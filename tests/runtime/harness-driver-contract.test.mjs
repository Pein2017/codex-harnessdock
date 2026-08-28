import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { inspect } from "node:util";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { createInternalAgentRuntime } from "../../runtime/internal-runtime.mjs";
import { readJobFile } from "../../runtime/job-store.mjs";

import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
  createClaudeCodeDriver,
} from "../../runtime/claude-code-driver.mjs";
import {
  ADMITTED_INTERACTION_VALUES,
  CAPABILITY_MATURITY_VALUES,
  HARNESS_CAPABILITY_NAMES,
  HARNESS_CAPABILITY_VALUES,
  ROUTE_CAPABILITY_NAMES,
  ROUTE_CAPABILITY_SCHEMA_VERSION,
  ROUTE_CAPABILITY_VALUES,
  assertAdmittedInteraction,
  assertHarnessCapability,
  assertRouteCapability,
  capabilityMaturity,
  validateHarnessCapabilities,
  validateRouteCapabilitySnapshot,
} from "../../runtime/harness-capabilities.mjs";
import {
  DRIVER_CONTRACT_VERSION_V2,
  DRIVER_V2_OPERATIONS,
  DRIVER_V2_OPTIONAL_OPERATIONS,
  HARNESS_DRIVER_CONTRACT_VERSION,
  MAX_FINAL_MESSAGE_CHARS,
  HARNESS_DRIVER_OPERATIONS,
  PROCESS_SHAPED_FIELDS,
  PROMPT_ENVELOPE_FIELDS,
  assertDriverRouteCoherence,
  boundedDriverReceipt,
  durableTurnEvidence,
  canonicalNativeSessionRef,
  harnessSessionKey,
  validateDriverV2,
  validateHarnessDriver,
  validateHarnessTurnResult,
  validateLiveHarnessTurn,
  validateNormalizedTerminalResult,
  validatePreparedTurn,
} from "../../runtime/harness-contract.mjs";
import {
  ADMITTED_DRIVER_V2_HARNESS_IDS,
  ADMITTED_HARNESS_IDS,
  DRIVER_INSPECTION_SCOPE_FIELDS,
  DRIVER_SCOPE_FIELDS,
  acceptDriverRoute,
  admitDriverV2,
  assertNoAmbientHarnessSelector,
  assertNoHarnessImplementationSelector,
  createDriverScope,
  inspectDriverInstances,
  resolveDriverV2,
  resolveHarnessDriver,
} from "../../runtime/harness-registry.mjs";
import {
  HARNESS_TURN_FAILURE_CLASSES,
  HARNESS_TURN_FAILURE_SCOPES,
} from "../../runtime/harness-failure-classes.mjs";
import {
  FAKE_SERVICE_DRIVER_VERSION,
  createFakeServiceDriver,
} from "./fixtures/fake-service-driver.mjs";

const driver = createClaudeCodeDriver();
const scratchRoots = [];
const sharedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-driver-shared-"));
const sharedRuntimeHome = path.join(sharedRuntimeRoot, "runtime-home");
const testEnvFile = path.join(sharedRuntimeRoot, "runtime.env");
fs.writeFileSync(testEnvFile, "");

after(() => {
  while (scratchRoots.length) fs.rmSync(scratchRoots.pop(), { recursive: true, force: true });
  fs.rmSync(sharedRuntimeRoot, { recursive: true, force: true });
});

function terminalResult(overrides = {}) {
  return {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_DRIVER_VERSION,
    contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
    status: "completed",
    exitStatus: 0,
    nativeSession: {
      harnessId: CLAUDE_CODE_HARNESS_ID,
      instanceKey: "/tmp/instance",
      nativeSessionId: "session-1",
    },
    sessionExactness: "exact",
    failure: { class: null, reason: null, detail: null, resumable: false, requiresAttention: false },
    finalMessage: "done",
    finalMessageAbsenceReason: null,
    process: { spawnAccepted: true, identityProven: true },
    receipts: { toolUses: [], touchedFiles: [], attempts: [], recoveryAttempts: 0 },
    ...overrides,
  };
}

/**
 * One complete version-two route capability snapshot. Tests override exactly the
 * dimension under proof so an unrelated default never explains a failure.
 */
function routeCapabilities(overrides = {}) {
  return {
    capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    driverMaturity: "experimental",
    values: {
      interaction: "noninteractive_fixed_policy",
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "unavailable",
      interruptRequest: "supported",
      turnObservation: "terminal_observable",
      automaticRecovery: "none",
      authorityEnforcement: "harness_policy",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
    },
    maturity: {
      interaction: "validated",
      activeInput: "validated",
      continuation: "validated",
      history: "experimental",
      interruptRequest: "validated",
      turnObservation: "experimental",
      automaticRecovery: "validated",
      authorityEnforcement: "validated",
      leafEnforcement: "validated",
      nativeOrchestration: "validated",
    },
    ...overrides,
  };
}

