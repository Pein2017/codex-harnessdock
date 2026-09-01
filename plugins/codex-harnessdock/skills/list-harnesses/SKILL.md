---
name: list-harnesses
description: 'Experimental: report the admitted Harnesses, their readiness, and exact route constraints from fresh native discovery, without selecting one.'
---

# List Harnesses

Call `mcp__codex_harnessdock__list_harnesses`; it accepts no fields and starts no work. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only. `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

Show fresh native discovery as flat rows: Harness maturity, `readiness`, `liveValidated`, capacity, exact model/effort/topology, unsupported capabilities. Group equal efforts; omit repetition. An unavailable Harness is still admitted and an operator fact, not model-quality evidence. This never orders Harnesses by fitness, selects one, or implies a default; the caller states the whole route on `$codex-harnessdock:spawn-agent`.
