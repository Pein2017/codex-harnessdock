/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Durable, root-scoped Agent Thread storage.  This module deliberately owns
 * registry, Agent mailbox, session-binding, and locking details so the public
 * runtime can reason in terms of one small Agent-store interface.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CLAUDE_LEGACY_HARNESS_ID,
  applyLegacyClaudeSessionRef,
  canonicalInstanceKeyForHarness,
  interpretLegacySessionBinding,
  isLegacyAgentRecord,
  legacyClaudeSessionProjection,
  legacyNativeSessionRef,
  legacyRouteProjection,
  migrateLegacyTerminalRecord,
  versionThreeInstanceKeyForHarness,
} from "./claude-legacy-adapter.mjs";
import {
  AGENT_RECORD_VERSION_V3,
  FUTURE_WRITE_GENERATION,
  JOB_STATE_VERSION_V3,
  assertUnderstoodJobRecord,
  assertVersionThreeWriteAllowed,
  isUnderstoodJobRecord,
  jobDurableStateVersion,
  normalizeWriteGeneration,
  validateVersionThreeRoute,
  versionThreeRouteText,
} from "./durable-state-v3.mjs";
import {
  HARNESS_CAPABILITY_NAMES,
  validateHarnessCapabilities,
} from "./harness-capabilities.mjs";
import {
  assertHarnessId,
  canonicalNativeSessionRef,
  harnessSessionKey,
} from "./harness-contract.mjs";
import {
  assertNativeReferenceEnvelopeShape,
  assertNativeReferenceLocatorShape,
} from "./native-reference.mjs";
import { resolvePluginStateRoot } from "./paths.mjs";
import { readLaunchClaim } from "./launch-claim.mjs";
import { getProcessIdentity, validateProcessIdentity } from "./process-control.mjs";
import { classifyVersionThreeContinuation } from "./turn-settlement.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// The registry container stays at version 1 so a root that still holds only
// version-1 Agents remains readable by a runtime without Harness support. A
// version-2 Agent record is what makes such a runtime fail closed.
export const AGENT_STORE_VERSION = 1;
export const AGENT_RECORD_VERSION = 2;
export const LEGACY_AGENT_RECORD_VERSION = 1;
export const AGENT_SESSION_BINDING_VERSION = 2;
export const AGENT_MAILBOX_VERSION = 1;

const SUPPORTED_AGENT_RECORD_VERSIONS = new Set([
  LEGACY_AGENT_RECORD_VERSION,
  AGENT_RECORD_VERSION,
  AGENT_RECORD_VERSION_V3,
]);

/**
 * Identity a version-three Agent states only inside its immutable route. A
 * record carrying one of these alongside a route would have two owners for the
 * same fact, and the legacy one is mutable.
 */
const LEGACY_IDENTITY_FIELDS = Object.freeze([
  "harnessId",
  "driverVersion",
  "capabilities",
  "selectedModel",
  "selectedEffort",
  "delegationMode",
  "claudeSessionId",
  "claudeConfigDir",
]);
const SUPPORTED_SESSION_BINDING_VERSIONS = new Set([1, AGENT_SESSION_BINDING_VERSION]);

const REGISTRY_DIRECTORY = "agent-registry";
const ROOTS_DIRECTORY = "roots";
const SESSIONS_DIRECTORY = "session-bindings";
const REGISTRY_FILE = "registry.json";
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;
const FINALIZED_JOB_ID_LIMIT = 128;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "unknown"]);
const AGENT_STATUSES = new Set(["pending_init", "running", "completed", "interrupted", "errored"]);
const DELEGATION_MODES = new Set(["leaf", "claude_orchestrator"]);
const CONTINUATION_MODES = new Set(["exact_session", "safe_fresh", "blocked"]);
const MESSAGE_STATES = new Set(["queued", "assigned", "dispatched", "acknowledged"]);

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty text value.`);
  }
  return value.trim();
}

function assertOptionalText(value, label) {
  if (value == null) return null;
  return assertText(value, label);
}

function nowIso() {
  return new Date().toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function canonicalWorkspace(cwd) {
  return canonicalPath(resolveWorkspaceRoot(cwd));
}

/**
 * The canonical workspace root one working directory resolves to -- the exact
 * value this store keys its registry by.
 *
 * Exported so a durable record that must be reopenable by a later
 * reconciliation pass (the internal version-three job record) can persist the
 * canonical root itself rather than whichever working directory its worker
 * happened to run in. Idempotent: canonicalizing a canonical root returns it
 * unchanged. Read-only -- it resolves a path and creates nothing.
 */
export function canonicalAgentWorkspaceRoot(cwd) {
  return canonicalWorkspace(assertText(cwd, "workspace cwd"));
}

function workspaceHash(cwd) {
  return digest(canonicalWorkspace(cwd)).slice(0, 16);
}

function rootHash(rootThreadId) {
  return digest(assertText(rootThreadId, "owner root ID")).slice(0, 32);
}

function normalizedName(value) {
  const text = assertText(value, "Agent name").normalize("NFKC").trim();
  if (text.includes("/") || text.includes("\\")) {
    throw new Error("Agent name must be one flat task-name segment.");
  }
  if (text === "." || text === "..") {
    throw new Error("Agent name must not be a relative path segment.");
  }
  return text.toLocaleLowerCase("en-US");
}

function displayName(value) {
  const text = assertText(value, "Agent name").normalize("NFKC").trim();
  normalizedName(text);
  return text;
}

function agentPath(name) {
  return `/root/${displayName(name)}`;
}

function generatedAgentId() {
  return `agent-${Date.now().toString(36)}-${randomBytes(9).toString("base64url")}`;
}

function generatedMessageId(agentId, sequence) {
  return `message-${digest(`${agentId}\0${sequence}`).slice(0, 24)}`;
}

function clone(value) {
  return structuredClone(value);
}

function protection(directory) {
  if (process.platform === "win32") {
    return {
      platform: "win32",
      protection: "not-verified",
      message: "Native Windows ACL verification is unavailable in this runtime; no owner-only ACL guarantee is claimed.",
    };
  }
  let mode = null;
  try { mode = fs.statSync(directory).mode & 0o777; } catch {}
  return {
    platform: "posix",
    protection: mode != null && (mode & 0o077) === 0 ? "owner-only" : "mode-not-verified",
    requestedDirectoryMode: "0700",
    requestedFileMode: "0600",
    effectiveDirectoryMode: mode == null ? null : mode.toString(8).padStart(4, "0"),
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
  return directory;
}

function fsyncDirectory(directory) {
  if (process.platform === "win32") return;
  let descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Best effort: some filesystems do not expose a directory descriptor.
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  const temporary = path.join(
    directory,
    `${path.basename(filePath)}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    if (process.platform !== "win32") {
      try { fs.chmodSync(filePath, 0o600); } catch {}
    }
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sleepSync(milliseconds) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function fileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function clearStaleLock(lockPath) {
  let observed = null;
  try {
    observed = fs.statSync(lockPath);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock?.identity && validateProcessIdentity(lock.pid, lock.identity)) return false;
    if (!lock?.identity && Date.now() - observed.mtimeMs < LOCK_STALE_MS) return false;
  } catch {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false;
    } catch {
      return false;
    }
  }
  try {
    const current = fs.statSync(lockPath);
    if (observed && !fileIdentity(observed, current)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(directory, name) {
  ensureDirectory(directory);
  const lockPath = path.join(directory, name);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    clearStaleLock(lockPath);
    const token = randomBytes(16).toString("hex");
    const candidate = `${lockPath}.${process.pid}.${token}.candidate`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(candidate, "wx", 0o600);
      let identity = null;
      try { identity = getProcessIdentity(process.pid); } catch {}
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, identity, token, createdAt: nowIso() }), "utf8");
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      fs.linkSync(candidate, lockPath);
      fs.unlinkSync(candidate);
      fs.closeSync(descriptor);
      return { lockPath, token, stat };
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(candidate); } catch {}
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        if (error?.code === "EEXIST") {
          throw Object.assign(new Error(`Timed out acquiring Agent-store lock ${lockPath}.`), { code: "ETIMEDOUT" });
        }
        throw error;
      }
      sleepSync(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    const stat = fs.statSync(lock.lockPath);
    const data = JSON.parse(fs.readFileSync(lock.lockPath, "utf8"));
    if (fileIdentity(lock.stat, stat) && data?.token === lock.token) fs.unlinkSync(lock.lockPath);
  } catch {}
}

function defaultRegistry(rootThreadId, workspaceRoot, directory) {
  const timestamp = nowIso();
  return {
    version: AGENT_STORE_VERSION,
    rootThreadId: assertText(rootThreadId, "owner root ID"),
    rootHash: rootHash(rootThreadId),
    workspaceRoot,
    agents: {},
    nameIndex: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    protection: protection(directory),
  };
}

function isVersionThree(agent) {
  return agent?.version === AGENT_RECORD_VERSION_V3;
}

/**
 * The neutral native-session reference for any schema. A version-three record
 * owns the reference directly; the Claude interpretation of a version-1 record
 * belongs to the legacy adapter, not to this generic path.
 */
function internalNativeSessionRef(agent) {
  if (isVersionThree(agent)) return agent.nativeSessionRef ?? null;
  if (isLegacyAgentRecord(agent)) return legacyNativeSessionRef(agent);
  return agent?.nativeSessionRef ?? null;
}

function recordHarnessId(agent) {
  if (isVersionThree(agent)) return agent.route?.harnessId ?? null;
  if (!isLegacyAgentRecord(agent)) return null;
  return agent.harnessId ?? CLAUDE_LEGACY_HARNESS_ID;
}

/** The Agent's immutable route, composed from its single-owner fields. */
function interpretedRoute(agent) {
  if (isVersionThree(agent)) return clone(agent.route);
  return legacyRouteProjection(agent);
}

function validateContinuation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent continuation must be an object.");
  }
  const mode = assertText(value.mode, "Agent continuation mode");
  if (!CONTINUATION_MODES.has(mode)) throw new Error(`Unsupported Agent continuation mode: ${mode}.`);
  const evidence = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
    ? value.evidence
    : null;
  if (!evidence) throw new Error("Agent continuation must carry evidence.");
  return { mode, evidence: clone(evidence) };
}

function validateMessage(message, agentId, previousSequence) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Agent mailbox contains an invalid message.");
  }
  if (message.version !== AGENT_MAILBOX_VERSION) {
    throw new Error(`Unsupported Agent mailbox message version: ${message.version}.`);
  }
  const sequence = Number(message.sequence);
  if (!Number.isSafeInteger(sequence) || sequence !== previousSequence + 1) {
    throw new Error("Agent mailbox sequence must be contiguous.");
  }
  if (message.agentId !== agentId || message.messageId !== generatedMessageId(agentId, sequence)) {
    throw new Error("Agent mailbox message identity is invalid.");
  }
  assertText(message.text, "Agent mailbox message text");
  if (!MESSAGE_STATES.has(message.state)) throw new Error(`Invalid Agent message state: ${message.state}.`);
  if (message.state === "queued" && message.assignedJobId != null) {
    throw new Error("Queued Agent mailbox message must not have an assigned job.");
  }
  if (["assigned", "dispatched", "acknowledged"].includes(message.state)) {
    assertText(message.assignedJobId, "Agent mailbox assigned job ID");
  }
  return sequence;
}

