---
name: wait-agent
description: 'Experimental: join current-root completion or an Agent turn/barrier, or observe one bounded progress update; never interrupts an Agent.'
---

# Wait for Agent Completion

> **Experimental.** Wait cannot reactivate an ended Codex turn.

Call `mcp__codex_harnessdock__wait_agent` with optional `wake_on_progress`,
`acknowledge_tokens`, or `targets`. Omit targets for root-wide join. One to
eight unique exact current-root targets join fixed snapshotted turns; multiple
targets form one completion-only all-settled barrier.
Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

An untargeted call observes current-root completion; a targeted call observes
only fixed turn(s). Use a fixed 3600000 ms (one-hour) upper bound.
Set `wake_on_progress: true` only with exactly one target for an intermediate update;
unrelated root activity remains available to its proper consumer. Do not repeat progress waiting
after its update was consumed.

- Pass each consumed `delivery_token` once later; completion stays unread for
  crash-safe redelivery.
- Completion has priority: complete stored `completion_message`, truncation,
  token, and optional closed `metrics`. `reported_cost_usd` is Harness-reported,
  not billed; do not follow up only to recover a metric.
- Progress returns at most one sanitized update per observable job. Hook
  activity stays private; no model text, thinking, inputs, paths, or sessions.
- Timeout means no eligible completion was visible: untargeted across the root,
  targeted for fixed turns. Do not call `list_agents` or
  `read_agent_messages` immediately afterward merely to recheck completion.
  Do not narrate unchanged timeouts or treat timeout as failure, cancellation,
  or health. If unresolved, call `wait_agent` again directly.
- A targeted barrier returns ordered `targets`: unread completion fields/token,
  `already_consumed`, or status-only `unresolved_targets`.
- `blocking` is `null` for `completed` and safe-flush parent-requested
  `interrupted`; otherwise it is closed `{reason, scope, retry}`. A completed
  question remains `blocking: null`: answer with a follow-up.
