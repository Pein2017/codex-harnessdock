## ADDED Requirements

### Requirement: Capability provenance is closed and dimension-specific
Every route capability dimension SHALL carry exactly one provenance value: `checkout_declared`, `inspection_proven`, or `session_negotiated`. A Driver SHALL NOT label a capability `inspection_proven` without matching fresh native evidence or `session_negotiated` without evidence from the exact accepted native session; missing, foreign, or contradictory provenance SHALL fail coherence before use.

#### Scenario: Session-negotiated capability is not proven
- **WHEN** a route declares a capability as `session_negotiated` but the exact native session did not affirm it
- **THEN** the operation requiring that capability is refused without widening the value or falling back to checkout declaration

#### Scenario: Static topology policy is reported
- **WHEN** a Driver's public topology is constrained only by checkout-owned policy
- **THEN** its topology provenance is `checkout_declared` and is not presented as a native negotiation result

### Requirement: Fresh route projections replace whole catalogs
Each completed instance inspection SHALL be one internally coherent complete projection. A later inspection SHALL replace the earlier projection wholesale; no model, effort, capability, maturity, provenance, readiness, or generation field SHALL be merged from a prior inspection.

#### Scenario: One model disappears during refresh
- **WHEN** a fresh native inspection omits a model present in the prior inspection
- **THEN** the new projection contains no residue for that model and exact admission rejects it
