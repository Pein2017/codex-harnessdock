## MODIFIED Requirements

### Requirement: First-turn failure does not create an unusable silent mailbox
The runtime SHALL preserve the existing complete pre-reservation validation,
empty-reservation concurrency guards, and handoff-disposition rollback rules.
Cancellation before durable identity SHALL create no Agent or mailbox. After an
Agent exists, only a structured `rollback_safe` disposition may remove its name
and first message under the existing guards. `lifecycle_owned` and
`ownership_uncertain` SHALL retain Agent identity, mailbox assignment, active
job, continuation evidence, and leases even when the MCP caller cancels or
cannot receive the result. Their public failure projection SHALL expose the
stable Agent name without exposing the internal Agent ID.

#### Scenario: Cancellation precedes Agent creation
- **WHEN** the abort signal is observed before reservation
- **THEN** no Agent name or mailbox entry is created

#### Scenario: Prepared activation is proven rollback-safe
- **WHEN** launch did not create an OS worker/native submission and the existing
  concurrency guards permit rollback
- **THEN** the Agent reservation and sole first message may be removed

#### Scenario: Cancellation follows possible handoff
- **WHEN** Agent identity exists and the handoff is `lifecycle_owned` or
  `ownership_uncertain`
- **THEN** identity and mailbox remain durable and the public failure names the
  Agent for later join, listing, or reconciliation
