/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 5.6 -- worker-loss integration tests for the version-three control
 * plane.
 *
 * `runtime/v3-worker-loop.mjs` (Task 5.4) already proves that a worker which
 * loses certainty durably records `unknown`, holds every lease, and leaves
 * the control stream open. What none of the accepted work proves is what
 * happens *after* the worker that owned a turn is gone for good: whether a
 * fresh process, holding nothing but the durable native-turn reference and
 * the Driver's optional `turnObservation` capability, may safely move that
 * turn forward -- exactly once -- or must leave it exactly as it was.
 *
 * These tests exercise real durable state (a real Agent store, real launch
 * claims, real instance leases, a real version-three job record, a real
 * completion inbox) and two genuinely independent boundaries: the worker
 * that (durably or actually) disappears, and the reconciler that later
 * observes evidence about it. `tests/runtime/fixtures/v3-worker-process.mjs`
 * is a real, separate OS process for the two launch-time scenarios, so "the
 * worker vanished" is an actual process death, not an abandoned Promise.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { createAgentStore, resolveAgentRegistryDirectory } from "../../runtime/agent-store.mjs";
import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { readUnreadCompletionEvents, resolveCompletionInboxFile } from "../../runtime/completion-inbox.mjs";
import { FUTURE_WRITE_GENERATION, PUBLIC_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import {
  DRIVER_CONTRACT_VERSION_V2,
  boundedDriverReceipt,
  validateNormalizedTerminalResult,
} from "../../runtime/harness-contract.mjs";
import {
  acquireInstanceLease,
  acquireNativeSessionLease,
  inspectLeaseInventory,
  releaseLeasesOnSettlement,
} from "../../runtime/instance-admission-lease.mjs";
import { acquireWorkspaceWriterLease } from "../../runtime/workspace-writer-lease.mjs";
import {
  beginPreSubmissionRollback,
  createLaunchClaim,
  launchClaimRollbackEligibility,
  readLaunchClaim,
  resolveLaunchClaimDirectory,
} from "../../runtime/launch-claim.mjs";
import { launchVersionThreeTurn } from "../../runtime/v3-worker-launch.mjs";
import {
  PRE_SUBMISSION_RECONCILIATION_AGE_MS,
  rollbackPreparedVersionThreeTurn,
} from "../../runtime/v3-worker-entry.mjs";
import { buildLeaseReleaseTargets, runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";
import {
  readVersionThreeJobRecord,
  resolveVersionThreeJobDirectory,
} from "../../runtime/v3-job-store.mjs";
import {
  enqueueControlCommand,
  listControlCommands,
  readControlStreamClosure,
} from "../../runtime/turn-control.mjs";
import {
  DEFAULT_OBSERVATION_DEADLINE_MS,
  reconcileVersionThreeWorkerLoss,
} from "../../runtime/v3-turn-reconciliation.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { versionThreeCapabilities, versionThreeRoute } from "./fixtures/version-three-state.mjs";

const workerProcessFixture = fileURLToPath(new URL("./fixtures/v3-worker-process.mjs", import.meta.url));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-v3-reconciliation-"));
const workspaceRoot = path.join(root, "workspace");
fs.mkdirSync(workspaceRoot);
process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");

after(() => fs.rmSync(root, { recursive: true, force: true }));

let sequence = 0;

const PROMPT = "Inspect only.\n\nReturn one bounded finding.";

async function untilTrue(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/**
 * Spawn a real child process from `v3-worker-process.mjs`, wait for its exact
 * `READY` checkpoint (and an optional `IDENTITY` line reporting the Agent ID
 * it durably created), then `SIGKILL` it. Nothing about *when* to kill it is
 * timer-guessed: the child only ever reports readiness once the durable
 * state this test asserts on is actually in place.
 */
function killAtCheckpoint(mode, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerProcessFixture, mode, JSON.stringify(payload)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let agentId = null;
    let stderr = "";
    let settled = false;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (line.startsWith("IDENTITY:")) {
        agentId = JSON.parse(line.slice("IDENTITY:".length)).agentId;
        return;
      }
      if (line.startsWith("READY:") || line === "READY:{}") {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      rl.close();
      if (!settled) {
        reject(new Error(`worker process exited before READY (code=${code}, signal=${signal}): ${stderr}`));
        return;
      }
      resolve({ agentId, signal });
    });
  });
}

/**
 * Spawn the same real child process, but leave it alive: the parent waits for
 * its exact `READY` checkpoint and then races its own reconciliation against
 * the child's own live settlement. Nothing is killed here -- this is the
 * genuine two-process convergence case, not worker loss.
 */
function spawnWorkerProcess(mode, payload) {
  const child = spawn(process.execPath, [workerProcessFixture, mode, JSON.stringify(payload)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let agentId = null;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.startsWith("IDENTITY:")) {
      agentId = JSON.parse(line.slice("IDENTITY:".length)).agentId;
      return;
    }
    if (line.startsWith("READY:")) resolveReady(agentId);
  });
  child.on("error", rejectReady);
  const exit = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      rl.close();
      rejectReady(new Error(`worker process exited before READY (code=${code}, signal=${signal}): ${stderr}`));
      resolve({ code, signal, stderr });
    });
  });
  return { ready, exit, child };
}

/**
 * One turn wired through real production persistence, stopped short of ever
 * calling `runVersionThreeWorkerLoop()` -- callers drive the worker/observer
 * boundary explicitly.
 */
