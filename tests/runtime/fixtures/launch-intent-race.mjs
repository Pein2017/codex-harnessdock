import fs from "node:fs";

import { versionThreeRoute } from "./version-three-state.mjs";

const [, , mode, payloadText] = process.argv;
const payload = JSON.parse(payloadText);

async function waitFor(filePath) {
  while (!fs.existsSync(filePath)) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function acquire() {
  const originalLinkSync = fs.linkSync;
  if (payload.holderReadyFile) {
    fs.linkSync = (source, destination) => {
      originalLinkSync(source, destination);
      if (destination.endsWith(".json") && destination.includes("/leases/v1/")) {
        fs.writeFileSync(payload.holderReadyFile, "ready");
        while (!fs.existsSync(payload.releaseHolderFile)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    };
  }
  const { acquireIntendedInstanceLease } = await import("../../../runtime/instance-admission-lease.mjs");
  await waitFor(payload.startFile);
  try {
    acquireIntendedInstanceLease({
      ownerRootId: payload.ownerRootId,
      agentId: payload.agentId,
      jobId: payload.jobId,
      attemptId: payload.attemptId,
      route: versionThreeRoute(),
      harnessId: payload.harnessId,
      instanceKey: payload.instanceKey,
      capacityClass: payload.capacityClass,
      capacityLimit: payload.capacityLimit,
    });
    process.stdout.write("acquired");
  } catch (error) {
    if (error?.code === "launch_intent_not_acquirable") process.stdout.write("fenced");
    else throw error;
  }
}

async function rollback() {
  const {
    beginPreSubmissionRollback,
    completePreSubmissionRollback,
    launchClaimRollbackEligibility,
    readLaunchClaim,
  } = await import("../../../runtime/launch-claim.mjs");
  const { releaseLeasesForPreSubmissionRollback } = await import("../../../runtime/instance-admission-lease.mjs");
  await waitFor(payload.startFile);
  const identity = {
    ownerRootId: payload.ownerRootId,
    agentId: payload.agentId,
    jobId: payload.jobId,
  };
  const claim = readLaunchClaim(identity);
  const owned = beginPreSubmissionRollback({
    ...identity,
    token: launchClaimRollbackEligibility(claim).token,
  });
  releaseLeasesForPreSubmissionRollback({ claim: owned });
  completePreSubmissionRollback({ ...identity, attemptId: payload.attemptId });
  process.stdout.write("rolled_back");
}

(mode === "acquire" ? acquire() : mode === "rollback" ? rollback() : Promise.reject(new Error("unsupported mode")))
  .catch((error) => {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  });
