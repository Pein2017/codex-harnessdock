/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exact version-three durable state fixtures.
 *
 * These records are what the dependent multi-Harness generation will write.
 * They deliberately name a non-Claude Harness: a fixture that could be read as
 * Claude Code would hide the very defaulting this version forbids. Every route
 * field is stated; nothing here may be inferred, defaulted, or back-filled.
 */

import { JOB_STATE_VERSION_V3 } from "../../../runtime/durable-state-v3.mjs";
import { ROUTE_CAPABILITY_SCHEMA_VERSION } from "../../../runtime/harness-capabilities.mjs";

import { FAKE_SERVICE_DRIVER_VERSION, FAKE_SERVICE_HARNESS_ID } from "./fake-service-driver.mjs";

export const V3_HARNESS_ID = FAKE_SERVICE_HARNESS_ID;
export const V3_DRIVER_VERSION = FAKE_SERVICE_DRIVER_VERSION;
export const V3_INSTANCE_KEY = "tenant-alpha";

/** The exact capability snapshot a version-three route freezes at creation. */
export function versionThreeCapabilities(overrides = {}) {
  return {
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    driverMaturity: "experimental",
    ...overrides,
    values: {
      interaction: "noninteractive_fixed_policy",
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "unavailable",
      interruptRequest: "supported",
      turnObservation: "terminal_observable",
      nativeProgress: "unavailable",
      automaticRecovery: "none",
      authorityEnforcement: "harness_policy",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
      ...(overrides.values ?? {}),
    },
    maturity: {
      interaction: "validated",
      activeInput: "experimental",
      continuation: "experimental",
      history: "validated",
      interruptRequest: "experimental",
      turnObservation: "experimental",
      nativeProgress: "validated",
      automaticRecovery: "validated",
      authorityEnforcement: "validated",
      leafEnforcement: "validated",
      nativeOrchestration: "validated",
      ...(overrides.maturity ?? {}),
    },
    provenance: {
      ...Object.fromEntries([
        "interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "nativeProgress",
        "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration",
      ].map((name) => [name, "checkout_declared"])),
      ...(overrides.provenance ?? {}),
    },
  };
}

/** The immutable version-three route identity, stated in full. */
export function versionThreeRoute(overrides = {}) {
  return {
    harnessId: V3_HARNESS_ID,
    instanceKey: V3_INSTANCE_KEY,
    model: "fake-service-large",
    topology: "leaf",
    authority: "behavioral_read_only",
    effort: "high",
    driverVersion: V3_DRIVER_VERSION,
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    capabilities: versionThreeCapabilities(),
    ...overrides,
  };
}

/** A real pre-effort version-three route: readable history, never a new transport route. */
export function legacyVersionThreeRoute(overrides = {}) {
  const { effort: _effort, ...route } = versionThreeRoute(overrides);
  return route;
}

/**
 * A version-three Agent record as the future generation persists it. The
 * neutral container fields (`rootThreadId`, `status`, `createdAt`/`updatedAt`)
 * keep their existing durable names; version three replaces the flattened
 * Claude-shaped identity with one immutable `route`.
 */
export function versionThreeAgentRecord(base, overrides = {}) {
  const timestamp = base?.createdAt ?? "2026-08-13T00:00:00.000Z";
  return {
    version: 3,
    agentId: base.agentId,
    rootThreadId: base.rootThreadId,
    workspaceRoot: base.workspaceRoot,
    name: base.name,
    normalizedName: base.normalizedName,
    path: base.path,
    description: base.description ?? null,
    route: versionThreeRoute(),
    activeJobId: null,
    latestJobId: null,
    nativeSessionRef: null,
    status: "pending_init",
    continuation: { mode: "safe_fresh", evidence: { reason: "new_agent_no_session" } },
    latestCompletionSequence: 0,
    lastTerminalJobId: null,
    finalizedJobIds: [],
    mailbox: { version: 1, nextSequence: 1, messages: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** A serialized pre-effort Agent fixture retained for inspection compatibility. */
export function legacyVersionThreeAgentRecord(base, overrides = {}) {
  return versionThreeAgentRecord(base, { route: legacyVersionThreeRoute(), ...overrides });
}

/** A version-three job record an older runtime must refuse to own. */
export function versionThreeJobRecord(overrides = {}) {
  return {
    id: "job-v3-1",
    harnessStateVersion: JOB_STATE_VERSION_V3,
    status: "running",
    route: versionThreeRoute(),
    ...overrides,
  };
}