function setup(options = {}) {
  sequence += 1;
  const ownerRootId = `root-v3-recon-${sequence}`;
  const jobId = `job-v3-recon-${sequence}`;
  const attemptId = `attempt-v3-recon-${sequence}`;
  const instanceKey = `tenant-recon-${sequence}`;
  const capabilities = versionThreeCapabilities(options.capabilities ?? {});
  const route = versionThreeRoute({
    instanceKey,
    capabilities,
    // A canonical-workspace writer lease is only admitted for a route that
    // actually carries behavioral write authority.
    ...(options.authority ? { authority: options.authority } : {}),
  });

  const store = createAgentStore({ cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
  const agent = store.createAgent({ task_name: `v3_recon_${sequence}`, route, initialMessage: PROMPT });
  const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
  assert.ok(reservation.reserved, "version-three activation reservation failed");

  const fixture = createFakeServiceDriver({
    autoComplete: false,
    observable: options.observable ?? true,
    instances: [{ instanceKey, readiness: "ready", detailCode: "ready" }],
    capabilities: options.capabilities,
  });

  const lease = acquireInstanceLease({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    route,
    harnessId: route.harnessId,
    instanceKey: route.instanceKey,
    capacityClass: "fake-service-recon",
    capacityLimit: 1,
  });

  // Every lease kind this runtime admits, not just the instance lease the
  // other cases exercise: settlement must release all three together.
  const nativeSessionId = `session-recon-${sequence}`;
  const leaseBindings = [lease];
  if (options.allLeaseKinds) {
    leaseBindings.push(acquireWorkspaceWriterLease({
      ownerRootId, agentId: agent.agentId, jobId, route, workspaceRoot: options.workspaceRoot ?? workspaceRoot,
    }));
    leaseBindings.push(acquireNativeSessionLease({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      nativeSessionId,
    }));
  }

  const preparedTurn = fixture.driver.prepareTurn({ route, taskInput: PROMPT });
  const identity = { ownerRootId, agentId: agent.agentId, jobId };
  const assignedMessageIds = reservation.assignedMessages.map((message) => message.messageId);
  createLaunchClaim({
    ...identity,
    attemptId,
    route,
    leaseBindings,
    assignedMessageIds,
    preparedInput: PROMPT,
    turnOptions: null,
  });

  return {
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route,
    store,
    fixture,
    identity,
    input: {
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId,
      route,
      driver: fixture.driver,
      preparedTurn,
      preparedInput: PROMPT,
      assignedMessageIds,
      assignedInputs: [],
      leaseBindings,
      // Stated explicitly: this fixture's Driver owns no turn options.
      turnOptions: null,
      workspaceRoot,
      env: {},
      cwd: workspaceRoot,
    },
    agent: () => store.readAgent(agent.agentId),
    events: () => readUnreadCompletionEvents(workspaceRoot, ownerRootId).events,
    commands: () => listControlCommands(identity),
    v3Record: () => readVersionThreeJobRecord(identity),
    turnId: () => fixture.control.turnIds()[0] ?? null,
    leaseHeld: () => probeLeaseHeld(() => acquireInstanceLease({
      ownerRootId: `${ownerRootId}-probe`,
      agentId: `${agent.agentId}-probe`,
      jobId: `${jobId}-probe`,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: "fake-service-recon",
      capacityLimit: 1,
    })),
    writerLeaseHeld: () => probeLeaseHeld(() => acquireWorkspaceWriterLease({
      ownerRootId: `${ownerRootId}-probe`,
      agentId: `${agent.agentId}-probe`,
      jobId: `${jobId}-probe`,
      route,
      workspaceRoot: options.workspaceRoot ?? workspaceRoot,
    })),
    nativeSessionLeaseHeld: () => probeLeaseHeld(() => acquireNativeSessionLease({
      ownerRootId: `${ownerRootId}-probe`,
      agentId: `${agent.agentId}-probe`,
      jobId: `${jobId}-probe`,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      nativeSessionId,
    })),
  };
}

/** Whether one lease key is still held: a probe acquisition of a full key throws. */
function probeLeaseHeld(acquire) {
  try {
    acquire();
    return false;
  } catch (error) {
    if (/capacity exhausted/.test(error.message)) return true;
    throw error;
  }
}

/**
 * Drive one turn to the accepted 5.4 unknown exit: the worker durably
 * accepted a native turn, then lost certainty and left every lease held.
 */
async function loseTurn(context) {
  const controller = new AbortController();
  const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
  await untilTrue(() => context.turnId() != null);
  controller.abort();
  const lost = await loop;
  assert.equal(lost.status, "unknown");
  return context;
}

/** The one durable version-three record file backing this owner root's job. */
function jobRecordFile(identity) {
  const directory = resolveVersionThreeJobDirectory(identity);
  const entries = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  assert.equal(entries.length, 1, "exactly one durable version-three record for this owner root");
  return path.join(directory, entries[0]);
}

/**
 * Rewrite one durable version-three record in place. This models a corrupted
 * or forged durable fact -- the only way a record can disagree with the
 * launch claim that proved its acceptance -- not an ordinary runtime write.
 */
function tamperJobRecord(identity, mutate) {
  const filePath = jobRecordFile(identity);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(parsed);
  fs.writeFileSync(filePath, JSON.stringify(parsed));
}

/** Wrap a fixture Driver so a test can count and shape its observations. */
function observingDriver(baseDriver, observe) {
  const calls = { count: 0, scopes: [] };
  const driver = {
    ...baseDriver,
    observeTurn: async (ref, scope) => {
      calls.count += 1;
      calls.scopes.push(scope);
      return observe(ref, scope, baseDriver);
    },
  };
  return { driver, calls };
}

function reconcile(context, driver, extra = {}) {
  return reconcileVersionThreeWorkerLoss({
    generation: FUTURE_WRITE_GENERATION,
    ...context.identity,
    driver,
    ...extra,
  });
}

/** A raw, well-formed terminal payload for a native turn this test already durably bound, independent of the fixture instance that originally minted it. */
function rawTerminalResultFor(record, { status = "completed", nativeTurnRef = record.nativeTurnRef } = {}) {
  const route = record.route;
  return {
    harnessId: route.harnessId,
    driverVersion: route.driverVersion,
    contractVersion: DRIVER_CONTRACT_VERSION_V2,
    instanceKey: route.instanceKey,
    nativeTurnRef,
    status,
    nativeTurn: "terminal",
    executionWorld: { continuity: "preserved", settlement: "settled" },
    continuation: { mode: "none", nativeSessionRef: null, evidence: { source: "reconciliation_test" } },
    failure: status === "completed"
      ? { class: null, reason: null, detail: null, resumable: false, requiresAttention: false }
      : { class: "cancelled_or_interrupted", reason: "reconciliation test", detail: null, resumable: false, requiresAttention: false },
    finalMessage: status === "completed" ? "reconciled after worker loss" : null,
    finalMessageAbsenceReason: status === "completed" ? null : "cancelled_or_interrupted",
    progress: { toolUses: [], touchedFiles: [], attempts: [], recoveryAttempts: 0 },
    metrics: null,
    driverReceipt: boundedDriverReceipt(route.harnessId, route.driverVersion, { source: "reconciliation_test" }),
  };
}

describe("version-three worker loss: before native submission (scenario 1)", () => {
  it("finishes an already-owned rollback immediately from the public owning wait path", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-owned-cleanup-${sequence}`,
      jobId: `job-v3-owned-cleanup-${sequence}`,
      attemptId: `attempt-v3-owned-cleanup-${sequence}`,
      instanceKey: `tenant-owned-cleanup-${sequence}`,
      taskName: `v3_owned_cleanup_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-owned-cleanup",
    };
    const { agentId } = await killAtCheckpoint("intent_after_acquire", payload);
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };
    const claim = readLaunchClaim(identity);
    beginPreSubmissionRollback({ ...identity, token: launchClaimRollbackEligibility(claim).token });

    const runtime = createAgentRuntime({
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CODEX_THREAD_ID: payload.ownerRootId,
        CODEX_HARNESSDOCK_RUNTIME_HOME: process.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
      },
    });
    assert.equal((await runtime.waitAgent({ timeout_ms: 0 })).timedOut, true);
    assert.equal(readLaunchClaim(identity).submissionState, "rollback_complete");
  });

  it("cleans a real SIGKILL preparation from the next public owning wait without replay", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-public-cleanup-${sequence}`,
      jobId: `job-v3-public-cleanup-${sequence}`,
      attemptId: `attempt-v3-public-cleanup-${sequence}`,
      instanceKey: `tenant-public-cleanup-${sequence}`,
      taskName: `v3_public_cleanup_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-public-cleanup",
    };
    const { agentId, signal } = await killAtCheckpoint("intent_after_acquire", payload);
    assert.equal(signal, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, PRE_SUBMISSION_RECONCILIATION_AGE_MS + 100));

    const identity = {
      ownerRootId: payload.ownerRootId,
      agentId,
      jobId: payload.jobId,
    };
    assert.equal(readVersionThreeJobRecord(identity), null);
    const runtime = createAgentRuntime({
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CODEX_THREAD_ID: payload.ownerRootId,
        CODEX_HARNESSDOCK_RUNTIME_HOME: process.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
      },
    });
    let driverCalls = 0;
    runtime.jobs.driverForHarness = () => {
      driverCalls += 1;
      throw new Error("pre-submission cleanup must not resolve or replay through a Driver");
    };
    assert.equal((await runtime.waitAgent({ timeout_ms: 0 })).timedOut, true);
    assert.equal(driverCalls, 0);
    assert.equal(readLaunchClaim(identity).submissionState, "rollback_complete");
    assert.equal(
      inspectLeaseInventory().entries.flatMap((entry) => entry.holders)
        .some((holder) => holder.ownerRootId === payload.ownerRootId && holder.jobId === payload.jobId),
      false,
    );
    assert.equal(readVersionThreeJobRecord(identity), null);
  });

  it("restores a noninitial follow-up to queued state and retains the Agent", () => {
    sequence += 1;
    const ownerRootId = `root-v3-followup-${sequence}`;
    const jobId = `job-v3-followup-${sequence}`;
    const attemptId = `attempt-v3-followup-${sequence}`;
    const route = versionThreeRoute({ instanceKey: `tenant-followup-${sequence}` });
    const store = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
    });
    const agent = store.createAgent({ task_name: `v3_followup_${sequence}`, route });
    store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "completed",
      continuation: { mode: "safe_fresh", evidence: { reason: "test_terminal" } },
    }));
    const queued = store.enqueueMessage(agent.agentId, "continue exactly", { kind: "followup_task" });
    const reservation = store.reserveActivation(agent.agentId, jobId);
    assert.equal(reservation.reserved, true);
    const lease = acquireInstanceLease({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: "fake-service-followup",
      capacityLimit: 1,
    });
    createLaunchClaim({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId,
      route,
      leaseBindings: [lease],
      assignedMessageIds: [queued.message.messageId],
      preparedInput: "continue exactly",
      turnOptions: null,
    });

    rollbackPreparedVersionThreeTurn({ cwd: workspaceRoot, ownerRootId, agentId: agent.agentId, jobId, attemptId });
    const retained = store.readAgent(agent.agentId);
    assert.equal(retained.status, "completed");
    assert.equal(retained.activeJobId, null);
    assert.equal(store.listMessages(agent.agentId)[0].state, "queued");
    assert.equal(store.listMessages(agent.agentId)[0].text, "continue exactly");
  });

  for (const mode of ["intent_before_acquire", "intent_after_acquire", "intent_after_binding"]) {
    it(`recovers exact ${mode} state after a real parent SIGKILL without native replay`, async () => {
      sequence += 1;
      const payload = {
        ownerRootId: `root-v3-intent-${sequence}`,
        jobId: `job-v3-intent-${sequence}`,
        attemptId: `attempt-v3-intent-${sequence}`,
        instanceKey: `tenant-intent-${sequence}`,
        taskName: `v3_intent_${sequence}`,
        promptText: PROMPT,
        workspaceRoot,
        capacityClass: "fake-service-intent",
      };
      const { agentId, signal } = await killAtCheckpoint(mode, payload);
      assert.equal(signal, "SIGKILL");
      const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };
      const claim = readLaunchClaim(identity);
      assert.equal(claim.leaseState, mode === "intent_after_binding" ? "acquired" : "intended");
      assert.equal(claim.submissionState, "not_started");
      assert.equal(readVersionThreeJobRecord(identity), null);

      const recovered = rollbackPreparedVersionThreeTurn({
        cwd: workspaceRoot,
        ...identity,
        attemptId: payload.attemptId,
      });
      assert.equal(recovered.submissionState, "rollback_complete");
      const store = createAgentStore({
        cwd: workspaceRoot,
        ownerRootId: payload.ownerRootId,
        writeGeneration: FUTURE_WRITE_GENERATION,
      });
      assert.equal(store.readAgent(agentId), null, "the initial empty reservation is removed by existing proof");
      assert.equal(
        inspectLeaseInventory().entries.flatMap((entry) => entry.holders)
          .some((holder) => holder.ownerRootId === payload.ownerRootId && holder.jobId === payload.jobId),
        false,
      );
    });
  }

  it("releases the exact intended native-session holder after a real SIGKILL in the acquire-to-bind gap", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-session-intent-${sequence}`,
      jobId: `job-v3-session-intent-${sequence}`,
      attemptId: `attempt-v3-session-intent-${sequence}`,
      instanceKey: `tenant-session-intent-${sequence}`,
      nativeSessionId: `native-session-intent-${sequence}`,
      taskName: `v3_session_intent_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "unused-for-native-session",
    };
    const { agentId } = await killAtCheckpoint("intent_after_acquire", payload);
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };
    const claim = readLaunchClaim(identity);
    assert.equal(claim.leaseState, "intended");
    assert.equal(claim.leaseIntent[0].kind, "native_session");
    assert.equal(claim.leaseIntent[0].keyFields.nativeSessionId, payload.nativeSessionId);

    rollbackPreparedVersionThreeTurn({ cwd: workspaceRoot, ...identity, attemptId: payload.attemptId });
    assert.equal(
      inspectLeaseInventory().entries.flatMap((entry) => entry.holders)
        .some((holder) => holder.ownerRootId === payload.ownerRootId && holder.jobId === payload.jobId),
      false,
    );
  });

  it("proves the pre-submission fence, not absence, before a fresh attempt may retry", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-before-${sequence}`,
      jobId: `job-v3-before-${sequence}`,
      attemptId: `attempt-v3-before-${sequence}`,
      instanceKey: `tenant-before-${sequence}`,
      taskName: `v3_before_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-before",
    };
    const { agentId } = await killAtCheckpoint("claim_before_submission", payload);
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };

    const claim = readLaunchClaim(identity);
    assert.ok(claim, "the killed worker durably created its launch claim before it died");
    assert.equal(claim.acceptance, "not_submitted");
    assert.equal(claim.submissionState, "not_started");
    assert.equal(readVersionThreeJobRecord(identity), null, "no native acceptance was ever durable");

    // The safe-to-retry claim comes only from this fact, never from "nothing
    // is running any more".
    const eligibility = launchClaimRollbackEligibility(claim);
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.reason, "not_submitted");

    const route = versionThreeRoute({ instanceKey: payload.instanceKey, capabilities: versionThreeCapabilities() });
    // The durable claim's own `leaseBindings` is a canonicalized snapshot for
    // storage, never brand-checked lease authority: a fresh worker retrying
    // this exact identity re-acquires (idempotently, same durable holder) its
    // own in-process lease evidence, exactly as a real recovering worker
    // would.
    const lease = acquireInstanceLease({
      ...identity,
      jobId: payload.jobId,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: payload.capacityClass,
      capacityLimit: 1,
    });
    const fixture = createFakeServiceDriver({
      instances: [{ instanceKey: payload.instanceKey, readiness: "ready", detailCode: "ready" }],
      autoComplete: true,
    });
    const preparedTurn = fixture.driver.prepareTurn({ route, taskInput: PROMPT });
    const { liveTurn, launchClaim } = await launchVersionThreeTurn({
      ...identity,
      attemptId: claim.attemptId,
      route,
      driver: fixture.driver,
      preparedTurn,
      preparedInput: PROMPT,
      assignedMessageIds: claim.assignedMessageIds,
      leaseBindings: [lease],
      // Stated explicitly: this fixture's Driver owns no turn options.
      turnOptions: null,
      workspaceRoot,
    });
    assert.equal(launchClaim.acceptance, "acceptance_proven");
    // Exactly one native call happened across both processes: the killed
    // worker never reached the Driver at all.
    assert.equal(fixture.control.service.prompts.length, 1);
    await liveTurn.dispose();
  });
});

