## MODIFIED Requirements

### Requirement: Unknown native settlement retains ownership and admission leases
Before the hard-reclaim boundary, Harness-instance, native-session, and
workspace-writer leases SHALL be released only after terminal native turn
evidence and settled turn-owned execution evidence are both valid. A lost
worker, unreadable locator, failed observation, contradictory result, or control
deadline SHALL preserve affected leases with explicit unknown evidence.

After one hour of durable unknown settlement, proof that the exact managed
worker tree is dead MAY release that turn's instance or native-session admission
lease without changing semantic settlement. A workspace-writer lease MAY be
released only when the exact mutation-capable native process, managed service,
or turn scope is also proven dead. A managed-service turn lease SHALL remain
held until that exact service scope is dead; a reused/operator service SHALL
never be killed to obtain such proof. Every release or intentional retention
MUST be bound to the original launch claim and recorded exactly once.

#### Scenario: Service turn becomes unobservable
- **WHEN** a worker dies while a remote native turn may remain active and the Driver cannot observe it
- **THEN** every lease remains held until ordinary settlement or the one-hour hard-reclaim decision is durably reached

#### Scenario: Hard reclaim releases admission but not writer authority
- **WHEN** the exact managed worker tree is dead after one hour but a reused service may still execute write-capable work
- **THEN** the turn's admission lease is released, its workspace-writer lease remains held, and semantic settlement remains unknown

#### Scenario: Complete managed execution scope is dead
- **WHEN** the exact worker and mutation-capable native process or managed-service scope are all proven dead after the bound
- **THEN** matching admission and writer leases may be released exactly once while the job records no semantic terminal result

#### Scenario: Later observation proves terminal settlement
- **WHEN** the Driver validates the persisted locator and observes coherent terminal state before hard reclaim commits
- **THEN** reconciliation projects the ordinary terminal result and releases matching leases exactly once instead of hard reclaiming the Agent

#### Scenario: Process identity is incomplete or termination is ambiguous
- **WHEN** any required physical identity is absent, reused, mismatched, foreign, or the exact target remains alive after bounded termination
- **THEN** no additional process is signalled, affected leases remain held, and no hard-reclaim receipt is claimed

### Requirement: Version-three migration is read-forward and active-owner safe
The runtime SHALL validate the current Agent, job, control,
native-turn-reference, lease, and physical-residency records without allowing
older runtimes or version-1 Drivers to claim their queue state. Existing active
or ownership-uncertain older records SHALL remain under their current worker. No
migration SHALL rewrite, signal, lease, resume, convert, or make a record
hard-reclaim eligible solely because a newer runtime observed it.

#### Scenario: Older runtime sees the new residency generation
- **WHEN** it encounters a job or launch record containing the new physical-residency or hard-reclaim state
- **THEN** it rejects the unknown generation and cannot claim the worker turn or release its leases

#### Scenario: Current runtime sees an active legacy turn
- **WHEN** verified or uncertain legacy ownership exists without a complete exact physical-residency receipt
- **THEN** it leaves that turn and its ownership evidence intact and excludes it from automatic hard reclaim

## ADDED Requirements

### Requirement: Physical residency evidence is exact, durable, and closed
Every current-generation detached turn SHALL bind a closed physical-residency
record to its trusted root, Agent, job, attempt, immutable route, and launch
claim. The record SHALL distinguish the supervisor worker, a Driver-owned local
process tree, an exactly managed service/turn scope, and a reused or
operator-owned service. Every local process identity SHALL include the PID and
deterministic start identity captured at launch; PID-only or later process-name
discovery SHALL be invalid.

Before native submission, the same launch binding SHALL durably carry the exact
supervisor worker identity and Driver-validated provisional native-turn
reference needed for later observation. The provisional reference is lineage,
not acceptance evidence. If that worker dies after binding but before the V3
running record commits, reconciliation SHALL mark acceptance unknown and create
one current-generation V3 `unknown` record with uncertainty beginning at that
recovery observation. It SHALL NOT replay input, infer acceptance, or use an
incomplete provisional reference to authorize hard reclaim.

The record SHALL exclude prompts, model output, credentials, arbitrary paths or
commands, endpoints, and public selectors. A process-backed current Driver that
cannot durably bind its exact execution identity before possible native
submission SHALL fail before submission rather than create future kill
ambiguity.

#### Scenario: Pi launches a turn process
- **WHEN** the Pi Driver creates the exact RPC child that can own native work
- **THEN** its PID and deterministic identity are durably bound to the launch claim before prompt submission

#### Scenario: Claude exposes an accepted child
- **WHEN** the Claude Driver proves its exact child identity for the native turn
- **THEN** the same process identity is retained as physical-residency evidence without adding a public PID field

#### Scenario: OpenCode attaches to a reused service
- **WHEN** the fixed-origin endpoint is compatible but lacks a valid HarnessDock managed receipt
- **THEN** the residency record states reused ownership and grants no service termination authority

#### Scenario: Worker dies between durable binding and running projection
- **WHEN** the exact current worker, physical residency, and provisional native-turn lineage are durable but the worker disappears before the V3 running record commits
- **THEN** reconciliation materializes one non-replayable V3 unknown record at the observation time and leaves semantic settlement unknown

#### Scenario: Pre-record lineage is incomplete
- **WHEN** the worker disappears before a complete exact provisional native-turn reference was durably bound
- **THEN** no V3 record is fabricated, every lease remains held, and the attempt stays operator-visible but ineligible for automatic hard reclaim

### Requirement: Hard reclaim is a physical lifecycle fact, not semantic settlement
After the fixed one-hour unknown boundary, the runtime SHALL record
`hard_reclaimed` only after its exact process-termination and lease-disposition
receipts are durable under one fenced generation. The record SHALL preserve the
last native observation, `settlement=unknown`, released and retained lease
classes, and a bounded reason. It SHALL contain no normalized terminal result,
assistant output, success claim, continuation claim, or acceptance inference.

#### Scenario: Exact hard reclaim succeeds
- **WHEN** every required managed process is proven dead and the admission-lease disposition is durably known
- **THEN** the job enters `hard_reclaimed`, the Agent projects `worker_lost`, and the retained record still states semantic settlement unknown

#### Scenario: Reclaim crashes between termination and projection
- **WHEN** the manager restarts after exact process death but before Agent projection or Wake publication
- **THEN** it rereads the same durable receipt and completes each missing idempotent projection without signaling another process

#### Scenario: Lease unlink disposition is unknown
- **WHEN** a target lease cannot be proven released or retained after physical termination
- **THEN** hard-reclaim projection remains pending and the manager retries only the exact lease disposition without repeating process termination
