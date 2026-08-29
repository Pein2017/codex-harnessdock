/** SPDX-License-Identifier: Apache-2.0 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function deferred() {
  let resolve; let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function open({ executable, argv, cwd, env }) {
  const child = spawn(process.execPath, [executable, ...argv], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const events = [];
  let buffer = "";
  let closed = false;
  const settled = deferred();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const value = JSON.parse(line);
      if (value.type === "response") {
        const request = pending.get(value.id); pending.delete(value.id);
        if (!request) throw new Error("direct Pi oracle received an uncorrelated response");
        if (value.success !== true) request.reject(new Error(value.error)); else request.resolve(value);
      } else {
        events.push(value);
        if (value.type === "agent_settled") settled.resolve(value);
      }
    }
  });
  child.once("exit", () => { closed = true; });
  let sequence = 0;
  return {
    child,
    events,
    request(type, payload = {}) {
      const id = `direct-${++sequence}`;
      const gate = deferred(); pending.set(id, gate);
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
      return gate.promise;
    },
    waitForSettled() { return settled.promise; },
    async dispose() {
      if (!closed) child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function recordFor(stateDir, pid) {
  const records = fs.readdirSync(path.join(stateDir, "records")).map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, "records", name), "utf8")));
  const record = records.find((item) => item.pid === pid);
  if (!record) throw new Error("direct Pi oracle could not recover its native receipt");
  return record;
}

function prompt(authority, task) {
  const authorityLine = authority === "behavioral_write"
    ? "Task-scoped writes are permitted only when needed for the stated task."
    : "Read only. Do not change files, processes, configuration, or external state.";
  return [
    "HarnessDock route contract:",
    `- ${authorityLine}`,
    "- Work as one leaf Agent. Do not delegate, spawn another agent, or start another harness.",
    "- Return one final assistant message to the Codex lead.",
    "",
    "Task:",
    task,
  ].join("\n");
}

export async function directInventory(input) {
  const client = open(input);
  const models = (await client.request("get_available_models")).data.models;
  const effortsByModel = {};
  for (const model of models) {
    const slash = model.indexOf("/");
    await client.request("set_model", { provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    effortsByModel[model] = (await client.request("get_available_thinking_levels")).data.thinkingLevels;
    await client.request("get_state");
  }
  const nativeConfiguration = (await client.request("get_commands")).data;
  const pid = client.child.pid;
  await client.dispose();
  return { models, effortsByModel, nativeConfiguration, record: recordFor(input.env.PI_NATIVE_PARITY_STATE_DIR, pid) };
}

export async function directTurn({ authority, task, ...input }) {
  const client = open(input);
  const state = (await client.request("get_state")).data;
  const beforeEntries = (await client.request("get_entries")).data;
  const beforeStats = (await client.request("get_session_stats")).data;
  await client.request("set_auto_retry", { enabled: false });
  await client.request("set_auto_compaction", { enabled: true });
  await client.request("set_steering_mode", { mode: "one-at-a-time" });
  await client.request("set_follow_up_mode", { mode: "one-at-a-time" });
  const promptText = prompt(authority, task);
  await client.request("prompt", { message: promptText });
  await client.waitForSettled();
  const afterEntries = (await client.request("get_entries", { since: beforeEntries.leafId })).data;
  const afterStats = (await client.request("get_session_stats")).data;
  const pid = client.child.pid;
  await client.dispose();
  return { state, beforeEntries, beforeStats, promptText, events: client.events, afterEntries, afterStats, record: recordFor(input.env.PI_NATIVE_PARITY_STATE_DIR, pid) };
}

export async function directInterrupt({ authority, task, ...input }) {
  const client = open(input);
  await client.request("get_state");
  const promptText = prompt(authority, task);
  await client.request("prompt", { message: promptText });
  const abort = await client.request("abort");
  await client.waitForSettled();
  const pid = client.child.pid;
  await client.dispose();
  return { promptText, abort, events: client.events, record: recordFor(input.env.PI_NATIVE_PARITY_STATE_DIR, pid) };
}
