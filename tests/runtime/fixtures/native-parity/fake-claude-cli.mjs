#!/usr/bin/env node
/** Test-owned fake Claude CLI. It never reads network or provider credentials. */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const scenario = env.CLAUDE_PARITY_SCENARIO ?? "normal";
const sessionBase = "native-session-s";
const logFile = env.CLAUDE_PARITY_LOG;
let interrupted = false;
let turnStarted = false;
let finished = false;

function selectedEnv() {
  return {
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    CLAUDE_PARITY_CONFIG_WITNESS: env.CLAUDE_PARITY_CONFIG_WITNESS ?? null,
    IS_SANDBOX: env.IS_SANDBOX ?? null,
  };
}

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...entry })}\n`);
}

function configWitness() {
  const configPath = path.join(env.CLAUDE_CONFIG_DIR ?? "", "native-parity-config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")).witness;
}

function flag(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitSuccess(sessionId, { assistantMessageId, resultId }) {
  emit({ type: "system", subtype: "init", session_id: sessionId, claude_code_version: "2.1.250", model: "claude-sonnet-5" });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { role: "assistant", id: assistantMessageId } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read", input: { file_path: "fixture.txt" } } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", content_block: { type: "tool_use", name: "Grep", input: { pattern: "needle" } } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "native result" } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "message_stop" } });
  emit({
    type: "result", subtype: "success", session_id: sessionId, uuid: resultId, result: "native result",
    duration_ms: 8, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 },
  });
}

function emitInterrupted() {
  if (finished || !turnStarted) return;
  finished = true;
  emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionBase, result: "" });
  process.exit(130);
}

async function firstInput() {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(buffer.slice(0, newline))); } catch (error) { reject(error); }
    };
    const onEnd = () => { cleanup(); reject(new Error("stdin ended before a native user message")); };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

async function main() {
  if (args[0] === "--version") {
    record({ kind: "probe", args, env: selectedEnv() });
    process.stdout.write("2.1.250 (Claude Code)\n");
    return;
  }
  if (args[0] === "--help") {
    record({ kind: "probe", args, env: selectedEnv() });
    process.stdout.write("-p --output-format --verbose --include-partial-messages --input-format --replay-user-messages --include-hook-events --name --model --effort --resume --allowedTools --disallowedTools --append-system-prompt --agents --settings --permission-mode --dangerously-skip-permissions stream-json low medium high xhigh max dontAsk bypassPermissions\n");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    record({ kind: "probe", args, env: selectedEnv() });
    process.stdout.write("authenticated\n");
    return;
  }
  if (args[0] !== "-p") throw new Error(`unexpected native args ${JSON.stringify(args)}`);

  const input = await firstInput();
  const inputText = input?.message?.content?.[0]?.text;
  const resume = flag("--resume");
  const sessionId = scenario === "drift" && resume ? "native-session-drift" : (resume ?? sessionBase);
  const userMessageId = resume ? "native-user-t2" : "native-user-t1";
  const assistantMessageId = resume ? "native-assistant-t2" : "native-assistant-t1";
  const resultId = resume ? "native-result-t2" : "native-result-t1";
  record({ kind: "turn", args, env: selectedEnv(), configWitness: configWitness(), input: inputText, resume, sessionId, userMessageId, assistantMessageId, resultId });
  emit({ type: "user", uuid: userMessageId, session_id: sessionId, message: { role: "user", content: [{ type: "text", text: inputText }] } });
  turnStarted = true;

  if (scenario === "interrupt") {
    emit({ type: "system", subtype: "init", session_id: sessionBase, claude_code_version: "2.1.250", model: "claude-sonnet-5" });
    if (interrupted) emitInterrupted();
    return;
  }
  if (scenario === "recover" && !resume) {
    emit({ type: "system", subtype: "init", session_id: sessionBase, claude_code_version: "2.1.250", model: "claude-sonnet-5" });
    emit({ type: "stream_event", session_id: sessionBase, event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
    process.stderr.write("Connection closed mid-response.\n");
    process.exit(1);
  }
  if (scenario === "usage") {
    emit({ type: "system", subtype: "init", session_id: sessionBase, claude_code_version: "2.1.250", model: "claude-sonnet-5" });
    emit({
      type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionBase, result: "",
      duration_ms: 8, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 },
    });
    process.stderr.write("usage limit reached\n");
    process.exit(1);
  }
  emitSuccess(sessionId, { assistantMessageId, resultId });
}

process.on("SIGINT", () => {
  interrupted = true;
  emitInterrupted();
});

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
