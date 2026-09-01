/** SPDX-License-Identifier: Apache-2.0 */
/** Detached, receipt-bound owner for durable worker and native residency. */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentStore, resolveAgentRegistryDirectory } from "./agent-store.mjs";
import { waitForDurableActivity } from "./durable-activity-wakeup.mjs";
import {
  assertVersionThreeWriteAllowed, FUTURE_WRITE_GENERATION, versionThreeRouteText,
} from "./durable-state-v3.mjs";
import { resolveDriverV2 } from "./harness-registry.mjs";
import { releaseExactLeasesForHardReclaim } from "./instance-admission-lease.mjs";
import {
  LAUNCH_CLAIM_SCHEMA_VERSION,
  listAllLaunchClaims,
  readLaunchClaim,
  recordLaunchAcceptanceUnknown,
  resolveLaunchClaimDirectory,
} from "./launch-claim.mjs";
import { sameNativeReference } from "./native-reference.mjs";
import { createOpencodeServiceManager } from "./opencode-service-manager.mjs";
import { resolvePluginRuntimeRoot, resolvePluginStateRoot } from "./paths.mjs";
import { getProcessIdentity, isProcessAlive, terminateProcessTree, validateProcessIdentity } from "./process-control.mjs";
import { reconcileVersionThreeWorkerLoss } from "./v3-turn-reconciliation.mjs";
import {
  V3_JOB_SCHEMA_VERSION,
  claimVersionThreeHardReclaim,
  commitVersionThreeHardReclaim,
  listAllVersionThreeJobRecords,
  markVersionThreeHardReclaimTerminationAttempted,
  readVersionThreeJobRecord,
  recordVersionThreeHardReclaimFailure,
  recordVersionThreeHardReclaimLeasePending,
  recordVersionThreeHardReclaimPhysicalDeath,
  recordVersionThreePreRecordUncertain,
  recordVersionThreeTurnUncertain,
  reconcileVersionThreeHardReclaimJob,
  resolveVersionThreeJobDirectory,
  updateCommittedVersionThreeHardReclaim,
} from "./v3-job-store.mjs";
import { recoverStaleDirectoryLock, sameFileIdentity } from "./durable-directory-lock.mjs";

export const UNKNOWN_RECLAIM_MS = 3_600_000;
const RECEIPT_VERSION = 2;
const READY_WAIT_MS = 2_000;
const RECOVERY_WAKE_MS = 10_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();

export function resolveResidencyManagerPaths(options = {}) {
  const stateRoot = path.resolve(options.stateRoot ?? resolvePluginStateRoot());
  const runtimeRoot = path.resolve(options.runtimeRoot ?? resolvePluginRuntimeRoot());
  const directory = path.join(runtimeRoot, "residency-manager");
  return Object.freeze({
    stateRoot, runtimeRoot, directory,
    receiptFile: path.join(directory, "receipt.json"),
    lockFile: path.join(directory, ".lock"),
    stateRootDigest: digest(stateRoot), runtimeRootDigest: digest(runtimeRoot),
  });
}

