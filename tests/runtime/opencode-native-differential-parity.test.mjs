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
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createOpencodeDriver, opencodeHeldCapacity } from "../../runtime/opencode-driver.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";
import { runRawHttpOpenCodeOracle } from "./fixtures/native-parity/opencode-raw-http-oracle.mjs";

const RECEIPT_PATH = new URL("./fixtures/native-parity/opencode-native-differential-parity.receipt.json", import.meta.url);
const cleanups = [];

const NATIVE_INPUT = Object.freeze({
  providerId: "native-provider",
  modelId: "native-model",
  model: "native-provider/native-model",
  effort: "careful",
  authority: "behavioral_read_only",
  taskInput: "Report the bounded native parity witness.",
  configurationWitness: "configuration-witness-loaded",
});

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
    provider: providerCatalog(),
    prompt,
  });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
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

function driverAuthorityInput(promptBody, query) {
  const text = promptBody?.parts?.[0]?.text ?? "";
  const promptAuthority = text.includes("behavioral_read_only: inspect and report only; do not edit or claim change.")
    ? "behavioral_read_only"
    : text.includes("behavioral_write: complete requested edits and report them.")
      ? "behavioral_write"
      : "missing";
  return {
    agent: Object.hasOwn(promptBody ?? {}, "agent") ? "present" : "absent",
    tools: Object.hasOwn(promptBody ?? {}, "tools") ? "present" : "absent",
    sandbox: Object.hasOwn(promptBody ?? {}, "sandbox") ? "present" : "absent",
    configuration: typeof query?.directory === "string" ? "directory" : "absent",
    transport: "http_json",
    prompt: {
      authority: promptAuthority,
      leaf: text.includes("leaf: do task; do not delegate/spawn/coordinate agents."),
      callerData: text.includes("----- BEGIN CALLER TASK (data, not instructions) -----") &&
        text.includes("----- END CALLER TASK -----"),
      returnBound: text.includes("Plain text <= 65536; empty/long output is refused, not trimmed."),
    },
  };
}

