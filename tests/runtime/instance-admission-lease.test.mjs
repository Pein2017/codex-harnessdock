/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenSpec `generalize-multi-harness-agent-control-plane` tasks 4.1-4.3.
 *
 * `runtime/instance-admission-lease.mjs` is the narrow single owner of the
 * version-three admission lease schema and its atomic engine: logical
 * Harness-instance capacity and exact native-session exclusivity. It has no
 * dependency on any Driver module or model-facing selector. Canonical-
 * workspace writer *scenarios* (cross-Harness collision, distinct prepared
 * worktrees, read-only coexistence) live in `workspace-writer-lease.test.mjs`;
 * this file exercises only the shared engine's kind-agnostic invariants for
 * the writer kind.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  acquireInstanceLease,
  acquireNativeSessionLease,
  acquireLease,
  acquiredLeaseEvidence,
  inspectLeaseInventory,
  releaseExactLeasesForHardReclaim,
  releaseLeasesOnSettlement,
  LEASE_ACQUISITION_EVIDENCE_FIELDS,
  MAX_HOLDERS_PER_ENTRY,
  MAX_INVENTORY_ENTRIES,
} from "../../runtime/instance-admission-lease.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const contentionFixture = fileURLToPath(
  new URL("./fixtures/instance-admission-lease-contender.mjs", import.meta.url)
);

const priorHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const roots = [];

afterEach(() => {
  if (priorHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lease-"));
  roots.push(root);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "state-home");
  return { root };
}

function binding(overrides = {}) {
  return {
    ownerRootId: "root-1",
    agentId: "agent-1",
    jobId: "job-1",
    route: versionThreeRoute(),
    ...overrides,
  };
}

/** A minimal publishable normalized-terminal-result fixture, shared by every release test. */
function publishableResult(overrides = {}) {
  return {
    status: "completed",
    nativeTurn: "terminal",
    executionWorld: { continuity: "not_applicable", settlement: "settled" },
    continuation: { mode: "none" },
    nativeTurnRef: {
      version: 1,
      harnessId: "fake-service",
      driverVersion: "fake-service@1",
      instanceKey: "tenant-alpha",
      locatorVersion: 1,
      locator: { turnId: "t-1" },
    },
    ...overrides,
  };
}

function releaseOne(target) {
  return releaseLeasesOnSettlement({ normalizedTerminalResult: publishableResult(), releases: [target] });
}

describe("instance admission lease: logical instance capacity", () => {
  it("admits up to the stated capacity limit and refuses the next distinct holder", () => {
    setup();
    const bindingA = {
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    };
    const a = acquireInstanceLease(bindingA);
    assert.equal(a.kind, "instance");
    assert.equal(a.ownerRootId, "root-1");
    assert.equal(a.route.harnessId, "fake-service");
    assert.equal(a.route.capabilities.values.interaction, "noninteractive_fixed_policy");
    assert.equal(a.capacity.class, "shared");
    assert.equal(a.capacity.limit, 2);

    acquireInstanceLease({
      ...binding({ jobId: "job-b", agentId: "agent-2" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    });

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-c", agentId: "agent-3" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 2,
      }),
      /capacity/i
    );

    const released = releaseOne({ kind: "instance", ...bindingA });
    assert.equal(released.released, true);
    assert.equal(released.releasedCount, 1);

    const c = acquireInstanceLease({
      ...binding({ jobId: "job-c", agentId: "agent-3" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    });
    assert.equal(c.jobId, "job-c");
  });

  it("is instance/route/instance-key qualified, not a global concurrency constant", () => {
    setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    // A distinct instance key under the same Harness is unrelated capacity.
    const other = acquireInstanceLease({
      ...binding({
        jobId: "job-b",
        agentId: "agent-2",
        route: versionThreeRoute({ harnessId: "fake-service", instanceKey: "tenant-beta" }),
      }),
      harnessId: "fake-service",
      instanceKey: "tenant-beta",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    assert.equal(other.keyFields.instanceKey, "tenant-beta");
  });

  it("reacquires idempotently only for the exact same owner/Agent/job/route identity", () => {
    setup();
    const first = acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    const second = acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    assert.equal(first.createdAt, second.createdAt);
    assert.notEqual(first, second, "each read returns a fresh frozen snapshot, never an aliased live object");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-a", agentId: "agent-other" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      }),
      /capacity/i
    );
  });

  it("fails closed on a capacity-evidence conflict between callers of the same key", () => {
    setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    });
    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /capacity evidence conflict/i
    );
  });
});

