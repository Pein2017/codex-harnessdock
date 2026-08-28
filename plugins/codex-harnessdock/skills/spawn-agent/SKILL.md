---
name: spawn-agent
description: 'Experimental: start a durable Agent asynchronously on one fully stated route (harness, model, topology, write, reasoning_effort).'
---

# Spawn Agent

> **Experimental.** The Agent runs asynchronously; the caller joins needed evidence.

Call `mcp__codex_harnessdock__spawn_agent` with `task_name`, a self-contained
`message`, and the whole route: `harness`, `model`, `topology`, `write`, and
`reasoning_effort` (required for every route, freshly validated by the Driver).
Optional: `description`.
There is no default Harness, model, topology, authority, or effort. Trusted Codex
metadata owns cwd/root; never pass environment, session, or fork selectors. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

## Routes

`$codex-harnessdock:list-harnesses` reports what is ready from fresh native
discovery; use full model IDs.

`claude-code`: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`,
`claude-fable-5`; `leaf` or `native_orchestrator`; either authority; separate
effort `low`, `medium`, `high`, `xhigh`, or `max`.

`pi`: provider `openai-codex` only; exact `openai-codex/gpt-5.6-luna`,
`openai-codex/gpt-5.6-terra`, or `openai-codex/gpt-5.6-sol`; `leaf`; either
authority. Every new turn requires `low`, `medium`, `high`, `xhigh`, or `max`.
No global capacity ceiling; one exact native session is serialized; exact
resume only; active input is acknowledged; automatic recovery is absent;
native orchestration is disabled.

`opencode`: exact `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, or
`openai/gpt-5.6-sol`; `leaf`; `write: false` or `write: true` (prompt/receipt
only); every turn requires an explicit `low`–`max` effort mapped to one
advertised Server variant, never inferred; no HarnessDock capacity ceiling;
`fresh_only`; interruption/history unsupported. No `-fast` variants.

Never infer a model from an Agent label such as Ops5, use partial IDs, or
substitute another model after rejection. Ask when no model family was selected.

If a real CC test reports subscription, usage, periodic allowance, credit, or
quota exhaustion, stop further real Claude tests in that workflow; do not
retry or fall back. A generic transient 429 may follow bounded reconnect and is
not this stop rule.

## Authority and topology

`write: false` is behavioral read/review-only authority; `write: true` permits
task-scoped mutation. Pi `write: false` allows only `read`, `grep`, `find`, and
`ls`; Pi `write: true` also allows `bash`, `edit`, and `write`. Authority is
frozen at creation and is not an OS-level
process-permission or CLI flag. Enforcement is route-specific
and observable: Claude is prompt-level under fixed config, `IS_SANDBOX=1`,
terminal parity, and `--dangerously-skip-permissions`; Pi and OpenCode are
prompt/receipt only, inheriting native tools, plugins, MCP, and config unchanged
and never enumerated. Never omit `write`.

Names are unique flat `/root/<task_name>` paths; the message must stand alone.
No cross-Harness message path.

`leaf` runs the task itself. Claude disables native `Agent` and `Workflow`; Pi
has no native orchestration. Use
`native_orchestrator` only with exact Opus or Fable: it is an
experimental Native Agent Team lead. A
named member must launch asynchronously and a correlated `SendMessage` to that
current-team name must succeed before transport is live-validated; a synchronous
result or failed message is rejected.

The lead selects only definition-owned `haiku-scout`, `sonnet`, or `opus`
teammates: requested models stay pinned by the definitions, while effective teammate model,
effort, and cost are unknown without native facts. State intended effort;
absent a teammate effort fact, only inherited lead effort is known. A read-only
lead may still maintain local native-memory. At most three active teammates and
six creations: these native limits are behavioral, not containment. Same-team
`SendMessage` stays in the current team by prompt.
Transport never auto-reconnects: an explicit follow-up forms a fresh native team; `Workflow` remains disabled.

On success, report one sentence from `model`, role, `agent_name`, authority, and
`status`; no final Claude text, JSON, or internal IDs. Use operator diagnostics
for deeper evidence and preserve actionable failure/recovery detail. On non-null
`blocking`, branch on `retry` (`same_agent_followup`, `new_agent`, or
`operator_required`).
