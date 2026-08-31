/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Repo-wide proof that the retired `cc`/`CC` identity is gone by absence.
 *
 * ## Why absence needs its own test
 *
 * A missed `CC_*` variable fails at runtime, not at compile time: nothing in
 * lint or typecheck notices that a reader was renamed and its writer was not.
 * The flag day deliberately ships no aliases and no fallbacks, so the only
 * cheap way to keep it honest is to scan the tracked tree for the retired
 * tokens and name the offending file.
 *
 * ## The allowlist is per-file AND per-token
 *
 * A file is never blanket-exempt. Each entry states exactly which retired
 * token that path may still contain and why, so a file allowed to keep its
 * retired-name *refusal* still fails if it ever grows a retired *variable*.
 * The two categories that legitimately survive the rename are:
 *
 *   - refusals and diagnostics, which must name the retired thing in order to
 *     reject or count it (`runtime/paths.mjs`, the usage ledger);
 *   - historical records, which describe what was true then (CHANGELOG,
 *     archived changes, dated handoffs, superseded plans, the pre-archive
 *     OpenSpec baseline this very change rewrites at archive time).
 *
 * This file assembles every forbidden token by concatenation so that the guard
 * does not match itself and therefore needs no exemption of its own.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

// Split literals: the scanner must not be its own first offender.
const UPPER = "CC";
const LOWER = "cc";

const RETIRED_ENV_PREFIX = "retired-env-prefix";
const RETIRED_BRAND_SHORTHAND = "retired-brand-shorthand";
const RETIRED_AGENT_WORDING = "retired-agent-wording";
const RETIRED_MCP_WORDING = "retired-mcp-wording";
const RETIRED_PLUGIN_SLUG = "retired-plugin-slug";
const RETIRED_SERVER_NAME = "retired-server-name";
const RETIRED_JOB_PREFIX = "retired-job-prefix";
const RETIRED_CHECKOUT_PATH = "retired-checkout-path";

/**
 * Tokens 1-5 are identifiers and wording owned by source, scripts, plugin
 * metadata, tests, and the two current top-level documents. Token 6 is the
 * retired checkout path, which is scanned across the whole tracked tree
 * because a stale path in any document sends an operator to a directory that
 * will not exist after the relocation.
 */
const SOURCE_SCOPE_TOKENS = Object.freeze([
  { id: RETIRED_ENV_PREFIX, pattern: new RegExp(`${UPPER}_[A-Z][A-Z0-9_]*`) },
  { id: RETIRED_AGENT_WORDING, pattern: new RegExp(`${UPPER} Agent`) },
  { id: RETIRED_MCP_WORDING, pattern: new RegExp(`${UPPER} MCP`) },
  { id: RETIRED_PLUGIN_SLUG, pattern: new RegExp(`${LOWER}-for-pein`) },
  { id: RETIRED_SERVER_NAME, pattern: new RegExp(`${LOWER}_for_pein`) },
  { id: RETIRED_JOB_PREFIX, pattern: new RegExp(`${LOWER}-agent-`) },
]);

const CHECKOUT_PATH_TOKEN = Object.freeze({
  id: RETIRED_CHECKOUT_PATH,
  // Backslashes are optional so a regex-escaped assertion (`\\/data\\/...`) is
  // recognised as the same reference; a plain-literal pattern silently misses
  // every path that appears inside a test's own regex.
  //
  // The reference-only external clone lives at a different parent and is a
  // deliberate, still-current denial target, so it must not match.
  pattern: new RegExp(`\\\\?/data\\\\?/CoordExp\\\\?/${LOWER}-plugin-codex`),
});

const PLUGIN_BRAND_TOKEN = Object.freeze({
  id: RETIRED_BRAND_SHORTHAND,
  pattern: new RegExp(`\\b${UPPER}\\b`),
});

const SOURCE_SCOPE_PREFIXES = Object.freeze([
  "runtime/",
  "scripts/",
  "plugins/",
  "tests/",
  "config/",
]);

const SOURCE_SCOPE_FILES = Object.freeze(["package.json", "README.md", "AGENTS.md"]);

/**
 * Exact paths mapped to the exact tokens they may still contain. Anything not
 * listed here is a defect, and any listed file that grows a *different*
 * retired token is still a defect.
 */
