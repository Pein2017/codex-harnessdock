/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Durable launch-claim/attempt persistence: the state machine `design.md`
 * decision 4 and the `durable-runtime-state` spec require before any Driver
 * can possibly submit task input.
 *
 * Before `startTurn()`, the supervisor must durably bind one unique launch
 * claim and attempt to the trusted root/Agent/job, the immutable route and
 * capability snapshot, the exact authority-lease intent before acquisition
 * and the matching acquired proof before submission,
 * the assigned mailbox/input identity, and a bounded cryptographic input
 * digest -- never prompt/input content, arbitrary environment, an endpoint, a
 * credential, or a live object. This module is the narrow single owner of
 * that record's durable schema and atomic engine, following the exact
 * owner-only directory-lock/atomic-write conventions
 * `runtime/instance-admission-lease.mjs` and `runtime/turn-control.mjs`
 * already established.
 *
 * The acceptance axis is closed and separate from every other turn fact:
 * `not_submitted | acceptance_proven | acceptance_rejected |
 * acceptance_unknown`. It is never collapsed with native turn state, terminal
 * settlement, transcript continuation, request acknowledgement, or job
 * completion -- those live in `runtime/turn-settlement.mjs` and
 * `runtime/turn-control.mjs`. A separate, independently monotonic
 * `submissionState` (`not_started|started|rollback_in_progress|
 * rollback_complete`) records whether native submission began or the
 * mutually exclusive pre-submission rollback fence won; see
 * `markNativeSubmissionStarted()` and `launchClaimRollbackEligibility()`
 * below for why this axis exists and how it gates rollback.
 *
 * `acceptance_proven` requires a fully canonical native turn reference bound
 * to this claim's own route; a raw/fresh locator, a PID, a prompt-write
 * guess, a request acknowledgement, transcript continuation, or lease
 * existence is never acceptance proof. Exact acceptance proof is consumed,
 * never re-derived: `recordLaunchAcceptanceProven()` does not accept a bare
 * `nativeTurnRef` at all. It accepts only the exact `LiveHarnessTurn`
 * wrapper `runtime/harness-contract.mjs`'s `validateLiveHarnessTurn()`
 * produced, and calls that module's own `durableTurnEvidence()` on it
 * internally. `durableTurnEvidence()` is a `WeakSet`-membership brand check:
 * it throws for any object that is not the exact wrapper
 * `validateLiveHarnessTurn()` returned, so a raw, fresh, or otherwise
 * caller-minted reference -- even one that is structurally valid and
 * route-correct -- can never satisfy it. This module never calls a Driver
 * itself; it only consumes evidence an upstream caller already produced by
 * calling `validateLiveHarnessTurn()` against its own live handle, exactly
 * once, before this function is called. A separately recorded, optional
 * `nativeSessionRef` is drawn from that same branded evidence and persisted
 * independently; it is never itself acceptance proof and it can never
 * substitute for `nativeTurnRef` in the acceptance gate. Additionally, each
 * validated `LiveHarnessTurn` wrapper is bound, in a process-local
 * `WeakMap`, to exactly one claim identity: the exact same wrapper may prove
 * acceptance for the same claim repeatedly (idempotent), but never for a
 * different claim/Agent/job -- see `bindLiveHarnessTurnToClaim()`. That live
 * binding says nothing about durable state after a restart or across
 * processes; global native-turn uniqueness after worker loss/restart is
 * reconciliation-owned (Task 8.2) and this live seam must never be read as a
 * substitute for that later proof.
 *
 * Exactly one `attemptId` may ever durably win a launch claim for one job
 * activation: `createLaunchClaim()` is idempotent for the exact same
 * `attemptId` and its exact bound content, and fails closed -- without
 * rewriting the stored record -- for a different `attemptId` or for
 * conflicting content under the same `attemptId`. That won attemptId is the
 * only `workerAttemptId` a future detached worker (Task 5B) may mint for
 * `runtime/turn-control.mjs`'s `claimControlCommand()`/
 * `recordRequestAcknowledgement()`/`recordControlSettlement()`; this module
 * does not call those functions itself, and it never mints `attemptId` on a
 * caller's behalf -- the caller (a future worker) generates it with the same
 * collision-resistant convention `runtime/agent-store.mjs`'s
 * `generatedAgentId()`/`generatedMessageId()` already use, exactly like
 * `commandId` is always caller-minted for `enqueueControlCommand()`.
 *
 * This module never calls a Driver, never acquires or releases a lease,
 * never appends or acknowledges a mailbox message, and never publishes a
 * completion. It imports exactly two narrow, already-accepted read/proof
 * seams for that purpose, and nothing else from either module:
 * `runtime/instance-admission-lease.mjs`'s brand-gated
 * `acquiredLeaseEvidence()` (never `acquireLease()`/`acquireInstanceLease()`/
 * `acquireNativeSessionLease()`/`releaseLeasesOnSettlement()`/
 * `inspectLeaseInventory()`), and `runtime/harness-contract.mjs`'s
 * `durableTurnEvidence()` (never `validateLiveHarnessTurn()`, which would
 * require this module to accept a raw Driver handle and reach into
 * Driver-owned validation itself). A lease binding is accepted only as the
 * *exact* object reference a successful Task 4 acquire/re-acquire call
 * returned to this same process; `acquiredLeaseEvidence()` throws for
 * anything else -- a plain object, a structural clone, a Proxy, or a stale
 * reference -- before any of its properties are read. See the module-level
 * comment above `leaseBindingReceipt()`.
 *
 * A pre-submission rollback (releasing a lease this caller acquired but
 * never used) is a distinct, narrower proof this module does not perform:
 * it only reports the closed `launchClaimRollbackEligibility()` fact, and
 * that fact is eligible only for `not_submitted` (and only while
 * `submissionState === "not_started"`) or `acceptance_rejected`. It never
 * calls a lease-release function itself. The returned CAS-style `token`
 * (`attemptId`/`acceptance`/`submissionState`/`updatedAt`) is a
 * point-in-time snapshot, not an atomic reservation: Task 5B2 must re-check
 * this function -- and therefore this token -- immediately before it
 * actually owns and acts on the exact attempt, never act on a token read
 * earlier in a longer-lived call chain.
 *
 * Every mutation recorder uses the real system clock; there is no
 * caller-injectable `now`. Durable timestamps are validated to be
 * monotonic relative to `createdAt`, and `submissionStartedAt` may never
 * follow `acceptanceEvidenceAt` when both are present.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateStoredVersionThreeRoute, validateVersionThreeRoute } from "./durable-state-v3.mjs";
import { durableTurnEvidence } from "./harness-contract.mjs";
import { acquiredLeaseEvidence } from "./instance-admission-lease.mjs";
import {
  assertNativeReferenceEnvelopeShape,
  assertNativeReferenceLocatorShape,
} from "./native-reference.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { plainDataTree, plainRecordSnapshot } from "./plain-record.mjs";
import {
  getProcessIdentity,
  isProcessAlive,
  validateProcessIdentity,
} from "./process-control.mjs";

export const LAUNCH_CLAIM_SCHEMA_VERSION = 2;
const LEGACY_LAUNCH_CLAIM_SCHEMA_VERSION = 1;

/** The closed acceptance axis. Never collapsed with native turn state, settlement, submission, or completion. */
export const LAUNCH_ACCEPTANCE_VALUES = Object.freeze([
  "not_submitted",
  "acceptance_proven",
  "acceptance_rejected",
  "acceptance_unknown",
]);

/**
 * The closed, separately monotonic pre-submission fence: whether a native
 * submission attempt has begun. Independent of `acceptance` -- a crash or
 * lock failure after `markNativeSubmissionStarted()` but before any
 * acceptance evidence leaves `acceptance` at `not_submitted` even though
 * `submissionState` is `started`, and that combination is never
 * rollback-eligible (see `launchClaimRollbackEligibility()`).
 */
export const SUBMISSION_STATES = Object.freeze([
  "not_started", "started", "rollback_in_progress", "rollback_complete",
]);

/**
 * The closed lease kinds a launch claim may bind against, reused directly
 * from `runtime/instance-admission-lease.mjs` (never redefined) so this
 * module's vocabulary can never drift from that one's.
 */
const LEASE_KINDS = Object.freeze(["instance", "native_session", "writer"]);

const MAX_IDENTITY_TEXT_BYTES = 256;
const MAX_KEY_FIELD_TEXT_BYTES = 4096;
const MAX_DETAIL_BYTES = 512;
const MAX_LEASE_BINDINGS = LEASE_KINDS.length;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INPUT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Bounded, ordered, deduplicated mailbox activation identity. The queue may
 * grow without this module, but one launch must either bind its complete
 * activation set within this explicit bound or fail before submission.
 */
export const MAX_ASSIGNED_MESSAGE_IDS = 256;

/** Domain separation for the module-owned input digest -- never a caller-suppliable value. */
const INPUT_DIGEST_DOMAIN = "codex-harnessdock-launch-claim-input-v2";

/**
 * Turn options are an opaque, bounded, Driver-owned bag. This module never
 * reads inside one and knows no option vocabulary: it canonicalizes the bag
 * trap-free, bounds it, folds it into the module-owned input digest under its
 * own domain separator, and then discards it. The bag itself is never
 * persisted, logged, or echoed -- exactly like `preparedInput`.
 */
const MAX_TURN_OPTIONS_DEPTH = 1;
const MAX_TURN_OPTIONS_BYTES = 1024;

// C0/C1 controls plus the soft hyphen, zero-width, bidi-override, and
// byte-order-mark ranges -- identical to the bound every sibling durable
// module (`durable-state-v3.mjs`, `instance-admission-lease.mjs`,
// `turn-control.mjs`) already enforces for identity text.

// eslint-disable-next-line no-control-regex
const UNSTABLE_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

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

function assertOptionalDetailText(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text or null.`);
  if (UNSTABLE_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} must not contain control or format characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_DETAIL_BYTES) {
    throw new Error(`${label} exceeds its durable bound.`);
  }
  return value;
}

function assertInputDigest(value) {
  if (typeof value !== "string" || !INPUT_DIGEST_PATTERN.test(value)) {
    throw new Error(
      `Launch claim input digest must be a bounded cryptographic digest of the exact shape ` +
      `"sha256:<64 lowercase hex characters>": ${JSON.stringify(value ?? null)}.`
    );
  }
  return value;
}

function assertTimestampText(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact ISO-8601 millisecond timestamp.`);
  }
  return value;
}

function assertOptionalTimestampText(value, label) {
  if (value === null) return null;
  return assertTimestampText(value, label);
}

/** @param {Record<string, *>} candidate */
function assertBindingIdentity({ ownerRootId, agentId, jobId }) {
  return {
    ownerRootId: assertIdentityText(ownerRootId, "Launch claim owner root ID"),
    agentId: assertIdentityText(agentId, "Launch claim Agent ID"),
    jobId: assertIdentityText(jobId, "Launch claim job ID"),
  };
}

