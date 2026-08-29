/**
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Claude Code CLI wrapper — replaces Codex app-server + broker pattern.
 * Spawns `claude -p` subprocess per invocation.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeClaudeCredentialState } from "./claude-credential-state.mjs";
import {
  assessObservedNativeSurface,
  canonicalizeInitToolName,
  resolveNativeTeamPolicy,
} from "./claude-native-team-policy.mjs";
import { normalizePathSlashes, resolvePluginRuntimeRoot } from "./paths.mjs";
import {
  getProcessIdentity,
  isProcessAlive,
  terminateProcessTree,
  validateProcessIdentity,
} from "./process-control.mjs";
import { normalizeClaudeTerminalProviderMetrics } from "./terminal-metrics.mjs";

const CLAUDE_PACKAGE_EXE_PARTS = [
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
];

/** @visibleForTesting */
export function resolveClaudeBin(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const existsSync = options.existsSync ?? fs.existsSync;
  const override = String(env.CODEX_HARNESSDOCK_CLAUDE_BIN ?? "").trim();

  if (override) {
    return override;
  }
  if (platform !== "win32") {
    return "claude";
  }

  const pathApi = path.win32;
  const searchRoots = [];
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  for (const entry of String(pathValue).split(pathApi.delimiter)) {
    const normalized = entry.trim().replace(/^"|"$/g, "");
    if (normalized) searchRoots.push(normalized);
  }
  if (env.npm_config_prefix) searchRoots.push(String(env.npm_config_prefix));
  if (env.APPDATA) searchRoots.push(pathApi.join(String(env.APPDATA), "npm"));
  searchRoots.push(pathApi.join(homedir, "AppData", "Roaming", "npm"));

  const seenRoots = new Set();
  for (const root of searchRoots) {
    const resolvedRoot = pathApi.resolve(root);
    const rootKey = resolvedRoot.toLowerCase();
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    const candidates = [
      pathApi.join(resolvedRoot, "claude.exe"),
      pathApi.join(resolvedRoot, ...CLAUDE_PACKAGE_EXE_PARTS),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Continue to the next candidate, then fall back to normal PATH lookup.
      }
    }
  }
  return "claude";
}

/** Resolve the exact executable selected by PATH for receipts and spawning. */
export function resolveClaudeExecutable(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const command = resolveClaudeBin({ ...options, env, platform });
  if (path.isAbsolute(command)) return command;
  const pathApi = platform === "win32" ? path.win32 : path;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = platform === "win32"
    ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const entry of String(pathValue).split(pathApi.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.resolve(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return command;
}

export const MAX_STREAM_PARSER_UNKNOWN_EVENTS = 50;
export const MAX_STREAM_PARSER_UNKNOWN_EVENT_LABEL_BYTES = 64;
export const MAX_STREAM_PARSER_UNKNOWN_EVENT_SUMMARY_BYTES = 4 * 1024;
export const MAX_STREAM_PARSER_PARSE_ERRORS = 50;
export const MAX_STREAM_PARSER_TOOL_USES = 256;
export const MAX_STREAM_PARSER_TOUCHED_FILES = 256;
export const MAX_STREAM_PARSER_TERMINAL_EVENTS = 16;
export const MAX_STREAM_PARSER_HOOK_RECEIPTS = 64;
export const MAX_STDERR_BYTES = 64 * 1024;
export const CLAUDE_NATIVE_ROUTE_PROBE_SCHEMA = "claude-native-route-probe-v1";
export const CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDOUT_BYTES = 64 * 1024;
export const CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDERR_BYTES = 16 * 1024;
export const CLAUDE_NATIVE_ROUTE_PROBE_MAX_ROWS = 64;
export const CLAUDE_NATIVE_ROUTE_PROBE_MAX_VALUE_BYTES = 256;
export const CLAUDE_NATIVE_ROUTE_PROBE_MAX_EFFORTS = 8;
export const CLAUDE_NATIVE_ROUTE_PROBE_TIMEOUT_MS = 10_000;
const CLAUDE_NATIVE_ROUTE_PROBE_MAX_LINE_BYTES = 16 * 1024;
const CLAUDE_NATIVE_ROUTE_PROBE_CLEANUP_WAIT_MS = 1_000;
const NATIVE_MODEL_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// The native-team witness is intentionally process-local, but it still ingests
// provider-supplied identities. Bound those identities before they can enter
// the member map or reach the optional callback.
const MAX_NATIVE_TEAM_WITNESS_MEMBERS = 16;
const MAX_NATIVE_TEAM_WITNESS_MEMBER_NAME_BYTES = 96;
const MAX_NATIVE_TEAM_PENDING_CORRELATIONS = 32;
export const SANDBOX_TEMP_DIR = normalizePathSlashes(path.resolve(os.tmpdir()));

const NATIVE_TEAM_DEFINITION_EXPECTATIONS = Object.freeze(Object.fromEntries(
  resolveNativeTeamPolicy({
    model: "claude-opus-5",
    delegationMode: "claude_orchestrator",
    write: false,
    jobId: "adapter-definition-validation",
  }).teammateDefinitions.map(({ name, model, disallowedTools }) => [name, Object.freeze({
    model,
    disallowedTools: [...disallowedTools],
  })]),
));
const NATIVE_TEAM_DEFINITION_NAMES = Object.freeze(
  Object.keys(NATIVE_TEAM_DEFINITION_EXPECTATIONS).sort((left, right) => left.localeCompare(right)),
);
const NATIVE_TEAM_DEFINITION_FIELDS = new Set([
  "description",
  "disallowedTools",
  "memory",
  "model",
  "prompt",
]);

function pushBoundedTail(list, value, maxEntries) {
  list.push(value);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

function pushUniqueBoundedTail(list, value, maxEntries) {
  if (!value || list.includes(value)) {
    return;
  }
  pushBoundedTail(list, value, maxEntries);
}

function sliceTextTailByBytes(text, maxBytes) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized || maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(mid), "utf8") > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let start = low;
  let retained = normalized.slice(start);
  while (start < normalized.length && Buffer.byteLength(retained, "utf8") > maxBytes) {
    start += 1;
    retained = normalized.slice(start);
  }
  return retained;
}

function appendTextTail(existing, chunk, maxBytes) {
  const next = `${existing ?? ""}${chunk ?? ""}`;
  return sliceTextTailByBytes(next, maxBytes);
}

const SAFE_PROTOCOL_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SAFE_NATIVE_TEAM_WITNESS_MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function safeNativeTeamWitnessMemberName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name
    && Buffer.byteLength(name, "utf8") <= MAX_NATIVE_TEAM_WITNESS_MEMBER_NAME_BYTES
    && SAFE_NATIVE_TEAM_WITNESS_MEMBER_NAME.test(name)
    ? name
    : null;
}

/**
 * Keep protocol drift labels useful for diagnosis without allowing an event
 * field to become a payload-bearing receipt. Only closed token characters are
 * retained; everything else is reduced to a fixed marker.
 */
function safeProtocolLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const label = value.trim();
  if (!label) return fallback;
  if (
    Buffer.byteLength(label, "utf8") > MAX_STREAM_PARSER_UNKNOWN_EVENT_LABEL_BYTES ||
    !SAFE_PROTOCOL_LABEL.test(label)
  ) {
    return "unsafe";
  }
  return label;
}

function unknownEventKey(entry) {
  return `${entry.type}\0${entry.subtype ?? ""}`;
}

function unknownEventSummaryBytes(entries) {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
}

function recordUnknownEvent(state, type, subtype) {
  const entry = {
    type: safeProtocolLabel(type, "missing"),
    subtype: safeProtocolLabel(subtype, null),
  };
  const key = unknownEventKey(entry);
  state.unknownEventCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    (state.unknownEventCount ?? 0) + 1,
  );
  const existing = state.unknownEvents.find((candidate) => unknownEventKey(candidate) === key);
  if (existing) {
    existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
    return;
  }

  if (state.unknownEvents.length >= MAX_STREAM_PARSER_UNKNOWN_EVENTS) {
    state.unknownEventOverflowCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (state.unknownEventOverflowCount ?? 0) + 1,
    );
    return;
  }
  state.unknownEvents.push({ ...entry, count: 1 });
  while (
    state.unknownEvents.length > 1 &&
    unknownEventSummaryBytes(state.unknownEvents) > MAX_STREAM_PARSER_UNKNOWN_EVENT_SUMMARY_BYTES
  ) {
    state.unknownEvents.shift();
    state.unknownEventOverflowCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (state.unknownEventOverflowCount ?? 0) + 1,
    );
  }
}

/** Return only the bounded protocol-drift fields admitted to a Driver receipt. */
export function sanitizeUnknownEventSummary(
  events,
  totalCount = 0,
  overflowCount = 0,
) {
  const sanitized = [];
  const byKey = new Map();
  for (const candidate of Array.isArray(events) ? events : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = {
      type: safeProtocolLabel(candidate.type, "missing"),
      subtype: safeProtocolLabel(candidate.subtype, null),
    };
    const key = unknownEventKey(entry);
    const count = Number.isSafeInteger(candidate.count) && candidate.count > 0
      ? candidate.count
      : 1;
    const existing = byKey.get(key);
    if (existing) {
      existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + count);
      continue;
    }
    if (sanitized.length >= MAX_STREAM_PARSER_UNKNOWN_EVENTS) continue;
    const normalized = { ...entry, count };
    sanitized.push(normalized);
    byKey.set(key, normalized);
    while (
      sanitized.length > 1 &&
      unknownEventSummaryBytes(sanitized) > MAX_STREAM_PARSER_UNKNOWN_EVENT_SUMMARY_BYTES
    ) {
      const removed = sanitized.shift();
      byKey.delete(unknownEventKey(removed));
    }
  }
  const observedCount = sanitized.reduce((sum, entry) => sum + entry.count, 0);
  return {
    unknownEvents: sanitized,
    unknownEventCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(observedCount, Number.isSafeInteger(totalCount) && totalCount > 0 ? totalCount : 0),
    ),
    unknownEventOverflowCount: Math.min(
      Number.MAX_SAFE_INTEGER,
      Number.isSafeInteger(overflowCount) && overflowCount > 0 ? overflowCount : 0,
    ),
  };
}

