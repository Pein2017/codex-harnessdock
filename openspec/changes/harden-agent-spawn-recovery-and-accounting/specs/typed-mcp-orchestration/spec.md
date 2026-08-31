## MODIFIED Requirements

### Requirement: MCP call boundaries preserve asynchronous Agents and explicit joins
The MCP adapter SHALL propagate caller cancellation to singular spawn and wait
observations. A cancelled spawn SHALL stop promptly only at a boundary where no
Agent/worker/native ownership can have been created. If cancellation is
observed after launch may have begun, the adapter/runtime SHALL obtain the
existing handoff disposition before returning or losing transport and SHALL
NOT interrupt, signal, delete, archive, roll back, or otherwise change a
non-rollback-safe Agent. Existing successful asynchronous spawn and fixed-wait
semantics remain unchanged.

#### Scenario: Parent cancels before spawn reservation
- **WHEN** the abort signal is observed before durable identity or launch
- **THEN** the operation exits promptly without Agent or model side effects

#### Scenario: Parent cancels during handoff
- **WHEN** the abort signal is observed while one worker/native submission may
  already be gaining ownership
- **THEN** that handoff reaches `rollback_safe`, `lifecycle_owned`, or
  `ownership_uncertain` under its existing owner before the adapter returns

#### Scenario: Parent cancels a wait call
- **WHEN** Codex cancels an in-flight `wait_agent` MCP request
- **THEN** the observation exits promptly while the Agent and active turn remain
  unchanged

### Requirement: MCP errors redact private runtime identity
Model-facing MCP errors SHALL preserve actionable public categories and
recovery actions while excluding native session identifiers, internal
Agent/job/instance/config identifiers, absolute runtime-state paths,
credentials, prompts, and raw provider errors. A non-rollback-safe spawn error
SHALL be represented as an error result whose structured fields are exactly the
stable public `agent_name`, closed `lifecycle_owned | ownership_uncertain`
outcome, bounded public code, and sanitized message. Pre-identity failures
SHALL not invent `agent_name`; successful spawn SHALL retain its current Agent
Card rather than using this error projection.

#### Scenario: Duplicate-name error contains an internal registry ID
- **WHEN** the registry reports a conflict using public and internal identity
- **THEN** the MCP error retains only the public Agent name/path and actionable
  conflict category

#### Scenario: Non-rollback-safe failure remains an error
- **WHEN** singular spawn returns `lifecycle_owned` or
  `ownership_uncertain` after an error
- **THEN** the MCP result is observably failed but carries only the four bounded
  recovery fields

#### Scenario: Transport disappears before the error result is delivered
- **WHEN** the caller disconnects after durable Agent identity exists
- **THEN** durable Agent state remains authoritative and no request replay,
  replacement Agent, or destructive cleanup is inferred

### Requirement: Public generation changes once for the unified surface
The structured non-rollback-safe spawn failure and cancellation propagation
SHALL use one MCP API generation after the Required Baseline. An older MCP
process SHALL fail with the current restart-required error before an operation;
release acceptance SHALL require a refreshed Plugin and new Codex task. Older
durable Agents and frozen completion facts SHALL remain readable without
rewriting them. A later batch-dispatch change SHALL use a subsequent generation.

#### Scenario: Old task calls the recovery generation
- **WHEN** its MCP process predates Change A
- **THEN** no lifecycle operation runs and the task receives the bounded
  restart-required instruction
