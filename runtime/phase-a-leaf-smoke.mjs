/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 8.3: one explicitly authorized real Claude Code read-only leaf smoke.
 *
 * This module owns nothing new about the lifecycle. It composes exactly the
 * production seams the dependent multi-Harness generation already owns -- the
 * static Driver Contract v2 registry, the real `claude-code` Driver, the real
 * job supervisor session behind it, the durable Agent store, the instance
 * admission lease, the replay-safe launch claim, the version-three worker
 * loop, and the completion inbox -- around one disposable Git workspace and
 * one temporary runtime home, and reports only bounded lifecycle and mutation
 * facts.
 *
 * Four boundaries are deliberate and load-bearing:
 *
 *   1. It is one-shot, and the fence that makes it one-shot is mandatory. A
 *      caller-supplied durable fence file is created atomically, before any
 *      Driver inspection or durable state exists; an already-present fence
 *      refuses the run outright. Exactly one worker loop is ever started, the
 *      production supervisor's bounded reconnect is pinned to zero so a
 *      resumable transport close can never spawn a second billed process, and
 *      nothing here retries, resumes, or replays. A second real call is the
 *      operator's own explicitly authorized decision, never this runner's.
 *   2. It never claims terminal success it did not prove. `verified`,
 *      `auth_or_quota_stopped`, `unverified`, and `preflight_rejected` are
 *      four different outcomes, and only the first means the leaf turn was
 *      observed end to end. Once the fence is consumed, the receipt always
 *      says that no further real call may reuse this attempt.
 *   3. It leaves nothing running and nothing changed. A turn that outlives its
 *      deadline is cancelled through the existing exact-process internal
 *      recovery path against this attempt's own durable child identity, and
 *      both the disposable workspace and the source checkout are gated on an
 *      exact content inventory rather than on status text.
 *   4. Its receipt is closed. No prompt, transcript, stdout/stderr, path,
 *      credential or configuration location, session identity, process
 *      identity, native locator, token payload, or free-text failure reason
 *      may leave this module -- only closed booleans, closed enums, fixed
 *      route facts, bounded counts, and bounded basenames of anything that
 *      was mutated.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalAgentWorkspaceRoot, createAgentStore } from "./agent-store.mjs";
import { CLAUDE_CODE_HARNESS_ID } from "./claude-code-driver.mjs";
import { cancelClaudeProcess } from "./claude-headless-adapter.mjs";
import { readUnreadCompletionEvents } from "./completion-inbox.mjs";
import { FUTURE_WRITE_GENERATION } from "./durable-state-v3.mjs";
import { resolveRuntimeEnvironment } from "./environment.mjs";
import { createExecutionProfile } from "./execution-profile.mjs";
import { ROUTE_CAPABILITY_SCHEMA_VERSION } from "./harness-capabilities.mjs";
import {
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
  resolveDriverV2,
} from "./harness-registry.mjs";
import { acquireInstanceLease } from "./instance-admission-lease.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, writeJobFile } from "./job-store.mjs";
import { runClaudeTaskSession } from "./job-supervisor.mjs";
import {
  bindLaunchClaimLease,
  createLaunchIntent,
  readLaunchClaim,
} from "./launch-claim.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { validateProcessIdentity } from "./process-control.mjs";
import { runVersionThreeWorkerLoop } from "./v3-worker-loop.mjs";
import { rollbackPreparedVersionThreeTurn } from "./v3-worker-entry.mjs";
import { SOURCE_ROOT } from "./version.mjs";
import {
  MAX_WITNESS_BASENAME_CHARS,
  MAX_WITNESS_REPORTED_BASENAMES,
  MAX_WITNESS_SNAPSHOT_PATHS,
  boundedWorkspaceBasenames as boundedBasenames,
  changedWorkspacePaths as changedPaths,
  snapshotWorkspaceState as snapshotWorkspace,
} from "./workspace-mutation-witness.mjs";

/** The exact route this smoke is authorized for. Nothing here is an option. */
export const PHASE_A_MODEL = "claude-haiku-4-5";
export const PHASE_A_EFFORT = "low";
export const PHASE_A_DELEGATION_MODE = "leaf";
export const PHASE_A_TOPOLOGY = "leaf";
export const PHASE_A_AUTHORITY = "behavioral_read_only";
export const PHASE_A_WRITE = false;

/** The fixed terminal marker the leaf turn must return, and nothing else. */
export const PHASE_A_MARKER = "HARNESSDOCK_PHASE_A_LEAF_OK";

/** The four outcomes this smoke can honestly report. */
export const PHASE_A_STATUSES = Object.freeze([
  "verified",
  "auth_or_quota_stopped",
  "unverified",
  "preflight_rejected",
]);

