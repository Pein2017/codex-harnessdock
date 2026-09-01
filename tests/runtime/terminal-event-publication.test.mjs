import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  HARD_RECLAIM_LIFECYCLE_MESSAGE,
  deterministicCompletionEventId,
} from "../../runtime/completion-inbox.mjs";

// RED contract for the producer-side terminal seam.  The implementation is
// intentionally not present yet: these tests freeze the smallest useful
// boundary without reaching into the wake-me-up checkout or its private state.
import {
  buildWorkerTerminalEvent,
  publishBoundTerminalEvent,
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

function committedHardReclaim(jobId) {
  return {
    ownerRootId: "root-hard-reclaim-publication",
    jobId,
    agentId: "hard-reclaimed-agent",
    status: "hard_reclaimed",
    uncertainty: { reason: "worker_lost" },
    terminalJob: null,
    hardReclaim: {
      phase: "committed",
      leaseDisposition: {
        admission: "released",
        writer: "retained_reused",
        serviceTurn: "retained_reused",
      },
    },
  };
}

function hardReclaimCompletion(record) {
  return {
    eventId: deterministicCompletionEventId(record.ownerRootId, record.jobId),
    jobId: record.jobId,
    agentId: record.agentId,
    terminalStatus: "hard_reclaimed",
    settlement: "unknown",
    summary: HARD_RECLAIM_LIFECYCLE_MESSAGE,
    finalMessage: HARD_RECLAIM_LIFECYCLE_MESSAGE,
    blocking: { reason: "worker_lost", scope: "agent", retry: "new_agent" },
    detailedResultAvailable: false,
    resultPointer: null,
    metrics: null,
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
    const events = ["completed", "failed", "interrupted", "unknown", "hard_reclaimed"].map((status) =>
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
        {
          kind: "worker_terminal",
          producer_task_id: AGENT,
          outcome: "settlement_uncertain",
          reason: "worker_lost",
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
  it("requires durable hard reclaim, Agent loss, and lifecycle completion before descriptor publication", () => {
    let calls = 0;
    const publication = [];
    const store = {
      terminalEventBinding: () => ({
        binding: { jobId: "hard-reclaimed-publish", descriptorPath: "/private/descriptor" },
        publication: null,
      }),
      resolveTarget: () => ({ path: AGENT, status: "running", latestJobId: "hard-reclaimed-publish" }),
      recordTerminalEventPublication: (_agentId, value) => publication.push(value),
    };
    const hardReclaim = committedHardReclaim("hard-reclaimed-publish");
    const completion = hardReclaimCompletion(hardReclaim);
    const frozenPhysical = JSON.stringify({
      uncertainty: hardReclaim.uncertainty,
      hardReclaim: hardReclaim.hardReclaim,
    });

    const beforeAgent = publishBoundTerminalEvent({
      store, agentId: hardReclaim.agentId, hardReclaim, completion,
      env: new Proxy({}, { get() { calls += 1; return undefined; } }),
    });
    assert.deepEqual(beforeAgent, { published: false, reason: "lifecycle_not_durable" });
    assert.equal(calls, 0);
    assert.deepEqual(publication, []);
    assert.equal(JSON.stringify({ uncertainty: hardReclaim.uncertainty, hardReclaim: hardReclaim.hardReclaim }), frozenPhysical);
  });

  it("does not call a publisher without a descriptor and records unavailable publication once", () => {
    const hardReclaim = committedHardReclaim("hard-reclaimed-bound");
    const completion = hardReclaimCompletion(hardReclaim);
    const frozenPhysical = JSON.stringify({
      uncertainty: hardReclaim.uncertainty,
      hardReclaim: hardReclaim.hardReclaim,
    });
    const agent = {
      path: AGENT, status: "errored", activeJobId: null, latestJobId: hardReclaim.jobId,
      continuation: { mode: "blocked", evidence: { reason: "worker_lost" } },
    };
    const absentCalls = [];
    const absent = publishBoundTerminalEvent({
      store: {
        terminalEventBinding: () => null,
        resolveTarget: () => agent,
        recordTerminalEventPublication: (...args) => absentCalls.push(args),
      },
      agentId: hardReclaim.agentId,
      hardReclaim,
      completion,
      env: new Proxy({}, { get() { throw new Error("publisher must not be inspected"); } }),
    });
    assert.deepEqual(absent, { published: false, reason: "not_bound_or_recorded" });
    assert.deepEqual(absentCalls, []);
    assert.equal(JSON.stringify({ uncertainty: hardReclaim.uncertainty, hardReclaim: hardReclaim.hardReclaim }), frozenPhysical);

    const publication = [];
    const binding = {
      binding: { jobId: hardReclaim.jobId, descriptorPath: "/private/descriptor" },
      publication: null,
    };
    const unavailableStore = {
      terminalEventBinding: () => binding,
      resolveTarget: () => agent,
      recordTerminalEventPublication: (_agentId, value) => {
        publication.push(value);
        binding.publication = value;
      },
    };
    const unavailable = publishBoundTerminalEvent({
      store: unavailableStore, agentId: hardReclaim.agentId, hardReclaim, completion, env: {},
    });
    assert.deepEqual(unavailable, { published: false, reason: "publisher_failed" });
    assert.deepEqual(publication, [{ state: "failed", jobId: hardReclaim.jobId }]);
    assert.deepEqual(
      publishBoundTerminalEvent({ store: unavailableStore, agentId: hardReclaim.agentId, hardReclaim, completion, env: {} }),
      { published: false, reason: "not_bound_or_recorded" },
    );
    assert.equal(publication.length, 1);
    assert.equal(JSON.stringify({ uncertainty: hardReclaim.uncertainty, hardReclaim: hardReclaim.hardReclaim }), frozenPhysical);
  });

  it("records a rejected hard-reclaim publication with no fallback or state mutation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-hard-reclaim-rejected-"));
    try {
      const executable = path.join(root, "publisher.mjs");
      const runtimeRoot = path.join(root, "runtime");
      const captured = path.join(root, "captured.jsonl");
      fs.mkdirSync(runtimeRoot);
      fs.writeFileSync(executable, [
        "#!/usr/bin/env node",
        "import fs from 'node:fs';",
        "const payload = process.argv[process.argv.indexOf('--event-payload') + 1];",
        "fs.appendFileSync(process.env.HD_CAPTURED_EVENTS, fs.readFileSync(payload, 'utf8') + '\\n');",
        "process.stdout.write(JSON.stringify({ state: 'rejected' }));",
      ].join("\n"), { mode: 0o700 });
      const hardReclaim = committedHardReclaim("hard-reclaimed-rejected");
      const before = JSON.stringify(hardReclaim);
      const completion = hardReclaimCompletion(hardReclaim);
      const agent = {
        path: AGENT, status: "errored", activeJobId: null, latestJobId: hardReclaim.jobId,
        continuation: { mode: "blocked", evidence: { reason: "worker_lost" } },
      };
      const binding = {
        binding: { jobId: hardReclaim.jobId, descriptorPath: path.join(root, "descriptor") },
        publication: null,
      };
      const publications = [];
      const store = {
        terminalEventBinding: () => binding,
        resolveTarget: () => agent,
        recordTerminalEventPublication: (_agentId, value) => {
          publications.push(value);
          binding.publication = value;
        },
      };
      const env = {
        ...process.env,
        CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: executable,
        CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: runtimeRoot,
        HD_CAPTURED_EVENTS: captured,
      };
      assert.deepEqual(publishBoundTerminalEvent({
        store, agentId: hardReclaim.agentId, hardReclaim, completion, env,
      }), { published: false, receipt: { published: false } });
      assert.deepEqual(publications, [{ state: "failed", jobId: hardReclaim.jobId }]);
      assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8").trim()), {
        kind: "worker_terminal", producer_task_id: AGENT,
        outcome: "settlement_uncertain", reason: "worker_lost",
      });
      assert.deepEqual(publishBoundTerminalEvent({
        store, agentId: hardReclaim.agentId, hardReclaim, completion, env,
      }), { published: false, reason: "not_bound_or_recorded" });
      assert.equal(fs.readFileSync(captured, "utf8").trim().split("\n").length, 1, "no fallback publication");
      assert.equal(JSON.stringify(hardReclaim), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
