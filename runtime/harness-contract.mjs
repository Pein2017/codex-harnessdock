/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The internal Harness Driver contract.
 *
 * The boundary is one complete turn. A Driver owns its executable, native
 * configuration, route validation, transport, protocol parsing, in-turn
 * recovery, native session evidence, compatibility, and failure classification.
 * The shared supervisor owns Agent identity, mailbox, jobs, leases, completion
 * delivery, wait budgets, retention, and reconciliation, and never requires
 * token-level or tool-schema parity between Harnesses.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";

import {
  CAPABILITY_MATURITY_VALUES,
  ROUTE_CAPABILITY_SCHEMA_VERSION,
  assertAdmittedInteraction,
  validateHarnessCapabilities,
  validateRouteCapabilityProvenance,
  validateRouteCapabilitySnapshot,
} from "./harness-capabilities.mjs";
import { assertHarnessTurnFailureClass } from "./harness-failure-classes.mjs";
import { validateNativeReferenceEnvelope } from "./native-reference.mjs";
import { plainDataTree } from "./plain-record.mjs";
import { normalizeTerminalMetrics } from "./terminal-metrics.mjs";
// The four turn axes have one owner: `runtime/turn-settlement.mjs` both
// defines what each axis may say and decides which of its combinations may
// publish a completion. Restating those values here would let the normalized
// schema and the publication predicate drift apart silently.
import {
  CONTINUATION_MODES,
  EXECUTION_CONTINUITY_VALUES,
  NORMALIZED_SETTLEMENT_VALUES,
  TURN_STATUS_VALUES,
} from "./turn-settlement.mjs";

export const HARNESS_DRIVER_CONTRACT_VERSION = 1;

/**
 * Every valid version-1 durable record predates Harness identity and is
 * interpreted as this Harness. The constant lives here, not in the Driver, so
 * durable state can be read without loading a Driver implementation.
 */
export const V1_HARNESS_ID = "claude-code";

/** Coarse turn-level operations every admitted Driver must implement. */
export const HARNESS_DRIVER_OPERATIONS = Object.freeze([
  "preflight",
  "describeUnreadiness",
  "validatePreparedPreflight",
  "revalidatePreparedPreflight",
  "validateRoute",
  "resolveInstanceKey",
  "startTurn",
  "assignInput",
  "interruptTurn",
  "cancelTurn",
]);

/** Operations a Driver provides only when its capability snapshot admits them. */
export const HARNESS_DRIVER_OPTIONAL_OPERATIONS = Object.freeze([
  "readAssistantHistory",
]);

