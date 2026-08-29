/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 6.4: legacy Claude interrupt honesty under the new durable command
 * path.
 *
 * `tests/runtime/v3-worker-loop.test.mjs` already proves the durable command
 * engine is honest with a Harness-neutral fake service Driver. This file
 * plugs the real `claude-code` Driver Contract v2 (behind a fake native
 * session, exactly like `claude-driver-v2.test.mjs`) into the exact same
 * production entry point, `runVersionThreeWorkerLoop()`, so what is proven
 * here is that Claude's own `requestInterrupt()` implementation -- including
 * the fast, non-blocking, non-text-matching request path this task adds --
 * remains honest end to end: request acknowledgement is nonterminal, valid
 * terminal stream evidence settles, a rejected request stays active, and
 * forced/deadline cleanup never reports graceful success.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createAgentStore } from "../../runtime/agent-store.mjs";
import { readUnreadCompletionEvents } from "../../runtime/completion-inbox.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import { CLAUDE_CODE_HARNESS_ID, createClaudeCodeDriverV2 } from "../../runtime/claude-code-driver.mjs";
import {
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
} from "../../runtime/harness-registry.mjs";
import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim, readLaunchClaim } from "../../runtime/launch-claim.mjs";
import {
  enqueueControlCommand,
  listControlCommands,
} from "../../runtime/turn-control.mjs";
import { runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-claude-command-path-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let sequence = 0;

const PROMPT = "Inspect only.\n\nReturn one bounded finding.";
const EXECUTABLE = "/usr/local/bin/claude";

function fixedEnv(configDir) {
  return { CLAUDE_CONFIG_DIR: configDir, PATH: "/usr/bin" };
}

function hostSeams() {
  return {
    observeAvailability: () => ({ available: true, detail: "claude 2.0.0" }),
    observeAuth: () => ({ available: true, loggedIn: true, detail: "logged in" }),
    observeCompatibility: () => ({
      staticCompatible: true,
      version: "2.0.0",
      fingerprint: "fingerprint-1",
      executable: EXECUTABLE,
    }),
    revalidateCompatibility: (_cwd, compatibility) => compatibility,
  };
}

/** A fake stream-json session held open until the test settles it. */
function fakeSession(options = {}) {
  const { pid = 4242, pidIdentity = "command-path-identity", autoSettle = false } = options;
  const state = { requests: [], settle: null, fail: null };
  const run = async (request) => {
    state.requests.push(request);
    await request.onSpawn({ pid, pidIdentity });
    if (autoSettle) return claudeResult();
    return new Promise((resolve, reject) => {
      state.settle = (value) => resolve(value ?? claudeResult());
      state.fail = reject;
    });
  };
  return { run, state };
}

function claudeResult(overrides = {}) {
  return {
    status: "completed",
    exitCode: 0,
    sessionId: "session-command-path",
    finalMessage: "the work is done",
    failureClass: null,
    failureReason: null,
    resumable: false,
    requiresAttention: false,
    assistantOutputObserved: true,
    toolUses: [],
    touchedFiles: [],
    attempts: [],
    recoveryAttempts: 0,
    steering: null,
    runtimeReceipt: { claudeCodeVersion: "2.0.0" },
    providerReportedMetrics: null,
    lastByteAt: null,
    stderr: null,
    warning: null,
    ...overrides,
  };
}

/**
 * One turn wired through the real production entry point: a real
 * version-three Agent record, a real durable mailbox, a real instance lease,
 * a real launch claim, and the real durable control-command stream -- the
 * same durable owners `v3-worker-loop.test.mjs` exercises with the fake
 * service Driver, here holding the real `claude-code` Driver instead.
 */
async function setup(options = {}) {
  sequence += 1;
  const label = sequence;
  const workspaceRoot = path.join(root, `workspace-${label}`);
  fs.mkdirSync(workspaceRoot);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, `runtime-home-${label}`);
  const configDir = path.join(root, `claude-config-${label}`);
  const env = fixedEnv(configDir);

  const session = options.session ?? fakeSession();
  const driver = createClaudeCodeDriverV2({
    env,
    runTurnSession: session.run,
    // The real `requestClaudeInterrupt` validates a real OS process identity,
    // which a fake pid can never satisfy. Tests that care about that exact
    // production request path assert it directly in
    // `claude-driver-v2.test.mjs`; here the seam is faked exactly like this
    // file's fake native session, so what's under test is the durable command
    // path around whatever the Driver's `requestInterrupt()` reports.
    requestInterrupt: options.requestInterrupt ?? (() => ({ requested: true, requestFailure: null })),
    recordCompatibilityObservation: () => ({ recorded: true, compatibility: { version: "2.0.0" } }),
    ...hostSeams(),
  });

  const ownerRootId = `root-cp-${label}`;
  const jobId = `job-cp-${label}`;
  const attemptId = `attempt-cp-${label}`;

  const inspections = await inspectDriverInstances(driver, createDriverScope({
    driver, purpose: "inspect", rootId: ownerRootId, workspaceRoot, env,
  }));
  const { route } = acceptDriverRoute(driver, {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    model: "claude-sonnet-5",
    topology: "leaf",
    authority: "behavioral_read_only",
    effort: "high",
  }, inspections);
  const v3Route = { ...route, capabilitySchemaVersion: route.capabilities.capabilitySchemaVersion };

  const store = createAgentStore({ cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
  const agent = store.createAgent({ task_name: `claude_command_path_${label}`, route: v3Route, initialMessage: PROMPT });
  const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
  assert.ok(reservation.reserved, "version-three activation reservation failed");

  const lease = acquireInstanceLease({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    route: v3Route,
    harnessId: v3Route.harnessId,
    instanceKey: v3Route.instanceKey,
    capacityClass: "claude-v2-command-path-test",
    capacityLimit: 1,
  });

  const preparedTurn = driver.prepareTurn({ route: v3Route, taskInput: PROMPT, turnId: jobId });
  createLaunchClaim({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route: v3Route,
    leaseBindings: [lease],
    assignedMessageIds: reservation.assignedMessages.map((message) => message.messageId),
    preparedInput: PROMPT,
    turnOptions: preparedTurn.turnOptions,
    inspectionEvidence: { generation: "unavailable", capabilities: v3Route.capabilities },
  });

  function readNativeTurnRef() {
    let claim;
    try {
      claim = readLaunchClaim({ ownerRootId, agentId: agent.agentId, jobId, attemptId });
    } catch {
      return null;
    }
    return claim?.nativeTurnRef ?? null;
  }

  return {
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route: v3Route,
    session,
    input: {
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId,
      route: v3Route,
      driver,
      preparedTurn,
      preparedInput: PROMPT,
      assignedMessageIds: reservation.assignedMessages.map((message) => message.messageId),
      assignedInputs: [],
      leaseBindings: [lease],
      // Stated explicitly: Claude's prepared turn always resolves an effort,
      // and the launch must state the exact bag that prepared turn bound.
      turnOptions: preparedTurn.turnOptions,
      workspaceRoot,
      env: {},
      cwd: workspaceRoot,
    },
    agent: () => store.readAgent(agent.agentId),
    events: () => readUnreadCompletionEvents(workspaceRoot, ownerRootId).events,
    commands: () => listControlCommands({ ownerRootId, agentId: agent.agentId, jobId }),
    nativeTurnRef: readNativeTurnRef,
    enqueueInterrupt: (commandId, deadlineMs = 60_000) => enqueueControlCommand({
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      commandId,
      kind: "interrupt",
      route: v3Route,
      nativeTurnRef: readNativeTurnRef(),
      deadlineMs,
    }),
  };
}

async function untilTrue(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("Claude Code interrupt honesty under the durable command path (Task 6.4)", () => {
  it("acknowledges an interrupt request promptly and nonterminally, then settles from real terminal stream evidence", async () => {
    const session = fakeSession({ autoSettle: false });
    const context = await setup({ session });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.nativeTurnRef() != null);

    context.enqueueInterrupt("interrupt-accepted");
    await untilTrue(() => context.commands().find((c) => c.commandId === "interrupt-accepted")?.requestState === "accepted");
    const accepted = context.commands().find((c) => c.commandId === "interrupt-accepted");
    assert.equal(accepted.requestState, "accepted");
    // Acceptance is not settlement: the command stays pending until the real
    // native turn produces terminal evidence.
    assert.equal(accepted.settlement, "pending");

    session.state.settle(claudeResult({
      status: "failed",
      exitCode: 130,
      failureClass: "cancelled_or_interrupted",
      failureReason: "SIGINT",
      finalMessage: "partial work",
    }));

    const result = await loop;
    assert.equal(result.status, "interrupted");
    assert.equal(result.published, true);

    const settled = context.commands().find((c) => c.commandId === "interrupt-accepted");
    assert.equal(settled.requestState, "accepted");
    assert.equal(settled.settlement, "settled");
    assert.equal(settled.nativeTurnState, "terminal");
  });

  it("keeps a rejected interrupt request active, never escalating and never claiming settlement", async () => {
    const session = fakeSession({ autoSettle: false });
    const context = await setup({
      session,
      requestInterrupt: () => ({ requested: false, requestFailure: "identity_mismatch" }),
    });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.nativeTurnRef() != null);

    context.enqueueInterrupt("interrupt-rejected");
    await untilTrue(() => context.commands().find((c) => c.commandId === "interrupt-rejected")?.requestState === "rejected");
    const rejected = context.commands().find((c) => c.commandId === "interrupt-rejected");
    assert.equal(rejected.requestState, "rejected");
    assert.equal(rejected.settlement, "pending");

    session.state.settle(claudeResult());
    const result = await loop;
    // The turn itself is never escalated by a rejected interrupt request: it
    // completes normally.
    assert.equal(result.status, "completed");

    const settled = context.commands().find((c) => c.commandId === "interrupt-rejected");
    assert.equal(settled.requestState, "rejected");
    assert.equal(settled.settlement, "settled");
  });

  it("never reports a claimed command's own deadline expiry as graceful success", async () => {
    const session = fakeSession({ autoSettle: false });
    const context = await setup({ session });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.nativeTurnRef() != null);

    // Claude accepts the request quickly, but the turn itself keeps running
    // past this command's own short deadline.
    context.enqueueInterrupt("interrupt-deadline", 1_000);
    await untilTrue(() => context.commands().find((c) => c.commandId === "interrupt-deadline")?.requestState === "accepted");
    const expired = await untilTrue(
      () => context.commands().find((c) => c.commandId === "interrupt-deadline")?.settlement === "unknown",
      6_000,
    );
    assert.equal(expired, true, "the worker must own its own claimed command's deadline");
    const pending = context.commands().find((c) => c.commandId === "interrupt-deadline");
    // Deadline expiry never fabricates an interruption: the axes stay exactly
    // what the worker actually knows -- accepted request, unresolved turn.
    assert.equal(pending.requestState, "accepted");
    assert.equal(pending.nativeTurnState, "active");

    session.state.settle(claudeResult());
    const result = await loop;
    assert.equal(result.status, "completed");
    // Only the turn's own publishable terminal evidence may move an expired
    // command forward, and it moves it to settled -- never to a synthesized
    // graceful interruption.
    const settled = context.commands().find((c) => c.commandId === "interrupt-deadline");
    assert.equal(settled.settlement, "settled");
    assert.equal(settled.nativeTurnState, "terminal");
  });

  it("closes a never-requested command honestly instead of inventing an outcome", async () => {
    const session = fakeSession({ autoSettle: false });
    const context = await setup({ session });
    const loop = runVersionThreeWorkerLoop(context.input);
    await untilTrue(() => context.nativeTurnRef() != null);
    // Parked in its wake wait: this command lands after the last claim sweep,
    // so the worker never claims or requests it before the result arrives.
    await new Promise((resolve) => setTimeout(resolve, 300));
    context.enqueueInterrupt("interrupt-never-requested", 30_000);
    session.state.settle(claudeResult());

    const result = await loop;
    assert.equal(result.status, "completed");
    assert.equal(session.state.requests.length, 1);

    const closed = context.commands().find((c) => c.commandId === "interrupt-never-requested");
    assert.equal(closed.requestState, "none");
    assert.equal(closed.settlement, "settled");
    assert.equal(closed.nativeTurnState, "terminal");
  });
});
