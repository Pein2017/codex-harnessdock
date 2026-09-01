/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Root-owned, durable completion delivery.  This deliberately has no
 * dependency on the public lifecycle API: supervisors may append/reconcile
 * terminal receipts, while a future host adapter may read and acknowledge
 * them without keeping a Claude process resident.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

import { assertAgentBlocking, deriveAgentBlocking } from "./agent-blocking.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { getProcessIdentity, validateProcessIdentity } from "./process-control.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { normalizeTerminalMetrics } from "./terminal-metrics.mjs";
import {
  UNREADABLE_TURN_EVIDENCE,
  assertPublishableTerminal,
  carriesTurnSettlementAxes,
  classifyTurnSettlement,
  isPublishableTerminal,
} from "./turn-settlement.mjs";

export const COMPLETION_INBOX_VERSION = 2;
export const LEGACY_COMPLETION_INBOX_VERSION = 1;
export const DEFAULT_ACKNOWLEDGED_TAIL = 100;
export const DEFAULT_UNREAD_BATCH_SIZE = 20;
export const DEFAULT_AGENT_SUMMARY_BATCH_SIZE = 1;

const INBOX_DIRECTORY_NAME = "completion-inboxes";
const INBOX_FILE_NAME = "inbox.json";
const LOCK_FILE_NAME = "inbox.lock";
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;
const ORDINARY_TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set([...ORDINARY_TERMINAL_STATUSES, "hard_reclaimed"]);
export const HARD_RECLAIM_LIFECYCLE_MESSAGE =
  "Agent worker resources were reclaimed while native settlement remains unknown.";
