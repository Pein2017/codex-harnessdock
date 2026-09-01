/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zero-model, source-independent OpenCode evidence. The direct side speaks
 * raw HTTP; the HarnessDock side uses the production Driver against the same
 * test-owned native Server. No raw prompt, endpoint, session, or config
 * identity is written to the checked-in receipt.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createOpencodeDriver, opencodeHeldCapacity } from "../../runtime/opencode-driver.mjs";
import { createOpencodeServiceManager } from "../../runtime/opencode-service-manager.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";
import { runDirectOpencodeProcessOracle } from "./fixtures/native-parity/opencode-direct-process-oracle.mjs";
import { runRawHttpOpenCodeObservationOracle, runRawHttpOpenCodeOracle } from "./fixtures/native-parity/opencode-raw-http-oracle.mjs";

const RECEIPT_PATH = new URL("./fixtures/native-parity/opencode-native-differential-parity.receipt.json", import.meta.url);
const cleanups = [];
const PROCESS_EXECUTABLE = new URL("./fixtures/native-parity/fake-opencode-service.mjs", import.meta.url).pathname;
const PROCESS_TTL_SECONDS = 60;
const PROCESS_CONFIGURATION = "deterministic-zero-model-config-v1";

const NATIVE_INPUT = Object.freeze({
  providerId: "native-provider",
  modelId: "native-model",
  model: "native-provider/native-model",
  effort: "careful",
  authority: "behavioral_read_only",
  taskInput: "Return the native baseline status.",
  configurationWitness: "configuration-witness-loaded",
});

function driverDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Test-only stand-in for the launch core's durable service lease evidence. */
function parityServiceManager() {
  return {
    ensure: async () => ({ status: "reused" }),
    acquireTurnLease: async () => ({ token: "a".repeat(32) }),
    releaseTurnLease: async () => true,
    residencyForTurnLease: async (lease) => ({ kind: "reused_service", turnLeaseToken: lease.token }),
  };
}

function parityLaunchContext(context) {
  return {
    ...context,
    // The production launch core persists this before the prompt.  The
    // source-independent fixture only needs to exercise that awaited seam.
    async bindPhysicalResidency() {},
  };
}

// This intentionally derives from the Driver's captured admission data, not
// from the direct HTTP oracle's projection helper.
function driverAdmissionConfiguration(admission) {
  const selected = admission?.agent ?? null;
  const rules = Array.isArray(selected?.ruleset) ? selected.ruleset : null;
  return Object.freeze({
    defaultAgentDigest: driverDigest(admission?.defaultAgent ?? null),
    selectedAgentDigest: driverDigest(selected?.name ?? null),
    selectedMode: typeof selected?.mode === "string" ? selected.mode : "missing",
    permissionRuleCount: rules?.length ?? -1,
    permissionDigest: driverDigest(rules),
  });
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function providerCatalog({ effort = NATIVE_INPUT.effort } = {}) {
  return {
    status: 200,
    body: {
      all: [{
        id: NATIVE_INPUT.providerId,
        models: {
          [NATIVE_INPUT.modelId]: {
            id: NATIVE_INPUT.modelId,
            providerID: NATIVE_INPUT.providerId,
            variants: { [effort]: {} },
          },
        },
      }],
      connected: [NATIVE_INPUT.providerId],
      default: {},
    },
  };
}

function nativePromptResponse(directory) {
  return ({ sessionId, body, query }) => {
    const honored = query?.directory === directory &&
      !Object.hasOwn(body ?? {}, "agent") &&
      !Object.hasOwn(body ?? {}, "tools") &&
      !Object.hasOwn(body ?? {}, "sandbox");
    const messageId = "msg_native_parity";
    return {
      body: {
        info: {
          id: messageId,
          sessionID: sessionId,
          parentID: body?.messageID,
          role: "assistant",
          providerID: NATIVE_INPUT.providerId,
          modelID: NATIVE_INPUT.modelId,
          variant: NATIVE_INPUT.effort,
          finish: "stop",
          cost: 0.125,
          tokens: { input: 21, output: 13, reasoning: 8, cache: { read: 5, write: 3 } },
        },
        parts: [
          { id: "prt_native_tool", sessionID: sessionId, messageID: messageId, type: "tool" },
          {
            id: "prt_native_text",
            sessionID: sessionId,
            messageID: messageId,
            type: "text",
            text: honored ? NATIVE_INPUT.configurationWitness : "configuration-witness-missing",
          },
        ],
      },
    };
  };
}

async function startServer(directory, prompt = nativePromptResponse(directory)) {
  const server = createFakeOpencodeServer({
    health: { status: 200, body: { healthy: true, version: "1.18.25" } },
    config: { status: 200, body: { default_agent: "codex-explorer" } },
    agents: {
      status: 200,
      body: [{
        name: "codex-explorer", mode: "primary", native: false,
        permission: [
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
        ],
      }],
    },
    provider: providerCatalog(),
    prompt,
  });
  const url = await server.listen();
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    await server.close();
  };
  cleanups.push(close);
  return { server, url, close };
}