describe("instance admission lease: exact native-session conflicts", () => {
  it("admits exactly one holder per (harnessId, instanceKey, nativeSessionId)", () => {
    setup();
    const held = acquireNativeSessionLease({
      ...binding(),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-1",
    });
    assert.equal(held.kind, "native_session");
    assert.equal(held.keyFields.nativeSessionId, "native-session-1", "native_session keyFields expose their session ID for diagnostics");
    assert.equal(held.key.includes("native-session-1"), true);
    assert.equal(held.capacity.limit, 1);

    assert.throws(
      () => acquireNativeSessionLease({
        ...binding({ jobId: "job-2", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        nativeSessionId: "native-session-1",
      }),
      /capacity/i
    );

    // A distinct native session ID on the same instance is unrelated.
    const distinct = acquireNativeSessionLease({
      ...binding({ jobId: "job-3", agentId: "agent-3" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-2",
    });
    assert.notEqual(distinct.key, held.key);
  });

  it("does not collide across Harnesses even with the same reported native session ID", () => {
    setup();
    acquireNativeSessionLease({
      ...binding({ route: versionThreeRoute({ harnessId: "fake-service", instanceKey: "tenant-alpha" }) }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "shared-looking-id",
    });
    const other = acquireNativeSessionLease({
      ...binding({
        jobId: "job-2",
        agentId: "agent-2",
        route: versionThreeRoute({ harnessId: "claude-code", instanceKey: "tenant-alpha" }),
      }),
      harnessId: "claude-code",
      instanceKey: "tenant-alpha",
      nativeSessionId: "shared-looking-id",
    });
    assert.equal(other.keyFields.harnessId, "claude-code");
  });

  it("releases only for the exact identity that acquired it and never partially, on the same settlement predicate", () => {
    setup();
    const sessionBinding = {
      ...binding(),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-1",
    };
    acquireNativeSessionLease(sessionBinding);

    // The exact holderFile digest *is* the identity: a different presented
    // identity derives a different (non-existent) file, so this is honestly
    // "already released" (a no-op) rather than a cross-identity mutation --
    // and, critically, it never touches the real holder's file.
    const intruderAttempt = releaseOne({ kind: "native_session", ...sessionBinding, agentId: "agent-intruder" });
    assert.equal(intruderAttempt.released, true);
    assert.equal(intruderAttempt.releasedCount, 0);
    assert.equal(intruderAttempt.alreadyReleasedCount, 1);

    // The true owner's lease is untouched and still exclusively held.
    assert.throws(
      () => acquireNativeSessionLease({ ...sessionBinding, agentId: "agent-other", jobId: "job-other" }),
      /capacity/i
    );
    const realRelease = releaseOne({ kind: "native_session", ...sessionBinding });
    assert.equal(realRelease.released, true);
    assert.equal(realRelease.releasedCount, 1);
  });
});

describe("instance admission lease: full binding identity", () => {
  it("binds every lease to owner root, Agent, job, full canonical route/capabilities, and exact kind/key", () => {
    setup();
    const route = versionThreeRoute({ model: "fake-service-large" });
    const lease = acquireInstanceLease({
      ownerRootId: "root-9",
      agentId: "agent-9",
      jobId: "job-9",
      route,
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    assert.equal(lease.ownerRootId, "root-9");
    assert.equal(lease.agentId, "agent-9");
    assert.equal(lease.jobId, "job-9");
    assert.equal(lease.kind, "instance");
    assert.equal(typeof lease.key, "string");
    assert.deepEqual(lease.route.capabilities.values, route.capabilities.values);
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(Object.isFrozen(lease.route), true);
  });

  it("refuses a route missing required version-three fields", () => {
    setup();
    const { capabilitySchemaVersion: _drop, ...incomplete } = versionThreeRoute();
    assert.throws(
      () => acquireInstanceLease({
        ...binding({ route: incomplete }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      }),
      /capabilitySchemaVersion/
    );
  });

  it("refuses a Proxy-wrapped route without invoking any trap", () => {
    setup();
    let trapped = false;
    const proxyRoute = new Proxy(versionThreeRoute(), {
      get(target, prop, receiver) {
        trapped = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.throws(() => acquireInstanceLease({
      ...binding({ route: proxyRoute }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    }));
    assert.equal(trapped, false);
  });

  it("refuses malformed owner/Agent/job identity text", () => {
    setup();
    for (const badId of ["", "   ", "with\0nul", "a".repeat(400)]) {
      assert.throws(() => acquireInstanceLease({
        ...binding({ ownerRootId: badId }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      }));
    }
  });

  it("refuses an instance lease whose key Harness/instance does not match its bound route", () => {
    setup();
    assert.throws(
      () => acquireInstanceLease({
        ...binding({ route: versionThreeRoute({ harnessId: "fake-service", instanceKey: "tenant-alpha" }) }),
        harnessId: "claude-code", // key names a different Harness than the bound route
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      }),
      /does not match its bound route/i
    );
    assert.throws(
      () => acquireInstanceLease({
        ...binding({ route: versionThreeRoute({ harnessId: "fake-service", instanceKey: "tenant-alpha" }) }),
        harnessId: "fake-service",
        instanceKey: "tenant-beta", // key names a different instance than the bound route
        capacityClass: "shared",
        capacityLimit: 1,
      }),
      /does not match its bound route/i
    );
  });

  it("refuses a native-session lease whose key Harness/instance does not match its bound route", () => {
    setup();
    assert.throws(
      () => acquireNativeSessionLease({
        ...binding({ route: versionThreeRoute({ harnessId: "fake-service", instanceKey: "tenant-alpha" }) }),
        harnessId: "claude-code",
        instanceKey: "tenant-alpha",
        nativeSessionId: "native-session-1",
      }),
      /does not match its bound route/i
    );
  });

  it("refuses a writer-kind lease whose bound route authority is not behavioral_write", () => {
    const { root } = setup();
    const workspaceRoot = fs.mkdtempSync(path.join(root, "worktree-"));
    assert.throws(
      () => acquireLease({
        kind: "writer",
        workspaceRoot,
        ownerRootId: "root-1",
        agentId: "agent-1",
        jobId: "job-1",
        route: versionThreeRoute({ authority: "behavioral_read_only" }),
        capacityLimit: 1,
      }),
      /requires a behavioral_write route/i
    );
  });
});

describe("instance admission lease: generic engine supports the writer kind (scenarios in workspace-writer-lease.test.mjs)", () => {
  it("acquires and releases a writer-kind lease only through the settlement-gated path", () => {
    const { root } = setup();
    const workspaceRoot = fs.mkdtempSync(path.join(root, "worktree-"));
    const writerBinding = {
      ownerRootId: "root-1",
      agentId: "agent-1",
      jobId: "job-1",
      route: versionThreeRoute({ authority: "behavioral_write" }),
      workspaceRoot,
    };
    const acquired = acquireLease({ kind: "writer", capacityLimit: 1, ...writerBinding });
    assert.equal(acquired.kind, "writer");
    assert.equal(acquired.keyFields.workspaceRoot, fs.realpathSync.native(workspaceRoot));
    const released = releaseOne({ kind: "writer", ...writerBinding });
    assert.equal(released.released, true);
    assert.equal(released.releasedCount, 1);
  });

  it("cannot present a key/keyFields split: acquireLease derives them internally, never from caller input", () => {
    const { root } = setup();
    const workspaceRoot = fs.mkdtempSync(path.join(root, "worktree-"));
    const acquired = acquireLease({
      kind: "writer",
      workspaceRoot,
      // A caller-supplied `key`/`keyFields` would be a forgery vector; the
      // exported signature does not even accept those parameter names, so
      // passing them here proves they are silently ignored, not honored.
      key: "writer\0/etc/passwd",
      keyFields: { workspaceRoot: "/etc/passwd" },
      ownerRootId: "root-1",
      agentId: "agent-1",
      jobId: "job-1",
      route: versionThreeRoute({ authority: "behavioral_write" }),
      capacityLimit: 1,
    });
    assert.equal(acquired.keyFields.workspaceRoot, fs.realpathSync.native(workspaceRoot));
    assert.notEqual(acquired.keyFields.workspaceRoot, "/etc/passwd");
  });

  it("has no exported identity-only release function", async () => {
    const module = await import("../../runtime/instance-admission-lease.mjs");
    assert.equal(module.releaseLease, undefined);
    assert.equal(module.releaseInstanceLease, undefined);
    assert.equal(module.releaseNativeSessionLease, undefined);
  });
});

describe("instance admission lease: fail-closed corruption and race handling", () => {
  it("refuses to admit past an unreadable existing holder record without deleting it", () => {
    const { root } = setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 5,
    });
    const stateHome = path.join(root, "state-home");
    const leaseFiles = fs.readdirSync(
      path.join(stateHome, "state", "leases", "v1", "instance"),
      { recursive: true }
    ).filter((entry) => entry.endsWith(".json"));
    assert.equal(leaseFiles.length, 1);
    const corruptPath = path.join(stateHome, "state", "leases", "v1", "instance", leaseFiles[0]);
    const before = fs.readFileSync(corruptPath, "utf8");
    fs.writeFileSync(corruptPath, "{not json");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /corrupt/i
    );
    // Corrupt evidence is never silently deleted to make room.
    assert.equal(fs.readFileSync(corruptPath, "utf8"), "{not json");
    assert.notEqual(before, "{not json");
  });

  it("refuses to admit past a zero-byte partial-write holder record without deleting it", () => {
    const { root } = setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 5,
    });
    const stateHome = path.join(root, "state-home");
    const instanceDir = path.join(stateHome, "state", "leases", "v1", "instance");
    const leaseFiles = fs.readdirSync(instanceDir, { recursive: true }).filter((entry) => entry.endsWith(".json"));
    assert.equal(leaseFiles.length, 1);
    const partialPath = path.join(instanceDir, leaseFiles[0]);
    // A crash between `open(O_CREAT|O_EXCL)` and the first `write()` leaves
    // exactly this: a zero-byte file at the final name, not a `.tmp.*` file
    // (the atomic-write helper always writes to a temp name first and only
    // `rename()`s once the write is fsynced, so this simulates a corrupted
    // *existing* record, not an in-flight write of a new one).
    fs.writeFileSync(partialPath, "");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /corrupt/i
    );
    assert.equal(fs.readFileSync(partialPath, "utf8"), "");
  });

  it("creates lease directories and files with owner-only 0700/0600 modes", () => {
    const { root } = setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    const stateHome = path.join(root, "state-home");
    const leasesRoot = path.join(stateHome, "state", "leases");
    const instanceRoot = path.join(leasesRoot, "v1", "instance");
    assert.equal(fs.statSync(leasesRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(instanceRoot).mode & 0o777, 0o700);
    const [keyDigest] = fs.readdirSync(instanceRoot);
    const keyDir = path.join(instanceRoot, keyDigest);
    assert.equal(fs.statSync(keyDir).mode & 0o777, 0o700);
    const [leaseFile] = fs.readdirSync(keyDir).filter((name) => name.endsWith(".json"));
    assert.equal(fs.statSync(path.join(keyDir, leaseFile)).mode & 0o777, 0o600);
  });

  it("serializes concurrent independent-process admission at exact capacity without over-admitting", async () => {
    const { root } = setup();
    const attempts = 6;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [
            contentionFixture,
            "instance",
            "fake-service",
            "tenant-alpha",
            "shared",
            "3",
            `agent-${index}`,
            `job-${index}`,
          ], {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.on("exit", () => resolve(stdout.trim()));
        })
      )
    );
    const admitted = results.filter((line) => line === "admitted");
    const refused = results.filter((line) => line === "capacity_exhausted");
    assert.equal(admitted.length, 3);
    assert.equal(refused.length, attempts - 3);

    const stateHome = path.join(root, "state-home");
    const leaseFiles = fs.readdirSync(
      path.join(stateHome, "state", "leases", "v1", "instance"),
      { recursive: true }
    ).filter((entry) => entry.endsWith(".json"));
    assert.equal(leaseFiles.length, 3);
  });

  it("serializes concurrent independent-process admission for one exclusive native session", async () => {
    const { root } = setup();
    const attempts = 6;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [
            contentionFixture,
            "native_session",
            "fake-service",
            "tenant-alpha",
            "native-session-race",
            `agent-${index}`,
            `job-${index}`,
          ], {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.on("exit", () => resolve(stdout.trim()));
        })
      )
    );
    const admitted = results.filter((line) => line === "admitted");
    const refused = results.filter((line) => line === "capacity_exhausted");
    assert.equal(admitted.length, 1);
    assert.equal(refused.length, attempts - 1);

    const stateHome = path.join(root, "state-home");
    const leaseFiles = fs.readdirSync(
      path.join(stateHome, "state", "leases", "v1", "native_session"),
      { recursive: true }
    ).filter((entry) => entry.endsWith(".json"));
    assert.equal(leaseFiles.length, 1);
  });
});

describe("instance admission lease: closed record validator and redacted diagnostics", () => {
  function acquireOneAndLocateFile(root) {
    acquireInstanceLease({
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 5,
    });
    const stateHome = path.join(root, "state-home");
    const instanceDir = path.join(stateHome, "state", "leases", "v1", "instance");
    const [keyDigest] = fs.readdirSync(instanceDir);
    const leaseFile = fs.readdirSync(path.join(instanceDir, keyDigest))
      .find((name) => name.endsWith(".json"));
    return { stateHome, instanceDir, keyDigest, filePath: path.join(instanceDir, keyDigest, leaseFile) };
  }

  it("refuses an extra unknown field without deleting the record", () => {
    const { root } = setup();
    const { filePath } = acquireOneAndLocateFile(root);
    const before = fs.readFileSync(filePath, "utf8");
    const tampered = { ...JSON.parse(before), extraSecretField: "should-not-be-admitted" };
    fs.writeFileSync(filePath, JSON.stringify(tampered, null, 2) + "\n");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /corrupt/i
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), JSON.stringify(tampered, null, 2) + "\n");
  });

  it("refuses a record whose key text was hand-edited inconsistent with its own key fields (identity drift)", () => {
    const { root } = setup();
    const { filePath } = acquireOneAndLocateFile(root);
    const before = fs.readFileSync(filePath, "utf8");
    const tampered = { ...JSON.parse(before), key: "instance\0fake-service\0tenant-beta\0shared" };
    fs.writeFileSync(filePath, JSON.stringify(tampered, null, 2) + "\n");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /corrupt/i
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), JSON.stringify(tampered, null, 2) + "\n");
  });

  it("refuses a record whose route no longer names the Harness/instance its key fields claim", () => {
    const { root } = setup();
    const { filePath } = acquireOneAndLocateFile(root);
    const before = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(before);
    const tampered = { ...parsed, route: { ...parsed.route, instanceKey: "tenant-beta" } };
    fs.writeFileSync(filePath, JSON.stringify(tampered, null, 2) + "\n");

    assert.throws(
      () => acquireInstanceLease({
        ...binding({ jobId: "job-b", agentId: "agent-2" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 5,
      }),
      /corrupt/i
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), JSON.stringify(tampered, null, 2) + "\n");
  });

  it("refuses a record copied into a directory other than the one its own identity derives", () => {
    const { root } = setup();
    const { instanceDir, filePath } = acquireOneAndLocateFile(root);
    const contents = fs.readFileSync(filePath, "utf8");
    const foreignDir = path.join(instanceDir, "not-the-real-key-digest");
    fs.mkdirSync(foreignDir, { recursive: true, mode: 0o700 });
    const misplacedPath = path.join(foreignDir, path.basename(filePath));
    fs.writeFileSync(misplacedPath, contents);

    // Diagnostics must fail closed on the misplaced copy without disturbing it.
    const inventory = inspectLeaseInventory();
    const unreadable = inventory.entries.find((entry) => entry.keyDigest === "not-the-real-key-digest");
    assert.ok(unreadable, "the misplaced record must be reported, not silently skipped");
    assert.equal(unreadable.unreadable, true);
    assert.equal(unreadable.reasonCode, "identity_drift");
    assert.equal(fs.readFileSync(misplacedPath, "utf8"), contents);
  });

  it("never surfaces a raw file path or exception message through the diagnostics inventory", () => {
    const { root } = setup();
    const { filePath } = acquireOneAndLocateFile(root);
    fs.writeFileSync(filePath, "{not json");

    const inventory = inspectLeaseInventory();
    const serialized = JSON.stringify(inventory);
    assert.ok(!serialized.includes(root), "diagnostics must never echo the local state-home path");
    assert.ok(!serialized.includes(filePath), "diagnostics must never echo the raw lease file path");
    const [entry] = inventory.entries;
    assert.equal(entry.unreadable, true);
    assert.equal(entry.reasonCode, "corrupt_json");
    assert.equal(typeof entry.reasonCode, "string");
  });
});