const HARD_RECLAIM_BLOCKING = Object.freeze({ reason: "worker_lost", scope: "agent", retry: "new_agent" });

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty text value.`);
  }
  return value.trim();
}

function assertPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function optionalAgentId(value) {
  if (value == null) return null;
  return assertText(value, "agent ID");
}

/**
 * Agent lifecycle is a projection of the terminal job receipt.  Keep this
 * mapping here with the completion fact so a registry can rebuild its state
 * without trusting a stale in-memory lifecycle value.
 */
export function agentStatusForTerminalJob(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  // Legacy cancelled receipts remain diagnosable, but an Agent never gets a
  // public cancelled lifecycle.  Failed/unknown terminal evidence is errored.
  return "errored";
}

function canonicalWorkspace(cwd) {
  const workspace = resolveWorkspaceRoot(cwd);
  try {
    return fs.realpathSync.native(workspace);
  } catch {
    return path.resolve(workspace);
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceHash(cwd) {
  return digest(canonicalWorkspace(cwd)).slice(0, 16);
}

export function resolveCompletionOwnerHash(ownerRootId) {
  return digest(assertText(ownerRootId, "owner root ID")).slice(0, 32);
}

export function deterministicCompletionEventId(ownerRootId, jobId) {
  const owner = assertText(ownerRootId, "owner root ID");
  const job = assertText(jobId, "job ID");
  return `completion-${digest(`${owner}\0${job}`)}`;
}

export function resolveCompletionInboxDir(cwd, ownerRootId) {
  assertText(ownerRootId, "owner root ID");
  return path.join(
    resolvePluginStateRoot(),
    workspaceHash(cwd),
    INBOX_DIRECTORY_NAME,
    resolveCompletionOwnerHash(ownerRootId)
  );
}

export function resolveCompletionInboxFile(cwd, ownerRootId) {
  return path.join(resolveCompletionInboxDir(cwd, ownerRootId), INBOX_FILE_NAME);
}

function platformProtectionReceipt(directory) {
  if (process.platform === "win32") {
    return {
      platform: "win32",
      protection: "not-verified",
      message:
        "Native Windows ACL verification is unavailable in this runtime; no user-scoped ACL guarantee is claimed.",
    };
  }

  let directoryMode = null;
  try {
    directoryMode = fs.statSync(directory).mode & 0o777;
  } catch {}
  return {
    platform: "posix",
    protection: directoryMode != null && (directoryMode & 0o077) === 0
      ? "owner-only"
      : "mode-not-verified",
    requestedDirectoryMode: "0700",
    requestedFileMode: "0600",
    effectiveDirectoryMode: directoryMode == null ? null : directoryMode.toString(8).padStart(4, "0"),
  };
}

function ensureInboxDirectory(cwd, ownerRootId) {
  const directory = resolveCompletionInboxDir(cwd, ownerRootId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
  return directory;
}

export function getCompletionInboxProtection(cwd, ownerRootId) {
  return platformProtectionReceipt(ensureInboxDirectory(cwd, ownerRootId));
}

function nowIso() {
  return new Date().toISOString();
}

function defaultInbox(ownerRootId, directory) {
  return {
    version: COMPLETION_INBOX_VERSION,
    ownerRootId: assertText(ownerRootId, "owner root ID"),
    ownerHash: resolveCompletionOwnerHash(ownerRootId),
    nextSequence: 1,
    acknowledgedThrough: 0,
    events: [],
    protection: platformProtectionReceipt(directory),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function eventAcknowledged(event, acknowledgedThrough = 0) {
  // Version-one records only have a contiguous cursor.  An unowned legacy
  // event is permanently quarantined so it cannot pin current Agent delivery.
  return event.acknowledgedAt != null ||
    event.sequence <= acknowledgedThrough ||
    !event.agentId;
}

function derivedAcknowledgedThrough(events, prior = 0) {
  let watermark = Math.max(0, Number(prior) || 0);
  for (const event of events) {
    if (event.sequence <= watermark) continue;
    if (!eventAcknowledged(event, watermark)) break;
    watermark = event.sequence;
  }
  return watermark;
}

function validateResumability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Completion resumability must be an explicit object.");
  }
  const classification = assertText(value.classification, "resumability classification");
  const claudeSessionId = value.claudeSessionId == null
    ? null
    : assertText(value.claudeSessionId, "Claude session ID");
  const blockingReason = value.blockingReason == null
    ? null
    : assertText(value.blockingReason, "resumability blocking reason");
  if (classification === "resumable" && !claudeSessionId) {
    throw new Error("Resumable completion requires an exact Claude session ID.");
  }
  if (classification !== "resumable" && !blockingReason) {
    throw new Error("Non-resumable completion requires a blocking reason.");
  }
  return { classification, claudeSessionId, blockingReason };
}

function assertHardReclaimLifecycle(value, label) {
  if (value.terminalStatus !== "hard_reclaimed") {
    if (value.settlement != null) throw new Error(`${label} ordinary terminal state cannot declare settlement uncertainty.`);
    return;
  }
  if (value.settlement !== "unknown" || value.summary !== HARD_RECLAIM_LIFECYCLE_MESSAGE ||
      value.finalMessage !== HARD_RECLAIM_LIFECYCLE_MESSAGE || value.detailedResultAvailable !== false ||
      value.resultPointer != null || value.claudeSessionIdAvailable !== false || value.metrics != null ||
      value.resumability?.classification !== "not_resumable" ||
      value.resumability?.blockingReason !== "worker_lost" || value.resumability?.claudeSessionId != null ||
      JSON.stringify(value.blocking) !== JSON.stringify(HARD_RECLAIM_BLOCKING)) {
    throw new Error(`${label} hard reclaim must remain one closed nonsemantic worker-loss lifecycle fact.`);
  }
}

function validateStoredEvent(event, ownerRootId, previousSequence) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Completion inbox contains an invalid event.");
  }
  if (event.version !== COMPLETION_INBOX_VERSION && event.version !== LEGACY_COMPLETION_INBOX_VERSION) {
    throw new Error(`Unsupported completion event version: ${event.version}.`);
  }
  const sequence = assertPositiveInteger(event.sequence, "completion sequence");
  if (sequence !== previousSequence + 1) {
    throw new Error("Completion inbox event sequences must be contiguous.");
  }
  if (event.ownerRootId !== ownerRootId) {
    throw new Error("Completion inbox owner does not match the requested root.");
  }
  const jobId = assertText(event.jobId, "job ID");
  const expectedId = deterministicCompletionEventId(ownerRootId, jobId);
  if (event.eventId !== expectedId) {
    throw new Error("Completion event identity does not match its owner and job.");
  }
  const agentId = optionalAgentId(event.agentId);
  if (agentId) {
    if (event.agentStatus !== agentStatusForTerminalJob(event.terminalStatus)) {
      throw new Error("Agent completion status does not match its terminal job receipt.");
    }
  } else if (event.agentStatus != null) {
    throw new Error("Unlinked completion event must not claim an Agent status.");
  }
  if (!TERMINAL_STATUSES.has(event.terminalStatus)) {
    throw new Error(`Invalid terminal completion status: ${event.terminalStatus}.`);
  }
  assertText(event.completedAt, "completion timestamp");
  assertText(event.summary, "completion summary");
  assertText(event.deliveryToken, "delivery token");
  validateResumability(event.resumability);
  // A pre-change stored event has no `blocking` key at all; that absence is
  // read as `null`, exactly like an explicitly stored `null`, so an older
  // record on disk is not rejected by a newer runtime.
  assertAgentBlocking(event.blocking ?? null, "stored completion blocking evidence");
  if (event.metrics != null && normalizeTerminalMetrics(event.metrics) == null) {
    throw new Error("Completion metrics are invalid.");
  }
  if (typeof event.detailedResultAvailable !== "boolean") {
    throw new Error("Completion detailed-result availability must be boolean.");
  }
  if (typeof event.finalMessage !== "string" || typeof event.truncated !== "boolean") {
    throw new Error("Completion final-message receipt is invalid.");
  }
  if (typeof event.claudeSessionIdAvailable !== "boolean") {
    throw new Error("Completion Claude-session availability receipt is invalid.");
  }
  assertHardReclaimLifecycle(event, "Stored completion event");
  if (event.firstDeliveredAt != null) {
    assertText(event.firstDeliveredAt, "completion first-delivery timestamp");
  }
  if (event.acknowledgedAt != null) {
    assertText(event.acknowledgedAt, "completion acknowledgement timestamp");
  }
  if (event.version === COMPLETION_INBOX_VERSION && !Object.hasOwn(event, "acknowledgedAt")) {
    throw new Error("Completion event acknowledgement state is invalid.");
  }
  return sequence;
}

function validateInbox(inbox, ownerRootId, directory) {
  if (!inbox || typeof inbox !== "object" || Array.isArray(inbox)) {
    throw new Error("Completion inbox must be an object.");
  }
  if (inbox.version !== COMPLETION_INBOX_VERSION && inbox.version !== LEGACY_COMPLETION_INBOX_VERSION) {
    throw new Error(`Unsupported completion inbox version: ${inbox.version}.`);
  }
  const owner = assertText(ownerRootId, "owner root ID");
  if (inbox.ownerRootId !== owner || inbox.ownerHash !== resolveCompletionOwnerHash(owner)) {
    throw new Error("Completion inbox owner identity is invalid.");
  }
  const acknowledgedThrough = Number(inbox.acknowledgedThrough);
  const nextSequence = Number(inbox.nextSequence);
  if (!Number.isSafeInteger(acknowledgedThrough) || acknowledgedThrough < 0) {
    throw new Error("Completion acknowledgement cursor is invalid.");
  }
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    throw new Error("Completion next sequence is invalid.");
  }
  if (!Array.isArray(inbox.events)) {
    throw new Error("Completion inbox events must be an array.");
  }
  // Compaction is allowed to remove an acknowledged prefix, so the first
  // retained event need not be sequence one.  The retained segment itself
  // remains contiguous, and any retained unread event must begin exactly at
  // the acknowledgement cursor plus one.
  let previousSequence = inbox.events.length > 0 ? inbox.events[0].sequence - 1 : 0;
  for (const event of inbox.events) {
    previousSequence = validateStoredEvent(event, owner, previousSequence);
  }
  if (inbox.version === LEGACY_COMPLETION_INBOX_VERSION) {
    const firstUnread = inbox.events.find((event) => event.sequence > acknowledgedThrough);
    if (firstUnread && firstUnread.sequence !== acknowledgedThrough + 1) {
      throw new Error("Completion inbox unread events must begin after the acknowledgement cursor.");
    }
  }
  if (nextSequence <= previousSequence || acknowledgedThrough >= nextSequence) {
    throw new Error("Completion inbox cursor state is inconsistent.");
  }
  const expectedProtection = platformProtectionReceipt(directory);
  const migrationTimestamp = inbox.updatedAt ?? nowIso();
  const migratedEvents = inbox.events.map((event) => inbox.version === LEGACY_COMPLETION_INBOX_VERSION
    ? {
        ...event,
        // Keep the legacy event version and all frozen payload/token fields;
        // only the acknowledgement fact is added for v2 selection.
        ...(eventAcknowledged(event, acknowledgedThrough) && !event.acknowledgedAt
          ? { acknowledgedAt: migrationTimestamp }
          : {}),
      }
    : event);
  const baseWatermark = migratedEvents.length > 0
    ? migratedEvents[0].sequence - 1
    : nextSequence - 1;
  const watermark = derivedAcknowledgedThrough(migratedEvents, baseWatermark);
  if (inbox.version === COMPLETION_INBOX_VERSION && acknowledgedThrough > watermark) {
    throw new Error("Completion inbox acknowledgement cursor skips an unread event.");
  }
  return {
    ...inbox,
    version: COMPLETION_INBOX_VERSION,
    acknowledgedThrough: watermark,
    nextSequence,
    events: migratedEvents,
    protection: inbox.protection ?? expectedProtection,
  };
}

function readInbox(cwd, ownerRootId, create = false) {
  const directory = create
    ? ensureInboxDirectory(cwd, ownerRootId)
    : resolveCompletionInboxDir(cwd, ownerRootId);
  const filePath = path.join(directory, INBOX_FILE_NAME);
  try {
    return validateInbox(JSON.parse(fs.readFileSync(filePath, "utf8")), ownerRootId, directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is a best-effort durability improvement on filesystems
    // that do not support opening a directory as a regular descriptor.
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeInboxAtomic(filePath, inbox) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `${INBOX_FILE_NAME}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sleepSync(milliseconds) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

