import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";

import { createOpencodeServiceManager } from "../../runtime/opencode-service-manager.mjs";

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
    assert.deepEqual(status, { status: "managed" });
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
});
