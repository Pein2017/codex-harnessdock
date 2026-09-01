import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cli = path.join(root, "runtime", "cli.mjs");
const operatorCli = path.join(root, "runtime", "operator-cli.mjs");
const bootstrap = path.join(root, "plugins", "codex-harnessdock", "bootstrap", "harnessdock-runtime.mjs");
const cleanups = [];
const COMMON_DENIED_TOOLS = [
  "Workflow", "ListAgents", "ListPeers", "ScheduleWakeup", "CronCreate", "CronDelete",
  "CronList", "CronUpdate", "RemoteTrigger", "PushNotification", "SendUserMessage",
  "SendUserFile", "SendFile", "EnterWorktree", "ExitWorktree",
];
const LEAF_DENIED_TOOLS = [...COMMON_DENIED_TOOLS, "Agent", "SendMessage"];

afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

function waitMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function fakeClaude(filePath) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const teamTools = ["Agent", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];

function textOf(event) {
  return Array.isArray(event && event.message && event.message.content)
    ? event.message.content.map((part) => part && part.text || "").join("\\n")
    : "";
}

async function firstEvent() {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    const data = (chunk) => {
      body += chunk;
      const newline = body.indexOf("\\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(body.slice(0, newline))); } catch (error) { reject(error); }
    };
    const end = () => { cleanup(); reject(new Error("stdin ended before first stream event")); };
    const cleanup = () => { process.stdin.off("data", data); process.stdin.off("end", end); };
    process.stdin.on("data", data);
    process.stdin.on("end", end);
  });
}

function appendInvocation(record) {
  if (process.env.CODEX_HARNESSDOCK_FAKE_INVOCATION_FILE) {
    fs.appendFileSync(process.env.CODEX_HARNESSDOCK_FAKE_INVOCATION_FILE, JSON.stringify(record) + "\\n");
  }
}