describe("instance admission lease: settlement-gated batch release (4.3)", () => {
  it("releases every matching lease exactly once for a publishable terminal result", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const sessionBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-x",
    };
    acquireNativeSessionLease(sessionBinding);

    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...instanceBinding },
        { kind: "native_session", ...sessionBinding },
      ],
    });
    assert.equal(outcome.released, true);
    assert.equal(outcome.releasedCount, 2);

    // Idempotent: a reconciliation replay of the exact same call is a safe no-op.
    const replay = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...instanceBinding },
        { kind: "native_session", ...sessionBinding },
      ],
    });
    assert.equal(replay.released, true);
    assert.equal(replay.releasedCount, 0);
    assert.equal(replay.alreadyReleasedCount, 2);

    const admittedAgain = acquireInstanceLease({
      ...instanceBinding, jobId: "job-y", agentId: "agent-y",
    });
    assert.ok(admittedAgain);
  });

  it("states exact partial evidence when one holder cannot be unlinked, and never throws", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-partial" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const sessionBinding = {
      ...binding({ jobId: "job-partial" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-partial",
    };
    acquireNativeSessionLease(sessionBinding);

    // A transient I/O failure on the second holder file only. "The batch
    // threw" would be a false statement that nothing was released: the first
    // holder is already gone by then.
    const realUnlink = fs.unlinkSync;
    let holderUnlinks = 0;
    fs.unlinkSync = function patched(target, ...rest) {
      if (typeof target === "string" && target.includes("/leases/") && target.endsWith(".json")) {
        holderUnlinks += 1;
        if (holderUnlinks === 2) {
          throw Object.assign(new Error("EIO: simulated transient I/O error"), { code: "EIO" });
        }
      }
      return realUnlink.call(this, target, ...rest);
    };
    let outcome;
    try {
      outcome = releaseLeasesOnSettlement({
        normalizedTerminalResult: publishableResult(),
        releases: [
          { kind: "instance", ...instanceBinding },
          { kind: "native_session", ...sessionBinding },
        ],
      });
    } finally {
      fs.unlinkSync = realUnlink;
    }

    assert.equal(outcome.released, false);
    assert.equal(outcome.outcome, "partial");
    assert.equal(outcome.reason, "release_partial");
    assert.equal(outcome.releasedCount, 1);
    assert.equal(outcome.retainedCount, 1);
    assert.equal(outcome.unknownCount, 0);
    assert.deepEqual(outcome.failures, [{ kind: "native_session", code: "EIO", disposition: "retained" }]);

    // The evidence is exact, not merely pessimistic: the released slot really
    // is free, and the retained one really is still held.
    acquireInstanceLease({ ...instanceBinding, jobId: "job-after", agentId: "agent-after" });
    assert.throws(
      () => acquireNativeSessionLease({ ...sessionBinding, jobId: "job-after", agentId: "agent-after" }),
      /capacity exhausted/
    );
  });

  it("reports `all` only when every target is released or already released", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-all" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [{ kind: "instance", ...instanceBinding }],
    });
    assert.equal(outcome.outcome, "all");
    assert.equal(outcome.released, true);
    assert.deepEqual(outcome.failures, []);

    // A gate refusal is `none`: nothing was touched at all.
    const refused = releaseLeasesOnSettlement({
      normalizedTerminalResult: { ...publishableResult(), nativeTurn: "unknown" },
      releases: [{ kind: "instance", ...instanceBinding }],
    });
    assert.equal(refused.outcome, "none");
    assert.equal(refused.released, false);
    assert.equal(refused.releasedCount, 0);
  });

  it("releases one holder of a capacity>1 key and treats a replay as already_released regardless of siblings (F1)", () => {
    setup();
    const holderA = {
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    };
    const holderB = { ...holderA, jobId: "job-b", agentId: "agent-b" };
    acquireInstanceLease(holderA);
    acquireInstanceLease(holderB);

    const first = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [{ kind: "instance", ...holderA }],
    });
    assert.equal(first.released, true);
    assert.equal(first.releasedCount, 1);
    assert.equal(first.alreadyReleasedCount, 0);

    // Replay: holder A's exact file is gone, but sibling holder B still
    // exists in the very same key directory. The exact holderFile digest is
    // the identity -- its absence is "already released", never
    // "held_by_other", independent of any sibling.
    const replay = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [{ kind: "instance", ...holderA }],
    });
    assert.equal(replay.released, true);
    assert.equal(replay.releasedCount, 0);
    assert.equal(replay.alreadyReleasedCount, 1);

    // Holder B's slot is still genuinely occupied: capacity 2 admits exactly
    // one more distinct holder (the freed slot A left), and no further one.
    acquireInstanceLease({ ...holderA, jobId: "job-c", agentId: "agent-c" });
    assert.throws(
      () => acquireInstanceLease({ ...holderA, jobId: "job-d", agentId: "agent-d" }),
      /capacity/i
    );
  });

  it("does not strand a genuinely held second target when a mixed batch replays an already-released capacity>1 holder (F1)", () => {
    setup();
    const holderA = {
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    };
    const holderB = { ...holderA, jobId: "job-b", agentId: "agent-b" };
    acquireInstanceLease(holderA);
    acquireInstanceLease(holderB);
    const sessionBinding = {
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-mixed",
    };
    acquireNativeSessionLease(sessionBinding);

    // First call releases only holder A; B and the session stay held.
    releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [{ kind: "instance", ...holderA }],
    });

    // Second call mixes a replay (holder A, now absent, sibling B remains)
    // with a genuinely first-time release (the session lease). The replay
    // target must never abort the batch and strand the session release.
    const mixed = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...holderA },
        { kind: "native_session", ...sessionBinding },
      ],
    });
    assert.equal(mixed.released, true);
    assert.equal(mixed.releasedCount, 1);
    assert.equal(mixed.alreadyReleasedCount, 1);

    // The session lease was genuinely released, not stranded.
    const sessionReacquired = acquireNativeSessionLease({
      ...sessionBinding, jobId: "job-other", agentId: "agent-other",
    });
    assert.ok(sessionReacquired);
    // Holder B is still genuinely held: capacity 2 admits exactly one more.
    acquireInstanceLease({ ...holderA, jobId: "job-c", agentId: "agent-c" });
    assert.throws(
      () => acquireInstanceLease({ ...holderA, jobId: "job-d", agentId: "agent-d" }),
      /capacity/i
    );
  });

  it("de-duplicates an identical target presented twice in one batch, releasing it exactly once (F2)", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);

    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...instanceBinding },
        { kind: "instance", ...instanceBinding }, // exact duplicate target
      ],
    });
    assert.equal(outcome.released, true);
    assert.equal(outcome.releasedCount, 1);
    assert.equal(outcome.alreadyReleasedCount, 0);

    const reacquired = acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" });
    assert.ok(reacquired);
  });

  it("releases multiple distinct targets in the same key directory independently (F2)", () => {
    setup();
    const holderA = {
      ...binding({ jobId: "job-a" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 2,
    };
    const holderB = { ...holderA, jobId: "job-b", agentId: "agent-b" };
    acquireInstanceLease(holderA);
    acquireInstanceLease(holderB);

    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...holderA },
        { kind: "instance", ...holderB },
      ],
    });
    assert.equal(outcome.released, true);
    assert.equal(outcome.releasedCount, 2);
    assert.equal(outcome.alreadyReleasedCount, 0);

    // Both slots are free again.
    acquireInstanceLease({ ...holderA, jobId: "job-c", agentId: "agent-c" });
    acquireInstanceLease({ ...holderA, jobId: "job-d", agentId: "agent-d" });
    assert.throws(
      () => acquireInstanceLease({ ...holderA, jobId: "job-e", agentId: "agent-e" }),
      /capacity/i
    );
  });

  for (const [label, foreignField, foreignValue] of [
    ["Harness", "harnessId", "claude-code"],
    ["instance", "instanceKey", "tenant-beta"],
    ["driver version", "driverVersion", "fake-service@2"],
  ]) {
    it(`retains all leases in a batch when the native turn reference names a foreign ${label} (F5)`, () => {
      setup();
      const instanceBinding = {
        ...binding({ jobId: "job-x" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      };
      acquireInstanceLease(instanceBinding);
      const sessionBinding = {
        ...binding({ jobId: "job-x" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        nativeSessionId: "native-session-x",
      };
      acquireNativeSessionLease(sessionBinding);

      const outcome = releaseLeasesOnSettlement({
        normalizedTerminalResult: publishableResult({
          nativeTurnRef: {
            version: 1,
            harnessId: "fake-service",
            driverVersion: "fake-service@1",
            instanceKey: "tenant-alpha",
            locatorVersion: 1,
            locator: { turnId: "t-1" },
            [foreignField]: foreignValue,
          },
        }),
        releases: [
          { kind: "instance", ...instanceBinding },
          { kind: "native_session", ...sessionBinding },
        ],
      });
      assert.equal(outcome.released, false);
      assert.equal(outcome.reason, "native_reference_route_mismatch");
      // The receipt states how many leases are still held. A whole-batch
      // retention that reported `retainedCount: 0` would say nothing was
      // released *and* nothing retained, which states no disposition at all
      // for leases that are, in fact, still held.
      assert.equal(outcome.outcome, "none");
      assert.equal(outcome.retainedCount, 2);
      assert.equal(outcome.releasedCount, 0);
      assert.equal(outcome.alreadyReleasedCount, 0);

      // Neither lease was released -- not even the ones whose own route
      // happens to still agree with the mismatched field.
      assert.throws(
        () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
        /capacity/i
      );
      assert.throws(
        () => acquireNativeSessionLease({ ...sessionBinding, jobId: "job-y", agentId: "agent-y" }),
        /capacity/i
      );
    });
  }

  it("retains every affected lease on worker loss (no evidence at all)", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: null,
      releases: [{ kind: "instance", ...instanceBinding }],
    });
    assert.equal(outcome.released, false);
    assert.equal(outcome.reason, "no_evidence");
    assert.throws(
      () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
      /capacity/i
    );
  });

  for (const [label, overrides] of [
    ["failed observation (native turn unknown)", { nativeTurn: "unknown" }],
    ["active native turn", { nativeTurn: "active" }],
    ["active execution settlement", { executionWorld: { continuity: "preserved", settlement: "active" } }],
    ["unknown execution settlement", { executionWorld: { continuity: "unknown", settlement: "unknown" } }],
    ["contradictory terminal evidence", { status: "completed", nativeTurn: "active" }],
  ]) {
    it(`retains every affected lease for: ${label}`, () => {
      setup();
      const instanceBinding = {
        ...binding({ jobId: "job-x" }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit: 1,
      };
      acquireInstanceLease(instanceBinding);
      const outcome = releaseLeasesOnSettlement({
        normalizedTerminalResult: publishableResult(overrides),
        releases: [{ kind: "instance", ...instanceBinding }],
      });
      assert.equal(outcome.released, false);
      // The count of leases still held is stated, never left at zero.
      assert.equal(outcome.retainedCount, 1);
      assert.equal(outcome.releasedCount, 0);
      assert.throws(
        () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
        /capacity/i
      );
    });
  }

  it("retains leases when the native turn reference declares an unrecognized envelope version", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult({
        nativeTurnRef: {
          version: 99, // core-owned envelope version, structurally unrecognized
          harnessId: "fake-service",
          driverVersion: "fake-service@1",
          instanceKey: "tenant-alpha",
          locatorVersion: 1,
          locator: { turnId: "t-1" },
        },
      }),
      releases: [{ kind: "instance", ...instanceBinding }],
    });
    assert.equal(outcome.released, false);
    assert.equal(outcome.reason, "unrecognized_native_reference_envelope");
    assert.throws(
      () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
      /capacity/i
    );
  });

  it("presents a foreign identity in a batch as a harmless no-op, never a cross-identity release", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const sessionBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-x",
    };
    acquireNativeSessionLease(sessionBinding);

    const outcome = releaseLeasesOnSettlement({
      normalizedTerminalResult: publishableResult(),
      releases: [
        { kind: "instance", ...instanceBinding },
        { kind: "native_session", ...sessionBinding, agentId: "agent-intruder" },
      ],
    });
    // The genuine instance target releases; the intruder-identity target
    // resolves to a file that never existed, so it is an honest no-op --
    // never a cross-identity mutation of the real session holder.
    assert.equal(outcome.released, true);
    assert.equal(outcome.releasedCount, 1);
    assert.equal(outcome.alreadyReleasedCount, 1);
    // The instance slot is now free: acquiring it again must succeed.
    const reacquired = acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" });
    assert.equal(reacquired.jobId, "job-y");
    // The real session holder was never touched by the intruder's target.
    assert.throws(
      () => acquireNativeSessionLease({ ...sessionBinding, jobId: "job-y", agentId: "agent-y" }),
      /capacity/i
    );
  });

  it("does not partially release a batch when one target's record is corrupt", () => {
    const { root } = setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    const sessionBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      nativeSessionId: "native-session-x",
    };
    acquireNativeSessionLease(sessionBinding);

    const stateHome = path.join(root, "state-home");
    const sessionDir = path.join(stateHome, "state", "leases", "v1", "native_session");
    const [keyDigest] = fs.readdirSync(sessionDir);
    const [leaseFile] = fs.readdirSync(path.join(sessionDir, keyDigest)).filter((name) => name.endsWith(".json"));
    const corruptPath = path.join(sessionDir, keyDigest, leaseFile);
    fs.writeFileSync(corruptPath, "{not json");

    assert.throws(
      () => releaseLeasesOnSettlement({
        normalizedTerminalResult: publishableResult(),
        releases: [
          { kind: "instance", ...instanceBinding },
          { kind: "native_session", ...sessionBinding },
        ],
      }),
      /corrupt/i
    );

    // Neither lease was released: the valid instance target stayed held too,
    // and the corrupt session record was never deleted to make room.
    assert.throws(
      () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
      /capacity/i
    );
    assert.equal(fs.readFileSync(corruptPath, "utf8"), "{not json");
  });

  it("refuses a release target whose key Harness/instance does not match its route", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    };
    acquireInstanceLease(instanceBinding);
    assert.throws(
      () => releaseOne({
        kind: "instance",
        ...instanceBinding,
        harnessId: "claude-code", // release target key no longer matches the acquired route
      }),
      /does not match its bound route/i
    );
    // The lease is untouched: the mismatch was refused before any lock/mutation.
    assert.throws(
      () => acquireInstanceLease({ ...instanceBinding, jobId: "job-y", agentId: "agent-y" }),
      /capacity/i
    );
  });
});