// ---------------------------------------------------------------------------
// Availability & Auth
// ---------------------------------------------------------------------------

export function getClaudeAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const claudeBin = options.claudeBin ?? resolveClaudeExecutable({ env });
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    return {
      available: false,
      detail: `Claude working directory is unavailable: ${cwd}`,
      executable: claudeBin,
    };
  }
  try {
    const result = spawnSyncImpl(claudeBin, ["--version"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("non-zero exit");
    return {
      available: true,
      detail: (result.stdout ?? "").trim(),
      executable: claudeBin,
    };
  } catch {
    return {
      available: false,
      detail: "claude CLI not found in PATH",
      executable: claudeBin,
    };
  }
}

export function getClaudeAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const claudeBin = options.claudeBin ?? resolveClaudeExecutable({ env });
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const credential = observeClaudeCredentialState({ env, nowMs: options.nowMs });
  if (env.ANTHROPIC_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      liveValidated: false,
      detail: "API key present (provider not live-validated)",
      credential,
    };
  }
  try {
    const result = spawnSyncImpl(claudeBin, ["auth", "status"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("not authenticated");
    return {
      available: true,
      loggedIn: true,
      liveValidated: false,
      detail: "credential present (provider not live-validated)",
      credential,
    };
  } catch {
    return {
      available: true,
      loggedIn: false,
      liveValidated: false,
      detail: "not authenticated — run `claude auth login`",
      credential,
    };
  }
}

// ---------------------------------------------------------------------------
// Stream Parser — fail-safe with chunk-boundary buffering
// ---------------------------------------------------------------------------

export class StreamParser {
  constructor(options = {}) {
    this.buffer = "";
    this.currentAssistantMessage = null;
    this.lastCompleteAssistantMessage = null;
    this.unboundedAssistantText = "";
    this.state = {
      sessionId: null,
      finalMessage: "",
      assistantOutputObserved: false,
      structuredOutput: null,
      receivedTerminalEvent: false,
      unknownEvents: [],
      unknownEventCount: 0,
      unknownEventOverflowCount: 0,
      parseErrors: [],
      unresolvedParseErrors: 0,
      toolUses: [],
      touchedFiles: [],
      terminalEvents: [],
      runtimeReceipt: null,
      hookReceipts: [],
      lastByteAt: null,
      providerReportedMetrics: null,
      nativeTeamSurface: null,
      compatibilitySurfaceDrift: false,
      delegationMode: options.delegationMode ?? "leaf",
      nativeTeamWarning: null,
      nativeTeamTransportPending: false,
      nativeTeamFirstAgentObserved: false,
    };
    this.delegationMode = options.delegationMode ?? "leaf";
    this.onNativeTeamWitness = typeof options.onNativeTeamWitness === "function"
      ? options.onNativeTeamWitness
      : null;
    // Witness-only, process-local member names. They are never copied to the
    // parser state, runtime receipt, job, or public MCP result.
    this.nativeTeamMembers = new Map();
    this.pendingNativeTeamAgentResults = new Map();
    this.launchedNativeTeamMembers = new Set();
    this.pendingNativeTeamMessageResults = new Map();
    this.nativeTeamWitnessOverflow = false;
  }

  _nativeTeamWitness(fact) {
    if (!this.onNativeTeamWitness) return;
    try {
      this.onNativeTeamWitness(fact);
    } catch {
      // A test-only in-process observer cannot change native turn semantics.
    }
  }

  _recordNativeTeamWitnessOverflow() {
    if (this.nativeTeamWitnessOverflow) return;
    this.nativeTeamWitnessOverflow = true;
    this._nativeTeamWitness({ type: "native_team_witness_overflow" });
  }

  _recordPendingNativeTeamCorrelation(map, toolUseId, value) {
    if (!map.has(toolUseId) && map.size >= MAX_NATIVE_TEAM_PENDING_CORRELATIONS) {
      this._recordNativeTeamWitnessOverflow();
      this.state.compatibilitySurfaceDrift = true;
      return false;
    }
    map.set(toolUseId, value);
    return true;
  }

  _recordNativeTeamSurface(event) {
    const inventory = (value) => {
      if (value == null) return value;
      if (Array.isArray(value)) {
        return value.map((entry) => typeof entry === "string" ? entry : entry?.name);
      }
      if (value && typeof value === "object") return Object.keys(value);
      return value;
    };
    const toolNames = inventory(event.tools ?? event.tool_names);
    const definitionNames = inventory(
      event.agents ?? event.agent_definitions ?? event.agentDefinitions,
    );
    let surface;
    try {
      surface = assessObservedNativeSurface({
        delegationMode: this.delegationMode,
        ...(toolNames === undefined ? {} : { toolNames }),
        ...(definitionNames === undefined ? {} : { definitionNames }),
      });
    } catch {
      this.state.compatibilitySurfaceDrift = true;
      return;
    }
    this.state.nativeTeamSurface = surface;
    this.state.runtimeReceipt.nativeTeamSurface = surface;
    if (surface.unknownNativeTools.length > 0) {
      this.state.nativeTeamWarning = "Claude init exposed unreviewed native tool names.";
    }
    this._nativeTeamWitness({ type: "native_team_surface", ...surface });
    if (
      surface.forbiddenTools.length > 0 ||
      surface.missingDefinitions.length > 0 ||
      surface.missingNecessaryCoordinationTools.length > 0
    ) {
      this.state.compatibilitySurfaceDrift = true;
    }
  }

  _recordNativeTeamToolResult(event) {
    if (this.delegationMode !== "claude_orchestrator" || this.state.nativeTeamSurface == null) return;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const toolUseIds = content
      .filter((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string")
      .map((part) => part.tool_use_id);
    if (toolUseIds.length === 0) return;
    const result = event.tool_use_result && typeof event.tool_use_result === "object"
      ? event.tool_use_result
      : null;
    if (!result) return;
    if (toolUseIds.length !== 1) {
      this.state.compatibilitySurfaceDrift = true;
      return;
    }

    for (const toolUseId of toolUseIds) {
      const memberName = this.pendingNativeTeamAgentResults.get(toolUseId);
      if (memberName) {
        this.pendingNativeTeamAgentResults.delete(toolUseId);
        if (
          result.status === "async_launched" &&
          typeof result.agentId === "string" &&
          result.agentId.trim()
        ) {
          this.launchedNativeTeamMembers.add(memberName);
          this._nativeTeamWitness({
            type: "native_team_member_launched",
            memberName,
            memberType: this.nativeTeamMembers.get(memberName),
          });
        } else {
          this.state.compatibilitySurfaceDrift = true;
          this._nativeTeamWitness({
            type: "native_team_transport",
            delegationMode: this.state.nativeTeamSurface.delegationMode,
            teamTransportLiveValidated: false,
          });
        }
      }

      const recipient = this.pendingNativeTeamMessageResults.get(toolUseId);
      if (!recipient) continue;
      this.pendingNativeTeamMessageResults.delete(toolUseId);
      const pinName = result.pin && typeof result.pin === "object" ? result.pin.name : null;
      const sameTeamRecipient = result.success === true && (pinName == null || pinName === recipient);
      if (!sameTeamRecipient) {
        this.state.compatibilitySurfaceDrift = true;
        continue;
      }
      const surface = Object.freeze({
        ...this.state.nativeTeamSurface,
        teamTransportLiveValidated: true,
      });
      this.state.nativeTeamSurface = surface;
      this.state.runtimeReceipt.nativeTeamSurface = surface;
      this.state.nativeTeamTransportPending = false;
      this._nativeTeamWitness({
        type: "native_team_transport",
        delegationMode: surface.delegationMode,
        teamTransportLiveValidated: true,
      });
      this._nativeTeamWitness({ type: "native_team_message", sameTeamRecipient: true });
    }
  }

  _recordNamedAgentToolUse(toolUse) {
    if (
      this.delegationMode !== "claude_orchestrator" ||
      canonicalizeInitToolName(toolUse?.name) !== "Agent"
    ) return;
    const input = toolUse.input;
    const memberName = safeNativeTeamWitnessMemberName(input?.name);
    const memberType = typeof input?.subagent_type === "string" ? input.subagent_type.trim() : "";
    if (!memberName || !Object.hasOwn(NATIVE_TEAM_DEFINITION_EXPECTATIONS, memberType)) {
      if (!memberName) this._recordNativeTeamWitnessOverflow();
      if (this.state.nativeTeamFirstAgentObserved !== true) {
        this.state.compatibilitySurfaceDrift = true;
      }
      return;
    }
    if (!this.nativeTeamMembers.has(memberName)) {
      if (this.nativeTeamMembers.size >= MAX_NATIVE_TEAM_WITNESS_MEMBERS) {
        this._recordNativeTeamWitnessOverflow();
        this.state.compatibilitySurfaceDrift = true;
        return;
      }
      this.nativeTeamMembers.set(memberName, memberType);
      this._nativeTeamWitness({ type: "native_team_member_requested", memberName, memberType });
    }
    if (typeof toolUse.id !== "string" || !toolUse.id) {
      this.state.compatibilitySurfaceDrift = true;
      return;
    }
    if (!this._recordPendingNativeTeamCorrelation(
      this.pendingNativeTeamAgentResults,
      toolUse.id,
      memberName,
    )) return;
    if (this.state.nativeTeamFirstAgentObserved !== true) {
      this.state.nativeTeamFirstAgentObserved = true;
      this.state.nativeTeamTransportPending = true;
    }
  }

  _recordNativeTeamMessage(toolUse) {
    if (
      this.delegationMode !== "claude_orchestrator" ||
      String(toolUse?.name ?? "").trim() !== "SendMessage" ||
      this.state.nativeTeamSurface == null
    ) return;
    const input = toolUse?.input;
    const recipient = typeof input?.recipient === "string"
      ? input.recipient.trim()
      : typeof input?.to === "string" ? input.to.trim() : "";
    if (
      !recipient ||
      !this.launchedNativeTeamMembers.has(recipient) ||
      typeof toolUse.id !== "string" ||
      !toolUse.id
    ) return;
    this._recordPendingNativeTeamCorrelation(
      this.pendingNativeTeamMessageResults,
      toolUse.id,
      recipient,
    );
  }

  /** Feed a raw stdout chunk. Returns parsed events. */
  feed(chunk) {
    if (chunk) this.state.lastByteAt = new Date().toISOString();
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete trailing line
    return lines.map((l) => this._parseLine(l)).filter(Boolean);
  }

  /** Flush remaining buffer at stream end. */
  flush() {
    if (this.buffer.trim()) {
      const result = this._parseLine(this.buffer);
      this.buffer = "";
      return result ? [result] : [];
    }
    return [];
  }

  _parseLine(line) {
    if (!line.trim()) return null;
    try {
      const event = JSON.parse(line);
      // Extract session_id from any event
      if (event.session_id && !this.state.sessionId) {
        this.state.sessionId = event.session_id;
      }
      switch (event.type) {
        case "stream_event":
          return this._handleStreamEvent(event);
        case "system":
          return this._handleSystemEvent(event);
        case "result":
          this.state.receivedTerminalEvent = true;
          pushBoundedTail(
            this.state.terminalEvents,
            event,
            MAX_STREAM_PARSER_TERMINAL_EVENTS
          );
          if (this.lastCompleteAssistantMessage !== null) {
            this.state.finalMessage = this.lastCompleteAssistantMessage;
          } else if (event.result || this.currentAssistantMessage || this.unboundedAssistantText) {
            const streamedFallback = this.currentAssistantMessage ?? this.unboundedAssistantText;
            this.state.finalMessage = mergeTerminalResultText(streamedFallback, event.result);
          }
          if (Object.prototype.hasOwnProperty.call(event, "structured_output")) {
            this.state.structuredOutput = event.structured_output ?? null;
          }
          if (event.session_id) this.state.sessionId = event.session_id;
          this.state.providerReportedMetrics = normalizeClaudeTerminalProviderMetrics(event);
          if (this.delegationMode === "claude_orchestrator" && event.subtype === "success" && event.is_error !== true) {
            this._nativeTeamWitness({ type: "native_team_parent_synthesis" });
          }
          return { kind: "result", data: event };
        case "user": {
          this._recordNativeTeamToolResult(event);
          const text = Array.isArray(event.message?.content)
            ? event.message.content
                .filter((part) => part?.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("\n")
            : "";
          if (!text) return null;
          return {
            kind: "user_replay",
            text,
            message: "Steering message acknowledged",
            phase: "running",
            threadId: this.state.sessionId,
          };
        }
        case "assistant": {
          const content = Array.isArray(event.message?.content) ? event.message.content : [];
          for (const part of content) {
            if (part?.type === "tool_use") {
              this._recordNamedAgentToolUse(part);
              this._recordNativeTeamMessage(part);
            }
          }
          return null;
        }
        case "tool_result":
          this._recordNativeTeamToolResult({
            tool_use_result: event.tool_use_result ?? event,
            message: {
              content: [{ type: "tool_result", tool_use_id: event.tool_use_id }],
            },
          });
          return null;
        default:
          recordUnknownEvent(this.state, event.type, event.subtype);
          return null;
      }
    } catch (err) {
      this.state.unresolvedParseErrors++;
      pushBoundedTail(this.state.parseErrors, {
        line: line.slice(0, 200),
        error: err.message,
      }, MAX_STREAM_PARSER_PARSE_ERRORS);
      return null;
    }
  }

  _handleStreamEvent(event) {
    const inner = event.event;
    if (inner?.type === "message_start" && inner.message?.role === "assistant") {
      this.currentAssistantMessage = "";
      return null;
    }
    if (inner?.type === "message_stop" && this.currentAssistantMessage !== null) {
      this.lastCompleteAssistantMessage = this.currentAssistantMessage;
      this.state.finalMessage = this.currentAssistantMessage;
      this.currentAssistantMessage = null;
      this.unboundedAssistantText = "";
      return null;
    }
    const delta = inner?.delta;
    if (delta?.type === "text_delta" && delta.text) {
      this.state.assistantOutputObserved = true;
      if (this.currentAssistantMessage !== null) {
        this.currentAssistantMessage += delta.text;
        this.state.finalMessage = this.currentAssistantMessage;
      } else {
        this.unboundedAssistantText += delta.text;
        this.state.finalMessage = this.unboundedAssistantText;
      }
      return {
        kind: "text",
        text: delta.text,
        message: delta.text,
        phase: "running",
        threadId: this.state.sessionId,
      };
    }

    if (inner?.type === "content_block_delta") {
      const blockDelta = inner.delta;
      if (blockDelta?.type === "text_delta" && blockDelta.text) {
        this.state.assistantOutputObserved = true;
        if (this.currentAssistantMessage !== null) {
          this.currentAssistantMessage += blockDelta.text;
          this.state.finalMessage = this.currentAssistantMessage;
        } else {
          this.unboundedAssistantText += blockDelta.text;
          this.state.finalMessage = this.unboundedAssistantText;
        }
        return {
          kind: "text",
          text: blockDelta.text,
          message: blockDelta.text,
          phase: "running",
          threadId: this.state.sessionId,
        };
      }
      if (blockDelta?.type === "thinking_delta" && blockDelta.thinking) {
        return {
          kind: "thinking",
          message: blockDelta.thinking,
          phase: "thinking",
          threadId: this.state.sessionId,
        };
      }
    }

    // Tool use events
    if (inner?.type === "content_block_start") {
      const cb = inner.content_block;
      if (cb?.type === "tool_use") {
        const tool = sliceTextTailByBytes(String(cb.name ?? "unknown"), 256);
        const inputKeys = cb.input && typeof cb.input === "object" && !Array.isArray(cb.input)
          ? Object.keys(cb.input)
              .sort()
              .slice(0, 32)
              .map((key) => sliceTextTailByBytes(key, 256))
          : [];
        pushBoundedTail(
          this.state.toolUses,
          { tool, inputKeys },
          MAX_STREAM_PARSER_TOOL_USES
        );
        // This streaming block starts before Claude has finished encoding the
        // tool input. It is progress/receipt evidence only; native-team
        // admission waits for the complete top-level assistant tool_use.
        if (cb.name === "Write" || cb.name === "Edit") {
          const touchedPath = cb.input?.file_path ?? cb.input?.path ?? null;
          pushUniqueBoundedTail(
            this.state.touchedFiles,
            touchedPath == null ? null : sliceTextTailByBytes(String(touchedPath), 2_048),
            MAX_STREAM_PARSER_TOUCHED_FILES
          );
        }
        return {
          kind: "tool_use",
          tool,
          inputKeys,
          message: `Using tool: ${tool}`,
          phase: "tool",
          threadId: this.state.sessionId,
        };
      }
    }
    return null;
  }

  _handleSystemEvent(event) {
    if (event.subtype === "init") {
      this.state.runtimeReceipt = {
        claudeCodeVersion: event.claude_code_version ?? null,
        model: event.model ?? null,
        permissionMode: event.permissionMode ?? event.permission_mode ?? null,
        mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
        plugins: Array.isArray(event.plugins) ? event.plugins : [],
      };
      this._recordNativeTeamSurface(event);
      return {
        kind: "system",
        subtype: "init",
        data: event,
        message: "Claude Code session initialized",
        phase: "running",
        threadId: this.state.sessionId,
      };
    }
    if (event.subtype === "hook_response") {
      pushBoundedTail(
        this.state.hookReceipts,
        {
          hookName: event.hook_name ?? null,
          hookEvent: event.hook_event ?? null,
          outcome: event.outcome ?? null,
          exitCode: event.exit_code ?? null,
        },
        MAX_STREAM_PARSER_HOOK_RECEIPTS
      );
      return {
        kind: "system",
        subtype: "hook_response",
        data: event,
        message: `Hook completed: ${event.hook_name ?? event.hook_event ?? "unknown"}`,
        phase: "hook",
        threadId: this.state.sessionId,
      };
    }
    if (event.subtype === "api_retry") {
      return {
        kind: "system",
        subtype: "api_retry",
        data: event,
        message: "API retry in progress",
        phase: "retry",
        threadId: this.state.sessionId,
      };
    }
    recordUnknownEvent(this.state, event.type, event.subtype);
    return null;
  }
}

function mergeTerminalResultText(existingText, terminalText) {
  const existing = typeof existingText === "string" ? existingText : "";
  const terminal = typeof terminalText === "string" ? terminalText : "";

  if (!terminal) {
    // Structured-output and tool-only turns can finish with an empty text result.
    return existing;
  }
  if (!existing) {
    return terminal;
  }

  // We observed one real failure mode where the terminal payload only contained
  // a truncated tail of the streamed answer. Preserve the longer streamed copy
  // only for that strict suffix case; otherwise the terminal result is the
  // authoritative final answer according to the streaming contract.
  if (existing.endsWith(terminal) && existing.length > terminal.length) {
    return existing;
  }

  return terminal;
}

// ---------------------------------------------------------------------------
// Turn Completion Validation
// ---------------------------------------------------------------------------

export function validateTurnCompletion(state, exitCode) {
  if (state.compatibilitySurfaceDrift === true) {
    return { status: "failed", warning: "Claude native team surface is incompatible." };
  }
  if (state.delegationMode === "claude_orchestrator" && state.nativeTeamSurface == null) {
    return { status: "failed", warning: "Claude native team initialization inventory is missing." };
  }
  if (state.delegationMode === "claude_orchestrator" && state.nativeTeamTransportPending === true) {
    return { status: "failed", warning: "Claude native team transport result is missing." };
  }
  if (
    state.delegationMode === "claude_orchestrator" &&
    state.nativeTeamSurface?.teamTransportLiveValidated !== true
  ) {
    return { status: "failed", warning: "Claude native team transport was not validated." };
  }
  if (exitCode !== 0) {
    return { status: "failed", exitCode };
  }
  if (state.unresolvedParseErrors > 0) {
    return {
      status: "unknown",
      warning: `${state.unresolvedParseErrors} unrecovered parse errors`,
    };
  }
  if (!state.receivedTerminalEvent) {
    return {
      status: "unknown",
      warning: "No terminal result event received despite exit code 0",
    };
  }
  const lastTerminal = Array.isArray(state.terminalEvents)
    ? state.terminalEvents.at(-1)
    : null;
  if (
    lastTerminal &&
    (lastTerminal.is_error === true ||
      (lastTerminal.subtype && lastTerminal.subtype !== "success"))
  ) {
    return {
      status: "failed",
      warning: `Claude terminal result reported ${lastTerminal.subtype ?? "an error"}`,
    };
  }
  if (state.unknownEvents.length > 0) {
    // Log but don't fail — protocol drift detection
  }
  return { status: "completed" };
}

export function classifyClaudeFailure(result = {}) {
  if (result.compatibilitySurfaceDrift === true || result.nativeTeamTransportUnvalidated === true) {
    return { kind: "compatibility_surface_drift", resumable: false, reason: "native_team_surface" };
  }
  if (result.status === "completed") {
    return { kind: null, resumable: false, reason: null };
  }

  const terminalEvents = Array.isArray(result.terminalEvents)
    ? result.terminalEvents
    : [];
  const terminalFailureText = terminalEvents.flatMap((event) => {
    const values = [];
    if (typeof event?.error === "string") values.push(event.error);
    if (Array.isArray(event?.errors)) {
      for (const error of event.errors) {
        if (typeof error === "string") values.push(error);
        else if (typeof error?.message === "string") values.push(error.message);
      }
    }
    if (event?.is_error === true && typeof event?.result === "string") {
      values.push(event.result);
    }
    return values;
  });
  const nativeFailureText = [
    result.stderr,
    result.warning,
    ...terminalFailureText,
  ]
    .filter(Boolean)
    .join("\n");
  if (/\b(authentication|not authenticated|unauthorized|forbidden|invalid api key|oauth|permission denied)\b/i.test(nativeFailureText)) {
    return { kind: "auth_or_permission", resumable: false, reason: nativeFailureText };
  }
  if (/\b(context window|maximum context|prompt is too long|request (?:is )?invalid|invalid request|malformed request|unprocessable)\b/i.test(nativeFailureText)) {
    return { kind: "context_or_request_invalid", resumable: false, reason: nativeFailureText };
  }

  const callerBudgetLimit = /\b(?:maximum|max)\s+budget\b|error_max_budget_usd|--max-budget-usd/i.test(nativeFailureText);
  const accountCapacityScope = "(?:subscription|quota|credits?|weekly|monthly|allowance|billing[- ]period)";
  const exhaustionSignal = "(?:hit|reached|exceeded|exhausted|depleted|used[ -]up|no remaining|insufficient)";
  const requestRateContext = /\b(?:rate|request)\s+limit\b|\blimit\b[^\n]{0,30}\b(?:for|on)\s+(?:api\s+)?requests?\b/i.test(nativeFailureText);
  const genericUserLimit = !requestRateContext &&
    /\byou(?:'ve| have)?\s+(?:hit|reached|exceeded)\s+(?:your\s+)?(?:limit|quota)\b/i.test(nativeFailureText);
  const explicitAccountLimit = !callerBudgetLimit && (
    new RegExp(`\\b${accountCapacityScope}\\b[^\\n]{0,100}\\b${exhaustionSignal}\\b`, "i").test(nativeFailureText) ||
    new RegExp(`\\b${exhaustionSignal}\\b[^\\n]{0,100}\\b${accountCapacityScope}\\b`, "i").test(nativeFailureText) ||
    /\busage\s+(?:limit|quota|allowance)\b[^\n]{0,60}\b(?:reached|exceeded|exhausted|depleted|used[ -]up)\b/i.test(nativeFailureText) ||
    /\b(?:reached|exceeded|exhausted|depleted|used[ -]up)\b[^\n]{0,60}\busage\s+(?:limit|quota|allowance)\b/i.test(nativeFailureText) ||
    /\b(?:insufficient|no|zero)\s+(?:remaining\s+)?credits?\b/i.test(nativeFailureText) ||
    /\byou(?:'ve| have)?\s+(?:hit|reached|exceeded)\s+(?:your\s+)?session\s+limit\b/i.test(nativeFailureText) ||
    genericUserLimit
  );
  if (explicitAccountLimit) {
    return {
      kind: "usage_or_subscription_limit",
      resumable: false,
      reason: nativeFailureText,
    };
  }

  const transportFailure = /connection closed mid-response|socket (?:closed|reset|hang up)|\bECONNRESET\b|\bEPIPE\b|stream(?:ing)? (?:idle )?timeout|timed out while streaming|\bHTTP\s*(?:408|429|5\d\d)\b/i.test(nativeFailureText);
  if (transportFailure && result.sessionId) {
    return {
      kind: "transport_closed_resumable",
      resumable: true,
      reason: nativeFailureText,
    };
  }

  const lastTerminal = terminalEvents.at(-1);
  if (
    (lastTerminal?.subtype === "error_during_execution" &&
      (result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143)) ||
    result.signal === "SIGINT" ||
    result.signal === "SIGTERM" ||
    result.exitCode === 130 ||
    result.exitCode === 143
  ) {
    return {
      kind: "cancelled_or_interrupted",
      resumable: false,
      reason: lastTerminal?.subtype ?? result.signal ?? `exit ${result.exitCode}`,
    };
  }

  if (transportFailure) {
    return { kind: "protocol_unknown", resumable: false, reason: nativeFailureText };
  }
  if (result.status === "unknown") {
    return { kind: "protocol_unknown", resumable: false, reason: nativeFailureText || null };
  }
  return { kind: "fatal", resumable: false, reason: nativeFailureText || null };
}

export function encodeStreamUserMessage(text) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: String(text ?? "") }],
    },
  })}\n`;
}

function redactProxyEndpoint(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return raw.replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
  }
}

function buildHostRuntimeReceipt(options, env, claudeBin) {
  return {
    claudeBin,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,
    requestedModel: options.model ?? null,
    requestedEffort: options.effort ?? null,
    permissionMode: options.permissionMode ?? null,
    dangerouslySkipPermissions: Boolean(options.dangerouslySkipPermissions),
    isSandbox: env.IS_SANDBOX === "1",
    allowedTools: Array.isArray(options.allowedTools) ? options.allowedTools : null,
    disallowedTools: Array.isArray(options.disallowedTools) ? options.disallowedTools : null,
    appendedSystemPrompt: Boolean(options.appendSystemPrompt),
    proxyEndpoints: {
      http: redactProxyEndpoint(env.HTTP_PROXY ?? env.http_proxy),
      https: redactProxyEndpoint(env.HTTPS_PROXY ?? env.https_proxy),
      all: redactProxyEndpoint(env.ALL_PROXY ?? env.all_proxy),
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox Tool Sets — approximate Codex sandbox modes via allowedTools.
// Codex enforces sandbox at OS level (seatbelt/landlock); Claude Code lacks
// OS-level sandboxing, so we restrict the tool whitelist instead.
// ---------------------------------------------------------------------------

export const SANDBOX_READ_ONLY_BASH_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(git branch:*)",
  "Bash(git ls-files:*)",
  "Bash(git merge-base:*)",
  "Bash(git describe:*)",
  "Bash(git shortlog:*)",
  "Bash(git cat-file:*)",
  "Bash(git tag --list:*)",
  "Bash(git stash list:*)",
  "Bash(git config --get:*)",
];

/** read-only: file reading + read-only git + web + read-only agents. No writes, MCP, or skills. */
export const SANDBOX_READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  ...SANDBOX_READ_ONLY_BASH_TOOLS,
  "WebSearch",
  "WebFetch",
  "Agent(explore,plan)",
];

// ---------------------------------------------------------------------------
// Sandbox Settings — OS-level isolation via Claude Code's sandbox feature.
// Written to a temp file and passed via --settings.
// ---------------------------------------------------------------------------

/**
 * Sandbox presets matching Codex sandbox modes.
 *
 * read-only:       no file writes outside the OS temp dir. Network is allowed so
 *                  that `WebFetch`, `WebSearch`, and the Claude CLI's API path keep
 *                  working; the review allowlist excludes Bash entirely, so there
 *                  is no shell surface to exfiltrate or mutate state through.
 * workspace-write: Bash can write to cwd + OS temp dir only, no network from Bash.
 *                  All tools allowed (no allowedTools restriction).
 */
export const SANDBOX_SETTINGS = {
  "read-only": {
    sandbox: {
      enabled: true,
      // No Bash in the review allowlist, but keep this flag conservative so that
      // any sandbox-aware tool still has to opt in explicitly.
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowWrite: [SANDBOX_TEMP_DIR],
      },
    },
  },
  "workspace-write": {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        allowWrite: [".", SANDBOX_TEMP_DIR],
      },
      network: {
        allowedDomains: [],
      },
    },
  },
};

/**
 * Write sandbox settings to a temp file. Returns the file path.
 * Caller is responsible for cleanup via cleanupSandboxSettings().
 */
export function createSandboxSettings(mode) {
  const settings = SANDBOX_SETTINGS[mode];
  if (!settings) return null;

  const sandboxDir = path.join(resolvePluginRuntimeRoot(), "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  const tmpFile = path.join(
    sandboxDir,
    `hd-sandbox-${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(settings), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpFile;
}