/** @param {unknown} error */
function errorCode(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return String(/** @type {{ code?: unknown }} */ (error).code ?? "");
}

function clearStaleLock(lockPath) {
  let lock = null;
  let observed = null;
  try {
    observed = fs.statSync(lockPath);
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.identity && validateProcessIdentity(lock.pid, lock.identity)) return false;
    if (!lock.identity && Date.now() - observed.mtimeMs < LOCK_STALE_MS) return false;
  } catch {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
    } catch {
      return false;
    }
  }
  try {
    const current = fs.statSync(lockPath);
    if (observed && (current.dev !== observed.dev || current.ino !== observed.ino)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireInboxLock(directory) {
  const lockPath = path.join(directory, LOCK_FILE_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    clearStaleLock(lockPath);
    const token = randomBytes(16).toString("hex");
    const candidate = `${lockPath}.${process.pid}.${token}.candidate`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(candidate, "wx", 0o600);
      const identity = getProcessIdentity(process.pid);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity, token, createdAt: nowIso() }), "utf8");
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      fs.linkSync(candidate, lockPath);
      fs.unlinkSync(candidate);
      fs.closeSync(descriptor);
      return { lockPath, token, stat };
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(candidate); } catch {}
      if (errorCode(error) !== "EEXIST" || Date.now() >= deadline) {
        if (errorCode(error) === "EEXIST") {
          throw Object.assign(
            new Error("Timed out acquiring completion inbox lock."),
            { code: "ETIMEDOUT" }
          );
        }
        throw error;
      }
      sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }
}

function releaseInboxLock(lock) {
  if (!lock) return;
  try {
    const stat = fs.statSync(lock.lockPath);
    const current = JSON.parse(fs.readFileSync(lock.lockPath, "utf8"));
    if (stat.dev === lock.stat.dev && stat.ino === lock.stat.ino && current.token === lock.token) {
      fs.unlinkSync(lock.lockPath);
    }
  } catch {}
}

function withInboxLock(cwd, ownerRootId, operation) {
  const directory = ensureInboxDirectory(cwd, ownerRootId);
  const lock = acquireInboxLock(directory);
  try {
    const inbox = readInbox(cwd, ownerRootId, true) ?? defaultInbox(ownerRootId, directory);
    return operation(inbox, path.join(directory, INBOX_FILE_NAME), directory);
  } finally {
    releaseInboxLock(lock);
  }
}

/**
 * Where a caller may attach normalized turn evidence to a completion input or
 * a terminal job. This is a closed internal path, not a public field: the
 * seven public operations and their schemas are unchanged, and the evidence
 * itself is never stored in or projected from an event.
 */
const TURN_EVIDENCE_FIELDS = Object.freeze(["normalizedTerminalResult", "result"]);

/**
 * True when `field` sits anywhere above `owner` in the prototype chain --
 * present but not readable as `owner`'s own data property. Never uses `in`:
 * a Proxy anywhere above `owner`, not just directly above it, can lie to
 * `in`'s `[[HasProperty]]` walk through its `has` trap. Each link's
 * Proxy-ness is decided before it is queried in any way, so a Proxy anywhere
 * in the chain is treated as presence rather than asked whether it has the
 * field, and `Object.getPrototypeOf` is only called on a link already proven
 * not to be a Proxy.
 */
