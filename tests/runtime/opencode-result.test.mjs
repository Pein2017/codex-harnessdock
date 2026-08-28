/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 4.3/4.4 of add-opencode-explorer-driver: select exactly one bounded
 * outer-assistant final text plus closed metadata, and nothing else.
 *
 * Every payload here is a fake built from the pinned `@opencode-ai/sdk@1.18.18`
 * assistant-message and part shapes (`{info: AssistantMessage, parts: Part[]}`);
 * no session, message, prompt, or model request is made anywhere in this suite.
 *
 * Two shapes in that schema are deliberately never projected, and are asserted
 * absent from every serialized result: `info.path` carries the operator's
 * absolute `cwd`/`root`, and an `APIError` carries raw `responseBody`/
 * `responseHeaders`. Tool state, file URLs, patch file lists, snapshots, and
 * subtask prompts are native tool history and stay in OpenCode.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MAX_FINAL_MESSAGE_CHARS,
  MAX_RESULT_METADATA_BYTES,
} from "../../runtime/harness-contract.mjs";
import {
  OPENCODE_FINISH_REASONS,
  OPENCODE_MAX_FINAL_TEXT_CHARS,
  OPENCODE_MAX_PARTS,
  OPENCODE_MAX_RAW_FINAL_TEXT_CHARS,
  OPENCODE_PROVIDER_ERROR_NAMES,
  OPENCODE_RESULT_FAILURE_CODES,
  OpencodeResultError,
  normalizeOpencodeFinalText,
  selectOpencodeExplorerFinalResult,
} from "../../runtime/opencode-result.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "tests", "runtime", "fixtures", "opencode-compatibility.json"), "utf8")
);

const SESSION_ID = "ses_01JEXPLORER";
const MESSAGE_ID = "msg_assistant_01";
const PARENT_ID = "msg_user_01";
const PROVIDER_ID = "opencode-go";
const MODEL_ID = "deepseek-v4-flash";
const AGENT = "codex-explorer";
const ATTEMPT_ID = "att_01JATTEMPT";
const VARIANT = "high";

/** The operator-absolute paths the assistant message carries but we never project. */
const OPERATOR_CWD = "/opt/operator-owned/workspace";
const OPERATOR_ROOT = "/opt/operator-owned";

function assistantInfo(overrides = {}) {
  return {
    id: MESSAGE_ID,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1_764_000_000_000, completed: 1_764_000_002_000 },
    parentID: PARENT_ID,
    modelID: MODEL_ID,
    providerID: PROVIDER_ID,
    mode: "primary",
    agent: AGENT,
    variant: VARIANT,
    path: { cwd: OPERATOR_CWD, root: OPERATOR_ROOT },
    cost: 0.0021,
    tokens: { total: 1234, input: 1000, output: 200, reasoning: 34, cache: { read: 900, write: 100 } },
    finish: "stop",
    ...overrides,
  };
}

function textPart(text, overrides = {}) {
  return {
    id: `prt_text_${Math.abs(text.length)}`,
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "text",
    text,
    time: { start: 1_764_000_001_000, end: 1_764_000_002_000 },
    ...overrides,
  };
}

function toolPart(overrides = {}) {
  return {
    id: "prt_tool_1",
    sessionID: SESSION_ID,
    messageID: MESSAGE_ID,
    type: "tool",
    callID: "call_1",
    tool: "read",
    state: { status: "completed", input: { filePath: "/opt/operator-owned/workspace/secret.txt" }, output: "TOOL-STATE-SENTINEL" },
    ...overrides,
  };
}

function expectedLineage(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    parentMessageId: PARENT_ID,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    agent: AGENT,
    attemptId: ATTEMPT_ID,
    variant: VARIANT,
    ...overrides,
  };
}

function response(parts, infoOverrides = {}) {
  return { info: assistantInfo(infoOverrides), parts };
}

function select(parts, { info = {}, expected = {} } = {}) {
  return selectOpencodeExplorerFinalResult(response(parts, info), expectedLineage(expected));
}

