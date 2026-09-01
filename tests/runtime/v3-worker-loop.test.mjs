import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  canonicalAgentWorkspaceRoot,
  createAgentStore,
  resolveAgentRegistryDirectory,
} from "../../runtime/agent-store.mjs";
import {
  readUnreadCompletionEvents,
  resolveCompletionInboxFile,
} from "../../runtime/completion-inbox.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import { projectAgentCard } from "../../runtime/agent-card.mjs";
import {
  MAX_DRIVER_RECEIPT_BYTES,
  MAX_FINAL_MESSAGE_CHARS,
} from "../../runtime/harness-contract.mjs";
import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim, readLaunchClaim } from "../../runtime/launch-claim.mjs";
import { listStoredJobs, readJobFile, reconcileCompletionEvents } from "../../runtime/job-store.mjs";
import { runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";
import {
  MAX_TERMINAL_JOB_SUMMARY_CHARS,
  readVersionThreeJobRecord,
  reconcileVersionThreeTerminalJobs,
  resolveVersionThreeJobDirectory,
} from "../../runtime/v3-job-store.mjs";
import {
  enqueueControlCommand,
  listControlCommands,
  readControlStreamClosure,
  resolveControlStreamDirectory,
} from "../../runtime/turn-control.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { versionThreeCapabilities, versionThreeRoute } from "./fixtures/version-three-state.mjs";

const contenderFixture = fileURLToPath(
  new URL("./fixtures/v3-settlement-contender.mjs", import.meta.url)
);

/**
 * Run one contender process *concurrently* with this test's own worker loop.
 * Deliberately not `spawnSync`: that blocks this process's event loop, so the
 * worker could not settle while the contender ran and the race would never
 * actually overlap.
 */
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-v3-worker-loop-"));
const workspaceRoot = path.join(root, "workspace");
fs.mkdirSync(workspaceRoot);
process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");

after(() => fs.rmSync(root, { recursive: true, force: true }));

let sequence = 0;

const PROMPT = "Inspect only.\n\nReturn one bounded finding.";

function registryFile(ownerRootId) {
  // The exact durable file the production Agent store owns for this root.
  return path.join(resolveAgentRegistryDirectory({ cwd: workspaceRoot, ownerRootId }), "registry.json");
}

async function untilTrue(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/**
 * One turn, wired end to end through production persistence: a real
 * version-three Agent record, its real durable mailbox, a real instance lease,
 * a real launch claim, and the real completion inbox. There is no in-memory
 * stand-in for any durable owner.
 */
function setup(options = {}) {
  sequence += 1;
  const ownerRootId = `root-v3-loop-${sequence}`;
  const jobId = `job-v3-loop-${sequence}`;
  const attemptId = `attempt-v3-loop-${sequence}`;
  const instanceKey = `tenant-loop-${sequence}`;
  const capabilities = versionThreeCapabilities(options.capabilities ?? {});
  const route = versionThreeRoute({ instanceKey, capabilities });

  const store = createAgentStore({
    cwd: workspaceRoot,
    ownerRootId,
    writeGeneration: FUTURE_WRITE_GENERATION,
  });
  const agent = store.createAgent({
    task_name: `v3_loop_${sequence}`,
    route,
    initialMessage: PROMPT,
  });
  const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
  assert.ok(reservation.reserved, "version-three activation reservation failed");

  const fixture = createFakeServiceDriver({
    autoComplete: false,
    observable: options.observable ?? true,
    instances: [{ instanceKey, readiness: "ready", detailCode: "ready" }],
    capabilities: options.capabilities,
    resultOverride: options.resultOverride,
    liveTurnOverride: options.liveTurnOverride,
  });

  const lease = acquireInstanceLease({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    route,
    harnessId: route.harnessId,
    instanceKey: route.instanceKey,
    capacityClass: "fake-service-test",
    capacityLimit: 1,
  });

  const preparedTurn = fixture.driver.prepareTurn({ route, taskInput: PROMPT });
  const assignedMessageIds = reservation.assignedMessages.map((message) => message.messageId);
  createLaunchClaim({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route,
    leaseBindings: [lease],
    assignedMessageIds,
    preparedInput: PROMPT,
    turnOptions: null,
    inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
  });

  return {
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route,
    store,
    fixture,
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
      leaseBindings: [lease],
      // Stated explicitly: this fixture's Driver owns no turn options.
      turnOptions: null,
      workspaceRoot,
      env: { FAKE_SERVICE_HOME: path.join(root, "fake-service") },
      ensureResidencyManager: () => undefined,
      cwd: workspaceRoot,
    },
    messages: () => store.listMessages(agent.agentId),
    message: (messageId) => store.listMessages(agent.agentId).find((entry) => entry.messageId === messageId),
    agent: () => store.readAgent(agent.agentId),
    events: () => readUnreadCompletionEvents(workspaceRoot, ownerRootId).events,
    commands: () => listControlCommands({ ownerRootId, agentId: agent.agentId, jobId }),
    leaseHeld: () => {
      try {
        acquireInstanceLease({
          ownerRootId: `${ownerRootId}-probe`,
          agentId: `${agent.agentId}-probe`,
          jobId: `${jobId}-probe`,
          route,
          harnessId: route.harnessId,
          instanceKey: route.instanceKey,
          capacityClass: "fake-service-test",
          capacityLimit: 1,
        });
        return false;
      } catch (error) {
        if (/capacity exhausted/.test(error.message)) return true;
        throw error;
      }
    },
    lease,
    v3Record: () => readVersionThreeJobRecord({ ownerRootId, agentId: agent.agentId, jobId }),
    turnId: () => fixture.control.turnIds()[0] ?? null,
    complete: (status = "completed", delayMs = 80) => setTimeout(() => {
      const turnIds = fixture.control.turnIds();
      if (turnIds.length > 0) fixture.control.complete(turnIds[0], status);
    }, delayMs),
  };
}

describe("version-three worker loop: durable turn lifecycle", () => {
  it("acknowledges the prompt only after proven acceptance, then settles through production persistence", async () => {
    const context = setup();
    let managerEnsures = 0;
    context.input.ensureResidencyManager = () => { managerEnsures += 1; };
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);

    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.agentReconciled, true);
    assert.equal(result.leasesReleased, true);
    assert.equal(managerEnsures, 3, "physical binding, running durability, and terminal durability each nudge the manager");
    assert.equal(result.disposed, true);
    assert.equal(result.liveOwnershipCleared, true);

    assert.equal(readLaunchClaim(context.input).acceptance, "acceptance_proven");
    for (const message of context.messages()) {
      assert.equal(message.state, "acknowledged");
      assert.ok(message.acknowledgedAt);
    }

    const agent = context.agent();
    assert.equal(agent.status, "completed");
    assert.equal(agent.activeJobId, null);
    assert.equal(agent.latestJobId, context.jobId);
    const record = context.v3Record();
    const card = projectAgentCard(agent, {
      id: record.jobId,
      ownerRootId: record.ownerRootId,
      agentId: record.agentId,
      attemptId: record.attemptId,
      route: record.route,
      status: record.status,
    });
    assert.equal(card.inspection_generation, "unavailable");
    assert.deepEqual(card.capability_provenance, record.route.capabilities.provenance);

    const event = context.events().find((candidate) => candidate.jobId === context.jobId);
    assert.ok(event, "completion event was published");
    assert.equal(event.terminalStatus, "completed");
    assert.equal(event.agentId, context.agentId);
    assert.equal(context.leaseHeld(), false);
  });

  it("finalizes a stored v2 Agent from its matching v3 execution job without rewriting route history", async () => {
    const context = setup();
    const filePath = registryFile(context.ownerRootId);
    const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const stored = registry.agents[context.agentId];
    const { provenance: _provenance, ...v2Capabilities } = stored.route.capabilities;
    stored.route = {
      ...stored.route,
      capabilitySchemaVersion: 2,
      capabilities: { ...v2Capabilities, capabilitySchemaVersion: 2 },
    };
    const historicalRoute = JSON.stringify(stored.route);
    fs.writeFileSync(filePath, JSON.stringify(registry));

    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    assert.equal(context.agent().status, "completed");
    assert.equal(context.v3Record().route.capabilitySchemaVersion, 4);
    const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(JSON.stringify(after.agents[context.agentId].route), historicalRoute);
  });

  it("keeps blank and NUL final messages intact while deriving a valid completion summary", async () => {
    for (const [finalMessage, expectedSummary] of [
      ["\n", "fallback"],
      [" ", "fallback"],
      ["answer\0with-native-bytes", "fallback"],
      ["  ordinary summary  ", "ordinary summary"],
    ]) {
      const context = setup({
        resultOverride: (result) => ({ ...result, finalMessage }),
      });
      context.complete("completed");

      const result = await runVersionThreeWorkerLoop(context.input);
      assert.equal(result.status, "completed");
      assert.equal(result.published, true);
      assert.equal(result.agentReconciled, true);

      const event = context.events().find((candidate) => candidate.jobId === context.jobId);
      assert.ok(event, `completion event missing for ${JSON.stringify(finalMessage)}`);
      assert.equal(event.finalMessage, finalMessage);
      assert.equal(
        event.summary,
        expectedSummary === "fallback" ? `completed job ${context.jobId}` : expectedSummary,
      );
      assert.equal(context.agent().status, "completed");
      assert.equal(context.v3Record().terminalJob.summary, event.summary);
      assert.equal(context.v3Record().terminalJob.normalizedTerminalResult.finalMessage, finalMessage);

      // A fresh reconciliation pass must safely reopen the same production
      // record and treat the already-published projection as a no-op.
      const reconciliation = reconcileVersionThreeTerminalJobs({
        ownerRootId: context.ownerRootId,
        generation: FUTURE_WRITE_GENERATION,
      });
      assert.deepEqual(reconciliation.unreadable, []);
      assert.deepEqual(reconciliation.receipts, []);
    }
  });

  it("records the Driver's own continuation envelope and never infers safe_fresh", async () => {
    const context = setup();
    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");

    const evidence = context.agent().continuation;
    assert.equal(evidence.mode, "exact_session");
    assert.equal(evidence.evidence.reason, "driver_proven_exact_resume");
    // The exact version-three envelope, not a flattened legacy session ID.
    assert.equal(evidence.evidence.nativeSessionRef.harnessId, context.route.harnessId);
    assert.equal(evidence.evidence.nativeSessionRef.instanceKey, context.route.instanceKey);
    assert.equal(evidence.evidence.nativeSessionRef.driverVersion, context.route.driverVersion);
    assert.ok(evidence.evidence.nativeSessionRef.locator.sessionId);
    assert.equal(evidence.evidence.nativeSessionRef.nativeSessionId, undefined);
    // Route and attempt lineage travel with the terminal projection.
    assert.equal(evidence.evidence.attemptId, context.attemptId);
    assert.equal(evidence.evidence.jobId, context.jobId);
    assert.equal(evidence.evidence.nativeTurnRef.locator.turnId, context.turnId());
    assert.deepEqual(
      context.agent().nativeSessionRef,
      evidence.evidence.nativeSessionRef,
      "the Driver-validated exact session reference becomes the next turn's resume pointer",
    );
    assert.equal(context.agent().claudeSessionId, null);

    // No foreign locator is ever renamed into a Claude-shaped public field.
    const event = context.events().find((candidate) => candidate.jobId === context.jobId);
    assert.equal(event.claudeSessionIdAvailable, false);
    assert.equal(event.resumability.claudeSessionId, null);
    assert.equal(event.resumability.classification, "not_resumable");
    assert.equal(event.resumability.blockingReason, "version_three_continuation_recorded_on_agent_record");
  });

  it("blocks continuation with an exact reason when the Driver cannot resume its transcript", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        continuation: { mode: "fresh_only", evidence: { source: "service_turn_status" } },
      }),
      capabilities: { values: { continuation: "fresh_only" } },
    });
    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);

    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.continuation.mode, "blocked");
    assert.equal(result.continuation.resumable, false);
    const evidence = context.agent().continuation;
    assert.equal(evidence.mode, "blocked");
    assert.notEqual(evidence.mode, "safe_fresh");
    assert.equal(evidence.evidence.reason, "driver_continuation_not_exact_resume");
  });
});