export function cleanupSandboxSettings(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Stale tmp sweepers — reclaim files left behind by SIGKILL/crashes.
// ---------------------------------------------------------------------------

function pruneStaleTempFiles(subdir, options = {}) {
  const prefixes = options.prefixes ?? (options.prefix ? [options.prefix] : null);
  const maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const dir = path.join(resolvePluginRuntimeRoot(), subdir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (prefixes && !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < maxAgeMs) continue;
    try {
      fs.unlinkSync(full);
    } catch {
      // Best effort: leave on disk rather than crash callers.
    }
  }
}

/**
 * Sweep sandbox-settings JSON files left behind by crashes. Call this at the
 * start of any flow that creates sandbox settings so they do not accumulate.
 */
export function pruneStaleSandboxSettings(options = {}) {
  // Both prefixes are swept because a crash before the rename can have left
  // files under the retired one. This is orphan cleanup, not a compatibility
  // reader: nothing parses either prefix, and no new file is ever written
  // under the retired name.
  pruneStaleTempFiles("sandbox", { prefixes: ["hd-sandbox-", "cc-sandbox-"], ...options });
}

// ---------------------------------------------------------------------------
// Model & Effort Mapping
// ---------------------------------------------------------------------------

export const MODEL_ALIASES = new Map([
  ["haiku", "claude-haiku-4-5"],
  ["claude-haiku-4-5", "claude-haiku-4-5"],
  ["sonnet", "claude-sonnet-5"],
  ["claude-sonnet-5", "claude-sonnet-5"],
  ["opus", "claude-opus-5"],
  ["claude-opus-5", "claude-opus-5"],
  ["fable", "claude-fable-5"],
  ["claude-fable-5", "claude-fable-5"],
]);

export const EFFORT_ALIASES = {
  none: "low",
  minimal: "low",
};

export const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_EFFORT_BY_MODEL = new Map([
  ["haiku", "low"],
  ["claude-haiku-4-5", "low"],
  ["sonnet", "high"],
  ["claude-sonnet-5", "high"],
  ["opus", "xhigh"],
  ["claude-opus-5", "xhigh"],
  ["fable", "max"],
  ["claude-fable-5", "max"],
]);

export function resolveDefaultEffort(model, effort) {
  if (effort != null && String(effort).trim() !== "") {
    return effort;
  }
  const key = String(model ?? "").trim().toLowerCase();
  return DEFAULT_EFFORT_BY_MODEL.get(key);
}

export function resolveModel(model) {
  if (!model) return undefined;
  const normalized = String(model).trim().toLowerCase();
  const resolved = MODEL_ALIASES.get(normalized);
  if (resolved) return resolved;
  throw new Error(
    `Unsupported Claude model "${model}". Use haiku/claude-haiku-4-5, sonnet/claude-sonnet-5, opus/claude-opus-5, or fable/claude-fable-5.`
  );
}

export function resolveEffort(effort) {
  if (!effort) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  const resolved = EFFORT_ALIASES[normalized] ?? normalized;
  if (VALID_EFFORTS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `Unsupported effort "${effort}". Use one of: ${[...VALID_EFFORTS].join(", ")}.`
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

/**
 * Serialize the one reviewed native-team definition source. Definitions are
 * deliberately closed here: the CLI receives no caller-composed teammates.
 */
export function serializeClaudeAgents(agents) {
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error("Claude native team definitions must be an object.");
  }
  const names = Object.keys(agents).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify(NATIVE_TEAM_DEFINITION_NAMES)) {
    throw new Error("Claude native team definitions must contain exactly haiku-scout, opus, and sonnet.");
  }
  for (const name of names) {
    const definition = agents[name];
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`Claude native team definition ${name} must be an object.`);
    }
    for (const field of Object.keys(definition)) {
      if (!NATIVE_TEAM_DEFINITION_FIELDS.has(field)) {
        throw new Error(`Claude native team definition ${name} has unsupported field ${field}.`);
      }
    }
    const expected = NATIVE_TEAM_DEFINITION_EXPECTATIONS[name];
    if (definition.model !== expected.model) {
      throw new Error(`Claude native team definition ${name} has an unsupported model.`);
    }
    if (definition.memory !== "local") {
      throw new Error(`Claude native team definition ${name} must use local memory.`);
    }
    if (!Array.isArray(definition.disallowedTools) ||
      definition.disallowedTools.length !== expected.disallowedTools.length ||
      definition.disallowedTools.some((tool, index) => tool !== expected.disallowedTools[index])) {
      throw new Error(`Claude native team definition ${name} must retain the complete policy-owned tool denial boundary.`);
    }
    if (typeof definition.description !== "string" || !definition.description.trim() || definition.description.includes("\0")) {
      throw new Error(`Claude native team definition ${name} must have a non-empty description without NUL bytes.`);
    }
    if (typeof definition.prompt !== "string" || !definition.prompt.trim() || definition.prompt.includes("\0")) {
      throw new Error(`Claude native team definition ${name} must have a non-empty prompt without NUL bytes.`);
    }
  }
  return JSON.stringify(canonicalJson(agents));
}