/**
 * Bounded, ordered, deduplicated mailbox activation identity: every assigned
 * initial-prompt mailbox message this attempt submits, in exact activation
 * order (order is durably significant -- see `computeInputDigest()`).
 */
function assertAssignedMessageIds(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} requires at least one assigned mailbox message identity, in activation order.`);
  }
  if (value.length > MAX_ASSIGNED_MESSAGE_IDS) {
    throw new Error(`${label} exceeds its durable bound of ${MAX_ASSIGNED_MESSAGE_IDS} entries.`);
  }
  const canonical = value.map((id, index) => assertIdentityText(id, `${label}[${index}]`));
  const seen = new Set();
  for (const id of canonical) {
    if (seen.has(id)) throw new Error(`${label} contains a duplicate message identity: ${JSON.stringify(id)}.`);
    seen.add(id);
  }
  return Object.freeze(canonical);
}

function assertPreparedInputText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be non-empty text.`);
  }
  // Prepared input is opaque model content, not identity text. Newlines,
  // tabs, code fences, and other formatting are meaningful and must hash
  // byte-for-byte. Match the accepted mailbox boundary by refusing NUL only;
  // the input is never persisted here, only streamed into SHA-256.
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL.`);
  }
  return value;
}

/**
 * The module-owned, domain-separated canonical input digest. Computed here,
 * over the ordered assigned message identities, the exact bounded prepared
 * input text, and the canonical bounded turn-option bag -- never accepted as
 * caller-supplied authority, and never a Driver-supplied digest (see
 * `createLaunchClaim()`, which never exposes an `inputDigest` input field at
 * all). `preparedInput` is never persisted. The exact bounded `turnOptions`
 * are persisted because a detached worker must reproduce the prepared native
 * request without inventing or re-resolving Driver-owned effective options.
 * Order is significant: swapping two message
 * identities' order produces a different digest, exactly matching current
 * Agent mailbox activation-order semantics.
 */
function computeInputDigest(assignedMessageIds, preparedInput, turnOptionsText) {
  const hash = createHash("sha256");
  hash.update(INPUT_DIGEST_DOMAIN);
  hash.update("\0");
  hash.update(String(assignedMessageIds.length));
  for (const id of assignedMessageIds) {
    hash.update("\0");
    hash.update(id);
  }
  hash.update("\0\0prepared-input\0");
  hash.update(preparedInput);
  // Turn options change what the Harness actually executes, so two attempts
  // that differ only in their options are two different launches. Stating no
  // options is its own distinct value, never the same digest as stating some.
  hash.update("\0\0turn-options\0");
  hash.update(turnOptionsText);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The canonical text one bounded turn-option bag digests as. `null` -- a route
 * whose Driver owns no turn options -- has its own reserved text, so omission
 * can never collide with a stated bag.
 */
function canonicalTurnOptions(value, label) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one bounded option record or null.`);
  }
  const canonical = plainDataTree(value, label, MAX_TURN_OPTIONS_DEPTH);
  const text = JSON.stringify(canonical);
  if (Buffer.byteLength(text, "utf8") > MAX_TURN_OPTIONS_BYTES) {
    throw new Error(`${label} exceeds ${MAX_TURN_OPTIONS_BYTES} bytes.`);
  }
  return canonical;
}

function canonicalTurnOptionsText(value, label) {
  const canonical = canonicalTurnOptions(value, label);
  return canonical === null ? "none" : `stated\0${JSON.stringify(canonical)}`;
}

/**
 * Canonicalize a native reference (turn or session) for durable persistence:
 * exact core-owned envelope shape plus the full bounded, exotic/secret-free
 * locator shape -- the same discipline `runtime/turn-control.mjs`'s
 * `canonicalizeNativeTurnRef()` already applies, duplicated here rather than
 * imported (this module has no dependency on that one, matching the
 * established per-module convention of duplicating this small helper rather
 * than extracting a shared utility). This module never uses this function to
 * *prove* acceptance by itself: for `nativeTurnRef`, the actual proof is
 * `durableTurnEvidence()`'s brand check (see `recordLaunchAcceptanceProven()`);
 * this function only re-canonicalizes evidence that already passed that
 * check, or re-validates an already-durable record's own stored shape on
 * read.
 */
function canonicalizeNativeReference(reference, label) {
  const snapshot = assertNativeReferenceEnvelopeShape(reference, label);
  const canonicalLocator = assertNativeReferenceLocatorShape(snapshot.locator, label);
  return Object.freeze({
    version: snapshot.version,
    harnessId: snapshot.harnessId,
    driverVersion: snapshot.driverVersion,
    instanceKey: snapshot.instanceKey,
    locatorVersion: snapshot.locatorVersion,
    locator: canonicalLocator,
  });
}

function assertNativeReferenceMatchesRoute(reference, route, label) {
  if (reference.harnessId !== route.harnessId || reference.instanceKey !== route.instanceKey) {
    throw new Error(
      `${label} native reference belongs to Harness ${JSON.stringify(reference.harnessId)}/instance ` +
      `${JSON.stringify(reference.instanceKey)}, which does not match its bound route.`
    );
  }
}

// ---------------------------------------------------------------------------
// Native-turn live uniqueness (correction pass, requirement 4).
//
// A validated `LiveHarnessTurn` wrapper is process-local and never
// serialized (see `runtime/harness-contract.mjs`). This `WeakMap` binds each
// exact wrapper object to exactly one claim identity
// (`ownerRootId\0agentId\0jobId\0attemptId`) the first time it is presented
// to `recordLaunchAcceptanceProven()`. A repeat presentation of the *same*
// wrapper for the *same* claim is an idempotent replay and is allowed; a
// repeat presentation of the *same* wrapper for a *different* claim identity
// is refused. A Driver can still return two distinct wrappers that name the
// same canonical native turn; detecting that durable/global collision belongs
// to later observation/reconciliation (Task 8.2), not this object-identity
// brand.
//
// This is a live, in-process fact only. It says nothing about durable
// uniqueness after this process exits, after a restart, or across
// processes -- that global durable proof belongs to later
// observation/reconciliation (Task 8.2) and must be built independently;
// this binding must never be read as, or weakened to stand in for, that
// proof.
// ---------------------------------------------------------------------------

const LIVE_TURN_CLAIM_BINDING = new WeakMap();

function claimIdentityKey({ ownerRootId, agentId, jobId, attemptId }) {
  return `${ownerRootId}\0${agentId}\0${jobId}\0${attemptId}`;
}

function claimJobIdentityKey({ ownerRootId, agentId, jobId }) {
  return `${ownerRootId}\0${agentId}\0${jobId}`;
}

function bindLiveHarnessTurnToClaim(liveHarnessTurn, identity, label) {
  const key = claimIdentityKey(identity);
  const existingKey = LIVE_TURN_CLAIM_BINDING.get(liveHarnessTurn);
  if (existingKey === undefined) {
    LIVE_TURN_CLAIM_BINDING.set(liveHarnessTurn, key);
    return;
  }
  if (existingKey !== key) {
    throw new Error(
      `${label} this exact validated live turn is already bound to a different launch claim in this process; ` +
      `one validated native turn may prove acceptance for exactly one claim identity here. Later ` +
      `observation/restart durable uniqueness is owned by reconciliation (Task 8.2) and is never established by, ` +
      `or weakened through, this live binding.`
    );
  }
}

// ---------------------------------------------------------------------------
// Lease binding receipts (correction pass, requirement 1).
//
// A launch claim never accepts caller-supplied `keyFields`/`capacity`/`route`
// as lease authority at face value. `runtime/instance-admission-lease.mjs`
// now exports the narrow brand-gated seam this module needs for exactly this
// purpose: `acquiredLeaseEvidence()` accepts only the *exact* object
// reference a successful acquire/re-acquire call returned to this process
// (a `WeakMap` brand, never invoking a hook/trap on a Proxy or clone), and
// returns a canonical immutable stable projection -- `kind`, `keyFields`,
// `capacity`, the full canonical `route`, and holder identity -- with only
// volatile bookkeeping timestamps excluded. This module never reimplements
// Task 4's key-derivation or capacity-admission authority; it only consumes
// that already-proven evidence.
//
// The durably persisted receipt binds `kind`, the exact canonical
// `keyFields` projection, `capacity`, a digest of the full canonical route
// (proving route/capability identity, including capability-snapshot drift,
// without duplicating the -- potentially large -- route object once per
// lease when the launch claim already carries the full route at its own top
// level), and holder identity, plus a tamper-evident `evidenceDigest` that a
// later read re-derives and compares. A caller-supplied lease-shaped object
// can therefore influence nothing beyond identifying *which* real,
// previously acquired lease it claims to be -- and unless
// `acquiredLeaseEvidence()` accepts it as that exact object, no receipt is
// ever produced.
// ---------------------------------------------------------------------------

const LEASE_KEY_FIELDS_BY_KIND = Object.freeze({
  instance: Object.freeze(["harnessId", "instanceKey"]),
  native_session: Object.freeze(["harnessId", "instanceKey", "nativeSessionId"]),
  writer: Object.freeze(["workspaceRoot"]),
});
const CAPACITY_FIELDS = Object.freeze(["class", "limit"]);

function routeDigestOf(canonicalRoute) {
  return createHash("sha256").update(JSON.stringify(canonicalRoute)).digest("hex");
}

function evidenceDigestOf({ kind, keyFields, capacity, routeDigest, ownerRootId, agentId, jobId }) {
  return createHash("sha256").update(JSON.stringify({
    kind, keyFields, capacity, routeDigest, ownerRootId, agentId, jobId,
  })).digest("hex");
}

function leaseBindingReceipt(leaseRecord, boundIdentity, boundRoute, boundRouteDigest, label) {
  const evidence = acquiredLeaseEvidence(leaseRecord);
  const kind = evidence.kind;
  if (!LEASE_KINDS.includes(kind)) {
    throw new Error(
      `${label} declares an unsupported lease kind: ${JSON.stringify(kind ?? null)}. Use one of: ${LEASE_KINDS.join(", ")}.`
    );
  }
  if (
    evidence.ownerRootId !== boundIdentity.ownerRootId ||
    evidence.agentId !== boundIdentity.agentId ||
    evidence.jobId !== boundIdentity.jobId
  ) {
    throw new Error(`${label} belongs to a foreign owner root/Agent/job, not this launch claim's own.`);
  }
  if (JSON.stringify(evidence.route) !== JSON.stringify(boundRoute)) {
    throw new Error(`${label} route (including capability snapshot) does not match this launch claim's own bound route.`);
  }
  const keyFields = Object.freeze({ ...evidence.keyFields });
  const capacity = Object.freeze({ ...evidence.capacity });
  const evidenceDigest = evidenceDigestOf({
    kind, keyFields, capacity, routeDigest: boundRouteDigest,
    ownerRootId: boundIdentity.ownerRootId, agentId: boundIdentity.agentId, jobId: boundIdentity.jobId,
  });
  return Object.freeze({
    kind,
    keyFields,
    capacity,
    routeDigest: boundRouteDigest,
    ownerRootId: boundIdentity.ownerRootId,
    agentId: boundIdentity.agentId,
    jobId: boundIdentity.jobId,
    evidenceDigest,
  });
}