describe("Harness Driver contract", () => {
  it("publishes one closed capability vocabulary and fails on anything outside it", () => {
    assert.deepEqual(HARNESS_CAPABILITY_NAMES, [
      "activeInput",
      "authorityEnforcement",
      "automaticRecovery",
      "continuation",
      "history",
      "interrupt",
      "leafEnforcement",
      "nativeOrchestration",
    ]);
    assert.deepEqual(HARNESS_CAPABILITY_VALUES.interrupt, [
      "graceful_flush_proven",
      "best_effort_signal",
      "unsupported",
    ]);

    const snapshot = validateHarnessCapabilities(CLAUDE_CODE_CAPABILITIES);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(
      () => validateHarnessCapabilities({ ...CLAUDE_CODE_CAPABILITIES, continuation: "maybe" }),
      /unsupported continuation value/,
    );
    assert.throws(
      () => validateHarnessCapabilities({ ...CLAUDE_CODE_CAPABILITIES, telepathy: "yes" }),
      /unknown capability: telepathy/,
    );
    const { history: _history, ...missing } = CLAUDE_CODE_CAPABILITIES;
    assert.throws(() => validateHarnessCapabilities(missing), /unsupported history value/);
  });

  it("refuses an operation the persisted snapshot does not admit", () => {
    const initialOnly = { ...CLAUDE_CODE_CAPABILITIES, activeInput: "initial_only" };
    assert.throws(
      () => assertHarnessCapability(initialOnly, "activeInput", ["acknowledged_active_stream"], "no live input"),
      /no live input \(activeInput=initial_only\)/,
    );
    assert.equal(
      assertHarnessCapability(CLAUDE_CODE_CAPABILITIES, "activeInput", ["acknowledged_active_stream"], "unused"),
      "acknowledged_active_stream",
    );
  });

  it("admits exactly the checkout-owned Claude Code Driver", () => {
    assert.deepEqual(ADMITTED_HARNESS_IDS, ["claude-code"]);
    assert.equal(CLAUDE_CODE_DRIVER_VERSION, "claude-code@2");
    // The registry holds no default Harness: every resolution states one.
    assert.throws(() => resolveHarnessDriver(undefined, { env: {} }), /explicit Harness/);
    const resolved = resolveHarnessDriver("claude-code", { env: {} });
    assert.equal(resolved.harnessId, "claude-code");
    assert.equal(resolved.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    assert.equal(resolved.contractVersion, HARNESS_DRIVER_CONTRACT_VERSION);
    assert.throws(() => resolveHarnessDriver("other-exec"), /Unknown Harness other-exec/);
    assert.throws(() => resolveHarnessDriver("Other Exec"), /Invalid Harness ID/);
  });

  it("gives each orchestrator turn a fresh job-bound team and disables only its automatic reconnect", async () => {
    const requests = [];
    const runTurnSession = async (request) => {
      requests.push(request);
      return {
        status: "failed",
        exitCode: 1,
        sessionId: "parent-session",
        finalMessage: "partial parent evidence",
        stderr: "Connection closed mid-response",
        failureClass: "transport_closed_resumable",
        failureReason: "Connection closed mid-response",
        resumable: true,
        recoveryAttempts: 0,
        attempts: [],
        steering: { messages: [], latestAcknowledgedSequence: 0 },
        runtimeReceipt: {},
        toolUses: [],
        touchedFiles: [],
      };
    };
    const launchContext = {
      compatibility: { fingerprint: "fingerprint", executable: process.execPath },
    };
    const common = {
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      prompt: "continue the bounded work",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-driver-contract" },
      launchContext,
      runTurnSession,
    };

    const first = await driver.startTurn({
      ...common,
      jobId: "orchestrator-job-one",
      route: {
        model: "claude-opus-5",
        effort: "high",
        write: false,
        delegationMode: "claude_orchestrator",
      },
    });
    const second = await driver.startTurn({
      ...common,
      jobId: "orchestrator-job-two",
      resumeSessionId: "parent-session",
      route: {
        model: "claude-opus-5",
        effort: "high",
        write: true,
        delegationMode: "claude_orchestrator",
      },
    });
    await driver.startTurn({
      ...common,
      jobId: "leaf-job",
      route: {
        model: "claude-sonnet-5",
        effort: "high",
        write: false,
        delegationMode: "leaf",
      },
    });

    assert.equal(first.failure.class, "transport_closed_resumable");
    assert.equal(first.failure.resumable, true);
    assert.equal(first.nativeSession.nativeSessionId, "parent-session");
    assert.deepEqual(requests[0].retryPolicy, { maxReconnectAttempts: 0 });
    assert.deepEqual(requests[1].retryPolicy, { maxReconnectAttempts: 0 });
    assert.equal(Object.hasOwn(requests[2], "retryPolicy"), false);
    assert.equal(requests[0].claudeOptions.resumeSessionId, undefined);
    assert.equal(requests[1].claudeOptions.resumeSessionId, "parent-session");
    assert.notEqual(
      requests[0].claudeOptions.appendSystemPrompt.match(/hd-native-team-[a-f0-9]+/)[0],
      requests[1].claudeOptions.appendSystemPrompt.match(/hd-native-team-[a-f0-9]+/)[0],
    );
  });

  it("rejects caller and ambient attempts to select a Driver implementation", () => {
    for (const key of [
      "harness_driver",
      "driver_module",
      "claude_bin",
      "claude_config_dir",
      "env_file",
      "capability_override",
    ]) {
      assert.throws(
        () => assertNoHarnessImplementationSelector({ [key]: "/somewhere" }, "spawn_agent"),
        new RegExp(`spawn_agent does not accept ${key}`),
      );
    }
    // `harness` is a route decision in the multi-Harness generation: a caller
    // must state which admitted Harness its Agent runs on, and that statement is
    // validated against the static table rather than refused here. Naming the
    // implementation behind that Harness stays refused.
    assert.doesNotThrow(() => assertNoHarnessImplementationSelector({ harness: "opencode" }, "spawn_agent"));
    assert.throws(
      () => assertNoHarnessImplementationSelector({ harness_id: "other-exec" }, "spawn_agent"),
      /spawn_agent does not accept harness_id/,
    );
    assert.doesNotThrow(() => assertNoHarnessImplementationSelector({ model: "opus" }, "spawn_agent"));
    for (const key of ["CODEX_HARNESSDOCK_HARNESS_ID", "CODEX_HARNESSDOCK_HARNESS_DRIVER_MODULE", "CODEX_HARNESSDOCK_HARNESS_CAPABILITIES"]) {
      assert.throws(
        () => assertNoAmbientHarnessSelector({ [key]: "x" }),
        new RegExp(`${key} cannot select a Harness Driver implementation`),
      );
      assert.throws(() => resolveHarnessDriver("claude-code", { env: { [key]: "x" } }));
    }
    assert.doesNotThrow(() => assertNoAmbientHarnessSelector({ CODEX_HARNESSDOCK_CLAUDE_BIN: "/usr/bin/claude" }));
  });

  it("validates a Driver module before it can own a turn", () => {
    assert.equal(validateHarnessDriver(driver), driver);
    assert.throws(
      () => validateHarnessDriver({ ...driver, contractVersion: 99 }),
      /implements contract 99/,
    );
    const { startTurn: _startTurn, ...incomplete } = driver;
    assert.throws(() => validateHarnessDriver(incomplete), /does not implement startTurn/);
    const { describeUnreadiness: _describeUnreadiness, ...noUnreadinessDescription } = driver;
    assert.throws(
      () => validateHarnessDriver(noUnreadinessDescription),
      /does not implement describeUnreadiness/,
    );
    const { validatePreparedPreflight: _validatePrepared, ...noPreparedValidation } = driver;
    assert.throws(
      () => validateHarnessDriver(noPreparedValidation),
      /does not implement validatePreparedPreflight/,
    );
    const { revalidatePreparedPreflight: _revalidatePrepared, ...noPreparedRevalidation } = driver;
    assert.throws(
      () => validateHarnessDriver(noPreparedRevalidation),
      /does not implement revalidatePreparedPreflight/,
    );
    const { readAssistantHistory: _history, ...noHistory } = driver;
    assert.throws(
      () => validateHarnessDriver(noHistory),
      /claims assistant history without implementing it/,
    );
  });

  it("normalizes one complete turn result and refuses an incomplete one", () => {
    assert.ok(validateHarnessTurnResult(terminalResult(), driver));
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({ status: "failed", exitStatus: 0 }), driver),
      /status and exit status are inconsistent/,
    );
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({
        status: "failed",
        exitStatus: 1,
        failure: { class: null, reason: "failed", resumable: false },
      }), driver),
      /must classify its failure/,
    );
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({ finalMessage: { text: "not normalized" } }), driver),
      /final message must be text/,
    );
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({ metrics: {
        version: 1,
        provider_reported: { duration_ms: 1, unknown: "payload" },
        plugin_observed: null,
      } }), driver),
      /metrics must use the closed version-one schema/,
    );
    assert.deepEqual(validateHarnessTurnResult(terminalResult({ metrics: {
      version: 1,
      provider_reported: { duration_ms: 1 },
      plugin_observed: null,
    } }), driver).metrics, {
      version: 1,
      provider_reported: {
        duration_ms: 1,
        duration_api_ms: null,
        turn_count: null,
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        reported_cost_usd: null,
      },
      plugin_observed: null,
    });
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({ harnessId: "other-exec" }), driver),
      /declares other-exec; expected claude-code/,
    );
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({ status: "pending" }), driver),
      /Unsupported Harness turn status/,
    );
    assert.throws(
      () => validateHarnessTurnResult(
        terminalResult({ sessionExactness: "exact", nativeSession: null }),
        driver,
      ),
      /Exact native session evidence requires a native session reference/,
    );
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({
        nativeSession: {
          harnessId: "other-exec",
          instanceKey: "opaque-instance",
          nativeSessionId: "session-1",
        },
      }), driver),
      /native session belongs to Harness other-exec/,
    );
    assert.throws(
      () => validateHarnessTurnResult(
        terminalResult({ finalMessage: null, finalMessageAbsenceReason: null }),
        driver,
      ),
      /final outer-assistant message or an explicit absence reason/,
    );
    assert.throws(
      () => validateHarnessTurnResult(
        terminalResult({ failure: { class: "fatal", reason: "x", resumable: false } }),
        driver,
      ),
      /completed Harness turn must not classify a failure/,
    );
    // A failed turn with no assistant text is valid when it says why.
    assert.ok(validateHarnessTurnResult(terminalResult({
      status: "failed",
      exitStatus: 1,
      sessionExactness: "unproven",
      nativeSession: null,
      failure: {
        class: "usage_or_subscription_limit",
        reason: "quota exhausted",
        resumable: false,
        requiresAttention: false,
      },
      finalMessage: null,
      finalMessageAbsenceReason: "usage_or_subscription_limit",
    }), driver));
  });

  it("closes the turn-failure vocabulary: every admitted class is accepted, a foreign class is rejected", () => {
    for (const failureClass of HARNESS_TURN_FAILURE_CLASSES) {
      assert.ok(validateHarnessTurnResult(terminalResult({
        status: "failed",
        exitStatus: 1,
        sessionExactness: "unproven",
        nativeSession: null,
        failure: { class: failureClass, reason: "x", resumable: false },
        finalMessage: null,
        finalMessageAbsenceReason: failureClass,
      }), driver), `${failureClass} must be admitted`);
    }
    assert.throws(
      () => validateHarnessTurnResult(terminalResult({
        status: "failed",
        exitStatus: 1,
        failure: { class: "not_an_admitted_class", reason: "x", resumable: false },
        finalMessage: null,
        finalMessageAbsenceReason: "not_an_admitted_class",
      }), driver),
      /is not an admitted turn-failure class/,
    );
  });

  it("rejects a supervisor-owned fact claimed as a Driver turn-failure class", () => {
    for (const supervisorFact of [
      "worker_launch_failed",
      "worker_handoff_failed",
      "worker_reaped",
      "session_binding_conflict",
      "forced_interruption_unflushed",
      "harness_incompatible",
    ]) {
      assert.throws(
        () => validateHarnessTurnResult(terminalResult({
          status: "failed",
          exitStatus: 1,
          failure: { class: supervisorFact, reason: "x", resumable: false },
          finalMessage: null,
          finalMessageAbsenceReason: supervisorFact,
        }), driver),
        /is not an admitted turn-failure class/,
        `${supervisorFact} is a supervisor-owned fact and must not be admitted as a Driver class`,
      );
    }
  });

  it("declares an explicit blocking scope for every admitted class, closed over harness/agent", () => {
    assert.equal(HARNESS_TURN_FAILURE_SCOPES.auth_or_permission, "harness");
    assert.equal(HARNESS_TURN_FAILURE_SCOPES.usage_or_subscription_limit, "harness");
    assert.equal(HARNESS_TURN_FAILURE_SCOPES.protocol_session_drift, "agent");
    for (const scope of Object.values(HARNESS_TURN_FAILURE_SCOPES)) {
      assert.ok(scope === "harness" || scope === "agent");
    }
  });

  it("runs the production supervisor boundary from normalized fields without reading native receipts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-generic-turn-"));
    scratchRoots.push(root);
    const workspace = path.join(root, "workspace");
    const claudeConfigDir = path.join(root, "claude");
    fs.mkdirSync(workspace);
    fs.mkdirSync(claudeConfigDir);
    const runtime = createInternalAgentRuntime({
      cwd: workspace,
      envFile: testEnvFile,
      env: {
        CODEX_THREAD_ID: "root-harness-generic-turn",
        CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });
    const capabilities = Object.freeze({
      ...CLAUDE_CODE_CAPABILITIES,
      activeInput: "initial_only",
      continuation: "fresh_only",
      history: "unavailable",
      interrupt: "unsupported",
      automaticRecovery: "none",
      nativeOrchestration: "disabled",
    });
    const launchContext = Object.freeze({ opaque: "test-launch-context" });
    const fakeDriver = validateHarnessDriver(Object.freeze({
      harnessId: "test-harness",
      driverVersion: "test-harness@1",
      contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
      capabilities,
      preflight: () => ({ ready: true, instanceKey: "tenant:alpha" }),
      describeUnreadiness: () => null,
      validatePreparedPreflight: (receipt) => receipt,
      revalidatePreparedPreflight: () => launchContext,
      validateRoute: (route) => route,
      resolveInstanceKey: () => "tenant:alpha",
      async startTurn(args) {
        assert.equal(args.launchContext, launchContext);
        assert.equal(Object.hasOwn(args, "executable"), false);
        assert.equal(Object.hasOwn(args, "launchCompatibility"), false);
        return {
          harnessId: "test-harness",
          driverVersion: "test-harness@1",
          contractVersion: HARNESS_DRIVER_CONTRACT_VERSION,
          status: "completed",
          exitStatus: 0,
          nativeSession: {
            harnessId: "test-harness",
            instanceKey: "tenant:alpha",
            nativeSessionId: "native-session-1",
          },
          sessionExactness: "unproven",
          failure: {
            class: null,
            reason: null,
            detail: null,
            resumable: false,
            requiresAttention: false,
          },
          finalMessage: "generic final message",
          finalMessageAbsenceReason: null,
          process: { spawnAccepted: true, identityProven: true },
          receipts: {
            toolUses: [],
            touchedFiles: [],
            attempts: [],
            recoveryAttempts: 0,
            steering: null,
          },
          runtime: { providerVersion: "test-1" },
          nativeReceipt: { mustRemainOpaque: true },
          driverReceipt: boundedDriverReceipt("test-harness", "test-harness@1", {
            privateEvidence: true,
          }),
        };
      },
      assignInput: () => ({ delivered: false }),
      interruptTurn: () => false,
      cancelTurn: () => false,
    }));
    runtime.driver = fakeDriver;
    runtime.harnessInstance = Object.freeze({ harnessId: "test-harness", instanceKey: "tenant:alpha" });

    const execution = await runtime.execute({
      id: "generic-turn-job",
      summary: "generic turn",
      harnessStateVersion: 2,
      harnessId: "test-harness",
      driverVersion: "test-harness@1",
      harnessCapabilities: capabilities,
      request: { prompt: "do the work", model: "test-model", effort: "high" },
    }, null, null, launchContext);

    assert.equal(execution.threadId, "native-session-1");
    assert.equal(execution.payload.rawOutput, "generic final message");
    assert.equal(execution.payload.runtimeReceipt.providerVersion, "test-1");
    assert.equal(Object.hasOwn(execution.payload, "mustRemainOpaque"), false);
  });

  it("keeps native session identity compatible for Claude and disjoint across Harnesses", () => {
    const reference = canonicalNativeSessionRef({
      harnessId: CLAUDE_CODE_HARNESS_ID,
      instanceKey: "/data/.claude",
      nativeSessionId: "abc-123",
    });
    // Version-1 runtimes derive sha256("<config dir>\0<session>"). Pin that
    // formula literally: the version-2 key must stay byte-identical so an old
    // runtime still observes the lease instead of stealing the live session.
    const legacy = createHash("sha256").update("/data/.claude\0abc-123").digest("hex");
    assert.equal(harnessSessionKey(reference), legacy);
    assert.notEqual(
      harnessSessionKey({ ...reference, harnessId: "other-exec" }),
      legacy,
    );
    assert.notEqual(
      harnessSessionKey({ ...reference, instanceKey: "/other/.claude" }),
      legacy,
    );
    assert.throws(
      () => canonicalNativeSessionRef({ ...reference, nativeSessionId: "../escape" }),
      /Invalid native session ID/,
    );
  });

  it("bounds opaque Driver receipts", () => {
    const small = boundedDriverReceipt(CLAUDE_CODE_HARNESS_ID, CLAUDE_CODE_DRIVER_VERSION, { attempts: 2 });
    assert.deepEqual(small.receipt, { attempts: 2 });
    const huge = boundedDriverReceipt(CLAUDE_CODE_HARNESS_ID, CLAUDE_CODE_DRIVER_VERSION, {
      blob: "x".repeat(32 * 1024),
    });
    assert.equal(huge.receipt, null);
    assert.equal(huge.omitted, "driver_receipt_exceeded_bound");
  });

  it("binds a durable turn to the contract that prepared it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-job-driver-"));
    scratchRoots.push(root);
    const workspace = path.join(root, "workspace");
    const claudeConfigDir = path.join(root, "claude");
    fs.mkdirSync(workspace);
    fs.mkdirSync(claudeConfigDir);
    const runtime = createInternalAgentRuntime({
      cwd: workspace,
      envFile: testEnvFile,
      env: {
        CODEX_THREAD_ID: "root-harness-job-driver",
        CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
        CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: "",
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });
    const prepared = {
      id: "cc-job-1",
      harnessStateVersion: 2,
      harnessId: CLAUDE_CODE_HARNESS_ID,
      driverVersion: CLAUDE_CODE_DRIVER_VERSION,
      harnessCapabilities: CLAUDE_CODE_CAPABILITIES,
    };
    assert.equal(runtime.assertJobDriver(prepared).harnessId, "claude-code");
    // A version-1 job predates Harness evidence and stays executable.
    assert.equal(runtime.assertJobDriver({ id: "cc-legacy" }).harnessId, "claude-code");

    assert.throws(
      () => runtime.assertJobDriver({ ...prepared, harnessStateVersion: 3 }),
      /carries Harness state version 3/,
    );
    assert.throws(
      () => runtime.assertJobDriver({ ...prepared, harnessId: "other-exec" }),
      /Unknown Harness other-exec/,
    );
    assert.throws(
      () => runtime.assertJobDriver({ ...prepared, driverVersion: "claude-code@1" }),
      /prepared by Driver claude-code@1/,
    );
    assert.throws(
      () => runtime.assertJobDriver({
        ...prepared,
        harnessCapabilities: { ...CLAUDE_CODE_CAPABILITIES, continuation: "fresh_only" },
      }),
      /prepared with continuation=fresh_only/,
    );
    assert.throws(
      () => runtime.assertJobDriver({
        ...prepared,
        harnessCapabilities: { ...CLAUDE_CODE_CAPABILITIES, continuation: "sometimes" },
      }),
      /unsupported continuation value/,
    );

    // Stopping a live turn stays possible across a Driver version bump; an
    // unknown capability vocabulary still fails closed.
    const drifted = { ...prepared, driverVersion: "claude-code@1" };
    assert.equal(runtime.assertJobDriver(drifted, { allowDriverVersionDrift: true }).harnessId, "claude-code");
    assert.throws(
      () => runtime.assertJobDriver(
        { ...drifted, harnessCapabilities: { ...CLAUDE_CODE_CAPABILITIES, interrupt: "eventually" } },
        { allowDriverVersionDrift: true },
      ),
      /unsupported interrupt value/,
    );
    assert.throws(
      () => runtime.assertJobDriver(
        { ...drifted, harnessId: "other-exec" },
        { allowDriverVersionDrift: true },
      ),
      /Unknown Harness other-exec/,
    );

    // A rollback must likewise refuse a queued @2 job. Process control uses
    // the persisted Harness identity/capabilities and remains separately safe.
    runtime.driver = Object.freeze({ ...runtime.driver, driverVersion: "claude-code@1" });
    assert.throws(
      () => runtime.assertJobDriver(prepared),
      /prepared by Driver claude-code@2; this runtime provides claude-code@1/,
    );
    assert.equal(
      runtime.assertJobDriver(prepared, { allowDriverVersionDrift: true }).harnessId,
      "claude-code",
    );
  });

  it("refuses durable Agent activation after Driver version or capability drift", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-agent-driver-"));
    scratchRoots.push(root);
    const workspace = path.join(root, "workspace");
    const claudeConfigDir = path.join(root, "claude");
    fs.mkdirSync(workspace);
    fs.mkdirSync(claudeConfigDir);
    const runtime = createAgentRuntime({
      cwd: workspace,
      envFile: testEnvFile,
      env: {
        CODEX_THREAD_ID: "root-harness-agent-driver",
        CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });
    const agent = runtime.store.createAgent({
      task_name: "driver_drift",
      selectedModel: "claude-sonnet-5",
      delegationMode: "leaf",
    });

    runtime.jobs.driver = Object.freeze({
      ...runtime.jobs.driver,
      driverVersion: "claude-code@future",
    });
    assert.throws(
      () => runtime.assertAgentDriver(runtime.store.resolveTarget(agent.agentId)),
      /accepted Driver .* but this runtime provides claude-code@future/,
    );
    assert.equal(
      runtime.assertAgentDriver(
        runtime.store.resolveTarget(agent.agentId),
        { allowDriverVersionDrift: true },
      ).harnessId,
      "claude-code",
    );

    runtime.jobs.driver = Object.freeze({
      ...runtime.jobs.driver,
      driverVersion: agent.driverVersion,
      capabilities: Object.freeze({
        ...runtime.jobs.driver.capabilities,
        continuation: "fresh_only",
      }),
    });
    assert.throws(
      () => runtime.assertAgentDriver(runtime.store.resolveTarget(agent.agentId)),
      /accepted continuation=exact_resume but this runtime provides continuation=fresh_only/,
    );
  });

  it("fences version-2 jobs from a version-1 worker before launch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-v1-worker-fence-"));
    scratchRoots.push(root);
    const workspace = path.join(root, "workspace");
    const claudeConfigDir = path.join(root, "claude");
    fs.mkdirSync(workspace);
    fs.mkdirSync(claudeConfigDir);
    const runtime = createInternalAgentRuntime({
      cwd: workspace,
      envFile: testEnvFile,
      env: {
        CODEX_THREAD_ID: "root-harness-v1-worker-fence",
        CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
        CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });
    const readiness = {
      ready: true,
      availability: { available: true },
      compatibility: {
        staticCompatible: true,
        fingerprint: "test-fingerprint",
        executable: process.execPath,
        version: "test",
      },
      auth: { loggedIn: true },
      cwd: runtime.cwd,
      claudeConfigDir: runtime.env.CLAUDE_CONFIG_DIR ?? null,
      sourceRoot: runtime.sourceRoot,
    };
    const prepared = runtime.prepareStart("fenced turn", {
      harnessId: runtime.driver.harnessId,
      readinessReceipt: readiness,
      jobId: "harness-v2-fence",
      model: "haiku",
      effort: "low",
    });
    const stored = readJobFile(workspace, prepared.jobId);
    assert.equal(stored.harnessStateVersion, 2);
    // The pre-Harness worker accepts only literal `queued`; this state is the
    // wire-level rollback fence, not merely advisory metadata.
    assert.equal(stored.status, "harness_queued");
  });

  it("keeps model-facing wait cadence and progress budget out of the Driver contract", () => {
    // Drivers report progress through the turn's receipts; polling cadence,
    // delivery budget, and completion priority stay with the supervisor.
    assert.deepEqual(HARNESS_DRIVER_OPERATIONS, [
      "preflight",
      "describeUnreadiness",
      "validatePreparedPreflight",
      "revalidatePreparedPreflight",
      "validateRoute",
      "resolveInstanceKey",
      "startTurn",
      "assignInput",
      "interruptTurn",
      "cancelTurn",
    ]);
    for (const name of Object.keys(driver)) {
      assert.doesNotMatch(name, /wait|progress|poll|timeout|budget/i);
    }
  });
});