// ---------------------------------------------------------------------------
// Core Execution
// ---------------------------------------------------------------------------

/**
 * Build CLI argument array for `claude -p`.
 * The prompt is intentionally excluded and is written to stdin by runClaudeTurn
 * so Windows process creation never has to carry a repository-sized prompt.
 */
/** @visibleForTesting */
export function buildArgs(prompt, options = {}) {
  const args = ["-p"];
  // No --bare: it breaks OAuth auth. Isolation is achieved via --allowedTools.

  if (options.outputFormat === "stream-json") {
    args.push(
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages"
    );
  } else {
    args.push("--output-format", options.outputFormat ?? "json");
  }

  if (options.inputFormat === "stream-json") {
    args.push("--input-format", "stream-json");
    if (options.replayUserMessages !== false) {
      args.push("--replay-user-messages");
    }
  }
  if (options.includeHookEvents) {
    args.push("--include-hook-events");
  }

  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  }
  if (options.sessionName && !options.sessionId && !options.resumeSessionId) {
    const sessionName = String(options.sessionName).trim();
    if (!sessionName || sessionName.includes("\0")) {
      throw new Error("Claude session name must be non-empty text without NUL bytes.");
    }
    args.push("--name", sessionName);
  }
  if (options.model) {
    args.push("--model", resolveModel(options.model));
  }
  if (options.effort) {
    args.push("--effort", resolveEffort(options.effort));
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.allowedTools) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (options.disallowedTools) {
    for (const tool of options.disallowedTools) {
      args.push("--disallowedTools", tool);
    }
  }
  if (options.agents != null) {
    args.push("--agents", serializeClaudeAgents(options.agents));
  }
  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    args.push("--json-schema", JSON.stringify(options.jsonSchema));
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }
  if (options.appendSystemPrompt) {
    const promptText = String(options.appendSystemPrompt);
    if (!promptText.trim() || promptText.includes("\0")) {
      throw new Error("Claude appended system prompt must be non-empty text without NUL bytes.");
    }
    args.push("--append-system-prompt", promptText);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.settingsFile) {
    args.push("--settings", options.settingsFile);
  }
  if (options.mcpConfigFile) {
    args.push("--mcp-config", options.mcpConfigFile);
  }
  if (options.strictMcpConfig) {
    args.push("--strict-mcp-config");
  }

  return args;
}

