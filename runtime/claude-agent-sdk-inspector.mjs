/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zero-prompt Claude route discovery through the documented Agent SDK.
 */

export const CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS = 10_000;
const MAX_MODELS = 64;
const MAX_EFFORTS = 8;
const MAX_TEXT_BYTES = 256;

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
    const resolvedModel = exactText(row.resolvedModel);
    if (!value || !resolvedModel || value === "default" || resolvedModel === "default") {
      throw unavailable("default_or_unresolved_model");
    }
    if (routes.has(resolvedModel)) throw unavailable("duplicate_resolved_model");
    if (row.supportsEffort !== true || !Array.isArray(row.supportedEffortLevels) ||
      row.supportedEffortLevels.length === 0 || row.supportedEffortLevels.length > MAX_EFFORTS) {
      throw unavailable("missing_efforts");
    }
    const efforts = row.supportedEffortLevels.map((effort) => exactText(effort, 16));
    if (efforts.some((effort) => effort == null) || new Set(efforts).size !== efforts.length) {
      throw unavailable("invalid_efforts");
    }
    routes.set(resolvedModel, Object.freeze([...efforts]));
  }
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

async function* noUserMessages() {}

/**
 * Starts the documented SDK transport with an empty AsyncIterable, reads only
 * initialization model metadata, and force-closes the process before return.
 */
/** @param {{cwd?: string, executable?: string, timeoutMs?: number, importAgentSdk?: () => Promise<any>}} options */
export async function inspectClaudeAgentSdkRoutes({
  cwd,
  executable,
  timeoutMs = CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS,
  importAgentSdk = () => import("@anthropic-ai/claude-agent-sdk"),
} = {}) {
  const pathToClaudeCodeExecutable = exactText(executable);
  if (!pathToClaudeCodeExecutable) throw unavailable("executable_missing");
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS)
    : CLAUDE_AGENT_SDK_INSPECTION_TIMEOUT_MS;
  let query;
  try {
    const sdk = await within(Promise.resolve(importAgentSdk()), deadline);
    if (typeof sdk?.query !== "function") throw unavailable("sdk_contract_missing");
    query = sdk.query({
      prompt: noUserMessages(),
      // Omit settingSources so the SDK follows normal direct-CLI settings.
      options: { cwd, pathToClaudeCodeExecutable },
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
    try { query?.close(); } catch {}
  }
}
