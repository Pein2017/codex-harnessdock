---
name: spawn-agent
description: 'Experimental: start a durable Agent asynchronously on one fully stated route (harness, model, topology, write).'
---

# Spawn Agent

> **Experimental.** The Agent runs in the background and cannot reactivate an
> ended Codex turn; the caller owns joining any evidence it needs.

Call `mcp__codex_harnessdock__spawn_agent` with `task_name`, a self-contained
`message`, and the whole route: `harness`, `model`, `topology`, `write`.
Optional: `description` and `reasoning_effort` where admitted.
There is no default Harness, model, topology, or authority. Trusted Codex
metadata owns cwd/root; never pass environment, session, or fork selectors. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

## Routes

`$codex-harnessdock:list-harnesses` reports what is ready; use full model IDs.

`claude-code`: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`,
`claude-fable-5`; `leaf` or `native_orchestrator`; either authority; separate
effort `low`, `medium`, `high`, `xhigh`, or `max`. Map “x-high” to `xhigh`.

`opencode`: exact `opencode-go/deepseek-v4-flash`,
`opencode-go/deepseek-v4-pro`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`,
or `openai/gpt-5.6-sol`; `leaf`, `write: false`; no reasoning effort or
HarnessDock capacity ceiling; `fresh_only`; interruption/history unsupported.
No `-fast` variants.

Never infer a model from an Agent label such as Ops5, use partial IDs, or
substitute another model after rejection. Ask when no model family was selected.
A refused route is reported as refused; the Plugin never retries elsewhere.

If a real CC test reports subscription, usage, periodic allowance, credit, or
quota exhaustion, stop further real Claude tests in that workflow. Do not
retry/fallback; local edits and fake/unit/integration tests may continue. A
generic transient 429 may follow bounded reconnect and is not this stop rule.

## Authority and topology

`write: false` is behavioral read/review-only authority; `write: true` permits
task-scoped mutation. It is frozen at creation and is not an OS-level
process-permission switch or CLI permission flag. Enforcement is route-specific
and observable: Claude is prompt-level under fixed config, `IS_SANDBOX=1`,
terminal parity, and `--dangerously-skip-permissions`; the Explorer is
Harness-policy tool denial. Never omit `write`.

Names are unique flat `/root/<task_name>` paths. Never adopt a Terminal Claude
session; the message must stand alone. There is no message path between Agents
on different Harnesses.

`leaf` runs the task itself and disables native `Agent` and `Workflow`. Use
`native_orchestrator` only with exact Opus or Fable: it is an
experimental Native Agent Team lead, not a Plugin-owned child lifecycle. A
named member must launch asynchronously and a correlated `SendMessage` to that
current-team name must succeed before transport is live-validated; a synchronous result or failed
message is rejected. Haiku and Sonnet cannot lead.

The lead selects only definition-owned `haiku-scout`, `sonnet`, or `opus`
teammates: requested models stay pinned by the definitions, while effective teammate model,
effort, and cost are unknown without native facts. State intended effort;
absent a teammate effort fact, only inherited lead effort is known. A read-only lead may still maintain local native-memory under
`.claude/agent-memory-local/<member-type>/`. At most three active teammates and
six creations: these native limits are behavioral, not containment. Same-team
`SendMessage` stays in the current team by prompt; no nested delegation, fork,
or completed-peer resume. Transport never auto-reconnects: an explicit follow-up
forms a fresh native team under the durable parent, which alone enters the
registry; `Workflow` remains disabled.

On success, report one sentence from `model`, role, `agent_name`, authority, and
`status`; no final Claude text, JSON, or internal IDs. Use operator diagnostics
for deeper evidence and preserve actionable failure/recovery detail. For
non-null `blocking`, branch on `retry`: `same_agent_followup` continues this
Agent, `new_agent` identifies a new lane, `operator_required` stops further
spawning.