describe("Driver Contract v2 route capabilities", () => {
  it("publishes the closed version-two dimensions with independent route maturity", () => {
    assert.equal(ROUTE_CAPABILITY_SCHEMA_VERSION, 2);
    assert.deepEqual(ROUTE_CAPABILITY_NAMES, [
      "activeInput",
      "authorityEnforcement",
      "automaticRecovery",
      "continuation",
      "history",
      "interaction",
      "interruptRequest",
      "leafEnforcement",
      "nativeOrchestration",
      "turnObservation",
    ]);
    assert.deepEqual(ROUTE_CAPABILITY_VALUES.interaction, [
      "noninteractive_fixed_policy",
      "requires_broker",
    ]);
    assert.deepEqual(ROUTE_CAPABILITY_VALUES.turnObservation, ["terminal_observable", "unavailable"]);
    assert.deepEqual(ROUTE_CAPABILITY_VALUES.continuation, ["exact_resume", "fresh_only", "none"]);
    assert.deepEqual(CAPABILITY_MATURITY_VALUES, ["experimental", "validated"]);

    const snapshot = validateRouteCapabilitySnapshot(routeCapabilities());
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.values), true);
    assert.equal(Object.isFrozen(snapshot.maturity), true);
    assert.equal(snapshot.values.interaction, "noninteractive_fixed_policy");
    assert.equal(capabilityMaturity(snapshot, "history"), "experimental");
    assert.equal(capabilityMaturity(snapshot, "continuation"), "validated");
  });

  it("fails closed on an unknown dimension, value, maturity, or schema version", () => {
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({ capabilitySchemaVersion: 1 })),
      /capability schema version 1/,
    );
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({
        values: { ...routeCapabilities().values, continuation: "maybe" },
      })),
      /unsupported continuation value/,
    );
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({
        values: { ...routeCapabilities().values, telepathy: "yes" },
      })),
      /unknown capability: telepathy/,
    );
    const { history: _history, ...withoutHistory } = routeCapabilities().values;
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({ values: withoutHistory })),
      /unsupported history value/,
    );
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({
        maturity: { ...routeCapabilities().maturity, history: "battle_tested" },
      })),
      /unsupported history maturity/,
    );
    const { turnObservation: _observation, ...missingMaturity } = routeCapabilities().maturity;
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({ maturity: missingMaturity })),
      /unsupported turnObservation maturity/,
    );
    assert.throws(
      () => validateRouteCapabilitySnapshot(routeCapabilities({ driverMaturity: "unknown" })),
      /unsupported Driver maturity/,
    );
  });

  it("admits only noninteractive_fixed_policy and reports a broker route unavailable", () => {
    assert.deepEqual(ADMITTED_INTERACTION_VALUES, ["noninteractive_fixed_policy"]);
    assert.equal(
      assertAdmittedInteraction(validateRouteCapabilitySnapshot(routeCapabilities())),
      "noninteractive_fixed_policy",
    );
    const broker = validateRouteCapabilitySnapshot(routeCapabilities({
      values: { ...routeCapabilities().values, interaction: "requires_broker" },
    }));
    // `requires_broker` stays discoverable so an operator can see why a route is
    // refused; it must never become an approval prompt, TUI wait, or auto-approval.
    assert.equal(broker.values.interaction, "requires_broker");
    assert.throws(
      () => assertAdmittedInteraction(broker),
      /route is unavailable: it requires an approval broker \(interaction=requires_broker\)/,
    );
  });

  it("blocks one operation on its own capability without disabling unrelated ones", () => {
    const snapshot = validateRouteCapabilitySnapshot(routeCapabilities());
    assert.throws(
      () => assertRouteCapability(snapshot, "history", ["assistant_messages"], "history is unavailable"),
      /history is unavailable \(history=unavailable\)/,
    );
    assert.equal(
      assertRouteCapability(snapshot, "interruptRequest", ["supported"], "unused"),
      "supported",
    );
    assert.equal(
      assertRouteCapability(snapshot, "activeInput", ["acknowledged_active_stream"], "unused"),
      "acknowledged_active_stream",
    );
    assert.throws(
      () => assertRouteCapability(snapshot, "telepathy", ["yes"], "unused"),
      /Unknown Harness capability: telepathy/,
    );
  });
});

