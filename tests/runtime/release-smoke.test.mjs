import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  assessNativeHarnessDifferentialParity,
  assertNoLeakedConfiguration,
  isClaudeSubscriptionLimit,
  probeInstalledMcp,
  projectNativeRouteDiscovery,
  runNativeTeamWitness,
  runPaidSmoke,
  runReleaseSmoke,
} from "../../runtime/release-smoke.mjs";
import { HARNESSDOCK_MCP_TOOL_NAMES } from "../../runtime/mcp-server.mjs";
import { ADMITTED_GENERATION_HARNESS_IDS } from "../../runtime/harness-registry.mjs";
import { createClaudeCodeDriver } from "../../runtime/claude-code-driver.mjs";
import { StreamParser } from "../../runtime/claude-headless-adapter.mjs";
import { readJobFile, resolveJobFile } from "../../runtime/job-store.mjs";
import { runClaudeTaskSession } from "../../runtime/job-supervisor.mjs";
import {
  finalizeCompatibilityInstall,
  prepareCompatibilityInstall,
} from "../../runtime/plugin-compatibility-shells.mjs";
import { CANONICAL_RUNTIME_CHECKOUT, SOURCE_ROOT } from "../../runtime/version.mjs";
import { runReleaseSmokeCli } from "../../scripts/release-smoke.mjs";
import { acceptDriverRoute, createDriverScope, inspectDriverInstances } from "../../runtime/harness-registry.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function matchingSnapshot() {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-release-snapshot-"));
  temporaryDirectories.push(codexHome);
  const pluginRoot = path.join(SOURCE_ROOT, "plugins", "codex-harnessdock");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const snapshotRoot = path.join(
    codexHome, "plugins", "cache", "pein-local", "codex-harnessdock", manifest.version,
  );
  fs.mkdirSync(path.dirname(snapshotRoot), { recursive: true });
  fs.cpSync(pluginRoot, snapshotRoot, { recursive: true });
  return {
    codexHome,
    snapshotRoot,
    installed: {
      pluginId: "codex-harnessdock@pein-local",
      version: manifest.version,
      enabled: true,
      source: "local",
      sourcePath: pluginRoot,
      snapshotRoot,
    },
  };
}

