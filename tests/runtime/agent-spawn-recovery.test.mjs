/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { claudeCodeInstanceKey } from "../../runtime/claude-code-driver.mjs";
import { acceptDriverRoute, resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { ROUTE_CAPABILITY_SCHEMA_VERSION } from "../../runtime/harness-capabilities.mjs";
import {
  CODEX_SANDBOX_META_KEY,
  createCcMcpServer,
  invokeIsolatedRuntimeOperation,
  redactMcpErrorMessage,
} from "../../runtime/mcp-server.mjs";
import { HARNESSDOCK_MCP_API_GENERATION } from "../../runtime/mcp-api.mjs";
import { listStoredJobs } from "../../runtime/job-store.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";

const roots = [];
const sharedRuntimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-spawn-recovery-home-"));
const sharedCodexHome = path.join(sharedRuntimeHome, "codex-home");

after(() => fs.rmSync(sharedRuntimeHome, { recursive: true, force: true }));
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup({ abortSignal = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-spawn-recovery-"));
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  roots.push(root);
  const env = {
    CODEX_THREAD_ID: `spawn-recovery-${process.pid}-${roots.length}`,
    CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
    CODEX_HOME: sharedCodexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
  const runtime = createAgentRuntime({ cwd: workspace, envFile, env, abortSignal });
  return { runtime, workspace, env };
}

function seamRouteInspection(runtime) {
  runtime.jobs.inspectRouteInstance = async (harnessId) => {
    const driver = resolveDriverV2(harnessId, { env: runtime.jobs.env });
    const models = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"];
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
  return runtime;
}

function spawnInput(overrides = {}) {
  return {
    task_name: "recovery_agent",
    message: "Do not leak this prompt.",
    harness: "claude-code",
    model: "claude-sonnet-5",
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
    ...overrides,
  };
}

async function mcpClientFor(runtime) {
  const server = createCcMcpServer({ runtimeFactory: () => ({
    spawn_agent: runtime.spawnAgent.bind(runtime),
  }) });
  const client = new Client({ name: "spawn-recovery-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("singular spawn cancellation boundaries", () => {
  it("stops before route inspection when the caller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runtime, workspace } = setup({ abortSignal: controller.signal });
    let inspections = 0;
    runtime.jobs.inspectRouteInstance = async () => {
      inspections += 1;
      throw new Error("route inspection must not run after cancellation");
    };

    await assert.rejects(
      runtime.spawnAgent(spawnInput()),
      (error) => error?.name === "AbortError" && /cancelled/i.test(error.message),
    );
    assert.equal(inspections, 0);
    assert.deepEqual(runtime.store.listAgents(), []);
    assert.deepEqual(listStoredJobs(workspace), []);
  });

  it("stops after route inspection but before readiness or reservation", async () => {
    const controller = new AbortController();
    const { runtime, workspace } = setup({ abortSignal: controller.signal });
    seamRouteInspection(runtime);
    const inspect = runtime.jobs.inspectRouteInstance;
    runtime.jobs.inspectRouteInstance = async (harnessId) => {
      const observed = await inspect(harnessId);
      controller.abort();
      return observed;
    };
    runtime.jobs.assertReady = () => {
      throw new Error("readiness must not run after cancellation");
    };

    await assert.rejects(
      runtime.spawnAgent(spawnInput({ task_name: "route_cancelled" })),
      (error) => error?.name === "AbortError" && /cancelled/i.test(error.message),
    );
    assert.deepEqual(runtime.store.listAgents(), []);
    assert.deepEqual(listStoredJobs(workspace), []);
  });

  it("rolls back a reservation when cancellation wins before detached launch", async () => {
    const controller = new AbortController();
    const { runtime, workspace } = setup({ abortSignal: controller.signal });
    seamRouteInspection(runtime);
    runtime.jobs.assertReady = () => ({
      ready: true,
      availability: { available: true },
      compatibility: { staticCompatible: true, fingerprint: "test", executable: process.execPath, version: "test" },
      auth: { loggedIn: true },
      cwd: runtime.jobs.cwd,
      claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR,
      sourceRoot: runtime.jobs.sourceRoot,
    });
    const attach = runtime.jobs.attachPreparedStart.bind(runtime.jobs);
    let launches = 0;
    runtime.jobs.attachPreparedStart = (prepared, agentId) => {
      const attached = attach(prepared, agentId);
      controller.abort();
      return attached;
    };
    runtime.jobs.launchPreparedStart = async () => {
      launches += 1;
      throw new Error("detached launch must not run after cancellation");
    };

    await assert.rejects(
      runtime.spawnAgent(spawnInput({ task_name: "reservation_cancelled" })),
      (error) => error?.name === "AbortError" && /cancelled/i.test(error.message),
    );
    assert.equal(launches, 0);
    assert.deepEqual(runtime.store.listAgents(), []);
    assert.deepEqual(listStoredJobs(workspace), []);
  });
});

describe("non-rollback-safe spawn error projection", () => {
  it("keeps a version-three Agent and exposes ownership uncertainty after launch begins", async () => {
    const controller = new AbortController();
    const { runtime } = setup({ abortSignal: controller.signal });
    const driver = createFakeServiceDriver().driver;
    const inspection = (await driver.inspectInstances({ env: {} }))[0];
    const acceptedRoute = acceptDriverRoute(driver, {
      harnessId: driver.harnessId,
      model: "standard-tier",
      topology: "leaf",
      authority: "behavioral_read_only",
      effort: "high",
    }, [inspection]).route;
    const route = { ...acceptedRoute, capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION };
    runtime.jobs.launchVersionThreeWorker = async () => {
      controller.abort();
      throw Object.assign(new Error("raw provider /tmp/private"), {
        handoffDisposition: "ownership_uncertain",
      });
    };

    await assert.rejects(
      runtime.spawnVersionThreeAgent({
        accepted: { driver, inspection, route },
        taskName: "v3_uncertain",
        description: null,
        message: "Do not leak this version-three prompt.",
        jobId: "hd-agent-v3-uncertain",
        turnOptions: { effort: route.effort },
        executionRoot: runtime.cwd,
      }),
      (error) => {
        assert.deepEqual(error.publicRecovery, {
          agent_name: "/root/v3_uncertain",
          outcome: "ownership_uncertain",
          code: "spawn_ownership_uncertain",
          message: "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
        });
        return true;
      },
    );
    const agent = runtime.versionThreeStore().resolveTarget("/root/v3_uncertain");
    assert.equal(agent.activeJobId, "hd-agent-v3-uncertain");
  });

  it("returns only the bounded public recovery fields through MCP", async () => {
    const { runtime } = setup();
    seamRouteInspection(runtime);
    runtime.jobs.assertReady = () => ({
      ready: true,
      availability: { available: true },
      compatibility: { staticCompatible: true, fingerprint: "test", executable: process.execPath, version: "test" },
      auth: { loggedIn: true },
      cwd: runtime.jobs.cwd,
      claudeConfigDir: runtime.jobs.env.CLAUDE_CONFIG_DIR,
      sourceRoot: runtime.jobs.sourceRoot,
    });
    runtime.jobs.launchPreparedStart = async () => {
      throw Object.assign(
        new Error(`provider leaked /data/private/job-123`),
        { handoffDisposition: "lifecycle_owned" },
      );
    };
    const { client, server } = await mcpClientFor(runtime);
    try {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: spawnInput({ task_name: "owned_failure" }),
        _meta: {
          threadId: runtime.ownerRootId,
          [CODEX_SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(runtime.cwd).href },
        },
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        agent_name: "/root/owned_failure",
        outcome: "lifecycle_owned",
        code: "spawn_lifecycle_owned",
        message: "Agent launch ownership was transferred; join the named Agent to reconcile its turn.",
      });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("preserves structured recovery fields through the isolated worker without raw error text", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-spawn-recovery-worker-"));
    roots.push(directory);
    const moduleFile = path.join(directory, "runtime.mjs");
    fs.writeFileSync(moduleFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createAgentRuntime() {
  return { spawn_agent() {
    const error = new Error("raw provider /data/secret prompt do-not-leak");
    error.publicRecovery = {
      agent_name: "/root/worker_owned",
      outcome: "ownership_uncertain",
      code: "spawn_ownership_uncertain",
      message: "raw provider /data/secret prompt do-not-leak"
    };
    throw error;
  } };
}
`);
    await assert.rejects(
      invokeIsolatedRuntimeOperation({
        operation: "spawn_agent",
        input: spawnInput({ task_name: "worker_owned" }),
        context: { cwd: process.cwd(), envFile: path.join(process.cwd(), "config", "runtime.env"), env: {} },
        runtimeModuleUrl: pathToFileURL(moduleFile),
      }),
      (error) => {
        assert.deepEqual(error.publicRecovery, {
          agent_name: "/root/worker_owned",
          outcome: "ownership_uncertain",
          code: "spawn_ownership_uncertain",
          message: "Agent launch ownership is uncertain; use the named Agent to reconcile its turn.",
        });
        assert.equal(error.message.includes("raw provider"), false);
        assert.equal(error.message.includes("/data/secret"), false);
        return true;
      },
    );
  });

  it("drops malformed recovery fields instead of inventing a rollback-safe outcome", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-spawn-recovery-invalid-"));
    roots.push(directory);
    const moduleFile = path.join(directory, "runtime.mjs");
    fs.writeFileSync(moduleFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createAgentRuntime() {
  return { spawn_agent() {
    const error = new Error("bad provider /data/secret");
    error.publicRecovery = {
      agent_name: "/root/private",
      outcome: "ownership_uncertain",
      code: "untrusted_provider_code",
      message: "raw"
    };
    throw error;
  } };
}
`);
    await assert.rejects(
      invokeIsolatedRuntimeOperation({
        operation: "spawn_agent",
        input: spawnInput({ task_name: "invalid_recovery" }),
        context: { cwd: process.cwd(), envFile: path.join(process.cwd(), "config", "runtime.env"), env: {} },
        runtimeModuleUrl: pathToFileURL(moduleFile),
      }),
      (error) => {
        assert.equal(error.publicRecovery, undefined);
        assert.equal(error.message.includes("/data/secret"), false);
        assert.equal(error.message.includes("rollback_safe"), false);
        return true;
      },
    );
  });

  it("redacts representative duplicate-name errors in the worker projection", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-spawn-recovery-duplicate-"));
    roots.push(directory);
    const moduleFile = path.join(directory, "runtime.mjs");
    fs.writeFileSync(moduleFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createAgentRuntime() {
  return { spawn_agent() {
    throw new Error("Agent name \\\"same\\\" already belongs to /root/same (agent-mabc-PRIVATE) at /data/private/state.json");
  } };
}
`);
    await assert.rejects(
      invokeIsolatedRuntimeOperation({
        operation: "spawn_agent",
        input: spawnInput({ task_name: "duplicate_name" }),
        context: { cwd: process.cwd(), envFile: path.join(process.cwd(), "config", "runtime.env"), env: {} },
        runtimeModuleUrl: pathToFileURL(moduleFile),
      }),
      (error) => {
        assert.match(error.message, /already belongs to \/root\/same/i);
        assert.equal(error.message.includes("agent-mabc-PRIVATE"), false);
        assert.equal(error.message.includes("/data/private"), false);
        return true;
      },
    );
  });
});

describe("MCP recovery redaction", () => {
  it("retains the public duplicate name while removing internal identifiers and paths", () => {
    const message = redactMcpErrorMessage(
      "Agent name \"same\" already belongs to /root/same (agent-mabc-PRIVATE), " +
      "internal job job-123 session session-456 instance instance-789 at /data/private/prompt.txt",
    );
    assert.match(message, /already belongs to \/root\/same/i);
    assert.equal(message.includes("agent-mabc-PRIVATE"), false);
    assert.equal(message.includes("job-123"), false);
    assert.equal(message.includes("session-456"), false);
    assert.equal(message.includes("instance-789"), false);
    assert.equal(message.includes("/data/private"), false);
  });
});
