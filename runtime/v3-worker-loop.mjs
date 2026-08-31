/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal version-three detached worker loop.
 *
 * This module owns the live turn lifecycle after `runtime/v3-worker-launch.mjs`
 * has durably proven native acceptance. It:
 *
 *   1. Acknowledges the prompt-carried mailbox assignment only after
 *      `acceptance_proven` is durable.
 *   2. Races the live turn result against durable wake hints for the Agent
 *      mailbox and the control stream, rereading durable state after every
 *      wake, on a wake window that can never be zero.
 *   3. Delivers capability-gated active input through the durable
 *      assigned -> dispatched -> acknowledged sequence, acknowledging only
 *      from a positive Driver receipt and leaving anything else dispatched.
 *   4. Claims, acknowledges, expires, and settles control commands bound to
 *      this exact worker attempt.
 *   5. Validates terminal evidence, proves it belongs to the accepted native
 *      turn, and gates every terminal projection on the shared publishability
 *      predicate.
 *   6. Holds leases and publishes nothing on unknown, invalid, contradictory,
 *      or unpublishable evidence -- including when a live Driver method, a
 *      durable control write, or the Agent store itself fails.
 *   7. Settles through one fixed durable order: final mailbox/control sweep,
 *      atomic Agent quiesce (the real live-ownership barrier), control-stream
 *      closure, lease release, durable terminal version-three job record,
 *      Agent projection, completion publication, and only then disposal. A
 *      disposal failure can never erase settlement that is already durable,
 *      and a publication failure leaves a durable terminal record that
 *      internal reconciliation can finish later.
 *
 * It is deliberately internal: no model-facing operation, no public v3 API,
 * and no 5.5/5.6 scope (no automatic public interrupt-to-cancel escalation, no
 * turn observation, no worker-loss recovery, no replay).
 */

import { types } from "node:util";
import { getProcessIdentity } from "./process-control.mjs";

import {
  canonicalAgentWorkspaceRoot,
  createAgentStore,
  resolveAgentRegistryDirectory,
} from "./agent-store.mjs";
import { reconcileTerminalJobCompletion } from "./completion-inbox.mjs";
import {
  FUTURE_WRITE_GENERATION,
  JOB_STATE_VERSION_V3,
  validateVersionThreeRoute,
} from "./durable-state-v3.mjs";
import { waitForDurableActivity } from "./durable-activity-wakeup.mjs";
import {
  assertHarnessId,
  boundedDriverReceipt,
  MAX_DRIVER_RECEIPT_BYTES,
  validateNativeProgress,
  validateNormalizedTerminalResult,
} from "./harness-contract.mjs";
import { sameNativeReference } from "./native-reference.mjs";
import { releaseLeasesOnSettlement } from "./instance-admission-lease.mjs";
import { resolveLaunchClaimDirectory } from "./launch-claim.mjs";
import { plainDataTree, plainRecordSnapshot } from "./plain-record.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import {
  claimControlCommand,
  closeControlStreamForAttempt,
  expireControlCommandDeadline,
  listControlCommands,
  recordRequestAcknowledgement,
  resolveControlStreamDirectory,
} from "./turn-control.mjs";
import {
  classifyTurnSettlement,
  classifyVersionThreeContinuation,
} from "./turn-settlement.mjs";
import { launchVersionThreeTurn } from "./v3-worker-launch.mjs";
import {
  MAX_TERMINAL_JOB_SUMMARY_CHARS,
  markVersionThreeTurnProjected,
  recordVersionThreeTurnRunning,
  recordVersionThreeTurnTerminal,
  recordVersionThreeTurnUncertain,
  publishVersionThreeProgress,
  versionThreeCompletionOptions,
} from "./v3-job-store.mjs";

const WORKER_LOOP_INPUT_FIELDS = Object.freeze([
  "ownerRootId",
  "agentId",
  "jobId",
  "attemptId",
  "route",
  "driver",
  "preparedTurn",
  "preparedInput",
  "assignedMessageIds",
  "assignedInputs",
  "leaseBindings",
  "controlRoot",
  "executionRoot",
  "workspaceRoot",
  "env",
  "signal",
  "deadlineAt",
  "cwd",
  "turnOptions",
  "nativeSessionRef",
]);

const ACTIVE_INPUT_CAPABILITY = "acknowledged_active_stream";
const INTERRUPT_CAPABILITY = "supported";
const REQUEST_STATES = Object.freeze(["accepted", "rejected", "unsupported"]);

/**
 * The wake window is clamped into `[MIN, MAX]` on every iteration, so a
 * deadline that has already elapsed -- the ordinary shape of a turn that
 * outlives its own deadline -- can never resolve the durable waiter
 * synchronously. Without this floor the loop would re-enter without ever
 * yielding to the event loop, starving the very timers and I/O callbacks that
 * carry the turn's own result.
 */
const MIN_WAKE_WINDOW_MS = 250;
const MAX_WAKE_WINDOW_MS = 30_000;
const WATCH_RECOVERY_INTERVAL_MS = 2_000;
const WATCH_FALLBACK_INTERVAL_MS = 1_000;
const MAX_RECEIPT_DEPTH = 3;

function nowIso() {
  return new Date().toISOString();
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty text value.`);
  }
  return value.trim();
}

/** Sanitized, bounded detail text for a durable-unknown disposition. */
function detailOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}

function snapshotArray(value, label) {
  if (!Array.isArray(value) || types.isProxy(value)) {
    throw new Error(`${label} must be an ordinary array.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must not carry symbol-keyed state.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} has an invalid length.`);
  }
  const allowedKeys = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  for (const key of Object.keys(descriptors)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} declares an unsupported array property: ${key}.`);
  }
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new Error(`${label}[${index}] must be one own data value; sparse/accessor arrays are refused.`);
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

function snapshotAssignedInput(value, index) {
  const label = `Version-three worker assignedInputs[${index}]`;
  const snapshot = plainRecordSnapshot(value, label);
  for (const field of Object.keys(snapshot)) {
    if (!["messageId", "text"].includes(field)) {
      throw new Error(`${label} declares an unsupported field: ${field}.`);
    }
  }
  if (typeof snapshot.text !== "string" || !snapshot.text) {
    throw new Error(`${label} requires the exact prepared text of its mailbox entry.`);
  }
  return Object.freeze({
    messageId: assertText(snapshot.messageId, `${label} messageId`),
    text: snapshot.text,
  });
}

/**
 * A deadline is bounded evidence, never an open-ended value. An unparseable or
 * non-finite deadline is refused here rather than degrading a durable wait
 * into a spin (`NaN` timers fire immediately).
 */
function snapshotDeadline(value) {
  if (value == null) return null;
  const text = assertText(value, "Version-three worker deadlineAt");
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error("Version-three worker deadlineAt must be one parseable timestamp.");
  }
  return Object.freeze({ text, ms: parsed });
}