const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const TURN_STATUSES = new Set(["completed", "failed", "interrupted", "unknown"]);
export const MAX_DRIVER_RECEIPT_BYTES = 16 * 1024;
export const NATIVE_PROGRESS_ACTIVITIES = Object.freeze(["thinking", "responding", "tool", "retrying", "reconnecting"]);
export const MAX_NATIVE_PROGRESS_TOOL_NAME_BYTES = 80;
const NATIVE_PROGRESS_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Validate the sole Driver-to-supervisor activity shape. */
export function validateNativeProgress(value, label = "Native progress") {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new Error(`${label} must be a plain progress object.`);
  }
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "activity" || key === "toolName")) {
    throw new Error(`${label} declares an unknown field.`);
  }
  if (!NATIVE_PROGRESS_ACTIVITIES.includes(value.activity)) {
    throw new Error(`${label} has unsupported activity.`);
  }
  if (value.toolName != null && (typeof value.toolName !== "string" ||
      !NATIVE_PROGRESS_TOOL_NAME_PATTERN.test(value.toolName) ||
      Buffer.byteLength(value.toolName, "utf8") > MAX_NATIVE_PROGRESS_TOOL_NAME_BYTES)) {
    throw new Error(`${label} has an unsafe tool name.`);
  }
  return Object.freeze({ activity: value.activity, toolName: value.toolName ?? null });
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be non-empty text.`);
  }
  return value.trim();
}

export function assertHarnessId(value) {
  const harnessId = assertText(value, "Harness ID");
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    throw new Error(`Invalid Harness ID: ${harnessId}.`);
  }
  return harnessId;
}

/**
 * The neutral durable reference to one native Harness session. `instanceKey`
 * is the Driver-derived minimum stable native configuration identity required
 * to keep two Harness instances from claiming the same logical session.
 */
export function canonicalNativeSessionRef(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Native session reference must be an object.");
  }
  const harnessId = assertHarnessId(reference.harnessId);
  const instanceKey = assertText(reference.instanceKey, "Harness instance key");
  const nativeSessionId = assertText(reference.nativeSessionId, "native session ID");
  if (!NATIVE_SESSION_ID_PATTERN.test(nativeSessionId)) {
    throw new Error(`Invalid native session ID for ${harnessId}: ${nativeSessionId}.`);
  }
  return Object.freeze({ harnessId, instanceKey, nativeSessionId });
}

/**
 * Canonical ownership key for durable session bindings and active leases.
 *
 * The `claude-code` branch reproduces the pre-Harness `(config dir, session)`
 * digest byte for byte. That compatibility is a correctness boundary, not
 * convenience: a runtime that predates version-2 state derives the same key, so
 * it still observes an active lease instead of stealing the live session. Any
 * later Harness is namespaced by its ID and therefore cannot collide even when
 * it reports the same native session ID text.
 */
export function harnessSessionKey(reference) {
  const { harnessId, instanceKey, nativeSessionId } = canonicalNativeSessionRef(reference);
  const material = harnessId === V1_HARNESS_ID
    ? `${instanceKey}\0${nativeSessionId}`
    : `${harnessId}\0${instanceKey}\0${nativeSessionId}`;
  return createHash("sha256").update(material).digest("hex");
}

export function sameNativeSessionRef(left, right) {
  if (!left || !right) return false;
  return left.harnessId === right.harnessId &&
    left.instanceKey === right.instanceKey &&
    left.nativeSessionId === right.nativeSessionId;
}

/**
 * Driver receipts stay opaque to the supervisor. They are bounded and
 * versioned, and are never the sole evidence for signalling, ownership, or
 * continuation decisions.
 */
export function boundedDriverReceipt(harnessId, driverVersion, receipt) {
  const payload = {
    harnessId: assertHarnessId(harnessId),
    driverVersion: assertText(driverVersion, "Driver version"),
    receipt: receipt ?? null,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_DRIVER_RECEIPT_BYTES) {
    return {
      harnessId: payload.harnessId,
      driverVersion: payload.driverVersion,
      receipt: null,
      omitted: "driver_receipt_exceeded_bound",
    };
  }
  return payload;
}

/**
 * Validate the one normalized terminal result a Driver returns for a complete
 * turn. Native protocol detail may accompany the result for Driver-local
 * diagnostics, but the shared supervisor never reads it.
 */
export function validateHarnessTurnResult(result, driver) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Harness turn result must be an object.");
  }
  if (result.harnessId !== driver.harnessId) {
    throw new Error(
      `Harness turn result declares ${result.harnessId}; expected ${driver.harnessId}.`
    );
  }
  if (result.driverVersion !== driver.driverVersion) {
    throw new Error("Harness turn result declares a foreign Driver version.");
  }
  if (result.contractVersion !== HARNESS_DRIVER_CONTRACT_VERSION) {
    throw new Error(
      `Harness turn result implements contract ${result.contractVersion}; ` +
      `this runtime requires ${HARNESS_DRIVER_CONTRACT_VERSION}.`
    );
  }
  if (!TURN_STATUSES.has(result.status)) {
    throw new Error(`Unsupported Harness turn status: ${result.status}.`);
  }
  if (!Number.isInteger(result.exitStatus)) {
    throw new Error("Harness turn result must carry an integer exit status.");
  }
  if (
    (result.status === "completed" && result.exitStatus !== 0) ||
    (result.status !== "completed" && result.exitStatus === 0)
  ) {
    throw new Error("Harness turn status and exit status are inconsistent.");
  }
  if (result.nativeSession != null) {
    const nativeSession = canonicalNativeSessionRef(result.nativeSession);
    if (nativeSession.harnessId !== driver.harnessId) {
      throw new Error(
        `Harness turn native session belongs to Harness ${nativeSession.harnessId}; ` +
        `expected ${driver.harnessId}.`
      );
    }
  }
  // Continuation and interruption evidence is exactly this triple: the exact
  // native session target, whether transport replay is safe, and the failure
  // class. Opaque Driver receipts never stand alone as that proof.
  if (!["exact", "unproven"].includes(result.sessionExactness)) {
    throw new Error("Harness turn result must classify native session exactness.");
  }
  if (result.sessionExactness === "exact" && result.nativeSession == null) {
    throw new Error("Exact native session evidence requires a native session reference.");
  }
  const failure = result.failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) {
    throw new Error("Harness turn result must carry a failure classification object.");
  }
  if (result.status === "completed" && failure.class != null) {
    throw new Error("A completed Harness turn must not classify a failure.");
  }
  if (result.status !== "completed") {
    if (typeof failure.class !== "string" || !failure.class.trim()) {
      throw new Error("A non-completed Harness turn must classify its failure.");
    }
    // The empty/missing case above keeps its own message; a non-empty but
    // unadmitted or free-text class is rejected here, before it becomes
    // durable continuation evidence or a model-facing receipt.
    assertHarnessTurnFailureClass(failure.class, `Harness turn result for ${driver.harnessId}`);
  }
  if (typeof failure.resumable !== "boolean") {
    throw new Error("Harness failure classification must state transport resumability.");
  }
  if (result.finalMessage == null && !result.finalMessageAbsenceReason) {
    throw new Error(
      "Harness turn result must carry a final outer-assistant message or an explicit absence reason."
    );
  }
  if (result.finalMessage != null && typeof result.finalMessage !== "string") {
    throw new Error("Harness turn final message must be text when present.");
  }
  if (
    result.finalMessageAbsenceReason != null &&
    (typeof result.finalMessageAbsenceReason !== "string" || !result.finalMessageAbsenceReason.trim())
  ) {
    throw new Error("Harness turn final-message absence reason must be non-empty text.");
  }
  if (!result.process || typeof result.process !== "object") {
    throw new Error("Harness turn result must carry process acceptance evidence.");
  }
  if (
    typeof result.process.spawnAccepted !== "boolean" ||
    typeof result.process.identityProven !== "boolean"
  ) {
    throw new Error("Harness turn process evidence must classify spawn acceptance and identity.");
  }
  if (!result.receipts || typeof result.receipts !== "object") {
    throw new Error("Harness turn result must carry bounded activity receipts.");
  }
  const normalizedMetrics = result.metrics == null ? null : normalizeTerminalMetrics(result.metrics);
  if (result.metrics != null && normalizedMetrics == null) {
    throw new Error("Harness turn metrics must use the closed version-one schema.");
  }
  if (result.runtime != null && (typeof result.runtime !== "object" || Array.isArray(result.runtime))) {
    throw new Error("Harness turn runtime evidence must be an object when present.");
  }
  if (result.driverReceipt != null) {
    if (typeof result.driverReceipt !== "object" || Array.isArray(result.driverReceipt)) {
      throw new Error("Harness turn Driver receipt must be an object when present.");
    }
    if (
      result.driverReceipt.harnessId !== driver.harnessId ||
      result.driverReceipt.driverVersion !== driver.driverVersion
    ) {
      throw new Error("Harness turn Driver receipt belongs to a foreign Driver contract.");
    }
    if (JSON.stringify(result.driverReceipt).length > MAX_DRIVER_RECEIPT_BYTES) {
      throw new Error("Harness turn Driver receipt exceeds its durable bound.");
    }
  }
  return result.metrics == null ? result : { ...result, metrics: normalizedMetrics };
}

/**
 * Validate a Driver module resolved from the static registry. This runs at
 * composition time so an incomplete or mislabelled Driver fails before any
 * durable Agent, lease, or native process exists.
 */
export function validateHarnessDriver(driver) {
  if (!driver || typeof driver !== "object") {
    throw new Error("A Harness Driver must be an object.");
  }
  assertHarnessId(driver.harnessId);
  assertText(driver.driverVersion, "Driver version");
  if (driver.contractVersion !== HARNESS_DRIVER_CONTRACT_VERSION) {
    throw new Error(
      `Harness Driver ${driver.harnessId} implements contract ${driver.contractVersion}; ` +
      `this runtime requires ${HARNESS_DRIVER_CONTRACT_VERSION}.`
    );
  }
  const capabilities = validateHarnessCapabilities(
    driver.capabilities,
    `Harness Driver ${driver.harnessId} capability snapshot`
  );
  for (const operation of HARNESS_DRIVER_OPERATIONS) {
    if (typeof driver[operation] !== "function") {
      throw new Error(`Harness Driver ${driver.harnessId} does not implement ${operation}.`);
    }
  }
  if (
    capabilities.history === "assistant_messages" &&
    typeof driver.readAssistantHistory !== "function"
  ) {
    throw new Error(
      `Harness Driver ${driver.harnessId} claims assistant history without implementing it.`
    );
  }
  return driver;
}

/**
 * Driver Contract v2.
 *
 * Version one is not a subset of version two. Its universal integer exit
 * status, `{spawnAccepted, identityProven}` evidence, PID interruption, and
 * blocking `startTurn()` result encode exactly one Harness, so a Driver that
 * still implements them is refused rather than adapted. Version two moves the
 * turn boundary to a process-local live handle and keeps every native fact
 * behind Driver-owned validators.
 *
 * The version-one surface above stays exported until the Claude Driver is
 * wrapped in version two; both generations are validated independently and
 * neither downgrades the other.
 */
export const DRIVER_CONTRACT_VERSION_V2 = 2;

/** Operations every admitted version-two Driver implements. */
export const DRIVER_V2_OPERATIONS = Object.freeze([
  "describe",
  "inspectInstances",
  "validateRoute",
  "prepareTurn",
  "revalidatePreparedTurn",
  "validateNativeSessionRef",
  "validateNativeTurnRef",
  "startTurn",
]);

/** Operations a Driver implements only for the routes whose snapshot admits them. */
export const DRIVER_V2_OPTIONAL_OPERATIONS = Object.freeze([
  "observeTurn",
  "readAssistantHistory",
]);

/**
 * The closed capability each optional operation implements. The check is
 * one-directional on purpose: an admitted capability requires its method, while
 * an implemented method on an unadmitted route is simply never invoked, because
 * one Driver may serve observable and unobservable instances at once.
 */
const DRIVER_V2_CAPABILITY_METHODS = Object.freeze({
  observeTurn: Object.freeze({ capability: "turnObservation", admitted: Object.freeze(["terminal_observable"]) }),
  readAssistantHistory: Object.freeze({ capability: "history", admitted: Object.freeze(["assistant_messages"]) }),
});

/**
 * The description each Driver was admitted with, keyed by the Driver object
 * itself. It is process-local, checkout-owned, and holds nothing but the frozen
 * validated metadata: after admission every consumer reads this snapshot, so a
 * later `describe()` call can never widen a Driver's environment view or
 * maturity behind the supervisor's back.
 */
const ADMITTED_DRIVER_DESCRIPTIONS = new WeakMap();

export const DRIVER_DESCRIPTION_FIELDS = Object.freeze([
  "capabilitySchemaVersion",
  "contractVersion",
  "driverVersion",
  "environmentKeys",
  "harnessId",
  "maturity",
  "title",
]);

/**
 * Everything a Driver may add around the caller's task text. Decomposition,
 * methodology, worker conflict policy, and final synthesis stay with Codex.
 */
export const PROMPT_ENVELOPE_FIELDS = Object.freeze([
  "authority",
  "returnContract",
  "taskInput",
  "topology",
]);

const ENVIRONMENT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const CREDENTIAL_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|APIKEY|API_KEY|_KEY|AUTH)/;
const MAX_ENVIRONMENT_KEYS = 16;
const MAX_DESCRIPTION_TITLE = 120;
const MAX_PROMPT_ENVELOPE_FACT = 4096;
/** A turn option bag is small by construction (e.g. one effort enum). */
const MAX_TURN_OPTIONS_BYTES = 1024;
const MAX_TURN_OPTIONS_DEPTH = 2;

/**
 * Validate the static metadata a Driver publishes about itself. It is read
 * before any instance inspection, so it may not name an endpoint, credential,
 * module path, or anything else that would let configuration select behavior.
 */
export function validateDriverDescription(description, driver) {
  const label = `Harness Driver ${driver.harnessId} description`;
  if (!description || typeof description !== "object" || Array.isArray(description)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(description)) {
    if (!DRIVER_DESCRIPTION_FIELDS.includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
  }
  if (description.harnessId !== driver.harnessId) {
    throw new Error(
      `Harness Driver ${driver.harnessId} describes Harness ${JSON.stringify(description.harnessId ?? null)}.`
    );
  }
  if (description.driverVersion !== driver.driverVersion) {
    throw new Error(`${label} declares a foreign Driver version.`);
  }
  if (description.contractVersion !== DRIVER_CONTRACT_VERSION_V2) {
    throw new Error(`${label} declares a foreign contract version.`);
  }
  if (description.capabilitySchemaVersion !== ROUTE_CAPABILITY_SCHEMA_VERSION) {
    throw new Error(`${label} declares a foreign capability schema version.`);
  }
  if (!CAPABILITY_MATURITY_VALUES.includes(description.maturity)) {
    throw new Error(
      `${label} has an unsupported maturity: ${JSON.stringify(description.maturity ?? null)}.`
    );
  }
  const title = assertText(description.title, `${label} title`);
  if (title.length > MAX_DESCRIPTION_TITLE) {
    throw new Error(`${label} title exceeds ${MAX_DESCRIPTION_TITLE} characters.`);
  }
  const environmentKeys = description.environmentKeys ?? [];
  if (!Array.isArray(environmentKeys) || environmentKeys.length > MAX_ENVIRONMENT_KEYS) {
    throw new Error(`${label} must declare at most ${MAX_ENVIRONMENT_KEYS} environment keys as an array.`);
  }
  for (const key of environmentKeys) {
    if (typeof key !== "string" || !ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new Error(`${label} declares an invalid environment key: ${JSON.stringify(key ?? null)}.`);
    }
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Harness Driver ${driver.harnessId} declares an environment key ${key} that names a credential; ` +
        `authentication material belongs to fixed Driver configuration, not the Driver scope.`
      );
    }
  }
  return Object.freeze({
    harnessId: description.harnessId,
    driverVersion: description.driverVersion,
    contractVersion: DRIVER_CONTRACT_VERSION_V2,
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    maturity: description.maturity,
    title,
    environmentKeys: Object.freeze([...environmentKeys]),
  });
}

