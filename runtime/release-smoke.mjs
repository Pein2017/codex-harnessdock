/** SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT,
  HARNESSDOCK_MCP_TOOL_NAMES,
  CODEX_SANDBOX_META_KEY,
  mcpExposedDescriptionCharacters,
  mcpProjectedModelVisibleCharacters,
} from "./mcp-server.mjs";
import { ADMITTED_GENERATION_HARNESS_IDS } from "./harness-registry.mjs";
import { createClaudeCodeDriver } from "./claude-code-driver.mjs";
import { createExecutionProfile } from "./execution-profile.mjs";
import { resolveRuntimeEnvironment } from "./environment.mjs";
import { resolveJobFile, resolveJobLogFile, writeJobFile } from "./job-store.mjs";
import { inspectCompatibilityShells, inspectInstalledPluginParity } from "./plugin-installation.mjs";
import { CANONICAL_RUNTIME_CHECKOUT, SOURCE_ROOT } from "./version.mjs";
import { CLAUDE_CODE_HARNESS_ID } from "./claude-code-driver.mjs";

const REAL_SMOKE_MODEL = "claude-haiku-4-5";
const REAL_SMOKE_EFFORT = "low";
const REAL_SMOKE_MAX_MS = 60 * 60 * 1000;
const NATIVE_TEAM_WITNESS_MEMORY_PREFIXES = Object.freeze([
  ".claude/agent-memory-local/haiku-scout",
  ".claude/agent-memory-local/sonnet",
]);
const MAX_NATIVE_TEAM_WITNESS_EVENTS = 32;
const MAX_NATIVE_TEAM_WITNESS_NAME_BYTES = 96;
const MAX_NATIVE_TEAM_WITNESS_PATHS = 16_384;
const SKILL_BYTES_LIMIT = 11_500;
const DEFAULT_PROMPT_CHARS_LIMIT = 800;
const SAFE_WITNESS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NATIVE_TEAM_WITNESS_JOB_ID = "native-team-witness";

function gitStatus(cwd) {
  const result = spawnSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Native-team witness requires a Git workspace.");
  return String(result.stdout ?? "");
}

function initializeWitnessWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hd-native-team-witness-"));
  const init = spawnSync("git", ["-C", cwd, "init", "--quiet"], { encoding: "utf8" });
  if (init.status !== 0) {
    fs.rmSync(cwd, { recursive: true, force: true });
    throw new Error("Native-team witness could not initialize its disposable Git workspace.");
  }
  fs.writeFileSync(path.join(cwd, "README.md"), "# Native Agent Team witness fixture\n", "utf8");
  for (const prefix of NATIVE_TEAM_WITNESS_MEMORY_PREFIXES) {
    fs.mkdirSync(path.join(cwd, prefix), { recursive: true });
  }
  return cwd;
}

function createWitnessSupervisorJob(workspaceRoot) {
  writeJobFile(workspaceRoot, NATIVE_TEAM_WITNESS_JOB_ID, {
    id: NATIVE_TEAM_WITNESS_JOB_ID,
    kind: "native_team_witness",
    kindLabel: "release-smoke",
    jobClass: "witness",
    title: "Native team witness",
    workspaceRoot,
    write: false,
    status: "running",
    phase: "starting_attempt",
    acceptingSteering: true,
  });
}

function removeWitnessSupervisorJob(workspaceRoot) {
  for (const target of [
    resolveJobFile(workspaceRoot, NATIVE_TEAM_WITNESS_JOB_ID),
    resolveJobLogFile(workspaceRoot, NATIVE_TEAM_WITNESS_JOB_ID),
  ]) {
    try { fs.rmSync(target, { force: true }); } catch {}
  }
}

function nativeMemoryPath(relative) {
  const normalized = String(relative ?? "").replaceAll("\\", "/");
  return normalized === ".claude/agent-memory-local" || normalized.startsWith(".claude/agent-memory-local/");
}

function snapshotWorkspacePaths(root, options = {}) {
  const snapshot = new Map();
  let overflow = false;
  const maxPaths = options.maxPaths ?? MAX_NATIVE_TEAM_WITNESS_PATHS;
  const visit = (relative) => {
    if (snapshot.size >= maxPaths) {
      overflow = true;
      return;
    }
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    const underNativeMemory = nativeMemoryPath(relative);
    const metadata = {
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      size: stat.size,
      mode: stat.mode,
    };
    if (!stat.isDirectory()) metadata.mtimeMs = stat.mtimeMs;
    // Native Auto/teammate memory is Claude-owned. Never open a file anywhere
    // in that subtree, including an unapproved third member; lstat/readdir
    // metadata is sufficient for the witness mutation gate.
    if (!underNativeMemory && stat.isFile()) {
      metadata.sha256 = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    }
    snapshot.set(relative || ".", metadata);
    // Never follow a symlink; a changed in-tree symlink is rejected below.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!relative && entry.name === ".git") continue;
      visit(relative ? path.join(relative, entry.name) : entry.name);
    }
  };
  visit("");
  return { paths: snapshot, overflow };
}

function changedSnapshotPaths(before, after) {
  const paths = new Set([...before.paths.keys(), ...after.paths.keys()]);
  return [...paths].filter((relative) => JSON.stringify(before.paths.get(relative) ?? null) !== JSON.stringify(after.paths.get(relative) ?? null)).sort();
}

function changedMemoryMetadata(before, after, paths) {
  return paths.map((relative) => Object.freeze({
    path: relative,
    before: before.paths.get(relative) ?? null,
    after: after.paths.get(relative) ?? null,
  }));
}

function nativeMemoryPathAllowed(relative) {
  const normalized = String(relative ?? "").replaceAll("\\", "/");
  return NATIVE_TEAM_WITNESS_MEMORY_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

function unsafeAllowedMemorySymlink(snapshot, relative) {
  return nativeMemoryPathAllowed(relative) && snapshot.paths.get(relative)?.type === "symlink";
}

function nativeMemorySnapshotHasSymlink(snapshot) {
  return [...snapshot.paths].some(([relative, metadata]) =>
    nativeMemoryPath(relative) && metadata.type === "symlink",
  );
}

function assertWitnessMemoryRoots(cwd) {
  for (const prefix of NATIVE_TEAM_WITNESS_MEMORY_PREFIXES) {
    let ancestor = cwd;
    for (const segment of prefix.split("/")) {
      ancestor = path.join(ancestor, segment);
      let stat;
      try {
        stat = fs.lstatSync(ancestor);
      } catch {
        throw new Error("Native-team witness memory ancestor must be an in-workspace directory.");
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(cwd, ancestor).startsWith("..")) {
        throw new Error("Native-team witness memory ancestor must be an in-workspace directory.");
      }
    }
  }
}

function safeWitnessName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && Buffer.byteLength(text, "utf8") <= MAX_NATIVE_TEAM_WITNESS_NAME_BYTES && SAFE_WITNESS_NAME.test(text)
    ? text : null;
}

function boundedWitnessEvent(fact) {
  if (!fact || typeof fact !== "object") return null;
  switch (fact.type) {
    case "native_team_member_requested":
    case "native_team_member_launched":
      return safeWitnessName(fact.memberName) && safeWitnessName(fact.memberType)
        ? { type: fact.type, memberName: safeWitnessName(fact.memberName), memberType: safeWitnessName(fact.memberType) }
        : null;
    case "native_team_surface":
      return { type: fact.type, observed: fact.observed === true };
    case "native_team_transport":
      return { type: fact.type, teamTransportLiveValidated: fact.teamTransportLiveValidated === true };
    case "native_team_message":
      return { type: fact.type, sameTeamRecipient: fact.sameTeamRecipient === true };
    case "native_team_parent_synthesis":
      return { type: fact.type };
    case "native_team_witness_overflow":
      return { type: fact.type };
    default:
      return null;
  }
}

/**
 * Run one explicitly selected native-team witness through the production
 * Driver/profile/adapter seam. The fake-test seam supplies `runTurnSession`;
 * it has no MCP, IPC, durable teammate state, or memory-content access.
 */
