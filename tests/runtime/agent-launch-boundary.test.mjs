import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { readUnreadCompletionEvents } from "../../runtime/completion-inbox.mjs";
import {
  listStoredJobs,
  readJobFile,
  resolveJobFile,
  writeJobFile,
} from "../../runtime/job-store.mjs";

/**
 * Seam the route-time readiness observation, exactly as these suites already
 * seam `assertReady`, so no test performs a real host probe.
 */
function seamRouteInspection(runtime) {
  runtime.jobs.inspectRouteInstance = async (harnessId) => ({
    driver: resolveDriverV2(harnessId, { env: runtime.jobs.env }),
    inspections: [{
      harnessId,
      instanceKey: claudeCodeInstanceKey(runtime.jobs.env.CLAUDE_CONFIG_DIR),
      readiness: "ready",
      liveValidated: true,
      maturity: "experimental",
      detailCode: "ready",
      routes: {
        models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"],
        effortsByModel: Object.fromEntries(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"].map((model) => [model, ["high"]])),
        topologies: ["leaf", "native_orchestrator"],
        interaction: "noninteractive_fixed_policy",
      },
      capabilityProvenance: Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((name) => [name, "checkout_declared"])),
      inspectionGeneration: "unavailable",
    }],
  });
  return runtime;
}

const roots = /** @type {string[]} */ ([]);
const sharedRuntimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-launch-runtime-home-"));

after(() => fs.rmSync(sharedRuntimeHome, { recursive: true, force: true }));
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-agent-launch-boundary-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  roots.push(root);
  const runtime = seamRouteInspection(createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_THREAD_ID: "root-agent-launch-boundary",
      CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  }));
  return { runtime, workspace };
}

function readiness(runtime) {
  return {
    ready: true,
    availability: { available: true },
    compatibility: {
      staticCompatible: true,
      fingerprint: "test-compatible-claude",
      executable: process.execPath,
      version: "test",
    },
    auth: { loggedIn: true },
    cwd: runtime.jobs.cwd,
    claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR ?? null,
    sourceRoot: runtime.jobs.sourceRoot,
  };
}

function waitMs(milliseconds) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

