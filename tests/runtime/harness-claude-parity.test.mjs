import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
  createClaudeCodeDriver,
} from "../../runtime/claude-code-driver.mjs";
import { getConfig } from "../../runtime/job-store.mjs";

const roots = [];
after(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function scratch(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-harness-parity-${label}-`));
  roots.push(root);
  return root;
}

const driver = createClaudeCodeDriver();
const MODELS = [
  ["claude-haiku-4-5", "claude-haiku-4-5", "low"],
  ["claude-sonnet-5", "claude-sonnet-5", "high"],
  ["claude-opus-5", "claude-opus-5", "xhigh"],
  ["claude-fable-5", "claude-fable-5", "max"],
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Capture the exact native envelope the Driver builds without launching Claude. */
async function captureTurn(route, options = {}) {
  let captured = null;
  const result = await driver.startTurn({
    workspaceRoot: options.cwd ?? "/workspace",
    cwd: options.cwd ?? "/workspace",
    jobId: "cc-parity-1",
    prompt: options.prompt ?? "do the work",
    route: { ...route, effort: route.effort ?? "high" },
    env: { CLAUDE_CONFIG_DIR: options.claudeConfigDir ?? "/data/.claude", PATH: "/usr/bin" },
    launchContext: {
      compatibility: { fingerprint: "fingerprint-1", executable: "/usr/local/bin/claude" },
    },
    sessionName: options.sessionName,
    resumeSessionId: options.resumeSessionId,
    onNativeTeamWitness: options.onNativeTeamWitness,
    runTurnSession: async (request) => {
      captured = request;
      return options.turn ?? {
        status: "failed",
        exitCode: 1,
        sessionId: null,
        finalMessage: "",
        failureClass: "fatal",
        failureReason: "parity fixture did not run Claude",
        resumable: false,
        recoveryAttempts: 0,
        attempts: [],
        steering: { messages: [], latestAcknowledgedSequence: 0 },
        runtimeReceipt: {},
        toolUses: [],
        touchedFiles: [],
      };
    },
  });
  return { captured, result };
}

describe("claude-code Driver preserves established Claude execution semantics", () => {
  it("publishes the observable capability snapshot for this checkout", () => {
    assert.deepEqual(driver.capabilities, {
      activeInput: "acknowledged_active_stream",
      continuation: "exact_resume",
      history: "assistant_messages",
      interrupt: "graceful_flush_proven",
      automaticRecovery: "same_session_recovery_prompt",
      // terminal-parity always passes the dangerous bypass, so write intent is
      // a prompt-level authority boundary rather than a process control.
      authorityEnforcement: "prompt_only",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "opaque_bounded",
    });
    assert.equal(driver.harnessId, CLAUDE_CODE_HARNESS_ID);
    assert.equal(driver.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    assert.equal(CLAUDE_CODE_CAPABILITIES, driver.capabilities);
  });

  it("admits exactly the established model, effort, and topology routes", () => {
    for (const [alias, canonical, defaultEffort] of MODELS) {
      for (const model of [alias, canonical]) {
        const validated = driver.validateRoute({ model, effort: defaultEffort, write: false, delegationMode: "leaf" });
        assert.equal(validated.model, canonical);
        assert.equal(validated.name, "terminal-parity");
        assert.equal(validated.dangerouslySkipPermissions, true);
        assert.equal(validated.delegationMode, "leaf");
        assert.equal(validated.effort, defaultEffort);
        assert.equal(
          driver.validateRoute({ profile: "safe", model, effort: defaultEffort, write: false }).effort,
          defaultEffort,
        );
      }
      for (const effort of EFFORTS) {
        assert.equal(driver.validateRoute({ model: canonical, effort, write: false }).effort, effort);
      }
    }
    for (const model of ["claude-opus-5", "claude-fable-5"]) {
      assert.equal(
        driver.validateRoute({ model, effort: "high", delegationMode: "claude_orchestrator", write: false }).delegationMode,
        "claude_orchestrator",
      );
    }
    assert.throws(
      () => driver.validateRoute({ model: "opus", effort: "high", delegationMode: "claude_orchestrator", write: false }),
      /claude_orchestrator delegation requires exact model claude-opus-5 or claude-fable-5/,
    );
    assert.throws(() => driver.validateRoute({ model: "claude-opus-4-7", write: false }), /Unsupported Claude model/);
    assert.throws(() => driver.validateRoute({ model: "opus", effort: "turbo", write: false }), /Unsupported effort/);
    assert.throws(() => driver.validateRoute({ write: false }), /requires an explicit Haiku, Sonnet, Opus, or Fable model/);
  });

  it("builds the fixed terminal-parity leaf envelope", async () => {
    const { captured } = await captureTurn(
      { model: "claude-sonnet-5", effort: "high", write: false, delegationMode: "leaf" },
      { sessionName: "researcher" },
    );
    const options = captured.claudeOptions;
    assert.equal(options.env.IS_SANDBOX, "1");
    assert.equal(options.dangerouslySkipPermissions, true);
    assert.equal(options.model, "claude-sonnet-5");
    assert.equal(options.effort, "high");
    assert.equal(options.claudeBin, "/usr/local/bin/claude");
    assert.equal(options.sessionName, "researcher");
    assert.equal(options.resumeSessionId, undefined);
    assert.equal(options.settingsFile, undefined);
    assert.equal(options.permissionMode, undefined);
    assert.deepEqual(options.disallowedTools, [
      "Workflow", "ListAgents", "ListPeers", "ScheduleWakeup", "CronCreate", "CronDelete",
      "CronList", "CronUpdate", "RemoteTrigger", "PushNotification", "SendUserMessage",
      "SendUserFile", "SendFile", "EnterWorktree", "ExitWorktree", "Agent", "SendMessage",
    ]);
    assert.match(options.appendSystemPrompt, /Act as a leaf: do not delegate or use Agent\/Workflow\./);
    assert.match(options.appendSystemPrompt, /Read\/review only/);
    assert.equal(captured.write, false);
    assert.deepEqual(captured.harnessInstance, {
      harnessId: "claude-code",
      instanceKey: "/data/.claude",
    });
  });

  it("keeps write intent a prompt-level authority statement", async () => {
    const { captured } = await captureTurn({ model: "claude-opus-5", write: true, delegationMode: "leaf" });
    assert.equal(captured.claudeOptions.dangerouslySkipPermissions, true);
    assert.equal(captured.claudeOptions.permissionMode, undefined);
    assert.match(captured.claudeOptions.appendSystemPrompt, /Task-scoped workspace mutation is allowed/);
    assert.equal(captured.write, true);
  });

  it("threads a native-surface witness only through the internal Driver start-turn seam", async () => {
    const witness = () => {};
    const { captured } = await captureTurn({
      model: "claude-fable-5",
      write: false,
      delegationMode: "claude_orchestrator",
    }, { onNativeTeamWitness: witness });
    assert.equal(captured.claudeOptions.delegationMode, "claude_orchestrator");
    assert.equal(captured.claudeOptions.onNativeTeamWitness, witness);
    assert.deepEqual(Object.keys(captured.claudeOptions.agents), ["haiku-scout", "sonnet", "opus"]);
  });

  it("resumes only the exact captured session and drops the fresh session name", async () => {
    const { captured } = await captureTurn(
      { model: "claude-opus-5", write: false, delegationMode: "leaf" },
      { resumeSessionId: "session-exact", sessionName: "researcher" },
    );
    assert.equal(captured.claudeOptions.resumeSessionId, "session-exact");
    // buildArgs drops --name whenever a resume target is present; the Driver
    // still forwards both so that owner stays a single place.
    assert.equal(captured.claudeOptions.sessionName, "researcher");
  });

  it("normalizes a completed turn into exact session evidence and Claude-owned receipts", async () => {
    const root = scratch("completed");
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = root;
    try {
      const { result } = await captureTurn(
        { model: "opus", write: false, delegationMode: "leaf" },
        {
          cwd: root,
          turn: {
            status: "completed",
            exitCode: 0,
            sessionId: "session-complete",
            finalMessage: "final answer",
            failureClass: null,
            failureReason: null,
            resumable: false,
            recoveryAttempts: 1,
            attempts: [{ attempt: 1 }],
            steering: { messages: [], latestAcknowledgedSequence: 0 },
            runtimeReceipt: {
              claudeCodeVersion: "2.1.220",
              unknownEvents: [{
                type: "future_task",
                subtype: "candidate",
                count: 2,
              }],
              unknownEventCount: 2,
            },
            toolUses: [{ name: "Read" }],
            touchedFiles: ["a.txt"],
          },
        },
      );
      assert.equal(result.status, "completed");
      assert.equal(result.exitStatus, 0);
      assert.equal(result.sessionExactness, "exact");
      assert.deepEqual(result.nativeSession, {
        harnessId: "claude-code",
        instanceKey: "/data/.claude",
        nativeSessionId: "session-complete",
      });
      assert.equal(result.finalMessage, "final answer");
      assert.equal(result.finalMessageAbsenceReason, null);
      assert.equal(result.failure.class, null);
      assert.deepEqual(result.receipts.toolUses, [{ name: "Read" }]);
      assert.equal(result.nativeReceipt.rawOutput, "final answer");
      assert.equal(result.nativeReceipt.runtimeReceipt.executionProfile.name, "terminal-parity");
      assert.equal(result.nativeReceipt.runtimeReceipt.executionProfile.inheritedClaudeConfiguration, true);
      assert.deepEqual(result.nativeReceipt.unknownEvents, [{
        type: "future_task",
        subtype: "candidate",
        count: 2,
      }]);
      assert.equal(result.nativeReceipt.unknownEventCount, 2);
      assert.equal(result.status, "completed");
      assert.equal(result.driverReceipt.harnessId, "claude-code");
      assert.equal(result.driverReceipt.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    } finally {
      delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    }
  });

  it("persists sanitized native-team compatibility evidence for clean and drift turns only", async () => {
    const root = scratch("native-team-observations");
    const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    const claudeConfigDir = path.join(root, ".claude");
    fs.mkdirSync(claudeConfigDir);
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
    const nativeTeamSurface = {
      observed: true,
      delegationMode: "claude_orchestrator",
      canonicalToolNames: ["Agent", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"],
      definitionNames: ["haiku-scout", "sonnet", "opus"],
      missingDefinitions: [],
      missingNecessaryCoordinationTools: [],
      forbiddenTools: [],
      unknownNativeTools: [],
      denySetLiveValidated: true,
      teamTransportLiveValidated: true,
      prompt: "prompt-sentinel",
      sessionId: "session-sentinel",
      roster: "roster-sentinel",
      memory: "memory-sentinel",
    };
    try {
      const clean = await captureTurn(
        { model: "claude-opus-5", write: false, delegationMode: "claude_orchestrator" },
        {
          cwd: root,
          claudeConfigDir,
          turn: {
            status: "completed",
            exitCode: 0,
            sessionId: "clean-session",
            finalMessage: "done",
            failureClass: null,
            failureReason: null,
            resumable: false,
            recoveryAttempts: 0,
            attempts: [],
            steering: { messages: [], latestAcknowledgedSequence: 0 },
            runtimeReceipt: { nativeTeamSurface },
            toolUses: [],
            touchedFiles: [],
          },
        },
      );
      const drift = await captureTurn(
        { model: "claude-opus-5", write: false, delegationMode: "claude_orchestrator" },
        {
          cwd: root,
          claudeConfigDir,
          turn: {
            status: "failed",
            exitCode: 1,
            sessionId: "drift-session",
            finalMessage: "",
            failureClass: "compatibility_surface_drift",
            failureReason: "native team transport drift",
            resumable: false,
            recoveryAttempts: 0,
            attempts: [],
            steering: { messages: [], latestAcknowledgedSequence: 0 },
            runtimeReceipt: {
              nativeTeamSurface: { ...nativeTeamSurface, teamTransportLiveValidated: false },
            },
            toolUses: [],
            touchedFiles: [],
          },
        },
      );
      assert.deepEqual(clean.result.runtime.nativeTeamCompatibilityObservation, {
        recorded: true,
        reason: null,
      });
      assert.deepEqual(drift.result.runtime.nativeTeamCompatibilityObservation, {
        recorded: true,
        reason: null,
      });
      const config = getConfig(root);
      assert.equal(config.claudeCliCompatibility.nativeTeamObservations.length, 2);
      assert.doesNotMatch(JSON.stringify(config), /prompt-sentinel|session-sentinel|roster-sentinel|memory-sentinel/);

      const absent = await captureTurn(
        { model: "opus", write: false, delegationMode: "leaf" },
        {
          cwd: root,
          claudeConfigDir,
        },
      );
      assert.equal(absent.result.runtime.nativeTeamCompatibilityObservation, null);
      assert.equal(getConfig(root).claudeCliCompatibility.nativeTeamObservations.length, 2);
    } finally {
      if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
      else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
    }
  });

  it("refuses to treat a drifted session as exact continuation evidence", async () => {
    const { result } = await captureTurn(
      { model: "opus", write: false, delegationMode: "leaf" },
      {
        turn: {
          status: "failed",
          exitCode: 1,
          sessionId: "observed-session",
          finalMessage: "",
          assistantOutputObserved: false,
          failureClass: "protocol_session_drift",
          failureReason: "expected session-a, observed observed-session",
          stderr: "native drift diagnostic",
          resumable: false,
          recoveryAttempts: 0,
          attempts: [],
          steering: { messages: [], latestAcknowledgedSequence: 0 },
          runtimeReceipt: {},
          toolUses: [],
          touchedFiles: [],
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.sessionExactness, "unproven");
    assert.equal(result.failure.class, "protocol_session_drift");
    // Native failure text renders the turn but stays out of the durable receipt.
    assert.equal(result.failure.detail, "native drift diagnostic");
    assert.equal(Object.hasOwn(result.nativeReceipt, "stderr"), false);
    assert.equal(result.finalMessage, null);
    assert.equal(result.finalMessageAbsenceReason, "expected session-a, observed observed-session");
  });

  it("preserves the non-fallback account-limit result", async () => {
    const { result } = await captureTurn(
      { model: "opus", write: false, delegationMode: "leaf" },
      {
        turn: {
          status: "failed",
          exitCode: 1,
          sessionId: null,
          finalMessage: "",
          failureClass: "usage_or_subscription_limit",
          failureReason: "subscription quota exhausted",
          resumable: false,
          recoveryAttempts: 0,
          attempts: [],
          steering: { messages: [], latestAcknowledgedSequence: 0 },
          runtimeReceipt: {},
          toolUses: [],
          touchedFiles: [],
        },
      },
    );
    assert.equal(result.failure.class, "usage_or_subscription_limit");
    assert.equal(result.failure.resumable, false);
    assert.equal(result.receipts.assistantOutputObserved, false);
    assert.equal(result.nativeReceipt.assistantOutputObserved, false);
    assert.equal(result.nativeSession, null);
  });

  it("binds a fresh redacted credential observation to an authentication failure", async () => {
    const root = scratch("auth-failure-observation");
    const claudeConfigDir = path.join(root, ".claude");
    fs.mkdirSync(claudeConfigDir);
    fs.writeFileSync(path.join(claudeConfigDir, ".credentials.json"), `${JSON.stringify({
      claudeAiOauth: {
        accessToken: "driver-secret-access",
        refreshToken: "driver-secret-refresh",
        expiresAt: Date.parse("2026-08-12T00:00:00.000Z"),
        refreshTokenExpiresAt: Date.parse("2026-09-12T00:00:00.000Z"),
        email: "driver-private@example.invalid",
      },
    })}\n`, { mode: 0o600 });

    const { result } = await captureTurn(
      { model: "opus", write: false, delegationMode: "leaf" },
      {
        cwd: root,
        claudeConfigDir,
        turn: {
          status: "failed",
          exitCode: 1,
          sessionId: "auth-failed-session",
          finalMessage: "",
          failureClass: "auth_or_permission",
          failureReason: "native authentication failed",
          stderr: "OAuth access token has expired",
          resumable: false,
          recoveryAttempts: 0,
          attempts: [],
          steering: { messages: [], latestAcknowledgedSequence: 0 },
          runtimeReceipt: {},
          toolUses: [],
          touchedFiles: [],
        },
      },
    );

    assert.equal(result.failure.class, "auth_or_permission");
    assert.equal(result.failure.resumable, false);
    assert.equal(result.runtime.credentialObservation.source, "native_oauth");
    assert.equal(result.runtime.credentialObservation.configIdentity, fs.realpathSync.native(claudeConfigDir));
    assert.equal(result.runtime.credentialObservation.liveValidated, false);
    assert.deepEqual(
      result.nativeReceipt.runtimeReceipt.credentialObservation,
      result.runtime.credentialObservation,
    );
    assert.doesNotMatch(JSON.stringify(result), /driver-secret|driver-private/);
  });

  it("derives its native instance identity from the fixed Claude configuration", () => {
    assert.equal(driver.resolveInstanceKey({ CLAUDE_CONFIG_DIR: "/data/.claude" }), "/data/.claude");
    assert.equal(
      driver.resolveInstanceKey({ CLAUDE_CONFIG_DIR: "" }),
      path.join(os.homedir(), ".claude"),
    );
  });

  it("fails closed on an unavailable or unauthenticated host CLI", () => {
    const root = scratch("preflight");
    const receipt = driver.preflight({
      cwd: root,
      env: { PATH: root, CODEX_HARNESSDOCK_CLAUDE_BIN: path.join(root, "absent-claude"), CLAUDE_CONFIG_DIR: root },
    });
    assert.equal(receipt.ready, false);
    assert.equal(receipt.availability.available, false);
    assert.equal(receipt.instanceKey, fs.realpathSync.native(root));
    assert.equal(
      driver.describeUnreadiness(receipt),
      "Claude Code CLI is unavailable. Install `claude` and ensure it is on PATH.",
    );
    assert.equal(
      driver.describeUnreadiness({
        availability: { available: true },
        compatibility: { staticCompatible: true },
        auth: { loggedIn: false },
      }),
      "Claude Code CLI is not authenticated. Run `claude auth login` in the same environment.",
    );
    assert.equal(
      driver.describeUnreadiness({
        availability: { available: true },
        compatibility: { staticCompatible: true },
        auth: { loggedIn: true },
      }),
      null,
    );
  });

  it("reads bounded native assistant history through the established owner", () => {
    const root = scratch("history");
    const claudeConfigDir = path.join(root, ".claude");
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot);
    const project = path.join(claudeConfigDir, "projects", workspaceRoot.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    const sessionId = "history-session";
    fs.writeFileSync(
      path.join(project, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "assistant",
          uuid: "m1",
          timestamp: "2026-07-31T00:00:00.000Z",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "first" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "m2",
          timestamp: "2026-07-31T00:00:01.000Z",
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: "second" }] },
        }),
        "",
      ].join("\n"),
    );
    const history = driver.readAssistantHistory(
      {
        claudeSessionId: sessionId,
        claudeConfigDir,
        workspaceRoot,
      },
      { limit: 1 },
    );
    assert.deepEqual(history.messages.map((message) => message.text), ["second"]);
    assert.equal(history.nextBefore, "m2");
  });
});