describe("instance admission lease: hard-reclaim exact disposition", () => {
  it("reuses the validated holder-plan seam and reports every released, already-released, or ambiguous target", () => {
    setup();
    const instanceBinding = {
      ...binding({ jobId: "job-hard" }), harnessId: "fake-service", instanceKey: "tenant-alpha",
      capacityClass: "shared", capacityLimit: 1,
    };
    const sessionBinding = {
      ...binding({ jobId: "job-hard" }), harnessId: "fake-service", instanceKey: "tenant-alpha",
      nativeSessionId: "native-hard",
    };
    acquireInstanceLease(instanceBinding);
    acquireNativeSessionLease(sessionBinding);
    const releases = [
      { kind: "instance", ...instanceBinding },
      { kind: "native_session", ...sessionBinding },
    ];
    const first = releaseExactLeasesForHardReclaim({ releases });
    assert.equal(first.outcome, "all");
    assert.deepEqual(first.dispositions.map(({ kind, disposition }) => ({ kind, disposition })), [
      { kind: "instance", disposition: "released" },
      { kind: "native_session", disposition: "released" },
    ]);
    const replay = releaseExactLeasesForHardReclaim({ releases });
    assert.deepEqual(replay.dispositions.map(({ kind, disposition }) => ({ kind, disposition })), [
      { kind: "instance", disposition: "already_released" },
      { kind: "native_session", disposition: "already_released" },
    ]);

    acquireNativeSessionLease(sessionBinding);
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = function patched(file, ...args) {
      if (typeof file === "string" && file.includes("/leases/") && file.endsWith(".json")) {
        throw Object.assign(new Error("simulated ambiguity"), { code: "EIO" });
      }
      return realUnlink.call(this, file, ...args);
    };
    let ambiguous;
    try {
      ambiguous = releaseExactLeasesForHardReclaim({ releases: [{ kind: "native_session", ...sessionBinding }] });
    } finally {
      fs.unlinkSync = realUnlink;
    }
    assert.equal(ambiguous.outcome, "none");
    assert.deepEqual(ambiguous.dispositions, [{ kind: "native_session", disposition: "retained", code: "EIO" }]);
  });
});