/**
 * Validate a version-two Driver at composition time, before readiness, durable
 * Agent mutation, or any native execution.
 */
export function validateDriverV2(driver) {
  if (!driver || typeof driver !== "object") {
    throw new Error("A Harness Driver must be an object.");
  }
  assertHarnessId(driver.harnessId);
  assertText(driver.driverVersion, "Driver version");
  if (driver.contractVersion !== DRIVER_CONTRACT_VERSION_V2) {
    throw new Error(
      `Harness Driver ${driver.harnessId} implements Driver Contract ` +
      `${JSON.stringify(driver.contractVersion ?? null)}; this runtime requires Driver Contract ` +
      `${DRIVER_CONTRACT_VERSION_V2}.`
    );
  }
  for (const operation of DRIVER_V2_OPERATIONS) {
    if (typeof driver[operation] !== "function") {
      throw new Error(`Harness Driver ${driver.harnessId} does not implement ${operation}.`);
    }
  }
  for (const operation of DRIVER_V2_OPTIONAL_OPERATIONS) {
    if (driver[operation] != null && typeof driver[operation] !== "function") {
      throw new Error(`Harness Driver ${driver.harnessId} declares ${operation} as a non-function.`);
    }
  }
  // `describe()` is pure static metadata. It takes no scope, so it cannot read
  // a service, and two calls must agree, so it cannot depend on ambient state.
  if (driver.describe.length !== 0) {
    throw new Error(
      `Harness Driver ${driver.harnessId} describe() must take no arguments: static metadata never receives a scope.`
    );
  }
  const description = validateDriverDescription(driver.describe(), driver);
  const repeated = validateDriverDescription(driver.describe(), driver);
  const previous = ADMITTED_DRIVER_DESCRIPTIONS.get(driver);
  if (
    JSON.stringify(repeated) !== JSON.stringify(description) ||
    (previous && JSON.stringify(previous) !== JSON.stringify(description))
  ) {
    throw new Error(
      `Harness Driver ${driver.harnessId} describe() must be static: two calls returned different metadata.`
    );
  }
  ADMITTED_DRIVER_DESCRIPTIONS.set(driver, description);
  return driver;
}

/**
 * The frozen description a Driver was admitted with, admitting it on first use.
 * Every consumer of static Driver metadata reads this, never `describe()`.
 */
export function admittedDriverDescription(driver) {
  const cached = ADMITTED_DRIVER_DESCRIPTIONS.get(driver);
  if (cached) return cached;
  validateDriverV2(driver);
  return ADMITTED_DRIVER_DESCRIPTIONS.get(driver);
}

/**
 * Every capability the accepted route admits must have its implementing method.
 * A route that does not admit an operation is refused at its call site instead.
 */
export function assertDriverRouteCoherence(driver, capabilities) {
  const snapshot = validateRouteCapabilitySnapshot(
    capabilities,
    `Harness Driver ${driver?.harnessId} route capability snapshot`
  );
  for (const [method, { capability, admitted }] of Object.entries(DRIVER_V2_CAPABILITY_METHODS)) {
    const value = snapshot.values[capability];
    if (admitted.includes(value) && typeof driver[method] !== "function") {
      throw new Error(
        `Harness Driver ${driver.harnessId} claims ${capability}=${value} without implementing ${method}.`
      );
    }
  }
  return snapshot;
}

/**
 * Validate one prepared turn. The Driver may translate immutable authority and
 * topology facts and ask for one bounded outer-assistant result; it may not
 * rewrite the caller's task or add a second scheduling policy.
 */
export function validatePreparedTurn(prepared, { driver, route, taskInput }) {
  const label = `Harness Driver ${driver.harnessId} prepared turn`;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new Error(`${label} must be an object.`);
  }
  if (prepared.harnessId !== driver.harnessId || prepared.driverVersion !== driver.driverVersion) {
    throw new Error(`${label} belongs to a foreign Driver contract.`);
  }
  for (const field of ["harnessId", "instanceKey", "model", "topology", "authority", "effort", "driverVersion"]) {
    if (prepared.route?.[field] !== route[field]) {
      throw new Error(`${label} declares a ${field} that is not the accepted route's.`);
    }
  }
  // A prepared turn is never a second place to declare authority: the Driver's
  // snapshot must equal the accepted one exactly, and the accepted frozen route
  // is what travels onward.
  const acceptedCapabilities = validateRouteCapabilitySnapshot(
    route.capabilities,
    `${label} accepted route capability snapshot`
  );
  const declaredCapabilities = validateRouteCapabilitySnapshot(
    prepared.route?.capabilities,
    `${label} route capability snapshot`
  );
  if (JSON.stringify(declaredCapabilities) !== JSON.stringify(acceptedCapabilities)) {
    throw new Error(`${label} declares a capability snapshot that is not the accepted route's.`);
  }
  const envelope = prepared.promptEnvelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(`${label} must carry a prompt envelope object.`);
  }
  for (const key of Object.keys(envelope)) {
    if (!PROMPT_ENVELOPE_FIELDS.includes(key)) {
      throw new Error(
        `Harness Driver ${driver.harnessId} prompt envelope declares an unknown field: ${key}. ` +
        `A Driver adds only authority, topology, and a bounded return contract around the caller task.`
      );
    }
  }
  if (envelope.taskInput !== taskInput) {
    throw new Error(
      `Harness Driver ${driver.harnessId} prompt envelope must carry the caller task input unchanged.`
    );
  }
  for (const field of ["authority", "topology", "returnContract"]) {
    const value = assertText(envelope[field], `${label} ${field}`);
    if (value.length > MAX_PROMPT_ENVELOPE_FACT) {
      throw new Error(`${label} ${field} exceeds ${MAX_PROMPT_ENVELOPE_FACT} characters.`);
    }
  }
  assertText(prepared.inputDigest, `${label} input digest`);
  // Turn options are a small closed generic seam: the core bounds and
  // canonicalizes the bag as trap-free plain data, but never interprets its
  // fields. Only the owning Driver's own validator knows what "effort" means.
  let turnOptions = null;
  if (Object.hasOwn(prepared, "turnOptions") && prepared.turnOptions != null) {
    turnOptions = plainDataTree(prepared.turnOptions, `${label} turn options`, MAX_TURN_OPTIONS_DEPTH);
    if (Buffer.byteLength(JSON.stringify(turnOptions), "utf8") > MAX_TURN_OPTIONS_BYTES) {
      throw new Error(`${label} turn options exceed ${MAX_TURN_OPTIONS_BYTES} bytes.`);
    }
  }
  return Object.freeze({
    harnessId: prepared.harnessId,
    driverVersion: prepared.driverVersion,
    route,
    promptEnvelope: Object.freeze({ ...envelope }),
    inputDigest: prepared.inputDigest,
    turnOptions: turnOptions == null ? null : Object.freeze(turnOptions),
  });
}

/** Readiness of one logical Harness instance, reported without repair. */
export const INSTANCE_READINESS_VALUES = Object.freeze(["ready", "unavailable", "blocked", "unknown"]);

/** Closed, sanitized reasons an instance is in its reported readiness. */
export const INSTANCE_DETAIL_CODES = Object.freeze([
  "ready",
  "not_configured",
  "interactive_policy",
  "executable_missing",
  "service_unreachable",
  "dormant_native_config",
  "not_authenticated",
  "incompatible_version",
  "capacity_exhausted",
  "configuration_missing",
  "rpc_incompatible",
  "rpc_timeout",
  "protocol_error",
  "unknown",
]);

export const ROUTE_TOPOLOGY_VALUES = Object.freeze(["leaf", "native_orchestrator"]);
export const ROUTE_AUTHORITY_VALUES = Object.freeze(["behavioral_read_only", "behavioral_write"]);

// One grammar for caller, discovery, durable lineage, and public projection.
// eslint-disable-next-line no-control-regex -- rejecting these characters is the contract
const UNSTABLE_ROUTE_TEXT = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export function isBoundedRouteText(value) {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim() &&
    !UNSTABLE_ROUTE_TEXT.test(value) && Buffer.byteLength(value, "utf8") <= 256;
}