function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function dependencies(options) {
  const test = options._test ?? {};
  return {
    now: test.now ?? (() => Date.now()),
    spawn: test.spawn ?? options.spawn ?? spawn,
    getIdentity: test.getIdentity ?? getProcessIdentity,
    isAlive: test.isAlive ?? isProcessAlive,
    validateIdentity: test.validateIdentity ?? validateProcessIdentity,
    sleep: test.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    terminationWaitMs: test.terminationWaitMs ?? (options._test ? 0 : 5_000),
    readyWaitMs: test.readyWaitMs ?? READY_WAIT_MS,
    listJobs: test.listJobs ?? listAllVersionThreeJobRecords,
    listClaims: test.listClaims ?? listAllLaunchClaims,
    readJob: test.readJob ?? readVersionThreeJobRecord,
    readClaim: test.readClaim ?? readLaunchClaim,
    recordAcceptanceUnknown: test.recordAcceptanceUnknown ?? recordLaunchAcceptanceUnknown,
    recordPreRecordUnknown: test.recordPreRecordUnknown ?? recordVersionThreePreRecordUncertain,
    agentOwns: test.agentOwns ?? defaultAgentOwns,
    resolveDriver: test.resolveDriver ?? resolveDriverV2,
    reconcileWorkerLoss: test.reconcileWorkerLoss ?? reconcileVersionThreeWorkerLoss,
    recordWorkerLostUncertain: test.recordWorkerLostUncertain ?? recordVersionThreeTurnUncertain,
    terminate: test.terminate ?? terminateProcessTree,
    releaseLeases: test.releaseLeases ?? releaseExactLeasesForHardReclaim,
    claimHardReclaim: test.claimHardReclaim ?? claimVersionThreeHardReclaim,
    markTerminationAttempted: test.markTerminationAttempted ?? markVersionThreeHardReclaimTerminationAttempted,
    recordReclaimFailure: test.recordReclaimFailure ?? recordVersionThreeHardReclaimFailure,
    recordPhysicalDeath: test.recordPhysicalDeath ?? recordVersionThreeHardReclaimPhysicalDeath,
    recordLeasePending: test.recordLeasePending ?? recordVersionThreeHardReclaimLeasePending,
    commitHardReclaim: test.commitHardReclaim ?? commitVersionThreeHardReclaim,
    updateCommittedDisposition: test.updateCommittedDisposition ?? updateCommittedVersionThreeHardReclaim,
    reconcileHardReclaim: test.reconcileHardReclaim ?? ((record) =>
      reconcileVersionThreeHardReclaimJob({ generation: FUTURE_WRITE_GENERATION, record })),
    waitForActivity: test.waitForActivity ?? waitForDurableActivity,
  };
}

function receiptMatches(value, paths, deps) {
  return value?.version === RECEIPT_VERSION && value.generation === FUTURE_WRITE_GENERATION &&
    value.stateRootDigest === paths.stateRootDigest && value.runtimeRootDigest === paths.runtimeRootDigest &&
    Number.isSafeInteger(value.pid) && typeof value.identity === "string" &&
    deps.isAlive(value.pid) && deps.validateIdentity(value.pid, value.identity);
}

function acquireLaunchLock(paths, deps) {
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  recoverStaleDirectoryLock(paths.lockFile, { isProcessAlive: deps.isAlive, validateProcessIdentity: deps.validateIdentity });
  const token = randomBytes(16).toString("hex");
  const candidate = `${paths.lockFile}.${process.pid}.${token}.candidate`;
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: deps.getIdentity(process.pid), token, timestamp: Date.now() }));
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    fs.linkSync(candidate, paths.lockFile);
    return { lockFile: paths.lockFile, token, stat };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(candidate); } catch {}
  }
}

