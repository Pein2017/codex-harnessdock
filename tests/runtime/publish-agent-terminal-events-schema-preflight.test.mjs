/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import {
  CODEX_SANDBOX_META_KEY,
  createCcMcpServer,
} from "../../runtime/mcp-server.mjs";
import { HARNESSDOCK_MCP_API_GENERATION } from "../../runtime/mcp-api.mjs";

const checkout = path.resolve(new URL("../../", import.meta.url).pathname);
const meta = {
  threadId: "terminal-events-schema-test",
  [CODEX_SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(checkout).href },
};
const closers = [];
const roots = [];
const sharedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-terminal-event-codex-home-"));
const sharedRuntimeHome = path.join(sharedCodexHome, "runtime-home");
process.on("exit", () => fs.rmSync(sharedCodexHome, { recursive: true, force: true }));

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function spawnInput(taskName = "descriptor_bound") {
  return {
    task_name: taskName,
    message: "exercise descriptor binding",
    harness: "claude-code",
    model: "claude-sonnet-5",
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
  };
}

function dispatchRow(taskName, descriptor) {
  return { ...spawnInput(taskName), terminal_event_descriptor_path: descriptor };
}

async function clientWithInvoker(calls) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCcMcpServer({
    runtimeInvoker: async ({ operation, input }) => {
      calls.push({ operation, input });
      if (operation === "spawn_agent") {
        return { agent_name: "/root/descriptor_bound", model: input.model, status: "working" };
      }
      return {
        rows: input.rows.map((row) => ({
          agent_name: `/root/${row.task_name}`,
          agent_exists: true,
          outcome: "launched",
          card: { agent_name: `/root/${row.task_name}`, model: row.model, status: "working" },
        })),
      };
    },
  });
  const client = new Client({ name: "terminal-events-schema-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(() => client.close(), () => server.close());
  return client;
}

describe("publish-agent-terminal-events strict public schema", () => {
  it("advertises the descriptor field in singular and batch schemas exactly once", async () => {
    const calls = [];
    const client = await clientWithInvoker(calls);
    const listed = await client.listTools();
    assert.equal(HARNESSDOCK_MCP_API_GENERATION, 11);

    const spawn = listed.tools.find((tool) => tool.name === "spawn_agent");
    assert.equal(spawn.inputSchema.properties.terminal_event_descriptor_path.type, "string");
    assert.equal(spawn.inputSchema.required.includes("terminal_event_descriptor_path"), false);
    assert.deepEqual(Object.keys(spawn.inputSchema.properties), [
      "task_name", "message", "description", "harness", "model", "topology", "write",
      "target_worktree", "reasoning_effort", "terminal_event_descriptor_path",
    ]);

    const dispatch = listed.tools.find((tool) => tool.name === "dispatch_agents");
    assert.equal(dispatch.inputSchema.properties.rows.items.properties.terminal_event_descriptor_path.type, "string");
    assert.equal(dispatch.inputSchema.properties.rows.items.required.includes("terminal_event_descriptor_path"), false);
    assert.deepEqual(Object.keys(dispatch.inputSchema.properties.rows.items.properties), [
      "task_name", "message", "description", "harness", "model", "topology", "write",
      "target_worktree", "reasoning_effort", "terminal_event_descriptor_path",
    ]);

    const followup = listed.tools.find((tool) => tool.name === "followup_task");
    assert.equal(Object.hasOwn(followup.inputSchema.properties, "terminal_event_descriptor_path"), false);
  });

  it("forwards row-local descriptors, keeps cards compact, and rejects relative or follow-up fields", async () => {
    const calls = [];
    const client = await clientWithInvoker(calls);
    const singular = {
      ...spawnInput(),
      terminal_event_descriptor_path: "/private/descriptor-a.json",
    };
    const singularResult = await client.callTool({
      name: "spawn_agent", arguments: singular, _meta: meta,
    });
    assert.deepEqual(calls[0], { operation: "spawn_agent", input: singular });
    assert.deepEqual(singularResult.structuredContent, {
      agent_name: "/root/descriptor_bound", model: "claude-sonnet-5", status: "working",
    });
    assert.equal(JSON.stringify(singularResult).includes("descriptor-a"), false);

    const rows = [
      dispatchRow("first_descriptor", "/private/descriptor-a.json"),
      dispatchRow("second_descriptor", "/private/descriptor-b.json"),
    ];
    const batch = await client.callTool({ name: "dispatch_agents", arguments: { rows }, _meta: meta });
    assert.deepEqual(calls[1], { operation: "dispatch_agents", input: { rows } });
    assert.deepEqual(batch.structuredContent.rows.map((row) => row.card), [
      { agent_name: "/root/first_descriptor", model: "claude-sonnet-5", status: "working" },
      { agent_name: "/root/second_descriptor", model: "claude-sonnet-5", status: "working" },
    ]);

    for (const [name, argumentsValue] of [
      ["spawn_agent", { ...spawnInput("relative_descriptor"), terminal_event_descriptor_path: "relative.json" }],
      ["dispatch_agents", { rows: [dispatchRow("relative_descriptor", "relative.json")] }],
      ["followup_task", {
        target: "/root/descriptor_bound",
        message: "must reject descriptor on continuation",
        terminal_event_descriptor_path: "/private/descriptor-a.json",
      }],
    ]) {
      const rejected = await client.callTool({ name, arguments: argumentsValue, _meta: meta });
      assert.equal(rejected.isError, true, name);
    }
    assert.equal(calls.length, 2, "strictly rejected inputs must not reach the runtime");
  });
});

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-terminal-event-preflight-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  const envFile = path.join(root, "runtime.env");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_HOME: sharedCodexHome,
      CODEX_THREAD_ID: "terminal-event-preflight",
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "terminal-event-preflight",
      CODEX_HARNESSDOCK_RUNTIME_HOME: sharedRuntimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  return { runtime, workspace };
}

