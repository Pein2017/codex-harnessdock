import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { projectAgentCard } from "../../runtime/agent-card.mjs";
import { createAgentStore } from "../../runtime/agent-store.mjs";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DRIVER_VERSION,
  CLAUDE_CODE_HARNESS_ID,
} from "../../runtime/claude-code-driver.mjs";
import {
  AGENT_RECORD_VERSION_V3,
  FUTURE_WRITE_GENERATION,
  PUBLIC_WRITE_GENERATION,
  UNDERSTOOD_JOB_STATE_VERSIONS,
  V3_ROUTE_FIELDS,
  sameDurableRouteSemantics,
  assertUnderstoodJobRecord,
  assertVersionThreeWriteAllowed,
  validateStoredVersionThreeRoute,
  validateVersionThreeRoute,
} from "../../runtime/durable-state-v3.mjs";
import {
  CAPABILITY_MATURITY_VALUES,
  validateRouteCapabilitySnapshot,
} from "../../runtime/harness-capabilities.mjs";
import { harnessSessionKey } from "../../runtime/harness-contract.mjs";
import {
  claimJobPublicProgress,
  cleanupOldJobs,
  listStoredJobs,
  markAgentProjectionReconciled,
  mutateJob,
  patchJob,
  readJobFile,
  reapStaleJobs,
  reconcileCompletionEvents,
  releaseSessionLease,
  reserveSessionLease,
  transitionJob,
  upsertJob,
  writeJobFile,
} from "../../runtime/job-store.mjs";

import {
  V3_DRIVER_VERSION,
  V3_HARNESS_ID,
  V3_INSTANCE_KEY,
  legacyVersionThreeAgentRecord,
  versionThreeAgentRecord,
  versionThreeCapabilities,
  versionThreeJobRecord,
  versionThreeRoute,
} from "./fixtures/version-three-state.mjs";

const HARNESS = {
  harnessId: CLAUDE_CODE_HARNESS_ID,
  driverVersion: CLAUDE_CODE_DRIVER_VERSION,
  capabilities: CLAUDE_CODE_CAPABILITIES,
};

const roots = [];
const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
});

function setup(ownerRootId = "codex-root-harness-migration") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-migration-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, "claude");
  fs.mkdirSync(workspace);
  fs.mkdirSync(claudeConfigDir);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "runtime-home");
  return {
    root,
    workspace,
    claudeConfigDir,
    ownerRootId,
    store: createAgentStore({ cwd: workspace, ownerRootId, claudeConfigDir, harness: HARNESS }),
  };
}

function registryFile(root) {
  const pending = [process.env.CODEX_HARNESSDOCK_RUNTIME_HOME];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.name === "registry.json") return candidate;
    }
  }
  throw new Error(`No Agent registry was created under ${root}.`);
}

function rewriteAgent(root, agentId, mutate) {
  const filePath = registryFile(root);
  const registry = JSON.parse(fs.readFileSync(filePath, "utf8"));
  registry.agents[agentId] = mutate(registry.agents[agentId]);
  fs.writeFileSync(filePath, JSON.stringify(registry));
  return registry.agents[agentId];
}

/** Rewrite an Agent as the version-1 record a pre-Harness runtime would own. */
function downgrade(root, agentId, patch = {}) {
  return rewriteAgent(root, agentId, (stored) => {
    const {
      harnessId: _harnessId,
      driverVersion: _driverVersion,
      capabilities: _capabilities,
      selectedEffort: _selectedEffort,
      nativeSessionRef,
      ...legacy
    } = stored;
    return {
      ...legacy,
      version: 1,
      ...(nativeSessionRef
        ? {
            claudeSessionId: nativeSessionRef.nativeSessionId,
            claudeConfigDir: nativeSessionRef.instanceKey,
          }
        : {}),
      ...patch,
    };
  });
}

function terminalJob(agent, id, overrides = {}) {
  return {
    id,
    agentId: agent.agentId,
    status: "completed",
    threadId: "native-session-1",
    harnessStateVersion: 2,
    harnessId: CLAUDE_CODE_HARNESS_ID,
    driverVersion: CLAUDE_CODE_DRIVER_VERSION,
    harnessCapabilities: CLAUDE_CODE_CAPABILITIES,
    harnessRoute: { harnessId: CLAUDE_CODE_HARNESS_ID, model: "claude-opus-5", effort: "xhigh" },
    recoverability: {
      resumable: true,
      mode: "exact_session",
      exactSessionId: "native-session-1",
      reason: "completed_exact_session",
    },
    ...overrides,
  };
}

