/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 7.1/7.2/7.4: the public runtime seam is Harness-neutral, the Driver
 * registry is static, no generic or version-three path carries a Harness
 * default, model-facing input can never select an implementation, a
 * `DriverScope` is least-authority, and the current `codex_harnessdock` MCP
 * discovery generation is unchanged.
 *
 * Everything here is a contract test. Nothing in this file starts a native
 * turn, writes version-three state, or touches Skill guidance.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import * as publicRuntime from "../../runtime/index.mjs";
import { createAgentRuntime } from "../../runtime/index.mjs";
import { HARNESSDOCK_MCP_API_GENERATION } from "../../runtime/mcp-api.mjs";
import {
  HARNESSDOCK_MCP_TOOL_NAMES,
  createCcMcpServer,
  invokeIsolatedRuntimeOperation,
} from "../../runtime/mcp-server.mjs";
import * as registry from "../../runtime/harness-registry.mjs";
import {
  acceptDriverRoute,
  assertNoAmbientHarnessSelector,
  assertNoHarnessImplementationSelector,
  createDriverScope,
  inspectDriverInstances,
  resolveDriverV2,
  resolveHarnessDriver,
} from "../../runtime/harness-registry.mjs";
import { createAgentStore } from "../../runtime/agent-store.mjs";
import { listStoredJobs } from "../../runtime/job-store.mjs";
import { CLAUDE_CODE_CAPABILITIES } from "../../runtime/claude-code-driver.mjs";
import { createInternalAgentRuntime } from "../../runtime/internal-runtime.mjs";
import { CLAUDE_LEGACY_HARNESS_ID } from "../../runtime/claude-legacy-adapter.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { acquireWorkspaceWriterLease } from "../../runtime/workspace-writer-lease.mjs";
import { enqueueControlCommand } from "../../runtime/turn-control.mjs";
import { launchVersionThreeTurn } from "../../runtime/v3-worker-launch.mjs";
import { runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const runtimeDirectory = path.join(repositoryRoot, "runtime");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-task7-neutrality-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * The public operations of the current generation. The multi-Harness generation
 * added `list_harnesses`; the seam itself stays the sole lifecycle surface.
 */
const PUBLIC_OPERATIONS = Object.freeze([
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "list_harnesses",
  "read_agent_messages",
  "send_message",
  "spawn_agent",
  "wait_agent",
]);

const discoveryFixture = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, "tests", "runtime", "fixtures", "harnessdock-mcp-discovery.json"),
  "utf8"
));

/**
 * One runtime home for the whole file: runtime path ownership is process-wide,
 * so two homes in one process would be refused by the state owner itself.
 */
const RUNTIME_HOME = path.join(root, "runtime-home");

function runtimeOptions(label) {
  return {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_THREAD_ID: `task7-${label}`,
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: `task7-${label}`,
      CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
      CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: path.join(repositoryRoot, "config", "runtime.env"),
    },
  };
}

/** Every runtime module a Harness-neutral or version-three owner lives in. */
const GENERIC_AND_V3_MODULES = Object.freeze([
  "agent-runtime.mjs",
  "agent-store.mjs",
  "completion-inbox.mjs",
  "durable-state-v3.mjs",
  "harness-capabilities.mjs",
  "harness-contract.mjs",
  "harness-registry.mjs",
  "index.mjs",
  "instance-admission-lease.mjs",
  "internal-runtime.mjs",
  "job-store.mjs",
  "launch-claim.mjs",
  "native-reference.mjs",
  "turn-control.mjs",
  "turn-settlement.mjs",
  "v3-job-store.mjs",
  "v3-turn-reconciliation.mjs",
  "v3-worker-launch.mjs",
  "v3-worker-loop.mjs",
  "workspace-writer-lease.mjs",
]);

