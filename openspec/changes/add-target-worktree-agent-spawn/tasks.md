## 1. Freeze Failing Contracts

- [x] 1.1 Add target-admission RED tests using temporary linked-worktree fixtures and a route-inspection spy; observe current failure for valid sibling selection and for relative, explicit-current, missing, prunable, unregistered, independent-clone, and owner-drift rejection before the spy or durable mutation.
- [x] 1.2 Add writer-binding RED/sensitivity tests at the public version-one Claude and version-three Pi/OpenCode launch seams; prove the current implementation can reach the Driver with only instance/native-session admission, then freeze rejection until an execution-root writer binding is also durable.

## 2. Target Admission and Public Schema

- [x] 2.1 Implement one checkout-owned target-worktree admission module using Node primitives plus read-only `git -c core.quotePath=false worktree list --porcelain` with a strict raw absolute/control-free path parser and absolute Git-common-directory checks, with repeated canonical identity comparison and closed sanitized failures; add no dependency, fallback, creation, repair, quoting decoder, or permission brokerage.
- [x] 2.2 Add optional absolute spawn-only `target_worktree` to the strict typed MCP schema and public runtime input, reject it on follow-up and reject every generic cwd/directory selector, bump the MCP API generation atomically, and update MCP/plugin-contract tests.
- [x] 2.3 Reorder spawn so target admission completes before route inspection, readiness, Agent reservation, or any durable write; omission must select the canonical trusted control root and an explicit current-root target must fail.
- [x] 2.4 Update only the spawn Skill and compact MCP description for the exact target contract and restart boundary; retain the existing three-field spawn receipt and add path-leak assertions for success and failure projections.

## 3. Immutable Root Persistence

- [x] 3.1 Extend Agent record validation/creation with immutable canonical `executionRoot` while retaining registry `workspaceRoot` as the control root; make mailbox, follow-up, interrupt, recovery, and update paths inherit it and reject retargeting.
- [x] 3.2 Add read compatibility so any valid existing record without `executionRoot` interprets its stored workspace as both roots without a read/list/reconcile write; add a write-sensitivity test proving ordinary later mutation preserves that identity.
- [x] 3.3 Carry control and execution roots separately through version-one prepared jobs, version-three worker reconstruction/snapshots, launch claims, running/terminal records, and reconciliation, with state-directory assertions proving registry, mailbox, jobs, completion, wait, log, and control evidence remain control-root scoped.
- [x] 3.4 Keep public Agent cards, spawn/follow-up/wait/completion/blocking receipts, usage projections, and model-facing errors path-free while preserving exact roots in owner-only durable evidence and bounded operator diagnostics.

## 4. Complete Turn Admission

- [x] 4.1 Generalize launch intent and branded binding from one expected lease to a closed ordered bundle of `instance XOR native_session`, plus `writer` exactly for behavioral-write authority; reject missing, duplicate, partial, root-drifted, or authority-incoherent bundles before the native-submission fence.
- [x] 4.2 In the version-three Pi/OpenCode lifecycle, persist the complete intent, acquire the existing instance/native-session admission plus the existing execution-root writer lease for write turns, bind both exact branded acquisitions, and use the current fenced pre-submission rollback on any acquisition or handoff failure.
- [x] 4.3 In the version-one Claude lifecycle, persist and acquire the same complete bundle before `Driver.startTurn()` without adding a version-three job/completion owner; use instance admission for fresh turns, native-session admission for exact continuation, and the execution-root writer lease for every write turn.
- [x] 4.4 Route both lifecycles through the existing settlement-gated batch release and unknown-retention engine, build release targets only from stored binding key fields, and verify `all`/`partial`/`none`/`unknown`, worker-loss, removed-worktree, and idempotent reconciliation behavior without force-clear.

## 5. Native Execution Boundary

- [x] 5.1 Revalidate every explicit target with the shared admission module after Harness preflight and immediately before the native submission fence/`startTurn()` in both lifecycle paths; classify drift as not-submitted, run only exact rollback, and never retry in the control root or request native approval.
- [x] 5.2 Populate Driver scope workspace identity only from the immutable execution root and update focused Claude cwd, Pi process-cwd, and OpenCode session/prompt-directory tests; detached Node workers and every durable state resolver must continue using the control root.
- [x] 5.3 Add cross-record invariants proving Agent, job, worker snapshot, launch claim, Driver scope, and writer binding agree on the same execution root while registry/state ownership agrees on the same control root.

## 6. Deterministic Acceptance

- [x] 6.1 Add a deterministic detached-worker fake-Driver smoke that creates two temporary linked worktrees, spawns from the control root into the sibling, proves the fake Driver observed the sibling execution root, proves state stayed in the control bucket, and proves settled dual-lease release; add an unknown-settlement case that retains both leases.
- [x] 6.2 Run focused tests with `npm run test:focus -- tests/runtime/target-worktree-admission.test.mjs tests/runtime/mcp-server.test.mjs tests/runtime/agent-store.test.mjs tests/runtime/launch-claim.test.mjs tests/runtime/workspace-writer-lease.test.mjs tests/runtime/v3-worker-launch.test.mjs tests/runtime/detached-worker-handoff.test.mjs tests/runtime/claude-driver-v2.test.mjs tests/runtime/pi-driver.test.mjs tests/runtime/opencode-driver.test.mjs`; fix only failures owned by this change.
- [x] 6.3 Run the deterministic fake-Driver smoke, `openspec validate add-target-worktree-agent-spawn --strict`, and `npm run check`; record exact passing receipts and do not run a paid/live Claude, Pi, OpenCode, provider, install, refresh, release, or model smoke.

## Implementation Receipts — 2026-08-29

- RED: `npm run test:focus -- tests/runtime/target-worktree-admission.test.mjs tests/runtime/agent-store.test.mjs tests/runtime/launch-claim.test.mjs` failed at the intended seams: missing target-admission module, absent persisted `executionRoot`, and absent plural launch-claim binding API.
- Focused acceptance: the exact 6.2 command passed 284 tests, 0 failed.
- Deterministic fake-Driver smoke: `node --test --test-name-pattern='runs a targeted detached fake-Driver turn' tests/runtime/target-worktree-admission.test.mjs` passed 1 test, 0 failed.
- OpenSpec: `openspec validate add-target-worktree-agent-spawn --strict` reported the change valid.
- Review correction: the expanded focused command including launch reconciliation and the Claude supervisor lifecycle passed 336 tests, 0 failed; both existing pre-writer-bundle Pi/OpenCode claims are readable without mutation and remain non-replayable.
- Review correction: the removed-target ordering regression returns sanitized `target_missing` with zero prompt/native calls and no control/target path; the lifecycle-owner regression prevents generic v3 reconciliation from claiming a Claude supervisor launch.
- Concurrency correction: a deterministic stale rollback-releaser RED reproduced the full-suite race; the shared release seam now accepts only the same claim's exact `rollback_complete` monotonic successor and idempotently removes any remaining holder.
- Repository gate after the ordered OpenCode successor: `npm run check` passed lint/typecheck; unit tests reported 1,582 tests, 1,581 passed, 1 skipped, 0 failed; integration reported 20 passed, 0 failed.
- No paid/live Harness, provider, model, install, refresh, release, or Plugin-cache operation was run.
