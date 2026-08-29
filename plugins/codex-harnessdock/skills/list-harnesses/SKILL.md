---
name: list-harnesses
description: 'Experimental: report the admitted Harnesses, their readiness, and exact route constraints from fresh native discovery, without selecting one.'
---

# List Harnesses

**Experimental.** Call `mcp__codex_harnessdock__list_harnesses`; it accepts no fields and starts no work. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

Report each admitted Harness's maturity, `readiness`, `liveValidated`, exact routes, capacity, and unsupported capability from fresh native discovery. An unavailable Harness is an operator fact, not model-quality evidence; still admitted, not removed. This never orders Harnesses by fitness, selects one, or implies a default: the caller states the whole route on `$codex-harnessdock:spawn-agent`. Omit JSON unless debugging.