function fieldInheritedUnreadably(owner, field) {
  let link = Object.getPrototypeOf(owner);
  while (link != null) {
    if (types.isProxy(link)) return true;
    if (Object.hasOwn(link, field)) return true;
    link = Object.getPrototypeOf(link);
  }
  return false;
}

/**
 * Terminal evidence that declares the turn axes may publish a completion only
 * when `runtime/turn-settlement.mjs` proves the native turn terminal and its
 * turn-owned execution settlement is `settled`. A turn that owns no execution
 * world states that as `continuity=not_applicable` with `settlement=settled`,
 * not a fourth settlement value -- `not_applicable` lives only on continuity.
 * Version-one results declare no axis, so this gate never sees them and their
 * behavior is unchanged.
 *
 * Returns the offending evidence so exactly one owner -- the settlement
 * module -- states the reason and the failure message.
 */
function unsettledTurnEvidence(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  // A container that can answer differently on each read cannot be gated at
  // all: refuse it before a single trap runs, rather than checking one value
  // and projecting another.
  if (types.isProxy(source)) return UNREADABLE_TURN_EVIDENCE;
  for (const field of TURN_EVIDENCE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor == null) {
      // An inherited evidence field is present but unreadable, not absent --
      // including one hidden behind a Proxy link further up the chain.
      if (fieldInheritedUnreadably(source, field)) return UNREADABLE_TURN_EVIDENCE;
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) return UNREADABLE_TURN_EVIDENCE;
    const candidate = descriptor.value;
    if (!carriesTurnSettlementAxes(candidate)) continue;
    if (!isPublishableTerminal(candidate)) return candidate;
  }
  return null;
}

function normalizeCompletionInput(ownerRootId, completion) {
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
    throw new Error("Completion event input must be an object.");
  }
  // Fail closed before the first property read: an unreadable container must
  // not be inspected at all, and no inbox read, lock, or event identity exists
  // yet either.
  const unsettled = unsettledTurnEvidence(completion);
  if (unsettled) assertPublishableTerminal(unsettled, "Completion event");
  const jobId = assertText(completion.jobId, "job ID");
  const terminalStatus = assertText(completion.terminalStatus, "terminal completion status");
  if (!TERMINAL_STATUSES.has(terminalStatus)) {
    throw new Error(`Invalid terminal completion status: ${terminalStatus}.`);
  }
  const resultPointer = completion.resultPointer == null ? null : String(completion.resultPointer);
  const finalMessage = String(completion.finalMessage ?? completion.summary ?? "");
  const agentId = optionalAgentId(completion.agentId);
  const normalized = {
    version: COMPLETION_INBOX_VERSION,
    eventId: deterministicCompletionEventId(ownerRootId, jobId),
    ownerRootId: assertText(ownerRootId, "owner root ID"),
    jobId,
    agentId,
    agentStatus: agentId ? agentStatusForTerminalJob(terminalStatus) : null,
    terminalStatus,
    ...(completion.settlement == null ? {} : { settlement: assertText(completion.settlement, "completion settlement") }),
    completedAt: completion.completedAt == null ? nowIso() : assertText(completion.completedAt, "completion timestamp"),
    summary: assertText(completion.summary, "completion summary"),
    resumability: validateResumability(completion.resumability),
    blocking: assertAgentBlocking(completion.blocking ?? null, "completion blocking evidence"),
    detailedResultAvailable: Boolean(completion.detailedResultAvailable),
    resultPointer,
    finalMessage,
    // Version-one events retain this field so an older event that already
    // lost bytes remains honest. New normalization never discards content.
    truncated: false,
    claudeSessionIdAvailable: Boolean(
      completion.claudeSessionIdAvailable ?? completion.resumability?.claudeSessionId
    ),
    metrics: normalizeTerminalMetrics(completion.metrics) ?? null,
  };
  assertHardReclaimLifecycle(normalized, "Completion event");
  return normalized;
}

function publicEvent(event) {
  return {
    version: event.version,
    sequence: event.sequence,
    eventId: event.eventId,
    jobId: event.jobId,
    agentId: event.agentId ?? null,
    agentStatus: event.agentStatus ?? null,
    terminalStatus: event.terminalStatus,
    ...(event.settlement == null ? {} : { settlement: event.settlement }),
    completedAt: event.completedAt,
    summary: event.summary,
    resumability: { ...event.resumability },
    // Absence (a pre-change frozen event) reads as `null`, identical to an
    // explicitly stored `null`; this projection never recomputes it.
    blocking: event.blocking ?? null,
    detailedResultAvailable: event.detailedResultAvailable,
    resultPointer: event.resultPointer,
    finalMessage: event.finalMessage,
    truncated: event.truncated,
    claudeSessionIdAvailable: event.claudeSessionIdAvailable,
    metrics: event.metrics ?? null,
    deliveryToken: event.deliveryToken,
  };
}

/**
 * The completion inbox stores the complete terminal final message for durable
 * parent delivery. Private result/session evidence stays out of this public
 * projection, but the Agent's own final synthesis is never truncated here.
 */
function publicAgentCompletionSummary(event) {
  if (!event.agentId) return null;
  const terminal = String(event.terminalStatus ?? "completed");
  return {
    kind: "completion",
    agentId: event.agentId,
    agentStatus: event.agentStatus,
    terminalStatus: terminal,
    ...(event.settlement == null ? {} : { settlement: event.settlement }),
    summary: `Agent turn ${terminal}.`,
    completionMessage: event.finalMessage,
    completionMessageTruncated: Boolean(event.truncated),
    deliveryToken: event.deliveryToken,
    // Absence (a pre-change frozen event) reads as `null`; this frozen
    // projection is never recomputed from the current Agent or job state.
    blocking: event.blocking ?? null,
    metrics: event.metrics ?? null,
  };
}

