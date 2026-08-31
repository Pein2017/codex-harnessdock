/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Version-three durable record identity.
 *
 * Version three exists so an Agent's Harness, logical instance, model,
 * topology, behavioral authority, Driver version, and capability snapshot are
 * one immutable route decided at creation. Nothing in this module defaults,
 * infers, widens, or repairs a route field: a record either states its whole
 * route explicitly or it is not a version-three record.
 *
 * The current seven-operation public generation cannot state all of those
 * inputs, so it keeps writing version two. Version-three creation is therefore
 * gated on an explicit write generation rather than on a feature flag, and an
 * older runtime that meets version-three queue state must fail closed while
 * leaving its owner untouched.
 *
 * Reasoning effort is immutable route lineage. New routes never infer it.
 */

import { Buffer } from "node:buffer";

import {
  ROUTE_CAPABILITY_SCHEMA_VERSION,
  validateRouteCapabilitySnapshot,
} from "./harness-capabilities.mjs";
import {
  CANONICAL_ROUTE_FIELDS,
  ROUTE_AUTHORITY_VALUES,
  ROUTE_TOPOLOGY_VALUES,
  assertHarnessId,
} from "./harness-contract.mjs";
import { plainDataTree, plainRecordSnapshot } from "./plain-record.mjs";

/** The Agent record version this module owns. */
export const AGENT_RECORD_VERSION_V3 = 3;

/** The durable job state version the dependent generation will write. */
export const JOB_STATE_VERSION_V3 = 3;

/**
 * Durable job state versions this runtime can safely own. A record outside
 * this set belongs to a generation whose queue, control, and settlement rules
 * are unknown here; it is observable but never claimable.
 */
export const UNDERSTOOD_JOB_STATE_VERSIONS = Object.freeze([1, 2]);

/** The current public seven-operation generation. It writes version two. */
export const PUBLIC_WRITE_GENERATION = "public_seven_operation";

/**
 * The dependent multi-Harness generation. It is the only writer that may
 * create version-three state, and only with a fully explicit route.
 */
export const FUTURE_WRITE_GENERATION = "internal_future_generation";

export const WRITE_GENERATIONS = Object.freeze([
  PUBLIC_WRITE_GENERATION,
  FUTURE_WRITE_GENERATION,
]);

/**
 * Every field of a version-three route, in canonical order. The Driver-facing
 * canonical route owns the first seven; version three additionally freezes the
 * capability schema version so later schema drift is visible in the record
 * itself rather than inferred from the snapshot it happens to contain.
 */
export const V3_ROUTE_FIELDS = Object.freeze(
  [...CANONICAL_ROUTE_FIELDS, "capabilitySchemaVersion"].sort()
);

/**
 * A logical instance key is a stable redacted identity published by a Driver
 * inspection, never an endpoint, path, or credential. The same bound is
 * enforced where native references are validated; repeating the shape here
 * keeps durable state from depending on a live Driver to be readable.
 */
const INSTANCE_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** Durable bounds are byte bounds: one route field, and the whole route. */
const MAX_ROUTE_TEXT_BYTES = 256;
export const MAX_ROUTE_BYTES = 4 * 1024;

/**
 * C0/C1 controls plus the soft hyphen, zero-width, bidi-override, and
 * byte-order-mark ranges. Identity text that can render as another identity is
 * not identity, so it is refused rather than normalized.
 */
// eslint-disable-next-line no-control-regex
const UNSTABLE_TEXT_PATTERN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function requiredValue(snapshot, key, label) {
  const value = snapshot[key];
  if (value == null) {
    throw new Error(`${label} requires an explicit ${key}.`);
  }
  return value;
}

/**
 * Exact, bounded identity text. Whitespace is never trimmed away: a value that
 * would have to be changed to be stored is a different identity and is refused
 * so the durable record and its Driver agree byte for byte.
 */
function boundedText(value, key, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} field ${key} must be non-empty text.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} field ${key} must not carry leading or trailing whitespace.`);
  }
  if (UNSTABLE_TEXT_PATTERN.test(value)) {
    throw new Error(`${label} field ${key} must not contain control or format characters.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_ROUTE_TEXT_BYTES) {
    throw new Error(`${label} field ${key} exceeds its durable bound.`);
  }
  return value;
}

