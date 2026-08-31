/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 6.1/6.2/6.3/6.5 of add-opencode-explorer-driver: exact provider-reported
 * metrics, route-keyed usage identity, bounded provenance, and the deliberate
 * separation between persistent-Server reuse and provider cache telemetry.
 *
 * No request of any kind is made here. The metrics cases drive the result
 * selector with crafted assistant messages built from the pinned schema, because
 * the selector is where the one single-read snapshot of a lineage-matched message
 * lives -- reading the numbers anywhere else would mean reading them twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPENCODE_PROVIDER_METRIC_FIELDS,
  selectOpencodeExplorerFinalResult,
} from "../../runtime/opencode-result.mjs";
import {
  OPENCODE_FORBIDDEN_INFERRED_FIELDS,
  OPENCODE_SERVER_REUSE_FIELDS,
  OPENCODE_USAGE_KEY_FIELDS,
  OPENCODE_USAGE_PLUGIN_FIELDS,
  OPENCODE_USAGE_RECORD_VERSION,
  OPENCODE_USAGE_STATUS_VALUES,
  OpencodeUsageError,
  assertNoInferredUsageFields,
  buildOpencodeServerReuseFacts,
  buildOpencodeUsageRecord,
  canonicalOpencodeUsageIdentityText,
  opencodeUsageKey,
} from "../../runtime/opencode-usage.mjs";

const SESSION_ID = "ses_usage";
const MESSAGE_ID = "msg_assistant_usage";
const PARENT_ID = "msg_user_usage";
const PROVIDER_ID = "opencode-go";
const MODEL_ID = "deepseek-v4-flash";
const VARIANT = "high";

function assistantInfo(overrides = {}) {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: PARENT_ID,
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    mode: "primary",
    agent: "codex-explorer",
    variant: VARIANT,
    path: { cwd: "/opt/operator-owned/workspace", root: "/opt/operator-owned" },
    cost: 0.25,
    tokens: { total: 900, input: 700, output: 150, reasoning: 50, cache: { read: 600, write: 40 } },
    finish: "stop",
    ...overrides,
  };
}

function expectedLineage() {
  return {
    sessionId: SESSION_ID,
    parentMessageId: PARENT_ID,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    agent: "codex-explorer",
    attemptId: "att_usage",
    variant: VARIANT,
  };
}

function metricsFor(infoOverrides, parts = null) {
  const info = assistantInfo(infoOverrides);
  const result = selectOpencodeExplorerFinalResult(
    {
      info,
      parts:
        parts ??
        [{ id: "prt_1", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "text", text: "the answer" }],
    },
    expectedLineage()
  );
  return result;
}

function identity(overrides = {}) {
  return {
    rootId: "root_1",
    agentId: "agent_1",
    turnId: "job_1",
    attemptId: "att_1",
    harnessId: "opencode",
    instanceKey: "opencode-server-0123456789abcdef",
    model: "opencode-go/deepseek-v4-flash",
    driverVersion: "opencode@1",
    capabilitySchemaVersion: 2,
    topology: "leaf",
    authority: "behavioral_read_only",
    ...overrides,
  };
}

