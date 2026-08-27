/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The production detached version-three worker entry
 * (add-opencode-explorer-driver, Task 7).
 *
 * Phase A designed and proved the version-three machinery: the launch claim and
 * submission fence (`v3-worker-launch.mjs`), the worker loop and its settlement
 * rules (`v3-worker-loop.mjs`), the durable turn record (`v3-job-store.mjs`),
 * reconciliation (`v3-turn-reconciliation.mjs`), leases, and the control stream.
 * What was missing was the one thing only a production surface can own: a real
 * detached process that composes them for a turn the public generation started.
 * That is this module, and nothing more.
 *
 * ## Why the handoff carries identity, not state
 *
 * The parent hands the worker four identifiers on its command line -- the
 * workspace, the Agent, the job, and the attempt -- and nothing else. Every
 * other input is read from durable state the parent already wrote:
 *
 *   - the immutable route comes from the version-three Agent record, so the
 *     worker can never run a route the record does not state;
 *   - the task text comes from the mailbox messages the parent assigned, so the
 *     prompt is never passed through an argument vector or an environment
 *     variable where it could be observed or truncated;
 *   - the Driver comes from the static in-tree registry, resolved from the
 *     route's own Harness identity;
 *   - the prepared turn is recomputed by that Driver from the same route and
 *     task text, which is deterministic by construction.
 *
 * A worker that cannot read all of that fails before it claims anything.
 *
 * ## Why there is no version-one job file
 *
 * A version-three turn's durable owner is the version-three job store, and its
 * completion is published through the same completion inbox every consumer
 * already reads. Writing a second version-one job record for the same turn
 * would create a parallel lifecycle that could publish a second completion for
 * one native turn, so this path deliberately writes none: the mailbox
 * activation reserves the turn, the launch claim fences its submission, and the
 * version-three record is the single authority on what happened.
 */

import { canonicalAgentWorkspaceRoot, createAgentStore } from "./agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "./durable-state-v3.mjs";
import { acquireInstanceLease } from "./instance-admission-lease.mjs";
import { resolveDriverV2 } from "./harness-registry.mjs";
import { runVersionThreeWorkerLoop } from "./v3-worker-loop.mjs";

const V3_TURN_EVIDENCE_CLASS = "v3-public-turn";

/** Read the immutable route from the version-three Agent record, or fail. */
function requireVersionThreeRoute(agent, agentId) {
  if (!agent) {
    throw new Error(`Version-three worker found no Agent ${agentId} in this root.`);
  }
  if (agent.version !== 3 || !agent.route) {
    throw new Error(
      `Agent ${agent.path} is not a version-three Agent; a version-three worker never infers a route.`
    );
  }
  return agent.route;
}

/**
 * The assigned first-turn input for this job, read from durable mailbox state.
 * A worker never invents, defaults, or truncates a prompt: an activation with no
 * assigned message is a launch that should never have been handed off.
 */
function requireAssignedInput(store, agent, jobId) {
  const assigned = store.listMessages(agent.agentId)
    .filter((message) => message.state === "assigned" && message.assignedJobId === jobId);
  if (assigned.length === 0) {
    throw new Error(`Version-three job ${jobId} has no assigned mailbox message to run.`);
  }
  return {
    taskInput: assigned.map((message) => message.text).join("\n\n"),
    assignedMessageIds: assigned.map((message) => message.messageId),
  };
}

/**
 * Run one detached version-three turn to settlement.
 *
 * Returns the worker loop's own bounded disposition. Every failure before the
 * loop is a launch that never crossed the submission fence; every outcome after
 * it is the loop's, including the unknown that holds leases and publishes
 * nothing.
 *
 * @param {{cwd: string, env: NodeJS.ProcessEnv, ownerRootId: string, agentId: string,
 *   jobId: string, attemptId: string, turnOptions?: object|null, signal?: AbortSignal}} input
 */
export async function runDetachedVersionThreeTurn(input) {
  const { cwd, env, ownerRootId, agentId, jobId, attemptId } = input;
  const store = createAgentStore({
    cwd,
    ownerRootId,
    writeGeneration: FUTURE_WRITE_GENERATION,
  });
  const agent = store.readAgent(agentId);
  const route = requireVersionThreeRoute(agent, agentId);
  const { taskInput, assignedMessageIds } = requireAssignedInput(store, agent, jobId);
  const driver = resolveDriverV2(route.harnessId, { env });
  const turnOptions = input.turnOptions ?? null;
  const preparedTurn = driver.prepareTurn({
    route,
    taskInput,
    turnOptions,
    turnId: jobId,
  });
  // Each turn keeps its own durable settlement evidence. Including the job in
  // the class prevents this evidence lease from becoming an instance-wide cap.
  const lease = acquireInstanceLease({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    route,
    harnessId: route.harnessId,
    instanceKey: route.instanceKey,
    capacityClass: `${V3_TURN_EVIDENCE_CLASS}:${jobId}`,
    capacityLimit: 1,
  });
  return runVersionThreeWorkerLoop({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route,
    driver,
    preparedTurn,
    preparedInput: taskInput,
    assignedMessageIds,
    assignedInputs: [],
    leaseBindings: [lease],
    turnOptions,
    // The stored canonical workspace root, never a fresh alias: every lease and
    // writer release in this path must round-trip the exact key the durable
    // record was written under.
    workspaceRoot: agent.workspaceRoot ?? canonicalAgentWorkspaceRoot(cwd),
    env,
    cwd,
    signal: input.signal ?? null,
  });
}