describe("Task 7.1 — the neutral public runtime factory", () => {
  it("exports createAgentRuntime() as the only public factory", () => {
    assert.equal(typeof publicRuntime.createAgentRuntime, "function");
    assert.deepEqual(
      Object.keys(publicRuntime).sort(),
      ["HARNESSDOCK_MCP_API_GENERATION", "createAgentRuntime"]
    );
  });

  it("no longer exports the Claude-named compatibility alias", () => {
    // The alias existed for one generation so a checkout discovered before the
    // neutral name could keep serving. The physical rename ends that window:
    // every caller is checkout-owned and moves in the same pass.
    assert.equal(Object.hasOwn(publicRuntime, "createClaudeRuntime"), false);
  });

  it("returns exactly the frozen public operations", () => {
    const neutral = createAgentRuntime(runtimeOptions("neutral"));
    assert.deepEqual(Object.keys(neutral).sort(), PUBLIC_OPERATIONS);
    assert.equal(Object.isFrozen(neutral), true);
    for (const operation of PUBLIC_OPERATIONS) {
      assert.equal(typeof neutral[operation], "function");
    }
  });

  it("keeps runtime/index.mjs the sole lifecycle seam: no store, supervisor, Driver, or registry escapes", () => {
    for (const forbidden of [
      "createAgentStore",
      "createInternalAgentRuntime",
      "resolveHarnessDriver",
      "resolveDriverV2",
      "createDriverScope",
      "launchVersionThreeTurn",
      "runVersionThreeWorkerLoop",
      "acquireInstanceLease",
      "AgentRuntime",
      "InternalAgentRuntime",
      "createClaudeRuntime",
    ]) {
      assert.equal(
        Object.hasOwn(publicRuntime, forbidden),
        false,
        `runtime/index.mjs must not export ${forbidden}`
      );
    }
    const source = fs.readFileSync(path.join(runtimeDirectory, "index.mjs"), "utf8");
    assert.doesNotMatch(source, /export\s+\*/);
  });

  it("routes internal callers through the neutral name and refuses a checkout that only exports the retired alias", async () => {
    assert.doesNotMatch(
      fs.readFileSync(path.join(runtimeDirectory, "cli.mjs"), "utf8"),
      /createClaudeRuntime/,
      "runtime/cli.mjs must call the neutral factory"
    );

    const directory = fs.mkdtempSync(path.join(root, "worker-"));
    const context = {
      cwd: repositoryRoot,
      envFile: path.join(repositoryRoot, "config", "runtime.env"),
      env: {},
    };
    const neutralFile = path.join(directory, "neutral-runtime.mjs");
    fs.writeFileSync(neutralFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createAgentRuntime() {
  return { list_agents() { return { factory: "createAgentRuntime" }; } };
}
`);
    assert.deepEqual(
      await invokeIsolatedRuntimeOperation({
        operation: "list_agents",
        input: {},
        context,
        runtimeModuleUrl: pathToFileURL(neutralFile),
      }),
      { factory: "createAgentRuntime" }
    );

    // The retired alias is no longer a fallback. A checkout exporting only the
    // Claude-named factory is not a runtime this generation can serve, and it
    // must say so rather than silently resolving a second surface.
    const legacyFile = path.join(directory, "legacy-runtime.mjs");
    fs.writeFileSync(legacyFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createClaudeRuntime() {
  return { list_agents() { return { factory: "createClaudeRuntime" }; } };
}
`);
    await assert.rejects(
      invokeIsolatedRuntimeOperation({
        operation: "list_agents",
        input: {},
        context,
        runtimeModuleUrl: pathToFileURL(legacyFile),
      }),
      /does not export createAgentRuntime/
    );
  });
});

describe("Task 7.4 — current codex_harnessdock MCP discovery stays generation-compatible", () => {
  it("advertises the frozen tool names, input schemas, and annotations", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({
      runtimeFactory: () => Object.fromEntries(
        HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [name, () => ({})])
      ),
    });
    const client = new Client({ name: "task7-discovery", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), HARNESSDOCK_MCP_TOOL_NAMES);
      const observed = listed.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }));
      assert.deepEqual(observed, discoveryFixture.tools);
      for (const tool of listed.tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.description.length > 0);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps the public MCP API generation unchanged by this change", () => {
    assert.equal(HARNESSDOCK_MCP_API_GENERATION, discoveryFixture.generation);
  });
});

