/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Route-keyed OpenCode usage evidence (add-opencode-explorer-driver, Task 6).
 *
 * This module owns one record: what one Explorer turn cost, keyed by everything
 * that makes it a distinct turn. It stores facts; it is not a ledger. The record
 * travels inside the Driver's own bounded receipt on the terminal result, so it
 * reaches durable state through the existing completion path rather than through
 * a second store that could disagree with it.
 *
 * ## Why the key carries eleven fields
 *
 * A model identifier is not an identity. `openai/gpt-5.6-luna` could
 * in principle be served by another Harness with its own pricing, its own
 * capabilities, and its own instance, and two such records must never merge into
 * one number. So the key is derived from the full tuple -- root, Agent, turn,
 * attempt, Harness, instance, full model, Driver version, capability schema
 * version, topology, and authority -- canonicalized so field order cannot
 * change it, then digested. The identity fields travel beside the key in
 * readable form; the digest exists so two records are comparable by one value.
 *
 * ## Two independent measurements, never one
 *
 * Provider cache telemetry and persistent-Server reuse are different facts with
 * different owners. Provider cache read/write tokens are numbers the provider
 * reported. Server reuse is what this process observed about the operator's
 * Server: which version answered, how long the call took, and that no
 * authoritative incarnation evidence exists at all. Nothing in the reuse record
 * may be read as cache evidence, and nothing derived -- a cache hit, an uncached
 * input count, a price, a saving, a subscription charge -- is ever computed from
 * a latency, a version, or a process identity. `assertNoInferredUsageFields()`
 * and the closed field sets below make that structural rather than a comment.
 */

import { createHash } from "node:crypto";

import { plainRecordSnapshot } from "./plain-record.mjs";
import { OPENCODE_PROVIDER_METRIC_FIELDS } from "./opencode-result.mjs";

export const OPENCODE_USAGE_RECORD_VERSION = 1;

/**
 * Every field the usage key is derived from. All eleven are required: a record
 * that cannot name one of them is not attributable and is refused.
 */
export const OPENCODE_USAGE_KEY_FIELDS = Object.freeze([
  "agentId",
  "attemptId",
  "authority",
  "capabilitySchemaVersion",
  "driverVersion",
  "harnessId",
  "instanceKey",
  "model",
  "rootId",
  "topology",
  "turnId",
]);

/** The closed plugin-observed counters this record carries. */
export const OPENCODE_USAGE_PLUGIN_FIELDS = Object.freeze([
  "attemptCount",
  "recoveryAttemptCount",
  "toolCallCount",
]);

/**
 * The closed persistent-Server reuse facts. None of them is cache telemetry,
 * and none is a price: the names are checked against the forbidden vocabulary
 * below so this set cannot quietly grow one.
 */
export const OPENCODE_SERVER_REUSE_FIELDS = Object.freeze([
  "derivedFromCacheTelemetry",
  "latencyMs",
  "serverIncarnationProven",
  "serverVersion",
  "sessionLifecycle",
]);

/**
 * Names of facts this generation cannot honestly report. Each one would require
 * inferring provider behaviour from a latency, a process identity, or a price
 * list this runtime does not have.
 */
export const OPENCODE_FORBIDDEN_INFERRED_FIELDS = Object.freeze([
  "cacheHit",
  "cacheHitRate",
  "cachedInputTokens",
  "estimatedCost",
  "inferredCacheHit",
  "pricePerToken",
  "savings",
  "savingsUsd",
  "subscriptionCharge",
  "uncachedInputTokens",
]);

/** The closed session lifecycle values a reuse record may state. */
export const OPENCODE_SESSION_LIFECYCLE_VALUES = Object.freeze(["fresh_session_per_agent"]);

/** Terminal dispositions a usage record may be attached to. */
export const OPENCODE_USAGE_STATUS_VALUES = Object.freeze(["completed", "failed", "interrupted", "unknown"]);

