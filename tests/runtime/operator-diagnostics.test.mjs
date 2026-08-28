import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  diagnoseNativeRouteDiscovery,
  diagnoseNativeTeamCompatibility,
  inspectBlockedLeases,
  inspectOperatorStorage,
  runDoctor,
} from "../../runtime/operator-diagnostics.mjs";
import {
  finalizeCompatibilityInstall,
  prepareCompatibilityInstall,
} from "../../runtime/plugin-compatibility-shells.mjs";
import { PACKAGE_VERSION, SOURCE_ROOT } from "../../runtime/version.mjs";
import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { acquireWorkspaceWriterLease } from "../../runtime/workspace-writer-lease.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

describe("operator storage diagnosis", () => {
  it("reports aggregate control state and conservative dry-run candidates without changing files", () => {
    const root = temporaryDirectory("cc-doctor-storage-");
    const pluginDataRoot = path.join(root, "codex-harnessdock");
    const workspace = path.join(pluginDataRoot, "state", "workspace");
    const jobsDirectory = path.join(workspace, "jobs");
    const owner = "owner-root";
    const events = [];
    for (let index = 0; index < 102; index += 1) {
      const id = `job-${String(index).padStart(3, "0")}`;
      writeJson(path.join(jobsDirectory, `${id}.json`), {
        id,
        status: "completed",
        ownerRootId: owner,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
      events.push({ jobId: id, sequence: index + 1 });
    }
    writeJson(path.join(workspace, "agent-registry", "roots", "owner", "registry.json"), {
      agents: {
        a: { status: "completed" },
        b: { status: "errored" },
      },
    });
    writeJson(path.join(workspace, "completion-inboxes", "owner", "inbox.json"), {
      acknowledgedThrough: 100,
      events,
    });
    const reservation = path.join(jobsDirectory, "stale.reserve");
    fs.writeFileSync(reservation, "");
    const old = new Date("2026-01-01T00:00:00.000Z");
    fs.utimesSync(reservation, old, old);

    const claudeConfigDir = path.join(root, ".claude");
    const oldHistory = path.join(claudeConfigDir, "projects", "project", "old.jsonl");
    const newHistory = path.join(claudeConfigDir, "projects", "project", "new.jsonl");
    fs.mkdirSync(path.dirname(oldHistory), { recursive: true });
    fs.writeFileSync(oldHistory, "{}\n");
    fs.writeFileSync(newHistory, "{}\n");
    fs.utimesSync(oldHistory, old, old);
    const before = fs.statSync(path.join(jobsDirectory, "job-000.json")).mtimeMs;

    const report = inspectOperatorStorage({
      pluginDataRoot,
      claudeConfigDir,
      nowMs: Date.parse("2026-07-28T00:00:00.000Z"),
      env: { CODEX_HOME: root },
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.runtime.agents, 2);
    assert.deepEqual(report.runtime.agentStatuses, { completed: 1, errored: 1 });
    assert.equal(report.runtime.jobs, 102);
    assert.equal(report.runtime.completionEvents, 102);
    assert.equal(report.runtime.unreadCompletionEvents, 2);
    assert.equal(report.cleanup.dryRun, true);
    assert.equal(report.cleanup.candidateCount, 3);
    assert.equal(report.cleanup.candidates.filter((entry) => entry.reason === "terminal-job-beyond-owner-retention").length, 2);
    assert.equal(report.claudeHistory.sessionFiles, 2);
    assert.equal(report.claudeHistory.olderThanObservationWindow, 1);
    assert.equal(report.claudeHistory.pluginCleanupCandidates, 0);
    assert.equal(fs.statSync(path.join(jobsDirectory, "job-000.json")).mtimeMs, before);
  });

  it("counts malformed records without rewriting them", () => {
    const root = temporaryDirectory("cc-doctor-malformed-");
    const malformed = path.join(root, "state", "workspace", "jobs", "broken.json");
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, "not-json\n");
    const before = fs.readFileSync(malformed, "utf8");
    const report = inspectOperatorStorage({
      pluginDataRoot: root,
      claudeConfigDir: path.join(root, ".claude"),
    });
    assert.equal(report.runtime.malformedRecords, 1);
    assert.equal(fs.readFileSync(malformed, "utf8"), before);
  });

  it("excludes an aged lease-tree scratch file from cleanup candidates without hiding unrelated ones (F4)", () => {
    const root = temporaryDirectory("cc-doctor-lease-cleanup-");
    const pluginDataRoot = path.join(root, "codex-harnessdock");
    const stateHome = path.join(pluginDataRoot, "state");
    const old = new Date("2026-01-01T00:00:00.000Z");

    // A real lease-tree layout (the exact directory shape
    // `instance-admission-lease.mjs` creates), so the walk exercises the
    // real relative-path shape this exclusion must match, not a stand-in.
    const leaseKeyDir = path.join(stateHome, "leases", "v1", "instance", "some-key-digest");
    fs.mkdirSync(leaseKeyDir, { recursive: true, mode: 0o700 });
    // Simulate a crashed atomic write: a leftover `.tmp.*` scratch file, aged
    // well past the stale-artifact window.
    const agedLeaseTemp = path.join(leaseKeyDir, "digest.json.tmp.12345.abc.def");
    fs.writeFileSync(agedLeaseTemp, "{}");
    fs.utimesSync(agedLeaseTemp, old, old);
    // Defensive: even a `.reserve`-suffixed file under the lease tree (never
    // legitimately produced by this module) must be excluded the same way.
    const agedLeaseReserve = path.join(leaseKeyDir, "stale.reserve");
    fs.writeFileSync(agedLeaseReserve, "");
    fs.utimesSync(agedLeaseReserve, old, old);

    // An unrelated, genuinely stale job-tree reservation must still surface.
    const jobsDirectory = path.join(stateHome, "workspace", "jobs");
    fs.mkdirSync(jobsDirectory, { recursive: true });
    const jobReservation = path.join(jobsDirectory, "stale.reserve");
    fs.writeFileSync(jobReservation, "");
    fs.utimesSync(jobReservation, old, old);

    const report = inspectOperatorStorage({
      pluginDataRoot,
      claudeConfigDir: path.join(root, ".claude"),
      nowMs: Date.parse("2026-07-28T00:00:00.000Z"),
    });

    const leaseCandidates = report.cleanup.candidates.filter((entry) => entry.path.includes("leases"));
    assert.deepEqual(leaseCandidates, [], "no lease-tree scratch file is ever a cleanup candidate");
    const jobCandidates = report.cleanup.candidates.filter((entry) => entry.path.includes("stale.reserve") && entry.path.includes("jobs"));
    assert.equal(jobCandidates.length, 1, "an unrelated, genuinely stale job-tree candidate is still found");
    assert.equal(report.cleanup.candidateCount, 1);

    // Bytes are untouched either way: this is a dry-run inventory only.
    assert.equal(fs.readFileSync(agedLeaseTemp, "utf8"), "{}");
    assert.equal(fs.existsSync(agedLeaseReserve), true);
    assert.equal(fs.existsSync(jobReservation), true);

    // The exact condition `runDoctor()`'s "storage" check warns on: it must
    // never trip due to the lease tree, only due to a real candidate/
    // malformed-record/boundary-error finding.
    const wouldWarn = report.runtime.malformedRecords > 0 || report.runtime.boundaryErrors > 0 || report.cleanup.candidateCount > 0;
    assert.equal(wouldWarn, true, "the unrelated job candidate still legitimately warns");
    assert.equal(report.runtime.malformedRecords, 0);
    assert.equal(report.runtime.boundaryErrors, 0);
  });
});

describe("operator doctor", () => {
  it("projects scoped native-team evidence without universal-containment or content leakage", async () => {
    const root = temporaryDirectory("cc-doctor-native-surface-");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const previous = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
    try {
      const { recordNativeTeamCompatibilityObservation } = await import("../../runtime/claude-version-compatibility.mjs");
      recordNativeTeamCompatibilityObservation(workspace, { fingerprint: "doctor-fingerprint" }, "claude_orchestrator", {
        canonicalToolNames: ["Task", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "FutureNativeTool"],
        definitionNames: ["haiku-scout", "sonnet"],
        teamTransportLiveValidated: false,
        prompt: "doctor-prompt-sentinel",
        memory: "doctor-memory-sentinel",
      });
      const report = diagnoseNativeTeamCompatibility(workspace, "doctor-fingerprint");
      const lead = report.modes.find((mode) => mode.delegationMode === "claude_orchestrator");
      assert.equal(lead.denySetLiveValidated, true);
      assert.equal(lead.teamTransportLiveValidated, false);
      assert.equal(lead.observed, true);
      assert.deepEqual(lead.canonicalToolNames, ["Agent", "FutureNativeTool", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
      assert.equal(lead.canonicalToolNameCount, 7);
      assert.deepEqual(lead.definitionNames, ["haiku-scout", "sonnet"]);
      assert.ok(lead.reviewedForbiddenToolNames.includes("ListAgents"));
      assert.deepEqual(lead.missingDefinitions, ["opus"]);
      assert.deepEqual(lead.missingNecessaryCoordinationTools, []);
      assert.deepEqual(lead.forbiddenTools, []);
      assert.deepEqual(lead.unknownNativeTools, ["FutureNativeTool"]);
      assert.match(lead.summary, /reviewed deny-set validation/i);
      assert.match(lead.summary, /named-team transport proof/i);
      assert.doesNotMatch(JSON.stringify(report), /universal containment|doctor-prompt-sentinel|doctor-memory-sentinel/i);

      const noObservation = diagnoseNativeTeamCompatibility(workspace, "other-fingerprint");
      assert.equal(noObservation.modes.every((mode) => mode.denySetLiveValidated === false), true);
      const noCurrentFingerprint = diagnoseNativeTeamCompatibility(workspace, null);
      assert.equal(noCurrentFingerprint.modes.every((mode) => mode.observed === false), true);
      assert.equal(noCurrentFingerprint.modes.every((mode) => mode.canonicalToolNames.length === 0), true);
    } finally {
      if (previous == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
      else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = previous;
    }
  });

  it("returns redacted health across a matching synthetic installation", async () => {
    const codexHome = temporaryDirectory("cc-doctor-codex-home-");
    const pluginRoot = path.join(SOURCE_ROOT, "plugins", "codex-harnessdock");
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    const snapshotRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      "pein-local",
      "codex-harnessdock",
      manifest.version,
    );
    fs.mkdirSync(path.dirname(snapshotRoot), { recursive: true });
    fs.cpSync(pluginRoot, snapshotRoot, { recursive: true });
    const coveragePlan = prepareCompatibilityInstall({
      codexHome,
      requestedVersion: manifest.version,
    });
    finalizeCompatibilityInstall({ plan: coveragePlan, installedSnapshotRoot: snapshotRoot });
    const secretEmail = "private@example.invalid";
    const fakeSpawn = (command, args) => {
      if (args.join(" ") === "plugin list --json") {
        return {
          status: 0,
          stdout: JSON.stringify({
            installed: [{
              pluginId: "codex-harnessdock@pein-local",
              name: "codex-harnessdock",
              marketplaceName: "pein-local",
              version: manifest.version,
              enabled: true,
              source: { source: "local", path: pluginRoot },
            }],
          }),
          stderr: "",
        };
      }
      if (args[0] === "--version") {
        return { status: 0, stdout: "2.1.220 (Claude Code)\n", stderr: "" };
      }
      if (args[0] === "--help") {
        return {
          status: 0,
          stdout: [
            "-p", "--output-format", "--verbose", "--include-partial-messages",
            "--input-format", "--replay-user-messages", "--include-hook-events", "--name",
            "--model", "--effort", "--resume", "--allowedTools", "--disallowedTools",
            "--append-system-prompt", "--agents", "--settings",
            "--permission-mode", "--dangerously-skip-permissions", "stream-json",
            "low", "medium", "high", "xhigh", "max", "dontAsk", "bypassPermissions",
          ].join(" "),
          stderr: "",
        };
      }
      if (args.join(" ") === "auth status --json") {
        return {
          status: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "oauth",
            apiProvider: "firstParty",
            subscriptionType: "max",
            email: secretEmail,
            orgId: "private-org",
          }),
          stderr: "",
        };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const report = await runDoctor({
      cwd: SOURCE_ROOT,
      expectedCheckout: SOURCE_ROOT,
      env: { ...process.env, CODEX_HOME: codexHome },
      spawnSyncImpl: fakeSpawn,
      observeCredentialImpl: () => ({
        version: 1,
        source: "native_oauth",
        configIdentity: "/data/CoordExp/.claude",
        state: "present",
        liveValidated: false,
        generation: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
        accessExpiresAt: "2026-08-11T20:00:00.000Z",
        accessLocallyExpired: false,
        refreshExpiresAt: null,
        refreshLocallyExpired: null,
      }),
      probeMcp: async () => ({
        healthy: true,
        tools: [
          "list_harnesses", "spawn_agent", "send_message", "followup_task", "wait_agent",
          "interrupt_agent", "list_agents", "read_agent_messages",
        ],
        agentCount: 0,
        nativeRoutes: [
          {
            harness: "claude-code",
            status: "available",
            detail: null,
            maturity: "stable",
            instances: [{ readiness: "ready", liveValidated: true, maturity: "stable", capacity: null, models: ["claude-sonnet-5"], efforts: ["low", "high"], effortsByModel: { "claude-sonnet-5": ["low", "high"] } }],
          },
          {
            harness: "pi",
            status: "available",
            detail: null,
            maturity: "experimental",
            instances: [{ readiness: "ready", liveValidated: true, maturity: "experimental", capacity: null, models: ["openai-codex/gpt-5.6-luna"], efforts: ["low", "medium", "high"], effortsByModel: { "openai-codex/gpt-5.6-luna": ["low", "medium", "high"] } }],
          },
          {
            harness: "opencode",
            status: "available",
            detail: null,
            maturity: "experimental",
            instances: [{ readiness: "ready", liveValidated: true, maturity: "experimental", capacity: 1, models: ["openai/gpt-5.6-luna"], efforts: ["low", "high"], effortsByModel: { "openai/gpt-5.6-luna": ["low", "high"] } }],
          },
        ],
      }),
    });

    assert.equal(report.status, "pass");
    const nativeRoutes = report.checks.find((check) => check.id === "native-routes");
    assert.equal(nativeRoutes.status, "pass");
    assert.match(nativeRoutes.summary, /no model, provider, or Server call/i);
    assert.deepEqual(
      nativeRoutes.details.routes.map((route) => route.harness).sort(),
      ["claude-code", "opencode", "pi"],
    );
    assert.deepEqual(
      nativeRoutes.details.routes.find((route) => route.harness === "pi").effortsByModel,
      { "openai-codex/gpt-5.6-luna": ["low", "medium", "high"] },
    );
    assert.equal(report.checks.find((check) => check.id === "checkout").details.packageVersion, PACKAGE_VERSION);
    assert.equal(report.checks.find((check) => check.id === "claude-auth").details.subscriptionType, "max");
    assert.equal(report.checks.find((check) => check.id === "claude-auth").details.liveValidated, false);
    assert.match(
      report.checks.find((check) => check.id === "claude-auth").summary,
      /provider liveness was not validated/,
    );
    const compatibilityShells = report.checks.find((check) => check.id === "plugin-compatibility-shells");
    assert.equal(compatibilityShells.status, "pass");
    assert.equal(compatibilityShells.details.coverageState, "first_install");
    assert.equal(compatibilityShells.details.expectedPredecessor, null);
    assert.match(compatibilityShells.summary, /first install.*no distinct predecessor/i);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secretEmail));
    assert.doesNotMatch(JSON.stringify(report), /private-org/);
    assert.equal(fs.existsSync(path.join(codexHome, "plugins", "data", "codex-harnessdock", "state")), false);
  });

  it("warns on locally expired OAuth and fails on unavailable credential metadata without claiming liveness", async () => {
    const fakeSpawn = (_command, args) => {
      if (args.join(" ") === "plugin list --json") {
        return { status: 0, stdout: JSON.stringify({ installed: [] }), stderr: "" };
      }
      if (args[0] === "--version") return { status: 0, stdout: "2.1.220 (Claude Code)\n", stderr: "" };
      if (args[0] === "--help") {
        return {
          status: 0,
          stdout: [
            "-p", "--output-format", "--verbose", "--include-partial-messages",
            "--input-format", "--replay-user-messages", "--include-hook-events", "--name",
            "--model", "--effort", "--resume", "--allowedTools", "--disallowedTools",
            "--append-system-prompt", "--agents", "--settings", "--permission-mode",
            "--dangerously-skip-permissions", "stream-json", "low", "medium", "high",
            "xhigh", "max", "dontAsk", "bypassPermissions",
          ].join(" "),
          stderr: "",
        };
      }
      if (args.join(" ") === "auth status --json") {
        return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }), stderr: "" };
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const base = {
      cwd: SOURCE_ROOT,
      expectedCheckout: SOURCE_ROOT,
      env: { ...process.env, CODEX_HOME: temporaryDirectory("cc-doctor-auth-state-") },
      spawnSyncImpl: fakeSpawn,
      probeMcp: async () => ({ healthy: false, tools: [], agentCount: 0 }),
    };
    const expired = await runDoctor({
      ...base,
      observeCredentialImpl: () => ({
        version: 1,
        source: "native_oauth",
        configIdentity: "/data/CoordExp/.claude",
        state: "present",
        liveValidated: false,
        generation: { dev: "1", ino: "2", size: "3", mtimeNs: "4", ctimeNs: "5" },
        accessExpiresAt: "2026-08-11T10:00:00.000Z",
        accessLocallyExpired: true,
        refreshExpiresAt: null,
        refreshLocallyExpired: null,
      }),
    });
    const expiredAuth = expired.checks.find((check) => check.id === "claude-auth");
    assert.equal(expiredAuth.status, "warn");
    assert.equal(expiredAuth.details.liveValidated, false);
    assert.match(expiredAuth.summary, /expired or unproven/);

    const unavailable = await runDoctor({
      ...base,
      observeCredentialImpl: () => ({
        version: 1,
        source: "native_oauth",
        configIdentity: "/data/CoordExp/.claude",
        state: "unavailable",
        liveValidated: false,
        generation: null,
        accessExpiresAt: null,
        accessLocallyExpired: null,
        refreshExpiresAt: null,
        refreshLocallyExpired: null,
      }),
    });
    const unavailableAuth = unavailable.checks.find((check) => check.id === "claude-auth");
    assert.equal(unavailableAuth.status, "fail");
    assert.equal(unavailableAuth.details.liveValidated, false);
    assert.match(unavailableAuth.summary, /provider liveness was not validated/);
    assert.doesNotMatch(JSON.stringify(unavailableAuth), /accessToken|refreshToken|private@/);
  });
});

describe("blocked instance/session/writer lease diagnostics (OpenSpec 4.4)", () => {
  const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  const leaseTestRoots = [];

  afterEach(() => {
    if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
    while (leaseTestRoots.length) fs.rmSync(leaseTestRoots.pop(), { recursive: true, force: true });
  });

  function setupLeaseHome() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-doctor-leases-"));
    leaseTestRoots.push(root);
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "state-home");
    return root;
  }

  it("reports a blocked instance lease at capacity with bounded, non-secret evidence", () => {
    setupLeaseHome();
    acquireInstanceLease({
      ownerRootId: "root-1",
      agentId: "agent-1",
      jobId: "job-1",
      route: versionThreeRoute(),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    const report = inspectBlockedLeases();
    assert.equal(report.total, 1);
    assert.equal(report.blocked.length, 1);
    const [entry] = report.blocked;
    assert.equal(entry.kind, "instance");
    assert.equal(entry.atCapacity, true);
    assert.equal(entry.evidenceClassNeeded, "native_terminal_and_settled_execution_evidence");
    assert.equal(entry.holders[0].ownerRootId, "root-1");
    // No force-clear/delete/mutation surface exists on this report at all.
    assert.equal(report.clear, undefined);
    assert.equal(report.forceClear, undefined);
    assert.equal(report.delete, undefined);
    assert.equal(typeof report, "object");
  });

  it("reports a blocked writer lease and does not report an unrelated read-only-admitting instance lease as blocked", () => {
    const root = setupLeaseHome();
    const workspaceRoot = fs.mkdtempSync(path.join(root, "worktree-"));
    acquireWorkspaceWriterLease({
      ownerRootId: "root-1",
      agentId: "writer-agent",
      jobId: "writer-job",
      route: versionThreeRoute({ authority: "behavioral_write" }),
      workspaceRoot,
    });
    acquireInstanceLease({
      ownerRootId: "root-1",
      agentId: "reader-agent",
      jobId: "reader-job",
      route: versionThreeRoute(),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 4, // one holder of four: not blocking anyone yet
    });
    const report = inspectBlockedLeases();
    assert.equal(report.total, 2);
    assert.equal(report.blocked.length, 1);
    assert.equal(report.blocked[0].kind, "writer");
  });

  it("returns an empty report without creating any lease directory", () => {
    const root = setupLeaseHome();
    const report = inspectBlockedLeases();
    assert.deepEqual(report.entries, []);
    assert.equal(report.total, 0);
    assert.equal(report.blocked.length, 0);
    assert.equal(fs.existsSync(path.join(root, "state-home", "state", "leases")), false);
  });

  it("surfaces blocked leases through the established inspectOperatorStorage() operator surface", () => {
    const root = temporaryDirectory("cc-doctor-leases-storage-");
    const pluginDataRoot = path.join(root, "codex-harnessdock");
    // The lease engine and `inspectOperatorStorage()` must resolve the exact
    // same plugin state root for this to be a real integration, not two
    // independently configured roots that merely look alike.
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = pluginDataRoot;
    try {
      acquireInstanceLease({
        ownerRootId: "root-1",
        agentId: "agent-1",
        jobId: "job-1",
        route: versionThreeRoute(),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      });
    } finally {
      if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
      else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
    }

    const report = inspectOperatorStorage({
      pluginDataRoot,
      env: { CODEX_HOME: root },
      nowMs: Date.parse("2026-07-28T00:00:00.000Z"),
    });
    assert.equal(report.readOnly, true);
    assert.equal(report.leases.total, 1);
    assert.equal(report.leases.blocked.length, 1);
    assert.equal(report.leases.blocked[0].kind, "instance");
    assert.equal(report.leases.blocked[0].holders[0].ownerRootId, "root-1");
    // Lease evidence is never folded into deletable cleanup candidates.
    assert.equal(report.cleanup.candidateCount, 0);
    assert.ok(!JSON.stringify(report.cleanup).includes("leases"));
  });
});

describe("doctor native-route discovery", () => {
  it("reports bounded redacted route/effort facts with no model call", () => {
    const check = diagnoseNativeRouteDiscovery({
      nativeRoutes: [
        {
          harness: "pi",
          status: "available",
          detail: null,
          maturity: "experimental",
          instances: [{
            readiness: "ready",
            liveValidated: true,
            maturity: "experimental",
            capacity: null,
            models: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"],
            efforts: ["low", "medium", "high"],
            effortsByModel: {
              "openai-codex/gpt-5.6-luna": ["low", "medium", "high"],
              "openai-codex/gpt-5.6-terra": ["low", "high"],
            },
          }],
        },
      ],
    });
    assert.equal(check.id, "native-routes");
    assert.equal(check.status, "pass");
    assert.match(check.summary, /no model, provider, or Server call/i);
    assert.match(check.summary, /exact model-specific effort\/variant choices/i);
    const pi = check.details.routes[0];
    assert.deepEqual(pi.effortsByModel["openai-codex/gpt-5.6-terra"], ["low", "high"]);
    assert.equal(pi.modelCount, 2);
  });

  it("distinguishes unavailable, ambiguous, and route-drift conditions and warns without repair", () => {
    const check = diagnoseNativeRouteDiscovery({
      nativeRoutes: [
        { harness: "claude-code", status: "available", detail: null, maturity: "stable", instances: [{ readiness: "ready", models: ["claude-sonnet-5"], efforts: ["low"], effortsByModel: {} }] },
        { harness: "pi", status: "unavailable", detail: "inspection_failed", maturity: "experimental", instances: [] },
        { harness: "opencode", status: "drift", detail: "discovery_unknown", maturity: "experimental", instances: [{ readiness: "unknown", models: [], efforts: [], effortsByModel: {} }] },
      ],
    });
    assert.equal(check.status, "warn");
    assert.match(check.summary, /unavailable: pi/i);
    assert.match(check.summary, /drift: opencode/i);
    assert.match(check.recovery, /does not repair, reload, or reconfigure/i);
  });

  it("warns when discovery was not observed this run", () => {
    const check = diagnoseNativeRouteDiscovery({ healthy: false, tools: [] });
    assert.equal(check.status, "warn");
    assert.match(check.summary, /not observed this run/i);
  });

  it("fails closed and withholds a projection that leaked configuration text", () => {
    const check = diagnoseNativeRouteDiscovery({
      nativeRoutes: [
        { harness: "opencode", status: "available", detail: "http://127.0.0.1:4096", maturity: "experimental", instances: [] },
      ],
    });
    assert.equal(check.status, "fail");
    assert.match(check.summary, /disallowed configuration text/i);
    assert.doesNotMatch(JSON.stringify(check), /127\.0\.0\.1/);
  });
});