function fakePublisherEnvironment(workspace, mode) {
  const root = path.dirname(workspace);
  const runtimeRoot = path.join(root, `wake-runtime-${mode}`);
  fs.mkdirSync(runtimeRoot);
  if (mode === "unavailable") {
    return {
      CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: path.join(root, "missing-publisher"),
      CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: runtimeRoot,
      HD_TEST_PUBLISHER_MODE: mode,
    };
  }
  const executable = path.join(root, `publisher-${mode}.mjs`);
  fs.writeFileSync(executable, `#!/usr/bin/env node
const mode = process.env.HD_TEST_PUBLISHER_MODE;
if (mode === "wrong_producer") {
  process.stdout.write(JSON.stringify({compatible:true, producer_task_id:"/root/another_agent", token_fingerprint:"fingerprint", reservation_id:"reservation"}));
  process.exit(0);
}
if (mode === "incompatible_runtime") {
  process.stdout.write(JSON.stringify({compatible:false, producer_task_id:"/root/preflight_matrix", token_fingerprint:"fingerprint", reservation_id:"reservation"}));
  process.exit(0);
}
process.stderr.write("descriptor rejected");
process.exit(2);
`);
  fs.chmodSync(executable, 0o700);
  return {
    CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN: executable,
    CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT: runtimeRoot,
    HD_TEST_PUBLISHER_MODE: mode,
  };
}

function acceptedRoute(witness) {
  return {
    driver: { prepareTurn: () => { witness.prepareCalls += 1; } },
    route: {
      harnessId: "claude-code",
      instanceKey: "claude-code-test",
      model: "claude-sonnet-5",
      effort: "high",
      topology: "leaf",
      authority: "behavioral_read_only",
      driverVersion: "test-driver",
      capabilitySchemaVersion: 4,
    },
  };
}

describe("publish-agent-terminal-events descriptor preflight", () => {
  it("rejects missing publisher configuration before Agent or model side effects", async () => {
    const { runtime } = runtimeFixture();
    const witness = { prepareCalls: 0, launchCalls: 0 };
    runtime.acceptStatedRoute = async () => acceptedRoute(witness);
    runtime.jobs.assertReady = () => ({ ready: true });
    runtime.versionThreeStore = () => ({
      createAgent: () => {
        witness.launchCalls += 1;
        throw new Error("unexpected model preparation");
      },
    });

    await assert.rejects(runtime.spawnAgent({
      ...spawnInput("missing_publisher"),
      terminal_event_descriptor_path: "/private/descriptor.json",
    }));
    assert.deepEqual(witness, { prepareCalls: 0, launchCalls: 0 });
  });

  it("rejects unavailable, unsafe, stale, wrong-producer, and incompatible preflight with zero Agent/model side effects", async () => {
    for (const mode of [
      "unavailable",
      "unsafe_descriptor",
      "stale_bearer",
      "wrong_producer",
      "incompatible_runtime",
    ]) {
      const { runtime, workspace } = runtimeFixture();
      Object.assign(runtime.jobs.env, fakePublisherEnvironment(workspace, mode));
      const witness = { prepareCalls: 0, launchCalls: 0 };
      runtime.acceptStatedRoute = async () => acceptedRoute(witness);
      runtime.jobs.assertReady = () => ({ ready: true });
      runtime.versionThreeStore = () => ({
        createAgent: () => {
          witness.launchCalls += 1;
          throw new Error("unexpected model preparation");
        },
      });

      await assert.rejects(runtime.spawnAgent({
        ...spawnInput("preflight_matrix"),
        terminal_event_descriptor_path: path.join(path.dirname(workspace), `${mode}.json`),
      }), undefined, mode);
      assert.deepEqual(witness, { prepareCalls: 0, launchCalls: 0 }, mode);
    }
  });

  it("stops the whole batch on descriptor preflight failure with no row launch", async () => {
    const { runtime } = runtimeFixture();
    const witness = { prepareCalls: 0, launchCalls: 0 };
    runtime.ensureDispatchHarness = async () => {};
    runtime.jobs.inspectRouteInstance = async () => ({ inspections: [] });
    runtime.acceptStatedRoute = async () => acceptedRoute(witness);
    runtime.launchDispatchRow = async () => { witness.launchCalls += 1; };

    const result = await runtime.dispatchAgents({ rows: [
      dispatchRow("batch_first", "/private/descriptor-a.json"),
      dispatchRow("batch_second", "/private/descriptor-b.json"),
    ] });
    assert.deepEqual(result.rows.map((row) => row.outcome), ["not_attempted", "not_attempted"]);
    assert.deepEqual(witness, { prepareCalls: 0, launchCalls: 0 });
  });
});
