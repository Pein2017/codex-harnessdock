import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import {
  appendCompletionEvent,
  resolveCompletionInboxFile,
} from "../../runtime/completion-inbox.mjs";
import { readJobFile, writeJobFile } from "../../runtime/job-store.mjs";

const roots = [];
const sharedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-completion-runtime-"));
const sharedCodexHome = path.join(sharedRuntimeRoot, ".codex");
const sharedRuntimeHome = path.join(sharedRuntimeRoot, "runtime-home");
fs.mkdirSync(sharedCodexHome);

after(() => fs.rmSync(sharedRuntimeRoot, { recursive: true, force: true }));

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup(ownerRootId = "root-agent-completion-projection") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-completion-projection-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, ".claude");
  const codexHome = sharedCodexHome;
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  roots.push(root);
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: ownerRootId,
      CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
      CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
      CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: "",
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { runtime, workspace, ownerRootId, envFile, claudeConfigDir, codexHome };
}

function completion(jobId, agentId = null) {
  return {
    jobId,
    agentId,
    terminalStatus: "completed",
    completedAt: "2026-07-26T00:00:00.000Z",
    summary: "stored internal summary",
    finalMessage: "stored Claude final output for parent synthesis",
    resumability: { classification: "resumable", claudeSessionId: `session-${jobId}` },
    detailedResultAvailable: true,
    resultPointer: jobId,
  };
}

const TEST_METRICS = Object.freeze({
  version: 1,
  provider_reported: {
    duration_ms: 7,
    duration_api_ms: null,
    turn_count: 1,
    input_tokens: 2,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reported_cost_usd: 0.001,
  },
  plugin_observed: { tool_call_count: 0, attempt_count: 1, recovery_attempt_count: 0 },
});

function attachJob(context, agent, jobId, status = "completed") {
  context.runtime.store.updateAgent(agent.agentId, (current) => ({
    ...current,
    status: status === "running" ? "running" : "completed",
    activeJobId: jobId,
    latestJobId: jobId,
  }));
  writeJobFile(context.workspace, jobId, {
    id: jobId,
    ownerRootId: context.ownerRootId,
    agentId: agent.agentId,
    workspaceRoot: context.workspace,
    status,
    agentProjectionReconciledAt: "2026-07-26T00:00:00.000Z",
    ...(status === "completed" ? {
      completedAt: "2026-07-26T00:00:00.000Z",
      result: { rawOutput: `result-${jobId}` },
      recoverability: { resumable: false, reason: "test_terminal" },
    } : {}),
  });
}