function releaseLaunchLock(lock) {
  if (!lock) return;
  try {
    const stat = fs.statSync(lock.lockFile);
    if (sameFileIdentity(lock.stat, stat) && read(lock.lockFile)?.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch {}
}

async function waitForReceipt(paths, deps, pid = null) {
  const deadline = deps.now() + deps.readyWaitMs;
  while (deps.now() <= deadline) {
    const value = read(paths.receiptFile);
    if ((pid == null || value?.pid === pid) && receiptMatches(value, paths, deps)) return value;
    if (pid != null && !deps.isAlive(pid)) break;
    await deps.sleep(Math.min(20, Math.max(1, deadline - deps.now())));
  }
  return null;
}

/** Start one manager or join the exact ready singleton selected by the launch lock. */
export async function ensureResidencyManager(options = {}) {
  const paths = resolveResidencyManagerPaths(options);
  const deps = dependencies(options);
  let lock = null;
  try {
    lock = acquireLaunchLock(paths, deps);
  } catch (error) {
    if (error?.code !== "EEXIST") return Object.freeze({ started: false, pid: null });
    const existing = await waitForReceipt(paths, deps);
    return Object.freeze({ started: false, pid: existing?.pid ?? null });
  }
  try {
    const existing = read(paths.receiptFile);
    if (receiptMatches(existing, paths, deps)) return Object.freeze({ started: false, pid: existing.pid });
    const entry = options.entry ?? fileURLToPath(new URL("./residency-manager.mjs", import.meta.url));
    const child = deps.spawn(process.execPath, [entry, "--run"], {
      cwd: options.cwd ?? process.cwd(), detached: true, stdio: "ignore", shell: false,
      env: { ...process.env, ...(options.env ?? {}),
        ...(options.envFile ? { CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: options.envFile } : {}),
        CODEX_HARNESSDOCK_RESIDENCY_RUNTIME_ROOT: paths.runtimeRoot,
        CODEX_HARNESSDOCK_RESIDENCY_STATE_ROOT: paths.stateRoot },
    });
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1 || !await waitForReceipt(paths, deps, child.pid)) {
      return Object.freeze({ started: false, pid: null });
    }
    child.unref?.();
    return Object.freeze({ started: true, pid: child.pid });
  } finally {
    releaseLaunchLock(lock);
  }
}

function processState(value, deps) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.identity !== "string" || !value.identity) return "incomplete";
  if (!deps.isAlive(value.pid)) return "dead";
  return deps.validateIdentity(value.pid, value.identity) ? "exact_live" : "identity_mismatch";
}

export function hardReclaimDeadline(record) {
  const recordedAt = Date.parse(record?.uncertainty?.recordedAt ?? "");
  return Number.isFinite(recordedAt) ? recordedAt + UNKNOWN_RECLAIM_MS : null;
}

function sameRoute(left, right) {
  try { return versionThreeRouteText(left, "Residency route") === versionThreeRouteText(right, "Residency claim route"); }
  catch { return false; }
}

function defaultAgentOwns(record, { allowFinalizedHardReclaim = false } = {}) {
  try {
    const store = createAgentStore({ cwd: record.controlRoot, ownerRootId: record.ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
    const agent = store.readAgent(record.agentId);
    const ownership = store.readVersionThreeTurnOwnership(record.agentId);
    const exactRoute = agent?.version === 3 && agent.executionRoot === record.executionRoot && sameRoute(agent.route, record.route);
    const active = agent?.activeJobId === record.jobId && agent.status === "running" &&
      (ownership == null || (ownership.jobId === record.jobId && ownership.attemptId === record.attemptId));
    const finalized = allowFinalizedHardReclaim && record.status === "hard_reclaimed" &&
      record.hardReclaim?.phase === "committed" && agent?.activeJobId == null && agent.latestJobId === record.jobId &&
      agent.status === "errored" && ownership == null && agent.continuation?.mode === "blocked" &&
      agent.continuation?.evidence?.reason === "worker_lost" &&
      agent.continuation?.evidence?.jobId === record.jobId &&
      agent.continuation?.evidence?.attemptId === record.attemptId;
    return exactRoute && (active || finalized);
  } catch { return false; }
}

function exactBinding(record, deps, options = {}) {
  if (record?.version !== V3_JOB_SCHEMA_VERSION || record.harnessStateVersion !== 3 ||
      !record.worker || !record.physicalResidency || !deps.agentOwns(record, options)) return null;
  let claim;
  try { claim = deps.readClaim(record); } catch { return null; }
  if (!claim || claim.version !== LAUNCH_CLAIM_SCHEMA_VERSION || claim.lifecycleOwner !== "version_three_worker" ||
      claim.attemptId !== record.attemptId || claim.submissionState !== "started" || claim.leaseState !== "acquired" ||
      claim.controlRoot !== record.controlRoot || claim.executionRoot !== record.executionRoot ||
      !sameRoute(claim.route, record.route) || JSON.stringify(claim.worker) !== JSON.stringify(record.worker) ||
      JSON.stringify(claim.physicalResidency) !== JSON.stringify(record.physicalResidency)) return null;
  const nativeRef = claim.acceptance === "acceptance_proven" ? claim.nativeTurnRef
    : claim.acceptance === "acceptance_unknown" ? claim.provisionalNativeTurnRef : null;
  try {
    if (!nativeRef || !sameNativeReference(nativeRef, record.nativeTurnRef, "Residency native turn")) return null;
  } catch { return null; }
  return claim;
}

function transitionInput(record) {
  return { generation: FUTURE_WRITE_GENERATION, ownerRootId: record.ownerRootId, agentId: record.agentId,
    jobId: record.jobId, attemptId: record.attemptId };
}

async function finalObservation(record, deps) {
  try {
    const driver = deps.resolveDriver(record.route.harnessId);
    await deps.reconcileWorkerLoss({ ...transitionInput(record), driver });
  } catch {}
  try { return deps.readJob(record); } catch { return null; }
}

function jobIdentityKey(value) {
  return `${value.ownerRootId}\0${value.agentId}\0${value.jobId}`;
}

function durableWatchRoot(paths) {
  return path.dirname(paths.stateRoot) === path.dirname(paths.runtimeRoot)
    ? path.dirname(paths.stateRoot)
    : paths.stateRoot;
}

function addDurableWatchPath(targets, candidate, paths) {
  const root = durableWatchRoot(paths);
  const relative = path.relative(root, path.resolve(candidate));
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))) targets.add(candidate);
}

