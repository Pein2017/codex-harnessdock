/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exact OpenCode Explorer route and `codex-explorer` profile validation
 * (add-opencode-explorer-driver, Task 3).
 *
 * This module owns one decision: whether the operator's running OpenCode
 * Server currently offers the exact discovered read-only Explorer route this
 * checkout admits, and nothing wider. It creates no session, message, prompt,
 * or model request; it never starts, stops, installs, or reconfigures a
 * Server; and it holds no SDK, transport, or credential surface of its own
 * (`runtime/opencode-client.mjs` remains the only owner of those).
 *
 * Everything here is an allowlist. The admitted route is one Harness, one full
 * model identifier, one topology, one authority, and one logical instance of
 * capacity one; the admitted profile policy is repository read/list/glob/grep/
 * LSP inspection. Anything else -- another model, a widened permission, an
 * interactive approval path, an unknown custom or MCP tool, a dynamic
 * selector, a broker-required route -- is refused before a session could
 * exist. A blocklist would be the wrong shape: a tool this checkout has never
 * heard of must be denied by construction, not by enumeration.
 *
 * ## Where the permission semantics came from
 *
 * The effective-policy rules below are not this checkout's invention. They were
 * read from three independent surfaces, and the installed pin wins on any
 * disagreement:
 *
 *   1. the live operator Server's own `GET /agent` projection (authoritative;
 *      health version 1.18.18), which is where the resolved rule shape
 *      `{permission, pattern, action}`, the leading configuration-level
 *      `*`/`*`/allow rule, the `ask` paths, and the operator-absolute
 *      `external_directory` patterns were actually observed;
 *   2. the pinned `@opencode-ai/sdk@1.18.18` types (`Agent`,
 *      `PermissionRuleset`, `PermissionAction`) in `node_modules`;
 *   3. the matching 1.18.18 upstream sources, read read-only for evidence and
 *      never depended on at runtime: rule precedence is `findLast` over the
 *      flattened ruleset (a LATER rule overrides an earlier one), an unmatched
 *      permission defaults to `ask` (never to a denial), a tool is hidden from
 *      the model only when the last rule matching its permission has
 *      `pattern: "*"` and `action: "deny"`, an Agent's own rules are merged
 *      after the configuration-level rules, the Server appends one
 *      `external_directory` allowance for its own tool-output truncation
 *      directory after them, and a `subagent`-mode Agent turns an explicit
 *      prompt into a nested subtask instead of the direct turn this route
 *      requires.
 *
 * Two consequences shape the validation:
 *
 *   - Because an unmatched permission is `ask` and the operator's own
 *     configuration begins with a catch-all allow, absence of a rule proves
 *     nothing. Denial must be positively proven from the resolved policy.
 *   - Because the Explorer route is noninteractive, an `ask` outcome is not a
 *     softer denial: it is an approval broker this generation does not admit.
 */

import { createHash } from "node:crypto";
import { types } from "node:util";

import { plainRecordSnapshot } from "./plain-record.mjs";
import {
  ROUTE_CAPABILITY_NAMES,
  validateRouteCapabilitySnapshot,
} from "./harness-capabilities.mjs";
import { ROUTE_REQUEST_FIELDS } from "./harness-contract.mjs";
import {
  OPENCODE_MAX_PERMISSION_RULES,
  createOpencodeDiscoveryClient,
  discoverOpencodeAgentPolicy,
  discoverOpencodeHealth,
  discoverOpencodeProviderCatalog,
  getOpencodeDiscoveryAudit,
  isLoopbackOpencodeUrl,
} from "./opencode-client.mjs";

// ---------------------------------------------------------------------------
// The frozen route. Every value here is a discovered fact, not a default.
// ---------------------------------------------------------------------------

export const OPENCODE_HARNESS_ID = "opencode";
export const OPENCODE_EXPLORER_PROVIDER_ID = "openai";
export const OPENCODE_EXPLORER_MODEL_ID = "gpt-5.6-luna";
export const OPENCODE_EXPLORER_MODEL = `${OPENCODE_EXPLORER_PROVIDER_ID}/${OPENCODE_EXPLORER_MODEL_ID}`;
export const OPENCODE_EXPLORER_MODEL_ROUTES = Object.freeze([
  Object.freeze({ providerId: "openai", modelId: "gpt-5.6-luna", model: "openai/gpt-5.6-luna" }),
  Object.freeze({ providerId: "openai", modelId: "gpt-5.6-terra", model: "openai/gpt-5.6-terra" }),
  Object.freeze({ providerId: "openai", modelId: "gpt-5.6-sol", model: "openai/gpt-5.6-sol" }),
]);
export const OPENCODE_EXPLORER_MODELS = Object.freeze(
  OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.model)
);
export const OPENCODE_EXPLORER_PROFILE_NAME = "codex-explorer";
export const OPENCODE_EXPLORER_TOPOLOGY = "leaf";
export const OPENCODE_EXPLORER_AUTHORITY = "behavioral_read_only";

