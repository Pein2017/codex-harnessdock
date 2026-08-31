## 0. Baseline Gate

- [x] 0.1 Reconcile or explicitly stack the completed route, worktree,
  Agent-card, blocking, catalog, provenance, and OpenCode-admission changes
  named in `proposal.md`; record the exact source/spec base and MCP generation.
- [x] 0.2 Prove current singular spawn success still returns the accepted Agent
  Card and current target-worktree/exact-route behavior before editing failure
  paths.

## 1. Failing Recovery Contracts

- [x] 1.1 Add RED tests proving cancellation before reservation creates no
  Agent/job/model work, while cancellation during launch cannot roll back or
  interrupt a `lifecycle_owned` or `ownership_uncertain` turn.
- [x] 1.2 Add RED tests proving non-rollback-safe failure is still an MCP error
  result containing only public `agent_name`, closed outcome, bounded code, and
  sanitized message.
- [x] 1.3 Add RED tests proving duplicate-name and representative runtime errors
  cannot expose internal Agent/job/session/instance IDs, paths, prompts, or raw
  provider text.

## 2. Singular Spawn and MCP Projection

- [x] 2.1 Check the abort signal at safe pre-ownership boundaries and preserve
  the existing handoff classification once worker/native launch may have begun.
- [x] 2.2 Attach the public Agent name to `lifecycle_owned` and
  `ownership_uncertain` failures without changing successful Agent Cards or
  inventing identity for pre-reservation rejection.
- [x] 2.3 Carry only the bounded public error fields through the isolated MCP
  worker and final redaction projection; add no cancel/interruption operation.

## 3. Current Route Accounting

- [x] 3.1 Add RED ledger fixtures using production-shaped singular spawn
  arguments for Claude, Pi, and OpenCode, including `native_orchestrator`.
- [x] 3.2 Replace the static model allowlist and retired `delegation_mode`
  parser with bounded `harness`/model/effort/`topology`/`write` accounting from
  existing rollout and completion evidence.
- [x] 3.3 Preserve replay exclusion, privacy, nullable provider metrics, and
  operator-only acceptance dispositions without adding runtime usage records or
  model-facing totals.

## 4. Generation and Verification

- [x] 4.1 Increment the MCP API generation once for Change A, update current
  tool/Skill contract fixtures as required, and retain older durable Agent
  readers without rewriting records.
- [x] 4.2 Run focused recovery, handoff, redaction, MCP-worker, and ledger tests
  with sensitivity checks, then run `npm run check`.
- [x] 4.3 Run `openspec validate harden-agent-spawn-recovery-and-accounting
  --strict` and inspect status/diff scope.
- [x] 4.4 Stop without batch dispatch, live Harness/model turns, install,
  Plugin-cache refresh, release, push, archive, or main-spec synchronization
  unless each action is separately authorized.