describe("Harness-neutral durable state migration", () => {
  it("writes new Agents as version 2 with an immutable Harness route", () => {
    const { store } = setup();
    const agent = store.createAgent({
      task_name: "v2_agent",
      selectedModel: "claude-opus-5",
      selectedEffort: "xhigh",
      delegationMode: "leaf",
    });
    assert.equal(agent.version, 2);
    assert.equal(agent.harnessId, "claude-code");
    assert.equal(agent.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    assert.deepEqual(agent.capabilities, CLAUDE_CODE_CAPABILITIES);
    assert.deepEqual(agent.route, {
      harnessId: "claude-code",
      model: "claude-opus-5",
      delegationMode: "leaf",
    });
    assert.equal(Object.hasOwn(agent.route, "effort"), false);
    assert.equal(agent.nativeSessionRef, null);

    assert.throws(
      () => store.updateAgent(agent.agentId, (current) => ({ ...current, selectedModel: "claude-haiku-4-5" })),
      /must not change immutable field selectedModel/,
    );
    assert.throws(
      () => store.updateAgent(agent.agentId, (current) => ({ ...current, harnessId: "future-harness" })),
      /must not change immutable field harnessId/,
    );
    assert.throws(
      () => store.updateAgent(agent.agentId, (current) => ({ ...current, driverVersion: "claude-code@future" })),
      /must not change immutable field driverVersion/,
    );
    assert.throws(
      () => store.updateAgent(agent.agentId, (current) => ({
        ...current,
        capabilities: { ...current.capabilities, continuation: "fresh_only" },
      })),
      /must not change immutable field capabilities/,
    );
    assert.throws(
      () => store.createAgent({
        task_name: "forged_contract",
        selectedModel: "claude-opus-5",
        driverVersion: "claude-code@forged",
      }),
      /does not accept driverVersion/,
    );
  });

  it("interprets a valid version-1 record as Claude Code without rewriting it", () => {
    const { root, store } = setup();
    const created = store.createAgent({ task_name: "legacy_reader", selectedModel: "claude-sonnet-5" });
    store.reserveActivation(created.agentId, "job-legacy-1", { initial: true });
    store.bindSession(created.agentId, "legacy-session", { jobId: "job-legacy-1" });
    downgrade(root, created.agentId, { status: "completed", activeJobId: null, latestJobId: "job-legacy-1" });

    const read = store.readAgent(created.agentId);
    assert.equal(read.version, 1);
    assert.equal(read.harnessId, "claude-code");
    assert.equal(read.driverVersion, null);
    assert.equal(read.capabilities, null);
    assert.deepEqual(read.nativeSessionRef, {
      harnessId: "claude-code",
      instanceKey: read.claudeConfigDir,
      nativeSessionId: "legacy-session",
    });
    assert.equal(read.claudeSessionId, "legacy-session");
    assert.deepEqual(read.route, {
      harnessId: "claude-code",
      model: "claude-sonnet-5",
      delegationMode: "leaf",
    });

    // An unrelated durable write must leave the legacy record's schema alone.
    store.enqueueMessage(created.agentId, "still legacy");
    assert.equal(store.readAgent(created.agentId).version, 1);
  });

  it("never normalizes an active or ownership-uncertain version-1 record", () => {
    const { root, store } = setup();
    const active = store.createAgent({ task_name: "active_legacy", selectedModel: "claude-opus-5" });
    store.reserveActivation(active.agentId, "job-active-legacy", { initial: true });
    downgrade(root, active.agentId);
    assert.equal(store.readAgent(active.agentId).activeJobId, "job-active-legacy");

    // A terminal receipt for some *other* job arrives while the legacy worker
    // still owns the active turn: the record stays version 1.
    const stale = store.finalizeFromJob(terminalJob(active, "job-unrelated", { threadId: null, recoverability: null }));
    assert.equal(stale.reason, "stale_terminal_recorded");
    assert.equal(store.readAgent(active.agentId).version, 1);
    assert.equal(store.readAgent(active.agentId).activeJobId, "job-active-legacy");

    // Ownership-uncertain: the legacy model was never proven, so the record
    // must keep its mutable version-1 shape for later backfill.
    const unproven = store.createAgent({ task_name: "unproven_legacy", selectedModel: "claude-opus-5" });
    store.reserveActivation(unproven.agentId, "job-unproven", { initial: true });
    downgrade(root, unproven.agentId, { selectedModel: null });
    store.finalizeFromJob(terminalJob(unproven, "job-unproven"));
    assert.equal(store.readAgent(unproven.agentId).version, 1);
  });

  it("normalizes a terminal unowned version-1 record on its next safe write", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "terminal_legacy", selectedModel: "claude-opus-5" });
    store.reserveActivation(agent.agentId, "job-terminal-legacy", { initial: true });
    store.bindSession(agent.agentId, "native-session-1", { jobId: "job-terminal-legacy" });
    store.enqueueMessage(agent.agentId, "queued before migration");
    const legacy = downgrade(root, agent.agentId);
    assert.equal(legacy.version, 1);
    const beforeMailbox = store.readAgent(agent.agentId).mailbox.nextSequence;

    const finalized = store.finalizeFromJob(terminalJob(agent, "job-terminal-legacy"));
    assert.equal(finalized.reconciled, true);
    const migrated = store.readAgent(agent.agentId);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.agentId, agent.agentId);
    assert.equal(migrated.path, agent.path);
    assert.equal(migrated.rootThreadId, agent.rootThreadId);
    assert.equal(migrated.harnessId, "claude-code");
    assert.equal(migrated.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    assert.deepEqual(migrated.capabilities, CLAUDE_CODE_CAPABILITIES);
    assert.equal(migrated.selectedModel, "claude-opus-5");
    assert.equal(Object.hasOwn(migrated.route, "effort"), false);
    assert.deepEqual(migrated.nativeSessionRef, {
      harnessId: "claude-code",
      instanceKey: migrated.claudeConfigDir,
      nativeSessionId: "native-session-1",
    });
    assert.equal(migrated.continuation.mode, "exact_session");
    assert.equal(migrated.mailbox.nextSequence, beforeMailbox);
    assert.equal(store.listMessages(agent.agentId).length, 1);
  });

  it("keeps a version-1 record when its terminal job carries no Harness evidence", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "v1_job", selectedModel: "claude-opus-5" });
    store.reserveActivation(agent.agentId, "job-v1", { initial: true });
    downgrade(root, agent.agentId);
    const {
      harnessId: _harnessId,
      driverVersion: _driverVersion,
      harnessCapabilities: _capabilities,
      harnessStateVersion: _stateVersion,
      ...legacyJob
    } = terminalJob(agent, "job-v1");
    store.finalizeFromJob(legacyJob);
    assert.equal(store.readAgent(agent.agentId).version, 1);
    assert.equal(store.readAgent(agent.agentId).claudeSessionId, "native-session-1");
  });

  it("rejects an unknown record version instead of interpreting it", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "future", selectedModel: "claude-opus-5" });
    rewriteAgent(root, agent.agentId, (stored) => ({ ...stored, version: 4 }));
    assert.throws(() => store.listAgents(), /Unsupported Agent record version: 4/);
  });

  it("refuses a version-three record that is not a complete version-three record", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "half_migrated", selectedModel: "claude-opus-5" });
    // A version bump alone is not a migration: the version-two identity fields
    // are not a route, and nothing may be inferred from them.
    rewriteAgent(root, agent.agentId, (stored) => ({ ...stored, version: 3 }));
    assert.throws(() => store.listAgents(), /Version-three Agent .* route/);
  });

  it("rejects a native session reference owned by a different Harness", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "foreign_session", selectedModel: "claude-opus-5" });
    rewriteAgent(root, agent.agentId, (stored) => ({
      ...stored,
      nativeSessionRef: {
        harnessId: "future-harness",
        instanceKey: "tenant:alpha",
        nativeSessionId: "foreign-session",
      },
    }));
    assert.throws(
      () => store.readAgent(agent.agentId),
      /native session belongs to Harness future-harness, not claude-code/,
    );
  });

  it("preserves the prior native session reference when a resumed turn drifts", () => {
    const { store } = setup();
    const agent = store.createAgent({ task_name: "drift", selectedModel: "claude-opus-5" });
    store.reserveActivation(agent.agentId, "job-drift-1", { initial: true });
    store.bindSession(agent.agentId, "native-session-1", { jobId: "job-drift-1" });
    store.finalizeFromJob(terminalJob(agent, "job-drift-1"));

    store.reserveActivation(agent.agentId, "job-drift-2");
    const drifted = store.finalizeFromJob(terminalJob(agent, "job-drift-2", {
      threadId: "other-session",
      recoverability: {
        resumable: true,
        mode: "exact_session",
        exactSessionId: "other-session",
        reason: "completed_exact_session",
      },
    }));
    assert.equal(drifted.agent.status, "errored");
    assert.equal(drifted.agent.continuation.mode, "blocked");
    assert.equal(drifted.agent.continuation.evidence.reason, "session_drift");
    assert.deepEqual(store.readAgent(agent.agentId).nativeSessionRef, {
      harnessId: "claude-code",
      instanceKey: drifted.agent.claudeConfigDir,
      nativeSessionId: "native-session-1",
    });
  });

  it("reconciles the same terminal receipt idempotently and retains Agent metadata", () => {
    const { store } = setup();
    const agent = store.createAgent({
      task_name: "retention",
      selectedModel: "claude-opus-5",
      selectedEffort: "xhigh",
    });
    store.reserveActivation(agent.agentId, "job-retention", { initial: true });
    store.bindSession(agent.agentId, "native-session-1", { jobId: "job-retention" });
    const first = store.finalizeFromJob(terminalJob(agent, "job-retention"));
    assert.equal(first.reconciled, true);
    const second = store.finalizeFromJob(terminalJob(agent, "job-retention"));
    assert.equal(second.reconciled, false);
    assert.equal(second.reason, "already_finalized");
    assert.equal(
      store.readAgent(agent.agentId).latestCompletionSequence,
      first.agent.latestCompletionSequence,
    );

    // Detailed job receipts can be pruned; identity, route, Driver contract,
    // and the native session reference outlive them.
    const retained = store.readAgent(agent.agentId);
    assert.deepEqual(retained.route, {
      harnessId: "claude-code",
      model: "claude-opus-5",
      delegationMode: "leaf",
    });
    assert.deepEqual(retained.capabilities, CLAUDE_CODE_CAPABILITIES);
    assert.equal(retained.nativeSessionRef.nativeSessionId, "native-session-1");
    assert.equal(retained.continuation.mode, "exact_session");
  });

  it("canonicalizes a Claude instance key so one native session has one binding", () => {
    const { root, workspace, claudeConfigDir, ownerRootId, store } = setup();
    const linkedConfigDir = path.join(root, "claude-link");
    fs.symlinkSync(claudeConfigDir, linkedConfigDir);

    const agent = store.createAgent({ task_name: "symlinked", selectedModel: "claude-opus-5" });
    store.reserveActivation(agent.agentId, "job-symlink", { initial: true });
    // A legacy job receipt records a non-canonical config path; binding through
    // it must not create a second identity for the same native session.
    const bound = store.bindSession(agent.agentId, "linked-session", {
      jobId: "job-symlink",
      instanceKey: linkedConfigDir,
    });
    const canonicalConfigDir = fs.realpathSync.native(claudeConfigDir);
    assert.equal(bound.binding.instanceKey, canonicalConfigDir);
    assert.equal(
      bound.binding.key,
      harnessSessionKey({
        harnessId: "claude-code",
        instanceKey: canonicalConfigDir,
        nativeSessionId: "linked-session",
      }),
    );
    assert.equal(store.readAgent(agent.agentId).nativeSessionRef.instanceKey, canonicalConfigDir);

    // Another root reaching the same session through the canonical path is
    // still refused by the existing cross-root ownership guard.
    const other = createAgentStore({
      cwd: path.join(root, "workspace"),
      ownerRootId: `${ownerRootId}-other`,
      claudeConfigDir,
      harness: HARNESS,
    });
    const foreign = other.createAgent({ task_name: "foreign", selectedModel: "claude-opus-5" });
    other.reserveActivation(foreign.agentId, "job-foreign-symlink", { initial: true });
    assert.throws(
      () => other.bindSession(foreign.agentId, "linked-session", { jobId: "job-foreign-symlink" }),
      /already bound to a different logical root or Agent/,
    );
    assert.ok(workspace);
  });

  it("preserves a non-Claude Agent store instance key as Driver-owned opaque text", () => {
    const { root, workspace } = setup();
    const store = createAgentStore({
      cwd: workspace,
      ownerRootId: "codex-root-opaque-agent-instance",
      harness: {
        harnessId: "future-harness",
        instanceKey: "tenant:alpha",
        driverVersion: "future-harness@1",
        capabilities: CLAUDE_CODE_CAPABILITIES,
      },
    });
    const agent = store.createAgent({ task_name: "opaque_instance", selectedModel: "test-model" });
    store.reserveActivation(agent.agentId, "job-opaque-instance", { initial: true });
    const bound = store.bindSession(agent.agentId, "native-session", {
      jobId: "job-opaque-instance",
    });

    assert.equal(bound.binding.instanceKey, "tenant:alpha");
    assert.equal(store.readAgent(agent.agentId).nativeSessionRef.instanceKey, "tenant:alpha");
    assert.equal(
      bound.binding.key,
      harnessSessionKey({
        harnessId: "future-harness",
        instanceKey: "tenant:alpha",
        nativeSessionId: "native-session",
      }),
    );
    assert.equal(fs.existsSync(path.join(root, "tenant:alpha")), false);
  });

  it("never records an exact-resume pointer for a Driver without exact continuation", () => {
    const { root, store } = setup();
    const agent = store.createAgent({ task_name: "fresh_only", selectedModel: "claude-opus-5" });
    rewriteAgent(root, agent.agentId, (stored) => ({
      ...stored,
      capabilities: { ...CLAUDE_CODE_CAPABILITIES, continuation: "fresh_only" },
    }));
    store.reserveActivation(agent.agentId, "job-fresh-only", { initial: true });
    const finalized = store.finalizeFromJob(terminalJob(agent, "job-fresh-only"));
    assert.equal(finalized.agent.status, "completed");
    assert.equal(finalized.agent.continuation.mode, "safe_fresh");
    assert.equal(finalized.agent.continuation.evidence.reason, "driver_continuation_fresh_only");
    assert.equal(finalized.agent.continuation.evidence.acceptedContinuation, "fresh_only");
  });

  it("keys native session leases by Harness, instance, and session without colliding", () => {
    const { workspace, claudeConfigDir } = setup();
    const claudeInstance = { harnessId: "claude-code", instanceKey: claudeConfigDir };
    writeJobFile(workspace, "cc-lease-1", {
      id: "cc-lease-1",
      workspaceRoot: workspace,
      status: "running",
    });

    const lease = reserveSessionLease(workspace, claudeInstance, "shared-session", "cc-lease-1");
    assert.equal(lease.version, 2);
    assert.equal(lease.harnessId, "claude-code");
    assert.equal(lease.nativeSessionId, "shared-session");
    // A version-1 caller passing only the config directory resolves the same
    // lease rather than creating a second, stealable one.
    assert.equal(
      reserveSessionLease(workspace, claudeConfigDir, "shared-session", "cc-lease-1").key,
      lease.key,
    );
    assert.equal(
      lease.key,
      harnessSessionKey({
        harnessId: "claude-code",
        instanceKey: lease.instanceKey,
        nativeSessionId: "shared-session",
      }),
    );
    assert.notEqual(
      harnessSessionKey({
        harnessId: "future-harness",
        instanceKey: lease.instanceKey,
        nativeSessionId: "shared-session",
      }),
      lease.key,
    );
    writeJobFile(workspace, "cc-lease-future", {
      id: "cc-lease-future",
      workspaceRoot: workspace,
      status: "running",
    });
    const futureInstance = { harnessId: "future-harness", instanceKey: lease.instanceKey };
    const futureLease = reserveSessionLease(
      workspace,
      futureInstance,
      "shared-session",
      "cc-lease-future",
    );
    assert.notEqual(futureLease.key, lease.key);
    assert.equal(futureLease.harnessId, "future-harness");
    assert.throws(
      () => reserveSessionLease(workspace, claudeInstance, "shared-session", "cc-lease-2"),
      /already owned by active job cc-lease-1/,
    );
    assert.equal(releaseSessionLease(claudeInstance, "shared-session", "cc-lease-1"), true);
    assert.equal(releaseSessionLease(futureInstance, "shared-session", "cc-lease-future"), true);
    assert.equal(
      reserveSessionLease(workspace, claudeInstance, "shared-session", "cc-lease-2").jobId,
      "cc-lease-2",
    );
    releaseSessionLease(claudeInstance, "shared-session", "cc-lease-2");
  });

  it("preserves non-Claude Driver instance keys verbatim", () => {
    const { workspace } = setup();
    const instance = { harnessId: "future-harness", instanceKey: "tenant:alpha" };
    writeJobFile(workspace, "generic-lease", {
      id: "generic-lease",
      workspaceRoot: workspace,
      status: "running",
    });
    const lease = reserveSessionLease(workspace, instance, "session-1", "generic-lease");
    assert.equal(lease.harnessId, "future-harness");
    assert.equal(lease.instanceKey, "tenant:alpha");
    releaseSessionLease(instance, "session-1", "generic-lease");
  });

  it("refuses a native session lease that belongs to another Harness", () => {
    const { workspace, claudeConfigDir } = setup();
    const leaseFile = path.join(
      process.env.CODEX_HARNESSDOCK_RUNTIME_HOME,
      "state",
      "session-leases",
      `${harnessSessionKey({
        harnessId: "claude-code",
        instanceKey: fs.realpathSync.native(claudeConfigDir),
        nativeSessionId: "foreign-session",
      })}.json`,
    );
    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
    fs.writeFileSync(leaseFile, JSON.stringify({
      version: 2,
      harnessId: "future-harness",
      instanceKey: fs.realpathSync.native(claudeConfigDir),
      nativeSessionId: "foreign-session",
      sessionId: "foreign-session",
      jobId: "future-job",
      workspaceRoot: workspace,
    }));
    assert.throws(
      () => reserveSessionLease(
        workspace,
        { harnessId: "claude-code", instanceKey: claudeConfigDir },
        "foreign-session",
        "cc-lease-9",
      ),
      /owned by Harness future-harness, not claude-code/,
    );

    fs.writeFileSync(leaseFile, JSON.stringify({ version: 99, jobId: "future-job" }));
    assert.throws(
      () => reserveSessionLease(
        workspace,
        { harnessId: "claude-code", instanceKey: claudeConfigDir },
        "foreign-session",
        "cc-lease-9",
      ),
      /Unsupported native session lease version: 99/,
    );
  });
});

