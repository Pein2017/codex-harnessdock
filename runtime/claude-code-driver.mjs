/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The `claude-code` Harness Driver.
 *
 * This module composes the established Claude owners — executable discovery,
 * environment, execution profile, version compatibility, stream-json session,
 * durable steering, transport recovery, process control, and native history —
 * behind the turn-level Driver contract. It re-implements none of them, so the
 * observable Claude behavior is exactly what those owners already produce.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cancelClaudeProcess,
  getClaudeAuthStatus,
  getClaudeAvailability,
  interruptClaudeProcess,
  requestClaudeInterrupt,
  sanitizeUnknownEventSummary,
} from "./claude-headless-adapter.mjs";
import { inspectClaudeAgentSdkRoutes } from "./claude-agent-sdk-inspector.mjs";
import { observeClaudeCredentialState } from "./claude-credential-state.mjs";
import { readBoundClaudeAgentMessages } from "./claude-session-history.mjs";
import {
  assertPreparedClaudeCompatibility,
  formatClaudeCompatibilityError,
  inspectClaudeCompatibility,
  recordNativeTeamCompatibilityObservation,
  recordSuccessfulClaudeTurn,
} from "./claude-version-compatibility.mjs";
import {
  createExecutionProfile,
  delegationEnvelopeFacts,
  validateExecutionProfileOptions,
} from "./execution-profile.mjs";
import { resolveNativeTeamPolicy } from "./claude-native-team-policy.mjs";
import { redactedClaudeInstanceKey } from "./claude-legacy-adapter.mjs";
import { AGENT_RECORD_VERSION_V3 } from "./durable-state-v3.mjs";
import {
  DRIVER_CONTRACT_VERSION_V2,
  HARNESS_DRIVER_CONTRACT_VERSION,
  MAX_ABSENCE_REASON_CHARS,
  MAX_FAILURE_REASON_CHARS,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PROGRESS_BYTES,
  boundedDriverReceipt,
  canonicalNativeSessionRef,
  driverPreTransportRejection,
} from "./harness-contract.mjs";
import { ROUTE_CAPABILITY_NAMES, ROUTE_CAPABILITY_SCHEMA_VERSION } from "./harness-capabilities.mjs";
import { isAdmittedHarnessTurnFailureClass } from "./harness-failure-classes.mjs";
import {
  NATIVE_REFERENCE_ENVELOPE_VERSION,
  validateNativeReferenceEnvelope,
} from "./native-reference.mjs";
import { plainDataTree } from "./plain-record.mjs";
import { enqueueSteeringMessage, getSteeringSnapshot } from "./job-store.mjs";
import { runClaudeTaskSession } from "./job-supervisor.mjs";
import { terminalMetricsFromEvidence } from "./terminal-metrics.mjs";

export const CLAUDE_CODE_HARNESS_ID = "claude-code";
export const CLAUDE_CODE_DRIVER_VERSION = "claude-code@2";


/**
 * Observable behavior of a Claude Code turn under this checkout.
 *
 * `authorityEnforcement` is `prompt_only` deliberately: `terminal-parity`
 * always passes the dangerous permission bypass, so write intent is a
 * behavioral and recovery-risk boundary carried in the delegation prompt, not a
 * process-level security control. `leafEnforcement` is stronger because leaf
 * delegation denies the native Agent tool at the CLI boundary.
 */
export const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  activeInput: "acknowledged_active_stream",
  continuation: "exact_resume",
  history: "assistant_messages",
  interrupt: "graceful_flush_proven",
  automaticRecovery: "same_session_recovery_prompt",
  authorityEnforcement: "prompt_only",
  leafEnforcement: "effective_tool_denial",
  nativeOrchestration: "opaque_bounded",
});

function canonicalPath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/**
 * Claude Code's stable native configuration identity. Two Agents that resolve
 * the same `CLAUDE_CONFIG_DIR` share one session namespace and therefore one
 * ownership scope.
 */