function exactNativeProbeText(value, maxBytes = CLAUDE_NATIVE_ROUTE_PROBE_MAX_VALUE_BYTES) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  if (Buffer.byteLength(value, "utf8") > maxBytes) return null;
  return value.trim() === value ? value : null;
}

function nativeProbeVersionClass(value) {
  const version = exactNativeProbeText(value, 64);
  const match = version?.match(/^(\d{1,2})\.(\d{1,2})\.\d{1,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function classifyNativeProbeModelRows(value) {
  const failures = new Set();
  const candidates = [];
  let rowsSeen = 0;
  if (!Array.isArray(value) || value.length > CLAUDE_NATIVE_ROUTE_PROBE_MAX_ROWS) {
    failures.add("catalog_malformed");
    return { candidates, failures, rowsSeen };
  }

  const values = new Set();
  for (const row of value) {
    rowsSeen += 1;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      failures.add("row_malformed");
      continue;
    }
    const model = exactNativeProbeText(row.value);
    const resolvedModel = exactNativeProbeText(row.resolvedModel);
    if (!model) {
      failures.add("row_malformed");
      continue;
    }
    if (values.has(model)) {
      failures.add("duplicate_value");
      continue;
    }
    values.add(model);
    if (model === "default" || row.disabled === true) {
      failures.add("default_or_disabled");
      continue;
    }
    // A native selector must resolve to itself. This rejects default, family,
    // context, alias, and display-only values without an in-tree alias table.
    if (!resolvedModel || resolvedModel !== model) {
      failures.add("unresolved_or_alias");
      continue;
    }
    if (row.supportsEffort !== true || !Array.isArray(row.supportedEffortLevels)) {
      failures.add("missing_efforts");
      continue;
    }
    if (
      row.supportedEffortLevels.length === 0 ||
      row.supportedEffortLevels.length > CLAUDE_NATIVE_ROUTE_PROBE_MAX_EFFORTS
    ) {
      failures.add("invalid_efforts");
      continue;
    }
    const efforts = [];
    const seenEfforts = new Set();
    let invalidEffort = false;
    for (const effortValue of row.supportedEffortLevels) {
      const effort = exactNativeProbeText(effortValue, 16);
      if (!effort || !NATIVE_MODEL_EFFORTS.has(effort) || seenEfforts.has(effort)) {
        invalidEffort = true;
        break;
      }
      seenEfforts.add(effort);
      efforts.push(effort);
    }
    if (invalidEffort) {
      failures.add("invalid_efforts");
      continue;
    }
    candidates.push(Object.freeze({ value: model, efforts: Object.freeze(efforts) }));
  }
  return { candidates, failures, rowsSeen };
}

function nativeProbeReceipt({
  cliVersionClass,
  candidates,
  failures,
  frames,
  noAcceptedTurn,
  noGeneration,
  noModelRequest,
  noSessionContinuation,
  noUserPrompt,
  processCleaned,
  rowsSeen,
}) {
  const failureClasses = [...failures].sort();
  const result = failureClasses.length === 0 && candidates.length > 0 ? "candidate" : "HOLD";
  const receipt = {
    probe: "claude-native-route-control",
    schema: CLAUDE_NATIVE_ROUTE_PROBE_SCHEMA,
    cliVersionClass: cliVersionClass ?? "unknown",
    counts: {
      frames,
      rowsSeen,
      candidates: result === "candidate" ? candidates.length : 0,
      failureClasses: failureClasses.length,
    },
    failureClasses,
    noUserPrompt,
    noAcceptedTurn,
    noGeneration,
    noSessionContinuation,
    noModelRequest,
    processCleaned,
    result,
  };
  if (result === "candidate") receipt.candidates = candidates;
  return Object.freeze(receipt);
}

/**
 * One bounded zero-prompt Claude control request. This is intentionally not a
 * Driver/admission API: a candidate is only parser evidence, never selection
 * proof, and callers must not substitute it for a model turn.
 */
export async function runClaudeNativeRouteProbe(cwd, options = {}) {
  const childEnv = options.env ?? process.env;
  const claudeBin = options.claudeBin ?? resolveClaudeExecutable({ env: childEnv });
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, CLAUDE_NATIVE_ROUTE_PROBE_TIMEOUT_MS)
    : CLAUDE_NATIVE_ROUTE_PROBE_TIMEOUT_MS;
  const maxStdoutBytes = Number.isSafeInteger(options.maxStdoutBytes) && options.maxStdoutBytes > 0
    ? Math.min(options.maxStdoutBytes, CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDOUT_BYTES)
    : CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDOUT_BYTES;
  const maxStderrBytes = Number.isSafeInteger(options.maxStderrBytes) && options.maxStderrBytes > 0
    ? Math.min(options.maxStderrBytes, CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDERR_BYTES)
    : CLAUDE_NATIVE_ROUTE_PROBE_MAX_STDERR_BYTES;
  const requestId = `harnessdock-list-models-${randomBytes(12).toString("hex")}`;
  const controlInput = `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "list_models" },
  })}\n`;
  const args = buildArgs("", {
    outputFormat: "stream-json",
    inputFormat: "stream-json",
    replayUserMessages: false,
    noSessionPersistence: true,
  });
  const failures = new Set();
  let candidates = [];
  let rowsSeen = 0;
  let frames = 0;
  let cliVersionClass = null;
  let initObserved = false;
  let controlObserved = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lineBuffer = "";
  let noAcceptedTurn = true;
  let noGeneration = true;
  let noModelRequest = true;
  let noSessionContinuation = true;
  let noUserPrompt = true;
  let processCleaned = false;
  let pidIdentity = null;
  let shutdownPromise = null;
  let deadline = null;
  let settled = false;

  const addFailure = (failure) => failures.add(failure);
  const spawnImpl = options.spawnImpl ?? spawn;
  let proc;
  try {
    proc = spawnImpl(claudeBin, args, {
      cwd,
      env: childEnv,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    addFailure("launch_failed");
    return nativeProbeReceipt({
      cliVersionClass,
      candidates,
      failures,
      frames,
      noAcceptedTurn,
      noGeneration,
      noModelRequest,
      noSessionContinuation,
      noUserPrompt,
      processCleaned,
      rowsSeen,
    });
  }

  const hasValidIdentity = () => Number.isFinite(proc.pid) && Boolean(String(pidIdentity ?? "").trim());
  try {
    pidIdentity = (options.getProcessIdentity ?? getProcessIdentity)(proc.pid);
  } catch {
    addFailure("launch_identity_missing");
  }

  const requestShutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (!proc.stdin.destroyed) {
        try { proc.stdin.destroy(); } catch {}
      }
      if (!hasValidIdentity()) {
        try { proc.kill("SIGTERM"); } catch {}
        addFailure("cleanup_ambiguous");
        return;
      }
      const cancellation = await cancelClaudeProcess(proc.pid, pidIdentity, options.processControlOptions);
      if (cancellation.cancelled !== true) addFailure("cleanup_ambiguous");
    })();
    return shutdownPromise;
  };

  const rejectProtocol = (failure) => {
    addFailure(failure);
    void requestShutdown();
  };

  const observeFrame = (event) => {
    frames += 1;
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      rejectProtocol("malformed_response");
      return;
    }
    if (event.type === "system") {
      if (event.subtype !== "init" || initObserved || nativeProbeVersionClass(event.claude_code_version) == null) {
        rejectProtocol("malformed_initialization");
        return;
      }
      initObserved = true;
      cliVersionClass = nativeProbeVersionClass(event.claude_code_version);
      return;
    }
    if (event.type === "control_response") {
      const response = event.response;
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        rejectProtocol("malformed_response");
        return;
      }
      if (response.request_id !== requestId) {
        rejectProtocol("correlation_mismatch");
        return;
      }
      if (response.subtype !== "success" || controlObserved) {
        rejectProtocol(response.subtype === "error" ? "control_error" : "malformed_response");
        return;
      }
      const payload = response.response;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "models")) {
        rejectProtocol("catalog_malformed");
        return;
      }
      controlObserved = true;
      const classified = classifyNativeProbeModelRows(payload.models);
      candidates = classified.candidates;
      rowsSeen = classified.rowsSeen;
      for (const failure of classified.failures) addFailure(failure);
      return;
    }
    if (event.type === "user") {
      noUserPrompt = false;
      noAcceptedTurn = false;
      rejectProtocol("forbidden_user_event");
      return;
    }
    if (event.type === "assistant") {
      noAcceptedTurn = false;
      noGeneration = false;
      rejectProtocol("forbidden_assistant_event");
      return;
    }
    if (event.type === "result") {
      noAcceptedTurn = false;
      noGeneration = false;
      rejectProtocol("forbidden_result_event");
      return;
    }
    if (event.type === "control_request") {
      noModelRequest = false;
      rejectProtocol("forbidden_model_request");
      return;
    }
    if (event.type === "stream_event" && /resume|continuation/i.test(String(event.subtype ?? ""))) {
      noSessionContinuation = false;
      rejectProtocol("forbidden_session_continuation");
      return;
    }
    rejectProtocol("unexpected_event");
  };

  return new Promise((resolve) => {
    const finish = async () => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (shutdownPromise) await shutdownPromise;
      if (!initObserved) addFailure("initialization_missing");
      if (!controlObserved) addFailure("control_response_missing");
      if (candidates.length === 0) addFailure("no_complete_candidate");
      if (hasValidIdentity()) {
        const group = await waitForProcessGroup(proc.pid, CLAUDE_NATIVE_ROUTE_PROBE_CLEANUP_WAIT_MS);
        processCleaned = group.absent === true;
        if (!processCleaned) addFailure("cleanup_ambiguous");
      } else {
        addFailure("cleanup_ambiguous");
      }
      resolve(nativeProbeReceipt({
        cliVersionClass,
        candidates,
        failures,
        frames,
        noAcceptedTurn,
        noGeneration,
        noModelRequest,
        noSessionContinuation,
        noUserPrompt,
        processCleaned,
        rowsSeen,
      }));
    };

    proc.stdin.on("error", () => rejectProtocol("input_write_failed"));
    proc.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes) rejectProtocol("stderr_oversized");
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        rejectProtocol("stdout_oversized");
        return;
      }
      lineBuffer += chunk;
      if (Buffer.byteLength(lineBuffer, "utf8") > CLAUDE_NATIVE_ROUTE_PROBE_MAX_LINE_BYTES) {
        rejectProtocol("stdout_oversized");
        return;
      }
      let boundary;
      while ((boundary = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, boundary);
        lineBuffer = lineBuffer.slice(boundary + 1);
        if (!line) continue;
        try {
          observeFrame(JSON.parse(line));
        } catch {
          rejectProtocol("malformed_response");
        }
      }
    });
    proc.on("error", () => {
      addFailure("launch_failed");
      void finish();
    });
    proc.on("close", () => {
      if (lineBuffer.trim()) {
        try {
          observeFrame(JSON.parse(lineBuffer));
        } catch {
          addFailure("malformed_response");
        }
      }
      void finish();
    });

    deadline = setTimeout(() => {
      addFailure("timeout");
      void requestShutdown();
    }, timeoutMs);

    if (!hasValidIdentity()) {
      void requestShutdown();
      return;
    }
    try {
      // This is the only stdin frame. It is a control request, never a user
      // prompt, and input is closed immediately after that one frame.
      proc.stdin.end(controlInput, "utf8");
    } catch {
      rejectProtocol("input_write_failed");
    }
  });
}

