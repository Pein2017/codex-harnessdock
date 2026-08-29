/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Direct OpenCode HTTP oracle for the native differential fixture. This file
 * deliberately imports no HarnessDock code, OpenCode SDK, or generated
 * expectation: it speaks the pinned HTTP boundary with `fetch` alone.
 */
import { createHash } from "node:crypto";

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requestPath(url) {
  const parsed = new URL(url);
  return parsed.pathname;
}

async function jsonRequest(serverUrl, method, path, body, events) {
  const requestUrl = `${serverUrl}${path}`;
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  const parsed = new URL(requestUrl);
  events.push({
    method,
    path: requestPath(requestUrl),
    query: Object.fromEntries(parsed.searchParams.entries()),
    headers: { authorization: "absent", contentType: body === undefined ? "absent" : "application/json" },
    status: response.status,
    body,
  });
  return { status: response.status, payload };
}

function routeInventory(catalog) {
  const connected = new Set(Array.isArray(catalog?.connected) ? catalog.connected : []);
  const routes = [];
  for (const provider of Array.isArray(catalog?.all) ? catalog.all : []) {
    if (!connected.has(provider?.id) || !provider?.models || typeof provider.models !== "object") continue;
    for (const model of Object.values(provider.models)) {
      const variants = model?.variants && typeof model.variants === "object" ? Object.keys(model.variants).sort() : [];
      if (typeof model?.id === "string" && typeof model?.providerID === "string" && variants.length > 0) {
        routes.push({ model: `${model.providerID}/${model.id}`, efforts: variants });
      }
    }
  }
  return routes.sort((left, right) => left.model.localeCompare(right.model));
}

function hasExactRoute(routes, selection) {
  return routes.some((route) => route.model === selection.model && route.efforts.includes(selection.effort));
}

function terminalEvidence(response, { sessionId, messageId, selection, configurationWitness }) {
  const info = response?.info ?? {};
  const parts = Array.isArray(response?.parts) ? response.parts : [];
  const lineageMatches = info.role === "assistant" &&
    info.sessionID === sessionId &&
    info.parentID === messageId &&
    info.providerID === selection.providerId &&
    info.modelID === selection.modelId &&
    info.variant === selection.effort;
  const partTypes = parts.map((part) => part?.type ?? "invalid");
  const partsMatch = parts.every((part) => part?.sessionID === sessionId && part?.messageID === info.id);
  const texts = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text.trim());
  const finalText = texts.at(-1) ?? null;
  return {
    terminal: lineageMatches && partsMatch && info.finish === "stop" && finalText !== null ? "completed" : "failed",
    lineage: lineageMatches ? "matched" : "mismatched",
    finalText,
    configurationWitness: finalText === configurationWitness ? "loaded" : "missing",
    finish: info.finish ?? null,
    partTypes,
    toolCallCount: partTypes.filter((type) => type === "tool").length,
    provider: lineageMatches ? {
      inputTokens: info.tokens?.input ?? null,
      outputTokens: info.tokens?.output ?? null,
      reasoningTokens: info.tokens?.reasoning ?? null,
      cacheReadTokens: info.tokens?.cache?.read ?? null,
      cacheWriteTokens: info.tokens?.cache?.write ?? null,
      reportedCost: info.cost ?? null,
      provenance: "provider_reported",
      malformedFields: [],
    } : null,
  };
}

function requestEvents(events) {
  return events.map((event) => {
    if (event.method === "GET") return `${event.method} ${event.path}`;
    if (event.path === "/session") return "POST /session";
    return "POST /session/{ephemeral}/message";
  });
}

function normalizedRequests(events) {
  return events.map((event) => {
    const body = event.body == null ? null : structuredClone(event.body);
    const prompt = event.path !== "/session" && event.method === "POST";
    if (prompt) {
      // The direct native task and the Driver envelope intentionally differ.
      // Prompt text and caller-generated message ids are the only elisions.
      body.messageID = "{ephemeral-message-id}";
      body.parts = body.parts.map((part) => ({ ...part, text: "{allowed-prompt-delta}" }));
    }
    return {
      method: event.method,
      path: prompt ? "/session/{ephemeral-session-id}/message" : event.path,
      query: event.query,
      headers: event.headers,
      body,
    };
  });
}

/**
 * A deliberately bounded projection of the native configuration surfaces. It
 * contains no Agent name, pattern, or policy identity; the opaque digests make
 * an otherwise-benign configuration or resolved-policy drift observable.
 */