/** The closed failure vocabulary. A receipt never carries free text instead. */
export const PHASE_A_FAILURE_CLASSES = Object.freeze([
  "none",
  "preflight_not_authorized",
  "preflight_fence_required",
  "preflight_fence_path_invalid",
  "preflight_fence_present",
  "preflight_fence_unavailable",
  "workspace_setup_failed",
  "source_inventory_unavailable",
  "driver_unready",
  "route_rejected",
  "durable_setup_failed",
  "auth_or_quota",
  "launch_not_submitted",
  "launch_ambiguous",
  "turn_failed",
  "turn_timeout",
  "timeout_cleanup_failed",
  "settlement_unknown",
  "publication_missing",
  "marker_absent",
  "workspace_mutated",
  "source_mutated",
  "internal_error",
]);

/**
 * The closed outcome of this runner's own exact-process cleanup. It is
 * separately classified internal recovery against one durable child identity,
 * never a graceful interrupt and never evidence of terminal settlement.
 *
 *   not_needed    the turn did not time out, or its exact child was already
 *                 gone (its durable identity no longer matches that PID)
 *   cancelled     the exact child was signalled and proven gone afterwards
 *   not_available no exact durable child identity could be resolved
 *   failed        an exact identity existed and the child could not be proven
 *                 gone
 */
export const PHASE_A_CLEANUP_OUTCOMES = Object.freeze([
  "not_needed",
  "cancelled",
  "not_available",
  "failed",
]);

/** The two Driver-observed failure classes that must stop further real calls. */
const ACCOUNT_FAILURE_CLASSES = Object.freeze(["auth_or_permission", "usage_or_subscription_limit"]);

/** Host readiness detail codes that are account evidence rather than a defect. */
const ACCOUNT_DETAIL_CODES = Object.freeze(["not_authenticated"]);

const PHASE_A_CAPACITY_CLASS = "phase-a-leaf-smoke";
const PHASE_A_JOB_KIND = "phase_a_leaf_smoke";
const DEFAULT_MAX_MS = 30 * 60 * 1000;
const MAX_SOURCE_INVENTORY_PATHS = 50_000;
const MAX_SOURCE_INVENTORY_BYTES = 512 * 1024 * 1024;
const CLEANUP_PROOF_TIMEOUT_MS = 5_000;
const CLEANUP_PROOF_INTERVAL_MS = 50;

/** The synthetic inventory entry that carries the index/worktree status text. */
const SOURCE_STATUS_ENTRY = "git-status";

/**
 * The leaf task. It performs one read-only observation with an ordinary tool
 * and returns one fixed marker, so a completed turn is evidence of a real
 * native round trip without asking Claude to produce anything of its own.
 */
const PHASE_A_PROMPT = [
  "Run the shell command `pwd` exactly once to observe this workspace's current directory.",
  "Create, modify, and delete nothing; do not delegate; do not use any network tool.",
  `Then reply with exactly this one line and nothing else: ${PHASE_A_MARKER}`,
].join(" ");

function nowSuffix() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitStatus(cwd) {
  const result = spawnSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("The Phase-A smoke requires a Git workspace.");
  return String(result.stdout ?? "");
}

/** Whether `candidate` is `root` or lives underneath it. */
function containedIn(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * An exact, content-level inventory of everything Git can see in one checkout:
 * tracked paths plus untracked paths that are not ignored. Status text alone
 * is not a gate -- a checkout with pre-existing untracked or already-modified
 * files keeps identical status text while its bytes change -- so every listed
 * path contributes its type, mode, and either its symlink target or its
 * content digest.
 *
 * `.git` internals, ignored caches, and anything outside the checkout are
 * never traversed: the path list comes from Git itself, and no directory walk
 * happens here. The returned entries are digests, never bytes, so nothing this
 * function produces can carry source content into a receipt.
 */
function sourceInventory(root) {
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (listed.status !== 0) {
    throw new Error("The Phase-A source inventory requires a readable Git checkout.");
  }
  const relatives = [...new Set(String(listed.stdout ?? "").split("\0").filter(Boolean))].sort();
  if (relatives.length > MAX_SOURCE_INVENTORY_PATHS) {
    throw new Error("The Phase-A source inventory exceeded its bounded path count.");
  }
  const entries = new Map();
  // The index and worktree status is folded in as one digested synthetic
  // entry, so a staging-only change is caught without the status text ever
  // being retained.
  entries.set(
    SOURCE_STATUS_ENTRY,
    createHash("sha256").update(gitStatus(root)).digest("hex"),
  );
  let bytes = 0;
  for (const relative of relatives) {
    const absolute = path.join(root, relative);
    const entry = createHash("sha256").update(relative).update("\0");
    let stat = null;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      // A tracked path Git lists but the worktree no longer has is a real,
      // recordable state, not an error.
      entries.set(relative, entry.update("absent").digest("hex"));
      continue;
    }
    if (stat.isSymbolicLink()) {
      // Never followed: the link target text is the fact, not its destination.
      entries.set(relative, entry.update(`symlink\0${stat.mode}\0`).update(fs.readlinkSync(absolute)).digest("hex"));
      continue;
    }
    if (!stat.isFile()) {
      entries.set(relative, entry.update(`other\0${stat.mode}\0${stat.isDirectory() ? "dir" : "special"}`).digest("hex"));
      continue;
    }
    bytes += stat.size;
    if (bytes > MAX_SOURCE_INVENTORY_BYTES) {
      throw new Error("The Phase-A source inventory exceeded its bounded byte budget.");
    }
    entries.set(
      relative,
      entry.update(`file\0${stat.mode}\0${stat.size}\0`).update(fs.readFileSync(absolute)).digest("hex"),
    );
  }
  return { entries, pathCount: relatives.length };
}

