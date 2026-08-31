---
name: wait-agent
description: 'Experimental: join current-root completion or an Agent turn/barrier, or observe one bounded progress update; never interrupts an Agent.'
---

# Wait for Agent Completion

**Experimental.** Call `mcp__codex_harnessdock__wait_agent` with optional `wake_on_progress`, `acknowledge_tokens`, or `targets`. One to eight unique exact current-root targets join fixed turns; multiple targets form one completion-only all-settled barrier. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

An untargeted call observes current-root completion; a targeted call observes fixed turns. The hidden upper bound is 3600000 ms. Set `wake_on_progress: true` only for exactly one target and an intermediate update; it returns at most one sanitized newer meaningful revision and hook activity stays private. Completion has priority with complete stored `completion_message` and token; acknowledge each consumed `delivery_token` once later. Unrelated root activity remains available to its proper consumer. A timeout means no eligible completion was visible, not failure: do not poll reflexively, narrate unchanged timeouts, or call `list_agents` or `read_agent_messages` immediately afterward merely to recheck completion; call `wait_agent` again directly. Wait cannot reactivate an ended Codex turn.