describe("Driver Contract v2 route capability snapshot safety (reopened 1.2 repair)", () => {
  it("refuses a Proxy snapshot before any trap can run", () => {
    const traps = [];
    assert.throws(() => validateRouteCapabilitySnapshot(new Proxy(routeCapabilities(), {})), /Proxy/);
    const observed = new Proxy(routeCapabilities(), {
      get(target, key, receiver) {
        traps.push(`get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        traps.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        traps.push("ownKeys");
        return Reflect.ownKeys(target);
      },
    });
    assert.throws(() => validateRouteCapabilitySnapshot(observed), /Proxy/);
    assert.deepEqual(traps, [], "no trap may run before a Proxy is refused");
    // A nested Proxy is equally inadmissible evidence.
    assert.throws(
      () => validateRouteCapabilitySnapshot({
        ...routeCapabilities(),
        values: new Proxy(routeCapabilities().values, {}),
      }),
      /Proxy/,
    );
    assert.throws(
      () => validateRouteCapabilitySnapshot({
        ...routeCapabilities(),
        maturity: new Proxy(routeCapabilities().maturity, {}),
      }),
      /Proxy/,
    );
  });

  it("reads one descriptor snapshot and refuses accessor, hidden, symbol, and inherited state", () => {
    let maturityReads = 0;
    const alternating = {
      ...routeCapabilities(),
      get driverMaturity() {
        maturityReads += 1;
        return maturityReads === 1 ? "validated" : "not-a-maturity";
      },
    };
    assert.throws(() => validateRouteCapabilitySnapshot(alternating), /accessor/);
    assert.equal(maturityReads, 0, "an accessor must never be invoked");

    const nestedAccessor = { ...routeCapabilities() };
    let valueReads = 0;
    Object.defineProperty(nestedAccessor.values, "interaction", {
      enumerable: true,
      configurable: true,
      get() {
        valueReads += 1;
        return valueReads === 1 ? "noninteractive_fixed_policy" : "requires_broker";
      },
    });
    assert.throws(() => validateRouteCapabilitySnapshot(nestedAccessor), /accessor/);
    assert.equal(valueReads, 0);

    const hidden = { ...routeCapabilities() };
    Object.defineProperty(hidden, "driverMaturity", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: "validated",
    });
    assert.throws(() => validateRouteCapabilitySnapshot(hidden), /enumerable/);

    const symbolKeyed = { ...routeCapabilities() };
    symbolKeyed[Symbol("smuggled")] = "value";
    assert.throws(() => validateRouteCapabilitySnapshot(symbolKeyed), /symbol/i);

    const inherited = Object.create({ driverMaturity: "validated" });
    for (const [key, value] of Object.entries(routeCapabilities())) {
      if (key !== "driverMaturity") inherited[key] = value;
    }
    assert.throws(() => validateRouteCapabilitySnapshot(inherited), /prototype/);

    const polluted = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(routeCapabilities()).slice(1)}`,
    );
    assert.throws(() => validateRouteCapabilitySnapshot(polluted), /prototype|unknown field/);
    assert.equal({}.polluted, undefined);
  });

  it("applies the same trap-free reading to the version-one capability validator", () => {
    const legacy = () => ({ ...CLAUDE_CODE_CAPABILITIES });
    assert.deepEqual(validateHarnessCapabilities(legacy()), CLAUDE_CODE_CAPABILITIES);
    // A canonical version-one snapshot is still a fixed point.
    const canonical = validateHarnessCapabilities(legacy());
    assert.deepEqual(validateHarnessCapabilities(canonical), canonical);

    assert.throws(() => validateHarnessCapabilities(new Proxy(legacy(), {})), /Proxy/);
    let reads = 0;
    const accessor = legacy();
    Object.defineProperty(accessor, "continuation", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? "exact_resume" : "fresh_only";
      },
    });
    assert.throws(() => validateHarnessCapabilities(accessor), /accessor/);
    assert.equal(reads, 0, "an accessor must never be invoked");

    const hidden = legacy();
    Object.defineProperty(hidden, "continuation", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: "exact_resume",
    });
    assert.throws(() => validateHarnessCapabilities(hidden), /enumerable/);

    const symbolKeyed = legacy();
    symbolKeyed[Symbol("smuggled")] = "value";
    assert.throws(() => validateHarnessCapabilities(symbolKeyed), /symbol/i);

    const inherited = Object.create({ continuation: "exact_resume" });
    for (const [key, value] of Object.entries(legacy())) {
      if (key !== "continuation") inherited[key] = value;
    }
    assert.throws(() => validateHarnessCapabilities(inherited), /prototype/);

    const polluted = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(legacy()).slice(1)}`,
    );
    assert.throws(() => validateHarnessCapabilities(polluted), /prototype|unknown capability/);
    assert.equal({}.polluted, undefined);
    // Legitimate frozen, spread, and decoded snapshots stay compatible.
    assert.deepEqual(
      validateHarnessCapabilities(JSON.parse(JSON.stringify(CLAUDE_CODE_CAPABILITIES))),
      CLAUDE_CODE_CAPABILITIES,
    );
    assert.equal(
      assertHarnessCapability(CLAUDE_CODE_CAPABILITIES, "continuation", ["exact_resume"], "unused"),
      "exact_resume",
    );
  });

  it("canonicalizes to a detached fixed point", () => {
    const source = routeCapabilities();
    const canonical = validateRouteCapabilitySnapshot(source);
    const again = validateRouteCapabilitySnapshot(canonical);
    assert.deepEqual(again, canonical);
    assert.equal(JSON.stringify(again), JSON.stringify(canonical));
    // The canonical snapshot shares no structure with its source.
    source.values.interaction = "requires_broker";
    source.maturity.interaction = "experimental";
    assert.equal(canonical.values.interaction, "noninteractive_fixed_policy");
    assert.equal(canonical.maturity.interaction, "validated");
    assert.equal(assertAdmittedInteraction(canonical), "noninteractive_fixed_policy");
  });
});

describe("Driver Contract v2 module admission", () => {
  it("admits a service Driver that owns no process and rejects contract v1 outright", () => {
    const { driver: service } = createFakeServiceDriver();
    assert.equal(validateDriverV2(service), service);
    assert.equal(DRIVER_CONTRACT_VERSION_V2, 2);
    assert.deepEqual(DRIVER_V2_OPERATIONS, [
      "describe",
      "inspectInstances",
      "validateRoute",
      "prepareTurn",
      "revalidatePreparedTurn",
      "validateNativeSessionRef",
      "validateNativeTurnRef",
      "startTurn",
    ]);
    assert.deepEqual(DRIVER_V2_OPTIONAL_OPERATIONS, ["observeTurn", "readAssistantHistory"]);

    // The in-tree version-one Claude Driver is a complete Driver; it is still
    // refused, because v1 encodes one Harness through exit status and PID
    // interruption and is not accepted as an additive subset.
    assert.throws(
      () => validateDriverV2(driver),
      /implements Driver Contract 1; this runtime requires Driver Contract 2/,
    );
    assert.throws(
      () => validateDriverV2({ ...service, contractVersion: 1 }),
      /implements Driver Contract 1; this runtime requires Driver Contract 2/,
    );
  });

  it("requires every version-two operation before a turn can exist", () => {
    const { driver: service } = createFakeServiceDriver();
    for (const operation of DRIVER_V2_OPERATIONS) {
      const { [operation]: _removed, ...incomplete } = service;
      assert.throws(
        () => validateDriverV2(incomplete),
        new RegExp(`does not implement ${operation}`),
        `${operation} must be required`,
      );
    }
  });

  it("keeps describe() static, argument-free, and free of scope authority", () => {
    const { driver: service } = createFakeServiceDriver();
    const description = validateDriverV2(service).describe();
    assert.deepEqual(description, service.describe());
    assert.equal(description.harnessId, "fake-service");
    assert.equal(description.contractVersion, 2);

    assert.throws(
      () => validateDriverV2({ ...service, describe: (scope) => ({ ...service.describe(), scope }) }),
      /describe\(\) must take no arguments/,
    );
    let call = 0;
    assert.throws(
      () => validateDriverV2({
        ...service,
        describe: () => ({ ...service.describe(), title: `call-${(call += 1)}` }),
      }),
      /describe\(\) must be static/,
    );
    assert.throws(
      () => validateDriverV2({
        ...service,
        describe: () => ({ ...service.describe(), endpoint: "https://service.invalid" }),
      }),
      /declares an unknown field: endpoint/,
    );
    assert.throws(
      () => validateDriverV2({
        ...service,
        describe: () => ({ ...service.describe(), environmentKeys: ["FAKE_SERVICE_TOKEN"] }),
      }),
      /environment key FAKE_SERVICE_TOKEN/,
    );
    assert.throws(
      () => validateDriverV2({
        ...service,
        describe: () => ({ ...service.describe(), harnessId: "other-service" }),
      }),
      /describes Harness "other-service"/,
    );
  });

  it("requires an admitted capability to have its implementing method", () => {
    const { driver: service, capabilities } = createFakeServiceDriver();
    assert.equal(assertDriverRouteCoherence(service, capabilities).values.turnObservation, "terminal_observable");

    const { observeTurn: _observeTurn, ...unobservable } = service;
    assert.throws(
      () => assertDriverRouteCoherence(unobservable, capabilities),
      /claims turnObservation=terminal_observable without implementing observeTurn/,
    );
    // The same Driver may serve an unobservable route: capability absence is
    // honest, and the method simply may not be invoked for that route.
    assert.doesNotThrow(() => assertDriverRouteCoherence(unobservable, {
      ...capabilities,
      values: { ...capabilities.values, turnObservation: "unavailable" },
    }));
    assert.throws(
      () => assertDriverRouteCoherence(service, {
        ...capabilities,
        values: { ...capabilities.values, history: "assistant_messages" },
      }),
      /claims history=assistant_messages without implementing readAssistantHistory/,
    );
  });

  it("limits Driver prompt preparation to authority, topology, return contract, and the caller task", () => {
    const { driver: service, capabilities } = createFakeServiceDriver();
    const route = {
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      model: "standard-tier",
      topology: "leaf",
      authority: "behavioral_read_only",
      driverVersion: FAKE_SERVICE_DRIVER_VERSION,
      capabilities,
    };
    assert.deepEqual(PROMPT_ENVELOPE_FIELDS, ["authority", "returnContract", "taskInput", "topology"]);

    const prepared = validatePreparedTurn(
      service.prepareTurn({ route, taskInput: "read the module and report" }),
      { driver: service, route, taskInput: "read the module and report" },
    );
    assert.equal(prepared.promptEnvelope.taskInput, "read the module and report");
    assert.equal(prepared.promptEnvelope.authority, "authority=behavioral_read_only");

    const overreaching = {
      ...service,
      prepareTurn: (input) => ({
        ...service.prepareTurn(input),
        promptEnvelope: {
          ...service.prepareTurn(input).promptEnvelope,
          methodology: "decompose the task into three research phases",
        },
      }),
    };
    assert.throws(
      () => validatePreparedTurn(
        overreaching.prepareTurn({ route, taskInput: "read the module and report" }),
        { driver: overreaching, route, taskInput: "read the module and report" },
      ),
      /prompt envelope declares an unknown field: methodology/,
    );

    const rewriting = {
      ...service,
      prepareTurn: (input) => {
        const base = service.prepareTurn(input);
        return {
          ...base,
          promptEnvelope: { ...base.promptEnvelope, taskInput: `${input.taskInput}\nAlso refactor the repository.` },
        };
      },
    };
    assert.throws(
      () => validatePreparedTurn(
        rewriting.prepareTurn({ route, taskInput: "read the module and report" }),
        { driver: rewriting, route, taskInput: "read the module and report" },
      ),
      /prompt envelope must carry the caller task input unchanged/,
    );
  });
});

/** One turn-shaped DriverScope input for the fake service Driver. */
function scopeInput(driver, overrides = {}) {
  return {
    driver,
    purpose: "turn",
    rootId: "root-fake-service",
    agentId: "agent-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    workspaceRoot: "/workspace",
    route: overrides.route ?? null,
    taskInput: "read the module and report",
    assignedInputs: [],
    deadlineAt: 1_000,
    signal: new AbortController().signal,
    env: {
      FAKE_SERVICE_HOME: "/srv/fake",
      AWS_SECRET_ACCESS_KEY: "must-never-be-visible",
      CLAUDE_CONFIG_DIR: "/data/.claude",
    },
    ...overrides,
  };
}

function routeRequest(overrides = {}) {
  return {
    harnessId: "fake-service",
    model: "standard-tier",
    topology: "leaf",
    authority: "behavioral_read_only",
    effort: "high",
    ...overrides,
  };
}

async function acceptFakeServiceRoute(driver, requestOverrides = {}) {
  const inspectionScope = createDriverScope(scopeInput(driver, { purpose: "inspect" }));
  const inspections = await inspectDriverInstances(driver, inspectionScope);
  return acceptDriverRoute(driver, routeRequest(requestOverrides), inspections);
}

describe("Driver Contract v2 registry and scope", () => {
  it("keeps the version-two registry static and in-tree", () => {
    const { driver: service } = createFakeServiceDriver();
    // The version-two table holds exactly the in-tree Drivers this checkout
    // implements on Contract v2. A fixture can never register itself, and admission is not
    // activation: no public lifecycle path resolves a v2 Driver here.
    assert.deepEqual([...ADMITTED_DRIVER_V2_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    assert.throws(() => resolveDriverV2("fake-service"), /Unknown Harness fake-service/);
    assert.equal(resolveDriverV2("claude-code").contractVersion, 2);
    assert.equal(admitDriverV2(service), service);
    for (const key of ["CODEX_HARNESSDOCK_HARNESS_DRIVER_MODULE", "CODEX_HARNESSDOCK_HARNESS_ENDPOINT", "CODEX_HARNESSDOCK_HARNESS_INSTANCE"]) {
      assert.throws(
        () => assertNoAmbientHarnessSelector({ [key]: "x" }),
        new RegExp(`${key} cannot select a Harness Driver implementation`),
      );
    }
  });

  it("refuses caller-supplied module, endpoint, instance, and credential selectors", () => {
    for (const key of [
      "driver_module",
      "harness_endpoint",
      "endpoint",
      "base_url",
      "service_url",
      "instance",
      "instance_key",
      "api_key",
      "auth_token",
      "credentials",
    ]) {
      assert.throws(
        () => assertNoHarnessImplementationSelector({ [key]: "value" }, "spawn_agent"),
        new RegExp(`spawn_agent does not accept ${key}`),
      );
    }
  });

  it("hands a Driver a least-authority scope and nothing else", () => {
    const { driver: service } = createFakeServiceDriver();
    const scope = createDriverScope(scopeInput(service, {
      route: { harnessId: "fake-service", instanceKey: "tenant-alpha" },
    }));
    assert.deepEqual(Object.keys(scope).sort(), [...DRIVER_SCOPE_FIELDS].sort());
    assert.equal(scope.rootId, "root-fake-service");
    assert.equal(scope.workspaceRoot, "/workspace");
    assert.equal(scope.taskInput, "read the module and report");
    assert.equal(scope.deadlineAt, 1_000);
    assert.equal(Object.isFrozen(scope.route), true);

    for (const forbidden of [
      "store",
      "registry",
      "drivers",
      "driver",
      "mcp",
      "jobs",
      "credentials",
      "process",
      "resolveHarnessDriver",
      "anythingElse",
    ]) {
      assert.throws(
        () => scope[forbidden],
        new RegExp(`DriverScope does not expose ${forbidden}`),
        `${forbidden} must stay outside the Driver scope`,
      );
    }
    assert.throws(() => { scope.route = { harnessId: "other" }; }, /DriverScope is immutable/);
    assert.throws(() => { delete scope.taskInput; }, /DriverScope is immutable/);

    // The environment view is exactly the Driver's declared fixed keys.
    assert.equal(scope.env.FAKE_SERVICE_HOME, "/srv/fake");
    assert.throws(
      () => scope.env.AWS_SECRET_ACCESS_KEY,
      /does not expose environment value AWS_SECRET_ACCESS_KEY/,
    );
    assert.throws(
      () => scope.env.CLAUDE_CONFIG_DIR,
      /does not expose environment value CLAUDE_CONFIG_DIR/,
    );
    assert.deepEqual(Object.keys(scope.env), ["FAKE_SERVICE_HOME"]);
  });

  it("keeps instance inspection blind to the turn it may later serve", () => {
    const { driver: service } = createFakeServiceDriver();
    const scope = createDriverScope(scopeInput(service, { purpose: "inspect" }));
    assert.deepEqual(Object.keys(scope).sort(), [...DRIVER_INSPECTION_SCOPE_FIELDS].sort());
    for (const turnOnly of ["taskInput", "assignedInputs", "route", "capabilities", "turnId", "attemptId"]) {
      assert.throws(
        () => scope[turnOnly],
        new RegExp(`${turnOnly} is not available during instance inspection`),
        `${turnOnly} must stay out of static inspection`,
      );
    }
  });

  it("inspects static logical instances without lifecycle authority", async () => {
    const { driver: service, control } = createFakeServiceDriver();
    const scope = createDriverScope(scopeInput(service, { purpose: "inspect" }));
    const inspections = await inspectDriverInstances(service, scope);
    assert.equal(control.service.inspections, 1);
    // A turn scope is not an inspection scope: inspection cannot borrow turn authority.
    await assert.rejects(
      () => inspectDriverInstances(service, createDriverScope(scopeInput(service))),
      /requires an instance-inspection scope/,
    );
    assert.deepEqual(inspections.map((instance) => [instance.instanceKey, instance.readiness]), [
      ["tenant-alpha", "ready"],
      ["tenant-beta", "unavailable"],
    ]);
    assert.equal(inspections[0].liveValidated, true);
    assert.equal(inspections[1].detailCode, "service_unreachable");
    assert.equal(Object.isFrozen(inspections[0]), true);

    // An inspection that reaches for supervisor internals fails at the scope,
    // before it can install, log in, start, or repair anything.
    const mutating = createFakeServiceDriver({
      inspectInstances: (injectedScope) => injectedScope.store.writeAgent({ hijacked: true }),
    });
    await assert.rejects(
      () => inspectDriverInstances(mutating.driver, createDriverScope(scopeInput(mutating.driver, { purpose: "inspect" }))),
      /DriverScope does not expose store/,
    );

    const foreign = createFakeServiceDriver({
      inspectInstances: () => [{
        harnessId: "other-service",
        instanceKey: "tenant-alpha",
        readiness: "ready",
        liveValidated: true,
        maturity: "experimental",
        detailCode: "ready",
        routes: null,
      }],
    });
    await assert.rejects(
      () => inspectDriverInstances(foreign.driver, createDriverScope(scopeInput(foreign.driver, { purpose: "inspect" }))),
      /inspection belongs to Harness "other-service"/,
    );

    const leaky = createFakeServiceDriver({
      instances: [{
        instanceKey: "https://operator:hunter2@service.invalid",
        readiness: "ready",
        detailCode: "ready",
      }],
    });
    await assert.rejects(
      () => inspectDriverInstances(leaky.driver, createDriverScope(scopeInput(leaky.driver, { purpose: "inspect" }))),
      /instance key/,
    );

    const undecided = createFakeServiceDriver({
      instances: [{ instanceKey: "tenant-alpha", readiness: "probably", detailCode: "ready" }],
    });
    await assert.rejects(
      () => inspectDriverInstances(undecided.driver, createDriverScope(scopeInput(undecided.driver, { purpose: "inspect" }))),
      /unsupported readiness/,
    );
  });

  it("accepts one explicit canonical route and never chooses for the caller", async () => {
    const { driver: service, capabilities } = createFakeServiceDriver();
    const accepted = await acceptFakeServiceRoute(service);
    assert.equal(accepted.route.instanceKey, "tenant-alpha");
    assert.equal(accepted.route.model, "standard-tier");
    assert.equal(accepted.route.topology, "leaf");
    assert.equal(accepted.route.authority, "behavioral_read_only");
    assert.equal(accepted.route.driverVersion, FAKE_SERVICE_DRIVER_VERSION);
    assert.equal(accepted.route.capabilities.values.interaction, "noninteractive_fixed_policy");
    assert.equal(capabilityMaturity(accepted.route.capabilities, "continuation"), "experimental");
    assert.equal(Object.isFrozen(accepted.route), true);

    for (const field of ["model", "topology", "authority"]) {
      const { [field]: _dropped, ...partial } = routeRequest();
      const inspections = await inspectDriverInstances(
        service,
        createDriverScope(scopeInput(service, { purpose: "inspect" })),
      );
      assert.throws(
        () => acceptDriverRoute(service, partial, inspections),
        new RegExp(`route request must state an explicit ${field}`),
        `${field} must never be defaulted`,
      );
    }
    await assert.rejects(
      () => acceptFakeServiceRoute(service, { topology: "swarm" }),
      /unsupported topology/,
    );
    await assert.rejects(
      () => acceptFakeServiceRoute(service, { driver_module: "/tmp/driver.mjs" }),
      /route validation does not accept driver_module/,
    );

    // A Driver may reject a request; it may not answer a different one.
    const substituting = createFakeServiceDriver({
      routeOverride: (route) => ({ ...route, model: "premium-tier" }),
    });
    await assert.rejects(
      () => acceptFakeServiceRoute(substituting.driver),
      /canonical route model "premium-tier" does not match the requested "standard-tier"/,
    );
    const effortSubstituting = createFakeServiceDriver({
      routeOverride: (route) => ({ ...route, effort: "low" }),
    });
    await assert.rejects(
      () => acceptFakeServiceRoute(effortSubstituting.driver, { effort: "high" }),
      /effective effort "low" does not match the requested "high"/,
    );
    assert.deepEqual(capabilities.values.interaction, "noninteractive_fixed_policy");
  });

  it("reports instance readiness independently and fails closed when selection is ambiguous", async () => {
    const bothReady = createFakeServiceDriver({
      instances: [
        { instanceKey: "tenant-alpha", readiness: "ready", detailCode: "ready" },
        { instanceKey: "tenant-beta", readiness: "ready", detailCode: "ready" },
      ],
    });
    await assert.rejects(
      () => acceptFakeServiceRoute(bothReady.driver),
      /2 ready logical instances .*This generation exposes no instance selector/s,
    );

    const noneReady = createFakeServiceDriver({
      instances: [
        { instanceKey: "tenant-alpha", readiness: "blocked", detailCode: "not_authenticated" },
        { instanceKey: "tenant-beta", readiness: "unavailable", detailCode: "service_unreachable" },
      ],
    });
    await assert.rejects(
      () => acceptFakeServiceRoute(noneReady.driver),
      /has no ready logical instance \(tenant-alpha=not_authenticated, tenant-beta=service_unreachable\)/,
    );

    // One unavailable instance never disables a ready sibling.
    const mixed = createFakeServiceDriver({
      instances: [
        { instanceKey: "tenant-alpha", readiness: "unavailable", detailCode: "service_unreachable" },
        { instanceKey: "tenant-beta", readiness: "ready", detailCode: "ready" },
      ],
    });
    const accepted = await acceptFakeServiceRoute(mixed.driver);
    assert.equal(accepted.route.instanceKey, "tenant-beta");
    assert.equal(accepted.inspection.readiness, "ready");
  });

  it("reports a broker-requiring route unavailable instead of approving anything", async () => {
    const broker = createFakeServiceDriver({
      capabilities: { values: { interaction: "requires_broker" } },
    });
    const scope = createDriverScope(scopeInput(broker.driver, { purpose: "inspect" }));
    const inspections = await inspectDriverInstances(broker.driver, scope);
    // The instance stays discoverable, with its interaction policy visible.
    assert.equal(inspections[0].readiness, "ready");
    assert.equal(inspections[0].routes.interaction, "requires_broker");
    assert.throws(
      () => acceptDriverRoute(broker.driver, routeRequest(), inspections),
      /is unavailable: it requires an approval broker \(interaction=requires_broker\)/,
    );
  });
});

/**
 * The generic turn path: everything the shared supervisor does with a Driver in
 * this phase, composed only from Harness-neutral exports. No step reads the
 * Harness ID to decide what to do next.
 */
async function runGenericServiceTurn(driver, options = {}) {
  const accepted = await acceptFakeServiceRoute(driver, options.request ?? {});
  const taskInput = options.taskInput ?? "read the module and report";
  const scope = createDriverScope(scopeInput(driver, { route: accepted.route, taskInput }));
  const preparedTurn = validatePreparedTurn(
    driver.prepareTurn({ route: accepted.route, taskInput }),
    { driver, route: accepted.route, taskInput },
  );
  const launchContext = driver.revalidatePreparedTurn(preparedTurn, scope);
  const live = validateLiveHarnessTurn(
    await driver.startTurn({ scope, preparedTurn, launchContext }),
    { driver, route: accepted.route },
  );
  return { accepted, scope, preparedTurn, live };
}

describe("Driver Contract v2 live turn and terminal result", () => {
  it("completes a service turn with no PID, exit status, or process evidence", async () => {
    const { driver: service, control } = createFakeServiceDriver();
    const { accepted, live } = await runGenericServiceTurn(service);

    for (const processField of PROCESS_SHAPED_FIELDS) {
      assert.equal(Object.hasOwn(live, processField), false, `${processField} must not exist on a live turn`);
    }
    // Only the two typed references are durable; the handle itself never is.
    const evidence = durableTurnEvidence(live);
    assert.deepEqual(Object.keys(evidence).sort(), ["nativeSessionRef", "nativeTurnRef"]);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
    assert.equal(evidence.nativeTurnRef.locator.turnId, "service-turn-1");

    const result = validateNormalizedTerminalResult(await live.result, {
      driver: service,
      route: accepted.route,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.nativeTurn, "terminal");
    assert.deepEqual(result.executionWorld, { continuity: "preserved", settlement: "settled" });
    assert.equal(result.continuation.mode, "exact_resume");
    assert.equal(result.continuation.nativeSessionRef.locator.sessionId, "service-session-1");
    assert.equal(result.finalMessage, "fake service completed turn service-turn-1");
    for (const processField of PROCESS_SHAPED_FIELDS) {
      assert.equal(Object.hasOwn(result, processField), false, `${processField} must not exist on a result`);
    }
    await live.dispose();
    assert.equal(control.service.disposals, 1);
    // The operator-owned service survives its finished turn.
    assert.equal(control.service.turns.get("service-turn-1").state, "terminal");
  });

  it("refuses a version-one, process-shaped, foreign, or contradictory result", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);
    const route = accepted.route;
    control.complete("service-turn-1", "completed");
    const valid = await live.result;
    const check = (overrides, pattern) => assert.throws(
      () => validateNormalizedTerminalResult({ ...valid, ...overrides }, { driver: service, route }),
      pattern,
    );

    // The whole version-one result shape is refused, not partially adapted: its
    // universal process evidence is rejected before anything else is read, and
    // its contract generation is rejected on its own.
    assert.throws(
      () => validateNormalizedTerminalResult(terminalResult(), { driver: service, route }),
      /must not carry process-shaped evidence: exitStatus/,
    );
    check({ contractVersion: 1 }, /implements Driver Contract 1; this runtime requires Driver Contract 2/);
    check({ exitStatus: 0 }, /must not carry process-shaped evidence: exitStatus/);
    check({ process: { spawnAccepted: true, identityProven: true } }, /must not carry process-shaped evidence: process/);
    check({ status: "pending" }, /unsupported status/);
    check({ nativeTurn: "active" }, /terminal result must report nativeTurn=terminal/);
    check(
      { executionWorld: { continuity: "preserved", settlement: "active" } },
      /completed turn cannot report active owned work/,
    );
    check({ harnessId: "other-service" }, /belongs to Harness "other-service"/);
    check({ driverVersion: "fake-service@2" }, /foreign Driver version/);
    check({ instanceKey: "tenant-beta" }, /belongs to logical instance "tenant-beta"/);
    check(
      { continuation: { ...valid.continuation, nativeSessionRef: null } },
      /continuation mode exact_resume requires a native session reference/,
    );
    check(
      { continuation: { mode: "none", nativeSessionRef: valid.continuation.nativeSessionRef, evidence: {} } },
      /continuation mode none must not carry a native session reference/,
    );
    // native-reference.mjs's forbidden-key bound now catches an endpoint-shaped
    // locator field before the Driver's own exact-schema validator ever runs.
    check(
      {
        nativeTurnRef: {
          ...valid.nativeTurnRef,
          locator: { ...valid.nativeTurnRef.locator, endpoint: "https://service.invalid" },
        },
      },
      /is a forbidden endpoint-shaped key/,
    );
    check(
      { failure: { class: "fatal", reason: "x", resumable: false } },
      /completed Harness turn must not classify a failure/,
    );
    check(
      { status: "failed", failure: { class: "not_a_class", reason: "x", resumable: false }, finalMessage: null, finalMessageAbsenceReason: "x" },
      /is not an admitted turn-failure class/,
    );
    check({ finalMessage: null, finalMessageAbsenceReason: null }, /final outer-assistant message or an explicit absence reason/);
    check({ scope: "repository research scope" }, /declares an unknown field: scope/);

    // Unknown settlement is an honest, admitted outcome, not a contradiction.
    const unknown = validateNormalizedTerminalResult({
      ...valid,
      status: "failed",
      executionWorld: { continuity: "unknown", settlement: "unknown" },
      failure: { class: "protocol_unknown", reason: "worker lost", resumable: false },
      finalMessage: null,
      finalMessageAbsenceReason: "protocol_unknown",
    }, { driver: service, route });
    assert.equal(unknown.executionWorld.settlement, "unknown");

    // A result may not claim a continuation the accepted route does not admit.
    const freshOnly = { ...route, capabilities: { ...route.capabilities, values: { ...route.capabilities.values, continuation: "fresh_only" } } };
    assert.throws(
      () => validateNormalizedTerminalResult(valid, { driver: service, route: freshOnly }),
      /route admits continuation=fresh_only/,
    );
    // Bounded metrics and receipts keep their existing closed schemas.
    assert.equal(
      validateNormalizedTerminalResult(
        { ...valid, metrics: { version: 1, provider_reported: { duration_ms: 5 }, plugin_observed: null } },
        { driver: service, route },
      ).metrics.provider_reported.duration_ms,
      5,
    );
    check(
      { metrics: { version: 1, provider_reported: { duration_ms: 1, unknown: "payload" }, plugin_observed: null } },
      /metrics must use the closed version-one schema/,
    );
    check(
      { driverReceipt: boundedDriverReceipt("other-service", "other-service@1", {}) },
      /Driver receipt belongs to a foreign Driver contract/,
    );
    // Optional opaque result metadata is admitted but bounded; the completion
    // never requires a repository-research ontology to accept a final message.
    assert.equal(
      validateNormalizedTerminalResult({ ...valid, resultMetadata: { citations: 2 } }, { driver: service, route })
        .resultMetadata.citations,
      2,
    );
    check({ resultMetadata: { blob: "x".repeat(64 * 1024) } }, /result metadata exceeds its durable bound/);
  });

  it("exposes exactly the live methods the accepted route admits", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);

    const initialOnly = {
      ...accepted.route,
      capabilities: {
        ...accepted.route.capabilities,
        values: { ...accepted.route.capabilities.values, activeInput: "initial_only" },
      },
    };
    assert.throws(
      () => validateLiveHarnessTurn(live, { driver: service, route: initialOnly }),
      /route declares activeInput=initial_only/,
    );
    const { requestInterrupt: _requestInterrupt, ...withoutInterrupt } = live;
    assert.throws(
      () => validateLiveHarnessTurn(withoutInterrupt, { driver: service, route: accepted.route }),
      /admits interruptRequest=supported without exposing requestInterrupt/,
    );

    // Request acceptance is not settlement: the turn stays live until the
    // service itself reports a terminal turn.
    const receipt = await live.requestInterrupt({ commandId: "command-1", kind: "interrupt" });
    assert.deepEqual(receipt, {
      commandId: "command-1",
      requestState: "accepted",
      settlement: "pending",
      nativeTurnState: "active",
    });
    const pending = Symbol("pending");
    assert.equal(await Promise.race([live.result, Promise.resolve(pending)]), pending);
    assert.equal(await service.observeTurn(live.nativeTurnRef).then((observation) => observation.nativeTurn), "active");

    control.complete("service-turn-1", "interrupted");
    const settled = validateNormalizedTerminalResult(await live.result, {
      driver: service,
      route: accepted.route,
    });
    assert.equal(settled.status, "interrupted");
    assert.equal(settled.failure.class, "cancelled_or_interrupted");
    assert.equal(await service.observeTurn(live.nativeTurnRef).then((observation) => observation.nativeTurn), "terminal");
  });

  it("runs identically for two Harnesses, proving no Harness-ID branch in the generic path", async () => {
    const first = createFakeServiceDriver();
    const second = createFakeServiceDriver({
      harnessId: "second-service",
      driverVersion: "second-service@1",
    });

    const project = async (fixture) => {
      const { accepted, preparedTurn, live } = await runGenericServiceTurn(fixture.driver, {
        request: { harnessId: fixture.driver.harnessId },
      });
      const result = validateNormalizedTerminalResult(await live.result, {
        driver: fixture.driver,
        route: accepted.route,
      });
      const projection = { route: accepted.route, preparedTurn, evidence: durableTurnEvidence(live), result };
      return JSON.stringify(projection)
        .replaceAll(fixture.driver.harnessId, "<harness>")
        .replaceAll(fixture.driver.driverVersion, "<driver-version>");
    };

    assert.equal(await project(first), await project(second));
    // Neither Harness gains authority the other lacks, and neither may be
    // selected by a caller-supplied module, endpoint, or instance value.
    for (const fixture of [first, second]) {
      await assert.rejects(
        () => acceptFakeServiceRoute(fixture.driver, {
          harnessId: fixture.driver.harnessId,
          endpoint: "https://service.invalid",
        }),
        /route validation does not accept endpoint/,
      );
      assert.throws(
        () => resolveDriverV2(fixture.driver.harnessId),
        new RegExp(`Unknown Harness ${fixture.driver.harnessId}`),
      );
    }
  });
});

describe("Driver Contract v2 boundary corrections", () => {
  it("keeps the accepted canonical route authoritative over the Driver's prepared route", async () => {
    const { driver: service } = createFakeServiceDriver();
    const accepted = await acceptFakeServiceRoute(service);
    const taskInput = "read the module and report";
    const prepare = (route) => service.prepareTurn({ route, taskInput });
    const validate = (prepared) =>
      validatePreparedTurn(prepared, { driver: service, route: accepted.route, taskInput });

    // The prepared turn carries the accepted frozen route itself, never the
    // Driver's copy of it.
    const prepared = validate(prepare(accepted.route));
    assert.equal(prepared.route, accepted.route);
    assert.equal(Object.isFrozen(prepared.route), true);

    const forged = (values) => ({
      ...accepted.route,
      capabilities: {
        ...accepted.route.capabilities,
        values: { ...accepted.route.capabilities.values, ...values },
      },
    });
    assert.throws(
      () => validate(prepare(forged({ authorityEnforcement: "process_sandbox" }))),
      /capability snapshot that is not the accepted route's/,
    );
    assert.throws(
      () => validate(prepare(forged({ leafEnforcement: "unsupported" }))),
      /capability snapshot that is not the accepted route's/,
    );
    assert.throws(
      () => validate(prepare(forged({ continuation: "maybe" }))),
      /unsupported continuation value/,
    );
    assert.throws(
      () => validate(prepare({ ...accepted.route, capabilities: null })),
      /capability snapshot must be an object/,
    );
  });

  it("accepts only the explicit route-request fields", async () => {
    const { driver: service } = createFakeServiceDriver();
    const inspections = await inspectDriverInstances(
      service,
      createDriverScope(scopeInput(service, { purpose: "inspect" })),
    );
    for (const [key, value] of [
      ["capabilities", { values: { authorityEnforcement: "process_sandbox" } }],
      ["harnessCapabilities", {}],
      ["policy", "prefer_cheapest"],
      ["max_concurrency", 4],
      ["route_ranking", ["fake-service"]],
    ]) {
      assert.throws(
        () => acceptDriverRoute(service, { ...routeRequest(), [key]: value }, inspections),
        new RegExp(`route request declares an unknown field: ${key}`),
        `${key} must not reach a Driver`,
      );
    }
    // The Driver never sees a request the core has not closed.
    let observed = null;
    const spy = {
      ...service,
      validateRoute: (request, inspection) => {
        observed = request;
        return service.validateRoute(request, inspection);
      },
    };
    assert.throws(
      () => acceptDriverRoute(spy, { ...routeRequest(), capabilities: {} }, inspections),
      /unknown field: capabilities/,
    );
    assert.equal(observed, null);
  });

  it("rejects inherited process-shaped evidence, not only own fields", async () => {
    const { driver: service } = createFakeServiceDriver();
    const { accepted, live } = await runGenericServiceTurn(service);
    const valid = await live.result;

    class ProcessBackedTurn {
      get pid() {
        return 4242;
      }
    }
    const inheritedLive = Object.assign(new ProcessBackedTurn(), {
      nativeTurnRef: live.nativeTurnRef,
      nativeSessionRef: live.nativeSessionRef,
      result: live.result,
      dispose: live.dispose,
      deliverActiveInput: live.deliverActiveInput,
      requestInterrupt: live.requestInterrupt,
    });
    assert.throws(
      () => validateLiveHarnessTurn(inheritedLive, { driver: service, route: accepted.route }),
      /must not carry process-shaped evidence: pid/,
    );
    const inheritedResult = Object.assign(Object.create({ exitStatus: 0 }), valid);
    assert.throws(
      () => validateNormalizedTerminalResult(inheritedResult, { driver: service, route: accepted.route }),
      /must not carry process-shaped evidence: exitStatus/,
    );
  });

  it("uses the description admitted at registration, never a later one", () => {
    const { driver: service } = createFakeServiceDriver();
    const base = service.describe();
    let calls = 0;
    const drifting = {
      ...service,
      describe: () => {
        calls += 1;
        return calls <= 2
          ? { ...base }
          : { ...base, environmentKeys: [...base.environmentKeys, "FAKE_SERVICE_EXTRA"] };
      },
    };
    assert.equal(admitDriverV2(drifting), drifting);
    assert.equal(calls, 2);

    const scope = createDriverScope(scopeInput(drifting, {
      env: { FAKE_SERVICE_HOME: "/srv/fake", FAKE_SERVICE_EXTRA: "widened-after-admission" },
    }));
    assert.equal(calls, 2, "scope construction must reuse the admitted description");
    assert.deepEqual(Object.keys(scope.env), ["FAKE_SERVICE_HOME"]);
    assert.throws(
      () => scope.env.FAKE_SERVICE_EXTRA,
      /does not expose environment value FAKE_SERVICE_EXTRA/,
    );
    // Re-admission after the drift is refused rather than silently widening.
    assert.throws(() => admitDriverV2(drifting), /describe\(\) must be static/);
  });

  it("binds instance inspection to the Driver its scope was built for", async () => {
    const first = createFakeServiceDriver();
    const second = createFakeServiceDriver({
      harnessId: "second-service",
      driverVersion: "second-service@1",
    });
    const scope = createDriverScope(scopeInput(first.driver, { purpose: "inspect" }));
    await assert.rejects(
      () => inspectDriverInstances(second.driver, scope),
      /scope belongs to Harness fake-service/,
    );
  });

  it("survives ordinary JavaScript protocol probes without widening authority", async () => {
    const { driver: service } = createFakeServiceDriver();
    const accepted = await acceptFakeServiceRoute(service);
    const scope = createDriverScope(scopeInput(service, { route: accepted.route }));

    // Promise assimilation, JSON serialization, and string inspection probe
    // protocol keys; probing must not throw and must not grant authority.
    assert.equal(await Promise.resolve(scope), scope);
    assert.equal(await Promise.resolve(scope.env), scope.env);
    const serialized = JSON.parse(JSON.stringify(scope));
    assert.equal(serialized.workspaceRoot, "/workspace");
    assert.equal(Object.hasOwn(serialized, "credentials"), false);
    assert.equal(String(scope), "[object Object]");
    assert.doesNotThrow(() => inspect(scope));
    assert.doesNotThrow(() => inspect(scope.env));
    assert.equal(typeof scope.then, "undefined");
    assert.equal(typeof scope.toJSON, "undefined");

    for (const forbidden of ["store", "registry", "credentials", "mcp"]) {
      assert.throws(() => scope[forbidden], new RegExp(`DriverScope does not expose ${forbidden}`));
    }
    assert.throws(() => scope.env.AWS_SECRET_ACCESS_KEY, /does not expose environment value/);
  });

  it("bounds and closes every normalized terminal field", async () => {
    const { driver: service } = createFakeServiceDriver();
    const { accepted, live } = await runGenericServiceTurn(service);
    const route = accepted.route;
    const valid = await live.result;
    const validate = (overrides) =>
      validateNormalizedTerminalResult({ ...valid, ...overrides }, { driver: service, route });
    const check = (overrides, pattern) => assert.throws(() => validate(overrides), pattern);

    assert.ok(validate({ finalMessage: "x".repeat(MAX_FINAL_MESSAGE_CHARS) }));
    check({ finalMessage: "x".repeat(MAX_FINAL_MESSAGE_CHARS + 1) }, /final message exceeds its durable bound/);

    const failed = {
      status: "failed",
      finalMessage: null,
      finalMessageAbsenceReason: "fatal",
      failure: { class: "fatal", reason: "boom", detail: null, resumable: false, requiresAttention: false },
    };
    check({ finalMessage: null, finalMessageAbsenceReason: "   " }, /absence reason must be non-empty text/);
    check(
      { finalMessage: null, finalMessageAbsenceReason: "x".repeat(1_000) },
      /absence reason exceeds its durable bound/,
    );
    check(
      { executionWorld: { continuity: "preserved", settlement: "settled", resumable: true } },
      /execution world declares an unknown field: resumable/,
    );
    check(
      { continuation: { ...valid.continuation, sessionId: "raw-native-id" } },
      /continuation declares an unknown field: sessionId/,
    );
    check({ continuation: { ...valid.continuation, evidence: null } }, /continuation must carry bounded evidence/);
    check(
      { continuation: { ...valid.continuation, evidence: { blob: "x".repeat(8 * 1024) } } },
      /continuation evidence exceeds its durable bound/,
    );
    check(
      { ...failed, failure: { ...failed.failure, retryPolicy: { nextWorker: "another-harness" } } },
      /failure classification declares an unknown field: retryPolicy/,
    );
    check(
      { ...failed, failure: { ...failed.failure, reason: "x".repeat(4_000) } },
      /failure reason exceeds its durable bound/,
    );
    check(
      { ...failed, failure: { ...failed.failure, requiresAttention: "yes" } },
      /failure classification must state requiresAttention as a boolean/,
    );
    check(
      { ...failed, failure: { ...failed.failure, detail: { blob: "x".repeat(8 * 1024) } } },
      /failure detail exceeds its durable bound/,
    );
    // A bounded object detail and a bounded reason remain admitted.
    assert.equal(
      validate({ ...failed, failure: { ...failed.failure, detail: { serviceStatus: 503 } } }).failure.detail.serviceStatus,
      503,
    );
  });
});

/**
 * Independent-review correction: `validateLiveHarnessTurn()` must never spread
 * a Driver-returned live object (that both leaks unexpected own properties and
 * silently drops prototype methods on a class-backed handle), and
 * `durableTurnEvidence()` must refuse anything that did not pass through it.
 */
describe("LiveHarnessTurn integration hardening (finding 5)", () => {
  it("never spreads the Driver-returned live object; unexpected own properties do not leak into the validated wrapper", async () => {
    const { driver: service } = createFakeServiceDriver({
      liveTurnOverride: (live) => ({ ...live, secretDebugField: "should-not-leak" }),
    });
    const { accepted, live } = await runGenericServiceTurn(service);
    const validated = validateLiveHarnessTurn(live, { driver: service, route: accepted.route });
    assert.equal(Object.hasOwn(validated, "secretDebugField"), false);
  });

  it("preserves a genuine class-backed LiveTurn's prototype methods and private state through validation", async () => {
    const { driver: service } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live: rawLive } = await runGenericServiceTurn(service);

    class ClassBackedLiveTurn {
      #disposed = false;
      #deliveredInputs = [];
      constructor(nativeTurnRef, nativeSessionRef, resultPromise) {
        this.nativeTurnRef = nativeTurnRef;
        this.nativeSessionRef = nativeSessionRef;
        this.result = resultPromise;
      }
      async dispose() {
        this.#disposed = true;
      }
      async deliverActiveInput(input) {
        this.#deliveredInputs.push(input);
        return { accepted: true, sequence: this.#deliveredInputs.length };
      }
      async requestInterrupt(command) {
        return {
          commandId: command.commandId,
          requestState: "accepted",
          settlement: "pending",
          nativeTurnState: "active",
        };
      }
      isDisposed() { return this.#disposed; }
      deliveredCount() { return this.#deliveredInputs.length; }
    }

    const classLive = new ClassBackedLiveTurn(rawLive.nativeTurnRef, rawLive.nativeSessionRef, rawLive.result);
    const validated = validateLiveHarnessTurn(classLive, { driver: service, route: accepted.route });

    // Bound methods still mutate the *original* instance's private state --
    // proof that `this` was preserved by binding, not merely copied by value.
    const receipt = await validated.deliverActiveInput({ text: "hi" });
    assert.equal(receipt.accepted, true);
    assert.equal(classLive.deliveredCount(), 1);

    const interruptReceipt = await validated.requestInterrupt({ commandId: "c1", kind: "interrupt" });
    assert.equal(interruptReceipt.requestState, "accepted");

    await validated.dispose();
    assert.equal(classLive.isDisposed(), true);

    assert.equal(await Promise.race([validated.result, Promise.resolve("pending")]), "pending");
  });

  it("durableTurnEvidence refuses a raw, unvalidated live handle and accepts only the canonical validated wrapper", async () => {
    const { driver: service } = createFakeServiceDriver();
    const accepted = await acceptFakeServiceRoute(service);
    const taskInput = "read the module and report";
    const scope = createDriverScope(scopeInput(service, { route: accepted.route, taskInput }));
    const preparedTurn = validatePreparedTurn(
      service.prepareTurn({ route: accepted.route, taskInput }),
      { driver: service, route: accepted.route, taskInput },
    );
    const launchContext = service.revalidatePreparedTurn(preparedTurn, scope);
    // Deliberately unvalidated: `runGenericServiceTurn()` already calls
    // `validateLiveHarnessTurn()` internally, so this test drives `startTurn()`
    // directly to obtain the Driver's genuinely raw, never-validated handle.
    const rawLive = await service.startTurn({ scope, preparedTurn, launchContext });
    assert.throws(() => durableTurnEvidence(rawLive), /validateLiveHarnessTurn/);
    const validated = validateLiveHarnessTurn(rawLive, { driver: service, route: accepted.route });
    const evidence = durableTurnEvidence(validated);
    assert.equal(evidence.nativeTurnRef.locator.turnId, "service-turn-1");
  });
});

/**
 * Independent-review correction: `validateNormalizedTerminalResult()` must
 * never spread or re-read `result` after its initial safe snapshot -- a
 * getter that answers differently on a second read must never be able to
 * change `finalMessage` (or any other field) after its bound check ran.
 */
describe("NormalizedTerminalResult integration hardening (finding 6)", () => {
  it("rejects a class-backed terminal result explicitly rather than silently accepting then dropping fields", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);
    control.complete("service-turn-1", "completed");
    const valid = await live.result;

    class ResultLike {}
    const classBacked = Object.assign(new ResultLike(), valid);
    assert.throws(
      () => validateNormalizedTerminalResult(classBacked, { driver: service, route: accepted.route }),
      /must be a plain object/,
    );
  });

  it("rejects a Proxy-wrapped terminal result before any reflective operation", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);
    control.complete("service-turn-1", "completed");
    const valid = await live.result;
    let trapCalls = 0;
    const proxied = new Proxy(valid, {
      get(target, prop, receiver) { trapCalls += 1; return Reflect.get(target, prop, receiver); },
      ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { trapCalls += 1; return Reflect.getOwnPropertyDescriptor(target, prop); },
    });
    assert.throws(
      () => validateNormalizedTerminalResult(proxied, { driver: service, route: accepted.route }),
      /must not be a Proxy/,
    );
    assert.equal(trapCalls, 0);
  });

  it("rejects a changing finalMessage getter without ever invoking it; finalMessage cannot change after its bound check", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);
    control.complete("service-turn-1", "completed");
    const valid = await live.result;

    const { finalMessage: _drop, ...withoutFinalMessage } = valid;
    let reads = 0;
    const tampered = { ...withoutFinalMessage };
    Object.defineProperty(tampered, "finalMessage", {
      get() {
        reads += 1;
        return reads === 1 ? "short valid answer" : "x".repeat(MAX_FINAL_MESSAGE_CHARS + 1);
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validateNormalizedTerminalResult(tampered, { driver: service, route: accepted.route }),
      /getter\/setter accessor/,
    );
    assert.equal(reads, 0);
  });

  it("is a fixed point: revalidating its own canonical output succeeds and reproduces the same result", async () => {
    const { driver: service, control } = createFakeServiceDriver({ autoComplete: false });
    const { accepted, live } = await runGenericServiceTurn(service);
    control.complete("service-turn-1", "completed");
    const once = validateNormalizedTerminalResult(await live.result, { driver: service, route: accepted.route });
    const twice = validateNormalizedTerminalResult(once, { driver: service, route: accepted.route });
    assert.deepEqual(JSON.parse(JSON.stringify(once)), JSON.parse(JSON.stringify(twice)));
  });
});

/**
 * Reopened acceptance repair for tasks 1.2/1.4.
 *
 * Every durable opaque field a Driver returns -- `continuation.evidence`, an
 * object `failure.detail`, `progress`, `resultMetadata`, and `driverReceipt` --
 * must be canonicalized into fresh, deep-frozen plain data *before* any
 * identity or byte-bound check, so the exact value that passed validation is
 * the value that becomes durable state. A getter, a `toJSON`, or a Proxy trap
 * nested anywhere inside one of those fields must never execute at all: a
 * check-time/persistence-time gap there is a durable-result TOCTOU, not a
 * cosmetic one.
 */
describe("durable opaque field canonicalization (reopened acceptance repair)", () => {
  async function serviceTurn() {
    const { driver: service } = createFakeServiceDriver();
    const { accepted, live } = await runGenericServiceTurn(service);
    const valid = await live.result;
    const route = accepted.route;
    const validate = (overrides) =>
      validateNormalizedTerminalResult({ ...valid, ...overrides }, { driver: service, route });
    return { service, route, valid, validate };
  }

  /** A failed-status result body, the only shape whose `failure.detail` is meaningful. */
  function failedWith(detail) {
    return {
      status: "failed",
      finalMessage: null,
      finalMessageAbsenceReason: "fatal",
      failure: { class: "fatal", reason: "boom", detail, resumable: false, requiresAttention: false },
    };
  }

  /** A Proxy that counts every trap it can observe, so "never invoked" is proven, not assumed. */
  function countingProxy(target, counter) {
    return new Proxy(target, {
      get(object, property, receiver) { counter.calls += 1; return Reflect.get(object, property, receiver); },
      has(object, property) { counter.calls += 1; return Reflect.has(object, property); },
      ownKeys(object) { counter.calls += 1; return Reflect.ownKeys(object); },
      getOwnPropertyDescriptor(object, property) {
        counter.calls += 1;
        return Reflect.getOwnPropertyDescriptor(object, property);
      },
      getPrototypeOf(object) { counter.calls += 1; return Reflect.getPrototypeOf(object); },
    });
  }

  it("reads Driver receipt identity from the canonical clone, never from a changing getter", async () => {
    const { service, validate } = await serviceTurn();

    // Validation-time read says `fake-service`; every later read says
    // `evil-harness`, which is exactly what would reach durable state if the
    // raw receipt were returned after its identity check.
    let reads = 0;
    const tampered = {
      driverVersion: service.driverVersion,
      receipt: { serviceTurn: "service-turn-1" },
    };
    Object.defineProperty(tampered, "harnessId", {
      get() {
        reads += 1;
        return reads === 1 ? service.harnessId : "evil-harness";
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validate({ driverReceipt: tampered }),
      /Driver receipt field "harnessId" must be a plain data property, not a getter\/setter accessor/,
    );
    assert.equal(reads, 0, "the identity getter must never be invoked");

    // A well-formed receipt is admitted, canonical, immutable, and detached
    // from the Driver's own object.
    const raw = {
      harnessId: service.harnessId,
      driverVersion: service.driverVersion,
      receipt: { serviceTurn: "service-turn-1", attempts: [{ index: 1 }] },
    };
    const canonical = validate({ driverReceipt: raw }).driverReceipt;
    assert.equal(canonical.harnessId, service.harnessId);
    assert.equal(canonical.driverVersion, service.driverVersion);
    assert.notEqual(canonical, raw);
    assert.equal(Object.isFrozen(canonical), true);
    assert.equal(Object.isFrozen(canonical.receipt), true);
    assert.equal(Object.isFrozen(canonical.receipt.attempts), true);
    assert.equal(Object.isFrozen(canonical.receipt.attempts[0]), true);
    raw.receipt.serviceTurn = "mutated-after-validation";
    raw.receipt.attempts[0].index = 999;
    assert.equal(canonical.receipt.serviceTurn, "service-turn-1");
    assert.equal(canonical.receipt.attempts[0].index, 1);

    // The foreign-contract refusal is unchanged for an ordinary receipt.
    assert.throws(
      () => validate({ driverReceipt: boundedDriverReceipt("other-service", "other-service@1", {}) }),
      /Driver receipt belongs to a foreign Driver contract/,
    );
  });

  it("refuses a nested changing getter in progress that is small at check time and oversized at persistence time", async () => {
    const { validate } = await serviceTurn();
    let reads = 0;
    const nested = {};
    Object.defineProperty(nested, "blob", {
      get() {
        reads += 1;
        return reads === 1 ? "small" : "x".repeat(64 * 1024);
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validate({ progress: { toolUses: [], nested } }),
      /progress\.nested field "blob" must be a plain data property, not a getter\/setter accessor/,
    );
    assert.equal(reads, 0, "the nested progress getter must never be invoked");
  });

  it("refuses a nested toJSON in result metadata that would emit secrets and an oversized payload at persistence time", async () => {
    const { validate } = await serviceTurn();
    let calls = 0;
    const nested = {
      summary: "benign",
      toJSON() {
        calls += 1;
        return calls === 1
          ? { summary: "benign" }
          : { apiKey: "sk-live-should-never-persist", transcript: "x".repeat(64 * 1024) };
      },
    };
    assert.throws(
      () => validate({ resultMetadata: { detail: nested } }),
      /result metadata\.detail\.toJSON must not carry a function or callback/,
    );
    assert.equal(calls, 0, "a nested toJSON must never be invoked");

    // The same hook one link up the prototype chain is refused as a live/class
    // container, before `JSON.stringify` could consult it.
    class SneakyMetadata {
      constructor() {
        this.summary = "benign";
      }
      toJSON() {
        calls += 1;
        return { apiKey: "sk-live-should-never-persist" };
      }
    }
    assert.throws(
      () => validate({ resultMetadata: { detail: new SneakyMetadata() } }),
      /result metadata\.detail must be a plain data object/,
    );
    assert.equal(calls, 0);
  });

  it("refuses a nested Proxy in every durable opaque field before any trap can run", async () => {
    const { validate } = await serviceTurn();
    const cases = [
      ["progress", (hooked) => ({ progress: { nested: hooked } }), /progress\.nested must not be a Proxy/],
      ["resultMetadata", (hooked) => ({ resultMetadata: { nested: hooked } }), /result metadata\.nested must not be a Proxy/],
      [
        "driverReceipt",
        (hooked) => ({
          driverReceipt: { harnessId: "fake-service", driverVersion: FAKE_SERVICE_DRIVER_VERSION, receipt: hooked },
        }),
        /Driver receipt\.receipt must not be a Proxy/,
      ],
      [
        "continuation.evidence",
        (hooked) => ({ continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: { nested: hooked } } }),
        /continuation evidence\.nested must not be a Proxy/,
      ],
      ["failure.detail", (hooked) => failedWith({ nested: hooked }), /failure detail\.nested must not be a Proxy/],
    ];
    for (const [name, build, pattern] of cases) {
      const counter = { calls: 0 };
      const hooked = countingProxy({ ok: true }, counter);
      assert.throws(() => validate(build(hooked)), pattern, `${name} must refuse a nested Proxy`);
      assert.equal(counter.calls, 0, `${name} must not invoke a single Proxy trap`);
    }
  });

  it("refuses functions, live containers, cycles, and non-JSON scalars nested in opaque fields", async () => {
    const { validate } = await serviceTurn();
    let callbackCalls = 0;
    const check = (overrides, pattern) => assert.throws(() => validate(overrides), pattern);

    check(
      { resultMetadata: { hook: () => { callbackCalls += 1; } } },
      /result metadata\.hook must not carry a function or callback/,
    );
    check({ progress: { started: new Date() } }, /progress\.started must be a plain data object/);
    check({ resultMetadata: { index: new Map([["a", 1]]) } }, /result metadata\.index must be a plain data object/);
    check(
      { resultMetadata: { stream: new (class NativeStream { constructor() { this.fd = 3; } })() } },
      /result metadata\.stream must be a plain data object/,
    );
    check({ resultMetadata: { size: 1n } }, /result metadata\.size must not carry a bigint value/);
    check({ resultMetadata: { missing: undefined } }, /result metadata\.missing must not carry an undefined value/);
    check({ resultMetadata: { ratio: Number.NaN } }, /result metadata\.ratio must be a finite number/);
    // A genuine hole, built without a sparse array literal.
    const sparse = [1, 2, 3];
    delete sparse[1];
    check({ progress: { items: sparse } }, /progress\.items contains a hole at index 1/);
    check(
      { progress: { items: Object.assign([1, 2], { extra: "smuggled" }) } },
      /progress\.items declares a non-index field: "extra"/,
    );
    check(
      { resultMetadata: { rows: new (class Rows extends Array {})() } },
      /result metadata\.rows must be an ordinary Array/,
    );
    check(
      { resultMetadata: Object.defineProperty({}, "hidden", { value: 1, enumerable: false }) },
      /result metadata field "hidden" must be an enumerable own property/,
    );
    check(
      { resultMetadata: { [Symbol("tag")]: 1, ok: true } },
      /result metadata must not carry symbol-keyed fields/,
    );
    check(
      { resultMetadata: JSON.parse('{"ok":true,"__proto__":{"polluted":true}}') },
      /result metadata field "__proto__" would rewrite object structure/,
    );
    assert.equal({}.polluted, undefined, "Object.prototype must never be polluted");
    assert.equal(callbackCalls, 0);

    const cyclicProgress = { attempts: [] };
    cyclicProgress.self = cyclicProgress;
    check({ progress: cyclicProgress }, /progress\.self contains a cycle/);

    // Runaway nesting fails closed with a bounded, field-named refusal instead
    // of the raw `RangeError: Maximum call stack size exceeded` a recursive
    // `JSON.stringify()` bound check raises.
    const nest = (depth) => {
      let node = { leaf: true };
      for (let level = 0; level < depth; level += 1) node = { child: node };
      return node;
    };
    assert.ok(validate({ resultMetadata: nest(30) }).resultMetadata.child);
    for (const depth of [40, 5_000]) {
      assert.throws(
        () => validate({ resultMetadata: nest(depth) }),
        (error) => error instanceof Error &&
          !(error instanceof RangeError) &&
          /result metadata(\.child)+ exceeds its maximum nesting depth of 32/.test(error.message),
        `depth ${depth} must fail closed with a field-named refusal`,
      );
    }
  });

  it("refuses changing getters and cycles in continuation evidence and failure detail", async () => {
    const { validate } = await serviceTurn();
    let evidenceReads = 0;
    const evidenceInner = {};
    Object.defineProperty(evidenceInner, "source", {
      get() {
        evidenceReads += 1;
        return evidenceReads === 1 ? "service_turn_status" : "x".repeat(8 * 1024);
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validate({ continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: { evidenceInner } } }),
      /continuation evidence\.evidenceInner field "source" must be a plain data property/,
    );
    assert.equal(evidenceReads, 0);

    const cyclicEvidence = { source: "service_turn_status" };
    cyclicEvidence.self = cyclicEvidence;
    assert.throws(
      () => validate({ continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: cyclicEvidence } }),
      /continuation evidence\.self contains a cycle/,
    );

    let detailReads = 0;
    const detailInner = {};
    Object.defineProperty(detailInner, "serviceStatus", {
      get() {
        detailReads += 1;
        return detailReads === 1 ? 503 : "x".repeat(8 * 1024);
      },
      enumerable: true,
      configurable: true,
    });
    assert.throws(
      () => validate(failedWith({ detailInner })),
      /failure detail\.detailInner field "serviceStatus" must be a plain data property/,
    );
    assert.equal(detailReads, 0);

    const cyclicDetail = { serviceStatus: 503 };
    cyclicDetail.self = cyclicDetail;
    assert.throws(() => validate(failedWith(cyclicDetail)), /failure detail\.self contains a cycle/);
  });

  it("computes every opaque byte bound on the canonical JSON, in bytes, after full validation", async () => {
    const { validate } = await serviceTurn();
    // 3-byte characters: 3_000 UTF-16 units (well under an 8 KiB length check)
    // but ~9_000 UTF-8 bytes, so only a byte-accurate bound catches it.
    assert.throws(
      () => validate({ resultMetadata: { blob: "€".repeat(3_000) } }),
      /result metadata exceeds its durable bound/,
    );
    // Nested accumulation: no single field is large, the total is.
    const nested = {};
    for (let index = 0; index < 40; index += 1) nested[`field-${index}`] = { note: "n".repeat(1_024) };
    assert.throws(() => validate({ progress: nested }), /progress exceeds its durable bound/);
    // Unknown keys stay admitted for a genuinely opaque field: the locator
    // forbidden-key policy is deliberately not applied to generic metadata.
    const admitted = validate({
      resultMetadata: { citations: 2, tokenUsage: { input: 10 }, endpointHits: 3, headers: ["x-trace"] },
    }).resultMetadata;
    assert.deepEqual(admitted.tokenUsage, { input: 10 });
    assert.deepEqual(admitted.headers, ["x-trace"]);
  });

  it("is a fixed point and JSON round-trip stable with every optional field present", async () => {
    const { service, route, validate } = await serviceTurn();
    const rawMetrics = {
      version: 1,
      provider_reported: {
        duration_ms: 5,
        duration_api_ms: 4,
        turn_count: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        reported_cost_usd: 0.25,
      },
      plugin_observed: { tool_call_count: 2, attempt_count: 1, recovery_attempt_count: 0 },
    };
    const rawProgress = { toolUses: ["Read"], touchedFiles: [], attempts: [{ index: 1 }], recoveryAttempts: 0 };
    const rawMetadata = { citations: 2, nested: { depth: [1, 2, { ok: true }] } };
    const rawReceipt = { harnessId: "fake-service", driverVersion: FAKE_SERVICE_DRIVER_VERSION, receipt: { serviceTurn: "service-turn-1" } };
    const rawEvidence = { source: "service_turn_status", observations: [{ at: 1 }] };
    const rawDetail = { serviceStatus: 503, retries: [1, 2] };

    const once = validate({
      ...failedWith(rawDetail),
      finalMessage: "partial answer before failure",
      continuation: { mode: "fresh_only", nativeSessionRef: null, evidence: rawEvidence },
      progress: rawProgress,
      metrics: rawMetrics,
      resultMetadata: rawMetadata,
      driverReceipt: rawReceipt,
    });
    const twice = validateNormalizedTerminalResult(once, { driver: service, route });

    assert.deepStrictEqual(twice, once);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(once)), once);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)));

    // Every opaque field is a fresh, deep-frozen clone, and only normalized
    // metrics survive.
    for (const [field, raw] of [
      ["progress", rawProgress],
      ["resultMetadata", rawMetadata],
      ["driverReceipt", rawReceipt],
      ["metrics", rawMetrics],
    ]) {
      assert.notEqual(once[field], raw, `${field} must not be the Driver's own object`);
      assert.equal(Object.isFrozen(once[field]), true, `${field} must be frozen`);
    }
    assert.notEqual(once.continuation.evidence, rawEvidence);
    assert.notEqual(once.failure.detail, rawDetail);
    assert.equal(Object.isFrozen(once.continuation.evidence), true);
    assert.equal(Object.isFrozen(once.failure.detail), true);
    assert.equal(Object.isFrozen(once.resultMetadata.nested.depth), true);
    assert.equal(Object.isFrozen(once.resultMetadata.nested.depth[2]), true);
    assert.deepEqual(once.metrics.provider_reported.reported_cost_usd, 0.25);

    // Mutating the Driver's own objects after validation cannot reach durable state.
    rawProgress.attempts[0].index = 999;
    rawEvidence.observations[0].at = 999;
    rawDetail.retries[0] = 999;
    assert.equal(once.progress.attempts[0].index, 1);
    assert.equal(once.continuation.evidence.observations[0].at, 1);
    assert.equal(once.failure.detail.retries[0], 1);
  });
});

