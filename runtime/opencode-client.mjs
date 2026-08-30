/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fixed-origin, auth-safe OpenCode client construction and side-effect-free
 * discovery (add-opencode-explorer-driver, Task 2).
 *
 * This module owns the one tracked loopback Server connection: it resolves
 * and validates exactly one configured literal-IP loopback origin, composes
 * optional Basic auth from the inherited operator process environment only,
 * and wraps the pinned `@opencode-ai/sdk` v2 client with bounded
 * connect/discovery/acceptance/turn deadlines, caller cancellation, a
 * fixed-origin/GET-only/reject-on-redirect fetch seam, a response byte
 * bound, and sanitized closed error codes. It never creates a session,
 * message, or prompt.
 *
 * The pinned SDK client is never returned to a caller: its low-level surface
 * (`client.client.get/post/request(...)`) accepts a per-call `baseUrl`/
 * `fetch` override that would otherwise let any holder of the returned value
 * redirect requests (and any configured Authorization header) to an
 * arbitrary origin, or issue a mutating request, bypassing this module's
 * fixed-origin/GET-only/deadline/size boundary entirely. Discovery functions
 * instead take an opaque handle; the real client lives only in a
 * module-private WeakMap keyed by that handle.
 */
import { createOpencodeClient as createOpencodeSdkClient } from "@opencode-ai/sdk/v2/client";

import { readOpencodeSecrets, resolveRuntimeEnvironment } from "./environment.mjs";
import { isBoundedRouteAtom } from "./harness-contract.mjs";

export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:4096";

// Turn deadlines are reserved here so the future session/turn Driver reuses
// one composed-deadline boundary instead of inventing a second one; Task 2
// only exercises connect/discovery. These are absolute ceilings: a handle or
// per-call request may only shorten them (see boundPositiveInteger), never
// extend or bypass them.
export const OPENCODE_DEADLINES_MS = Object.freeze({
  connect: 5_000,
  discovery: 10_000,
  acceptance: 15_000,
  turn: 3_600_000,
});

// Absolute ceiling on a single discovery response body, enforced at the fetch
// seam for both a declared Content-Length and a streamed/chunked body. It is
// the ceiling for every discovery path except the one documented exception
// below.
export const OPENCODE_MAX_RESPONSE_BYTES = 262_144; // 256 KiB

/** The one path whose response is the provider catalog (`provider.list`). */
export const OPENCODE_PROVIDER_CATALOG_PATH = "/provider";

/**
 * The provider-catalog endpoint's own hard ceiling.
 *
 * That endpoint legitimately carries the Server's hydrated models.dev registry:
 * an operator Server that reached the registry at start answers it with the
 * complete provider/model metadata catalog -- measured live at 188 providers,
 * ~308 KB on the wire and ~5.0 MB decoded, which the 256 KiB discovery bound
 * refused outright, leaving the exact model route permanently unconfirmable.
 * Every other discovery response keeps the 256 KiB bound; only this path gets
 * the larger one, and it is still a hard cap rather than an unbounded read.
 *
 * Both ceilings are frozen module constants. A caller may shorten either one
 * (see `boundPositiveInteger`), and can never widen or bypass one.
 */
export const OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES = 8_388_608; // 8 MiB

/**
 * The frozen response ceiling for one request path, resolved before the network
 * call. The catalog path is matched exactly: a neighbouring endpoint such as
 * `/api/provider`, `/provider/auth`, or `/provider/` keeps the global bound.
 *
 * @param {string} pathname
 * @returns {number}
 */
export function resolveOpencodeResponseCeiling(pathname) {
  return pathname === OPENCODE_PROVIDER_CATALOG_PATH
    ? OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES
    : OPENCODE_MAX_RESPONSE_BYTES;
}

const MAX_ARRAY_LENGTH = 256;
const MAX_FIELD_LENGTH = 512;

/**
 * Absolute ceiling on the number of provider entries in the catalog payload.
 * The hydrated models.dev registry is measured live at 188 providers, so the
 * shared 256-entry array bound left only ~27% headroom before ordinary
 * registry growth would fail the catalog read as `malformed_response` and
 * leave readiness permanently unconfirmable. The catalog byte ceiling remains
 * the real payload limit; this bound only keeps iteration finite.
 */
export const OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES = 2048;

export class OpencodeClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpencodeClientError";
    this.code = code;
  }
}

function nonEmptyString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/**
 * Only a literal IP loopback origin is admitted (127.0.0.1, or a correctly
 * parsed [::1]). "localhost" is deliberately rejected: it requires a
 * resolver step between validation and connection (a DNS/TOCTOU gap, e.g. a
 * misconfigured or poisoned /etc/hosts), while a literal IP address needs no
 * resolution and cannot be redirected elsewhere after validation.
 */