function canonicalizeLeaseBindings(leaseBindings, boundIdentity, boundRoute, boundRouteDigest) {
  if (!Array.isArray(leaseBindings) || leaseBindings.length === 0) {
    throw new Error("Launch claim requires at least one authority lease binding before any possible native submission.");
  }
  if (leaseBindings.length > MAX_LEASE_BINDINGS) {
    throw new Error(`Launch claim declares more lease bindings than the closed lease-kind vocabulary admits.`);
  }
  const receipts = leaseBindings.map((leaseRecord, index) =>
    leaseBindingReceipt(leaseRecord, boundIdentity, boundRoute, boundRouteDigest, `Launch claim lease binding [${index}]`)
  );
  const seenKinds = new Set();
  for (const receipt of receipts) {
    if (seenKinds.has(receipt.kind)) {
      throw new Error(`Launch claim declares more than one lease binding of kind ${JSON.stringify(receipt.kind)}.`);
    }
    seenKinds.add(receipt.kind);
  }
  return Object.freeze([...receipts].sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// On-disk layout and owner-only atomic primitives. This mirrors, file for
// file, the mutex pattern `runtime/instance-admission-lease.mjs` and
// `runtime/turn-control.mjs` already established (0700 directories,
// `wx`-then-`linkSync` lock publication, fsync, stale-lock recovery keyed to
// process identity). Unlike those two modules, this one does NOT copy their
// 30-second lock-acquisition timeout: nothing calls this module from a live
// worker's event loop yet, but it is the persistence seam that Task 5B2 will
// wire directly into that loop, so a 30-second synchronous
// `Atomics.wait` spin is not carried forward blindly here. Instead
// `LOCK_ACQUIRE_TIMEOUT_MS` is tightly bounded to 2 seconds -- generous
// relative to the handful of local filesystem syscalls this lock actually
// protects, and proven by a deterministic contention/timeout test using a
// real, genuinely alive (but never-releasing) lock holder. This is still a
// synchronous, event-loop-blocking primitive, not an async/off-thread
// redesign; see the accompanying task report for why a full redesign is out
// of this persistence-only slice's scope and what Task 5B2 must still do
// before this lock may share an event loop with a live Driver connection.
// ---------------------------------------------------------------------------

function resolveLaunchClaimRoot(version = LAUNCH_CLAIM_SCHEMA_VERSION) {
  return path.join(resolvePluginStateRoot(), "launch-claims", `v${version}`);
}

function jobDigest({ ownerRootId, agentId, jobId }) {
  return createHash("sha256").update(`${ownerRootId}\0${agentId}\0${jobId}`).digest("hex");
}

/**
 * The durable directory backing one job's launch claim. Exported so tests and
 * a future reconciler can locate a job's claim file without reaching into
 * this module's private layout. Every call -- read or write -- resolves the
 * same live, env-configured production state root; there is no override
 * parameter, matching `runtime/turn-control.mjs`'s
 * `resolveControlStreamDirectory()` (this module has no second caller that
 * needs one either).
 */
export function resolveLaunchClaimDirectory({ ownerRootId, agentId, jobId }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return path.join(resolveLaunchClaimRoot(), jobDigest(identity));
}

function resolveLegacyLaunchClaimDirectory(identity) {
  return path.join(resolveLaunchClaimRoot(LEGACY_LAUNCH_CLAIM_SCHEMA_VERSION), jobDigest(identity));
}

function claimFileName(attemptId) {
  return `${createHash("sha256").update(attemptId).digest("hex")}.json`;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
  }
  return directory;
}

/**
 * Tightly bounded, not the 30-second convention `instance-admission-lease.mjs`/
 * `turn-control.mjs` use -- see the module-level comment above. Exported so a
 * deterministic test can assert observed wait time stays within a small,
 * explicit multiple of this bound rather than hard-coding the constant twice.
 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_IDENTITY_FAILURE_GRACE_MS = 1_000;
const LOCK_RETRY_MIN_DELAY_MS = 10;
const LOCK_RETRY_MAX_DELAY_MS = 50;

function sleepSync(ms) {
  const bounded = Math.max(0, Math.min(Number(ms) || 0, 1_000));
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, bounded);
}

function sleepAsync(ms) {
  const bounded = Math.max(0, Math.min(Number(ms) || 0, 1_000));
  return new Promise((resolve) => setTimeout(resolve, bounded));
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
        throw Object.assign(new Error(`Timed out acquiring launch claim directory lock ${lockFile}.`), { code: "ETIMEDOUT" });
      }
      throw error;
    }
  }
}

/**
 * Acquire the same durable lock without blocking the caller's event loop while
 * another process owns it. The critical section remains a handful of local
 * synchronous filesystem operations; only contention may wait for seconds,
 * and that wait always yields through a timer.
 */
async function acquireDirectoryLockAsync(directory) {
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
        await sleepAsync(
          LOCK_RETRY_MIN_DELAY_MS + Math.random() * (LOCK_RETRY_MAX_DELAY_MS - LOCK_RETRY_MIN_DELAY_MS)
        );
        continue;
      }
      if (error?.code === "EEXIST") {
        throw Object.assign(new Error(`Timed out acquiring launch claim directory lock ${lockFile}.`), { code: "ETIMEDOUT" });
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

function writeAtomicClaimFile(filePath, data, { createOnly = false } = {}) {
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
// Closed durable record validator. Every record this module writes is also
// read back through this exact validator, so persistence never diverges from
// what a later read accepts. A corrupt, partial, or identity-drifted record
// is refused before it can be acted on, and it is never deleted -- corruption
// fails closed, not silently repaired or replaced.
// ---------------------------------------------------------------------------

const LAUNCH_CLAIM_FIELDS = Object.freeze([
  "version", "ownerRootId", "agentId", "jobId", "attemptId",
  "route", "leaseState", "leaseIntent", "leaseBindings", "assignedMessageIds", "turnOptions", "inputDigest",
  "acceptance", "nativeTurnRef", "nativeSessionRef", "acceptanceEvidenceAt", "sanitizedDetail",
  "submissionState", "submissionStartedAt",
  "createdAt", "updatedAt",
]);
const LEGACY_LAUNCH_CLAIM_FIELDS = Object.freeze(
  LAUNCH_CLAIM_FIELDS.filter((field) => !["leaseState", "leaseIntent", "turnOptions"].includes(field))
);

const LEASE_RECEIPT_FIELDS = Object.freeze([
  "kind", "keyFields", "capacity", "routeDigest", "ownerRootId", "agentId", "jobId", "evidenceDigest",
]);
const ROUTE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EVIDENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Refuse any field outside `allowedFields`, without requiring every allowed
 * field to be present. Used for caller-facing *input* objects, where some
 * fields (`sanitizedDetail`) are legitimately optional with defaults --
 * unlike a durable *record*, whose every field is always present by
 * construction (`assertClosedFieldSet()` below).
 */
function assertNoUnknownFields(snapshot, allowedFields, label) {
  for (const field of Object.keys(snapshot)) {
    if (!allowedFields.includes(field)) {
      throw new Error(`${label} declares an unsupported field: ${JSON.stringify(field)}. Use one of: ${allowedFields.join(", ")}.`);
    }
  }
}

function assertClosedFieldSet(snapshot, expectedFields, label) {
  for (const field of Object.keys(snapshot)) {
    if (!expectedFields.includes(field)) throw new Error(`${label} declares an unknown field: ${field}.`);
  }
  for (const field of expectedFields) {
    if (!(field in snapshot)) throw new Error(`${label} is missing required field: ${field}.`);
  }
}

function validateStoredKeyFields(kind, value, label) {
  const snapshot = plainRecordSnapshot(value, label);
  const expected = LEASE_KEY_FIELDS_BY_KIND[kind];
  assertClosedFieldSet(snapshot, expected, label);
  const canonical = {};
  for (const field of expected) {
    canonical[field] = assertIdentityText(snapshot[field], `${label} ${field}`, MAX_KEY_FIELD_TEXT_BYTES);
  }
  return Object.freeze(canonical);
}

function validateStoredCapacity(value, label) {
  const snapshot = plainRecordSnapshot(value, label);
  assertClosedFieldSet(snapshot, CAPACITY_FIELDS, label);
  const capacityClass = snapshot.class === null ? null : assertIdentityText(snapshot.class, `${label} class`);
  if (!Number.isInteger(snapshot.limit) || snapshot.limit < 1) {
    throw new Error(`${label} limit must be a positive integer.`);
  }
  return Object.freeze({ class: capacityClass, limit: snapshot.limit });
}

function validateLeaseReceipt(receipt, index, label) {
  const entryLabel = `${label}[${index}]`;
  const snapshot = plainRecordSnapshot(receipt, entryLabel);
  assertClosedFieldSet(snapshot, LEASE_RECEIPT_FIELDS, entryLabel);
  if (!LEASE_KINDS.includes(snapshot.kind)) {
    throw new Error(`${entryLabel} declares an unsupported lease kind: ${JSON.stringify(snapshot.kind ?? null)}.`);
  }
  const kind = snapshot.kind;
  const keyFields = validateStoredKeyFields(kind, snapshot.keyFields, `${entryLabel} keyFields`);
  const capacity = validateStoredCapacity(snapshot.capacity, `${entryLabel} capacity`);
  if (typeof snapshot.routeDigest !== "string" || !ROUTE_DIGEST_PATTERN.test(snapshot.routeDigest)) {
    throw new Error(`${entryLabel} routeDigest must be a bounded sha256 hex digest.`);
  }
  const identity = assertBindingIdentity(snapshot);
  if (typeof snapshot.evidenceDigest !== "string" || !EVIDENCE_DIGEST_PATTERN.test(snapshot.evidenceDigest)) {
    throw new Error(`${entryLabel} evidenceDigest must be a bounded sha256 hex digest.`);
  }
  // Re-derive the digest from the record's own stated fields; a hand-edited
  // receipt whose evidenceDigest disagrees with its own keyFields/capacity/
  // routeDigest/holder identity fails closed rather than being trusted at
  // face value.
  const recomputed = evidenceDigestOf({
    kind, keyFields, capacity, routeDigest: snapshot.routeDigest,
    ownerRootId: identity.ownerRootId, agentId: identity.agentId, jobId: identity.jobId,
  });
  if (recomputed !== snapshot.evidenceDigest) {
    throw taggedError(
      "identity_drift",
      `${entryLabel} evidenceDigest does not match its own stated fields; possible tamper.`
    );
  }
  return Object.freeze({
    kind, keyFields, capacity, routeDigest: snapshot.routeDigest,
    ownerRootId: identity.ownerRootId, agentId: identity.agentId, jobId: identity.jobId,
    evidenceDigest: snapshot.evidenceDigest,
  });
}

function validateLeaseBindingsList(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an authority lease binding array.`);
  }
  if (value.length > MAX_LEASE_BINDINGS) {
    throw new Error(`${label} declares more lease bindings than the closed lease-kind vocabulary admits.`);
  }
  const receipts = value.map((receipt, index) => validateLeaseReceipt(receipt, index, label));
  const seenKinds = new Set();
  for (const receipt of receipts) {
    if (seenKinds.has(receipt.kind)) {
      throw new Error(`${label} declares more than one lease binding of kind ${JSON.stringify(receipt.kind)}.`);
    }
    seenKinds.add(receipt.kind);
  }
  return Object.freeze(receipts);
}

function assertAcceptanceCrossFieldInvariants(acceptance, nativeTurnRef, nativeSessionRef, acceptanceEvidenceAt, label) {
  if (acceptance === "not_submitted") {
    if (nativeTurnRef !== null) throw new Error(`${label} not_submitted must not carry a native turn reference.`);
    if (nativeSessionRef !== null) throw new Error(`${label} not_submitted must not carry a native session reference.`);
    if (acceptanceEvidenceAt !== null) throw new Error(`${label} not_submitted must not carry an acceptance evidence timestamp.`);
    return;
  }
  if (acceptanceEvidenceAt === null) {
    throw new Error(`${label} acceptance ${acceptance} requires an acceptance evidence timestamp.`);
  }
  if (acceptance === "acceptance_proven") {
    if (nativeTurnRef === null) {
      throw new Error(`${label} acceptance_proven requires an exact canonical native turn reference.`);
    }
    // nativeSessionRef may be null or non-null here: it is drawn from the
    // same branded evidence as nativeTurnRef but a fresh session may
    // legitimately have none. It never substitutes for nativeTurnRef and is
    // never independently required.
    return;
  }
  // acceptance_rejected and acceptance_unknown both carry evidence of the
  // *absence* of a proven turn; neither may carry a native turn or session
  // reference.
  if (nativeTurnRef !== null) {
    throw new Error(`${label} acceptance ${acceptance} must not carry a native turn reference.`);
  }
  if (nativeSessionRef !== null) {
    throw new Error(`${label} acceptance ${acceptance} must not carry a native session reference.`);
  }
}

function assertSubmissionCrossFieldInvariants(submissionState, submissionStartedAt, label) {
  if (submissionState === "not_started") {
    if (submissionStartedAt !== null) {
      throw new Error(`${label} submissionState not_started must not carry a submission-started timestamp.`);
    }
    return;
  }
  if (["rollback_in_progress", "rollback_complete"].includes(submissionState)) return;
  if (submissionStartedAt === null) {
    throw new Error(`${label} submissionState started requires a submission-started timestamp.`);
  }
}

/** `updatedAt`/`acceptanceEvidenceAt`/`submissionStartedAt` must never precede `createdAt`, and `submissionStartedAt` must never follow `acceptanceEvidenceAt` when both exist. */
function assertTimestampMonotonicity(createdAt, updatedAt, acceptanceEvidenceAt, submissionStartedAt, label) {
  const createdMs = Date.parse(createdAt);
  if (Date.parse(updatedAt) < createdMs) {
    throw new Error(`${label} updatedAt must not precede createdAt.`);
  }
  if (acceptanceEvidenceAt != null && Date.parse(acceptanceEvidenceAt) < createdMs) {
    throw new Error(`${label} acceptanceEvidenceAt must not precede createdAt.`);
  }
  if (submissionStartedAt != null && Date.parse(submissionStartedAt) < createdMs) {
    throw new Error(`${label} submissionStartedAt must not precede createdAt.`);
  }
  if (
    submissionStartedAt != null && acceptanceEvidenceAt != null &&
    Date.parse(submissionStartedAt) > Date.parse(acceptanceEvidenceAt)
  ) {
    throw new Error(`${label} submissionStartedAt must not follow acceptanceEvidenceAt.`);
  }
}

function validateLaunchClaimRecord(parsed) {
  const label = "Launch claim record";
  const snapshot = plainRecordSnapshot(parsed, label);
  // Claims written before effective options became a durable worker handoff
  // remain readable. Their next native operation receives null and the owning
  // Driver must freshly prove an effective option or fail closed.
  const hasTurnOptions = Object.hasOwn(snapshot, "turnOptions");
  assertClosedFieldSet(snapshot, hasTurnOptions
    ? LAUNCH_CLAIM_FIELDS
    : LAUNCH_CLAIM_FIELDS.filter((field) => field !== "turnOptions"), label);
  if (snapshot.version !== LAUNCH_CLAIM_SCHEMA_VERSION) {
    throw taggedError(
      "unsupported_version",
      `${label} declares unsupported schema version ${JSON.stringify(snapshot.version ?? null)}.`
    );
  }
  const identity = assertBindingIdentity(snapshot);
  const attemptId = assertIdentityText(snapshot.attemptId, `${label} attemptId`);
  const route = validateStoredVersionThreeRoute(snapshot.route, `${label} route`);
  const leaseState = ["intended", "acquired"].includes(snapshot.leaseState) ? snapshot.leaseState : null;
  if (leaseState == null) throw new Error(`${label} has an unsupported leaseState.`);
  const leaseIntent = validateLeaseBindingsList(snapshot.leaseIntent, `${label} leaseIntent`);
  if (leaseIntent.length === 0) throw new Error(`${label} requires at least one exact lease intent.`);
  const leaseBindings = validateLeaseBindingsList(snapshot.leaseBindings, `${label} leaseBindings`);
  const expectedRouteDigest = routeDigestOf(route);
  for (const receipt of [...leaseIntent, ...leaseBindings]) {
    if (receipt.ownerRootId !== identity.ownerRootId || receipt.agentId !== identity.agentId || receipt.jobId !== identity.jobId) {
      throw new Error(`${label} lease binding identity does not match this launch claim's own owner root/Agent/job.`);
    }
    if (receipt.routeDigest !== expectedRouteDigest) {
      throw taggedError(
        "identity_drift",
        `${label} lease binding route digest does not match this launch claim's full canonical route/capability snapshot.`
      );
    }
  }
  if (leaseState === "intended" && leaseBindings.length !== 0) {
    throw new Error(`${label} intended lease must not claim acquired bindings.`);
  }
  if (
    leaseState === "acquired" &&
    JSON.stringify(leaseBindings) !== JSON.stringify(leaseIntent)
  ) {
    throw new Error(`${label} acquired lease must bind exactly its durable pre-acquisition intent.`);
  }
  const assignedMessageIds = assertAssignedMessageIds(snapshot.assignedMessageIds, `${label} assignedMessageIds`);
  const turnOptions = hasTurnOptions
    ? canonicalTurnOptions(snapshot.turnOptions, `${label} turnOptions`)
    : null;
  const inputDigest = assertInputDigest(snapshot.inputDigest);
  const acceptance = LAUNCH_ACCEPTANCE_VALUES.includes(snapshot.acceptance) ? snapshot.acceptance : null;
  if (acceptance == null) {
    throw new Error(
      `${label} has an unsupported acceptance: ${JSON.stringify(snapshot.acceptance ?? null)}. ` +
      `Use one of: ${LAUNCH_ACCEPTANCE_VALUES.join(", ")}.`
    );
  }
  const nativeTurnRef = snapshot.nativeTurnRef === null ? null : canonicalizeNativeReference(snapshot.nativeTurnRef, `${label} native turn reference`);
  if (nativeTurnRef != null) assertNativeReferenceMatchesRoute(nativeTurnRef, route, label);
  const nativeSessionRef = snapshot.nativeSessionRef === null ? null : canonicalizeNativeReference(snapshot.nativeSessionRef, `${label} native session reference`);
  if (nativeSessionRef != null) assertNativeReferenceMatchesRoute(nativeSessionRef, route, label);
  const acceptanceEvidenceAt = assertOptionalTimestampText(snapshot.acceptanceEvidenceAt, `${label} acceptanceEvidenceAt`);
  assertAcceptanceCrossFieldInvariants(acceptance, nativeTurnRef, nativeSessionRef, acceptanceEvidenceAt, label);
  const submissionState = SUBMISSION_STATES.includes(snapshot.submissionState) ? snapshot.submissionState : null;
  if (submissionState == null) {
    throw new Error(
      `${label} has an unsupported submissionState: ${JSON.stringify(snapshot.submissionState ?? null)}. ` +
      `Use one of: ${SUBMISSION_STATES.join(", ")}.`
    );
  }
  const submissionStartedAt = assertOptionalTimestampText(snapshot.submissionStartedAt, `${label} submissionStartedAt`);
  assertSubmissionCrossFieldInvariants(submissionState, submissionStartedAt, label);
  const sanitizedDetail = assertOptionalDetailText(snapshot.sanitizedDetail, `${label} sanitizedDetail`);
  const createdAt = assertTimestampText(snapshot.createdAt, `${label} createdAt`);
  const updatedAt = assertTimestampText(snapshot.updatedAt, `${label} updatedAt`);
  assertTimestampMonotonicity(createdAt, updatedAt, acceptanceEvidenceAt, submissionStartedAt, label);
  return Object.freeze({
    version: LAUNCH_CLAIM_SCHEMA_VERSION,
    ownerRootId: identity.ownerRootId,
    agentId: identity.agentId,
    jobId: identity.jobId,
    attemptId,
    route,
    leaseState,
    leaseIntent,
    leaseBindings,
    assignedMessageIds,
    ...(hasTurnOptions ? { turnOptions } : {}),
    inputDigest,
    acceptance,
    nativeTurnRef,
    nativeSessionRef,
    acceptanceEvidenceAt,
    sanitizedDetail,
    submissionState,
    submissionStartedAt,
    createdAt,
    updatedAt,
  });
}

function validateLegacyLaunchClaimRecord(parsed) {
  const snapshot = plainRecordSnapshot(parsed, "Legacy launch claim record");
  assertClosedFieldSet(snapshot, LEGACY_LAUNCH_CLAIM_FIELDS, "Legacy launch claim record");
  if (snapshot.version !== LEGACY_LAUNCH_CLAIM_SCHEMA_VERSION) {
    throw taggedError(
      "unsupported_version",
      `Legacy launch claim record declares unsupported schema version ${JSON.stringify(snapshot.version ?? null)}.`
    );
  }
  if (!Array.isArray(snapshot.leaseBindings) || snapshot.leaseBindings.length === 0) {
    throw new Error("Legacy launch claim record requires nonempty acquired lease bindings.");
  }
  return validateLaunchClaimRecord({
    ...snapshot,
    version: LAUNCH_CLAIM_SCHEMA_VERSION,
    leaseState: "acquired",
    leaseIntent: snapshot.leaseBindings,
  });
}

/**
 * Read and validate one durable claim record. Beyond
 * `validateLaunchClaimRecord()` itself, this additionally proves the record
 * was not moved, copied, or hand-placed somewhere other than the exact
 * directory/filename its own identity derives. A parse, shape, or drift
 * failure throws with a closed `.code` rather than being silently skipped or
 * deleted.
 */
function readClaimFile(filePath, expectedDir, { legacy = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw taggedError("corrupt_or_unreadable", `Launch claim record ${filePath} is unreadable: ${error?.message ?? error}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw taggedError("corrupt_json", `Launch claim record ${filePath} is corrupt: invalid JSON.`);
  }
  let record;
  try {
    record = legacy ? validateLegacyLaunchClaimRecord(parsed) : validateLaunchClaimRecord(parsed);
  } catch (error) {
    throw taggedError(error.code ?? "invalid_shape", `Launch claim record ${filePath} is corrupt: ${error.message}`);
  }
  const derivedDir = legacy
    ? resolveLegacyLaunchClaimDirectory(record)
    : resolveLaunchClaimDirectory(record);
  const expectedFile = path.join(derivedDir, claimFileName(record.attemptId));
  if (expectedDir !== derivedDir || filePath !== expectedFile) {
    throw taggedError(
      "identity_drift",
      `Launch claim record ${filePath} does not live at the directory/filename its own identity derives.`
    );
  }
  return record;
}

function readClaimFiles(claimDir, options = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(claimDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    records.push(readClaimFile(path.join(claimDir, entry.name), claimDir, options));
  }
  return records;
}

/**
 * At most one durable launch claim may ever exist for one job activation.
 * More than one valid record present is a corruption/tamper shape no ordinary
 * write can produce -- `createLaunchClaim()`'s own exclusivity check refuses
 * a second `attemptId` before ever writing a second file -- so this fails
 * closed rather than guessing which one is authoritative.
 */
function readSingleClaimRecord(claimDir, options = {}) {
  const records = readClaimFiles(claimDir, options);
  if (records.length === 0) return null;
  if (records.length > 1) {
    throw taggedError(
      "multiple_launch_claims_present",
      `More than one launch claim record is present for one job activation in ${claimDir}; this is a corruption/tamper shape.`
    );
  }
  return records[0];
}

function readCurrentOrMigrateWhileLocked(identity) {
  const currentDir = resolveLaunchClaimDirectory(identity);
  const current = readSingleClaimRecord(currentDir);
  const legacy = readSingleClaimRecord(resolveLegacyLaunchClaimDirectory(identity), { legacy: true });
  if (current && legacy && JSON.stringify(current) !== JSON.stringify(legacy)) {
    throw taggedError(
      "ambiguous_launch_claim_versions",
      "Legacy and current launch claims disagree for the same owner root, Agent, and job."
    );
  }
  if (current) return current;
  if (!legacy) return null;
  ensureDirectory(currentDir);
  writeAtomicClaimFile(
    path.join(currentDir, claimFileName(legacy.attemptId)),
    legacy,
    { createOnly: true },
  );
  return readSingleClaimRecord(currentDir);
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/** Read the one launch claim for a job, migrating an immutable v1 record to v2 when needed. */
export function readLaunchClaim({ ownerRootId, agentId, jobId }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const claimDir = resolveLaunchClaimDirectory(identity);
  const current = readSingleClaimRecord(claimDir);
  const legacy = readSingleClaimRecord(resolveLegacyLaunchClaimDirectory(identity), { legacy: true });
  if (current && legacy && JSON.stringify(current) !== JSON.stringify(legacy)) {
    throw taggedError(
      "ambiguous_launch_claim_versions",
      "Legacy and current launch claims disagree for the same owner root, Agent, and job."
    );
  }
  if (current) return current;
  if (!legacy) return null;
  const lock = acquireDirectoryLock(claimDir);
  try {
    return readCurrentOrMigrateWhileLocked(identity);
  } finally {
    releaseDirectoryLock(lock);
  }
}

const MAX_RECONCILIATION_CLAIM_DIRECTORIES = 4096;
const MAX_RECONCILIATION_FILES_PER_DIRECTORY = 4;

function scanClaimRoot(version, ownerRootId) {
  const root = resolveLaunchClaimRoot(version);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (directories.length > MAX_RECONCILIATION_CLAIM_DIRECTORIES) {
    throw taggedError(
      "launch_claim_scan_bound_exceeded",
      "Launch claim reconciliation scan exceeds its fixed directory bound."
    );
  }
  const records = [];
  for (const entry of directories) {
    const directory = path.join(root, entry.name);
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"));
    if (files.length > MAX_RECONCILIATION_FILES_PER_DIRECTORY) {
      throw taggedError(
        "launch_claim_scan_bound_exceeded",
        "Launch claim reconciliation scan exceeds its fixed per-directory file bound."
      );
    }
    const matching = [];
    for (const file of files) {
      const filePath = path.join(directory, file.name);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        throw taggedError("corrupt_json", "Launch claim reconciliation encountered invalid JSON.");
      }
      if (typeof parsed?.ownerRootId !== "string") {
        throw taggedError("invalid_shape", "Launch claim reconciliation encountered an invalid owner root identity.");
      }
      if (parsed.ownerRootId !== ownerRootId) continue;
      matching.push(readClaimFile(filePath, directory, {
        legacy: version === LEGACY_LAUNCH_CLAIM_SCHEMA_VERSION,
      }));
    }
    if (matching.length > 1) {
      throw taggedError(
        "multiple_launch_claims_present",
        "More than one launch claim record is present for one current-root job activation."
      );
    }
    if (matching[0]) records.push(matching[0]);
  }
  return records;
}

/** Bounded internal inventory for one exact owner root; never exposes prompt/input text. */
export function listLaunchClaimsForOwnerRoot({ ownerRootId }) {
  const root = assertIdentityText(ownerRootId, "Launch claim owner root ID");
  const claims = new Map();
  for (const record of scanClaimRoot(LAUNCH_CLAIM_SCHEMA_VERSION, root)) {
    claims.set(claimJobIdentityKey(record), record);
  }
  for (const legacy of scanClaimRoot(LEGACY_LAUNCH_CLAIM_SCHEMA_VERSION, root)) {
    const key = claimJobIdentityKey(legacy);
    const current = claims.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(legacy)) {
      throw taggedError(
        "ambiguous_launch_claim_versions",
        "Legacy and current launch claims disagree for the same owner root, Agent, and job."
      );
    }
    if (!current) claims.set(key, legacy);
  }
  return Object.freeze([...claims.values()]);
}

/**
 * Verify that a detached worker is consuming the exact claim its parent
 * prepared. This recomputes the private input digest but never creates or
 * advances durable state.
 */
export function verifyPreparedLaunchClaim(input) {
  const snapshot = plainRecordSnapshot(input, "Prepared launch claim verification input");
  assertNoUnknownFields(snapshot, [
    "ownerRootId", "agentId", "jobId", "attemptId", "route",
    "assignedMessageIds", "preparedInput", "turnOptions",
  ], "Prepared launch claim verification input");
  const identity = assertBindingIdentity(snapshot);
  const stored = readLaunchClaim(identity);
  if (!stored) throw taggedError("not_found", `No launch claim exists for job ${identity.jobId}.`);
  const attemptId = assertIdentityText(snapshot.attemptId, "Prepared launch claim attemptId");
  const route = validateVersionThreeRoute(snapshot.route, "Prepared launch claim route");
  const assignedMessageIds = assertAssignedMessageIds(
    snapshot.assignedMessageIds, "Prepared launch claim assignedMessageIds"
  );
  const inputDigest = computeInputDigest(
    assignedMessageIds,
    assertPreparedInputText(snapshot.preparedInput, "Prepared launch claim input"),
    canonicalTurnOptionsText(snapshot.turnOptions ?? null, "Prepared launch claim turnOptions"),
  );
  if (
    stored.attemptId !== attemptId ||
    JSON.stringify(stored.route) !== JSON.stringify(route) ||
    JSON.stringify(stored.assignedMessageIds) !== JSON.stringify(assignedMessageIds) ||
    stored.inputDigest !== inputDigest
  ) {
    throw taggedError("prepared_claim_mismatch", "Detached worker input does not match its durable prepared launch claim.");
  }
  if (["rollback_in_progress", "rollback_complete"].includes(stored.submissionState)) {
    throw taggedError("rollback_fenced", "Detached worker is fenced by durable pre-submission rollback.");
  }
  if (stored.leaseState !== "acquired") {
    throw taggedError("lease_not_acquired", "Detached worker launch claim has not durably bound its intended lease.");
  }
  return stored;
}

const CREATE_INPUT_FIELDS = Object.freeze([
  "ownerRootId", "agentId", "jobId", "attemptId",
  "route", "leaseBindings", "assignedMessageIds", "preparedInput", "turnOptions",
]);

function prepareLaunchClaimCreate(input) {
  const snapshot = plainRecordSnapshot(input, "Launch claim create input");
  for (const field of Object.keys(snapshot)) {
    if (!CREATE_INPUT_FIELDS.includes(field)) {
      throw new Error(
        `Launch claim create input declares an unsupported field: ${JSON.stringify(field)}. ` +
        `Use one of: ${CREATE_INPUT_FIELDS.join(", ")}. In particular, inputDigest/acceptance/nativeTurnRef/` +
        `acceptanceEvidenceAt/submissionState are never create inputs -- inputDigest is always computed here from ` +
        `assignedMessageIds/preparedInput/turnOptions, and every launch claim starts as ` +
        `not_submitted/not_started.`
      );
    }
  }
  // Turn options are required to be *stated*, not required to be non-empty. A
  // route whose Driver owns no turn options states `null`; omitting the field
  // is refused, so an attempt can never be claimed under options nobody
  // declared and no default is invented here.
  if (!Object.hasOwn(snapshot, "turnOptions")) {
    throw new Error(
      "Launch claim create input requires an explicit turnOptions value; state null when the accepted " +
      "route's Driver owns no turn options."
    );
  }
  const {
    ownerRootId, agentId, jobId, attemptId, route, leaseBindings, assignedMessageIds, preparedInput,
    turnOptions,
  } = snapshot;
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const canonicalAttemptId = assertIdentityText(attemptId, "Launch claim attemptId");
  const canonicalRoute = validateVersionThreeRoute(route, "Launch claim route");
  const boundRouteDigest = routeDigestOf(canonicalRoute);
  const canonicalLeaseBindings = canonicalizeLeaseBindings(leaseBindings, identity, canonicalRoute, boundRouteDigest);
  const canonicalAssignedMessageIds = assertAssignedMessageIds(assignedMessageIds, "Launch claim assignedMessageIds");
  const canonicalPreparedInput = assertPreparedInputText(preparedInput, "Launch claim preparedInput");
  const canonicalOptions = canonicalTurnOptions(turnOptions ?? null, "Launch claim turnOptions");
  const canonicalOptionsText = canonicalOptions === null
    ? "none"
    : `stated\0${JSON.stringify(canonicalOptions)}`;
  const canonicalInputDigest = computeInputDigest(
    canonicalAssignedMessageIds,
    canonicalPreparedInput,
    canonicalOptionsText
  );
  return {
    identity,
    canonicalAttemptId,
    canonicalRoute,
    canonicalLeaseBindings,
    canonicalAssignedMessageIds,
    canonicalTurnOptions: canonicalOptions,
    canonicalInputDigest,
    claimDir: resolveLaunchClaimDirectory(identity),
  };
}

function createLaunchClaimWhileLocked(prepared) {
  const {
    identity, canonicalAttemptId, canonicalRoute, canonicalLeaseBindings,
    canonicalAssignedMessageIds, canonicalInputDigest, claimDir,
  } = prepared;
  const leaseState = prepared.leaseState ?? "acquired";
  const leaseIntent = prepared.leaseIntent ?? canonicalLeaseBindings;
  const existing = readCurrentOrMigrateWhileLocked(identity);
  if (existing) {
    if (existing.attemptId !== canonicalAttemptId) {
      throw taggedError(
        "already_claimed_by_other_attempt",
        `Launch claim for job ${identity.jobId} is already claimed by a different attempt ` +
        `(${JSON.stringify(existing.attemptId)}); a different attempt cannot claim it while that claim exists.`
      );
    }
    const identical = (
      JSON.stringify(existing.route) === JSON.stringify(canonicalRoute) &&
      existing.leaseState === leaseState &&
      JSON.stringify(existing.leaseIntent) === JSON.stringify(leaseIntent) &&
      JSON.stringify(existing.leaseBindings) === JSON.stringify(canonicalLeaseBindings) &&
      JSON.stringify(existing.turnOptions ?? null) === JSON.stringify(prepared.canonicalTurnOptions) &&
      JSON.stringify(existing.assignedMessageIds) === JSON.stringify(canonicalAssignedMessageIds) &&
      existing.inputDigest === canonicalInputDigest
    );
    if (!identical) {
      throw new Error(
        `Launch claim attemptId ${JSON.stringify(canonicalAttemptId)} identity mismatch: this exact attempt ` +
        `already exists with different route/lease bindings/mailbox identity/prepared input/turn options, ` +
        `and none may be silently replaced.`
      );
    }
    return existing;
  }
  const createdAt = nowIso();
  const record = validateLaunchClaimRecord({
    version: LAUNCH_CLAIM_SCHEMA_VERSION,
    ownerRootId: identity.ownerRootId,
    agentId: identity.agentId,
    jobId: identity.jobId,
    attemptId: canonicalAttemptId,
    route: canonicalRoute,
    leaseState,
    leaseIntent,
    leaseBindings: canonicalLeaseBindings,
    assignedMessageIds: canonicalAssignedMessageIds,
    turnOptions: prepared.canonicalTurnOptions,
    inputDigest: canonicalInputDigest,
    acceptance: "not_submitted",
    nativeTurnRef: null,
    nativeSessionRef: null,
    acceptanceEvidenceAt: null,
    sanitizedDetail: null,
    submissionState: "not_started",
    submissionStartedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  const filePath = path.join(claimDir, claimFileName(canonicalAttemptId));
  writeAtomicClaimFile(filePath, record, { createOnly: true });
  return record;
}

/**
 * Durably bind one unique launch claim/attempt for one job activation, or
 * return the exact existing claim for a repeated identical request
 * (idempotent retry, including from an independent process). Exactly one
 * `attemptId` may ever win: a different `attemptId` presented while a claim
 * already exists fails closed without rewriting the stored record, and a
 * repeated `attemptId` whose route/lease bindings/mailbox identity/prepared
 * input conflicts with the stored claim fails closed the same way. Records
 * `acceptance: "not_submitted"`, `submissionState: "not_started"` -- the only
 * initial values -- with no native turn/session reference.
 *
 * `preparedInput` is the exact prepared input text this attempt
 * submits. It is used only in memory, here, to compute the module-owned
 * `inputDigest` (see `computeInputDigest()`); it is never itself persisted,
 * logged, or returned.
 *
 * @param {{ownerRootId: string, agentId: string, jobId: string, attemptId: string,
 *   route: *, leaseBindings: *[], assignedMessageIds: string[], preparedInput: string,
 *   turnOptions?: object|null}} input
 */
export function createLaunchClaim(input) {
  const prepared = prepareLaunchClaimCreate(input);
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    return createLaunchClaimWhileLocked(prepared);
  } finally {
    releaseDirectoryLock(lock);
  }
}

/** Async-contention counterpart used by the live Driver worker. */
export async function createLaunchClaimAsync(input) {
  const prepared = prepareLaunchClaimCreate(input);
  const lock = await acquireDirectoryLockAsync(prepared.claimDir);
  try {
    return createLaunchClaimWhileLocked(prepared);
  } finally {
    releaseDirectoryLock(lock);
  }
}

const INTENT_INPUT_FIELDS = Object.freeze([
  "ownerRootId", "agentId", "jobId", "attemptId", "route", "expectedLease",
  "assignedMessageIds", "preparedInput", "turnOptions",
]);

function expectedLeaseReceipt(expectedLease, identity, route) {
  const snapshot = plainRecordSnapshot(expectedLease, "Launch claim expected lease");
  const kind = snapshot.kind;
  if (!["instance", "native_session"].includes(kind)) {
    throw new Error("Launch claim expected lease kind must be instance or native_session.");
  }
  const expectedFields = kind === "instance"
    ? ["kind", "capacityClass", "capacityLimit"]
    : ["kind", "nativeSessionId"];
  assertClosedFieldSet(snapshot, expectedFields, "Launch claim expected lease");
  const keyFields = kind === "instance"
    ? Object.freeze({ harnessId: route.harnessId, instanceKey: route.instanceKey })
    : Object.freeze({
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        nativeSessionId: assertIdentityText(snapshot.nativeSessionId, "Launch claim expected native session ID"),
      });
  const capacity = kind === "instance"
    ? validateStoredCapacity(
        { class: snapshot.capacityClass, limit: snapshot.capacityLimit },
        "Launch claim expected instance capacity",
      )
    : Object.freeze({ class: null, limit: 1 });
  const routeDigest = routeDigestOf(route);
  return Object.freeze({
    kind,
    keyFields,
    capacity,
    routeDigest,
    ...identity,
    evidenceDigest: evidenceDigestOf({ kind, keyFields, capacity, routeDigest, ...identity }),
  });
}

/** Persist exact launch and lease intent before acquiring the intended holder. */
export function createLaunchIntent(input) {
  const snapshot = plainRecordSnapshot(input, "Launch claim intent input");
  assertNoUnknownFields(snapshot, INTENT_INPUT_FIELDS, "Launch claim intent input");
  if (!Object.hasOwn(snapshot, "turnOptions")) throw new Error("Launch claim intent requires turnOptions.");
  const identity = assertBindingIdentity(snapshot);
  const canonicalRoute = validateVersionThreeRoute(snapshot.route, "Launch claim intent route");
  const leaseIntent = expectedLeaseReceipt(snapshot.expectedLease, identity, canonicalRoute);
  const assignedMessageIds = assertAssignedMessageIds(snapshot.assignedMessageIds, "Launch claim intent assignedMessageIds");
  const inputDigest = computeInputDigest(
    assignedMessageIds,
    assertPreparedInputText(snapshot.preparedInput, "Launch claim intent preparedInput"),
    canonicalTurnOptionsText(snapshot.turnOptions ?? null, "Launch claim intent turnOptions"),
  );
  const prepared = {
    identity,
    canonicalAttemptId: assertIdentityText(snapshot.attemptId, "Launch claim intent attemptId"),
    canonicalRoute,
    canonicalLeaseBindings: Object.freeze([]),
    canonicalAssignedMessageIds: assignedMessageIds,
    canonicalTurnOptions: canonicalTurnOptions(snapshot.turnOptions ?? null, "Launch claim intent turnOptions"),
    canonicalInputDigest: inputDigest,
    leaseState: "intended",
    leaseIntent: [leaseIntent],
    claimDir: resolveLaunchClaimDirectory(identity),
  };
  const lock = acquireDirectoryLock(prepared.claimDir);
  try { return createLaunchClaimWhileLocked(prepared); }
  finally { releaseDirectoryLock(lock); }
}

/** Bind the exact branded acquisition to its already durable intent. */
export function bindLaunchClaimLease({ ownerRootId, agentId, jobId, attemptId, lease }) {
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  const claimDir = resolveLaunchClaimDirectory(identity);
  const lock = acquireDirectoryLock(claimDir);
  try {
    const { filePath, record } = loadClaimForMutation(identity, attemptId, "Launch claim lease binding");
    if (record.leaseState === "acquired") return record;
    if (record.submissionState !== "not_started" || record.acceptance !== "not_submitted") {
      throw new Error("Launch claim lease binding must precede native submission.");
    }
    const receipt = leaseBindingReceipt(
      lease, identity, record.route, routeDigestOf(record.route), "Launch claim acquired lease",
    );
    if (JSON.stringify([receipt]) !== JSON.stringify(record.leaseIntent)) {
      throw new Error("Acquired lease does not match the durable pre-acquisition intent.");
    }
    const updated = validateLaunchClaimRecord({
      ...record,
      leaseState: "acquired",
      leaseBindings: [receipt],
      updatedAt: nowIso(),
    });
    writeAtomicClaimFile(filePath, updated);
    return updated;
  } finally { releaseDirectoryLock(lock); }
}

function loadClaimForMutation(identity, attemptId, label) {
  const canonicalAttemptId = assertIdentityText(attemptId, `${label} attemptId`);
  const claimDir = resolveLaunchClaimDirectory(identity);
  const record = readCurrentOrMigrateWhileLocked(identity);
  if (!record) {
    throw taggedError("not_found", `No launch claim exists for job ${identity.jobId}.`);
  }
  if (record.attemptId !== canonicalAttemptId) {
    throw taggedError(
      "wrong_attempt",
      `${label} refuses a wrong-attempt call: this job's launch claim is bound to attemptId ` +
      `${JSON.stringify(record.attemptId)}, not ${JSON.stringify(canonicalAttemptId)}. Only the exact winning ` +
      `attemptId may record this claim's acceptance.`
    );
  }
  validateVersionThreeRoute(record.route, `${label} activation route`);
  return { claimDir, filePath: path.join(claimDir, claimFileName(canonicalAttemptId)), record };
}

const SUBMISSION_STARTED_INPUT_FIELDS = Object.freeze(["ownerRootId", "agentId", "jobId", "attemptId"]);

function prepareClaimIdentityInput(input, fields, label) {
  const snapshot = plainRecordSnapshot(input, label);
  assertNoUnknownFields(snapshot, fields, label);
  const { ownerRootId, agentId, jobId, attemptId } = snapshot;
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return { snapshot, identity, attemptId, claimDir: resolveLaunchClaimDirectory(identity) };
}

function markNativeSubmissionStartedWhileLocked({ identity, attemptId }) {
  const { filePath, record } = loadClaimForMutation(identity, attemptId, "Launch claim submission-started");
  if (record.submissionState === "started") return { started: false, record };
  if (["rollback_in_progress", "rollback_complete"].includes(record.submissionState)) {
    throw new Error("Launch claim submission-started is fenced by a pre-submission rollback.");
  }
  if (record.leaseState !== "acquired") {
    throw new Error("Launch claim submission-started requires durable acquired lease proof.");
  }
  if (record.acceptance !== "not_submitted") {
    throw new Error(
      `Launch claim submission-started refuses to start submission after acceptance has already been recorded ` +
      `as ${record.acceptance}; marking submission started only ever precedes acceptance evidence.`
    );
  }
  const updatedAt = nowIso();
  const updated = validateLaunchClaimRecord({
    ...record,
    submissionState: "started",
    submissionStartedAt: updatedAt,
    updatedAt,
  });
  writeAtomicClaimFile(filePath, updated);
  return { started: true, record: updated };
}

/**
 * The pre-submission fence: durably mark that a native submission attempt is
 * about to begin, immediately before any possible `startTurn()` call.
 * Monotonic and idempotent: `not_started -> started` exactly once, and a
 * repeat call while already `started` is a no-op returning the record
 * unchanged (`submissionStartedAt` is never moved forward by a replay).
 * There is no function to move `started` back to `not_started` -- this fence
 * exists precisely so a crash or lock failure between this call and the
 * later acceptance recording leaves an honest, rollback-unsafe trace (see
 * `launchClaimRollbackEligibility()`), not so it can be undone.
 *
 * Refuses to start submission once acceptance has already moved past
 * `not_submitted` (a call after `recordLaunchAcceptance*()` is out of the
 * order `design.md` decision 4 requires and is refused rather than silently
 * accepted).
 */
export function markNativeSubmissionStarted(input) {
  const prepared = prepareClaimIdentityInput(
    input, SUBMISSION_STARTED_INPUT_FIELDS, "Launch claim submission-started input"
  );
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    return markNativeSubmissionStartedWhileLocked(prepared).record;
  } finally {
    releaseDirectoryLock(lock);
  }
}

