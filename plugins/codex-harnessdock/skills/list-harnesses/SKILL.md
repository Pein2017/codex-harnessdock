---
name: list-harnesses
description: 'Experimental: report the admitted Harnesses, their readiness, and exact route constraints from fresh native discovery, without selecting one.'
---

# List Harnesses

> **Experimental.** Inspection only: it starts no work, changes no Agent, and
> cannot reactivate an idle Codex parent.

Call `mcp__codex_harnessdock__list_harnesses`; it accepts no fields. Trusted Codex
metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

Each record states one admitted Harness, its Driver and capability maturity, and
its logical instances: `readiness`, whether that reading was `liveValidated`,
exact admitted models and topologies, capacity, and unsupported capabilities. For
Pi and OpenCode these model and effort facts are freshly discovered each call,
not a fixed list, and include no native config, plugin, MCP, or tool inventory.

- Admitted and available differ. An unavailable Harness is still admitted; it is
  never removed, repaired, started, or hidden. Its authentication, quota, or
  service evidence is an operator fact, not model-quality evidence.
- This never orders Harnesses by fitness, selects one, or implies a default.
  Instead the caller still states the whole route on
  `$codex-harnessdock:spawn-agent`.
- Present names, readiness, and any unsupported capability affecting the work;
  omit JSON unless debug was requested.
