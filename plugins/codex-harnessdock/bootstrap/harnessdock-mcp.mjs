#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Descriptor-only MCP bootstrap. The installed snapshot validates and starts
 * the one checkout-owned MCP runtime while preserving stdio protocol framing.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { assertCheckoutDependencies } from "./dependency-preflight.mjs";

const FIXED_RUNTIME_CHECKOUT = "/data/CoordExp/codex-harnessdock";

function existing(candidate) {
  try {
    return fs.statSync(candidate).isFile() ? path.resolve(candidate) : null;
  } catch {
    return null;
  }
}

function parseEnv(filePath) {
  const values = {};
  for (const [index, rawLine] of fs.readFileSync(filePath, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid env syntax at ${filePath}:${index + 1}.`);
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function resolveCheckout() {
  let checkout;
  try {
    checkout = fs.realpathSync.native(FIXED_RUNTIME_CHECKOUT);
  } catch {
    throw new Error(`Fixed HarnessDock runtime checkout is unavailable: ${FIXED_RUNTIME_CHECKOUT}`);
  }
  const server = path.join(checkout, "runtime", "mcp-server.mjs");
  const envFile = existing(path.join(checkout, "config", "runtime.env"));
  const manifest = path.join(
    checkout,
    "plugins",
    "codex-harnessdock",
    ".codex-plugin",
    "plugin.json"
  );
  const packageJson = path.join(checkout, "package.json");
  if (!existing(server) || !envFile || !existing(manifest) || !existing(packageJson)) {
    throw new Error(`Fixed HarnessDock MCP checkout is invalid: ${checkout}`);
  }
  const plugin = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (plugin.name !== "codex-harnessdock" || plugin.mcpServers !== "./.mcp.json") {
    throw new Error(`Unexpected HarnessDock MCP Plugin identity at ${checkout}.`);
  }
  return { checkout, server, envFile };
}

async function main() {
  const { checkout, server, envFile } = resolveCheckout();
  assertCheckoutDependencies(checkout);
  const configured = parseEnv(envFile);
  delete configured.CODEX_THREAD_ID;
  delete configured.CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID;
  const env = {
    ...process.env,
    ...configured,
    CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: checkout,
    CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFile,
    CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: checkout,
  };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID;

  process.chdir(checkout);
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID;
  Object.assign(process.env, env);
  const { runCcMcpServer } = await import(pathToFileURL(server).href);
  await runCcMcpServer();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