/**
 * Atomically claim the one native-submission start transition. Exactly one
 * concurrent caller observes `started: true`; an idempotent replay observes
 * the already-started record with `started: false` and must not call the
 * Driver again.
 */
export async function claimNativeSubmissionStartAsync(input) {
  const prepared = prepareClaimIdentityInput(
    input, SUBMISSION_STARTED_INPUT_FIELDS, "Launch claim submission-started input"
  );
  const lock = await acquireDirectoryLockAsync(prepared.claimDir);
  try {
    return Object.freeze(markNativeSubmissionStartedWhileLocked(prepared));
  } finally {
    releaseDirectoryLock(lock);
  }
}

/**
 * The acceptance lattice: `not_submitted -> {acceptance_rejected,
 * acceptance_unknown, acceptance_proven}`, `acceptance_unknown ->
 * {acceptance_unknown, acceptance_proven}`, `acceptance_rejected ->
 * {acceptance_rejected}` (sticky terminal), `acceptance_proven ->
 * {acceptance_proven}` (sticky terminal). `acceptance_proven`/
 * `acceptance_unknown` never regress to `not_submitted`/`acceptance_rejected`,
 * and `acceptance_rejected` never advances to anything else: a Driver-proven
 * pre-transport rejection is a confident, final fact, not a starting point
 * for later proof.
 */
