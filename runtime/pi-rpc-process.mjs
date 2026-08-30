/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * One Pi RPC child.  This owns JSONL framing, correlation, and child cleanup;
 * the Pi Driver owns route and Harness semantics.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export const PI_RPC_MAX_LINE_BYTES = 1024 * 1024;
export const PI_RPC_RESPONSE_TIMEOUT_MS = 10_000;
const PI_RPC_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiRpcProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PiRpcProcessError";
    this.code = code;
  }
}

export function piRpcArgv({ provider, model, effort, sessionDir, sessionId, resumeSessionId, resumeOnly = false, control = false }) {
  const session = resumeSessionId == null
    ? ["--session-id", sessionId]
    : ["--session", resumeSessionId];
  return [
    "--mode", "rpc",
    "--session-dir", sessionDir,
    ...(resumeOnly || model == null ? [] : ["--provider", provider, "--model", model, "--thinking", effort]),
    ...(control ? ["--offline", "--no-session"] : session),
  ];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function safeText(value, max = 512) {
  return typeof value === "string" ? value.slice(0, max) : "Pi RPC protocol failed.";
}

/**
 * Start a fixed Pi RPC process. `_test` is intentionally private: production
 * callers have no process, executable, or session-root selector.
 */
export function createPiRpcProcess(options) {
  const spawn = options?._test?.spawn ?? nodeSpawn;
  const command = options?._test?.command ?? "pi";
  const responseTimeoutMs = options?._test?.responseTimeoutMs ?? PI_RPC_RESPONSE_TIMEOUT_MS;
  const child = spawn(command, options.argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  if (!child?.stdin || !child?.stdout || !child?.stderr) {
    throw new PiRpcProcessError("spawn_failed", "Pi RPC did not provide standard streams.");
  }

  const pending = new Map();
  const settled = deferred();
  // A protocol failure may happen while the caller is awaiting a correlated
  // response rather than settlement. Keep that later observable rejection from
  // becoming an unhandled process-level rejection.
  settled.promise.catch(() => {});
  let terminal = false;
  let closed = false;
  let fatal = null;
  let stderr = "";
  let finalAssistantMessage = null;
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (!terminal) settled.reject(error);
  }
  function fail(code, message) {
    if (fatal) return;
    fatal = new PiRpcProcessError(code, message);
    rejectPending(fatal);
  }
  function receive(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("invalid_response", "Pi RPC emitted a non-object JSON response.");
      return;
    }
    if (value.type === "response") {
      const request = pending.get(value.id);
      if (!request || value.command !== request.command) {
        fail("invalid_response", "Pi RPC emitted an uncorrelated response.");
        return;
      }
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.success !== true) {
        request.reject(new PiRpcProcessError("request_rejected", safeText(value.error)));
      } else {
        request.resolve(value);
      }
      return;
    }
    if (value.type === "extension_ui_request" && PI_RPC_DIALOG_METHODS.has(value.method)) {
      if (typeof value.id !== "string" || !value.id || value.id.length > 512 || value.id.includes("\0")) {
        fail("invalid_response", "Pi RPC emitted an invalid extension UI request.");
        return;
      }
      if (value.method === "select" && (!Array.isArray(value.options) || typeof value.options[0] !== "string")) {
        fail("invalid_response", "Pi RPC emitted a select request without a first option.");
        return;
      }
      if (value.method === "editor" && value.prefill != null && typeof value.prefill !== "string") {
        fail("invalid_response", "Pi RPC emitted an invalid editor prefill.");
        return;
      }
      const response = value.method === "confirm"
        ? { confirmed: true }
        : { value: value.method === "select" ? value.options[0] : value.method === "editor" ? value.prefill ?? "" : "" };
      try {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: value.id, ...response })}\n`, "utf8", (error) => {
          if (error) fail("stdin_error", "Pi RPC extension UI response failed.");
        });
      } catch {
        fail("stdin_error", "Pi RPC extension UI response failed.");
      }
      return;
    }
    if (value.type === "message_end") {
      if (value.message?.role === "assistant") finalAssistantMessage = value.message;
      return;
    }
    if (value.type === "agent_settled") {
      terminal = true;
      settled.resolve({ finalAssistantMessage });
    }
  }
  function receiveLine(line) {
    if (Buffer.byteLength(line, "utf8") > PI_RPC_MAX_LINE_BYTES) {
      fail("response_too_large", "Pi RPC emitted an oversized JSONL response.");
      return;
    }
    try {
      receive(JSON.parse(line));
    } catch {
      fail("invalid_response", "Pi RPC emitted invalid JSONL.");
    }
  }
  function onStdout(chunk) {
    buffer += decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n"); // Strict JSONL: do not split U+2028/U+2029.
      if (index < 0) {
        if (Buffer.byteLength(buffer, "utf8") > PI_RPC_MAX_LINE_BYTES) {
          fail("response_too_large", "Pi RPC emitted an oversized JSONL response.");
        }
        return;
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      receiveLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }
  function onStdoutEnd() {
    buffer += decoder.end();
    if (buffer) receiveLine(buffer);
    if (!terminal) fail("process_exit", "Pi RPC closed before agent_settled.");
  }
  child.stdout.on("data", onStdout);
  child.stdout.on("end", onStdoutEnd);
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.once("error", () => fail("process_error", "Pi RPC process failed."));
  child.once("exit", () => {
    closed = true;
    if (!terminal) fail("process_exit", "Pi RPC exited before agent_settled.");
  });

  function request(command, payload = {}) {
    if (fatal) return Promise.reject(fatal);
    if (closed) return Promise.reject(new PiRpcProcessError("process_exit", "Pi RPC process is closed."));
    const id = randomUUID();
    const gate = deferred();
    const timer = setTimeout(
      () => fail("response_timeout", `Pi RPC ${command} response exceeded the fixed deadline.`),
      responseTimeoutMs,
    );
    pending.set(id, { command, timer, ...gate });
    try {
      child.stdin.write(`${JSON.stringify({ id, type: command, ...payload })}\n`, "utf8", (error) => {
        if (!error) return;
        const request = pending.get(id);
        pending.delete(id);
        clearTimeout(request?.timer);
        gate.reject(new PiRpcProcessError("stdin_error", "Pi RPC input failed."));
      });
    } catch {
      const request = pending.get(id);
      pending.delete(id);
      clearTimeout(request?.timer);
      gate.reject(new PiRpcProcessError("stdin_error", "Pi RPC input failed."));
    }
    return gate.promise;
  }

  return Object.freeze({
    child,
    prompt: (message) => request("prompt", { message }),
    steer: (message) => request("steer", { message }),
    abort: () => request("abort"),
    getEntries: (since) => request("get_entries", since == null ? {} : { since }),
    getSessionStats: () => request("get_session_stats"),
    getState: () => request("get_state"),
    getAvailableModels: () => request("get_available_models"),
    setModel: (provider, modelId) => request("set_model", { provider, modelId }),
    getAvailableThinkingLevels: () => request("get_available_thinking_levels"),
    getCommands: () => request("get_commands"),
    setAutoRetry: (enabled) => request("set_auto_retry", { enabled }),
    setAutoCompaction: (enabled) => request("set_auto_compaction", { enabled }),
    setSteeringMode: (mode) => request("set_steering_mode", { mode }),
    setFollowUpMode: (mode) => request("set_follow_up_mode", { mode }),
    waitForSettled: () => settled.promise,
    finalAssistantMessage: () => finalAssistantMessage,
    async dispose() {
      if (closed) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 1000);
        child.once("exit", () => { clearTimeout(timer); resolve(undefined); });
      });
    },
  });
}
