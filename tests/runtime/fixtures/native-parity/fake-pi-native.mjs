#!/usr/bin/env node
/** SPDX-License-Identifier: Apache-2.0 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const stateDir = process.env.PI_NATIVE_PARITY_STATE_DIR;
const configRoot = process.env.PI_CODING_AGENT_DIR;
if (!stateDir || !configRoot) throw new Error("native parity fixture needs its bounded state and config roots");

const statePath = path.join(stateDir, "sessions.json");
const recordsDir = path.join(stateDir, "records");
const configPath = path.join(configRoot, "native-parity.json");
fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
function config() { return readJson(configPath, {}); }
function state() { return readJson(statePath, { nextProcess: 0, sessions: {} }); }
function updateState(fn) { const value = state(); fn(value); writeJson(statePath, value); return value; }
function argValue(name) { const index = process.argv.indexOf(name); return index < 0 ? null : (process.argv[index + 1] ?? null); }

const argv = process.argv.slice(2);
const sessionId = argValue("--session-id") ?? argValue("--session");
const processNumber = updateState((value) => { value.nextProcess += 1; }).nextProcess;
const recordPath = path.join(recordsDir, `${String(processNumber).padStart(4, "0")}.json`);
const record = {
  processNumber,
  pid: process.pid,
  argv,
  environment: {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
    PI_NATIVE_PARITY_ENV_WITNESS: process.env.PI_NATIVE_PARITY_ENV_WITNESS ?? null,
  },
  sessionId,
  configWitness: config().configWitness ?? null,
  commands: [],
  events: [],
  closed: false,
};
function saveRecord() { writeJson(recordPath, record); }
saveRecord();
function emit(value) {
  if (value.type !== "response") record.events.push(value);
  saveRecord();
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function response(command, data) { emit({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) }); }
function reject(command, error) { emit({ id: command.id, type: "response", command: command.type, success: false, error }); }
function selectedModel() {
  const provider = argValue("--provider"); const model = argValue("--model");
  return provider && model ? `${provider}/${model}` : null;
}
let activeModel = selectedModel();
let active = false;

function sessionForCurrentProcess() {
  if (!sessionId) return null;
  return updateState((value) => {
    value.sessions[sessionId] ??= {
      leaf: 0,
      turns: [],
      stats: { toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    };
  }).sessions[sessionId];
}
function statsForSession() { return sessionForCurrentProcess()?.stats ?? { toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; }
function settle(stopReason = config().terminalStopReason ?? "stop") {
  if (!active) return;
  active = false;
  const current = updateState((value) => {
    const item = value.sessions[sessionId];
    const turnNumber = item.turns.length + 1;
    const id = config().reuseNativeTurnId ? "native-turn-1" : `native-turn-${turnNumber}`;
    item.leaf += 1;
    item.turns.push({ type: "message", id, timestamp: 1_764_000_000_000 + turnNumber, message: { role: "assistant", stopReason, content: [{ type: "text", text: `native answer ${id}` }] } });
    const delta = config().usageDelta ?? { toolCalls: 2, input: 12, output: 6, cacheRead: 3, cacheWrite: 2 };
    item.stats.toolCalls += delta.toolCalls;
    item.stats.tokens.input += delta.input;
    item.stats.tokens.output += delta.output;
    item.stats.tokens.cacheRead += delta.cacheRead;
    item.stats.tokens.cacheWrite += delta.cacheWrite;
  }).sessions[sessionId];
  const message = current.turns.at(-1).message;
  const events = config().eventOrder ?? ["turn_started", "tool_call", "message_end", "agent_settled"];
  for (const type of events) {
    if (type === "message_end") emit({ type, message });
    else emit({ type });
  }
}
function promptAllowed(message) {
  const requiredText = config().requiredPromptText;
  const requiredArgv = config().requiredArgv;
  return (!requiredText || message.includes(requiredText)) && (!requiredArgv || argv.includes(requiredArgv));
}
function commands() { return config().commands ?? [{ source: "extension" }, { source: "prompt" }, { source: "skill" }]; }

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { process.exitCode = 2; return; }
  record.commands.push(command); saveRecord();
  const currentConfig = config();
  if (command.type === "get_available_models") { response(command, { models: Object.keys(currentConfig.catalog ?? {}) }); return; }
  if (command.type === "set_model") { activeModel = `${command.provider}/${command.modelId}`; response(command); return; }
  if (command.type === "get_available_thinking_levels") { response(command, { thinkingLevels: currentConfig.catalog?.[activeModel] ?? [] }); return; }
  if (command.type === "get_commands") { response(command, { commands: commands(), configWitness: currentConfig.configWitness ?? null }); return; }
  if (command.type === "get_state") {
    const [provider, id] = (activeModel ?? "").split("/");
    response(command, { sessionId, model: { provider, id }, thinkingLevel: argValue("--thinking") ?? "high", isStreaming: false, isCompacting: false });
    return;
  }
  if (command.type === "get_entries") { const current = sessionForCurrentProcess(); response(command, { leafId: current ? `leaf-${current.leaf}` : null, entries: current?.turns ?? [] }); return; }
  if (command.type === "get_session_stats") { response(command, statsForSession()); return; }
  if (["set_auto_retry", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode", "steer"].includes(command.type)) { response(command); return; }
  if (command.type === "prompt") {
    if (!sessionId || !promptAllowed(command.message)) { reject(command, "native prompt policy rejected input"); return; }
    sessionForCurrentProcess(); active = true; response(command);
    if (currentConfig.settleOnPrompt !== false) queueMicrotask(() => settle());
    return;
  }
  if (command.type === "abort") { response(command); queueMicrotask(() => settle("aborted")); return; }
  reject(command, "unsupported native parity RPC command");
});

process.on("SIGTERM", () => { if (config().ignoreSigterm) return; process.exit(0); });
process.on("exit", () => { record.closed = true; saveRecord(); });