/** `null` is the public Harness contract's existing representation for no ceiling. */
export const OPENCODE_EXPLORER_CAPACITY_LIMIT = null;

export function opencodeExplorerModelRoute(model) {
  return OPENCODE_EXPLORER_MODEL_ROUTES.find((route) => route.model === model) ?? null;
}

/**
 * The compatibility probe found no authoritative Server/session incarnation
 * field in any inspected schema, so a persisted session cannot be proven to
 * belong to the original Server. Continuation is therefore fresh-only; this
 * constant is checked against the captured fixture by the Task 3 suite so the
 * two can never drift apart silently.
 */
export const OPENCODE_EXPLORER_CONTINUATION = "fresh_only";

/**
 * The one capability snapshot this route publishes. `leafEnforcement` is
 * `effective_tool_denial` because readiness proves the delegation tools are
 * hidden by the resolved policy, and `authorityEnforcement` is `harness_policy`
 * because read-only is enforced by that same policy -- never by an OS sandbox.
 */
export const OPENCODE_EXPLORER_CAPABILITIES = validateRouteCapabilitySnapshot(
  {
    capabilitySchemaVersion: 3,
    driverMaturity: "experimental",
    values: {
      activeInput: "initial_only",
      authorityEnforcement: "harness_policy",
      automaticRecovery: "none",
      continuation: OPENCODE_EXPLORER_CONTINUATION,
      history: "unavailable",
      interaction: "noninteractive_fixed_policy",
      interruptRequest: "unsupported",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
      turnObservation: "unavailable",
    },
    maturity: Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((name) => [name, "experimental"])),
    provenance: Object.fromEntries(ROUTE_CAPABILITY_NAMES.map((name) => [name, "checkout_declared"])),
  },
  "OpenCode Explorer route capability snapshot"
);

// ---------------------------------------------------------------------------
// The closed permission vocabulary.
// ---------------------------------------------------------------------------

/**
 * The only permissions the Explorer may hold. `list` has no tool in the
 * installed generation but stays admitted because the reviewed contract is
 * repository read/list/glob/search/LSP inspection; admitting a permission with
 * no tool grants nothing.
 */
export const OPENCODE_ADMITTED_PERMISSIONS = Object.freeze(["glob", "grep", "list", "lsp", "read"]);

/**
 * Permissions whose tools must be proven hidden by the resolved policy. These
 * are the installed tool identities (`bash` is the shell tool, `execute` the
 * code-mode tool, `todowrite` the todo tool) plus the non-tool flow actions an
 * interactive client would otherwise be able to drive. `write` and
 * `apply_patch` are listed because a caller may name them, even though the
 * Harness maps all three mutation tools onto the single `edit` permission.
 */
export const OPENCODE_FORBIDDEN_PERMISSIONS = Object.freeze([
  "apply_patch",
  "bash",
  "doom_loop",
  "edit",
  "execute",
  "invalid",
  "plan_enter",
  "plan_exit",
  "question",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
]);

/**
 * Names no tool in this generation answers to. They stand in for a custom
 * plugin tool, an MCP tool, and a future built-in: with a default-deny anchor
 * in place all three must be hidden without this checkout having enumerated
 * them, which is what makes the policy an allowlist rather than a blocklist.
 */
export const OPENCODE_UNKNOWN_TOOL_PROBES = Object.freeze([
  "mcp__unknown_server__unknown_tool",
  "operator_custom_tool",
  "opencode_future_tool",
]);

/** Workspace-shaped resources an admitted read permission must actually allow. */
export const OPENCODE_WORKSPACE_PROBES = Object.freeze(["README.md", "src/index.ts", "."]);

/** Dotenv-shaped resources the resolved policy must deny to the read tool. */
export const OPENCODE_DOTENV_PROBES = Object.freeze([
  ".env",
  "config/.env",
  ".env.local",
  "packages/app/.env.production",
]);

/** External resources the resolved policy must deny outside the workspace. */
export const OPENCODE_EXTERNAL_DIRECTORY_PROBES = Object.freeze([
  "/",
  "/etc/passwd",
  "/var/lib/secrets",
  "../../elsewhere",
]);

/** Mutation tools the Harness folds onto the single `edit` permission. */
const OPENCODE_EDIT_TOOLS = Object.freeze(["apply_patch", "edit", "write"]);