describe("version-three worker loop: mailbox delivery", () => {
  it("delivers a steering message through the durable mailbox wake and a positive receipt", async () => {
    const context = setup();
    const loop = runVersionThreeWorkerLoop(context.input);
    // Enqueued after the turn is live: the only path to the worker is the
    // durable mailbox write plus its directory wake hint.
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Please also check the tests.");
    await untilTrue(() => context.fixture.control.service.deliveredInputs.length === 1);
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "completed");
    assert.equal(context.fixture.control.service.deliveredInputs.length, 1);
    assert.equal(context.fixture.control.service.deliveredInputs[0].text, "Please also check the tests.");
    const delivered = context.message(message.messageId);
    assert.equal(delivered.state, "acknowledged");
    assert.equal(delivered.receipt.accepted, true);
    assert.deepEqual(result.mailbox.dispatchedUnacknowledgedMessageIds, []);
  });

  it("pins an oversized active-input receipt without acknowledging or persisting its payload", async () => {
    const oversized = "x".repeat(MAX_DRIVER_RECEIPT_BYTES * 2);
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        deliverActiveInput: async () => ({ accepted: true, oversized }),
      }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Oversized receipt.");
    await untilTrue(() => context.message(message.messageId)?.state === "dispatched");
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "completed");
    const delivered = context.message(message.messageId);
    assert.equal(delivered.state, "dispatched");
    assert.equal(delivered.receipt.delivery, "unknown");
    assert.equal(delivered.receipt.reason, "receipt_not_recordable");
    assert.equal(delivered.receipt.oversized, undefined);
    assert.equal(result.mailbox.acknowledgedMessageIds.includes(message.messageId), false);
    assert.equal(result.mailbox.pinnedMessageIds.includes(message.messageId), true);
  });

  it("binds assignedInputs after proven acceptance instead of submitting them at launch", async () => {
    sequence += 1;
    const ownerRootId = `root-v3-bind-${sequence}`;
    const jobId = `job-v3-bind-${sequence}`;
    const instanceKey = `tenant-bind-${sequence}`;
    const route = versionThreeRoute({ instanceKey, capabilities: versionThreeCapabilities() });
    const store = createAgentStore({ cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
    const agent = store.createAgent({ task_name: `v3_bind_${sequence}`, route, initialMessage: PROMPT });
    // A second mailbox entry exists before activation, so the reservation binds
    // both to this job: one is prompt-carried, one must be actively delivered.
    const queued = store.enqueueMessage(agent.agentId, "Deliver me actively.").message;
    const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
    const assignedMessageIds = reservation.assignedMessages.map((entry) => entry.messageId);
    assert.equal(assignedMessageIds.length, 2);

    const fixture = createFakeServiceDriver({
      autoComplete: false,
      instances: [{ instanceKey, readiness: "ready", detailCode: "ready" }],
    });
    const lease = acquireInstanceLease({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: "fake-service-test",
      capacityLimit: 1,
    });
    const input = {
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId: `attempt-v3-bind-${sequence}`,
      route,
      driver: fixture.driver,
      preparedTurn: fixture.driver.prepareTurn({ route, taskInput: PROMPT }),
      preparedInput: PROMPT,
      assignedMessageIds,
      assignedInputs: [{ messageId: queued.messageId, text: "Deliver me actively." }],
      leaseBindings: [lease],
      // Stated explicitly: this fixture's Driver owns no turn options.
      turnOptions: null,
      workspaceRoot,
      env: {},
      cwd: workspaceRoot,
    };
    createLaunchClaim({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId: input.attemptId,
      route,
      leaseBindings: [lease],
      assignedMessageIds,
      preparedInput: PROMPT,
      turnOptions: null,
      inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
    });

    setTimeout(() => {
      const turnIds = fixture.control.turnIds();
      if (turnIds.length > 0) fixture.control.complete(turnIds[0], "completed");
    }, 200);
    const result = await runVersionThreeWorkerLoop(input);

    assert.equal(result.status, "completed");
    // The launch fence never saw an active input, and the bound entry was
    // delivered only after acceptance was proven.
    assert.equal(fixture.control.service.prompts.length, 1);
    assert.equal(fixture.control.service.deliveredInputs.length, 1);
    assert.equal(fixture.control.service.deliveredInputs[0].messageId, queued.messageId);
    const messages = store.listMessages(agent.agentId);
    assert.deepEqual(messages.map((entry) => entry.state), ["acknowledged", "acknowledged"]);

    // A bound input outside the claim's mailbox identity is refused up front.
    await assert.rejects(
      () => runVersionThreeWorkerLoop({ ...input, assignedInputs: [{ messageId: "foreign-message", text: "x" }] }),
      /assigned mailbox identity does not contain/
    );
    // So is one the accepted capability snapshot cannot deliver.
    await assert.rejects(
      () => runVersionThreeWorkerLoop({
        ...input,
        route: versionThreeRoute({
          instanceKey,
          capabilities: versionThreeCapabilities({ values: { activeInput: "initial_only" } }),
        }),
      }),
      /admits acknowledged active input/
    );
  });

  it("acknowledges active input only from a positive Driver receipt", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        deliverActiveInput: async () => ({ accepted: false, rejectedReason: "turn_no_longer_active" }),
      }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Refused steering message.");
    await untilTrue(() => context.message(message.messageId).state === "dispatched");
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "completed");
    // The Driver *proved* it did not take the entry, so nothing crossed the
    // native boundary and the message is still owed: it returns to the queue
    // rather than being stranded on a job that will never deliver it.
    const requeued = context.message(message.messageId);
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.assignedJobId, null);
    assert.equal(requeued.acknowledgedAt, null);
    assert.equal(requeued.undeliveredEvidence.reason, "driver_rejected_active_input");
    assert.deepEqual(result.mailbox.dispatchedUnacknowledgedMessageIds, []);
    assert.deepEqual(result.mailbox.requeuedMessageIds, [message.messageId]);
    assert.deepEqual(result.mailbox.inputFailures, [
      {
        messageId: message.messageId,
        reason: "driver_rejected_active_input",
        detail: null,
        disposition: "requeued",
      },
    ]);

    // At-least-once: the next turn owes it again.
    const next = context.store.reserveActivation(context.agentId, `${context.jobId}-next`);
    assert.equal(next.reserved, true);
    assert.ok(next.assignedMessages.some((entry) => entry.messageId === message.messageId));
  });

  it("leaves an entry dispatched when the Driver's delivery fails, and still settles the turn", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        deliverActiveInput: async () => { throw new Error("service input stream reset"); },
      }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Delivery explodes.");
    await untilTrue(() => context.message(message.messageId).state === "dispatched");
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    // The delivery may or may not have crossed the boundary, so the entry is
    // pinned rather than requeued: replaying it could duplicate real work.
    const pinned = context.message(message.messageId);
    assert.equal(pinned.state, "dispatched");
    assert.equal(pinned.receipt.delivery, "unknown");
    assert.equal(pinned.receipt.reason, "driver_delivery_failed");
    assert.equal(result.mailbox.inputFailures[0].reason, "driver_delivery_failed");
    assert.equal(result.mailbox.inputFailures[0].disposition, "pinned_dispatched");
    assert.deepEqual(result.mailbox.requeuedMessageIds, []);

    // A pinned entry is never handed to a later turn.
    const next = context.store.reserveActivation(context.agentId, `${context.jobId}-next`);
    assert.ok(!next.assignedMessages.some((entry) => entry.messageId === message.messageId));
  });

  it("queues messages without active delivery when the capability is initial_only", async () => {
    const context = setup({ capabilities: { values: { activeInput: "initial_only" } } });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Never actively delivered.");
    context.complete("completed", 120);

    const result = await loop;
    assert.equal(result.status, "completed");
    assert.equal(context.fixture.control.service.deliveredInputs.length, 0);
    // Nothing was ever delivered for it, so the quiesce barrier returns it to
    // the queue and the next turn owes it.
    const requeued = context.message(message.messageId);
    assert.equal(requeued.state, "queued");
    assert.equal(requeued.assignedJobId, null);
    assert.deepEqual(result.mailbox.requeuedMessageIds, [message.messageId]);
    const next = context.store.reserveActivation(context.agentId, `${context.jobId}-next`);
    assert.ok(next.assignedMessages.some((entry) => entry.messageId === message.messageId));
  });
});