function snapshotWorkerLoopInput(input) {
  const snapshot = plainRecordSnapshot(input, "Version-three worker loop input");
  for (const field of Object.keys(snapshot)) {
    if (!WORKER_LOOP_INPUT_FIELDS.includes(field)) {
      throw new Error(`Version-three worker loop input declares an unsupported field: ${field}.`);
    }
  }
  for (const field of [
    "ownerRootId", "agentId", "jobId", "attemptId", "route", "driver",
    "preparedTurn", "preparedInput", "assignedMessageIds", "leaseBindings",
    "cwd",
    // Stated, not necessarily non-empty. The launch core binds it into the
    // durable claim digest; this loop only requires that a value exists.
    "turnOptions",
  ]) {
    if (!Object.hasOwn(snapshot, field)) {
      throw new Error(`Version-three worker loop input requires ${field}.`);
    }
  }
  const hasSplitRoots = Object.hasOwn(snapshot, "controlRoot") || Object.hasOwn(snapshot, "executionRoot");
  if (
    hasSplitRoots &&
    !(Object.hasOwn(snapshot, "controlRoot") && Object.hasOwn(snapshot, "executionRoot"))
  ) {
    throw new Error("Version-three worker loop input must state controlRoot and executionRoot together.");
  }
  if (!hasSplitRoots && !Object.hasOwn(snapshot, "workspaceRoot")) {
    throw new Error("Version-three worker loop input requires its durable roots.");
  }
  const route = validateVersionThreeRoute(snapshot.route, "Version-three worker loop route");
  assertHarnessId(snapshot.driver?.harnessId);
  const assignedMessageIds = snapshotArray(snapshot.assignedMessageIds, "Version-three worker assignedMessageIds")
    .map((value, index) => assertText(value, `Version-three worker assignedMessageIds[${index}]`));
  if (assignedMessageIds.length === 0) {
    throw new Error("Version-three worker loop requires the assigned mailbox identity its launch claim binds.");
  }
  if (new Set(assignedMessageIds).size !== assignedMessageIds.length) {
    throw new Error("Version-three worker assignedMessageIds must be unique.");
  }
  const leaseBindings = snapshotArray(snapshot.leaseBindings, "Version-three worker leaseBindings");
  if (leaseBindings.length === 0) {
    throw new Error("Version-three worker loop requires the authority leases its launch claim binds.");
  }

  // `assignedInputs` names the subset of the claim's own mailbox identity that
  // this turn must deliver as active input *after* proven acceptance. It is
  // deliberately never forwarded to the launch core, whose fence refuses it:
  // nothing may be delivered before the native turn is durably accepted.
  const assignedInputs = snapshot.assignedInputs == null
    ? Object.freeze([])
    : Object.freeze(snapshotArray(snapshot.assignedInputs, "Version-three worker assignedInputs").map(snapshotAssignedInput));
  const activeInputIds = assignedInputs.map((entry) => entry.messageId);
  if (new Set(activeInputIds).size !== activeInputIds.length) {
    throw new Error("Version-three worker assignedInputs must name each mailbox entry at most once.");
  }
  for (const messageId of activeInputIds) {
    if (!assignedMessageIds.includes(messageId)) {
      throw new Error(
        `Version-three worker assignedInputs names ${JSON.stringify(messageId)}, which its launch claim's ` +
        "assigned mailbox identity does not contain."
      );
    }
  }
  if (assignedInputs.length > 0 && route.capabilities?.values?.activeInput !== ACTIVE_INPUT_CAPABILITY) {
    throw new Error(
      "Version-three worker assignedInputs require a route whose accepted capability snapshot admits " +
      "acknowledged active input; this route does not."
    );
  }

  // The detached worker and all durable state stay in the control root. Only
  // the Driver scope and writer lease use the separately immutable execution
  // root. Legacy single-root inputs interpret their one stored workspace as
  // both roots without rewriting durable state.
  const cwd = assertText(snapshot.cwd, "Version-three worker cwd");
  const declaredControlRoot = assertText(
    hasSplitRoots ? snapshot.controlRoot : snapshot.workspaceRoot,
    "Version-three worker controlRoot",
  );
  const declaredExecutionRoot = assertText(
    hasSplitRoots ? snapshot.executionRoot : snapshot.workspaceRoot,
    "Version-three worker executionRoot",
  );
  const canonicalWorkspaceRoot = canonicalAgentWorkspaceRoot(cwd);
  if (canonicalAgentWorkspaceRoot(declaredControlRoot) !== canonicalWorkspaceRoot) {
    throw new Error(
      "Version-three worker controlRoot and cwd resolve to different canonical workspaces."
    );
  }
  const canonicalExecutionRoot = canonicalAgentWorkspaceRoot(declaredExecutionRoot);

  return Object.freeze({
    ownerRootId: assertText(snapshot.ownerRootId, "Version-three worker ownerRootId"),
    agentId: assertText(snapshot.agentId, "Version-three worker agentId"),
    jobId: assertText(snapshot.jobId, "Version-three worker jobId"),
    attemptId: assertText(snapshot.attemptId, "Version-three worker attemptId"),
    route,
    driver: snapshot.driver,
    preparedTurn: snapshot.preparedTurn,
    preparedInput: snapshot.preparedInput,
    // Both are Driver-owned and opaque here. The launch core canonicalizes,
    // binds, and validates them; this loop only carries them through.
    turnOptions: snapshot.turnOptions ?? null,
    nativeSessionRef: snapshot.nativeSessionRef ?? null,
    assignedMessageIds: Object.freeze(assignedMessageIds),
    assignedInputs,
    promptMessageIds: Object.freeze(assignedMessageIds.filter((id) => !activeInputIds.includes(id))),
    leaseBindings,
    controlRoot: canonicalWorkspaceRoot,
    executionRoot: canonicalExecutionRoot,
    workspaceRoot: canonicalExecutionRoot,
    canonicalWorkspaceRoot,
    env: plainDataTree(snapshot.env ?? {}, "Version-three worker env", 3),
    signal: snapshot.signal ?? null,
    deadline: snapshotDeadline(snapshot.deadlineAt),
    cwd,
  });
}

function identityOf(snapshot) {
  return {
    ownerRootId: snapshot.ownerRootId,
    agentId: snapshot.agentId,
    jobId: snapshot.jobId,
  };
}

/**
 * The launch input. `assignedInputs` is always empty here: 5.4A's fence refuses
 * active input at launch, and this loop binds it afterwards instead.
 */
function launchInputOf(snapshot) {
  return {
    ownerRootId: snapshot.ownerRootId,
    agentId: snapshot.agentId,
    jobId: snapshot.jobId,
    attemptId: snapshot.attemptId,
    lifecycleOwner: "version_three_worker",
    route: snapshot.route,
    driver: snapshot.driver,
    preparedTurn: snapshot.preparedTurn,
    preparedInput: snapshot.preparedInput,
    assignedMessageIds: snapshot.assignedMessageIds,
    assignedInputs: [],
    leaseBindings: snapshot.leaseBindings,
    controlRoot: snapshot.controlRoot,
    executionRoot: snapshot.executionRoot,
    env: snapshot.env,
    signal: snapshot.signal,
    deadlineAt: snapshot.deadline?.text ?? null,
    // Always stated onward: the launch core refuses an omitted value, and an
    // omission must never be silently reintroduced as a default here.
    turnOptions: snapshot.turnOptions,
    ...(snapshot.nativeSessionRef == null ? {} : { nativeSessionRef: snapshot.nativeSessionRef }),
  };
}

/**
 * Exported so `runtime/v3-turn-reconciliation.mjs` can release the exact same
 * lease targets from a durable launch claim's `leaseBindings` after the
 * worker that acquired them is gone, without a second, drifting copy of this
 * mapping. Pure; touches no file.
 */
