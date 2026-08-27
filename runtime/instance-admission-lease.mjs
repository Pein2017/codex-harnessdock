/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Version-three admission lease schema and atomic engine.
 *
 * `design.md` decision 9 defines three separate admission conflicts: logical
 * Harness-instance capacity, exact native-session exclusivity, and one
 * canonical-workspace behavioral writer. This module is the one narrow owner
 * of every lease's durable schema, identity binding, and atomic engine, so the
 * three kinds cannot silently drift into three different admission rules.
 * `runtime/workspace-writer-lease.mjs` is a thin kind-specific facade over the
 * same engine for the writer lease.
 *
 * Capacity is route/instance admission evidence, not a global concurrency
 * constant and not part of the frozen eight-field version-three route: it is
 * persisted as its own immutable `capacity` snapshot bound *alongside* the
 * full canonical route on the lease record, exactly as Task 5's launch claim
 * will bind both together. A Driver never supplies it directly here; the
 * caller (the future admission/launch seam) is expected to derive it from
 * Driver-validated instance-route evidence, never from a caller-chosen or
 * model-facing constant.
 *
 * This module has no dependency on any Driver module, model-facing selector,
 * or the legacy `session-leases` directory. The existing legacy session lease
 * (`runtime/job-store.mjs`) may reclaim a stale key after local worker
 * inactivity/grace; that stale-owner heuristic is deliberately not reachable
 * from here. A version-three lease is retained on every unknown condition and
 * released only through `releaseLeasesOnSettlement()`'s validated settlement
 * predicate. Exact owner root/Agent/job/route identity alone is never release
 * authority -- it proves who is asking, not whether the turn settled -- so
 * there is deliberately no identity-only release export. No liveness/PID/
 * grace-period signal ever releases one either.
 *
 * A lease's on-disk `key`/`keyFields` are never accepted as caller input: the
 * engine always derives them itself from the kind-specific identity fields
 * (Harness/instance/capacity class, or native session ID, or workspace root),
 * so no internal caller -- including the writer facade -- can ever present a
 * `key` inconsistent with the `keyFields`/route it claims to bind. The same
 * closed derivation is re-verified on every read (`validateLeaseRecord()`),
 * so a hand-edited or misplaced durable file cannot silently drift from the
 * identity its own content claims either.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

import { validateVersionThreeRoute } from "./durable-state-v3.mjs";
import { readLaunchClaim } from "./launch-claim.mjs";
import { assertNativeReferenceEnvelopeShape } from "./native-reference.mjs";
import { assertHarnessId, canonicalNativeSessionRef } from "./harness-contract.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { plainRecordSnapshot } from "./plain-record.mjs";
import {
  getProcessIdentity,
  isProcessAlive,
  validateProcessIdentity,
} from "./process-control.mjs";
import { classifyTurnSettlement } from "./turn-settlement.mjs";

export const LEASE_SCHEMA_VERSION = 1;
export const LEASE_KINDS = Object.freeze(["instance", "native_session", "writer"]);

/** The one and only evidence class this generation may release a lease with. */
export const SETTLEMENT_EVIDENCE_CLASS = "native_terminal_and_settled_execution_evidence";

const MAX_IDENTITY_TEXT_BYTES = 256;
const MAX_CAPACITY_LIMIT = 64;
const MAX_KEY_TEXT_BYTES = 1024;
const MAX_WORKSPACE_ROOT_BYTES = 4096;
const INSTANCE_LEASE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CAPACITY_CLASS_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// C0/C1 controls plus the soft hyphen, zero-width, bidi-override, and
// byte-order-mark ranges, exactly as `runtime/durable-state-v3.mjs` bounds
// route identity text: identity that can render as another identity is not
// identity, so it is refused rather than normalized.
// eslint-disable-next-line no-control-regex
const UNSTABLE_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function nowIso() {
  return new Date().toISOString();
}

function taggedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertIdentityText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty text.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not carry leading or trailing whitespace.`);
  }
  if (UNSTABLE_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} must not contain control or format characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTITY_TEXT_BYTES) {
    throw new Error(`${label} exceeds its durable bound.`);
  }
  return value;
}

/** @param {Record<string, *>} candidate */
function assertBindingIdentity({ ownerRootId, agentId, jobId }) {
  return {
    ownerRootId: assertIdentityText(ownerRootId, "Lease owner root ID"),
    agentId: assertIdentityText(agentId, "Lease Agent ID"),
    jobId: assertIdentityText(jobId, "Lease job ID"),
  };
}

function assertLeaseKind(kind) {
  if (!LEASE_KINDS.includes(kind)) {
    throw new Error(`Unsupported lease kind: ${JSON.stringify(kind ?? null)}. Use one of: ${LEASE_KINDS.join(", ")}.`);
  }
  return kind;
}

function assertCapacityLimit(capacityLimit) {
  if (!Number.isInteger(capacityLimit) || capacityLimit < 1 || capacityLimit > MAX_CAPACITY_LIMIT) {
    throw new Error(`Lease capacity limit must be an integer between 1 and ${MAX_CAPACITY_LIMIT}.`);
  }
  return capacityLimit;
}

function assertCapacityClass(value) {
  if (typeof value !== "string" || !CAPACITY_CLASS_PATTERN.test(value)) {
    throw new Error(`Instance lease capacity class must be a stable redacted identity: ${JSON.stringify(value ?? null)}.`);
  }
  return value;
}

function assertInstanceKey(value) {
  if (typeof value !== "string" || !INSTANCE_LEASE_KEY_PATTERN.test(value)) {
    throw new Error(`Lease Harness instance key must be a stable redacted identity: ${JSON.stringify(value ?? null)}.`);
  }
  return value;
}

function assertNativeSessionIdText(value) {
  if (typeof value !== "string" || !NATIVE_SESSION_ID_PATTERN.test(value)) {
    throw new Error(`Invalid native session ID: ${JSON.stringify(value ?? null)}.`);
  }
  return value;
}

function assertWorkspaceRootText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty text.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not carry leading or trailing whitespace.`);
  }
  if (value.includes("\0") || UNSTABLE_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} must not contain control or format characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_ROOT_BYTES) {
    throw new Error(`${label} exceeds its durable bound.`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return value;
}

function assertTimestampText(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact ISO-8601 millisecond timestamp.`);
  }
  return value;
}

/**
 * The one immutable capacity/instance-admission snapshot a lease binds
 * alongside its full canonical route. Only the `instance` kind carries a
 * caller-declared capacity class and limit; `native_session` and `writer`
 * are structurally single-holder kinds, so their capacity is the fixed fact
 * `{ class: null, limit: 1 }` rather than caller-suppliable evidence.
 */
function assertCapacityEvidence(kind, { capacityClass, capacityLimit }) {
  assertCapacityLimit(capacityLimit);
  if (kind === "instance") {
    return Object.freeze({ class: assertCapacityClass(capacityClass), limit: capacityLimit });
  }
  if (capacityClass != null) {
    throw new Error(`Lease kind ${kind} does not admit a capacity class; its capacity is a fixed single holder.`);
  }
  if (capacityLimit !== 1) {
    throw new Error(`Lease kind ${kind} must declare capacity limit 1 (single exclusive holder).`);
  }
  return Object.freeze({ class: null, limit: 1 });
}

/**
 * Every instance/native-session lease key states the exact Harness and
 * logical instance it admits; that key must equal the bound route's own
 * Harness/instance, never a caller-chosen alias of it. A writer lease has no
 * Harness/instance in its key, but the same "the key must be the truth the
 * route already states" rule applies to its one relevant route fact instead:
 * a writer lease may only be bound to a `behavioral_write` route.
 */
function assertKeyFieldsMatchRoute(kind, keyFields, route) {
  if (kind === "instance" || kind === "native_session") {
    if (keyFields.harnessId !== route.harnessId) {
      throw new Error(
        `Lease ${kind} key names Harness ${JSON.stringify(keyFields.harnessId ?? null)}, which does not match ` +
        `its bound route's Harness ${route.harnessId}.`
      );
    }
    if (keyFields.instanceKey !== route.instanceKey) {
      throw new Error(
        `Lease ${kind} key names instance ${JSON.stringify(keyFields.instanceKey ?? null)}, which does not match ` +
        `its bound route's instance ${route.instanceKey}.`
      );
    }
    return;
  }
  if (route.authority !== "behavioral_write") {
    throw new Error(
      `A canonical-workspace writer lease requires a behavioral_write route; the bound route declares ` +
      `authority ${route.authority}.`
    );
  }
}

