---
name: send-message
description: 'Experimental: durably deliver or queue a message for a named Agent without activating an idle one.'
---

# Send Agent Message

> **Experimental.** Queueing never activates an idle Agent or Codex.

Call `mcp__codex_harnessdock__send_message` with exact current-root `target` and
`message`. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

A running Pi worker durably acknowledges active input; the receipt may remain
`activation_pending`, and its exact session serializes delivery. A route taking
only its first input queues the message instead;
the Explorer route is such a route. `queued_no_turn` requires
`$codex-harnessdock:followup-task`. A blocked Agent rejects instead of queueing
with a closed `reason`/`scope`/`retry`; `retry: new_agent` leaves that identity
unusable and needs a new Agent under a new name.

Present one concise sentence from `agent_name` and `delivery`: sent for
`dispatched_active`, durably accepted for `activation_pending`, or queued and
idle for `queued_no_turn`. Do not repeat the message or JSON unless debug was
explicitly requested. `activation_pending` means an activation already owns it;
observe that Agent rather than sending a duplicate. This targets only a durable
parent Agent in this root: never a native teammate, never another Harness.
