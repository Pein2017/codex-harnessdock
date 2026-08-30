/** SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { claudeRouteCapabilities, createClaudeCodeDriverV2 } from "../../runtime/claude-code-driver.mjs";
import { createOpencodeDriver } from "../../runtime/opencode-driver.mjs";
import { createPiDriver } from "../../runtime/pi-driver.mjs";
import { assessNativeHarnessDifferentialParity } from "../../runtime/release-smoke.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";
import {
  assertNativeHarnessDifferentialParityComposition,
  composeNativeHarnessDifferentialParity,
  renderNativeHarnessDifferentialParityMarkdown,
  renderNativeHarnessDifferentialParityReceipt,
  sealNativeHarnessDifferentialParityReceipt,
} from "./fixtures/native-parity/native-harness-differential-parity.mjs";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/native-parity");
const RECEIPT_PATH = path.join(FIXTURES, "native-harness-differential-parity.receipt.json");
const MARKDOWN_PATH = path.join(FIXTURES, "native-harness-differential-parity.receipt.md");

function read(name) { return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")); }
function localReceipts() {
  return {
    claudeReceipt: read("claude-differential-receipt.json"),
    piReceipt: read("pi-native-differential-receipt.json"),
    opencodeReceipt: read("opencode-native-differential-parity.receipt.json"),
  };
}
function reseal(receipt) { return sealNativeHarnessDifferentialParityReceipt(receipt); }

async function piRouteCapabilities() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-pi-parity-snapshot-"));
  const configRoot = path.join(root, "config");
  const stateRoot = path.join(root, "state");
  const sessionRoot = path.join(root, "sessions");
  const env = { PI_CODING_AGENT_DIR: configRoot, PI_NATIVE_PARITY_STATE_DIR: stateRoot, PI_NATIVE_PARITY_ENV_WITNESS: "snapshot" };
  try {
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, "native-parity.json"), JSON.stringify({
      catalog: { "openai-codex/gpt-5.6-luna": ["high"] },
      commands: [{ source: "extension" }, { source: "prompt" }, { source: "skill" }],
      configWitness: "snapshot", usageDelta: { toolCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, terminalStopReason: "stop",
    }));
    const driver = createPiDriver({
      env,
      _test: {
        sessionRoot,
        spawn(_command, argv, options) {
          return spawn(process.execPath, [path.join(FIXTURES, "fake-pi-native.mjs"), ...argv], options);
        },
      },
    });
    const [inspection] = await driver.inspectInstances({ workspaceRoot: root, env });
    const route = driver.validateRoute({
      harnessId: "pi", model: "openai-codex/gpt-5.6-luna", topology: "leaf", authority: "behavioral_read_only", effort: "high",
    }, inspection);
    return route.capabilities;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function opencodeRouteCapabilities() {
  const server = createFakeOpencodeServer({
    health: { status: 200, body: { healthy: true, version: "1.18.23" } },
    config: { status: 200, body: { default_agent: "codex-explorer" } },
    agents: {
      status: 200,
      body: [{
        name: "codex-explorer", mode: "primary", native: false,
        permission: [{ permission: "doom_loop", pattern: "*", action: "allow" }],
      }],
    },
    provider: {
      status: 200,
      body: {
        all: [{ id: "native", models: { model: { id: "model", providerID: "native", variants: { low: {} } } } }],
        connected: ["native"], default: {},
      },
    },
  });
  const url = await server.listen();
  try {
    const driver = createOpencodeDriver({ env: { OPENCODE_SERVER_URL: url }, serviceManager: { ensure: async () => ({ status: "reused" }) } });
    const [inspection] = await driver.inspectInstances({ env: { OPENCODE_SERVER_URL: url }, workspaceRoot: os.tmpdir() });
    return driver.validateRoute({
      harnessId: "opencode", model: "native/model", topology: "leaf", authority: "behavioral_read_only", effort: "low",
    }, inspection).capabilities;
  } finally {
    await server.close();
  }
}

describe("native Harness differential parity", () => {
  it("composes all 42 cells from local evidence and freezes sanitized receipts", async () => {
    const inputs = localReceipts();
    const receipt = composeNativeHarnessDifferentialParity(inputs);
    const assessment = assessNativeHarnessDifferentialParity(receipt);
    assert.deepEqual(assessment.counts, { pass: 31, fail: 0, hold: 1, not_applicable: 10 });
    assert.equal(assessment.status, "hold");
    assert.equal(assessment.promotionEligible, false);
    assert.equal(receipt.cells.length, 42);
    assert.equal(renderNativeHarnessDifferentialParityReceipt(receipt), fs.readFileSync(RECEIPT_PATH, "utf8"));
    assert.equal(renderNativeHarnessDifferentialParityMarkdown(receipt, assessment), fs.readFileSync(MARKDOWN_PATH, "utf8"));
    assertNativeHarnessDifferentialParityComposition(read("native-harness-differential-parity.receipt.json"), inputs);
    const serialized = fs.readFileSync(RECEIPT_PATH, "utf8");
    assert.doesNotMatch(serialized, /(?:\/data\/|https?:\/\/|PI_CODING_AGENT_DIR|OPENCODE_SERVER_URL|Bearer|password|api[_-]?key)/i);

    const descriptions = {
      "claude-code": createClaudeCodeDriverV2().describe(),
      pi: createPiDriver().describe(),
      opencode: createOpencodeDriver().describe(),
    };
    for (const entry of receipt.cells) {
      assert.equal(entry.driverVersion, descriptions[entry.harness].driverVersion);
      assert.equal(entry.capabilitySchemaVersion, descriptions[entry.harness].capabilitySchemaVersion);
      assert.match(entry.directSource, /^[A-Za-z0-9][A-Za-z0-9 ._:@#/,;()\-]*$/);
      assert.match(entry.harnessdockSource, /^[A-Za-z0-9][A-Za-z0-9 ._:@#/,;()\-]*$/);
      assert.match(entry.artifactDigest, /^sha256:[0-9a-f]{64}$/);
    }
    const capabilities = {
      "claude-code": claudeRouteCapabilities("leaf"),
      pi: await piRouteCapabilities(),
      opencode: await opencodeRouteCapabilities(),
    };
    for (const entry of receipt.cells.filter((row) => row.result === "not_applicable")) {
      assert.equal(capabilities[entry.harness].values[entry.notApplicableBasis.capability], entry.notApplicableBasis.observed);
    }
  });

  it("rejects evidence/result composition mutations even when their digests are resealed", () => {
    const inputs = localReceipts();
    const baseline = composeNativeHarnessDifferentialParity(inputs);
    const mutations = [
      (value) => { value.cells[0].localEvidence[0].label = "claude-differential-receipt.json#other"; },
      (value) => { value.cells.find((row) => row.harness === "claude-code" && row.dimension === "exact_model_effort_inventory").result = "pass"; },
      (value) => { value.cells.find((row) => row.harness === "claude-code" && row.dimension === "exact_model_effort_inventory").result = "not_applicable"; value.cells.find((row) => row.harness === "claude-code" && row.dimension === "exact_model_effort_inventory").notApplicableBasis = { capability: "inventory", observed: "unavailable" }; delete value.cells.find((row) => row.harness === "claude-code" && row.dimension === "exact_model_effort_inventory").blockerReason; },
      (value) => { const row = value.cells.find((entry) => entry.harness === "opencode" && entry.dimension === "native_configuration_inheritance"); row.result = "fail"; row.blockerReason = "forged config gap"; },
      (value) => { delete value.cells[0].directSource; },
      (value) => { value.cells[0].directSource = "different source"; },
      (value) => { value.cells[0].directSource = "https://unsafe.example"; },
      (value) => { delete value.cells[0].harnessdockSource; },
      (value) => { value.cells[0].harnessdockSource = "different source"; },
      (value) => { value.cells[0].harnessdockSource = "https://unsafe.example"; },
      (value) => { value.cells[0].artifactDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(baseline);
      mutate(changed);
      assert.throws(() => assertNativeHarnessDifferentialParityComposition(reseal(changed), inputs));
    }
  });

  it("rejects structural and digest mutations in the generic release assessment", () => {
    const baseline = composeNativeHarnessDifferentialParity(localReceipts());
    const mutations = [
      (value) => { value.cells[0].localEvidence[0].label = "claude-differential-receipt.json#other"; },
      (value) => { delete value.cells[0].directSource; },
      (value) => { value.cells[0].directSource = "https://unsafe.example"; },
      (value) => { delete value.cells[0].harnessdockSource; },
      (value) => { value.cells[0].harnessdockSource = "https://unsafe.example"; },
      (value) => { value.cells[0].artifactDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; },
      (value) => { value.cells.pop(); },
      (value) => { value.cells[1] = structuredClone(value.cells[0]); },
      (value) => { value.cells[0].driverVersion = "different"; },
      (value) => { value.cells[0].capabilitySchemaVersion = 2; },
      (value) => { value.digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(baseline);
      mutate(changed);
      assert.throws(() => assessNativeHarnessDifferentialParity(changed));
    }
  });
});
