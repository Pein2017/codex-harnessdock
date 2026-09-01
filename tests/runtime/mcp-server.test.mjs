import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  HARNESSDOCK_MCP_TOOL_NAMES,
  HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT,
  HARNESSDOCK_MCP_HOST_PROJECTION_CHAR_RESERVE,
  CODEX_SANDBOX_META_KEY,
  createCcMcpServer,
  invokeIsolatedRuntimeOperation,
  mcpExposedDescriptionCharacters,
  mcpProjectedModelVisibleCharacters,
  modelFacingReceipt,
  redactMcpErrorMessage,
} from "../../runtime/mcp-server.mjs";
import { HARNESSDOCK_MCP_API_GENERATION } from "../../runtime/mcp-api.mjs";
import { PACKAGE_VERSION } from "../../runtime/version.mjs";

const root = path.resolve(new URL("../../", import.meta.url).pathname);
const pluginRoot = path.join(root, "plugins", "codex-harnessdock");
const meta = {
  threadId: "mcp-test-thread",
  [CODEX_SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(root).href },
};

function descriptionCharacters(value) {
  if (!value || typeof value !== "object") return 0;
  return (typeof value.description === "string" ? value.description.length : 0)
    + Object.values(value).reduce((total, nested) => total + descriptionCharacters(nested), 0);
}

function runtimeMethods(handler) {
  return Object.fromEntries(HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [name, (input) => handler(name, input)]));
}

function payloadOf(result) {
  assert.equal(Object.hasOwn(result, "structuredContent"), false, "MCP result must not duplicate its text payload");
  return JSON.parse(result.content[0].text);
}

