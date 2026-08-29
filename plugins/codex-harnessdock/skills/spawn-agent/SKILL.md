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
session, or fork selectors. Never pass environment, session, or fork selectors.
No create/repair/retarget/approval brokerage.
No default route. If unavailable, report Plugin startup or discovery failure; never use shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

## Routes

Call `$codex-harnessdock:list-harnesses` immediately before route selection.
It is the current inventory: use its exact admitted `harness`, full `model`,
`topology`, `write`, and `reasoning_effort` values. All route fields are
mandatory; nothing is defaulted, inferred, aliased, or substituted after
rejection. Do not copy a model or effort roster from this Skill.

Never infer a model from an Agent label such as Ops5, use partial IDs, or
substitute another model after rejection. Ask when no model family was selected.

CC subscription, usage, allowance, credit, or quota exhaustion: stop further
real Claude tests; do not retry or fall back. A generic transient 429 may use
bounded reconnect.

`write: false` is behavioral read/review-only authority; `write: true` permits
task-scoped mutation. Authority is frozen at creation and is not an OS-level
process-permission or CLI flag. Enforcement is route-specific
and observable: Claude is prompt-level under fixed config, `IS_SANDBOX=1`,
terminal parity, and `--dangerously-skip-permissions`; Pi and OpenCode are
prompt/receipt only, inheriting native tools, plugins, MCP, and config unchanged
and never enumerated. Never omit `write`.

`leaf` runs the task itself. Claude disables native `Agent` and `Workflow`; Pi
has no native orchestration. Use
`native_orchestrator` only when fresh listing admits it: it is an
experimental Native Agent Team lead. A
named member must launch asynchronously and a correlated `SendMessage` to that
current-team name must succeed before transport is live-validated; a synchronous
result or failed message is rejected.

Native teams use definition-owned members; requested models are pinned and
effective teammate model, effort, and cost are unknown. At most three active
teammates and six creations are behavioral limits, not containment.
Transport never auto-reconnects: an explicit follow-up forms a fresh native team; `Workflow` remains disabled.

On success: use the returned Agent Card with `agent_name`, `model`, and `status`; never worktree paths,
final Harness text, JSON, or internal IDs. Operator diagnostics hold actionable failure/recovery detail.
