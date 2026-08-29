/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Read-only operator diagnostics. This module never calls lifecycle
 * reconciliation or persistence helpers.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getClaudeAvailability,
  resolveClaudeExecutable,
} from "./claude-headless-adapter.mjs";
import { observeClaudeCredentialState } from "./claude-credential-state.mjs";
import {
  diagnoseClaudeCompatibility,
  inspectNativeTeamCompatibility,
} from "./claude-version-compatibility.mjs";
import { resolveNativeTeamPolicy } from "./claude-native-team-policy.mjs";
import { resolveRuntimeEnvironment } from "./environment.mjs";
import { inspectConfiguredOpencodeService } from "./opencode-service-manager.mjs";
import {
  inspectCompatibilityShells,
  inspectInstalledPluginParity,
} from "./plugin-installation.mjs";
import { inspectIdentityCutover } from "./plugin-identity-cutover.mjs";
import { inspectLeaseInventory } from "./instance-admission-lease.mjs";
import { validateInspectionGeneration } from "./harness-contract.mjs";
import { CANONICAL_RUNTIME_CHECKOUT, PACKAGE_VERSION, SOURCE_ROOT } from "./version.mjs";

export const CANONICAL_CHECKOUT = CANONICAL_RUNTIME_CHECKOUT;
export const EXPECTED_CLAUDE_CONFIG_DIR = "/data/CoordExp/.claude";
export const EXPECTED_PROXY = "http://127.0.0.1:9090";
export const CLAUDE_HISTORY_OBSERVATION_DAYS = 30;
const STALE_ARTIFACT_MS = 60 * 60 * 1000;
const MAX_TERMINAL_JOBS_PER_OWNER = 100;
const MAX_CANDIDATE_DETAILS = 100;
const MAX_RECORD_ERRORS = 50;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "unknown"]);
const REQUIRED_DEPENDENCIES = ["@modelcontextprotocol/sdk/server/mcp.js", "zod"];

function bounded(value, max = 500) {
  return String(value ?? "").replaceAll("\0", "").trim().slice(0, max);
}

function increment(target, key) {
  const normalized = bounded(key || "missing", 80) || "missing";
  target[normalized] = (target[normalized] ?? 0) + 1;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * `relativePath` is one `state.files[*].relative` entry, relative to
 * `stateRoot`. The lease tree always lives at `<stateRoot>/leases/...`
 * (`runtime/instance-admission-lease.mjs`'s `resolveLeaseRoot()`); nothing
 * outside `stateRoot` can share that prefix, so this needs no additional
 * root argument.
 */
function isWithinLeaseTree(relativePath) {
  return relativePath === "leases" || relativePath.startsWith(`leases${path.sep}`);
}

function walkFiles(root, options = {}) {
  const files = [];
  const boundaryErrors = [];
  const limit = options.limit ?? 200_000;
  if (!fs.existsSync(root)) return { files, boundaryErrors };
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      boundaryErrors.push(path.relative(root, directory) || ".");
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (!isWithin(root, target)) {
        boundaryErrors.push(path.relative(root, target));
        continue;
      }
      if (entry.isSymbolicLink()) {
        boundaryErrors.push(path.relative(root, target));
        continue;
      }
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        try {
          files.push({
            absolute: target,
            relative: path.relative(root, target),
            stat: fs.statSync(target),
          });
        } catch {
          boundaryErrors.push(path.relative(root, target));
        }
      }
      if (files.length > limit) throw new Error(`Storage inventory exceeds ${limit} files.`);
    }
  };
  visit(root);
  return { files, boundaryErrors };
}

function readControlRecord(file, malformed) {
  try {
    return JSON.parse(fs.readFileSync(file.absolute, "utf8"));
  } catch {
    if (malformed.length < MAX_RECORD_ERRORS) malformed.push(file.relative);
    return null;
  }
}

