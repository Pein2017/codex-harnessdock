/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal version-three job persistence.
 *
 * A version-three turn needs a durable record of its own lifecycle for the
 * same reason a version-two turn does: the in-memory receipt a worker returns
 * dies with the worker. Without a durable record, a completion that could not
 * be published is lost with no evidence any later pass could reconcile from,
 * and a turn that ended in uncertainty leaves nothing behind but held leases.
 *
 * This is deliberately **not** the public job store. `job-store.mjs` owns the
 * version-one/two queue, its transitions, reaping, retention, and public
 * projections, and `UNDERSTOOD_JOB_STATE_VERSIONS` deliberately excludes
 * version three so every one of those paths refuses to own a version-three
 * record. Rather than weaken that gate, version-three records live in their
 * own state directory under their own writer, gated on the internal future
 * write generation. The public queue therefore never sees them at all -- a
 * stronger separation than refusing them one call site at a time -- and the
 * existing refusal remains in force for any version-three record that does
 * appear in the public store.
 *
 * Nothing here is model-facing. There is no public operation, no selector, and
 * no MCP surface: the only callers are the internal detached worker and the
 * internal reconciliation pass below.
 *
 * Lifecycle, monotonic:
 *
 *     running -> unknown        (the worker lost certainty; leases stay held)
 *     running -> terminal       (proven publishable terminal evidence)
 *     unknown -> terminal       (Task 5.6: coherent later Driver observation
 *                                only, proven publishable and matching the
 *                                exact native turn; see
 *                                runtime/v3-turn-reconciliation.mjs)
 *     terminal -> terminal      idempotent; only reconciliation marks advance
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createAgentStore } from "./agent-store.mjs";
import { reconcileTerminalJobCompletion } from "./completion-inbox.mjs";
import { publishBoundTerminalEvent } from "./terminal-event-publisher.mjs";
import { recoverStaleDirectoryLock, sameFileIdentity } from "./durable-directory-lock.mjs";
import {
  JOB_STATE_VERSION_V3,
  MAX_ROUTE_BYTES,
  assertVersionThreeWriteAllowed,
  validateStoredVersionThreeRoute,
  validateVersionThreeRoute,
} from "./durable-state-v3.mjs";
import {
  MAX_ABSENCE_REASON_CHARS,
  MAX_CONTINUATION_EVIDENCE_BYTES,
  MAX_DRIVER_RECEIPT_BYTES,
  MAX_FAILURE_DETAIL_BYTES,
  MAX_FAILURE_REASON_CHARS,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_OPAQUE_FIELD_DEPTH,
  MAX_PROGRESS_BYTES,
  validateNativeProgress,
  MAX_RESULT_METADATA_BYTES,
} from "./harness-contract.mjs";
import {
  MAX_NATIVE_LOCATOR_BYTES,
  assertNativeReferenceEnvelopeShape,
  assertNativeReferenceLocatorShape,
  canonicalNativeReferenceText,
} from "./native-reference.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { plainRecordSnapshot } from "./plain-record.mjs";
import { getProcessIdentity } from "./process-control.mjs";
import { classifyTurnSettlement } from "./turn-settlement.mjs";

export const V3_JOB_SCHEMA_VERSION = 1;

/** Terminal statuses a version-three job record may declare. */
export const V3_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "interrupted"]);

/** Every lifecycle state a version-three job record may declare. */
export const V3_JOB_STATUSES = Object.freeze(["running", "unknown", ...V3_TERMINAL_STATUSES]);

const V3_JOB_FIELDS = Object.freeze([
  "version", "harnessStateVersion",
  "ownerRootId", "agentId", "jobId", "attemptId", "workspaceRoot",
  "controlRoot", "executionRoot",
  "route", "nativeTurnRef", "status", "uncertainty", "terminalJob",
  "progress", "progressDeliveredRevision", "worker",
  "agentProjectionReconciledAt", "completionPublishedAt",
  "createdAt", "updatedAt",
]);

const MAX_IDENTITY_TEXT_BYTES = 256;
const MAX_DETAIL_BYTES = 2048;

// Durable uncertainty detail is an operator-facing machine code, not an error
// message.  In particular, paths, service responses, and arbitrary exception
// text must never become durable state.  A caller may still provide a closed
// platform code when it has one; an unrecognized/free-form value is honestly
// represented as null rather than replaced with a made-up explanation.
const DURABLE_UNCERTAINTY_DETAIL_CODES = new Set([
  "EACCES", "EBUSY", "ECONNREFUSED", "ECONNRESET", "EEXIST", "EINTR", "EINVAL",
  "EIO", "EISDIR", "ENOSPC", "ENOENT", "ENOTDIR", "EPERM", "EPIPE", "ETIMEDOUT",
]);

/**
 * Worst-case UTF-8 bytes `JSON.stringify()` can emit for one UTF-16 code unit
 * of admitted text. A control character becomes the six-byte `\uXXXX` escape;
 * an unescaped BMP character is at most three UTF-8 bytes; a surrogate pair
 * spends four bytes across two units. Six is therefore the true ceiling, and
 * every char-denominated contract bound below is converted through it, because
 * the contract counts characters while this record's cap counts bytes.
 */
