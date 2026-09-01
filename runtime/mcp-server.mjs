#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Typed Codex MCP adapter. This process owns no lifecycle state: every call is
 * bound to trusted Codex metadata and delegated to runtime/index.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { isBoundedRouteAtom, isBoundedRouteText } from "./harness-contract.mjs";
import { HARNESSDOCK_MCP_API_GENERATION, HARNESSDOCK_MCP_HARNESS_IDS } from "./mcp-api.mjs";
import { removeRuntimeLoaderMarker, resolveGitCommonDirectory } from "./promotion-gate.mjs";
import { PACKAGE_VERSION } from "./version.mjs";
import { ensureResidencyManager } from "./residency-manager.mjs";

export const CODEX_SANDBOX_META_KEY = "codex/sandbox-state-meta";
export const HARNESSDOCK_MCP_TOOL_NAMES = Object.freeze([
  "list_harnesses",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "read_agent_messages",
  "dispatch_agents",
]);

const SOURCE_ROOT = fs.realpathSync.native(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);
const FIXED_ENV_FILE = path.join(SOURCE_ROOT, "config", "runtime.env");
const RUNTIME_MODULE_URL = pathToFileURL(path.join(SOURCE_ROOT, "runtime", "index.mjs"));
const MCP_CALL_WORKER_URL = new URL("./mcp-call-worker.mjs", import.meta.url);
const PROMOTION_GATE_DIRECTORY = path.join(
  resolveGitCommonDirectory(SOURCE_ROOT),
  "codex-harnessdock-promotion-gate",
);
// One source for both the typed schema and runtime validation.
const HARNESS_IDS = [...HARNESSDOCK_MCP_HARNESS_IDS];
const TOPOLOGIES = ["leaf", "native_orchestrator"];
const boundedRouteText = z.string().min(1).max(256).refine(
  isBoundedRouteText,
  "must be bounded exact route text",
);
const boundedRouteAtom = z.string().refine(isBoundedRouteAtom, "must be one bounded route atom");
const MODEL_FACING_WAIT_TIMEOUT_MS = 3_600_000;
export const HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT = 4_500;
export const HARNESSDOCK_MCP_HOST_PROJECTION_CHAR_RESERVE = 2_932;

