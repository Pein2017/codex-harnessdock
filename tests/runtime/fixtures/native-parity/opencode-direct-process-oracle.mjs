/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Direct process control for the native-parity fixture. This module is
 * deliberately Node-builtins-only: it never imports HarnessDock runtime code
 * or reuses the manager's ownership, identity, or lifecycle projections.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

async function health(url) {
  try {
    const response = await fetch(`${url}/global/health`);
    const body = await response.json();
    return { reachable: true, healthy: response.status === 200 && body?.healthy === true && body?.version === "1.18.25" };
  } catch {
    return { reachable: false, healthy: false };
  }
}

async function waitForHealthy(child, url) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await health(url);
    if (result.healthy) return;
    if (result.reachable || child.exitCode != null || !processAlive(child.pid)) {
      throw new Error("direct test-owned OpenCode process did not become healthy");
    }
    await delay(10);
  }
  throw new Error("direct test-owned OpenCode process health timed out");
}

async function stopExactChild(child) {
  if (!processAlive(child.pid)) return "no_survivor";
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(2_000).then(() => { throw new Error("direct test-owned OpenCode process did not exit"); }),
  ]);
  if (processAlive(child.pid)) throw new Error("direct test-owned OpenCode process survived SIGTERM");
  return "no_survivor";
}

function directEnvironment({ baseEnv, executable, url, record, configuration, healthState, permission }) {
  return {
    ...baseEnv,
    OPENCODE_EXECUTABLE: executable,
    OPENCODE_SERVER_URL: url,
    OPENCODE_PERMISSION: permission,
    OPENCODE_NATIVE_PARITY_CONFIG: configuration,
    OPENCODE_NATIVE_PARITY_RECORD: record,
    ...(healthState == null ? {} : { OPENCODE_NATIVE_PARITY_HEALTH: healthState }),
  };
}

function directNativeObservation(record, executable) {
  return {
    executable,
    argv: record.argv.map((argument) => /^\d+$/.test(argument) ? "{ephemeral-port}" : argument),
    environment: { permissionDigest: record.permissionDigest },
    configurationDigest: record.configurationDigest,
    health: "healthy",
    reuse: "same_process",
    cleanup: "no_survivor",
  };
}

/** Manually spawn, health-check, reuse-check, and stop one exact fake Server. */
export async function runDirectOpencodeProcessOracle({ executable, root, configuration, baseEnv = process.env, healthState = null, permission = '{"*":"allow","doom_loop":"allow"}', args = null }) {
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const recordFile = new URL("direct-process.json", `file://${root}/`).pathname;
  const childArgs = args == null ? ["serve", "--hostname", "127.0.0.1", "--port", String(port)] : args(port);
  const child = spawn(executable, childArgs, {
    detached: true,
    env: directEnvironment({ baseEnv, executable, url, record: recordFile, configuration, healthState, permission }),
    stdio: "ignore",
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error("direct test-owned OpenCode process lacks a PID");
  try {
    await waitForHealthy(child, url);
    const second = await health(url);
    if (!second.healthy || !processAlive(child.pid)) throw new Error("direct health reuse did not retain the spawned process");
    const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
    if (record.pid !== child.pid) throw new Error("direct process witness did not bind the spawned PID");
    return directNativeObservation(record, executable);
  } finally {
    await stopExactChild(child);
  }
}