describe("instance admission lease: read-only diagnostics inventory (4.4)", () => {
  it("lists blocked leases with bounded non-secret evidence and no mutation", () => {
    setup();
    acquireInstanceLease({
      ...binding({ jobId: "job-x" }),
      harnessId: "fake-service",
      instanceKey: "tenant-alpha",
      capacityClass: "shared",
      capacityLimit: 1,
    });
    const inventory = inspectLeaseInventory();
    assert.equal(inventory.total, 1);
    assert.equal(inventory.blockedTotal, 1);
    assert.equal(inventory.truncated, false);
    assert.equal(inventory.entries.length, 1);
    const [entry] = inventory.entries;
    assert.equal(entry.kind, "instance");
    assert.equal(entry.holderCount, 1);
    assert.equal(entry.capacityLimit, 1);
    assert.equal(entry.capacityClass, "shared");
    assert.equal(entry.atCapacity, true);
    assert.equal(entry.holdersTruncated, false);
    assert.equal(entry.evidenceClassNeeded, "native_terminal_and_settled_execution_evidence");
    assert.ok(Array.isArray(entry.holders));
    const [holder] = entry.holders;
    assert.equal(holder.ownerRootId, "root-1");
    assert.equal(holder.agentId, "agent-1");
    assert.equal(holder.jobId, "job-x");
    assert.equal(holder.harnessId, "fake-service");
    assert.equal(holder.instanceKey, "tenant-alpha");
    assert.equal(holder.model, "fake-service-large");
    assert.equal(holder.topology, "leaf");
    assert.equal(holder.authority, "behavioral_read_only");
    assert.equal(holder.capabilities, undefined, "diagnostics never project the full capability snapshot");
    assert.equal(holder.token, undefined);
    assert.equal(holder.secret, undefined);
  });

  it("returns an empty inventory without creating any lease directory", () => {
    const { root } = setup();
    const inventory = inspectLeaseInventory();
    assert.deepEqual(inventory.entries, []);
    assert.equal(inventory.total, 0);
    assert.equal(inventory.blockedTotal, 0);
    assert.equal(inventory.truncated, false);
    assert.equal(fs.existsSync(path.join(root, "state-home", "leases")), false);
  });

  it("sorts entries deterministically and returns the same order across repeated calls (F3)", () => {
    setup();
    for (const instanceKey of ["tenant-charlie", "tenant-alpha", "tenant-bravo"]) {
      acquireInstanceLease({
        ...binding({ jobId: `job-${instanceKey}`, route: versionThreeRoute({ harnessId: "fake-service", instanceKey }) }),
        harnessId: "fake-service",
        instanceKey,
        capacityClass: "shared",
        capacityLimit: 1,
      });
    }
    const first = inspectLeaseInventory();
    const second = inspectLeaseInventory();
    assert.deepEqual(
      first.entries.map((entry) => entry.keyFields.instanceKey),
      second.entries.map((entry) => entry.keyFields.instanceKey)
    );
    // Deterministic sort order, not directory-listing order.
    assert.deepEqual(
      first.entries.map((entry) => entry.keyFields.instanceKey),
      [...first.entries.map((entry) => entry.keyFields.instanceKey)].sort()
    );
  });

  it("caps the number of displayed entries and reports a truthful total/truncated flag beyond the cap (F3)", () => {
    setup();
    const overCap = MAX_INVENTORY_ENTRIES + 5;
    for (let index = 0; index < overCap; index += 1) {
      const instanceKey = `tenant-${String(index).padStart(4, "0")}`;
      acquireInstanceLease({
        ...binding({
          jobId: `job-${index}`,
          route: versionThreeRoute({ harnessId: "fake-service", instanceKey }),
        }),
        harnessId: "fake-service",
        instanceKey,
        capacityClass: "shared",
        capacityLimit: 1,
      });
    }
    const inventory = inspectLeaseInventory();
    assert.equal(inventory.total, overCap);
    assert.equal(inventory.blockedTotal, overCap);
    assert.equal(inventory.entries.length, MAX_INVENTORY_ENTRIES);
    assert.equal(inventory.truncated, true);
  });

  it("caps the per-entry holder sample while keeping the true holderCount for capacity=64 (F3)", () => {
    setup();
    const capacityLimit = 64;
    for (let index = 0; index < capacityLimit; index += 1) {
      acquireInstanceLease({
        ...binding({ jobId: `job-${index}`, agentId: `agent-${index}` }),
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        capacityClass: "shared",
        capacityLimit,
      });
    }
    const inventory = inspectLeaseInventory();
    assert.equal(inventory.total, 1);
    const [entry] = inventory.entries;
    assert.equal(entry.holderCount, capacityLimit);
    assert.equal(entry.atCapacity, true);
    assert.ok(entry.holders.length <= MAX_HOLDERS_PER_ENTRY);
    assert.equal(entry.holdersTruncated, true);
  });
});

