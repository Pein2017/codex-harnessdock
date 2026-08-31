/** SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DRIVER_CONTRACT_VERSION_V2, assertNativeReferenceEnvelope, boundedDriverReceipt, driverPreTransportRejection, isBoundedRouteAtom, isBoundedRouteText, splitFullModelRoute } from "./harness-contract.mjs";
import { ROUTE_CAPABILITY_NAMES, ROUTE_CAPABILITY_SCHEMA_VERSION } from "./harness-capabilities.mjs";
import { NATIVE_REFERENCE_ENVELOPE_VERSION } from "./native-reference.mjs";
import { resolvePluginRuntimeRoot } from "./paths.mjs";
import { plainDataTree } from "./plain-record.mjs";
import { createPiRpcProcess, piRpcArgv } from "./pi-rpc-process.mjs";
import { terminalMetricsFromEvidence } from "./terminal-metrics.mjs";

export const PI_HARNESS_ID = "pi";
export const PI_DRIVER_VERSION = "pi@2";
export const PI_DISCOVERY_FAILURE_CODES = Object.freeze([
  "configuration_missing", "executable_missing", "rpc_incompatible", "rpc_timeout", "protocol_error",
]);
const INSTANCE_KEY = "pi-local";
const LOCATOR_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGENT_MESSAGE_LIMIT = 20;
const MAX_DISCOVERED_MODELS = 32;
const MAX_DISCOVERED_EFFORTS = 16;

function preTransport(cause) { return Object.assign(driverPreTransportRejection(), { cause }); }
function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} requires bounded text.`);
  return value;
}
function uuid(value, label) {
  const text = requiredText(value, label);
  if (!UUID_PATTERN.test(text)) throw new Error(`${label} must be one canonical UUID, not a path or partial ID.`);
  return text.toLowerCase();
}
function exactRouteText(value, label) {
  if (!isBoundedRouteText(value)) throw new Error(`${label} requires bounded exact text.`);
  return value;
}
function modelParts(model) {
  const parts = splitFullModelRoute(model);
  if (!parts) throw new Error("Pi model must be one exact provider/model identifier.");
  return parts;
}
function turnOptions(value, route = null) {
  const data = value == null ? null : plainDataTree(value, "Pi turn options", 1);
  const effort = route?.effort;
  if (data == null && typeof effort === "string") return Object.freeze({ effort });
  if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, "effort") || !isBoundedRouteAtom(data.effort) || data.effort !== effort) {
    throw new Error("Pi turn options must retain the accepted effective effort.");
  }
  return Object.freeze({ effort: data.effort });
}
function reference(locator) {
  return Object.freeze({ version: NATIVE_REFERENCE_ENVELOPE_VERSION, harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION,
    instanceKey: INSTANCE_KEY, locatorVersion: LOCATOR_VERSION, locator: Object.freeze(locator) });
}
function nativeStats(value, label) {
  const tokens = value?.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error(`${label} lacks Pi token counters.`);
  const integer = (item, field) => {
    if (!Number.isSafeInteger(item) || item < 0) throw new Error(`${label} has invalid ${field}.`);
    return item;
  };
  // Locator keys cannot spell "token" (the generic native-reference owner
  // reserves that shape for credentials), so these are compact counters only.
  return Object.freeze({ tc: integer(value?.toolCalls, "toolCalls"), i: integer(tokens.input, "tokens.input"),
    o: integer(tokens.output, "tokens.output"), cr: integer(tokens.cacheRead, "tokens.cacheRead"), cw: integer(tokens.cacheWrite, "tokens.cacheWrite") });
}
function statsDelta(before, after) {
  for (const key of ["i", "o", "cr", "cw", "tc"]) {
    if (after[key] < before[key]) throw new Error(`Pi cumulative counter ${key} regressed within one exact session.`);
  }
  return { input_tokens: after.i - before.i, output_tokens: after.o - before.o,
    cache_creation_input_tokens: after.cw - before.cw, cache_read_input_tokens: after.cr - before.cr,
    tool_call_count: after.tc - before.tc };
}
function assertNativeStats(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "cr,cw,i,o,tc") {
    throw new Error(`${label} lacks Pi baseline counters.`);
  }
  for (const key of ["tc", "i", "o", "cr", "cw"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${label} has invalid ${key}.`);
  }
  return value;
}
function observation(nativeTurn, terminalResult = null) {
  return Object.freeze({ nativeTurn, terminalResult });
}
function messageTimestamp(value) {
  if (typeof value === "string" && value) return value;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function messageOutcome(entry) {
  const timestamp = messageTimestamp(entry?.timestamp);
  if (entry?.type !== "message" || entry?.message?.role !== "assistant" || typeof entry.id !== "string" || !timestamp) return null;
  if (!["stop", "length", "error", "aborted"].includes(entry.message.stopReason)) return null;
  const content = entry.message.content;
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts) || parts.some((part) => part?.type === "toolCall" || part?.type === "tool_call")) return null;
  const text = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  return text ? { messageId: entry.id, timestamp, text, stopReason: entry.message.stopReason } : null;
}
function messageEndOutcome(message) {
  if (message?.role !== "assistant") return null;
  if (!["stop", "length", "error", "aborted"].includes(message.stopReason)) return null;
  const content = message.content;
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts) || parts.some((part) => part?.type === "toolCall" || part?.type === "tool_call")) return null;
  const text = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  return text ? { text, stopReason: message.stopReason } : null;
}
function resultFor({ nativeTurnRef, nativeSessionRef, baseline, after, outcome, leafId }) {
  const delta = statsDelta(baseline.stats, after);
  const aborted = outcome?.stopReason === "aborted";
  const errored = outcome?.stopReason === "error";
  const completed = outcome != null && !aborted && !errored;
  return {
    harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, contractVersion: DRIVER_CONTRACT_VERSION_V2, instanceKey: INSTANCE_KEY,
    nativeTurnRef, status: completed ? "completed" : (aborted ? "interrupted" : "failed"), nativeTurn: "terminal",
    executionWorld: { continuity: "lost", settlement: "settled" },
    continuation: { mode: "exact_resume", nativeSessionRef, evidence: { source: "pi_rpc_session", messageEndObserved: outcome != null } },
    failure: completed ? { class: null, reason: null, detail: null, resumable: false, requiresAttention: false }
      : { class: aborted ? "cancelled_or_interrupted" : "protocol_unknown", reason: aborted ? "Pi reported stopReason=aborted." : (errored ? "Pi reported stopReason=error." : "Pi settled without a final assistant message."), detail: null, resumable: false, requiresAttention: false },
    finalMessage: completed ? outcome.text : null, finalMessageAbsenceReason: completed ? null : (aborted ? "aborted" : (errored ? "provider_error" : "no_final_message")),
    progress: null, metrics: terminalMetricsFromEvidence({ providerReported: {
      duration_ms: null,
      duration_api_ms: null,
      turn_count: null,
      input_tokens: delta.input_tokens,
      output_tokens: delta.output_tokens,
      cache_creation_input_tokens: delta.cache_creation_input_tokens,
      cache_read_input_tokens: delta.cache_read_input_tokens,
      reported_cost_usd: null,
    }, toolCallCount: delta.tool_call_count, attemptCount: 1, recoveryAttemptCount: 0 }),
    resultMetadata: { entriesLeafId: leafId ?? null, stopReason: outcome?.stopReason ?? null },
    driverReceipt: boundedDriverReceipt(PI_HARNESS_ID, PI_DRIVER_VERSION, { outcome: completed ? "message_end" : "no_final_message", usage: delta }),
  };
}
function routeCapabilities() {
  return Object.freeze({ capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION, driverMaturity: "experimental",
    values: Object.freeze({ interaction: "noninteractive_fixed_policy", activeInput: "acknowledged_active_stream", continuation: "exact_resume", history: "assistant_messages", interruptRequest: "supported", turnObservation: "terminal_observable", nativeProgress: "native_coalesced", automaticRecovery: "none", authorityEnforcement: "prompt_only", leafEnforcement: "prompt_only", nativeOrchestration: "opaque_bounded" }),
    maturity: Object.freeze(Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((key) => [key, "experimental"]).concat([["turnObservation", "validated"], ["nativeProgress", "validated"]]))),
    provenance: Object.freeze(Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((key) => [key, "checkout_declared"]))),
  });
}

function inspectionRouteFacts(models, effortsByModel) {
  return Object.freeze({
    models: Object.freeze([...models]),
    topologies: Object.freeze(["leaf"]),
    effortsByModel: Object.freeze(Object.fromEntries(Object.entries(effortsByModel).map(([model, efforts]) => [model, Object.freeze([...efforts])]))),
    interaction: "noninteractive_fixed_policy",
    activeInput: "acknowledged_active_stream",
    continuation: "exact_resume",
    history: "assistant_messages",
    interruptRequest: "supported",
    turnObservation: "terminal_observable",
    nativeProgress: "native_coalesced",
    automaticRecovery: "none",
    nativeOrchestration: "opaque_bounded",
    authorities: Object.freeze({ behavioral_read_only: Object.freeze({ authorityEnforcement: "prompt_only", leafEnforcement: "prompt_only" }), behavioral_write: Object.freeze({ authorityEnforcement: "prompt_only", leafEnforcement: "prompt_only" }) }),
  });
}

function fixedPrompt(envelope) {
  const authority = envelope.authority === "behavioral_write"
    ? "Task-scoped writes are permitted only when needed for the stated task."
    : "Read only. Do not change files, processes, configuration, or external state.";
  return [
    "HarnessDock route contract:",
    `- ${authority}`,
    "- Work as one leaf Agent. Do not delegate, spawn another agent, or start another harness.",
    "- Do not ask the user for input; decide and continue.",
    "- Return one final assistant message to the Codex lead.",
    "",
    "Task:",
    envelope.taskInput,
  ].join("\n");
}

function piDiscoveryFailure(error) {
  const code = String(error?.code ?? "");
  if (/PI_CODING_AGENT_DIR/.test(String(error?.message ?? ""))) return "configuration_missing";
  if (code === "ENOENT" || code === "spawn_failed" || code === "process_error" || code === "process_exit" || code === "stdin_error") return "executable_missing";
  if (code === "response_timeout") return "rpc_timeout";
  if (["invalid_response", "response_too_large", "request_rejected"].includes(code)) return "rpc_incompatible";
  return "protocol_error";
}

/** The Pi Driver. `_test` is private fixture-only process/probe injection. */
export function createPiDriver(options = {}) {
  const fixedEnv = options.env ?? process.env;
  const test = options._test ?? null;
  const sessionRoot = test?.sessionRoot ?? path.join(resolvePluginRuntimeRoot(), "pi-sessions");
  const inspectionGeneration = () => typeof test?.inspectionGeneration === "function"
    ? test.inspectionGeneration()
    : (test?.inspectionGeneration ?? "unavailable");
  function modelList(value) {
    const rows = Array.isArray(value?.models) ? value.models : (Array.isArray(value) ? value : []);
    if (rows.length === 0 || rows.length > MAX_DISCOVERED_MODELS) throw new Error("Pi RPC returned no bounded available models.");
    const models = rows.map((row) => typeof row === "string" ? row : `${row?.provider ?? ""}/${row?.id ?? ""}`).map((model) => exactRouteText(model, "Pi discovered model"));
    if (new Set(models).size !== models.length) throw new Error("Pi RPC returned duplicate available models.");
    return models;
  }
  function thinkingLevels(value) {
    const levels = Array.isArray(value?.thinkingLevels) ? value.thinkingLevels : (Array.isArray(value?.levels) ? value.levels : value);
    if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_DISCOVERED_EFFORTS) throw new Error("Pi RPC returned no bounded thinking levels.");
    const output = levels.map((level) => typeof level === "string" ? level : level?.id);
    if (!output.every(isBoundedRouteAtom)) throw new Error("Pi discovered thinking level requires bounded exact text.");
    if (new Set(output).size !== output.length) throw new Error("Pi RPC returned duplicate thinking levels.");
    return output;
  }
  async function discover(scope) {
    const configRoot = scope?.env
      ? scope.env.PI_CODING_AGENT_DIR
      : fixedEnv.PI_CODING_AGENT_DIR;
    if (typeof configRoot !== "string" || !configRoot) throw new Error("Pi requires PI_CODING_AGENT_DIR through the bounded runtime environment.");
    const rpc = createPiRpcProcess({ argv: piRpcArgv({ provider: null, model: null, effort: null, sessionDir: sessionRoot, sessionId: null, resumeSessionId: null, control: true }), cwd: scope?.workspaceRoot ?? process.cwd(), env: { ...fixedEnv, PI_CODING_AGENT_DIR: configRoot }, ...(test ? { _test: test } : {}) });
    try {
      const models = modelList((await rpc.getAvailableModels()).data);
      const effortsByModel = {};
      for (const model of models) {
        const selected = modelParts(model);
        await rpc.setModel(selected.provider, selected.model);
        const efforts = thinkingLevels((await rpc.getAvailableThinkingLevels()).data);
        const state = (await rpc.getState()).data;
        if (state?.model && `${state.model.provider ?? ""}/${state.model.id ?? ""}` !== model) throw new Error("Pi RPC selected a different model during discovery.");
        // `get_state` proves the exact `set_model` control operation took
        // effect. Its local default thinking level is deliberately not read
        // into route state: every HarnessDock turn states its own effort.
        effortsByModel[model] = efforts;
      }
      const commands = (await rpc.getCommands()).data;
      const parity = commands?.commands ?? commands;
      if (!Array.isArray(parity) || parity.length > 256) throw new Error("Pi RPC command parity witness is unavailable.");
      const group = { extension: 0, prompt: 1, skill: 2 };
      let prior = -1;
      for (const item of parity) {
        const kind = item?.source ?? item?.kind;
        if (!Object.hasOwn(group, kind) || group[kind] < prior) throw new Error("Pi RPC command parity order is not native extensions, templates, then skills.");
        prior = group[kind];
      }
      return Object.freeze({ models: Object.freeze(models), effortsByModel: Object.freeze(effortsByModel) });
    } finally { await rpc.dispose(); }
  }
  function assertRoute(route, label) {
    if (route?.harnessId !== PI_HARNESS_ID || route?.driverVersion !== PI_DRIVER_VERSION || route?.instanceKey !== INSTANCE_KEY) throw new Error(`${label} belongs to a foreign Pi route.`);
    modelParts(route.model);
    if (route.topology !== "leaf" || !["behavioral_read_only", "behavioral_write"].includes(route.authority)) throw new Error(`${label} is not an admitted Pi route.`);
    return route;
  }
  function makeProcess({ route, effort = null, sessionId, resumeOnly = false, resume = false, cwd, env = fixedEnv }) {
    fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    const target = modelParts(route.model);
    return createPiRpcProcess({ argv: piRpcArgv({ provider: target.provider, model: target.model, effort, sessionDir: sessionRoot, sessionId, resumeSessionId: resume || resumeOnly ? sessionId : null, resumeOnly }), cwd, env, ...(test ? { _test: test } : {}) });
  }
  function sessionRefFor(route, sessionId) { return assertNativeReferenceEnvelope(reference({ sessionId }), { driver, route, kind: "session" }); }
  function turnRefFor(route, sessionId, turnId, baseline) { return assertNativeReferenceEnvelope(reference({ sessionId, turnId, baselineLeafId: baseline.leafId, baselineStats: baseline.stats }), { driver, route, kind: "turn" }); }
  async function proveCurrentRoute(route, scope) {
    const fresh = await driver.inspectInstances(scope);
    const accepted = driver.validateRoute({ harnessId: PI_HARNESS_ID, model: route.model, topology: route.topology, authority: route.authority, effort: route.effort }, fresh[0]);
    if (["harnessId", "instanceKey", "model", "topology", "authority", "effort", "driverVersion"].some((key) => accepted[key] !== route[key])) throw new Error("Pi route drifted before native operation.");
    return accepted;
  }
  async function openReadOnly(route, sessionId, scope, since = null) {
    const rpc = makeProcess({ route, sessionId, resumeOnly: true, cwd: scope?.workspaceRoot ?? process.cwd() });
    try { return { rpc, entries: await rpc.getEntries(since) }; } catch (error) { await rpc.dispose(); throw error; }
  }
  async function observeTurn(nativeTurnRef, scope) {
    const route = assertRoute(scope?.route, "Pi turn observation route");
    let ref;
    try { ref = assertNativeReferenceEnvelope(nativeTurnRef, { driver, route, kind: "turn" }); }
    catch { return observation("unknown"); }
    const locator = ref.locator;
    if (scope?.signal?.aborted || (scope?.deadlineAt && Date.parse(scope.deadlineAt) <= Date.now())) return observation("unknown");
    let rpc;
    let rpcEntries;
    try {
      rpc = makeProcess({ route, sessionId: locator.sessionId, resumeOnly: true, cwd: scope?.workspaceRoot ?? process.cwd() });
      const state = (await rpc.getState()).data;
      const target = modelParts(route.model);
      if (state?.sessionId !== locator.sessionId || state?.model?.provider !== target.provider || state?.model?.id !== target.model) return observation("unknown");
      if (state?.isStreaming === true || state?.isCompacting === true) return observation("active");
      if (state?.isStreaming !== false || state?.isCompacting !== false) return observation("unknown");
      rpcEntries = await rpc.getEntries(locator.baselineLeafId);
      const data = rpcEntries.data;
      const entries = data?.entries;
      if (!Array.isArray(entries) || entries.length > 1024 || (data.leafId !== null && typeof data.leafId !== "string")) return observation("unknown");
      let post = entries;
      if (locator.baselineLeafId != null) {
        const baselineIndex = entries.findIndex((entry) => entry?.id === locator.baselineLeafId);
        if (baselineIndex >= 0) post = entries.slice(baselineIndex + 1);
      }
      let parent = locator.baselineLeafId;
      for (const entry of post) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return observation("unknown");
        if (entry.sessionId != null && entry.sessionId !== locator.sessionId) return observation("unknown");
        if (entry.id != null && typeof entry.id !== "string") return observation("unknown");
        if (entry.parentId != null && entry.parentId !== parent) return observation("unknown");
        if (typeof entry.id === "string") parent = entry.id;
        if (entry.type === "message") {
          if (typeof entry.id !== "string" || !entry.id || !entry.message || typeof entry.message !== "object") return observation("unknown");
        }
      }
      let after;
      try {
        after = nativeStats((await rpc.getSessionStats()).data, "Pi observed stats");
        statsDelta(locator.baselineStats, after);
      } catch { return observation("unknown"); }
      const terminalCandidates = post.filter((entry) => entry?.type === "message" && entry.message?.role === "assistant" && ["stop", "length", "error", "aborted"].includes(entry.message.stopReason));
      if (terminalCandidates.length > 1) return observation("unknown");
      if (terminalCandidates.length === 1) {
        const terminal = terminalCandidates[0];
        if (typeof terminal.timestamp === "string" ? Number.isNaN(Date.parse(terminal.timestamp)) : !Number.isSafeInteger(terminal.timestamp)) return observation("unknown");
        if (typeof data.leafId === "string" && post.some((entry) => entry.id === data.leafId) && terminal.id !== data.leafId) return observation("unknown");
        const outcome = messageOutcome(terminal);
        if (!outcome) return observation("unknown");
        let terminalResult;
        try { terminalResult = resultFor({ nativeTurnRef: ref, nativeSessionRef: sessionRefFor(route, locator.sessionId), baseline: { stats: locator.baselineStats }, after, outcome, leafId: data.leafId }); }
        catch { return observation("unknown"); }
        return observation("terminal", terminalResult);
      }
      return observation("active");
    } catch {
      return observation("unknown");
    } finally {
      if (rpc) await rpc.dispose().catch(() => {});
    }
  }
  const driver = {
    harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, contractVersion: DRIVER_CONTRACT_VERSION_V2,
    describe() { return { harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, contractVersion: DRIVER_CONTRACT_VERSION_V2, capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION, maturity: "experimental", title: "Pi RPC", environmentKeys: ["PI_CODING_AGENT_DIR"] }; },
    async inspectInstances(scope) {
      try {
        const facts = await discover(scope);
        const routes = inspectionRouteFacts(facts.models, facts.effortsByModel);
        return [{ harnessId: PI_HARNESS_ID, instanceKey: INSTANCE_KEY, readiness: "ready", liveValidated: true, maturity: "experimental", detailCode: "ready", routes: Object.freeze(routes), capabilityProvenance: routeCapabilities().provenance, inspectionGeneration: inspectionGeneration() }];
      } catch (error) {
        return [{ harnessId: PI_HARNESS_ID, instanceKey: INSTANCE_KEY, readiness: "unavailable", liveValidated: true, maturity: "experimental", detailCode: piDiscoveryFailure(error), routes: null, capabilityProvenance: routeCapabilities().provenance, inspectionGeneration: inspectionGeneration() }];
      }
    },
    validateRoute(request, inspection) {
      if (inspection?.instanceKey !== INSTANCE_KEY || inspection?.readiness !== "ready") throw new Error("Pi instance is not ready.");
      const model = exactRouteText(request?.model, "Pi requested model");
      if (request?.topology !== "leaf") throw new Error("Pi admits leaf topology only.");
      if (!["behavioral_read_only", "behavioral_write"].includes(request?.authority)) throw new Error("Pi requires explicit read or write authority.");
      const efforts = inspection.routes?.effortsByModel?.[model];
      if (!Array.isArray(efforts) || efforts.length === 0) throw new Error("Pi requested model is not freshly admitted.");
      const effort = request?.effort;
      if (!isBoundedRouteAtom(effort)) throw new Error("Pi requested effort requires bounded exact text.");
      if (!efforts.includes(effort)) throw new Error("Pi requested effort is not freshly admitted for this exact model.");
      return { harnessId: PI_HARNESS_ID, instanceKey: INSTANCE_KEY, model, topology: "leaf", authority: request.authority, effort, driverVersion: PI_DRIVER_VERSION, capabilities: routeCapabilities() };
    },
    prepareTurn(input) {
      const route = assertRoute(input?.route, "Prepared Pi turn"); const taskInput = requiredText(input?.taskInput, "Pi task input"); const options = turnOptions(input?.turnOptions, route);
      return { harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, route, turnOptions: options, promptEnvelope: { taskInput, authority: route.authority, topology: route.topology, returnContract: "Return one final assistant message." }, inputDigest: `sha256:${createHash("sha256").update(JSON.stringify([route.model, options.effort, taskInput])).digest("hex")}` };
    },
    async revalidatePreparedTurn(prepared, scope) {
      assertRoute(prepared?.route, "Prepared Pi turn"); assertRoute(scope?.route, "Pi turn scope");
      await proveCurrentRoute(scope.route, scope);
      if (prepared.promptEnvelope?.taskInput !== scope?.taskInput || JSON.stringify(turnOptions(scope?.turnOptions, scope.route)) !== JSON.stringify(prepared.turnOptions)) throw new Error("Pi prepared turn differs from its scope.");
      return Object.freeze({ workspaceRoot: scope?.workspaceRoot ?? process.cwd() });
    },
    validateNativeSessionRef(value) {
      if (value?.harnessId !== PI_HARNESS_ID || value?.driverVersion !== PI_DRIVER_VERSION || value?.instanceKey !== INSTANCE_KEY || value?.locatorVersion !== LOCATOR_VERSION || Object.keys(value?.locator ?? {}).join(",") !== "sessionId") throw new Error("A Pi native session locator is exactly {sessionId}.");
      uuid(value.locator.sessionId, "Pi native session ID"); return value;
    },
    validateNativeTurnRef(value) {
      const locator = value?.locator ?? {}; const keys = Object.keys(locator).sort();
      if (value?.harnessId !== PI_HARNESS_ID || value?.driverVersion !== PI_DRIVER_VERSION || value?.instanceKey !== INSTANCE_KEY || value?.locatorVersion !== LOCATOR_VERSION || keys.join(",") !== "baselineLeafId,baselineStats,sessionId,turnId") throw new Error("A Pi native turn locator has one exact baseline schema.");
      uuid(locator.sessionId, "Pi native turn session ID"); requiredText(locator.turnId, "Pi native turn ID");
      if (locator.baselineLeafId !== null && (typeof locator.baselineLeafId !== "string" || !locator.baselineLeafId)) throw new Error("Pi native turn baseline leaf is invalid.");
      assertNativeStats(locator.baselineStats, "Pi native turn baseline"); return value;
    },
    observeTurn,
    async readAssistantHistory(agent, page = {}) {
      const route = assertRoute(agent?.route, "Pi Agent history route"); const sessionId = assertNativeReferenceEnvelope(agent?.nativeSessionRef, { driver, route, kind: "session" }).locator.sessionId;
      const limit = page.limit == null ? 1 : Number(page.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_MESSAGE_LIMIT) throw new Error(`read_agent_messages limit must be between 1 and ${MAX_AGENT_MESSAGE_LIMIT}.`);
      const before = page.before == null ? null : requiredText(String(page.before), "read_agent_messages before cursor");
      await proveCurrentRoute(route, page);
      const { rpc, entries } = await openReadOnly(route, sessionId, page);
      try {
        const newest = (entries.data?.entries ?? []).map(messageOutcome).filter(Boolean).reverse();
        const start = before == null ? 0 : newest.findIndex((message) => message.messageId === before) + 1;
        if (before != null && start === 0) throw new Error("read_agent_messages before cursor is not an eligible message for this Agent.");
        const messages = newest.slice(start, start + limit).map(({ messageId, timestamp, text }) => ({ messageId, timestamp, text }));
        return { messages, nextBefore: start + messages.length < newest.length && messages.length ? messages.at(-1).messageId : null };
      } finally { await rpc.dispose(); }
    },
    async startTurn(input) {
      const scope = input?.scope; let route; let effort; let sessionId; let resumed = false;
      try {
        route = assertRoute(scope?.route, "Pi turn scope"); assertRoute(input?.preparedTurn?.route, "Prepared Pi turn"); effort = turnOptions(scope?.turnOptions, route).effort;
        if (JSON.stringify(input.preparedTurn.turnOptions) !== JSON.stringify({ effort })) throw new Error("Pi prepared effort differs from scope.");
        requiredText(scope?.turnId, "Pi turn identity"); resumed = input?.nativeSessionRef != null; sessionId = resumed ? assertNativeReferenceEnvelope(input.nativeSessionRef, { driver, route, kind: "session" }).locator.sessionId : randomUUID();
      } catch (error) { throw preTransport(error); }
      let rpc;
      try { rpc = makeProcess({ route, effort, sessionId, resume: resumed, cwd: input?.launchContext?.workspaceRoot ?? scope.workspaceRoot }); } catch (error) { throw preTransport(error); }
      const nativeSessionRef = sessionRefFor(route, sessionId); let baseline;
      try {
        const state = (await rpc.getState()).data;
        const target = modelParts(route.model);
        if (state?.sessionId !== sessionId || state?.model?.provider !== target.provider || state?.model?.id !== target.model || state?.thinkingLevel !== effort || state?.isStreaming !== false || state?.isCompacting !== false) throw new Error("Pi RPC state does not match the accepted route and idle session.");
        const entries = await rpc.getEntries(null); baseline = { leafId: entries.data?.leafId ?? null, stats: nativeStats((await rpc.getSessionStats()).data, "Pi baseline stats") };
        await rpc.setAutoRetry(false); await rpc.setAutoCompaction(true); await rpc.setSteeringMode("one-at-a-time"); await rpc.setFollowUpMode("one-at-a-time");
      } catch (error) { await rpc.dispose(); throw preTransport(error); }
      const nativeTurnRef = turnRefFor(route, sessionId, scope.turnId, baseline); let promptWritten = false;
      try { promptWritten = true; await rpc.prompt(fixedPrompt(input.preparedTurn.promptEnvelope)); }
      catch (error) { await rpc.dispose(); if (!promptWritten || error?.code === "request_rejected") throw preTransport(error); throw error; }
      let settled = false;
      const result = (async () => {
        try {
          const settledEvent = await rpc.waitForSettled(); settled = true;
          const entries = await rpc.getEntries(baseline.leafId); const after = nativeStats((await rpc.getSessionStats()).data, "Pi post-turn stats");
          return resultFor({ nativeTurnRef, nativeSessionRef, baseline, after, outcome: messageEndOutcome(settledEvent.finalAssistantMessage), leafId: entries.data?.leafId ?? null });
        } finally { await rpc.dispose(); }
      })();
      result.catch(() => {});
      return { nativeSessionRef, nativeTurnRef, result,
        subscribeProgress(listener) { return rpc.subscribeProgress(listener); },
        async deliverActiveInput(assigned) { try { await rpc.steer(requiredText(assigned?.text, "Pi steering input")); return { accepted: true, sequence: assigned?.messageId ?? null, mode: "pi_rpc_steer" }; } catch (error) { return { accepted: false, reason: "native_turn_did_not_accept_input", detail: String(error?.code ?? "rpc_error") }; } },
        async requestInterrupt(command) { if (command?.kind !== "interrupt") return { commandId: command?.commandId ?? null, requestState: "unsupported", nativeTurnState: settled ? "terminal" : "active", settlement: "pending" }; try { await rpc.abort(); return { commandId: command?.commandId ?? null, requestState: "accepted", nativeTurnState: settled ? "terminal" : "active", settlement: settled ? "settled" : "pending" }; } catch { return { commandId: command?.commandId ?? null, requestState: "rejected", nativeTurnState: settled ? "terminal" : "unknown", settlement: settled ? "settled" : "unknown" }; } },
        dispose: () => rpc.dispose(),
      };
    },
  };
  return Object.freeze(driver);
}