const exactTarget = z.string().trim().min(1);
const message = z.string().trim().min(1);
const targetWorktree = z.string().refine(
  (value) => path.isAbsolute(value) && !value.includes("\0"),
  "must be an absolute target worktree path",
);
const terminalEventDescriptorPath = z.string().refine(
  (value) => path.isAbsolute(value) && !value.includes("\0"),
  "must be an absolute terminal event descriptor path",
);
const executionFields = {
  reasoning_effort: boundedRouteAtom,
};
// The dispatch decoder retains singular route validation while keeping the
// ninth serialized catalog compact: the refinements carry the exact bounds.
const dispatchTaskName = z.string().refine(
  (value) => /^[a-z0-9_]+$/u.test(value),
  "must be a lowercase task name",
);
const dispatchMessage = z.string().trim().refine(
  (value) => value.length > 0,
  "must not be empty",
);
const dispatchRouteText = z.string().refine(
  isBoundedRouteText,
  "must be bounded exact route text",
);
const dispatchRouteAtom = dispatchRouteText.refine(
  isBoundedRouteAtom,
  "must be one bounded route atom",
);
const dispatchRow = z.object({
  task_name: dispatchTaskName,
  message: dispatchMessage,
  description: dispatchMessage.optional(),
  harness: z.enum(/** @type {[string, ...string[]]} */ (HARNESS_IDS)),
  model: dispatchRouteText,
  topology: z.enum(/** @type {[string, ...string[]]} */ (TOPOLOGIES)),
  write: z.boolean(),
  target_worktree: targetWorktree.optional(),
  reasoning_effort: dispatchRouteAtom,
  terminal_event_descriptor_path: terminalEventDescriptorPath.optional(),
}).strict();
const TOOL_DEFINITIONS = Object.freeze({
  list_harnesses: {
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  spawn_agent: {
    inputSchema: z.object({
      task_name: z.string().regex(/^[a-z0-9_]+$/),
      message,
      description: z.string().trim().min(1).optional(),
      harness: z.enum(/** @type {[string, ...string[]]} */ (HARNESS_IDS)),
      model: boundedRouteText,
      topology: z.enum(/** @type {[string, ...string[]]} */ (TOPOLOGIES)),
      write: z.boolean(),
      target_worktree: targetWorktree.optional(),
      ...executionFields,
      terminal_event_descriptor_path: terminalEventDescriptorPath.optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  send_message: {
    inputSchema: z.object({ target: exactTarget, message }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  followup_task: {
    inputSchema: z.object({ target: exactTarget, message }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  wait_agent: {
    inputSchema: z.object({
      targets: z.array(exactTarget).min(1).max(8).optional(),
      wake_on_progress: z.boolean().optional(),
      acknowledge_tokens: z.array(z.string().trim().min(1)).optional(),
    }).strict().superRefine((value, context) => {
      if (value.targets && value.wake_on_progress === true && value.targets.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets"],
          message: "wake_on_progress requires exactly one target when targets are provided",
        });
      }
      if (value.targets && new Set(value.targets).size !== value.targets.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets"],
          message: "targets must contain unique Agent identifiers",
        });
      }
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  interrupt_agent: {
    inputSchema: z.object({ target: exactTarget }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  list_agents: {
    inputSchema: z.object({ path_prefix: z.string().trim().min(1).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  read_agent_messages: {
    inputSchema: z.object({
      target: exactTarget,
      before: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  dispatch_agents: {
    inputSchema: z.object({
      rows: z.array(dispatchRow).min(1).max(8),
    }).strict().superRefine((value, context) => {
      const taskNames = value.rows.map((row) => row.task_name);
      if (new Set(taskNames).size !== taskNames.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows"],
          message: "rows must contain unique task_name values",
        });
      }
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
});

export function mcpExposedDescriptionCharacters(tools, instructions) {
  return (Array.isArray(tools) ? tools : []).reduce(
    (total, tool) => total + String(tool?.description ?? "").length + String(instructions ?? "").length,
    0,
  );
}

export function mcpProjectedModelVisibleCharacters(tools, instructions) {
  return HARNESSDOCK_MCP_HOST_PROJECTION_CHAR_RESERVE + mcpExposedDescriptionCharacters(tools, instructions);
}

function contextError(detail) {
  return new Error(
    `HarnessDock MCP requires trusted Codex thread and local sandbox workspace metadata: ${detail}. ` +
    "Start a new Codex task with the installed codex-harnessdock Plugin enabled."
  );
}

const PRIVATE_ID_PATTERNS = [
  /\b(?:internal\s+)?Agent\s+(?:ID|id)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:agent|instance|job|session|attempt)(?:Id|ID|Key)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\bagent-[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:instance|attempt|message)-[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:internal\s+)?instance(?:\s+(?:ID|id))?\s*[:=]?\s+(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?Claude\s+session(?:\s+ID)?\s*[:=]?\s*(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?session\s+(?:ID|id)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?session(?:\s+(?:ID|id))?\s*[:=]?\s+(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:internal\s+)?(?:Claude\s+)?job(?:\s+(?:ID|id)?|\s*[:=])\s*(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:session|job)(?:Id|ID)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._:-]*/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

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

function normalizePublicSpawnRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agentName = String(value.agent_name ?? "").trim();
  const outcome = String(value.outcome ?? "").trim();
  const code = String(value.code ?? "").trim();
  if (!/^\/root\/[a-z0-9_]+$/u.test(agentName)) return null;
  if (!Object.hasOwn(PUBLIC_SPAWN_RECOVERY_CODES, outcome)) return null;
  if (!PUBLIC_RECOVERY_CODE_PATTERN.test(code) || code !== PUBLIC_SPAWN_RECOVERY_CODES[outcome]) return null;
  return Object.freeze({
    agent_name: agentName,
    outcome,
    code,
    // Recovery text is closed by outcome; arbitrary provider/runtime text is
    // never carried through the model-facing boundary.
    message: PUBLIC_SPAWN_RECOVERY_MESSAGES[outcome],
  });
}

function redactAbsolutePaths(message) {
  // Preserve only one flat public Agent path. `/root/.../...` is a private
  // filesystem path and must be redacted like every other absolute path.
  return message.replace(
    /(^|[\s"'`=,:([{])\/[^\s"'`<>\])};,]+/g,
    (match, prefix, offset, source) => {
      const candidate = match.slice(prefix.length);
      const pathStart = offset + prefix.length;
      const context = source.slice(Math.max(0, pathStart - 32), pathStart);
      const publicAgentPath = /^\/root\/[a-z0-9_]+$/u.test(candidate)
        && /\bAgent(?:\s+(?:name|path))?\s*$|\bbelongs\s+to\s*$/i.test(context);
      return publicAgentPath
        ? match
        : `${prefix}<runtime path>`;
    }
  );
}

export function redactMcpErrorMessage(value) {
  let message = String(value ?? "").replaceAll("\0", "").trim();
  for (const pattern of PRIVATE_ID_PATTERNS) {
    message = message.replace(pattern, (match) => {
      if (/job/i.test(match)) return "internal job";
      return "native session";
    });
  }
  message = redactAbsolutePaths(message);
  return message.slice(0, 8_000) || "HarnessDock MCP tool call failed.";
}

export function resolveCodexMcpContext(meta, signal = null) {
  const threadId = String(meta?.threadId ?? "").trim();
  if (!threadId) throw contextError("missing _meta.threadId");
  const rawCwd = meta?.[CODEX_SANDBOX_META_KEY]?.sandboxCwd;
  if (typeof rawCwd !== "string" || !rawCwd.trim()) {
    throw contextError(`missing _meta["${CODEX_SANDBOX_META_KEY}"].sandboxCwd`);
  }
  let cwd;
  try {
    const uri = new URL(rawCwd);
    if (uri.protocol !== "file:") throw contextError("sandboxCwd is not a local file URI");
    cwd = fileURLToPath(uri);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HarnessDock MCP requires")) throw error;
    throw contextError("sandboxCwd is not a valid local file URI");
  }
  if (!path.isAbsolute(cwd)) throw contextError("sandboxCwd is not absolute");
  try {
    cwd = fs.realpathSync.native(cwd);
    if (!fs.statSync(cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw contextError(`trusted sandbox workspace is unavailable or no longer exists: ${cwd}`);
  }
  return {
    cwd,
    envFile: FIXED_ENV_FILE,
    abortSignal: signal,
    env: {
      ...process.env,
      CODEX_THREAD_ID: threadId,
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: threadId,
      CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: SOURCE_ROOT,
      CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: SOURCE_ROOT,
      CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: FIXED_ENV_FILE,
    },
  };
}

function groupedModels(routes) {
  const groups = new Map();
  for (const model of Array.isArray(routes?.models) ? routes.models : []) {
    const efforts = Array.isArray(routes?.effortsByModel?.[model])
      ? routes.effortsByModel[model]
      : [];
    const key = JSON.stringify(efforts);
    const group = groups.get(key) ?? { models: [], efforts };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function compactHarnesses(receipt) {
  if (!Array.isArray(receipt?.harnesses)) return receipt;
  return {
    harnesses: receipt.harnesses.flatMap((harness) => {
      const instances = Array.isArray(harness?.instances) ? harness.instances : [];
      if (instances.length === 0) {
        return [{
          harness: harness?.harness ?? null,
          readiness: "unavailable",
          ...(harness?.unavailable ? { detail: harness.unavailable } : {}),
        }];
      }
      return instances.map((instance) => {
        const routes = instance?.routes;
        const constraints = routes && typeof routes === "object"
          ? Object.fromEntries(Object.entries(routes).filter(([key]) =>
            !["models", "effortsByModel", "topologies", "capacity"].includes(key)
          ))
          : {};
        return {
          harness: harness?.harness ?? null,
          instance: instance?.instance ?? null,
          readiness: instance?.readiness ?? "unavailable",
          ...(instance?.detail && instance.detail !== instance.readiness ? { detail: instance.detail } : {}),
          live_validated: instance?.live_validated === true,
          maturity: instance?.maturity ?? harness?.maturity ?? null,
          ...(instance?.inspection_generation != null
            ? { inspection_generation: instance.inspection_generation }
            : {}),
          ...(Number.isSafeInteger(instance?.capacity) ? { capacity: instance.capacity } : {}),
          ...(routes ? {
            model_groups: groupedModels(routes),
            topologies: Array.isArray(routes.topologies) ? routes.topologies : [],
            ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
          } : {}),
        };
      });
    }),
  };
}

function compactAgents(receipt) {
  if (!Array.isArray(receipt?.agents)) return receipt;
  const fields = [
    "agent_name", "agent_status", "harness", "model", "reasoning_effort",
    "authority", "delegation_mode", "phase",
  ];
  return {
    agents: receipt.agents.map((agent) => Object.fromEntries(
      fields.filter((field) => agent?.[field] != null).map((field) => [field, agent[field]])
    )),
  };
}

export function modelFacingReceipt(operation, receipt) {
  if (operation === "list_harnesses") return compactHarnesses(receipt);
  if (operation === "list_agents") return compactAgents(receipt);
  return receipt;
}

/** @returns {import("@modelcontextprotocol/sdk/types.js").CallToolResult} */
export function runtimeReceiptResult(operation, receipt) {
  return {
    content: [{ type: "text", text: JSON.stringify(modelFacingReceipt(operation, receipt)) }],
  };
}

export function sanitizedError(error) {
  const recovery = normalizePublicSpawnRecovery(/** @type {any} */ (error)?.publicRecovery);
  if (recovery) {
    const sanitized = new Error(recovery.message);
    /** @type {any} */ (sanitized).publicRecovery = recovery;
    return sanitized;
  }
  const messageText = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(redactMcpErrorMessage(messageText));
  if (typeof /** @type {any} */ (error)?.code === "string" && PUBLIC_ERROR_CODES.has(/** @type {any} */ (error).code)) {
    /** @type {any} */ (sanitized).code = /** @type {any} */ (error).code;
  }
  return sanitized;
}

function workerError(payload) {
  const recovery = normalizePublicSpawnRecovery(payload?.recovery);
  const error = new Error(
    recovery?.message || payload?.message || "HarnessDock MCP isolated runtime call failed."
  );
  error.name = payload?.name === "AbortError" ? "AbortError" : "Error";
  if (recovery) /** @type {any} */ (error).publicRecovery = recovery;
  if (typeof payload?.code === "string" && PUBLIC_ERROR_CODES.has(payload.code)) {
    /** @type {any} */ (error).code = payload.code;
  }
  return error;
}

export function invokeIsolatedRuntimeOperation(options) {
  const {
    operation,
    input,
    context,
    signal = null,
    expectedGeneration = HARNESSDOCK_MCP_API_GENERATION,
    runtimeModuleUrl = RUNTIME_MODULE_URL,
    workerUrl = MCP_CALL_WORKER_URL,
  } = options;
  const { abortSignal: _abortSignal, ...serializableContext } = context;
  const loaderMarkerPath = path.join(
    PROMOTION_GATE_DIRECTORY,
    "loaders",
    `${process.pid}-${randomUUID()}.json`,
  );
  const worker = new Worker(workerUrl, {
    workerData: {
      operation,
      input,
      context: serializableContext,
      expectedGeneration,
      runtimeModuleUrl: runtimeModuleUrl instanceof URL ? runtimeModuleUrl.href : String(runtimeModuleUrl),
      promotionGateDirectory: PROMOTION_GATE_DIRECTORY,
      loaderMarkerPath,
    },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortTimer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearTimeout(abortTimer);
      signal?.removeEventListener("abort", onAbort);
      removeRuntimeLoaderMarker(loaderMarkerPath);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => {
      worker.postMessage({ type: "abort" });
      if (operation === "wait_agent") {
        abortTimer = setTimeout(() => {
          const error = new Error("HarnessDock MCP wait observation was cancelled.");
          error.name = "AbortError";
          finish(reject, error);
        }, 1_000);
        abortTimer.unref?.();
      }
    };
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.receipt);
      else finish(reject, workerError(message?.error));
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (!settled) finish(reject, new Error(`HarnessDock MCP isolated runtime worker exited with code ${code}.`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * The two seams this server accepts, and nothing else.
 *
 * The default -- no options at all -- is production: every operation runs in an
 * isolated worker that builds its own runtime from the resolved operator
 * configuration. That default is why an unrecognized option must be refused
 * rather than ignored: a caller who believes it supplied a runtime, and is
 * silently given the isolated worker instead, reaches the operator's real
 * configuration while believing it reached the one it passed. That exact
 * mistake -- passing a bare factory function where an options object belongs --
 * sent a test turn to an operator's live Server.
 */
const HARNESSDOCK_MCP_SERVER_OPTIONS = Object.freeze(["runtimeFactory", "runtimeInvoker", "onOperationComplete"]);

/**
 * @param {{runtimeFactory?: (context: any) => any, runtimeInvoker?: (input: any) => Promise<any>, onOperationComplete?: () => Promise<void>|void}} [options]
 */
export function createCcMcpServer(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(
      "createCcMcpServer takes an options object; it accepts " +
      `${HARNESSDOCK_MCP_SERVER_OPTIONS.join(" and ")}. A bare function is not a runtime factory.`
    );
  }
  for (const key of Object.keys(options)) {
    if (!HARNESSDOCK_MCP_SERVER_OPTIONS.includes(key)) {
      throw new Error(
        `createCcMcpServer does not accept ${JSON.stringify(key)}; it accepts ` +
        `${HARNESSDOCK_MCP_SERVER_OPTIONS.join(" and ")}.`
      );
    }
  }
  for (const key of HARNESSDOCK_MCP_SERVER_OPTIONS) {
    const seam = /** @type {Record<string, unknown>} */ (options)[key];
    if (seam != null && typeof seam !== "function") {
      throw new Error(`createCcMcpServer ${key} must be a function when stated.`);
    }
  }
  const runtimeFactory = options.runtimeFactory;
  const runtimeInvoker = options.runtimeInvoker ?? invokeIsolatedRuntimeOperation;
  const onOperationComplete = options.onOperationComplete ?? null;
  const server = new McpServer(
    { name: "codex-harnessdock", version: PACKAGE_VERSION },
    {
      capabilities: { experimental: { [CODEX_SANDBOX_META_KEY]: {} } },
      instructions: "Experimental; trusted Codex metadata. Fresh routes; no defaults. Dispatch: stateless ordered rows; preflight, cancellation, outcomes. list_harnesses: no service/model turn.",
    }
  );

  for (const name of HARNESSDOCK_MCP_TOOL_NAMES) {
    const definition = TOOL_DEFINITIONS[name];
    /** @type {any} */ (server).registerTool(name, definition, async (input, extra) => {
      try {
        const context = resolveCodexMcpContext(extra._meta, extra.signal);
        const runtimeInput = name === "wait_agent"
          ? { ...input, timeout_ms: MODEL_FACING_WAIT_TIMEOUT_MS }
          : input;
        const receipt = runtimeFactory
          ? await runtimeFactory(context)[name](runtimeInput)
          : await runtimeInvoker({ operation: name, input: runtimeInput, context, signal: extra.signal });
        return runtimeReceiptResult(name, receipt);
      } catch (error) {
        const sanitized = sanitizedError(error);
        const recovery = normalizePublicSpawnRecovery(/** @type {any} */ (sanitized).publicRecovery);
        if (recovery) {
          return {
            ...runtimeReceiptResult(name, recovery),
            isError: true,
          };
        }
        throw sanitized;
      } finally {
        try { await onOperationComplete?.(); } catch { /* housekeeping is never an MCP operation failure */ }
      }
    });
  }
  return server;
}

export async function runCcMcpServer() {
  // MCP is a transport, not a cleanup owner.  A durable manager survives its
  // exit and uses the existing exact reaper; no MCP inactivity policy exists.
  await ensureResidencyManager({ envFile: FIXED_ENV_FILE, cwd: SOURCE_ROOT });
  const server = createCcMcpServer({ onOperationComplete: async () => {
    await ensureResidencyManager({ envFile: FIXED_ENV_FILE, cwd: SOURCE_ROOT });
  } });
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    process.stderr.write(`HarnessDock MCP transport error: ${error.message}\n`);
  };
  await server.connect(transport);
  const close = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCcMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
