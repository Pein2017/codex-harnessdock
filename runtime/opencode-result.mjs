/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenCode Explorer result boundary (add-opencode-explorer-driver, Task 4).
 *
 * One job: given the pinned prompt response (`{info: AssistantMessage, parts:
 * Part[]}`) and the exact lineage the caller expects, either project one
 * bounded outer-assistant final text plus closed metadata, or refuse with a
 * closed failure code. It makes no request of any kind, parses no terminal UI,
 * imports no SDK, and never carries native tool history, provider payloads, or
 * operator configuration outward.
 *
 * ## What "outer final" means, and why it is the last text part
 *
 * The pinned schema gives an assistant message a flat `parts` array whose
 * members are typed: `text`, `reasoning`, `tool`, `step-start`, `step-finish`,
 * `file`, `patch`, `snapshot`, `subtask`, `agent`, `retry`, `compaction`. A
 * multi-step Explorer turn legitimately emits several `text` parts -- a note
 * before a search, then its answer -- so the deliverable is the LAST
 * lineage-matching, non-synthetic, non-ignored `text` part. Earlier text parts
 * are counted, never concatenated: joining them would hand the caller an answer
 * the worker never gave as its final message. A `reasoning`, `tool`, or any
 * other part type is never eligible, so native tool history cannot be projected
 * as a result.
 *
 * A trailing part that normalizes to nothing is skipped in favour of the last
 * part that carries text, because an empty trailing part is a streaming
 * artifact rather than an answer. An oversized part is never skipped that way:
 * it is a refusal, since falling back would silently answer with superseded
 * text.
 *
 * ## Why oversized output is refused rather than truncated
 *
 * The governing spec text is explicit that empty or oversized output "SHALL not
 * be projected as success", and the design says the Plugin "rejects
 * empty/oversized/wrong-lineage output" against a bounded text result. That is
 * the opposite of the Claude CLI path, which truncates a captured stdout
 * stream: there, the bound is a transport capture limit; here the Harness hands
 * us one typed answer, so exceeding the bound is the worker breaking the return
 * contract the prompt stated. Truncating would silently publish a cut-off
 * answer as a success.
 *
 * ## What never crosses this boundary
 *
 * `info.path` holds the operator's absolute `cwd`/`root`; an `APIError` holds
 * raw `responseBody`/`responseHeaders`; `info.structured`, tool `state`, file
 * `url`, patch `files`, snapshot payloads, and subtask prompts are native
 * detail. None of them are read into the projection. A provider error is
 * reduced to its closed variant name, and an unrecognized name or finish reason
 * becomes the literal `unrecognized` rather than an echoed string.
 *
 * `info.tokens`/`info.cost` ARE read, but only as exact provider-reported
 * numbers on a separate `providerMetrics` field, never into the final text or
 * its metadata (Task 6.1). They are read from this same single-read snapshot of
 * the lineage-matched message rather than from a second request or a second
 * read, so the numbers a receipt carries are provably the ones this boundary
 * validated. Metrics accompany a refused projection too -- a provider error or
 * an empty final answer still consumed provider work -- but never a payload
 * whose lineage or shape was rejected, because such a payload proves nothing.
 */

import { types } from "node:util";

import { plainRecordSnapshot } from "./plain-record.mjs";

/**
 * The bounded final answer this route admits. It sits an order of magnitude
 * below the shared durable bound (`MAX_FINAL_MESSAGE_CHARS`, 256 KiB) so a
 * projected result always fits durable state, and it is the number the prompt
 * envelope states to the worker.
 */
export const OPENCODE_MAX_FINAL_TEXT_CHARS = 65_536;

/**
 * The raw ceiling checked before normalization runs, so a runaway part is
 * refused without first walking megabytes of text. Four times the normalized
 * bound leaves ample room for escape/control noise inside a legitimate answer.
 */
export const OPENCODE_MAX_RAW_FINAL_TEXT_CHARS = 262_144;

/** Absolute ceiling on the parts of one assistant message. */
export const OPENCODE_MAX_PARTS = 4_096;

/**
 * The exact provider-error variant names the pinned schema declares. The name
 * is the only part of an error this boundary ever projects: each variant's
 * `data` may carry a provider message, and `APIError.data` additionally carries
 * raw response headers and body.
 */
export const OPENCODE_PROVIDER_ERROR_NAMES = Object.freeze([
  "APIError",
  "ContentFilterError",
  "ContextOverflowError",
  "MessageAbortedError",
  "MessageOutputLengthError",
  "ProviderAuthError",
  "StructuredOutputError",
  "UnknownError",
]);

/**
 * `AssistantMessage.finish` is an open string in the schema, fed from the model
 * runtime's finish reason. These are the reasons this generation recognizes;
 * anything else is reported as `unrecognized` instead of echoed.
 */