function fromClosedSet(value, key, values, label) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(
      `${label} has an unsupported ${key}: ${JSON.stringify(value ?? null)}. ` +
      `Use one of: ${values.join(", ")}.`
    );
  }
  return value;
}

/**
 * Validate one immutable version-three route and return its canonical, deeply
 * frozen durable snapshot. The returned object shares no structure with the
 * input, so no Driver-owned or caller-owned state stays aliased into durable
 * records — including the shallow route facts a Driver instance inspection
 * publishes, which are not part of route identity at all. Revalidating a
 * canonical route returns the same canonical route.
 */
function validateVersionThreeRouteInternal(route, label, allowUnknownEffort) {
  const snapshot = plainRecordSnapshot(route, label);
  for (const key of Object.keys(snapshot)) {
    if (!V3_ROUTE_FIELDS.includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
  }
  const harnessId = boundedText(requiredValue(snapshot, "harnessId", label), "harnessId", label);
  if (assertHarnessId(harnessId) !== harnessId) {
    throw new Error(`${label} field harnessId must be stated exactly: ${JSON.stringify(harnessId)}.`);
  }
  const instanceKey = requiredValue(snapshot, "instanceKey", label);
  if (typeof instanceKey !== "string" || !INSTANCE_KEY_PATTERN.test(instanceKey)) {
    throw new Error(
      `${label} instance key must be a stable redacted identity: ${JSON.stringify(instanceKey ?? null)}.`
    );
  }
  const model = boundedText(requiredValue(snapshot, "model", label), "model", label);
  const topology = fromClosedSet(
    requiredValue(snapshot, "topology", label),
    "topology",
    ROUTE_TOPOLOGY_VALUES,
    label
  );
  const authority = fromClosedSet(
    requiredValue(snapshot, "authority", label),
    "authority",
    ROUTE_AUTHORITY_VALUES,
    label
  );
  const driverVersion = boundedText(
    requiredValue(snapshot, "driverVersion", label),
    "driverVersion",
    label
  );
  const hasEffort = Object.hasOwn(snapshot, "effort");
  const effort = hasEffort
    ? boundedText(requiredValue(snapshot, "effort", label), "effort", label)
    : null;
  if (!allowUnknownEffort && effort === null) requiredValue(snapshot, "effort", label);
  const capabilitySchemaVersion = requiredValue(snapshot, "capabilitySchemaVersion", label);
  if (capabilitySchemaVersion !== ROUTE_CAPABILITY_SCHEMA_VERSION &&
      !(allowUnknownEffort && [2, 3].includes(capabilitySchemaVersion))) {
    throw new Error(
      `${label} declares capability schema version ${JSON.stringify(capabilitySchemaVersion)}; ` +
      `this runtime requires ${ROUTE_CAPABILITY_SCHEMA_VERSION}.`
    );
  }
  // The capability snapshot is rebuilt from single reads before an accepted
  // validator sees it, so that validator cannot be shown a different snapshot
  // than the one this record will store.
  const capabilities = validateRouteCapabilitySnapshot(
    plainDataTree(requiredValue(snapshot, "capabilities", label), `${label} capabilities`, 2),
    `${label} capabilities`, { allowSchemaV2: allowUnknownEffort, allowSchemaV3: allowUnknownEffort }
  );
  if (capabilities.capabilitySchemaVersion !== capabilitySchemaVersion) {
    throw new Error(`${label} disagrees with its own capability schema version.`);
  }
  /** @type {Record<string, *>} */
  const values = {
    authority,
    capabilities,
    capabilitySchemaVersion,
    driverVersion,
    harnessId,
    instanceKey,
    model,
    topology,
  };
  if (effort !== null) values.effort = effort;
  /** @type {Record<string, *>} */
  const canonical = {};
  for (const key of V3_ROUTE_FIELDS) {
    if (key !== "effort" || effort !== null) canonical[key] = values[key];
  }
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > MAX_ROUTE_BYTES) {
    throw new Error(`${label} exceeds its durable bound.`);
  }
  return Object.freeze(canonical);
}

