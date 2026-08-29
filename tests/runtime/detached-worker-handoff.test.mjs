import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import {
  createInternalAgentRuntime,
  preparedStartDisposition,
} from "../../runtime/internal-runtime.mjs";
import {
  HARNESS_QUEUED_JOB_STATUS,
  patchJob,
  readJobFile,
  reserveSessionLease,
  transitionJob,
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
        topologies: ["leaf", "native_orchestrator"],
        interaction: "noninteractive_fixed_policy",
      },
      capabilityProvenance: Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((name) => [name, "checkout_declared"])),
      inspectionGeneration: "unavailable",
    }],
  });
  return runtime;
}

const roots = [];
const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-detached-worker-handoff-shared-"));
const sharedRuntimeHome = path.join(sharedRoot, "runtime-home");

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

after(() => fs.rmSync(sharedRoot, { recursive: true, force: true }));

function fakeChild({
  pid = 47_001,
  emitSpawn = true,
  spawnError = null,
  spawnDelayMs = 0,
  postSpawnError = null,
  postSpawnErrorDelayMs = 0,
  killResult = true,
  emitExitOnKill = true,
  unrefError = null,
  onKill = null,
} = {}) {
  const listeners = new Map();
  // Events this fake already emitted, so a listener attached afterwards still
  // observes them. The production launcher attaches its observer before a real
  // child can finish spawning, so replaying to a late listener models the real
  // ordering; without it, this fixture's outcome depends on how many awaits the
  // caller happens to perform before the observer exists.
  const fired = new Map();
  const child = {
    pid,
    exitCode: null,
    unrefCount: 0,
    killCount: 0,
    once(event, callback) {
      if (fired.has(event)) {
        const args = fired.get(event);
        queueMicrotask(() => callback(...args));
        return child;
      }
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(callback);
      listeners.set(event, callbacks);
      return child;
    },
    emit(event, ...args) {
      const callbacks = listeners.get(event) ?? [];
      listeners.delete(event);
      fired.set(event, args);
      for (const callback of callbacks) callback(...args);
    },
    unref() {
      child.unrefCount += 1;
      if (unrefError) throw unrefError;
    },
    kill() {
      child.killCount += 1;
      if (!killResult) return false;
      onKill?.(child);
      if (emitExitOnKill) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, "SIGTERM");
        });
      }
      return true;
    },
  };
  const emitSpawnOutcome = () => {
    if (spawnError) {
      child.emit("error", spawnError);
      child.exitCode = 1;
      child.emit("exit", 1, null);
    } else if (emitSpawn) {
      child.emit("spawn");
      if (postSpawnError) {
        const emitPostSpawnError = () => child.emit("error", postSpawnError);
        if (postSpawnErrorDelayMs > 0) setTimeout(emitPostSpawnError, postSpawnErrorDelayMs);
        else queueMicrotask(emitPostSpawnError);
      }
    }
  };
  if (spawnDelayMs > 0) setTimeout(emitSpawnOutcome, spawnDelayMs);
  else queueMicrotask(emitSpawnOutcome);
  return child;
}

function setup(launchDependencies = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-detached-worker-handoff-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, ".claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  roots.push(root);
  const env = {
    CODEX_THREAD_ID: "root-detached-worker-handoff",
    CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
  const runtime = createInternalAgentRuntime({
    cwd: workspace,
    env,
    envFile,
    launchDependencies,
  });
  return { runtime, workspace, claudeConfigDir, env, envFile };
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
    cwd: runtime.cwd,
    claudeConfigDir: runtime.env.CLAUDE_CONFIG_DIR ?? null,
    sourceRoot: runtime.sourceRoot,
  };
}

function preparedResume(runtime, jobId, sessionId = `resume-${jobId}`) {
  return runtime.prepareStart("resume task", {
    harnessId: runtime.driver.harnessId,
    readinessReceipt: readiness(runtime),
    jobId,
    model: "haiku",
    effort: "low",
    resumeSessionId: sessionId,
  });
}

