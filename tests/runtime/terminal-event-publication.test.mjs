import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// RED contract for the producer-side terminal seam.  The implementation is
// intentionally not present yet: these tests freeze the smallest useful
// boundary without reaching into the wake-me-up checkout or its private state.
import {
  buildWorkerTerminalEvent,
  publishWorkerTerminalEvent,
  reconcileWorkerTerminalEvent,
  terminalPublisherReadiness,
} from "../../runtime/terminal-event-publisher.mjs";

const AGENT = "/root/terminal_event_agent";

function terminalJob(status, overrides = {}) {
  return {
    id: "job-terminal-event-1",
    agentId: "agent-terminal-event-1",
    status,
    completedAt: "2026-08-31T00:00:00.000Z",
    summary: "bounded summary",
    normalizedTerminalResult: {
      status,
      finalMessage: "the completion body",
      failure: status === "completed"
        ? { class: null, reason: null, detail: null }
        : { class: "harness_internal", reason: "driver stopped", detail: null },
      ...overrides.normalizedTerminalResult,
    },
    ...overrides,
  };
}

describe("producer terminal event mapping", () => {
  it("reports only redacted publisher readiness", () => {
    const missing = terminalPublisherReadiness({});
    assert.deepEqual(missing, { configured: false, ready: false });
    const text = JSON.stringify(missing);
    assert.equal(text.includes("descriptor"), false);
    assert.equal(text.includes("token"), false);

    const invalid = terminalPublisherReadiness({
      CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: "/missing/publisher",
      CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: "/missing/runtime",
    });
    assert.deepEqual(invalid, { configured: true, ready: false });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-terminal-publisher-ready-"));
    try {
      const executable = path.join(root, "publisher");
      const nonExecutable = path.join(root, "not-executable");
      const runtimeRoot = path.join(root, "runtime");
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      fs.mkdirSync(runtimeRoot);
      assert.deepEqual(terminalPublisherReadiness({
        CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: nonExecutable,
        CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: runtimeRoot,
      }), { configured: true, ready: false });
      assert.deepEqual(terminalPublisherReadiness({
        CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: executable,
        CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: runtimeRoot,
      }), { configured: true, ready: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("maps every closed Agent outcome to one worker-terminal outcome", () => {
    const events = ["completed", "failed", "interrupted", "unknown"].map((status) =>
      buildWorkerTerminalEvent({
        agentName: AGENT,
        terminalJob: terminalJob(status),
      })
    );
    assert.deepEqual(
      events.map(({ kind, producer_task_id, outcome, reason }) => ({
        kind, producer_task_id, outcome, ...(reason == null ? {} : { reason }),
      })),
      [
        { kind: "worker_terminal", producer_task_id: AGENT, outcome: "completed" },
        { kind: "worker_terminal", producer_task_id: AGENT, outcome: "failed", reason: "driver stopped" },
        { kind: "worker_terminal", producer_task_id: AGENT, outcome: "cancelled", reason: "driver stopped" },
        {
          kind: "worker_terminal",
          producer_task_id: AGENT,
          outcome: "settlement_uncertain",
          reason: "driver_unverifiable",
        },
      ],
    );
    for (const event of events) {
      assert.equal(Object.hasOwn(event, "candidate_oid"), false);
      assert.equal(Object.hasOwn(event, "candidate_commit"), false);
    }
  });

  it("never publishes progress, working state, or Driver prose as a terminal event", () => {
    for (const status of ["running", "queued", "waiting", "starting"]) {
      assert.throws(
        () => buildWorkerTerminalEvent({
          agentName: AGENT,
          terminalJob: terminalJob(status, {
            summary: "terminal-looking prose from a progress update",
          }),
        }),
        /terminal|closed|settlement/i,
      );
    }
  });
});

describe("producer terminal event ordering and repair", () => {
  it("binds every durable completion owner to the shared publisher", () => {
    for (const file of ["v3-worker-loop.mjs", "v3-job-store.mjs", "job-store.mjs"]) {
      const source = fs.readFileSync(path.join(process.cwd(), "runtime", file), "utf8");
      assert.match(source, /publishBoundTerminalEvent/, file);
    }
  });

  it("publishes only after the durable completion fact and preserves completion bytes", async () => {
    const job = terminalJob("completed");
    const completion = Object.freeze({
      eventId: "completion-event-1",
      deliveryToken: "delivery-token-1",
      terminalStatus: "completed",
      finalMessage: "the completion body",
    });
    const before = JSON.stringify(completion);
    const calls = [];

    await publishWorkerTerminalEvent({
      agentName: AGENT,
      terminalJob: job,
      completion,
      completionDurable: true,
      publish: async (event) => {
        calls.push({ event, completion: JSON.stringify(completion) });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.outcome, "completed");
    assert.deepEqual(JSON.stringify(completion), before);
    assert.deepEqual(calls[0].completion, before);

    await assert.rejects(
      publishWorkerTerminalEvent({
        agentName: AGENT,
        terminalJob: job,
        completion,
        completionDurable: false,
        publish: async () => { throw new Error("must not publish before completion"); },
      }),
      /durable completion/i,
    );
  });

  it("retries the identical envelope after a crash between external publish and the local marker", async () => {
    const job = terminalJob("failed");
    const published = [];
    const state = { terminalEventPublished: false };
    const publish = async (event) => {
      published.push(structuredClone(event));
      if (published.length === 1) throw new Error("crash after publisher accepted payload");
      return { accepted: true };
    };

    await assert.rejects(
      publishWorkerTerminalEvent({
        agentName: AGENT,
        terminalJob: job,
        completion: { eventId: "completion-event-2", deliveryToken: "delivery-token-2" },
        completionDurable: true,
        state,
        publish,
      }),
      /crash after publisher accepted payload/,
    );
    assert.equal(state.terminalEventPublished, false);

    await reconcileWorkerTerminalEvent({
      agentName: AGENT,
      terminalJob: job,
      completion: { eventId: "completion-event-2", deliveryToken: "delivery-token-2" },
      state,
      publish,
    });
    assert.deepEqual(published[1], published[0]);
    assert.equal(state.terminalEventPublished, true);

    await reconcileWorkerTerminalEvent({
      agentName: AGENT,
      terminalJob: job,
      completion: { eventId: "completion-event-2", deliveryToken: "delivery-token-2" },
      state,
      publish,
    });
    assert.equal(published.length, 2, "a recorded success is not retried");
  });

  it("records a terminal publisher failure without rewriting completion or retrying automatically", async () => {
    const job = terminalJob("failed");
    const completion = { eventId: "completion-event-3", deliveryToken: "delivery-token-3" };
    const state = {};
    let calls = 0;
    const result = await publishWorkerTerminalEvent({
      agentName: AGENT,
      terminalJob: job,
      completion,
      completionDurable: true,
      state,
      publish: async () => {
        calls += 1;
        return { accepted: false, reason: "publisher_unavailable" };
      },
    });
    assert.equal(result.published, false);
    assert.equal(state.terminalEventPublished, false);
    assert.equal(state.terminalEventFailure.reason, "publisher_unavailable");

    await reconcileWorkerTerminalEvent({
      agentName: AGENT,
      terminalJob: job,
      completion,
      state,
      publish: async () => { calls += 1; return { accepted: true }; },
    });
    assert.equal(calls, 1, "a recorded publisher failure is not an automatic retry loop");
    assert.deepEqual(completion, { eventId: "completion-event-3", deliveryToken: "delivery-token-3" });
  });

  it("rejects a conflicting rewrite instead of publishing a second terminal fact", async () => {
    const firstJob = terminalJob("completed");
    const state = { terminalEventPublished: true };
    let calls = 0;
    await assert.rejects(
      reconcileWorkerTerminalEvent({
        agentName: AGENT,
        terminalJob: terminalJob("completed", {
          normalizedTerminalResult: { finalMessage: "rewritten completion" },
        }),
        completion: { eventId: "completion-event-1", deliveryToken: "delivery-token-1" },
        state,
        publish: async () => { calls += 1; },
        priorTerminalJob: firstJob,
      }),
      /immutable|conflict/i,
    );
    assert.equal(calls, 0);
  });
});