describe("Agent durable launch boundary", () => {
  it("reserves an exact inspected tuple and rejects stale tuples before durable or transport work", async () => {
    const { runtime, workspace } = setup();
    const inspected = runtime.jobs.inspectRouteInstance;
    runtime.jobs.inspectRouteInstance = async (harnessId) => {
      const observed = await inspected(harnessId);
      return {
        ...observed,
        inspections: observed.inspections.map((inspection) => ({
          ...inspection,
          routes: { ...inspection.routes, models: ["claude-sonnet-5"], effortsByModel: { "claude-sonnet-5": ["high"] } },
        })),
      };
    };
    runtime.jobs.assertReady = () => readiness(runtime);
    let transports = 0;
    runtime.jobs.launchPreparedStart = async (prepared) => {
      transports += 1;
      return { jobId: prepared.jobId, agentId: prepared.agentId, status: "queued" };
    };
    const exact = {
      topology: "leaf", harness: "claude-code", message: "bounded task", model: "claude-sonnet-5",
      reasoning_effort: "high", write: false,
    };
    await runtime.spawnAgent({ ...exact, task_name: "exact_tuple" });
    const agents = runtime.store.listAgents().length;
    const jobs = listStoredJobs(workspace).length;
    for (const stale of [
      { task_name: "stale_model", model: "claude-opus-5", reasoning_effort: "high" },
      { task_name: "stale_effort", model: "claude-sonnet-5", reasoning_effort: "low" },
      { task_name: "model_alias", model: "claude-sonnet", reasoning_effort: "high" },
      { task_name: "null_effort", model: "claude-sonnet-5", reasoning_effort: null },
    ]) {
      await assert.rejects(() => runtime.spawnAgent({ ...exact, ...stale }));
      assert.equal(runtime.store.listAgents().length, agents);
      assert.equal(listStoredJobs(workspace).length, jobs);
      assert.equal(transports, 1);
    }
  });

  it("rejects a missing model before readiness or Agent reservation", async () => {
    const { runtime } = setup();
    let readinessCalled = false;
    runtime.jobs.assertReady = () => {
      readinessCalled = true;
      return readiness(runtime);
    };
    await assert.rejects(
      runtime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "missing_model",
        message: "must not launch",
        reasoning_effort: "high",
        write: false,
      }),
      /spawn_agent model must be non-empty text/
    );
    assert.equal(readinessCalled, false);
    assert.equal(runtime.store.listAgents().length, 0);
  });

  it("rejects invalid complete spawn delegation options before readiness or durable state", async () => {
    const cases = [
      {
        name: "effort",
        input: { reasoning_effort: "not-an-effort" },
        error: /exact discovered effort/,
      },
      {
        name: "removed profile",
        input: { execution_profile: "unknown-profile" },
        error: /does not support execution_profile/,
      },
      {
        name: "sonnet orchestrator",
        input: { topology: "native_orchestrator" },
        error: /claude-opus-5 or claude-fable-5/,
      },
      {
        name: "haiku write",
        input: { model: "claude-haiku-4-5", write: true },
        error: /Haiku is valid only as a write:false leaf scout/,
      },
      {
        name: "haiku orchestrator",
        input: { model: "claude-haiku-4-5", topology: "native_orchestrator" },
        error: /claude-opus-5 or claude-fable-5/,
      },
      {
        // A model is stated in full now: an alias is a different identifier, not
        // a shorthand the route resolves.
        name: "alias model",
        input: { model: "fable" },
        error: /exact discovered full model/,
      },
      {
        name: "retired tool allowlist",
        input: { allowed_tools: ["Agent(explore)"] },
        error: /does not support allowed_tools/,
      },
    ];

    for (const testCase of cases) {
      const { runtime, workspace } = setup();
      let readinessCalled = false;
      runtime.jobs.assertReady = () => {
        readinessCalled = true;
        return readiness(runtime);
      };

      await assert.rejects(
        runtime.spawnAgent({
          topology: "leaf",
          harness: "claude-code",
          task_name: `invalid_${testCase.name.replace(/[^a-z]+/g, "_")}`,
          message: "must not persist",
          model: "claude-sonnet-5",
          reasoning_effort: "high",
          write: false,
          ...testCase.input,
        }),
        testCase.error,
        testCase.name,
      );

      assert.equal(readinessCalled, false, `${testCase.name}: readiness`);
      assert.equal(runtime.store.listAgents().length, 0, `${testCase.name}: Agent registry`);
      assert.deepEqual(listStoredJobs(workspace), [], `${testCase.name}: job store`);
    }
  });

  it("rejects invalid activating follow-up options before mailbox or job mutation", async () => {
    const cases = [
      { input: { reasoning_effort: "not-an-effort" }, error: /Unsupported effort/ },
      { input: { execution_profile: "unknown-profile" }, error: /does not support execution_profile/ },
      {
        input: { delegation_mode: "claude_orchestrator" },
        error: /does not support delegation_mode/,
      },
      { input: { allowed_tools: ["Agent"] }, error: /does not support allowed_tools/ },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { runtime, workspace } = setup();
      const agent = runtime.store.createAgent({
        task_name: `terminal_invalid_${index}`,
        selectedModel: "claude-sonnet-5",
      });
      runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
      let readinessCalled = false;
      runtime.jobs.assertReady = () => {
        readinessCalled = true;
        return readiness(runtime);
      };

      await assert.rejects(
        runtime.followupTask({
          target: agent.agentId,
          message: "must not append",
          ...testCase.input,
        }),
        testCase.error,
      );

      assert.equal(readinessCalled, false, `case ${index}: readiness`);
      assert.deepEqual(runtime.store.listMessages(agent.agentId), [], `case ${index}: mailbox`);
      assert.deepEqual(listStoredJobs(workspace), [], `case ${index}: job store`);
    }
  });

  it("projects idle interruption as one compact operation outcome", async () => {
    const { runtime } = setup();
    const agent = runtime.store.createAgent({
      task_name: "idle_interrupt_projection",
      selectedModel: "claude-sonnet-5",
    });

    const pending = await runtime.interruptAgent({ target: agent.agentId });
    assert.deepEqual(pending, {
      agent_name: agent.path,
      status: "no_active_turn",
    });

    runtime.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "errored",
    }));
    const failed = await runtime.interruptAgent({ target: agent.agentId });
    assert.deepEqual(failed, {
      agent_name: agent.path,
      status: "no_active_turn",
    });
  });

  it("fails compatibility before spawn or idle follow-up durable mutation", async () => {
    const spawnSetup = setup();
    spawnSetup.runtime.jobs.assertReady = () => {
      throw new Error("Claude Code 2.1.221 is incompatible with HarnessDock runtime surface hd-agent-v2.");
    };
    await assert.rejects(
      spawnSetup.runtime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "incompatible_spawn",
        message: "must not persist",
        model: "claude-sonnet-5",
        reasoning_effort: "high",
        write: false,
      }),
      /incompatible with HarnessDock runtime surface/,
    );
    assert.deepEqual(spawnSetup.runtime.store.listAgents(), []);
    assert.deepEqual(listStoredJobs(spawnSetup.workspace), []);

    const followupSetup = setup();
    const agent = followupSetup.runtime.store.createAgent({
      task_name: "incompatible_followup",
      selectedModel: "claude-sonnet-5",
    });
    followupSetup.runtime.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "completed",
    }));
    followupSetup.runtime.jobs.assertReady = () => {
      throw new Error("Claude Code 2.1.221 is incompatible with HarnessDock runtime surface hd-agent-v2.");
    };
    await assert.rejects(
      followupSetup.runtime.followupTask({
        target: agent.agentId,
        message: "must remain outside the mailbox",
        reasoning_effort: "high",
      }),
      /incompatible with HarnessDock runtime surface/,
    );
    assert.deepEqual(followupSetup.runtime.store.listMessages(agent.agentId), []);
    assert.deepEqual(listStoredJobs(followupSetup.workspace), []);
  });

  it("delivers to an admitted active process without checking a replacement CLI", async () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({
      task_name: "active_version_steering",
      selectedModel: "claude-sonnet-5",
    });
    const jobId = "active-version-steering-job";
    runtime.store.reserveActivation(agent.agentId, jobId, { initial: true });
    const timestamp = new Date().toISOString();
    writeJobFile(workspace, jobId, {
      id: jobId,
      workspaceRoot: workspace,
      ownerRootId: agent.rootThreadId,
      agentId: agent.agentId,
      status: "running",
      phase: "running_attempt",
      preClaudeLaunch: false,
      acceptingSteering: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      request: { model: "claude-sonnet-5", profile: "terminal-parity" },
    });
    let readinessCalled = false;
    runtime.jobs.assertReady = () => {
      readinessCalled = true;
      throw new Error("replacement CLI must not gate active steering");
    };

    const result = await runtime.followupTask({
      target: agent.agentId,
      message: "continue in the already-running process",
      reasoning_effort: "high",
    });
    assert.equal(result.delivery, "dispatched_active");
    assert.equal(readinessCalled, false);
    assert.equal(runtime.store.listMessages(agent.agentId)[0].state, "dispatched");
  });

  it("rejects an invalid active-turn follow-up before mailbox or steering mutation", async () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({
      task_name: "active_invalid_followup",
      selectedModel: "claude-sonnet-5",
    });
    const jobId = "active-invalid-followup-job";
    runtime.store.reserveActivation(agent.agentId, jobId, { initial: true });
    const timestamp = new Date().toISOString();
    writeJobFile(workspace, jobId, {
      id: jobId,
      workspaceRoot: workspace,
      ownerRootId: agent.rootThreadId,
      agentId: agent.agentId,
      status: "running",
      phase: "running_attempt",
      preClaudeLaunch: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      request: { model: "claude-sonnet-5", profile: "terminal-parity" },
    });
    const jobBefore = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");

    await assert.rejects(
      runtime.followupTask({
        target: agent.agentId,
        message: "must not become steering",
        reasoning_effort: "not-an-effort",
      }),
      /Unsupported effort/
    );

    assert.deepEqual(runtime.store.listMessages(agent.agentId), []);
    const stored = readJobFile(workspace, jobId);
    assert.equal(stored.steering, undefined);
    const jobAfter = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");
    assert.equal(jobAfter, jobBefore);
  });

  it("rejects invalid follow-up options before reconciling an unprojected terminal receipt", async () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({
      task_name: "invalid_before_reconcile",
      selectedModel: "claude-sonnet-5",
    });
    const jobId = "invalid-before-reconcile-job";


    runtime.store.reserveActivation(agent.agentId, jobId, { initial: true });
    const timestamp = new Date().toISOString();
    writeJobFile(workspace, jobId, {
      id: jobId,
      workspaceRoot: workspace,
      ownerRootId: agent.rootThreadId,
      agentId: agent.agentId,
      status: "completed",
      phase: "done",
      preClaudeLaunch: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      request: { model: "claude-sonnet-5", profile: "terminal-parity" },
      recoverability: {
        resumable: false,
        mode: "blocked",
        exactSessionId: null,
        reason: "fixture terminal",
      },
    });
    const agentBefore = runtime.store.resolveTarget(agent.agentId);
    const jobBefore = fs.readFileSync(resolveJobFile(workspace, jobId), "utf8");
    const inboxBefore = readUnreadCompletionEvents(workspace, agent.rootThreadId);

    await assert.rejects(
      runtime.followupTask({
        target: agent.agentId,
        message: "must not trigger reconciliation",
        reasoning_effort: "not-an-effort",
      }),
      /Unsupported effort/
    );

    assert.deepEqual(runtime.store.resolveTarget(agent.agentId), agentBefore);
    assert.deepEqual(runtime.store.listMessages(agent.agentId), []);
    assert.equal(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"), jobBefore);
    assert.deepEqual(readUnreadCompletionEvents(workspace, agent.rootThreadId), inboxBefore);
  });

  it("defensively validates complete profiles before preparing a job receipt", () => {
    const { runtime, workspace } = setup();
    assert.throws(
      () => runtime.jobs.prepareStart("must not prepare", {
        harnessId: runtime.jobs.driver.harnessId,
        model: "sonnet",
        effort: "not-an-effort",
        readinessReceipt: readiness(runtime),
      }),
      /Unsupported effort/,
    );
    assert.deepEqual(listStoredJobs(workspace), []);
  });

  it("keeps slow readiness outside activation, then attaches a prepared fact before worker launch", async () => {
    const { runtime, workspace } = setup();
    const events = /** @type {string[]} */ ([]);
    // The public generation writes version-three Agents, so the launch path's
    // durable owner is the version-three store; seam that one.
    const baseStore = runtime.versionThreeStore();
    const jobs = /** @type {any} */ (runtime.jobs);
    const baseAttach = jobs.attachPreparedStart.bind(jobs);
    let observedJobId = null;
    let observedPrepared = null;

    jobs.assertReady = () => {
      events.push("ready:start");
      assert.equal(baseStore.listAgents().some((agent) => agent.activeJobId), false);
      waitMs(2_100);
      assert.equal(baseStore.listAgents().some((agent) => agent.activeJobId), false);
      events.push("ready:end");
      return readiness(runtime);
    };
    const seamedStore = {
      ...baseStore,
      reserveActivation(target, jobId, options) {
        const prepared = readJobFile(workspace, jobId);
        assert.equal(prepared.agentId, undefined);
        assert.equal(prepared.phase, "activation_prepared");
        assert.equal(prepared.workerPid, process.pid);
        baseStore.enqueueMessage(target, "message racing initial reservation", {
          kind: "send_message",
        });
        events.push("reserve");
        return baseStore.reserveActivation(target, jobId, options);
      },
    };
    runtime.versionThreeStore = () => seamedStore;
    jobs.attachPreparedStart = (prepared, agentId) => {
      events.push("attach");
      return baseAttach(prepared, agentId);
    };
    jobs.launchPreparedStart = async (prepared, task) => {
      const attached = readJobFile(workspace, prepared.jobId);
      assert.equal(attached.agentId, prepared.agentId);
      assert.equal(attached.phase, "activation_prepared");
      assert.equal(task, "launch after readiness\n\nmessage racing initial reservation");
      events.push("launch");
      observedJobId = prepared.jobId;
      observedPrepared = prepared;
      return { jobId: prepared.jobId, agentId: prepared.agentId, status: "queued" };
    };

    const result = await runtime.spawnAgent({
      topology: "leaf",
      harness: "claude-code",
      task_name: "boundary",
      message: "launch after readiness",
      model: "claude-sonnet-5",
      reasoning_effort: "high",
      write: false,
    });

    assert.deepEqual(result, {
      agent_name: "/root/boundary",
      harness: "claude-code",
      route_maturity: "experimental",
      model: "claude-sonnet-5",
      reasoning_effort: "high",
      delegation_mode: "leaf",
      authority: "behavioral_read_only",
      phase: null,
      started_at: null,
      last_activity_at: null,
      elapsed_seconds: null,
      status: "working",
    });
    assert.deepEqual(events, ["ready:start", "ready:end", "reserve", "attach", "launch"]);
    const storedAgent = runtime.store.resolveTarget(result.agent_name);
    assert.equal(readJobFile(workspace, observedJobId).agentId, storedAgent.agentId);
    assert.equal(readJobFile(workspace, observedJobId).request.delegationMode, "leaf");
    const messages = runtime.store.listMessages(storedAgent.agentId);
    assert.deepEqual(messages.map((message) => message.sequence), [1, 2]);
    assert.deepEqual(messages.map((message) => message.text), [
      "launch after readiness",
      "message racing initial reservation",
    ]);
    assert.ok(messages.every((message) =>
      message.state === "dispatched" &&
      message.assignedJobId === observedJobId &&
      message.receipt?.delivery === "initial_prompt"
    ));
    assert.equal(runtime.jobs.abortPreparedStart(observedPrepared), true);
  });

  it("keeps a racing mailbox message when initial job preparation fails", async () => {
    const { runtime } = setup();
    const jobs = /** @type {any} */ (runtime.jobs);
    jobs.assertReady = () => readiness(runtime);
    jobs.prepareStart = () => {
      const agent = runtime.store.resolveTarget("prepare_race");
      const sent = runtime.sendMessage({ target: agent.agentId, message: "message during prepare" });
      assert.equal(sent.delivery, "queued_no_turn");
      throw new Error("injected prepare failure");
    };

    await assert.rejects(
      runtime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "prepare_race",
        message: "initial prompt",
        model: "claude-opus-5",
        reasoning_effort: "high",
        write: false,
      }),
      /injected prepare failure/
    );

    const agent = runtime.store.resolveTarget("prepare_race");
    assert.equal(agent.status, "pending_init");
    assert.equal(agent.activeJobId, null);
    const messages = runtime.store.listMessages(agent.agentId);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((message) => message.text), [
      "initial prompt",
      "message during prepare",
    ]);
    assert.ok(messages.every((message) => message.state === "queued"));
  });

  it("keeps a losing prepared record unbound and prevents it from projecting onto the Agent", () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({ task_name: "loser" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    const prepared = runtime.jobs.prepareStart("losing concurrent follow-up", {
      harnessId: runtime.jobs.driver.harnessId,
      readinessReceipt: readiness(runtime),
      jobId: "prepared-loser",
      agentId: agent.agentId,
      model: "sonnet",
      effort: "high",
    });
    const stored = readJobFile(workspace, prepared.jobId);
    assert.ok(stored);
    assert.equal(stored.agentId, undefined);
    assert.equal(stored.phase, "activation_prepared");

    writeJobFile(workspace, prepared.jobId, {
      ...stored,
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
    });
    runtime.reconcile();
    const afterReconcile = runtime.store.readAgent(agent.agentId);
    assert.ok(afterReconcile);
    assert.equal(afterReconcile.status, "completed");
  });

  it("uses a live unbound prepared fact as a barrier, then rolls back a reaped pre-attach reservation", () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({ task_name: "crash_window" });
    runtime.store.updateAgent(agent.agentId, (current) => ({ ...current, status: "completed" }));
    const prepared = runtime.jobs.prepareStart("crash between reserve and attach", {
      harnessId: runtime.jobs.driver.harnessId,
      readinessReceipt: readiness(runtime),
      jobId: "prepared-crash-window",
      agentId: agent.agentId,
      model: "sonnet",
      effort: "high",
    });
    const reservation = runtime.store.reserveActivation(agent.agentId, prepared.jobId);
    assert.equal(reservation.reserved, true);

    // Age past the reaper grace window. The launcher identity is this live
    // process, so the unbound durable fact must still prevent a rollback.
    const staleAt = new Date(Date.now() - 5_000).toISOString();
    const stored = readJobFile(workspace, prepared.jobId);
    writeJobFile(workspace, prepared.jobId, {
      ...stored,
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    assert.deepEqual(runtime.reconcile(), []);
    const whileLauncherLives = runtime.store.readAgent(agent.agentId);
    assert.ok(whileLauncherLives);
    assert.equal(whileLauncherLives.status, "running");
    assert.equal(whileLauncherLives.activeJobId, prepared.jobId);

    // This models the reaper's terminal fact after that launcher hard-crashes
    // before attach. It remains unbound and must not finalize the Agent.
    writeJobFile(workspace, prepared.jobId, {
      ...readJobFile(workspace, prepared.jobId),
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      workerPid: null,
      workerPidIdentity: null,
    });
    const recovery = runtime.reconcile();
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].jobId, prepared.jobId);
    assert.equal(recovery[0].reason, "pre_claude_activation_recovered");
    const recovered = runtime.store.readAgent(agent.agentId);
    assert.ok(recovered);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.activeJobId, null);
    assert.equal(recovered.lastTerminalJobId, undefined);
  });

  it("preserves pending initial messages after a pre-attach crash and reactivates them as an initial turn", async () => {
    const { runtime, workspace } = setup();
    const agent = runtime.store.createAgent({
      task_name: "initial_crash",
      selectedModel: "claude-sonnet-5",
    });
    const prepared = runtime.jobs.prepareStart("initial prompt", {
      harnessId: runtime.jobs.driver.harnessId,
      readinessReceipt: readiness(runtime),
      jobId: "prepared-initial-crash",
      agentId: agent.agentId,
      model: "sonnet",
      effort: "high",
    });
    const activation = runtime.store.reserveActivation(agent.agentId, prepared.jobId, { initial: true });
    assert.equal(activation.reserved, true);

    const sent = runtime.sendMessage({ target: agent.agentId, message: "keep this pending input" });
    assert.equal(sent.delivery, "activation_pending");
    const storedMessage = runtime.store.listMessages(agent.agentId)
      .find((message) => message.text === "keep this pending input");
    assert.ok(storedMessage);
    runtime.store.markMessageDispatched(agent.agentId, storedMessage.messageId, {
      jobId: prepared.jobId,
      receipt: { delivery: "stale_prelaunch_receipt", steeringSequence: 1 },
    });

    writeJobFile(workspace, prepared.jobId, {
      ...readJobFile(workspace, prepared.jobId),
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      workerPid: null,
      workerPidIdentity: null,
    });
    const recovery = runtime.reconcile();
    assert.equal(recovery.length, 1);
    assert.equal(recovery[0].jobId, prepared.jobId);
    assert.equal(recovery[0].reason, "pre_claude_activation_recovered");

    const recovered = runtime.store.readAgent(agent.agentId);
    assert.ok(recovered);
    assert.equal(recovered.status, "pending_init");
    assert.equal(recovered.activeJobId, null);
    const recoveredMessages = runtime.store.listMessages(agent.agentId);
    assert.equal(recoveredMessages.length, 1);
    assert.equal(recoveredMessages[0].state, "queued");
    assert.equal(recoveredMessages[0].assignedJobId, null);
    assert.equal(recoveredMessages[0].receipt, undefined);

    const baseStore = runtime.store;
    const jobs = /** @type {any} */ (runtime.jobs);
    const baseReserve = baseStore.reserveActivation.bind(baseStore);
    let reserveOptions = null;
    let launchedPrompt = null;
    runtime.store = {
      ...baseStore,
      reserveActivation(target, jobId, options) {
        reserveOptions = options;
        return baseReserve(target, jobId, options);
      },
    };
    jobs.assertReady = () => readiness(runtime);
    jobs.launchPreparedStart = async (nextPrepared, prompt) => {
      launchedPrompt = prompt;
      return { jobId: nextPrepared.jobId, agentId: nextPrepared.agentId, status: "queued" };
    };

    const followup = await runtime.followupTask({
      target: agent.agentId,
      message: "follow-up after recovery",
      reasoning_effort: "high",
    });
    assert.equal(reserveOptions?.initial, true);
    assert.deepEqual(followup, {
      agent_name: agent.path,
      delivery: "new_turn",
    });
    assert.equal(launchedPrompt, "keep this pending input\n\nfollow-up after recovery");
    const activeJobId = runtime.store.resolveTarget(agent.agentId).activeJobId;
    assert.equal(readJobFile(runtime.jobs.cwd, activeJobId).request.delegationMode, "leaf");
  });
});
