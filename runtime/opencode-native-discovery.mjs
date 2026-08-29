/** SPDX-License-Identifier: Apache-2.0 */
import { spawn as nodeSpawn } from "node:child_process";

import { isBoundedRouteAtom } from "./harness-contract.mjs";

export const OPENCODE_NATIVE_DIAGNOSTIC_TIMEOUT_MS = 5_000;
export const OPENCODE_NATIVE_DIAGNOSTIC_MAX_BYTES = 256 * 1024;
export const OPENCODE_NATIVE_DIAGNOSTIC_MAX_ROUTES = 32;
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

function closed(code) { return { ok: false, code }; }

function boundedText(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? null : text;
}

function jsonEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

/** Parse only `provider/model` + its following complete variants JSON object. */
export function parseOpencodeVerboseModels(stdout) {
  const text = boundedText(stdout, OPENCODE_NATIVE_DIAGNOSTIC_MAX_BYTES);
  if (text == null || !text.trim()) return closed("diagnostic_malformed");
  const routes = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
    if (cursor >= text.length) break;
    const lineEnd = text.indexOf("\n", cursor);
    const rawModel = text.slice(cursor, lineEnd < 0 ? text.length : lineEnd).trim();
    const slash = rawModel.indexOf("/");
    if (slash < 1 || rawModel.indexOf("/", slash + 1) !== -1 ||
        !isBoundedRouteAtom(rawModel.slice(0, slash)) || !isBoundedRouteAtom(rawModel.slice(slash + 1))) {
      return closed("diagnostic_malformed");
    }
    cursor = lineEnd < 0 ? text.length : lineEnd + 1;
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "{") return closed("diagnostic_malformed");
    const end = jsonEnd(text, cursor);
    if (end == null) return closed("diagnostic_truncated");
    let details;
    try { details = JSON.parse(text.slice(cursor, end)); } catch { return closed("diagnostic_malformed"); }
    const variants = details?.variants;
    if (!variants || typeof variants !== "object" || Array.isArray(variants)) return closed("diagnostic_malformed");
    const efforts = Object.keys(variants).filter(isBoundedRouteAtom).sort();
    if (efforts.length === 0 || efforts.length > 16 || efforts.length !== Object.keys(variants).length) return closed("diagnostic_malformed");
    routes.push({ model: rawModel, efforts });
    if (routes.length > OPENCODE_NATIVE_DIAGNOSTIC_MAX_ROUTES || new Set(routes.map((route) => route.model)).size !== routes.length) {
      return closed("diagnostic_malformed");
    }
    cursor = end;
  }
  return routes.length ? { ok: true, routes } : closed("diagnostic_malformed");
}

function providerKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseOpencodeCredentialProviders(stdout) {
  const text = boundedText(stdout, OPENCODE_NATIVE_DIAGNOSTIC_MAX_BYTES);
  if (text == null || !text.trim()) return closed("credential_malformed");
  const plain = text.replace(ANSI_SGR, "");
  if (plain.includes("\x1B")) return closed("credential_malformed");
  const row = /^\s*(?:[│|]\s*)?[●•*-]\s+([A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?)\s+(?:\((?:api|oauth)\)|api|oauth)\s*$/iu;
  const bullet = /^\s*(?:[│|]\s*)?[●•*-](?:\s|$)/u;
  const lines = plain.split(/\r?\n/u);
  const rows = lines.filter((line) => bullet.test(line));
  if (rows.some((line) => !row.test(line))) return closed("credential_malformed");
  const providers = rows.length
    ? rows.map((line) => providerKey(row.exec(line)?.[1]))
    : plain.includes("\n") || plain.includes("\r")
      ? []
      : plain.split(",").map((entry) => {
        const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?)\s*\((api|oauth)\)\s*$/iu.exec(entry);
        return match ? providerKey(match[1]) : "";
      });
  return providers.length && providers.length <= 128 && providers.every(Boolean) && new Set(providers).size === providers.length
    ? { ok: true, providers: new Set(providers) }
    : closed("credential_malformed");
}

export function runDiagnostic(executable, args, options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? OPENCODE_NATIVE_DIAGNOSTIC_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OPENCODE_NATIVE_DIAGNOSTIC_MAX_BYTES;
  return new Promise((resolve) => {
    let stdout = "";
    let stderrBytes = 0;
    let done = false;
    let timer = null;
    let forceTimer = null;
    let finalTimer = null;
    let stopOutcome = null;
    const finish = (value) => {
      if (!done) {
        done = true;
        for (const handle of [timer, forceTimer, finalTimer]) if (handle) clearTimeout(handle);
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch { return finish(closed("diagnostic_unavailable")); }
    if (!child?.once) return finish(closed("diagnostic_unavailable"));
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1_000;
    const stop = (outcome) => {
      if (stopOutcome || done) return;
      stopOutcome = outcome;
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finalTimer = setTimeout(() => finish(outcome), cleanupTimeoutMs);
        finalTimer.unref?.();
      }, cleanupTimeoutMs);
      forceTimer.unref?.();
      try { child.kill("SIGTERM"); } catch {}
    };
    timer = setTimeout(() => stop(closed("diagnostic_timeout")), timeoutMs);
    timer.unref?.();
    child.once("error", () => { if (!stopOutcome) finish(closed("diagnostic_unavailable")); });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBytes) stop(closed("diagnostic_truncated"));
    });
    child.stderr?.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > maxBytes) stop(closed("diagnostic_truncated")); });
    child.once("close", (status) => finish(stopOutcome ?? (status === 0 ? { ok: true, stdout } : closed("diagnostic_unavailable"))));
  });
}

/** Bounded, ordinary-config CLI discovery. Raw diagnostics never leave this module. */
export async function discoverDormantOpencodeRoutes(options = {}) {
  const executable = String(options.env?.OPENCODE_EXECUTABLE ?? "").trim();
  if (!executable.startsWith("/")) return closed("diagnostic_unavailable");
  const models = await runDiagnostic(executable, ["models", "--verbose"], options);
  if (!models.ok) return models;
  const parsed = parseOpencodeVerboseModels(models.stdout);
  if (!parsed.ok) return parsed;
  const credentials = await runDiagnostic(executable, ["auth", "list"], options);
  if (!credentials.ok) return credentials;
  const providers = parseOpencodeCredentialProviders(credentials.stdout);
  if (!providers.ok) return providers;
  return parsed.routes.every((route) => providers.providers.has(providerKey(route.model.split("/", 1)[0])))
    ? { ok: true, routes: parsed.routes }
    : closed("credential_unavailable");
}