/** MCP resource tools the Harness folds onto the `read` permission. */
const OPENCODE_MCP_READ_TOOLS = Object.freeze([
  "list_mcp_resource_templates",
  "list_mcp_resources",
  "read_mcp_resource",
]);

const OPENCODE_PERMISSION_ACTIONS = Object.freeze(["allow", "deny", "ask"]);
const OPENCODE_ADMITTED_PROFILE_MODES = Object.freeze(["all", "primary"]);

/** Every blocker code readiness may report. Details are closed separately. */
export const OPENCODE_READINESS_BLOCKER_CODES = Object.freeze([
  "admitted_permission_denied",
  "approval_path_admitted",
  "capacity_exhausted",
  "default_deny_anchor_missing",
  "dotenv_read_admitted",
  "external_directory_widened",
  "model_route_not_confirmed",
  "permission_widened",
  "profile_lookup_failed",
  "profile_missing",
  "profile_mode_unusable",
  "profile_model_mismatch",
  "profile_model_missing",
  "profile_native_conflict",
  "profile_options_present",
  "profile_policy_malformed",
  "profile_variant_unproven",
  "server_auth_failed",
  "server_unhealthy",
  "server_unreachable",
]);

/**
 * The only details a blocker may carry. A resolved rule's pattern can hold an
 * operator-absolute path, so a detail is emitted only when it is one of these
 * checkout-owned names; anything else degrades to the bare code rather than
 * disclosing configuration.
 */
const CLOSED_BLOCKER_DETAILS = Object.freeze(
  new Set([
    OPENCODE_EXPLORER_PROFILE_NAME,
    "*",
    "external_directory",
    ...OPENCODE_ADMITTED_PERMISSIONS,
    ...OPENCODE_FORBIDDEN_PERMISSIONS,
    ...OPENCODE_UNKNOWN_TOOL_PROBES,
  ])
);

const MAX_SERVER_VERSION_CHARS = 64;
const MAX_ECHOED_VALUE_CHARS = 64;

export class OpencodeRouteError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OpencodeRouteError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Upstream-mirrored policy evaluation.
// ---------------------------------------------------------------------------

/**
 * The Harness's own wildcard match, mirrored exactly: `\` is normalized to
 * `/`, regex metacharacters are escaped, `*` becomes `.*`, `?` becomes `.`, a
 * trailing ` .*` becomes optional, and the result is anchored with the
 * dot-matches-newline flag. This checkout is Linux-only, so the
 * case-insensitive Windows variant is deliberately not mirrored: matching must
 * stay case-sensitive, or `Edit` would resolve through an `edit` rule.
 */
export function opencodeWildcardMatch(input, pattern) {
  const normalized = String(input).replaceAll("\\", "/");
  let escaped = String(pattern)
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(normalized);
}

/**
 * The permission key one tool identity is governed by. Every mutation tool
 * shares the `edit` permission and every MCP resource-read tool shares `read`,
 * so denying `edit` denies `write` and `apply_patch` with it.
 */
export function opencodePermissionKeyForTool(toolName) {
  const name = String(toolName ?? "");
  if (OPENCODE_EDIT_TOOLS.includes(name)) return "edit";
  if (OPENCODE_MCP_READ_TOOLS.includes(name)) return "read";
  return name;
}

/**
 * The effective action for one permission and one resource: the last rule that
 * matches both wins, and an unmatched permission is `ask` -- the Harness's own
 * default, and for this noninteractive route a refusal to proceed rather than a
 * denial.
 */
export function resolveOpencodePermission(ruleset, permission, resource) {
  for (let index = ruleset.length - 1; index >= 0; index -= 1) {
    const rule = ruleset[index];
    if (opencodeWildcardMatch(permission, rule.permission) && opencodeWildcardMatch(resource, rule.pattern)) {
      return rule.action;
    }
  }
  return "ask";
}

/**
 * Whether the Harness would hide one tool from the model entirely. This is the
 * upstream predicate, not an approximation: the last rule matching the tool's
 * permission (regardless of its pattern) must be a catch-all denial. A tool
 * with no matching rule at all is visible, which is why the reviewed profile
 * needs its default-deny anchor.
 */