describe("version-three worker loss: during native submission (scenario 2)", () => {
  it("never automatically replays ambiguous acceptance and makes no second native call", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-during-${sequence}`,
      jobId: `job-v3-during-${sequence}`,
      attemptId: `attempt-v3-during-${sequence}`,
      instanceKey: `tenant-during-${sequence}`,
      taskName: `v3_during_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-during",
    };
    const { agentId } = await killAtCheckpoint("hang_during_native_submission", payload);
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };

    const claim = readLaunchClaim(identity);
    assert.ok(claim, "the killed worker durably crossed the submission-start fence");
    assert.equal(claim.acceptance, "not_submitted");
    assert.equal(claim.submissionState, "started");
    assert.equal(readVersionThreeJobRecord(identity), null, "no native acceptance was ever durable");

    const eligibility = launchClaimRollbackEligibility(claim);
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, "not_submitted_after_submission_started_never_rollback_safe");

    const route = versionThreeRoute({ instanceKey: payload.instanceKey, capabilities: versionThreeCapabilities() });
    const lease = acquireInstanceLease({
      ...identity,
      jobId: payload.jobId,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: payload.capacityClass,
      capacityLimit: 1,
    });
    const fixture = createFakeServiceDriver({
      instances: [{ instanceKey: payload.instanceKey, readiness: "ready", detailCode: "ready" }],
      autoComplete: true,
    });
    const preparedTurn = fixture.driver.prepareTurn({ route, taskInput: PROMPT });
    await assert.rejects(
      launchVersionThreeTurn({
        ...identity,
        attemptId: claim.attemptId,
        route,
        driver: fixture.driver,
        preparedTurn,
        preparedInput: PROMPT,
        assignedMessageIds: claim.assignedMessageIds,
        leaseBindings: [lease],
        // Stated explicitly: this fixture's Driver owns no turn options.
        turnOptions: null,
        workspaceRoot,
      }),
      (error) => {
        assert.equal(error.acceptance, "acceptance_unknown");
        assert.equal(error.acceptancePersisted, false);
        return true;
      }
    );
    // The replay attempt never reached this fresh Driver instance at all.
    assert.equal(fixture.control.service.prompts.length, 0);
    assert.equal(fixture.control.turnIds().length, 0);
    // The durable claim itself is untouched: `acceptancePersisted: false`.
    assert.deepEqual(readLaunchClaim(identity), claim);
    // Never released and never published: this generation has no proof that
    // would make either safe for a claim that never durably left
    // `not_submitted`.
    assert.throws(
      () => acquireInstanceLease({
        ownerRootId: `${payload.ownerRootId}-probe`,
        agentId: `${agentId}-probe`,
        jobId: `${payload.jobId}-probe`,
        route,
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        capacityClass: payload.capacityClass,
        capacityLimit: 1,
      }),
      /capacity exhausted/
    );
    assert.equal(readUnreadCompletionEvents(workspaceRoot, payload.ownerRootId).events.length, 0);
    assert.equal(readVersionThreeJobRecord(identity), null);
  });
});

