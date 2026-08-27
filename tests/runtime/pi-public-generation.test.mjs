import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { createCcMcpServer } from "../../runtime/mcp-server.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import {
  ADMITTED_DRIVER_V2_HARNESS_IDS,
  ADMITTED_GENERATION_HARNESS_IDS,
  ADMITTED_ROUTE_MODELS,
  harnessExecutionLifecycle,
  resolveDriverV2,
} from "../../runtime/harness-registry.mjs";
import { PI_DRIVER_VERSION, PI_HARNESS_ID, PI_MODELS } from "../../runtime/pi-driver.mjs";
import { acquireNativeSessionLease } from "../../runtime/instance-admission-lease.mjs";
import { recordVersionThreeTurnRunning } from "../../runtime/v3-job-store.mjs";
import { listControlCommands } from "../../runtime/turn-control.mjs";

const roots = [];
const sharedRuntimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-generation-home-"));
after(() => fs.rmSync(sharedRuntimeHome, { recursive: true, force: true }));
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-generation-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const ownerRootId = `pi-public-${root.slice(-8)}`;
  const env = {
    ...process.env,
    CODEX_THREAD_ID: ownerRootId,
    CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: ownerRootId,
    CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
  };
  const runtime = createAgentRuntime({ cwd: workspace, env });
  const driver = resolveDriverV2(PI_HARNESS_ID, { env });
  runtime.jobs.inspectRouteInstance = async () => ({
    driver,
    inspections: [{
      harnessId: PI_HARNESS_ID,
      instanceKey: "pi-local",
      readiness: "ready",
      liveValidated: true,
      maturity: "experimental",
      detailCode: "ready",
      routes: { models: [...PI_MODELS], topologies: ["leaf"], interaction: "noninteractive_fixed_policy" },
    }],
  });
  const launches = [];
  runtime.jobs.launchPreparedStart = async () => { throw new Error("version-one supervisor was invoked"); };
  runtime.jobs.interrupt = async () => { throw new Error("version-one interrupt was invoked"); };
  runtime.jobs.launchVersionThreeWorker = async (options) => {
    launches.push({ ...options, sessionAtLaunch: runtime.versionThreeStore().resolveTarget(options.agentId).nativeSessionRef });
    return { jobId: options.jobId, agentId: options.agentId, attemptId: options.attemptId, status: "queued" };
  };
  return { runtime, ownerRootId, launches };
}

function spawnInput(overrides = {}) {
  return {
    task_name: "pi_agent",
    message: "Inspect the repository.",
    harness: PI_HARNESS_ID,
    model: PI_MODELS[0],
    topology: "leaf",
    write: false,
    reasoning_effort: "high",
    ...overrides,
  };
}

function sessionRef() {
  return {
    version: 1,
    harnessId: PI_HARNESS_ID,
    driverVersion: PI_DRIVER_VERSION,
    instanceKey: "pi-local",
    locatorVersion: 1,
    locator: { sessionId: "123e4567-e89b-42d3-a456-426614174000" },
  };
}

function turnRef() {
  return {
    ...sessionRef(),
    locator: {
      sessionId: sessionRef().locator.sessionId,
      turnId: "turn-1",
      baselineLeafId: null,
      baselineStats: { tc: 0, i: 0, o: 0, cr: 0, cw: 0 },
    },
  };
}

async function publicSchema() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCcMcpServer({ runtimeFactory: () => ({}) });
  const client = new Client({ name: "pi-generation-test", version: "1.0.0" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.find((tool) => tool.name === "spawn_agent");
  } finally {
    await client.close();
    await server.close();
  }
}