export function isBoundedRouteAtom(value) {
  return isBoundedRouteText(value) && !value.includes("/");
}

export function splitFullModelRoute(value) {
  if (!isBoundedRouteText(value)) return null;
  const slash = value.indexOf("/");
  if (slash < 1 || slash !== value.lastIndexOf("/")) return null;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return isBoundedRouteAtom(provider) && isBoundedRouteAtom(model)
    ? Object.freeze({ provider, model })
    : null;
}

/** Everything a caller may state when asking for one canonical route. */
export const ROUTE_REQUEST_FIELDS = Object.freeze([
  "authority",
  "effort",
  "harnessId",
  "model",
  "topology",
]);

export const CANONICAL_ROUTE_FIELDS = Object.freeze([
  "authority",
  "capabilities",
  "driverVersion",
  "effort",
  "harnessId",
  "instanceKey",
  "model",
  "topology",
]);

const INSTANCE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const MAX_INSTANCE_ROUTE_FACTS_BYTES = 4 * 1024;
const INSPECTION_GENERATION_TOKEN_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A Driver states this only when it has no safe native configuration witness. */
export const INSPECTION_GENERATION_UNAVAILABLE = "unavailable";

/**
 * One bounded opaque native-inspection generation. This is evidence, never a
 * route selector or a raw configuration identity.
 */
export function validateInspectionGeneration(value, label = "Inspection generation") {
  if (value === INSPECTION_GENERATION_UNAVAILABLE) return value;
  if (typeof value !== "string" || !INSPECTION_GENERATION_TOKEN_PATTERN.test(value)) {
    throw new Error(
      `${label} must be ${JSON.stringify(INSPECTION_GENERATION_UNAVAILABLE)} or one bounded opaque sha256 token.`
    );
  }
  return value;
}

/**
 * Validate one logical-instance inspection. The instance key is a stable
 * redacted identity, never an endpoint, credential, or filesystem secret, so a
 * later diagnostic can name the blocked instance without leaking configuration.
 */
export function validateInstanceInspection(inspection, driver) {
  const label = `Harness Driver ${driver.harnessId} instance inspection`;
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new Error(`${label} must be an object.`);
  }
  if (inspection.harnessId !== driver.harnessId) {
    throw new Error(
      `${label} belongs to Harness ${JSON.stringify(inspection.harnessId ?? null)}; expected ${driver.harnessId}.`
    );
  }
  if (typeof inspection.instanceKey !== "string" || !INSTANCE_KEY_PATTERN.test(inspection.instanceKey)) {
    throw new Error(
      `Harness ${driver.harnessId} instance key must be a stable redacted identity: ` +
      `${JSON.stringify(inspection.instanceKey ?? null)}.`
    );
  }
  if (!INSTANCE_READINESS_VALUES.includes(inspection.readiness)) {
    throw new Error(
      `${label} has an unsupported readiness: ${JSON.stringify(inspection.readiness ?? null)}. ` +
      `Use one of: ${INSTANCE_READINESS_VALUES.join(", ")}.`
    );
  }
  if (typeof inspection.liveValidated !== "boolean") {
    throw new Error(`${label} must state whether readiness was live-validated.`);
  }
  if (!CAPABILITY_MATURITY_VALUES.includes(inspection.maturity)) {
    throw new Error(`${label} has an unsupported maturity: ${JSON.stringify(inspection.maturity ?? null)}.`);
  }
  if (!INSTANCE_DETAIL_CODES.includes(inspection.detailCode)) {
    throw new Error(
      `${label} has an unsupported detail code: ${JSON.stringify(inspection.detailCode ?? null)}. ` +
      `Use one of: ${INSTANCE_DETAIL_CODES.join(", ")}.`
    );
  }
  const routes = inspection.routes ?? null;
  if (routes != null) {
    if (typeof routes !== "object" || Array.isArray(routes)) {
      throw new Error(`${label} route facts must be an object or null.`);
    }
  }
  if (inspection.capabilityProvenance == null || inspection.inspectionGeneration == null) {
    throw new Error(`${label} requires current capability provenance and inspection generation.`);
  }
  const capabilityProvenance = validateRouteCapabilityProvenance(
    inspection.capabilityProvenance, `${label} capability provenance`
  );
  const inspectionGeneration = validateInspectionGeneration(inspection.inspectionGeneration, `${label} generation`);
  const canonicalRoutes = routes == null ? null : canonicalBoundedOpaqueField(routes, {
    label: `${label} route facts`, maxBytes: MAX_INSTANCE_ROUTE_FACTS_BYTES,
  });
  if (canonicalRoutes != null && Buffer.byteLength(JSON.stringify(canonicalRoutes), "utf8") > MAX_INSTANCE_ROUTE_FACTS_BYTES) {
    throw new Error(`${label} route facts exceed their durable bound.`);
  }
  if (inspection.readiness === "ready") {
    if (canonicalRoutes == null) {
      throw new Error(`${label} ready instance requires exact route facts.`);
    }
    const models = canonicalRoutes.models;
    const effortsByModel = canonicalRoutes.effortsByModel;
    if (!Array.isArray(models) || models.length === 0 || !models.every(isBoundedRouteText)) {
      throw new Error(`${label} ready route facts require non-empty bounded models.`);
    }
    if (new Set(models).size !== models.length) {
      throw new Error(`${label} ready route facts declare duplicate models.`);
    }
    if (!effortsByModel || typeof effortsByModel !== "object" || Array.isArray(effortsByModel)) {
      throw new Error(`${label} ready route facts require per-model efforts.`);
    }
    const effortModels = Object.keys(effortsByModel);
    if (effortModels.length !== models.length ||
        effortModels.some((model) => !models.includes(model)) ||
        models.some((model) => !Object.hasOwn(effortsByModel, model))) {
      throw new Error(`${label} ready route models and per-model efforts must have exact keys.`);
    }
    for (const model of models) {
      const efforts = effortsByModel[model];
      if (!Array.isArray(efforts) || efforts.length === 0 || !efforts.every(isBoundedRouteAtom)) {
        throw new Error(`${label} ready route ${JSON.stringify(model)} requires non-empty bounded exact efforts.`);
      }
      if (new Set(efforts).size !== efforts.length) {
        throw new Error(`${label} ready route ${JSON.stringify(model)} declares duplicate efforts.`);
      }
    }
  }
  for (const key of Object.keys(inspection)) {
    if (!["harnessId", "instanceKey", "readiness", "liveValidated", "maturity", "detailCode", "routes", "capabilityProvenance", "inspectionGeneration"].includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
  }
  return Object.freeze({
    harnessId: inspection.harnessId,
    instanceKey: inspection.instanceKey,
    readiness: inspection.readiness,
    liveValidated: inspection.liveValidated,
    maturity: inspection.maturity,
    detailCode: inspection.detailCode,
    routes: canonicalRoutes,
    capabilityProvenance,
    inspectionGeneration,
  });
}

/**
 * Bind the route snapshot to the exact completed inspection that admitted it.
 * An inspection itself cannot prove a session-negotiated dimension: that fact
 * exists only after the accepted native session, so a route may not claim it.
 */
export function inspectionEvidenceForRoute(route, inspection, driver) {
  const validatedInspection = validateInstanceInspection(inspection, driver);
  if (route?.instanceKey !== validatedInspection.instanceKey) {
    throw new Error("Route inspection evidence belongs to another logical instance.");
  }
  if (JSON.stringify(validatedInspection.capabilityProvenance) !==
      JSON.stringify(route?.capabilities?.provenance ?? null)) {
    throw new Error("Route inspection provenance does not match the accepted execution route.");
  }
  if (!validatedInspection.liveValidated && Object.values(route?.capabilities?.provenance ?? {}).includes("inspection_proven")) {
    throw new Error("Route claims inspection-proven capability provenance without a live inspection receipt.");
  }
  return validateRouteInspectionEvidence({
    generation: validatedInspection.inspectionGeneration,
    capabilities: route?.capabilities,
  }, route);
}

/** Validate the bounded evidence retained with one new attempt. */
export function validateRouteInspectionEvidence(evidence, route, label = "Route inspection evidence") {
  const fields = snapshotClosedPlainObject(evidence, ["generation", "capabilities"], label);
  const capabilities = validateRouteCapabilitySnapshot(route?.capabilities, `${label} route capabilities`);
  if (capabilities.capabilitySchemaVersion !== ROUTE_CAPABILITY_SCHEMA_VERSION || !capabilities.provenance) {
    throw new Error(`${label} requires current capability-schema v${ROUTE_CAPABILITY_SCHEMA_VERSION} provenance.`);
  }
  const evidenceCapabilities = validateRouteCapabilitySnapshot(
    fields.capabilities, `${label} capabilities`
  );
  if (evidenceCapabilities.capabilitySchemaVersion !== ROUTE_CAPABILITY_SCHEMA_VERSION ||
      JSON.stringify(evidenceCapabilities) !== JSON.stringify(capabilities)) {
    throw new Error(`${label} capabilities do not exactly match the attempt execution route.`);
  }
  for (const value of Object.values(evidenceCapabilities.provenance)) {
    if (value === "session_negotiated") {
      throw new Error(`${label} cannot claim session-negotiated provenance before an exact accepted native session.`);
    }
  }
  return Object.freeze({
    generation: validateInspectionGeneration(fields.generation, `${label} generation`),
    capabilities: evidenceCapabilities,
  });
}