export function opencodeNativeConfigurationWitness(config, agents) {
  const defaultAgent = typeof config?.default_agent === "string" ? config.default_agent : null;
  const catalog = Array.isArray(agents) ? agents : [];
  const selected = defaultAgent == null ? null : catalog.find((agent) => agent?.name === defaultAgent) ?? null;
  const rules = Array.isArray(selected?.permission)
    ? selected.permission
    : Array.isArray(selected?.ruleset) ? selected.ruleset : null;
  return Object.freeze({
    defaultAgentDigest: digest(defaultAgent),
    selectedAgentDigest: digest(selected?.name ?? null),
    selectedMode: typeof selected?.mode === "string" ? selected.mode : "missing",
    permissionRuleCount: rules?.length ?? -1,
    permissionDigest: digest(rules),
  });
}

/**
 * Run one manual raw-HTTP turn. `beforeRecheck` lets the caller introduce a
 * native catalog drift between discovery and the pre-transport recheck.
 */
export async function runRawHttpOpenCodeOracle({
  serverUrl,
  selection,
  taskInput,
  directory,
  configurationWitness,
  beforeRecheck = null,
}) {
  const events = [];
  const directoryQuery = `?directory=${encodeURIComponent(directory)}`;
  const first = await jsonRequest(serverUrl, "GET", `/provider${directoryQuery}`, undefined, events);
  const inventory = routeInventory(first.payload);
  if (first.status !== 200 || !hasExactRoute(inventory, selection)) {
    return { kind: "route_drift", inventory, events: requestEvents(events), routeDrift: "route_not_admitted" };
  }
  if (beforeRecheck) await beforeRecheck();
  const second = await jsonRequest(serverUrl, "GET", `/provider${directoryQuery}`, undefined, events);
  const recheckedInventory = routeInventory(second.payload);
  if (second.status !== 200 || !hasExactRoute(recheckedInventory, selection)) {
    return { kind: "route_drift", inventory, events: requestEvents(events), routeDrift: "route_not_admitted" };
  }

  // This is intentionally direct raw HTTP rather than a projection from the
  // Driver. The policy remains opaque in the returned witness.
  const config = await jsonRequest(serverUrl, "GET", `/config${directoryQuery}`, undefined, events);
  const agents = await jsonRequest(serverUrl, "GET", `/agent${directoryQuery}`, undefined, events);
  if (config.status !== 200 || agents.status !== 200) throw new Error("Raw OpenCode oracle could not read native configuration.");
  const configuration = opencodeNativeConfigurationWitness(config.payload, agents.payload);

  const sessionBody = { model: { id: selection.modelId, providerID: selection.providerId, variant: selection.effort } };
  const session = await jsonRequest(serverUrl, "POST", `/session${directoryQuery}`, sessionBody, events);
  const sessionId = session.payload?.id;
  if (session.status !== 200 || typeof sessionId !== "string") throw new Error("Raw OpenCode oracle could not create a session.");

  const messageId = "msg_raw_http_oracle";
  const promptBody = {
    messageID: messageId,
    model: { providerID: selection.providerId, modelID: selection.modelId },
    variant: selection.effort,
    parts: [{ type: "text", text: taskInput }],
  };
  const prompt = await jsonRequest(
    serverUrl,
    "POST",
    `/session/${encodeURIComponent(sessionId)}/message${directoryQuery}`,
    promptBody,
    events
  );
  if (prompt.status !== 200) throw new Error("Raw OpenCode oracle prompt did not settle.");

  const terminal = terminalEvidence(prompt.payload, { sessionId, messageId, selection, configurationWitness });
  return {
    kind: "turn",
    inventory,
    requestTransport: { origin: "loopback", requests: normalizedRequests(events.filter((event) => ["/provider", "/session"].includes(event.path) || event.path.endsWith("/message"))) },
    configuration,
    executionDirectory: { witness: terminal.configurationWitness, propagated: "session_and_prompt_directory" },
    events: { requestOrder: requestEvents(events.filter((event) => ["/provider", "/session"].includes(event.path) || event.path.endsWith("/message"))), partTypes: terminal.partTypes, toolCallCount: terminal.toolCallCount },
    terminal: { classification: terminal.terminal, lineage: terminal.lineage, finish: terminal.finish, finalText: terminal.finalText },
    usage: terminal.provider,
    lifecycle: { sessionLifecycle: "fresh_session_per_agent", settled: prompt.status === 200, cleanup: "no_live_client" },
  };
}