export function resolveClaudeInstanceKey(env = process.env) {
  return canonicalPath(env?.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

function nativeSessionRef(env, nativeSessionId) {
  if (!nativeSessionId) return null;
  try {
    return canonicalNativeSessionRef({
      harnessId: CLAUDE_CODE_HARNESS_ID,
      instanceKey: resolveClaudeInstanceKey(env),
      nativeSessionId,
    });
  } catch {
    return null;
  }
}

function unknownEventSummary(result) {
  return sanitizeUnknownEventSummary(
    result.unknownEvents ?? result.runtimeReceipt?.unknownEvents,
    result.unknownEventCount ?? result.runtimeReceipt?.unknownEventCount,
    result.unknownEventOverflowCount ?? result.runtimeReceipt?.unknownEventOverflowCount,
  );
}

/**
 * Normalize one native Claude turn into the shared terminal result. The
 * supervisor consumes only the normalized fields; `nativeReceipt` remains
 * optional Driver-local diagnostics and is never generic lifecycle evidence.
 */
function recordNativeTeamObservation(cwd, launchCompatibility, delegationMode, nativeTeamSurface) {
  if (nativeTeamSurface == null) return null;
  try {
    recordNativeTeamCompatibilityObservation(
      cwd,
      launchCompatibility,
      delegationMode,
      nativeTeamSurface,
    );
    return { recorded: true, reason: null };
  } catch {
    // Compatibility evidence is useful only when durably recorded. Keep the
    // failure receipt path-free and content-free rather than reporting success.
    return { recorded: false, reason: "native_team_observation_record_failed" };
  }
}

function normalizeTurnResult({
  env,
  result,
  profileReceipt,
  processEvidence,
  compatibility,
  nativeTeamCompatibilityObservation,
}) {
  const rawOutput = String(result.finalMessage ?? "");
  const session = nativeSessionRef(env, result.sessionId ?? null);
  const unknownEvents = unknownEventSummary(result);
  const drifted = result.failureClass === "protocol_session_drift";
  const finalMessagePresent = rawOutput.length > 0;
  const credentialObservation = result.failureClass === "auth_or_permission"
    ? observeClaudeCredentialState({ env })
    : null;
  return {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_DRIVER_VERSION,
    contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
    status: result.status === "completed" ? "completed" : "failed",
    exitStatus: result.status === "completed" ? 0 : (result.exitCode || 1),
    nativeSession: session,
    // Claude proves an exact session only when the transcript identity survived
    // the turn. Drift is refused here rather than becoming a resume target.
    sessionExactness: session && !drifted ? "exact" : "unproven",
    failure: {
      class: result.status === "completed" ? null : (result.failureClass ?? null),
      reason: result.status === "completed" ? null : (result.failureReason ?? null),
      // Bounded native failure text. It renders the turn's message and is
      // deliberately not persisted in the durable receipt.
      detail: result.stderr ?? null,
      resumable: result.resumable === true,
      requiresAttention: Boolean(result.requiresAttention),
    },
    finalMessage: finalMessagePresent ? rawOutput : null,
    finalMessageAbsenceReason: finalMessagePresent
      ? null
      : (result.failureReason ?? result.failureClass ?? "no_outer_assistant_message"),
    process: processEvidence,
    receipts: {
      assistantOutputObserved: result.assistantOutputObserved === true,
      toolUses: result.toolUses ?? [],
      touchedFiles: result.touchedFiles ?? [],
      attempts: result.attempts ?? [],
      recoveryAttempts: result.recoveryAttempts ?? 0,
      steering: result.steering ?? null,
    },
    metrics: terminalMetricsFromEvidence({
      providerReported: result.providerReportedMetrics,
      toolCallCount: Array.isArray(result.attempts)
        ? result.attempts.reduce((count, attempt) =>
          count + (Array.isArray(attempt?.toolUses) ? attempt.toolUses.length : 0), 0)
        : (Array.isArray(result.toolUses) ? result.toolUses.length : 0),
      attemptCount: Array.isArray(result.attempts) ? result.attempts.length : 0,
      recoveryAttemptCount: result.recoveryAttempts ?? 0,
    }),
    warning: result.warning ?? null,
    lastActivityAt: result.lastByteAt ?? null,
    manualContinuationCommand: result.manualResumeCommand ?? null,
    runtime: {
      ...(result.runtimeReceipt ?? {}),
      ...(credentialObservation ? { credentialObservation } : {}),
      ...unknownEvents,
      executionProfile: profileReceipt,
      hostClaudeVersion: compatibility.compatibility?.version ?? null,
      preparedClaudeFingerprint: compatibility.compatibility?.fingerprint ?? null,
      claudeCompatibility: compatibility.compatibility,
      compatibilityObservationRecorded: compatibility.recorded,
      compatibilityObservationReason: compatibility.reason ?? null,
      nativeTeamCompatibilityObservation,
    },
    // Bounded Claude-owned evidence. The supervisor persists it as the turn's
    // native receipt and never reads it as generic proof of ownership,
    // signalling, or continuation.
    nativeReceipt: {
      status: result.status,
      sessionId: result.sessionId ?? null,
      rawOutput,
      partialOutput: rawOutput,
      warning: result.warning ?? null,
      failureClass: result.failureClass ?? null,
      failureReason: result.failureReason ?? null,
      resumable: result.resumable === true,
      recoveryAttempts: result.recoveryAttempts ?? 0,
      attempts: result.attempts ?? [],
      steering: result.steering ?? null,
      runtimeReceipt: {
        ...(result.runtimeReceipt ?? {}),
        ...(credentialObservation ? { credentialObservation } : {}),
        ...unknownEvents,
        executionProfile: profileReceipt,
        claudeCompatibility: compatibility.compatibility,
        compatibilityObservationRecorded: compatibility.recorded,
        compatibilityObservationReason: compatibility.reason ?? null,
        nativeTeamCompatibilityObservation,
      },
      lastByteAt: result.lastByteAt ?? null,
      manualResumeCommand: result.manualResumeCommand ?? null,
      requiresAttention: Boolean(result.requiresAttention),
      assistantOutputObserved: result.assistantOutputObserved === true,
      toolUses: result.toolUses ?? [],
      touchedFiles: result.touchedFiles ?? [],
      ...unknownEvents,
    },
    driverReceipt: boundedDriverReceipt(CLAUDE_CODE_HARNESS_ID, CLAUDE_CODE_DRIVER_VERSION, {
      executionProfile: profileReceipt?.name ?? null,
      failureClass: result.failureClass ?? null,
      recoveryAttempts: result.recoveryAttempts ?? 0,
      attempts: Array.isArray(result.attempts) ? result.attempts.length : 0,
      unknownEvents: unknownEvents.unknownEvents,
      unknownEventCount: unknownEvents.unknownEventCount,
      unknownEventOverflowCount: unknownEvents.unknownEventOverflowCount,
    }),
  };
}

export function createClaudeCodeDriver(_options = {}) {
  return Object.freeze({
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_DRIVER_VERSION,
    contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
    capabilities: CLAUDE_CODE_CAPABILITIES,

    /** Host executable, native configuration, and account readiness. */
    preflight({ cwd, env }) {
      const availability = getClaudeAvailability(cwd, { env });
      const compatibility = inspectClaudeCompatibility(cwd, { availability, env });
      const auth = availability.available
        ? getClaudeAuthStatus(cwd, { env })
        : { available: false, loggedIn: false, detail: availability.detail };
      return {
        ready: Boolean(availability.available && compatibility.staticCompatible && auth.loggedIn),
        availability,
        compatibility,
        auth,
        instanceKey: resolveClaudeInstanceKey(env),
      };
    },

    /** Explain an unready preflight in the Driver's own terms. */
    describeUnreadiness(receipt) {
      if (!receipt.availability?.available) {
        return "Claude Code CLI is unavailable. Install `claude` and ensure it is on PATH.";
      }
      if (!receipt.compatibility?.staticCompatible) {
        return formatClaudeCompatibilityError(receipt.compatibility);
      }
      if (!receipt.auth?.loggedIn) {
        return "Claude Code CLI is not authenticated. Run `claude auth login` in the same environment.";
      }
      return null;
    },

    /**
     * Validate a persisted readiness receipt without re-running host checks.
     * @param {any} receipt
     * @param {{cwd?: string, env?: NodeJS.ProcessEnv, sourceRoot?: string}} [scope]
     */
    validatePreparedPreflight(receipt, scope = {}) {
      const { cwd, env, sourceRoot } = scope;
      if (
        receipt?.ready !== true ||
        receipt?.availability?.available !== true ||
        receipt?.compatibility?.staticCompatible !== true ||
        !String(receipt?.compatibility?.fingerprint ?? "").trim() ||
        !String(receipt?.compatibility?.executable ?? "").trim() ||
        receipt?.auth?.loggedIn !== true ||
        receipt?.cwd !== cwd ||
        receipt?.claudeConfigDir !== (env?.CLAUDE_CONFIG_DIR ?? null) ||
        receipt?.sourceRoot !== sourceRoot
      ) {
        throw new Error("Internal start received an invalid readiness receipt.");
      }
      return receipt;
    },

    /**
     * Re-prove the prepared executable immediately before the native turn.
     * @param {any} receipt
     * @param {{cwd?: string, env?: NodeJS.ProcessEnv, sourceRoot?: string}} [scope]
     */
    revalidatePreparedPreflight(receipt, scope = {}) {
      const { cwd, env, sourceRoot } = scope;
      const prepared = this.validatePreparedPreflight(receipt, { cwd, env, sourceRoot });
      const availability = getClaudeAvailability(cwd, { env });
      const compatibility = assertPreparedClaudeCompatibility(
        cwd,
        prepared.compatibility,
        { availability, env },
      );
      return Object.freeze({ availability, compatibility });
    },

    resolveInstanceKey(env) {
      return resolveClaudeInstanceKey(env);
    },

    /** The Driver alone decides which models, efforts, and topologies exist. */
    validateRoute(route = {}) {
      return validateExecutionProfileOptions(route);
    },

    /** Durable supervisor-assigned input for an already-running turn. */
    assignInput({ cwd, jobId, text, kind, messageId }) {
      return enqueueSteeringMessage(cwd, jobId, text, { kind, messageId });
    },

    interruptTurn({ pid, pidIdentity }) {
      return interruptClaudeProcess(pid, pidIdentity);
    },

    cancelTurn({ pid, pidIdentity }) {
      return cancelClaudeProcess(pid, pidIdentity);
    },

    readAssistantHistory(agent, options) {
      return readBoundClaudeAgentMessages(agent, options);
    },

    /** One complete Claude turn, including its bounded in-turn recovery. */
    async startTurn({
      workspaceRoot,
      cwd,
      jobId,
      prompt,
      route,
      env,
      launchContext,
      sessionName,
      resumeSessionId,
      onProgress,
      onSpawn,
      // Internal test seam for bounded native-team observations. Public jobs
      // never provide this callback and no observation is persisted here.
      onNativeTeamWitness,
      // Kept internal to this Driver so parity fixtures can capture the exact
      // native envelope without launching Claude. No public or ambient input
      // reaches it.
      runTurnSession = runClaudeTaskSession,
    }) {
      const launchCompatibility = launchContext?.compatibility;
      if (!launchCompatibility?.executable) {
        throw new Error("Claude Code Driver requires a revalidated launch context.");
      }
      const profile = createExecutionProfile({ ...route, env, jobId });
      // Native teammates exist only in this Claude process. A transport loss
      // may leave their in-process state ambiguous, so only an explicit later
      // parent follow-up may create a new team.
      const retryPolicy = route.delegationMode === "claude_orchestrator"
        ? { maxReconnectAttempts: 0 }
        : undefined;
      const processEvidence = { spawnAccepted: false, identityProven: false };
      try {
        const result = await runTurnSession({
          workspaceRoot,
          jobId,
          cwd,
          prompt,
          write: Boolean(route.write),
          automaticRecovery: CLAUDE_CODE_CAPABILITIES.automaticRecovery,
          ...(retryPolicy ? { retryPolicy } : {}),
          claudeOptions: {
            ...profile.claudeOptions,
            claudeBin: launchCompatibility.executable,
            delegationMode: route.delegationMode,
            ...(onNativeTeamWitness ? { onNativeTeamWitness } : {}),
            sessionName: sessionName ?? undefined,
            resumeSessionId: resumeSessionId ?? undefined,
          },
          harnessInstance: {
            harnessId: CLAUDE_CODE_HARNESS_ID,
            instanceKey: resolveClaudeInstanceKey(env),
          },
          onProgress,
          onSpawn: async (receipt) => {
            const accepted = onSpawn ? await onSpawn(receipt) : true;
            if (accepted === true) {
              processEvidence.spawnAccepted = true;
              processEvidence.identityProven = Boolean(receipt?.pidIdentity);
            }
            return accepted;
          },
        });
        const nativeTeamCompatibilityObservation = recordNativeTeamObservation(
          cwd,
          launchCompatibility,
          route.delegationMode,
          result.runtimeReceipt?.nativeTeamSurface,
        );
        const compatibility = result.status === "completed"
          ? recordSuccessfulClaudeTurn(
              cwd,
              launchCompatibility,
              result.runtimeReceipt?.claudeCodeVersion,
              { env },
            )
          : {
              recorded: false,
              compatibility: launchCompatibility,
              runtimeVersion: result.runtimeReceipt?.claudeCodeVersion ?? null,
            };
        const normalized = normalizeTurnResult({
          env,
          result,
          profileReceipt: profile.receipt,
          processEvidence,
          compatibility,
          nativeTeamCompatibilityObservation,
        });
        normalized.nativeReceipt.steering ??= getSteeringSnapshot(cwd, jobId);
        normalized.receipts.steering ??= normalized.nativeReceipt.steering;
        return normalized;
      } finally {
        profile.cleanup();
      }
    },
  });
}

// ===========================================================================
// Driver Contract v2
//
// The same Claude owners, behind the process-neutral contract. Everything
// below wraps the established stream-json session: it starts no second
// transport, parser, recovery policy, or process supervisor, and it publishes
// only what those owners already proved.
//
// The version-one Driver above is untouched and remains the production path
// until a later change moves the public generation onto this one.
// ===========================================================================

/**
 * The Claude Driver generation that implements Driver Contract v2. It is a
 * distinct Driver version from the version-one `claude-code@2`, so a durable
 * record, native reference, or receipt written by one can never be read as the
 * other's.
 */
export const CLAUDE_CODE_V2_DRIVER_VERSION = "claude-code@3";

/** Locator schema generation for both Claude native reference kinds. */
export const CLAUDE_LOCATOR_VERSION = 1;

const V2_DRIVER_TITLE = "Claude Code CLI (stream-json)";

/** The one fixed configuration value the Driver scope exposes. */
const V2_ENVIRONMENT_KEYS = Object.freeze(["CLAUDE_CONFIG_DIR"]);

/** Domain separator for the Driver's own prepared-input digest. */
const PREPARED_INPUT_DIGEST_DOMAIN = "claude-code-driver-v2-prepared-input";

/** Bounded durable text limits this Driver applies before contract validation. */
const MAX_WARNING_CHARS = 1024;
const MAX_PROGRESS_SAMPLE_ENTRIES = 32;
const MAX_PROGRESS_SAMPLE_CHARS = 256;
const MAX_PROGRESS_ATTEMPT_ENTRIES = 16;

/** Closed reasons this Driver may give for its owned-work settlement. */
export const CLAUDE_SETTLEMENT_REASONS = Object.freeze([
  "process_close_with_classified_result",
  "native_turn_evidence_unresolved",
  "contradictory_native_evidence",
]);

/**
 * Claude Code's logical instance is its native configuration directory: two
 * Agents that resolve the same `CLAUDE_CONFIG_DIR` share one session namespace
 * and one ownership scope. Driver Contract v2 requires a stable *redacted*
 * instance key, so the canonical path is hashed rather than published: an
 * operator diagnostic can name the blocked instance without printing where the
 * operator keeps their Claude configuration.
 */
export function claudeCodeInstanceKey(configDir) {
  // One owner for the path-to-redacted translation. `claude-legacy-adapter.mjs`
  // already owns the canonical Claude configuration identity for legacy state,
  // so the version-three instance namespace cannot drift from this Driver's own
  // key by holding a second copy of the same derivation.
  return redactedClaudeInstanceKey(String(configDir ?? "").trim() || undefined);
}

/**
 * Reconcile the version-one Claude instance identity (`resolveClaudeInstanceKey`,
 * a canonical configuration path) with this Driver's redacted version-two
 * instance key. Both generations name exactly one native Claude configuration;
 * this is a pure hash, so it never reads or rewrites any legacy Agent record
 * and it never returns the raw path either way. It exists so the same native
 * configuration cannot occupy two logical lease namespaces once both
 * generations can run.
 */
export function reconcileLegacyClaudeInstanceKey(legacyInstanceKey) {
  return claudeCodeInstanceKey(legacyInstanceKey);
}

/**
 * The legacy delegation mode one version-two topology means. Exported so the
 * public spawn path translates a stated topology through this Driver's own
 * mapping rather than a second copy that could drift.
 */
export function delegationModeForTopology(topology) {
  if (topology === "native_orchestrator") return "claude_orchestrator";
  if (topology === "leaf") return "leaf";
  throw new Error(`Claude Code admits no topology ${JSON.stringify(topology ?? null)}.`);
}

/**
 * The observable capabilities of one accepted Claude route.
 *
 * They are route-qualified, not Driver-wide: a leaf route denies the native
 * Agent tool at the CLI boundary, so its leaf boundary is effective and native
 * orchestration is off; a native-orchestrator route has no leaf boundary to
 * enforce and admits the bounded native team instead.
 *
 * `turnObservation` is `unavailable` deliberately. A Claude turn lives in a
 * child process this worker owns; once that worker is gone, no other process
 * can authoritatively decide whether the turn settled, so worker loss stays
 * honestly unknown rather than being reconciled from a PID that may have been
 * reused. `authorityEnforcement` is `prompt_only` because `terminal-parity`
 * always passes the dangerous permission bypass.
 */
export function claudeRouteCapabilities(topology) {
  const orchestrator = delegationModeForTopology(topology) === "claude_orchestrator";
  return Object.freeze({
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    // The Claude behavior is mature; this contract wrapper is not yet proven
    // against a real Claude turn, so the Driver stays experimental.
    driverMaturity: "experimental",
    values: Object.freeze({
      interaction: "noninteractive_fixed_policy",
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "assistant_messages",
      interruptRequest: "supported",
      turnObservation: "unavailable",
      automaticRecovery: "same_session_recovery_prompt",
      authorityEnforcement: "prompt_only",
      leafEnforcement: orchestrator ? "unsupported" : "effective_tool_denial",
      nativeOrchestration: orchestrator ? "opaque_bounded" : "disabled",
    }),
    maturity: Object.freeze({
      interaction: "validated",
      activeInput: "validated",
      continuation: "validated",
      history: "validated",
      interruptRequest: "validated",
      turnObservation: "validated",
      automaticRecovery: "validated",
      authorityEnforcement: "validated",
      leafEnforcement: "validated",
      nativeOrchestration: orchestrator ? "experimental" : "validated",
    }),
    provenance: Object.freeze(Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((key) => [key, "checkout_declared"]))),
  });
}

/** The only turn-scoped option this Driver admits from a caller. */
const TURN_OPTION_FIELDS = Object.freeze(["effort"]);

/** Turn options are a flat one-level bag: `{effort}` and nothing nested. */
const MAX_TURN_OPTIONS_DEPTH = 1;

/**
 * Validate one turn's Claude-owned options. Effort is turn-scoped: it never
 * changes Agent identity or route authority, and it is validated by this
 * Driver alone -- the generic core never shares a Claude enum or infers
 * effort support from another Harness. A turn that states no explicit effort
 * still receives this Driver's own per-model default rather than silently
 * inheriting whatever the host `claude` process's own ambient default is.
 *
 * The caller's value is never interpreted directly. It is first rebuilt into
 * a detached, trap-free snapshot by the shared `plain-record.mjs` owner,
 * which refuses a Proxy before any trap can run and refuses an accessor,
 * non-enumerable, symbol-keyed, inherited-prototype, or prototype-polluting
 * field before it is ever read -- so every admitted value here is read
 * exactly once, from that snapshot, and a caller-held reference to the
 * original object can never change what this Driver already captured.
 */
function validateClaudeTurnOptions(model, turnOptions, admittedEffort = null) {
  if (turnOptions != null && typeof turnOptions !== "object") {
    throw new Error("Claude turn options must be a plain object.");
  }
  const snapshot = turnOptions == null
    ? {}
    : plainDataTree(turnOptions, "Claude turn options", MAX_TURN_OPTIONS_DEPTH);
  for (const key of Object.keys(snapshot)) {
    if (!TURN_OPTION_FIELDS.includes(key)) {
      throw new Error(`Claude turn options declare an unknown field: ${key}.`);
    }
  }
  const effort = typeof (snapshot.effort ?? admittedEffort) === "string" &&
    (snapshot.effort ?? admittedEffort).trim() === (snapshot.effort ?? admittedEffort) &&
    (snapshot.effort ?? admittedEffort)
    ? (snapshot.effort ?? admittedEffort)
    : null;
  if (!effort) throw new Error(`Claude route ${model} requires an explicit discovered effort.`);
  if (admittedEffort != null && effort !== admittedEffort) {
    throw new Error(`Claude turn effort must equal its immutable admitted effort for ${model}.`);
  }
  return Object.freeze({ effort });
}

function boundedText(value, max) {
  const text = value == null ? null : String(value);
  if (text == null || text.length === 0) return { text: null, truncated: false };
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

function nativeReferenceEnvelope(instanceKey, locator) {
  return Object.freeze({
    version: NATIVE_REFERENCE_ENVELOPE_VERSION,
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
    instanceKey,
    locatorVersion: CLAUDE_LOCATOR_VERSION,
    locator: Object.freeze(locator),
  });
}

/**
 * A Claude session identity is bounded text with no structure of its own. An
 * identity this Driver cannot express as a valid locator is treated as absent
 * rather than reshaped, so continuation reports what was proven.
 */
function usableSessionId(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 256 || text.includes("\0")) return null;
  return text;
}

/** The admitted turn-failure class of one native result, never free text. */
function admittedFailureClass(result) {
  const candidate = result?.failureClass ?? null;
  return isAdmittedHarnessTurnFailureClass(candidate) ? candidate : "protocol_unknown";
}

/**
 * Translate Claude's own terminal evidence onto the execution-world axes.
 *
 * `settlement` is turn-owned work, not residency: a Claude turn owns its child
 * process tree, and the currently proven boundary is exactly the one this
 * checkout already uses — the process closed and its result was classified.
 *
 * Two cases are refused that boundary. Evidence the native protocol itself
 * could not resolve (no terminal event, unrecovered parse errors) cannot prove
 * that nothing of this turn's is still owed, and evidence that contradicts
 * itself is not honest uncertainty. Both become `unknown`, which holds every
 * lease and publishes nothing.
 *
 * `harden-native-background-task-completion` remains the owner of any stronger
 * Claude owned-work evidence. Its accepted protocol-drift summary is carried in
 * the Driver receipt and deliberately does not decide settlement here: that
 * change, not this one, may promote a background-task signal to authority.
 */
function claudeOwnedWorkEvidence(result) {
  const status = result?.status;
  const contradicted = status === "completed" &&
    (Boolean(result?.failureClass) || result?.requiresAttention === true);
  if (contradicted) {
    return { settlement: "unknown", continuity: "unknown", reason: "contradictory_native_evidence" };
  }
  if (status !== "completed" && status !== "failed") {
    return { settlement: "unknown", continuity: "unknown", reason: "native_turn_evidence_unresolved" };
  }
  // The child process tree is gone with the turn: its execution world did not
  // survive, which is independent of whether the transcript can be resumed.
  return { settlement: "settled", continuity: "lost", reason: "process_close_with_classified_result" };
}

/** The transcript axis, which never states anything about execution. */
function claudeContinuationEvidence(result, instanceKey) {
  const drifted = result?.failureClass === "protocol_session_drift";
  const sessionId = drifted ? null : usableSessionId(result?.sessionId);
  if (drifted) {
    return {
      mode: "unknown",
      nativeSessionRef: null,
      evidence: { source: "stream_json_session", drift: true, sessionObserved: false },
    };
  }
  if (!sessionId) {
    return {
      mode: "fresh_only",
      nativeSessionRef: null,
      evidence: { source: "stream_json_session", drift: false, sessionObserved: false },
    };
  }
  return {
    mode: "exact_resume",
    nativeSessionRef: nativeReferenceEnvelope(instanceKey, { sessionId }),
    evidence: { source: "stream_json_session", drift: false, sessionObserved: true },
  };
}

function progressSample(values, limit) {
  const list = Array.isArray(values) ? values : [];
  return list
    .slice(0, limit)
    .map((entry) => String(entry ?? "").slice(0, MAX_PROGRESS_SAMPLE_CHARS));
}

function steeringProjection(steering) {
  if (!steering || typeof steering !== "object" || Array.isArray(steering)) return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    pendingCount: count(steering.pendingCount),
    unacknowledgedCount: count(steering.unacknowledgedCount),
    latestAcknowledgedSequence: count(steering.latestAcknowledgedSequence),
    lastSequence: count(steering.lastSequence),
  };
}