/** Read retained attempt evidence without promoting an older route schema. */
export function validateStoredRouteInspectionEvidence(evidence, route, label = "Stored route inspection evidence") {
  const fields = snapshotClosedPlainObject(evidence, ["generation", "capabilities"], label);
  const options = { allowSchemaV2: true, allowSchemaV3: true };
  const capabilities = validateRouteCapabilitySnapshot(route?.capabilities, `${label} route capabilities`, options);
  const evidenceCapabilities = validateRouteCapabilitySnapshot(fields.capabilities, `${label} capabilities`, options);
  if (JSON.stringify(evidenceCapabilities) !== JSON.stringify(capabilities)) {
    throw new Error(`${label} capabilities do not exactly match the retained attempt route.`);
  }
  for (const value of Object.values(evidenceCapabilities.provenance ?? {})) {
    if (value === "session_negotiated") {
      throw new Error(`${label} cannot claim session-negotiated provenance before an exact accepted native session.`);
    }
  }
  return Object.freeze({
    generation: validateInspectionGeneration(fields.generation, `${label} generation`),
    capabilities: evidenceCapabilities,
  });
}

/**
 * Validate the canonical route a Driver returns for one explicit request. A
 * Driver may refuse a request; it may never answer a different one, and it
 * never supplies a Harness, instance, model, topology, or authority the caller
 * did not state.
 */
export function validateCanonicalRoute(route, { driver, inspection, request }) {
  const label = `Harness ${driver.harnessId} canonical route`;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(route)) {
    if (!CANONICAL_ROUTE_FIELDS.includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
  }
  if (route.harnessId !== driver.harnessId) {
    throw new Error(`${label} declares Harness ${JSON.stringify(route.harnessId ?? null)}.`);
  }
  if (route.driverVersion !== driver.driverVersion) {
    throw new Error(`${label} declares a foreign Driver version.`);
  }
  if (route.instanceKey !== inspection.instanceKey) {
    throw new Error(
      `${label} instance ${JSON.stringify(route.instanceKey ?? null)} is not the admitted instance ` +
      `${inspection.instanceKey}.`
    );
  }
  for (const field of ["model", "topology", "authority"]) {
    if (route[field] !== request[field]) {
      throw new Error(
        `${label} ${field} ${JSON.stringify(route[field] ?? null)} does not match the requested ` +
        `${JSON.stringify(request[field] ?? null)}.`
      );
    }
  }
  if (!isBoundedRouteAtom(request.effort)) {
    throw new Error(`${label} request must state one explicit effort.`);
  }
  if (route.effort !== request.effort) {
    throw new Error(`${label} effective effort ${JSON.stringify(route.effort ?? null)} does not match the requested ${JSON.stringify(request.effort)}.`);
  }
  if (!isBoundedRouteAtom(route.effort)) {
    throw new Error(`${label} must record one effective native effort.`);
  }
  const validatedInspection = validateInstanceInspection(inspection, driver);
  if (validatedInspection.readiness !== "ready" ||
      !validatedInspection.routes.models.includes(route.model) ||
      !validatedInspection.routes.effortsByModel[route.model].includes(route.effort)) {
    throw new Error(`${label} model and effort must be freshly advertised by the admitted instance.`);
  }
  const capabilities = assertDriverRouteCoherence(driver, route.capabilities);
  assertAdmittedInteraction(capabilities, label);
  const canonical = Object.freeze({
    harnessId: route.harnessId,
    instanceKey: route.instanceKey,
    model: route.model,
    topology: route.topology,
    authority: route.authority,
    driverVersion: route.driverVersion,
    effort: route.effort,
    capabilities,
  });
  inspectionEvidenceForRoute(canonical, validatedInspection, driver);
  return canonical;
}

/**
 * Fields that made version one a single-Harness contract. A version-two result
 * or live handle that carries any of them is rejected rather than tolerated:
 * a service-backed turn has no PID and no exit status to fabricate, and the
 * supervisor must never be able to read one anyway.
 */
export const PROCESS_SHAPED_FIELDS = Object.freeze([
  "exitStatus",
  "exitCode",
  "pid",
  "processId",
  "process",
  "spawnAccepted",
  "identityProven",
  "signalDelivered",
]);

export const NORMALIZED_TERMINAL_FIELDS = Object.freeze([
  "continuation",
  "contractVersion",
  "driverReceipt",
  "driverVersion",
  "executionWorld",
  "failure",
  "finalMessage",
  "finalMessageAbsenceReason",
  "harnessId",
  "instanceKey",
  "metrics",
  "nativeTurn",
  "nativeTurnRef",
  "progress",
  "resultMetadata",
  "status",
]);

export const MAX_PROGRESS_BYTES = 32 * 1024;
export const MAX_CONTINUATION_EVIDENCE_BYTES = 4 * 1024;
export const MAX_FAILURE_REASON_CHARS = 2048;
export const MAX_FAILURE_DETAIL_BYTES = 4 * 1024;
export const MAX_ABSENCE_REASON_CHARS = 256;
export const MAX_RESULT_METADATA_BYTES = 8 * 1024;

/**
 * The one outer-assistant answer is the turn's deliverable, so it is admitted
 * whole rather than truncated: 256 KiB is four times the existing bounded
 * native text capture (`MAX_STDERR_BYTES`) and eight times the bounded progress
 * receipt, which keeps a complete answer well inside the bound while a runaway
 * transcript dump fails closed before it can enter durable state.
 */
export const MAX_FINAL_MESSAGE_CHARS = 256 * 1024;

/**
 * Live-turn methods and the capability each one requires. Unlike Driver-level
 * methods, a live handle is route-scoped, so the check is bidirectional: a
 * handle that offers steering on an `initial_only` route is as incoherent as
 * one that hides interruption on a route that admits it.
 */
const LIVE_TURN_CAPABILITY_METHODS = Object.freeze({
  deliverActiveInput: Object.freeze({ capability: "activeInput", admitted: Object.freeze(["acknowledged_active_stream"]) }),
  requestInterrupt: Object.freeze({ capability: "interruptRequest", admitted: Object.freeze(["supported"]) }),
  subscribeProgress: Object.freeze({ capability: "nativeProgress", admitted: Object.freeze(["native_coalesced"]) }),
});

function assertNoProcessShapedFields(value, label) {
  for (const field of PROCESS_SHAPED_FIELDS) {
    // `in`, not `hasOwn`: a class-backed live handle or a result built on a
    // process-shaped prototype hides the same evidence one link up the chain.
    // `in` checks property *existence* ([[HasProperty]]) and never invokes a
    // getter; callers of this function reject a Proxy value before calling it,
    // so `in` cannot trigger a `has` trap either.
    if (field in value) {
      throw new Error(
        `${label} must not carry process-shaped evidence: ${field}. Driver Contract v2 has no universal ` +
        `child process, PID, or exit status.`
      );
    }
  }
}

/**
 * Validate one native reference envelope against the Driver that owns it.
 * The envelope shape, its explicit byte/depth/key/scalar bounds, and its
 * forbidden secret/config/prompt/output/endpoint/environment keys are all
 * owned by `native-reference.mjs`; this is the one place `harness-contract.mjs`
 * invokes it, so continuation and exact turn acceptance can never persist an
 * open-ended locator, a live transport, or one kind substituted for the other.
 */
export function assertNativeReferenceEnvelope(reference, { driver, route, kind }) {
  return validateNativeReferenceEnvelope(reference, { driver, route, kind });
}

/**
 * The exact set of live-turn wrapper objects `validateLiveHarnessTurn()` has
 * produced. `durableTurnEvidence()` checks membership instead of trusting its
 * argument's shape, so a raw, never-validated Driver handle — which may still
 * carry process-shaped evidence, an unbounded locator, or an unexpected own
 * property — can never reach durable state by construction.
 */
const VALIDATED_LIVE_HARNESS_TURNS = new WeakSet();

/**
 * Validate the process-local live handle a Driver returns once its native turn
 * exists, and return an explicit, hand-built wrapper — never the Driver's
 * object, and never a spread of it. A spread would silently drop any
 * prototype method a class-backed handle relies on (dropping `dispose()`
 * itself, for a handle that implements it only on its prototype) and would
 * just as silently copy forward any unexpected own property the Driver's
 * object happens to carry. Every admitted method is captured once and bound
 * to the original handle, so `this`/private-field semantics inside a
 * class-backed Driver handle keep working through the wrapper. The handle is
 * never serialized: only `durableTurnEvidence()` may be persisted, and only
 * for a wrapper this function produced.
 */