function requestOrder(requests) {
  return requests.map((request) => {
    if (request.method === "GET") return `${request.method} ${request.path}`;
    if (request.path === "/session") return "POST /session";
    return "POST /session/{ephemeral}/message";
  });
}

function driverRoutes(inspection) {
  return Object.entries(inspection.routes.effortsByModel)
    .map(([model, efforts]) => ({ model, efforts: [...efforts].sort() }))
    .sort((left, right) => left.model.localeCompare(right.model));
}

function splitHarnessRequestEvidence(requests) {
  let providerChecks = 0;
  const nativeRequests = [];
  const policyRequests = [];
  let sessionPermission = null;
  for (const request of requests) {
    // The observer is deliberately outside the synchronous prompt parity
    // baseline: it is covered by the focused fixed-origin observer fixture.
    if (request.path === "/event" || request.path === "/session/status" ||
        (request.method === "GET" && request.path.startsWith("/session/") && request.path.endsWith("/message"))) continue;
    if (request.method === "GET") {
      if (request.path === "/provider" && providerChecks < 2) {
        providerChecks += 1;
      } else {
        if (request.path === "/provider") providerChecks += 1;
        policyRequests.push({ method: request.method, path: request.path, query: request.query, headers: {
          authorization: request.hasAuthorizationHeader ? "present" : "absent",
          contentType: request.contentType ?? "absent",
        } });
        continue;
      }
    }
    const prompt = request.method === "POST" && request.path !== "/session";
    const body = request.body == null ? null : structuredClone(request.body);
    if (request.path === "/session" && body != null) {
      sessionPermission = body.permission ?? null;
      delete body.permission;
    }
    if (prompt) {
      // Match the direct baseline on every native transport field while
      // allowing only HarnessDock's bounded prompt-envelope delta.
      body.messageID = "{ephemeral-message-id}";
      body.parts = body.parts.map((part) => ({ ...part, text: "{allowed-prompt-delta}" }));
    }
    nativeRequests.push({
      method: request.method,
      path: prompt ? "/session/{ephemeral-session-id}/message" : request.path,
      query: request.query,
      headers: {
        authorization: request.hasAuthorizationHeader ? "present" : "absent",
        contentType: request.contentType ?? "absent",
      },
      body,
    });
  }
  return {
    requestTransport: { origin: "loopback", requests: nativeRequests },
    unattendedPolicy: { requests: policyRequests, sessionPermission },
  };
}

