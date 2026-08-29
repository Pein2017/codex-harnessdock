---
name: send-message
description: 'Experimental: durably deliver or queue a message for a named Agent without activating an idle one.'
---

# Send Agent Message

**Experimental.** Call `mcp__codex_harnessdock__send_message` with exact current-root `target` and `message`. Queueing never activates an idle Agent or Codex. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

`dispatched_active` is sent, `activation_pending` is durably accepted (do not duplicate), and `queued_no_turn` needs `$codex-harnessdock:followup-task`. A blocked Agent rejects with closed `reason`/`scope`/`retry`; `retry: new_agent` needs a new name. Target only a durable parent Agent in this root, never a native teammate or another Harness. Report one concise sentence from `agent_name` and `delivery`; do not repeat the message or JSON unless debugging.
