---
name: interrupt-agent
description: 'Experimental: stop an Agent current turn, preserving its durable identity and proven continuation.'
---

# Interrupt Agent

> **Experimental.** Interrupt ends only the current turn; it never deletes the
> Agent or reactivates an idle Codex parent.

Call `mcp__codex_harnessdock__interrupt_agent` with exact current-root `target`.
Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

The graceful interrupt request may be accepted, rejected, or left pending by
the native process; the receipt's `status` is `interrupted`, `still_working`,
`failed`, or Pi `settlement_unknown`. A Pi request is nonterminal while
settlement is unknown; wait for settlement before a follow-up. This tool never force-kills a turn, so `still_working` is never
a forced termination -- the turn is simply still running. Exact-session
continuation needs native evidence of a safe flush.

A route proving no interruption answers `unsupported` instead: nothing is
aborted, the turn keeps running, and no substitute call is made; the Explorer
route is such a route. Report one concise sentence from `agent_name` and
`status`; raw JSON is debug-only.