async function inMemoryClient(runtimeFactory) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCcMcpServer({ runtimeFactory });
  const client = new Client({ name: "hd-mcp-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const closers = [];
const temporaryDirectories = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("typed HarnessDock MCP server", () => {
  it("keeps the idle MCP frontend outside Driver implementation imports", () => {
    const frontendSource = fs.readFileSync(new URL("../../runtime/mcp-server.mjs", import.meta.url), "utf8");
    const apiSource = fs.readFileSync(new URL("../../runtime/mcp-api.mjs", import.meta.url), "utf8");

    assert.equal(/from\s+["']\.\/harness-registry\.mjs["']/u.test(frontendSource), false,
      "mcp-server must not import harness-registry");
    assert.equal(/from\s+["']\.\/[^"']*-driver\.mjs["']/u.test(frontendSource), false,
      "mcp-server must not import a Driver module");
    assert.equal(/^\s*import\s/mu.test(apiSource), false, "mcp-api must remain import-free");
  });

  it("advertises exactly the canonical typed tools", async () => {
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => ({})));
    closers.push(() => client.close(), () => server.close());
    const listed = await client.listTools();
    const expectedToolNames = [
      "list_harnesses",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "list_agents",
      "read_agent_messages",
      "dispatch_agents",
    ];
    assert.equal(client.getServerVersion()?.version, PACKAGE_VERSION);
    assert.equal(HARNESSDOCK_MCP_API_GENERATION, 11);
    assert.deepEqual(HARNESSDOCK_MCP_TOOL_NAMES, expectedToolNames);
    assert.equal(listed.tools.length, 9);
    assert.deepEqual(listed.tools.map((tool) => tool.name), expectedToolNames);
    for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false);
    const listAgents = listed.tools.find((tool) => tool.name === "list_agents");
    assert.deepEqual(listAgents.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const spawn = listed.tools.find((tool) => tool.name === "spawn_agent");
    assert.deepEqual(new Set(spawn.inputSchema.required), new Set(["task_name", "message", "harness", "model", "reasoning_effort", "topology", "write"]));
    assert.equal(Object.hasOwn(spawn.inputSchema.properties, "fork_turns"), false);
    assert.equal(Object.hasOwn(spawn.inputSchema.properties, "execution_profile"), false);
    assert.equal(Object.hasOwn(spawn.inputSchema.properties, "allowed_tools"), false);
    assert.equal(Object.hasOwn(spawn.inputSchema.properties, "delegation_mode"), false);
    assert.deepEqual(Object.keys(spawn.inputSchema.properties), [
      "task_name", "message", "description", "harness", "model", "topology", "write", "target_worktree", "reasoning_effort", "terminal_event_descriptor_path",
    ]);
    assert.deepEqual(spawn.inputSchema.properties.harness.enum, ["claude-code", "opencode", "pi"]);
    assert.deepEqual(spawn.inputSchema.properties.topology.enum, ["leaf", "native_orchestrator"]);
    assert.equal(spawn.inputSchema.properties.target_worktree.type, "string");
    const instructions = client.getInstructions();
    assert.match(instructions, /Fresh routes; no defaults/i);
    assert.match(instructions, /stateless ordered rows; preflight, cancellation, outcomes/i);
    assert.match(instructions, /list_harnesses: no service\/model turn/i);
    const followup = listed.tools.find((tool) => tool.name === "followup_task");
    assert.equal(Object.hasOwn(followup.inputSchema.properties, "allowed_tools"), false);
    assert.deepEqual(Object.keys(followup.inputSchema.properties).sort(), ["message", "target"]);
    const wait = listed.tools.find((tool) => tool.name === "wait_agent");
    assert.equal(Object.hasOwn(wait.inputSchema.properties, "timeout_ms"), false);
    assert.equal(Object.hasOwn(wait.inputSchema.properties, "targets"), true);
    assert.equal(wait.inputSchema.properties.targets.items.type, "string");
    assert.equal(wait.inputSchema.properties.targets.items.minLength, 1);
    assert.equal(wait.inputSchema.properties.targets.minItems, 1);
    assert.equal(wait.inputSchema.properties.targets.maxItems, 8);
    assert.equal(Object.hasOwn(wait.inputSchema.properties, "wake_on_progress"), true);
    assert.equal(wait.inputSchema.required?.includes("wake_on_progress") ?? false, false);
    const descriptionWords = listed.tools
      .map((tool) => String(tool.description ?? "").trim().split(/\s+/u).filter(Boolean).length)
      .reduce((total, words) => total + words, 0);
    assert.ok(descriptionWords <= 3, `tool descriptions use ${descriptionWords} words`);
    const rawClient = mcpExposedDescriptionCharacters(listed.tools, client.getInstructions());
    const projected = mcpProjectedModelVisibleCharacters(listed.tools, client.getInstructions());
    assert.equal(projected, HARNESSDOCK_MCP_HOST_PROJECTION_CHAR_RESERVE + rawClient);
    assert.ok(projected <= HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT, `projected model-visible guidance uses ${projected} characters`);
    assert.ok(
      mcpProjectedModelVisibleCharacters(listed.tools, `${client.getInstructions()}x`.repeat(20)) > HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT,
      "the projected-guidance check must fail when host-repeated instructions grow",
    );
    assert.ok(JSON.stringify(listed.tools).length <= 5_000, "serialized discovery catalog exceeds 5,000 characters");
    assert.ok(descriptionCharacters(listed.tools) <= 800, "nested discovery descriptions exceed 800 characters");
    const restoredVerboseCatalog = structuredClone(listed.tools);
    restoredVerboseCatalog.find((tool) => tool.name === "spawn_agent").description =
      "Experimental: start one durable Agent asynchronously on an explicitly stated route. Harness, full model, effort, topology, and behavioral authority are required, freshly validated against native discovery, and frozen on the Agent; never default or alias a route.";
    assert.ok(JSON.stringify(restoredVerboseCatalog).length > JSON.stringify(listed.tools).length, "catalog guard accepts restored verbose spawn guidance");
  });

  it("projects high-volume listings without duplicate MCP payloads", () => {
    const receipt = {
      harnesses: [{
        harness: "pi",
        driver_version: "pi@2",
        maturity: "experimental",
        capability_schema_version: 4,
        instances: [{
          instance: "pi-local",
          readiness: "ready",
          detail: "ready",
          live_validated: true,
          maturity: "experimental",
          capacity: null,
          routes: {
            models: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
            topologies: ["leaf"],
            effortsByModel: {
              "openai-codex/gpt-5.6-luna": ["low", "medium", "high"],
              "openai-codex/gpt-5.6-sol": ["low", "medium", "high"],
            },
            interaction: "noninteractive_fixed_policy",
            continuation: "exact_resume",
          },
          capability_provenance: {
            interaction: "checkout_declared",
            continuation: "checkout_declared",
          },
          inspection_generation: "unavailable",
        }],
      }],
    };
    const projected = modelFacingReceipt("list_harnesses", receipt);
    assert.deepEqual(projected, {
      harnesses: [{
        harness: "pi",
        instance: "pi-local",
        readiness: "ready",
        live_validated: true,
        maturity: "experimental",
        inspection_generation: "unavailable",
        model_groups: [{
          models: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
          efforts: ["low", "medium", "high"],
        }],
        topologies: ["leaf"],
        constraints: {
          interaction: "noninteractive_fixed_policy",
          continuation: "exact_resume",
        },
      }],
    });
    assert.ok(JSON.stringify(projected).length < JSON.stringify(receipt).length * 0.7);

    assert.deepEqual(modelFacingReceipt("list_agents", {
      agents: [{
        agent_name: "/root/worker",
        agent_status: "working",
        harness: "pi",
        route_maturity: "experimental",
        capability_provenance: { interaction: "checkout_declared" },
        inspection_generation: "unavailable",
        model: "openai-codex/gpt-5.6-luna",
        reasoning_effort: "low",
        authority: "behavioral_write",
        delegation_mode: "leaf",
        phase: "tool",
        started_at: "2026-09-01T00:00:00.000Z",
        last_activity_at: "2026-09-01T00:00:01.000Z",
        elapsed_seconds: 1,
      }],
    }), {
      agents: [{
        agent_name: "/root/worker",
        agent_status: "working",
        harness: "pi",
        model: "openai-codex/gpt-5.6-luna",
        reasoning_effort: "low",
        authority: "behavioral_write",
        delegation_mode: "leaf",
        phase: "tool",
      }],
    });
  });

  it("strictly decodes ordered explicit dispatch rows and routes only the decoded request to the deferred runtime operation", async () => {
    const calls = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({
      runtimeInvoker: async ({ operation, input }) => {
        calls.push({ operation, input });
        if (operation === "dispatch_agents") {
          return { rows: input.rows.map((row) => ({
            agent_name: `/root/${row.task_name}`,
            agent_exists: true,
            outcome: "launched",
          })) };
        }
        if (operation === "spawn_agent") return { agent_name: "/root/singular", model: input.model, status: "working" };
        if (operation === "list_harnesses") return { harnesses: [] };
        return {};
      },
    });
    const client = new Client({ name: "hd-mcp-dispatch-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(() => client.close(), () => server.close());

    const listed = await client.listTools();
    const dispatch = listed.tools.find((tool) => tool.name === "dispatch_agents");
    assert.ok(dispatch);
    assert.deepEqual(Object.keys(dispatch.inputSchema.properties), ["rows"]);
    const rows = dispatch.inputSchema.properties.rows;
    assert.equal(rows.type, "array");
    assert.equal(rows.minItems, 1);
    assert.equal(rows.maxItems, 8);
    assert.equal(rows.items.additionalProperties, false);
    assert.deepEqual(new Set(rows.items.required), new Set([
      "task_name", "message", "harness", "model", "reasoning_effort", "topology", "write",
    ]));
    assert.deepEqual(Object.keys(rows.items.properties), [
      "task_name", "message", "description", "harness", "model", "topology", "write", "target_worktree", "reasoning_effort", "terminal_event_descriptor_path",
    ]);
    assert.equal(Object.hasOwn(rows.items.properties, "agent_name"), false);
    assert.equal(dispatch.description, undefined);

    const first = {
      task_name: "first_row",
      message: "first bounded assignment",
      description: "optional bounded description",
      harness: "claude-code",
      model: "claude-sonnet-5",
      reasoning_effort: "high",
      topology: "leaf",
      write: false,
      target_worktree: "/tmp/dispatch-first",
    };
    const second = {
      task_name: "second_row",
      message: "second bounded assignment",
      harness: "pi",
      model: "openai-codex/gpt-5.6-sol",
      reasoning_effort: "medium",
      topology: "leaf",
      write: true,
    };
    const accepted = await client.callTool({
      name: "dispatch_agents",
      arguments: { rows: [first, second] },
      _meta: meta,
    });
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(payloadOf(accepted), {
      rows: [
        { agent_name: "/root/first_row", agent_exists: true, outcome: "launched" },
        { agent_name: "/root/second_row", agent_exists: true, outcome: "launched" },
      ],
    });
    assert.deepEqual(calls, [{ operation: "dispatch_agents", input: { rows: [first, second] } }]);

    const forbiddenRowSelectors = [
      "agent_name", "inherited_model", "shared_model", "default_model", "retry", "Team", "dag", "session_id", "cwd",
    ];
    for (const selector of forbiddenRowSelectors) {
      const rejected = await client.callTool({
        name: "dispatch_agents",
        arguments: { rows: [{ ...first, [selector]: "forbidden" }] },
        _meta: meta,
      });
      assert.equal(rejected.isError, true, selector);
    }
    for (const required of ["task_name", "message", "harness", "model", "reasoning_effort", "topology", "write"]) {
      const row = { ...first };
      delete row[required];
      const rejected = await client.callTool({
        name: "dispatch_agents",
        arguments: { rows: [row] },
        _meta: meta,
      });
      assert.equal(rejected.isError, true, `missing ${required}`);
    }
    for (const argumentsValue of [
      { rows: [] },
      { rows: Array.from({ length: 9 }, (_, index) => ({ ...first, task_name: `row_${index}` })) },
      { rows: [first, { ...second, task_name: first.task_name }] },
      { rows: [{ ...first, task_name: "not-a-task-name" }] },
      { rows: [{ ...first, message: "   " }] },
      { rows: [{ ...first, model: "" }] },
      { rows: [{ ...first, reasoning_effort: "" }] },
      { rows: [{ ...first, target_worktree: "relative/worktree" }] },
      { rows: [first], shared_model: "forbidden" },
    ]) {
      const rejected = await client.callTool({ name: "dispatch_agents", arguments: argumentsValue, _meta: meta });
      assert.equal(rejected.isError, true);
    }
    assert.equal(calls.length, 1, "rejected dispatch inputs must not reach a runtime seam");

    const singular = await client.callTool({
      name: "spawn_agent",
      arguments: {
        task_name: "singular",
        message: "one Agent remains singular",
        harness: "claude-code",
        model: "claude-sonnet-5",
        reasoning_effort: "high",
        topology: "leaf",
        write: false,
      },
      _meta: meta,
    });
    const harnesses = await client.callTool({ name: "list_harnesses", arguments: {}, _meta: meta });
    assert.equal(singular.isError, undefined);
    assert.equal(harnesses.isError, undefined);
    assert.deepEqual(calls.slice(1).map(({ operation, input }) => ({ operation, input })), [
      {
        operation: "spawn_agent",
        input: {
          task_name: "singular",
          message: "one Agent remains singular",
          harness: "claude-code",
          model: "claude-sonnet-5",
          reasoning_effort: "high",
          topology: "leaf",
          write: false,
        },
      },
      { operation: "list_harnesses", input: {} },
    ]);
  });

  it("keeps shared server routing short and retains wait semantics in its owner Skill", async () => {
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => ({})));
    closers.push(() => client.close(), () => server.close());
    const instructions = client.getInstructions();
    assert.equal(instructions, "Experimental; trusted Codex metadata. Fresh routes; no defaults. Dispatch: stateless ordered rows; preflight, cancellation, outcomes. list_harnesses: no service/model turn.");
    const waitSkill = fs.readFileSync(path.join(pluginRoot, "skills", "wait-agent", "SKILL.md"), "utf8");
    assert.match(waitSkill, /3600000 ms[\s\S]*wake_on_progress: true[\s\S]*exactly one target/i);
    assert.match(waitSkill, /completion has priority[\s\S]*completion_message[\s\S]*token/i);
    assert.match(waitSkill, /timeout means no eligible completion was visible[\s\S]*call `wait_agent` again directly/i);
  });

  it("keeps the server instructions free of mandatory scheduling/classification language", async () => {
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => ({})));
    closers.push(() => client.close(), () => server.close());
    const instructions = client.getInstructions();
    assert.doesNotMatch(instructions, /do non-overlapping work first/i);
    assert.doesNotMatch(instructions, /critical dependency/i);
    assert.doesNotMatch(instructions, /required work/i);
    assert.doesNotMatch(instructions, /completion-first/i);
  });

  it("injects the hidden one-hour timeout for wait_agent via runtimeFactory, still rejects caller timeout_ms, and forwards other tools unchanged", async () => {
    const calls = [];
    const { client, server } = await inMemoryClient(() => runtimeMethods((name, input) => {
      calls.push({ name, input });
      return { accepted: true };
    }));
    closers.push(() => client.close(), () => server.close());

    await client.callTool({ name: "wait_agent", arguments: {}, _meta: meta });
    await client.callTool({
      name: "wait_agent",
      arguments: {
        targets: ["/root/first"],
        wake_on_progress: true,
      },
      _meta: meta,
    });
    await client.callTool({
      name: "wait_agent",
      arguments: {
        targets: ["/root/first", "/root/second"],
      },
      _meta: meta,
    });
    await client.callTool({
      name: "wait_agent",
      arguments: {
        wake_on_progress: true,
        acknowledge_tokens: ["delivery-prior"],
      },
      _meta: meta,
    });
    await client.callTool({ name: "list_agents", arguments: {}, _meta: meta });
    const rejected = await client.callTool({
      name: "wait_agent",
      arguments: { timeout_ms: 1_000 },
      _meta: meta,
    });

    assert.deepEqual(calls, [
      { name: "wait_agent", input: { timeout_ms: 3_600_000 } },
      {
        name: "wait_agent",
        input: {
          targets: ["/root/first"],
          wake_on_progress: true,
          timeout_ms: 3_600_000,
        },
      },
      {
        name: "wait_agent",
        input: {
          targets: ["/root/first", "/root/second"],
          timeout_ms: 3_600_000,
        },
      },
      {
        name: "wait_agent",
        input: {
          wake_on_progress: true,
          acknowledge_tokens: ["delivery-prior"],
          timeout_ms: 3_600_000,
        },
      },
      { name: "list_agents", input: {} },
    ]);
    assert.equal(rejected.isError, true);
  });

  it("rejects multi-target progress and duplicate target identifiers at the typed boundary", async () => {
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => ({ accepted: true })));
    closers.push(() => client.close(), () => server.close());
    const mixed = await client.callTool({
      name: "wait_agent",
      arguments: { targets: ["/root/one", "/root/two"], wake_on_progress: true },
      _meta: meta,
    });
    const duplicate = await client.callTool({
      name: "wait_agent",
      arguments: { targets: ["/root/one", "/root/one"] },
      _meta: meta,
    });
    assert.equal(mixed.isError, true);
    assert.equal(duplicate.isError, true);
  });

  it("injects the hidden one-hour timeout for wait_agent via runtimeInvoker", async () => {
    const calls = [];
    const runtimeInvoker = async ({ operation, input }) => {
      calls.push({ operation, input });
      return { accepted: true };
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({ runtimeInvoker });
    const client = new Client({ name: "hd-mcp-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(() => client.close(), () => server.close());

    await client.callTool({ name: "wait_agent", arguments: {}, _meta: meta });

    assert.deepEqual(calls, [
      { operation: "wait_agent", input: { timeout_ms: 3_600_000 } },
    ]);
  });

  it("runs lifecycle housekeeping after an operation without changing its receipt", async () => {
    let completed = 0;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({
      runtimeInvoker: async () => ({ accepted: true }),
      onOperationComplete: async () => { completed += 1; },
    });
    const client = new Client({ name: "hd-mcp-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(() => client.close(), () => server.close());
    const result = await client.callTool({ name: "list_agents", arguments: {}, _meta: meta });
    assert.deepEqual(payloadOf(result), { accepted: true });
    assert.equal(completed, 1);
  });

  it("redacts private runtime identities and absolute paths while keeping public error categories", () => {
    const message = redactMcpErrorMessage(
      [
        "Claude session abc-123 in internal job job-456 failed at /data/CoordExp/codex-harnessdock/runtime/state/jobs/job-456.json:",
        "(/data/CoordExp/.codex/plugins/data/codex-harnessdock/state/private.json)",
        "`/data/CoordExp/.codex/plugins/data/codex-harnessdock/state/private.json`",
        "/root/.codex/plugins/data/codex-harnessdock/state/session-leases/private.json",
        "/root/.claude /root/project",
        "Agent /root/public_agent authentication required",
      ].join(" "),
    );
    assert.match(message, /authentication required/i);
    assert.equal(message.includes("abc-123"), false);
    assert.equal(message.includes("job-456"), false);
    assert.equal(message.includes("/data/CoordExp"), false);
    assert.equal(message.includes("/root/.codex"), false);
    assert.equal(message.includes("/root/.claude"), false);
    assert.equal(message.includes("/root/project"), false);
    assert.match(message, /\/root\/public_agent/);
  });

  it("forwards a non-null wait_agent blocking object unchanged, with no output schema or supplementation", async () => {
    const update = {
      kind: "completion",
      agent_name: "/root/blocked_wait",
      agent_status: "failed",
      summary: "Agent turn failed.",
      completion_message: "",
      completion_message_truncated: false,
      delivery_token: "delivery-blocked-wait",
      blocking: { reason: "auth_required", scope: "harness", retry: "operator_required" },
    };
    const receipt = { message: "HarnessDock Agent completion is available.", timedOut: false, update };
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => receipt));
    closers.push(() => client.close(), () => server.close());

    const listed = await client.listTools();
    const wait = listed.tools.find((tool) => tool.name === "wait_agent");
    assert.equal(Object.hasOwn(wait, "outputSchema"), false);

    const result = await client.callTool({ name: "wait_agent", arguments: {}, _meta: meta });
    assert.deepEqual(payloadOf(result), receipt);
    assert.deepEqual(JSON.parse(result.content[0].text), receipt);
    assert.deepEqual(JSON.parse(result.content[0].text).update.blocking, update.blocking);
  });

  it("forwards a null wait_agent blocking field unchanged rather than synthesizing a reason", async () => {
    const update = {
      kind: "completion",
      agent_name: "/root/completed_wait",
      agent_status: "completed",
      summary: "Agent turn completed.",
      completion_message: "done",
      completion_message_truncated: false,
      delivery_token: "delivery-completed-wait",
      blocking: null,
    };
    const receipt = { message: "HarnessDock Agent completion is available.", timedOut: false, update };
    const { client, server } = await inMemoryClient(() => runtimeMethods(() => receipt));
    closers.push(() => client.close(), () => server.close());

    const result = await client.callTool({ name: "wait_agent", arguments: {}, _meta: meta });
    assert.deepEqual(payloadOf(result), receipt);
    assert.equal(JSON.parse(result.content[0].text).update.blocking, null);
  });

  it("preserves a compact send receipt without reconstructing internal evidence", async () => {
    const receipt = {
      agent_name: "/root/compact_send",
      delivery: "dispatched_active",
    };
    const { client, server } = await inMemoryClient(() => runtimeMethods((name) => {
      assert.equal(name, "send_message");
      return receipt;
    }));
    closers.push(() => client.close(), () => server.close());

    const result = await client.callTool({
      name: "send_message",
      arguments: { target: "/root/compact_send", message: "private repeated text" },
      _meta: meta,
    });
    assert.deepEqual(payloadOf(result), receipt);
    assert.deepEqual(JSON.parse(result.content[0].text), receipt);
    assert.equal(JSON.stringify(result).includes("private repeated text"), false);
  });

  it("passes through exact compact spawn, follow-up, and interrupt receipts", async () => {
    const receipts = {
      spawn_agent: {
        agent_name: "/root/compact",
        model: "claude-sonnet-5",
        status: "working",
      },
      followup_task: {
        agent_name: "/root/compact",
        delivery: "new_turn",
      },
      interrupt_agent: {
        agent_name: "/root/compact",
        status: "interrupted",
      },
    };
    const { client, server } = await inMemoryClient(() => runtimeMethods((name) => receipts[name] ?? {}));
    closers.push(() => client.close(), () => server.close());

    for (const [name, argumentsValue] of [
      ["spawn_agent", {
        task_name: "compact",
        message: "bounded task",
        harness: "claude-code",
        model: "claude-sonnet-5",
        reasoning_effort: "high",
        topology: "leaf",
        write: false,
      }],
      ["followup_task", { target: "/root/compact", message: "continue" }],
      ["interrupt_agent", { target: "/root/compact" }],
    ]) {
      const result = await client.callTool({ name, arguments: argumentsValue, _meta: meta });
      assert.deepEqual(payloadOf(result), receipts[name]);
      assert.deepEqual(JSON.parse(result.content[0].text), receipts[name]);
      assert.deepEqual(Object.keys(payloadOf(result)), Object.keys(receipts[name]));
    }
  });

  it("requires spawn write intent and preserves explicit false and true without another switch", async () => {
    const calls = [];
    const { client, server } = await inMemoryClient(() => runtimeMethods((name, input) => {
      calls.push({ name, input });
      return { accepted: true };
    }));
    closers.push(() => client.close(), () => server.close());

    const base = {
      task_name: "permission_probe",
      message: "inspect only",
      model: "claude-haiku-4-5",
      reasoning_effort: "high",
    };
    const omitted = await client.callTool({ name: "spawn_agent", arguments: base, _meta: meta });
    assert.equal(omitted.isError, true);
    await client.callTool({
      name: "spawn_agent",
      arguments: {
        harness: "claude-code",
        topology: "leaf", ...base, task_name: "permission_read", write: false },
      _meta: meta,
    });
    await client.callTool({
      name: "spawn_agent",
      arguments: {
        harness: "claude-code",
        topology: "leaf", ...base, task_name: "permission_write", write: true },
      _meta: meta,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].input.write, false);
    assert.equal(calls[1].input.write, true);
    for (const call of calls) {
      assert.equal(Object.hasOwn(call.input, "dangerously_skip_permissions"), false);
      assert.equal(Object.hasOwn(call.input, "permission_mode"), false);
    }
  });

  it("forwards one explicit spawn tuple and rejects null effort before runtime invocation", async () => {
    const calls = [];
    const { client, server } = await inMemoryClient(() => runtimeMethods((name, input) => {
      calls.push({ name, input });
      return { accepted: true };
    }));
    closers.push(() => client.close(), () => server.close());
    const tuple = {
      task_name: "exact_tuple", message: "bounded task", harness: "claude-code",
      model: "claude-sonnet-5", reasoning_effort: "high", topology: "leaf", write: false,
    };
    await client.callTool({ name: "spawn_agent", arguments: tuple, _meta: meta });
    assert.deepEqual(calls, [{ name: "spawn_agent", input: tuple }]);
    const rejected = await client.callTool({
      name: "spawn_agent", arguments: { ...tuple, task_name: "null_effort", reasoning_effort: null }, _meta: meta,
    });
    assert.equal(rejected.isError, true);
    assert.equal(calls.length, 1);
  });

  it("forwards target_worktree only to spawn and never adds either path to its compact receipt", async () => {
    const target = "/tmp/harnessdock target/linked";
    const calls = [];
    const receipt = { agent_name: "/root/targeted", model: "claude-sonnet-5", status: "working" };
    const { client, server } = await inMemoryClient(() => runtimeMethods((name, input) => {
      calls.push({ name, input });
      return receipt;
    }));
    closers.push(() => client.close(), () => server.close());

    const result = await client.callTool({
      name: "spawn_agent",
      arguments: {
        task_name: "targeted",
        message: "bounded task",
        harness: "claude-code",
        model: "claude-sonnet-5",
        reasoning_effort: "high",
        topology: "leaf",
        write: false,
        target_worktree: target,
      },
      _meta: meta,
    });
    assert.equal(calls[0].input.target_worktree, target);
    assert.deepEqual(payloadOf(result), receipt);
    assert.equal(JSON.stringify(result).includes(target), false);

    const followup = await client.callTool({
      name: "followup_task",
      arguments: { target: "/root/targeted", message: "continue", target_worktree: target },
      _meta: meta,
    });
    assert.equal(followup.isError, true);
    assert.equal(calls.length, 1);
  });

  it("binds every call to trusted Codex thread and workspace metadata", async () => {
    const contexts = [];
    const { client, server } = await inMemoryClient((context) => {
      contexts.push(context);
      return runtimeMethods((name, input) => ({ operation: name, input }));
    });
    closers.push(() => client.close(), () => server.close());

    const result = await client.callTool({
      name: "list_agents",
      arguments: { path_prefix: "/root/a" },
      _meta: meta,
    });
    assert.deepEqual(payloadOf(result), {
      operation: "list_agents",
      input: { path_prefix: "/root/a" },
    });
    assert.equal(result.content[0].type, "text");
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].cwd, root);
    assert.equal(contexts[0].env.CODEX_THREAD_ID, meta.threadId);
    assert.equal(contexts[0].env.CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID, meta.threadId);
    assert.equal(contexts[0].env.CODEX_HARNESSDOCK_RUNTIME_CHECKOUT, root);
    assert.equal(contexts[0].envFile, path.join(root, "config", "runtime.env"));
  });

  it("fails closed when trusted context is missing or callers add private selectors", async () => {
    let runtimeCalls = 0;
    const { client, server } = await inMemoryClient(() => {
      runtimeCalls += 1;
      return runtimeMethods(() => ({}));
    });
    closers.push(() => client.close(), () => server.close());

    const missing = await client.callTool({ name: "list_agents", arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /missing _meta\.threadId/);

    const staleWorkspace = await client.callTool({
      name: "list_agents",
      arguments: {},
      _meta: {
        threadId: "mcp-stale-workspace-thread",
        [CODEX_SANDBOX_META_KEY]: {
          sandboxCwd: pathToFileURL(path.join(root, ".missing-cc-workspace-for-test")).href,
        },
      },
    });
    assert.equal(staleWorkspace.isError, true);
    assert.match(staleWorkspace.content[0].text, /trusted.*workspace.*(?:unavailable|no longer exists)/i);

    const forbidden = await client.callTool({
      name: "spawn_agent",
      arguments: {
        harness: "claude-code",
        topology: "leaf",
        task_name: "audit",
        message: "read only",
        model: "claude-haiku-4-5",
        write: false,
        cwd: "/tmp",
      },
      _meta: meta,
    });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /invalid|unrecognized|additional/i);
    const retiredTools = await client.callTool({
      name: "followup_task",
      arguments: { target: "/root/audit", message: "continue", allowed_tools: ["Read"] },
      _meta: meta,
    });
    assert.equal(retiredTools.isError, true);
    assert.match(retiredTools.content[0].text, /invalid|unrecognized|additional/i);
    assert.equal(runtimeCalls, 0);
  });

  it("propagates caller cancellation only into the wait observation", async () => {
    let observedAbort = false;
    let mutations = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const { client, server } = await inMemoryClient((context) => runtimeMethods(async (name) => {
      if (name !== "wait_agent") {
        mutations += 1;
        return {};
      }
      markStarted();
      await new Promise((resolve, reject) => {
        context.abortSignal.addEventListener("abort", () => {
          observedAbort = true;
          const error = new Error("wait cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      return {};
    }));
    closers.push(() => client.close(), () => server.close());

    const controller = new AbortController();
    const waiting = client.callTool(
      { name: "wait_agent", arguments: {}, _meta: meta },
      undefined,
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    await assert.rejects(waiting, /abort|cancel/i);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observedAbort, true);
    assert.equal(mutations, 0);
  });

  it("loads compatible runtime implementation edits in a fresh worker on every call", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-mcp-hot-load-"));
    temporaryDirectories.push(directory);
    const runtimeFile = path.join(directory, "runtime.mjs");
    const writeRuntime = (revision) => fs.writeFileSync(runtimeFile, `
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION};
export function createAgentRuntime() {
  return { list_agents() { return { revision: ${JSON.stringify(revision)} }; } };
}
`);
    const context = { cwd: root, envFile: path.join(root, "config", "runtime.env"), env: {} };
    writeRuntime("first");
    const first = await invokeIsolatedRuntimeOperation({
      operation: "list_agents",
      input: {},
      context,
      runtimeModuleUrl: pathToFileURL(runtimeFile),
    });
    writeRuntime("second");
    const second = await invokeIsolatedRuntimeOperation({
      operation: "list_agents",
      input: {},
      context,
      runtimeModuleUrl: pathToFileURL(runtimeFile),
    });
    assert.deepEqual(first, { revision: "first" });
    assert.deepEqual(second, { revision: "second" });
  });

  it("settles a real quiet wait through the isolated Worker lifecycle", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-mcp-wait-worker-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const claudeConfig = path.join(directory, "claude");
    const codexHome = path.join(directory, "codex");
    const runtimeHome = path.join(directory, "runtime");
    fs.mkdirSync(workspace);
    fs.mkdirSync(claudeConfig);
    const receipt = await invokeIsolatedRuntimeOperation({
      operation: "wait_agent",
      input: { timeout_ms: 25 },
      context: {
        cwd: workspace,
        envFile: path.join(root, "config", "runtime.env"),
        env: {
          CODEX_HOME: codexHome,
          CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
          CODEX_THREAD_ID: "mcp-isolated-wait-timeout",
          CLAUDE_CONFIG_DIR: claudeConfig,
          CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: root,
          CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: root,
        },
      },
    });
    assert.equal(receipt.timedOut, true);
  });

  it("rejects a stale MCP generation before invoking the current runtime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hd-mcp-generation-"));
    temporaryDirectories.push(directory);
    const marker = path.join(directory, "called");
    const runtimeFile = path.join(directory, "runtime.mjs");
    fs.writeFileSync(runtimeFile, `
import fs from "node:fs";
export const HARNESSDOCK_MCP_API_GENERATION = ${HARNESSDOCK_MCP_API_GENERATION + 1};
export function createAgentRuntime() {
  fs.writeFileSync(${JSON.stringify(marker)}, "called");
  return { list_agents() { return {}; } };
}
`);
    await assert.rejects(
      invokeIsolatedRuntimeOperation({
        operation: "list_agents",
        input: {},
        context: { cwd: root, envFile: path.join(root, "config", "runtime.env"), env: {} },
        runtimeModuleUrl: pathToFileURL(runtimeFile),
      }),
      (error) => error?.code === "HARNESSDOCK_MCP_RESTART_REQUIRED" && /release:local.*new Codex task/i.test(error.message),
    );
    assert.equal(fs.existsSync(marker), false);
  });

  it("starts through the descriptor bootstrap and preserves stdio framing", async () => {
    const canonicalManifestFile = "/data/CoordExp/codex-harnessdock/plugins/codex-harnessdock/.codex-plugin/plugin.json";
    if (!fs.existsSync(canonicalManifestFile)) {
      // A development worktree is never the live checkout, and between the
      // source rename and the operator relocation the live path does not exist
      // at all. Either way the fixed bootstrap must fail closed and name what
      // it could not validate, rather than falling back to another checkout or
      // to the retired identity. This asserts the constant, not the directory.
      const result = spawnSync(process.execPath, ["--", path.join(pluginRoot, "bootstrap", "harnessdock-mcp.mjs")], {
        cwd: root,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stderr}\n${result.stdout}`,
        /Fixed HarnessDock (MCP checkout is invalid|runtime checkout is unavailable)|Unexpected HarnessDock MCP Plugin identity/i,
      );
      assert.match(`${result.stderr}\n${result.stdout}`, /\/data\/CoordExp\/codex-harnessdock/);
      return;
    }
    const canonicalServerFile = "/data/CoordExp/codex-harnessdock/runtime/mcp-server.mjs";
    if (!fs.existsSync(canonicalServerFile) || !fs.readFileSync(canonicalServerFile, "utf8").includes('"dispatch_agents"')) {
      // This unrefreshed checkout is intentionally not a release witness for
      // the next generation; the in-memory catalog test above owns it.
      return;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--", path.join(pluginRoot, "bootstrap", "harnessdock-mcp.mjs")],
      cwd: root,
      stderr: "pipe",
    });
    const client = new Client({ name: "hd-mcp-stdio-test", version: "1.0.0" });
    closers.push(() => client.close());
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), HARNESSDOCK_MCP_TOOL_NAMES);
  });

  it("exits the one-process bootstrap when stdin closes without a runtime child", async () => {
    const canonicalManifestFile = "/data/CoordExp/codex-harnessdock/plugins/codex-harnessdock/.codex-plugin/plugin.json";
    if (!fs.existsSync(canonicalManifestFile)) return;
    const child = spawn(process.execPath, ["--", path.join(pluginRoot, "bootstrap", "harnessdock-mcp.mjs")], {
      cwd: root,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, stderr.join(""));
    if (process.platform === "linux") {
      const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
      assert.equal(children, "", "bootstrap has a child before stdin closes");
    }
    child.stdin.end();
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap did not exit after stdin closed")), 5_000)),
    ]);
    assert.equal(signal, null);
    assert.equal(code, 0, stderr.join(""));
    const descendants = spawnSync("ps", ["-o", "pid=", "--ppid", String(child.pid)], { encoding: "utf8" });
    assert.equal(descendants.stdout.trim(), "", "bootstrap left a runtime child process");
  });
});

describe("MCP server option admission", () => {
  it("refuses a bare function where an options object belongs", () => {
    // The trap this closes: a bare factory is silently ignored, the server
    // falls back to the isolated worker, and that worker builds its runtime
    // from the operator's real configuration.
    assert.throws(
      () => createCcMcpServer(() => ({})),
      /takes an options object[\s\S]*bare function is not a runtime factory/i,
    );
    for (const argument of [null, [], "runtimeFactory", 7]) {
      assert.throws(() => createCcMcpServer(argument), /takes an options object/i);
    }
  });

  it("refuses an option it does not declare and a non-function seam", () => {
    assert.throws(
      () => createCcMcpServer({ runtime: () => ({}) }),
      /does not accept "runtime"/,
    );
    assert.throws(
      () => createCcMcpServer({ runtimeFactory: {} }),
      /runtimeFactory must be a function/,
    );
    assert.throws(
      () => createCcMcpServer({ runtimeInvoker: "isolated" }),
      /runtimeInvoker must be a function/,
    );
  });

  it("still accepts the production default and each declared seam", () => {
    for (const options of [undefined, {}, { runtimeFactory: () => ({}) }, { runtimeInvoker: async () => ({}) }]) {
      const server = createCcMcpServer(options);
      assert.ok(server);
      server.close();
    }
  });
});
