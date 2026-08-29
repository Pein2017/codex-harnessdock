/**
 * Source-independent, zero-model-cost Claude native differential evidence.
 *
 * The direct control is intentionally isolated in `fixtures/native-parity` and
 * imports Node built-ins only. The HarnessDock side uses the production V2
 * Driver, supervisor, and adapter against exactly that executable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { runDirectClaude } from "./fixtures/native-parity/claude-direct-control.mjs";
import {
  CLAUDE_CODE_HARNESS_ID,
  createClaudeCodeDriverV2,
} from "../../runtime/claude-code-driver.mjs";
import {
  isDriverPreTransportRejection,
  validateLiveHarnessTurn,
  validatePreparedTurn,
} from "../../runtime/harness-contract.mjs";
import { createDriverScope, acceptDriverRoute, inspectDriverInstances } from "../../runtime/harness-registry.mjs";
import { transitionJob, writeJobFile } from "../../runtime/job-store.mjs";
import { runClaudeTaskSession } from "../../runtime/job-supervisor.mjs";

const ROOTS = [];
const PRIOR_RUNTIME_HOME = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "native-parity");
const FAKE_CLAUDE = path.join(FIXTURES, "fake-claude-cli.mjs");
const RECEIPT_PATH = path.join(FIXTURES, "claude-differential-receipt.json");

const TASK_INPUT = "inspect the fake native control";
const FOLLOW_UP_INPUT = "continue on the exact native session";
const CONTROL_RECOVERY_INPUT = "continue the exact native session without replay";
const MODEL = "claude-sonnet-5";
const EFFORT = "high";
const SESSION = "native-session-s";

const PROVEN_ROWS = [
  "baseline_argv_environment",
  "benign_config_inheritance_witness",
  "task_native_input",
  "closed_harnessdock_policy_delta",
  "write_authority_delta",
  "ordered_stream_tool_events",
  "interrupt_behavior",
  "terminal_classification",
  "route_drift",
  "provider_native_usage_source_fields",
  "process_lifecycle_cleanup",
];
const UNPROVEN_ROWS = [
  {
    row: "exact_resume_same_session_fresh_process_mechanics",
    reason: "the fake protocol exposes no provider-native persistent turn key; a distinct child PID is not native turn identity",
  },
  {
    row: "exact_session_transport_recovery_without_duplicate_input",
    reason: "same session and non-duplicated input lack a provider-defined accepted-turn or recovery binding",
  },
];
const NOT_APPLICABLE = {
  oldTurnObservation: "turnObservation is unavailable in the current Claude route capability snapshot",
};
const HOLD = {
  dimension: "exact_dynamic_claude_model_effort_inventory",
  result: "HOLD",
  reason: "zero-prompt native controls do not establish the exact selectable full model and effort catalog",
  fallbackUsed: false,
  staticCatalogUsed: false,
};

after(() => {
  if (PRIOR_RUNTIME_HOME == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = PRIOR_RUNTIME_HOME;
  while (ROOTS.length) fs.rmSync(ROOTS.pop(), { recursive: true, force: true });
});

function directArgs(resumeSessionId = null) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--input-format", "stream-json", "--replay-user-messages", "--include-hook-events",
    "--model", MODEL, "--effort", EFFORT,
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

function directArgsWithEffort(effort) {
  const args = directArgs();
  args[args.indexOf("--effort") + 1] = effort;
  return args;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-claude-native-parity-"));
  const workspace = path.join(root, "workspace");
  const configDir = path.join(root, "claude-config");
  const log = path.join(root, "fake-claude.jsonl");
  fs.mkdirSync(workspace);
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "native-parity-config.json"),
    `${JSON.stringify({ witness: "config-inherited-v1" })}\n`,
  );
  ROOTS.push(root);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
  let turn = 0;
  return {
    root,
    workspace,
    log,
    nextTurnId() {
      turn += 1;
      return `native-parity-turn-${turn}`;
    },
    clearLog() { fs.writeFileSync(log, ""); },
    env(scenario) {
      return {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
        CLAUDE_PARITY_CONFIG_WITNESS: "config-inherited-v1",
        CLAUDE_PARITY_LOG: log,
        CLAUDE_PARITY_SCENARIO: scenario,
        CODEX_HARNESSDOCK_CLAUDE_BIN: FAKE_CLAUDE,
        CODEX_HARNESSDOCK_CLAUDE_RECONNECT_ATTEMPTS: "1",
        CODEX_HARNESSDOCK_CLAUDE_RECONNECT_BASE_DELAY_MS: "1",
      };
    },
  };
}

function turnLogs(test) {
  if (!fs.existsSync(test.log)) return [];
  return fs.readFileSync(test.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "turn");
}

function projectDriverEvent(event) {
  if (event?.kind === "system" && event.subtype === "init") return "init";
  if (event?.kind === "result") return `result:${event.data?.subtype ?? "unknown"}`;
  if (event?.kind === "tool_use") return `tool:${event.tool}:${event.inputKeys.join(",")}`;
  return event?.kind === "text" ? `text:${event.text}` : null;
}

function providerFields(terminal) {
  const usage = terminal?.usage ?? {};
  return {
    duration_ms: terminal?.duration_ms ?? null,
    duration_api_ms: terminal?.duration_api_ms ?? null,
    turn_count: terminal?.num_turns ?? null,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    reported_cost_usd: terminal?.total_cost_usd ?? null,
  };
}

function normalizeEphemeral(value, test) {
  if (typeof value !== "string") return value;
  return value.split(test.root).join("<ROOT>");
}

function logObservation(record, test) {
  return {
    argv: record.args,
    environment: Object.fromEntries(
      Object.entries(record.env).map(([key, value]) => [key, normalizeEphemeral(value, test)]),
    ),
    configWitness: record.configWitness,
    nativeInput: record.input,
  };
}

function pidExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function launchDriver(test, {
  scenario,
  taskInput,
  authority = "behavioral_read_only",
  nativeSessionRef = undefined,
  preparedTurnOptions = null,
  scopeTurnOptions = preparedTurnOptions,
}) {
  const stream = [];
  let initializedResolve;
  const initialized = new Promise((resolve) => { initializedResolve = resolve; });
  const env = test.env(scenario);
  const nativeDriver = createClaudeCodeDriverV2({
    env,
    runTurnSession: (request) => runClaudeTaskSession({
      ...request,
      onProgress(event) {
        const projection = projectDriverEvent(event);
        if (projection) {
          stream.push(projection);
          if (projection === "init") initializedResolve();
        }
      },
    }),
  });
  const driver = {
    ...nativeDriver,
    // This fixture runs exactly one direct CLI model/effort pair. It projects
    // that observed pair only; it does not advertise a general Claude roster.
    async inspectInstances(scope) {
      return (await nativeDriver.inspectInstances(scope)).map((inspection) => (
        inspection.readiness === "ready"
          ? { ...inspection, routes: { ...inspection.routes, models: [MODEL], effortsByModel: { [MODEL]: [EFFORT] } } }
          : inspection
      ));
    },
  };
  const inspectionScope = createDriverScope({
    driver,
    purpose: "inspect",
    rootId: "native-parity-root",
    workspaceRoot: test.workspace,
    env,
  });
  const inspections = await inspectDriverInstances(driver, inspectionScope);
  const route = acceptDriverRoute(driver, {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    model: MODEL,
    topology: "leaf",
    authority,
    effort: EFFORT,
  }, inspections).route;
  const turnId = test.nextTurnId();
  writeJobFile(test.workspace, turnId, {
    id: turnId,
    workspaceRoot: test.workspace,
    status: "running",
    acceptingSteering: true,
  });
  const scope = createDriverScope({
    driver,
    purpose: "turn",
    rootId: "native-parity-root",
    agentId: "native-parity-agent",
    turnId,
    attemptId: `${turnId}-attempt-1`,
    route,
    taskInput,
    turnOptions: scopeTurnOptions,
    assignedInputs: [],
    workspaceRoot: test.workspace,
    env,
  });
  const preparedTurn = validatePreparedTurn(
    driver.prepareTurn({ route, taskInput, turnOptions: preparedTurnOptions, turnId }),
    { driver, route, taskInput },
  );
  const launchContext = await driver.revalidatePreparedTurn(preparedTurn, scope);
  const result = {
    route,
    stream,
    turnId,
    initialized,
  };
  try {
    const live = await driver.startTurn({
      scope,
      preparedTurn,
      launchContext,
      ...(nativeSessionRef === undefined ? {} : { nativeSessionRef }),
    });
    return { ...result, wrapper: validateLiveHarnessTurn(live, { driver, route }) };
  } catch (startError) {
    return { ...result, startError };
  }
}

function settleDriverJob(test, launched, result) {
  const terminalStatus = result.status === "completed"
    ? "completed"
    : result.status === "interrupted" ? "interrupted" : "failed";
  const settled = transitionJob(test.workspace, launched.turnId, ["running"], terminalStatus, {
    threadId: result.continuation.nativeSessionRef?.locator.sessionId ?? null,
    completedAt: new Date().toISOString(),
  });
  assert.equal(settled.transitioned, true, "terminal Driver result releases its exact-session lease");
}

function completedControl(control, record, test) {
  return {
    ...logObservation(record, test),
    eventProjection: control.eventProjection,
    terminal: { status: "completed", failureClass: null, finalMessage: control.terminal?.result ?? null },
    provider: providerFields(control.terminal),
    cleanup: { childExited: pidExited(control.pid) },
  };
}

function completedHarness(result, record, stream, test) {
  return {
    ...logObservation(record, test),
    eventProjection: stream,
    terminal: { status: result.status, failureClass: result.failure.class, finalMessage: result.finalMessage },
    provider: result.metrics.provider_reported,
    cleanup: { childExited: pidExited(record.pid) },
  };
}

function splitHarnessPolicyArgs(argv) {
  const baseline = [];
  const delta = { appendSystemPrompt: null, disallowedTools: [], dangerouslySkipPermissions: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--append-system-prompt") {
      assert.equal(delta.appendSystemPrompt, null, "one HarnessDock authority prompt");
      delta.appendSystemPrompt = argv[index + 1] ?? null;
      index += 1;
    } else if (value === "--disallowedTools") {
      delta.disallowedTools.push(argv[index + 1] ?? null);
      index += 1;
    } else if (value === "--dangerously-skip-permissions") {
      assert.equal(delta.dangerouslySkipPermissions, false, "one HarnessDock permission flag");
      delta.dangerouslySkipPermissions = true;
    } else {
      baseline.push(value);
    }
  }
  return { baseline, delta };
}

function assertNativeBaseline(args) {
  for (const policyFlag of ["--append-system-prompt", "--disallowedTools", "--dangerously-skip-permissions"]) {
    assert.equal(args.includes(policyFlag), false, `direct native baseline excludes ${policyFlag}`);
  }
}

function assertClosedPolicyDelta(control, harness) {
  const { baseline, delta } = splitHarnessPolicyArgs(harness.argv);
  assert.deepEqual(control.argv, baseline, "native baseline argv plus only the closed HarnessDock delta");
  assert.deepEqual(
    control.environment,
    { ...harness.environment, IS_SANDBOX: null },
    "only IS_SANDBOX differs from the native baseline environment",
  );
  assert.equal(typeof delta.appendSystemPrompt, "string", "bounded authority prompt exists");
  assert.ok(delta.appendSystemPrompt.length > 0 && delta.appendSystemPrompt.length <= 4096);
  assert.ok(delta.disallowedTools.length > 0 && delta.disallowedTools.length <= 64);
  assert.equal(delta.disallowedTools.every((tool) => typeof tool === "string" && tool.length > 0), true);
  assert.equal(delta.dangerouslySkipPermissions, true);
  return delta;
}

function maskAuthorityPrompt(argv) {
  const masked = [...argv];
  const index = masked.indexOf("--append-system-prompt");
  assert.notEqual(index, -1, "HarnessDock authority prompt exists");
  assert.equal(masked.indexOf("--append-system-prompt", index + 1), -1, "one authority prompt");
  masked[index + 1] = "<AUTHORITY_PROMPT>";
  return masked;
}

function assertWriteAuthorityDelta(readHarness, writeHarness) {
  const readPolicy = splitHarnessPolicyArgs(readHarness.argv);
  const writePolicy = splitHarnessPolicyArgs(writeHarness.argv);
  assert.deepEqual(maskAuthorityPrompt(readHarness.argv), maskAuthorityPrompt(writeHarness.argv));
  assert.deepEqual(readPolicy.baseline, writePolicy.baseline, "native transport argv");
  assert.deepEqual(readPolicy.delta.disallowedTools, writePolicy.delta.disallowedTools, "tool-denial bytes");
  assert.equal(readPolicy.delta.dangerouslySkipPermissions, writePolicy.delta.dangerouslySkipPermissions);
  assert.notEqual(readPolicy.delta.appendSystemPrompt, writePolicy.delta.appendSystemPrompt, "authority prompt text");
  assert.deepEqual(readHarness.environment, writeHarness.environment, "native environment");
  assert.deepEqual(readHarness.configWitness, writeHarness.configWitness, "inherited config witness");
  assert.deepEqual(readHarness.nativeInput, writeHarness.nativeInput, "native task input");
}

function assertCompletedParity(control, harness) {
  assertNativeBaseline(control.argv);
  assertClosedPolicyDelta(control, harness);
  assert.deepEqual(control.configWitness, harness.configWitness, "benign config inheritance witness");
  assert.deepEqual(control.nativeInput, harness.nativeInput, "native task input");
  assert.deepEqual(control.eventProjection, harness.eventProjection, "ordered stream/tool projection");
  assert.deepEqual(control.terminal, harness.terminal, "terminal classification");
  assert.deepEqual(control.provider, harness.provider, "provider-native usage fields");
  assert.deepEqual(control.cleanup, harness.cleanup, "process cleanup");
}

function assertRejectsMutation(label, assertion) {
  assert.throws(assertion, undefined, `${label} mutation must fail its behavioral comparator`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function renderReceipt(rows) {
  return `${JSON.stringify({
    schema: "harnessdock.claude-native-differential-parity.v1",
    subject: "test-owned fake Claude CLI, direct Node control, and production Claude Driver v2/adapter",
    normalization: { ephemeralRoot: "<ROOT>", processPid: "<PID>" },
    provenRows: rows,
    hold: HOLD,
    notApplicable: NOT_APPLICABLE,
    unprovenRows: UNPROVEN_ROWS,
  }, null, 2)}\n`;
}

describe("Claude native differential parity", () => {
  it("compares a direct native control with the production Driver/adapter and renders only proven evidence", async () => {
    const test = fixture();

    // Normal terminal parity: the executable records the actual argv, selected
    // environment, configured witness, stdin, and native stream on each side.
    test.clearLog();
    const direct = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(),
      cwd: test.workspace,
      env: test.env("normal"),
      input: TASK_INPUT,
    });
    const control = completedControl(direct, turnLogs(test).at(-1), test);
    test.clearLog();
    const launched = await launchDriver(test, { scenario: "normal", taskInput: TASK_INPUT });
    const result = await launched.wrapper.result;
    settleDriverJob(test, launched, result);
    const harnessLog = turnLogs(test).at(-1);
    const harness = completedHarness(result, harnessLog, launched.stream, test);
    assertCompletedParity(control, harness);
    assert.equal(result.driverVersion, "claude-code@3");
    assert.equal(harness.cleanup.childExited, true);
    assertRejectsMutation("copied-policy oracle", () =>
      assertNativeBaseline([...control.argv, "--disallowedTools", "baseline"]));

    // Each normal-row comparator must reject a behavioral change, rather than
    // accepting a static fixture hash.
    for (const [label, mutate] of [
      ["argv", (value) => { value.argv[0] = "--wrong"; }],
      ["environment/config", (value) => { value.environment.CLAUDE_PARITY_CONFIG_WITNESS = "changed"; }],
      ["authority native input", (value) => { value.nativeInput = "different task"; }],
      ["stream/tool order", (value) => { [value.eventProjection[1], value.eventProjection[2]] = [value.eventProjection[2], value.eventProjection[1]]; }],
      ["terminal and usage source", (value) => { value.provider.output_tokens += 1; }],
      ["cleanup", (value) => { value.cleanup.childExited = false; }],
    ]) {
      const mutated = clone(harness);
      mutate(mutated);
      assertRejectsMutation(label, () => assertCompletedParity(control, mutated));
    }

    // `write` may change the authority prompt only. The actual native argv,
    // environment, config witness, transport, and denial bytes must otherwise
    // remain identical to the read turn without duplicating policy text here.
    test.clearLog();
    const writeLaunched = await launchDriver(test, {
      scenario: "normal",
      taskInput: TASK_INPUT,
      authority: "behavioral_write",
    });
    const writeResult = await writeLaunched.wrapper.result;
    settleDriverJob(test, writeLaunched, writeResult);
    const writeHarness = completedHarness(writeResult, turnLogs(test).at(-1), writeLaunched.stream, test);
    assertWriteAuthorityDelta(harness, writeHarness);
    const writeMutation = clone(writeHarness);
    writeMutation.argv[writeMutation.argv.indexOf("--disallowedTools") + 1] = "changed-denial";
    assertRejectsMutation("write tool-denial delta", () => assertWriteAuthorityDelta(harness, writeMutation));

    // The native control accepts an altered effort argv, while the production
    // Driver refuses a scope/prepared-route disagreement before any fake
    // native child can receive a prompt. This is route-drift evidence, not a
    // claim that the fake or a static table discovered a real Claude catalog.
    test.clearLog();
    const directRouteDrift = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgsWithEffort("low"),
      cwd: test.workspace,
      env: test.env("normal"),
      input: TASK_INPUT,
    });
    const controlRouteDrift = {
      requestedEffort: "low",
      nativeAttempted: true,
      completed: directRouteDrift.exitCode === 0,
    };
    test.clearLog();
    const driverRouteDrift = await launchDriver(test, {
      scenario: "normal",
      taskInput: TASK_INPUT,
      preparedTurnOptions: { effort: EFFORT },
      scopeTurnOptions: { effort: "low" },
    });
    const harnessRouteDrift = {
      preparedEffort: EFFORT,
      requestedEffort: "low",
      nativeAttempted: turnLogs(test).length > 0,
      pretransportRefusal: isDriverPreTransportRejection(driverRouteDrift.startError),
    };
    const assertRouteDrift = (controlValue, harnessValue) => {
      assert.equal(controlValue.requestedEffort, harnessValue.requestedEffort);
      assert.equal(controlValue.nativeAttempted, true);
      assert.equal(controlValue.completed, true);
      assert.equal(harnessValue.preparedEffort, EFFORT);
      assert.equal(harnessValue.nativeAttempted, false);
      assert.equal(harnessValue.pretransportRefusal, true);
    };
    assertRouteDrift(controlRouteDrift, harnessRouteDrift);
    const routeMutation = clone(harnessRouteDrift);
    routeMutation.nativeAttempted = true;
    assertRejectsMutation("route drift", () => assertRouteDrift(controlRouteDrift, routeMutation));

    // This observes same-session/fresh-process mechanics only. A child PID is
    // not a provider-native turn key, so this remains explicitly unproven.
    test.clearLog();
    const directFirst = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(),
      cwd: test.workspace,
      env: test.env("normal"),
      input: TASK_INPUT,
    });
    const directSecond = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(directFirst.sessionId),
      cwd: test.workspace,
      env: test.env("normal"),
      input: FOLLOW_UP_INPUT,
    });
    const directContinuationLogs = turnLogs(test);
    const controlContinuation = {
      session: [directFirst.sessionId, directSecond.sessionId],
      resume: directContinuationLogs[1].resume,
      freshProcess: directFirst.pid !== directSecond.pid,
    };
    test.clearLog();
    const driverFirst = await launchDriver(test, { scenario: "normal", taskInput: TASK_INPUT });
    const driverFirstResult = await driverFirst.wrapper.result;
    settleDriverJob(test, driverFirst, driverFirstResult);
    const driverFirstLog = turnLogs(test).at(-1);
    const driverSecond = await launchDriver(test, {
      scenario: "normal",
      taskInput: FOLLOW_UP_INPUT,
      nativeSessionRef: driverFirstResult.continuation.nativeSessionRef,
    });
    const driverSecondResult = await driverSecond.wrapper.result;
    settleDriverJob(test, driverSecond, driverSecondResult);
    const driverContinuationLogs = turnLogs(test);
    const harnessContinuation = {
      session: [
        driverFirstResult.continuation.nativeSessionRef.locator.sessionId,
        driverSecondResult.continuation.nativeSessionRef.locator.sessionId,
      ],
      resume: driverContinuationLogs[1].resume,
      freshProcess: driverFirstLog.pid !== driverContinuationLogs[1].pid,
    };
    assert.deepEqual(controlContinuation, harnessContinuation, "same-session/fresh-process mechanics");
    const continuationMutation = clone(harnessContinuation);
    continuationMutation.session[1] = "wrong-session";
    assertRejectsMutation("session/new-turn identity", () =>
      assert.deepEqual(controlContinuation, continuationMutation, "same-session/fresh-process mechanics"));
    const processMutation = clone(harnessContinuation);
    processMutation.freshProcess = false;
    assertRejectsMutation("fresh-process is not turn identity", () =>
      assert.deepEqual(controlContinuation, processMutation, "same-session/fresh-process mechanics"));

    // The protocol demonstrates input-count mechanics only. It has no
    // provider-defined accepted-turn/recovery binding, so receipt status is
    // unproven even though the Driver path is production supervisor/adapter.
    test.clearLog();
    const directRecoveryFirst = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(),
      cwd: test.workspace,
      env: test.env("recover"),
      input: TASK_INPUT,
    });
    const directRecoverySecond = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(directRecoveryFirst.sessionId),
      cwd: test.workspace,
      env: test.env("recover"),
      input: CONTROL_RECOVERY_INPUT,
    });
    const directRecoveryLogs = turnLogs(test);
    const controlRecovery = {
      session: [directRecoveryFirst.sessionId, directRecoverySecond.sessionId],
      originalInputCount: directRecoveryLogs.filter((entry) => entry.input === TASK_INPUT).length,
      resume: directRecoveryLogs[1].resume,
      recoveryInputDiffers: directRecoveryLogs[1].input !== TASK_INPUT,
    };
    test.clearLog();
    const driverRecovery = await launchDriver(test, { scenario: "recover", taskInput: TASK_INPUT });
    const driverRecoveryResult = await driverRecovery.wrapper.result;
    settleDriverJob(test, driverRecovery, driverRecoveryResult);
    const driverRecoveryLogs = turnLogs(test);
    const harnessRecovery = {
      session: [SESSION, driverRecoveryResult.continuation.nativeSessionRef.locator.sessionId],
      originalInputCount: driverRecoveryLogs.filter((entry) => entry.input === TASK_INPUT).length,
      resume: driverRecoveryLogs[1].resume,
      recoveryInputDiffers: driverRecoveryLogs[1].input !== TASK_INPUT,
    };
    assert.deepEqual(controlRecovery, harnessRecovery, "exact-session transport recovery");
    assert.equal(driverRecoveryResult.progress.recoveryAttempts, 1);
    const recoveryMutation = clone(harnessRecovery);
    recoveryMutation.originalInputCount = 2;
    assertRejectsMutation("duplicate-input recovery", () =>
      assert.deepEqual(controlRecovery, recoveryMutation, "exact-session transport recovery"));

    // Direct SIGINT and the production requestInterrupt path both settle one
    // classified interrupted terminal turn; neither infers a hidden observer.
    test.clearLog();
    const directInterrupt = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(),
      cwd: test.workspace,
      env: test.env("interrupt"),
      input: TASK_INPUT,
      interrupt: true,
    });
    const controlInterrupt = {
      interrupted: directInterrupt.exitCode === 130 && directInterrupt.terminal?.subtype === "error_during_execution",
      cleanup: pidExited(directInterrupt.pid),
    };
    test.clearLog();
    const driverInterrupt = await launchDriver(test, { scenario: "interrupt", taskInput: TASK_INPUT });
    await driverInterrupt.initialized;
    const interruptReceipt = await driverInterrupt.wrapper.requestInterrupt({ commandId: "interrupt-1", kind: "interrupt" });
    const driverInterruptResult = await driverInterrupt.wrapper.result;
    settleDriverJob(test, driverInterrupt, driverInterruptResult);
    const interruptLog = turnLogs(test).at(-1);
    const harnessInterrupt = {
      interrupted: interruptReceipt.requestState === "requested" && driverInterruptResult.status === "interrupted" &&
        driverInterruptResult.failure.class === "cancelled_or_interrupted",
      cleanup: pidExited(interruptLog.pid),
    };
    assert.deepEqual(controlInterrupt, harnessInterrupt, "interrupt behavior");

    // The source terminal fields, rather than an invented usage estimate,
    // classify the limit result and feed the closed provider metric projection.
    test.clearLog();
    const directUsage = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(),
      cwd: test.workspace,
      env: test.env("usage"),
      input: TASK_INPUT,
    });
    const controlUsage = {
      terminal: { status: "failed", failureClass: "usage_or_subscription_limit" },
      provider: providerFields(directUsage.terminal),
    };
    test.clearLog();
    const driverUsage = await launchDriver(test, { scenario: "usage", taskInput: TASK_INPUT });
    const driverUsageResult = await driverUsage.wrapper.result;
    settleDriverJob(test, driverUsage, driverUsageResult);
    const harnessUsage = {
      terminal: { status: driverUsageResult.status, failureClass: driverUsageResult.failure.class },
      provider: driverUsageResult.metrics.provider_reported,
    };
    assert.deepEqual(controlUsage, harnessUsage, "terminal and provider-native usage classification");

    // A direct resumed native subject reporting a different session and the
    // production Driver both reject identity drift; no old-turn observer is claimed.
    const stableSessionRef = driverFirstResult.continuation.nativeSessionRef;
    test.clearLog();
    const directDrift = await runDirectClaude({
      executable: FAKE_CLAUDE,
      args: directArgs(SESSION),
      cwd: test.workspace,
      env: test.env("drift"),
      input: FOLLOW_UP_INPUT,
    });
    const controlDrift = { expected: SESSION, observed: directDrift.sessionId, disposition: "refused" };
    test.clearLog();
    const driverDrift = await launchDriver(test, {
      scenario: "drift",
      taskInput: FOLLOW_UP_INPUT,
      nativeSessionRef: stableSessionRef,
    });
    const driverDriftResult = await driverDrift.wrapper.result;
    settleDriverJob(test, driverDrift, driverDriftResult);
    const harnessDrift = {
      expected: SESSION,
      observed: "native-session-drift",
      disposition: driverDriftResult.failure.class === "protocol_session_drift" ? "refused" : "accepted",
    };
    assert.deepEqual(controlDrift, harnessDrift, "exact-session identity drift");
    const driftMutation = clone(harnessDrift);
    driftMutation.observed = SESSION;
    assertRejectsMutation("session identity drift", () =>
      assert.deepEqual(controlDrift, driftMutation, "exact-session identity drift"));

    // The checked-in receipt is sanitized and reproducible: it contains only
    // rows that the comparators above reached plus the frozen exact-route HOLD.
    assert.equal(renderReceipt(PROVEN_ROWS), fs.readFileSync(RECEIPT_PATH, "utf8"));
  });

  it("keeps the direct native control source-independent", () => {
    for (const file of ["claude-direct-control.mjs", "fake-claude-cli.mjs"]) {
      const source = fs.readFileSync(path.join(FIXTURES, file), "utf8");
      assert.doesNotMatch(source, /(?:from|require\()\s*["'][^"']*runtime\//);
      assert.doesNotMatch(source, /claude-code-driver|claude-headless-adapter|execution-profile|terminal-metrics/);
    }
  });
});
