/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { once } from "node:events";

import { createPiDriver } from "../../runtime/pi-driver.mjs";
import { directInterrupt, directInventory, directTurn } from "./fixtures/native-parity/direct-pi-jsonl-client.mjs";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/native-parity/fake-pi-native.mjs");
const RECEIPT = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/native-parity/pi-native-differential-receipt.json");
const MODEL = "openai-codex/gpt-5.6-luna";
const ROOTS = [];

function json(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function canonicalConfig(overrides = {}) {
  return {
    catalog: {
      "openai-codex/gpt-5.6-luna": ["medium", "high"],
      "openai-codex/gpt-5.6-terra": ["low"],
    },
    commands: [{ source: "extension" }, { source: "prompt" }, { source: "skill" }],
    configWitness: "sha256:pi-native-config-v1",
    usageDelta: { toolCalls: 2, input: 12, output: 6, cacheRead: 3, cacheWrite: 2 },
    terminalStopReason: "stop",
    ...overrides,
  };
}
function world(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-native-parity-${label}-`));
  ROOTS.push(root);
  const configRoot = path.join(root, "config"); const stateRoot = path.join(root, "state"); const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const value = { root, configRoot, stateRoot, sessionRoot, configPath: path.join(configRoot, "native-parity.json") };
  value.env = { PI_CODING_AGENT_DIR: configRoot, PI_NATIVE_PARITY_STATE_DIR: stateRoot, PI_NATIVE_PARITY_ENV_WITNESS: "native-config-inherited" };
  setConfig(value);
  return value;
}
function setConfig(current, overrides = {}) { json(current.configPath, canonicalConfig(overrides)); }
function records(current) {
  const dir = path.join(current.stateRoot, "records");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
}
function nativeInput(current, argv) { return { executable: FIXTURE, argv, cwd: current.root, env: current.env }; }
function controlArgv(current) { return ["--mode", "rpc", "--session-dir", current.sessionRoot, "--offline", "--no-session"]; }
function turnArgv(current, sessionId, resume = false) {
  return ["--mode", "rpc", "--session-dir", current.sessionRoot, "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "high", resume ? "--session" : "--session-id", sessionId];
}
function promptRecord(record) { return record.commands.find((command) => command.type === "prompt"); }
function sessionRecord(current, sessionId) { return records(current).find((record) => record.sessionId === sessionId && promptRecord(record)); }
function controlRecord(current) { return records(current).filter((record) => record.argv.includes("--offline")).at(-1); }
function capturedRecords(current, subject) {
  const all = records(current);
  return subject.captures.map(({ pid }) => all.find((record) => record.pid === pid));
}
function argvShape(argv) {
  return argv.map((item, index) => (index > 0 && ["--session-id", "--session"].includes(argv[index - 1]) ? "<native-session>" : (index > 0 && argv[index - 1] === "--session-dir" ? "<bounded-session-root>" : item)));
}
function eventTypes(recordOrEvents) { return (Array.isArray(recordOrEvents) ? recordOrEvents : recordOrEvents.events).map((event) => event.type); }
function commandShape(commands) { return commands.map(({ id: _id, ...command }) => command); }
function normalizeAuthorityStatement(message) { return message.replace(/^- [^\n]+/m, "- <authority-statement>"); }
function authorityStatement(message) { return message.match(/^- ([^\n]+)/m)?.[1] ?? null; }
function usageDelta(before, after) {
  return {
    input_tokens: after.tokens.input - before.tokens.input,
    output_tokens: after.tokens.output - before.tokens.output,
    cache_creation_input_tokens: after.tokens.cacheWrite - before.tokens.cacheWrite,
    cache_read_input_tokens: after.tokens.cacheRead - before.tokens.cacheRead,
    tool_call_count: after.toolCalls - before.toolCalls,
  };
}
function sourceEnvironment(record) { return { PI_CODING_AGENT_DIR: "<bounded-config-root>", PI_NATIVE_PARITY_ENV_WITNESS: record.environment.PI_NATIVE_PARITY_ENV_WITNESS }; }
function parityEqual(label, direct, harnessdock) { assert.deepEqual(harnessdock, direct, `${label} parity mismatch`); }
function mustFail(comparator) { assert.throws(comparator, /parity mismatch/); }
function noLivePid(pid) { assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); }
function sourceGuard() {
  const direct = fs.readFileSync(path.join(path.dirname(FIXTURE), "direct-pi-jsonl-client.mjs"), "utf8");
  assert.doesNotMatch(direct, /(?:pi-driver|pi-rpc-process|harness-contract|terminal-metrics|harness-registry|piRpcArgv|fixedPrompt|statsDelta|HarnessDock route contract|Task-scoped writes|Read only\. Do not change|Work as one leaf|Return one final assistant message)/);
}

function harness(current) {
  const captures = [];
  const driver = createPiDriver({
    env: current.env,
    _test: {
      sessionRoot: current.sessionRoot,
      spawn(_command, argv, options) {
        const child = spawn(process.execPath, [FIXTURE, ...argv], options);
        captures.push({ argv: [...argv], cwd: options.cwd, environment: {
          PI_CODING_AGENT_DIR: options.env.PI_CODING_AGENT_DIR ?? null,
          PI_NATIVE_PARITY_ENV_WITNESS: options.env.PI_NATIVE_PARITY_ENV_WITNESS ?? null,
        }, pid: child.pid, child });
        return child;
      },
    },
  });
  return { driver, captures };
}
async function inspect(current, subject) {
  const inspection = (await subject.driver.inspectInstances({ workspaceRoot: current.root, env: current.env }))[0];
  assert.equal(inspection.readiness, "ready");
  return inspection;
}
async function launch(current, subject, { authority = "behavioral_read_only", task = "native parity task", turnId = "driver-t1", nativeSessionRef = null } = {}) {
  const inspection = await inspect(current, subject);
  const route = subject.driver.validateRoute({ harnessId: "pi", model: MODEL, topology: "leaf", authority, effort: "high" }, inspection);
  const scope = { route, rootId: "root", agentId: "agent", turnId, attemptId: `${turnId}-attempt`, taskInput: task, turnOptions: { effort: "high" }, workspaceRoot: current.root, env: current.env };
  const preparedTurn = subject.driver.prepareTurn({ route, taskInput: task, turnOptions: { effort: "high" } });
  const launchContext = await subject.driver.revalidatePreparedTurn(preparedTurn, scope);
  const live = await subject.driver.startTurn({ scope, preparedTurn, launchContext, ...(nativeSessionRef ? { nativeSessionRef } : {}) });
  return { inspection, route, scope, live };
}
async function completed(current, subject, options) { const output = await launch(current, subject, options); return { ...output, result: await output.live.result }; }

function row(dimension, direct, harnessdock, comparator, sources = {}) {
  comparator();
  return {
    dimension,
    directSource: sources.directSource ?? "manual Pi JSONL client",
    harnessdockSource: sources.harnessdockSource ?? "Pi Driver receipt and native invocation capture",
    mode: "zero-model deterministic fake native",
    comparator: "executed independent behavioral comparison",
    result: "pass",
    artifactDigest: digest({ direct, harnessdock }),
  };
}
function unavailable(dimension, value, comparator) {
  comparator();
  return {
    dimension,
    directSource: "accepted Pi capability snapshot",
    harnessdockSource: "Pi Driver inspection receipt",
    mode: "capability-derived",
    comparator: "executed capability-derived unavailability check",
    result: "not_applicable",
    artifactDigest: digest(value),
  };
}
function nativeTurnStop(events) { return events.find((event) => event.type === "message_end")?.message?.stopReason ?? null; }
function nativeHistory(entries) { return entries.map((entry) => entry.id).reverse(); }
function assertAllClosed(current) {
  for (const record of records(current)) {
    assert.equal(record.closed, true, `Pi fixture process ${record.pid} did not publish clean closure`);
    noLivePid(record.pid);
  }
}
function assertNoSurvivors(current) { for (const record of records(current)) noLivePid(record.pid); }
async function waitForCapturedExit(subject) {
  await Promise.all(subject.captures.map(async ({ child }) => { if (child.exitCode == null) await once(child, "exit"); }));
}

async function evidence() {
  const current = world("evidence");
  try {
    const directCatalog = await directInventory(nativeInput(current, controlArgv(current)));
    const inventoryHarness = harness(current); const inventory = await inspect(current, inventoryHarness);
    const driverCatalog = controlRecord(current);

    const directRead = await directTurn({ ...nativeInput(current, turnArgv(current, "11111111-1111-4111-8111-111111111111")), task: "native parity task" });
    const readHarness = harness(current); const read = await completed(current, readHarness);
    const readRecord = sessionRecord(current, read.live.nativeSessionRef.locator.sessionId);

    const writeHarness = harness(current); const write = await completed(current, writeHarness, { authority: "behavioral_write", turnId: "driver-write" });
    const writeRecord = sessionRecord(current, write.live.nativeSessionRef.locator.sessionId);

    setConfig(current, { settleOnPrompt: false });
    const directAbort = await directInterrupt({ ...nativeInput(current, turnArgv(current, "33333333-3333-4333-8333-333333333333")), task: "interrupt task" });
    const interruptHarness = harness(current); const interrupted = await launch(current, interruptHarness, { task: "interrupt task", turnId: "driver-interrupt" });
    const interruptReceipt = await interrupted.live.requestInterrupt({ commandId: "interrupt-1", kind: "interrupt" });
    const interruptResult = await interrupted.live.result;
    const interruptRecord = sessionRecord(current, interrupted.live.nativeSessionRef.locator.sessionId);

    setConfig(current);
    const directSession = "44444444-4444-4444-8444-444444444444";
    await directTurn({ ...nativeInput(current, turnArgv(current, directSession)), task: "first" });
    const directContinuation = await directTurn({ ...nativeInput(current, turnArgv(current, directSession, true)), task: "second" });
    const firstHarness = harness(current); const first = await completed(current, firstHarness, { task: "first", turnId: "driver-t1" });
    const secondHarness = harness(current); const second = await completed(current, secondHarness, { task: "second", turnId: "driver-t2", nativeSessionRef: first.live.nativeSessionRef });
    const history = await secondHarness.driver.readAssistantHistory({ route: second.route, nativeSessionRef: first.live.nativeSessionRef }, { limit: 2, workspaceRoot: current.root });

    const driftHarness = harness(current); const driftInspection = await inspect(current, driftHarness);
    const driftRoute = driftHarness.driver.validateRoute({ harnessId: "pi", model: MODEL, topology: "leaf", authority: "behavioral_read_only", effort: "high" }, driftInspection);
    const driftScope = { route: driftRoute, taskInput: "drift", turnOptions: { effort: "high" }, workspaceRoot: current.root, env: current.env };
    const driftPrepared = driftHarness.driver.prepareTurn({ route: driftRoute, taskInput: "drift", turnOptions: { effort: "high" } });
    setConfig(current, { catalog: { "openai-codex/gpt-5.6-terra": ["low"] } });
    let routeDriftRejected = false;
    await assert.rejects(driftHarness.driver.revalidatePreparedTurn(driftPrepared, driftScope), (error) => {
      routeDriftRejected = /not freshly admitted|drifted/.test(String(error?.message));
      return routeDriftRejected;
    });
    setConfig(current);

    const directUsage = usageDelta(directRead.beforeStats, directRead.afterStats);
    const driverUsage = {
      input_tokens: read.result.metrics.provider_reported.input_tokens,
      output_tokens: read.result.metrics.provider_reported.output_tokens,
      cache_creation_input_tokens: read.result.metrics.provider_reported.cache_creation_input_tokens,
      cache_read_input_tokens: read.result.metrics.provider_reported.cache_read_input_tokens,
      tool_call_count: read.result.metrics.plugin_observed.tool_call_count,
    };
    const readControls = capturedRecords(current, readHarness).filter((record) => record.argv.includes("--offline"));
    const writeControls = capturedRecords(current, writeHarness).filter((record) => record.argv.includes("--offline"));
    const readAuthorityCapture = {
      argv: argvShape(readRecord.argv), environment: sourceEnvironment(readRecord), configWitness: readRecord.configWitness,
      turnCommands: commandShape(readRecord.commands).map((command) => command.type === "prompt" ? { ...command, message: normalizeAuthorityStatement(command.message) } : command),
      controls: readControls.map((record) => ({ argv: argvShape(record.argv), environment: sourceEnvironment(record), configWitness: record.configWitness, commands: commandShape(record.commands) })),
    };
    const writeAuthorityCapture = {
      argv: argvShape(writeRecord.argv), environment: sourceEnvironment(writeRecord), configWitness: writeRecord.configWitness,
      turnCommands: commandShape(writeRecord.commands).map((command) => command.type === "prompt" ? { ...command, message: normalizeAuthorityStatement(command.message) } : command),
      controls: writeControls.map((record) => ({ argv: argvShape(record.argv), environment: sourceEnvironment(record), configWitness: record.configWitness, commands: commandShape(record.commands) })),
    };
    const directLifecycle = [directCatalog.record, directRead.record, directAbort.record, directContinuation.record].map((record) => record.closed);
    const harnessLifecycle = [inventoryHarness, readHarness, writeHarness, interruptHarness, firstHarness, secondHarness, driftHarness]
      .flatMap((subject) => capturedRecords(current, subject)).map((record) => record.closed);
    const rows = [
      row("exact_model_per_model_effort_inventory", { models: directCatalog.models, effortsByModel: directCatalog.effortsByModel }, { models: inventory.routes.models, effortsByModel: inventory.routes.effortsByModel }, () => parityEqual("exact native catalog", { models: directCatalog.models, effortsByModel: directCatalog.effortsByModel }, { models: inventory.routes.models, effortsByModel: inventory.routes.effortsByModel })),
      row("argv_environment", { argv: argvShape(directRead.record.argv), environment: sourceEnvironment(directRead.record) }, { argv: argvShape(readRecord.argv), environment: sourceEnvironment(readRecord) }, () => { assert.equal(directRead.record.argv[3], current.sessionRoot); assert.equal(readRecord.argv[3], current.sessionRoot); assert.equal(directRead.record.environment.PI_CODING_AGENT_DIR, current.configRoot); assert.equal(readRecord.environment.PI_CODING_AGENT_DIR, current.configRoot); parityEqual("launch argv/environment", { argv: argvShape(directRead.record.argv), environment: sourceEnvironment(directRead.record) }, { argv: argvShape(readRecord.argv), environment: sourceEnvironment(readRecord) }); }),
      row("configuration_inheritance_witness", directCatalog.nativeConfiguration.configWitness, driverCatalog.configWitness, () => parityEqual("configuration witness", directCatalog.nativeConfiguration.configWitness, driverCatalog.configWitness)),
      row("prompt_authority_native_input", readAuthorityCapture, writeAuthorityCapture, () => { parityEqual("read/write argv, environment, config, transport, and controls", readAuthorityCapture, writeAuthorityCapture); assert.notEqual(authorityStatement(promptRecord(readRecord).message), authorityStatement(promptRecord(writeRecord).message)); }, { directSource: "Pi Driver behavioral_read_only native capture", harnessdockSource: "Pi Driver behavioral_write native capture" }),
      row("ordered_events", eventTypes(directRead.events), eventTypes(readRecord), () => parityEqual("native event order", eventTypes(directRead.events), eventTypes(readRecord))),
      row("interrupt_request_behavior", { events: eventTypes(directAbort.events), accepted: directAbort.abort.success }, { events: eventTypes(interruptRecord), receipt: interruptReceipt, status: interruptResult.status }, () => { parityEqual("interrupt events", eventTypes(directAbort.events), eventTypes(interruptRecord)); assert.equal(directAbort.abort.success, true); assert.deepEqual(interruptReceipt, { commandId: "interrupt-1", requestState: "accepted", nativeTurnState: "active", settlement: "pending" }); assert.equal(interruptResult.status, "interrupted"); }),
      row("exact_session_continuation", { session: directSession, turnIds: nativeHistory(directContinuation.afterEntries.entries) }, { sameSession: second.live.nativeSessionRef.locator.sessionId === first.live.nativeSessionRef.locator.sessionId, distinctDriverTurns: second.live.nativeTurnRef.locator.turnId !== first.live.nativeTurnRef.locator.turnId, turnIds: history.messages.map((message) => message.messageId) }, () => { assert.equal(second.live.nativeSessionRef.locator.sessionId, first.live.nativeSessionRef.locator.sessionId); assert.notEqual(second.live.nativeTurnRef.locator.turnId, first.live.nativeTurnRef.locator.turnId); parityEqual("continuation native turn identities", nativeHistory(directContinuation.afterEntries.entries), history.messages.map((message) => message.messageId)); }),
      row("terminal_classification", nativeTurnStop(directRead.events), { status: read.result.status, stopReason: read.result.resultMetadata.stopReason, receipt: read.result.driverReceipt.receipt.outcome }, () => { assert.equal(nativeTurnStop(directRead.events), "stop"); assert.deepEqual({ status: read.result.status, stopReason: read.result.resultMetadata.stopReason, receipt: read.result.driverReceipt.receipt.outcome }, { status: "completed", stopReason: "stop", receipt: "message_end" }); }),
      row("route_drift", directCatalog.models, "driver rejected changed exact native catalog before prompt", () => { assert.ok(directCatalog.models.includes(MODEL)); assert.equal(routeDriftRejected, true); }),
      row("native_usage_source_fields", directUsage, driverUsage, () => parityEqual("provider usage fields", directUsage, driverUsage)),
      row("lifecycle_process_cleanup", directLifecycle, harnessLifecycle, () => { assert.ok(directLifecycle.every(Boolean)); assert.ok(harnessLifecycle.every(Boolean)); assertAllClosed(current); }),
      unavailable("cross_process_turn_observation_or_reconciliation", inventory.routes.turnObservation, () => { assert.equal(inventory.routes.turnObservation, "unavailable"); assert.equal(typeof inventoryHarness.driver.observeTurn, "undefined"); }),
      unavailable("automatic_recovery_exact_session_transport", inventory.routes.automaticRecovery, () => assert.equal(inventory.routes.automaticRecovery, "none")),
    ];
    for (const entry of rows.filter((item) => item.result === "pass")) {
      assert.match(entry.artifactDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assertAllClosed(current);
    return {
      schemaVersion: "pi-native-differential-v1",
      harness: "pi",
      driverVersion: inventoryHarness.driver.driverVersion,
      capabilitySchemaVersion: inventoryHarness.driver.describe().capabilitySchemaVersion,
      unprovenRows: [{ dimension: "real_user_configuration_loading", reason: "deterministic fake-native config witness only; real Pi user configuration was not loaded" }],
      rows,
    };
  } finally {
    assertAllClosed(current);
  }
}

async function sensitivity(label, exercise) {
  const current = world(label);
  try { await exercise(current); assertNoSurvivors(current); } finally { assertNoSurvivors(current); }
}

after(() => { while (ROOTS.length) fs.rmSync(ROOTS.pop(), { recursive: true, force: true }); });

describe("Pi direct-native differential parity", () => {
  it("uses an independent raw JSONL oracle and produces a byte-stable sanitized receipt", async () => {
    sourceGuard();
    const first = await evidence(); const second = await evidence();
    assert.deepEqual(second, first, "repeated zero-model evidence must be byte-identical");
    assert.deepEqual(JSON.parse(fs.readFileSync(RECEIPT, "utf8")), first);
    assert.deepEqual(first.rows.map((entry) => entry.result), ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "not_applicable", "not_applicable"]);
    assert.deepEqual(first.unprovenRows, [{ dimension: "real_user_configuration_loading", reason: "deterministic fake-native config witness only; real Pi user configuration was not loaded" }]);
  });

  it("rejects behavioral mutations rather than trusting receipt digests", async () => {
    await sensitivity("catalog", async (current) => {
      const direct = await directInventory(nativeInput(current, controlArgv(current)));
      setConfig(current, { catalog: { "openai-codex/gpt-5.6-terra": ["low"] } });
      const subject = harness(current); const inspected = await inspect(current, subject);
      mustFail(() => parityEqual("catalog", { models: direct.models, efforts: direct.effortsByModel }, { models: inspected.routes.models, efforts: inspected.routes.effortsByModel }));
    });
    await sensitivity("config", async (current) => {
      const direct = await directInventory(nativeInput(current, controlArgv(current)));
      setConfig(current, { configWitness: "sha256:mutated-config" });
      const subject = harness(current); await inspect(current, subject);
      mustFail(() => parityEqual("config", direct.nativeConfiguration.configWitness, controlRecord(current).configWitness));
    });
    await sensitivity("events", async (current) => {
      const direct = await directTurn({ ...nativeInput(current, turnArgv(current, "55555555-5555-4555-8555-555555555555")), task: "events" });
      setConfig(current, { eventOrder: ["turn_started", "tool_call", "agent_settled", "message_end"] });
      const subject = harness(current); const output = await completed(current, subject, { task: "events" });
      mustFail(() => parityEqual("events", eventTypes(direct.events), eventTypes(sessionRecord(current, output.live.nativeSessionRef.locator.sessionId))));
    });
    await sensitivity("authority", async (current) => {
      const direct = await directTurn({ ...nativeInput(current, turnArgv(current, "66666666-6666-4666-8666-666666666666")), task: "authority" });
      setConfig(current, { requiredArgv: "--native-write-authority", requiredPromptText: "native-only-authority" });
      const subject = harness(current);
      const failure = await assert.rejects(launch(current, subject, { authority: "behavioral_write", task: "authority" }));
      mustFail(() => parityEqual("authority input", nativeTurnStop(direct.events), failure?.cause ? "accepted" : "rejected"));
    });
    await sensitivity("continuation", async (current) => {
      const session = "77777777-7777-4777-8777-777777777777";
      await directTurn({ ...nativeInput(current, turnArgv(current, session)), task: "first" });
      const direct = await directTurn({ ...nativeInput(current, turnArgv(current, session, true)), task: "second" });
      const firstSubject = harness(current); const first = await completed(current, firstSubject, { task: "first", turnId: "t1" });
      setConfig(current, { reuseNativeTurnId: true });
      const secondSubject = harness(current); const second = await completed(current, secondSubject, { task: "second", turnId: "t2", nativeSessionRef: first.live.nativeSessionRef });
      const history = await secondSubject.driver.readAssistantHistory({ route: second.route, nativeSessionRef: first.live.nativeSessionRef }, { limit: 2, workspaceRoot: current.root });
      mustFail(() => parityEqual("continuation native identities", nativeHistory(direct.afterEntries.entries), history.messages.map((message) => message.messageId)));
    });
    await sensitivity("usage", async (current) => {
      const direct = await directTurn({ ...nativeInput(current, turnArgv(current, "88888888-8888-4888-8888-888888888888")), task: "usage" });
      setConfig(current, { usageDelta: { toolCalls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      const subject = harness(current); const output = await completed(current, subject, { task: "usage" });
      mustFail(() => parityEqual("usage", usageDelta(direct.beforeStats, direct.afterStats), { input_tokens: output.result.metrics.provider_reported.input_tokens, output_tokens: output.result.metrics.provider_reported.output_tokens, cache_creation_input_tokens: output.result.metrics.provider_reported.cache_creation_input_tokens, cache_read_input_tokens: output.result.metrics.provider_reported.cache_read_input_tokens, tool_call_count: output.result.metrics.plugin_observed.tool_call_count }));
    });
    await sensitivity("terminal", async (current) => {
      const direct = await directTurn({ ...nativeInput(current, turnArgv(current, "99999999-9999-4999-8999-999999999999")), task: "terminal" });
      setConfig(current, { terminalStopReason: "error" });
      const subject = harness(current); const output = await completed(current, subject, { task: "terminal" });
      mustFail(() => parityEqual("terminal", nativeTurnStop(direct.events), output.result.resultMetadata.stopReason));
    });
    await sensitivity("cleanup", async (current) => {
      const direct = await directInventory(nativeInput(current, controlArgv(current)));
      setConfig(current, { ignoreSigterm: true });
      const subject = harness(current); await inspect(current, subject);
      await waitForCapturedExit(subject);
      mustFail(() => parityEqual("cleanup", direct.record.closed, controlRecord(current).closed));
    });
  });
});