export function isOpencodeToolHidden(ruleset, toolName) {
  const permission = opencodePermissionKeyForTool(toolName);
  for (let index = ruleset.length - 1; index >= 0; index -= 1) {
    const rule = ruleset[index];
    if (opencodeWildcardMatch(permission, rule.permission)) {
      return rule.pattern === "*" && rule.action === "deny";
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Profile validation.
// ---------------------------------------------------------------------------

function blockerDetail(code, detail) {
  return CLOSED_BLOCKER_DETAILS.has(detail) ? `${code}:${detail}` : code;
}

/**
 * Rebuild one bounded, trap-free copy of a resolved ruleset, or `null` when it
 * is not the pinned shape. The copy matters: every rule is read exactly once
 * here, so the policy this module validates is provably the same policy it then
 * evaluates -- a Proxy, accessor, or inherited field cannot answer one way to
 * the shape check and another way to the effective-action resolution.
 */
function normalizedRuleset(candidate) {
  // A Proxy is refused before any trap can run, exactly as one is for a record:
  // an exotic ruleset never gets to observe validation at all.
  if (types.isProxy(candidate)) return null;
  if (!Array.isArray(candidate) || candidate.length > OPENCODE_MAX_PERMISSION_RULES) return null;
  const rules = [];
  for (const rule of candidate) {
    let fields;
    try {
      fields = plainRecordSnapshot(rule, "OpenCode permission rule");
    } catch {
      return null;
    }
    if (typeof fields.permission !== "string" || typeof fields.pattern !== "string") return null;
    if (!OPENCODE_PERMISSION_ACTIONS.includes(fields.action)) return null;
    rules.push(Object.freeze({ permission: fields.permission, pattern: fields.pattern, action: fields.action }));
  }
  return Object.freeze(rules);
}

/** The index of the last catch-all denial: the anchor everything after it must respect. */
function defaultDenyAnchorIndex(ruleset) {
  for (let index = ruleset.length - 1; index >= 0; index -= 1) {
    const rule = ruleset[index];
    if (rule.permission === "*" && rule.pattern === "*" && rule.action === "deny") return index;
  }
  return -1;
}

/**
 * Whether one residual `external_directory` allowance has the shape of the
 * Server's own tool-output truncation slot: an absolute path of at least two
 * named segments, with no traversal and no root-wide wildcard. The exact path
 * is operator configuration and is never returned, compared against a
 * hard-coded value, or written into this checkout.
 */
function isBoundedExternalDirectoryPattern(pattern) {
  if (!pattern.startsWith("/")) return false;
  if (pattern.includes("..")) return false;
  if (["/", "/*", "/**"].includes(pattern)) return false;
  const named = pattern
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "*" && segment !== "**");
  return named.length >= 2;
}

/**
 * Validate the resolved policy of the reviewed Explorer profile.
 *
 * The report is closed by construction: bounded booleans, counts, the
 * checkout's own route strings, and blocker codes drawn from one frozen
 * vocabulary. No rule pattern, operator path, Agent name other than the
 * reviewed profile, or Server payload is ever projected into it.
 *
 * @param {*} policy the `discoverOpencodeAgentPolicy()` result
 */
export function validateOpencodeExplorerProfile(policy) {
  const blockers = new Set();
  const facts = {
    profile: OPENCODE_EXPLORER_PROFILE_NAME,
    profilePresent: false,
    mode: null,
    model: null,
    native: false,
    variantDeclared: false,
    optionKeyCount: 0,
    unknownFieldCount: 0,
    ruleCount: 0,
    anchorPresent: false,
    residualRuleCount: 0,
    externalDirectoryResidualAllows: 0,
    admittedPermissionsAllowed: 0,
    forbiddenPermissionsDenied: 0,
    unknownToolProbesDenied: false,
    dotenvReadDenied: false,
    externalDirectoryDenied: false,
  };

  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.ok !== true) {
    blockers.add("profile_lookup_failed");
    return sealedProfileReport(blockers, facts);
  }
  if (policy.present !== true || !policy.agent || typeof policy.agent !== "object") {
    blockers.add(blockerDetail("profile_missing", OPENCODE_EXPLORER_PROFILE_NAME));
    return sealedProfileReport(blockers, facts);
  }

  // One single-read snapshot of the resolved Agent, for the same reason the
  // ruleset gets one: a record that can answer differently to two readers is
  // not evidence.
  let agent;
  try {
    agent = plainRecordSnapshot(policy.agent, "OpenCode Agent policy");
  } catch {
    blockers.add("profile_policy_malformed");
    return sealedProfileReport(blockers, facts);
  }
  facts.profilePresent = true;

  if (agent.name !== OPENCODE_EXPLORER_PROFILE_NAME) {
    blockers.add(blockerDetail("profile_missing", OPENCODE_EXPLORER_PROFILE_NAME));
  }

  // A `subagent`-mode Agent silently becomes a nested subtask when it is
  // prompted explicitly, so the mode is a route fact, not cosmetics.
  if (OPENCODE_ADMITTED_PROFILE_MODES.includes(agent.mode)) facts.mode = agent.mode;
  else blockers.add("profile_mode_unusable");

  if (agent.native === true) {
    facts.native = true;
    blockers.add("profile_native_conflict");
  }

  if (!agent.model || typeof agent.model !== "object") {
    blockers.add("profile_model_missing");
  } else if (
    agent.model.providerID === OPENCODE_EXPLORER_PROVIDER_ID &&
    agent.model.modelID === OPENCODE_EXPLORER_MODEL_ID
  ) {
    facts.model = OPENCODE_EXPLORER_MODEL;
  } else {
    blockers.add("profile_model_mismatch");
  }

  // A model variant is how this Harness expresses reasoning effort, and the
  // discovered route proves no effort.
  if (typeof agent.variant === "string" && agent.variant.trim()) {
    facts.variantDeclared = true;
    blockers.add("profile_variant_unproven");
  }

  const optionKeyCount = Number.isInteger(agent.optionKeyCount) ? agent.optionKeyCount : 0;
  facts.optionKeyCount = optionKeyCount;
  if (optionKeyCount > 0) blockers.add("profile_options_present");

  const unknownFieldCount = Number.isInteger(agent.unknownFieldCount) ? agent.unknownFieldCount : 0;
  facts.unknownFieldCount = unknownFieldCount;
  if (unknownFieldCount > 0) blockers.add("profile_policy_malformed");

  const ruleset = normalizedRuleset(agent.ruleset);
  if (!ruleset) {
    blockers.add("profile_policy_malformed");
    return sealedProfileReport(blockers, facts);
  }
  facts.ruleCount = ruleset.length;

  const anchorIndex = defaultDenyAnchorIndex(ruleset);
  facts.anchorPresent = anchorIndex >= 0;
  if (anchorIndex < 0) blockers.add("default_deny_anchor_missing");

  // Every rule after the anchor is an exception punched through the default
  // denial, so each one must be an admitted read allowance, a further denial,
  // or the Server's single tool-output allowance. With no anchor at all, every
  // rule is such an exception.
  const residual = ruleset.slice(anchorIndex + 1);
  facts.residualRuleCount = residual.length;
  for (const rule of residual) {
    if (rule.action === "deny") continue;
    if (rule.action === "ask") {
      blockers.add(blockerDetail("approval_path_admitted", rule.permission));
      continue;
    }
    if (OPENCODE_ADMITTED_PERMISSIONS.includes(rule.permission)) continue;
    if (rule.permission === "external_directory") {
      facts.externalDirectoryResidualAllows += 1;
      if (!isBoundedExternalDirectoryPattern(rule.pattern)) blockers.add("external_directory_widened");
      continue;
    }
    blockers.add(blockerDetail("permission_widened", rule.permission));
  }
  if (facts.externalDirectoryResidualAllows > 1) blockers.add("external_directory_widened");

  // Effective checks, independent of where a rule sits: a forbidden tool must
  // be hidden outright, an admitted one must actually resolve to `allow`, and
  // an `ask` for an admitted permission is a broker, not a narrower grant.
  for (const permission of OPENCODE_FORBIDDEN_PERMISSIONS) {
    if (isOpencodeToolHidden(ruleset, permission)) facts.forbiddenPermissionsDenied += 1;
    else blockers.add(blockerDetail("permission_widened", permission));
  }

  facts.unknownToolProbesDenied = OPENCODE_UNKNOWN_TOOL_PROBES.every((probe) =>
    isOpencodeToolHidden(ruleset, probe)
  );
  for (const probe of OPENCODE_UNKNOWN_TOOL_PROBES) {
    if (!isOpencodeToolHidden(ruleset, probe)) blockers.add(blockerDetail("permission_widened", probe));
  }

  for (const permission of OPENCODE_ADMITTED_PERMISSIONS) {
    const allowed =
      !isOpencodeToolHidden(ruleset, permission) &&
      OPENCODE_WORKSPACE_PROBES.every(
        (resource) => resolveOpencodePermission(ruleset, permission, resource) === "allow"
      );
    if (allowed) facts.admittedPermissionsAllowed += 1;
    else blockers.add(blockerDetail("admitted_permission_denied", permission));
  }

  facts.dotenvReadDenied = OPENCODE_DOTENV_PROBES.every(
    (resource) => resolveOpencodePermission(ruleset, "read", resource) === "deny"
  );
  if (!facts.dotenvReadDenied) blockers.add("dotenv_read_admitted");

  facts.externalDirectoryDenied = OPENCODE_EXTERNAL_DIRECTORY_PROBES.every(
    (resource) => resolveOpencodePermission(ruleset, "external_directory", resource) === "deny"
  );
  if (!facts.externalDirectoryDenied) blockers.add("external_directory_widened");

  return sealedProfileReport(blockers, facts);
}

function sealedProfileReport(blockers, facts) {
  const sorted = Object.freeze([...blockers].sort());
  return Object.freeze({ ok: sorted.length === 0, blockers: sorted, facts: Object.freeze(facts) });
}

// ---------------------------------------------------------------------------
// Route request and capability admission.
// ---------------------------------------------------------------------------

/**
 * Fields that would carry a reasoning-effort or variant selection. The
 * discovered route proves no effort, so each is refused by its own code rather
 * than as an anonymous unknown field.
 */
const REJECTED_EFFORT_FIELDS = Object.freeze(["effort", "reasoningEffort", "reasoning_effort", "variant"]);

/** One bounded, control-character-free echo of a rejected caller value. */
function boundedValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  // eslint-disable-next-line no-control-regex -- the point is to strip them
  const sanitized = String(text).replace(/[\u0000-\u001f\u007f]/g, "");
  return sanitized.length > MAX_ECHOED_VALUE_CHARS
    ? `${sanitized.slice(0, MAX_ECHOED_VALUE_CHARS)}...`
    : sanitized;
}

