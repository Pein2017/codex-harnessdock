/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenCode Explorer Driver, Contract v2 (add-opencode-explorer-driver,
 * Task 5).
 *
 * This module owns launch, session, and turn lineage for one operator-owned
 * loopback OpenCode Server, and nothing else. Route and profile admission are
 * Task 3's; the prompt and result text boundary is Task 4's; the transport is
 * `runtime/opencode-client.mjs`; claims, leases, mailbox, settlement, and
 * publication belong to the supervisor. What is left here is exactly the part
 * only a Driver can do: turn one accepted route plus one prepared turn into a
 * native session, one native turn, and one normalized terminal result -- or
 * into an honest refusal.
 *
 * ## Three separate facts, in one order
 *
 *   1. **The claim comes first.** The supervisor persists the launch claim and
 *      wins the native-submission fence before it ever calls `startTurn()`, so
 *      this Driver creates a session only inside `startTurn()` -- never in
 *      `validateRoute()`, `prepareTurn()`, or `revalidatePreparedTurn()`, which
 *      run before anything durable exists.
 *   2. **A session is not a turn.** Creating a session proves only that a
 *      container exists. The `NativeSessionRef` is proven and returned, and it
 *      never implies that a prompt was accepted.
 *   3. **A turn is the prompt request.** The blocking prompt call is dispatched
 *      and *not* awaited; the exact `NativeTurnRef` is proven from the session
 *      id, the caller-generated user-message id, the attempt, and the exact
 *      provider/model before the live handle is returned, so the supervisor can
 *      persist acceptance before it acknowledges the mailbox.
 *
 * ## Why a session-creation failure is a clean rejection
 *
 * Turn acceptance is defined by the prompt request. Every failure before that
 * request is dispatched -- route drift, capacity, a refused or ambiguous
 * session creation, an unprovable session reference -- is reported through
 * `driverPreTransportRejection()`, because this Driver can prove no prompt left
 * the process and therefore no provider work happened and no native turn
 * exists. That holds even when session creation itself was ambiguous: an
 * orphaned session is operator-visible state, not a turn, and treating it as
 * acceptance-unknown would strand capacity for work that provably never
 * started.
 *
 * ## Why ambiguity rejects the result promise
 *
 * A normalized terminal result must declare `nativeTurn: "terminal"`, so it can
 * never express "I do not know". After the prompt is dispatched, anything that
 * leaves the outcome unreadable -- a lost connection, a deadline, a caller
 * abort, a 5xx -- rejects the live turn's `result` promise instead. The worker
 * loop turns that into `settleUnknown`: leases stay held, no completion is
 * published, and nothing is replayed, resumed, aborted, or observed. This
 * Driver has no observer to call.
 *
 * A response, by contrast, is settlement evidence: `session.prompt` is the
 * blocking call, so the Server only answers it after the assistant message
 * completes. That is why a readable 200, and the two refusals the pinned schema
 * declares (400 and 404), become terminal results rather than unknowns.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  DRIVER_CONTRACT_VERSION_V2,
  assertNativeReferenceEnvelope,
  boundedDriverReceipt,
  driverPreTransportRejection,
  isBoundedRouteAtom,
  splitFullModelRoute,
} from "./harness-contract.mjs";
import { ROUTE_CAPABILITY_NAMES, ROUTE_CAPABILITY_SCHEMA_VERSION, validateRouteCapabilitySnapshot } from "./harness-capabilities.mjs";
import {
  createOpencodeDiscoveryClient,
  createOpencodeObservationClient,
  createOpencodeSession,
  createOpencodeTurnClient,
  OPENCODE_DEADLINES_MS,
  discoverOpencodeAgentPolicy,
  discoverOpencodeDefaultAgent,
  discoverOpencodeHealth,
  discoverOpencodeProviderRoutes,
  isLoopbackOpencodeUrl,
  observeOpencodeSession,
  readOpencodeObservedSession,
  submitOpencodePrompt,
} from "./opencode-client.mjs";
import {
  OPENCODE_PROMPT_PREFIX_VERSION,
  buildOpencodeExplorerPromptEnvelope,
  renderOpencodeExplorerPrompt,
} from "./opencode-prompt.mjs";
import { selectOpencodeExplorerFinalResult } from "./opencode-result.mjs";
import {
  buildOpencodeServerReuseFacts,
  buildOpencodeUsageRecord,
} from "./opencode-usage.mjs";
import { plainRecordSnapshot } from "./plain-record.mjs";
import { terminalMetricsFromEvidence } from "./terminal-metrics.mjs";
import { createOpencodeServiceManager } from "./opencode-service-manager.mjs";

export const OPENCODE_DRIVER_VERSION = "opencode@1";
export const OPENCODE_DRIVER_TITLE = "OpenCode native routes (experimental)";
export const OPENCODE_HARNESS_ID = "opencode";
export const OPENCODE_INTERACTION_VERSION = "1.18.25";

class OpencodeRouteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpencodeRouteError";
    this.code = code;
  }
}

function opencodeInstanceKey(serverUrl) {
  if (!isLoopbackOpencodeUrl(serverUrl)) {
    throw new OpencodeRouteError("invalid_server_url", "An OpenCode instance key requires the configured literal-IP loopback origin.");
  }
  return `opencode-server-${createHash("sha256").update(new URL(String(serverUrl)).origin).digest("hex").slice(0, 16)}`;
}

const OPENCODE_NATIVE_CAPABILITIES = validateRouteCapabilitySnapshot({
  capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
  driverMaturity: "experimental",
  values: {
    activeInput: "initial_only", authorityEnforcement: "prompt_only", automaticRecovery: "none",
    continuation: "fresh_only", history: "unavailable", interaction: "noninteractive_fixed_policy",
    interruptRequest: "unsupported", leafEnforcement: "prompt_only", nativeOrchestration: "opaque_bounded",
    turnObservation: "terminal_observable",
    nativeProgress: "native_coalesced",
  },
  maturity: Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((name) => [name, "experimental"])),
  provenance: Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((name) => [name, "checkout_declared"])),
}, "OpenCode native route capabilities");