export async function runNativeTeamWitness(options = {}) {
  const sourceRoot = fs.realpathSync.native(options.sourceRoot ?? SOURCE_ROOT);
  const sourceBefore = gitStatus(sourceRoot);
  // Snapshots recurse through all native-memory paths for path-level mutation
  // evidence, but never open their contents.
  const sourceSnapshotBefore = snapshotWorkspacePaths(sourceRoot, { maxPaths: options.maxSnapshotPaths });
  const cwd = initializeWitnessWorkspace();
  let witnessSupervisorJobCreated = false;
  try {
    return await (async () => {
  // Internal fixture hook for zero-Claude tests; it is not routed from MCP.
  if (typeof options.prepareWorkspace === "function") options.prepareWorkspace(cwd);
  const before = snapshotWorkspacePaths(cwd, { maxPaths: options.maxSnapshotPaths });
  let memoryRootsValid = true;
  try {
    assertWitnessMemoryRoots(cwd);
  } catch {
    memoryRootsValid = false;
  }
  const events = [];
  const requestedMembers = new Map();
  const launchedMembers = new Map();
  let requestedModelHaiku = null;
  let requestedModelSonnet = null;
  let definitionSurface = false;
  let teamTransportValidated = false;
  let sameTeamMessage = false;
  let parentSynthesis = false;
  let witnessOverflow = false;
  let turn;
  let launchContext = null;
  const witnessRoute = {
    model: "claude-opus-5", effort: "low", write: false, delegationMode: "claude_orchestrator",
  };
  if (memoryRootsValid) try {
    const driver = options.driver ?? createClaudeCodeDriver();
    const environment = resolveRuntimeEnvironment({ cwd, env: options.env ?? process.env });
    const env = environment.env;
    const readiness = {
      ...driver.preflight({ cwd, env }),
      cwd,
      claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,
      sourceRoot,
    };
    const unready = driver.describeUnreadiness?.(readiness);
    if (unready) throw new Error(unready);
    driver.validatePreparedPreflight(readiness, { cwd, env, sourceRoot });
    launchContext = driver.revalidatePreparedPreflight(readiness, { cwd, env, sourceRoot });
    if (!launchContext?.compatibility?.executable || !launchContext.compatibility.fingerprint) {
      throw new Error("Native-team witness requires a revalidated Claude executable fingerprint.");
    }
    const profile = createExecutionProfile({ ...witnessRoute, env, jobId: "native-team-witness" });
    try {
      // This is the same profile the production Driver constructs for the
      // direct turn; it proves injected requested definitions, never effective
      // teammate properties.
      const agents = profile.claudeOptions.agents;
      requestedModelHaiku = agents["haiku-scout"]?.model ?? null;
      requestedModelSonnet = agents.sonnet?.model ?? null;
    } finally {
      profile.cleanup();
    }
    // The production supervisor patches the running job before it invokes the
    // adapter. This witness-only record is isolated to the disposable root and
    // removed in this function's finally block.
    createWitnessSupervisorJob(cwd);
    witnessSupervisorJobCreated = true;
    turn = await driver.startTurn({
      workspaceRoot: cwd,
      cwd,
      jobId: NATIVE_TEAM_WITNESS_JOB_ID,
      prompt: [
        "Create one fresh Native Agent Team. Do not use synchronous ordinary subagents.",
        "Invoke the named haiku-scout definition as scout-fixture with intended effort low and run_in_background: true.",
        "Invoke the named sonnet definition as reviewer-fixture with intended effort low and run_in_background: true.",
        "After both native teammates have started, use SendMessage once to send a short coordination message to a current-team teammate.",
        "Wait for the required native teammate outcomes, then return one parent synthesis.",
      ].join(" "),
      route: witnessRoute,
      env,
      launchContext,
      onNativeTeamWitness: (fact) => {
        const event = boundedWitnessEvent(fact);
        if (!event) return;
        if (events.length >= MAX_NATIVE_TEAM_WITNESS_EVENTS) {
          witnessOverflow = true;
          return;
        }
        events.push(event);
        if (event.type === "native_team_witness_overflow") witnessOverflow = true;
        if (event.type === "native_team_surface") definitionSurface ||= event.observed;
        if (event.type === "native_team_member_requested") requestedMembers.set(event.memberType, event.memberName);
        if (event.type === "native_team_member_launched") launchedMembers.set(event.memberType, event.memberName);
        if (event.type === "native_team_transport") teamTransportValidated ||= event.teamTransportLiveValidated;
        if (event.type === "native_team_message") sameTeamMessage ||= event.sameTeamRecipient;
        if (event.type === "native_team_parent_synthesis") parentSynthesis = true;
      },
    });
  } finally {
    // Take the immutable path-level snapshot before optional cleanup. This does
    // not open any native-memory file, including allowed paths.
  }
  const after = snapshotWorkspacePaths(cwd, { maxPaths: options.maxSnapshotPaths });
  const changedPaths = changedSnapshotPaths(before, after);
  const allowedMemoryChangedPaths = changedPaths.filter((relative) => nativeMemoryPathAllowed(relative));
  const allowedMemoryMetadataChanges = changedMemoryMetadata(before, after, allowedMemoryChangedPaths);
  const nativeMemorySymlink = nativeMemorySnapshotHasSymlink(before) || nativeMemorySnapshotHasSymlink(after);
  const unauthorizedPaths = changedPaths.filter((relative) =>
    !nativeMemoryPathAllowed(relative) || unsafeAllowedMemorySymlink(after, relative),
  );
  const sourceAfter = gitStatus(sourceRoot);
  const sourceSnapshotAfter = snapshotWorkspacePaths(sourceRoot, { maxPaths: options.maxSnapshotPaths });
  const sourceChangedPaths = changedSnapshotPaths(sourceSnapshotBefore, sourceSnapshotAfter);
  const accountLimit = turn?.failure?.class === "usage_or_subscription_limit" ||
    isClaudeSubscriptionLimit(`${turn?.failure?.reason ?? ""}\n${turn?.failure?.detail ?? ""}`);
  const requestedModels = { haikuScout: requestedModelHaiku, sonnet: requestedModelSonnet };
  const successfulTerminal = turn?.status === "completed" && turn?.failure?.class == null && turn?.exitStatus === 0;
  const missingEvidence = [
    ...(memoryRootsValid ? [] : ["memory_root_invalid"]),
    ...(witnessOverflow ? ["witness_event_overflow"] : []),
    ...(nativeMemorySymlink ? ["native_memory_symlink"] : []),
    ...(before.overflow || after.overflow ? ["disposable_snapshot_overflow"] : []),
    ...(sourceSnapshotBefore.overflow || sourceSnapshotAfter.overflow ? ["source_snapshot_overflow"] : []),
    ...(successfulTerminal ? [] : ["successful_terminal"]),
    ...(definitionSurface ? [] : ["native_team_definition_surface"]),
    ...(requestedMembers.has("haiku-scout") ? [] : ["requested_haiku_scout"]),
    ...(requestedMembers.has("sonnet") ? [] : ["requested_sonnet"]),
    ...(launchedMembers.has("haiku-scout") ? [] : ["launched_haiku_scout"]),
    ...(launchedMembers.has("sonnet") ? [] : ["launched_sonnet"]),
    ...(teamTransportValidated ? [] : ["team_transport"]),
    ...(sameTeamMessage ? [] : ["current_team_message"]),
    ...(parentSynthesis ? [] : ["parent_synthesis"]),
  ];
  const status = accountLimit ? "account_limit_stopped" : (unauthorizedPaths.length || sourceBefore !== sourceAfter || sourceChangedPaths.length || missingEvidence.length ? "unverified" : "verified");
  const report = {
    status,
    liveVerified: status === "verified",
    requestedModels,
    intendedEffort: { haikuScout: "low", sonnet: "low" },
    effectiveTeammate: { model: "unknown", effort: "unknown", cost: "unknown" },
    definitionSurface,
    launch: {
      executable: launchContext?.compatibility?.executable ?? null,
      fingerprint: launchContext?.compatibility?.fingerprint ?? null,
    },
    settleObservation: {
      status: "unobservable",
      executable: launchContext?.compatibility?.executable ?? null,
    },
    memberLaunches: {
      haikuScout: launchedMembers.has("haiku-scout"),
      sonnet: launchedMembers.has("sonnet"),
    },
    teamTransportValidated,
    missingEvidence,
    events,
    source: { unchanged: sourceBefore === sourceAfter && sourceChangedPaths.length === 0, statusBefore: sourceBefore, statusAfter: sourceAfter, changedPaths: sourceChangedPaths },
    disposable: {
      gitStatus: gitStatus(cwd),
      snapshot: { beforePathCount: before.paths.size, afterPathCount: after.paths.size, overflow: before.overflow || after.overflow },
      mutation: {
        changedPaths,
        allowedMemoryChangedPaths,
        allowedMemoryMetadataChanges,
        unauthorizedPaths,
        allowedMemoryPrefixes: [...NATIVE_TEAM_WITNESS_MEMORY_PREFIXES],
      },
    },
  };
  return report;
    })();
  } finally {
    if (witnessSupervisorJobCreated) removeWitnessSupervisorJob(cwd);
    if (options.keepWorkspace !== true) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function exactTools(tools) {
  return JSON.stringify(tools) === JSON.stringify(HARNESSDOCK_MCP_TOOL_NAMES);
}

function toolError(result, operation) {
  const text = Array.isArray(result?.content)
    ? result.content.filter((entry) => entry?.type === "text").map((entry) => entry.text).join(" ")
    : "";
  return new Error(`${operation} failed: ${String(text || "unknown MCP error").slice(0, 1_000)}`);
}

function callOptions(timeout) {
  return { timeout, maxTotalTimeout: timeout };
}

export function isClaudeSubscriptionLimit(value) {
  const text = String(value instanceof Error ? value.message : value ?? "");
  // This is compatibility-only: the normalized Driver failure class is
  // authoritative. Do not mistake a transient/request HTTP 429 for account
  // exhaustion, but retain narrowly named subscription capacity diagnostics.
  if (/\bHTTP\s*429\b/i.test(text) && !/\b(?:subscription|allowance|credits?|quota)\b/i.test(text)) return false;
  const capacity = "(?:subscription|allowance|credits?|quota)";
  const exhaustion = "(?:limit(?:ed)?|hit|reached|exceeded|exhausted|depleted|no remaining|insufficient)";
  return new RegExp(`\\b${capacity}\\b[\\s\\S]{0,80}\\b${exhaustion}\\b|\\b${exhaustion}\\b[\\s\\S]{0,80}\\b${capacity}\\b`, "i").test(text);
}

function paidSmokeError(error) {
  if (!isClaudeSubscriptionLimit(error)) return error;
  const bounded = new Error("Claude subscription or usage limit reached; paid CC testing stopped.");
  /** @type {any} */ (bounded).code = "CLAUDE_SUBSCRIPTION_LIMIT";
  return bounded;
}

export async function runPaidSmoke(client, meta, options = {}) {
  const taskName = `release_smoke_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  let spawned;
  try {
    spawned = await client.callTool({
      name: "spawn_agent",
      arguments: {
        task_name: taskName,
        message: "Inspect your available native tools, use Bash to run pwd without modifying anything, and do not delegate. If Workflow is unavailable, reply exactly HARNESSDOCK_RELEASE_SMOKE_OK. If Workflow is available, reply exactly HARNESSDOCK_RELEASE_SMOKE_WORKFLOW_VISIBLE.",
        description: "Explicit paid release acceptance smoke",
        harness: CLAUDE_CODE_HARNESS_ID,
        model: REAL_SMOKE_MODEL,
        topology: "leaf",
        reasoning_effort: REAL_SMOKE_EFFORT,
        write: false,
      },
      _meta: meta,
    }, undefined, callOptions(60_000));
  } catch (error) {
    throw paidSmokeError(error);
  }
  if (spawned?.isError) throw paidSmokeError(toolError(spawned, "spawn_agent"));

  const deadline = Date.now() + (options.maxMs ?? REAL_SMOKE_MAX_MS);
  while (Date.now() < deadline) {
    const timeoutMs = Math.min(600_000, Math.max(0, deadline - Date.now()));
    let waited;
    try {
      // The model-facing schema has a fixed completion-first wait. Keep the
      // outer smoke deadline as a transport bound, never as a private MCP
      // timeout argument that the public tool deliberately does not accept.
      waited = await client.callTool({
        name: "wait_agent",
        arguments: {},
        _meta: meta,
      }, undefined, callOptions(timeoutMs + 60_000));
    } catch (error) {
      throw paidSmokeError(error);
    }
    if (waited?.isError) throw paidSmokeError(toolError(waited, "wait_agent"));
    const update = waited?.structuredContent?.update;
    if (update?.kind !== "completion") continue;
    const message = String(update.completion_message ?? "");
    if (isClaudeSubscriptionLimit(`${update.summary ?? ""}\n${message}`)) {
      throw paidSmokeError(new Error(`${update.summary ?? ""} ${message}`));
    }
    if (!message.includes("HARNESSDOCK_RELEASE_SMOKE_OK")) {
      throw new Error("Haiku release smoke completed without the expected marker.");
    }
    // This is the final wait in the smoke. Completion acknowledgement is
    // conditional: a caller that ends after consuming the handoff does not
    // need an acknowledgement-only call.
    return {
      requested: true,
      model: REAL_SMOKE_MODEL,
      reasoningEffort: REAL_SMOKE_EFFORT,
      write: false,
      status: "completed",
      markerObserved: true,
    };
  }
  throw new Error("Haiku release smoke exceeded the one-hour observation bound.");
}

const MAX_DISCOVERY_MODELS = 24;
const MAX_DISCOVERY_EFFORTS = 12;

function boundedAtom(value, max = 64) {
  return String(value ?? "").replaceAll("\0", "").trim().slice(0, max);
}

function boundedEffortList(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, MAX_DISCOVERY_EFFORTS)
    .map((atom) => boundedAtom(atom))
    .filter(Boolean);
}

/**
 * Bounded, redacted projection of one `list_harnesses` receipt for zero-model
 * diagnostics. It keeps only the discoverable route facts the public contract
 * already exposes -- readiness, maturity, capacity, exact models, and the
 * model-specific effort/variant choices -- and classifies each admitted Harness
 * as available, unavailable, ambiguous, or drifted. It never carries an
 * endpoint, credential, filesystem path, or native plugin/MCP/tool inventory,
 * and it makes no model, provider, or Server call.
 */
const FORBIDDEN_DISCOVERY_PATTERNS = [
  /https?:\/\//i,
  /\b(?:localhost|127\.0\.0\.1)\b/i,
  /(?:^|[\s"'`=,:([{])\/[^\s"'`<>\])};,]{2,}/,
  /\b(?:api[_-]?key|secret|token|password|credential|bearer)\b/i,
  /\bPI_CODING_AGENT_DIR\b|\bOPENCODE_SERVER_URL\b/i,
  /\bmcpServers?\b|\.mcp\.json\b/i,
];

/**
 * Fail closed if a bounded discovery projection carries an endpoint, credential,
 * filesystem path, or native plugin/MCP identity that the read-only surface must
 * never expose.
 */
export function assertNoLeakedConfiguration(value, context) {
  const serialized = JSON.stringify(value ?? null);
  for (const pattern of FORBIDDEN_DISCOVERY_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`${context} exposed disallowed configuration text (${pattern}).`);
    }
  }
}

const DIFFERENTIAL_PARITY_SCHEMA = "harnessdock.native-harness-differential-parity.v2";
const DIFFERENTIAL_PARITY_HARNESSES = Object.freeze(["claude-code", "pi", "opencode"]);
const DIFFERENTIAL_PARITY_DIMENSIONS = Object.freeze([
  "exact_model_effort_inventory",
  "argv_environment_or_request_transport",
  "native_configuration_inheritance",
  "prompt_authority_delta",
  "event_tool_order",
  "interrupt",
  "exact_session_continuation",
  "cross_process_turn_observation_or_reconciliation",
  "automatic_recovery_exact_session_transport",
  "same_session_recovery_prompt",
  "terminal_classification",
  "route_drift",
  "native_usage_provenance",
  "process_lifecycle",
]);
const DIFFERENTIAL_PARITY_RESULTS = new Set(["pass", "fail", "hold", "not_applicable"]);
const DIFFERENTIAL_PARITY_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIFFERENTIAL_PARITY_REFERENCE = /^[a-z0-9][a-z0-9.-]*\.json#[A-Za-z0-9_/-]+$/;
const DIFFERENTIAL_PARITY_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:@#/,;()\-]*$/;

function parityDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function parityRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Differential parity ${label} must be an object.`);
  return value;
}

function parityKeys(value, keys, label) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`Differential parity ${label} has an unsupported field.`);
  }
}

function parityText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 480 || !DIFFERENTIAL_PARITY_TEXT.test(value)) {
    throw new Error(`Differential parity ${label} is not bounded sanitized text.`);
  }
  return value;
}

/**
 * Assess one closed, sanitized native-harness parity matrix. Result ownership
 * remains with the checked-in receipt/composer; this gate only validates its
 * shape and promotion semantics.
 */
export function assessNativeHarnessDifferentialParity(receipt) {
  const matrix = parityRecord(receipt, "receipt");
  parityKeys(matrix, ["schema", "cells", "digest"], "receipt");
  if (matrix.schema !== DIFFERENTIAL_PARITY_SCHEMA) throw new Error("Differential parity receipt schema is unsupported.");
  if (!Array.isArray(matrix.cells)) throw new Error("Differential parity cells must be an array.");
  const expectedCells = DIFFERENTIAL_PARITY_HARNESSES.flatMap((harness) =>
    DIFFERENTIAL_PARITY_DIMENSIONS.map((dimension) => `${harness}/${dimension}`),
  );
  if (matrix.cells.length !== expectedCells.length) throw new Error("Differential parity receipt must contain every closed matrix cell exactly once.");
  assertNoLeakedConfiguration(matrix, "differential parity receipt");
  const counts = { pass: 0, fail: 0, hold: 0, not_applicable: 0 };
  const blockers = [];
  for (const [index, candidate] of matrix.cells.entries()) {
    const row = parityRecord(candidate, `cell ${index}`);
    const expected = expectedCells[index];
    if (`${row.harness}/${row.dimension}` !== expected) {
      throw new Error("Differential parity cells must be unique, complete, and canonical-order.");
    }
    const needsBlocker = row.result === "fail" || row.result === "hold";
    const isNotApplicable = row.result === "not_applicable";
    parityKeys(row, [
      "harness", "driverVersion", "capabilitySchemaVersion", "dimension", "localEvidence", "directSource", "harnessdockSource", "mode", "comparator", "result", "artifactDigest", "contentDigest",
      ...(needsBlocker ? ["blockerReason"] : []),
      ...(isNotApplicable ? ["notApplicableBasis"] : []),
    ], `cell ${index}`);
    if (!DIFFERENTIAL_PARITY_HARNESSES.includes(row.harness) || !DIFFERENTIAL_PARITY_DIMENSIONS.includes(row.dimension)) {
      throw new Error("Differential parity cell has an unknown harness or dimension.");
    }
    parityText(row.driverVersion, `cell ${index} driverVersion`);
    if (row.capabilitySchemaVersion !== 3) throw new Error("Differential parity capability schema must be version 3.");
    parityText(row.directSource, `cell ${index} direct source`);
    parityText(row.harnessdockSource, `cell ${index} HarnessDock source`);
    parityText(row.mode, `cell ${index} mode`);
    parityText(row.comparator, `cell ${index} comparator`);
    if (!DIFFERENTIAL_PARITY_RESULTS.has(row.result)) throw new Error("Differential parity result is not closed.");
    if (!Array.isArray(row.localEvidence) || row.localEvidence.length < 1 || row.localEvidence.length > 4) {
      throw new Error("Differential parity local evidence must be bounded.");
    }
    for (const reference of row.localEvidence) {
      parityKeys(parityRecord(reference, `cell ${index} evidence`), ["label", "digest"], `cell ${index} evidence`);
      if (!DIFFERENTIAL_PARITY_REFERENCE.test(reference.label) || !DIFFERENTIAL_PARITY_DIGEST.test(reference.digest ?? "")) {
        throw new Error("Differential parity local evidence reference is malformed.");
      }
    }
    if (!DIFFERENTIAL_PARITY_DIGEST.test(row.artifactDigest ?? "")) {
      throw new Error("Differential parity artifact digest is malformed.");
    }
    if (needsBlocker) parityText(row.blockerReason, `cell ${index} blocker reason`);
    if (isNotApplicable) {
      const basis = parityRecord(row.notApplicableBasis, `cell ${index} N/A basis`);
      parityKeys(basis, ["capability", "observed"], `cell ${index} N/A basis`);
      parityText(basis.capability, `cell ${index} N/A capability`);
      parityText(basis.observed, `cell ${index} N/A observed`);
    }
    const { contentDigest, ...content } = row;
    if (!DIFFERENTIAL_PARITY_DIGEST.test(contentDigest ?? "") || contentDigest !== parityDigest(content)) {
      throw new Error("Differential parity cell content digest does not match.");
    }
    counts[row.result] += 1;
    if (needsBlocker) blockers.push({ harness: row.harness, dimension: row.dimension, result: row.result, reason: row.blockerReason });
  }
  if (!DIFFERENTIAL_PARITY_DIGEST.test(matrix.digest ?? "") || matrix.digest !== parityDigest({ schema: matrix.schema, cells: matrix.cells })) {
    throw new Error("Differential parity receipt digest does not match.");
  }
  const status = counts.fail ? "fail" : counts.hold ? "hold" : "pass";
  return {
    status,
    promotionEligible: status === "pass",
    counts: Object.freeze(counts),
    blockers: Object.freeze(blockers),
  };
}

export function projectNativeRouteDiscovery(records, previousRecords = null) {
  const priorGenerations = new Map();
  for (const record of Array.isArray(previousRecords) ? previousRecords : []) {
    for (const instance of Array.isArray(record?.instances) ? record.instances : []) {
      const harness = boundedAtom(record?.harness, 48);
      const instanceKey = boundedAtom(instance?.instance, 64);
      if (harness && instanceKey) priorGenerations.set(`${harness}\0${instanceKey}`, instance?.inspection_generation ?? null);
    }
  }
  return (Array.isArray(records) ? records : []).map((record) => {
    const harness = boundedAtom(record?.harness, 48) || "unknown";
    const instances = Array.isArray(record?.instances) ? record.instances : [];
    const projectedInstances = instances.slice(0, 8).map((instance) => {
      const priorGeneration = priorGenerations.get(
        `${harness}\0${boundedAtom(instance?.instance, 64)}`
      ) ?? null;
      const routes = instance?.routes ?? null;
      const effortsByModel = routes && typeof routes.effortsByModel === "object" && routes.effortsByModel
        ? Object.fromEntries(
          Object.entries(routes.effortsByModel)
            .slice(0, MAX_DISCOVERY_MODELS)
            .map(([model, efforts]) => [boundedAtom(model, 96), boundedEffortList(efforts)]),
        )
        : {};
      return {
        readiness: boundedAtom(instance?.readiness, 32) || "unknown",
        liveValidated: instance?.live_validated === true,
        maturity: boundedAtom(instance?.maturity, 32) || null,
        capacity: Number.isSafeInteger(instance?.capacity) ? instance.capacity : null,
        models: routes && Array.isArray(routes.models)
          ? routes.models.slice(0, MAX_DISCOVERY_MODELS).map((model) => boundedAtom(model, 96)).filter(Boolean)
          : [],
        efforts: routes ? boundedEffortList(routes.reasoningEfforts) : [],
        effortsByModel,
        inspectionGeneration: instance?.inspection_generation ?? null,
        previousInspectionGeneration: priorGeneration,
      };
    });
    let status;
    let detail = null;
    if (record?.unavailable != null) {
      status = "unavailable";
      detail = boundedAtom(record.unavailable, 48);
    } else if (projectedInstances.length === 0) {
      status = "unavailable";
      detail = "no_instances";
    } else if (projectedInstances.length > 1) {
      status = "ambiguous";
    } else if (projectedInstances[0].readiness !== "ready") {
      // A listed instance that cannot be freshly proven ready is a discovery
      // drift condition, not a repair request and not model liveness.
      status = "drift";
      detail = `discovery_${projectedInstances[0].readiness}`;
    } else {
      status = "available";
    }
    return {
      harness,
      status,
      detail,
      maturity: boundedAtom(record?.maturity, 32) || null,
      instances: projectedInstances,
    };
  });
}

export async function probeInstalledMcp(options = {}) {
  const snapshotRoot = fs.realpathSync.native(options.snapshotRoot);
  const workspace = fs.realpathSync.native(options.workspace ?? SOURCE_ROOT);
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-harnessdock-release-smoke-"));
  const threadId = `hd-release-smoke-${randomBytes(12).toString("hex")}`;
  const meta = {
    threadId,
    [CODEX_SANDBOX_META_KEY]: { sandboxCwd: pathToFileURL(workspace).href },
  };
  const descriptor = JSON.parse(fs.readFileSync(path.join(snapshotRoot, ".mcp.json"), "utf8"))?.mcpServers?.codex_harnessdock;
  if (
    descriptor?.cwd !== CANONICAL_RUNTIME_CHECKOUT ||
    descriptor?.args?.[1] !== path.join(CANONICAL_RUNTIME_CHECKOUT, "plugins", "codex-harnessdock", "bootstrap", "harnessdock-mcp.mjs")
  ) {
    throw new Error("Installed MCP descriptor does not launch the canonical checkout bootstrap directly.");
  }
  const transport = new StdioClientTransport({
    command: descriptor.command === "node" ? process.execPath : descriptor.command,
    args: descriptor.args,
    cwd: descriptor.cwd,
    env: {
      ...(options.env ?? process.env),
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-harnessdock-release-smoke", version: "1.0.0" });
  let paidStarted = false;
  let paidCompleted = false;
  try {
    await client.connect(transport);
    const listed = await client.listTools(undefined, callOptions(60_000));
    const tools = listed.tools.map((tool) => tool.name);
    const rawClientDescriptionCharacters = mcpExposedDescriptionCharacters(listed.tools, client.getInstructions());
    const projectedModelVisibleCharacters = mcpProjectedModelVisibleCharacters(listed.tools, client.getInstructions());
    if (projectedModelVisibleCharacters > HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT) {
      throw new Error(`Installed MCP projects ${projectedModelVisibleCharacters} guidance characters; limit is ${HARNESSDOCK_MCP_EXPOSED_DESCRIPTION_CHAR_LIMIT}.`);
    }
    let agentCount = null;
    let harnessCount = null;
    let schemaRejected = null;
    let nativeRoutes = null;
    if (options.callListAgents !== false) {
      const result = await client.callTool({ name: "list_agents", arguments: {}, _meta: meta }, undefined, callOptions(60_000));
      if (result?.isError) throw toolError(result, "list_agents");
      const agents = /** @type {any} */ (result?.structuredContent)?.agents;
      if (!Array.isArray(agents)) throw new Error("list_agents returned no structured Agent array.");
      agentCount = agents.length;
      if (agentCount !== 0) throw new Error("Isolated release-smoke root unexpectedly contains Agents.");

      // Harness discovery is the one multi-Harness observation that is
      // side-effect free by contract: it starts no work, mutates no Agent, and
      // does not start, stop, or reconfigure any Harness's Server. It is
      // therefore the only new call this zero-model smoke may add.
      const firstHarnesses = await client.callTool(
        { name: "list_harnesses", arguments: {}, _meta: meta },
        undefined,
        callOptions(60_000),
      );
      if (firstHarnesses?.isError) throw toolError(firstHarnesses, "list_harnesses");
      const previousRecords = /** @type {any} */ (firstHarnesses?.structuredContent)?.harnesses;
      if (!Array.isArray(previousRecords)) throw new Error("list_harnesses returned no structured Harness array.");
      const harnesses = await client.callTool(
        { name: "list_harnesses", arguments: {}, _meta: meta },
        undefined,
        callOptions(60_000),
      );
      if (harnesses?.isError) throw toolError(harnesses, "list_harnesses");
      const records = /** @type {any} */ (harnesses?.structuredContent)?.harnesses;
      if (!Array.isArray(records)) throw new Error("list_harnesses returned no structured Harness array.");
      harnessCount = records.length;
      // Bounded, redacted, zero-model projection of the fresh native-route
      // discovery this same call performed. No extra Server or model traffic.
      nativeRoutes = projectNativeRouteDiscovery(records, previousRecords);
      if (options.expectedHarnessCount != null && harnessCount !== options.expectedHarnessCount) {
        throw new Error(
          `Installed Plugin reported ${harnessCount} admitted Harnesses; this release admits ` +
          `${options.expectedHarnessCount}.`
        );
      }
      // Readiness is reported, never required: an operator whose Server is down
      // still has an admitted Harness, and this smoke spends no model tokens
      // proving otherwise.

      // The typed schema must refuse what it does not declare. A generation
      // that silently accepted an unknown field would accept a defaulted route.
      const rejected = await client.callTool(
        { name: "list_harnesses", arguments: { harness: "opencode" }, _meta: meta },
        undefined,
        callOptions(60_000),
      );
      schemaRejected = rejected?.isError === true;
      if (!schemaRejected) {
        throw new Error("Installed Plugin accepted an argument list_harnesses does not declare.");
      }
    }
    let paid = { requested: false, status: "skipped" };
    if (options.realClaude === true) {
      paidStarted = true;
      options.onPaidStart?.({ model: REAL_SMOKE_MODEL, reasoningEffort: REAL_SMOKE_EFFORT, write: false });
      paid = await runPaidSmoke(client, meta, { maxMs: options.realClaudeMaxMs });
      paidCompleted = true;
    }
    return {
      healthy: exactTools(tools) &&
        (agentCount == null || agentCount === 0) &&
        (harnessCount == null || options.expectedHarnessCount == null || harnessCount === options.expectedHarnessCount) &&
        (schemaRejected == null || schemaRejected === true),
      tools,
      rawClientDescriptionCharacters,
      projectedModelVisibleCharacters,
      agentCount,
      harnessCount,
      schemaRejected,
      nativeRoutes,
      paid,
    };
  } finally {
    await client.close().catch(() => {});
    if (!paidStarted || paidCompleted) {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  }
}

function installedSkills(snapshotRoot) {
  const skillsRoot = path.join(snapshotRoot, "skills");
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

export async function runReleaseSmoke(options = {}) {
  const parity = inspectInstalledPluginParity({
    checkout: options.checkout ?? SOURCE_ROOT,
    cwd: options.workspace ?? SOURCE_ROOT,
    env: options.env ?? process.env,
    spawnSyncImpl: options.spawnSyncImpl,
    codexExecutable: options.codexExecutable,
    installed: options.installed,
  });
  if (!parity.parity) {
    throw new Error(
      "Installed Plugin snapshot is stale. Run npm run refresh:local for same-generation discovery edits, " +
      "or npm run release:local after a release/API-generation change."
    );
  }
  const skills = installedSkills(parity.installed.snapshotRoot);
  const skillBytes = skills.reduce(
    (total, name) => total + fs.statSync(path.join(parity.installed.snapshotRoot, "skills", name, "SKILL.md")).size,
    0,
  );
  const defaultPromptChars = JSON.parse(
    fs.readFileSync(path.join(parity.installed.snapshotRoot, ".codex-plugin", "plugin.json"), "utf8"),
  )?.interface?.defaultPrompt?.join("\n")?.length;
  if (skillBytes > SKILL_BYTES_LIMIT || !Number.isInteger(defaultPromptChars) || defaultPromptChars > DEFAULT_PROMPT_CHARS_LIMIT) {
    throw new Error("Installed Plugin guidance exceeds its Skill or default-prompt context budget.");
  }
  const expectedSkills = [
    "followup-task",
    "interrupt-agent",
    "list-agents",
    "list-harnesses",
    "read-agent-messages",
    "send-message",
    "spawn-agent",
    "wait-agent",
  ];
  if (JSON.stringify(skills) !== JSON.stringify(expectedSkills)) {
    throw new Error(`Installed Plugin does not expose exactly eight canonical Skills: ${skills.join(", ")}.`);
  }
  const compatibilityShells = inspectCompatibilityShells({
    snapshotRoot: parity.installed.snapshotRoot,
    currentVersion: parity.installed.version,
  });
  if (
    !compatibilityShells.valid ||
    (compatibilityShells.coverageState !== "unmanaged" && !compatibilityShells.coverageComplete)
  ) {
    throw new Error(
      "Plugin compatibility coverage is incomplete, unbounded, or does not route exclusively to the canonical checkout.",
    );
  }
  const mcp = await (options.probeMcp ?? probeInstalledMcp)({
    snapshotRoot: parity.installed.snapshotRoot,
    workspace: options.workspace ?? SOURCE_ROOT,
    env: options.env ?? process.env,
    callListAgents: true,
    realClaude: options.realClaude === true,
    realClaudeMaxMs: options.realClaudeMaxMs,
    onPaidStart: options.onPaidStart,
    expectedHarnessCount: ADMITTED_GENERATION_HARNESS_IDS.length,
  });
  if (!mcp.healthy) throw new Error("Installed MCP smoke did not satisfy the eight-tool contract.");
  if (mcp.harnessCount !== ADMITTED_GENERATION_HARNESS_IDS.length) {
    throw new Error(
      `Installed MCP smoke reported ${mcp.harnessCount ?? "no"} admitted Harness count; ` +
      `this release requires ${ADMITTED_GENERATION_HARNESS_IDS.length}.`
    );
  }
  // The smoke performs one fresh native-route discovery through the same
  // zero-model `list_harnesses` call. A native Harness reported unavailable,
  // ambiguous, or drifted is an operator diagnostic, never a smoke failure and
  // never a repair request; the discovery projection must still be bounded and
  // free of configuration, endpoint, or credential text.
  const nativeRouteDiscovery = Array.isArray(mcp.nativeRoutes) ? mcp.nativeRoutes : [];
  assertNoLeakedConfiguration(nativeRouteDiscovery, "release smoke native-route discovery");
  const differentialParity = options.differentialParityReceipt == null
    ? null
    : assessNativeHarnessDifferentialParity(options.differentialParityReceipt);
  return {
    version: 1,
    status: differentialParity?.status ?? "pass",
    zeroModelCost: options.realClaude !== true,
    installedVersion: parity.installed.version,
    installedSnapshot: parity.installed.snapshotRoot,
    skills,
    contextBudgets: {
      skillBytes,
      defaultPromptChars,
      rawClientDescriptionCharacters: mcp.rawClientDescriptionCharacters ?? null,
      projectedModelVisibleCharacters: mcp.projectedModelVisibleCharacters ?? null,
      freshHostMeasurement: "pending installed task",
    },
    tools: mcp.tools,
    listAgents: { isolated: true, agentCount: mcp.agentCount },
    nativeRouteDiscovery,
    compatibilityShells,
    paid: mcp.paid,
    ...(differentialParity ? {
      differentialParity,
      promotionEligible: differentialParity.promotionEligible,
    } : {}),
  };
}