function snapshotVersion(fixture, version) {
  const root = path.join(path.dirname(fixture.snapshotRoot), version);
  fs.cpSync(path.join(SOURCE_ROOT, "plugins", "codex-harnessdock"), root, { recursive: true });
  const manifestFile = path.join(root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return root;
}

function establishCompatibilityCoverage(fixture, previousVersion = null) {
  if (previousVersion) snapshotVersion(fixture, previousVersion);
  const plan = prepareCompatibilityInstall({
    codexHome: fixture.codexHome,
    requestedVersion: fixture.installed.version,
  });
  return finalizeCompatibilityInstall({ plan, installedSnapshotRoot: fixture.snapshotRoot });
}

function completedWitnessTurn(overrides = {}) {
  return {
    status: "completed",
    exitStatus: 0,
    failure: { class: null, reason: null, detail: null },
    ...overrides,
  };
}

function fakeWitnessDriver(startTurn) {
  const calls = [];
  const compatibility = { executable: "/fake/claude", fingerprint: "fake-fingerprint" };
  return {
    calls,
    preflight({ cwd, env }) {
      calls.push({ method: "preflight", cwd, env });
      return {
        ready: true,
        availability: { available: true },
        compatibility: { staticCompatible: true, ...compatibility },
        auth: { loggedIn: true },
      };
    },
    validatePreparedPreflight(receipt, scope) {
      calls.push({ method: "validate", receipt, scope });
      assert.equal(receipt.cwd, scope.cwd);
      assert.equal(receipt.claudeConfigDir, scope.env.CLAUDE_CONFIG_DIR);
      return receipt;
    },
    revalidatePreparedPreflight(receipt, scope) {
      calls.push({ method: "revalidate", receipt, scope });
      assert.equal(receipt.cwd, scope.cwd);
      return { availability: { available: true }, compatibility };
    },
    async startTurn(request) {
      calls.push({ method: "start", request });
      return startTurn(request);
    },
  };
}

function productionWitnessDriver(runAttempt) {
  const driver = createClaudeCodeDriver();
  const compatibility = { executable: "/fake/claude", fingerprint: "fake-fingerprint" };
  return {
    ...driver,
    preflight() {
      return {
        ready: true,
        availability: { available: true },
        compatibility: { staticCompatible: true, ...compatibility },
        auth: { loggedIn: true },
      };
    },
    validatePreparedPreflight(receipt, scope) {
      assert.equal(receipt.cwd, scope.cwd);
      assert.equal(receipt.claudeConfigDir, scope.env.CLAUDE_CONFIG_DIR);
      return receipt;
    },
    revalidatePreparedPreflight(receipt, scope) {
      assert.equal(receipt.cwd, scope.cwd);
      return { availability: { available: true }, compatibility };
    },
    startTurn(request) {
      return driver.startTurn({
        ...request,
        runTurnSession: (supervisorRequest) => runClaudeTaskSession({
          ...supervisorRequest,
          runAttempt,
        }),
      });
    },
  };
}

describe("release smoke", () => {
  it("projects and admits a replaced fake catalog without a turn or configuration identity", async () => {
    const guidance = fs.readFileSync(path.join(SOURCE_ROOT, "plugins", "codex-harnessdock", "skills", "spawn-agent", "SKILL.md"));
    const catalog = { "fake/provider-a": ["opaque-effort-a"] };
    const fixture = createFakeServiceDriver({ inspectInstances: () => [{
      harnessId: "fake-service", instanceKey: "tenant-alpha", readiness: "ready", liveValidated: true,
      maturity: "experimental", detailCode: "ready",
      routes: { models: Object.keys(catalog), effortsByModel: catalog, configurationIdentity: "secret-catalog-origin" },
      capabilityProvenance: fixture.capabilities.provenance, inspectionGeneration: "unavailable",
    }] });
    const inspect = async () => {
      const [inspection] = await inspectDriverInstances(fixture.driver, createDriverScope({ driver: fixture.driver, purpose: "inspect", env: {} }));
      return inspection;
    };
    const listing = (inspection) => projectNativeRouteDiscovery([{ harness: "fake-service", maturity: "experimental", instances: [{
      instance: inspection.instanceKey, readiness: inspection.readiness, live_validated: inspection.liveValidated,
      maturity: inspection.maturity, routes: inspection.routes,
    }] }]);
    const request = (model, effort) => ({ harnessId: "fake-service", model, effort, topology: "leaf", authority: "behavioral_read_only" });
    const firstInspection = await inspect();
    const first = listing(firstInspection);
    assert.equal(acceptDriverRoute(fixture.driver, request("fake/provider-a", "opaque-effort-a"), [firstInspection]).route.effort, "opaque-effort-a");
    delete catalog["fake/provider-a"];
    catalog["fake/provider-b"] = ["opaque-effort-b"];
    const secondInspection = await inspect();
    const second = listing(secondInspection);
    assert.notDeepEqual(first, second);
    assert.throws(() => acceptDriverRoute(fixture.driver, request("fake/provider-a", "opaque-effort-a"), [secondInspection]));
    assert.equal(acceptDriverRoute(fixture.driver, request("fake/provider-b", "opaque-effort-b"), [secondInspection]).route.effort, "opaque-effort-b");
    assert.deepEqual(second[0].instances[0].effortsByModel, { "fake/provider-b": ["opaque-effort-b"] });
    assert.equal(guidance.includes("fake/provider-b"), false);
    assert.equal(JSON.stringify(second).includes("secret-catalog-origin"), false);
    assert.equal(fixture.control.service.prompts.length, 0);
  });

  it("reports a supplied differential matrix as non-promotable without changing default smoke behavior", async () => {
    const fixture = matchingSnapshot();
    const differentialParityReceipt = JSON.parse(fs.readFileSync(
      path.join(SOURCE_ROOT, "tests", "runtime", "fixtures", "native-parity", "native-harness-differential-parity.receipt.json"),
      "utf8",
    ));
    const assessment = assessNativeHarnessDifferentialParity(differentialParityReceipt);
    assert.equal(assessment.status, "hold");
    assert.equal(assessment.promotionEligible, false);
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      differentialParityReceipt,
      probeMcp: async () => ({
        healthy: true,
        tools: [...HARNESSDOCK_MCP_TOOL_NAMES],
        agentCount: 0,
        harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
        paid: { requested: false, status: "skipped" },
      }),
    });
    assert.equal(report.status, "hold");
    assert.equal(report.promotionEligible, false);
    assert.deepEqual(report.differentialParity.counts, { pass: 29, fail: 0, hold: 3, not_applicable: 7 });
    assert.equal(report.differentialParity.blockers.length, 3);
  });

  it("validates matching installed Skills and MCP evidence without paid usage by default", async () => {
    const fixture = matchingSnapshot();
    let probeOptions;
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      probeMcp: async (options) => {
        probeOptions = options;
        return {
          healthy: true,
          tools: [...HARNESSDOCK_MCP_TOOL_NAMES],
          agentCount: 0,
          harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
          schemaRejected: true,
          nativeRoutes: [
            { harness: "claude-code", status: "available", detail: null, maturity: "stable", instances: [{ readiness: "ready", liveValidated: true, maturity: "stable", capacity: null, models: ["claude-sonnet-5"], efforts: ["low"], effortsByModel: { "claude-sonnet-5": ["low"] } }] },
            { harness: "pi", status: "unavailable", detail: "inspection_failed", maturity: "experimental", instances: [] },
            { harness: "opencode", status: "available", detail: null, maturity: "experimental", instances: [{ readiness: "ready", liveValidated: true, maturity: "experimental", capacity: 1, models: ["openai/gpt-5.6-luna"], efforts: ["low", "high"], effortsByModel: { "openai/gpt-5.6-luna": ["low", "high"] } }] },
          ],
          paid: { requested: false, status: "skipped" },
        };
      },
    });
    assert.equal(report.status, "pass");
    assert.equal(report.zeroModelCost, true);
    assert.equal(probeOptions.realClaude, false);
    assert.equal(report.skills.length, 8);
    assert.equal(report.tools.length, 8);
    // Fresh native-route discovery rides the same zero-model list_harnesses
    // call; an unavailable native Harness is reported, never a smoke failure.
    assert.equal(report.nativeRouteDiscovery.length, 3);
    assert.equal(report.nativeRouteDiscovery.find((route) => route.harness === "pi").status, "unavailable");
    assert.deepEqual(
      report.nativeRouteDiscovery.find((route) => route.harness === "opencode").instances[0].effortsByModel,
      { "openai/gpt-5.6-luna": ["low", "high"] },
    );
    assert.equal(report.compatibilityShells.valid, true);
    assert.equal(report.compatibilityShells.count, 0);
    assert.equal(report.compatibilityShells.coverageState, "unmanaged");
    assert.equal(report.compatibilityShells.coverageComplete, false);
  });

  it("passes paid intent only when explicitly selected", async () => {
    const fixture = matchingSnapshot();
    let paidStart;
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      realClaude: true,
      onPaidStart(receipt) { paidStart = receipt; },
      probeMcp: async (options) => {
        options.onPaidStart({ model: "claude-haiku-4-5", reasoningEffort: "low", write: false });
        return {
          healthy: true,
          tools: [
            "spawn_agent", "send_message", "followup_task", "wait_agent",
            "interrupt_agent", "list_agents", "read_agent_messages",
          ],
          agentCount: 0,
          harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
          paid: { requested: true, status: "completed" },
        };
      },
    });
    assert.equal(report.zeroModelCost, false);
    assert.deepEqual(paidStart, { model: "claude-haiku-4-5", reasoningEffort: "low", write: false });
  });

  it("accepts complete managed predecessor coverage", async () => {
    const fixture = matchingSnapshot();
    const previousVersion = "0.17.0+codex.previous";
    establishCompatibilityCoverage(fixture, previousVersion);
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      probeMcp: async () => ({
        healthy: true,
        tools: [
          "spawn_agent", "send_message", "followup_task", "wait_agent",
          "interrupt_agent", "list_agents", "read_agent_messages",
        ],
        agentCount: 0,
        harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
        paid: { requested: false, status: "skipped" },
      }),
    });
    assert.equal(report.compatibilityShells.valid, true);
    assert.equal(report.compatibilityShells.count, 1);
    assert.equal(report.compatibilityShells.coverageState, "managed");
    assert.equal(report.compatibilityShells.coverageComplete, true);
    assert.equal(report.compatibilityShells.expectedPredecessor, previousVersion);
    assert.deepEqual(report.compatibilityShells.retainedVersions, [previousVersion]);
  });

  it("fails when a known predecessor disappears from cache and archive", async () => {
    const fixture = matchingSnapshot();
    const previousVersion = "0.17.0+codex.previous";
    establishCompatibilityCoverage(fixture, previousVersion);
    fs.rmSync(path.join(path.dirname(fixture.snapshotRoot), previousVersion), { recursive: true, force: true });
    fs.rmSync(path.join(
      fixture.codexHome, "plugins", "data", "codex-harnessdock", "compatibility-shells", "v1", "versions", previousVersion,
    ), { recursive: true, force: true });

    await assert.rejects(
      () => runReleaseSmoke({
        installed: fixture.installed,
        probeMcp: async () => ({ healthy: true, tools: [], agentCount: 0 }),
      }),
      /compatibility coverage|known predecessor|compatibility shells/i,
    );
  });

  it("reports a successful first install without inventing predecessor coverage", async () => {
    const fixture = matchingSnapshot();
    establishCompatibilityCoverage(fixture);
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      probeMcp: async () => ({
        healthy: true,
        tools: [
          "spawn_agent", "send_message", "followup_task", "wait_agent",
          "interrupt_agent", "list_agents", "read_agent_messages",
        ],
        agentCount: 0,
        harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
        paid: { requested: false, status: "skipped" },
      }),
    });
    assert.equal(report.compatibilityShells.coverageState, "first_install");
    assert.equal(report.compatibilityShells.expectedPredecessor, null);
    assert.equal(report.compatibilityShells.coverageComplete, true);
  });

  it("launches the descriptor MCP with isolated list_agents and no model", async () => {
    const canonicalManifest = path.join(
      CANONICAL_RUNTIME_CHECKOUT,
      "plugins",
      "codex-harnessdock",
      ".codex-plugin",
      "plugin.json",
    );
    const canonicalBootstrap = path.join(CANONICAL_RUNTIME_CHECKOUT, "plugins", "codex-harnessdock", "bootstrap", "harnessdock-mcp.mjs");
    if (
      !fs.existsSync(canonicalManifest) ||
      JSON.parse(fs.readFileSync(canonicalManifest, "utf8")).name !== "codex-harnessdock" ||
      !fs.readFileSync(canonicalBootstrap, "utf8").includes("await runCcMcpServer()")
    ) {
      // Candidate source is not installed. The descriptor must reject the old
      // canonical guidance rather than calling it a current release witness.
      await assert.rejects(
        () => probeInstalledMcp({
          snapshotRoot: path.join(SOURCE_ROOT, "plugins", "codex-harnessdock"),
          workspace: SOURCE_ROOT,
          callListAgents: true,
        }),
        /guidance characters|canonical checkout/i,
      );
      return;
    }
    const report = await probeInstalledMcp({
      snapshotRoot: path.join(SOURCE_ROOT, "plugins", "codex-harnessdock"),
      workspace: SOURCE_ROOT,
      callListAgents: true,
    });
    assert.equal(report.healthy, true);
    assert.equal(report.tools.length, 8);
    assert.equal(report.agentCount, 0);
    assert.deepEqual(report.paid, { requested: false, status: "skipped" });
  });

  it("projects a bounded redacted native-route discovery and classifies availability", () => {
    const projected = projectNativeRouteDiscovery([
      {
        harness: "pi",
        maturity: "experimental",
        instances: [{
          instance: "pi-local",
          readiness: "ready",
          live_validated: true,
          maturity: "experimental",
          capacity: null,
          routes: {
            models: ["openai-codex/gpt-5.6-luna"],
            reasoningEfforts: ["low", "medium", "high"],
            effortsByModel: { "openai-codex/gpt-5.6-luna": ["low", "medium", "high"] },
          },
        }],
      },
      { harness: "opencode", unavailable: "server_unreachable", instances: [] },
      {
        harness: "claude-code",
        instances: [
          { readiness: "ready", routes: { models: ["claude-sonnet-5"], reasoningEfforts: ["low"], effortsByModel: {} } },
          { readiness: "ready", routes: { models: ["claude-opus-5"], reasoningEfforts: ["low"], effortsByModel: {} } },
        ],
      },
    ]);
    assert.equal(projected.find((route) => route.harness === "pi").status, "available");
    assert.deepEqual(
      projected.find((route) => route.harness === "pi").instances[0].effortsByModel,
      { "openai-codex/gpt-5.6-luna": ["low", "medium", "high"] },
    );
    assert.equal(projected.find((route) => route.harness === "opencode").status, "unavailable");
    assert.equal(projected.find((route) => route.harness === "opencode").detail, "server_unreachable");
    assert.equal(projected.find((route) => route.harness === "claude-code").status, "ambiguous");
    // Route drift: a listed instance that cannot be freshly proven ready.
    const drift = projectNativeRouteDiscovery([{ harness: "pi", instances: [{ readiness: "unknown", routes: null }] }]);
    assert.equal(drift[0].status, "drift");
    assert.equal(drift[0].detail, "discovery_unknown");
  });

  it("fails closed when a discovery projection carries an endpoint or credential", () => {
    assert.doesNotThrow(() => assertNoLeakedConfiguration(
      [{ harness: "pi", status: "available", instances: [{ models: ["openai-codex/gpt-5.6-luna"], efforts: ["low"] }] }],
      "test",
    ));
    assert.throws(
      () => assertNoLeakedConfiguration([{ harness: "opencode", detail: "http://127.0.0.1:4096/provider" }], "test"),
      /disallowed configuration text/i,
    );
    assert.throws(
      () => assertNoLeakedConfiguration([{ note: "PI_CODING_AGENT_DIR=/home/op/.pi" }], "test"),
      /disallowed configuration text/i,
    );
  });

  it("distinguishes bounded subscription compatibility fallbacks from a generic HTTP 429", () => {
    assert.equal(isClaudeSubscriptionLimit("subscription allowance exhausted"), true);
    assert.equal(isClaudeSubscriptionLimit("no remaining credits"), true);
    assert.equal(isClaudeSubscriptionLimit("quota limit reached"), true);
    assert.equal(isClaudeSubscriptionLimit("HTTP 429 transient rate limit"), false);
  });

  it("runs the paid control flow against a zero-Claude fake transport using the current wait schema", async () => {
    const calls = [];
    const client = {
      async callTool(request) {
        calls.push(request);
        if (request.name === "spawn_agent") {
          return { isError: false, structuredContent: { status: "working" } };
        }
        assert.equal(request.name, "wait_agent");
        assert.deepEqual(request.arguments, {});
        return {
          isError: false,
          structuredContent: {
            update: {
              kind: "completion",
              summary: "Agent turn completed.",
              completion_message: "HARNESSDOCK_RELEASE_SMOKE_OK",
              delivery_token: "delivery-fake",
            },
          },
        };
      },
    };
    const result = await runPaidSmoke(client, { threadId: "fake", "codex/sandbox-state-meta": {} }, { maxMs: 5_000 });
    assert.equal(result.status, "completed");
    assert.equal(result.markerObserved, true);
    assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [
      ["spawn_agent", calls[0].arguments],
      ["wait_agent", {}],
    ]);
  });

  it("binds the fake witness to a full Driver preflight/revalidation seam and preserves observable team facts", async () => {
    const driver = fakeWitnessDriver(async (request) => {
      assert.equal(request.launchContext.compatibility.executable, "/fake/claude");
      assert.equal(request.launchContext.compatibility.fingerprint, "fake-fingerprint");
      assert.match(request.prompt, /run_in_background:\s*true/);
      assert.match(request.prompt, /scout-fixture/);
      assert.match(request.prompt, /reviewer-fixture/);
      assert.match(request.prompt, /SendMessage/);
      assert.match(request.prompt, /Do not use synchronous ordinary subagents/);
      const parser = new StreamParser({
        delegationMode: "claude_orchestrator",
        onNativeTeamWitness: request.onNativeTeamWitness,
      });
      parser.feed(`${JSON.stringify({
        type: "system", subtype: "init", session_id: "fake-parent",
        tools: ["Task", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"],
        agents: ["haiku-scout", "sonnet", "opus"],
      })}\n`);
      parser.feed(`${JSON.stringify({ type: "assistant", message: { content: [{
        type: "tool_use", id: "fake-spawn", name: "Agent",
        input: { name: "haiku-scout-1", subagent_type: "haiku-scout" },
      }, {
        type: "tool_use", id: "fake-sonnet", name: "Agent",
        input: { name: "sonnet-1", subagent_type: "sonnet" },
      }] } })}\n`);
      for (const [toolUseId, agentId, resolvedModel] of [
        ["fake-spawn", "fake-haiku-agent", "claude-haiku-4-5"],
        ["fake-sonnet", "fake-sonnet-agent", "claude-sonnet-5"],
      ]) {
        parser.feed(`${JSON.stringify({
          type: "user", tool_use_result: { status: "async_launched", agentId, resolvedModel },
          message: { content: [{ type: "tool_result", tool_use_id: toolUseId }] },
        })}\n`);
      }
      parser.feed(`${JSON.stringify({ type: "assistant", message: { content: [{
        type: "tool_use", id: "fake-message", name: "SendMessage",
        input: { recipient: "haiku-scout-1", content: "opaque fixture" },
      }] } })}\n`);
      parser.feed(`${JSON.stringify({
        type: "user", tool_use_result: {
          success: true,
          pin: { id: "fake-haiku-agent", name: "haiku-scout-1", ref: "safe-ref" },
        },
        message: { content: [{ type: "tool_result", tool_use_id: "fake-message" }] },
      })}\n`);
      parser.feed(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
      fs.mkdirSync(path.join(request.cwd, ".claude", "agent-memory-local", "haiku-scout"), { recursive: true });
      fs.writeFileSync(path.join(request.cwd, ".claude", "agent-memory-local", "haiku-scout", "metadata.json"), "fixture");
      return completedWitnessTurn();
    });
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      driver,
    });
    assert.equal(witness.status, "verified", JSON.stringify(witness, null, 2));
    assert.equal(witness.liveVerified, true);
    assert.equal(witness.requestedModels.haikuScout, "claude-haiku-4-5");
    assert.equal(witness.requestedModels.sonnet, "claude-sonnet-5");
    assert.deepEqual(witness.memberLaunches, { haikuScout: true, sonnet: true });
    assert.equal(witness.teamTransportValidated, true);
    assert.equal(witness.definitionSurface, true);
    assert.deepEqual(witness.intendedEffort, { haikuScout: "low", sonnet: "low" });
    assert.deepEqual(witness.effectiveTeammate, { model: "unknown", effort: "unknown", cost: "unknown" });
    assert.deepEqual(witness.disposable.mutation.unauthorizedPaths, []);
    assert.deepEqual(witness.disposable.mutation.allowedMemoryChangedPaths, [
      ".claude/agent-memory-local/haiku-scout/metadata.json",
    ]);
    assert.deepEqual(witness.disposable.mutation.allowedMemoryMetadataChanges.map((entry) => entry.path), [
      ".claude/agent-memory-local/haiku-scout/metadata.json",
    ]);
    assert.equal(witness.disposable.mutation.allowedMemoryMetadataChanges[0].after.sha256, undefined);
    assert.equal(witness.source.unchanged, true);
    assert.deepEqual(witness.missingEvidence, []);
    assert.deepEqual(witness.settleObservation, { status: "unobservable", executable: "/fake/claude" });
    assert.deepEqual(driver.calls.map((call) => call.method), ["preflight", "validate", "revalidate", "start"]);
  });

  it("creates the disposable running supervisor job before the real Driver reaches its adapter seam", async () => {
    let workspace;
    let observedJob;
    let observedOptions;
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      keepWorkspace: true,
      prepareWorkspace(cwd) {
        workspace = cwd;
      },
      driver: productionWitnessDriver(async (cwd, _prompt, options) => {
        observedJob = readJobFile(cwd, "native-team-witness");
        observedOptions = options;
        return {
          status: "failed",
          exitCode: 1,
          sessionId: null,
          finalMessage: "",
          stderr: "zero-paid adapter seam fixture",
          failureClass: "fixture_failure",
          failureReason: "fixture failure",
          toolUses: [],
          touchedFiles: [],
          terminalEvents: [],
        };
      }),
    });
    try {
      assert.equal(witness.status, "unverified");
      assert.equal(observedJob?.id, "native-team-witness");
      assert.equal(observedJob?.status, "running");
      assert.equal(observedJob?.workspaceRoot, workspace);
      assert.equal(observedOptions?.claudeBin, "/fake/claude");
      assert.equal(observedOptions?.delegationMode, "claude_orchestrator");
      assert.equal(fs.existsSync(resolveJobFile(workspace, "native-team-witness")), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("cleans the disposable job and workspace when preflight or turn start fails", async () => {
    let preflightWorkspace;
    await assert.rejects(
      runNativeTeamWitness({
        sourceRoot: SOURCE_ROOT,
        prepareWorkspace(cwd) {
          preflightWorkspace = cwd;
        },
        driver: {
          preflight() {
            throw new Error("fixture preflight failure");
          },
        },
      }),
      /fixture preflight failure/,
    );
    assert.equal(fs.existsSync(preflightWorkspace), false);

    let startWorkspace;
    await assert.rejects(
      runNativeTeamWitness({
        sourceRoot: SOURCE_ROOT,
        keepWorkspace: true,
        prepareWorkspace(cwd) {
          startWorkspace = cwd;
        },
        driver: fakeWitnessDriver(async (request) => {
          assert.equal(readJobFile(request.cwd, "native-team-witness")?.status, "running");
          throw new Error("fixture turn-start failure");
        }),
      }),
      /fixture turn-start failure/,
    );
    try {
      assert.equal(fs.existsSync(resolveJobFile(startWorkspace, "native-team-witness")), false);
    } finally {
      fs.rmSync(startWorkspace, { recursive: true, force: true });
    }
  });

  it("leaves the witness unverified when the bounded adapter reports a member overflow", async () => {
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      driver: fakeWitnessDriver(async (request) => {
        request.onNativeTeamWitness({ type: "native_team_witness_overflow" });
        return completedWitnessTurn();
      }),
    });
    assert.equal(witness.status, "unverified");
    assert.ok(witness.missingEvidence.includes("witness_event_overflow"));
  });

  it("rejects a symlinked native-memory ancestor before a fake turn can start", async () => {
    let attempts = 0;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hd-native-team-outside-"));
    temporaryDirectories.push(outside);
    fs.mkdirSync(path.join(outside, "agent-memory-local", "haiku-scout"), { recursive: true });
    fs.mkdirSync(path.join(outside, "agent-memory-local", "sonnet"), { recursive: true });
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      prepareWorkspace(cwd) {
        fs.rmSync(path.join(cwd, ".claude"), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(cwd, ".claude"));
      },
      driver: fakeWitnessDriver(async () => {
        attempts += 1;
        throw new Error("memory ancestry must stop before launching a turn");
      }),
    });
    assert.equal(attempts, 0);
    assert.equal(witness.status, "unverified");
    assert.ok(witness.missingEvidence.includes("memory_root_invalid"));
  });

  it("rejects ignored and non-ignored disposable writes outside the two memory prefixes", async () => {
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      driver: fakeWitnessDriver(async (request) => {
        fs.writeFileSync(path.join(request.cwd, ".gitignore"), "ignored-fixture.txt\n", "utf8");
        fs.writeFileSync(path.join(request.cwd, "ignored-fixture.txt"), "ignored", "utf8");
        fs.writeFileSync(path.join(request.cwd, "ordinary-fixture.txt"), "ordinary", "utf8");
        return completedWitnessTurn();
      }),
    });
    assert.equal(witness.status, "unverified");
    assert.ok(witness.disposable.mutation.unauthorizedPaths.includes("ignored-fixture.txt"));
    assert.ok(witness.disposable.mutation.unauthorizedPaths.includes("ordinary-fixture.txt"));
  });

  it("records allowed-memory metadata without opening any teammate memory content and rejects a third member path", async () => {
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function guardedReadFileSync(file, ...args) {
      if (String(file).replaceAll("\\", "/").includes("/.claude/agent-memory-local/opus/")) {
        throw new Error("witness must not read third-member memory content");
      }
      return originalReadFileSync.call(this, file, ...args);
    };
    try {
      const witness = await runNativeTeamWitness({
        sourceRoot: SOURCE_ROOT,
        driver: fakeWitnessDriver(async (request) => {
          const memory = path.join(request.cwd, ".claude", "agent-memory-local");
          fs.writeFileSync(path.join(memory, "haiku-scout", "metadata.json"), "allowed", "utf8");
          fs.mkdirSync(path.join(memory, "opus"), { recursive: true });
          fs.writeFileSync(path.join(memory, "opus", "private.md"), "must stay unopened", "utf8");
          return completedWitnessTurn();
        }),
      });
      assert.equal(witness.status, "unverified");
      assert.deepEqual(witness.disposable.mutation.allowedMemoryChangedPaths, [
        ".claude/agent-memory-local/haiku-scout/metadata.json",
      ]);
      assert.ok(witness.disposable.mutation.unauthorizedPaths.includes(".claude/agent-memory-local/opus/private.md"));
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  it("leaves the witness unverified when the capped memory metadata snapshot overflows", async () => {
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      maxSnapshotPaths: 4,
      driver: fakeWitnessDriver(async () => completedWitnessTurn()),
    });
    assert.equal(witness.status, "unverified");
    assert.ok(witness.missingEvidence.includes("disposable_snapshot_overflow"));
  });

  it("detects a pre-dirty source content mutation even when Git status text is unchanged", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hd-native-team-source-"));
    temporaryDirectories.push(sourceRoot);
    assert.equal(spawnSync("git", ["-C", sourceRoot, "init", "--quiet"]).status, 0);
    fs.writeFileSync(path.join(sourceRoot, "pre-dirty.txt"), "before", "utf8");
    const witness = await runNativeTeamWitness({
      sourceRoot,
      driver: fakeWitnessDriver(async () => {
        fs.writeFileSync(path.join(sourceRoot, "pre-dirty.txt"), "after", "utf8");
        return completedWitnessTurn();
      }),
    });
    assert.equal(witness.status, "unverified");
    assert.equal(witness.source.statusBefore, witness.source.statusAfter);
    assert.equal(witness.source.unchanged, false);
    assert.ok(witness.source.changedPaths.includes("pre-dirty.txt"));
  });

  it("stops the native witness on an account limit without a second paid attempt", async () => {
    let attempts = 0;
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      driver: fakeWitnessDriver(async () => {
        attempts += 1;
        return completedWitnessTurn({
          status: "failed", exitStatus: 1,
          failure: { class: "usage_or_subscription_limit", reason: "subscription usage limit reached", detail: null },
        });
      }),
    });
    assert.equal(attempts, 1);
    assert.equal(witness.status, "account_limit_stopped");
    assert.equal(witness.liveVerified, false);
  });

  it("does not verify a failed Driver terminal turn even when native events claim completion", async () => {
    const witness = await runNativeTeamWitness({
      sourceRoot: SOURCE_ROOT,
      driver: fakeWitnessDriver(async () => completedWitnessTurn({
        status: "failed", exitStatus: 1, failure: { class: "fatal", reason: "failed", detail: null },
      })),
    });
    assert.equal(witness.liveVerified, false);
    assert.ok(witness.missingEvidence.includes("successful_terminal"));
    assert.ok(witness.missingEvidence.includes("native_team_definition_surface"));
  });

  it("rejects mutually exclusive paid CLI modes before a model can launch", () => {
    const result = spawnSync(process.execPath, [
      path.join(SOURCE_ROOT, "scripts", "release-smoke.mjs"),
      "--real-claude",
      "--native-team-witness",
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive paid smoke modes/i);
    assert.doesNotMatch(result.stderr, /Starting explicit paid/i);
  });

  it("loads the canonical differential receipt into the production CLI and fails its release outcome", async () => {
    const stdout = [];
    const canonicalReceipt = path.join(
      SOURCE_ROOT, "tests", "runtime", "fixtures", "native-parity", "native-harness-differential-parity.receipt.json",
    );
    let suppliedReceipt;
    const exitCode = await runReleaseSmokeCli([], {
      sourceRoot: SOURCE_ROOT,
      assertCheckoutDependencies() {},
      readFileSync(receiptPath, encoding) {
        assert.equal(receiptPath, canonicalReceipt);
        return fs.readFileSync(receiptPath, encoding);
      },
      async runReleaseSmoke(options) {
        suppliedReceipt = options.differentialParityReceipt;
        const assessment = assessNativeHarnessDifferentialParity(suppliedReceipt);
        return {
          status: assessment.status,
          promotionEligible: assessment.promotionEligible,
        };
      },
      writeStdout(value) { stdout.push(value); },
      writeStderr() {},
    });
    assert.equal(exitCode, 1);
    assert.equal(suppliedReceipt.schema, "harnessdock.native-harness-differential-parity.v1");
    assert.deepEqual(JSON.parse(stdout.join("")), { status: "hold", promotionEligible: false });
  });

  for (const [label, readFileSync] of [
    ["missing", () => { throw new Error("ENOENT canonical receipt"); }],
    ["malformed", () => "{"],
  ]) {
    it(`fails closed when the canonical differential receipt is ${label}`, async () => {
      const stderr = [];
      let called = false;
      const exitCode = await runReleaseSmokeCli([], {
        sourceRoot: path.join(os.tmpdir(), "release-smoke-canonical-receipt"),
        assertCheckoutDependencies() {},
        readFileSync,
        async runReleaseSmoke() { called = true; },
        writeStdout() {},
        writeStderr(value) { stderr.push(value); },
      });
      assert.equal(exitCode, 1);
      assert.equal(called, false);
      assert.match(stderr.join(""), label === "missing" ? /ENOENT canonical receipt/ : /JSON/);
    });
  }

  it("does not accept a CLI receipt override", async () => {
    let called = false;
    const exitCode = await runReleaseSmokeCli(["--differential-parity-receipt", "replacement.json"], {
      assertCheckoutDependencies() {},
      async runReleaseSmoke() { called = true; },
      writeStdout() {},
      writeStderr() {},
    });
    assert.equal(exitCode, 1);
    assert.equal(called, false);
  });

  it("prints an unverified native-team report before returning a nonzero CLI outcome without launching a model", async () => {
    const stdout = [];
    const stderr = [];
    const exitCode = await runReleaseSmokeCli(["--native-team-witness"], {
      assertCheckoutDependencies() {},
      async runNativeTeamWitness() {
        return { status: "account_limit_stopped", liveVerified: false, missingEvidence: ["successful_terminal"] };
      },
      writeStdout(value) { stdout.push(value); },
      writeStderr(value) { stderr.push(value); },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(stdout.join("")), {
      status: "account_limit_stopped", liveVerified: false, missingEvidence: ["successful_terminal"],
    });
    assert.match(stderr.join(""), /Starting explicit paid native-team witness/i);
    assert.doesNotMatch(stderr.join(""), /model quality/i);
  });

  it("returns zero only for a live-verified native-team CLI report without launching a model", async () => {
    const stdout = [];
    const exitCode = await runReleaseSmokeCli(["--native-team-witness"], {
      assertCheckoutDependencies() {},
      async runNativeTeamWitness() {
        return { status: "verified", liveVerified: true };
      },
      writeStdout(value) { stdout.push(value); },
      writeStderr() {},
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.join("")), { status: "verified", liveVerified: true });
  });

  it("converts a native-team witness exception into a structured unverified CLI report", async () => {
    const stdout = [];
    const exitCode = await runReleaseSmokeCli(["--native-team-witness"], {
      assertCheckoutDependencies() {},
      async runNativeTeamWitness() {
        throw new Error("fixture preflight failed");
      },
      writeStdout(value) { stdout.push(value); },
      writeStderr() {},
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(stdout.join("")), {
      status: "unverified", liveVerified: false, reason: "native_team_witness_error",
    });
  });
});

describe("release smoke: the installed surface must be complete, not merely present", () => {
  it("refuses an installed Plugin whose MCP surface is not the eight-tool contract", async () => {
    const fixture = matchingSnapshot();
    await assert.rejects(
      runReleaseSmoke({
        installed: fixture.installed,
        // `healthy: false` is what the probe reports for a surface that is not
        // exactly the eight tools, an unexpected Agent, a Harness count that
        // does not match this release, or a schema that accepted an undeclared
        // argument.
        probeMcp: async () => ({
          healthy: false,
          tools: HARNESSDOCK_MCP_TOOL_NAMES.slice(0, 7),
          agentCount: 0,
          harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
          schemaRejected: true,
          paid: { requested: false, status: "skipped" },
        }),
      }),
      /eight-tool contract/,
    );
  });

  it("carries the zero-model witnesses into the report", async () => {
    const fixture = matchingSnapshot();
    const report = await runReleaseSmoke({
      installed: fixture.installed,
      probeMcp: async () => ({
        healthy: true,
        tools: [...HARNESSDOCK_MCP_TOOL_NAMES],
        agentCount: 0,
        harnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
        schemaRejected: true,
        paid: { requested: false, status: "skipped" },
      }),
    });
    assert.equal(report.status, "pass");
    // Zero model cost is the property this smoke exists to keep: it observes
    // Skills, tools, and Harness admission, and starts no turn.
    assert.equal(report.zeroModelCost, true);
    assert.deepEqual(report.paid, { requested: false, status: "skipped" });
    assert.equal(report.skills.length, 8);
    assert.equal(report.tools.length, 8);
  });
});
