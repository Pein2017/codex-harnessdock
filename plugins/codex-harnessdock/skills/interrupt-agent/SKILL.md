---
name: interrupt-agent
description: 'Experimental: stop an Agent current turn, preserving its durable identity and proven continuation.'
---

# Interrupt Agent

**Experimental.** Call `mcp__codex_harnessdock__interrupt_agent` with exact current-root `target`. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

It ends only the current turn, never deletes the Agent or reactivates Codex. A graceful interrupt request may be accepted, rejected, or left pending: `status` is `interrupted`, `still_working`, `failed`, or Pi `settlement_unknown`. Pi request is nonterminal: wait for settlement. `still_working` is never a forced termination. `unsupported`: the turn keeps running. Exact-session continuation needs safe-flush evidence. Report one concise sentence from `agent_name` and `status`; raw JSON is debug-only.