function preRecordClaimIsActive(claim) {
  return claim?.version === LAUNCH_CLAIM_SCHEMA_VERSION && claim.lifecycleOwner === "version_three_worker" &&
    claim.submissionState === "started" && ["not_submitted", "acceptance_unknown", "acceptance_proven"].includes(claim.acceptance);
}

function preRecordClaimIsComplete(claim) {
  return preRecordClaimIsActive(claim) && claim.worker != null && claim.physicalResidency != null &&
    claim.provisionalNativeTurnRef != null && claim.controlRoot != null && claim.executionRoot != null;
}

/** Recover the durable bind-to-running crash window without replaying native input. */
function recoverPreRecordClaims(claimSnapshot, records, deps) {
  let obligations = (claimSnapshot.unreadable?.length ?? 0) > 0;
  const existing = new Set(records.map(jobIdentityKey));
  for (const claim of claimSnapshot.records ?? []) {
    if (existing.has(jobIdentityKey(claim)) || !preRecordClaimIsActive(claim)) continue;
    obligations = true;
    if (!preRecordClaimIsComplete(claim)) continue;
    const worker = processState(claim.worker, deps);
    if (worker !== "dead") continue;
    const nativeTurnRef = claim.acceptance === "acceptance_proven" ? claim.nativeTurnRef : claim.provisionalNativeTurnRef;
    const candidate = { ...claim, status: "running", route: claim.route, nativeTurnRef,
      physicalResidency: claim.physicalResidency, worker: claim.worker };
    if (!nativeTurnRef || !deps.agentOwns(candidate)) continue;
    try {
      const recoveredClaim = claim.acceptance === "not_submitted"
        ? deps.recordAcceptanceUnknown({ ownerRootId: claim.ownerRootId, agentId: claim.agentId, jobId: claim.jobId,
          attemptId: claim.attemptId, sanitizedDetail: null })
        : claim;
      const record = deps.recordPreRecordUnknown({
        generation: FUTURE_WRITE_GENERATION, ownerRootId: recoveredClaim.ownerRootId,
        agentId: recoveredClaim.agentId, jobId: recoveredClaim.jobId, attemptId: recoveredClaim.attemptId,
        workspaceRoot: recoveredClaim.controlRoot, controlRoot: recoveredClaim.controlRoot,
        executionRoot: recoveredClaim.executionRoot, route: recoveredClaim.route,
        provisionalNativeTurnRef: recoveredClaim.acceptance === "acceptance_proven"
          ? recoveredClaim.nativeTurnRef : recoveredClaim.provisionalNativeTurnRef,
        worker: recoveredClaim.worker, physicalResidency: recoveredClaim.physicalResidency,
      });
      records.push(record);
      existing.add(jobIdentityKey(record));
    } catch { /* the next bounded recovery wake retries the exact durable claim */ }
  }
  return obligations;
}