function throwsUsage(code, field) {
  return (error) => {
    assert.ok(error instanceof OpencodeUsageError, `expected OpencodeUsageError, got ${error?.name}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  };
}

// ---------------------------------------------------------------------------
// 6.1 Exact provider-reported facts, or unknown.
// ---------------------------------------------------------------------------

describe("opencode usage: exact provider-reported metrics", () => {
  it("maps exactly the six facts the pinned schema declares", () => {
    const result = metricsFor({});
    assert.equal(result.ok, true);
    assert.deepEqual({ ...result.providerMetrics }, {
      inputTokens: 700,
      outputTokens: 150,
      reasoningTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 40,
      reportedCost: 0.25,
      provenance: "provider_reported",
      malformedFields: [],
    });
    assert.deepEqual([...OPENCODE_PROVIDER_METRIC_FIELDS].sort(), [
      "cacheReadTokens",
      "cacheWriteTokens",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "reportedCost",
    ]);
    // `tokens.total` is derivable and deliberately not a carried fact.
    assert.equal(Object.hasOwn(result.providerMetrics, "total"), false);
    assert.equal(Object.isFrozen(result.providerMetrics), true);
  });

  it("leaves every token fact unknown when the tokens object is absent", () => {
    const result = metricsFor({ tokens: undefined });
    assert.equal(result.providerMetrics.inputTokens, null);
    assert.equal(result.providerMetrics.outputTokens, null);
    assert.equal(result.providerMetrics.reasoningTokens, null);
    assert.equal(result.providerMetrics.cacheReadTokens, null);
    assert.equal(result.providerMetrics.cacheWriteTokens, null);
    // A present cost survives an absent tokens object.
    assert.equal(result.providerMetrics.reportedCost, 0.25);
    assert.deepEqual([...result.providerMetrics.malformedFields], []);
  });

  it("keeps a partial tokens object partial instead of zero-filling it", () => {
    const result = metricsFor({ tokens: { input: 10, output: 5 } });
    assert.equal(result.providerMetrics.inputTokens, 10);
    assert.equal(result.providerMetrics.outputTokens, 5);
    assert.equal(result.providerMetrics.reasoningTokens, null, "absent reasoning is unknown, not zero");
    assert.equal(result.providerMetrics.cacheReadTokens, null);
    assert.equal(result.providerMetrics.cacheWriteTokens, null);
  });

  it("distinguishes a present-but-zero cache fact from an absent one", () => {
    const zeroed = metricsFor({ tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
    assert.equal(zeroed.providerMetrics.cacheReadTokens, 0);
    assert.equal(zeroed.providerMetrics.cacheWriteTokens, 0);
    assert.equal(zeroed.providerMetrics.reasoningTokens, 0);
    const absent = metricsFor({ tokens: { input: 1, output: 1 } });
    assert.equal(absent.providerMetrics.cacheReadTokens, null);
    assert.equal(absent.providerMetrics.cacheWriteTokens, null);
    assert.notEqual(zeroed.providerMetrics.cacheReadTokens, absent.providerMetrics.cacheReadTokens);
  });

  it("refuses a negative, non-finite, or string-typed number as unknown and marks it malformed", () => {
    for (const [field, tokens] of [
      ["inputTokens", { input: -1, output: 1 }],
      ["outputTokens", { input: 1, output: Number.NaN }],
      ["reasoningTokens", { input: 1, output: 1, reasoning: Number.POSITIVE_INFINITY }],
      ["inputTokens", { input: "700", output: 1 }],
      ["outputTokens", { input: 1, output: 1.5 }],
      ["cacheReadTokens", { input: 1, output: 1, cache: { read: -5, write: 0 } }],
      ["cacheWriteTokens", { input: 1, output: 1, cache: { read: 0, write: "40" } }],
    ]) {
      const result = metricsFor({ tokens });
      assert.equal(result.providerMetrics[field], null, field);
      assert.equal(result.providerMetrics.malformedFields.includes(field), true, field);
    }
  });

  it("treats a malformed cache object as unknown cache facts without losing the token counts", () => {
    for (const cache of ["not-an-object", 7, []]) {
      const result = metricsFor({ tokens: { input: 11, output: 3, reasoning: 1, cache } });
      assert.equal(result.providerMetrics.inputTokens, 11, JSON.stringify(cache));
      assert.equal(result.providerMetrics.outputTokens, 3);
      assert.equal(result.providerMetrics.reasoningTokens, 1);
      assert.equal(result.providerMetrics.cacheReadTokens, null);
      assert.equal(result.providerMetrics.cacheWriteTokens, null);
      assert.equal(result.providerMetrics.malformedFields.includes("cacheReadTokens"), true);
      assert.equal(result.providerMetrics.malformedFields.includes("cacheWriteTokens"), true);
    }
  });

  it("keeps tokens when the cost is absent, and the cost when it is malformed", () => {
    const noCost = metricsFor({ cost: undefined });
    assert.equal(noCost.providerMetrics.reportedCost, null);
    assert.equal(noCost.providerMetrics.inputTokens, 700);
    assert.deepEqual([...noCost.providerMetrics.malformedFields], []);
    for (const cost of [-0.5, Number.NaN, "0.25", Number.POSITIVE_INFINITY]) {
      const result = metricsFor({ cost });
      assert.equal(result.providerMetrics.reportedCost, null, String(cost));
      assert.equal(result.providerMetrics.malformedFields.includes("reportedCost"), true, String(cost));
    }
  });

  it("still reports metrics for a refused projection whose lineage was proven", () => {
    const emptyFinal = metricsFor({}, [
      { id: "prt_1", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "text", text: "   " },
    ]);
    assert.equal(emptyFinal.ok, false);
    assert.equal(emptyFinal.code, "empty_final_text");
    assert.equal(emptyFinal.providerMetrics.inputTokens, 700, "a refused answer still consumed provider work");
    const providerError = metricsFor({ error: { name: "APIError", data: { message: "x" } } });
    assert.equal(providerError.code, "provider_error");
    assert.equal(providerError.providerMetrics.reportedCost, 0.25);
  });

  it("reports no metrics at all when the payload itself was rejected", () => {
    const crossed = selectOpencodeExplorerFinalResult(
      { info: assistantInfo({ sessionID: "ses_other" }), parts: [] },
      expectedLineage()
    );
    assert.equal(crossed.code, "lineage_mismatch");
    assert.equal(crossed.providerMetrics, undefined, "an untrusted payload proves no numbers");
    const malformed = selectOpencodeExplorerFinalResult({ info: null, parts: [] }, expectedLineage());
    assert.equal(malformed.code, "malformed_response");
    assert.equal(malformed.providerMetrics, undefined);
  });

  it("counts tool parts without reading any tool name, input, or output", () => {
    const parts = [
      { id: "p1", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "tool", callID: "c1", tool: "grep", state: { output: "TOOL-SENTINEL" } },
      { id: "p2", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "tool", callID: "c2", tool: "read", state: {} },
      { id: "p3", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "step-start" },
      { id: "p4", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "text", text: "answer" },
    ];
    const result = metricsFor({}, parts);
    assert.equal(result.toolCallCount, 2);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("TOOL-SENTINEL"), false);
    assert.equal(serialized.includes("grep"), false);
  });
});

// ---------------------------------------------------------------------------
// 6.2 Route-keyed identity: same model, different Harness, never one record.
// ---------------------------------------------------------------------------

describe("opencode usage: route-keyed identity", () => {
  it("requires all eleven identity fields", () => {
    assert.deepEqual([...OPENCODE_USAGE_KEY_FIELDS], [
      "agentId",
      "attemptId",
      "authority",
      "capabilitySchemaVersion",
      "driverVersion",
      "harnessId",
      "instanceKey",
      "model",
      "rootId",
      "topology",
      "turnId",
    ]);
    for (const field of OPENCODE_USAGE_KEY_FIELDS) {
      const incomplete = identity();
      delete incomplete[field];
      assert.throws(() => opencodeUsageKey(incomplete), throwsUsage("usage_identity_incomplete", field), field);
      const nulled = identity({ [field]: null });
      assert.throws(() => opencodeUsageKey(nulled), throwsUsage("usage_identity_incomplete", field), field);
    }
  });

  it("is stable for one turn and independent of field order", () => {
    const key = opencodeUsageKey(identity());
    assert.match(key, /^ocu1:[0-9a-f]{32}$/);
    assert.equal(opencodeUsageKey(identity()), key);
    const reordered = {};
    for (const field of [...OPENCODE_USAGE_KEY_FIELDS].reverse()) reordered[field] = identity()[field];
    assert.equal(opencodeUsageKey(reordered), key);
    assert.equal(canonicalOpencodeUsageIdentityText(reordered), canonicalOpencodeUsageIdentityText(identity()));
  });

  it("never merges the same full model served by a different Harness", () => {
    // The exact scenario the spec names: one model string, two Harnesses.
    const opencodeKey = opencodeUsageKey(identity());
    const otherHarness = opencodeUsageKey(identity({ harnessId: "opencode-mirror" }));
    assert.notEqual(otherHarness, opencodeKey);
    assert.equal(
      canonicalOpencodeUsageIdentityText(identity()).includes('"opencode"'),
      true,
      "the Harness is part of the identity text, not an afterthought"
    );
  });

  it("separates every other identity axis too", () => {
    const base = opencodeUsageKey(identity());
    for (const [field, value] of [
      ["rootId", "root_2"],
      ["agentId", "agent_2"],
      ["turnId", "job_2"],
      ["attemptId", "att_2"],
      ["instanceKey", "opencode-server-fedcba9876543210"],
      ["model", "opencode-go/deepseek-v4-pro"],
      ["driverVersion", "opencode@2"],
      ["capabilitySchemaVersion", 4],
      ["topology", "native_orchestrator"],
      ["authority", "behavioral_write"],
    ]) {
      assert.notEqual(opencodeUsageKey(identity({ [field]: value })), base, field);
    }
  });

  it("refuses an unknown identity field and an exotic identity object", () => {
    assert.throws(
      () => opencodeUsageKey({ ...identity(), effort: "high" }),
      throwsUsage("usage_identity_invalid", "effort")
    );
    assert.throws(() => opencodeUsageKey(new Proxy(identity(), {})), throwsUsage("usage_identity_invalid"));
    assert.throws(
      () =>
        opencodeUsageKey(
          Object.defineProperty(identity(), "model", { get: () => "opencode-go/deepseek-v4-flash", enumerable: true })
        ),
      throwsUsage("usage_identity_invalid")
    );
  });
});

// ---------------------------------------------------------------------------
// 6.3 Bounded provenance: identities only, never payloads.
// ---------------------------------------------------------------------------

describe("opencode usage: bounded provenance", () => {
  function record(overrides = {}) {
    return buildOpencodeUsageRecord({
      identity: identity(),
      status: "completed",
      providerMetrics: {
        inputTokens: 700,
        outputTokens: 150,
        reasoningTokens: 50,
        cacheReadTokens: 600,
        cacheWriteTokens: 40,
        reportedCost: 0.25,
        provenance: "provider_reported",
        malformedFields: [],
      },
      plugin: { toolCallCount: 2, attemptCount: 1, recoveryAttemptCount: 0 },
      serverReuse: { latencyMs: 1200, serverVersion: "1.18.18" },
      ...overrides,
    });
  }

  it("builds one closed, frozen, bounded record", () => {
    const usage = record();
    assert.equal(usage.version, OPENCODE_USAGE_RECORD_VERSION);
    assert.deepEqual(Object.keys(usage).sort(), ["identity", "key", "plugin", "provider", "serverReuse", "status", "version"]);
    assert.equal(Object.isFrozen(usage), true);
    assert.equal(Object.isFrozen(usage.identity), true);
    assert.deepEqual(Object.keys(usage.plugin).sort(), [...OPENCODE_USAGE_PLUGIN_FIELDS]);
    assert.equal(usage.provider.provenance, "provider_reported");
    assert.ok(Buffer.byteLength(JSON.stringify(usage), "utf8") < 4 * 1024);
    for (const status of OPENCODE_USAGE_STATUS_VALUES) {
      assert.equal(record({ status }).status, status);
    }
    assert.throws(() => record({ status: "published" }), throwsUsage("usage_identity_invalid", "status"));
  });

  it("carries no prompt body, transcript, tool event, raw error, endpoint, or credential", () => {
    const serialized = JSON.stringify(record());
    for (const sentinel of [
      "Map how the static Driver registry",
      "PROVIDER-SENTINEL",
      "RAW-SENTINEL",
      "hunter2",
      "authorization",
      "127.0.0.1",
      "http://",
      "/opt/operator-owned",
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
    for (const field of [
      "prompt",
      "promptText",
      "transcript",
      "toolEvents",
      "responseBody",
      "stderr",
      "serverUrl",
      "endpoint",
      "authorization",
      "password",
      "metadata",
    ]) {
      assert.throws(
        () => buildOpencodeUsageRecord({ ...unwrapRecordInput(), [field]: "x" }),
        throwsUsage("usage_provenance_excluded", field),
        field
      );
    }
  });

  function unwrapRecordInput() {
    return {
      identity: identity(),
      status: "completed",
      providerMetrics: null,
      plugin: {},
      serverReuse: {},
    };
  }

  it("refuses a path-shaped, endpoint-shaped, or credential-shaped identity value", () => {
    for (const [field, value] of [
      ["instanceKey", "/opt/operator-owned/opencode"],
      ["instanceKey", "http://127.0.0.1:4096"],
      ["model", "opencode-go/deepseek v4 flash"],
      ["agentId", "agent secret-token"],
      ["rootId", "x".repeat(300)],
    ]) {
      assert.throws(() => opencodeUsageKey(identity({ [field]: value })), (error) => {
        assert.ok(error instanceof OpencodeUsageError);
        assert.ok(["usage_provenance_excluded", "usage_identity_invalid"].includes(error.code), error.code);
        return true;
      }, `${field}=${value}`);
    }
  });

  it("refuses provider metrics that were not provider-reported, and unknown metric fields", () => {
    assert.throws(
      () => record({ providerMetrics: { inputTokens: 1, provenance: "plugin_estimated" } }),
      throwsUsage("usage_provenance_invalid")
    );
    assert.throws(
      () => record({ providerMetrics: { provenance: "provider_reported", totalTokens: 900 } }),
      throwsUsage("usage_provenance_excluded", "totalTokens")
    );
    assert.throws(
      () => record({ providerMetrics: { provenance: "provider_reported", inputTokens: -1 } }),
      throwsUsage("usage_identity_invalid", "inputTokens")
    );
    assert.throws(
      () => record({ plugin: { toolCallCount: -1 } }),
      throwsUsage("usage_identity_invalid", "toolCallCount")
    );
    assert.throws(() => record({ plugin: { latencyMs: 5 } }), throwsUsage("usage_provenance_excluded", "latencyMs"));
  });

  it("accepts an unknown-only metric set: absent numbers are still a valid record", () => {
    const usage = record({
      providerMetrics: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reportedCost: null,
        provenance: "provider_reported",
        malformedFields: ["inputTokens"],
      },
    });
    assert.equal(usage.provider.inputTokens, null);
    assert.deepEqual([...usage.provider.malformedFields], ["inputTokens"]);
  });
});

// ---------------------------------------------------------------------------
// 6.5 Server reuse and provider cache telemetry stay separate.
// ---------------------------------------------------------------------------

describe("opencode usage: Server reuse is not cache telemetry", () => {
  it("declares only observation fields, none of them cache or price shaped", () => {
    assert.deepEqual([...OPENCODE_SERVER_REUSE_FIELDS], [
      "derivedFromCacheTelemetry",
      "latencyMs",
      "serverIncarnationProven",
      "serverVersion",
      "sessionLifecycle",
    ]);
    for (const field of OPENCODE_SERVER_REUSE_FIELDS) {
      assert.equal(/cache_read|cache_write|cacheRead|cacheWrite|price|saving|charge|subscription/i.test(field), false, field);
    }
  });

  it("records what it observed and states outright that it proves no incarnation", () => {
    const reuse = buildOpencodeServerReuseFacts({ latencyMs: 4200, serverVersion: "1.18.18" });
    assert.deepEqual({ ...reuse }, {
      latencyMs: 4200,
      serverVersion: "1.18.18",
      sessionLifecycle: "fresh_session_per_agent",
      serverIncarnationProven: false,
      derivedFromCacheTelemetry: false,
    });
    const unobserved = buildOpencodeServerReuseFacts({});
    assert.equal(unobserved.latencyMs, null);
    assert.equal(unobserved.serverVersion, null);
  });

  it("is idempotent over its own output but cannot be talked into a claim", () => {
    const reuse = buildOpencodeServerReuseFacts({ latencyMs: 1, serverVersion: "1.18.18" });
    assert.deepEqual({ ...buildOpencodeServerReuseFacts(reuse) }, { ...reuse });
    assert.throws(
      () => buildOpencodeServerReuseFacts({ ...reuse, serverIncarnationProven: true }),
      throwsUsage("usage_provenance_excluded", "serverIncarnationProven")
    );
    assert.throws(
      () => buildOpencodeServerReuseFacts({ ...reuse, derivedFromCacheTelemetry: true }),
      throwsUsage("usage_provenance_excluded", "derivedFromCacheTelemetry")
    );
  });

  it("refuses every field that would infer provider behaviour from latency or identity", () => {
    for (const field of OPENCODE_FORBIDDEN_INFERRED_FIELDS) {
      assert.throws(
        () => assertNoInferredUsageFields({ serverReuse: { [field]: 1 } }),
        throwsUsage("usage_inference_forbidden", field),
        field
      );
      assert.throws(
        () => buildOpencodeServerReuseFacts({ latencyMs: 1, [field]: 1 }),
        throwsUsage("usage_provenance_excluded", field),
        field
      );
    }
  });

  it("keeps a high latency with absent cache facts as unknown cache, never a hit", () => {
    const usage = buildOpencodeUsageRecord({
      identity: identity(),
      status: "completed",
      providerMetrics: {
        inputTokens: 700,
        outputTokens: 10,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reportedCost: null,
        provenance: "provider_reported",
        malformedFields: [],
      },
      plugin: { toolCallCount: 0, attemptCount: 1, recoveryAttemptCount: 0 },
      serverReuse: { latencyMs: 12, serverVersion: "1.18.18" },
    });
    // A very fast turn with no reported cache fields says nothing about caching.
    assert.equal(usage.provider.cacheReadTokens, null);
    assert.equal(usage.provider.cacheWriteTokens, null);
    assert.equal(usage.serverReuse.latencyMs, 12);
    const serialized = JSON.stringify(usage);
    for (const inferred of OPENCODE_FORBIDDEN_INFERRED_FIELDS) {
      assert.equal(serialized.includes(inferred), false, inferred);
    }
  });

  it("keeps the two measurements in separate objects", () => {
    const usage = buildOpencodeUsageRecord({
      identity: identity(),
      status: "completed",
      providerMetrics: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 600,
        cacheWriteTokens: 40,
        reportedCost: 0.5,
        provenance: "provider_reported",
        malformedFields: [],
      },
      plugin: { toolCallCount: 0, attemptCount: 1, recoveryAttemptCount: 0 },
      serverReuse: { latencyMs: 5, serverVersion: "1.18.18" },
    });
    for (const key of Object.keys(usage.serverReuse)) {
      assert.equal(OPENCODE_PROVIDER_METRIC_FIELDS.includes(key), false, key);
    }
    for (const key of Object.keys(usage.provider)) {
      assert.equal(OPENCODE_SERVER_REUSE_FIELDS.includes(key), false, key);
    }
    assert.equal(usage.provider.cacheReadTokens, 600);
    assert.equal(Object.hasOwn(usage.serverReuse, "cacheReadTokens"), false);
  });
});
