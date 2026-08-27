/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 1 of add-opencode-explorer-driver: prove the compatibility probe is
 * zero-model/zero-session, sanitizes discovery output, uses the CLI only for
 * version/catalog text (never lifecycle parsing), uses the pinned v2 SDK
 * client for Server facts, confirms the exact model on both independent
 * surfaces, records the codex-explorer profile truthfully, and fails closed
 * on drift/malformed/mutating-request evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEFAULT_OPENCODE_BIN,
  DEFAULT_SERVER_URL,
  DEFAULT_TIMEOUT_MS,
  EXPECTED_EXPLORER_PROFILE,
  EXPECTED_MODEL,
  EXPECTED_MODEL_ID,
  EXPECTED_PROVIDER_ID,
  PINNED_SDK_INTEGRITY,
  PINNED_SDK_PACKAGE,
  PINNED_SDK_VERSION,
  classifyModelRoute,
  determineContinuation,
  extractTopLevelKeys,
  extractTypeBody,
  inspectSdkTypeShapes,
  isLoopbackUrl,
  parseCliVersion,
  parseModelCatalog,
  projectCliDiscovery,
  projectServerDiscovery,
  runCompatibilityProbe,
  sanitizeAgentList,
  sanitizeCapabilities,
  sanitizeProviderCatalog,
} from "../../scripts/probe-opencode-compatibility.mjs";

