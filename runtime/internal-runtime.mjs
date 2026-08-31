/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal one-turn Claude job runtime. The public Agent lifecycle is composed
 * above this module; subprocess, persistence, retries, and stream-json details
 * stay here.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimeEnvironment } from "./environment.mjs";
import {
  rollbackPreparedVersionThreeTurn,
  runDetachedVersionThreeTurn,
} from "./v3-worker-entry.mjs";
import { createAgentStore } from "./agent-store.mjs";
import {
  FUTURE_WRITE_GENERATION,
  assertSameDurableRouteSemantics,
  versionThreeRouteText,
} from "./durable-state-v3.mjs";
import {
  NATIVE_REFERENCE_ENVELOPE_VERSION,
  validateNativeReferenceEnvelope,
} from "./native-reference.mjs";
import { CLAUDE_LOCATOR_VERSION } from "./claude-code-driver.mjs";
import {
  acquireIntendedInstanceLease,
  acquireIntendedNativeSessionLease,
  releaseLeasesForPreSubmissionRollback,
  releaseLeasesOnSettlement,
} from "./instance-admission-lease.mjs";
import {
  beginPreSubmissionRollback,
  bindLaunchClaimLeases,
  completePreSubmissionRollback,
  createLaunchIntent,
  launchClaimRollbackEligibility,
  readLaunchClaim,
  recordLaunchAcceptanceUnknown,
} from "./launch-claim.mjs";
import { acquireIntendedWorkspaceWriterLease } from "./workspace-writer-lease.mjs";
import {
  HARNESS_CAPABILITY_NAMES,
  assertHarnessCapability,
  validateHarnessCapabilities,
} from "./harness-capabilities.mjs";
import {
  currentGenerationHarnessId,
  legacyRecordHarnessId,
} from "./claude-legacy-adapter.mjs";
import {
  admittedDriverDescription,
  validateRouteInspectionEvidence,
  validateHarnessTurnResult,
  validateInstanceInspection,
  validateNormalizedTerminalResult,
} from "./harness-contract.mjs";
import {
  ADMITTED_GENERATION_HARNESS_IDS,
  assertStatedHarnessId,
  createDriverScope,
  resolveDriverV2,
  resolveHarnessDriver,
} from "./harness-registry.mjs";
import {
  ACTIVE_JOB_STATUSES,
  HARNESS_QUEUED_JOB_STATUS,
  cleanupOldJobs,
  claimJobPublicProgress,
  generateJobId,
  getSteeringSnapshot,
  getStateProtectionReceipt,
  isJobPublicProgressDeliveryEligible,
  listJobsForOwner,
  listStoredJobs,
  nowIso,
  patchJob,
  readJobFile,
  releaseSessionLease,
  reserveSessionLease,
  resolveJobsDirForObservation,
  resolveJobFile,
  ensureStateDir as ensureJobStateDir,
  resolveJobLogFile,
  transitionJob,
  writeJobFile,
} from "./job-store.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  createWorkerLogStdio,
  runTrackedJob,
  safePublicToolName,
  OWNER_ROOT_ID_ENV,
} from "./job-runner.mjs";
import { enrichJob, sortJobsNewestFirst } from "./job-query.mjs";
import { getProcessIdentity } from "./process-control.mjs";
import { configureRuntimePaths, resolvePluginStateRoot, samePath } from "./paths.mjs";
import { renderTaskResult } from "./render.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { claimVersionThreeProgress, listVersionThreeJobRecords, resolveVersionThreeJobDirectory } from "./v3-job-store.mjs";
import { buildLeaseReleaseTargets } from "./v3-worker-loop.mjs";
import { launchVersionThreeTurn } from "./v3-worker-launch.mjs";
import {
  acknowledgeAgentCompletionEvents,
  readUnreadAgentCompletionSummaries,
  readTargetedAgentCompletionSummaries,
  resolveCompletionInboxDir,
  readUnreadCompletionEvents,
} from "./completion-inbox.mjs";
import {
  DEFAULT_FALLBACK_INTERVAL_MS,
  DEFAULT_RECOVERY_INTERVAL_MS,
  waitForDurableActivity,
} from "./durable-activity-wakeup.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const SOURCE_ROOT = fs.realpathSync.native(path.resolve(path.dirname(CLI_PATH), ".."));
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unknown",
]);

/**
 * The status of one version-three job record, for targeted-wait readiness. The
 * version-three store is keyed by owner root rather than workspace, and the
 * caller holds no agent identity here, so the bounded per-root listing is the
 * correct lookup.
 */
function versionThreeJobStatus(ownerRootId, jobId) {
  try {
    const { records } = listVersionThreeJobRecords({ ownerRootId });
    return records.find((record) => record.jobId === jobId)?.status;
  } catch {
    return undefined;
  }
}
const HANDOFF_DISPOSITIONS = new Set([
  "rollback_safe",
  "lifecycle_owned",
  "ownership_uncertain",
]);
const CHILD_SPAWN_WAIT_MS = 1_000;
const CHILD_EXIT_WAIT_MS = 1_000;
// A cold OpenCode route may spend up to 35 seconds in bounded, pre-submission
// service health, ownership, startup, and route revalidation. Keep the parent
// alive beyond that closed envelope so it cannot roll back the worker while
// the worker is still proving that no native turn has been submitted.
const V3_SUBMISSION_HANDOFF_WAIT_MS = 45_000;
const V3_TURN_EVIDENCE_CLASS = "v3-public-turn";
/** Version-2 durable Harness evidence on every job this runtime prepares. */
export const HARNESS_JOB_STATE_VERSION = 2;

export function preparedStartDisposition(error) {
  const value = String(error?.handoffDisposition ?? "");
  return HANDOFF_DISPOSITIONS.has(value) ? value : "ownership_uncertain";
}

function withPreparedStartDisposition(error, disposition) {
  const resolved = HANDOFF_DISPOSITIONS.has(disposition)
    ? disposition
    : "ownership_uncertain";
  if (error && typeof error === "object") {
    error.handoffDisposition = resolved;
    return error;
  }
  const wrapped = new Error(String(error));
  /** @type {any} */ (wrapped).handoffDisposition = resolved;
  return wrapped;
}