async function main() {
  if (args[0] === "--version") return process.stdout.write("2.1.220 (Claude Code)\\n");
  if (args[0] === "--help") return process.stdout.write("-p --output-format --verbose --include-partial-messages --input-format --replay-user-messages --include-hook-events --name --model --effort --session-id --resume --allowedTools --disallowedTools --append-system-prompt --agents --settings --permission-mode --dangerously-skip-permissions stream-json low medium high xhigh max dontAsk bypassPermissions\\n");
  if (args[0] === "auth" && args[1] === "status") return process.stdout.write("authenticated\\n");
  if (args[0] === "--output-format") {
    const request = await firstEvent();
    if (request.type !== "control_request" || request.request?.subtype !== "initialize") {
      throw new Error("unexpected SDK request " + JSON.stringify(request));
    }
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    process.stdout.write(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.request_id,
        response: {
          commands: [], agents: [], output_style: "default", available_output_styles: [], account: {},
          models: [
            { value: "default", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: efforts },
            { value: "claude-haiku-4-5", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
            ...["claude-sonnet-5", "claude-opus-5", "claude-fable-5"].map((model) => ({
              value: model, supportsEffort: true, supportedEffortLevels: efforts,
            })),
          ],
        },
      },
    }) + "\\n");
    return new Promise(() => {});
  }
  if (args[0] !== "-p") throw new Error("unexpected args " + JSON.stringify(args));
  const initial = await firstEvent();
  const prompt = textOf(initial);
  const resume = value("--resume");
  const agents = value("--agents") ? JSON.parse(value("--agents")) : null;
  const token = (prompt.match(/session=([a-z0-9_-]+)/i) || [])[1] || "default";
  // Test-only fixture switch: a resumed turn that must observe a foreign
  // native session id instead of the one it was asked to resume, to drive the
  // supervisor's own protocol_session_drift detection.
  const drift = /drift=1/.test(prompt);
  const sessionId = drift ? "fake-session-drifted-" + token : (resume || "fake-session-" + token);
  appendInvocation({
    args, prompt, sessionId,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      CONDA_EXE: process.env.CONDA_EXE,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      IS_SANDBOX: process.env.IS_SANDBOX,
      CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: process.env.CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT,
    },
  });
  process.stdout.write(JSON.stringify({
    type: "system", subtype: "init", session_id: sessionId,
    claude_code_version: "2.1.220", model: value("--model"),
    ...(agents ? { tools: teamTools, agents } : {}),
  }) + "\\n");
  // Test-only fixture switch: fail the turn itself (after session
  // establishment) with stderr text that Claude's own failure classifier
  // recognizes, to drive a Harness-scoped turn failure without a real Claude
  // account.
  const failMode = (prompt.match(/fail=(auth|account_limit|transport)/) || [])[1];
  if (failMode && failMode !== "transport") {
    process.stderr.write(failMode === "auth"
      ? "Error: unauthorized. Please re-authenticate.\\n"
      : "Error: You've hit your session limit. Your limit will reset at 8pm.\\n");
    process.exit(1);
  }
  if (agents) {
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use", id: "fixture-team-spawn", name: "Agent",
        input: { name: "fixture-scout", subagent_type: "haiku-scout" },
      }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "fixture-team-spawn" }] },
      tool_use_result: { status: "async_launched", agentId: "fixture-team-agent" },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use", id: "fixture-team-message", name: "SendMessage",
        input: { recipient: "fixture-scout", message: "opaque" },
      }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "fixture-team-message" }] },
      tool_use_result: { success: true },
    }) + "\\n");
  }
  if (failMode === "transport") {
    process.stderr.write("Error: Connection closed mid-response.\\n");
    process.exit(1);
  }
  process.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const text = textOf(event);
        if (text) process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } }) + "\\n");
      } catch {}
    }
  });
  process.on("SIGINT", () => process.exit(130));
  const delay = Number((prompt.match(/delay=(\\d+)/) || [])[1] || 80);
  process.stdout.write(JSON.stringify({
    type: "stream_event", session_id: sessionId,
    event: { delta: { type: "text_delta", text: "completed:" + prompt } },
  }) + "\\n");
  await sleep(delay);
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id: sessionId, result: "completed:" + prompt,
    duration_ms: 8, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0.002,
    usage: {
      input_tokens: 3, output_tokens: 2,
      cache_creation_input_tokens: 1, cache_read_input_tokens: 0,
      service_tier: "must-not-project",
    },
    modelUsage: { private: "must-not-project" },
  }) + "\\n");
}
main().catch((error) => { process.stderr.write(error.stack + "\\n"); process.exitCode = 1; });
`, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function fixture(ownerRootId = "owner-1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-cli-"));
  cleanups.push(dir);
  const workspace = path.join(dir, "workspace");
  const codexHome = path.join(dir, ".codex");
  const runtimeHome = path.join(dir, "runtime-home");
  const claude = path.join(dir, "claude");
  const invocation = path.join(dir, "invocations.jsonl");
  fs.mkdirSync(workspace);
  fs.mkdirSync(codexHome);
  fakeClaude(claude);
  const envFile = path.join(codexHome, ".env");
  fs.writeFileSync(envFile, [
    `CLAUDE_CONFIG_DIR=${path.join(dir, ".claude")}`,
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=0",
    "CONDA_EXE=/opt/conda/bin/conda",
    "HTTP_PROXY=http://127.0.0.1:9090",
    "HTTPS_PROXY=http://127.0.0.1:9090",
    "NO_PROXY=127.0.0.1,localhost",
    `CODEX_HARNESSDOCK_CLAUDE_BIN=${claude}`,
    `CODEX_HARNESSDOCK_RUNTIME_CHECKOUT=${root}`,
    "",
  ].join("\n"));
  const inheritedEnv = { ...process.env };
  // A CC-bootstrapped parent exports its own trusted root and native config
  // dir ambiently. The fixture owns a fresh logical root and claudeConfigDir
  // and must not let that ambient identity override the explicit
  // CODEX_THREAD_ID and CLAUDE_CONFIG_DIR set below.
  delete inheritedEnv.CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID;
  delete inheritedEnv.CLAUDE_NATIVE_CONFIG_DIR;
  return {
    workspace,
    invocation,
    envFile,
    env: {
      ...inheritedEnv,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: ownerRootId,
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
      CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFile,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CODEX_HARNESSDOCK_FAKE_INVOCATION_FILE: invocation,
    },
  };
}

function command(test, args, options = {}) {
  return spawnSync(process.execPath, [...(options.nodeArgs ?? []), options.program ?? cli, ...args], {
    cwd: test.workspace,
    env: options.env ?? test.env,
    encoding: "utf8",
    timeout: options.timeout ?? 15_000,
  });
}

function run(test, args, options = {}) {
  const result = command(test, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runAsync(test, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.program ?? cli, ...args], {
      cwd: test.workspace,
      env: options.env ?? test.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

function list(test, options = {}) {
  return run(test, ["list_agents", "--json"], options);
}

function agent(test, target, options = {}) {
  const environment = options.env ?? test.env;
  const workspaceHash = createHash("sha256")
    .update(fs.realpathSync.native(test.workspace))
    .digest("hex")
    .slice(0, 16);
  const rootHash = createHash("sha256")
    .update(environment.CODEX_THREAD_ID)
    .digest("hex")
    .slice(0, 32);
  const registryFile = path.join(
    environment.CODEX_HARNESSDOCK_RUNTIME_HOME,
    "state",
    workspaceHash,
    "agent-registry",
    "roots",
    rootHash,
    "registry.json",
  );
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const selected = Object.values(registry.agents).find((item) =>
    [item.agentId, item.path, item.name].includes(target)
  );
  assert.ok(selected, `expected Agent ${target}`);
  return selected;
}

function reconcileAgentState(test, options = {}) {
  const environment = options.env ?? test.env;
  const moduleUrl = new URL("../../runtime/agent-runtime.mjs", import.meta.url).href;
  const source = [
    `import { createAgentRuntime } from ${JSON.stringify(moduleUrl)};`,
    "const [cwd, envFile] = process.argv.slice(1);",
    "createAgentRuntime({ cwd, envFile, env: process.env }).reconcile();",
  ].join("\n");
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    source,
    test.workspace,
    test.envFile,
  ], {
    cwd: test.workspace,
    env: environment,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function waitForAgent(test, target, predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let latest = null;
  let lastReconcileAt = 0;
  while (Date.now() < deadline) {
    // Tests that need durable lifecycle repair invoke that owner explicitly;
    // public list_agents is intentionally observation-only.
    if (Date.now() - lastReconcileAt >= 200) {
      reconcileAgentState(test, options);
      lastReconcileAt = Date.now();
    }
    const current = agent(test, target, options);
    latest = current;
    if (predicate(current)) return current;
    waitMs(40);
  }
  throw new Error(`Timed out waiting for Agent ${target}: ${JSON.stringify(latest)}`);
}

function waitForJob(test, jobId, predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const current = readInternalJob(test, jobId);
    if (current && predicate(current)) return current;
    waitMs(40);
  }
  throw new Error(`Timed out waiting for internal Agent job ${jobId}`);
}

function readInternalJob(test, jobId) {
  const canonicalWorkspace = fs.realpathSync.native(test.workspace);
  const workspaceHash = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 12);
  const jobFile = path.join(test.env.CODEX_HARNESSDOCK_RUNTIME_HOME, "state", workspaceHash, "jobs", `${jobId}.json`);
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null;
  }
}

function invocations(test) {
  if (!fs.existsSync(test.invocation)) return [];
  return fs.readFileSync(test.invocation, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeNativeTranscript(test, sessionId, records) {
  const claudeConfigDir = path.join(path.dirname(test.workspace), ".claude");
  const encodedWorkspace = test.workspace.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = path.join(claudeConfigDir, "projects", encodedWorkspace);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify({ sessionId, ...record })).join("\n")}\n`,
    "utf8",
  );
}