const MAX_IDENTITY_VALUE_CHARS = 256;
const MAX_USAGE_RECORD_BYTES = 4 * 1024;
const URL_SHAPE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const CREDENTIAL_NAME_PATTERN = /(secret|password|passphrase|credential|token|apikey|api_key|cookie|authorization|bearer)/i;
const FORBIDDEN_PROVENANCE_NAME_PATTERN =
  /(prompt|instruction|transcript|message_body|body|content|output|answer|endpoint|url|uri|host|address|env|environment|config|settings|header|stderr|stack)/i;

export class OpencodeUsageError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OpencodeUsageError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * One bounded provenance scalar: short text with no absolute path, no URL, and
 * no credential-shaped content. Provenance names identities, never payloads.
 */
function assertBoundedProvenanceValue(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OpencodeUsageError("usage_identity_invalid", `Usage field ${field} must be a finite number.`, { field });
    }
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new OpencodeUsageError("usage_identity_invalid", `Usage field ${field} must be bounded text.`, { field });
  }
  if (value.length > MAX_IDENTITY_VALUE_CHARS) {
    throw new OpencodeUsageError("usage_identity_invalid", `Usage field ${field} exceeds its bound.`, { field });
  }
  if (value.startsWith("/") || /\s/.test(value) || URL_SHAPE_PATTERN.test(value)) {
    throw new OpencodeUsageError(
      "usage_provenance_excluded",
      `Usage field ${field} looks like a path or endpoint; provenance carries identities, not configuration.`,
      { field }
    );
  }
  if (CREDENTIAL_NAME_PATTERN.test(value)) {
    throw new OpencodeUsageError(
      "usage_provenance_excluded",
      `Usage field ${field} carries credential-shaped text.`,
      { field }
    );
  }
  return value;
}

function assertAdmittedFieldName(field) {
  if (CREDENTIAL_NAME_PATTERN.test(field) || FORBIDDEN_PROVENANCE_NAME_PATTERN.test(field)) {
    throw new OpencodeUsageError(
      "usage_provenance_excluded",
      `Usage records exclude ${field}: prompt bodies, transcripts, tool events, raw errors, endpoints, ` +
        `credentials, and arbitrary Server metadata never become usage provenance.`,
      { field }
    );
  }
  return field;
}

/** Refuse any field whose very name claims an inference this runtime cannot make. */
export function assertNoInferredUsageFields(value, label = "usage record") {
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (OPENCODE_FORBIDDEN_INFERRED_FIELDS.includes(key)) {
        throw new OpencodeUsageError(
          "usage_inference_forbidden",
          `${label} declares ${path}${key}, which would infer provider behaviour this runtime cannot observe.`,
          { field: key }
        );
      }
      walk(child, `${path}${key}.`);
    }
  };
  walk(value, "");
  return value;
}

/**
 * The canonical, order-independent identity text one usage key is derived from.
 * Exported so a test can prove that two identities differing only in Harness
 * produce different text, and that field order alone produces identical text.
 */
export function canonicalOpencodeUsageIdentityText(identity) {
  let fields;
  try {
    fields = plainRecordSnapshot(identity, "OpenCode usage identity");
  } catch (error) {
    throw new OpencodeUsageError("usage_identity_invalid", error.message);
  }
  for (const field of Object.keys(fields)) {
    if (!OPENCODE_USAGE_KEY_FIELDS.includes(field)) {
      throw new OpencodeUsageError(
        "usage_identity_invalid",
        `An OpenCode usage identity declares an unknown field: ${field}.`,
        { field }
      );
    }
  }
  const normalized = {};
  for (const field of OPENCODE_USAGE_KEY_FIELDS) {
    if (fields[field] === undefined || fields[field] === null) {
      throw new OpencodeUsageError(
        "usage_identity_incomplete",
        `An OpenCode usage record requires ${field}; unattributable usage is refused.`,
        { field }
      );
    }
    normalized[field] = assertBoundedProvenanceValue(fields[field], field);
  }
  // Sorted keys: two records naming the same turn are one record regardless of
  // the order their fields were assembled in.
  return OPENCODE_USAGE_KEY_FIELDS.map((field) => `${field}=${JSON.stringify(normalized[field])}`).join("\n");
}