export function buildLeaseReleaseTargets(leaseBindings) {
  return leaseBindings.map((binding) => {
    const base = {
      kind: binding.kind,
      ownerRootId: binding.ownerRootId,
      agentId: binding.agentId,
      jobId: binding.jobId,
      route: binding.route,
    };
    if (binding.kind === "instance") {
      return {
        ...base,
        harnessId: binding.keyFields.harnessId,
        instanceKey: binding.keyFields.instanceKey,
        capacityClass: binding.capacity.class,
      };
    }
    if (binding.kind === "native_session") {
      return {
        ...base,
        harnessId: binding.keyFields.harnessId,
        instanceKey: binding.keyFields.instanceKey,
        nativeSessionId: binding.keyFields.nativeSessionId,
      };
    }
    return { ...base, workspaceRoot: binding.keyFields.workspaceRoot };
  });
}

/**
 * The record's bounded derived label, never a second copy of the deliverable.
 *
 * A final message is admitted whole by the contract (256 KiB of characters);
 * a summary is a short operator-facing line, so it is truncated at its own
 * named bound with an explicit ellipsis rather than silently carrying an
 * answer-sized payload into a second durable field.
 */
function boundedTerminalSummary(normalizedResult, jobId) {
  const fallback = `${normalizedResult.status} job ${jobId}`;
  // The completion inbox requires a non-empty, NUL-free summary, while the
  // normalized result contract intentionally preserves a legal blank or
  // NUL-bearing final message verbatim.  The summary is only a derived label:
  // it must never become a second copy of that deliverable.
  const candidate = normalizedResult.finalMessage != null
    ? normalizedResult.finalMessage
    : normalizedResult.finalMessageAbsenceReason;
  const source = typeof candidate === "string" && candidate.trim() && !candidate.includes("\0")
    ? candidate.trim()
    : fallback;
  if (source.length <= MAX_TERMINAL_JOB_SUMMARY_CHARS) return source;
  return `${source.slice(0, MAX_TERMINAL_JOB_SUMMARY_CHARS - 1)}\u2026`;
}

/**
 * The durable version-three terminal receipt. It carries its own route,
 * attempt, and exact native turn lineage, and it states continuation only
 * through the single owner in `runtime/turn-settlement.mjs`: `safe_fresh` --
 * a claim that replaying is harmless -- is never inferred from a transcript
 * fact. No legacy Claude session field is written for a version-three turn.
 *
 * Exported so `runtime/v3-turn-reconciliation.mjs` builds byte-identical
 * terminal projections for the same evidence instead of a second, drifting
 * copy of this shape; `snapshot` there is a minimal `{jobId, agentId,
 * ownerRootId, attemptId, route}` binding rather than the full worker
 * snapshot, and `launchClaim` only ever needs its `nativeTurnRef`.
 */
export function buildVersionThreeTerminalJob(snapshot, launchClaim, normalizedResult, continuationProjection) {
  const summary = boundedTerminalSummary(normalizedResult, snapshot.jobId);
  return {
    id: snapshot.jobId,
    agentId: snapshot.agentId,
    ownerRootId: snapshot.ownerRootId,
    harnessStateVersion: JOB_STATE_VERSION_V3,
    attemptId: snapshot.attemptId,
    route: snapshot.route,
    harnessId: snapshot.route.harnessId,
    harnessInstanceKey: snapshot.route.instanceKey,
    driverVersion: snapshot.route.driverVersion,
    nativeTurnRef: launchClaim.nativeTurnRef,
    status: normalizedResult.status,
    completedAt: nowIso(),
    summary,
    // `rawOutput` is deliberately absent. The complete final message has
    // exactly one durable home -- `normalizedTerminalResult.finalMessage` --
    // and copying it here (and again into `summary`) is what made a
    // contract-legal answer overrun this record's durable capacity. The
    // completion event reads the one copy through
    // `versionThreeCompletionOptions()`.
    result: {
      failureClass: normalizedResult.failure?.class ?? null,
      metrics: normalizedResult.metrics ?? null,
    },
    recoverability: {
      resumable: continuationProjection.resumable,
      mode: continuationProjection.mode,
      reason: continuationProjection.reason,
    },
    // The public completion payload keeps its version-two shape. A
    // version-three continuation pointer is a Driver-validated envelope, not a
    // Claude session ID. `followup_task` resumes from the Agent record itself;
    // this legacy completion field cannot encode that neutral pointer, so it
    // states where the pointer lives instead of renaming a foreign locator into
    // a Claude-shaped field. The separately frozen `blocking` projection owns
    // the public same-Agent retry decision.
    resumability: {
      classification: "not_resumable",
      blockingReason: continuationProjection.mode === "exact_session"
        ? "version_three_continuation_recorded_on_agent_record"
        : continuationProjection.reason,
    },
    normalizedTerminalResult: normalizedResult,
  };
}

function activeInputSupported(route) {
  return route.capabilities?.values?.activeInput === ACTIVE_INPUT_CAPABILITY;
}

function interruptSupported(route) {
  return route.capabilities?.values?.interruptRequest === INTERRUPT_CAPABILITY;
}

/**
 * Only an explicit positive Driver receipt may acknowledge a mailbox entry.
 * An absent receipt, a non-plain receipt, or `accepted:false` all mean the
 * Harness did not take the input, so the entry stays `dispatched` and is never
 * consumed.
 */
function isPositiveInputReceipt(receipt) {
  if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt) || types.isProxy(receipt)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(receipt, "accepted");
  return Boolean(descriptor) && Object.hasOwn(descriptor, "value") && descriptor.value === true;
}

/**
 * An explicit, readable `accepted: false` -- the Driver's own proof that it did
 * not take the input. This is the only negative strong enough to requeue on:
 * an absent, exotic, or unreadable receipt proves nothing about whether the
 * input crossed the native boundary.
 */
function isProvenNegativeInputReceipt(receipt) {
  if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt) || types.isProxy(receipt)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(receipt, "accepted");
  return Boolean(descriptor) && Object.hasOwn(descriptor, "value") && descriptor.value === false;
}

/**
 * Return one provably undelivered entry to the queue so a later turn owes it
 * again. A failure to record that is itself reported: the entry then stays
 * dispatched, which is conservative rather than lost.
 */
function requeueProvenUndelivered(session, messageId, reason) {
  const { snapshot, agentStore } = session;
  try {
    agentStore.requeueUndeliveredMessage(snapshot.agentId, messageId, { jobId: snapshot.jobId, reason });
    session.dispatchedUnacknowledged.delete(messageId);
    session.requeuedMessageIds.push(messageId);
    session.inputFailures.push({ messageId, reason, detail: null, disposition: "requeued" });
  } catch (error) {
    session.inputFailures.push({
      messageId, reason, detail: detailOf(error), disposition: "requeue_failed",
    });
  }
}

