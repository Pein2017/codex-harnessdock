/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 9.2 of add-opencode-explorer-driver: the failure matrix at the COMPOSED
 * level -- what a caller entering through MCP actually observes when a turn
 * goes wrong, and what the durable layer holds afterwards.
 *
 * Task 5 already proved each Driver-level classification against the Driver.
 * Re-proving those here would duplicate, not compose. What only this level can
 * answer is different: does the closed classification survive the MCP boundary
 * without leaking, does an uncertain submission hold its leases and publish
 * nothing, does a lost worker avoid inventing a restart, and is the durable
 * reconciliation that follows idempotent.
 *
 * Every Server here is a fake on an ephemeral loopback port.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/index.mjs";
import { createAgentRuntime as createInternalAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { createCcMcpServer } from "../../runtime/mcp-server.mjs";
import { createAgentStore } from "../../runtime/agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import { inspectLeaseInventory } from "../../runtime/instance-admission-lease.mjs";

import { listVersionThreeJobRecords } from "../../runtime/v3-job-store.mjs";
import { readUnreadCompletionEvents } from "../../runtime/completion-inbox.mjs";
import {
  OPENCODE_EXPLORER_MODEL,
  OPENCODE_EXPLORER_MODEL_ID,
  OPENCODE_EXPLORER_MODEL_ROUTES,
  OPENCODE_EXPLORER_PROFILE_NAME,
  OPENCODE_EXPLORER_PROVIDER_ID,
  OPENCODE_HARNESS_ID,
} from "../../runtime/opencode-explorer-profile.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const RUNTIME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cc-failures-home-"));
const CODEX_HOME = path.join(RUNTIME_HOME, "codex-home");
process.on("exit", () => fs.rmSync(RUNTIME_HOME, { recursive: true, force: true }));

const SECRET_USERNAME = "explorer-operator";
const SECRET_PASSWORD = "hunter2-never-projected";

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

function explorerAgentBody(overrides = {}) {
  return [{
    name: OPENCODE_EXPLORER_PROFILE_NAME,
    mode: "primary",
    native: false,
    permission: compliantRuleset(),
    model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
    options: {},
    ...overrides,
  }];
}

function providerBody(overrides = {}) {
  const providers = [...new Set(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.providerId))];
  return {
    all: providers.map((providerId) => ({
      id: providerId,
      models: Object.fromEntries(
        OPENCODE_EXPLORER_MODEL_ROUTES
          .filter((route) => route.providerId === providerId)
          .map((route) => [route.modelId, {
            id: route.modelId,
            providerID: route.providerId,
            variants: { high: {} },
          }])
      ),
    })),
    connected: providers,
    default: {},
    ...overrides,
  };
}

