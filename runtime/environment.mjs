/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deterministic environment layering without shell evaluation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ENV_FILE = path.join(PLUGIN_ROOT, "config", "runtime.env");
const DEFAULT_CLAUDE_CONFIG_DIR = "/data/CoordExp/.claude";
const SUPPORTED_KEYS = new Set([
  "CLAUDE_NATIVE_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CONDA_EXE",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "http_proxy", "https_proxy", "all_proxy",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "no_proxy", "NO_PROXY",
  "CODEX_HARNESSDOCK_CLAUDE_BIN",
  "CODEX_HARNESSDOCK_RUNTIME_CHECKOUT",
  "CODEX_HARNESSDOCK_CLAUDE_RECONNECT_ATTEMPTS",
  "CODEX_HARNESSDOCK_CLAUDE_RECONNECT_BASE_DELAY_MS",
  "PI_CODING_AGENT_DIR",
  "OPENCODE_EXECUTABLE",
  "OPENCODE_SERVER_URL",
  "HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS",
]);

// Official OpenCode Basic-auth credentials. These are intentionally excluded
// from SUPPORTED_KEYS: they may only be read from the inherited operator
// process environment (see readOpencodeSecrets), never from a tracked dotenv
// file or the merged runtime environment.
const OPENCODE_SECRET_KEYS = new Set(["OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"]);

function parseEnvFile(filePath) {
  const values = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid env syntax at ${filePath}:${index + 1}.`);
    const [, key, rawValue] = match;
    if (OPENCODE_SECRET_KEYS.has(key)) {
      throw new Error(`${key} is not allowed in tracked env file: ${filePath}:${index + 1}.`);
    }
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function existing(filePath) {
  return filePath && fs.existsSync(filePath) ? path.resolve(filePath) : null;
}

function findAncestorEnvFile(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    const candidate = existing(path.join(current, ".codex", ".env"));
    if (candidate) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function redactProxy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
  }
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export const OPENCODE_IDLE_TTL_DEFAULT_SECONDS = 3_600;
export const OPENCODE_IDLE_TTL_MIN_SECONDS = 60;
export const OPENCODE_IDLE_TTL_MAX_SECONDS = 604_800;

export function resolveOpencodeIdleTtlSeconds(env) {
  const raw = nonEmpty(env?.HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS);
  if (raw == null) return OPENCODE_IDLE_TTL_DEFAULT_SECONDS;
  if (!/^[0-9]+$/.test(raw)) throw new Error("HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS must be an integer from 60 through 604800.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < OPENCODE_IDLE_TTL_MIN_SECONDS || value > OPENCODE_IDLE_TTL_MAX_SECONDS) {
    throw new Error("HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS must be an integer from 60 through 604800.");
  }
  return value;
}

export function resolveRuntimeEnvironment(options = {}) {
  const inherited = { ...(options.env ?? process.env) };
  const codexHome = inherited.CODEX_HOME
    ? path.resolve(inherited.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const projectEnv = codexHome ? existing(path.join(codexHome, ".env")) : null;
  const workspaceEnv = findAncestorEnvFile(options.cwd ?? process.cwd());
  const defaultEnv = existing(DEFAULT_ENV_FILE);
  const explicitPath = options.envFile ?? inherited.CODEX_HARNESSDOCK_RUNTIME_ENV_FILE ?? null;
  const explicitEnv = explicitPath ? existing(path.resolve(options.cwd ?? process.cwd(), explicitPath)) : null;
  if (explicitPath && !explicitEnv) throw new Error(`Runtime env file not found: ${explicitPath}`);

  const selectedEnv = explicitEnv ?? projectEnv ?? workspaceEnv ?? defaultEnv;
  const sources = selectedEnv ? [selectedEnv] : [];
  const selectedValues = selectedEnv ? parseEnvFile(selectedEnv) : {};
  const env = {
    ...inherited,
    ...selectedValues,
  };
  const effectiveClaudeConfigDir = nonEmpty(env.CLAUDE_NATIVE_CONFIG_DIR)
    ?? nonEmpty(env.CLAUDE_CONFIG_DIR)
    ?? DEFAULT_CLAUDE_CONFIG_DIR;
  env.CLAUDE_CONFIG_DIR = path.resolve(effectiveClaudeConfigDir);
  // This assignment intentionally follows the single selected-file merge so
  // neither an inherited value nor that file can disable native Auto Memory.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "0";
  if (selectedEnv) env.CODEX_HARNESSDOCK_RUNTIME_ENV_FILE = selectedEnv;
  // OpenCode Basic-auth credentials never enter the merged runtime environment,
  // even if inherited from the operator process; see readOpencodeSecrets.
  for (const secretKey of OPENCODE_SECRET_KEYS) delete env[secretKey];
  if (!Object.hasOwn(selectedValues, "HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS")) {
    delete env.HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS;
  }
  resolveOpencodeIdleTtlSeconds(env);

  return {
    env,
    receipt: {
      sources,
      runtimeCheckout: env.CODEX_HARNESSDOCK_RUNTIME_CHECKOUT ?? null,
      claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,
      proxyEndpoints: {
        http: redactProxy(env.HTTP_PROXY ?? env.http_proxy),
        https: redactProxy(env.HTTPS_PROXY ?? env.https_proxy),
        all: redactProxy(env.ALL_PROXY ?? env.all_proxy),
      },
      noProxy: env.NO_PROXY ?? env.no_proxy ?? null,
    },
  };
}

/**
 * Reads the official OpenCode Basic-auth credentials only from the exact
 * given raw environment (the inherited operator process environment by
 * default). This never reads the tracked-dotenv-merged runtime environment,
 * so tracked config can never supply these values.
 */
export function readOpencodeSecrets(rawEnv = process.env) {
  return {
    username: nonEmpty(rawEnv?.OPENCODE_SERVER_USERNAME),
    password: nonEmpty(rawEnv?.OPENCODE_SERVER_PASSWORD),
  };
}

export { DEFAULT_CLAUDE_CONFIG_DIR, DEFAULT_ENV_FILE, OPENCODE_SECRET_KEYS, SUPPORTED_KEYS };
