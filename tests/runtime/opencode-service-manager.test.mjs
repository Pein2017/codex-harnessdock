import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createOpencodeServiceManager, inspectLoopbackPeerActivity } from "../../runtime/opencode-service-manager.mjs";
import { resolveExpectedPluginDataRoot } from "../../runtime/paths.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-service-"));
  cleanups.push(runtimeRoot);
  let healthy = false;
  let starts = 0;
  let killed = 0;
  let pid = 7000;
  const manager = createOpencodeServiceManager({
    env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
    runtimeRoot,
    probe: async () => ({ kind: healthy ? "healthy" : "absent" }),
    executableCheck: () => true,
    start: () => {
      starts += 1;
      const child = new EventEmitter();
      child.pid = ++pid;
      child.unref = () => {};
      child.kill = () => { killed += 1; child.emit("exit", 1); };
      healthy = true;
      return child;
    },
    getIdentity: (value) => `identity-${value}`,
    isAlive: () => true,
    validateIdentity: () => false,
    startupDelayMs: 1,
    startupTimeoutMs: 100,
  });
  return { manager, state: () => ({ starts, killed }), setHealthy: (value) => { healthy = value; }, runtimeRoot };
}

describe("OpenCode shared service manager", () => {
  it("reuses a healthy endpoint without starting or claiming it", async () => {
    const { manager, state, setHealthy, runtimeRoot } = fixture();
    setHealthy(true);
    assert.deepEqual(await manager.ensure(), { status: "reused" });
    assert.deepEqual(state(), { starts: 0, killed: 0 });
    assert.equal(fs.existsSync(path.join(runtimeRoot, "opencode-service", "receipt.json")), false);
  });

  it("binds managed-child maximum permission without claiming an unattested attachment", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-policy-"));
    cleanups.push(runtimeRoot);
    let healthy = false;
    let childEnv;
    const manager = createOpencodeServiceManager({
      env: {
        OPENCODE_SERVER_URL: "http://127.0.0.1:4096",
        OPENCODE_EXECUTABLE: "/opt/opencode",
        OPENCODE_PERMISSION: "operator-override",
        OPENCODE_UNRELATED_SECRET: "must-not-appear-in-receipt",
      },
      runtimeRoot,
      probe: async () => ({ kind: healthy ? "healthy" : "absent" }),
      executableCheck: () => true,
      start: (_executable, _args, value) => {
        childEnv = value;
        healthy = true;
        return { pid: 91, unref() {} };
      },
      getIdentity: () => "identity-91",
      isAlive: () => true,
      validateIdentity: () => true,
    });
    const inherited = process.env.OPENCODE_PERMISSION;

    assert.deepEqual(await manager.ensure(), { status: "managed" });
    assert.equal(childEnv.OPENCODE_PERMISSION, '{"*":"allow"}');
    assert.equal(process.env.OPENCODE_PERMISSION, inherited);
    const receiptFile = path.join(runtimeRoot, "opencode-service", "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    assert.match(receipt.policyGenerationDigest, /^[a-f0-9]{64}$/);
    assert.match(receipt.childEnvironmentIdentity, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes("must-not-appear-in-receipt"), false);
    assert.deepEqual(await manager.inspect(), { status: "managed" });

    receipt.policyGenerationDigest = "0".repeat(64);
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    assert.deepEqual(await manager.inspect(), { status: "reused" });
  });

  it("keeps managed ownership outside disposable runtime isolation homes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-service-owner-"));
    cleanups.push(root);
    const codexHome = path.join(root, "codex-home");
    const firstRuntimeHome = path.join(root, "first-runtime-home");
    const secondRuntimeHome = path.join(root, "second-runtime-home");
    const priorCodexHome = process.env.CODEX_HOME;
    const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = firstRuntimeHome;
    try {
      const stableRuntimeRoot = path.join(resolveExpectedPluginDataRoot(), "runtime");
      const receipt = path.join(stableRuntimeRoot, "opencode-service", "receipt.json");
      let started = 0;
      const first = createOpencodeServiceManager({
        env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
        probe: async () => ({ kind: started ? "healthy" : "absent" }),
        executableCheck: () => true,
        start: () => { started += 1; return { pid: 21, unref() {} }; },
        getIdentity: () => "child-identity",
      });
      assert.deepEqual(await first.ensure(), { status: "managed" });
      assert.equal(started, 1);
      assert.equal(fs.existsSync(path.join(firstRuntimeHome, "opencode-service", "receipt.json")), false);
      assert.equal(fs.statSync(path.dirname(receipt)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);

      fs.rmSync(firstRuntimeHome, { recursive: true, force: true });
      process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = secondRuntimeHome;
      const second = createOpencodeServiceManager({
        env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
        probe: async () => ({ kind: "healthy" }),
        start: () => { throw new Error("managed service must be reused"); },
        isAlive: () => true,
        validateIdentity: () => true,
      });
      assert.deepEqual(await second.inspect(), { status: "managed" });
      assert.equal(fs.existsSync(receipt), true);
    } finally {
      if (priorCodexHome == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
      else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
    }
  });

  it("inspects managed and reused readiness without lifecycle mutation or configuration disclosure", async () => {
    const { manager, state, setHealthy, runtimeRoot } = fixture();
    setHealthy(true);
    assert.deepEqual(await manager.inspect(), { status: "reused" });
    assert.equal(fs.existsSync(path.join(runtimeRoot, "opencode-service")), false);

    const receipt = path.join(runtimeRoot, "opencode-service", "receipt.json");
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({
      version: 1,
      pid: 9001,
      identity: "managed-identity",
      commandFingerprint: "a".repeat(64),
    }));
    const managed = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/secret/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: "healthy" }),
      isAlive: () => true,
      validateIdentity: () => true,
      start: () => { throw new Error("doctor must not start"); },
    });
    const before = fs.readFileSync(receipt, "utf8");
    const status = await managed.inspect();
    assert.deepEqual(status, { status: "reused" });
    assert.equal(fs.readFileSync(receipt, "utf8"), before);
    assert.equal(JSON.stringify(status).includes("secret"), false);
    assert.deepEqual(state(), { starts: 0, killed: 0 });
  });

  it("serializes concurrent absence into exactly one start", async () => {
    const { manager, state } = fixture();
    const results = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
    assert.equal(state().starts, 1);
    assert.deepEqual(results.map((result) => result.status).sort(), ["managed", "reused", "reused"]);
  });

  it("replaces only a stale managed receipt", async () => {
    const { manager, state, runtimeRoot } = fixture();
    const receipt = path.join(runtimeRoot, "opencode-service", "receipt.json");
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ version: 1, pid: 1234, identity: "old", command: "x" }));
    assert.equal((await manager.ensure()).status, "managed");
    assert.equal(state().starts, 1);
  });

  it("fails closed for an incompatible endpoint without starting or killing it", async () => {
    const { runtimeRoot } = fixture();
    let starts = 0;
    let killed = 0;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: "incompatible" }),
      executableCheck: () => true,
      start: () => { starts += 1; throw new Error("must not run"); },
      terminate: () => { killed += 1; },
    });
    await assert.rejects(manager.ensure(), (error) => error?.code === "endpoint_incompatible");
    assert.deepEqual({ starts, killed }, { starts: 0, killed: 0 });
  });

  it("cleans up only its exact failed child", async () => {
    const { runtimeRoot } = fixture();
    let killed = 0;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: "absent" }),
      executableCheck: () => true,
      start: () => ({ pid: 17, unref() {}, kill() { killed += 1; } }),
      getIdentity: () => "child-identity",
      terminate: () => { killed += 1; },
      startupDelayMs: 1,
      startupTimeoutMs: 5,
    });
    await assert.rejects(manager.ensure(), (error) => error?.code === "startup_failed");
    assert.equal(killed, 1);
  });

  it("retries a first startup health deadline before terminating its exact child", async () => {
    const { runtimeRoot } = fixture();
    let starts = 0;
    let terminated = 0;
    let probesAfterStart = 0;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => {
        if (starts === 0) return { kind: "absent" };
        if (probesAfterStart++ === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5_100));
          return { kind: "absent" };
        }
        return { kind: "healthy" };
      },
      executableCheck: () => true,
      start: () => {
        starts += 1;
        return { pid: 20, unref() {}, kill() { terminated += 1; } };
      },
      getIdentity: () => "child-identity",
      terminate: () => { terminated += 1; },
      startupDelayMs: 1,
    });
    assert.deepEqual(await manager.ensure(), { status: "managed" });
    assert.deepEqual({ starts, terminated, probesAfterStart }, { starts: 1, terminated: 0, probesAfterStart: 2 });
  });

  it("contains an early child error as one bounded startup failure", async () => {
    const { runtimeRoot } = fixture();
    let terminated = 0;
    let emitted = false;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: "absent" }),
      executableCheck: () => true,
      start: () => {
        const child = new EventEmitter();
        child.pid = 18;
        child.unref = () => {};
        queueMicrotask(() => { emitted = true; child.emit("error", new Error("spawn-race")); });
        return child;
      },
      getIdentity: () => "child-identity",
      terminate: () => { terminated += 1; },
      startupDelayMs: 1,
      startupTimeoutMs: 20,
    });
    await assert.rejects(manager.ensure(), (error) => error?.code === "startup_failed" && !/spawn-race/.test(error.message));
    assert.equal(emitted, true);
    assert.equal(terminated, 1);
  });

  it("terminates its exact healthy child when receipt persistence fails", async () => {
    const { runtimeRoot } = fixture();
    const receipt = path.join(runtimeRoot, "opencode-service", "receipt.json");
    fs.mkdirSync(receipt, { recursive: true });
    let terminated = 0;
    let healthy = false;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: healthy ? "healthy" : "absent" }),
      executableCheck: () => true,
      start: () => {
        healthy = true;
        return { pid: 19, unref() {} };
      },
      getIdentity: () => "child-identity",
      terminate: (pid, identity) => {
        assert.equal(pid, 19);
        assert.equal(identity, "child-identity");
        terminated += 1;
      },
    });
    await assert.rejects(manager.ensure(), (error) => error?.code === "startup_failed" && !/EISDIR/.test(error.message));
    assert.equal(terminated, 1);
  });

  it("holds active leases and reaps only its exact idle managed process", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-reap-"));
    cleanups.push(runtimeRoot);
    let now = 1_000;
    let alive = false;
    let serverReady = false;
    let terminated = 0;
    const durableHistory = path.join(runtimeRoot, "durable-agent-history.json");
    fs.writeFileSync(durableHistory, "must-survive");
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode", HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: "60" },
      runtimeRoot,
      probe: async () => ({ kind: serverReady ? "healthy" : "absent" }),
      executableCheck: () => true,
      start: () => { alive = true; serverReady = true; return { pid: 99, unref() {} }; },
      getIdentity: () => "identity-99",
      isAlive: () => alive,
      validateIdentity: () => alive,
      terminate: () => { terminated += 1; alive = false; serverReady = false; return { attempted: true, delivered: true }; },
      now: () => now,
      peerActivity: () => "none",
    });
    assert.equal((await manager.ensure()).status, "managed");
    const lease = await manager.acquireTurnLease({ rootId: "root", agentId: "agent", turnId: "turn", attemptId: "attempt" });
    now += 61_000;
    assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "turn_held" });
    await manager.releaseTurnLease(lease);
    now += 61_000;
    assert.deepEqual(await manager.reapIfIdle(), { reaped: true, reason: "terminated" });
    assert.equal(terminated, 1);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "opencode-service", "receipt.json")), false);
    const tombstone = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "opencode-service", "tombstone.json"), "utf8"));
    assert.deepEqual(Object.keys(tombstone).sort(), ["lastActivityAt", "outcome", "reapedAt", "startedAt", "version"]);
    assert.equal(tombstone.outcome, "terminated");
    assert.equal(fs.readFileSync(durableHistory, "utf8"), "must-survive");
  });

  it("keeps reused services usable while their independent durable lease is exact", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-reused-"));
    cleanups.push(runtimeRoot);
    let terminated = 0;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot,
      probe: async () => ({ kind: "healthy" }),
      executableCheck: () => true,
      terminate: () => { terminated += 1; return { attempted: true, delivered: true }; },
    });
    assert.deepEqual(await manager.ensure(), { status: "reused" });
    const first = await manager.acquireTurnLease({ rootId: "root", agentId: "agent", turnId: "turn-a", attemptId: "attempt-a" });
    const second = await manager.acquireTurnLease({ rootId: "root", agentId: "agent", turnId: "turn-b", attemptId: "attempt-b" });
    assert.equal(await manager.releaseTurnLease({ ...first, file: second.file }), false);
    assert.equal(fs.existsSync(second.file), true);
    assert.equal(await manager.releaseTurnLease(first), true);
    assert.equal(await manager.releaseTurnLease(second), true);
    assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "receipt_unproven" });
    assert.equal(terminated, 0);
  });

  it("uses Linux socket evidence and refuses reaping on present or unreadable peers", async () => {
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    const ipv6Header = "  sl  local_address remote_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    const established = `${header}\n   0: 0100007F:1000 0100007F:9C40 01 00000000:00000000 00:00000000 00000000 1000 0 1`;
    assert.equal(inspectLoopbackPeerActivity({}, { platform: "linux", readFile: () => established }), "present");
    assert.equal(inspectLoopbackPeerActivity({}, {
      platform: "linux",
      readFile: (file) => file.endsWith("tcp6") ? ipv6Header : header,
    }), "none");
    assert.equal(inspectLoopbackPeerActivity({}, { platform: "linux", readFile: () => { throw new Error("unreadable"); } }), "unknown");

    for (const [peerActivity, reason] of [[() => "present", "peer_present"], [() => "unknown", "peer_unknown"]]) {
      const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-peer-"));
      cleanups.push(runtimeRoot);
      let alive = false;
      let ready = false;
      let now = 1_000;
      let terminated = 0;
      const manager = createOpencodeServiceManager({
        env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode", HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: "60" },
        runtimeRoot,
        probe: async () => ({ kind: ready ? "healthy" : "absent" }), executableCheck: () => true,
        start: () => { alive = true; ready = true; return { pid: 81, unref() {} }; }, getIdentity: () => "identity-81",
        isAlive: () => alive, validateIdentity: () => alive, now: () => now, peerActivity,
        terminate: () => { terminated += 1; alive = false; return { attempted: true, delivered: true }; },
      });
      await manager.ensure();
      now += 60_000;
      assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason });
      assert.equal(terminated, 0);
    }
  });

  it("does not mistake its own health probe for a pre-existing peer", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-self-peer-"));
    cleanups.push(runtimeRoot);
    let alive = false;
    let ready = false;
    let probing = false;
    let now = 1_000;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode", HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: "60" },
      runtimeRoot,
      probe: async () => { probing = true; return { kind: ready ? "healthy" : "absent" }; },
      executableCheck: () => true,
      start: () => { alive = true; ready = true; return { pid: 84, unref() {} }; },
      getIdentity: () => "identity-84",
      isAlive: () => alive,
      validateIdentity: () => alive,
      now: () => now,
      peerActivity: () => probing ? "present" : "none",
      terminate: () => { alive = false; return { attempted: true, delivered: true }; },
    });
    await manager.ensure();
    probing = false;
    now += 60_000;
    assert.deepEqual(await manager.reapIfIdle(), { reaped: true, reason: "terminated" });
  });

  it("does not refresh activity for health or ensure and rechecks the one-hour boundary", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-hour-"));
    cleanups.push(runtimeRoot);
    let now = 1_000;
    let alive = false;
    let ready = false;
    const manager = createOpencodeServiceManager({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode" },
      runtimeRoot, probe: async () => ({ kind: ready ? "healthy" : "absent" }), executableCheck: () => true,
      start: () => { alive = true; ready = true; return { pid: 82, unref() {} }; }, getIdentity: () => "identity-82",
      isAlive: () => alive, validateIdentity: () => alive, now: () => now, peerActivity: () => "none",
      terminate: () => { alive = false; return { attempted: true, delivered: true }; },
    });
    await manager.ensure();
    const receipt = path.join(runtimeRoot, "opencode-service", "receipt.json");
    const activity = JSON.parse(fs.readFileSync(receipt, "utf8")).lastActivityAt;
    now += 3_599_999;
    await manager.inspect();
    await manager.ensure();
    assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).lastActivityAt, activity);
    assert.deepEqual(await manager.reapIfIdle(), { reaped: false, reason: "not_idle" });
    now += 1;
    assert.deepEqual(await manager.reapIfIdle(), { reaped: true, reason: "terminated" });
  });

  it("serializes reapers, refuses drift and ambiguous termination, and re-arms one timer", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-fence-"));
    cleanups.push(runtimeRoot);
    let now = 1_000;
    let alive = false;
    let ready = false;
    let terminated = 0;
    const common = {
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096", OPENCODE_EXECUTABLE: "/opt/opencode", HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: "60" },
      runtimeRoot, probe: async () => ({ kind: ready ? "healthy" : "absent" }), executableCheck: () => true,
      start: () => { alive = true; ready = true; return { pid: 83, unref() {} }; }, getIdentity: () => "identity-83",
      isAlive: () => alive, validateIdentity: () => alive, now: () => now, peerActivity: () => "none",
      terminate: () => { terminated += 1; alive = false; return { attempted: true, delivered: true }; },
    };
    const first = createOpencodeServiceManager(common);
    await first.ensure();
    now += 60_000;
    const drift = createOpencodeServiceManager({ ...common, validateIdentity: () => false });
    assert.deepEqual(await drift.reapIfIdle(), { reaped: false, reason: "receipt_unproven" });
    const commandDrift = createOpencodeServiceManager({
      ...common,
      env: { ...common.env, OPENCODE_EXECUTABLE: "/other/opencode" },
    });
    assert.deepEqual(await commandDrift.reapIfIdle(), { reaped: false, reason: "receipt_unproven" });

    const second = createOpencodeServiceManager(common);
    const outcomes = await Promise.all([first.reapIfIdle(), second.reapIfIdle()]);
    assert.equal(outcomes.filter((result) => result.reaped).length, 1);
    assert.equal(terminated, 1);

    const callbacks = [];
    const timer = createOpencodeServiceManager({ ...common, setTimer: (fn, ms) => {
      const handle = { fn, ms, unref() {} }; callbacks.push(handle); return handle;
    } });
    assert.equal(timer.scheduleReap(), true);
    assert.equal(timer.scheduleReap(), false);
    await callbacks[0].fn();
    assert.equal(callbacks.length, 2);

    const ambiguousRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-ambiguous-"));
    cleanups.push(ambiguousRoot);
    alive = false;
    ready = false;
    const ambiguous = createOpencodeServiceManager({ ...common, runtimeRoot: ambiguousRoot, start: () => { alive = true; ready = true; return { pid: 84, unref() {} }; }, getIdentity: () => "identity-84", terminate: () => ({ attempted: true, delivered: false }) });
    await ambiguous.ensure();
    assert.deepEqual(await ambiguous.reapIfIdle(), { reaped: false, reason: "not_idle" });
    now += 60_000;
    assert.deepEqual(await ambiguous.reapIfIdle(), { reaped: false, reason: "termination_ambiguous" });
  });
});
