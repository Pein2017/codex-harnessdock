/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 2 of add-opencode-explorer-driver: fixed-origin auth-safe client
 * construction and side-effect-free discovery. Zero model/session/prompt
 * requests are made anywhere in this suite; the fake Server implements no
 * session/message/prompt route at all.
 *
 * Correction round 1: a lead review reproduced a real cross-origin/auth-leak
 * escape through the low-level SDK client that Task 2 v1 returned directly,
 * plus post-hoc-only mutation detection, an unbounded response size, a
 * credential-presence leak, an unbounded/bypassable timeout, and a
 * DNS-resolvable "localhost" loopback admission. This file's tests target
 * the corrected, hardened contract; see task-2-report.md for the original v1
 * evidence and the correction RED/GREEN evidence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_OPENCODE_SERVER_URL,
  OPENCODE_DEADLINES_MS,
  OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES,
  OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES,
  OPENCODE_MAX_RESPONSE_BYTES,
  OPENCODE_MAX_SESSION_RESPONSE_BYTES,
  OPENCODE_MAX_TURN_RESPONSE_BYTES,
  OPENCODE_PROVIDER_CATALOG_PATH,
  OpencodeClientError,
  boundPositiveInteger,
  createFixedOriginFetch,
  createOpencodeDiscoveryClient,
  createOpencodeSession,
  discoverOpencodeCapabilities,
  discoverOpencodeDefaultAgent,
  discoverOpencodeHealth,
  discoverOpencodeProfile,
  discoverOpencodeProviderCatalog,
  discoverOpencodeProviderRoutes,
  getOpencodeDiscoveryAudit,
  isLoopbackOpencodeUrl,
  createOpencodeTurnClient,
  isAdmittedOpencodeTurnRequest,
  resolveOpencodeResponseCeiling,
  resolveOpencodeServerUrl,
  resolveOpencodeTurnResponseCeiling,
  runOpencodeSideEffectFreeDiscovery,
  submitOpencodePrompt,
  summarizeRequestAudit,
} from "../../runtime/opencode-client.mjs";
import { OPENCODE_MAX_RAW_FINAL_TEXT_CHARS } from "../../runtime/opencode-result.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";
import { withOneTransportRetry } from "./fixtures/bounded-transport-retry.mjs";

const PROVIDER_ID = "opencode-go";
const MODEL_ID = "deepseek-v4-flash";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    await cleanup();
  }
});

function fixtureCodexHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-client-"));
  cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  // An empty tracked file so resolution stops here instead of falling through
  // to the repository's own config/runtime.env default OPENCODE_SERVER_URL.
  fs.writeFileSync(path.join(codexHome, ".env"), "");
  return { root, codexHome };
}