const UNRELATED_MODEL_IDENTIFIERS = [
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "grok-4.5",
  "hy3",
  "mimo-v2.5",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.6-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.8-max",
  "big-pickle",
  "deepseek-v4-pro",
  "nemotron-3-ultra-free",
];
const UNRELATED_PROVIDER_IDENTIFIERS = ["anthropic", "opencode-go", "deepseek", "opencode"];
const UNRELATED_AGENT_NAMES = ["build", "compaction", "explore", "general", "plan", "summary", "title"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(root, "scripts", "probe-opencode-compatibility.mjs");
const fixturePath = path.join(root, "tests", "runtime", "fixtures", "opencode-compatibility.json");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

function isServerReachable(baseUrl, timeoutMs) {
  try {
    const result = execFileSync(
      process.execPath,
      ["-e", `
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ${timeoutMs});
        fetch(${JSON.stringify(baseUrl)} + "/global/health", { signal: controller.signal })
          .then((r) => r.json())
          .then((body) => { clearTimeout(timer); process.stdout.write(JSON.stringify(body)); })
          .catch(() => { clearTimeout(timer); process.stdout.write("null"); });
      `],
      { encoding: "utf8", timeout: timeoutMs + 2000 }
    );
    const parsed = JSON.parse(result.trim() || "null");
    return parsed && parsed.healthy === true;
  } catch {
    return false;
  }
}

function isOpencodeBinDiscoverable() {
  try {
    execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function resolveDiscoverableOpencodePath() {
  try {
    const resolved = execFileSync("sh", ["-c", "command -v opencode"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return resolved.includes("/") ? resolved : null;
  } catch {
    return null;
  }
}

describe("opencode compatibility probe: pure parsing/sanitization", () => {
  it("accepts only loopback origins without credentials/query/fragment", () => {
    assert.equal(isLoopbackUrl("http://127.0.0.1:4096"), true);
    assert.equal(isLoopbackUrl("http://[::1]:4096"), true);
    // A NAME is not an address. `localhost` is resolved by the DNS resolver at
    // connect time, so admitting it here would pin an origin whose address is
    // decided later and could differ from the one that was checked. The runtime
    // client closes that gap by admitting literal loopback addresses only, and
    // this probe pins the same origin, so it must close it identically.
    assert.equal(isLoopbackUrl("http://localhost:4096"), false);
    assert.equal(isLoopbackUrl("http://LOCALHOST:4096"), false);
    // A bare `::1` never round-trips through URL parsing as a hostname; the
    // bracketed form above is the only IPv6 loopback spelling that exists.
    assert.equal(isLoopbackUrl("http://::1:4096"), false);
    assert.equal(isLoopbackUrl("http://127.0.0.1:4096/probe"), false);
    assert.equal(isLoopbackUrl("http://example.com:4096"), false);
    assert.equal(isLoopbackUrl("http://127.0.0.1.example.com:4096"), false);
    assert.equal(isLoopbackUrl("http://user:pass@127.0.0.1:4096"), false);
    assert.equal(isLoopbackUrl("http://127.0.0.1:4096/?x=1"), false);
    assert.equal(isLoopbackUrl("http://127.0.0.1:4096#frag"), false);
    assert.equal(isLoopbackUrl("not a url"), false);
  });

  it("parses a bare semver-shaped CLI version and rejects noise", () => {
    assert.equal(parseCliVersion("1.18.18\n"), "1.18.18");
    assert.equal(parseCliVersion("opencode 1.18.18"), null);
    assert.equal(parseCliVersion(""), null);
  });

  it("parses the model catalog and drops malformed lines", () => {
    const stdout = [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "",
      "not-a-model-line",
      "  opencode/big-pickle  ",
    ].join("\n");
    const models = parseModelCatalog(stdout);
    assert.deepEqual(models, [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "opencode/big-pickle",
    ]);
  });

  it("sanitizes the agent list to name/mode/native only", () => {
    const raw = [
      {
        name: "build",
        mode: "primary",
        native: true,
        permission: [{ permission: "*", action: "allow", pattern: "*" }],
        prompt: "system prompt text",
      },
      { mode: "primary" },
      null,
    ];
    const result = sanitizeAgentList(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.agents, [{ name: "build", mode: "primary", native: true }]);
    assert.equal(JSON.stringify(result).includes("permission"), false);
    assert.equal(JSON.stringify(result).includes("system prompt text"), false);
  });

  it("sanitizes the provider catalog to the target route only, dropping cost/env/key", () => {
    const raw = {
      connected: ["openai", "opencode", "anthropic"],
      default: { anthropic: "claude-sonnet-4-6" },
      all: [
        {
          id: "openai",
          name: "OpenAI",
          source: "custom",
          env: ["OPENAI_API_KEY"],
          key: "sk-should-not-appear",
          options: {},
          models: {
            "gpt-5.6-luna": {
              id: "gpt-5.6-luna",
              providerID: "openai",
              name: "GPT-5.6 Luna",
              family: "gpt-5.6",
              cost: { input: 0.07, output: 0.14 },
              limit: { context: 1000000 },
            },
          },
        },
        { id: "anthropic", name: "Anthropic", source: "env", env: ["ANTHROPIC_API_KEY"], options: {}, models: {} },
      ],
    };
    const result = sanitizeProviderCatalog(raw, EXPECTED_PROVIDER_ID, EXPECTED_MODEL_ID);
    assert.deepEqual(result.connected, ["openai", "opencode", "anthropic"]);
    assert.equal(result.providerPresent, true);
    assert.equal(result.providerConnected, true);
    assert.deepEqual(result.model, {
      id: "gpt-5.6-luna",
      providerID: "openai",
      name: "GPT-5.6 Luna",
      family: "gpt-5.6",
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("sk-should-not-appear"), false);
    assert.equal(serialized.includes("OPENAI_API_KEY"), false);
    assert.equal(serialized.includes("cost"), false);
    assert.equal(serialized.includes("limit"), false);
  });

  it("passes through only the known capabilities booleans", () => {
    assert.deepEqual(sanitizeCapabilities({ backgroundSubagents: false, someFutureField: "x" }), {
      backgroundSubagents: false,
    });
    assert.deepEqual(sanitizeCapabilities(null), {});
  });
});

describe("opencode compatibility probe: model route drift/malformed classification", () => {
  it("confirms the exact route only when both independent surfaces agree", () => {
    const confirmed = classifyModelRoute({
      cliModels: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"],
      providerCatalog: { providerConnected: true, model: { id: "gpt-5.6-luna", providerID: "openai" } },
    });
    assert.equal(confirmed.cliMatch, true);
    assert.equal(confirmed.serverMatch, true);
    assert.equal(confirmed.exact, EXPECTED_MODEL);
  });

  it("fails closed when the CLI catalog is missing the exact identifier", () => {
    const drifted = classifyModelRoute({
      cliModels: ["openai/gpt-5.6-terra"],
      providerCatalog: { providerConnected: true, model: { id: "gpt-5.6-luna", providerID: "openai" } },
    });
    assert.equal(drifted.cliMatch, false);
    assert.equal(drifted.exact, null);
  });

  it("fails closed when the Server/client discovery does not report the model", () => {
    const drifted = classifyModelRoute({
      cliModels: ["openai/gpt-5.6-luna"],
      providerCatalog: { providerConnected: true, model: null },
    });
    assert.equal(drifted.serverMatch, false);
    assert.equal(drifted.exact, null);
  });

  it("fails closed on a malformed/absent provider catalog", () => {
    const malformed = classifyModelRoute({ cliModels: ["openai/gpt-5.6-luna"], providerCatalog: null });
    assert.equal(malformed.serverMatch, false);
    assert.equal(malformed.exact, null);
  });
});

describe("opencode compatibility probe: continuation evidence", () => {
  it("declares fresh_only when no incarnation-shaped field was observed", () => {
    const result = determineContinuation({ observedFieldNames: ["id", "slug", "title", "time", "tokens", "cost"] });
    assert.equal(result.mode, "fresh_only");
    assert.deepEqual(result.incarnationCandidates, []);
  });

  it("still declares fresh_only even if a candidate-shaped field name appears, without inferring binding proof", () => {
    const result = determineContinuation({ observedFieldNames: ["id", "instanceId", "title"] });
    assert.equal(result.mode, "fresh_only");
    assert.deepEqual(result.incarnationCandidates, ["instanceId"]);
    assert.match(result.reason, /out of Task 1 scope|cross-call binding proof/);
  });
});

describe("opencode compatibility probe: bounded TypeScript type-body extraction", () => {
  it("extracts only the immediate top-level keys of a type, ignoring nested object keys", () => {
    const snippet = `
export type Example = {
    id: string;
    time: {
        created: number;
        completed?: number;
    };
    tokens: {
        input: number;
        cache: {
            read: number;
            write: number;
        };
    };
    finish?: string;
};
export type Other = {
    unrelated: string;
};
`;
    const body = extractTypeBody(snippet, "Example");
    assert.notEqual(body, null);
    const keys = extractTopLevelKeys(body);
    assert.deepEqual(keys, ["id", "time", "tokens", "finish"]);
    assert.equal(keys.includes("created"), false);
    assert.equal(keys.includes("read"), false);
  });

  it("returns null for a type name that is not present", () => {
    assert.equal(extractTypeBody("export type Foo = { a: string };", "Bar"), null);
  });
});

describe("opencode compatibility probe: pinned dependency evidence", () => {
  it("pins @opencode-ai/sdk to the exact frozen version with no range operator", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const pinned = packageJson.dependencies[PINNED_SDK_PACKAGE];
    assert.equal(pinned, PINNED_SDK_VERSION);
    assert.equal(/^[\^~]|latest|\*|>=?|<=?/.test(pinned), false);
  });

  it("matches the frozen registry integrity in the committed lockfile", () => {
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const entry = lockfile.packages[`node_modules/${PINNED_SDK_PACKAGE}`];
    assert.ok(entry, "lockfile must contain the pinned SDK entry");
    assert.equal(entry.version, PINNED_SDK_VERSION);
    assert.equal(entry.integrity, PINNED_SDK_INTEGRITY);
  });

  it("resolves the actual installed v2 client/type shapes deterministically offline", () => {
    const shapes = inspectSdkTypeShapes();
    assert.deepEqual(shapes.clientExports.sort(), ["OpencodeClient", "createOpencodeClient"]);
    assert.ok(shapes.forbiddenExports.includes("createOpencode"));
    assert.ok(shapes.assistantMessageFields.includes("tokens"));
    assert.ok(shapes.assistantMessageFields.includes("cost"));
    assert.ok(shapes.assistantMessageFields.includes("error"));
    assert.ok(shapes.assistantMessageFields.includes("finish"));
    assert.ok(shapes.tokensFields.includes("input"));
    assert.ok(shapes.tokensFields.includes("output"));
    assert.ok(shapes.tokensFields.includes("reasoning"));
    assert.ok(shapes.errorVariantNames.includes("ProviderAuthError"));
    assert.ok(shapes.errorVariantNames.includes("ApiError"));
    assert.equal(shapes.sessionFields.some((name) => /instance|incarnation|boot|pid/i.test(name)), false);
    assert.ok(shapes.clientConfigFields.includes("baseUrl"));
    assert.ok(shapes.clientConfigFields.includes("fetch"));
  });
});

describe("opencode compatibility probe: forbids production-risk imports and lifecycle parsing", () => {
  it("imports only the pinned v2 client, never the Server-spawning helper or bare package barrel", () => {
    assert.match(scriptSource, /@opencode-ai\/sdk\/v2\/client/);
    assert.doesNotMatch(scriptSource, /@opencode-ai\/sdk\/server/);
    assert.doesNotMatch(scriptSource, /@opencode-ai\/sdk\/v2\/server/);
    assert.doesNotMatch(scriptSource, /from\s+["']@opencode-ai\/sdk["']/);
    assert.doesNotMatch(scriptSource, /createOpencode\((?!Client)/);
  });

  it("never calls session creation, prompt, or promptAsync endpoints", () => {
    assert.doesNotMatch(scriptSource, /\.session\.(create|prompt|promptAsync)\s*\(/);
  });

  it("never parses CLI lifecycle output (opencode run / --attach / session status text)", () => {
    assert.doesNotMatch(scriptSource, /opencode["'\s]+run\b/);
    assert.doesNotMatch(scriptSource, /--attach\b/);
  });

  it("never constructs an ad hoc OpenCode REST path outside the SDK client's typed methods", () => {
    for (const restPath of ["/global/health", "/agent", "/provider", "/experimental/capabilities", "/session"]) {
      const literalPathPattern = new RegExp(`["'\`]${restPath.replace(/\//g, "\\/")}`);
      assert.doesNotMatch(scriptSource, literalPathPattern);
    }
  });

  it("makes no raw fetch() call at all: every request goes through the client's fixed-origin bounded seam", () => {
    assert.equal([...scriptSource.matchAll(/\bfetch\(/g)].length, 0);
    assert.match(scriptSource, /import \{ createFixedOriginFetch, isLoopbackOpencodeUrl \} from "\.\.\/runtime\/opencode-client\.mjs"/);
  });

  it("does not hardcode the operator's absolute opencode binary path", () => {
    assert.doesNotMatch(scriptSource, /\/root\/\.opencode\/bin\/opencode/);
    assert.equal(DEFAULT_OPENCODE_BIN, "opencode");
  });
});

describe("opencode compatibility probe: checked-in sanitized fixture", () => {
  it("is present, structurally sound current zero-model evidence", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal(fixture.zeroModel, true);
    assert.equal(fixture.zeroSession, true);
    assert.equal(fixture.modelRoute.expected, EXPECTED_MODEL);
    assert.equal(fixture.modelRoute.exact, EXPECTED_MODEL);
    assert.equal(fixture.modelRoute.cliMatch, true);
    assert.equal(fixture.modelRoute.serverMatch, true);
    assert.equal(fixture.profile.name, EXPECTED_EXPLORER_PROFILE);
    assert.equal(fixture.profile.present, true);
    assert.equal(fixture.continuation.mode, "fresh_only");
    assert.equal(fixture.server.requestAudit.mutatingRequestCount, 0);
    assert.ok(fixture.server.requestAudit.totalRequests > 0);
    assert.ok(fixture.server.requestAudit.methods.every((method) => method === "GET"));
    assert.equal(fixture.pinnedDependency.version, PINNED_SDK_VERSION);
    assert.equal(fixture.pinnedDependency.exactPin, true);

    const serialized = JSON.stringify(fixture);
    for (const forbidden of ["password", "Authorization", "Bearer ", "prompt\":", "transcript", "sk-should-not-appear"]) {
      assert.equal(serialized.includes(forbidden), false, `fixture must not contain ${forbidden}`);
    }
  });

  it("never persists the operator's absolute opencode binary path; only a closed discovery mode", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal("bin" in fixture.cli, false);
    assert.equal(typeof fixture.cli.binMode, "string");
    assert.ok(["path_discovery", "explicit_override"].includes(fixture.cli.binMode));
    const serialized = JSON.stringify(fixture);
    assert.equal(serialized.includes("/root/.opencode"), false);
    assert.doesNotMatch(serialized, /"\/[^"]*\/opencode(\/[^"]*)?"/);
  });

  it("keeps only target-model facts in cli.modelCatalog, never the full catalog", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal("models" in fixture.cli.modelCatalog, false);
    assert.equal(fixture.cli.modelCatalog.targetPresent, true);
    assert.ok(Number.isInteger(fixture.cli.modelCatalog.observedCount));
    assert.ok(fixture.cli.modelCatalog.observedCount > 0);
    const serialized = JSON.stringify(fixture);
    for (const unrelated of UNRELATED_MODEL_IDENTIFIERS) {
      assert.equal(serialized.includes(`"${unrelated}"`), false, `fixture must not contain unrelated model id ${unrelated}`);
    }
  });

  it("keeps only target-provider presence/connected + target model, never the full connected list", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal("connected" in fixture.server.provider, false);
    assert.equal(fixture.server.provider.providerPresent, true);
    assert.equal(fixture.server.provider.providerConnected, true);
    assert.deepEqual(fixture.server.provider.model, {
      id: EXPECTED_MODEL_ID,
      providerID: EXPECTED_PROVIDER_ID,
      name: fixture.server.provider.model.name,
      family: fixture.server.provider.model.family,
    });
    const serialized = JSON.stringify(fixture);
    for (const unrelated of UNRELATED_PROVIDER_IDENTIFIERS) {
      assert.equal(serialized.includes(`"${unrelated}"`), false, `fixture must not contain unrelated provider id ${unrelated}`);
    }
  });

  it("keeps only profile name/present, never the full available-agent name list", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert.equal("availableAgents" in fixture.profile, false);
    assert.equal("agents" in fixture.server, false);
    assert.equal(fixture.profile.name, EXPECTED_EXPLORER_PROFILE);
    assert.equal(fixture.profile.present, true);
    // Scoped to profile/server (not sdkTypeShapes, which legitimately contains
    // bounded SDK field names that happen to overlap with English agent-name
    // words, e.g. "summary"/"title" as AssistantMessage/Session field names).
    const serialized = JSON.stringify({ profile: fixture.profile, server: fixture.server });
    for (const unrelated of UNRELATED_AGENT_NAMES) {
      assert.equal(serialized.includes(`"${unrelated}"`), false, `fixture must not contain unrelated agent name ${unrelated}`);
    }
  });
});

describe("opencode compatibility probe: projection helpers keep raw data process-local", () => {
  it("projects cli discovery to a closed shape with no bin path or full catalog", () => {
    const projected = projectCliDiscovery(
      {
        version: { ok: true, value: "1.18.18" },
        modelCatalog: { ok: true, models: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"] },
      },
      "/root/.opencode/bin/opencode"
    );
    assert.equal("bin" in projected, false);
    assert.equal("models" in projected.modelCatalog, false);
    assert.equal(projected.binMode, "explicit_override");
    assert.deepEqual(projected.modelCatalog, { ok: true, targetPresent: true, observedCount: 2 });
  });

  it("reports path_discovery when the default opencode binary name is used", () => {
    const projected = projectCliDiscovery(
      { version: { ok: true, value: "1.18.18" }, modelCatalog: { ok: true, models: [] } },
      DEFAULT_OPENCODE_BIN
    );
    assert.equal(projected.binMode, "path_discovery");
    assert.equal(projected.modelCatalog.targetPresent, false);
    assert.equal(projected.modelCatalog.observedCount, 0);
  });

  it("passes through a failed model catalog probe without inventing target facts", () => {
    const projected = projectCliDiscovery(
      { version: { ok: false, reason: "spawn_failed" }, modelCatalog: { ok: false, reason: "spawn_failed" } },
      DEFAULT_OPENCODE_BIN
    );
    assert.equal(projected.modelCatalog.ok, false);
    assert.equal("targetPresent" in projected.modelCatalog, false);
  });

  it("projects server discovery to drop the full connected-provider list and agent-name list", () => {
    const projected = projectServerDiscovery({
      baseUrl: DEFAULT_SERVER_URL,
      loopback: true,
      reachable: true,
      health: { healthy: true, version: "1.18.18" },
      agents: { ok: true, agents: [{ name: "build", mode: "primary", native: true }] },
      provider: {
        connected: ["openai", "opencode", "anthropic"],
        providerPresent: true,
        providerConnected: true,
        model: { id: "gpt-5.6-luna", providerID: "openai", name: "GPT-5.6 Luna", family: "gpt-5.6" },
      },
      capabilities: { backgroundSubagents: false },
      requestAudit: { totalRequests: 4, mutatingRequestCount: 0, methods: ["GET", "GET", "GET", "GET"] },
    });
    assert.equal("agents" in projected, false);
    assert.equal("connected" in projected.provider, false);
    assert.deepEqual(projected.provider, {
      providerPresent: true,
      providerConnected: true,
      model: { id: "gpt-5.6-luna", providerID: "openai", name: "GPT-5.6 Luna", family: "gpt-5.6" },
    });
    assert.deepEqual(projected.requestAudit, { totalRequests: 4, mutatingRequestCount: 0, methods: ["GET", "GET", "GET", "GET"] });
  });

  it("passes through an unreachable server projection without inventing provider facts", () => {
    const projected = projectServerDiscovery({
      baseUrl: DEFAULT_SERVER_URL,
      loopback: true,
      reachable: false,
      reason: "health_unavailable",
      requestAudit: { totalRequests: 1, mutatingRequestCount: 0, methods: ["GET"] },
    });
    assert.equal(projected.reachable, false);
    assert.equal(projected.reason, "health_unavailable");
    assert.equal("provider" in projected, false);
  });
});

describe("opencode compatibility probe: live operator Server (skips if unreachable)", () => {
  it("runs the full zero-model probe against the configured loopback Server", async (t) => {
    if (!isServerReachable(DEFAULT_SERVER_URL, 2000)) {
      t.skip("operator OpenCode Server is not reachable at " + DEFAULT_SERVER_URL);
      return;
    }
    const bin = isOpencodeBinDiscoverable() ? DEFAULT_OPENCODE_BIN : process.env.CODEX_HARNESSDOCK_OPENCODE_BIN;
    if (!bin) {
      t.skip("opencode CLI is not discoverable on PATH and CODEX_HARNESSDOCK_OPENCODE_BIN is unset");
      return;
    }
    const report = await runCompatibilityProbe({
      opencodeBin: bin,
      serverUrl: DEFAULT_SERVER_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    assert.equal(report.zeroModel, true);
    assert.equal(report.zeroSession, true);
    assert.equal(report.server.reachable, true);
    assert.equal(report.modelRoute.exact, EXPECTED_MODEL);
    assert.equal(report.server.requestAudit.mutatingRequestCount, 0);
    assert.equal(report.continuation.mode, "fresh_only");
    assert.equal("bin" in report.cli, false);
    assert.equal("models" in report.cli.modelCatalog, false);
    assert.equal("connected" in report.server.provider, false);
    assert.equal("agents" in report.server, false);
    assert.equal("availableAgents" in report.profile, false);
    const serialized = JSON.stringify(report);
    // The minimal-disclosure invariant forbids the operator's binary *path* in
    // the report. The bare default name "opencode" is a legitimate substring of
    // route identifiers, so only path-shaped candidates are leak evidence; the
    // resolved PATH location keeps the guard non-vacuous when bin is bare.
    const leakSensitivePaths = [bin, resolveDiscoverableOpencodePath()].filter(
      (value) => typeof value === "string" && value.includes("/"),
    );
    assert.notEqual(leakSensitivePaths.length, 0);
    for (const binPath of leakSensitivePaths) {
      assert.equal(serialized.includes(binPath), false);
    }
  });
});
