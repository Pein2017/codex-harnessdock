#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zero-model, zero-session compatibility probe for the operator-owned
 * OpenCode loopback Server (add-opencode-explorer-driver, Task 1).
 *
 * This script never creates an OpenCode session, message, prompt, or model
 * request. It only reads: the installed CLI version/model-catalog text, the
 * pinned `@opencode-ai/sdk` v2 client's side-effect-free GET discovery
 * (health/agents/providers/capabilities), and the installed SDK package's
 * own declared type shapes. It never imports the SDK's Server-spawning
 * helper, never parses CLI lifecycle/session output, and never falls back to
 * ad hoc HTTP outside the pinned client.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createFixedOriginFetch, isLoopbackOpencodeUrl } from "../runtime/opencode-client.mjs";

export const EXPECTED_HARNESS = "opencode";
export const EXPECTED_PROVIDER_ID = "openai";
export const EXPECTED_MODEL_ID = "gpt-5.6-luna";
export const EXPECTED_MODEL = `${EXPECTED_PROVIDER_ID}/${EXPECTED_MODEL_ID}`;
export const EXPECTED_EXPLORER_PROFILE = "codex-explorer";

export const DEFAULT_OPENCODE_BIN = "opencode";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4096";
export const DEFAULT_TIMEOUT_MS = 10_000;

export const PINNED_SDK_PACKAGE = "@opencode-ai/sdk";
export const PINNED_SDK_VERSION = "1.18.18";
export const PINNED_SDK_INTEGRITY =
  "sha512-zJlwXskIR47V1dkPJqeKBgq7nejG1uU8lJaGIGqbX3MWRCT8vKn0fEotbxuPCKnTdmWsDyNGNg9q1qIliDSMDA==";

const INCARNATION_CANDIDATE_KEYS = new Set([
  "instanceid",
  "instanceId".toLowerCase(),
  "pid",
  "bootid",
  "bootId".toLowerCase(),
  "incarnation",
  "incarnationid",
  "serverinstance",
  "serverinstanceid",
]);

// ---------------------------------------------------------------------------
// Pure parsing / sanitization helpers (no I/O; unit-testable in isolation).
// ---------------------------------------------------------------------------

/**
 * Whether one stated Server origin may be probed.
 *
 * This delegates to the runtime client's own predicate rather than restating
 * it. The probe pins the SAME origin the runtime pins, so a looser rule here
 * would be a second, weaker door into the same room: this probe previously
 * admitted `localhost`, which is a NAME resolved by the resolver at connect
 * time, so the address actually contacted is decided after the check passes.
 * The runtime admits literal loopback addresses only for exactly that reason,
 * and one owner for the rule is what keeps the two from drifting apart again.
 */
export function isLoopbackUrl(rawUrl) {
  return isLoopbackOpencodeUrl(rawUrl);
}

export function parseCliVersion(stdout) {
  const text = String(stdout ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(text) ? text : null;
}

export function parseModelCatalog(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][\w.:-]*$/.test(line));
}

export function sanitizeAgentList(rawAgents) {
  if (!Array.isArray(rawAgents)) return { ok: false, agents: [] };
  const agents = rawAgents
    .filter((agent) => agent && typeof agent.name === "string")
    .map((agent) => ({
      name: agent.name,
      mode: typeof agent.mode === "string" ? agent.mode : null,
      native: agent.native === true,
    }));
  return { ok: true, agents };
}

export function sanitizeProviderCatalog(rawPayload, providerId, modelId) {
  const all = Array.isArray(rawPayload?.all) ? rawPayload.all : [];
  const connected = Array.isArray(rawPayload?.connected)
    ? rawPayload.connected.filter((id) => typeof id === "string")
    : [];
  const provider = all.find((candidate) => candidate && candidate.id === providerId);
  const rawModel =
    provider && provider.models && typeof provider.models === "object" ? provider.models[modelId] : undefined;
  const model = rawModel
    ? {
        id: typeof rawModel.id === "string" ? rawModel.id : null,
        providerID: typeof rawModel.providerID === "string" ? rawModel.providerID : null,
        name: typeof rawModel.name === "string" ? rawModel.name : null,
        family: typeof rawModel.family === "string" ? rawModel.family : null,
      }
    : null;
  return {
    connected,
    providerPresent: Boolean(provider),
    providerConnected: connected.includes(providerId),
    model,
  };
}