async function runHarnessDockTurn({ server, url, directory, authority = NATIVE_INPUT.authority }) {
  let nativePartTypes = null;
  let nativeAdmission = null;
  const driver = createOpencodeDriver({
    env: { OPENCODE_SERVER_URL: url },
    serviceManager: parityServiceManager(),
    _test: {
      captureNativePromptEvidence: (evidence) => { nativePartTypes = evidence.partTypes; },
      captureNativeAdmissionEvidence: (evidence) => { nativeAdmission = evidence; },
    },
  });
  const scope = {
    env: { OPENCODE_SERVER_URL: url },
    workspaceRoot: directory,
    rootId: "root_native_parity",
    agentId: "agent_native_parity",
    turnId: "turn_native_parity",
    attemptId: "attempt_native_parity",
  };
  const before = server.requests.length;
  const [inspection] = await driver.inspectInstances(scope);
  const route = driver.validateRoute({
    harnessId: "opencode",
    model: NATIVE_INPUT.model,
    topology: "leaf",
    authority,
    effort: NATIVE_INPUT.effort,
  }, inspection);
  const prepared = driver.prepareTurn({ route, taskInput: NATIVE_INPUT.taskInput, turnOptions: { effort: route.effort } });
  const launchContext = parityLaunchContext(await driver.revalidatePreparedTurn(prepared, scope));
  const live = await driver.startTurn({ scope, preparedTurn: prepared, launchContext });
  const terminal = await live.result;
  await live.dispose();
  const requests = server.requests.slice(before);
  assert.ok(nativeAdmission, "the Driver must preserve the actual pre-session admission witness for this differential test");
  const session = requests.find((request) => request.path === "/session");
  const prompt = requests.find((request) => request.method === "POST" && request.path.endsWith("/message"));
  const requestEvidence = splitHarnessRequestEvidence(requests);
  return {
    inventory: driverRoutes(inspection),
    ...requestEvidence,
    configuration: driverAdmissionConfiguration(nativeAdmission),
    executionDirectory: {
      witness: terminal.finalMessage === NATIVE_INPUT.configurationWitness ? "loaded" : "missing",
      propagated: typeof session?.query?.directory === "string" && typeof prompt?.query?.directory === "string"
        ? "session_and_prompt_directory"
        : "absent",
    },
    events: {
      requestOrder: requestOrder(requestEvidence.requestTransport.requests),
      partTypes: nativePartTypes,
      toolCallCount: terminal.metrics.plugin_observed.tool_call_count,
    },
    terminal: {
      classification: terminal.status,
      lineage: terminal.nativeTurnRef.locator.providerId === NATIVE_INPUT.providerId &&
        terminal.nativeTurnRef.locator.modelId === NATIVE_INPUT.modelId &&
        terminal.nativeTurnRef.locator.variant === NATIVE_INPUT.effort ? "matched" : "mismatched",
      finish: terminal.resultMetadata.finishReason,
      finalText: terminal.finalMessage,
    },
    usage: terminal.driverReceipt.receipt.usage.provider,
    lifecycle: {
      sessionLifecycle: terminal.driverReceipt.receipt.usage.serverReuse.sessionLifecycle,
      settled: terminal.nativeTurn === "terminal",
      cleanup: opencodeHeldCapacity(inspection.instanceKey) === 0 ? "no_live_client" : "capacity_held",
    },
    capabilities: route.capabilities,
    authorityEvidence: {
      route: authority,
      receipt: terminal.driverReceipt.receipt.usage.identity.authority,
      promptText: prompt?.body?.parts?.[0]?.text ?? "",
    },
  };
}

function compareEvidence(direct, harness) {
  const comparisons = [
    ["exact_model_effort_inventory", direct.inventory, harness.inventory],
    ["request_transport_environment", direct.requestTransport, harness.requestTransport],
    ["native_configuration_inheritance", direct.configuration, harness.configuration],
    ["execution_directory_propagation", direct.executionDirectory, harness.executionDirectory],
    ["ordered_request_event_tool_observations", direct.events, harness.events],
    ["terminal_classification", direct.terminal, harness.terminal],
    ["provider_native_usage_source_fields", direct.usage, harness.usage],
    ["turn_session_cleanup", direct.lifecycle, harness.lifecycle],
  ];
  return comparisons.map(([dimension, nativeValue, harnessValue]) => {
    assert.deepEqual(nativeValue, harnessValue, `${dimension} must retain native behavior`);
    return { dimension, result: "pass" };
  });
}

function observationMessageFor(reference, directory) {
  const locator = reference.locator;
  return nativePromptResponse(directory)({
    sessionId: locator.sessionId,
    body: { messageID: locator.userMessageId },
    query: { directory },
  }).body;
}

function observationEvidence(observation, reference) {
  const terminal = observation.terminalResult;
  return {
    nativeTurn: observation.nativeTurn,
    terminal: terminal == null ? null : {
      lineage: terminal.nativeTurnRef?.locator?.sessionId === reference.locator.sessionId &&
        terminal.nativeTurnRef?.locator?.userMessageId === reference.locator.userMessageId &&
        terminal.nativeTurnRef?.locator?.providerId === reference.locator.providerId &&
        terminal.nativeTurnRef?.locator?.modelId === reference.locator.modelId &&
        terminal.nativeTurnRef?.locator?.variant === reference.locator.variant ? "matched" : "mismatched",
      classification: terminal.status,
    },
  };
}

function compareCrossProcessObservation(raw, harness) {
  const expected = {
    nativeTurn: "terminal",
    terminal: { lineage: "matched", classification: "completed" },
  };
  assert.deepEqual(raw, expected, "raw HTTP must bind the persisted exact lineage to its terminal outcome");
  assert.deepEqual(harness, expected, "the fresh Driver observer must bind the persisted exact lineage to its terminal outcome");
  assert.deepEqual(raw, harness, "raw HTTP and the fresh Driver observer must agree on terminal classification");
  return { dimension: "cross_process_turn_observation_or_reconciliation", result: "pass" };
}

