import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createAgentStore } from "../../runtime/agent-store.mjs";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
} from "../../runtime/claude-code-driver.mjs";
import { readUnreadCompletionEvents } from "../../runtime/completion-inbox.mjs";
import {
  FUTURE_WRITE_GENERATION,
  PUBLIC_WRITE_GENERATION,
  assertUnderstoodJobRecord,
  isUnderstoodJobRecord,
} from "../../runtime/durable-state-v3.mjs";
import {
  MAX_CONTINUATION_EVIDENCE_BYTES,
  MAX_DRIVER_RECEIPT_BYTES,
  MAX_FAILURE_DETAIL_BYTES,
  MAX_FAILURE_REASON_CHARS,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_OPAQUE_FIELD_DEPTH,
  MAX_PROGRESS_BYTES,
  MAX_RESULT_METADATA_BYTES,
} from "../../runtime/harness-contract.mjs";
import {
  listStoredJobs,
  readJobFile,
  reconcileCompletionEvents,
  writeJobFile,
} from "../../runtime/job-store.mjs";
import {
  V3_JOB_STATUSES,
  listVersionThreeJobRecords,
  markVersionThreeTurnProjected,
  readVersionThreeJobRecord,
  recordVersionThreeTurnRunning,
  recordVersionThreeTurnTerminal,
  recordVersionThreeTurnUncertain,
  reconcileVersionThreeTerminalJobs,
  resolveVersionThreeJobDirectory,
} from "../../runtime/v3-job-store.mjs";
import { versionThreeCapabilities, versionThreeRoute } from "./fixtures/version-three-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-v3-job-store-"));
const workspaceRoot = path.join(root, "workspace");
fs.mkdirSync(workspaceRoot);
process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");

// `maxRetries` because a contending child may still be releasing a lock file
// as the tree is removed; teardown is not the thing under test.
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const contenderFixture = fileURLToPath(
  new URL("./fixtures/v3-job-store-contender.mjs", import.meta.url)
);

