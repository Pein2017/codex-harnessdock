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

import { resolveOpencodeServerUrl, createOpencodeDiscoveryClient, discoverOpencodeHealth } from "./opencode-client.mjs";
import { recoverStaleDirectoryLock, sameFileIdentity } from "./durable-directory-lock.mjs";
import { resolveOpencodeIdleTtlSeconds, resolveRuntimeEnvironment } from "./environment.mjs";
import { resolveExpectedPluginDataRoot } from "./paths.mjs";
import { getProcessIdentity, isProcessAlive, terminateProcessTree, validateProcessIdentity } from "./process-control.mjs";

const RECEIPT_VERSION = 3;
const LOCK_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 20;
const REAP_TIMEOUT_MS = 5_000;
const MANAGED_CHILD_PERMISSION = '{"*":"allow"}';
const POLICY_GENERATION = "opencode-max-permission-zero-wait-v1";

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const POLICY_GENERATION_DIGEST = sha256([POLICY_GENERATION, MANAGED_CHILD_PERMISSION]);
const CHILD_ENVIRONMENT_IDENTITY = sha256([["OPENCODE_PERMISSION", MANAGED_CHILD_PERMISSION]]);

function taggedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serviceDirectory(runtimeRoot) {
  return path.join(runtimeRoot, "opencode-service");
}

function leasesDirectory(directory) { return path.join(directory, "leases"); }

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedIdentity(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 512 && !text.includes("\0") ? text : null;
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
      ![1, 2, RECEIPT_VERSION].includes(value?.version) ||
      !Number.isSafeInteger(value?.pid) || value.pid < 1 ||
      typeof value.identity !== "string" || !value.identity ||
      typeof value.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.commandFingerprint)
    ) return null;
    if (value.version === RECEIPT_VERSION && (
      timestamp(value.startedAt) == null || timestamp(value.lastActivityAt) == null ||
      !/^[a-f0-9]{64}$/.test(value.policyGenerationDigest ?? "") ||
      !/^[a-f0-9]{64}$/.test(value.childEnvironmentIdentity ?? "")
    )) return null;
    return value;
  } catch {
    return null;
  }
}

function readLease(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || value?.state !== "active" || !/^[a-f0-9]{32}$/.test(value.token ?? "") ||
        !boundedIdentity(value.rootId) || !boundedIdentity(value.agentId) ||
        !boundedIdentity(value.turnId) || !boundedIdentity(value.attemptId) || !timestamp(value.createdAt)) return null;
    return value;
  } catch { return null; }
}

function activeLeases(directory) {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    const leases = entries.map((entry) => readLease(path.join(directory, entry.name)));
    return leases.some((lease) => lease == null) ? null : leases;
  } catch (error) { return error?.code === "ENOENT" ? [] : null; }
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

function commandFingerprint(env) {
  const executable = String(env?.OPENCODE_EXECUTABLE ?? "").trim();
  return sha256([executable, endpointArguments(env), POLICY_GENERATION_DIGEST, CHILD_ENVIRONMENT_IDENTITY]);
}

function managedChildEnvironment(env) {
  return { ...env, OPENCODE_PERMISSION: MANAGED_CHILD_PERMISSION };
}

/** Linux-only evidence for an established peer on the fixed loopback port. */
export function inspectLoopbackPeerActivity(env, options = {}) {
  if ((options.platform ?? process.platform) !== "linux") return "unknown";
  let port;
  try { port = new URL(resolveOpencodeServerUrl(env)).port; } catch { return "unknown"; }
  const expectedPort = Number(port).toString(16).padStart(4, "0").toUpperCase();
  const readFile = options.readFile ?? fs.readFileSync;
  try {
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const lines = String(readFile(file, "utf8")).trim().split(/\r?\n/u);
      if (lines.length < 1 || !/local_address\s+rem(?:ote)?_address\s+st/u.test(lines[0])) return "unknown";
      for (const line of lines.slice(1)) {
        const fields = line.trim().split(/\s+/u);
        if (fields.length < 4) return "unknown";
        const local = fields[1]?.split(":");
        if (local?.length !== 2 || !/^[0-9A-F]+$/iu.test(local[0]) || !/^[0-9A-F]{4}$/iu.test(local[1])) return "unknown";
        if (local[1].toUpperCase() === expectedPort && fields[3] === "01") return "present";
      }
    }
    return "none";
  } catch { return "unknown"; }
}