async function startServer(scenario) {
  const server = createFakeOpencodeServer(scenario);
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

function baseEnv(codexHome, extra = {}) {
  return { CODEX_HOME: codexHome, ...extra };
}

describe("opencode-client: fixed loopback URL validation", () => {
  it("accepts only literal-IP loopback http(s) origins with no credentials/query/fragment/path", () => {
    assert.equal(isLoopbackOpencodeUrl("http://127.0.0.1:4096"), true);
    assert.equal(isLoopbackOpencodeUrl("https://127.0.0.1:4096"), true);
    assert.equal(isLoopbackOpencodeUrl("http://[::1]:4096"), true);
    assert.equal(isLoopbackOpencodeUrl("http://127.0.0.1:4096/"), true);
  });

  it("rejects the DNS-resolvable hostname 'localhost' to avoid a DNS/TOCTOU loopback escape", () => {
    // "localhost" requires a resolver step (which may be misconfigured, e.g.
    // via /etc/hosts) between validation and connection; only a literal IP
    // loopback address proves the destination without that gap.
    assert.equal(isLoopbackOpencodeUrl("http://localhost:4096"), false);
  });

  it("rejects embedded credentials", () => {
    assert.equal(isLoopbackOpencodeUrl("http://user:pass@127.0.0.1:4096"), false);
  });

  it("rejects remote/non-loopback hosts", () => {
    assert.equal(isLoopbackOpencodeUrl("http://example.com:4096"), false);
    assert.equal(isLoopbackOpencodeUrl("http://10.0.0.5:4096"), false);
  });

  it("rejects a query string or fragment", () => {
    assert.equal(isLoopbackOpencodeUrl("http://127.0.0.1:4096/?x=1"), false);
    assert.equal(isLoopbackOpencodeUrl("http://127.0.0.1:4096#frag"), false);
  });

  it("rejects a non-root path", () => {
    assert.equal(isLoopbackOpencodeUrl("http://127.0.0.1:4096/session"), false);
  });

  it("rejects an unsupported scheme", () => {
    assert.equal(isLoopbackOpencodeUrl("ftp://127.0.0.1:4096"), false);
    assert.equal(isLoopbackOpencodeUrl("ws://127.0.0.1:4096"), false);
    assert.equal(isLoopbackOpencodeUrl("file:///etc/passwd"), false);
  });

  it("rejects unparsable input", () => {
    assert.equal(isLoopbackOpencodeUrl("not a url"), false);
  });

  it("resolveOpencodeServerUrl defaults to the tracked loopback origin and normalizes trailing slash", () => {
    assert.equal(resolveOpencodeServerUrl({}), DEFAULT_OPENCODE_SERVER_URL);
    assert.equal(resolveOpencodeServerUrl({ OPENCODE_SERVER_URL: "http://127.0.0.1:4096/" }), "http://127.0.0.1:4096");
  });

  it("resolveOpencodeServerUrl throws a closed error for a rejected configured URL", () => {
    assert.throws(
      () => resolveOpencodeServerUrl({ OPENCODE_SERVER_URL: "http://example.com:4096" }),
      (error) => error instanceof OpencodeClientError && error.code === "invalid_server_url"
    );
  });
});

describe("opencode-client: the discovery client is an opaque handle (no low-level escape surface)", () => {
  it("exposes only serverUrl; no .client, .hasCredentials, or requestAudit records", () => {
    const { root, codexHome } = fixtureCodexHome();
    const handle = createOpencodeDiscoveryClient({
      cwd: root,
      env: baseEnv(codexHome, { OPENCODE_SERVER_URL: DEFAULT_OPENCODE_SERVER_URL }),
    });
    assert.equal(handle.serverUrl, DEFAULT_OPENCODE_SERVER_URL);
    assert.deepEqual(Object.keys(handle), ["serverUrl"]);
    assert.equal("client" in handle, false);
    assert.equal("hasCredentials" in handle, false);
    assert.equal("requestAudit" in handle, false);
    assert.ok(Object.isFrozen(handle));
  });

  it("rejects an incomplete credential pair before any request", () => {
    const { root, codexHome } = fixtureCodexHome();
    assert.throws(
      () =>
        createOpencodeDiscoveryClient({
          cwd: root,
          env: baseEnv(codexHome, {
            OPENCODE_SERVER_URL: DEFAULT_OPENCODE_SERVER_URL,
            OPENCODE_SERVER_USERNAME: "admin",
          }),
        }),
      (error) => error instanceof OpencodeClientError && error.code === "credentials_incomplete"
    );
  });

  it("never leaks composed Basic-auth credentials through the serialized handle", () => {
    const { root, codexHome } = fixtureCodexHome();
    const handle = createOpencodeDiscoveryClient({
      cwd: root,
      env: baseEnv(codexHome, {
        OPENCODE_SERVER_URL: DEFAULT_OPENCODE_SERVER_URL,
        OPENCODE_SERVER_USERNAME: "admin",
        OPENCODE_SERVER_PASSWORD: "hunter2",
      }),
    });
    const serialized = JSON.stringify(handle);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("admin"), false);
    assert.equal(serialized.includes("Basic"), false);
  });

  it("reproduces and blocks the reported low-level per-call baseUrl/fetch escape (client.client.get({url, baseUrl: originB})), leaking no auth to origin B", async () => {
    const { url: urlA } = await startServer({ auth: { username: "admin", password: "hunter2" } });
    const { url: urlB, server: serverB } = await startServer({});
    const { root, codexHome } = fixtureCodexHome();
    const handle = createOpencodeDiscoveryClient({
      cwd: root,
      env: baseEnv(codexHome, {
        OPENCODE_SERVER_URL: urlA,
        OPENCODE_SERVER_USERNAME: "admin",
        OPENCODE_SERVER_PASSWORD: "hunter2",
      }),
    });
    let escapedOk = false;
    try {
      // The exact reported v1 escape path; must be structurally unreachable.
      const escaped = await handle.client.client.get({ url: "/global/health", baseUrl: urlB });
      escapedOk = escaped?.error === undefined;
    } catch {
      escapedOk = false;
    }
    assert.equal(escapedOk, false);
    assert.equal(serverB.requests.length, 0);
    assert.equal(serverB.requests.some((request) => request.hasAuthorizationHeader), false);
  });
});

