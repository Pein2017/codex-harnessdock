## MODIFIED Requirements

### Requirement: Every terminal job emits one durable completion event
The runtime SHALL create exactly one root-owned, Agent-linked lifecycle event
when an Agent's internal job first reaches `completed`, `interrupted`, `failed`,
or `hard_reclaimed`. Ordinary events SHALL retain the complete `finalMessage`,
legacy-compatible `truncated`, `detailedResultAvailable`, and
`claudeSessionIdAvailable` fields. Internal `failed` and `hard_reclaimed` SHALL
both project Agent `errored`, but `hard_reclaimed` SHALL expose the closed
blocking reason `worker_lost`, a deterministic resource-loss message, and
`settlement=unknown` rather than model output or a semantic failure result.
New ordinary final messages SHALL remain complete and untruncated; historical
truncation provenance SHALL remain unchanged.

#### Scenario: Worker publishes ordinary terminal state
- **WHEN** a non-terminal internal job first commits completed, interrupted, or failed state
- **THEN** an idempotently keyed completion event identifies both the internal job and stable Agent and uses the defined Agent-status mapping

#### Scenario: Hard reclaim closes physical lifecycle
- **WHEN** an exact hard-reclaim receipt becomes durable for an unknown Agent turn
- **THEN** one idempotent Agent-linked event projects `errored`/`worker_lost` without final assistant output or semantic settlement

#### Scenario: Reconciliation sees an event after a crash
- **WHEN** a terminal Agent lifecycle exists without its deterministic completion event
- **THEN** reconciliation appends the missing Agent-linked event once without duplicating an existing event

#### Scenario: Final output exceeds the completion bound
- **WHEN** a new ordinarily settled Agent turn's final output is larger than 64 KiB in UTF-8
- **THEN** the event retains the complete final message and records that the Plugin did not truncate it

#### Scenario: Legacy event was already truncated
- **WHEN** the runtime reads an existing event whose persisted truncation flag is true
- **THEN** it preserves that flag and stored prefix without claiming that discarded bytes were recovered

### Requirement: Completion requires native and execution-world settlement
An Agent-linked semantic completion SHALL be created only when the normalized
Driver result proves the native turn is terminal and all turn-owned execution
is settled or not applicable. A persistent Harness session, idle shell, or
reusable server MAY remain available after a turn; residency alone is not
outstanding work. Unknown, active, or contradictory settlement SHALL not
publish, freeze, or acknowledge a semantic result.

The sole non-semantic lifecycle exception is a one-hour `hard_reclaimed` event
backed by exact physical and lease-disposition receipts. It SHALL state
`settlement=unknown`, carry no assistant result or continuation, and SHALL NOT
be interpreted as completed work, failed model work, or lead acceptance.

#### Scenario: Persistent session is idle after a turn
- **WHEN** the native turn is terminal and its turn-owned commands are settled while the reusable session remains available
- **THEN** semantic completion is published and session continuity may be preserved independently

#### Scenario: Worker loss remains within quarantine
- **WHEN** no valid observation proves settlement and the one-hour hard-reclaim boundary has not committed
- **THEN** no lifecycle or semantic completion event is emitted and any preexisting payload remains unchanged

#### Scenario: Hard reclaim is delivered
- **WHEN** exact physical reclamation commits after the bound while native settlement is still unknown
- **THEN** only the resource-loss lifecycle event becomes deliverable and no semantic result is fabricated

## ADDED Requirements

### Requirement: Descriptor-bound hard reclaim wakes L0 as settlement uncertain
When the reclaimed initial Agent turn carries a previously validated terminal
event descriptor, HarnessDock SHALL attempt the existing immutable external
publication only after the hard-reclaim receipt and Agent-linked lifecycle event
are durable. The envelope SHALL be `worker_terminal` with outcome
`settlement_uncertain`; it SHALL NOT be `completed`, `failed`, `cancelled`, or
`delivered`. Publication is an explicit wake hint that may start a billed L0
turn, never a HarnessDock completion or acceptance claim.

#### Scenario: Bound unknown Agent is hard-reclaimed
- **WHEN** its exact hard-reclaim and `worker_lost` lifecycle event are durable
- **THEN** HarnessDock publishes one idempotent `settlement_uncertain` envelope and L0 remains responsible for targeted reconciliation

#### Scenario: Reclaim has no descriptor
- **WHEN** an ordinary Agent without a terminal-event binding is hard-reclaimed
- **THEN** its durable `worker_lost` event remains available to the next natural L0 operation and no external wake is attempted

#### Scenario: External publication fails
- **WHEN** Wake publication rejects or is unavailable after hard reclaim is durable
- **THEN** HarnessDock records the bounded publication failure without changing lease disposition, Agent state, or semantic settlement and does not add a fallback wake path
