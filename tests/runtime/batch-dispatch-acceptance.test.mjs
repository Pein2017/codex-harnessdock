/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { readUnreadCompletionEvents } from "../../runtime/completion-inbox.mjs";
import { resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { inspectLeaseInventory } from "../../runtime/instance-admission-lease.mjs";
import { listStoredJobs } from "../../runtime/job-store.mjs";
import { CODEX_SANDBOX_META_KEY, createCcMcpServer } from "../../runtime/mcp-server.mjs";

const roots = [];
const closers = [];
const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-batch-dispatch-acceptance-home-"));
const codexHome = path.join(runtimeHome, "codex-home");
let sequence = 0;

after(() => fs.rmSync(runtimeHome, { recursive: true, force: true }));
afterEach(async () => {
  while (closers.length) await closers.pop()();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function setup({ abortSignal = null, targetCount = 0 } = {}) {
  sequence += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-batch-dispatch-acceptance-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  const targets = [];
  roots.push(root);

  fs.mkdirSync(workspace);
  if (targetCount > 0) {
    git(workspace, ["init", "-q"]);
    git(workspace, ["config", "user.email", "acceptance@example.invalid"]);
    git(workspace, ["config", "user.name", "Batch Dispatch Acceptance"]);
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "acceptance\n");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-qm", "acceptance fixture"]);
    for (let index = 0; index < targetCount; index += 1) {
      const target = path.join(root, `target-${index + 1}`);
      git(workspace, ["worktree", "add", "-qb", `target_${index + 1}`, target]);
      targets.push(fs.realpathSync.native(target));
    }
  }
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);

  const ownerRootId = `batch-dispatch-acceptance-${process.pid}-${sequence}`;
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    abortSignal,
    env: {
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: ownerRootId,
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: ownerRootId,
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { runtime, workspace: fs.realpathSync.native(workspace), targets };
}

function row(taskName, overrides = {}) {
  return {
    task_name: taskName,
    message: `Run ${taskName} without a provider turn.`,
    harness: "claude-code",
    model: "claude-sonnet-5",
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
    ...overrides,
  };
}

function rows(count, prefix) {
  return Array.from({ length: count }, (_, index) => row(`${prefix}_${index + 1}`));
}

function routeObservation(runtime, harnessId) {
  const driver = resolveDriverV2(harnessId, { env: runtime.jobs.env });
  return {
    driver,
    inspections: [{
      harnessId,
      instanceKey: claudeCodeInstanceKey(runtime.jobs.env.CLAUDE_CONFIG_DIR),
      readiness: "ready",
      liveValidated: true,
      maturity: "experimental",
      detailCode: "ready",
      routes: {
        models: ["claude-sonnet-5"],
        effortsByModel: { "claude-sonnet-5": ["high"] },
        topologies: ["leaf", "native_orchestrator"],
        interaction: "noninteractive_fixed_policy",
      },
      capabilityProvenance: Object.fromEntries([
        "interaction", "activeInput", "continuation", "history", "interruptRequest",
        "turnObservation", "automaticRecovery", "authorityEnforcement", "leafEnforcement",
        "nativeOrchestration",
      ].map((name) => [name, "checkout_declared"])),
      inspectionGeneration: "unavailable",
    }],
  };
}

function readyReceipt(runtime) {
  return {
    ready: true,
    availability: { available: true },
    compatibility: {
      staticCompatible: true,
      fingerprint: "batch-dispatch-acceptance",
      executable: process.execPath,
      version: "test",
    },
    auth: { loggedIn: true },
    cwd: runtime.jobs.cwd,
    claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR,
    sourceRoot: runtime.jobs.sourceRoot,
  };
}

/**
 * All host probes and child handoffs are replaced at their existing seams. The
 * real runtime, Agent stores, route admission, and typed MCP boundary remain
 * in the path under test; this fixture cannot contact a Harness or a model.
 */
function installZeroModelSeams(runtime) {
  const witness = {
    discoveries: [],
    serviceEnsures: [],
    readinessCalls: 0,
    jobPreparations: 0,
    fakeHandoffs: [],
    preparedStartAborts: 0,
    rollbacks: 0,
    interruptions: 0,
    onInspect: null,
    onEnsure: null,
  };
  const prepareStart = runtime.jobs.prepareStart.bind(runtime.jobs);
  const abortPreparedStart = runtime.jobs.abortPreparedStart.bind(runtime.jobs);
  const rollbackActivation = runtime.rollbackActivation.bind(runtime);
  const interruptAgent = runtime.interruptAgent.bind(runtime);

  runtime.jobs.inspectRouteInstance = async (harnessId, executionRoot) => {
    const entry = Object.freeze({
      index: witness.discoveries.length,
      harnessId,
      executionRoot,
    });
    witness.discoveries.push(entry);
    if (witness.onInspect) return await witness.onInspect(entry);
    return routeObservation(runtime, harnessId);
  };
  runtime.ensureDispatchHarness = async (harnessId, executionRoot) => {
    const entry = Object.freeze({ harnessId, executionRoot });
    witness.serviceEnsures.push(entry);
    if (witness.onEnsure) return await witness.onEnsure(entry);
    return undefined;
  };
  runtime.jobs.assertReady = () => {
    witness.readinessCalls += 1;
    return readyReceipt(runtime);
  };
  runtime.jobs.prepareStart = (...args) => {
    witness.jobPreparations += 1;
    return prepareStart(...args);
  };
  runtime.jobs.launchPreparedStart = async (prepared) => {
    witness.fakeHandoffs.push(Object.freeze({ jobId: prepared.jobId, agentId: prepared.agentId }));
    return { jobId: prepared.jobId, agentId: prepared.agentId, status: "queued" };
  };
  runtime.jobs.abortPreparedStart = (...args) => {
    witness.preparedStartAborts += 1;
    return abortPreparedStart(...args);
  };
  runtime.rollbackActivation = (...args) => {
    witness.rollbacks += 1;
    return rollbackActivation(...args);
  };
  runtime.interruptAgent = async (...args) => {
    witness.interruptions += 1;
    return await interruptAgent(...args);
  };
  return witness;
}

function runtimeSurface(runtime, overrides = {}) {
  return {
    spawn_agent: overrides.spawn_agent ?? ((input) => runtime.spawnAgent(input)),
    dispatch_agents: overrides.dispatch_agents ?? ((input) => {
      if (typeof runtime.dispatchAgents !== "function") {
        throw new Error("dispatch_agents runtime operation is unavailable");
      }
      return runtime.dispatchAgents(input);
    }),
    list_agents: overrides.list_agents ?? ((input) => runtime.listAgents(input)),
  };
}

async function mcpClientFor(runtime, overrides = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCcMcpServer({ runtimeFactory: () => runtimeSurface(runtime, overrides) });
  const client = new Client({ name: "batch-dispatch-acceptance", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });
  return client;
}

function meta(runtime) {
  return {
    threadId: runtime.ownerRootId,
    [CODEX_SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(runtime.cwd).href },
  };
}

async function callTool(client, runtime, name, args) {
  return await client.callTool({ name, arguments: args, _meta: meta(runtime) });
}

function successfulPayload(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${JSON.stringify(result.content)}`);
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.ok(text, `${label} must return one text payload`);
  const payload = JSON.parse(text);
  assert.deepEqual(payload, result.structuredContent, `${label} text and structured receipts differ`);
  return payload;
}

async function assertPublicDispatchTool(client) {
  const listed = await client.listTools();
  assert.equal(
    listed.tools.filter((tool) => tool.name === "dispatch_agents").length,
    1,
    "dispatch_agents must be one public typed MCP tool",
  );
}

function rowTuples(receipt) {
  return receipt.rows.map((value) => [
    value.agent_name,
    value.agent_exists,
    value.outcome,
    value.error?.code ?? null,
  ]);
}

function discoveryGroups(discoveries) {
  const counts = new Map();
  for (const { harnessId, executionRoot } of discoveries) {
    const key = JSON.stringify([harnessId, executionRoot]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function heldLeases(ownerRootId) {
  return inspectLeaseInventory().entries
    .flatMap((entry) => entry.holders ?? [])
    .filter((holder) => holder.ownerRootId === ownerRootId);
}

function assertNoStructuralWork(fixture, witness) {
  assert.deepEqual(witness.serviceEnsures, []);
  assert.deepEqual(witness.discoveries, []);
  assert.equal(witness.readinessCalls, 0);
  assert.equal(witness.jobPreparations, 0);
  assert.deepEqual(witness.fakeHandoffs, []);
  assert.equal(witness.preparedStartAborts, 0);
  assert.equal(witness.rollbacks, 0);
  assert.equal(witness.interruptions, 0);
  assert.deepEqual(fixture.runtime.store.listAgents(), []);
  assert.deepEqual(fixture.runtime.versionThreeStore().listAgents(), []);
  assert.deepEqual(listStoredJobs(fixture.workspace), []);
  assert.deepEqual(readUnreadCompletionEvents(fixture.workspace, fixture.runtime.ownerRootId).events, []);
  assert.deepEqual(heldLeases(fixture.runtime.ownerRootId), []);
}

function publicRecovery(taskName, outcome) {
  const messages = {
    lifecycle_owned: "Agent launch ownership was transferred; join the named Agent to reconcile its turn.",
    ownership_uncertain: "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
  };
  const error = new Error("private provider failure must not be projected");
  error.publicRecovery = {
    agent_name: `/root/${taskName}`,
    outcome,
    code: outcome === "lifecycle_owned" ? "spawn_lifecycle_owned" : "spawn_ownership_uncertain",
    message: messages[outcome],
  };
  return error;
}

async function measure(action) {
  const startedAt = performance.now();
  const value = await action();
  const wallMs = performance.now() - startedAt;
  assert.equal(Number.isFinite(wallMs), true);
  assert.ok(wallMs >= 0);
  return { value, wallMs };
}

describe("stateless batch dispatch deterministic acceptance", () => {
  it("measures N=1/4/8 typed calls and exact-pair discovery without a speed threshold", async (t) => {
    const measurements = [];

    for (const count of [1, 4, 8]) {
      const singular = setup();
      const singularWitness = installZeroModelSeams(singular.runtime);
      const singularClient = await mcpClientFor(singular.runtime);
      await assertPublicDispatchTool(singularClient);
      const singularRows = rows(count, `single_${count}`);
      const singularCalls = [];
      const singularRun = await measure(async () => {
        for (const input of singularRows) {
          singularCalls.push({ operation: "spawn_agent", input });
          successfulPayload(
            await callTool(singularClient, singular.runtime, "spawn_agent", input),
            `singular N=${count}`,
          );
        }
      });

      const batch = setup();
      const batchWitness = installZeroModelSeams(batch.runtime);
      const batchClient = await mcpClientFor(batch.runtime);
      await assertPublicDispatchTool(batchClient);
      const batchRows = rows(count, `batch_${count}`);
      const batchCalls = [];
      const batchRun = await measure(async () => {
        batchCalls.push({ operation: "dispatch_agents", input: { rows: batchRows } });
        return successfulPayload(
          await callTool(batchClient, batch.runtime, "dispatch_agents", { rows: batchRows }),
          `dispatch N=${count}`,
        );
      });

      assert.equal(singularCalls.length, count);
      assert.equal(batchCalls.length, 1);
      assert.equal(batchCalls[0].input.rows.length, count);
      assert.equal(singularWitness.discoveries.length, count);
      assert.equal(batchWitness.discoveries.length, 1);
      assert.deepEqual(batchRun.value.rows.map((value) => value.outcome), Array(count).fill("launched"));
      assert.equal(singularCalls.length - batchCalls.length, count - 1);
      measurements.push({
        rows: count,
        singular_mcp_calls: singularCalls.length,
        dispatch_mcp_calls: batchCalls.length,
        singular_discoveries: singularWitness.discoveries.length,
        dispatch_discoveries: batchWitness.discoveries.length,
        singular_wall_ms: singularRun.wallMs,
        dispatch_wall_ms: batchRun.wallMs,
      });
    }

    assert.deepEqual(measurements.map((measurement) => [
      measurement.rows,
      measurement.singular_mcp_calls,
      measurement.dispatch_mcp_calls,
      measurement.singular_discoveries,
      measurement.dispatch_discoveries,
    ]), [
      [1, 1, 1, 1, 1],
      [4, 4, 1, 4, 1],
      [8, 8, 1, 8, 1],
    ]);
    t.diagnostic?.(JSON.stringify({
      decision: "call and exact-pair discovery reduction; wall time is recorded without a threshold",
      measurements,
    }));
  });

  it("reuses discovery once per canonical Harness/root group and separates roots", async () => {
    const fixture = setup({ targetCount: 1 });
    const witness = installZeroModelSeams(fixture.runtime);
    const launched = [];
    fixture.runtime.launchDispatchRow = async (input) => {
      launched.push(input.task_name);
      return { agent_name: `/root/${input.task_name}`, status: "working" };
    };
    const client = await mcpClientFor(fixture.runtime);
    await assertPublicDispatchTool(client);

    const receipt = successfulPayload(
      await callTool(client, fixture.runtime, "dispatch_agents", {
        rows: [
          row("control_one"),
          row("control_two"),
          row("target_one", { target_worktree: fixture.targets[0] }),
          row("target_two", { target_worktree: fixture.targets[0] }),
        ],
      }),
      "different-root dispatch",
    );

    assert.deepEqual(launched, ["control_one", "control_two", "target_one", "target_two"]);
    assert.deepEqual(receipt.rows.map((value) => value.outcome), Array(4).fill("launched"));
    assert.deepEqual(discoveryGroups(witness.discoveries), [
      [JSON.stringify(["claude-code", fixture.targets[0]]), 1],
      [JSON.stringify(["claude-code", fixture.workspace]), 1],
    ].sort(([left], [right]) => left.localeCompare(right)));
  });

  it("rejects structural input before service, Agent, mailbox, job, lease, or native work", async () => {
    const fixture = setup();
    const witness = installZeroModelSeams(fixture.runtime);
    let runtimeDispatches = 0;
    if (typeof fixture.runtime.dispatchAgents === "function") {
      const dispatchAgents = fixture.runtime.dispatchAgents.bind(fixture.runtime);
      fixture.runtime.dispatchAgents = async (input) => {
        runtimeDispatches += 1;
        return await dispatchAgents(input);
      };
    }
    const client = await mcpClientFor(fixture.runtime);
    await assertPublicDispatchTool(client);

    const rejected = await callTool(client, fixture.runtime, "dispatch_agents", {
      rows: [row("duplicate"), row("duplicate")],
    });

    assert.equal(rejected.isError, true);
    assert.equal(runtimeDispatches, 0, "typed structural rejection must not reach runtime dispatch");
    assertNoStructuralWork(fixture, witness);
  });

  it("rejects route/readiness, existing-name, and same-root writer conflicts without launching a row", async () => {
    const routeFailure = setup({ targetCount: 1 });
    const routeWitness = installZeroModelSeams(routeFailure.runtime);
    const routeLaunches = [];
    routeWitness.onInspect = (entry) => {
      if (entry.index === 1) throw new Error("injected route/readiness failure");
      return routeObservation(routeFailure.runtime, entry.harnessId);
    };
    routeFailure.runtime.launchDispatchRow = async (input) => {
      routeLaunches.push(input.task_name);
      throw new Error("launch must not run after environment failure");
    };
    const routeClient = await mcpClientFor(routeFailure.runtime);
    await assertPublicDispatchTool(routeClient);
    const routeReceipt = successfulPayload(
      await callTool(routeClient, routeFailure.runtime, "dispatch_agents", {
        rows: [
          row("route_ready"),
          row("route_rejected", { target_worktree: routeFailure.targets[0] }),
        ],
      }),
      "route/readiness rejection",
    );
    assert.deepEqual(routeLaunches, []);
    assert.deepEqual(rowTuples(routeReceipt), [
      ["/root/route_ready", false, "not_attempted", "batch_preflight_stopped"],
      ["/root/route_rejected", false, "not_attempted", "route_rejected"],
    ]);
    assert.equal(routeWitness.readinessCalls, 0);
    assert.equal(routeWitness.jobPreparations, 0);
    assert.deepEqual(routeWitness.fakeHandoffs, []);
    assert.deepEqual(routeFailure.runtime.versionThreeStore().listAgents(), []);
    assert.deepEqual(listStoredJobs(routeFailure.workspace), []);

    const existingName = setup();
    const existingWitness = installZeroModelSeams(existingName.runtime);
    const takenInput = row("taken");
    const accepted = await existingName.runtime.acceptStatedRoute(
      takenInput,
      "batch acceptance seed",
      existingName.runtime.cwd,
    );
    existingName.runtime.versionThreeStore().createAgent({
      task_name: takenInput.task_name,
      route: accepted.route,
      executionRoot: existingName.runtime.cwd,
      initialMessage: "pre-existing Agent",
    });
    existingWitness.discoveries.length = 0;
    const existingLaunches = [];
    existingName.runtime.launchDispatchRow = async (input) => {
      existingLaunches.push(input.task_name);
      throw new Error("existing-name conflict must not launch");
    };
    const existingClient = await mcpClientFor(existingName.runtime);
    await assertPublicDispatchTool(existingClient);
    const existingReceipt = successfulPayload(
      await callTool(existingClient, existingName.runtime, "dispatch_agents", {
        rows: [takenInput, row("still_unattempted")],
      }),
      "existing-name rejection",
    );
    assert.deepEqual(existingLaunches, []);
    assert.deepEqual(existingWitness.discoveries, []);
    assert.deepEqual(rowTuples(existingReceipt), [
      ["/root/taken", false, "not_attempted", "agent_name_conflict"],
      ["/root/still_unattempted", false, "not_attempted", "batch_preflight_stopped"],
    ]);

    const writerConflict = setup();
    const writerWitness = installZeroModelSeams(writerConflict.runtime);
    const writerLaunches = [];
    writerConflict.runtime.launchDispatchRow = async (input) => {
      writerLaunches.push(input.task_name);
      throw new Error("writer conflict must not launch");
    };
    const writerClient = await mcpClientFor(writerConflict.runtime);
    await assertPublicDispatchTool(writerClient);
    const writerReceipt = successfulPayload(
      await callTool(writerClient, writerConflict.runtime, "dispatch_agents", {
        rows: [row("writer_one", { write: true }), row("writer_two", { write: true })],
      }),
      "same-root writer rejection",
    );
    assert.deepEqual(writerLaunches, []);
    assert.deepEqual(writerWitness.discoveries, []);
    assert.deepEqual(rowTuples(writerReceipt), [
      ["/root/writer_one", false, "not_attempted", "batch_writer_conflict"],
      ["/root/writer_two", false, "not_attempted", "batch_writer_conflict"],
    ]);
  });

  it("preserves ordered ownership outcomes and starts nothing after uncertainty", async () => {
    const fixture = setup();
    installZeroModelSeams(fixture.runtime);
    const launches = [];
    fixture.runtime.launchDispatchRow = async (input) => {
      launches.push(input.task_name);
      switch (input.task_name) {
        case "launched":
          return { agent_name: "/root/launched", status: "working" };
        case "rolled_back": {
          const error = new Error("private rollback detail");
          error.batchOutcome = "rolled_back";
          throw error;
        }
        case "owned":
          throw publicRecovery("owned", "lifecycle_owned");
        case "uncertain":
          throw publicRecovery("uncertain", "ownership_uncertain");
        default:
          throw new Error("a row after uncertainty must not launch");
      }
    };
    const client = await mcpClientFor(fixture.runtime);
    await assertPublicDispatchTool(client);

    const receipt = successfulPayload(
      await callTool(client, fixture.runtime, "dispatch_agents", {
        rows: [row("launched"), row("rolled_back"), row("owned"), row("uncertain"), row("later")],
      }),
      "ordered ownership dispatch",
    );

    assert.deepEqual(launches, ["launched", "rolled_back", "owned", "uncertain"]);
    assert.deepEqual(rowTuples(receipt), [
      ["/root/launched", true, "launched", null],
      ["/root/rolled_back", false, "rolled_back", "spawn_rolled_back"],
      ["/root/owned", true, "lifecycle_owned", "spawn_lifecycle_owned"],
      ["/root/uncertain", true, "ownership_uncertain", "spawn_ownership_uncertain"],
      ["/root/later", false, "not_attempted", "batch_stopped_after_ownership_uncertain"],
    ]);
    assert.deepEqual(receipt.rows[0].card, { agent_name: "/root/launched", status: "working" });
    assert.equal(receipt.rows.slice(1).every((value) => !Object.hasOwn(value, "card")), true);
    assert.equal(JSON.stringify(receipt).includes("private"), false);
  });

  it("settles the cancelled current row before marking later rows not_attempted", async () => {
    const controller = new AbortController();
    const fixture = setup({ abortSignal: controller.signal });
    installZeroModelSeams(fixture.runtime);
    const launches = [];
    fixture.runtime.launchDispatchRow = async (input) => {
      launches.push(input.task_name);
      controller.abort();
      throw publicRecovery(input.task_name, "lifecycle_owned");
    };
    const client = await mcpClientFor(fixture.runtime);
    await assertPublicDispatchTool(client);

    const receipt = successfulPayload(
      await callTool(client, fixture.runtime, "dispatch_agents", {
        rows: [row("current"), row("later_one"), row("later_two")],
      }),
      "mid-row cancellation",
    );

    assert.deepEqual(launches, ["current"]);
    assert.deepEqual(rowTuples(receipt), [
      ["/root/current", true, "lifecycle_owned", "spawn_lifecycle_owned"],
      ["/root/later_one", false, "not_attempted", "batch_cancelled"],
      ["/root/later_two", false, "not_attempted", "batch_cancelled"],
    ]);
  });

  it("keeps deterministic public names as the only recovery handles after response loss", async () => {
    const fixture = setup();
    const witness = installZeroModelSeams(fixture.runtime);
    let spawnAttempts = 0;
    const launchDispatchRow = fixture.runtime.launchDispatchRow.bind(fixture.runtime);
    fixture.runtime.launchDispatchRow = async (...args) => {
      spawnAttempts += 1;
      return await launchDispatchRow(...args);
    };
    let runtimeDispatches = 0;
    let loseFirstResponse = true;
    const client = await mcpClientFor(fixture.runtime, {
      dispatch_agents: async (input) => {
        runtimeDispatches += 1;
        const receipt = await fixture.runtime.dispatchAgents(input);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("injected response loss after durable dispatch");
        }
        return receipt;
      },
    });
    await assertPublicDispatchTool(client);
    const input = { rows: [row("lost_one"), row("lost_two")] };

    const lost = await callTool(client, fixture.runtime, "dispatch_agents", input);
    assert.equal(lost.isError, true, "the caller must receive no batch receipt after injected response loss");
    assert.equal(runtimeDispatches, 1);
    assert.equal(spawnAttempts, 2);
    assert.equal(witness.jobPreparations, 2);
    assert.equal(witness.fakeHandoffs.length, 2);
    assert.equal(witness.preparedStartAborts, 0);
    assert.equal(witness.rollbacks, 0);
    assert.equal(witness.interruptions, 0);
    for (const taskName of ["lost_one", "lost_two"]) {
      assert.equal(
        fixture.runtime.versionThreeStore().resolveTarget(`/root/${taskName}`).path,
        `/root/${taskName}`,
      );
    }
    const recoveryHandles = successfulPayload(
      await callTool(client, fixture.runtime, "list_agents", {}),
      "lost-response public reconciliation",
    );
    assert.deepEqual(
      recoveryHandles.agents.map((agent) => agent.agent_name).sort(),
      ["/root/lost_one", "/root/lost_two"],
    );

    const retried = successfulPayload(
      await callTool(client, fixture.runtime, "dispatch_agents", input),
      "post-loss explicit retry",
    );
    assert.equal(runtimeDispatches, 2);
    assert.equal(spawnAttempts, 2, "a lost response must not replay a row");
    assert.equal(witness.fakeHandoffs.length, 2, "a lost response must not create replacement turns");
    assert.equal(witness.preparedStartAborts, 0, "a lost response must not clean up durable Agents");
    assert.equal(witness.rollbacks, 0, "a lost response must not roll back durable Agents");
    assert.equal(witness.interruptions, 0, "a lost response must not interrupt durable Agents");
    assert.deepEqual(rowTuples(retried), [
      ["/root/lost_one", false, "not_attempted", "agent_name_conflict"],
      ["/root/lost_two", false, "not_attempted", "agent_name_conflict"],
    ]);
    assert.equal(witness.discoveries.length, 1, "existing names must reject before a retry can rediscover or skip");
  });
});