// ---------------------------------------------------------------------------
// Every admitted Driver, not just the fixture one (Task 9.1).
//
// The cases above prove the contract against `fake-service`, which exists to be
// bent in ways a real Driver never would. That leaves the real question
// unasked: does every Driver this checkout actually admits satisfy the same
// contract? These enumerate `ADMITTED_DRIVER_V2_HARNESS_IDS` rather than a hand
// list, so a Driver added later joins this suite by existing.
//
// Only the STATIC half is shared here. `inspectInstances()` and everything
// downstream of it need per-Driver scaffolding -- a fake Server for OpenCode, a
// seamed host observation for Claude -- and those semantics already have their
// own owning suites. Re-proving them here would duplicate, not generalize.
// ---------------------------------------------------------------------------

describe("Driver Contract v2 conformance across every admitted Harness", () => {
  const admittedDrivers = () =>
    ADMITTED_DRIVER_V2_HARNESS_IDS.map((harnessId) => ({
      harnessId,
      driver: resolveDriverV2(harnessId, { env: {} }),
    }));

  it("admits every statically registered Driver under the same validation", () => {
    assert.deepEqual([...ADMITTED_DRIVER_V2_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    for (const { harnessId, driver } of admittedDrivers()) {
      assert.equal(validateDriverV2(driver), driver, harnessId);
      assert.equal(admitDriverV2(driver), driver, harnessId);
      assert.equal(driver.harnessId, harnessId);
      assert.equal(driver.contractVersion, DRIVER_CONTRACT_VERSION_V2);
      assert.match(driver.driverVersion, /^[a-z0-9-]+@\d+$/, harnessId);
    }
  });

  it("implements every required operation and declares no optional one as a non-function", () => {
    for (const { harnessId, driver } of admittedDrivers()) {
      for (const operation of DRIVER_V2_OPERATIONS) {
        assert.equal(typeof driver[operation], "function", `${harnessId}.${operation}`);
      }
      for (const operation of DRIVER_V2_OPTIONAL_OPERATIONS) {
        if (driver[operation] != null) {
          assert.equal(typeof driver[operation], "function", `${harnessId}.${operation}`);
        }
      }
    }
  });

  it("keeps describe() static, argument-free, and free of endpoint or credential identity", () => {
    for (const { harnessId, driver } of admittedDrivers()) {
      assert.equal(driver.describe.length, 0, harnessId);
      const first = driver.describe();
      const second = driver.describe();
      assert.deepEqual(first, second, harnessId);
      assert.equal(first.harnessId, harnessId);
      assert.equal(first.contractVersion, DRIVER_CONTRACT_VERSION_V2);
      assert.equal(first.driverVersion, driver.driverVersion);
      assert.equal(typeof first.maturity, "string");
      // A description is static metadata, so it can carry no live identity.
      const serialized = JSON.stringify(first);
      assert.doesNotMatch(serialized, /https?:\/\/|password|username|token|secret/i, harnessId);
      // The declared environment keys are names, never values.
      for (const key of first.environmentKeys ?? []) {
        assert.match(key, /^[A-Z][A-Z0-9_]*$/, `${harnessId} environmentKeys`);
      }
    }
  });

  it("refuses to resolve a Driver whose registry identity does not match the request", () => {
    for (const harnessId of ADMITTED_DRIVER_V2_HARNESS_IDS) {
      // A miscased identity is refused by the identity vocabulary itself, before
      // the registry is consulted; either refusal is fail-closed.
      assert.throws(
        () => resolveDriverV2(harnessId.toUpperCase(), { env: {} }),
        /Invalid Harness ID|Unknown Harness/,
        harnessId,
      );
    }
    assert.throws(() => resolveDriverV2("", { env: {} }), /Harness/);
    assert.throws(() => resolveDriverV2(undefined, { env: {} }), /Harness/);
  });

  it("gives every admitted Driver a distinct Harness identity and Driver version", () => {
    const drivers = admittedDrivers();
    assert.equal(new Set(drivers.map((entry) => entry.harnessId)).size, drivers.length);
    assert.equal(new Set(drivers.map((entry) => entry.driver.driverVersion)).size, drivers.length);
  });
});