export function sanitizeCapabilities(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return {};
  return { backgroundSubagents: rawPayload.backgroundSubagents === true };
}

/**
 * Projects raw CLI discovery (which may hold the full model catalog and an
 * absolute/operator-chosen binary path) down to a closed, portable shape:
 * a discovery mode (never the raw path) and closed target-model facts (never
 * unrelated model identifiers). The full catalog stays process-local to the
 * caller for `classifyModelRoute` and is never returned here.
 */
export function projectCliDiscovery(cli, opencodeBin) {
  return {
    binMode: opencodeBin === DEFAULT_OPENCODE_BIN ? "path_discovery" : "explicit_override",
    version: cli.version,
    modelCatalog: cli.modelCatalog.ok
      ? {
          ok: true,
          targetPresent: cli.modelCatalog.models.includes(EXPECTED_MODEL),
          observedCount: cli.modelCatalog.models.length,
        }
      : cli.modelCatalog,
  };
}

/**
 * Projects raw Server discovery (which may hold the full connected-provider
 * list and every available Agent name) down to a closed, portable shape:
 * only target-provider presence/connected + target model, and drops the
 * agent-name list entirely (the caller derives `profile.present` from it
 * before this projection runs; the full list is never returned here).
 */
export function projectServerDiscovery(server) {
  if (!server.reachable) {
    return {
      baseUrl: server.baseUrl,
      loopback: server.loopback,
      reachable: false,
      reason: server.reason,
      requestAudit: server.requestAudit ?? null,
    };
  }
  return {
    baseUrl: server.baseUrl,
    loopback: server.loopback,
    reachable: true,
    health: server.health,
    provider: {
      providerPresent: server.provider.providerPresent,
      providerConnected: server.provider.providerConnected,
      model: server.provider.model,
    },
    capabilities: server.capabilities,
    requestAudit: server.requestAudit,
  };
}

export function classifyModelRoute({ cliModels, providerCatalog }) {
  const cliMatch = Array.isArray(cliModels) && cliModels.includes(EXPECTED_MODEL);
  const serverMatch = Boolean(
    providerCatalog &&
      providerCatalog.providerConnected === true &&
      providerCatalog.model &&
      providerCatalog.model.id === EXPECTED_MODEL_ID &&
      providerCatalog.model.providerID === EXPECTED_PROVIDER_ID
  );
  return {
    expected: EXPECTED_MODEL,
    cliMatch,
    serverMatch,
    exact: cliMatch && serverMatch ? EXPECTED_MODEL : null,
  };
}

export function determineContinuation({ observedFieldNames }) {
  const names = Array.isArray(observedFieldNames) ? observedFieldNames : [];
  const incarnationCandidates = names.filter((name) => INCARNATION_CANDIDATE_KEYS.has(String(name).toLowerCase()));
  const reason =
    incarnationCandidates.length > 0
      ? "a candidate-shaped field name was observed, but proving authoritative cross-call session binding requires creating a session, which is out of Task 1 scope"
      : "no instance/pid/boot/incarnation-shaped field was observed in health, agent, capabilities, session, or assistant-message schemas";
  return { mode: "fresh_only", incarnationCandidates, reason };
}

/** Finds the index of the declaration's opening `{`, skipping past `<...>` generics/extends clauses. */
function findDeclarationOpenBrace(text, fromIndex) {
  let angleDepth = 0;
  for (let index = fromIndex; index < text.length; index++) {
    const ch = text[index];
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "{" && angleDepth === 0) return index;
  }
  return -1;
}

