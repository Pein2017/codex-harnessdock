import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAgentStore } from "../../runtime/agent-store.mjs";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
} from "../../runtime/claude-code-driver.mjs";

const HARNESS = {
  harnessId: CLAUDE_CODE_HARNESS_ID,
  driverVersion: CLAUDE_CODE_DRIVER_VERSION,
  capabilities: CLAUDE_CODE_CAPABILITIES,
};

const roots = [];
const originalRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;

afterEach(() => {
  if (originalRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = originalRuntimeHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup(ownerRootId = "codex-root-agent-test") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-store-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
  roots.push(root);
  return {
    root,
    workspace,
    claudeConfigDir,
    ownerRootId,
    store: createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS }),
  };
}

function terminalJob(agent, id, overrides = {}) {
  return {
    id,
    agentId: agent.agentId,
    ownerRootId: agent.rootThreadId,
    status: "completed",
    recoverability: {
      resumable: true,
      mode: "exact_session",
      exactSessionId: "claude-agent-session-1",
      reason: "completed_exact_session",
    },
    ...overrides,
  };
}

function findRegistryFile(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (entry.isFile() && entry.name === "registry.json") return candidate;
    }
  }
  throw new Error("Agent registry fixture was not created.");
}

const storeUrl = new URL("../../runtime/agent-store.mjs", import.meta.url).href;

function concurrentWriter(workspace, runtimeHome, claudeConfigDir, ownerRootId, target, start, count) {
  const source = [
    `import { createAgentStore } from ${JSON.stringify(storeUrl)};`,
    "const [workspace, config, root, target, start, count] = process.argv.slice(1);",
    "const store = createAgentStore({ cwd: workspace, ownerRootId: root, claudeConfigDir: config, harness: JSON.parse(process.env.CODEX_HARNESSDOCK_TEST_HARNESS) });",
    "for (let index = 0; index < Number(count); index += 1) store.enqueueMessage(target, `message-${Number(start) + index}`);",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, claudeConfigDir, ownerRootId, target, String(start), String(count)], {
      env: {
        ...process.env,
        CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
        CODEX_HARNESSDOCK_TEST_HARNESS: JSON.stringify(HARNESS),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  });
}

