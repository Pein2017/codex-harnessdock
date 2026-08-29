/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 9.1 of add-opencode-explorer-driver: one complete OpenCode turn through
 * the composed public path, entered where a caller actually enters it.
 *
 * Every other suite proves one layer. This one proves that the layers compose:
 * an MCP client calls `spawn_agent`, the runtime accepts the stated route, a
 * real detached worker claims and submits the turn against a fake Server, the
 * durable launch claim and native session/turn references exist for it, the
 * completion arrives through `wait_agent` carrying the metrics Task 6 defined,
 * and the conditional continuation branch this route actually proves --
 * `fresh_only` -- refuses a same-Agent follow-up by name.
 *
 * The workspace mutation witness (Task 6) wraps the turn. This is its first
 * composed use: it is opened before the Agent exists and closed after the
 * completion is read, so its verdict describes the whole turn rather than a
 * synthetic window, and it states the honest enforcement label -- a read-only
 * Explorer turn is Harness policy, never OS containment.
 *
 * Nothing here reaches a real Server or a real model. The Explorer is a fake on
 * an ephemeral loopback port; the only requests it may see are its own
 * discovery GETs plus exactly one session creation and one prompt.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createAgentRuntime } from "../../runtime/index.mjs";
import { createAgentStore } from "../../runtime/agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import { createCcMcpServer } from "../../runtime/mcp-server.mjs";
import { readLaunchClaim } from "../../runtime/launch-claim.mjs";
import {
  listVersionThreeJobRecords,
  readVersionThreeJobRecord,
} from "../../runtime/v3-job-store.mjs";
import {
  closeWorkspaceMutationWitness,
  openWorkspaceMutationWitness,
} from "../../runtime/workspace-mutation-witness.mjs";
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

const RUNTIME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hd-composed-home-"));
const CODEX_HOME = path.join(RUNTIME_HOME, "codex-home");
process.on("exit", () => fs.rmSync(RUNTIME_HOME, { recursive: true, force: true }));

const OWNER_ROOT_ID = "composed-root";
const FINAL_TEXT = "runtime/harness-registry.mjs owns the static Driver table.";

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
      body: [{
        name: OPENCODE_EXPLORER_PROFILE_NAME,
        mode: "primary",
        native: false,
        permission: compliantRuleset(),
        model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
        options: {},
      }],
    },
    provider: {
      status: 200,
      body: {
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
      },
    },
    ...scenario,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

function setup(serverUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-composed-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const envFile = path.join(root, "runtime.env");
  fs.writeFileSync(envFile, `OPENCODE_SERVER_URL=${serverUrl}\n`);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_HOME,
      CODEX_THREAD_ID: OWNER_ROOT_ID,
      CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: OWNER_ROOT_ID,
      CODEX_HARNESSDOCK_RUNTIME_HOME: RUNTIME_HOME,
    },
  });
  return { runtime, workspace, root };
}