const JSON_TEXT_BYTES_PER_CHAR = 6;

/**
 * The bounded, derived one-line summary a version-three terminal projection
 * carries. The complete final message is stored exactly once, inside
 * `normalizedTerminalResult`; the summary is a short derived label for
 * operators and the public completion event, never a second copy of the
 * deliverable.
 */
export const MAX_TERMINAL_JOB_SUMMARY_CHARS = 2048;

/**
 * Fixed bytes for the record's own scaffolding: identities, timestamps,
 * statuses, `recoverability`/`resumability`, and every JSON key and delimiter
 * in the projection. Generous by design -- it is the only term here not
 * derived from a contract bound, so it is the one that must not be tight.
 */
const V3_TERMINAL_JOB_SCAFFOLDING_BYTES = 16 * 1024;

/**
 * The durable capacity of one version-three terminal projection, derived from
 * the named bounds of the exact contract it stores rather than chosen.
 *
 * This must provably cover every result `validateNormalizedTerminalResult()`
 * admits: persistence happens *after* lease release, so a valid Driver result
 * this cap could not hold would turn a proven, publishable completion into a
 * permanent unknown with its leases already gone. Each term below names the
 * owner that bounds it, so raising a contract bound raises this with it
 * instead of silently overrunning it.
 */
const MAX_TERMINAL_JOB_BYTES =
  // The one complete final message, stored exactly once.
  MAX_FINAL_MESSAGE_CHARS * JSON_TEXT_BYTES_PER_CHAR +
  MAX_ABSENCE_REASON_CHARS * JSON_TEXT_BYTES_PER_CHAR +
  // The derived summary this record adds on top of the contract.
  MAX_TERMINAL_JOB_SUMMARY_CHARS * JSON_TEXT_BYTES_PER_CHAR +
  // `failure.reason` plus `failure.detail` in its text form; the object form
  // is bounded separately and cannot coexist with the text form.
  MAX_FAILURE_REASON_CHARS * JSON_TEXT_BYTES_PER_CHAR * 2 +
  MAX_FAILURE_DETAIL_BYTES +
  MAX_PROGRESS_BYTES +
  MAX_CONTINUATION_EVIDENCE_BYTES +
  MAX_RESULT_METADATA_BYTES +
  MAX_DRIVER_RECEIPT_BYTES +
  // The turn reference the record states itself, plus the turn and session
  // references the normalized result restates.
  MAX_NATIVE_LOCATOR_BYTES * 3 +
  // The route on the record, and the route lineage the projection repeats.
  MAX_ROUTE_BYTES * 2 +
  V3_TERMINAL_JOB_SCAFFOLDING_BYTES;

/**
 * Depth headroom above the contract's own opaque-field depth. A bounded opaque
 * field (`progress`, `driverReceipt`, `resultMetadata`, continuation evidence)
 * sits two levels inside the projection -- `terminalJob.normalizedTerminalResult.<field>`
 * -- and an array adds one level per rank, so the wrapper allowance is what
 * keeps a contract-legal result from failing this record's own depth check.
 */
const V3_TERMINAL_JOB_WRAPPER_DEPTH = 6;
const MAX_TERMINAL_JOB_DEPTH = MAX_OPAQUE_FIELD_DEPTH + V3_TERMINAL_JOB_WRAPPER_DEPTH;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const UNSTABLE_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_DELAY_MS = 10;
const LOCK_RETRY_MAX_DELAY_MS = 40;

function nowIso() {
  return new Date().toISOString();
}

function taggedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertIdentityText(value, label, maxBytes = MAX_IDENTITY_TEXT_BYTES) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty text.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not carry leading or trailing whitespace.`);
  }
  if (UNSTABLE_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} must not contain control or format characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its durable bound.`);
  }
  return value;
}

