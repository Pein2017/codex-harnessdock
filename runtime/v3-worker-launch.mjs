/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Internal version-three Driver launch boundary.
 *
 * This module owns only replay-safe native acceptance. Mailbox
 * acknowledgement, active input/control, terminal publication, lease release,
 * reconciliation, and disposal remain later worker-loop responsibilities.
 */

import {
  assertDriverRouteCoherence,
  driverPreTransportRejection,
  isDriverPreTransportRejection,
  validateDriverV2,
  validateLiveHarnessTurn,
  validatePreparedTurn,
} from "./harness-contract.mjs";
import { createDriverScope } from "./harness-registry.mjs";
import {
  claimNativeSubmissionStartAsync,
  recordLaunchAcceptanceProvenAsync,
  recordLaunchAcceptanceRejectedAsync,
  recordLaunchAcceptanceUnknownAsync,
  verifyPreparedLaunchClaim,
} from "./launch-claim.mjs";
import { validateVersionThreeRoute } from "./durable-state-v3.mjs";
import { validateNativeReferenceEnvelope } from "./native-reference.mjs";
import { plainDataTree, plainRecordSnapshot } from "./plain-record.mjs";
import { types } from "node:util";

/**
 * Turn options are an opaque, bounded, Driver-owned bag. The generic core
 * canonicalizes and compares them; only the owning Driver knows what any field
 * inside means, and no generic path may branch on one.
 */
const MAX_TURN_OPTIONS_DEPTH = 1;

/** A native reference envelope is a flat record holding one flat locator. */
const MAX_NATIVE_REFERENCE_DEPTH = 2;

const LAUNCH_INPUT_FIELDS = Object.freeze([
  "agentId",
  "assignedInputs",
  "assignedMessageIds",
  "attemptId",
  "deadlineAt",
  "driver",
  "env",
  "jobId",
  "leaseBindings",
  "nativeSessionRef",
  "ownerRootId",
  "preparedInput",
  "preparedTurn",
  "route",
  "signal",
  "turnOptions",
  "workspaceRoot",
]);

/**
 * The closed Driver proof that `startTurn()` rejected before any request
 * crossed its native transport boundary. It is owned by the Driver contract so
 * a Driver can make the proof without importing this launch module; it is
 * re-exported here because this is the only place that consumes it.
 */
export { driverPreTransportRejection };

function launchFailure(error, acceptance, { acceptancePersisted = true, persistenceError = null } = {}) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return Object.assign(
    new Error(`Version-three Driver launch failed with ${acceptance}: ${cause.message}`, { cause }),
    {
      code: "v3_driver_launch_failed",
      acceptance,
      acceptancePersisted,
      persistenceError: persistenceError instanceof Error ? persistenceError : null,
    }
  );
}

/**
 * The comparison text one bounded turn-option bag has. It is deliberately not
 * `JSON.stringify` of the raw value: `null` gets its own reserved text, so a
 * launch that states nothing can never compare equal to one that states a bag.
 */
function canonicalTurnOptionsText(value) {
  return value == null ? "none" : `stated\0${JSON.stringify(value)}`;
}