/**
 * Bounded progress evidence. Counts are always exact; the samples that explain
 * them shrink deterministically until the whole receipt fits the contract's
 * durable bound, so a turn that touched hundreds of files reports the truth
 * about how many rather than failing its own terminal validation.
 */
function boundedClaudeProgress(result, steering) {
  const toolUses = Array.isArray(result?.toolUses) ? result.toolUses : [];
  const touchedFiles = Array.isArray(result?.touchedFiles) ? result.touchedFiles : [];
  const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
  const base = {
    assistantOutputObserved: result?.assistantOutputObserved === true,
    toolUseCount: toolUses.length,
    touchedFileCount: touchedFiles.length,
    attemptCount: attempts.length,
    recoveryAttempts: Number.isSafeInteger(result?.recoveryAttempts) ? result.recoveryAttempts : 0,
    lastActivityAt: result?.lastByteAt == null ? null : String(result.lastByteAt).slice(0, 64),
    steering: steeringProjection(steering),
  };
  let limit = MAX_PROGRESS_SAMPLE_ENTRIES;
  while (true) {
    const progress = {
      ...base,
      toolUses: progressSample(toolUses, limit),
      touchedFiles: progressSample(touchedFiles, limit),
      attempts: attempts.slice(0, Math.min(limit, MAX_PROGRESS_ATTEMPT_ENTRIES)).map((attempt) => ({
        attempt: Number.isSafeInteger(attempt?.attempt) ? attempt.attempt : null,
        status: attempt?.status == null ? null : String(attempt.status).slice(0, 64),
        failureClass: attempt?.failureClass == null ? null : String(attempt.failureClass).slice(0, 64),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(progress), "utf8") <= MAX_PROGRESS_BYTES || limit === 0) {
      return progress;
    }
    limit = Math.floor(limit / 2);
  }
}

/** The bounded, path-free projection of a local credential observation. */
function credentialProjection(observation) {
  if (!observation || typeof observation !== "object") return null;
  return {
    version: observation.version ?? null,
    source: observation.source ?? null,
    state: observation.state ?? null,
    liveValidated: observation.liveValidated === true,
    accessExpiresAt: observation.accessExpiresAt ?? null,
    accessLocallyExpired: observation.accessLocallyExpired ?? null,
    refreshExpiresAt: observation.refreshExpiresAt ?? null,
    refreshLocallyExpired: observation.refreshLocallyExpired ?? null,
  };
}

/**
 * One native Claude session result as one normalized version-two terminal
 * result. Native turn state, owned-work settlement, and transcript
 * continuation are decided independently above; nothing here collapses them,
 * and no process fact crosses the boundary.
 */
function normalizeClaudeV2TurnResult({
  result,
  route,
  profileReceipt,
  steering,
  compatibility,
  nativeTeamCompatibilityObservation,
  credentialObservation,
}) {
  const world = claudeOwnedWorkEvidence(result);
  const continuation = claudeContinuationEvidence(result, route.instanceKey);
  const completed = result.status === "completed" && world.reason !== "contradictory_native_evidence";
  const failureClass = completed ? null : admittedFailureClass(result);
  const status = completed
    ? "completed"
    : failureClass === "cancelled_or_interrupted" ? "interrupted" : "failed";

  const rawOutput = String(result.finalMessage ?? "");
  const finalMessageTruncated = rawOutput.length > MAX_FINAL_MESSAGE_CHARS;
  const finalMessage = rawOutput.length === 0
    ? null
    : (finalMessageTruncated ? rawOutput.slice(0, MAX_FINAL_MESSAGE_CHARS) : rawOutput);
  const absenceReason = finalMessage != null
    ? null
    : String(failureClass ?? "no_outer_assistant_message").slice(0, MAX_ABSENCE_REASON_CHARS);

  const reason = boundedText(result.failureReason, MAX_FAILURE_REASON_CHARS);
  const detail = boundedText(result.stderr, MAX_FAILURE_REASON_CHARS);
  const warning = boundedText(result.warning, MAX_WARNING_CHARS);
  const unknownEvents = unknownEventSummary(result);

  const resultMetadata = {
    ...(warning.text ? { warning: warning.text } : {}),
    ...(result.manualResumeCommand ? { manualResumeCommand: String(result.manualResumeCommand).slice(0, 512) } : {}),
    ...(finalMessageTruncated
      ? { finalMessageTruncated: true, finalMessageChars: rawOutput.length }
      : {}),
    ...(credentialObservation ? { credentialObservation } : {}),
  };

  return {
    contractVersion: DRIVER_CONTRACT_VERSION_V2,
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
    instanceKey: route.instanceKey,
    status,
    // The completion promise resolves only after the session owner observed
    // the child close, so the native turn is terminal by construction.
    nativeTurn: "terminal",
    nativeTurnRef: route.nativeTurnRef,
    executionWorld: { continuity: world.continuity, settlement: world.settlement },
    continuation,
    failure: {
      class: failureClass,
      reason: reason.text,
      detail: detail.text,
      resumable: result.resumable === true,
      requiresAttention: Boolean(result.requiresAttention),
    },
    finalMessage,
    finalMessageAbsenceReason: absenceReason,
    progress: boundedClaudeProgress(result, steering),
    metrics: terminalMetricsFromEvidence({
      providerReported: result.providerReportedMetrics,
      toolCallCount: Array.isArray(result.attempts) && result.attempts.length > 0
        ? result.attempts.reduce((count, attempt) =>
          count + (Array.isArray(attempt?.toolUses) ? attempt.toolUses.length : 0), 0)
        : (Array.isArray(result.toolUses) ? result.toolUses.length : 0),
      attemptCount: Array.isArray(result.attempts) ? result.attempts.length : 0,
      recoveryAttemptCount: result.recoveryAttempts ?? 0,
    }),
    resultMetadata: Object.keys(resultMetadata).length > 0 ? resultMetadata : null,
    driverReceipt: boundedDriverReceipt(CLAUDE_CODE_HARNESS_ID, CLAUDE_CODE_V2_DRIVER_VERSION, {
      executionProfile: profileReceipt?.name ?? null,
      settlementReason: world.reason,
      continuationMode: continuation.mode,
      nativeStatus: String(result.status ?? "missing").slice(0, 64),
      failureClass,
      failureTextTruncated: reason.truncated || detail.truncated,
      recoveryAttempts: result.recoveryAttempts ?? 0,
      attempts: Array.isArray(result.attempts) ? result.attempts.length : 0,
      unknownEvents: unknownEvents.unknownEvents,
      unknownEventCount: unknownEvents.unknownEventCount,
      unknownEventOverflowCount: unknownEvents.unknownEventOverflowCount,
      hostClaudeVersion: compatibility?.compatibility?.version ?? null,
      compatibilityObservationRecorded: compatibility?.recorded === true,
      nativeTeamObservationRecorded: nativeTeamCompatibilityObservation?.recorded ?? null,
    }),
  };
}

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function preTransportRejection(cause) {
  const rejection = driverPreTransportRejection();
  rejection.cause = cause instanceof Error ? cause : new Error(String(cause));
  return rejection;
}

/**
 * The `claude-code` Driver on Contract v2.
 *
 * Every option below the fixed environment is an internal composition seam
 * used by this checkout's own fixtures. No public input, persisted record, or
 * ambient value reaches this factory: the static registry constructs it with
 * the resolved operator environment and nothing else.
 */
export function createClaudeCodeDriverV2(options = {}) {
  const fixedEnv = options.env ?? process.env;
  const jobStateRoot = options.jobStateRoot ?? null;
  const sessionName = String(options.sessionName ?? "").trim() || null;
  const reportProgress = typeof options.onProgress === "function" ? options.onProgress : undefined;
  const runTurnSession = options.runTurnSession ?? runClaudeTaskSession;
  const requestInterruptSignal = options.requestInterrupt ?? requestClaudeInterrupt;
  const observeAvailability = options.observeAvailability ?? getClaudeAvailability;
  const observeAuth = options.observeAuth ?? getClaudeAuthStatus;
  const observeCompatibility = options.observeCompatibility ?? inspectClaudeCompatibility;
  const revalidateCompatibility = options.revalidateCompatibility ?? assertPreparedClaudeCompatibility;
  const recordCompatibilityObservation = options.recordCompatibilityObservation ?? recordSuccessfulClaudeTurn;
  const observeCredentialState = options.observeCredentialState ?? observeClaudeCredentialState;
  const readSteering = options.readSteering ?? getSteeringSnapshot;
  const assignDurableInput = options.assignDurableInput ?? enqueueSteeringMessage;
  const inspectRoutes = options.inspectRoutes ?? inspectClaudeAgentSdkRoutes;

  const fixedInstanceKey = claudeCodeInstanceKey(fixedEnv?.CLAUDE_CONFIG_DIR);

  /**
   * The host facts of the most recent inspection, kept so one route acceptance
   * needs exactly one host observation.
   *
   * Observing this host means running the CLI: an availability probe, a version
   * probe, and an auth probe, each of which can take seconds. Route acceptance
   * and the version-one launch preflight ask the same three questions, so the
   * answer is retained here for the caller that composes both, rather than
   * asked twice. It is deliberately keyed by working directory and never
   * refreshed on its own: this is a memo of one observation, not a cache with a
   * lifetime, and a caller that did not just inspect gets nothing back.
   */
  let lastHostObservation = null;

  /** The host facts one inspection observed, without repairing anything. */
  function observeHost(cwd) {
    const availability = observeAvailability(cwd, { env: fixedEnv });
    if (!availability?.available) {
      return { readiness: "unavailable", detailCode: "executable_missing", availability, compatibility: null, auth: null };
    }
    const compatibility = observeCompatibility(cwd, { availability, env: fixedEnv });
    if (compatibility?.staticCompatible !== true) {
      return { readiness: "blocked", detailCode: "incompatible_version", availability, compatibility, auth: null };
    }
    const auth = observeAuth(cwd, { env: fixedEnv });
    if (auth?.loggedIn !== true) {
      return { readiness: "blocked", detailCode: "not_authenticated", availability, compatibility, auth };
    }
    return { readiness: "ready", detailCode: "ready", availability, compatibility, auth };
  }

  /** The exact prompt facts this Driver adds around one caller task. */
  function envelopeFacts(route, turnId) {
    const delegationMode = delegationModeForTopology(route.topology);
    const write = route.authority === "behavioral_write";
    if (delegationMode === "claude_orchestrator" && !String(turnId ?? "").trim()) {
      throw new Error(
        "Claude Code native-orchestrator prompt preparation requires this turn's durable identity: " +
        "its team envelope binds one current cohort."
      );
    }
    // Validation is the profile owner's; a route it refuses never reaches a
    // prompt, a durable claim, or the native transport.
    validateExecutionProfileOptions({ model: route.model, effort: route.effort, exactDiscovered: true, delegationMode, write, jobId: turnId });
    const policy = resolveNativeTeamPolicy({ model: route.model, delegationMode, write, jobId: turnId });
    return delegationEnvelopeFacts(policy, write);
  }

  function assertOwnedRoute(route, label) {
    if (route?.harnessId !== CLAUDE_CODE_HARNESS_ID || route?.driverVersion !== CLAUDE_CODE_V2_DRIVER_VERSION) {
      throw new Error(`${label} belongs to a foreign Harness Driver contract.`);
    }
    if (route.instanceKey !== fixedInstanceKey) {
      throw new Error(
        `${label} belongs to logical instance ${JSON.stringify(route.instanceKey ?? null)}; ` +
        `this Driver is configured for ${fixedInstanceKey}.`
      );
    }
    return route;
  }

  const driver = {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
    contractVersion: DRIVER_CONTRACT_VERSION_V2,

    describe() {
      return {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
        contractVersion: DRIVER_CONTRACT_VERSION_V2,
        capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
        maturity: "experimental",
        title: V2_DRIVER_TITLE,
        environmentKeys: [...V2_ENVIRONMENT_KEYS],
      };
    },

    /**
     * Claude Code has exactly one logical instance per native configuration
     * directory, and this checkout configures exactly one. Inspection reads the
     * fixed executable, its version, and local auth metadata; it installs
     * nothing, logs into nothing, and repairs nothing.
     */
    async inspectInstances(scope) {
      const declared = scope?.env?.CLAUDE_CONFIG_DIR;
      // The scope's declared fixed key and this Driver's own configuration must
      // name one instance. A disagreement is reported as an unconfigured
      // instance rather than admitting a route this Driver cannot serve.
      if (declared && claudeCodeInstanceKey(declared) !== fixedInstanceKey) {
        return [{
          harnessId: CLAUDE_CODE_HARNESS_ID,
          instanceKey: fixedInstanceKey,
          readiness: "blocked",
          liveValidated: false,
          maturity: "experimental",
          detailCode: "not_configured",
          routes: null,
          capabilityProvenance: claudeRouteCapabilities("leaf").provenance,
          inspectionGeneration: "unavailable",
        }];
      }
      const instanceKey = fixedInstanceKey;
      const observedCwd = scope?.workspaceRoot ?? process.cwd();
      let host;
      lastHostObservation = null;
      try {
        host = observeHost(observedCwd);
        lastHostObservation = { cwd: observedCwd, host };
      } catch {
        // An unreadable host is reported as unknown, never as ready and never
        // as a repair opportunity.
        return [{
          harnessId: CLAUDE_CODE_HARNESS_ID,
          instanceKey,
          readiness: "unknown",
          liveValidated: false,
          maturity: "experimental",
          detailCode: "unknown",
          routes: null,
          capabilityProvenance: claudeRouteCapabilities("leaf").provenance,
          inspectionGeneration: "unavailable",
        }];
      }
      if (host.readiness !== "ready") {
        return [{
          harnessId: CLAUDE_CODE_HARNESS_ID, instanceKey, readiness: host.readiness,
          liveValidated: true, maturity: "experimental", detailCode: host.detailCode,
          routes: null, capabilityProvenance: claudeRouteCapabilities("leaf").provenance,
          inspectionGeneration: "unavailable",
        }];
      }
      try {
        const discovered = await inspectRoutes({
          cwd: observedCwd,
          executable: host.compatibility.executable,
          environment: fixedEnv,
        });
        return [{
          harnessId: CLAUDE_CODE_HARNESS_ID, instanceKey, readiness: "ready",
          liveValidated: true, maturity: "experimental", detailCode: "ready",
          routes: { ...discovered, topologies: ["leaf", "native_orchestrator"], interaction: "noninteractive_fixed_policy" },
          capabilityProvenance: claudeRouteCapabilities("leaf").provenance,
          inspectionGeneration: "unavailable",
        }];
      } catch (error) {
        return [{
          harnessId: CLAUDE_CODE_HARNESS_ID, instanceKey, readiness: "unavailable",
          liveValidated: false, maturity: "experimental",
          detailCode: "protocol_error", routes: null,
          capabilityProvenance: claudeRouteCapabilities("leaf").provenance,
          inspectionGeneration: "unavailable",
        }];
      }
    },

    /**
     * The version-one-shaped launch preflight for the observation this Driver
     * just made, or `null` when it has none for this working directory.
     *
     * The version-one supervisor consumes a readiness receipt; producing it
     * from the inspection that already ran is what keeps one route acceptance
     * to one host observation. `null` is always a safe answer: the caller then
     * observes for itself.
     */
    launchPreflightFromInspection(cwd) {
      if (lastHostObservation == null || lastHostObservation.cwd !== cwd) return null;
      const { availability, compatibility, auth } = lastHostObservation.host;
      if (!availability || !compatibility || !auth) return null;
      return Object.freeze({
        ready: Boolean(availability.available && compatibility.staticCompatible && auth.loggedIn),
        availability,
        compatibility,
        auth,
        // The version-one instance identity, exactly as that generation's own
        // preflight states it. The redacted version-three key is a different
        // namespace and never substitutes for it here.
        instanceKey: resolveClaudeInstanceKey(fixedEnv),
      });
    },

    /**
     * One canonical route for one explicit request. Claude's own model,
     * topology, and authority rules decide; nothing is defaulted, and an alias
     * is refused rather than silently canonicalized into a different route than
     * the caller stated.
     */
    validateRoute(request, inspection) {
      const delegationMode = delegationModeForTopology(request?.topology);
      const write = request?.authority === "behavioral_write";
      const model = typeof request?.model === "string" && request.model.trim() === request.model && request.model
        ? request.model : null;
      if (!model || !inspection?.routes?.models?.includes(model)) {
        throw new Error("Claude route validation requires one exact discovered full model.");
      }
      const effort = validateClaudeTurnOptions(model, { effort: request?.effort }).effort;
      if (!inspection.routes.effortsByModel?.[model]?.includes(effort)) {
        throw new Error(`Claude route validation requires one exact discovered effort for ${model}.`);
      }
      validateExecutionProfileOptions({
        model, effort, exactDiscovered: true, delegationMode, write,
        jobId: delegationMode === "claude_orchestrator" ? "route-validation" : undefined,
      });
      return {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        instanceKey: inspection.instanceKey,
        model,
        topology: request.topology,
        authority: request.authority,
        effort,
        driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
        capabilities: claudeRouteCapabilities(request.topology),
      };
    },

    /**
     * The bounded envelope this Driver will actually send. Its three facts are
     * the execution-profile owner's own delegation prompt, decomposed rather
     * than restated, so preparation cannot describe one prompt and the turn
     * send another.
     */
    prepareTurn(input) {
      const route = assertOwnedRoute(input?.route, "Claude prepared turn route");
      const taskInput = String(input?.taskInput ?? "");
      if (!taskInput.trim()) {
        throw new Error("A Claude turn requires bounded task input.");
      }
      const turnOptions = validateClaudeTurnOptions(route.model, input?.turnOptions, route.effort);
      const facts = envelopeFacts(route, input?.turnId);
      return {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
        route,
        promptEnvelope: {
          taskInput,
          authority: facts.authority,
          topology: facts.topology,
          returnContract: facts.returnContract,
        },
        turnOptions,
        // Turn options are bound into the same digest as the task input, so a
        // different effort can never reuse this exact prepared turn.
        inputDigest: `sha256:${createHash("sha256")
          .update(PREPARED_INPUT_DIGEST_DOMAIN)
          .update("\0")
          .update(taskInput)
          .update("\0")
          .update(JSON.stringify(turnOptions))
          .digest("hex")}`,
      };
    },

    /**
     * Re-prove the host immediately before the native turn. Driver Contract v2
     * carries no host receipt on a prepared turn, so this is a fresh proof of
     * the exact executable, version, and account state, not a comparison with
     * a receipt written earlier.
     */
    async revalidatePreparedTurn(preparedTurn, scope) {
      const route = assertOwnedRoute(preparedTurn?.route, "Claude prepared turn route");
      assertOwnedRoute(scope?.route, "Claude turn scope route");
      const cwd = scope?.workspaceRoot ?? process.cwd();
      const host = observeHost(cwd);
      if (host.readiness !== "ready") {
        throw new Error(
          host.detailCode === "executable_missing"
            ? "Claude Code CLI is unavailable. Install `claude` and ensure it is on PATH."
            : host.detailCode === "incompatible_version"
              ? formatClaudeCompatibilityError(host.compatibility)
              : "Claude Code CLI is not authenticated. Run `claude auth login` in the same environment."
        );
      }
      const compatibility = revalidateCompatibility(
        cwd,
        host.compatibility,
        { availability: host.availability, env: fixedEnv },
      );
      let discovered;
      try {
        discovered = await inspectRoutes({ cwd, executable: compatibility.executable, environment: fixedEnv });
      } catch {
        throw new Error("Claude exact-route revalidation is unavailable before prompt submission.");
      }
      if (!discovered.models.includes(route.model) || !discovered.effortsByModel?.[route.model]?.includes(route.effort)) {
        throw new Error("Claude exact route disappeared or narrowed before prompt submission.");
      }
      return Object.freeze({ availability: host.availability, compatibility });
    },

    /** Exactly `{sessionId}` — a reusable transcript identity and nothing else. */
    validateNativeSessionRef(reference) {
      const keys = Object.keys(reference?.locator ?? {});
      if (keys.length !== 1 || keys[0] !== "sessionId" || !usableSessionId(reference.locator.sessionId)) {
        throw new Error("A Claude native session locator is exactly {sessionId}.");
      }
      return reference;
    },

    /**
     * Exactly `{pid, processIdentity}` — the verified identity of the accepted
     * child, which is the only durable name a Claude turn has. The identity is
     * the kernel-owned start token the process owner already uses to refuse a
     * reused PID, so a locator can never address a different process later.
     */
    validateNativeTurnRef(reference) {
      const locator = reference?.locator ?? {};
      const keys = Object.keys(locator).sort();
      const valid = keys.length === 2 &&
        keys[0] === "pid" &&
        keys[1] === "processIdentity" &&
        Number.isSafeInteger(locator.pid) &&
        locator.pid > 0 &&
        typeof locator.processIdentity === "string" &&
        locator.processIdentity.trim().length > 0;
      if (!valid) {
        throw new Error("A Claude native turn locator is exactly {pid, processIdentity} of the accepted child.");
      }
      return reference;
    },

    /**
     * Bound native assistant history for one Agent this Driver owns.
     *
     * A version-three Agent's record states its logical instance as a one-way
     * redaction, never as a path, so the native configuration directory is
     * resolved HERE, at use time, from the runtime's own operator environment
     * -- and it is only used once it has been proven to be the very instance
     * the route pinned, by re-deriving the same redacted key. A configuration
     * that moved, or an environment naming a different one, fails closed: if
     * the hash does not match, the instance genuinely is not the one this
     * Agent's turns ran on. The resolved path is passed inward and never
     * returned, logged, or serialized.
     */
    readAssistantHistory(agent, page) {
      // A version-two record carries a legacy `route` projection that states no
      // instance, so the discriminator is the record version, never the field.
      const route = agent?.version === AGENT_RECORD_VERSION_V3 ? agent.route : null;
      if (route == null) return readBoundClaudeAgentMessages(agent, page);
      const declared = String(fixedEnv?.CLAUDE_CONFIG_DIR ?? "").trim();
      if (!declared || claudeCodeInstanceKey(declared) !== route.instanceKey) {
        throw new Error(
          `Agent ${agent.path ?? agent.agentId} is pinned to logical instance ${route.instanceKey}; ` +
          "this runtime's Claude configuration resolves to a different logical instance, so its " +
          "native history is refused."
        );
      }
      return readBoundClaudeAgentMessages(agent, { ...page, claudeConfigDir: declared });
    },

    /**
     * One complete Claude turn as a process-local live handle.
     *
     * The handle is returned at the same fence the version-one Driver already
     * enforced: the child exists, its identity is verified, and the supervisor
     * accepted it before one prompt byte was written. Nothing else about this
     * turn is invented — the session owner still owns the stream, the bounded
     * reconnect, the steering pump, and the terminal classification.
     */
    async startTurn(input) {
      const scope = input?.scope;
      const preparedTurn = input?.preparedTurn;
      const launchContext = input?.launchContext;
      // Everything in this block runs before the session owner is called, so
      // no request can have crossed the native transport: each failure is the
      // Driver's own proof that this attempt was never submitted.
      let profile = null;
      let route;
      let envelope;
      let delegationMode;
      let write;
      let executable;
      let resumeSessionId = null;
      try {
        route = assertOwnedRoute(scope?.route, "Claude turn scope route");
        assertOwnedRoute(preparedTurn?.route, "Claude prepared turn route");
        executable = launchContext?.compatibility?.executable;
        if (!executable) {
          throw new Error("Claude Code Driver requires a revalidated launch context.");
        }
        envelope = preparedTurn?.promptEnvelope;
        if (!envelope || envelope.taskInput !== scope.taskInput) {
          throw new Error("The prepared Claude prompt envelope does not carry this turn's task input.");
        }
        // The prepared digest binds a validated turn-scoped effort; a scope
        // that requests a different one can never reuse it.
        const turnOptions = validateClaudeTurnOptions(route.model, scope.turnOptions, route.effort);
        if (JSON.stringify(turnOptions) !== JSON.stringify(preparedTurn?.turnOptions)) {
          throw new Error(
            "The prepared Claude turn options are not the ones this turn's scope requests: " +
            "a different effort cannot reuse the same prepared turn."
          );
        }
        // A caller-supplied native session reference is validated here, before
        // any request crosses the transport: an unowned or malformed reference
        // can never become a resume attempt.
        if (input?.nativeSessionRef != null) {
          const validatedSessionRef = validateNativeReferenceEnvelope(input.nativeSessionRef, {
            driver, kind: "session", route,
          });
          resumeSessionId = validatedSessionRef.locator.sessionId;
        }
        delegationMode = delegationModeForTopology(route.topology);
        write = route.authority === "behavioral_write";
        profile = createExecutionProfile({
          model: route.model,
          delegationMode,
          write,
          exactDiscovered: true,
          env: fixedEnv,
          jobId: scope.turnId,
          effort: turnOptions.effort,
        });
        // The envelope is a published fact, so it must be the bytes that are
        // sent. A disagreement is refused before submission, never reconciled.
        const composed = [envelope.returnContract, envelope.topology, envelope.authority].join(" ");
        if (composed !== profile.claudeOptions.appendSystemPrompt) {
          throw new Error(
            "The prepared Claude prompt envelope is not the delegation prompt this route sends."
          );
        }
      } catch (error) {
        profile?.cleanup();
        throw preTransportRejection(error);
      }
      const workspaceRoot = scope.workspaceRoot;
      const turnId = scope.turnId;

      const acceptance = deferred();
      let accepted = null;
      let liveProcess = null;
      let nativeSettled = false;

      const sessionPromise = (async () => runTurnSession({
        workspaceRoot: jobStateRoot ?? workspaceRoot,
        jobId: turnId,
        cwd: workspaceRoot,
        prompt: envelope.taskInput,
        write,
        automaticRecovery: route.capabilities.values.automaticRecovery,
        ...(delegationMode === "claude_orchestrator" ? { retryPolicy: { maxReconnectAttempts: 0 } } : {}),
        claudeOptions: {
          ...profile.claudeOptions,
          claudeBin: executable,
          delegationMode,
          sessionName: sessionName ?? undefined,
          resumeSessionId: resumeSessionId ?? undefined,
        },
        onProgress: reportProgress,
        harnessInstance: {
          harnessId: CLAUDE_CODE_HARNESS_ID,
          instanceKey: route.instanceKey,
        },
        onSpawn: (receipt) => {
          const pid = receipt?.pid;
          const pidIdentity = String(receipt?.pidIdentity ?? "").trim();
          if (!Number.isSafeInteger(pid) || pid <= 0 || !pidIdentity) return false;
          // A bounded reconnect may own a later child; the durable turn keeps
          // the first accepted identity, while signalling always targets the
          // child that is actually live.
          liveProcess = { pid, pidIdentity };
          if (!accepted) {
            accepted = liveProcess;
            acceptance.resolve(liveProcess);
          }
          return true;
        },
      }))();
      // Register the settled fence immediately, so a control request that
      // arrives in the same tick as the native result never calls a finished
      // turn active -- and so an early rejection is never unhandled.
      sessionPromise.then(
        () => { nativeSettled = true; },
        () => { nativeSettled = true; },
      );

      /** @type {{kind: string, result?: any, error?: any}} */
      const outcome = await Promise.race([
        acceptance.promise.then(() => ({ kind: "accepted" })),
        sessionPromise.then(
          (result) => ({ kind: "ended", result }),
          (error) => ({ kind: "failed", error }),
        ),
      ]);
      if (outcome.kind !== "accepted") {
        profile.cleanup();
        if (outcome.kind === "ended" && outcome.result?.status === "completed") {
          // A turn that completed without ever accepting a child contradicts
          // the session owner's own launch fence. Nothing here can prove the
          // prompt was never written, so this stays ambiguous rather than
          // becoming replay-safe evidence.
          throw new Error(
            "The Claude session reported a completed turn without an accepted child; " +
            "native acceptance cannot be proven either way."
          );
        }
        // No child was ever accepted, so the session owner wrote zero prompt
        // bytes: this is the Claude proof that nothing crossed the native
        // transport boundary and the attempt is safely not submitted.
        throw preTransportRejection(
          outcome.kind === "failed"
            ? outcome.error
            : new Error(
              `The Claude session ended before any child was accepted ` +
              `(${String(outcome.result?.failureClass ?? outcome.result?.status ?? "no result")}).`
            )
        );
      }

      const nativeTurnRef = nativeReferenceEnvelope(route.instanceKey, {
        pid: accepted.pid,
        processIdentity: accepted.pidIdentity,
      });

      const completion = (async () => {
        try {
          const result = await sessionPromise;
          const nativeTeamCompatibilityObservation = recordNativeTeamObservation(
            workspaceRoot,
            launchContext.compatibility,
            delegationMode,
            result.runtimeReceipt?.nativeTeamSurface,
          );
          let compatibility = {
            recorded: false,
            compatibility: launchContext.compatibility,
            runtimeVersion: result.runtimeReceipt?.claudeCodeVersion ?? null,
          };
          if (result.status === "completed") {
            try {
              compatibility = recordCompatibilityObservation(
                workspaceRoot,
                launchContext.compatibility,
                result.runtimeReceipt?.claudeCodeVersion,
                { env: fixedEnv },
              );
            } catch {
              // Compatibility evidence is useful only when durably recorded; a
              // failed observation is reported as unrecorded and never turns a
              // proven native turn into a failure.
            }
          }
          let steering = result.steering ?? null;
          if (!steering) {
            try {
              steering = readSteering(workspaceRoot, turnId);
            } catch {
              steering = null;
            }
          }
          let credentialObservation = null;
          if (result.failureClass === "auth_or_permission") {
            try {
              credentialObservation = credentialProjection(observeCredentialState({ env: fixedEnv }));
            } catch {
              credentialObservation = null;
            }
          }
          return normalizeClaudeV2TurnResult({
            result,
            route: { instanceKey: route.instanceKey, nativeTurnRef },
            profileReceipt: profile.receipt,
            steering,
            compatibility,
            nativeTeamCompatibilityObservation,
            credentialObservation,
          });
        } finally {
          profile.cleanup();
        }
      })();
      completion.catch(() => {});

      return {
        nativeTurnRef,
        // No native session is proven when the child is accepted: the stream
        // announces it later, and the terminal result carries it. Nothing is
        // fabricated here to fill the field.
        nativeSessionRef: null,
        result: completion,

        /**
         * Durable stream input for the live turn. The queue is this turn's own
         * durable ordering record, and it is what the live stdin pump reads, so
         * a successful enqueue is the same acceptance the current runtime already
         * reports. A refusal proves the entry never crossed the boundary, so the
         * supervisor may return it to the mailbox for a later turn.
         */
        async deliverActiveInput(assigned) {
          try {
            const queued = assignDurableInput(workspaceRoot, turnId, assigned?.text, {
              kind: "steer",
              messageId: assigned?.messageId,
            });
            return { accepted: true, sequence: queued?.sequence ?? null, mode: "durable_stream_input" };
          } catch (error) {
            return {
              accepted: false,
              reason: "native_turn_did_not_accept_input",
              detail: boundedText(error?.message, 256).text,
            };
          }
        },

        /**
         * Request interruption of the live child. This is a request, never a
         * settlement: it returns as soon as the signal is delivered (or
         * refused), never waits for the process to actually exit, and never
         * infers anything from human-readable text -- only this turn's own
         * terminal evidence may end it, and nothing here escalates to a
         * forced cancellation.
         */
        async requestInterrupt(command) {
          const target = liveProcess;
          const receipt = { commandId: command?.commandId ?? null, settlement: "pending" };
          if (command?.kind !== "interrupt") {
            // A command kind this Driver cannot request is refused as
            // unsupported; it never becomes a signal by default.
            return { ...receipt, requestState: "unsupported", nativeTurnState: nativeSettled ? "terminal" : "active" };
          }
          if (!target) {
            return { ...receipt, requestState: "rejected", nativeTurnState: nativeSettled ? "terminal" : "unknown" };
          }
          let response;
          try {
            response = await requestInterruptSignal(target.pid, target.pidIdentity);
          } catch (error) {
            return {
              ...receipt,
              requestState: "rejected",
              nativeTurnState: nativeSettled ? "terminal" : "unknown",
              detail: boundedText(error?.message, 256).text,
            };
          }
          if (response?.requested === true) {
            // The signal reached the process group. Whether the turn ends,
            // and how, is decided by the completion promise alone.
            return { ...receipt, requestState: "accepted", nativeTurnState: nativeSettled ? "terminal" : "active" };
          }
          if (response?.requestFailure === "unsupported_platform") {
            return { ...receipt, requestState: "unsupported", nativeTurnState: nativeSettled ? "terminal" : "active" };
          }
          // Every other closed failure code (missing/mismatched identity, an
          // already-absent process, or a real signal-delivery failure) means
          // this Driver could not prove the request reached the process it
          // holds. The identity it holds no longer decides the turn, so its
          // state is unknown until its own result says otherwise.
          return { ...receipt, requestState: "rejected", nativeTurnState: nativeSettled ? "terminal" : "unknown" };
        },

        /**
         * Release this Driver's local ownership. It never signals, cancels, or
         * settles the native turn: a worker that disposes an unsettled turn is
         * giving up its own ownership, not ending Claude's work.
         */
        async dispose() {
          if (nativeSettled) profile.cleanup();
        },
      };
    },
  };

  return Object.freeze(driver);
}
