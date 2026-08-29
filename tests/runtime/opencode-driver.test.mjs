/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 5 of add-opencode-explorer-driver: launch, session, and turn lineage.
 *
 * Every request in this suite goes to a fake OpenCode Server started on an
 * ephemeral loopback port by `fixtures/fake-opencode-server.mjs`. Nothing here
 * touches the operator's configured Server, and no live model or session
 * request is made anywhere: the fake implements exactly the two mutating routes
 * the pinned SDK's `session.create`/`session.prompt` use, and the runtime's own
 * admission gate blocks every other method and path before the network.
 *
 * The Driver is exercised through the real Phase A seams -- `createDriverScope`
 * for the least-authority scope, `validateDriverV2`/`validateCanonicalRoute`/
 * `validatePreparedTurn`/`validateLiveHarnessTurn`/`durableTurnEvidence`/
 * `validateNormalizedTerminalResult` for every boundary -- so a shape this
 * suite accepts is a shape the supervisor accepts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  DRIVER_CONTRACT_VERSION_V2,
  admittedDriverDescription,
  durableTurnEvidence,
  isDriverPreTransportRejection,
  validateCanonicalRoute,
  validateDriverV2,
  validateInstanceInspection,
  validateLiveHarnessTurn,
  validateNormalizedTerminalResult,
  validatePreparedTurn,
} from "../../runtime/harness-contract.mjs";
import { createDriverScope } from "../../runtime/harness-registry.mjs";
import {
  OPENCODE_DRIVER_ENVIRONMENT_KEYS,
  OPENCODE_DRIVER_VERSION,
  OPENCODE_SESSION_LOCATOR_KEYS,
  OPENCODE_TURN_LOCATOR_KEYS,
  OpencodeTurnError,
  createOpencodeDriver,
  opencodeHeldCapacity,
} from "../../runtime/opencode-driver.mjs";
import {
  OPENCODE_EXPLORER_AUTHORITY,
  OPENCODE_EXPLORER_CAPABILITIES,
  OPENCODE_EXPLORER_MODEL,
  OPENCODE_EXPLORER_MODEL_ID,
  OPENCODE_EXPLORER_MODELS,
  OPENCODE_EXPLORER_MODEL_ROUTES,
  OPENCODE_EXPLORER_PROFILE_NAME,
  OPENCODE_EXPLORER_PROVIDER_ID,
  OPENCODE_EXPLORER_TOPOLOGY,
  OPENCODE_HARNESS_ID,
  opencodeExplorerInstanceKey,
} from "../../runtime/opencode-explorer-profile.mjs";
import { OPENCODE_MAX_FINAL_TEXT_CHARS } from "../../runtime/opencode-result.mjs";
import { OPENCODE_PROMPT_PREFIX_VERSION } from "../../runtime/opencode-prompt.mjs";
import {
  createFakeOpencodeServer,
  fakeAssistantMessage,
  fakeTextPart,
} from "./fixtures/fake-opencode-server.mjs";
import { inspectInstancesWithOneTransportRetry } from "./fixtures/bounded-transport-retry.mjs";

const WORKSPACE_ROOT = "/opt/operator-owned/workspace";
const TASK_INPUT = "Map how the static Driver registry admits a Harness.";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    await cleanup();
  }
});

/** A resolved profile whose effective policy satisfies Task 3's validation. */
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

function readyAgents(overrides = {}) {
  return {
    status: 200,
    body: [
      {
        name: OPENCODE_EXPLORER_PROFILE_NAME,
        description: "Read-only repository Explorer.",
        mode: "primary",
        native: false,
        permission: compliantRuleset(),
        model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
        options: {},
        ...overrides,
      },
    ],
  };
}

function readyProvider() {
  const providers = [...new Set(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.providerId))];
  return {
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
              name: route.model,
              family: null,
              variants: { high: {} },
            }])
        ),
      })),
      connected: providers,
      default: {},
    },
  };
}

async function startFake(scenario = {}) {
  const server = createFakeOpencodeServer({
    health: { status: 200, body: { healthy: true, version: "1.18.23" } },
    config: { status: 200, body: { default_agent: OPENCODE_EXPLORER_PROFILE_NAME } },
    agents: readyAgents(),
    provider: readyProvider(),
    ...scenario,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

function driverFor(url, options = {}) {
  return createOpencodeDriver({
    env: { OPENCODE_SERVER_URL: url },
    serviceManager: { ensure: async () => ({ status: "reused" }) },
    ...options,
  });
}

function routeRequest(model = OPENCODE_EXPLORER_MODEL) {
  return {
    harnessId: OPENCODE_HARNESS_ID,
    model,
    topology: OPENCODE_EXPLORER_TOPOLOGY,
    authority: OPENCODE_EXPLORER_AUTHORITY,
    effort: "high",
  };
}

/** Route + prepared turn + scope, each through its real contract validator. */
async function acceptedTurn(driver, url, {
  taskInput = TASK_INPUT,
  model = OPENCODE_EXPLORER_MODEL,
  authority = OPENCODE_EXPLORER_AUTHORITY,
  scopeOverrides = {},
} = {}) {
  // Setup, not the scenario: every caller of this helper is asserting something
  // downstream of a ready instance, so one transport-class reading of its own
  // just-started fake Server is re-observed rather than failing the scenario.
  const [inspection] = await inspectInstancesWithOneTransportRetry(
    driver,
    createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url }, workspaceRoot: WORKSPACE_ROOT })
  );
  const request = routeRequest(model);
  request.authority = authority;
  const route = validateCanonicalRoute(driver.validateRoute(request, inspection), { driver, inspection, request });
  const preparedTurn = validatePreparedTurn(driver.prepareTurn({ route, taskInput, turnOptions: { effort: route.effort } }), {
    driver,
    route,
    taskInput,
  });
  const scope = createDriverScope({
    driver,
    purpose: "turn",
    rootId: "root_1",
    agentId: "agent_1",
    turnId: "job_1",
    attemptId: "att_1",
    route,
    taskInput,
    workspaceRoot: WORKSPACE_ROOT,
    env: { OPENCODE_SERVER_URL: url },
    ...scopeOverrides,
  });
  return { inspection, request, route, preparedTurn, scope };
}