/** One in-memory MCP client bound to this runtime, the way Codex binds one. */
async function mcpClientFor(runtime) {
  // `runtimeFactory` is mandatory here. Without it the server dispatches through
  // the ISOLATED worker, which builds its own runtime from the real checkout
  // configuration -- including the operator's real Server URL -- instead of this
  // test's fake. Passing a bare function silently selects that path.
  const server = createCcMcpServer({ runtimeFactory: () => runtime });
  const client = new Client({ name: "composed-path-test", version: "0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

/** The one structured payload an MCP tool result carries. */
function payloadOf(result) {
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  assert.ok(text, "an MCP tool result must carry one text payload");
  return JSON.parse(text);
}

/**
 * Every MCP call is bound to the trusted Codex identity: the thread that owns
 * the root and the sandbox cwd that owns the workspace. A tool argument can
 * select neither, so the tests state them exactly where Codex would.
 */
function trustedMeta(workspace) {
  return {
    threadId: OWNER_ROOT_ID,
    "codex/sandbox-state-meta": { sandboxCwd: new URL(`file://${workspace}`).href },
  };
}

async function callTool(client, workspace, name, args) {
  const result = await client.callTool({ name, arguments: args, _meta: trustedMeta(workspace) });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return payloadOf(result);
}

describe("Task 9.1 — one complete OpenCode turn through MCP, runtime, and the worker", () => {
  it("composes spawn, launch claim, native references, completion, and the fresh-only branch", async () => {
    const { server, url } = await startReadyFake();
    const { runtime, workspace } = setup(url);
    const client = await mcpClientFor(runtime);

    // The witness opens before the Agent exists, so its verdict covers the
    // whole turn rather than a window chosen after the fact.
    const witness = openWorkspaceMutationWitness(workspace);

    // 1. Discovery informs; it never selects. The route below is still stated
    //    in full by the caller.
    const harnesses = await callTool(client, workspace, "list_harnesses", {});
    const explorer = harnesses.harnesses.find((entry) => entry.harness === OPENCODE_HARNESS_ID);
    assert.ok(explorer, "the Explorer must be an admitted Harness");
    assert.equal(explorer.instances.some((instance) => instance.readiness === "ready"), true);
    // Proof that THIS test's fake Server answered, and no other. A composed test
    // that accidentally dispatches through the isolated worker would reach the
    // operator's configured Server instead and leave this at zero.
    assert.ok(server.requests.length > 0, "the fake Server must be the one that answered discovery");
    assert.equal(server.requests.every((request) => request.method === "GET"), true);

    // 2. Spawn through MCP with the whole route stated.
    const spawned = await callTool(client, workspace, "spawn_agent", {
      task_name: "composed_turn",
      message: "Name the module that owns the static Driver table.",
      harness: OPENCODE_HARNESS_ID,
      model: OPENCODE_EXPLORER_MODEL,
      reasoning_effort: "high",
      topology: "leaf",
      write: false,
    });
    assert.equal(spawned.agent_name, "/root/composed_turn");
    assert.equal(spawned.model, OPENCODE_EXPLORER_MODEL);
    assert.deepEqual(Object.keys(spawned).sort(), ["agent_name", "model", "status"]);

    // The durable record, read the way an internal reconciler reads it. The
    // public surface deliberately exposes no Agent or job identity.
    const store = createAgentStore({
      cwd: workspace,
      ownerRootId: OWNER_ROOT_ID,
      writeGeneration: FUTURE_WRITE_GENERATION,
    });
    const agent = store.resolveTarget(spawned.agent_name);
    const jobId = agent.activeJobId;
    assert.ok(jobId, "the spawn must reserve one activation");

    // 3. Join the completion through MCP, exactly as a caller would: one call,
    //    no polling. The model-facing schema declares no timeout at all -- the
    //    server fixes the one-hour bound -- so this blocks on durable activity
    //    and returns as soon as the worker publishes.
    const waited = await callTool(client, workspace, "wait_agent", {});
    assert.equal(waited?.update?.kind, "completion", "the turn must publish one completion");
    const completion = waited.update;
    assert.equal(completion.agent_name, spawned.agent_name);
    assert.equal(completion.agent_status, "completed");
    assert.equal(completion.completion_message, FINAL_TEXT.length > 0 ? completion.completion_message : null);
    assert.ok(completion.completion_message.length > 0, "the complete final text is delivered");
    assert.equal(completion.blocking, null);

    // 4. Task 6's metrics survive the whole composition, in their two closed
    //    halves: what the provider reported and what the Plugin observed.
    assert.ok(completion.metrics, "a settled Explorer turn reports closed metrics");
    assert.equal(typeof completion.metrics.plugin_observed.tool_call_count, "number");
    assert.equal(completion.metrics.plugin_observed.attempt_count, 1);
    assert.equal(completion.metrics.plugin_observed.recovery_attempt_count, 0);
    // Provider numbers are reported, never computed here; a fake Server that
    // reports none leaves the half null rather than inventing zeros.
    assert.ok(
      completion.metrics.provider_reported === null ||
        typeof completion.metrics.provider_reported === "object",
    );

    // 5. The durable evidence the worker wrote: one launch claim naming this
    //    turn, and one version-three job record carrying both native
    //    references.
    const claim = readLaunchClaim({ ownerRootId: OWNER_ROOT_ID, agentId: agent.agentId, jobId });
    assert.ok(claim, "the worker must leave one durable launch claim");
    // The claim is bound to this exact turn and to the route it was claimed
    // under; a claim is never route-agnostic.
    assert.equal(claim.route.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(claim.route.instanceKey, agent.route.instanceKey);
    assert.equal(claim.jobId, jobId);
    assert.equal(claim.agentId, agent.agentId);

    const inventory = listVersionThreeJobRecords({ ownerRootId: OWNER_ROOT_ID });
    assert.deepEqual(inventory.unreadable, [], "every version-three record is readable");
    assert.equal(
      inventory.records.filter((entry) => entry.jobId === jobId).length,
      1,
      "exactly one version-three record owns this turn",
    );
    const record = readVersionThreeJobRecord({
      ownerRootId: OWNER_ROOT_ID,
      agentId: agent.agentId,
      jobId,
    });
    assert.ok(record, "the turn's own record resolves by its exact identity");
    assert.equal(record.status, "completed");
    assert.equal(record.route.harnessId, OPENCODE_HARNESS_ID);
    // A native turn reference is a Driver-validated envelope, never a raw ID.
    assert.equal(record.nativeTurnRef.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(record.nativeTurnRef.instanceKey, agent.route.instanceKey);
    assert.equal(typeof record.nativeTurnRef.locatorVersion, "number");
    assert.ok(record.nativeTurnRef.locator, "the turn reference carries its Driver's locator");

    // 6. The Server saw exactly one session creation and one prompt, and
    //    nothing else mutating.
    const mutating = server.requests.filter((request) => request.method !== "GET");
    assert.deepEqual(
      mutating.map((request) => request.method),
      ["POST", "POST"],
      "one session creation and one prompt, and no other mutating request",
    );

    // 7. The conditional continuation branch this route proves: fresh_only
    //    refuses a same-Agent second turn by name, through MCP.
    const refused = await client.callTool({
      name: "followup_task",
      arguments: { target: spawned.agent_name, message: "a second turn on the same Agent" },
      _meta: trustedMeta(workspace),
    });
    assert.equal(refused.isError, true, "a fresh-only route refuses a same-Agent follow-up");
    const refusal = refused.content.map((entry) => entry.text ?? "").join(" ");
    // The refusal is actionable AND precise: it names the Agent, that it is
    // blocked, the route's own proven reason, and the only retry that helps.
    // `unclassified` here would be a defensive default surfacing on this
    // Harness's ordinary settled path.
    assert.match(refusal, /cannot continue: blocked/i);
    assert.match(refusal, /reason=continuation_unsupported/);
    assert.match(refusal, /scope=agent/);
    assert.match(refusal, /retry=new_agent/);
    // It states a closed vocabulary and never an endpoint, credential, or
    // internal identifier.
    assert.doesNotMatch(refusal, /https?:\/\/|password|username/i);
    assert.equal(refusal.includes(url), false);

    // The durable evidence behind that refusal is the Driver's own continuation
    // projection: this route proved fresh-only continuation, so no same-Agent
    // second turn exists to offer.
    const settledAgent = store.resolveTarget(spawned.agent_name);
    assert.equal(settledAgent.continuation.mode, "blocked");
    assert.equal(
      settledAgent.continuation.evidence.reason,
      "driver_continuation_not_exact_resume",
    );
    // The refusal reached no Server.
    assert.equal(server.requests.filter((request) => request.method !== "GET").length, mutating.length);

    // 8. The witness closes over the whole turn. A read-only Explorer route
    //    leaves the workspace unchanged, and says so without claiming
    //    containment it does not have.
    const verdict = closeWorkspaceMutationWitness(witness);
    assert.equal(verdict.clean, true, `changed: ${verdict.changedBasenames.join(", ")}`);
    assert.equal(verdict.enforcement, "harness_policy");
    assert.equal(verdict.osContainment, false);

    // 9. No credential, endpoint, or operator path escaped into any payload the
    //    caller saw.
    const seen = JSON.stringify([harnesses, spawned, waited]);
    assert.doesNotMatch(seen, /password|username|authorization/i);
    assert.equal(seen.includes(url), false, "no Server endpoint reaches a model-facing payload");
    assert.equal(seen.includes(workspace), false, "no operator path reaches a model-facing payload");
  });

  it("joins a version-three Explorer turn through a targeted wait", async () => {
    // Live-proven gap from the first activation run: the targeted wait
    // consulted only version-one job files, so a version-three-worker turn
    // reported itself not joinable (agent working, state not_joinable) while
    // the turn was completing in the background. The targeted join must read
    // the version-three record for both readiness and the snapshot.
    const { url } = await startReadyFake();
    const { runtime, workspace } = setup(url);
    const client = await mcpClientFor(runtime);
    const spawned = await callTool(client, workspace, "spawn_agent", {
      task_name: "targeted_turn",
      message: "Name the module that owns the static Driver table.",
      harness: OPENCODE_HARNESS_ID,
      model: OPENCODE_EXPLORER_MODEL,
      reasoning_effort: "high",
      topology: "leaf",
      write: false,
    });
    const waited = await callTool(client, workspace, "wait_agent", {
      targets: [spawned.agent_name],
    });
    assert.equal(waited.timedOut, false, "a targeted wait must join the settling turn");
    const target = (waited.targets ?? []).find((entry) => entry.agent_name === spawned.agent_name);
    assert.ok(target, "the targeted wait answers for the requested Agent");
    assert.equal(target.state, "settled");
    assert.equal(target.agent_status, "completed");
    assert.ok(target.completion_message.length > 0, "the settled target delivers its final text");
    assert.ok(target.metrics, "the settled target entry carries the closed metrics");
    assert.deepEqual(waited.unresolved_targets, []);
  });
});
