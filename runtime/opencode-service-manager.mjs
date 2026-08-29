/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Private, fixed-origin OpenCode Server ownership. This is deliberately not a
 * supervisor: it owns one short ensure transaction and no public controls.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveOpencodeServerUrl, createOpencodeDiscoveryClient, discoverOpencodeHealth, discoverOpencodeProviderRoutes } from "./opencode-client.mjs";
import { recoverStaleDirectoryLock, sameFileIdentity } from "./durable-directory-lock.mjs";
import { resolveRuntimeEnvironment } from "./environment.mjs";
import { resolvePluginRuntimeRoot } from "./paths.mjs";
import { getProcessIdentity, isProcessAlive, terminateProcessTree, validateProcessIdentity } from "./process-control.mjs";

const RECEIPT_VERSION = 1;
const LOCK_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 20;

function taggedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serviceDirectory(runtimeRoot) {
  return path.join(runtimeRoot, "opencode-service");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
  }
}

function acquireLock(directory, deps) {
  const lockFile = path.join(directory, ".lock");
  const deadline = Date.now() + (deps.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
  return (async () => {
    while (true) {
      recoverStaleDirectoryLock(lockFile, {
        isProcessAlive: deps.isAlive,
        validateProcessIdentity: deps.validateIdentity,
      });
      const token = randomBytes(16).toString("hex");
      const candidate = `${lockFile}.${process.pid}.${token}.candidate`;
      let fd = null;
      try {
        fd = fs.openSync(candidate, "wx", 0o600);
        let identity = null;
        try { identity = deps.getIdentity(process.pid); } catch { /* best effort */ }
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity, token, timestamp: Date.now() }), "utf8");
        fs.fsyncSync(fd);
        const stat = fs.fstatSync(fd);
        fs.linkSync(candidate, lockFile);
        fs.unlinkSync(candidate);
        fs.closeSync(fd);
        return { lockFile, token, stat };
      } catch (error) {
        if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
        try { fs.unlinkSync(candidate); } catch { /* best effort */ }
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw taggedError("lock_timeout", "Timed out waiting for the OpenCode service ownership fence.");
        await delay(RETRY_DELAY_MS);
      }
    }
  })();
}