function assertAcceptanceTransitionAllowed(currentAcceptance, nextAcceptance) {
  const allowed = {
    not_submitted: new Set(["acceptance_rejected", "acceptance_unknown", "acceptance_proven"]),
    acceptance_unknown: new Set(["acceptance_unknown", "acceptance_proven"]),
    acceptance_rejected: new Set(["acceptance_rejected"]),
    acceptance_proven: new Set(["acceptance_proven"]),
  };
  if (!allowed[currentAcceptance]?.has(nextAcceptance)) {
    throw new Error(
      `Launch claim conflicting acceptance transition: cannot move from ${currentAcceptance} to ${nextAcceptance}.`
    );
  }
}

const REJECTED_INPUT_FIELDS = Object.freeze(["ownerRootId", "agentId", "jobId", "attemptId", "sanitizedDetail"]);

function prepareSimpleAcceptanceInput(input, fields, label) {
  const prepared = prepareClaimIdentityInput(input, fields, label);
  return {
    ...prepared,
    canonicalDetail: assertOptionalDetailText(prepared.snapshot.sanitizedDetail ?? null, `${label} sanitizedDetail`),
  };
}

function recordSimpleAcceptanceWhileLocked(prepared, nextAcceptance, mutationLabel) {
  const { identity, attemptId, canonicalDetail } = prepared;
  const { filePath, record } = loadClaimForMutation(identity, attemptId, mutationLabel);
  if (record.acceptance === nextAcceptance && nextAcceptance === "acceptance_rejected") return record;
  assertAcceptanceTransitionAllowed(record.acceptance, nextAcceptance);
  const updatedAt = nowIso();
  const updated = validateLaunchClaimRecord({
    ...record,
    acceptance: nextAcceptance,
    nativeTurnRef: null,
    nativeSessionRef: null,
    acceptanceEvidenceAt: updatedAt,
    sanitizedDetail: canonicalDetail ?? record.sanitizedDetail,
    updatedAt,
  });
  writeAtomicClaimFile(filePath, updated);
  return updated;
}

