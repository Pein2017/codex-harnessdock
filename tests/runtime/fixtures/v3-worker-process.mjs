/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * A real, separate version-three worker process for Task 5.6 worker-loss
 * integration tests.
 *
 * Simulating "the worker vanished" in-process can only ever abandon a
 * Promise; it never proves the runtime survives an actual process death with
 * zero chance to run any further JavaScript. This fixture is a genuine child
 * process that performs real durable Agent creation, activation, instance
 * leasing, and (depending on `mode`) a real version-three launch/worker loop
 * -- then parks at one exact, deterministic checkpoint and prints `READY` so
 * the parent test can send `SIGKILL` at that precise point rather than
 * guessing with a timer. Everything durable it writes before the kill stays
 * on disk under the shared `CODEX_HARNESSDOCK_RUNTIME_HOME`/workspace root the
 * parent test passes through `env`/`payload.workspaceRoot`; nothing here is
 * read back except by the parent reopening that same durable state.
 *
 * Modes:
 *   claim_before_submission     durably create the launch claim, then hang
 *                                before the native-submission fence is ever
 *                                crossed (`submissionState` stays
 *                                `not_started`) -- Task 5.6 scenario 1.
 *   hang_during_native_submission  cross the submission-start fence, then
 *                                hang inside the Driver's own `startTurn()`
 *                                before it can return -- scenario 2.
 *   hang_while_running           complete native acceptance and let the
 *                                worker loop become durably `running`, then
 *                                hang forever without ever settling --
 *                                scenario 3's "worker vanished mid-turn".
 *   settle_on_trigger            complete native acceptance, report `READY`
 *                                once the record is durably `running`, then
 *                                settle its own live turn as soon as the
 *                                parent creates `payload.triggerFile`. This
 *                                process is never killed: it is the live
 *                                worker half of the real two-process
 *                                worker/reconciler convergence test.
 */

import fs from "node:fs";

import { createAgentStore } from "../../../runtime/agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "../../../runtime/durable-state-v3.mjs";
import {
  acquireInstanceLease,
  acquireIntendedInstanceLease,
  acquireIntendedNativeSessionLease,
  acquireNativeSessionLease,
} from "../../../runtime/instance-admission-lease.mjs";
import {
  bindLaunchClaimLease,
  createLaunchClaimAsync,
  createLaunchIntent,
} from "../../../runtime/launch-claim.mjs";
import { readVersionThreeJobRecord } from "../../../runtime/v3-job-store.mjs";
import { runVersionThreeWorkerLoop } from "../../../runtime/v3-worker-loop.mjs";
import { createFakeServiceDriver } from "./fake-service-driver.mjs";
import { versionThreeCapabilities, versionThreeRoute } from "./version-three-state.mjs";

const [, , mode, payloadText] = process.argv;
const payload = JSON.parse(payloadText);

function report(kind, data) {
  process.stdout.write(`${kind}:${JSON.stringify(data)}\n`);
}

function hangForever() {
  return new Promise(() => {});
}