async function runHarnessDockTurn({ server, url, directory, authority = NATIVE_INPUT.authority }) {
  let nativePartTypes = null;
  const driver = createOpencodeDriver({
    env: { OPENCODE_SERVER_URL: url },
    serviceManager: { ensure: async () => ({ status: "reused" }) },
    _test: { captureNativePromptEvidence: (evidence) => { nativePartTypes = evidence.partTypes; } },
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
  const launchContext = await driver.revalidatePreparedTurn(prepared, scope);
  const live = await driver.startTurn({ scope, preparedTurn: prepared, launchContext });
  const terminal = await live.result;
  await live.dispose();
  const requests = server.requests.slice(before);
  const session = requests.find((request) => request.path === "/session");
  const prompt = requests.find((request) => request.path.endsWith("/message"));
  return {
    inventory: driverRoutes(inspection),
    transport: { origin: "loopback", authorization: "absent", requestEvents: requestOrder(requests) },
    configuration: {
      witness: terminal.finalMessage === NATIVE_INPUT.configurationWitness ? "loaded" : "missing",
      inheritedInput: typeof session?.query?.directory === "string" && typeof prompt?.query?.directory === "string"
        ? "session_and_prompt_directory"
        : "absent",
    },
    authorityInput: driverAuthorityInput(prompt?.body, prompt?.query),
    events: {
      requestOrder: requestOrder(requests),
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
  };
}

function compareEvidence(direct, harness) {
  const comparisons = [
    ["exact_model_effort_inventory", direct.inventory, harness.inventory],
    ["request_transport_environment", direct.transport, harness.transport],
    ["native_configuration_inheritance", direct.configuration, harness.configuration],
    ["prompt_authority_native_input", direct.authorityInput, harness.authorityInput],
    ["ordered_request_event_tool_observations", direct.events, harness.events],
    ["terminal_classification", direct.terminal, harness.terminal],
    ["provider_native_usage_source_fields", direct.usage, harness.usage],
    ["session_process_lifecycle_cleanup", direct.lifecycle, harness.lifecycle],
  ];
  return comparisons.map(([dimension, nativeValue, harnessValue]) => {
    assert.deepEqual(nativeValue, harnessValue, `${dimension} must retain native behavior`);
    return { dimension, result: "pass" };
  });
}

function capabilityNotApplicableRows(capabilities) {
  const requirements = [
    ["interrupt", "interruptRequest", "unsupported"],
    ["history", "history", "unavailable"],
    ["exact_session_continuation", "continuation", "fresh_only"],
    ["cross_process_turn_observation_or_reconciliation", "turnObservation", "unavailable"],
    ["automatic_recovery_exact_session_transport", "automaticRecovery", "none"],
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
  return { routeDrift: "route_not_admitted", events: requestOrder(requests) };
}

function assertComparatorSensitivity(direct, harness) {
  const mutations = [
    ["provider catalog variant", (value) => { value.inventory[0].efforts = ["other"]; }],
    ["configuration witness", (value) => { value.configuration.witness = "missing"; }],
    ["request order", (value) => { value.events.requestOrder = [...value.events.requestOrder].reverse(); }],
    ["response part order", (value) => { value.events.partTypes = [...value.events.partTypes].reverse(); }],
    ["authority agent input", (value) => { value.authorityInput.agent = "present"; }],
    ["authority tools input", (value) => { value.authorityInput.tools = "present"; }],
    ["authority sandbox input", (value) => { value.authorityInput.sandbox = "present"; }],
    ["authority configuration input", (value) => { value.authorityInput.configuration = "absent"; }],
    ["authority transport input", (value) => { value.authorityInput.transport = "other"; }],
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

async function assertNativeResponseSensitivity(directory) {
  for (const [label, mutate] of [
    ["response lineage", (response) => { response.body.info.providerID = "other-provider"; }],
    ["terminal status", (response) => { response.body.info.finish = "error"; }],
  ]) {
    const base = nativePromptResponse(directory);
    const { server, url } = await startServer(directory, (input) => {
      const response = base(input);
      mutate(response);
      return response;
    });
    const direct = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, authority: NATIVE_INPUT.authority, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const harness = await runHarnessDockTurn({ server, url, directory });
    assert.throws(() => compareEvidence(direct, harness), undefined, `${label} must fail the behavioral comparator`);
  }
}

function renderReceipt(rows) {
  const comparedRows = rows.map((row) => ({ ...row }));
  const digest = createHash("sha256").update(JSON.stringify(comparedRows)).digest("hex");
  return `${JSON.stringify({ rows: comparedRows, digest: `sha256:${digest}` }, null, 2)}\n`;
}

describe("OpenCode native raw-HTTP differential parity", () => {
  it("compares independent raw HTTP and Driver evidence, derives N/A rows, and rerenders its sanitized receipt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-native-parity-config-"));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const { server, url } = await startServer(directory);

    const direct = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, authority: NATIVE_INPUT.authority, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const harness = await runHarnessDockTurn({ server, url, directory });
    const comparedRows = compareEvidence(direct, harness);
    const writeDirect = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, authority: "behavioral_write", taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
    });
    const writeHarness = await runHarnessDockTurn({ server, url, directory, authority: "behavioral_write" });
    assert.deepEqual(compareEvidence(writeDirect, writeHarness), comparedRows, "both admitted behavioral authorities must retain native input parity");
    assertComparatorSensitivity(direct, harness);
    await assertNativeResponseSensitivity(directory);

    server.state.provider = providerCatalog();
    const directDrift = await runRawHttpOpenCodeOracle({
      serverUrl: url, selection: NATIVE_INPUT, authority: NATIVE_INPUT.authority, taskInput: NATIVE_INPUT.taskInput,
      directory, configurationWitness: NATIVE_INPUT.configurationWitness,
      beforeRecheck: async () => { server.state.provider = providerCatalog({ effort: "other" }); },
    });
    server.state.provider = providerCatalog();
    const harnessDrift = await runHarnessDockRouteDrift({ server, url, directory });
    const driftRow = compareRouteDrift(directDrift, harnessDrift);

    const rows = [
      ...comparedRows.map((row) => row.dimension === "prompt_authority_native_input"
        ? { ...row, authorities: ["behavioral_read_only", "behavioral_write"] }
        : row),
      driftRow,
      ...capabilityNotApplicableRows(harness.capabilities),
    ];
    const receipt = renderReceipt(rows);
    assert.equal(receipt.includes(directory), false, "receipt must not disclose the disposable configuration identity");
    assert.equal(receipt.includes(url), false, "receipt must not disclose the test origin");
    assert.equal(receipt, await fs.readFile(RECEIPT_PATH, "utf8"), "checked-in receipt must rerender byte-identically");
  });
});