/**
 * Validate one explicit route request. Nothing is defaulted, canonicalized,
 * trimmed, or lower-cased: an alias is a different route than the one this
 * checkout discovered, and answering it would be a model substitution. Every
 * field outside the canonical request is refused by name, which is what keeps
 * an endpoint, profile, instance, session, tool map, or policy override from
 * reaching the Driver as a routing decision.
 */
export function validateOpencodeExplorerRouteRequest(request) {
  let fields;
  try {
    fields = plainRecordSnapshot(request, "OpenCode route request");
  } catch (error) {
    throw new OpencodeRouteError("route_request_malformed", error.message);
  }

  for (const field of Object.keys(fields)) {
    if (ROUTE_REQUEST_FIELDS.includes(field)) continue;
    if (REJECTED_EFFORT_FIELDS.includes(field)) {
      throw new OpencodeRouteError(
        "reasoning_effort_unproven",
        `OpenCode route field ${field} is not proven by the discovered route; no reasoning effort is admitted.`,
        { field }
      );
    }
    throw new OpencodeRouteError(
      "unexpected_route_field",
      `OpenCode route request declares an unadmitted field: ${field}.`,
      { field }
    );
  }

  if (fields.harnessId !== OPENCODE_HARNESS_ID) {
    throw new OpencodeRouteError(
      "harness_not_admitted",
      `OpenCode route request states Harness ${boundedValue(fields.harnessId)}.`
    );
  }
  if (typeof fields.model !== "string" || !fields.model) {
    throw new OpencodeRouteError(
      "model_required",
      "An OpenCode route requires the exact full model identifier as a string."
    );
  }
  if (!opencodeExplorerModelRoute(fields.model)) {
    throw new OpencodeRouteError(
      "model_not_admitted",
      `OpenCode does not admit model ${boundedValue(fields.model)}; use one exact published route.`
    );
  }
  if (fields.topology !== OPENCODE_EXPLORER_TOPOLOGY) {
    throw new OpencodeRouteError(
      "topology_not_admitted",
      `OpenCode admits only topology ${OPENCODE_EXPLORER_TOPOLOGY}.`
    );
  }
  if (fields.authority === undefined || fields.authority === null || fields.authority === "") {
    throw new OpencodeRouteError("authority_required", "An OpenCode route requires an explicit authority.");
  }
  if (fields.authority !== OPENCODE_EXPLORER_AUTHORITY) {
    throw new OpencodeRouteError(
      "write_authority_rejected",
      `OpenCode admits only ${OPENCODE_EXPLORER_AUTHORITY}; this route has no write authority to grant.`
    );
  }

  return Object.freeze({
    authority: OPENCODE_EXPLORER_AUTHORITY,
    harnessId: OPENCODE_HARNESS_ID,
    model: fields.model,
    topology: OPENCODE_EXPLORER_TOPOLOGY,
  });
}

