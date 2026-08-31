## MODIFIED Requirements

### Requirement: Plugin skills map directly to the canonical operations
The installed Plugin SHALL expose exactly nine one-to-one operation Skills and
typed MCP tools: existing singular `spawn_agent`, new `dispatch_agents`, and
the existing send, follow-up, wait, interrupt, list, history, and Harness-list
operations. `$codex-harnessdock:dispatch-agents` SHALL describe only stateless
ordered explicit-row launch; singular `$codex-harnessdock:spawn-agent` remains
the preferred one-Agent path. Neither Skill SHALL become an automatic route,
retry, Team, DAG, scheduler, or shell-fallback surface.

#### Scenario: New Codex task discovers the dispatch generation
- **WHEN** the installed Plugin and MCP generation match
- **THEN** all nine Skills and matching typed tools are present with distinct
  singular and batch semantics

#### Scenario: One Agent is required
- **WHEN** the lead has one independent assignment
- **THEN** guidance uses singular spawn rather than wrapping it in a one-row
  batch by default

## REMOVED Requirements

### Requirement: Public runtime exposes only eight canonical Agent operations
**Reason**: The public runtime intentionally gains the stateless
`dispatch_agents` convenience while preserving every existing operation.
**Migration**: Use the replacement nine-operation requirement in this same
capability after refreshing the Plugin and starting a new Codex task.

## ADDED Requirements

### Requirement: Public runtime exposes only nine canonical Agent operations
The public runtime SHALL expose `spawn_agent`, `dispatch_agents`,
`send_message`, `followup_task`, `wait_agent`, `interrupt_agent`,
`list_agents`, `read_agent_messages`, and `list_harnesses` as its complete
model-facing lifecycle surface. No Team, batch-resume, DAG, scheduler, route
default, retry, provider-usage, job, server, session, endpoint, credential,
cancel, delete, or worktree-creation operation is added.

#### Scenario: Runtime surface is enumerated
- **WHEN** the dispatch generation is loaded
- **THEN** exactly the nine canonical operations exist and singular spawn/list/
  wait behavior remains independently callable

### Requirement: dispatch_agents is a stateless ordered launch convenience
`dispatch_agents` SHALL accept only 1..8 ordered complete explicit singular-
spawn rows and SHALL create no durable batch identity, parent Agent, Team, DAG,
scheduler, dependency, retry, shared route, or cross-row transaction. It SHALL
return caller-order row results and leave every Agent that exists as an ordinary
independently controlled Agent.

#### Scenario: Rows select different exact routes
- **WHEN** the caller states complete distinct routes for independent rows
- **THEN** each row is admitted and launched only under its own immutable route
  with no shared model or authority decision

#### Scenario: Caller retries a partially executed request
- **WHEN** some deterministic public Agent names already exist
- **THEN** dispatch does not skip, adopt, replace, or retry them; the caller
  reconciles existing Agents and submits only genuinely unattempted work

### Requirement: dispatch_agents preserves row ownership and stop boundaries
Dispatch SHALL preserve Change A's row-authoritative `launched`,
`rolled_back`, `lifecycle_owned`, and `ownership_uncertain` outcomes. It SHALL
mark rows that never begin as `not_attempted`, continue only after outcomes
whose ownership is known, stop after the first `ownership_uncertain`, and
never roll back a prior row. Cancellation during a row SHALL settle that row's
Change A disposition before later rows become `not_attempted`.

#### Scenario: Rollback-safe row precedes valid work
- **WHEN** one row is proven safely rolled back
- **THEN** its result is `rolled_back` and the next ordered row may begin

#### Scenario: Lifecycle-owned row returns an error disposition
- **WHEN** launch reports `lifecycle_owned`
- **THEN** its Agent remains independently joinable/controllable and the next
  ordered row may begin

#### Scenario: Ownership becomes uncertain
- **WHEN** one row reports `ownership_uncertain`
- **THEN** that public Agent is retained and every later row is
  `not_attempted`