async function startFake(scenario = {}) {
  const server = createFakeOpencodeServer({
    health: { status: 200, body: { healthy: true, version: "1.18.25" } },
    config: { status: 200, body: { default_agent: OPENCODE_EXPLORER_PROFILE_NAME } },
    agents: { status: 200, body: explorerAgentBody() },
    provider: { status: 200, body: providerBody() },
    ...scenario,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

let rootSequence = 0;
function setup(serverUrl, { secrets = false } = {}) {
  rootSequence += 1;
  const ownerRootId = `failures-root-${process.pid}-${rootSequence}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-failures-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const envFile = path.join(root, "runtime.env");
  fs.writeFileSync(envFile, `OPENCODE_SERVER_URL=${serverUrl}\n`);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    // This suite passes an explicit environment object, so carry the preload's
    // stable Plugin-data isolation root into the detached worker as well.
    CODEX_HOME,
    CODEX_THREAD_ID: ownerRootId,
    CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: ownerRootId,
    CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
    // Basic-auth credentials are inherited from the operator process
    // environment only, never from the tracked file.
    ...(secrets
      ? { OPENCODE_SERVER_USERNAME: SECRET_USERNAME, OPENCODE_SERVER_PASSWORD: SECRET_PASSWORD }
      : {}),
  };
  return {
    ownerRootId,
    workspace,
    env,
    envFile,
    runtime: createAgentRuntime({ cwd: workspace, envFile, env }),
    internalRuntime: () => createInternalAgentRuntime({ cwd: workspace, envFile, env }),
    store: () => createAgentStore({
      cwd: workspace,
      ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
    }),
  };
}

async function mcpClientFor(runtime) {
  const server = createCcMcpServer({ runtimeFactory: () => runtime });
  const client = new Client({ name: "composed-failures", version: "0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** Every instance-lease holder one owner root holds right now. */
function heldInstanceLeases(ownerRootId) {
  return inspectLeaseInventory({ kinds: ["instance"] }).entries
    .flatMap((entry) => entry.holders ?? [])
    .filter((holder) => holder.ownerRootId === ownerRootId);
}

function meta(workspace, ownerRootId) {
  return {
    threadId: ownerRootId,
    "codex/sandbox-state-meta": { sandboxCwd: new URL(`file://${workspace}`).href },
  };
}

function spawnArgs(overrides = {}) {
  return {
    task_name: "failing_turn",
    message: "Name the module that owns the static Driver table.",
    harness: OPENCODE_HARNESS_ID,
    model: OPENCODE_EXPLORER_MODEL,
    reasoning_effort: "high",
    topology: "leaf",
    write: false,
    ...overrides,
  };
}

/** One spawn attempt through MCP, returning the raw tool result. */
async function attemptSpawn(context, overrides = {}) {
  const client = await mcpClientFor(context.runtime);
  return client.callTool({
    name: "spawn_agent",
    arguments: spawnArgs(overrides),
    _meta: meta(context.workspace, context.ownerRootId),
  });
}

function refusalTextOf(result) {
  assert.equal(result.isError, true, "the attempt must be refused");
  return result.content.map((entry) => entry.text ?? "").join(" ");
}

// ---------------------------------------------------------------------------
// Route-time failures: what a caller sees, and what durable state does not gain.
// ---------------------------------------------------------------------------

describe("Task 9.2 — route-time failures refuse through MCP without durable residue", () => {
  const cases = [
    {
      name: "authentication",
      scenario: { auth: { username: SECRET_USERNAME, password: "a-different-password" } },
      expect: /not ready|no ready logical instance/i,
    },
    {
      name: "a provider that does not serve the pinned model",
      scenario: { provider: { status: 200, body: providerBody({ all: [], connected: [] }) } },
      expect: /no ready logical instance/i,
    },
    {
      name: "a Server that is unreachable",
      scenario: null,
      expect: /no ready logical instance/i,
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name} and creates no Agent`, async () => {
      const url = testCase.scenario === null
        ? "http://127.0.0.1:4599"
        : (await startFake(testCase.scenario)).url;
      const context = setup(url, { secrets: true });

      const refusal = refusalTextOf(await attemptSpawn(context));
      assert.match(refusal, testCase.expect);

      // Nothing durable exists for a refused route.
      assert.deepEqual(context.store().listAgents(), []);
      assert.deepEqual(
        listVersionThreeJobRecords({ ownerRootId: context.ownerRootId }).records,
        [],
      );
      assert.deepEqual(heldInstanceLeases(context.ownerRootId), []);

      // No credential, endpoint, or operator path crosses the MCP boundary.
      assert.equal(refusal.includes(SECRET_PASSWORD), false);
      assert.equal(refusal.includes(SECRET_USERNAME), false);
      assert.equal(refusal.includes(url), false);
      assert.equal(refusal.includes(context.workspace), false);
      assert.doesNotMatch(refusal, /authorization|password|username|basic /i);
    });
  }
});

// ---------------------------------------------------------------------------
// An unreadable answer versus an unprovable submission. These settle
// differently on purpose, and the difference is what leases turn on.
// ---------------------------------------------------------------------------

/** Wait for the worker to leave `running`, and return its durable record. */
async function settledRecord(ownerRootId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [candidate] = listVersionThreeJobRecords({ ownerRootId }).records;
    if (candidate && candidate.status !== "running") return candidate;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

describe("Task 9.2 — an unreadable answer settles as a proven failure", () => {
  it("publishes a closed failure, invents no final text, and releases its lease", async () => {
    // The prompt request completed; its body cannot be read as a result. The
    // turn demonstrably ran, so this is a settled failure, not uncertainty.
    const { server, url } = await startFake({ promptMalformed: true });
    const context = setup(url);
    const client = await mcpClientFor(context.runtime);

    const spawned = await client.callTool({
      name: "spawn_agent",
      arguments: spawnArgs({ task_name: "malformed_turn" }),
      _meta: meta(context.workspace, context.ownerRootId),
    });
    assert.notEqual(spawned.isError, true, `an accepted route still spawns: ${JSON.stringify(spawned)}`);

    const record = await settledRecord(context.ownerRootId);
    assert.ok(record, "the worker records the turn it submitted");
    assert.equal(record.status, "failed");
    // Which closed class a given Driver fact produces is Task 5's; what this
    // level owns is that the caller receives a closed classification at all,
    // asserted on the public receipt below.

    // The caller is told it failed, and is never handed invented output.
    const waited = await client.callTool({
      name: "wait_agent",
      arguments: {},
      _meta: meta(context.workspace, context.ownerRootId),
    });
    assert.notEqual(waited.isError, true);
    const update = JSON.parse(waited.content.find((entry) => entry.type === "text").text).update;
    assert.equal(update.kind, "completion");
    assert.equal(update.agent_status, "failed");
    assert.ok(update.blocking, "a failed turn carries closed blocking evidence");
    assert.equal(update.blocking.retry, "new_agent");

    // Settlement is proven, so the instance is free again.
    assert.deepEqual(heldInstanceLeases(context.ownerRootId), []);
    assert.equal(server.requests.some((request) => request.method === "POST"), true);

    // No credential or endpoint reaches the caller through a failure path.
    const seen = JSON.stringify([spawned, waited]);
    assert.equal(seen.includes(url), false);
    assert.doesNotMatch(seen, /password|username|authorization/i);
  });
});

describe("Task 9.2 — an unprovable submission publishes nothing and holds its leases", () => {
  it("records uncertainty, leaves the inbox empty, and retains the instance", async () => {
    // The connection is destroyed mid-prompt. Nobody can prove whether the
    // Harness received and ran that turn, so nothing may be published either
    // way and the instance stays held.
    const { server, url } = await startFake({ promptDestroy: true });
    const context = setup(url);
    const client = await mcpClientFor(context.runtime);

    const spawned = await client.callTool({
      name: "spawn_agent",
      arguments: spawnArgs({ task_name: "uncertain_turn" }),
      _meta: meta(context.workspace, context.ownerRootId),
    });
    assert.notEqual(spawned.isError, true, `an accepted uncertain route still spawns: ${JSON.stringify(spawned)}`);

    const record = await settledRecord(context.ownerRootId);
    assert.ok(record, "the worker records the turn it submitted");
    assert.equal(record.status, "unknown");

    // Nothing published: a caller is never told an outcome nobody can prove.
    assert.deepEqual(
      readUnreadCompletionEvents(context.workspace, context.ownerRootId).events
        .map((event) => event.jobId),
      [],
    );

    // The instance lease is RETAINED, which is what keeps a second turn off an
    // instance whose first turn's outcome is unknown.
    const held = heldInstanceLeases(context.ownerRootId);
    assert.equal(held.length, 1, "an unknown settlement holds exactly its own instance lease");
    assert.equal(held[0].harnessId, OPENCODE_HARNESS_ID);

    // The submission did reach the Server; the uncertainty is about its answer.
    assert.equal(server.requests.some((request) => request.method === "POST"), true);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation is idempotent and observes no restart.
// ---------------------------------------------------------------------------

describe("Task 9.2 — reconciliation repeats without inventing a turn", () => {
  it("is byte-identical across repeated passes and starts nothing", async () => {
    const { server, url } = await startFake();
    const context = setup(url);
    const client = await mcpClientFor(context.runtime);

    await client.callTool({
      name: "spawn_agent",
      arguments: spawnArgs({ task_name: "reconciled_turn" }),
      _meta: meta(context.workspace, context.ownerRootId),
    });
    const completion = await client.callTool({
      name: "wait_agent",
      arguments: {},
      _meta: meta(context.workspace, context.ownerRootId),
    });
    assert.notEqual(completion.isError, true);

    const settled = JSON.stringify(context.store().listAgents());
    const requestsAfterTurn = server.requests.length;

    // Two further reconciliation passes through a fresh internal runtime, the
    // way startup recovery runs one.
    const first = context.internalRuntime().reconcile();
    const second = context.internalRuntime().reconcile();
    assert.deepEqual(second, first, "a repeated pass observes the same facts");
    assert.equal(JSON.stringify(context.store().listAgents()), settled, "and rewrites nothing");

    // No restart observation: reconciliation never re-submits a settled turn.
    assert.equal(server.requests.length, requestsAfterTurn, "reconciliation contacts no Server");
    const records = listVersionThreeJobRecords({ ownerRootId: context.ownerRootId }).records;
    assert.equal(records.length, 1, "one turn stays one record");
    assert.equal(records[0].status, "completed");
  });
});
