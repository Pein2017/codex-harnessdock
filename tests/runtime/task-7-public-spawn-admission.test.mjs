/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 7 of add-opencode-explorer-driver: the failure-mode matrix of the
 * public two-Harness spawn surface, and the two cross-Harness properties one
 * root must hold.
 *
 * Nothing here reaches a real Harness. Every OpenCode observation points at a
 * fake Server on an ephemeral loopback port; the Claude side is seamed at the
 * same readiness and launch boundaries the Phase A suites already seam. No
 * test in this file creates a native session or makes a model request.
 *
 * The properties under test:
 *
 *   - a route is stated in full or it is refused, and every refusal happens
 *     before any durable Agent, any mutating request, or any lease exists;
 *   - a Harness identity is exact -- unknown, miscased, and absent are all the
 *     same refusal, and none of them resolves to a default;
 *   - a model is stated in full -- an alias, a bare model ID, and a foreign
 *     provider are three different ways of not naming this route's model;
 *   - a route that proves an operation unsupported answers with a receipt, not
 *     an exception and not a substitute call;
 *   - one root may own Agents on both Harnesses at once, and neither Agent's
 *     mailbox, route, or completion may reach the other;
 *   - a writer lease is released under the canonical workspace root the
 *     durable record was written with, never under a fresh alias of it.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import {
  acquireWorkspaceWriterLease,
  releaseLeasesOnSettlement,
} from "../../runtime/workspace-writer-lease.mjs";
import { readJobFile, resolveJobFile } from "../../runtime/job-store.mjs";
import { resolveVersionThreeJobDirectory } from "../../runtime/v3-job-store.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { canonicalAgentWorkspaceRoot } from "../../runtime/agent-store.mjs";
import { inspectLeaseInventory } from "../../runtime/instance-admission-lease.mjs";
import {
  markNativeSubmissionStarted,
  readLaunchClaim,
  recordLaunchAcceptanceRejected,
} from "../../runtime/launch-claim.mjs";
import { rollbackPreparedVersionThreeTurn } from "../../runtime/v3-worker-entry.mjs";
import {
  HARNESS_EXECUTION_LIFECYCLES,
  harnessExecutionLifecycle,
  resolveDriverV2,
} from "../../runtime/harness-registry.mjs";
import {
  OPENCODE_EXPLORER_MODEL,
  OPENCODE_EXPLORER_MODEL_ID,
  OPENCODE_EXPLORER_MODEL_ROUTES,
  OPENCODE_EXPLORER_PROFILE_NAME,
  OPENCODE_EXPLORER_PROVIDER_ID,
  OPENCODE_HARNESS_ID,
} from "../../runtime/opencode-explorer-profile.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const RUNTIME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-spawn-admission-home-"));
const CODEX_HOME = path.join(RUNTIME_HOME, "codex-home");
process.on("exit", () => fs.rmSync(RUNTIME_HOME, { recursive: true, force: true }));

function compliantRuleset() {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
  ];
}

