---
name: dispatch-agents
description: 'Experimental: stateless ordered explicit-row launch for independent Agents.'
---

# Dispatch Agents

**Experimental.** Call `mcp__codex_harnessdock__dispatch_agents` only for 1..8
independent complete rows. This is stateless ordered explicit-row launch. For one Agent,
use singular `spawn_agent`.

Each row states `task_name`, `message`, `harness`, full `model`,
`reasoning_effort`, `topology`, and `write`; only `description` and
`target_worktree` are optional. Nothing is inherited or shared. No retry,
fallback, default, Team, DAG, scheduler, or replay.

Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or
discovery failure; never use a shell fallback. Use the exact retained Skill path;
latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED`
means new Codex task. Never repair Plugin Cache.