/**
 * The stable key of one usage record. Two turns share a key only when all
 * eleven identity fields match, so the same full model string served by a
 * different Harness, instance, Driver version, topology, or authority is a
 * different key and can never be summed into one number.
 */
export function opencodeUsageKey(identity) {
  const text = canonicalOpencodeUsageIdentityText(identity);
  return `ocu${OPENCODE_USAGE_RECORD_VERSION}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

function frozenIdentity(identity) {
  const fields = plainRecordSnapshot(identity, "OpenCode usage identity");
  const normalized = {};
  for (const field of OPENCODE_USAGE_KEY_FIELDS) normalized[field] = fields[field];
  return Object.freeze(normalized);
}

/**
 * Validate the persistent-Server reuse facts. This is the 6.5 boundary: the
 * record is proven to carry no cache, price, or charge field, so a reader cannot
 * mistake a latency or a Server version for provider cache evidence.
 */
export function buildOpencodeServerReuseFacts(observed = {}) {
  let fields;
  try {
    fields = plainRecordSnapshot(observed, "OpenCode Server reuse facts");
  } catch (error) {
    throw new OpencodeUsageError("usage_identity_invalid", error.message);
  }
  for (const field of Object.keys(fields)) {
    if (!OPENCODE_SERVER_REUSE_FIELDS.includes(field)) {
      throw new OpencodeUsageError(
        "usage_provenance_excluded",
        `Server reuse facts do not admit ${field}.`,
        { field }
      );
    }
    assertAdmittedFieldName(field);
  }
  // The two derived flags are re-admitted so this builder is idempotent over its
  // own output, and only at their one honest value: a caller can restate that
  // nothing was proven, never that something was.
  for (const field of ["serverIncarnationProven", "derivedFromCacheTelemetry"]) {
    if (fields[field] !== undefined && fields[field] !== false) {
      throw new OpencodeUsageError(
        "usage_provenance_excluded",
        `Server reuse facts cannot claim ${field}: this route proves no Server incarnation and derives ` +
          `nothing from cache telemetry.`,
        { field }
      );
    }
  }
  const latencyMs = Number.isSafeInteger(fields.latencyMs) && fields.latencyMs >= 0 ? fields.latencyMs : null;
  if (fields.latencyMs != null && latencyMs === null) {
    throw new OpencodeUsageError("usage_identity_invalid", "An observed latency must be a non-negative integer.", {
      field: "latencyMs",
    });
  }
  const serverVersion =
    fields.serverVersion == null ? null : assertBoundedProvenanceValue(fields.serverVersion, "serverVersion");
  const sessionLifecycle = fields.sessionLifecycle ?? OPENCODE_SESSION_LIFECYCLE_VALUES[0];
  if (!OPENCODE_SESSION_LIFECYCLE_VALUES.includes(sessionLifecycle)) {
    throw new OpencodeUsageError("usage_identity_invalid", "Unsupported session lifecycle.", {
      field: "sessionLifecycle",
    });
  }
  return assertNoInferredUsageFields(
    Object.freeze({
      // Plugin-observed wall clock. Nothing is derived from it: it is not a
      // cache signal, not a price, and not evidence about the provider.
      latencyMs,
      serverVersion,
      sessionLifecycle,
      // The compatibility probe found no authoritative incarnation field, so a
      // persistent Server can never be proven to be the same Server.
      serverIncarnationProven: false,
      derivedFromCacheTelemetry: false,
    }),
    "Server reuse facts"
  );
}

function frozenProviderMetrics(providerMetrics) {
  if (providerMetrics == null) return null;
  let fields;
  try {
    fields = plainRecordSnapshot(providerMetrics, "OpenCode provider metrics");
  } catch (error) {
    throw new OpencodeUsageError("usage_identity_invalid", error.message);
  }
  for (const field of Object.keys(fields)) {
    if (![...OPENCODE_PROVIDER_METRIC_FIELDS, "provenance", "malformedFields"].includes(field)) {
      throw new OpencodeUsageError("usage_provenance_excluded", `Provider metrics do not admit ${field}.`, { field });
    }
  }
  if (fields.provenance !== "provider_reported") {
    throw new OpencodeUsageError(
      "usage_provenance_invalid",
      "Provider metrics must declare provider_reported provenance; no value here is computed or inferred."
    );
  }
  const normalized = { provenance: "provider_reported" };
  for (const field of OPENCODE_PROVIDER_METRIC_FIELDS) {
    const value = fields[field];
    if (value === null || value === undefined) {
      normalized[field] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new OpencodeUsageError("usage_identity_invalid", `Provider metric ${field} is not an exact fact.`, {
        field,
      });
    }
    normalized[field] = value;
  }
  const malformed = Array.isArray(fields.malformedFields) ? [...fields.malformedFields] : [];
  for (const field of malformed) {
    if (!OPENCODE_PROVIDER_METRIC_FIELDS.includes(field)) {
      throw new OpencodeUsageError("usage_identity_invalid", "A malformed-field marker names an unknown metric.", {
        field,
      });
    }
  }
  normalized.malformedFields = Object.freeze(malformed.sort());
  return Object.freeze(normalized);
}

function frozenPluginCounters(counters = {}) {
  let fields;
  try {
    fields = plainRecordSnapshot(counters, "OpenCode plugin counters");
  } catch (error) {
    throw new OpencodeUsageError("usage_identity_invalid", error.message);
  }
  const normalized = {};
  for (const field of Object.keys(fields)) {
    if (!OPENCODE_USAGE_PLUGIN_FIELDS.includes(field)) {
      throw new OpencodeUsageError("usage_provenance_excluded", `Plugin counters do not admit ${field}.`, { field });
    }
  }
  for (const field of OPENCODE_USAGE_PLUGIN_FIELDS) {
    const value = fields[field];
    if (value === null || value === undefined) {
      normalized[field] = null;
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OpencodeUsageError("usage_identity_invalid", `Plugin counter ${field} must be a non-negative integer.`, {
        field,
      });
    }
    normalized[field] = value;
  }
  return Object.freeze(normalized);
}

/**
 * Build one bounded, route-keyed usage record.
 *
 * @param {{identity: object, status: string, providerMetrics?: object|null,
 *   plugin?: object, serverReuse?: object}} input
 */
export function buildOpencodeUsageRecord(input) {
  let fields;
  try {
    fields = plainRecordSnapshot(input, "OpenCode usage record input");
  } catch (error) {
    throw new OpencodeUsageError("usage_identity_invalid", error.message);
  }
  for (const field of Object.keys(fields)) {
    if (!["identity", "status", "providerMetrics", "plugin", "serverReuse"].includes(field)) {
      throw new OpencodeUsageError("usage_provenance_excluded", `A usage record does not admit ${field}.`, { field });
    }
  }
  if (!OPENCODE_USAGE_STATUS_VALUES.includes(fields.status)) {
    throw new OpencodeUsageError("usage_identity_invalid", "A usage record requires a closed terminal status.", {
      field: "status",
    });
  }
  const key = opencodeUsageKey(fields.identity);
  const record = Object.freeze({
    version: OPENCODE_USAGE_RECORD_VERSION,
    key,
    identity: frozenIdentity(fields.identity),
    status: fields.status,
    provider: frozenProviderMetrics(fields.providerMetrics ?? null),
    plugin: frozenPluginCounters(fields.plugin ?? {}),
    serverReuse: buildOpencodeServerReuseFacts(fields.serverReuse ?? {}),
  });
  assertNoInferredUsageFields(record, "usage record");
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded, "utf8") > MAX_USAGE_RECORD_BYTES) {
    throw new OpencodeUsageError("usage_record_too_large", "The usage record exceeds its durable bound.");
  }
  return record;
}