function sameCompletionFact(existing, normalized) {
  return [
    "eventId",
    "ownerRootId",
    "jobId",
    "agentId",
    "agentStatus",
    "terminalStatus",
    "completedAt",
    "summary",
    "detailedResultAvailable",
    "resultPointer",
    "finalMessage",
    "truncated",
    "claudeSessionIdAvailable",
  ].every((field) => existing[field] === normalized[field]) &&
    (existing.settlement ?? null) === (normalized.settlement ?? null) &&
    JSON.stringify(existing.resumability) === JSON.stringify(normalized.resumability) &&
    // `blocking` is compared structurally, exactly like `resumability`, rather
    // than by the `===` scan used for scalars: a pre-change stored event has
    // no key at all (reads as `null`), so that absence must compare equal to
    // an explicitly stored `null` rather than always registering as changed.
    JSON.stringify(existing.blocking ?? null) === JSON.stringify(normalized.blocking ?? null) &&
    JSON.stringify(existing.metrics ?? null) === JSON.stringify(normalized.metrics ?? null);
}

function assertSameCompletionIdentity(existing, normalized, ownerRootId) {
  if (
    existing.jobId !== normalized.jobId ||
    existing.ownerRootId !== ownerRootId ||
    (existing.agentId ?? null) !== normalized.agentId
  ) {
    throw new Error("Completion event identity collision.");
  }
}

function snapshotExistingCompletionResult(inbox, existing, normalized, ownerRootId, options) {
  assertSameCompletionIdentity(existing, normalized, ownerRootId);
  if (sameCompletionFact(existing, normalized)) {
    return {
      appended: false,
      corrected: false,
      event: publicEvent(existing),
      sequence: existing.sequence,
    };
  }
  const immutable = Boolean(existing.firstDeliveredAt) ||
    existing.sequence <= inbox.acknowledgedThrough;
  if (!immutable) return null;
  const factDiffers = options.reconcileExisting === true;
  return {
    appended: false,
    corrected: false,
    ...(factDiffers
      ? {
          reason: existing.firstDeliveredAt
            ? "delivered_event_immutable"
            : "acknowledged_event_immutable",
        }
      : {}),
    event: publicEvent(existing),
    sequence: existing.sequence,
  };
}

export function appendCompletionEvent(cwd, ownerRootId, completion, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  const normalized = normalizeCompletionInput(owner, completion);
  const snapshot = readInbox(cwd, owner, false);
  const snapshotExisting = snapshot?.events.find(
    (event) => event.eventId === normalized.eventId
  );
  if (snapshotExisting) {
    const settled = snapshotExistingCompletionResult(
      snapshot,
      snapshotExisting,
      normalized,
      owner,
      options
    );
    if (settled) return settled;
  }
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const existing = inbox.events.find((event) => event.eventId === normalized.eventId);
    if (existing) {
      assertSameCompletionIdentity(existing, normalized, owner);
      if (options.reconcileExisting === true && !sameCompletionFact(existing, normalized)) {
        // Completion facts already acknowledged by Codex are immutable. A
        // durable job correction remains diagnosable, but must not rewrite a
        // receipt the caller may already have acted upon.
        if (existing.sequence <= inbox.acknowledgedThrough || existing.firstDeliveredAt) {
          return {
            appended: false,
            corrected: false,
            reason: existing.firstDeliveredAt
              ? "delivered_event_immutable"
              : "acknowledged_event_immutable",
            event: publicEvent(existing),
            sequence: existing.sequence,
          };
        }
      const corrected = {
          ...normalized,
          version: existing.version,
          sequence: existing.sequence,
          deliveryToken: existing.deliveryToken,
          acknowledgedAt: existing.acknowledgedAt ?? null,
        };
        const events = [...inbox.events];
        events[inbox.events.indexOf(existing)] = corrected;
        writeInboxAtomic(filePath, { ...inbox, events, updatedAt: nowIso() });
        return {
          appended: false,
          corrected: true,
          reason: "corrected_unacknowledged_event",
          event: publicEvent(corrected),
          sequence: corrected.sequence,
        };
      }
      return { appended: false, corrected: false, event: publicEvent(existing), sequence: existing.sequence };
    }
  const event = {
    ...normalized,
    sequence: inbox.nextSequence,
    acknowledgedAt: null,
    deliveryToken: `delivery-${randomBytes(32).toString("base64url")}`,
  };
    const updated = {
      ...inbox,
      nextSequence: inbox.nextSequence + 1,
      events: [...inbox.events, event],
      updatedAt: nowIso(),
    };
    writeInboxAtomic(filePath, updated);
    return { appended: true, event: publicEvent(event), sequence: event.sequence };
  });
}