function changedInventoryEntries(before, after) {
  const union = new Set([...before.entries.keys(), ...after.entries.keys()]);
  return [...union]
    .filter((relative) => before.entries.get(relative) !== after.entries.get(relative))
    .sort();
}

/**
 * The one disposable Git workspace this smoke runs in. Its seed file is
 * committed, so a clean `git status` is the honest statement that the turn
 * changed nothing -- not an artifact of the workspace starting out dirty.
 */
function initializeWorkspace() {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-phase-a-workspace-")));
  const git = (...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const failed = () => {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw new Error("The Phase-A smoke could not initialize its disposable Git workspace.");
  };
  if (git("init", "--quiet").status !== 0) failed();
  fs.writeFileSync(path.join(cwd, "README.md"), "# HarnessDock Phase-A leaf smoke workspace\n", "utf8");
  if (git("add", "--all").status !== 0) failed();
  const committed = git(
    "-c", "user.email=phase-a-smoke@invalid",
    "-c", "user.name=HarnessDock Phase-A smoke",
    "commit", "--quiet", "-m", "phase-a smoke workspace",
  );
  if (committed.status !== 0) failed();
  return cwd;
}

/** The closed acceptance value one durable launch claim proves. */
function acceptanceOf(record) {
  const acceptance = record?.acceptance;
  if (acceptance === "acceptance_proven") return "proven";
  if (acceptance === "acceptance_rejected") return "rejected";
  if (acceptance === "acceptance_unknown") return "unknown";
  if (acceptance === "not_submitted") return "not_submitted";
  return "unobserved";
}

/** The closed acceptance a thrown launch failure names, never its message. */
function acceptanceOfLaunchError(error) {
  const acceptance = /** @type {any} */ (error)?.acceptance;
  if (acceptance === "acceptance_rejected") return "rejected";
  if (acceptance === "acceptance_unknown") return "unknown";
  if (acceptance === "not_submitted") return "not_submitted";
  return "unobserved";
}

/**
 * The production supervisor session, pinned to exactly one native attempt.
 *
 * A leaf Claude route normally keeps `runClaudeTaskSession`'s bounded
 * reconnect, so one resumable transport close would spawn a second billed
 * Claude process. This smoke is authorized for exactly one, so the wrapper
 * states `maxReconnectAttempts: 0` and changes nothing else: the delegation
 * mode, topology, prompt, Claude options, and every callback stay exactly the
 * ones the Driver composed. It is deliberately not a caller-selectable option.
 */
function singleAttemptSupervisorSession(baseSession) {
  return (request) => baseSession({ ...request, retryPolicy: { maxReconnectAttempts: 0 } });
}

/**
 * The exact tool denials the production execution profile applies to this
 * route. This is the same profile the Driver itself constructs for the turn,
 * so the receipt states the authority the turn actually ran under.
 */
function observeAuthorityFacts(env, jobId) {
  const profile = createExecutionProfile({
    model: PHASE_A_MODEL,
    delegationMode: PHASE_A_DELEGATION_MODE,
    write: PHASE_A_WRITE,
    effort: PHASE_A_EFFORT,
    env,
    jobId,
  });
  try {
    const denied = profile.claudeOptions.disallowedTools ?? [];
    return {
      writeRequested: false,
      nativeAgentToolDenied: denied.includes("Agent"),
      workflowToolDenied: denied.includes("Workflow"),
      nativeTeamRequested: profile.claudeOptions.agents != null,
      dangerousPermissionBypass: profile.claudeOptions.dangerouslySkipPermissions === true,
    };
  } finally {
    profile.cleanup();
  }
}

/** The v1 supervisor record the production Claude session seam requires. */
function createSupervisorJob(workspaceRoot, jobId) {
  writeJobFile(workspaceRoot, jobId, {
    id: jobId,
    kind: PHASE_A_JOB_KIND,
    kindLabel: "phase-a-smoke",
    jobClass: "smoke",
    title: "Phase-A leaf smoke",
    workspaceRoot,
    write: PHASE_A_WRITE,
    status: "running",
    phase: "starting_attempt",
    acceptingSteering: true,
  });
}

function removeSupervisorJob(workspaceRoot, jobId) {
  for (const target of [resolveJobFile(workspaceRoot, jobId), resolveJobLogFile(workspaceRoot, jobId)]) {
    try { fs.rmSync(target, { force: true }); } catch {}
  }
}

/**
 * The exact durable child identity of this attempt.
 *
 * The production supervisor's own job receipt is read first; when this seam
 * leaves no process fact on it, the durable launch claim's native turn
 * reference is used instead, validated by the owning Driver rather than
 * trusted as raw text. Nothing else is ever signalled: no scan, no name match,
 * and no PID without the identity token that proves it is still this child.
 */
function exactChildIdentity({ workspaceRoot, jobId, claimIdentity, driver }) {
  const job = (() => {
    try { return readJobFile(workspaceRoot, jobId); } catch { return null; }
  })();
  if (Number.isSafeInteger(job?.pid) && job.pid > 0 && String(job?.pidIdentity ?? "").trim()) {
    return { pid: job.pid, pidIdentity: String(job.pidIdentity) };
  }
  try {
    const claim = readLaunchClaim(claimIdentity);
    const validated = driver.validateNativeTurnRef(claim?.nativeTurnRef);
    return { pid: validated.locator.pid, pidIdentity: validated.locator.processIdentity };
  } catch {
    return null;
  }
}

/** Whether the exact child that identity names is provably gone. */
async function provenAbsent(pid, pidIdentity, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!validateProcessIdentity(pid, pidIdentity)) return true;
    await sleep(CLEANUP_PROOF_INTERVAL_MS);
  }
  return !validateProcessIdentity(pid, pidIdentity);
}

