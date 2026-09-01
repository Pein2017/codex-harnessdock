import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { projectNativeRouteDiscovery } from "../../runtime/release-smoke.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const skillRoot = path.join(root, "plugins", "codex-harnessdock", "skills");

const skills = [
  "followup-task",
  "interrupt-agent",
  "list-agents",
  "list-harnesses",
  "read-agent-messages",
  "send-message",
  "spawn-agent",
  "wait-agent",
];

const readSkill = (name) => fs.readFileSync(path.join(skillRoot, name, "SKILL.md"), "utf8");
const readMetadata = (name) => fs.readFileSync(path.join(skillRoot, name, "agents/openai.yaml"), "utf8");

describe("HarnessDock Skill guidance neutrality", () => {
  it("keeps checked-in guidance unchanged while the release listing projection changes", () => {
    const guidance = skills.flatMap((name) => [readSkill(name), readMetadata(name)]);
    const bytes = guidance.map((text) => Buffer.from(text));
    const record = (model, effort) => [{
      harness: "fake", instance: "redacted", readiness: "ready", live_validated: true,
      maturity: "experimental", model_groups: [{ models: [model], efforts: [effort] }],
      configurationIdentity: "secret-catalog-origin",
    }];
    const first = projectNativeRouteDiscovery(record("fake/provider-a", "opaque-effort-a"));
    const second = projectNativeRouteDiscovery(record("fake/provider-b", "opaque-effort-b"));
    assert.notDeepEqual(first, second);
    assert.equal(JSON.stringify(second).includes("secret-catalog-origin"), false);
    assert.deepEqual(guidance.map((text) => Buffer.from(text)), bytes);
    assert.equal(guidance.join("\n").includes("fake/provider-b"), false);
  });

  it("does not prescribe scheduler policy or a global team shape", () => {
    const forbiddenPolicy = [
      /Parent join policy/i,
      /classify the result as `required`/i,
      /`parallel-then-join`/i,
      /`explicitly-detached`/i,
      /\b(?:fan[- ]out|fanout)\b/i,
      /delegation thresholds?/i,
      /automatic route ranking/i,
      /worker conflict resolution/i,
      /conflict policy/i,
      /cheapest\/fastest/i,
      /preferred for real smoke/i,
      /highest capability\/spend/i,
      /Approximate guidance, not exact pricing/i,
      /\bHaiku < Sonnet < Opus < Fable\b/i,
      /\bleaf by default\b/i,
      /\brequired join\b/i,
      /\bcritical path\b/i,
      /completion-first/i,
    ];

    for (const name of skills) {
      for (const [surface, text] of [["SKILL.md", readSkill(name)], ["agents/openai.yaml", readMetadata(name)]]) {
        for (const pattern of forbiddenPolicy) {
          assert.doesNotMatch(text, pattern, `${name}/${surface} retains scheduler policy: ${pattern}`);
        }
      }
    }
  });

  it("retains common operation routing, ownership, and safety mechanics", () => {
    const operations = {
      "followup-task": "followup_task",
      "interrupt-agent": "interrupt_agent",
      "list-agents": "list_agents",
      "list-harnesses": "list_harnesses",
      "read-agent-messages": "read_agent_messages",
      "send-message": "send_message",
      "spawn-agent": "spawn_agent",
      "wait-agent": "wait_agent",
    };

    for (const [name, operation] of Object.entries(operations)) {
      const text = readSkill(name);
      assert.match(text, new RegExp(`mcp__codex_harnessdock__${operation}`), name);
      assert.match(text, /Trusted Codex\s+metadata owns cwd\/root/i, name);
      assert.match(text, /report\s+Plugin\s+startup or\s+discovery failure/i, name);
      assert.match(text, /never use[\s\S]*shell/i, name);
      assert.match(text, /exact retained Skill path/i, name);
      assert.match(text, /HARNESSDOCK_MCP_RESTART_REQUIRED[\s\S]*new Codex task/i, name);
      assert.match(text, /Never repair Plugin Cache/i, name);
      assert.match(text, /Experimental/i, name);
    }
  });

  it("keeps operation-local targeting, acknowledgement, blocking, and safety facts", () => {
    const followup = readSkill("followup-task");
    assert.match(followup, /exact current-root `target` and\s+`message`/i);
    // The route and its authority are frozen at creation, not restated here.
    assert.match(followup, /frozen at creation and inherited unchanged/i);
    assert.match(followup, /accepts no `write`,[\s\S]*`harness`,[\s\S]*`topology`/i);
    assert.match(followup, /a different route means a new Agent/i);
    assert.match(followup, /`activation_pending`[\s\S]*do not resend/i);
    assert.match(followup, /blocked Agent rejects with a closed `reason`\/`scope`\/`retry`/i);
    assert.match(followup, /auth_required[\s\S]*safe-fresh\s+recover/i);
    assert.match(followup, /one sentence from `agent_name` and `delivery`/i);

    const interrupt = readSkill("interrupt-agent");
    assert.match(interrupt, /exact current-root `target`/i);
    assert.match(interrupt, /ends only the current turn[\s\S]*never deletes the[\s\S]*Agent/i);
    assert.match(interrupt, /graceful\s+interrupt request may be accepted, rejected, or left pending/i);
    assert.match(interrupt, /`status`[\s\S]*`interrupted`,\s*`still_working`,[\s\S]*`failed`,[\s\S]*`settlement_unknown`/i);
    assert.match(interrupt, /`still_working`[\s\S]*never\s+a\s+forced\s+termination/i);
    assert.match(interrupt, /Pi request is nonterminal[\s\S]*wait for settlement/i);
    assert.match(interrupt, /Exact-session\s+continuation needs safe-flush evidence/i);
    assert.doesNotMatch(interrupt, /force-terminat/i);
    assert.match(interrupt, /one concise sentence from `agent_name` and\s+`status`/i);

    const list = readSkill("list-agents");
    assert.match(list, /list_agents` with no fields[\s\S]*optional `path_prefix`/i);
    assert.match(list, /state snapshot/i);
    assert.match(list, /starting`, `working`,\s+`completed`, `failed`, or `interrupted`/i);
    assert.match(list, /completion comes from\s+`\$codex-harnessdock:wait-agent`/i);
    assert.match(list, /never call this\s+solely to recheck completion after a quiet `wait_agent` timeout/i);

    const harnesses = readSkill("list-harnesses");
    assert.match(harnesses, /accepts no fields/i);
    assert.match(harnesses, /`readiness`[\s\S]*`liveValidated`/);
    assert.match(harnesses, /never orders Harnesses by fitness, selects one, or implies a default/i);
    assert.match(harnesses, /operator fact, not model-quality evidence/i);

    const history = readSkill("read-agent-messages");
    assert.match(history, /exact current-root `target`[\s\S]*optional `before`\/`limit`/i);
    assert.match(history, /cannot reactivate Codex/i);
    assert.match(history, /extend native retention/i);
    assert.match(history, /latest outer-assistant text, newest first/i);
    assert.match(history, /Thinking, tools, attachments, child transcripts, and Codex history\s+are excluded/i);
    assert.match(history, /Current completion comes from[\s\S]*wait-agent/i);
    assert.match(history, /`unsupported`[\s\S]*no messages/i);

    const send = readSkill("send-message");
    assert.match(send, /exact current-root `target` and\s+`message`/i);
    assert.match(send, /Queueing never activates an idle Agent or Codex/i);
    assert.match(send, /blocked Agent rejects with closed `reason`\/`scope`\/`retry`/i);
    assert.match(send, /`dispatched_active`[\s\S]*`activation_pending`[\s\S]*`queued_no_turn`/i);
    assert.match(send, /`activation_pending` is durably accepted[\s\S]*do not duplicate/i);
    assert.match(send, /never a native teammate or another Harness/i);

    const spawn = readSkill("spawn-agent");
    assert.match(spawn, /with `task_name`, self-contained\s+`message`, and `harness`, `model`, `topology`, `write`/i);
    assert.match(spawn, /`harness`, `model`, `topology`, `write`/);
    assert.doesNotMatch(spawn, /delegation_mode/);
    assert.match(spawn, /never pass\s+environment, session, or fork selectors/i);
    assert.match(spawn, /list-harnesses[\s\S]*current inventory[\s\S]*all route fields[\s\S]*mandatory/i);
    assert.match(spawn, /exact admitted[\s\S]*`reasoning_effort` values/i);
    for (const staleRoster of [
      "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5",
      "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol",
      "openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol",
      "`low`, `medium`, `high`, `xhigh`, or `max`",
    ]) assert.doesNotMatch(spawn, new RegExp(staleRoster.replaceAll("/", "\\/"), "i"));
    assert.doesNotMatch(spawn, /Pi `write: false` allows only|Pi `write: true` also allows/i);
    assert.doesNotMatch(spawn, /deepseek|opencode-go/i);
    assert.match(spawn, /`write: false` is behavioral read\/review-only[\s\S]*`write: true`/i);
    assert.match(spawn, /`IS_SANDBOX=1`[\s\S]*`--dangerously-skip-permissions`/i);
    assert.match(spawn, /`native_orchestrator` only when fresh listing admits it/i);
    assert.match(spawn, /named member must launch asynchronously and a correlated `SendMessage`/i);
    assert.match(spawn, /Transport never auto-reconnects/i);
    assert.match(spawn, /`Workflow` remains disabled/i);
    assert.match(spawn, /(?:subscription|usage)[\s\S]*(?:quota|credit)[\s\S]*exhaustion[\s\S]*stop further\s+real Claude tests/i);

    const wait = readSkill("wait-agent");
    const waitMetadata = readMetadata("wait-agent");
    assert.match(wait, /optional `wake_on_progress`,\s+`acknowledge_tokens`, or `targets`/i);
    assert.match(wait, /One to\s+eight unique exact current-root targets/i);
    assert.match(wait, /multiple\s+targets form one completion-only all-settled barrier/i);
    assert.match(wait, /wake_on_progress: true[\s\S]*exactly one target/i);
    assert.match(wait, /Completion has priority[\s\S]*completion_message[\s\S]*token/i);
    assert.match(wait, /it returns at most one sanitized newer meaningful revision/i);
    assert.match(wait, /do not poll reflexively/i);
    assert.match(wait, /timeout means no eligible completion was visible/i);
    assert.match(wait, /Wait cannot reactivate an ended Codex turn/i);
    assert.match(waitMetadata, /mcp__codex_harnessdock__wait_agent/i);
    assert.match(waitMetadata, /one to eight exact targets[\s\S]*all-settled barrier/i);
    assert.match(waitMetadata, /one-hour completion bound/i);
    assert.match(waitMetadata, /wake_on_progress[\s\S]*exactly one target/i);
    assert.match(waitMetadata, /two or more targets[\s\S]*completion-only barrier/i);
    assert.doesNotMatch(waitMetadata, /Never combine targets with wake_on_progress/i);
    assert.match(waitMetadata, /wake_on_progress[\s\S]*one intentional intermediate observation/i);
    assert.match(waitMetadata, /quiet timeout[\s\S]*call wait_agent again directly/i);
  });
});