/** Mutable identity a version-1/2 record states outside any route. */
function validateLegacyIdentity(agent) {
  if (agent.selectedModel != null) assertText(agent.selectedModel, "Agent selected model");
  if (!DELEGATION_MODES.has(agent.delegationMode)) {
    throw new Error(`Invalid Agent delegation mode: ${agent.delegationMode}.`);
  }
}

/**
 * A version-three Agent states its whole Harness route once, immutably. It
 * carries no legacy identity field, and its native session may only belong to
 * the exact Harness instance its route froze.
 */
/**
 * The durable live-turn ownership marker.
 *
 * `state` is the whole point: a worker that has proven its native turn
 * terminal must be able to stop being the live owner *durably*, before it
 * releases a lease or publishes anything, so that a concurrent
 * `enqueueMessage()` in that window cannot bind a new message to a turn that
 * will never deliver it. An in-process boolean cannot do that -- another
 * process never sees it.
 *
 *   live      the worker owns this turn; new messages bind to it as usual
 *   quiesced  the turn is provably over; new messages stay queued for the
 *             next turn, and the Agent is still not activatable because
 *             `activeJobId` remains set until the terminal projection lands
 */
const TURN_OWNERSHIP_STATES = new Set(["live", "quiesced"]);

function validateTurnOwnership(value, label) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const field of Object.keys(value)) {
    if (!["jobId", "attemptId", "state", "updatedAt"].includes(field)) {
      throw new Error(`${label} declares an unsupported field: ${field}.`);
    }
  }
  if (!TURN_OWNERSHIP_STATES.has(value.state)) {
    throw new Error(`${label} declares an unsupported state: ${JSON.stringify(value.state ?? null)}.`);
  }
  return {
    jobId: assertText(value.jobId, `${label} job ID`),
    attemptId: assertText(value.attemptId, `${label} attempt ID`),
    state: value.state,
    updatedAt: assertText(value.updatedAt, `${label} timestamp`),
  };
}

function validateVersionThreeAgent(agent) {
  const label = `Version-three Agent ${agent.agentId}`;
  if (agent.route == null) {
    throw new Error(`${label} requires one immutable route; version alone is not a migration.`);
  }
  const route = validateVersionThreeRoute(agent.route, `${label} route`);
  const ownership = validateTurnOwnership(agent.liveTurnOwnership, `${label} live turn ownership`);
  if (ownership && agent.activeJobId != null && ownership.jobId !== agent.activeJobId) {
    throw new Error(`${label} live turn ownership names a job that is not its active job.`);
  }
  for (const field of LEGACY_IDENTITY_FIELDS) {
    if (agent[field] != null) {
      throw new Error(`${label} must not carry the legacy identity field ${field}.`);
    }
  }
  if (agent.nativeSessionRef != null) {
    const envelope = Object.hasOwn(agent.nativeSessionRef, "locator");
    let nativeSession;
    if (envelope) {
      nativeSession = assertNativeReferenceEnvelopeShape(
        agent.nativeSessionRef,
        `${label} native session reference`,
      );
      assertNativeReferenceLocatorShape(
        nativeSession.locator,
        `${label} native session reference`,
      );
      if (nativeSession.driverVersion !== route.driverVersion) {
        throw new Error(
          `${label} native session belongs to Driver ${nativeSession.driverVersion}, ` +
          `not ${route.driverVersion}.`
        );
      }
    } else {
      nativeSession = canonicalNativeSessionRef(agent.nativeSessionRef);
    }
    if (nativeSession.harnessId !== route.harnessId) {
      throw new Error(
        `${label} native session belongs to Harness ${nativeSession.harnessId}, not ${route.harnessId}.`
      );
    }
    if (nativeSession.instanceKey !== route.instanceKey) {
      throw new Error(
        `${label} native session belongs to logical instance ${nativeSession.instanceKey}, ` +
        `not ${route.instanceKey}.`
      );
    }
  }
  return route;
}

function validateAgent(agent, rootThreadId, workspaceRoot) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new Error("Agent record must be an object.");
  }
  if (!SUPPORTED_AGENT_RECORD_VERSIONS.has(agent.version)) {
    throw new Error(`Unsupported Agent record version: ${agent.version}.`);
  }
  assertText(agent.agentId, "Agent ID");
  if (agent.rootThreadId !== rootThreadId) throw new Error("Agent root does not match its registry.");
  if (agent.workspaceRoot !== workspaceRoot) throw new Error("Agent workspace does not match its registry.");
  const name = displayName(agent.name);
  if (agent.normalizedName !== normalizedName(name) || agent.path !== agentPath(name)) {
    throw new Error("Agent name or flat path is invalid.");
  }
  if (!AGENT_STATUSES.has(agent.status)) throw new Error(`Invalid Agent lifecycle status: ${agent.status}.`);
  validateContinuation(agent.continuation);
  if (agent.activeJobId != null) assertText(agent.activeJobId, "Agent active job ID");
  if (agent.latestJobId != null) assertText(agent.latestJobId, "Agent latest job ID");
  if (agent.finalizedJobIds != null) {
    if (!Array.isArray(agent.finalizedJobIds) || agent.finalizedJobIds.length > FINALIZED_JOB_ID_LIMIT) {
      throw new Error("Agent finalized job IDs must be a bounded array.");
    }
    const finalized = agent.finalizedJobIds.map((jobId) => assertText(jobId, "Agent finalized job ID"));
    if (new Set(finalized).size !== finalized.length) throw new Error("Agent finalized job IDs must be unique.");
  }
  if (agent.version === AGENT_RECORD_VERSION_V3) {
    validateVersionThreeAgent(agent);
  } else if (agent.version === AGENT_RECORD_VERSION) {
    validateLegacyIdentity(agent);
    if (agent.liveTurnOwnership != null) {
      throw new Error(`Agent ${agent.agentId} is not a version-three record and cannot own version-three turn state.`);
    }
    assertHarnessId(agent.harnessId);
    assertText(agent.driverVersion, "Agent Driver version");
    validateHarnessCapabilities(agent.capabilities, `Agent ${agent.agentId} capability snapshot`);
    if (agent.nativeSessionRef != null) {
      const nativeSession = canonicalNativeSessionRef(agent.nativeSessionRef);
      if (nativeSession.harnessId !== agent.harnessId) {
        throw new Error(
          `Agent native session belongs to Harness ${nativeSession.harnessId}, not ${agent.harnessId}.`
        );
      }
    }
    if (agent.claudeSessionId != null || agent.claudeConfigDir != null) {
      throw new Error("A version-2 Agent stores its native session only as a neutral reference.");
    }
  } else {
    validateLegacyIdentity(agent);
    if (
      agent.harnessId != null ||
      agent.driverVersion != null ||
      agent.nativeSessionRef != null ||
      agent.capabilities != null
    ) {
      throw new Error("A version-1 Agent must not carry Harness-neutral fields.");
    }
    if (agent.claudeSessionId != null) {
      assertText(agent.claudeSessionId, "Agent Claude session ID");
      assertText(agent.claudeConfigDir, "Agent Claude config directory");
    }
  }
  if (!agent.mailbox || typeof agent.mailbox !== "object" || Array.isArray(agent.mailbox)) {
    throw new Error("Agent mailbox must be an object.");
  }
  if (agent.mailbox.version !== AGENT_MAILBOX_VERSION) throw new Error("Unsupported Agent mailbox version.");
  let previous = 0;
  for (const message of agent.mailbox.messages ?? []) previous = validateMessage(message, agent.agentId, previous);
  if (Number(agent.mailbox.nextSequence) !== previous + 1) {
    throw new Error("Agent mailbox next sequence is inconsistent.");
  }
  return agent;
}

function validateRegistry(registry, rootThreadId, workspaceRoot, directory) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Agent registry must be an object.");
  }
  if (registry.version !== AGENT_STORE_VERSION) throw new Error(`Unsupported Agent registry version: ${registry.version}.`);
  const root = assertText(rootThreadId, "owner root ID");
  if (registry.rootThreadId !== root || registry.rootHash !== rootHash(root)) {
    throw new Error("Agent registry root identity is invalid.");
  }
  if (registry.workspaceRoot !== workspaceRoot) throw new Error("Agent registry workspace is invalid.");
  if (!registry.agents || typeof registry.agents !== "object" || Array.isArray(registry.agents)) {
    throw new Error("Agent registry agents index is invalid.");
  }
  if (!registry.nameIndex || typeof registry.nameIndex !== "object" || Array.isArray(registry.nameIndex)) {
    throw new Error("Agent registry name index is invalid.");
  }
  const expectedNames = {};
  const normalizedAgents = {};
  for (const [agentId, agent] of Object.entries(registry.agents)) {
    if (agentId !== agent.agentId) throw new Error("Agent registry ID index is invalid.");
    const normalizedAgent = agent.version === AGENT_RECORD_VERSION_V3
      ? agent
      : { ...agent, delegationMode: agent.delegationMode ?? "leaf" };
    validateAgent(normalizedAgent, root, workspaceRoot);
    if (expectedNames[normalizedAgent.normalizedName]) throw new Error("Agent registry contains duplicate normalized names.");
    expectedNames[normalizedAgent.normalizedName] = agentId;
    normalizedAgents[agentId] = normalizedAgent;
  }
  if (JSON.stringify(Object.keys(expectedNames).sort()) !== JSON.stringify(Object.keys(registry.nameIndex).sort())) {
    throw new Error("Agent registry name index does not match records.");
  }
  for (const [name, agentId] of Object.entries(registry.nameIndex)) {
    if (expectedNames[name] !== agentId) throw new Error("Agent registry name index entry is invalid.");
  }
  return {
    ...registry,
    agents: normalizedAgents,
    protection: registry.protection ?? protection(directory),
  };
}

/**
 * Canonical `(harnessId, instanceKey, nativeSessionId)` binding identity. For
 * Claude Code this reproduces the version-1 `(config dir, session)` digest, so
 * a runtime on either schema resolves the same ownership record.
 */
function sessionBindingKey(reference) {
  return harnessSessionKey(reference);
}

function layout(cwd, rootThreadId) {
  const root = assertText(rootThreadId, "owner root ID");
  const pluginStateRoot = resolvePluginStateRoot();
  const base = path.join(pluginStateRoot, workspaceHash(cwd), REGISTRY_DIRECTORY);
  const rootDirectory = path.join(base, ROOTS_DIRECTORY, rootHash(root));
  return {
    base,
    rootDirectory,
    registryFile: path.join(rootDirectory, REGISTRY_FILE),
    // A native Claude session can be resumed from another workspace. Bind it
    // once for the whole checkout runtime, matching the global session lease
    // scope rather than accidentally duplicating authority per workspace.
    sessionsDirectory: path.join(pluginStateRoot, SESSIONS_DIRECTORY),
  };
}

/**
 * The durable directory backing one root's Agent registry, mailbox included.
 *
 * Exported read-only so a durable-wake waiter -- the internal version-three
 * worker's mailbox loop -- can add it to `waitForDurableActivity()`'s
 * `desiredPaths` without reaching into this module's private layout. It
 * resolves the same live, env-configured production state root every other
 * call here uses, creates nothing, and confers no write authority: a wake hint
 * is never a lifecycle source, so the waiter must still reread the mailbox
 * through this store.
 */