/** A ready fake Explorer Server, with only the discovery routes exercised. */
async function startReadyFake(scenario = {}) {
  const providers = [...new Set(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.providerId))];
  const server = createFakeOpencodeServer({
    agents: {
      status: 200,
      body: [{
        name: OPENCODE_EXPLORER_PROFILE_NAME,
        mode: "primary",
        native: false,
        permission: compliantRuleset(),
        model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
        options: {},
      }],
    },
    provider: {
      status: 200,
      body: {
        all: providers.map((providerId) => ({
          id: providerId,
          models: Object.fromEntries(
            OPENCODE_EXPLORER_MODEL_ROUTES
              .filter((route) => route.providerId === providerId)
              .map((route) => [route.modelId, {
                id: route.modelId,
                providerID: route.providerId,
                variants: { high: {} },
              }])
          ),
        })),
        connected: providers,
        default: {},
      },
    },
    ...scenario,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

/**
 * One disposable root that can serve both Harnesses: a fake Explorer Server
 * for OpenCode, and a seamed readiness observation for Claude.
 */
function setup(serverUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-spawn-admission-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  const envFile = path.join(root, "runtime.env");
  fs.writeFileSync(
    envFile,
    `CLAUDE_CONFIG_DIR=${claudeConfigDir}\nOPENCODE_SERVER_URL=${serverUrl}\n`
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_HOME,
      CODEX_THREAD_ID: "spawn-admission-root",
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "spawn-admission-root",
      CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { runtime, workspace, root, claudeConfigDir };
}

/**
 * Seam only the Claude half of route-time readiness. The OpenCode half keeps
 * observing the fake Server for real, so an OpenCode refusal in this file is
 * always the production observation's own.
 */
function seamClaudeReadiness(runtime) {
  const base = runtime.jobs.inspectRouteInstance.bind(runtime.jobs);
  runtime.jobs.inspectRouteInstance = async (harnessId) => {
    if (harnessId === OPENCODE_HARNESS_ID) return base(harnessId);
    return {
      driver: resolveDriverV2(harnessId, { env: runtime.jobs.env }),
      inspections: [{
        harnessId,
        instanceKey: claudeCodeInstanceKey(runtime.jobs.env.CLAUDE_CONFIG_DIR),
        readiness: "ready",
        liveValidated: true,
        maturity: "experimental",
        detailCode: "ready",
        routes: {
          models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"],
          topologies: ["leaf", "native_orchestrator"],
          interaction: "noninteractive_fixed_policy",
        },
      }],
    };
  };
  return runtime;
}

/** The version-one readiness receipt the legacy Claude launch path consumes. */
function claudeReadiness(runtime) {
  return {
    ready: true,
    availability: { available: true },
    compatibility: {
      staticCompatible: true,
      fingerprint: "test-compatible-claude",
      executable: process.execPath,
      version: "test",
    },
    auth: { loggedIn: true },
    cwd: runtime.jobs.cwd,
    claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR ?? null,
    sourceRoot: runtime.jobs.sourceRoot,
  };
}

/** Seam the Claude launch so a Claude Agent reaches `working` with no CLI. */
function seamClaudeLaunch(runtime) {
  runtime.jobs.assertReady = () => claudeReadiness(runtime);
  runtime.jobs.launchPreparedStart = async (prepared) => ({
    jobId: prepared.jobId,
    agentId: prepared.agentId,
    status: "queued",
  });
  return runtime;
}

/** The exact route this runtime accepts for the Explorer, with no side effect. */
function explorerRequest(overrides = {}) {
  return {
    task_name: "explorer",
    message: "Name the module that owns the static Driver table.",
    harness: OPENCODE_HARNESS_ID,
    model: OPENCODE_EXPLORER_MODEL,
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
    ...overrides,
  };
}

function mutatingRequests(server) {
  return server.requests.filter((request) => request.method !== "GET");
}

// ---------------------------------------------------------------------------
// A route is stated in full, or it is refused.
// ---------------------------------------------------------------------------

describe("Task 7 — the public spawn refuses an incompletely stated route", () => {
  it("refuses an old-generation payload that states no Harness at all", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    let observed = 0;
    const base = runtime.jobs.inspectRouteInstance.bind(runtime.jobs);
    runtime.jobs.inspectRouteInstance = async (harnessId) => {
      observed += 1;
      return base(harnessId);
    };

    await assert.rejects(
      runtime.spawnAgent({
        task_name: "old_generation",
        message: "a pre-generation caller states no Harness",
        model: "claude-sonnet-5",
        topology: "leaf",
        write: false,
      }),
      /spawn_agent harness must be non-empty text/
    );

    // Nothing was observed, nothing was created, nothing was sent.
    assert.equal(observed, 0);
    assert.equal(runtime.store.listAgents().length, 0);
    assert.deepEqual(server.requests, []);
  });

  it("names each missing route field and refuses before any readiness observation", async () => {
    const cases = [
      { omit: "model", error: /spawn_agent model must be non-empty text/ },
      { omit: "reasoning_effort", error: /spawn_agent requires explicit reasoning_effort/ },
      { omit: "topology", error: /spawn_agent topology must be non-empty text/ },
      { omit: "write", error: /spawn_agent requires explicit boolean write authority/ },
    ];
    for (const testCase of cases) {
      const { url, server } = await startReadyFake();
      const { runtime } = setup(url);
      let observed = 0;
      const base = runtime.jobs.inspectRouteInstance.bind(runtime.jobs);
      runtime.jobs.inspectRouteInstance = async (harnessId) => {
        observed += 1;
        return base(harnessId);
      };
      const input = explorerRequest();
      delete input[testCase.omit];

      await assert.rejects(runtime.spawnAgent(input), testCase.error);
      assert.equal(observed, 0, `omitting ${testCase.omit} must not observe readiness`);
      assert.equal(runtime.store.listAgents().length, 0);
      assert.deepEqual(server.requests, []);
    }
  });

  it("refuses a non-boolean write authority rather than coercing it", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    for (const write of ["false", "true", 0, 1, null]) {
      await assert.rejects(
        runtime.spawnAgent(explorerRequest({ write })),
        /spawn_agent requires explicit boolean write authority/
      );
    }
    assert.equal(runtime.store.listAgents().length, 0);
  });

  it("refuses an unknown or miscased Harness and names the admitted set", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    for (const harness of ["OpenCode", "OPENCODE", "Claude-Code", "claude", "gemini-cli", ""]) {
      await assert.rejects(
        runtime.spawnAgent(explorerRequest({ harness })),
        (error) => {
          if (harness === "") return /spawn_agent harness must be non-empty text/.test(error.message);
          assert.match(error.message, /this runtime admits only claude-code, opencode/);
          assert.match(error.message, /There is no default Harness/);
          return true;
        }
      );
    }
    assert.equal(runtime.store.listAgents().length, 0);
    assert.equal(server.requests.every((request) => request.method === "GET"), true);
  });
});