describe("Task 7.2 — no generic or version-three path carries a Harness default", () => {
  it("removes DEFAULT_HARNESS_ID from the registry surface", () => {
    assert.equal(Object.hasOwn(registry, "DEFAULT_HARNESS_ID"), false);
  });

  it("leaves the identifier itself only in the Claude legacy adapter", () => {
    const owners = fs.readdirSync(runtimeDirectory)
      .filter((name) => name.endsWith(".mjs"))
      .filter((name) => fs.readFileSync(path.join(runtimeDirectory, name), "utf8").includes("DEFAULT_HARNESS_ID"));
    assert.deepEqual(owners, []);
    for (const name of GENERIC_AND_V3_MODULES) {
      const source = fs.readFileSync(path.join(runtimeDirectory, name), "utf8");
      assert.doesNotMatch(source, /DEFAULT_HARNESS_ID/, `${name} must not name a Harness default`);
    }
  });

  it("refuses an unstated Harness at every registry resolution", () => {
    for (const missing of [undefined, null, "", "   "]) {
      assert.throws(() => resolveHarnessDriver(missing, { env: {} }), /explicit|non-empty|Harness/i);
      assert.throws(() => resolveDriverV2(missing, { env: {} }), /explicit|non-empty|Harness/i);
    }
  });

  it("refuses an unstated Harness at the internal runtime Driver resolver", () => {
    const runtime = createInternalAgentRuntime(runtimeOptions("driver-for-harness"));
    assert.throws(() => runtime.driverForHarness(), /explicit|non-empty|Harness/i);
    assert.throws(() => runtime.driverForHarness(null), /explicit|non-empty|Harness/i);
    assert.equal(
      runtime.driverForHarness(CLAUDE_LEGACY_HARNESS_ID).harnessId,
      CLAUDE_LEGACY_HARNESS_ID
    );
  });

  it("refuses an unstated Harness at turn preparation, before readiness or any durable write", () => {
    const workspaceRoot = path.join(root, "prepare-start-workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = RUNTIME_HOME;
    const runtime = createInternalAgentRuntime({
      ...runtimeOptions("prepare-start"),
      cwd: workspaceRoot,
    });
    assert.throws(
      () => runtime.prepareStart("must not prepare", { model: "sonnet" }),
      /explicit Harness/
    );
    // Nothing durable exists: the refusal is ahead of readiness and every write.
    assert.deepEqual(listStoredJobs(workspaceRoot), []);
  });

  it("requires an explicit canonical route on every version-three preparation, launch, lease, and control path", async () => {
    const ownerRootId = "root-task7-explicit";
    const agentId = "agent-task7-explicit";
    const jobId = "job-task7-explicit";
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = RUNTIME_HOME;
    const workspaceRoot = path.join(root, "explicit-route-workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    await assert.rejects(
      launchVersionThreeTurn({
        ownerRootId,
        agentId,
        jobId,
        attemptId: "attempt-1",
        driver: createFakeServiceDriver().driver,
        preparedTurn: {},
        preparedInput: "task",
        assignedMessageIds: ["m-1"],
        leaseBindings: [],
        workspaceRoot,
      }),
      /requires route|requires an explicit|route/i
    );

    await assert.rejects(
      runVersionThreeWorkerLoop({
        ownerRootId,
        agentId,
        jobId,
        attemptId: "attempt-1",
        driver: createFakeServiceDriver().driver,
        preparedTurn: {},
        preparedInput: "task",
        assignedMessageIds: ["m-1"],
        leaseBindings: [],
        workspaceRoot,
        cwd: workspaceRoot,
      }),
      /requires route|requires an explicit|route/i
    );

    assert.throws(
      () => acquireInstanceLease({
        ownerRootId,
        agentId,
        jobId,
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "explicit",
        capacityLimit: 1,
      }),
      /route/i
    );

    assert.throws(
      () => acquireWorkspaceWriterLease({ ownerRootId, agentId, jobId, workspaceRoot }),
      /route/i
    );

    assert.throws(
      () => enqueueControlCommand({
        ownerRootId,
        agentId,
        jobId,
        commandId: "command-1",
        kind: "interrupt",
        deadlineMs: 60_000,
      }),
      /route/i
    );
  });
});

describe("Task 7.1 — the current public generation stays inert on version two", () => {
  it("keeps a store that states no write generation on version two", () => {
    // The multi-Harness generation writes version-three Agents for an explicitly
    // stated route, and does so through a store that names that write generation
    // out loud. A store that states none is still the version-two generation, so
    // every legacy record and every caller that opens one is unchanged.
    const workspaceRoot = path.join(root, "public-generation-workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = RUNTIME_HOME;
    const store = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId: "root-public-generation",
      claudeConfigDir: path.join(root, "public-generation-config"),
      harness: {
        harnessId: CLAUDE_LEGACY_HARNESS_ID,
        driverVersion: "claude-code@2",
        capabilities: CLAUDE_CODE_CAPABILITIES,
      },
    });
    const agent = store.createAgent({
      task_name: "public_generation_agent",
      selectedModel: "claude-sonnet-5",
      initialMessage: "bounded work",
    });
    assert.equal(agent.version, 2);
    assert.equal(Object.hasOwn(agent, "route") && agent.route?.driverVersion != null, false);
    assert.throws(
      () => store.createAgent({ task_name: "smuggled_v3", version: 3 }),
      /version-three/i
    );
  });
});