function opencodeModelParts(model) {
  const parts = splitFullModelRoute(model);
  if (!parts) throw new OpencodeRouteError("foreign_route", "OpenCode route model must be provider/model.");
  return { providerId: parts.provider, modelId: parts.model };
}

function nativeRouteFacts(routes) {
  return Object.freeze({
    models: Object.freeze(routes.map((route) => route.model)),
    effortsByModel: Object.freeze(Object.fromEntries(routes.map((route) => [route.model, Object.freeze([...route.efforts])]))),
    topologies: Object.freeze(["leaf"]),
    ...OPENCODE_NATIVE_CAPABILITIES.values,
  });
}

/**
 * The one fixed configuration key this Driver declares. Basic-auth credentials
 * are deliberately absent: they are inherited from the operator process
 * environment by the client's own allowlist and never enter a Driver scope,
 * a receipt, or a reference.
 */
export const OPENCODE_DRIVER_ENVIRONMENT_KEYS = Object.freeze(["OPENCODE_EXECUTABLE", "OPENCODE_SERVER_URL"]);

/** The locator schema version both native references carry. */
export const OPENCODE_LOCATOR_VERSION = 1;

/** The exact locator key sets this Driver's own validators admit. */
export const OPENCODE_SESSION_LOCATOR_KEYS = Object.freeze(["sessionId"]);
export const OPENCODE_TURN_LOCATOR_KEYS = Object.freeze([
  "attemptId",
  "modelId",
  "providerId",
  "sessionId",
  "userMessageId",
  "variant",
]);

/** Closed reasons this Driver refuses a turn before its native transport. */
export const OPENCODE_PRE_TRANSPORT_CODES = Object.freeze([
  "continuation_unsupported",
  "foreign_route",
  "instance_not_configured",
  "instance_not_ready",
  "interactive_policy",
  "prompt_rejected",
  "session_identity_reused",
  "session_not_created",
  "session_reference_unprovable",
  "turn_identity_unprovable",
  "turn_options_not_admitted",
]);

/** Closed reasons a dispatched turn's outcome stays unknown. */
export const OPENCODE_UNKNOWN_ACCEPTANCE_CODES = Object.freeze([
  "aborted_by_caller",
  "deadline_exceeded",
  "server_error",
  "transport_lost",
  "unreadable_transport",
]);

/** Closed absence reasons a failed turn reports instead of a final message. */
export const OPENCODE_ABSENCE_REASONS = Object.freeze([
  "assistant_role_mismatch",
  "empty_final_text",
  "final_text_too_large",
  "lineage_mismatch",
  "malformed_response",
  "no_final_text",
  "prompt_refused",
  "provider_error",
  "server_refused_authentication",
  "unreadable_response",
]);

/**
 * Client failure codes that prove the Server answered the prompt request and
 * therefore that its turn settled, mapped to the turn failure they represent.
 * `session.prompt` is blocking: a response exists only after the assistant
 * message completes, so any of these is terminal evidence, not ambiguity.
 */
const SETTLED_PROMPT_FAILURES = Object.freeze({
  // The two refusals the pinned schema declares for this request: the Server
  // rejected the prompt itself, so no provider work happened.
  prompt_refused: Object.freeze({
    failureClass: "context_or_request_invalid",
    absence: "prompt_refused",
    continuity: "not_applicable",
  }),
  auth_failed: Object.freeze({
    failureClass: "auth_or_permission",
    absence: "server_refused_authentication",
    continuity: "not_applicable",
  }),
  // A 200 whose body is not the pinned shape: the request settled, its content
  // is unreadable, and nothing may be projected from it.
  malformed_response: Object.freeze({
    failureClass: "protocol_unknown",
    absence: "unreadable_response",
    continuity: "preserved",
  }),
  // The response exceeded the frozen turn ceiling. The turn itself settled (the
  // blocking call answered), so this is a refusal to read, not an unknown.
  response_too_large: Object.freeze({
    failureClass: "protocol_unknown",
    absence: "unreadable_response",
    continuity: "preserved",
  }),
});

/**
 * Client failure codes that leave the outcome unknown. A 5xx is here on
 * purpose: the Server answered, but nothing proves its turn settled coherently,
 * and no readable assistant message exists to say otherwise.
 */
const UNKNOWN_PROMPT_FAILURES = Object.freeze({
  network_error: "transport_lost",
  server_error: "server_error",
  deadline_exceeded: "deadline_exceeded",
  aborted_by_caller: "aborted_by_caller",
  bad_request: "unreadable_transport",
  redirect_rejected: "unreadable_transport",
  cross_origin_rejected: "unreadable_transport",
  request_not_admitted: "unreadable_transport",
  mutating_request_blocked: "unreadable_transport",
  unknown_error: "unreadable_transport",
});

/** Result-selector failures mapped onto the closed turn-failure vocabulary. */
const SELECTOR_FAILURE_CLASSES = Object.freeze({
  lineage_mismatch: "protocol_session_drift",
  assistant_role_mismatch: "protocol_session_drift",
  malformed_response: "protocol_unknown",
  no_final_text: "protocol_unknown",
  empty_final_text: "protocol_unknown",
  final_text_too_large: "protocol_unknown",
});

/**
 * Provider-error variants mapped onto the closed turn-failure vocabulary. Only
 * the variant name is read; the error's `data` (which may carry a provider
 * message, raw response headers, or a raw body) is never read, which is why a
 * quota-shaped `APIError` classifies as `protocol_unknown` rather than as a
 * Harness-scoped usage limit: guessing the wider scope from an unread payload
 * would block the whole instance on an inference.
 */
const PROVIDER_ERROR_CLASSES = Object.freeze({
  ProviderAuthError: "auth_or_permission",
  MessageAbortedError: "cancelled_or_interrupted",
  ContextOverflowError: "context_or_request_invalid",
  MessageOutputLengthError: "context_or_request_invalid",
  ContentFilterError: "context_or_request_invalid",
  StructuredOutputError: "protocol_unknown",
  APIError: "protocol_unknown",
  UnknownError: "protocol_unknown",
  unrecognized: "protocol_unknown",
});

/**
 * Process-local active/unknown turn evidence, keyed by logical instance. It is
 * observational only: the operator requested no HarnessDock capacity ceiling.
 */
