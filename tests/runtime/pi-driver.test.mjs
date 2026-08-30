import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";

import { createPiDriver, PI_HARNESS_ID } from "../../runtime/pi-driver.mjs";
import { createPiRpcProcess } from "../../runtime/pi-rpc-process.mjs";
import { isDriverPreTransportRejection, validateInstanceInspection, validateLiveHarnessTurn, validateNormalizedTerminalResult, validatePreparedTurn } from "../../runtime/harness-contract.mjs";
import { acceptDriverRoute, createDriverScope, inspectDriverInstances } from "../../runtime/harness-registry.mjs";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PI_MODEL = "openai-codex/gpt-5.6-luna";
const text = "authoritative U+2028 message";

function fakePi(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); child.exitCode = 0; queueMicrotask(() => { child.emit("exit", 0, signal); child.stdout.end(); child.stderr.end(); }); return true; };
  const state = { argv: [], commands: [], settled: false, prompted: false, catalogRefreshes: 0, directNativeParity: false, selectedModel: PI_MODEL, entries: options.entries ?? [
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
    if (command.type === "get_available_models") response({ models: options.models ?? [PI_MODEL] });
    if (command.type === "set_model") { state.selectedModel = `${command.provider}/${command.modelId}`; response(); }
    if (command.type === "get_available_thinking_levels") response({ thinkingLevels: ["medium", "high"] });
    if (command.type === "get_commands") response({ commands: options.commands ?? [{ source: "extension" }, { source: "prompt" }, { source: "skill" }] });
    if (command.type === "get_state") { const [provider, id] = state.selectedModel.split("/"); response({ sessionId: sessionId(), model: { provider, id }, thinkingLevel: "high", isStreaming: false, isCompacting: false }); }
    if (command.type === "get_entries") response({ leafId: "leaf-post", entries: state.entries });
    if (command.type === "get_session_stats") response(state.prompted
      ? (options.afterStats ?? { toolCalls: 3, tokens: { input: 13, output: 7, cacheRead: 3, cacheWrite: 2 } })
      : (options.baselineStats ?? { toolCalls: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
    if (["set_auto_retry", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode", "steer"].includes(command.type)) response();
    if (command.type === "prompt") {
      state.prompted = true;
      const disallowedParityFlag = ["--offline", "--no-approve", "--tools", "--no-extensions", "--no-skills", "--no-prompt-templates"]
        .some((flag) => state.argv.includes(flag));
      if (options.requireDirectNativeParity && disallowedParityFlag) emit({ id: command.id, type: "response", command: "prompt", success: false, error: "native configuration was suppressed" });
      else if (options.requireDirectNativeParity) { state.directNativeParity = true; response(); if (options.settleOnPrompt !== false) queueMicrotask(settle); }
      else if (options.promptReject) emit({ id: command.id, type: "response", command: "prompt", success: false, error: "refused" });
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
  const driver = createPiDriver({ env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" }, _test: { inspectionGeneration: options.inspectionGeneration, sessionRoot: options.sessionRoot ?? "/tmp/pi-driver-fixture", spawn: (_command, argv) => {
    const fake = fakePi({ ...options, models: options.modelsForSpawn?.(fakes.length) ?? options.models }); fake.state.argv = argv;
    if (argv.includes("--no-session") && !argv.includes("--offline")) fake.state.catalogRefreshes += 1;
    fakes.push(fake); return fake.child;
  } } });
  return { driver, fakes };
}

async function started(options = {}) {
  const { driver, fakes } = fixture(options);
  const inspections = await inspectDriverInstances(driver, createDriverScope({ driver, purpose: "inspect", rootId: "r", workspaceRoot: "/tmp", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } }));
  const inspection = inspections[0];
  const route = acceptDriverRoute(driver, { harnessId: PI_HARNESS_ID, model: PI_MODEL, topology: "leaf", authority: options.write ? "behavioral_write" : "behavioral_read_only", effort: options.effort ?? "high" }, [inspection]).route;
  const scope = createDriverScope({ driver, purpose: "turn", rootId: "r", agentId: "a", turnId: "turn-1", attemptId: "attempt-1", route, taskInput: "inspect", turnOptions: { effort: route.effort }, workspaceRoot: "/tmp", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } });
  const preparedTurn = validatePreparedTurn(driver.prepareTurn({ route, taskInput: scope.taskInput, turnOptions: scope.turnOptions }), { driver, route, taskInput: scope.taskInput });
  const live = validateLiveHarnessTurn(await driver.startTurn({ scope, preparedTurn, launchContext: await driver.revalidatePreparedTurn(preparedTurn, scope) }), { driver, route });
  return { driver, fake: fakes.at(-1), fakes, route, scope, live };
}

describe("Pi Driver v2", () => {
  it("fails closed when bounded local Pi configuration is not available", async () => {
    const unavailable = createPiDriver({ _test: { sessionRoot: "/tmp/pi-driver-fixture", spawn: () => { throw new Error("missing"); } } });
    const missing = (await unavailable.inspectInstances(createDriverScope({ driver: unavailable, purpose: "inspect", env: {} })))[0];
    assert.deepEqual({ readiness: missing.readiness, detail: missing.detailCode }, { readiness: "unavailable", detail: "configuration_missing" });

    const executable = createPiDriver({ env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" }, _test: { sessionRoot: "/tmp/pi-driver-fixture", spawn: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } } });
    const absent = (await executable.inspectInstances(createDriverScope({ driver: executable, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    assert.deepEqual({ readiness: absent.readiness, detail: absent.detailCode }, { readiness: "unavailable", detail: "executable_missing" });
  });

  it("proves zero-model host readiness, fixes configuration before prompt, and projects message_end", async () => {
    const { driver, fake, fakes, route, live } = await started();
    const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
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
    assert.equal(fake.state.argv.includes("--offline"), false);
    assert.equal(fake.state.argv.includes("--no-approve"), false);
    assert.equal(fake.state.argv.includes("--tools"), false);
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates"]) assert.equal(fake.state.argv.includes(flag), false);
    assert.deepEqual(route.capabilities.values, { interaction: "noninteractive_fixed_policy", activeInput: "acknowledged_active_stream", continuation: "exact_resume", history: "assistant_messages", interruptRequest: "supported", turnObservation: "unavailable", automaticRecovery: "none", authorityEnforcement: "prompt_only", leafEnforcement: "prompt_only", nativeOrchestration: "opaque_bounded" });
    assert.equal(Object.hasOwn(inspection.routes, "reasoningEfforts"), false);
    assert.deepEqual(inspection.routes.effortsByModel, { [PI_MODEL]: ["medium", "high"] });
    assert.equal(inspection.routes.continuation, "exact_resume");
    assert.equal(inspection.routes.turnObservation, "unavailable");
    assert.equal(inspection.routes.automaticRecovery, "none");
    assert.equal(typeof driver.observeTurn, "undefined");
    assert.deepEqual(fakes[0].state.commands.map((command) => command.type), ["get_available_models", "set_model", "get_available_thinking_levels", "get_state", "get_commands"]);
    assert.deepEqual(fakes[0].state.commands[1], { id: fakes[0].state.commands[1].id, type: "set_model", provider: "openai-codex", modelId: "gpt-5.6-luna" });
    assert.equal(Object.hasOwn(fakes[0].state.commands[1], "model"), false);
    assert.equal(fakes[0].state.argv.includes("--no-session"), true);
    assert.equal(fakes[0].state.catalogRefreshes, 0, "control discovery must not refresh Pi's remote model catalog");
    assert.equal(fakes[0].state.argv.includes("--offline"), true);
    for (const flag of ["--no-approve", "--tools", "--no-extensions", "--no-skills", "--no-prompt-templates"]) assert.equal(fakes[0].state.argv.includes(flag), false);
    assert.equal(fakes[0].state.argv.includes("--session-id"), false);
  });

  it("uses Pi's exact set_model wire fields, prompt source vocabulary, and no-session discovery without session artifacts", async () => {
    const sessionRoot = path.join(os.tmpdir(), `pi-control-${process.pid}-${Date.now()}`);
    assert.equal(fs.existsSync(sessionRoot), false);
    const { driver, fakes } = fixture({ sessionRoot });
    const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    assert.equal(inspection.readiness, "ready");
    assert.equal(fs.existsSync(sessionRoot), false, "control discovery must not create a Pi session root");
    assert.deepEqual(fakes[0].state.commands[1], { id: fakes[0].state.commands[1].id, type: "set_model", provider: "openai-codex", modelId: "gpt-5.6-luna" });
    assert.equal(Object.hasOwn(fakes[0].state.commands[1], "model"), false);
    assert.equal(fakes[0].state.commands.at(-1).type, "get_commands");
    assert.equal(fakes[0].state.argv.includes("--no-session"), true);
    assert.equal(fakes[0].state.catalogRefreshes, 0, "control discovery must not refresh Pi's remote model catalog");
    assert.equal(fakes[0].state.argv.includes("--offline"), true);
    assert.equal(fakes[0].state.argv.some((part) => part === "--session" || part === "--session-id"), false);

    const malformed = fixture({ commands: [{ source: "extension" }, { source: "prompt_template" }] });
    const invalid = (await malformed.driver.inspectInstances(createDriverScope({ driver: malformed.driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    assert.deepEqual({ readiness: invalid.readiness, detail: invalid.detailCode }, { readiness: "unavailable", detail: "protocol_error" });
  });

  it("refuses malformed full models, unsafe session paths/partials, and explicit effort absence", async () => {
    const { driver } = fixture(); const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    assert.throws(() => driver.validateRoute({ model: "gpt-5.6-luna", topology: "leaf", authority: "behavioral_read_only" }, inspection), /not freshly admitted/);
    assert.throws(() => driver.validateRoute({ model: PI_MODEL, topology: "leaf", authority: "behavioral_read_only" }, inspection), /effort/);
    const route = driver.validateRoute({ model: PI_MODEL, topology: "leaf", authority: "behavioral_read_only", effort: "high" }, inspection);
    assert.equal(driver.prepareTurn({ route, taskInput: "x", turnOptions: { effort: "high" } }).turnOptions.effort, "high");
    for (const sessionId of ["/tmp/session.jsonl", "123e4567", "session-old"]) {
      assert.throws(() => driver.validateNativeSessionRef({ harnessId: "pi", driverVersion: "pi@2", instanceKey: "pi-local", locatorVersion: 1, locator: { sessionId } }), /UUID/);
    }
    assert.throws(() => driver.validateNativeSessionRef({ harnessId: "pi", driverVersion: "pi@2", instanceKey: "other", locatorVersion: 1, locator: { sessionId: SESSION_ID } }), /exactly/);
  });

  it("rejects a duplicated Pi effort projection before any prompt", async () => {
    const { driver, fakes } = fixture();
    const [inspection] = await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } }));
    const malformed = structuredClone(inspection);
    malformed.routes.effortsByModel[PI_MODEL] = ["high", "high"];
    assert.throws(() => validateInstanceInspection(malformed, driver), /duplicate efforts/);
    assert.equal(fakes.some((fake) => fake.state.commands.some((command) => command.type === "prompt")), false);
  });

  it("reinspects immediately before transport and rejects a disappeared exact route", async () => {
    const { driver } = fixture({ modelsForSpawn: (index) => index === 1 ? ["openai-codex/gpt-5.6-terra"] : [PI_MODEL] });
    const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    const route = driver.validateRoute({ harnessId: PI_HARNESS_ID, model: PI_MODEL, topology: "leaf", authority: "behavioral_read_only", effort: "high" }, inspection);
    const scope = createDriverScope({ driver, purpose: "turn", route, taskInput: "x", turnOptions: { effort: route.effort }, env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } });
    const prepared = driver.prepareTurn({ route, taskInput: "x", turnOptions: { effort: route.effort } });
    await assert.rejects(driver.revalidatePreparedTurn(prepared, scope), /not freshly admitted|drifted/);
  });

  it("replaces a whole Pi projection and keeps safe generation evidence separate from route identity", async () => {
    const firstToken = `sha256:${"a".repeat(64)}`;
    const secondToken = `sha256:${"b".repeat(64)}`;
    const generations = [firstToken, secondToken];
    const { driver } = fixture({
      inspectionGeneration: () => generations.shift(),
      modelsForSpawn: (index) => index === 0 ? [PI_MODEL] : ["openai-codex/gpt-5.6-terra"],
    });
    const scope = createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } });
    const firstInspection = (await driver.inspectInstances(scope))[0];
    const secondInspection = (await driver.inspectInstances(scope))[0];
    assert.deepEqual(firstInspection.capabilityProvenance, secondInspection.capabilityProvenance);
    assert.equal(firstInspection.inspectionGeneration, firstToken);
    assert.equal(secondInspection.inspectionGeneration, secondToken);
    assert.deepEqual(secondInspection.routes.models, ["openai-codex/gpt-5.6-terra"]);
    assert.equal(Object.hasOwn(secondInspection.routes.effortsByModel, PI_MODEL), false);
  });

  it("keeps direct native config parity across behavioral authorities", async () => {
    const read = await started({ requireDirectNativeParity: true }); const write = await started({ write: true, requireDirectNativeParity: true });
    const withoutSession = (argv) => argv.slice(0, -2);
    assert.deepEqual(withoutSession(read.fake.state.argv), withoutSession(write.fake.state.argv));
    assert.equal(read.fake.state.directNativeParity, true);
    assert.equal(write.fake.state.directNativeParity, true);
    await Promise.all([read.live.result, write.live.result]);
  });

  it("fails closed before history opens a persisted Pi session after route disappearance", async () => {
    const context = await started({ modelsForSpawn: (index) => index >= 3 ? ["openai-codex/gpt-5.6-terra"] : [PI_MODEL] });
    await assert.rejects(context.driver.readAssistantHistory({ route: context.route, nativeSessionRef: context.live.nativeSessionRef }), /not freshly admitted|drifted/);
    assert.equal(context.fakes.length, 4);
  });

  it("returns generic uncertainty after a prompt-write framing loss, but marks explicit prompt rejection pretransport", async () => {
    for (const [options, branded] of [[{ promptFramingFailure: true }, false], [{ promptReject: true }, true]]) {
      const { driver } = fixture(options);
      const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
      const route = driver.validateRoute({ model: PI_MODEL, topology: "leaf", authority: "behavioral_read_only", effort: "high" }, inspection);
      const preparedTurn = driver.prepareTurn({ route, taskInput: "x", turnOptions: { effort: "high" } });
      const scope = { route, turnId: "turn", taskInput: "x", turnOptions: { effort: "high" }, workspaceRoot: "/tmp" };
      await assert.rejects(driver.startTurn({ scope, preparedTurn, launchContext: { workspaceRoot: "/tmp" } }), (error) => isDriverPreTransportRejection(error) === branded);
    }
  });

  it("reads exact UUID history newest-first", async () => {
    const entries = [
      { type: "message", id: "a-1", timestamp: Date.parse("2026-01-01T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }] } },
      { type: "message", id: "a-2", timestamp: Date.parse("2026-01-02T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second" }] } },
    ];
    const { driver, fake, fakes, route, live } = await started({ entries });
    const history = await driver.readAssistantHistory({ route, nativeSessionRef: live.nativeSessionRef }, { limit: 1 });
    assert.deepEqual(history, { messages: [{ messageId: "a-2", timestamp: "2026-01-02T00:00:00.000Z", text: "second" }], nextBefore: "a-2" });
    assert.deepEqual((await driver.readAssistantHistory({ route, nativeSessionRef: live.nativeSessionRef }, { limit: 1, before: "a-2" })).messages.map((message) => message.messageId), ["a-1"]);
    assert.equal(fake.state.commands.some((command) => command.type === "prompt" && command.message === "second"), false);
    assert.equal(fakes.filter((candidate) => !candidate.state.argv.includes("--no-session")).some((candidate) => candidate.state.argv.includes("--offline")), false);
  });

  it("does not expose ambiguous post-baseline history as an old-turn terminal", async () => {
    const entries = [
      { type: "message", id: "a-old", timestamp: Date.parse("2026-01-01T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old turn" }] } },
      { type: "message", id: "a-later", timestamp: Date.parse("2026-01-02T00:00:00.000Z"), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "later turn" }] } },
    ];
    const { driver, route, live } = await started({ entries });
    assert.equal(route.capabilities.values.turnObservation, "unavailable");
    assert.equal(typeof driver.observeTurn, "undefined");
    assert.equal(live.nativeTurnRef.locator.turnId, "turn-1");
  });

  it("uses --session only for a validated exact UUID resume", async () => {
    const { driver, fakes } = fixture();
    const inspection = (await driver.inspectInstances(createDriverScope({ driver, purpose: "inspect", env: { PI_CODING_AGENT_DIR: "/tmp/pi-config" } })))[0];
    const route = driver.validateRoute({ model: PI_MODEL, topology: "leaf", authority: "behavioral_read_only", effort: "high" }, inspection);
    const preparedTurn = driver.prepareTurn({ route, taskInput: "resume", turnOptions: { effort: "high" } });
    const live = await driver.startTurn({ scope: { route, turnId: "resume-turn", taskInput: "resume", turnOptions: { effort: "high" }, workspaceRoot: "/tmp" }, preparedTurn, launchContext: { workspaceRoot: "/tmp" }, nativeSessionRef: { version: 1, harnessId: "pi", driverVersion: "pi@2", instanceKey: "pi-local", locatorVersion: 1, locator: { sessionId: SESSION_ID } } });
    assert.deepEqual(fakes.at(-1).state.argv.slice(-2), ["--session", SESSION_ID]);
    assert.equal(fakes.at(-1).state.argv.includes("--offline"), false);
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

  it("fails closed instead of hiding regressed cumulative usage counters", async () => {
    const { live } = await started({ afterStats: { toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    await assert.rejects(live.result, /cumulative counter .* regressed/);
  });
});

describe("Pi RPC process hardening", () => {
  it("cancels blocking extension UI requests instead of waiting for an unavailable host reply", async () => {
    const fake = fakePi();
    const rpc = createPiRpcProcess({ argv: [], cwd: "/tmp", env: {}, _test: { spawn: () => fake.child } });
    for (const method of ["select", "confirm", "input", "editor"]) {
      fake.child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: `ask-${method}`, method })}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      fake.state.commands.filter((command) => command.type === "extension_ui_response"),
      ["select", "confirm", "input", "editor"].map((method) => ({
        type: "extension_ui_response", id: `ask-${method}`, cancelled: true,
      })),
    );
    await rpc.dispose();
  });

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