// ---------------------------------------------------------------------------
// A model is stated in full.
// ---------------------------------------------------------------------------

describe("Task 7 — the Explorer route refuses every model it does not serve", () => {
  it("refuses an alias, a bare model ID, a foreign provider, and the other Harness's model", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    const refused = [
      OPENCODE_EXPLORER_MODEL_ID,
      "opencode-go",
      "opencode-go/",
      "/deepseek-v4-flash",
      "anthropic/deepseek-v4-flash",
      "opencode-go/deepseek-v4",
      "claude-sonnet-5",
      OPENCODE_EXPLORER_MODEL.toUpperCase(),
      `${OPENCODE_EXPLORER_MODEL}-preview`,
    ];
    for (const model of refused) {
      await assert.rejects(
        runtime.spawnAgent(explorerRequest({ model })),
        /provider\/model|requires one freshly advertised exact model|does not serve model .* A model is stated in full and is never aliased, completed, or substituted/s,
        `model ${JSON.stringify(model)} must be refused`
      );
    }
    assert.equal(runtime.store.listAgents().length, 0);
    assert.equal(server.requests.every((request) => request.method === "GET"), true);
  });

  it("refuses the Explorer model on the Claude Harness", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    seamClaudeReadiness(runtime);
    await assert.rejects(
      runtime.spawnAgent(explorerRequest({ harness: "claude-code" })),
      /Unsupported Claude model|Harness claude-code does not serve model/
    );
    assert.equal(runtime.store.listAgents().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Topology, authority, and turn options the Explorer route proves it refuses.
// ---------------------------------------------------------------------------

describe("Task 7 — the Explorer route refuses what its own capabilities deny", () => {
  it("refuses a non-leaf topology after observing, but before any mutating request", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    await assert.rejects(
      runtime.spawnAgent(explorerRequest({ topology: "native_orchestrator" })),
      /topology/
    );
    assert.equal(runtime.store.listAgents().length, 0);
    assert.deepEqual(mutatingRequests(server), []);
  });

  it("keeps behavioral write authority in the accepted route", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest({ write: true }),
      "spawn_agent",
    );
    assert.equal(accepted.route.authority, "behavioral_write");
    assert.equal(runtime.store.listAgents().length, 0);
    assert.deepEqual(mutatingRequests(server), []);
  });

  it("admits only an exact advertised reasoning variant", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    const accepted = await runtime.acceptStatedRoute(explorerRequest(), "spawn_agent");
    assert.equal(accepted.route.effort, "high");
    await assert.rejects(
      runtime.acceptStatedRoute(explorerRequest({ reasoning_effort: "unadvertised" }), "spawn_agent"),
      /effort|variant/i,
    );
    assert.equal(runtime.store.listAgents().length, 0);
    assert.deepEqual(mutatingRequests(server), []);
  });
});