export const OPENCODE_FINISH_REASONS = Object.freeze([
  "content-filter",
  "error",
  "length",
  "other",
  "stop",
  "tool-calls",
  "unknown",
]);

/** Every reason a payload is refused. A caller misuse throws instead. */
export const OPENCODE_RESULT_FAILURE_CODES = Object.freeze([
  "assistant_role_mismatch",
  "empty_final_text",
  "final_text_too_large",
  "lineage_mismatch",
  "malformed_response",
  "no_final_text",
  "provider_error",
]);

const UNRECOGNIZED = "unrecognized";

/**
 * The exact provider-reported numeric facts the pinned assistant schema
 * declares: `tokens.{input,output,reasoning}`, `tokens.cache.{read,write}`, and
 * `cost`. Nothing else is a metric here -- `tokens.total` is derivable and is
 * deliberately not carried, and no duration, latency, or price is inferred.
 */
export const OPENCODE_PROVIDER_METRIC_FIELDS = Object.freeze([
  "cacheReadTokens",
  "cacheWriteTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "reportedCost",
]);

function admittedTokenCount(value) {
  // Present-but-zero is a fact; absent is unknown; anything non-integer,
  // negative, or non-finite is malformed and stays unknown rather than being
  // coerced into a number a receipt would then present as reported.
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function admittedCostValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function snapshotOrNull(value, label) {
  if (value === undefined || value === null) return null;
  try {
    return plainRecordSnapshot(value, label);
  } catch {
    return undefined; // present but unreadable: malformed, not absent
  }
}

/**
 * Read the exact provider-reported metrics from one already-lineage-validated
 * assistant message snapshot. Every field is independent: a malformed cache
 * object leaves the cache facts unknown without discarding the token counts,
 * and a missing `tokens` object leaves a present `cost` intact.
 */
function readProviderMetrics(info) {
  const malformed = [];
  const metrics = {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reportedCost: null,
  };

  const tokens = snapshotOrNull(info.tokens, "OpenCode assistant tokens");
  if (tokens === undefined) {
    malformed.push("inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens");
  } else if (tokens !== null) {
    for (const [field, raw] of [
      ["inputTokens", tokens.input],
      ["outputTokens", tokens.output],
      ["reasoningTokens", tokens.reasoning],
    ]) {
      const admitted = admittedTokenCount(raw);
      if (admitted === null && raw !== undefined && raw !== null) malformed.push(field);
      metrics[field] = admitted;
    }
    const cache = snapshotOrNull(tokens.cache, "OpenCode assistant cache tokens");
    if (cache === undefined) {
      malformed.push("cacheReadTokens", "cacheWriteTokens");
    } else if (cache !== null) {
      for (const [field, raw] of [["cacheReadTokens", cache.read], ["cacheWriteTokens", cache.write]]) {
        const admitted = admittedTokenCount(raw);
        if (admitted === null && raw !== undefined && raw !== null) malformed.push(field);
        metrics[field] = admitted;
      }
    }
  }

  const cost = admittedCostValue(info.cost);
  if (cost === null && info.cost !== undefined && info.cost !== null) malformed.push("reportedCost");
  metrics.reportedCost = cost;

  return Object.freeze({
    ...metrics,
    provenance: "provider_reported",
    malformedFields: Object.freeze([...new Set(malformed)].sort()),
  });
}

const EXPECTED_LINEAGE_FIELDS = Object.freeze([
  "agent",
  "attemptId",
  "modelId",
  "parentMessageId",
  "providerId",
  "sessionId",
  "variant",
]);

const REQUIRED_LINEAGE_FIELDS = Object.freeze(["modelId", "parentMessageId", "providerId", "sessionId", "variant"]);

export class OpencodeResultError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OpencodeResultError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Deterministic bounded normalization.
// ---------------------------------------------------------------------------

/**
 * Line and paragraph separators, all folded to one newline so a bound and a
 * comparison mean the same thing on every payload.
 */
// eslint-disable-next-line no-control-regex -- folding them is the point
const LINE_SEPARATOR_PATTERN = /\u000d\u000a|\u000d|\u2028|\u2029/g;

/**
 * ANSI/VT escape sequences: a CSI sequence, an OSC sequence terminated by BEL
 * or ST, and any remaining two-character escape. Removed before control
 * characters are stripped, because stripping the escape byte first would leave
 * the payload (`[31m`) behind as visible text.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const ANSI_PATTERN = /\u001b\[[0-9;?]*[\u0020-\u002f]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\u005c)|\u001b[@-Z\u005c-_]/g;

/**
 * Everything invisible that survives: C0 controls other than newline and tab,
 * DEL, the C1 range, zero-width and BiDi format characters, the soft hyphen,
 * and a byte-order mark. Any of these can hide or reorder text a reader would
 * otherwise see.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const INVISIBLE_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

/**
 * Normalize one final text deterministically and idempotently: fold line
 * separators, remove escape sequences, remove invisible characters, then trim.
 * Nothing is rewritten into different visible text and nothing is truncated, so
 * running it twice returns the same string.
 */
export function normalizeOpencodeFinalText(text) {
  return normalizeWithCounters(text).text;
}

function normalizeWithCounters(text) {
  if (typeof text !== "string") {
    throw new OpencodeResultError("final_text_not_string", "A final text must be a string.");
  }
  const folded = text.replace(LINE_SEPARATOR_PATTERN, "\n");
  const ansiSequencesRemoved = countMatches(folded, ANSI_PATTERN);
  const withoutAnsi = folded.replace(ANSI_PATTERN, "");
  const controlCharactersRemoved = countMatches(withoutAnsi, INVISIBLE_PATTERN);
  const visible = withoutAnsi.replace(INVISIBLE_PATTERN, "");
  const trimmedText = visible.trim();
  return {
    text: trimmedText,
    ansiSequencesRemoved,
    controlCharactersRemoved,
    trimmed: trimmedText.length !== visible.length,
  };
}

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value);
}

