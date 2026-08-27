/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 3 of add-opencode-explorer-driver: the exact OpenCode Explorer route
 * and the reviewed `codex-explorer` profile.
 *
 * Zero model requests and zero session/message/prompt requests are made
 * anywhere in this suite. The fake Server implements no session route at all,
 * and the readiness path is asserted to dispatch only side-effect-free GETs.
 *
 * The permission semantics exercised here are not invented by this checkout.
 * They were read from three independent surfaces and recorded in the module
 * under test:
 *   - the live operator Server's own `GET /agent` projection (authoritative,
 *     health version 1.18.18);
 *   - the pinned `@opencode-ai/sdk@1.18.18` `Agent` / `PermissionRule` types
 *     in `node_modules` (the installed pin wins on any disagreement);
 *   - the matching 1.18.18 upstream source (`findLast` rule precedence, the
 *     `ask` default for an unmatched permission, and the tool-visibility
 *     predicate), read read-only for evidence and never depended on at
 *     runtime.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { ROUTE_CAPABILITY_NAMES, validateRouteCapabilitySnapshot } from "../../runtime/harness-capabilities.mjs";
import { ROUTE_REQUEST_FIELDS, validateInstanceInspection } from "../../runtime/harness-contract.mjs";
import { createOpencodeDiscoveryClient, discoverOpencodeAgentPolicy } from "../../runtime/opencode-client.mjs";
import {
  OPENCODE_ADMITTED_PERMISSIONS,
  OPENCODE_EXPLORER_AUTHORITY,
  OPENCODE_EXPLORER_CAPABILITIES,
  OPENCODE_EXPLORER_CAPACITY_LIMIT,
  OPENCODE_EXPLORER_CONTINUATION,
  OPENCODE_EXPLORER_MODEL,
  OPENCODE_EXPLORER_MODEL_ID,
  OPENCODE_EXPLORER_MODELS,
  OPENCODE_EXPLORER_MODEL_ROUTES,
  OPENCODE_EXPLORER_PROFILE_NAME,
  OPENCODE_EXPLORER_PROVIDER_ID,
  OPENCODE_EXPLORER_TOPOLOGY,
  OPENCODE_FORBIDDEN_PERMISSIONS,
  OPENCODE_HARNESS_ID,
  OPENCODE_READINESS_BLOCKER_CODES,
  OPENCODE_UNKNOWN_TOOL_PROBES,
  OpencodeRouteError,
  assertOpencodeRouteCapabilities,
  assessOpencodeExplorerReadiness,
  inspectOpencodeExplorerInstance,
  isOpencodeToolHidden,
  opencodeExplorerInstanceKey,
  opencodePermissionKeyForTool,
  opencodeWildcardMatch,
  resolveOpencodePermission,
  validateOpencodeExplorerProfile,
  validateOpencodeExplorerRouteRequest,
} from "../../runtime/opencode-explorer-profile.mjs";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatePath = path.join(root, "config", "opencode", "codex-explorer.md");
const modulePath = path.join(root, "runtime", "opencode-explorer-profile.mjs");

/**
 * A synthetic absolute path stands in for the Server's own tool-output
 * truncation directory. The operator's real path is never written into this
 * checkout.
 */
const SYNTHETIC_TRUNCATION_GLOB = "/opt/operator-owned/tool-output/*";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    await cleanup();
  }
});

async function startServer(scenario) {
  const server = createFakeOpencodeServer(scenario);
  const url = await server.listen();
  cleanups.push(() => server.close());
  return { server, url };
}

// ---------------------------------------------------------------------------
// Ruleset builders: exactly the shape the Server resolves and returns.
// ---------------------------------------------------------------------------

/**
 * The configuration-level rules an operator Server merges before an Agent's
 * own rules: a catch-all allow, two interactive `ask` paths, one absolute
 * external-directory allowance, and the upstream dotenv `ask` guards. Every
 * one of them must be neutralized by the reviewed profile's own trailing
 * rules, which is the entire point of the default-deny anchor.
 */
function operatorConfigRules() {
  return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: SYNTHETIC_TRUNCATION_GLOB, action: "allow" },
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "plan_enter", pattern: "*", action: "deny" },
    { permission: "plan_exit", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
  ];
}

/** The rules the reviewed template's permission block resolves to, in order. */
function reviewedProfileRules() {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
  ];
}

/** The one allowance the Server appends after an Agent's own rules. */
function serverAppendedRules() {
  return [{ permission: "external_directory", pattern: SYNTHETIC_TRUNCATION_GLOB, action: "allow" }];
}

function compliantRuleset(extra = []) {
  return [...operatorConfigRules(), ...reviewedProfileRules(), ...serverAppendedRules(), ...extra];
}

function compliantAgent(overrides = {}) {
  return {
    name: OPENCODE_EXPLORER_PROFILE_NAME,
    mode: "primary",
    native: false,
    hidden: false,
    model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
    variant: null,
    optionKeyCount: 0,
    unknownFieldCount: 0,
    ruleset: compliantRuleset(),
    ...overrides,
  };
}

function compliantPolicy(agentOverrides = {}) {
  return { ok: true, present: true, agent: compliantAgent(agentOverrides) };
}

/** Rules for a profile whose own block is missing (only operator defaults). */
function unanchoredPolicy() {
  return { ok: true, present: true, agent: compliantAgent({ ruleset: operatorConfigRules() }) };
}

function policyWithExtraRules(extra) {
  return { ok: true, present: true, agent: compliantAgent({ ruleset: compliantRuleset(extra) }) };
}

function healthyHealth() {
  return { ok: true, healthy: true, version: "1.18.18" };
}

function exactProviders() {
  return OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => ({
    ok: true,
    providerPresent: true,
    providerConnected: true,
    model: {
      id: route.modelId,
      providerID: route.providerId,
      name: route.model,
      family: null,
    },
  }));
}

function readinessInput(overrides = {}) {
  return {
    serverUrl: "http://127.0.0.1:4096",
    health: healthyHealth(),
    providers: exactProviders(),
    policy: compliantPolicy(),
    heldCapacity: 0,
    ...overrides,
  };
}

function exactRouteRequest(overrides = {}) {
  return {
    harnessId: OPENCODE_HARNESS_ID,
    model: OPENCODE_EXPLORER_MODEL,
    topology: OPENCODE_EXPLORER_TOPOLOGY,
    authority: OPENCODE_EXPLORER_AUTHORITY,
    ...overrides,
  };
}

/** Every string reachable in a serialized report, for leak assertions. */
function collectStrings(value, sink = []) {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, sink);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, sink);
  return sink;
}