function assertClosedFailure(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code, `expected ${code}, got ${result.code}`);
  assert.equal(OPENCODE_RESULT_FAILURE_CODES.includes(result.code), true, result.code);
}

/** Every string reachable in a serialized projection, for disclosure guards. */
function collectStrings(value, sink = []) {
  if (typeof value === "string") sink.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, sink);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, sink);
  return sink;
}

describe("opencode result: deterministic bounded text normalization", () => {
  it("keeps ordinary text, newlines, and tabs intact", () => {
    const text = "Finding one\n\nFinding two\tcited at runtime/index.mjs:12";
    assert.equal(normalizeOpencodeFinalText(text), text);
  });

  it("normalizes every line and paragraph separator to one form", () => {
    // CRLF, a lone CR, and the Unicode line/paragraph separators all become LF.
    assert.equal(
      normalizeOpencodeFinalText("a\r\nb\rc\u2028d\u2029e"),
      "a\nb\nc\nd\ne"
    );
  });

  it("removes ANSI escape sequences without leaving their payload behind", () => {
    assert.equal(normalizeOpencodeFinalText("\u001b[31mred\u001b[0m answer"), "red answer");
    assert.equal(normalizeOpencodeFinalText("\u001b]0;window title\u0007answer"), "answer");
    assert.equal(normalizeOpencodeFinalText("\u001b[2J\u001b[H\u001b[?25lanswer"), "answer");
    assert.equal(normalizeOpencodeFinalText("answer\u001bM"), "answer");
    // A bracket sequence with no escape byte is ordinary text, not an escape.
    assert.equal(normalizeOpencodeFinalText("plain [31m answer"), "plain [31m answer");
  });

  it("strips remaining control, DEL, C1, zero-width, and BiDi characters", () => {
    assert.equal(normalizeOpencodeFinalText("a\u0000b\u0001c\u001fd"), "abcd");
    assert.equal(normalizeOpencodeFinalText("a\u007fb\u0085c\u009fd"), "abcd");
    assert.equal(normalizeOpencodeFinalText("a\u200bb\u200ec\ufeffd\u00ade"), "abcde");
    assert.equal(normalizeOpencodeFinalText("a\u202eb\u2066c\u2069d"), "abcd");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeOpencodeFinalText("\n\n  answer  \n\t\n"), "answer");
  });

  it("is idempotent for every documented rule", () => {
    for (const text of [
      "plain",
      "a\r\nb",
      "\u001b[31mred\u001b[0m",
      "   trim me\u200b  ",
      "a\u0000b\u007fc",
      "\u001b]0;t\u0007x",
      "line\n\nline",
      "a\u2028b",
    ]) {
      const once = normalizeOpencodeFinalText(text);
      assert.equal(normalizeOpencodeFinalText(once), once, JSON.stringify(text));
    }
  });

  it("refuses a non-string input rather than coercing one", () => {
    for (const value of [undefined, null, 7, {}, []]) {
      assert.throws(() => normalizeOpencodeFinalText(value), (error) => error instanceof OpencodeResultError);
    }
  });
});

