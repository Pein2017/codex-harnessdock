/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Closed capability vocabulary for Harness Drivers.
 *
 * A capability states what the Harness can be observed to do for one Agent
 * turn. It never advertises model quality, and it is never supplied, widened,
 * or overridden by a caller: every snapshot originates in checkout-owned Driver
 * source and is persisted with the turn it launched.
 */

import { plainRecordSnapshot } from "./plain-record.mjs";

export const HARNESS_CAPABILITY_VALUES = Object.freeze({
  activeInput: Object.freeze(["acknowledged_active_stream", "initial_only"]),
  continuation: Object.freeze(["exact_resume", "fresh_only"]),
  history: Object.freeze(["assistant_messages", "unavailable"]),
  interrupt: Object.freeze(["graceful_flush_proven", "best_effort_signal", "unsupported"]),
  automaticRecovery: Object.freeze(["exact_session_transport", "same_session_recovery_prompt", "none"]),
  authorityEnforcement: Object.freeze(["process_sandbox", "prompt_only"]),
  leafEnforcement: Object.freeze(["effective_tool_denial", "prompt_only"]),
  nativeOrchestration: Object.freeze(["opaque_bounded", "disabled"]),
});

export const HARNESS_CAPABILITY_NAMES = Object.freeze(
  Object.keys(HARNESS_CAPABILITY_VALUES).sort()
);

/**
 * Validate a Driver-published capability snapshot against the closed
 * vocabulary. An unknown capability name, an unknown value, or a missing
 * capability fails here rather than at the native process boundary.
 */
export function validateHarnessCapabilities(snapshot, label = "Harness capability snapshot") {
  // One trap-free descriptor snapshot, read once, exactly like the version-two
  // route validator: a capability that can answer differently to validation
  // than to the durable record it is persisted in is not a capability claim.
  const fields = plainRecordSnapshot(snapshot, label);
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const name of HARNESS_CAPABILITY_NAMES) {
    const value = fields[name];
    if (!HARNESS_CAPABILITY_VALUES[name].includes(value)) {
      throw new Error(
        `${label} has an unsupported ${name} value: ${JSON.stringify(value ?? null)}. ` +
        `Use one of: ${HARNESS_CAPABILITY_VALUES[name].join(", ")}.`
      );
    }
    normalized[name] = value;
  }
  for (const name of Object.keys(fields)) {
    if (!HARNESS_CAPABILITY_NAMES.includes(name)) {
      throw new Error(`${label} declares an unknown capability: ${name}.`);
    }
  }
  return Object.freeze(normalized);
}

/**
 * Fail closed before a lifecycle operation the persisted snapshot does not
 * admit. `admitted` is the closed set of values under which the operation is
 * proven; anything else refuses without mutating Agent continuity.
 */
export function assertHarnessCapability(snapshot, name, admitted, detail) {
  if (!HARNESS_CAPABILITY_NAMES.includes(name)) {
    throw new Error(`Unknown Harness capability: ${name}.`);
  }
  const value = validateHarnessCapabilities(snapshot)[name];
  if (!admitted.includes(value)) {
    throw new Error(`${detail} (${name}=${value}).`);
  }
  return value;
}

/**
 * Version-two route capabilities.
 *
 * A version-two snapshot belongs to one accepted `(Harness, logical instance,
 * canonical route, Driver version)` tuple, not to a Driver module in the
 * abstract: the same Driver may admit live steering on one instance and initial
 * input only on another. Maturity is recorded per dimension so one experimental
 * capability can be refused without disabling an otherwise validated route.
 *
 * The version-one vocabulary above stays in place until the Claude Driver is
 * wrapped in Contract v2; the two never merge, because version one encodes
 * process-shaped interruption instead of a request/settlement split.
 */
export const ROUTE_CAPABILITY_SCHEMA_VERSION = 4;