export function isLoopbackOpencodeUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== "" && url.pathname !== "/") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Resolves and validates the one tracked loopback Server origin from a merged runtime environment. */
export function resolveOpencodeServerUrl(env) {
  const configured = nonEmptyString(env?.OPENCODE_SERVER_URL) ?? DEFAULT_OPENCODE_SERVER_URL;
  if (!isLoopbackOpencodeUrl(configured)) {
    throw new OpencodeClientError(
      "invalid_server_url",
      "OPENCODE_SERVER_URL must be a literal-IP loopback http(s) origin with no credentials, query, fragment, or path"
    );
  }
  const normalized = new URL(configured);
  return `${normalized.protocol}//${normalized.host}`;
}

function buildAuthorizationHeader(secrets) {
  const { username, password } = secrets;
  if (!username && !password) return null;
  if (!username || !password) {
    throw new OpencodeClientError(
      "credentials_incomplete",
      "OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD must both be set together"
    );
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/**
 * A positive finite integer request may only shorten the Driver-owned
 * ceiling, never extend or bypass it: invalid (non-integer, non-finite,
 * non-positive), equal, or larger requests all fall back to the ceiling
 * itself.
 */
export function boundPositiveInteger(requested, ceiling) {
  if (typeof requested === "number" && Number.isInteger(requested) && requested > 0 && requested < ceiling) {
    return requested;
  }
  return ceiling;
}

function boundResponseSize(response, maxResponseBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      if (response.body) response.body.cancel().catch(() => {});
      throw new OpencodeClientError("response_too_large", "response exceeded the bounded size limit");
    }
  }
  if (!response.body) return response;
  let received = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxResponseBytes) {
        controller.error(new OpencodeClientError("response_too_large", "response exceeded the bounded size limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Builds the one fetch implementation ever wired into the pinned SDK client.
 * Every request that reaches the network must pass through here: it rejects
 * a differing origin and blocks any non-GET method before any network call
 * (not after), forces redirect rejection regardless of the incoming
 * Request's own redirect mode, records only a bounded method/path audit
 * entry for allowed requests, and bounds the response size at both the
 * declared-Content-Length and streamed-byte level using the frozen ceiling for
 * that request's own path (`maxResponseBytes` may only shorten it). Exported for a direct
 * controlled-wrapper test; this is an internal seam, not runtime/index
 * public API.
 */
function admitDiscoveryRequest(method, pathname) {
  void pathname; // discovery admits by method alone; the path table bounds size only
  if (method !== "GET") {
    throw new OpencodeClientError("mutating_request_blocked", "non-GET request blocked before network");
  }
}

export function createFixedOriginFetch({
  baseOrigin,
  maxResponseBytes,
  auditRecords,
  admitRequest = admitDiscoveryRequest,
  ceilingForPath = resolveOpencodeResponseCeiling,
}) {
  return async function fixedOriginFetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    let requestUrl;
    try {
      requestUrl = new URL(request.url);
    } catch {
      throw new OpencodeClientError("cross_origin_rejected", "request URL could not be parsed");
    }
    if (requestUrl.origin !== baseOrigin) {
      throw new OpencodeClientError("cross_origin_rejected", "cross-origin request rejected");
    }
    // The admission gate runs before any network call: discovery admits GET
    // only, a turn admits exactly two POST paths, and each gate owns its own
    // closed rejection code.
    admitRequest(request.method, requestUrl.pathname);
    // The size ceiling is chosen from the request's own path before the network
    // call, never from the response, a header, or a caller-supplied widening: a
    // request may only ever shorten the frozen ceiling for its path.
    const effectiveMaxResponseBytes = boundPositiveInteger(maxResponseBytes, ceilingForPath(requestUrl.pathname));
    const outboundRequest = new Request(request, { redirect: "error" });
    auditRecords.push({ method: outboundRequest.method, path: requestUrl.pathname });
    const response = await fetch(outboundRequest);
    return boundResponseSize(response, effectiveMaxResponseBytes);
  };
}

export function summarizeRequestAudit(requestAudit) {
  const methods = requestAudit.records.map((record) => record.method);
  return {
    totalRequests: requestAudit.records.length,
    mutatingRequestCount: methods.filter((method) => method !== "GET").length,
    methods,
  };
}

const HANDLE_ENTRIES = new WeakMap();

class OpencodeDiscoveryHandle {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    Object.freeze(this);
  }
}

/** @typedef {InstanceType<typeof OpencodeDiscoveryHandle>} OpencodeDiscoveryHandleType */

function requireHandleEntry(handle) {
  const entry = handle instanceof OpencodeDiscoveryHandle ? HANDLE_ENTRIES.get(handle) : undefined;
  if (!entry) {
    throw new OpencodeClientError("invalid_discovery_handle", "not a valid OpenCode discovery handle");
  }
  return entry;
}

/**
 * Constructs the one pinned, fixed-origin OpenCode SDK client and returns
 * only an opaque handle: no `.client`, no credential-presence flag, and no
 * live audit records are ever exposed on it. Performs no I/O beyond
 * validation.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, directory?: string, envFile?: string, connectTimeoutMs?: number,
 *   discoveryTimeoutMs?: number, maxResponseBytes?: number}} [options]
 */
export function createOpencodeDiscoveryClient(options = {}) {
  const rawEnv = options.env ?? process.env;
  const { env: mergedEnv } = resolveRuntimeEnvironment({ cwd: options.cwd, envFile: options.envFile, env: rawEnv });
  const serverUrl = resolveOpencodeServerUrl(mergedEnv);
  const secrets = readOpencodeSecrets(rawEnv);
  const authorizationHeader = buildAuthorizationHeader(secrets);
  const baseOrigin = new URL(serverUrl).origin;
  // The requested bound is passed through unbounded on purpose: the fetch seam
  // bounds it against the frozen ceiling for each request's own path, so
  // pre-bounding it here against the global ceiling would silently cap the
  // provider catalog back down to 256 KiB.
  const maxResponseBytes = options.maxResponseBytes ?? null;
  const connectCeilingMs = boundPositiveInteger(options.connectTimeoutMs, OPENCODE_DEADLINES_MS.connect);
  const discoveryCeilingMs = boundPositiveInteger(options.discoveryTimeoutMs, OPENCODE_DEADLINES_MS.discovery);
  const requestAudit = { records: [] };
  const sdkClient = createOpencodeSdkClient({
    baseUrl: serverUrl,
    directory: boundedDirectory(options.directory),
    fetch: createFixedOriginFetch({ baseOrigin, maxResponseBytes, auditRecords: requestAudit.records }),
    headers: authorizationHeader ? { authorization: authorizationHeader } : undefined,
    redirect: "error",
  });
  const handle = new OpencodeDiscoveryHandle(serverUrl);
  HANDLE_ENTRIES.set(handle, { sdkClient, requestAudit, connectCeilingMs, discoveryCeilingMs });
  return handle;
}

/** Returns the bounded, sanitized request audit summary for a discovery handle. */
export function getOpencodeDiscoveryAudit(handle) {
  return summarizeRequestAudit(requireHandleEntry(handle).requestAudit);
}

function composeDeadlineSignal(timeoutMs, callerSignal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (callerSignal) signals.push(callerSignal);
  return AbortSignal.any(signals);
}

function classifyDiscoveryFailure(error, response) {
  if (error instanceof OpencodeClientError) return { code: error.code, retryable: false };
  if (response) {
    const status = response.status;
    if (status === 401 || status === 403) return { code: "auth_failed", retryable: false };
    if (status >= 500) return { code: "server_error", retryable: true };
    return { code: "bad_request", retryable: false };
  }
  if (error) {
    if (error.name === "TimeoutError") return { code: "deadline_exceeded", retryable: true };
    if (error.name === "AbortError") return { code: "aborted_by_caller", retryable: false };
    if (error?.cause?.message === "unexpected redirect") return { code: "redirect_rejected", retryable: false };
    if (error instanceof SyntaxError) return { code: "malformed_response", retryable: false };
    return { code: "network_error", retryable: true };
  }
  return { code: "unknown_error", retryable: false };
}

function isBoundedString(value, maxLength = MAX_FIELD_LENGTH) {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNullableString(value, maxLength = MAX_FIELD_LENGTH) {
  return value === null || value === undefined || isBoundedString(value, maxLength);
}

/**
 * @param {OpencodeDiscoveryHandleType} handle
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export async function discoverOpencodeHealth(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.connectCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.global.health({ signal: deadlineSignal });
    if (result.error !== undefined || !result.data) {
      return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    }
    if (typeof result.data.healthy !== "boolean" || !isBoundedNullableString(result.data.version)) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    return { ok: true, healthy: result.data.healthy, version: result.data.version ?? null };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * Read the only configuration fact interaction admission needs.  The full
 * configuration may carry operator-owned paths and secrets, so it never
 * leaves this client boundary.
 */
export async function discoverOpencodeDefaultAgent(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.config.get({}, { signal: deadlineSignal });
    if (result.error !== undefined || !result.data || typeof result.data !== "object") {
      return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    }
    const defaultAgent = result.data.default_agent;
    if (defaultAgent !== undefined && defaultAgent !== null && !isBoundedString(defaultAgent)) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    return { ok: true, defaultAgent: defaultAgent ?? null };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * @param {OpencodeDiscoveryHandleType} handle
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export async function discoverOpencodeProfile(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.app.agents({}, { signal: deadlineSignal });
    if (result.error !== undefined) return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    if (!Array.isArray(result.data) || result.data.length > MAX_ARRAY_LENGTH) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    const agents = [];
    for (const agent of result.data) {
      if (!agent || typeof agent !== "object") continue;
      if (typeof agent.name !== "string") continue;
      if (!isBoundedString(agent.name) || !isBoundedNullableString(agent.mode)) {
        return { ok: false, code: "malformed_response", retryable: false };
      }
      agents.push({
        name: agent.name,
        mode: typeof agent.mode === "string" ? agent.mode : null,
        native: agent.native === true,
      });
    }
    return { ok: true, agents };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * @param {OpencodeDiscoveryHandleType} handle
 * @param {{providerId?: string, modelId?: string, signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export async function discoverOpencodeProviderCatalog(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const { providerId, modelId } = options;
  if (!providerId || !modelId) {
    throw new OpencodeClientError("provider_target_required", "providerId and modelId are required");
  }
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.provider.list({}, { signal: deadlineSignal });
    if (result.error !== undefined) return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    const payload = result.data;
    if (
      !payload ||
      !Array.isArray(payload.all) ||
      !Array.isArray(payload.connected) ||
      payload.all.length > OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES ||
      payload.connected.length > MAX_ARRAY_LENGTH
    ) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    if (!payload.connected.every((id) => isBoundedString(id))) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    const connected = payload.connected;
    const provider = payload.all.find((candidate) => candidate && candidate.id === providerId);
    const rawModel = provider && provider.models && typeof provider.models === "object" ? provider.models[modelId] : undefined;
    if (
      rawModel !== undefined &&
      (!isBoundedNullableString(rawModel.id) ||
        !isBoundedNullableString(rawModel.providerID) ||
        !isBoundedNullableString(rawModel.name) ||
        !isBoundedNullableString(rawModel.family))
    ) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    const model = rawModel
      ? {
          id: typeof rawModel.id === "string" ? rawModel.id : null,
          providerID: typeof rawModel.providerID === "string" ? rawModel.providerID : null,
          name: typeof rawModel.name === "string" ? rawModel.name : null,
          family: typeof rawModel.family === "string" ? rawModel.family : null,
        }
      : null;
    return {
      ok: true,
      providerPresent: Boolean(provider),
      providerConnected: connected.includes(providerId),
      model,
    };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * Project the connected Server's catalog into the only native route facts the
 * Driver needs. It reads `/provider` once and deliberately carries neither
 * agent/configuration fields nor a chosen default. A model without advertised
 * variants is not a route in this generation.
 */
export async function discoverOpencodeProviderRoutes(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  try {
    const result = await entry.sdkClient.provider.list({}, {
      signal: composeDeadlineSignal(timeoutMs, options.signal),
    });
    if (result.error !== undefined) return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    const payload = result.data;
    if (!payload || !Array.isArray(payload.all) || !Array.isArray(payload.connected) ||
        payload.all.length > OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES ||
        payload.connected.length > OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    const connected = new Set(payload.connected.filter(isBoundedRouteAtom));
    const routes = [];
    for (const provider of payload.all) {
      if (!provider || !isBoundedRouteAtom(provider.id) || !connected.has(provider.id) ||
          !provider.models || typeof provider.models !== "object" || Array.isArray(provider.models)) continue;
      for (const [key, raw] of Object.entries(provider.models)) {
        const modelId = typeof raw?.id === "string" ? raw.id : key;
        if (!isBoundedRouteAtom(modelId) || raw?.providerID !== provider.id ||
            !raw?.variants || typeof raw.variants !== "object" || Array.isArray(raw.variants)) continue;
        const efforts = Object.keys(raw.variants).filter(isBoundedRouteAtom);
        if (efforts.length === 0 || efforts.length > 16 || new Set(efforts).size !== efforts.length) continue;
        const candidate = { model: `${provider.id}/${modelId}`, efforts: efforts.sort() };
        // ponytail: bounded O(n^2) serialization is simpler; revisit only if the 32-route ceiling grows.
        if (Buffer.byteLength(JSON.stringify([...routes, candidate]), "utf8") <= 4 * 1024) routes.push(candidate);
      }
    }
    if (routes.length === 0 || routes.length > 32 || new Set(routes.map((route) => route.model)).size !== routes.length) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    return { ok: true, routes: routes.sort((left, right) => left.model.localeCompare(right.model)) };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * @param {OpencodeDiscoveryHandleType} handle
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 */
export async function discoverOpencodeCapabilities(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.experimental.capabilities.get({}, { signal: deadlineSignal });
    if (result.error !== undefined) return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    const payload = result.data;
    if (!payload || typeof payload !== "object") return { ok: false, code: "malformed_response", retryable: false };
    return { ok: true, backgroundSubagents: payload.backgroundSubagents === true };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * Absolute ceiling on the number of permission rules one resolved Agent policy
 * may carry. The Server merges configuration-level rules ahead of an Agent's
 * own, so a real ruleset is hundreds of rules long; this bound keeps a drifting
 * or hostile Server from handing the validator an unbounded array.
 */
export const OPENCODE_MAX_PERMISSION_RULES = 4096;

/**
 * Every field the pinned SDK's `Agent` type declares. A resolved Agent that
 * carries anything else is not the contract this checkout pinned, so the count
 * of unknown fields is reported rather than silently dropped: a future policy
 * field (a second tool map, for example) must fail readiness, not be ignored.
 */
const OPENCODE_AGENT_FIELDS = Object.freeze([
  "color",
  "description",
  "hidden",
  "mode",
  "model",
  "name",
  "native",
  "options",
  "permission",
  "prompt",
  "steps",
  "temperature",
  "topP",
  "variant",
]);

const OPENCODE_PERMISSION_ACTIONS = Object.freeze(["allow", "deny", "ask"]);

/**
 * Projects one resolved Agent into the bounded typed policy the Explorer
 * profile validator consumes, or `null` when the payload is not the pinned
 * shape. Provider option *values* never cross this boundary (only their count),
 * and the permission ruleset is passed through verbatim because its patterns
 * are the policy: they may hold operator-absolute paths, so only the
 * validator's own closed report is ever serialized.
 */
function projectOpencodeAgentPolicy(agent) {
  if (!Array.isArray(agent.permission) || agent.permission.length > OPENCODE_MAX_PERMISSION_RULES) return null;
  const ruleset = [];
  for (const rule of agent.permission) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
    if (!isBoundedString(rule.permission) || !isBoundedString(rule.pattern)) return null;
    if (!OPENCODE_PERMISSION_ACTIONS.includes(rule.action)) return null;
    ruleset.push({ permission: rule.permission, pattern: rule.pattern, action: rule.action });
  }
  if (agent.mode !== undefined && !isBoundedString(agent.mode)) return null;
  if (agent.variant !== undefined && !isBoundedNullableString(agent.variant)) return null;
  let model = null;
  if (agent.model !== undefined && agent.model !== null) {
    if (typeof agent.model !== "object" || Array.isArray(agent.model)) return null;
    if (!isBoundedString(agent.model.providerID) || !isBoundedString(agent.model.modelID)) return null;
    model = { providerID: agent.model.providerID, modelID: agent.model.modelID };
  }
  if (agent.options !== undefined) {
    if (!agent.options || typeof agent.options !== "object" || Array.isArray(agent.options)) return null;
  }
  return {
    name: agent.name,
    mode: agent.mode === undefined ? null : agent.mode,
    native: agent.native === true,
    hidden: agent.hidden === true,
    model,
    variant: typeof agent.variant === "string" ? agent.variant : null,
    optionKeyCount: agent.options === undefined ? 0 : Object.keys(agent.options).length,
    unknownFieldCount: Object.keys(agent).filter((field) => !OPENCODE_AGENT_FIELDS.includes(field)).length,
    ruleset,
  };
}

/**
 * Reads the resolved policy of exactly one named Agent profile. This is a
 * side-effect-free GET like every other discovery call: it creates no session,
 * message, or prompt, and it never returns the other Agents' names, so a
 * readiness report cannot disclose the operator's full Agent list.
 *
 * @param {OpencodeDiscoveryHandleType} handle
 * @param {{name?: string, signal?: AbortSignal, timeoutMs?: number}} [options] a bounded
 *   profile `name` is required; an absent or oversized one is refused.
 */
export async function discoverOpencodeAgentPolicy(handle, options = {}) {
  const entry = requireHandleEntry(handle);
  const name = nonEmptyString(options.name);
  if (!name || name.length > MAX_FIELD_LENGTH) {
    throw new OpencodeClientError("profile_target_required", "a bounded profile name is required");
  }
  const timeoutMs = boundPositiveInteger(options.timeoutMs, entry.discoveryCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options.signal);
  try {
    const result = await entry.sdkClient.app.agents({}, { signal: deadlineSignal });
    if (result.error !== undefined) return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    if (!Array.isArray(result.data) || result.data.length > MAX_ARRAY_LENGTH) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    const matches = result.data.filter(
      (agent) => agent && typeof agent === "object" && !Array.isArray(agent) && agent.name === name
    );
    if (matches.length === 0) return { ok: true, present: false, agent: null };
    // Two Agents answering to one name is ambiguous policy, not a profile.
    if (matches.length > 1) return { ok: false, code: "malformed_response", retryable: false };
    const agent = projectOpencodeAgentPolicy(matches[0]);
    if (!agent) return { ok: false, code: "malformed_response", retryable: false };
    return { ok: true, present: true, agent };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * Orchestrates the fixed-origin client plus health/profile/provider/capabilities
 * discovery in one bounded, side-effect-free call. Never creates a session,
 * message, or prompt; throws if any dispatched request was not a GET. Never
 * discloses credential presence.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, envFile?: string, signal?: AbortSignal,
 *   connectTimeoutMs?: number, discoveryTimeoutMs?: number, maxResponseBytes?: number,
 *   providerId?: string, modelId?: string}} [options]
 */
export async function runOpencodeSideEffectFreeDiscovery(options = {}) {
  const handle = createOpencodeDiscoveryClient(options);
  const health = await discoverOpencodeHealth(handle, { signal: options.signal });
  if (!health.ok || !health.healthy) {
    return {
      ok: false,
      serverUrl: handle.serverUrl,
      health,
      profile: null,
      provider: null,
      capabilities: null,
      requestAudit: getOpencodeDiscoveryAudit(handle),
    };
  }
  const [profile, provider, capabilities] = await Promise.all([
    discoverOpencodeProfile(handle, { signal: options.signal }),
    options.providerId && options.modelId
      ? discoverOpencodeProviderCatalog(handle, {
          providerId: options.providerId,
          modelId: options.modelId,
          signal: options.signal,
        })
      : Promise.resolve(null),
    discoverOpencodeCapabilities(handle, { signal: options.signal }),
  ]);
  const audit = getOpencodeDiscoveryAudit(handle);
  if (audit.mutatingRequestCount > 0) {
    throw new OpencodeClientError(
      "mutating_request_detected",
      "discovery issued a mutating request; refusing to publish a discovery result"
    );
  }
  return { ok: true, serverUrl: handle.serverUrl, health, profile, provider, capabilities, requestAudit: audit };
}

// ---------------------------------------------------------------------------
// The turn-scoped client seam.
//
// Discovery is GET-only, which is what keeps a readiness probe incapable of
// creating anything. A turn needs exactly two mutating requests, so it gets its
// own client with its own admission gate rather than widening the discovery
// one: the pinned SDK's `session.create` and `session.prompt` methods, and
// nothing else the SDK could ever be asked to do (`prompt_async`, `abort`,
// `fork`, `share`, `summarize`, `command`, `shell`, `revert`, `delete`,
// `update`, or any GET) is blocked before the network.
// ---------------------------------------------------------------------------

/** `session.create` in the pinned SDK: POST /session. */
export const OPENCODE_SESSION_CREATE_PATH = "/session";

/**
 * `session.prompt` in the pinned SDK: POST /session/{sessionID}/message. The
 * session segment is matched against a bounded identifier so a crafted id can
 * never widen the admitted path set (`/session/x/../abort` and
 * `/session/x/message/y` both fail this).
 */
export const OPENCODE_SESSION_PROMPT_PATH_PATTERN = /^\/session\/[A-Za-z0-9_-]{1,128}\/message$/;

/** The bounded session-identifier shape both the path and the refs admit. */
export const OPENCODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The pinned schema requires a message id in the `msg_` namespace. */
export const OPENCODE_MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{1,120}$/;

/**
 * A created session record is a small object (identity, project, title,
 * timestamps), so it keeps a bound close to the discovery one.
 */
export const OPENCODE_MAX_SESSION_RESPONSE_BYTES = 65_536;

/**
 * The prompt response ceiling, derived rather than guessed:
 *
 *   - the admitted final text is at most `OPENCODE_MAX_RAW_FINAL_TEXT_CHARS`
 *     (262,144) characters before normalization;
 *   - a character is at most 4 bytes in UTF-8, so that text is at most 1 MiB
 *     on the wire, and at most ~1.5 MiB once JSON-escaped in the worst case;
 *   - the remaining ~2.5 MiB bounds everything else one assistant message
 *     carries: its own fields, the step/tool/reasoning parts of a multi-step
 *     turn, and the earlier text parts the result selector counts.
 *
 * 4 MiB is therefore a real ceiling with headroom, not an unbounded read: a
 * response beyond it is refused at the declared length or mid-stream, exactly
 * like every other response this client reads.
 */
export const OPENCODE_MAX_TURN_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Whether one method/path pair is one of the two admitted turn requests. */
export function isAdmittedOpencodeTurnRequest(method, pathname) {
  if (method !== "POST") return false;
  if (pathname === OPENCODE_SESSION_CREATE_PATH) return true;
  return OPENCODE_SESSION_PROMPT_PATH_PATTERN.test(pathname);
}

/**
 * The frozen response ceiling for one admitted turn path.
 *
 * @param {string} pathname
 * @returns {number}
 */
export function resolveOpencodeTurnResponseCeiling(pathname) {
  return pathname === OPENCODE_SESSION_CREATE_PATH
    ? OPENCODE_MAX_SESSION_RESPONSE_BYTES
    : OPENCODE_MAX_TURN_RESPONSE_BYTES;
}

function admitTurnRequest(method, pathname) {
  if (!isAdmittedOpencodeTurnRequest(method, pathname)) {
    throw new OpencodeClientError(
      "request_not_admitted",
      "only the pinned session-create and session-prompt requests are admitted; blocked before network"
    );
  }
}

const TURN_HANDLE_ENTRIES = new WeakMap();

class OpencodeTurnHandle {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    Object.freeze(this);
  }
}

/** @typedef {InstanceType<typeof OpencodeTurnHandle>} OpencodeTurnHandleType */

function requireTurnEntry(handle) {
  const entry = handle instanceof OpencodeTurnHandle ? TURN_HANDLE_ENTRIES.get(handle) : undefined;
  if (!entry) {
    throw new OpencodeClientError("invalid_turn_handle", "not a valid OpenCode turn handle");
  }
  return entry;
}

/**
 * Construct the one pinned, fixed-origin client a single Agent's turns use, and
 * return only an opaque handle. Performs no I/O: like the discovery client it
 * validates configuration, composes inherited-only auth, and wires exactly one
 * audited fetch implementation.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, envFile?: string,
 *   acceptanceTimeoutMs?: number, turnTimeoutMs?: number}} [options]
 */
export function createOpencodeTurnClient(options = {}) {
  const rawEnv = options.env ?? process.env;
  const { env: mergedEnv } = resolveRuntimeEnvironment({ cwd: options.cwd, envFile: options.envFile, env: rawEnv });
  const serverUrl = resolveOpencodeServerUrl(mergedEnv);
  const authorizationHeader = buildAuthorizationHeader(readOpencodeSecrets(rawEnv));
  const baseOrigin = new URL(serverUrl).origin;
  const requestAudit = { records: [] };
  const sdkClient = createOpencodeSdkClient({
    baseUrl: serverUrl,
    fetch: createFixedOriginFetch({
      baseOrigin,
      // No caller-shortened bound: a turn reads exactly the frozen per-path
      // ceilings for session creation and the prompt result.
      maxResponseBytes: null,
      auditRecords: requestAudit.records,
      admitRequest: admitTurnRequest,
      ceilingForPath: resolveOpencodeTurnResponseCeiling,
    }),
    headers: authorizationHeader ? { authorization: authorizationHeader } : undefined,
    redirect: "error",
  });
  const handle = new OpencodeTurnHandle(serverUrl);
  TURN_HANDLE_ENTRIES.set(handle, {
    sdkClient,
    requestAudit,
    acceptanceCeilingMs: boundPositiveInteger(options.acceptanceTimeoutMs, OPENCODE_DEADLINES_MS.acceptance),
    turnCeilingMs: boundPositiveInteger(options.turnTimeoutMs, OPENCODE_DEADLINES_MS.turn),
  });
  return handle;
}

/** The bounded, sanitized request audit summary for a turn handle. */
export function getOpencodeTurnAudit(handle) {
  return summarizeRequestAudit(requireTurnEntry(handle).requestAudit);
}

function boundedDirectory(directory) {
  if (directory == null) return undefined;
  if (typeof directory !== "string" || !directory.startsWith("/") || directory.length > 4096) {
    throw new OpencodeClientError("invalid_workspace_directory", "the workspace directory must be an absolute path");
  }
  return directory;
}

/**
 * Create one fresh native session for one Agent.
 *
 * The body states the exact admitted model and fixed maximum-permission,
 * zero-wait rules. It never accepts caller-provided permission rules, a title
 * derived from the caller's task (prompt text does not belong in session
 * metadata), or a parent session.
 *
 * @param {OpencodeTurnHandleType} handle
 * @param {{agent?: string, providerId: string, modelId: string, variant?: string, directory?: string,
 *   signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function createOpencodeSession(handle, options) {
  const entry = requireTurnEntry(handle);
  const agent = options?.agent == null ? null : nonEmptyString(options.agent);
  const providerId = nonEmptyString(options?.providerId);
  const modelId = nonEmptyString(options?.modelId);
  const variant = options?.variant == null ? null : nonEmptyString(options.variant);
  if (!providerId || !modelId || (options?.agent != null && !agent) || (options?.variant != null && !variant)) {
    throw new OpencodeClientError("session_target_required", "a provider and model are required");
  }
  const directory = boundedDirectory(options?.directory);
  const timeoutMs = boundPositiveInteger(options?.timeoutMs, entry.acceptanceCeilingMs);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options?.signal);
  admitTurnRequest("POST", OPENCODE_SESSION_CREATE_PATH);
  try {
    const result = await entry.sdkClient.session.create(
      {
        ...(agent == null ? {} : { agent }),
        model: { id: modelId, providerID: providerId, ...(variant == null ? {} : { variant }) },
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "question", pattern: "*", action: "deny" },
          { permission: "plan_exit", pattern: "*", action: "deny" },
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "doom_loop", pattern: "*", action: "allow" },
        ],
        ...(directory === undefined ? {} : { directory }),
      },
      { signal: deadlineSignal }
    );
    if (result.error !== undefined || !result.data) {
      return { ok: false, ...classifyDiscoveryFailure(result.error, result.response) };
    }
    const session = result.data;
    if (!isBoundedString(session.id, 128) || !OPENCODE_SESSION_ID_PATTERN.test(session.id)) {
      return { ok: false, code: "malformed_response", retryable: false };
    }
    if (session.parentID !== undefined && session.parentID !== null) {
      // A child session is a different lineage than the one this Driver asked
      // for; it is refused rather than adopted.
      return { ok: false, code: "malformed_response", retryable: false };
    }
    return { ok: true, sessionId: session.id };
  } catch (error) {
    return { ok: false, ...classifyDiscoveryFailure(error, undefined) };
  }
}

/**
 * Start the one blocking prompt request that owns a turn.
 *
 * Everything that can be refused without a network call -- the admitted path,
 * the bounded identifiers, the workspace -- is checked synchronously, so a
 * caller that catches a synchronous throw has proof no request was dispatched.
 * The returned promise is the request itself: the caller keeps it as its live
 * turn and must not await it before proving lineage.
 *
 * The body states the exact model, the reviewed profile, the caller-generated
 * user-message id, the exact top-level native variant, and one text part. It
 * never carries `tools`, `system`, `format`, or `noReply`: a per-call tool map or system override is
 * exactly the dynamic selector this route refuses, and the prompt text is the
 * only content the Driver sends.
 *
 * @param {OpencodeTurnHandleType} handle
 * @param {{sessionId: string, messageId: string, agent?: string, providerId: string,
 *   modelId: string, variant?: string, text: string, directory?: string, signal?: AbortSignal,
 *   timeoutMs?: number}} options
 */
export function submitOpencodePrompt(handle, options) {
  const entry = requireTurnEntry(handle);
  const sessionId = nonEmptyString(options?.sessionId);
  const messageId = nonEmptyString(options?.messageId);
  const agent = options?.agent == null ? null : nonEmptyString(options.agent);
  const providerId = nonEmptyString(options?.providerId);
  const modelId = nonEmptyString(options?.modelId);
  const variant = options?.variant == null ? null : nonEmptyString(options.variant);
  const text = typeof options?.text === "string" ? options.text : "";
  if (!sessionId || !OPENCODE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new OpencodeClientError("invalid_session_id", "a bounded session identifier is required");
  }
  if (!messageId || !OPENCODE_MESSAGE_ID_PATTERN.test(messageId)) {
    throw new OpencodeClientError("invalid_message_id", "a bounded msg_ identifier is required");
  }
  if (!providerId || !modelId || !text || (options?.agent != null && !agent) || (options?.variant != null && !variant)) {
    throw new OpencodeClientError("prompt_target_required", "a provider, model, and prompt text are required");
  }
  const directory = boundedDirectory(options?.directory);
  const timeoutMs = boundPositiveInteger(options?.timeoutMs, entry.turnCeilingMs);
  // Proven before dispatch: the exact path this request will use is one of the
  // two admitted ones.
  admitTurnRequest("POST", `/session/${sessionId}/message`);
  const deadlineSignal = composeDeadlineSignal(timeoutMs, options?.signal);
  const dispatched = entry.sdkClient.session
    .prompt(
      {
        sessionID: sessionId,
        messageID: messageId,
        ...(agent == null ? {} : { agent }),
        model: { providerID: providerId, modelID: modelId },
        ...(variant == null ? {} : { variant }),
        parts: [{ type: "text", text }],
        ...(directory === undefined ? {} : { directory }),
      },
      { signal: deadlineSignal }
    )
    .then((result) => {
      if (result.error !== undefined || !result.data) {
        const classified = classifyDiscoveryFailure(result.error, result.response);
        const status = result.response?.status ?? null;
        // 400 and 404 are the only refusals the pinned schema declares for this
        // request. They prove the Server rejected the prompt itself, so no
        // provider work happened and the outcome is not ambiguous. Every other
        // outcome leaves acceptance unknown.
        if (status === 400 || status === 404) {
          return { ok: false, code: "prompt_refused", retryable: false, status };
        }
        return { ok: false, ...classified, status };
      }
      return { ok: true, response: result.data };
    })
    .catch((error) => ({ ok: false, ...classifyDiscoveryFailure(error, undefined), status: null }));
  return dispatched;
}
