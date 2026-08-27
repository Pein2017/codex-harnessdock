import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import {
  claimNativeSubmissionStartAsync,
  createLaunchClaim,
  createLaunchClaimAsync,
  readLaunchClaim,
  resolveLaunchClaimDirectory,
} from "../../runtime/launch-claim.mjs";
import { getProcessIdentity } from "../../runtime/process-control.mjs";
import {
  driverPreTransportRejection,
  launchVersionThreeTurn,
} from "../../runtime/v3-worker-launch.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-v3-worker-launch-"));
const workspaceRoot = path.join(root, "workspace");
fs.mkdirSync(workspaceRoot);
process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");

after(() => fs.rmSync(root, { recursive: true, force: true }));

let sequence = 0;

function setup(options = {}) {
  sequence += 1;
  const ownerRootId = `root-v3-launch-${sequence}`;
  const agentId = `agent-v3-launch-${sequence}`;
  const jobId = `job-v3-launch-${sequence}`;
  const attemptId = `attempt-v3-launch-${sequence}`;
  const instanceKey = `tenant-launch-${sequence}`;
  const route = versionThreeRoute({ instanceKey });
  const fixture = createFakeServiceDriver({
    autoComplete: false,
    instances: [{ instanceKey, readiness: "ready", detailCode: "ready" }],
  });
  const baseDriver = fixture.driver;
  let startCalls = 0;
  let observedAtStart = null;
  const driver = Object.freeze({
    ...baseDriver,
    async startTurn(input) {
      startCalls += 1;
      observedAtStart = readLaunchClaim({ ownerRootId, agentId, jobId });
      if (options.startError === "ambiguous") throw new Error("service transport closed during submit");
      if (options.startError === "rejected") throw driverPreTransportRejection();
      return baseDriver.startTurn(input);
    },
  });
  const preparedInput = "Inspect only.\n\nReturn one bounded finding.";
  const preparedTurn = driver.prepareTurn({ route, taskInput: preparedInput });
  const lease = acquireInstanceLease({
    ownerRootId,
    agentId,
    jobId,
    route,
    harnessId: route.harnessId,
    instanceKey: route.instanceKey,
    capacityClass: "fake-service-test",
    capacityLimit: 1,
  });
  const input = {
    ownerRootId,
    agentId,
    jobId,
    attemptId,
    route,
    driver,
    preparedTurn,
    preparedInput,
    assignedMessageIds: [`message-${sequence}`],
    assignedInputs: [],
    leaseBindings: [lease],
    // Stated explicitly: this fixture's Driver owns no turn options.
    turnOptions: null,
    workspaceRoot,
    env: { FAKE_SERVICE_HOME: path.join(root, "fake-service") },
  };
  createLaunchClaim({
    ownerRootId,
    agentId,
    jobId,
    attemptId,
    route,
    leaseBindings: [lease],
    assignedMessageIds: input.assignedMessageIds,
    preparedInput,
    turnOptions: null,
  });
  return {
    input,
    route,
    fixture,
    lease,
    get startCalls() { return startCalls; },
    get observedAtStart() { return observedAtStart; },
  };
}