/**
 * Record a Driver-proven pre-transport rejection: no native request ever
 * crossed the transport boundary. Idempotent for a repeat once already
 * `acceptance_rejected`; fails closed (never regresses) once the claim
 * already recorded `acceptance_unknown` or `acceptance_proven`. Independent
 * of `submissionState`: a rejection can be proven whether or not
 * `markNativeSubmissionStarted()` was ever called (the Driver call itself
 * may throw with pre-transport proof immediately after the fence is set).
 */
export function recordLaunchAcceptanceRejected(input) {
  const prepared = prepareSimpleAcceptanceInput(
    input, REJECTED_INPUT_FIELDS, "Launch claim rejection input"
  );
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    return recordSimpleAcceptanceWhileLocked(prepared, "acceptance_rejected", "Launch claim rejection");
  } finally {
    releaseDirectoryLock(lock);
  }
}

/** Async-contention counterpart for genuine Driver pre-transport rejection. */
export async function recordLaunchAcceptanceRejectedAsync(input) {
  const prepared = prepareSimpleAcceptanceInput(
    input, REJECTED_INPUT_FIELDS, "Launch claim rejection input"
  );
  const lock = await acquireDirectoryLockAsync(prepared.claimDir);
  try {
    return recordSimpleAcceptanceWhileLocked(prepared, "acceptance_rejected", "Launch claim rejection");
  } finally {
    releaseDirectoryLock(lock);
  }
}

