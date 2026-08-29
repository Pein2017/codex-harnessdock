---
name: followup-task
description: 'Experimental: deliver work to a running Agent or activate its proven continuation path.'
---

# Follow Up Agent

**Experimental.** Call `mcp__codex_harnessdock__followup_task` with exact current-root `target` and `message`; the route is frozen at creation and inherited unchanged, including effort. It accepts no `write`, `harness`, `topology`, or `reasoning_effort`; a different route means a new Agent. Trusted Codex metadata owns cwd/root. If unavailable, report Plugin startup or discovery failure; never use a shell fallback.

Use the exact retained Skill path; latest-version instructions are emergency-only; `HARNESSDOCK_MCP_RESTART_REQUIRED` means new Codex task. Never repair Plugin Cache.

`activation_pending`: wait, do not resend. `fresh_only` needs a new Agent. A blocked Agent rejects with a closed `reason`/`scope`/`retry`; only a first zero-side-effect `auth_required` turn may safe-fresh recover after OAuth refresh. Report one sentence from `agent_name` and `delivery`; raw JSON is debug-only.