function failure(code, extra = {}) {
  return Object.freeze({ ok: false, code, ...extra });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The lineage the caller must state. The session, parent message, provider, and
 * model are matched against the payload; the agent is matched when stated. The
 * attempt is the Plugin's own identity and has no field in the native payload,
 * so it is carried through the projection rather than matched -- proving
 * acceptance against an attempt is the launch/turn lineage owner's job, not
 * this boundary's.
 */
function requireExpectedLineage(expected) {
  let fields;
  try {
    fields = plainRecordSnapshot(expected, "OpenCode expected result lineage");
  } catch (error) {
    throw new OpencodeResultError("expected_lineage_malformed", error.message);
  }
  for (const field of Object.keys(fields)) {
    if (!EXPECTED_LINEAGE_FIELDS.includes(field)) {
      throw new OpencodeResultError(
        "expected_lineage_malformed",
        `OpenCode expected result lineage declares an unknown field: ${field}.`,
        { field }
      );
    }
  }
  for (const field of REQUIRED_LINEAGE_FIELDS) {
    if (!nonEmptyString(fields[field])) {
      throw new OpencodeResultError(
        "expected_lineage_required",
        `OpenCode result selection requires the expected ${field}.`,
        { field }
      );
    }
  }
  if (fields.agent != null && !nonEmptyString(fields.agent)) {
    throw new OpencodeResultError("expected_lineage_required", "The expected agent must be text when stated.", {
      field: "agent",
    });
  }
  if (fields.attemptId != null && !nonEmptyString(fields.attemptId)) {
    throw new OpencodeResultError("expected_lineage_required", "The expected attempt must be text when stated.", {
      field: "attemptId",
    });
  }
  return Object.freeze({
    sessionId: fields.sessionId,
    parentMessageId: fields.parentMessageId,
    providerId: fields.providerId,
    modelId: fields.modelId,
    variant: fields.variant,
    agent: fields.agent ?? null,
    attemptId: fields.attemptId ?? null,
  });
}

/**
 * Tool parts of one message, counted without reading a tool name, input, or
 * output. Used by the provider-error arm, which returns before the part walk.
 */
function countToolParts(parts, info) {
  let count = 0;
  for (const rawPart of parts) {
    let part;
    try {
      part = plainRecordSnapshot(rawPart, "OpenCode message part");
    } catch {
      return count;
    }
    if (part.type === "tool" && part.sessionID === info.sessionID && part.messageID === info.id) count += 1;
  }
  return count;
}

function closedProviderErrorName(error) {
  if (!isPlainObject(error)) return UNRECOGNIZED;
  return OPENCODE_PROVIDER_ERROR_NAMES.includes(error.name) ? error.name : UNRECOGNIZED;
}

function closedFinishReason(finish) {
  if (finish == null) return null;
  return OPENCODE_FINISH_REASONS.includes(finish) ? finish : UNRECOGNIZED;
}

/**
 * Select the one final Explorer answer from one pinned prompt response.
 *
 * @param {*} response the pinned `{info, parts}` payload, unvalidated
 * @param {*} expected the exact lineage the caller proved before submitting
 * @returns {{ok: boolean, finalMessage?: string, metadata?: object, lineage?: object,
 *   code?: string, field?: string, providerErrorName?: string, providerMetrics?: object,
 *   toolCallCount?: number}} exactly one arm is populated: `ok: true` carries the
 *   projection, `ok: false` carries a closed code. `providerMetrics` accompanies
 *   every arm whose message lineage validated, including refusals.
 */
export function selectOpencodeExplorerFinalResult(response, expected) {
  const lineage = requireExpectedLineage(expected);

  // One single-read snapshot per record. The message's own session id is
  // compared twice -- once against the expected lineage, once against every
  // part -- so reading it from a live object would leave a gap an accessor
  // could answer differently through. Nothing below reads the caller's objects
  // again.
  let info;
  let parts;
  try {
    const envelope = plainRecordSnapshot(response, "OpenCode prompt response");
    parts = envelope.parts;
    if (!Array.isArray(parts) || types.isProxy(parts)) return failure("malformed_response");
    if (parts.length > OPENCODE_MAX_PARTS) return failure("malformed_response");
    info = plainRecordSnapshot(envelope.info, "OpenCode assistant message");
  } catch {
    return failure("malformed_response");
  }

  if (info.role !== "assistant") return failure("assistant_role_mismatch");
  if (!nonEmptyString(info.id)) return failure("malformed_response");

  for (const [field, actual, wanted] of [
    ["sessionID", info.sessionID, lineage.sessionId],
    ["parentID", info.parentID, lineage.parentMessageId],
    ["providerID", info.providerID, lineage.providerId],
    ["modelID", info.modelID, lineage.modelId],
    ["variant", info.variant, lineage.variant],
  ]) {
    if (actual !== wanted) return failure("lineage_mismatch", { field });
  }
  if (lineage.agent !== null && info.agent !== lineage.agent) {
    return failure("lineage_mismatch", { field: "agent" });
  }

  // Lineage is proven, so this message's own numbers are trustworthy evidence
  // even when its text is not.
  const providerMetrics = readProviderMetrics(info);

  // A provider/native error is classified here but never merged with a partial
  // answer: a turn that errored has no admitted final text.
  if (info.error != null) {
    return failure("provider_error", {
      providerErrorName: closedProviderErrorName(info.error),
      providerMetrics,
      toolCallCount: countToolParts(parts, info),
    });
  }

  /** @type {string[]} */
  const candidates = [];
  let nonTextPartCount = 0;
  let toolCallCount = 0;
  for (const rawPart of parts) {
    let part;
    try {
      part = plainRecordSnapshot(rawPart, "OpenCode message part");
    } catch {
      return failure("malformed_response");
    }
    if (typeof part.type !== "string") return failure("malformed_response");
    if (typeof part.sessionID !== "string" || typeof part.messageID !== "string") {
      return failure("malformed_response");
    }
    // A part that belongs to another session or message is a crossover, not
    // noise to skip past.
    if (part.sessionID !== info.sessionID) return failure("lineage_mismatch", { field: "part.sessionID" });
    if (part.messageID !== info.id) return failure("lineage_mismatch", { field: "part.messageID" });
    if (part.type !== "text") {
      nonTextPartCount += 1;
      // A count is not tool history: no tool name, input, or output is read.
      if (part.type === "tool") toolCallCount += 1;
      continue;
    }
    if (typeof part.text !== "string") return failure("malformed_response");
    // Synthetic and ignored text is injected or withdrawn by the Harness, not
    // the worker's answer.
    if (part.synthetic === true || part.ignored === true) continue;
    candidates.push(part.text);
  }

  if (candidates.length === 0) return failure("no_final_text", { providerMetrics, toolCallCount });

  let selected = null;
  let selectedIndex = -1;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const raw = candidates[index];
    if (raw.length > OPENCODE_MAX_RAW_FINAL_TEXT_CHARS) {
      return failure("final_text_too_large", { providerMetrics, toolCallCount });
    }
    const normalized = normalizeWithCounters(raw);
    if (normalized.text.length > OPENCODE_MAX_FINAL_TEXT_CHARS) {
      return failure("final_text_too_large", { providerMetrics, toolCallCount });
    }
    if (normalized.text.length > 0) {
      selected = normalized;
      selectedIndex = index;
      break;
    }
  }
  if (selected === null) return failure("empty_final_text", { providerMetrics, toolCallCount });

  return Object.freeze({
    ok: true,
    finalMessage: selected.text,
    providerMetrics,
    toolCallCount,
    metadata: Object.freeze({
      textPartCount: candidates.length,
      precedingTextPartCount: selectedIndex,
      nonTextPartCount,
      finishReason: closedFinishReason(info.finish),
      normalization: Object.freeze({
        ansiSequencesRemoved: selected.ansiSequencesRemoved,
        controlCharactersRemoved: selected.controlCharactersRemoved,
        trimmed: selected.trimmed,
      }),
    }),
    lineage: Object.freeze({
      sessionId: lineage.sessionId,
      messageId: info.id,
      parentMessageId: lineage.parentMessageId,
      providerId: lineage.providerId,
      modelId: lineage.modelId,
      variant: lineage.variant,
      agent: lineage.agent,
      attemptId: lineage.attemptId,
    }),
  });
}
