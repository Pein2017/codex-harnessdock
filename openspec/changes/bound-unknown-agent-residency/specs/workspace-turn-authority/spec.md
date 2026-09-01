## MODIFIED Requirements

### Requirement: Writer lease release requires settled execution evidence
The writer lease SHALL normally release only after terminal native state and
settled turn-owned execution are proven. Worker loss, failed interruption,
unknown remote state, or contradictory mutation evidence SHALL retain the lease
before the hard-reclaim boundary and surface an operator-actionable blocked
condition.

After one hour of durable unknown settlement, an exact hard-reclaim receipt MAY
release the writer lease only when every mutation-capable process or managed
service/turn scope bound to that attempt is proven dead. Worker death alone is
insufficient for a service-backed turn, and a reused/operator-owned service
whose turn scope remains unproven SHALL keep the writer lease. No model-facing
operation SHALL force-clear a writer lease.

#### Scenario: Worker disappears after write-capable input acceptance
- **WHEN** the Driver cannot prove whether the native turn or its commands settled and the hard-reclaim proof is incomplete
- **THEN** the writer lease remains held and later write turns fail closed

#### Scenario: Local mutation-capable tree is proven dead
- **WHEN** the worker and exact Driver-owned process tree are all proven dead after the one-hour bound
- **THEN** the matching writer lease may release with a hard-reclaim receipt while semantic settlement remains unknown

#### Scenario: Reused service may still mutate
- **WHEN** the exact worker is dead but a reused/operator-owned service may still execute the accepted write-capable turn
- **THEN** the writer lease remains held for operator reconciliation even if the admission-capacity lease is released