function assertNoPolicyDisclosure(report) {
  for (const text of collectStrings(report)) {
    assert.equal(text.startsWith("/"), false, `report disclosed an absolute path: ${text}`);
    assert.equal(text.includes(SYNTHETIC_TRUNCATION_GLOB), false, `report disclosed the truncation glob: ${text}`);
    // `*` is the wildcard permission's own name, so one closed blocker may end
    // in `:*`. Anything else carrying a `*` would be a resolved rule pattern.
    const wildcardDetail =
      text.endsWith(":*") && OPENCODE_READINESS_BLOCKER_CODES.includes(text.slice(0, -2));
    assert.equal(text.includes("*") && !wildcardDetail, false, `report disclosed a permission pattern: ${text}`);
  }
}

/**
 * The upstream configuration-to-ruleset expansion, mirrored here so the
 * reviewed template's own text can be checked against the rules the Server
 * will derive from it: a string value becomes one `*`-pattern rule, and an
 * object value becomes one rule per pattern in declaration order.
 */
function rulesFromPermissionConfig(config) {
  const rules = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value });
      continue;
    }
    for (const [pattern, action] of Object.entries(value)) rules.push({ permission, pattern, action });
  }
  return rules;
}

/** Parses the reviewed template's YAML-flow frontmatter (also valid JSON). */
function parseReviewedTemplate() {
  const text = fs.readFileSync(templatePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  assert.notEqual(match, null, "the reviewed template must have YAML frontmatter");
  const frontmatter = match[1]
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return { frontmatter: JSON.parse(frontmatter), body: match[2].trim(), raw: text };
}

// ---------------------------------------------------------------------------
// 3.1 The reviewed operator template.
// ---------------------------------------------------------------------------

describe("opencode explorer template: reviewed default-deny operator profile", () => {
  it("declares the exact admitted model, a primary mode, and no unreviewed key", () => {
    const { frontmatter } = parseReviewedTemplate();
    assert.equal(frontmatter.model, OPENCODE_EXPLORER_MODEL);
    assert.equal(frontmatter.mode, "primary");
    assert.equal(typeof frontmatter.description, "string");
    // An unknown frontmatter key is folded into the Agent's provider options
    // by OpenCode, which readiness refuses; the reviewed template keeps to the
    // four reviewed keys so that failure can only mean operator drift.
    assert.deepEqual(Object.keys(frontmatter).sort(), ["description", "mode", "model", "permission"]);
    assert.equal(Object.hasOwn(frontmatter, "variant"), false);
    assert.equal(Object.hasOwn(frontmatter, "tools"), false);
    assert.equal(Object.hasOwn(frontmatter, "options"), false);
  });

  it("expands to exactly the reviewed default-deny ruleset, anchor first", () => {
    const { frontmatter } = parseReviewedTemplate();
    const rules = rulesFromPermissionConfig(frontmatter.permission);
    assert.deepEqual(rules, reviewedProfileRules());
    assert.deepEqual(rules[0], { permission: "*", pattern: "*", action: "deny" });
    for (const rule of rules.slice(1)) {
      assert.notEqual(rule.action, "ask");
      if (rule.action === "allow") {
        assert.equal(OPENCODE_ADMITTED_PERMISSIONS.includes(rule.permission), true, rule.permission);
      }
    }
  });

  it("resolves through readiness as a compliant profile", () => {
    const { frontmatter } = parseReviewedTemplate();
    const ruleset = [
      ...operatorConfigRules(),
      ...rulesFromPermissionConfig(frontmatter.permission),
      ...serverAppendedRules(),
    ];
    const report = validateOpencodeExplorerProfile(compliantPolicy({ ruleset }));
    assert.deepEqual(report.blockers, []);
    assert.equal(report.ok, true);
  });

  it("states the read-only, leaf, workspace-scoped, no-approval boundary in its prompt body", () => {
    const { body } = parseReviewedTemplate();
    assert.match(body, /read-only/i);
    assert.match(body, /leaf/i);
    assert.match(body, /never (state|imply)|no edit/i);
    assert.match(body, /approval/i);
    assert.equal(body.includes(OPENCODE_EXPLORER_MODEL), false);
  });

  it("carries no credential, endpoint, or operator absolute path", () => {
    const { raw } = parseReviewedTemplate();
    assert.equal(/password|secret|token|authorization/i.test(raw), false);
    assert.equal(/127\.0\.0\.1|localhost|OPENCODE_SERVER/.test(raw), false);
    assert.equal(/\/(root|home|Users)\//.test(raw), false);
  });
});

// ---------------------------------------------------------------------------
// Frozen constants and their evidence.
// ---------------------------------------------------------------------------

describe("opencode explorer route: frozen constants bound to captured evidence", () => {
  it("admits exactly the three OpenAI subscription full model identifiers", () => {
    assert.equal(OPENCODE_HARNESS_ID, "opencode");
    assert.equal(OPENCODE_EXPLORER_PROVIDER_ID, "openai");
    assert.equal(OPENCODE_EXPLORER_MODEL_ID, "gpt-5.6-luna");
    assert.equal(OPENCODE_EXPLORER_MODEL, "openai/gpt-5.6-luna");
    assert.deepEqual(OPENCODE_EXPLORER_MODELS, [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
    ]);
    assert.equal(OPENCODE_EXPLORER_PROFILE_NAME, "codex-explorer");
  });

  it("keeps the only continuation mode the route proves", () => {
    assert.equal(OPENCODE_EXPLORER_CONTINUATION, "fresh_only");
    assert.equal(OPENCODE_EXPLORER_CAPABILITIES.values.continuation, OPENCODE_EXPLORER_CONTINUATION);
  });

  it("declares leaf, read-only routes with no HarnessDock capacity ceiling", () => {
    assert.equal(OPENCODE_EXPLORER_TOPOLOGY, "leaf");
    assert.equal(OPENCODE_EXPLORER_AUTHORITY, "behavioral_read_only");
    assert.equal(OPENCODE_EXPLORER_CAPACITY_LIMIT, null);
  });

  it("publishes one valid experimental capability snapshot with nothing unproven", () => {
    const snapshot = validateRouteCapabilitySnapshot(OPENCODE_EXPLORER_CAPABILITIES);
    assert.deepEqual(Object.keys(snapshot.values).sort(), [...ROUTE_CAPABILITY_NAMES]);
    assert.deepEqual(snapshot.values, {
      activeInput: "initial_only",
      authorityEnforcement: "harness_policy",
      automaticRecovery: "none",
      continuation: "fresh_only",
      history: "unavailable",
      interaction: "noninteractive_fixed_policy",
      interruptRequest: "unsupported",
      leafEnforcement: "effective_tool_denial",
      nativeOrchestration: "disabled",
      turnObservation: "unavailable",
    });
    assert.equal(snapshot.driverMaturity, "experimental");
    for (const name of ROUTE_CAPABILITY_NAMES) assert.equal(snapshot.maturity[name], "experimental");
  });

  it("keeps the admitted permission set to bounded repository inspection", () => {
    assert.deepEqual([...OPENCODE_ADMITTED_PERMISSIONS], ["glob", "grep", "list", "lsp", "read"]);
    for (const forbidden of ["edit", "write", "apply_patch", "bash", "task", "webfetch", "websearch", "skill", "todowrite", "question", "execute", "doom_loop", "plan_enter", "plan_exit"]) {
      assert.equal(OPENCODE_FORBIDDEN_PERMISSIONS.includes(forbidden), true, forbidden);
      assert.equal(OPENCODE_ADMITTED_PERMISSIONS.includes(forbidden), false, forbidden);
    }
  });

  it("owns no SDK, session, or prompt surface of its own", () => {
    const source = fs.readFileSync(modulePath, "utf8");
    assert.equal(/from\s+"@opencode-ai\/sdk/.test(source), false);
    assert.equal(/import\(["']@opencode-ai/.test(source), false);
    assert.equal(/\.prompt\(|prompt_async|session\.(create|prompt|messages)/.test(source), false);
    assert.equal(/\bfetch\(/.test(source), false);
  });
});

// ---------------------------------------------------------------------------
// 3.2 Upstream permission semantics.
// ---------------------------------------------------------------------------

describe("opencode permission semantics: last matching rule wins, unmatched asks", () => {
  it("matches a rule's permission and pattern as anchored wildcards", () => {
    assert.equal(opencodeWildcardMatch("edit", "*"), true);
    assert.equal(opencodeWildcardMatch("edit", "edit"), true);
    assert.equal(opencodeWildcardMatch("edit", "edi"), false);
    assert.equal(opencodeWildcardMatch("Edit", "edit"), false);
    assert.equal(opencodeWildcardMatch("config/.env", "*.env"), true);
    assert.equal(opencodeWildcardMatch(".env.local", "*.env.*"), true);
    assert.equal(opencodeWildcardMatch("src/a.ts", "*.env"), false);
  });

  it("resolves a permission from the last matching rule", () => {
    const ruleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ];
    assert.equal(resolveOpencodePermission(ruleset, "read", "README.md"), "allow");
    assert.equal(resolveOpencodePermission(ruleset, "edit", "README.md"), "deny");
  });

  it("treats an unmatched permission as an interactive ask, never as a denial", () => {
    assert.equal(resolveOpencodePermission([], "edit", "README.md"), "ask");
    assert.equal(resolveOpencodePermission([{ permission: "read", pattern: "*", action: "allow" }], "bash", "ls"), "ask");
  });

  it("hides a tool only when its last matching rule is a catch-all denial", () => {
    const denied = [{ permission: "*", pattern: "*", action: "deny" }];
    assert.equal(isOpencodeToolHidden(denied, "bash"), true);
    assert.equal(isOpencodeToolHidden([...denied, { permission: "bash", pattern: "*", action: "allow" }], "bash"), false);
    assert.equal(isOpencodeToolHidden([...denied, { permission: "bash", pattern: "ls*", action: "deny" }], "bash"), false);
    assert.equal(isOpencodeToolHidden([], "bash"), false);
  });

  it("maps mutating and MCP-resource tool names onto their permission keys", () => {
    assert.equal(opencodePermissionKeyForTool("edit"), "edit");
    assert.equal(opencodePermissionKeyForTool("write"), "edit");
    assert.equal(opencodePermissionKeyForTool("apply_patch"), "edit");
    assert.equal(opencodePermissionKeyForTool("read_mcp_resource"), "read");
    assert.equal(opencodePermissionKeyForTool("list_mcp_resources"), "read");
    assert.equal(opencodePermissionKeyForTool("bash"), "bash");
    assert.equal(opencodePermissionKeyForTool("mcp__server__tool"), "mcp__server__tool");
  });
});

// ---------------------------------------------------------------------------
// 3.2 / 3.4 Profile validation against the actual resolved policy.
// ---------------------------------------------------------------------------

describe("opencode explorer profile: exact resolved-policy validation", () => {
  it("accepts the reviewed profile and reports only closed bounded facts", () => {
    const report = validateOpencodeExplorerProfile(compliantPolicy());
    assert.equal(report.ok, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.facts.profile, OPENCODE_EXPLORER_PROFILE_NAME);
    assert.equal(report.facts.mode, "primary");
    assert.equal(report.facts.model, OPENCODE_EXPLORER_MODEL);
    assert.equal(report.facts.anchorPresent, true);
    assert.equal(report.facts.externalDirectoryResidualAllows, 1);
    assert.equal(report.facts.dotenvReadDenied, true);
    assert.equal(report.facts.unknownToolProbesDenied, true);
    assert.equal(typeof report.facts.ruleCount, "number");
    assertNoPolicyDisclosure(report);
  });

  it("accepts an `all` mode profile and rejects a subagent-mode profile", () => {
    assert.deepEqual(validateOpencodeExplorerProfile(compliantPolicy({ mode: "all" })).blockers, []);
    const subagent = validateOpencodeExplorerProfile(compliantPolicy({ mode: "subagent" }));
    assert.equal(subagent.ok, false);
    assert.equal(subagent.blockers.includes("profile_mode_unusable"), true);
    const unknownMode = validateOpencodeExplorerProfile(compliantPolicy({ mode: "orchestrator" }));
    assert.equal(unknownMode.blockers.includes("profile_mode_unusable"), true);
    assert.equal(unknownMode.facts.mode, null);
  });

  it("reports a missing profile precisely and never invents presence", () => {
    const report = validateOpencodeExplorerProfile({ ok: true, present: false, agent: null });
    assert.equal(report.ok, false);
    assert.deepEqual(report.blockers, [`profile_missing:${OPENCODE_EXPLORER_PROFILE_NAME}`]);
    assert.equal(report.facts.mode, null);
    assert.equal(report.facts.model, null);
    assert.equal(report.facts.anchorPresent, false);
  });

  it("fails a failed profile lookup instead of assuming a compliant policy", () => {
    const report = validateOpencodeExplorerProfile({ ok: false, code: "malformed_response", retryable: false });
    assert.equal(report.ok, false);
    assert.equal(report.blockers.includes("profile_lookup_failed"), true);
  });

  it("rejects a foreign or absent model on the resolved profile", () => {
    const missing = validateOpencodeExplorerProfile(compliantPolicy({ model: null }));
    assert.equal(missing.blockers.includes("profile_model_missing"), true);
    for (const model of [
      { providerID: "opencode-go", modelID: "kimi-k2.6" },
      { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      { providerID: "opencode-go", modelID: "DeepSeek-V4-Flash" },
      { providerID: "OpenCode-Go", modelID: "deepseek-v4-flash" },
      { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
    ]) {
      const report = validateOpencodeExplorerProfile(compliantPolicy({ model }));
      assert.equal(report.ok, false);
      assert.equal(report.blockers.includes("profile_model_mismatch"), true, JSON.stringify(model));
      assert.equal(report.facts.model, null);
    }
  });

  it("rejects an unproven reasoning-effort variant and injected provider options", () => {
    const variant = validateOpencodeExplorerProfile(compliantPolicy({ variant: "thinking" }));
    assert.equal(variant.blockers.includes("profile_variant_unproven"), true);
    const options = validateOpencodeExplorerProfile(compliantPolicy({ optionKeyCount: 2 }));
    assert.equal(options.blockers.includes("profile_options_present"), true);
    const unknown = validateOpencodeExplorerProfile(compliantPolicy({ unknownFieldCount: 1 }));
    assert.equal(unknown.blockers.includes("profile_policy_malformed"), true);
  });

  it("rejects a native Harness Agent wearing the reviewed profile name", () => {
    const report = validateOpencodeExplorerProfile(compliantPolicy({ native: true }));
    assert.equal(report.blockers.includes("profile_native_conflict"), true);
  });

  it("fails closed when the profile has no default-deny anchor", () => {
    const report = validateOpencodeExplorerProfile(unanchoredPolicy());
    assert.equal(report.ok, false);
    assert.equal(report.blockers.includes("default_deny_anchor_missing"), true);
    assert.equal(report.facts.anchorPresent, false);
  });

  it("rejects every widened effective permission", () => {
    const widenings = [
      ["edit", { permission: "edit", pattern: "*", action: "allow" }],
      ["edit", { permission: "write", pattern: "*", action: "allow" }],
      ["bash", { permission: "bash", pattern: "*", action: "allow" }],
      ["task", { permission: "task", pattern: "*", action: "allow" }],
      ["webfetch", { permission: "webfetch", pattern: "*", action: "allow" }],
      ["websearch", { permission: "websearch", pattern: "*", action: "allow" }],
      ["skill", { permission: "skill", pattern: "*", action: "allow" }],
      ["todowrite", { permission: "todowrite", pattern: "*", action: "allow" }],
      ["question", { permission: "question", pattern: "*", action: "allow" }],
      ["execute", { permission: "execute", pattern: "*", action: "allow" }],
      ["*", { permission: "*", pattern: "*", action: "allow" }],
    ];
    for (const [, rule] of widenings) {
      const report = validateOpencodeExplorerProfile(policyWithExtraRules([rule]));
      assert.equal(report.ok, false, JSON.stringify(rule));
      assert.equal(
        report.blockers.some((blocker) => blocker.startsWith("permission_widened")),
        true,
        JSON.stringify(rule)
      );
      assertNoPolicyDisclosure(report);
    }
  });

  it("rejects a narrowly patterned mutation allowance, not only a catch-all one", () => {
    const report = validateOpencodeExplorerProfile(
      policyWithExtraRules([{ permission: "edit", pattern: "docs/*.md", action: "allow" }])
    );
    assert.equal(report.ok, false);
    assert.equal(report.blockers.includes("permission_widened:edit"), true);
    assertNoPolicyDisclosure(report);
  });

  it("rejects an interactive approval path as a broker requirement", () => {
    for (const rule of [
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "ask" },
    ]) {
      const report = validateOpencodeExplorerProfile(policyWithExtraRules([rule]));
      assert.equal(report.ok, false, JSON.stringify(rule));
      assert.equal(
        report.blockers.some((blocker) => blocker.startsWith("approval_path_admitted")),
        true,
        JSON.stringify(rule)
      );
    }
  });

  it("denies every unknown custom and MCP tool by construction, and rejects one that is allowed", () => {
    const compliant = validateOpencodeExplorerProfile(compliantPolicy());
    assert.equal(compliant.facts.unknownToolProbesDenied, true);
    for (const probe of OPENCODE_UNKNOWN_TOOL_PROBES) {
      assert.equal(isOpencodeToolHidden(compliantRuleset(), probe), true, probe);
      const report = validateOpencodeExplorerProfile(
        policyWithExtraRules([{ permission: probe, pattern: "*", action: "allow" }])
      );
      assert.equal(report.ok, false, probe);
      assert.equal(report.facts.unknownToolProbesDenied, false, probe);
    }
  });

  it("keeps external-directory access denied except for the Server's own appended allowance", () => {
    const compliant = validateOpencodeExplorerProfile(compliantPolicy());
    assert.deepEqual(compliant.blockers, []);
    for (const rule of [
      { permission: "external_directory", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "/", action: "allow" },
      { permission: "external_directory", pattern: "/*", action: "allow" },
      { permission: "external_directory", pattern: "~", action: "allow" },
      { permission: "external_directory", pattern: "../*", action: "allow" },
    ]) {
      const report = validateOpencodeExplorerProfile(policyWithExtraRules([rule]));
      assert.equal(report.ok, false, JSON.stringify(rule));
      assert.equal(report.blockers.includes("external_directory_widened"), true, JSON.stringify(rule));
      assertNoPolicyDisclosure(report);
    }
    const twoAllowances = validateOpencodeExplorerProfile(
      policyWithExtraRules([{ permission: "external_directory", pattern: "/opt/other/dir/*", action: "allow" }])
    );
    assert.equal(twoAllowances.blockers.includes("external_directory_widened"), true);
  });

  it("requires the resolved profile to deny dotenv reads", () => {
    const report = validateOpencodeExplorerProfile(
      policyWithExtraRules([{ permission: "read", pattern: "*.env", action: "allow" }])
    );
    assert.equal(report.ok, false);
    assert.equal(report.blockers.includes("dotenv_read_admitted"), true);
    assert.equal(report.facts.dotenvReadDenied, false);
  });

  it("fails a profile that cannot inspect the repository at all", () => {
    const report = validateOpencodeExplorerProfile(
      policyWithExtraRules([{ permission: "read", pattern: "*", action: "deny" }])
    );
    assert.equal(report.ok, false);
    assert.equal(report.blockers.includes("admitted_permission_denied:read"), true);
  });

  it("rejects a malformed or oversized resolved policy instead of interpreting it", () => {
    for (const ruleset of [
      "not-a-ruleset",
      [{ permission: "read", pattern: "*" }],
      [{ permission: 7, pattern: "*", action: "allow" }],
      [{ permission: "read", pattern: "*", action: "maybe" }],
    ]) {
      const report = validateOpencodeExplorerProfile(compliantPolicy({ ruleset }));
      assert.equal(report.ok, false, JSON.stringify(ruleset));
      assert.equal(report.blockers.includes("profile_policy_malformed"), true, JSON.stringify(ruleset));
    }
  });

  it("refuses an exotic resolved policy that could answer two readers differently", () => {
    for (const agent of [
      compliantAgent({ ruleset: new Proxy(compliantRuleset(), {}) }),
      compliantAgent({
        ruleset: [
          new Proxy({ permission: "*", pattern: "*", action: "deny" }, {}),
        ],
      }),
      compliantAgent({
        ruleset: [
          Object.defineProperty({ pattern: "*", action: "allow" }, "permission", {
            get: () => "read",
            enumerable: true,
          }),
        ],
      }),
    ]) {
      const report = validateOpencodeExplorerProfile({ ok: true, present: true, agent });
      assert.equal(report.ok, false);
      assert.equal(report.blockers.includes("profile_policy_malformed"), true);
    }
    const exoticAgent = validateOpencodeExplorerProfile({
      ok: true,
      present: true,
      agent: new Proxy(compliantAgent(), {}),
    });
    assert.equal(exoticAgent.blockers.includes("profile_policy_malformed"), true);
  });

  it("emits only closed blocker codes with closed details", () => {
    const reports = [
      validateOpencodeExplorerProfile(compliantPolicy()),
      validateOpencodeExplorerProfile(unanchoredPolicy()),
      validateOpencodeExplorerProfile({ ok: true, present: false, agent: null }),
      validateOpencodeExplorerProfile(compliantPolicy({ mode: "subagent", native: true, variant: "x", model: null })),
      validateOpencodeExplorerProfile(policyWithExtraRules([{ permission: "bash", pattern: "*", action: "ask" }])),
    ];
    const closedDetails = new Set([
      OPENCODE_EXPLORER_PROFILE_NAME,
      "*",
      "external_directory",
      ...OPENCODE_ADMITTED_PERMISSIONS,
      ...OPENCODE_FORBIDDEN_PERMISSIONS,
      ...OPENCODE_UNKNOWN_TOOL_PROBES,
    ]);
    for (const report of reports) {
      for (const blocker of report.blockers) {
        const [code, ...rest] = blocker.split(":");
        assert.equal(OPENCODE_READINESS_BLOCKER_CODES.includes(code), true, blocker);
        if (rest.length) assert.equal(closedDetails.has(rest.join(":")), true, blocker);
      }
      assert.deepEqual([...report.blockers].sort(), report.blockers);
      assert.equal(new Set(report.blockers).size, report.blockers.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.3 Route request rejection, before any session exists.
// ---------------------------------------------------------------------------

describe("opencode explorer route request: exact, immutable, selector-free", () => {
  it("accepts each exact discovered route and echoes nothing else", () => {
    for (const model of OPENCODE_EXPLORER_MODELS) {
      const request = exactRouteRequest({ model });
      const route = validateOpencodeExplorerRouteRequest(request);
      assert.deepEqual({ ...route }, request);
      assert.deepEqual(Object.keys(route).sort(), [...ROUTE_REQUEST_FIELDS]);
      assert.equal(Object.isFrozen(route), true);
    }
  });

  it("rejects an omitted, aliased, substituted, or case-variant model", () => {
    const cases = [
      [undefined, "model_required"],
      ["", "model_required"],
      ["deepseek-v4-flash", "model_not_admitted"],
      ["opencode-go", "model_not_admitted"],
      ["opencode-go/deepseek", "model_not_admitted"],
      ["opencode-go/deepseek-v4-flash ", "model_not_admitted"],
      [" opencode-go/deepseek-v4-flash", "model_not_admitted"],
      ["OpenCode-Go/deepseek-v4-flash", "model_not_admitted"],
      ["opencode-go/DeepSeek-V4-Flash", "model_not_admitted"],
      ["opencode-go/deepseek-v4-flash:thinking", "model_not_admitted"],
      ["openai/gpt-5.6-luna-fast", "model_not_admitted"],
      ["openai/gpt-5.6-terra-fast", "model_not_admitted"],
      ["openai/gpt-5.6-sol-fast", "model_not_admitted"],
      ["opencode-go/kimi-k2.6", "model_not_admitted"],
      ["flash", "model_not_admitted"],
      [{ providerID: "opencode-go", modelID: "deepseek-v4-flash" }, "model_required"],
    ];
    for (const [model, code] of cases) {
      const request = exactRouteRequest();
      if (model === undefined) delete request.model;
      else request.model = model;
      assert.throws(
        () => validateOpencodeExplorerRouteRequest(request),
        (error) => error instanceof OpencodeRouteError && error.code === code,
        JSON.stringify(model ?? null)
      );
    }
  });

  it("rejects a foreign Harness, a topology change, and write authority", () => {
    assert.throws(
      () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ harnessId: "claude-code" })),
      (error) => error.code === "harness_not_admitted"
    );
    assert.throws(
      () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ topology: "native_orchestrator" })),
      (error) => error.code === "topology_not_admitted"
    );
    assert.throws(
      () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ authority: "behavioral_write" })),
      (error) => error.code === "write_authority_rejected"
    );
    assert.throws(
      () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ authority: undefined })),
      (error) => error.code === "authority_required"
    );
  });

  it("rejects an unproven reasoning effort under either public spelling", () => {
    for (const field of ["reasoning_effort", "reasoningEffort", "effort", "variant"]) {
      assert.throws(
        () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ [field]: "high" })),
        (error) => error instanceof OpencodeRouteError && error.code === "reasoning_effort_unproven",
        field
      );
    }
  });

  it("rejects every dynamic tool, profile, instance, endpoint, and session selector", () => {
    const selectors = {
      tools: { read: true },
      agent: "build",
      profile: "codex-explorer",
      permission: { "*": "allow" },
      instanceKey: "opencode-server-0000000000000000",
      sessionId: "ses_1",
      sessionID: "ses_1",
      endpoint: "http://127.0.0.1:4096",
      serverUrl: "http://127.0.0.1:4096",
      baseUrl: "http://10.0.0.1:4096",
      write: true,
      harness: "opencode",
      capabilities: {},
      timeoutMs: 1,
    };
    for (const [field, value] of Object.entries(selectors)) {
      assert.throws(
        () => validateOpencodeExplorerRouteRequest(exactRouteRequest({ [field]: value })),
        (error) =>
          error instanceof OpencodeRouteError &&
          (error.code === "unexpected_route_field" || error.code === "write_authority_rejected") &&
          (error.field === field || error.code === "write_authority_rejected"),
        field
      );
    }
  });

  it("refuses an exotic request object outright", () => {
    for (const request of [
      null,
      "opencode",
      [],
      new Proxy(exactRouteRequest(), {}),
      Object.defineProperty(exactRouteRequest(), "model", { get: () => OPENCODE_EXPLORER_MODEL, enumerable: true }),
      Object.assign(Object.create({ model: OPENCODE_EXPLORER_MODEL }), {
        harnessId: OPENCODE_HARNESS_ID,
        topology: OPENCODE_EXPLORER_TOPOLOGY,
        authority: OPENCODE_EXPLORER_AUTHORITY,
      }),
    ]) {
      assert.throws(
        () => validateOpencodeExplorerRouteRequest(request),
        (error) => error instanceof OpencodeRouteError && error.code === "route_request_malformed"
      );
    }
  });

  it("refuses a broker-required or otherwise unproven capability snapshot", () => {
    assert.deepEqual(assertOpencodeRouteCapabilities(OPENCODE_EXPLORER_CAPABILITIES).values.interaction, "noninteractive_fixed_policy");
    const broker = {
      ...OPENCODE_EXPLORER_CAPABILITIES,
      values: { ...OPENCODE_EXPLORER_CAPABILITIES.values, interaction: "requires_broker" },
    };
    assert.throws(
      () => assertOpencodeRouteCapabilities(broker),
      (error) => error instanceof OpencodeRouteError && error.code === "interaction_requires_broker"
    );
    const unproven = {
      continuation: "exact_resume",
      activeInput: "acknowledged_active_stream",
      history: "assistant_messages",
      interruptRequest: "supported",
      turnObservation: "terminal_observable",
      automaticRecovery: "exact_session_transport",
      authorityEnforcement: "process_sandbox",
      nativeOrchestration: "opaque_bounded",
      leafEnforcement: "prompt_only",
    };
    for (const [capability, value] of Object.entries(unproven)) {
      assert.throws(
        () =>
          assertOpencodeRouteCapabilities({
            ...OPENCODE_EXPLORER_CAPABILITIES,
            values: { ...OPENCODE_EXPLORER_CAPABILITIES.values, [capability]: value },
          }),
        (error) =>
          error instanceof OpencodeRouteError &&
          error.code === "capability_not_proven" &&
          error.capability === capability,
        capability
      );
    }
    assert.throws(
      () =>
        assertOpencodeRouteCapabilities({
          ...OPENCODE_EXPLORER_CAPABILITIES,
          maturity: { ...OPENCODE_EXPLORER_CAPABILITIES.maturity, history: "validated" },
        }),
      (error) => error instanceof OpencodeRouteError && error.code === "capability_not_proven"
    );
  });
});