/** New route identity: effective effort is mandatory and never inferred. */
export function validateVersionThreeRoute(route, label = "Version-three route") {
  return validateVersionThreeRouteInternal(route, label, false);
}

/** Pre-effort V3 history remains readable; no activation seam accepts it. */
export function validateStoredVersionThreeRoute(route, label = "Stored version-three route") {
  return validateVersionThreeRouteInternal(route, label, true);
}

/**
 * Schema-v2 did not retain provenance.  Compare it to a freshly admitted v3
 * route by every durable execution semantic, but never invent provenance or
 * make an inspection generation part of immutable Agent identity.
 */
export function sameDurableRouteSemantics(storedRoute, executionRoute, label = "Durable route") {
  const stored = validateStoredVersionThreeRoute(storedRoute, `${label} stored route`);
  const execution = validateVersionThreeRoute(executionRoute, `${label} execution route`);
  for (const field of [
    "harnessId", "instanceKey", "model", "effort", "topology", "authority", "driverVersion",
  ]) {
    if (stored[field] !== execution[field]) return false;
  }
  if (stored.capabilities.driverMaturity !== execution.capabilities.driverMaturity) return false;
  for (const name of Object.keys(stored.capabilities.values)) {
    if (stored.capabilities.values[name] !== execution.capabilities.values[name] ||
        stored.capabilities.maturity[name] !== execution.capabilities.maturity[name]) return false;
  }
  return true;
}

export function assertSameDurableRouteSemantics(storedRoute, executionRoute, label = "Durable route") {
  if (!sameDurableRouteSemantics(storedRoute, executionRoute, label)) {
    throw new Error(`${label} route identity does not semantically derive from its immutable Agent route.`);
  }
  return validateVersionThreeRoute(executionRoute, `${label} execution route`);
}

/** Stable serialization of one canonical route, for immutability comparison. */
export function versionThreeRouteText(route, label = "Version-three route") {
  return JSON.stringify(validateVersionThreeRoute(route, label));
}

/** Normalize the write generation a durable store was opened for. */
export function normalizeWriteGeneration(value) {
  if (value == null) return PUBLIC_WRITE_GENERATION;
  if (typeof value !== "string" || !WRITE_GENERATIONS.includes(value)) {
    throw new Error(
      `Unsupported durable write generation: ${JSON.stringify(value ?? null)}. ` +
      `Use one of: ${WRITE_GENERATIONS.join(", ")}.`
    );
  }
  return value;
}

/**
 * The version-three write gate. The public generation exposes no Harness,
 * instance, topology, or authority input, so letting it create version-three
 * state could only mean silently defaulting a route.
 */
export function assertVersionThreeWriteAllowed(generation, label = "Version-three state") {
  const normalized = normalizeWriteGeneration(generation);
  if (normalized !== FUTURE_WRITE_GENERATION) {
    throw new Error(
      `${label} cannot be written by the ${normalized} generation; ` +
      `version-three creation requires the ${FUTURE_WRITE_GENERATION} write generation ` +
      `and one fully explicit route.`
    );
  }
  return normalized;
}

/** The durable state version of one job record; an absent version means one. */
export function jobDurableStateVersion(job) {
  const version = job?.harnessStateVersion;
  return version == null ? 1 : version;
}

/** True when this runtime may own the job record's queue and lifecycle. */
export function isUnderstoodJobRecord(job) {
  return UNDERSTOOD_JOB_STATE_VERSIONS.includes(jobDurableStateVersion(job));
}

/**
 * Fail closed before claiming, reaping, rewriting, or releasing a job record
 * whose durable generation this runtime does not own. The record and whatever
 * owner it names are left exactly as they are for its own runtime to settle.
 */
export function assertUnderstoodJobRecord(job, action = "own") {
  const version = jobDurableStateVersion(job);
  if (!UNDERSTOOD_JOB_STATE_VERSIONS.includes(version)) {
    throw new Error(
      `Job ${job?.id ?? "unknown"} carries durable state version ${JSON.stringify(version)}; ` +
      `this runtime owns ${UNDERSTOOD_JOB_STATE_VERSIONS.join(", ")} and must not ${action} it.`
    );
  }
  return version;
}
