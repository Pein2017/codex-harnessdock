/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * One semantic owner for every Claude CLI override. `terminal-parity` inherits
 * the user's normal Claude envelope except for the plugin-wide supported-model
 * constraint; `safe` also adds an explicit sandbox/tool policy suitable for
 * delegated work.
 */
import {
  SANDBOX_READ_ONLY_TOOLS,
  cleanupSandboxSettings,
  createSandboxSettings,
  resolveDefaultEffort,
  resolveEffort,
  resolveModel,
} from "./claude-headless-adapter.mjs";
import { resolveNativeTeamPolicy } from "./claude-native-team-policy.mjs";

export const EXECUTION_PROFILES = new Set(["safe", "terminal-parity"]);
export const DELEGATION_MODES = new Set(["leaf", "claude_orchestrator"]);

const COMMON_DELEGATION_PROMPT = [
  "You are a bounded Claude Agent delegated by Codex.",
  "Stay within the task, workspace, and authority; Codex owns user-facing synthesis and acceptance.",
  "Return one self-contained final result with needed evidence and conclusions.",
  "If blocked on a lead/user decision, end with the exact question and evidence; this session can continue.",
].join(" ");

const READ_ONLY_AUTHORITY_PROMPT = [
  "Read/review only: full CLI access avoids prompts but grants no mutation authority.",
].join(" ");

const WRITE_AUTHORITY_PROMPT = [
  "Task-scoped workspace mutation is allowed; change only what is required and preserve unrelated work.",
].join(" ");

const LEAF_TOPOLOGY_PROMPT = "Act as a leaf: do not delegate or use Agent/Workflow.";

export function normalizeDelegationMode(value) {
  const mode = String(value ?? "leaf").trim().toLowerCase();
  if (!DELEGATION_MODES.has(mode)) {
    throw new Error(`Unknown delegation mode ${value}. Use leaf or claude_orchestrator.`);
  }
  return mode;
}

