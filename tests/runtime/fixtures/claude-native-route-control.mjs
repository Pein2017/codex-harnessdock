import { spawn } from "node:child_process";
import fs from "node:fs";

const mode = process.env.CLAUDE_NATIVE_ROUTE_PROBE_FIXTURE_MODE ?? "current-negative";
const tracePath = process.env.CLAUDE_NATIVE_ROUTE_PROBE_TRACE;
const secret = "fixture-secret-config-/not-for-receipt";

function write(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function response(requestId, models, hooks = false) {
  if (hooks) {
    write({ type: "system", subtype: "hook_started" });
    write({ type: "system", subtype: "hook_progress" });
    write({ type: "system", subtype: "hook_response" });
  }
  write({ type: "system", subtype: "init", claude_code_version: "2.1.250" });
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { models } },
  });
}

function completeRow(overrides = {}) {
  return {
    value: "claude-test-1",
    resolvedModel: "claude-test-1",
    displayName: secret,
    description: secret,
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    ...overrides,
  };
}

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let request;
  try {
    const lines = input.split("\n").filter(Boolean);
    request = lines.length === 1 ? JSON.parse(lines[0]) : null;
  } catch {}
  if (tracePath) {
    fs.writeFileSync(tracePath, JSON.stringify({
      args: process.argv.slice(2),
      configDir: process.env.CLAUDE_CONFIG_DIR,
      input,
    }));
  }
  const requestId = request?.request_id ?? "missing-request";
  if (mode === "timeout") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (mode === "oversized") {
    process.stdout.write(`${"x".repeat(70 * 1024)}\n`);
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("{bad json}\n");
    return;
  }
  if (mode === "mismatched") {
    response("wrong-request", [completeRow()]);
    return;
  }
  if (mode === "unknown-system") {
    write({ type: "system", subtype: "hook_unrecognized" });
    return;
  }
  if (mode === "user" || mode === "assistant" || mode === "result") {
    write({ type: "system", subtype: "init", claude_code_version: "2.1.250" });
    write({ type: mode });
    return;
  }
  if (mode === "model-request") {
    write({ type: "system", subtype: "init", claude_code_version: "2.1.250" });
    write({ type: "control_request", request: { subtype: "set_model" } });
    return;
  }
  if (mode === "continuation") {
    write({ type: "system", subtype: "init", claude_code_version: "2.1.250" });
    write({ type: "stream_event", subtype: "session_continuation" });
    return;
  }
  if (mode === "linger") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (tracePath) fs.appendFileSync(tracePath, `\n${child.pid}`);
    response(requestId, [completeRow()]);
    setInterval(() => {}, 1_000);
    return;
  }

  const rows = {
    "current-negative": [
      completeRow({ value: "default", resolvedModel: "claude-test-1" }),
      completeRow({ value: "sonnet", resolvedModel: "claude-test-1" }),
      completeRow({ value: "context-1m", resolvedModel: "claude-test-1" }),
    ],
    candidate: [completeRow()],
    "hook-lifecycle": [completeRow({ supportedEffortLevels: ["opaque-effort-v1"] })],
    default: [completeRow({ value: "default", resolvedModel: "claude-test-1" })],
    alias: [completeRow({ value: "sonnet", resolvedModel: "claude-test-1" })],
    mismatch: [completeRow({ resolvedModel: "claude-other-1" })],
    "missing-efforts": [completeRow({ supportsEffort: false, supportedEffortLevels: [] })],
    "malformed-row": [{}],
  }[mode];
  if (!rows) {
    process.stderr.write(secret);
    response(requestId, []);
    return;
  }
  process.stderr.write(secret);
  response(requestId, rows, mode === "hook-lifecycle");
});