const UNKNOWN_INPUT_FIELDS = Object.freeze(["ownerRootId", "agentId", "jobId", "attemptId", "sanitizedDetail"]);

/**
 * Record that the call may have crossed the native transport boundary but an
 * exact native-turn reference could not be durably proven. Repeatable while
 * `acceptance_unknown` (each call refreshes evidence); fails closed once the
 * claim already recorded `acceptance_rejected` or `acceptance_proven`.
 */
export function recordLaunchAcceptanceUnknown(input) {
  const prepared = prepareSimpleAcceptanceInput(
    input, UNKNOWN_INPUT_FIELDS, "Launch claim unknown-acceptance input"
  );
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    return recordSimpleAcceptanceWhileLocked(prepared, "acceptance_unknown", "Launch claim unknown-acceptance");
  } finally {
    releaseDirectoryLock(lock);
  }
}

/** Async-contention counterpart for ambiguous native acceptance. */
export async function recordLaunchAcceptanceUnknownAsync(input) {
  const prepared = prepareSimpleAcceptanceInput(
    input, UNKNOWN_INPUT_FIELDS, "Launch claim unknown-acceptance input"
  );
  const lock = await acquireDirectoryLockAsync(prepared.claimDir);
  try {
    return recordSimpleAcceptanceWhileLocked(prepared, "acceptance_unknown", "Launch claim unknown-acceptance");
  } finally {
    releaseDirectoryLock(lock);
  }
}

/**
 * The exact, closed set of fields `recordLaunchAcceptanceProven()` accepts.
 * There is no bare `nativeTurnRef`/`nativeSessionRef` parameter at all: the
 * only accepted proof is `liveHarnessTurn`, the exact wrapper
 * `runtime/harness-contract.mjs`'s `validateLiveHarnessTurn()` produced. A
 * caller cannot even attempt to pass a fresh, raw, or otherwise unbranded
 * reference -- the same closed-field-set discipline
 * `runtime/turn-control.mjs`'s `ENQUEUE_INPUT_FIELDS` already established for
 * refusing an unwanted field outright rather than silently ignoring it.
 */
const PROVEN_INPUT_FIELDS = Object.freeze(["ownerRootId", "agentId", "jobId", "attemptId", "liveHarnessTurn"]);

function prepareProvenAcceptanceInput(input) {
  const snapshot = plainRecordSnapshot(input, "Launch claim proven-acceptance input");
  assertNoUnknownFields(snapshot, PROVEN_INPUT_FIELDS, "Launch claim proven-acceptance input");
  const { ownerRootId, agentId, jobId, attemptId, liveHarnessTurn } = snapshot;
  const identity = assertBindingIdentity({ ownerRootId, agentId, jobId });
  return { identity, attemptId, liveHarnessTurn, claimDir: resolveLaunchClaimDirectory(identity) };
}

