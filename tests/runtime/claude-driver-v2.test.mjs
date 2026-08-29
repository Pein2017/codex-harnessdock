/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tasks 6.1/6.2: the Claude Code stream-json session behind Driver Contract v2.
 *
 * These tests never launch Claude. They drive the Driver through its internal
 * session seam exactly like the existing parity fixtures, so what is proven
 * here is the Driver-contract boundary — live-turn shape, durable locator,
 * admitted live methods, and the native/execution/continuation translation —
 * not the native protocol, which its established owners already cover.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  CLAUDE_CODE_HARNESS_ID,
  CLAUDE_CODE_V2_DRIVER_VERSION,
  CLAUDE_CODE_DRIVER_VERSION,
  claudeCodeInstanceKey,
  createClaudeCodeDriver,
  createClaudeCodeDriverV2,
  reconcileLegacyClaudeInstanceKey,
  resolveClaudeInstanceKey,
} from "../../runtime/claude-code-driver.mjs";
import {
  DRIVER_CONTRACT_VERSION_V2,
  MAX_FINAL_MESSAGE_CHARS,
  admittedDriverDescription,
  durableTurnEvidence,
  isDriverPreTransportRejection,
  validateCanonicalRoute,
  validateDriverV2,
  validateLiveHarnessTurn,
  validateNormalizedTerminalResult,
  validatePreparedTurn,
} from "../../runtime/harness-contract.mjs";
import {
  ADMITTED_DRIVER_V2_HARNESS_IDS,
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
  resolveDriverV2,
  resolveHarnessDriver,
} from "../../runtime/harness-registry.mjs";
import { classifyTurnSettlement, isPublishableTerminal } from "../../runtime/turn-settlement.mjs";
import { createExecutionProfile } from "../../runtime/execution-profile.mjs";
import { writeJobFile } from "../../runtime/job-store.mjs";
import { DEFAULT_EFFORT_BY_MODEL, VALID_EFFORTS } from "../../runtime/claude-headless-adapter.mjs";

const priorHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const roots = [];
after(() => {
  if (priorHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

/** One scratch workspace with its own durable state home. */
function scratch(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-claude-v2-${label}-`));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "state-home");
  return workspace;
}

const CONFIG_DIR = "/data/fixture/.claude";
const EXECUTABLE = "/usr/local/bin/claude";

function fixedEnv(overrides = {}) {
  return { CLAUDE_CONFIG_DIR: CONFIG_DIR, PATH: "/usr/bin", ...overrides };
}

function hostSeams(overrides = {}) {
  return {
    observeAvailability: () => ({ available: true, detail: "claude 2.0.0" }),
    observeAuth: () => ({ available: true, loggedIn: true, detail: "logged in" }),
    observeCompatibility: () => ({
      staticCompatible: true,
      version: "2.0.0",
      fingerprint: "fingerprint-1",
      executable: EXECUTABLE,
    }),
    // The executable-identity re-proof is the compatibility owner's; these
    // tests never place a real Claude binary on disk.
    revalidateCompatibility: (_cwd, compatibility) => compatibility,
    ...overrides,
  };
}

/**
 * One fake stream-json session. It accepts the child before any prompt byte,
 * exactly like the real runner's `onSpawn` fence, and settles only when the
 * test says so.
 */
function fakeSession(options = {}) {
  const {
    spawn = true,
    pid = 4242,
    pidIdentity = "883412",
    result = null,
    startError = null,
    autoSettle = true,
  } = options;
  const state = { requests: [], spawnAccepted: null, settle: null, fail: null };
  const run = async (request) => {
    state.requests.push(request);
    if (spawn) {
      state.spawnAccepted = await request.onSpawn({ pid, pidIdentity });
    }
    if (startError) throw startError;
    if (autoSettle) return result ?? claudeResult();
    return new Promise((resolve, reject) => {
      state.settle = (value) => resolve(value ?? result ?? claudeResult());
      state.fail = reject;
    });
  };
  return { run, state };
}

/** A completed native Claude session result, in the shape the session owner returns. */
function claudeResult(overrides = {}) {
  return {
    status: "completed",
    exitCode: 0,
    sessionId: "session-abc",
    finalMessage: "the work is done",
    failureClass: null,
    failureReason: null,
    resumable: false,
    requiresAttention: false,
    assistantOutputObserved: true,
    toolUses: ["Read(runtime/index.mjs)"],
    touchedFiles: [],
    attempts: [{ attempt: 1, status: "completed", toolUses: ["Read(runtime/index.mjs)"] }],
    recoveryAttempts: 0,
    steering: { pendingCount: 0, unacknowledgedCount: 0, latestAcknowledgedSequence: 0, lastSequence: 0 },
    runtimeReceipt: { claudeCodeVersion: "2.0.0" },
    providerReportedMetrics: { duration_ms: 1200, input_tokens: 90, output_tokens: 40 },
    lastByteAt: "2026-08-15T00:00:00.000Z",
    stderr: null,
    warning: null,
    ...overrides,
  };
}

function makeDriver(overrides = {}) {
  const session = overrides.session ?? fakeSession();
  const driver = createClaudeCodeDriverV2({
    env: overrides.env ?? fixedEnv(),
    runTurnSession: session.run,
    requestInterrupt: overrides.requestInterrupt ?? (() => ({ requested: true, requestFailure: null })),
    recordCompatibilityObservation: () => ({ recorded: true, compatibility: { version: "2.0.0" } }),
    ...hostSeams(overrides.host ?? {}),
  });
  return { driver, session };
}

function inspectScope(driver, overrides = {}) {
  return createDriverScope({
    driver,
    purpose: "inspect",
    rootId: "root-1",
    workspaceRoot: "/workspace",
    env: fixedEnv(),
    ...overrides,
  });
}

async function acceptRoute(driver, request = {}) {
  const inspections = await inspectDriverInstances(driver, inspectScope(driver));
  return acceptDriverRoute(driver, {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    model: "claude-sonnet-5",
    topology: "leaf",
    authority: "behavioral_read_only",
    effort: request.effort ?? DEFAULT_EFFORT_BY_MODEL.get(request.model ?? "claude-sonnet-5"),
    ...request,
  }, inspections).route;
}

function turnScope(driver, route, overrides = {}) {
  return createDriverScope({
    driver,
    purpose: "turn",
    rootId: "root-1",
    agentId: "agent-1",
    turnId: overrides.turnId ?? "cc-turn-1",
    attemptId: "attempt-1",
    route,
    taskInput: overrides.taskInput ?? "read the module and report",
    turnOptions: overrides.turnOptions ?? null,
    assignedInputs: [],
    workspaceRoot: overrides.workspaceRoot ?? "/workspace",
    env: fixedEnv(),
  });
}

/** Prepare, revalidate, and start one turn through the full Driver boundary. */
async function startTurn(driver, options = {}) {
  const route = options.route ?? await acceptRoute(driver, options.request);
  const taskInput = options.taskInput ?? "read the module and report";
  const turnOptions = options.turnOptions ?? null;
  const scope = turnScope(driver, route, { ...options, taskInput, turnOptions });
  const preparedTurn = validatePreparedTurn(
    driver.prepareTurn({ route, taskInput, turnOptions, turnId: scope.turnId }),
    { driver, route, taskInput },
  );
  const launchContext = await driver.revalidatePreparedTurn(preparedTurn, scope);
  const live = await driver.startTurn({
    scope,
    preparedTurn,
    launchContext,
    ...(options.nativeSessionRef !== undefined ? { nativeSessionRef: options.nativeSessionRef } : {}),
  });
  return { route, scope, preparedTurn, live, wrapper: validateLiveHarnessTurn(live, { driver, route }) };
}

// ---------------------------------------------------------------------------
// 6.1 — admission, instances, route, prepared turn
// ---------------------------------------------------------------------------

describe("Claude Code Driver Contract v2 admission", () => {
  it("admits the wrapped Claude Driver without changing the version-one Driver", () => {
    const { driver } = makeDriver();
    assert.equal(validateDriverV2(driver), driver);
    assert.equal(driver.contractVersion, DRIVER_CONTRACT_VERSION_V2);
    assert.equal(driver.harnessId, CLAUDE_CODE_HARNESS_ID);
    assert.equal(driver.driverVersion, CLAUDE_CODE_V2_DRIVER_VERSION);
    assert.notEqual(CLAUDE_CODE_V2_DRIVER_VERSION, CLAUDE_CODE_DRIVER_VERSION);

    const description = admittedDriverDescription(driver);
    assert.equal(description.contractVersion, DRIVER_CONTRACT_VERSION_V2);
    assert.equal(description.capabilitySchemaVersion, 2);
    assert.deepEqual(description.environmentKeys, ["CLAUDE_CONFIG_DIR"]);
    assert.equal(description.maturity, "experimental");

    // The version-one Driver keeps its own object, contract, and behavior.
    const legacy = createClaudeCodeDriver();
    assert.equal(legacy.contractVersion, 1);
    assert.notEqual(legacy, driver);
    assert.equal(resolveHarnessDriver(CLAUDE_CODE_HARNESS_ID, { env: fixedEnv() }).contractVersion, 1);
  });

  it("resolves the wrapped Driver from the static in-tree version-two registry", () => {
    // The multi-Harness generation admits three Harnesses at Driver Contract v2;
    // this Driver is still resolved from the static in-tree table by identity.
    assert.equal(ADMITTED_DRIVER_V2_HARNESS_IDS.includes(CLAUDE_CODE_HARNESS_ID), true);
    assert.deepEqual([...ADMITTED_DRIVER_V2_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    const resolved = resolveDriverV2(CLAUDE_CODE_HARNESS_ID, { env: fixedEnv() });
    assert.equal(resolved.harnessId, CLAUDE_CODE_HARNESS_ID);
    assert.equal(resolved.contractVersion, DRIVER_CONTRACT_VERSION_V2);
    assert.throws(() => resolveDriverV2("fake-service"), /Unknown Harness fake-service/);
  });

  it("implements exactly the operations its route capabilities admit", async () => {
    const { driver } = makeDriver();
    for (const operation of [
      "describe", "inspectInstances", "validateRoute", "prepareTurn", "revalidatePreparedTurn",
      "validateNativeSessionRef", "validateNativeTurnRef", "startTurn",
    ]) {
      assert.equal(typeof driver[operation], "function", operation);
    }
    // History is admitted, so its method exists; terminal observation is not,
    // so a lost worker stays honestly unknown rather than reconciling from a
    // Claude process that no longer exists.
    assert.equal(typeof driver.readAssistantHistory, "function");
    assert.equal(driver.observeTurn, undefined);
    const route = await acceptRoute(driver);
    assert.equal(route.capabilities.values.turnObservation, "unavailable");
    assert.equal(route.capabilities.values.history, "assistant_messages");
  });
});

describe("Claude Code logical instance inspection", () => {
  it("reports one stable redacted instance for the fixed native configuration", async () => {
    const { driver } = makeDriver();
    const instances = await inspectDriverInstances(driver, inspectScope(driver));
    assert.equal(instances.length, 1);
    const [instance] = instances;
    assert.equal(instance.harnessId, CLAUDE_CODE_HARNESS_ID);
    assert.match(instance.instanceKey, /^claude-config-[0-9a-f]{16}$/);
    assert.equal(instance.readiness, "ready");
    assert.equal(instance.detailCode, "ready");
    assert.equal(instance.liveValidated, true);
    // The key never leaks the configuration path it identifies.
    assert.equal(instance.instanceKey.includes("data"), false);
    assert.equal(instance.instanceKey.includes("claude-code"), false);

    // Stable for one configuration, distinct across configurations.
    assert.equal(claudeCodeInstanceKey(CONFIG_DIR), claudeCodeInstanceKey(CONFIG_DIR));
    assert.notEqual(claudeCodeInstanceKey(CONFIG_DIR), claudeCodeInstanceKey("/data/other/.claude"));
  });

  it("reports each unready host fact with its own closed detail code", async () => {
    const cases = [
      [{ observeAvailability: () => ({ available: false, detail: "not found" }) }, "unavailable", "executable_missing"],
      [{ observeCompatibility: () => ({ staticCompatible: false, version: "0.1.0", fingerprint: "f", executable: EXECUTABLE }) },
        "blocked", "incompatible_version"],
      [{ observeAuth: () => ({ available: true, loggedIn: false, detail: "not logged in" }) },
        "blocked", "not_authenticated"],
      [{ observeAvailability: () => { throw new Error("host probe failed"); } }, "unknown", "unknown"],
    ];
    for (const [host, readiness, detailCode] of cases) {
      const { driver } = makeDriver({ host });
      const [instance] = await inspectDriverInstances(driver, inspectScope(driver));
      assert.equal(instance.readiness, readiness, detailCode);
      assert.equal(instance.detailCode, detailCode);
      assert.equal(instance.liveValidated, readiness !== "unknown");
      assert.equal(instance.routes, null);
    }
  });

  it("blocks an instance whose declared configuration is not this Driver's", async () => {
    const { driver } = makeDriver();
    const [instance] = await inspectDriverInstances(
      driver,
      inspectScope(driver, { env: fixedEnv({ CLAUDE_CONFIG_DIR: "/data/elsewhere/.claude" }) }),
    );
    assert.equal(instance.instanceKey, claudeCodeInstanceKey(CONFIG_DIR));
    assert.equal(instance.readiness, "blocked");
    assert.equal(instance.detailCode, "not_configured");
    assert.equal(instance.liveValidated, false);
  });

  it("refuses a route whose only instance is not ready", async () => {
    const { driver } = makeDriver({ host: { observeAuth: () => ({ available: true, loggedIn: false }) } });
    await assert.rejects(async () => acceptRoute(driver), /no ready logical instance/);
  });
});

describe("Claude Code canonical route validation", () => {
  it("returns the caller's exact explicit route with a closed capability snapshot", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    assert.deepEqual(route.capabilities.values, {
      interaction: "noninteractive_fixed_policy",
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "assistant_messages",
      interruptRequest: "supported",
      turnObservation: "unavailable",
      automaticRecovery: "exact_session_transport",
      // terminal-parity always passes the dangerous bypass, so write intent
      // stays a prompt-level authority boundary, never a process sandbox.
      authorityEnforcement: "prompt_only",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
    });
    assert.equal(route.model, "claude-sonnet-5");
    assert.equal(route.topology, "leaf");
    assert.equal(route.authority, "behavioral_read_only");
    assert.equal(route.driverVersion, CLAUDE_CODE_V2_DRIVER_VERSION);
  });

  it("route-qualifies the native delegation capabilities by topology", async () => {
    const { driver } = makeDriver();
    const orchestrator = await acceptRoute(driver, {
      model: "claude-opus-5",
      topology: "native_orchestrator",
      authority: "behavioral_write",
    });
    assert.equal(orchestrator.capabilities.values.nativeOrchestration, "opaque_bounded");
    assert.equal(orchestrator.capabilities.values.leafEnforcement, "unsupported");
    assert.equal(orchestrator.capabilities.values.authorityEnforcement, "prompt_only");
  });

  it("never resolves an alias, an unsupported model, or an unsupported native team route", async () => {
    const { driver } = makeDriver();
    await assert.rejects(async () => acceptRoute(driver, { model: "opus" }), /exact model/);
    await assert.rejects(async () => acceptRoute(driver, { model: "gpt-5", effort: "high" }), /Unsupported Claude model/);
    await assert.rejects(
      async () => acceptRoute(driver, { model: "claude-sonnet-5", topology: "native_orchestrator" }),
      /claude_orchestrator delegation requires exact model/,
    );
  });

  it("validates the returned route through the shared contract owner", async () => {
    const { driver } = makeDriver();
    const inspections = await inspectDriverInstances(driver, inspectScope(driver));
    const request = {
      harnessId: CLAUDE_CODE_HARNESS_ID,
      model: "claude-haiku-4-5",
      topology: "leaf",
      authority: "behavioral_read_only",
      effort: "high",
    };
    const route = validateCanonicalRoute(
      driver.validateRoute(request, inspections[0]),
      { driver, inspection: inspections[0], request },
    );
    assert.equal(route.instanceKey, inspections[0].instanceKey);
  });
});

describe("Claude Code prepared turn", () => {
  it("adds only the authority, topology, and return facts it actually sends", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const prepared = validatePreparedTurn(
      driver.prepareTurn({ route, taskInput }),
      { driver, route, taskInput },
    );
    assert.deepEqual(
      Object.keys(prepared.promptEnvelope).sort(),
      ["authority", "returnContract", "taskInput", "topology"],
    );
    assert.equal(prepared.promptEnvelope.taskInput, taskInput);
    // The envelope is not a second prompt owner: its three facts recompose the
    // exact delegation prompt `execution-profile.mjs` sends to the CLI.
    const profile = createExecutionProfile({
      model: route.model,
      delegationMode: "leaf",
      write: false,
      env: fixedEnv(),
      jobId: "cc-turn-1",
    });
    profile.cleanup();
    assert.equal(
      [
        prepared.promptEnvelope.returnContract,
        prepared.promptEnvelope.topology,
        prepared.promptEnvelope.authority,
      ].join(" "),
      profile.claudeOptions.appendSystemPrompt,
    );
  });

  it("binds a domain-separated digest to the exact task input", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const first = driver.prepareTurn({ route, taskInput: "task one" });
    const again = driver.prepareTurn({ route, taskInput: "task one" });
    const other = driver.prepareTurn({ route, taskInput: "task two" });
    assert.match(first.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.inputDigest, again.inputDigest);
    assert.notEqual(first.inputDigest, other.inputDigest);
  });

  it("re-proves the host executable immediately before the native turn", async () => {
    let probes = 0;
    const { driver } = makeDriver({
      host: {
        observeCompatibility: () => {
          probes += 1;
          return probes > 1
            ? { staticCompatible: false, version: "0.1.0", fingerprint: "f", executable: EXECUTABLE }
            : { staticCompatible: true, version: "2.0.0", fingerprint: "fingerprint-1", executable: EXECUTABLE };
        },
      },
    });
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const prepared = validatePreparedTurn(
      driver.prepareTurn({ route, taskInput }),
      { driver, route, taskInput },
    );
    await assert.rejects(
      async () => driver.revalidatePreparedTurn(prepared, turnScope(driver, route)),
      /Claude Code/,
    );
  });

  it("refuses a prepared turn that belongs to another logical instance", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const prepared = validatePreparedTurn(
      driver.prepareTurn({ route, taskInput }),
      { driver, route, taskInput },
    );
    const foreign = { ...prepared, route: { ...route, instanceKey: "claude-config-0000000000000000" } };
    await assert.rejects(
      async () => driver.revalidatePreparedTurn(foreign, turnScope(driver, route)),
      /logical instance/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6.3 — turn-scoped reasoning effort has a real Driver v2 transport
// ---------------------------------------------------------------------------

describe("Claude Code turn-scoped effort", () => {
  it("sends the caller's exact admitted effort for every explicit value, never the host default", async () => {
    for (const effort of VALID_EFFORTS) {
      const session = fakeSession({ autoSettle: false });
      const { driver } = makeDriver({ session });
      const { wrapper } = await startTurn(driver, { turnOptions: { effort } });
      assert.equal(session.state.requests[0].claudeOptions.effort, effort);
      session.state.settle(claudeResult());
      await wrapper.result;
    }
  });

  it("defaults turn-scoped effort per model instead of silently inheriting the host default", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    assert.equal(session.state.requests[0].claudeOptions.effort, DEFAULT_EFFORT_BY_MODEL.get(route.model));
    session.state.settle(claudeResult());
    await wrapper.result;
  });

  it("rejects a foreign effort value and an unknown turn option before any request crosses the transport", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    assert.throws(
      () => driver.prepareTurn({ route, taskInput: "read the module", turnOptions: { effort: "extreme" } }),
      /Unsupported effort/,
    );
    assert.throws(
      () => driver.prepareTurn({ route, taskInput: "read the module", turnOptions: { model: "haiku" } }),
      /unknown field/,
    );
  });

  it("snapshots turn options trap-free before interpreting effort, with zero hook execution", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";

    let getterCalls = 0;
    let proxyGetTraps = 0;
    let proxyOwnKeysTraps = 0;
    let proxyGetOwnPropertyDescriptorTraps = 0;

    const inheritedProto = { effort: "high" };
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "effort", { value: "high", enumerable: false });
    const accessor = {};
    Object.defineProperty(accessor, "effort", {
      get() { getterCalls += 1; return "high"; },
      enumerable: true,
      configurable: true,
    });
    const symbolKeyed = { [Symbol("effort")]: "high" };
    const pollutingKey = JSON.parse('{"__proto__":{"effort":"high"}}');
    const proxied = new Proxy({ effort: "high" }, {
      get(target, prop, receiver) { proxyGetTraps += 1; return Reflect.get(target, prop, receiver); },
      ownKeys(target) { proxyOwnKeysTraps += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) {
        proxyGetOwnPropertyDescriptorTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });

    for (const [label, malicious] of [
      ["inherited-prototype", Object.create(inheritedProto)],
      ["non-enumerable", nonEnumerable],
      ["accessor", accessor],
      ["symbol-keyed", symbolKeyed],
      ["prototype-polluting", pollutingKey],
      ["proxy", proxied],
      ["array", ["effort", "high"]],
      ["string", "high"],
      ["number", 42],
    ]) {
      // The label alone identifies the failing shape; never touch `malicious`
      // itself to build a message, or the message construction becomes a
      // second, uncounted read of the very shape under test.
      assert.throws(
        () => driver.prepareTurn({ route, taskInput, turnOptions: malicious }),
        undefined,
        `expected rejection for ${label}`,
      );
    }

    // No adversarial shape may ever have reached a hook: refusal happens
    // before any trap or getter executes.
    assert.equal(getterCalls, 0);
    assert.equal(proxyGetTraps, 0);
    assert.equal(proxyOwnKeysTraps, 0);
    assert.equal(proxyGetOwnPropertyDescriptorTraps, 0);
  });

  it("reads turn options from one detached fixed-point snapshot", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const turnOptions = { effort: "low" };
    const prepared = driver.prepareTurn({ route, taskInput, turnOptions });
    // Mutating the caller's own object after preparation must never reach the
    // already-captured value: the Driver read it exactly once.
    turnOptions.effort = "high";
    const repeat = driver.prepareTurn({ route, taskInput, turnOptions: { effort: "low" } });
    assert.equal(prepared.inputDigest, repeat.inputDigest);
  });

  it("binds a different turn-scoped effort to a different prepared digest", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const low = driver.prepareTurn({ route, taskInput, turnOptions: { effort: "low" } });
    const high = driver.prepareTurn({ route, taskInput, turnOptions: { effort: "high" } });
    const repeatLow = driver.prepareTurn({ route, taskInput, turnOptions: { effort: "low" } });
    assert.match(low.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(low.inputDigest, high.inputDigest);
    assert.equal(low.inputDigest, repeatLow.inputDigest);
  });

  it("refuses to start a turn whose scope requests a different effort than its prepared digest (TOCTOU)", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const preparedTurn = validatePreparedTurn(
      driver.prepareTurn({ route, taskInput, turnOptions: { effort: "low" } }),
      { driver, route, taskInput },
    );
    const scope = turnScope(driver, route, { taskInput, turnOptions: { effort: "high" } });
    const launchContext = await driver.revalidatePreparedTurn(preparedTurn, scope);
    await assert.rejects(
      async () => driver.startTurn({ scope, preparedTurn, launchContext }),
      (error) => {
        assert.equal(isDriverPreTransportRejection(error), true);
        return /different effort cannot reuse the same prepared turn/.test(error.cause?.message ?? "");
      },
    );
    assert.deepEqual(session.state.requests, []);
  });
});

// ---------------------------------------------------------------------------
// 6.3 — exact-session continuation through the v2 prepared/start path
// ---------------------------------------------------------------------------

describe("Claude Code exact-session continuation", () => {
  it("resumes the caller's validated native session id and keeps active input working after resume", async () => {
    const workspace = scratch("resume");
    writeJobFile(workspace, "resume-turn-2", {
      id: "resume-turn-2",
      workspaceRoot: workspace,
      status: "running",
      acceptingSteering: true,
    });
    const first = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session: first });
    const started = await startTurn(driver, { workspaceRoot: workspace, turnId: "resume-turn-1" });
    first.state.settle(claudeResult({ sessionId: "session-original" }));
    const firstResult = await started.wrapper.result;
    assert.equal(firstResult.continuation.mode, "exact_resume");
    const nativeSessionRef = firstResult.continuation.nativeSessionRef;

    const second = fakeSession({ autoSettle: false });
    const { driver: driver2 } = makeDriver({ session: second });
    const resumed = await startTurn(driver2, {
      workspaceRoot: workspace,
      turnId: "resume-turn-2",
      nativeSessionRef,
    });
    assert.equal(second.state.requests[0].claudeOptions.resumeSessionId, "session-original");

    const receipt = await resumed.wrapper.deliverActiveInput({
      messageId: "msg-after-resume",
      text: "also check the tests",
      sequence: 1,
    });
    assert.equal(receipt.accepted, true);

    second.state.settle(claudeResult({ sessionId: "session-original" }));
    const resumedResult = await resumed.wrapper.result;
    assert.equal(resumedResult.continuation.mode, "exact_resume");
  });

  it("refuses a native session reference foreign to this Driver or instance before any request crosses the transport", async () => {
    const { driver } = makeDriver();
    const route = await acceptRoute(driver);
    for (const foreign of [
      { version: 1, harnessId: "opencode", driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION, instanceKey: route.instanceKey, locatorVersion: 1, locator: { sessionId: "s" } },
      { version: 1, harnessId: CLAUDE_CODE_HARNESS_ID, driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION, instanceKey: "claude-config-0000000000000000", locatorVersion: 1, locator: { sessionId: "s" } },
      { version: 1, harnessId: CLAUDE_CODE_HARNESS_ID, driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION, instanceKey: route.instanceKey, locatorVersion: 1, locator: { turnId: "not-a-session" } },
    ]) {
      const session = fakeSession({ autoSettle: false });
      const { driver: scopedDriver } = makeDriver({ session, env: fixedEnv() });
      await assert.rejects(
        async () => startTurn(scopedDriver, { route, nativeSessionRef: foreign }),
        (error) => {
          assert.equal(isDriverPreTransportRejection(error), true);
          return true;
        },
      );
      assert.deepEqual(session.state.requests, []);
    }
  });

  it("keeps a native-orchestrator turn on zero bounded reconnect attempts while a leaf turn inherits the default", async () => {
    const leafSession = fakeSession({ autoSettle: false });
    const { driver: leafDriver } = makeDriver({ session: leafSession });
    const leaf = await startTurn(leafDriver);
    assert.equal("retryPolicy" in leafSession.state.requests[0], false);
    leafSession.state.settle(claudeResult());
    await leaf.wrapper.result;

    const orchestratorSession = fakeSession({ autoSettle: false });
    const { driver: orchestratorDriver } = makeDriver({ session: orchestratorSession });
    const orchestrator = await startTurn(orchestratorDriver, {
      request: { model: "claude-opus-5", topology: "native_orchestrator", authority: "behavioral_read_only" },
    });
    assert.deepEqual(orchestratorSession.state.requests[0].retryPolicy, { maxReconnectAttempts: 0 });
    orchestratorSession.state.settle(claudeResult());
    await orchestrator.wrapper.result;
  });
});

// ---------------------------------------------------------------------------
// 6.3 — legacy/version-two instance identity reconciliation
// ---------------------------------------------------------------------------

describe("Claude Code instance identity reconciliation", () => {
  it("reconciles the legacy canonical instance key with this Driver's redacted instance key without leaking the path", async () => {
    const { driver } = makeDriver();
    const [instance] = await inspectDriverInstances(driver, inspectScope(driver));
    const legacyInstanceKey = resolveClaudeInstanceKey(fixedEnv());
    const reconciled = reconcileLegacyClaudeInstanceKey(legacyInstanceKey);
    assert.equal(reconciled, instance.instanceKey);
    assert.equal(reconciled, claudeCodeInstanceKey(CONFIG_DIR));
    assert.match(reconciled, /^claude-config-[0-9a-f]{16}$/);
    assert.equal(reconciled.includes("data"), false);
    assert.equal(reconciled.includes("fixture"), false);

    assert.notEqual(
      reconcileLegacyClaudeInstanceKey(legacyInstanceKey),
      reconcileLegacyClaudeInstanceKey(resolveClaudeInstanceKey(fixedEnv({ CLAUDE_CONFIG_DIR: "/data/other/.claude" }))),
    );
  });
});

// ---------------------------------------------------------------------------
// 6.1 — the process-local live turn
// ---------------------------------------------------------------------------

describe("Claude Code live turn", () => {
  it("returns a live handle at proven child acceptance, before the turn ends", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const { wrapper } = await startTurn(driver);

    assert.equal(session.state.spawnAccepted, true);
    let settled = false;
    void wrapper.result.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the live handle must be returned before the turn settles");

    // The prompt is written only after the supervisor-visible acceptance.
    assert.equal(session.state.requests.length, 1);
    assert.equal(session.state.requests[0].prompt, "read the module and report");

    session.state.settle(claudeResult());
    const result = await wrapper.result;
    assert.equal(result.status, "completed");
  });

  it("binds the durable locator to the verified child process identity", async () => {
    const session = fakeSession({ autoSettle: false, pid: 5150, pidIdentity: "912345" });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);

    assert.deepEqual(wrapper.nativeTurnRef, Object.freeze({
      version: 1,
      harnessId: CLAUDE_CODE_HARNESS_ID,
      driverVersion: CLAUDE_CODE_V2_DRIVER_VERSION,
      instanceKey: route.instanceKey,
      locatorVersion: 1,
      locator: Object.freeze({ pid: 5150, processIdentity: "912345" }),
    }));
    // No native session is proven at acceptance, so none is fabricated.
    assert.equal(wrapper.nativeSessionRef, null);
    assert.deepEqual(durableTurnEvidence(wrapper), {
      nativeTurnRef: wrapper.nativeTurnRef,
      nativeSessionRef: null,
    });
    session.state.settle(claudeResult());
    await wrapper.result;
  });

  it("proves no request crossed the native boundary when the child is never accepted", async () => {
    for (const options of [
      { spawn: false, startError: new Error("spawn ENOENT claude") },
      // A session that ends before any child was accepted wrote no prompt byte
      // either, so it is the same proof rather than an ambiguous submission.
      { spawn: false, result: claudeResult({ status: "failed", failureClass: "fatal" }) },
    ]) {
      const session = fakeSession(options);
      const { driver } = makeDriver({ session });
      await assert.rejects(
        async () => startTurn(driver),
        (error) => {
          assert.equal(isDriverPreTransportRejection(error), true);
          return true;
        },
      );
    }
  });

  it("proves every pre-session refusal was never submitted", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const route = await acceptRoute(driver);
    const taskInput = "read the module and report";
    const prepared = validatePreparedTurn(
      driver.prepareTurn({ route, taskInput }),
      { driver, route, taskInput },
    );
    const launchContext = await driver.revalidatePreparedTurn(prepared, turnScope(driver, route));
    for (const broken of [
      { scope: turnScope(driver, route, { taskInput: "a different task" }), preparedTurn: prepared, launchContext },
      { scope: turnScope(driver, route), preparedTurn: prepared, launchContext: { compatibility: {} } },
      {
        scope: turnScope(driver, route),
        preparedTurn: {
          ...prepared,
          promptEnvelope: { ...prepared.promptEnvelope, authority: "you may do anything" },
        },
        launchContext,
      },
    ]) {
      await assert.rejects(
        async () => driver.startTurn(broken),
        (error) => {
          assert.equal(isDriverPreTransportRejection(error), true);
          return true;
        },
      );
    }
    // Not one of them reached the session owner.
    assert.deepEqual(session.state.requests, []);
  });

  it("refuses an interrupt command kind it cannot request", async () => {
    const signals = [];
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({
      session,
      requestInterrupt: (pid) => { signals.push(pid); return { requested: true, requestFailure: null }; },
    });
    const { wrapper } = await startTurn(driver);
    const receipt = await wrapper.requestInterrupt({ commandId: "cmd-9", kind: "cancel" });
    assert.equal(receipt.requestState, "unsupported");
    assert.deepEqual(signals, []);
    session.state.settle(claudeResult());
    await wrapper.result;
  });

  it("never turns a completed turn without an accepted child into a rejection", async () => {
    // The session owner writes no prompt before acceptance, so this cannot
    // happen; if it ever did, the attempt is ambiguous, never replay-safe.
    const session = fakeSession({ spawn: false, result: claudeResult() });
    const { driver } = makeDriver({ session });
    await assert.rejects(
      async () => startTurn(driver),
      (error) => {
        assert.equal(isDriverPreTransportRejection(error), false);
        return /cannot be proven either way/.test(error.message);
      },
    );
  });

  it("keeps an ambiguous post-acceptance failure out of the pre-transport proof", async () => {
    const session = fakeSession({ startError: new Error("stream closed after prompt delivery") });
    const { driver } = makeDriver({ session });
    // The child was accepted, so prompt bytes may have crossed the boundary:
    // the live turn exists and only its completion promise fails.
    const { wrapper } = await startTurn(driver);
    await assert.rejects(
      async () => wrapper.result,
      (error) => {
        assert.equal(isDriverPreTransportRejection(error), false);
        return /stream closed after prompt delivery/.test(error.message);
      },
    );
  });

  it("delivers active input as durable stream input and proves a refusal", async () => {
    const workspace = scratch("input");
    writeJobFile(workspace, "cc-turn-1", {
      id: "cc-turn-1",
      workspaceRoot: workspace,
      status: "running",
      acceptingSteering: true,
    });
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const { wrapper } = await startTurn(driver, { workspaceRoot: workspace });

    const receipt = await wrapper.deliverActiveInput({
      messageId: "msg-1",
      text: "also check the tests",
      sequence: 1,
    });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.sequence, 1);
    assert.equal(receipt.mode, "durable_stream_input");

    // The same message identity is idempotent, never a second queued entry.
    const repeat = await wrapper.deliverActiveInput({
      messageId: "msg-1",
      text: "also check the tests",
      sequence: 1,
    });
    assert.equal(repeat.accepted, true);
    assert.equal(repeat.sequence, 1);

    // A turn that stopped accepting input proves the entry never crossed the
    // boundary, so the supervisor may requeue it for a later turn.
    writeJobFile(workspace, "cc-turn-1", {
      id: "cc-turn-1",
      workspaceRoot: workspace,
      status: "running",
      acceptingSteering: false,
    });
    const refused = await wrapper.deliverActiveInput({
      messageId: "msg-2",
      text: "and this one",
      sequence: 2,
    });
    assert.equal(refused.accepted, false);
    assert.equal(typeof refused.reason, "string");
    session.state.settle(claudeResult());
    await wrapper.result;
  });

  it("acknowledges an interrupt request without settling the turn", async () => {
    const requests = [];
    const session = fakeSession({ autoSettle: false, pid: 4242, pidIdentity: "883412" });
    const { driver } = makeDriver({
      session,
      requestInterrupt: (pid, pidIdentity) => {
        requests.push({ pid, pidIdentity });
        return { requested: true, requestFailure: null };
      },
    });
    const { wrapper } = await startTurn(driver);
    // Requesting interruption must resolve promptly and structurally: it
    // never waits for a bounded post-signal observation window.
    const start = Date.now();
    const receipt = await wrapper.requestInterrupt({
      commandId: "cmd-1",
      kind: "interrupt",
      requestedAt: "2026-08-15T00:00:00.000Z",
      deadlineAt: "2026-08-15T00:01:00.000Z",
      sanitizedReason: null,
    });
    assert.ok(Date.now() - start < 200, "requestInterrupt must not block on process observation");
    assert.deepEqual(requests, [{ pid: 4242, pidIdentity: "883412" }]);
    assert.equal(receipt.commandId, "cmd-1");
    assert.equal(receipt.requestState, "accepted");
    assert.equal(receipt.settlement, "pending");
    assert.equal(receipt.nativeTurnState, "active");

    // Acceptance is not settlement: the turn is still live until its own
    // terminal evidence arrives.
    let settled = false;
    void wrapper.result.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    session.state.settle(claudeResult({
      status: "failed",
      exitCode: 130,
      failureClass: "cancelled_or_interrupted",
      failureReason: "SIGINT",
      finalMessage: "partial work",
    }));
    const result = await wrapper.result;
    assert.equal(result.status, "interrupted");
  });

  it("rejects an interrupt request it refuses to signal and never claims settlement", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({
      session,
      requestInterrupt: () => ({ requested: false, requestFailure: "identity_mismatch" }),
    });
    const { wrapper } = await startTurn(driver);
    const receipt = await wrapper.requestInterrupt({ commandId: "cmd-2", kind: "interrupt" });
    assert.equal(receipt.requestState, "rejected");
    assert.equal(receipt.settlement, "pending");
    assert.equal(receipt.nativeTurnState, "unknown");
    session.state.settle(claudeResult());
    assert.equal((await wrapper.result).status, "completed");
  });

  it("reports an unsupported interrupt request without touching the process", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({
      session,
      // A structured code, never note-text matching, decides "unsupported".
      requestInterrupt: () => ({ requested: false, requestFailure: "unsupported_platform" }),
    });
    const { wrapper } = await startTurn(driver);
    const receipt = await wrapper.requestInterrupt({ commandId: "cmd-3", kind: "interrupt" });
    assert.equal(receipt.requestState, "unsupported");
    assert.equal(receipt.settlement, "pending");
    session.state.settle(claudeResult());
    await wrapper.result;
  });

  it("never escalates a thrown interrupt request into settlement or a stranded turn", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({
      session,
      requestInterrupt: () => { throw new Error("signal delivery exploded"); },
    });
    const { wrapper } = await startTurn(driver);
    const receipt = await wrapper.requestInterrupt({ commandId: "cmd-throw", kind: "interrupt" });
    assert.equal(receipt.requestState, "rejected");
    assert.equal(receipt.settlement, "pending");
    assert.equal(receipt.nativeTurnState, "unknown");
    assert.match(receipt.detail, /signal delivery exploded/);
    // The turn itself is untouched: it can still complete normally.
    session.state.settle(claudeResult());
    assert.equal((await wrapper.result).status, "completed");
  });

  it("disposes without signalling, cancelling, or settling the native turn", async () => {
    const cancels = [];
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({
      session,
      requestInterrupt: (pid) => { cancels.push(pid); return { requested: true, requestFailure: null }; },
    });
    const { wrapper } = await startTurn(driver);
    await wrapper.dispose();
    await wrapper.dispose();
    assert.deepEqual(cancels, []);
    let settled = false;
    void wrapper.result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    session.state.settle(claudeResult());
    assert.equal((await wrapper.result).status, "completed");
  });
});

// ---------------------------------------------------------------------------
// 6.2 — native, execution, and continuation axes
// ---------------------------------------------------------------------------

describe("Claude Code terminal evidence translation", () => {
  it("publishes a completed turn with settled owned work and exact continuation", async () => {
    const { driver } = makeDriver();
    const { wrapper, route } = await startTurn(driver);
    const raw = await wrapper.result;
    const result = validateNormalizedTerminalResult(raw, { driver, route });

    assert.equal(result.status, "completed");
    assert.equal(result.nativeTurn, "terminal");
    assert.deepEqual(result.executionWorld, { continuity: "lost", settlement: "settled" });
    assert.equal(result.continuation.mode, "exact_resume");
    assert.deepEqual(result.continuation.nativeSessionRef.locator, { sessionId: "session-abc" });
    assert.equal(result.continuation.nativeSessionRef.instanceKey, route.instanceKey);
    assert.equal(result.finalMessage, "the work is done");
    assert.equal(result.finalMessageAbsenceReason, null);
    assert.equal(result.failure.class, null);
    assert.equal(result.metrics.provider_reported.duration_ms, 1200);
    assert.equal(result.metrics.plugin_observed.tool_call_count, 1);
    assert.equal(result.progress.toolUseCount, 1);
    assert.equal(isPublishableTerminal(result), true);
    // Process facts stay inside the Driver: none of them is contract evidence.
    for (const field of ["exitStatus", "exitCode", "pid", "process", "spawnAccepted", "identityProven"]) {
      assert.equal(field in result, false, field);
    }
  });

  it("keeps a session-less turn resumable-free instead of fabricating one", async () => {
    const session = fakeSession({ result: claudeResult({ sessionId: null }) });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.continuation.mode, "fresh_only");
    assert.equal(result.continuation.nativeSessionRef, null);
    assert.equal(isPublishableTerminal(result), true);
  });

  it("maps a drifted session to unknown continuation and holds nothing else back", async () => {
    const session = fakeSession({
      result: claudeResult({
        status: "failed",
        exitCode: 1,
        failureClass: "protocol_session_drift",
        failureReason: "expected session a, observed b",
        finalMessage: "",
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.status, "failed");
    assert.equal(result.continuation.mode, "unknown");
    assert.equal(result.continuation.nativeSessionRef, null);
    assert.equal(result.failure.class, "protocol_session_drift");
    assert.equal(result.finalMessage, null);
    assert.equal(result.finalMessageAbsenceReason, "protocol_session_drift");
  });

  it("classifies an interrupted turn as interrupted, not failed", async () => {
    const session = fakeSession({
      result: claudeResult({
        status: "failed",
        exitCode: 130,
        failureClass: "cancelled_or_interrupted",
        failureReason: "SIGINT",
        finalMessage: "partial",
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.status, "interrupted");
    assert.equal(result.executionWorld.settlement, "settled");
    assert.equal(result.finalMessage, "partial");
    assert.equal(isPublishableTerminal(result), true);
  });

  it("preserves the established credential and account-limit classification", async () => {
    const session = fakeSession({
      result: claudeResult({
        status: "failed",
        exitCode: 1,
        failureClass: "usage_or_subscription_limit",
        failureReason: "you have reached your usage limit",
        finalMessage: "",
        requiresAttention: true,
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.failure.class, "usage_or_subscription_limit");
    assert.equal(result.failure.requiresAttention, true);
    assert.equal(result.status, "failed");
  });

  it("maps unresolved native protocol evidence to unknown owned work", async () => {
    const session = fakeSession({
      result: claudeResult({
        status: "unknown",
        exitCode: 0,
        failureClass: "protocol_unknown",
        failureReason: "No terminal result event received despite exit code 0",
        warning: "No terminal result event received despite exit code 0",
        finalMessage: "",
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.status, "failed");
    assert.equal(result.executionWorld.settlement, "unknown");
    assert.equal(result.executionWorld.continuity, "unknown");
    assert.equal(isPublishableTerminal(result), false);
    assert.equal(classifyTurnSettlement(result).reason, "execution_settlement_unknown");
  });

  it("maps contradictory completed evidence to unknown instead of publishing it", async () => {
    const session = fakeSession({
      result: claudeResult({ status: "completed", failureClass: "fatal", failureReason: "contradiction" }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.executionWorld.settlement, "unknown");
    assert.equal(isPublishableTerminal(result), false);
    assert.equal(result.driverReceipt.receipt.settlementReason, "contradictory_native_evidence");
  });

  it("leaves the background-task experiment's unknown-event evidence non-authoritative", async () => {
    // `harden-native-background-task-completion` owns stronger Claude owned-work
    // evidence. Its accepted protocol-drift summary alone must not change this
    // classification, and this Driver must not pre-empt that decision.
    const session = fakeSession({
      result: claudeResult({
        unknownEvents: [{ type: "task_update", subtype: "started", count: 2 }],
        unknownEventCount: 2,
        unknownEventOverflowCount: 0,
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.equal(result.status, "completed");
    assert.equal(result.executionWorld.settlement, "settled");
    assert.equal(isPublishableTerminal(result), true);
    assert.equal(result.driverReceipt.receipt.unknownEventCount, 2);
  });

  it("rejects the completion promise when the native turn cannot be proven terminal", async () => {
    const session = fakeSession({ autoSettle: false });
    const { driver } = makeDriver({ session });
    const { wrapper } = await startTurn(driver);
    session.state.fail(new Error("worker lost the native transport"));
    await assert.rejects(async () => wrapper.result, /native transport/);
  });

  it("bounds native failure text, progress, and an oversized final message", async () => {
    const session = fakeSession({
      result: claudeResult({
        status: "failed",
        exitCode: 1,
        failureClass: "fatal",
        failureReason: "x".repeat(9000),
        stderr: "e".repeat(64 * 1024),
        finalMessage: "m".repeat(MAX_FINAL_MESSAGE_CHARS + 10),
        toolUses: Array.from({ length: 256 }, (_, index) => `Bash(command number ${index} ${"y".repeat(200)})`),
        touchedFiles: Array.from({ length: 256 }, (_, index) => `/workspace/file-${index}-${"z".repeat(200)}.mjs`),
        attempts: Array.from({ length: 8 }, (_, index) => ({ attempt: index + 1, status: "failed" })),
      }),
    });
    const { driver } = makeDriver({ session });
    const { wrapper, route } = await startTurn(driver);
    // Every bound is the contract owner's; validation is the proof.
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    assert.ok(result.failure.reason.length <= 2048);
    assert.ok(String(result.failure.detail).length <= 2048);
    assert.equal(result.finalMessage.length, MAX_FINAL_MESSAGE_CHARS);
    assert.equal(result.resultMetadata.finalMessageTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.progress), "utf8") <= 32 * 1024);
    assert.equal(result.progress.toolUseCount, 256);
    assert.equal(result.progress.touchedFileCount, 256);
    assert.ok(result.progress.toolUses.length < 256);
  });

  it("never carries a secret, endpoint, or configuration path in its durable references", async () => {
    const { driver } = makeDriver();
    const { wrapper, route } = await startTurn(driver);
    const result = validateNormalizedTerminalResult(await wrapper.result, { driver, route });
    const durable = JSON.stringify({
      turn: wrapper.nativeTurnRef,
      session: result.continuation.nativeSessionRef,
      receipt: result.driverReceipt,
      instance: route.instanceKey,
    });
    for (const value of [CONFIG_DIR, EXECUTABLE, "CLAUDE_CONFIG_DIR", "Bearer"]) {
      assert.equal(durable.includes(value), false, value);
    }
  });
});

describe("Claude Code Driver v2 — one host observation states both facts", () => {
  it("answers the launch preflight from the inspection it just made", async () => {
    const counts = { availability: 0, auth: 0, compatibility: 0 };
    const driver = createClaudeCodeDriverV2({
      env: fixedEnv(),
      ...hostSeams({
        observeAvailability: () => {
          counts.availability += 1;
          return { available: true, detail: "claude 2.0.0" };
        },
        observeAuth: () => {
          counts.auth += 1;
          return { available: true, loggedIn: true, detail: "logged in" };
        },
        observeCompatibility: () => {
          counts.compatibility += 1;
          return {
            staticCompatible: true,
            version: "2.0.0",
            fingerprint: "fingerprint-1",
            executable: EXECUTABLE,
          };
        },
      }),
    });

    const inspections = await driver.inspectInstances(inspectScope(driver));
    assert.equal(inspections[0].readiness, "ready");
    assert.deepEqual(counts, { availability: 1, auth: 1, compatibility: 1 });

    const preflight = driver.launchPreflightFromInspection("/workspace");
    assert.equal(preflight.ready, true);
    assert.equal(preflight.availability.available, true);
    assert.equal(preflight.compatibility.executable, EXECUTABLE);
    assert.equal(preflight.auth.loggedIn, true);
    // The whole point: no second probe of any kind.
    assert.deepEqual(counts, { availability: 1, auth: 1, compatibility: 1 });
  });

  it("states nothing for a working directory it did not just inspect", async () => {
    const { driver } = makeDriver();
    assert.equal(driver.launchPreflightFromInspection("/workspace"), null);
    await driver.inspectInstances(inspectScope(driver));
    assert.equal(driver.launchPreflightFromInspection("/some/other/workspace"), null);
    assert.notEqual(driver.launchPreflightFromInspection("/workspace"), null);
  });
});
