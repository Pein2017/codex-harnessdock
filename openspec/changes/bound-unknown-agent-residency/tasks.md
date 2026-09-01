## 1. Freeze dependency seams and RED evidence

- [x] 1.1 Re-read or sync the final active `stream-native-harness-progress` and `publish-agent-terminal-events` artifacts, record their exact reconciliation/publication owners, and remove any implementation task below that would duplicate them.
- [x] 1.2 Add focused failing tests proving that an unknown V3 turn currently retains admission indefinitely after its exact worker dies and that the MCP-owned OpenCode timer disappears with the MCP process.
- [x] 1.3 Add failing safety cases for a healthy running turn older than one hour, an identity-incomplete/legacy record, a PID-reuse mismatch, a reused OpenCode service, and a managed service with peer work; none may be killed or over-released.

## 2. Bind exact physical residency before transport

- [x] 2.1 Add V3 schema/round-trip tests for the three closed residency variants, fenced reclaim phases, generation rejection, bounded fields, and legacy read-only exclusion.
- [x] 2.2 Implement the private V3 residency/reclaim fields and one awaited `launchContext` binding callback, including exact worker/provisional-turn recovery for a crash before running projection, with fail-closed attempt/route/launch-claim checks and no public PID or selector.
- [x] 2.3 Wire Claude's accepted-child fence and Pi's exact RPC child PID/start identity through the callback before prompt bytes; prove by sensitivity tests that a failed durable bind rejects pre-transport and disposes only the exact child.
- [x] 2.4 Wire OpenCode's managed-service receipt plus turn lease or closed reused-service classification before submission; prove binding failure rolls back only the unsubmitted lease and never stops a reused service.

## 3. Replace task-owned timers with one self-exiting manager

- [x] 3.1 Add deterministic tests for singleton start races, stale-manager replacement, MCP exit survival, durable-change wakeup, bounded recovery wake, crash restart, exact receipt cleanup, and exit when no managed deadline remains.
- [x] 3.2 Implement the checkout-owned detached residency-manager entrypoint and `ensureResidencyManager()` using the existing durable directory lock and `waitForDurableActivity()`; add no dependency, socket, polling loop, or service unit.
- [x] 3.3 Ensure the manager after every durable residency/lease transition and from MCP `onOperationComplete`, then remove the MCP-owned repeating `scheduleReap()` lifecycle while retaining exact `reapIfIdle()` behavior under the manager.
- [x] 3.4 Prove ordinary OpenCode idle TTL still uses admitted-turn activity only, preserves peer/reused protections, and self-exits after exact managed-service tombstoning.

## 4. Implement one-hour hard reclaim and lease disposition

- [x] 4.1 Add clock-controlled RED cases for the fixed `uncertainty.recordedAt + 3_600_000` boundary, no refresh from reads/progress/restarts, final ordinary Driver observation, and the exemption for any running job with a live exact worker.
- [x] 4.2 Implement the fenced `claimed -> physical_dead -> lease_pending -> committed` path using existing exact process/service termination primitives; prove a terminal commit that wins first stays ordinary and no process is signalled twice after a crash.
- [x] 4.3 Implement and test the release matrix: Claude/Pi release admission plus writer after exact tree death; sole managed OpenCode releases admission/service-turn/writer after exact service death; shared managed OpenCode releases admission only; reused OpenCode releases admission only and is never terminated.
- [x] 4.4 Preserve retained managed-service dispositions and complete them only if later peer departure makes the exact target sole; retain reused-service writer/turn leases for operator reconciliation without keeping the manager resident.
- [x] 4.5 Add failure-injection tests for signal refusal, target still alive, receipt/command/endpoint/peer drift, lease unlink ambiguity, restart after process death, and repeated reconciliation; every ambiguous case must retain the affected lease and semantic `unknown` state.

## 5. Project worker loss and descriptor-bound Wake

- [x] 5.1 Add failing completion tests for one `hard_reclaimed` Agent lifecycle event projected as `errored`/`worker_lost`, with deterministic text, `settlement=unknown`, and no assistant output, semantic result, continuation, or completion acceptance.
- [x] 5.2 Implement idempotent hard-reclaim projection and reconciliation from the durable reclaim receipt without passing a fabricated result through ordinary settlement release.
- [x] 5.3 Extend the existing terminal publication owner so a previously bound descriptor maps the committed loss to one immutable `worker_terminal: settlement_uncertain` event only after reclaim and Agent lifecycle durability.
- [x] 5.4 Test crash replay, absent descriptor, publisher unavailable/rejected, and recorded publication failure; none may alter leases, Agent state, semantic settlement, or create a fallback wake.

## 6. Source acceptance

- [x] 6.1 Run the focused state, Driver, manager, OpenCode service, lease, worker-reconciliation, completion, and terminal-publication test files and retain one sensitivity receipt for each load-bearing RED invariant.
- [x] 6.2 Run `npm run check` and fix only failures caused by this change.
- [x] 6.3 Run `openspec validate bound-unknown-agent-residency --type change --strict --json` and verify the implementation diff contains no public kill tool, MCP inactivity TTL, inherited-config restriction, new dependency, or unrelated cleanup.

## 7. Separately authorized activation

- [ ] 7.1 After explicit activation authorization, promote/install the compatible HarnessDock and wake-me-up source versions, restart only the required task-owned frontends, and verify loaded version/generation without terminating unrelated work.
- [ ] 7.2 Run a zero-model installed-runtime lifecycle smoke with an aged temporary current-generation fixture and exact disposable child/service, proving one-hour reclaim, the release matrix, manager self-exit, and descriptor-bound `settlement_uncertain` ordering.
- [ ] 7.3 Run one bounded real Claude Code read-only smoke to prove pre-submit exact-child binding and unchanged ordinary settlement, then use a fresh Codex task to verify no manager or HarnessDock MCP process remains resident after all durable deadlines close.