async function defaultProbe(env, cwd, options) {
  try {
    const handle = createOpencodeDiscoveryClient({ env, cwd });
    const health = await discoverOpencodeHealth(handle, options);
    if (!health.ok || !health.healthy) {
      const code = "code" in health ? health.code : null;
      return { kind: ["network_error", "deadline_exceeded", "server_error"].includes(code) ? "absent" : "incompatible" };
    }
    return { kind: "healthy" };
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
  const runtimeRoot = path.resolve(options.runtimeRoot ?? path.join(resolveExpectedPluginDataRoot(), "runtime"));
  const deps = {
    probe: options.probe ?? ((value, probeOptions) => defaultProbe(value, options.cwd, probeOptions)),
    executableCheck: options.executableCheck ?? ((file) => {
      try { return fs.statSync(file).isFile() && fs.accessSync(file, fs.constants.X_OK) === undefined; } catch { return false; }
    }),
    start: options.start ?? ((executable, args, childEnv) => nodeSpawn(executable, args, {
      cwd: options.cwd,
      env: childEnv,
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
    now: options.now ?? (() => Date.now()),
    peerActivity: options.peerActivity ?? ((value) => inspectLoopbackPeerActivity(value)),
    reapTimeoutMs: options.reapTimeoutMs ?? REAP_TIMEOUT_MS,
    reapDelayMs: options.reapDelayMs ?? RETRY_DELAY_MS,
    setTimer: options.setTimer ?? setTimeout,
  };
  const directory = serviceDirectory(runtimeRoot);
  const receiptFile = path.join(directory, "receipt.json");
  const leaseDirectory = leasesDirectory(directory);
  const ttlSeconds = resolveOpencodeIdleTtlSeconds(env);
  let scheduled = null;

  function upgradedReceipt(receipt, now) {
    return receipt.version === RECEIPT_VERSION ? receipt : {
      ...receipt, version: RECEIPT_VERSION, startedAt: new Date(now).toISOString(), lastActivityAt: new Date(now).toISOString(),
    };
  }

  async function withLock(action) {
    ensureDirectory(directory);
    const lock = await acquireLock(directory, deps);
    try { return await action(); } finally { releaseLock(lock); }
  }

  function managedReceiptMatches(receipt) {
    return receipt &&
      receipt.version === RECEIPT_VERSION &&
      receipt.policyGenerationDigest === POLICY_GENERATION_DIGEST &&
      receipt.childEnvironmentIdentity === CHILD_ENVIRONMENT_IDENTITY &&
      deps.isAlive(receipt.pid) && deps.validateIdentity(receipt.pid, receipt.identity) &&
      receipt.commandFingerprint === commandFingerprint(env);
  }

  async function acquireTurnLease(identity) {
    const rootId = boundedIdentity(identity?.rootId);
    const agentId = boundedIdentity(identity?.agentId);
    const turnId = boundedIdentity(identity?.turnId);
    const attemptId = boundedIdentity(identity?.attemptId);
    if (!rootId || !agentId || !turnId || !attemptId) throw taggedError("lease_identity_invalid", "OpenCode turn lease requires exact durable turn lineage.");
    return withLock(async () => {
      const receipt = readReceipt(receiptFile);
      const now = deps.now();
      ensureDirectory(leaseDirectory);
      const token = randomBytes(16).toString("hex");
      const file = path.join(leaseDirectory, `${token}.json`);
      writeReceipt(file, { version: 1, state: "active", token, rootId, agentId, turnId, attemptId, createdAt: new Date(now).toISOString() });
      if (managedReceiptMatches(receipt)) {
        writeReceipt(receiptFile, { ...upgradedReceipt(receipt, now), lastActivityAt: new Date(now).toISOString() });
      }
      return Object.freeze({ file, token, rootId, agentId, turnId, attemptId });
    });
  }

  async function releaseTurnLease(lease) {
    if (!lease?.file || path.dirname(lease.file) !== leaseDirectory || !/^[a-f0-9]{32}$/.test(lease.token ?? "")) return false;
    return withLock(async () => {
      const record = readLease(lease.file);
      if (!record || record.token !== lease.token ||
          ["rootId", "agentId", "turnId", "attemptId"].some((key) => record[key] !== lease[key])) return false;
      try { fs.unlinkSync(lease.file); } catch { return false; }
      const receipt = readReceipt(receiptFile);
      if (managedReceiptMatches(receipt)) {
        const now = deps.now();
        writeReceipt(receiptFile, { ...upgradedReceipt(receipt, now), lastActivityAt: new Date(now).toISOString() });
      }
      return true;
    });
  }

  async function reapIfIdle() {
    return withLock(async () => {
      const receipt = readReceipt(receiptFile);
      if (!receipt || receipt.version !== RECEIPT_VERSION || !managedReceiptMatches(receipt)) return { reaped: false, reason: "receipt_unproven" };
      if (deps.now() - timestamp(receipt.lastActivityAt) < ttlSeconds * 1_000) return { reaped: false, reason: "not_idle" };
      const leases = activeLeases(leaseDirectory);
      if (leases == null) return { reaped: false, reason: "lease_unknown" };
      if (leases.length) return { reaped: false, reason: "turn_held" };
      let peerActivity;
      try { peerActivity = deps.peerActivity(env); } catch { peerActivity = "unknown"; }
      if (peerActivity !== "none") return { reaped: false, reason: peerActivity === "present" ? "peer_present" : "peer_unknown" };
      if (await probe() !== "healthy") return { reaped: false, reason: "endpoint_unproven" };
      let termination;
      try { termination = deps.terminate(receipt.pid, receipt.identity); } catch { return { reaped: false, reason: "termination_ambiguous" }; }
      if (!termination?.attempted || !termination.delivered) return { reaped: false, reason: "termination_ambiguous" };
      const deadline = deps.now() + deps.reapTimeoutMs;
      while (deps.now() < deadline && deps.isAlive(receipt.pid)) await delay(deps.reapDelayMs);
      if (deps.isAlive(receipt.pid)) return { reaped: false, reason: "termination_ambiguous" };
      const current = readReceipt(receiptFile);
      if (!current || JSON.stringify(current) !== JSON.stringify(receipt)) return { reaped: false, reason: "receipt_changed" };
      fs.unlinkSync(receiptFile);
      writeReceipt(path.join(directory, "tombstone.json"), {
        version: 1, outcome: "terminated", startedAt: receipt.startedAt, lastActivityAt: receipt.lastActivityAt, reapedAt: new Date(deps.now()).toISOString(),
      });
      return { reaped: true, reason: "terminated" };
    });
  }

  function scheduleReap() {
    if (scheduled) return false;
    scheduled = deps.setTimer(async () => {
      scheduled = null;
      try { await reapIfIdle(); } catch {}
      scheduleReap();
    }, ttlSeconds * 1_000);
    scheduled.unref?.();
    return true;
  }

  async function probe(probeOptions) {
    const result = await deps.probe(env, probeOptions);
    return result?.kind === "healthy" ? "healthy" : result?.kind === "incompatible" ? "incompatible" : "absent";
  }

  async function inspect() {
    if (await probe() !== "healthy") return { status: "unavailable" };
    const receipt = readReceipt(receiptFile);
    return { status: managedReceiptMatches(receipt) ? "managed" : "reused" };
  }

  async function ensure() {
    const initial = await probe();
    if (initial === "healthy") return { status: managedReceiptMatches(readReceipt(receiptFile)) ? "managed" : "reused" };
    if (initial === "incompatible") throw taggedError("endpoint_incompatible", "The fixed OpenCode endpoint is occupied by an incompatible service.");

    ensureDirectory(directory);
    const lock = await acquireLock(directory, deps);
    try {
      const settled = await probe();
      if (settled === "healthy") return { status: managedReceiptMatches(readReceipt(receiptFile)) ? "managed" : "reused" };
      if (settled === "incompatible") throw taggedError("endpoint_incompatible", "The fixed OpenCode endpoint is occupied by an incompatible service.");

      const stale = readReceipt(receiptFile);
      if (stale && deps.isAlive(stale.pid) && deps.validateIdentity(stale.pid, stale.identity)) {
        throw taggedError("managed_service_unhealthy", "The managed OpenCode service is still alive but cannot prove fixed-origin readiness.");
      }
      try { fs.unlinkSync(receiptFile); } catch { /* absent/corrupt/stale is intentionally discarded under the fence */ }

      const executable = configuredExecutable(env, deps.executableCheck);
      const args = endpointArguments(env);
      const child = deps.start(executable, args, managedChildEnvironment(env));
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
        const readiness = await probe({ timeoutMs: deadline - Date.now() });
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
              commandFingerprint: commandFingerprint(env),
              policyGenerationDigest: POLICY_GENERATION_DIGEST,
              childEnvironmentIdentity: CHILD_ENVIRONMENT_IDENTITY,
              startedAt: new Date(deps.now()).toISOString(),
              lastActivityAt: new Date(deps.now()).toISOString(),
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

  return Object.freeze({ ensure, inspect, acquireTurnLease, releaseTurnLease, reapIfIdle, scheduleReap });
}

export async function ensureConfiguredOpencodeService(options = {}) {
  return createOpencodeServiceManager(options).ensure();
}

export async function inspectConfiguredOpencodeService(options = {}) {
  return createOpencodeServiceManager(options).inspect();
}
