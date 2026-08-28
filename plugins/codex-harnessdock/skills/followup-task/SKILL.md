---
name: followup-task
description: 'Experimental: deliver work to a running Agent or activate its proven continuation path.'
---

# Follow Up Agent

> **Experimental.** May activate an Agent; cannot reactivate an idle Codex parent.

Call `mcp__codex_harnessdock__followup_task` with exact current-root `target` and
`message` only. The Agent's frozen route effort is inherited for every turn,
including each new Pi or OpenCode turn; this tool accepts no `reasoning_effort`. Trusted Codex
metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Release drift: use the exact retained Skill path; latest-version instructions
are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

- The whole route -- Harness, model, topology, behavioral authority, and
  reasoning effort -- is frozen at creation and inherited unchanged. This tool
  accepts no `write`, `harness`, `topology`, or `reasoning_effort`, and a different route means a new Agent.
- An idle Pi Agent resumes its exact session only, without automatic recovery;
  an active Pi turn acknowledges serialized input. Other routes may use exact
  or receipt-proven safe-fresh continuation. Never substitute a Terminal
  session. A `fresh_only` route needs a new Agent; the Explorer is such a route.
- An Opus/Fable `native_orchestrator` follow-up never resumes in-process
  teammates: it starts a fresh Native Agent Team under the durable parent.
- `activation_pending` is durably assigned to a starting activation: use
  `$codex-harnessdock:wait-agent` and do not resend. `queued_no_turn` stays idle
  until a follow-up activates it.
- A blocked Agent rejects with a closed `reason`/`scope`/`retry`, not raw
  evidence; `retry: new_agent` leaves that identity unusable. After OAuth
  refresh, only a first, zero-side-effect `auth_required` turn may safe-fresh
  recover, requeuing its original task once.
- Report one sentence from `agent_name` and `delivery`; raw JSON only on an
  explicit debug request.