// ---------------------------------------------------------------------------
// Kind-specific key derivation. This is the *only* place `key`/`keyFields`
// are produced; neither is ever accepted as caller input anywhere else in
// this module, so no internal caller -- including the writer facade -- can
// present a `key` inconsistent with its own `keyFields`. `keyText*()` are
// pure text builders with no I/O, reused by both derivation (acquire) and
// re-verification (read); only `writerLeaseDescriptor()` touches the
// filesystem, and only at acquire time.
// ---------------------------------------------------------------------------

function instanceKeyText(harnessId, instanceKey, capacityClass) {
  return `instance\0${harnessId}\0${instanceKey}\0${capacityClass}`;
}

function nativeSessionKeyText(harnessId, instanceKey, nativeSessionId) {
  return `native_session\0${harnessId}\0${instanceKey}\0${nativeSessionId}`;
}

function writerKeyText(canonicalWorkspaceRootText) {
  return `writer\0${canonicalWorkspaceRootText}`;
}

function instanceLeaseDescriptor({ harnessId, instanceKey, capacityClass }) {
  const canonicalHarnessId = assertHarnessId(harnessId);
  const canonicalInstanceKey = assertInstanceKey(instanceKey);
  const canonicalCapacityClass = assertCapacityClass(capacityClass);
  return {
    keyText: instanceKeyText(canonicalHarnessId, canonicalInstanceKey, canonicalCapacityClass),
    keyFields: Object.freeze({ harnessId: canonicalHarnessId, instanceKey: canonicalInstanceKey }),
    capacityClass: canonicalCapacityClass,
  };
}

function nativeSessionLeaseDescriptor({ harnessId, instanceKey, nativeSessionId }) {
  // Reuse the Harness-neutral pure validator/canonicalizer only; the legacy
  // `harnessSessionKey()` special-cases `claude-code` for pre-Harness lease
  // compatibility, which a version-three lease must never inherit.
  const reference = canonicalNativeSessionRef({ harnessId, instanceKey, nativeSessionId });
  assertNativeSessionIdText(reference.nativeSessionId);
  return {
    keyText: nativeSessionKeyText(reference.harnessId, reference.instanceKey, reference.nativeSessionId),
    keyFields: Object.freeze({
      harnessId: reference.harnessId,
      instanceKey: reference.instanceKey,
      nativeSessionId: reference.nativeSessionId,
    }),
  };
}

function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new Error("Writer lease workspace root must be non-empty text.");
  }
  // Operator-prepared canonical worktrees already exist; a writer lease never
  // canonicalizes a path that does not resolve, unlike the legacy session
  // lease's best-effort fallback -- symlink/path aliasing must fail closed,
  // not silently collide or silently diverge.
  return fs.realpathSync.native(workspaceRoot);
}

function writerLeaseDescriptor({ workspaceRoot }) {
  const canonical = assertWorkspaceRootText(canonicalWorkspaceRoot(workspaceRoot), "Writer lease workspace root");
  return {
    keyText: writerKeyText(canonical),
    keyFields: Object.freeze({ workspaceRoot: canonical }),
  };
}

function resolveDescriptorForTarget(target) {
  const kind = assertLeaseKind(target?.kind);
  if (kind === "instance") return { kind, ...instanceLeaseDescriptor(target) };
  if (kind === "native_session") return { kind, ...nativeSessionLeaseDescriptor(target) };
  return { kind, ...writerLeaseDescriptor(target) };
}

/**
 * The release-time counterpart to `resolveDescriptorForTarget()`. Acquisition
 * canonicalizes a writer's `workspaceRoot` against the live filesystem
 * (`writerLeaseDescriptor()`), because it is the one moment a caller-given
 * path must be proven real. Release happens later, often after the turn's
 * own workspace has already been torn down, so `releaseLeasesOnSettlement()`
 * must not repeat that live realpath: it already holds the record's own
 * previously canonicalized `keyFields.workspaceRoot` text (round-tripped
 * through the acquisition receipt), and re-touching a since-removed
 * directory would turn a legitimate release into a spurious `ENOENT`. This
 * still fully re-validates the text's shape (`assertWorkspaceRootText`) and
 * derives the key the exact same way (`writerKeyText`); it only skips the
 * filesystem round-trip. Instance/native-session descriptors do no I/O
 * either way, so they are resolved identically at acquire and release.
 */
function releaseDescriptorForTarget(target) {
  const kind = assertLeaseKind(target?.kind);
  if (kind === "instance") return { kind, ...instanceLeaseDescriptor(target) };
  if (kind === "native_session") return { kind, ...nativeSessionLeaseDescriptor(target) };
  const canonicalWorkspaceRootText = assertWorkspaceRootText(
    target?.workspaceRoot, "Writer lease workspace root"
  );
  return {
    kind,
    keyText: writerKeyText(canonicalWorkspaceRootText),
    keyFields: Object.freeze({ workspaceRoot: canonicalWorkspaceRootText }),
  };
}

// ---------------------------------------------------------------------------
// On-disk layout and owner-only atomic primitives. The mutex pattern below
// (0700 directories, `wx`-then-`linkSync` lock publication, fsync, stale-lock
// recovery keyed to process identity) mirrors the accepted conventions in
// `runtime/agent-store.mjs` and `runtime/job-store.mjs`. It protects the lease
// *directory* against concurrent writers; it never decides whether a lease
// itself is still owned, so it carries no bearing on R9 (the legacy session
// lease's local-inactivity reclaim policy stays out of this module entirely).
// ---------------------------------------------------------------------------