/** Pin one dispatched entry whose delivery outcome is unknown, with its reason. */
function pinUnknownDelivery(session, messageId, reason, detail) {
  const { snapshot, agentStore } = session;
  try {
    agentStore.pinUndeliveredMessage(snapshot.agentId, messageId, { jobId: snapshot.jobId, reason });
  } catch {
    // The pin is an explanatory fact, not the safety property. The entry is
    // already dispatched-not-acknowledged, which is what keeps it unreplayed.
  }
  // Reported here as well as at the barrier: an entry pinned mid-turn is
  // pinned whether or not this turn ever reaches a settlement sweep, and a
  // receipt whose `pinnedMessageIds` omitted it would understate what is held.
  if (!session.pinnedMessageIds.includes(messageId)) session.pinnedMessageIds.push(messageId);
  session.inputFailures.push({ messageId, reason, detail, disposition: "pinned_dispatched" });
}

/** One bounded, replay-stable view of a durable command for the Driver. */
function commandView(command) {
  return {
    commandId: command.commandId,
    kind: command.kind,
    requestedAt: command.requestedAt,
    deadlineAt: command.deadlineAt,
    sanitizedReason: command.sanitizedReason ?? null,
  };
}

/**
 * Identity by validated value, never by key insertion order. A Driver that
 * rebuilds its turn locator from a different service response at settlement
 * than at start names the same turn even when its fields serialize in a
 * different order; treating that as a foreign turn would hold every lease and
 * publish nothing for a turn that provably completed.
 */
function sameNativeTurnRef(left, right) {
  return sameNativeReference(left, right, "Version-three terminal native turn reference");
}

/**
 * The anti-spin floor. Deliberately not unref'd: it is bounded by
 * `MIN_WAKE_WINDOW_MS`, and an unref'd floor could let a process exit out from
 * under a live turn whose own completion handle is unref'd too.
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * One abort waiter for the whole loop, with an explicit disposer. A waiter per
 * iteration would accumulate listeners on a long-lived signal for as long as
 * the turn runs.
 */
function createAbortWaiter(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose() {} };
  let onAbort = null;
  const promise = new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      onAbort = null;
    },
  };
}

/**
 * The next moment this loop must be awake for a bounded fact it owns: the
 * turn's own deadline, and every claimed control command's deadline. Without
 * the command boundary a quiet turn would sleep past deadlines the worker is
 * the only live owner of.
 */
function nextWakeBoundaryMs(session) {
  const now = Date.now();
  let boundary = now + MAX_WAKE_WINDOW_MS;
  // Only a boundary that is still ahead of us is a reason to wake early. An
  // elapsed deadline has already been acted on -- the turn's own deadline is
  // never a terminal synthesis, and a claimed command's deadline is recorded
  // exactly once -- so continuing to clamp against it would pin the loop to
  // its anti-spin floor and sweep durable state four times a second for the
  // rest of a turn that may run for hours.
  if (session.snapshot.deadline != null && session.snapshot.deadline.ms > now) {
    boundary = Math.min(boundary, session.snapshot.deadline.ms);
  }
  for (const state of session.claimedCommands.values()) {
    if (state.settled) continue;
    const deadline = Date.parse(state.deadlineAt);
    if (Number.isFinite(deadline) && deadline > now) boundary = Math.min(boundary, deadline);
  }
  return boundary;
}

/**
 * One bounded wake. The window can never be zero, the losing watcher/timer is
 * always cancelled by the caller's `dispose()`, and the returned promise never
 * rejects, so a losing waiter can never surface as an unhandled rejection.
 */
function createWakeWaiter(session) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const window = Math.min(
    MAX_WAKE_WINDOW_MS,
    Math.max(MIN_WAKE_WINDOW_MS, nextWakeBoundaryMs(session) - startedAt)
  );
  const promise = waitForDurableActivity({
    desiredPaths: session.watchDirectories,
    stateRoot: resolvePluginStateRoot(),
    deadline: startedAt + window,
    signal: controller.signal,
    recoveryIntervalMs: WATCH_RECOVERY_INTERVAL_MS,
    fallbackIntervalMs: WATCH_FALLBACK_INTERVAL_MS,
  }).then(
    (diagnostics) => ({ kind: "wake", wakeReason: diagnostics?.wakeReason ?? null }),
    () => ({ kind: "wake", wakeReason: "cancelled" }),
  ).then(async (outcome) => {
    // Structural anti-spin floor: however a wake resolved, one iteration can
    // never consume less than the floor, so no watcher storm or degenerate
    // waiter can turn this loop into a hot loop.
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_WAKE_WINDOW_MS) await delay(MIN_WAKE_WINDOW_MS - elapsed);
    return outcome;
  });
  return { promise, dispose() { controller.abort(); } };
}

/**
 * The live worker session: every durable owner this attempt touches, plus the
 * bounded facts a caller needs to reconcile what happened.
 */
function createSession(snapshot, liveTurn, launchClaim) {
  const agentStore = createAgentStore({
    cwd: snapshot.cwd,
    ownerRootId: snapshot.ownerRootId,
    // Version-three Agent, mailbox, and terminal records are owned by the
    // internal generation. This store never carries a legacy Harness default.
    writeGeneration: FUTURE_WRITE_GENERATION,
  });
  return {
    snapshot,
    liveTurn,
    launchClaim,
    agentStore,
    identity: identityOf(snapshot),
    watchDirectories: [
      resolveControlStreamDirectory(identityOf(snapshot)),
      resolveLaunchClaimDirectory(identityOf(snapshot)),
      resolveAgentRegistryDirectory({ cwd: snapshot.cwd, ownerRootId: snapshot.ownerRootId }),
    ],
    liveOwnershipCleared: false,
    /** @type {Map<string, {deadlineAt: string, acknowledged: boolean, settled: boolean}>} */
    claimedCommands: new Map(),
    /** @type {Map<string, string>} */
    skippedCommands: new Map(),
    /** @type {Array<{commandId: string, stage: string, detail: string}>} */
    controlFailures: [],
    /** @type {Set<string>} */
    deliveryAttempted: new Set(),
    /** @type {Set<string>} */
    dispatchedUnacknowledged: new Set(),
    /** @type {Array<{messageId: string, reason: string, detail: string|null, disposition?: string}>} */
    inputFailures: [],
    acknowledgedMessageIds: [],
    /** @type {string[]} */
    requeuedMessageIds: [],
    /** @type {string[]} */
    retainedMessageIds: [],
    /** @type {string[]} */
    pinnedMessageIds: [],
    /** @type {*} */
    leaseRelease: null,
    /** @type {*} */
    controlClosure: null,
    /** @type {*} */
    liveOwnershipQuiesce: null,
    durableRecord: "running",
    progressUnsubscribe: null,
  };
}

function sessionFacts(session) {
  return {
    mailbox: {
      acknowledgedMessageIds: [...session.acknowledgedMessageIds],
      dispatchedUnacknowledgedMessageIds: [...session.dispatchedUnacknowledged],
      // Entries returned to the queue because nothing was ever delivered for
      // them; a later turn owes each one again.
      requeuedMessageIds: [...session.requeuedMessageIds],
      // Entries left bound to this finished turn because they were carried in
      // the launch prompt: the Harness already has them, so they are never
      // requeued and never replayed.
      retainedMessageIds: [...session.retainedMessageIds],
      // Entries pinned as dispatched-with-unknown-outcome; never replayed.
      pinnedMessageIds: [...session.pinnedMessageIds],
      inputFailures: session.inputFailures.map((failure) => ({ ...failure })),
    },
    control: {
      claimedCommandIds: [...session.claimedCommands.keys()],
      skippedCommands: Object.fromEntries(session.skippedCommands),
      failures: session.controlFailures.map((failure) => ({ ...failure })),
      // Present only once the stream has been durably closed: which commands
      // this settlement settled, and which were left to their own owner.
      closure: session.controlClosure,
    },
  };
}