export function validateLiveHarnessTurn(live, { driver, route }) {
  const label = `Harness ${driver.harnessId} live turn`;
  if (!live || typeof live !== "object" || Array.isArray(live)) {
    throw new Error(`${label} must be an object.`);
  }
  if (types.isProxy(live)) {
    throw new Error(`${label} must not be a Proxy.`);
  }
  assertNoProcessShapedFields(live, label);
  // Capture the canonical, bounded reference `assertNativeReferenceEnvelope`
  // returns rather than discarding it: what a Driver returns only becomes
  // durable-safe once it has passed through native-reference.mjs, so that
  // canonical value — not the Driver's raw object — is what travels onward to
  // `durableTurnEvidence()`. Each of `live.nativeTurnRef`/`live.nativeSessionRef`
  // is read exactly once, into a local, before any validation of it begins.
  const rawNativeTurnRef = live.nativeTurnRef;
  const rawNativeSessionRef = live.nativeSessionRef;
  const nativeTurnRef = assertNativeReferenceEnvelope(rawNativeTurnRef, { driver, route, kind: "turn" });
  const nativeSessionRef = rawNativeSessionRef != null
    ? assertNativeReferenceEnvelope(rawNativeSessionRef, { driver, route, kind: "session" })
    : null;
  const resultPromise = live.result;
  if (typeof resultPromise?.then !== "function") {
    throw new Error(`${label} must expose one completion promise.`);
  }
  const disposeMethod = live.dispose;
  if (typeof disposeMethod !== "function") {
    throw new Error(`${label} must expose dispose().`);
  }
  const capabilities = validateRouteCapabilitySnapshot(route.capabilities, `${label} route capability snapshot`);
  const boundOptionalMethods = {};
  for (const [method, { capability, admitted }] of Object.entries(LIVE_TURN_CAPABILITY_METHODS)) {
    const value = capabilities.values[capability];
    const implementation = live[method];
    const implemented = typeof implementation === "function";
    if (admitted.includes(value) && !implemented) {
      throw new Error(`${label} admits ${capability}=${value} without exposing ${method}.`);
    }
    if (!admitted.includes(value) && implemented) {
      throw new Error(
        `${label} exposes ${method} although the accepted route declares ${capability}=${value}.`
      );
    }
    if (implemented && method === "subscribeProgress") {
      boundOptionalMethods[method] = (listener) => {
        if (typeof listener !== "function") throw new Error(`${label} subscribeProgress listener must be a function.`);
        const unsubscribe = implementation.call(live, (progress) => {
          try { listener(validateNativeProgress(progress, `${label} progress`)); } catch { /* best effort only */ }
        });
        if (typeof unsubscribe !== "function") throw new Error(`${label} subscribeProgress must return unsubscribe().`);
        return unsubscribe;
      };
    } else if (implemented) {
      // Bind to the original handle so a class-backed live turn's prototype
      // method keeps operating on its own private fields through the wrapper.
      boundOptionalMethods[method] = implementation.bind(live);
    }
  }
  const wrapper = Object.freeze({
    nativeTurnRef,
    nativeSessionRef,
    result: resultPromise,
    dispose: disposeMethod.bind(live),
    ...boundOptionalMethods,
  });
  VALIDATED_LIVE_HARNESS_TURNS.add(wrapper);
  return wrapper;
}

/**
 * The only part of a live turn that may become durable state. Accepts only a
 * wrapper `validateLiveHarnessTurn()` produced; a raw or otherwise
 * unvalidated handle is refused before either of its native references is
 * ever read, regardless of what shape it happens to have.
 */
export function durableTurnEvidence(live) {
  if (!VALIDATED_LIVE_HARNESS_TURNS.has(live)) {
    throw new Error(
      "durableTurnEvidence() requires the exact wrapper validateLiveHarnessTurn() returned; " +
      "a raw or unvalidated live handle cannot become durable state."
    );
  }
  return Object.freeze({
    nativeTurnRef: live.nativeTurnRef,
    nativeSessionRef: live.nativeSessionRef ?? null,
  });
}

/**
 * The closed Driver proof that `startTurn()` refused a turn before any request
 * crossed its native transport boundary.
 *
 * It lives with the Driver contract, not with the worker that consumes it,
 * because the proof is a Driver's own statement about its own transport: a
 * Driver must be able to make it without importing the supervisor's launch
 * module. Only a selected in-process Driver can make it relevant by throwing
 * this exact branded object from its own `startTurn()`; error text or a
 * caller-shaped property is never evidence, so an ambiguous submission can
 * never present itself as a replay-safe rejection.
 */
const PRE_TRANSPORT_REJECTIONS = new WeakSet();

export function driverPreTransportRejection() {
  const error = Object.assign(
    new Error("Harness Driver rejected the turn before native transport submission."),
    { code: "driver_pre_transport_rejection" }
  );
  PRE_TRANSPORT_REJECTIONS.add(error);
  return error;
}

export function isDriverPreTransportRejection(error) {
  return error !== null && typeof error === "object" && PRE_TRANSPORT_REJECTIONS.has(error);
}

/**
 * Reject an own property that is not a plain, enumerable data property, without
 * ever invoking a getter/setter: only the descriptor object itself is read
 * (`"value" in descriptor`, `descriptor.get`, `descriptor.set`), never the
 * underlying property. Shared by the closed-field snapshot below and by the
 * opaque-field canonicalizer, so both refuse an accessor identically.
 */
function assertPlainDataDescriptor(descriptor, label) {
  if (!("value" in descriptor) || typeof descriptor.get === "function" || typeof descriptor.set === "function") {
    throw new Error(`${label} must be a plain data property, not a getter/setter accessor.`);
  }
  if (!descriptor.enumerable) {
    throw new Error(`${label} must be an enumerable own property.`);
  }
}

/**
 * Safely snapshot one untrusted closed-field plain object: reject a Proxy, a
 * non-ordinary prototype (this refuses a class-backed or otherwise exotic
 * object explicitly, per the durable-runtime-state safety boundary, rather
 * than silently accepting it and then dropping fields it does not
 * recognize), and any symbol-keyed, accessor, or non-enumerable own
 * property -- all via `Object.getOwnPropertyDescriptors()` alone, so a
 * getter or Proxy trap can never execute while building the snapshot.
 * `allowedFields` is the exact closed vocabulary; an unknown field is
 * rejected using the snapshot's own keys, never a second read of `value`.
 */
function snapshotClosedPlainObject(value, allowedFields, label) {
  if (types.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must not carry symbol-keyed fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = {};
  for (const key of Object.keys(descriptors)) {
    if (!allowedFields.includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
    assertPlainDataDescriptor(descriptors[key], `${label} field ${key}`);
    snapshot[key] = descriptors[key].value;
  }
  return snapshot;
}

/**
 * Structural rules for one durable *opaque* field: `continuation.evidence`, an
 * object `failure.detail`, `progress`, `resultMetadata`, and `driverReceipt`.
 *
 * Their *vocabulary* belongs to the Driver -- unknown keys stay admitted, and
 * the native-locator forbidden secret/config/prompt/output/endpoint key policy
 * deliberately does not apply to generic metadata -- but their *structure* does
 * not. A value that can execute code (an accessor, a `toJSON`, a Proxy trap, a
 * class-backed or built-in container) makes the bound-checked value and the
 * persisted value two different objects: the field passes its byte bound as one
 * shape and is serialized later as another. Everything below therefore reads
 * untrusted input through `util.types.isProxy()` plus
 * `Object.getOwnPropertyDescriptors()` only, and rebuilds a fresh deep-frozen
 * plain-data clone that is what the canonical result actually carries.
 *
 * `MAX_OPAQUE_FIELD_DEPTH` is stack safety for that recursive rebuild, not a
 * schema policy: cycles are refused separately, and no bounded receipt has a
 * reason to nest this deep.
 */
export const MAX_OPAQUE_FIELD_DEPTH = 32;

/** Canonical dense-array index text; anything else on an array is a smuggled field. */
const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Names that would rewrite object structure rather than store a value if ever
 * assigned through an ordinary `[[Set]]`-based copy downstream. The rebuild
 * here uses `Object.defineProperty()` and is safe regardless, but a durable
 * opaque field has no legitimate reason to carry one, so it fails closed.
 */
const STRUCTURAL_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Validate one opaque array using descriptors only. `value.map`, `value[i]`,
 * and every other attacker-reachable method on the array are never invoked:
 * only an ordinary `Array.prototype` array with no holes, no extra or
 * symbol-keyed properties, and no accessor elements is admitted, and the
 * canonical clone is rebuilt index by index from the validated descriptors.
 */
function canonicalOpaqueArray(value, { label, depth, visited }) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an ordinary Array; subclassed or prototype-swapped arrays are not admitted.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must not carry symbol-keyed fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error(`${label} must have an ordinary non-negative integer length.`);
  }
  const length = lengthDescriptor.value;
  // A pure string-shape check against the key itself, so a smuggled extra
  // property is refused by its name alone -- without inspecting, let alone
  // invoking, its descriptor.
  const indices = new Set();
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!ARRAY_INDEX_PATTERN.test(key) || Number(key) >= length) {
      throw new Error(`${label} declares a non-index field: ${JSON.stringify(key)}.`);
    }
    indices.add(Number(key));
  }
  const canonical = [];
  for (let index = 0; index < length; index += 1) {
    if (!indices.has(index)) {
      throw new Error(`${label} contains a hole at index ${index}; sparse arrays are not admitted.`);
    }
    const elementLabel = `${label}[${index}]`;
    assertPlainDataDescriptor(descriptors[String(index)], elementLabel);
    canonical.push(canonicalOpaqueValue(descriptors[String(index)].value, {
      label: elementLabel, depth: depth + 1, visited,
    }));
  }
  return Object.freeze(canonical);
}