/**
 * `stateRoot` is an explicit override for read-only inventory callers (the
 * established operator-diagnostics surface already resolves its own plugin
 * state root from `options.pluginDataRoot`/`CODEX_HOME`); every mutating
 * entry point below always uses the live env-configured root and never
 * accepts this override, so acquisition/release can never be pointed at an
 * operator-chosen location.
 * @param {string} [stateRoot]
 */
function resolveLeaseRoot(stateRoot) {
  return path.join(stateRoot ?? resolvePluginStateRoot(), "leases", `v${LEASE_SCHEMA_VERSION}`);
}

/** @param {string} [stateRoot] */
function resolveLeaseKeyDirectory(kind, keyText, stateRoot) {
  const digest = createHash("sha256").update(keyText).digest("hex");
  return path.join(resolveLeaseRoot(stateRoot), kind, digest);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
  }
  return directory;
}

const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_IDENTITY_FAILURE_GRACE_MS = 1_000;
const LOCK_RETRY_MIN_DELAY_MS = 10;
const LOCK_RETRY_MAX_DELAY_MS = 50;

function sleepSync(ms) {
  const bounded = Math.max(0, Math.min(Number(ms) || 0, 1_000));
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, bounded);
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function recoverStaleDirectoryLock(lockFile) {
  if (!fs.existsSync(lockFile)) return false;
  let observedStat = null;
  try {
    observedStat = fs.statSync(lockFile);
    const lockData = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const ageMs = Date.now() - Number(lockData.timestamp ?? observedStat.mtimeMs);
    const ownerPid = Number(lockData.pid);
    const ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid);
    const ownerMatch = lockData.identity != null && validateProcessIdentity(ownerPid, lockData.identity);
    const transientProbeGrace = ownerAlive && Number.isFinite(ageMs) && ageMs <= LOCK_IDENTITY_FAILURE_GRACE_MS;
    if (ownerMatch || transientProbeGrace) return false;
  } catch { /* fall through to reclaim */ }
  try {
    const currentStat = fs.statSync(lockFile);
    if (observedStat && !sameFileIdentity(observedStat, currentStat)) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

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
        throw Object.assign(new Error(`Timed out acquiring lease directory lock ${lockFile}.`), { code: "ETIMEDOUT" });
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

function writeAtomicLeaseFile(filePath, data, { createOnly = false } = {}) {
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
    if (createOnly) {
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, filePath);
    }
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
// Closed durable lease-record validator. Every record this module ever
// writes is also read back through this exact validator before it is
// returned or written again (see `acquireLease()`), so persistence never
// diverges from what a later read will accept. A record that fails any of
// these checks is refused before it can block or falsely occupy capacity,
// and it is never deleted -- corruption fails closed, not silently repaired.
// ---------------------------------------------------------------------------

const LEASE_RECORD_FIELDS = Object.freeze([
  "version", "kind", "key", "keyFields", "ownerRootId", "agentId", "jobId", "route", "capacity", "createdAt", "updatedAt",
]);
const CAPACITY_FIELDS = Object.freeze(["class", "limit"]);
const KEY_FIELDS_BY_KIND = Object.freeze({
  instance: Object.freeze(["harnessId", "instanceKey"]),
  native_session: Object.freeze(["harnessId", "instanceKey", "nativeSessionId"]),
  writer: Object.freeze(["workspaceRoot"]),
});

function assertClosedFieldSet(snapshot, expectedFields, label) {
  for (const field of Object.keys(snapshot)) {
    if (!expectedFields.includes(field)) throw new Error(`${label} declares an unknown field: ${field}.`);
  }
  for (const field of expectedFields) {
    if (!(field in snapshot)) throw new Error(`${label} is missing required field: ${field}.`);
  }
}

function recomputeKeyText(kind, keyFields, capacity) {
  if (kind === "instance") return instanceKeyText(keyFields.harnessId, keyFields.instanceKey, capacity.class);
  if (kind === "native_session") {
    return nativeSessionKeyText(keyFields.harnessId, keyFields.instanceKey, keyFields.nativeSessionId);
  }
  return writerKeyText(keyFields.workspaceRoot);
}

function validateLeaseRecordKeyFields(kind, keyFields, label) {
  const snapshot = plainRecordSnapshot(keyFields, label);
  assertClosedFieldSet(snapshot, KEY_FIELDS_BY_KIND[kind], label);
  if (kind === "instance" || kind === "native_session") {
    if (assertHarnessId(snapshot.harnessId) !== snapshot.harnessId) {
      throw new Error(`${label} harnessId must be stated exactly.`);
    }
    assertInstanceKey(snapshot.instanceKey);
    if (kind === "native_session") assertNativeSessionIdText(snapshot.nativeSessionId);
    return Object.freeze({ ...snapshot });
  }
  assertWorkspaceRootText(snapshot.workspaceRoot, `${label} workspaceRoot`);
  return Object.freeze({ ...snapshot });
}

function validateLeaseRecordCapacity(kind, capacity, label) {
  const snapshot = plainRecordSnapshot(capacity, label);
  assertClosedFieldSet(snapshot, CAPACITY_FIELDS, label);
  return assertCapacityEvidence(kind, { capacityClass: snapshot.class, capacityLimit: snapshot.limit });
}

/**
 * Validate one durable lease record structurally, independent of where it
 * was read from: closed top-level field set, plain (non-Proxy, non-accessor)
 * shape throughout, a schema version this runtime understands, bounded
 * identity text, a route that re-passes the full version-three route
 * validator, an immutable capacity snapshot appropriate to its kind, exact
 * key/keyFields/route consistency, and bounded ISO timestamps. Returns a
 * freshly rebuilt, fully frozen canonical record -- never the parsed input.
 */
function validateLeaseRecord(parsed) {
  const label = "Lease record";
  const snapshot = plainRecordSnapshot(parsed, label);
  assertClosedFieldSet(snapshot, LEASE_RECORD_FIELDS, label);
  if (snapshot.version !== LEASE_SCHEMA_VERSION) {
    throw taggedError(
      "unsupported_version",
      `${label} declares unsupported schema version ${JSON.stringify(snapshot.version ?? null)}.`
    );
  }
  const kind = assertLeaseKind(snapshot.kind);
  const identity = assertBindingIdentity(snapshot);
  if (typeof snapshot.key !== "string" || !snapshot.key || Buffer.byteLength(snapshot.key, "utf8") > MAX_KEY_TEXT_BYTES) {
    throw new Error(`${label} key must be bounded non-empty text.`);
  }
  const route = validateVersionThreeRoute(snapshot.route, `${label} route`);
  const keyFields = validateLeaseRecordKeyFields(kind, snapshot.keyFields, `${label} key fields`);
  const capacity = validateLeaseRecordCapacity(kind, snapshot.capacity, `${label} capacity`);
  assertKeyFieldsMatchRoute(kind, keyFields, route);
  const recomputedKey = recomputeKeyText(kind, keyFields, capacity);
  if (recomputedKey !== snapshot.key) {
    throw taggedError(
      "identity_drift",
      `${label} key does not match the key its own key fields/capacity derive; possible identity drift.`
    );
  }
  const createdAt = assertTimestampText(snapshot.createdAt, `${label} createdAt`);
  const updatedAt = assertTimestampText(snapshot.updatedAt, `${label} updatedAt`);
  return Object.freeze({
    version: LEASE_SCHEMA_VERSION,
    kind,
    key: snapshot.key,
    keyFields,
    ownerRootId: identity.ownerRootId,
    agentId: identity.agentId,
    jobId: identity.jobId,
    route,
    capacity,
    createdAt,
    updatedAt,
  });
}

function holderIdentityDigest({ kind, keyText, ownerRootId, agentId, jobId, routeText }) {
  return createHash("sha256")
    .update(`${kind}\0${keyText}\0${ownerRootId}\0${agentId}\0${jobId}\0${routeText}`)
    .digest("hex");
}

/**
 * Read and validate one durable holder record. Beyond `validateLeaseRecord()`
 * itself, this additionally proves the record was not moved, copied, or
 * hand-placed somewhere other than the exact directory/filename its own kind
 * and identity derive -- "identity drift" at the filesystem level, not just
 * within the record's own fields. A parse, shape, or drift failure throws
 * rather than being silently skipped: an unreadable or misplaced record must
 * never be treated as absent capacity, and it is never deleted to make room
 * for a new admission. Every thrown error carries a closed `.code`; only that
 * code -- never the message, which may name the local file path -- is safe
 * to surface from a read-only diagnostic. `stateRoot`, when given, is the
 * same explicit override `inspectLeaseInventory()` accepts, so the drift
 * check below re-derives the expected location against the root the caller
 * actually walked, not a second, independently (and possibly no longer
 * live-env-configured) resolved one.
 * @param {string} filePath
 * @param {string} [stateRoot]
 */
function readHolderFile(filePath, stateRoot) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw taggedError("corrupt_or_unreadable", `Lease record ${filePath} is unreadable: ${error?.message ?? error}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw taggedError("corrupt_json", `Lease record ${filePath} is corrupt: invalid JSON.`);
  }
  let record;
  try {
    record = validateLeaseRecord(parsed);
  } catch (error) {
    throw taggedError(error.code ?? "invalid_shape", `Lease record ${filePath} is corrupt: ${error.message}`);
  }
  const expectedDir = resolveLeaseKeyDirectory(record.kind, record.key, stateRoot);
  const expectedDigest = holderIdentityDigest({
    kind: record.kind,
    keyText: record.key,
    ownerRootId: record.ownerRootId,
    agentId: record.agentId,
    jobId: record.jobId,
    routeText: JSON.stringify(record.route),
  });
  if (path.dirname(filePath) !== expectedDir || path.basename(filePath, ".json") !== expectedDigest) {
    throw taggedError(
      "identity_drift",
      `Lease record ${filePath} does not live at the directory/filename its own identity derives.`
    );
  }
  return record;
}

/** @param {string} [stateRoot] */
function readHolderFiles(directory, stateRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const holders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    holders.push({ filePath, record: readHolderFile(filePath, stateRoot) });
  }
  return holders;
}

function assertSameLeaseIdentity(record, { kind, keyText, ownerRootId, agentId, jobId, routeText }) {
  if (
    record.kind !== kind ||
    record.key !== keyText ||
    record.ownerRootId !== ownerRootId ||
    record.agentId !== agentId ||
    record.jobId !== jobId ||
    JSON.stringify(record.route) !== routeText
  ) {
    throw new Error(
      `Lease record identity mismatch for ${kind}:${keyText}; a lease may only be re-read or released by the ` +
      `exact owner root, Agent, job, and route that acquired it.`
    );
  }
}

function assertDurableLaunchIntent({ kind, keyFields, capacity, identity, route, attemptId }) {
  const claim = readLaunchClaim(identity);
  const intended = claim?.leaseIntent;
  const receipt = Array.isArray(intended) && intended.length === 1 ? intended[0] : null;
  const routeDigest = createHash("sha256").update(JSON.stringify(route)).digest("hex");
  if (
    claim?.attemptId !== attemptId ||
    claim?.acceptance !== "not_submitted" ||
    claim?.submissionState !== "not_started" ||
    claim?.leaseState !== "intended" ||
    receipt?.kind !== kind ||
    receipt?.ownerRootId !== identity.ownerRootId ||
    receipt?.agentId !== identity.agentId ||
    receipt?.jobId !== identity.jobId ||
    receipt?.routeDigest !== routeDigest ||
    JSON.stringify(receipt?.keyFields) !== JSON.stringify(keyFields) ||
    JSON.stringify(receipt?.capacity) !== JSON.stringify(capacity) ||
    JSON.stringify(claim?.route) !== JSON.stringify(route)
  ) {
    throw taggedError(
      "launch_intent_not_acquirable",
      "Lease acquisition requires the exact durable rollback-safe launch intent."
    );
  }
}

// ---------------------------------------------------------------------------
// Low-level engine, shared by every kind-specific facade and by
// `runtime/workspace-writer-lease.mjs`. `key`/`keyFields` are always derived
// internally by `resolveDescriptorForTarget()`; neither can be supplied
// directly by any caller.
// ---------------------------------------------------------------------------

/**
 * Acquire one lease. Idempotent for the exact same owner root/Agent/job/route
 * identity; deterministic capacity admission for a distinct identity; fails
 * closed (without deleting anything) on a corrupt existing record, an
 * unreadable route, a key whose Harness/instance/authority is not what the
 * bound route actually states, or a capacity-evidence conflict between
 * callers of the same key.
 *
 * @param {{kind: string, ownerRootId: string, agentId: string, jobId: string, route: *,
 *   capacityLimit: number, capacityClass?: (string|null), harnessId?: string, instanceKey?: string,
 *   nativeSessionId?: string, workspaceRoot?: string, launchAttemptId?: string|null}} input Only the fields the given `kind`'s
 *   descriptor needs are read; the rest are ignored, exactly like `resolveDescriptorForTarget()`.
 */
export function acquireLease({
  kind,
  ownerRootId,
  agentId,
  jobId,
  route,
  capacityLimit,
  capacityClass = null,
  harnessId,
  instanceKey,
  nativeSessionId,
  workspaceRoot,
  launchAttemptId = null,
}) {
  const { keyText, keyFields } = resolveDescriptorForTarget({
    kind, harnessId, instanceKey, capacityClass, nativeSessionId, workspaceRoot,
  });
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const canonicalRoute = validateVersionThreeRoute(route, "Lease route");
  assertKeyFieldsMatchRoute(kind, keyFields, canonicalRoute);
  const capacity = assertCapacityEvidence(kind, { capacityClass, capacityLimit });
  const routeText = JSON.stringify(canonicalRoute);

  const keyDir = resolveLeaseKeyDirectory(kind, keyText);
  const lock = acquireDirectoryLock(keyDir);
  try {
    if (launchAttemptId != null) {
      assertDurableLaunchIntent({
        kind,
        keyFields,
        capacity,
        identity,
        route: canonicalRoute,
        attemptId: assertIdentityText(launchAttemptId, "Launch intent attempt ID"),
      });
    }
    const holderDigest = holderIdentityDigest({ kind, keyText, ...identity, routeText });
    const holderFile = path.join(keyDir, `${holderDigest}.json`);
    const existing = readHolderFiles(keyDir);
    const mine = existing.find((holder) => holder.filePath === holderFile);
    if (mine) {
      assertSameLeaseIdentity(mine.record, { kind, keyText, ...identity, routeText });
      if (mine.record.capacity.limit !== capacity.limit || mine.record.capacity.class !== capacity.class) {
        throw new Error(
          `Lease ${kind}:${keyText} capacity evidence conflict: this holder previously declared capacity ` +
          `${JSON.stringify(mine.record.capacity)}, now declares ${JSON.stringify(capacity)}.`
        );
      }
      const refreshed = validateLeaseRecord({ ...mine.record, updatedAt: nowIso() });
      writeAtomicLeaseFile(holderFile, refreshed);
      return brandAcquisitionEvidence(refreshed);
    }
    for (const holder of existing) {
      if (holder.record.capacity.limit !== capacity.limit) {
        throw new Error(
          `Lease ${kind}:${keyText} capacity evidence conflict: an existing holder declares capacity limit ` +
          `${holder.record.capacity.limit}, this admission declares ${capacity.limit}.`
        );
      }
    }
    if (existing.length >= capacity.limit) {
      throw Object.assign(
        new Error(`Lease ${kind}:${keyText} capacity exhausted (${existing.length}/${capacity.limit}).`),
        { code: "lease_capacity_exhausted", kind, key: keyText }
      );
    }
    const record = validateLeaseRecord({
      version: LEASE_SCHEMA_VERSION,
      kind,
      key: keyText,
      keyFields,
      ownerRootId: identity.ownerRootId,
      agentId: identity.agentId,
      jobId: identity.jobId,
      route: canonicalRoute,
      capacity,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    writeAtomicLeaseFile(holderFile, record, { createOnly: true });
    return brandAcquisitionEvidence(record);
  } finally {
    releaseDirectoryLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Brand-gated acquisition evidence (Task 5.3 correction pass).
//
// A caller elsewhere in the same process (`runtime/launch-claim.mjs`) needs
// to durably bind proof that it genuinely holds a lease, without this module
// exporting its private record validator or key-derivation logic (which
// would let a caller reconstruct/forge a plausible-looking record). The
// brand below is the narrow seam for exactly that: it accepts only the
// *exact* object reference `acquireLease()`/`acquireInstanceLease()`/
// `acquireNativeSessionLease()` (and, via `runtime/workspace-writer-lease.mjs`,
// `acquireWorkspaceWriterLease()`) returned to *this* caller in *this*
// process, and returns a canonical immutable stable projection safe to
// persist.
//
// `WeakMap.prototype.get()`/`.has()` compare object identity internally
// (SameValueZero on the actual reference), never invoking a `get`/`has`
// trap, a getter, or `toJSON` -- so a Proxy wrapping a genuinely branded
// record, a structurally identical clone, or any other object that is not
// literally the same reference is refused with zero hook execution, before
// any of its own properties are ever read.
// ---------------------------------------------------------------------------

/** Every successful acquire/re-acquire's exact returned object, keyed by identity. */
const ACQUISITION_EVIDENCE = new WeakMap();

/** The closed, stable (no volatile timestamps) field set `acquiredLeaseEvidence()` projects. */
export const LEASE_ACQUISITION_EVIDENCE_FIELDS = Object.freeze([
  "kind", "key", "keyFields", "capacity", "route", "ownerRootId", "agentId", "jobId",
]);

/**
 * Brand one successful acquire/re-acquire's exact returned record with its
 * canonical stable evidence projection, then return that same record
 * unchanged. Every `acquireLease()` return path calls this before returning;
 * no other function ever populates `ACQUISITION_EVIDENCE`.
 */
function brandAcquisitionEvidence(record) {
  const evidence = Object.freeze({
    kind: record.kind,
    key: record.key,
    keyFields: record.keyFields,
    capacity: record.capacity,
    route: record.route,
    ownerRootId: record.ownerRootId,
    agentId: record.agentId,
    jobId: record.jobId,
  });
  ACQUISITION_EVIDENCE.set(record, evidence);
  return record;
}

/**
 * The exact brand-gated evidence seam a caller elsewhere in this process
 * uses to durably record proof of a real, currently held lease. Accepts
 * only the exact object reference a successful `acquireLease()` family call
 * returned to this same process; a plain object, a structural clone, a
 * Proxy, a foreign object, or a stale reference from an unrelated call is
 * refused identically and before any of its properties are read. Volatile
 * bookkeeping timestamps (`createdAt`/`updatedAt`) are deliberately excluded
 * from the returned projection: a caller computing a stable digest over it
 * needs no separate exclusion step, and a benign concurrent re-acquire
 * (which only ever changes `updatedAt`) always yields byte-identical
 * evidence for the same real lease.
 *
 * @param {*} record
 * @returns {Readonly<{kind: string, key: string, keyFields: object, capacity: object,
 *   route: object, ownerRootId: string, agentId: string, jobId: string}>}
 */
export function acquiredLeaseEvidence(record) {
  const evidence = (record !== null && typeof record === "object") ? ACQUISITION_EVIDENCE.get(record) : undefined;
  if (!evidence) {
    throw new Error(
      "Lease acquisition evidence requires the exact object reference a successful acquireLease()/" +
      "acquireInstanceLease()/acquireNativeSessionLease()/acquireWorkspaceWriterLease() call returned in this " +
      "process; a plain, cloned, Proxy, foreign, or stale object is never accepted as lease authority."
    );
  }
  return evidence;
}

/**
 * There is deliberately no exported identity-only release function. Exact
 * owner root/Agent/job/route identity proves *who* is asking, never *whether
 * the turn settled*; a release path gated on identity alone could delete an
 * active or unknown lease and falsify the 4.3 retention guarantee. The one
 * public release surface below the low-level engine is
 * `releaseLeasesOnSettlement()`: every release, single or batch, is gated on
 * the same validated settlement predicate the completion-delivery seam uses.
 * A pre-native-submission rollback is the distinct narrow exception: the
 * launch-claim state machine must already own its durable rollback fence, and
 * `releaseLeasesForPreSubmissionRollback()` releases only the exact bindings
 * stored in that still-current claim.
 */

// ---------------------------------------------------------------------------
// Kind-specific facades.
// ---------------------------------------------------------------------------

export function acquireInstanceLease({
  ownerRootId, agentId, jobId, route, harnessId, instanceKey, capacityClass, capacityLimit,
}) {
  return acquireLease({
    kind: "instance", ownerRootId, agentId, jobId, route, harnessId, instanceKey, capacityClass, capacityLimit,
  });
}

export function acquireNativeSessionLease({
  ownerRootId, agentId, jobId, route, harnessId, instanceKey, nativeSessionId,
}) {
  return acquireLease({
    kind: "native_session", ownerRootId, agentId, jobId, route, harnessId, instanceKey, nativeSessionId, capacityLimit: 1,
  });
}

export function acquireIntendedInstanceLease({
  ownerRootId, agentId, jobId, attemptId, route, harnessId, instanceKey, capacityClass, capacityLimit,
}) {
  return acquireLease({
    kind: "instance",
    ownerRootId,
    agentId,
    jobId,
    route,
    harnessId,
    instanceKey,
    capacityClass,
    capacityLimit,
    launchAttemptId: attemptId,
  });
}

export function acquireIntendedNativeSessionLease({
  ownerRootId, agentId, jobId, attemptId, route, harnessId, instanceKey, nativeSessionId,
}) {
  return acquireLease({
    kind: "native_session",
    ownerRootId,
    agentId,
    jobId,
    route,
    harnessId,
    instanceKey,
    nativeSessionId,
    capacityLimit: 1,
    launchAttemptId: attemptId,
  });
}

function rollbackReleasePlan(binding, boundRoute = null) {
  const target = {
    kind: binding.kind,
    ownerRootId: binding.ownerRootId,
    agentId: binding.agentId,
    jobId: binding.jobId,
    route: binding.route ?? boundRoute,
    ...(binding.kind === "instance" ? {
      harnessId: binding.keyFields.harnessId,
      instanceKey: binding.keyFields.instanceKey,
      capacityClass: binding.capacity.class,
    } : binding.kind === "native_session" ? {
      harnessId: binding.keyFields.harnessId,
      instanceKey: binding.keyFields.instanceKey,
      nativeSessionId: binding.keyFields.nativeSessionId,
    } : {
      workspaceRoot: binding.keyFields.workspaceRoot,
    }),
  };
  const { kind, keyText } = releaseDescriptorForTarget(target);
  const identity = assertBindingIdentity(target);
  const route = validateVersionThreeRoute(target.route, "Rollback lease route");
  const routeText = JSON.stringify(route);
  const keyDir = resolveLeaseKeyDirectory(kind, keyText);
  return {
    kind,
    keyText,
    identity,
    routeText,
    keyDir,
    holderFile: path.join(keyDir, `${holderIdentityDigest({ kind, keyText, ...identity, routeText })}.json`),
  };
}

/**
 * Release only the exact durable bindings of a claim whose rollback fence
 * already owns native submission. Missing holder files are idempotent success.
 */
export function releaseLeasesForPreSubmissionRollback({ claim }) {
  if (
    claim == null || typeof claim !== "object" || types.isProxy(claim) ||
    claim.submissionState !== "rollback_in_progress" ||
    !(claim.acceptance === "acceptance_rejected" || claim.acceptance === "not_submitted")
  ) {
    throw new Error("Pre-submission lease release requires a rollback-in-progress launch claim.");
  }
  if (!Array.isArray(claim.leaseBindings) || !Array.isArray(claim.leaseIntent) || claim.leaseIntent.length === 0) {
    throw new Error("Pre-submission rollback claim has no exact lease intent.");
  }
  const durable = readLaunchClaim({
    ownerRootId: claim.ownerRootId,
    agentId: claim.agentId,
    jobId: claim.jobId,
  });
  if (!durable || JSON.stringify(durable) !== JSON.stringify(claim)) {
    throw new Error("Pre-submission lease release requires the exact durable rollback claim.");
  }
  const bindings = claim.leaseBindings.length === 0 ? claim.leaseIntent : claim.leaseBindings;
  const plans = bindings.map((binding) => rollbackReleasePlan(binding, claim.route));
  const locks = [];
  try {
    for (const keyDir of [...new Set(plans.map((plan) => plan.keyDir))].sort()) {
      locks.push(acquireDirectoryLock(keyDir));
    }
    for (const plan of plans) {
      if (!fs.existsSync(plan.holderFile)) continue;
      const record = readHolderFile(plan.holderFile);
      assertSameLeaseIdentity(record, {
        kind: plan.kind,
        keyText: plan.keyText,
        ...plan.identity,
        routeText: plan.routeText,
      });
      fs.unlinkSync(plan.holderFile);
    }
    return Object.freeze({ outcome: "all", released: true });
  } finally {
    for (const lock of locks) releaseDirectoryLock(lock);
  }
}

/** Undo an in-process acquisition when no launch claim was durably created. */
export function releaseUnclaimedLeaseAcquisition(record) {
  const binding = acquiredLeaseEvidence(record);
  const plan = rollbackReleasePlan(binding);
  const lock = acquireDirectoryLock(plan.keyDir);
  try {
    if (!fs.existsSync(plan.holderFile)) return Object.freeze({ released: true, alreadyReleased: true });
    const stored = readHolderFile(plan.holderFile);
    assertSameLeaseIdentity(stored, {
      kind: plan.kind,
      keyText: plan.keyText,
      ...plan.identity,
      routeText: plan.routeText,
    });
    fs.unlinkSync(plan.holderFile);
    return Object.freeze({ released: true, alreadyReleased: false });
  } finally {
    releaseDirectoryLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Settlement-gated batch release (4.3).
//
// This reuses `runtime/turn-settlement.mjs`'s `classifyTurnSettlement()` --
// the exact same publication predicate `runtime/completion-inbox.mjs` gates
// completion delivery with -- so a lease can never be released under a looser
// settlement rule than the one that publishes a completion.
//
// `assertNativeReferenceEnvelopeShape()` (imported from the Driver-agnostic
// `native-reference.mjs`) proves only the core-owned envelope shape: the
// exact six-field record and its outer `version` field
// (`NATIVE_REFERENCE_ENVELOPE_VERSION`). It does NOT and cannot prove that
// the envelope's Driver-owned `locatorVersion`/`locator` content is one a
// real Driver recognizes -- only `driver.validateNativeSessionRef()` /
// `validateNativeTurnRef()` can do that, and this module deliberately never
// imports a Driver. A structurally well-formed envelope naming a
// Driver-unrecognized locator therefore is NOT caught here; it must already
// have been rejected upstream by `validateNormalizedTerminalResult()` before
// evidence reaches this function. This is a residual: Task 5 must always pass
// evidence that already passed that Driver-bound validator, never a raw,
// un-vetted observation, directly into `releaseLeasesOnSettlement()`. What
// this function does honestly retain leases for is any evidence whose
// `nativeTurnRef` is missing, not an object, or fails the core-owned
// structural/version check outright.
// ---------------------------------------------------------------------------

function ownDataValue(source, field) {
  if (source == null || typeof source !== "object" || types.isProxy(source)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(source, field);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Structural precondition on top of `classifyTurnSettlement()`: the terminal
 * result must carry a native turn reference whose core-owned envelope
 * shape/version this runtime recognizes. `classifyTurnSettlement()` alone
 * never looks at `nativeTurnRef` at all (by design, so its axis-only
 * vocabulary cannot drift from the durable schema); this closes that gap for
 * the one caller -- lease release -- where a structurally unrecognized
 * envelope must retain, not release. See the module-level comment above for
 * the exact, narrower scope of what this can and cannot prove. The validated,
 * canonical envelope is returned (never re-read from `evidence` a second
 * time) so the caller's route-binding check below cannot be shown a
 * different value than the one just validated.
 */
function assertSettlementEvidenceShape(evidence) {
  if (evidence == null) return { ok: false, reason: "no_evidence" };
  if (typeof evidence !== "object" || Array.isArray(evidence) || types.isProxy(evidence)) {
    return { ok: false, reason: "invalid_evidence" };
  }
  const nativeTurnRef = ownDataValue(evidence, "nativeTurnRef");
  if (nativeTurnRef == null) return { ok: false, reason: "missing_native_reference" };
  let canonicalNativeTurnRef;
  try {
    canonicalNativeTurnRef = assertNativeReferenceEnvelopeShape(nativeTurnRef, "Lease release native turn reference");
  } catch {
    return { ok: false, reason: "unrecognized_native_reference_envelope" };
  }
  return { ok: true, nativeTurnRef: canonicalNativeTurnRef };
}

/**
 * The settlement evidence's native turn reference must structurally belong
 * to the exact route being released: a Harness/instance/Driver-version
 * mismatch means this evidence proves nothing about *this* lease's turn,
 * regardless of how the top-level settlement axes classify. This is
 * independent of -- and does not require -- Driver-bound locator/content
 * proof (see the module-level comment above).
 */
function nativeTurnRefMatchesRoute(nativeTurnRef, route) {
  return (
    nativeTurnRef.harnessId === route.harnessId &&
    nativeTurnRef.instanceKey === route.instanceKey &&
    nativeTurnRef.driverVersion === route.driverVersion
  );
}

/**
 * The closed release-outcome vocabulary. `released` stays a boolean for
 * callers that only need "may I publish?", but it is never the whole answer:
 * `outcome` states exactly what happened to the batch, and a caller that
 * reports a boolean alone would be claiming something this function did not
 * prove.
 *
 * - `all`     every target is released or was already released
 * - `none`    nothing was touched (the settlement gate refused the batch)
 * - `partial` at least one target released and at least one still held
 * - `unknown` at least one target's post-failure state cannot be read at all
 */
export const LEASE_RELEASE_OUTCOMES = Object.freeze(["all", "none", "partial", "unknown"]);

/**
 * The whole-batch retention receipt.
 *
 * `retainedCount` is the number of targets this call left held, never zero: a
 * receipt that says nothing was released *and* nothing was retained states no
 * disposition at all for leases that are, in fact, still held.
 */
function retained(reason, classification = null, retainedCount = 0) {
  return Object.freeze({
    released: false,
    outcome: "none",
    reason,
    classification,
    releasedCount: 0,
    alreadyReleasedCount: 0,
    retainedCount,
    unknownCount: 0,
    failures: Object.freeze([]),
  });
}

/**
 * Release every listed lease exactly once, only when the shared settlement
 * predicate proves the turn publishable **and** its native turn reference
 * structurally belongs to every target's own route. All targets are
 * validated before any are mutated: an invalid identity/evidence, a
 * route-mismatched native reference, or a corrupt record for even one target
 * retains every lease in the batch, before any lock is acquired. A target
 * whose exact holder file is already absent is treated as already released
 * (idempotent reconciliation replay, independent of any sibling holder in a
 * capacity>1 key -- the holder file *is* the identity, so its absence can
 * never mean "held by someone else"). An exact duplicate target presented
 * more than once in one call is de-duplicated before locking/validation/
 * mutation, so it is released exactly once, not double-unlinked.
 *
 * Unlink failures are contained, never thrown: the return value states the
 * exact `outcome` (`all`/`none`/`partial`/`unknown`) with per-disposition
 * counts, because "the batch threw" is not evidence that nothing was released.
 *
 * @param {{normalizedTerminalResult: *, releases: Array<{kind: string, ownerRootId: string, agentId: string, jobId: string, route: *}>}} input
 */
export function releaseLeasesOnSettlement({ normalizedTerminalResult, releases }) {
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error("releaseLeasesOnSettlement requires at least one lease release target.");
  }

  // Before any target is resolved the only honest count of retained leases is
  // the number of targets the caller presented.
  const shape = assertSettlementEvidenceShape(normalizedTerminalResult);
  if (!shape.ok) return retained(shape.reason, null, releases.length);

  const classification = classifyTurnSettlement(normalizedTerminalResult);
  if (!classification.publishable) {
    return retained(classification.reason, classification, releases.length);
  }

  const rawPlans = releases.map((target) => {
    const { kind, keyText, keyFields } = releaseDescriptorForTarget(target);
    const identity = assertBindingIdentity(target);
    const canonicalRoute = validateVersionThreeRoute(target.route, "Lease release route");
    assertKeyFieldsMatchRoute(kind, keyFields, canonicalRoute);
    const routeText = JSON.stringify(canonicalRoute);
    const keyDir = resolveLeaseKeyDirectory(kind, keyText);
    const holderDigest = holderIdentityDigest({ kind, keyText, ...identity, routeText });
    const holderFile = path.join(keyDir, `${holderDigest}.json`);
    return { kind, keyText, identity, canonicalRoute, routeText, keyDir, holderFile, status: /** @type {string|null} */ (null) };
  });

  // De-duplicate by the exact holder-file identity: two release targets that
  // resolve to the same file are the same release, not two. Pure, and it
  // touches no file, so it may precede the coherence check below and let that
  // check's receipt state the exact number of distinct leases retained.
  const plans = [];
  const seenHolderFiles = new Set();
  for (const plan of rawPlans) {
    if (seenHolderFiles.has(plan.holderFile)) continue;
    seenHolderFiles.add(plan.holderFile);
    plans.push(plan);
  }

  // Every target's own bound route must agree with the settlement evidence's
  // native turn reference (Harness/instance/Driver version). A mismatch
  // means this evidence proves nothing about that lease's turn; the whole
  // batch retains, before any file is even looked at.
  for (const plan of plans) {
    if (!nativeTurnRefMatchesRoute(shape.nativeTurnRef, plan.canonicalRoute)) {
      return retained("native_reference_route_mismatch", classification, plans.length);
    }
  }

  const uniqueDirs = [...new Set(plans.map((plan) => plan.keyDir))].sort();
  // Locks are acquired one at a time *inside* the try/finally, not built via
  // `.map()` ahead of it: if a later directory's lock acquisition throws
  // (contention timeout, I/O error), every lock already acquired for an
  // earlier directory must still be released rather than leaked.
  const locks = [];
  try {
    for (const dir of uniqueDirs) {
      locks.push({ dir, lock: acquireDirectoryLock(dir) });
    }
    for (const plan of plans) {
      if (!fs.existsSync(plan.holderFile)) {
        // The holder file *is* the identity: its absence always means
        // "already released" for this exact owner/Agent/job/route/kind/key
        // combination, regardless of whether a sibling holder still exists
        // for a capacity>1 key. It can never mean "held by someone else" --
        // a different identity computes a different file, never this one.
        plan.status = "already_released";
        continue;
      }
      const record = readHolderFile(plan.holderFile);
      assertSameLeaseIdentity(record, { kind: plan.kind, keyText: plan.keyText, ...plan.identity, routeText: plan.routeText });
      plan.status = "to_release";
    }

    let releasedCount = 0;
    let alreadyReleasedCount = 0;
    let retainedCount = 0;
    let unknownCount = 0;
    /** @type {Array<{kind: string, code: string, disposition: string}>} */
    const failures = [];
    for (const plan of plans) {
      if (plan.status !== "to_release") {
        alreadyReleasedCount += 1;
        continue;
      }
      try {
        fs.unlinkSync(plan.holderFile);
        releasedCount += 1;
      } catch (error) {
        // A mid-batch unlink failure must never surface as "nothing was
        // released": earlier targets in this batch are already gone, and a
        // caller that retried or reported `released: false` would be acting on
        // a false statement. Re-read this exact holder file to decide the one
        // honest disposition for it, and keep going so the batch's total
        // evidence is exact rather than truncated at the first failure.
        let disposition;
        try {
          disposition = fs.existsSync(plan.holderFile) ? "retained" : "released";
        } catch {
          disposition = "unknown";
        }
        if (disposition === "released") {
          releasedCount += 1;
        } else if (disposition === "retained") {
          retainedCount += 1;
        } else {
          unknownCount += 1;
        }
        // Only the closed error code is reported: a filesystem message can
        // name a local path, and a lease receipt is not a place for one.
        failures.push(Object.freeze({
          kind: plan.kind,
          code: typeof error?.code === "string" ? error.code : "unknown_error",
          disposition,
        }));
      }
    }
    const outcome = unknownCount > 0
      ? "unknown"
      : retainedCount === 0
        ? "all"
        : releasedCount + alreadyReleasedCount > 0
          ? "partial"
          : "none";
    return Object.freeze({
      released: outcome === "all",
      outcome,
      reason: outcome === "all" ? "publishable" : `release_${outcome}`,
      classification,
      releasedCount,
      alreadyReleasedCount,
      retainedCount,
      unknownCount,
      failures: Object.freeze(failures),
    });
  } finally {
    for (const { lock } of locks) releaseDirectoryLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Read-only diagnostics inventory (4.4). Pure reads only: no directory is
// created, no file is written, moved, or deleted, and nothing here can be
// reached from a model-facing operation. A corrupt/unreadable record is
// reported only by its closed `.code` reason -- never by the underlying
// exception message or file path, both of which may name local filesystem
// detail.
// ---------------------------------------------------------------------------

/** Hard cap on the number of lease-key entries one inventory call returns. */
export const MAX_INVENTORY_ENTRIES = 100;
/** Hard cap on the number of sampled holders returned per entry. */
export const MAX_HOLDERS_PER_ENTRY = 16;

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Deterministic order: kind, then the readable key text or, for an unreadable entry, its key digest. */
function compareInventoryEntries(left, right) {
  return compareText(left.kind, right.kind) || compareText(left.key ?? left.keyDigest, right.key ?? right.keyDigest);
}

/** Deterministic order for holders sharing one key: owner root, then Agent, then job. */
function compareHolderRecords(left, right) {
  return (
    compareText(left.ownerRootId, right.ownerRootId) ||
    compareText(left.agentId, right.agentId) ||
    compareText(left.jobId, right.jobId)
  );
}

function isBlockedEntry(entry) {
  return entry.atCapacity === true || entry.unreadable === true;
}

function boundedHolderEvidence(record) {
  return Object.freeze({
    ownerRootId: record.ownerRootId,
    agentId: record.agentId,
    jobId: record.jobId,
    harnessId: record.route?.harnessId ?? null,
    instanceKey: record.route?.instanceKey ?? null,
    model: record.route?.model ?? null,
    topology: record.route?.topology ?? null,
    authority: record.route?.authority ?? null,
    driverVersion: record.route?.driverVersion ?? null,
    createdAt: record.createdAt,
    lastSeenAt: record.updatedAt,
  });
}

/**
 * Bounded, non-secret, read-only inventory of every currently held lease,
 * grouped by kind/key. There is no force-clear, delete, or cleanup-on-read
 * here: this function never calls anything but `fs.existsSync`/`readdirSync`/
 * `readFileSync`. `stateRoot`, when given, overrides the live env-configured
 * plugin state root -- used by `runtime/operator-diagnostics.mjs` so this
 * inventory shares the exact plugin data root its established
 * `inspectOperatorStorage()`/`runDoctor()` surface already resolved, rather
 * than a second, independently configured root.
 * @param {{kinds?: readonly string[], stateRoot?: string}} [options]
 * The returned entry list and each entry's holder sample are both hard
 * bounded (`MAX_INVENTORY_ENTRIES`, `MAX_HOLDERS_PER_ENTRY`) and sorted
 * deterministically, so neither a large number of distinct lease keys nor a
 * single high-capacity key can make this output grow without bound.
 * `total`/`blockedTotal` are always computed over the *complete* population
 * before any cap is applied, so they -- and `truncated`/`holdersTruncated`
 * -- remain truthful even when the displayed sample is capped.
 */
export function inspectLeaseInventory({ kinds = LEASE_KINDS, stateRoot } = {}) {
  const root = resolveLeaseRoot(stateRoot);
  const allEntries = [];
  for (const kind of kinds) {
    assertLeaseKind(kind);
    const kindDir = path.join(root, kind);
    if (!fs.existsSync(kindDir)) continue;
    let keyDirs = [];
    try {
      keyDirs = fs.readdirSync(kindDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const keyDirEntry of keyDirs) {
      const keyDir = path.join(kindDir, keyDirEntry.name);
      let holders;
      try {
        holders = readHolderFiles(keyDir, stateRoot);
      } catch (error) {
        allEntries.push(Object.freeze({
          kind,
          keyDigest: keyDirEntry.name,
          unreadable: true,
          reasonCode: error?.code ?? "corrupt_or_unreadable",
        }));
        continue;
      }
      if (holders.length === 0) continue;
      const [{ record: sample }] = holders;
      const sortedHolders = [...holders].sort((left, right) => compareHolderRecords(left.record, right.record));
      const boundedHolders = sortedHolders.slice(0, MAX_HOLDERS_PER_ENTRY);
      allEntries.push(Object.freeze({
        kind,
        key: sample.key,
        keyFields: Object.freeze({ ...sample.keyFields }),
        capacityClass: sample.capacity.class,
        capacityLimit: sample.capacity.limit,
        holderCount: holders.length,
        atCapacity: holders.length >= sample.capacity.limit,
        evidenceClassNeeded: SETTLEMENT_EVIDENCE_CLASS,
        holders: Object.freeze(boundedHolders.map(({ record }) => boundedHolderEvidence(record))),
        holdersTruncated: boundedHolders.length < holders.length,
      }));
    }
  }
  allEntries.sort(compareInventoryEntries);
  const total = allEntries.length;
  const blockedTotal = allEntries.filter(isBlockedEntry).length;
  const entries = Object.freeze(allEntries.slice(0, MAX_INVENTORY_ENTRIES));
  return Object.freeze({
    entries,
    total,
    blockedTotal,
    truncated: entries.length < total,
  });
}