async function runCrossProcessObservation({ server, url, directory }) {
  const scope = {
    env: { OPENCODE_SERVER_URL: url }, workspaceRoot: directory,
    rootId: "root_native_parity", agentId: "agent_native_parity", turnId: "turn_native_parity", attemptId: "attempt_native_parity",
  };
  let persistedNativeTurnRef;
  {
    const driver = createOpencodeDriver({
      env: { OPENCODE_SERVER_URL: url },
      serviceManager: parityServiceManager(),
    });
    const [inspection] = await driver.inspectInstances(scope);
    const route = driver.validateRoute({
      harnessId: "opencode", model: NATIVE_INPUT.model, topology: "leaf", authority: NATIVE_INPUT.authority, effort: NATIVE_INPUT.effort,
    }, inspection);
    const prepared = driver.prepareTurn({ route, taskInput: NATIVE_INPUT.taskInput, turnOptions: { effort: route.effort } });
    const live = await driver.startTurn({
      scope,
      preparedTurn: prepared,
      launchContext: parityLaunchContext(await driver.revalidatePreparedTurn(prepared, scope)),
    });
    persistedNativeTurnRef = JSON.parse(JSON.stringify(live.nativeTurnRef));
    await live.result;
    await live.dispose();
  }
  assert.equal(opencodeHeldCapacity(persistedNativeTurnRef.instanceKey), 0, "the original live turn must be gone before restart observation");
  server.state.observationMessages = [observationMessageFor(persistedNativeTurnRef, directory)];
  server.state.observationStatus = { [persistedNativeTurnRef.locator.sessionId]: { type: "idle" } };
  const raw = await runRawHttpOpenCodeObservationOracle({ serverUrl: url, nativeTurnRef: persistedNativeTurnRef });
  const restartedDriver = createOpencodeDriver({
    env: { OPENCODE_SERVER_URL: url },
    serviceManager: { ensure: async () => ({ status: "reused" }) },
  });
  const harness = observationEvidence(await restartedDriver.observeTurn(persistedNativeTurnRef, scope), persistedNativeTurnRef);
  return { raw, harness, persistedNativeTurnRef, scope };
}

async function assertCrossProcessObservationSensitivity({ server, url, persistedNativeTurnRef, scope, raw, harness }) {
  const original = structuredClone(server.state.observationMessages);
  server.state.observationMessages[0].info.providerID = "other-provider";
  try {
    const changedRaw = await runRawHttpOpenCodeObservationOracle({ serverUrl: url, nativeTurnRef: persistedNativeTurnRef });
    const changedDriver = createOpencodeDriver({
      env: { OPENCODE_SERVER_URL: url },
      serviceManager: { ensure: async () => ({ status: "reused" }) },
    });
    const changedHarness = observationEvidence(await changedDriver.observeTurn(persistedNativeTurnRef, scope), persistedNativeTurnRef);
    assert.throws(
      () => compareCrossProcessObservation(changedRaw, changedHarness),
      undefined,
      "a raw persisted-lineage mutation must fail the cross-process observation comparator",
    );
  } finally {
    server.state.observationMessages = original;
  }
  assert.equal(compareCrossProcessObservation(raw, harness).result, "pass");
}

function assertUnattendedPolicyDelta(policy) {
  assert.deepEqual(
    policy.sessionPermission,
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "plan_exit", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "doom_loop", pattern: "*", action: "allow" },
    ],
    "the harness-only session permission delta must be the reviewed unattended policy",
  );
  assert.deepEqual(
    policy.requests.map((request) => `${request.method} ${request.path}`),
    [
      "GET /global/health", "GET /config", "GET /agent",
      "GET /global/health", "GET /config", "GET /agent",
      "GET /global/health", "GET /provider", "GET /config", "GET /agent",
    ],
    "the harness-only admission delta must recheck health, route, default Agent, and unattended policy before POST",
  );
  return { dimension: "closed_harnessdock_unattended_policy_delta", result: "pass" };
}