describe("opencode-client: fixed-origin fetch seam (direct controlled wrapper tests)", () => {
  it("rejects a cross-origin request before any network call reaches it", async () => {
    const { url: urlA } = await startServer({});
    const { url: urlB, server: serverB } = await startServer({});
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({
      baseOrigin: new URL(urlA).origin,
      maxResponseBytes: OPENCODE_MAX_RESPONSE_BYTES,
      auditRecords,
    });
    await assert.rejects(
      () => wrapped(new Request(`${urlB}/global/health`)),
      (error) => error instanceof OpencodeClientError && error.code === "cross_origin_rejected"
    );
    assert.equal(serverB.requests.length, 0);
    assert.equal(auditRecords.length, 0);
  });

  it("blocks a non-GET request before any network call reaches it", async () => {
    const { url, server } = await startServer({});
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({
      baseOrigin: new URL(url).origin,
      maxResponseBytes: OPENCODE_MAX_RESPONSE_BYTES,
      auditRecords,
    });
    await assert.rejects(
      () => wrapped(new Request(`${url}/agent`, { method: "POST" })),
      (error) => error instanceof OpencodeClientError && error.code === "mutating_request_blocked"
    );
    assert.equal(server.requests.length, 0);
    assert.equal(auditRecords.length, 0);
  });

  it("forces redirect rejection regardless of the incoming Request's own redirect mode", async () => {
    const { url } = await startServer({ redirectPaths: { "/global/health": "/global/health-v2" } });
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({
      baseOrigin: new URL(url).origin,
      maxResponseBytes: OPENCODE_MAX_RESPONSE_BYTES,
      auditRecords,
    });
    await assert.rejects(() => wrapped(new Request(`${url}/global/health`, { redirect: "follow" })));
  });

  it("records only bounded method/path in the audit, never a query string or fragment", async () => {
    const { url } = await startServer({});
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({
      baseOrigin: new URL(url).origin,
      maxResponseBytes: OPENCODE_MAX_RESPONSE_BYTES,
      auditRecords,
    });
    await wrapped(new Request(`${url}/global/health?x=1`));
    assert.deepEqual(auditRecords, [{ method: "GET", path: "/global/health" }]);
  });

  it("enforces a declared-Content-Length bound without reading the oversized body", async () => {
    const { url, server } = await startServer({ oversizedDeclaredLengthPaths: ["/global/health"] });
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({ baseOrigin: new URL(url).origin, maxResponseBytes: 1024, auditRecords });
    await assert.rejects(
      () => wrapped(new Request(`${url}/global/health`)),
      (error) => error instanceof OpencodeClientError && error.code === "response_too_large"
    );
    assert.equal(server.requests.length, 1);
  });

  it("enforces a streaming/chunked response bound without buffering the full oversized body", async () => {
    const { url } = await startServer({ oversizedStreamingPaths: { "/global/health": 5_000_000 } });
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({ baseOrigin: new URL(url).origin, maxResponseBytes: 1024, auditRecords });
    const start = Date.now();
    const response = await wrapped(new Request(`${url}/global/health`));
    await assert.rejects(
      () => response.text(),
      (error) => error instanceof OpencodeClientError && error.code === "response_too_large"
    );
    assert.ok(Date.now() - start < 2000, "must reject promptly, not after draining 5MB");
  });
});

/**
 * The provider-catalog endpoint legitimately carries the hydrated models.dev
 * registry: the operator's own Server answers `GET /provider` with 188
 * providers, a `Content-Length` of ~308 KB compressed and ~5.0 MB decoded. The
 * 256 KiB discovery bound rejected that response outright, so the model route
 * could never be confirmed. These tests pin the correction: one separate frozen
 * ceiling for exactly that path, decided before the network call, enforced at
 * both the declared-length and streamed level, and with the global bound
 * unchanged for every other path.
 */