describe("Agent completion projection", () => {
  it("projects hard reclaim through public wait without model result or continuation", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "hard_reclaimed_wait" });
    runtime.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "errored",
      continuation: {
        mode: "blocked",
        evidence: { reason: "worker_lost", jobId: "hard-reclaimed-wait-job", observedAt: "2026-08-31T00:00:00.000Z" },
      },
    }));
    const message = "Agent worker resources were reclaimed while native settlement remains unknown.";
    appendCompletionEvent(workspace, ownerRootId, {
      jobId: "hard-reclaimed-wait-job",
      agentId: agent.agentId,
      terminalStatus: "hard_reclaimed",
      completedAt: "2026-08-31T00:00:00.000Z",
      summary: message,
      settlement: "unknown",
      resumability: { classification: "not_resumable", blockingReason: "worker_lost" },
      blocking: { reason: "worker_lost", scope: "agent", retry: "new_agent" },
      detailedResultAvailable: false,
      resultPointer: null,
      finalMessage: message,
      claudeSessionIdAvailable: false,
      metrics: null,
    });

    const waited = await runtime.waitAgent({ timeout_ms: 0 });
    assert.deepEqual({
      kind: waited.update.kind,
      agentStatus: waited.update.agent_status,
      settlement: waited.update.settlement,
      completionMessage: waited.update.completion_message,
      blocking: waited.update.blocking,
      metrics: waited.update.metrics,
    }, {
      kind: "completion",
      agentStatus: "failed",
      settlement: "unknown",
      completionMessage: message,
      blocking: { reason: "worker_lost", scope: "agent", retry: "new_agent" },
      metrics: null,
    });
    for (const forbidden of [
      "continuation", "result", "result_pointer", "detailed_result", "assistant_output", "model_output",
      "acceptance", "success", "failure",
    ]) {
      assert.equal(Object.hasOwn(waited.update, forbidden), false, forbidden);
    }
  });

  it("joins a fixed target barrier in caller order without consuming unrelated older completion", async () => {
    const context = setup();
    const first = context.runtime.store.createAgent({ task_name: "target_first" });
    const second = context.runtime.store.createAgent({ task_name: "target_second" });
    attachJob(context, first, "target-job-first");
    attachJob(context, second, "target-job-second");
    const unrelated = appendCompletionEvent(context.workspace, context.ownerRootId, completion("unrelated", "unrelated-agent")).event;
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("target-job-first", first.agentId));
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("target-job-second", second.agentId));
    const receipt = await context.runtime.waitAgent({
      targets: [second.path, first.path],
      timeout_ms: 0,
    });
    assert.equal(receipt.timedOut, false);
    assert.deepEqual(receipt.targets.map((target) => target.agent_name), [second.path, first.path]);
    assert.deepEqual(receipt.targets.map((target) => target.state), ["settled", "settled"]);
    assert.deepEqual(receipt.targets.map((target) => target.completion_message), [
      "result-target-job-second",
      "result-target-job-first",
    ]);
    assert.equal(JSON.stringify(receipt).includes("unrelated"), false);
    const unrelatedUnread = await context.runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(unrelatedUnread.update.delivery_token, unrelated.deliveryToken);
  });

  it("returns status-only timeout and delivers no partial barrier payload", async () => {
    const context = setup();
    const done = context.runtime.store.createAgent({ task_name: "barrier_done" });
    const pending = context.runtime.store.createAgent({ task_name: "barrier_pending" });
    attachJob(context, done, "barrier-job-done");
    attachJob(context, pending, "barrier-job-pending", "running");
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("barrier-job-done", done.agentId));
    const timedOut = await context.runtime.waitAgent({
      targets: [done.path, pending.path],
      timeout_ms: 0,
    });
    assert.equal(timedOut.timedOut, true);
    assert.deepEqual(timedOut.unresolved_targets, [pending.path]);
    assert.equal("delivery_token" in timedOut.targets[0], false);
    assert.equal("completion_message" in timedOut.targets[0], false);
  });

  it("reports already-consumed target turns without reconstructing payload", async () => {
    const context = setup();
    const agent = context.runtime.store.createAgent({ task_name: "already_consumed" });
    attachJob(context, agent, "consumed-job");
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("consumed-job", agent.agentId));
    const first = await context.runtime.waitAgent({ targets: [agent.path], timeout_ms: 0 });
    const second = await context.runtime.waitAgent({
      targets: [agent.path],
      timeout_ms: 0,
      acknowledge_tokens: [first.targets[0].delivery_token],
    });
    assert.equal(second.timedOut, false);
    assert.equal(second.targets[0].state, "already_consumed");
    assert.equal("completion_message" in second.targets[0], false);
    assert.equal("delivery_token" in second.targets[0], false);
  });

  it("returns a known Agent with no concrete turn as not_joinable", async () => {
    const context = setup();
    const agent = context.runtime.store.createAgent({ task_name: "not_joinable" });
    const receipt = await context.runtime.waitAgent({ targets: [agent.path], timeout_ms: 0 });
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.targets[0].state, "not_joinable");
    assert.deepEqual(receipt.unresolved_targets, [agent.path]);
  });

  it("acknowledges prior delivered tokens before returning not_joinable", async () => {
    const context = setup();
    const completed = context.runtime.store.createAgent({ task_name: "ack_before_not_joinable" });
    attachJob(context, completed, "ack-before-not-joinable");
    appendCompletionEvent(
      context.workspace,
      context.ownerRootId,
      completion("ack-before-not-joinable", completed.agentId),
    );
    const delivered = await context.runtime.waitAgent({
      targets: [completed.path],
      timeout_ms: 0,
    });
    const idle = context.runtime.store.createAgent({ task_name: "idle_not_joinable" });

    const receipt = await context.runtime.waitAgent({
      targets: [idle.path],
      timeout_ms: 0,
      acknowledge_tokens: [delivered.targets[0].delivery_token],
    });
    assert.equal(receipt.targets[0].state, "not_joinable");

    const consumed = await context.runtime.waitAgent({
      targets: [completed.path],
      timeout_ms: 0,
    });
    assert.equal(consumed.targets[0].state, "already_consumed");
  });

  it("keeps a snapshotted turn fixed when the same Agent starts a follow-up", async () => {
    const context = setup();
    const agent = context.runtime.store.createAgent({ task_name: "fixed_turn" });
    attachJob(context, agent, "fixed-old");
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("fixed-old", agent.agentId));
    const originalWait = context.runtime.jobs.wait.bind(context.runtime.jobs);
    context.runtime.jobs.wait = async (jobId, options) => {
      context.runtime.store.updateAgent(agent.agentId, (current) => ({
        ...current,
        status: "running",
        activeJobId: "fixed-followup",
        latestJobId: "fixed-followup",
      }));
      writeJobFile(context.workspace, "fixed-followup", {
        id: "fixed-followup",
        ownerRootId: context.ownerRootId,
        agentId: agent.agentId,
        workspaceRoot: context.workspace,
        status: "running",
      });
      return originalWait(jobId, options);
    };
    const receipt = await context.runtime.waitAgent({ targets: [agent.path], timeout_ms: 0 });
    assert.equal(receipt.targets[0].state, "settled");
    assert.equal(receipt.targets[0].completion_message, "result-fixed-old");
  });

  it("aborts a live barrier without freezing or acknowledging its completed subset", async () => {
    const context = setup();
    const done = context.runtime.store.createAgent({ task_name: "abort_done" });
    const pending = context.runtime.store.createAgent({ task_name: "abort_pending" });
    attachJob(context, done, "abort-done");
    attachJob(context, pending, "abort-pending", "running");
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("abort-done", done.agentId));
    const controller = new AbortController();
    context.runtime.abortSignal = controller.signal;
    const waiting = context.runtime.waitAgent({
      targets: [done.path, pending.path],
      timeout_ms: 2_000,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
      waiting,
      (error) => error?.name === "AbortError"
    );
    const inbox = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(context.workspace, context.ownerRootId), "utf8"));
    const stored = inbox.events.find((event) => event.jobId === "abort-done");
    assert.equal(stored.firstDeliveredAt ?? null, null);
    assert.equal(stored.acknowledgedAt ?? null, null);
  });

  it("uses the final observation when completion lands after the bounded result", async () => {
    const context = setup();
    const agent = context.runtime.store.createAgent({ task_name: "final_observation_target" });
    attachJob(context, agent, "final-observation-target", "running");
    const originalWait = context.runtime.jobs.wait.bind(context.runtime.jobs);
    let calls = 0;
    context.runtime.jobs.wait = async (jobId, options) => {
      calls += 1;
      if (calls === 1) {
        attachJob(context, agent, "final-observation-target");
        appendCompletionEvent(
          context.workspace,
          context.ownerRootId,
          completion("final-observation-target", agent.agentId),
        );
        return {
          update: null,
          targetReady: false,
          acknowledgement: { acknowledgedCount: 0, acknowledgedThrough: null, compactedCount: 0 },
          waitTimedOut: true,
          message: "Timed out waiting for HarnessDock Agent activity.",
        };
      }
      return originalWait(jobId, options);
    };

    const receipt = await context.runtime.waitAgent({
      targets: [agent.path],
      timeout_ms: 0,
    });
    assert.equal(calls, 2);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.targets[0].completion_message, "result-final-observation-target");
  });

  it("redelivers a fixed target turn after an AgentRuntime restart", async () => {
    const context = setup();
    const agent = context.runtime.store.createAgent({ task_name: "target_restart" });
    attachJob(context, agent, "target-restart");
    const storedJob = readJobFile(context.workspace, "target-restart");
    writeJobFile(context.workspace, "target-restart", {
      ...storedJob,
      result: { ...storedJob.result, metrics: TEST_METRICS },
    });
    appendCompletionEvent(context.workspace, context.ownerRootId, {
      ...completion("target-restart", agent.agentId),
      metrics: TEST_METRICS,
    });
    const first = await context.runtime.waitAgent({ targets: [agent.path], timeout_ms: 0 });

    const restarted = createAgentRuntime({
      cwd: context.workspace,
      envFile: context.envFile,
      env: {
        CODEX_HOME: context.codexHome,
        CODEX_THREAD_ID: context.ownerRootId,
        CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
        CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: "",
        CLAUDE_CONFIG_DIR: context.claudeConfigDir,
      },
    });
    const redelivered = await restarted.waitAgent({ targets: [agent.path], timeout_ms: 0 });
    assert.equal(redelivered.targets[0].delivery_token, first.targets[0].delivery_token);
    assert.equal(redelivered.targets[0].completion_message, first.targets[0].completion_message);
    assert.deepEqual(first.targets[0].metrics, TEST_METRICS);
    assert.deepEqual(redelivered.targets[0].metrics, TEST_METRICS);
  });

  it("rejects a target owned by another Codex root", async () => {
    const local = setup("root-target-local");
    const foreign = setup("root-target-foreign");
    const foreignAgent = foreign.runtime.store.createAgent({ task_name: "foreign_target" });
    await assert.rejects(
      local.runtime.waitAgent({ targets: [foreignAgent.agentId], timeout_ms: 0 }),
      /not found|current Codex root|in this root/i,
    );
  });

  it("does not freeze a partial subset when a terminal target has no completion evidence", async () => {
    const context = setup();
    const present = context.runtime.store.createAgent({ task_name: "evidence_present" });
    const missing = context.runtime.store.createAgent({ task_name: "evidence_missing" });
    attachJob(context, present, "evidence-present");
    attachJob(context, missing, "evidence-missing");
    appendCompletionEvent(context.workspace, context.ownerRootId, completion("evidence-present", present.agentId));
    const reconcile = context.runtime.reconcile.bind(context.runtime);
    context.runtime.reconcile = () => {
      const result = reconcile();
      const inboxFile = resolveCompletionInboxFile(context.workspace, context.ownerRootId);
      const inbox = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
      inbox.events = inbox.events.filter((event) => event.jobId !== "evidence-missing");
      fs.writeFileSync(inboxFile, `${JSON.stringify(inbox, null, 2)}\n`);
      return result;
    };
    const receipt = await context.runtime.waitAgent({
      targets: [present.path, missing.path],
      timeout_ms: 0,
    });
    assert.equal(receipt.timedOut, false);
    assert.deepEqual(receipt.unresolved_targets, [missing.path]);
    assert.equal(receipt.targets[0].state, "settled");
    assert.equal("delivery_token" in receipt.targets[0], false);
    assert.equal(receipt.targets[1].state, "not_joinable");
    const inbox = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(context.workspace, context.ownerRootId), "utf8"));
    assert.equal(inbox.events[0].firstDeliveredAt ?? null, null);
  });

  it("returns one redeliverable Agent update with the complete final message", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "projection" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    appendCompletionEvent(workspace, ownerRootId, completion("legacy-one-shot"));
    const linked = appendCompletionEvent(workspace, ownerRootId, completion("agent-one", agent.agentId)).event;

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.deepEqual(first, {
      message: "HarnessDock Agent completion is available.",
      timedOut: false,
      update: {
        kind: "completion",
        agent_name: agent.path,
        agent_status: "completed",
        summary: "Agent turn completed.",
        completion_message: "stored Claude final output for parent synthesis",
        completion_message_truncated: false,
        delivery_token: linked.deliveryToken,
        blocking: null,
        metrics: null,
      },
    });
    assert.equal(JSON.stringify(first).includes("stored Claude final output"), true);
    assert.equal(JSON.stringify(first).includes("resultPointer"), false);

    const correction = appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-one", agent.agentId),
      terminalStatus: "failed",
      finalMessage: "a later correction must not rewrite an exposed token",
      resumability: { classification: "not_resumable", blockingReason: "late correction" },
    }, { reconcileExisting: true });
    assert.equal(correction.corrected, false);
    assert.equal(correction.reason, "delivered_event_immutable");

    const listBeforeAcknowledgement = runtime.listAgents();
    assert.deepEqual(listBeforeAcknowledgement, {
      agents: [{
        agent_name: agent.path,
        agent_status: "completed",
        harness: "claude-code",
        route_maturity: null,
        model: null,
        reasoning_effort: null,
        authority: "unknown",
        delegation_mode: "leaf",
        phase: null,
        started_at: null,
        last_activity_at: null,
        elapsed_seconds: null,
      }],
    });
    const unrelated = runtime.store.createAgent({ task_name: "unrelated" });
    assert.deepEqual(runtime.listAgents({ path_prefix: "/root/proj" }), {
      agents: [{
        agent_name: agent.path,
        agent_status: "completed",
        harness: "claude-code",
        route_maturity: null,
        model: null,
        reasoning_effort: null,
        authority: "unknown",
        delegation_mode: "leaf",
        phase: null,
        started_at: null,
        last_activity_at: null,
        elapsed_seconds: null,
      }],
    });
    assert.deepEqual(runtime.listAgents({ path_prefix: "/root" }), runtime.listAgents());
    assert.deepEqual(runtime.listAgents({ path_prefix: "/root/" }), runtime.listAgents());
    for (const prefix of ["/root//proj", "/root/../proj", "/foreign/proj"]) {
      assert.throws(() => runtime.listAgents({ path_prefix: prefix }), /Agent path prefix/);
    }
    assert.deepEqual(runtime.listAgents().agents, [
      {
        agent_name: agent.path,
        agent_status: "completed",
        harness: "claude-code",
        route_maturity: null,
        model: null,
        reasoning_effort: null,
        authority: "unknown",
        delegation_mode: "leaf",
        phase: null,
        started_at: null,
        last_activity_at: null,
        elapsed_seconds: null,
      },
      {
        agent_name: unrelated.path,
        agent_status: "starting",
        harness: "claude-code",
        route_maturity: null,
        model: null,
        reasoning_effort: null,
        authority: "unknown",
        delegation_mode: "leaf",
        phase: null,
        started_at: null,
        last_activity_at: null,
        elapsed_seconds: null,
      },
    ]);

    runtime.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "running",
      activeJobId: "agent-follow-up",
      latestJobId: "agent-follow-up",
    }));

    const redelivered = await runtime.waitAgent({ timeout_ms: 0 });
    assert.deepEqual(redelivered, first);

    const afterAcknowledgement = await runtime.waitAgent({
      timeout_ms: 0,
      acknowledge_tokens: [first.update.delivery_token],
    });
    assert.deepEqual(afterAcknowledgement, {
      message: "Timed out waiting for HarnessDock Agent activity.",
      timedOut: true,
    });
  });

  it("preserves multilingual final output above the former 64 KiB bound", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "long_handoff" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    const longMessage = `${"界".repeat(24_000)}\n${"🙂".repeat(4_000)}\ncomplete-tail`;
    assert.ok(Buffer.byteLength(longMessage, "utf8") > 64 * 1024);
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-long", agent.agentId),
      finalMessage: longMessage,
    });

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.kind, "completion");
    assert.equal(first.update.completion_message_truncated, false);
    assert.equal(first.update.completion_message, longMessage);
    assert.deepEqual(await runtime.waitAgent({ timeout_ms: 0 }), first);
  });

  it("preserves legacy truncation provenance without claiming discarded bytes", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "legacy_truncated" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    appendCompletionEvent(workspace, ownerRootId, completion("agent-legacy", agent.agentId));

    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const inbox = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    inbox.events[0].finalMessage = "legacy stored prefix";
    inbox.events[0].truncated = true;
    fs.writeFileSync(inboxFile, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.completion_message, "legacy stored prefix");
    assert.equal(first.update.completion_message_truncated, true);
    assert.deepEqual(await runtime.waitAgent({ timeout_ms: 0 }), first);
  });

  it("reports the closed blocking triple for a failed turn with no outer-assistant text", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "failed_no_text" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "errored" }));
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-failed-no-text", agent.agentId),
      terminalStatus: "failed",
      finalMessage: "",
      resumability: { classification: "not_resumable", blockingReason: "auth_or_permission" },
      blocking: { reason: "auth_required", scope: "harness", retry: "operator_required" },
    });

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.agent_status, "failed");
    assert.equal(first.update.summary, "Agent turn failed.");
    // Today's `completion_message` resolution is unchanged by this projection:
    // it stays empty rather than being backfilled from `blocking`.
    assert.equal(first.update.completion_message, "");
    assert.deepEqual(first.update.blocking, { reason: "auth_required", scope: "harness", retry: "operator_required" });
  });

  it("reports blocking: null for a completed turn regardless of its final message content", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "completed_with_question" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-completed-question", agent.agentId),
      finalMessage: "Which environment should I deploy to? This looks blocked on your quota.",
    });

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.agent_status, "completed");
    assert.equal(first.update.blocking, null);
  });

  it("reports blocking: null for a gracefully interrupted turn whose receipt proves a safe flush", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "graceful_interrupt" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "interrupted" }));
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-graceful-interrupt", agent.agentId),
      terminalStatus: "interrupted",
      finalMessage: "partial progress before the parent's own interrupt",
      resumability: { classification: "resumable", claudeSessionId: "session-graceful-interrupt" },
      blocking: null,
    });

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.agent_status, "interrupted");
    assert.equal(first.update.blocking, null);
  });

  it("reports interrupted_unflushed for an interrupted turn without a receipt proving a safe flush", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "unflushed_interrupt" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "interrupted" }));
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-unflushed-interrupt", agent.agentId),
      terminalStatus: "interrupted",
      finalMessage: "",
      resumability: { classification: "not_resumable", blockingReason: "interrupted_without_exact_session" },
      blocking: { reason: "interrupted_unflushed", scope: "agent", retry: "new_agent" },
    });

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.agent_status, "interrupted");
    assert.deepEqual(first.update.blocking, { reason: "interrupted_unflushed", scope: "agent", retry: "new_agent" });
  });

  it("redelivers blocking: null for a payload frozen before this change, without recomputing", async () => {
    const { runtime, workspace, ownerRootId } = setup();
    const agent = runtime.store.createAgent({ task_name: "pre_change_frozen" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "errored" }));
    appendCompletionEvent(workspace, ownerRootId, {
      ...completion("agent-pre-change-frozen", agent.agentId),
      terminalStatus: "failed",
      finalMessage: "pre-change failed handoff",
    });

    // Simulate a stored event from before this change: no `blocking` key at
    // all, exactly as `runtime/completion-inbox.mjs:463-482` projected before.
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const inbox = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    delete inbox.events[0].blocking;
    fs.writeFileSync(inboxFile, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");

    const first = await runtime.waitAgent({ timeout_ms: 0 });
    assert.equal(first.update.agent_status, "failed");
    assert.equal(first.update.blocking, null);

    // First delivery has now frozen the payload. Even though recomputing from
    // the terminal fact would yield a non-null triple (a "failed" status
    // always would), the frozen `null` is redelivered unchanged.
    const redelivered = await runtime.waitAgent({ timeout_ms: 0 });
    assert.deepEqual(redelivered, first);
    const storedAfterDelivery = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    assert.equal("blocking" in storedAfterDelivery.events[0], false);
  });
});
