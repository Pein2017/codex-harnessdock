/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The accepted stale-lock recovery discipline for owner-only durable
 * directories.
 *
 * Every durable directory in this runtime is guarded by a `link()`-based lock
 * whose holder writes its own PID plus a start-time identity. Reclaiming such a
 * lock is the only place that discipline can go wrong, and it can go wrong in
 * two independent ways:
 *
 *   1. **Time of check to time of use.** Deciding a lock is stale requires
 *      reading it and probing its holder -- both syscalls. A different process
 *      can legitimately acquire the lock inside that window, and unlinking
 *      afterwards would delete *its* lock, leaving two live holders of a lock
 *      that exists to serialize read-modify-write persistence. The reclaim is
 *      therefore conditional on the lock file still being the exact same inode
 *      that was inspected.
 *
 *   2. **A transient identity probe failure.** `validateProcessIdentity()`
 *      returns `false` for a genuinely foreign holder *and* for a momentary
 *      failure to read the holder's start time. A live holder must not lose its
 *      lock to the second case, so a lock whose owner is alive is left alone
 *      until it is older than the transient-probe grace.
 *
 * `turn-control.mjs`, `launch-claim.mjs`, and `instance-admission-lease.mjs`
 * each carry a byte-identical private copy of this logic. This module is the
 * one place it is stated so that a newer durable store adopts the exact
 * accepted discipline rather than an approximation of it; those three keep
 * their own copies until a change that owns them can adopt this without
 * unrelated churn.
 */

import fs from "node:fs";

import { isProcessAlive, validateProcessIdentity } from "./process-control.mjs";

/**
 * How long a lock whose holder is alive but whose identity could not be
 * confirmed is left alone. Shorter than any lock is legitimately held for, and
 * long enough that a momentary probe failure is not fatal.
 */
export const LOCK_IDENTITY_FAILURE_GRACE_MS = 1_000;

/** Whether two `fs.Stats` name the exact same file, not merely the same path. */
export function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

/**
 * Reclaim one lock file whose holder is provably gone, or leave it exactly as
 * it is.
 *
 * @param {string} lockFile
 * @param {{now?: () => number, isProcessAlive?: (pid: number) => boolean,
 *   validateProcessIdentity?: (pid: number, identity: *) => boolean}} [deps]
 *   Ordinary dependency-injection seams, in the same style as
 *   `waitForDurableActivity()`'s `watch`/`setTimeout` and
 *   `getProcessIdentity()`'s `platform`/`runCommandCheckedImpl`. The identity
 *   probe is the widest syscall in the check-to-unlink window, so injecting it
 *   is how a test can place a competing acquisition inside that exact window.
 * @returns {boolean} whether this call removed the lock file
 */
export function recoverStaleDirectoryLock(lockFile, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const aliveProbe = deps.isProcessAlive ?? isProcessAlive;
  const identityProbe = deps.validateProcessIdentity ?? validateProcessIdentity;
  if (!fs.existsSync(lockFile)) return false;
  let observedStat = null;
  try {
    observedStat = fs.statSync(lockFile);
    const lockData = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const ageMs = now() - Number(lockData.timestamp ?? observedStat.mtimeMs);
    const ownerPid = Number(lockData.pid);
    const ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0 && aliveProbe(ownerPid);
    const ownerMatch = lockData.identity != null && identityProbe(ownerPid, lockData.identity);
    const transientProbeGrace = ownerAlive && Number.isFinite(ageMs) && ageMs <= LOCK_IDENTITY_FAILURE_GRACE_MS;
    if ((ownerAlive && ownerMatch) || transientProbeGrace) return false;
  } catch { /* fall through to reclaim */ }
  try {
    // The whole point: only unlink the exact file that was inspected. A lock
    // another process acquired during the probe above is a different inode and
    // is left to its own owner.
    const currentStat = fs.statSync(lockFile);
    if (observedStat && !sameFileIdentity(observedStat, currentStat)) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}