export function resolveAgentRegistryDirectory({ cwd, ownerRootId }) {
  return layout(assertText(cwd, "workspace cwd"), ownerRootId).rootDirectory;
}

function readRegistry(cwd, rootThreadId, create = false) {
  const workspaceRoot = canonicalWorkspace(cwd);
  const paths = layout(cwd, rootThreadId);
  const directory = create ? ensureDirectory(paths.rootDirectory) : paths.rootDirectory;
  try {
    return validateRegistry(JSON.parse(fs.readFileSync(paths.registryFile, "utf8")), rootThreadId, workspaceRoot, directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether one durable Agent record belongs to the writing generation.
 *
 * A generation may always read and validate a record it does not own; it may
 * never change one. Version three is owned by the dependent multi-Harness
 * generation, so the current public generation is fenced out of it.
 */
/**
 * Whether one version-three Agent's turns run on the version-one supervisor.
 *
 * The public generation gives every new Agent a version-three identity record
 * while keeping two execution machines underneath it, and the Claude Harness
 * keeps the version-one supervisor because that machinery IS the Claude
 * contract: the job record, its stream-json progress, the exact-child
 * acceptance fence, and the resumable completion its adapter classifies.
 *
 * `runtime/harness-registry.mjs` states this rule for the whole runtime
 * (`harnessExecutionLifecycle`); this restates it in the one term the store
 * already knows, so the durable layer takes on no dependency on the Driver
 * graph. A test pins the two statements together.
 */
function versionOneLifecycleRecord(agent) {
  return agent?.version === AGENT_RECORD_VERSION_V3 &&
    agent?.route?.harnessId === CLAUDE_LEGACY_HARNESS_ID;
}

function isRecordWritableBy(record, generation) {
  if (record?.version !== AGENT_RECORD_VERSION_V3) return true;
  if (generation === FUTURE_WRITE_GENERATION) return true;
  // The public generation now states a whole route on every spawn, so it is the
  // generation that CREATES version-three Agents -- and for a route that runs on
  // the version-one supervisor it also owns the whole turn lifecycle: the
  // activation, its recovery, its reconciliation, and its terminal projection.
  // Fencing it out of those records would fence an Agent away from the only
  // machine that runs it. A version-three-worker route stays fenced: those
  // records are owned by the detached worker, and the public seam may read them
  // but never write one.
  return versionOneLifecycleRecord(record);
}

/**
 * The structural old-generation fence.
 *
 * Every Agent mutation in this module funnels through `withRegistry`, so the
 * fence is applied to the whole registry image rather than to a list of named
 * methods: any current or future helper is covered, and a fenced record must
 * come out of the mutation byte-identical or not exist on either side.
 */
function assertGenerationFence(before, after, generation) {
  const agentIds = new Set([
    ...Object.keys(before?.agents ?? {}),
    ...Object.keys(after?.agents ?? {}),
  ]);
  for (const agentId of agentIds) {
    const previous = before?.agents?.[agentId] ?? null;
    const next = after?.agents?.[agentId] ?? null;
    if (isRecordWritableBy(previous ?? next, generation)) continue;
    if (JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null)) {
      throw new Error(
        `The ${generation} generation cannot write version-three Agent state ` +
        `(${previous?.path ?? next?.path ?? agentId}); the record is readable but fenced.`
      );
    }
  }
  return after;
}

/**
 * Fail closed before advancing the turn lifecycle of a version-three Agent.
 * This generation owns no version-three job, control, or settlement semantics,
 * so activation, recovery, and session binding are refused rather than run
 * under version-one/two meanings.
 */
function assertVersionThreeLifecycleUnavailable(agent, operation) {
  if (agent?.version !== AGENT_RECORD_VERSION_V3) return agent;
  // A version-three record whose route runs the version-one supervisor uses
  // that supervisor's own lifecycle transitions. Refusing them here would fence
  // an Agent out of the only machine that can run it.
  if (versionOneLifecycleRecord(agent)) return agent;
  throw new Error(
    `Agent ${agent.path ?? agent.agentId} is a version-three record and the version-three ` +
    `turn lifecycle is not implemented in this generation; ${operation} is refused.`
  );
}

/**
 * The two version-three lifecycle transitions this checkout owns: activating
 * one turn and projecting its terminal receipt. Both belong to the internal
 * detached version-three worker, never to the public seven-operation
 * generation, so both restate the write-generation gate at their own seam.
 * The structural fence (`assertGenerationFence`) still refuses the resulting
 * registry image independently; this only fails closed earlier, before a
 * mailbox is assigned or a session is looked at.
 *
 * Every other version-three transition -- rollback, credential recovery,
 * native session binding, pre-Claude recovery -- stays refused by
 * `assertVersionThreeLifecycleUnavailable()`: this generation owns no honest
 * meaning for them.
 */
function assertVersionThreeLifecycleOwned(agent, generation, operation) {
  if (agent?.version !== AGENT_RECORD_VERSION_V3) return false;
  // A version-three record whose route runs the version-one supervisor is
  // created and driven by the generation that states its route, so its
  // activation and turn transitions belong to that generation too. The
  // structural fence still decides whether this particular generation may write
  // this particular record; this only refuses a version-three-WORKER record to
  // a generation that does not own the version-three turn machine.
  if (versionOneLifecycleRecord(agent)) return true;
  assertVersionThreeWriteAllowed(
    generation,
    `Version-three Agent ${agent.path ?? agent.agentId} ${operation}`
  );
  return true;
}

/**
 * The durable continuation of one version-three Agent, derived only from the
 * Driver's own transcript-continuation axis through the single owner in
 * `runtime/turn-settlement.mjs`.
 *
 * `safe_fresh` is never reachable here. It asserts that starting over is safe,
 * which is a side-effect fact about the execution world; a Driver that cannot
 * resume its transcript has said nothing about side effects. The exact-resume
 * pointer persists as the Driver's own bounded envelope -- it is never
 * flattened into a legacy `nativeSessionId`. Terminal projection also binds
 * that same validated envelope onto `agent.nativeSessionRef`, which is the
 * exact pointer the next version-three worker consumes.
 */
function versionThreeContinuation(job, agent) {
  const projection = classifyVersionThreeContinuation(job?.normalizedTerminalResult, agent.route);
  const lineage = {
    jobId: job.id,
    attemptId: job.attemptId == null ? null : assertText(job.attemptId, "Version-three receipt attempt ID"),
  };
  if (job?.nativeTurnRef != null) {
    const turnRef = assertNativeReferenceEnvelopeShape(job.nativeTurnRef, "Version-three receipt native turn reference");
    assertNativeReferenceLocatorShape(turnRef.locator, "Version-three receipt native turn locator");
    lineage.nativeTurnRef = clone(turnRef);
  }
  if (projection.mode !== "exact_session") {
    return continuation("blocked", { ...lineage, reason: projection.reason });
  }
  const sessionRef = assertNativeReferenceEnvelopeShape(
    projection.nativeSessionRef,
    "Version-three receipt native session reference"
  );
  assertNativeReferenceLocatorShape(sessionRef.locator, "Version-three receipt native session locator");
  return continuation("exact_session", {
    ...lineage,
    reason: projection.reason,
    nativeSessionRef: clone(sessionRef),
  });
}

/**
 * A version-three Agent may only be finalized by a receipt that proves it ran
 * this exact frozen route. Identity is checked before any session binding or
 * lifecycle advance, so a legacy or foreign receipt cannot bind a session,
 * publish a completion, or move continuation.
 */
function assertVersionThreeJobIdentity(job, agent) {
  const label = `Version-three Agent ${agent.path ?? agent.agentId}`;
  const stateVersion = jobDurableStateVersion(job);
  if (stateVersion !== AGENT_RECORD_VERSION_V3) {
    throw new Error(
      `${label} cannot be finalized by a receipt carrying durable state version ` +
      `${JSON.stringify(stateVersion)}; a version-three turn requires a version-three receipt.`
    );
  }
  if (job?.route == null) {
    throw new Error(`${label} requires a receipt that states its route identity.`);
  }
  const route = validateVersionThreeRoute(job.route, `${label} receipt route`);
  if (versionThreeRouteText(route) !== versionThreeRouteText(agent.route)) {
    throw new Error(`${label} receipt route identity does not match the Agent's frozen route.`);
  }
  for (const [field, observed, expected] of [
    ["Harness", job.harnessId, route.harnessId],
    ["logical instance", job.harnessInstanceKey, route.instanceKey],
    ["Driver version", job.driverVersion, route.driverVersion],
  ]) {
    if (observed != null && observed !== expected) {
      throw new Error(
        `${label} receipt route identity declares ${field} ${JSON.stringify(observed)}, not ${JSON.stringify(expected)}.`
      );
    }
  }
  return route;
}

function withRegistry(cwd, rootThreadId, generation, operation) {
  const paths = layout(cwd, rootThreadId);
  const directory = ensureDirectory(paths.rootDirectory);
  const lock = acquireLock(directory, "registry.lock");
  try {
    const workspaceRoot = canonicalWorkspace(cwd);
    const registry = readRegistry(cwd, rootThreadId, true) ?? defaultRegistry(rootThreadId, workspaceRoot, directory);
    const result = operation(registry, paths);
    if (!result || typeof result !== "object" || !("registry" in result)) {
      throw new Error("Agent registry mutation must return a registry result.");
    }
    const updated = {
      ...result.registry,
      version: AGENT_STORE_VERSION,
      rootThreadId: assertText(rootThreadId, "owner root ID"),
      rootHash: rootHash(rootThreadId),
      workspaceRoot,
      updatedAt: nowIso(),
      protection: protection(directory),
    };
    validateRegistry(updated, rootThreadId, workspaceRoot, directory);
    assertGenerationFence(registry, updated, generation);
    if (result.write !== false) writeAtomic(paths.registryFile, updated);
    return { ...result, registry: updated };
  } finally {
    releaseLock(lock);
  }
}

function publicAgent(agent) {
  const mailbox = agent.mailbox ?? { messages: [] };
  const nativeSessionRef = internalNativeSessionRef(agent);
  const versionThree = isVersionThree(agent);
  const route = interpretedRoute(agent);
  // The Claude Code projection of the neutral reference. Native history and
  // legacy model recovery still read these names; a version-three Agent never
  // has them, because no Claude meaning was ever recorded for it.
  const claudeSession = versionThree
    ? { claudeSessionId: null, claudeConfigDir: null }
    : legacyClaudeSessionProjection(nativeSessionRef);
  return {
    version: agent.version,
    agentId: agent.agentId,
    path: agent.path,
    name: agent.name,
    description: agent.description,
    harnessId: recordHarnessId(agent),
    route,
    driverVersion: versionThree ? route.driverVersion : agent.driverVersion ?? null,
    capabilities: versionThree ? route.capabilities : agent.capabilities ?? null,
    nativeSessionRef,
    selectedModel: versionThree ? route.model : agent.selectedModel ?? null,
    delegationMode: versionThree ? null : agent.delegationMode ?? "leaf",
    // Immutable behavioral facts exist only where version three froze them.
    ...(versionThree ? { topology: route.topology, authority: route.authority } : {}),
    rootThreadId: agent.rootThreadId,
    workspaceRoot: agent.workspaceRoot,
    activeJobId: agent.activeJobId,
    latestJobId: agent.latestJobId,
    ...claudeSession,
    status: agent.status,
    continuation: clone(agent.continuation),
    latestCompletionSequence: agent.latestCompletionSequence,
    mailbox: {
      nextSequence: mailbox.nextSequence,
      queuedCount: mailbox.messages.filter((message) => message.state === "queued").length,
      assignedCount: mailbox.messages.filter((message) => message.state === "assigned").length,
      dispatchedCount: mailbox.messages.filter((message) => message.state === "dispatched").length,
      acknowledgedCount: mailbox.messages.filter((message) => message.state === "acknowledged").length,
    },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function internalAgent(registry, target) {
  const reference = assertText(target, "Agent target");
  if (registry.agents[reference]) return registry.agents[reference];
  const byPath = Object.values(registry.agents).find((agent) => agent.path === reference);
  if (byPath) return byPath;
  const agentId = registry.nameIndex[normalizedName(reference)];
  if (agentId && registry.agents[agentId]) return registry.agents[agentId];
  throw new Error("No Agent with that exact ID, path, or name exists in this root.");
}

function continuation(mode, evidence) {
  return { mode, evidence: { ...evidence, observedAt: evidence?.observedAt ?? nowIso() } };
}

/**
 * The Harness contract a store may write. A read-only store (terminal session
 * binding, operator listing) needs only the interpretation of version-1 state;
 * a store that creates Agents must be given the resolved Driver's accepted
 * version and capability snapshot.
 */
function normalizeStoreHarness(harness, claudeConfigDir, generation) {
  const harnessId = harness == null
    ? CLAUDE_LEGACY_HARNESS_ID
    : assertHarnessId(harness.harnessId);
  const requestedInstanceKey = harness?.instanceKey ?? claudeConfigDir;
  // The version-three namespace is where a Claude configuration path and the
  // Driver's own redacted key must collapse onto one logical instance. A
  // future-generation store therefore resolves through the legacy adapter's
  // version-three mapping instead of `path.resolve()`-ing what is already a
  // redacted identity into a second, invented namespace.
  const instanceKey = generation === FUTURE_WRITE_GENERATION
    ? versionThreeInstanceKeyForHarness(harnessId, requestedInstanceKey)
    : canonicalInstanceKeyForHarness(harnessId, requestedInstanceKey);
  if (!harness) {
    return { harnessId: CLAUDE_LEGACY_HARNESS_ID, instanceKey, driverVersion: null, capabilities: null };
  }
  return {
    harnessId,
    instanceKey,
    driverVersion: harness.driverVersion == null
      ? null
      : assertText(harness.driverVersion, "Agent store Driver version"),
    capabilities: harness.capabilities == null
      ? null
      : validateHarnessCapabilities(harness.capabilities, "Agent store capability snapshot"),
  };
}

/**
 * A store that was not given a resolved Driver may read and bind existing
 * state, but it cannot create an Agent: there is no accepted contract to record.
 */
function creationHarnessContract(input, storeHarness) {
  for (const key of ["harnessId", "driverVersion", "capabilities"]) {
    if (input?.[key] != null) {
      throw new Error(
        `Agent creation does not accept ${key}; the resolved Agent store Driver contract is authoritative.`
      );
    }
  }
  const driverVersion = storeHarness.driverVersion;
  const capabilities = storeHarness.capabilities;
  if (!driverVersion || capabilities == null) {
    throw new Error(
      "Creating an Agent requires the resolved Harness Driver version and capability snapshot; " +
      "this Agent store was opened without one."
    );
  }
  return {
    driverVersion: assertText(driverVersion, "Agent Driver version"),
    capabilities: validateHarnessCapabilities(capabilities, "Agent capability snapshot"),
  };
}

/** The mailbox one newly created Agent starts with, in either schema. */
function initialMailbox(agentId, timestamp, initialMessage) {
  const text = initialMessage == null
    ? null
    : assertText(initialMessage, "Agent initial message");
  const messages = text == null
    ? []
    : [{
        version: AGENT_MAILBOX_VERSION,
        messageId: generatedMessageId(agentId, 1),
        agentId,
        sequence: 1,
        text,
        kind: "spawn_agent",
        state: "queued",
        assignedJobId: null,
        queuedAt: timestamp,
        assignedAt: null,
        deliveryIntent: null,
        dispatchedAt: null,
        acknowledgedAt: null,
      }];
  return { version: AGENT_MAILBOX_VERSION, nextSequence: messages.length + 1, messages };
}

/**
 * A version-three Agent record. Its identity is exactly the explicit route it
 * was created with: no Harness, instance, model, topology, or authority may be
 * defaulted, inferred from a legacy field, or back-filled later.
 */
function recordFromVersionThreeInput(input, rootThreadId, workspaceRoot) {
  if (input?.version != null && input.version !== AGENT_RECORD_VERSION_V3) {
    throw new Error(`Version-three Agent creation cannot write record version ${JSON.stringify(input.version)}.`);
  }
  if (input?.route == null) {
    throw new Error("Version-three Agent creation requires one explicit route.");
  }
  for (const field of LEGACY_IDENTITY_FIELDS) {
    if (input?.[field] != null) {
      throw new Error(
        `Version-three Agent creation does not accept ${field}; the explicit route is its only identity.`
      );
    }
  }
  const route = validateVersionThreeRoute(input.route, "Version-three Agent route");
  const name = displayName(input?.taskName ?? input?.task_name ?? input?.name);
  const timestamp = nowIso();
  const agentId = generatedAgentId();
  return {
    version: AGENT_RECORD_VERSION_V3,
    agentId,
    rootThreadId,
    workspaceRoot,
    name,
    normalizedName: normalizedName(name),
    path: agentPath(name),
    description: input?.description == null ? null : assertText(input.description, "Agent description"),
    route,
    activeJobId: null,
    latestJobId: null,
    nativeSessionRef: null,
    status: "pending_init",
    continuation: continuation("safe_fresh", { reason: "new_agent_no_session" }),
    latestCompletionSequence: 0,
    lastTerminalJobId: null,
    finalizedJobIds: [],
    mailbox: initialMailbox(agentId, timestamp, input?.initialMessage),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function recordFromInput(input, rootThreadId, workspaceRoot, storeHarness) {
  const name = displayName(input?.taskName ?? input?.task_name ?? input?.name);
  const timestamp = nowIso();
  const agentId = generatedAgentId();
  return {
    // New Agents are always written in the version-2 Harness-neutral schema.
    version: AGENT_RECORD_VERSION,
    agentId,
    rootThreadId,
    workspaceRoot,
    name,
    normalizedName: normalizedName(name),
    path: agentPath(name),
    description: input?.description == null ? null : assertText(input.description, "Agent description"),
    harnessId: storeHarness.harnessId,
    ...creationHarnessContract(input, storeHarness),
    selectedModel: input?.selectedModel == null
      ? null
      : assertText(input.selectedModel, "Agent selected model"),
    delegationMode: input?.delegationMode ?? "leaf",
    activeJobId: null,
    latestJobId: null,
    nativeSessionRef: null,
    status: "pending_init",
    continuation: continuation("safe_fresh", { reason: "new_agent_no_session" }),
    latestCompletionSequence: 0,
    lastTerminalJobId: null,
    finalizedJobIds: [],
    mailbox: initialMailbox(agentId, timestamp, input?.initialMessage),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeJobId(value) {
  return assertText(value, "Agent job ID");
}

function jobSessionId(job) {
  const value = job?.threadId ?? job?.result?.sessionId ?? job?.recoverability?.exactSessionId ?? null;
  return value == null ? null : assertText(value, "Claude session ID");
}

function jobContinuation(job, priorSession) {
  const recoverability = job?.recoverability ?? {};
  const exactSessionId = recoverability?.resumable && recoverability.mode === "exact_session"
    ? (recoverability.exactSessionId ?? jobSessionId(job))
    : null;
  if (exactSessionId) {
    if (priorSession && priorSession !== exactSessionId) {
      return continuation("blocked", {
        reason: "session_drift",
        expectedSessionId: priorSession,
        observedSessionId: exactSessionId,
        jobId: job.id,
      });
    }
    return continuation("exact_session", {
      reason: recoverability.reason ?? "terminal_exact_session",
      sessionId: exactSessionId,
      jobId: job.id,
    });
  }
  const noSideEffects = job?.safeFresh === true || job?.recoverability?.mode === "safe_fresh" || job?.result?.noSideEffects === true;
  if (noSideEffects) {
    return continuation("safe_fresh", {
      reason: recoverability.reason ?? "receipt_proven_safe_fresh",
      jobId: job.id,
    });
  }
  return continuation("blocked", {
    reason: recoverability.reason ?? job?.errorMessage ?? "terminal_turn_not_proven_resumable",
    jobId: job.id,
  });
}

/**
 * The only durable normalization a read-forward runtime performs, and it is
 * Claude-legacy-only: a terminal, unowned, model-proven version-1 record moves
 * to version 2 on its next safe write. Every other record — including every
 * version-three record — is returned exactly as it was stored.
 */
function normalizedTerminalRecord(agent, job) {
  if (!isLegacyAgentRecord(agent)) return agent;
  // The resolved record is this receipt's Agent; the adapter re-checks that
  // linkage, the terminal status, and the owning root before it migrates.
  return migrateLegacyTerminalRecord(agent, { ...job, agentId: agent.agentId });
}

/**
 * A Driver that does not declare exact continuation never produces an
 * exact-resume pointer. The accepted snapshot recorded on the Agent, not the
 * currently registered Driver, decides what its terminal session may claim.
 */
function acceptedContinuation(agent) {
  if (isVersionThree(agent)) return agent.route?.capabilities?.values?.continuation ?? null;
  return agent?.capabilities?.continuation ?? null;
}

function boundedContinuation(agent, next) {
  const accepted = acceptedContinuation(agent);
  if (next.mode !== "exact_session" || !accepted || accepted === "exact_resume") return next;
  return continuation("safe_fresh", {
    ...next.evidence,
    reason: "driver_continuation_fresh_only",
    acceptedContinuation: accepted,
  });
}

function lifecycleFromJob(job) {
  if (job.status === "completed") return "completed";
  if (job.status === "interrupted") return "interrupted";
  return "errored";
}

function updateMailboxMessages(agent, updater) {
  const mailbox = clone(agent.mailbox);
  const messages = updater(mailbox.messages);
  return { ...agent, mailbox: { ...mailbox, messages }, updatedAt: nowIso() };
}

function redactedAgent(agent) {
  return {
    agentId: agent.agentId,
    path: agent.path,
    name: agent.name,
    rootHash: rootHash(agent.rootThreadId),
    harnessId: recordHarnessId(agent),
    status: agent.status,
    delegationMode: isVersionThree(agent) ? null : agent.delegationMode ?? "leaf",
    activeJobId: agent.activeJobId,
    latestJobId: agent.latestJobId,
    continuation: { mode: agent.continuation.mode },
    updatedAt: agent.updatedAt,
  };
}

function listRootRegistryFiles(cwd) {
  const base = path.join(resolvePluginStateRoot(), workspaceHash(cwd), REGISTRY_DIRECTORY, ROOTS_DIRECTORY);
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, REGISTRY_FILE));
  } catch {
    return [];
  }
}

/**
 * Creates the sole Agent persistence seam used by the v0.2 runtime. ownerRootId
 * is a logical scope selected by the host bootstrap; it is not treated as a
 * security authorization primitive here.
 */
/**
 * @param {{ cwd?: string, ownerRootId?: string, claudeConfigDir?: string,
 *   harness?: { harnessId?: string, instanceKey?: string, driverVersion?: string,
 *   capabilities?: object }, writeGeneration?: string }} [options]
 */
export function createAgentStore({ cwd, ownerRootId, claudeConfigDir, harness, writeGeneration } = {}) {
  const workspace = assertText(cwd, "workspace cwd");
  const root = assertText(ownerRootId, "owner root ID");
  // The public seven-operation generation writes version two. Only the
  // dependent multi-Harness generation may create version-three records, and
  // only from a complete explicit route.
  const generation = normalizeWriteGeneration(writeGeneration);
  // The future generation states its Harness per Agent route, so a store it
  // opens without legacy instance evidence has no Claude default to fall back
  // on. It may still be given one in order to read existing legacy records.
  const neutralFutureStore = generation === FUTURE_WRITE_GENERATION &&
    harness == null &&
    claudeConfigDir == null;
  const storeHarness = neutralFutureStore
    ? null
    : normalizeStoreHarness(harness, claudeConfigDir, generation);

  /** Every Agent mutation goes through the generation-fenced registry seam. */
  function mutateRegistry(operation) {
    return withRegistry(workspace, root, generation, operation);
  }
  // A version-three instance key is a redacted identity, not a Claude
  // configuration directory, so the future generation offers no store-wide
  // legacy configuration default. A legacy session binding under that
  // generation must state its own instance evidence or fail closed.
  const defaultClaudeConfigDir = generation === FUTURE_WRITE_GENERATION
    ? null
    : storeHarness?.instanceKey ?? null;

  function getRegistry() {
    return readRegistry(workspace, root, false);
  }

  function createAgent(input = {}) {
    const requestsVersionThree = input?.route != null ||
      input?.version != null ||
      generation === FUTURE_WRITE_GENERATION;
    if (requestsVersionThree) {
      assertVersionThreeWriteAllowed(generation, "Version-three Agent creation");
    }
    const candidate = requestsVersionThree
      ? recordFromVersionThreeInput(input, root, canonicalWorkspace(workspace))
      : recordFromInput(input, root, canonicalWorkspace(workspace), storeHarness);
    const result = mutateRegistry((registry) => {
      const conflictId = registry.nameIndex[candidate.normalizedName];
      if (conflictId) {
        const conflict = registry.agents[conflictId];
        throw new Error(`Agent name ${JSON.stringify(candidate.name)} already belongs to ${conflict.path} (${conflict.agentId}).`);
      }
      const agents = { ...registry.agents, [candidate.agentId]: candidate };
      const nameIndex = { ...registry.nameIndex, [candidate.normalizedName]: candidate.agentId };
      return { registry: { ...registry, agents, nameIndex }, agent: candidate };
    });
    return publicAgent(result.agent);
  }

  function readAgent(target) {
    const registry = getRegistry();
    if (!registry) return null;
    try { return publicAgent(internalAgent(registry, target)); } catch { return null; }
  }

  function resolveTarget(target) {
    const agent = readAgent(target);
    if (!agent) throw new Error("No Agent with that exact ID, path, or name exists in this root.");
    return agent;
  }

  function listAgents(options = {}) {
    const requestedPrefix = options.pathPrefix == null
      ? null
      : assertText(options.pathPrefix, "Agent path prefix");
    const prefix = requestedPrefix === "/root" ? null : requestedPrefix;
    if (prefix != null) {
      if (!prefix.startsWith("/root/")) {
        throw new Error("Agent path prefix must be /root or begin with /root/.");
      }
      const segments = prefix === "/root/"
        ? []
        : prefix.slice("/root/".length).split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
        throw new Error("Agent path prefix must be /root or a non-relative /root/... path.");
      }
    }
    const registry = getRegistry();
    if (!registry) return [];
    return Object.values(registry.agents)
      .filter((agent) => prefix == null || agent.path.startsWith(prefix))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(publicAgent);
  }

  function listAllAgents() {
    return listRootRegistryFiles(workspace)
      .flatMap((filePath) => {
        try {
          const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
          return Object.values(registry.agents ?? {}).map(redactedAgent);
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.path.localeCompare(right.path) || left.agentId.localeCompare(right.agentId));
  }

  function updateAgent(target, updater) {
    if (typeof updater !== "function") throw new Error("Agent updater must be a function.");
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      const next = updater(clone(current));
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        throw new Error("Agent updater must return an Agent record.");
      }
      const immutable = [
        "version",
        "agentId",
        "rootThreadId",
        "workspaceRoot",
        "name",
        "normalizedName",
        "path",
        "delegationMode",
        "createdAt",
        // A version-2 Agent's Harness and model route are fixed at creation.
        // Version-1 records still allow the legacy model backfill to complete.
        ...(current.version === AGENT_RECORD_VERSION
          ? ["harnessId", "driverVersion", "selectedModel"]
          : []),
      ];
      for (const key of immutable) {
        if (next[key] !== current[key]) throw new Error(`Agent updater must not change immutable field ${key}.`);
      }
      if (
        current.version === AGENT_RECORD_VERSION &&
        HARNESS_CAPABILITY_NAMES.some(
          (name) => next.capabilities?.[name] !== current.capabilities?.[name]
        )
      ) {
        throw new Error("Agent updater must not change immutable field capabilities.");
      }
      if (current.version === AGENT_RECORD_VERSION_V3) {
        const frozen = versionThreeRouteText(current.route);
        let candidate = null;
        try {
          candidate = next.route == null ? null : versionThreeRouteText(next.route);
        } catch {
          candidate = null;
        }
        if (candidate !== frozen) {
          throw new Error("Agent updater must not change immutable field route.");
        }
      }
      const agent = { ...next, updatedAt: nowIso() };
      return { registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } }, agent };
    });
    return publicAgent(result.agent);
  }

  function rollbackReservation(target, options = {}) {
    const result = mutateRegistry((registry) => {
      const agent = internalAgent(registry, target);
      if (agent.version === AGENT_RECORD_VERSION_V3) {
        assertVersionThreeLifecycleOwned(agent, generation, "activation rollback");
      } else {
        assertVersionThreeLifecycleUnavailable(agent, "activation rollback");
      }
      if (
        agent.status !== "pending_init" ||
        agent.activeJobId ||
        agent.latestJobId ||
        internalNativeSessionRef(agent)
      ) {
        return { registry, write: false, rolledBack: false, reason: "agent_already_launched" };
      }
      const removableMessageId = options.removableMessageId == null
        ? null
        : assertText(options.removableMessageId, "Agent removable message ID");
      const soleRemovableMessage = agent.mailbox.messages.length === 1 &&
        removableMessageId != null &&
        agent.mailbox.messages[0].messageId === removableMessageId &&
        agent.mailbox.messages[0].state === "queued";
      if (
        agent.mailbox.messages.length > 0 &&
        !soleRemovableMessage &&
        options.dropQueuedMessages !== true
      ) {
        return { registry, write: false, rolledBack: false, reason: "queued_messages_present" };
      }
      const agents = { ...registry.agents };
      const nameIndex = { ...registry.nameIndex };
      delete agents[agent.agentId];
      delete nameIndex[agent.normalizedName];
      return { registry: { ...registry, agents, nameIndex }, rolledBack: true, reason: "prelaunch_reservation" };
    });
    return { rolledBack: Boolean(result.rolledBack), reason: result.reason ?? null };
  }

  function reserveActivation(target, jobId, options = {}) {
    const id = normalizeJobId(jobId);
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      assertVersionThreeLifecycleOwned(current, generation, "activation");
      if (current.activeJobId) {
        return { registry, write: false, reserved: false, reason: "already_active", agent: current, assignedMessages: [] };
      }
      if (current.continuation.mode === "blocked") {
        return { registry, write: false, reserved: false, reason: "continuation_blocked", agent: current, assignedMessages: [] };
      }
      if (current.status === "pending_init" && options.initial !== true) {
        return { registry, write: false, reserved: false, reason: "initial_turn_required", agent: current, assignedMessages: [] };
      }
      const activationReservedAt = nowIso();
      const assignedMessages = current.mailbox.messages
        .filter((message) => message.state === "queued")
        .map((message) => ({
          ...message,
          state: "assigned",
          assignedJobId: id,
          assignedAt: activationReservedAt,
          // This reservation is the durable handoff to jobs.start(prompt).
          // Reconciliation must never reinterpret these entries as stream
          // steering while the job is being published.
          deliveryIntent: "initial_prompt",
        }));
      const assignedById = new Map(assignedMessages.map((message) => [message.messageId, message]));
      const agent = updateMailboxMessages({
        ...current,
        activeJobId: id,
        latestJobId: current.latestJobId,
        status: "running",
        continuation: continuation(current.continuation.mode, {
          ...current.continuation.evidence,
          activationJobId: id,
          activationKind: options.initial === true ? "initial" : "followup",
          activationReservedAt,
          activationPreviousStatus: current.status,
          activationPreviousContinuation: clone(current.continuation),
        }),
      }, (messages) => messages.map((message) => assignedById.get(message.messageId) ?? message));
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        reserved: true,
        reason: null,
        agent,
        assignedMessages,
      };
    });
    return {
      reserved: Boolean(result.reserved),
      reason: result.reason,
      agent: publicAgent(result.agent),
      assignedMessages: clone(result.assignedMessages),
    };
  }

  /**
   * Restore one version-three activation only while its launch claim owns the
   * pre-submission rollback fence. Every unacknowledged message for the job,
   * including steering that raced the handoff, returns to the queue atomically.
   */
  function rollbackVersionThreeActivation(target, options = {}) {
    const id = normalizeJobId(options.jobId);
    const durableClaim = readLaunchClaim({ ownerRootId: root, agentId: assertText(target, "Agent target"), jobId: id });
    if (options.rollbackClaim == null) {
      if (durableClaim != null) {
        throw new Error("Unclaimed version-three activation rollback found a durable launch claim.");
      }
    } else if (
      durableClaim == null ||
      durableClaim.submissionState !== "rollback_in_progress" ||
      JSON.stringify(durableClaim) !== JSON.stringify(options.rollbackClaim)
    ) {
      throw new Error("Version-three activation rollback requires the exact durable rollback-in-progress claim.");
    }
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      assertVersionThreeLifecycleOwned(current, generation, "pre-submission activation rollback");
      if (current.activeJobId == null) {
        return { registry, write: false, restored: true, initial: false, agent: current };
      }
      if (current.activeJobId !== id) {
        return { registry, write: false, restored: false, reason: "agent_advanced", initial: false, agent: current };
      }
      const evidence = current.continuation?.evidence ?? {};
      if (evidence.activationJobId !== id || evidence.activationPreviousContinuation == null) {
        throw new Error(`Agent ${current.path} has no activation snapshot for job ${id}.`);
      }
      const messages = current.mailbox.messages.map((message) => {
        if (message.assignedJobId !== id) return message;
        if (message.state === "acknowledged") {
          throw new Error("Pre-submission rollback found an acknowledged mailbox message.");
        }
        const { receipt: _receipt, undeliveredEvidence: _undelivered, ...rest } = message;
        return {
          ...rest,
          state: "queued",
          assignedJobId: null,
          assignedAt: null,
          deliveryIntent: null,
          dispatchedAt: null,
          acknowledgedAt: null,
        };
      });
      const agent = {
        ...current,
        activeJobId: null,
        status: evidence.activationPreviousStatus,
        continuation: clone(evidence.activationPreviousContinuation),
        mailbox: { ...current.mailbox, messages },
        ...(current.liveTurnOwnership?.jobId === id ? { liveTurnOwnership: null } : {}),
        updatedAt: nowIso(),
      };
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        restored: true,
        initial: evidence.activationKind === "initial",
        agent,
      };
    });
    return {
      restored: Boolean(result.restored),
      reason: result.reason ?? null,
      initial: Boolean(result.initial),
      agent: readAgent(target),
    };
  }

  function recoverCredentialBlockedActivation(target, options = {}) {
    const failedJobId = normalizeJobId(options.failedJobId);
    const replacement = options.replacementCredential;
    if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) {
      throw new Error("Credential recovery requires a redacted replacement observation.");
    }
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      assertVersionThreeLifecycleUnavailable(current, "credential-blocked activation recovery");
      const currentRef = internalNativeSessionRef(current);
      const ownsFirstFailure =
        current.activeJobId == null &&
        current.latestJobId === failedJobId &&
        current.lastTerminalJobId === failedJobId &&
        current.latestCompletionSequence === 1 &&
        current.finalizedJobIds?.length === 1 &&
        current.finalizedJobIds[0] === failedJobId;
      if (!ownsFirstFailure) {
        return { registry, write: false, recovered: false, reason: "agent_advanced", agent: current };
      }
      if (
        current.status !== "errored" ||
        current.continuation.mode !== "blocked" ||
        current.continuation.evidence?.reason !== "auth_or_permission"
      ) {
        return { registry, write: false, recovered: false, reason: "not_auth_blocked", agent: current };
      }
      if (currentRef) {
        return { registry, write: false, recovered: false, reason: "native_session_present", agent: current };
      }
      let recoveredMessages = 0;
      const messages = current.mailbox.messages.map((message) => {
        if (message.assignedJobId !== failedJobId) {
          if (["assigned", "dispatched", "acknowledged"].includes(message.state)) {
            throw new Error("Credential recovery found mailbox ownership from another turn.");
          }
          return message;
        }
        if (!["assigned", "dispatched", "acknowledged"].includes(message.state)) {
          throw new Error("Credential recovery found an invalid failed-turn mailbox state.");
        }
        recoveredMessages += 1;
        const { receipt: _receipt, ...withoutReceipt } = message;
        return {
          ...withoutReceipt,
          state: "queued",
          assignedJobId: null,
          assignedAt: null,
          deliveryIntent: null,
          dispatchedAt: null,
          acknowledgedAt: null,
        };
      });
      if (recoveredMessages === 0) {
        return { registry, write: false, recovered: false, reason: "no_failed_turn_messages", agent: current };
      }
      const agent = {
        ...current,
        continuation: continuation("safe_fresh", {
          reason: "credential_refresh_proven_safe_fresh",
          failedJobId,
          configIdentity: replacement.configIdentity,
          credentialGeneration: clone(replacement.generation),
          accessExpiresAt: replacement.accessExpiresAt,
        }),
        mailbox: { ...current.mailbox, messages },
        updatedAt: nowIso(),
      };
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        recovered: true,
        reason: "credential_refresh_proven_safe_fresh",
        agent,
      };
    });
    return {
      recovered: Boolean(result.recovered),
      reason: result.reason ?? null,
      agent: publicAgent(result.agent),
    };
  }

  function enqueueMessage(target, text, options = {}) {
    const messageText = assertText(text, "Agent message");
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      if (current.continuation.mode === "blocked") {
        throw new Error(`Agent ${current.path} has blocked continuation and cannot accept an undeliverable message.`);
      }
      const sequence = current.mailbox.nextSequence;
      // The durable live-ownership barrier. While a turn is quiesced its
      // worker has already proven the native turn terminal and can no longer
      // deliver anything, so a new message must stay queued for the next turn
      // instead of binding to a turn that will never see it. This is read from
      // the durable record inside the registry lock, so a concurrent worker
      // settlement and a concurrent enqueue cannot interleave into a lost
      // message.
      const quiesced = current.liveTurnOwnership?.state === "quiesced"
        && current.liveTurnOwnership.jobId === current.activeJobId;
      const assignedJobId = quiesced ? null : current.activeJobId ?? null;
      const message = {
        version: AGENT_MAILBOX_VERSION,
        messageId: generatedMessageId(current.agentId, sequence),
        agentId: current.agentId,
        sequence,
        text: messageText,
        kind: options.kind ?? "message",
        state: assignedJobId ? "assigned" : "queued",
        assignedJobId,
        queuedAt: nowIso(),
        assignedAt: assignedJobId ? nowIso() : null,
        deliveryIntent: assignedJobId ? "steering" : null,
        dispatchedAt: null,
        acknowledgedAt: null,
      };
      const agent = updateMailboxMessages(current, (messages) => [...messages, message]);
      agent.mailbox.nextSequence = sequence + 1;
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        agent,
        message,
        delivery: assignedJobId ? "assigned_active" : "queued_no_turn",
      };
    });
    return { agent: publicAgent(result.agent), message: clone(result.message), delivery: result.delivery };
  }

  function assignQueuedMessages(target, jobId) {
    const id = normalizeJobId(jobId);
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      if (current.activeJobId !== id) throw new Error(`Agent ${current.path} is not active for job ${id}.`);
      const assigned = [];
      const agent = updateMailboxMessages(current, (messages) => messages.map((message) => {
        if (message.state !== "queued") return message;
        const next = {
          ...message,
          state: "assigned",
          assignedJobId: id,
          assignedAt: nowIso(),
          deliveryIntent: "steering",
        };
        assigned.push(next);
        return next;
      }));
      return { registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } }, agent, assigned };
    });
    return { agent: publicAgent(result.agent), assignedMessages: clone(result.assigned) };
  }

  function listMessages(target, options = {}) {
    const registry = getRegistry();
    if (!registry) return [];
    const agent = internalAgent(registry, target);
    const state = options.state == null ? null : assertText(options.state, "Agent mailbox state");
    if (state != null && !MESSAGE_STATES.has(state)) throw new Error(`Invalid Agent mailbox state: ${state}.`);
    return agent.mailbox.messages
      .filter((message) => state == null || message.state === state)
      .map((message) => clone(message));
  }

  function mutateMessage(target, messageReference, expectedState, nextState, options = {}) {
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      const reference = assertText(messageReference, "Agent message reference");
      const message = current.mailbox.messages.find((candidate) => candidate.messageId === reference || String(candidate.sequence) === reference);
      if (!message) throw new Error("No Agent mailbox message with that exact ID or sequence exists.");
      if (options.jobId != null && message.assignedJobId !== normalizeJobId(options.jobId)) {
        throw new Error("Agent mailbox message is assigned to a different job.");
      }
      if (message.state === nextState) {
        return { registry, write: false, agent: current, message, changed: false };
      }
      if (message.state !== expectedState) {
        throw new Error(`Agent mailbox message is ${message.state}; expected ${expectedState}.`);
      }
      const timestampField = nextState === "dispatched" ? "dispatchedAt" : "acknowledgedAt";
      const agent = updateMailboxMessages(current, (messages) => messages.map((candidate) => candidate.messageId === message.messageId
        ? { ...candidate, state: nextState, [timestampField]: nowIso(), ...(options.receipt ? { receipt: clone(options.receipt) } : {}) }
        : candidate));
      const changed = agent.mailbox.messages.find((candidate) => candidate.messageId === message.messageId);
      return { registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } }, agent, message: changed, changed: true };
    });
    return { agent: publicAgent(result.agent), message: clone(result.message), changed: result.changed };
  }

  function markMessageDispatched(target, messageReference, options = {}) {
    return mutateMessage(target, messageReference, "assigned", "dispatched", options);
  }

  function acknowledgeMessage(target, messageReference, options = {}) {
    return mutateMessage(target, messageReference, "dispatched", "acknowledged", options);
  }

  function sessionBindingPath(reference) {
    const paths = layout(workspace, root);
    return {
      directory: ensureDirectory(paths.sessionsDirectory),
      filePath: path.join(paths.sessionsDirectory, `${sessionBindingKey(reference)}.json`),
    };
  }

  function readSessionBinding(reference) {
    const descriptor = sessionBindingPath(reference);
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(descriptor.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (!SUPPORTED_SESSION_BINDING_VERSIONS.has(stored?.version)) {
      throw new Error(`Unsupported native session binding version: ${stored?.version}.`);
    }
    // A version-1 binding names only a Claude config directory and session.
    return interpretLegacySessionBinding(stored);
  }

  /**
   * Record the Agent's validated native session. A version-2 record owns the
   * neutral reference; a version-1 record keeps its Claude fields so an active
   * legacy worker is never rewritten into a schema it does not understand.
   */
  function applyAgentSessionRef(agent, reference) {
    if (agent.version === AGENT_RECORD_VERSION || agent.version === AGENT_RECORD_VERSION_V3) {
      return { ...agent, nativeSessionRef: reference };
    }
    return applyLegacyClaudeSessionRef(agent, reference);
  }

  function markSessionDrift(target, expectedSessionId, observedSessionId, jobId) {
    return updateAgent(target, (agent) => ({
      ...agent,
      activeJobId: agent.activeJobId === jobId ? null : agent.activeJobId,
      latestJobId: jobId ?? agent.latestJobId,
      status: "errored",
      continuation: continuation("blocked", {
        reason: "session_drift",
        expectedSessionId,
        observedSessionId,
        jobId,
      }),
    }));
  }

  function bindSession(target, sessionId, options = {}) {
    const session = assertText(sessionId, "native session ID");
    const jobId = normalizeJobId(options.jobId);
    const targetAgent = resolveTarget(target);
    assertVersionThreeLifecycleUnavailable(targetAgent, "native session binding");
    const harnessId = options.harnessId ?? targetAgent.harnessId;
    const frozenRoute = targetAgent.version === AGENT_RECORD_VERSION_V3 ? targetAgent.route : null;
    if (frozenRoute && harnessId !== frozenRoute.harnessId) {
      throw new Error(
        `Agent ${targetAgent.path} is frozen to Harness ${frozenRoute.harnessId}; ` +
        `a ${harnessId} session is rejected.`
      );
    }
    const requestedInstanceKey = options.instanceKey
      ?? options.claudeConfigDir
      ?? frozenRoute?.instanceKey
      ?? defaultClaudeConfigDir;
    if (requestedInstanceKey == null && generation === FUTURE_WRITE_GENERATION) {
      throw new Error(
        `Agent ${targetAgent.path} native session binding requires an explicit logical instance; ` +
        "this generation resolves no default Harness instance."
      );
    }
    if (frozenRoute && requestedInstanceKey !== frozenRoute.instanceKey) {
      throw new Error(
        `Agent ${targetAgent.path} is frozen to logical instance ${frozenRoute.instanceKey}; ` +
        `${JSON.stringify(requestedInstanceKey ?? null)} is rejected.`
      );
    }
    const reference = canonicalNativeSessionRef({
      harnessId,
      // Claude Code's instance key is a filesystem path, so the legacy adapter
      // canonicalizes it: a symlinked configuration directory must not produce
      // a second binding identity for one native session. Another Harness owns
      // its own canonical derivation and its key is taken verbatim.
      instanceKey: frozenRoute
        ? frozenRoute.instanceKey
        : canonicalInstanceKeyForHarness(harnessId, requestedInstanceKey),
      nativeSessionId: session,
    });
    if (targetAgent.activeJobId !== jobId && !(options.allowTerminal === true && targetAgent.activeJobId == null)) {
      throw new Error(`Agent ${targetAgent.path} is not active for job ${jobId}; session observation is rejected.`);
    }
    const priorSessionId = targetAgent.nativeSessionRef?.nativeSessionId ?? null;
    if (priorSessionId && priorSessionId !== session) {
      markSessionDrift(target, priorSessionId, session, jobId);
      throw new Error("Claude session drift detected; the prior Agent session pointer was preserved.");
    }
    const descriptor = sessionBindingPath(reference);
    const lock = acquireLock(descriptor.directory, `${path.basename(descriptor.filePath)}.lock`);
    try {
      const existing = readSessionBinding(reference);
      if (existing && (existing.rootThreadId !== root || existing.agentId !== targetAgent.agentId)) {
        throw new Error("Claude session is already bound to a different logical root or Agent.");
      }
      if (existing && existing.harnessId !== reference.harnessId) {
        throw new Error("Native session is already bound to a different Harness.");
      }
      const binding = existing ?? {
        version: AGENT_SESSION_BINDING_VERSION,
        key: sessionBindingKey(reference),
        harnessId: reference.harnessId,
        instanceKey: reference.instanceKey,
        nativeSessionId: reference.nativeSessionId,
        rootThreadId: root,
        agentId: targetAgent.agentId,
        createdAt: nowIso(),
      };
      writeAtomic(descriptor.filePath, { ...binding, updatedAt: nowIso() });
      const agent = updateAgent(targetAgent.agentId, (current) => {
        if (current.activeJobId !== jobId && !(options.allowTerminal === true && current.activeJobId == null)) {
          throw new Error(`Agent ${current.path} changed active job while binding a Claude session.`);
        }
        const currentRef = internalNativeSessionRef(current);
        if (currentRef && currentRef.nativeSessionId !== session) {
          throw new Error("Claude session drift detected during binding.");
        }
        return applyAgentSessionRef(current, reference);
      });
      return { binding: clone(binding), agent };
    } finally {
      releaseLock(lock);
    }
  }

  function finalizeFromJob(job) {
    if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("Agent terminal job must be an object.");
    if (!TERMINAL_JOB_STATUSES.has(job.status)) throw new Error(`Agent job ${job.id ?? "unknown"} is not terminal.`);
    const jobId = normalizeJobId(job.id);
    const target = assertText(job.agentId, "Agent-linked job agent ID");
    const agentBefore = resolveTarget(target);
    // Which terminal projection applies is decided by the RECEIPT's durable
    // generation, not by the Agent record's version. The two are independent
    // under the hybrid: a version-three Claude Agent's turns settle as
    // version-one supervisor jobs, and projecting those through the
    // version-three receipt path would demand a `normalizedTerminalResult` they
    // never carry. A version-three receipt still additionally requires a
    // version-three Agent and the generation that owns version-three turn
    // semantics, and both checks precede any session binding or lifecycle
    // advance.
    const versionThreeTerminal = jobDurableStateVersion(job) === JOB_STATE_VERSION_V3
      ? assertVersionThreeLifecycleOwned(agentBefore, generation, "terminal projection")
      : false;
    if (versionThreeTerminal) {
      // `assertVersionThreeJobIdentity()` requires durable state version three
      // exactly. `assertUnderstoodJobRecord()` deliberately still refuses that
      // version everywhere else -- the public job queue included -- so this
      // one seam, gated on both a version-three Agent and the internal write
      // generation, is the only place a version-three receipt is owned.
      assertVersionThreeJobIdentity(job, agentBefore);
    } else if (agentBefore.version === AGENT_RECORD_VERSION_V3) {
      // A version-one/two receipt may finalize a version-three Agent only when
      // that Agent's route runs the version-one supervisor -- the machine that
      // produced the receipt -- and only when the receipt names the very
      // Harness the route froze. A receipt from any other Harness has no
      // standing to speak for this route, whatever its durable generation.
      if (!versionOneLifecycleRecord(agentBefore)) {
        throw new Error(
          `Version-three Agent ${agentBefore.path} runs no version-one turn; ` +
          `job ${jobId} cannot finalize it.`
        );
      }
      const receiptHarnessId = job.harnessId ?? CLAUDE_LEGACY_HARNESS_ID;
      if (receiptHarnessId !== agentBefore.route.harnessId) {
        throw new Error(
          `Version-three Agent ${agentBefore.path} is frozen to Harness ${agentBefore.route.harnessId}; ` +
          `a ${receiptHarnessId} receipt is rejected.`
        );
      }
      assertUnderstoodJobRecord(job, "project");
    } else {
      // A receipt from a durable generation this runtime does not own cannot be
      // projected onto an Agent: its terminal, settlement, and session meanings
      // are defined elsewhere.
      assertUnderstoodJobRecord(job, "project");
    }
    // A version-three RECEIPT binds no legacy Claude session: its continuation
    // pointer is the Driver-validated envelope the receipt itself carries. A
    // version-one receipt binds one exactly as it always did, whatever version
    // the Agent record is, because that binding is the supervisor's own fact.
    const observedSessionId = versionThreeTerminal ? null : jobSessionId(job);
    let sessionBinding = null;
    let sessionBindingError = null;
    const candidateIsCurrent = agentBefore.activeJobId === jobId
      || (agentBefore.activeJobId == null && (agentBefore.latestJobId == null || agentBefore.latestJobId === jobId));
    const authenticationFailed =
      job?.result?.failureClass === "auth_or_permission" ||
      job?.recoverability?.reason === "auth_or_permission" ||
      job?.lastFailureClass === "auth_or_permission";
    if (candidateIsCurrent && observedSessionId && !agentBefore.nativeSessionRef && !authenticationFailed) {
      try {
        sessionBinding = bindSession(target, observedSessionId, {
          jobId,
          // A Claude config directory is legacy instance evidence; a
          // version-three Agent takes its instance only from its frozen route.
          ...(agentBefore.version === AGENT_RECORD_VERSION_V3
            ? {}
            : { claudeConfigDir: job.claudeConfigDir ?? defaultClaudeConfigDir }),
          allowTerminal: true,
        });
      } catch (error) {
        sessionBindingError = error instanceof Error ? error.message : String(error);
      }
    }
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      const finalizedJobIds = Array.isArray(current.finalizedJobIds)
        ? current.finalizedJobIds
        : (current.lastTerminalJobId ? [current.lastTerminalJobId] : []);
      if (current.lastTerminalJobId === jobId || finalizedJobIds.includes(jobId)) {
        return { registry, write: false, reconciled: false, reason: "already_finalized", agent: current };
      }
      const nextFinalizedJobIds = [...finalizedJobIds, jobId].slice(-FINALIZED_JOB_ID_LIMIT);
      const isCurrentTerminal = current.activeJobId === jobId
        || (current.activeJobId == null && (current.latestJobId == null || current.latestJobId === jobId));
      if (!isCurrentTerminal) {
        const agent = {
          ...current,
          finalizedJobIds: nextFinalizedJobIds,
          updatedAt: nowIso(),
        };
        return {
          registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
          reconciled: true,
          reason: "stale_terminal_recorded",
          agent,
        };
      }
      const nextContinuation = versionThreeTerminal
        ? versionThreeContinuation(job, current)
        : boundedContinuation(
          current,
          sessionBindingError
            ? continuation("blocked", {
                reason: "session_binding_conflict",
                jobId,
                detail: sessionBindingError,
              })
            : jobContinuation(job, internalNativeSessionRef(current)?.nativeSessionId ?? null),
        );
      const sessionBoundCurrent = versionThreeTerminal && nextContinuation.mode === "exact_session"
        ? applyAgentSessionRef(current, clone(nextContinuation.evidence.nativeSessionRef))
        : current;
      const blockedByIdentity = ["session_drift", "session_binding_conflict"]
        .includes(nextContinuation.evidence.reason);
      const agent = {
        ...normalizedTerminalRecord(
          {
            ...sessionBoundCurrent,
            activeJobId: current.activeJobId === jobId ? null : current.activeJobId,
          },
          job,
        ),
        activeJobId: current.activeJobId === jobId ? null : current.activeJobId,
        // The durable live-ownership marker exists only while a turn is being
        // settled. Once the terminal projection lands, this Agent has no live
        // turn at all and the marker must not outlive it -- a stale `quiesced`
        // marker would keep queueing messages that a later turn owns.
        ...(current.liveTurnOwnership?.jobId === jobId ? { liveTurnOwnership: null } : {}),
        latestJobId: jobId,
        lastTerminalJobId: jobId,
        finalizedJobIds: nextFinalizedJobIds,
        latestCompletionSequence: Number(current.latestCompletionSequence ?? 0) + 1,
        status: blockedByIdentity ? "errored" : lifecycleFromJob(job),
        continuation: nextContinuation,
        updatedAt: nowIso(),
      };
      return { registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } }, reconciled: true, reason: null, agent };
    });
    return {
      reconciled: Boolean(result.reconciled),
      reason: result.reason,
      agent: publicAgent(result.agent),
      sessionBinding: sessionBinding?.binding ?? null,
    };
  }

  function reconcileFromJobs(jobs) {
    if (!Array.isArray(jobs)) throw new Error("Agent reconciliation requires an array of jobs.");
    const receipts = [];
    for (const job of jobs) {
      if (!job?.agentId || !TERMINAL_JOB_STATUSES.has(job.status)) continue;
      // Foreign-root receipts are filtered before this root reports anything
      // about them, including that their durable generation is unreadable.
      if (job.ownerRootId && job.ownerRootId !== root) continue;
      if (!isUnderstoodJobRecord(job)) {
        receipts.push({
          jobId: job.id ?? null,
          reconciled: false,
          reason: "unsupported_job_state_version",
        });
        continue;
      }
      if (job.preClaudeLaunch === true) {
        const agent = readAgent(job.agentId);
        receipts.push({
          jobId: job.id,
          reconciled: false,
          reason: "pre_claude_diagnostic",
          agent,
        });
        continue;
      }
      if (job.agentProjectionReconciledAt) {
        receipts.push({
          jobId: job.id,
          reconciled: false,
          reason: "already_finalized",
          agent: resolveTarget(job.agentId),
        });
        continue;
      }
      try {
        receipts.push({ jobId: job.id, ...finalizeFromJob(job) });
      } catch (error) {
        receipts.push({
          jobId: job?.id ?? null,
          reconciled: false,
          reason: "reconciliation_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return receipts;
  }

  function recoverPreClaudeActivation(target, jobId) {
    const id = normalizeJobId(jobId);
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      assertVersionThreeLifecycleUnavailable(current, "pre-Claude activation recovery");
      const ownsActivation = current.activeJobId === id;
      const evidence = current.continuation?.evidence ?? {};
      const priorContinuation = evidence.activationPreviousContinuation;
      const priorStatus = evidence.activationPreviousStatus;
      let messagesChanged = false;
      const messages = current.mailbox.messages.map((message) => {
        if (
          message.assignedJobId !== id ||
          !["assigned", "dispatched", "acknowledged"].includes(message.state)
        ) {
          return message;
        }
        messagesChanged = true;
        const { receipt, ...withoutReceipt } = message;
        return {
          ...withoutReceipt,
          state: "queued",
          assignedJobId: null,
          assignedAt: null,
          deliveryIntent: null,
          dispatchedAt: null,
          acknowledgedAt: null,
        };
      });
      if (!ownsActivation && !messagesChanged) {
        return {
          registry,
          write: false,
          recovered: true,
          reason: "agent_already_advanced",
          agent: current,
        };
      }
      let restoredContinuation = current.continuation;
      if (ownsActivation) {
        if (priorContinuation) {
          restoredContinuation = validateContinuation(priorContinuation);
        } else {
          // Older prepared receipts predate the explicit snapshot but copied
          // the prior continuation evidence before appending activation
          // metadata. Strip only those metadata keys to recover that state.
          const legacyPrior = clone(current.continuation);
          for (const key of [
            "activationJobId",
            "activationKind",
            "activationReservedAt",
            "activationPreviousStatus",
            "activationPreviousContinuation",
          ]) {
            delete legacyPrior.evidence[key];
          }
          restoredContinuation = validateContinuation(legacyPrior);
        }
      }
      const restoredStatus = ownsActivation && AGENT_STATUSES.has(priorStatus)
        ? priorStatus
        : current.status;
      const agent = {
        ...current,
        ...(ownsActivation ? {
          activeJobId: null,
          status: restoredStatus,
          continuation: restoredContinuation,
        } : {}),
        mailbox: {
          ...current.mailbox,
          messages,
        },
        updatedAt: nowIso(),
      };
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        recovered: true,
        reason: ownsActivation ? "activation_restored" : "stale_messages_requeued",
        agent,
      };
    });
    return {
      recovered: Boolean(result.recovered),
      reason: result.reason ?? null,
      agent: publicAgent(result.agent),
    };
  }

  // -------------------------------------------------------------------------
  // Version-three live-turn ownership and mailbox recovery.
  //
  // These are the internal generation's own transitions. Each one restates the
  // version-three write gate at its seam and is refused outright for a
  // version-one/two record, whose undelivered-message recovery already has an
  // owner in `agent-runtime.mjs`.
  // -------------------------------------------------------------------------

  /**
   * Atomically stop being the live owner of one version-three turn.
   *
   * In a single registry mutation this:
   *
   *   1. marks the durable ownership `quiesced`, so any later `enqueueMessage()`
   *      queues instead of binding to this finished turn;
   *   2. requeues every entry still `assigned` to this job as *steering* --
   *      nothing was ever handed to the Harness for them, so they are owed to
   *      the next turn;
   *   3. retains every entry still `assigned` as `initial_prompt` -- those
   *      entries were carried in the launch prompt, so the Harness already has
   *      them and requeueing would replay work it may have done;
   *   4. leaves `dispatched` entries exactly where they are, pinned, because a
   *      delivery whose outcome is unknown must never be replayed.
   *
   * Steps 2 and 3 read the durable `deliveryIntent` the mailbox already
   * records, not a caller's claim about what was submitted.
   *
   * `activeJobId` deliberately stays set: the Agent must not become
   * activatable until its terminal projection lands, or a second turn could
   * start while this one is still publishing. On an unknown exit it stays set
   * permanently in this generation, which is the conservative outcome -- the
   * native turn's fate is unproven, so the Agent must not start another.
   */
  function quiesceVersionThreeTurn(target, jobId, options = {}) {
    const id = normalizeJobId(jobId);
    const attemptId = assertText(options.attemptId, "Version-three quiesce attempt ID");
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      if (!assertVersionThreeLifecycleOwned(current, generation, "live turn quiesce")) {
        throw new Error(
          `Agent ${current.path ?? current.agentId} is not a version-three record; live-turn quiesce ` +
          `is a version-three transition only.`
        );
      }
      if (current.activeJobId !== id) {
        return {
          registry, write: false, quiesced: false, reason: "not_active_owner",
          agent: current, requeuedMessageIds: [], retainedMessageIds: [], pinnedMessageIds: [],
        };
      }
      const requeuedMessageIds = [];
      const retainedMessageIds = [];
      const pinnedMessageIds = [];
      const messages = current.mailbox.messages.map((message) => {
        if (message.assignedJobId !== id) return message;
        if (message.state === "dispatched") {
          pinnedMessageIds.push(message.messageId);
          return message;
        }
        if (message.state !== "assigned") return message;
        if (message.deliveryIntent === "initial_prompt") {
          // Carried in the launch prompt, which crossed the native boundary
          // before this worker acknowledged anything. Never replayed.
          retainedMessageIds.push(message.messageId);
          return message;
        }
        requeuedMessageIds.push(message.messageId);
        const { receipt: _receipt, ...withoutReceipt } = message;
        return {
          ...withoutReceipt,
          state: "queued",
          assignedJobId: null,
          assignedAt: null,
          deliveryIntent: null,
          dispatchedAt: null,
          acknowledgedAt: null,
        };
      });
      const agent = updateMailboxMessages({
        ...current,
        liveTurnOwnership: { jobId: id, attemptId, state: "quiesced", updatedAt: nowIso() },
      }, () => messages);
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        quiesced: true,
        reason: null,
        agent,
        requeuedMessageIds,
        retainedMessageIds,
        pinnedMessageIds,
      };
    });
    return {
      quiesced: Boolean(result.quiesced),
      reason: result.reason ?? null,
      requeuedMessageIds: [...result.requeuedMessageIds],
      retainedMessageIds: [...result.retainedMessageIds],
      pinnedMessageIds: [...result.pinnedMessageIds],
      agent: publicAgent(result.agent),
    };
  }

  /**
   * Return one entry the Harness provably did not take to the queue, so the
   * next turn owes it again.
   *
   * Only proven non-delivery may use this: an explicit negative Driver receipt
   * or a capability that cannot deliver at all. A delivery whose outcome is
   * unknown must stay pinned instead (`pinUndeliveredMessage()`), because
   * requeueing it could replay something the Harness already acted on.
   */
  function requeueUndeliveredMessage(target, messageReference, options = {}) {
    const id = normalizeJobId(options.jobId);
    const evidence = assertText(options.reason, "Undelivered message requeue reason");
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      if (!assertVersionThreeLifecycleOwned(current, generation, "undelivered message requeue")) {
        throw new Error(
          `Agent ${current.path ?? current.agentId} is not a version-three record; undelivered-message ` +
          `recovery for it belongs to the current generation's own reconciler, not to this seam.`
        );
      }
      const reference = assertText(messageReference, "Agent message reference");
      const message = current.mailbox.messages.find((candidate) => candidate.messageId === reference);
      if (!message) throw new Error("No Agent mailbox message with that exact ID exists.");
      if (message.assignedJobId !== id) {
        throw new Error("Agent mailbox message is assigned to a different job.");
      }
      if (!["assigned", "dispatched"].includes(message.state)) {
        return { registry, write: false, requeued: false, reason: `state_${message.state}`, agent: current };
      }
      const agent = updateMailboxMessages(current, (messages) => messages.map((candidate) => {
        if (candidate.messageId !== message.messageId) return candidate;
        const { receipt: _receipt, ...withoutReceipt } = candidate;
        return {
          ...withoutReceipt,
          state: "queued",
          assignedJobId: null,
          assignedAt: null,
          deliveryIntent: null,
          dispatchedAt: null,
          acknowledgedAt: null,
          undeliveredEvidence: { reason: evidence, jobId: id, recordedAt: nowIso() },
        };
      }));
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        requeued: true, reason: evidence, agent,
      };
    });
    return { requeued: Boolean(result.requeued), reason: result.reason ?? null, agent: publicAgent(result.agent) };
  }

  /**
   * Pin one dispatched entry whose delivery outcome is unknown, with an
   * explicit durable fact. The entry is never consumed and never replayed;
   * this only makes the reason legible to a later reader instead of leaving a
   * bare `dispatched` state with no explanation.
   */
  function pinUndeliveredMessage(target, messageReference, options = {}) {
    const id = normalizeJobId(options.jobId);
    const reason = assertText(options.reason, "Pinned message reason");
    const result = mutateRegistry((registry) => {
      const current = internalAgent(registry, target);
      if (!assertVersionThreeLifecycleOwned(current, generation, "undelivered message pin")) {
        throw new Error(
          `Agent ${current.path ?? current.agentId} is not a version-three record; undelivered-message ` +
          `recovery for it belongs to the current generation's own reconciler, not to this seam.`
        );
      }
      const reference = assertText(messageReference, "Agent message reference");
      const message = current.mailbox.messages.find((candidate) => candidate.messageId === reference);
      if (!message) throw new Error("No Agent mailbox message with that exact ID exists.");
      if (message.assignedJobId !== id || message.state !== "dispatched") {
        return { registry, write: false, pinned: false, reason: `state_${message.state}`, agent: current };
      }
      const agent = updateMailboxMessages(current, (messages) => messages.map((candidate) => (
        candidate.messageId === message.messageId
          ? {
            ...candidate,
            receipt: { delivery: "unknown", reason, recordedAt: nowIso() },
          }
          : candidate
      )));
      return {
        registry: { ...registry, agents: { ...registry.agents, [agent.agentId]: agent } },
        pinned: true, reason, agent,
      };
    });
    return { pinned: Boolean(result.pinned), reason: result.reason ?? null, agent: publicAgent(result.agent) };
  }

  /** Read-only view of one version-three Agent's durable live-turn ownership. */
  function readVersionThreeTurnOwnership(target) {
    const registry = getRegistry();
    if (!registry) return null;
    const agent = internalAgent(registry, target);
    return agent?.liveTurnOwnership ? clone(agent.liveTurnOwnership) : null;
  }

  return Object.freeze({
    createAgent,
    readAgent,
    listAgents,
    listAllAgents,
    updateAgent,
    reserveActivation,
    rollbackVersionThreeActivation,
    recoverCredentialBlockedActivation,
    finalizeFromJob,
    enqueueMessage,
    listMessages,
    assignQueuedMessages,
    markMessageDispatched,
    acknowledgeMessage,
    bindSession,
    reconcileFromJobs,
    recoverPreClaudeActivation,
    quiesceVersionThreeTurn,
    requeueUndeliveredMessage,
    pinUndeliveredMessage,
    readVersionThreeTurnOwnership,
    rollbackReservation,
    resolveTarget,
    readSessionBinding,
    getProtection: () => protection(ensureDirectory(layout(workspace, root).rootDirectory)),
  });
}