describe("version-three worker loss: later observation after exact acceptance (scenarios 3-6)", () => {
  it("settles an in-process unknown exit from a later terminal observation, exactly once", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    const lost = await loop;
    assert.equal(lost.status, "unknown");
    assert.equal(lost.reason, "aborted");
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(
      readControlStreamClosure(context.identity),
      null,
      "the accepted 5.4 residual: an unknown exit leaves the control stream open"
    );

    // A control command lands while the record is still unknown -- the
    // residual scenario 6 names explicitly.
    const turnId = context.turnId();
    const turn = context.fixture.control.service.turns.get(turnId);
    const commandId = `late-command-${context.jobId}`;
    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ...context.identity,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 30_000,
    });

    // The Harness's own turn finishes independently of the worker that lost it.
    context.fixture.control.complete(turnId, "completed");

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: context.fixture.driver,
    });

    assert.equal(reconciliation.reconciled, true);
    assert.equal(reconciliation.status, "completed");
    assert.equal(reconciliation.leaseRelease.outcome, "all");
    assert.equal(reconciliation.agentProjected, true);
    assert.equal(reconciliation.completionPublished, true);

    assert.equal(context.leaseHeld(), false);
    assert.equal(context.v3Record().status, "completed");
    assert.equal(context.agent().status, "completed");
    assert.equal(context.agent().activeJobId, null);

    const event = context.events().find((candidate) => candidate.jobId === context.jobId);
    assert.ok(event, "completion was published exactly once");

    const closure = readControlStreamClosure(context.identity);
    assert.ok(closure, "the control stream is now closed from real terminal evidence");
    assert.equal(closure.nativeTurnState, "terminal");
    const command = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(command.requestState, "none");
    assert.equal(command.settlement, "settled");
    assert.equal(command.nativeTurnState, "terminal");

    // Never replayed input, never called startTurn again, never delivered
    // mailbox input, never requested interrupt.
    assert.equal(context.fixture.control.service.prompts.length, 1);
    assert.equal(context.fixture.control.service.deliveredInputs.length, 0);
    assert.equal(context.fixture.control.service.interruptRequests.length, 0);

    // Idempotent, restart-safe repeat: no second lease release, no second
    // completion event.
    const repeat = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: context.fixture.driver,
    });
    assert.equal(repeat.reconciled, true);
    assert.equal(repeat.alreadyTerminal, true);
    assert.equal(context.events().length, 1);
  });

  it("settles a genuinely killed worker's still-running record from a later observation", async () => {
    sequence += 1;
    const payload = {
      ownerRootId: `root-v3-running-${sequence}`,
      jobId: `job-v3-running-${sequence}`,
      attemptId: `attempt-v3-running-${sequence}`,
      instanceKey: `tenant-running-${sequence}`,
      taskName: `v3_running_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-running",
    };
    const { agentId } = await killAtCheckpoint("hang_while_running", payload);
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };

    const record = readVersionThreeJobRecord(identity);
    assert.ok(record, "native acceptance was durably proven before the kill");
    assert.equal(record.status, "running", "nothing ever ran the worker's own unknown-exit path");

    const fixture = createFakeServiceDriver({
      instances: [{ instanceKey: payload.instanceKey, readiness: "ready", detailCode: "ready" }],
      observeTurnOverride: () => ({ nativeTurn: "terminal", terminalResult: rawTerminalResultFor(record) }),
    });

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...identity,
      driver: fixture.driver,
    });

    assert.equal(reconciliation.reconciled, true);
    assert.equal(reconciliation.status, "completed");
    assert.equal(readVersionThreeJobRecord(identity).status, "completed");
  });

  it("leaves leases held and publishes nothing when the route cannot observe at all", async () => {
    const context = setup({ observable: false, capabilities: { values: { turnObservation: "unavailable" } } });
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    await loop;
    context.fixture.control.complete(context.turnId(), "completed");

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: context.fixture.driver,
    });
    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.reason, "turn_observation_unavailable");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.events().length, 0);
  });

  it("leaves leases held and publishes nothing while the native turn is still genuinely active", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    await loop;
    // Deliberately never completed: the Harness's own turn is still running.

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: context.fixture.driver,
    });
    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.reason, "native_turn_active");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.events().length, 0);
  });

  it("leaves leases held and publishes nothing on contradictory observation evidence", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    await loop;
    context.fixture.control.complete(context.turnId(), "completed");

    // A `status: "completed"` claim next to `executionWorld.settlement:
    // "active"` is `classifyTurnSettlement()`'s own definition of a
    // contradictory terminal claim -- but `validateNormalizedTerminalResult()`
    // already refuses that exact combination structurally, before this
    // module's own classification could ever run. Both outcomes are the same
    // safety property (unknown, nothing released, nothing published); this
    // asserts the one this module's own evidence path can actually reach.
    const contradictoryDriver = {
      ...context.fixture.driver,
      observeTurn: async (ref, scope) => {
        const observation = await context.fixture.driver.observeTurn(ref, scope);
        return observation.nativeTurn === "terminal"
          ? { ...observation, terminalResult: { ...observation.terminalResult, executionWorld: { continuity: "preserved", settlement: "active" } } }
          : observation;
      },
    };

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: contradictoryDriver,
    });
    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.reason, "invalid_terminal_result");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.events().length, 0);
  });

  it("leaves leases held and publishes nothing when the observation names a foreign native turn", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    await loop;
    context.fixture.control.complete(context.turnId(), "completed");
    const record = context.v3Record();
    const foreignRef = {
      ...record.nativeTurnRef,
      locator: { ...record.nativeTurnRef.locator, turnId: `${record.nativeTurnRef.locator.turnId}-foreign` },
    };

    const foreignDriver = {
      ...context.fixture.driver,
      observeTurn: async (ref, scope) => {
        const observation = await context.fixture.driver.observeTurn(ref, scope);
        return observation.nativeTurn === "terminal"
          ? { ...observation, terminalResult: { ...observation.terminalResult, nativeTurnRef: foreignRef } }
          : observation;
      },
    };

    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ...context.identity,
      driver: foreignDriver,
    });
    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.reason, "terminal_result_native_turn_mismatch");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.events().length, 0);
  });

  it("fails closed on a wrong root/Agent/job binding instead of reconciling a foreign record", async () => {
    const context = setup();
    const other = setup();
    const reconciliation = await reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION,
      ownerRootId: context.ownerRootId,
      agentId: other.agentId,
      jobId: context.jobId,
      driver: context.fixture.driver,
    });
    assert.equal(reconciliation.reconciled, false);
    assert.equal(reconciliation.reason, "record_not_found");
  });

  it("converges two concurrent reconciliation attempts to exactly one durable terminal record", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    await untilTrue(() => context.turnId() != null);
    controller.abort();
    await loop;
    context.fixture.control.complete(context.turnId(), "completed");

    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let observeCalls = 0;
    const gatedDriver = {
      ...context.fixture.driver,
      observeTurn: async (...args) => {
        observeCalls += 1;
        await gate;
        return context.fixture.driver.observeTurn(...args);
      },
    };

    const first = reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION, ...context.identity, driver: gatedDriver,
    });
    const second = reconcileVersionThreeWorkerLoss({
      generation: FUTURE_WRITE_GENERATION, ...context.identity, driver: gatedDriver,
    });
    await untilTrue(() => observeCalls === 2);
    releaseGate();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.reconciled, true);
    assert.equal(secondResult.reconciled, true);
    assert.equal(context.v3Record().status, "completed");
    assert.equal(context.leaseHeld(), false);
    assert.equal(context.events().length, 1, "exactly one completion event was published");
  });
});

