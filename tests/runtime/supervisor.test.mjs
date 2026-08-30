import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { mergeAttemptOutput, runClaudeTaskSession } from "../../runtime/job-supervisor.mjs";
import {
  enqueueSteeringMessage,
  readJobFile,
  transitionJob,
  writeJobFile,
} from "../../runtime/job-store.mjs";

const priorHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const roots = [];
afterEach(() => {
  if (priorHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-supervisor-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  roots.push(root);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
  writeJobFile(workspace, "cc-1", {
    id: "cc-1",
    workspaceRoot: workspace,
    status: "running",
    acceptingSteering: true,
  });
  return { workspace };
}

function failed(sessionId = "session-1") {
  return {
    status: "failed",
    exitCode: 1,
    sessionId,
    finalMessage: "partial",
    stderr: "Connection closed mid-response",
    failureClass: sessionId ? "transport_closed_resumable" : "protocol_unknown",
    toolUses: [], touchedFiles: [], terminalEvents: [],
  };
}

function completed(sessionId = "session-1") {
  return {
    status: "completed",
    exitCode: 0,
    sessionId,
    finalMessage: "partial then done",
    stderr: "",
    failureClass: null,
    toolUses: [], touchedFiles: [], terminalEvents: [],
  };
}

describe("job supervisor", () => {
  it("resumes the exact session without replaying the original prompt", async () => {
    const { workspace } = setup();
    const calls = [];
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "ORIGINAL TASK",
      write: true,
      retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 0, jitterRatio: 0 },
      runAttempt: async (_cwd, prompt, options) => {
        calls.push({ prompt, resume: options.resumeSessionId ?? null });
        return calls.length === 1 ? failed() : completed();
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.sessionId, "session-1");
    assert.equal(result.recoveryAttempts, 1);
    assert.deepEqual(calls[0], { prompt: "ORIGINAL TASK", resume: null });
    assert.equal(calls[1].resume, "session-1");
    assert.doesNotMatch(calls[1].prompt, /ORIGINAL TASK/);
    assert.equal(result.finalMessage, "partial then done");
  });

  it("fails closed for any recovery capability other than a same-session recovery prompt", async () => {
    const { workspace } = setup();
    let calls = 0;
    await assert.rejects(
      runClaudeTaskSession({
        workspaceRoot: workspace,
        jobId: "cc-1",
        cwd: workspace,
        prompt: "ORIGINAL TASK",
        automaticRecovery: "exact_session_transport",
        runAttempt: async () => { calls += 1; return completed(); },
      }),
      /recovery is unavailable for automaticRecovery="exact_session_transport"/,
    );
    assert.equal(calls, 0);
  });

  it("returns an orchestrator transport close without reconnect while retaining exact parent continuation evidence", async () => {
    const { workspace } = setup();
    let calls = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "bounded team task",
      write: true,
      retryPolicy: { maxReconnectAttempts: 0 },
      runAttempt: async () => {
        calls += 1;
        return { ...failed("parent-session"), resumable: true };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.failureClass, "transport_closed_resumable");
    assert.equal(result.resumable, true);
    assert.equal(result.sessionId, "parent-session");
    assert.equal(result.recoveryAttempts, 0);
    assert.equal(result.manualResumeCommand, "claude --resume parent-session");
    assert.match(result.warning, /Automatic recovery budget exhausted/);
  });

  it("returns only the completed recovery attempt handoff", async () => {
    const { workspace } = setup();
    let attempts = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: false,
      retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 0, jitterRatio: 0 },
      runAttempt: async () => {
        attempts += 1;
        return attempts === 1
          ? { ...failed(), finalMessage: "intermediate narration" }
          : { ...completed(), finalMessage: "final evidence memo" };
      },
    });

    assert.equal(result.finalMessage, "final evidence memo");
    assert.equal(readJobFile(workspace, "cc-1").partialOutput, "intermediate narration\nfinal evidence memo");
  });

  it("does not reconnect from transport-shaped assistant prose", async () => {
    const { workspace } = setup();
    let attempts = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "audit transport handling",
      write: false,
      retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 0, jitterRatio: 0 },
      runAttempt: async () => {
        attempts += 1;
        return {
          ...failed(),
          stderr: "",
          failureClass: "fatal",
          finalMessage: "The report discusses HTTP 429 and a socket reset in another system.",
        };
      },
    });

    assert.equal(attempts, 1);
    assert.equal(result.failureClass, "fatal");
  });

  it("lets cancellation win during reconnect backoff", async () => {
    const { workspace } = setup();
    let attempts = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: false,
      retryPolicy: { maxReconnectAttempts: 2, baseDelayMs: 100, jitterRatio: 0 },
      runAttempt: async () => { attempts += 1; return failed(); },
      sleep: async () => {
        transitionJob(workspace, "cc-1", ["running"], "cancelled");
      },
    });
    assert.equal(attempts, 1);
    assert.equal(result.failureClass, "cancelled_or_interrupted");
    assert.equal(readJobFile(workspace, "cc-1").status, "cancelled");
  });

  it("refuses fresh replay after possible write side effects without a session", async () => {
    const { workspace } = setup();
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "write task",
      write: true,
      runAttempt: async () => ({
        ...failed(null),
        failureClass: "transport_closed_resumable",
        toolUses: [{ tool: "Write", input: { file_path: "a.txt" } }],
      }),
    });
    assert.equal(result.requiresAttention, true);
    assert.match(result.warning, /refusing to replay/i);
  });

  it("never reconnects an explicit subscription or usage-limit failure", async () => {
    const { workspace } = setup();
    let attempts = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "cheap smoke",
      write: false,
      retryPolicy: { maxReconnectAttempts: 3, baseDelayMs: 0, jitterRatio: 0 },
      runAttempt: async () => {
        attempts += 1;
        return {
          ...failed(),
          stderr: "HTTP 429: You've hit your limit · resets tomorrow",
          failureClass: "usage_or_subscription_limit",
          failureReason: "You've hit your limit · resets tomorrow",
        };
      },
    });
    assert.equal(attempts, 1);
    assert.equal(result.failureClass, "usage_or_subscription_limit");
    assert.equal(result.recoveryAttempts, 0);
  });

  it("rejects exact-session drift instead of accepting a different session", async () => {
    const { workspace } = setup();
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "continue",
      write: false,
      claudeOptions: { resumeSessionId: "expected-session" },
      runAttempt: async () => completed("different-session"),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.sessionId, "expected-session");
    assert.equal(result.failureClass, "protocol_session_drift");
    assert.match(result.warning, /expected expected-session, observed different-session/);
  });

  it("aggregates side-effect and hook receipts across reconnect attempts", async () => {
    const { workspace } = setup();
    let call = 0;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: true,
      retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 0, jitterRatio: 0 },
      runAttempt: async () => {
        call += 1;
        if (call === 1) {
          return {
            ...failed(),
            toolUses: [{ tool: "Write", input: { file_path: "a.txt" } }],
            touchedFiles: ["a.txt"],
            runtimeReceipt: { hookReceipts: [{ hook: "PostToolUse", status: "success" }] },
          };
        }
        return {
          ...completed(),
          runtimeReceipt: { hookReceipts: [] },
        };
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.toolUses, [{ tool: "Write", input: { file_path: "a.txt" } }]);
    assert.deepEqual(result.touchedFiles, ["a.txt"]);
    assert.deepEqual(result.runtimeReceipt.hookReceipts, [
      { hook: "PostToolUse", status: "success" },
    ]);
    assert.equal(result.attempts[0].toolUses.length, 1);
    assert.equal(result.attempts[0].hookReceipts.length, 1);
  });

  it("does not merge accidental one-character output overlap", () => {
    assert.equal(mergeAttemptOutput("hello", "orange"), "hello\norange");
  });

  it("recovers two simultaneous disconnects without cross-job state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-supervisor-pair-"));
    roots.push(root);
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
    const workspaces = ["a", "b"].map((name) => {
      const workspace = path.join(root, name);
      fs.mkdirSync(workspace);
      writeJobFile(workspace, `cc-${name}`, {
        id: `cc-${name}`,
        workspaceRoot: workspace,
        status: "running",
        acceptingSteering: true,
      });
      return workspace;
    });
    const results = await Promise.all(workspaces.map((workspace, index) => {
      let call = 0;
      const sessionId = `session-${index}`;
      return runClaudeTaskSession({
        workspaceRoot: workspace,
        jobId: `cc-${index === 0 ? "a" : "b"}`,
        cwd: workspace,
        prompt: `task-${index}`,
        write: false,
        retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 0, jitterRatio: 0 },
        runAttempt: async () => {
          call += 1;
          return call === 1 ? failed(sessionId) : completed(sessionId);
        },
      });
    }));
    assert.deepEqual(results.map((result) => result.status), ["completed", "completed"]);
    assert.deepEqual(results.map((result) => result.sessionId), ["session-0", "session-1"]);
    assert.deepEqual(results.map((result) => result.recoveryAttempts), [1, 1]);
  });

  it("delivers steering queued during reconnect exactly once and acknowledges it", async () => {
    const { workspace } = setup();
    let call = 0;
    const delivered = [];
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: false,
      retryPolicy: { maxReconnectAttempts: 1, baseDelayMs: 1, jitterRatio: 0 },
      sleep: async () => {
        enqueueSteeringMessage(workspace, "cc-1", "during reconnect");
      },
      runAttempt: async (_cwd, _prompt, options) => {
        call += 1;
        if (call === 1) return failed();
        const pending = await options.pollInput();
        for (const message of pending) {
          delivered.push(message.text);
          options.onInputDispatched(message);
          options.onInputAcknowledged(message);
        }
        return completed();
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(delivered, ["during reconnect"]);
    assert.equal(result.steering.pendingCount, 0);
    assert.equal(result.steering.latestAcknowledgedSequence, 1);
  });

  it("enters running_attempt only after the durable child receipt is accepted", async () => {
    const { workspace } = setup();
    let observedAcceptance = null;
    let observedPhase = null;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: false,
      onSpawn: () => false,
      runAttempt: async (_cwd, _prompt, options) => {
        observedAcceptance = await options.onSpawn({ pid: process.pid, pidIdentity: "fake" });
        observedPhase = readJobFile(workspace, "cc-1").phase;
        return completed();
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(observedAcceptance, false);
    assert.equal(observedPhase, "starting_attempt");
  });

  it("records running_attempt after the durable child receipt is accepted", async () => {
    const { workspace } = setup();
    let observedAcceptance = null;
    const result = await runClaudeTaskSession({
      workspaceRoot: workspace,
      jobId: "cc-1",
      cwd: workspace,
      prompt: "task",
      write: false,
      onSpawn: () => true,
      runAttempt: async (_cwd, _prompt, options) => {
        observedAcceptance = await options.onSpawn({ pid: process.pid, pidIdentity: "fake" });
        assert.equal(readJobFile(workspace, "cc-1").phase, "running_attempt");
        return completed();
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(observedAcceptance, true);
  });
});
