/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zero-prompt Claude route discovery through the documented Agent SDK.
 */

export const CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS = 10_000;
const MAX_MODELS = 64;
const MAX_EFFORTS = 8;
const MAX_TEXT_BYTES = 256;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DONE = Object.freeze({ value: undefined, done: true });

function exactText(value, maxBytes = MAX_TEXT_BYTES) {
  return typeof value === "string" && value && !value.includes("\0") &&
    value.trim() === value && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function unavailable(code) {
  return Object.assign(new Error(`Claude Agent SDK inspection is unavailable: ${code}.`), { code });
}

function projectModels(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_MODELS) {
    throw unavailable("catalog_malformed");
  }
  const routes = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw unavailable("row_malformed");
    const value = exactText(row.value);
    if (!value) throw unavailable("row_malformed");
    if (value === "default") continue;
    if (row.supportsEffort !== true) continue;
    const resolvedModel = row.resolvedModel == null ? value : exactText(row.resolvedModel);
    if (!resolvedModel || resolvedModel === "default") throw unavailable("unresolved_model");
    if (!Array.isArray(row.supportedEffortLevels) ||
      row.supportedEffortLevels.length === 0 || row.supportedEffortLevels.length > MAX_EFFORTS) {
      throw unavailable("missing_efforts");
    }
    const efforts = row.supportedEffortLevels.map((effort) => exactText(effort, 16));
    if (efforts.some((effort) => effort == null || !VALID_EFFORTS.has(effort)) ||
      new Set(efforts).size !== efforts.length) {
      throw unavailable("invalid_efforts");
    }
    const existing = routes.get(resolvedModel);
    if (existing) {
      if (existing.length !== efforts.length || existing.some((effort) => !efforts.includes(effort))) {
        throw unavailable("conflicting_efforts");
      }
      continue;
    }
    routes.set(resolvedModel, Object.freeze([...efforts]));
  }
  if (routes.size === 0) throw unavailable("no_effort_routes");
  return Object.freeze({
    models: Object.freeze([...routes.keys()]),
    effortsByModel: Object.freeze(Object.fromEntries(routes)),
  });
}

function within(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(unavailable("initialization_timeout")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function emptyOpenInput() {
  let closed = false;
  const pending = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const resolve of pending) resolve(DONE);
    pending.clear();
  };
  return {
    prompt: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (closed) return Promise.resolve(DONE);
        return new Promise((resolve) => pending.add(resolve));
      },
      return() {
        close();
        return Promise.resolve(DONE);
      },
    },
    close,
  };
}

/**
 * Starts the documented SDK transport with an empty AsyncIterable, reads only
 * initialization model metadata, and force-closes the process before return.
 */
/** @param {{cwd?: string, executable?: string, environment?: Record<string, string | undefined>, timeoutMs?: number, importAgentSdk?: () => Promise<any>}} options */
export async function inspectClaudeAgentSdkRoutes({
  cwd,
  executable,
  environment,
  timeoutMs = CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS,
  importAgentSdk = () => import("@anthropic-ai/claude-agent-sdk"),
} = {}) {
  const pathToClaudeCodeExecutable = exactText(executable);
  if (!pathToClaudeCodeExecutable) throw unavailable("executable_missing");
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS)
    : CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS;
  let query;
  let input;
  try {
    const sdk = await within(Promise.resolve(importAgentSdk()), deadline);
    if (typeof sdk?.query !== "function") throw unavailable("sdk_contract_missing");
    input = emptyOpenInput();
    query = sdk.query({
      prompt: input.prompt,
      // Omit settingSources so the SDK follows normal direct-CLI settings.
      options: { cwd, env: environment, pathToClaudeCodeExecutable },
    });
    if (!query || typeof query.initializationResult !== "function" || typeof query.close !== "function") {
      throw unavailable("sdk_contract_missing");
    }
    const initialized = await within(query.initializationResult(), deadline);
    const models = Array.isArray(initialized?.models)
      ? initialized.models
      : await within(query.supportedModels?.(), deadline);
    return projectModels(models);
  } catch (error) {
    if (error?.code) throw error;
    throw unavailable("initialization_failed");
  } finally {
    input?.close();
    try { query?.close(); } catch {}
  }
}