/** The exact durable key set a public-generation Agent record has always had. */
const V2_RECORD_KEYS = Object.freeze([
  "activeJobId",
  "agentId",
  "capabilities",
  "continuation",
  "createdAt",
  "delegationMode",
  "description",
  "driverVersion",
  "executionRoot",
  "finalizedJobIds",
  "harnessId",
  "lastTerminalJobId",
  "latestCompletionSequence",
  "latestJobId",
  "mailbox",
  "name",
  "nativeSessionRef",
  "normalizedName",
  "path",
  "rootThreadId",
  "selectedModel",
  "status",
  "updatedAt",
  "version",
  "workspaceRoot",
]);

function storedAgent(root, agentId) {
  const registry = JSON.parse(fs.readFileSync(registryFile(root), "utf8"));
  return registry.agents[agentId];
}

function futureStore(context) {
  return createAgentStore({
    cwd: context.workspace,
    ownerRootId: context.ownerRootId,
    writeGeneration: FUTURE_WRITE_GENERATION,
  });
}

describe("Version-three route identity", () => {
  it("canonicalizes one exact route and keeps the durable snapshot detached", () => {
    const source = versionThreeRoute();
    const canonical = validateVersionThreeRoute(source);

    assert.deepEqual(Object.keys(canonical), [...V3_ROUTE_FIELDS]);
    assert.deepEqual(V3_ROUTE_FIELDS, [
      "authority",
      "capabilities",
      "capabilitySchemaVersion",
      "driverVersion",
      "effort",
      "harnessId",
      "instanceKey",
      "model",
      "topology",
    ]);
    assert.equal(canonical.harnessId, V3_HARNESS_ID);
    assert.equal(canonical.instanceKey, V3_INSTANCE_KEY);
    assert.equal(canonical.driverVersion, V3_DRIVER_VERSION);
    assert.equal(canonical.topology, "leaf");
    assert.equal(canonical.authority, "behavioral_read_only");
    assert.equal(canonical.capabilitySchemaVersion, 4);
    assert.equal(canonical.capabilities.values.continuation, "exact_resume");

    // The snapshot is deep-frozen and deep-copied: no route fact may stay
    // aliased to Driver-owned or caller-owned state after validation.
    assert.equal(Object.isFrozen(canonical), true);
    assert.equal(Object.isFrozen(canonical.capabilities), true);
    assert.equal(Object.isFrozen(canonical.capabilities.values), true);
    assert.equal(Object.isFrozen(canonical.capabilities.maturity), true);
    source.capabilities.values.continuation = "fresh_only";
    source.model = "mutated";
    assert.equal(canonical.capabilities.values.continuation, "exact_resume");
    assert.equal(canonical.model, "fake-service-large");
    assert.throws(() => {
      "use strict";
      canonical.capabilities.values.continuation = "fresh_only";
    });
  });

  it("requires every identity field explicitly", () => {
    for (const field of V3_ROUTE_FIELDS) {
      const route = versionThreeRoute();
      delete route[field];
      assert.throws(
        () => validateVersionThreeRoute(route),
        new RegExp(`Version-three route.*${field}`),
        `missing ${field} must be refused`,
      );
      const nulled = versionThreeRoute({ [field]: null });
      assert.throws(
        () => validateVersionThreeRoute(nulled),
        new RegExp(`Version-three route.*${field}`),
        `null ${field} must be refused`,
      );
    }
  });

  it("refuses extra, unstable, or inspection-shaped route facts", () => {
    // Effective effort is admitted only as one bounded immutable route fact.
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ effort: "  xhigh" })),
      /effort/,
    );
    // The Driver's shallow-frozen `inspection.routes` facts must never be
    // carried forward into a durable route snapshot.
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ routes: { endpoint: "https://x" } })),
      /unknown field: routes/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ instanceKey: "Tenant Alpha" })),
      /stable redacted identity/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ model: "  " })),
      /model/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ model: "x".repeat(600) })),
      /bound/,
    );
    assert.throws(() => validateVersionThreeRoute(null), /must be an object/);
    assert.throws(() => validateVersionThreeRoute([versionThreeRoute()]), /must be an object/);
  });

  it("refuses accessor, Proxy, and prototype-polluted route objects", () => {
    const accessor = versionThreeRoute();
    let reads = 0;
    Object.defineProperty(accessor, "harnessId", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? V3_HARNESS_ID : "other-harness";
      },
    });
    assert.throws(() => validateVersionThreeRoute(accessor), /accessor/);

    const proxied = new Proxy(versionThreeRoute(), {
      get(target, key, receiver) {
        if (key === "model") return `drifting-${Math.random()}`;
        return Reflect.get(target, key, receiver);
      },
    });
    assert.throws(() => validateVersionThreeRoute(proxied), /Version-three route/);

    const polluted = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(versionThreeRoute()).slice(1)}`,
    );
    assert.throws(() => validateVersionThreeRoute(polluted), /prototype|unknown field/);

    const inherited = Object.create({ harnessId: V3_HARNESS_ID });
    for (const [key, value] of Object.entries(versionThreeRoute())) {
      if (key !== "harnessId") inherited[key] = value;
    }
    assert.throws(() => validateVersionThreeRoute(inherited), /prototype/);
    assert.equal({}.polluted, undefined);
  });

  it("refuses a Proxy before any trap can run and stays a canonical fixed point", () => {
    const traps = [];
    const zeroTrap = new Proxy(versionThreeRoute(), {});
    assert.throws(() => validateVersionThreeRoute(zeroTrap), /Proxy/);
    const observed = new Proxy(versionThreeRoute(), {
      get(target, key, receiver) {
        traps.push(String(key));
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        traps.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        traps.push("ownKeys");
        return Reflect.ownKeys(target);
      },
    });
    assert.throws(() => validateVersionThreeRoute(observed), /Proxy/);
    assert.deepEqual(traps, [], "no trap may run before a Proxy is refused");

    // A capability snapshot may not smuggle a Proxy either.
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({
        capabilities: new Proxy(versionThreeCapabilities(), {}),
      })),
      /Proxy/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({
        capabilities: { ...versionThreeCapabilities(), values: new Proxy(versionThreeCapabilities().values, {}) },
      })),
      /Proxy/,
    );

    // Canonical output is a fixed point: revalidating it changes nothing.
    const canonical = validateVersionThreeRoute(versionThreeRoute());
    const again = validateVersionThreeRoute(canonical);
    assert.deepEqual(again, canonical);
    assert.equal(JSON.stringify(again), JSON.stringify(canonical));
  });

  it("reads each route field exactly once from one descriptor snapshot", () => {
    // A plain (non-Proxy) alternating getter must never be observed twice, and
    // must never reach durable state.
    for (const field of ["model", "driverVersion", "harnessId", "capabilities"]) {
      const route = versionThreeRoute();
      const values = [route[field], "drifted"];
      let reads = 0;
      Object.defineProperty(route, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return values[Math.min(reads - 1, values.length - 1)];
        },
      });
      assert.throws(() => validateVersionThreeRoute(route), /accessor/, field);
      assert.ok(reads <= 1, `${field} must not be read through its accessor`);
    }

    const hidden = versionThreeRoute();
    Object.defineProperty(hidden, "model", {
      enumerable: false,
      configurable: true,
      writable: true,
      value: "hidden-model",
    });
    assert.throws(() => validateVersionThreeRoute(hidden), /enumerable/);

    const symbolKeyed = versionThreeRoute();
    symbolKeyed[Symbol("smuggled")] = "value";
    assert.throws(() => validateVersionThreeRoute(symbolKeyed), /symbol/i);
  });

  it("bounds route text in UTF-8 bytes and rejects unstable identity characters", () => {
    // 200 four-byte characters are far below the character bound and far above
    // the durable byte bound.
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ model: "𝄞".repeat(200) })),
      /bound/,
    );
    assert.equal(
      validateVersionThreeRoute(versionThreeRoute({ model: "𝄞".repeat(60) })).model,
      "𝄞".repeat(60),
    );
    // Surrounding whitespace is a different identity, not a normalizable one.
    for (const model of [" fake-service-large", "fake-service-large ", "fake\tservice"]) {
      assert.throws(
        () => validateVersionThreeRoute(versionThreeRoute({ model })),
        /whitespace|control|non-empty/,
        JSON.stringify(model),
      );
    }
    for (const driverVersion of [" fake-service@1", "fake-service@1\n"]) {
      assert.throws(
        () => validateVersionThreeRoute(versionThreeRoute({ driverVersion })),
        /whitespace|control|non-empty/,
        JSON.stringify(driverVersion),
      );
    }
    for (const hostile of ["fake\u0000service", "fake\u0007service", "fake\u009Fservice", "fake\u200Bservice", "fake\u202Eservice", "fake\uFEFFservice"]) {
      assert.throws(
        () => validateVersionThreeRoute(versionThreeRoute({ model: hostile })),
        /control|format|non-empty/,
        JSON.stringify(hostile),
      );
      assert.throws(
        () => validateVersionThreeRoute(versionThreeRoute({ driverVersion: hostile })),
        /control|format|non-empty/,
        JSON.stringify(hostile),
      );
    }
  });

  it("never lets a capability snapshot answer twice on the durable path", () => {
    const capabilities = versionThreeCapabilities();
    let maturityReads = 0;
    Object.defineProperty(capabilities, "driverMaturity", {
      enumerable: true,
      configurable: true,
      get() {
        maturityReads += 1;
        return maturityReads === 1 ? "experimental" : "definitely-not-a-maturity";
      },
    });
    assert.throws(() => validateVersionThreeRoute(versionThreeRoute({ capabilities })), /accessor/);
    // The accepted capability validator refuses the same shape directly, so the
    // durable seam is not the only thing standing between a Driver-supplied
    // snapshot and a record. Neither path may invoke the accessor.
    assert.throws(() => validateRouteCapabilitySnapshot(capabilities), /accessor/);
    assert.equal(maturityReads, 0);
    assert.equal(CAPABILITY_MATURITY_VALUES.includes(
      validateRouteCapabilitySnapshot(versionThreeCapabilities()).driverMaturity,
    ), true);
  });

  it("refuses capability, schema, and Driver drift inside one route", () => {
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ capabilitySchemaVersion: 1 })),
      /capability schema version/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({
        capabilities: versionThreeCapabilities({ capabilitySchemaVersion: 2 }),
      })),
      /capability schema version/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({
        capabilities: versionThreeCapabilities({ values: { continuation: "resumable" } }),
      })),
      /unsupported continuation value/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({
        capabilities: versionThreeCapabilities({ maturity: { continuation: "proven" } }),
      })),
      /unsupported continuation maturity/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ driverVersion: "  " })),
      /driverVersion/,
    );
  });

  it("reads a stored schema-v2 route without upgrading it, but refuses it for a new write", () => {
    const current = versionThreeRoute();
    const { provenance: _provenance, ...v2Capabilities } = current.capabilities;
    const v2Route = {
      ...current,
      capabilitySchemaVersion: 2,
      capabilities: { ...v2Capabilities, capabilitySchemaVersion: 2 },
    };
    assert.deepEqual(validateStoredVersionThreeRoute(v2Route), v2Route);
    assert.throws(() => validateVersionThreeRoute(v2Route), /capability schema version/);
  });

  it("compares a stored v2 route to a fresh v3 execution route without widening a value or maturity", () => {
    const current = versionThreeRoute();
    const { provenance: _provenance, ...v2Capabilities } = current.capabilities;
    const historical = {
      ...current,
      capabilitySchemaVersion: 2,
      capabilities: { ...v2Capabilities, capabilitySchemaVersion: 2 },
    };
    assert.equal(sameDurableRouteSemantics(historical, current), true);
    assert.equal(sameDurableRouteSemantics(historical, versionThreeRoute({
      capabilities: versionThreeCapabilities({ values: { continuation: "fresh_only" } }),
    })), false);
    assert.equal(sameDurableRouteSemantics(historical, versionThreeRoute({
      capabilities: versionThreeCapabilities({ maturity: { continuation: "validated" } }),
    })), false);
  });

  it("refuses legacy Claude vocabulary as version-three identity", () => {
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ topology: "claude_orchestrator" })),
      /topology/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ authority: "write" })),
      /authority/,
    );
    assert.throws(
      () => validateVersionThreeRoute(versionThreeRoute({ harnessId: "Claude Code" })),
      /Harness ID/,
    );
  });
});

describe("Version-three Agent write gate", () => {
  it("keeps the public seven-operation generation writing version-two records", () => {
    const context = setup();
    const agent = context.store.createAgent({
      task_name: "public_generation",
      selectedModel: "claude-opus-5",
      delegationMode: "leaf",
    });
    const stored = storedAgent(context.root, agent.agentId);
    assert.equal(stored.version, 2);
    assert.deepEqual(Object.keys(stored).sort(), [...V2_RECORD_KEYS]);
    assert.equal(Object.hasOwn(stored, "route"), false);
    assert.equal(stored.harnessId, "claude-code");
    assert.equal(stored.driverVersion, CLAUDE_CODE_DRIVER_VERSION);
    assert.deepEqual(stored.capabilities, CLAUDE_CODE_CAPABILITIES);

    // The public generation cannot state a version-three route at all.
    assert.throws(
      () => context.store.createAgent({ task_name: "smuggled", route: versionThreeRoute() }),
      /version-three/i,
    );
    assert.throws(
      () => context.store.createAgent({ task_name: "smuggled_version", version: 3 }),
      /version-three/i,
    );
    assert.throws(
      () => createAgentStore({
        cwd: context.workspace,
        ownerRootId: context.ownerRootId,
        writeGeneration: "some_other_generation",
      }),
      /write generation/,
    );
    assert.equal(assertVersionThreeWriteAllowed(FUTURE_WRITE_GENERATION), FUTURE_WRITE_GENERATION);
    assert.throws(
      () => assertVersionThreeWriteAllowed(PUBLIC_WRITE_GENERATION),
      /version-three/i,
    );
  });

  it("accepts only a fully explicit version-three creation from the future generation", () => {
    const context = setup();
    const store = futureStore(context);
    assert.throws(() => store.createAgent({ task_name: "no_route" }), /route/);
    for (const field of V3_ROUTE_FIELDS) {
      if (field === "effort") continue;
      const route = versionThreeRoute();
      delete route[field];
      assert.throws(
        () => store.createAgent({ task_name: `missing_${field.toLowerCase()}`, route }),
        new RegExp(field),
      );
    }
    // Version-three identity comes only from the route; no legacy field may
    // supply, shadow, or contradict it.
    for (const legacy of ["selectedModel", "delegationMode", "harnessId", "driverVersion", "capabilities"]) {
      assert.throws(
        () => store.createAgent({
          task_name: `legacy_${legacy.toLowerCase()}`,
          route: versionThreeRoute(),
          [legacy]: "claude-opus-5",
        }),
        new RegExp(legacy),
      );
    }

    const agent = store.createAgent({ task_name: "v3_agent", route: versionThreeRoute() });
    assert.equal(agent.version, AGENT_RECORD_VERSION_V3);
    assert.deepEqual(agent.route, validateVersionThreeRoute(versionThreeRoute()));
    assert.equal(agent.harnessId, V3_HARNESS_ID);
    assert.equal(agent.selectedModel, "fake-service-large");
    assert.equal(agent.topology, "leaf");
    assert.equal(agent.authority, "behavioral_read_only");
    assert.equal(agent.delegationMode, null);
    assert.equal(agent.claudeSessionId, null);
    assert.equal(agent.claudeConfigDir, null);
    assert.equal(agent.nativeSessionRef, null);

    const stored = storedAgent(context.root, agent.agentId);
    assert.equal(stored.version, 3);
    for (const legacy of ["harnessId", "driverVersion", "capabilities", "selectedModel", "delegationMode", "claudeSessionId", "claudeConfigDir"]) {
      assert.equal(Object.hasOwn(stored, legacy), false, `${legacy} must not exist on a version-three record`);
    }
  });

  it("keeps a pre-effort version-three Agent inspectable but refuses activation", () => {
    const context = setup();
    const store = futureStore(context);
    const created = store.createAgent({ task_name: "legacy_v3_effort", route: versionThreeRoute() });
    rewriteAgent(context.root, created.agentId, () => legacyVersionThreeAgentRecord({
      agentId: created.agentId,
      rootThreadId: created.rootThreadId,
      workspaceRoot: created.workspaceRoot,
      name: created.name,
      normalizedName: created.name,
      path: created.path,
    }));

    const inspected = store.readAgent(created.agentId);
    assert.equal(Object.hasOwn(inspected.route, "effort"), false);
    assert.equal(projectAgentCard(inspected, null).reasoning_effort, null);
    assert.throws(
      () => store.reserveActivation(created.agentId, "job-legacy-v3-effort", { initial: true }),
      /explicit.*effort|effort.*unknown/i,
    );
  });

  it("freezes the version-three route against every later write", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "frozen_route", route: versionThreeRoute() });
    for (const patch of [
      { model: "fake-service-small" },
      { authority: "behavioral_write" },
      { topology: "native_orchestrator" },
      { instanceKey: "tenant-beta" },
      { harnessId: "claude-code" },
      { driverVersion: "fake-service@2" },
    ]) {
      assert.throws(
        () => store.updateAgent(agent.agentId, (current) => ({
          ...current,
          route: { ...current.route, ...patch },
        })),
        /must not change immutable field route/,
      );
    }
    assert.throws(
      () => store.updateAgent(agent.agentId, (current) => {
        const { route: _route, ...rest } = current;
        return { ...rest, selectedModel: "claude-opus-5" };
      }),
      /route/,
    );
    assert.deepEqual(store.readAgent(agent.agentId).route, validateVersionThreeRoute(versionThreeRoute()));
  });

  it("never binds a native session to a version-three Agent in this generation", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "v3_session", route: versionThreeRoute() });

    // The internal generation now owns version-three activation (Task 5.4B),
    // but a native session pointer still has no version-one/two meaning here:
    // an active version-three turn continues to bind nothing.
    assert.equal(store.reserveActivation(agent.agentId, "job-v3-session", { initial: true }).reserved, true);
    const before = JSON.stringify(storedAgent(context.root, agent.agentId));
    for (const options of [
      { jobId: "job-v3-session" },
      { jobId: "job-v3-session", harnessId: "claude-code" },
      { jobId: "job-v3-session", instanceKey: "tenant-beta" },
      { jobId: "job-v3-session", allowTerminal: true },
    ]) {
      assert.throws(
        () => store.bindSession(agent.agentId, "native-session-1", options),
        /version-three turn lifecycle/i,
      );
    }
    const read = store.readAgent(agent.agentId);
    assert.equal(read.nativeSessionRef, null);
    assert.equal(read.claudeSessionId, null);
    assert.equal(read.claudeConfigDir, null);
    assert.equal(JSON.stringify(storedAgent(context.root, agent.agentId)), before);
    assert.equal(
      fs.existsSync(path.join(process.env.CODEX_HARNESSDOCK_RUNTIME_HOME, "state", "session-bindings")),
      false,
    );
    assert.equal(fs.existsSync(path.join(os.homedir(), ".claude", "projects", "tenant-alpha")), false);
  });

  it("refuses a stored version-three record that is malformed or Claude-shaped", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "stored_v3", route: versionThreeRoute() });

    for (const [mutation, pattern] of [
      [(stored) => ({ ...stored, route: { ...stored.route, extra: true } }), /unknown field: extra/],
      [(stored) => {
        const { capabilities: _capabilities, ...route } = stored.route;
        return { ...stored, route };
      }, /capabilities/],
      [(stored) => ({ ...stored, selectedModel: "claude-opus-5" }), /selectedModel/],
      [(stored) => ({ ...stored, claudeSessionId: "legacy", claudeConfigDir: "/tmp/claude" }), /claudeSessionId/],
      [(stored) => ({ ...stored, harnessId: "claude-code" }), /harnessId/],
      [(stored) => ({
        ...stored,
        nativeSessionRef: {
          harnessId: "claude-code",
          instanceKey: "/tmp/claude",
          nativeSessionId: "legacy-session",
        },
      }), /Harness claude-code/],
      [(stored) => ({
        ...stored,
        nativeSessionRef: {
          harnessId: V3_HARNESS_ID,
          instanceKey: "tenant-beta",
          nativeSessionId: "native-session-1",
        },
      }), /instance/],
    ]) {
      rewriteAgent(context.root, agent.agentId, mutation);
      assert.throws(() => store.listAgents(), pattern);
      rewriteAgent(context.root, agent.agentId, () => versionThreeAgentRecord({
        agentId: agent.agentId,
        rootThreadId: agent.rootThreadId,
        workspaceRoot: agent.workspaceRoot,
        name: agent.name,
        normalizedName: "stored_v3",
        path: agent.path,
      }));
      assert.equal(store.listAgents().length, 1);
    }
  });

  it("keeps version-one, version-two, and version-three records readable side by side", () => {
    const context = setup();
    const legacy = context.store.createAgent({ task_name: "legacy_peer", selectedModel: "claude-opus-5" });
    context.store.reserveActivation(legacy.agentId, "job-peer", { initial: true });
    context.store.bindSession(legacy.agentId, "legacy-session", { jobId: "job-peer" });
    downgrade(context.root, legacy.agentId, { status: "completed", activeJobId: null, latestJobId: "job-peer" });
    const neutral = context.store.createAgent({ task_name: "v2_peer", selectedModel: "claude-sonnet-5" });
    const store = futureStore(context);
    const future = store.createAgent({ task_name: "v3_peer", route: versionThreeRoute() });

    const byPath = new Map(store.listAgents().map((agent) => [agent.path, agent]));
    assert.equal(byPath.get(legacy.path).version, 1);
    assert.equal(byPath.get(legacy.path).harnessId, "claude-code");
    assert.equal(byPath.get(legacy.path).claudeSessionId, "legacy-session");
    assert.equal(byPath.get(neutral.path).version, 2);
    assert.equal(byPath.get(neutral.path).selectedModel, "claude-sonnet-5");
    assert.equal(byPath.get(future.path).version, 3);

    // Reading a version-three peer must not rewrite either legacy record.
    assert.equal(storedAgent(context.root, legacy.agentId).version, 1);
    assert.equal(storedAgent(context.root, neutral.agentId).version, 2);
    assert.equal(Object.hasOwn(storedAgent(context.root, neutral.agentId), "route"), false);
  });

  it("never applies the legacy Claude migration or model backfill to version three", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({
      task_name: "v3_terminal",
      route: versionThreeRoute({
        capabilities: versionThreeCapabilities({ values: { continuation: "fresh_only" } }),
      }),
    });
    const before = JSON.stringify(storedAgent(context.root, agent.agentId));
    // A Claude-shaped terminal receipt cannot convert the route, back-fill a
    // model, bind a session, or advance a lifecycle it never owned.
    assert.throws(
      () => store.finalizeFromJob({
        id: "job-v3-terminal",
        agentId: agent.agentId,
        status: "completed",
        threadId: "native-session-1",
        harnessStateVersion: 2,
        harnessId: CLAUDE_CODE_HARNESS_ID,
        driverVersion: CLAUDE_CODE_DRIVER_VERSION,
        harnessCapabilities: CLAUDE_CODE_CAPABILITIES,
        recoverability: {
          resumable: true,
          mode: "exact_session",
          exactSessionId: "native-session-1",
          reason: "completed_exact_session",
        },
      }),
      // The refusal is now stated in lifecycle terms: this route runs no
      // version-one turn, so no version-one/two receipt can speak for it.
      /runs no version-one turn/i,
    );
    const after = store.readAgent(agent.agentId);
    assert.equal(after.version, 3);
    assert.equal(after.route.harnessId, V3_HARNESS_ID);
    assert.equal(after.selectedModel, "fake-service-large");
    assert.equal(after.nativeSessionRef, null);
    assert.equal(after.continuation.mode, "safe_fresh");
    assert.equal(after.continuation.evidence.reason, "new_agent_no_session");
    assert.equal(after.latestCompletionSequence, 0);
    assert.equal(JSON.stringify(storedAgent(context.root, agent.agentId)), before);
    assert.equal(Object.hasOwn(storedAgent(context.root, agent.agentId), "harnessId"), false);
  });
});

describe("Version-three queue refusal and active-owner preservation", () => {
  it("refuses to own a durable job state version it cannot understand", () => {
    assert.deepEqual([...UNDERSTOOD_JOB_STATE_VERSIONS], [1, 2]);
    assert.equal(assertUnderstoodJobRecord({ id: "legacy", status: "running" }, "reap"), 1);
    assert.equal(
      assertUnderstoodJobRecord({ id: "v2", harnessStateVersion: 2, status: "running" }, "reap"),
      2,
    );
    assert.throws(
      () => assertUnderstoodJobRecord(versionThreeJobRecord(), "reap"),
      /state version 3/,
    );
    assert.throws(
      () => assertUnderstoodJobRecord({ id: "bogus", harnessStateVersion: "2" }, "reap"),
      /state version/,
    );
  });

  it("leaves a version-three job record intact instead of reaping or rewriting it", () => {
    const { workspace } = setup();
    const job = versionThreeJobRecord({
      id: "job-v3-active",
      ownerRootId: "codex-root-harness-migration",
      workspaceRoot: workspace,
      status: "running",
      agentId: "agent-v3",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    const jobFile = writeJobFile(workspace, job.id, job);
    const before = fs.readFileSync(jobFile, "utf8");

    // No PID and an unreadable version: an older reaper would call this a dead
    // worker and release it. The active owner must survive untouched.
    const reaped = reapStaleJobs(workspace, [readJobFile(workspace, job.id)]);
    assert.equal(reaped[0].status, "running");
    assert.equal(fs.readFileSync(jobFile, "utf8"), before);

    assert.throws(
      () => transitionJob(workspace, job.id, ["running"], "failed", { failureClass: "worker_reaped" }),
      /state version 3/,
    );
    assert.throws(() => patchJob(workspace, job.id, { status: "failed" }), /state version 3/);
    assert.throws(
      () => mutateJob(workspace, job.id, (current) => ({ ...current, status: "cancelled" })),
      /state version 3/,
    );
    assert.equal(fs.readFileSync(jobFile, "utf8"), before);

    cleanupOldJobs(workspace);
    assert.equal(fs.existsSync(jobFile), true);
    assert.equal(fs.readFileSync(jobFile, "utf8"), before);
    assert.equal(listStoredJobs(workspace).some((stored) => stored.id === job.id), true);
  });

  it("refuses every job write path for a record it cannot understand", () => {
    const { workspace } = setup();
    const job = versionThreeJobRecord({
      id: "job-v3-writes",
      ownerRootId: "codex-root-harness-migration",
      workspaceRoot: workspace,
      status: "running",
      agentId: "agent-v3",
      createdAt: "2026-08-13T00:00:00.000Z",
      publicProgress: { revision: 1, activity: "tool", updatedAt: "2026-08-13T00:00:01.000Z" },
    });
    const jobFile = writeJobFile(workspace, job.id, job);
    const before = fs.readFileSync(jobFile, "utf8");

    const writes = [
      ["mutateJob", () => mutateJob(workspace, job.id, (current) => ({ ...current, status: "cancelled" }))],
      ["patchJob", () => patchJob(workspace, job.id, { status: "failed" })],
      ["transitionJob", () => transitionJob(workspace, job.id, ["running"], "failed", {})],
      ["upsertJob", () => upsertJob(workspace, { id: job.id, status: "failed" })],
      ["claimJobPublicProgress", () => claimJobPublicProgress(workspace, job.id)],
      ["markAgentProjectionReconciled", () => markAgentProjectionReconciled(workspace, job.id)],
      ["writeJobFile", () => writeJobFile(workspace, job.id, { id: job.id, status: "failed" })],
    ];
    for (const [name, write] of writes) {
      assert.throws(write, /state version 3/, `${name} must refuse`);
      assert.equal(fs.readFileSync(jobFile, "utf8"), before, `${name} must not rewrite the record`);
    }

    // Sweeps observe without owning.
    reapStaleJobs(workspace, [readJobFile(workspace, job.id)]);
    reconcileCompletionEvents(workspace, [readJobFile(workspace, job.id)]);
    cleanupOldJobs(workspace);
    assert.equal(fs.readFileSync(jobFile, "utf8"), before);
  });

  it("leaves every understood job write path working", () => {
    const { workspace } = setup();
    writeJobFile(workspace, "job-v2-writes", {
      id: "job-v2-writes",
      harnessStateVersion: 2,
      ownerRootId: "codex-root-harness-migration",
      workspaceRoot: workspace,
      status: "running",
      publicProgress: { revision: 1, activity: "tool", updatedAt: "2026-08-13T00:00:01.000Z" },
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    assert.equal(claimJobPublicProgress(workspace, "job-v2-writes").claimed, true);
    assert.equal(patchJob(workspace, "job-v2-writes", { phase: "tool" }).phase, "tool");
    assert.equal(
      mutateJob(workspace, "job-v2-writes", (current) => ({ ...current, phase: "thinking" })).phase,
      "thinking",
    );
    assert.equal(upsertJob(workspace, { id: "job-v2-writes", sessionName: "kept" }).sessionName, "kept");
    assert.equal(
      transitionJob(workspace, "job-v2-writes", ["running"], "completed", {}).transitioned,
      true,
    );
    assert.equal(markAgentProjectionReconciled(workspace, "job-v2-writes").updated, true);
    // A legacy record with no durable version at all stays writable.
    writeJobFile(workspace, "job-v1-writes", {
      id: "job-v1-writes",
      workspaceRoot: workspace,
      status: "running",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    assert.equal(patchJob(workspace, "job-v1-writes", { phase: "tool" }).phase, "tool");
    assert.equal(writeJobFile(workspace, "job-v1-writes", {
      id: "job-v1-writes",
      workspaceRoot: workspace,
      status: "running",
    }).endsWith("job-v1-writes.json"), true);
  });

  it("keeps a terminal version-three receipt out of cleanup and completion rewriting", () => {
    const { workspace } = setup();
    const jobs = [];
    for (let index = 0; index < 12; index += 1) {
      const id = `job-v3-terminal-${index}`;
      jobs.push(id);
      writeJobFile(workspace, id, versionThreeJobRecord({
        id,
        ownerRootId: "codex-root-harness-migration",
        workspaceRoot: workspace,
        status: "completed",
        agentId: "agent-v3",
        createdAt: new Date(Date.UTC(2026, 7, 13, 0, index)).toISOString(),
        completedAt: new Date(Date.UTC(2026, 7, 13, 0, index)).toISOString(),
      }));
    }
    cleanupOldJobs(workspace);
    for (const id of jobs) {
      assert.equal(readJobFile(workspace, id)?.harnessStateVersion, 3, `${id} must be retained`);
    }
  });
});

/**
 * Every registry mutation the Agent store exposes, as a caller reaches it. The
 * fence under test is structural, so this table exists to prove the structure
 * holds for each surface — not to enumerate the surfaces the fence knows about.
 */
function publicMutations(store, agent, context) {
  return [
    ["updateAgent", () => store.updateAgent(agent.agentId, (current) => ({ ...current, status: "running" }))],
    ["reserveActivation", () => store.reserveActivation(agent.agentId, "job-fence-1", { initial: true })],
    ["rollbackReservation", () => store.rollbackReservation(agent.agentId, { dropQueuedMessages: true })],
    ["recoverPreClaudeActivation", () => store.recoverPreClaudeActivation(agent.agentId, "job-fence-1")],
    ["recoverCredentialBlockedActivation", () => store.recoverCredentialBlockedActivation(agent.agentId, {
      failedJobId: "job-fence-1",
      replacementCredential: { source: "api_key", state: "present" },
    })],
    ["enqueueMessage", () => store.enqueueMessage(agent.agentId, "public generation message")],
    ["assignQueuedMessages", () => store.assignQueuedMessages(agent.agentId, "job-fence-1")],
    ["markMessageDispatched", () => store.markMessageDispatched(agent.agentId, "1", { jobId: "job-fence-1" })],
    ["acknowledgeMessage", () => store.acknowledgeMessage(agent.agentId, "1", { jobId: "job-fence-1" })],
    ["bindSession", () => store.bindSession(agent.agentId, "native-session-1", { jobId: "job-fence-1" })],
    ["finalizeFromJob", () => store.finalizeFromJob({
      id: "job-fence-1",
      agentId: agent.agentId,
      status: "completed",
      threadId: "native-session-1",
      harnessStateVersion: 2,
      harnessId: CLAUDE_CODE_HARNESS_ID,
      driverVersion: CLAUDE_CODE_DRIVER_VERSION,
      harnessCapabilities: CLAUDE_CODE_CAPABILITIES,
    })],
    ["reconcileFromJobs", () => store.reconcileFromJobs([{
      id: "job-fence-2",
      agentId: agent.agentId,
      ownerRootId: context.ownerRootId,
      status: "completed",
      threadId: "native-session-2",
      harnessStateVersion: 2,
    }])],
  ];
}

describe("Old-generation Agent fence", () => {
  it("cannot change a pre-existing version-three Agent through any public mutation", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "fenced_v3", route: versionThreeRoute() });
    const before = JSON.stringify(storedAgent(context.root, agent.agentId));
    const publicStore = context.store;

    for (const [name, mutate] of publicMutations(publicStore, agent, context)) {
      let outcome = null;
      try {
        outcome = mutate();
      } catch (error) {
        outcome = error;
      }
      assert.equal(
        JSON.stringify(storedAgent(context.root, agent.agentId)),
        before,
        `${name} must leave the version-three record byte-identical`,
      );
      if (outcome instanceof Error) {
        assert.match(
          outcome.message,
          /version-three|version 3|not active|lifecycle|no Agent mailbox message/i,
          `${name} refusal must name the reason`,
        );
      }
    }
  });

  it("keeps legacy work available while a version-three Agent is fenced", () => {
    const context = setup();
    const future = futureStore(context);
    const fenced = future.createAgent({ task_name: "fenced_peer", route: versionThreeRoute() });
    const fencedBefore = JSON.stringify(storedAgent(context.root, fenced.agentId));

    // A public-generation write to its own version-two Agent still succeeds and
    // leaves the version-three record exactly as it was.
    const legacy = context.store.createAgent({ task_name: "legacy_peer", selectedModel: "claude-opus-5" });
    context.store.reserveActivation(legacy.agentId, "job-legacy-fence", { initial: true });
    context.store.enqueueMessage(legacy.agentId, "still works");
    context.store.finalizeFromJob(terminalJob(legacy, "job-legacy-fence"));
    assert.equal(context.store.readAgent(legacy.agentId).status, "completed");
    assert.equal(JSON.stringify(storedAgent(context.root, fenced.agentId)), fencedBefore);
    assert.equal(context.store.readAgent(fenced.agentId).version, 3);
    assert.equal(context.store.listAgents().length, 2);
  });

  it("routes every Agent mutation through the one fenced registry seam", () => {
    // The fence is structural, so this proves there is no second write path:
    // the registry file is written in exactly one place, that place is the
    // fenced seam, and no store method reaches it any other way.
    const source = fs.readFileSync(
      new URL("../../runtime/agent-store.mjs", import.meta.url),
      "utf8",
    );
    const registryWrites = source.match(/writeAtomic\(paths\.registryFile/g) ?? [];
    assert.equal(registryWrites.length, 1);
    const fencedSeam = source.match(/withRegistry\(/g) ?? [];
    // One declaration plus the single wrapper call inside the store closure.
    assert.equal(fencedSeam.length, 2);
    assert.match(source, /function mutateRegistry\(operation\) \{\s*return withRegistry\(workspace, root, generation, operation\);/);
    assert.match(source, /assertGenerationFence\(registry, updated, generation\);/);
  });

  it("refuses to add a version-three record from the public generation", () => {
    const context = setup();
    assert.throws(
      () => context.store.createAgent({ task_name: "smuggled", route: versionThreeRoute() }),
      /version-three/i,
    );
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "owned_v3", route: versionThreeRoute() });
    // Even a direct registry forgery is refused on the next public write: the
    // fence compares what the public generation may write, not what it meant.
    assert.equal(context.store.listAgents().find((entry) => entry.agentId === agent.agentId).version, 3);
  });
});

describe("Version-three turn lifecycle is owned only by the internal generation", () => {
  it("refuses recovery and session binding, and refuses activation from the public generation", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "v3_lifecycle", route: versionThreeRoute() });
    const before = JSON.stringify(storedAgent(context.root, agent.agentId));

    // Activation is owned by the internal generation only; the public
    // seven-operation store is refused at the seam, before the mailbox moves.
    assert.throws(
      () => context.store.reserveActivation(agent.agentId, "job-v3-life", { initial: true }),
      /cannot be written by the public/i,
    );
    assert.equal(JSON.stringify(storedAgent(context.root, agent.agentId)), before);

    for (const [name, mutate] of [
      ["recoverPreClaudeActivation", () => store.recoverPreClaudeActivation(agent.agentId, "job-v3-life")],
      ["recoverCredentialBlockedActivation", () => store.recoverCredentialBlockedActivation(agent.agentId, {
        failedJobId: "job-v3-life",
        replacementCredential: { source: "api_key", state: "present" },
      })],
      ["bindSession", () => store.bindSession(agent.agentId, "native-session-1", { jobId: "job-v3-life" })],
    ]) {
      assert.throws(mutate, /version-three turn lifecycle/i, `${name} must refuse`);
      assert.equal(JSON.stringify(storedAgent(context.root, agent.agentId)), before, name);
    }
    assert.equal(store.readAgent(agent.agentId).activeJobId, null);
    assert.equal(store.readAgent(agent.agentId).nativeSessionRef, null);
    assert.deepEqual(store.rollbackReservation(agent.agentId), {
      rolledBack: true,
      reason: "prelaunch_reservation",
    });
    assert.equal(store.readAgent(agent.agentId), null);
  });

  it("never finalizes a version-three Agent from a legacy or foreign receipt", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "v3_finalize", route: versionThreeRoute() });
    const before = JSON.stringify(storedAgent(context.root, agent.agentId));
    const card = projectAgentCard(store.readAgent(agent.agentId), null, { now: new Date() });

    // A Claude version-two receipt cannot speak for a fake-service route.
    assert.throws(
      () => store.finalizeFromJob({
        id: "job-v3-claude",
        agentId: agent.agentId,
        status: "completed",
        threadId: "native-session-1",
        harnessStateVersion: 2,
        harnessId: CLAUDE_CODE_HARNESS_ID,
        driverVersion: CLAUDE_CODE_DRIVER_VERSION,
        harnessCapabilities: CLAUDE_CODE_CAPABILITIES,
        recoverability: {
          resumable: true,
          mode: "exact_session",
          exactSessionId: "native-session-1",
          reason: "completed_exact_session",
        },
      }),
      /runs no version-one turn|route identity/i,
    );
    // A version-three receipt naming another instance is refused on identity.
    assert.throws(
      () => store.finalizeFromJob({
        id: "job-v3-foreign",
        agentId: agent.agentId,
        status: "completed",
        harnessStateVersion: 3,
        route: versionThreeRoute({ instanceKey: "tenant-beta" }),
      }),
      /route identity/i,
    );
    // A matching version-three receipt is refused for the public generation:
    // only the internal generation owns the version-three turn lifecycle.
    assert.throws(
      () => context.store.finalizeFromJob({
        id: "job-v3-matching",
        agentId: agent.agentId,
        status: "completed",
        harnessStateVersion: 3,
        route: versionThreeRoute(),
      }),
      /cannot be written by the public/i,
    );

    const after = store.readAgent(agent.agentId);
    assert.equal(JSON.stringify(storedAgent(context.root, agent.agentId)), before);
    assert.equal(after.nativeSessionRef, null);
    assert.equal(after.continuation.mode, "safe_fresh");
    assert.equal(after.latestCompletionSequence, 0);
    assert.equal(after.status, "pending_init");
    assert.deepEqual(projectAgentCard(after, null, { now: new Date() }), card);
    assert.equal(
      fs.existsSync(path.join(process.env.CODEX_HARNESSDOCK_RUNTIME_HOME, "state", "session-bindings")),
      false,
    );
  });

  it("projects a version-three terminal receipt without inferring safe_fresh", () => {
    const context = setup();
    const store = futureStore(context);
    const agent = store.createAgent({ task_name: "v3_project", route: versionThreeRoute() });
    assert.equal(store.reserveActivation(agent.agentId, "job-v3-project", { initial: true }).reserved, true);

    const nativeSessionRef = {
      version: 1,
      harnessId: V3_HARNESS_ID,
      driverVersion: V3_DRIVER_VERSION,
      instanceKey: V3_INSTANCE_KEY,
      locatorVersion: 1,
      locator: { sessionId: "service-session-7" },
    };
    const nativeTurnRef = { ...nativeSessionRef, locator: { sessionId: "service-session-7", turnId: "service-turn-7" } };
    const receipt = {
      id: "job-v3-project",
      agentId: agent.agentId,
      ownerRootId: context.ownerRootId,
      status: "completed",
      harnessStateVersion: 3,
      attemptId: "attempt-v3-project",
      route: versionThreeRoute(),
      nativeTurnRef,
      normalizedTerminalResult: {
        status: "completed",
        nativeTurn: "terminal",
        executionWorld: { continuity: "preserved", settlement: "settled" },
        continuation: { mode: "exact_resume", nativeSessionRef, evidence: { source: "service_turn_status" } },
      },
    };
    assert.equal(store.finalizeFromJob(receipt).reconciled, true);

    const after = store.readAgent(agent.agentId);
    assert.deepEqual(after.nativeSessionRef, nativeSessionRef);
    assert.equal(after.status, "completed");
    assert.equal(after.activeJobId, null);
    assert.equal(after.latestJobId, "job-v3-project");
    assert.equal(storedAgent(context.root, agent.agentId).lastTerminalJobId, "job-v3-project");
    // The Driver's own exact-resume envelope, not a flattened legacy session ID.
    assert.equal(after.continuation.mode, "exact_session");
    assert.equal(after.continuation.evidence.reason, "driver_proven_exact_resume");
    assert.deepEqual(after.continuation.evidence.nativeSessionRef, nativeSessionRef);
    assert.deepEqual(after.continuation.evidence.nativeTurnRef, nativeTurnRef);
    assert.equal(after.continuation.evidence.attemptId, "attempt-v3-project");
    assert.equal(after.continuation.evidence.jobId, "job-v3-project");
    // No Claude meaning is invented for a fake-service turn.
    assert.equal(after.claudeSessionId, null);
    assert.equal(
      fs.existsSync(path.join(process.env.CODEX_HARNESSDOCK_RUNTIME_HOME, "state", "session-bindings")),
      false,
    );

    // A Driver that cannot resume its transcript is blocked with its exact
    // reason -- never "safe_fresh", which would claim no side effect occurred.
    for (const [mode, reason] of [
      ["fresh_only", "driver_continuation_not_exact_resume"],
      ["none", "driver_continuation_not_exact_resume"],
      ["unknown", "driver_continuation_not_exact_resume"],
    ]) {
      const other = futureStore(context);
      const otherAgent = other.createAgent({ task_name: `v3_project_${mode}`, route: versionThreeRoute() });
      other.reserveActivation(otherAgent.agentId, `job-${mode}`, { initial: true });
      other.finalizeFromJob({
        ...receipt,
        id: `job-${mode}`,
        agentId: otherAgent.agentId,
        normalizedTerminalResult: {
          ...receipt.normalizedTerminalResult,
          continuation: { mode, evidence: { source: "service_turn_status" } },
        },
      });
      const projected = other.readAgent(otherAgent.agentId);
      assert.equal(projected.continuation.mode, "blocked", mode);
      assert.equal(projected.continuation.evidence.reason, reason, mode);
    }
  });

  it("skips a foreign root's unreadable receipt without reporting it", () => {
    const context = setup();
    const receipts = context.store.reconcileFromJobs([{
      id: "job-foreign-v3",
      agentId: "agent-elsewhere",
      ownerRootId: `${context.ownerRootId}-other`,
      status: "completed",
      harnessStateVersion: 3,
    }]);
    assert.deepEqual(receipts, []);
    // An owned unreadable receipt is still reported, without being projected.
    const owned = context.store.reconcileFromJobs([{
      id: "job-owned-v3",
      agentId: "agent-elsewhere",
      ownerRootId: context.ownerRootId,
      status: "completed",
      harnessStateVersion: 3,
    }]);
    assert.deepEqual(owned, [{
      jobId: "job-owned-v3",
      reconciled: false,
      reason: "unsupported_job_state_version",
    }]);
  });
});
