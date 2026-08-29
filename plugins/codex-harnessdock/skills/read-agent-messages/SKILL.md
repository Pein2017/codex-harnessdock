---
name: read-agent-messages
description: 'Experimental: read recent outer-assistant text from an Agent bound native history, without activating it.'
---

# Read Agent Messages

**Experimental.** Call `mcp__codex_harnessdock__read_agent_messages` with exact current-root `target` and optional `before`/`limit`. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

It returns complete latest outer-assistant text, newest first; thinking, tools, attachments, child transcripts, and Codex history are excluded. It cannot reactivate Codex or extend native retention. `unsupported` returns no messages. Current completion comes from `$codex-harnessdock:wait-agent`; present text with minimal context, not JSON, unless debugging.