/**
 * Internal exact-process cleanup for a turn that outlived its deadline.
 *
 * This is the existing internal recovery path (`cancelClaudeProcess`) against
 * one durable identity, not a graceful interrupt and never a settlement: a
 * cancelled child is still an unverified turn. It runs only on timeout, never
 * for an ambiguous acceptance, and it must prove absence rather than merely
 * having called something.
 */
async function cancelTimedOutChild(context) {
  const identity = exactChildIdentity(context);
  if (!identity) return "not_available";
  if (!validateProcessIdentity(identity.pid, identity.pidIdentity)) return "not_needed";
  try {
    await cancelClaudeProcess(identity.pid, identity.pidIdentity);
  } catch {
    // A throwing cancellation is still only evidence about the call; the
    // proof below is what decides the outcome.
  }
  return await provenAbsent(identity.pid, identity.pidIdentity, CLEANUP_PROOF_TIMEOUT_MS)
    ? "cancelled"
    : "failed";
}

function isAccountFailure(failureClass) {
  return ACCOUNT_FAILURE_CLASSES.includes(String(failureClass ?? ""));
}

/**
 * Build the one bounded receipt. Status is derived last, from proven facts
 * only: anything unproven is `unverified`, and account evidence outranks every
 * other classification because it must stop further real calls.
 */
function buildReceipt(state) {
  const accountStopped = state.accountEvidence === true;
  const proven = state.lifecycle.driverReadinessProven &&
    state.lifecycle.routeAccepted &&
    state.lifecycle.nativeAcceptance === "proven" &&
    state.lifecycle.terminalSettlement === "settled" &&
    state.lifecycle.terminalStatus === "completed" &&
    state.lifecycle.turnFailureClass == null &&
    !state.lifecycle.timedOut &&
    state.lifecycle.completionPublished &&
    state.lifecycle.completionEventObserved &&
    state.lifecycle.agentReconciled &&
    state.lifecycle.leasesReleased &&
    state.lifecycle.disposed &&
    state.lifecycle.markerObserved &&
    state.mutation.gitWorkspaceClean &&
    state.mutation.sourceCheckoutUnchanged &&
    !state.mutation.snapshotOverflow &&
    !state.authority.nativeTeamRequested &&
    state.oneShot.launchAttempts === 1;
  const status = state.status ?? (accountStopped
    ? "auth_or_quota_stopped"
    : proven ? "verified" : "unverified");
  const failureClass = state.failureClass ?? (accountStopped
    ? "auth_or_quota"
    : proven ? "none" : "internal_error");
  return Object.freeze({
    version: 1,
    phase: "A",
    status,
    failureClass,
    // A consumed fence or a started launch means this authorized attempt is
    // spent: nothing may reuse it, whatever the outcome was. Account, quota,
    // and authentication evidence stop further real calls outright.
    stopFurtherRealCalls: accountStopped ||
      state.oneShot.fenceConsumed ||
      state.oneShot.launchAttempts >= 1,
    route: Object.freeze({
      harnessId: CLAUDE_CODE_HARNESS_ID,
      model: PHASE_A_MODEL,
      effort: PHASE_A_EFFORT,
      write: PHASE_A_WRITE,
      delegationMode: PHASE_A_DELEGATION_MODE,
      topology: PHASE_A_TOPOLOGY,
      authority: PHASE_A_AUTHORITY,
    }),
    seam: Object.freeze({
      productionDriver: state.seam.productionDriver,
      productionWorkerLoop: state.seam.productionWorkerLoop,
      productionSupervisorSession: state.seam.productionSupervisorSession,
      singleNativeAttemptEnforced: state.seam.singleNativeAttemptEnforced,
      nativeTeamRequested: state.authority.nativeTeamRequested,
      followUpRequested: false,
    }),
    lifecycle: Object.freeze({ ...state.lifecycle }),
    authority: Object.freeze({
      writeRequested: state.authority.writeRequested,
      nativeAgentToolDenied: state.authority.nativeAgentToolDenied,
      workflowToolDenied: state.authority.workflowToolDenied,
      dangerousPermissionBypass: state.authority.dangerousPermissionBypass,
    }),
    mutation: Object.freeze({
      ...state.mutation,
      workspaceChangedBasenames: Object.freeze([...state.mutation.workspaceChangedBasenames]),
      sourceChangedBasenames: Object.freeze([...state.mutation.sourceChangedBasenames]),
    }),
    oneShot: Object.freeze({
      fenceConsumed: state.oneShot.fenceConsumed,
      launchAttempts: state.oneShot.launchAttempts,
      // Derived, never asserted: this runner starts exactly one worker loop
      // and has no path that starts a second one after a launch that may have
      // crossed the native transport.
      retriedAfterPossibleSubmission: state.oneShot.launchAttempts > 1,
    }),
  });
}

