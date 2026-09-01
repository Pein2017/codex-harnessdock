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
 * A worker that cannot read all of that fails before native submission; the
 * prepared parent claim then drives the idempotent rollback path.
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
import { FUTURE_WRITE_GENERATION, assertSameDurableRouteSemantics } from "./durable-state-v3.mjs";
import { validateRouteInspectionEvidence } from "./harness-contract.mjs";
import { validateNativeReferenceEnvelope } from "./native-reference.mjs";
import {
  releaseLeasesForPreSubmissionRollback,
} from "./instance-admission-lease.mjs";
import { resolveDriverV2 } from "./harness-registry.mjs";
import { isProcessAlive } from "./process-control.mjs";
import {
  beginPreSubmissionRollback,
  completePreSubmissionRollback,
  launchClaimRollbackEligibility,
  listLaunchClaimsForOwnerRoot,
  recordLaunchAcceptanceUnknown,
  readLaunchClaim,
} from "./launch-claim.mjs";
import { runVersionThreeWorkerLoop } from "./v3-worker-loop.mjs";
import { readVersionThreeJobRecord, recordVersionThreePreRecordUncertain } from "./v3-job-store.mjs";

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
function requireAssignedInput(store, agent, jobId, assignedMessageIds) {
  const byId = new Map(store.listMessages(agent.agentId).map((message) => [message.messageId, message]));
  const assigned = assignedMessageIds.map((messageId) => {
    const message = byId.get(messageId);
    if (!message || message.state !== "assigned" || message.assignedJobId !== jobId) {
      throw new Error(`Version-three job ${jobId} cannot consume its prepared mailbox message ${messageId}.`);
    }
    return message;
  });
  return {
    taskInput: assigned.map((message) => message.text).join("\n\n"),
    assignedMessageIds: [...assignedMessageIds],
  };
}

function removeInitialReservationAfterRollback(store, agentId, removableMessageId) {
  if (!store.readAgent(agentId)) return;
  try {
    store.rollbackReservation(agentId, { removableMessageId });
  } catch (error) {
    // Parent and worker may finish the same durable rollback concurrently. The
    // existing empty-reservation proof owns deletion; absence after the race is
    // the idempotent result, not permission to weaken that proof.
    if (!store.readAgent(agentId)) return;
    throw error;
  }
}

