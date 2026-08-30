import { acquireInstanceLease } from "../../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim } from "../../../runtime/launch-claim.mjs";
import { V3_HARNESS_ID, V3_INSTANCE_KEY, versionThreeRoute } from "./version-three-state.mjs";

const [, , mode, ...rest] = process.argv;

function binding() {
  return { ownerRootId: "root-1", agentId: "agent-1", jobId: "job-1" };
}

function leaseBindings() {
  const lease = acquireInstanceLease({
    ...binding(),
    route: versionThreeRoute(),
    harnessId: V3_HARNESS_ID,
    instanceKey: V3_INSTANCE_KEY,
    capacityClass: "default",
    capacityLimit: 4,
  });
  return [lease];
}

function run() {
  if (mode === "create") {
    // `turnOptionsText` is always stated by the caller -- "null" for a route
    // whose Driver owns no turn options, or a JSON bag. It is never defaulted
    // here, so a contender can never accidentally agree with another one.
    const [attemptId, turnOptionsText = "null"] = rest;
    createLaunchClaim({
      ...binding(),
      attemptId,
      route: versionThreeRoute(),
      leaseBindings: leaseBindings(),
      assignedMessageIds: ["message-1"],
      preparedInput: "hello",
      turnOptions: JSON.parse(turnOptionsText),
      inspectionEvidence: { generation: "unavailable", capabilities: versionThreeRoute().capabilities },
    });
    return "ok";
  }
  throw new Error(`Unsupported contention fixture mode: ${mode}`);
}

try {
  process.stdout.write(run());
} catch (error) {
  if (/already claimed by a different attempt/.test(error?.message ?? "")) {
    process.stdout.write("conflict");
  } else if (/identity mismatch/.test(error?.message ?? "")) {
    process.stdout.write("mismatch");
  } else {
    process.stdout.write(`error:${error?.message}`);
  }
}