// ---------------------------------------------------------------------------
// A route that proves an operation unsupported answers with a receipt.
// ---------------------------------------------------------------------------

describe("Task 7 — an Explorer Agent answers unsupported operations with a receipt", () => {
  async function explorerAgent(runtime) {
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest(),
      "spawn_agent"
    );
    const store = runtime.versionThreeStore();
    const agent = store.createAgent({
      task_name: "explorer",
      route: accepted.route,
      initialMessage: "Name the module that owns the static Driver table.",
    });
    const activation = store.reserveActivation(agent.agentId, "hd-agent-explorer-turn", { initial: true });
    assert.equal(activation.reserved, true);
    return store.resolveTarget(agent.agentId);
  }

  it("returns an unsupported interrupt receipt without aborting or calling the Server", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    const agent = await explorerAgent(runtime);
    const before = server.requests.length;

    const receipt = await runtime.interruptAgent({ target: agent.path });

    assert.deepEqual(receipt, {
      agent_name: agent.path,
      harness: OPENCODE_HARNESS_ID,
      status: "unsupported",
      unsupported: {
        operation: "interruptRequest",
        value: "unsupported",
        harness: OPENCODE_HARNESS_ID,
      },
    });
    // No substitute call: not an abort, not a status poll, not a session read.
    assert.equal(server.requests.length, before);
    // The Agent keeps its turn; a receipt is not a cancellation.
    assert.equal(runtime.store.resolveTarget(agent.path).activeJobId, "hd-agent-explorer-turn");
  });

  it("returns an unsupported history receipt with no messages and no transcript read", async () => {
    const { url, server } = await startReadyFake();
    const { runtime } = setup(url);
    const agent = await explorerAgent(runtime);
    const before = server.requests.length;

    const receipt = await runtime.readAgentMessages({ target: agent.path });

    assert.deepEqual(receipt, {
      agent_name: agent.path,
      harness: OPENCODE_HARNESS_ID,
      status: "unsupported",
      unsupported: {
        operation: "history",
        value: "unavailable",
        harness: OPENCODE_HARNESS_ID,
      },
      messages: [],
    });
    assert.equal(server.requests.length, before);
  });

  it("refuses a same-Agent follow-up on a fresh-only route", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    const agent = await explorerAgent(runtime);
    await assert.rejects(
      runtime.followupTask({ target: agent.path, message: "a second turn on the same Agent" }),
      /continuation|fresh|new Agent/i
    );
  });
});

// ---------------------------------------------------------------------------
// One root, both Harnesses, no path between them.
// ---------------------------------------------------------------------------

