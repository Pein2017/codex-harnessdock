## 1. Freeze The Shared Progress Contract

- [x] 1.1 Add a failing Driver-contract fixture for capability-schema v4 with required `nativeProgress` values, maturity, provenance, and live-handle subscription coherence.
- [x] 1.2 Define and validate the closed Driver-reduced progress shape, generic safe summaries, tool-name allowlist, byte bounds, and duplicate/coalescing rules without persisting raw native values.
- [x] 1.3 Advance every current Driver/profile/fixture to capability schema v4: Claude uses `supervisor_projected`, Pi/OpenCode use `native_coalesced`, and unsupported fixtures state `unavailable` explicitly.
- [x] 1.4 Extend the validated process-local live-turn wrapper with `subscribeProgress(listener)` only for `native_coalesced`, including immediate-latest replay, unsubscribe-before-dispose, and listener-failure containment tests.

## 2. Persist And Deliver Version-Three Progress

- [x] 2.1 Add failing V3-store fixtures for an optional latest progress snapshot, zero/default delivered revision on retained records, exact worker process identity, active-only writes, and atomic monotonic claims.
- [x] 2.2 Implement bounded V3 progress publication under the existing record lock, storing only the latest meaningful revision and refusing progress after `unknown` or terminal settlement.
- [x] 2.3 Subscribe the V3 worker after its running record exists, replay the Driver's latest activity, publish later revisions, and detach the subscription before live-turn disposal on every exit.
- [x] 2.4 Extend root-wide and targeted progress selection to V3 records and watch their durable directory without creating paths or changing ordinary completion-only waits.
- [x] 2.5 Replace the one-progress-per-job predicate with `revision > deliveredRevision`, preserving atomic races, root isolation, targeted fixed-turn scope, completion priority, and final zero-time completion observation.

## 3. Integrate Pi Native Progress And Observation

- [x] 3.1 Add a failing Pi RPC fixture that emits lifecycle, message, tool, duplicate, oversized, unknown, and dialog events and proves only closed progress milestones reach the Driver subscriber.
- [x] 3.2 Add Pi's process-local event subscription over the existing framed JSONL reader without changing request correlation, fixed noninteractive dialog policy, `message_end`, `agent_settled`, steering, interruption, or cleanup.
- [x] 3.3 Implement Pi `observeTurn()` from the exact session ID, baseline leaf, branch lineage, terminal assistant entry, and monotonic stats; active, missing, regressed, multiple, malformed, or foreign evidence remains nonterminal.
- [x] 3.4 Promote Pi's progress and turn-observation capabilities only after focused Driver and native-differential fixtures prove live progress, post-loss terminal reconstruction, redaction, and unchanged direct-Harness parity.

## 4. Integrate OpenCode Native Progress And Observation

- [x] 4.1 Add a failing fixed-origin OpenCode observer-client fixture for `/event`, exact-session bounded message/status reads, auth/redirect/deadline/byte limits, cancellation, reconnect, and rejection of every mutating or foreign-session request.
- [x] 4.2 Implement the read-only observer with session filtering, stable message/part deduplication, observe-register-observe message replay at initial connection/reconnect, bounded backoff, and disposal cleanup while retaining synchronous prompt submission.
- [x] 4.3 Reduce only exact-session lifecycle/tool/message milestones to the closed progress shape; discard text, reasoning, permissions, paths, diffs, todo bodies, tool inputs/outputs, raw errors, and arbitrary event fields.
- [x] 4.4 Implement OpenCode `observeTurn()` from the exact session/user-message/attempt/provider/model/variant locator plus bounded messages/status, reusing the final-result selector only for an unambiguous terminal assistant lineage.
- [x] 4.5 Promote OpenCode's progress and turn-observation capabilities while keeping active input, public history, interrupt, automatic recovery, native orchestration, and `prompt_async` unavailable; update native-differential and installed-compatibility receipts.

## 5. Reconcile Proven Lost Workers

- [x] 5.1 Add failing reconciliation fixtures proving only an exact dead worker identity under the current owner root reaches `observeTurn()`; live, reused, missing, or ambiguous identity never does.
- [x] 5.2 Invoke bounded sequential V3 worker-loss reconciliation at `wait_agent` pre-wait and post-wait boundaries with the remaining deadline and cancellation signal, without running it from list/spawn/follow-up or a background daemon.
- [x] 5.3 Prove exact terminal observation publishes one completion, releases matching leases, closes control ownership, and remains idempotent; active/unknown/foreign/malformed/contradictory observations retain every lease and publish nothing.
- [x] 5.4 Prove a completion that appears during progress claim or final observation supersedes the advisory update without redelivery or progress-cursor regression.

## 6. Guidance, Live Compatibility, And Acceptance

- [x] 6.1 Update Agent cards, `wait_agent` Skill/MCP guidance, README capability tables, and release-smoke expectations for internal realtime plus explicit repeated meaningful progress; do not invite automatic polling or raw JSON output.
- [x] 6.2 Run focused contract, V3-store/worker, progress/wait, Pi, OpenCode, reconciliation, redaction/flood, and direct-parity suites, including a demonstrated failing pre-change/sensitivity witness for each load-bearing behavior.
- [x] 6.3 Run one bounded real Pi/Luna-low and one OpenCode/Luna-low compatibility smoke only after deterministic gates pass, capturing at least one sanitized progress revision and exact terminal completion without retaining prompt or native payloads; stop on auth/quota/account failure.
- [x] 6.4 Run `openspec validate stream-native-harness-progress --strict`, Plugin validation, `git diff --check`, and `npm run check`; record the depth-2 package receipt and leave archive, release, install, merge, and push for an explicit subsequent decision.