/**
 * Acknowledge the prompt-carried mailbox entries, and only those: active-input
 * entries are acknowledged from their own Driver receipt instead.
 *
 * Dispatch is replay-safe for the one state a crashed predecessor can leave
 * behind: an entry already `dispatched` is re-marked as a no-op and then
 * acknowledged here rather than skipped, so at-least-once delivery cannot
 * silently strand a message in `dispatched`. Any other state -- including an
 * already-`acknowledged` entry -- is refused by the mailbox rather than
 * silently accepted, and that refusal surfaces as a durable unknown for this
 * attempt. It is unreachable in practice: exactly one attempt may ever win a
 * job's launch claim, so no second worker reaches this point for the same
 * prompt entries.
 */
function acknowledgePromptMessages(session) {
  const { snapshot, agentStore } = session;
  for (const messageId of snapshot.promptMessageIds) {
    agentStore.markMessageDispatched(snapshot.agentId, messageId, { jobId: snapshot.jobId });
    agentStore.acknowledgeMessage(snapshot.agentId, messageId, {
      jobId: snapshot.jobId,
      receipt: { acceptance: "proven", acceptedAt: nowIso() },
    });
    session.acknowledgedMessageIds.push(messageId);
  }
}

/**
 * Deliver every mailbox entry this job owns that is still `assigned`, once.
 *
 * A message is marked `dispatched` before the Driver is called, so a delivery
 * whose outcome is unknown stays visible as dispatched-not-acknowledged rather
 * than being retried into a duplicate native delivery.
 */
async function deliverActiveInputs(session) {
  const { snapshot, agentStore, liveTurn } = session;
  if (!activeInputSupported(snapshot.route) || typeof liveTurn.deliverActiveInput !== "function") return;
  const assigned = agentStore
    .listMessages(snapshot.agentId, { state: "assigned" })
    .filter((message) => message.assignedJobId === snapshot.jobId);
  for (const message of assigned) {
    if (session.deliveryAttempted.has(message.messageId)) continue;
    const bound = snapshot.assignedInputs.find((entry) => entry.messageId === message.messageId) ?? null;
    if (bound && bound.text !== message.text) {
      // The mailbox is the durable ordering owner. A prepared text that
      // disagrees with it would deliver something the record does not state.
      throw new Error(
        `Version-three assigned input for ${message.messageId} does not match its durable mailbox text.`
      );
    }
    session.deliveryAttempted.add(message.messageId);
    agentStore.markMessageDispatched(snapshot.agentId, message.messageId, { jobId: snapshot.jobId });
    session.dispatchedUnacknowledged.add(message.messageId);
    let receipt;
    try {
      receipt = await liveTurn.deliverActiveInput({
        messageId: message.messageId,
        text: message.text,
        sequence: message.sequence,
      });
    } catch (error) {
      // The delivery may or may not have crossed the native boundary. It stays
      // dispatched and pinned with an explicit durable fact: replaying it
      // could duplicate work the Harness already did.
      pinUnknownDelivery(session, message.messageId, "driver_delivery_failed", detailOf(error));
      continue;
    }
    if (isProvenNegativeInputReceipt(receipt)) {
      // The Driver proved it did not take this entry. Nothing crossed the
      // boundary, so the message is still owed and returns to the queue for a
      // later turn rather than being stranded on a finished job.
      requeueProvenUndelivered(session, message.messageId, "driver_rejected_active_input");
      continue;
    }
    if (!isPositiveInputReceipt(receipt)) {
      // Neither a positive nor a readable negative: unknown, so pin it.
      pinUnknownDelivery(session, message.messageId, "receipt_not_positive", null);
      continue;
    }
    let boundedReceipt;
    try {
      const durableReceipt = plainDataTree(receipt, "Active input delivery receipt", MAX_RECEIPT_DEPTH);
      // Use the Driver-contract owner for the byte bound. Keep the original
      // receipt shape in the mailbox (callers rely on `accepted`), but let the
      // contract wrapper decide whether it fits. An omitted wrapper is a
      // negative size proof, not an acknowledgement receipt.
      const bounded = boundedDriverReceipt(
        snapshot.driver.harnessId,
        snapshot.driver.driverVersion,
        durableReceipt,
      );
      if (bounded.omitted === "driver_receipt_exceeded_bound") {
        throw new Error(`Active input delivery receipt exceeds ${MAX_DRIVER_RECEIPT_BYTES} bytes.`);
      }
      boundedReceipt = durableReceipt;
    } catch (error) {
      // A receipt that cannot be recorded as bounded durable evidence cannot
      // acknowledge anything -- and it claimed acceptance, so the delivery may
      // well have happened. Unknown, therefore pinned, never replayed.
      pinUnknownDelivery(session, message.messageId, "receipt_not_recordable", detailOf(error));
      continue;
    }
    agentStore.acknowledgeMessage(snapshot.agentId, message.messageId, {
      jobId: snapshot.jobId,
      receipt: boundedReceipt,
    });
    session.dispatchedUnacknowledged.delete(message.messageId);
    session.acknowledgedMessageIds.push(message.messageId);
  }
}

/**
 * Claim, request, and acknowledge control commands for this exact attempt.
 *
 * A command this attempt cannot claim -- a foreign native turn reference, an
 * out-of-order or already-claimed record -- is skipped and reported. It never
 * ends the turn, and no receipt is ever synthesized for it: an unclaimable
 * command stays exactly as its own owner left it.
 */
async function processControlCommands(session) {
  const { snapshot, liveTurn, launchClaim } = session;
  if (!interruptSupported(snapshot.route) || typeof liveTurn.requestInterrupt !== "function") return;
  const commands = listControlCommands(session.identity);
  for (const command of commands) {
    if (session.claimedCommands.has(command.commandId)) continue;
    if (session.skippedCommands.has(command.commandId)) continue;
    if (command.requestState !== "none") {
      session.skippedCommands.set(command.commandId, "already_acknowledged");
      continue;
    }
    try {
      claimControlCommand({
        ...session.identity,
        commandId: command.commandId,
        route: snapshot.route,
        nativeTurnRef: launchClaim.nativeTurnRef,
        workerAttemptId: snapshot.attemptId,
      });
    } catch (error) {
      session.skippedCommands.set(command.commandId, "not_claimable");
      session.controlFailures.push({ commandId: command.commandId, stage: "claim", detail: detailOf(error) });
      continue;
    }
    session.claimedCommands.set(command.commandId, {
      deadlineAt: command.deadlineAt,
      acknowledged: false,
      settled: false,
    });
    let response;
    try {
      response = await liveTurn.requestInterrupt(commandView(command));
    } catch (error) {
      // A failed request is not a rejection: nothing is durably claimed about
      // the request axis, and this command's settlement is decided later by
      // terminal evidence or by its own deadline.
      session.controlFailures.push({ commandId: command.commandId, stage: "request", detail: detailOf(error) });
      continue;
    }
    const requestState = REQUEST_STATES.includes(response?.requestState) ? response.requestState : null;
    if (requestState == null) {
      session.controlFailures.push({
        commandId: command.commandId,
        stage: "request",
        detail: "Driver returned no admitted requestState; no request outcome was recorded.",
      });
      continue;
    }
    try {
      recordRequestAcknowledgement({
        ...session.identity,
        commandId: command.commandId,
        route: snapshot.route,
        nativeTurnRef: launchClaim.nativeTurnRef,
        workerAttemptId: snapshot.attemptId,
        requestState,
      });
      session.claimedCommands.get(command.commandId).acknowledged = true;
    } catch (error) {
      session.controlFailures.push({
        commandId: command.commandId,
        stage: "acknowledgement",
        detail: detailOf(error),
      });
    }
  }
}