describe("Task 7 — one root owns Agents on both Harnesses with no cross-Harness path", () => {
  it("keeps two concurrent Agents on different Harnesses fully separate", async () => {
    const { url } = await startReadyFake();
    const { runtime, workspace } = setup(url);
    seamClaudeLaunch(seamClaudeReadiness(runtime));

    const claude = await runtime.spawnAgent({
      task_name: "claude_side",
      message: "the Claude Agent's own first turn",
      harness: "claude-code",
      model: "claude-sonnet-5",
      reasoning_effort: "high",
      topology: "leaf",
      write: false,
    });
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest(),
      "spawn_agent"
    );
    const versionThree = runtime.versionThreeStore();
    const explorer = versionThree.createAgent({
      task_name: "opencode_side",
      route: accepted.route,
      initialMessage: "the Explorer Agent's own first turn",
    });
    versionThree.reserveActivation(explorer.agentId, "hd-agent-explorer-concurrent", { initial: true });

    // Both are live in the same root, each stating its own Harness.
    const listed = runtime.listAgents().agents;
    assert.equal(listed.length, 2);
    const byName = Object.fromEntries(listed.map((card) => [card.agent_name, card]));
    assert.equal(byName[claude.agent_name].harness, "claude-code");
    assert.equal(byName[explorer.path].harness, OPENCODE_HARNESS_ID);
    assert.equal(byName[explorer.path].model, OPENCODE_EXPLORER_MODEL);
    assert.equal(byName[claude.agent_name].model, "claude-sonnet-5");

    // A message addressed to one Agent reaches only that Agent's mailbox.
    runtime.sendMessage({ target: explorer.path, message: "for the Explorer only" });
    const explorerTexts = versionThree.listMessages(explorer.agentId).map((entry) => entry.text);
    const claudeAgentId = runtime.store.resolveTarget(claude.agent_name).agentId;
    const claudeTexts = runtime.store.listMessages(claudeAgentId).map((entry) => entry.text);
    assert.equal(explorerTexts.includes("for the Explorer only"), true);
    assert.equal(claudeTexts.includes("for the Explorer only"), false);
    assert.equal(claudeTexts.includes("the Explorer Agent's own first turn"), false);
    assert.equal(explorerTexts.includes("the Claude Agent's own first turn"), false);

    // Neither Agent's durable record carries the other's route or instance.
    const claudeRecord = runtime.store.resolveTarget(claude.agent_name);
    const explorerRecord = versionThree.resolveTarget(explorer.agentId);
    assert.equal(explorerRecord.route.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(
      JSON.stringify(claudeRecord).includes(OPENCODE_HARNESS_ID),
      false,
      "a Claude Agent record must not carry the OpenCode Harness identity"
    );
    assert.equal(
      JSON.stringify(explorerRecord).includes(claudeRecord.activeJobId ?? "hd-agent-none"),
      false,
      "an Explorer Agent record must not carry the Claude Agent's job identity"
    );

    // The two live turns hold distinct jobs in one workspace.
    assert.notEqual(claudeRecord.activeJobId, explorerRecord.activeJobId);
    assert.equal(canonicalAgentWorkspaceRoot(workspace), explorerRecord.workspaceRoot);

    // One identity plane, two execution machines. Both Agents are version-three
    // records; underneath, each has only its own machine's artifacts.
    assert.equal(claudeRecord.version, 3);
    assert.equal(explorerRecord.version, 3);
    assert.equal(harnessExecutionLifecycle(claudeRecord.route.harnessId), "version_one_supervisor");
    assert.equal(harnessExecutionLifecycle(explorerRecord.route.harnessId), "version_three_worker");

    // The Claude Agent has a version-one supervisor job...
    const claudeJob = readJobFile(workspace, claudeRecord.activeJobId);
    assert.equal(claudeJob?.agentId, claudeRecord.agentId);
    // ...and the Explorer Agent has none of its own.
    assert.equal(readJobFile(workspace, explorerRecord.activeJobId), null);
    // The Explorer was only reserved here; no detached worker was launched, so
    // neither lifecycle has written a version-three job record.
    const versionThreeJobs = resolveVersionThreeJobDirectory({ ownerRootId: runtime.ownerRootId });
    const versionThreeNames = fs.existsSync(versionThreeJobs) ? fs.readdirSync(versionThreeJobs) : [];
    assert.equal(versionThreeNames.length, 0, "a reservation alone creates no version-three job record");
  });
});

// ---------------------------------------------------------------------------
// The writer lease is released under the canonical root it was written with.
// ---------------------------------------------------------------------------

