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

import { ADMITTED_GENERATION_HARNESS_IDS, ADMITTED_MODEL_IDS } from "./harness-registry.mjs";
import { HARNESSDOCK_MCP_API_GENERATION } from "./mcp-api.mjs";
import { removeRuntimeLoaderMarker, resolveGitCommonDirectory } from "./promotion-gate.mjs";
import { PACKAGE_VERSION } from "./version.mjs";

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
const MODEL_IDS = [...ADMITTED_MODEL_IDS];
const HARNESS_IDS = [...ADMITTED_GENERATION_HARNESS_IDS];
const TOPOLOGIES = ["leaf", "native_orchestrator"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODEL_FACING_WAIT_TIMEOUT_MS = 3_600_000;

const exactTarget = z.string().trim().min(1).describe(
  "Exact current-root Agent ID, /root/<task_name>, or normalized name."
);
const message = z.string().trim().min(1);
const executionFields = {
  reasoning_effort: z.enum(EFFORTS).optional(),
};
const TOOL_DEFINITIONS = Object.freeze({
  list_harnesses: {
    description:
      "Experimental: list the Harnesses this checkout admits, with each logical instance's readiness, route constraints, capability maturity, and capacity. This observes state only.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  spawn_agent: {
    description:
      "Experimental: start one durable Agent asynchronously on an explicitly stated route. The Harness, full model, topology, and behavioral authority are all required and are frozen on the Agent; none of them is defaulted, inferred, or aliased.",
    inputSchema: z.object({
      task_name: z.string().regex(/^[a-z0-9_]+$/),
      message,
      description: z.string().trim().min(1).optional(),
      harness: z.enum(/** @type {[string, ...string[]]} */ (HARNESS_IDS)).describe(
        "Required Harness this Agent runs on. There is no default Harness."
      ),
      model: z.enum(/** @type {[string, ...string[]]} */ (MODEL_IDS)).describe(
        "Required full model identifier admitted by the stated Harness."
      ),
      topology: z.enum(/** @type {[string, ...string[]]} */ (TOPOLOGIES)).describe(
        "Required topology: leaf runs the task itself; native_orchestrator is admitted only by a Harness whose route proves it."
      ),
      write: z.boolean().describe(
        "Required behavioral authority: false is read/review-only; true permits task-scoped writes. Process access is unchanged."
      ),
      ...executionFields,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  send_message: {
    description:
      "Experimental: deliver to a running Agent or queue for idle; never activates it.",
    inputSchema: z.object({ target: exactTarget, message }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  followup_task: {
    description:
      "Experimental: deliver work or activate one proven Agent continuation asynchronously. The Agent's route and behavioral authority are immutable and inherited; only its turn-scoped reasoning effort may be stated where the route admits one.",
    inputSchema: z.object({ target: exactTarget, message, ...executionFields }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  wait_agent: {
    description:
      "Experimental: join one current-root Agent turn or a fixed all-settled target barrier; one target may opt into one progress update.",
    inputSchema: z.object({
      targets: z.array(exactTarget).min(1).max(8).optional().describe(
        "Fixed exact current-root Agent turns to join; one target may observe progress and multiple targets form a completion-only barrier."
      ),
      wake_on_progress: z.boolean().optional().describe(
        "Return the Agent turn's one eligible safe progress update before completion; ordinary joins omit."
      ),
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
    description:
      "Experimental: request that only the current Agent turn stop; preserve identity and proven continuation.",
    inputSchema: z.object({ target: exactTarget }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  list_agents: {
    description:
      "Experimental: list current-root logical Agent Cards, optionally by path prefix. This observes state only.",
    inputSchema: z.object({ path_prefix: z.string().trim().min(1).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  read_agent_messages: {
    description:
      "Experimental: read complete recent outer-assistant text from an Agent's proven native history without activation.",
    inputSchema: z.object({
      target: exactTarget,
      before: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
});

function contextError(detail) {
  return new Error(
    `HarnessDock MCP requires trusted Codex thread and local sandbox workspace metadata: ${detail}. ` +
    "Start a new Codex task with the installed codex-harnessdock Plugin enabled."
  );
}

const PRIVATE_ID_PATTERNS = [
  /\b(?:native\s+)?Claude\s+session(?:\s+ID)?\s*[:=]?\s*(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?session\s+(?:ID|id)\s*[:=]?\s*[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:native\s+)?session(?:\s+(?:ID|id))?\s*[:=]?\s+(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:internal\s+)?(?:Claude\s+)?job(?:\s+(?:ID|id)?|\s*[:=])\s*(?=[A-Za-z0-9._:-]*[0-9_-])[A-Za-z0-9][A-Za-z0-9._:-]*/gi,
  /\b(?:session|job)(?:Id|ID)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._:-]*/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

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
        && /\bAgent(?: path)?\s*$/i.test(context);
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

/** @returns {import("@modelcontextprotocol/sdk/types.js").CallToolResult} */
export function runtimeReceiptResult(receipt) {
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    structuredContent: receipt,
  };
}

export function sanitizedError(error) {
  const messageText = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(redactMcpErrorMessage(messageText));
  if (typeof /** @type {any} */ (error)?.code === "string") {
    /** @type {any} */ (sanitized).code = /** @type {any} */ (error).code;
  }
  return sanitized;
}

function workerError(payload) {
  const error = new Error(payload?.message || "HarnessDock MCP isolated runtime call failed.");
  error.name = payload?.name || "Error";
  if (typeof payload?.code === "string") /** @type {any} */ (error).code = payload.code;
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
const HARNESSDOCK_MCP_SERVER_OPTIONS = Object.freeze(["runtimeFactory", "runtimeInvoker"]);

/**
 * @param {{runtimeFactory?: (context: any) => any, runtimeInvoker?: (input: any) => Promise<any>}} [options]
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
  const server = new McpServer(
    { name: "codex-harnessdock", version: PACKAGE_VERSION },
    {
      capabilities: { experimental: { [CODEX_SANDBOX_META_KEY]: {} } },
      instructions:
        "Use the eight Experimental Agent tools. list_harnesses observes which Harnesses this checkout admits and what each instance reports. Spawn starts one Agent asynchronously on an explicitly stated Harness, full model, topology, and behavioral authority, all of which are then frozen on that Agent; follow-up inherits them. wait_agent has implementation-defined completion-priority, wakes on durable activity, has a fixed one-hour upper bound, and takes no timeout argument. Targets form one to eight exact targets joined as either one exact turn or an all-settled barrier; only one target may opt into one progress update. A completion token is acknowledged exactly once on a later wait only if needed. After a quiet timeout, call wait_agent again instead of list_agents or read_agent_messages. list_agents observes logical Agent Cards without delivery. Tool calls are scoped by trusted Codex metadata.",
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
        return runtimeReceiptResult(receipt);
      } catch (error) {
        throw sanitizedError(error);
      }
    });
  }
  return server;
}

export async function runCcMcpServer() {
  const server = createCcMcpServer();
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