/**
 * Validate one opaque object using descriptors only, and rebuild it field by
 * field with `Object.defineProperty()` on a fresh ordinary object. Unlike
 * `clone[key] = value`, `Object.defineProperty()` always creates an own data
 * property regardless of key name, so it can never be tricked into rewriting
 * the clone's prototype instead of storing a field.
 */
function canonicalOpaqueObject(value, { label, depth, visited }) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must not carry symbol-keyed fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const canonical = {};
  for (const key of Object.keys(descriptors)) {
    if (STRUCTURAL_POLLUTION_KEYS.has(key)) {
      throw new Error(`${label} field ${JSON.stringify(key)} would rewrite object structure and is not admitted.`);
    }
    assertPlainDataDescriptor(descriptors[key], `${label} field ${JSON.stringify(key)}`);
    Object.defineProperty(canonical, key, {
      value: canonicalOpaqueValue(descriptors[key].value, { label: `${label}.${key}`, depth: depth + 1, visited }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(canonical);
}

/**
 * Walk one opaque value. `util.types.isProxy()` runs before any other
 * reflective operation (`Array.isArray`, `Object.getPrototypeOf`,
 * `Object.getOwnPropertyDescriptors`), so a Proxy is refused before a single
 * trap can run. A `toJSON`, a callback, or any other function-valued field is
 * refused as a function; a `Date`, `Map`, `Buffer`, socket, stream, or class
 * instance is refused by the exact-prototype check instead of being silently
 * reshaped by `JSON.stringify()`. Only values JSON round-trips unchanged
 * survive, so the canonical clone and its persisted text always agree.
 */
function canonicalOpaqueValue(value, { label, depth, visited }) {
  if (depth > MAX_OPAQUE_FIELD_DEPTH) {
    throw new Error(`${label} exceeds its maximum nesting depth of ${MAX_OPAQUE_FIELD_DEPTH}.`);
  }
  const type = typeof value;
  if (type === "function") {
    throw new Error(`${label} must not carry a function or callback.`);
  }
  if (type === "symbol" || type === "bigint") {
    throw new Error(`${label} must not carry a ${type} value.`);
  }
  if (type === "undefined") {
    throw new Error(`${label} must not carry an undefined value; JSON has no undefined.`);
  }
  if (value === null) return null;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number; JSON has no NaN or Infinity.`);
    }
    // JSON has no negative zero, so the value that survives persistence is the
    // one this canonical clone carries.
    return value === 0 ? 0 : value;
  }
  if (type !== "object") return value;
  if (types.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy.`);
  }
  if (visited.has(value)) {
    throw new Error(`${label} contains a cycle.`);
  }
  visited.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalOpaqueArray(value, { label, depth, visited });
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `${label} must be a plain data object; live handles, class instances, and built-in ` +
        `containers (Map/Set/Date/Buffer/RegExp/Error/socket/stream) are not admitted.`
      );
    }
    return canonicalOpaqueObject(value, { label, depth, visited });
  } finally {
    visited.delete(value);
  }
}

/**
 * Canonicalize and bound one durable opaque field. The byte bound is computed
 * with `Buffer.byteLength()` on the *canonical* JSON, after the whole value has
 * been validated and rebuilt, so it measures exactly the bytes that become
 * durable state -- nested accumulation included -- rather than a UTF-16 length
 * of whatever the Driver's object happened to serialize as at check time.
 * Errors name the field and its measured size; they never echo a value.
 */