describe("Task 7 — a version-three Agent records the canonical workspace root", () => {
  it("stores the canonical root, not the alias the caller happened to open", async () => {
    const { url } = await startReadyFake();
    const { runtime, workspace } = setup(url);
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest(),
      "spawn_agent"
    );
    const store = runtime.versionThreeStore();
    const agent = store.createAgent({
      task_name: "canonical_root",
      route: accepted.route,
      initialMessage: "first turn",
    });
    const canonical = canonicalAgentWorkspaceRoot(workspace);
    assert.equal(agent.workspaceRoot, canonical);

    // An alias of the same directory canonicalizes to the same stored key, so a
    // later release cannot address a second, differently-spelled lease home.
    const alias = path.join(workspace, ".", "..", path.basename(workspace));
    assert.equal(canonicalAgentWorkspaceRoot(alias), canonical);
  });

  it("releases a stale writer lease under the stored canonical root, not a freshly derived one", async () => {
    const { url } = await startReadyFake();
    const { runtime, workspace } = setup(url);
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest(),
      "spawn_agent"
    );
    const store = runtime.versionThreeStore();
    const agent = store.createAgent({
      task_name: "writer_release",
      route: accepted.route,
      initialMessage: "a turn that holds the workspace writer",
    });
    const storedRoot = agent.workspaceRoot;

    // A writer lease is bound to a behavioral_write route; the Explorer route is
    // read-only, so this states a write route over the same stored root -- the
    // release question is about the ROOT, not the Harness.
    const writeRoute = { ...accepted.route, authority: "behavioral_write" };
    const held = acquireWorkspaceWriterLease({
      ownerRootId: runtime.ownerRootId,
      agentId: agent.agentId,
      jobId: "hd-agent-writer-release",
      route: writeRoute,
      workspaceRoot: storedRoot,
    });
    assert.equal(held.kind, "writer");

    // A worker that re-derived its root from a nested working directory would
    // address a DIFFERENT lease home. This is the mistake the stored root
    // exists to prevent, so prove the two really do differ here.
    const nested = path.join(workspace, "nested");
    fs.mkdirSync(nested, { recursive: true });
    assert.notEqual(canonicalAgentWorkspaceRoot(nested), storedRoot);

    const settled = {
      status: "completed",
      nativeTurn: "terminal",
      executionWorld: { continuity: "not_applicable", settlement: "settled" },
      continuation: { mode: "none" },
      nativeTurnRef: {
        version: 1,
        harnessId: writeRoute.harnessId,
        driverVersion: writeRoute.driverVersion,
        instanceKey: writeRoute.instanceKey,
        locatorVersion: 1,
        locator: { turnId: "hd-agent-writer-release" },
      },
    };
    const releaseTarget = (workspaceRoot) => ({
      kind: "writer",
      ownerRootId: runtime.ownerRootId,
      agentId: agent.agentId,
      jobId: "hd-agent-writer-release",
      route: writeRoute,
      workspaceRoot,
    });

    // The freshly derived root releases nothing real: it addresses a different
    // lease home, so the held lease is untouched.
    const wrong = releaseLeasesOnSettlement({
      normalizedTerminalResult: settled,
      releases: [releaseTarget(nested)],
    });
    assert.equal(wrong.releasedCount, 0);

    // Still held, so a second writer for the stored root is still refused.
    assert.throws(
      () => acquireWorkspaceWriterLease({
        ownerRootId: runtime.ownerRootId,
        agentId: "agent-second-writer",
        jobId: "hd-agent-writer-second",
        route: writeRoute,
        workspaceRoot: storedRoot,
      }),
      /capacity/i
    );

    // The stored canonical root releases it, and the workspace is writable again.
    const released = releaseLeasesOnSettlement({
      normalizedTerminalResult: settled,
      releases: [releaseTarget(storedRoot)],
    });
    assert.equal(released.released, true);
    assert.equal(released.releasedCount, 1);
    assert.equal(released.retainedCount, 0);
    const next = acquireWorkspaceWriterLease({
      ownerRootId: runtime.ownerRootId,
      agentId: "agent-second-writer",
      jobId: "hd-agent-writer-second",
      route: writeRoute,
      workspaceRoot: storedRoot,
    });
    assert.equal(next.kind, "writer");
  });
});

// ---------------------------------------------------------------------------
// One execution lifecycle per Agent, chosen once from its route's Harness.
// ---------------------------------------------------------------------------