/** Recover one prepared attempt without replaying it. Safe to call repeatedly. */
export function rollbackPreparedVersionThreeTurn({ cwd, ownerRootId, agentId, jobId, attemptId }) {
  const identity = { ownerRootId, agentId, jobId };
  let claim = readLaunchClaim(identity);
  if (!claim) throw new Error(`Version-three rollback found no prepared claim for ${jobId}.`);
  if (claim.attemptId !== attemptId) throw new Error(`Version-three rollback refuses a different attempt for ${jobId}.`);
  const store = createAgentStore({ cwd, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
  if (claim.submissionState === "rollback_complete") {
    removeInitialReservationAfterRollback(store, agentId, claim.assignedMessageIds[0] ?? null);
    return claim;
  }
  if (claim.submissionState !== "rollback_in_progress") {
    const eligibility = launchClaimRollbackEligibility(claim);
    if (!eligibility.eligible) {
      throw Object.assign(new Error(`Version-three launch ${jobId} is not rollback-safe: ${eligibility.reason}.`), {
        handoffDisposition: "lifecycle_owned",
      });
    }
    claim = beginPreSubmissionRollback({ ...identity, token: eligibility.token });
  }
  releaseLeasesForPreSubmissionRollback({ claim });
  if (!store.readAgent(agentId)) {
    const raced = readLaunchClaim(identity);
    if (raced?.submissionState === "rollback_complete") return raced;
    throw new Error("Version-three Agent disappeared before rollback completion was durable.");
  }
  let restored;
  try {
    restored = store.rollbackVersionThreeActivation(agentId, {
      jobId,
      removableMessageId: claim.assignedMessageIds[0] ?? null,
      rollbackClaim: claim,
    });
  } catch (error) {
    const raced = readLaunchClaim(identity);
    const racedAgent = store.readAgent(agentId);
    if (
      raced?.submissionState === "rollback_complete" &&
      (!racedAgent || racedAgent.activeJobId !== jobId)
    ) {
      removeInitialReservationAfterRollback(store, agentId, claim.assignedMessageIds[0] ?? null);
      return raced;
    }
    throw error;
  }
  if (!restored.restored) throw new Error(`Version-three activation rollback failed: ${restored.reason}.`);
  const completed = completePreSubmissionRollback({ ...identity, attemptId });
  removeInitialReservationAfterRollback(store, agentId, claim.assignedMessageIds[0] ?? null);
  return completed;
}

export const PRE_SUBMISSION_RECONCILIATION_AGE_MS = 6_000;

/** Bounded pre-submission cleanup only; never observes or replays a native turn. */
export function reconcilePreparedVersionThreeTurns({ cwd, ownerRootId, reconciliationStartedAt }) {
  const startedAt = Number(reconciliationStartedAt);
  if (!Number.isFinite(startedAt)) throw new Error("Pre-submission reconciliation requires its pass start time.");
  const receipts = [];
  for (const claim of listLaunchClaimsForOwnerRoot({ ownerRootId })) {
    if (claim.lifecycleOwner !== "version_three_worker") continue;
    const completePreRecordBinding = claim.version === 3 && claim.submissionState === "started" &&
      ["not_submitted", "acceptance_unknown", "acceptance_proven"].includes(claim.acceptance) && claim.physicalResidency != null && claim.worker != null &&
      claim.provisionalNativeTurnRef != null && claim.controlRoot != null && claim.executionRoot != null;
    if (completePreRecordBinding && !readVersionThreeJobRecord(claim) &&
        !isProcessAlive(claim.worker.pid)) {
      try {
        const uncertainClaim = claim.acceptance === "not_submitted"
          ? recordLaunchAcceptanceUnknown({ ownerRootId, agentId: claim.agentId, jobId: claim.jobId,
            attemptId: claim.attemptId, sanitizedDetail: null })
          : claim;
        recordVersionThreePreRecordUncertain({
          generation: FUTURE_WRITE_GENERATION, ownerRootId, agentId: claim.agentId, jobId: claim.jobId,
          attemptId: uncertainClaim.attemptId, workspaceRoot: uncertainClaim.controlRoot, controlRoot: uncertainClaim.controlRoot,
          executionRoot: uncertainClaim.executionRoot, route: uncertainClaim.route,
          provisionalNativeTurnRef: uncertainClaim.acceptance === "acceptance_proven"
            ? uncertainClaim.nativeTurnRef : uncertainClaim.provisionalNativeTurnRef,
          worker: uncertainClaim.worker, physicalResidency: uncertainClaim.physicalResidency,
        });
        receipts.push(Object.freeze({ jobId: claim.jobId, reconciled: true, reason: "v3_pre_record_worker_lost" }));
      } catch {
        receipts.push(Object.freeze({ jobId: claim.jobId, reconciled: false, reason: "v3_pre_record_recovery_deferred" }));
      }
      continue;
    }
    const immediatelyCompletable = claim.submissionState === "rollback_in_progress";
    const ageEligible = (
      claim.acceptance === "acceptance_rejected" ||
      (claim.acceptance === "not_submitted" && claim.submissionState === "not_started")
    ) && Date.parse(claim.updatedAt) <= startedAt - PRE_SUBMISSION_RECONCILIATION_AGE_MS;
    if (!immediatelyCompletable && !ageEligible && claim.submissionState !== "rollback_complete") continue;
    try {
      const completed = rollbackPreparedVersionThreeTurn({
        cwd,
        ownerRootId,
        agentId: claim.agentId,
        jobId: claim.jobId,
        attemptId: claim.attemptId,
      });
      receipts.push(Object.freeze({
        jobId: claim.jobId,
        reconciled: completed.submissionState === "rollback_complete",
        reason: "v3_pre_submission_rollback_complete",
      }));
    } catch {
      const raced = readLaunchClaim(claim);
      const activeWon = raced && (
        raced.submissionState === "started" ||
        ["acceptance_unknown", "acceptance_proven"].includes(raced.acceptance)
      );
      receipts.push(Object.freeze({
        jobId: claim.jobId,
        reconciled: false,
        reason: activeWon
          ? "v3_pre_submission_active_launch_won"
          : "v3_pre_submission_rollback_deferred",
      }));
    }
  }
  return Object.freeze(receipts);
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
  const storedRoute = requireVersionThreeRoute(agent, agentId);
  const claim = readLaunchClaim({ ownerRootId, agentId, jobId });
  if (!claim || claim.attemptId !== attemptId) {
    throw new Error(`Version-three worker found no exact prepared claim for attempt ${attemptId}.`);
  }
  if (claim.lifecycleOwner !== "version_three_worker") {
    throw new Error(`Version-three worker refuses claim ${jobId} owned by another or legacy lifecycle.`);
  }
  if (claim.inspectionEvidence == null) {
    throw new Error("Version-three worker refuses an evidence-less historical launch claim before submission.");
  }
  const route = assertSameDurableRouteSemantics(
    storedRoute, claim.route, `Version-three worker ${jobId}`
  );
  validateRouteInspectionEvidence(claim.inspectionEvidence, route, "Version-three worker inspection evidence");
  const { taskInput, assignedMessageIds } = requireAssignedInput(
    store, agent, jobId, claim.assignedMessageIds
  );
  const driver = resolveDriverV2(route.harnessId, { env });
  const turnOptions = claim.turnOptions ?? null;
  const preparedTurn = driver.prepareTurn({
    route,
    taskInput,
    turnOptions,
    turnId: jobId,
  });
  const nativeSessionRef = agent.nativeSessionRef == null
    ? null
    : validateNativeReferenceEnvelope(agent.nativeSessionRef, {
        driver,
        kind: "session",
        route,
      });
  const controlRoot = agent.workspaceRoot ?? canonicalAgentWorkspaceRoot(cwd);
  const executionRoot = agent.executionRoot ?? controlRoot;
  if (
    claim.controlRoot != null &&
    (claim.controlRoot !== controlRoot || claim.executionRoot !== executionRoot)
  ) {
    throw new Error("Version-three worker Agent roots do not match its durable launch claim.");
  }
  const admissionLease = claim.leaseBindings.find((binding) =>
    binding.kind === (nativeSessionRef == null ? "instance" : "native_session")
  );
  const writerLease = claim.leaseBindings.find((binding) => binding.kind === "writer") ?? null;
  if (claim.leaseState !== "acquired") {
    throw new Error("Version-three worker claim has no durable acquired lease proof.");
  }
  if (nativeSessionRef == null && admissionLease?.kind !== "instance") {
    throw new Error("Fresh version-three worker claim does not hold its prepared instance lease.");
  }
  if (
    nativeSessionRef != null &&
    (admissionLease?.kind !== "native_session" ||
      admissionLease.keyFields.nativeSessionId !== nativeSessionRef.locator.sessionId)
  ) {
    throw new Error("Exact-session worker claim does not match the Agent's persisted validated session.");
  }
  const requiresWriter = route.authority === "behavioral_write";
  if (
    (requiresWriter && writerLease?.keyFields.workspaceRoot !== executionRoot) ||
    (!requiresWriter && writerLease != null)
  ) {
    throw new Error("Version-three worker claim does not bind the Agent's execution-root writer authority.");
  }
  try {
    return await runVersionThreeWorkerLoop({
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
      leaseBindings: claim.leaseBindings.map((binding) => ({ ...binding, route: claim.route })),
      turnOptions,
      nativeSessionRef,
      // The stored canonical workspace root, never a fresh alias: every lease and
      // writer release in this path must round-trip the exact key the durable
      // record was written under.
      controlRoot,
      executionRoot,
      env,
      cwd,
      signal: input.signal ?? null,
    });
  } catch (error) {
    const durable = readLaunchClaim({ ownerRootId, agentId, jobId });
    const eligible = durable == null ? null : launchClaimRollbackEligibility(durable);
    if (eligible?.eligible || durable?.submissionState === "rollback_in_progress") {
      rollbackPreparedVersionThreeTurn({ cwd, ownerRootId, agentId, jobId, attemptId });
    }
    throw error;
  }
}