function assertDriverAuthorityParity(readOnly, write) {
  assert.deepEqual(
    readOnly.requestTransport,
    write.requestTransport,
    "read-only and write authority must preserve every non-prompt native request field"
  );
  assert.deepEqual(
    readOnly.unattendedPolicy,
    write.unattendedPolicy,
    "read-only and write authority must preserve the same unattended policy/configuration bytes",
  );
  assert.equal(readOnly.authorityEvidence.route, "behavioral_read_only");
  assert.equal(readOnly.authorityEvidence.receipt, "behavioral_read_only");
  assert.equal(write.authorityEvidence.route, "behavioral_write");
  assert.equal(write.authorityEvidence.receipt, "behavioral_write");
  assert.notEqual(readOnly.authorityEvidence.promptText, write.authorityEvidence.promptText);
  return { dimension: "driver_authority_non_prompt_invariance", result: "pass" };
}

function capabilityNotApplicableRows(capabilities) {
  const requirements = [
    ["interrupt", "interruptRequest", "unsupported"],
    ["history", "history", "unavailable"],
    ["exact_session_continuation", "continuation", "fresh_only"],
    ["automatic_recovery_exact_session_transport", "automaticRecovery", "none"],
    ["same_session_recovery_prompt", "automaticRecovery", "none"],
  ];
  return requirements.map(([dimension, capability, requiredValue]) => {
    const observed = capabilities?.values?.[capability];
    assert.equal(observed, requiredValue, `${dimension} is N/A only when the accepted capability snapshot says so`);
    return { dimension, result: "not_applicable", capability, observed };
  });
}

function compareRouteDrift(direct, harness) {
  assert.equal(direct.kind, "route_drift");
  assert.deepEqual(
    { routeDrift: direct.routeDrift, events: direct.events },
    harness,
    "the pre-transport catalog drift must reject before a session is created"
  );
  return { dimension: "route_drift", result: "pass" };
}

async function runHarnessDockRouteDrift({ server, url, directory }) {
  const driver = createOpencodeDriver({
    env: { OPENCODE_SERVER_URL: url },
    serviceManager: { ensure: async () => ({ status: "reused" }) },
  });
  const scope = {
    env: { OPENCODE_SERVER_URL: url }, workspaceRoot: directory,
    rootId: "root_native_parity", agentId: "agent_native_parity", turnId: "turn_native_parity", attemptId: "attempt_native_parity",
  };
  const before = server.requests.length;
  const [inspection] = await driver.inspectInstances(scope);
  const route = driver.validateRoute({
    harnessId: "opencode", model: NATIVE_INPUT.model, topology: "leaf", authority: NATIVE_INPUT.authority, effort: NATIVE_INPUT.effort,
  }, inspection);
  const prepared = driver.prepareTurn({ route, taskInput: NATIVE_INPUT.taskInput, turnOptions: { effort: route.effort } });
  server.state.provider = providerCatalog({ effort: "other" });
  await assert.rejects(
    driver.revalidatePreparedTurn(prepared, scope),
    (error) => error?.code === "route_not_admitted"
  );
  const requests = server.requests.slice(before);
  return { routeDrift: "route_not_admitted", events: requestOrder(splitHarnessRequestEvidence(requests).requestTransport.requests) };
}

