/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Canonical Agent orchestration. This module is the only composer allowed to
 * translate stable Agent operations into ephemeral internal Claude jobs.
 */

import fs from "node:fs";
import path from "node:path";

import { createAgentStore } from "./agent-store.mjs";
import { FUTURE_WRITE_GENERATION, assertSameDurableRouteSemantics } from "./durable-state-v3.mjs";
import { listVersionThreeJobRecords, readVersionThreeJobRecord } from "./v3-job-store.mjs";
import { CLAUDE_CODE_HARNESS_ID, delegationModeForTopology } from "./claude-code-driver.mjs";
import { deriveBlockedContinuationRejection } from "./agent-blocking.mjs";
import {
  isLocallyCurrentOAuthCredential,
  isNativeOAuthCredentialObservation,
  observeClaudeCredentialState,
  sameCredentialGeneration,
} from "./claude-credential-state.mjs";
import {
  acknowledgeAgentCompletionEvents,
  readTargetedAgentCompletionSummaries,
} from "./completion-inbox.mjs";
import {
  HARNESS_CAPABILITY_NAMES,
  ROUTE_CAPABILITY_SCHEMA_VERSION,
  assertAdmittedInteraction,
  assertHarnessCapability,
  validateHarnessCapabilities,
} from "./harness-capabilities.mjs";
import {
  inspectionEvidenceForRoute,
  validateInstanceInspection,
} from "./harness-contract.mjs";
import {
  ADMITTED_GENERATION_HARNESS_IDS,
  assertNoHarnessImplementationSelector,
  assertStatedHarnessId,
  harnessExecutionLifecycle,
  acceptDriverRoute,
  createDriverScope,
  resolveDriverV2,
} from "./harness-registry.mjs";
import { createInternalAgentRuntime, preparedStartDisposition } from "./internal-runtime.mjs";
import {
  ACTIVE_JOB_STATUSES,
  generateJobId,
  getSteeringSnapshot,
  listJobsForAgentReconciliation,
  markAgentProjectionReconciled,
  readJobFile,
} from "./job-store.mjs";
import { readLaunchClaim } from "./launch-claim.mjs";
import { projectAgentCard } from "./agent-card.mjs";
import { ensureConfiguredOpencodeService } from "./opencode-service-manager.mjs";
import { enqueueControlCommand } from "./turn-control.mjs";
import { reconcilePreparedVersionThreeTurns } from "./v3-worker-entry.mjs";
import { admitTargetWorktree } from "./target-worktree-admission.mjs";
import { validateProcessIdentity } from "./process-control.mjs";
import { reconcileVersionThreeWorkerLoss } from "./v3-turn-reconciliation.mjs";
import { preflightTerminalEventDescriptor } from "./terminal-event-publisher.mjs";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "unknown"]);
const TERMINAL_AGENT_STATUSES = new Set(["completed", "interrupted", "errored"]);
const ACTIVATION_RECOVERY_GRACE_MS = 2_000;
const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_AGENT_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_NAME_PATTERN = /^[a-z0-9_]+$/;
const CLAUDE_SESSION_MODEL_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_TARGETED_WAIT_TARGETS = 8;
const SPAWN_RECOVERY_OUTCOMES = new Set(["lifecycle_owned", "ownership_uncertain"]);
const SPAWN_RECOVERY_CODES = Object.freeze({
  lifecycle_owned: "spawn_lifecycle_owned",
  ownership_uncertain: "spawn_ownership_uncertain",
});
const SPAWN_RECOVERY_MESSAGES = Object.freeze({
  lifecycle_owned: "Agent launch ownership was transferred; join the named Agent to reconcile its turn.",
  ownership_uncertain: "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
});
const DISPATCH_ROW_FIELDS = new Set([
  "task_name",
  "message",
  "description",
  "harness",
  "model",
  "reasoning_effort",
  "topology",
  "write",
  "target_worktree",
  "terminal_event_descriptor_path",
]);
const DISPATCH_REQUIRED_ROW_FIELDS = Object.freeze([
  "task_name",
  "message",
  "harness",
  "model",
  "reasoning_effort",
  "topology",
  "write",
]);
const DISPATCH_ERROR_MESSAGES = Object.freeze({
  agent_name_conflict: "A requested Agent name already exists in this root.",
  batch_cancelled: "Batch dispatch was cancelled before this row began.",
  batch_preflight_stopped: "Batch environment preflight stopped before this row could begin.",
  batch_stopped_after_ownership_uncertain: "An earlier row has uncertain launch ownership; this row was not attempted.",
  batch_writer_conflict: "Two write rows target the same canonical execution root.",
  route_rejected: "The requested row route failed environment preflight.",
  service_unavailable: "The requested Harness service failed bounded environment preflight.",
  spawn_rolled_back: "Agent launch was rolled back safely.",
  target_rejected: "The requested target worktree failed environment preflight.",
  row_launch_rejected: "The row failed a final gate before durable Agent ownership.",
});