/**
 * Extracts the raw body text between the outer braces of a top-level
 * `export type <name> = { ... }` or `export interface <name>[<T>][extends ...] { ... }`
 * declaration, correctly skipping past generic parameters and extends clauses.
 */
export function extractTypeBody(text, typeName) {
  const declaration = new RegExp(`export (?:type|interface) ${typeName}\\b`).exec(text);
  if (!declaration) return null;
  const braceIndex = findDeclarationOpenBrace(text, declaration.index + declaration[0].length);
  if (braceIndex === -1) return null;
  let index = braceIndex + 1;
  let depth = 1;
  const bodyStart = index;
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    index++;
  }
  if (depth !== 0) return null;
  return text.slice(bodyStart, index - 1);
}

/** Extracts the balanced `{ ... }` body following `<key>: {` inside an already-extracted type body. */
export function extractNestedBody(body, key) {
  const text = String(body ?? "");
  const marker = new RegExp(`${key}\\??:\\s*\\{`);
  const match = marker.exec(text);
  if (!match) return null;
  let index = match.index + match[0].length;
  let depth = 1;
  const bodyStart = index;
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    index++;
  }
  if (depth !== 0) return null;
  return text.slice(bodyStart, index - 1);
}

/** Returns only the immediate (depth-0) property names of an object type body. */
export function extractTopLevelKeys(body) {
  const keys = [];
  let depth = 0;
  const keyPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (depth === 0) {
      const match = keyPattern.exec(line);
      if (match) keys.push(match[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }
  return keys;
}

function extractClassMethodNames(text, className) {
  const marker = `export declare class ${className} extends HeyApiClient {`;
  const start = text.indexOf(marker);
  if (start === -1) return [];
  let index = start + marker.length;
  let depth = 1;
  const bodyStart = index;
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    index++;
  }
  const body = text.slice(bodyStart, index - 1);
  const names = new Set();
  for (const match of body.matchAll(/^\s{4}(?:get\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*[(<:]/gm)) {
    if (!match[1].startsWith("_")) names.add(match[1]);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Local, offline SDK type-shape inspection (reads the installed package's own
// declared .d.ts text; no network, no server call).
// ---------------------------------------------------------------------------

function resolveSdkPackageRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.resolve("@opencode-ai/sdk/v2/client")));
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === PINNED_SDK_PACKAGE) return { root: dir, pkg };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate ${PINNED_SDK_PACKAGE} package root`);
    dir = parent;
  }
}

export function inspectSdkTypeShapes() {
  const { root, pkg } = resolveSdkPackageRoot();
  const clientDts = fs.readFileSync(path.join(root, "dist", "v2", "client.d.ts"), "utf8");
  const sdkGenDts = fs.readFileSync(path.join(root, "dist", "v2", "gen", "sdk.gen.d.ts"), "utf8");
  const typesGenDts = fs.readFileSync(path.join(root, "dist", "v2", "gen", "types.gen.d.ts"), "utf8");
  const clientTypesDts = fs.readFileSync(path.join(root, "dist", "v2", "gen", "client", "types.gen.d.ts"), "utf8");
  const serverDtsExists = fs.existsSync(path.join(root, "dist", "v2", "server.d.ts"));

  const clientExports = [];
  if (/export\s+declare\s+function\s+createOpencodeClient\b/.test(clientDts)) clientExports.push("createOpencodeClient");
  if (/export\s*\{[^}]*\bOpencodeClient\b[^}]*\}/.test(clientDts)) clientExports.push("OpencodeClient");

  const assistantMessageBody = extractTypeBody(typesGenDts, "AssistantMessage");
  const assistantMessageFields = assistantMessageBody ? extractTopLevelKeys(assistantMessageBody) : [];
  const tokensBody = assistantMessageBody ? extractNestedBody(assistantMessageBody, "tokens") : null;
  const tokensFields = tokensBody ? extractTopLevelKeys(tokensBody) : [];

  const sessionBody = extractTypeBody(typesGenDts, "Session");
  const sessionFields = sessionBody ? extractTopLevelKeys(sessionBody) : [];

  const errorVariantNames = ["ProviderAuthError", "UnknownError", "MessageOutputLengthError", "MessageAbortedError", "StructuredOutputError", "ContextOverflowError", "ContentFilterError", "ApiError"].filter(
    (name) => new RegExp(`export type ${name} = \\{`).test(typesGenDts)
  );

  const clientConfigBody = extractTypeBody(clientTypesDts, "Config") ?? "";
  const clientConfigFields = extractTopLevelKeys(clientConfigBody);

  const declaredMethods = {
    "global.health": extractClassMethodNames(sdkGenDts, "Global").includes("health"),
    "app.agents": extractClassMethodNames(sdkGenDts, "App").includes("agents"),
    "provider.list": extractClassMethodNames(sdkGenDts, "Provider").includes("list"),
    "experimental.capabilities.get": extractClassMethodNames(sdkGenDts, "Capabilities").includes("get"),
  };
  const methodsUsed = Object.entries(declaredMethods)
    .filter(([, declared]) => declared)
    .map(([name]) => name);

  return {
    packageVersion: pkg.version,
    clientExports,
    forbiddenExports: serverDtsExists ? ["createOpencode"] : [],
    methodsUsed,
    assistantMessageFields,
    tokensFields,
    errorVariantNames,
    sessionFields,
    clientConfigFields,
  };
}

// ---------------------------------------------------------------------------
// CLI discovery (version/catalog text only; never lifecycle/session output).
// ---------------------------------------------------------------------------

export function runCliDiscovery({ opencodeBin, timeoutMs = DEFAULT_TIMEOUT_MS, execFileImpl = execFileSync } = {}) {
  const version = (() => {
    try {
      const stdout = execFileImpl(opencodeBin, ["--version"], { encoding: "utf8", timeout: timeoutMs });
      const value = parseCliVersion(stdout);
      return value ? { ok: true, value } : { ok: false, reason: "unparseable_version_output" };
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: error?.code ?? null };
    }
  })();
  const modelCatalog = (() => {
    try {
      const stdout = execFileImpl(opencodeBin, ["models"], { encoding: "utf8", timeout: timeoutMs });
      return { ok: true, models: parseModelCatalog(stdout) };
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: error?.code ?? null };
    }
  })();
  return { bin: opencodeBin, version, modelCatalog };
}

// ---------------------------------------------------------------------------
// Server discovery via the pinned v2 SDK client (side-effect-free GETs only).
// ---------------------------------------------------------------------------

export async function runServerDiscovery({ baseUrl = DEFAULT_SERVER_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isLoopbackUrl(baseUrl)) {
    return { baseUrl, loopback: false, reachable: false, reason: "non_loopback_or_invalid_url" };
  }
  const requestAudit = [];
  // The probe shares the runtime client's fixed-origin fetch seam, so even
  // this diagnostic path gets pre-network origin/GET/redirect enforcement,
  // the per-path frozen response ceilings, and the same audit record shape.
  const client = createOpencodeClient({
    baseUrl,
    fetch: createFixedOriginFetch({
      baseOrigin: new URL(baseUrl).origin,
      maxResponseBytes: null,
      auditRecords: requestAudit,
    }),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await client.global.health({ signal: controller.signal });
    if (health.error || !health.data) {
      return {
        baseUrl,
        loopback: true,
        reachable: false,
        reason: "health_unavailable",
        requestAudit: summarizeAudit(requestAudit),
      };
    }
    const [agentsResult, providerResult, capabilitiesResult] = await Promise.all([
      client.app.agents({ signal: controller.signal }),
      client.provider.list({ signal: controller.signal }),
      client.experimental.capabilities.get({ signal: controller.signal }),
    ]);
    const audit = summarizeAudit(requestAudit);
    if (audit.mutatingRequestCount > 0) {
      throw new Error("compatibility probe issued a mutating request; refusing to publish a compatibility result");
    }
    return {
      baseUrl,
      loopback: true,
      reachable: true,
      health: { healthy: health.data.healthy === true, version: health.data.version ?? null },
      agents: sanitizeAgentList(agentsResult.data),
      provider: sanitizeProviderCatalog(providerResult.data, EXPECTED_PROVIDER_ID, EXPECTED_MODEL_ID),
      capabilities: sanitizeCapabilities(capabilitiesResult.data),
      requestAudit: audit,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeAudit(records) {
  const methods = records.map((record) => record.method);
  return {
    totalRequests: records.length,
    mutatingRequestCount: methods.filter((method) => method !== "GET").length,
    methods,
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export async function runCompatibilityProbe({
  opencodeBin = DEFAULT_OPENCODE_BIN,
  serverUrl = DEFAULT_SERVER_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // Raw discovery is kept process-local: the full model catalog and the full
  // connected-provider/available-agent lists are used only to derive the
  // closed facts below and are never assigned into the returned report.
  const rawCli = runCliDiscovery({ opencodeBin, timeoutMs });
  const rawServer = await runServerDiscovery({ baseUrl: serverUrl, timeoutMs });
  const modelRoute = classifyModelRoute({
    cliModels: rawCli.modelCatalog.ok ? rawCli.modelCatalog.models : [],
    providerCatalog: rawServer.reachable ? rawServer.provider : null,
  });
  const availableAgents =
    rawServer.reachable && rawServer.agents.ok ? rawServer.agents.agents.map((agent) => agent.name) : [];
  const profile = {
    name: EXPECTED_EXPLORER_PROFILE,
    present: availableAgents.includes(EXPECTED_EXPLORER_PROFILE),
  };
  const sdkTypeShapes = inspectSdkTypeShapes();
  const continuation = determineContinuation({
    observedFieldNames: [
      ...sdkTypeShapes.sessionFields,
      ...sdkTypeShapes.assistantMessageFields,
      "healthy",
      "version",
      ...(rawServer.reachable ? Object.keys(rawServer.capabilities) : []),
    ],
  });
  const blockers = [];
  if (!modelRoute.exact) blockers.push("model_route_not_confirmed");
  if (!profile.present) blockers.push(`profile_missing:${EXPECTED_EXPLORER_PROFILE}`);
  if (!rawServer.reachable) blockers.push("server_unreachable");

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    zeroModel: true,
    zeroSession: true,
    pinnedDependency: {
      name: PINNED_SDK_PACKAGE,
      version: sdkTypeShapes.packageVersion,
      exactPin: sdkTypeShapes.packageVersion === PINNED_SDK_VERSION,
    },
    cli: projectCliDiscovery(rawCli, opencodeBin),
    server: projectServerDiscovery(rawServer),
    modelRoute,
    profile,
    continuation,
    sdkTypeShapes: {
      clientExports: sdkTypeShapes.clientExports,
      forbiddenExports: sdkTypeShapes.forbiddenExports,
      methodsUsed: sdkTypeShapes.methodsUsed,
      assistantMessageFields: sdkTypeShapes.assistantMessageFields,
      tokensFields: sdkTypeShapes.tokensFields,
      errorVariantNames: sdkTypeShapes.errorVariantNames,
      sessionFields: sdkTypeShapes.sessionFields,
      clientConfigFields: sdkTypeShapes.clientConfigFields,
    },
    readiness: { ready: blockers.length === 0, blockers },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const opencodeBin = optionValue("--opencode-bin") ?? DEFAULT_OPENCODE_BIN;
  const serverUrl = optionValue("--server-url") ?? DEFAULT_SERVER_URL;
  const timeoutMs = Number(optionValue("--timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  const report = await runCompatibilityProbe({ opencodeBin, serverUrl, timeoutMs });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.modelRoute.exact) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
