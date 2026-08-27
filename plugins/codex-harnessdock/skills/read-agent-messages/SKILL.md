---
name: read-agent-messages
description: 'Experimental: read recent outer-assistant text from an Agent bound native history, without activating it.'
---

# Read Agent Messages

> **Experimental.** History cannot reactivate Codex or extend native retention.

Call `mcp__codex_harnessdock__read_agent_messages` with exact current-root `target`
and optional `before`/`limit`. Trusted Codex metadata owns cwd/root; never infer
a transcript path or session ID. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

- Default returns the latest outer-assistant text, newest first; paginate older
  messages only with returned `next_before`.
- Text is complete within codex-harnessdock; host transport may impose its own
  capacity. Thinking, tools, attachments, child transcripts, and Codex history
  are excluded, and this never activates the Agent. Pi exposes asynchronous
  assistant history.
- A route proving no readable history answers `unsupported` and no messages, and
  no transcript is looked for; the Explorer route is such a route.
- Current completion comes from `$codex-harnessdock:wait-agent`'s complete
  `completion_message`; use history only for earlier output.
- Report missing history honestly; present message text plus minimal context,
  not raw JSON, unless debug was requested.