function releaseLock(lock) {
  try {
    const stat = fs.statSync(lock.lockFile);
    const data = JSON.parse(fs.readFileSync(lock.lockFile, "utf8"));
    if (sameFileIdentity(lock.stat, stat) && data?.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch { /* best effort */ }
}

function readReceipt(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      value?.version !== RECEIPT_VERSION ||
      !Number.isSafeInteger(value?.pid) || value.pid < 1 ||
      typeof value.identity !== "string" || !value.identity ||
      typeof value.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.commandFingerprint)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function writeReceipt(file, receipt) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

function configuredExecutable(env, executableCheck) {
  const executable = String(env?.OPENCODE_EXECUTABLE ?? "").trim();
  if (!path.isAbsolute(executable) || !executableCheck(executable)) {
    throw taggedError("executable_unavailable", "The configured OpenCode executable is unavailable.");
  }
  return executable;
}

function endpointArguments(env) {
  const origin = new URL(resolveOpencodeServerUrl(env));
  if (origin.protocol !== "http:" || !origin.port || origin.hostname !== "127.0.0.1") {
    throw taggedError("endpoint_invalid", "The configured OpenCode Server endpoint is not a fixed IPv4 loopback port.");
  }
  return ["serve", "--hostname", "127.0.0.1", "--port", origin.port];
}

async function defaultProbe(env, cwd) {
  try {
    const handle = createOpencodeDiscoveryClient({ env, cwd });
    const health = await discoverOpencodeHealth(handle);
    if (!health.ok || !health.healthy) {
      const code = "code" in health ? health.code : null;
      return { kind: ["network_error", "deadline_exceeded", "server_error"].includes(code) ? "absent" : "incompatible" };
    }
    const result = await discoverOpencodeProviderRoutes(handle);
    if (result.ok) return { kind: "healthy" };
    const code = "code" in result ? result.code : null;
    return { kind: ["network_error", "deadline_exceeded", "server_error"].includes(code) ? "absent" : "incompatible" };
  } catch {
    return { kind: "absent" };
  }
}

// A ChildProcess can emit `error` after spawn returns. Keep this tiny listener
// through its exit so that a startup race cannot escape as an uncaught event.
function observeStartedChild(child) {
  let failure = null;
  const record = (kind) => { if (failure == null) failure = kind; };
  const onError = () => record("error");
  const onExit = () => record("exit");
  const remove = () => {
    child?.removeListener?.("error", onError);
    child?.removeListener?.("exit", onExit);
    child?.removeListener?.("exit", remove);
  };
  child?.on?.("error", onError);
  child?.once?.("exit", onExit);
  child?.once?.("exit", remove);
  return { failure: () => failure };
}

/**
 * Internal-only service manager. `probe` and process hooks are fixture seams;
 * no public lifecycle or configuration selector reaches this object.
 */
export function createOpencodeServiceManager(options = {}) {
  const env = options.env ?? resolveRuntimeEnvironment({ cwd: options.cwd, envFile: options.envFile }).env;
  const runtimeRoot = path.resolve(options.runtimeRoot ?? resolvePluginRuntimeRoot());
  const deps = {
    probe: options.probe ?? ((value) => defaultProbe(value, options.cwd)),
    executableCheck: options.executableCheck ?? ((file) => {
      try { return fs.statSync(file).isFile() && fs.accessSync(file, fs.constants.X_OK) === undefined; } catch { return false; }
    }),
    start: options.start ?? ((executable, args) => nodeSpawn(executable, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: "ignore",
      shell: false,
    })),
    getIdentity: options.getIdentity ?? getProcessIdentity,
    isAlive: options.isAlive ?? isProcessAlive,
    validateIdentity: options.validateIdentity ?? validateProcessIdentity,
    terminate: options.terminate ?? ((pid, identity) => terminateProcessTree(pid, identity)),
    startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    startupDelayMs: options.startupDelayMs ?? RETRY_DELAY_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
  };
  const directory = serviceDirectory(runtimeRoot);
  const receiptFile = path.join(directory, "receipt.json");

  async function probe() {
    const result = await deps.probe(env);
    return result?.kind === "healthy" ? "healthy" : result?.kind === "incompatible" ? "incompatible" : "absent";
  }

  async function inspect() {
    if (await probe() !== "healthy") return { status: "unavailable" };
    const receipt = readReceipt(receiptFile);
    const managed = receipt && deps.isAlive(receipt.pid) && deps.validateIdentity(receipt.pid, receipt.identity);
    return { status: managed ? "managed" : "reused" };
  }

  async function ensure() {
    const initial = await probe();
    if (initial === "healthy") return { status: "reused" };
    if (initial === "incompatible") throw taggedError("endpoint_incompatible", "The fixed OpenCode endpoint is occupied by an incompatible service.");

    ensureDirectory(directory);
    const lock = await acquireLock(directory, deps);
    try {
      const settled = await probe();
      if (settled === "healthy") return { status: "reused" };
      if (settled === "incompatible") throw taggedError("endpoint_incompatible", "The fixed OpenCode endpoint is occupied by an incompatible service.");

      const stale = readReceipt(receiptFile);
      if (stale && deps.isAlive(stale.pid) && deps.validateIdentity(stale.pid, stale.identity)) {
        throw taggedError("managed_service_unhealthy", "The managed OpenCode service is still alive but cannot prove fixed-origin readiness.");
      }
      try { fs.unlinkSync(receiptFile); } catch { /* absent/corrupt/stale is intentionally discarded under the fence */ }

      const executable = configuredExecutable(env, deps.executableCheck);
      const args = endpointArguments(env);
      const child = deps.start(executable, args);
      if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
        throw taggedError("startup_failed", "The OpenCode service process did not expose an exact child identity.");
      }
      const childObservation = observeStartedChild(child);
      child.unref?.();
      let identity;
      let terminated = false;
      const terminateChild = () => {
        if (terminated) return;
        terminated = true;
        try { deps.terminate(child.pid, identity); } catch { /* exact proven child cleanup is best effort */ }
      };
      try { identity = deps.getIdentity(child.pid); } catch {
        try { child.kill?.("SIGTERM"); } catch { /* exact child only */ }
        throw taggedError("startup_failed", "The OpenCode service child identity could not be proven.");
      }
      const deadline = Date.now() + deps.startupTimeoutMs;
      while (Date.now() < deadline) {
        if (childObservation.failure()) {
          terminateChild();
          throw taggedError("startup_failed", "The exact OpenCode service child exited or errored before readiness.");
        }
        const readiness = await probe();
        if (childObservation.failure()) {
          terminateChild();
          throw taggedError("startup_failed", "The exact OpenCode service child exited or errored before readiness.");
        }
        if (readiness === "healthy") {
          try {
            writeReceipt(receiptFile, {
              version: RECEIPT_VERSION,
              pid: child.pid,
              identity,
              commandFingerprint: createHash("sha256").update(JSON.stringify([executable, args])).digest("hex"),
            });
          } catch {
            terminateChild();
            throw taggedError("startup_failed", "The exact OpenCode service child readiness could not be persisted.");
          }
          return { status: "managed" };
        }
        if (readiness === "incompatible") break;
        await delay(deps.startupDelayMs);
      }
      terminateChild();
      throw taggedError("startup_failed", "The exact OpenCode service child did not become ready before the startup deadline.");
    } finally {
      releaseLock(lock);
    }
  }

  return Object.freeze({ ensure, inspect });
}

export async function ensureConfiguredOpencodeService(options = {}) {
  return createOpencodeServiceManager(options).ensure();
}

export async function inspectConfiguredOpencodeService(options = {}) {
  return createOpencodeServiceManager(options).inspect();
}