describe("version-three worker loop: attempt-bound control", () => {
  it("claims, acknowledges, and settles an interrupt for this exact attempt", async () => {
    const context = setup();
    const commandId = `interrupt-${sequence}`;
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;

    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 5_000,
    });
    await untilTrue(() => context.fixture.control.service.interruptRequests.length === 1);
    context.fixture.control.complete(turn.turnId, "interrupted");

    const result = await loop;
    assert.equal(result.status, "interrupted");
    assert.equal(result.published, true);
    assert.deepEqual(result.control.claimedCommandIds, [commandId]);

    const command = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(command.claimedByAttemptId, context.attemptId);
    assert.equal(command.requestState, "accepted");
    assert.equal(command.settlement, "settled");
    assert.equal(command.nativeTurnState, "terminal");
  });

  it("expires its own command deadline to unknown without synthesizing a terminal", async () => {
    const context = setup();
    const commandId = `interrupt-deadline-${sequence}`;
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;

    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 1_000,
    });
    const expired = await untilTrue(
      () => context.commands().find((entry) => entry.commandId === commandId)?.settlement === "unknown",
      6_000
    );
    assert.equal(expired, true, "the worker must own its own command deadline");
    const pending = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(pending.nativeTurnState, "active");
    assert.equal(context.agent().status, "running");

    context.fixture.control.complete(turn.turnId, "completed");
    const result = await loop;
    assert.equal(result.status, "completed");
    // Publishable terminal evidence is the only thing that may move an expired
    // command forward, and it moves it to settled -- never to a synthesized
    // interruption.
    const settled = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(settled.settlement, "settled");
    assert.equal(settled.nativeTurnState, "terminal");
  });

  it("contains an unclaimable foreign command without ending the turn or touching its record", async () => {
    const context = setup();
    const commandId = `stale-interrupt-${sequence}`;
    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: {
        version: 1,
        harnessId: context.route.harnessId,
        driverVersion: context.route.driverVersion,
        instanceKey: context.route.instanceKey,
        locatorVersion: 1,
        locator: { sessionId: "service-session-0", turnId: "service-turn-0" },
      },
      deadlineMs: 5_000,
    });
    context.complete("completed", 200);

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.leasesReleased, true);
    assert.equal(result.disposed, true);
    assert.equal(result.control.skippedCommands[commandId], "not_claimable");
    assert.equal(result.control.failures[0].stage, "claim");
    // The foreign command is left exactly as its own owner wrote it.
    const command = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(command.requestState, "none");
    assert.equal(command.settlement, "pending");
    assert.equal(command.claimedByAttemptId, null);
    assert.equal(context.fixture.control.service.interruptRequests.length, 0);
  });

  it("holds everything when its own control settlement cannot be persisted", async () => {
    const context = setup();
    const commandId = `interrupt-unwritable-${sequence}`;
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;
    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 30_000,
    });
    await untilTrue(() => context.commands().find((entry) => entry.commandId === commandId)?.requestState === "accepted");

    // Corrupt this attempt's own command record: settlement can no longer be
    // made durable, so nothing may be released or published.
    const streamDir = resolveControlStreamDirectory({
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
    });
    for (const file of fs.readdirSync(streamDir)) {
      if (file.endsWith(".json")) fs.writeFileSync(path.join(streamDir, file), "{ not json");
    }
    context.fixture.control.complete(turn.turnId, "completed");

    const result = await loop;
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "control_stream_not_closed");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(result.agentReconciled, false);
    assert.equal(result.disposed, true);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
    assert.equal(context.agent().status, "running");
  });
});