function isNativeAgentTool(value) {
  return /^Agent(?:\(|$)/.test(String(value ?? "").trim());
}

/**
 * The three bounded facts this owner adds around a caller's task text: the
 * delegation framing and return contract, the topology boundary, and the
 * behavioral authority. `delegationPrompt()` is exactly their concatenation, so
 * a Driver that must publish its prompt envelope separately (Driver Contract
 * v2) states the same bytes it sends and cannot become a second prompt owner.
 */
export function delegationEnvelopeFacts(policy, write) {
  const topology = policy.role === "native_team_lead"
    ? [
        policy.prompt,
        "Never use Workflow.",
        "The one-layer spawn depth is a hard topology boundary; the concurrency value is only a residual guard for a forbidden ordinary-subagent path.",
      ].join(" ")
    : LEAF_TOPOLOGY_PROMPT;
  const readAuthority = policy.role === "native_team_lead"
    ? [
        READ_ONLY_AUTHORITY_PROMPT,
        "Do not mutate task, workspace, repository, or external state except Claude native local-memory maintenance under .claude/agent-memory-local/<member-type>/.",
        "This is behavioral authority, not a filesystem sandbox.",
      ].join(" ")
    : [
        READ_ONLY_AUTHORITY_PROMPT,
        "Do not mutate task, workspace, repository, or external state except Claude native Auto Memory or local-memory maintenance.",
        "This is behavioral authority, not a filesystem sandbox.",
      ].join(" ");
  return Object.freeze({
    returnContract: COMMON_DELEGATION_PROMPT,
    topology,
    authority: write ? WRITE_AUTHORITY_PROMPT : readAuthority,
  });
}

function delegationPrompt(policy, write) {
  const facts = delegationEnvelopeFacts(policy, write);
  return [facts.returnContract, facts.topology, facts.authority].join(" ");
}

function deterministicAgents(definitions) {
  return Object.fromEntries(definitions.map(({ name, ...definition }) => [name, definition]));
}

function applyNativeTeamProfile(claudeOptions, inheritedEnv, policy) {
  if (policy.role !== "native_team_lead") return;
  const env = { ...inheritedEnv };
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(policy.limits.maxSpawnDepth);
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(policy.limits.maxConcurrentTeammates);
  delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  claudeOptions.env = env;
  claudeOptions.agents = deterministicAgents(policy.teammateDefinitions);
}

export function normalizeProfileName(value) {
  const name = String(value ?? "terminal-parity").trim().toLowerCase();
  if (!EXECUTION_PROFILES.has(name)) {
    throw new Error(`Unknown execution profile ${value}. Use safe or terminal-parity.`);
  }
  return name;
}

/**
 * Validate every caller-owned execution option without creating temporary
 * sandbox state. Public Agent activation and durable job preparation share
 * this pure seam so invalid options cannot become an asynchronous worker
 * failure after state has already been persisted.
 */
export function validateExecutionProfileOptions(options = {}) {
  const name = normalizeProfileName(options.profile);
  const requestedDangerousBypass = Boolean(options.dangerouslySkipPermissions);
  const requestedModel = String(options.model ?? "").trim();
  if (!requestedModel) {
    throw new Error(
      "Claude execution requires an explicit Haiku, Sonnet, Opus, or Fable model."
    );
  }
  const exactDiscovered = options.exactDiscovered === true;
  const model = exactDiscovered ? requestedModel : resolveModel(requestedModel);
  const delegationMode = normalizeDelegationMode(options.delegationMode);
  if (!exactDiscovered && delegationMode === "claude_orchestrator" && requestedModel !== model) {
    throw new Error(
      "claude_orchestrator delegation requires exact model claude-opus-5 or claude-fable-5."
    );
  }
  resolveNativeTeamPolicy({
    model,
    delegationMode,
    write: Boolean(options.write),
    // Route validation runs before a durable job ID is allocated. Profile
    // creation below re-resolves the policy with the real durable identity.
    jobId: delegationMode === "claude_orchestrator"
      ? (options.jobId ?? "profile-route-validation")
      : undefined,
  });
  if (
    delegationMode === "leaf" &&
    Array.isArray(options.allowedTools) &&
    options.allowedTools.some(isNativeAgentTool)
  ) {
    throw new Error("Leaf delegation cannot allow the native Agent tool.");
  }

  if (requestedDangerousBypass && name !== "terminal-parity") {
    throw new Error(
      "--dangerously-skip-permissions requires --profile terminal-parity; safe must remain sandboxed."
    );
  }
  if (name === "terminal-parity" && options.permissionMode) {
    throw new Error(
      "--dangerously-skip-permissions cannot be combined with --permission-mode."
    );
  }

  const effort = exactDiscovered
    ? (typeof options.effort === "string" && options.effort.trim() === options.effort && options.effort
      ? options.effort : null)
    : name === "terminal-parity"
      ? resolveEffort(options.effort)
      : resolveEffort(resolveDefaultEffort(model, options.effort));
  if (exactDiscovered && !effort) {
    throw new Error("Claude execution requires an explicit discovered effort.");
  }
  const dangerouslySkipPermissions = name === "terminal-parity";
  return { name, model, effort, delegationMode, dangerouslySkipPermissions };
}

export function createExecutionProfile(options = {}) {
  const validated = validateExecutionProfileOptions(options);
  const { name, model, effort, delegationMode } = validated;
  const exactDiscovered = options.exactDiscovered === true;
  const policy = resolveNativeTeamPolicy({
    model,
    delegationMode,
    write: Boolean(options.write),
    jobId: options.jobId,
  });
  const inheritedEnv = options.env ?? process.env;

  if (name === "terminal-parity") {
    const env = { ...inheritedEnv, IS_SANDBOX: "1" };
    const claudeOptions = {
      env,
      model,
      appendSystemPrompt: delegationPrompt(policy, Boolean(options.write)),
    };
    if (exactDiscovered) claudeOptions.exactDiscovered = true;
    claudeOptions.disallowedTools = policy.deniedToolNames;
    applyNativeTeamProfile(claudeOptions, env, policy);
    claudeOptions.dangerouslySkipPermissions = true;
    if (effort) claudeOptions.effort = effort;
    return {
      name,
      claudeOptions,
      receipt: {
        name,
        inheritedClaudeConfiguration: true,
        addedOverrides: Object.keys(claudeOptions).filter((key) => key !== "env"),
      },
      cleanup() {},
    };
  }

  const env = inheritedEnv;
  const sandboxMode = options.write ? "workspace-write" : "read-only";
  const settingsFile = createSandboxSettings(sandboxMode);
  const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const claudeOptions = {
    env,
    model,
    effort,
    appendSystemPrompt: delegationPrompt(policy, Boolean(options.write)),
    settingsFile,
    permissionMode: options.permissionMode ?? (options.write
      ? runningAsRoot ? undefined : "bypassPermissions"
      : "dontAsk"),
  };
  if (exactDiscovered) claudeOptions.exactDiscovered = true;
  claudeOptions.disallowedTools = policy.deniedToolNames;
  applyNativeTeamProfile(claudeOptions, env, policy);
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    claudeOptions.allowedTools = options.allowedTools;
  } else if (!options.write) {
    claudeOptions.allowedTools = delegationMode === "leaf"
      ? SANDBOX_READ_ONLY_TOOLS.filter((tool) => !isNativeAgentTool(tool))
      : SANDBOX_READ_ONLY_TOOLS;
  }

  return {
    name,
    claudeOptions,
    receipt: {
      name,
      inheritedClaudeConfiguration: true,
      sandboxMode,
      addedOverrides: [
        "model",
        "effort",
        "appendSystemPrompt",
        "disallowedTools",
        "settings",
        "permission",
        ...(options.write ? [] : ["allowedTools"]),
      ],
    },
    cleanup() {
      cleanupSandboxSettings(settingsFile);
    },
  };
}
