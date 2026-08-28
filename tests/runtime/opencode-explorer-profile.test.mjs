/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * This historical filename now guards the replacement contract: native
 * OpenCode configuration is Server-owned and route discovery is `/provider`
 * only. No profile or agent selector remains a HarnessDock input.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  createOpencodeDiscoveryClient,
  discoverOpencodeProviderRoutes,
} from "../../runtime/opencode-client.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function start(provider) {
  const server = createFakeOpencodeServer({ provider });
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

describe("OpenCode native route discovery", () => {
  it("projects only connected exact provider variants and does not read a profile or config", async () => {
    const { server, url } = await start({
      status: 200,
      body: {
        all: [{ id: "openai", models: {
          "gpt-5.6": { id: "gpt-5.6", providerID: "openai", variants: { low: {}, high: {} } },
        } }],
        connected: ["openai"],
        default: { openai: "gpt-5.6" },
      },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProviderRoutes(handle);

    assert.deepEqual(result, { ok: true, routes: [{ model: "openai/gpt-5.6", efforts: ["high", "low"] }] });
    assert.deepEqual(server.requests.map((request) => `${request.method} ${request.path}`), ["GET /provider"]);
  });

  it("refuses a catalog without an explicit advertised variant instead of using its native default", async () => {
    const { url } = await start({
      status: 200,
      body: { all: [{ id: "openai", models: { "gpt-5.6": { id: "gpt-5.6", providerID: "openai" } } }], connected: ["openai"], default: { openai: "gpt-5.6" } },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const result = await discoverOpencodeProviderRoutes(handle);
    assert.deepEqual(result, { ok: false, code: "malformed_response", retryable: false });
  });
});