function assertTimestampText(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} must be one ISO-8601 millisecond timestamp.`);
  }
  return value;
}

function assertOptionalTimestamp(value, label) {
  return value == null ? null : assertTimestampText(value, label);
}

/**
 * One bounded durable data tree. Unlike `plainDataTree()` this admits arrays,
 * because a normalized terminal result legitimately carries bounded ordered
 * evidence (tool uses, touched files, attempts). Everything else stays the
 * same discipline: no function, symbol, accessor, Proxy, cycle, or
 * prototype-polluting key survives, and the result is a fresh plain value.
 */
function boundedDurableTree(value, label, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`${label} must contain only plain durable data.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${label} must not carry a non-finite number.`);
    }
    return value;
  }
  if (depth >= MAX_TERMINAL_JOB_DEPTH) {
    throw new Error(`${label} is nested deeper than a durable version-three record admits.`);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => boundedDurableTree(entry, `${label}[${index}]`, depth + 1));
  }
  const snapshot = plainRecordSnapshot(value, label);
  /** @type {Record<string, *>} */
  const rebuilt = {};
  for (const key of Object.keys(snapshot)) {
    rebuilt[key] = boundedDurableTree(snapshot[key], `${label}.${key}`, depth + 1);
  }
  return rebuilt;
}

/**
 * @param {{ownerRootId?: *, agentId?: *, jobId?: *}} candidate
 * @returns {{ownerRootId: string, agentId: string, jobId: string}}
 */
function assertBindingIdentity({ ownerRootId, agentId, jobId }) {
  return {
    ownerRootId: assertIdentityText(ownerRootId, "Version-three job ownerRootId"),
    agentId: assertIdentityText(agentId, "Version-three job agentId"),
    jobId: assertIdentityText(jobId, "Version-three job jobId"),
  };
}

function canonicalNativeTurnRef(nativeTurnRef, label) {
  const snapshot = assertNativeReferenceEnvelopeShape(nativeTurnRef, label);
  const locator = assertNativeReferenceLocatorShape(snapshot.locator, label);
  return Object.freeze({
    version: snapshot.version,
    harnessId: snapshot.harnessId,
    driverVersion: snapshot.driverVersion,
    instanceKey: snapshot.instanceKey,
    locatorVersion: snapshot.locatorVersion,
    locator,
  });
}

// ---------------------------------------------------------------------------
// Layout. One directory per owner root, one file per job, both named by digest
// so no caller-supplied identity ever becomes a path segment.
// ---------------------------------------------------------------------------

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveVersionThreeJobRoot() {
  return path.join(resolvePluginStateRoot(), "v3-jobs", `v${V3_JOB_SCHEMA_VERSION}`);
}

/**
 * The durable directory backing one owner root's version-three job records.
 * Exported read-only so an internal caller can add it to a durable-wake
 * waiter's `desiredPaths`; it creates nothing and confers no authority.
 */
export function resolveVersionThreeJobDirectory({ ownerRootId }) {
  return path.join(resolveVersionThreeJobRoot(), digest(assertIdentityText(ownerRootId, "Version-three job ownerRootId")));
}

function jobFileName(jobId) {
  return `${digest(jobId)}.json`;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
  }
  return directory;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
}

/**
 * Acquire this owner root's version-three job directory lock.
 *
 * Stale recovery is delegated to `runtime/durable-directory-lock.mjs` rather
 * than restated here: `persist()` below is a read-modify-write of a durable
 * lifecycle record, so a lock that can be taken from a live holder -- or
 * unlinked after another process legitimately acquired it -- would let an
 * uncertainty write land on top of a terminal one.
 */
function acquireDirectoryLock(directory) {
  ensureDirectory(directory);
  const lockFile = path.join(directory, ".lock");
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    recoverStaleDirectoryLock(lockFile);
    const token = randomBytes(16).toString("hex");
    const candidateFile = `${lockFile}.${process.pid}.${token}.candidate`;
    let fd = null;
    try {
      fd = fs.openSync(candidateFile, "wx", 0o600);
      let identity = null;
      try { identity = getProcessIdentity(process.pid); } catch { /* best effort */ }
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity, token, timestamp: Date.now() }), "utf8");
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      fs.linkSync(candidateFile, lockFile);
      fs.unlinkSync(candidateFile);
      fs.closeSync(fd);
      return { lockFile, token, stat };
    } catch (error) {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      try { fs.unlinkSync(candidateFile); } catch { /* best effort */ }
      if (error?.code === "EEXIST" && Date.now() < deadline) {
        sleepSync(LOCK_RETRY_MIN_DELAY_MS + Math.random() * (LOCK_RETRY_MAX_DELAY_MS - LOCK_RETRY_MIN_DELAY_MS));
        continue;
      }
      if (error?.code === "EEXIST") {
        throw taggedError("ETIMEDOUT", `Timed out acquiring version-three job directory lock ${lockFile}.`);
      }
      throw error;
    }
  }
}

function releaseDirectoryLock(lock) {
  if (!lock) return;
  try {
    const stat = fs.statSync(lock.lockFile);
    const data = JSON.parse(fs.readFileSync(lock.lockFile, "utf8"));
    if (sameFileIdentity(lock.stat, stat) && data?.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch { /* best effort */ }
}

function writeAtomicJobFile(filePath, data) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `${path.basename(filePath)}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`
  );
  let fd = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    }
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Closed record validator. Every record written here is read back through this
// exact validator, so persistence can never diverge from what a later read
// accepts, and a corrupt record fails closed instead of being repaired.
// ---------------------------------------------------------------------------

function validateUncertainty(value, label) {
  if (value == null) return null;
  const snapshot = plainRecordSnapshot(value, label);
  for (const field of Object.keys(snapshot)) {
    if (!["reason", "detail", "recordedAt"].includes(field)) {
      throw new Error(`${label} declares an unsupported field: ${field}.`);
    }
  }
  const detail = snapshot.detail == null ? null : sanitizeUncertaintyDetail(snapshot.detail);
  return Object.freeze({
    reason: assertIdentityText(snapshot.reason, `${label} reason`),
    detail,
    recordedAt: assertTimestampText(snapshot.recordedAt, `${label} recordedAt`),
  });
}

function sanitizeUncertaintyDetail(value) {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!DURABLE_UNCERTAINTY_DETAIL_CODES.has(code)) return null;
  if (Buffer.byteLength(code, "utf8") > MAX_DETAIL_BYTES) return null;
  return code;
}

function assertProjectionBinding(actual, expected, label) {
  if (actual !== expected) {
    throw taggedError(
      "projection_not_bound",
      `${label} declares ${JSON.stringify(actual ?? null)}, not this record's own ${JSON.stringify(expected ?? null)}.`
    );
  }
}