async function launch(driver, url, options = {}) {
  const accepted = await acceptedTurn(driver, url, options);
  const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
  const rawLive = await driver.startTurn({
    scope: accepted.scope,
    preparedTurn: accepted.preparedTurn,
    launchContext,
    ...(options.nativeSessionRef ? { nativeSessionRef: options.nativeSessionRef } : {}),
  });
  const live = validateLiveHarnessTurn(rawLive, { driver, route: accepted.route });
  return { ...accepted, launchContext, live };
}

function postRequests(server) {
  return server.requests.filter((request) => request.method === "POST");
}

function collectStrings(value, sink = []) {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, sink);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, sink);
  return sink;
}

function assertNoDisclosure(value, label) {
  for (const text of collectStrings(value)) {
    assert.equal(text.startsWith("/"), false, `${label} disclosed an absolute path: ${text}`);
    assert.equal(text.includes(WORKSPACE_ROOT), false, `${label} disclosed the workspace: ${text}`);
    assert.equal(text.includes(TASK_INPUT), false, `${label} disclosed the task text`);
    assert.equal(/password|secret|authorization|basic /i.test(text), false, `${label} disclosed a credential: ${text}`);
    assert.equal(/127\.0\.0\.1|http:\/\//.test(text), false, `${label} disclosed an endpoint: ${text}`);
  }
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Contract composition and the deliberately absent surface (5.5).
// ---------------------------------------------------------------------------

describe("opencode driver: contract surface", () => {
  it("is an admitted Driver Contract v2 Driver", async () => {
    const { url } = await startFake();
    const driver = driverFor(url);
    assert.equal(validateDriverV2(driver), driver);
    const description = admittedDriverDescription(driver);
    assert.equal(description.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(description.driverVersion, OPENCODE_DRIVER_VERSION);
    assert.equal(description.contractVersion, DRIVER_CONTRACT_VERSION_V2);
    assert.equal(description.maturity, "experimental");
    assert.deepEqual([...description.environmentKeys], [...OPENCODE_DRIVER_ENVIRONMENT_KEYS]);
  });

  it("exposes no observation, history, interrupt, active-input, recovery, or write method", async () => {
    const { url } = await startFake();
    const driver = driverFor(url);
    for (const method of [
      "observeTurn",
      "readAssistantHistory",
      "deliverActiveInput",
      "requestInterrupt",
      "abortTurn",
      "resumeTurn",
      "recoverTurn",
      "writeWorkspace",
      "approve",
    ]) {
      assert.equal(method in driver, false, `driver must not expose ${method}`);
    }
    assert.equal(Object.isFrozen(driver), true);
  });

  it("declares no credential-shaped environment key", async () => {
    const { url } = await startFake();
    for (const key of driverFor(url).describe().environmentKeys) {
      assert.equal(/TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|APIKEY|API_KEY|_KEY|AUTH/.test(key), false, key);
    }
  });
});

// ---------------------------------------------------------------------------
// Readiness and route admission, before any session can exist.
// ---------------------------------------------------------------------------

describe("opencode driver: readiness and route admission", () => {
  it("ensures before its immediate pre-spawn discovery", async () => {
    const { url } = await startFake();
    let ensures = 0;
    const driver = driverFor(url, { serviceManager: { ensure: async () => { ensures += 1; } } });
    const { preparedTurn, scope } = await acceptedTurn(driver, url);
    await driver.revalidatePreparedTurn(preparedTurn, scope);
    assert.equal(ensures, 1);
  });

  it("reports one ready instance using GET-only discovery", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url }, workspaceRoot: WORKSPACE_ROOT })
    );
    assert.equal(inspection.readiness, "ready");
    assert.equal(inspection.instanceKey, opencodeExplorerInstanceKey(url));
    assert.deepEqual(postRequests(server), []);
    assert.equal(server.requests.every((request) => request.method === "GET"), true);
    assert.deepEqual(server.requests.map((request) => request.path), ["/global/health", "/provider", "/config", "/agent"]);
    assert.equal(server.requests.find((request) => request.path === "/provider")?.query.directory, WORKSPACE_ROOT);
  });

  it("replaces the whole OpenCode projection when a model disappears and records only opaque test drift", async () => {
    const { server, url } = await startFake();
    const generations = [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`];
    const driver = driverFor(url, { _test: { inspectionGeneration: () => generations.shift() } });
    const scope = createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url }, workspaceRoot: WORKSPACE_ROOT });
    const [first] = await driver.inspectInstances(scope);
    const next = readyProvider();
    next.body.all[0].models = {
      "gpt-5.6-terra": next.body.all[0].models["gpt-5.6-terra"],
    };
    server.state.provider = next;
    const [second] = await driver.inspectInstances(scope);
    assert.equal(first.inspectionGeneration, `sha256:${"a".repeat(64)}`);
    assert.equal(second.inspectionGeneration, `sha256:${"b".repeat(64)}`);
    assert.equal(Object.hasOwn(second.routes.effortsByModel, OPENCODE_EXPLORER_MODEL), false);
    assert.deepEqual(second.routes.models, ["openai/gpt-5.6-terra"]);
    assert.deepEqual(second.capabilityProvenance, first.capabilityProvenance);
  });

  it("does not advertise dormant CLI routes when the connected Server is absent", async () => {
    let discovered = 0;
    const driver = driverFor("http://127.0.0.1:4998", {
      nativeDiscovery: async () => {
        discovered += 1;
        return { ok: true, routes: [{ model: OPENCODE_EXPLORER_MODEL, efforts: ["high"] }] };
      },
    });
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4998" }, workspaceRoot: WORKSPACE_ROOT })
    );
    assert.equal(discovered, 0);
    assert.equal(inspection.readiness, "unavailable");
    assert.equal(inspection.liveValidated, false);
    assert.equal(inspection.detailCode, "service_unreachable");
    assert.throws(() => driver.validateRoute(routeRequest(), inspection));
  });

  it("blocks a scope that names another configured Server without any request", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4999" } })
    );
    assert.equal(inspection.readiness, "blocked");
    assert.equal(inspection.detailCode, "not_configured");
    assert.deepEqual(server.requests, []);
  });

  it("admits exactly the discovered route and refuses everything else", async () => {
    const { url } = await startFake();
    const driver = driverFor(url);
    const { route, request, inspection } = await acceptedTurn(driver, url);
    assert.deepEqual(validateCanonicalRoute(route, { driver, inspection, request }), route);
    assert.equal(route.model, OPENCODE_EXPLORER_MODEL);
    assert.equal(route.capabilities.values.continuation, "fresh_only");
    for (const bad of [
      { ...request, model: "opencode-go/deepseek" },
      { ...request, effort: "medium" },
      { ...request, topology: "native_orchestrator" },
      { ...request, reasoning_effort: "high" },
      { ...request, tools: { read: true } },
    ]) {
      assert.throws(() => driver.validateRoute(bad, inspection));
    }
  });

  it("rejects an orphaned OpenCode effort projection before any session request", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url }, workspaceRoot: WORKSPACE_ROOT })
    );
    const malformed = structuredClone(inspection);
    malformed.routes.effortsByModel["foreign-model"] = ["high"];
    assert.throws(() => validateInstanceInspection(malformed, driver), /exact keys/);
    assert.deepEqual(postRequests(server), []);
  });

  it("binds a non-default admitted model through native submission and result lineage", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const model = "openai/gpt-5.6-sol";
    assert.equal(OPENCODE_EXPLORER_MODELS.includes(model), true);
    const { live, route } = await launch(driver, url, { model });
    const outcome = await settled(live.result);
    assert.equal(outcome.ok, true);
    assert.equal(route.model, model);
    const posts = postRequests(server);
    assert.deepEqual(posts.map((request) => request.body?.model), [
      { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
      { providerID: "openai", modelID: "gpt-5.6-sol" },
    ]);
    assert.equal(posts[1].body.variant, "high");
    assert.equal(live.nativeTurnRef.locator.providerId, "openai");
    assert.equal(live.nativeTurnRef.locator.modelId, "gpt-5.6-sol");
  });

  it("refuses a route for an instance that is not ready", async () => {
    const { url } = await startFake({ provider: { status: 200, body: { all: [], connected: [], default: {} } } });
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url } })
    );
    assert.equal(inspection.readiness, "unavailable");
    assert.throws(
      () => driver.validateRoute(routeRequest(), inspection),
      (error) => error.code === "instance_not_ready"
    );
  });
});

// ---------------------------------------------------------------------------
// Prepared turns stay pure; revalidation is the pre-session gate.
// ---------------------------------------------------------------------------

describe("opencode driver: prepared turn and pre-session gate", () => {
  it("prepares one envelope-bound turn without touching the Server", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { route } = await acceptedTurn(driver, url);
    const before = server.requests.length;
    const prepared = validatePreparedTurn(driver.prepareTurn({ route, taskInput: TASK_INPUT, turnOptions: { effort: route.effort } }), {
      driver,
      route,
      taskInput: TASK_INPUT,
    });
    assert.equal(server.requests.length, before, "prepareTurn must make no request");
    assert.equal(prepared.promptEnvelope.taskInput, TASK_INPUT);
    assert.match(prepared.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(prepared.turnOptions, { effort: route.effort });
  });

  it("requires its accepted turn option, a native route, and usable task", async () => {
    const { url } = await startFake();
    const driver = driverFor(url);
    const { route } = await acceptedTurn(driver, url);
    assert.throws(
      () => driver.prepareTurn({ route, taskInput: TASK_INPUT, turnOptions: null }),
      (error) => error.code === "turn_options_not_admitted"
    );
    assert.throws(
      () => driver.prepareTurn({ route: { ...route, harnessId: "claude-code" }, taskInput: TASK_INPUT, turnOptions: { effort: route.effort } }),
      (error) => error.code === "foreign_route"
    );
    assert.throws(
      () => driver.prepareTurn({ route, taskInput: "   ", turnOptions: { effort: route.effort } }),
      (error) => error.code === "task_input_required"
    );
  });

  it("revalidates with GET-only discovery and returns a session-free launch context", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { preparedTurn, scope } = await acceptedTurn(driver, url);
    const launchContext = await driver.revalidatePreparedTurn(preparedTurn, scope);
    assert.equal(launchContext.readinessDetailCode, "ready");
    assert.equal(Object.isFrozen(launchContext), true);
    assert.deepEqual(postRequests(server), []);
  });

  it("rejects an Agent policy drift during the pre-session gate", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { preparedTurn, scope } = await acceptedTurn(driver, url);
    // The operator changes the native exception between route admission and launch.
    server.state.agents = readyAgents({
      permission: [...compliantRuleset().slice(0, -1), { permission: "doom_loop", pattern: "*", action: "ask" }],
    });
    await assert.rejects(
      () => driver.revalidatePreparedTurn(preparedTurn, scope),
      (error) => error.code === "interactive_policy" && !/doom_loop|ask/i.test(error.message)
    );
    assert.deepEqual(postRequests(server), []);
  });

  it("fails closed on a version, default-Agent, doom-loop, or duo-workflow witness failure", async () => {
    const cases = [
      { health: { status: 200, body: { healthy: true, version: "1.18.22" } } },
      { config: { status: 200, body: { default_agent: "missing" } } },
      { agents: readyAgents({ permission: [...compliantRuleset().slice(0, -1), { permission: "doom_loop", pattern: "*", action: "ask" }] }) },
      {
        provider: {
          status: 200,
          body: { all: [{ id: "gitlab", models: { "duo-workflow-test": { id: "duo-workflow-test", providerID: "gitlab", variants: { high: {} } } } }], connected: ["gitlab"], default: {} },
        },
      },
    ];
    for (const scenario of cases) {
      const { server, url } = await startFake(scenario);
      const driver = driverFor(url);
      const [inspection] = await driver.inspectInstances(
        createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url } })
      );
      assert.equal(inspection.readiness, "blocked");
      assert.equal(inspection.detailCode, "interactive_policy");
      assert.deepEqual(postRequests(server), []);
    }
  });

  it("uses only the visible primary build Agent when default_agent is absent", async () => {
    const { url } = await startFake({
      config: { status: 200, body: {} },
      agents: readyAgents({ name: "build" }),
    });
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url } })
    );
    assert.equal(inspection.readiness, "ready");
  });

  it("does not treat an ordinary native ask as blocking under the session wildcard", async () => {
    const { url } = await startFake({
      agents: readyAgents({ permission: [...compliantRuleset(), { permission: "edit", pattern: "*", action: "ask" }] }),
    });
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url } })
    );
    assert.equal(inspection.readiness, "ready");
  });

  it("fails the gate closed when the scope names another Server", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { preparedTurn, route } = await acceptedTurn(driver, url);
    const foreignScope = createDriverScope({
      driver,
      purpose: "turn",
      route,
      taskInput: TASK_INPUT,
      attemptId: "att_1",
      turnId: "job_1",
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4999" },
    });
    const before = server.requests.length;
    await assert.rejects(
      () => driver.revalidatePreparedTurn(preparedTurn, foreignScope),
      (error) => error.code === "instance_not_configured"
    );
    assert.equal(server.requests.length, before);
  });
});

// ---------------------------------------------------------------------------
// The happy path: session, turn, and one terminal result.
// ---------------------------------------------------------------------------

describe("opencode driver: session and turn lineage", () => {
  it("uses the final GET /agent witness immediately before session creation", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { live } = await launch(driver, url);
    await live.result;
    const requests = server.requests;
    const session = requests.findIndex((request) => request.method === "POST" && request.path === "/session");
    assert.ok(session > 0);
    assert.deepEqual(requests[session - 1], {
      method: "GET", path: "/agent", hasAuthorizationHeader: false, contentType: null, query: { directory: WORKSPACE_ROOT },
    });
  });

  it("blocks final policy drift before POST /session and releases the local claim", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const accepted = await acceptedTurn(driver, url);
    const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
    server.state.agents = readyAgents({
      permission: [...compliantRuleset().slice(0, -1), { permission: "doom_loop", pattern: "*", action: "deny" }],
    });
    const before = postRequests(server).length;
    const rejected = await settled(driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.opencodeCode, "interactive_policy");
    assert.equal(postRequests(server).length, before);
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
  });
  it("keeps both behavioral authorities on the identical native configuration", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    await (await launch(driver, url, { authority: "behavioral_read_only" })).live.result;
    await (await launch(driver, url, { authority: "behavioral_write" })).live.result;
    const posts = postRequests(server);
    const sessions = posts.filter((request) => request.path === "/session");
    const prompts = posts.filter((request) => /\/session\/[^/]+\/message$/.test(request.path));
    assert.equal(sessions.length, 2);
    assert.equal(prompts.length, 2);
    assert.deepEqual(sessions.map((request) => request.body.model), [
      { id: OPENCODE_EXPLORER_MODEL_ID, providerID: OPENCODE_EXPLORER_PROVIDER_ID, variant: "high" },
      { id: OPENCODE_EXPLORER_MODEL_ID, providerID: OPENCODE_EXPLORER_PROVIDER_ID, variant: "high" },
    ]);
    assert.deepEqual(prompts.map((request) => request.body.model), [
      { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
      { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
    ]);
    assert.deepEqual(prompts.map((request) => request.body.variant), ["high", "high"]);
    for (const request of posts) assert.equal(Object.hasOwn(request.body, "agent"), false);
  });

  it("creates one session, proves both references, and settles one completed turn", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const { live, route } = await launch(driver, url);
    // `startTurn()` returns as soon as the prompt is dispatched, so the request
    // is observed on the Server only once the turn has settled.
    const terminalResult = await live.result;

    const posts = postRequests(server);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].path, "/session");
    assert.deepEqual(Object.keys(posts[0].body).sort(), ["model", "permission"]);
    assert.deepEqual(posts[0].body.model, {
      id: OPENCODE_EXPLORER_MODEL_ID,
      providerID: OPENCODE_EXPLORER_PROVIDER_ID,
      variant: "high",
    });
    assert.equal(Object.hasOwn(posts[0].body, "agent"), false);
    assert.deepEqual(posts[0].body.permission, [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "plan_exit", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(Object.hasOwn(posts[0].body, "title"), false, "never sends prompt-derived session metadata");
    assert.equal(posts[0].query.directory, WORKSPACE_ROOT);

    assert.match(posts[1].path, /^\/session\/[^/]+\/message$/);
    assert.deepEqual(Object.keys(posts[1].body).sort(), ["messageID", "model", "parts", "variant"]);
    assert.deepEqual(posts[1].body.model, {
      providerID: OPENCODE_EXPLORER_PROVIDER_ID,
      modelID: OPENCODE_EXPLORER_MODEL_ID,
    });
    assert.equal(posts[1].body.variant, "high");
    assert.equal(posts[1].body.parts.length, 1);
    assert.equal(posts[1].body.parts[0].type, "text");
    assert.ok(posts[1].body.parts[0].text.includes(TASK_INPUT));
    assert.ok(posts[1].body.parts[0].text.includes(`envelope v${OPENCODE_PROMPT_PREFIX_VERSION}`));
    for (const forbidden of ["tools", "system", "format", "noReply"]) {
      assert.equal(Object.hasOwn(posts[1].body, forbidden), false, `never sends ${forbidden}`);
    }

    // The turn reference is distinct from the session reference and carries the
    // exact generated user-message id the prompt body used.
    assert.deepEqual(Object.keys(live.nativeSessionRef.locator).sort(), [...OPENCODE_SESSION_LOCATOR_KEYS]);
    assert.deepEqual(Object.keys(live.nativeTurnRef.locator).sort(), [...OPENCODE_TURN_LOCATOR_KEYS]);
    assert.equal(live.nativeTurnRef.locator.sessionId, live.nativeSessionRef.locator.sessionId);
    assert.equal(live.nativeTurnRef.locator.userMessageId, posts[1].body.messageID);
    assert.match(live.nativeTurnRef.locator.userMessageId, /^msg_[A-Za-z0-9_-]{1,120}$/);
    assert.equal(live.nativeTurnRef.locator.attemptId, "att_1");
    assert.equal(live.nativeTurnRef.locator.providerId, OPENCODE_EXPLORER_PROVIDER_ID);
    assert.equal(live.nativeTurnRef.locator.modelId, OPENCODE_EXPLORER_MODEL_ID);
    assert.equal(live.nativeTurnRef.locator.variant, "high");
    assert.deepEqual(durableTurnEvidence(live), {
      nativeTurnRef: live.nativeTurnRef,
      nativeSessionRef: live.nativeSessionRef,
    });
    assertNoDisclosure(live.nativeSessionRef, "native session reference");
    assertNoDisclosure(live.nativeTurnRef, "native turn reference");

    const terminal = validateNormalizedTerminalResult(terminalResult, { driver, route });
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.nativeTurn, "terminal");
    assert.deepEqual({ ...terminal.executionWorld }, { continuity: "preserved", settlement: "settled" });
    assert.equal(terminal.continuation.mode, "fresh_only");
    assert.equal(terminal.continuation.nativeSessionRef, null);
    assert.equal(terminal.finalMessage, "The fake Explorer answer.");
    assert.equal(terminal.finalMessageAbsenceReason, null);
    assert.equal(terminal.failure.class, null);
    assert.equal(terminal.progress, null);
    // Task 6: the exact provider-reported facts, mapped onto the closed
    // Harness-neutral vocabulary, with nothing derived and nothing zero-filled.
    assert.deepEqual(terminal.metrics, {
      version: 1,
      provider_reported: {
        duration_ms: null,
        duration_api_ms: null,
        turn_count: null,
        input_tokens: 80,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        reported_cost_usd: 0.001,
      },
      plugin_observed: { tool_call_count: 0, attempt_count: 1, recovery_attempt_count: 0 },
    });
    const usage = terminal.driverReceipt.receipt.usage;
    assert.equal(usage.version, 1);
    assert.match(usage.key, /^ocu1:[0-9a-f]{32}$/);
    assert.equal(usage.status, "completed");
    assert.deepEqual(usage.identity, {
      rootId: "root_1",
      agentId: "agent_1",
      turnId: "job_1",
      attemptId: "att_1",
      harnessId: OPENCODE_HARNESS_ID,
      instanceKey: opencodeExplorerInstanceKey(url),
      model: OPENCODE_EXPLORER_MODEL,
      driverVersion: OPENCODE_DRIVER_VERSION,
      capabilitySchemaVersion: OPENCODE_EXPLORER_CAPABILITIES.capabilitySchemaVersion,
      topology: OPENCODE_EXPLORER_TOPOLOGY,
      authority: OPENCODE_EXPLORER_AUTHORITY,
    });
    // The sixth exact fact the pinned schema reports has no slot in the shared
    // metrics vocabulary, so the route-keyed record is where it lives.
    assert.equal(usage.provider.reasoningTokens, 0);
    assert.equal(usage.provider.provenance, "provider_reported");
    assert.deepEqual([...usage.provider.malformedFields], []);
    assert.equal(usage.serverReuse.serverIncarnationProven, false);
    assert.equal(usage.serverReuse.derivedFromCacheTelemetry, false);
    assert.equal(usage.serverReuse.sessionLifecycle, "fresh_session_per_agent");
    assert.equal(Number.isSafeInteger(usage.serverReuse.latencyMs), true);
    assert.equal(terminal.resultMetadata.promptPrefixVersion, OPENCODE_PROMPT_PREFIX_VERSION);
    assert.equal(terminal.resultMetadata.finishReason, "stop");
    assertNoDisclosure({ ...terminal, finalMessage: null }, "terminal result");
    await live.dispose();
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
  });

  it("returns the live turn before the blocking prompt settles", async () => {
    const { url } = await startFake({ promptDelayMs: 120 });
    const driver = driverFor(url);
    const { live, route } = await launch(driver, url);
    let settledEarly = false;
    void live.result.then(() => {
      settledEarly = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settledEarly, false, "the live handle must be returned without awaiting the turn");
    assert.equal(live.nativeTurnRef.locator.sessionId.length > 0, true);
    const terminal = validateNormalizedTerminalResult(await live.result, { driver, route });
    assert.equal(terminal.status, "completed");
    await live.dispose();
  });

  it("exposes no active-input or interrupt method on the live turn", async () => {
    const { url } = await startFake();
    const driver = driverFor(url);
    const { live } = await launch(driver, url);
    assert.equal("deliverActiveInput" in live, false);
    assert.equal("requestInterrupt" in live, false);
    assert.deepEqual(Object.keys(live).sort(), ["dispose", "nativeSessionRef", "nativeTurnRef", "result"]);
    await live.result;
    await live.dispose();
  });

  it("gives two Agents two isolated sessions", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const first = await launch(driver, url);
    await first.live.result;
    await first.live.dispose();
    const second = await launch(driver, url, { scopeOverrides: { agentId: "agent_2", attemptId: "att_2", turnId: "job_2" } });
    await second.live.result;
    await second.live.dispose();
    assert.notEqual(
      first.live.nativeSessionRef.locator.sessionId,
      second.live.nativeSessionRef.locator.sessionId
    );
    assert.notEqual(
      first.live.nativeTurnRef.locator.userMessageId,
      second.live.nativeTurnRef.locator.userMessageId
    );
    assert.equal(postRequests(server).length, 4);
  });

  it("refuses to bind one native session id to two turns", async () => {
    // A Server that hands out the same session id twice would otherwise put two
    // Agents in one native session. The durable native-session lease is the
    // real owner of that rule; this is the in-process guard beside it.
    const { url } = await startFake({ sessionIds: ["ses_duplicate"] });
    const driver = driverFor(url);
    const first = await launch(driver, url);
    await first.live.result;
    await first.live.dispose();
    const accepted = await acceptedTurn(driver, url, {
      scopeOverrides: { agentId: "agent_2", attemptId: "att_2", turnId: "job_2" },
    });
    const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
    const rejection = await settled(
      driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext })
    );
    assert.equal(rejection.ok, false);
    assert.equal(isDriverPreTransportRejection(rejection.error), true);
    assert.equal(rejection.error.opencodeCode, "session_identity_reused");
  });
});

// ---------------------------------------------------------------------------
// Pre-transport refusals: nothing was submitted, nothing is ambiguous.
// ---------------------------------------------------------------------------

describe("opencode driver: refusals before native submission", () => {
  it("rejects a follow-up before any mailbox or native mutation", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    const accepted = await acceptedTurn(driver, url);
    const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
    const before = server.requests.length;
    const outcome = await settled(
      driver.startTurn({
        scope: accepted.scope,
        preparedTurn: accepted.preparedTurn,
        launchContext,
        nativeSessionRef: {
          version: 1,
          harnessId: OPENCODE_HARNESS_ID,
          driverVersion: OPENCODE_DRIVER_VERSION,
          instanceKey: opencodeExplorerInstanceKey(url),
          locatorVersion: 1,
          locator: { sessionId: "ses_previous" },
        },
      })
    );
    assert.equal(outcome.ok, false);
    assert.equal(isDriverPreTransportRejection(outcome.error), true);
    assert.equal(outcome.error.opencodeCode, "continuation_unsupported");
    assert.equal(server.requests.length, before, "a rejected follow-up creates nothing");
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
    assertNoDisclosure({ message: outcome.error.message, detail: outcome.error.opencodeDetail }, "rejection");
  });

  it("rejects cleanly when the Server refuses session creation", async () => {
    const { server, url } = await startFake({ sessionStatus: 400 });
    const driver = driverFor(url);
    const accepted = await acceptedTurn(driver, url);
    const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
    const outcome = await settled(
      driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext })
    );
    assert.equal(outcome.ok, false);
    assert.equal(isDriverPreTransportRejection(outcome.error), true);
    assert.equal(outcome.error.opencodeCode, "session_not_created");
    const posts = postRequests(server);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/session");
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
  });

  it("rejects cleanly when session creation is ambiguous, and submits no prompt", async () => {
    for (const scenario of [{ sessionHang: true }, { sessionDestroy: true }, { sessionMalformed: true }]) {
      const { server, url } = await startFake(scenario);
      const driver = driverFor(url, { acceptanceTimeoutMs: 150 });
      const accepted = await acceptedTurn(driver, url);
      const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
      const outcome = await settled(
        driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext })
      );
      assert.equal(outcome.ok, false, JSON.stringify(scenario));
      assert.equal(isDriverPreTransportRejection(outcome.error), true, JSON.stringify(scenario));
      assert.equal(outcome.error.opencodeCode, "session_not_created", JSON.stringify(scenario));
      assert.deepEqual(
        postRequests(server).map((request) => request.path),
        ["/session"],
        "no prompt is submitted after an ambiguous session creation"
      );
      assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
    }
  });

  it("refuses a session whose returned identity is not the one it asked for", async () => {
    for (const sessionBody of [
      { id: "ses_child", parentID: "ses_parent" },
      { id: "" },
      { id: "ses/../escape" },
      { slug: "no-id" },
    ]) {
      const { server, url } = await startFake({ sessionBody });
      const driver = driverFor(url);
      const accepted = await acceptedTurn(driver, url);
      const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
      const outcome = await settled(
        driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext })
      );
      assert.equal(outcome.ok, false, JSON.stringify(sessionBody));
      assert.equal(outcome.error.opencodeCode, "session_not_created", JSON.stringify(sessionBody));
      assert.deepEqual(postRequests(server).map((request) => request.path), ["/session"]);
    }
  });

  it("refuses a turn with no durable attempt or turn identity", async () => {
    const { server, url } = await startFake();
    const driver = driverFor(url);
    for (const scopeOverrides of [{ attemptId: null }, { turnId: null }]) {
      const accepted = await acceptedTurn(driver, url, { scopeOverrides });
      const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
      const before = server.requests.length;
      const outcome = await settled(
        driver.startTurn({ scope: accepted.scope, preparedTurn: accepted.preparedTurn, launchContext })
      );
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.opencodeCode, "turn_identity_unprovable");
      assert.equal(server.requests.length, before);
    }
  });

  it("admits concurrent distinct turns without releasing unknown-turn evidence", async () => {
    const { server, url } = await startFake({ promptHang: true });
    const driver = driverFor(url, { turnTimeoutMs: 400 });
    const accepted = await acceptedTurn(driver, url, {
      scopeOverrides: { agentId: "agent_2", attemptId: "att_2", turnId: "job_2" },
    });
    const first = await launch(driver, url);
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 1);
    const launchContext = await driver.revalidatePreparedTurn(accepted.preparedTurn, accepted.scope);
    const second = await driver.startTurn({
      scope: accepted.scope,
      preparedTurn: accepted.preparedTurn,
      launchContext,
    });
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 2);
    assert.equal(
      postRequests(server).filter((request) => request.path === "/session").length,
      2
    );
    const [firstAmbiguous, secondAmbiguous] = await Promise.all([
      settled(first.live.result),
      settled(second.result),
    ]);
    assert.equal(firstAmbiguous.ok, false);
    assert.equal(secondAmbiguous.ok, false);
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 2, "ambiguity keeps both observations");
  });
});

// ---------------------------------------------------------------------------
// Terminal outcomes after the prompt was dispatched.
// ---------------------------------------------------------------------------

describe("opencode driver: terminal settlement", () => {
  it("keeps an exact durable lease around a turn on a reused service", async () => {
    const { url } = await startFake();
    const calls = [];
    const lease = { file: "/opaque/reused-service-lease", token: "a".repeat(32), rootId: "root_1", agentId: "agent_1", turnId: "job_1", attemptId: "att_1" };
    const driver = driverFor(url, {
      serviceManager: {
        ensure: async () => ({ status: "reused" }),
        acquireTurnLease: async (identity) => { calls.push(["acquire", identity]); return lease; },
        releaseTurnLease: async (value) => { calls.push(["release", value]); return true; },
      },
    });
    const { live } = await launch(driver, url);
    await live.result;
    assert.deepEqual(calls, [["acquire", { rootId: "root_1", agentId: "agent_1", turnId: "job_1", attemptId: "att_1" }], ["release", lease]]);
  });

  it("retains a reused-service lease when native acceptance remains unknown", async () => {
    const { url } = await startFake({ promptDestroy: true });
    const calls = [];
    const lease = { file: "/opaque/unknown-lease", token: "b".repeat(32), rootId: "root_1", agentId: "agent_1", turnId: "job_1", attemptId: "att_1" };
    const driver = driverFor(url, {
      serviceManager: {
        ensure: async () => ({ status: "reused" }),
        acquireTurnLease: async (identity) => { calls.push(["acquire", identity]); return lease; },
        releaseTurnLease: async () => { calls.push(["release"]); return true; },
      },
    });
    const { live } = await launch(driver, url);
    await assert.rejects(live.result, (error) => error instanceof OpencodeTurnError && error.code === "transport_lost");
    assert.deepEqual(calls, [["acquire", { rootId: "root_1", agentId: "agent_1", turnId: "job_1", attemptId: "att_1" }]]);
  });

  async function terminalFor(scenario, options = {}) {
    const { server, url } = await startFake(scenario);
    const driver = driverFor(url, options);
    const { live, route } = await launch(driver, url);
    const outcome = await settled(live.result);
    return { server, url, driver, live, route, outcome };
  }

  it("classifies the two schema-declared prompt refusals as settled failures", async () => {
    for (const [status, failureClass] of [[400, "context_or_request_invalid"], [404, "context_or_request_invalid"]]) {
      const { driver, route, outcome, url, live } = await terminalFor({ promptStatus: status });
      assert.equal(outcome.ok, true, `status ${status} must settle`);
      const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure.class, failureClass);
      assert.equal(terminal.finalMessage, null);
      assert.equal(terminal.finalMessageAbsenceReason, "prompt_refused");
      assert.deepEqual({ ...terminal.executionWorld }, { continuity: "not_applicable", settlement: "settled" });
      // A turn the Server refused reports no provider numbers at all: there is
      // no assistant message, so nothing is zero-filled in its place.
      assert.equal(terminal.metrics.provider_reported, null);
      assert.equal(terminal.metrics.plugin_observed.attempt_count, 1);
      assert.equal(terminal.driverReceipt.receipt.usage.provider, null);
      assert.equal(terminal.driverReceipt.receipt.usage.status, "failed");
      await live.dispose();
      assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0, "a settled failure releases capacity");
    }
  });

  it("classifies an authentication refusal as a Harness-scoped settled failure", async () => {
    // Readiness passes, then the Server refuses the prompt itself: no provider
    // work happened, so this settles rather than staying unknown.
    const { driver, route, outcome, live, url } = await terminalFor({ promptStatus: 401 });
    assert.equal(outcome.ok, true);
    const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure.class, "auth_or_permission");
    assert.equal(terminal.failure.requiresAttention, true);
    assert.equal(terminal.finalMessageAbsenceReason, "server_refused_authentication");
    assert.deepEqual({ ...terminal.executionWorld }, { continuity: "not_applicable", settlement: "settled" });
    assertNoDisclosure({ ...terminal }, "authentication failure");
    await live.dispose();
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 0);
  });

  it("blocks readiness when the Server requires credentials this process does not have", async () => {
    const { url } = await startFake({ auth: { username: "admin", password: "hunter2" } });
    const driver = driverFor(url);
    const [inspection] = await driver.inspectInstances(
      createDriverScope({ driver, purpose: "inspect", env: { OPENCODE_SERVER_URL: url } })
    );
    assert.equal(inspection.readiness, "blocked");
    assert.equal(inspection.detailCode, "not_authenticated");
    assert.equal(JSON.stringify(inspection).includes("hunter2"), false);
  });

  it("leaves a 5xx, a lost connection, and a deadline as acceptance-unknown", async () => {
    for (const [scenario, expectedCode, options] of [
      [{ promptStatus: 500 }, "server_error", {}],
      [{ promptDestroy: true }, "transport_lost", {}],
      [{ promptHang: true }, "deadline_exceeded", { turnTimeoutMs: 200 }],
    ]) {
      const { outcome, url, live, server } = await terminalFor(scenario, options);
      assert.equal(outcome.ok, false, JSON.stringify(scenario));
      assert.equal(outcome.error instanceof OpencodeTurnError, true, JSON.stringify(scenario));
      assert.equal(outcome.error.code, expectedCode, JSON.stringify(scenario));
      assert.equal(
        opencodeHeldCapacity(opencodeExplorerInstanceKey(url)),
        1,
        "unknown acceptance keeps capacity held"
      );
      // Disposal must not release the slot, abort, or observe anything.
      const before = server.requests.length;
      await live.dispose();
      assert.equal(server.requests.length, before, "dispose never calls the Server");
      assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 1);
      assertNoDisclosure({ message: outcome.error.message }, "unknown-acceptance error");
    }
  });

  it("treats a Server that disappears mid-turn as unknown, never as interrupted", async () => {
    const { server, url } = await startFake({ promptDelayMs: 5_000 });
    const driver = driverFor(url, { turnTimeoutMs: 3_000 });
    const { live } = await launch(driver, url);
    await server.close();
    cleanups.pop();
    const outcome = await settled(live.result);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error instanceof OpencodeTurnError, true);
    assert.equal(["transport_lost", "unreadable_transport", "server_error"].includes(outcome.error.code), true);
    assert.equal(opencodeHeldCapacity(opencodeExplorerInstanceKey(url)), 1);
  });

  it("classifies an unreadable 200 body as a settled protocol failure", async () => {
    const { driver, route, outcome, live } = await terminalFor({ promptMalformed: true });
    assert.equal(outcome.ok, true);
    const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure.class, "protocol_unknown");
    assert.equal(terminal.finalMessageAbsenceReason, "unreadable_response");
    await live.dispose();
  });

  it("classifies a crossed session, parent, provider, model, missing variant, or changed variant as session drift", async () => {
    const lineageCases = [
      ["sessionID", (sessionId) => ({ info: fakeAssistantMessage({ sessionID: "ses_other" }), parts: [fakeTextPart("x", { sessionID: sessionId })] })],
      ["parentID", (sessionId) => ({
        info: fakeAssistantMessage({ sessionID: sessionId, parentID: "msg_someone_else" }),
        parts: [fakeTextPart("x", { sessionID: sessionId })],
      })],
      ["providerID", (sessionId) => ({
        info: fakeAssistantMessage({ sessionID: sessionId, providerID: "deepseek" }),
        parts: [fakeTextPart("x", { sessionID: sessionId })],
      })],
      ["modelID", (sessionId) => ({
        info: fakeAssistantMessage({ sessionID: sessionId, modelID: "kimi-k2.6" }),
        parts: [fakeTextPart("x", { sessionID: sessionId })],
      })],
      ["variant_missing", (sessionId) => ({
        info: fakeAssistantMessage({ sessionID: sessionId, variant: undefined }),
        parts: [fakeTextPart("x", { sessionID: sessionId })],
      })],
      ["variant_mismatch", (sessionId) => ({
        info: fakeAssistantMessage({ sessionID: sessionId, variant: "medium" }),
        parts: [fakeTextPart("x", { sessionID: sessionId })],
      })],
    ];
    for (const [field, build] of lineageCases) {
      const { driver, route, outcome, live } = await terminalFor({
        prompt: ({ sessionId, body }) => {
          const payload = build(sessionId);
          if (field !== "parentID") payload.info.parentID = body.messageID;
          return { body: payload };
        },
      });
      assert.equal(outcome.ok, true, field);
      const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
      assert.equal(terminal.status, "failed", field);
      assert.equal(terminal.failure.class, "protocol_session_drift", field);
      assert.equal(terminal.finalMessageAbsenceReason, "lineage_mismatch", field);
      await live.dispose();
    }
  });

  it("classifies each provider error by its closed variant name", async () => {
    const expected = {
      ProviderAuthError: ["failed", "auth_or_permission"],
      MessageAbortedError: ["interrupted", "cancelled_or_interrupted"],
      ContextOverflowError: ["failed", "context_or_request_invalid"],
      MessageOutputLengthError: ["failed", "context_or_request_invalid"],
      ContentFilterError: ["failed", "context_or_request_invalid"],
      APIError: ["failed", "protocol_unknown"],
      UnknownError: ["failed", "protocol_unknown"],
      StructuredOutputError: ["failed", "protocol_unknown"],
    };
    for (const [name, [status, failureClass]] of Object.entries(expected)) {
      const { driver, route, outcome, live } = await terminalFor({
        prompt: ({ sessionId, body }) => ({
          body: {
            info: fakeAssistantMessage({
              sessionID: sessionId,
              parentID: body.messageID,
              error: { name, data: { message: "PROVIDER-SENTINEL", responseBody: "RAW-SENTINEL" } },
            }),
            parts: [],
          },
        }),
      });
      assert.equal(outcome.ok, true, name);
      const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
      assert.equal(terminal.status, status, name);
      assert.equal(terminal.failure.class, failureClass, name);
      assert.equal(terminal.finalMessageAbsenceReason, "provider_error", name);
      assert.equal(terminal.resultMetadata.providerErrorName, name, name);
      // Task 6: a refused turn still consumed provider work, so its exact
      // metrics and its route-keyed usage record travel with the failure.
      assert.equal(terminal.metrics.provider_reported.input_tokens, 80, name);
      assert.equal(terminal.driverReceipt.receipt.usage.status, status, name);
      assert.equal(terminal.driverReceipt.receipt.usage.provider.reportedCost, 0.001, name);
      assert.equal(terminal.driverReceipt.receipt.usage.serverReuse.derivedFromCacheTelemetry, false, name);
      const serialized = JSON.stringify(terminal);
      assert.equal(serialized.includes("PROVIDER-SENTINEL"), false, name);
      assert.equal(serialized.includes("RAW-SENTINEL"), false, name);
      await live.dispose();
    }
  });

  it("refuses an empty, absent, or oversized final message", async () => {
    const cases = [
      ["no_final_text", () => []],
      ["empty_final_text", (sessionId) => [fakeTextPart("   \n  ", { sessionID: sessionId })]],
      [
        "final_text_too_large",
        (sessionId) => [fakeTextPart("x".repeat(OPENCODE_MAX_FINAL_TEXT_CHARS + 1), { sessionID: sessionId })],
      ],
    ];
    for (const [absence, buildParts] of cases) {
      const { driver, route, outcome, live } = await terminalFor({
        prompt: ({ sessionId, body }) => ({
          body: {
            info: fakeAssistantMessage({ sessionID: sessionId, parentID: body.messageID }),
            parts: buildParts(sessionId).map((part) => ({ ...part, messageID: "msg_assistant_fake" })),
          },
        }),
      });
      assert.equal(outcome.ok, true, absence);
      const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
      assert.equal(terminal.status, "failed", absence);
      assert.equal(terminal.finalMessageAbsenceReason, absence, absence);
      assert.equal(terminal.failure.class, "protocol_unknown", absence);
      await live.dispose();
    }
  });

  it("projects the last text part of a multi-step turn and no tool history", async () => {
    const { driver, route, outcome, live } = await terminalFor({
      prompt: ({ sessionId, body }) => ({
        body: {
          info: fakeAssistantMessage({ sessionID: sessionId, parentID: body.messageID }),
          parts: [
            { id: "prt_step", sessionID: sessionId, messageID: "msg_assistant_fake", type: "step-start" },
            fakeTextPart("Looking at the registry.", { sessionID: sessionId, id: "prt_a" }),
            {
              id: "prt_tool",
              sessionID: sessionId,
              messageID: "msg_assistant_fake",
              type: "tool",
              callID: "call_1",
              tool: "grep",
              state: { status: "completed", output: "TOOL-SENTINEL" },
            },
            fakeTextPart("FINAL: the registry is static.", { sessionID: sessionId, id: "prt_b" }),
          ],
        },
      }),
    });
    const terminal = validateNormalizedTerminalResult(outcome.value, { driver, route });
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.finalMessage, "FINAL: the registry is static.");
    assert.equal(terminal.resultMetadata.textPartCount, 2);
    assert.equal(terminal.resultMetadata.precedingTextPartCount, 1);
    assert.equal(terminal.resultMetadata.nonTextPartCount, 2);
    const serialized = JSON.stringify(terminal);
    assert.equal(serialized.includes("TOOL-SENTINEL"), false);
    assert.equal(serialized.includes("grep"), false);
    assert.equal(serialized.includes("Looking at the registry"), false);
    await live.dispose();
  });

  it("settles the same result whether the promise is awaited early or late", async () => {
    const { url } = await startFake({ promptDelayMs: 60 });
    const driver = driverFor(url);
    const { live, route } = await launch(driver, url);
    // The worker loop attaches an early no-op observer before its own await.
    void Promise.resolve(live.result).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const terminal = validateNormalizedTerminalResult(await live.result, { driver, route });
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.finalMessage, "The fake Explorer answer.");
    await live.dispose();
  });
});