describe("Pi public generation admission", () => {
  it("admits exactly Pi and exposes its closed route schema", async () => {
    assert.deepEqual([...ADMITTED_DRIVER_V2_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    assert.deepEqual([...ADMITTED_GENERATION_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    assert.deepEqual([...ADMITTED_ROUTE_MODELS[PI_HARNESS_ID]], [...PI_MODELS]);
    assert.equal(PI_DRIVER_VERSION, resolveDriverV2(PI_HARNESS_ID).driverVersion);
    assert.equal(harnessExecutionLifecycle(PI_HARNESS_ID), "version_three_worker");
    const spawn = await publicSchema();
    assert.deepEqual(spawn.inputSchema.properties.harness.enum, ["claude-code", "opencode", "pi"]);
    assert.equal(PI_MODELS.every((model) => spawn.inputSchema.properties.model.enum.includes(model)), true);
    assert.deepEqual(spawn.inputSchema.properties.reasoning_effort.enum, ["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("Pi public generation v3 dispatch", () => {
  it("keeps follow-up and interrupt on the v3 worker path", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput());
    const store = context.runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    const attemptId = context.launches[0].attemptId;
    recordVersionThreeTurnRunning({
      generation: FUTURE_WRITE_GENERATION,
      ownerRootId: context.ownerRootId,
      agentId: agent.agentId,
      jobId: agent.activeJobId,
      attemptId,
      workspaceRoot: agent.workspaceRoot,
      route: agent.route,
      nativeTurnRef: turnRef(),
    });
    const followup = await context.runtime.followupTask({ target: receipt.agent_name, message: "continue on the active turn" });
    assert.equal(followup.delivery, "activation_pending");
    const sent = context.runtime.sendMessage({ target: receipt.agent_name, message: "durable active input" });
    assert.equal(sent.delivery, "activation_pending");
    const interrupt = await context.runtime.interruptAgent({ target: receipt.agent_name });
    assert.equal(interrupt.status, "still_working");
    assert.equal(listControlCommands({ ownerRootId: context.ownerRootId, agentId: agent.agentId, jobId: agent.activeJobId }).some((command) => command.kind === "interrupt"), true);
    const quiesced = store.quiesceVersionThreeTurn(agent.agentId, agent.activeJobId, { attemptId });
    assert.equal(quiesced.quiesced, true);
    const steered = store.listMessages(agent.agentId).find((message) => message.text === "continue on the active turn");
    assert.equal(steered.state, "queued");
    assert.equal(steered.assignedJobId, null);
    assert.equal(store.listMessages(agent.agentId).find((message) => message.text === "durable active input").state, "queued");
    assert.equal(context.launches.length, 1);
  });

  it("requires explicit effort for each new Pi turn", async () => {
    const context = setup();
    await assert.rejects(context.runtime.spawnAgent(spawnInput({ reasoning_effort: undefined })), /explicit effort/);
    assert.equal(context.launches.length, 0);
    const receipt = await context.runtime.spawnAgent(spawnInput({ task_name: "pi_effort" }));
    const store = context.runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    store.updateAgent(agent.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    const messageCount = store.listMessages(agent.agentId).length;
    await assert.rejects(
      context.runtime.followupTask({ target: receipt.agent_name, message: "missing effort" }),
      /explicit effort/,
    );
    assert.equal(store.listMessages(agent.agentId).length, messageCount);
    assert.equal(context.launches.length, 1);
  });

  it("serializes the same exact Pi session while admitting a distinct session", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput());
    const route = context.runtime.versionThreeStore().resolveTarget(receipt.agent_name).route;
    const common = { ownerRootId: context.ownerRootId, route, harnessId: PI_HARNESS_ID, instanceKey: "pi-local" };
    const first = acquireNativeSessionLease({ ...common, agentId: "lease-a", jobId: "job-a", nativeSessionId: sessionRef().locator.sessionId });
    assert.ok(first.key);
    assert.throws(
      () => acquireNativeSessionLease({ ...common, agentId: "lease-b", jobId: "job-b", nativeSessionId: sessionRef().locator.sessionId }),
      /capacity exhausted/,
    );
    const distinct = acquireNativeSessionLease({ ...common, agentId: "lease-c", jobId: "job-c", nativeSessionId: "223e4567-e89b-42d3-a456-426614174001" });
    assert.ok(distinct.key);
  });

  it("carries the persisted exact UUID session into the next v3 launch and keeps history async", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput());
    const store = context.runtime.versionThreeStore();
    const ref = sessionRef();
    const agent = store.resolveTarget(receipt.agent_name);
    store.updateAgent(agent.agentId, (current) => ({
      ...current,
      activeJobId: null,
      status: "completed",
    }));
    const historyPromise = context.runtime.readAgentMessages({ target: receipt.agent_name, limit: 1 });
    assert.equal(historyPromise instanceof Promise, true);
    await assert.rejects(
      historyPromise,
      /has no proven native session history/,
    );
    assert.equal(context.launches.length, 1);
    store.updateAgent(agent.agentId, (current) => ({
      ...current,
      nativeSessionRef: ref,
      continuation: { mode: "exact_session", evidence: { reason: "driver_proven_exact_resume", nativeSessionRef: ref } },
    }));
    const followup = await context.runtime.followupTask({ target: receipt.agent_name, message: "resume exactly", reasoning_effort: "medium" });
    assert.equal(followup.agent_name, receipt.agent_name);
    assert.equal(context.launches.length, 2);
    assert.deepEqual(context.launches[1].sessionAtLaunch, ref);
  });
});
