import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { resolveAgentRegistryDirectory } from "../../runtime/agent-store.mjs";
import { createCcMcpServer } from "../../runtime/mcp-server.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import {
  ADMITTED_DRIVER_V2_HARNESS_IDS,
  ADMITTED_GENERATION_HARNESS_IDS,
  harnessExecutionLifecycle,
  resolveDriverV2,
} from "../../runtime/harness-registry.mjs";
import { PI_DRIVER_VERSION, PI_HARNESS_ID } from "../../runtime/pi-driver.mjs";
import { acquireInstanceLease, acquireNativeSessionLease } from "../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim } from "../../runtime/launch-claim.mjs";
import { recordVersionThreeTurnRunning } from "../../runtime/v3-job-store.mjs";
import { listControlCommands } from "../../runtime/turn-control.mjs";

const roots = [];
const PI_MODEL = "openai-codex/gpt-5.6-luna";
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
  delete env.PI_CODING_AGENT_DIR;
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
      routes: { models: [PI_MODEL], topologies: ["leaf"], interaction: "noninteractive_fixed_policy", effortsByModel: { [PI_MODEL]: ["medium", "high"] }, defaultsByModel: { [PI_MODEL]: "high" } },
      capabilityProvenance: Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "nativeProgress", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((name) => [name, "checkout_declared"])),
      inspectionGeneration: "unavailable",
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
    model: PI_MODEL,
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
    assert.equal(PI_DRIVER_VERSION, resolveDriverV2(PI_HARNESS_ID).driverVersion);
    assert.equal(harnessExecutionLifecycle(PI_HARNESS_ID), "version_three_worker");
    const spawn = await publicSchema();
    assert.deepEqual(spawn.inputSchema.properties.harness.enum, ["claude-code", "opencode", "pi"]);
    assert.equal(spawn.inputSchema.properties.model.type, "string");
    assert.equal(spawn.inputSchema.properties.reasoning_effort.type, "string");
  });
});