describe("version-three worker loop: fail-closed dispositions", () => {
  it("observes a late native rejection when durable setup fails before the result race", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        result: new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late native result rejection")), 40);
        }),
      }),
    });
    // Force the pre-race running-record bailout after native acceptance. The
    // result rejection arrives after the worker has already disposed, so an
    // observer attached immediately after launch is the only safe containment.
    const directory = resolveVersionThreeJobDirectory({ ownerRootId: context.ownerRootId });
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.writeFileSync(directory, "not a directory", "utf8");

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let result;
    try {
      result = await runVersionThreeWorkerLoop(context.input);
      await new Promise((resolve) => setTimeout(resolve, 90));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      fs.rmSync(directory, { force: true });
    }

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "v3_job_record_unavailable");
    assert.equal(result.disposed, true);
    assert.deepEqual(unhandled, []);
    assert.equal(context.events().length, 0);
    assert.equal(context.leaseHeld(), true);
  });

  it("publishes nothing and projects nothing when execution settlement is unknown", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        executionWorld: { continuity: "preserved", settlement: "unknown" },
      }),
    });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "execution_settlement_unknown");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(result.agentReconciled, false);
    assert.equal(result.disposed, true);
    // The publishability gate precedes every terminal projection: the Agent is
    // still its own active owner.
    const agent = context.agent();
    assert.equal(agent.status, "running");
    assert.equal(agent.activeJobId, context.jobId);
    assert.equal(agent.continuation.mode, "safe_fresh");
    assert.equal(agent.continuation.evidence.reason, "new_agent_no_session");
    assert.equal(context.events().length, 0);
    assert.equal(context.leaseHeld(), true);
  });

  it("refuses a terminal result that names another native turn", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        nativeTurnRef: {
          ...result.nativeTurnRef,
          locator: { sessionId: "service-session-9", turnId: "service-turn-9" },
        },
      }),
    });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "terminal_result_native_turn_mismatch");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(context.leaseHeld(), true);
  });

  it("treats a rejected result promise as unknown and holds its leases", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        result: Promise.reject(new Error("service connection lost")),
      }),
    });
    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "driver_result_rejected");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(result.disposed, true);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.agent().status, "running");
  });

  it("treats an Agent store failure as durable unknown", async () => {
    const context = setup();
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const file = registryFile(context.ownerRootId);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, "{ not json");
    context.complete("completed", 300);

    const result = await loop;
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "durable_sweep_failed");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(result.disposed, true);
    fs.writeFileSync(file, original);
    assert.equal(context.agent().status, "running");
    assert.equal(context.events().length, 0);
    assert.equal(context.leaseHeld(), true);
  });

  it("holds leases and publishes nothing on abort", async () => {
    const context = setup();
    const controller = new AbortController();
    const loop = runVersionThreeWorkerLoop({ ...context.input, signal: controller.signal });
    setTimeout(() => controller.abort(), 60);

    const result = await loop;
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "aborted");
    assert.equal(result.published, false);
    assert.equal(result.leasesReleased, false);
    assert.equal(result.disposed, true);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.agent().status, "running");
  });

  it("rejects replay of the same attempt after native acceptance", async () => {
    const context = setup();
    context.complete("completed");
    const first = await runVersionThreeWorkerLoop(context.input);
    assert.equal(first.status, "completed");
    assert.equal(context.fixture.control.service.turns.size, 1);

    await assert.rejects(
      runVersionThreeWorkerLoop(context.input),
      (error) => error.code === "v3_driver_launch_failed" && error.acceptance === "acceptance_proven"
    );
    assert.equal(context.fixture.control.service.turns.size, 1);
  });

  it("refuses a caller-supplied Agent store and an unparseable deadline", async () => {
    const context = setup();
    await assert.rejects(
      () => runVersionThreeWorkerLoop({ ...context.input, agentStore: { listMessages: () => [] } }),
      /unsupported field: agentStore/
    );
    await assert.rejects(
      () => runVersionThreeWorkerLoop({ ...context.input, deadlineAt: "whenever" }),
      /deadlineAt must be one parseable timestamp/
    );
    assert.equal(context.fixture.control.service.turns.size, 0);
  });
});

