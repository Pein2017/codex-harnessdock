# Implementation receipt

## Disposition

Status: `COMPLETE` for deterministic parity acceptance.

On 2026-08-30 the user accepted the existing Claude behavior as
`automaticRecovery=same_session_recovery_prompt`: after a recoverable
disconnect, a fresh process resumes the stable native session and sends one
generated recovery prompt as a distinct new turn. The former
`exact_session_transport` claim is now explicitly unavailable for Claude.
Task 3.1 is complete at this bounded deterministic scope. Task 4.3 remains
unchecked because no parity-specific model-turn witness was authorized or run;
the accepted Claude evidence is a zero-prompt Agent SDK initialization witness.

## Decision-bearing evidence

- Canonical matrix:
  `tests/runtime/fixtures/native-parity/native-harness-differential-parity.receipt.json`
  (`harnessdock.native-harness-differential-parity.v2`, digest
  `sha256:31a0ad5628cee10dbbebc263e1a127c96de6976012a31dd5a682554be72800ec`).
- Matrix outcome: 32 `pass`, 0 `fail`, 0 `hold`, and 10 capability-derived
  `not_applicable` cells; promotion is eligible.
- Claude's exact dynamic model/effort inventory is now a source-bound pass. Its
  fresh-process continuation row proves stable session `S` and distinct native
  continuation message/result identities. Its old-turn observer and
  exact-session-transport rows are capability-derived `not_applicable`.
- The accepted zero-prompt Agent SDK initialization witness was observed at
  `2026-08-30T06:33:50.169Z`; it started no prompt, accepted turn,
  continuation, generation, or model request.
- `runtime/claude-code-driver.mjs` advertises only the closed
  `same_session_recovery_prompt` recovery value. Its persisted `{sessionId}`
  is the native session target; PID/job/attempt values are not native identities.
- `runtime/job-supervisor.mjs` admits only that recovery value and resumes the
  session with one generated new recovery prompt per bounded reconnect attempt.
- Pi already fails closed for unsupported old-turn observation and automatic
  recovery while retaining its independently proven exact-session continuation.

## Verification

- Local supervisor and Claude capability tests: 29 passed.
- Durable-state compatibility tests: 49 passed.
- The dependency-free matrix composer regenerated and matched both checked-in
  receipts: 42 cells, 32 `pass`, 0 `hold`, 10 `not_applicable`.
- Strict `openspec validate prove-direct-harness-parity --strict` and
  `git diff --check`: passed.
- The focused Claude parity, matrix, and release-smoke command passed with 38
  tests and no model turn.
- No release, installation, archive, push, paid turn, or model-generation
  witness is part of this change.