function assertComparatorSensitivity(direct, harness) {
  const mutations = [
    ["provider catalog variant", (value) => { value.inventory[0].efforts = ["other"]; }],
    ["execution directory", (value) => { value.executionDirectory.witness = "missing"; }],
    ["native config default Agent", (value) => { value.configuration.defaultAgentDigest = "sha256:changed"; }],
    ["native selected Agent", (value) => { value.configuration.selectedAgentDigest = "sha256:changed"; }],
    ["native policy", (value) => { value.configuration.permissionDigest = "sha256:changed"; }],
    ["request order", (value) => { value.events.requestOrder = [...value.events.requestOrder].reverse(); }],
    ["response part order", (value) => { value.events.partTypes = [...value.events.partTypes].reverse(); }],
    ["request body model", (value) => { value.requestTransport.requests[2].body.model.variant = "other"; }],
    ["authority agent input", (value) => { value.requestTransport.requests[3].body.agent = "other"; }],
    ["authority tools input", (value) => { value.requestTransport.requests[3].body.tools = {}; }],
    ["authority sandbox input", (value) => { value.requestTransport.requests[3].body.sandbox = "other"; }],
    ["authority configuration input", (value) => { value.requestTransport.requests[3].query.directory = "/other"; }],
    ["authority transport header", (value) => { value.requestTransport.requests[3].headers.authorization = "present"; }],
    ["response lineage", (value) => { value.terminal.lineage = "mismatched"; }],
    ["terminal status", (value) => { value.terminal.classification = "failed"; }],
    ["provider usage source", (value) => { value.usage.outputTokens = 0; }],
    ["cleanup", (value) => { value.lifecycle.cleanup = "capacity_held"; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(harness);
    mutate(changed);
    assert.throws(() => compareEvidence(direct, changed), undefined, `${label} must fail the behavioral comparator`);
  }
}

async function assertNativeConfigurationSensitivity(directory) {
  const baselineServer = await startServer(directory);
  const baseline = await runRawHttpOpenCodeOracle({
    serverUrl: baselineServer.url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
    directory, configurationWitness: NATIVE_INPUT.configurationWitness,
  });
  baselineServer.server.state.config.body.default_agent = "alternate-primary";
  baselineServer.server.state.agents.body.push({
    name: "alternate-primary", mode: "primary", native: false,
    permission: structuredClone(baselineServer.server.state.agents.body[0].permission),
  });
  const changedDefault = await runHarnessDockTurn({ server: baselineServer.server, url: baselineServer.url, directory });
  assert.throws(
    () => compareEvidence(baseline, changedDefault),
    undefined,
    "a native default-Agent configuration mutation must fail the behavioral comparator",
  );
  await baselineServer.close();

  const policyServer = await startServer(directory);
  const direct = await runRawHttpOpenCodeOracle({
    serverUrl: policyServer.url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
    directory, configurationWitness: NATIVE_INPUT.configurationWitness,
  });
  policyServer.server.state.agents.body[0].permission[0].action = "allow";
  const changedPolicy = await runHarnessDockTurn({ server: policyServer.server, url: policyServer.url, directory });
  assert.throws(
    () => compareEvidence(direct, changedPolicy),
    undefined,
    "a native resolved-policy mutation must fail the behavioral comparator",
  );
  await policyServer.close();
}

function assertAuthoritySensitivity(readOnly, write) {
  const changed = structuredClone(write);
  changed.requestTransport.requests[3].body.agent = "other";
  assert.throws(
    () => assertDriverAuthorityParity(readOnly, changed),
    undefined,
    "an authority-dependent native body field must fail the authority comparator"
  );
  changed.unattendedPolicy.sessionPermission[0].action = "deny";
  assert.throws(
    () => assertDriverAuthorityParity(readOnly, changed),
    undefined,
    "an unattended-policy mutation must fail the non-prompt comparator",
  );
}

async function assertNativeResponseSensitivity(directory) {
  for (const [label, mutate] of [
    ["response lineage", (response) => { response.body.info.providerID = "other-provider"; }],
    ["terminal status", (response) => { response.body.info.finish = "error"; }],
  ]) {
    const base = nativePromptResponse(directory);
    const fixture = await startServer(directory, (input) => {
      const response = base(input);
      mutate(response);
      return response;
    });
    const direct = await runRawHttpOpenCodeOracle({
      serverUrl: fixture.url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const harness = await runHarnessDockTurn({ server: fixture.server, url: fixture.url, directory });
    assert.throws(() => compareEvidence(direct, harness), undefined, `${label} must fail the behavioral comparator`);
    await fixture.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(`${label} did not settle before the bounded deadline.`);
}

async function stopManagedChild(pid) {
  if (!processAlive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
  await waitFor(() => !processAlive(pid), "managed test-owned OpenCode process cleanup");
}

function managedProcessEnvironment({ url, record, envFile }) {
  return {
    ...process.env,
    OPENCODE_EXECUTABLE: PROCESS_EXECUTABLE,
    OPENCODE_SERVER_URL: url,
    OPENCODE_PERMISSION: '{"*":"allow"}',
    OPENCODE_NATIVE_PARITY_CONFIG: PROCESS_CONFIGURATION,
    OPENCODE_NATIVE_PARITY_RECORD: record,
    HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: String(PROCESS_TTL_SECONDS),
    CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFile,
  };
}

async function managedProcessWitness(record, executable) {
  await waitFor(async () => {
    try { await fs.access(record); return true; } catch { return false; }
  }, "managed OpenCode process witness");
  const value = JSON.parse(await fs.readFile(record, "utf8"));
  return {
    executable,
    argv: value.argv.map((argument) => /^\d+$/.test(argument) ? "{ephemeral-port}" : argument),
    environment: { permissionDigest: value.permissionDigest },
    configurationDigest: value.configurationDigest,
    health: "healthy",
    reuse: "same_process",
    cleanup: "no_survivor",
  };
}

async function runManagedProcessOracle(root, attempt = 0) {
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const record = path.join(root, "managed-process.json");
  const runtimeRoot = path.join(root, "managed-runtime");
  const envFile = path.join(root, "managed-runtime.env");
  await fs.writeFile(envFile, [
    `OPENCODE_EXECUTABLE=${PROCESS_EXECUTABLE}`,
    `OPENCODE_SERVER_URL=${url}`,
    `HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS=${PROCESS_TTL_SECONDS}`,
    "",
  ].join("\n"));
  const env = managedProcessEnvironment({ url, record, envFile });
  let now = 1_000;
  let peerActivity = "none";
  const options = {
    env,
    runtimeRoot,
    now: () => now,
    peerActivity: () => peerActivity,
  };
  const manager = createOpencodeServiceManager(options);
  const receiptFile = path.join(runtimeRoot, "opencode-service", "receipt.json");
  cleanups.push(async () => {
    try {
      const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
      await stopManagedChild(receipt.pid);
    } catch { /* the successful oracle already removed the exact receipt */ }
  });

  const started = await manager.ensure();
  if (started.status === "reused") {
    if (attempt >= 2) throw new Error("could not reserve a test-owned OpenCode process port");
    return runManagedProcessOracle(await fs.mkdtemp(path.join(root, "retry-")), attempt + 1);
  }
  assert.deepEqual(started, { status: "managed" });
  const firstReceipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  const native = await managedProcessWitness(record, PROCESS_EXECUTABLE);
  assert.deepEqual(await manager.ensure(), { status: "managed" });
  const reusedReceipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  assert.equal(reusedReceipt.pid, firstReceipt.pid, "managed reuse must retain the exact child process identity");
  assert.equal(reusedReceipt.identity, firstReceipt.identity, "managed reuse must retain the exact child identity witness");

  const lease = await manager.acquireTurnLease({ rootId: "root", agentId: "agent", turnId: "turn", attemptId: "attempt" });
  now += PROCESS_TTL_SECONDS * 1_000 - 1;
  assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "not_idle" });
  now += 1;
  assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "turn_held" });
  assert.equal(await manager.releaseTurnLease(lease), true);
  now += PROCESS_TTL_SECONDS * 1_000 - 1;
  assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "not_idle" });
  now += 1;
  peerActivity = "present";
  assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "peer_present" });
  peerActivity = "none";
  assert.deepEqual(
    await createOpencodeServiceManager({ ...options, validateIdentity: () => false }).reapIfIdle(),
    { reaped: false, reason: "receipt_unproven" },
  );
  assert.deepEqual(
    await createOpencodeServiceManager({ ...options, terminate: () => ({ attempted: true, delivered: false }) }).reapIfIdle(),
    { reaped: false, reason: "termination_ambiguous" },
  );
  assert.equal(processAlive(firstReceipt.pid), true, "a failed managed termination must leave the exact process alive");
  const failedTerminationNative = { ...native, cleanup: "survivor" };
  assert.deepEqual(await manager.reapIfIdle(), { reaped: true, reason: "terminated" });
  await waitFor(() => !processAlive(firstReceipt.pid), "managed exact child termination");
  return { native, failedTerminationNative };
}