describe("version-three worker loop: settlement ordering", () => {
  it("keeps a bounded wake cadence when its deadline has already elapsed", async () => {
    const context = setup();
    context.complete("completed", 900);

    const startedAt = Date.now();
    const result = await runVersionThreeWorkerLoop({
      ...context.input,
      // Already elapsed before the turn even starts: the wake window must still
      // never be zero, or the loop would starve the timer carrying the result.
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.ok(elapsed >= 900, `the turn's own timer must run (elapsed ${elapsed}ms)`);
    assert.ok(elapsed < 20_000, `the loop must not stall (elapsed ${elapsed}ms)`);
  });

  it("releases every matching lease before it publishes, and publishes before it disposes", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        dispose: async () => {
          // Observed at disposal time: publication has already happened.
          disposalView.events = readUnreadCompletionEvents(workspaceRoot, disposalView.ownerRootId).events.length;
          throw new Error("service disposal transport error");
        },
      }),
    });
    const disposalView = { ownerRootId: context.ownerRootId, events: null };
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);

    // Disposal failed, yet everything durable survives it.
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.agentReconciled, true);
    assert.equal(result.leasesReleased, true);
    assert.equal(result.disposed, false);
    assert.match(result.disposalFailure, /disposal transport error/);
    assert.equal(disposalView.events, 1, "the completion was published before disposal");
    assert.equal(context.events().length, 1);
    assert.equal(context.agent().status, "completed");
    assert.equal(context.leaseHeld(), false);
  });

  it("has already released its leases when terminal projection fails", async () => {
    const context = setup();
    // A directory where the inbox file belongs: publication fails, settlement
    // does not.
    fs.mkdirSync(resolveCompletionInboxFile(workspaceRoot, context.ownerRootId), { recursive: true });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "terminal_projection_failed");
    assert.equal(result.published, false);
    // Release precedes publication, so the lease is already gone.
    assert.equal(result.leasesReleased, true);
    assert.equal(context.leaseHeld(), false);
    // The Agent projection that did succeed is reported honestly.
    assert.equal(result.agentReconciled, true);
    assert.equal(result.disposed, true);
  });
});

/**
 * The seven findings an independent read-only acceptance review raised against
 * the first 5.4B candidate. Each test names the exact defect it reproduces and
 * asserts the durable property that now holds instead. Everything runs through
 * production persistence: a real version-three Agent, its real mailbox, real
 * leases, the real control stream, the real completion inbox, and the real
 * internal version-three job store.
 */
