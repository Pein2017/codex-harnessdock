import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  COMPLETION_INBOX_VERSION,
  HARD_RECLAIM_LIFECYCLE_MESSAGE,
  acknowledgeAgentCompletionEvents,
  acknowledgeCompletionEvents,
  appendCompletionEvent,
  compactAcknowledgedCompletionEvents,
  deterministicCompletionEventId,
  readUnreadAgentCompletionSummaries,
  readUnreadCompletionEvents,
  reconcileTerminalJobCompletion,
  reconcileTerminalJobCompletions,
  resolveCompletionInboxFile,
} from "../../runtime/completion-inbox.mjs";

const roots = [];
const originalRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;

afterEach(() => {
  if (originalRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = originalRuntimeHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-completion-inbox-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
  roots.push(root);
  return { workspace, ownerRootId: "codex-root-test" };
}

function completion(jobId, overrides = {}) {
  return {
    jobId,
    terminalStatus: "completed",
    completedAt: "2026-07-25T00:00:00.000Z",
    summary: `Job ${jobId} completed`,
    resumability: { classification: "resumable", claudeSessionId: `session-${jobId}` },
    detailedResultAvailable: true,
    resultPointer: jobId,
    ...overrides,
  };
}

function observePersistenceIo(operation) {
  const originalFsyncSync = fs.fsyncSync;
  const originalLinkSync = fs.linkSync;
  const counts = { fsync: 0, lockLinks: 0 };
  fs.fsyncSync = (...args) => {
    counts.fsync += 1;
    return originalFsyncSync(...args);
  };
  fs.linkSync = (...args) => {
    counts.lockLinks += 1;
    return originalLinkSync(...args);
  };
  try {
    return { counts, result: operation() };
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.linkSync = originalLinkSync;
  }
}

const completionInboxUrl = new URL("../../runtime/completion-inbox.mjs", import.meta.url).href;

function runWriter(moduleUrl, workspace, ownerRootId, start, count, runtimeHome) {
  const source = [
    `import { appendCompletionEvent } from ${JSON.stringify(moduleUrl)};`,
    "const [workspace, ownerRootId, start, count] = process.argv.slice(1);",
    "for (let i = 0; i < Number(count); i += 1) {",
    "  const jobId = `concurrent-${Number(start) + i}`;",
    "  appendCompletionEvent(workspace, ownerRootId, {",
    "    jobId, terminalStatus: 'completed', completedAt: '2026-07-25T00:00:00.000Z',",
    "    summary: jobId, resumability: { classification: 'resumable', claudeSessionId: `session-${jobId}` },",
    "    detailedResultAvailable: true, resultPointer: jobId,",
    "  });",
    "}",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, ownerRootId, String(start), String(count)], {
      env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  });
}

function readFromFreshProcess(workspace, ownerRootId, runtimeHome) {
  const source = [
    `import { readUnreadCompletionEvents } from ${JSON.stringify(completionInboxUrl)};`,
    "const [workspace, ownerRootId] = process.argv.slice(1);",
    "process.stdout.write(JSON.stringify(readUnreadCompletionEvents(workspace, ownerRootId)));",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, ownerRootId], {
      env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `reader exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("completion inbox", () => {
  it("stores one nonsemantic hard-reclaim lifecycle event with explicit unknown settlement", () => {
    const { workspace, ownerRootId } = setup();
    const message = HARD_RECLAIM_LIFECYCLE_MESSAGE;
    const first = appendCompletionEvent(workspace, ownerRootId, {
      jobId: "hard-reclaimed-job",
      agentId: "hard-reclaimed-agent",
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
    const second = appendCompletionEvent(workspace, ownerRootId, {
      jobId: "hard-reclaimed-job",
      agentId: "hard-reclaimed-agent",
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

    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.deepEqual(second.event, first.event, "replay returns the exact same lifecycle event bytes");
    assert.deepEqual(first.event, {
      version: COMPLETION_INBOX_VERSION,
      sequence: 1,
      eventId: deterministicCompletionEventId(ownerRootId, "hard-reclaimed-job"),
      jobId: "hard-reclaimed-job",
      agentId: "hard-reclaimed-agent",
      agentStatus: "errored",
      terminalStatus: "hard_reclaimed",
      settlement: "unknown",
      completedAt: "2026-08-31T00:00:00.000Z",
      summary: message,
      resumability: { classification: "not_resumable", claudeSessionId: null, blockingReason: "worker_lost" },
      blocking: { reason: "worker_lost", scope: "agent", retry: "new_agent" },
      detailedResultAvailable: false,
      resultPointer: null,
      finalMessage: message,
      truncated: false,
      claudeSessionIdAvailable: false,
      metrics: null,
      deliveryToken: first.event.deliveryToken,
    });
    for (const forbidden of ["continuation", "result", "assistantOutput", "modelOutput", "acceptance", "success", "failure"]) {
      assert.equal(Object.hasOwn(first.event, forbidden), false, forbidden);
    }

    const publicSummary = readUnreadAgentCompletionSummaries(workspace, ownerRootId).events[0];
    assert.deepEqual({
      agentStatus: publicSummary.agentStatus,
      terminalStatus: publicSummary.terminalStatus,
      settlement: publicSummary.settlement,
      completionMessage: publicSummary.completionMessage,
      blocking: publicSummary.blocking,
      metrics: publicSummary.metrics,
    }, {
      agentStatus: "errored",
      terminalStatus: "hard_reclaimed",
      settlement: "unknown",
      completionMessage: message,
      blocking: { reason: "worker_lost", scope: "agent", retry: "new_agent" },
      metrics: null,
    });
    for (const forbidden of ["continuation", "result", "assistant_output", "model_output", "acceptance", "success", "failure"]) {
      assert.equal(Object.hasOwn(publicSummary, forbidden), false, forbidden);
    }
  });

  it("freezes normalized metrics and projects legacy completion metrics as null", () => {
    const { workspace, ownerRootId } = setup();
    const metrics = {
      version: 1,
      provider_reported: {
        duration_ms: 7,
        duration_api_ms: null,
        turn_count: 1,
        input_tokens: 2,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        reported_cost_usd: 0.001,
      },
      plugin_observed: { tool_call_count: 1, attempt_count: 1, recovery_attempt_count: 0 },
    };
    appendCompletionEvent(workspace, ownerRootId, completion("metrics", { agentId: "agent-metrics", metrics }));
    appendCompletionEvent(workspace, ownerRootId, completion("legacy-metrics", { agentId: "agent-legacy-metrics" }));
    const first = readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    assert.deepEqual(first.events.map((event) => event.metrics), [metrics]);
    const second = readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    assert.deepEqual(second.events.map((event) => event.metrics), [metrics]);
    assert.deepEqual(
      readUnreadCompletionEvents(workspace, ownerRootId).events.map((event) => event.metrics),
      [metrics, null],
    );
  });

  it("keeps identical reconciliation lock-free while serializing mutable corrections", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "immutable-reconciliation",
      agentId: "agent-immutable-reconciliation",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      completionSummary: "immutable reconciliation",
      result: { rawOutput: "immutable public handoff" },
      recoverability: {
        resumable: false,
        reason: "test_terminal",
      },
    };
    const initial = reconcileTerminalJobCompletion(workspace, ownerRootId, job).event;

    const unfrozenDuplicate = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, job)
    );
    assert.deepEqual(unfrozenDuplicate.counts, { fsync: 0, lockLinks: 0 });

    const correctedJob = {
      ...job,
      completionSummary: "corrected before delivery",
      result: { rawOutput: "corrected public handoff" },
    };
    const mutableCorrection = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, correctedJob)
    );
    assert.ok(mutableCorrection.counts.lockLinks > 0);
    assert.ok(mutableCorrection.counts.fsync > 0);
    assert.equal(mutableCorrection.result.reason, "corrected_unacknowledged_event");
    assert.equal(mutableCorrection.result.event.deliveryToken, initial.deliveryToken);

    readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    const frozenDuplicate = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, correctedJob)
    );
    assert.deepEqual(frozenDuplicate.counts, { fsync: 0, lockLinks: 0 });
    assert.equal(frozenDuplicate.result.event.deliveryToken, initial.deliveryToken);

    acknowledgeAgentCompletionEvents(workspace, ownerRootId, [initial.deliveryToken]);
    const acknowledgedOnlyJob = {
      ...job,
      id: "acknowledged-only-reconciliation",
      completionSummary: "acknowledged without first-delivery freezing",
    };
    const acknowledgedOnly = reconcileTerminalJobCompletion(
      workspace,
      ownerRootId,
      acknowledgedOnlyJob
    ).event;
    assert.throws(
      () => acknowledgeAgentCompletionEvents(workspace, ownerRootId, [acknowledgedOnly.deliveryToken]),
      /never-delivered token/
    );
    readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    acknowledgeAgentCompletionEvents(workspace, ownerRootId, [acknowledgedOnly.deliveryToken]);
    const acknowledgedDuplicate = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, acknowledgedOnlyJob)
    );
    assert.deepEqual(acknowledgedDuplicate.counts, { fsync: 0, lockLinks: 0 });
    assert.equal(acknowledgedDuplicate.result.event.deliveryToken, acknowledgedOnly.deliveryToken);

    assert.throws(
      () => appendCompletionEvent(workspace, ownerRootId, {
        ...completion(job.id, {
          agentId: "agent-identity-collision",
          finalMessage: "different Agent",
        }),
      }, { reconcileExisting: true }),
      /identity collision/
    );
  });

  it("derives blocking purely from the terminal job fact and corrects it once before freezing", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "blocking-correction",
      agentId: "agent-blocking-correction",
      status: "failed",
      completedAt: "2026-07-25T00:00:00.000Z",
      result: { failureClass: "transport_closed_resumable", rawOutput: "" },
      recoverability: { resumable: false, mode: "blocked", reason: "transport_closed_resumable" },
    };
    const initial = reconcileTerminalJobCompletion(workspace, ownerRootId, job).event;
    assert.deepEqual(initial.blocking, { reason: "transport_exhausted", scope: "agent", retry: "new_agent" });

    // The turn is later reclassified before first delivery: an unread,
    // unfrozen event still corrects in place under the existing lock-and-reread
    // rule, and `blocking` changes along with the rest of the fact.
    const reclassifiedJob = {
      ...job,
      result: { failureClass: "auth_or_permission", rawOutput: "" },
      recoverability: { resumable: false, mode: "blocked", reason: "auth_or_permission" },
    };
    const corrected = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, reclassifiedJob)
    );
    assert.ok(corrected.result.reconciled, "a genuine blocking-evidence change must be recognized as a correction");
    assert.deepEqual(corrected.result.event.blocking, { reason: "auth_required", scope: "harness", retry: "operator_required" });
    assert.equal(corrected.result.event.deliveryToken, initial.deliveryToken);

    // The identical fact converges in one step: a further reconcile of the
    // same reclassified job performs no additional write.
    const settled = observePersistenceIo(
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, reclassifiedJob)
    );
    assert.deepEqual(settled.counts, { fsync: 0, lockLinks: 0 });
  });

  it("never copies job.errorMessage into the model-facing summary or final message", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "no-summary-operator-prose",
      agentId: "agent-no-summary-operator-prose",
      status: "failed",
      completedAt: "2026-07-25T00:00:00.000Z",
      // No completionSummary, summary, finalMessage, result, or rendered text
      // at all: a malformed or legacy job whose only text is operator prose.
      errorMessage:
        "Control process 55555 died or changed identity without completing. Auto-reaped. " +
        "Resume manually with: claude --resume native-session-should-not-leak",
      recoverability: { resumable: false, mode: "blocked", reason: "worker_reaped" },
    };
    const { event } = reconcileTerminalJobCompletion(workspace, ownerRootId, job);
    assert.equal(event.summary.includes("55555"), false);
    assert.equal(event.summary.includes("Control process"), false);
    assert.equal(event.summary.includes("claude --resume"), false);
    assert.equal(event.summary.includes("native-session-should-not-leak"), false);
    assert.equal(event.finalMessage.includes("55555"), false);
    assert.equal(event.finalMessage.includes("claude --resume"), false);
    assert.equal(event.finalMessage.includes("native-session-should-not-leak"), false);
    // With no prompt-derived text anywhere, the projection falls back to the
    // generic status/job-id text rather than any operator prose.
    assert.equal(event.summary, `failed job ${job.id}`);
    assert.equal(event.finalMessage, `failed job ${job.id}`);
  });

  it("performs no durable write across repeated observation of a settled failed Agent", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "settled-failed-agent",
      agentId: "agent-settled-failed",
      status: "failed",
      completedAt: "2026-07-25T00:00:00.000Z",
      result: { failureClass: "fatal", rawOutput: "" },
      recoverability: { resumable: false, mode: "blocked", reason: "fatal" },
    };
    const appended = reconcileTerminalJobCompletion(workspace, ownerRootId, job).event;
    assert.deepEqual(appended.blocking, { reason: "unclassified", scope: "agent", retry: "new_agent" });

    const firstDelivery = observePersistenceIo(
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId)
    );
    assert.equal(firstDelivery.result.events[0].blocking.reason, "unclassified");

    const settledObservations = observePersistenceIo(() => Array.from(
      { length: 10 },
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId)
    ));
    assert.deepEqual(settledObservations.counts, { fsync: 0, lockLinks: 0 });
    assert.ok(settledObservations.result.every(
      (receipt) => JSON.stringify(receipt) === JSON.stringify(firstDelivery.result)
    ));

    // Reconciling the same unchanged terminal job repeatedly is also write-free:
    // the derivation is pure, so it never disagrees with the frozen payload.
    const repeatedReconcile = observePersistenceIo(() => Array.from(
      { length: 10 },
      () => reconcileTerminalJobCompletion(workspace, ownerRootId, job)
    ));
    assert.deepEqual(repeatedReconcile.counts, { fsync: 0, lockLinks: 0 });
  });

  it("does not overwrite a correction committed after an identical snapshot read", () => {
    const { workspace, ownerRootId } = setup();
    const factA = completion("snapshot-correction-race", {
      agentId: "agent-snapshot-correction-race",
      summary: "snapshot fact A",
      finalMessage: "public fact A",
    });
    const factB = {
      ...factA,
      summary: "corrected fact B",
      finalMessage: "public fact B",
    };
    const initial = appendCompletionEvent(workspace, ownerRootId, factA).event;
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const originalReadFileSync = fs.readFileSync;
    let correction = null;
    let injected = false;
    fs.readFileSync = (filePath, ...args) => {
      const snapshot = originalReadFileSync(filePath, ...args);
      if (!injected && path.resolve(String(filePath)) === inboxFile) {
        injected = true;
        correction = appendCompletionEvent(
          workspace,
          ownerRootId,
          factB,
          { reconcileExisting: true }
        );
      }
      return snapshot;
    };
    let staleReceipt;
    try {
      staleReceipt = appendCompletionEvent(
        workspace,
        ownerRootId,
        factA,
        { reconcileExisting: true }
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(injected, true);
    assert.equal(staleReceipt.event.summary, "snapshot fact A");
    assert.equal(correction?.corrected, true);
    assert.equal(correction?.event.sequence, initial.sequence);
    assert.equal(correction?.event.deliveryToken, initial.deliveryToken);

    const durable = readUnreadCompletionEvents(workspace, ownerRootId).events[0];
    assert.equal(durable.summary, "corrected fact B");
    assert.equal(durable.finalMessage, "public fact B");
    assert.equal(durable.sequence, initial.sequence);
    assert.equal(durable.deliveryToken, initial.deliveryToken);
    assert.deepEqual(readUnreadAgentCompletionSummaries(workspace, ownerRootId).events, [{
      kind: "completion",
      agentId: factA.agentId,
      agentStatus: "completed",
      terminalStatus: "completed",
      summary: "Agent turn completed.",
      completionMessage: "public fact B",
      completionMessageTruncated: false,
      deliveryToken: initial.deliveryToken,
      blocking: null,
      metrics: null,
    }]);
  });

  it("keeps quiet observation and frozen redelivery free of locks and fsync", () => {
    const { workspace, ownerRootId } = setup();
    const appended = appendCompletionEvent(workspace, ownerRootId, completion("agent-observation", {
      agentId: "agent-observation",
      finalMessage: "immutable public handoff",
    })).event;

    const firstDelivery = observePersistenceIo(
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId)
    );
    assert.ok(firstDelivery.counts.lockLinks > 0);
    assert.ok(firstDelivery.counts.fsync > 0);
    assert.equal(firstDelivery.result.events[0].deliveryToken, appended.deliveryToken);

    const frozenRedelivery = observePersistenceIo(() => Array.from(
      { length: 25 },
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId)
    ));
    assert.deepEqual(frozenRedelivery.counts, { fsync: 0, lockLinks: 0 });
    assert.ok(frozenRedelivery.result.every(
      (receipt) => JSON.stringify(receipt) === JSON.stringify(firstDelivery.result)
    ));

    const acknowledgement = observePersistenceIo(() => acknowledgeAgentCompletionEvents(
      workspace,
      ownerRootId,
      [appended.deliveryToken]
    ));
    assert.ok(acknowledgement.counts.lockLinks > 0);
    assert.ok(acknowledgement.counts.fsync > 0);

    const quietReads = observePersistenceIo(() => Array.from(
      { length: 25 },
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId)
    ));
    assert.deepEqual(quietReads.counts, { fsync: 0, lockLinks: 0 });
    assert.ok(quietReads.result.every((receipt) => receipt.events.length === 0));
  });

  it("locks a mixed frozen and unfrozen batch once, then redelivers it read-only", () => {
    const { workspace, ownerRootId } = setup();
    const first = appendCompletionEvent(workspace, ownerRootId, completion("mixed-first", {
      agentId: "agent-mixed-first",
      finalMessage: "first handoff",
    })).event;
    const second = appendCompletionEvent(workspace, ownerRootId, completion("mixed-second", {
      agentId: "agent-mixed-second",
      finalMessage: "second handoff",
    })).event;

    const frozenFirst = readUnreadAgentCompletionSummaries(
      workspace,
      ownerRootId,
      { limit: 1 },
    );
    assert.deepEqual(frozenFirst.events.map((event) => event.deliveryToken), [first.deliveryToken]);

    const mixed = observePersistenceIo(() => readUnreadAgentCompletionSummaries(
      workspace,
      ownerRootId,
      { limit: 2 },
    ));
    assert.ok(mixed.counts.lockLinks > 0);
    assert.ok(mixed.counts.fsync > 0);
    assert.deepEqual(
      mixed.result.events.map((event) => event.deliveryToken),
      [first.deliveryToken, second.deliveryToken],
    );

    const redelivery = observePersistenceIo(() => readUnreadAgentCompletionSummaries(
      workspace,
      ownerRootId,
      { limit: 2 },
    ));
    assert.deepEqual(redelivery.counts, { fsync: 0, lockLinks: 0 });
    assert.deepEqual(redelivery.result, mixed.result);
  });

  it("permits only an immutable at-least-once duplicate when acknowledgement races snapshot redelivery", () => {
    const { workspace, ownerRootId } = setup();
    const appended = appendCompletionEvent(workspace, ownerRootId, completion("racing-ack", {
      agentId: "agent-racing-ack",
      finalMessage: "frozen handoff",
    })).event;
    const frozen = readUnreadAgentCompletionSummaries(workspace, ownerRootId);

    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const originalReadFileSync = fs.readFileSync;
    let acknowledgementTriggered = false;
    fs.readFileSync = (...args) => {
      const snapshot = originalReadFileSync(...args);
      if (!acknowledgementTriggered && path.resolve(String(args[0])) === path.resolve(inboxFile)) {
        acknowledgementTriggered = true;
        acknowledgeAgentCompletionEvents(workspace, ownerRootId, [appended.deliveryToken]);
      }
      return snapshot;
    };
    let raced;
    try {
      raced = readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(acknowledgementTriggered, true);
    assert.deepEqual(raced, frozen);
    assert.deepEqual(readUnreadAgentCompletionSummaries(workspace, ownerRootId), { events: [] });
    const stored = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    assert.equal(stored.acknowledgedThrough, 1);
  });

  it("accepts an already-acknowledged prefix when partial acknowledgement races a frozen batch", () => {
    const { workspace, ownerRootId } = setup();
    const events = ["batch-first", "batch-second"].map((jobId) => appendCompletionEvent(
      workspace,
      ownerRootId,
      completion(jobId, { agentId: `agent-${jobId}`, finalMessage: jobId }),
    ).event);
    const frozen = readUnreadAgentCompletionSummaries(workspace, ownerRootId, { limit: 2 });
    assert.deepEqual(
      frozen.events.map((event) => event.deliveryToken),
      events.map((event) => event.deliveryToken),
    );

    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const originalReadFileSync = fs.readFileSync;
    let partialAckTriggered = false;
    fs.readFileSync = (...args) => {
      const snapshot = originalReadFileSync(...args);
      if (!partialAckTriggered && path.resolve(String(args[0])) === path.resolve(inboxFile)) {
        partialAckTriggered = true;
        acknowledgeAgentCompletionEvents(workspace, ownerRootId, [events[0].deliveryToken]);
      }
      return snapshot;
    };
    let raced;
    try {
      raced = readUnreadAgentCompletionSummaries(workspace, ownerRootId, { limit: 2 });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(partialAckTriggered, true);
    assert.deepEqual(raced, frozen);
    const acknowledged = acknowledgeAgentCompletionEvents(
      workspace,
      ownerRootId,
      raced.events.map((event) => event.deliveryToken),
    );
    assert.equal(acknowledged.acknowledgedThrough, 2);
    assert.equal(acknowledged.acknowledgedCount, 1);
    assert.deepEqual(readUnreadAgentCompletionSummaries(workspace, ownerRootId), { events: [] });
  });

  it("survives restart and redelivers an unacknowledged completion", async () => {
    const { workspace, ownerRootId } = setup();
    const first = appendCompletionEvent(workspace, ownerRootId, completion("job-1"));
    assert.equal(first.appended, true);
    assert.equal(first.event.eventId, deterministicCompletionEventId(ownerRootId, "job-1"));

    const initial = readUnreadCompletionEvents(workspace, ownerRootId);
    const afterRestart = await readFromFreshProcess(workspace, ownerRootId, process.env.CODEX_HARNESSDOCK_RUNTIME_HOME);
    assert.deepEqual(afterRestart.events, initial.events);
    assert.equal(afterRestart.events.length, 1);
    assert.match(afterRestart.events[0].deliveryToken, /^delivery-/);
    assert.ok(fs.existsSync(resolveCompletionInboxFile(workspace, ownerRootId)));
  });

  it("rejects skipped acknowledgement and permits a later contiguous acknowledgement", () => {
    const { workspace, ownerRootId } = setup();
    appendCompletionEvent(workspace, ownerRootId, completion("job-1"));
    appendCompletionEvent(workspace, ownerRootId, completion("job-2"));
    const delivered = readUnreadCompletionEvents(workspace, ownerRootId);
    assert.throws(
      () => acknowledgeCompletionEvents(workspace, ownerRootId, [delivered.events[1].deliveryToken]),
      /oldest unread contiguous token prefix/
    );
    assert.equal(readUnreadCompletionEvents(workspace, ownerRootId).events.length, 2);

    const acknowledged = acknowledgeCompletionEvents(workspace, ownerRootId, delivered.events.map((event) => event.deliveryToken));
    assert.deepEqual(acknowledged, { acknowledgedThrough: 2, acknowledgedCount: 2, compactedCount: 0 });
    assert.equal(readUnreadCompletionEvents(workspace, ownerRootId).events.length, 0);
  });

  it("skips a legacy prefix for Agent delivery while acknowledgement advances its cursor", () => {
    const { workspace, ownerRootId } = setup();
    const legacy = appendCompletionEvent(workspace, ownerRootId, completion("legacy-one-shot", {
      finalMessage: "legacy final output must remain internal",
    })).event;
    const linked = appendCompletionEvent(workspace, ownerRootId, completion("agent-completion", {
      agentId: "agent-current",
      finalMessage: "Claude final output enters only the bounded handoff",
    })).event;

    const delivered = readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    assert.deepEqual(delivered.events, [{
      kind: "completion",
      agentId: "agent-current",
      agentStatus: "completed",
      terminalStatus: "completed",
      summary: "Agent turn completed.",
      completionMessage: "Claude final output enters only the bounded handoff",
      completionMessageTruncated: false,
      deliveryToken: linked.deliveryToken,
      blocking: null,
      metrics: null,
    }]);
    assert.equal("finalMessage" in delivered.events[0], false);
    assert.equal("resultPointer" in delivered.events[0], false);
    assert.equal("resumability" in delivered.events[0], false);

    const acknowledged = acknowledgeAgentCompletionEvents(
      workspace,
      ownerRootId,
      [linked.deliveryToken]
    );
    assert.deepEqual(acknowledged, { acknowledgedThrough: 2, acknowledgedCount: 1, compactedCount: 0 });
    const stored = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8"));
    assert.deepEqual(stored.events.map((event) => [event.sequence, event.eventId]), [
      [1, legacy.eventId],
      [2, linked.eventId],
    ]);
    assert.deepEqual(readUnreadAgentCompletionSummaries(workspace, ownerRootId).events, []);
  });

  it("serializes concurrent appends without duplicate or missing sequences", async () => {
    const { workspace, ownerRootId } = setup();
    const writers = 5;
    const perWriter = 12;
    await Promise.all(Array.from({ length: writers }, (_, index) => runWriter(
      completionInboxUrl,
      workspace,
      ownerRootId,
      index * perWriter,
      perWriter,
      process.env.CODEX_HARNESSDOCK_RUNTIME_HOME
    )));
    const unread = readUnreadCompletionEvents(workspace, ownerRootId, { limit: 100 });
    assert.equal(unread.events.length, writers * perWriter);
    assert.deepEqual(
      unread.events.map((event) => event.sequence),
      Array.from({ length: writers * perWriter }, (_, index) => index + 1)
    );
    assert.equal(new Set(unread.events.map((event) => event.eventId)).size, writers * perWriter);
  });

  it("reconciles terminal jobs idempotently and compacts only acknowledged history", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "job-reconcile",
      status: "failed",
      updatedAt: "2026-07-25T00:00:00.000Z",
      errorMessage: "transport exhausted",
      resumability: { classification: "not_resumable", blockingReason: "transport exhausted" },
    };
    assert.equal(reconcileTerminalJobCompletion(workspace, ownerRootId, job).reconciled, true);
    assert.equal(reconcileTerminalJobCompletion(workspace, ownerRootId, job).reconciled, false);

    for (let index = 0; index < 5; index += 1) {
      appendCompletionEvent(workspace, ownerRootId, completion(`job-${index}`));
    }
    const delivered = readUnreadCompletionEvents(workspace, ownerRootId, { limit: 100 });
    acknowledgeCompletionEvents(workspace, ownerRootId, delivered.events.map((event) => event.deliveryToken), { acknowledgedTail: 2 });
    const compacted = compactAcknowledgedCompletionEvents(workspace, ownerRootId, { acknowledgedTail: 2 });
    assert.equal(compacted.retainedEventCount, 2);
    assert.equal(compacted.compactedCount, 0);
    const stored = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8"));
    assert.deepEqual(stored.events.map((event) => event.sequence), [5, 6]);
  });

  it("migrates a version-one cursor to per-event acknowledgement without changing frozen fields", () => {
    const { workspace, ownerRootId } = setup();
    const first = appendCompletionEvent(workspace, ownerRootId, completion("v1-first", {
      agentId: "agent-v1-first",
      finalMessage: "first",
    })).event;
    const second = appendCompletionEvent(workspace, ownerRootId, completion("v1-second", {
      agentId: "agent-v1-second",
      finalMessage: "second",
    })).event;
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const legacy = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    legacy.version = 1;
    legacy.acknowledgedThrough = first.sequence;
    legacy.events = legacy.events.map(({ acknowledgedAt, ...event }) => ({ ...event, version: 1 }));
    fs.writeFileSync(inboxFile, `${JSON.stringify(legacy, null, 2)}\n`);
    const unread = readUnreadAgentCompletionSummaries(workspace, ownerRootId);
    assert.deepEqual(unread.events.map((event) => event.completionMessage), ["second"]);
    acknowledgeAgentCompletionEvents(workspace, ownerRootId, [second.deliveryToken]);
    const migrated = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.events.map((event) => event.version), [1, 1]);
    assert.deepEqual(migrated.events.map((event) => event.finalMessage), [first.finalMessage, second.finalMessage]);
    assert.deepEqual(migrated.events.map((event) => event.deliveryToken), [first.deliveryToken, second.deliveryToken]);
    assert.equal(migrated.acknowledgedThrough, 2);
  });

  it("acknowledges selected Agent events out of order and derives the hole watermark", () => {
    const { workspace, ownerRootId } = setup();
    const events = ["hole-1", "hole-2", "hole-3"].map((jobId) => appendCompletionEvent(
      workspace,
      ownerRootId,
      completion(jobId, { agentId: `agent-${jobId}`, finalMessage: jobId }),
    ).event);
    const delivered = readUnreadAgentCompletionSummaries(workspace, ownerRootId, { limit: 3 });
    assert.equal(delivered.events.length, 3);
    assert.equal(acknowledgeAgentCompletionEvents(workspace, ownerRootId, [events[1].deliveryToken]).acknowledgedThrough, 0);
    const storedHole = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8"));
    assert.equal(storedHole.events[1].acknowledgedAt != null, true);
    assert.equal(storedHole.acknowledgedThrough, 0);
    const completed = acknowledgeAgentCompletionEvents(workspace, ownerRootId, [
      events[2].deliveryToken,
      events[0].deliveryToken,
    ]);
    assert.equal(completed.acknowledgedThrough, 3);
    assert.equal(completed.acknowledgedCount, 2);
    assert.equal(acknowledgeAgentCompletionEvents(workspace, ownerRootId, [events[0].deliveryToken]).acknowledgedCount, 0);
  });

  it("rejects a version-two cursor that skips an unread acknowledgement hole", () => {
    const { workspace, ownerRootId } = setup();
    appendCompletionEvent(workspace, ownerRootId, completion("invalid-v2-hole", {
      agentId: "agent-invalid-v2-hole",
    }));
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const stored = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    stored.acknowledgedThrough = 1;
    fs.writeFileSync(inboxFile, `${JSON.stringify(stored, null, 2)}\n`);

    assert.throws(
      () => readUnreadAgentCompletionSummaries(workspace, ownerRootId),
      /cursor skips an unread event/,
    );
  });
});

/**
 * One version-two normalized terminal result, reduced to the fields the
 * completion seam is allowed to consult. No production version-two caller
 * exists yet, so this proves the closed internal path only: the seven public
 * operations and every version-one job keep their exact current behavior.
 */
function normalizedTerminalResult(overrides = {}) {
  const { executionWorld, continuation, ...rest } = overrides;
  return {
    contractVersion: 2,
    harnessId: "fake-service",
    driverVersion: "fake-service@1",
    instanceKey: "tenant-alpha",
    status: "completed",
    nativeTurn: "terminal",
    executionWorld: { continuity: "preserved", settlement: "settled", ...(executionWorld ?? {}) },
    continuation: { mode: "exact_resume", nativeSessionRef: null, evidence: {}, ...(continuation ?? {}) },
    failure: { class: null, reason: null, detail: null, resumable: false, requiresAttention: false },
    finalMessage: "service turn completed",
    finalMessageAbsenceReason: null,
    progress: null,
    metrics: null,
    resultMetadata: null,
    driverReceipt: null,
    ...rest,
  };
}

/**
 * Counts every filesystem call the completion inbox could make. A refusal must
 * not read, lock, write, fsync, or rename anything at all.
 */
function observeInboxIo(operation) {
  const names = [
    "readFileSync", "writeFileSync", "openSync", "renameSync", "mkdirSync",
    "linkSync", "fsyncSync", "unlinkSync", "statSync", "chmodSync", "closeSync",
  ];
  const originals = {};
  const counts = {};
  for (const name of names) {
    originals[name] = fs[name];
    counts[name] = 0;
    fs[name] = (...args) => {
      counts[name] += 1;
      return originals[name](...args);
    };
  }
  try {
    return { counts, result: operation(), error: null };
  } catch (error) {
    return { counts, result: null, error };
  } finally {
    for (const name of names) fs[name] = originals[name];
  }
}

function totalIo(counts) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

const unpublishableEvidence = [
  ["unknown owned work", { status: "failed", executionWorld: { settlement: "unknown" } }, "execution_settlement_unknown"],
  ["active owned work", { status: "interrupted", executionWorld: { settlement: "active" } }, "execution_settlement_active"],
  ["unknown native turn", { status: "failed", nativeTurn: "unknown" }, "native_turn_unknown"],
  ["active native turn", { status: "failed", nativeTurn: "active" }, "native_turn_active"],
  ["contradictory claim", { status: "completed", executionWorld: { settlement: "active" } }, "contradictory_terminal_evidence"],
  ["unreadable axes", { nativeTurn: "finished" }, "invalid_evidence"],
];

describe("completion settlement gate", () => {
  it("creates no event, mutation, or acknowledgement for unpublishable version-two evidence", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    for (const [label, overrides, reason] of unpublishableEvidence) {
      const attempt = observeInboxIo(() => appendCompletionEvent(workspace, ownerRootId, completion(`v2-${reason}`, {
        agentId: `agent-${reason}`,
        normalizedTerminalResult: normalizedTerminalResult(overrides),
      })));
      assert.match(
        String(attempt.error?.message),
        new RegExp(`cannot publish a completion: terminal settlement is ${reason}`),
        label,
      );
      // No read, lock, write, fsync, or rename happened at all.
      assert.equal(totalIo(attempt.counts), 0, label);
      // Nothing was created, so nothing can be delivered or acknowledged.
      assert.equal(fs.existsSync(inboxFile), false, label);
      assert.deepEqual(readUnreadCompletionEvents(workspace, ownerRootId).events, [], label);
      assert.deepEqual(readUnreadAgentCompletionSummaries(workspace, ownerRootId).events, [], label);
    }
  });

  it("withholds reconciliation for an unpublishable version-two job without touching the inbox", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    for (const [label, overrides, reason] of unpublishableEvidence) {
      const outcome = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, {
        id: `job-${reason}`,
        agentId: `agent-${reason}`,
        status: "completed",
        completedAt: "2026-07-25T00:00:00.000Z",
        summary: "service turn",
        result: normalizedTerminalResult(overrides),
      }));
      assert.deepEqual(outcome.result, { reconciled: false, reason, event: null }, label);
      assert.equal(totalIo(outcome.counts), 0, label);
      assert.equal(fs.existsSync(inboxFile), false, label);
      assert.deepEqual(readUnreadCompletionEvents(workspace, ownerRootId).events, [], label);
    }
  });

  it("holds an unpublishable correction back from an already published completion", () => {
    const { workspace, ownerRootId } = setup();
    const job = {
      id: "job-settled-then-unknown",
      agentId: "agent-settled-then-unknown",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: normalizedTerminalResult(),
    };
    const first = reconcileTerminalJobCompletion(workspace, ownerRootId, job);
    assert.equal(first.reconciled, true);
    const stored = fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8");

    const withheld = reconcileTerminalJobCompletion(workspace, ownerRootId, {
      ...job,
      summary: "revised service turn",
      result: normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } }),
    });
    assert.deepEqual(withheld, { reconciled: false, reason: "execution_settlement_unknown", event: null });
    // The preexisting completion payload is left exactly as it was.
    assert.equal(fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8"), stored);
  });

  it("publishes settled evidence, including an idle service turn, exactly once", () => {
    const { workspace, ownerRootId } = setup();
    for (const [jobId, overrides] of [
      ["v2-settled", {}],
      ["v2-idle-service", {
        executionWorld: { continuity: "not_applicable", settlement: "settled" },
        continuation: { mode: "none" },
      }],
      ["v2-interrupted-settled", {
        status: "interrupted",
        failure: { class: "cancelled_or_interrupted", reason: null, detail: null, resumable: false, requiresAttention: false },
      }],
    ]) {
      const job = {
        id: jobId,
        agentId: `agent-${jobId}`,
        status: overrides.status === "interrupted" ? "interrupted" : "completed",
        completedAt: "2026-07-25T00:00:00.000Z",
        summary: `${jobId} summary`,
        result: normalizedTerminalResult(overrides),
      };
      const first = reconcileTerminalJobCompletion(workspace, ownerRootId, job);
      assert.equal(first.reconciled, true, jobId);
      assert.equal(first.reason, "appended", jobId);
      const repeated = reconcileTerminalJobCompletion(workspace, ownerRootId, job);
      assert.equal(repeated.reconciled, false, jobId);
      assert.equal(repeated.reason, "already-present", jobId);
      assert.equal(repeated.event.sequence, first.event.sequence, jobId);
      assert.equal(
        appendCompletionEvent(workspace, ownerRootId, completion(jobId, {
          agentId: `agent-${jobId}`,
          summary: `${jobId} summary`,
          normalizedTerminalResult: normalizedTerminalResult(overrides),
        })).appended,
        false,
        jobId,
      );
    }
    const stored = JSON.parse(fs.readFileSync(resolveCompletionInboxFile(workspace, ownerRootId), "utf8"));
    assert.deepEqual(stored.events.map((event) => event.jobId), ["v2-settled", "v2-idle-service", "v2-interrupted-settled"]);
    // The internal evidence field is never stored or projected.
    assert.equal(stored.events.some((event) => Object.hasOwn(event, "normalizedTerminalResult")), false);
    const unread = readUnreadCompletionEvents(workspace, ownerRootId, { limit: 10 }).events;
    assert.equal(unread.length, 3);
    assert.equal(unread.some((event) => Object.hasOwn(event, "normalizedTerminalResult")), false);
  });

  it("refuses wrapped version-two evidence instead of letting it skip the gate", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const unpublishable = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });
    // A Proxy can answer one thing to the gate and another to the next reader,
    // so it is refused as unreadable rather than trusted or waved through.
    assert.throws(
      () => appendCompletionEvent(workspace, ownerRootId, completion("v2-proxied", {
        agentId: "agent-v2-proxied",
        normalizedTerminalResult: new Proxy(unpublishable, {}),
      })),
      /terminal settlement is invalid_evidence/,
    );
    assert.deepEqual(
      reconcileTerminalJobCompletion(workspace, ownerRootId, {
        id: "job-v2-proxied",
        agentId: "agent-v2-proxied",
        status: "completed",
        completedAt: "2026-07-25T00:00:00.000Z",
        summary: "service turn",
        result: new Proxy(normalizedTerminalResult(), {}),
      }),
      { reconciled: false, reason: "invalid_evidence", event: null },
    );
    assert.equal(fs.existsSync(inboxFile), false);
    assert.deepEqual(readUnreadCompletionEvents(workspace, ownerRootId).events, []);
  });

  it("refuses inherited and class-prototype version-two evidence at the inbox seam", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });
    class TerminalEvidence {}
    Object.assign(TerminalEvidence.prototype, unsettled);

    const appended = observeInboxIo(() => appendCompletionEvent(workspace, ownerRootId, completion("v2-inherited", {
      agentId: "agent-v2-inherited",
      normalizedTerminalResult: Object.create(unsettled),
    })));
    assert.match(String(appended.error), /terminal settlement is invalid_evidence/);
    assert.equal(totalIo(appended.counts), 0);

    const reconciled = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "job-v2-class",
      agentId: "agent-v2-class",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: new TerminalEvidence(),
    }));
    assert.deepEqual(reconciled.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(totalIo(reconciled.counts), 0);
    assert.equal(fs.existsSync(inboxFile), false);
    assert.deepEqual(readUnreadCompletionEvents(workspace, ownerRootId).events, []);
  });

  it("refuses an alternating accessor or Proxy container without invoking it once", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const settled = normalizedTerminalResult();
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });

    // The classic time-of-check attack: the gate is shown settled evidence and
    // the projection is shown unsettled evidence from the same field.
    let reads = 0;
    const alternating = {
      id: "job-alternating",
      agentId: "agent-alternating",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
    };
    Object.defineProperty(alternating, "result", {
      get() {
        reads += 1;
        return reads === 1 ? settled : unsettled;
      },
      enumerable: true,
      configurable: true,
    });
    const alternated = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, alternating));
    assert.deepEqual(alternated.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(reads, 0);
    assert.equal(totalIo(alternated.counts), 0);

    const traps = [];
    const spy = {
      get(target, key, receiver) {
        traps.push(`get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        traps.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
      getOwnPropertyDescriptor(target, key) {
        traps.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    };
    const proxiedJob = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, new Proxy({
      id: "job-proxied-container",
      agentId: "agent-proxied-container",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: settled,
    }, spy)));
    assert.deepEqual(proxiedJob.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(totalIo(proxiedJob.counts), 0);

    const proxiedInput = observeInboxIo(() => appendCompletionEvent(
      workspace,
      ownerRootId,
      new Proxy(completion("v2-proxied-input", {
        agentId: "agent-v2-proxied-input",
        normalizedTerminalResult: settled,
      }), spy),
    ));
    assert.match(String(proxiedInput.error), /terminal settlement is invalid_evidence/);
    assert.equal(totalIo(proxiedInput.counts), 0);
    assert.deepEqual(traps, []);
    assert.equal(fs.existsSync(inboxFile), false);
  });

  it("refuses conflicting evidence fields whichever one is unsettled", () => {
    const { workspace, ownerRootId } = setup();
    const settled = normalizedTerminalResult();
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "active" } });
    for (const [jobId, fields] of [
      ["job-conflict-a", { normalizedTerminalResult: unsettled, result: settled }],
      ["job-conflict-b", { normalizedTerminalResult: settled, result: unsettled }],
    ]) {
      const outcome = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, {
        id: jobId,
        agentId: `agent-${jobId}`,
        status: "completed",
        completedAt: "2026-07-25T00:00:00.000Z",
        summary: "service turn",
        ...fields,
      }));
      assert.deepEqual(outcome.result, { reconciled: false, reason: "execution_settlement_active", event: null }, jobId);
      assert.equal(totalIo(outcome.counts), 0, jobId);
    }
    assert.equal(fs.existsSync(resolveCompletionInboxFile(workspace, ownerRootId)), false);
  });

  it("leaves a published event's bytes, unread batch, and cursor untouched under every refusal", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const job = {
      id: "job-published",
      agentId: "agent-published",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: normalizedTerminalResult(),
    };
    assert.equal(reconcileTerminalJobCompletion(workspace, ownerRootId, job).reconciled, true);
    const published = fs.readFileSync(inboxFile, "utf8");
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });
    class TerminalEvidence {}
    Object.assign(TerminalEvidence.prototype, unsettled);

    for (const attack of [
      { ...job, summary: "revised", result: Object.create(unsettled) },
      { ...job, summary: "revised", result: new TerminalEvidence() },
      { ...job, summary: "revised", result: unsettled },
      { ...job, summary: "revised", result: new Proxy(unsettled, {}) },
    ]) {
      const outcome = reconcileTerminalJobCompletion(workspace, ownerRootId, attack);
      assert.equal(outcome.reconciled, false);
      assert.equal(outcome.event, null);
      assert.equal(fs.readFileSync(inboxFile, "utf8"), published);
    }
    const unread = readUnreadCompletionEvents(workspace, ownerRootId, { limit: 10 });
    assert.equal(unread.events.length, 1);
    assert.equal(unread.acknowledgedThrough, 0);
    assert.equal(unread.events[0].jobId, "job-published");
  });

  it("leaves version-one terminal jobs and completions untouched by the gate", () => {
    const { workspace, ownerRootId } = setup();
    // A version-one job result carries process-shaped evidence and no axis at
    // all: it must reconcile exactly as it did before the gate existed.
    const legacy = reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "legacy-job",
      agentId: "agent-legacy",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "legacy summary",
      recoverability: { resumable: true, exactSessionId: "session-legacy" },
      result: { contractVersion: 1, exitStatus: 0, rawOutput: "legacy output", failureClass: null, metrics: null },
    });
    assert.equal(legacy.reconciled, true);
    assert.equal(legacy.event.finalMessage, "legacy output");
    assert.equal(legacy.event.resumability.classification, "resumable");
    // A plain completion input without any settlement evidence is unaffected.
    assert.equal(appendCompletionEvent(workspace, ownerRootId, completion("plain-job")).appended, true);
  });

  it("refuses a lying Proxy in the evidence object's own prototype chain without invoking it", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });
    const traps = [];
    // A lying `has` trap denies every axis field; a correct reader must not
    // let that make the evidence look axis-free and skip the gate.
    const lyingEvidenceProto = new Proxy(unsettled, {
      has(target, key) {
        traps.push(`has:${String(key)}`);
        return false;
      },
    });
    const evidenceViaProto = Object.create(lyingEvidenceProto);

    const appended = observeInboxIo(() => appendCompletionEvent(workspace, ownerRootId, completion("v2-evidence-proto-proxy", {
      agentId: "agent-evidence-proto-proxy",
      normalizedTerminalResult: evidenceViaProto,
    })));
    assert.match(String(appended.error), /terminal settlement is invalid_evidence/);
    assert.equal(totalIo(appended.counts), 0);

    const reconciled = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "job-evidence-proto-proxy",
      agentId: "agent-evidence-proto-proxy",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "looks fine",
      result: evidenceViaProto,
    }));
    assert.deepEqual(reconciled.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(totalIo(reconciled.counts), 0);
    // The lying trap is never consulted, on either path.
    assert.deepEqual(traps, []);
    assert.equal(fs.existsSync(inboxFile), false);
  });

  it("refuses a lying Proxy in the completion/job container's own prototype chain without invoking it", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    const unsettled = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });
    const traps = [];
    const lyingContainerProto = new Proxy(
      { result: unsettled, normalizedTerminalResult: unsettled },
      {
        has(target, key) {
          traps.push(`has:${String(key)}`);
          return false;
        },
      },
    );
    const job = Object.create(lyingContainerProto);
    Object.assign(job, {
      id: "job-container-proto-proxy",
      agentId: "agent-container-proto-proxy",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "looks fine",
    });
    const reconciled = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, job));
    assert.deepEqual(reconciled.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(totalIo(reconciled.counts), 0);

    const completionContainer = Object.create(
      new Proxy(
        { normalizedTerminalResult: unsettled },
        {
          has(target, key) {
            traps.push(`has:${String(key)}`);
            return false;
          },
        },
      ),
    );
    Object.assign(completionContainer, completion("v2-completion-container-proto-proxy", {
      agentId: "agent-completion-container-proto-proxy",
    }));
    const appended = observeInboxIo(() => appendCompletionEvent(workspace, ownerRootId, completionContainer));
    assert.match(String(appended.error), /terminal settlement is invalid_evidence/);
    assert.equal(totalIo(appended.counts), 0);

    assert.deepEqual(traps, []);
    assert.equal(fs.existsSync(inboxFile), false);
  });

  it("never invokes a throwing or alternating `has` trap while classifying a container or evidence chain", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    let callCount = 0;
    const settled = normalizedTerminalResult();
    const throwingContainerProto = new Proxy(
      { result: settled },
      {
        has() {
          callCount += 1;
          if (callCount % 2 === 1) throw new Error("malicious has trap");
          return false;
        },
      },
    );
    const job = Object.create(throwingContainerProto);
    Object.assign(job, {
      id: "job-throwing-container-proxy",
      agentId: "agent-throwing-container-proxy",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "looks fine",
    });
    let reconciled;
    assert.doesNotThrow(() => {
      reconciled = observeInboxIo(() => reconcileTerminalJobCompletion(workspace, ownerRootId, job));
    });
    assert.deepEqual(reconciled.result, { reconciled: false, reason: "invalid_evidence", event: null });
    assert.equal(totalIo(reconciled.counts), 0);
    assert.equal(callCount, 0);
    assert.equal(fs.existsSync(inboxFile), false);
  });

  it("skips only the malicious job in a batch, with zero traps and zero I/O for it, while both healthy jobs publish", () => {
    const { workspace, ownerRootId } = setup();
    const inboxFile = resolveCompletionInboxFile(workspace, ownerRootId);
    function healthyJob(id) {
      return {
        id,
        agentId: `agent-${id}`,
        status: "completed",
        completedAt: "2026-07-25T00:00:00.000Z",
        summary: `${id} summary`,
        result: { contractVersion: 1, exitStatus: 0, rawOutput: `${id} output`, failureClass: null, metrics: null },
      };
    }
    const traps = [];
    const throwingProto = new Proxy(
      {},
      {
        has(target, key) {
          traps.push(`has:${String(key)}`);
          throw new Error("malicious has trap");
        },
      },
    );
    const maliciousJob = Object.create(throwingProto);
    Object.assign(maliciousJob, {
      id: "job-malicious",
      agentId: "agent-malicious",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "evil",
    });

    let results;
    assert.doesNotThrow(() => {
      results = reconcileTerminalJobCompletions(workspace, ownerRootId, [
        healthyJob("job-healthy-a"),
        maliciousJob,
        healthyJob("job-healthy-b"),
      ]);
    });
    assert.equal(results.length, 3);
    assert.equal(results[0].reconciled, true, "first healthy job");
    assert.equal(results[0].reason, "appended", "first healthy job");
    assert.equal(results[1].reconciled, false, "malicious job");
    assert.equal(results[1].reason, "invalid_evidence", "malicious job");
    assert.equal(results[1].event, null, "malicious job");
    assert.equal(results[2].reconciled, true, "second healthy job");
    assert.equal(results[2].reason, "appended", "second healthy job");
    // Zero traps invoked for the malicious item anywhere in the batch.
    assert.deepEqual(traps, []);

    const stored = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    assert.deepEqual(stored.events.map((event) => event.jobId), ["job-healthy-a", "job-healthy-b"]);
    assert.deepEqual(stored.events.map((event) => event.sequence), [1, 2]);
  });

  it("keeps canonical Object.prototype and null-prototype settled/unsettled evidence unchanged at the seam", () => {
    const { workspace, ownerRootId } = setup();
    const bare = (fields) => Object.assign(Object.create(null), fields);
    const settledNullProto = bare({
      ...normalizedTerminalResult(),
      executionWorld: bare(normalizedTerminalResult().executionWorld),
      continuation: bare(normalizedTerminalResult().continuation),
    });
    const settledOrdinary = normalizedTerminalResult();
    const unsettledOrdinary = normalizedTerminalResult({ status: "failed", executionWorld: { settlement: "unknown" } });

    const settledNullReconciled = reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "job-settled-null-proto",
      agentId: "agent-settled-null-proto",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: settledNullProto,
    });
    assert.equal(settledNullReconciled.reconciled, true);
    assert.equal(settledNullReconciled.reason, "appended");

    const settledOrdinaryReconciled = reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "job-settled-ordinary-proto",
      agentId: "agent-settled-ordinary-proto",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: settledOrdinary,
    });
    assert.equal(settledOrdinaryReconciled.reconciled, true);
    assert.equal(settledOrdinaryReconciled.reason, "appended");

    const unsettledReconciled = reconcileTerminalJobCompletion(workspace, ownerRootId, {
      id: "job-unsettled-ordinary-proto",
      agentId: "agent-unsettled-ordinary-proto",
      status: "completed",
      completedAt: "2026-07-25T00:00:00.000Z",
      summary: "service turn",
      result: unsettledOrdinary,
    });
    assert.deepEqual(unsettledReconciled, { reconciled: false, reason: "execution_settlement_unknown", event: null });
  });
});