/** Run one contending process against the same durable store, concurrently. */
function runContender(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [contenderFixture, mode, JSON.stringify(payload)], {
      env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`contender ${mode} exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout || "[]"));
    });
  });
}

let sequence = 0;

function nativeTurnRef(route, overrides = {}) {
  return {
    version: 1,
    harnessId: route.harnessId,
    driverVersion: route.driverVersion,
    instanceKey: route.instanceKey,
    locatorVersion: 1,
    locator: { sessionId: "service-session-1", turnId: "service-turn-1" },
    ...overrides,
  };
}

function normalizedTerminalResult(route, turnRef, overrides = {}) {
  return {
    harnessId: route.harnessId,
    driverVersion: route.driverVersion,
    contractVersion: 2,
    instanceKey: route.instanceKey,
    nativeTurnRef: turnRef,
    status: "completed",
    nativeTurn: "terminal",
    executionWorld: { continuity: "preserved", settlement: "settled" },
    continuation: { mode: "fresh_only", evidence: { source: "test" } },
    failure: { class: null, reason: null, detail: null, resumable: false, requiresAttention: false },
    finalMessage: "done",
    ...overrides,
  };
}

function setup(options = {}) {
  sequence += 1;
  const ownerRootId = `root-v3-job-${sequence}`;
  const jobId = `job-v3-job-${sequence}`;
  const attemptId = `attempt-v3-job-${sequence}`;
  const route = versionThreeRoute({
    instanceKey: `tenant-job-${sequence}`,
    capabilities: versionThreeCapabilities(),
  });
  const turnRef = nativeTurnRef(route);
  const store = createAgentStore({
    cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION,
  });
  const agent = store.createAgent({ task_name: `v3_job_${sequence}`, route, initialMessage: "prompt" });
  if (options.activate !== false) {
    const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
    assert.ok(reservation.reserved);
  }
  const identity = { ownerRootId, agentId: agent.agentId, jobId };
  return {
    ...identity,
    attemptId,
    route,
    turnRef,
    store,
    identity,
    terminalJob: (overrides = {}) => ({
      id: jobId,
      agentId: agent.agentId,
      ownerRootId,
      harnessStateVersion: 3,
      attemptId,
      route,
      harnessId: route.harnessId,
      harnessInstanceKey: route.instanceKey,
      driverVersion: route.driverVersion,
      nativeTurnRef: turnRef,
      status: "completed",
      completedAt: new Date().toISOString(),
      summary: "done",
      result: { rawOutput: "done", failureClass: null, metrics: null },
      recoverability: { resumable: false, mode: "blocked", reason: "driver_continuation_not_exact_resume" },
      resumability: { classification: "not_resumable", blockingReason: "driver_continuation_not_exact_resume" },
      normalizedTerminalResult: normalizedTerminalResult(route, turnRef),
      ...overrides,
    }),
    running: () => recordVersionThreeTurnRunning({
      generation: FUTURE_WRITE_GENERATION,
      ...identity,
      attemptId,
      workspaceRoot,
      route,
      nativeTurnRef: turnRef,
    }),
    record: () => readVersionThreeJobRecord(identity),
    events: () => readUnreadCompletionEvents(workspaceRoot, ownerRootId).events,
  };
}

describe("version-three job store: durable lifecycle", () => {
  it("creates a running record and is idempotent for the same attempt", () => {
    const context = setup();
    const first = context.running();
    assert.equal(first.status, "running");
    assert.equal(first.harnessStateVersion, 3);
    assert.equal(first.terminalJob, null);
    assert.equal(first.uncertainty, null);

    const second = context.running();
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.status, "running");
    assert.deepEqual(V3_JOB_STATUSES, ["running", "unknown", "completed", "failed", "interrupted"]);
  });

  it("moves running to unknown with an exact reason, and only a proven terminal moves it onward", () => {
    const context = setup();
    context.running();
    const uncertain = recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      reason: "driver_result_rejected",
      detail: "service connection lost",
    });
    assert.equal(uncertain.status, "unknown");
    assert.equal(uncertain.uncertainty.reason, "driver_result_rejected");
    // Free-form exception text is operator-only and never becomes durable
    // uncertainty state. A closed platform code may be retained, but this
    // message carries no such code, so the honest durable value is null.
    assert.equal(uncertain.uncertainty.detail, null);
    assert.ok(uncertain.uncertainty.recordedAt);

    // `unknown -> terminal` with evidence that is not publishable stays
    // refused: only Task 5.6's coherent, publishable, exact-turn-matching
    // Driver observation may move an unknown record forward, never a bare
    // status claim.
    assert.throws(
      () => recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        terminalJob: context.terminalJob({
          normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, {
            executionWorld: { continuity: "preserved", settlement: "active" },
          }),
        }),
      }),
      (error) => error.code === "not_publishable"
    );
    assert.equal(context.record().status, "unknown");

    // `unknown -> terminal` from proven publishable evidence is Task 5.6's
    // exact proof: `runtime/v3-turn-reconciliation.mjs` is this generation's
    // one caller for that transition, using this same durable primitive.
    const settled = recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });
    assert.equal(settled.status, "completed");
    assert.equal(settled.uncertainty, null);
    assert.equal(context.record().status, "completed");
  });

  it("refuses a terminal record whose evidence is not publishable", () => {
    const context = setup();
    context.running();
    assert.throws(
      () => recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        terminalJob: context.terminalJob({
          normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, {
            executionWorld: { continuity: "preserved", settlement: "unknown" },
          }),
        }),
      }),
      (error) => error.code === "not_publishable"
    );
    assert.equal(context.record().status, "running");
  });

  it("refuses a foreign attempt, an uncreated record, and a terminal regression", () => {
    const context = setup();
    context.running();
    assert.throws(
      () => recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: "attempt-somebody-else",
        terminalJob: context.terminalJob(),
      }),
      (error) => error.code === "wrong_attempt"
    );

    const other = setup();
    assert.throws(
      () => recordVersionThreeTurnUncertain({
        generation: FUTURE_WRITE_GENERATION,
        ...other.identity,
        attemptId: other.attemptId,
        reason: "aborted",
      }),
      (error) => error.code === "not_found"
    );

    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });
    // A settled turn is not made uncertain by a later failure.
    const afterUncertain = recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      reason: "disposal_failed",
    });
    assert.equal(afterUncertain.status, "completed");
    assert.equal(afterUncertain.uncertainty, null);
  });

  it("accepts only byte-identical terminal facts and checks attempt identity before terminal no-ops", () => {
    const context = setup();
    context.running();
    const terminal = context.terminalJob();
    const first = recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: terminal,
    });
    assert.equal(first.status, "completed");

    // The exact same terminal fact is idempotent, including after projection
    // marks have been written by the reconciliation path.
    const second = recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: structuredClone(terminal),
    });
    assert.deepEqual(second.terminalJob, first.terminalJob);

    assert.throws(
      () => recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        terminalJob: context.terminalJob({ summary: "a different fact" }),
      }),
      (error) => error.code === "conflicting_terminal"
    );
    assert.deepEqual(context.record().terminalJob, first.terminalJob);

    assert.throws(
      () => recordVersionThreeTurnUncertain({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: "foreign-attempt",
        reason: "should_not_be_read_first",
        detail: "/private/operator/path",
      }),
      (error) => error.code === "wrong_attempt"
    );
    assert.deepEqual(context.record().terminalJob, first.terminalJob);
  });

  it("retains only a closed platform detail code and drops paths or free text", () => {
    const context = setup();
    context.running();
    const uncertain = recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      reason: "driver_result_rejected",
      detail: "/srv/private/service-secret: connection reset",
    });
    assert.equal(uncertain.uncertainty.detail, null);

    const other = setup();
    other.running();
    const coded = recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...other.identity,
      attemptId: other.attemptId,
      reason: "driver_result_rejected",
      detail: "ECONNRESET",
    });
    assert.equal(coded.uncertainty.detail, "ECONNRESET");
  });

  it("is writable only by the internal future generation", () => {
    const context = setup();
    assert.throws(
      () => recordVersionThreeTurnRunning({
        generation: PUBLIC_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        workspaceRoot,
        route: context.route,
        nativeTurnRef: context.turnRef,
      }),
      /cannot be written by the public_seven_operation generation/
    );
    assert.equal(context.record(), null);
  });

  it("refuses a record whose native turn reference belongs to another route", () => {
    const context = setup();
    assert.throws(
      () => recordVersionThreeTurnRunning({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        workspaceRoot,
        route: context.route,
        nativeTurnRef: nativeTurnRef(context.route, { instanceKey: "tenant-somewhere-else" }),
      }),
      /does not belong to its own route/
    );
  });

  it("fails closed on a corrupt record instead of repairing or ignoring it", () => {
    const context = setup();
    context.running();
    const directory = resolveVersionThreeJobDirectory({ ownerRootId: context.ownerRootId });
    const file = fs.readdirSync(directory).find((entry) => entry.endsWith(".json") && entry !== ".lock");
    fs.writeFileSync(path.join(directory, file), "{ not json");
    assert.throws(() => context.record(), (error) => error.code === "corrupt_record");
    // A corrupt sibling is reported, never allowed to hide healthy records.
    const listed = listVersionThreeJobRecords({ ownerRootId: context.ownerRootId });
    assert.deepEqual(listed.records, []);
    assert.deepEqual(listed.unreadable, [{ code: "corrupt_record" }]);
  });

  it("reads stored schema-v2 jobs without upgrading them but refuses schema-v2 creation", () => {
    const downgradeStoredRoute = (context, { terminal = false } = {}) => {
      const directory = resolveVersionThreeJobDirectory({ ownerRootId: context.ownerRootId });
      const file = fs.readdirSync(directory).find((entry) => entry.endsWith(".json"));
      const filePath = path.join(directory, file);
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const { provenance: _provenance, ...capabilities } = stored.route.capabilities;
      const route = {
        ...stored.route,
        capabilitySchemaVersion: 2,
        capabilities: { ...capabilities, capabilitySchemaVersion: 2 },
      };
      stored.route = route;
      if (terminal) stored.terminalJob.route = route;
      fs.writeFileSync(filePath, JSON.stringify(stored));
      return route;
    };

    const uncertain = setup();
    uncertain.running();
    recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...uncertain.identity,
      attemptId: uncertain.attemptId,
      reason: "driver_result_rejected",
    });
    const historicalRoute = downgradeStoredRoute(uncertain);
    assert.equal(uncertain.record().route.capabilitySchemaVersion, 2);

    const terminal = setup();
    terminal.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...terminal.identity,
      attemptId: terminal.attemptId,
      terminalJob: terminal.terminalJob(),
    });
    downgradeStoredRoute(terminal, { terminal: true });
    assert.equal(terminal.record().route.capabilitySchemaVersion, 2);

    const fresh = setup();
    assert.throws(
      () => recordVersionThreeTurnRunning({
        generation: FUTURE_WRITE_GENERATION,
        ...fresh.identity,
        attemptId: fresh.attemptId,
        workspaceRoot,
        route: historicalRoute,
        nativeTurnRef: nativeTurnRef(historicalRoute),
      }),
      /capability schema version/,
    );
  });
});

describe("version-three job store: separation from the public queue", () => {
  it("keeps every version-three record out of the public job queue", () => {
    const context = setup();
    context.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });

    // The public store has no idea this turn exists, so none of its queue,
    // reaping, retention, or reconciliation paths can touch it.
    assert.deepEqual(listStoredJobs(workspaceRoot), []);
    assert.equal(readJobFile(workspaceRoot, context.jobId), null);
    assert.deepEqual(reconcileCompletionEvents(workspaceRoot), []);
  });

  it("leaves the UNDERSTOOD gate refusing version three in the public store", () => {
    const context = setup();
    // A version-three record that does appear in the public store is still
    // refused by every public write path, exactly as before.
    const id = `public-v3-${sequence}`;
    writeJobFile(workspaceRoot, id, { id, harnessStateVersion: 3, status: "running" });
    assert.equal(isUnderstoodJobRecord(readJobFile(workspaceRoot, id)), false);
    assert.throws(
      () => assertUnderstoodJobRecord(readJobFile(workspaceRoot, id), "own"),
      /carries durable state version 3; this runtime owns 1, 2/
    );
    assert.throws(
      () => writeJobFile(workspaceRoot, id, { id, harnessStateVersion: 3, status: "completed" }),
      /carries durable state version 3; this runtime owns 1, 2/
    );
    assert.equal(context.record(), null);
  });
});

describe("version-three job store: internal reconciliation", () => {
  it("finishes an unpublished terminal record exactly once", () => {
    const context = setup();
    context.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });
    assert.equal(context.events().length, 0);

    const first = reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION });
    assert.deepEqual(
      first.receipts.map((receipt) => [receipt.jobId, receipt.reconciled, receipt.agentProjected, receipt.completionPublished]),
      [[context.jobId, true, true, true]]
    );
    assert.equal(context.events().length, 1);
    assert.equal(context.store.readAgent(context.agentId).status, "completed");

    // Idempotent: nothing left to do, and no duplicate event.
    assert.deepEqual(reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION }).receipts, []);
    assert.equal(context.events().length, 1);
  });

  it("finishes a completion whose Agent projection already landed", () => {
    const context = setup();
    context.running();
    const terminalJob = context.terminalJob();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob,
    });
    context.store.finalizeFromJob(terminalJob);
    markVersionThreeTurnProjected({
      generation: FUTURE_WRITE_GENERATION, ...context.identity, agentProjected: true,
    });

    const receipts = reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION }).receipts;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].reconciled, true);
    assert.equal(context.events().length, 1);
    assert.ok(context.record().completionPublishedAt);
  });

  it("never reconciles a running or uncertain record into a completion", () => {
    const running = setup();
    running.running();
    const uncertain = setup();
    uncertain.running();
    recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...uncertain.identity,
      attemptId: uncertain.attemptId,
      reason: "aborted",
    });

    assert.deepEqual(reconcileVersionThreeTerminalJobs({ ownerRootId: running.ownerRootId, generation: FUTURE_WRITE_GENERATION }).receipts, []);
    assert.deepEqual(reconcileVersionThreeTerminalJobs({ ownerRootId: uncertain.ownerRootId, generation: FUTURE_WRITE_GENERATION }).receipts, []);
    assert.equal(running.events().length, 0);
    assert.equal(uncertain.events().length, 0);
    assert.equal(running.store.readAgent(running.agentId).status, "running");
  });

  it("refuses reconciliation from the public generation", () => {
    const context = setup();
    assert.throws(
      () => reconcileVersionThreeTerminalJobs({
        ownerRootId: context.ownerRootId,
        generation: PUBLIC_WRITE_GENERATION,
      }),
      /cannot be written by the public_seven_operation generation/
    );
  });

  it("requires the write generation to be stated, never defaulted", () => {
    // Reconciliation writes Agent and completion state. Defaulting it to the
    // privileged generation would hand that authority to any caller that
    // simply omitted the argument.
    const context = setup();
    context.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });
    assert.throws(
      () => reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId }),
      /version-three creation requires the internal_future_generation write generation/
    );
    assert.equal(context.events().length, 0);
    assert.equal(context.record().completionPublishedAt, null);
  });
});

describe("version-three job store: durable capacity covers the whole contract", () => {
  /**
   * One normalized terminal result at every bound the contract admits at once.
   * Persistence happens after lease release, so a valid Driver result this
   * record could not hold would strand a proven completion with its leases
   * already gone.
   */
  function maximalResult(context, { fill, chars }) {
    const filler = fill.repeat(Math.ceil(chars / fill.length)).slice(0, chars);
    return normalizedTerminalResult(context.route, context.turnRef, {
      status: "failed",
      finalMessage: filler,
      finalMessageAbsenceReason: null,
      failure: {
        class: "harness_internal",
        reason: "r".repeat(MAX_FAILURE_REASON_CHARS),
        detail: { note: "d".repeat(MAX_FAILURE_DETAIL_BYTES - 64) },
        resumable: false,
        requiresAttention: false,
      },
      progress: { blob: "p".repeat(MAX_PROGRESS_BYTES - 64) },
      resultMetadata: { blob: "m".repeat(MAX_RESULT_METADATA_BYTES - 64) },
      driverReceipt: {
        harnessId: context.route.harnessId,
        driverVersion: context.route.driverVersion,
        receipt: { blob: "k".repeat(MAX_DRIVER_RECEIPT_BYTES - 256) },
      },
      continuation: {
        mode: "fresh_only",
        evidence: { blob: "e".repeat(MAX_CONTINUATION_EVIDENCE_BYTES - 64) },
      },
    });
  }

  for (const [name, fill] of [
    ["maximum ASCII", "x"],
    ["maximum four-byte UTF-8", "\u{1F600}"],
    ["maximum escaped control characters", "\u0001"],
  ]) {
    it(`stores a terminal projection carrying a ${name} final message`, () => {
      const context = setup();
      context.running();
      const result = maximalResult(context, { fill, chars: MAX_FINAL_MESSAGE_CHARS });
      assert.equal(result.finalMessage.length, MAX_FINAL_MESSAGE_CHARS);

      const record = recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        terminalJob: context.terminalJob({
          status: "failed",
          summary: "bounded summary",
          result: { failureClass: "harness_internal", metrics: null },
          normalizedTerminalResult: result,
        }),
      });

      assert.equal(record.status, "failed");
      // The complete message survives, byte for byte, in its one durable home.
      assert.equal(
        record.terminalJob.normalizedTerminalResult.finalMessage,
        result.finalMessage
      );
      // ...and the record read back off disk agrees.
      assert.equal(
        context.record().terminalJob.normalizedTerminalResult.finalMessage.length,
        MAX_FINAL_MESSAGE_CHARS
      );
    });
  }

  it("stores a projection whose opaque field is nested as deeply as the contract admits", () => {
    const context = setup();
    context.running();
    let nested = { leaf: true };
    // `canonicalBoundedOpaqueField()` admits `MAX_OPAQUE_FIELD_DEPTH` levels
    // below the field itself; the projection then wraps that field twice more.
    for (let level = 0; level < MAX_OPAQUE_FIELD_DEPTH - 1; level += 1) {
      nested = { level, nested };
    }
    const record = recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob({
        normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, {
          progress: nested,
        }),
      }),
    });
    assert.equal(record.status, "completed");
    assert.ok(context.record().terminalJob.normalizedTerminalResult.progress);
  });

  it("still refuses a projection past the derived bound", () => {
    const context = setup();
    context.running();
    assert.throws(
      () => recordVersionThreeTurnTerminal({
        generation: FUTURE_WRITE_GENERATION,
        ...context.identity,
        attemptId: context.attemptId,
        terminalJob: context.terminalJob({
          normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, {
            // Well past every admitted bound: the cap is derived, not removed.
            finalMessage: "x".repeat(MAX_FINAL_MESSAGE_CHARS * 8),
          }),
        }),
      }),
      /exceeds \d+ bytes/
    );
    assert.equal(context.record().status, "running");
  });
});

describe("version-three job store: cross-process lock discipline", () => {
  it("keeps a settled record settled while other processes write to it concurrently", async () => {
    const context = setup();
    context.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });

    const payload = {
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      attemptId: context.attemptId,
      generation: FUTURE_WRITE_GENERATION,
      windowMs: 2_000,
      maxAttempts: 300,
      stopOnTerminal: false,
    };
    // Two separate processes contend for this record's directory lock: one
    // attempting the exact transition that would overwrite proven terminal
    // evidence with uncertainty if the lock ever leaked, one reading. Nothing
    // inside a single process can prove that lock holds.
    const contenders = Promise.all([
      runContender("uncertain", payload),
      runContender("read", payload),
    ]);

    // Meanwhile this process performs its own read-modify-writes on the same
    // record, so the contention straddles real concurrent persistence rather
    // than a quiet file.
    const deadline = Date.now() + 1_500;
    let localWrites = 0;
    while (Date.now() < deadline) {
      markVersionThreeTurnProjected({
        generation: FUTURE_WRITE_GENERATION, ...context.identity, agentProjected: true,
      });
      localWrites += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [uncertainAttempts, readAttempts] = await contenders;

    assert.ok(localWrites > 0, "this process must have written during the race");
    assert.ok(uncertainAttempts.length > 0, "the uncertainty contender must have run");
    assert.ok(readAttempts.length > 0, "the reading contender must have run");

    // Every contending uncertainty write observed the settled record and left
    // it alone; none of them saw or produced `unknown`.
    for (const attempt of uncertainAttempts) {
      assert.equal(attempt.ok, true, `unexpected write failure: ${attempt.code}`);
      assert.equal(attempt.status, "completed");
    }
    // Every observation is a valid record; a torn or half-written file would
    // have surfaced as a read failure, and no read ever saw a regression.
    for (const attempt of readAttempts) {
      assert.equal(attempt.ok, true, `unexpected read failure: ${attempt.code}`);
      assert.equal(attempt.status, "completed");
    }
    assert.equal(context.record().status, "completed");
    assert.equal(context.record().uncertainty, null);
    assert.ok(context.record().agentProjectionReconciledAt);
  });
});

describe("version-three mailbox recovery is a version-three transition only", () => {
  it("refuses quiesce, requeue, and pin for a legacy Agent record", () => {
    const legacyOwner = `root-legacy-${Date.now()}`;
    // A version-two Agent, created the way the current public generation does.
    const legacyStore = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId: legacyOwner,
      writeGeneration: PUBLIC_WRITE_GENERATION,
      harness: {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        driverVersion: CLAUDE_CODE_DRIVER_VERSION,
        capabilities: CLAUDE_CODE_CAPABILITIES,
      },
    });
    const legacy = legacyStore.createAgent({ task_name: "legacy_agent", initialMessage: "prompt" });
    legacyStore.reserveActivation(legacy.agentId, "job-legacy-1", { initial: true });
    const message = legacyStore.listMessages(legacy.agentId)[0];

    // A version-one/two record's undelivered-message recovery has its own
    // owner in the current generation; two writers for one fact is the bug.
    for (const call of [
      () => legacyStore.quiesceVersionThreeTurn(legacy.agentId, "job-legacy-1", { attemptId: "attempt-legacy" }),
      () => legacyStore.requeueUndeliveredMessage(legacy.agentId, message.messageId, {
        jobId: "job-legacy-1", reason: "driver_rejected_active_input",
      }),
      () => legacyStore.pinUndeliveredMessage(legacy.agentId, message.messageId, {
        jobId: "job-legacy-1", reason: "driver_delivery_failed",
      }),
    ]) {
      assert.throws(call, /is not a version-three record/);
    }
    // The legacy mailbox is exactly as it was.
    assert.equal(legacyStore.listMessages(legacy.agentId)[0].state, message.state);
    assert.equal(legacyStore.readAgent(legacy.agentId).activeJobId, "job-legacy-1");
  });

  it("refuses every version-three mailbox transition from the public generation", () => {
    const context = setup();
    const publicStore = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId: context.ownerRootId,
      writeGeneration: PUBLIC_WRITE_GENERATION,
    });
    assert.throws(
      () => publicStore.quiesceVersionThreeTurn(context.agentId, context.jobId, { attemptId: context.attemptId }),
      /cannot be written by the public_seven_operation generation/
    );
  });
});

// ---------------------------------------------------------------------------
// Section 5 defense: a terminal projection is the only thing the Agent
// projection and the completion event are built from, and nothing downstream
// re-derives its identity. So the store binds it to the record it settles.
// ---------------------------------------------------------------------------

describe("version-three job store: every terminal projection is bound to its own record", () => {
  it("refuses a forged projection that renames any identity its record owns", () => {
    const context = setup();
    context.running();
    const foreignTurnRef = nativeTurnRef(context.route, {
      locator: { sessionId: "service-session-1", turnId: "service-turn-forged" },
    });

    const forgeries = [
      ["another owner root", { ownerRootId: `${context.ownerRootId}-somebody-else` }],
      ["another Agent", { agentId: `${context.agentId}-somebody-else` }],
      ["another job", { id: `${context.jobId}-somebody-else` }],
      ["another attempt", { attemptId: "attempt-somebody-else" }],
      ["another durable state version", { harnessStateVersion: 2 }],
      ["another route", { route: { ...context.route, model: "forged-model" } }],
      ["another Harness", { harnessId: "forged-harness" }],
      ["another logical instance", { harnessInstanceKey: "tenant-forged" }],
      ["another Driver version", { driverVersion: "forged-service@9" }],
      ["another native turn", { nativeTurnRef: foreignTurnRef }],
      ["terminal evidence naming another native turn", {
        normalizedTerminalResult: normalizedTerminalResult(context.route, foreignTurnRef),
      }],
      ["terminal evidence declaring another status", {
        normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, { status: "failed" }),
      }],
      ["terminal evidence belonging to another Harness", {
        normalizedTerminalResult: normalizedTerminalResult(context.route, context.turnRef, { harnessId: "forged-harness" }),
      }],
      ["no terminal evidence at all", { normalizedTerminalResult: null }],
    ];

    for (const [label, overrides] of forgeries) {
      assert.throws(
        () => recordVersionThreeTurnTerminal({
          generation: FUTURE_WRITE_GENERATION,
          ...context.identity,
          attemptId: context.attemptId,
          terminalJob: context.terminalJob(overrides),
        }),
        (error) => error.code === "projection_not_bound",
        `a projection naming ${label} must never persist`,
      );
      assert.equal(context.record().status, "running", `${label} left the record untouched`);
      assert.equal(context.events().length, 0, `${label} published nothing`);
    }
  });

  it("still accepts a projection whose locator states the same values in another key order", () => {
    const context = setup();
    context.running();
    const reordered = {
      ...context.turnRef,
      locator: Object.fromEntries(Object.entries(context.turnRef.locator).reverse()),
    };
    const settled = recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob({
        nativeTurnRef: reordered,
        normalizedTerminalResult: normalizedTerminalResult(context.route, reordered),
      }),
    });
    assert.equal(settled.status, "completed");
    assert.equal(settled.terminalJob.nativeTurnRef.locator.turnId, context.turnRef.locator.turnId);
  });

  it("never reads, projects, or publishes a terminal record whose projection was forged on disk", () => {
    const context = setup();
    context.running();
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      attemptId: context.attemptId,
      terminalJob: context.terminalJob(),
    });

    const directory = resolveVersionThreeJobDirectory(context.identity);
    const [fileName] = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"));
    const filePath = path.join(directory, fileName);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    stored.terminalJob.ownerRootId = `${context.ownerRootId}-somebody-else`;
    fs.writeFileSync(filePath, JSON.stringify(stored));

    assert.throws(() => readVersionThreeJobRecord(context.identity), (error) => error.code === "projection_not_bound");
    const listed = listVersionThreeJobRecords({ ownerRootId: context.ownerRootId });
    assert.deepEqual(listed.records, []);
    assert.deepEqual(listed.unreadable, [{ code: "projection_not_bound" }]);

    const reconciliation = reconcileVersionThreeTerminalJobs({
      ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION,
    });
    assert.deepEqual(reconciliation.receipts, []);
    assert.equal(context.events().length, 0, "a forged projection is never published");
  });
});
