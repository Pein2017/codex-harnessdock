/**
 * Node-only direct control for the test-owned fake Claude CLI.
 *
 * This intentionally imports no HarnessDock runtime module.  It hand-writes
 * the native JSONL user message and independently projects native events.
 */
import { spawn } from "node:child_process";

function encodeUser(text) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: String(text) }] },
  })}\n`;
}

function project(event) {
  if (event?.type === "system" && event.subtype === "init") return "init";
  if (event?.type === "result") return `result:${event.subtype ?? "unknown"}`;
  const inner = event?.type === "stream_event" ? event.event : null;
  if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
    const keys = Object.keys(inner.content_block.input ?? {}).sort().join(",");
    return `tool:${inner.content_block.name}:${keys}`;
  }
  const text = inner?.delta?.type === "text_delta" ? inner.delta.text : null;
  return text ? `text:${text}` : null;
}

/** Spawn one fake-native Claude process without using any HarnessDock helper. */
export async function runDirectClaude({ executable, args, cwd, env, input, interrupt = false }) {
  const child = spawn(executable, args, {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stdout = "";
  let stderr = "";
  let sessionId = null;
  let initResolve;
  const initialized = new Promise((resolve) => { initResolve = resolve; });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "system" && event.subtype === "init") {
        sessionId = event.session_id ?? null;
        initResolve();
      }
      events.push(event);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.stdin.end(encodeUser(input));
  if (interrupt) {
    await initialized;
    process.kill(-child.pid, "SIGINT");
  }
  const closedResult = await closed;
  if (stdout.trim()) events.push(JSON.parse(stdout));
  const terminal = [...events].reverse().find((event) => event.type === "result") ?? null;
  return {
    pid: child.pid,
    ...closedResult,
    stderr,
    sessionId,
    terminal,
    eventProjection: events.map(project).filter(Boolean),
  };
}
