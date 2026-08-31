/** SPDX-License-Identifier: Apache-2.0 */
import { parentPort, workerData } from "node:worker_threads";

import { withRuntimeLoadGate } from "./promotion-gate.mjs";

if (!parentPort) throw new Error("HarnessDock MCP call worker requires a parent port.");

const abortController = new AbortController();
parentPort.on("message", (message) => {
  if (message?.type === "abort") abortController.abort();
});

const PUBLIC_SPAWN_RECOVERY_CODES = Object.freeze({
  lifecycle_owned: "spawn_lifecycle_owned",
  ownership_uncertain: "spawn_ownership_uncertain",
});
const PUBLIC_SPAWN_RECOVERY_MESSAGES = Object.freeze({
  lifecycle_owned: "Agent launch ownership was transferred; join the named Agent to reconcile its turn.",
  ownership_uncertain: "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
});
const PUBLIC_ERROR_CODES = new Set(["HARNESSDOCK_MCP_RESTART_REQUIRED"]);
const PUBLIC_RECOVERY_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const PRIVATE_ID_PATTERNS = [
  /\b(?:internal\s+)?Agent\s+(?:ID|id)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:agent|instance|job|session|attempt)(?:Id|ID|Key)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\bagent-[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:instance|attempt|message)-[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:internal\s+)?instance(?:\s+(?:ID|id))?\s*[:=]?\s+(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?Claude\s+session(?:\s+ID)?\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?session\s+(?:ID|id)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:internal\s+)?(?:Claude\s+)?job(?:\s+(?:ID|id)?|\s*[:=])\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

function safeErrorMessage(value) {
  let message = String(value ?? "").replaceAll("\0", "").trim();
  for (const pattern of PRIVATE_ID_PATTERNS) {
    message = message.replace(pattern, (match) => /job/i.test(match) ? "internal job" : "native session");
  }
  message = message.replace(
    /(^|[\s"'`=,:([{])\/[^\s"'`<>\])};,]+/g,
    (match, prefix, offset, source) => {
      const candidate = match.slice(prefix.length);
      const pathStart = offset + prefix.length;
      const context = source.slice(Math.max(0, pathStart - 32), pathStart);
      const publicAgentPath = /^\/root\/[a-z0-9_]+$/u.test(candidate) &&
        /\bAgent(?:\s+(?:name|path))?\s*$|\bbelongs\s+to\s*$/i.test(context);
      return publicAgentPath ? match : `${prefix}<runtime path>`;
    },
  );
  return message.slice(0, 8_000) || "HarnessDock MCP tool call failed.";
}

function normalizePublicSpawnRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agentName = String(value.agent_name ?? "").trim();
  const outcome = String(value.outcome ?? "").trim();
  const code = String(value.code ?? "").trim();
  if (!/^\/root\/[a-z0-9_]+$/u.test(agentName)) return null;
  if (!Object.hasOwn(PUBLIC_SPAWN_RECOVERY_CODES, outcome)) return null;
  if (!PUBLIC_RECOVERY_CODE_PATTERN.test(code) || code !== PUBLIC_SPAWN_RECOVERY_CODES[outcome]) return null;
  return {
    agent_name: agentName,
    outcome,
    code,
    message: PUBLIC_SPAWN_RECOVERY_MESSAGES[outcome],
  };
}

function errorPayload(error) {
  const recovery = normalizePublicSpawnRecovery(error?.publicRecovery);
  const code = typeof /** @type {any} */ (error)?.code === "string" &&
    PUBLIC_ERROR_CODES.has(/** @type {any} */ (error).code)
    ? /** @type {any} */ (error).code
    : undefined;
  return {
    name: error instanceof Error && error.name === "AbortError" ? "AbortError" : "Error",
    message: recovery?.message || safeErrorMessage(error instanceof Error ? error.message : String(error)),
    code,
    ...(recovery ? { recovery } : {}),
  };
}

try {
  const runtimeModule = await withRuntimeLoadGate({
    gateDirectory: workerData.promotionGateDirectory,
    markerPath: workerData.loaderMarkerPath,
    load: () => import(workerData.runtimeModuleUrl),
  });
  if (runtimeModule.HARNESSDOCK_MCP_API_GENERATION !== workerData.expectedGeneration) {
    const error = new Error(
      `HARNESSDOCK_MCP_RESTART_REQUIRED: HarnessDock MCP API generation changed from ${workerData.expectedGeneration} to ` +
      `${runtimeModule.HARNESSDOCK_MCP_API_GENERATION ?? "unknown"}. Run npm run release:local in ` +
      "/data/CoordExp/codex-harnessdock and start a new Codex task."
    );
    /** @type {any} */ (error).code = "HARNESSDOCK_MCP_RESTART_REQUIRED";
    throw error;
  }
  const runtimeFactory = runtimeModule.createAgentRuntime;
  if (typeof runtimeFactory !== "function") {
    throw new Error("Checkout runtime/index.mjs does not export createAgentRuntime().");
  }
  const runtime = runtimeFactory({
    ...workerData.context,
    abortSignal: abortController.signal,
  });
  const operation = runtime?.[workerData.operation];
  if (typeof operation !== "function") {
    const error = new Error(
      `HARNESSDOCK_MCP_RESTART_REQUIRED: checkout runtime does not implement MCP operation ${workerData.operation}. ` +
      "Run npm run release:local and start a new Codex task."
    );
    /** @type {any} */ (error).code = "HARNESSDOCK_MCP_RESTART_REQUIRED";
    throw error;
  }
  const receipt = await operation(workerData.input);
  parentPort.postMessage({ ok: true, receipt });
} catch (error) {
  parentPort.postMessage({ ok: false, error: errorPayload(error) });
}
