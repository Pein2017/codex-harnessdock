import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import {
  readBoundClaudeAgentMessages,
  resolveBoundClaudeTranscript,
} from "../../runtime/claude-session-history.mjs";
import {
  appendCompletionEvent,
  resolveCompletionInboxFile,
} from "../../runtime/completion-inbox.mjs";

import { versionThreeRoute } from "./fixtures/version-three-state.mjs";

const roots = [];
const sharedHarness = fs.mkdtempSync(path.join(os.tmpdir(), "cc-history-runtime-"));
const sharedRuntimeHome = path.join(sharedHarness, "runtime-home");
const sharedCodexHome = path.join(sharedHarness, ".codex");
fs.mkdirSync(sharedCodexHome);

after(() => fs.rmSync(sharedHarness, { recursive: true, force: true }));

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function encodedWorkspace(workspace) {
  return workspace.replace(/[^a-zA-Z0-9]/g, "-");
}

function record({ uuid, text, sessionId, timestamp, ...overrides }) {
  return {
    type: "assistant",
    uuid,
    sessionId,
    timestamp,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    ...overrides,
  };
}

function setup(label = "history") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-${label}-`));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const claudeConfigDir = path.join(root, ".claude");
  const projects = path.join(claudeConfigDir, "projects");
  const project = path.join(projects, encodedWorkspace(workspace));
  const runtimeHome = sharedRuntimeHome;
  const envFile = path.join(root, "runtime.env");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  fs.mkdirSync(workspace);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
  const ownerRootId = `root-${label}`;
  const runtime = createAgentRuntime({
    cwd: workspace,
    envFile,
    env: {
      CODEX_THREAD_ID: ownerRootId,
      CODEX_HOME: sharedCodexHome,
      CODEX_HARNESSDOCK_RUNTIME_HOME: runtimeHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  });
  const agent = runtime.store.createAgent({ task_name: `${label}_agent` });
  runtime.store.updateAgent(agent.agentId, (current) => ({
    ...current,
    status: "completed",
    nativeSessionRef: {
      harnessId: "claude-code",
      instanceKey: claudeConfigDir,
      nativeSessionId: sessionId,
    },
    continuation: { mode: "exact_session", evidence: { reason: "test_session" } },
  }));
  const transcript = path.join(project, `${sessionId}.jsonl`);
  return {
    root,
    workspace,
    claudeConfigDir,
    projects,
    runtimeHome,
    runtime,
    agent,
    ownerRootId,
    sessionId,
    transcript,
  };
}

function writeTranscript(filePath, records) {
  fs.writeFileSync(filePath, `${records.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

describe("native Claude Agent message history", () => {
  it("returns complete outer-assistant text newest first and filters private records", async () => {
    const fixture = setup("filtering");
    const huge = `${"界".repeat(24_000)}${"🙂".repeat(3_000)}-tail`;
    assert.ok(Buffer.byteLength(huge, "utf8") > 64 * 1024);
    writeTranscript(fixture.transcript, [
      { type: "user", sessionId: fixture.sessionId, message: { role: "user", content: "prompt" } },
      record({ uuid: "m1", text: "oldest", sessionId: fixture.sessionId, timestamp: "2026-07-01T00:00:00.000Z" }),
      record({
        uuid: "thinking",
        text: "must-not-leak-thinking",
        sessionId: fixture.sessionId,
        timestamp: "2026-07-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] },
      }),
      record({
        uuid: "mixed",
        text: "visible-only",
        sessionId: fixture.sessionId,
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "visible" },
            { type: "tool_use", name: "Bash", input: { command: "secret" } },
            { type: "text", text: "-only" },
          ],
        },
      }),
      record({
        uuid: "sidechain",
        text: "must-not-leak-sidechain",
        sessionId: fixture.sessionId,
        timestamp: "2026-07-01T00:00:03.000Z",
        isSidechain: true,
      }),
      record({ uuid: "m3", text: huge, sessionId: fixture.sessionId, timestamp: "2026-07-01T00:00:04.000Z" }),
    ]);
    appendCompletionEvent(fixture.workspace, fixture.ownerRootId, {
      jobId: "history-observation-job",
      agentId: fixture.agent.agentId,
      terminalStatus: "completed",
      completedAt: "2026-07-01T00:00:05.000Z",
      summary: "history observation completion",
      finalMessage: "completion must remain unread",
      resumability: { classification: "resumable", claudeSessionId: fixture.sessionId },
      detailedResultAvailable: true,
    });

    const before = JSON.stringify(fixture.runtime.store.readAgent(fixture.agent.agentId));
    const inboxFile = resolveCompletionInboxFile(fixture.workspace, fixture.ownerRootId);
    const inboxBefore = fs.readFileSync(inboxFile, "utf8");
    const latest = await fixture.runtime.readAgentMessages({ target: fixture.agent.path });
    assert.equal(latest.agent_name, fixture.agent.path);
    assert.deepEqual(latest.messages, [{
      message_id: "m3",
      timestamp: "2026-07-01T00:00:04.000Z",
      text: huge,
    }]);
    assert.equal(latest.next_before, "m3");
    assert.equal(JSON.stringify(fixture.runtime.store.readAgent(fixture.agent.agentId)), before);

    const page = await fixture.runtime.readAgentMessages({ target: fixture.agent.agentId, limit: 2 });
    assert.deepEqual(page.messages.map((message) => [message.message_id, message.text]), [
      ["m3", huge],
      ["mixed", "visible-only"],
    ]);
    assert.equal(page.next_before, "mixed");

    const older = await fixture.runtime.readAgentMessages({
      target: fixture.agent.name,
      before: page.next_before,
      limit: 2,
    });
    assert.deepEqual(older.messages.map((message) => message.message_id), ["m1"]);
    assert.equal(older.next_before, null);
    assert.equal(JSON.stringify(older).includes("secret"), false);
    assert.equal(JSON.stringify(older).includes("sidechain"), false);
    assert.equal(fs.readFileSync(inboxFile, "utf8"), inboxBefore);
  });

  it("rejects unavailable, ambiguous, escaped, malformed, and invalid-cursor history", async () => {
    const missing = setup("missing");
    await assert.rejects(
      missing.runtime.readAgentMessages({ target: missing.agent.agentId }),
      /history is unavailable/,
    );

    const ambiguous = setup("ambiguous");
    writeTranscript(ambiguous.transcript, [
      record({ uuid: "m1", text: "one", sessionId: ambiguous.sessionId, timestamp: "2026-07-01T00:00:00.000Z" }),
    ]);
    const duplicateDir = path.join(ambiguous.projects, "-duplicate-project");
    fs.mkdirSync(duplicateDir);
    fs.copyFileSync(ambiguous.transcript, path.join(duplicateDir, `${ambiguous.sessionId}.jsonl`));
    assert.throws(
      () => resolveBoundClaudeTranscript(ambiguous.runtime.store.readAgent(ambiguous.agent.agentId)),
      /history is ambiguous/,
    );

    const malformed = setup("malformed");
    fs.writeFileSync(malformed.transcript, "{not-json}\n");
    await assert.rejects(
      malformed.runtime.readAgentMessages({ target: malformed.agent.agentId }),
      /malformed JSONL/,
    );

    const cursor = setup("cursor");
    writeTranscript(cursor.transcript, [
      record({ uuid: "m1", text: "one", sessionId: cursor.sessionId, timestamp: "2026-07-01T00:00:00.000Z" }),
    ]);
    await assert.rejects(
      cursor.runtime.readAgentMessages({ target: cursor.agent.agentId, before: "foreign" }),
      /before cursor is not an eligible message/,
    );
    await assert.rejects(
      cursor.runtime.readAgentMessages({ target: cursor.agent.agentId, limit: 21 }),
      /limit must be between 1 and 20/,
    );
    await assert.rejects(
      cursor.runtime.readAgentMessages({ target: cursor.agent.agentId, session_id: cursor.sessionId }),
      /does not support session_id/,
    );
    await assert.rejects(
      cursor.runtime.readAgentMessages({ target: cursor.agent.agentId, transcript_path: cursor.transcript }),
      /does not support transcript_path/,
    );
    await assert.rejects(
      cursor.runtime.readAgentMessages({ target: cursor.agent.agentId, owner_root_id: "foreign" }),
      /does not support owner_root_id/,
    );

    const trailingPartial = setup("trailing_partial");
    fs.writeFileSync(
      trailingPartial.transcript,
      `${JSON.stringify(record({
        uuid: "m1",
        text: "complete-before-partial-tail",
        sessionId: trailingPartial.sessionId,
        timestamp: "2026-07-01T00:00:00.000Z",
      }))}\n{\"type\":\"assistant\"`,
      "utf8",
    );
    assert.deepEqual(
      (await trailingPartial.runtime.readAgentMessages({ target: trailingPartial.agent.agentId })).messages,
      [{
        message_id: "m1",
        timestamp: "2026-07-01T00:00:00.000Z",
        text: "complete-before-partial-tail",
      }],
    );

    const escaped = setup("escaped");
    const outside = path.join(escaped.root, `${escaped.sessionId}.jsonl`);
    writeTranscript(outside, [
      record({ uuid: "m1", text: "outside", sessionId: escaped.sessionId, timestamp: "2026-07-01T00:00:00.000Z" }),
    ]);
    fs.symlinkSync(outside, escaped.transcript);
    assert.throws(
      () => readBoundClaudeAgentMessages(escaped.runtime.store.readAgent(escaped.agent.agentId)),
      /not a top-level project session artifact/,
    );
  });

  it("enforces current-root Agent targeting", async () => {
    const fixture = setup("root_a");
    writeTranscript(fixture.transcript, [
      record({ uuid: "m1", text: "owned", sessionId: fixture.sessionId, timestamp: "2026-07-01T00:00:00.000Z" }),
    ]);
    const foreign = createAgentRuntime({
      cwd: fixture.workspace,
      env: {
        CODEX_THREAD_ID: "root-b",
        CODEX_HOME: sharedCodexHome,
        CODEX_HARNESSDOCK_RUNTIME_HOME: fixture.runtimeHome,
        CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      },
    });
    await assert.rejects(
      foreign.readAgentMessages({ target: fixture.agent.agentId }),
      /No Agent with that exact ID, path, or name exists in this root/,
    );
  });
});