const ALLOWED = new Map([
  // Refusals: these modules exist to reject the retired runtime-home override
  // rather than silently ignore it and fall back to the operator namespace.
  ["runtime/paths.mjs", [RETIRED_ENV_PREFIX]],
  ["runtime/plugin-identity-cutover.mjs", [RETIRED_ENV_PREFIX]],
  ["tests/runtime/plugin-identity-cutover.test.mjs", [RETIRED_ENV_PREFIX]],

  // Diagnostic: the usage report must name the retired MCP server in order to
  // recognise its events and exclude them from usage.
  ["runtime/operator-usage-ledger.mjs", [RETIRED_SERVER_NAME]],
  ["tests/runtime/operator-usage-ledger.test.mjs", [RETIRED_SERVER_NAME]],

  // Historical records: true when written, never rewritten.
  ["docs/activation-runbook.md", [RETIRED_CHECKOUT_PATH]],
]);

const ALLOWED_PREFIXES = Object.freeze([
  // Archived changes are the record of decisions already made.
  { prefix: "openspec/changes/archive/", tokens: [RETIRED_CHECKOUT_PATH] },
  // The pre-archive OpenSpec baseline. Every requirement below that still
  // names the retired path is rewritten by this change's own spec deltas when
  // the change is archived; editing them by hand here would fork the baseline.
  { prefix: "openspec/specs/", tokens: [RETIRED_CHECKOUT_PATH] },
  // This change necessarily names the path it is moving away from.
  {
    prefix: "openspec/changes/complete-harnessdock-physical-rename/",
    tokens: [RETIRED_CHECKOUT_PATH],
  },
  // Dated handoffs and superseded implementation plans.
  { prefix: "docs/handoffs/", tokens: [RETIRED_CHECKOUT_PATH] },
  { prefix: "docs/superpowers/", tokens: [RETIRED_CHECKOUT_PATH] },
]);

const SKIPPED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2"]);

function trackedFiles() {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    throw new Error("Retired-token guard requires a Git checkout to enumerate tracked files.", {
      cause: error,
    });
  }
  return output.split("\0").filter(Boolean);
}

function allowedTokensFor(relativePath) {
  const exact = ALLOWED.get(relativePath);
  if (exact) return new Set(exact);
  for (const entry of ALLOWED_PREFIXES) {
    if (relativePath.startsWith(entry.prefix)) return new Set(entry.tokens);
  }
  return new Set();
}

function inSourceScope(relativePath) {
  return (
    SOURCE_SCOPE_FILES.includes(relativePath) ||
    SOURCE_SCOPE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function scan() {
  const offenders = [];
  for (const relativePath of trackedFiles()) {
    if (SKIPPED_EXTENSIONS.has(path.extname(relativePath))) continue;
    const absolute = path.join(root, relativePath);
    let text;
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      continue; // A file removed between listing and reading cannot offend.
    }
    const allowed = allowedTokensFor(relativePath);
    const applicable = inSourceScope(relativePath)
      ? [...SOURCE_SCOPE_TOKENS, CHECKOUT_PATH_TOKEN]
      : [CHECKOUT_PATH_TOKEN];
    if (relativePath.startsWith("plugins/")) applicable.push(PLUGIN_BRAND_TOKEN);
    for (const token of applicable) {
      if (allowed.has(token.id)) continue;
      const lines = text.split(/\r?\n/);
      const index = lines.findIndex((line) => token.pattern.test(line));
      if (index >= 0) {
        offenders.push(`${relativePath}:${index + 1} [${token.id}] ${lines[index].trim().slice(0, 120)}`);
      }
    }
  }
  return offenders;
}

describe("retired identity tokens are absent from the tracked tree", () => {
  it("finds no retired variable, wording, slug, job prefix, or checkout path", () => {
    const offenders = scan();
    assert.deepEqual(
      offenders,
      [],
      `Retired identity tokens survive in ${offenders.length} file(s):\n  ${offenders.join("\n  ")}`,
    );
  });

  it("keeps the allowlist honest: every listed path exists and still needs its exemption", () => {
    const stale = [];
    for (const [relativePath, tokens] of ALLOWED) {
      const absolute = path.join(root, relativePath);
      if (!fs.existsSync(absolute)) {
        stale.push(`${relativePath} is allowlisted but no longer tracked`);
        continue;
      }
      const text = fs.readFileSync(absolute, "utf8");
      const all = [...SOURCE_SCOPE_TOKENS, CHECKOUT_PATH_TOKEN];
      for (const id of tokens) {
        const token = all.find((candidate) => candidate.id === id);
        assert.ok(token, `Allowlist names an unknown token id: ${id}`);
        if (!token.pattern.test(text)) {
          stale.push(`${relativePath} no longer contains [${id}]; drop the exemption`);
        }
      }
    }
    assert.deepEqual(stale, [], `Stale allowlist entries:\n  ${stale.join("\n  ")}`);
  });
});