function versionThreeHandoffDisposition(identity) {
  let claim = null;
  try {
    claim = readLaunchClaim(identity);
  } catch {
    return "ownership_uncertain";
  }
  if (!claim) return "rollback_safe";
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

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isTerminalJob(job) {
  return Boolean(job && TERMINAL_STATUSES.has(job.status));
}

function matchesClaimedWorker(job, childPid, childIdentity = null) {
  if (!job || !["queued", HARNESS_QUEUED_JOB_STATUS, "running"].includes(job.status)) return false;
  if (!Number.isFinite(childPid) || job.workerPid !== childPid) return false;
  const storedIdentity = nonEmptyString(job.workerPidIdentity);
  if (!storedIdentity) return false;
  const expectedIdentity = nonEmptyString(childIdentity);
  return expectedIdentity == null || storedIdentity === expectedIdentity;
}

function matchesLauncherOwnership(job, launcher) {
  return Boolean(
    job &&
    ["queued", HARNESS_QUEUED_JOB_STATUS].includes(job.status) &&
    Number.isFinite(launcher?.pid) &&
    job.workerPid === launcher.pid &&
    nonEmptyString(job.workerPidIdentity) === nonEmptyString(launcher.identity) &&
    nonEmptyString(job.launcherGeneration) === nonEmptyString(launcher.generation)
  );
}

function waitFor(promise, milliseconds, fallback) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitForVersionThreeSubmissionFence(identity, observer, waitMs = V3_SUBMISSION_HANDOFF_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const claim = readLaunchClaim(identity);
    if (["acceptance_unknown", "acceptance_proven", "acceptance_rejected"].includes(claim?.acceptance)) {
      return { kind: "fenced", claim };
    }
    if (["rollback_in_progress", "rollback_complete"].includes(claim?.submissionState)) {
      return { kind: "rollback", claim };
    }
    if (observer.hasExited()) return { kind: "exit", claim };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { kind: "timeout", claim: readLaunchClaim(identity) };
}

function observeChild(child, onPostSpawnError) {
  if (!child || typeof child.once !== "function") {
    throw new Error("Worker spawn did not return an observable child process.");
  }
  let spawned = false;
  let exited = child.exitCode != null || child.signalCode != null;
  let postSpawnError = null;
  let resolveSpawn = null;
  let resolveExit = null;
  const spawnOutcome = new Promise((resolve) => { resolveSpawn = resolve; });
  const exitOutcome = new Promise((resolve) => { resolveExit = resolve; });
  const markExit = () => {
    if (exited) return;
    exited = true;
    resolveExit?.(true);
  };
  if (exited) resolveExit?.(true);
  child.once("spawn", () => {
    spawned = true;
    resolveSpawn?.({ kind: "spawned" });
  });
  child.once("error", (error) => {
    resolveSpawn?.({ kind: "error", error });
    if (spawned) {
      postSpawnError = error;
      onPostSpawnError?.(error);
    }
  });
  child.once("exit", markExit);
  child.once("close", markExit);
  return {
    hasExited: () => exited,
    postSpawnError: () => postSpawnError,
    waitForSpawn: () => waitFor(spawnOutcome, CHILD_SPAWN_WAIT_MS, { kind: "timeout" }),
    waitForExit: () => exited
      ? Promise.resolve(true)
      : waitFor(exitOutcome, CHILD_EXIT_WAIT_MS, false),
  };
}

function terminalizeFencedWorker(cwd, jobId, errorMessage) {
  return transitionJob(cwd, jobId, ["cancelling"], "failed", {
    phase: "worker_handoff_failed",
    completedAt: nowIso(),
    errorMessage,
    failureClass: "worker_handoff_failed",
    safeFreshRetry: true,
    workerPid: null,
    workerPidIdentity: null,
    pid: null,
    pidIdentity: null,
  });
}

function recordWorkerHandoffUncertainty(cwd, jobId, errorMessage) {
  const current = readJobFile(cwd, jobId);
  if (!current) return null;
  const uncertainAt = nowIso();
  const diagnostic = {
    workerHandoffUncertainAt: uncertainAt,
    workerHandoffError: errorMessage,
  };
  if (isTerminalJob(current)) patchJob(cwd, jobId, diagnostic);
  else {
    patchJob(cwd, jobId, {
      ...diagnostic,
      phase: current.status === "cancelling"
        ? "worker_handoff_cancelling"
        : "worker_handoff_uncertain",
    });
  }
  const durable = readJobFile(cwd, jobId);
  if (durable?.workerHandoffUncertainAt !== uncertainAt) {
    throw new Error(`Worker handoff uncertainty for ${jobId} was not durably persisted.`);
  }
  return durable;
}

function mayUnrefUnresolvedChild(cwd, jobId, observer) {
  if (observer.hasExited()) return true;
  const durable = readJobFile(cwd, jobId);
  return Boolean(
    isTerminalJob(durable) ||
    nonEmptyString(durable?.workerHandoffUncertainAt)
  );
}

async function fenceQueuedWorkerAndTerminate({
  cwd,
  jobId,
  child,
  observer,
  childPid,
  childIdentity,
  launcher,
  reason,
  recordUncertainty,
}) {
  let fence;
  try {
    fence = transitionJob(cwd, jobId, ["queued", HARNESS_QUEUED_JOB_STATUS], "cancelling", {
      phase: "worker_handoff_cancelling",
      workerHandoffFenceAt: nowIso(),
      workerHandoffUncertainAt: nowIso(),
      workerHandoffError: reason,
      workerPid: Number.isFinite(childPid) ? childPid : null,
      workerPidIdentity: childIdentity ?? null,
      pid: null,
      pidIdentity: null,
    }, {
      predicate: (job) => matchesLauncherOwnership(job, launcher),
    });
  } catch {
    return { kind: "unknown" };
  }

  if (!fence.transitioned) {
    const observed = fence.job ?? readJobFile(cwd, jobId);
    // A worker claim that won before the fence has already crossed the
    // execution boundary. The parent must never send it a cleanup signal.
    if (matchesClaimedWorker(observed, childPid, childIdentity)) return { kind: "claimed" };
    // A queued-to-terminal control CAS is also an execution fence: the worker
    // claims only from queued, so an old child cannot accept Claude input.
    if (isTerminalJob(observed)) return { kind: "terminal" };
    return { kind: "unknown" };
  }

  let delivered = false;
  try {
    delivered = child.kill("SIGTERM") === true;
  } catch {}
  if (!delivered || !(await observer.waitForExit())) {
    try { recordUncertainty(cwd, jobId, reason); } catch {}
    return { kind: "unknown" };
  }

  let terminalized = null;
  try {
    terminalized = terminalizeFencedWorker(cwd, jobId, reason);
  } catch {
    return { kind: "unknown" };
  }
  if (terminalized.transitioned || isTerminalJob(terminalized.job)) return { kind: "terminal" };
  return { kind: "unknown" };
}

async function resolveSpawnedWorkerHandoff({
  cwd,
  jobId,
  child,
  observer,
  getWorkerIdentity,
  publishWorkerIdentity,
  launcher,
  recordUncertainty,
}) {
  const childPid = Number.isFinite(child?.pid) ? child.pid : null;
  let childIdentity = null;
  let publicationError = null;
  if (childPid != null) {
    try {
      childIdentity = nonEmptyString(await getWorkerIdentity(childPid));
    } catch (error) {
      publicationError = error;
    }
  }

  if (!observer.postSpawnError() && childPid != null && childIdentity) {
    try {
      const publication = await publishWorkerIdentity(
        cwd,
        jobId,
        childPid,
        childIdentity,
        launcher
      );
      if (publication?.transitioned && matchesClaimedWorker(publication.job, childPid, childIdentity)) {
        return { kind: "published" };
      }
    } catch (error) {
      publicationError = error;
    }
  }

  const observed = readJobFile(cwd, jobId);
  if (matchesClaimedWorker(observed, childPid, childIdentity)) return { kind: "claimed" };
  if (isTerminalJob(observed)) return { kind: "terminal" };

  const detail = observer.postSpawnError()
    ? `worker reported a post-spawn error: ${observer.postSpawnError() instanceof Error
      ? observer.postSpawnError().message
      : String(observer.postSpawnError())}`
    : publicationError instanceof Error
    ? publicationError.message
    : childIdentity
      ? "queued worker identity publication did not prove ownership"
      : "worker PID identity could not be proven";
  return fenceQueuedWorkerAndTerminate({
    cwd,
    jobId,
    child,
    observer,
    childPid,
    childIdentity,
    launcher,
    reason: `Worker handoff failed: ${detail}`,
    recordUncertainty,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitAbortError() {
  const error = new Error("HarnessDock Agent wait observation was cancelled by the caller.");
  error.name = "AbortError";
  return error;
}

function throwIfWaitAborted(signal) {
  if (signal?.aborted) throw waitAbortError();
}

function summaryOf(prompt) {
  const normalized = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "Continue Claude session";
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}

function normalizeAllowedTools(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resultSessionId(job) {
  return job?.threadId ?? job?.result?.sessionId ?? job?.request?.resumeSessionId ?? null;
}

function assertWorkerIdentityText(value, label) {
  const text = String(value ?? "").trim();
  if (!text || !/^[\w.:-]+$/.test(text)) {
    throw new Error(`${label} must be bounded identity text.`);
  }
  return text;
}

function assertJobId(value) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("A Claude job id is required.");
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Invalid Claude job id: ${id}`);
  return id;
}

function resolveJob(jobs, reference) {
  const id = assertJobId(reference);
  const exact = jobs.find((job) => job.id === id);
  if (exact) return exact;
  const matches = jobs.filter((job) => job.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Job reference ${id} is ambiguous.`);
  throw new Error(`No Claude job found for ${id}.`);
}

function legacyOwnerRootId(job) {
  return typeof job?.sessionId === "string" && job.sessionId.trim()
    ? job.sessionId.trim()
    : null;
}

function jobOwnerRootId(job) {
  return typeof job?.ownerRootId === "string" && job.ownerRootId.trim()
    ? job.ownerRootId.trim()
    : legacyOwnerRootId(job);
}

const PUBLIC_PROGRESS_ACTIVITY = Object.freeze({
  initialized: { phase: "running", summary: "Claude session initialized." },
  thinking: { phase: "thinking", summary: "Claude is reasoning." },
  responding: { phase: "running", summary: "Claude is drafting its response." },
  tool: { phase: "tool", summary: "Claude is using a tool." },
  retrying: { phase: "retry", summary: "Claude is retrying an API request." },
  reconnecting: { phase: "reconnect_backoff", summary: "Claude is reconnecting." },
});

function projectPublicProgress(job, ownerRootId, jobId = null, options = {}) {
  if (
    jobOwnerRootId(job) !== ownerRootId ||
    !job.agentId ||
    !ACTIVE_JOB_STATUSES.has(job.status) ||
    (jobId != null && job.id !== jobId)
  ) {
    return null;
  }
      const progress = job.publicProgress;
      const revision = Number(progress?.revision ?? 0);
      const deliveredRevision = Number(job.publicProgressDeliveredRevision ?? 0);
      const activity = typeof progress?.activity === "string" ? progress.activity : "";
      const template = PUBLIC_PROGRESS_ACTIVITY[activity];
      if (
        !template ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        (options.requirePending !== false && (
          revision <= deliveredRevision ||
          !isJobPublicProgressDeliveryEligible(job)
        ))
      ) {
        return null;
      }
      let summary = template.summary;
      if (activity === "tool") {
        const match = String(progress?.summary ?? "").match(
          /^Claude is using ([A-Za-z0-9_.:-]{1,80})\.$/
        );
        const tool = safePublicToolName(match?.[1]);
        if (tool) summary = `Claude is using ${tool}.`;
      }
      const updatedAt = typeof progress?.updatedAt === "string" && Number.isFinite(Date.parse(progress.updatedAt))
        ? progress.updatedAt
        : job.updatedAt;
  return {
        kind: "progress",
        jobId: job.id,
        agentId: job.agentId,
        progress: {
          revision,
          activity,
          phase: template.phase,
          summary,
          updatedAt,
        },
  };
}

function pendingPublicProgress(cwd, ownerRootId, jobId = null, progressJobIds = null) {
  const jobs = jobId
    ? [readJobFile(cwd, jobId)].filter(Boolean)
    : Array.isArray(progressJobIds)
      ? progressJobIds.map((candidate) => readJobFile(cwd, candidate)).filter(Boolean)
      : listStoredJobs(cwd);
  const legacy = jobs
    .map((job) => projectPublicProgress(job, ownerRootId, jobId))
    .filter(Boolean)
    .sort((left, right) =>
      Date.parse(left.progress.updatedAt ?? 0) - Date.parse(right.progress.updatedAt ?? 0) ||
      left.jobId.localeCompare(right.jobId)
    )[0] ?? null;
  const eligible = new Set(jobId ? [jobId] : progressJobIds ?? []);
  const versionThree = listVersionThreeJobRecords({ ownerRootId }).records
    .filter((record) => record.status === "running" && record.progress && record.progress.revision > record.progressDeliveredRevision)
    .filter((record) => !jobId || record.jobId === jobId)
    .filter((record) => eligible.size === 0 || eligible.has(record.jobId))
    .map((record) => ({
      kind: "progress", source: "v3", jobId: record.jobId, agentId: record.agentId,
      progress: {
        revision: record.progress.revision,
        activity: record.progress.activity,
        phase: PUBLIC_PROGRESS_ACTIVITY[record.progress.activity]?.phase ?? "running",
        summary: record.progress.activity === "tool" && record.progress.toolName
          ? `Harness is using ${record.progress.toolName}.`
          : `Harness is ${record.progress.activity}.`,
        updatedAt: record.progress.updatedAt,
      },
    }))
    .sort((left, right) => Date.parse(left.progress.updatedAt) - Date.parse(right.progress.updatedAt) || left.jobId.localeCompare(right.jobId))[0] ?? null;
  if (!legacy) return versionThree;
  if (!versionThree) return legacy;
  return Date.parse(legacy.progress.updatedAt) <= Date.parse(versionThree.progress.updatedAt) ? legacy : versionThree;
}

/**
 * The bounded facts one logical instance publishes to a model-facing listing.
 *
 * Everything here is already closed by the Driver contract: a redacted instance
 * key, a closed readiness and detail code, a maturity, and the Driver's own
 * bounded route facts. Capacity is surfaced as its own field because a caller
 * needs to know a route serves one turn at a time; it is read from the route
 * facts rather than computed, and an absent capacity stays null rather than
 * defaulting to a number.
 */
const PUBLIC_ROUTE_FACT_FIELDS = Object.freeze([
  "models", "topologies", "effortsByModel", "capacity", "interaction", "activeInput",
  "continuation", "history", "interruptRequest", "turnObservation", "automaticRecovery",
  "nativeProgress", "authorityEnforcement", "leafEnforcement", "nativeOrchestration", "authorities",
]);

function publicHarnessRoutes(routes) {
  if (routes == null) return null;
  return Object.freeze(Object.fromEntries(
    PUBLIC_ROUTE_FACT_FIELDS.filter((field) => Object.hasOwn(routes, field)).map((field) => [field, routes[field]])
  ));
}

function publicHarnessInstance(inspection) {
  const routes = inspection.routes ?? null;
  return Object.freeze({
    instance: inspection.instanceKey,
    readiness: inspection.readiness,
    detail: inspection.detailCode,
    live_validated: inspection.liveValidated,
    maturity: inspection.maturity,
    capacity: routes && Number.isSafeInteger(routes.capacity) ? routes.capacity : null,
    routes: publicHarnessRoutes(routes),
    ...(inspection.capabilityProvenance == null ? {} : { capability_provenance: inspection.capabilityProvenance }),
    ...(inspection.inspectionGeneration == null ? {} : { inspection_generation: inspection.inspectionGeneration }),
  });
}

class InternalAgentRuntime {
  constructor(options = {}) {
    const inheritedEnv = options.env ?? process.env;
    const inheritedOwnerRootId = String(
      inheritedEnv[OWNER_ROOT_ID_ENV] ?? inheritedEnv.CODEX_THREAD_ID ?? ""
    ).trim();
    this.cwd = resolveWorkspaceRoot(options.cwd ?? process.cwd());
    const environment = resolveRuntimeEnvironment({
      cwd: this.cwd,
      env: inheritedEnv,
      envFile: options.envFile,
    });
    this.env = environment.env;
    configureRuntimePaths(this.env);
    this.environmentReceipt = environment.receipt;
    const configuredCheckout = String(this.env.CODEX_HARNESSDOCK_RUNTIME_CHECKOUT ?? "").trim();
    if (configuredCheckout) {
      const expectedSourceRoot = fs.realpathSync.native(path.resolve(configuredCheckout));
      if (!samePath(expectedSourceRoot, SOURCE_ROOT)) {
        throw new Error(
          `Refusing runtime source ${SOURCE_ROOT}; CODEX_HARNESSDOCK_RUNTIME_CHECKOUT requires ${expectedSourceRoot}.`
        );
      }
    }
    this.sourceRoot = SOURCE_ROOT;
    this.env.CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT = this.sourceRoot;
    // Kept internal to this runtime constructor so local tests can freeze
    // launch races without starting a real Claude worker. The public Agent API
    // never accepts or exposes these dependencies.
    this.launchDependencies = {
      spawn: options.launchDependencies?.spawn ?? spawn,
      getProcessIdentity: options.launchDependencies?.getProcessIdentity ?? getProcessIdentity,
      createWorkerLogStdio: options.launchDependencies?.createWorkerLogStdio ?? createWorkerLogStdio,
      publishWorkerIdentity: options.launchDependencies?.publishWorkerIdentity ??
        ((cwd, jobId, workerPid, workerPidIdentity, launcher) => {
          const current = readJobFile(cwd, jobId);
          const status = current?.status;
          if (!["queued", HARNESS_QUEUED_JOB_STATUS].includes(status)) {
            return { transitioned: false, job: current, previousStatus: status ?? null };
          }
          return transitionJob(cwd, jobId, [status], status, {
            workerPid,
            workerPidIdentity,
            workerHandoffAt: nowIso(),
          }, {
            predicate: (job) => matchesLauncherOwnership(job, launcher),
          });
        }),
      recordWorkerHandoffUncertainty:
        options.launchDependencies?.recordWorkerHandoffUncertainty ?? recordWorkerHandoffUncertainty,
      resolveDriverV2: options.launchDependencies?.resolveDriverV2 ?? resolveDriverV2,
    };
    this.waitDependencies = {
      watch: options.waitDependencies?.watch ?? fs.watch,
      statSync: options.waitDependencies?.statSync ?? fs.statSync,
      setTimeout: options.waitDependencies?.setTimeout ?? setTimeout,
      clearTimeout: options.waitDependencies?.clearTimeout ?? clearTimeout,
      now: options.waitDependencies?.now ?? (() => Date.now()),
      recoveryIntervalMs: options.waitDependencies?.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
      fallbackIntervalMs: options.waitDependencies?.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS,
      onWake: options.waitDependencies?.onWake ?? null,
      onRead: options.waitDependencies?.onRead ?? null,
    };
    // The Harness this public generation is bound to is stated once, by the
    // owner of that legacy meaning. Every durable Agent/job is still resolved
    // from its own recorded Harness, and nothing below defaults to this one.
    this.generationHarnessId = currentGenerationHarnessId();
    this.driver = resolveHarnessDriver(this.generationHarnessId, { env: this.env });
    this.harnessInstance = Object.freeze({
      harnessId: this.driver.harnessId,
      instanceKey: this.driver.resolveInstanceKey(this.env),
    });
    this.operatorMode = options.operatorMode === true;
    this.ownerRootId = String(
      this.operatorMode && options.ownerRootId
        ? options.ownerRootId
        : inheritedOwnerRootId
    ).trim() || null;
  }

  /**
   * Resolve one explicitly stated Harness. There is no default: an unstated
   * Harness is a missing route, and it is refused before any readiness check,
   * durable write, or native launch.
   */
  driverForHarness(harnessId) {
    const stated = assertStatedHarnessId(harnessId, "Harness Driver resolution");
    // Preserve the existing in-process test seam while production composition
    // still resolves every other route from the static registry.
    if (this.driver?.harnessId === stated) return this.driver;
    return resolveHarnessDriver(stated, { env: this.env });
  }

  harnessInstanceFor(driver) {
    return Object.freeze({
      harnessId: driver.harnessId,
      instanceKey: driver.resolveInstanceKey(this.env),
    });
  }

  assertOwnerRoot() {
    if (!this.ownerRootId) {
      throw new Error(
        "A Codex root identity is required. Invoke this lifecycle through the plugin bootstrap so CODEX_THREAD_ID can be captured."
      );
    }
    return this.ownerRootId;
  }

  migrateMatchingLegacyOwner(job) {
    if (job?.ownerRootId || legacyOwnerRootId(job) !== this.ownerRootId) return job;
    return patchJob(this.cwd, job.id, { ownerRootId: this.ownerRootId }) ?? job;
  }

  /**
   * Observe every admitted Harness through its version-two Driver.
   *
   * This is inspection, not dispatch: it creates no Agent, no session, and no
   * durable record, it starts and repairs nothing, and it neither ranks,
   * recommends, nor selects. Each Harness answers for its own logical instances;
   * one Harness failing to answer never hides the others.
   */
  /**
   * The validated version-two inspections of one admitted Harness, for route
   * acceptance.
   *
   * This is the runtime's single seam for a route-time readiness observation, so
   * a caller, a test, or a later generation replaces one function rather than
   * reaching into a Driver. It starts, repairs, and creates nothing.
   */
  async inspectRouteInstance(harnessId, executionRoot = this.cwd) {
    const driver = resolveDriverV2(assertStatedHarnessId(harnessId, "Route instance inspection"), {
      env: this.env,
    });
    const inspections = await driver.inspectInstances(createDriverScope({
      driver,
      purpose: "inspect",
      rootId: this.ownerRootId,
      workspaceRoot: executionRoot,
      env: this.env,
    }));
    // One host observation per route acceptance. A Harness whose turns run on
    // the version-one supervisor needs that generation's readiness receipt too,
    // and its Driver can state it from the observation it just made rather than
    // making the same (subprocess-shaped) observation a second time. A Driver
    // that offers none simply returns null and the caller observes for itself.
    const offered = typeof driver.launchPreflightFromInspection === "function"
      ? driver.launchPreflightFromInspection(executionRoot)
      : null;
    return Object.freeze({
      driver,
      inspections: Object.freeze(
        (Array.isArray(inspections) ? inspections : [])
          .map((inspection) => validateInstanceInspection(inspection, driver))
      ),
      // The receipt is consumed by the version-one launch path, so it is
      // wrapped with the version-one Driver's own identity, exactly as
      // `assertReady()` would have produced it.
      launchReadiness: offered == null
        ? null
        : this.readinessFromPreflight(this.driverForHarness(driver.harnessId), offered, executionRoot),
    });
  }

  async inspectAdmittedHarnesses() {
    const records = [];
    for (const harnessId of ADMITTED_GENERATION_HARNESS_IDS) {
      records.push(Object.freeze(await this.inspectAdmittedHarness(harnessId)));
    }
    return Object.freeze(records);
  }

  async inspectAdmittedHarness(harnessId) {
    let driver;
    try {
      driver = resolveDriverV2(harnessId, { env: this.env });
    } catch {
      // A Harness this checkout admits but cannot construct here is reported as
      // unavailable with a closed reason; the underlying message may name
      // configuration and never reaches a model-facing receipt.
      return { harness: harnessId, unavailable: "driver_unavailable", instances: [] };
    }
    const description = admittedDriverDescription(driver);
    const scope = createDriverScope({
      driver,
      purpose: "inspect",
      rootId: this.ownerRootId,
      workspaceRoot: this.cwd,
      env: this.env,
    });
    let inspections;
    try {
      inspections = await driver.inspectInstances(scope);
    } catch {
      return {
        harness: driver.harnessId,
        driver_version: driver.driverVersion,
        maturity: description.maturity,
        capability_schema_version: description.capabilitySchemaVersion,
        unavailable: "inspection_failed",
        instances: [],
      };
    }
    return {
      harness: driver.harnessId,
      driver_version: driver.driverVersion,
      maturity: description.maturity,
      capability_schema_version: description.capabilitySchemaVersion,
      instances: Object.freeze(
        (Array.isArray(inspections) ? inspections : []).map((inspection) =>
          publicHarnessInstance(validateInstanceInspection(inspection, driver))
        )
      ),
    };
  }

  readiness(harnessId = this.generationHarnessId, executionRoot = this.cwd) {
    const driver = this.driverForHarness(harnessId);
    return this.readinessFromPreflight(driver, driver.preflight({ cwd: executionRoot, env: this.env }), executionRoot);
  }

  /**
   * Wrap one Driver preflight in this runtime's own scope facts.
   *
   * The scope half -- working directory, native configuration, environment
   * receipt, source root, owner root, state protection -- belongs to this
   * runtime, not to any Driver, so it is added in exactly one place whether the
   * preflight came from a fresh observation or from the one a route acceptance
   * already made.
   */
  readinessFromPreflight(driver, preflight, executionRoot = this.cwd) {
    return {
      ...preflight,
      harness: {
        harnessId: driver.harnessId,
        driverVersion: driver.driverVersion,
        instanceKey: preflight.instanceKey,
        capabilities: driver.capabilities,
      },
      cwd: executionRoot,
      claudeConfigDir: this.env.CLAUDE_CONFIG_DIR ?? null,
      environment: this.environmentReceipt,
      sourceRoot: this.sourceRoot,
      ownerRoot: {
        available: Boolean(this.ownerRootId),
        source: this.ownerRootId ? "codex_thread_environment" : null,
        scope: "logical_root",
      },
      stateProtection: getStateProtectionReceipt(this.cwd),
    };
  }

  assertReady(harnessId, executionRoot = this.cwd) {
    const driver = this.driverForHarness(harnessId);
    const receipt = this.readiness(driver.harnessId, executionRoot);
    const unready = driver.describeUnreadiness(receipt);
    if (unready) throw new Error(unready);
    return receipt;
  }

  assertPreparedReadiness(receipt, driver = this.driver, executionRoot = this.cwd) {
    if (receipt == null) return this.assertReady(driver.harnessId, executionRoot);
    return driver.validatePreparedPreflight(receipt, {
      cwd: executionRoot,
      env: this.env,
      sourceRoot: this.sourceRoot,
    });
  }

  list() {
    const ownerRootId = this.assertOwnerRoot();
    const jobs = sortJobsNewestFirst(listJobsForOwner(this.cwd, ownerRootId));
    return jobs
      .filter((job) => jobOwnerRootId(job) === ownerRootId)
      .map((job) => enrichJob(this.migrateMatchingLegacyOwner(job)));
  }

  status(jobId = null) {
    const jobs = this.list();
    if (jobId) return enrichJob(resolveJob(jobs, jobId));
    const ownerRootId = this.assertOwnerRoot();
    return {
      workspaceRoot: this.cwd,
      active: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)),
      recent: jobs.slice(0, 15),
      unreadCompletions: readUnreadCompletionEvents(this.cwd, ownerRootId),
    };
  }

  operatorListAllJobs() {
    if (!this.operatorMode) throw new Error("Cross-root listing is operator-only.");
    return sortJobsNewestFirst(listStoredJobs(this.cwd)).map((job) => enrichJob(job));
  }

  assertSessionAvailable(sessionId, excludingJobId = null) {
    if (!sessionId) return;
    const owner = listStoredJobs(this.cwd).find((job) =>
      job.id !== excludingJobId &&
      ACTIVE_JOB_STATUSES.has(job.status) &&
      resultSessionId(job) === sessionId
    );
    if (owner) {
      throw new Error(`Claude session ${sessionId} is already owned by active job ${owner.id}.`);
    }
  }

  prepareStart(task, options = {}) {
    const ownerRootId = this.assertOwnerRoot();
    const prompt = String(task ?? "").trim();
    const resumeSessionId = String(options.resumeSessionId ?? "").trim() || null;
    if (!prompt && !resumeSessionId) {
      throw new Error("start requires a task or an explicit Claude session to resume.");
    }
    // Keep this validation ahead of readiness and all durable job writes. The
    // public lifecycle validates first for caller-facing failure semantics;
    // preparation repeats it so internal callers cannot bypass that boundary.
    //
    // Preparation is a route decision, so it states its Harness. There is no
    // fallback here: an unstated Harness fails before readiness, before the
    // session lease, and before one durable job byte is written.
    const driver = this.driverForHarness(options.harnessId);
    const harnessInstance = this.harnessInstanceFor(driver);
    const executionProfile = driver.validateRoute({
      profile: options.profile,
      write: options.write,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      allowedTools: options.allowedTools,
      delegationMode: options.delegationMode,
    });
    const profile = executionProfile.name;
    // Agent orchestration validates this potentially slow CLI/auth check
    // before it publishes an active Agent reservation. Reuse that exact,
    // scope-bound receipt here so the small reservation-to-job window contains
    // only local durable writes and worker launch.
    const executionRoot = fs.realpathSync.native(options.executionRoot ?? this.cwd);
    const readiness = this.assertPreparedReadiness(options.readinessReceipt, driver, executionRoot);
    const jobId = String(options.jobId ?? "").trim() || generateJobId("hd-agent");
    if (!/^[\w.-]+$/.test(jobId)) throw new Error(`Invalid internal Claude job id: ${jobId}.`);
    const title = options.title ?? "Claude Code Task";
    const candidateAgentId = String(options.agentId ?? "").trim() || null;
    let launcherIdentity = null;
    try { launcherIdentity = getProcessIdentity(process.pid); } catch {}
    if (!launcherIdentity) {
      throw new Error("Unable to establish a deterministic launcher process identity.");
    }
    const launcherGeneration = generateJobId("launcher");
    try {
      const base = createJobRecord({
        id: jobId,
        kind: "task",
        kindLabel: "run",
        jobClass: "task",
        title,
        summary: summaryOf(prompt),
        workspaceRoot: this.cwd,
        controlRoot: this.cwd,
        executionRoot,
        write: Boolean(options.write),
        profile,
        // A prepared fact intentionally has no persisted agentId. Losing a
        // concurrent Agent reservation must leave a disposable diagnostic
        // record, never a terminal fact that can project onto an Agent.
        claudeConfigDir: this.env.CLAUDE_CONFIG_DIR,
        readiness,
        parentJobId: options.parentJobId ?? null,
      }, {
        cwd: this.cwd,
        env: this.env,
        ownerRootId,
      });
      const logFile = createJobLogFile(this.cwd, jobId, title);
      const request = {
        prompt: prompt || "Continue where you left off.",
        write: Boolean(options.write),
        profile,
        model: executionProfile.model,
        effort: executionProfile.effort ?? null,
        permissionMode: options.permissionMode ?? null,
        dangerouslySkipPermissions: executionProfile.dangerouslySkipPermissions,
        allowedTools: normalizeAllowedTools(options.allowedTools),
        delegationMode: executionProfile.delegationMode,
        sessionName: String(options.sessionName ?? "").trim() || null,
        resumeSessionId,
      };
      writeJobFile(this.cwd, jobId, {
        ...base,
        // Every prepared turn records the Driver contract that launched it, so
        // recovery is later judged against the same capabilities rather than
        // whatever the current registry happens to publish.
        harnessStateVersion: HARNESS_JOB_STATE_VERSION,
        harnessId: driver.harnessId,
        driverVersion: driver.driverVersion,
        harnessInstanceKey: harnessInstance.instanceKey,
        harnessCapabilities: driver.capabilities,
        harnessRoute: {
          harnessId: driver.harnessId,
          model: executionProfile.model,
          effort: executionProfile.effort ?? null,
          delegationMode: executionProfile.delegationMode,
          write: Boolean(options.write),
        },
        route: options.route ?? null,
        status: HARNESS_QUEUED_JOB_STATUS,
        phase: "activation_prepared",
        activationPrepared: true,
        activationAttached: false,
        preClaudeLaunch: true,
        safeFreshRetry: true,
        acceptingSteering: driver.capabilities.activeInput === "acknowledged_active_stream",
        // The caller owning this prepared fact is an identity-verified launch
        // boundary. Reaping consults this PID, so a slow local lease/write
        // cannot be mistaken for a dead reservation while the caller lives.
        workerPid: process.pid,
        workerPidIdentity: launcherIdentity,
        launcherGeneration,
        pid: null,
        pidIdentity: null,
        logFile,
        request,
      });
      appendLogLine(logFile, "Prepared for Agent activation.");
      return {
        jobId,
        agentId: candidateAgentId,
        status: "prepared",
        title,
        summary: base.summary,
        profile,
        workspaceRoot: this.cwd,
        controlRoot: this.cwd,
        executionRoot,
        launcherPid: process.pid,
        launcherIdentity,
        launcherGeneration,
      };
    } catch (error) {
      try { fs.unlinkSync(resolveJobFile(this.cwd, jobId)); } catch {}
      try { fs.unlinkSync(resolveJobLogFile(this.cwd, jobId)); } catch {}
      throw error;
    }
  }

  attachPreparedStart(prepared, agentId) {
    const jobId = assertJobId(prepared?.jobId);
    const id = String(agentId ?? "").trim();
    if (!id) throw new Error("Prepared Agent start requires an Agent ID.");
    const job = readJobFile(this.cwd, jobId);
    if (
      !matchesLauncherOwnership(job, {
        pid: prepared?.launcherPid,
        identity: prepared?.launcherIdentity,
        generation: prepared?.launcherGeneration,
      }) ||
      job.phase !== "activation_prepared" ||
      job.agentId
    ) {
      throw new Error(`Prepared job ${jobId} is no longer attachable to an Agent.`);
    }
    patchJob(this.cwd, jobId, {
      agentId: id,
      activationAttached: true,
      activationAttachedAt: nowIso(),
    });
    return { ...prepared, agentId: id };
  }

  abortPreparedStart(prepared, options = {}) {
    const jobId = assertJobId(prepared?.jobId);
    const job = readJobFile(this.cwd, jobId);
    // A durable launch marker is a cross-process boundary: an ordinary caller
    // may not remove it merely because no child PID was published yet. The
    // sole exception is a structured rollback_safe disposition, which proves
    // that spawn itself never succeeded.
    const rollbackSafe = options.handoffDisposition === "rollback_safe";
    if (
      !job ||
      !matchesLauncherOwnership(job, {
        pid: prepared?.launcherPid,
        identity: prepared?.launcherIdentity,
        generation: prepared?.launcherGeneration,
      }) ||
      job.pid != null ||
      (job.workerLaunchStartedAt && !rollbackSafe)
    ) {
      return false;
    }
    try { fs.unlinkSync(resolveJobFile(this.cwd, jobId)); } catch { return false; }
    try { fs.unlinkSync(resolveJobLogFile(this.cwd, jobId)); } catch {}
    return true;
  }

  async launchPreparedStart(prepared, task, options = {}) {
    const jobId = assertJobId(prepared?.jobId);
    const current = readJobFile(this.cwd, jobId);
    const launcher = {
      pid: prepared?.launcherPid,
      identity: prepared?.launcherIdentity,
      generation: prepared?.launcherGeneration,
    };
    if (!matchesLauncherOwnership(current, launcher)) {
      throw new Error(`Prepared job ${jobId} is no longer owned by this launcher.`);
    }
    if (prepared.agentId && current.agentId !== prepared.agentId) {
      throw new Error(`Prepared job ${jobId} is not attached to the expected Agent.`);
    }
    const prompt = String(task ?? "").trim();
    const resumeSessionId = String(current.request?.resumeSessionId ?? "").trim() || null;
    if (!prompt && !resumeSessionId) {
      throw new Error("Prepared start requires a task or an explicit Claude session to resume.");
    }
    let sessionLease = null;
    let childReturned = false;
    let handoffResolved = false;
    let workerLog = null;
    let launched = null;
    let receipt = null;
    let failure = null;
    const harnessInstance = Object.freeze({
      harnessId: legacyRecordHarnessId(current),
      instanceKey: nonEmptyString(current.harnessInstanceKey) ??
        this.driverForHarness(legacyRecordHarnessId(current)).resolveInstanceKey(this.env),
    });
    try {
      // Version-three Agents use the shared native-session admission bundle
      // below. Keep the older session-lease owner only for genuinely legacy
      // jobs rather than holding two independent session locks for one turn.
      sessionLease = resumeSessionId && current.route == null
        ? reserveSessionLease(this.cwd, harnessInstance, resumeSessionId, jobId)
        : null;
      launched = patchJob(this.cwd, jobId, {
        summary: summaryOf(prompt),
        phase: "queued",
        activationPrepared: false,
        ...(sessionLease ? {
          sessionLease: {
            harnessId: sessionLease.harnessId,
            instanceKey: sessionLease.instanceKey,
            configIdentity: sessionLease.configIdentity,
            sessionId: sessionLease.sessionId,
          },
        } : {}),
        request: {
          ...current.request,
          prompt: prompt || "Continue where you left off.",
        },
        assignedMessageIds: Array.isArray(options.assignedMessageIds)
          ? [...options.assignedMessageIds]
          : (current.assignedMessageIds ?? null),
      });
      if (!launched || launched.status !== HARNESS_QUEUED_JOB_STATUS) {
        throw new Error(`Prepared job ${jobId} could not enter the queued launch state.`);
      }
      const marked = patchJob(this.cwd, jobId, { workerLaunchStartedAt: nowIso() });
      if (!matchesLauncherOwnership(marked, launcher)) {
        throw new Error(`Prepared job ${jobId} could not record detached-worker launch.`);
      }
      appendLogLine(launched.logFile, "Queued for background execution.");

      workerLog = this.launchDependencies.createWorkerLogStdio(launched.logFile);
      const child = this.launchDependencies.spawn(process.execPath, [CLI_PATH, "worker", "--cwd", this.cwd, "--job-id", jobId], {
        cwd: this.cwd,
        env: this.env,
        detached: true,
        stdio: /** @type {import("node:child_process").StdioOptions} */ (workerLog.stdio),
        windowsHide: true,
      });
      childReturned = true;
      let observer = null;
      observer = observeChild(child, (error) => {
        try {
          this.launchDependencies.recordWorkerHandoffUncertainty(
            this.cwd,
            jobId,
            `Worker reported an error after spawn: ${error instanceof Error ? error.message : String(error)}`
          );
        } catch {}
      });
      const spawnOutcome = await observer.waitForSpawn();
      if (spawnOutcome.kind === "error") {
        throw withPreparedStartDisposition(
          spawnOutcome.error instanceof Error
            ? spawnOutcome.error
            : new Error("Worker process failed before spawn."),
          "rollback_safe"
        );
      }
      if (spawnOutcome.kind !== "spawned") {
        const handoff = await fenceQueuedWorkerAndTerminate({
          cwd: this.cwd,
          jobId,
          child,
          observer,
          childPid: Number.isFinite(child?.pid) ? child.pid : null,
          childIdentity: null,
          launcher,
          reason: `Worker process did not prove spawn within the handoff window for ${jobId}.`,
          recordUncertainty: this.launchDependencies.recordWorkerHandoffUncertainty,
        });
        if (handoff.kind !== "unknown" || mayUnrefUnresolvedChild(this.cwd, jobId, observer)) {
          try { child.unref(); } catch {}
        }
        if (handoff.kind === "terminal") {
          throw withPreparedStartDisposition(
            new Error(`Worker handoff ended before Claude launch for ${jobId}.`),
            "lifecycle_owned"
          );
        }
        if (handoff.kind === "claimed") {
          handoffResolved = true;
          receipt = {
            jobId,
            agentId: launched.agentId ?? null,
            status: "queued",
            title: launched.title,
            summary: launched.summary,
            profile: launched.profile,
            workspaceRoot: this.cwd,
          };
        } else {
          throw withPreparedStartDisposition(
            new Error("Worker process did not prove spawn within the handoff window."),
            "ownership_uncertain"
          );
        }
      } else {
        const handoff = await resolveSpawnedWorkerHandoff({
          cwd: this.cwd,
          jobId,
          child,
          observer,
          getWorkerIdentity: this.launchDependencies.getProcessIdentity,
          publishWorkerIdentity: this.launchDependencies.publishWorkerIdentity,
          launcher,
          recordUncertainty: this.launchDependencies.recordWorkerHandoffUncertainty,
        });
        if (handoff.kind === "published" || handoff.kind === "claimed") {
          handoffResolved = true;
          try { child.unref(); } catch {
            try { appendLogLine(launched.logFile, "Worker handoff succeeded but child unref failed."); } catch {}
          }
          receipt = {
            jobId,
            agentId: launched.agentId ?? null,
            status: "queued",
            title: launched.title,
            summary: launched.summary,
            profile: launched.profile,
            workspaceRoot: this.cwd,
          };
        } else if (handoff.kind === "terminal") {
          handoffResolved = true;
          try { child.unref(); } catch {}
          throw withPreparedStartDisposition(
            new Error(`Worker handoff ended before Claude launch for ${jobId}.`),
            "lifecycle_owned"
          );
        } else {
          try {
            this.launchDependencies.recordWorkerHandoffUncertainty(
              this.cwd,
              jobId,
              `Worker handoff could not prove publication, claim, or exit for ${jobId}.`
            );
          } catch {}
          if (mayUnrefUnresolvedChild(this.cwd, jobId, observer)) {
            try { child.unref(); } catch {}
          }
          throw withPreparedStartDisposition(
            new Error(`Worker handoff ownership remains uncertain for ${jobId}.`),
            "ownership_uncertain"
          );
        }
      }
    } catch (error) {
      const explicitDisposition = String(error?.handoffDisposition ?? "");
      failure = withPreparedStartDisposition(
        error,
        HANDOFF_DISPOSITIONS.has(explicitDisposition)
          ? explicitDisposition
          : childReturned ? "ownership_uncertain" : "rollback_safe"
      );
    }

    try {
      workerLog?.close();
    } catch (error) {
      try {
        appendLogLine(launched?.logFile, `Worker log cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {}
      if (!handoffResolved && !failure) {
        failure = withPreparedStartDisposition(error, childReturned ? "ownership_uncertain" : "rollback_safe");
      }
    }

    if (failure) {
      if (preparedStartDisposition(failure) === "rollback_safe" && sessionLease) {
        releaseSessionLease(harnessInstance, sessionLease.sessionId, jobId);
      }
      throw failure;
    }
    return receipt;
  }

  async start(task, options = {}) {
    const prepared = this.prepareStart(task, options);
    let launchAttempted = false;
    try {
      const attached = prepared.agentId
        ? this.attachPreparedStart(prepared, prepared.agentId)
        : prepared;
      launchAttempted = true;
      return await this.launchPreparedStart(attached, task);
    } catch (error) {
      const handoffDisposition = launchAttempted
        ? preparedStartDisposition(error)
        : "rollback_safe";
      if (handoffDisposition === "rollback_safe") {
        this.abortPreparedStart(prepared, { handoffDisposition });
      }
      throw error;
    }
  }

  /**
   * Hand one accepted version-three turn to a real detached worker process.
   *
   * This mirrors the existing detached-worker contract exactly -- the same
   * `cli.mjs worker` entry, the same detached/stdio/windowsHide options, the
   * same spawn observation -- and differs only in what it hands over: four
   * identifiers, never state. It writes no version-one job record, because a
   * version-three turn's durable owner is the version-three job store and a
   * second lifecycle for one native turn could publish a second completion.
   *
   * A process that never proves it spawned is terminated and reported, so the
   * caller can roll its activation back; a process that dies later is
   * reconciliation's business, not this call's.
   */
  async launchVersionThreeWorker(options) {
    const handoffIdentity = {
      ownerRootId: String(this.ownerRootId ?? "").trim(),
      agentId: String(options?.agentId ?? "").trim(),
      jobId: String(options?.jobId ?? "").trim(),
      attemptId: String(options?.attemptId ?? "").trim(),
    };
    try {
      const ownerRootId = this.assertOwnerRoot();
      const agentId = assertWorkerIdentityText(options.agentId, "Version-three worker agent ID");
      const jobId = assertJobId(options.jobId);
      const attemptId = assertWorkerIdentityText(options.attemptId, "Version-three worker attempt ID");
      const identity = { ownerRootId, agentId, jobId };
      const store = createAgentStore({
      cwd: this.cwd,
      ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
      });
    const agent = store.resolveTarget(agentId);
    if (agent.activeJobId !== jobId) {
      throw new Error(`Version-three Agent ${agent.path} is not active for job ${jobId}.`);
    }
    const assigned = store.listMessages(agentId).filter(
      (message) => message.assignedJobId === jobId && message.deliveryIntent === "initial_prompt"
    );
    if (assigned.length === 0) throw new Error(`Version-three job ${jobId} has no prepared initial assignment.`);
    const assignedMessageIds = assigned.map((message) => message.messageId);
    const taskInput = assigned.map((message) => message.text).join("\n\n");
    const executionRoute = assertSameDurableRouteSemantics(
      agent.route,
      options.executionRoute,
      `Version-three Agent ${agent.path} launch`,
    );
    const driver = resolveDriverV2(executionRoute.harnessId, { env: this.env });
    const inspectionEvidence = validateRouteInspectionEvidence(
      options.inspectionEvidence, executionRoute, "Version-three launch inspection evidence"
    );
    const turnOptions = options.turnOptions ?? null;
    let leases = [];
    let claim = readLaunchClaim(identity);
    if (claim) {
      if (claim.inspectionEvidence == null) {
        throw new Error("Version-three launch refuses an evidence-less historical claim before submission.");
      }
      if (
        claim.lifecycleOwner !== "version_three_worker" ||
        claim.controlRoot !== agent.workspaceRoot ||
        claim.executionRoot !== (agent.executionRoot ?? agent.workspaceRoot)
      ) {
        throw new Error("Version-three launch claim does not bind this Agent's control and execution roots.");
      }
      assertSameDurableRouteSemantics(agent.route, claim.route, `Version-three launch claim ${jobId}`);
      validateRouteInspectionEvidence(claim.inspectionEvidence, executionRoute, "Version-three launch claim inspection evidence");
      if (JSON.stringify(claim.route) !== JSON.stringify(executionRoute)) {
        throw new Error(`Version-three launch claim ${jobId} does not bind this exact execution route.`);
      }
    }
    try {
      if (claim) {
        if (claim.attemptId !== attemptId) {
          throw new Error(`Version-three job ${jobId} is already claimed by another attempt.`);
        }
        if (["rollback_in_progress", "rollback_complete"].includes(claim.submissionState)) {
          rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
          throw new Error(`Version-three job ${jobId} was already rolled back.`);
        }
        if (claim.acceptance === "not_submitted" && claim.submissionState === "not_started") {
          rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
          throw new Error(`Version-three job ${jobId} recovered its incomplete prepared launch without replay.`);
        }
      } else {
        const preparedTurn = driver.prepareTurn({
          route: executionRoute,
          taskInput,
          turnOptions,
          turnId: jobId,
        });
        const nativeSessionRef = agent.nativeSessionRef == null
          ? null
          : validateNativeReferenceEnvelope(agent.nativeSessionRef, {
              driver,
              kind: "session",
              route: executionRoute,
            });
        const expectedLease = nativeSessionRef == null
          ? {
              kind: "instance",
              capacityClass: `${V3_TURN_EVIDENCE_CLASS}:${jobId}`,
              capacityLimit: 1,
            }
          : { kind: "native_session", nativeSessionId: nativeSessionRef.locator.sessionId };
        claim = createLaunchIntent({
          ...identity,
          attemptId,
          lifecycleOwner: "version_three_worker",
          controlRoot: agent.workspaceRoot,
          executionRoot: agent.executionRoot ?? agent.workspaceRoot,
          route: executionRoute,
          expectedLeases: [
            expectedLease,
            ...(executionRoute.authority === "behavioral_write"
              ? [{ kind: "writer", workspaceRoot: agent.executionRoot ?? agent.workspaceRoot }]
              : []),
          ],
          assignedMessageIds,
          preparedInput: taskInput,
          turnOptions: preparedTurn.turnOptions ?? turnOptions,
          inspectionEvidence,
        });
        const admissionLease = nativeSessionRef == null
          ? acquireIntendedInstanceLease({
              ...identity,
              attemptId,
              route: executionRoute,
              harnessId: executionRoute.harnessId,
              instanceKey: executionRoute.instanceKey,
              capacityClass: `${V3_TURN_EVIDENCE_CLASS}:${jobId}`,
              capacityLimit: 1,
            })
          : acquireIntendedNativeSessionLease({
              ...identity,
              attemptId,
              route: executionRoute,
              harnessId: executionRoute.harnessId,
              instanceKey: executionRoute.instanceKey,
              nativeSessionId: nativeSessionRef.locator.sessionId,
            });
        leases = [admissionLease];
        if (executionRoute.authority === "behavioral_write") {
          leases.push(acquireIntendedWorkspaceWriterLease({
            ...identity,
            attemptId,
            route: executionRoute,
            workspaceRoot: agent.executionRoot ?? agent.workspaceRoot,
          }));
        }
        claim = bindLaunchClaimLeases({
          ...identity,
          attemptId,
          leases,
        });
      }
    } catch (error) {
      const durable = readLaunchClaim(identity);
      if (durable && durable.acceptance === "not_submitted" && durable.submissionState === "not_started") {
        rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
      } else if (!durable) {
        store.rollbackVersionThreeActivation(agentId, {
          jobId,
          removableMessageId: assignedMessageIds[0],
          rollbackClaim: null,
        });
        if (store.readAgent(agentId)) {
          store.rollbackReservation(agentId, { removableMessageId: assignedMessageIds[0] });
        }
      }
      throw error;
    }
    ensureJobStateDir(this.cwd);
    const logFile = resolveJobLogFile(this.cwd, jobId);
    const args = [
      CLI_PATH,
      "worker",
      "--cwd",
      this.cwd,
      "--job-id",
      jobId,
      "--agent-id",
      agentId,
      "--attempt-id",
      attemptId,
    ];
    // Turn-scoped effort is the only turn option this generation admits, and it
    // is a closed enum: it travels as one argument, never as free-form state.
    const effort = turnOptions?.effort ?? null;
    if (effort) args.push("--reasoning-effort", String(effort));
    const workerLog = this.launchDependencies.createWorkerLogStdio(logFile);
    let child = null;
    try {
      child = this.launchDependencies.spawn(process.execPath, args, {
        cwd: this.cwd,
        env: this.env,
        detached: true,
        stdio: /** @type {import("node:child_process").StdioOptions} */ (workerLog.stdio),
        windowsHide: true,
      });
      const observer = observeChild(child, () => {});
      const spawnOutcome = await observer.waitForSpawn();
      if (spawnOutcome.kind !== "spawned") {
        try { child.kill("SIGTERM"); } catch {}
        rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
        throw new Error(`Version-three worker for ${jobId} did not prove spawn; its prepared launch was rolled back.`);
      }
      const handoff = await waitForVersionThreeSubmissionFence(
        identity,
        observer,
        this.launchDependencies.versionThreeHandoffWaitMs ?? V3_SUBMISSION_HANDOFF_WAIT_MS,
      );
      await this.launchDependencies.afterVersionThreeHandoffWait?.({ identity, handoff });
      let durable = readLaunchClaim(identity);
      if (["rollback_in_progress", "rollback_complete"].includes(durable?.submissionState)) {
        rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
        throw new Error(`Version-three worker for ${jobId} completed rollback before native acceptance (${handoff.kind}).`);
      }
      if (durable?.acceptance === "acceptance_rejected" ||
          (durable?.acceptance === "not_submitted" && durable?.submissionState === "not_started")) {
        let rollbackWon = false;
        try {
          rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
          rollbackWon = true;
        } catch {
          durable = readLaunchClaim(identity);
        }
        if (rollbackWon) {
          try { child.kill("SIGTERM"); } catch {}
          throw new Error(`Version-three worker for ${jobId} rolled back before native acceptance (${handoff.kind}).`);
        }
      }
      if (["rollback_in_progress", "rollback_complete"].includes(durable?.submissionState)) {
        rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
        throw new Error(`Version-three worker for ${jobId} lost the handoff race to rollback (${handoff.kind}).`);
      }
      if (durable?.acceptance === "not_submitted" && durable?.submissionState === "started") {
        try {
          durable = recordLaunchAcceptanceUnknown({
            ...identity,
            attemptId,
            sanitizedDetail: "parent_handoff_observation_ended_after_submission_started",
          });
        } catch {
          durable = readLaunchClaim(identity);
        }
      }
      if (durable?.acceptance === "acceptance_rejected") {
        rollbackPreparedVersionThreeTurn({ cwd: this.cwd, ...identity, attemptId });
        try { child.kill("SIGTERM"); } catch {}
        throw new Error(`Version-three worker for ${jobId} rejected native acceptance and rolled back (${handoff.kind}).`);
      }
      if (!["acceptance_unknown", "acceptance_proven"].includes(durable?.acceptance)) {
        throw new Error(`Version-three worker for ${jobId} has no durable acceptance handoff (${handoff.kind}).`);
      }
      try { child.unref(); } catch {}
      appendLogLine(logFile, "Queued for detached version-three execution.");
      return Object.freeze({
        jobId,
        agentId,
        attemptId,
        ownerRootId,
        status: "queued",
        workspaceRoot: this.cwd,
        logFile,
      });
      } finally {
        try { workerLog.close?.(); } catch {}
      }
    } catch (error) {
      const explicit = String(error?.handoffDisposition ?? "");
      let disposition = HANDOFF_DISPOSITIONS.has(explicit)
        ? explicit
        : versionThreeHandoffDisposition(handoffIdentity);
      if (disposition === "rollback_safe" && handoffIdentity.attemptId) {
        let claim = null;
        try {
          claim = readLaunchClaim(handoffIdentity);
        } catch {
          disposition = "ownership_uncertain";
        }
        if (claim && claim.submissionState !== "rollback_complete") {
          try {
            rollbackPreparedVersionThreeTurn({
              cwd: this.cwd,
              ownerRootId: handoffIdentity.ownerRootId,
              agentId: handoffIdentity.agentId,
              jobId: handoffIdentity.jobId,
              attemptId: handoffIdentity.attemptId,
            });
          } catch {
            disposition = "ownership_uncertain";
          }
        }
      }
      throw withPreparedStartDisposition(error, disposition);
    }
  }

  async runWorker(jobId, options = {}) {
    const ownerRootId = this.assertOwnerRoot();
    const id = assertJobId(jobId);
    // A version-three handoff states its Agent and attempt on the command line
    // and carries no version-one job record at all.
    if (options.agentId || options.attemptId) {
      return runDetachedVersionThreeTurn({
        cwd: this.cwd,
        env: this.env,
        ownerRootId,
        agentId: assertWorkerIdentityText(options.agentId, "Version-three worker agent ID"),
        jobId: id,
        attemptId: assertWorkerIdentityText(options.attemptId, "Version-three worker attempt ID"),
        turnOptions: options.effort ? { effort: options.effort } : null,
        signal: options.signal ?? null,
      });
    }
    const stored = readJobFile(this.cwd, id);
    if (!stored) throw new Error(`No stored Claude job found for ${id}.`);
    if (jobOwnerRootId(stored) !== ownerRootId) {
      throw new Error(`Stored Claude job ${id} does not belong to the current Codex root scope.`);
    }
    const requiredQueueStatus = stored.harnessStateVersion === HARNESS_JOB_STATE_VERSION
      ? HARNESS_QUEUED_JOB_STATUS
      : "queued";
    if (stored.status !== requiredQueueStatus) {
      throw new Error(
        `Claude job ${id} is ${stored.status}; worker requires ${requiredQueueStatus}.`
      );
    }
    const progress = createProgressReporter({
      logFile: stored.logFile ?? resolveJobLogFile(this.cwd, id),
      onEvent: createJobProgressUpdater(this.cwd, id),
    });
    return runTrackedJob(stored, (onSpawn) => {
      if (
        stored.agentId && stored.route &&
        Array.isArray(stored.assignedMessageIds) && stored.assignedMessageIds.length > 0
      ) {
        return this.executeVersionOneAgentTurn(stored, onSpawn, progress);
      }
      const driver = this.assertJobDriver(stored);
      const launchContext = driver.revalidatePreparedPreflight(stored.readiness, {
        cwd: stored.executionRoot ?? stored.workspaceRoot,
        env: this.env,
        sourceRoot: this.sourceRoot,
      });
      return this.execute(stored, progress, onSpawn, launchContext);
    }, {
      logFile: stored.logFile,
      claimStatuses: [requiredQueueStatus],
    });
  }

  rollbackPreparedLeaseBundle(identity, attemptId) {
    let claim = readLaunchClaim(identity);
    if (!claim) return null;
    if (claim.submissionState === "rollback_complete") return claim;
    if (claim.submissionState !== "rollback_in_progress") {
      const eligibility = launchClaimRollbackEligibility(claim);
      if (!eligibility.eligible) return null;
      claim = beginPreSubmissionRollback({ ...identity, token: eligibility.token });
    }
    releaseLeasesForPreSubmissionRollback({ claim });
    return completePreSubmissionRollback({ ...identity, attemptId });
  }

  async executeVersionOneAgentTurn(job, onSpawn, onProgress = null) {
    const ownerRootId = this.assertOwnerRoot();
    const store = createAgentStore({
      cwd: this.cwd,
      ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
    });
    const agent = store.resolveTarget(job.agentId);
    if (
      agent.activeJobId !== job.id ||
      versionThreeRouteText(agent.route) !== versionThreeRouteText(job.route)
    ) {
      throw new Error(`Claude job ${job.id} no longer matches its immutable Agent activation.`);
    }
    const controlRoot = agent.workspaceRoot;
    const executionRoot = agent.executionRoot ?? controlRoot;
    if (
      (job.controlRoot ?? job.workspaceRoot) !== controlRoot ||
      (job.executionRoot ?? job.workspaceRoot) !== executionRoot
    ) {
      throw new Error(`Claude job ${job.id} roots no longer match its immutable Agent roots.`);
    }
    const identity = { ownerRootId, agentId: agent.agentId, jobId: job.id };
    const attemptId = `v1-${job.id}`;
    const driver = this.launchDependencies.resolveDriverV2(agent.route.harnessId, {
      env: this.env,
      jobStateRoot: controlRoot,
      sessionName: job.request?.sessionName ?? null,
      onProgress,
    });
    const executionRoute = agent.route;
    const inspectionEvidence = {
      generation: "unavailable",
      capabilities: executionRoute.capabilities,
    };
    const taskInput = String(job.request?.prompt ?? "");
    const turnOptions = executionRoute.effort == null ? null : { effort: executionRoute.effort };
    const preparedTurn = driver.prepareTurn({
      route: executionRoute,
      taskInput,
      turnOptions,
      turnId: job.id,
    });
    const storedNativeSessionRef = agent.nativeSessionRef == null
      ? null
      : Object.hasOwn(agent.nativeSessionRef, "locator")
        ? agent.nativeSessionRef
        : {
            version: NATIVE_REFERENCE_ENVELOPE_VERSION,
            harnessId: agent.nativeSessionRef.harnessId,
            driverVersion: executionRoute.driverVersion,
            instanceKey: agent.nativeSessionRef.instanceKey,
            locatorVersion: CLAUDE_LOCATOR_VERSION,
            locator: { sessionId: agent.nativeSessionRef.nativeSessionId },
          };
    const nativeSessionRef = storedNativeSessionRef == null
      ? null
      : validateNativeReferenceEnvelope(storedNativeSessionRef, {
          driver,
          kind: "session",
          route: executionRoute,
        });
    let claim = readLaunchClaim(identity);
    try {
      if (claim) {
        throw new Error(`Claude job ${job.id} recovered a prior launch claim without replay.`);
      }
      const expectedAdmission = nativeSessionRef == null
        ? {
            kind: "instance",
            capacityClass: `${V3_TURN_EVIDENCE_CLASS}:${job.id}`,
            capacityLimit: 1,
          }
        : { kind: "native_session", nativeSessionId: nativeSessionRef.locator.sessionId };
      claim = createLaunchIntent({
        ...identity,
        attemptId,
        lifecycleOwner: "version_one_supervisor",
        controlRoot,
        executionRoot,
        route: executionRoute,
        expectedLeases: [
          expectedAdmission,
          ...(executionRoute.authority === "behavioral_write"
            ? [{ kind: "writer", workspaceRoot: executionRoot }]
            : []),
        ],
        assignedMessageIds: job.assignedMessageIds,
        preparedInput: taskInput,
        turnOptions: preparedTurn.turnOptions ?? turnOptions,
        inspectionEvidence,
      });
      const leases = [nativeSessionRef == null
        ? acquireIntendedInstanceLease({
            ...identity,
            attemptId,
            route: executionRoute,
            harnessId: executionRoute.harnessId,
            instanceKey: executionRoute.instanceKey,
            capacityClass: `${V3_TURN_EVIDENCE_CLASS}:${job.id}`,
            capacityLimit: 1,
          })
        : acquireIntendedNativeSessionLease({
            ...identity,
            attemptId,
            route: executionRoute,
            harnessId: executionRoute.harnessId,
            instanceKey: executionRoute.instanceKey,
            nativeSessionId: nativeSessionRef.locator.sessionId,
          })];
      if (executionRoute.authority === "behavioral_write") {
        leases.push(acquireIntendedWorkspaceWriterLease({
          ...identity,
          attemptId,
          route: executionRoute,
          workspaceRoot: executionRoot,
        }));
      }
      claim = bindLaunchClaimLeases({ ...identity, attemptId, leases });
    } catch (error) {
      this.rollbackPreparedLeaseBundle(identity, attemptId);
      throw error;
    }

    let launched;
    try {
      launched = await launchVersionThreeTurn({
        ...identity,
        attemptId,
        lifecycleOwner: "version_one_supervisor",
        route: executionRoute,
        driver,
        preparedTurn,
        preparedInput: taskInput,
        assignedMessageIds: job.assignedMessageIds,
        assignedInputs: [],
        leaseBindings: claim.leaseBindings.map((binding) => ({ ...binding, route: claim.route })),
        turnOptions: preparedTurn.turnOptions ?? turnOptions,
        nativeSessionRef,
        controlRoot,
        executionRoot,
        env: this.env,
      });
    } catch (error) {
      const durable = readLaunchClaim(identity);
      const eligibility = durable == null ? null : launchClaimRollbackEligibility(durable);
      if (eligibility?.eligible || durable?.submissionState === "rollback_in_progress") {
        this.rollbackPreparedLeaseBundle(identity, attemptId);
        throw error;
      }
      return {
        terminalStatus: "unknown",
        exitStatus: 1,
        threadId: null,
        turnId: null,
        payload: { status: "unknown", reason: "native_acceptance_unknown" },
        rendered: "Native acceptance is unknown; authority leases remain held.",
        summary: "Native acceptance unknown",
      };
    }

    const locator = launched.liveTurn.nativeTurnRef?.locator ?? {};
    if (onSpawn({ pid: locator.pid, pidIdentity: locator.processIdentity }) !== true) {
      try { await launched.liveTurn.dispose(); } catch {}
      return {
        terminalStatus: "unknown",
        exitStatus: 1,
        threadId: null,
        turnId: null,
        payload: { status: "unknown", reason: "native_process_identity_not_published" },
        rendered: "Native process ownership is unknown; authority leases remain held.",
        summary: "Native process ownership unknown",
      };
    }
    let turn;
    try {
      turn = validateNormalizedTerminalResult(await launched.liveTurn.result, {
        driver,
        route: executionRoute,
      });
    } catch (error) {
      try { await launched.liveTurn.dispose(); } catch {}
      return {
        terminalStatus: "unknown",
        exitStatus: 1,
        threadId: null,
        turnId: null,
        payload: { status: "unknown", reason: "terminal_evidence_invalid" },
        rendered: "Terminal evidence is unknown; authority leases remain held.",
        summary: "Terminal evidence unknown",
      };
    }
    const release = releaseLeasesOnSettlement({
      normalizedTerminalResult: turn,
      releases: buildLeaseReleaseTargets(
        claim.leaseBindings.map((binding) => ({ ...binding, route: claim.route }))
      ),
    });
    try { await launched.liveTurn.dispose(); } catch {}
    if (release.outcome !== "all") {
      return {
        terminalStatus: "unknown",
        exitStatus: 1,
        threadId: null,
        turnId: null,
        payload: { status: "unknown", reason: `lease_release_${release.outcome}` },
        rendered: "Terminal settlement did not release the complete authority bundle.",
        summary: "Authority settlement unknown",
      };
    }
    const nativeSession = turn.continuation.nativeSessionRef;
    const sessionId = nativeSession?.locator?.sessionId ?? null;
    return {
      terminalStatus: turn.status,
      exitStatus: turn.status === "completed" ? 0 : 1,
      threadId: sessionId,
      turnId: null,
      payload: {
        status: turn.status,
        sessionId,
        rawOutput: turn.finalMessage ?? "",
        partialOutput: turn.finalMessage ?? "",
        failureClass: turn.failure.class,
        failureReason: turn.failure.reason,
        resumable: turn.failure.resumable,
        requiresAttention: Boolean(turn.failure.requiresAttention),
        recoveryAttempts: turn.metrics?.plugin_observed?.recovery_attempt_count ?? 0,
        metrics: turn.metrics,
        harnessId: turn.harnessId,
        driverVersion: turn.driverVersion,
        nativeSessionRef: nativeSession,
        sessionExactness: nativeSession == null ? "unproven" : "exact",
        driverReceipt: turn.driverReceipt,
        normalizedTerminalResult: turn,
        runtimeReceipt: {
          environment: this.environmentReceipt,
          workspaceRoot: executionRoot,
          sourceRoot: this.sourceRoot,
          leaseRelease: release,
        },
      },
      rendered: renderTaskResult({
        rawOutput: turn.finalMessage ?? "",
        failureReason: turn.failure.reason,
        failureMessage: turn.failure.detail,
      }),
      summary: summaryOf(turn.finalMessage || turn.failure.reason || job.summary),
    };
  }

  /**
   * Run one prepared turn through this job's immutable Driver route. Native
   * protocol, prompt envelope, recovery, and failure detection stay behind the
   * Driver; the supervisor only normalizes the terminal result into its own
   * durable receipt.
   */
  async execute(job, onProgress, onSpawn, launchContext) {
    const request = job.request ?? {};
    const driver = this.assertJobDriver(job);
    const executionRoot = job.executionRoot ?? job.workspaceRoot;
    const turn = validateHarnessTurnResult(await driver.startTurn({
      workspaceRoot: executionRoot,
      cwd: executionRoot,
      jobId: job.id,
      prompt: request.prompt,
      route: {
        profile: request.profile,
        write: request.write,
        model: request.model,
        effort: request.effort,
        permissionMode: request.permissionMode,
        dangerouslySkipPermissions: request.dangerouslySkipPermissions,
        allowedTools: request.allowedTools,
        delegationMode: request.delegationMode,
      },
      env: this.env,
      launchContext,
      sessionName: request.sessionName ?? undefined,
      resumeSessionId: request.resumeSessionId ?? undefined,
      onProgress,
      onSpawn,
    }), driver);
    const rawOutput = String(turn.finalMessage ?? "");
    const nativeSessionId = turn.nativeSession?.nativeSessionId ?? null;
    const receipts = turn.receipts ?? {};
    const payload = {
      status: turn.status,
      sessionId: nativeSessionId,
      rawOutput,
      partialOutput: rawOutput,
      warning: turn.warning ?? null,
      failureClass: turn.failure.class ?? null,
      failureReason: turn.failure.reason ?? null,
      resumable: turn.failure.resumable === true,
      recoveryAttempts: receipts.recoveryAttempts ?? 0,
      attempts: receipts.attempts ?? [],
      steering: receipts.steering ?? null,
      lastByteAt: turn.lastActivityAt ?? null,
      manualResumeCommand: turn.manualContinuationCommand ?? null,
      requiresAttention: Boolean(turn.failure.requiresAttention),
      assistantOutputObserved: receipts.assistantOutputObserved === true,
      toolUses: receipts.toolUses ?? [],
      touchedFiles: receipts.touchedFiles ?? [],
      metrics: turn.metrics ?? null,
      harnessId: turn.harnessId,
      driverVersion: turn.driverVersion,
      nativeSessionRef: turn.nativeSession,
      sessionExactness: turn.sessionExactness,
      driverReceipt: turn.driverReceipt,
      runtimeReceipt: {
        ...(turn.runtime ?? {}),
        environment: this.environmentReceipt,
        workspaceRoot: executionRoot,
        sourceRoot: this.sourceRoot,
      },
    };
    return {
      exitStatus: turn.exitStatus,
      threadId: nativeSessionId,
      turnId: null,
      payload,
      rendered: renderTaskResult({
        rawOutput,
        failureReason: turn.failure.reason,
        failureMessage: turn.failure.detail,
      }),
      summary: summaryOf(rawOutput || turn.failure.reason || job.summary),
    };
  }

  /**
   * Deliver supervisor-assigned input to an already-running turn. A Driver
   * whose persisted snapshot admits only the initial prompt refuses here rather
   * than letting the supervisor claim an unproven active delivery.
   */
  assignInput(job, text, options = {}) {
    const driver = this.assertJobDriver(job);
    assertHarnessCapability(
      job?.harnessCapabilities ?? driver.capabilities,
      "activeInput",
      ["acknowledged_active_stream"],
      `Harness ${driver.harnessId} does not accept input for a running turn`
    );
    return driver.assignInput({
      cwd: this.cwd,
      jobId: job.id,
      text,
      kind: options.kind,
      messageId: options.messageId,
    });
  }

  /**
   * Resolve the Driver a durable turn was launched with. A record naming
   * another Harness, Driver version, or capability vocabulary fails closed
   * instead of being executed by the currently registered Driver.
   */
  assertJobDriver(job, options = {}) {
    const stateVersion = job?.harnessStateVersion;
    if (stateVersion != null && stateVersion !== HARNESS_JOB_STATE_VERSION) {
      throw new Error(
        `Claude job ${job.id} carries Harness state version ${stateVersion}; ` +
        `this runtime owns version ${HARNESS_JOB_STATE_VERSION}.`
      );
    }
    const harnessId = legacyRecordHarnessId(job);
    const driver = this.driverForHarness(harnessId);
    const driverVersion = nonEmptyString(job?.driverVersion);
    // Stopping a live turn must stay possible across a Driver version bump:
    // process control needs the Harness and its interrupt capability, not an
    // identical Driver build. Executing or steering a turn still requires one.
    if (
      options.allowDriverVersionDrift !== true &&
      driverVersion &&
      driverVersion !== driver.driverVersion
    ) {
      throw new Error(
        `Harness job ${job.id} was prepared by Driver ${driverVersion}; this runtime provides ${driver.driverVersion}.`
      );
    }
    if (job?.harnessCapabilities != null) {
      // An unknown capability name or value always fails here. A snapshot that
      // parses but disagrees with the resolved Driver means the record was
      // written by a contract this process cannot execute; process control
      // instead judges the persisted snapshot on its own terms.
      const persisted = validateHarnessCapabilities(
        job.harnessCapabilities,
        `Claude job ${job.id} capability snapshot`
      );
      for (const name of options.allowDriverVersionDrift === true ? [] : HARNESS_CAPABILITY_NAMES) {
        if (persisted[name] !== driver.capabilities[name]) {
          throw new Error(
            `Harness job ${job.id} was prepared with ${name}=${persisted[name]}; ` +
            `this runtime provides ${name}=${driver.capabilities[name]}.`
          );
        }
      }
    }
    return driver;
  }

  steer(jobId, message) {
    const job = this.status(jobId);
    if (!ACTIVE_JOB_STATUSES.has(job.status) || job.status === "cancelling" || job.status === "interrupting") {
      throw new Error(`Claude job ${job.id} is ${job.status}; use followUp for a resumable terminal job.`);
    }
    const queued = this.assignInput(job, message);
    return {
      jobId: job.id,
      status: job.status,
      sequence: queued.sequence,
      mode: "durable_stream_input",
      steering: getSteeringSnapshot(this.cwd, job.id),
    };
  }

  async followUp(jobId, message, options = {}) {
    const source = this.status(jobId);
    const recoverability = source.recoverability ?? null;
    if (!recoverability?.resumable || recoverability.mode !== "exact_session") {
      throw new Error(
        `Claude job ${source.id} is not explicitly resumable: ${recoverability?.reason ?? source.status}.`
      );
    }
    const sessionId = recoverability.exactSessionId ?? resultSessionId(source);
    if (!sessionId) throw new Error(`Claude job ${source.id} has no owner-valid exact Claude session to resume.`);
    const request = readJobFile(this.cwd, source.id)?.request ?? {};
    return this.start(message, {
      // A resumed turn belongs to the Harness its own source job recorded.
      harnessId: options.harnessId ?? legacyRecordHarnessId(source),
      write: options.write ?? source.write,
      profile: options.profile ?? request.profile ?? source.profile,
      model: options.model ?? request.model,
      effort: options.effort ?? request.effort,
      permissionMode: options.permissionMode ?? request.permissionMode,
      dangerouslySkipPermissions:
        options.dangerouslySkipPermissions ?? request.dangerouslySkipPermissions,
      allowedTools: options.allowedTools ?? request.allowedTools,
      delegationMode: options.delegationMode ?? request.delegationMode,
      sessionName: options.sessionName ?? request.sessionName,
      resumeSessionId: sessionId,
      parentJobId: source.id,
      title: "Claude Code Follow-up",
    });
  }

  async interrupt(jobId) {
    const job = this.status(jobId);
    const stored = readJobFile(this.cwd, job.id) ?? job;
    const driver = this.assertJobDriver(stored, { allowDriverVersionDrift: true });
    assertHarnessCapability(
      stored.harnessCapabilities ?? driver.capabilities,
      "interrupt",
      ["graceful_flush_proven", "best_effort_signal"],
      `Harness ${driver.harnessId} cannot interrupt an active turn`
    );
    const transition = transitionJob(this.cwd, job.id, ["running"], "interrupting", {
      acceptingSteering: false,
      phase: "interrupting",
    });
    if (!transition.transitioned) throw new Error(`Claude job ${job.id} is no longer running.`);

    /** @type {{ interrupted: boolean, note?: string, controlFailure?: string, forced?: boolean }} */
    let receipt = {
      interrupted: false,
      note: "Interrupt request has no terminal evidence yet.",
      controlFailure: "no_process_identity",
    };
    if (stored.pid) {
      if (!stored.pidIdentity) {
        receipt = {
          interrupted: false,
          note: "Refusing to signal a process without a PID identity.",
          controlFailure: "missing_identity",
        };
      } else {
        try {
          receipt = await driver.interruptTurn({
            pid: stored.pid,
            pidIdentity: stored.pidIdentity,
          });
        } catch {
          receipt = {
            interrupted: false,
            note: "Native interrupt request failed.",
            controlFailure: "driver_error",
          };
        }
      }
    }
    if (!receipt.interrupted) {
      transitionJob(this.cwd, job.id, ["interrupting"], "running", {
        phase: "interrupt_failed",
        acceptingSteering: true,
      });
    }
    const current = readJobFile(this.cwd, job.id) ?? job;
    return {
      jobId: job.id,
      interrupted: current.status === "interrupted",
      status: current.status,
      sessionId: resultSessionId(current),
      forced: false,
      note: receipt.note ?? null,
    };
  }



  result(jobId = null) {
    const jobs = this.list();
    const job = jobId
      ? resolveJob(jobs, jobId)
      : jobs.find((candidate) => TERMINAL_STATUSES.has(candidate.status));
    if (!job) throw new Error("No finished Claude jobs found for this workspace.");
    return {
      state: TERMINAL_STATUSES.has(job.status) ? "terminal" : "active",
      job,
      result: job.result ?? null,
    };
  }

  async wait(jobId, options = {}) {
    const ownerRootId = this.assertOwnerRoot();
    const requestedTimeout = options.timeoutMs == null ? 30_000 : Number(options.timeoutMs);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
      throw new Error("wait timeoutMs must be a non-negative finite number.");
    }
    const timeoutMs = requestedTimeout;
    const signal = options.signal ?? null;
    throwIfWaitAborted(signal);
    const acknowledgeTokens = Array.isArray(options.acknowledgeTokens)
      ? options.acknowledgeTokens
      : [];
    const wakeOnProgress = options.wakeOnProgress === true;
    const targetJobIds = Array.isArray(options.targetJobIds)
      ? [...new Set(options.targetJobIds.map((value) => assertJobId(value)))]
      : null;
    if (targetJobIds?.length === 0) throw new Error("Targeted wait requires at least one job ID.");
    if (wakeOnProgress && targetJobIds != null && targetJobIds.length !== 1) {
      throw new Error("Targeted progress wait requires exactly one job ID.");
    }
    const resolveProgressJobIds = () => {
      const values = typeof options.progressJobIds === "function"
        ? options.progressJobIds()
        : options.progressJobIds;
      return Array.isArray(values)
        ? [...new Set(values.map((value) => assertJobId(value)))]
        : null;
    };
    const acknowledgement = acknowledgeTokens.length > 0
      ? acknowledgeAgentCompletionEvents(this.cwd, ownerRootId, acknowledgeTokens)
      : { acknowledgedCount: 0, acknowledgedThrough: null, compactedCount: 0 };
    const now = this.waitDependencies.now;
    const deadline = now() + timeoutMs;
    let job = jobId ? this.status(jobId) : null;
    let inbox = { events: [] };
    let selectedProgress = null;
    let waitDiagnostics = null;
    let durableReadCount = 0;
    const noteRead = (kind) => {
      durableReadCount += 1;
      this.waitDependencies.onRead?.(kind);
    };
    const targetBarrierReady = () => targetJobIds == null || targetJobIds.every((id) => {
      // A version-three-worker job has no version-one file; its status lives in
      // the version-three record. "running" stays not-ready either way, and a
      // settled "unknown" is joinable terminal evidence in both stores.
      const status = readJobFile(this.cwd, id)?.status
        ?? versionThreeJobStatus(this.assertOwnerRoot(), id);
      return TERMINAL_STATUSES.has(status);
    });
    const desiredWatchPaths = () => [
      resolveCompletionInboxDir(this.cwd, ownerRootId),
      ...(wakeOnProgress || targetJobIds ? [resolveJobsDirForObservation(this.cwd)] : []),
      ...(wakeOnProgress || targetJobIds ? [resolveVersionThreeJobDirectory({ ownerRootId })] : []),
    ];
    const observe = () => {
      noteRead("completion");
      inbox = targetJobIds == null
        ? readUnreadAgentCompletionSummaries(this.cwd, ownerRootId)
        : (targetBarrierReady()
          ? readTargetedAgentCompletionSummaries(this.cwd, ownerRootId, targetJobIds, { freeze: false })
          : { events: [], consumed: [] });
      selectedProgress = null;
      if (inbox.events.length > 0) return;
      if (targetJobIds != null && targetBarrierReady()) return;
      const progress = wakeOnProgress
        ? pendingPublicProgress(
            this.cwd,
            ownerRootId,
            jobId,
            targetJobIds ?? resolveProgressJobIds()
          )
        : null;
      if (!progress) return;
      // Completion is authoritative and always wins a race with advisory
      // progress. Recheck immediately before advancing the progress revision.
      noteRead("completion");
      inbox = targetJobIds == null
        ? readUnreadAgentCompletionSummaries(this.cwd, ownerRootId)
        : (targetBarrierReady()
          ? readTargetedAgentCompletionSummaries(this.cwd, ownerRootId, targetJobIds, { freeze: false })
          : { events: [], consumed: [] });
      if (inbox.events.length > 0 || (targetJobIds != null && targetBarrierReady())) return;
      const progressSource = /** @type {{source?: string}} */ (progress).source;
      if (progressSource === "v3") {
        const record = claimVersionThreeProgress({ generation: FUTURE_WRITE_GENERATION, ownerRootId,
          agentId: progress.agentId, jobId: progress.jobId });
        if (record.status === "running" && record.progress?.revision === progress.progress.revision &&
            record.progressDeliveredRevision === progress.progress.revision) selectedProgress = progress;
      } else {
        const claimed = claimJobPublicProgress(this.cwd, progress.jobId);
        if (claimed.claimed && claimed.job) {
          selectedProgress = projectPublicProgress(claimed.job, ownerRootId, jobId, {
            requirePending: false,
          });
        }
      }
    };
    observe();
    while (true) {
      throwIfWaitAborted(signal);
      if (inbox.events.length > 0 || selectedProgress || (targetJobIds != null && targetBarrierReady())) break;
      job = jobId ? this.status(jobId) : null;
      if ((job && !ACTIVE_JOB_STATUSES.has(job.status)) || now() >= deadline) break;
      let postRegistration = false;
      waitDiagnostics = await waitForDurableActivity({
        desiredPaths: desiredWatchPaths(),
        stateRoot: resolvePluginStateRoot(),
        signal,
        deadline,
        ...this.waitDependencies,
        afterRegister: () => {
          observe();
          postRegistration = inbox.events.length > 0 ||
            Boolean(selectedProgress) ||
            (targetJobIds != null && targetBarrierReady());
          return postRegistration;
        },
      });
      if (typeof this.waitDependencies.onWake === "function") {
        waitDiagnostics.durableReadCount = durableReadCount;
        this.waitDependencies.onWake(waitDiagnostics);
      }
      if (!postRegistration) observe();
    }
    const update = targetJobIds == null
      ? (inbox.events[0] ?? selectedProgress ?? null)
      : (wakeOnProgress ? selectedProgress : null);
    const targetReady = targetJobIds != null && targetBarrierReady();
    const waitTimedOut = targetJobIds != null
      ? !targetReady && update == null
      : update == null && (!job || ACTIVE_JOB_STATUSES.has(job.status));
    return {
      // The public Agent runtime intentionally does not expose the internal
      // acknowledgement receipt; it only needs the next delivery token.
      update,
      targetReady,
      acknowledgement,
      waitTimedOut,
      message: waitTimedOut
        ? "Timed out waiting for HarnessDock Agent activity."
        : update?.kind === "progress"
          ? "HarnessDock Agent progress is available."
          : "HarnessDock Agent completion is available.",
    };
  }
}

export function createInternalAgentRuntime(options = {}) {
  return new InternalAgentRuntime(options);
}