/**
 * The worker owns its own commands' deadlines: a bounded wait with no
 * authoritative evidence becomes `settlement=unknown`, never a synthesized
 * terminal or interruption.
 */
function expireOwnControlDeadlines(session) {
  const { snapshot, launchClaim } = session;
  const now = Date.now();
  for (const [commandId, state] of session.claimedCommands) {
    if (state.settled) continue;
    const deadline = Date.parse(state.deadlineAt);
    if (!Number.isFinite(deadline) || now < deadline) continue;
    try {
      expireControlCommandDeadline({
        ...session.identity,
        commandId,
        route: snapshot.route,
        nativeTurnRef: launchClaim.nativeTurnRef,
      });
      // The durable record now says `settlement=unknown`, and only publishable
      // terminal evidence may move it forward -- which the settlement path
      // owns, not this scan. Marking it here stops an elapsed deadline from
      // being re-locked and re-read on every later iteration.
      state.settled = true;
      state.deadlineExpired = true;
    } catch (error) {
      session.controlFailures.push({ commandId, stage: "deadline_expiry", detail: detailOf(error) });
    }
  }
}

/**
 * The durable live-ownership barrier: atomically stop owning this Agent's live
 * turn.
 *
 * In one registry mutation the Agent records that its turn is quiesced, every
 * entry still merely `assigned` as steering returns to the queue, every entry
 * carried in the launch prompt is retained rather than replayed, and every
 * `dispatched` entry stays pinned. From that moment a concurrent
 * `enqueueMessage()` -- an isolated `send_message`/`followup_task` caller, in
 * any process -- queues for the *next* turn instead of binding to a turn that
 * can no longer deliver anything. That is the property a boolean in this
 * process could never have.
 *
 * This runs on **both** exits. On terminal settlement it precedes lease
 * release and publication. On an unknown exit the worker is equally unable to
 * deliver anything ever again, so binding later input to this job would strand
 * it just as surely; the difference is only that `activeJobId` then stays set
 * forever in this generation, which is the conservative outcome for a turn
 * whose native fate is unproven.
 */
function quiesceLiveOwnership(session) {
  const { snapshot, agentStore } = session;
  const receipt = agentStore.quiesceVersionThreeTurn(snapshot.agentId, snapshot.jobId, {
    attemptId: snapshot.attemptId,
  });
  if (!receipt.quiesced) {
    throw new Error(`Version-three live ownership could not be quiesced: ${receipt.reason}.`);
  }
  session.liveOwnershipCleared = true;
  for (const messageId of receipt.requeuedMessageIds) {
    if (!session.requeuedMessageIds.includes(messageId)) session.requeuedMessageIds.push(messageId);
  }
  for (const messageId of receipt.retainedMessageIds) {
    if (!session.retainedMessageIds.includes(messageId)) session.retainedMessageIds.push(messageId);
  }
  for (const messageId of receipt.pinnedMessageIds) {
    if (!session.pinnedMessageIds.includes(messageId)) session.pinnedMessageIds.push(messageId);
  }
  session.liveOwnershipQuiesce = Object.freeze({
    quiesced: true,
    reason: null,
    requeuedMessageIds: [...receipt.requeuedMessageIds],
    retainedMessageIds: [...receipt.retainedMessageIds],
    pinnedMessageIds: [...receipt.pinnedMessageIds],
  });
  return receipt;
}

/**
 * Apply the barrier on an unknown exit, containing its own failure.
 *
 * Deliberately **not** paired with a control-stream closure. Closing the
 * stream states that the native turn is provably terminal; an unknown exit
 * proves nothing of the sort, and a later Task 5.6 observation must still be
 * able to settle commands against real evidence. Input binding is the separate
 * axis: an entry that was never dispatched can always be returned to the
 * queue, so the mailbox barrier is safe exactly when the control barrier is
 * not.
 *
 * The receipt states what happened either way -- a barrier that could not be
 * applied is a fact an operator needs, not something to swallow.
 */
function quiesceOnUnknownExit(session) {
  // Already applied on the way to this exit (a terminal settlement that failed
  // after its own barrier): re-running it would only restate the same fact.
  if (session.liveOwnershipQuiesce != null) return session.liveOwnershipQuiesce;
  try {
    quiesceLiveOwnership(session);
    return session.liveOwnershipQuiesce;
  } catch (error) {
    return Object.freeze({
      quiesced: false,
      reason: detailOf(error),
      requeuedMessageIds: [],
      retainedMessageIds: [],
      pinnedMessageIds: [],
    });
  }
}

/**
 * The durable live-ownership barrier, step two: settle and close this exact
 * attempt's control stream.
 *
 * Every command bound to this native turn -- including one that landed after
 * the last wake, which this worker never claimed and never requested -- is
 * settled from the same terminal evidence that is about to publish, and the
 * stream is closed so no later command can be appended. Without this a late
 * command would sit durably claiming `nativeTurnState: "active"` for a turn
 * proven terminal, with nothing in this generation able to correct it.
 */
function closeLiveControlOwnership(session, normalizedResult) {
  const { snapshot, launchClaim } = session;
  const receipt = closeControlStreamForAttempt({
    ...session.identity,
    route: snapshot.route,
    nativeTurnRef: launchClaim.nativeTurnRef,
    workerAttemptId: snapshot.attemptId,
    normalizedTerminalResult: normalizedResult,
  });
  for (const commandId of receipt.settledCommandIds) {
    const state = session.claimedCommands.get(commandId);
    if (state) state.settled = true;
  }
  session.controlClosure = {
    settledCommandIds: [...receipt.settledCommandIds],
    alreadySettledCommandIds: [...receipt.alreadySettledCommandIds],
    skipped: receipt.skipped.map((entry) => ({ ...entry })),
  };
  return receipt;
}

async function disposeLiveTurn(session) {
  try { session.progressUnsubscribe?.(); } catch { /* best-effort source cleanup */ }
  session.progressUnsubscribe = null;
  try {
    await session.liveTurn.dispose();
    return { disposed: true, disposalFailure: null };
  } catch (error) {
    // Disposal is cleanup, never evidence. Whatever is already durable stays
    // durable and is still reported.
    return { disposed: false, disposalFailure: detailOf(error) };
  }
}

/**
 * Persist the nonterminal uncertainty of this attempt before anything is
 * disposed. The leases stay with their own owner and nothing is published; the
 * point is that the turn's uncertainty is a durable fact an operator or a
 * later reconciliation can read, rather than an in-memory receipt that dies
 * with this process.
 */
function persistUncertainty(session, reason, detail) {
  try {
    recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...session.identity,
      attemptId: session.snapshot.attemptId,
      reason,
      detail,
    });
    session.durableRecord = "unknown";
    return { uncertaintyPersisted: true, uncertaintyFailure: null };
  } catch (error) {
    return { uncertaintyPersisted: false, uncertaintyFailure: detailOf(error) };
  }
}

