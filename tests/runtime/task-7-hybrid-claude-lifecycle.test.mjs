/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 7 of add-opencode-explorer-driver: the hybrid Claude Agent.
 *
 * A new-generation Claude Agent gets the same identity plane every other
 * Harness gets -- a version-three record whose whole route is immutable from
 * creation -- while its turns keep running on the version-one supervisor,
 * because that machinery IS the Claude contract. Nothing here reaches a real
 * Claude CLI: readiness and launch are seamed at the same boundaries the Phase
 * A suites already seam.
 *
 * The properties under test:
 *
 *   - a new Claude spawn writes a version-three Agent stating the whole route;
 *   - that Agent's turn has version-one job artifacts and no version-three job
 *     record, and the OpenCode Agent beside it has the exact inverse;
 *   - `interrupt_agent` on it steers through the version-one execution path and
 *     produces today's receipt, which is the positive half of the
 *     store-version/execution-lifecycle split;
 *   - bound native history resolves the Claude configuration directory from the
 *     runtime's own environment and PROVES it by re-hashing against the route's
 *     pinned instance key;
 *   - an environment naming a different Claude configuration fails closed, and
 *     the resolved absolute path never enters any serialized shape;
 *   - pre-generation version-one and version-two Agents are untouched by all of
 *     it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { harnessExecutionLifecycle, resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { readJobFile, writeJobFile } from "../../runtime/job-store.mjs";
import { observeClaudeCredentialState } from "../../runtime/claude-credential-state.mjs";
import { resolveVersionThreeJobDirectory } from "../../runtime/v3-job-store.mjs";
import { CLAUDE_LEGACY_HARNESS_ID } from "../../runtime/claude-legacy-adapter.mjs";
import { ADMITTED_GENERATION_HARNESS_IDS } from "../../runtime/harness-registry.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

const RUNTIME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hybrid-home-"));
process.on("exit", () => fs.rmSync(RUNTIME_HOME, { recursive: true, force: true }));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hybrid-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(claudeConfigDir, "projects"), { recursive: true });
  const envFile = path.join(root, "runtime.env");
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_THREAD_ID: "hybrid-root",
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "hybrid-root",
      CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  seamClaude(runtime);
  return { runtime, workspace, root, claudeConfigDir };
}