/**
 * Validate one durable terminal projection *against the record it settles*.
 *
 * The projection is the only thing a later Agent projection and completion
 * event are built from, and nothing downstream re-derives its identity. So a
 * projection is admitted only when every identity it states is this record's
 * own: owner root, Agent, job, attempt, status, durable state version, the
 * whole canonical route (Harness, logical instance, model, topology,
 * authority, Driver version, capability snapshot), and the exact native turn
 * -- including the native turn named by its own nested terminal evidence,
 * which is what actually proves the deliverable belongs to this turn.
 *
 * A projection that disagrees on any of them is refused here, before it can
 * be persisted, re-read, projected onto an Agent, or published. Identity
 * comparisons that have a canonical form use it, so an equivalent route or
 * locator restated in another key order is still the same identity
 * (`durable-state-v3.mjs` and `native-reference.mjs` own those two forms).
 */
function validateTerminalJob(value, label, {
  ownerRootId, agentId, jobId, attemptId, route, nativeTurnRef, status, storedRoute,
}) {
  if (value == null) return null;
  const bounded = boundedDurableTree(value, label);
  const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
  if (bytes > MAX_TERMINAL_JOB_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TERMINAL_JOB_BYTES} bytes.`);
  }
  assertProjectionBinding(bounded.id, jobId, `${label} job identity`);
  assertProjectionBinding(bounded.agentId, agentId, `${label} Agent identity`);
  assertProjectionBinding(bounded.ownerRootId, ownerRootId, `${label} owner root identity`);
  assertProjectionBinding(bounded.attemptId, attemptId, `${label} attempt identity`);
  assertProjectionBinding(bounded.status, status, `${label} status`);
  assertProjectionBinding(bounded.harnessStateVersion, JOB_STATE_VERSION_V3, `${label} durable job state version`);
  assertProjectionBinding(bounded.harnessId, route.harnessId, `${label} Harness identity`);
  assertProjectionBinding(bounded.harnessInstanceKey, route.instanceKey, `${label} logical instance`);
  assertProjectionBinding(bounded.driverVersion, route.driverVersion, `${label} Driver version`);
  const validateRoute = storedRoute ? validateStoredVersionThreeRoute : validateVersionThreeRoute;
  assertProjectionBinding(
    JSON.stringify(validateRoute(bounded.route, `${label} route`)),
    JSON.stringify(route),
    `${label} route`
  );
  const boundTurnRefText = canonicalNativeReferenceText(nativeTurnRef, `${label} record native turn reference`);
  assertProjectionBinding(
    canonicalNativeReferenceText(bounded.nativeTurnRef, `${label} native turn reference`),
    boundTurnRefText,
    `${label} native turn reference`
  );
  const evidence = bounded.normalizedTerminalResult;
  if (evidence == null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw taggedError("projection_not_bound", `${label} must carry its own normalized terminal evidence.`);
  }
  assertProjectionBinding(
    canonicalNativeReferenceText(evidence.nativeTurnRef, `${label} terminal evidence native turn reference`),
    boundTurnRefText,
    `${label} terminal evidence native turn reference`
  );
  assertProjectionBinding(evidence.status, status, `${label} terminal evidence status`);
  assertProjectionBinding(evidence.harnessId, route.harnessId, `${label} terminal evidence Harness identity`);
  assertProjectionBinding(evidence.instanceKey, route.instanceKey, `${label} terminal evidence logical instance`);
  assertProjectionBinding(evidence.driverVersion, route.driverVersion, `${label} terminal evidence Driver version`);
  // A terminal projection may only be stored when the shared settlement owner
  // proves it publishable: an unpublishable projection stored as terminal
  // would let a later reconciliation publish evidence this runtime refused.
  const classification = classifyTurnSettlement(evidence);
  if (!classification.publishable) {
    throw taggedError(
      "not_publishable",
      `${label} cannot be stored as terminal: settlement is ${classification.reason}.`
    );
  }
  return bounded;
}

function validateVersionThreeJobRecord(parsed, { storedRoute = false } = {}) {
  const label = "Version-three job record";
  const snapshot = plainRecordSnapshot(parsed, label);
  for (const field of Object.keys(snapshot)) {
    if (!V3_JOB_FIELDS.includes(field)) throw new Error(`${label} declares an unknown field: ${field}.`);
  }
  const hasControlRoot = Object.hasOwn(snapshot, "controlRoot");
  const hasExecutionRoot = Object.hasOwn(snapshot, "executionRoot");
  if (hasControlRoot !== hasExecutionRoot) {
    throw new Error(`${label} must state controlRoot and executionRoot together.`);
  }
  for (const field of V3_JOB_FIELDS) {
    if (!["controlRoot", "executionRoot", "progress", "progressDeliveredRevision", "worker"].includes(field) && !(field in snapshot)) {
      throw new Error(`${label} is missing required field: ${field}.`);
    }
  }
  if (snapshot.version !== V3_JOB_SCHEMA_VERSION) {
    throw taggedError("unsupported_version", `${label} declares unsupported schema version.`);
  }
  if (snapshot.harnessStateVersion !== JOB_STATE_VERSION_V3) {
    throw taggedError(
      "unsupported_state_version",
      `${label} must declare durable job state version ${JOB_STATE_VERSION_V3}.`
    );
  }
  const identity = assertBindingIdentity(snapshot);
  const attemptId = assertIdentityText(snapshot.attemptId, `${label} attemptId`);
  const validateRoute = storedRoute ? validateStoredVersionThreeRoute : validateVersionThreeRoute;
  const route = validateRoute(snapshot.route, `${label} route`);
  const nativeTurnRef = canonicalNativeTurnRef(snapshot.nativeTurnRef, `${label} native turn reference`);
  if (nativeTurnRef.harnessId !== route.harnessId || nativeTurnRef.instanceKey !== route.instanceKey) {
    throw new Error(`${label} native turn reference does not belong to its own route.`);
  }
  if (!V3_JOB_STATUSES.includes(snapshot.status)) {
    throw new Error(`${label} declares an unsupported status: ${JSON.stringify(snapshot.status ?? null)}.`);
  }
  const isTerminal = V3_TERMINAL_STATUSES.includes(snapshot.status);
  const uncertainty = validateUncertainty(snapshot.uncertainty, `${label} uncertainty`);
  if (snapshot.status === "unknown" && uncertainty == null) {
    throw new Error(`${label} with status unknown must state its exact uncertainty.`);
  }
  if (snapshot.status !== "unknown" && uncertainty != null) {
    throw new Error(`${label} may only carry uncertainty while its status is unknown.`);
  }
  const terminalJob = validateTerminalJob(snapshot.terminalJob, `${label} terminal projection`, {
    ...identity, attemptId, route, nativeTurnRef, status: snapshot.status, storedRoute,
  });
  if (isTerminal && terminalJob == null) {
    throw new Error(`${label} with a terminal status must carry its durable terminal projection.`);
  }
  if (!isTerminal && terminalJob != null) {
    throw new Error(`${label} may only carry a terminal projection with a terminal status.`);
  }
  const completionPublishedAt = assertOptionalTimestamp(snapshot.completionPublishedAt, `${label} completionPublishedAt`);
  const agentProjectionReconciledAt = assertOptionalTimestamp(
    snapshot.agentProjectionReconciledAt, `${label} agentProjectionReconciledAt`
  );
  if (!isTerminal && (completionPublishedAt != null || agentProjectionReconciledAt != null)) {
    throw new Error(`${label} cannot claim a terminal projection or completion before it is terminal.`);
  }
  const progressDeliveredRevision = snapshot.progressDeliveredRevision == null ? 0 : snapshot.progressDeliveredRevision;
  if (!Number.isSafeInteger(progressDeliveredRevision) || progressDeliveredRevision < 0) {
    throw new Error(`${label} progressDeliveredRevision must be a non-negative safe integer.`);
  }
  let progress = null;
  if (snapshot.progress != null) {
    const value = plainRecordSnapshot(snapshot.progress, `${label} progress`);
    if (!Object.keys(value).every((key) => ["revision", "activity", "toolName", "updatedAt"].includes(key))) {
      throw new Error(`${label} progress declares an unknown field.`);
    }
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error(`${label} progress revision is invalid.`);
    const reduced = validateNativeProgress({ activity: value.activity, toolName: value.toolName }, `${label} progress`);
    progress = Object.freeze({ revision: value.revision, ...reduced, updatedAt: assertTimestampText(value.updatedAt, `${label} progress updatedAt`) });
  }
  if (progress != null && progressDeliveredRevision > progress.revision) {
    throw new Error(`${label} progressDeliveredRevision cannot exceed progress revision.`);
  }
  if (snapshot.status !== "running" && progress != null) throw new Error(`${label} may only carry progress while running.`);
  let worker = null;
  if (snapshot.worker != null) {
    const value = plainRecordSnapshot(snapshot.worker, `${label} worker`);
    if (Object.keys(value).sort().join(",") !== "identity,pid") throw new Error(`${label} worker must state exact pid identity.`);
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(`${label} worker pid is invalid.`);
    worker = Object.freeze({ pid: value.pid, identity: assertIdentityText(value.identity, `${label} worker identity`) });
  }
  const workspaceRoot = assertIdentityText(snapshot.workspaceRoot, `${label} workspaceRoot`, 4096);
  const controlRoot = hasControlRoot
    ? assertIdentityText(snapshot.controlRoot, `${label} controlRoot`, 4096)
    : workspaceRoot;
  const executionRoot = hasExecutionRoot
    ? assertIdentityText(snapshot.executionRoot, `${label} executionRoot`, 4096)
    : workspaceRoot;
  if (workspaceRoot !== controlRoot) {
    throw new Error(`${label} legacy workspaceRoot must remain its control root.`);
  }
  return Object.freeze({
    version: V3_JOB_SCHEMA_VERSION,
    harnessStateVersion: JOB_STATE_VERSION_V3,
    ...identity,
    attemptId,
    workspaceRoot,
    controlRoot,
    executionRoot,
    route,
    nativeTurnRef,
    status: snapshot.status,
    uncertainty,
    terminalJob,
    progress,
    progressDeliveredRevision,
    worker,
    agentProjectionReconciledAt,
    completionPublishedAt,
    createdAt: assertTimestampText(snapshot.createdAt, `${label} createdAt`),
    updatedAt: assertTimestampText(snapshot.updatedAt, `${label} updatedAt`),
  });
}

function readRecordFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw taggedError("corrupt_record", `Version-three job record is unreadable: ${error.message}`);
  }
  return validateVersionThreeJobRecord(parsed, { storedRoute: true });
}

/**
 * Read one version-three job record, or `null` when none exists. Read-only;
 * no lock, no directory creation.
 */
export function readVersionThreeJobRecord({ ownerRootId, agentId, jobId }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const filePath = path.join(resolveVersionThreeJobDirectory(identity), jobFileName(identity.jobId));
  if (!fs.existsSync(filePath)) return null;
  const record = readRecordFile(filePath);
  if (record && (record.agentId !== identity.agentId || record.jobId !== identity.jobId)) {
    throw taggedError("identity_drift", "Version-three job record identity does not match the requested job.");
  }
  return record;
}

/**
 * Every version-three job record one owner root holds, oldest first. A record
 * that cannot be read is reported by its closed reason rather than thrown, so
 * one corrupt file cannot hide every healthy sibling from reconciliation.
 */
export function listVersionThreeJobRecords({ ownerRootId }) {
  const owner = assertIdentityText(ownerRootId, "Version-three job ownerRootId");
  const directory = resolveVersionThreeJobDirectory({ ownerRootId: owner });
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { records: [], unreadable: [] };
  }
  const records = [];
  const unreadable = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = readRecordFile(path.join(directory, entry.name));
      if (record) records.push(record);
    } catch (error) {
      unreadable.push({ code: typeof error?.code === "string" ? error.code : "corrupt_record" });
    }
  }
  records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { records, unreadable };
}

/**
 * The monotonic lifecycle gate. A version-three record may advance from
 * `running` to `unknown` or to a terminal status, from `unknown` to a
 * terminal status, and a terminal record may only be rewritten by the exact
 * same terminal status (reconciliation marks). Everything else -- terminal
 * regression, a second contradictory terminal -- is refused here.
 *
 * `unknown -> terminal` exists only for Task 5.6's proof: coherent,
 * publishable, exact-native-turn-matching Driver observation gathered by
 * `runtime/v3-turn-reconciliation.mjs` *after* the worker that owned this
 * record is gone. `persist()`'s own `validateTerminalJob()` gate is what
 * actually enforces "publishable" here; this function only says the
 * transition itself is legal.
 */
function assertLifecycleAdvance(previous, next) {
  if (previous == null) {
    if (next.status !== "running") {
      throw taggedError(
        "invalid_creation",
        `A version-three job record is created as running; ${next.status} cannot be its first durable state.`
      );
    }
    return;
  }
  if (previous.attemptId !== next.attemptId) {
    throw taggedError(
      "wrong_attempt",
      `Version-three job ${previous.jobId} is bound to attempt ${JSON.stringify(previous.attemptId)}; ` +
      `attempt ${JSON.stringify(next.attemptId)} cannot write it.`
    );
  }
  if (previous.status === next.status) {
    if (V3_TERMINAL_STATUSES.includes(previous.status)) {
      const previousTerminal = JSON.stringify(previous.terminalJob);
      const nextTerminal = JSON.stringify(next.terminalJob);
      if (previousTerminal !== nextTerminal) {
        throw taggedError(
          "conflicting_terminal",
          `Version-three job ${previous.jobId} already carries a different terminal fact; ` +
          "a terminal record is immutable except for idempotent projection marks."
        );
      }
    }
    return;
  }
  if (previous.status === "running" && (next.status === "unknown" || V3_TERMINAL_STATUSES.includes(next.status))) {
    return;
  }
  if (previous.status === "unknown" && V3_TERMINAL_STATUSES.includes(next.status)) {
    return;
  }
  throw taggedError(
    "invalid_transition",
    `Version-three job ${previous.jobId} cannot move from ${previous.status} to ${next.status}; ` +
    `this generation owns no proof that reverses or re-decides a settled lifecycle.`
  );
}

function assertAttemptMatches(previous, attemptId, identity) {
  const candidateAttemptId = assertIdentityText(attemptId, "Version-three job attemptId");
  if (previous.attemptId !== candidateAttemptId) {
    throw taggedError(
      "wrong_attempt",
      `Version-three job ${identity.jobId} is bound to attempt ${JSON.stringify(previous.attemptId)}; ` +
      `attempt ${JSON.stringify(candidateAttemptId)} cannot write it.`
    );
  }
  return candidateAttemptId;
}

function persist(identity, generation, build) {
  assertVersionThreeWriteAllowed(generation, `Version-three job ${identity.jobId}`);
  const directory = resolveVersionThreeJobDirectory(identity);
  const lock = acquireDirectoryLock(directory);
  try {
    const filePath = path.join(directory, jobFileName(identity.jobId));
    const previous = fs.existsSync(filePath) ? readRecordFile(filePath) : null;
    const candidate = validateVersionThreeJobRecord(build(previous), { storedRoute: previous != null });
    assertLifecycleAdvance(previous, candidate);
    writeAtomicJobFile(filePath, candidate);
    return candidate;
  } finally {
    releaseDirectoryLock(lock);
  }
}

/**
 * Create the durable `running` record for one accepted version-three turn.
 * Idempotent for the exact same attempt: a repeat returns the stored record
 * rather than resetting a lifecycle that may already have advanced.
 */
export function recordVersionThreeTurnRunning({
  generation, ownerRootId, agentId, jobId, attemptId, workspaceRoot,
  controlRoot = workspaceRoot, executionRoot = workspaceRoot, route, nativeTurnRef, worker = null,
}) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return persist(identity, generation, (previous) => {
    if (previous) return previous;
    const timestamp = nowIso();
    return {
      version: V3_JOB_SCHEMA_VERSION,
      harnessStateVersion: JOB_STATE_VERSION_V3,
      ...identity,
      attemptId,
      workspaceRoot,
      controlRoot,
      executionRoot,
      route,
      nativeTurnRef,
      status: "running",
      uncertainty: null,
      terminalJob: null,
      progress: null,
      progressDeliveredRevision: 0,
      worker,
      agentProjectionReconciledAt: null,
      completionPublishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
}

/** Persist one new meaningful closed activity snapshot for a running V3 turn. */
export function publishVersionThreeProgress({ generation, ownerRootId, agentId, jobId, attemptId, progress }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const reduced = validateNativeProgress(progress, "Version-three progress");
  return persist(identity, generation, (previous) => {
    if (previous == null) throw taggedError("not_found", `Version-three job ${identity.jobId} has no durable running record.`);
    assertAttemptMatches(previous, attemptId, identity);
    if (previous.status !== "running") return previous;
    if (previous.progress?.activity === reduced.activity && previous.progress?.toolName === reduced.toolName) return previous;
    return { ...previous, progress: { revision: Number(previous.progress?.revision ?? 0) + 1, ...reduced, updatedAt: nowIso() }, updatedAt: nowIso() };
  });
}

/** Atomically consume one newer V3 progress revision; terminal/unknown never claim. */
export function claimVersionThreeProgress({ generation, ownerRootId, agentId, jobId }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return persist(identity, generation, (previous) => {
    if (previous == null || previous.status !== "running" || previous.progress == null ||
        previous.progress.revision <= previous.progressDeliveredRevision) return previous;
    return { ...previous, progressDeliveredRevision: previous.progress.revision, updatedAt: nowIso() };
  });
}

/**
 * Record that this turn ended without proven, publishable terminal evidence.
 *
 * This is the durable half of every post-acceptance unknown exit: the leases
 * stay held by their own owner, nothing is published, and the record states
 * the exact closed reason so a later operator or a Task 5.6 reconciliation has
 * something to read other than an absence. It never becomes terminal and never
 * synthesizes a status.
 */
export function recordVersionThreeTurnUncertain({
  generation, ownerRootId, agentId, jobId, attemptId, reason, detail = null,
}) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return persist(identity, generation, (previous) => {
    if (previous == null) {
      throw taggedError(
        "not_found",
        `Version-three job ${identity.jobId} has no durable running record to mark uncertain.`
      );
    }
    const candidateAttemptId = assertAttemptMatches(previous, attemptId, identity);
    // A turn that already settled terminally is not made uncertain by a later
    // cleanup failure: the settled fact stays exactly as it was proven.
    if (previous.status !== "running") return previous;
    return {
      ...previous,
      attemptId: candidateAttemptId,
      status: "unknown",
      uncertainty: { reason, detail: sanitizeUncertaintyDetail(detail), recordedAt: nowIso() },
      progress: null,
      updatedAt: nowIso(),
    };
  });
}

/**
 * Make one turn's terminal projection durable, before any Agent projection or
 * completion exists. This is what makes a later reconciliation possible: if
 * publication fails, or the worker dies between the Agent projection and the
 * completion event, the exact receipt is still on disk.
 */
export function recordVersionThreeTurnTerminal({ generation, ownerRootId, agentId, jobId, attemptId, terminalJob }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return persist(identity, generation, (previous) => {
    if (previous == null) {
      throw taggedError(
        "not_found",
        `Version-three job ${identity.jobId} has no durable running record to settle.`
      );
    }
    const candidateAttemptId = assertAttemptMatches(previous, attemptId, identity);
    return {
      ...previous,
      attemptId: candidateAttemptId,
      status: terminalJob?.status,
      uncertainty: null,
      terminalJob,
      progress: null,
      updatedAt: nowIso(),
    };
  });
}

/**
 * Record which durable projections of one terminal record have completed.
 * Marks are monotonic: neither can be withdrawn once written.
 */
export function markVersionThreeTurnProjected({
  generation, ownerRootId, agentId, jobId, agentProjected = false, completionPublished = false,
}) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return persist(identity, generation, (previous) => {
    if (previous == null) {
      throw taggedError("not_found", `Version-three job ${identity.jobId} has no durable record to mark.`);
    }
    const timestamp = nowIso();
    return {
      ...previous,
      agentProjectionReconciledAt: previous.agentProjectionReconciledAt
        ?? (agentProjected ? timestamp : null),
      completionPublishedAt: previous.completionPublishedAt
        ?? (completionPublished ? timestamp : null),
      updatedAt: timestamp,
    };
  });
}

/**
 * The completion-event options one version-three terminal projection derives.
 *
 * Single owner on purpose: the detached worker and the reconciliation pass
 * below must publish byte-identical events for the same record, and the
 * complete final message is stored exactly once -- inside
 * `normalizedTerminalResult` -- so neither caller may fall back to a duplicate
 * copy on the terminal job.
 *
 *   - `finalMessage` is the deliverable, read from its one durable home. An
 *     absent message stays absent so the completion states its own absence
 *     reason instead of re-advertising the bounded summary as an answer.
 *   - `summary` is the record's bounded derived label.
 *   - `detailedResultAvailable`/`resultPointer` are explicitly negative: the
 *     public detailed-result path cannot resolve a version-three record, and
 *     an explicit `null` pointer is a different statement from silence.
 */
export function versionThreeCompletionOptions(terminalJob) {
  const finalMessage = terminalJob?.normalizedTerminalResult?.finalMessage ?? null;
  return {
    detailedResultAvailable: false,
    resultPointer: null,
    ...(finalMessage == null ? {} : { finalMessage }),
    ...(terminalJob?.summary == null ? {} : { summary: terminalJob.summary }),
  };
}

// ---------------------------------------------------------------------------
// Internal reconciliation.
//
// The one recovery path this slice owns: a durable terminal record whose Agent
// projection or completion event never became durable is finished here. It is
// not Driver observation, replay, or worker-loss recovery (Task 5.6): it
// touches only records that already carry proven, publishable terminal
// evidence, and it invokes no Driver, no process, and no live turn.
// ---------------------------------------------------------------------------

/**
 * Finish the durable projections of one terminal version-three record.
 * Idempotent by construction: the Agent store refuses a second finalization
 * of the same job, and the completion event identity is deterministic.
 */
export function reconcileVersionThreeTerminalJob({ generation, record }) {
  if (!V3_TERMINAL_STATUSES.includes(record?.status)) {
    return { reconciled: false, reason: "not_terminal", agentProjected: false, completionPublished: false };
  }
  if (record.agentProjectionReconciledAt && record.completionPublishedAt) {
    return { reconciled: false, reason: "already_reconciled", agentProjected: true, completionPublished: true };
  }
  const store = createAgentStore({
    cwd: record.controlRoot ?? record.workspaceRoot,
    ownerRootId: record.ownerRootId,
    writeGeneration: generation,
  });
  let agentProjected = Boolean(record.agentProjectionReconciledAt);
  let completionPublished = Boolean(record.completionPublishedAt);
  let reason = "reconciled";
  if (!agentProjected) {
    const projection = store.finalizeFromJob(record.terminalJob);
    // `already_finalized` is success for reconciliation: the durable Agent
    // already carries this exact terminal job.
    agentProjected = projection.reconciled || projection.reason === "already_finalized";
    if (!agentProjected) reason = projection.reason ?? "agent_projection_refused";
  }
  if (!completionPublished) {
    const completion = reconcileTerminalJobCompletion(
      record.workspaceRoot,
      record.ownerRootId,
      record.terminalJob,
      versionThreeCompletionOptions(record.terminalJob),
    );
    completionPublished = completion.reconciled || completion.event != null;
    if (!completionPublished) reason = completion.reason ?? "completion_refused";
    if (completionPublished) publishBoundTerminalEvent({ store, agentId: record.agentId, terminalJob: record.terminalJob });
  }
  if (agentProjected || completionPublished) {
    markVersionThreeTurnProjected({
      generation,
      ownerRootId: record.ownerRootId,
      agentId: record.agentId,
      jobId: record.jobId,
      agentProjected,
      completionPublished,
    });
  }
  return { reconciled: agentProjected && completionPublished, reason, agentProjected, completionPublished };
}

/**
 * Reconcile every incompletely projected terminal record one owner root holds.
 * A record whose reconciliation fails is reported and skipped, never thrown,
 * so one unreadable receipt cannot block unrelated recovery.
 */
export function reconcileVersionThreeTerminalJobs({ ownerRootId, generation }) {
  // Stated, never defaulted: reconciliation writes Agent and completion state,
  // so the caller names the generation it is writing as, exactly like every
  // other exported writer here.
  assertVersionThreeWriteAllowed(generation, "Version-three reconciliation");
  const { records, unreadable } = listVersionThreeJobRecords({ ownerRootId });
  const receipts = [];
  for (const record of records) {
    if (!V3_TERMINAL_STATUSES.includes(record.status)) continue;
    if (record.agentProjectionReconciledAt && record.completionPublishedAt) continue;
    try {
      receipts.push({ jobId: record.jobId, ...reconcileVersionThreeTerminalJob({ generation, record }) });
    } catch (error) {
      receipts.push({
        jobId: record.jobId,
        reconciled: false,
        reason: "reconciliation_failed",
        detail: error instanceof Error ? error.message : String(error),
        agentProjected: false,
        completionPublished: false,
      });
    }
  }
  return { receipts, unreadable };
}
