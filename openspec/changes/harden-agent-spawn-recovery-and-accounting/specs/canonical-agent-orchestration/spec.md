## MODIFIED Requirements

### Requirement: spawn_agent creates identity and starts the first turn
`spawn_agent` SHALL retain the current complete explicit route, authority,
target-worktree, successful Agent Card, and asynchronous first-turn behavior.
Validation or cancellation proven before durable Agent reservation SHALL fail
without creating an Agent, message, job, native session, or model request. Once
worker/native launch may have begun, only the existing handoff disposition may
authorize rollback. A non-rollback-safe failure SHALL remain a failure while
exposing the stable public `agent_name` and exact `lifecycle_owned` or
`ownership_uncertain` outcome for reconciliation; it SHALL preserve the Agent,
mailbox, job, and leases required by that disposition.

#### Scenario: Cancellation is observed before reservation
- **WHEN** the MCP caller cancels before Agent identity or native ownership can
  exist
- **THEN** spawn exits without creating lifecycle state or starting model work

#### Scenario: Cancellation races accepted handoff
- **WHEN** cancellation arrives after worker/native launch may have begun
- **THEN** spawn finishes the existing handoff classification, never interrupts
  the turn or guesses rollback, and preserves every non-rollback-safe owner

#### Scenario: Lifecycle ownership is known after a spawn error
- **WHEN** a post-launch operation errors but durable evidence proves
  `lifecycle_owned`
- **THEN** the public failure contains the stable `agent_name` and that outcome
  while the ordinary Agent remains independently joinable and controllable

#### Scenario: Ownership cannot be proven
- **WHEN** worker/native launch may have occurred but neither ownership nor safe
  rollback can be proven
- **THEN** the public failure contains `agent_name` and
  `ownership_uncertain`, and durable reconciliation retains the Agent and leases

#### Scenario: Route validation rejects before identity
- **WHEN** the complete stated route, target worktree, or readiness is rejected
  before Agent reservation
- **THEN** the error exposes no invented Agent name and performs no fallback or
  model substitution