function agentRuntimeWithInjectedJobs(seed, launchDependencies) {
  const agentRuntime = createAgentRuntime({
    cwd: seed.workspace,
    env: seed.env,
    envFile: seed.envFile,
  });
  const injectedJobs = createInternalAgentRuntime({
    cwd: seed.workspace,
    env: seed.env,
    envFile: seed.envFile,
    launchDependencies,
  });
  injectedJobs.assertReady = () => readiness(injectedJobs);
  agentRuntime.jobs = injectedJobs;
  // Seam after the injected internal runtime is installed, so the route-time
  // readiness observation belongs to the same object the suite drives.
  return seamRouteInspection(agentRuntime);
}

describe("detached worker handoff", () => {
  it("accepts a same-worker claim race and retains the exact-session lease", async () => {
    const child = fakeChild({ pid: 47_101 });
    let workspace = null;
    let jobId = null;
    const { runtime, claudeConfigDir } = setup({
      spawn() {
        transitionJob(workspace, jobId, [HARNESS_QUEUED_JOB_STATUS], "running", {
          workerPid: child.pid,
          workerPidIdentity: "worker-47101",
          phase: "starting",
        });
        return child;
      },
      getProcessIdentity() {
        return "worker-47101";
      },
    });
    workspace = runtime.cwd;
    jobId = "worker-claim-race";
    const prepared = preparedResume(runtime, jobId);

    const receipt = await runtime.launchPreparedStart(prepared, "resume task");

    assert.equal(receipt.status, "queued");
    assert.equal(readJobFile(workspace, jobId).status, "running");
    assert.equal(child.unrefCount, 1);
    assert.throws(
      () => reserveSessionLease(workspace, claudeConfigDir, `resume-${jobId}`, "second-job"),
      /already owned by active job worker-claim-race/
    );
  });

  it("reports rollback_safe for a synchronous spawn throw and releases its parent-held lease", async () => {
    const { runtime, workspace, claudeConfigDir } = setup({
      spawn() {
        throw new Error("injected synchronous spawn throw");
      },
    });
    const prepared = preparedResume(runtime, "sync-spawn-throw");
    let failure = null;

    await assert.rejects(runtime.launchPreparedStart(prepared, "resume task"), (error) => {
      failure = error;
      return /synchronous spawn throw/.test(error.message);
    });

    assert.equal(preparedStartDisposition(failure), "rollback_safe");
    assert.equal(runtime.abortPreparedStart(prepared, { handoffDisposition: "rollback_safe" }), true);
    assert.equal(readJobFile(workspace, prepared.jobId), null);
    assert.doesNotThrow(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-sync-spawn-throw", "second-job")
    );
  });

  it("rolls back Agent spawn and activating follow-up only after an async pre-spawn error", async () => {
    const spawnError = () => fakeChild({ spawnError: new Error("injected async pre-spawn error") });
    const firstSeed = setup();
    const firstRuntime = agentRuntimeWithInjectedJobs(firstSeed, { spawn: spawnError });

    await assert.rejects(
      firstRuntime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "safe_spawn",
        message: "safe before spawn",
        model: "claude-haiku-4-5",
        reasoning_effort: "low",
        write: false,
      }),
      /async pre-spawn error/
    );
    assert.deepEqual(firstRuntime.store.listAgents(), []);

    const followSeed = setup();
    const followRuntime = agentRuntimeWithInjectedJobs(followSeed, { spawn: spawnError });
    const agent = followRuntime.store.createAgent({
      task_name: "safe_followup",
      selectedModel: "claude-haiku-4-5",
    });
    await assert.rejects(
      followRuntime.followupTask({ target: agent.path, message: "safe follow-up" }),
      /async pre-spawn error/
    );
    const restored = followRuntime.store.resolveTarget(agent.agentId);
    assert.equal(restored.status, "pending_init");
    assert.equal(restored.activeJobId, null);
    assert.equal(followRuntime.store.listMessages(agent.agentId)[0].state, "queued");
  });

  it("fences an unproven startup before a late worker can claim the queued job", async () => {
    const child = fakeChild({ pid: 47_110, emitSpawn: false });
    const seed = setup();
    const agentRuntime = agentRuntimeWithInjectedJobs(seed, {
      spawn() {
        return child;
      },
      getProcessIdentity() {
        return "worker-47110";
      },
    });
    const agent = agentRuntime.store.createAgent({
      task_name: "late_spawn",
      selectedModel: "claude-haiku-4-5",
    });
    agentRuntime.store.updateAgent(agent.agentId, (current) => ({
      ...current,
      status: "completed",
      nativeSessionRef: {
        harnessId: "claude-code",
        instanceKey: seed.claudeConfigDir,
        nativeSessionId: "late-spawn-session",
      },
      continuation: { mode: "exact_session", evidence: { reason: "fixture" } },
    }));

    await assert.rejects(
      agentRuntime.followupTask({ target: agent.path, message: "wait for late worker" }),
      /ended before Claude launch/
    );

    const attached = agentRuntime.store.resolveTarget(agent.agentId);
    const terminal = readJobFile(seed.workspace, attached.activeJobId);
    assert.equal(attached.status, "running");
    assert.equal(terminal.status, "failed");
    assert.ok(terminal.workerHandoffFenceAt);
    assert.equal(child.killCount, 1);
    assert.equal(child.unrefCount, 1);
    assert.equal(
      transitionJob(seed.workspace, terminal.id, ["queued"], "running", {
        workerPid: child.pid,
        workerPidIdentity: "worker-47110",
      }).transitioned,
      false
    );
  });

  it("explicitly rolls back ordinary attach failures before any launch attempt", async () => {
    const spawnSeed = setup();
    const spawnRuntime = agentRuntimeWithInjectedJobs(spawnSeed, {});
    spawnRuntime.jobs.attachPreparedStart = () => {
      throw new Error("injected pre-launch attach failure");
    };
    await assert.rejects(
      spawnRuntime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "attach_spawn",
        message: "do not leave active",
        model: "claude-haiku-4-5",
        reasoning_effort: "low",
        write: false,
      }),
      /attach failure/
    );
    assert.deepEqual(spawnRuntime.store.listAgents(), []);

    const followSeed = setup();
    const followRuntime = agentRuntimeWithInjectedJobs(followSeed, {});
    const agent = followRuntime.store.createAgent({
      task_name: "attach_followup",
      selectedModel: "claude-haiku-4-5",
    });
    followRuntime.jobs.attachPreparedStart = () => {
      throw new Error("injected pre-launch attach failure");
    };
    await assert.rejects(
      followRuntime.followupTask({ target: agent.path, message: "restore idle Agent" }),
      /attach failure/
    );
    const restored = followRuntime.store.resolveTarget(agent.agentId);
    assert.equal(restored.status, "pending_init");
    assert.equal(restored.activeJobId, null);
    assert.equal(followRuntime.store.listMessages(agent.agentId)[0].state, "queued");
  });

  it("terminates an unclaimed identity-less child and lets terminal lifecycle release its lease", async () => {
    const child = fakeChild({ pid: 47_102 });
    const { runtime, workspace, claudeConfigDir } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        throw new Error("injected identity failure");
      },
    });
    const prepared = preparedResume(runtime, "identity-failure");

    await assert.rejects(
      runtime.launchPreparedStart(prepared, "resume task"),
      /worker handoff/i
    );

    const terminal = readJobFile(workspace, prepared.jobId);
    assert.equal(child.killCount, 1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.preClaudeLaunch, true);
    assert.equal(terminal.residencyReceipt.sessionLeaseReleased, true);
    assert.doesNotThrow(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-identity-failure", "second-job")
    );
  });

  it("terminates an unclaimed child when parent identity publication throws", async () => {
    const child = fakeChild({ pid: 47_105 });
    const { runtime, workspace, claudeConfigDir } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        return "worker-47105";
      },
      publishWorkerIdentity() {
        throw new Error("injected publication failure");
      },
    });
    const prepared = preparedResume(runtime, "publication-failure");

    await assert.rejects(runtime.launchPreparedStart(prepared, "resume task"), /worker handoff/i);

    const terminal = readJobFile(workspace, prepared.jobId);
    assert.equal(child.killCount, 1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.residencyReceipt.sessionLeaseReleased, true);
    assert.doesNotThrow(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-publication-failure", "second-job")
    );
  });

  it("fences and terminates a real post-spawn async error before publication", async () => {
    const child = fakeChild({
      pid: 47_111,
      postSpawnError: new Error("injected post-spawn async error"),
    });
    const { runtime, workspace } = setup({
      spawn() {
        return child;
      },
      async getProcessIdentity() {
        await new Promise((resolve) => setImmediate(resolve));
        return "worker-47111";
      },
    });
    const prepared = preparedResume(runtime, "post-spawn-async-error");

    await assert.rejects(runtime.launchPreparedStart(prepared, "resume task"), /worker handoff/i);

    const terminal = readJobFile(workspace, prepared.jobId);
    assert.equal(child.killCount, 1);
    assert.equal(terminal.status, "failed");
    assert.ok(terminal.workerHandoffFenceAt);
    assert.match(terminal.workerHandoffError, /post-spawn async error/);
  });

  it("does not let a stale launcher publication overwrite a newer generation", async () => {
    const child = fakeChild({ pid: 47_112, emitExitOnKill: false });
    const { runtime, workspace } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        patchJob(workspace, "stale-publication", {
          launcherGeneration: "newer-launcher-generation",
        });
        return "worker-47112";
      },
    });
    const prepared = preparedResume(runtime, "stale-publication");

    await assert.rejects(
      runtime.launchPreparedStart(prepared, "resume task"),
      /ownership remains uncertain/
    );

    const retained = readJobFile(workspace, prepared.jobId);
    assert.equal(retained.status, HARNESS_QUEUED_JOB_STATUS);
    assert.equal(retained.launcherGeneration, "newer-launcher-generation");
    assert.equal(retained.workerPid, process.pid);
    assert.notEqual(retained.workerPid, child.pid);
    assert.equal(child.killCount, 0);
    assert.equal(child.unrefCount, 1);
  });

  it("keeps an unresolved child referenced when durable uncertainty cannot be written", async () => {
    const child = fakeChild({ pid: 47_113, emitExitOnKill: false });
    const { runtime, workspace, claudeConfigDir } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        patchJob(workspace, "uncertainty-write-failure", {
          launcherGeneration: "newer-launcher-generation",
        });
        return "worker-47113";
      },
      recordWorkerHandoffUncertainty() {
        throw new Error("injected uncertainty persistence failure");
      },
    });
    const prepared = preparedResume(runtime, "uncertainty-write-failure");

    await assert.rejects(
      runtime.launchPreparedStart(prepared, "resume task"),
      /ownership remains uncertain/
    );

    const retained = readJobFile(workspace, prepared.jobId);
    assert.equal(retained.status, HARNESS_QUEUED_JOB_STATUS);
    assert.equal(retained.workerHandoffUncertainAt, undefined);
    assert.equal(child.killCount, 0);
    assert.equal(child.unrefCount, 0);
    assert.throws(
      () => reserveSessionLease(
        workspace,
        claudeConfigDir,
        "resume-uncertainty-write-failure",
        "second-job"
      ),
      /already owned by active job/
    );
  });

  it("persists the cancelling fence and lease before a no-exit unref failure", async () => {
    const child = fakeChild({
      pid: 47_106,
      emitExitOnKill: false,
      unrefError: new Error("injected unref failure"),
    });
    const { runtime, workspace, claudeConfigDir } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        throw new Error("injected identity failure");
      },
    });
    const prepared = preparedResume(runtime, "sigterm-without-exit");
    let failure = null;

    await assert.rejects(runtime.launchPreparedStart(prepared, "resume task"), (error) => {
      failure = error;
      return /ownership remains uncertain/.test(error.message);
    });

    const cancelling = readJobFile(workspace, prepared.jobId);
    assert.equal(preparedStartDisposition(failure), "ownership_uncertain");
    assert.equal(cancelling.status, "cancelling");
    assert.ok(cancelling.workerHandoffFenceAt);
    assert.ok(cancelling.workerHandoffUncertainAt);
    assert.equal(child.killCount, 1);
    assert.equal(child.unrefCount, 1);
    assert.throws(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-sigterm-without-exit", "second-job"),
      /already owned by active job/
    );
    const old = new Date(Date.now() - 60_000).toISOString();
    writeJobFile(workspace, prepared.jobId, {
      ...cancelling,
      createdAt: old,
      updatedAt: old,
    });
    assert.throws(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-sigterm-without-exit", "second-job"),
      /already owned by active job/
    );
    assert.equal(transitionJob(workspace, prepared.jobId, ["cancelling"], "failed", {
      phase: "fixture_terminal",
      completedAt: new Date().toISOString(),
      workerPid: null,
      workerPidIdentity: null,
      pid: null,
      pidIdentity: null,
    }).transitioned, true);
    assert.doesNotThrow(
      () => reserveSessionLease(workspace, claudeConfigDir, "resume-sigterm-without-exit", "second-job")
    );
  });

  it("treats a queued terminal CAS as an execution fence without killing the child", async () => {
    const child = fakeChild({ pid: 47_109, emitExitOnKill: false });
    const { runtime, workspace } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        return "worker-47109";
      },
      publishWorkerIdentity(cwd, jobId) {
        return transitionJob(cwd, jobId, [HARNESS_QUEUED_JOB_STATUS], "cancelled", {
          phase: "cancelled_before_handoff",
          completedAt: new Date().toISOString(),
          workerPid: null,
          workerPidIdentity: null,
          pid: null,
          pidIdentity: null,
        });
      },
    });
    const prepared = preparedResume(runtime, "terminal-without-exit");
    await assert.rejects(runtime.launchPreparedStart(prepared, "resume task"), (error) => {
      return /ended before Claude launch/.test(error.message);
    });

    const terminal = readJobFile(workspace, prepared.jobId);
    assert.equal(terminal.status, "cancelled");
    assert.equal(child.killCount, 0);
    assert.equal(child.unrefCount, 1);
    assert.equal(
      transitionJob(workspace, prepared.jobId, ["queued"], "running", {
        workerPid: child.pid,
        workerPidIdentity: "worker-47109",
      }).transitioned,
      false
    );
  });

  it("accepts a matching worker claim that wins before the cancelling fence", async () => {
    let workspace = null;
    let jobId = null;
    const child = fakeChild({
      pid: 47_107,
    });
    const { runtime, claudeConfigDir } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        transitionJob(workspace, jobId, [HARNESS_QUEUED_JOB_STATUS], "running", {
          workerPid: child.pid,
          workerPidIdentity: "worker-47107",
          phase: "starting",
        });
        throw new Error("worker claim beat parent identity lookup");
      },
    });
    workspace = runtime.cwd;
    jobId = "exit-claim-race";
    const prepared = preparedResume(runtime, jobId);

    const receipt = await runtime.launchPreparedStart(prepared, "resume task");

    assert.equal(receipt.status, "queued");
    assert.equal(readJobFile(workspace, jobId).status, "running");
    assert.equal(child.killCount, 0);
    assert.equal(child.unrefCount, 1);
    assert.throws(
      () => reserveSessionLease(workspace, claudeConfigDir, `resume-${jobId}`, "second-job"),
      /already owned by active job/
    );
  });

  it("never deletes a prepared job once detached launch is durably marked", () => {
    const { runtime, workspace } = setup();
    const prepared = preparedResume(runtime, "marked-before-spawn", "marker-session");
    patchJob(workspace, prepared.jobId, { workerLaunchStartedAt: new Date().toISOString() });

    assert.equal(runtime.abortPreparedStart(prepared), false);
    assert.ok(readJobFile(workspace, prepared.jobId));
  });

  it("does not turn a successful handoff into a launch failure when log cleanup throws", async () => {
    const child = fakeChild({ pid: 47_103 });
    const { runtime } = setup({
      spawn() {
        return child;
      },
      getProcessIdentity() {
        return "worker-47103";


      },
      createWorkerLogStdio() {
        return {
          stdio: ["ignore", "ignore", "ignore"],
          close() {
            throw new Error("injected log close failure");
          },
        };
      },
    });
    const prepared = preparedResume(runtime, "log-close-after-handoff", "log-close-session");

    const receipt = await runtime.launchPreparedStart(prepared, "resume task");

    assert.equal(receipt.status, "queued");
    assert.equal(child.unrefCount, 1);
  });

  it("keeps an Agent attached for terminal pre-Claude lifecycle reconciliation", async () => {
    const child = fakeChild({ pid: 47_108 });
    const seed = setup();
    const agentRuntime = agentRuntimeWithInjectedJobs(seed, {
      spawn() {
        return child;
      },
      getProcessIdentity() {
        throw new Error("injected identity failure");
      },
    });

    await assert.rejects(
      agentRuntime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "terminal_handoff",
        message: "preserve before reconciliation",
        model: "claude-haiku-4-5",
        reasoning_effort: "low",
        write: false,
      }),
      /worker handoff/i
    );

    const attached = agentRuntime.store.resolveTarget("terminal_handoff");
    const terminal = readJobFile(seed.workspace, attached.activeJobId);
    assert.equal(attached.status, "running");
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.preClaudeLaunch, true);
    assert.equal(agentRuntime.store.listMessages(attached.agentId)[0].state, "assigned");

    const reconciliation = agentRuntime.reconcile();
    assert.equal(reconciliation[0].reason, "pre_claude_activation_recovered");
    const recovered = agentRuntime.store.resolveTarget(attached.agentId);
    assert.equal(recovered.status, "pending_init");
    assert.equal(recovered.activeJobId, null);
    assert.equal(agentRuntime.store.listMessages(recovered.agentId)[0].state, "queued");
  });

  it("preserves attached Agent ownership and lease when post-spawn outcome is unknown", async () => {
    const child = fakeChild({ pid: 47_104, killResult: false });
    const seed = setup();
    const agentRuntime = agentRuntimeWithInjectedJobs(seed, {
      spawn() {
        return child;
      },
      getProcessIdentity() {
        throw new Error("injected identity failure");
      },
    });

    await assert.rejects(
      agentRuntime.spawnAgent({
        topology: "leaf",
        harness: "claude-code",
        task_name: "unknown_handoff",
        message: "do not detach me",
        model: "claude-haiku-4-5",
        reasoning_effort: "low",
        write: false,
      }),
      /worker handoff/i
    );

    const agent = agentRuntime.store.resolveTarget("unknown_handoff");
    const job = readJobFile(seed.workspace, agent.activeJobId);
    assert.equal(agent.activeJobId, job.id);
    assert.equal(agent.status, "running");
    assert.equal(job.status, "cancelling");
    assert.ok(job.workerLaunchStartedAt);
    assert.ok(job.workerHandoffFenceAt);
    assert.ok(job.workerHandoffUncertainAt);
    assert.match(job.workerHandoffError, /could not prove/);
    assert.equal(child.unrefCount, 1);
    assert.equal(agentRuntime.store.listMessages(agent.agentId)[0].state, "assigned");
  });
});