function unknownOutcome(session, reason, detail, extra = {}) {
  return Object.freeze({
    status: "unknown",
    terminalResult: null,
    published: false,
    agentReconciled: false,
    leasesReleased: session.leaseRelease?.outcome === "all",
    leaseRelease: session.leaseRelease,
    durableRecord: session.durableRecord,
    reason,
    detail,
    liveOwnershipCleared: session.liveOwnershipCleared,
    // Whether the durable mailbox barrier was applied, and what it moved. A
    // caller must be able to tell "later input queues for the next turn" from
    // "later input still binds to a turn nothing can deliver".
    liveOwnershipQuiesce: session.liveOwnershipQuiesce,
    ...sessionFacts(session),
    ...extra,
  });
}

/**
 * Every post-acceptance failure lands here: the exact uncertainty becomes
 * durable, leases stay wherever their own release outcome left them, nothing
 * is projected or published, and the live handle is disposed last.
 */
async function settleUnknown(session, reason, detail) {
  expireOwnControlDeadlines(session);
  // The durable mailbox barrier, before anything is disposed: this worker will
  // never deliver again, so later input must queue for the next turn rather
  // than bind to this one. The control stream stays open on purpose -- see
  // `quiesceOnUnknownExit()`.
  session.liveOwnershipQuiesce = quiesceOnUnknownExit(session);
  const uncertainty = persistUncertainty(session, reason, detail);
  const disposal = await disposeLiveTurn(session);
  return unknownOutcome(session, reason, detail, { ...uncertainty, ...disposal });
}

/**
 * The one settlement path, in one fixed durable order:
 *
 *   1. prove the evidence is publishable and names this exact native turn;
 *   2. atomically quiesce the Agent (durable live-ownership barrier, final
 *      mailbox sweep, late/undelivered entries requeued);
 *   3. settle and close this attempt's control stream (final control sweep);
 *   4. release every matching lease, with an exact release outcome;
 *   5. write the durable terminal version-three job record;
 *   6. project the Agent;
 *   7. publish the completion;
 *   8. dispose.
 *
 * Steps 2-5 are each fail-closed: anything that cannot be made durable becomes
 * a durable unknown instead, and nothing later in the order runs. From step 5
 * onward the terminal record exists, so a failure to project or publish is
 * recoverable by internal reconciliation rather than lost.
 */
async function settleTerminal(session, rawResult) {
  const { snapshot, launchClaim } = session;
  let normalizedResult;
  try {
    normalizedResult = validateNormalizedTerminalResult(rawResult, {
      driver: snapshot.driver,
      route: snapshot.route,
    });
  } catch (error) {
    return settleUnknown(session, "invalid_terminal_result", detailOf(error));
  }
  if (!sameNativeTurnRef(normalizedResult.nativeTurnRef, launchClaim.nativeTurnRef)) {
    return settleUnknown(
      session,
      "terminal_result_native_turn_mismatch",
      "The terminal result does not name the native turn this attempt durably accepted."
    );
  }
  const classification = classifyTurnSettlement(normalizedResult);
  if (!classification.publishable) {
    // Nothing is quiesced, released, projected, or published before this gate.
    return settleUnknown(session, classification.reason, "Terminal evidence is not publishable.");
  }

  // 2. Durable live-ownership barrier plus final mailbox sweep.
  try {
    quiesceLiveOwnership(session);
  } catch (error) {
    return settleUnknown(session, "live_ownership_not_quiesced", detailOf(error));
  }

  // 3. Final control sweep: settle every bound command, then close the stream.
  try {
    closeLiveControlOwnership(session, normalizedResult);
  } catch (error) {
    return settleUnknown(session, "control_stream_not_closed", detailOf(error));
  }

  // 4. Release every matching lease. The outcome is exact evidence, never a
  //    bare boolean: a mid-batch failure states what was and was not released.
  let release;
  try {
    release = releaseLeasesOnSettlement({
      normalizedTerminalResult: normalizedResult,
      releases: buildLeaseReleaseTargets(snapshot.leaseBindings),
    });
  } catch (error) {
    return settleUnknown(session, "lease_release_failed", detailOf(error));
  }
  session.leaseRelease = {
    outcome: release.outcome,
    releasedCount: release.releasedCount,
    alreadyReleasedCount: release.alreadyReleasedCount,
    retainedCount: release.retainedCount ?? 0,
    unknownCount: release.unknownCount ?? 0,
    failures: (release.failures ?? []).map((failure) => ({ ...failure })),
  };
  if (release.outcome !== "all") {
    return settleUnknown(
      session,
      `lease_release_${release.outcome}`,
      `Lease release outcome was ${release.outcome}; nothing may be published on partial admission evidence.`
    );
  }

  // 5. The durable terminal record. Everything after this point is a
  //    projection of a fact that already survives this process.
  const continuationProjection = classifyVersionThreeContinuation(normalizedResult, snapshot.route);
  const terminalJob = buildVersionThreeTerminalJob(snapshot, launchClaim, normalizedResult, continuationProjection);
  try {
    recordVersionThreeTurnTerminal({
      generation: FUTURE_WRITE_GENERATION,
      ...session.identity,
      attemptId: snapshot.attemptId,
      terminalJob,
    });
    session.durableRecord = "terminal";
  } catch (error) {
    return settleUnknown(session, "terminal_record_not_durable", detailOf(error));
  }

  // 6/7. Project the Agent, then publish the completion.
  let agentReconciled = false;
  let published = false;
  let publishReason = null;
  let publishFailure = null;
  try {
    agentReconciled = session.agentStore.finalizeFromJob(terminalJob).reconciled;
    const completion = reconcileTerminalJobCompletion(
      snapshot.canonicalWorkspaceRoot,
      snapshot.ownerRootId,
      terminalJob,
      // One owner for these options, shared with internal reconciliation, so a
      // completion published here and one published later from the same
      // durable record are the same event.
      versionThreeCompletionOptions(terminalJob),
    );
    published = completion.reconciled || completion.event != null;
    publishReason = completion.reason;
  } catch (error) {
    publishFailure = detailOf(error);
  }
  try {
    markVersionThreeTurnProjected({
      generation: FUTURE_WRITE_GENERATION,
      ...session.identity,
      agentProjected: agentReconciled,
      completionPublished: published,
    });
  } catch {
    // The marks are a reconciliation optimization; both projections are
    // idempotent, so an unmarked record is retried, never duplicated.
  }

  // 8. Dispose last. A disposal failure cannot erase what is already durable.
  const disposal = await disposeLiveTurn(session);

  if (publishFailure != null || !published) {
    // Settlement is proven and durable; only its projection is incomplete.
    // Internal reconciliation can finish it from the terminal record, so this
    // reports uncertainty about delivery, never a terminal a consumer could
    // treat as delivered.
    return Object.freeze({
      status: "unknown",
      terminalResult: normalizedResult,
      published,
      agentReconciled,
      leasesReleased: true,
      leaseRelease: session.leaseRelease,
      durableRecord: session.durableRecord,
      reason: "terminal_projection_failed",
      detail: publishFailure ?? publishReason,
      liveOwnershipCleared: true,
      liveOwnershipQuiesce: session.liveOwnershipQuiesce,
      continuation: continuationProjection,
      reconcilable: true,
      ...sessionFacts(session),
      ...disposal,
    });
  }
  return Object.freeze({
    status: normalizedResult.status,
    terminalResult: normalizedResult,
    published,
    publishReason,
    agentReconciled,
    leasesReleased: true,
    leaseRelease: session.leaseRelease,
    durableRecord: session.durableRecord,
    reason: "settled",
    detail: null,
    liveOwnershipCleared: true,
    liveOwnershipQuiesce: session.liveOwnershipQuiesce,
    continuation: continuationProjection,
    ...sessionFacts(session),
    ...disposal,
  });
}

