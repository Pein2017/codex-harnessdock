/** SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAgentStore } from "../../runtime/agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import { createOpencodeServiceManager } from "../../runtime/opencode-service-manager.mjs";
import { resolvePluginRuntimeRoot } from "../../runtime/paths.mjs";
import {
  UNKNOWN_RECLAIM_MS,
  ensureResidencyManager,
  hardReclaimDeadline,
  resolveResidencyManagerPaths,
  runResidencyManager,
} from "../../runtime/residency-manager.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-residency-"));
  roots.push(root);
  return { stateRoot: path.join(root, "state"), runtimeRoot: path.join(root, "runtime") };
}

function turnRef(route, turnId = "native-turn") {
  return {
    version: 1, harnessId: route.harnessId, driverVersion: route.driverVersion,
    instanceKey: route.instanceKey, locatorVersion: 1, locator: { turnId },
  };
}

function fixture(overrides = {}) {
  const route = versionThreeRoute();
  const recordedAt = new Date(1_000).toISOString();
  const record = {
    version: 2, harnessStateVersion: 3, ownerRootId: "root", agentId: "agent", jobId: "job", attemptId: "attempt",
    workspaceRoot: "/workspace", controlRoot: "/workspace", executionRoot: "/workspace", route,
    nativeTurnRef: turnRef(route), status: "unknown",
    uncertainty: { reason: "worker_lost", detail: null, recordedAt }, terminalJob: null,
    progress: null, progressDeliveredRevision: 0,
    worker: { pid: 71, identity: "worker-71" },
    physicalResidency: { kind: "local_process", pid: 72, identity: "native-72" }, hardReclaim: null,
    agentProjectionReconciledAt: null, completionPublishedAt: null,
    createdAt: recordedAt, updatedAt: recordedAt, ...overrides,
  };
  const claim = {
    version: 3, ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
    attemptId: record.attemptId, controlRoot: record.controlRoot, executionRoot: record.executionRoot,
    lifecycleOwner: "version_three_worker", route: record.route, leaseState: "acquired",
    leaseBindings: [
      { kind: "instance", ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
        keyFields: { harnessId: route.harnessId, instanceKey: route.instanceKey } },
      { kind: "writer", ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
        keyFields: { workspaceRoot: record.workspaceRoot } },
    ],
    submissionState: "started", acceptance: "acceptance_proven", nativeTurnRef: record.nativeTurnRef,
    provisionalNativeTurnRef: record.nativeTurnRef, worker: record.worker, physicalResidency: record.physicalResidency,
  };
  return { record, claim };
}

function statefulManager({ record: initialRecord, claim: initialClaim, now = 1_000 + UNKNOWN_RECLAIM_MS, serviceManager } = {}) {
  const isolated = temporaryRoots();
  let record = initialRecord ?? fixture().record;
  let claim = initialClaim ?? fixture().claim;
  const calls = { reconcile: 0, uncertain: 0, claim: 0, marker: 0, signal: 0, release: 0, projection: 0, waits: [] };
  const options = {
    ...isolated,
    generation: FUTURE_WRITE_GENERATION,
    serviceManager: serviceManager ?? {
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    },
    _test: {
      now: () => now,
      listJobs: () => ({ records: record == null ? [] : [structuredClone(record)], unreadable: [] }),
      listClaims: () => ({ records: [], unreadable: [] }),
      readJob: () => record == null ? null : structuredClone(record),
      readClaim: () => claim == null ? null : structuredClone(claim),
      agentOwns: () => true,
      isAlive: (pid) => pid === 72,
      validateIdentity: (pid, identity) => pid === 72 && identity === "native-72",
      resolveDriver: () => ({ harnessId: record?.route?.harnessId, driverVersion: record?.route?.driverVersion }),
      async reconcileWorkerLoss() { calls.reconcile += 1; },
      recordWorkerLostUncertain() {
        calls.uncertain += 1;
        record = { ...record, status: "unknown", uncertainty: { reason: "worker_lost", detail: null, recordedAt: new Date(now).toISOString() }, progress: null };
        return record;
      },
      terminate() { calls.signal += 1; return { attempted: true, delivered: true }; },
      releaseLeases({ releases }) {
        calls.release += 1;
        return { outcome: "all", dispositions: releases.map((target) => ({ kind: target.kind, disposition: "released", code: null })) };
      },
      claimHardReclaim() {
        calls.claim += 1;
        if (record.hardReclaim == null) record = { ...record, hardReclaim: { phase: "claimed", terminationAttemptedAt: null, failureCode: null } };
        return record;
      },
      markTerminationAttempted() {
        calls.marker += 1;
        record = { ...record, hardReclaim: { ...record.hardReclaim, terminationAttemptedAt: new Date(now).toISOString() } };
        return record;
      },
      recordReclaimFailure({ failureCode }) {
        record = { ...record, hardReclaim: { ...record.hardReclaim, failureCode } };
        return record;
      },
      recordPhysicalDeath({ physicalDisposition }) {
        record = { ...record, hardReclaim: { ...record.hardReclaim, phase: "physical_dead", physicalDisposition } };
        return record;
      },
      recordLeasePending({ leaseDisposition, failureCode = null }) {
        record = { ...record, hardReclaim: { ...record.hardReclaim, phase: "lease_pending", leaseDisposition, failureCode } };
        return record;
      },
      commitHardReclaim() {
        record = { ...record, status: "hard_reclaimed", hardReclaim: { ...record.hardReclaim, phase: "committed" } };
        return record;
      },
      updateCommittedDisposition({ leaseDisposition, physicalDisposition }) {
        record = { ...record, hardReclaim: { ...record.hardReclaim, leaseDisposition, physicalDisposition } };
        return record;
      },
      reconcileHardReclaim() {
        calls.projection += 1;
        record = { ...record, agentProjectionReconciledAt: record.agentProjectionReconciledAt ?? new Date(now).toISOString(),
          completionPublishedAt: record.completionPublishedAt ?? new Date(now).toISOString() };
        return { reconciled: true, agentProjected: true, completionPublished: true };
      },
      async waitForActivity(waitOptions) {
        calls.waits.push(waitOptions);
        record = null;
        return { wakeReason: "watcher" };
      },
    },
  };
  return {
    isolated, calls, options,
    get record() { return record; },
    setRecord(value) { record = value; },
    setClaim(value) { claim = value; },
  };
}

describe("residency manager", () => {
  it("keeps state and runtime roots distinct and removes the MCP-owned timer", () => {
    const stateRoot = path.join(os.tmpdir(), "state-only");
    const paths = resolveResidencyManagerPaths({ stateRoot });
    assert.equal(paths.stateRoot, stateRoot);
    assert.equal(paths.runtimeRoot, resolvePluginRuntimeRoot());
    assert.notEqual(paths.runtimeRoot, path.join(stateRoot, "runtime"));
    assert.equal(createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot: temporaryRoots().runtimeRoot,
      probe: async () => ({ kind: "healthy" }),
    }).scheduleReap, undefined);
  });

  it("retains a current unknown turn before the exact fixed boundary and never refreshes it", async () => {
    const { record, claim } = fixture({ updatedAt: new Date(9_999_999).toISOString() });
    const manager = statefulManager({ record, claim, now: 1_000 + UNKNOWN_RECLAIM_MS - 1 });
    await runResidencyManager(manager.options);
    assert.equal(hardReclaimDeadline(record), 1_000 + UNKNOWN_RECLAIM_MS);
    assert.equal(manager.calls.claim, 0);
    assert.equal(manager.calls.release, 0);
    assert.equal(manager.calls.signal, 0);
    assert.equal(manager.calls.waits[0].deadline, 1_000 + UNKNOWN_RECLAIM_MS);
  });

  it("retains a healthy running worker older than one hour and converts only an exactly dead worker", async () => {
    const old = new Date(1_000).toISOString();
    const liveFixture = fixture({ status: "running", uncertainty: null, createdAt: old, updatedAt: old });
    const live = statefulManager({ record: liveFixture.record, claim: liveFixture.claim, now: 1_000 + 2 * UNKNOWN_RECLAIM_MS });
    live.options._test.isAlive = (pid) => [71, 72].includes(pid);
    live.options._test.validateIdentity = (pid, identity) => (pid === 71 && identity === "worker-71") || (pid === 72 && identity === "native-72");
    await runResidencyManager(live.options);
    assert.equal(live.calls.reconcile, 0);
    assert.equal(live.calls.claim, 0);

    const deadFixture = fixture({ status: "running", uncertainty: null, createdAt: old, updatedAt: old });
    const dead = statefulManager({ record: deadFixture.record, claim: deadFixture.claim, now: 1_000 + 2 * UNKNOWN_RECLAIM_MS });
    dead.options._test.isAlive = (pid) => pid === 72;
    await runResidencyManager(dead.options);
    assert.equal(dead.calls.reconcile, 1);
    assert.equal(dead.calls.uncertain, 1);
    assert.equal(dead.calls.claim, 0, "the new one-hour boundary begins at worker-loss conversion");
  });

  it("treats a live PID identity mismatch as HOLD, never worker death eligibility", async () => {
    const running = fixture({ status: "running", uncertainty: null });
    const manager = statefulManager({ record: running.record, claim: running.claim, now: 1_000 + 2 * UNKNOWN_RECLAIM_MS });
    manager.options._test.isAlive = () => true;
    manager.options._test.validateIdentity = () => false;
    await runResidencyManager(manager.options);
    assert.equal(manager.calls.reconcile, 0);
    assert.equal(manager.calls.claim, 0);
    assert.equal(manager.calls.signal, 0);
  });

  it("recovers a complete pre-record crash while a live or PID-reused worker remains HOLD", async () => {
    const base = fixture();
    const claim = { ...base.claim, acceptance: "not_submitted", nativeTurnRef: null };
    for (const [state, isAlive, validates, expectedRecovery] of [
      ["live", true, true, 0],
      ["pid_reused", true, false, 0],
      ["dead", false, false, 1],
    ]) {
      const isolated = temporaryRoots();
      let claims = [structuredClone(claim)];
      let records = [];
      let acceptanceWrites = 0;
      let recoveryWrites = 0;
      let waits = 0;
      const result = await runResidencyManager({ ...isolated, serviceManager: {
        async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
        async nextIdleDeadline() { return { obligation: false, deadline: null }; },
      }, _test: {
        now: () => 5_000,
        listJobs: () => ({ records: structuredClone(records), unreadable: [] }),
        listClaims: () => ({ records: structuredClone(claims), unreadable: [] }),
        readClaim: () => structuredClone(claim), agentOwns: () => true,
        isAlive: (pid) => pid === claim.worker.pid ? isAlive : false,
        validateIdentity: () => validates,
        recordAcceptanceUnknown() { acceptanceWrites += 1; return { ...claim, acceptance: "acceptance_unknown" }; },
        recordPreRecordUnknown(input) {
          recoveryWrites += 1;
          const recovered = fixture({ status: "unknown", nativeTurnRef: input.provisionalNativeTurnRef,
            uncertainty: { reason: "worker_lost_before_running_projection", detail: null, recordedAt: new Date(5_000).toISOString() } }).record;
          records = [recovered];
          return recovered;
        },
        async waitForActivity() { waits += 1; claims = []; records = []; return { wakeReason: "recovery" }; },
      } });
      assert.equal(result.reason, "receipt_unproven", state);
      assert.equal(recoveryWrites, expectedRecovery, state);
      assert.equal(acceptanceWrites, expectedRecovery, state);
      assert.equal(waits, 1, state);
    }
  });

  for (const [name, mutate] of [
    ["legacy record", ({ record }) => { record.version = 1; delete record.physicalResidency; }],
    ["incomplete record", ({ record }) => { record.physicalResidency = null; }],
    ["route drift", ({ claim }) => { claim.route = versionThreeRoute({ instanceKey: "tenant-drift" }); }],
    ["native-reference drift", ({ claim }) => { claim.nativeTurnRef = turnRef(claim.route, "other-turn"); }],
    ["physical-residency drift", ({ claim }) => { claim.physicalResidency = { kind: "local_process", pid: 99, identity: "other" }; }],
    ["Agent ownership drift", ({ manager }) => { manager.options._test.agentOwns = () => false; }],
  ]) {
    it(`fails closed without signal or lease release on ${name}`, async () => {
      const base = fixture();
      const record = structuredClone(base.record);
      const claim = structuredClone(base.claim);
      const manager = statefulManager({ record, claim });
      mutate({ record, claim, manager });
      manager.options._test.isAlive = () => false;
      manager.options._test.validateIdentity = () => false;
      await runResidencyManager(manager.options);
      assert.equal(manager.calls.claim, 0);
      assert.equal(manager.calls.signal, 0);
      assert.equal(manager.calls.release, 0);
    });
  }

  it("preflights managed receipt, command, endpoint, and peer drift before claiming reclaim", async () => {
    for (const failureCode of ["receipt_drift", "endpoint_unproven", "peer_present", "peer_unknown"]) {
      const base = fixture();
      base.record.physicalResidency = { kind: "managed_service", pid: 73, identity: "service-73",
        commandFingerprint: "command", receiptGeneration: "generation", turnLeaseToken: "turn-token" };
      base.claim.physicalResidency = structuredClone(base.record.physicalResidency);
      const manager = statefulManager({ record: base.record, claim: base.claim, serviceManager: {
        async inspectHardReclaimManagedTurn() { return { disposition: "ambiguous", failureCode }; },
        async hardReclaimManagedTurn() { throw new Error("preflight must stop reclaim"); },
        async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
        async nextIdleDeadline() { return { obligation: false, deadline: null }; },
      } });
      manager.options._test.isAlive = () => false;
      manager.options._test.validateIdentity = () => false;
      await runResidencyManager(manager.options);
      assert.deepEqual({ claim: manager.calls.claim, signal: manager.calls.signal, release: manager.calls.release },
        { claim: 0, signal: 0, release: 0 }, failureCode);
    }
  });

  it("commits the local, sole-managed, shared-managed, and reused release matrix", async () => {
    const localBase = fixture();
    const local = statefulManager({ record: localBase.record, claim: localBase.claim });
    let localAlive = true;
    local.options._test.isAlive = (pid) => pid === 72 && localAlive;
    local.options._test.validateIdentity = (pid, identity) => pid === 72 && identity === "native-72" && localAlive;
    local.options._test.terminate = () => { local.calls.signal += 1; localAlive = false; return { attempted: true, delivered: true }; };
    await runResidencyManager(local.options);
    assert.equal(local.record.status, "hard_reclaimed");
    assert.deepEqual(local.record.hardReclaim.leaseDisposition,
      { admission: "released", writer: "released", serviceTurn: "not_applicable" });
    assert.deepEqual({ signal: local.calls.signal, marker: local.calls.marker, releases: local.calls.release },
      { signal: 1, marker: 1, releases: 1 });
    assert.equal(local.calls.projection, 1, "projection runs only after the committed reclaim receipt");

    const managedResidency = { kind: "managed_service", pid: 73, identity: "service-73",
      commandFingerprint: "command", receiptGeneration: "generation", turnLeaseToken: "turn-token" };
    const soleBase = fixture({ physicalResidency: managedResidency });
    soleBase.claim.physicalResidency = structuredClone(managedResidency);
    let soleSignals = 0;
    const sole = statefulManager({ record: soleBase.record, claim: soleBase.claim, serviceManager: {
      async inspectHardReclaimManagedTurn() { return { disposition: "eligible" }; },
      async hardReclaimManagedTurn({ beforeTerminate }) {
        await beforeTerminate(); soleSignals += 1;
        return { disposition: "released", processDisposition: "dead", serviceTurnDisposition: "released", failureCode: null };
      },
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    } });
    sole.options._test.isAlive = () => false;
    sole.options._test.validateIdentity = () => false;
    await runResidencyManager(sole.options);
    assert.equal(sole.record.status, "hard_reclaimed");
    assert.deepEqual(sole.record.hardReclaim.leaseDisposition,
      { admission: "released", writer: "released", serviceTurn: "released" });
    assert.deepEqual({ signals: soleSignals, marker: sole.calls.marker, releases: sole.calls.release },
      { signals: 1, marker: 1, releases: 1 });

    const sharedBase = fixture({ physicalResidency: managedResidency });
    sharedBase.claim.physicalResidency = structuredClone(managedResidency);
    let shared = true;
    let sharedSignals = 0;
    const sharedManager = statefulManager({ record: sharedBase.record, claim: sharedBase.claim, serviceManager: {
      async inspectHardReclaimManagedTurn() { return { disposition: shared ? "retained_shared" : "eligible" }; },
      async hardReclaimManagedTurn({ beforeTerminate }) {
        if (shared) return { disposition: "retained_shared", processDisposition: "retained_shared",
          serviceTurnDisposition: "retained_shared", failureCode: null };
        await beforeTerminate(); sharedSignals += 1;
        return { disposition: "released", processDisposition: "dead", serviceTurnDisposition: "released", failureCode: null };
      },
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    } });
    sharedManager.options._test.isAlive = () => false;
    sharedManager.options._test.validateIdentity = () => false;
    sharedManager.options._test.waitForActivity = async () => {
      assert.equal(sharedManager.record.status, "hard_reclaimed");
      assert.deepEqual(sharedManager.record.hardReclaim.leaseDisposition,
        { admission: "released", writer: "retained_shared", serviceTurn: "retained_shared" });
      shared = false;
      return { wakeReason: "watcher" };
    };
    await runResidencyManager(sharedManager.options);
    assert.deepEqual(sharedManager.record.hardReclaim.leaseDisposition,
      { admission: "released", writer: "released", serviceTurn: "released" });
    assert.deepEqual({ signals: sharedSignals, marker: sharedManager.calls.marker, releases: sharedManager.calls.release },
      { signals: 1, marker: 1, releases: 2 });

    const reusedResidency = { kind: "reused_service", turnLeaseToken: "reused-token" };
    const reusedBase = fixture({ physicalResidency: reusedResidency });
    reusedBase.claim.physicalResidency = structuredClone(reusedResidency);
    const reused = statefulManager({ record: reusedBase.record, claim: reusedBase.claim });
    reused.options._test.isAlive = () => false;
    reused.options._test.validateIdentity = () => false;
    await runResidencyManager(reused.options);
    assert.equal(reused.record.status, "hard_reclaimed");
    assert.deepEqual(reused.record.hardReclaim.leaseDisposition,
      { admission: "released", writer: "retained_reused", serviceTurn: "retained_reused" });
    assert.deepEqual({ signal: reused.calls.signal, marker: reused.calls.marker, releases: reused.calls.release },
      { signal: 0, marker: 0, releases: 1 });
  });

  it("closes a retained shared-managed residual after the exact hard-reclaimed Agent projection", async () => {
    const isolated = temporaryRoots();
    const workspace = path.join(path.dirname(isolated.stateRoot), "workspace");
    fs.mkdirSync(workspace);
    const route = versionThreeRoute({ instanceKey: "shared-after-projection" });
    const store = createAgentStore({ cwd: workspace, ownerRootId: "root-shared-projection", writeGeneration: FUTURE_WRITE_GENERATION });
    const agent = store.createAgent({ task_name: "shared_after_projection", route, initialMessage: "prompt" });
    assert.equal(store.reserveActivation(agent.agentId, "job-shared-projection", { initial: true }).reserved, true);
    store.updateAgent(agent.agentId, (current) => ({
      ...current,
      activeJobId: null,
      latestJobId: "job-shared-projection",
      lastTerminalJobId: "job-shared-projection",
      finalizedJobIds: ["job-shared-projection"],
      liveTurnOwnership: null,
      status: "errored",
      continuation: {
        mode: "blocked",
        evidence: {
          reason: "worker_lost", settlement: "unknown", jobId: "job-shared-projection",
          attemptId: "attempt-shared-projection", observedAt: "2026-08-31T00:00:00.000Z",
        },
      },
    }));
    const residency = { kind: "managed_service", pid: 73, identity: "service-73",
      commandFingerprint: "command", receiptGeneration: "generation", turnLeaseToken: "turn-token" };
    let record = fixture({
      ownerRootId: "root-shared-projection", agentId: agent.agentId,
      jobId: "job-shared-projection", attemptId: "attempt-shared-projection",
      workspaceRoot: workspace, controlRoot: workspace, executionRoot: workspace, route,
      nativeTurnRef: turnRef(route), status: "hard_reclaimed", physicalResidency: residency,
      hardReclaim: {
        phase: "committed", physicalDisposition: "retained_shared", terminationAttemptedAt: null,
        leaseDisposition: { admission: "released", writer: "retained_shared", serviceTurn: "retained_shared" },
      },
    }).record;
    const claim = fixture({
      ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
      attemptId: record.attemptId, workspaceRoot: workspace, controlRoot: workspace, executionRoot: workspace,
      route, nativeTurnRef: record.nativeTurnRef, physicalResidency: residency,
    }).claim;
    claim.physicalResidency = structuredClone(residency);
    claim.leaseBindings = [
      { kind: "instance", ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
        keyFields: { harnessId: route.harnessId, instanceKey: route.instanceKey } },
      { kind: "writer", ownerRootId: record.ownerRootId, agentId: record.agentId, jobId: record.jobId,
        keyFields: { workspaceRoot: workspace } },
    ];
    let closures = 0;
    let updates = 0;
    await runResidencyManager({ ...isolated, generation: FUTURE_WRITE_GENERATION, serviceManager: {
      async hardReclaimManagedTurn({ beforeTerminate }) {
        await beforeTerminate();
        closures += 1;
        return { disposition: "released", processDisposition: "dead", serviceTurnDisposition: "released", failureCode: null };
      },
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    }, _test: {
      listJobs: () => ({ records: [structuredClone(record)], unreadable: [] }),
      listClaims: () => ({ records: [], unreadable: [] }),
      readClaim: () => structuredClone(claim),
      isAlive: () => false,
      validateIdentity: () => false,
      reconcileHardReclaim: () => ({ reconciled: true, agentProjected: true, completionPublished: true }),
      markTerminationAttempted: () => {
        record = { ...record, hardReclaim: { ...record.hardReclaim, terminationAttemptedAt: new Date().toISOString() } };
        return record;
      },
      releaseLeases: ({ releases }) => ({ outcome: "all", dispositions: releases.map((target) => ({
        kind: target.kind, disposition: "released", code: null,
      })) }),
      updateCommittedDisposition: ({ physicalDisposition, leaseDisposition }) => {
        updates += 1;
        record = { ...record, hardReclaim: { ...record.hardReclaim, physicalDisposition, leaseDisposition } };
        return record;
      },
      waitForActivity: async () => { throw new Error("finalized Agent ownership left the residual permanently resident"); },
    } });
    assert.deepEqual({ closures, updates }, { closures: 1, updates: 1 });
    assert.deepEqual(record.hardReclaim.leaseDisposition,
      { admission: "released", writer: "released", serviceTurn: "released" });
  });

  it("persists ambiguous managed unlink as lease_pending and retries disposition without a second signal", async () => {
    const residency = { kind: "managed_service", pid: 73, identity: "service-73",
      commandFingerprint: "command", receiptGeneration: "generation", turnLeaseToken: "turn-token" };
    const base = fixture({ physicalResidency: residency });
    base.claim.physicalResidency = structuredClone(residency);
    let ambiguous = true;
    let signals = 0;
    let hardCalls = 0;
    const manager = statefulManager({ record: base.record, claim: base.claim, serviceManager: {
      async inspectHardReclaimManagedTurn() { return { disposition: "eligible" }; },
      async hardReclaimManagedTurn({ beforeTerminate, terminationAlreadyAttempted }) {
        hardCalls += 1;
        if (ambiguous) {
          assert.equal(terminationAlreadyAttempted, false);
          await beforeTerminate(); signals += 1;
          return { disposition: "ambiguous", processDisposition: "dead",
            serviceTurnDisposition: "retained", failureCode: "lease_unlink_retained" };
        }
        assert.equal(terminationAlreadyAttempted, true);
        return { disposition: "released", processDisposition: "dead",
          serviceTurnDisposition: "released", failureCode: null };
      },
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    } });
    manager.options._test.isAlive = () => false;
    manager.options._test.validateIdentity = () => false;
    manager.options._test.waitForActivity = async () => {
      assert.equal(manager.record.status, "unknown");
      assert.equal(manager.record.hardReclaim.phase, "lease_pending");
      assert.equal(manager.record.hardReclaim.failureCode, "lease_unlink_retained");
      assert.equal(manager.record.hardReclaim.leaseDisposition.serviceTurn, "unknown");
      ambiguous = false;
      return { wakeReason: "watcher" };
    };
    await runResidencyManager(manager.options);
    assert.equal(manager.record.status, "hard_reclaimed");
    assert.deepEqual({ signals, marker: manager.calls.marker, hardCalls }, { signals: 1, marker: 1, hardCalls: 2 });
  });

  it("starts one ready singleton, joins its race, replaces a stale receipt, and fails closed without readiness", async () => {
    const isolated = temporaryRoots();
    const paths = resolveResidencyManagerPaths(isolated);
    let spawns = 0;
    let nextPid = 800;
    const options = {
      ...isolated,
      _test: {
        isAlive: (pid) => pid >= 800,
        validateIdentity: (pid, identity) => identity === `identity-${pid}`,
        spawn: (_command, _args, childOptions) => {
          spawns += 1;
          const pid = nextPid++;
          fs.mkdirSync(path.dirname(paths.receiptFile), { recursive: true });
          fs.writeFileSync(paths.receiptFile, JSON.stringify({
            version: 2, generation: FUTURE_WRITE_GENERATION, pid, identity: `identity-${pid}`,
            stateRootDigest: paths.stateRootDigest, runtimeRootDigest: paths.runtimeRootDigest,
            startedAt: new Date().toISOString(),
          }));
          assert.equal(childOptions.env.CODEX_HARNESSDOCK_RESIDENCY_STATE_ROOT, isolated.stateRoot);
          assert.equal(childOptions.env.CODEX_HARNESSDOCK_RESIDENCY_RUNTIME_ROOT, isolated.runtimeRoot);
          return { pid, unref() {} };
        },
      },
    };
    const raced = await Promise.all([ensureResidencyManager(options), ensureResidencyManager(options)]);
    assert.equal(spawns, 1);
    assert.deepEqual(new Set(raced.map((entry) => entry.pid)), new Set([800]));

    fs.writeFileSync(paths.receiptFile, JSON.stringify({ version: 2, generation: FUTURE_WRITE_GENERATION, pid: 9, identity: "stale",
      stateRootDigest: paths.stateRootDigest, runtimeRootDigest: paths.runtimeRootDigest, startedAt: new Date().toISOString() }));
    await ensureResidencyManager({ ...options, _test: { ...options._test, isAlive: (pid) => pid !== 9 } });
    assert.equal(spawns, 2);

    fs.rmSync(paths.receiptFile, { force: true });
    const notReady = await ensureResidencyManager({ ...isolated, _test: {
      isAlive: () => true, validateIdentity: () => true,
      spawn: () => ({ pid: 999, unref() {} }), readyWaitMs: 1,
    } });
    assert.deepEqual(notReady, { started: false, pid: null });
    assert.equal(fs.existsSync(paths.lockFile), false);
  });

  it("survives the ensuring frontend process and self-exits on the durable removal wake", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-residency-child-"));
    roots.push(root);
    const runtimeHome = path.join(root, "data");
    const corruptFile = path.join(runtimeHome, "state", "v3-jobs", "v1", "owner", "corrupt.json");
    fs.mkdirSync(path.dirname(corruptFile), { recursive: true });
    fs.writeFileSync(corruptFile, "{");
    const managerEntry = new URL("../../runtime/residency-manager.mjs", import.meta.url).href;
    const script = `import { ensureResidencyManager } from ${JSON.stringify(managerEntry)};` +
      `const result = await ensureResidencyManager({cwd:${JSON.stringify(process.cwd())},envFile:${JSON.stringify(path.join(process.cwd(), "config/runtime.env"))}});` +
      "process.stdout.write(JSON.stringify(result));";
    const ensured = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
          CODEX_HOME: path.join(root, "codex-home") }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(stdout))
        : reject(new Error(`ensurer exited ${code}: ${stderr}`)));
    });
    assert.equal(ensured.started, true);
    assert.equal(process.kill(ensured.pid, 0), true, "detached manager outlives the exited frontend");
    const receiptFile = path.join(runtimeHome, "runtime", "residency-manager", "receipt.json");
    assert.equal(fs.existsSync(receiptFile), true);
    const exited = new Promise((resolve, reject) => {
      let timer;
      const watcher = fs.watch(path.dirname(receiptFile), () => {
        if (!fs.existsSync(receiptFile)) { clearTimeout(timer); watcher.close(); resolve(true); }
      });
      timer = setTimeout(() => { watcher.close(); reject(new Error("manager did not self-exit after durable wake")); }, 4_000);
    });
    fs.unlinkSync(corruptFile);
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(ensured.pid, 0), (error) => error.code === "ESRCH");
  });

  it("refuses to overwrite another matching live receipt and self-unlinks only its own receipt", async () => {
    const isolated = temporaryRoots();
    const paths = resolveResidencyManagerPaths(isolated);
    fs.mkdirSync(path.dirname(paths.receiptFile), { recursive: true });
    const foreign = { version: 2, generation: FUTURE_WRITE_GENERATION, pid: 909, identity: "foreign",
      stateRootDigest: paths.stateRootDigest, runtimeRootDigest: paths.runtimeRootDigest, startedAt: new Date().toISOString() };
    fs.writeFileSync(paths.receiptFile, JSON.stringify(foreign));
    const refused = await runResidencyManager({ ...isolated, serviceManager: {
      async reapIfIdle() { throw new Error("must not manage"); },
    }, _test: { isAlive: () => true, validateIdentity: (pid, identity) => pid === 909 && identity === "foreign" } });
    assert.deepEqual(refused, { waiting: false, reason: "already_running" });
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.receiptFile, "utf8")), foreign);

    fs.rmSync(paths.receiptFile, { force: true });
    const result = await runResidencyManager({ ...isolated, serviceManager: {
      async reapIfIdle() { return { reaped: false, reason: "receipt_unproven" }; },
      async nextIdleDeadline() { return { obligation: false, deadline: null }; },
    } });
    assert.deepEqual(result, { waiting: false, reason: "receipt_unproven" });
    assert.equal(fs.existsSync(paths.receiptFile), false);
  });

  it("waits on the nearest managed deadline with watcher and bounded recovery wakes", async () => {
    const isolated = temporaryRoots();
    const deadlines = [];
    let passes = 0;
    const result = await runResidencyManager({ ...isolated, _test: {
      listJobs: () => ({ records: [], unreadable: [] }), now: () => 10_000,
      async waitForActivity(options) { deadlines.push(options); passes += 1; return { wakeReason: passes === 1 ? "watcher" : "recovery" }; },
    }, serviceManager: {
      async reapIfIdle() { return passes === 0 ? { reaped: false, reason: "not_idle" } : { reaped: true, reason: "terminated" }; },
      async nextIdleDeadline() { return passes === 0 ? { obligation: true, deadline: 15_000 } : { obligation: false, deadline: null }; },
    } });
    assert.equal(result.reason, "terminated");
    assert.equal(deadlines[0].deadline, 15_000);
    assert.equal(deadlines[0].recoveryIntervalMs, 10_000);
    assert.equal(deadlines[0].stateRoot, path.dirname(isolated.stateRoot));
    assert.deepEqual(deadlines[0].desiredPaths.sort(), [isolated.runtimeRoot, isolated.stateRoot].sort());
  });
});