describe("opencode-client: provider-catalog response ceiling", () => {
  /** A valid, realistically large catalog: many providers, each with many models. */
  function paddedCatalogBody({ providerCount = 200, modelsPerProvider = 24 } = {}) {
    const all = [
      {
        id: PROVIDER_ID,
        name: "OpenCode Go",
        models: {
          [MODEL_ID]: {
            id: MODEL_ID,
            providerID: PROVIDER_ID,
            name: "DeepSeek V4 Flash (2x usage)",
            family: "deepseek-flash",
          },
        },
      },
    ];
    for (let providerIndex = 0; providerIndex < providerCount; providerIndex += 1) {
      const models = {};
      for (let modelIndex = 0; modelIndex < modelsPerProvider; modelIndex += 1) {
        const id = `synthetic-model-${providerIndex}-${modelIndex}-with-a-realistically-long-identifier`;
        models[id] = {
          id,
          providerID: `synthetic-provider-${providerIndex}`,
          name: `Synthetic Model ${providerIndex}/${modelIndex} for response-size padding only`,
          family: "synthetic-family-for-padding",
          release_date: "2026-01-01",
          cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
        };
      }
      all.push({ id: `synthetic-provider-${providerIndex}`, name: `Synthetic Provider ${providerIndex}`, models });
    }
    return { all, connected: [PROVIDER_ID], default: {} };
  }

  it("declares one separate frozen ceiling for exactly the catalog path", () => {
    assert.equal(OPENCODE_PROVIDER_CATALOG_PATH, "/provider");
    assert.equal(OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES, 8_388_608);
    assert.ok(OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES > OPENCODE_MAX_RESPONSE_BYTES);
    assert.equal(resolveOpencodeResponseCeiling("/provider"), OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES);
    for (const pathname of [
      "/global/health",
      "/agent",
      "/experimental/capabilities",
      "/api/provider",
      "/provider/auth",
      "/providers",
      "/provider2",
      "/provider/",
    ]) {
      assert.equal(resolveOpencodeResponseCeiling(pathname), OPENCODE_MAX_RESPONSE_BYTES, pathname);
    }
  });

  it("admits a catalog larger than the global bound and projects only the target facts", async () => {
    const body = paddedCatalogBody();
    const encodedBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    assert.ok(encodedBytes > OPENCODE_MAX_RESPONSE_BYTES, `catalog must exceed the global bound: ${encodedBytes}`);
    assert.ok(encodedBytes < OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES);
    const { url } = await startServer({ provider: { status: 200, body } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProviderCatalog(handle, { providerId: PROVIDER_ID, modelId: MODEL_ID });
    assert.deepEqual(result, {
      ok: true,
      providerPresent: true,
      providerConnected: true,
      model: {
        id: MODEL_ID,
        providerID: PROVIDER_ID,
        name: "DeepSeek V4 Flash (2x usage)",
        family: "deepseek-flash",
      },
    });
    // The projection stays closed: no other provider or model reaches the caller.
    assert.equal(JSON.stringify(result).includes("synthetic"), false);
  });

  it("bounds catalog entries by their own ceiling instead of the shared array bound", async () => {
    // A registry grown past the shared 256-entry array bound still reads
    // cleanly: the live registry already sits at 188 providers.
    const grown = paddedCatalogBody({ providerCount: 300, modelsPerProvider: 2 });
    const grownServer = await startServer({ provider: { status: 200, body: grown } });
    const grownHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: grownServer.url } });
    const grownResult = await discoverOpencodeProviderCatalog(grownHandle, {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    assert.equal(grownResult.ok, true);
    assert.equal(grownResult.providerPresent, true);
    assert.equal(grownResult.providerConnected, true);
    // One entry past the catalog's own ceiling still fails closed.
    const past = paddedCatalogBody({
      providerCount: OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES,
      modelsPerProvider: 0,
    });
    assert.equal(past.all.length, OPENCODE_MAX_PROVIDER_CATALOG_ENTRIES + 1);
    const pastServer = await startServer({ provider: { status: 200, body: past } });
    const pastHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: pastServer.url } });
    assert.deepEqual(await discoverOpencodeProviderCatalog(pastHandle, { providerId: PROVIDER_ID, modelId: MODEL_ID }), {
      ok: false,
      code: "malformed_response",
      retryable: false,
    });
  });

  it("still rejects a catalog beyond the catalog ceiling, by declared length and by streamed bytes", async () => {
    const declared = await startServer({ oversizedDeclaredLengthPaths: [OPENCODE_PROVIDER_CATALOG_PATH] });
    const declaredHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: declared.url } });
    assert.deepEqual(
      await discoverOpencodeProviderCatalog(declaredHandle, { providerId: PROVIDER_ID, modelId: MODEL_ID }),
      { ok: false, code: "response_too_large", retryable: false }
    );
    const streamed = await startServer({
      oversizedStreamingPaths: { [OPENCODE_PROVIDER_CATALOG_PATH]: OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES + 65_536 },
    });
    const streamedHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: streamed.url } });
    assert.deepEqual(
      await discoverOpencodeProviderCatalog(streamedHandle, { providerId: PROVIDER_ID, modelId: MODEL_ID }),
      { ok: false, code: "response_too_large", retryable: false }
    );
  });

  it("keeps the global bound in force for every non-catalog discovery response", async () => {
    const overGlobalBytes = OPENCODE_MAX_RESPONSE_BYTES + 65_536;
    const agents = await startServer({ oversizedStreamingPaths: { "/agent": overGlobalBytes } });
    const agentsHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: agents.url } });
    assert.deepEqual(await discoverOpencodeProfile(agentsHandle), {
      ok: false,
      code: "response_too_large",
      retryable: false,
    });
    const health = await startServer({ oversizedStreamingPaths: { "/global/health": overGlobalBytes } });
    const healthHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: health.url } });
    assert.deepEqual(await discoverOpencodeHealth(healthHandle), {
      ok: false,
      code: "response_too_large",
      retryable: false,
    });
    const capabilities = await startServer({
      oversizedStreamingPaths: { "/experimental/capabilities": overGlobalBytes },
    });
    const capabilitiesHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: capabilities.url } });
    assert.deepEqual(await discoverOpencodeCapabilities(capabilitiesHandle), {
      ok: false,
      code: "response_too_large",
      retryable: false,
    });
  });

  it("lets a caller shorten either ceiling but never widen one", async () => {
    assert.equal(boundPositiveInteger(16 * 1024 * 1024, OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES), OPENCODE_MAX_PROVIDER_CATALOG_RESPONSE_BYTES);
    const { url } = await startServer({ provider: { status: 200, body: paddedCatalogBody() } });
    const shortened = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url }, maxResponseBytes: 4096 });
    assert.deepEqual(await discoverOpencodeProviderCatalog(shortened, { providerId: PROVIDER_ID, modelId: MODEL_ID }), {
      ok: false,
      code: "response_too_large",
      retryable: false,
    });
  });

  it("projects only spawnable bounded route atoms from a hostile catalog", async () => {
    const hugeVariants = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`effort-${index}-${"x".repeat(240)}`, {}]),
    );
    const body = {
      all: [
        {
          id: "safe-provider",
          models: {
            "safe-model": { id: "safe-model", providerID: "safe-provider", variants: { high: {} } },
          },
        },
        {
          id: "bad/provider",
          models: { model: { id: "model", providerID: "bad/provider", variants: { high: {} } } },
        },
        {
          id: "control-provider\u0007",
          models: { model: { id: "model", providerID: "control-provider\u0007", variants: { high: {} } } },
        },
        {
          id: "bad-model-provider",
          models: { "bad/model": { id: "bad/model", providerID: "bad-model-provider", variants: { high: {} } } },
        },
        {
          id: "bad-variant-provider",
          models: { model: { id: "model", providerID: "bad-variant-provider", variants: { "high/hidden": {} } } },
        },
        {
          id: "aggregate-provider",
          models: { model: { id: "model", providerID: "aggregate-provider", variants: hugeVariants } },
        },
      ],
      connected: [
        "safe-provider", "bad/provider", "control-provider\u0007", "bad-model-provider",
        "bad-variant-provider", "aggregate-provider",
      ],
      default: {},
    };
    const { url } = await startServer({ provider: { status: 200, body } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    assert.deepEqual(await discoverOpencodeProviderRoutes(handle), {
      ok: true,
      routes: [{ model: "safe-provider/safe-model", efforts: ["high"] }],
    });
  });
});