describe("lease acquisition evidence: brand-gated, exact-object-identity seam (Task 5.3 correction)", () => {
  it("returns the canonical stable projection for a real instance acquire", () => {
    setup();
    const record = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    const evidence = acquiredLeaseEvidence(record);
    assert.deepEqual(Object.keys(evidence).sort(), [...LEASE_ACQUISITION_EVIDENCE_FIELDS].sort());
    assert.equal(evidence.kind, "instance");
    assert.equal(evidence.ownerRootId, "root-1");
    assert.equal(evidence.agentId, "agent-1");
    assert.equal(evidence.jobId, "job-1");
    assert.deepEqual(evidence.route, versionThreeRoute());
    assert.deepEqual(evidence.capacity, { class: "default", limit: 4 });
    assert.deepEqual(evidence.keyFields, { harnessId: "fake-service", instanceKey: "tenant-alpha" });
  });

  it("returns the canonical stable projection for a real native_session acquire", () => {
    setup();
    const record = acquireNativeSessionLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", nativeSessionId: "session-1",
    });
    const evidence = acquiredLeaseEvidence(record);
    assert.equal(evidence.kind, "native_session");
    assert.deepEqual(evidence.keyFields, {
      harnessId: "fake-service", instanceKey: "tenant-alpha", nativeSessionId: "session-1",
    });
  });

  it("excludes createdAt/updatedAt from the projection entirely", () => {
    setup();
    const record = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    const evidence = acquiredLeaseEvidence(record);
    assert.equal("createdAt" in evidence, false);
    assert.equal("updatedAt" in evidence, false);
  });

  it("is byte-identical across an idempotent re-acquire of the same real lease, even though the returned object is a new reference", () => {
    setup();
    const first = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    const second = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    assert.notEqual(first, second, "expected a freshly re-validated object reference, not the identical one");
    assert.deepEqual(acquiredLeaseEvidence(first), acquiredLeaseEvidence(second));
  });

  it("REVIEWER ATTACK -- rejects a structurally identical clone of a real record (same field values, different object reference)", () => {
    setup();
    const record = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    const clone = JSON.parse(JSON.stringify(record));
    assert.throws(() => acquiredLeaseEvidence(clone), /exact object reference/);
  });

  it("REVIEWER ATTACK -- rejects a Proxy wrapping a genuinely branded record, invoking zero traps", () => {
    setup();
    const record = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    let trapped = false;
    const proxy = new Proxy(record, {
      get(target, property, receiver) { trapped = true; return Reflect.get(target, property, receiver); },
      has(target, property) { trapped = true; return Reflect.has(target, property); },
    });
    assert.throws(() => acquiredLeaseEvidence(proxy), /exact object reference/);
    assert.equal(trapped, false, "WeakMap key lookup must never invoke a Proxy get/has trap");
  });

  it("REVIEWER ATTACK -- rejects a same-identity forged object stating the exact correct kind/identity/route, that was never really returned by acquireLease", () => {
    setup();
    const real = acquireInstanceLease({
      ...binding(), harnessId: "fake-service", instanceKey: "tenant-alpha", capacityClass: "default", capacityLimit: 4,
    });
    const evidence = acquiredLeaseEvidence(real);
    // A hand-built object with the exact same evidence shape/values, but
    // never returned by a real acquire call -- proves matching content is
    // not sufficient, only the exact branded object reference is.
    const forged = { ...evidence };
    assert.throws(() => acquiredLeaseEvidence(forged), /exact object reference/);
  });

  it("rejects a plain never-acquired object, null, and a primitive, identically", () => {
    setup();
    assert.throws(() => acquiredLeaseEvidence({ kind: "instance" }), /exact object reference/);
    assert.throws(() => acquiredLeaseEvidence(null), /exact object reference/);
    assert.throws(() => acquiredLeaseEvidence("not-an-object"), /exact object reference/);
  });
});