describe("Agent durable store", () => {
  it("validates list prefixes before an empty root can return", () => {
    const { store } = setup();
    assert.deepEqual(store.listAgents(), []);
    assert.deepEqual(store.listAgents({ pathPrefix: "/root" }), []);
    assert.deepEqual(store.listAgents({ pathPrefix: "/root/" }), []);
    for (const prefix of ["/root//alpha", "/root/../alpha", "/foreign/alpha"]) {
      assert.throws(() => store.listAgents({ pathPrefix: prefix }), /Agent path prefix/);
    }
  });

  it("atomically reserves normalized names within a logical root while isolating roots", () => {
    const { workspace, claudeConfigDir, store } = setup();
    const created = store.createAgent({ task_name: "Researcher", description: "bounded task" });
    assert.equal(created.path, "/root/Researcher");
    assert.equal(created.status, "pending_init");
    assert.equal(created.continuation.mode, "safe_fresh");
    assert.throws(() => store.createAgent({ task_name: " researcher " }), /already belongs/);

    const otherRoot = createAgentStore({
      cwd: workspace,
      ownerRootId: "codex-root-other",
      claudeConfigDir,
      harness: HARNESS,
    });
    const other = otherRoot.createAgent({ task_name: "researcher" });
    assert.notEqual(other.agentId, created.agentId);
    assert.equal(other.path, "/root/researcher");
    assert.deepEqual(store.listAgents().map((agent) => agent.agentId), [created.agentId]);
    assert.equal(store.listAllAgents().length, 2);
    assert.ok(store.listAllAgents().every((agent) => agent.rootHash && agent.claudeSessionId === undefined));
  });

  it("persists immutable delegation mode and normalizes legacy records to leaf", () => {
    const { workspace, ownerRootId, claudeConfigDir, store } = setup();
    const orchestrator = store.createAgent({
      task_name: "fable_orchestrator",
      selectedModel: "claude-fable-5",
      delegationMode: "claude_orchestrator",
    });
    assert.equal(orchestrator.delegationMode, "claude_orchestrator");
    assert.throws(
      () => store.updateAgent(orchestrator.agentId, (current) => ({
        ...current,
        delegationMode: "leaf",
      })),
      /immutable field delegationMode/,
    );

    const legacy = store.createAgent({ task_name: "legacy_leaf" });
    const registryFile = findRegistryFile(process.env.CODEX_HARNESSDOCK_RUNTIME_HOME);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    delete registry.agents[legacy.agentId].delegationMode;
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const restarted = createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS });
    assert.equal(restarted.resolveTarget(legacy.agentId).delegationMode, "leaf");
    restarted.updateAgent(legacy.agentId, (current) => ({ ...current, status: "completed" }));
    const normalized = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(normalized.agents[legacy.agentId].delegationMode, "leaf");
  });

  it("persists one immutable execution root and interprets workspace-only records without a read write", () => {
    const { root, workspace, ownerRootId, claudeConfigDir, store } = setup();
    const executionRoot = path.join(root, "execution");
    fs.mkdirSync(executionRoot);
    const targeted = store.createAgent({ task_name: "targeted", executionRoot });
    assert.equal(targeted.workspaceRoot, fs.realpathSync.native(workspace));
    assert.equal(targeted.executionRoot, fs.realpathSync.native(executionRoot));
    assert.throws(
      () => store.updateAgent(targeted.agentId, (agent) => ({ ...agent, executionRoot: agent.workspaceRoot })),
      /immutable field executionRoot/,
    );

    const legacy = store.createAgent({ task_name: "workspace_only" });
    const registryFile = findRegistryFile(process.env.CODEX_HARNESSDOCK_RUNTIME_HOME);
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    delete registry.agents[legacy.agentId].executionRoot;
    fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    const beforeRead = fs.readFileSync(registryFile, "utf8");
    const restarted = createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS });
    assert.equal(restarted.resolveTarget(legacy.agentId).executionRoot, fs.realpathSync.native(workspace));
    assert.equal(fs.readFileSync(registryFile, "utf8"), beforeRead);
    restarted.updateAgent(legacy.agentId, (agent) => ({ ...agent, status: "completed" }));
    const afterMutation = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assert.equal(afterMutation.agents[legacy.agentId].executionRoot, fs.realpathSync.native(workspace));
  });

  it("uses exact ID, path, or normalized-name targeting and reserves one active turn", () => {
    const { store } = setup();
    const alpha = store.createAgent({ task_name: "alpha" });
    const alpine = store.createAgent({ task_name: "alpine" });
    assert.equal(store.resolveTarget(alpha.agentId).agentId, alpha.agentId);
    assert.equal(store.resolveTarget(alpha.path).agentId, alpha.agentId);
    assert.equal(store.resolveTarget(" ALPHA ").agentId, alpha.agentId);
    assert.throws(() => store.resolveTarget("/root/al"), /No Agent with that exact/);
    assert.deepEqual(store.listAgents({ pathPrefix: "/root/al" }).map((agent) => agent.path), ["/root/alpha", "/root/alpine"]);
    assert.deepEqual(
      store.listAgents({ pathPrefix: "/root" }).map((agent) => agent.path),
      store.listAgents().map((agent) => agent.path),
    );
    assert.deepEqual(
      store.listAgents({ pathPrefix: "/root/" }).map((agent) => agent.path),
      store.listAgents().map((agent) => agent.path),
    );
    for (const prefix of ["/root//alpha", "/root/../alpha", "/foreign/alpha"]) {
      assert.throws(() => store.listAgents({ pathPrefix: prefix }), /Agent path prefix/);
    }

    const first = store.reserveActivation(alpha.path, "job-alpha-1", { initial: true });
    assert.equal(first.reserved, true);
    const second = store.reserveActivation(alpha.path, "job-alpha-2", { initial: true });
    assert.equal(second.reserved, false);
    assert.equal(second.reason, "already_active");
  });

  it("keeps Agent mailbox state durable through active delivery, idle queueing, and restart", () => {
    const { workspace, ownerRootId, claudeConfigDir, store } = setup();
    const agent = store.createAgent({ task_name: "mailbox" });
    store.reserveActivation(agent.path, "job-mailbox-1", { initial: true });
    const live = store.enqueueMessage(agent.path, "first message");
    assert.equal(live.delivery, "assigned_active");
    assert.equal(live.message.state, "assigned");
    const dispatched = store.markMessageDispatched(agent.path, live.message.messageId, { jobId: "job-mailbox-1" });
    assert.equal(dispatched.message.state, "dispatched");
    const acknowledged = store.acknowledgeMessage(agent.path, live.message.messageId, { jobId: "job-mailbox-1" });
    assert.equal(acknowledged.message.state, "acknowledged");

    const final = store.finalizeFromJob(terminalJob(agent, "job-mailbox-1"));
    assert.equal(final.agent.activeJobId, null);
    assert.equal(final.agent.status, "completed");
    const queued = store.enqueueMessage(agent.path, "later message");
    assert.equal(queued.delivery, "queued_no_turn");

    const afterRestart = createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS });
    assert.equal(afterRestart.listMessages(agent.path, { state: "queued" }).length, 1);
    const activation = afterRestart.reserveActivation(agent.path, "job-mailbox-2");
    assert.equal(activation.reserved, true);
    assert.equal(activation.assignedMessages.length, 1);
    assert.equal(afterRestart.listMessages(agent.path, { state: "assigned" })[0].assignedJobId, "job-mailbox-2");
  });

  it("owns the spawn prompt as mailbox sequence one and preserves raced messages during rollback", () => {
    const { store } = setup();
    const disposable = store.createAgent({
      task_name: "initial_disposable",
      initialMessage: "perform the first task",
    });
    const disposableMessages = store.listMessages(disposable.agentId);
    assert.equal(disposableMessages.length, 1);
    assert.equal(disposableMessages[0].sequence, 1);
    assert.equal(disposableMessages[0].kind, "spawn_agent");
    assert.equal(disposableMessages[0].text, "perform the first task");
    assert.equal(disposableMessages[0].state, "queued");
    assert.equal(store.rollbackReservation(disposable.agentId, {
      removableMessageId: disposableMessages[0].messageId,
    }).rolledBack, true);
    assert.equal(store.readAgent(disposable.agentId), null);

    const retained = store.createAgent({
      task_name: "initial_race",
      initialMessage: "perform the original task",
    });
    const initial = store.listMessages(retained.agentId)[0];
    store.enqueueMessage(retained.agentId, "raced sender message", { kind: "send_message" });
    const rollback = store.rollbackReservation(retained.agentId, {
      removableMessageId: initial.messageId,
    });
    assert.equal(rollback.rolledBack, false);
    assert.equal(rollback.reason, "queued_messages_present");
    const preserved = store.listMessages(retained.agentId);
    assert.deepEqual(preserved.map((message) => message.sequence), [1, 2]);
    assert.deepEqual(preserved.map((message) => message.text), [
      "perform the original task",
      "raced sender message",
    ]);
    const activation = store.reserveActivation(retained.agentId, "job-initial-race", { initial: true });
    assert.deepEqual(activation.assignedMessages.map((message) => message.sequence), [1, 2]);
    assert.ok(activation.assignedMessages.every((message) => message.deliveryIntent === "initial_prompt"));
  });

  it("serializes concurrent mailbox enqueue without missing or duplicate messages", async () => {
    const { workspace, claudeConfigDir, ownerRootId, store } = setup();
    const agent = store.createAgent({ task_name: "concurrent" });
    const writers = 4;
    const perWriter = 8;
    await Promise.all(Array.from({ length: writers }, (_, index) => concurrentWriter(
      workspace,
      process.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
      claudeConfigDir,
      ownerRootId,
      agent.path,
      index * perWriter,
      perWriter
    )));
    const messages = store.listMessages(agent.path);
    assert.equal(messages.length, writers * perWriter);
    assert.deepEqual(messages.map((message) => message.sequence), Array.from({ length: writers * perWriter }, (_, index) => index + 1));
    assert.equal(new Set(messages.map((message) => message.messageId)).size, writers * perWriter);
    assert.ok(messages.every((message) => message.state === "queued"));
  });

  it("binds plugin-created Claude sessions once and rejects a different root", () => {
    const { root, workspace, claudeConfigDir, store } = setup();
    const agent = store.createAgent({ task_name: "session-owner" });
    store.reserveActivation(agent.path, "job-session-1", { initial: true });
    const bound = store.bindSession(agent.path, "claude-shared-session", { jobId: "job-session-1" });
    assert.equal(bound.agent.claudeSessionId, "claude-shared-session");
    assert.equal(
      store.readSessionBinding({
        harnessId: CLAUDE_CODE_HARNESS_ID,
        instanceKey: claudeConfigDir,
        nativeSessionId: "claude-shared-session",
      }).agentId,
      agent.agentId,
    );

    const otherWorkspace = path.join(root, "other-workspace");
    fs.mkdirSync(otherWorkspace);
    const other = createAgentStore({ cwd: otherWorkspace, ownerRootId: "codex-root-session-other", claudeConfigDir, harness: HARNESS });
    const foreignAgent = other.createAgent({ task_name: "foreign" });
    other.reserveActivation(foreignAgent.path, "job-session-foreign", { initial: true });
    assert.throws(
      () => other.bindSession(foreignAgent.path, "claude-shared-session", { jobId: "job-session-foreign" }),
      /already bound to a different logical root or Agent/
    );
    const conflicted = other.finalizeFromJob(terminalJob(foreignAgent, "job-session-foreign", {
      recoverability: {
        resumable: true,
        mode: "exact_session",
        exactSessionId: "claude-shared-session",
        reason: "completed_exact_session",
      },
    }));
    assert.equal(conflicted.agent.status, "errored");
    assert.equal(conflicted.agent.continuation.mode, "blocked");
    assert.equal(conflicted.agent.continuation.evidence.reason, "session_binding_conflict");
  });

  it("maps terminal job evidence, preserves the prior session on drift, and reconciles restart state", () => {
    const { workspace, ownerRootId, claudeConfigDir, store } = setup();
    const agent = store.createAgent({ task_name: "lifecycle" });
    store.reserveActivation(agent.path, "job-life-1", { initial: true });
    store.bindSession(agent.path, "claude-agent-session-1", { jobId: "job-life-1" });
    const done = store.finalizeFromJob(terminalJob(agent, "job-life-1"));
    assert.equal(done.reconciled, true);
    assert.equal(done.agent.status, "completed");
    assert.equal(done.agent.continuation.mode, "exact_session");
    assert.equal(done.agent.activeJobId, null);
    assert.equal(done.agent.latestJobId, "job-life-1");

    store.reserveActivation(agent.path, "job-life-2");
    const drift = store.finalizeFromJob(terminalJob(agent, "job-life-2", {
      recoverability: {
        resumable: true,
        mode: "exact_session",
        exactSessionId: "claude-unexpected-session",
        reason: "completed_exact_session",
      },
    }));
    assert.equal(drift.agent.status, "errored");
    assert.equal(drift.agent.continuation.mode, "blocked");
    assert.equal(drift.agent.claudeSessionId, "claude-agent-session-1");

    const restarted = createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS });
    const reconciled = restarted.reconcileFromJobs([terminalJob(agent, "job-life-2", {
      recoverability: { resumable: false, mode: "blocked", reason: "fatal" },
      status: "failed",
    })]);
    assert.equal(reconciled[0].reason, "already_finalized");
    assert.equal(restarted.readAgent(agent.path).latestJobId, "job-life-2");
  });

  it("projects each terminal job once without allowing an older receipt to regress the Agent", () => {
    const { store } = setup();
    const agent = store.createAgent({ task_name: "monotonic" });
    const firstJob = terminalJob(agent, "job-monotonic-1");
    store.reserveActivation(agent.path, firstJob.id, { initial: true });
    store.finalizeFromJob(firstJob);

    const secondJob = terminalJob(agent, "job-monotonic-2");
    store.reserveActivation(agent.path, secondJob.id);
    const second = store.finalizeFromJob(secondJob);
    assert.equal(second.agent.latestJobId, secondJob.id);
    assert.equal(second.agent.latestCompletionSequence, 2);

    const replay = store.reconcileFromJobs([firstJob, secondJob]);
    assert.deepEqual(replay.map((receipt) => receipt.reason), ["already_finalized", "already_finalized"]);
    const afterReplay = store.readAgent(agent.path);
    assert.equal(afterReplay.latestJobId, secondJob.id);
    assert.equal(afterReplay.latestCompletionSequence, 2);
  });

  it("recovers only old pre-Claude mailbox ownership after an Agent has advanced", () => {
    const { store } = setup();
    const agent = store.createAgent({
      task_name: "pre_claude_monotonic",
      initialMessage: "first durable prompt",
    });
    const first = store.reserveActivation(agent.agentId, "job-pre-claude-old", { initial: true });
    store.markMessageDispatched(agent.agentId, first.assignedMessages[0].messageId, {
      jobId: "job-pre-claude-old",
      receipt: { delivery: "initial_prompt" },
    });
    store.updateAgent(agent.agentId, (current) => ({
      ...current,
      activeJobId: "job-newer-turn",
      latestJobId: "job-newer-turn",
      status: "running",
      continuation: {
        mode: "exact_session",
        evidence: { reason: "newer_turn", sessionId: "claude-newer-session" },
      },
    }));

    const recovered = store.recoverPreClaudeActivation(agent.agentId, "job-pre-claude-old");
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.reason, "stale_messages_requeued");
    assert.equal(recovered.agent.activeJobId, "job-newer-turn");
    assert.equal(recovered.agent.latestJobId, "job-newer-turn");
    assert.equal(recovered.agent.status, "running");
    assert.equal(recovered.agent.continuation.evidence.reason, "newer_turn");
    const message = store.listMessages(agent.agentId)[0];
    assert.equal(message.state, "queued");
    assert.equal(message.assignedJobId, null);
    assert.equal("receipt" in message, false);

    const repeated = store.recoverPreClaudeActivation(agent.agentId, "job-pre-claude-old");
    assert.equal(repeated.reason, "agent_already_advanced");
    assert.deepEqual(store.listMessages(agent.agentId), [message]);
  });
});