export const ROUTE_CAPABILITY_VALUES = Object.freeze({
  interaction: Object.freeze(["noninteractive_fixed_policy", "requires_broker"]),
  activeInput: Object.freeze(["acknowledged_active_stream", "initial_only"]),
  continuation: Object.freeze(["exact_resume", "fresh_only", "none"]),
  history: Object.freeze(["assistant_messages", "unavailable"]),
  interruptRequest: Object.freeze(["supported", "unsupported"]),
  turnObservation: Object.freeze(["terminal_observable", "unavailable"]),
  nativeProgress: Object.freeze(["native_coalesced", "supervisor_projected", "unavailable"]),
  automaticRecovery: Object.freeze(["exact_session_transport", "same_session_recovery_prompt", "none"]),
  authorityEnforcement: Object.freeze(["prompt_only", "harness_policy", "process_sandbox"]),
  leafEnforcement: Object.freeze(["effective_tool_denial", "prompt_only", "unsupported"]),
  nativeOrchestration: Object.freeze(["opaque_bounded", "disabled"]),
});

export const ROUTE_CAPABILITY_NAMES = Object.freeze(
  Object.keys(ROUTE_CAPABILITY_VALUES).sort()
);

export const CAPABILITY_MATURITY_VALUES = Object.freeze(["experimental", "validated"]);
export const ROUTE_CAPABILITY_PROVENANCE_VALUES = Object.freeze([
  "checkout_declared",
  "inspection_proven",
  "session_negotiated",
]);

/**
 * Interaction values this generation may actually run. `requires_broker` stays
 * in the discoverable vocabulary so a route can explain why it is refused; it
 * never becomes an approval prompt, a TUI wait, or an auto-approval.
 */
export const ADMITTED_INTERACTION_VALUES = Object.freeze(["noninteractive_fixed_policy"]);

/**
 * Validate one route-qualified capability snapshot. Unknown dimensions, unknown
 * values, missing dimensions, missing maturity, and a foreign schema version all
 * fail here, before an Agent, lease, or native turn exists.
 */
export function validateRouteCapabilityProvenance(
  provenance,
  label = "Route capability provenance",
  { capabilityNames = ROUTE_CAPABILITY_NAMES } = {},
) {
  const fields = plainRecordSnapshot(provenance, label);
  /** @type {Record<string, string>} */
  const normalized = {};
  for (const name of capabilityNames) {
    const value = fields[name];
    if (!ROUTE_CAPABILITY_PROVENANCE_VALUES.includes(value)) {
      throw new Error(
        `${label} has an unsupported ${name} value: ${JSON.stringify(value ?? null)}. ` +
        `Use one of: ${ROUTE_CAPABILITY_PROVENANCE_VALUES.join(", ")}.`
      );
    }
    normalized[name] = value;
  }
  for (const name of Object.keys(fields)) {
    if (!capabilityNames.includes(name)) {
      throw new Error(`${label} declares an unknown capability provenance: ${name}.`);
    }
  }
  return Object.freeze(normalized);
}