function compareNativeProcessEvidence(direct, managed) {
  assert.deepEqual(direct, managed, "direct and managed executable observations must match");
}

async function assertObservedProcessSensitivities(root, managed) {
  const changedConfiguration = await runDirectOpencodeProcessOracle({
    executable: PROCESS_EXECUTABLE, root, configuration: "different-native-config",
  });
  assert.throws(() => compareNativeProcessEvidence(changedConfiguration, managed), undefined, "an actual native config mutation must fail the process comparator");
  const changedEnvironment = await runDirectOpencodeProcessOracle({
    executable: PROCESS_EXECUTABLE, root, configuration: PROCESS_CONFIGURATION, permission: '{"*":"deny"}',
  });
  assert.throws(() => compareNativeProcessEvidence(changedEnvironment, managed), undefined, "an actual native environment mutation must fail the process comparator");
  await assert.rejects(
    runDirectOpencodeProcessOracle({
      executable: PROCESS_EXECUTABLE, root, configuration: PROCESS_CONFIGURATION,
      args: (port) => ["serve", "--hostname", "127.0.0.1", "--port", `${port}x`],
    }),
    /did not become healthy/,
  );
  await assert.rejects(
    runDirectOpencodeProcessOracle({
      executable: PROCESS_EXECUTABLE, root, configuration: PROCESS_CONFIGURATION, healthState: "unhealthy",
    }),
    /did not become healthy/,
  );
}

