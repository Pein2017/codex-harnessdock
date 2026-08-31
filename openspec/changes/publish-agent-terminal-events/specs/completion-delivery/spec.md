## ADDED Requirements

### Requirement: Descriptor-bound Agent turn publishes one external terminal event

For an initial Agent turn whose route froze a validated terminal publisher
descriptor, the runtime SHALL attempt exactly one immutable external
`worker_terminal` publication only after its deterministic Agent-linked
completion event is durably present. It SHALL map Agent `completed` to worker
`completed`, Agent `errored` to worker `failed` with bounded reason, and Agent
`interrupted` to worker `cancelled` with bounded reason. If terminal settlement
is explicitly unverifiable under an existing closed reason, it SHALL publish
`settlement_uncertain` rather than claim completion or failure certainty. It
MUST NOT publish `delivered`, a candidate commit, task success, or lead
acceptance.

#### Scenario: Agent completes normally
- **WHEN** a descriptor-bound initial Agent turn durably publishes its completed
  Agent-linked completion
- **THEN** the runtime publishes one matching external `completed` envelope with
  the exact Agent name as producer and no candidate commit

#### Scenario: Agent fails
- **WHEN** a descriptor-bound initial Agent turn durably publishes an errored
  completion
- **THEN** the runtime publishes one external `failed` envelope with bounded
  failure classification and no candidate or acceptance claim

#### Scenario: Agent is interrupted
- **WHEN** a descriptor-bound initial Agent turn durably publishes an
  interrupted completion
- **THEN** the runtime publishes one external `cancelled` envelope with bounded
  interruption classification

#### Scenario: Terminal settlement remains unverifiable
- **WHEN** the existing runtime reaches a closed terminal uncertainty outcome
  for the descriptor-bound turn
- **THEN** it publishes `settlement_uncertain` with the corresponding bounded
  reason instead of inventing a HarnessDock completion or external success

#### Scenario: Progress arrives before terminal completion
- **WHEN** a descriptor-bound Agent publishes one or more safe progress updates
- **THEN** no terminal envelope is published and progress remains owned by the
  existing opt-in progress delivery surface

### Requirement: External terminal publication is restart-safe and completion-neutral

The runtime SHALL persist enough redacted binding and publication identity to
repair a missing terminal publication from the same deterministic completion
without changing completion content, delivery token, acknowledgement cursor,
Agent projection, or lifecycle status. An identical retry SHALL be idempotent;
a conflicting rewrite SHALL fail closed. Publication failure SHALL be recorded
as bounded operator evidence and SHALL NOT withhold, rewrite, acknowledge, or
fabricate HarnessDock completion.

#### Scenario: Runtime crashes after external publish
- **WHEN** the publisher accepted the terminal envelope but HarnessDock crashed
  before recording its local publication marker
- **THEN** reconciliation retries the byte-equivalent envelope and the publisher
  returns its original immutable event idempotently

#### Scenario: Runtime crashes before external publish
- **WHEN** Agent completion is durable but no publication attempt was recorded
- **THEN** reconciliation attempts the deterministic terminal envelope once
  without creating another completion event or Agent turn

#### Scenario: External publisher rejects the terminal envelope
- **WHEN** publication fails after authoritative HarnessDock completion is
  durable
- **THEN** completion remains fully deliverable through `wait_agent`, the failure
  is retained as bounded diagnostic evidence, and no automatic retry loop,
  fallback wake path, or model work is started

#### Scenario: Completion is delivered to L0
- **WHEN** wake-me-up later activates L0 and targeted `wait_agent` returns the
  already durable HarnessDock completion
- **THEN** the existing complete message, frozen payload, and delivery token are
  unchanged and acknowledgement still occurs only when that token is echoed in
  a later wait

#### Scenario: Turn has no terminal descriptor
- **WHEN** an ordinary Agent turn reaches completion without a frozen descriptor
- **THEN** completion delivery behaves exactly as before and no wake publisher
  executable or external event state is consulted
