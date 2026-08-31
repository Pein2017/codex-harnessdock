---
name: dispatch-agents
description: 'Experimental: stateless ordered explicit-row launch for independent Agents.'
---

# Dispatch Agents

Call `mcp__codex_harnessdock__dispatch_agents` only for 1..8 independent rows:
stateless ordered explicit-row launch. For one Agent, use singular `spawn_agent`.

Each row states `task_name`, `message`, `harness`, full `model`,
`reasoning_effort`, `topology`, and `write`; only `description` and
`target_worktree` and initial-turn `terminal_event_descriptor_path` are optional.
Descriptors: reserve/preflight/launch/arm/L0-end; `all`=all-settled, separate=first, never task success. Nothing is inherited or shared. No retry,
fallback, default, Team, DAG, scheduler, or replay.

Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or
discovery failure; never use a shell fallback. Use the exact retained Skill path;
latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED`
means new Codex task. Never repair Plugin Cache.
