/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Canonical-workspace behavioral writer lease.
 *
 * `specs/workspace-turn-authority/spec.md` requires at most one behavioral
 * writer per canonical workspace root, regardless of which Harness, logical
 * instance, or model holds it. `runtime/instance-admission-lease.mjs` already
 * owns the writer kind's schema, key derivation, capacity (fixed at one), and
 * settlement-gated release; this module is the thin, ergonomic, kind-specific
 * entry point Task 5's launch/admission seam is expected to call.
 *
 * There is deliberately no exported release function here beyond the
 * re-exported settlement-gated `releaseLeasesOnSettlement()`: a writer lease
 * is filesystem-adjacent but not filesystem containment, and its release must
 * always be proven by the same native-terminal-plus-settled-execution
 * predicate every other lease kind uses -- exact caller identity alone is
 * never sufficient release authority (see `instance-admission-lease.mjs`).
 *
 * Read-only turns never call this module at all: `acquireLease()` requires a
 * `behavioral_write` route for the `writer` kind, so a read-only Agent's
 * turn cannot even construct a writer lease by mistake. A read-only turn that
 * needs admission acquires only the instance/native-session leases its own
 * route requires, from `instance-admission-lease.mjs` directly, and that
 * admission is independent of -- never blocked by, and never blocking -- a
 * concurrent writer on the same workspace.
 */

import { acquireLease, releaseLeasesOnSettlement } from "./instance-admission-lease.mjs";

/**
 * Acquire the one behavioral writer lease for a canonical workspace root.
 * `workspaceRoot` is canonicalized (realpath) before it becomes the lease
 * key, so distinct operator-prepared worktrees never collide and symlink
 * aliases of the same worktree always do. The Plugin does not create or
 * merge worktrees; the caller must already have one to admit against.
 *
 * @param {{ownerRootId: string, agentId: string, jobId: string, route: *, workspaceRoot: string}} input
 */
export function acquireWorkspaceWriterLease({ ownerRootId, agentId, jobId, route, workspaceRoot }) {
  return acquireLease({
    kind: "writer",
    ownerRootId,
    agentId,
    jobId,
    route,
    workspaceRoot,
    capacityLimit: 1,
  });
}

/** Acquire the writer holder only while its exact durable launch intent is rollback-safe. */
export function acquireIntendedWorkspaceWriterLease({
  ownerRootId, agentId, jobId, attemptId, route, workspaceRoot,
}) {
  return acquireLease({
    kind: "writer",
    ownerRootId,
    agentId,
    jobId,
    route,
    workspaceRoot,
    capacityLimit: 1,
    launchAttemptId: attemptId,
  });
}

export { releaseLeasesOnSettlement };
