/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 7.1/7.2 of add-opencode-explorer-driver: the static two-Harness
 * admission and the eighth operation, `list_harnesses`.
 *
 * Every OpenCode observation here points at a fake Server on an ephemeral
 * loopback port, or at a deliberately dead port; nothing in this suite touches
 * the operator's configured Server, creates a session, or makes a model request.
 *
 * `list_harnesses` is inspection. These tests hold it to that: it must report
 * readiness, route constraints, capability maturity, and capacity for every
 * admitted Harness, and it must carry no ranking, recommendation, score, price,
 * threshold, or default anywhere in its receipt.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ADMITTED_DRIVER_V2_HARNESS_IDS,
  ADMITTED_GENERATION_HARNESS_IDS,
  ADMITTED_HARNESS_IDS,
  resolveDriverV2,
  resolveHarnessDriver,
} from "../../runtime/harness-registry.mjs";
import { HARNESSDOCK_MCP_TOOL_NAMES, createCcMcpServer } from "../../runtime/mcp-server.mjs";
import { createAgentRuntime } from "../../runtime/index.mjs";
import { OPENCODE_DRIVER_VERSION } from "../../runtime/opencode-driver.mjs";
import {
  OPENCODE_EXPLORER_MODEL,
  OPENCODE_EXPLORER_MODEL_ID,
  OPENCODE_EXPLORER_MODELS,
  OPENCODE_EXPLORER_MODEL_ROUTES,
  OPENCODE_EXPLORER_PROFILE_NAME,
  OPENCODE_EXPLORER_PROVIDER_ID,
  OPENCODE_HARNESS_ID,
  opencodeExplorerInstanceKey,
} from "../../runtime/opencode-explorer-profile.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const repositoryRoot = path.resolve(new URL("../../", import.meta.url).pathname);
/** A loopback port nothing listens on, for the unreachable-Harness cases. */
const DEAD_SERVER_URL = "http://127.0.0.1:4599";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function compliantRuleset() {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "doom_loop", pattern: "*", action: "allow" },
  ];
}

async function startReadyFake(scenario = {}) {
  const providers = [...new Set(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.providerId))];
  const server = createFakeOpencodeServer({
    health: { status: 200, body: { healthy: true, version: "1.18.23" } },
    config: { status: 200, body: { default_agent: OPENCODE_EXPLORER_PROFILE_NAME } },
    agents: {
      status: 200,
      body: [
        {
          name: OPENCODE_EXPLORER_PROFILE_NAME,
          mode: "primary",
          native: false,
          permission: compliantRuleset(),
          model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
          options: {},
        },
      ],
    },
    provider: {
      status: 200,
      body: {
        all: providers.map((providerId) => ({
          id: providerId,
          models: Object.fromEntries(
            OPENCODE_EXPLORER_MODEL_ROUTES
              .filter((route) => route.providerId === providerId)
              .map((route) => [route.modelId, { id: route.modelId, providerID: route.providerId, variants: { high: {} } }])
          ),
        })),
        connected: providers,
        default: {},
      },
    },
    ...scenario,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

// Runtime path ownership is process-wide, so every runtime in this file shares
// one disposable home.
const RUNTIME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-generation-home-"));
process.on("exit", () => fs.rmSync(RUNTIME_HOME, { recursive: true, force: true }));

/**
 * A disposable env file naming one Server origin. The selected env file
 * deliberately overrides the inherited process environment -- an operator-owned
 * setting is not something a stray shell variable may redirect -- so a test that
 * wants a fake Server states it the same way an operator would.
 */
function envFileFor(serverUrl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-generation-env-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "runtime.env");
  fs.writeFileSync(file, `OPENCODE_SERVER_URL=${serverUrl}\n`);
  return file;
}

function runtimeFor(serverUrl) {
  return createAgentRuntime({
    cwd: repositoryRoot,
    envFile: envFileFor(serverUrl),
    env: {
      ...process.env,
      CODEX_THREAD_ID: "generation-root",
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "generation-root",
      CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
      CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: "",
      // A dead-origin test must not fall through to the host's native OpenCode
      // diagnostic executable and turn into a dormant-route observation.
      OPENCODE_EXECUTABLE: "",
    },
  });
}

function harnessOf(listing, harnessId) {
  return listing.harnesses.find((record) => record.harness === harnessId);
}

function collectKeys(value, sink = []) {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, sink);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      sink.push(key);
      collectKeys(child, sink);
    }
  }
  return sink;
}