function assertObject(value, label) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be non-empty text.`);
  }
  return value.trim();
}

function spawnAbortError() {
  const error = new Error("HarnessDock Agent spawn was cancelled by the caller.");
  error.name = "AbortError";
  return error;
}

function throwIfSpawnAborted(signal) {
  if (signal?.aborted) throw spawnAbortError();
}

function publicSpawnFailure(error, agent, outcome) {
  if (!SPAWN_RECOVERY_OUTCOMES.has(outcome)) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  const recovery = {
    agent_name: agent?.path,
    outcome,
    code: SPAWN_RECOVERY_CODES[outcome],
    message: SPAWN_RECOVERY_MESSAGES[outcome],
  };
  /** @type {any} */ (failure).handoffDisposition = outcome;
  /** @type {any} */ (failure).publicRecovery = Object.freeze(recovery);
  return failure;
}

function withBatchOutcome(error, outcome) {
  const failure = error instanceof Error ? error : new Error(String(error));
  /** @type {any} */ (failure).batchOutcome = outcome;
  return failure;
}

function rollbackSafeSpawnFailure(error, store, agent) {
  try {
    if (store.readAgent(agent.agentId)) return publicSpawnFailure(error, agent, "ownership_uncertain");
  } catch {
    return publicSpawnFailure(error, agent, "ownership_uncertain");
  }
  return withBatchOutcome(error, "rolled_back");
}

function dispatchError(code) {
  return Object.freeze({ code, message: DISPATCH_ERROR_MESSAGES[code] });
}

function dispatchAgentName(taskName) {
  return `/root/${taskName}`;
}

function dispatchRowResult(agentName, outcome, options = {}) {
  const agentExists = ["launched", "lifecycle_owned", "ownership_uncertain"].includes(outcome);
  const result = { agent_name: agentName, agent_exists: agentExists, outcome };
  if (outcome === "launched") result.card = options.card;
  else if (options.error) result.error = options.error;
  return Object.freeze(result);
}

function notAttemptedRows(rows, failures = new Map(), fallbackCode = "batch_preflight_stopped") {
  return rows.map((row, index) => dispatchRowResult(
    dispatchAgentName(row.task_name),
    "not_attempted",
    { error: dispatchError(failures.get(index) ?? fallbackCode) },
  ));
}

function validatedDispatchRows(inputValue) {
  const input = assertObject(inputValue, "dispatch_agents input");
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "rows")) {
    throw new Error("dispatch_agents accepts exactly one rows field.");
  }
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 8) {
    throw new Error("dispatch_agents rows must contain between 1 and 8 complete spawn rows.");
  }
  const taskNames = new Set();
  return input.rows.map((value, index) => {
    const row = assertObject(value, `dispatch_agents rows[${index}]`);
    const unknown = Object.keys(row).filter((key) => !DISPATCH_ROW_FIELDS.has(key));
    if (unknown.length) throw new Error(`dispatch_agents rows[${index}] does not support ${unknown[0]}.`);
    for (const field of DISPATCH_REQUIRED_ROW_FIELDS) {
      if (!Object.hasOwn(row, field)) throw new Error(`dispatch_agents rows[${index}] requires ${field}.`);
    }
    const taskName = assertText(row.task_name, `dispatch_agents rows[${index}] task_name`);
    if (!TASK_NAME_PATTERN.test(taskName)) {
      throw new Error(`dispatch_agents rows[${index}] task_name must match [a-z0-9_]+.`);
    }
    if (taskNames.has(taskName)) throw new Error(`dispatch_agents repeats task_name ${JSON.stringify(taskName)}.`);
    taskNames.add(taskName);
    const message = assertText(row.message, `dispatch_agents rows[${index}] message`);
    const harness = assertText(row.harness, `dispatch_agents rows[${index}] harness`);
    const model = assertText(row.model, `dispatch_agents rows[${index}] model`);
    const reasoningEffort = assertText(row.reasoning_effort, `dispatch_agents rows[${index}] reasoning_effort`);
    const topology = assertText(row.topology, `dispatch_agents rows[${index}] topology`);
    if (typeof row.write !== "boolean") throw new Error(`dispatch_agents rows[${index}] requires boolean write.`);
    let description;
    if (Object.hasOwn(row, "description")) {
      description = assertText(row.description, `dispatch_agents rows[${index}] description`);
    }
    let targetWorktree;
    if (Object.hasOwn(row, "target_worktree")) {
      targetWorktree = assertText(row.target_worktree, `dispatch_agents rows[${index}] target_worktree`);
      if (!path.isAbsolute(targetWorktree)) {
        throw new Error(`dispatch_agents rows[${index}] target_worktree must be absolute.`);
      }
    }
    let terminalEventDescriptorPath;
    if (Object.hasOwn(row, "terminal_event_descriptor_path")) {
      terminalEventDescriptorPath = assertText(row.terminal_event_descriptor_path, `dispatch_agents rows[${index}] terminal_event_descriptor_path`);
      if (!path.isAbsolute(terminalEventDescriptorPath)) throw new Error(`dispatch_agents rows[${index}] terminal_event_descriptor_path must be absolute.`);
    }
    return Object.freeze({
      task_name: taskName,
      message,
      ...(description == null ? {} : { description }),
      harness,
      model,
      reasoning_effort: reasoningEffort,
      topology,
      write: row.write,
      ...(targetWorktree == null ? {} : { target_worktree: targetWorktree }),
      ...(terminalEventDescriptorPath == null ? {} : { terminal_event_descriptor_path: terminalEventDescriptorPath }),
    });
  });
}

function admittedBatchRecovery(error, agentName) {
  const recovery = error?.publicRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return null;
  const outcome = String(recovery.outcome ?? "");
  if (!SPAWN_RECOVERY_OUTCOMES.has(outcome) || recovery.agent_name !== agentName ||
      recovery.code !== SPAWN_RECOVERY_CODES[outcome] || recovery.message !== SPAWN_RECOVERY_MESSAGES[outcome]) {
    return null;
  }
  return {
    outcome,
    error: Object.freeze({ code: recovery.code, message: recovery.message }),
  };
}

function versionThreeLaunchDisposition(ownerRootId, agentId, jobId) {
  let claim = null;
  try { claim = readLaunchClaim({ ownerRootId, agentId, jobId }); } catch {}
  if (!claim) return "ownership_uncertain";
  if (["rollback_in_progress", "rollback_complete"].includes(claim.submissionState)) return "rollback_safe";
  if (claim.acceptance === "acceptance_proven") return "lifecycle_owned";
  if (claim.acceptance === "acceptance_rejected" && claim.submissionState !== "started") {
    return "rollback_safe";
  }
  if (claim.acceptance === "not_submitted" && claim.submissionState === "not_started") {
    return "rollback_safe";
  }
  return "ownership_uncertain";
}

function optionalText(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim();
}

function messageText(messages) {
  return messages.map((message) => message.text).join("\n\n");
}

function resultSessionId(job) {
  return job?.threadId ?? job?.result?.sessionId ?? job?.recoverability?.exactSessionId ?? null;
}

function emptyEvidenceArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function sideEffectFreeAuthenticationFailure(job) {
  if (
    job?.status !== "failed" ||
    job?.preClaudeLaunch === true ||
    job?.parentJobId != null ||
    job?.result?.failureClass !== "auth_or_permission" ||
    job?.recoverability?.reason !== "auth_or_permission" ||
    job?.result?.assistantOutputObserved !== false ||
    !emptyEvidenceArray(job?.result?.toolUses) ||
    !emptyEvidenceArray(job?.result?.touchedFiles) ||
    !Array.isArray(job?.result?.attempts)
  ) {
    return false;
  }
  return job.result.attempts.every((attempt) =>
    attempt?.assistantOutputObserved === false &&
    emptyEvidenceArray(attempt?.toolUses) &&
    emptyEvidenceArray(attempt?.touchedFiles)
  );
}

function internalOptions(input, fallback = {}) {
  const requestedModel = input.model ?? fallback.model;
  return {
    write: input.write ?? fallback.write,
    profile: fallback.profile ?? "terminal-parity",
    model: requestedModel,
    effort: input.reasoning_effort ?? fallback.effort,
    permissionMode: fallback.permissionMode,
    dangerouslySkipPermissions: fallback.dangerouslySkipPermissions,
    delegationMode: input.delegation_mode ?? fallback.delegationMode,
  };
}

function validatedInternalOptions(driver, input, fallback = {}) {
  const options = internalOptions(input, fallback);
  const validated = driver.validateRoute(options);
  // A topology-changing route must name its canonical model explicitly. This
  // preserves a stable durable route while leaving each Driver responsible for
  // defining aliases, canonical model IDs, and topology compatibility.
  if (
    validated.delegationMode !== "leaf" &&
    String(options.model ?? "").trim() !== validated.model
  ) {
    throw new Error(
      `${validated.delegationMode} delegation requires exact model ${validated.model}.`
    );
  }
  return {
    ...options,
    profile: validated.name,
    model: validated.model,
    effort: validated.effort,
    delegationMode: validated.delegationMode,
    dangerouslySkipPermissions: validated.dangerouslySkipPermissions,
  };
}

function requiredSpawnModel(input) {
  const requested = optionalText(input.model);
  if (!requested) {
    throw new Error(
      "spawn_agent requires an explicit model: haiku/claude-haiku-4-5, " +
      "sonnet/claude-sonnet-5, opus/claude-opus-5, or fable/claude-fable-5."
    );
  }
  return requested;
}

function normalizedObservedModel(value) {
  const model = optionalText(value);
  if (!model) return null;
  const stripped = model.replace(/\[[^\]]+\]$/, "");
  return /^claude-haiku-4-5-\d{8}$/.test(stripped)
    ? "claude-haiku-4-5"
    : stripped;
}

function observedModelFromJob(job) {
  return normalizedObservedModel(
    job?.result?.runtimeReceipt?.model ??
    job?.runtimeReceipt?.model ??
    job?.result?.model ??
    job?.model
  );
}

function explicitRequestModel(job) {
  const requested = optionalText(job?.request?.model)?.replace(/\[[^\]]+\]$/, "") ?? null;
  return requested?.startsWith("claude-") ? requested : null;
}

function findClaudeSessionArtifact(claudeConfigDir, sessionId) {
  const target = `${optionalText(sessionId)}.jsonl`;
  const projects = path.join(String(claudeConfigDir ?? ""), "projects");
  if (target === "null.jsonl" || !fs.existsSync(projects)) return null;
  const pending = [projects];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === target) return candidate;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return null;
}

function claudeSessionArtifactKey(claudeConfigDir, sessionId) {
  return `${String(claudeConfigDir ?? "")}\0${String(sessionId ?? "")}`;
}

function expectedClaudeSessionArtifact(agent) {
  if (!agent.claudeConfigDir || !agent.claudeSessionId || !agent.workspaceRoot) return null;
  const projectDirectory = String(agent.workspaceRoot).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(
    agent.claudeConfigDir,
    "projects",
    projectDirectory,
    `${agent.claudeSessionId}.jsonl`,
  );
}

function findClaudeSessionArtifacts(agents, jobs) {
  const artifacts = new Map();
  const wantedByProjects = new Map();
  for (const agent of agents) {
    if (agent.selectedModel || !agent.claudeSessionId ||
        agent.continuation?.evidence?.reason === "legacy_agent_model_unsupported") continue;
    const latestJob = jobs.find((job) => job.id === agent.latestJobId) ?? null;
    if (observedModelFromJob(latestJob) || explicitRequestModel(latestJob)) continue;
    const key = claudeSessionArtifactKey(agent.claudeConfigDir, agent.claudeSessionId);
    const directCandidates = [
      agent.continuation?.evidence?.modelArtifactPath,
      expectedClaudeSessionArtifact(agent),
    ].filter(Boolean);
    const directArtifact = directCandidates.find((candidate) => fs.existsSync(candidate));
    if (directArtifact) {
      artifacts.set(key, directArtifact);
      continue;
    }
    if ([
      "legacy_agent_model_pending",
      "legacy_agent_model_unproven",
    ].includes(agent.continuation?.evidence?.reason)) continue;
    const projects = path.join(String(agent.claudeConfigDir ?? ""), "projects");
    const target = `${agent.claudeSessionId}.jsonl`;
    const wanted = wantedByProjects.get(projects) ?? new Map();
    wanted.set(target, claudeSessionArtifactKey(agent.claudeConfigDir, agent.claudeSessionId));
    wantedByProjects.set(projects, wanted);
  }
  for (const [projects, wanted] of wantedByProjects) {
    if (!fs.existsSync(projects)) continue;
    const pending = [projects];
    while (pending.length > 0 && wanted.size > 0) {
      const directory = pending.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        const key = wanted.get(entry.name);
        if (entry.isFile() && key) {
          artifacts.set(key, candidate);
          wanted.delete(entry.name);
        }
      }
    }
  }
  return artifacts;
}

function observedModelFromClaudeArtifact(claudeConfigDir, sessionId, artifacts = null) {
  const artifact = artifacts == null
    ? findClaudeSessionArtifact(claudeConfigDir, sessionId)
    : artifacts.get(claudeSessionArtifactKey(claudeConfigDir, sessionId)) ?? null;
  if (!artifact) return null;
  let descriptor;
  try {
    descriptor = fs.openSync(artifact, "r");
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, CLAUDE_SESSION_MODEL_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (size > length) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const model = normalizedObservedModel(
          event?.message?.model ?? event?.model ?? event?.data?.model ?? event?.event?.model
        );
        if (model) return model;
      } catch {
        // Ignore malformed or partial JSONL lines while scanning bounded tail evidence.
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
  return null;
}

function canonicalAgentStatus(agent) {
  switch (agent.status) {
    case "pending_init":
      return "starting";
    case "running":
      return "working";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    default:
      return "failed";
  }
}

function canonicalFrozenAgentStatus(status) {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "errored":
      return "failed";
    default:
      return "failed";
  }
}

function observedAgentStatus(agent, job) {
  if (!job || job.agentId !== agent.agentId) return canonicalAgentStatus(agent);
  switch (job.status) {
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
    case "unknown":
      return "failed";
    default:
      return canonicalAgentStatus(agent);
  }
}

function observedAgentJob(agent, job, ownerRootId) {
  if (!job || job.agentId !== agent.agentId) return null;
  const jobOwnerRootId = typeof job.ownerRootId === "string" && job.ownerRootId.trim()
    ? job.ownerRootId.trim()
    : typeof job.sessionId === "string" && job.sessionId.trim()
      ? job.sessionId.trim()
      : null;
  return jobOwnerRootId === ownerRootId ? job : null;
}

function publicSpawnReceipt(cwd, agent, inspectionEvidence = null) {
  const job = agent.activeJobId ? readJobFile(cwd, agent.activeJobId) : null;
  return {
    ...projectAgentCard(agent, job, { inspectionEvidence }),
    status: canonicalAgentStatus(agent),
  };
}

function publicFollowupReceipt(agent, delivery) {
  return {
    agent_name: agent.path,
    delivery,
  };
}

function publicCompletionUpdate(summary, agents) {
  const agent = agents.find((candidate) => candidate.agentId === summary.agentId);
  return {
    kind: "completion",
    agent_name: agent?.path ?? summary.agentId,
    // Completion delivery is at-least-once. Keep every token's terminal status
    // tied to the frozen inbox fact instead of a later follow-up lifecycle.
    agent_status: canonicalFrozenAgentStatus(summary.agentStatus),
    summary: summary.summary,
    completion_message: summary.completionMessage,
    completion_message_truncated: summary.completionMessageTruncated,
    delivery_token: summary.deliveryToken,
    // Pass through the frozen value exactly as stored; never recompute it
    // from the Agent's current (possibly later) lifecycle.
    blocking: summary.blocking ?? null,
    metrics: summary.metrics ?? null,
  };
}

/**
 * Build a blocked-Agent activation rejection from the closed `reason`,
 * `scope`, and `retry` triple alone. `agent.continuation.evidence.reason` is
 * consulted only through `deriveBlockedContinuationRejection`, which reduces
 * it to a recognized closed literal or treats it as absent — including
 * version-1 legacy Agent model migration's own `legacy_agent_model_unsupported`
 * and `legacy_agent_model_unproven` reasons, which resolve to
 * `route_unsupported` there. No raw evidence text (which can carry
 * `job.errorMessage` prose, a PID, a native session ID, or a `claude --resume`
 * command) ever reaches this message.
 */
function blockedContinuationRejection(agent, verb) {
  const blocking = deriveBlockedContinuationRejection({
    continuationEvidenceReason: agent.continuation.evidence?.reason ?? null,
    continuationMode: agent.continuation.mode,
  });
  return new Error(
    `Agent ${agent.path} cannot ${verb}: blocked ` +
    `(reason=${blocking.reason}, scope=${blocking.scope}, retry=${blocking.retry}).`
  );
}

function publicProgressUpdate(update, agents) {
  const agent = agents.find((candidate) => candidate.agentId === update.agentId);
  return {
    kind: "progress",
    agent_name: agent?.path ?? update.agentId,
    agent_status: agent ? canonicalAgentStatus(agent) : "failed",
    progress: {
      revision: update.progress.revision,
      activity: update.progress.activity,
      phase: update.progress.phase,
      summary: update.progress.summary,
      updated_at: update.progress.updatedAt,
    },
  };
}

function publicTargetTerminalStatus(jobStatus, agentStatus) {
  if (jobStatus === "completed" || agentStatus === "completed") return "completed";
  if (jobStatus === "interrupted" || agentStatus === "interrupted") return "interrupted";
  if (TERMINAL_JOB_STATUSES.has(jobStatus) || agentStatus === "errored") return "failed";
  return canonicalAgentStatus({ status: agentStatus });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPreClaudeActivation(job) {
  return job?.preClaudeLaunch === true;
}

function isTerminalPreClaudeActivation(job) {
  return isPreClaudeActivation(job) && TERMINAL_JOB_STATUSES.has(job?.status);
}

function requeuePreClaudeMailboxMessage(message, jobId) {
  if (
    message.assignedJobId !== jobId ||
    !["assigned", "dispatched"].includes(message.state)
  ) {
    return message;
  }
  // The durable child boundary was never crossed, so any historical dispatch
  // receipt is a pre-launch artifact, not proof that Claude consumed input.
  // Remove it before making the message eligible for the next winning turn.
  const { receipt, ...withoutReceipt } = message;
  return {
    ...withoutReceipt,
    state: "queued",
    assignedJobId: null,
    assignedAt: null,
    deliveryIntent: null,
    dispatchedAt: null,
    acknowledgedAt: null,
  };
}

/**
 * The closed reason one accepted route does not admit an operation, or `null`
 * when it does. Only a version-three Agent carries a route capability snapshot;
 * a legacy record keeps its existing version-one capability handling, so this
 * never changes what a Claude Agent created before this generation can do.
 */
/**
 * The version-one capability snapshot to hold one Agent to, or `null` when the
 * question has already been answered by a frozen route.
 *
 * A version-three Agent states its capabilities in the route capability
 * vocabulary, which `unsupportedRouteOperation()` has already read by the time
 * any caller reaches this. Re-asking in the version-one vocabulary would
 * validate a snapshot that record deliberately does not carry.
 */
function versionOneCapabilitySnapshot(agent, driver) {
  if (agent?.version === 3) return null;
  return agent?.capabilities ?? driver?.capabilities ?? null;
}

function unsupportedRouteOperation(agent, capability, admitted) {
  const values = agent?.version === 3 ? agent?.route?.capabilities?.values : null;
  if (!values) return null;
  const value = values[capability];
  if (typeof value !== "string" || admitted.includes(value)) return null;
  return { operation: capability, value, harness: agent.harnessId ?? null };
}

class AgentRuntime {
  constructor(options = {}) {
    this.jobs = createInternalAgentRuntime(options);
    this.abortSignal = options.abortSignal ?? null;
    this.ownerRootId = this.jobs.assertOwnerRoot();
    this.cwd = this.jobs.cwd;
    this.store = createAgentStore({
      cwd: this.cwd,
      ownerRootId: this.ownerRootId,
      // The Driver contract this supervisor resolved is what every new durable
      // Agent records; it is never inferred from a model name or caller input.
      harness: {
        harnessId: this.jobs.driver.harnessId,
        driverVersion: this.jobs.driver.driverVersion,
        capabilities: this.jobs.driver.capabilities,
        instanceKey: this.jobs.harnessInstance.instanceKey,
      },
    });
  }

  /**
   * The store that writes version-three Agents. Version three is the record
   * shape whose whole route -- Harness, instance, model, topology, authority,
   * Driver version, capability schema -- is immutable from creation, which is
   * exactly what an explicitly stated route deserves.
   */
  versionThreeStore() {
    return createAgentStore({
      cwd: this.cwd,
      ownerRootId: this.ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
    });
  }

  /**
   * The durable store that owns one Agent's record generation.
   *
   * A version-three record is fenced out of the public generation's own store,
   * so every mutation of one -- a mailbox entry, an activation, a terminal
   * projection -- has to be made through the store that states the write
   * generation version three belongs to. Reads are unfenced and stay on the
   * runtime's own store.
   *
   * Store routing keys on the RECORD VERSION because it is about the write
   * generation a record belongs to. Turn steering keys on the Harness's
   * EXECUTION LIFECYCLE instead, because that is about which machine owns the
   * running turn. The two questions have different answers for the same Agent
   * and must never be collapsed into one test.
   */
  storeForAgent(agent) {
    return agent?.version === 3 ? this.versionThreeStore() : this.store;
  }

  storeForDriver(driver) {
    return createAgentStore({
      cwd: this.cwd,
      ownerRootId: this.ownerRootId,
      harness: {
        harnessId: driver.harnessId,
        driverVersion: driver.driverVersion,
        capabilities: driver.capabilities,
        instanceKey: driver.resolveInstanceKey(this.jobs.env),
      },
    });
  }

  rootJobs() {
    const activeJobIds = new Set(
      this.store.listAgents().map((agent) => agent.activeJobId).filter(Boolean)
    );
    return listJobsForAgentReconciliation(this.cwd, this.ownerRootId)
      .map((job) => this.jobs.migrateMatchingLegacyOwner(job))
      .filter((job) =>
        (typeof job.agentId === "string" && job.agentId) || activeJobIds.has(job.id)
      );
  }

  migrateLegacySelectedModel(agent, jobs, sessionArtifacts = null) {
    if (agent.selectedModel ||
        agent.continuation?.evidence?.reason === "legacy_agent_model_unsupported") return;
    const latestJob = jobs.find((job) => job.id === agent.latestJobId) ?? null;
    const observed = observedModelFromJob(latestJob)
      ?? observedModelFromClaudeArtifact(agent.claudeConfigDir, agent.claudeSessionId, sessionArtifacts);
    const candidate = observed ?? explicitRequestModel(latestJob);
    if (candidate) {
      try {
        // Legacy version-1 state is always Claude Code. Let its admitted Driver
        // normalize the observed model instead of importing a Claude catalog
        // into the Harness-neutral Agent supervisor.
        const selectedModel = this.jobs.driver.validateRoute({
          model: candidate,
          write: false,
          delegationMode: agent.delegationMode ?? "leaf",
        }).model;
        this.store.updateAgent(agent.agentId, (current) => {
          if (current.selectedModel) return current;
          const migrationReason = current.continuation?.evidence?.reason;
          if (!["legacy_agent_model_pending", "legacy_agent_model_unproven"].includes(migrationReason)) {
            return { ...current, selectedModel };
          }
          const priorEvidence = { ...current.continuation.evidence };
          delete priorEvidence.reason;
          delete priorEvidence.modelMigrationBlockedAt;
          delete priorEvidence.modelMigrationDeferredAt;
          return {
            ...current,
            selectedModel,
            continuation: {
              mode: migrationReason === "legacy_agent_model_unproven"
                ? (current.claudeSessionId ? "exact_session" : "none")
                : current.continuation.mode,
              evidence: {
                ...priorEvidence,
                reason: "legacy_agent_model_migrated",
                observedModel: candidate,
                modelMigrationRecoveredAt: new Date().toISOString(),
              },
            },
          };
        });
        return;
      } catch {
        if (agent.continuation.mode === "blocked") return;
        this.store.updateAgent(agent.agentId, (current) => ({
          ...current,
          continuation: {
            mode: "blocked",
            evidence: {
              ...(current.continuation?.evidence ?? {}),
              reason: "legacy_agent_model_unsupported",
              observedModel: candidate,
              modelMigrationBlockedAt: new Date().toISOString(),
            },
          },
        }));
        return;
      }
    }
    if (agent.activeJobId || !TERMINAL_AGENT_STATUSES.has(agent.status)) {
      if (agent.continuation?.evidence?.reason === "legacy_agent_model_pending") return;
      const modelArtifactPath = sessionArtifacts?.get(
        claudeSessionArtifactKey(agent.claudeConfigDir, agent.claudeSessionId),
      ) ?? expectedClaudeSessionArtifact(agent);
      this.store.updateAgent(agent.agentId, (current) => ({
        ...current,
        continuation: {
          ...current.continuation,
          evidence: {
            ...(current.continuation?.evidence ?? {}),
            reason: "legacy_agent_model_pending",
            modelMigrationDeferredAt: new Date().toISOString(),
            ...(modelArtifactPath ? { modelArtifactPath } : {}),
          },
        },
      }));
      return;
    }
    if (agent.continuation?.evidence?.reason === "legacy_agent_model_unproven") return;
    if (!agent.claudeSessionId || agent.continuation.mode === "blocked") return;
    const modelArtifactPath = sessionArtifacts?.get(
      claudeSessionArtifactKey(agent.claudeConfigDir, agent.claudeSessionId),
    ) ?? expectedClaudeSessionArtifact(agent);
    this.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      continuation: {
        mode: "blocked",
        evidence: {
          ...(current.continuation?.evidence ?? {}),
          reason: "legacy_agent_model_unproven",
          modelMigrationBlockedAt: new Date().toISOString(),
          ...(modelArtifactPath && fs.existsSync(modelArtifactPath) ? { modelArtifactPath } : {}),
        },
      },
    }));
  }

  recoverMissingActivation(agent, jobs, now = Date.now(), options = {}) {
    const jobId = agent.activeJobId;
    const evidence = agent.continuation?.evidence ?? {};
    const terminatedPreparedJob = options.terminatedPreparedJobId === jobId;
    if (!jobId || (!terminatedPreparedJob && jobs.some((job) => job.id === jobId))) return false;
    if (evidence.activationJobId !== jobId) return false;
    if (!["initial", "followup"].includes(evidence.activationKind)) return false;

    const reservedAt = Date.parse(evidence.activationReservedAt ?? agent.updatedAt ?? "");
    if (!terminatedPreparedJob &&
      (!Number.isFinite(reservedAt) || now - reservedAt < ACTIVATION_RECOVERY_GRACE_MS)) return false;

    const recoveryReason = terminatedPreparedJob
      ? "activation_prepared_job_terminated_before_attach"
      : "activation_missing_job_after_grace";

    const initial = evidence.activationKind === "initial";
    if (initial && agent.latestJobId == null && !agent.claudeSessionId) {
      try {
        this.store.updateAgent(agent.agentId, (current) => ({
          ...current,
          activeJobId: current.activeJobId === jobId ? null : current.activeJobId,
          status: "pending_init",
          continuation: {
            mode: "safe_fresh",
            evidence: {
              reason: initial && terminatedPreparedJob
                ? "initial_activation_prepared_job_terminated_before_attach"
                : "initial_activation_missing_job_after_grace",
              activationJobId: jobId,
              recoveredAt: new Date(now).toISOString(),
            },
          },
          mailbox: {
            ...current.mailbox,
            messages: current.mailbox.messages.map((message) =>
              requeuePreClaudeMailboxMessage(message, jobId)
            ),
          },
        }));
        // Do not request a destructive rollback. The store atomically keeps a
        // pending-init Agent whenever a sender raced this recovery, while an
        // empty never-launched Agent is still reclaimed.
        this.store.rollbackReservation(agent.agentId);
        return true;
      } catch {
        return false;
      }
    }

    const priorStatus = TERMINAL_AGENT_STATUSES.has(evidence.activationPreviousStatus)
      ? evidence.activationPreviousStatus
      : agent.continuation?.mode === "exact_session"
        ? "completed"
        : "errored";
    try {
      this.store.updateAgent(agent.agentId, (current) => ({
        ...current,
        activeJobId: current.activeJobId === jobId ? null : current.activeJobId,
        status: priorStatus,
        continuation: {
          ...current.continuation,
          evidence: {
            ...current.continuation.evidence,
            reason: recoveryReason,
            activationRecoveryJobId: jobId,
            activationRecoveredAt: new Date(now).toISOString(),
          },
        },
        mailbox: {
          ...current.mailbox,
          messages: current.mailbox.messages.map((message) =>
            terminatedPreparedJob
              ? requeuePreClaudeMailboxMessage(message, jobId)
              : message.state === "assigned" && message.assignedJobId === jobId
                ? {
                    ...message,
                    state: "queued",
                    assignedJobId: null,
                    assignedAt: null,
                    deliveryIntent: null,
                  }
                : message
          ),
        },
      }));
      return true;
    } catch {
      return false;
    }
  }

  acknowledgeMailboxFromJob(agent, job) {
    const steering = getSteeringSnapshot(this.cwd, job.id);
    for (const message of this.store.listMessages(agent.agentId)) {
      if (message.assignedJobId !== job.id || message.state !== "dispatched") continue;
      const receipt = message.receipt ?? {};
      const initialPrompt = receipt.delivery === "initial_prompt";
      const steeringSequence = Number(receipt.steeringSequence ?? 0);
      if (
        (initialPrompt && TERMINAL_JOB_STATUSES.has(job.status)) ||
        (steeringSequence > 0 && steering.latestAcknowledgedSequence >= steeringSequence)
      ) {
        this.store.acknowledgeMessage(agent.agentId, message.messageId, {
          jobId: job.id,
          receipt: {
            delivery: initialPrompt ? "terminal_initial_prompt" : "stream_acknowledged",
            steeringSequence: steeringSequence || null,
          },
        });
      }
    }
  }

  requeueAssignedMessage(agentId, messageId, jobId) {
    this.store.updateAgent(agentId, (agent) => ({
      ...agent,
      mailbox: {
        ...agent.mailbox,
        messages: agent.mailbox.messages.map((message) =>
          message.messageId === messageId &&
          message.state === "assigned" &&
          message.assignedJobId === jobId
            ? {
                ...message,
                state: "queued",
                assignedJobId: null,
                assignedAt: null,
                deliveryIntent: null,
              }
            : message
        ),
      },
    }));
  }

  reconcile() {
    // Grace is evaluated at the beginning of this pass.  Scanning a large
    // retained receipt set can itself take longer than the grace window, and
    // must not turn a healthy just-reserved activation into a false orphan.
    const reconciliationStartedAt = Date.now();
    let versionThreePreparationReceipts;
    try {
      versionThreePreparationReceipts = reconcilePreparedVersionThreeTurns({
        cwd: this.cwd,
        ownerRootId: this.ownerRootId,
        reconciliationStartedAt,
      });
    } catch {
      versionThreePreparationReceipts = [{
        jobId: null,
        reconciled: false,
        reason: "v3_pre_submission_scan_deferred",
      }];
    }
    const jobs = this.rootJobs();
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const diagnosticReceipts = [];
    const agentsByActiveJob = new Map(
      this.store.listAgents()
        .filter((agent) => agent.activeJobId)
        .map((agent) => [agent.activeJobId, agent])
    );
    for (const job of jobs) {
      if (!isTerminalPreClaudeActivation(job) || job.agentProjectionReconciledAt) continue;
      const target = job.agentId ?? agentsByActiveJob.get(job.id)?.agentId ?? null;
      if (!target) continue;
      try {
        const recovery = this.store.recoverPreClaudeActivation(target, job.id);
        if (!recovery.recovered) {
          diagnosticReceipts.push({
            jobId: job.id,
            reconciled: false,
            reason: recovery.reason ?? "pre_claude_recovery_deferred",
          });
          continue;
        }
        markAgentProjectionReconciled(this.cwd, job.id);
        diagnosticReceipts.push({
          jobId: job.id,
          reconciled: true,
          reason: "pre_claude_activation_recovered",
          agent: recovery.agent,
        });
      } catch (error) {
        diagnosticReceipts.push({
          jobId: job.id,
          reconciled: false,
          reason: "pre_claude_recovery_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ordinaryJobs = jobs.filter((job) => !isTerminalPreClaudeActivation(job));
    const ordinaryReceipts = this.store.reconcileFromJobs(ordinaryJobs);
    const receipts = [...versionThreePreparationReceipts, ...diagnosticReceipts, ...ordinaryReceipts];
    for (const receipt of ordinaryReceipts) {
      if (!receipt.jobId) continue;
      const projectionMarkerMissing = !jobsById.get(receipt.jobId)?.agentProjectionReconciledAt;
      if (!receipt.reconciled && !(receipt.reason === "already_finalized" && projectionMarkerMissing)) {
        continue;
      }
      try {
        markAgentProjectionReconciled(this.cwd, receipt.jobId);
      } catch {
        // The Agent projection is already durable. A later cleanup/reconcile
        // pass may record the missing pruning marker if this job still exists.
      }
    }
    const agentsBeforeMigration = this.store.listAgents();
    const sessionArtifacts = findClaudeSessionArtifacts(agentsBeforeMigration, jobs);
    for (const agent of agentsBeforeMigration) {
      this.migrateLegacySelectedModel(agent, jobs, sessionArtifacts);
    }
    for (const agent of this.store.listAgents()) {
      const jobId = agent.activeJobId ?? agent.latestJobId;
      const job = jobId ? jobs.find((candidate) => candidate.id === jobId) : null;
      if (!job) {
        this.recoverMissingActivation(agent, jobs, reconciliationStartedAt);
        continue;
      }
      if (isTerminalPreClaudeActivation(job)) {
        // Dedicated recovery runs before generic projection. If it could not
        // complete, retain the receipt and make no session, mailbox, or
        // completion mutation in this pass.
        continue;
      }
      const sessionId = resultSessionId(job);
      if (sessionId && !agent.claudeSessionId && ACTIVE_JOB_STATUSES.has(job.status)) {
        try {
          this.store.bindSession(agent.agentId, sessionId, {
            jobId: job.id,
            harnessId: job.harnessId ?? agent.harnessId,
            instanceKey: job.harnessInstanceKey ?? this.jobs.harnessInstance.instanceKey,
          });
        } catch {
          // The Agent store persists drift/binding evidence. Reconciliation
          // continues so completion delivery remains available.
        }
      }
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        for (const message of this.store.listMessages(agent.agentId, { state: "assigned" })) {
          if (message.assignedJobId === job.id) {
            // Follow-up messages are atomically marked as an initial prompt
            // before their job record becomes visible. A crash before the
            // normal post-start acknowledgement must not requeue and replay a
            // prompt that the terminal job already consumed.
            if (message.deliveryIntent === "initial_prompt") {
              this.store.markMessageDispatched(agent.agentId, message.messageId, {
                jobId: job.id,
                receipt: { delivery: "initial_prompt" },
              });
            } else {
              this.requeueAssignedMessage(agent.agentId, message.messageId, job.id);
            }
          }
        }
      } else if (ACTIVE_JOB_STATUSES.has(job.status) && job.status !== "interrupting") {
        for (const message of this.store.listMessages(agent.agentId, { state: "assigned" })) {
          if (message.assignedJobId === job.id) this.deliverAssignedMessage(agent, message);
        }
      }
      this.acknowledgeMailboxFromJob(agent, job);
    }
    return receipts;
  }

  rollbackActivation(agentId, jobId, previous, {
    initial = false,
    removableMessageId = null,
  } = {}) {
    // The rollback has to be written by the store that owns the record's write
    // generation; the public generation's own store is fenced out of a
    // version-three record and would silently leave a half-created Agent.
    const store = this.storeForAgent(previous ?? this.store.readAgent(agentId));
    try {
      store.updateAgent(agentId, (agent) => ({
        ...agent,
        activeJobId: agent.activeJobId === jobId ? null : agent.activeJobId,
        status: previous.status,
        continuation: previous.continuation,
        mailbox: {
          ...agent.mailbox,
          messages: agent.mailbox.messages.map((message) =>
            initial
              ? requeuePreClaudeMailboxMessage(message, jobId)
              : message.assignedJobId === jobId && message.state === "assigned"
              ? {
                  ...message,
                  state: "queued",
                  assignedJobId: null,
                  assignedAt: null,
                  deliveryIntent: null,
                }
              : message
          ),
        },
      }));
      // An initial activation that failed before its turn was established may
      // have received sender messages. Let the store delete only an empty
      // pending-init record; queued messages are the durable reason to keep it.
      if (initial) store.rollbackReservation(agentId, { removableMessageId });
    } catch {
      // A durable job may already exist. Later reconciliation is authoritative.
    }
  }

  /**
   * Create one version-three Agent on an accepted route and hand its first turn
   * to a detached worker.
   *
   * The order is the durable one: the Agent identity and its first mailbox
   * message exist before the activation is reserved, the activation exists
   * before the worker is launched, and the worker owns the launch claim,
   * submission fence, instance lease, and settlement from there. If the worker
   * cannot be handed the turn, the activation and its unread first message are
   * rolled back so nothing half-exists.
   */
  async spawnVersionThreeAgent({ accepted, taskName, description, message, jobId, turnOptions, executionRoot, terminalEventBinding = null }) {
    throwIfSpawnAborted(this.abortSignal);
    const inspectionEvidence = inspectionEvidenceForRoute(
      accepted.route, accepted.inspection, accepted.driver
    );
    const store = this.versionThreeStore();
    const agent = store.createAgent({
      task_name: taskName,
      description,
      route: accepted.route,
      executionRoot,
      initialMessage: message,
      ...(terminalEventBinding == null ? {} : {
        terminalEventBinding: { ...terminalEventBinding, jobId },
      }),
    });
    const initialMessage = store.listMessages(agent.agentId)[0];
    try {
      throwIfSpawnAborted(this.abortSignal);
      const activation = store.reserveActivation(agent.agentId, jobId, { initial: true });
      if (!activation.reserved) {
        store.rollbackReservation(agent.agentId, { removableMessageId: initialMessage?.messageId });
        throw rollbackSafeSpawnFailure(
          new Error(`Unable to activate ${agent.path}: ${activation.reason}.`),
          store,
          agent,
        );
      }
      throwIfSpawnAborted(this.abortSignal);
      const attemptId = generateJobId("attempt");
      let launchAttempted = false;
      try {
        launchAttempted = true;
        await this.jobs.launchVersionThreeWorker({
          agentId: agent.agentId,
          jobId,
          attemptId,
          turnOptions,
          executionRoute: accepted.route,
          inspectionEvidence,
        });
        if (this.abortSignal?.aborted) {
          const outcome = versionThreeLaunchDisposition(this.ownerRootId, agent.agentId, jobId);
          if (outcome === "rollback_safe") throw spawnAbortError();
          throw publicSpawnFailure(spawnAbortError(), agent, outcome);
        }
        return publicSpawnReceipt(this.cwd, store.resolveTarget(agent.agentId), inspectionEvidence);
      } catch (error) {
        const stated = String(error?.handoffDisposition ?? "");
        const handoffDisposition = SPAWN_RECOVERY_OUTCOMES.has(stated) || stated === "rollback_safe"
          ? stated
          : launchAttempted
            ? versionThreeLaunchDisposition(this.ownerRootId, agent.agentId, jobId)
            : "rollback_safe";
        if (handoffDisposition === "rollback_safe") {
          // The detached worker owns claim rollback once a claim exists. Before
          // that claim, restore the reserved activation and remove only the
          // empty initial reservation.
          let claim = null;
          try { claim = readLaunchClaim({ ownerRootId: this.ownerRootId, agentId: agent.agentId, jobId }); } catch {
            throw publicSpawnFailure(error, agent, "ownership_uncertain");
          }
          if (!claim) {
            try {
              store.rollbackVersionThreeActivation(agent.agentId, {
                jobId,
                removableMessageId: initialMessage?.messageId,
                rollbackClaim: null,
              });
            } catch {}
            try {
              store.rollbackReservation(agent.agentId, { removableMessageId: initialMessage?.messageId });
            } catch {}
          }
          throw rollbackSafeSpawnFailure(error, store, agent);
        }
        throw publicSpawnFailure(error, agent, handoffDisposition);
      }
    } catch (error) {
      // Cancellation and pre-reservation validation must not leave an empty
      // Agent behind. The guarded store operation is idempotent with a racing
      // sender and preserves any concurrently queued message.
      let finalError = error;
      if (error?.name === "AbortError") {
        let claim = null;
        try { claim = readLaunchClaim({ ownerRootId: this.ownerRootId, agentId: agent.agentId, jobId }); } catch {}
        if (!claim) {
          try {
            store.rollbackVersionThreeActivation(agent.agentId, {
              jobId,
              removableMessageId: initialMessage?.messageId,
              rollbackClaim: null,
            });
          } catch {}
          try { store.rollbackReservation(agent.agentId, { removableMessageId: initialMessage?.messageId }); } catch {}
          finalError = rollbackSafeSpawnFailure(error, store, agent);
        } else {
          const outcome = versionThreeLaunchDisposition(this.ownerRootId, agent.agentId, jobId);
          if (outcome !== "rollback_safe") finalError = publicSpawnFailure(error, agent, outcome);
        }
      }
      throw finalError;
    }
  }

  async followupVersionThreeAgent(input, initialAgent) {
    const store = this.versionThreeStore();
    const taskInput = assertText(input.message, "followup_task message");
    if (input.reasoning_effort != null) {
      throw new Error("followup_task inherits its immutable accepted route; reasoning_effort is not an input.");
    }
    const requestedTurnOptions = null;
    const turnOptions = typeof initialAgent.route?.effort === "string"
      ? { effort: initialAgent.route.effort }
      : null;

    this.reconcile();
    let agent = store.resolveTarget(initialAgent.agentId);
    if (agent.continuation.mode === "blocked") {
      throw blockedContinuationRejection(agent, "continue");
    }

    // An active version-three worker owns its durable mailbox directly. A
    // follow-up delivered there is steering for the current turn, not a new
    // turn on which a different reasoning effort could take effect.
    if (agent.activeJobId) {
      if (requestedTurnOptions != null) {
        throw new Error(
          "followup_task reasoning_effort applies only when activating a new turn; " +
          "this Agent already has an active version-three turn."
        );
      }
      const queued = store.enqueueMessage(agent.agentId, taskInput, { kind: "followup_task" });
      return publicFollowupReceipt(
        store.resolveTarget(agent.agentId),
        queued.delivery === "assigned_active" ? "activation_pending" : "queued_no_turn",
      );
    }

    if (typeof agent.route.effort !== "string") {
      throw new Error(`Agent ${agent.path} has a historical route without explicit effort and cannot activate.`);
    }
    const jobId = generateJobId("hd-agent");
    const observed = await this.jobs.inspectRouteInstance(agent.route.harnessId);
    const matchingInspections = observed.inspections.filter((inspection) =>
      inspection.instanceKey === agent.route.instanceKey && inspection.readiness === "ready"
    );
    if (matchingInspections.length !== 1) {
      throw new Error(`Agent ${agent.path} requires exactly one current ready inspection for its immutable route instance.`);
    }
    const admitted = acceptDriverRoute(observed.driver, {
      harnessId: agent.route.harnessId,
      model: agent.route.model,
      topology: agent.route.topology,
      authority: agent.route.authority,
      effort: agent.route.effort,
    }, matchingInspections);
    const executionRoute = Object.freeze({
      ...admitted.route,
      capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    });
    assertSameDurableRouteSemantics(agent.route, executionRoute, `Agent ${agent.path}`);
    const inspectionEvidence = inspectionEvidenceForRoute(executionRoute, admitted.inspection, observed.driver);
    // Pure Driver validation precedes every durable mailbox or activation
    // mutation. The detached worker recomputes the same prepared turn from the
    // assigned batch and revalidates the host immediately before submission.
    observed.driver.prepareTurn({
      route: executionRoute,
      taskInput,
      turnOptions,
      turnId: jobId,
    });
    const queued = store.enqueueMessage(agent.agentId, taskInput, { kind: "followup_task" });
    agent = queued.agent;
    if (queued.delivery === "assigned_active") {
      // Another caller won the activation race. This message is already bound
      // to that live worker and must never be launched or replayed here.
      return publicFollowupReceipt(store.resolveTarget(agent.agentId), "activation_pending");
    }

    const activation = store.reserveActivation(agent.agentId, jobId, {
      initial: agent.status === "pending_init" && agent.latestJobId == null,
    });
    if (!activation.reserved && activation.reason === "already_active") {
      return publicFollowupReceipt(store.resolveTarget(agent.agentId), "activation_pending");
    }
    if (!activation.reserved) {
      throw new Error(`Unable to activate ${agent.path}: ${activation.reason}.`);
    }

    const attemptId = generateJobId("attempt");
    await this.jobs.launchVersionThreeWorker({
      agentId: agent.agentId,
      jobId,
      attemptId,
      turnOptions,
      executionRoute,
      inspectionEvidence,
    });
    return publicFollowupReceipt(store.resolveTarget(agent.agentId), "new_turn");
  }

  /**
   * Accept one fully stated route before anything durable exists.
   *
   * Every field is the caller's explicit decision: the Harness, the full model
   * identifier, the topology, and the behavioral authority. Nothing here
   * defaults, infers, aliases, or remembers a previous choice, and no Harness is
   * preferred. The Driver that owns the stated Harness decides whether the route
   * is admissible; a Harness with no ready logical instance, a model that
   * Harness does not serve, a topology it does not admit, an authority it
   * refuses, or a capability snapshot needing an approval broker all fail here,
   * before any readiness side effect, durable write, session, or native turn.
   */
  async ensureDispatchHarness(harnessId, executionRoot) {
    if (harnessId !== "opencode") return;
    await ensureConfiguredOpencodeService({
      cwd: executionRoot,
      env: this.jobs.env,
    });
  }

  async acceptStatedRoute(input, label, executionRoot = this.cwd, observedRoute = null) {
    const harnessId = assertText(input.harness, `${label} harness`);
    if (!ADMITTED_GENERATION_HARNESS_IDS.includes(harnessId)) {
      throw new Error(
        `${label} states Harness ${JSON.stringify(harnessId)}; this runtime admits only ` +
        `${ADMITTED_GENERATION_HARNESS_IDS.join(", ")}. There is no default Harness.`
      );
    }
    const model = assertText(input.model, `${label} model`);
    const topology = assertText(input.topology, `${label} topology`);
    if (typeof input.write !== "boolean") {
      throw new Error(`${label} requires explicit boolean write authority.`);
    }
    if (typeof input.reasoning_effort !== "string" || !input.reasoning_effort.trim()) {
      throw new Error(`${label} requires explicit reasoning_effort.`);
    }
    // One route-time readiness observation, through the runtime's own seam.
    const observed = observedRoute ?? await this.jobs.inspectRouteInstance(harnessId, executionRoot);
    const driver = observed.driver;
    const request = {
      harnessId,
      model,
      topology,
      authority: input.write ? "behavioral_write" : "behavioral_read_only",
      ...(input.reasoning_effort == null ? {} : { effort: input.reasoning_effort }),
    };
    const { route, inspection } = acceptDriverRoute(driver, request, observed.inspections);
    assertAdmittedInteraction(route.capabilities, `Harness ${harnessId} route`);
    return Object.freeze({
      driver,
      inspection,
      // The version-one launch receipt this same observation produced, when the
      // owning Driver offered one. It is what keeps a spawn to ONE host
      // observation instead of two.
      launchReadiness: observed.launchReadiness ?? null,
      route: Object.freeze({ ...route, capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION }),
    });
  }

  async dispatchAgents(inputValue) {
    const rows = validatedDispatchRows(inputValue);
    const cancelled = () => Object.freeze({
      rows: notAttemptedRows(rows, new Map(), "batch_cancelled"),
    });
    if (this.abortSignal?.aborted) return cancelled();

    const executionRoots = [];
    for (let index = 0; index < rows.length; index += 1) {
      try {
        executionRoots.push(admitTargetWorktree({
          controlRoot: this.cwd,
          targetWorktree: rows[index].target_worktree,
        }).executionRoot);
      } catch {
        return Object.freeze({
          rows: notAttemptedRows(rows, new Map([[index, "target_rejected"]])),
        });
      }
    }
    if (this.abortSignal?.aborted) return cancelled();

    const writersByRoot = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      if (!rows[index].write) continue;
      const indices = writersByRoot.get(executionRoots[index]) ?? [];
      indices.push(index);
      writersByRoot.set(executionRoots[index], indices);
    }
    const writerFailures = new Map();
    for (const indices of writersByRoot.values()) {
      if (indices.length > 1) for (const index of indices) writerFailures.set(index, "batch_writer_conflict");
    }
    if (writerFailures.size) {
      return Object.freeze({ rows: notAttemptedRows(rows, writerFailures) });
    }

    const store = this.versionThreeStore();
    const nameFailures = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      try {
        if (store.readAgent(dispatchAgentName(rows[index].task_name))) {
          nameFailures.set(index, "agent_name_conflict");
        }
      } catch {
        nameFailures.set(index, "route_rejected");
      }
    }
    if (nameFailures.size) {
      return Object.freeze({ rows: notAttemptedRows(rows, nameFailures) });
    }

    const observations = new Map();
    const prepared = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const executionRoot = executionRoots[index];
      const key = JSON.stringify([row.harness, executionRoot]);
      let observed = observations.get(key);
      if (!observed) {
        try {
          await this.ensureDispatchHarness(row.harness, executionRoot);
        } catch {
          return Object.freeze({
            rows: notAttemptedRows(rows, new Map([[index, "service_unavailable"]])),
          });
        }
        if (this.abortSignal?.aborted) return cancelled();
        try {
          observed = await this.jobs.inspectRouteInstance(row.harness, executionRoot);
          observations.set(key, observed);
        } catch {
          return Object.freeze({
            rows: notAttemptedRows(rows, new Map([[index, "route_rejected"]])),
          });
        }
      }
      if (this.abortSignal?.aborted) return cancelled();
      let terminalEventBinding = null;
      try {
        if (row.terminal_event_descriptor_path != null) {
          terminalEventBinding = preflightTerminalEventDescriptor({
            descriptorPath: row.terminal_event_descriptor_path,
            agentName: dispatchAgentName(row.task_name), env: this.jobs.env,
          });
        }
      } catch {
        return Object.freeze({ rows: notAttemptedRows(rows, new Map([[index, "route_rejected"]])) });
      }
      try {
        const accepted = await this.acceptStatedRoute(
          row,
          `dispatch_agents rows[${index}]`,
          executionRoot,
          observed,
        );
        prepared.push(Object.freeze({ accepted, executionRoot, terminalEventBinding }));
      } catch {
        return Object.freeze({
          rows: notAttemptedRows(rows, new Map([[index, "route_rejected"]])),
        });
      }
    }

    const results = [];
    const appendRemaining = (start, code) => {
      for (let index = start; index < rows.length; index += 1) {
        results.push(dispatchRowResult(
          dispatchAgentName(rows[index].task_name),
          "not_attempted",
          { error: dispatchError(code) },
        ));
      }
    };

    for (let index = 0; index < rows.length; index += 1) {
      if (this.abortSignal?.aborted) {
        appendRemaining(index, "batch_cancelled");
        break;
      }
      const agentName = dispatchAgentName(rows[index].task_name);
      try {
        const card = await this.launchDispatchRow(rows[index], prepared[index]);
        results.push(dispatchRowResult(agentName, "launched", { card }));
      } catch (error) {
        const recovery = admittedBatchRecovery(error, agentName);
        if (recovery) {
          results.push(dispatchRowResult(agentName, recovery.outcome, { error: recovery.error }));
          if (recovery.outcome === "ownership_uncertain") {
            appendRemaining(index + 1, "batch_stopped_after_ownership_uncertain");
            break;
          }
        } else if (error?.batchOutcome === "rolled_back") {
          results.push(dispatchRowResult(agentName, "rolled_back", {
            error: dispatchError("spawn_rolled_back"),
          }));
        } else {
          // Change A closes every post-launch error with publicRecovery. An
          // unmarked error is therefore a final pre-identity rejection (for
          // example, another caller won the public name); never adopt whatever
          // Agent may now exist under that deterministic name.
          results.push(dispatchRowResult(agentName, "not_attempted", {
            error: dispatchError("row_launch_rejected"),
          }));
        }
      }
      if (this.abortSignal?.aborted) {
        appendRemaining(index + 1, "batch_cancelled");
        break;
      }
    }
    return Object.freeze({ rows: Object.freeze(results) });
  }

  async spawnAgent(inputValue) {
    return this.spawnAgentWithPreflight(inputValue, null);
  }

  async launchDispatchRow(inputValue, preflight) {
    return this.spawnAgentWithPreflight(inputValue, preflight);
  }

  async spawnAgentWithPreflight(inputValue, preflight) {
    const input = assertObject(inputValue, "spawn_agent input");
    throwIfSpawnAborted(this.abortSignal);
    assertNoHarnessImplementationSelector(input, "spawn_agent");
    for (const key of [
      "agent_type",
      "delegation_mode",
      "service_tier",
      "session_id",
      "claude_session_id",
      "resume_session_id",
      "fork_turns",
      "execution_profile",
      "permission_mode",
      "dangerously_skip_permissions",
      "allowed_tools",
      "cwd",
      "directory",
      "working_directory",
      "workspace_root",
      "env_file",
    ]) {
      if (input[key] != null) throw new Error(`spawn_agent does not support ${key}.`);
    }
    let terminalEventBinding = null;
    if (input.terminal_event_descriptor_path != null) {
      const descriptorPath = assertText(input.terminal_event_descriptor_path, "spawn_agent terminal_event_descriptor_path");
      if (!path.isAbsolute(descriptorPath)) throw new Error("spawn_agent terminal_event_descriptor_path must be absolute.");
      terminalEventBinding = preflight?.terminalEventBinding ?? preflightTerminalEventDescriptor({
        descriptorPath, agentName: dispatchAgentName(assertText(input.task_name, "spawn_agent task_name")), env: this.jobs.env,
      });
    }
    const taskName = assertText(input.task_name, "spawn_agent task_name");
    if (!TASK_NAME_PATTERN.test(taskName)) {
      throw new Error("spawn_agent task_name must match [a-z0-9_]+.");
    }
    const message = assertText(input.message, "spawn_agent message");
    const { executionRoot } = admitTargetWorktree({
      controlRoot: this.cwd,
      targetWorktree: input.target_worktree,
    });
    // The whole route is the caller's explicit decision, accepted before any
    // readiness side effect or durable Agent reservation exists.
    if (preflight && preflight.executionRoot !== executionRoot) {
      throw new Error("spawn_agent preflight target drifted before launch.");
    }
    const accepted = preflight?.accepted ?? await this.acceptStatedRoute(input, "spawn_agent", executionRoot);
    if (preflight) {
      const expectedAuthority = input.write ? "behavioral_write" : "behavioral_read_only";
      if (
        accepted.route.harnessId !== input.harness ||
        accepted.route.model !== input.model ||
        accepted.route.effort !== input.reasoning_effort ||
        accepted.route.topology !== input.topology ||
        accepted.route.authority !== expectedAuthority
      ) {
        throw new Error("spawn_agent preflight route drifted before launch.");
      }
    }
    throwIfSpawnAborted(this.abortSignal);
    if (input.target_worktree != null) {
      const revalidated = admitTargetWorktree({
        controlRoot: this.cwd,
        targetWorktree: executionRoot,
      });
      if (revalidated.executionRoot !== executionRoot) {
        throw Object.assign(new Error("target_owner_drift"), { code: "target_owner_drift" });
      }
    }
    const jobId = generateJobId("hd-agent");
    // Reasoning effort is Driver-discriminated: the Driver that owns the accepted
    // route decides whether one is admitted at all, and it decides here, before
    // anything durable exists. A route that proves no effort refuses it.
    const acceptedTurnOptions = typeof accepted.route.effort === "string"
      ? { effort: accepted.route.effort }
      : (input.reasoning_effort == null ? null : { effort: input.reasoning_effort });
    throwIfSpawnAborted(this.abortSignal);
    accepted.driver.prepareTurn({
      route: accepted.route,
      taskInput: message,
      turnOptions: acceptedTurnOptions,
      turnId: jobId,
    });
    if (harnessExecutionLifecycle(accepted.route.harnessId) === "version_three_worker") {
      return await this.spawnVersionThreeAgent({
        accepted,
        taskName,
        description: input.description,
        message,
        jobId,
        turnOptions: acceptedTurnOptions,
        executionRoot,
        terminalEventBinding,
      });
    }
    const driver = this.jobs.driverForHarness(accepted.route.harnessId);
    const executionOptions = validatedInternalOptions(driver, {
      ...input,
      model: accepted.route.model,
      // The legacy execution profile speaks delegation modes; the stated
      // topology is translated through the owning Driver's own mapping.
      delegation_mode: delegationModeForTopology(accepted.route.topology),
    });
    const model = executionOptions.model;

    this.reconcile();
    // CLI availability/auth can each take seconds. Do not create a durable
    // active Agent reservation until that external preflight has succeeded --
    // and do not run it twice: route acceptance already observed this host, and
    // its Driver stated the version-one receipt from that same observation.
    // Anything less than a proven-ready receipt falls back to observing again,
    // so this can only ever remove a duplicate, never a check.
    throwIfSpawnAborted(this.abortSignal);
    const readinessReceipt = accepted.launchReadiness?.ready === true
      ? accepted.launchReadiness
      : this.jobs.assertReady(driver.harnessId, executionRoot);
    throwIfSpawnAborted(this.abortSignal);
    // Every new Agent gets the version-three identity plane: the whole route is
    // immutable from creation. Its TURNS still run on the version-one
    // supervisor, which is a separate question with a separate owner
    // (`harnessExecutionLifecycle`), and everything below this line is that
    // supervisor's own path.
    const store = this.versionThreeStore();
    const agent = store.createAgent({
      task_name: taskName,
      description: input.description,
      route: accepted.route,
      executionRoot,
      initialMessage: message,
      ...(terminalEventBinding == null ? {} : { terminalEventBinding: { ...terminalEventBinding, jobId } }),
    });
    const initialMessage = store.listMessages(agent.agentId)[0];
    let prepared;
    try {
      throwIfSpawnAborted(this.abortSignal);
      prepared = this.jobs.prepareStart(message, {
        ...executionOptions,
        harnessId: driver.harnessId,
        readinessReceipt,
        jobId,
        agentId: agent.agentId,
        sessionName: agent.name,
        title: `${driver.harnessId} Agent ${agent.name}`,
        executionRoot,
        route: accepted.route,
      });
    } catch (error) {
      // A sender may have reached this newly-created Agent while local job
      // preparation was failing. The store removes only an empty reservation.
      store.rollbackReservation(agent.agentId, {
        removableMessageId: initialMessage?.messageId,
      });
      throw rollbackSafeSpawnFailure(error, store, agent);
    }
    if (this.abortSignal?.aborted) {
      this.jobs.abortPreparedStart(prepared, { handoffDisposition: "rollback_safe" });
      store.rollbackReservation(agent.agentId, { removableMessageId: initialMessage?.messageId });
      throw rollbackSafeSpawnFailure(spawnAbortError(), store, agent);
    }
    const activation = store.reserveActivation(agent.agentId, jobId, { initial: true });
    if (!activation.reserved) {
      this.jobs.abortPreparedStart(prepared);
      store.rollbackReservation(agent.agentId, {
        removableMessageId: initialMessage?.messageId,
      });
      throw rollbackSafeSpawnFailure(
        new Error(`Unable to activate ${agent.path}: ${activation.reason}.`),
        store,
        agent,
      );
    }
    let launchAttempted = false;
    try {
      const attached = this.jobs.attachPreparedStart(prepared, agent.agentId);
      throwIfSpawnAborted(this.abortSignal);
      launchAttempted = true;
      const assigned = activation.assignedMessages;
      await this.jobs.launchPreparedStart(attached, messageText(assigned), {
        assignedMessageIds: assigned.map((message) => message.messageId),
      });
      if (this.abortSignal?.aborted) {
        throw publicSpawnFailure(spawnAbortError(), agent, "lifecycle_owned");
      }
      this.markInitialPromptMessages(agent.agentId, jobId, assigned, store);
      return publicSpawnReceipt(this.cwd, store.resolveTarget(agent.agentId));
    } catch (error) {
      let handoffDisposition;
      if (launchAttempted) {
        handoffDisposition = preparedStartDisposition(error);
      } else if (error?.name === "AbortError") {
        let current = null;
        try { current = readJobFile(this.cwd, jobId); } catch { handoffDisposition = "ownership_uncertain"; }
        if (!handoffDisposition) {
          handoffDisposition = current?.workerLaunchStartedAt || current?.pid != null
            ? preparedStartDisposition(error)
            : "rollback_safe";
        }
      } else {
        handoffDisposition = "rollback_safe";
      }
      if (handoffDisposition === "rollback_safe") {
        this.jobs.abortPreparedStart(prepared, { handoffDisposition });
        this.rollbackActivation(agent.agentId, jobId, agent, {
          initial: true,
          removableMessageId: initialMessage?.messageId,
        });
        throw rollbackSafeSpawnFailure(error, store, agent);
      } else {
        throw publicSpawnFailure(error, agent, handoffDisposition);
      }
    }
  }

  /**
   * Resolve the Driver that owns an Agent's recorded Harness. A record naming
   * an unadmitted Harness fails closed rather than being executed, steered, or
   * read by whichever Driver this runtime happens to register.
   */
  assertAgentDriver(agent, options = {}) {
    // Every Agent projection states its own Harness -- a version-one/two record
    // through the legacy adapter, a version-three record from its frozen route.
    // An Agent that states none is unroutable and is refused, never defaulted.
    if (agent?.version === 3) {
      // A version-three Agent is routed by the Driver Contract v2 table its own
      // frozen route names. Resolving it through the version-one table would
      // refuse every Harness that generation never had, and would answer an
      // unsupported operation with an unroutable-Agent exception instead of the
      // receipt the route itself proves.
      const statedHarnessId = agent.route?.harnessId ?? agent.harnessId;
      const routed = resolveDriverV2(assertStatedHarnessId(
        statedHarnessId,
        `Agent ${agent.path} Harness`,
      ), { env: this.jobs.env });
      if (
        options.allowDriverVersionDrift !== true &&
        agent.route?.driverVersion != null &&
        agent.route.driverVersion !== routed.driverVersion
      ) {
        throw new Error(
          `Agent ${agent.path} accepted Driver ${agent.route.driverVersion}; ` +
          `but this runtime provides ${routed.driverVersion}.`
        );
      }
      return routed;
    }
    const driver = this.jobs.driverForHarness(agent.harnessId);
    if (agent.version === 2) {
      if (
        options.allowDriverVersionDrift !== true &&
        agent.driverVersion !== driver.driverVersion
      ) {
        throw new Error(
          `Agent ${agent.path} accepted Driver ${agent.driverVersion}; ` +
          `but this runtime provides ${driver.driverVersion}.`
        );
      }
      const accepted = validateHarnessCapabilities(
        agent.capabilities,
        `Agent ${agent.path} capability snapshot`,
      );
      for (const name of options.allowDriverVersionDrift === true ? [] : HARNESS_CAPABILITY_NAMES) {
        if (accepted[name] !== driver.capabilities[name]) {
          throw new Error(
            `Agent ${agent.path} accepted ${name}=${accepted[name]} but this runtime provides ` +
            `${name}=${driver.capabilities[name]}.`
          );
        }
      }
    }
    return driver;
  }

  deliverAssignedMessage(agent, mailboxMessage) {
    const activeJobId = mailboxMessage.assignedJobId ?? agent.activeJobId;
    if (!activeJobId) return { delivered: false, reason: "queued_no_turn" };
    const activeJob = readJobFile(this.cwd, activeJobId);
    if (!activeJob) {
      return { delivered: false, reason: "activation_pending", jobId: activeJobId };
    }
    if (!ACTIVE_JOB_STATUSES.has(activeJob.status) || activeJob.status === "interrupting") {
      this.requeueAssignedMessage(agent.agentId, mailboxMessage.messageId, activeJobId);
      return { delivered: false, reason: "queued_no_turn" };
    }
    if (isPreClaudeActivation(activeJob)) {
      return { delivered: false, reason: "activation_pending", jobId: activeJobId };
    }
    if (mailboxMessage.deliveryIntent === "initial_prompt") {
      return { delivered: false, reason: "initial_prompt", jobId: activeJobId };
    }
    let steering;
    try {
      steering = this.jobs.assignInput(activeJob, mailboxMessage.text, {
        kind: "agent_message",
        messageId: mailboxMessage.messageId,
      });
    } catch {
      this.requeueAssignedMessage(agent.agentId, mailboxMessage.messageId, activeJobId);
      return { delivered: false, reason: "queued_no_turn" };
    }
    this.store.markMessageDispatched(agent.agentId, mailboxMessage.messageId, {
      jobId: activeJobId,
      receipt: { delivery: "durable_stream_input", steeringSequence: steering.sequence },
    });
    return { delivered: true, jobId: activeJobId, steeringSequence: steering.sequence };
  }

  sendMessage(inputValue) {
    const input = assertObject(inputValue, "send_message input");
    this.reconcile();
    const agent = this.store.resolveTarget(assertText(input.target, "send_message target"));
    this.assertAgentDriver(agent);
    if (agent.continuation.mode === "blocked") {
      throw blockedContinuationRejection(agent, "accept messages");
    }
    const store = this.storeForAgent(agent);
    const queued = store.enqueueMessage(agent.agentId, assertText(input.message, "send_message message"), {
      kind: "send_message",
    });
    // Active delivery is lifecycle-owned. The version-one supervisor can steer
    // immediately through its job record. A version-three worker instead reads
    // the assigned durable mailbox asynchronously, so the public receipt may
    // report only activation_pending until that worker records acknowledgement.
    const steerable = harnessExecutionLifecycle(agent.harnessId) === "version_one_supervisor";
    const delivery = queued.delivery === "assigned_active"
      ? steerable
        ? this.deliverAssignedMessage(queued.agent, queued.message)
        : { delivered: false, reason: "activation_pending" }
      : { delivered: false, reason: "queued_no_turn" };
    const current = store.resolveTarget(agent.agentId);
    return {
      agent_name: current.path,
      delivery: delivery.delivered
        ? "dispatched_active"
        : delivery.reason === "activation_pending"
          ? "activation_pending"
          : "queued_no_turn",
    };
  }

  async waitForAssignedDelivery(agent, mailboxMessage, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    let delivery = this.deliverAssignedMessage(agent, mailboxMessage);
    while (!delivery.delivered && delivery.reason === "activation_pending" && Date.now() < deadline) {
      await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
      delivery = this.deliverAssignedMessage(this.store.resolveTarget(agent.agentId), mailboxMessage);
    }
    return delivery;
  }

  markInitialPromptMessages(agentId, jobId, messages, store = this.store) {
    let marked = 0;
    for (const message of messages) {
      try {
        const receipt = store.markMessageDispatched(agentId, message.messageId, {
          jobId,
          receipt: { delivery: "initial_prompt" },
        });
        if (receipt.changed || receipt.message?.state === "dispatched") marked += 1;
      } catch {
        // Once the detached worker is launched, its durable job receipt owns
        // recovery. Leaving an entry assigned with initial_prompt intent is
        // safe: active delivery will not steer it, and terminal reconciliation
        // will finish its dispatch/acknowledgement projection.
      }
    }
    return marked;
  }

  recoverCredentialBlockedAgent(agent, driver, failedJob) {
    if (agent.continuation.mode !== "blocked") return agent;
    if (agent.continuation.evidence?.reason !== "auth_or_permission") return agent;
    if (
      !failedJob ||
      failedJob.id !== agent.latestJobId ||
      failedJob.agentId !== agent.agentId ||
      failedJob.ownerRootId !== agent.rootThreadId ||
      failedJob.harnessId !== agent.harnessId ||
      failedJob.harnessId !== driver.harnessId ||
      !sideEffectFreeAuthenticationFailure(failedJob)
    ) {
      return agent;
    }
    const failureObservation = failedJob.result?.runtimeReceipt?.credentialObservation;
    const observedAtMs = Date.now();
    const replacement = observeClaudeCredentialState({
      env: this.jobs.env,
      nowMs: observedAtMs,
    });
    if (
      !isNativeOAuthCredentialObservation(failureObservation) ||
      !isNativeOAuthCredentialObservation(replacement) ||
      failureObservation.configIdentity !== replacement.configIdentity ||
      sameCredentialGeneration(failureObservation, replacement) ||
      !isLocallyCurrentOAuthCredential(replacement, observedAtMs)
    ) {
      return agent;
    }
    // The instance identity being compared is the VERSION-ONE supervisor's: the
    // failed receipt states it, the credential observation states it, and both
    // are the native configuration path. A version-three Agent's own route
    // states the redacted key instead -- a different namespace -- so the
    // comparison is made through the Driver that owns the execution machine,
    // not through the Contract v2 Driver that owns its capabilities. Comparing
    // the redacted key against a path would silently never match, and an
    // auth-blocked Agent could never be recovered at all.
    const executionDriver = agent.version === 3
      ? this.jobs.driverForHarness(agent.route.harnessId)
      : driver;
    const driverInstanceKey = executionDriver.resolveInstanceKey?.(this.jobs.env) ?? null;
    const failedInstanceKey = failedJob.harnessInstanceKey ?? failedJob.claudeConfigDir ?? null;
    // "No proven native session yet" is stated as the neutral reference on a
    // version-three record and as the legacy pair on a legacy one.
    const provenSession = agent.version === 3
      ? agent.nativeSessionRef != null
      : agent.claudeSessionId != null;
    if (
      driverInstanceKey !== replacement.configIdentity ||
      failedInstanceKey !== replacement.configIdentity ||
      provenSession
    ) {
      return agent;
    }
    try {
      const recovered = this.store.recoverCredentialBlockedActivation(agent.agentId, {
        failedJobId: failedJob.id,
        replacementCredential: replacement,
      });
      return recovered.recovered ? recovered.agent : agent;
    } catch {
      return agent;
    }
  }

  async followupTask(inputValue) {
    const input = assertObject(inputValue, "followup_task input");
    assertNoHarnessImplementationSelector(input, "followup_task");
    if (input.model != null) {
      throw new Error("followup_task inherits the Agent's selected model and does not accept a model override.");
    }
    // A frozen route's behavioral authority is immutable: a follow-up inherits
    // it and can never widen, narrow, or restate it.
    for (const key of [
      "write", "harness", "topology", "target_worktree",
      "cwd", "directory", "working_directory", "workspace_root", "env_file",
    ]) {
      if (input[key] != null) {
        throw new Error(
          `followup_task does not accept ${key}: an Agent's route and behavioral authority are frozen at ` +
          `creation and inherited by every later turn.`
        );
      }
    }
    for (const key of [
      "delegation_mode",
      "fork_turns",
      "execution_profile",
      "permission_mode",
      "dangerously_skip_permissions",
      "allowed_tools",
    ]) {
      if (input[key] != null) throw new Error(`followup_task does not support ${key}.`);
    }
    // Resolve and validate against a read-only snapshot before reconciliation:
    // invalid caller options must not repair an unrelated terminal receipt,
    // publish completion, or otherwise mutate durable state before rejection.
    let agent = this.store.resolveTarget(assertText(input.target, "followup_task target"));
    const driver = this.assertAgentDriver(agent);
    const credentialRecoveryCandidate =
      agent.continuation.mode === "blocked" &&
      agent.continuation.evidence?.reason === "auth_or_permission";
    if (agent.continuation.mode === "blocked" && !credentialRecoveryCandidate) {
      throw blockedContinuationRejection(agent, "continue");
    }
    // A version-three Agent's frozen route decides continuation before any
    // legacy option validation sees the input. A route that proves fresh-only
    // continuation has no same-Agent second turn to validate options for, and
    // refusing here keeps the legacy validator from answering with its own
    // unrelated vocabulary.
    const continuationSupport = unsupportedRouteOperation(agent, "continuation", ["exact_resume"]);
    if (continuationSupport) {
      throw new Error(
        `Agent ${agent.path} is frozen to a ${continuationSupport.harness} route whose continuation is ` +
        `${continuationSupport.value}; a same-Agent follow-up is refused. Spawn a new Agent instead.`
      );
    }
    if (agent.continuation.mode === "exact_session") {
      // Refuse before any durable mailbox or activation write: an exact-resume
      // target is only meaningful when the accepted snapshot proves it.
      const continuationSnapshot = versionOneCapabilitySnapshot(agent, driver);
      if (continuationSnapshot) {
        assertHarnessCapability(
          continuationSnapshot,
          "continuation",
          ["exact_resume"],
          `Harness ${driver.harnessId} cannot resume Agent ${agent.path} in its exact native session`
        );
      }
    }
    if (
      agent.version === 3 &&
      harnessExecutionLifecycle(agent.route.harnessId) === "version_three_worker"
    ) {
      return await this.followupVersionThreeAgent(input, agent);
    }
    const validationJobId = agent.activeJobId ?? agent.latestJobId;
    const validationLatestJob = validationJobId
      ? readJobFile(this.cwd, validationJobId)
      : null;
    // Validate before enqueueing even if the current active turn may win a
    // delivery race: should that turn become terminal during delivery, this
    // same call is allowed to activate the queued message and must not leave
    // invalid execution options behind as durable mailbox state.
    // A version-three Agent's model and topology are the frozen route's, never
    // a legacy projected field it does not carry and never a value recovered
    // from a previous job's request. A follow-up cannot change either.
    const frozenRoute = agent.version === 3 ? agent.route : null;
    // Two Drivers answer two different questions for one Agent. `driver` is the
    // Contract v2 Driver its frozen route names, and it owns capability
    // questions. The EXECUTION options below speak the version-one supervisor's
    // own vocabulary -- profile, delegation mode, effort -- so they are
    // validated by the Driver that owns that machine. Handing a version-one
    // option bag to a version-two Driver would ask it to read a route in a
    // vocabulary that bag does not contain.
    const executionDriver = frozenRoute
      ? this.jobs.driverForHarness(frozenRoute.harnessId)
      : driver;
    const executionOptions = validatedInternalOptions(executionDriver, input, {
      ...(validationLatestJob?.request ?? {}),
      model: frozenRoute?.model ?? validationLatestJob?.request?.model ?? agent.selectedModel,
      delegationMode: frozenRoute
        ? delegationModeForTopology(frozenRoute.topology)
        : agent.delegationMode,
    });
    if (credentialRecoveryCandidate) {
      agent = this.recoverCredentialBlockedAgent(agent, driver, validationLatestJob);
      if (agent.continuation.mode === "blocked") {
        throw blockedContinuationRejection(agent, "continue");
      }
    }
    this.reconcile();
    agent = this.store.resolveTarget(agent.agentId);
    if (agent.continuation.mode === "blocked") {
      throw blockedContinuationRejection(agent, "continue");
    }
    // An idle follow-up will need a new Claude process. Prove the host CLI
    // surface before adding its message to durable state. Active steering keeps
    // using the already-running admitted process and needs no replacement-CLI
    // check.
    let readinessReceipt = agent.activeJobId ? null : this.jobs.assertReady(driver.harnessId);
    const queued = this.store.enqueueMessage(
      agent.agentId,
      assertText(input.message, "followup_task message"),
      { kind: "followup_task" }
    );
    agent = queued.agent;
    if (agent.activeJobId) {
      const delivery = await this.waitForAssignedDelivery(agent, queued.message);
      if (delivery.delivered) {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "dispatched_active",
        );
      }
      if (delivery.reason === "activation_pending") {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "activation_pending",
        );
      }
      if (delivery.reason === "initial_prompt") {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "already_active_initial_prompt",
        );
      }
      this.reconcile();
      agent = this.store.resolveTarget(agent.agentId);
    }
    // Keep slow Claude CLI/auth preflight outside the active-reservation
    // interval. A concurrent follow-up then sees an idle Agent until a winner
    // is genuinely ready to publish its local job receipt.
    readinessReceipt ??= this.jobs.assertReady(driver.harnessId);
    const jobId = generateJobId("hd-agent");
    const previous = agent;
    const latestJob = validationLatestJob;
    const resumeSessionId = agent.continuation.mode === "exact_session"
      ? agent.nativeSessionRef?.nativeSessionId
      : null;
    const initialActivation = agent.status === "pending_init" &&
      agent.latestJobId == null &&
      !agent.nativeSessionRef;
    // This provisional prompt is replaced with the atomically assigned
    // mailbox batch immediately before the worker starts. It lets us publish
    // an unbound launch fact before an Agent becomes active.
    const prepared = this.jobs.prepareStart(
      assertText(input.message, "followup_task message"),
      {
        ...executionOptions,
        harnessId: driver.harnessId,
        readinessReceipt,
        jobId,
        agentId: agent.agentId,
        resumeSessionId,
        parentJobId: agent.latestJobId,
        sessionName: agent.name,
        title: initialActivation
          ? `${driver.harnessId} Agent ${agent.name} initial activation`
          : `${driver.harnessId} Agent ${agent.name} follow-up`,
        executionRoot: agent.executionRoot ?? agent.workspaceRoot,
        route: agent.route,
      }
    );
    let activation = this.store.reserveActivation(agent.agentId, jobId, {
      initial: initialActivation,
    });
    if (!activation.reserved && activation.reason === "already_active") {
      this.jobs.abortPreparedStart(prepared);
      const latest = this.store.resolveTarget(agent.agentId);
      const assigned = this.store.assignQueuedMessages(agent.agentId, latest.activeJobId);
      const message = assigned.assignedMessages.find((candidate) => candidate.messageId === queued.message.messageId)
        ?? this.store.listMessages(agent.agentId).find((candidate) =>
          candidate.messageId === queued.message.messageId &&
          candidate.assignedJobId === latest.activeJobId
        );
      if (message?.deliveryIntent === "initial_prompt") {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "already_active_initial_prompt",
        );
      }
      if (message?.state === "dispatched" || message?.state === "acknowledged") {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "already_active_dispatched",
        );
      }
      const delivery = message
        ? await this.waitForAssignedDelivery(latest, message)
        : { delivered: false };
      if (delivery.delivered) {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "dispatched_active",
        );
      }
      if (delivery.reason === "activation_pending") {
        return publicFollowupReceipt(
          this.store.resolveTarget(agent.agentId),
          "activation_pending",
        );
      }
      throw new Error(`Agent ${agent.path} became active but its message could not be delivered.`);
    }
    if (!activation.reserved) {
      this.jobs.abortPreparedStart(prepared);
      throw new Error(`Unable to activate ${agent.path}: ${activation.reason}.`);
    }

    const assigned = activation.assignedMessages;
    const prompt = messageText(assigned);
    let launchAttempted = false;
    try {
      const attached = this.jobs.attachPreparedStart(prepared, agent.agentId);
      launchAttempted = true;
      await this.jobs.launchPreparedStart(attached, prompt, {
        assignedMessageIds: assigned.map((message) => message.messageId),
      });
      this.markInitialPromptMessages(agent.agentId, jobId, assigned);
      return publicFollowupReceipt(
        this.store.resolveTarget(agent.agentId),
        "new_turn",
      );
    } catch (error) {
      const handoffDisposition = launchAttempted
        ? preparedStartDisposition(error)
        : "rollback_safe";
      if (handoffDisposition === "rollback_safe") {
        this.jobs.abortPreparedStart(prepared, { handoffDisposition });
        this.rollbackActivation(agent.agentId, jobId, previous, { initial: initialActivation });
      }
      throw error;
    }
  }

  /**
   * The version-three view of one targeted Agent's job, projected to exactly
   * the two fields the targeted join reads. A version-one-supervisor Agent has
   * a version-one job file instead and reads as null here; an absent record on
   * a fresh version-three reservation reads as null, which the join treats as
   * not-yet-terminal rather than not joinable.
   */
  versionThreeJobView(agent, jobId) {
    if (!jobId || harnessExecutionLifecycle(agent.harnessId) !== "version_three_worker") return null;
    try {
      const record = readVersionThreeJobRecord({
        ownerRootId: this.ownerRootId,
        agentId: agent.agentId,
        jobId,
      });
      return record ? {
        id: record.jobId,
        ownerRootId: record.ownerRootId,
        agentId: record.agentId,
        attemptId: record.attemptId,
        route: record.route,
        status: record.status,
      } : null;
    } catch {
      return null;
    }
  }
  async reconcileLostV3Turns(deadlineAt) {
    const agents = new Map(this.store.listAgents().map((agent) => [agent.agentId, agent]));
    const records = listVersionThreeJobRecords({ ownerRootId: this.ownerRootId }).records;
    for (const record of records) {
      if (!['running', 'unknown'].includes(record.status) || !record.worker ||
          validateProcessIdentity(record.worker.pid, record.worker.identity)) continue;
      const agent = agents.get(record.agentId);
      if (!agent || (agent.activeJobId !== record.jobId && agent.latestJobId !== record.jobId)) continue;
      let driver;
      try { driver = this.assertAgentDriver(agent); } catch { continue; }
      await reconcileVersionThreeWorkerLoss({ generation: FUTURE_WRITE_GENERATION,
        ownerRootId: this.ownerRootId, agentId: record.agentId, jobId: record.jobId,
        driver, deadlineAt, signal: this.abortSignal });
    }
  }
  async waitAgent(inputValue = {}) {
    const input = assertObject(inputValue, "wait_agent input");
    if (this.abortSignal?.aborted) {
      const error = new Error("HarnessDock Agent wait observation was cancelled by the caller.");
      error.name = "AbortError";
      throw error;
    }
    const unsupported = Object.keys(input).find((key) => !new Set([
      "timeout_ms",
      "wake_on_progress",
      "acknowledge_tokens",
      "targets",
    ]).has(key));
    if (unsupported) throw new Error(`wait_agent does not support ${unsupported}.`);
    const timeout = input.timeout_ms == null
      ? DEFAULT_AGENT_WAIT_TIMEOUT_MS
      : Number(input.timeout_ms);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_AGENT_WAIT_TIMEOUT_MS) {
      throw new Error("wait_agent timeout_ms must be between 0 and 3600000 milliseconds.");
    }
    if (input.wake_on_progress != null && typeof input.wake_on_progress !== "boolean") {
      throw new Error("wait_agent wake_on_progress must be a boolean when provided.");
    }
    const hasTargets = input.targets != null;
    if (hasTargets && !Array.isArray(input.targets)) {
      throw new Error("wait_agent targets must be a non-empty array.");
    }
    if (hasTargets && (input.targets.length < 1 || input.targets.length > MAX_TARGETED_WAIT_TARGETS)) {
      throw new Error(`wait_agent targets must contain between 1 and ${MAX_TARGETED_WAIT_TARGETS} Agents.`);
    }
    if (hasTargets && input.wake_on_progress === true && input.targets.length !== 1) {
      throw new Error("wait_agent wake_on_progress requires exactly one target when targets are provided.");
    }
    const wakeOnProgress = input.wake_on_progress === true;
    const acknowledgeTokens = Array.isArray(input.acknowledge_tokens)
      ? input.acknowledge_tokens
      : [];
    if (input.acknowledge_tokens != null && !Array.isArray(input.acknowledge_tokens)) {
      throw new Error("wait_agent acknowledge_tokens must be an array when provided.");
    }
    const deadlineAt = new Date(Date.now() + timeout).toISOString();
    await this.reconcileLostV3Turns(deadlineAt);
    // Correct any recoverable terminal fact before the completion payload is
    // first exposed and frozen under its delivery token.
    this.reconcile();
    if (hasTargets) {
      const requestedTargets = input.targets.map((target) => {
        if (typeof target !== "string" || !target.trim()) {
          throw new Error("wait_agent targets must contain non-empty Agent identifiers.");
        }
        return target.trim();
      });
      const snapshots = [];
      const seenAgents = new Set();
      for (const target of requestedTargets) {
        const agent = this.store.resolveTarget(target);
        if (seenAgents.has(agent.agentId)) {
          throw new Error("wait_agent targets must contain unique Agents.");
        }
        seenAgents.add(agent.agentId);
        const jobId = agent.activeJobId ?? agent.latestJobId ?? null;
        // A version-three-worker Agent has no version-one job file: its durable
        // job is the version-three record, projected here to exactly the two
        // fields the targeted join reads (id and status). Discovered live: the
        // first activation run's targeted wait reported a completing OpenCode
        // turn as not joinable because only the version-one file was consulted.
        const versionThreeWorker =
          harnessExecutionLifecycle(agent.harnessId) === "version_three_worker";
        const job = (jobId ? readJobFile(this.cwd, jobId) : null)
          ?? this.versionThreeJobView(agent, jobId);
        snapshots.push({
          agent,
          agentId: agent.agentId,
          agentName: agent.path,
          // A version-three reservation is joinable from the moment it exists:
          // the worker upserts its durable record moments later, and until then
          // the absent record simply reads as not-yet-terminal.
          jobId: job?.id ?? (versionThreeWorker ? jobId : null),
          job,
        });
      }
      const notJoinable = snapshots.filter((snapshot) => !snapshot.jobId);
      const unresolvedNotJoinable = snapshots
        .filter((snapshot) => !snapshot.jobId || !TERMINAL_JOB_STATUSES.has(snapshot.job?.status))
        .map((snapshot) => snapshot.agentName);
      if (notJoinable.length > 0) {
        if (acknowledgeTokens.length > 0) {
          acknowledgeAgentCompletionEvents(this.cwd, this.ownerRootId, acknowledgeTokens);
        }
        return {
          message: "HarnessDock Agent target is not joinable.",
          timedOut: false,
          targets: snapshots.map((snapshot) => ({
            agent_name: snapshot.agentName,
            agent_status: canonicalAgentStatus(snapshot.agent),
            state: snapshot.jobId ? "pending" : "not_joinable",
            ...(snapshot.job?.status && TERMINAL_JOB_STATUSES.has(snapshot.job.status)
              ? { agent_status: publicTargetTerminalStatus(snapshot.job.status, snapshot.agent.status) }
              : {}),
          })),
          unresolved_targets: unresolvedNotJoinable,
        };
      }
      const targetJobIds = snapshots.map((snapshot) => snapshot.jobId);
      let waited = await this.jobs.wait(null, {
        timeoutMs: timeout,
        targetJobIds,
        acknowledgeTokens,
        wakeOnProgress,
        signal: this.abortSignal,
      });
      // Reconcile once more before the final fixed-snapshot observation. The
      // durable job publication may race the wakeup notification itself.
      this.reconcile();
      await this.reconcileLostV3Turns(deadlineAt);
      if (!waited.targetReady) {
        const finalObservation = await this.jobs.wait(null, {
          timeoutMs: 0,
          targetJobIds,
          acknowledgeTokens: [],
          wakeOnProgress: false,
          signal: this.abortSignal,
        });
        if (finalObservation.targetReady) waited = finalObservation;
      }
      this.reconcile();
      if (waited.update?.kind === "progress" && !waited.targetReady) {
        return {
          message: waited.message,
          timedOut: false,
          update: publicProgressUpdate(waited.update, this.store.listAgents()),
        };
      }
      const inspected = waited.targetReady
        ? readTargetedAgentCompletionSummaries(this.cwd, this.ownerRootId, targetJobIds, { freeze: false })
        : { events: [], consumed: [] };
      const observedJobs = new Set([
        ...inspected.events.map((event) => event.jobId),
        ...inspected.consumed.map((event) => event.jobId),
      ]);
      const missingEvidence = waited.targetReady
        ? snapshots.filter((snapshot) => !observedJobs.has(snapshot.jobId))
        : [];
      const selected = waited.targetReady && missingEvidence.length === 0
        ? readTargetedAgentCompletionSummaries(this.cwd, this.ownerRootId, targetJobIds)
        : inspected;
      const selectedByJob = new Map(selected.events.map((event) => [event.jobId, event]));
      const consumedByJob = new Map(selected.consumed.map((event) => [event.jobId, event]));
      const barrierSettled = waited.targetReady && missingEvidence.length === 0;
      const unresolved = [];
      const targets = snapshots.map((snapshot) => {
        const currentJob = readJobFile(this.cwd, snapshot.jobId)
          ?? this.versionThreeJobView(snapshot.agent, snapshot.jobId)
          ?? snapshot.job;
        const terminal = Boolean(currentJob && TERMINAL_JOB_STATUSES.has(currentJob.status));
        const event = selectedByJob.get(snapshot.jobId);
        const consumed = consumedByJob.get(snapshot.jobId);
        const state = missingEvidence.some((missing) => missing.jobId === snapshot.jobId)
          ? "not_joinable"
          : !barrierSettled
          ? (terminal ? "settled" : "pending")
          : event
            ? "settled"
            : consumed
              ? "already_consumed"
              : "settled";
        if ((!barrierSettled && !terminal) || missingEvidence.some((missing) => missing.jobId === snapshot.jobId)) {
          unresolved.push(snapshot.agentName);
        }
        const entry = {
          agent_name: snapshot.agentName,
          agent_status: publicTargetTerminalStatus(currentJob?.status, snapshot.agent.status),
          state,
        };
        const frozen = event ?? consumed;
        if (frozen?.blocking != null) entry.blocking = frozen.blocking;
        if (event && barrierSettled) {
          entry.summary = event.summary;
          entry.completion_message = event.completionMessage;
          entry.completion_message_truncated = event.completionMessageTruncated;
          entry.delivery_token = event.deliveryToken;
          entry.metrics = event.metrics ?? null;
        }
        return entry;
      });
      return {
        message: missingEvidence.length > 0
          ? "HarnessDock Agent target is not joinable."
          : barrierSettled
          ? "HarnessDock Agent barrier is complete."
          : "Timed out waiting for HarnessDock Agent activity.",
        timedOut: !barrierSettled && missingEvidence.length === 0,
        targets,
        unresolved_targets: unresolved,
      };
    }
    // Refresh the light Agent registry on every poll so a root-wide wait can
    // observe progress from a turn started after the wait began.
    const progressJobIds = () => this.store.listAgents()
      .map((agent) => agent.activeJobId)
      .filter(Boolean);
    let waited = await this.jobs.wait(null, {
      timeoutMs: timeout,
      acknowledgeTokens,
      wakeOnProgress,
      progressJobIds,
      signal: this.abortSignal,
    });
    // Exit-time reconciliation can publish a completion the bounded wait above
    // never observed. When the bounded result was not already a completion,
    // take exactly one more zero-time, completion-only look at the same inbox
    // (no acknowledgement tokens, no progress wakeup) so a completion visible
    // at this linearization point replaces a stale timeout or claimed
    // progress instead of leaving the receipt behind durable state.
    this.reconcile();
    await this.reconcileLostV3Turns(deadlineAt);
    if (waited.update?.kind !== "completion") {
      const finalObservation = await this.jobs.wait(null, {
        timeoutMs: 0,
        acknowledgeTokens: [],
        wakeOnProgress: false,
        signal: this.abortSignal,
      });
      if (finalObservation.update?.kind === "completion") {
        waited = finalObservation;
      }
    }
    const agents = this.store.listAgents();
    const receipt = {
      message: waited.message,
      timedOut: waited.waitTimedOut,
    };
    if (waited.update) {
      receipt.update = waited.update.kind === "progress"
        ? publicProgressUpdate(waited.update, agents)
        : publicCompletionUpdate(waited.update, agents);
    }
    return receipt;
  }

  async interruptAgent(inputValue) {
    const input = assertObject(inputValue, "interrupt_agent input");
    this.reconcile();
    const agent = this.store.resolveTarget(assertText(input.target, "interrupt_agent target"));
    // Process control must remain available across an in-place Driver upgrade.
    // The persisted Agent and job snapshots still have to name this Harness and
    // carry a known capability vocabulary; activation and history stay strict.
    const driver = this.assertAgentDriver(agent, { allowDriverVersionDrift: true });
    if (!agent.activeJobId) {
      return {
        agent_name: agent.path,
        status: "no_active_turn",
      };
    }
    const interruptSupport = unsupportedRouteOperation(agent, "interruptRequest", ["supported"]);
    if (interruptSupport) {
      // An accepted route that proves no interrupt answers with a receipt, not
      // an exception: the Agent keeps running, nothing is aborted, and no
      // abort/status call is made in place of the operation.
      return {
        agent_name: agent.path,
        harness: agent.harnessId ?? driver.harnessId,
        status: "unsupported",
        unsupported: interruptSupport,
      };
    }
    if (
      agent.version === 3 &&
      harnessExecutionLifecycle(agent.route.harnessId) === "version_three_worker"
    ) {
      const identity = {
        ownerRootId: this.ownerRootId,
        agentId: agent.agentId,
        jobId: agent.activeJobId,
      };
      let record;
      try {
        record = readVersionThreeJobRecord(identity);
      } catch {
        return { agent_name: agent.path, status: "settlement_unknown" };
      }
      // The worker may still be between process handoff and its durable
      // running record. There is no native turn reference to address yet, so
      // the only honest request-stage answer is that it is still working.
      if (!record) {
        return { agent_name: agent.path, status: "still_working" };
      }
      if (record.status !== "running") {
        if (["completed", "failed", "interrupted"].includes(record.status) && record.terminalJob) {
          try {
            this.versionThreeStore().finalizeFromJob(record.terminalJob);
            const current = this.versionThreeStore().resolveTarget(agent.agentId);
            return {
              agent_name: current.path,
              status: current.activeJobId ? "settlement_unknown" : "no_active_turn",
            };
          } catch {}
        }
        return { agent_name: agent.path, status: "settlement_unknown" };
      }
      try {
        enqueueControlCommand({
          commandId: generateJobId("interrupt"),
          kind: "interrupt",
          ...identity,
          route: record.route,
          nativeTurnRef: record.nativeTurnRef,
          sanitizedReason: "operator_requested_interrupt",
        });
      } catch (error) {
        // A terminal barrier may win between the running-record read and the
        // enqueue. Re-read once; never fall through to Claude PID control.
        if (error?.code === "stream_closed") {
          try {
            const raced = readVersionThreeJobRecord(identity);
            if (["completed", "failed", "interrupted"].includes(raced?.status) && raced?.terminalJob) {
              this.versionThreeStore().finalizeFromJob(raced.terminalJob);
              const current = this.versionThreeStore().resolveTarget(agent.agentId);
              return {
                agent_name: current.path,
                status: current.activeJobId ? "settlement_unknown" : "no_active_turn",
              };
            }
          } catch {}
        }
        return { agent_name: agent.path, status: "settlement_unknown" };
      }
      // Request acceptance is deliberately not terminal settlement. The live
      // worker owns native acknowledgement and the result promise owns the
      // eventual terminal projection.
      return { agent_name: agent.path, status: "still_working" };
    }
    const interruptSnapshot = versionOneCapabilitySnapshot(agent, driver);
    if (interruptSnapshot) {
      assertHarnessCapability(
        interruptSnapshot,
        "interrupt",
        ["graceful_flush_proven", "best_effort_signal"],
        `Harness ${driver.harnessId} cannot interrupt an active turn`
      );
    }
    const turn = await this.jobs.interrupt(agent.activeJobId);
    this.reconcile();
    const current = this.store.resolveTarget(agent.agentId);
    return {
      agent_name: current.path,
      status: turn.interrupted
        ? "interrupted"
        : canonicalAgentStatus(current) === "failed"
          ? "failed"
          : "still_working",
    };
  }

  async readAgentMessages(inputValue) {
    const input = assertObject(inputValue, "read_agent_messages input");
    const allowed = new Set(["target", "before", "limit"]);
    const unsupported = Object.keys(input).find((key) => !allowed.has(key));
    if (unsupported) {
      throw new Error(`read_agent_messages does not support ${unsupported}.`);
    }
    const agent = this.store.resolveTarget(assertText(input.target, "read_agent_messages target"));
    const driver = this.assertAgentDriver(agent);
    const historySupport = unsupportedRouteOperation(agent, "history", ["assistant_messages"]);
    if (historySupport) {
      // No native transcript API is called for a route that proves no history.
      return {
        agent_name: agent.path,
        harness: agent.harnessId ?? driver.harnessId,
        status: "unsupported",
        unsupported: historySupport,
        messages: [],
      };
    }
    const historySnapshot = versionOneCapabilitySnapshot(agent, driver);
    if (historySnapshot) {
      assertHarnessCapability(
        historySnapshot,
        "history",
        ["assistant_messages"],
        `Harness ${driver.harnessId} exposes no readable assistant history`
      );
    }
    // A version-three record proves its native session with a neutral
    // reference; a legacy record proves it with the legacy pair. Either way the
    // proof has to exist before a transcript is looked for.
    const provenSession = agent.version === 3
      ? agent.nativeSessionRef
      : agent.claudeSessionId && agent.claudeConfigDir;
    if (!provenSession) {
      throw new Error(`Agent ${agent.path} has no proven native session history.`);
    }
    const history = await driver.readAssistantHistory(agent, {
      before: input.before,
      limit: input.limit,
    });
    return {
      agent_name: agent.path,
      agent_status: canonicalAgentStatus(agent),
      messages: history.messages.map((message) => ({
        message_id: message.messageId,
        timestamp: message.timestamp,
        text: message.text,
      })),
      next_before: history.nextBefore,
    };
  }

  listAgents(inputValue = {}) {
    const input = assertObject(inputValue, "list_agents input");
    if (input.all != null) throw new Error("list_agents does not expose cross-root all.");
    const agents = this.store.listAgents({ pathPrefix: optionalText(input.path_prefix) }).map((agent) => {
      const jobId = agent.activeJobId ?? agent.latestJobId;
      const job = agent.version === 3 && harnessExecutionLifecycle(agent.route.harnessId) === "version_three_worker"
        ? this.versionThreeJobView(agent, jobId)
        : observedAgentJob(agent, jobId ? readJobFile(this.cwd, jobId) : null, this.ownerRootId);
      return {
        ...projectAgentCard(agent, job),
        agent_status: observedAgentStatus(agent, job),
      };
    });
    return {
      agents,
    };
  }

  /**
   * Observe which Harnesses this checkout admits and what their logical
   * instances currently report.
   *
   * This states availability, not advice. It reports each Harness's readiness,
   * route constraints, capability maturity, and capacity, and it deliberately
   * carries no ranking, recommendation, score, price, or default: choosing a
   * Harness is the caller's explicit decision at spawn, and nothing here makes
   * it for them. It creates no Agent, session, or durable record.
   */
  async listHarnesses(inputValue = {}) {
    const input = assertObject(inputValue, "list_harnesses input");
    for (const key of Object.keys(input)) {
      throw new Error(`list_harnesses observes admitted Harnesses only; it does not accept ${key}.`);
    }
    return { harnesses: await this.jobs.inspectAdmittedHarnesses() };
  }
}

export function createAgentRuntime(options = {}) {
  return new AgentRuntime(options);
}