export function validateRouteCapabilitySnapshot(snapshot, label = "Route capability snapshot", { allowSchemaV2 = false, allowSchemaV3 = false } = {}) {
  // Every field is read exactly once, from one descriptor snapshot of an
  // ordinary object. A Proxy, accessor, hidden, symbol-keyed, or inherited
  // field is refused here: a route snapshot that can answer differently to a
  // validator than to a Driver, a durable record, or a receipt is not evidence.
  const fields = plainRecordSnapshot(snapshot, label);
  const declaredSchemaVersion = fields.capabilitySchemaVersion;
  const declaredDriverMaturity = fields.driverMaturity;
  if (declaredSchemaVersion !== ROUTE_CAPABILITY_SCHEMA_VERSION &&
      !(allowSchemaV2 && declaredSchemaVersion === 2) &&
      !(allowSchemaV3 && declaredSchemaVersion === 3)) {
    throw new Error(
      `${label} declares capability schema version ${JSON.stringify(declaredSchemaVersion ?? null)}; ` +
      `this runtime requires ${ROUTE_CAPABILITY_SCHEMA_VERSION}.`
    );
  }
  if (!CAPABILITY_MATURITY_VALUES.includes(declaredDriverMaturity)) {
    throw new Error(
      `${label} has an unsupported Driver maturity: ${JSON.stringify(declaredDriverMaturity ?? null)}. ` +
      `Use one of: ${CAPABILITY_MATURITY_VALUES.join(", ")}.`
    );
  }
  const legacySchema = declaredSchemaVersion === 2;
  for (const [part, name] of [[fields.values, "values"], [fields.maturity, "maturity"],
    ...(legacySchema ? [] : [[fields.provenance, "provenance"]])]) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error(`${label} must carry a capability ${name} object.`);
    }
  }
  const values = plainRecordSnapshot(fields.values, `${label} capability values`);
  const maturity = plainRecordSnapshot(fields.maturity, `${label} capability maturity`);
  const capabilityNames = declaredSchemaVersion < ROUTE_CAPABILITY_SCHEMA_VERSION &&
      !Object.hasOwn(values, "nativeProgress")
    ? ROUTE_CAPABILITY_NAMES.filter((name) => name !== "nativeProgress")
    : ROUTE_CAPABILITY_NAMES;
  const provenance = legacySchema ? null : validateRouteCapabilityProvenance(
    fields.provenance, `${label} capability provenance`, { capabilityNames }
  );
  /** @type {Record<string, string>} */
  const normalizedValues = {};
  /** @type {Record<string, string>} */
  const normalizedMaturity = {};
  for (const name of capabilityNames) {
    const value = values[name];
    if (!ROUTE_CAPABILITY_VALUES[name].includes(value)) {
      throw new Error(
        `${label} has an unsupported ${name} value: ${JSON.stringify(value ?? null)}. ` +
        `Use one of: ${ROUTE_CAPABILITY_VALUES[name].join(", ")}.`
      );
    }
    const declaredMaturity = maturity[name];
    if (!CAPABILITY_MATURITY_VALUES.includes(declaredMaturity)) {
      throw new Error(
        `${label} has an unsupported ${name} maturity: ${JSON.stringify(declaredMaturity ?? null)}. ` +
        `Use one of: ${CAPABILITY_MATURITY_VALUES.join(", ")}.`
      );
    }
    normalizedValues[name] = value;
    normalizedMaturity[name] = declaredMaturity;
  }
  for (const [part, partLabel] of [[values, "capability"], [maturity, "capability maturity"],
    ...(provenance == null ? [] : [[provenance, "capability provenance"]])]) {
    for (const name of Object.keys(part)) {
      if (!capabilityNames.includes(name)) {
        throw new Error(`${label} declares an unknown ${partLabel}: ${name}.`);
      }
    }
  }
  for (const key of Object.keys(fields)) {
    if (!["capabilitySchemaVersion", "driverMaturity", "values", "maturity", ...(legacySchema ? [] : ["provenance"])].includes(key)) {
      throw new Error(`${label} declares an unknown field: ${key}.`);
    }
  }
  return Object.freeze({
    capabilitySchemaVersion: declaredSchemaVersion,
    driverMaturity: declaredDriverMaturity,
    values: Object.freeze(normalizedValues),
    maturity: Object.freeze(normalizedMaturity),
    ...(provenance == null ? {} : { provenance }),
  });
}

/** The recorded maturity of one dimension of an accepted route. */
export function capabilityMaturity(snapshot, name) {
  if (!ROUTE_CAPABILITY_NAMES.includes(name)) {
    throw new Error(`Unknown Harness capability: ${name}.`);
  }
  return validateRouteCapabilitySnapshot(snapshot).maturity[name];
}

/**
 * Fail closed before an operation the accepted route does not admit. Refusing
 * one dimension never disables the rest of the route or another instance.
 */
export function assertRouteCapability(snapshot, name, admitted, detail) {
  if (!ROUTE_CAPABILITY_NAMES.includes(name)) {
    throw new Error(`Unknown Harness capability: ${name}.`);
  }
  const value = validateRouteCapabilitySnapshot(snapshot).values[name];
  if (!admitted.includes(value)) {
    throw new Error(`${detail} (${name}=${value}).`);
  }
  return value;
}

/**
 * Refuse a route whose interaction policy needs an approval broker. The first
 * multi-Harness generation reports such a route unavailable instead of waiting
 * on a terminal UI or approving on the caller's behalf.
 */
export function assertAdmittedInteraction(snapshot, label = "Harness route") {
  const value = validateRouteCapabilitySnapshot(snapshot).values.interaction;
  if (!ADMITTED_INTERACTION_VALUES.includes(value)) {
    throw new Error(
      `${label} is unavailable: it requires an approval broker (interaction=${value}). ` +
      `This generation admits only: ${ADMITTED_INTERACTION_VALUES.join(", ")}.`
    );
  }
  return value;
}
