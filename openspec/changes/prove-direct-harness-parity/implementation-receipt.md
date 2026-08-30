# Implementation receipt

## Disposition

Status: `HOLD`.

On 2026-08-30 the user selected **preserve current Claude continuation and
recovery behavior, and retain the evidence-backed parity HOLD**. HarnessDock
therefore does not downgrade or relabel the public Claude capability snapshot,
does not treat process/session mechanics as provider-native turn identity, and
does not report final differential parity or release eligibility.

This is a stop-rule outcome, not completion of task 3.1. Task 3.1 remains
unchecked. Task 4.3 also remains unchecked because no parity-specific live
witness was run under this change.

## Decision-bearing evidence

- Canonical matrix:
  `tests/runtime/fixtures/native-parity/native-harness-differential-parity.receipt.json`
  (`harnessdock.native-harness-differential-parity.v2`, digest
  `sha256:4d08f39a90a7e74c53619bb0609e3d653a11177990726661cdbc202050cd7769`).
- Matrix outcome: 29 `pass`, 0 `fail`, 3 `hold`, and 7 capability-derived
  `not_applicable` cells.
- Claude HOLD cells: exact dynamic model/effort inventory, provider-native
  fresh-process continuation-turn binding, and provider-defined
  interrupted-turn recovery binding.
- The explicitly reset zero-prompt catalog receipt is
  `docs/history/2026-08-30-claude-native-route-probe-reset.json`; it started no
  prompt, accepted turn, continuation, generation, or model request.
- `runtime/claude-code-driver.mjs` persists only `{sessionId}` for a session and
  `{pid, processIdentity}` for an accepted child. The latter is deliberately
  rejected by this change as provider-native turn identity.
- `runtime/job-supervisor.mjs` resumes the session with a generated recovery
  prompt. That is new-input continuation, not provider-defined recovery of the
  same accepted turn.
- Pi already fails closed for unsupported old-turn observation and automatic
  recovery while retaining its independently proven exact-session continuation.

## Verification

- Focused parity/Driver/release replay: 110 passed, 0 failed.
- Full checkout verification: 1,640 unit tests passed with one existing skip;
  20 integration tests passed.
- Strict change and full-store validation: passed.
- Test-owned survivor inspection: none.
- No release, installation, archive, push, or paid/live witness is part of this
  disposition.