async function run() {
  const route = versionThreeRoute({
    instanceKey: payload.instanceKey,
    capabilities: versionThreeCapabilities(payload.capabilityOverrides ?? {}),
  });
  const store = createAgentStore({
    cwd: payload.workspaceRoot,
    ownerRootId: payload.ownerRootId,
    writeGeneration: FUTURE_WRITE_GENERATION,
  });
  const agent = store.createAgent({ task_name: payload.taskName, route, initialMessage: payload.promptText });
  const reservation = store.reserveActivation(agent.agentId, payload.jobId, { initial: true });
  report("IDENTITY", { agentId: agent.agentId });
  const identity = { ownerRootId: payload.ownerRootId, agentId: agent.agentId, jobId: payload.jobId };
  if (["intent_before_acquire", "intent_after_acquire", "intent_after_binding"].includes(mode)) {
    createLaunchIntent({
      ...identity,
      attemptId: payload.attemptId,
      lifecycleOwner: "version_three_worker",
      route,
      expectedLease: payload.nativeSessionId == null
        ? { kind: "instance", capacityClass: payload.capacityClass, capacityLimit: 1 }
        : { kind: "native_session", nativeSessionId: payload.nativeSessionId },
      assignedMessageIds: reservation.assignedMessages.map((entry) => entry.messageId),
      preparedInput: payload.promptText,
      turnOptions: null,
      inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
    });
    if (mode === "intent_before_acquire") {
      report("READY", {});
      await hangForever();
      return;
    }
  }
  const hasIntent = ["intent_before_acquire", "intent_after_acquire", "intent_after_binding"].includes(mode);
  const lease = payload.nativeSessionId == null
    ? (hasIntent ? acquireIntendedInstanceLease : acquireInstanceLease)({
        ownerRootId: payload.ownerRootId,
        agentId: agent.agentId,
        jobId: payload.jobId,
        ...(hasIntent ? { attemptId: payload.attemptId } : {}),
        route,
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        capacityClass: payload.capacityClass,
        capacityLimit: 1,
      })
    : (hasIntent ? acquireIntendedNativeSessionLease : acquireNativeSessionLease)({
        ownerRootId: payload.ownerRootId,
        agentId: agent.agentId,
        jobId: payload.jobId,
        ...(hasIntent ? { attemptId: payload.attemptId } : {}),
        route,
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        nativeSessionId: payload.nativeSessionId,
      });
  if (mode === "intent_after_acquire") {
    report("READY", {});
    await hangForever();
    return;
  }
  if (mode === "intent_after_binding") {
    bindLaunchClaimLease({ ...identity, attemptId: payload.attemptId, lease });
    report("READY", {});
    await hangForever();
    return;
  }

  if (mode === "claim_before_submission") {
    // Durably bind the claim -- exactly what `launchVersionThreeTurn()` does
    // before it ever touches the Driver -- then hang before the
    // submission-start fence is crossed at all. No native call is possible
    // from this state.
    await createLaunchClaimAsync({
      ...identity,
      attemptId: payload.attemptId,
      route,
      leaseBindings: [lease],
      assignedMessageIds: reservation.assignedMessages.map((entry) => entry.messageId),
      preparedInput: payload.promptText,
      // Stated explicitly, exactly as `launchVersionThreeTurn()` states it:
      // this fixture's Driver owns no turn options.
      turnOptions: null,
      inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
    });
    report("READY", {});
    await hangForever();
    return;
  }

  const fixture = createFakeServiceDriver({
    harnessId: route.harnessId,
    driverVersion: route.driverVersion,
    instances: [{ instanceKey: payload.instanceKey, readiness: "ready", detailCode: "ready" }],
    capabilities: versionThreeCapabilities(payload.capabilityOverrides ?? {}),
    autoComplete: false,
  });
  let driver = fixture.driver;
  if (mode === "hang_during_native_submission") {
    // The pre-submission fence (`markNativeSubmissionStarted`) has already
    // been crossed by the time `launchVersionThreeTurn()` calls this: hang
    // before any request could possibly reach (or fail to reach) the
    // Harness, so acceptance can never durably resolve.
    driver = {
      ...fixture.driver,
      startTurn: async () => {
        report("READY", {});
        await hangForever();
      },
    };
  }

  const preparedTurn = fixture.driver.prepareTurn({ route, taskInput: payload.promptText });
  const input = {
    ...identity,
    attemptId: payload.attemptId,
    route,
    driver,
    preparedTurn,
    preparedInput: payload.promptText,
    assignedMessageIds: reservation.assignedMessages.map((entry) => entry.messageId),
    assignedInputs: [],
    leaseBindings: [lease],
    // Stated explicitly: this fixture's Driver owns no turn options.
    turnOptions: null,
    workspaceRoot: payload.workspaceRoot,
    env: {},
    ensureResidencyManager: async () => undefined,
    cwd: payload.workspaceRoot,
  };

  await createLaunchClaimAsync({
    ...identity,
    attemptId: payload.attemptId,
    route,
    leaseBindings: [lease],
    assignedMessageIds: input.assignedMessageIds,
    preparedInput: payload.promptText,
    turnOptions: null,
    inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
  });

  if (mode === "hang_while_running") {
    // Fire and forget: proven native acceptance must land durably before this
    // process hangs, exactly like a worker that is later killed mid-turn.
    runVersionThreeWorkerLoop(input).catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const record = readVersionThreeJobRecord(identity);
      if (record?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    report("READY", {});
    await hangForever();
    return;
  }

  if (mode === "settle_on_trigger") {
    const loop = runVersionThreeWorkerLoop(input);
    const runningDeadline = Date.now() + 10_000;
    while (Date.now() < runningDeadline) {
      const record = readVersionThreeJobRecord(identity);
      if (record?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    report("READY", {});
    // The parent creates the trigger file and starts its own reconciliation
    // in the same instant; this process then settles its own live turn.
    const triggerDeadline = Date.now() + 10_000;
    while (Date.now() < triggerDeadline && !fs.existsSync(payload.triggerFile)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [turnId] = fixture.control.turnIds();
    fixture.control.complete(turnId, "completed");
    report("RECEIPT", await loop);
    return;
  }

  if (mode === "hang_during_native_submission") {
    // `READY` is reported from inside the wrapped `startTurn()` above, right
    // as the pre-submission fence has been crossed and before any request
    // could possibly reach the Harness. The loop call itself just hangs
    // there until this process is killed.
    await runVersionThreeWorkerLoop(input);
    return;
  }

  throw new Error(`Unsupported v3-worker-process mode: ${mode}`);
}

run().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
});