describe("canonical Agent runtime CLI", () => {
  it("launches Haiku with its canonical model and explicit low effort", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "haiku_smoke",
      "--model", "claude-haiku-4-5", "--reasoning-effort", "low", "--json", "session=haiku delay=40",
    ]);
    assert.deepEqual(Object.keys(spawned).sort(), [
      "agent_name", "authority", "delegation_mode", "elapsed_seconds", "harness",
      "last_activity_at", "model", "phase", "reasoning_effort", "route_maturity", "started_at", "status",
    ]);
    assert.equal(spawned.agent_name, "/root/haiku_smoke");
    assert.equal(spawned.model, "claude-haiku-4-5");
    assert.match(spawned.status, /^(starting|working)$/);
    waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const invocation = invocations(test)[0];
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-haiku-4-5");
    assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "low");
    assert.deepEqual(
      invocation.args.flatMap((value, index) => value === "--disallowedTools" ? [invocation.args[index + 1]] : []),
      LEAF_DENIED_TOOLS,
    );
    assert.equal(invocation.args.includes("--dangerously-skip-permissions"), true);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /Act as a leaf/i);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /read(?: and|\/)review only/i);

    // Every prepared turn records the Driver contract that launched it, so a
    // later recovery is judged against the same accepted capabilities.
    const record = agent(test, spawned.agent_name);
    const launched = readInternalJob(test, record.latestJobId);
    assert.equal(launched.harnessStateVersion, 2);
    assert.equal(launched.harnessId, "claude-code");
    assert.equal(launched.driverVersion, "claude-code@2");
    assert.equal(launched.harnessCapabilities.continuation, "exact_resume");
    assert.equal(launched.harnessCapabilities.authorityEnforcement, "prompt_only");
    assert.deepEqual(launched.harnessRoute, {
      harnessId: "claude-code",
      model: "claude-haiku-4-5",
      effort: "low",
      delegationMode: "leaf",
      write: false,
    });
    assert.equal(launched.harnessInstanceKey, path.join(path.dirname(test.workspace), ".claude"));
  });

  it("launches Fable with canonical model and explicit max effort", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--write=false", "--task-name", "fable_smoke",
      "--model", "claude-fable-5", "--reasoning-effort", "max",
      "--topology", "native_orchestrator", "--json", "session=fable delay=40",
    ]);
    assert.deepEqual(Object.keys(spawned).sort(), [
      "agent_name", "authority", "delegation_mode", "elapsed_seconds", "harness",
      "last_activity_at", "model", "phase", "reasoning_effort", "route_maturity", "started_at", "status",
    ]);
    assert.equal(spawned.agent_name, "/root/fable_smoke");
    assert.equal(spawned.model, "claude-fable-5");
    assert.match(spawned.status, /^(starting|working)$/);
    const firstTurn = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const invocation = invocations(test)[0];
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-fable-5");
    assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "max");
    assert.deepEqual(
      invocation.args.flatMap((value, index) => value === "--disallowedTools" ? [invocation.args[index + 1]] : []),
      COMMON_DENIED_TOOLS,
    );
    assert.equal(invocation.args.includes("--dangerously-skip-permissions"), true);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /Wait for required teammate outcomes/i);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /read(?: and|\/)review only/i);

    const followed = run(test, [
      "followup_task", spawned.agent_name, "--json", "fable exact-session follow-up delay=40",
    ]);
    assert.deepEqual(followed, {
      agent_name: spawned.agent_name,
      delivery: "new_turn",
    });
    const completed = waitForAgent(
      test,
      spawned.agent_name,
      (value) => value.status === "completed" && value.latestJobId !== firstTurn.latestJobId,
    );
    // A version-three Agent states its immutable topology; `delegationMode` is
    // the version-one supervisor's own vocabulary and lives on the job.
    assert.equal(completed.route.topology, "native_orchestrator");
    const followupJob = readInternalJob(test, completed.latestJobId);
    assert.equal(followupJob.request.delegationMode, "claude_orchestrator");
    const followupInvocation = invocations(test)[1];
    assert.equal(
      followupInvocation.args[followupInvocation.args.indexOf("--resume") + 1],
      "fake-session-fable",
    );
    assert.deepEqual(
      followupInvocation.args.flatMap((value, index) => value === "--disallowedTools" ? [followupInvocation.args[index + 1]] : []),
      COMMON_DENIED_TOOLS,
    );
    assert.equal(followupInvocation.args.includes("--dangerously-skip-permissions"), true);
    assert.match(
      followupInvocation.args[followupInvocation.args.indexOf("--append-system-prompt") + 1],
      /Wait for required teammate outcomes/i,
    );
    assert.match(
      followupInvocation.args[followupInvocation.args.indexOf("--append-system-prompt") + 1],
      /read(?: and|\/)review only/i,
    );
    const firstCohort = invocation.args[invocation.args.indexOf("--append-system-prompt") + 1]
      .match(/hd-native-team-[a-f0-9]+/)[0];
    const followupCohort = followupInvocation.args[followupInvocation.args.indexOf("--append-system-prompt") + 1]
      .match(/hd-native-team-[a-f0-9]+/)[0];
    assert.notEqual(firstCohort, followupCohort);
  });

  it("keeps the durable parent session after a team transport close but starts a fresh follow-up team", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--write=false", "--task-name", "transport_team",
      "--model", "claude-opus-5", "--reasoning-effort", "high", "--topology", "native_orchestrator", "--json",
      "session=team-close fail=transport",
    ]);
    const closed = waitForAgent(test, spawned.agent_name, (value) => value.status === "errored");
    const closedJob = readInternalJob(test, closed.latestJobId);
    assert.equal(closed.continuation.mode, "exact_session");
    assert.equal(closed.nativeSessionRef.nativeSessionId, "fake-session-team-close");
    assert.equal(closedJob.result.failureClass, "transport_closed_resumable");
    assert.equal(closedJob.result.recoveryAttempts, 0);
    assert.equal(invocations(test).length, 1);

    const followed = run(test, [
      "followup_task", spawned.agent_name, "--json", "session=team-recovered delay=40",
    ]);
    assert.equal(followed.delivery, "new_turn");
    const recovered = waitForAgent(
      test,
      spawned.agent_name,
      (value) => value.status === "completed" && value.latestJobId !== closed.latestJobId,
    );
    const recorded = invocations(test);
    const firstPrompt = recorded[0].args[recorded[0].args.indexOf("--append-system-prompt") + 1];
    const secondPrompt = recorded[1].args[recorded[1].args.indexOf("--append-system-prompt") + 1];
    assert.equal(recovered.agentId, closed.agentId);
    assert.equal(recorded[1].args[recorded[1].args.indexOf("--resume") + 1], "fake-session-team-close");
    assert.notEqual(
      firstPrompt.match(/hd-native-team-[a-f0-9]+/)[0],
      secondPrompt.match(/hd-native-team-[a-f0-9]+/)[0],
    );
    assert.deepEqual(Object.keys(JSON.parse(recorded[1].args[recorded[1].args.indexOf("--agents") + 1])), [
      "haiku-scout", "opus", "sonnet",
    ]);
  });

  it("exposes all seven operations with flat exact targeting and duplicate-name rejection", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "alpha", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=alpha delay=700",
    ]);
    assert.deepEqual(Object.keys(spawned).sort(), [
      "agent_name", "authority", "delegation_mode", "elapsed_seconds", "harness",
      "last_activity_at", "model", "phase", "reasoning_effort", "route_maturity", "started_at", "status",
    ]);
    assert.equal(spawned.agent_name, "/root/alpha");
    assert.equal(spawned.model, "claude-sonnet-5");
    assert.match(spawned.status, /^(starting|working)$/);
    assert.throws(
      () => run(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "alpha", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "duplicate"]),
      /already belongs/
    );
    const selected = agent(test, "/root/alpha");
    assert.equal(selected.path, spawned.agent_name);
    const prefix = command(test, ["send_message", "/root/al", "not exact", "--json"]);
    assert.equal(prefix.status, 1);
    assert.match(prefix.stderr, /No Agent with that exact ID, path, or name/);
    assert.throws(
      () => run(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "forked", "--reasoning-effort", "high", "--fork-turns", "all", "--json", "forbidden"]),
      /Unknown option --fork-turns/
    );
  });

  it("keeps Agent roots isolated while operator all-agents remains explicit and read-only", () => {
    const test = fixture("root-a");
    const alpha = run(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "alpha", "--model", "claude-opus-5", "--reasoning-effort", "high", "--json", "session=alpha delay=50"]);
    waitForAgent(test, alpha.agent_name, (value) => value.status === "completed");
    const foreignEnv = { ...test.env, CODEX_THREAD_ID: "root-b" };
    assert.deepEqual(list(test, { env: foreignEnv }).agents, []);
    const foreign = command(test, ["send_message", alpha.agent_name, "foreign", "--json"], { env: foreignEnv });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /No Agent with that exact ID, path, or name/);
    const beta = run(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "beta", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=beta delay=50"], { env: foreignEnv });
    waitForAgent(test, beta.agent_name, (value) => value.status === "completed", { env: foreignEnv });

    const operator = run(test, [
      "list-agents", "--all", "--cwd", test.workspace,
      "--env-file", test.envFile, "--json",
    ], {
      program: operatorCli,
      env: foreignEnv,
    });
    assert.equal(operator.operatorMode, true);
    assert.equal(operator.readOnly, true);
    assert.equal(operator.agents.length, 2);
    assert.ok(operator.agents.every((value) => value.rootHash && value.claudeSessionId === undefined));
  });

  it("runs two Agents concurrently and leaves their terminal histories nonresident", async () => {
    const test = fixture();
    const launches = await Promise.all([
      runAsync(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "agent_a", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=a delay=500"]),
      runAsync(test, ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "agent_b", "--model", "claude-opus-5", "--reasoning-effort", "high", "--json", "session=b delay=500"]),
    ]);
    assert.deepEqual(launches.map((entry) => entry.status).sort(), [0, 0]);
    const agents = launches.map((entry) => JSON.parse(entry.stdout));
    for (const entry of agents) waitForAgent(test, entry.agent_name, (value) => value.status === "completed");
    const listed = list(test);
    assert.equal(listed.agents.length, 2);
    assert.ok(listed.agents.every((value) => value.agent_status === "completed"));
    assert.deepEqual(
      new Set(invocations(test).map((value) => value.sessionId)),
      new Set(["fake-session-a", "fake-session-b"])
    );
  });

  it("durably dispatches an active send_message and records acknowledgement", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "active", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=active delay=1000",
    ]);
    const stored = agent(test, spawned.agent_name);
    const started = waitForJob(test, stored.activeJobId, (value) => value.status === "running" && Boolean(value.pid));
    assert.equal(started.agentId, stored.agentId);
    const sent = run(test, ["send_message", spawned.agent_name, "steer exactly once", "--json"]);
    assert.deepEqual(sent, {
      agent_name: spawned.agent_name,
      delivery: "dispatched_active",
    });
    assert.equal(JSON.stringify(sent).includes("steer exactly once"), false);
    const finished = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    assert.ok(finished.mailbox.messages.filter((message) => message.state === "acknowledged").length >= 1);
    assert.equal(finished.mailbox.messages.some((message) => message.state === "dispatched"), false);
  });

  it("queues an idle message and assigns it to an exact-session follow-up", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "resume", "--model", "claude-opus-5", "--reasoning-effort", "high", "--json", "session=resume delay=60",
    ]);
    const terminal = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    assert.equal(terminal.continuation.mode, "exact_session");
    // A new-generation Claude Agent holds the version-three identity plane; its
    // TURNS still settle through the version-one supervisor, which is what the
    // exact-session continuation above proves.
    assert.equal(terminal.version, 3);
    assert.equal(terminal.route.harnessId, "claude-code");
    assert.deepEqual(terminal.nativeSessionRef, {
      harnessId: "claude-code",
      // The version-three instance identity is the redacted key, never the raw
      // configuration path the version-two record carried.
      instanceKey: claudeCodeInstanceKey(path.join(path.dirname(test.workspace), ".claude")),
      nativeSessionId: "fake-session-resume",
    });
    const queued = run(test, ["send_message", terminal.path, "queued before follow-up", "--json"]);
    assert.deepEqual(queued, {
      agent_name: terminal.path,
      delivery: "queued_no_turn",
    });
    const beforeFollowup = agent(test, terminal.path);
    assert.equal(beforeFollowup.mailbox.messages.filter((message) => message.state === "queued").length, 1);

    const followup = run(test, ["followup_task", terminal.path, "session=resume follow-up", "--json"]);
    assert.deepEqual(followup, {
      agent_name: terminal.path,
      delivery: "new_turn",
    });
    waitForAgent(
      test,
      terminal.path,
      (value) => value.status === "completed" && value.latestJobId !== terminal.latestJobId,
    );
    const recorded = invocations(test);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].args[recorded[0].args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(recorded[0].args[recorded[0].args.indexOf("--name") + 1], "resume");
    assert.equal(recorded[1].args.includes("--resume"), true);
    assert.equal(recorded[1].args[recorded[1].args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(recorded[1].args.includes("--name"), false);
    assert.equal(recorded[1].args[recorded[1].args.indexOf("--resume") + 1], "fake-session-resume");
    assert.match(recorded[1].prompt, /queued before follow-up/);
    assert.match(recorded[1].prompt, /session=resume follow-up/);
  });

  it("reads complete paginated outer-assistant history from the bound native session", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "history",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=history delay=40",
    ]);
    const terminal = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const before = fs.readFileSync(
      path.join(
        test.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
        "state",
        createHash("sha256").update(fs.realpathSync.native(test.workspace)).digest("hex").slice(0, 16),
        "agent-registry",
        "roots",
        createHash("sha256").update(test.env.CODEX_THREAD_ID).digest("hex").slice(0, 32),
        "registry.json",
      ),
      "utf8",
    );
    const longMessage = `${"界".repeat(24_000)}-complete-tail`;
    writeNativeTranscript(test, terminal.nativeSessionRef.nativeSessionId, [
      {
        type: "assistant",
        uuid: "old-message",
        timestamp: "2026-07-27T00:00:00.000Z",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: "older" }] },
      },
      {
        type: "assistant",
        uuid: "private-thinking",
        timestamp: "2026-07-27T00:00:01.000Z",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
      },
      {
        type: "assistant",
        uuid: "new-message",
        timestamp: "2026-07-27T00:00:02.000Z",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: longMessage },
            { type: "tool_use", name: "Bash", input: { command: "private" } },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "sidechain",
        timestamp: "2026-07-27T00:00:03.000Z",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "private-sidechain" }] },
      },
    ]);

    const latest = run(test, ["read_agent_messages", terminal.path, "--json"]);
    assert.deepEqual(latest.messages, [{
      message_id: "new-message",
      timestamp: "2026-07-27T00:00:02.000Z",
      text: longMessage,
    }]);
    assert.equal(latest.next_before, "new-message");
    assert.ok(Buffer.byteLength(latest.messages[0].text, "utf8") > 64 * 1024);

    const older = run(test, [
      "read_agent_messages", terminal.path,
      "--before", latest.next_before,
      "--limit", "2",
      "--json",
    ]);
    assert.deepEqual(older.messages.map((message) => message.message_id), ["old-message"]);
    assert.equal(older.next_before, null);
    assert.equal(JSON.stringify(older).includes("private"), false);

    const after = fs.readFileSync(
      path.join(
        test.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
        "state",
        createHash("sha256").update(fs.realpathSync.native(test.workspace)).digest("hex").slice(0, 16),
        "agent-registry",
        "roots",
        createHash("sha256").update(test.env.CODEX_THREAD_ID).digest("hex").slice(0, 32),
        "registry.json",
      ),
      "utf8",
    );
    assert.equal(after, before);
  });

  it("keeps list and wait completion delivery unread until a later acknowledgement", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "delivery", "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=delivery delay=60",
    ]);
    waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const firstList = list(test);
    const secondList = list(test);
    assert.deepEqual(firstList, secondList);
    assert.equal(firstList.agents.length, 1);
    assert.deepEqual({
      agent_name: firstList.agents[0].agent_name,
      agent_status: firstList.agents[0].agent_status,
      harness: firstList.agents[0].harness,
      route_maturity: firstList.agents[0].route_maturity,
      model: firstList.agents[0].model,
      reasoning_effort: firstList.agents[0].reasoning_effort,
      authority: firstList.agents[0].authority,
      delegation_mode: firstList.agents[0].delegation_mode,
      phase: firstList.agents[0].phase,
    }, {
      agent_name: spawned.agent_name,
      agent_status: "completed",
      harness: "claude-code",
      route_maturity: "experimental",
      model: "claude-sonnet-5",
      reasoning_effort: "high",
      authority: "behavioral_read_only",
      delegation_mode: "leaf",
      phase: "responding",
    });
    assert.match(firstList.agents[0].started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(firstList.agents[0].last_activity_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isSafeInteger(firstList.agents[0].elapsed_seconds), true);
    assert.equal(JSON.stringify(firstList).includes("completionInbox"), false);

    const firstWait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(firstWait.timedOut, false);
    assert.equal(firstWait.update.kind, "completion");
    assert.equal(firstWait.update.agent_name, spawned.agent_name);
    assert.ok(firstWait.update.delivery_token);
    assert.match(firstWait.update.completion_message, /^completed:session=delivery/);
    assert.equal(firstWait.update.completion_message_truncated, false);
    assert.deepEqual(firstWait.update.metrics, {
      version: 1,
      provider_reported: {
        duration_ms: 8,
        duration_api_ms: 5,
        turn_count: 1,
        input_tokens: 3,
        output_tokens: 2,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 0,
        reported_cost_usd: 0.002,
      },
      plugin_observed: {
        tool_call_count: 0,
        attempt_count: 1,
        recovery_attempt_count: 0,
      },
    });
    assert.equal(JSON.stringify(firstWait.update).includes("service_tier"), false);
    assert.equal(JSON.stringify(firstWait.update).includes("modelUsage"), false);
    const redelivered = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.deepEqual(redelivered, firstWait);
    const secondWait = run(test, [
      "wait_agent", "--timeout-ms", "0", "--acknowledge-tokens", firstWait.update.delivery_token, "--json",
    ]);
    assert.equal(secondWait.timedOut, true);
    assert.equal(secondWait.update, undefined);
    assert.deepEqual(list(test), firstList);
  });

  it("reports safe stream progress before the complete completion message", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "progress_stream",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=progress-stream delay=2000",
    ]);
    const progressAgent = agent(test, spawned.agent_name);
    waitForJob(test, progressAgent.activeJobId, (value) => Number(value.publicProgress?.revision ?? 0) >= 2);

    const completionFirst = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.deepEqual(completionFirst, {
      message: "Timed out waiting for HarnessDock Agent activity.",
      timedOut: true,
    });

    const progress = run(test, [
      "wait_agent", "--timeout-ms", "0", "--wake-on-progress", "--json",
    ]);
    assert.equal(progress.timedOut, false);
    assert.deepEqual(progress.update, {
      kind: "progress",
      agent_name: spawned.agent_name,
      agent_status: "working",
      progress: {
        revision: 2,
        activity: "responding",
        phase: "running",
        summary: "Claude is drafting its response.",
        updated_at: progress.update.progress.updated_at,
      },
    });
    assert.equal(JSON.stringify(progress).includes("session=progress-stream"), false);

    const completion = run(test, ["wait_agent", "--timeout-ms", "5000", "--json"], { timeout: 10_000 });
    assert.equal(completion.update.kind, "completion");
    assert.match(completion.update.completion_message, /^completed:session=progress-stream/);
  });

  it("interrupts only a running Agent turn and keeps the logical Agent record", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "interruptible", "--model", "claude-opus-5", "--reasoning-effort", "high", "--json", "session=interrupt delay=5000",
    ]);
    const stored = agent(test, spawned.agent_name);
    waitForJob(test, stored.activeJobId, (value) => value.status === "running" && Boolean(value.pid));
    const receipt = run(test, ["interrupt_agent", spawned.agent_name, "--json"], { timeout: 12_000 });
    assert.deepEqual(receipt, {
      agent_name: spawned.agent_name,
      status: "interrupted",
    });
    const terminal = waitForAgent(
      test,
      spawned.agent_name,
      (value) => ["interrupted", "errored"].includes(value.status),
      { timeoutMs: 12_000 }
    );
    assert.equal(terminal.agentId, stored.agentId);
    assert.equal(terminal.activeJobId, null);
  });

  it("rejects removed lifecycle commands and model-facing all/session overrides", () => {
    const test = fixture();
    for (const legacy of ["start", "run", "steer", "status", "result", "follow-up", "cancel", "cancel_job"]) {
      const result = command(test, [legacy, "--json"]);
      assert.equal(result.status, 1, legacy);
      assert.match(result.stderr, /Unknown or removed command/);
    }
    for (const args of [
      ["list_agents", "--all", "--json"],
      ["list_agents", "--cwd", path.dirname(test.workspace), "--json"],
      ["list_agents", "-C", path.dirname(test.workspace), "--json"],
      ["list_agents", "--env-file", test.envFile, "--json"],
      ["list_agents", `--cwd ${path.dirname(test.workspace)} --json`],
      ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "forbidden", "--resume-session", "x", "--json", "x"],
      ["spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "forbidden_tools", "--allowed-tools", "Bash", "--json", "x"],
      ["wait_agent", "/root/not-allowed", "--json"],
      ["read_agent_messages", "/root/not-allowed", "--session-id", "foreign", "--json"],
      ["read_agent_messages", "/root/not-allowed", "--owner-root-id", "foreign", "--json"],
      ["read_agent_messages", "/root/not-allowed", "--all", "--json"],
      ["read_agent_messages", "/root/not-allowed", "--transcript-path", "/tmp/foreign.jsonl", "--json"],
    ]) {
      const result = command(test, args);
      assert.equal(result.status, 1, args.join(" "));
      assert.match(result.stderr, /Unsupported model-facing option|Unknown option|root-scoped/);
    }

    const swallowedUnknown = command(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false",
      "--task-name", "must_not_exist",
      "--message", "--claude-session-id", "foreign",
      "--json",
    ]);
    assert.equal(swallowedUnknown.status, 1);
    assert.match(swallowedUnknown.stderr, /Missing value for --message/);
    assert.deepEqual(list(test).agents, []);

    const unsupportedModel = command(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false",
      "--task-name", "unsupported_model",
      "--model", "fable-5", "--reasoning-effort", "high",
      "--json", "must fail before Claude starts",
    ]);
    assert.equal(unsupportedModel.status, 1);
    assert.match(unsupportedModel.stderr, /exact discovered full model/);

    for (const unsupported of ["haiku-4-5", "claude-haiku-4-5-20251001"]) {
      const rejected = command(test, [
        "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false",
        "--task-name", `unsupported_${unsupported.replaceAll("-", "_")}`,
        "--model", unsupported, "--reasoning-effort", "high",
        "--json", "dated or partial IDs are not public inputs",
      ]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /exact discovered full model/);
    }

    const missingModel = command(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "missing_model", "--reasoning-effort", "high", "--json", "must fail before Claude starts",
    ]);
    assert.equal(missingModel.status, 1);
    assert.match(missingModel.stderr, /model must be non-empty text/);
    assert.deepEqual(list(test).agents, []);
    assert.deepEqual(invocations(test), []);
  });

  it("preserves full-access terminal-parity environment and delegates a copied bootstrap to the checkout", (testContext) => {
    const test = fixture();
    const canonicalManifest = path.join(
      "/data/CoordExp/codex-harnessdock",
      "plugins",
      "codex-harnessdock",
      ".codex-plugin",
      "plugin.json",
    );
    const canonicalPlugin = fs.existsSync(canonicalManifest)
      ? JSON.parse(fs.readFileSync(canonicalManifest, "utf8"))
      : null;
    if (canonicalPlugin?.name !== "codex-harnessdock") {
      // The candidate is intentionally uninstalled, and between the source
      // rename and the operator relocation the live path does not exist at
      // all. The fixed production bootstrap must fail closed either way and
      // name the checkout it could not validate.
      const rejected = command(test, ["list_agents", "--json"], { program: bootstrap });
      assert.equal(rejected.status, 1);
      const output = `${rejected.stderr}\n${rejected.stdout}`;
      assert.match(output, /Fixed HarnessDock runtime checkout is (invalid|unavailable)|Unexpected plugin identity/i);
      assert.match(output, /\/data\/CoordExp\/codex-harnessdock/);
      return;
    }
    const candidateManifest = path.join(root, "plugins", "codex-harnessdock", ".codex-plugin", "plugin.json");
    const candidatePlugin = JSON.parse(fs.readFileSync(candidateManifest, "utf8"));
    if (canonicalPlugin.version !== candidatePlugin.version) {
      testContext.skip("canonical Plugin has not been promoted to the candidate version");
      return;
    }
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "parity", "--model", "claude-opus-5", "--reasoning-effort", "high",
      "--json", "session=parity delay=60",
    ]);
    waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const invocation = invocations(test)[0];
    for (const flag of ["--settings", "--permission-mode", "--allowedTools", "--strict-mcp-config"]) {
      assert.equal(invocation.args.includes(flag), false, flag);
    }
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
    assert.equal(invocation.args.includes("--dangerously-skip-permissions"), true);
    assert.deepEqual(
      invocation.args.flatMap((value, index) => value === "--disallowedTools" ? [invocation.args[index + 1]] : []),
      LEAF_DENIED_TOOLS,
    );
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /bounded Claude Agent/i);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /read(?: and|\/)review only/i);
    assert.match(invocation.args[invocation.args.indexOf("--append-system-prompt") + 1], /blocked on a lead\/user decision/i);
    assert.equal(invocation.args.includes("--system-prompt"), false);
    assert.equal(invocation.args[invocation.args.indexOf("--name") + 1], "parity");
    assert.equal(invocation.env.CLAUDE_CONFIG_DIR, path.join(path.dirname(test.workspace), ".claude"));
    assert.equal(invocation.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "0");
    assert.equal(invocation.env.CONDA_EXE, undefined);
    assert.equal(invocation.env.HTTP_PROXY, "http://127.0.0.1:9090");
    assert.equal(invocation.env.HTTPS_PROXY, "http://127.0.0.1:9090");
    assert.equal(invocation.env.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(invocation.env.IS_SANDBOX, "1");
    assert.equal(invocation.env.CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT, root);

    const fakeCache = path.join(path.dirname(test.workspace), "fake-cache", "cc", "0.1.0");
    const fakeBootstrap = path.join(fakeCache, "bootstrap", "harnessdock-runtime.mjs");
    const poisonMarker = path.join(fakeCache, "poison-ran");
    fs.mkdirSync(path.dirname(fakeBootstrap), { recursive: true });
    fs.copyFileSync(bootstrap, fakeBootstrap);
    fs.copyFileSync(
      path.join(path.dirname(bootstrap), "dependency-preflight.mjs"),
      path.join(path.dirname(fakeBootstrap), "dependency-preflight.mjs"),
    );
    fs.mkdirSync(path.join(fakeCache, "runtime"));
    fs.writeFileSync(path.join(fakeCache, "runtime", "cli.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(poisonMarker)}, "bad");\n`);
    const poisonEnv = path.join(fakeCache, "poison.env");
    fs.writeFileSync(poisonEnv, "not valid dotenv syntax\n");
    const delegated = command(test, ["list_agents", "--json"], {
      program: fakeBootstrap,
      nodeArgs: ["--"],
      env: {
        ...test.env,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: fakeCache,
        CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: poisonEnv,
        CLAUDE_NATIVE_CONFIG_DIR: "/poison/native-claude",
        CLAUDE_CONFIG_DIR: "/poison/claude",
      },
    });
    if (delegated.status !== 0) {
      // This migration writes capability-schema v4; an unrefreshed canonical
      // checkout still on v3 must fail closed rather than reinterpret it.
      assert.match(`${delegated.stderr}\n${delegated.stdout}`, /capability schema version 4; this runtime requires 3/);
      assert.equal(fs.existsSync(poisonMarker), false);
      return;
    }
    const stableAgents = (receipt) => receipt.agents.map((entry) => ({
      agent_name: entry.agent_name,
      agent_status: entry.agent_status,
      model: entry.model,
      delegation_mode: entry.delegation_mode,
    }));
    assert.deepEqual(stableAgents(JSON.parse(delegated.stdout)), stableAgents(list(test)));
    assert.equal(fs.existsSync(poisonMarker), false);

    for (const args of [
      ["list_agents", "--cwd", path.dirname(test.workspace), "--json"],
      ["list_agents", "-C", path.dirname(test.workspace), "--json"],
      ["list_agents", "--env-file", test.envFile, "--json"],
      ["list_agents", "--env-file", path.join(fakeCache, "missing.env"), "--json"],
      ["list_agents", `--env-file ${test.envFile} --json`],
    ]) {
      const rejected = command(test, args, { program: fakeBootstrap, nodeArgs: ["--"] });
      assert.equal(rejected.status, 1, args.join(" "));
      assert.match(rejected.stderr, /Unsupported model-facing option/);
    }
  });

  it("always adds dangerous bypass while a follow-up inherits the frozen behavioral authority", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--task-name", "write_parity",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--write=false", "--json", "session=write-parity delay=40",
    ]);
    const terminal = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    // The authority is frozen at creation: a follow-up that tries to state one
    // is refused by the public surface, which no longer publishes the field.
    const restated = command(test, [
      "followup_task", terminal.path, "--write=true", "session=write-parity follow-up", "--json",
    ]);
    assert.equal(restated.status, 1);
    assert.match(restated.stderr, /Unknown option --write/);
    const followup = run(test, [
      "followup_task", terminal.path, "session=write-parity follow-up", "--json",
    ]);
    waitForAgent(
      test,
      terminal.path,
      (value) => value.status === "completed" && value.latestJobId !== terminal.latestJobId,
    );
    const recorded = invocations(test);
    assert.equal(recorded.length, 2);
    assert.equal(recorded[0].args.includes("--dangerously-skip-permissions"), true);
    assert.equal(recorded[1].args.includes("--dangerously-skip-permissions"), true);
    // Both turns carry the same inherited read-only authority.
    for (const invocation of recorded) {
      assert.match(
        invocation.args[invocation.args.indexOf("--append-system-prompt") + 1],
        /read(?: and|\/)review only/i,
      );
    }

    const rejected = command(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "contradictory",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--dangerously-skip-permissions", "--json", "must fail",
    ]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unknown option --dangerously-skip-permissions/);
  });

  it("delivers an auth-loss wait receipt as a Harness-scoped operator-required block", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "auth_loss",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "fail=auth",
    ]);
    waitForAgent(test, spawned.agent_name, (value) => value.status === "errored");
    const wait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(wait.timedOut, false);
    assert.equal(wait.update.agent_name, spawned.agent_name);
    assert.equal(wait.update.agent_status, "failed");
    assert.deepEqual(wait.update.blocking, {
      reason: "auth_required", scope: "harness", retry: "operator_required",
    });
  });

  it("delivers an account-limit wait receipt as a Harness-scoped operator-required block", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "account_limit",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "fail=account_limit",
    ]);
    waitForAgent(test, spawned.agent_name, (value) => value.status === "errored");
    const wait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(wait.timedOut, false);
    assert.equal(wait.update.agent_name, spawned.agent_name);
    assert.equal(wait.update.agent_status, "failed");
    assert.deepEqual(wait.update.blocking, {
      reason: "account_limit", scope: "harness", retry: "operator_required",
    });
  });

  it("delivers a session-drift wait receipt as an Agent-scoped new-agent block", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "session_drift",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=driftbase delay=40",
    ]);
    const terminal = waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
    const firstWait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(firstWait.update.blocking, null);
    run(test, [
      "wait_agent", "--timeout-ms", "0", "--acknowledge-tokens", firstWait.update.delivery_token, "--json",
    ]);

    run(test, ["followup_task", terminal.path, "--json", "session=driftbase drift=1 delay=40"]);
    waitForAgent(
      test,
      terminal.path,
      (value) => value.status === "errored" && value.latestJobId !== terminal.latestJobId,
    );

    const wait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(wait.timedOut, false);
    assert.equal(wait.update.agent_name, terminal.path);
    assert.equal(wait.update.agent_status, "failed");
    assert.deepEqual(wait.update.blocking, {
      reason: "session_lost", scope: "agent", retry: "new_agent",
    });
  });

  it("delivers a worker-lost wait receipt without exposing the dead PID or operator prose", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "lost_worker",
      "--model", "claude-sonnet-5", "--reasoning-effort", "high", "--json", "session=lost delay=30000",
    ]);
    const stored = agent(test, spawned.agent_name);
    // The Claude turn and its own detached worker are both structurally lost
    // together (e.g. an OOM kill of the whole worker process tree), so no live
    // actor ever observes the turn and patches a Driver failure class: only the
    // passive stale-job reaper (`runtime/job-store.mjs` `reapStaleJobs`) later
    // discovers the dead control PIDs.
    const running = waitForJob(
      test,
      stored.activeJobId,
      (value) => value.status === "running" && Boolean(value.pid) && Boolean(value.workerPid),
    );
    process.kill(running.workerPid, "SIGKILL");
    process.kill(running.pid, "SIGKILL");
    waitForAgent(test, spawned.agent_name, (value) => value.status === "errored", { timeoutMs: 8_000 });

    const wait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(wait.timedOut, false);
    assert.equal(wait.update.agent_name, spawned.agent_name);
    assert.equal(wait.update.agent_status, "failed");
    assert.deepEqual(wait.update.blocking, {
      reason: "worker_lost", scope: "agent", retry: "new_agent",
    });
    const blockingText = JSON.stringify(wait.update.blocking);
    assert.equal(blockingText.includes(String(running.pid)), false);
    assert.equal(blockingText.includes(String(running.workerPid)), false);
    assert.equal(/auto-reaped|control process/i.test(blockingText), false);
  });

  it("delivers an interrupted wait receipt with a null block and keeps the Agent follow-up resumable", () => {
    const test = fixture();
    const spawned = run(test, [
      "spawn_agent", "--harness", "claude-code", "--topology", "leaf", "--write=false", "--task-name", "graceful_interrupt", "--model", "claude-opus-5", "--reasoning-effort", "high",
      "--json", "session=graceful-interrupt delay=5000",
    ]);
    const stored = agent(test, spawned.agent_name);
    waitForJob(test, stored.activeJobId, (value) => value.status === "running" && Boolean(value.pid));
    const receipt = run(test, ["interrupt_agent", spawned.agent_name, "--json"], { timeout: 12_000 });
    assert.equal(receipt.agent_name, spawned.agent_name);
    assert.ok(
      ["interrupt_requested", "still_working", "interrupted"].includes(receipt.status),
      `unexpected interrupt receipt: ${JSON.stringify(receipt)}`,
    );
    waitForAgent(test, spawned.agent_name, (value) => value.status === "interrupted", { timeoutMs: 12_000 });

    const wait = run(test, ["wait_agent", "--timeout-ms", "0", "--json"]);
    assert.equal(wait.timedOut, false);
    assert.equal(wait.update.agent_name, spawned.agent_name);
    assert.equal(wait.update.agent_status, "interrupted");
    assert.equal(wait.update.blocking, null);

    const followup = run(test, [
      "followup_task", spawned.agent_name, "--json", "session=graceful-interrupt follow-up delay=40",
    ]);
    assert.deepEqual(followup, { agent_name: spawned.agent_name, delivery: "new_turn" });
    waitForAgent(test, spawned.agent_name, (value) => value.status === "completed");
  });
});