function recordLaunchAcceptanceProvenWhileLocked({ identity, attemptId, liveHarnessTurn }) {
  const { filePath, record } = loadClaimForMutation(identity, attemptId, "Launch claim proven-acceptance");
  const evidence = durableTurnEvidence(liveHarnessTurn);
  bindLiveHarnessTurnToClaim(
    liveHarnessTurn,
    { ownerRootId: identity.ownerRootId, agentId: identity.agentId, jobId: identity.jobId, attemptId: record.attemptId },
    "Launch claim proven-acceptance"
  );
  const canonicalNativeTurnRef = canonicalizeNativeReference(
    evidence.nativeTurnRef, "Launch claim proven-acceptance native turn reference"
  );
  assertNativeReferenceMatchesRoute(canonicalNativeTurnRef, record.route, "Launch claim proven-acceptance");
  const canonicalNativeSessionRef = evidence.nativeSessionRef == null
    ? null
    : canonicalizeNativeReference(evidence.nativeSessionRef, "Launch claim proven-acceptance native session reference");
  if (canonicalNativeSessionRef != null) {
    assertNativeReferenceMatchesRoute(canonicalNativeSessionRef, record.route, "Launch claim proven-acceptance session");
  }
  if (record.acceptance === "acceptance_proven") {
    const sameTurn = JSON.stringify(record.nativeTurnRef) === JSON.stringify(canonicalNativeTurnRef);
    const sameSession = JSON.stringify(record.nativeSessionRef) === JSON.stringify(canonicalNativeSessionRef);
    if (sameTurn && sameSession) return record;
    throw new Error(
      `Launch claim conflicting acceptance transition: this claim is already acceptance_proven with a ` +
      `different native turn or session reference, and neither may be silently replaced.`
    );
  }
  assertAcceptanceTransitionAllowed(record.acceptance, "acceptance_proven");
  const updatedAt = nowIso();
  const updated = validateLaunchClaimRecord({
    ...record,
    acceptance: "acceptance_proven",
    nativeTurnRef: canonicalNativeTurnRef,
    nativeSessionRef: canonicalNativeSessionRef,
    acceptanceEvidenceAt: updatedAt,
    updatedAt,
  });
  writeAtomicClaimFile(filePath, updated);
  return updated;
}

/**
 * Record exact native acceptance. This is the only function that may set
 * `acceptance: "acceptance_proven"`, and the only proof it ever accepts is
 * `durableTurnEvidence(liveHarnessTurn)` -- `runtime/harness-contract.mjs`'s
 * brand-gated proof seam, which throws unless `liveHarnessTurn` is the exact
 * wrapper `validateLiveHarnessTurn()` produced. A structurally valid,
 * route-correct, but never-actually-validated reference can never satisfy
 * this: `durableTurnEvidence()` checks object identity against a `WeakSet`
 * `validateLiveHarnessTurn()` populated, not shape. This module never calls
 * a Driver itself and never re-derives that proof on its own -- the caller
 * must already have called `validateLiveHarnessTurn()` against its own real
 * live handle before calling this function.
 *
 * The exact `liveHarnessTurn` wrapper is additionally bound, in a
 * process-local `WeakMap`, to this exact claim identity
 * (`bindLiveHarnessTurnToClaim()`): a repeat call with the same wrapper for
 * the same claim is an idempotent replay, but the same wrapper presented for
 * a *different* claim identity is refused -- one validated native turn may
 * prove acceptance for exactly one claim in this process.
 *
 * Idempotent for a repeat with the exact same canonical `nativeTurnRef`
 * *and* `nativeSessionRef`; fails closed (never silently replaces either) for
 * a different one, and fails closed (never advances) once the claim already
 * recorded `acceptance_rejected`. `nativeSessionRef` is drawn from the same
 * branded evidence and persisted separately; it never substitutes for
 * `nativeTurnRef` in the transition gate above (an evidence object with a
 * session reference but no turn reference cannot reach `acceptance_proven`
 * at all -- `durableTurnEvidence()`/`validateLiveHarnessTurn()` already
 * require a turn reference unconditionally).
 */
export function recordLaunchAcceptanceProven(input) {
  const prepared = prepareProvenAcceptanceInput(input);
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    return recordLaunchAcceptanceProvenWhileLocked(prepared);
  } finally {
    releaseDirectoryLock(lock);
  }
}

/**
 * Async-contention counterpart. The live wrapper's WeakSet/WeakMap authority
 * stays in this process; only the lock wait yields, so no branded object is
 * serialized across a worker boundary or replaced by caller-supplied evidence.
 */
export async function recordLaunchAcceptanceProvenAsync(input) {
  const prepared = prepareProvenAcceptanceInput(input);
  const lock = await acquireDirectoryLockAsync(prepared.claimDir);
  try {
    return recordLaunchAcceptanceProvenWhileLocked(prepared);
  } finally {
    releaseDirectoryLock(lock);
  }
}

/** The closed reasons `launchClaimRollbackEligibility()` may report. */
export const LAUNCH_CLAIM_ROLLBACK_REASONS = Object.freeze([
  "not_submitted",
  "acceptance_rejected",
  "not_submitted_after_submission_started_never_rollback_safe",
  "acceptance_unknown_never_rollback_safe",
  "acceptance_proven_never_rollback_safe",
]);

/**
 * The one closed, separate pre-submission rollback-eligibility fact.
 * `not_submitted` is eligible only while `submissionState === "not_started"`
 * -- once `markNativeSubmissionStarted()` has run, even a claim that still
 * reads `acceptance: "not_submitted"` (for example after a crash or lock
 * failure between marking submission started and recording acceptance) is
 * never rollback-eligible; recovery must instead drive it to
 * `acceptance_unknown`. `acceptance_rejected` remains rollback-safe
 * regardless of `submissionState`, because it already semantically requires
 * Driver proof that no request ever crossed transport.
 * `acceptance_unknown`/`acceptance_proven` are never rollback-safe.
 *
 * This is a pure, read-only classification -- it never releases a lease,
 * never mutates the durable record, and never calls anything from
 * `runtime/instance-admission-lease.mjs` or `runtime/workspace-writer-lease.mjs`
 * beyond the read-only `acquiredLeaseEvidence()` this module already imports
 * for lease-binding proof. A future reconciler (Task 5B2) owns actually
 * acting on this fact through the existing settlement-gated release
 * predicate; this function only reports whether that action would even be
 * safe to attempt.
 *
 * `record` is never trusted at face value: it is run through the exact same
 * `validateLaunchClaimRecord()` this module uses for durable persistence
 * (refusing a Proxy, an accessor, a partial object, or any field this
 * schema does not admit), and the validated result is then required to be
 * byte-identical to what is *actually* currently durable for that record's
 * own identity (re-read via `readLaunchClaim()`'s own internals). A
 * caller-fabricated record, or a stale copy of a record whose real durable
 * state has since moved on, can never be blessed as rollback-eligible.
 *
 * The returned `token` (`attemptId`/`acceptance`/`submissionState`/
 * `updatedAt`) is a point-in-time CAS-style snapshot of the exact durable
 * state this eligibility decision was computed from -- it is NOT an atomic
 * lease reservation or release. Task 5B2 must re-call this function (and
 * therefore obtain a fresh token) immediately before it actually owns and
 * acts on the exact attempt; it must never act on a token read earlier in a
 * longer-lived call chain, since the durable record can advance between the
 * two calls.
 *
 * @param {*} record A launch claim record, typically from `readLaunchClaim()`.
 */
export function launchClaimRollbackEligibility(record) {
  const validated = validateLaunchClaimRecord(record);
  const stored = readLaunchClaim(validated);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(validated)) {
    throw new Error(
      "Launch claim rollback-eligibility requires the exact currently durable record for this job; a " +
      "caller-fabricated, partial, or stale record is never eligible."
    );
  }
  const token = Object.freeze({
    attemptId: stored.attemptId,
    acceptance: stored.acceptance,
    submissionState: stored.submissionState,
    updatedAt: stored.updatedAt,
  });
  if (stored.acceptance === "acceptance_rejected") {
    return Object.freeze({ eligible: true, reason: "acceptance_rejected", token });
  }
  if (stored.acceptance === "not_submitted") {
    if (stored.submissionState === "not_started") {
      return Object.freeze({ eligible: true, reason: "not_submitted", token });
    }
    return Object.freeze({ eligible: false, reason: "not_submitted_after_submission_started_never_rollback_safe", token });
  }
  if (stored.acceptance === "acceptance_unknown") {
    return Object.freeze({ eligible: false, reason: "acceptance_unknown_never_rollback_safe", token });
  }
  return Object.freeze({ eligible: false, reason: "acceptance_proven_never_rollback_safe", token });
}

const ROLLBACK_INPUT_FIELDS = Object.freeze(["ownerRootId", "agentId", "jobId", "token"]);

/**
 * Win the durable pre-submission rollback fence. The caller must present the
 * exact fresh eligibility token; once this write wins, no stale worker can
 * cross the native-submission fence for this attempt.
 */
export function beginPreSubmissionRollback(input) {
  const snapshot = plainRecordSnapshot(input, "Launch claim rollback input");
  assertNoUnknownFields(snapshot, ROLLBACK_INPUT_FIELDS, "Launch claim rollback input");
  const identity = assertBindingIdentity(snapshot);
  const token = plainRecordSnapshot(snapshot.token, "Launch claim rollback token");
  assertClosedFieldSet(token, ["attemptId", "acceptance", "submissionState", "updatedAt"], "Launch claim rollback token");
  const claimDir = resolveLaunchClaimDirectory(identity);
  const lock = acquireDirectoryLock(claimDir);
  try {
    const record = readCurrentOrMigrateWhileLocked(identity);
    if (!record || record.attemptId !== token.attemptId || record.acceptance !== token.acceptance ||
      record.submissionState !== token.submissionState || record.updatedAt !== token.updatedAt) {
      throw taggedError("stale_rollback_token", "Launch claim rollback token is stale or does not name the current attempt.");
    }
    const eligibility = record.acceptance === "acceptance_rejected" ||
      (record.acceptance === "not_submitted" && record.submissionState === "not_started");
    if (!eligibility) throw taggedError("rollback_not_eligible", "Launch claim is not safely rollback-eligible.");
    const updatedAt = nowIso();
    const updated = validateLaunchClaimRecord({
      ...record,
      submissionState: "rollback_in_progress",
      updatedAt,
    });
    writeAtomicClaimFile(path.join(claimDir, claimFileName(record.attemptId)), updated);
    return updated;
  } finally {
    releaseDirectoryLock(lock);
  }
}

const ROLLBACK_COMPLETE_INPUT_FIELDS = Object.freeze([
  "ownerRootId", "agentId", "jobId", "attemptId",
]);

/** Mark the durable tombstone complete only after callers finish cleanup. */
export function completePreSubmissionRollback(input) {
  const prepared = prepareClaimIdentityInput(
    input, ROLLBACK_COMPLETE_INPUT_FIELDS, "Launch claim rollback-complete input"
  );
  const lock = acquireDirectoryLock(prepared.claimDir);
  try {
    const { filePath, record } = loadClaimForMutation(
      prepared.identity, prepared.attemptId, "Launch claim rollback-complete"
    );
    if (record.submissionState === "rollback_complete") return record;
    if (record.submissionState !== "rollback_in_progress") {
      throw taggedError("rollback_not_owned", "Launch claim rollback is not in progress.");
    }
    const updatedAt = nowIso();
    const updated = validateLaunchClaimRecord({
      ...record,
      submissionState: "rollback_complete",
      updatedAt,
    });
    writeAtomicClaimFile(filePath, updated);
    return updated;
  } finally {
    releaseDirectoryLock(lock);
  }
}