function unreadContiguousEvents(inbox, limit) {
  const result = [];
  for (const event of inbox.events) {
    if (event.acknowledgedAt != null) continue;
    result.push(event);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Legacy one-shot jobs did not have a durable Agent identity. They remain in
 * the immutable inbox for forensic compatibility, but they are not events the
 * Agent lifecycle can deliver. Advance the scan over those records so an old
 * legacy prefix cannot starve a current Agent completion.
 */
function unreadAgentLinkedEvents(inbox, limit) {
  const result = [];
  for (const event of inbox.events) {
    if (event.sequence <= inbox.acknowledgedThrough || eventAcknowledged(event, inbox.acknowledgedThrough)) continue;
    if (!event.agentId) continue;
    result.push(event);
    if (result.length >= limit) break;
  }
  return result;
}

function targetedAgentEvents(inbox, jobIds) {
  const wanted = new Set(jobIds);
  return inbox.events.filter((event) =>
    wanted.has(event.jobId) && event.agentId &&
    event.sequence > inbox.acknowledgedThrough && !eventAcknowledged(event, inbox.acknowledgedThrough)
  );
}

export function readUnreadCompletionEvents(cwd, ownerRootId, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  const requestedLimit = options.limit == null ? DEFAULT_UNREAD_BATCH_SIZE : options.limit;
  const limit = Math.min(assertPositiveInteger(requestedLimit, "unread completion limit"), 100);
  const inbox = readInbox(cwd, owner, false);
  if (!inbox) {
    return {
      version: COMPLETION_INBOX_VERSION,
      ownerRootId: owner,
      acknowledgedThrough: 0,
      events: [],
      protection: getCompletionInboxProtection(cwd, owner),
    };
  }
  return {
    version: inbox.version,
    ownerRootId: owner,
    acknowledgedThrough: inbox.acknowledgedThrough,
    events: unreadContiguousEvents(inbox, limit).map(publicEvent),
    protection: inbox.protection,
  };
}

/**
 * Read the narrow, Agent-only projection used by the public wait lifecycle.
 * Full completion records remain available only through durable runtime state.
 */
export function readUnreadAgentCompletionSummaries(cwd, ownerRootId, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  const requestedLimit = options.limit == null ? DEFAULT_AGENT_SUMMARY_BATCH_SIZE : options.limit;
  const limit = Math.min(assertPositiveInteger(requestedLimit, "Agent completion summary limit"), 100);
  const snapshot = readInbox(cwd, owner, false);
  if (!snapshot) return { events: [] };
  const snapshotSelection = unreadAgentLinkedEvents(snapshot, limit);
  if (snapshotSelection.length === 0) return { events: [] };
  // Once first delivery freezes every selected payload, reconciliation cannot
  // rewrite it. Snapshot redelivery is therefore observation-only. A racing
  // acknowledgement may make this the final at-least-once duplicate, but it
  // cannot change the token, payload, or monotonic durable cursor.
  if (snapshotSelection.every((event) => event.firstDeliveredAt)) {
    return {
      events: snapshotSelection
        .map(publicAgentCompletionSummary)
        .filter(Boolean),
    };
  }
  // An unfrozen selection still needs the original lock-and-reread path so
  // exactly one durable public payload is established before first exposure.
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const selected = unreadAgentLinkedEvents(inbox, limit);
    const selectedIds = new Set(selected.map((event) => event.eventId));
    let changed = false;
    const deliveredAt = nowIso();
    const events = inbox.events.map((event) => {
      if (!selectedIds.has(event.eventId) || event.firstDeliveredAt) return event;
      changed = true;
      return { ...event, firstDeliveredAt: deliveredAt };
    });
    const updated = changed ? { ...inbox, events, updatedAt: deliveredAt } : inbox;
    if (changed) writeInboxAtomic(filePath, updated);
    return {
      events: unreadAgentLinkedEvents(updated, limit)
        .map(publicAgentCompletionSummary)
        .filter(Boolean),
    };
  });
}

/**
 * Select a fixed set of terminal Agent jobs without allowing an older
 * unrelated inbox event to participate.  The `jobId` field is intentionally
 * an internal identity used by AgentRuntime; it must never be copied into a
 * model-facing receipt.
 */
export function readTargetedAgentCompletionSummaries(cwd, ownerRootId, jobIds, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    throw new Error("Targeted completion selection requires at least one job ID.");
  }
  const ids = jobIds.map((jobId) => assertText(jobId, "job ID"));
  if (new Set(ids).size !== ids.length) throw new Error("Targeted completion job IDs must be unique.");
  const snapshot = readInbox(cwd, owner, false);
  if (!snapshot) return { events: [], consumed: [] };
  const selected = targetedAgentEvents(snapshot, ids);
  const consumed = snapshot.events
    .filter((event) => ids.includes(event.jobId) && event.agentId && eventAcknowledged(event, snapshot.acknowledgedThrough))
    .map((event) => ({
      jobId: event.jobId,
      agentId: event.agentId,
      agentStatus: event.agentStatus,
      terminalStatus: event.terminalStatus,
      ...(event.settlement == null ? {} : { settlement: event.settlement }),
      blocking: event.blocking ?? null,
    }));
  const project = (events) => events.map((event) => ({
    ...publicAgentCompletionSummary(event),
    jobId: event.jobId,
  })).filter(Boolean);
  if (options.freeze === false || selected.length === 0 || selected.every((event) => event.firstDeliveredAt)) {
    return { events: project(selected), consumed };
  }
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const reread = targetedAgentEvents(inbox, ids);
    const selectedIds = new Set(reread.map((event) => event.eventId));
    let changed = false;
    const deliveredAt = nowIso();
    const events = inbox.events.map((event) => {
      if (!selectedIds.has(event.eventId) || event.firstDeliveredAt) return event;
      changed = true;
      return { ...event, firstDeliveredAt: deliveredAt };
    });
    const updated = changed ? { ...inbox, events, updatedAt: deliveredAt } : inbox;
    if (changed) writeInboxAtomic(filePath, updated);
    const consumedAfter = updated.events
      .filter((event) => ids.includes(event.jobId) && event.agentId && eventAcknowledged(event, updated.acknowledgedThrough))
      .map((event) => ({
        jobId: event.jobId,
        agentId: event.agentId,
        agentStatus: event.agentStatus,
        terminalStatus: event.terminalStatus,
        ...(event.settlement == null ? {} : { settlement: event.settlement }),
        blocking: event.blocking ?? null,
      }));
    return { events: project(targetedAgentEvents(updated, ids)), consumed: consumedAfter };
  });
}

function compactInbox(inbox, acknowledgedTail) {
  const tail = Math.max(0, Number(acknowledgedTail));
  if (!Number.isSafeInteger(tail)) {
    throw new Error("Acknowledged completion tail must be a non-negative integer.");
  }
  const retainAfter = Math.max(0, inbox.acknowledgedThrough - tail);
  const events = inbox.events.filter((event) => event.sequence > retainAfter);
  return { ...inbox, events, compactedCount: inbox.events.length - events.length };
}