// ---------------------------------------------------------------------------
// Section 5 defenses. Each block below is one defense the Section 5
// architecture/concurrency review asked for: the reconciler must read a
// Driver's observation as a closed, trap-free plain value; it must refuse to
// act on a durable record that disagrees with the launch claim that proved
// its acceptance; every durable read or projection failure must be a closed
// receipt rather than an escaping error; the write generation must be proven
// before anything is read, observed, or mutated; and an observation must be
// bounded in time rather than able to hang the reconciler forever.
// ---------------------------------------------------------------------------

describe("Section 5 defense: the observation is a closed, trap-free value", () => {
  it("refuses a Proxy observation before a single trap can run", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    const traps = [];
    const { driver } = observingDriver(context.fixture.driver, async (ref, scope, base) => {
      const observation = await base.observeTurn(ref, scope);
      return new Proxy(observation, {
        get(target, key, receiver) { traps.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
        has(target, key) { traps.push(`has:${String(key)}`); return Reflect.has(target, key); },
        ownKeys(target) { traps.push("ownKeys"); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) {
          traps.push(`descriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
      });
    });

    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "invalid_observation");
    // The only entries here are the JavaScript engine's own thenable probe
    // when an async function resolves with an object -- not this runtime
    // reading the observation. Validation itself runs zero traps.
    assert.deepEqual(traps.filter((trap) => trap !== "get:then"), [], "a Proxy trap observed this validation");
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
  });

  it("refuses an accessor-backed observation without ever invoking its getter", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    const record = context.v3Record();

    // A getter that answers "terminal" once and "active" afterwards is the
    // exact split a single-read snapshot has to make impossible.
    let getterCalls = 0;
    const { driver } = observingDriver(context.fixture.driver, async () => {
      const observation = { terminalResult: rawTerminalResultFor(record) };
      Object.defineProperty(observation, "nativeTurn", {
        enumerable: true,
        configurable: true,
        get() { getterCalls += 1; return getterCalls === 1 ? "terminal" : "active"; },
      });
      return observation;
    });

    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "invalid_observation");
    assert.equal(getterCalls, 0, "the changing getter was never invoked at all");
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
  });

  it("refuses unknown, hidden, symbol-keyed, inherited, and polluting observation fields", async () => {
    const shapes = [
      ["an unknown field", (terminal) => ({ nativeTurn: "terminal", terminalResult: terminal, state: "terminal" })],
      ["a hidden non-enumerable field", (terminal) => {
        const observation = { nativeTurn: "terminal", terminalResult: terminal };
        Object.defineProperty(observation, "evidence", { value: { source: "hidden" }, enumerable: false });
        return observation;
      }],
      ["symbol-keyed state", (terminal) => ({
        nativeTurn: "terminal", terminalResult: terminal, [Symbol("evidence")]: "hidden",
      })],
      ["an inherited discriminant", (terminal) => Object.assign(
        Object.create({ nativeTurn: "terminal" }), { terminalResult: terminal }
      )],
      ["a prototype-polluting field", (terminal) => {
        const observation = { nativeTurn: "terminal", terminalResult: terminal };
        Object.defineProperty(observation, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true });
        return observation;
      }],
    ];

    for (const [label, build] of shapes) {
      const context = setup();
      await loseTurn(context);
      context.fixture.control.complete(context.turnId(), "completed");
      const record = context.v3Record();
      const { driver } = observingDriver(context.fixture.driver, async () => build(rawTerminalResultFor(record)));

      const receipt = await reconcile(context, driver);
      assert.equal(receipt.reason, "invalid_observation", `${label} must be refused`);
      assert.equal(context.v3Record().status, "unknown", `${label} settled nothing`);
      assert.equal(context.leaseHeld(), true, `${label} released nothing`);
      assert.equal(context.events().length, 0, `${label} published nothing`);
    }
  });

  it("requires a terminal result exactly when, and only when, the turn is terminal", async () => {
    const withoutResult = setup();
    await loseTurn(withoutResult);
    withoutResult.fixture.control.complete(withoutResult.turnId(), "completed");
    const missing = await reconcile(
      withoutResult,
      observingDriver(withoutResult.fixture.driver, async () => ({ nativeTurn: "terminal" })).driver,
    );
    assert.equal(missing.reason, "invalid_observation");
    assert.equal(withoutResult.v3Record().status, "unknown");
    assert.equal(withoutResult.leaseHeld(), true);

    const stillActive = setup();
    await loseTurn(stillActive);
    stillActive.fixture.control.complete(stillActive.turnId(), "completed");
    const record = stillActive.v3Record();
    const contradictory = await reconcile(
      stillActive,
      observingDriver(stillActive.fixture.driver, async () => ({
        nativeTurn: "active", terminalResult: rawTerminalResultFor(record),
      })).driver,
    );
    assert.equal(contradictory.reason, "invalid_observation");
    assert.equal(stillActive.v3Record().status, "unknown");
    assert.equal(stillActive.leaseHeld(), true);
    assert.equal(stillActive.events().length, 0);
  });
});

describe("Section 5 defense: the record must agree with the claim that proved it", () => {
  it("never observes when the durable record's route disagrees with its launch claim", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    tamperJobRecord(context.identity, (record) => { record.route.model = "forged-model"; });

    const { driver, calls } = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "launch_claim_route_mismatch");
    assert.equal(calls.count, 0, "the Driver was never asked about a turn the claim does not corroborate");
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
    assert.equal(readControlStreamClosure(context.identity), null);
  });

  it("never observes when the durable record's native turn disagrees with its launch claim", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    tamperJobRecord(context.identity, (record) => {
      record.nativeTurnRef.locator.turnId = `${record.nativeTurnRef.locator.turnId}-forged`;
    });

    const { driver, calls } = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "launch_claim_native_turn_mismatch");
    assert.equal(calls.count, 0);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
  });

  it("accepts a launch-claim locator whose keys are stated in a different order", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    // Key order is not value: re-stating the same locator's keys backwards
    // must stay the same native turn.
    tamperJobRecord(context.identity, (record) => {
      const locator = record.nativeTurnRef.locator;
      record.nativeTurnRef.locator = Object.fromEntries(Object.entries(locator).reverse());
    });

    const receipt = await reconcile(context, context.fixture.driver);
    assert.equal(receipt.reconciled, true);
    assert.equal(receipt.status, "completed");
    assert.equal(context.leaseHeld(), false);
  });
});

describe("Section 5 defense: durable read and projection failures are closed receipts", () => {
  it("returns a closed receipt for an unreadable durable record", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    fs.writeFileSync(jobRecordFile(context.identity), "{ not json");

    const { driver, calls } = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "record_unreadable");
    assert.equal(calls.count, 0);
    // A closed platform/validator code, never a message that could carry a
    // local path or free-form error text.
    assert.ok(receipt.detail === null || /^[A-Za-z_]+$/.test(receipt.detail), `unexpected detail: ${receipt.detail}`);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
  });

  it("returns a closed receipt for an unreadable launch claim", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    // Two claim records for one job activation is a tamper shape the claim
    // reader refuses outright.
    const claimDirectory = resolveLaunchClaimDirectory(context.identity);
    const [existing] = fs.readdirSync(claimDirectory).filter((entry) => entry.endsWith(".json"));
    fs.copyFileSync(path.join(claimDirectory, existing), path.join(claimDirectory, `forged-${existing}`));

    const { driver, calls } = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const receipt = await reconcile(context, driver);
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "launch_claim_unreadable");
    assert.equal(calls.count, 0);
    assert.ok(receipt.detail === null || /^[A-Za-z_]+$/.test(receipt.detail), `unexpected detail: ${receipt.detail}`);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
  });

  it("keeps a terminal record retryable when its projection cannot be completed", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    // The completion inbox cannot be written while a directory occupies its
    // exact file path -- the durable-projection failure a terminal record
    // must survive rather than throw forever.
    const inboxFile = resolveCompletionInboxFile(workspaceRoot, context.ownerRootId);
    fs.mkdirSync(inboxFile, { recursive: true });

    const blocked = await reconcile(context, context.fixture.driver);
    assert.equal(blocked.reconciled, false);
    assert.equal(blocked.reason, "projection_failed");
    assert.ok(blocked.detail === null || /^[A-Za-z_]+$/.test(blocked.detail), `unexpected detail: ${blocked.detail}`);
    // The proven terminal fact is already durable, so nothing was lost.
    assert.equal(context.v3Record().status, "completed");
    assert.equal(context.v3Record().completionPublishedAt, null);
    assert.equal(context.leaseHeld(), false);

    fs.rmSync(inboxFile, { recursive: true, force: true });
    const retried = await reconcile(context, context.fixture.driver);
    assert.equal(retried.reconciled, true);
    assert.equal(retried.alreadyTerminal, true);
    assert.equal(context.events().length, 1, "exactly one completion event after the retry");
    assert.equal(context.agent().status, "completed");
  });
});

describe("Section 5 defense: the write generation is proven first", () => {
  it("refuses a public, absent, or bogus generation before any read or observation", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    for (const generation of [PUBLIC_WRITE_GENERATION, undefined, "bogus-generation"]) {
      const { driver, calls } = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
      await assert.rejects(
        reconcileVersionThreeWorkerLoss({ generation, ...context.identity, driver }),
        /version-three|generation/i,
        `generation ${JSON.stringify(generation ?? null)} must be refused`,
      );
      assert.equal(calls.count, 0, `generation ${JSON.stringify(generation ?? null)} reached Driver.observeTurn`);
      assert.equal(context.v3Record().status, "unknown");
      assert.equal(context.leaseHeld(), true);
      assert.equal(context.events().length, 0);
    }
  });
});

describe("Section 5 defense: an observation is bounded, and cancellation is not settlement", () => {
  it("bounds a hanging observation by the caller's deadline", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    let observedScope = null;
    const { driver } = observingDriver(context.fixture.driver, async (ref, scope) => {
      observedScope = scope;
      return new Promise(() => {});
    });

    const startedAt = Date.now();
    const receipt = await reconcile(context, driver, {
      deadlineAt: new Date(Date.now() + 250).toISOString(),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "observation_deadline_exceeded");
    assert.ok(elapsed < 5_000, `the reconciler waited ${elapsed} ms on a hanging observation`);
    assert.equal(observedScope.signal.aborted, true, "the Driver's own scope signal was aborted");
    // Cancellation is not settlement.
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
    assert.equal(readControlStreamClosure(context.identity), null);
  });

  it("distinguishes a caller abort from a deadline", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    const controller = new AbortController();
    const { driver } = observingDriver(context.fixture.driver, async () => {
      setTimeout(() => controller.abort(), 20);
      return new Promise(() => {});
    });

    const receipt = await reconcile(context, driver, { signal: controller.signal });
    assert.equal(receipt.reconciled, false);
    assert.equal(receipt.reason, "observation_aborted");
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
  });

  it("refuses an already-aborted caller and an already-elapsed deadline before observing", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    const controller = new AbortController();
    controller.abort();
    const aborted = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const abortedReceipt = await reconcile(context, aborted.driver, { signal: controller.signal });
    assert.equal(abortedReceipt.reason, "observation_aborted");
    assert.equal(aborted.calls.count, 0);

    const elapsed = observingDriver(context.fixture.driver, async (ref, scope, base) => base.observeTurn(ref, scope));
    const elapsedReceipt = await reconcile(context, elapsed.driver, {
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.equal(elapsedReceipt.reason, "observation_deadline_exceeded");
    assert.equal(elapsed.calls.count, 0);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.leaseHeld(), true);
  });

  it("passes a bounded default deadline and a live signal into the DriverScope, and cleans up after itself", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); };
    controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };

    let observedScope = null;
    let observedAt = 0;
    const { driver } = observingDriver(context.fixture.driver, async (ref, scope, base) => {
      observedScope = scope;
      observedAt = Date.now();
      assert.equal(scope.signal.aborted, false, "the observation window is open while the Driver runs");
      return base.observeTurn(ref, scope);
    });

    const receipt = await reconcile(context, driver, { signal: controller.signal });
    assert.equal(receipt.reconciled, true);
    assert.ok(observedScope.signal instanceof AbortSignal);
    const deadlineMs = Date.parse(observedScope.deadlineAt);
    assert.ok(Number.isFinite(deadlineMs), "the scope carries one parseable bounded deadline");
    assert.ok(
      deadlineMs - observedAt <= DEFAULT_OBSERVATION_DEADLINE_MS && deadlineMs > observedAt,
      `default observation deadline out of bounds: ${observedScope.deadlineAt}`,
    );
    assert.equal(DEFAULT_OBSERVATION_DEADLINE_MS, 30_000);
    assert.ok(added >= 1, "the reconciler listened to the caller's signal");
    assert.equal(removed, added, "every abort listener the reconciler added was removed");
  });
});

describe("Section 5 coverage: leases, cross-process convergence, and restart", () => {
  it("releases the instance, writer, and native-session leases together", async () => {
    const context = setup({ allLeaseKinds: true, authority: "behavioral_write" });
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.writerLeaseHeld(), true);
    assert.equal(context.nativeSessionLeaseHeld(), true);

    const receipt = await reconcile(context, context.fixture.driver);
    assert.equal(receipt.reconciled, true);
    assert.equal(receipt.leaseRelease.outcome, "all");
    assert.equal(receipt.leaseRelease.releasedCount, 3);
    assert.equal(receipt.leaseRelease.retainedCount, 0);
    assert.equal(context.leaseHeld(), false);
    assert.equal(context.nativeSessionLeaseHeld(), false);
    assert.equal(context.writerLeaseHeld(), false);
    assert.equal(context.events().length, 1);
  });

  it("settles a restart that crashed after lease release but before the terminal record", async () => {
    const context = setup();
    await loseTurn(context);
    context.fixture.control.complete(context.turnId(), "completed");

    // Exactly the durable state a worker leaves behind when it dies between
    // step 4 (lease release) and step 5 (the durable terminal record).
    const record = context.v3Record();
    const evidence = validateNormalizedTerminalResult(rawTerminalResultFor(record), {
      driver: context.fixture.driver, route: record.route,
    });
    const claim = readLaunchClaim(context.identity);
    const released = releaseLeasesOnSettlement({
      normalizedTerminalResult: evidence,
      releases: buildLeaseReleaseTargets(claim.leaseBindings.map((binding) => ({ ...binding, route: record.route }))),
    });
    assert.equal(released.outcome, "all");
    assert.equal(context.leaseHeld(), false);
    assert.equal(context.v3Record().status, "unknown");
    assert.equal(context.events().length, 0);

    const receipt = await reconcile(context, context.fixture.driver);
    assert.equal(receipt.reconciled, true);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.leaseRelease.outcome, "all");
    assert.equal(receipt.leaseRelease.releasedCount, 0);
    assert.equal(receipt.leaseRelease.alreadyReleasedCount, 1);
    assert.equal(context.v3Record().status, "completed");
    assert.equal(context.agent().status, "completed");
    assert.equal(context.events().length, 1, "exactly one completion event across the restart");
  });

  it("converges a real live worker process and a concurrent reconciler to exactly one settlement", async () => {
    sequence += 1;
    const triggerFile = path.join(root, `settle-trigger-${sequence}`);
    const payload = {
      ownerRootId: `root-v3-converge-${sequence}`,
      jobId: `job-v3-converge-${sequence}`,
      attemptId: `attempt-v3-converge-${sequence}`,
      instanceKey: `tenant-converge-${sequence}`,
      taskName: `v3_converge_${sequence}`,
      promptText: PROMPT,
      workspaceRoot,
      capacityClass: "fake-service-converge",
      triggerFile,
    };

    const worker = spawnWorkerProcess("settle_on_trigger", payload);
    const agentId = await worker.ready;
    const identity = { ownerRootId: payload.ownerRootId, agentId, jobId: payload.jobId };
    const record = readVersionThreeJobRecord(identity);
    assert.equal(record.status, "running", "the live worker durably owns a running turn");

    // The reconciler observes the same native turn from its own process, with
    // its own Driver instance, at the same moment the live worker settles it.
    const fixture = createFakeServiceDriver({
      instances: [{ instanceKey: payload.instanceKey, readiness: "ready", detailCode: "ready" }],
      observeTurnOverride: () => ({ nativeTurn: "terminal", terminalResult: rawTerminalResultFor(record) }),
    });
    fs.writeFileSync(triggerFile, "settle");
    const [receipt, exit] = await Promise.all([
      reconcileVersionThreeWorkerLoss({ generation: FUTURE_WRITE_GENERATION, ...identity, driver: fixture.driver }),
      worker.exit,
    ]);

    assert.equal(exit.code, 0, `worker process failed: ${exit.stderr}`);
    assert.equal(receipt.reconciled, true, `reconciler receipt: ${JSON.stringify(receipt)}`);
    const settled = readVersionThreeJobRecord(identity);
    assert.ok(["completed", "failed", "interrupted"].includes(settled.status));
    assert.ok(settled.completionPublishedAt, "the durable record records exactly one publication");
    const events = readUnreadCompletionEvents(workspaceRoot, payload.ownerRootId).events;
    assert.equal(events.length, 1, "exactly one completion event across both processes");
    assert.equal(events[0].jobId, payload.jobId);
    const closure = readControlStreamClosure(identity);
    assert.equal(closure.nativeTurnState, "terminal");
    assert.equal(
      probeLeaseHeld(() => acquireInstanceLease({
        ownerRootId: `${payload.ownerRootId}-probe`,
        agentId: `${agentId}-probe`,
        jobId: `${payload.jobId}-probe`,
        route: settled.route,
        harnessId: settled.route.harnessId,
        instanceKey: settled.route.instanceKey,
        capacityClass: payload.capacityClass,
        capacityLimit: 1,
      })),
      false,
      "the instance lease was released exactly once, by whichever settler won",
    );
  });
});