function leaseTargets(record, claim, includeWriter) {
  return claim.leaseBindings
    .filter((binding) => binding.kind !== "writer" || includeWriter)
    .map((binding) => ({ ...binding, route: record.route }));
}

function collapsedDisposition(release, kind, absent) {
  const rows = (release?.dispositions ?? []).filter((entry) => kind === "admission"
    ? ["instance", "native_session"].includes(entry.kind) : entry.kind === kind);
  if (!rows.length) return absent;
  if (rows.some((entry) => !["released", "already_released"].includes(entry.disposition))) return "unknown";
  return rows.some((entry) => entry.disposition === "released") ? "released" : "already_released";
}

function serviceDispositionFor(residency, physicalDisposition, serviceResult) {
  if (residency.kind === "local_process") return "not_applicable";
  if (physicalDisposition === "retained_shared") return "retained_shared";
  if (physicalDisposition === "retained_reused") return "retained_reused";
  const disposition = serviceResult?.serviceTurnDisposition;
  return ["released", "already_released"].includes(disposition) ? disposition : "unknown";
}

async function markFailure(record, failureCode, deps) {
  try { return deps.recordReclaimFailure({ ...transitionInput(record), failureCode }); } catch { return record; }
}

async function closePhysical(record, services, deps) {
  let current = record;
  const residency = current.physicalResidency;
  if (current.hardReclaim?.phase !== "claimed") {
    return { record: current, disposition: current.hardReclaim.physicalDisposition, serviceResult: null };
  }
  if (["signal_refused", "target_still_alive", "physical_identity_ambiguous"].includes(current.hardReclaim.failureCode)) {
    return { record: current, hold: true };
  }
  if (residency.kind === "reused_service") {
    current = deps.recordPhysicalDeath({ ...transitionInput(current), physicalDisposition: "retained_reused" });
    return { record: current, disposition: "retained_reused", serviceResult: null };
  }
  if (residency.kind === "local_process") {
    const state = processState(residency, deps);
    if (state === "identity_mismatch" || state === "incomplete") {
      await markFailure(current, "physical_identity_ambiguous", deps);
      return { record: current, hold: true };
    }
    if (state === "exact_live") {
      if (current.hardReclaim.terminationAttemptedAt == null) {
        current = deps.markTerminationAttempted(transitionInput(current));
        let termination;
        try { termination = deps.terminate(residency.pid, residency.identity); } catch {
          await markFailure(current, "signal_failed", deps); return { record: current, hold: true };
        }
        if (!termination?.attempted || !termination.delivered) {
          await markFailure(current, "signal_refused", deps); return { record: current, hold: true };
        }
      }
      const attempts = Math.ceil(deps.terminationWaitMs / 20);
      for (let index = 0; index < attempts && processState(residency, deps) === "exact_live"; index += 1) {
        await deps.sleep(20);
      }
      if (processState(residency, deps) !== "dead") {
        await markFailure(current, "target_still_alive", deps); return { record: current, hold: true };
      }
    }
    current = deps.recordPhysicalDeath({ ...transitionInput(current), physicalDisposition: "dead" });
    return { record: current, disposition: "dead", serviceResult: null };
  }
  const serviceResult = await services.hardReclaimManagedTurn({
    residency, rootId: current.ownerRootId, agentId: current.agentId, turnId: current.jobId, attemptId: current.attemptId,
    terminationAlreadyAttempted: current.hardReclaim.terminationAttemptedAt != null,
    beforeTerminate: async () => { current = deps.markTerminationAttempted(transitionInput(current)); },
  });
  if (serviceResult.disposition === "ambiguous") {
    if (serviceResult.processDisposition !== "dead") {
      await markFailure(current, serviceResult.failureCode ?? "lease_disposition_unknown", deps);
      return { record: current, hold: true, serviceResult };
    }
    current = deps.recordPhysicalDeath({ ...transitionInput(current), physicalDisposition: "dead" });
    return { record: current, disposition: "dead", serviceResult };
  }
  const disposition = serviceResult.processDisposition;
  current = deps.recordPhysicalDeath({ ...transitionInput(current), physicalDisposition: disposition });
  return { record: current, disposition, serviceResult };
}