describe("opencode-client: bounded interaction witness", () => {
  it("projects only the default Agent from GET /config", async () => {
    const { url, server } = await startServer({
      config: { status: 200, body: { default_agent: "build", secret: "must-not-leave-client" } },
    });
    const result = await discoverOpencodeDefaultAgent(
      createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } })
    );
    assert.deepEqual(result, { ok: true, defaultAgent: "build" });
    assert.deepEqual(server.requests.map(({ method, path }) => ({ method, path })), [{ method: "GET", path: "/config" }]);
  });
});

/**
 * Task 5 gives session creation and the blocking prompt their own client. The
 * point of a second client rather than a widened first one is that the discovery
 * handle stays incapable of creating anything, and that the turn handle admits
 * exactly two POST paths -- every other method and path the pinned SDK could
 * ever be asked for is refused before the network.
 */
describe("opencode-client: turn-scoped admission gate", () => {
  it("creates sessions with the exact maximum-permission zero-wait rules", async () => {
    const { url, server } = await startServer({});
    const handle = createOpencodeTurnClient({ env: { OPENCODE_SERVER_URL: url } });

    const result = await createOpencodeSession(handle, {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      variant: "low",
      directory: "/opt/operator-owned/workspace",
    });

    assert.deepEqual(result, { ok: true, sessionId: "ses_fake_1" });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].path, "/session");
    assert.deepEqual(server.requests[0].body, {
      model: { id: MODEL_ID, providerID: PROVIDER_ID, variant: "low" },
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "deny" },
        { permission: "plan_exit", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ],
    });
    assert.equal(Object.hasOwn(server.requests[0].body, "agent"), false);
  });

  it("admits exactly the two pinned mutating requests", () => {
    assert.equal(isAdmittedOpencodeTurnRequest("POST", "/session"), true);
    assert.equal(isAdmittedOpencodeTurnRequest("POST", "/session/ses_abc/message"), true);
    for (const [method, pathname] of [
      ["POST", "/session/ses_abc/abort"],
      ["POST", "/session/ses_abc/prompt_async"],
      ["POST", "/session/ses_abc/fork"],
      ["POST", "/session/ses_abc/share"],
      ["POST", "/session/ses_abc/summarize"],
      ["POST", "/session/ses_abc/command"],
      ["POST", "/session/ses_abc/shell"],
      ["POST", "/session/ses_abc/revert"],
      ["POST", "/session/ses_abc/init"],
      ["POST", "/session/ses_abc/message/msg_1"],
      ["POST", "/session/ses_abc/permissions/per_1"],
      ["POST", "/sessions"],
      ["POST", "/session/message"],
      ["POST", "/session/ses_abc/../abort"],
      ["POST", "/api/provider"],
      ["GET", "/session"],
      ["GET", "/session/ses_abc/message"],
      ["DELETE", "/session/ses_abc"],
      ["PATCH", "/session/ses_abc"],
      ["PUT", "/session/ses_abc/message"],
    ]) {
      assert.equal(isAdmittedOpencodeTurnRequest(method, pathname), false, `${method} ${pathname}`);
    }
  });

  it("blocks a non-admitted turn request before any network call reaches it", async () => {
    const { url, server } = await startServer({});
    const auditRecords = [];
    const wrapped = createFixedOriginFetch({
      baseOrigin: new URL(url).origin,
      maxResponseBytes: null,
      auditRecords,
      admitRequest: (method, pathname) => {
        if (!isAdmittedOpencodeTurnRequest(method, pathname)) {
          throw new OpencodeClientError("request_not_admitted", "blocked before network");
        }
      },
      ceilingForPath: resolveOpencodeTurnResponseCeiling,
    });
    for (const [method, path] of [
      ["POST", "/session/ses_abc/abort"],
      ["POST", "/session/ses_abc/prompt_async"],
      ["GET", "/session"],
      ["DELETE", "/session/ses_abc"],
    ]) {
      await assert.rejects(
        () => wrapped(new Request(`${url}${path}`, { method })),
        (error) => error instanceof OpencodeClientError && error.code === "request_not_admitted",
        `${method} ${path}`
      );
    }
    assert.deepEqual(server.requests, [], "nothing reached the Server");
    assert.deepEqual(auditRecords, [], "a blocked request is never audited as dispatched");
  });

  it("derives the prompt ceiling from the admitted raw final-text bound", () => {
    assert.equal(resolveOpencodeTurnResponseCeiling("/session"), OPENCODE_MAX_SESSION_RESPONSE_BYTES);
    assert.equal(resolveOpencodeTurnResponseCeiling("/session/ses_abc/message"), OPENCODE_MAX_TURN_RESPONSE_BYTES);
    // 262,144 admitted characters at up to 4 UTF-8 bytes each is 1 MiB, ~1.5 MiB
    // once JSON-escaped in the worst case; the ceiling keeps that plus the rest
    // of a multi-step assistant message inside one frozen bound.
    assert.equal(OPENCODE_MAX_TURN_RESPONSE_BYTES, 4 * 1024 * 1024);
    assert.ok(OPENCODE_MAX_TURN_RESPONSE_BYTES >= OPENCODE_MAX_RAW_FINAL_TEXT_CHARS * 4);
    assert.ok(OPENCODE_MAX_SESSION_RESPONSE_BYTES < OPENCODE_MAX_TURN_RESPONSE_BYTES);
  });

  it("refuses an unusable prompt target synchronously, before dispatch", async () => {
    const { url, server } = await startServer({});
    const handle = createOpencodeTurnClient({ env: { OPENCODE_SERVER_URL: url } });
    for (const overrides of [
      { sessionId: "ses/../escape" },
      { sessionId: "" },
      { messageId: "not-a-msg-id" },
      { messageId: "" },
      { text: "" },
      { agent: "" },
    ]) {
      assert.throws(
        () =>
          submitOpencodePrompt(handle, {
            sessionId: "ses_abc",
            messageId: "msg_abc",
            agent: "codex-explorer",
            providerId: PROVIDER_ID,
            modelId: MODEL_ID,
            text: "prompt",
            ...overrides,
          }),
        (error) => error instanceof OpencodeClientError,
        JSON.stringify(overrides)
      );
    }
    assert.deepEqual(server.requests, []);
  });

  it("never exposes the pinned client or a per-call origin override on a turn handle", async () => {
    const { url } = await startServer({});
    const handle = createOpencodeTurnClient({ env: { OPENCODE_SERVER_URL: url } });
    assert.deepEqual(Object.keys(handle), ["serverUrl"]);
    assert.equal("client" in handle, false);
    assert.equal(Object.isFrozen(handle), true);
  });
});