describe("opencode result: closed vocabularies and bounds", () => {
  it("bounds the final text below the shared durable bound", () => {
    assert.equal(OPENCODE_MAX_FINAL_TEXT_CHARS, 65_536);
    assert.ok(OPENCODE_MAX_FINAL_TEXT_CHARS < MAX_FINAL_MESSAGE_CHARS);
    assert.ok(OPENCODE_MAX_RAW_FINAL_TEXT_CHARS >= OPENCODE_MAX_FINAL_TEXT_CHARS);
    assert.ok(OPENCODE_MAX_RAW_FINAL_TEXT_CHARS <= MAX_FINAL_MESSAGE_CHARS);
    assert.equal(Number.isInteger(OPENCODE_MAX_PARTS), true);
  });

  it("declares exactly the pinned schema's provider error names", () => {
    assert.deepEqual(
      [...OPENCODE_PROVIDER_ERROR_NAMES].sort(),
      [
        "APIError",
        "ContentFilterError",
        "ContextOverflowError",
        "MessageAbortedError",
        "MessageOutputLengthError",
        "ProviderAuthError",
        "StructuredOutputError",
        "UnknownError",
      ]
    );
    // The captured compatibility fixture lists the same variants by type name;
    // `ApiError` is the type whose own `name` field reads `APIError`.
    assert.equal(fixture.sdkTypeShapes.errorVariantNames.length, OPENCODE_PROVIDER_ERROR_NAMES.length);
  });

  it("declares a closed finish-reason vocabulary", () => {
    for (const reason of ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"]) {
      assert.equal(OPENCODE_FINISH_REASONS.includes(reason), true, reason);
    }
  });

  it("declares a closed failure vocabulary", () => {
    for (const code of [
      "malformed_response",
      "assistant_role_mismatch",
      "lineage_mismatch",
      "provider_error",
      "no_final_text",
      "empty_final_text",
      "final_text_too_large",
    ]) {
      assert.equal(OPENCODE_RESULT_FAILURE_CODES.includes(code), true, code);
    }
  });
});