function collectStrings(value, sink = []) {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, sink);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, sink);
  return sink;
}

/** Words a policy-thin inspection surface may never introduce. */
const POLICY_WORDS =
  /\brank(ing)?\b|recommend|preferred|\bscore\b|\bbest\b|cheap|\bprice\b|\bcost\b|budget|threshold|fallback|default_harness|auto[_-]?(delegate|select|route|choose)/i;

// ---------------------------------------------------------------------------
// 7.1 Static admission.
// ---------------------------------------------------------------------------

describe("public generation: static three-Harness admission", () => {
  it("admits exactly claude-code, opencode, and pi at Driver Contract v2", () => {
    assert.deepEqual([...ADMITTED_DRIVER_V2_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    assert.deepEqual([...ADMITTED_GENERATION_HARNESS_IDS], ["claude-code", "opencode", "pi"]);
    // Deterministic order, not a preference: sorted, with no first-choice meaning.
    assert.deepEqual([...ADMITTED_GENERATION_HARNESS_IDS], [...ADMITTED_GENERATION_HARNESS_IDS].sort());
  });

  it("resolves the checkout-owned OpenCode Driver from the static table", () => {
    const driver = resolveDriverV2(OPENCODE_HARNESS_ID, { env: { OPENCODE_SERVER_URL: DEAD_SERVER_URL } });
    assert.equal(driver.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(driver.driverVersion, OPENCODE_DRIVER_VERSION);
    assert.equal(Object.isFrozen(driver), true);
  });

  it("keeps the version-one table Claude-only", () => {
    // Version one encodes a process-shaped Claude lifecycle; a service-backed
    // Harness has no meaning for it, so this resolution stays closed.
    assert.deepEqual([...ADMITTED_HARNESS_IDS], ["claude-code"]);
    assert.throws(() => resolveHarnessDriver(OPENCODE_HARNESS_ID, { env: {} }), /Unknown Harness/);
  });

  it("refuses an unknown, miscased, or ambient-selected Harness", () => {
    for (const harnessId of ["opencode-go", "OpenCode", "openCode", "claude", "deepseek", "opencode2"]) {
      assert.throws(() => resolveDriverV2(harnessId, { env: {} }), undefined, harnessId);
    }
    assert.throws(
      () => resolveDriverV2(OPENCODE_HARNESS_ID, { env: { CODEX_HARNESSDOCK_HARNESS_ENDPOINT: "http://10.0.0.5:4096" } }),
      /cannot select a Harness Driver implementation/
    );
  });
});

// ---------------------------------------------------------------------------
// 7.2 The eighth operation.
// ---------------------------------------------------------------------------

describe("public generation: list_harnesses observes without selecting", () => {
  it("exposes exactly eight frozen public operations", () => {
    const runtime = runtimeFor(DEAD_SERVER_URL);
    assert.deepEqual(Object.keys(runtime).sort(), [
      "followup_task",
      "interrupt_agent",
      "list_agents",
      "list_harnesses",
      "read_agent_messages",
      "send_message",
      "spawn_agent",
      "wait_agent",
    ]);
    assert.equal(Object.isFrozen(runtime), true);
  });

  it("reports readiness, routes, maturity, and capacity for every Harness", async () => {
    const { url } = await startReadyFake();
    const listing = await runtimeFor(url).list_harnesses({});
    assert.deepEqual(listing.harnesses.map((record) => record.harness), ["claude-code", "opencode", "pi"]);

    const opencode = harnessOf(listing, OPENCODE_HARNESS_ID);
    assert.equal(opencode.driver_version, OPENCODE_DRIVER_VERSION);
    assert.equal(opencode.maturity, "experimental");
    assert.equal(opencode.capability_schema_version, 3);
    assert.equal(opencode.instances.length, 1);
    const instance = opencode.instances[0];
    assert.equal(instance.instance, opencodeExplorerInstanceKey(url));
    assert.equal(instance.readiness, "ready");
    assert.equal(instance.detail, "ready");
    assert.equal(instance.live_validated, true);
    assert.equal(instance.capacity, null, "the OpenCode route has no HarnessDock capacity ceiling");
    assert.deepEqual([...instance.routes.models].sort(), [...OPENCODE_EXPLORER_MODELS].sort());
    assert.deepEqual([...instance.routes.topologies], ["leaf"]);
    assert.equal(instance.routes.authorityEnforcement, "prompt_only");
    assert.equal(instance.routes.continuation, "fresh_only");
    assert.equal(instance.routes.interaction, "noninteractive_fixed_policy");
    assert.equal(instance.routes.interruptRequest, "unsupported");
    assert.equal(instance.routes.history, "unavailable");
    assert.equal(Object.hasOwn(instance.routes, "profile"), false);

    const claude = harnessOf(listing, "claude-code");
    assert.equal(claude.maturity, "experimental");
    assert.ok(claude.instances.length >= 1);
    if (claude.instances[0].readiness === "ready") {
      assert.ok(claude.instances[0].routes.models.length >= 1);
    } else {
      assert.equal(claude.instances[0].routes, null);
    }
  });

  it("carries no ranking, recommendation, price, threshold, or default", async () => {
    const { url } = await startReadyFake();
    const listing = await runtimeFor(url).list_harnesses({});
    for (const key of collectKeys(listing)) {
      assert.equal(POLICY_WORDS.test(key), false, `listing key states policy: ${key}`);
    }
    for (const text of collectStrings(listing)) {
      assert.equal(POLICY_WORDS.test(text), false, `listing value states policy: ${text}`);
    }
    // No ordering field, no chosen/selected marker, and no per-Harness verdict.
    for (const record of listing.harnesses) {
      for (const forbidden of ["preferred", "selected", "recommended", "order", "rank", "default"]) {
        assert.equal(Object.hasOwn(record, forbidden), false, forbidden);
      }
    }
  });

  it("discloses no endpoint, credential, or absolute path", async () => {
    const { url } = await startReadyFake();
    const listing = await runtimeFor(url).list_harnesses({});
    const serialized = JSON.stringify(listing);
    assert.equal(serialized.includes(url), false);
    assert.equal(serialized.includes("127.0.0.1"), false);
    assert.equal(/password|secret|token|authorization/i.test(serialized), false);
    for (const text of collectStrings(listing)) {
      assert.equal(text.startsWith("/"), false, `disclosed an absolute path: ${text}`);
    }
  });

  it("projects an interaction witness failure without policy detail", async () => {
    const { url } = await startReadyFake({
      agents: {
        status: 200,
        body: [{
          name: OPENCODE_EXPLORER_PROFILE_NAME, mode: "primary", native: false,
          permission: [{ permission: "doom_loop", pattern: "*", action: "ask" }], options: {},
        }],
      },
    });
    const opencode = harnessOf(await runtimeFor(url).list_harnesses({}), OPENCODE_HARNESS_ID);
    assert.deepEqual(opencode.instances[0], {
      instance: opencodeExplorerInstanceKey(url), readiness: "blocked", detail: "interactive_policy",
      live_validated: false, maturity: "experimental", capacity: null, routes: null,
    });
    assert.doesNotMatch(JSON.stringify(opencode), /doom_loop|ask|build|1\.18\.23/i);
  });

  it("keeps one unavailable Harness from hiding the other", async () => {
    const listing = await runtimeFor(DEAD_SERVER_URL).list_harnesses({});
    const opencode = harnessOf(listing, OPENCODE_HARNESS_ID);
    assert.equal(opencode.instances[0].readiness, "unavailable");
    assert.equal(opencode.instances[0].detail, "service_unreachable");
    assert.equal(opencode.instances[0].routes, null);
    assert.equal(opencode.instances[0].live_validated, false);
    const claude = harnessOf(listing, "claude-code");
    assert.ok(claude.instances.length >= 1, "the other Harness still answers");
  });

  it("blocks a misconfigured Harness without repairing or hiding it", async () => {
    // A configured origin this Driver refuses outright: the record is reported
    // unavailable with a closed reason and no configuration text.
    const listing = await runtimeFor("http://10.0.0.5:4096").list_harnesses({});
    const opencode = harnessOf(listing, OPENCODE_HARNESS_ID);
    assert.equal(opencode.unavailable, "driver_unavailable");
    assert.deepEqual([...opencode.instances], []);
    assert.equal(JSON.stringify(opencode).includes("10.0.0.5"), false);
  });

  it("accepts no input at all", async () => {
    const runtime = runtimeFor(DEAD_SERVER_URL);
    await assert.rejects(() => runtime.list_harnesses({ harness: "opencode" }), /does not accept harness/);
    await assert.rejects(() => runtime.list_harnesses({ all: true }), /does not accept all/);
    await assert.rejects(() => runtime.list_harnesses({ path_prefix: "/root" }), /does not accept path_prefix/);
    const listing = await runtime.list_harnesses();
    assert.ok(Array.isArray(listing.harnesses));
  });
});

// ---------------------------------------------------------------------------
// 7.2 The same observation through MCP and the operator CLI.
// ---------------------------------------------------------------------------

describe("public generation: list_harnesses through MCP and the operator CLI", () => {
  async function inMemoryClient(runtimeFactory) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCcMcpServer({ runtimeFactory });
    const client = new Client({ name: "generation-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close(), () => server.close());
    return client;
  }

  it("advertises exactly eight typed tools, with list_harnesses read-only and input-free", async () => {
    const client = await inMemoryClient(() =>
      Object.fromEntries(HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [name, () => ({ operation: name })]))
    );
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 8);
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...HARNESSDOCK_MCP_TOOL_NAMES]);
    assert.equal(HARNESSDOCK_MCP_TOOL_NAMES.includes("list_harnesses"), true);
    const tool = listed.tools.find((entry) => entry.name === "list_harnesses");
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties ?? {}, {});
    assert.equal(POLICY_WORDS.test(tool.description), false, tool.description);
  });

  it("routes a list_harnesses call to the runtime operation of the same name", async () => {
    const calls = [];
    const client = await inMemoryClient(() =>
      Object.fromEntries(
        HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [
          name,
          (input) => {
            calls.push({ name, input });
            return { harnesses: [] };
          },
        ])
      )
    );
    const result = await client.callTool({
      name: "list_harnesses",
      arguments: {},
      _meta: {
        threadId: "generation-mcp-thread",
        "codex/sandbox-state-meta": { sandboxCwd: new URL(`file://${repositoryRoot}`).href },
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls.map((call) => call.name), ["list_harnesses"]);
    assert.deepEqual(calls[0].input, {});
    assert.deepEqual(result.structuredContent, { harnesses: [] });
  });

  it("rejects an argument the eighth tool does not declare", async () => {
    const client = await inMemoryClient(() =>
      Object.fromEntries(HARNESSDOCK_MCP_TOOL_NAMES.map((name) => [name, () => ({ harnesses: [] })]))
    );
    const result = await client.callTool({
      name: "list_harnesses",
      arguments: { harness: "opencode" },
      _meta: {
        threadId: "generation-mcp-thread",
        "codex/sandbox-state-meta": { sandboxCwd: new URL(`file://${repositoryRoot}`).href },
      },
    });
    assert.equal(result.isError, true);
  });

  it("surfaces the same records through the operator CLI as inspection", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "runtime", "operator-cli.mjs"), "list-harnesses", "--all", "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "",
          CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: "",
          CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFileFor(DEAD_SERVER_URL),
          CODEX_HARNESSDOCK_RUNTIME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cc-generation-cli-")),
          OPENCODE_EXECUTABLE: "",
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.operatorMode, true);
    assert.equal(payload.readOnly, true);
    assert.deepEqual(payload.harnesses.map((record) => record.harness), ["claude-code", "opencode", "pi"]);
    assert.equal(harnessOf(payload, OPENCODE_HARNESS_ID).instances[0].readiness, "unavailable");
    // Inspection, never dispatch: the operator surface exposes no spawn/route verb.
    const usage = spawnSync(
      process.execPath,
      [path.join(repositoryRoot, "runtime", "operator-cli.mjs"), "help"],
      { encoding: "utf8" }
    );
    assert.match(usage.stdout, /list-harnesses --all/);
    assert.equal(/spawn|route|dispatch/i.test(usage.stdout), false);
  });

  it("refuses an operator invocation without --all or with a target", () => {
    for (const argv of [["list-harnesses"], ["list-harnesses", "--all", "opencode"]]) {
      const result = spawnSync(
        process.execPath,
        [path.join(repositoryRoot, "runtime", "operator-cli.mjs"), ...argv],
        { encoding: "utf8", env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: "", CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: "" } }
      );
      assert.equal(result.status, 1, argv.join(" "));
      assert.match(result.stderr, /requires explicit --all/);
    }
  });
});
