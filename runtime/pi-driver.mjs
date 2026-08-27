/** SPDX-License-Identifier: Apache-2.0 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DRIVER_CONTRACT_VERSION_V2, assertNativeReferenceEnvelope, boundedDriverReceipt, driverPreTransportRejection } from "./harness-contract.mjs";
import { ROUTE_CAPABILITY_SCHEMA_VERSION } from "./harness-capabilities.mjs";
import { NATIVE_REFERENCE_ENVELOPE_VERSION } from "./native-reference.mjs";
import { resolvePluginRuntimeRoot } from "./paths.mjs";
import { plainDataTree } from "./plain-record.mjs";
import { createPiRpcProcess, piRpcArgv } from "./pi-rpc-process.mjs";
import { terminalMetricsFromEvidence } from "./terminal-metrics.mjs";

export const PI_HARNESS_ID = "pi";
export const PI_DRIVER_VERSION = "pi@2";
export const PI_PROVIDER = "openai-codex";
export const PI_MODELS = Object.freeze(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol"]);
export const PI_MODEL_IDS = Object.freeze(PI_MODELS.map((model) => model.slice(`${PI_PROVIDER}/`.length)));
export const PI_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const INSTANCE_KEY = "pi-local";
const LOCATOR_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MAX_AGENT_MESSAGE_LIMIT = 20;

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
function modelId(model) {
  if (!PI_MODELS.includes(model)) throw new Error(`Pi requires exactly one model: ${PI_MODELS.join(", ")}.`);
  return model.slice(`${PI_PROVIDER}/`.length);
}
function turnOptions(value) {
  const data = value == null ? null : plainDataTree(value, "Pi turn options", 1);
  if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, "effort") || !PI_EFFORTS.includes(data.effort)) {
    throw new Error(`Pi turn options require exactly one explicit effort: ${PI_EFFORTS.join(", ")}.`);
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
function routeCapabilities(authority) {
  const read = authority === "behavioral_read_only";
  return Object.freeze({ capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION, driverMaturity: "experimental",
    values: Object.freeze({ interaction: "noninteractive_fixed_policy", activeInput: "acknowledged_active_stream", continuation: "exact_resume", history: "assistant_messages", interruptRequest: "supported", turnObservation: "terminal_observable", automaticRecovery: "none", authorityEnforcement: read ? "harness_policy" : "prompt_only", leafEnforcement: read ? "effective_tool_denial" : "prompt_only", nativeOrchestration: "disabled" }),
    maturity: Object.freeze(Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((key) => [key, "experimental"]))),
  });
}

function inspectionRouteFacts() {
  return Object.freeze({
    models: Object.freeze([...PI_MODELS]),
    provider: PI_PROVIDER,
    topologies: Object.freeze(["leaf"]),
    reasoningEfforts: Object.freeze([...PI_EFFORTS]),
    interaction: "noninteractive_fixed_policy",
    activeInput: "acknowledged_active_stream",
    continuation: "exact_resume",
    history: "assistant_messages",
    interruptRequest: "supported",
    turnObservation: "terminal_observable",
    automaticRecovery: "none",
    nativeOrchestration: "disabled",
    authorities: Object.freeze({
      behavioral_read_only: Object.freeze({
        tools: Object.freeze([...READ_TOOLS]),
        authorityEnforcement: "harness_policy",
        leafEnforcement: "effective_tool_denial",
      }),
      behavioral_write: Object.freeze({
        tools: Object.freeze([...WRITE_TOOLS]),
        authorityEnforcement: "prompt_only",
        leafEnforcement: "prompt_only",
      }),
    }),
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
    "- Return one final assistant message to the Codex lead.",
    "",
    "Task:",
    envelope.taskInput,
  ].join("\n");
}

/** The Pi Driver. `_test` is private fixture-only process/probe injection. */
export function createPiDriver(options = {}) {
  const fixedEnv = options.env ?? process.env;
  const test = options._test ?? null;
  const sessionRoot = test?.sessionRoot ?? path.join(resolvePluginRuntimeRoot(), "pi-sessions");
  const probe = test?.probe ?? ((args) => spawnSync("pi", args, { cwd: process.cwd(), env: fixedEnv, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, shell: false }));
  function hostEvidence() {
    let version; let auth; let models;
    try { version = probe(["--version"]); } catch { return { readiness: "unknown", detailCode: "unknown" }; }
    if (version?.error?.code === "ENOENT") return { readiness: "unavailable", detailCode: "executable_missing" };
    if (version?.error || version?.status !== 0) return { readiness: "unknown", detailCode: "unknown" };
    try { auth = probe(["auth", "check", "--provider", PI_PROVIDER, "--json", "--no-refresh"]); } catch { return { readiness: "unknown", detailCode: "unknown" }; }
    if (auth?.error || auth?.status !== 0) return { readiness: "blocked", detailCode: "not_authenticated" };
    try {
      const parsed = JSON.parse(String(auth.stdout ?? ""));
      if (parsed?.status !== "ready" || parsed?.provider !== PI_PROVIDER) {
        return { readiness: "blocked", detailCode: "not_authenticated" };
      }
    }
    catch { return { readiness: "unknown", detailCode: "unknown" }; }
    try { models = probe(["--offline", "--list-models", PI_PROVIDER]); } catch { return { readiness: "unknown", detailCode: "unknown" }; }
    if (models?.error || models?.status !== 0) return { readiness: "unknown", detailCode: "unknown" };
    const text = String(models.stdout ?? "");
    return PI_MODEL_IDS.every((id) => text.includes(`${PI_PROVIDER}  ${id}`) || text.includes(`${PI_PROVIDER}/${id}`)) ? { readiness: "ready", detailCode: "ready" } : { readiness: "blocked", detailCode: "incompatible_version" };
  }
  function assertRoute(route, label) {
    if (route?.harnessId !== PI_HARNESS_ID || route?.driverVersion !== PI_DRIVER_VERSION || route?.instanceKey !== INSTANCE_KEY) throw new Error(`${label} belongs to a foreign Pi route.`);
    modelId(route.model);
    if (route.topology !== "leaf" || !["behavioral_read_only", "behavioral_write"].includes(route.authority)) throw new Error(`${label} is not an admitted Pi route.`);
    return route;
  }
  function makeProcess({ route, effort = null, sessionId, resumeOnly = false, resume = false, cwd }) {
    fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    return createPiRpcProcess({ argv: piRpcArgv({ provider: PI_PROVIDER, model: modelId(route.model), effort, sessionDir: sessionRoot, sessionId, resumeSessionId: resume || resumeOnly ? sessionId : null, resumeOnly, tools: route.authority === "behavioral_write" ? WRITE_TOOLS : READ_TOOLS }), cwd, env: fixedEnv, ...(test ? { _test: test } : {}) });
  }
  function sessionRefFor(route, sessionId) { return assertNativeReferenceEnvelope(reference({ sessionId }), { driver, route, kind: "session" }); }
  function turnRefFor(route, sessionId, turnId, baseline) { return assertNativeReferenceEnvelope(reference({ sessionId, turnId, baselineLeafId: baseline.leafId, baselineStats: baseline.stats }), { driver, route, kind: "turn" }); }
  async function openReadOnly(route, sessionId, scope) {
    const rpc = makeProcess({ route, sessionId, resumeOnly: true, cwd: scope?.workspaceRoot ?? process.cwd() });
    try { return { rpc, entries: await rpc.getEntries(null) }; } catch (error) { await rpc.dispose(); throw error; }
  }
  const driver = {
    harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, contractVersion: DRIVER_CONTRACT_VERSION_V2,
    describe() { return { harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, contractVersion: DRIVER_CONTRACT_VERSION_V2, capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION, maturity: "experimental", title: "Pi RPC (fixed policy)", environmentKeys: [] }; },
    async inspectInstances() {
      const host = hostEvidence();
      return [{ harnessId: PI_HARNESS_ID, instanceKey: INSTANCE_KEY, readiness: host.readiness, liveValidated: true, maturity: "experimental", detailCode: host.detailCode, routes: host.readiness === "ready" ? inspectionRouteFacts() : null }];
    },
    validateRoute(request, inspection) {
      if (inspection?.instanceKey !== INSTANCE_KEY || inspection?.readiness !== "ready") throw new Error("Pi instance is not ready.");
      modelId(request?.model);
      if (request?.topology !== "leaf") throw new Error("Pi admits leaf topology only.");
      if (!["behavioral_read_only", "behavioral_write"].includes(request?.authority)) throw new Error("Pi requires explicit read or write authority.");
      return { harnessId: PI_HARNESS_ID, instanceKey: INSTANCE_KEY, model: request.model, topology: "leaf", authority: request.authority, driverVersion: PI_DRIVER_VERSION, capabilities: routeCapabilities(request.authority) };
    },
    prepareTurn(input) {
      const route = assertRoute(input?.route, "Prepared Pi turn"); const taskInput = requiredText(input?.taskInput, "Pi task input"); const options = turnOptions(input?.turnOptions);
      return { harnessId: PI_HARNESS_ID, driverVersion: PI_DRIVER_VERSION, route, turnOptions: options, promptEnvelope: { taskInput, authority: route.authority, topology: route.topology, returnContract: "Return one final assistant message." }, inputDigest: `sha256:${createHash("sha256").update(JSON.stringify([route.model, options.effort, taskInput])).digest("hex")}` };
    },
    async revalidatePreparedTurn(prepared, scope) {
      assertRoute(prepared?.route, "Prepared Pi turn"); assertRoute(scope?.route, "Pi turn scope");
      if (hostEvidence().readiness !== "ready") throw new Error("Pi host evidence no longer admits this route.");
      if (prepared.promptEnvelope?.taskInput !== scope?.taskInput || JSON.stringify(turnOptions(scope?.turnOptions)) !== JSON.stringify(prepared.turnOptions)) throw new Error("Pi prepared turn differs from its scope.");
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
    async readAssistantHistory(agent, page = {}) {
      const route = assertRoute(agent?.route, "Pi Agent history route"); const sessionId = assertNativeReferenceEnvelope(agent?.nativeSessionRef, { driver, route, kind: "session" }).locator.sessionId;
      const limit = page.limit == null ? 1 : Number(page.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_MESSAGE_LIMIT) throw new Error(`read_agent_messages limit must be between 1 and ${MAX_AGENT_MESSAGE_LIMIT}.`);
      const before = page.before == null ? null : requiredText(String(page.before), "read_agent_messages before cursor");
      const { rpc, entries } = await openReadOnly(route, sessionId, page);
      try {
        const newest = (entries.data?.entries ?? []).map(messageOutcome).filter(Boolean).reverse();
        const start = before == null ? 0 : newest.findIndex((message) => message.messageId === before) + 1;
        if (before != null && start === 0) throw new Error("read_agent_messages before cursor is not an eligible message for this Agent.");
        const messages = newest.slice(start, start + limit).map(({ messageId, timestamp, text }) => ({ messageId, timestamp, text }));
        return { messages, nextBefore: start + messages.length < newest.length && messages.length ? messages.at(-1).messageId : null };
      } finally { await rpc.dispose(); }
    },
    async observeTurn(nativeTurnRef, scope) {
      let route; let ref;
      try { route = assertRoute(scope?.route, "Pi observation route"); ref = assertNativeReferenceEnvelope(nativeTurnRef, { driver, route, kind: "turn" }); } catch { return { nativeTurn: "unknown", terminalResult: null }; }
      if (scope?.signal?.aborted) return { nativeTurn: "unknown", terminalResult: null };
      let rpc;
      try {
        rpc = makeProcess({ route, sessionId: ref.locator.sessionId, resumeOnly: true, cwd: scope?.workspaceRoot ?? process.cwd() });
        const entries = await rpc.getEntries(ref.locator.baselineLeafId);
        const after = nativeStats((await rpc.getSessionStats()).data, "Pi observed post-turn stats");
        const outcome = [...(entries.data?.entries ?? [])].reverse().map(messageOutcome).find(Boolean) ?? null;
        if (!outcome) return { nativeTurn: "unknown", terminalResult: null };
        const baseline = { leafId: ref.locator.baselineLeafId, stats: assertNativeStats(ref.locator.baselineStats, "Pi observation baseline") };
        return { nativeTurn: "terminal", terminalResult: resultFor({ nativeTurnRef: ref, nativeSessionRef: sessionRefFor(route, ref.locator.sessionId), baseline, after, outcome, leafId: entries.data?.leafId ?? null }) };
      } catch { return { nativeTurn: "unknown", terminalResult: null }; } finally { await rpc?.dispose(); }
    },
    async startTurn(input) {
      const scope = input?.scope; let route; let effort; let sessionId; let resumed = false;
      try {
        route = assertRoute(scope?.route, "Pi turn scope"); assertRoute(input?.preparedTurn?.route, "Prepared Pi turn"); effort = turnOptions(scope?.turnOptions).effort;
        if (JSON.stringify(input.preparedTurn.turnOptions) !== JSON.stringify({ effort })) throw new Error("Pi prepared effort differs from scope.");
        requiredText(scope?.turnId, "Pi turn identity"); resumed = input?.nativeSessionRef != null; sessionId = resumed ? assertNativeReferenceEnvelope(input.nativeSessionRef, { driver, route, kind: "session" }).locator.sessionId : randomUUID();
      } catch (error) { throw preTransport(error); }
      let rpc;
      try { rpc = makeProcess({ route, effort, sessionId, resume: resumed, cwd: input?.launchContext?.workspaceRoot ?? scope.workspaceRoot }); } catch (error) { throw preTransport(error); }
      const nativeSessionRef = sessionRefFor(route, sessionId); let baseline;
      try {
        const state = (await rpc.getState()).data;
        if (state?.sessionId !== sessionId || state?.model?.provider !== PI_PROVIDER || state?.model?.id !== modelId(route.model) || state?.thinkingLevel !== effort || state?.isStreaming !== false || state?.isCompacting !== false) throw new Error("Pi RPC state does not match the accepted route and idle session.");
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
        async deliverActiveInput(assigned) { try { await rpc.steer(requiredText(assigned?.text, "Pi steering input")); return { accepted: true, sequence: assigned?.messageId ?? null, mode: "pi_rpc_steer" }; } catch (error) { return { accepted: false, reason: "native_turn_did_not_accept_input", detail: String(error?.code ?? "rpc_error") }; } },
        async requestInterrupt(command) { if (command?.kind !== "interrupt") return { commandId: command?.commandId ?? null, requestState: "unsupported", nativeTurnState: settled ? "terminal" : "active", settlement: "pending" }; try { await rpc.abort(); return { commandId: command?.commandId ?? null, requestState: "accepted", nativeTurnState: settled ? "terminal" : "active", settlement: settled ? "settled" : "pending" }; } catch { return { commandId: command?.commandId ?? null, requestState: "rejected", nativeTurnState: settled ? "terminal" : "unknown", settlement: settled ? "settled" : "unknown" }; } },
        dispose: () => rpc.dispose(),
      };
    },
  };
  return Object.freeze(driver);
}