async function releaseAndCommit(record, claim, physicalDisposition, serviceResult, deps) {
  const includeWriter = physicalDisposition === "dead";
  const releases = leaseTargets(record, claim, includeWriter);
  let release;
  try { release = deps.releaseLeases({ releases }); } catch { release = { outcome: "unknown", dispositions: [] }; }
  const retainedWriter = record.physicalResidency.kind === "reused_service" ? "retained_reused" : "retained_shared";
  const leaseDisposition = {
    admission: collapsedDisposition(release, "admission", "unknown"),
    writer: includeWriter
      ? collapsedDisposition(release, "writer", claim.leaseBindings.some((entry) => entry.kind === "writer") ? "unknown" : "not_applicable")
      : claim.leaseBindings.some((entry) => entry.kind === "writer") ? retainedWriter : "not_applicable",
    serviceTurn: serviceDispositionFor(record.physicalResidency, physicalDisposition, serviceResult),
  };
  const total = release.outcome === "all" && !Object.values(leaseDisposition).includes("unknown") &&
    serviceResult?.disposition !== "ambiguous";
  const current = deps.recordLeasePending({ ...transitionInput(record), leaseDisposition,
    failureCode: total ? null : serviceResult?.failureCode ?? "lease_disposition_unknown" });
  return total ? deps.commitHardReclaim(transitionInput(current)) : current;
}

async function reclaimUnknown(record, services, deps) {
  const deadline = hardReclaimDeadline(record);
  if (record.status !== "unknown" || deadline == null || deps.now() < deadline) return { hold: false };
  const claim = exactBinding(record, deps);
  if (!claim || processState(record.worker, deps) !== "dead") return { hold: true };
  const observed = await finalObservation(record, deps);
  if (!observed || observed.status !== "unknown") return { hold: false };
  if (!exactBinding(observed, deps) || processState(observed.worker, deps) !== "dead") return { hold: true };
  let current = observed;
  if (current.hardReclaim == null) {
    // PID reuse of the native target is an operator HOLD, not a reclaim claim.
    if (current.physicalResidency.kind === "local_process" && processState(current.physicalResidency, deps) === "identity_mismatch") return { hold: true };
    if (current.physicalResidency.kind === "managed_service") {
      const preflight = await services.inspectHardReclaimManagedTurn?.({
        residency: current.physicalResidency, rootId: current.ownerRootId, agentId: current.agentId,
        turnId: current.jobId, attemptId: current.attemptId,
      });
      if (!preflight || preflight.disposition === "ambiguous") return { hold: true };
    }
    try { current = deps.claimHardReclaim(transitionInput(current)); } catch { return { hold: true }; }
  }
  if (current.hardReclaim.phase === "committed") {
    const projection = deps.reconcileHardReclaim(current);
    return { committed: true, projectionPending: !(projection?.agentProjected && projection?.completionPublished) };
  }
  let physicalDisposition = current.hardReclaim.physicalDisposition;
  let serviceResult = null;
  if (current.hardReclaim.phase === "claimed") {
    const physical = await closePhysical(current, services, deps);
    if (physical.hold) return { hold: true };
    current = physical.record;
    physicalDisposition = physical.disposition;
    serviceResult = physical.serviceResult;
  } else if (["physical_dead", "lease_pending"].includes(current.hardReclaim.phase) &&
      current.physicalResidency.kind === "managed_service" && physicalDisposition === "dead") {
    serviceResult = await services.hardReclaimManagedTurn({
      residency: current.physicalResidency, rootId: current.ownerRootId, agentId: current.agentId,
      turnId: current.jobId, attemptId: current.attemptId, terminationAlreadyAttempted: true,
    });
  }
  try {
    current = await releaseAndCommit(current, claim, physicalDisposition, serviceResult, deps);
  } catch { return { hold: true }; }
  let projectionPending = false;
  if (current.status === "hard_reclaimed") {
    try {
      const projection = deps.reconcileHardReclaim(current);
      projectionPending = !(projection?.agentProjected && projection?.completionPublished);
    } catch { projectionPending = true; }
  }
  return {
    committed: current.status === "hard_reclaimed",
    retainedShared: current.hardReclaim?.physicalDisposition === "retained_shared",
    projectionPending,
  };
}

