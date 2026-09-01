import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { bindLaunchClaimPhysicalResidencyAsync, claimNativeSubmissionStartAsync, createLaunchClaim, readLaunchClaim } from "../../runtime/launch-claim.mjs";
import { readVersionThreeJobRecord } from "../../runtime/v3-job-store.mjs";
import { reconcilePreparedVersionThreeTurns } from "../../runtime/v3-worker-entry.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-v3-pre-record-"));
const workspaceRoot = path.join(root, "workspace");
fs.mkdirSync(workspaceRoot);
process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
after(() => fs.rmSync(root, { recursive: true, force: true }));

it("materializes one unknown record for a dead fully bound worker before running projection, without replay", async () => {
  const identity = { ownerRootId: "root-pre-record", agentId: "agent-pre-record", jobId: "job-pre-record" };
  const route = versionThreeRoute({ instanceKey: "tenant-pre-record" });
  const attemptId = "attempt-pre-record";
  const lease = acquireInstanceLease({ ...identity, route, harnessId: route.harnessId, instanceKey: route.instanceKey, capacityClass: "pre-record", capacityLimit: 1 });
  createLaunchClaim({
    ...identity, attemptId, route, leaseBindings: [lease], assignedMessageIds: ["message-pre-record"], preparedInput: "never replay",
    turnOptions: null, lifecycleOwner: "version_three_worker", controlRoot: workspaceRoot, executionRoot: workspaceRoot,
    inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
  });
  await claimNativeSubmissionStartAsync({ ...identity, attemptId });
  const provisionalNativeTurnRef = {
    version: 1, harnessId: route.harnessId, driverVersion: route.driverVersion, instanceKey: route.instanceKey,
    locatorVersion: 1, locator: { sessionId: "pre-record-session", turnId: "pre-record-turn" },
  };
  await bindLaunchClaimPhysicalResidencyAsync({
    ...identity, attemptId, route, worker: { pid: 999999, identity: "dead-worker" },
    physicalResidency: { kind: "reused_service", turnLeaseToken: "a".repeat(32) }, provisionalNativeTurnRef,
  });
  const first = reconcilePreparedVersionThreeTurns({ cwd: workspaceRoot, ownerRootId: identity.ownerRootId, reconciliationStartedAt: Date.now() });
  assert.deepEqual(first, [{ jobId: identity.jobId, reconciled: true, reason: "v3_pre_record_worker_lost" }]);
  const record = readVersionThreeJobRecord(identity);
  assert.equal(record.status, "unknown");
  assert.deepEqual(record.nativeTurnRef, provisionalNativeTurnRef);
  assert.equal(record.uncertainty.reason, "worker_lost_before_running_projection");
  assert.equal(readLaunchClaim(identity).acceptance, "acceptance_unknown");
  assert.equal(readVersionThreeJobRecord(identity).status, "unknown");
});