/**
 * Execute a Claude Code turn with streaming progress.
 * Returns { status, sessionId, finalMessage, toolUses, touchedFiles, stderr, pid, pidIdentity }
 */
export async function runClaudeTurn(cwd, prompt, options = {}) {
  const args = buildArgs(prompt, {
    outputFormat: "stream-json",
    ...options,
  });

  return new Promise((resolve) => {
    const childEnv = options.env ?? process.env;
    const claudeBin = options.claudeBin ?? resolveClaudeExecutable({ env: childEnv });
    const streamingInput = options.inputFormat === "stream-json";
    const proc = spawn(claudeBin, args, {
      cwd,
      env: childEnv,
      detached: true, // new process group for safe cancellation
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdinError = null;
    let stdinClosed = false;
    let inputPumpInFlight = null;
    let inputTimer = null;
    let settled = false;
    const sentInputs = [];
    const parser = new StreamParser({
      delegationMode: options.delegationMode,
      onNativeTeamWitness: options.onNativeTeamWitness,
    });
    let stderr = "";

    proc.stdin.on("error", (error) => {
      // ChildProcess still emits its normal close/error event. Retain the pipe
      // failure so a child cannot be reported as successful without its prompt.
      stdinError = error;
    });

    const closeInput = () => {
      if (stdinClosed || proc.stdin.destroyed) return;
      stdinClosed = true;
      proc.stdin.end();
    };

    const writeStreamInput = (input) => new Promise((resolveWrite) => {
      if (stdinClosed || proc.stdin.destroyed || !proc.stdin.writable) {
        resolveWrite(false);
        return;
      }
      const text = String(input?.text ?? "");
      try {
        proc.stdin.write(encodeStreamUserMessage(text), "utf8", (error) => {
          if (error) {
            stdinError = error;
            resolveWrite(false);
            return;
          }
          const receipt = { ...input, text };
          sentInputs.push(receipt);
          options.onInputDispatched?.(receipt);
          resolveWrite(true);
        });
      } catch (error) {
        stdinError = error;
        resolveWrite(false);
      }
    });

    const pumpInput = async () => {
      if (!streamingInput || !options.pollInput || stdinClosed) return 0;
      if (inputPumpInFlight) return inputPumpInFlight;
      inputPumpInFlight = (async () => {
        const pending = await options.pollInput();
        let dispatched = 0;
        for (const input of Array.isArray(pending) ? pending : []) {
          if (await writeStreamInput(input)) dispatched += 1;
        }
        return dispatched;
      })();
      try {
        return await inputPumpInFlight;
      } finally {
        inputPumpInFlight = null;
      }
    };

    let pidIdentity = null;
    const getProcessIdentityImpl = options.getProcessIdentity ?? getProcessIdentity;
    try {
      pidIdentity = getProcessIdentityImpl(proc.pid);
    } catch {
      // A process identity is mandatory for the launch boundary. The child is
      // terminated below without sending any task input.
    }

    const hasValidReceipt = Number.isFinite(proc.pid) &&
      Boolean(String(pidIdentity ?? "").trim());

    const terminateUnacceptedChild = () => {
      let terminated = false;
      if (hasValidReceipt) {
        try {
          const terminate = options.terminateProcessTree ?? terminateProcessTree;
          terminated = terminate(proc.pid, pidIdentity)?.delivered === true;
        } catch {
          // The direct child handle below is safe while this adapter still
          // owns the newly-spawned process and provides a best-effort fallback.
        }
      }
      if (!terminated && !proc.killed) {
        try { proc.kill("SIGTERM"); } catch {}
      }
    };

    const rejectChildBeforeInput = (error) => {
      stdinError = error instanceof Error ? error : new Error(String(error));
      terminateUnacceptedChild();
      if (!proc.stdin.destroyed) {
        try { proc.stdin.destroy(); } catch {}
      }
    };

    const acceptChildBeforeInput = async () => {
      if (!hasValidReceipt) {
        rejectChildBeforeInput(
          new Error("Claude child launch requires a valid PID identity before prompt delivery.")
        );
        return false;
      }
      try {
        const accepted = options.onSpawn
          ? await options.onSpawn({ pid: proc.pid, pidIdentity })
          : true;
        if (accepted !== true) {
          rejectChildBeforeInput(new Error("Claude child launch was not durably accepted."));
          return false;
        }
        return true;
      } catch (error) {
        rejectChildBeforeInput(error);
        return false;
      }
    };

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr = appendTextTail(stderr, chunk, MAX_STDERR_BYTES);
      parser.state.lastByteAt = new Date().toISOString();
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      const events = parser.feed(chunk);
      for (const evt of events) {
        if (evt.kind === "user_replay") {
          const inputIndex = sentInputs.findIndex((input) => input.text === evt.text);
          if (inputIndex >= 0) {
            const [acknowledged] = sentInputs.splice(inputIndex, 1);
            options.onInputAcknowledged?.(acknowledged);
          }
        }
        if (options.onProgress) {
          options.onProgress(evt);
        }
        if (streamingInput && evt.kind === "result") {
          void (async () => {
            try {
              const pumpedInputs = await pumpInput();
              const shouldClose = options.onTerminal
                ? await options.onTerminal({
                    event: evt.data,
                    state: parser.state,
                    pumpedInputs,
                  })
                : true;
              if (shouldClose !== false) closeInput();
            } catch (error) {
              stdinError = error;
              closeInput();
            }
          })();
        }
      }
    });

    proc.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (inputTimer) clearInterval(inputTimer);
      // Flush remaining buffer
      const remaining = parser.flush();
      for (const evt of remaining) {
        if (options.onProgress) options.onProgress(evt);
      }

      if (stdinError) {
        stderr = appendTextTail(
          stderr,
          `\nFailed to write Claude prompt to stdin: ${stdinError.message}`,
          MAX_STDERR_BYTES
        );
      }
      const validation = stdinError
        ? { status: "failed", warning: "Claude prompt delivery through stdin failed." }
        : validateTurnCompletion(parser.state, code ?? 1);
      const baseResult = {
        status: validation.status,
        warning: validation.warning ?? parser.state.nativeTeamWarning,
        exitCode: code,
        signal,
        sessionId: parser.state.sessionId,
        finalMessage: parser.state.finalMessage,
        assistantOutputObserved: parser.state.assistantOutputObserved,
        structuredOutput: parser.state.structuredOutput,
        toolUses: parser.state.toolUses,
        touchedFiles: parser.state.touchedFiles,
        terminalEvents: parser.state.terminalEvents,
        unknownEvents: parser.state.unknownEvents,
        unknownEventCount: parser.state.unknownEventCount,
        unknownEventOverflowCount: parser.state.unknownEventOverflowCount,
        runtimeReceipt: {
          ...buildHostRuntimeReceipt(options, childEnv, claudeBin),
          ...(parser.state.runtimeReceipt ?? {}),
          hookReceipts: parser.state.hookReceipts,
          unknownEvents: parser.state.unknownEvents,
          unknownEventCount: parser.state.unknownEventCount,
          unknownEventOverflowCount: parser.state.unknownEventOverflowCount,
        },
        lastByteAt: parser.state.lastByteAt,
        providerReportedMetrics: parser.state.providerReportedMetrics,
        compatibilitySurfaceDrift: parser.state.compatibilitySurfaceDrift,
        nativeTeamTransportUnvalidated: parser.state.delegationMode === "claude_orchestrator" &&
          parser.state.nativeTeamSurface?.teamTransportLiveValidated !== true,
        stderr,
        pid: proc.pid,
        pidIdentity,
      };
      const failure = classifyClaudeFailure(baseResult);
      resolve({
        ...baseResult,
        failureClass: failure.kind,
        failureReason: failure.reason,
        resumable: failure.resumable,
      });
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (inputTimer) clearInterval(inputTimer);
      resolve({
        status: "failed",
        exitCode: -1,
        sessionId: null,
        finalMessage: "",
        assistantOutputObserved: false,
        structuredOutput: null,
        toolUses: [],
        touchedFiles: [],
        terminalEvents: [],
        runtimeReceipt: buildHostRuntimeReceipt(options, childEnv, claudeBin),
        lastByteAt: null,
        stderr: err.message,
        pid: proc.pid,
        pidIdentity,
        failureClass: "fatal",
        failureReason: err.message,
        resumable: false,
      });
    });

    // Keeping prompts out of argv avoids Windows' command-line length limit.
    // More importantly, no stdin write or input-pump timer may begin before
    // the runner durably accepts this exact child receipt.
    void (async () => {
      if (!await acceptChildBeforeInput() || settled) return;
      try {
        if (streamingInput) {
          proc.stdin.write(encodeStreamUserMessage(prompt), "utf8");
        } else {
          stdinClosed = true;
          proc.stdin.end(String(prompt ?? ""), "utf8");
        }
      } catch (error) {
        stdinError = error;
        proc.stdin.destroy();
        return;
      }

      if (streamingInput && options.pollInput) {
        const pollIntervalMs = Math.max(25, Number(options.inputPollIntervalMs) || 200);
        inputTimer = setInterval(() => {
          void pumpInput().catch((error) => {
            stdinError = error;
            closeInput();
          });
        }, pollIntervalMs);
      }
    })();

    // Unref only for background workers — foreground callers need the process to keep Node alive
    if (options.background) {
      proc.unref();
    }
  });
}

