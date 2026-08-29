## MODIFIED Requirements

### Requirement: Agent metadata outlives bounded job receipts
The runtime SHALL retain root-owned Agent identity, immutable Harness route, accepted Driver contract, canonical control root, immutable canonical execution root, Agent mailbox, latest job pointer, and latest validated native-session reference independently from the newest-100 terminal-job receipt bucket.

#### Scenario: All detailed jobs for an old Agent are pruned
- **WHEN** the Agent remains in the control-root registry with continuation evidence valid under its persisted Driver capabilities
- **THEN** it remains discoverable and eligible for that exact capability-valid continuation path in its immutable execution root

### Requirement: Launch claims precede every possible native submission
Before a Driver can submit task input, the runtime SHALL durably bind a unique launch claim and attempt to the trusted owner root, canonical control root, immutable execution root, Agent, job, immutable route/capability snapshot, every required admission lease, mailbox/input identity, and a bounded input digest. A write-authorized claim SHALL bind both the turn's Harness instance or native-session admission lease and its execution-root writer lease before native submission. The runtime SHALL separately record `not_submitted`, `acceptance_proven`, `acceptance_rejected`, or `acceptance_unknown`. If the Driver call may have reached the Harness but an exact native-turn reference was not durably proven, acceptance SHALL become unknown, all affected leases SHALL remain held, and no automatic replay, fallback, retarget, or replacement session SHALL occur.

#### Scenario: Worker disappears during native submission
- **WHEN** local evidence cannot prove whether the Harness accepted the attempt
- **THEN** the attempt records unknown acceptance, retains instance/session and writer admission ownership as applicable, and requires later authoritative evidence or operator reconciliation

#### Scenario: Submission fails before transport boundary
- **WHEN** the Driver proves no native request left the process
- **THEN** the attempt records not submitted or rejected and uses the exact durable rollback path without claiming native acceptance

#### Scenario: Write claim lacks writer binding
- **WHEN** a write-authorized attempt has an instance or native-session lease but no writer lease bound to its immutable execution root
- **THEN** launch-claim validation rejects it before native submission for every supported Harness lifecycle

### Requirement: Unknown native settlement retains ownership and admission leases
Harness-instance, native-session, and execution-root workspace-writer leases SHALL be released exactly once only after terminal native turn evidence and settled turn-owned execution evidence are both valid. A lost worker, unreadable locator, failed observation, contradictory result, control deadline, partial release, or release failure SHALL preserve every affected unreleased lease with explicit unknown evidence until later reconciliation proves settlement. Reconciliation SHALL use the exact durable lease bindings rather than re-derive a root from process cwd or current worktree state.

#### Scenario: Service turn becomes unobservable
- **WHEN** a worker dies while a remote native turn may remain active and the Driver cannot observe it
- **THEN** the instance or native-session lease and any writer lease remain held and a competing turn is rejected

#### Scenario: Later observation proves terminal settlement
- **WHEN** the Driver validates the persisted locator and observes coherent terminal state
- **THEN** reconciliation may project the terminal result and release each matching durable lease exactly once

#### Scenario: One of two write-turn releases fails
- **WHEN** settlement is proven but release of either the native admission lease or writer lease cannot be durably confirmed
- **THEN** the failed lease remains unknown and no receipt claims that all admission ownership was released

### Requirement: Version-three migration is read-forward and active-owner safe
The runtime SHALL validate version-3 Agent, job, control, native-turn-reference, and lease records without allowing older runtimes or version-1 Drivers to claim their queue state. Existing active or ownership-uncertain v1/v2 Claude records SHALL remain under their current worker. A valid existing record without a separately stored execution root SHALL be interpreted as naming its stored workspace for both control and execution, and SHALL NOT be rewritten solely because the newer runtime read or reconciled it. No migration SHALL rewrite, signal, lease, resume, retarget, or convert an existing record solely because a newer runtime observed it.

#### Scenario: Older runtime sees a version-three job
- **WHEN** it encounters the new queue or control schema
- **THEN** it rejects the unknown version and cannot claim the worker turn

#### Scenario: Version-three runtime sees an active legacy Claude turn
- **WHEN** verified or uncertain legacy ownership still exists
- **THEN** it leaves the turn and its ownership evidence intact until ordinary terminal reconciliation

#### Scenario: New runtime reads a workspace-only record
- **WHEN** a valid existing Agent, job, or launch record lacks a separate execution root
- **THEN** the stored workspace supplies both meanings in memory and no migration write occurs merely from observation

## ADDED Requirements

### Requirement: Detached work carries roots separately without moving control state
Prepared activations, detached-worker reconstruction, version-one jobs, version-three jobs, launch attempts, terminal evidence, and recovery SHALL retain the canonical control root and immutable execution root as separate bounded facts. Registry, mailbox, job, completion, control-stream, wait, log, and reconciliation ownership SHALL continue to resolve from the control root. Native directory selection and writer-lease identity SHALL resolve only from the execution root.

#### Scenario: Detached worker runs for a sibling target
- **WHEN** a control-root Agent hands a turn to a detached worker for another execution root
- **THEN** the worker reopens all durable owners from the control root and passes only the execution root to native scope and writer admission

#### Scenario: Runtime restarts before targeted execution
- **WHEN** recovery reconstructs a prepared or active targeted turn
- **THEN** it preserves the original root separation and does not search the prompt, process cwd, or another registry for a replacement execution root

#### Scenario: Target worktree disappears after unknown acceptance
- **WHEN** execution-root filesystem evidence is unavailable while native settlement remains unknown
- **THEN** control-root evidence stays readable and all affected leases retain their stored canonical keys rather than being released by re-canonicalizing the missing path