/** One durable sweep: reread the mailbox and the control stream. */
async function sweepDurableState(session) {
  await deliverActiveInputs(session);
  await processControlCommands(session);
  expireOwnControlDeadlines(session);
}

async function runLiveTurn(session) {
  const { snapshot, liveTurn } = session;
  acknowledgePromptMessages(session);

  const resultWaiter = liveTurn.result
    .then((result) => ({ kind: "result", result }))
    .catch((error) => ({ kind: "result-error", error }));
  const abortWaiter = createAbortWaiter(snapshot.signal);

  try {
    while (true) {
      if (snapshot.signal?.aborted) {
        return await settleUnknown(session, "aborted", "The worker loop was aborted by its caller's signal.");
      }
      try {
        await sweepDurableState(session);
      } catch (error) {
        return await settleUnknown(session, "durable_sweep_failed", detailOf(error));
      }

      const wakeWaiter = createWakeWaiter(session);
      let raced;
      try {
        raced = await Promise.race([resultWaiter, wakeWaiter.promise, abortWaiter.promise]);
      } finally {
        // Cancel the losing waiter's watchers and timers immediately.
        wakeWaiter.dispose();
      }

      if (raced.kind === "aborted") {
        return await settleUnknown(session, "aborted", "The worker loop was aborted by its caller's signal.");
      }
      if (raced.kind === "result") {
        return await settleTerminal(session, raced.result);
      }
      if (raced.kind === "result-error") {
        return await settleUnknown(session, "driver_result_rejected", detailOf(raced.error));
      }
      // A wake is only a hint; the next iteration rereads durable state.
    }
  } finally {
    abortWaiter.dispose();
  }
}

/**
 * Run one version-three worker loop to completion.
 *
 * Returns a bounded disposition. On publishable terminal evidence, every
 * matching lease is released and the terminal version-three job and its
 * completion are published. On unknown, invalid, contradictory, aborted, or
 * failure-contained evidence, leases stay held, nothing is projected, and the
 * result names the exact reason.
 *
 * Only a failure before proven native acceptance -- caller input, route, or
 * the launch fence itself -- may throw.
 *
 * @param {*} input
 */
export async function runVersionThreeWorkerLoop(input) {
  const snapshot = snapshotWorkerLoopInput(input);

  // The launch core persists the claim, submission fence, and exact acceptance
  // proof before returning, and throws on every other classification. Every
  // path after this point treats the native turn as live and can no longer
  // fail by throwing.
  const { liveTurn, launchClaim } = await launchVersionThreeTurn(launchInputOf(snapshot));
  // Observe the native result before any pre-race durable setup can fail. A
  // worker may reject during `createSession()` or record creation, and that
  // early bailout still must not leave the original result promise unhandled.
  // The observer is deliberately side-effect free: `runLiveTurn()` retains
  // and consumes the exact original promise for normal semantic settlement.
  void Promise.resolve(liveTurn.result).catch(() => undefined);

  let session;
  try {
    session = createSession(snapshot, liveTurn, launchClaim);
  } catch (error) {
    // The durable owners this attempt needs could not even be resolved. Hold
    // every lease, publish nothing, and dispose the live handle last.
    let disposalFailure = null;
    try {
      await liveTurn.dispose();
    } catch (disposalError) {
      disposalFailure = detailOf(disposalError);
    }
    return Object.freeze({
      status: "unknown",
      terminalResult: null,
      published: false,
      agentReconciled: false,
      leasesReleased: false,
      reason: "durable_owner_unavailable",
      detail: detailOf(error),
      // No durable owner could be resolved, so no barrier was applied and this
      // Agent still advertises a live turn. Saying otherwise would claim a
      // durable transition that never happened.
      liveOwnershipCleared: false,
      liveOwnershipQuiesce: null,
      disposed: disposalFailure == null,
      disposalFailure,
    });
  }
  // The durable lifecycle record. It exists before the first mailbox
  // acknowledgement so that every later disposition -- terminal, unknown, or a
  // worker that simply disappears -- has a durable record to be written onto
  // or read from. Without it a settlement that cannot publish leaves nothing
  // any later pass could reconcile.
  try {
    recordVersionThreeTurnRunning({
      generation: FUTURE_WRITE_GENERATION,
      ownerRootId: snapshot.ownerRootId,
      agentId: snapshot.agentId,
      jobId: snapshot.jobId,
      attemptId: snapshot.attemptId,
      // The canonical root, not this worker's working directory: a later
      // reconciliation reopens the Agent store and completion inbox from it.
      workspaceRoot: snapshot.canonicalWorkspaceRoot,
      controlRoot: snapshot.canonicalWorkspaceRoot,
      executionRoot: snapshot.executionRoot,
      route: snapshot.route,
      nativeTurnRef: launchClaim.nativeTurnRef,
      worker: { pid: process.pid, identity: getProcessIdentity(process.pid) },
    });
    if (typeof liveTurn.subscribeProgress === "function") {
      session.progressUnsubscribe = liveTurn.subscribeProgress((progress) => {
        try {
          publishVersionThreeProgress({ generation: FUTURE_WRITE_GENERATION, ownerRootId: snapshot.ownerRootId,
            agentId: snapshot.agentId, jobId: snapshot.jobId, attemptId: snapshot.attemptId,
            progress: validateNativeProgress(progress) });
        } catch { /* advisory progress never changes turn settlement */ }
      });
    }
  } catch (error) {
    // Nothing durable can be recorded for this turn at all, so no uncertainty
    // record is possible either. Hold every lease, publish nothing, and say
    // exactly that -- but still stop advertising a live turn, because this
    // worker will never deliver anything for it. Nothing was acknowledged yet,
    // and the launch-prompt entries are retained rather than requeued, so the
    // barrier cannot replay input the Harness already has.
    const quiesce = quiesceOnUnknownExit(session);
    const disposal = await disposeLiveTurn(session);
    return Object.freeze({
      status: "unknown",
      terminalResult: null,
      published: false,
      agentReconciled: false,
      leasesReleased: false,
      leaseRelease: null,
      durableRecord: "unavailable",
      reason: "v3_job_record_unavailable",
      detail: detailOf(error),
      liveOwnershipCleared: session.liveOwnershipCleared,
      liveOwnershipQuiesce: quiesce,
      uncertaintyPersisted: false,
      ...sessionFacts(session),
      ...disposal,
    });
  }

  try {
    return await runLiveTurn(session);
  } catch (error) {
    // Nothing after proven acceptance may escape as an exception: an
    // unexpected internal failure is a durable unknown that holds its leases.
    return await settleUnknown(session, "internal_worker_failure", detailOf(error));
  }
}