describe("opencode result: selecting the one outer-assistant final text", () => {
  it("projects a single matching final text with closed metadata and lineage", () => {
    const result = select([textPart("The registry is static.\n")]);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "The registry is static.");
    assert.deepEqual(result.lineage, {
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      parentMessageId: PARENT_ID,
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      variant: VARIANT,
      agent: AGENT,
      attemptId: ATTEMPT_ID,
    });
    assert.equal(result.metadata.textPartCount, 1);
    assert.equal(result.metadata.precedingTextPartCount, 0);
    assert.equal(result.metadata.nonTextPartCount, 0);
    assert.equal(result.metadata.finishReason, "stop");
    assert.deepEqual(result.metadata.normalization, {
      ansiSequencesRemoved: 0,
      controlCharactersRemoved: 0,
      trimmed: true,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result.metadata), "utf8") <= MAX_RESULT_METADATA_BYTES);
    assert.equal(Object.isFrozen(result), true);
  });

  it("selects the last text part of a multi-step turn and never concatenates", () => {
    const result = select([
      { id: "prt_step", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "step-start" },
      textPart("Let me look at the registry.", { id: "prt_text_a" }),
      toolPart(),
      textPart("FINAL: the registry is static.", { id: "prt_text_b" }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "FINAL: the registry is static.");
    assert.equal(result.finalMessage.includes("Let me look"), false);
    assert.equal(result.metadata.textPartCount, 2);
    assert.equal(result.metadata.precedingTextPartCount, 1);
    assert.equal(result.metadata.nonTextPartCount, 2);
  });

  it("skips a trailing empty text part and keeps the last nonempty one", () => {
    const result = select([
      textPart("The answer.", { id: "prt_text_a" }),
      textPart("   \n\t ", { id: "prt_text_b" }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "The answer.");
  });

  it("ignores synthetic and ignored text parts, which are not the worker's answer", () => {
    const result = select([
      textPart("real answer", { id: "prt_text_a" }),
      textPart("injected continuation", { id: "prt_text_b", synthetic: true }),
      textPart("ignored draft", { id: "prt_text_c", ignored: true }),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "real answer");
    assert.equal(result.metadata.textPartCount, 1);
  });

  it("normalizes the selected final text and counts what it removed", () => {
    const result = select([textPart("  \u001b[32mAnswer\u001b[0m with\u0007 noise\r\nand a line  ")]);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "Answer with noise\nand a line");
    assert.equal(result.metadata.normalization.ansiSequencesRemoved, 2);
    assert.equal(result.metadata.normalization.controlCharactersRemoved, 1);
    assert.equal(result.metadata.normalization.trimmed, true);
  });

  it("reports no final text when the assistant produced none", () => {
    assertClosedFailure(select([]), "no_final_text");
    assertClosedFailure(select([toolPart()]), "no_final_text");
    assertClosedFailure(
      select([
        { id: "prt_r", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "reasoning", text: "thinking", time: { start: 1 } },
      ]),
      "no_final_text"
    );
    assertClosedFailure(select([textPart("only", { synthetic: true })]), "no_final_text");
  });

  it("reports an empty final text rather than projecting whitespace or stripped noise", () => {
    assertClosedFailure(select([textPart("")]), "empty_final_text");
    assertClosedFailure(select([textPart("   \n\t  ")]), "empty_final_text");
    assertClosedFailure(select([textPart("\u001b[31m\u001b[0m \u200b")]), "empty_final_text");
  });

  it("rejects an oversized final text instead of truncating it", () => {
    // The OpenSpec text is explicit: empty or oversized output is not projected
    // as success. OpenCode hands us a typed assistant part, so an oversized
    // final message is the worker breaking the return contract -- not a
    // transport capture limit to trim.
    const exact = "x".repeat(OPENCODE_MAX_FINAL_TEXT_CHARS);
    const exactResult = select([textPart(exact)]);
    assert.equal(exactResult.ok, true);
    assert.equal(exactResult.finalMessage.length, OPENCODE_MAX_FINAL_TEXT_CHARS);
    const overResult = select([textPart("x".repeat(OPENCODE_MAX_FINAL_TEXT_CHARS + 1))]);
    assertClosedFailure(overResult, "final_text_too_large");
    assert.equal(Object.hasOwn(overResult, "finalMessage"), false);
    // A raw part beyond the raw ceiling is refused before normalization runs.
    assertClosedFailure(
      select([textPart("y".repeat(OPENCODE_MAX_RAW_FINAL_TEXT_CHARS + 1))]),
      "final_text_too_large"
    );
    // An oversized final is never rescued by an earlier, smaller text part.
    assertClosedFailure(
      select([textPart("small answer", { id: "prt_a" }), textPart("z".repeat(OPENCODE_MAX_FINAL_TEXT_CHARS + 1), { id: "prt_b" })]),
      "final_text_too_large"
    );
  });
});

describe("opencode result: lineage must match exactly", () => {
  it("rejects a foreign session, parent, provider, model, or agent", () => {
    const cases = [
      [{ info: { sessionID: "ses_other" } }, "sessionID"],
      [{ info: { parentID: "msg_user_other" } }, "parentID"],
      [{ info: { providerID: "deepseek" } }, "providerID"],
      [{ info: { modelID: "kimi-k2.6" } }, "modelID"],
      [{ info: { agent: "build" } }, "agent"],
      [{ info: { variant: "medium" } }, "variant"],
    ];
    for (const [override, field] of cases) {
      const result = select([textPart("answer")], override);
      assertClosedFailure(result, "lineage_mismatch");
      assert.equal(result.field, field, JSON.stringify(override));
      assert.equal(Object.hasOwn(result, "finalMessage"), false);
    }
  });

  it("rejects a part that belongs to another message or session", () => {
    for (const override of [{ messageID: "msg_assistant_other" }, { sessionID: "ses_other" }]) {
      const result = select([textPart("answer", override)]);
      assertClosedFailure(result, "lineage_mismatch");
    }
    // A non-text part with foreign lineage is a crossover too, not noise to skip.
    const result = select([textPart("answer"), toolPart({ sessionID: "ses_other" })]);
    assertClosedFailure(result, "lineage_mismatch");
  });

  it("rejects a non-assistant or roleless message", () => {
    for (const role of ["user", "system", undefined, 7]) {
      assertClosedFailure(select([textPart("answer")], { info: { role } }), "assistant_role_mismatch");
    }
  });

  it("carries the caller's attempt identity without pretending the payload proved it", () => {
    const result = select([textPart("answer")], { expected: { attemptId: "att_other" } });
    assert.equal(result.ok, true);
    assert.equal(result.lineage.attemptId, "att_other");
  });

  it("refuses an incomplete expected-lineage record as caller misuse", () => {
    for (const field of ["sessionId", "parentMessageId", "providerId", "modelId", "variant"]) {
      const expected = expectedLineage();
      delete expected[field];
      assert.throws(
        () => selectOpencodeExplorerFinalResult(response([textPart("answer")]), expected),
        (error) => error instanceof OpencodeResultError && error.code === "expected_lineage_required",
        field
      );
    }
  });
});

describe("opencode result: provider errors and malformed payloads", () => {
  it("classifies a provider error by its closed name and projects no error data", () => {
    for (const name of OPENCODE_PROVIDER_ERROR_NAMES) {
      const result = select([textPart("partial answer")], {
        info: {
          error: {
            name,
            data: {
              message: "PROVIDER-MESSAGE-SENTINEL",
              responseBody: "RAW-BODY-SENTINEL",
              responseHeaders: { authorization: "Basic SENTINEL" },
              providerID: PROVIDER_ID,
              statusCode: 500,
            },
          },
        },
      });
      assertClosedFailure(result, "provider_error");
      assert.equal(result.providerErrorName, name);
      const serialized = JSON.stringify(result);
      for (const sentinel of ["PROVIDER-MESSAGE-SENTINEL", "RAW-BODY-SENTINEL", "SENTINEL", "authorization", "500"]) {
        assert.equal(serialized.includes(sentinel), false, `${name} leaked ${sentinel}`);
      }
      assert.equal(Object.hasOwn(result, "finalMessage"), false);
    }
  });

  it("reports an unrecognized error shape without echoing it", () => {
    const result = select([textPart("answer")], {
      info: { error: { name: "SomeFutureError", data: { message: "LEAK-SENTINEL" } } },
    });
    assertClosedFailure(result, "provider_error");
    assert.equal(result.providerErrorName, "unrecognized");
    assert.equal(JSON.stringify(result).includes("LEAK-SENTINEL"), false);
    assert.equal(JSON.stringify(result).includes("SomeFutureError"), false);
  });

  it("closes an unrecognized finish reason instead of echoing an arbitrary string", () => {
    const result = select([textPart("answer")], { info: { finish: "some-future-reason" } });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.finishReason, "unrecognized");
    const absent = select([textPart("answer")], { info: { finish: undefined } });
    assert.equal(absent.metadata.finishReason, null);
  });

  it("rejects a malformed response envelope", () => {
    for (const payload of [
      null,
      "text",
      [],
      {},
      { info: null, parts: [] },
      { info: assistantInfo(), parts: null },
      { info: assistantInfo(), parts: "not-an-array" },
      { info: assistantInfo() },
      new Proxy({ info: assistantInfo(), parts: [textPart("answer")] }, {}),
    ]) {
      const result = selectOpencodeExplorerFinalResult(payload, expectedLineage());
      assertClosedFailure(result, "malformed_response");
    }
  });

  it("rejects a malformed message identity or part shape", () => {
    assertClosedFailure(select([textPart("answer")], { info: { id: "" } }), "malformed_response");
    assertClosedFailure(select([textPart("answer")], { info: { id: 7 } }), "malformed_response");
    for (const part of [
      null,
      "text-part",
      [],
      { sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "text", text: 7 },
      { sessionID: SESSION_ID, messageID: MESSAGE_ID, type: 7, text: "answer" },
      new Proxy(textPart("answer"), {}),
    ]) {
      assertClosedFailure(select([part]), "malformed_response");
    }
    assertClosedFailure(
      select(Array.from({ length: OPENCODE_MAX_PARTS + 1 }, (unused, index) => textPart("answer", { id: `p${index}` }))),
      "malformed_response"
    );
  });

  it("refuses an exotic message or part that could answer two readers differently", () => {
    // The message's session id is compared against the expected lineage and
    // against every part, so an accessor there would otherwise have two
    // chances to answer differently.
    const trapInfo = { ...assistantInfo() };
    delete trapInfo.sessionID;
    Object.defineProperty(trapInfo, "sessionID", { get: () => SESSION_ID, enumerable: true });
    assertClosedFailure(
      selectOpencodeExplorerFinalResult({ info: trapInfo, parts: [textPart("answer")] }, expectedLineage()),
      "malformed_response"
    );
    const trapPart = { ...textPart("answer") };
    delete trapPart.text;
    Object.defineProperty(trapPart, "text", { get: () => "answer", enumerable: true });
    assertClosedFailure(select([trapPart]), "malformed_response");
    assertClosedFailure(
      selectOpencodeExplorerFinalResult(
        { info: Object.assign(Object.create({ role: "assistant" }), assistantInfo()), parts: [] },
        expectedLineage()
      ),
      "malformed_response"
    );
  });

  it("never treats a binary, structured, or tool-shaped part as the final text", () => {
    const parts = [
      { id: "prt_f", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "file", mime: "image/png", url: "data:image/png;base64,FILE-SENTINEL" },
      { id: "prt_p", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "patch", hash: "abc", files: ["/opt/operator-owned/workspace/a.ts"] },
      { id: "prt_s", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "snapshot", snapshot: "SNAPSHOT-SENTINEL" },
      { id: "prt_sub", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "subtask", prompt: "SUBTASK-SENTINEL", description: "d", agent: "general" },
      toolPart(),
      { id: "prt_sf", sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "step-finish", reason: "stop", cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    ];
    assertClosedFailure(select(parts), "no_final_text");
    const withFinal = select([...parts, textPart("the real answer")]);
    assert.equal(withFinal.ok, true);
    assert.equal(withFinal.finalMessage, "the real answer");
    const serialized = JSON.stringify(withFinal);
    for (const sentinel of ["FILE-SENTINEL", "SNAPSHOT-SENTINEL", "SUBTASK-SENTINEL", "TOOL-STATE-SENTINEL", "a.ts"]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
  });

  it("projects no operator path, token count, cost, or structured payload", () => {
    const result = select([textPart("answer")], {
      info: { structured: { leaked: "STRUCTURED-SENTINEL" } },
    });
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result);
    for (const sentinel of [OPERATOR_CWD, OPERATOR_ROOT, "STRUCTURED-SENTINEL"]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
    for (const text of collectStrings(result)) {
      assert.equal(text.startsWith("/"), false, `projected an absolute path: ${text}`);
    }
    // Metrics are exact provider facts on their own field (Task 6); the text
    // metadata still carries none of them, and `tokens.total` is never carried.
    assert.equal(Object.hasOwn(result.metadata, "tokens"), false);
    assert.equal(Object.hasOwn(result.metadata, "cost"), false);
    assert.equal(Object.hasOwn(result.providerMetrics, "total"), false);
    assert.equal(serialized.includes("1234"), false, "tokens.total is not a carried fact");
    assert.equal(result.finalMessage.includes("0.0021"), false);
  });

  it("keeps the projection free of native tool history for a long realistic turn", () => {
    const parts = [];
    for (let step = 0; step < 12; step += 1) {
      parts.push({ id: `prt_ss_${step}`, sessionID: SESSION_ID, messageID: MESSAGE_ID, type: "step-start" });
      parts.push(toolPart({ id: `prt_tool_${step}`, tool: "grep" }));
      parts.push(textPart(`step ${step} note`, { id: `prt_note_${step}` }));
    }
    parts.push(textPart("FINAL ANSWER", { id: "prt_final" }));
    const result = select(parts);
    assert.equal(result.ok, true);
    assert.equal(result.finalMessage, "FINAL ANSWER");
    assert.equal(result.metadata.textPartCount, 13);
    assert.equal(result.metadata.precedingTextPartCount, 12);
    assert.equal(result.metadata.nonTextPartCount, 24);
    assert.equal(JSON.stringify(result).includes("grep"), false);
    assert.equal(JSON.stringify(result).includes("step 0 note"), false);
  });
});