const ACTIVE_TURNS = new Map();

function heldCapacity(instanceKey) {
  return ACTIVE_TURNS.get(instanceKey) ?? 0;
}

function claimCapacity(instanceKey) {
  const held = heldCapacity(instanceKey);
  ACTIVE_TURNS.set(instanceKey, held + 1);
  return () => {
    const current = heldCapacity(instanceKey);
    if (current <= 1) ACTIVE_TURNS.delete(instanceKey);
    else ACTIVE_TURNS.set(instanceKey, current - 1);
  };
}

/**
 * Native session ids this process has already bound to a turn, keyed by logical
 * instance. A Server that handed the same id to two Agents would otherwise put
 * them in one native session; the durable native-session lease is the
 * authoritative owner of that rule, and this is the in-process guard beside it.
 * The set is bounded, and eviction can only loosen a defense-in-depth check
 * whose durable owner is unaffected.
 */
const BOUND_SESSION_IDS = new Map();
const MAX_TRACKED_SESSION_IDS = 4_096;

function bindSessionIdentity(instanceKey, sessionId) {
  let bound = BOUND_SESSION_IDS.get(instanceKey);
  if (!bound) {
    bound = new Set();
    BOUND_SESSION_IDS.set(instanceKey, bound);
  }
  if (bound.has(sessionId)) {
    throw new OpencodeRouteError(
      "session_identity_reused",
      "The Server returned a native session identity this process already bound to a turn; " +
        "two Agents never share one native session."
    );
  }
  if (bound.size >= MAX_TRACKED_SESSION_IDS) {
    bound.delete(bound.values().next().value);
  }
  bound.add(sessionId);
}

/** Test-only inspection of the process-local slot; never a control surface. */
export function opencodeHeldCapacity(instanceKey) {
  return heldCapacity(instanceKey);
}