async function completeSharedReclaim(record, services, deps) {
  if (record.status !== "hard_reclaimed" || record.hardReclaim?.physicalDisposition !== "retained_shared" ||
      record.physicalResidency?.kind !== "managed_service" || processState(record.worker, deps) !== "dead") return false;
  const claim = exactBinding(record, deps, { allowFinalizedHardReclaim: true });
  if (!claim) return true;
  let current = record;
  const result = await services.hardReclaimManagedTurn({
    residency: record.physicalResidency, rootId: record.ownerRootId, agentId: record.agentId,
    turnId: record.jobId, attemptId: record.attemptId,
    terminationAlreadyAttempted: record.hardReclaim.terminationAttemptedAt != null,
    beforeTerminate: async () => { current = deps.markTerminationAttempted(transitionInput(current)); },
  });
  if (result.disposition !== "released") {
    if (result.disposition === "ambiguous") await markFailure(current, result.failureCode ?? "lease_disposition_unknown", deps);
    return true;
  }
  const writerTargets = leaseTargets(record, claim, true).filter((target) => target.kind === "writer");
  let release = { outcome: "all", dispositions: [] };
  try { if (writerTargets.length) release = deps.releaseLeases({ releases: writerTargets }); } catch { return true; }
  const writer = collapsedDisposition(release, "writer", "not_applicable");
  if (release.outcome !== "all" || writer === "unknown") return true;
  deps.updateCommittedDisposition({ ...transitionInput(current), physicalDisposition: "dead",
    leaseDisposition: { admission: current.hardReclaim.leaseDisposition.admission, writer,
      serviceTurn: result.serviceTurnDisposition } });
  return false;
}