describe("Task 7.4 — the Driver registry stays static and in-tree", () => {
  it("resolves only checkout-owned Harness identities", () => {
    // Version one stays the Claude-only legacy contract; version two is where the
    // multi-Harness generation admits every checkout-owned Harness.
    assert.deepEqual([...registry.ADMITTED_HARNESS_IDS], [CLAUDE_LEGACY_HARNESS_ID]);
    assert.deepEqual(
      [...registry.ADMITTED_DRIVER_V2_HARNESS_IDS],
      [CLAUDE_LEGACY_HARNESS_ID, "opencode", "pi"],
    );
    assert.equal(Object.isFrozen(registry.ADMITTED_HARNESS_IDS), true);
    assert.equal(Object.isFrozen(registry.ADMITTED_DRIVER_V2_HARNESS_IDS), true);
    assert.throws(() => resolveHarnessDriver("opencode", { env: {} }), /Unknown Harness/);
    // An unadmitted Harness is still refused at both contract versions.
    assert.throws(() => resolveHarnessDriver("deepseek", { env: {} }), /Unknown Harness/);
    assert.throws(() => resolveDriverV2("deepseek", { env: {} }), /Unknown Harness/);
  });

  it("exposes no registration, loader, or evaluation seam", () => {
    const source = fs.readFileSync(path.join(runtimeDirectory, "harness-registry.mjs"), "utf8");
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /createRequire|require\s*\(|new Function|\beval\b|process\.binding/);
    assert.doesNotMatch(source, /export function (register|addDriver|installDriver|loadDriver)/);
    for (const name of Object.keys(registry)) {
      assert.doesNotMatch(name, /^(register|unregister|addDriver|removeDriver|loadDriver)/);
    }
  });

  it("refuses every model-facing implementation, instance, endpoint, and credential selector", () => {
    for (const key of [
      "harness_id", "harness_driver", "harness_module", "harness_executable",
      "harness_endpoint", "harness_instance", "driver", "driver_module", "driver_path",
      "driver_endpoint", "capability_override", "claude_bin", "claude_config_dir", "env_file",
      "settings_path", "endpoint", "base_url", "api_base", "service_url", "instance",
      "instance_key", "api_key", "auth_token", "access_token", "credentials",
    ]) {
      assert.throws(
        () => assertNoHarnessImplementationSelector({ [key]: "chosen" }, "spawn_agent"),
        new RegExp(key),
        `${key} must never select an implementation`
      );
    }
    // The one route decision a caller does state: which admitted Harness. It is
    // validated against the static table, never treated as an implementation.
    assert.doesNotThrow(() => assertNoHarnessImplementationSelector({ harness: "opencode" }, "spawn_agent"));
    for (const key of [
      "CODEX_HARNESSDOCK_HARNESS_ID", "CODEX_HARNESSDOCK_HARNESS_DRIVER", "CODEX_HARNESSDOCK_HARNESS_DRIVER_MODULE", "CODEX_HARNESSDOCK_HARNESS_DRIVER_PATH",
      "CODEX_HARNESSDOCK_HARNESS_CAPABILITIES", "CODEX_HARNESSDOCK_HARNESS_REGISTRY", "CODEX_HARNESSDOCK_HARNESS_ENDPOINT",
      "CODEX_HARNESSDOCK_HARNESS_INSTANCE", "CODEX_HARNESSDOCK_DRIVER_ENDPOINT",
    ]) {
      assert.throws(() => assertNoAmbientHarnessSelector({ [key]: "chosen" }), new RegExp(key));
    }
  });

  it("gives the public MCP schemas no selector to state one", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({
      runtimeFactory: () => Object.fromEntries(
        HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [name, () => ({})])
      ),
    });
    const client = new Client({ name: "task7-selector", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        assert.equal(tool.inputSchema.additionalProperties, false);
        for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
          // `harness` is the one route field a caller states, and it is a closed
          // enum of admitted Harness identities -- not an implementation,
          // endpoint, instance, module, or credential selector, none of which
          // any public schema publishes.
          if (property === "harness") {
            assert.deepEqual(tool.inputSchema.properties.harness.enum, ["claude-code", "opencode", "pi"]);
            continue;
          }
          assert.doesNotMatch(
            property,
            /harness|driver|instance|endpoint|base_url|api_base|service_url|credential|api_key|auth_token|access_token|module|config_dir|settings|executable/i,
            `${tool.name} must not publish selector ${property}`
          );
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Task 7.4 — DriverScope is a least-authority value", () => {
  const { driver } = createFakeServiceDriver();

  async function turnScope() {
    const inspections = await inspectDriverInstances(driver, createDriverScope({
      driver, purpose: "inspect", rootId: "root-scope", workspaceRoot: root, env: {},
    }));
    const { route } = acceptDriverRoute(driver, {
      harnessId: driver.harnessId,
      model: "fake-model",
      effort: "high",
      topology: "leaf",
      authority: "behavioral_read_only",
    }, inspections);
    return createDriverScope({
      driver,
      purpose: "turn",
      rootId: "root-scope",
      agentId: "agent-scope",
      turnId: "turn-scope",
      attemptId: "attempt-scope",
      route,
      taskInput: "bounded task",
      workspaceRoot: root,
      env: { OPENCODE_TOKEN: "secret", PATH: "/usr/bin" },
    });
  }

  it("refuses stores, the registry, MCP operations, other Drivers, and arbitrary environment", async () => {
    const scope = await turnScope();
    for (const property of [
      "store", "agentStore", "jobStore", "registry", "resolveHarnessDriver", "drivers",
      "mcp", "spawn_agent", "runtime", "process", "credentials", "secrets", "require",
    ]) {
      assert.throws(() => scope[property], /DriverScope does not expose/);
    }
    assert.throws(() => scope.env.PATH, /does not expose environment value/);
    assert.throws(() => scope.env.OPENCODE_TOKEN, /does not expose environment value/);
    assert.throws(() => { scope.route = null; }, /immutable/);
    assert.throws(() => { delete scope.taskInput; }, /immutable/);
  });

  it("never lets instance inspection see the turn it may later serve", () => {
    const scope = createDriverScope({
      driver, purpose: "inspect", rootId: "root-scope", workspaceRoot: root, env: {},
    });
    for (const property of ["route", "taskInput", "turnId", "attemptId", "assignedInputs", "turnOptions"]) {
      assert.throws(() => scope[property], /not available during instance inspection/);
    }
  });
});