function safeIso(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function storedTimestamp(record, stat) {
  const timestamps = [record?.createdAt, record?.updatedAt, record?.startedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : stat.mtimeMs;
}

function candidateEntry(file, reason, pluginDataRoot) {
  if (!isWithin(pluginDataRoot, file.absolute)) return null;
  return { path: path.relative(pluginDataRoot, file.absolute), reason };
}

function inspectClaudeHistory(claudeConfigDir, nowMs) {
  const projectsRoot = path.join(claudeConfigDir, "projects");
  const { files, boundaryErrors } = walkFiles(projectsRoot);
  const sessions = files.filter((file) => file.relative.endsWith(".jsonl"));
  const cutoff = nowMs - CLAUDE_HISTORY_OBSERVATION_DAYS * 24 * 60 * 60 * 1000;
  const mtimes = sessions.map((file) => file.stat.mtimeMs);
  return {
    configDir: path.resolve(claudeConfigDir),
    observationDays: CLAUDE_HISTORY_OBSERVATION_DAYS,
    sessionFiles: sessions.length,
    totalBytes: sessions.reduce((total, file) => total + file.stat.size, 0),
    olderThanObservationWindow: sessions.filter((file) => file.stat.mtimeMs < cutoff).length,
    oldestAt: mtimes.length > 0 ? safeIso(Math.min(...mtimes)) : null,
    newestAt: mtimes.length > 0 ? safeIso(Math.max(...mtimes)) : null,
    boundaryErrors: boundaryErrors.length,
    pluginCleanupCandidates: 0,
  };
}

/**
 * Read-only operator inventory of blocked instance/session/writer admission
 * leases (OpenSpec `generalize-multi-harness-agent-control-plane` 4.4). This
 * wraps `runtime/instance-admission-lease.mjs`'s bounded, non-secret
 * inventory unchanged: it adds no force-clear, delete, mutation, or
 * cleanup-on-read surface, and reports no arbitrary path, locator, endpoint,
 * config, env, prompt, or output value. An entry is "blocked" when it is
 * either at its declared capacity (no further admission possible) or an
 * unreadable/corrupt record (admission at that key fails closed until an
 * operator investigates); every entry names the one closed evidence class
 * (`evidenceClassNeeded`) that can release it.
 *
 * `options.stateRoot` lets a caller (below, `inspectOperatorStorage()`) share
 * the exact plugin state root it already resolved, rather than this function
 * independently re-resolving one from `CODEX_HARNESSDOCK_RUNTIME_HOME`.
 *
 * `total`/`blockedTotal` and `truncated` are exactly
 * `inspectLeaseInventory()`'s own bounded/truthful counts (see there): the
 * displayed `entries`/`blocked` lists are hard-capped, but the counts always
 * reflect the complete lease population, never just the displayed sample.
 */
export function inspectBlockedLeases(options = {}) {
  const inventory = inspectLeaseInventory(options);
  const blocked = inventory.entries.filter((entry) => entry.atCapacity === true || entry.unreadable === true);
  return {
    total: inventory.total,
    blockedTotal: inventory.blockedTotal,
    truncated: inventory.truncated,
    blocked,
    entries: inventory.entries,
  };
}

export function inspectOperatorStorage(options = {}) {
  const env = options.env ?? process.env;
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const pluginDataRoot = path.resolve(options.pluginDataRoot ?? path.join(codexHome, "plugins", "data", "codex-harnessdock"));
  const stateRoot = path.join(pluginDataRoot, "state");
  const runtimeRoot = path.join(pluginDataRoot, "runtime");
  const nowMs = options.nowMs ?? Date.now();
  const state = walkFiles(stateRoot);
  const runtime = walkFiles(runtimeRoot);
  const malformed = [];
  const agentStatuses = {};
  const jobStatuses = {};
  const jobs = [];
  const completionJobIds = new Set();
  let registries = 0;
  let agents = 0;
  let inboxes = 0;
  let completionEvents = 0;
  let unreadCompletionEvents = 0;
  let jobLogs = 0;

  for (const file of state.files) {
    if (file.relative.endsWith(".log") && file.relative.includes(`${path.sep}jobs${path.sep}`)) {
      jobLogs += 1;
      continue;
    }
    if (/agent-registry[/\\]roots[/\\][^/\\]+[/\\]registry\.json$/.test(file.relative)) {
      const record = readControlRecord(file, malformed);
      if (!record) continue;
      registries += 1;
      const values = record.agents && typeof record.agents === "object" && !Array.isArray(record.agents)
        ? Object.values(record.agents)
        : [];
      agents += values.length;
      for (const agent of values) increment(agentStatuses, agent?.status);
      continue;
    }
    if (/completion-inboxes[/\\][^/\\]+[/\\]inbox\.json$/.test(file.relative)) {
      const record = readControlRecord(file, malformed);
      if (!record) continue;
      inboxes += 1;
      const events = Array.isArray(record.events) ? record.events : [];
      completionEvents += events.length;
      const cursor = Number(record.acknowledgedThrough ?? 0);
      unreadCompletionEvents += events.filter((event) => Number(event?.sequence ?? 0) > cursor).length;
      for (const event of events) {
        if (typeof event?.jobId === "string" && event.jobId) completionJobIds.add(event.jobId);
      }
      continue;
    }
    const jobMatch = /^([^/\\]+)[/\\]jobs[/\\]([^/\\]+)\.json$/.exec(file.relative);
    if (!jobMatch) continue;
    const record = readControlRecord(file, malformed);
    if (!record) continue;
    increment(jobStatuses, record.status);
    jobs.push({
      file,
      workspace: jobMatch[1],
      id: typeof record.id === "string" && record.id ? record.id : jobMatch[2],
      status: record.status,
      owner: typeof record.ownerRootId === "string" && record.ownerRootId
        ? record.ownerRootId
        : typeof record.sessionId === "string" && record.sessionId
          ? record.sessionId
          : "__no_session__",
      hasOwner: Boolean(record.ownerRootId || record.sessionId),
      agentId: typeof record.agentId === "string" && record.agentId ? record.agentId : null,
      projectionReady: Boolean(record.agentProjectionReconciledAt),
      preClaude: record.preClaudeLaunch === true,
      timestamp: storedTimestamp(record, file.stat),
    });
  }

  const candidates = [];
  const allPluginFiles = [...state.files, ...runtime.files];
  for (const file of allPluginFiles) {
    // OpenSpec 4.4: the version-three admission lease tree is never a
    // cleanup candidate, including its own aged `.tmp.*`/`.reserve` scratch
    // files -- a lease releases only through the settlement-gated predicate
    // (`releaseLeasesOnSettlement()`), never a storage dry-run sweep.
    if (isWithinLeaseTree(file.relative)) continue;
    const stale = nowMs - file.stat.mtimeMs > STALE_ARTIFACT_MS;
    if (!stale) continue;
    const reservation = file.relative.endsWith(".reserve");
    const atomicTemporary = /(?:^|[/\\])[^/\\]+\.tmp\./.test(file.relative);
    if (!reservation && !atomicTemporary) continue;
    const entry = candidateEntry(file, reservation ? "stale-reservation" : "stale-atomic-temp", pluginDataRoot);
    if (entry) candidates.push(entry);
  }

  const buckets = new Map();
  for (const job of jobs) {
    if (!TERMINAL_JOB_STATUSES.has(job.status)) continue;
    const key = `${job.workspace}\0${job.owner}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(job);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => right.timestamp - left.timestamp);
    for (const job of bucket.slice(MAX_TERMINAL_JOBS_PER_OWNER)) {
      const completionReady = job.preClaude
        ? true
        : job.hasOwner
          ? completionJobIds.has(job.id)
          : !job.agentId;
      const projectionReady = !job.agentId || job.projectionReady;
      if (!completionReady || !projectionReady) continue;
      const entry = candidateEntry(job.file, "terminal-job-beyond-owner-retention", pluginDataRoot);
      if (entry) candidates.push(entry);
      const logFile = {
        absolute: job.file.absolute.replace(/\.json$/, ".log"),
        relative: job.file.relative.replace(/\.json$/, ".log"),
      };
      if (fs.existsSync(logFile.absolute)) {
        const logEntry = candidateEntry(logFile, "log-for-terminal-job-beyond-owner-retention", pluginDataRoot);
        if (logEntry) candidates.push(logEntry);
      }
    }
  }

  let workspaceStateRoots = 0;
  try {
    workspaceStateRoots = fs.readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
  } catch {}
  const claudeConfigDir = path.resolve(options.claudeConfigDir ?? EXPECTED_CLAUDE_CONFIG_DIR);
  return {
    pluginDataRoot,
    readOnly: true,
    runtime: {
      workspaceStateRoots,
      files: allPluginFiles.length,
      totalBytes: allPluginFiles.reduce((total, file) => total + file.stat.size, 0),
      runtimeFiles: runtime.files.length,
      agentRegistries: registries,
      agents,
      agentStatuses,
      jobs: jobs.length,
      jobStatuses,
      jobLogs,
      completionInboxes: inboxes,
      completionEvents,
      unreadCompletionEvents,
      malformedRecords: malformed.length,
      malformedRecordExamples: malformed,
      boundaryErrors: state.boundaryErrors.length + runtime.boundaryErrors.length,
    },
    cleanup: {
      dryRun: true,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, MAX_CANDIDATE_DETAILS),
      truncated: candidates.length > MAX_CANDIDATE_DETAILS,
    },
    // Read-only lease evidence, deliberately kept out of `cleanup`: a blocked
    // instance/session/writer lease is never a deletable/reclaimable file --
    // it is retained until the same settlement predicate that publishes a
    // completion proves it releasable (`releaseLeasesOnSettlement()`), and
    // this generation exposes no force-clear path for it at all.
    leases: inspectBlockedLeases({ stateRoot }),
    claudeHistory: inspectClaudeHistory(claudeConfigDir, nowMs),
  };
}

function inspectDependencies(checkout, options = {}) {
  const resolve = options.resolve ?? createRequire(path.join(checkout, "package.json")).resolve;
  const missing = [];
  for (const dependency of REQUIRED_DEPENDENCIES) {
    try { resolve(dependency); } catch { missing.push(dependency); }
  }
  return { required: REQUIRED_DEPENDENCIES.length, missing };
}

function inspectAuth(cwd, env, options = {}) {
  const credential = (options.observeCredentialImpl ?? observeClaudeCredentialState)({
    env,
    nowMs: options.nowMs,
  });
  if (env.ANTHROPIC_API_KEY) {
    return {
      loggedIn: true,
      liveValidated: false,
      authMethod: "api-key",
      apiProvider: null,
      subscriptionType: null,
      credential,
    };
  }
  const executable = options.executable ?? resolveClaudeExecutable({ env });
  const result = (options.spawnSyncImpl ?? spawnSync)(executable, ["auth", "status", "--json"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result?.error || result?.status !== 0) {
    return {
      loggedIn: false,
      liveValidated: false,
      authMethod: null,
      apiProvider: null,
      subscriptionType: null,
      credential,
    };
  }
  let parsed = {};
  try { parsed = JSON.parse(result.stdout); } catch {}
  const publicText = (value) => {
    const text = bounded(value, 80);
    return text && /^[A-Za-z0-9 ._+:/-]+$/.test(text) ? text : null;
  };
  return {
    loggedIn: parsed.loggedIn === true,
    liveValidated: false,
    authMethod: publicText(parsed.authMethod),
    apiProvider: publicText(parsed.apiProvider),
    subscriptionType: publicText(parsed.subscriptionType),
    credential,
  };
}

function makeCheck(id, status, summary, details = null, recovery = null) {
  return {
    id,
    status,
    summary: bounded(summary, 800),
    ...(details == null ? {} : { details }),
    ...(recovery == null ? {} : { recovery: bounded(recovery, 800) }),
  };
}

function failedCheck(id, error, recovery = null) {
  return makeCheck(id, "fail", bounded(error instanceof Error ? error.message : error, 800), null, recovery);
}

const NATIVE_ROUTE_LEAK_PATTERNS = [
  /https?:\/\//i,
  /\b(?:localhost|127\.0\.0\.1)\b/i,
  /(?:^|[\s"'`=,:([{])\/[^\s"'`<>\])};,]{2,}/,
  /\b(?:api[_-]?key|secret|token|password|credential|bearer)\b/i,
  /\bPI_CODING_AGENT_DIR\b|\bOPENCODE_SERVER_URL\b/i,
  /\bmcpServers?\b|\.mcp\.json\b/i,
];

function inspectionGenerationDrift(instance) {
  try {
    const current = validateInspectionGeneration(instance?.inspectionGeneration);
    const previous = instance?.previousInspectionGeneration == null
      ? null
      : validateInspectionGeneration(instance.previousInspectionGeneration);
    if (previous == null || current === "unavailable" || previous === "unavailable") return "unavailable";
    return previous === current ? "unchanged" : "changed";
  } catch {
    return "unavailable";
  }
}

/**
 * Bounded, redacted read-only diagnosis of the fresh native Pi/OpenCode route
 * discovery that the isolated MCP probe already performed. It reports route
 * availability, discovery freshness, and the exact model-specific effort/variant
 * choices, and it distinguishes unavailable, ambiguous, and route-drift
 * conditions from successful native-model execution. It launches no model,
 * starts or reconfigures no Harness, and exposes no endpoint, credential,
 * configuration path or content, plugin, MCP server, tool, or prompt template.
 */
export function diagnoseNativeRouteDiscovery(mcp) {
  const routes = Array.isArray(mcp?.nativeRoutes) ? mcp.nativeRoutes : null;
  if (routes == null) {
    return makeCheck(
      "native-routes",
      "warn",
      "Fresh Pi/OpenCode native-route discovery was not observed this run; no model, provider, or Server call was made.",
      null,
      "Rerun doctor once the isolated MCP probe succeeds.",
    );
  }
  const serialized = JSON.stringify(routes);
  for (const pattern of NATIVE_ROUTE_LEAK_PATTERNS) {
    if (pattern.test(serialized)) {
      return failedCheck(
        "native-routes",
        new Error("Native-route discovery projection carried disallowed configuration text and was withheld."),
        "Inspect the list_harnesses projection for endpoint, path, or credential leakage.",
      );
    }
  }
  const byStatus = { available: [], unavailable: [], ambiguous: [], drift: [] };
  const summary = routes.map((route) => {
    const key = ["available", "unavailable", "ambiguous", "drift"].includes(route?.status) ? route.status : "unavailable";
    (byStatus[key] ?? byStatus.unavailable).push(bounded(route?.harness, 48) || "unknown");
    const instance = Array.isArray(route?.instances) ? route.instances[0] : null;
    return {
      harness: bounded(route?.harness, 48) || "unknown",
      status: key,
      detail: route?.detail == null ? null : bounded(route.detail, 48),
      maturity: route?.maturity == null ? null : bounded(route.maturity, 32),
      modelCount: Array.isArray(instance?.models) ? instance.models.length : 0,
      efforts: Array.isArray(instance?.efforts) ? instance.efforts.map((atom) => bounded(atom, 32)).filter(Boolean) : [],
      effortsByModel: instance && instance.effortsByModel && typeof instance.effortsByModel === "object"
        ? Object.fromEntries(
          Object.entries(instance.effortsByModel).slice(0, 24).map(([model, efforts]) => [
            bounded(model, 96),
            (Array.isArray(efforts) ? efforts : []).map((atom) => bounded(atom, 32)).filter(Boolean),
          ]),
        )
        : {},
      inspectionGeneration: inspectionGenerationDrift(instance),
    };
  });
  const degraded = byStatus.unavailable.length + byStatus.ambiguous.length + byStatus.drift.length;
  const status = degraded > 0 ? "warn" : "pass";
  const summaryText = degraded === 0
    ? `Fresh native-route discovery completed with no model, provider, or Server call; ${byStatus.available.join(", ") || "no"} route(s) available with exact model-specific effort/variant choices.`
    : `Fresh native-route discovery completed with no model, provider, or Server call; ` +
      `unavailable: ${byStatus.unavailable.join(", ") || "none"}; ambiguous: ${byStatus.ambiguous.join(", ") || "none"}; ` +
      `drift: ${byStatus.drift.join(", ") || "none"}.`;
  return makeCheck(
    "native-routes",
    status,
    summaryText,
    { routes: summary },
    degraded > 0 ? "Inspect the unavailable, ambiguous, or drifted native Harness; doctor does not repair, reload, or reconfigure it." : null,
  );
}

export function diagnoseOpencodeServiceReadiness(service) {
  const readiness = ["managed", "reused"].includes(service?.status) ? service.status : "unavailable";
  return makeCheck(
    "opencode-service",
    readiness === "unavailable" ? "warn" : "pass",
    readiness === "unavailable"
      ? "OpenCode service readiness is unavailable; doctor did not start, stop, repair, or reconfigure it."
      : `OpenCode service readiness is ${readiness}; doctor did not start, stop, repair, or reconfigure it.`,
    { readiness },
    readiness === "unavailable" ? "Start an eligible native OpenCode turn to reconcile the private service lifecycle." : null,
  );
}

/**
 * Read-only projection of bounded native-team receipts.  These labels are
 * deliberately scoped: an observed clean deny set does not establish broader
 * containment, and tool names do not prove the first native spawn transport.
 */
export function diagnoseNativeTeamCompatibility(cwd, fingerprint = null) {
  const evidence = inspectNativeTeamCompatibility(cwd, fingerprint);
  const modes = ["leaf", "claude_orchestrator"].map((delegationMode) => {
    const reviewedForbiddenToolNames = resolveNativeTeamPolicy({
      model: delegationMode === "leaf" ? "claude-sonnet-5" : "claude-opus-5",
      delegationMode,
      write: false,
      ...(delegationMode === "claude_orchestrator" ? { jobId: "doctor-native-team-policy" } : {}),
    }).deniedToolNames;
    const observation = evidence.observations
      .filter((entry) => entry.delegationMode === delegationMode)
      .at(-1);
    if (!observation) {
      return {
        delegationMode,
        observedAt: null,
        policyRevision: null,
        observed: false,
        canonicalToolNames: [],
        canonicalToolNameCount: 0,
        definitionNames: [],
        reviewedForbiddenToolNames,
        denySetLiveValidated: false,
        teamTransportLiveValidated: false,
        missingDefinitions: [],
        missingNecessaryCoordinationTools: [],
        forbiddenTools: [],
        unknownNativeTools: [],
        status: "live-unverified",
        summary: "No production inventory is retained; reviewed deny-set validation and named-team transport proof are live-unverified.",
      };
    }
    const classification = observation.classification;
    const definitionsMissing = classification.missingDefinitions.length > 0 ||
      classification.missingNecessaryCoordinationTools.length > 0;
    const forbidden = classification.forbiddenTools.length > 0;
    const unknown = classification.unknownNativeTools.length > 0;
    const status = forbidden || definitionsMissing
      ? "incompatible"
      : unknown || (delegationMode === "claude_orchestrator" && !classification.teamTransportLiveValidated)
        ? "warn"
        : classification.denySetLiveValidated
          ? "observed"
          : "live-unverified";
    return {
      delegationMode,
      observedAt: observation.observedAt,
      policyRevision: observation.policyRevision,
      observed: classification.observed,
      canonicalToolNames: classification.canonicalToolNames,
      canonicalToolNameCount: classification.canonicalToolNameCount,
      definitionNames: classification.definitionNames,
      reviewedForbiddenToolNames,
      denySetLiveValidated: classification.denySetLiveValidated,
      teamTransportLiveValidated: classification.teamTransportLiveValidated,
      missingDefinitions: classification.missingDefinitions,
      missingNecessaryCoordinationTools: classification.missingNecessaryCoordinationTools,
      forbiddenTools: classification.forbiddenTools,
      unknownNativeTools: classification.unknownNativeTools,
      status,
      summary: `Reviewed deny-set validation is ${classification.denySetLiveValidated ? "observed clean" : "not live-validated"}; named-team transport proof is ${classification.teamTransportLiveValidated ? "observed" : "live-unverified"}.`,
    };
  });
  return {
    fingerprint,
    legacyObservationCount: evidence.legacyObservationCount,
    modes,
  };
}

function fixedEnvironment(cwd, options = {}) {
  const envFile = path.join(SOURCE_ROOT, "config", "runtime.env");
  const resolved = resolveRuntimeEnvironment({ cwd, envFile, env: options.env ?? process.env });
  const env = resolved.env;
  const proxyKeys = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
  const proxyMatches = proxyKeys.every((key) => env[key] === EXPECTED_PROXY);
  const configMatches = (
    env.CLAUDE_CONFIG_DIR === EXPECTED_CLAUDE_CONFIG_DIR &&
    env.CLAUDE_NATIVE_CONFIG_DIR === EXPECTED_CLAUDE_CONFIG_DIR
  );
  const noProxyMatches = env.no_proxy === "127.0.0.1,localhost" && env.NO_PROXY === "127.0.0.1,localhost";
  const condaConfigured = Boolean(String(env.CONDA_EXE ?? "").trim());
  return {
    env,
    receipt: {
      envFile,
      claudeConfigDir: env.CLAUDE_CONFIG_DIR,
      proxyEndpoint: EXPECTED_PROXY,
      proxyMatches,
      configMatches,
      noProxyMatches,
      condaConfigured,
    },
    healthy: proxyMatches && configMatches && noProxyMatches && condaConfigured,
  };
}

export async function runDoctor(options = {}) {
  const cwd = path.resolve(options.cwd ?? SOURCE_ROOT);
  const expectedCheckout = path.resolve(options.expectedCheckout ?? CANONICAL_CHECKOUT);
  const checks = [];
  let environment = null;
  let installation = null;
  let dependencies = null;

  try {
    const canonical = fs.realpathSync.native(SOURCE_ROOT);
    const healthy = canonical === expectedCheckout && cwd === expectedCheckout;
    checks.push(makeCheck(
      "checkout",
      healthy ? "pass" : "fail",
      healthy ? `Canonical checkout ${canonical} is active.` : `Expected ${expectedCheckout}, found ${canonical} with cwd ${cwd}.`,
      { packageVersion: PACKAGE_VERSION },
      healthy ? null : `Run doctor from ${expectedCheckout}.`,
    ));
  } catch (error) {
    checks.push(failedCheck("checkout", error, `Restore the canonical checkout at ${CANONICAL_CHECKOUT}.`));
  }

  try {
    installation = inspectInstalledPluginParity({
      checkout: SOURCE_ROOT,
      cwd,
      env: options.env ?? process.env,
      spawnSyncImpl: options.spawnSyncImpl,
      codexExecutable: options.codexExecutable,
    });
    checks.push(makeCheck(
      "plugin-installation",
      installation.parity ? "pass" : "fail",
      installation.parity
        ? `Installed ${installation.manifestVersion} snapshot matches the checkout.`
        : "Installed Plugin source, version, or discovery content does not match the checkout.",
      {
        installedVersion: installation.installed.version,
        sourceMatches: installation.sourceMatches,
        versionMatches: installation.versionMatches,
        contentMatches: installation.contentMatches,
        checkoutFiles: installation.checkoutFileCount,
        snapshotFiles: installation.snapshotFileCount,
      },
      installation.parity
        ? null
        : "Run npm run refresh:local for same-generation discovery edits, or npm run release:local after a release/API-generation change; then start a new Codex task.",
    ));
  } catch (error) {
    checks.push(failedCheck("plugin-installation", error, "Run npm run install:local or npm run refresh:local."));
  }

  if (installation?.installed) {
    try {
      const shells = inspectCompatibilityShells({
        snapshotRoot: installation.installed.snapshotRoot,
        currentVersion: installation.installed.version,
      });
      const unmanaged = shells.coverageState === "unmanaged";
      const healthy = unmanaged ? shells.valid : (shells.valid && shells.coverageComplete);
      const status = healthy ? (unmanaged ? "warn" : "pass") : "fail";
      const summary = unmanaged
        ? "Compatibility coverage is unavailable for this unmanaged or legacy installation; no predecessor is claimed."
        : shells.coverageState === "first_install" && healthy
          ? "First install coverage is recorded; no distinct predecessor exists yet."
          : healthy
            ? `Known predecessor ${shells.expectedPredecessor} is retained in cache and durable archive.`
            : "Known Plugin compatibility coverage is incomplete or invalid.";
      checks.push(makeCheck(
        "plugin-compatibility-shells",
        status,
        summary,
        shells,
        status === "pass" ? null : "Run npm run release:local and inspect the durable Plugin compatibility archive.",
      ));
    } catch (error) {
      checks.push(failedCheck(
        "plugin-compatibility-shells",
        error,
        "Run npm run release:local and inspect the local Plugin cache compatibility shells.",
      ));
    }
  } else {
    checks.push(makeCheck(
      "plugin-compatibility-shells",
      "fail",
      "Compatibility-shell check skipped because the installed Plugin could not be resolved.",
    ));
  }

  try {
    dependencies = inspectDependencies(SOURCE_ROOT, options);
    const healthy = dependencies.missing.length === 0;
    checks.push(makeCheck(
      "checkout-dependencies",
      healthy ? "pass" : "fail",
      healthy ? "Required checkout dependencies are resolvable." : `Missing dependencies: ${dependencies.missing.join(", ")}.`,
      { required: dependencies.required, missing: dependencies.missing },
      healthy ? null : `Run npm install in ${CANONICAL_CHECKOUT}.`,
    ));
  } catch (error) {
    checks.push(failedCheck("checkout-dependencies", error, `Run npm install in ${CANONICAL_CHECKOUT}.`));
  }

  try {
    environment = fixedEnvironment(cwd, options);
    checks.push(makeCheck(
      "fixed-environment",
      environment.healthy ? "pass" : "fail",
      environment.healthy ? "Fixed Claude config, 9090 proxy, no-proxy, and Conda envelope are active." : "Fixed runtime environment does not match the checkout contract.",
      environment.receipt,
      environment.healthy ? null : `Repair ${path.join(SOURCE_ROOT, "config", "runtime.env")}.`,
    ));
  } catch (error) {
    checks.push(failedCheck("fixed-environment", error, "Repair the fixed runtime.env file."));
  }

  if (environment) {
    const availability = getClaudeAvailability(cwd, {
      env: environment.env,
      spawnSyncImpl: options.spawnSyncImpl,
    });
    const compatibility = diagnoseClaudeCompatibility(cwd, {
      availability,
      env: environment.env,
      spawnSyncImpl: options.spawnSyncImpl,
    });
    const nativeTeam = diagnoseNativeTeamCompatibility(cwd, compatibility.fingerprint);
    checks.push(makeCheck(
      "claude-cli",
      availability.available && compatibility.staticCompatible ? "pass" : "fail",
      availability.available && compatibility.staticCompatible
        ? `Claude Code ${compatibility.version} exposes the required ${compatibility.requiredSurfaceRevision} surface.`
        : `Claude Code is unavailable or incompatible (${compatibility.failureCode ?? "unknown"}).`,
      {
        available: availability.available,
        version: compatibility.version,
        staticCompatible: compatibility.staticCompatible,
        missingSurface: compatibility.missingSurface,
        failureCode: compatibility.failureCode,
        nativeTeam,
      },
      availability.available && compatibility.staticCompatible ? null : "Update or repair the fixed Claude CLI, then rerun doctor.",
    ));

    const auth = inspectAuth(cwd, environment.env, options);
    const credentialPresent = auth.credential?.state === "present";
    const credentialUnproven =
      !credentialPresent ||
      (auth.credential?.source === "native_oauth" && auth.credential?.accessLocallyExpired !== false);
    const authStatus = !auth.loggedIn || !credentialPresent
      ? "fail"
      : credentialUnproven
        ? "warn"
        : "pass";
    checks.push(makeCheck(
      "claude-auth",
      authStatus,
      authStatus === "pass"
        ? "Claude credential metadata is present; provider liveness was not validated."
        : authStatus === "warn"
          ? "Claude reports authentication, but the local access credential is expired or unproven; provider liveness was not validated."
          : "Claude credential metadata is unavailable; provider liveness was not validated.",
      auth,
      authStatus === "pass" ? null : `Run CLAUDE_CONFIG_DIR=${EXPECTED_CLAUDE_CONFIG_DIR} claude auth login, then rerun doctor.`,
    ));

  } else {
    checks.push(makeCheck("claude-cli", "fail", "Claude CLI check skipped because the fixed environment is invalid."));
    checks.push(makeCheck("claude-auth", "fail", "Claude auth check skipped because the fixed environment is invalid."));
  }

  try {
    const identity = options.identityCutover ?? inspectIdentityCutover({ env: options.env ?? process.env });
    const status = identity.state === "conflicting" || identity.state === "rollback_required"
      ? "fail"
      : identity.state === "pending"
        ? "warn"
        : "pass";
    const summary = identity.state === "migrated"
      ? "HarnessDock data namespace is migrated with one accepted cutover receipt."
      : identity.state === "adopted"
        ? "HarnessDock data namespace is explicitly adopted as authoritative without legacy recovery."
      : identity.state === "pending"
        ? "Legacy data namespace is pending explicit identity cutover; no migration was executed."
        : identity.state === "absent"
          ? "No identity cutover receipt is present; installed migration remains unexecuted."
          : identity.state === "conflicting"
            ? "Both legacy and HarnessDock data namespaces exist; writable ownership is split."
            : "HarnessDock data namespace exists without an accepted cutover receipt; rollback inspection is required.";
    checks.push(makeCheck(
      "identity-cutover",
      status,
      summary,
      {
        state: identity.state,
        currentNamespace: "codex-harnessdock",
        legacyNamespace: "cc",
        operation: identity.receipt?.operation ?? (identity.state === "migrated" ? "cutover" : null),
        cutoverAt: identity.receipt?.cutover_at ?? null,
        adoptedAt: identity.receipt?.adopted_at ?? null,
        backupRoot: identity.receipt?.backup_root ?? null,
      },
      status === "pass" ? null : "Stop lifecycle work and inspect the identity cutover receipt before migration or rollback.",
    ));
  } catch (error) {
    checks.push(failedCheck("identity-cutover", error, "Inspect legacy/new data roots and the identity cutover receipt."));
  }

  try {
    const storage = inspectOperatorStorage({
      env: options.env ?? process.env,
      claudeConfigDir: environment?.env.CLAUDE_CONFIG_DIR ?? EXPECTED_CLAUDE_CONFIG_DIR,
      nowMs: options.nowMs,
      pluginDataRoot: options.pluginDataRoot,
    });
    const warning = storage.runtime.malformedRecords > 0 || storage.runtime.boundaryErrors > 0 || storage.cleanup.candidateCount > 0;
    checks.push(makeCheck(
      "storage",
      warning ? "warn" : "pass",
      warning ? "Storage is readable with advisory cleanup or malformed-record findings." : "Storage inventory is readable with no cleanup candidates.",
      storage,
    ));
  } catch (error) {
    checks.push(failedCheck("storage", error, "Inspect Plugin data permissions and rerun doctor."));
  }

  if (installation?.parity && dependencies?.missing?.length === 0) {
    let mcp = null;
    try {
      const probe = options.probeMcp ?? (await import("./release-smoke.mjs")).probeInstalledMcp;
      mcp = await probe({
        snapshotRoot: installation.installed.snapshotRoot,
        workspace: cwd,
        env: environment?.env ?? options.env ?? process.env,
        callListAgents: true,
      });
      checks.push(makeCheck(
        "mcp-tools",
        mcp.healthy ? "pass" : "fail",
        mcp.healthy ? "Installed MCP bootstrap exposes exactly eight tools and isolated list_agents succeeds." : "Installed MCP discovery did not match the eight-tool contract.",
        { toolCount: mcp.tools.length, tools: mcp.tools, isolatedAgentCount: mcp.agentCount },
        mcp.healthy ? null : "Run npm run refresh:local and start a new Codex task.",
      ));
    } catch (error) {
      checks.push(failedCheck("mcp-tools", error, "Run npm run refresh:local and inspect the MCP bootstrap."));
    }
    checks.push(diagnoseNativeRouteDiscovery(mcp));
  } else {
    checks.push(makeCheck(
      "mcp-tools",
      "fail",
      "MCP discovery skipped because installation parity or checkout dependencies failed.",
      null,
      "Repair earlier failures, then rerun doctor.",
    ));
    checks.push(makeCheck(
      "native-routes",
      "warn",
      "Native Pi/OpenCode route discovery skipped because installation parity or checkout dependencies failed.",
      null,
      "Repair earlier failures, then rerun doctor.",
    ));
  }

  try {
    const inspectService = options.inspectOpencodeService ?? inspectConfiguredOpencodeService;
    checks.push(diagnoseOpencodeServiceReadiness(await inspectService({
      cwd,
      env: environment?.env ?? options.env ?? process.env,
    })));
  } catch {
    checks.push(diagnoseOpencodeServiceReadiness({ status: "unavailable" }));
  }

  const requiredFailed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  return {
    version: 1,
    operatorOnly: true,
    readOnly: true,
    checkout: SOURCE_ROOT,
    status: requiredFailed ? "fail" : warned ? "warn" : "pass",
    checks,
  };
}