describe("Task 7 — each Harness states exactly one execution lifecycle", () => {
  it("runs Claude turns on the version-one supervisor and OpenCode turns on the version-three worker", () => {
    assert.equal(harnessExecutionLifecycle("claude-code"), "version_one_supervisor");
    assert.equal(harnessExecutionLifecycle(OPENCODE_HARNESS_ID), "version_three_worker");
    assert.deepEqual(HARNESS_EXECUTION_LIFECYCLES, [
      "version_one_supervisor",
      "version_three_worker",
    ]);
  });

  it("refuses an unstated, unknown, or miscased Harness rather than defaulting a lifecycle", () => {
    for (const harnessId of [undefined, null, "", "   ", "OpenCode", "gemini-cli"]) {
      assert.throws(
        () => harnessExecutionLifecycle(harnessId),
        /Harness/,
        `${JSON.stringify(harnessId)} must resolve no lifecycle`
      );
    }
  });

  it("keeps the two lifecycles' durable artifacts disjoint for one Explorer turn", async () => {
    const { url } = await startReadyFake();
    const { runtime, workspace } = setup(url);

    const receipt = await runtime.spawnAgent(explorerRequest({ task_name: "lifecycle_probe" }));
    const agentId = runtime.store.resolveTarget(receipt.agent_name).agentId;

    // The detached worker owns settlement; observe the durable projection.
    const deadline = Date.now() + 20_000;
    let card = null;
    while (Date.now() < deadline) {
      card = runtime.listAgents().agents.find((entry) => entry.agent_name === receipt.agent_name);
      if (["completed", "failed", "interrupted", "errored"].includes(card?.agent_status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(card?.agent_status, "completed", "the Explorer turn must settle through the public surface");

    const agent = runtime.versionThreeStore().resolveTarget(agentId);
    assert.equal(agent.version, 3);
    assert.equal(agent.route.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(harnessExecutionLifecycle(agent.route.harnessId), "version_three_worker");

    // A version-three-lifecycle Agent leaves no version-one job file behind.
    const jobsDirectory = path.dirname(resolveJobFile(workspace, "hd-agent-probe"));
    const jobFiles = fs.existsSync(jobsDirectory)
      ? fs.readdirSync(jobsDirectory).filter((entry) => entry.endsWith(".json"))
      : [];
    assert.deepEqual(jobFiles, [], "an OpenCode Agent must write no version-one job record");
  });

  it("rolls back a spawned worker that exits before submission, including raced steering", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    let jobId = null;
    runtime.jobs.launchDependencies.spawn = (_command, args) => {
      jobId = args[args.indexOf("--job-id") + 1];
      const child = new EventEmitter();
      child.pid = 424242;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      child.unref = () => {};
      process.nextTick(() => {
        child.emit("spawn");
        const card = runtime.listAgents().agents.find((entry) => entry.agent_name === "/root/rollback_probe");
        runtime.sendMessage({ target: card.agent_name, message: "raced steering" });
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
      return child;
    };

    await assert.rejects(
      runtime.spawnAgent(explorerRequest({ task_name: "rollback_probe" })),
      /rolled back before native acceptance/,
    );

    const store = runtime.versionThreeStore();
    const agent = store.resolveTarget("/root/rollback_probe");
    assert.equal(agent.activeJobId, null);
    assert.equal(agent.status, "pending_init");
    assert.equal(agent.continuation.mode, "safe_fresh");
    assert.deepEqual(store.listMessages(agent.agentId).map((message) => [message.text, message.state]), [
      ["Name the module that owns the static Driver table.", "queued"],
      ["raced steering", "queued"],
    ]);
    const claim = readLaunchClaim({ ownerRootId: runtime.ownerRootId, agentId: agent.agentId, jobId });
    assert.equal(claim.submissionState, "rollback_complete");
    assert.equal(claim.acceptance, "not_submitted");
    assert.equal(rollbackPreparedVersionThreeTurn({
      cwd: runtime.cwd,
      ownerRootId: runtime.ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId: claim.attemptId,
    }).submissionState, "rollback_complete");
    const heldByAgent = inspectLeaseInventory().entries
      .flatMap((entry) => entry.holders)
      .filter((holder) => holder.agentId === agent.agentId);
    assert.deepEqual(heldByAgent, []);
    assert.equal(readJobFile(runtime.cwd, jobId), null);
  });

  it("leaves no lease or activation when detached OpenCode preflight fails", async () => {
    const { server, url } = await startReadyFake();
    const { runtime } = setup(url);
    const accepted = await runtime.acceptStatedRoute(
      explorerRequest(),
      "spawn_agent",
    );
    server.state.provider = { status: 503, body: { error: "unavailable" } };
    await assert.rejects(
      runtime.spawnVersionThreeAgent({
        accepted,
        taskName: "preflight_rollback",
        description: null,
        message: "must never reach native submission",
        jobId: "hd-agent-preflight-rollback",
        turnOptions: { effort: accepted.route.effort },
      }),
      /submission fence|rolled back|preflight/i,
    );
    assert.equal(runtime.versionThreeStore().readAgent("/root/preflight_rollback"), null);
    const holders = inspectLeaseInventory().entries.flatMap((entry) => entry.holders);
    assert.equal(holders.some((holder) => holder.jobId === "hd-agent-preflight-rollback"), false);
    assert.equal(readJobFile(runtime.cwd, "hd-agent-preflight-rollback"), null);
  });

  it("treats a barrier-controlled acceptance rejection as rollback, never public success", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    let killed = false;
    runtime.jobs.launchDependencies.versionThreeHandoffWaitMs = 1;
    runtime.jobs.launchDependencies.spawn = () => {
      const child = new EventEmitter();
      child.pid = 424243;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => { killed = true; return true; };
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    };
    runtime.jobs.launchDependencies.afterVersionThreeHandoffWait = ({ identity }) => {
      const claim = readLaunchClaim(identity);
      markNativeSubmissionStarted({ ...identity, attemptId: claim.attemptId });
      recordLaunchAcceptanceRejected({
        ...identity,
        attemptId: claim.attemptId,
        sanitizedDetail: "barrier_controlled_pre_transport_rejection",
      });
    };

    await assert.rejects(
      runtime.spawnAgent(explorerRequest({ task_name: "rejected_handoff" })),
      /rolled back before native acceptance/,
    );
    assert.equal(killed, true);
    assert.equal(runtime.versionThreeStore().readAgent("/root/rejected_handoff"), null);
  });

  it("converts a timeout-vs-submission winner to durable unknown and never kills the continuing turn", async () => {
    const { url } = await startReadyFake();
    const { runtime } = setup(url);
    let killed = false;
    runtime.jobs.launchDependencies.versionThreeHandoffWaitMs = 1;
    runtime.jobs.launchDependencies.spawn = () => {
      const child = new EventEmitter();
      child.pid = 424244;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => { killed = true; return true; };
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    };
    runtime.jobs.launchDependencies.afterVersionThreeHandoffWait = ({ identity }) => {
      const claim = readLaunchClaim(identity);
      markNativeSubmissionStarted({ ...identity, attemptId: claim.attemptId });
    };

    const receipt = await runtime.spawnAgent(explorerRequest({ task_name: "submission_wins_handoff" }));
    assert.equal(receipt.status, "working");
    assert.equal(killed, false);
    const agent = runtime.versionThreeStore().resolveTarget("/root/submission_wins_handoff");
    const claim = readLaunchClaim({
      ownerRootId: runtime.ownerRootId,
      agentId: agent.agentId,
      jobId: agent.activeJobId,
    });
    assert.equal(claim.submissionState, "started");
    assert.equal(claim.acceptance, "acceptance_unknown");
  });

  it("starts two public Explorer Agents concurrently without an instance capacity ceiling", async () => {
    const { server, url } = await startReadyFake({ promptDelayMs: 2_000 });
    const { runtime } = setup(url);
    const first = await runtime.spawnAgent(explorerRequest({ task_name: "capacity_one" }));
    const second = await runtime.spawnAgent(explorerRequest({ task_name: "capacity_two" }));

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const sessions = server.requests.filter((request) => request.method === "POST" && request.path === "/session");
      if (sessions.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      server.requests.filter((request) => request.method === "POST" && request.path === "/session").length,
      2
    );

    while (Date.now() < deadline) {
      const cards = runtime.listAgents().agents.filter((entry) =>
        [first.agent_name, second.agent_name].includes(entry.agent_name)
      );
      if (cards.length === 2 && cards.every((card) => card.agent_status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cards = runtime.listAgents().agents.filter((entry) =>
      [first.agent_name, second.agent_name].includes(entry.agent_name)
    );
    assert.deepEqual(cards.map((card) => card.agent_status).sort(), ["completed", "completed"]);
  });
});