function claimIdentity(snapshot) {
  return {
    ownerRootId: snapshot.ownerRootId,
    agentId: snapshot.agentId,
    jobId: snapshot.jobId,
    attemptId: snapshot.attemptId,
  };
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

/** @returns {Readonly<Record<string, *>>} */
function snapshotLaunchInput(input) {
  const snapshot = plainRecordSnapshot(input, "Version-three worker launch input");
  for (const field of Object.keys(snapshot)) {
    if (!LAUNCH_INPUT_FIELDS.includes(field)) {
      throw new Error(`Version-three worker launch input declares an unsupported field: ${field}.`);
    }
  }
  for (const field of [
    "ownerRootId", "agentId", "jobId", "attemptId", "route", "driver", "preparedTurn",
    "preparedInput", "assignedMessageIds", "leaseBindings", "workspaceRoot",
    // Stated, not necessarily non-empty: a route whose Driver owns no turn
    // options states `null`. Omission is refused so no attempt is ever
    // claimed, digested, or submitted under options nobody declared.
    "turnOptions",
  ]) {
    if (!Object.hasOwn(snapshot, field)) {
      throw new Error(`Version-three worker launch input requires ${field}.`);
    }
  }
  /** @type {Record<string, *>} */
  const stable = {
    ...snapshot,
    preparedTurn: plainDataTree(snapshot.preparedTurn, "Version-three worker preparedTurn", 6),
    // Turn options and the optional continuation reference are canonicalized
    // once here, before anything reads them. Every later read -- the TOCTOU
    // fence, the DriverScope, and the Driver's own validator -- sees this one
    // detached snapshot, never the caller's object.
    turnOptions: snapshot.turnOptions == null
      ? null
      : plainDataTree(snapshot.turnOptions, "Version-three worker turnOptions", MAX_TURN_OPTIONS_DEPTH),
    nativeSessionRef: snapshot.nativeSessionRef == null
      ? null
      : plainDataTree(snapshot.nativeSessionRef, "Version-three worker nativeSessionRef", MAX_NATIVE_REFERENCE_DEPTH),
    assignedMessageIds: snapshotArray(snapshot.assignedMessageIds, "Version-three worker assignedMessageIds"),
    leaseBindings: snapshotArray(snapshot.leaseBindings, "Version-three worker leaseBindings"),
    assignedInputs: snapshot.assignedInputs == null
      ? Object.freeze([])
      : snapshotArray(snapshot.assignedInputs, "Version-three worker assignedInputs"),
  };
  return Object.freeze(stable);
}

function replayAcceptance(record) {
  if (record.acceptance === "not_submitted" && record.submissionState === "started") {
    return { acceptance: "acceptance_unknown", acceptancePersisted: false };
  }
  return { acceptance: record.acceptance, acceptancePersisted: record.acceptance !== "not_submitted" };
}

async function persistPostSubmissionFailure(identity, error, acceptance) {
  const recorder = acceptance === "acceptance_rejected"
    ? recordLaunchAcceptanceRejectedAsync
    : recordLaunchAcceptanceUnknownAsync;
  try {
    await recorder({
      ...identity,
      sanitizedDetail: acceptance === "acceptance_rejected"
        ? "driver_pre_transport_rejection"
        : "native_acceptance_not_durably_proven",
    });
    return launchFailure(error, acceptance);
  } catch (persistenceError) {
    // The submission-start fence remains durable and rollback-unsafe even when
    // storage is unavailable. Preserve the original native failure as `cause`
    // and expose that the semantic classification could not itself be written.
    return launchFailure(error, acceptance, { acceptancePersisted: false, persistenceError });
  }
}

function assertDriverOwnsRoute(driver, route) {
  validateDriverV2(driver);
  if (driver.harnessId !== route.harnessId || driver.driverVersion !== route.driverVersion) {
    throw new Error(
      `Version-three route belongs to ${route.harnessId}/${route.driverVersion}, not selected Driver ` +
      `${driver.harnessId}/${driver.driverVersion}.`
    );
  }
  assertDriverRouteCoherence(driver, route.capabilities);
}

/**
 * Revalidate and launch exactly one version-three native turn.
 *
 * A durable claim and the atomic submission-start winner exist before
 * `Driver.startTurn()`. Every path after that call begins records either
 * rejected, unknown, or exact proven acceptance before returning/throwing.
 * A replay that observes an already-started claim stops before the Driver.
 */
export async function launchVersionThreeTurn(input) {
  const snapshot = snapshotLaunchInput(input);
  if (snapshot.assignedInputs.length > 0) {
    throw new Error(
      "Version-three initial launch does not accept active assignedInputs; Task 5.4B must bind and deliver them after proven native acceptance."
    );
  }
  const route = validateVersionThreeRoute(snapshot.route, "Version-three worker route");
  const driver = snapshot.driver;
  assertDriverOwnsRoute(driver, route);
  const preparedTurn = validatePreparedTurn(snapshot.preparedTurn, {
    driver,
    route,
    taskInput: snapshot.preparedInput,
  });
  // Stated turn options are bound to the prepared evidence before anything
  // durable exists. The generic core never reads inside the bag; it only
  // proves that the bag this launch carries is byte-identical to the one the
  // Driver's own prepared turn committed to -- including stated-versus-absent,
  // which are two different launches, never one with a default filled in.
  const turnOptions = snapshot.turnOptions ?? null;
  const preparedTurnOptions = preparedTurn.turnOptions ?? null;
  if (canonicalTurnOptionsText(turnOptions) !== canonicalTurnOptionsText(preparedTurnOptions)) {
    throw launchFailure(
      new Error(
        "The version-three launch states turn options its prepared turn did not bind; " +
        "a prepared turn is never reused for different Driver-owned turn options."
      ),
      "not_submitted",
      { acceptancePersisted: false }
    );
  }
  // An optional continuation reference is proven to be this Driver's own, for
  // this exact route, and to be a session reference -- never a turn reference
  // standing in for one -- before it can become a resume request.
  let nativeSessionRef = null;
  if (snapshot.nativeSessionRef != null) {
    try {
      nativeSessionRef = validateNativeReferenceEnvelope(snapshot.nativeSessionRef, {
        driver,
        kind: "session",
        route,
      });
    } catch (error) {
      throw launchFailure(error, "not_submitted", { acceptancePersisted: false });
    }
  }
  const scope = createDriverScope({
    driver,
    purpose: "turn",
    rootId: snapshot.ownerRootId,
    agentId: snapshot.agentId,
    turnId: snapshot.jobId,
    attemptId: snapshot.attemptId,
    route,
    taskInput: snapshot.preparedInput,
    turnOptions,
    assignedInputs: snapshot.assignedInputs,
    workspaceRoot: snapshot.workspaceRoot,
    deadlineAt: snapshot.deadlineAt ?? null,
    signal: snapshot.signal ?? null,
    env: snapshot.env ?? {},
  });

  // The parent already bound the exact lease and mailbox activation before it
  // detached us. A worker consumes that claim; it never reacquires/recreates.
  const identity = claimIdentity(snapshot);
  const created = verifyPreparedLaunchClaim({
    ...identity,
    route,
    assignedMessageIds: snapshot.assignedMessageIds,
    preparedInput: snapshot.preparedInput,
    turnOptions,
  });
  if (created.acceptance !== "not_submitted" || created.submissionState !== "not_started") {
    const replay = replayAcceptance(created);
    throw launchFailure(
      new Error("The durable launch attempt already crossed its native-submission fence and cannot be replayed."),
      replay.acceptance,
      { acceptancePersisted: replay.acceptancePersisted }
    );
  }

  // Readiness/route revalidation is not native submission. Its failure leaves
  // this durable claim eligible for the handoff owner's fenced rollback.
  let launchContext;
  try {
    launchContext = await driver.revalidatePreparedTurn(preparedTurn, scope);
  } catch (error) {
    throw launchFailure(error, "not_submitted", { acceptancePersisted: false });
  }
  const submission = await claimNativeSubmissionStartAsync(identity);
  if (!submission.started) {
    const replay = replayAcceptance(submission.record);
    throw launchFailure(
      new Error("Another worker already owns this attempt's native-submission start."),
      replay.acceptance,
      { acceptancePersisted: replay.acceptancePersisted }
    );
  }

  let liveTurn;
  try {
    const rawLiveTurn = await driver.startTurn({
      scope,
      preparedTurn,
      launchContext,
      ...(nativeSessionRef == null ? {} : { nativeSessionRef }),
    });
    liveTurn = validateLiveHarnessTurn(rawLiveTurn, { driver, route });
    const launchClaim = await recordLaunchAcceptanceProvenAsync({
      ...identity,
      liveHarnessTurn: liveTurn,
    });
    return Object.freeze({ liveTurn, launchClaim });
  } catch (error) {
    if (isDriverPreTransportRejection(error)) {
      throw await persistPostSubmissionFailure(identity, error, "acceptance_rejected");
    }

    // `startTurn()` may have reached the Harness, or it may have returned a
    // live handle whose exact reference could not become durable. Neither is
    // replayable. The launch-claim lattice itself refuses any attempted
    // regression if proven persistence already won.
    throw await persistPostSubmissionFailure(identity, error, "acceptance_unknown");
  }
}