export function compactAcknowledgedCompletionEvents(cwd, ownerRootId, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  const acknowledgedTail = options.acknowledgedTail ?? DEFAULT_ACKNOWLEDGED_TAIL;
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const compacted = compactInbox(inbox, acknowledgedTail);
    if (compacted.compactedCount > 0) {
      const updated = { ...compacted, updatedAt: nowIso() };
      delete updated.compactedCount;
      writeInboxAtomic(filePath, updated);
    }
    return {
      acknowledgedThrough: inbox.acknowledgedThrough,
      compactedCount: compacted.compactedCount,
      retainedEventCount: compacted.events.length,
    };
  });
}

export function acknowledgeCompletionEvents(cwd, ownerRootId, deliveryTokens, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  if (!Array.isArray(deliveryTokens)) {
    throw new Error("Completion acknowledgement tokens must be an array.");
  }
  if (deliveryTokens.length === 0) {
    const inbox = readInbox(cwd, owner, false);
    return { acknowledgedThrough: inbox?.acknowledgedThrough ?? 0, acknowledgedCount: 0, compactedCount: 0 };
  }
  const tokens = deliveryTokens.map((token) => assertText(token, "delivery token"));
  if (new Set(tokens).size !== tokens.length) {
    throw new Error("Completion acknowledgement tokens must not repeat.");
  }
  const acknowledgedTail = options.acknowledgedTail ?? DEFAULT_ACKNOWLEDGED_TAIL;
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const alreadyAcknowledged = inbox.events.filter((event) => event.acknowledgedAt != null);
    if (tokens.every((token) => alreadyAcknowledged.some((event) => event.deliveryToken === token))) {
      return {
        acknowledgedThrough: inbox.acknowledgedThrough,
        acknowledgedCount: 0,
        compactedCount: 0,
      };
    }
    const expected = unreadContiguousEvents(inbox, tokens.length);
    if (expected.length !== tokens.length || expected.some((event, index) => event.deliveryToken !== tokens[index])) {
      throw new Error("Completion acknowledgement must cover the oldest unread contiguous token prefix.");
    }
    const acknowledgedAt = nowIso();
    const selectedIds = new Set(expected.map((event) => event.eventId));
    const events = inbox.events.map((event) => selectedIds.has(event.eventId)
      ? { ...event, acknowledgedAt }
      : event);
    const advanced = {
      ...inbox,
      events,
      acknowledgedThrough: derivedAcknowledgedThrough(events, inbox.acknowledgedThrough),
    };
    const compacted = compactInbox(advanced, acknowledgedTail);
    const updated = { ...compacted, updatedAt: nowIso() };
    delete updated.compactedCount;
    writeInboxAtomic(filePath, updated);
    return {
      acknowledgedThrough: advanced.acknowledgedThrough,
      acknowledgedCount: tokens.length,
      compactedCount: compacted.compactedCount,
    };
  });
}

/**
 * Acknowledge the oldest unread Agent-linked prefix. The cursor may move over
 * quarantined legacy events that precede that prefix, but never rewrites or
 * otherwise mutates those stored facts.
 */
export function acknowledgeAgentCompletionEvents(cwd, ownerRootId, deliveryTokens, options = {}) {
  const owner = assertText(ownerRootId, "owner root ID");
  if (!Array.isArray(deliveryTokens)) {
    throw new Error("Completion acknowledgement tokens must be an array.");
  }
  if (deliveryTokens.length === 0) {
    const inbox = readInbox(cwd, owner, false);
    return { acknowledgedThrough: inbox?.acknowledgedThrough ?? 0, acknowledgedCount: 0, compactedCount: 0 };
  }
  const tokens = deliveryTokens.map((token) => assertText(token, "delivery token"));
  if (new Set(tokens).size !== tokens.length) {
    throw new Error("Completion acknowledgement tokens must not repeat.");
  }
  const acknowledgedTail = options.acknowledgedTail ?? DEFAULT_ACKNOWLEDGED_TAIL;
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const byToken = new Map(inbox.events.map((event) => [event.deliveryToken, event]));
    const selected = [];
    for (const token of tokens) {
      const event = byToken.get(token);
      if (!event?.agentId || !event.firstDeliveredAt) {
        throw new Error("Completion acknowledgement contains an unknown, non-Agent, or never-delivered token.");
      }
      if (!eventAcknowledged(event, inbox.acknowledgedThrough)) selected.push(event);
    }
    if (selected.length === 0) {
      return {
        acknowledgedThrough: derivedAcknowledgedThrough(inbox.events, inbox.acknowledgedThrough),
        acknowledgedCount: 0,
        compactedCount: 0,
      };
    }
    const acknowledgedAt = nowIso();
    const selectedTokens = new Set(selected.map((event) => event.deliveryToken));
    const events = inbox.events.map((event) => selectedTokens.has(event.deliveryToken)
      ? { ...event, acknowledgedAt }
      : event);
    const advanced = {
      ...inbox,
      events,
      acknowledgedThrough: derivedAcknowledgedThrough(events, inbox.acknowledgedThrough),
    };
    const compacted = compactInbox(advanced, acknowledgedTail);
    const updated = { ...compacted, updatedAt: nowIso() };
    delete updated.compactedCount;
    writeInboxAtomic(filePath, updated);
    return {
      acknowledgedThrough: advanced.acknowledgedThrough,
      acknowledgedCount: selected.length,
      compactedCount: compacted.compactedCount,
    };
  });
}

