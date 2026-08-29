import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  LOCK_IDENTITY_FAILURE_GRACE_MS,
  recoverStaleDirectoryLock,
  sameFileIdentity,
} from "../../runtime/durable-directory-lock.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-durable-lock-"));

/** A genuinely alive process to name as a lock holder. */
let holder = null;

before(async () => {
  holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 150));
});

after(() => {
  holder?.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;

/** One lock file, written exactly as `acquireDirectoryLock()` writes them. */
function plantLock({ pid, identity, timestamp = Date.now() }) {
  sequence += 1;
  const directory = path.join(root, `lock-${sequence}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, ".lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid, identity, token: `token-${sequence}`, timestamp }), "utf8");
  return lockFile;
}

/** A PID that is provably not running. */
function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  return new Promise((resolve) => child.on("close", () => resolve(child.pid)));
}

describe("durable directory lock: stale recovery", () => {
  it("leaves a lock whose holder identity still matches", () => {
    const lockFile = plantLock({ pid: holder.pid, identity: "matching-identity" });
    const reclaimed = recoverStaleDirectoryLock(lockFile, {
      validateProcessIdentity: () => true,
    });
    assert.equal(reclaimed, false);
    assert.ok(fs.existsSync(lockFile), "a matching live holder must keep its lock");
  });

  it("reclaims an exact former holder that is no longer live", () => {
    const lockFile = plantLock({ pid: holder.pid, identity: "matching-but-dead" });
    const reclaimed = recoverStaleDirectoryLock(lockFile, {
      isProcessAlive: () => false,
      validateProcessIdentity: () => true,
    });
    assert.equal(reclaimed, true);
    assert.equal(fs.existsSync(lockFile), false);
  });

  it("leaves a live holder's lock alone while its identity probe may be transient", () => {
    // The exact production hazard: `validateProcessIdentity()` returns false
    // both for a foreign holder and for a momentary failure to read the
    // holder's start time. A live holder must not lose its lock to the second.
    const lockFile = plantLock({ pid: holder.pid, identity: "unreadable-identity" });
    const reclaimed = recoverStaleDirectoryLock(lockFile);
    assert.equal(reclaimed, false);
    assert.ok(fs.existsSync(lockFile), "a live holder must survive one failed identity probe");
  });

  it("reclaims a live holder's lock only once the transient-probe grace has passed", () => {
    const timestamp = Date.now();
    const lockFile = plantLock({ pid: holder.pid, identity: "unreadable-identity", timestamp });
    assert.equal(
      recoverStaleDirectoryLock(lockFile, { now: () => timestamp + LOCK_IDENTITY_FAILURE_GRACE_MS }),
      false,
      "the grace boundary is inclusive"
    );
    assert.equal(
      recoverStaleDirectoryLock(lockFile, { now: () => timestamp + LOCK_IDENTITY_FAILURE_GRACE_MS + 1 }),
      true
    );
    assert.equal(fs.existsSync(lockFile), false);
  });

  it("reclaims a lock whose holder process is gone", async () => {
    const lockFile = plantLock({ pid: await deadPid(), identity: "whatever" });
    assert.equal(recoverStaleDirectoryLock(lockFile), true);
    assert.equal(fs.existsSync(lockFile), false);
  });

  it("leaves a lock a competing process acquired during the identity probe", async () => {
    // The check-to-unlink window, made deterministic: the identity probe is the
    // widest syscall between reading the lock and unlinking it, so a competing
    // acquisition is placed inside that exact call. Without the same-file
    // re-stat this reclaim would delete the *winner's* lock and produce two
    // live holders of a lock that exists to serialize durable writes.
    const stale = await deadPid();
    const lockFile = plantLock({ pid: stale, identity: "stale-identity" });
    const before = fs.statSync(lockFile);
    let competitorStat = null;

    const reclaimed = recoverStaleDirectoryLock(lockFile, {
      validateProcessIdentity: () => {
        // Exactly how `acquireDirectoryLock()` wins: the candidate file is
        // created (and holds its own inode) *before* the stale lock is
        // unlinked, then hard-linked onto the lock path. That ordering is what
        // makes the winner's inode necessarily distinct from the stale one, so
        // this simulation cannot pass by accidental inode reuse either.
        const candidate = `${lockFile}.winner.candidate`;
        fs.writeFileSync(
          candidate,
          JSON.stringify({ pid: holder.pid, identity: "winner", token: "winner", timestamp: Date.now() }),
          "utf8"
        );
        fs.unlinkSync(lockFile);
        fs.linkSync(candidate, lockFile);
        fs.unlinkSync(candidate);
        competitorStat = fs.statSync(lockFile);
        return false;
      },
    });

    assert.equal(reclaimed, false, "a lock acquired during the probe must not be reclaimed");
    assert.ok(fs.existsSync(lockFile), "the competing acquirer keeps its lock");
    assert.equal(sameFileIdentity(before, competitorStat), false, "the test must have swapped the inode");
    assert.equal(
      sameFileIdentity(fs.statSync(lockFile), competitorStat),
      true,
      "the surviving lock must be the competing acquirer's, untouched"
    );
  });

  it("reclaims an unreadable lock record rather than blocking forever", () => {
    sequence += 1;
    const directory = path.join(root, `lock-corrupt-${sequence}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockFile = path.join(directory, ".lock");
    fs.writeFileSync(lockFile, "{ not json", "utf8");
    assert.equal(recoverStaleDirectoryLock(lockFile), true);
    assert.equal(fs.existsSync(lockFile), false);
  });

  it("reports no reclaim for a lock that does not exist", () => {
    assert.equal(recoverStaleDirectoryLock(path.join(root, "absent", ".lock")), false);
  });
});