describe("native Claude history is legacy-only", () => {
  it("refuses a version-three Agent on a foreign Harness instead of guessing a Claude transcript", () => {
    // Native Claude history is proven by the ROUTE, not by record age: the
    // public generation writes version-three records for Claude Agents too, so
    // the question this refusal answers is which Harness the route names.
    const fixture = setup("version_three");
    const future = {
      ...fixture.agent,
      version: 3,
      route: versionThreeRoute(),
      claudeSessionId: null,
      claudeConfigDir: null,
    };
    assert.throws(
      () => resolveBoundClaudeTranscript(future),
      /bound to Harness fake-service; native Claude history is unavailable/,
    );
    assert.throws(
      () => readBoundClaudeAgentMessages(future),
      /bound to Harness fake-service; native Claude history is unavailable/,
    );
  });

  it("refuses a version-two Agent bound to another Harness", () => {
    const fixture = setup("foreign_harness");
    const foreign = {
      ...fixture.agent,
      version: 2,
      harnessId: "fake-service",
      nativeSessionRef: {
        harnessId: "fake-service",
        instanceKey: "tenant-alpha",
        nativeSessionId: "native-session-1",
      },
      claudeSessionId: null,
      claudeConfigDir: null,
    };
    assert.throws(
      () => resolveBoundClaudeTranscript(foreign),
      /Harness fake-service|not bound to Claude Code/,
    );
    assert.throws(
      () => readBoundClaudeAgentMessages(foreign),
      /Harness fake-service|not bound to Claude Code/,
    );
  });

  it("reads history from the adapter-resolved binding, not a projected field", () => {
    const fixture = setup("adapter_binding");
    writeTranscript(fixture.transcript, [
      record({
        uuid: "adapter-1",
        text: "from the bound session",
        sessionId: fixture.sessionId,
        timestamp: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    // The durable record carries only the neutral reference; the Claude
    // compatibility projection is absent.
    const durable = {
      ...fixture.agent,
      version: 2,
      harnessId: "claude-code",
      nativeSessionRef: {
        harnessId: "claude-code",
        instanceKey: fixture.claudeConfigDir,
        nativeSessionId: fixture.sessionId,
      },
      claudeSessionId: null,
      claudeConfigDir: null,
    };
    assert.equal(resolveBoundClaudeTranscript(durable), fs.realpathSync.native(fixture.transcript));
    assert.deepEqual(
      readBoundClaudeAgentMessages(durable).messages.map((message) => message.text),
      ["from the bound session"],
    );
  });
});