function completionFromTerminalJob(job, options) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("Terminal job must be an object.");
  }
  if (!ORDINARY_TERMINAL_STATUSES.has(job.status)) {
    return null;
  }
  // `job.errorMessage` is deliberately excluded from this chain: it is
  // operator-only free text (a PID, a manual resume command, or other raw
  // diagnostic prose) and must never reach a model-facing summary or final
  // message, even for a malformed or legacy job lacking a prompt-derived
  // summary. Operator diagnostics still read `job.errorMessage` directly from
  // the durable job record, unaffected by this projection.
  const summary =
    options.summary ??
    job.completionSummary ??
    job.summary ??
    job.finalMessage ??
    `${job.status} job ${job.id}`;
  const recoverability = job.recoverability ?? null;
  const blocking = deriveAgentBlocking({
    terminalStatus: job.status,
    turnFailureClass: job.result?.failureClass ?? null,
    supervisorFailureClass: job.failureClass ?? null,
    continuationMode: recoverability?.mode ?? "blocked",
  });
  const resumability = options.resumability ?? job.resumability ?? (
    recoverability?.resumable
      ? {
          classification: "resumable",
          claudeSessionId: recoverability.exactSessionId,
        }
      : {
          classification: "not_resumable",
          blockingReason: recoverability?.reason ?? "terminal job is not resumable",
        }
  );
  return {
    jobId: job.id,
    // The internal terminal job receipt is the source of this linkage.  Do
    // not accept an Agent identity from a caller that disagrees with it.
    agentId: job.agentId ?? null,
    terminalStatus: job.status,
    completedAt: job.completedAt ?? job.updatedAt ?? nowIso(),
    summary,
    resumability,
    blocking,
    detailedResultAvailable: options.detailedResultAvailable ?? true,
    // An explicit `null` pointer means "no durable record the public detailed
    // -result path can resolve", which is a different statement from "the
    // caller did not say". `??` would collapse the two and re-advertise a
    // pointer the caller deliberately withheld.
    resultPointer: Object.hasOwn(options, "resultPointer") ? options.resultPointer : job.id,
    finalMessage:
      options.finalMessage ??
      job.result?.rawOutput ??
      job.result?.partialOutput ??
      job.rendered ??
      summary,
    claudeSessionIdAvailable: Boolean(
      options.claudeSessionIdAvailable ?? resumability?.claudeSessionId
    ),
    metrics: normalizeTerminalMetrics(job.result?.metrics) ?? null,
  };
}

export function markCompletionDetailedResultUnavailable(cwd, ownerRootId, jobId) {
  const owner = assertText(ownerRootId, "owner root ID");
  const eventId = deterministicCompletionEventId(owner, jobId);
  return withInboxLock(cwd, owner, (inbox, filePath) => {
    const index = inbox.events.findIndex((event) => event.eventId === eventId);
    if (index < 0) return { updated: false, reason: "missing_event" };
    const current = inbox.events[index];
    if (!current.detailedResultAvailable && current.resultPointer == null) {
      return { updated: false, reason: "already_unavailable" };
    }
    const events = [...inbox.events];
    events[index] = {
      ...current,
      detailedResultAvailable: false,
      resultPointer: null,
    };
    writeInboxAtomic(filePath, { ...inbox, events, updatedAt: nowIso() });
    return { updated: true, reason: "marked_unavailable" };
  });
}

export function reconcileTerminalJobCompletion(cwd, ownerRootId, job, options = {}) {
  // Reconciliation is a batch, restart-time path: an unpublishable job is
  // reported and skipped rather than thrown, so one unsettled turn cannot stop
  // unrelated terminal receipts from being delivered. Nothing is read, locked,
  // written, or acknowledged for it.
  const unsettled = unsettledTurnEvidence(job);
  if (unsettled) {
    return { reconciled: false, reason: classifyTurnSettlement(unsettled).reason, event: null };
  }
  const completion = completionFromTerminalJob(job, options);
  if (!completion) return { reconciled: false, reason: "not-terminal", event: null };
  const result = appendCompletionEvent(cwd, ownerRootId, completion, { reconcileExisting: true });
  return {
    reconciled: result.appended || result.corrected === true,
    reason: result.appended ? "appended" : result.reason ?? "already-present",
    event: result.event,
  };
}

/** Project one committed physical lifecycle loss without inventing semantic settlement. */
export function reconcileHardReclaimCompletion(cwd, ownerRootId, record) {
  const leaseDispositions = Object.values(record?.hardReclaim?.leaseDisposition ?? {});
  if (record?.status !== "hard_reclaimed" || record?.hardReclaim?.phase !== "committed" ||
      record?.uncertainty == null || record?.terminalJob != null ||
      leaseDispositions.length !== 3 || leaseDispositions.some((entry) => ["pending", "unknown"].includes(entry))) {
    return { reconciled: false, reason: "hard_reclaim_not_committed", event: null };
  }
  const result = appendCompletionEvent(cwd, ownerRootId, {
    jobId: record.jobId,
    agentId: record.agentId,
    terminalStatus: "hard_reclaimed",
    completedAt: record.hardReclaim.committedAt,
    summary: HARD_RECLAIM_LIFECYCLE_MESSAGE,
    settlement: "unknown",
    resumability: { classification: "not_resumable", blockingReason: "worker_lost" },
    blocking: HARD_RECLAIM_BLOCKING,
    detailedResultAvailable: false,
    resultPointer: null,
    finalMessage: HARD_RECLAIM_LIFECYCLE_MESSAGE,
    claudeSessionIdAvailable: false,
    metrics: null,
  }, { reconcileExisting: true });
  return {
    reconciled: result.appended || result.corrected === true,
    reason: result.appended ? "appended" : result.reason ?? "already-present",
    event: result.event,
  };
}

export function reconcileTerminalJobCompletions(cwd, ownerRootId, jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new Error("Terminal jobs must be an array.");
  return jobs.map((job) => reconcileTerminalJobCompletion(cwd, ownerRootId, job, options));
}