function initialState() {
  return {
    status: null,
    failureClass: null,
    accountEvidence: false,
    sourceRoot: null,
    claimIdentity: null,
    driver: null,
    seam: {
      productionDriver: false,
      productionWorkerLoop: false,
      productionSupervisorSession: false,
      singleNativeAttemptEnforced: false,
    },
    lifecycle: {
      driverReadinessProven: false,
      routeAccepted: false,
      nativeAcceptance: "not_submitted",
      terminalSettlement: "unobserved",
      terminalStatus: "none",
      turnFailureClass: null,
      completionPublished: false,
      completionEventObserved: false,
      agentReconciled: false,
      leasesReleased: false,
      disposed: false,
      markerObserved: false,
      timedOut: false,
      timeoutCleanup: "not_needed",
    },
    authority: {
      writeRequested: false,
      nativeAgentToolDenied: false,
      workflowToolDenied: false,
      nativeTeamRequested: false,
      dangerousPermissionBypass: false,
    },
    mutation: {
      gitWorkspaceClean: false,
      workspaceChangedBasenames: [],
      sourceCheckoutUnchanged: false,
      sourceChangedBasenames: [],
      sourceInventoryPathCount: 0,
      snapshotOverflow: false,
      runtimeStateIsolated: false,
      runtimeHomeDisposed: false,
      workspaceDisposed: false,
      nativeConfigDirOutsideWorkspace: false,
    },
    oneShot: {
      fenceConsumed: false,
      launchAttempts: 0,
    },
  };
}

/**
 * Resolve the mandatory durable fence path to the exact location the kernel
 * will write, before anything is created.
 *
 * The fence must be absolute, must have a real existing directory as its
 * parent, and that *resolved* parent must lie outside the source checkout --
 * a lexical check alone is not a gate, because an absolute symlinked parent
 * (`/tmp/link-to-checkout/x.fence`) is lexically outside the checkout while
 * the atomic creation below would land inside it. The parent is therefore
 * resolved through `realpath` and the candidate rebuilt from it, so the
 * containment decision is made about the destination that will actually be
 * created. The final component is never resolved: `wx` refuses an existing
 * path, including a symlink, so it can never be followed either.
 *
 * The fence is deliberately never deleted, whatever the outcome, so it must
 * also live somewhere that survives this run.
 */
function resolveFenceTarget(fenceFile, sourceRoot) {
  if (typeof fenceFile !== "string" || !fenceFile.trim()) {
    return { failureClass: "preflight_fence_required" };
  }
  if (!path.isAbsolute(fenceFile) || fenceFile.includes("\0")) {
    return { failureClass: "preflight_fence_path_invalid" };
  }
  const basename = path.basename(fenceFile);
  if (!basename || basename === "." || basename === "..") {
    return { failureClass: "preflight_fence_path_invalid" };
  }
  if (containedIn(sourceRoot, fenceFile)) {
    return { failureClass: "preflight_fence_path_invalid" };
  }
  let realParent;
  try {
    realParent = fs.realpathSync.native(path.dirname(fenceFile));
  } catch {
    // Missing, unreadable, or an unresolvable link chain: the destination
    // cannot be decided, so no fence is created and no attempt is spent.
    return { failureClass: "preflight_fence_unavailable" };
  }
  let parentStat;
  try {
    parentStat = fs.lstatSync(realParent);
  } catch {
    return { failureClass: "preflight_fence_unavailable" };
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    return { failureClass: "preflight_fence_unavailable" };
  }
  const target = path.join(realParent, basename);
  if (containedIn(sourceRoot, target)) {
    return { failureClass: "preflight_fence_path_invalid" };
  }
  return { target };
}

/**
 * Run the one authorized Phase-A leaf smoke.
 *
 * `options.authorized` must be explicitly true and `options.fenceFile` must be
 * an absolute path outside the source checkout: an accidental or repeated
 * invocation costs nothing and reaches no Driver. `options.driverSeams` is an
 * internal composition seam for this checkout's own zero-cost tests; it is
 * forwarded to the static registry, which constructs the same production
 * Driver either way, and the production path states nothing.
 */
