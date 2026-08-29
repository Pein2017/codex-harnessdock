## ADDED Requirements

### Requirement: Native inspection evidence is durable but not a route selector
An accepted turn SHALL retain a bounded opaque inspection generation and capability provenance used to admit it. Those facts SHALL be receipt evidence only: callers cannot supply them, and a changed generation SHALL NOT by itself mutate the Agent's immutable Harness/model/effort/topology/authority route, delete history, replay work, or select a replacement route.

#### Scenario: Configuration generation changes but exact route remains valid
- **WHEN** fresh inspection observes a different safe native generation while the persisted exact tuple and required capabilities are still admitted
- **THEN** the operation may continue under the same immutable route and records the new observation without pretending the old generation was used

#### Scenario: Exact persisted route disappears
- **WHEN** a generation change removes the persisted model/effort tuple or narrows a required capability
- **THEN** the operation fails closed before native submission and retains existing durable Agent state