// ---------------------------------------------------------------------------
// Cancellation — process-group based, identity-verified
// ---------------------------------------------------------------------------

/**
 * Interrupt a running Claude Code process without escalating to SIGKILL.
 * Claude persists the current session before exiting, so callers can resume
 * the exact session and retain partial output.
 */
export async function interruptClaudeProcess(pid, pidIdentity, options = {}) {
  const platform = options.platform ?? process.platform;
  const validateIdentity = options.validateProcessIdentityImpl ?? validateProcessIdentity;
  if (!pidIdentity) {
    return {
      interrupted: false,
      note: "Refusing to signal a process without a deterministic identity.",
      controlFailure: "missing_identity",
    };
  }
  if (!validateIdentity(pid, pidIdentity, options)) {
    return {
      interrupted: false,
      note: "Refusing to signal a process whose identity no longer matches.",
      controlFailure: "identity_mismatch",
    };
  }

  if (platform === "win32") {
    return {
      interrupted: false,
      note: "Graceful SIGINT is unavailable for a detached native Windows process; internal bounded process-tree cleanup is required.",
    };
  }

  const signal = signalProcessGroup(pid, "SIGINT", options);
  if (signal.absent) return { interrupted: true, note: signal.note };
  if (signal.controlFailure) {
    return {
      interrupted: false,
      note: signal.note,
      controlFailure: signal.controlFailure,
      controlFailureCode: signal.controlFailureCode,
    };
  }

  const observed = await waitForProcessGroup(pid, 5000, options);
  if (observed.controlFailure) {
    return {
      interrupted: false,
      note: observed.note,
      controlFailure: observed.controlFailure,
      controlFailureCode: observed.controlFailureCode,
    };
  }
  if (observed.absent) return { interrupted: true };
  return {
    interrupted: false,
    note: `Process group ${pid} did not exit after SIGINT; it was not force-killed`,
  };
}

