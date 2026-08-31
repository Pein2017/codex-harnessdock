## 1. Freeze Public And Terminal Behavior With RED Tests

- [x] 1.1 Add failing strict-schema and generated-contract tests for optional
  `terminal_event_descriptor_path` on singular spawn and each dispatch row,
  including row isolation, relative paths, unknown follow-up input, unchanged
  Agent Cards, and one generation bump.
- [x] 1.2 Add failing preflight tests for missing publisher configuration,
  unavailable executable, unsafe descriptor, stale bearer, wrong producer,
  incompatible runtime, whole-batch stop, and zero Agent/model side effects.
- [x] 1.3 Add failing terminal mapping and ordering tests proving completed,
  errored, interrupted, and terminally uncertain envelopes publish only after
  durable completion and never from progress or prose.
- [x] 1.4 Add failing crash/reconciliation tests for publish-before-marker,
  completion-before-publish, identical retry, conflicting rewrite, recorded
  publish failure, and byte-identical completion/token/acknowledgement behavior.

## 2. Admit And Freeze Descriptor-Bound Initial Turns

- [x] 2.1 Extend singular spawn, dispatch row, MCP schema, generated guidance,
  and public-generation validation with the one optional absolute descriptor
  field while preserving every explicit route and authority field.
- [x] 2.2 Add configured publisher executable/runtime-root resolution and bounded
  shell-free descriptor preflight against the deterministic proposed Agent name
  before any lifecycle ownership.
- [x] 2.3 Persist only descriptor path and bounded redacted binding evidence on
  the immutable initial turn; exclude bearer, private descriptor content, and
  wake identifiers from public receipts, diagnostics, and logs.

## 3. Publish Deterministic Agent Terminal Events

- [x] 3.1 Add one Harness-neutral publisher helper that creates a private bounded
  event payload, invokes the configured wake CLI with bounded subprocess
  resources, cleans temporary state, and returns redacted success or failure.
- [x] 3.2 Map durable completion states to `completed`, `failed`, `cancelled`, or
  admitted `settlement_uncertain` without candidate commit, delivery, task
  success, or lead acceptance.
- [x] 3.3 Invoke the helper after v3 completion durability and from both v3 and
  retained reconciliation owners, recording deterministic publication success
  or terminal diagnostic failure without changing completion delivery.
- [x] 3.4 Preserve ordinary descriptor-free turns, progress streaming,
  interruption, retention, Agent projection, wait delivery tokens, and later
  acknowledgement semantics byte-for-byte.

## 4. Update Operator And Model Guidance

- [x] 4.1 Update spawn/dispatch Skills and exact public schemas to describe
  reserve -> descriptor preflight -> launch -> arm -> L0 ends turn, without
  claiming that terminal wake is task success.
- [x] 4.2 Document one composed `all` monitor for all-settled mixed Agents and
  independent single-member monitors for continued first-settlement control;
  keep live progress and automatic follow-up out of the wake path.
- [x] 4.3 Add runtime diagnostics for configured publisher readiness, compatible
  preflight, redacted terminal publication, and recorded failure without
  exposing private files or wake state.

## 5. Verify The Cross-Repository Seam

- [x] 5.1 Run focused schema, batch, spawn-recovery, worker-loop, job-store,
  reconciliation, completion, progress, and MCP tests with observed RED receipts.
- [x] 5.2 Run `npm run check`, strict OpenSpec validation, generated-artifact
  parity, secret scans, and `git diff --check` for the exact HarnessDock paths.
- [x] 5.3 Run a zero-model vertical slice that uses the real source wake CLI and
  a temporary wake runtime root: preflight one descriptor, drive a fake
  HarnessDock turn to durable completion, and observe exactly one immutable
  external `completed` event while completion/token bytes remain unchanged.
- [x] 5.4 Stop before release, install, MCP restart, paid Agent smoke, archive,
  commit, or push; a later authorized production-shaped smoke must prove one
  mixed native/HarnessDock all-settled wake and one independently monitored
  first-settlement wake from a fresh Codex task.
