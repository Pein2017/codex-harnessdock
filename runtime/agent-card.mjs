/** SPDX-License-Identifier: Apache-2.0 */

const SAFE_PHASES = Object.freeze({
  initialized: "starting",
  tool: "tool",
  thinking: "thinking",
  responding: "responding",
  retrying: "retrying",
  reconnecting: "reconnecting",
});
import { assertSameDurableRouteSemantics } from "./durable-state-v3.mjs";
import { isBoundedRouteAtom, validateRouteInspectionEvidence } from "./harness-contract.mjs";
import { readLaunchClaim } from "./launch-claim.mjs";

function nullableEffort(value) {
  return isBoundedRouteAtom(value) ? value : null;
}

function nullableTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function safeElapsedSeconds(startedAt, endedAt, now) {
  const start = Date.parse(startedAt ?? "");
  const reference = endedAt ?? (now instanceof Date ? now.toISOString() : String(now));
  const end = Date.parse(reference);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function acceptedAttemptEvidence(agent, job) {
  if (agent?.version !== 3 || !job?.ownerRootId || !job?.agentId || !job?.id || !job?.attemptId || !job?.route) return null;
  try {
    assertSameDurableRouteSemantics(agent.route, job.route, "Agent Card");
    const claim = readLaunchClaim({ ownerRootId: job.ownerRootId, agentId: job.agentId, jobId: job.id });
    if (!claim || claim.attemptId !== job.attemptId || claim.acceptance !== "acceptance_proven" ||
        JSON.stringify(claim.route) !== JSON.stringify(job.route)) return null;
    return validateRouteInspectionEvidence(claim.inspectionEvidence, claim.route, "Agent Card inspection evidence");
  } catch {
    return null;
  }
}

function projectedInspectionEvidence(agent, job, options) {
  if (options?.inspectionEvidence != null) {
    if (agent?.version !== 3 || agent?.route == null) {
      throw new Error("Agent Card inspection evidence requires a version-three Agent route.");
    }
    return validateRouteInspectionEvidence(
      options.inspectionEvidence, agent.route, "Agent Card spawn inspection evidence"
    );
  }
  return acceptedAttemptEvidence(agent, job);
}

/**
 * Project only retained Agent/job facts.  This is observation, not a liveness
 * or progress-delivery operation; callers must not persist its result.
 */
export function projectAgentCard(agent, job, options = {}) {
  const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "unknown"]);
  const progress = job?.publicProgress;
  const activity = typeof progress?.activity === "string" ? progress.activity : null;
  const phase = activity && activity !== "hook" ? SAFE_PHASES[activity] ?? null : null;
  const progressTimestamp = phase ? nullableTimestamp(progress?.updatedAt) : null;
  const driverLastByteAt = phase
    ? nullableTimestamp(job?.result?.lastByteAt ?? job?.lastByteAt)
    : null;
  const startedAt = nullableTimestamp(job?.startedAt);
  // A version-three Agent froze its model, topology, and behavioral authority
  // at creation, including effective reasoning effort. Nothing about an
  // observed turn may restate that identity.
  const frozenRoute = agent?.version === 3 && agent?.route ? agent.route : null;
  const inspectionEvidence = projectedInspectionEvidence(agent, job, options);
  const terminalJob = terminal.has(job?.status);
  const completedAt = terminalJob ? nullableTimestamp(job?.completedAt) : null;
  return {
    agent_name: agent.path,
    // Immutable route lineage. A version-three Agent states its whole route, so
    // every card, wait, and completion receipt names the Harness that owns it
    // and the maturity that route was accepted under; a legacy record states
    // only the Harness it recorded and no maturity to claim.
    harness: agent.harnessId ?? null,
    route_maturity: frozenRoute?.capabilities?.driverMaturity ?? null,
    ...(inspectionEvidence == null ? {} : {
      capability_provenance: inspectionEvidence.capabilities.provenance,
      inspection_generation: inspectionEvidence.generation,
    }),
    model: frozenRoute ? frozenRoute.model : agent.selectedModel,
    reasoning_effort: nullableEffort(frozenRoute?.effort ?? job?.request?.effort),
    // Historical per-turn write intent is legacy Claude evidence; it can never
    // widen, narrow, or answer for a frozen route authority.
    authority: frozenRoute
      ? frozenRoute.authority
      : job?.request?.write === true
        ? "behavioral_write"
        : job?.request?.write === false
          ? "behavioral_read_only"
          : "unknown",
    delegation_mode: frozenRoute ? frozenRoute.topology : agent.delegationMode,
    phase,
    started_at: startedAt,
    // Private or unknown activity cannot lend its timestamp to a public card.
    last_activity_at: phase ? driverLastByteAt ?? progressTimestamp : null,
    elapsed_seconds: terminalJob && completedAt == null
      ? null
      : safeElapsedSeconds(startedAt, completedAt, options.now ?? new Date()),
  };
}