// ---------------------------------------------------------------------------
// 3.4 Readiness assessment.
// ---------------------------------------------------------------------------

describe("opencode explorer readiness: contract-shaped, live-validated, no model request", () => {
  it("reports one ready experimental instance for an exact successful discovery", () => {
    const { inspection, blockers, facts } = assessOpencodeExplorerReadiness(readinessInput());
    assert.deepEqual(blockers, []);
    assert.deepEqual(validateInstanceInspection(inspection, { harnessId: OPENCODE_HARNESS_ID }), inspection);
    assert.equal(inspection.readiness, "ready");
    assert.equal(inspection.detailCode, "ready");
    assert.equal(inspection.liveValidated, true);
    assert.equal(inspection.maturity, "experimental");
    assert.equal(inspection.instanceKey, opencodeExplorerInstanceKey("http://127.0.0.1:4096"));
    assert.deepEqual(inspection.routes.models, OPENCODE_EXPLORER_MODELS);
    assert.deepEqual(inspection.routes.topologies, [OPENCODE_EXPLORER_TOPOLOGY]);
    assert.equal(inspection.routes.authority, OPENCODE_EXPLORER_AUTHORITY);
    assert.equal(inspection.routes.capacity, OPENCODE_EXPLORER_CAPACITY_LIMIT);
    assert.equal(inspection.routes.profile, OPENCODE_EXPLORER_PROFILE_NAME);
    assert.equal(inspection.routes.continuation, "fresh_only");
    assert.equal(inspection.routes.interaction, "noninteractive_fixed_policy");
    assert.equal(inspection.routes.turnObservation, "unavailable");
    assert.equal(inspection.routes.interruptRequest, "unsupported");
    assert.equal(inspection.routes.history, "unavailable");
    assert.equal(inspection.routes.automaticRecovery, "none");
    assert.equal(inspection.routes.authorityEnforcement, "harness_policy");
    assert.equal(inspection.routes.leafEnforcement, "effective_tool_denial");
    assert.equal(inspection.routes.nativeOrchestration, "disabled");
    assert.equal(inspection.routes.driverMaturity, "experimental");
    assert.equal(facts.profile, OPENCODE_EXPLORER_PROFILE_NAME);
    assertNoPolicyDisclosure({ inspection, blockers, facts });
  });

  it("derives a stable redacted instance key that never carries the endpoint", () => {
    const key = opencodeExplorerInstanceKey("http://127.0.0.1:4096");
    assert.match(key, /^opencode-server-[0-9a-f]{16}$/);
    assert.equal(key.includes("4096"), false);
    assert.equal(key, opencodeExplorerInstanceKey("http://127.0.0.1:4096/"));
    assert.notEqual(key, opencodeExplorerInstanceKey("http://127.0.0.1:4097"));
    assert.throws(() => opencodeExplorerInstanceKey("http://10.0.0.5:4096"), /loopback/i);
  });

  it("reports an unreachable or unhealthy Server without repairing anything", () => {
    const unreachable = assessOpencodeExplorerReadiness(
      readinessInput({ health: { ok: false, code: "network_error", retryable: true } })
    );
    assert.equal(unreachable.inspection.readiness, "unavailable");
    assert.equal(unreachable.inspection.detailCode, "service_unreachable");
    assert.equal(unreachable.inspection.liveValidated, false);
    assert.equal(unreachable.inspection.routes, null);
    assert.equal(unreachable.blockers.includes("server_unreachable"), true);
    const unhealthy = assessOpencodeExplorerReadiness(
      readinessInput({ health: { ok: true, healthy: false, version: null } })
    );
    assert.equal(unhealthy.inspection.detailCode, "service_unreachable");
    assert.equal(unhealthy.blockers.includes("server_unhealthy"), true);
  });

  it("reports an authentication failure without echoing any credential", () => {
    const report = assessOpencodeExplorerReadiness(
      readinessInput({ health: { ok: false, code: "auth_failed", retryable: false } })
    );
    assert.equal(report.inspection.readiness, "blocked");
    assert.equal(report.inspection.detailCode, "not_authenticated");
    assert.deepEqual(report.blockers, ["server_auth_failed"]);
    const serialized = JSON.stringify(report);
    assert.equal(/password|authorization|basic |secret/i.test(serialized), false);
  });

  it("blocks a missing, disconnected, or substituted model route", () => {
    const broken = exactProviders();
    broken[2] = { ...broken[2], model: { id: "gpt-5.6-sol-fast", providerID: "openai" } };
    for (const providers of [
      exactProviders().slice(0, -1),
      exactProviders().map((provider, index) => index === 1 ? { ...provider, providerConnected: false } : provider),
      broken,
    ]) {
      const report = assessOpencodeExplorerReadiness(readinessInput({ providers }));
      assert.equal(report.inspection.readiness, "blocked", JSON.stringify(providers));
      assert.equal(report.inspection.detailCode, "not_configured", JSON.stringify(providers));
      assert.equal(report.inspection.routes, null);
      assert.equal(report.blockers.includes("model_route_not_confirmed"), true, JSON.stringify(providers));
    }
  });

  it("blocks profile drift, an unsafe permission, and an unknown admitted tool", () => {
    const missing = assessOpencodeExplorerReadiness(
      readinessInput({ policy: { ok: true, present: false, agent: null } })
    );
    assert.equal(missing.inspection.readiness, "blocked");
    assert.equal(missing.inspection.detailCode, "not_configured");
    assert.equal(missing.inspection.liveValidated, true);
    assert.deepEqual(missing.blockers, [`profile_missing:${OPENCODE_EXPLORER_PROFILE_NAME}`]);
    const widened = assessOpencodeExplorerReadiness(
      readinessInput({ policy: policyWithExtraRules([{ permission: "bash", pattern: "*", action: "allow" }]) })
    );
    assert.equal(widened.inspection.readiness, "blocked");
    assert.equal(widened.blockers.includes("permission_widened:bash"), true);
    const unknownTool = assessOpencodeExplorerReadiness(
      readinessInput({
        policy: policyWithExtraRules([
          { permission: OPENCODE_UNKNOWN_TOOL_PROBES[0], pattern: "*", action: "allow" },
        ]),
      })
    );
    assert.equal(unknownTool.inspection.readiness, "blocked");
    assert.equal(
      unknownTool.blockers.some((blocker) => blocker.startsWith("permission_widened")),
      true
    );
  });

  it("keeps readiness uncapped while retaining the held-turn observation", () => {
    const report = assessOpencodeExplorerReadiness(readinessInput({ heldCapacity: 10_000 }));
    assert.equal(report.inspection.readiness, "ready");
    assert.equal(report.inspection.detailCode, "ready");
    assert.equal(report.inspection.liveValidated, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.inspection.routes.capacity, null);
    assert.equal(report.facts.heldCapacity, 10_000);
    assert.throws(() => assessOpencodeExplorerReadiness(readinessInput({ heldCapacity: -1 })));
    assert.throws(() => assessOpencodeExplorerReadiness(readinessInput({ heldCapacity: "1" })));
    assert.throws(() => assessOpencodeExplorerReadiness(readinessInput({ heldCapacity: undefined })));
  });

  it("keeps the route facts inside the durable instance bound", () => {
    const { inspection } = assessOpencodeExplorerReadiness(readinessInput());
    assert.ok(JSON.stringify(inspection.routes).length < 4 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 3.4 The bounded discovery-to-readiness path against a fake Server.
// ---------------------------------------------------------------------------

describe("opencode explorer readiness: fake-Server discovery is GET-only and session-free", () => {
  function agentBody(overrides = {}) {
    return [
      { name: "build", description: "d", mode: "primary", native: true, permission: operatorConfigRules(), options: {} },
      {
        name: OPENCODE_EXPLORER_PROFILE_NAME,
        description: "Read-only repository Explorer.",
        mode: "primary",
        native: false,
        permission: compliantRuleset(),
        model: { providerID: OPENCODE_EXPLORER_PROVIDER_ID, modelID: OPENCODE_EXPLORER_MODEL_ID },
        options: {},
        ...overrides,
      },
    ];
  }

  function providerBody() {
    const providers = [...new Set(OPENCODE_EXPLORER_MODEL_ROUTES.map((route) => route.providerId))];
    return {
      all: providers.map((providerId) => ({
        id: providerId,
        models: Object.fromEntries(
          OPENCODE_EXPLORER_MODEL_ROUTES
            .filter((route) => route.providerId === providerId)
            .map((route) => [route.modelId, {
              id: route.modelId,
              providerID: route.providerId,
              name: route.model,
              family: null,
            }])
        ),
      })),
      connected: providers,
      default: {},
    };
  }

  it("reads exactly one named profile's resolved policy", async () => {
    const { url } = await startServer({ agents: { status: 200, body: agentBody() } });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const policy = await discoverOpencodeAgentPolicy(handle, { name: OPENCODE_EXPLORER_PROFILE_NAME });
    assert.equal(policy.ok, true);
    assert.equal(policy.present, true);
    assert.equal(policy.agent.name, OPENCODE_EXPLORER_PROFILE_NAME);
    assert.equal(policy.agent.mode, "primary");
    assert.equal(policy.agent.native, false);
    assert.deepEqual(policy.agent.model, {
      providerID: OPENCODE_EXPLORER_PROVIDER_ID,
      modelID: OPENCODE_EXPLORER_MODEL_ID,
    });
    assert.equal(policy.agent.optionKeyCount, 0);
    assert.equal(policy.agent.unknownFieldCount, 0);
    assert.deepEqual(policy.agent.ruleset, compliantRuleset());
    assert.equal(JSON.stringify(policy).includes('"build"'), false);
  });

  it("reports an absent profile without inventing one", async () => {
    const { url } = await startServer({
      agents: { status: 200, body: [{ name: "build", mode: "primary", native: true, permission: [], options: {} }] },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const policy = await discoverOpencodeAgentPolicy(handle, { name: OPENCODE_EXPLORER_PROFILE_NAME });
    assert.deepEqual(policy, { ok: true, present: false, agent: null });
  });

  it("rejects a duplicated profile name and a malformed rule", async () => {
    const duplicate = await startServer({
      agents: { status: 200, body: [...agentBody(), ...agentBody()] },
    });
    const duplicateHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: duplicate.url } });
    assert.deepEqual(await discoverOpencodeAgentPolicy(duplicateHandle, { name: OPENCODE_EXPLORER_PROFILE_NAME }), {
      ok: false,
      code: "malformed_response",
      retryable: false,
    });
    const malformed = await startServer({
      agents: { status: 200, body: agentBody({ permission: [{ permission: "read", pattern: "*" }] }) },
    });
    const malformedHandle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: malformed.url } });
    assert.deepEqual(await discoverOpencodeAgentPolicy(malformedHandle, { name: OPENCODE_EXPLORER_PROFILE_NAME }), {
      ok: false,
      code: "malformed_response",
      retryable: false,
    });
  });

  it("counts an unknown resolved-Agent field instead of ignoring it", async () => {
    const { url } = await startServer({
      agents: { status: 200, body: agentBody({ toolPolicyV2: { bash: true } }) },
    });
    const handle = createOpencodeDiscoveryClient({ env: { OPENCODE_SERVER_URL: url } });
    const policy = await discoverOpencodeAgentPolicy(handle, { name: OPENCODE_EXPLORER_PROFILE_NAME });
    assert.equal(policy.agent.unknownFieldCount, 1);
    const report = validateOpencodeExplorerProfile(policy);
    assert.equal(report.blockers.includes("profile_policy_malformed"), true);
  });

  it("assesses a ready instance through the client without a session or a mutating request", async () => {
    const { server, url } = await startServer({
      agents: { status: 200, body: agentBody() },
      provider: { status: 200, body: providerBody() },
    });
    const report = await inspectOpencodeExplorerInstance({
      env: { OPENCODE_SERVER_URL: url },
      heldCapacity: 0,
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.inspection.readiness, "ready");
    assert.equal(report.inspection.liveValidated, true);
    assert.deepEqual(validateInstanceInspection(report.inspection, { harnessId: OPENCODE_HARNESS_ID }), report.inspection);
    assert.equal(report.inspection.instanceKey, opencodeExplorerInstanceKey(url));
    const paths = server.requests.map((request) => request.path);
    assert.deepEqual(
      server.requests.filter((request) => request.method !== "GET"),
      []
    );
    for (const requestPath of paths) {
      assert.equal(["/global/health", "/agent", "/provider", "/experimental/capabilities"].includes(requestPath), true, requestPath);
    }
    assert.equal(paths.some((requestPath) => requestPath.includes("session")), false);
    assert.equal(paths.some((requestPath) => requestPath.includes("message")), false);
    assertNoPolicyDisclosure(report);
  });

  it("blocks a profile the fake Server resolves wider than the reviewed contract", async () => {
    const { url } = await startServer({
      agents: {
        status: 200,
        body: agentBody({
          permission: compliantRuleset([{ permission: "edit", pattern: "*", action: "allow" }]),
        }),
      },
      provider: { status: 200, body: providerBody() },
    });
    const report = await inspectOpencodeExplorerInstance({ env: { OPENCODE_SERVER_URL: url }, heldCapacity: 0 });
    assert.equal(report.inspection.readiness, "blocked");
    assert.equal(report.inspection.detailCode, "not_configured");
    assert.equal(report.blockers.includes("permission_widened:edit"), true);
    assert.equal(report.inspection.routes, null);
  });

  it("stops at an unreachable Server without touching the profile or model route", async () => {
    const { server, url } = await startServer({ hangPaths: ["/global/health"] });
    const report = await inspectOpencodeExplorerInstance({
      env: { OPENCODE_SERVER_URL: url },
      heldCapacity: 0,
      connectTimeoutMs: 150,
    });
    assert.equal(report.inspection.readiness, "unavailable");
    assert.equal(report.inspection.detailCode, "service_unreachable");
    assert.equal(report.inspection.liveValidated, false);
    assert.deepEqual(
      server.requests.map((request) => request.path),
      ["/global/health"]
    );
  });
});

// ---------------------------------------------------------------------------
// The operator's own Server, read-only, skipped when unreachable.
// ---------------------------------------------------------------------------

describe("opencode explorer readiness: rejected configuration never reaches a request", () => {
  it("refuses a non-loopback configured Server before any connection", async () => {
    await assert.rejects(
      () => inspectOpencodeExplorerInstance({ env: { OPENCODE_SERVER_URL: "http://10.0.0.5:4096" }, heldCapacity: 0 }),
      (error) => error.code === "invalid_server_url"
    );
    await assert.rejects(
      () => inspectOpencodeExplorerInstance({ env: { OPENCODE_SERVER_URL: "http://localhost:4096" }, heldCapacity: 0 }),
      (error) => error.code === "invalid_server_url"
    );
  });
});

describe("opencode explorer readiness: live operator Server (skips if unreachable)", () => {
  it("reports the current profile state exactly, inventing no presence", async (t) => {
    const report = await inspectOpencodeExplorerInstance({
      env: { OPENCODE_SERVER_URL: "http://127.0.0.1:4096" },
      heldCapacity: 0,
      connectTimeoutMs: 3000,
    }).catch(() => null);
    if (!report || report.inspection.detailCode === "service_unreachable") {
      t.skip("operator OpenCode Server is not reachable");
      return;
    }
    assert.equal(report.inspection.harnessId, OPENCODE_HARNESS_ID);
    assert.equal(report.inspection.maturity, "experimental");
    if (report.facts.profilePresent === false) {
      assert.equal(report.inspection.readiness, "blocked");
      assert.equal(report.inspection.detailCode, "not_configured");
      assert.equal(report.blockers.includes(`profile_missing:${OPENCODE_EXPLORER_PROFILE_NAME}`), true);
      assert.equal(report.inspection.routes, null);
    } else if (report.blockers.length === 0) {
      assert.equal(report.inspection.readiness, "ready");
      assert.equal(report.inspection.routes.profile, OPENCODE_EXPLORER_PROFILE_NAME);
    } else {
      assert.equal(report.inspection.readiness, "blocked");
    }
    assertNoPolicyDisclosure(report);
  });
});