function readinessReceipt(runtime) {
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

/** Seam every host observation; no real Claude CLI is reached. */
function seamClaude(runtime) {
  runtime.jobs.inspectRouteInstance = async (harnessId) => ({
    driver: resolveDriverV2(harnessId, { env: runtime.jobs.env }),
    // Production states the version-one launch receipt from the same
    // observation; the seam does the same so the spawn path is exercised as it
    // actually runs.
    launchReadiness: readinessReceipt(runtime),
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
  });
  runtime.jobs.assertReady = () => readinessReceipt(runtime);
  runtime.jobs.launchPreparedStart = async (prepared) => ({
    jobId: prepared.jobId,
    agentId: prepared.agentId,
    status: "queued",
  });
  return runtime;
}

async function spawnClaude(runtime, overrides = {}) {
  return runtime.spawnAgent({
    task_name: "hybrid_claude",
    message: "the first Claude turn",
    harness: "claude-code",
    model: "claude-sonnet-5",
    topology: "leaf",
    write: false,
    ...overrides,
  });
}

/** One eligible outer-assistant transcript for a bound Claude session. */
function writeTranscript(claudeConfigDir, workspaceRoot, sessionId, texts) {
  const directory = path.join(
    claudeConfigDir,
    "projects",
    workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${sessionId}.jsonl`);
  const lines = texts.map((text, index) => JSON.stringify({
    type: "assistant",
    sessionId,
    uuid: `msg-${index + 1}`,
    timestamp: `2026-08-1${index + 1}T00:00:00.000Z`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("Task 7 hybrid — a new Claude spawn writes a version-three Agent", () => {
  it("states the whole route on the record and freezes it", async () => {
    const { runtime } = setup();
    const receipt = await spawnClaude(runtime);

    const agent = runtime.versionThreeStore().resolveTarget(receipt.agent_name);
    assert.equal(agent.version, 3);
    assert.equal(agent.route.harnessId, "claude-code");
    assert.equal(agent.route.model, "claude-sonnet-5");
    assert.equal(agent.route.topology, "leaf");
    assert.equal(agent.route.authority, "behavioral_read_only");
    assert.equal(agent.route.instanceKey, claudeCodeInstanceKey(runtime.jobs.env.CLAUDE_CONFIG_DIR));
    // The route's instance key is the redacted identity, never the raw path.
    assert.match(agent.route.instanceKey, /^claude-config-[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(agent).includes(runtime.jobs.env.CLAUDE_CONFIG_DIR), false);
    // The public card keeps stating the same lineage.
    assert.equal(receipt.harness, "claude-code");
    assert.equal(receipt.model, "claude-sonnet-5");
  });

  it("runs its turn on the version-one supervisor and writes no version-three job record", async () => {
    const { runtime, workspace } = setup();
    const receipt = await spawnClaude(runtime);
    const agent = runtime.versionThreeStore().resolveTarget(receipt.agent_name);

    assert.equal(harnessExecutionLifecycle(agent.route.harnessId), "version_one_supervisor");
    // Durable vocabulary: identifiers minted after the physical rename carry the
    // HarnessDock prefix. No reader accepts the retired one, because the state
    // reset leaves no pre-rename record to read.
    assert.match(agent.activeJobId, /^hd-agent-/);
    const job = readJobFile(workspace, agent.activeJobId);
    assert.equal(job?.id, agent.activeJobId);
    assert.equal(job.agentId, agent.agentId);

    // The durable version-three job records live under the plugin state root,
    // not the workspace, so this looks where they would actually be.
    const versionThreeJobs = resolveVersionThreeJobDirectory({ ownerRootId: "hybrid-root" });
    assert.equal(
      fs.existsSync(versionThreeJobs) && fs.readdirSync(versionThreeJobs).length > 0,
      false,
      "a version-one-lifecycle Agent must write no version-three job record"
    );
  });

  it("steers interrupt_agent through the version-one execution path", async () => {
    const { runtime, workspace } = setup();
    const receipt = await spawnClaude(runtime);
    const agent = runtime.versionThreeStore().resolveTarget(receipt.agent_name);
    // The supervisor job has to look live for a control request to reach it,
    // exactly as the seamed launch would have left it running.
    const job = readJobFile(workspace, agent.activeJobId);
    assert.ok(job, "the version-one supervisor job must exist");
    writeJobFile(workspace, agent.activeJobId, { ...job, status: "running" });

    const interrupt = await runtime.interruptAgent({ target: receipt.agent_name });
    // Today's receipt: a status, never an unsupported route receipt.
    assert.equal(interrupt.agent_name, receipt.agent_name);
    assert.equal(Object.hasOwn(interrupt, "unsupported"), false);
    assert.equal(typeof interrupt.status, "string");
    assert.notEqual(interrupt.status, "unsupported");
  });

  it("delivers an active send_message through the version-one steering path", async () => {
    const { runtime } = setup();
    const receipt = await spawnClaude(runtime);
    const delivery = runtime.sendMessage({ target: receipt.agent_name, message: "steer me" });
    assert.equal(delivery.agent_name, receipt.agent_name);
    // A version-three record on the version-one lifecycle must not be forced
    // onto the queued-only path the version-three worker uses.
    assert.notEqual(delivery.delivery, undefined);
    assert.equal(["dispatched_active", "activation_pending"].includes(delivery.delivery), true);
  });
});

describe("Task 7 hybrid — the pinned Claude instance is re-proven at use time", () => {
  it("reads bound native history for a version-three Claude Agent", async () => {
    const { runtime, workspace, claudeConfigDir } = setup();
    const receipt = await spawnClaude(runtime);
    const store = runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    const sessionId = "11111111-2222-3333-4444-555555555555";
    writeTranscript(claudeConfigDir, agent.workspaceRoot, sessionId, [
      "the first outer answer",
      "the second outer answer",
    ]);
    store.bindSession(agent.agentId, sessionId, { jobId: agent.activeJobId });

    const history = await runtime.readAgentMessages({ target: receipt.agent_name, limit: 5 });
    assert.equal(history.agent_name, receipt.agent_name);
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages[0].text, "the second outer answer");
    assert.equal(history.messages[1].text, "the first outer answer");
    // The resolved absolute configuration path never enters the receipt.
    assert.equal(JSON.stringify(history).includes(claudeConfigDir), false);
    assert.equal(JSON.stringify(history).includes(workspace), false);
  });

  it("fails closed when the environment names a different Claude configuration", async () => {
    const { runtime, claudeConfigDir, root } = setup();
    const receipt = await spawnClaude(runtime);
    const store = runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    const sessionId = "99999999-8888-7777-6666-555555555555";
    writeTranscript(claudeConfigDir, agent.workspaceRoot, sessionId, ["an answer"]);
    store.bindSession(agent.agentId, sessionId, { jobId: agent.activeJobId });

    // The operator's configuration moved after the route pinned its instance.
    const moved = path.join(root, "claude-moved");
    fs.mkdirSync(path.join(moved, "projects"), { recursive: true });
    runtime.jobs.env.CLAUDE_CONFIG_DIR = moved;

    await assert.rejects(
      runtime.readAgentMessages({ target: receipt.agent_name }),
      (error) => {
        assert.match(error.message, /instance/i);
        // No absolute operator path in the refusal.
        assert.equal(error.message.includes(moved), false);
        assert.equal(error.message.includes(claudeConfigDir), false);
        return true;
      }
    );
  });

  it("refuses history for a version-three Claude Agent with no proven session", async () => {
    const { runtime } = setup();
    const receipt = await spawnClaude(runtime);
    await assert.rejects(
      runtime.readAgentMessages({ target: receipt.agent_name }),
      /no proven native session history/
    );
  });
});

describe("Task 7 hybrid — pre-generation Agents are untouched", () => {
  it("leaves an existing version-two Agent readable, steerable, and version two", async () => {
    const { runtime, workspace } = setup();
    // A pre-generation Agent, created the way the previous generation did.
    const legacy = runtime.store.createAgent({
      task_name: "pre_generation",
      selectedModel: "claude-sonnet-5",
      initialMessage: "an older turn",
    });
    assert.equal(legacy.version, 2);

    await spawnClaude(runtime, { task_name: "new_generation" });

    const reread = runtime.store.resolveTarget(legacy.path);
    assert.equal(reread.version, 2);
    // A version-two record's `route` is the legacy projection, never a frozen
    // version-three route: it states no instance, authority, or capabilities.
    assert.equal(reread.route?.instanceKey ?? null, null);
    assert.equal(reread.route?.authority ?? null, null);
    assert.equal(reread.route?.capabilitySchemaVersion ?? null, null);
    const cards = runtime.listAgents().agents;
    assert.equal(cards.length, 2);
    assert.equal(cards.every((card) => card.harness === "claude-code"), true);
    // The older record still takes a message through its own generation.
    const delivery = runtime.sendMessage({ target: legacy.path, message: "still reachable" });
    assert.equal(delivery.agent_name, legacy.path);
    assert.equal(fs.existsSync(workspace), true);
  });
});

describe("Task 7 hybrid — one lifecycle rule, stated in two places", () => {
  it("pins the registry's rule to the durable store's restatement of it", () => {
    // `runtime/agent-store.mjs` restates the lifecycle rule in the one Harness
    // identity it already imports, so the durable layer takes on no dependency
    // on the Driver graph. If a second version-one-supervisor Harness is ever
    // admitted, this fails and that restatement has to be revisited.
    assert.equal(harnessExecutionLifecycle(CLAUDE_LEGACY_HARNESS_ID), "version_one_supervisor");
    assert.deepEqual(
      ADMITTED_GENERATION_HARNESS_IDS.filter(
        (harnessId) => harnessExecutionLifecycle(harnessId) === "version_one_supervisor"
      ),
      [CLAUDE_LEGACY_HARNESS_ID],
    );
  });
});

describe("Task 7 hybrid — one host observation per Claude spawn", () => {
  it("consumes the route acceptance's own readiness receipt instead of observing again", async () => {
    const { runtime } = setup();
    let assertReadyCalls = 0;
    runtime.jobs.assertReady = () => {
      assertReadyCalls += 1;
      return readinessReceipt(runtime);
    };
    let inspectCalls = 0;
    const seamedInspect = runtime.jobs.inspectRouteInstance;
    runtime.jobs.inspectRouteInstance = async (harnessId) => {
      inspectCalls += 1;
      return seamedInspect(harnessId);
    };

    await spawnClaude(runtime, { task_name: "one_observation" });

    // Exactly one host observation: route acceptance's. The version-one launch
    // receipt came from it, so no second CLI availability/version/auth probe ran.
    assert.equal(inspectCalls, 1);
    assert.equal(assertReadyCalls, 0);
  });

  it("still observes for itself when the route acceptance offered no receipt", async () => {
    const { runtime } = setup();
    let assertReadyCalls = 0;
    runtime.jobs.assertReady = () => {
      assertReadyCalls += 1;
      return readinessReceipt(runtime);
    };
    const seamedInspect = runtime.jobs.inspectRouteInstance;
    runtime.jobs.inspectRouteInstance = async (harnessId) => {
      const observed = await seamedInspect(harnessId);
      return { ...observed, launchReadiness: null };
    };

    await spawnClaude(runtime, { task_name: "fallback_observation" });

    // A Driver that states no launch receipt is not a Driver whose readiness
    // may be skipped.
    assert.equal(assertReadyCalls, 1);
  });
});

describe("Task 7 hybrid — credential recovery reaches a version-three Claude Agent", () => {
  function writeCredential(claudeConfigDir, expiresAt) {
    const temporary = path.join(claudeConfigDir, `.credentials.${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({
      claudeAiOauth: {
        accessToken: "test-token-never-projected",
        refreshToken: "test-refresh-never-projected",
        expiresAt,
        refreshTokenExpiresAt: expiresAt + 86_400_000,
      },
    }), { mode: 0o600 });
    fs.renameSync(temporary, path.join(claudeConfigDir, ".credentials.json"));
  }

  it("requeues a side-effect-free auth failure after the operator rotates the credential", async () => {
    const { runtime, workspace, claudeConfigDir } = setup();
    writeCredential(claudeConfigDir, Date.now() - 60_000);
    const credentialObservation = observeClaudeCredentialState({ env: runtime.jobs.env });

    const receipt = await spawnClaude(runtime, { task_name: "credential_v3" });
    const store = runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    assert.equal(agent.version, 3);
    const jobId = agent.activeJobId;
    const timestamp = new Date().toISOString();
    const job = readJobFile(workspace, jobId);
    // The version-one supervisor's own auth failure, written exactly as that
    // machine writes it: the instance is the raw configuration path, which is a
    // different namespace from the route's redacted key.
    writeJobFile(workspace, jobId, {
      ...job,
      status: "failed",
      phase: "failed",
      harnessInstanceKey: fs.realpathSync.native(claudeConfigDir),
      claudeConfigDir: fs.realpathSync.native(claudeConfigDir),
      // The turn crossed the durable Claude-child boundary before failing, so
      // this is an Agent-owned auth failure rather than a launcher fact.
      preClaudeLaunch: false,
      acceptingSteering: false,
      completedAt: timestamp,
      updatedAt: timestamp,
      recoverability: {
        resumable: false,
        mode: "blocked",
        exactSessionId: null,
        reason: "auth_or_permission",
      },
      result: {
        status: "failed",
        failureClass: "auth_or_permission",
        failureReason: "OAuth access token has expired",
        rawOutput: "OAuth access token has expired",
        partialOutput: "OAuth access token has expired",
        assistantOutputObserved: false,
        toolUses: [],
        touchedFiles: [],
        attempts: [{ assistantOutputObserved: false, toolUses: [], touchedFiles: [] }],
        runtimeReceipt: { credentialObservation },
      },
    });
    runtime.reconcile();
    const blocked = store.resolveTarget(agent.agentId);
    assert.equal(blocked.continuation.mode, "blocked");

    // The operator rotates the credential; the same Agent may retry.
    writeCredential(claudeConfigDir, Date.now() + 3_600_000);
    let launchedPrompt = null;
    runtime.jobs.launchPreparedStart = async (prepared, prompt) => {
      launchedPrompt = prompt;
      return { jobId: prepared.jobId, agentId: prepared.agentId, status: "queued" };
    };

    const followed = await runtime.followupTask({
      target: agent.agentId,
      message: "credentials were refreshed; retry the same task",
    });

    assert.deepEqual(followed, { agent_name: agent.path, delivery: "new_turn" });
    assert.equal(
      launchedPrompt,
      "the first Claude turn\n\ncredentials were refreshed; retry the same task",
    );
    const recovered = store.resolveTarget(agent.agentId);
    assert.equal(recovered.version, 3);
    assert.equal(recovered.status, "running");
    assert.notEqual(recovered.activeJobId, jobId);
    // The historical auth failure is untouched evidence.
    assert.equal(readJobFile(workspace, jobId).result.failureClass, "auth_or_permission");
  });
});
