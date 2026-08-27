import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";

import { createPiDriver, PI_HARNESS_ID, PI_MODELS } from "../../runtime/pi-driver.mjs";
import { createPiRpcProcess } from "../../runtime/pi-rpc-process.mjs";
import { isDriverPreTransportRejection, validateLiveHarnessTurn, validateNormalizedTerminalResult, validatePreparedTurn } from "../../runtime/harness-contract.mjs";
import { acceptDriverRoute, createDriverScope, inspectDriverInstances } from "../../runtime/harness-registry.mjs";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const text = "authoritative U+2028 message";

function probe(args) {
  if (args[0] === "--version") return { status: 0, stdout: "pi 1.0\n", stderr: "" };
  if (args[0] === "auth") return { status: 0, stdout: JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth" }), stderr: "" };
  return { status: 0, stdout: PI_MODELS.map((model) => model.replace("/", "  ")).join("\n"), stderr: "" };
}

function fakePi(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); child.exitCode = 0; queueMicrotask(() => { child.emit("exit", 0, signal); child.stdout.end(); child.stderr.end(); }); return true; };
  const state = { argv: [], commands: [], settled: false, prompted: false, entries: options.entries ?? [
    { type: "message", id: "a-1", timestamp: Date.parse("2026-01-01T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }, },
  ] };
  const emit = (record) => child.stdout.write(`${JSON.stringify(record)}\n`);
  const sessionId = () => {
    const created = state.argv.indexOf("--session-id");
    const resumed = state.argv.indexOf("--session");
    return created >= 0 ? state.argv[created + 1] : (resumed >= 0 ? state.argv[resumed + 1] : SESSION_ID);
  };
  const settle = () => {
    if (state.settled) return; state.settled = true;
    emit({ type: "message_end", message: options.messageEnd ?? { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
    emit({ type: "agent_settled" });
  };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const command = JSON.parse(String(chunk).trim()); state.commands.push(command);
    const response = (data) => emit({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) });
    if (command.type === "get_state") response({ sessionId: sessionId(), model: { provider: "openai-codex", id: "gpt-5.6-luna" }, thinkingLevel: "high", isStreaming: false, isCompacting: false });
    if (command.type === "get_entries") response({ leafId: "leaf-post", entries: state.entries });
    if (command.type === "get_session_stats") response(state.prompted
      ? (options.afterStats ?? { toolCalls: 3, tokens: { input: 13, output: 7, cacheRead: 3, cacheWrite: 2 } })
      : (options.baselineStats ?? { toolCalls: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
    if (["set_auto_retry", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode", "steer"].includes(command.type)) response();
    if (command.type === "prompt") {
      state.prompted = true;
      if (options.promptReject) emit({ id: command.id, type: "response", command: "prompt", success: false, error: "refused" });
      else if (options.promptFramingFailure) child.stdout.write("not-json\n");
      else { response(); if (options.settleOnPrompt !== false) queueMicrotask(settle); }
    }
    if (command.type === "abort") { response(); if (options.settleOnAbort !== false) queueMicrotask(settle); }
    done();
  } });
  return { child, state, settle };
}

function fixture(options = {}) {
  const fakes = [];
  const driver = createPiDriver({ _test: { sessionRoot: "/tmp/pi-driver-fixture", probe: options.probe ?? probe, spawn: (_command, argv) => {
    const fake = fakePi(options); fake.state.argv = argv; fakes.push(fake); return fake.child;
  } } });
  return { driver, fakes };
}

async function started(options = {}) {
  const { driver, fakes } = fixture(options);
  const inspection = (await inspectDriverInstances(driver, createDriverScope({ driver, purpose: "inspect", rootId: "r", workspaceRoot: "/tmp" })))[0];
  const route = acceptDriverRoute(driver, { harnessId: PI_HARNESS_ID, model: PI_MODELS[0], topology: "leaf", authority: "behavioral_read_only" }, [inspection]).route;
  const scope = createDriverScope({ driver, purpose: "turn", rootId: "r", agentId: "a", turnId: "turn-1", attemptId: "attempt-1", route, taskInput: "inspect", turnOptions: { effort: "high" }, workspaceRoot: "/tmp", env: {} });
  const preparedTurn = validatePreparedTurn(driver.prepareTurn({ route, taskInput: scope.taskInput, turnOptions: scope.turnOptions }), { driver, route, taskInput: scope.taskInput });
  const live = validateLiveHarnessTurn(await driver.startTurn({ scope, preparedTurn, launchContext: await driver.revalidatePreparedTurn(preparedTurn, scope) }), { driver, route });
  return { driver, fake: fakes[0], fakes, route, scope, live };
}

describe("Pi Driver v2", () => {
  it("reports executable/auth/model probe failure without pretending readiness", async () => {
    const unavailable = createPiDriver({ _test: { sessionRoot: "/tmp/pi-driver-fixture", probe: () => ({ error: { code: "ENOENT" } }) } });
    assert.deepEqual((await unavailable.inspectInstances())[0].readiness, "unavailable");
    const blocked = createPiDriver({ _test: { sessionRoot: "/tmp/pi-driver-fixture", probe: (args) => args[0] === "auth" ? ({ status: 1, stdout: "", stderr: "" }) : ({ status: 0, stdout: "pi\n", stderr: "" }) } });
    assert.deepEqual((await blocked.inspectInstances())[0].detailCode, "not_authenticated");
    const foreign = createPiDriver({ _test: { sessionRoot: "/tmp/pi-driver-fixture", probe: (args) => args[0] === "auth" ? ({ status: 0, stdout: JSON.stringify({ status: "ready", provider: "other" }), stderr: "" }) : ({ status: 0, stdout: "pi\n", stderr: "" }) } });
    assert.deepEqual((await foreign.inspectInstances())[0].detailCode, "not_authenticated");
  });

  it("proves zero-model host readiness, fixes configuration before prompt, and projects message_end", async () => {
    const calls = [];
    const checked = (args) => { calls.push(args); return probe(args); };
    const { driver, fake, route, live } = await started({ probe: checked });
    const inspection = (await driver.inspectInstances())[0];
    const result = validateNormalizedTerminalResult(await live.result, { driver, route });
    assert.equal(result.finalMessage, text, "message_end, not get_entries, is final authority");
    assert.deepEqual(result.metrics.provider_reported, {
      duration_ms: null,
      duration_api_ms: null,
      turn_count: null,
      input_tokens: 12,
      output_tokens: 6,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      reported_cost_usd: null,
    });
    assert.equal(result.metrics.plugin_observed.tool_call_count, 2);
    assert.deepEqual(fake.state.commands.slice(0, 8).map((command) => command.type), ["get_state", "get_entries", "get_session_stats", "set_auto_retry", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode", "prompt"]);
    assert.match(fake.state.commands.find((command) => command.type === "prompt").message, /HarnessDock route contract:[\s\S]*Read only[\s\S]*Task:\ninspect/);
    assert.deepEqual(fake.state.argv.slice(0, 8), ["--mode", "rpc", "--session-dir", "/tmp/pi-driver-fixture", "--provider", "openai-codex", "--model", "gpt-5.6-luna"]);
    assert.equal(fake.state.argv.includes("--offline"), true);
    assert.deepEqual(route.capabilities.values, { interaction: "noninteractive_fixed_policy", activeInput: "acknowledged_active_stream", continuation: "exact_resume", history: "assistant_messages", interruptRequest: "supported", turnObservation: "terminal_observable", automaticRecovery: "none", authorityEnforcement: "harness_policy", leafEnforcement: "effective_tool_denial", nativeOrchestration: "disabled" });
    assert.deepEqual(inspection.routes.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(inspection.routes.authorities.behavioral_read_only.tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(inspection.routes.authorities.behavioral_write.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    assert.equal(inspection.routes.continuation, "exact_resume");
    assert.equal(inspection.routes.automaticRecovery, "none");
    assert.equal(typeof driver.observeTurn, "function");
    assert.deepEqual(calls.slice(0, 3), [["--version"], ["auth", "check", "--provider", "openai-codex", "--json", "--no-refresh"], ["--offline", "--list-models", "openai-codex"]]);
  });

  it("refuses malformed full models, unsafe session paths/partials, and explicit effort absence", async () => {
    const { driver } = fixture();
    assert.throws(() => driver.validateRoute({ model: "gpt-5.6-luna", topology: "leaf", authority: "behavioral_read_only" }, { instanceKey: "pi-local", readiness: "ready" }), /exactly one model/);
    assert.throws(() => driver.validateRoute({ model: "openai-codex/gpt-5.6-luna:high", topology: "leaf", authority: "behavioral_read_only" }, { instanceKey: "pi-local", readiness: "ready" }), /exactly one model/);
    const route = driver.validateRoute({ model: PI_MODELS[0], topology: "leaf", authority: "behavioral_read_only" }, { instanceKey: "pi-local", readiness: "ready" });
    assert.throws(() => driver.prepareTurn({ route, taskInput: "x", turnOptions: null }), /explicit effort/);
    for (const sessionId of ["/tmp/session.jsonl", "123e4567", "session-old"]) {
      assert.throws(() => driver.validateNativeSessionRef({ harnessId: "pi", driverVersion: "pi@2", instanceKey: "pi-local", locatorVersion: 1, locator: { sessionId } }), /UUID/);
    }
    assert.throws(() => driver.validateNativeSessionRef({ harnessId: "pi", driverVersion: "pi@2", instanceKey: "other", locatorVersion: 1, locator: { sessionId: SESSION_ID } }), /exactly/);
  });

  it("returns generic uncertainty after a prompt-write framing loss, but marks explicit prompt rejection pretransport", async () => {
    for (const [options, branded] of [[{ promptFramingFailure: true }, false], [{ promptReject: true }, true]]) {
      const { driver } = fixture(options);
      const inspection = (await driver.inspectInstances())[0];
      const route = driver.validateRoute({ model: PI_MODELS[0], topology: "leaf", authority: "behavioral_read_only" }, inspection);
      const preparedTurn = driver.prepareTurn({ route, taskInput: "x", turnOptions: { effort: "high" } });
      const scope = { route, turnId: "turn", taskInput: "x", turnOptions: { effort: "high" }, workspaceRoot: "/tmp" };
      await assert.rejects(driver.startTurn({ scope, preparedTurn, launchContext: { workspaceRoot: "/tmp" } }), (error) => isDriverPreTransportRejection(error) === branded);
    }
  });

  it("reads exact UUID history newest-first and observes only post-baseline terminal evidence", async () => {
    const entries = [
      { type: "message", id: "a-1", timestamp: Date.parse("2026-01-01T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }] } },
      { type: "message", id: "a-2", timestamp: Date.parse("2026-01-02T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second" }] } },
    ];
    const { driver, fake, route, live } = await started({ entries });
    const history = await driver.readAssistantHistory({ route, nativeSessionRef: live.nativeSessionRef }, { limit: 1 });
    assert.deepEqual(history, { messages: [{ messageId: "a-2", timestamp: "2026-01-02T00:00:00.000Z", text: "second" }], nextBefore: "a-2" });
    assert.deepEqual((await driver.readAssistantHistory({ route, nativeSessionRef: live.nativeSessionRef }, { limit: 1, before: "a-2" })).messages.map((message) => message.messageId), ["a-1"]);
    const observed = await driver.observeTurn(live.nativeTurnRef, { route, workspaceRoot: "/tmp" });
    assert.equal(observed.nativeTurn, "terminal");
    assert.equal(observed.terminalResult.finalMessage, "second");
    assert.equal(fake.state.commands.some((command) => command.type === "prompt" && command.message === "second"), false);
  });

  it("uses --session only for a validated exact UUID resume", async () => {
    const { driver, fakes } = fixture();
    const inspection = (await driver.inspectInstances())[0];
    const route = driver.validateRoute({ model: PI_MODELS[0], topology: "leaf", authority: "behavioral_read_only" }, inspection);
    const preparedTurn = driver.prepareTurn({ route, taskInput: "resume", turnOptions: { effort: "high" } });
    const live = await driver.startTurn({ scope: { route, turnId: "resume-turn", taskInput: "resume", turnOptions: { effort: "high" }, workspaceRoot: "/tmp" }, preparedTurn, launchContext: { workspaceRoot: "/tmp" }, nativeSessionRef: { version: 1, harnessId: "pi", driverVersion: "pi@2", instanceKey: "pi-local", locatorVersion: 1, locator: { sessionId: SESSION_ID } } });
    assert.deepEqual(fakes[0].state.argv.slice(-2), ["--session", SESSION_ID]);
    await live.result;
  });

  it("acknowledges interrupt without waiting for terminal settlement", async () => {
    const { fake, live } = await started({ settleOnPrompt: false, settleOnAbort: false });
    const receipt = await live.requestInterrupt({ commandId: "interrupt-1", kind: "interrupt" });
    assert.deepEqual(receipt, { commandId: "interrupt-1", requestState: "accepted", nativeTurnState: "active", settlement: "pending" });
    assert.equal(fake.state.settled, false);
    fake.settle();
    assert.equal((await live.result).status, "completed");
  });

  it("projects an observed aborted final transcript as interrupted", async () => {
    const entries = [{ type: "message", id: "a-stop", timestamp: Date.parse("2026-01-03T00:00:00.000Z"), message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] } }];
    const { route, live, driver } = await started({ entries });
    const observed = await driver.observeTurn(live.nativeTurnRef, { route, workspaceRoot: "/tmp" });
    assert.equal(observed.nativeTurn, "terminal");
    assert.equal(observed.terminalResult.status, "interrupted");
    assert.equal(observed.terminalResult.failure.class, "cancelled_or_interrupted");
  });

  it("fails closed instead of hiding regressed cumulative usage counters", async () => {
    const { live } = await started({ afterStats: { toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    await assert.rejects(live.result, /cumulative counter .* regressed/);
  });
});

describe("Pi RPC process hardening", () => {
  it("preserves strict LF framing/cursors and rejects invalid or oversized responses with cleanup", async () => {
    const fake = fakePi();
    const rpc = createPiRpcProcess({ argv: [], cwd: "/tmp", env: {}, _test: { spawn: () => fake.child } });
    await rpc.getEntries("entry-42");
    assert.equal(fake.state.commands[0].since, "entry-42");
    await rpc.dispose();
    for (const payload of ["not json\n", `${JSON.stringify({ type: "event", text: "x".repeat(1024 * 1024) })}\n`]) {
      const bad = fakePi(); bad.child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const process = createPiRpcProcess({ argv: [], cwd: "/tmp", env: {}, _test: { spawn: () => bad.child } });
      const pending = process.getState(); bad.child.stdout.write(payload);
      await assert.rejects(pending, /invalid JSONL|oversized/); await process.dispose(); assert.equal(bad.child.kills[0], "SIGTERM");
    }
  });

  it("bounds a correlated command whose RPC response never arrives", async () => {
    const stalled = fakePi();
    stalled.child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const rpc = createPiRpcProcess({
      argv: [], cwd: "/tmp", env: {},
      _test: { spawn: () => stalled.child, responseTimeoutMs: 10 },
    });
    await assert.rejects(rpc.getState(), (error) => error?.code === "response_timeout");
    await rpc.dispose();
  });
});
