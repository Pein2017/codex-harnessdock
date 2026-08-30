# Implementation receipt

## Disposition

Status: `PARTIAL`.

On 2026-08-30 the user accepted the existing Claude behavior as
`automaticRecovery=same_session_recovery_prompt`: after a recoverable
disconnect, a fresh process resumes the stable native session and sends one
generated recovery prompt as a distinct new turn. The former
`exact_session_transport` claim is now explicitly unavailable for Claude.
Task 3.1 is complete at this bounded deterministic scope; task 4.3 remains
unchecked because no parity-specific live witness was authorized or run.

## Decision-bearing evidence

- Canonical matrix:
  `tests/runtime/fixtures/native-parity/native-harness-differential-parity.receipt.json`
  (`harnessdock.native-harness-differential-parity.v2`, digest
  `sha256:4d08f39a90a7e74c53619bb0609e3d653a11177990726661cdbc202050cd7769`).
- Matrix outcome: 31 `pass`, 0 `fail`, 1 `hold`, and 10 capability-derived
  `not_applicable` cells.
- Claude's only HOLD cell is exact dynamic model/effort inventory. Its
  fresh-process continuation row proves stable session `S` and distinct native
  continuation message/result identities. Its old-turn observer and
  exact-session-transport rows are capability-derived `not_applicable`.
- The explicitly reset zero-prompt catalog receipt is
  `docs/history/2026-08-30-claude-native-route-probe-reset.json`; it started no
  prompt, accepted turn, continuation, generation, or model request.
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
  receipts: 42 cells, 31 `pass`, 1 `hold`, 10 `not_applicable`.
- Strict `openspec validate prove-direct-harness-parity --strict` and
  `git diff --check`: passed.
- The focused Claude Driver/parity, matrix, and release-smoke test command did
  not load because this isolated worktree lacks `@opencode-ai/sdk` and
  `@modelcontextprotocol/sdk`; no dependency installation was authorized.
- No release, installation, archive, push, or paid/live witness is part of this
  change.