describe("Pi public generation v3 dispatch", () => {
  it("fails Agent admission closed when Pi reports multiple ready instances", async () => {
    const context = setup();
    const driver = resolveDriverV2(PI_HARNESS_ID, { env: {} });
    const routeFacts = { models: [PI_MODEL], topologies: ["leaf"], interaction: "noninteractive_fixed_policy", effortsByModel: { [PI_MODEL]: ["high"] }, defaultsByModel: { [PI_MODEL]: "high" } };
    context.runtime.jobs.inspectRouteInstance = async () => ({
      driver,
      inspections: ["pi-local-a", "pi-local-b"].map((instanceKey) => ({
        harnessId: PI_HARNESS_ID, instanceKey, readiness: "ready", liveValidated: true, maturity: "experimental", detailCode: "ready", routes: routeFacts,
        capabilityProvenance: Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "nativeProgress", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((name) => [name, "checkout_declared"])), inspectionGeneration: "unavailable",
      })),
    });
    await assert.rejects(context.runtime.spawnAgent(spawnInput({ task_name: "ambiguous_pi" })), /2 ready logical instances/);
    assert.equal(context.runtime.versionThreeStore().listAgents().length, 0);
  });

  it("keeps follow-up and interrupt on the v3 worker path", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput());
    assert.equal(receipt.inspection_generation, "unavailable");
    assert.deepEqual(receipt.capability_provenance, context.launches[0].inspectionEvidence.capabilities.provenance);
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

  it("rejects omitted effort and inherits the explicit route effort for each Pi turn", async () => {
    const context = setup();
    await assert.rejects(context.runtime.spawnAgent(spawnInput({ task_name: "pi_default", reasoning_effort: undefined })), /reasoning_effort/);
    const receipt = await context.runtime.spawnAgent(spawnInput({ task_name: "pi_effort" }));
    const store = context.runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    store.updateAgent(agent.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    const messageCount = store.listMessages(agent.agentId).length;
    await context.runtime.followupTask({ target: receipt.agent_name, message: "missing effort" });
    assert.equal(store.listMessages(agent.agentId).length, messageCount + 1);
    assert.equal(context.launches.length, 2);
  });

  it("revalidates only the immutable instance when other ready instances appear", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput({ task_name: "pi_instance_revalidation" }));
    const store = context.runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    const initial = await context.runtime.jobs.inspectRouteInstance(PI_HARNESS_ID);
    const own = initial.inspections[0];
    const ready = (instanceKey) => ({ ...own, instanceKey });
    context.runtime.jobs.inspectRouteInstance = async () => ({
      ...initial,
      inspections: [ready(agent.route.instanceKey), ready("pi-foreign")],
    });
    store.updateAgent(agent.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    await context.runtime.followupTask({ target: receipt.agent_name, message: "ignore the foreign ready instance" });
    assert.equal(context.launches.length, 2);
    assert.equal(context.launches[1].executionRoute.instanceKey, agent.route.instanceKey);

    store.updateAgent(agent.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    const beforeMessages = store.listMessages(agent.agentId).length;
    for (const inspections of [[], [ready(agent.route.instanceKey), ready(agent.route.instanceKey)]]) {
      context.runtime.jobs.inspectRouteInstance = async () => ({ ...initial, inspections });
      await assert.rejects(
        context.runtime.followupTask({ target: receipt.agent_name, message: "must not reserve without one matching instance" }),
        /exactly one current ready inspection/,
      );
      assert.equal(store.listMessages(agent.agentId).length, beforeMessages);
    }
  });

  it("revalidates a stored v2 Agent into a private v3 execution route without rewriting history", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput({ task_name: "pi_v2_forward" }));
    const store = context.runtime.versionThreeStore();
    const created = store.resolveTarget(receipt.agent_name);
    store.updateAgent(created.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    const registryPath = path.join(resolveAgentRegistryDirectory({
      cwd: created.workspaceRoot, ownerRootId: context.ownerRootId,
    }), "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const historical = registry.agents[created.agentId];
    const { provenance: _provenance, ...v2Capabilities } = historical.route.capabilities;
    historical.route = {
      ...historical.route,
      capabilitySchemaVersion: 2,
      capabilities: { ...v2Capabilities, capabilitySchemaVersion: 2 },
    };
    const historicalRoute = JSON.stringify(historical.route);
    fs.writeFileSync(registryPath, JSON.stringify(registry));

    await context.runtime.followupTask({ target: receipt.agent_name, message: "freshly revalidate this v2 route" });
    const launch = context.launches.at(-1);
    assert.equal(launch.executionRoute.capabilitySchemaVersion, 4);
    assert.deepEqual(launch.inspectionEvidence.capabilities, launch.executionRoute.capabilities);
    const after = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    assert.equal(JSON.stringify(after.agents[created.agentId].route), historicalRoute);

    const beforeMessages = store.listMessages(created.agentId).length;
    context.runtime.jobs.inspectRouteInstance = async () => ({
      driver: resolveDriverV2(PI_HARNESS_ID, { env: {} }),
      inspections: [{
        harnessId: PI_HARNESS_ID, instanceKey: "pi-local", readiness: "ready", liveValidated: true,
        maturity: "experimental", detailCode: "ready",
        routes: { models: [], topologies: ["leaf"], interaction: "noninteractive_fixed_policy", effortsByModel: {}, defaultsByModel: {} },
        capabilityProvenance: Object.fromEntries(["interaction", "activeInput", "continuation", "history", "interruptRequest", "turnObservation", "nativeProgress", "automaticRecovery", "authorityEnforcement", "leafEnforcement", "nativeOrchestration"].map((name) => [name, "checkout_declared"])),
        inspectionGeneration: `sha256:${"b".repeat(64)}`,
      }],
    });
    store.updateAgent(created.agentId, (current) => ({ ...current, activeJobId: null, status: "completed" }));
    await assert.rejects(
      context.runtime.followupTask({ target: receipt.agent_name, message: "must not enqueue a vanished tuple" }),
      /model|route|admit/i,
    );
    assert.equal(store.listMessages(created.agentId).length, beforeMessages);
  });

  it("carries the canonical effective effort through the real detached worker entry", async () => {
    const context = setup();
    const receipt = await context.runtime.spawnAgent(spawnInput({ task_name: "pi_worker_effort" }));
    const store = context.runtime.versionThreeStore();
    const agent = store.resolveTarget(receipt.agent_name);
    const launch = context.launches[0];
    const assignedMessageIds = store.listMessages(agent.agentId)
      .filter((message) => message.assignedJobId === agent.activeJobId)
      .map((message) => message.messageId);
    const lease = acquireInstanceLease({
      ownerRootId: context.ownerRootId,
      agentId: agent.agentId,
      jobId: agent.activeJobId,
      route: agent.route,
      harnessId: agent.route.harnessId,
      instanceKey: agent.route.instanceKey,
      capacityClass: "pi-v3-dispatch-test",
      capacityLimit: 1,
    });
    createLaunchClaim({
      ownerRootId: context.ownerRootId,
      agentId: agent.agentId,
      jobId: agent.activeJobId,
      attemptId: launch.attemptId,
      route: agent.route,
      leaseBindings: [lease],
      assignedMessageIds,
      preparedInput: "Inspect the repository.",
      turnOptions: { effort: "high" },
      inspectionEvidence: { generation: "unavailable", capabilities: agent.route.capabilities },
    });
    // This reaches the production runWorker -> runDetachedVersionThreeTurn
    // seam before any native operation; its stored Agent route is then made
    // semantically foreign to the claim's v3 execution route.
    const registryPath = path.join(resolveAgentRegistryDirectory({
      cwd: agent.workspaceRoot, ownerRootId: context.ownerRootId,
    }), "registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const stored = registry.agents[agent.agentId];
    const { provenance: _provenance, ...v2Capabilities } = stored.route.capabilities;
    stored.route = {
      ...stored.route,
      capabilitySchemaVersion: 2,
      capabilities: {
        ...v2Capabilities,
        capabilitySchemaVersion: 2,
        maturity: { ...v2Capabilities.maturity, continuation: "validated" },
      },
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    await assert.rejects(
      context.runtime.jobs.runWorker(agent.activeJobId, { agentId: agent.agentId, attemptId: launch.attemptId }),
      /route identity does not semantically derive/,
    );
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
    const followup = await context.runtime.followupTask({ target: receipt.agent_name, message: "resume exactly" });
    assert.equal(followup.agent_name, receipt.agent_name);
    assert.equal(context.launches.length, 2);
    assert.deepEqual(context.launches[1].sessionAtLaunch, ref);
  });
});