export async function runPhaseALeafSmoke(options = {}) {
  const state = initialState();
  if (options.authorized !== true) {
    state.status = "preflight_rejected";
    state.failureClass = "preflight_not_authorized";
    return buildReceipt(state);
  }

  let sourceRoot;
  try {
    sourceRoot = fs.realpathSync.native(options.sourceRoot ?? SOURCE_ROOT);
    state.sourceRoot = sourceRoot;
  } catch {
    state.status = "preflight_rejected";
    state.failureClass = "workspace_setup_failed";
    return buildReceipt(state);
  }

  const fence = resolveFenceTarget(options.fenceFile ?? null, sourceRoot);
  if (fence.failureClass) {
    state.status = "preflight_rejected";
    state.failureClass = fence.failureClass;
    return buildReceipt(state);
  }
  // The resolved destination, not the caller's spelling of it: nothing below
  // reopens the caller's path or re-traverses its parent.
  const fenceFile = fence.target;
  // The fence is consumed atomically, before any Driver inspection, durable
  // record, or native call exists. `wx` is the whole guard: two concurrent
  // runners cannot both create it, and there is no window between an existence
  // check and a later write for a second attempt to slip through.
  try {
    fs.closeSync(fs.openSync(fenceFile, "wx", 0o600));
    state.oneShot.fenceConsumed = true;
  } catch (error) {
    state.status = "preflight_rejected";
    state.failureClass = /** @type {any} */ (error)?.code === "EEXIST"
      ? "preflight_fence_present"
      : "preflight_fence_unavailable";
    return buildReceipt(state);
  }

  let sourceBefore;
  try {
    sourceBefore = sourceInventory(sourceRoot);
    state.mutation.sourceInventoryPathCount = sourceBefore.pathCount;
  } catch {
    // Fail closed: without a trustworthy before-inventory there is no source
    // gate at all, so no native call may happen.
    state.status = "unverified";
    state.failureClass = "source_inventory_unavailable";
    return buildReceipt(state);
  }

  const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-phase-a-runtime-"));
  let cwd = null;
  let supervisorJob = null;
  try {
    cwd = initializeWorkspace();
  } catch {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    state.status = "unverified";
    state.failureClass = "workspace_setup_failed";
    return buildReceipt(state);
  }
  if (containedIn(cwd, fenceFile) || containedIn(runtimeHome, fenceFile)) {
    // Both roots are freshly created, so this is unreachable in practice; a
    // fence inside a disposed root would silently un-consume itself, so it
    // fails closed rather than being tolerated.
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runtimeHome, { recursive: true, force: true });
    state.status = "unverified";
    state.failureClass = "preflight_fence_path_invalid";
    return buildReceipt(state);
  }

  let deadlineSignal = null;
  try {
    // One inner attempt closure: every early exit below is an early exit from
    // the attempt, never from this function, so the outer `finally` always
    // runs exact cleanup, disposal, and the source-mutation gate before the
    // receipt is built.
    await (async () => {
    // Every durable owner this smoke touches resolves its root through
    // `paths.mjs`, so one temporary runtime home isolates the Agent store,
    // launch claim, lease, control stream, version-three job record,
    // completion inbox, supervisor job record, and sandbox settings at once --
    // outside the disposable Git workspace and outside any operator state.
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = runtimeHome;
    state.mutation.runtimeStateIsolated =
      containedIn(runtimeHome, resolvePluginStateRoot());

    const environment = resolveRuntimeEnvironment({ cwd, env: options.env ?? process.env });
    const env = environment.env;
    state.mutation.nativeConfigDirOutsideWorkspace =
      !containedIn(cwd, String(env.CLAUDE_CONFIG_DIR ?? path.sep));

    const baseSession = options.driverSeams?.runTurnSession ?? runClaudeTaskSession;
    const driver = resolveDriverV2(CLAUDE_CODE_HARNESS_ID, {
      env,
      ...(options.driverSeams ?? {}),
      runTurnSession: singleAttemptSupervisorSession(baseSession),
    });
    state.seam.productionDriver = true;
    // True only because the wrapper above calls the real production supervisor
    // session; a test that substitutes its own base session says so.
    state.seam.productionSupervisorSession = baseSession === runClaudeTaskSession;
    state.seam.singleNativeAttemptEnforced = true;

    const inspections = await inspectDriverInstances(
      driver,
      createDriverScope({ driver, purpose: "inspect", workspaceRoot: cwd, env }),
    );
    const ready = inspections.find((instance) => instance.readiness === "ready");
    if (!ready) {
      const accountDetail = inspections.some((instance) => ACCOUNT_DETAIL_CODES.includes(instance.detailCode));
      state.accountEvidence = accountDetail;
      state.status = accountDetail ? "auth_or_quota_stopped" : "unverified";
      state.failureClass = accountDetail ? "auth_or_quota" : "driver_unready";
      return;
    }
    state.lifecycle.driverReadinessProven = true;

    let accepted;
    try {
      accepted = acceptDriverRoute(driver, {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        model: PHASE_A_MODEL,
        topology: PHASE_A_TOPOLOGY,
        authority: PHASE_A_AUTHORITY,
      }, inspections);
    } catch {
      state.status = "unverified";
      state.failureClass = "route_rejected";
      return;
    }
    state.lifecycle.routeAccepted = true;
    const route = {
      ...accepted.route,
      capabilitySchemaVersion: ROUTE_CAPABILITY_SCHEMA_VERSION,
    };

    const ownerRootId = `phase-a-${nowSuffix()}`;
    const jobId = `job-phase-a-${nowSuffix()}`;
    const attemptId = `attempt-phase-a-${nowSuffix()}`;
    state.authority = observeAuthorityFacts(env, jobId);

    let input;
    try {
      const store = createAgentStore({
        cwd,
        ownerRootId,
        writeGeneration: FUTURE_WRITE_GENERATION,
      });
      const agent = store.createAgent({
        task_name: `phase_a_leaf_smoke_${nowSuffix().replace(/-/g, "_")}`,
        route,
        initialMessage: PHASE_A_PROMPT,
      });
      const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
      if (!reservation.reserved) throw new Error("Phase-A activation reservation failed.");
      state.claimIdentity = { ownerRootId, agentId: agent.agentId, jobId, attemptId };
      const preparedTurn = driver.prepareTurn({
        route,
        taskInput: PHASE_A_PROMPT,
        turnOptions: { effort: PHASE_A_EFFORT },
        turnId: jobId,
      });
      createLaunchIntent({
        ownerRootId,
        agentId: agent.agentId,
        jobId,
        attemptId,
        route,
        expectedLease: {
          kind: "instance",
          capacityClass: PHASE_A_CAPACITY_CLASS,
          capacityLimit: 1,
        },
        assignedMessageIds: reservation.assignedMessages.map((message) => message.messageId),
        preparedInput: PHASE_A_PROMPT,
        turnOptions: preparedTurn.turnOptions,
      });
      const lease = acquireInstanceLease({
        ownerRootId,
        agentId: agent.agentId,
        jobId,
        route,
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        capacityClass: PHASE_A_CAPACITY_CLASS,
        capacityLimit: 1,
      });
      bindLaunchClaimLease({ ownerRootId, agentId: agent.agentId, jobId, attemptId, lease });
      createSupervisorJob(cwd, jobId);
      supervisorJob = jobId;
      deadlineSignal = AbortSignal.timeout(options.maxMs ?? DEFAULT_MAX_MS);
      input = {
        ownerRootId,
        agentId: agent.agentId,
        jobId,
        attemptId,
        route,
        driver,
        preparedTurn,
        preparedInput: PHASE_A_PROMPT,
        assignedMessageIds: reservation.assignedMessages.map((message) => message.messageId),
        assignedInputs: [],
        leaseBindings: [lease],
        turnOptions: { effort: PHASE_A_EFFORT },
        workspaceRoot: canonicalAgentWorkspaceRoot(cwd),
        env,
        cwd,
        signal: deadlineSignal,
      };
      state.driver = driver;
    } catch {
      try {
        if (state.claimIdentity && readLaunchClaim(state.claimIdentity)) {
          rollbackPreparedVersionThreeTurn({ cwd, ...state.claimIdentity });
        }
      } catch { /* the smoke reports durable setup failure without weakening its fence */ }
      state.status = "unverified";
      state.failureClass = "durable_setup_failed";
      return;
    }

    const before = snapshotWorkspace(cwd);

    // The single native attempt. Nothing below this line retries, resumes, or
    // reconstructs a second launch: from here the durable launch claim is the
    // only authority on what did or did not cross the transport.
    state.oneShot.launchAttempts = 1;
    let loopResult = null;
    let launchError = null;
    try {
      loopResult = await runVersionThreeWorkerLoop(input);
      state.seam.productionWorkerLoop = true;
    } catch (error) {
      launchError = error;
      state.seam.productionWorkerLoop = true;
    }
    // The exact signal decides, not the loop's own reason: a loop that throws
    // after its deadline elapsed still leaves a live child to clean up.
    state.lifecycle.timedOut = deadlineSignal.aborted || loopResult?.reason === "aborted";

    const after = snapshotWorkspace(cwd);
    const workspaceChanged = changedPaths(before, after);
    state.mutation.gitWorkspaceClean = workspaceChanged.length === 0 && gitStatus(cwd) === "";
    state.mutation.workspaceChangedBasenames = boundedBasenames(workspaceChanged);
    state.mutation.snapshotOverflow = before.overflow || after.overflow;

    const claim = (() => {
      try { return readLaunchClaim(state.claimIdentity); } catch { return null; }
    })();

    if (launchError) {
      try {
        if (claim?.acceptance === "not_submitted" && claim.submissionState === "not_started") {
          rollbackPreparedVersionThreeTurn({ cwd, ...state.claimIdentity });
        }
      } catch { /* failure remains unverified and the claim stays fail-closed */ }
      state.lifecycle.nativeAcceptance = claim
        ? acceptanceOf(claim)
        : acceptanceOfLaunchError(launchError);
      state.status = "unverified";
      state.failureClass = state.lifecycle.nativeAcceptance === "unknown"
        ? "launch_ambiguous"
        : "launch_not_submitted";
      return;
    }
    state.lifecycle.nativeAcceptance = acceptanceOf(claim);
    const terminal = loopResult.terminalResult ?? null;
    state.lifecycle.terminalSettlement = terminal?.executionWorld?.settlement ?? "unknown";
    state.lifecycle.terminalStatus = terminal?.status ?? "none";
    state.lifecycle.turnFailureClass = terminal?.failure?.class ?? null;
    state.lifecycle.completionPublished = loopResult.published === true;
    state.lifecycle.agentReconciled = loopResult.agentReconciled === true;
    state.lifecycle.leasesReleased = loopResult.leasesReleased === true;
    state.lifecycle.disposed = loopResult.disposed === true;
    state.lifecycle.markerObserved = String(terminal?.finalMessage ?? "").includes(PHASE_A_MARKER);
    state.lifecycle.completionEventObserved = (() => {
      try {
        return readUnreadCompletionEvents(cwd, state.claimIdentity.ownerRootId).events
          .some((event) => event.jobId === state.claimIdentity.jobId);
      } catch {
        return false;
      }
    })();
    state.accountEvidence = isAccountFailure(state.lifecycle.turnFailureClass);
    if (state.accountEvidence) {
      state.status = "auth_or_quota_stopped";
      state.failureClass = "auth_or_quota";
    } else if (state.lifecycle.timedOut) {
      // Classified in the `finally`, once exact cleanup has run.
      state.status = "unverified";
    } else if (state.lifecycle.turnFailureClass != null || state.lifecycle.terminalStatus !== "completed") {
      state.status = "unverified";
      state.failureClass = "turn_failed";
    } else if (state.lifecycle.terminalSettlement !== "settled") {
      state.status = "unverified";
      state.failureClass = "settlement_unknown";
    } else if (!state.lifecycle.completionPublished || !state.lifecycle.completionEventObserved) {
      state.status = "unverified";
      state.failureClass = "publication_missing";
    } else if (!state.mutation.gitWorkspaceClean || state.mutation.snapshotOverflow) {
      state.status = "unverified";
      state.failureClass = "workspace_mutated";
    } else if (!state.lifecycle.markerObserved) {
      state.status = "unverified";
      state.failureClass = "marker_absent";
    }
    })();
  } catch {
    state.status = state.status ?? "unverified";
    state.failureClass = state.failureClass ?? "internal_error";
  } finally {
    // Exact internal cleanup runs before anything durable is disposed: the
    // child identity it needs lives in this attempt's own supervisor record
    // and launch claim, both under the runtime home removed below.
    if (state.lifecycle.timedOut && supervisorJob && state.claimIdentity) {
      state.lifecycle.timeoutCleanup = await cancelTimedOutChild({
        workspaceRoot: cwd,
        jobId: supervisorJob,
        claimIdentity: state.claimIdentity,
        driver: state.driver,
      });
      if (!state.accountEvidence) {
        state.status = "unverified";
        state.failureClass = ["cancelled", "not_needed"].includes(state.lifecycle.timeoutCleanup)
          ? "turn_timeout"
          : "timeout_cleanup_failed";
      }
    }
    if (supervisorJob && cwd) removeSupervisorJob(cwd, supervisorJob);

    const sourceAfter = (() => {
      try { return sourceInventory(state.sourceRoot); } catch { return null; }
    })();
    if (sourceAfter == null) {
      // Fail closed: an unreadable after-inventory cannot prove the source
      // checkout is untouched, so it is never reported as unchanged.
      state.mutation.sourceCheckoutUnchanged = false;
      if (!state.accountEvidence && state.failureClass !== "timeout_cleanup_failed") {
        state.status = "unverified";
        state.failureClass = "source_inventory_unavailable";
      }
    } else {
      const sourceChanged = changedInventoryEntries(sourceBefore, sourceAfter);
      state.mutation.sourceCheckoutUnchanged = sourceChanged.length === 0;
      state.mutation.sourceChangedBasenames = boundedBasenames(sourceChanged);
      if (sourceChanged.length > 0 && !state.accountEvidence &&
        state.failureClass !== "timeout_cleanup_failed") {
        state.status = "unverified";
        state.failureClass = "source_mutated";
      }
    }

    if (cwd && options.keepWorkspace !== true) {
      fs.rmSync(cwd, { recursive: true, force: true });
      state.mutation.workspaceDisposed = !fs.existsSync(cwd);
    }
    if (options.keepRuntimeHome !== true) {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
      state.mutation.runtimeHomeDisposed = !fs.existsSync(runtimeHome);
    }
    if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
    // The fence is never removed: a consumed authorized attempt stays consumed.
  }
  return buildReceipt(state);
}