function canonicalBoundedOpaqueField(value, { label, maxBytes }) {
  const canonical = canonicalOpaqueValue(value, { label, depth: 1, visited: new Set() });
  const bytes = Buffer.byteLength(JSON.stringify(canonical), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds its durable bound (${bytes} > ${maxBytes} bytes).`);
  }
  return canonical;
}

/**
 * Rebuild the closed metrics object the metrics owner returned as frozen data.
 * `normalizeTerminalMetrics()` is the sole owner of the metrics vocabulary; it
 * already returns a fresh object built from validated fields, and this only
 * makes that object immutable so the canonical result cannot be mutated after
 * validation. No Driver-supplied object survives here.
 */
function frozenNormalizedMetrics(metrics) {
  if (metrics == null) return null;
  return Object.freeze({
    version: metrics.version,
    provider_reported: metrics.provider_reported == null ? null : Object.freeze({ ...metrics.provider_reported }),
    plugin_observed: metrics.plugin_observed == null ? null : Object.freeze({ ...metrics.plugin_observed }),
  });
}

/**
 * Validate the one normalized terminal result of a version-two turn.
 *
 * Native turn state, execution-world settlement, and transcript continuation
 * are independent axes: a persistent service may be preserved and settled at
 * once, and a transcript may be resumable after its execution world is gone.
 * Nothing here collapses them into one resumable boolean.
 *
 * Every field this function reads comes from exactly one
 * `Object.getOwnPropertyDescriptors()`-based snapshot per object level
 * (`result` itself, then `executionWorld`/`continuation`/`failure`
 * independently). `result` is never spread and never read a second time
 * after that snapshot: the value this function validated for a bound (for
 * example `finalMessage`'s length) is the exact same value it places in the
 * canonical return, because there is no second read through which a getter
 * could answer differently.
 *
 * The same guarantee has to hold *inside* the durable opaque fields, whose
 * vocabulary belongs to the Driver: `continuation.evidence`, an object
 * `failure.detail`, `progress`, `resultMetadata`, and `driverReceipt` are each
 * canonicalized into fresh deep-frozen plain data before any identity or byte
 * bound is checked, and it is that clone -- never the Driver's object -- that
 * the canonical result carries. Without it, a nested accessor, `toJSON`, or
 * Proxy trap could answer one way for the bound check and another way when the
 * result is serialized into durable state. Metrics keep their existing closed
 * owner and the canonical result retains only that owner's normalized object.
 *
 * The canonical return is therefore a fixed point: feeding it back into this
 * function revalidates successfully and reproduces an equal result, and
 * `JSON.parse(JSON.stringify(result))` reproduces it too.
 */
export function validateNormalizedTerminalResult(result, { driver, route }) {
  const label = `Harness ${driver.harnessId} terminal result`;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${label} must be an object.`);
  }
  if (types.isProxy(result)) {
    throw new Error(`${label} must not be a Proxy.`);
  }
  // `in` never invokes a getter and, with the Proxy already refused above,
  // never triggers a `has` trap either -- safe to run before snapshotting.
  assertNoProcessShapedFields(result, label);
  const snapshot = snapshotClosedPlainObject(result, NORMALIZED_TERMINAL_FIELDS, label);

  if (snapshot.contractVersion !== DRIVER_CONTRACT_VERSION_V2) {
    throw new Error(
      `${label} implements Driver Contract ${JSON.stringify(snapshot.contractVersion ?? null)}; ` +
      `this runtime requires Driver Contract ${DRIVER_CONTRACT_VERSION_V2}.`
    );
  }
  if (snapshot.harnessId !== driver.harnessId) {
    throw new Error(`${label} belongs to Harness ${JSON.stringify(snapshot.harnessId ?? null)}.`);
  }
  if (snapshot.driverVersion !== driver.driverVersion) {
    throw new Error(`${label} declares a foreign Driver version.`);
  }
  if (snapshot.instanceKey !== route.instanceKey) {
    throw new Error(
      `${label} belongs to logical instance ${JSON.stringify(snapshot.instanceKey ?? null)}; ` +
      `expected ${route.instanceKey}.`
    );
  }
  if (!TURN_STATUS_VALUES.includes(snapshot.status)) {
    throw new Error(
      `${label} has an unsupported status: ${JSON.stringify(snapshot.status ?? null)}. ` +
      `Use one of: ${TURN_STATUS_VALUES.join(", ")}.`
    );
  }
  if (snapshot.nativeTurn !== "terminal") {
    throw new Error(`${label} terminal result must report nativeTurn=terminal.`);
  }
  // Captured, not discarded: the canonical bounded reference is what becomes
  // durable state, not whatever object the Driver happened to return.
  const nativeTurnRef = assertNativeReferenceEnvelope(snapshot.nativeTurnRef, { driver, route, kind: "turn" });

  const world = snapshotClosedPlainObject(
    snapshot.executionWorld, ["continuity", "settlement"], `${label} execution world`
  );
  if (!EXECUTION_CONTINUITY_VALUES.includes(world.continuity)) {
    throw new Error(
      `${label} has an unsupported execution continuity: ${JSON.stringify(world.continuity ?? null)}.`
    );
  }
  if (!NORMALIZED_SETTLEMENT_VALUES.includes(world.settlement)) {
    throw new Error(
      `${label} has an unsupported execution settlement: ${JSON.stringify(world.settlement ?? null)}.`
    );
  }
  if (snapshot.status === "completed" && world.settlement === "active") {
    throw new Error(`${label} completed turn cannot report active owned work.`);
  }

  const capabilities = validateRouteCapabilitySnapshot(route.capabilities, `${label} route capability snapshot`);
  const continuation = snapshotClosedPlainObject(
    snapshot.continuation, ["mode", "nativeSessionRef", "evidence"], `${label} continuation`
  );
  if (!CONTINUATION_MODES.includes(continuation.mode)) {
    throw new Error(
      `${label} has an unsupported continuation mode: ${JSON.stringify(continuation.mode ?? null)}.`
    );
  }
  if (continuation.mode === "exact_resume") {
    if (capabilities.values.continuation !== "exact_resume") {
      throw new Error(
        `${label} claims continuation mode exact_resume while the accepted ` +
        `route admits continuation=${capabilities.values.continuation}.`
      );
    }
    if (continuation.nativeSessionRef == null) {
      throw new Error(`${label} continuation mode exact_resume requires a native session reference.`);
    }
  }
  const declaredEvidence = continuation.evidence;
  if (
    types.isProxy(declaredEvidence) ||
    !declaredEvidence ||
    typeof declaredEvidence !== "object" ||
    Array.isArray(declaredEvidence)
  ) {
    throw new Error(`${label} continuation must carry bounded evidence as an object.`);
  }
  const continuationEvidence = canonicalBoundedOpaqueField(declaredEvidence, {
    label: `${label} continuation evidence`, maxBytes: MAX_CONTINUATION_EVIDENCE_BYTES,
  });
  let continuationSessionRef = continuation.nativeSessionRef ?? null;
  if (continuation.nativeSessionRef != null) {
    if (["none", "fresh_only"].includes(continuation.mode)) {
      throw new Error(
        `${label} continuation mode ${continuation.mode} must not carry a native session reference.`
      );
    }
    continuationSessionRef = assertNativeReferenceEnvelope(
      continuation.nativeSessionRef, { driver, route, kind: "session" }
    );
  }

  const failure = snapshotClosedPlainObject(
    snapshot.failure, ["class", "reason", "detail", "resumable", "requiresAttention"], `${label} failure classification`
  );
  if (snapshot.status === "completed" && failure.class != null) {
    throw new Error("A completed Harness turn must not classify a failure.");
  }
  if (snapshot.status !== "completed") {
    if (typeof failure.class !== "string" || !failure.class.trim()) {
      throw new Error("A non-completed Harness turn must classify its failure.");
    }
    assertHarnessTurnFailureClass(failure.class, label);
  }
  if (typeof failure.resumable !== "boolean") {
    throw new Error(`${label} failure classification must state transport resumability.`);
  }
  if (failure.requiresAttention != null && typeof failure.requiresAttention !== "boolean") {
    throw new Error(`${label} failure classification must state requiresAttention as a boolean.`);
  }
  if (failure.reason != null) {
    const reason = assertText(failure.reason, `${label} failure reason`);
    if (reason.length > MAX_FAILURE_REASON_CHARS) {
      throw new Error(`${label} failure reason exceeds its durable bound.`);
    }
  }
  let failureDetail = failure.detail ?? null;
  if (failure.detail != null) {
    if (typeof failure.detail === "string") {
      if (failure.detail.length > MAX_FAILURE_REASON_CHARS) {
        throw new Error(`${label} failure detail exceeds its durable bound.`);
      }
    } else if (!types.isProxy(failure.detail) && typeof failure.detail === "object" && !Array.isArray(failure.detail)) {
      failureDetail = canonicalBoundedOpaqueField(failure.detail, {
        label: `${label} failure detail`, maxBytes: MAX_FAILURE_DETAIL_BYTES,
      });
    } else {
      throw new Error(`${label} failure detail must be bounded text or an object when present.`);
    }
  }
  if (snapshot.finalMessage == null && !snapshot.finalMessageAbsenceReason) {
    throw new Error(
      `${label} must carry a final outer-assistant message or an explicit absence reason.`
    );
  }
  if (snapshot.finalMessage != null) {
    if (typeof snapshot.finalMessage !== "string") {
      throw new Error(`${label} final message must be text when present.`);
    }
    if (snapshot.finalMessage.length > MAX_FINAL_MESSAGE_CHARS) {
      throw new Error(`${label} final message exceeds its durable bound.`);
    }
  }
  if (snapshot.finalMessageAbsenceReason != null) {
    const absence = assertText(
      snapshot.finalMessageAbsenceReason,
      `${label} final-message absence reason`
    );
    if (absence.length > MAX_ABSENCE_REASON_CHARS) {
      throw new Error(`${label} final-message absence reason exceeds its durable bound.`);
    }
  }
  let progress = null;
  if (snapshot.progress != null) {
    if (types.isProxy(snapshot.progress) || typeof snapshot.progress !== "object" || Array.isArray(snapshot.progress)) {
      throw new Error(`${label} progress must be an object when present.`);
    }
    progress = canonicalBoundedOpaqueField(snapshot.progress, {
      label: `${label} progress`, maxBytes: MAX_PROGRESS_BYTES,
    });
  }
  let resultMetadata = null;
  if (snapshot.resultMetadata != null) {
    if (
      types.isProxy(snapshot.resultMetadata) ||
      typeof snapshot.resultMetadata !== "object" ||
      Array.isArray(snapshot.resultMetadata)
    ) {
      throw new Error(`${label} result metadata must be an object when present.`);
    }
    resultMetadata = canonicalBoundedOpaqueField(snapshot.resultMetadata, {
      label: `${label} result metadata`, maxBytes: MAX_RESULT_METADATA_BYTES,
    });
  }
  if (snapshot.metrics != null && types.isProxy(snapshot.metrics)) {
    throw new Error(`${label} metrics must not be a Proxy.`);
  }
  // The metrics vocabulary keeps its existing closed owner; only that owner's
  // freshly built normalized object -- never the Driver's -- becomes durable.
  const normalizedMetrics = frozenNormalizedMetrics(
    snapshot.metrics == null ? null : normalizeTerminalMetrics(snapshot.metrics)
  );
  if (snapshot.metrics != null && normalizedMetrics == null) {
    throw new Error(`${label} metrics must use the closed version-one schema.`);
  }
  let driverReceipt = null;
  if (snapshot.driverReceipt != null) {
    if (
      types.isProxy(snapshot.driverReceipt) ||
      typeof snapshot.driverReceipt !== "object" ||
      Array.isArray(snapshot.driverReceipt)
    ) {
      throw new Error(`${label} Driver receipt must be an object when present.`);
    }
    // Canonicalize first: the receipt's own identity fields are read from the
    // frozen clone that is returned, so the identity this check accepted is
    // the identity that becomes durable state.
    driverReceipt = canonicalBoundedOpaqueField(snapshot.driverReceipt, {
      label: `${label} Driver receipt`, maxBytes: MAX_DRIVER_RECEIPT_BYTES,
    });
    if (driverReceipt.harnessId !== driver.harnessId || driverReceipt.driverVersion !== driver.driverVersion) {
      throw new Error(`${label} Driver receipt belongs to a foreign Driver contract.`);
    }
  }
  // The canonical result is built explicitly, field by field, from locals
  // captured above -- never from `{...result}` -- so no field can differ from
  // what was actually validated, and no field `result` happens to carry
  // outside `NORMALIZED_TERMINAL_FIELDS` can reach durable state.
  return Object.freeze({
    contractVersion: snapshot.contractVersion,
    harnessId: snapshot.harnessId,
    driverVersion: snapshot.driverVersion,
    instanceKey: snapshot.instanceKey,
    status: snapshot.status,
    nativeTurn: snapshot.nativeTurn,
    nativeTurnRef,
    executionWorld: Object.freeze({ continuity: world.continuity, settlement: world.settlement }),
    continuation: Object.freeze({
      mode: continuation.mode,
      nativeSessionRef: continuationSessionRef,
      evidence: continuationEvidence,
    }),
    failure: Object.freeze({
      class: failure.class ?? null,
      reason: failure.reason ?? null,
      detail: failureDetail,
      resumable: failure.resumable,
      requiresAttention: failure.requiresAttention ?? null,
    }),
    finalMessage: snapshot.finalMessage ?? null,
    finalMessageAbsenceReason: snapshot.finalMessageAbsenceReason ?? null,
    progress,
    metrics: normalizedMetrics,
    resultMetadata,
    driverReceipt,
  });
}