async function assertIndependentOracleGuards() {
  const directHttp = await fs.readFile(new URL("./fixtures/native-parity/opencode-raw-http-oracle.mjs", import.meta.url), "utf8");
  const directProcess = await fs.readFile(new URL("./fixtures/native-parity/opencode-direct-process-oracle.mjs", import.meta.url), "utf8");
  const testSource = await fs.readFile(new URL(import.meta.url), "utf8");
  assert.equal(testSource.includes(["opencodeNative", "ConfigurationWitness"].join("")), false, "Driver evidence must not invoke the direct config projection");
  assert.equal(directHttp.includes(["driverAdmission", "Configuration"].join("")), false, "direct config evidence must not invoke the Driver projection");
  for (const forbidden of ["/runtime/", "opencode-service-manager", "process-control", ["managedNative", "ProcessEvidence"].join("")]) {
    assert.equal(directProcess.includes(forbidden), false, `direct process oracle must not import or copy ${forbidden}`);
  }
}

function renderReceipt(rows) {
  const sections = Object.fromEntries(
    Object.entries(rows).map(([name, entries]) => [name, entries.map((entry) => ({ ...entry }))])
  );
  const digest = createHash("sha256").update(JSON.stringify(sections)).digest("hex");
  return `${JSON.stringify({ ...sections, digest: `sha256:${digest}` }, null, 2)}\n`;
}

describe("OpenCode native raw-HTTP differential parity", () => {
  it("compares independent raw HTTP and Driver evidence, derives N/A rows, and rerenders its sanitized receipt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-native-parity-config-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const { server, url } = await startServer(directory);
    await assertIndependentOracleGuards();

    const direct = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const harness = await runHarnessDockTurn({ server, url, directory });
    const comparedRows = compareEvidence(direct, harness);
    const writeDirect = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const writeHarness = await runHarnessDockTurn({ server, url, directory, authority: "behavioral_write" });
    assert.deepEqual(compareEvidence(writeDirect, writeHarness), comparedRows, "the direct native baseline remains stable beside the write-authority Driver turn");
    const authorityRow = assertDriverAuthorityParity(harness, writeHarness);
    const policyRow = assertUnattendedPolicyDelta(harness.unattendedPolicy);
    const crossProcessObservation = await runCrossProcessObservation({ server, url, directory });
    await assertCrossProcessObservationSensitivity({ server, url, ...crossProcessObservation });
    const observationRow = compareCrossProcessObservation(crossProcessObservation.raw, crossProcessObservation.harness);
    assertComparatorSensitivity(direct, harness);
    assertAuthoritySensitivity(harness, writeHarness);
    await assertNativeResponseSensitivity(directory);
    await assertNativeConfigurationSensitivity(directory);
    const processRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-native-parity-process-"));
    cleanups.push(() => fs.rm(processRoot, { recursive: true, force: true }));
    const directProcess = await runDirectOpencodeProcessOracle({
      executable: PROCESS_EXECUTABLE, root: processRoot, configuration: PROCESS_CONFIGURATION,
    });
    const managedProcess = await runManagedProcessOracle(processRoot);
    compareNativeProcessEvidence(directProcess, managedProcess.native);
    assert.throws(() => compareNativeProcessEvidence(directProcess, managedProcess.failedTerminationNative), undefined, "an actual surviving managed process must fail the native lifecycle comparator");
    await assertObservedProcessSensitivities(processRoot, managedProcess.native);
    const processRows = [
      { dimension: "direct_executable_process_lifecycle_comparison", result: "pass" },
      { dimension: "managed_service_process_lifecycle", result: "pass" },
    ];

    server.state.provider = providerCatalog();
    const directDrift = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
      beforeRecheck: async () => { server.state.provider = providerCatalog({ effort: "other" }); },
    });
    server.state.provider = providerCatalog();
    const harnessDrift = await runHarnessDockRouteDrift({ server, url, directory });
    const driftRow = compareRouteDrift(directDrift, harnessDrift);

    const receipt = renderReceipt({
      provenRows: [...comparedRows, authorityRow, policyRow, observationRow, driftRow, ...processRows],
      notApplicableRows: capabilityNotApplicableRows(harness.capabilities),
      unprovenRows: [],
    });
    assert.equal(receipt.includes(directory), false, "receipt must not disclose the disposable configuration identity");
    assert.equal(receipt.includes(url), false, "receipt must not disclose the test origin");
    assert.equal(receipt, await fs.readFile(RECEIPT_PATH, "utf8"), "checked-in receipt must rerender byte-identically");
  });
});