/**
 * Request interruption of a running Claude Code process without observing the
 * outcome. This is the request-only half of `interruptClaudeProcess`: it
 * verifies identity and delivers exactly one SIGINT to the process group,
 * then returns immediately with a closed structured code. It never runs the
 * bounded post-signal observation window and never infers anything from
 * human-readable note text, so a caller that must acknowledge a request
 * promptly and structurally is never delayed by this turn's own settlement.
 * `interruptClaudeProcess` is unchanged and remains the legacy synchronous
 * request-and-observe contract existing callers still use.
 */
export function requestClaudeInterrupt(pid, pidIdentity, options = {}) {
  const platform = options.platform ?? process.platform;
  const validateIdentity = options.validateProcessIdentityImpl ?? validateProcessIdentity;
  if (!pidIdentity) {
    return { requested: false, requestFailure: "missing_identity" };
  }
  if (!validateIdentity(pid, pidIdentity, options)) {
    return { requested: false, requestFailure: "identity_mismatch" };
  }
  if (platform === "win32") {
    return { requested: false, requestFailure: "unsupported_platform" };
  }
  const signal = signalProcessGroup(pid, "SIGINT", options);
  if (signal.absent) {
    return { requested: false, requestFailure: "process_absent" };
  }
  if (signal.controlFailure) {
    return {
      requested: false,
      requestFailure: signal.controlFailure,
      controlFailureCode: signal.controlFailureCode,
    };
  }
  return { requested: true, requestFailure: null };
}

/**
 * Cancel a running Claude Code process.
 * Uses process group kill with PID identity verification.
 */
export async function cancelClaudeProcess(pid, pidIdentity, options = {}) {
  const platform = options.platform ?? process.platform;
  const validateIdentity = options.validateProcessIdentityImpl ?? validateProcessIdentity;
  if (!pidIdentity) {
    return {
      cancelled: false,
      note: "Refusing to terminate a process without a deterministic identity.",
      controlFailure: "missing_identity",
    };
  }
  if (!validateIdentity(pid, pidIdentity, options)) {
    return {
      cancelled: false,
      note: "Refusing to terminate a process whose identity no longer matches.",
      controlFailure: "identity_mismatch",
    };
  }

  if (platform === "win32") {
    const receipt = terminateProcessTree(pid, pidIdentity, options);
    if (!receipt.delivered) {
      return {
        cancelled: false,
        note: `Process-tree termination was not delivered (${receipt.reason ?? "not_found"}).`,
        controlFailure: receipt.reason ?? "not_delivered",
      };
    }
    const dead = await waitForProcessExit(pid, 5000, options);
    return dead
      ? { cancelled: true }
      : { cancelled: false, note: `Process tree ${pid} still alive after taskkill` };
  }

  // SIGTERM to entire process group
  const terminate = signalProcessGroup(pid, "SIGTERM", options);
  if (terminate.absent) return { cancelled: true, note: terminate.note };
  if (terminate.controlFailure) {
    return {
      cancelled: false,
      note: terminate.note,
      controlFailure: terminate.controlFailure,
      controlFailureCode: terminate.controlFailureCode,
    };
  }

  // Wait for process group to die
  const observed = await waitForProcessGroup(pid, 5000, options);
  if (observed.controlFailure) {
    return {
      cancelled: false,
      note: observed.note,
      controlFailure: observed.controlFailure,
      controlFailureCode: observed.controlFailureCode,
    };
  }
  if (observed.absent) {
    return { cancelled: true };
  }

  // Escalate to SIGKILL
  if (!validateIdentity(pid, pidIdentity, options)) {
    return {
      cancelled: false,
      note: "Process identity was lost during SIGTERM wait; refusing SIGKILL.",
      controlFailure: "identity_mismatch",
    };
  }

  const kill = signalProcessGroup(pid, "SIGKILL", options);
  if (kill.absent) return { cancelled: true, note: kill.note };
  if (kill.controlFailure) {
    return {
      cancelled: false,
      note: kill.note,
      controlFailure: kill.controlFailure,
      controlFailureCode: kill.controlFailureCode,
    };
  }

  const killed = await waitForProcessGroup(pid, 3000, options);
  if (killed.controlFailure) {
    return {
      cancelled: false,
      note: killed.note,
      controlFailure: killed.controlFailure,
      controlFailureCode: killed.controlFailureCode,
    };
  }
  if (killed.absent) {
    return { cancelled: true };
  }

  return {
    cancelled: false,
    note: `Process group ${pid} still alive after SIGKILL`,
  };
}

function signalProcessGroup(pgid, signal, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(-pgid, signal);
    return { delivered: true, absent: false, controlFailure: null };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "signal_failed";
    if (code === "ESRCH") {
      return {
        delivered: false,
        absent: true,
        controlFailure: null,
        note: "Process group is already absent (ESRCH).",
      };
    }
    const detail = error instanceof Error ? error.message : String(error ?? "unknown error");
    return {
      delivered: false,
      absent: false,
      controlFailure: code,
      controlFailureCode: code,
      note: `Process-group ${signal} failed (${code}): ${detail}`,
    };
  }
}

function probeProcessGroup(pgid, options = {}) {
  const probe = signalProcessGroup(pgid, 0, options);
  if (probe.delivered) return { alive: true, absent: false, controlFailure: null };
  if (probe.absent) return { alive: false, absent: true, controlFailure: null };
  return {
    alive: null,
    absent: false,
    controlFailure: probe.controlFailure,
    controlFailureCode: probe.controlFailureCode,
    note: `Process-group liveness probe failed: ${probe.note}`,
  };
}

async function waitForProcessExit(pid, timeoutMs, options = {}) {
  const alive = options.isProcessAliveImpl ?? isProcessAlive;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

async function waitForProcessGroup(pgid, timeoutMs, options = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probe = probeProcessGroup(pgid, options);
    if (probe.absent || probe.controlFailure) return probe;
    await new Promise((r) => setTimeout(r, 100));
  }
  return probeProcessGroup(pgid, options);
}