describe("version-three worker launch acceptance core", () => {
  it("persists claim and submission fence before startTurn, then exact acceptance before returning", async () => {
    const context = setup();
    const launched = await launchVersionThreeTurn(context.input);

    assert.equal(context.startCalls, 1);
    assert.equal(context.observedAtStart.acceptance, "not_submitted");
    assert.equal(context.observedAtStart.submissionState, "started");
    assert.equal(launched.launchClaim.acceptance, "acceptance_proven");
    assert.deepEqual(launched.launchClaim.nativeTurnRef, launched.liveTurn.nativeTurnRef);
    assert.deepEqual(launched.launchClaim.nativeSessionRef, launched.liveTurn.nativeSessionRef);
    assert.equal(readLaunchClaim(context.input).acceptance, "acceptance_proven");
  });

  it("records ambiguous submission as unknown, retains the lease, and never submits an idempotent replay", async () => {
    const context = setup({ startError: "ambiguous" });

    await assert.rejects(
      launchVersionThreeTurn(context.input),
      (error) => error.code === "v3_driver_launch_failed" && error.acceptance === "acceptance_unknown"
    );
    assert.equal(context.startCalls, 1);
    const durable = readLaunchClaim(context.input);
    assert.equal(durable.submissionState, "started");
    assert.equal(durable.acceptance, "acceptance_unknown");

    await assert.rejects(launchVersionThreeTurn(context.input), /cannot be replayed/);
    assert.equal(context.startCalls, 1);
    assert.throws(
      () => acquireInstanceLease({
        ownerRootId: `${context.input.ownerRootId}-competitor`,
        agentId: `${context.input.agentId}-competitor`,
        jobId: `${context.input.jobId}-competitor`,
        route: context.route,
        harnessId: context.route.harnessId,
        instanceKey: context.route.instanceKey,
        capacityClass: "fake-service-test",
        capacityLimit: 1,
      }),
      /capacity exhausted/
    );
  });

  it("lets exactly one concurrent caller submit the same attempt", async () => {
    const context = setup();
    const outcomes = await Promise.allSettled([
      launchVersionThreeTurn(context.input),
      launchVersionThreeTurn(context.input),
      launchVersionThreeTurn(context.input),
      launchVersionThreeTurn(context.input),
    ]);
    assert.equal(context.startCalls, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(readLaunchClaim(context.input).acceptance, "acceptance_proven");
    for (const outcome of outcomes.filter((candidate) => candidate.status === "rejected")) {
      assert.notEqual(outcome.reason.acceptance, "not_submitted");
    }
  });

  it("reports a crash-after-fence replay as unpersisted unknown, never rollback-safe not_submitted", async () => {
    const context = setup();
    const identity = {
      ownerRootId: context.input.ownerRootId,
      agentId: context.input.agentId,
      jobId: context.input.jobId,
      attemptId: context.input.attemptId,
    };
    await createLaunchClaimAsync({
      ...identity,
      route: context.input.route,
      leaseBindings: context.input.leaseBindings,
      assignedMessageIds: context.input.assignedMessageIds,
      preparedInput: context.input.preparedInput,
      turnOptions: context.input.turnOptions,
    });
    assert.equal((await claimNativeSubmissionStartAsync(identity)).started, true);

    await assert.rejects(launchVersionThreeTurn(context.input), (error) => {
      assert.equal(error.acceptance, "acceptance_unknown");
      assert.equal(error.acceptancePersisted, false);
      return true;
    });
    assert.equal(context.startCalls, 0);
  });

  it("records only the exact branded Driver pre-transport rejection as acceptance_rejected", async () => {
    const context = setup({ startError: "rejected" });
    await assert.rejects(
      launchVersionThreeTurn(context.input),
      (error) => error.code === "v3_driver_launch_failed" && error.acceptance === "acceptance_rejected"
    );
    const durable = readLaunchClaim(context.input);
    assert.equal(durable.submissionState, "started");
    assert.equal(durable.acceptance, "acceptance_rejected");
    assert.equal(durable.sanitizedDetail, "driver_pre_transport_rejection");

    const forged = setup();
    forged.input.driver = Object.freeze({
      ...forged.input.driver,
      async startTurn() {
        const error = new Error("looks rejected");
        error.code = "driver_pre_transport_rejection";
        throw error;
      },
    });
    await assert.rejects(
      launchVersionThreeTurn(forged.input),
      (error) => error.acceptance === "acceptance_unknown"
    );
  });

  it("refuses foreign claim identity and a different attempt before a second native submission", async () => {
    const context = setup();
    await assert.rejects(
      launchVersionThreeTurn({ ...context.input, ownerRootId: `${context.input.ownerRootId}-foreign` }),
      /No launch claim exists/
    );
    assert.equal(context.startCalls, 0);

    await launchVersionThreeTurn(context.input);
    await assert.rejects(
      launchVersionThreeTurn({ ...context.input, attemptId: `${context.input.attemptId}-other` }),
      /different attempt|does not match/
    );
    assert.equal(context.startCalls, 1);
  });

  it("snapshots identity and exact prompt once before the first await", async () => {
    const context = setup();
    const originalAgentId = context.input.agentId;
    const originalPrompt = context.input.preparedInput;
    const baseDriver = context.input.driver;
    context.input.driver = Object.freeze({
      ...baseDriver,
      async revalidatePreparedTurn(preparedTurn, scope) {
        context.input.agentId = `${originalAgentId}-mutated`;
        context.input.preparedInput = "DECOY AFTER REVALIDATION";
        context.input.assignedMessageIds.push("message-mutated");
        return baseDriver.revalidatePreparedTurn(preparedTurn, scope);
      },
    });

    const launched = await launchVersionThreeTurn(context.input);
    assert.equal(launched.launchClaim.agentId, originalAgentId);
    assert.deepEqual(launched.launchClaim.assignedMessageIds, [context.input.assignedMessageIds[0]]);
    assert.equal(context.fixture.control.service.prompts[0].taskInput, originalPrompt);
    assert.equal(readLaunchClaim({
      ownerRootId: context.input.ownerRootId,
      agentId: originalAgentId,
      jobId: context.input.jobId,
    }).acceptance, "acceptance_proven");
  });

  it("refuses accessor-bearing launch input without invoking the accessor", async () => {
    const context = setup();
    let getterCalls = 0;
    Object.defineProperty(context.input, "preparedInput", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "forged prompt";
      },
    });
    await assert.rejects(launchVersionThreeTurn(context.input), /plain value, not an accessor/);
    assert.equal(getterCalls, 0);
    assert.equal(context.startCalls, 0);
  });

  it("refuses nested accessor/Proxy prepared turns without invoking Driver-owned hooks", async () => {
    const accessor = setup();
    let getterCalls = 0;
    const envelope = { ...accessor.input.preparedTurn.promptEnvelope };
    Object.defineProperty(envelope, "taskInput", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? accessor.input.preparedInput : "DECOY";
      },
    });
    accessor.input.preparedTurn = { ...accessor.input.preparedTurn, promptEnvelope: envelope };
    await assert.rejects(launchVersionThreeTurn(accessor.input), /plain value, not an accessor/);
    assert.equal(getterCalls, 0);
    assert.equal(accessor.startCalls, 0);

    const proxied = setup();
    let proxyGets = 0;
    proxied.input.preparedTurn = new Proxy(proxied.input.preparedTurn, {
      get(target, property, receiver) {
        proxyGets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await assert.rejects(launchVersionThreeTurn(proxied.input), /plain object, not a Proxy/);
    assert.equal(proxyGets, 0);
    assert.equal(proxied.startCalls, 0);
  });

  it("preserves semantic unknown and the original cause when acceptance persistence is unavailable", async () => {
    const context = setup();
    const claimDirectory = resolveLaunchClaimDirectory(context.input);
    const lockFile = path.join(claimDirectory, ".lock");
    const baseDriver = context.input.driver;
    context.input.driver = Object.freeze({
      ...baseDriver,
      async startTurn(input) {
        const live = await baseDriver.startTurn(input);
        fs.writeFileSync(lockFile, JSON.stringify({
          pid: process.pid,
          identity: getProcessIdentity(process.pid),
          token: "wedged-after-native-start",
          timestamp: Date.now(),
        }), { mode: 0o600 });
        return live;
      },
    });

    try {
      await assert.rejects(launchVersionThreeTurn(context.input), (error) => {
        assert.equal(error.code, "v3_driver_launch_failed");
        assert.equal(error.acceptance, "acceptance_unknown");
        assert.equal(error.acceptancePersisted, false);
        assert.equal(error.cause?.code, "ETIMEDOUT");
        assert.equal(error.persistenceError?.code, "ETIMEDOUT");
        return true;
      });
    } finally {
      fs.unlinkSync(lockFile);
    }
    assert.equal(context.startCalls, 1);
    const durable = readLaunchClaim(context.input);
    assert.equal(durable.acceptance, "not_submitted");
    assert.equal(durable.submissionState, "started");
  });

  it("yields the parent event loop while a live launch-claim lock is held", async () => {
    const context = setup();
    const claimDirectory = resolveLaunchClaimDirectory(context.input);
    fs.mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
    const lockFile = path.join(claimDirectory, ".lock");
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      identity: getProcessIdentity(process.pid),
      token: "held-by-test",
      timestamp: Date.now(),
    }), { mode: 0o600 });

    let heartbeats = 0;
    const interval = setInterval(() => { heartbeats += 1; }, 10);
    const startedAt = Date.now();
    try {
      await assert.rejects(launchVersionThreeTurn(context.input), (error) => error?.code === "ETIMEDOUT");
    } finally {
      clearInterval(interval);
      fs.unlinkSync(lockFile);
    }
    assert.ok(Date.now() - startedAt >= 1_500);
    assert.ok(heartbeats >= 25, `expected an unblocked event loop, observed only ${heartbeats} heartbeats`);
    assert.equal(context.startCalls, 0);
  });
});
