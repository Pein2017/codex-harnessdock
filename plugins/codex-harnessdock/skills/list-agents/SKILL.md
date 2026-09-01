---
name: list-agents
description: 'Experimental: list durable Agents in the current Codex root, including nonresident terminal history.'
---

# List Agents

Call `mcp__codex_harnessdock__list_agents` with no fields or optional `path_prefix`; it is a state snapshot and cannot reactivate Codex. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only. `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

Show flat Agent/Harness/model/effort/topology/authority rows with `starting`, `working`, `completed`, `failed`, or `interrupted`. Omit nulls, JSON, tokens, timestamps, provenance, and final output. Completion comes from `$codex-harnessdock:wait-agent`; never call this solely to recheck completion after a quiet `wait_agent` timeout—call `wait_agent` again directly.
