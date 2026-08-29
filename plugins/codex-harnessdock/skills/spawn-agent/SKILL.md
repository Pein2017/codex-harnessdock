---
name: spawn-agent
description: 'Experimental: start an async durable Agent on one explicit route (harness, model, topology, write, reasoning_effort).'
---

# Spawn Agent

Call `mcp__codex_harnessdock__spawn_agent` with `task_name`, self-contained
`message`, and `harness`, `model`, `topology`, `write`, and `reasoning_effort` (required for every route);
optional `description`. Trusted Codex metadata owns cwd/root.
`target_worktree`: exact absolute registered sibling; confirm both checkouts. Omission
uses control; target is spawn-only/frozen. Never pass cwd/directory, env,
session, or fork selectors. No create/repair/retarget/approval brokerage.
No default route. If unavailable, report Plugin startup or discovery failure; never use shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

`$codex-harnessdock:list-harnesses` reports what is ready from fresh native
discovery; use full model IDs.

`claude-code`: `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`,
`claude-fable-5`; `leaf` or `native_orchestrator`; either authority; separate
effort `low`, `medium`, `high`, `xhigh`, or `max`.

`pi`: provider `openai-codex` only; exact `openai-codex/gpt-5.6-luna`,
`openai-codex/gpt-5.6-terra`, or `openai-codex/gpt-5.6-sol`; `leaf`; either
authority; every turn requires `low`, `medium`, `high`, `xhigh`, or `max`. No
capacity ceiling; one exact serialized session: resume-only, active input
acknowledged, no automatic recovery/orchestration.

`opencode`: exact `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, or
`openai/gpt-5.6-sol`; `leaf`; `write: false` or `write: true` (prompt/receipt
only); explicit `low`–`max` effort must map to one advertised Server variant,
never inferred; no capacity ceiling; `fresh_only`; interruption/history
unsupported. No `-fast` variants.

Never infer a model from an Agent label such as Ops5, use partial IDs, or
substitute another model after rejection. Ask when no model family was selected.

CC subscription, usage, allowance, credit, or quota exhaustion: stop further
real Claude tests; do not retry or fall back. A generic transient 429 may use
bounded reconnect.

`write: false` is behavioral read/review-only authority; `write: true` permits
task-scoped mutation. Pi `write: false` allows only `read`, `grep`, `find`, and
`ls`; Pi `write: true` also allows `bash`, `edit`, and `write`. Authority is
frozen at creation and is not an OS-level
process-permission or CLI flag. Enforcement is route-specific
and observable: Claude is prompt-level under fixed config, `IS_SANDBOX=1`,
terminal parity, and `--dangerously-skip-permissions`; Pi and OpenCode are
prompt/receipt only, inheriting native tools, plugins, MCP, and config unchanged
and never enumerated. Never omit `write`.

`leaf` runs the task itself. Claude disables native `Agent` and `Workflow`; Pi
has no native orchestration. Use
`native_orchestrator` only with exact Opus or Fable: it is an
experimental Native Agent Team lead. A
named member must launch asynchronously and a correlated `SendMessage` to that
current-team name must succeed before transport is live-validated; a synchronous
result or failed message is rejected.

Native teams use definition-owned members; requested models are pinned and
effective teammate model, effort, and cost are unknown. At most three active
teammates and six creations are behavioral limits, not containment.
Transport never auto-reconnects: an explicit follow-up forms a fresh native team; `Workflow` remains disabled.

On success: exactly `agent_name`, `model`, and `status`; never worktree paths,
final Harness text, JSON, or internal IDs. Operator diagnostics hold actionable failure/recovery detail.