export class OpencodeTurnError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OpencodeTurnError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function generateUserMessageId() {
  // `msg_`-namespaced because the pinned schema requires it, time-ordered so a
  // Server that sorts messages by id sees this turn's user message in order,
  // and random-suffixed so two attempts never collide.
  return `msg_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

function requiredText(value, code, detail) {
  if (typeof value !== "string" || !value.trim()) {
    throw new OpencodeRouteError(code, detail);
  }
  return value;
}

/**
 * One OpenCode Explorer Driver bound to one fixed configuration.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, envFile?: string,
 *   acceptanceTimeoutMs?: number, turnTimeoutMs?: number,
 *   serviceManager?: {ensure: () => Promise<object>, acquireTurnLease?: (identity: object) => Promise<object>, releaseTurnLease?: (lease: object) => Promise<boolean>},
 *   _test?: any}} [options]
 */
export function createOpencodeDriver(options = {}) {
  const fixedEnv = options.env ?? process.env;
  const inspectionGeneration = () => typeof options._test?.inspectionGeneration === "function"
    ? options._test.inspectionGeneration()
    : (options._test?.inspectionGeneration ?? "unavailable");
  const clientOptions = Object.freeze({
    env: fixedEnv,
    cwd: options.cwd,
    envFile: options.envFile,
    acceptanceTimeoutMs: options.acceptanceTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
  });
  // Resolving the origin here, once, is what makes the instance key fixed: a
  // scope can restate the configured URL but never choose a different one.
  const fixedInstanceKey = opencodeInstanceKey(
    createOpencodeTurnClient(clientOptions).serverUrl
  );
  const serviceManager = options.serviceManager ?? createOpencodeServiceManager({
    env: fixedEnv,
    cwd: options.cwd,
    envFile: options.envFile,
  });

  function sessionReference(sessionId) {
    return {
      version: 1,
      harnessId: OPENCODE_HARNESS_ID,
      driverVersion: OPENCODE_DRIVER_VERSION,
      instanceKey: fixedInstanceKey,
      locatorVersion: OPENCODE_LOCATOR_VERSION,
      locator: { sessionId },
    };
  }

  function turnReference({ sessionId, userMessageId, attemptId, providerId, modelId, variant }) {
    return {
      version: 1,
      harnessId: OPENCODE_HARNESS_ID,
      driverVersion: OPENCODE_DRIVER_VERSION,
      instanceKey: fixedInstanceKey,
      locatorVersion: OPENCODE_LOCATOR_VERSION,
      locator: {
        sessionId,
        userMessageId,
        attemptId,
        providerId,
        modelId,
        variant,
      },
    };
  }

  function assertOwnedRoute(route, label) {
    const fields = plainRecordSnapshot(route, `${label} route`);
    if (fields.harnessId !== OPENCODE_HARNESS_ID || fields.driverVersion !== OPENCODE_DRIVER_VERSION) {
      throw new OpencodeRouteError("foreign_route", `${label} belongs to a foreign Harness Driver contract.`);
    }
    if (fields.instanceKey !== fixedInstanceKey) {
      throw new OpencodeRouteError(
        "instance_not_configured",
        `${label} names a logical instance this Driver is not configured for.`
      );
    }
    opencodeModelParts(fields.model);
    if (fields.topology !== "leaf" || !["behavioral_read_only", "behavioral_write"].includes(fields.authority)) {
      throw new OpencodeRouteError("foreign_route", `${label} names a topology or authority this route does not admit.`);
    }
    if (!isBoundedRouteAtom(fields.effort)) {
      throw new OpencodeRouteError("foreign_route", `${label} lacks an explicit native effort.`);
    }
    const capabilities = validateRouteCapabilitySnapshot(fields.capabilities, `${label} capabilities`);
    if (JSON.stringify(capabilities) !== JSON.stringify(OPENCODE_NATIVE_CAPABILITIES)) {
      throw new OpencodeRouteError("foreign_route", `${label} claims unsupported native capabilities.`);
    }
    return fields;
  }

  function hasTerminalDoomLoopAllow(agent) {
    const terminal = [...agent.ruleset].reverse().find((rule) => rule.permission === "doom_loop");
    return terminal?.pattern === "*" && terminal.action === "allow";
  }

  function isAuthFailure(result) {
    return result?.ok === false && result?.code === "auth_failed";
  }

  async function inspectNative(scope) {
    const declared = scope?.env?.OPENCODE_SERVER_URL;
    if (declared && opencodeInstanceKey(declared) !== fixedInstanceKey) {
      return { harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey, readiness: "blocked", liveValidated: false, maturity: "experimental", detailCode: "not_configured", routes: null, capabilityProvenance: OPENCODE_NATIVE_CAPABILITIES.provenance, inspectionGeneration: inspectionGeneration() };
    }
    try {
      const handle = createOpencodeDiscoveryClient({ ...clientOptions, env: fixedEnv, directory: scope?.workspaceRoot });
      const health = await discoverOpencodeHealth(handle, { signal: scope?.signal });
      const discovered = health.ok && health.healthy
        ? await discoverOpencodeProviderRoutes(handle, { signal: scope?.signal })
        : null;
      const config = discovered?.ok
        ? await discoverOpencodeDefaultAgent(handle, { signal: scope?.signal })
        : null;
      const defaultAgent = config?.ok ? config.defaultAgent ?? "build" : null;
      const policy = defaultAgent
        ? await discoverOpencodeAgentPolicy(handle, { name: defaultAgent, signal: scope?.signal })
        : null;
      const admitted = health.ok && health.healthy && health.version === OPENCODE_INTERACTION_VERSION &&
        discovered?.ok && config?.ok && policy?.ok && policy.present && policy.agent &&
        policy.agent.mode === "primary" && !policy.agent.hidden && hasTerminalDoomLoopAllow(policy.agent);
      if (!admitted) {
        const unavailable = !health.ok || !health.healthy || !discovered?.ok;
        const notAuthenticated = isAuthFailure(health) || isAuthFailure(discovered);
        return {
          harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey,
          readiness: unavailable ? (notAuthenticated ? "blocked" : "unavailable") : "blocked",
          liveValidated: false, maturity: "experimental",
          detailCode: unavailable ? (notAuthenticated ? "not_authenticated" : "service_unreachable") : "interactive_policy",
          routes: null,
          capabilityProvenance: OPENCODE_NATIVE_CAPABILITIES.provenance,
          inspectionGeneration: inspectionGeneration(),
        };
      }
      const routes = discovered.routes.filter(({ model }) => {
        const { providerId, modelId } = opencodeModelParts(model);
        return providerId !== "gitlab" || !modelId.startsWith("duo-workflow-");
      });
      if (routes.length === 0) {
        return { harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey, readiness: "blocked", liveValidated: false, maturity: "experimental", detailCode: "interactive_policy", routes: null, capabilityProvenance: OPENCODE_NATIVE_CAPABILITIES.provenance, inspectionGeneration: inspectionGeneration() };
      }
      // Test-only differential evidence. It stays outside every Driver result
      // and receipt; the test projects these just-read native facts to digests.
      if (typeof options._test?.captureNativeAdmissionEvidence === "function") {
        options._test.captureNativeAdmissionEvidence(Object.freeze({ defaultAgent, agent: policy.agent }));
      }
      return { harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey, readiness: "ready", liveValidated: true, maturity: "experimental", detailCode: "ready", routes: nativeRouteFacts(routes), capabilityProvenance: OPENCODE_NATIVE_CAPABILITIES.provenance, inspectionGeneration: inspectionGeneration() };
    } catch {
      return { harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey, readiness: "unavailable", liveValidated: false, maturity: "experimental", detailCode: "service_unreachable", routes: null, capabilityProvenance: OPENCODE_NATIVE_CAPABILITIES.provenance, inspectionGeneration: inspectionGeneration() };
    }
  }

  /** The bounded facts a terminal result carries about how it was produced. */
  function driverReceipt(receipt) {
    return boundedDriverReceipt(OPENCODE_HARNESS_ID, OPENCODE_DRIVER_VERSION, receipt);
  }

  /**
   * The exact provider-reported facts, mapped onto the closed Harness-neutral
   * metrics vocabulary. Only the five fields that vocabulary already models are
   * carried here; the sixth exact fact this schema reports -- reasoning tokens --
   * has no slot in it and travels in the route-keyed usage record instead, which
   * is where the spec puts these facts with their lineage anyway. Nothing is
   * zero-filled: an absent or malformed provider field stays null.
   */
  function terminalMetricsFor(providerMetrics, toolCallCount) {
    return terminalMetricsFromEvidence({
      providerReported: providerMetrics
        ? {
            duration_ms: null,
            duration_api_ms: null,
            turn_count: null,
            input_tokens: providerMetrics.inputTokens,
            output_tokens: providerMetrics.outputTokens,
            cache_creation_input_tokens: providerMetrics.cacheWriteTokens,
            cache_read_input_tokens: providerMetrics.cacheReadTokens,
            reported_cost_usd: providerMetrics.reportedCost,
          }
        : null,
      toolCallCount: Number.isSafeInteger(toolCallCount) ? toolCallCount : 0,
      attemptCount: 1,
      recoveryAttemptCount: 0,
    });
  }

  /**
   * The route-keyed usage record for one settled turn. Usage evidence never
   * decides settlement: if the record cannot be built -- an unattributable
   * identity, a bound, a refused provenance field -- the receipt records the
   * closed reason and the turn still settles on its own evidence.
   */
  function usageReceiptFor(context, status, providerMetrics, toolCallCount) {
    try {
      return {
        usage: buildOpencodeUsageRecord({
          identity: context.usageIdentity,
          status,
          providerMetrics: providerMetrics ?? null,
          plugin: {
            toolCallCount: Number.isSafeInteger(toolCallCount) ? toolCallCount : null,
            attemptCount: 1,
            recoveryAttemptCount: 0,
          },
          serverReuse: buildOpencodeServerReuseFacts({
            latencyMs: context.latencyMs,
            serverVersion: context.serverVersion,
          }),
        }),
      };
    } catch (error) {
      return { usageUnattributable: typeof error?.code === "string" ? error.code : "usage_unavailable" };
    }
  }

  function continuationEvidence() {
    // Fresh-only, and honest about why: the compatibility probe found no
    // authoritative Server/session incarnation field, so a persisted session
    // can never be proven to belong to the Server that answered this turn.
    return {
      source: "opencode_session_create",
      sessionBindingProven: true,
      serverIncarnationProven: false,
    };
  }

  function failedTerminal({
    nativeTurnRef,
    failureClass,
    absence,
    continuity,
    reason,
    metadata,
    status = "failed",
    context = null,
    providerMetrics = null,
    toolCallCount = null,
  }) {
    return {
      harnessId: OPENCODE_HARNESS_ID,
      driverVersion: OPENCODE_DRIVER_VERSION,
      contractVersion: DRIVER_CONTRACT_VERSION_V2,
      instanceKey: fixedInstanceKey,
      nativeTurnRef,
      status,
      nativeTurn: "terminal",
      executionWorld: { continuity, settlement: "settled" },
      // A fresh-only route never carries a session reference here: the session
      // reference reached durable state through the live handle, and repeating
      // it as continuation evidence would advertise a resume this route cannot
      // prove.
      continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: continuationEvidence() },
      failure: {
        class: failureClass,
        reason,
        detail: null,
        resumable: false,
        requiresAttention: failureClass === "auth_or_permission",
      },
      finalMessage: null,
      finalMessageAbsenceReason: absence,
      progress: null,
      metrics: terminalMetricsFor(providerMetrics, toolCallCount),
      resultMetadata: metadata,
      driverReceipt: driverReceipt({
        promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION,
        outcome: absence,
        ...(context ? usageReceiptFor(context, status, providerMetrics, toolCallCount) : {}),
      }),
    };
  }

  function completedTerminal({ nativeTurnRef, selected, context }) {
    return {
      harnessId: OPENCODE_HARNESS_ID,
      driverVersion: OPENCODE_DRIVER_VERSION,
      contractVersion: DRIVER_CONTRACT_VERSION_V2,
      instanceKey: fixedInstanceKey,
      nativeTurnRef,
      status: "completed",
      nativeTurn: "terminal",
      // The operator's Server outlives the turn, so its execution world stays
      // resident with nothing outstanding.
      executionWorld: { continuity: "preserved", settlement: "settled" },
      continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: continuationEvidence() },
      failure: { class: null, reason: null, detail: null, resumable: false, requiresAttention: false },
      finalMessage: selected.finalMessage,
      finalMessageAbsenceReason: null,
      progress: null,
      metrics: terminalMetricsFor(selected.providerMetrics, selected.toolCallCount),
      resultMetadata: {
        promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION,
        finishReason: selected.metadata.finishReason,
        textPartCount: selected.metadata.textPartCount,
        precedingTextPartCount: selected.metadata.precedingTextPartCount,
        nonTextPartCount: selected.metadata.nonTextPartCount,
        normalization: { ...selected.metadata.normalization },
      },
      driverReceipt: driverReceipt({
        promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION,
        outcome: "final_message_projected",
        finishReason: selected.metadata.finishReason,
        ...usageReceiptFor(context, "completed", selected.providerMetrics, selected.toolCallCount),
      }),
    };
  }

  /**
   * Turn one dispatched prompt outcome into a terminal result, or throw so the
   * live turn's promise rejects and the supervisor settles unknown.
   */
  function normalizeOutcome(outcome, context) {
    const { nativeTurnRef, sessionId, userMessageId } = context;
    if (!outcome.ok) {
      const settled = SETTLED_PROMPT_FAILURES[outcome.code];
      if (settled) {
        return failedTerminal({
          nativeTurnRef,
          failureClass: settled.failureClass,
          absence: settled.absence,
          continuity: settled.continuity,
          reason: `the OpenCode Server answered the prompt request with a ${settled.absence} outcome`,
          metadata: { promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION, resultFailureCode: settled.absence },
          context,
        });
      }
      const unknown = UNKNOWN_PROMPT_FAILURES[outcome.code] ?? "unreadable_transport";
      throw new OpencodeTurnError(
        unknown,
        "The OpenCode prompt request left this process but its outcome cannot be read; " +
          "acceptance and settlement stay unknown.",
        { retryable: false }
      );
    }

    // Test-only differential evidence: typed part order is otherwise consumed
    // at the result boundary and never belongs in a durable Driver receipt.
    // Deliberately expose no part payload, native id, tool input, or output.
    if (typeof options._test?.captureNativePromptEvidence === "function") {
      const parts = Array.isArray(outcome.response?.parts) ? outcome.response.parts : [];
      options._test.captureNativePromptEvidence(Object.freeze({
        partTypes: Object.freeze(parts.map((part) => typeof part?.type === "string" ? part.type : "invalid")),
      }));
    }

    const selected = selectOpencodeExplorerFinalResult(outcome.response, {
      sessionId,
      parentMessageId: userMessageId,
      providerId: context.providerId,
      modelId: context.modelId,
      variant: context.variant,
      agent: null,
      attemptId: context.attemptId,
    });
    if (selected.ok) return completedTerminal({ nativeTurnRef, selected, context });
    const refused = /** @type {{code: string, providerErrorName?: string}} */ (selected);

    if (refused.code === "provider_error") {
      const failureClass = PROVIDER_ERROR_CLASSES[refused.providerErrorName] ?? "protocol_unknown";
      return failedTerminal({
        nativeTurnRef,
        failureClass,
        absence: "provider_error",
        continuity: "preserved",
        status: failureClass === "cancelled_or_interrupted" ? "interrupted" : "failed",
        reason: `the native assistant message reported a ${refused.providerErrorName} provider error`,
        metadata: {
          promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION,
          resultFailureCode: refused.code,
          providerErrorName: refused.providerErrorName,
        },
        context,
        providerMetrics: selected.providerMetrics ?? null,
        toolCallCount: selected.toolCallCount ?? null,
      });
    }
    return failedTerminal({
      nativeTurnRef,
      failureClass: SELECTOR_FAILURE_CLASSES[refused.code] ?? "protocol_unknown",
      absence: refused.code,
      continuity: "preserved",
      reason: `the native assistant message did not satisfy the Explorer return contract (${refused.code})`,
      metadata: { promptPrefixVersion: OPENCODE_PROMPT_PREFIX_VERSION, resultFailureCode: refused.code },
      context,
      providerMetrics: selected.providerMetrics ?? null,
      toolCallCount: selected.toolCallCount ?? null,
    });
  }

  const driver = {
    harnessId: OPENCODE_HARNESS_ID,
    driverVersion: OPENCODE_DRIVER_VERSION,
    contractVersion: DRIVER_CONTRACT_VERSION_V2,

    describe() {
      return {
        harnessId: OPENCODE_HARNESS_ID,
        driverVersion: OPENCODE_DRIVER_VERSION,
        contractVersion: DRIVER_CONTRACT_VERSION_V2,
        capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
        maturity: "experimental",
        title: OPENCODE_DRIVER_TITLE,
        environmentKeys: [...OPENCODE_DRIVER_ENVIRONMENT_KEYS],
      };
    },

    /**
     * Read-only readiness for the one configured logical instance. Every
     * request it makes is a side-effect-free GET; it starts nothing, repairs
     * nothing, and creates no session.
     */
    async inspectInstances(scope) {
      return [await inspectNative(scope)];
    },

    /**
     * One canonical route for one explicit request. Task 3 owns admission: an
     * aliased model, a topology change, write authority, an unproven effort, a
     * dynamic selector, or a broker-required capability snapshot is refused
     * here, before any session could exist.
     */
    validateRoute(request, inspection) {
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          Object.keys(request).some((key) => !["harnessId", "model", "topology", "authority", "effort"].includes(key))) {
        throw new OpencodeRouteError("route_not_admitted", "OpenCode route contains an unsupported selector.");
      }
      if (inspection?.instanceKey !== fixedInstanceKey) {
        throw new OpencodeRouteError(
          "instance_not_configured",
          "The inspected instance is not the one this Driver is configured for."
        );
      }
      if (inspection.readiness !== "ready") {
        throw new OpencodeRouteError(
          "instance_not_ready",
          `The OpenCode instance is ${inspection.readiness} (${inspection.detailCode}); no route is admitted.`
        );
      }
      const model = opencodeModelParts(request?.model) && request.model;
      const effort = isBoundedRouteAtom(request?.effort) ? request.effort : null;
      if (request?.topology !== "leaf" || !["behavioral_read_only", "behavioral_write"].includes(request?.authority) || !effort ||
          !inspection.routes?.effortsByModel?.[model]?.includes(effort)) {
        throw new OpencodeRouteError("route_not_admitted", "OpenCode requires one freshly advertised exact model, leaf topology, authority, and effort.");
      }
      return {
        harnessId: OPENCODE_HARNESS_ID,
        instanceKey: fixedInstanceKey,
        model,
        topology: request.topology,
        authority: request.authority,
        effort,
        driverVersion: OPENCODE_DRIVER_VERSION,
        capabilities: OPENCODE_NATIVE_CAPABILITIES,
      };
    },

    /** Pure: builds Task 4's envelope and binds its digest. No I/O, no session. */
    prepareTurn(input) {
      const route = assertOwnedRoute(input?.route, "Prepared turn");
      if (JSON.stringify(input?.turnOptions) !== JSON.stringify({ effort: route.effort })) {
        throw new OpencodeRouteError(
          "turn_options_not_admitted",
          "The OpenCode turn must retain its accepted explicit effort."
        );
      }
      const promptEnvelope = buildOpencodeExplorerPromptEnvelope(input?.taskInput, route.authority);
      const promptText = renderOpencodeExplorerPrompt(input?.taskInput, route.authority);
      return {
        harnessId: OPENCODE_HARNESS_ID,
        driverVersion: OPENCODE_DRIVER_VERSION,
        route: input.route,
        promptEnvelope,
        // JSON-array domain separation: unambiguous by construction, with no
        // separator character that could appear inside a component.
        inputDigest: `sha256:${createHash("sha256")
          .update(JSON.stringify([OPENCODE_PROMPT_PREFIX_VERSION, route.model, promptText]))
          .digest("hex")}`,
        turnOptions: { effort: route.effort },
      };
    },

    /**
     * Revalidate before the durable claim exists. This is the pre-session gate:
     * the fixed configuration, the route, and the live profile/model readiness
     * are all rechecked with GET-only discovery, so a drifted profile, an
     * unconfirmed model, a broker requirement, or a full capacity slot fails
     * closed before anything native is created.
     */
    async revalidatePreparedTurn(prepared, scope) {
      assertOwnedRoute(prepared?.route, "Prepared turn");
      const declared = scope?.env?.OPENCODE_SERVER_URL;
      if (declared && opencodeInstanceKey(declared) !== fixedInstanceKey) {
        throw new OpencodeRouteError(
          "instance_not_configured",
          "The turn scope names a logical instance this Driver is not configured for."
        );
      }
      await serviceManager.ensure();
      const inspection = await inspectNative(scope);
      if (inspection.readiness !== "ready") {
        if (inspection.detailCode === "interactive_policy") {
          throw new OpencodeRouteError(
            "interactive_policy",
            "The OpenCode interaction policy cannot be witnessed before session creation."
          );
        }
        throw new OpencodeRouteError(
          "instance_not_ready",
          `The OpenCode instance is ${inspection.readiness} (${inspection.detailCode}); ` +
          "no native turn is started."
        );
      }
      const accepted = driver.validateRoute({ harnessId: OPENCODE_HARNESS_ID, model: prepared.route.model, topology: prepared.route.topology, authority: prepared.route.authority, effort: prepared.route.effort }, inspection);
      if (["model", "topology", "authority", "effort", "instanceKey"].some((key) => accepted[key] !== prepared.route[key])) {
        throw new OpencodeRouteError("route_not_admitted", "The accepted OpenCode route drifted before transport.");
      }
      return Object.freeze({
        readinessDetailCode: inspection.detailCode,
        serverVersion: null,
        workspaceRoot: scope?.workspaceRoot ?? null,
      });
    },

    /** The exact session locator shape, confirmed by identity or refused. */
    validateNativeSessionRef(reference) {
      if (
        reference?.harnessId !== OPENCODE_HARNESS_ID ||
        reference?.driverVersion !== OPENCODE_DRIVER_VERSION ||
        reference?.locatorVersion !== OPENCODE_LOCATOR_VERSION
      ) {
        throw new Error("The native session reference is not valid for the OpenCode Explorer Driver.");
      }
      const keys = Object.keys(reference.locator ?? {}).sort();
      if (
        keys.length !== OPENCODE_SESSION_LOCATOR_KEYS.length ||
        keys.some((key, index) => key !== OPENCODE_SESSION_LOCATOR_KEYS[index]) ||
        typeof reference.locator.sessionId !== "string"
      ) {
        throw new Error("An OpenCode session locator must be exactly {sessionId}.");
      }
      return reference;
    },

    /** The exact turn locator shape; a session locator can never satisfy it. */
    validateNativeTurnRef(reference) {
      if (
        reference?.harnessId !== OPENCODE_HARNESS_ID ||
        reference?.driverVersion !== OPENCODE_DRIVER_VERSION ||
        reference?.locatorVersion !== OPENCODE_LOCATOR_VERSION
      ) {
        throw new Error("The native turn reference is not valid for the OpenCode Explorer Driver.");
      }
      const locator = reference.locator ?? {};
      const keys = Object.keys(locator).sort();
      if (
        keys.length !== OPENCODE_TURN_LOCATOR_KEYS.length ||
        keys.some((key, index) => key !== OPENCODE_TURN_LOCATOR_KEYS[index])
      ) {
        throw new Error(
          `An OpenCode turn locator must be exactly {${OPENCODE_TURN_LOCATOR_KEYS.join(", ")}}.`
        );
      }
      for (const key of OPENCODE_TURN_LOCATOR_KEYS) {
        if (typeof locator[key] !== "string" || !locator[key]) {
          throw new Error(`An OpenCode turn locator requires bounded text for ${key}.`);
        }
      }
      opencodeModelParts(`${locator.providerId}/${locator.modelId}`);
      return reference;
    },

    /** Read-only restart observation for one already-persisted exact turn. */
    async observeTurn(reference, scope = {}) {
      try {
        const validated = driver.validateNativeTurnRef(reference);
        if (validated.instanceKey !== fixedInstanceKey) return { nativeTurn: "unknown", terminalResult: null };
        const { sessionId, userMessageId, attemptId, providerId, modelId, variant } = validated.locator;
        const observer = createOpencodeObservationClient(clientOptions);
        const snapshot = await readOpencodeObservedSession(observer, { sessionId, signal: scope.signal });
        if (!snapshot.ok) return { nativeTurn: "unknown", terminalResult: null };
        const status = snapshot.status?.[sessionId];
        if (status?.type === "busy" || status?.type === "retry") return { nativeTurn: "active", terminalResult: null };
        if (status != null && status.type !== "idle") return { nativeTurn: "unknown", terminalResult: null };
        const candidates = snapshot.messages.filter((message) =>
          message?.info?.role === "assistant" && message.info.sessionID === sessionId && message.info.parentID === userMessageId
        );
        if (candidates.length !== 1) return { nativeTurn: "unknown", terminalResult: null };
        if (candidates[0].info.finish == null && candidates[0].info.error == null) {
          return { nativeTurn: "unknown", terminalResult: null };
        }
        const terminal = normalizeOutcome({ ok: true, response: candidates[0] }, {
          nativeTurnRef: validated,
          sessionId,
          userMessageId,
          attemptId,
          providerId,
          modelId,
          variant,
          usageIdentity: {
            rootId: scope.rootId ?? null, agentId: scope.agentId ?? null, turnId: scope.turnId ?? null, attemptId,
            harnessId: OPENCODE_HARNESS_ID, instanceKey: fixedInstanceKey, model: `${providerId}/${modelId}`,
            driverVersion: OPENCODE_DRIVER_VERSION, capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
            topology: scope.route?.topology ?? "leaf", authority: scope.route?.authority ?? "behavioral_read_only",
          },
          latencyMs: 0,
          serverVersion: null,
        });
        return { nativeTurn: "terminal", terminalResult: terminal };
      } catch {
        return { nativeTurn: "unknown", terminalResult: null };
      }
    },

    /**
     * Create one fresh session, prove its reference, prove this turn's distinct
     * reference from the caller-generated user-message id, dispatch the one
     * blocking prompt, and return the live turn without awaiting it.
     */
    async startTurn(input) {
      const scope = input?.scope;
      const prepared = input?.preparedTurn;
      let releaseCapacity = null;
      let turnLease = null;
      let promptText;
      let attemptId;
      let route;
      try {
        route = assertOwnedRoute(prepared?.route, "Started turn");
        // Fresh-only continuation is refused here: before any mailbox
        // acknowledgement, any native mutation, and any session creation.
        if (input?.nativeSessionRef != null) {
          throw new OpencodeRouteError(
            "continuation_unsupported",
            "This OpenCode route proves fresh_only continuation; a same-Agent follow-up requires a new Agent."
          );
        }
        attemptId = requiredText(
          scope?.attemptId,
          "turn_identity_unprovable",
          "An OpenCode turn requires its durable attempt identity before any native submission."
        );
        requiredText(
          scope?.turnId,
          "turn_identity_unprovable",
          "An OpenCode turn requires its durable turn identity before any native submission."
        );
        promptText = renderOpencodeExplorerPrompt(prepared?.promptEnvelope?.taskInput, route.authority);
        releaseCapacity = claimCapacity(fixedInstanceKey);
        if (typeof serviceManager.acquireTurnLease === "function") {
          turnLease = await serviceManager.acquireTurnLease({
            rootId: scope?.rootId, agentId: scope?.agentId, turnId: scope?.turnId, attemptId,
          });
        }
      } catch (error) {
        if (turnLease && typeof serviceManager.releaseTurnLease === "function") await serviceManager.releaseTurnLease(turnLease);
        if (releaseCapacity) releaseCapacity();
        throw preTransportRejection(error);
      }

      let sessionId;
      let nativeSessionRef;
      let nativeTurnRef;
      let userMessageId;
      let observation = null;
      try {
        const admittedModel = opencodeModelParts(route.model);
        const finalWitness = await inspectNative(scope);
        if (finalWitness.readiness !== "ready" || !finalWitness.routes?.effortsByModel?.[route.model]?.includes(route.effort)) {
          throw new OpencodeRouteError("interactive_policy", "The OpenCode interaction policy cannot be witnessed immediately before session creation.");
        }
        const turnClient = createOpencodeTurnClient(clientOptions);
        const workspaceRoot = input?.launchContext?.workspaceRoot ?? scope?.workspaceRoot ?? null;
        const created = await createOpencodeSession(turnClient, {
          providerId: admittedModel.providerId,
          modelId: admittedModel.modelId,
          variant: route.effort,
          directory: workspaceRoot ?? undefined,
          signal: scope?.signal ?? undefined,
        });
        if (!created.ok) {
          const createdFailure = /** @type {{code: string}} */ (created);
          // No prompt was dispatched, so no native turn exists and no provider
          // work happened -- even when the session outcome itself was ambiguous.
          throw new OpencodeRouteError(
            "session_not_created",
            `The OpenCode Server did not return a usable session (${createdFailure.code}); no prompt was submitted.`
          );
        }
        sessionId = created.sessionId;
        bindSessionIdentity(fixedInstanceKey, sessionId);
        // A session reference that cannot be proven is refused before the
        // prompt: an unprovable container never becomes a turn.
        try {
          nativeSessionRef = assertNativeReferenceEnvelope(sessionReference(sessionId), {
            driver,
            route: prepared.route,
            kind: "session",
          });
        } catch (error) {
          throw new OpencodeRouteError("session_reference_unprovable", error.message);
        }
        userMessageId = generateUserMessageId();
        try {
          nativeTurnRef = assertNativeReferenceEnvelope(
            turnReference({
              sessionId,
              userMessageId,
              attemptId,
              providerId: admittedModel.providerId,
              modelId: admittedModel.modelId,
              variant: route.effort,
            }),
            { driver, route: prepared.route, kind: "turn" }
          );
        } catch (error) {
          throw new OpencodeRouteError("turn_identity_unprovable", error.message);
        }
        // The read-only stream is registered before the blocking prompt is
        // dispatched. Its own failure is advisory and cannot alter prompt
        // acceptance or settlement.
        try {
          observation = await observeOpencodeSession(createOpencodeObservationClient({
            ...clientOptions,
            timeoutMs: OPENCODE_DEADLINES_MS.connect,
          }), {
            sessionId,
            signal: scope?.signal ?? undefined,
          });
        } catch {
          observation = null;
        }
        // Everything that can refuse this turn without a prompt has now run.
        // A synchronous throw from here is still proof that nothing was
        // dispatched: the client validates and admits the exact path before it
        // touches the network.
        const dispatched = submitOpencodePrompt(turnClient, {
          sessionId,
          messageId: userMessageId,
          providerId: admittedModel.providerId,
          modelId: admittedModel.modelId,
          variant: route.effort,
          text: promptText,
          directory: workspaceRoot ?? undefined,
          signal: scope?.signal ?? undefined,
        });
        const dispatchedAt = Date.now();
        const usageIdentity = {
          rootId: scope?.rootId ?? null,
          agentId: scope?.agentId ?? null,
          turnId: scope?.turnId ?? null,
          attemptId,
          harnessId: OPENCODE_HARNESS_ID,
          instanceKey: fixedInstanceKey,
          model: route.model,
          driverVersion: OPENCODE_DRIVER_VERSION,
          capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
          topology: route.topology,
          authority: route.authority,
        };
        let settled = false;
        const result = dispatched.then(
          async (outcome) => {
            const terminal = normalizeOutcome(outcome, {
              nativeTurnRef,
              sessionId,
              userMessageId,
              attemptId,
              providerId: admittedModel.providerId,
              modelId: admittedModel.modelId,
              variant: route.effort,
              usageIdentity,
              // Plugin-observed wall clock only. Nothing derives a cache hit, a
              // price, or a charge from it.
              latencyMs: Math.max(0, Date.now() - dispatchedAt),
              serverVersion: input?.launchContext?.serverVersion ?? null,
            });
            settled = true;
            if (turnLease && typeof serviceManager.releaseTurnLease === "function") {
              await serviceManager.releaseTurnLease(turnLease);
              turnLease = null;
            }
            if (releaseCapacity) {
              releaseCapacity();
              releaseCapacity = null;
            }
            return terminal;
          },
          (error) => {
            // Ambiguity keeps the slot: the native turn may still be running,
            // and this Driver has no observer to ask.
            throw error instanceof OpencodeTurnError
              ? error
              : new OpencodeTurnError("unreadable_transport", "The OpenCode prompt outcome could not be read.");
          }
        ).finally(() => observation?.dispose());
        return {
          nativeSessionRef,
          nativeTurnRef,
          result,
          subscribeProgress: observation
            ? (listener) => observation.subscribeProgress(listener)
            : () => () => {},
          // Disposal is process-local only. It never aborts, cancels, or
          // observes the native turn -- this route has no interrupt -- and it
          // never releases capacity for an unsettled turn.
          dispose: async () => {
            observation?.dispose();
            if (settled && releaseCapacity) {
              releaseCapacity();
              releaseCapacity = null;
            }
          },
        };
      } catch (error) {
        observation?.dispose();
        if (turnLease && typeof serviceManager.releaseTurnLease === "function") await serviceManager.releaseTurnLease(turnLease);
        if (releaseCapacity) releaseCapacity();
        throw preTransportRejection(error);
      }
    },
  };

  return Object.freeze(driver);
}

/**
 * Wrap a refusal as the contract's branded pre-transport proof, preserving the
 * closed code and sanitized message for operator diagnostics. Only a Driver
 * that can prove nothing was submitted may throw this, and only these paths do.
 */
function preTransportRejection(error) {
  return Object.assign(driverPreTransportRejection(), {
    opencodeCode: error instanceof OpencodeRouteError ? error.code : "prompt_rejected",
    opencodeDetail:
      typeof error?.message === "string" ? error.message.slice(0, 512) : "the turn was refused before submission",
    cause: error,
  });
}