/** One durable self-exiting manager loop; tests may inject only syscall/durable seams. */
export async function runResidencyManager(options = {}) {
  assertVersionThreeWriteAllowed(options.generation ?? FUTURE_WRITE_GENERATION, "Residency manager");
  const paths = resolveResidencyManagerPaths(options);
  const deps = dependencies(options);
  const identity = deps.getIdentity(process.pid);
  const receipt = { version: RECEIPT_VERSION, generation: FUTURE_WRITE_GENERATION, pid: process.pid, identity,
    stateRootDigest: paths.stateRootDigest, runtimeRootDigest: paths.runtimeRootDigest, startedAt: nowIso() };
  const existing = read(paths.receiptFile);
  if (receiptMatches(existing, paths, deps) && (existing.pid !== process.pid || existing.identity !== identity)) {
    return { waiting: false, reason: "already_running" };
  }
  write(paths.receiptFile, receipt);
  const services = options.serviceManager ?? createOpencodeServiceManager({
    runtimeRoot: paths.runtimeRoot, cwd: options.cwd, env: options.env, envFile: options.envFile,
  });
  let lastReason = "no_obligation";
  try {
    while (true) {
      const snapshot = deps.listJobs();
      const records = [...(snapshot.records ?? [])];
      const desiredPaths = new Set([paths.stateRoot, paths.runtimeRoot, ...(snapshot.watchPaths ?? [])]);
      let obligations = (snapshot.unreadable?.length ?? 0) > 0;
      let claimSnapshot = { records: [], unreadable: [] };
      try {
        claimSnapshot = deps.listClaims();
        obligations = recoverPreRecordClaims(claimSnapshot, records, deps) || obligations;
      }
      catch { obligations = true; }
      for (const watchPath of claimSnapshot.watchPaths ?? []) addDurableWatchPath(desiredPaths, watchPath, paths);
      for (const record of records) addDurableWatchPath(desiredPaths, resolveVersionThreeJobDirectory(record), paths);
      for (const record of records) addDurableWatchPath(desiredPaths,
        resolveAgentRegistryDirectory({ cwd: record.controlRoot, ownerRootId: record.ownerRootId }), paths);
      for (const claim of claimSnapshot.records ?? []) addDurableWatchPath(desiredPaths, resolveLaunchClaimDirectory(claim), paths);
      for (const activityPath of services.activityPaths?.() ?? []) addDurableWatchPath(desiredPaths, activityPath, paths);
      let nearest = Number.POSITIVE_INFINITY;
      for (const initial of records) {
        let record = initial;
        if (record.status === "running") {
          obligations = true;
          const worker = processState(record.worker, deps);
          if (worker === "dead" && exactBinding(record, deps)) {
            await finalObservation(record, deps);
            record = deps.readJob(record);
            if (record?.status === "running") {
              try { record = deps.recordWorkerLostUncertain({ ...transitionInput(record), reason: "worker_lost", detail: null }); } catch {}
            }
          }
        }
        if (record?.status === "unknown") {
          const deadline = hardReclaimDeadline(record);
          if (record.version === V3_JOB_SCHEMA_VERSION && deadline != null) {
            if (deadline > deps.now()) nearest = Math.min(nearest, deadline);
            const result = await reclaimUnknown(record, services, deps);
            if (!result.committed || result.retainedShared || result.projectionPending) obligations = true;
          }
        } else if (record?.status === "hard_reclaimed") {
          try {
            const projection = deps.reconcileHardReclaim(record);
            if (!(projection?.agentProjected && projection?.completionPublished)) obligations = true;
          } catch { obligations = true; }
          if (record.hardReclaim?.physicalDisposition === "retained_shared") {
            obligations = await completeSharedReclaim(record, services, deps) || obligations;
          }
        }
      }
      const idle = await services.reapIfIdle();
      lastReason = idle?.reason ?? lastReason;
      const managed = typeof services.nextIdleDeadline === "function"
        ? await services.nextIdleDeadline() : { obligation: false, deadline: null };
      obligations = managed?.obligation === true || obligations;
      if (Number.isFinite(managed?.deadline) && managed.deadline > deps.now()) nearest = Math.min(nearest, managed.deadline);
      if (!obligations) return { waiting: false, reason: lastReason };
      const recoveryDeadline = deps.now() + RECOVERY_WAKE_MS;
      await deps.waitForActivity({
        desiredPaths: [...desiredPaths], stateRoot: durableWatchRoot(paths),
        deadline: Math.min(nearest, recoveryDeadline), recoveryIntervalMs: RECOVERY_WAKE_MS,
      });
    }
  } finally {
    const current = read(paths.receiptFile);
    if (current?.pid === process.pid && current?.identity === identity &&
        current?.stateRootDigest === receipt.stateRootDigest && current?.runtimeRootDigest === receipt.runtimeRootDigest) {
      try { fs.unlinkSync(paths.receiptFile); } catch {}
    }
  }
}

if (process.argv[2] === "--run") {
  await runResidencyManager({
    runtimeRoot: process.env.CODEX_HARNESSDOCK_RESIDENCY_RUNTIME_ROOT,
    stateRoot: process.env.CODEX_HARNESSDOCK_RESIDENCY_STATE_ROOT,
  });
}