/**
 * Admit one candidate capability snapshot. The snapshot must be exactly the
 * one this route proved: a broker-required interaction is refused by its own
 * code, and any other claim -- resumable sessions, active input, history,
 * interrupt, observation, recovery, OS containment, native orchestration, or a
 * validated maturity -- is refused as unproven rather than trusted.
 */
export function assertOpencodeRouteCapabilities(capabilities) {
  let snapshot;
  try {
    snapshot = validateRouteCapabilitySnapshot(capabilities, "OpenCode route capability snapshot");
  } catch (error) {
    throw new OpencodeRouteError("capability_snapshot_malformed", error.message);
  }
  if (snapshot.values.interaction === "requires_broker") {
    throw new OpencodeRouteError(
      "interaction_requires_broker",
      "The OpenCode route is unavailable: it requires an approval broker this generation does not admit.",
      { capability: "interaction" }
    );
  }
  if (snapshot.driverMaturity !== OPENCODE_EXPLORER_CAPABILITIES.driverMaturity) {
    throw new OpencodeRouteError(
      "capability_not_proven",
      "The OpenCode route claims a Driver maturity its evidence does not support.",
      { capability: "driverMaturity" }
    );
  }
  for (const name of ROUTE_CAPABILITY_NAMES) {
    if (snapshot.values[name] !== OPENCODE_EXPLORER_CAPABILITIES.values[name]) {
      throw new OpencodeRouteError(
        "capability_not_proven",
        `The OpenCode route claims ${name}=${boundedValue(snapshot.values[name])}, ` +
          `which this generation has not proven.`,
        { capability: name }
      );
    }
    if (snapshot.maturity[name] !== OPENCODE_EXPLORER_CAPABILITIES.maturity[name]) {
      throw new OpencodeRouteError(
        "capability_not_proven",
        `The OpenCode route claims a ${name} maturity its evidence does not support.`,
        { capability: name }
      );
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Readiness.
// ---------------------------------------------------------------------------

/**
 * The stable redacted identity of one configured Server. It names no endpoint,
 * port, or credential, and it is not an incarnation witness: two runs against
 * the same origin share this key even across a Server restart, which is exactly
 * why continuation needs separate evidence.
 */
export function opencodeExplorerInstanceKey(serverUrl) {
  if (!isLoopbackOpencodeUrl(serverUrl)) {
    throw new OpencodeRouteError(
      "invalid_server_url",
      "An OpenCode instance key requires the configured literal-IP loopback origin."
    );
  }
  const origin = new URL(String(serverUrl)).origin;
  return `opencode-server-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;
}

/** Closed mapping from one client failure code to instance readiness. */
const SERVER_FAILURE_READINESS = Object.freeze({
  auth_failed: Object.freeze({
    readiness: "blocked",
    detailCode: "not_authenticated",
    blocker: "server_auth_failed",
  }),
  malformed_response: Object.freeze({
    readiness: "unknown",
    detailCode: "unknown",
    blocker: "server_unreachable",
  }),
  unknown_error: Object.freeze({ readiness: "unknown", detailCode: "unknown", blocker: "server_unreachable" }),
  aborted_by_caller: Object.freeze({
    readiness: "unknown",
    detailCode: "unknown",
    blocker: "server_unreachable",
  }),
});

const DEFAULT_SERVER_FAILURE = Object.freeze({
  readiness: "unavailable",
  detailCode: "service_unreachable",
  blocker: "server_unreachable",
});

function modelRoutesConfirmed(providers) {
  return Boolean(
    Array.isArray(providers) &&
      providers.length === OPENCODE_EXPLORER_MODEL_ROUTES.length &&
      OPENCODE_EXPLORER_MODEL_ROUTES.every((route, index) => {
        const provider = providers[index];
        return (
          provider?.ok === true &&
          provider.providerPresent === true &&
          provider.providerConnected === true &&
          provider.model?.id === route.modelId &&
          provider.model.providerID === route.providerId
        );
      })
  );
}

function boundedServerVersion(version) {
  if (typeof version !== "string") return null;
  const sanitized = version.replace(/[^0-9A-Za-z.+_-]/g, "");
  return sanitized ? sanitized.slice(0, MAX_SERVER_VERSION_CHARS) : null;
}

function sealedInspection({ serverUrl, readiness, detailCode, liveValidated, routes }) {
  return Object.freeze({
    harnessId: OPENCODE_HARNESS_ID,
    instanceKey: opencodeExplorerInstanceKey(serverUrl),
    readiness,
    liveValidated,
    maturity: "experimental",
    detailCode,
    routes: routes === null ? null : Object.freeze(routes),
    capabilityProvenance: OPENCODE_EXPLORER_CAPABILITIES.provenance,
    inspectionGeneration: "unavailable",
  });
}

/**
 * The bounded route/maturity facts a proven route publishes.
 */
function routeFacts(serverVersion) {
  return {
    ...OPENCODE_EXPLORER_CAPABILITIES.values,
    models: OPENCODE_EXPLORER_MODELS,
    topologies: Object.freeze([OPENCODE_EXPLORER_TOPOLOGY]),
    authority: OPENCODE_EXPLORER_AUTHORITY,
    profile: OPENCODE_EXPLORER_PROFILE_NAME,
    capacity: OPENCODE_EXPLORER_CAPACITY_LIMIT,
    driverMaturity: OPENCODE_EXPLORER_CAPABILITIES.driverMaturity,
    serverVersion,
  };
}

/**
 * Assess one logical OpenCode instance from already-collected side-effect-free
 * observations. Nothing here starts, repairs, or reconfigures anything, and no
 * absent observation is ever read as a passing one: an unreachable Server, an
 * unconfirmed model route, a drifted profile, and a full capacity slot each
 * produce their own closed readiness rather than a partial admission.
 *
 * @param {{serverUrl: string, health: *, providers: *[], policy: *, heldCapacity: number}} input
 */
export function assessOpencodeExplorerReadiness(input) {
  const { serverUrl, health, providers, policy, heldCapacity } = input ?? {};
  if (!Number.isInteger(heldCapacity) || heldCapacity < 0) {
    throw new OpencodeRouteError(
      "capacity_observation_required",
      "Readiness requires the observed held capacity as a non-negative integer."
    );
  }

  const serverVersion = boundedServerVersion(health?.version);

  if (!health || health.ok !== true) {
    const mapped = SERVER_FAILURE_READINESS[health?.code] ?? DEFAULT_SERVER_FAILURE;
    return Object.freeze({
      inspection: sealedInspection({
        serverUrl,
        readiness: mapped.readiness,
        detailCode: mapped.detailCode,
        liveValidated: false,
        routes: null,
      }),
      blockers: Object.freeze([mapped.blocker]),
      facts: Object.freeze({ serverVersion: null, serverReachable: false, modelRouteConfirmed: false }),
    });
  }
  if (health.healthy !== true) {
    return Object.freeze({
      inspection: sealedInspection({
        serverUrl,
        readiness: "unavailable",
        detailCode: "service_unreachable",
        liveValidated: false,
        routes: null,
      }),
      blockers: Object.freeze(["server_unhealthy"]),
      facts: Object.freeze({ serverVersion, serverReachable: true, modelRouteConfirmed: false }),
    });
  }

  const blockers = new Set();
  const routeConfirmed = modelRoutesConfirmed(providers);
  if (!routeConfirmed) blockers.add("model_route_not_confirmed");

  const profileReport = validateOpencodeExplorerProfile(policy);
  for (const blocker of profileReport.blockers) blockers.add(blocker);

  const routeProven = routeConfirmed && profileReport.ok;
  let readiness = "ready";
  let detailCode = "ready";
  if (!routeProven) {
    readiness = "blocked";
    detailCode = "not_configured";
  }

  return Object.freeze({
    inspection: sealedInspection({
      serverUrl,
      readiness,
      detailCode,
      liveValidated: true,
      routes: readiness === "ready" ? routeFacts(serverVersion) : null,
    }),
    blockers: Object.freeze([...blockers].sort()),
    facts: Object.freeze({
      ...profileReport.facts,
      serverVersion,
      serverReachable: true,
      modelRouteConfirmed: routeConfirmed,
      capacityLimit: OPENCODE_EXPLORER_CAPACITY_LIMIT,
      heldCapacity,
    }),
  });
}

/**
 * Run the bounded side-effect-free discovery this readiness needs, then assess
 * it. Only GET observations are dispatched -- health first, then the model
 * catalog and the one named profile -- and an unreachable Server stops before
 * either. The resolved permission ruleset stays inside this call: only the
 * closed report leaves it.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, envFile?: string, signal?: AbortSignal,
 *   heldCapacity?: number, connectTimeoutMs?: number, discoveryTimeoutMs?: number}} [options]
 *   `heldCapacity` is required in practice: readiness refuses to assess an instance whose
 *   capacity was never observed.
 */
export async function inspectOpencodeExplorerInstance(options = {}) {
  const handle = createOpencodeDiscoveryClient(options);
  const serverUrl = handle.serverUrl;
  const health = await discoverOpencodeHealth(handle, { signal: options.signal });
  let providers = null;
  let policy = null;
  if (health.ok === true && health.healthy === true) {
    [providers, policy] = await Promise.all([
      Promise.all(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) =>
        discoverOpencodeProviderCatalog(handle, {
          providerId: route.providerId,
          modelId: route.modelId,
          signal: options.signal,
        })
      )),
      discoverOpencodeAgentPolicy(handle, {
        name: OPENCODE_EXPLORER_PROFILE_NAME,
        signal: options.signal,
      }),
    ]);
  }
  const audit = getOpencodeDiscoveryAudit(handle);
  if (audit.mutatingRequestCount > 0) {
    throw new OpencodeRouteError(
      "mutating_request_detected",
      "Readiness dispatched a mutating request; refusing to publish a readiness result."
    );
  }
  return assessOpencodeExplorerReadiness({
    serverUrl,
    health,
    providers,
    policy,
    heldCapacity: options.heldCapacity,
  });
}
