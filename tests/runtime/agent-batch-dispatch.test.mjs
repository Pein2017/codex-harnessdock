/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { inspectLeaseInventory } from "../../runtime/instance-admission-lease.mjs";
import { listStoredJobs } from "../../runtime/job-store.mjs";

const roots = [];
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-batch-dispatch-home-"));

after(() => fs.rmSync(runtimeHome, { recursive: true, force: true }));
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup({ abortSignal = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-batch-dispatch-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  roots.push(root);
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    abortSignal,
    env: {
      CODEX_THREAD_ID: `batch-dispatch-${process.pid}-${roots.length}`,
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { runtime, workspace, claudeConfigDir };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setupRegisteredWorktrees() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-batch-worktrees-"));
  const controlRoot = path.join(root, "control");
  const firstTarget = path.join(root, "first");
  const secondTarget = path.join(root, "second");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(controlRoot);
  fs.mkdirSync(claudeConfigDir);
  roots.push(root);
  git(controlRoot, ["init", "-q"]);
  git(controlRoot, ["config", "user.email", "fixture@example.invalid"]);
  git(controlRoot, ["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(controlRoot, "tracked.txt"), "fixture\n");
  git(controlRoot, ["add", "tracked.txt"]);
  git(controlRoot, ["commit", "-qm", "fixture"]);
  git(controlRoot, ["worktree", "add", "-qb", "first", firstTarget]);
  git(controlRoot, ["worktree", "add", "-qb", "second", secondTarget]);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  const runtime = createAgentRuntime({
    cwd: controlRoot,
    envFile,
    env: {
      CODEX_THREAD_ID: `batch-worktrees-${process.pid}-${roots.length}`,
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { root, runtime, firstTarget, secondTarget };
}

function row(taskName, overrides = {}) {
  return {
    task_name: taskName,
    message: `Implement ${taskName}.`,
    harness: "claude-code",
    model: "claude-sonnet-5",
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
    ...overrides,
  };
}

function installRouteInspection(runtime, { models = ["claude-sonnet-5", "claude-opus-5"] } = {}) {
  let inspections = 0;
  runtime.jobs.inspectRouteInstance = async (harnessId) => {
    inspections += 1;
    const driver = resolveDriverV2(harnessId, { env: runtime.jobs.env });
    const inspection = {
      harnessId,
      instanceKey: claudeCodeInstanceKey(runtime.jobs.env.CLAUDE_CONFIG_DIR),
      readiness: "ready",
      liveValidated: true,
      maturity: "experimental",
      detailCode: "ready",
      routes: {
        models,
        effortsByModel: Object.fromEntries(models.map((model) => [model, ["high"]])),
        topologies: ["leaf", "native_orchestrator"],
        interaction: "noninteractive_fixed_policy",
      },
      capabilityProvenance: Object.fromEntries([
        "interaction", "activeInput", "continuation", "history", "interruptRequest",
        "turnObservation", "nativeProgress", "automaticRecovery", "authorityEnforcement", "leafEnforcement",
        "nativeOrchestration", "nativeProgress",
      ].map((name) => [name, "checkout_declared"])),
      inspectionGeneration: "unavailable",
    };
    return { driver, inspections: [inspection] };
  };
  return () => inspections;
}

function launchedCard(agentName) {
  return { agent_name: agentName, status: "working" };
}

describe("stateless batch dispatch structural and environment preflight", () => {
  it("rejects malformed row sets before discovery or service activity", async () => {
    const { runtime, workspace } = setup();
    let inspections = 0;
    let serviceEnsures = 0;
    runtime.jobs.inspectRouteInstance = async () => { inspections += 1; throw new Error("must not inspect"); };
    runtime.ensureDispatchHarness = async () => { serviceEnsures += 1; };

    for (const input of [
      { rows: [] },
      { rows: Array.from({ length: 9 }, (_, index) => row(`row_${index}`)) },
      { rows: [row("duplicate"), row("duplicate")] },
      { rows: [{ ...row("unknown"), retry: true }] },
      { rows: [{ ...row("alias"), task_name: undefined, agent_name: "/root/alias" }] },
      { rows: [{ ...row("missing_effort"), reasoning_effort: undefined }] },
    ]) {
      await assert.rejects(runtime.dispatchAgents(input));
    }
    assert.equal(inspections, 0);
    assert.equal(serviceEnsures, 0);
    assert.deepEqual(runtime.versionThreeStore().listAgents(), []);
    assert.deepEqual(listStoredJobs(workspace), []);
    assert.equal(inspectLeaseInventory().total, 0);
  });

  it("rejects same-root writers and existing names before discovery, launching no row", async () => {
    const { runtime } = setup();
    const inspectionCount = installRouteInspection(runtime);
    let launches = 0;
    const originalLaunch = runtime.launchDispatchRow.bind(runtime);
    runtime.launchDispatchRow = async (...args) => { launches += 1; return originalLaunch(...args); };

    const writers = await runtime.dispatchAgents({ rows: [
      row("writer_a", { write: true }),
      row("writer_b", { write: true }),
    ] });
    assert.deepEqual(writers.rows.map(({ outcome, agent_exists: exists }) => [outcome, exists]), [
      ["not_attempted", false],
      ["not_attempted", false],
    ]);
    assert.ok(writers.rows.every((value) => value.error?.code === "batch_writer_conflict"));
    assert.equal(inspectionCount(), 0);
    assert.equal(launches, 0);

    const accepted = await runtime.acceptStatedRoute(row("taken"), "fixture", runtime.cwd);
    runtime.versionThreeStore().createAgent({
      task_name: "taken",
      route: accepted.route,
      executionRoot: runtime.cwd,
      initialMessage: "existing",
    });
    const beforeCollision = inspectionCount();
    const collision = await runtime.dispatchAgents({ rows: [row("taken"), row("free")] });
    assert.deepEqual(collision.rows.map((value) => value.outcome), ["not_attempted", "not_attempted"]);
    assert.equal(collision.rows[0].error.code, "agent_name_conflict");
    assert.equal(collision.rows[1].error.code, "batch_preflight_stopped");
    assert.equal(inspectionCount(), beforeCollision);
    assert.equal(launches, 0);
  });

  it("shares discovery only for an exact Harness and execution-root pair", async () => {
    const { runtime } = setup();
    const inspectionCount = installRouteInspection(runtime);
    let serviceEnsures = 0;
    runtime.ensureDispatchHarness = async () => { serviceEnsures += 1; };
    runtime.launchDispatchRow = async (input) => launchedCard(`/root/${input.task_name}`);

    const result = await runtime.dispatchAgents({ rows: [
      row("one"),
      row("two", { model: "claude-opus-5" }),
      row("three"),
    ] });
    assert.equal(serviceEnsures, 1);
    assert.equal(inspectionCount(), 1);
    assert.deepEqual(result.rows.map((value) => value.outcome), ["launched", "launched", "launched"]);
    assert.deepEqual(result.rows.map((value) => value.card.agent_name), ["/root/one", "/root/two", "/root/three"]);
  });

  it("separates discovery for the same Harness across canonical execution roots", async () => {
    const { root, runtime, firstTarget, secondTarget } = setupRegisteredWorktrees();
    const inspectionCount = installRouteInspection(runtime);
    runtime.launchDispatchRow = async (input) => launchedCard(`/root/${input.task_name}`);

    const result = await runtime.dispatchAgents({ rows: [
      row("first_a", { target_worktree: firstTarget }),
      row("first_b", { target_worktree: path.join(root, "control", "..", "first") }),
      row("second", { target_worktree: secondTarget }),
    ] });
    assert.equal(inspectionCount(), 2);
    assert.deepEqual(result.rows.map((entry) => entry.outcome), ["launched", "launched", "launched"]);
  });

  it("launches no row when a later route fails whole-array environment preflight", async () => {
    const { runtime } = setup();
    const inspectionCount = installRouteInspection(runtime, { models: ["claude-sonnet-5"] });
    let launches = 0;
    runtime.launchDispatchRow = async () => { launches += 1; return launchedCard("/root/unexpected"); };

    const result = await runtime.dispatchAgents({ rows: [
      row("valid_route"),
      row("invalid_route", { model: "claude-opus-5" }),
    ] });
    assert.equal(inspectionCount(), 1);
    assert.equal(launches, 0);
    assert.equal(result.rows[0].error.code, "batch_preflight_stopped");
    assert.equal(result.rows[1].error.code, "route_rejected");
    assert.deepEqual(result.rows.map((value) => value.outcome), ["not_attempted", "not_attempted"]);
  });

  it("launches a real row through the same singular lifecycle seam", async () => {
    const { runtime } = setup();
    const inspectionCount = installRouteInspection(runtime);
    runtime.jobs.assertReady = () => ({
      ready: true,
      availability: { available: true },
      compatibility: { staticCompatible: true, fingerprint: "test", executable: process.execPath, version: "test" },
      auth: { loggedIn: true },
      cwd: runtime.jobs.cwd,
      claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR,
      sourceRoot: runtime.jobs.sourceRoot,
    });
    runtime.jobs.launchPreparedStart = async () => ({ status: "queued" });

    const result = await runtime.dispatchAgents({ rows: [row("real_row")] });
    assert.equal(inspectionCount(), 1);
    assert.equal(result.rows[0].outcome, "launched");
    assert.equal(result.rows[0].agent_exists, true);
    assert.equal(result.rows[0].card.agent_name, "/root/real_row");
    assert.equal(runtime.versionThreeStore().readAgent("/root/real_row").activeJobId != null, true);
  });

  it("measures one caller dispatch and flat exact-pair discovery at N=1/4/8", async (context) => {
    for (const count of [1, 4, 8]) {
      const { runtime } = setup();
      const inspectionCount = installRouteInspection(runtime);
      let rowLaunches = 0;
      runtime.launchDispatchRow = async (input) => {
        rowLaunches += 1;
        return launchedCard(`/root/${input.task_name}`);
      };
      const rows = Array.from({ length: count }, (_, index) => row(`measure_${count}_${index}`));
      let callerDispatchCalls = 0;
      const started = performance.now();
      callerDispatchCalls += 1;
      const result = await runtime.dispatchAgents({ rows });
      const elapsedMs = performance.now() - started;

      assert.equal(result.rows.length, count);
      assert.equal(rowLaunches, count);
      assert.equal(inspectionCount(), 1);
      assert.equal(callerDispatchCalls, 1);
      assert.equal(count - callerDispatchCalls, count - 1);
      context.diagnostic(JSON.stringify({ count, caller_mcp_calls: callerDispatchCalls, singular_caller_calls: count, discovery_calls: 1, elapsed_ms: elapsedMs }));
    }
  });
});

describe("stateless batch dispatch ordered ownership outcomes", () => {
  it("continues after rollback and lifecycle ownership, then stops after uncertainty", async () => {
    const { runtime } = setup();
    installRouteInspection(runtime);
    const launched = [];
    runtime.launchDispatchRow = async (input) => {
      launched.push(input.task_name);
      if (input.task_name === "launched") return launchedCard("/root/launched");
      if (input.task_name === "rolled_back") {
        throw Object.assign(new Error("private rollback detail"), { batchOutcome: "rolled_back" });
      }
      const outcome = input.task_name === "owned" ? "lifecycle_owned" : "ownership_uncertain";
      throw Object.assign(new Error("private provider detail"), {
        publicRecovery: {
          agent_name: `/root/${input.task_name}`,
          outcome,
          code: outcome === "lifecycle_owned" ? "spawn_lifecycle_owned" : "spawn_ownership_uncertain",
          message: outcome === "lifecycle_owned"
            ? "Agent launch ownership was transferred; join the named Agent to reconcile its turn."
            : "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
        },
      });
    };

    const result = await runtime.dispatchAgents({ rows: [
      row("launched"), row("rolled_back"), row("owned"), row("uncertain"), row("later"),
    ] });
    assert.deepEqual(launched, ["launched", "rolled_back", "owned", "uncertain"]);
    assert.deepEqual(result.rows.map(({ outcome, agent_exists: exists }) => [outcome, exists]), [
      ["launched", true],
      ["rolled_back", false],
      ["lifecycle_owned", true],
      ["ownership_uncertain", true],
      ["not_attempted", false],
    ]);
    assert.equal(result.rows[1].error.code, "spawn_rolled_back");
    assert.equal(result.rows[4].error.code, "batch_stopped_after_ownership_uncertain");
    assert.equal(JSON.stringify(result).includes("private"), false);
  });

  it("settles a cancellation-owning current row and starts no later row", async () => {
    const controller = new AbortController();
    const { runtime } = setup({ abortSignal: controller.signal });
    installRouteInspection(runtime);
    const launched = [];
    runtime.launchDispatchRow = async (input) => {
      launched.push(input.task_name);
      controller.abort();
      throw Object.assign(new Error("private cancellation"), {
        publicRecovery: {
          agent_name: `/root/${input.task_name}`,
          outcome: "lifecycle_owned",
          code: "spawn_lifecycle_owned",
          message: "Agent launch ownership was transferred; join the named Agent to reconcile its turn.",
        },
      });
    };

    const result = await runtime.dispatchAgents({ rows: [row("current"), row("later")] });
    assert.deepEqual(launched, ["current"]);
    assert.deepEqual(result.rows.map((value) => value.outcome), ["lifecycle_owned", "not_attempted"]);
    assert.equal(result.rows[1].error.code, "batch_cancelled");
  });

  it("does not replay a lost receipt and collides on the existing public Agent name", async () => {
    const { runtime } = setup();
    const discoveries = installRouteInspection(runtime);
    runtime.jobs.assertReady = () => ({
      ready: true,
      availability: { available: true },
      compatibility: { staticCompatible: true, fingerprint: "test", executable: process.execPath, version: "test" },
      auth: { loggedIn: true },
      cwd: runtime.jobs.cwd,
      claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR,
      sourceRoot: runtime.jobs.sourceRoot,
    });
    let launches = 0;
    runtime.jobs.launchPreparedStart = async () => { launches += 1; return { status: "queued" }; };

    // Discard the first successful receipt: durable state is unchanged by the
    // response transport the caller did not receive.
    await runtime.dispatchAgents({ rows: [row("lost")] });
    const second = await runtime.dispatchAgents({ rows: [row("lost")] });

    assert.equal(discoveries(), 1);
    assert.equal(launches, 1);
    assert.equal(second.rows[0].outcome, "not_attempted");
    assert.equal(second.rows[0].error.code, "agent_name_conflict");
    assert.equal(second.rows[0].agent_name, "/root/lost");
  });
});