describe("version-three worker loop: durable settlement barrier", () => {
  it("F1: makes the terminal version-three job durable without ever entering the public job queue", async () => {
    const context = setup();
    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);

    assert.equal(result.status, "completed");
    assert.equal(result.durableRecord, "terminal");

    // The terminal receipt is a durable file, not an in-memory object that
    // died with the worker.
    const record = context.v3Record();
    assert.ok(record, "the terminal version-three job record must be durable");
    assert.equal(record.status, "completed");
    assert.equal(record.harnessStateVersion, 3);
    assert.equal(record.attemptId, context.attemptId);
    assert.equal(record.terminalJob.id, context.jobId);
    assert.equal(record.terminalJob.normalizedTerminalResult.status, "completed");
    assert.ok(record.agentProjectionReconciledAt);
    assert.ok(record.completionPublishedAt);

    // ...and the public version-one/two queue never sees it at all.
    assert.deepEqual(listStoredJobs(workspaceRoot), []);
    assert.equal(readJobFile(workspaceRoot, context.jobId), null);
    assert.deepEqual(reconcileCompletionEvents(workspaceRoot), []);

    // The completion event never advertises a detailed result the public path
    // cannot resolve; it stays self-contained instead.
    const event = context.events().find((candidate) => candidate.jobId === context.jobId);
    assert.equal(event.detailedResultAvailable, false);
    assert.equal(event.resultPointer, null);
    assert.ok(event.finalMessage);
  });

  it("F2: recovers a completion that could not be published, exactly once", async () => {
    const context = setup();
    // A directory where the inbox file belongs: publication fails, settlement
    // does not.
    fs.mkdirSync(resolveCompletionInboxFile(workspaceRoot, context.ownerRootId), { recursive: true });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "terminal_projection_failed");
    assert.equal(result.published, false);
    assert.equal(result.reconcilable, true);
    assert.equal(result.durableRecord, "terminal");

    // The worker process is gone; only durable state remains.
    const stranded = context.v3Record();
    assert.equal(stranded.status, "completed");
    assert.ok(stranded.agentProjectionReconciledAt);
    assert.equal(stranded.completionPublishedAt, null);

    // Clear the blocked inbox path; the completion is still absent, and no
    // public restart path can derive it -- the version-three record is the
    // only evidence that survived.
    fs.rmSync(resolveCompletionInboxFile(workspaceRoot, context.ownerRootId), { recursive: true, force: true });
    assert.equal(context.events().length, 0);
    assert.deepEqual(reconcileCompletionEvents(workspaceRoot), []);

    const first = reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION });
    assert.deepEqual(first.receipts.map((receipt) => [receipt.jobId, receipt.reconciled]), [[context.jobId, true]]);
    assert.equal(context.events().length, 1);
    assert.equal(context.events()[0].terminalStatus, "completed");

    // Idempotent: a second pass finds nothing left to do and publishes nothing.
    const second = reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION });
    assert.deepEqual(second.receipts, []);
    assert.equal(context.events().length, 1);
  });

  it("F2: persists a nonterminal uncertainty for every post-acceptance unknown exit", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        executionWorld: { continuity: "preserved", settlement: "unknown" },
      }),
    });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "execution_settlement_unknown");
    assert.equal(result.uncertaintyPersisted, true);
    assert.equal(result.durableRecord, "unknown");

    const record = context.v3Record();
    assert.equal(record.status, "unknown");
    assert.equal(record.uncertainty.reason, "execution_settlement_unknown");
    assert.ok(record.uncertainty.recordedAt);
    assert.equal(record.terminalJob, null);
    // Nothing was published and every lease is still held by its own owner.
    assert.equal(context.events().length, 0);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.agent().status, "running");
    // An uncertain turn is never reconcilable into a completion.
    assert.deepEqual(reconcileVersionThreeTerminalJobs({ ownerRootId: context.ownerRootId, generation: FUTURE_WRITE_GENERATION }).receipts, []);
  });

  it("F3/F4: holds the barrier against another process racing the settlement", async () => {
    const context = setup();
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;

    // Two separate processes hammer the isolated-caller entry points across
    // the whole settlement window. Nothing in this process can interleave with
    // a synchronous settlement sequence, so the contention has to be real.
    const payload = {
      cwd: workspaceRoot,
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      commandPrefix: `race-${sequence}`,
      // Generous: each contender stops as soon as it has proven it was still
      // writing after the barrier closed, so the window is a ceiling, not a
      // duration the test pays.
      windowMs: 20_000,
    };
    const races = Promise.all([
      runContender("messages", payload),
      runContender("commands", payload),
    ]);
    // Settle only once both contenders are demonstrably writing, so the
    // quiesce, the control-stream closure, the lease release, and the
    // publication all run while two other processes are actively contending
    // for this job's durable state. A fixed sleep would not do: this process's
    // own durable sweeps take the same synchronous locks the contenders hold,
    // so a timer here can be starved well past the contention window.
    await untilTrue(() => context.commands().length >= 2 && context.messages().length >= 2, 20_000);
    context.complete("completed", 0);
    const [result, [messageAttempts, commandAttempts]] = await Promise.all([loop, races]);
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.ok(messageAttempts.length > 0, "the message contender must have run");
    assert.ok(commandAttempts.length > 0, "the command contender must have run");

    // Invariant one: no accepted message is ever stranded on the terminal job.
    // Every one is either acknowledged (delivered) or queued for a later turn.
    const messages = context.messages();
    for (const message of messages) {
      if (message.messageId === context.input.assignedMessageIds[0]) continue;
      assert.ok(
        message.state === "acknowledged" || message.state === "queued" || message.state === "dispatched",
        `unexpected mailbox state ${message.state}`
      );
      if (message.state === "queued") assert.equal(message.assignedJobId, null);
      if (message.state === "dispatched") {
        // Only an unknown delivery outcome may stay pinned, and it says so.
        assert.equal(message.receipt.delivery, "unknown");
      }
    }
    // Everything still owed is reachable by the next turn.
    const owed = messages.filter((message) => message.state === "queued");
    const next = context.store.reserveActivation(context.agentId, `${context.jobId}-after-race`);
    assert.equal(next.reserved, true);
    assert.equal(next.assignedMessages.length, owed.length);

    // Invariant two: no durable command is left falsely active. Accepted ones
    // are settled against terminal evidence; the rest were refused outright.
    const accepted = commandAttempts.filter((attempt) => attempt.accepted).map((attempt) => attempt.commandId);
    const refused = commandAttempts.filter((attempt) => !attempt.accepted);
    for (const command of context.commands()) {
      assert.equal(command.settlement, "settled", `${command.commandId} must not stay pending`);
      assert.equal(command.nativeTurnState, "terminal", `${command.commandId} must not stay active`);
    }
    assert.deepEqual(
      context.commands().map((command) => command.commandId).sort(),
      [...accepted].sort()
    );
    for (const attempt of refused) assert.equal(attempt.code, "stream_closed");
    // The contention must actually straddle the barrier: some writes land
    // while the turn is live and some after it closed. Without both, this
    // test would pass vacuously on a race that never overlapped.
    assert.ok(accepted.length > 0, "the race must land commands before the stream closed");
    assert.ok(refused.length > 0, "the race must outlive the stream closure");
    assert.ok(
      messages.some((message) => message.state === "queued"),
      "the race must land messages the barrier had to queue or requeue"
    );
  });

  it("F4: settles a late command and refuses every command after the stream closes", async () => {
    const context = setup();
    const commandId = `late-interrupt-${sequence}`;
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;
    // Parked in its wake wait: this command lands after the last sweep, so the
    // worker never claims or requests it before the result arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));
    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 30_000,
    });
    context.fixture.control.complete(turn.turnId, "completed");

    const result = await loop;
    assert.equal(result.status, "completed");
    assert.equal(context.fixture.control.service.interruptRequests.length, 0);

    // Never requested -- and never left claiming the turn is still running.
    const command = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(command.requestState, "none");
    assert.equal(command.settlement, "settled");
    assert.equal(command.nativeTurnState, "terminal");
    assert.deepEqual(result.control.closure.settledCommandIds, [commandId]);

    const closure = readControlStreamClosure({
      ownerRootId: context.ownerRootId, agentId: context.agentId, jobId: context.jobId,
    });
    assert.equal(closure.closedByAttemptId, context.attemptId);
    assert.equal(closure.nativeTurnState, "terminal");

    // A later isolated caller fails closed instead of writing a command that
    // nothing could ever act on or settle.
    assert.throws(
      () => enqueueControlCommand({
        commandId: `${commandId}-after`,
        kind: "interrupt",
        ownerRootId: context.ownerRootId,
        agentId: context.agentId,
        jobId: context.jobId,
        route: context.route,
        nativeTurnRef: turn.nativeTurnRef,
      }),
      (error) => error.code === "stream_closed"
    );
  });

  it("F5: stops scanning an elapsed deadline instead of sweeping four times a second", async () => {
    const context = setup();
    const commandId = `deadline-${sequence}`;
    const registryPath = registryFile(context.ownerRootId);
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const turn = context.fixture.control.service.turns.values().next().value;
    enqueueControlCommand({
      commandId,
      kind: "interrupt",
      ownerRootId: context.ownerRootId,
      agentId: context.agentId,
      jobId: context.jobId,
      route: context.route,
      nativeTurnRef: turn.nativeTurnRef,
      deadlineMs: 1_000,
    });
    await untilTrue(
      () => context.commands().find((entry) => entry.commandId === commandId)?.settlement === "unknown",
      8_000
    );

    // The deadline has now elapsed and been recorded exactly once. Measure how
    // often the loop still touches durable state.
    let sweeps = 0;
    const watcher = fs.watch(path.dirname(registryPath), () => { sweeps += 1; });
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    watcher.close();
    const perSecond = sweeps / ((Date.now() - startedAt) / 1000);
    assert.ok(perSecond < 2, `an elapsed deadline must not pin the loop to its floor (${perSecond}/s)`);

    context.fixture.control.complete(turn.turnId, "completed");
    const result = await loop;
    assert.equal(result.status, "completed");
    // The expired command is still moved forward exactly once, by terminal
    // evidence -- never by a synthesized interruption.
    const settled = context.commands().find((entry) => entry.commandId === commandId);
    assert.equal(settled.settlement, "settled");
    assert.equal(settled.nativeTurnState, "terminal");
  });

  it("F6: accepts a terminal result whose locator names the same turn in another key order", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        // Same turn, same values, different key insertion order -- exactly
        // what a Driver that rebuilds its locator from a second service
        // response emits.
        nativeTurnRef: {
          locator: {
            turnId: result.nativeTurnRef.locator.turnId,
            sessionId: result.nativeTurnRef.locator.sessionId,
          },
          locatorVersion: result.nativeTurnRef.locatorVersion,
          instanceKey: result.nativeTurnRef.instanceKey,
          driverVersion: result.nativeTurnRef.driverVersion,
          harnessId: result.nativeTurnRef.harnessId,
          version: result.nativeTurnRef.version,
        },
      }),
    });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.leasesReleased, true);
    assert.equal(context.leaseHeld(), false);
    assert.equal(context.agent().status, "completed");
  });

  it("F6: still refuses a locator whose values name a different turn", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        nativeTurnRef: {
          ...result.nativeTurnRef,
          locator: { turnId: "service-turn-999", sessionId: result.nativeTurnRef.locator.sessionId },
        },
      }),
    });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "terminal_result_native_turn_mismatch");
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.v3Record().status, "unknown");
  });

  it("F7: reports exact lease-release evidence instead of a false boolean", async () => {
    const context = setup();
    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);

    assert.equal(result.status, "completed");
    assert.equal(result.leasesReleased, true);
    assert.deepEqual(result.leaseRelease, {
      outcome: "all",
      releasedCount: 1,
      alreadyReleasedCount: 0,
      retainedCount: 0,
      unknownCount: 0,
      failures: [],
    });
  });

  it("R1: settles a maximum-length ASCII final message without losing it", async () => {
    // The contract admits a final message of `MAX_FINAL_MESSAGE_CHARS`, and
    // this record persists *after* lease release: a valid Driver result the
    // durable capacity could not hold would strand a proven completion with
    // its leases already gone.
    const finalMessage = "x".repeat(MAX_FINAL_MESSAGE_CHARS);
    const context = setup({ resultOverride: (result) => ({ ...result, finalMessage }) });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(result.durableRecord, "terminal");

    const record = context.v3Record();
    assert.equal(record.status, "completed");
    // Stored exactly once, complete, in its one durable home.
    assert.equal(record.terminalJob.normalizedTerminalResult.finalMessage, finalMessage);
    assert.equal(Object.hasOwn(record.terminalJob.result, "rawOutput"), false);
    // ...and the summary is a bounded derived label, not a second copy.
    assert.ok(record.terminalJob.summary.length <= MAX_TERMINAL_JOB_SUMMARY_CHARS);
    assert.ok(record.terminalJob.summary.startsWith("xxx"));

    // The completion event still carries the complete deliverable.
    const event = context.events().find((candidate) => candidate.jobId === context.jobId);
    assert.equal(event.finalMessage, finalMessage);
    assert.equal(event.summary, record.terminalJob.summary);
  });

  it("R1: settles a maximum-length four-byte UTF-8 final message without losing it", async () => {
    // The contract's bound counts characters; this record's capacity counts
    // bytes. A message made entirely of four-byte code points is the widest
    // valid conversion between the two.
    const finalMessage = "\u{1F600}".repeat(MAX_FINAL_MESSAGE_CHARS / 2);
    assert.equal(finalMessage.length, MAX_FINAL_MESSAGE_CHARS);
    const context = setup({ resultOverride: (result) => ({ ...result, finalMessage }) });
    context.complete("completed");

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    assert.equal(result.published, true);
    assert.equal(context.v3Record().terminalJob.normalizedTerminalResult.finalMessage, finalMessage);
    assert.equal(
      context.events().find((candidate) => candidate.jobId === context.jobId).finalMessage,
      finalMessage
    );
    assert.equal(context.leaseHeld(), false);
    assert.equal(context.agent().status, "completed");
  });

  it("R2: quiesces the mailbox on an unknown exit and states that it did", async () => {
    const context = setup({
      resultOverride: (result) => ({
        ...result,
        executionWorld: { continuity: "preserved", settlement: "unknown" },
      }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    // Steering that was never delivered: the barrier owes it to the next turn.
    const steering = context.store.enqueueMessage(context.agentId, "Never delivered.").message;
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "execution_settlement_unknown");
    // The receipt says whether the barrier was applied.
    assert.equal(result.liveOwnershipQuiesce.quiesced, true);
    assert.equal(result.liveOwnershipQuiesce.reason, null);
    assert.equal(result.liveOwnershipCleared, true);

    // Durable, in any process: a later enqueue queues for the next turn
    // instead of binding to a turn nothing can deliver.
    const ownership = context.store.readVersionThreeTurnOwnership(context.agentId);
    assert.equal(ownership.state, "quiesced");
    assert.equal(ownership.jobId, context.jobId);
    const { message, delivery } = context.store.enqueueMessage(context.agentId, "After the unknown exit.");
    assert.equal(delivery, "queued_no_turn");
    assert.equal(message.state, "queued");
    assert.equal(message.assignedJobId, null);
    // The undelivered steering entry is owed again, not stranded.
    assert.equal(context.message(steering.messageId).state, "queued");

    // Everything the unknown exit must still hold is still held.
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);
    assert.equal(context.v3Record().status, "unknown");
    // The control stream stays open on purpose: an unknown turn is not proven
    // terminal, so Task 5.6 must still be able to settle against real
    // evidence. Closing it here would be the false claim.
    assert.equal(
      readControlStreamClosure({
        ownerRootId: context.ownerRootId, agentId: context.agentId, jobId: context.jobId,
      }),
      null
    );
  });

  it("R2: retains prompt-carried entries on an unknown exit instead of replaying them", async () => {
    sequence += 1;
    const ownerRootId = `root-v3-retain-${sequence}`;
    const jobId = `job-v3-retain-${sequence}`;
    const instanceKey = `tenant-retain-${sequence}`;
    const route = versionThreeRoute({ instanceKey, capabilities: versionThreeCapabilities() });
    const store = createAgentStore({ cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
    const agent = store.createAgent({ task_name: `v3_retain_${sequence}`, route, initialMessage: PROMPT });
    const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
    const promptMessageId = reservation.assignedMessages[0].messageId;

    // The barrier must never requeue an entry the launch prompt already
    // carried across the native boundary, so this entry is left exactly where
    // the crash found it: assigned, never replayed.
    store.markMessageDispatched(agent.agentId, promptMessageId, { jobId });
    store.acknowledgeMessage(agent.agentId, promptMessageId, {
      jobId, receipt: { acceptance: "proven" },
    });

    const quiesce = store.quiesceVersionThreeTurn(agent.agentId, jobId, { attemptId: "attempt-retain" });
    assert.equal(quiesce.quiesced, true);
    assert.deepEqual(quiesce.requeuedMessageIds, []);
    assert.deepEqual(quiesce.retainedMessageIds, []);

    // Now the same shape with an entry still assigned as `initial_prompt`.
    const second = createAgentStore({ cwd: workspaceRoot, ownerRootId: `${ownerRootId}-b`, writeGeneration: FUTURE_WRITE_GENERATION });
    const other = second.createAgent({ task_name: `v3_retain_b_${sequence}`, route, initialMessage: PROMPT });
    const otherJobId = `${jobId}-b`;
    const otherReservation = second.reserveActivation(other.agentId, otherJobId, { initial: true });
    const steering = second.enqueueMessage(other.agentId, "Steering, never delivered.").message;
    const receipt = second.quiesceVersionThreeTurn(other.agentId, otherJobId, { attemptId: "attempt-retain-b" });
    assert.deepEqual(receipt.retainedMessageIds, [otherReservation.assignedMessages[0].messageId]);
    assert.deepEqual(receipt.requeuedMessageIds, [steering.messageId]);
    // The prompt entry stays bound to its own finished turn; only the
    // never-delivered steering entry is owed again.
    const messages = second.listMessages(other.agentId);
    assert.equal(messages.find((entry) => entry.messageId === steering.messageId).state, "queued");
    assert.equal(
      messages.find((entry) => entry.messageId === otherReservation.assignedMessages[0].messageId).state,
      "assigned"
    );
  });

  it("R3: reports every pinned entry, including one pinned during delivery", async () => {
    const context = setup({
      liveTurnOverride: (live) => ({
        ...live,
        deliverActiveInput: async () => { throw new Error("service delivery failed"); },
      }),
      resultOverride: (result) => ({
        ...result,
        executionWorld: { continuity: "preserved", settlement: "unknown" },
      }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.turnId() != null);
    const { message } = context.store.enqueueMessage(context.agentId, "Delivery outcome unknown.");
    await untilTrue(() => context.message(message.messageId)?.state === "dispatched");
    context.complete("completed", 0);

    const result = await loop;
    assert.equal(result.status, "unknown");
    // The entry is pinned as dispatched-with-unknown-outcome, and the receipt
    // says so in the bucket a reader looks in.
    assert.ok(result.mailbox.pinnedMessageIds.includes(message.messageId));
    assert.ok(result.mailbox.dispatchedUnacknowledgedMessageIds.includes(message.messageId));
    assert.equal(context.message(message.messageId).state, "dispatched");
    assert.equal(context.message(message.messageId).receipt.delivery, "unknown");
    // Never requeued: replaying it could duplicate work the Harness already did.
    assert.equal(result.mailbox.requeuedMessageIds.includes(message.messageId), false);
  });

  it("R2: quiesces even when no durable version-three record could be created", async () => {
    const context = setup();
    // A file where this owner root's version-three job directory belongs: the
    // durable lifecycle record cannot be created at all.
    const directory = resolveVersionThreeJobDirectory({ ownerRootId: context.ownerRootId });
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.writeFileSync(directory, "not a directory", "utf8");
    context.complete("completed", 0);

    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "v3_job_record_unavailable");
    assert.equal(result.uncertaintyPersisted, false);
    // Nothing was published and every lease is still held.
    assert.equal(result.published, false);
    assert.equal(context.leaseHeld(), true);
    assert.equal(context.events().length, 0);

    // The worker still stopped advertising a live turn, and said so.
    assert.equal(result.liveOwnershipQuiesce.quiesced, true);
    assert.equal(result.liveOwnershipCleared, true);
    // The prompt entry crossed the native boundary at launch, so it is
    // retained rather than requeued: the barrier must never replay it.
    assert.deepEqual(
      result.liveOwnershipQuiesce.retainedMessageIds,
      [context.input.assignedMessageIds[0]]
    );
    assert.deepEqual(result.liveOwnershipQuiesce.requeuedMessageIds, []);
    assert.equal(context.message(context.input.assignedMessageIds[0]).state, "assigned");
    const { delivery } = context.store.enqueueMessage(context.agentId, "After an unavailable record.");
    assert.equal(delivery, "queued_no_turn");

    fs.rmSync(directory, { force: true });
  });

  it("R4: persists the canonical workspace root the reconciler reopens from", async () => {
    const context = setup();
    context.complete("completed");
    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");
    const record = context.v3Record();
    assert.equal(record.workspaceRoot, canonicalAgentWorkspaceRoot(workspaceRoot));
    // Canonical means idempotent: reopening from the stored value resolves to
    // the same workspace the worker used.
    assert.equal(canonicalAgentWorkspaceRoot(record.workspaceRoot), record.workspaceRoot);
  });

  it("R4: refuses a cwd and workspaceRoot that name different canonical workspaces", async () => {
    const context = setup();
    const foreign = fs.mkdtempSync(path.join(root, "foreign-workspace-"));
    await assert.rejects(
      () => runVersionThreeWorkerLoop({ ...context.input, workspaceRoot: foreign }),
      /different canonical workspaces/
    );
    // Refused before launch: no native turn was ever started.
    assert.equal(context.turnId(), null);
    assert.equal(context.v3Record(), null);
  });

  it("R5: never claims live ownership was cleared unless the barrier says so", async () => {
    // One invariant across every reachable exit: `liveOwnershipCleared` is the
    // barrier receipt's own answer, never an independent claim.
    const settled = setup();
    settled.complete("completed");
    const terminal = await runVersionThreeWorkerLoop(settled.input);

    const unknown = setup({
      resultOverride: (result) => ({
        ...result,
        executionWorld: { continuity: "unknown", settlement: "unknown" },
      }),
    });
    unknown.complete("completed");
    const unresolved = await runVersionThreeWorkerLoop(unknown.input);

    const aborted = setup();
    const controller = new AbortController();
    const abortedLoop = runVersionThreeWorkerLoop({ ...aborted.input, signal: controller.signal });
    await untilTrue(() => aborted.turnId() != null);
    controller.abort();
    const abortedResult = await abortedLoop;

    for (const outcome of [terminal, unresolved, abortedResult]) {
      assert.equal(
        outcome.liveOwnershipCleared,
        outcome.liveOwnershipQuiesce?.quiesced === true,
        `${outcome.reason} disagrees with its own barrier receipt`
      );
    }
    assert.equal(terminal.status, "completed");
    assert.equal(unresolved.reason, "execution_settlement_unknown");
    assert.equal(abortedResult.reason, "aborted");
  });

  it("F3: quiesce is a durable barrier a later enqueue in any process must obey", async () => {
    const context = setup();
    context.complete("completed");
    await runVersionThreeWorkerLoop(context.input);

    // After a settled turn the Agent owns no live turn at all, so the marker
    // is gone and a new message queues for the next turn.
    assert.equal(context.store.readVersionThreeTurnOwnership(context.agentId), null);
    const { message, delivery } = context.store.enqueueMessage(context.agentId, "after settlement");
    assert.equal(message.state, "queued");
    assert.equal(delivery, "queued_no_turn");
  });
});