describe("opencode-client: side-effect-free discovery against a fake Server", () => {
  it("reports health when the Server is ready", async () => {
    const { url } = await startServer({});
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.deepEqual(result, { ok: true, healthy: true, version: "1.18.18" });
  });

  it("returns a sanitized auth_failed classification when Basic auth is missing", async () => {
    const { url } = await startServer({ auth: { username: "admin", password: "hunter2" } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, false);
    assert.equal(result.code, "auth_failed");
    assert.equal(result.retryable, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("admin"), false);
    assert.equal(serialized.includes("Authorization"), false);
  });

  it("succeeds with matching inherited Basic auth credentials", async () => {
    const { url } = await startServer({ auth: { username: "admin", password: "hunter2" } });
    const { root, codexHome } = fixtureCodexHome();
    const handle = createOpencodeDiscoveryClient({
      cwd: root,
      env: baseEnv(codexHome, {
        OPENCODE_SERVER_URL: url,
        OPENCODE_SERVER_USERNAME: "admin",
        OPENCODE_SERVER_PASSWORD: "hunter2",
      }),
    });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, true);
  });

  it("reports the target provider/model catalog match without the full connected list", async () => {
    const { url } = await startServer({
      provider: {
        status: 200,
        body: {
          connected: ["opencode-go", "anthropic"],
          default: {},
          all: [
            {
              id: PROVIDER_ID,
              models: {
                [MODEL_ID]: { id: MODEL_ID, providerID: PROVIDER_ID, name: "DeepSeek V4 Flash", family: "deepseek-flash" },
              },
            },
          ],
        },
      },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProviderCatalog(handle, { providerId: PROVIDER_ID, modelId: MODEL_ID });
    assert.deepEqual(result, {
      ok: true,
      providerPresent: true,
      providerConnected: true,
      model: { id: MODEL_ID, providerID: PROVIDER_ID, name: "DeepSeek V4 Flash", family: "deepseek-flash" },
    });
  });

  it("reports catalog absence truthfully when the target model is not present", async () => {
    const { url } = await startServer({ provider: { status: 200, body: { connected: [], default: {}, all: [] } } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProviderCatalog(handle, { providerId: PROVIDER_ID, modelId: MODEL_ID });
    assert.deepEqual(result, { ok: true, providerPresent: false, providerConnected: false, model: null });
  });

  it("reports the codex-explorer profile presence from the sanitized agent list", async () => {
    const { url } = await startServer({
      agents: { status: 200, body: [{ name: "codex-explorer", mode: "primary", native: false }, { name: "build", mode: "primary", native: true }] },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProfile(handle);
    assert.equal(result.ok, true);
    assert.ok(result.agents.some((agent) => agent.name === "codex-explorer"));
    assert.equal(result.agents.length, 2);
  });

  it("fails closed on an oversized agents array instead of returning partial raw data", async () => {
    const agents = Array.from({ length: 300 }, (_, index) => ({ name: `agent-${index}`, mode: "primary", native: false }));
    const { url } = await startServer({ agents: { status: 200, body: agents } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await withOneTransportRetry(() => discoverOpencodeProfile(handle));
    assert.deepEqual(result, { ok: false, code: "malformed_response", retryable: false });
  });

  it("fails closed on an oversized agent field instead of truncating it", async () => {
    const { url } = await startServer({ agents: { status: 200, body: [{ name: "x".repeat(1000), mode: "primary", native: false }] } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await withOneTransportRetry(() => discoverOpencodeProfile(handle));
    assert.deepEqual(result, { ok: false, code: "malformed_response", retryable: false });
  });

  it("fails closed on an oversized provider catalog model field", async () => {
    const { url } = await startServer({
      provider: {
        status: 200,
        body: {
          connected: [PROVIDER_ID],
          default: {},
          all: [{ id: PROVIDER_ID, models: { [MODEL_ID]: { id: MODEL_ID, providerID: PROVIDER_ID, name: "n".repeat(1000), family: "f" } } }],
        },
      },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await withOneTransportRetry(
      () => discoverOpencodeProviderCatalog(handle, { providerId: PROVIDER_ID, modelId: MODEL_ID }),
    );
    assert.deepEqual(result, { ok: false, code: "malformed_response", retryable: false });
  });

  it("reports capabilities booleans only", async () => {
    const { url } = await startServer({ capabilities: { status: 200, body: { backgroundSubagents: false, someFutureField: "x" } } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeCapabilities(handle);
    assert.deepEqual(result, { ok: true, backgroundSubagents: false });
  });

  it("classifies a connection loss as a retryable network_error", async () => {
    const { server, url } = await startServer({});
    await server.close();
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, false);
    assert.equal(result.code, "network_error");
    assert.equal(result.retryable, true);
  });

  it("classifies an exceeded deadline as deadline_exceeded without waiting for the configured ceiling", async () => {
    const { url } = await startServer({ hangPaths: ["/global/health"] });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const start = Date.now();
    const result = await discoverOpencodeHealth(handle, { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.code, "deadline_exceeded");
    assert.equal(result.retryable, true);
    assert.ok(Date.now() - start < 2000);
  });

  it("classifies a malformed (invalid JSON) response as non-retryable malformed_response", async () => {
    const { url } = await startServer({ malformedPaths: ["/global/health"] });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, false);
    assert.equal(result.code, "malformed_response");
    assert.equal(result.retryable, false);
  });

  it("classifies a schema-invalid but well-formed JSON health body as malformed_response", async () => {
    const { url } = await startServer({ health: { status: 200, body: { healthy: "yes" } } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, false);
    assert.equal(result.code, "malformed_response");
  });

  it("classifies a rejected redirect as non-retryable redirect_rejected", async () => {
    const { url } = await startServer({ redirectPaths: { "/global/health": "/global/health-v2" } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, false);
    assert.equal(result.code, "redirect_rejected");
    assert.equal(result.retryable, false);
  });

  it("classifies a declared oversized response as non-retryable response_too_large", async () => {
    const { url } = await startServer({ oversizedDeclaredLengthPaths: ["/global/health"] });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url }, maxResponseBytes: 1024 });
    const result = await discoverOpencodeHealth(handle);
    assert.deepEqual(result, { ok: false, code: "response_too_large", retryable: false });
  });

  it("classifies an oversized streamed response as non-retryable response_too_large promptly", async () => {
    const { url } = await startServer({ oversizedStreamingPaths: { "/global/health": 5_000_000 } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url }, maxResponseBytes: 1024 });
    const start = Date.now();
    const result = await discoverOpencodeHealth(handle);
    assert.deepEqual(result, { ok: false, code: "response_too_large", retryable: false });
    assert.ok(Date.now() - start < 2000);
  });

  it("caller-composed abort produces aborted_by_caller and fires before the discovery ceiling", async () => {
    const { url } = await startServer({ hangPaths: ["/global/health"] });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await discoverOpencodeHealth(handle, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, "aborted_by_caller");
  });

  it("ignores an unrecognized per-call option and never diverts from the fixed origin/path", async () => {
    const { url, server } = await startServer({});
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    await discoverOpencodeHealth(handle, { endpoint: "http://127.0.0.1:1/evil" });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, "/global/health");
  });

  it("bypasses configured proxy environment variables for the fixed loopback origin", async () => {
    const { url } = await startServer({});
    const { root, codexHome } = fixtureCodexHome();
    const handle = createOpencodeDiscoveryClient({
      cwd: root,
      env: baseEnv(codexHome, { OPENCODE_SERVER_URL: url, HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1" }),
    });
    const result = await discoverOpencodeHealth(handle);
    assert.equal(result.ok, true);
  });
});

describe("opencode-client: a per-call or handle-level timeout/byte request can only shorten the Driver-owned ceiling", () => {
  it("boundPositiveInteger keeps a valid smaller request", () => {
    assert.equal(boundPositiveInteger(100, 5000), 100);
  });

  it("boundPositiveInteger clamps to the ceiling for larger/invalid/equal requests", () => {
    assert.equal(boundPositiveInteger(999_999, 5000), 5000);
    assert.equal(boundPositiveInteger(5000, 5000), 5000);
    assert.equal(boundPositiveInteger(0, 5000), 5000);
    assert.equal(boundPositiveInteger(-5, 5000), 5000);
    assert.equal(boundPositiveInteger(Infinity, 5000), 5000);
    assert.equal(boundPositiveInteger(Number.NaN, 5000), 5000);
    assert.equal(boundPositiveInteger(1.5, 5000), 5000);
    assert.equal(boundPositiveInteger(undefined, 5000), 5000);
  });

  it("a per-call timeoutMs cannot extend past the handle's own (already-bounded) connect ceiling", async () => {
    const { url } = await startServer({ hangPaths: ["/global/health"] });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url }, connectTimeoutMs: 150 });
    const start = Date.now();
    const result = await discoverOpencodeHealth(handle, { timeoutMs: 999_999 });
    assert.equal(result.code, "deadline_exceeded");
    assert.ok(Date.now() - start < 2000, "must be bounded by the 150ms handle ceiling, not 999999ms");
  });
});

describe("opencode-client: composed side-effect-free discovery proves zero mutation/session/model calls", () => {
  it("runs health + profile + provider + capabilities as GET-only requests and reports a bounded audit", async () => {
    const { url, server } = await startServer({
      provider: {
        status: 200,
        body: {
          connected: [PROVIDER_ID],
          default: {},
          all: [{ id: PROVIDER_ID, models: { [MODEL_ID]: { id: MODEL_ID, providerID: PROVIDER_ID, name: "n", family: "f" } } }],
        },
      },
    });
    const result = await runOpencodeSideEffectFreeDiscovery({
      env: { OPENCODE_SERVER_URL: url },
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(result.health.healthy, true);
    assert.equal(result.provider.providerConnected, true);
    assert.equal(result.profile.ok, true);
    assert.equal(result.capabilities.ok, true);
    assert.equal(result.requestAudit.totalRequests, 4);
    assert.equal(result.requestAudit.mutatingRequestCount, 0);
    assert.ok(result.requestAudit.methods.every((method) => method === "GET"));
    assert.equal("hasCredentials" in result, false);
    assert.equal(JSON.stringify(result).includes("hasCredentials"), false);
    assert.ok(server.requests.every((record) => record.path !== "/session" && !record.path.startsWith("/session")));
  });

  it("stops after health and never calls discovery endpoints when the Server is unhealthy", async () => {
    const { url, server } = await startServer({ health: { status: 200, body: { healthy: false, version: "1.18.18" } } });
    const result = await runOpencodeSideEffectFreeDiscovery({ env: { OPENCODE_SERVER_URL: url } });
    assert.equal(result.ok, false);
    assert.equal(result.profile, null);
    assert.equal(server.requests.length, 1);
  });

  it("getOpencodeDiscoveryAudit reports the same bounded shape after real discovery calls", async () => {
    const { url } = await startServer({});
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    await discoverOpencodeHealth(handle);
    const audit = getOpencodeDiscoveryAudit(handle);
    assert.deepEqual(audit, { totalRequests: 1, mutatingRequestCount: 0, methods: ["GET"] });
  });
});

describe("opencode-client: sanitized audit summarization", () => {
  it("summarizes a request audit as bounded counts/methods only", () => {
    const summary = summarizeRequestAudit({
      records: [
        { method: "GET", path: "/global/health" },
        { method: "GET", path: "/agent" },
      ],
    });
    assert.deepEqual(summary, { totalRequests: 2, mutatingRequestCount: 0, methods: ["GET", "GET"] });
  });
});

describe("opencode-client: deadline and response-size constants", () => {
  it("exposes closed, positive, ascending connect/discovery/acceptance/turn bounds", () => {
    assert.ok(OPENCODE_DEADLINES_MS.connect > 0);
    assert.ok(OPENCODE_DEADLINES_MS.discovery >= OPENCODE_DEADLINES_MS.connect);
    assert.ok(OPENCODE_DEADLINES_MS.acceptance >= OPENCODE_DEADLINES_MS.discovery);
    assert.ok(OPENCODE_DEADLINES_MS.turn >= OPENCODE_DEADLINES_MS.acceptance);
    assert.deepEqual(Object.keys(OPENCODE_DEADLINES_MS).sort(), ["acceptance", "connect", "discovery", "turn"]);
  });

  it("exposes a closed, positive default response byte bound", () => {
    assert.ok(Number.isInteger(OPENCODE_MAX_RESPONSE_BYTES));
    assert.ok(OPENCODE_MAX_RESPONSE_BYTES > 0);
  });
});
