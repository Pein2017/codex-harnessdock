## MODIFIED Requirements

### Requirement: Terminal jobs do not retain live turn ownership or idle supervisors
A job SHALL NOT be published as semantically completed, interrupted, or failed
until its Driver proves the native turn terminal, turn-owned execution settled
or not applicable, live control ownership cleared, and all settlement-required
leases released. A reusable external service, native session, or idle execution
substrate MAY remain available when it owns no unsettled work for that turn. The
detached supervisor worker SHALL exit immediately after normal terminal
publication rather than entering an idle resident loop.

Separately, an exact one-hour hard-reclaim receipt MAY close only the Agent's
physical lifecycle as `hard_reclaimed` and project `worker_lost`. That receipt
MUST preserve native settlement as `unknown`, MUST NOT contain a semantic
terminal result, and MUST NOT claim that every authority lease was released.

#### Scenario: Local process turn completes
- **WHEN** the Driver proves process exit, coherent native terminal result, and settled turn-owned work
- **THEN** process identity and leases are cleared and the supervisor exits after publishing the terminal receipt

#### Scenario: Service-backed turn completes
- **WHEN** the Driver proves terminal and settled evidence while the operator-owned server remains running
- **THEN** the job completes without treating the persistent server as a resident Agent worker

#### Scenario: Interruption remains unknown before the bound
- **WHEN** an interrupt was requested but terminal settlement is not proven and the one-hour unknown bound has not elapsed
- **THEN** the job remains nonterminal, the worker may exit only after durable uncertainty is recorded, and affected leases remain held

#### Scenario: Unknown residency reaches the hard bound
- **WHEN** exact managed physical residency is proven dead after one hour of durable unknown settlement
- **THEN** the Agent lifecycle becomes `hard_reclaimed`/`worker_lost` while native settlement and any unproven writer authority remain unknown

### Requirement: Managed shared-service residency expires independently from durable history
HarnessDock SHALL make a managed shared Harness service eligible for ordinary
process-only reclamation after one hour without an admitted native turn using
that service. Readiness, health, model discovery, doctor, release smoke, and
receipt inspection SHALL NOT refresh activity. Reclamation SHALL preserve every
Agent, job, message, native reference, completion, result, usage receipt, and
audit record.

An unknown turn lease SHALL block ordinary idle reclamation. After that turn has
remained durably unknown for one hour, the hard-reclaim path MAY terminate the
exact receipt-proven managed service only when no other admitted turn or peer
work can be affected. A reused or operator-owned service SHALL remain outside
HarnessDock termination authority for every elapsed duration.

#### Scenario: Managed service becomes idle
- **WHEN** the service has no active or uncertainty-held turn lease and its last admitted turn activity is at least one hour old
- **THEN** HarnessDock may terminate only the exact receipt-proven managed process and leaves all durable logical state intact

#### Scenario: Health is inspected repeatedly
- **WHEN** health, doctor, or Harness discovery probes occur without an OpenCode turn
- **THEN** the service's last turn activity remains unchanged and the probes do not postpone idle eligibility

#### Scenario: Native settlement is newly unknown
- **WHEN** a turn may have been accepted but exact terminal settlement is unavailable for less than one hour
- **THEN** its durable service lease remains held and ordinary idle reclamation does not terminate the shared service

#### Scenario: Sole unknown turn reaches the hard bound
- **WHEN** the unknown turn is the managed service's only lease, its one-hour bound elapsed, exact ownership still matches, and peer work is absent
- **THEN** hard reclaim may terminate that exact managed service while preserving the turn's semantic settlement as unknown

#### Scenario: Unknown turn uses a reused service
- **WHEN** an unknown turn belongs to a compatible service without a valid HarnessDock ownership receipt
- **THEN** HarnessDock never terminates that service and retains any authority whose execution scope cannot be proven dead

## ADDED Requirements

### Requirement: Detached residency cleanup is task-independent and self-exiting
HarnessDock SHALL run at most one receipt-bound residency manager per Plugin
data root while durable active or unknown worker residency, Harness turn leases,
or managed-service deadlines exist. The manager SHALL derive work and deadlines
only from durable Plugin state, SHALL survive the MCP frontend that started it,
and SHALL exit when a fenced reread finds no residency or deadline to own.

MCP operations and detached workers MAY only ensure or wake that manager. A
Codex task becoming inactive, terminal, archived, or disconnected SHALL NOT by
itself cancel an accepted Agent, and the manager SHALL NOT keep a task-owned MCP
stdio process alive.

#### Scenario: Calling Codex task exits first
- **WHEN** a task-owned MCP transport closes while detached Agent residency or a managed-service deadline remains
- **THEN** the MCP process exits and the independent manager continues only the durable cleanup obligation

#### Scenario: Residency becomes empty
- **WHEN** all jobs are normally terminal or hard-reclaimed, all relevant leases are settled or intentionally retained without a managed deadline, and no managed service is eligible later
- **THEN** the residency manager releases its singleton ownership and exits without requiring close or archive

#### Scenario: Manager is absent after a crash
- **WHEN** a later worker or MCP operation finds durable residency but no matching live manager receipt
- **THEN** it starts at most one exact replacement and resumes from durable deadlines rather than from process memory
