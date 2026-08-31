## ADDED Requirements

### Requirement: Initial Agent turn may bind one terminal publisher descriptor

The strict `spawn_agent` schema and each strict `dispatch_agents` row SHALL
accept one optional `terminal_event_descriptor_path` in addition to their
existing explicit route, authority, description, and target-worktree fields.
The value MUST be an absolute path to a private local worker publisher
descriptor. It SHALL bind only the initial Agent turn created by that request,
SHALL NOT be inherited or defaulted across dispatch rows, and SHALL remain an
unknown field for `send_message`, `followup_task`, and every other operation.

#### Scenario: Singular spawn binds a terminal descriptor
- **WHEN** a complete spawn request supplies one absolute
  `terminal_event_descriptor_path`
- **THEN** strict decoding preserves that path only for the proposed initial
  Agent turn and copies no route or descriptor field from another request

#### Scenario: Dispatch rows bind distinct descriptors
- **WHEN** two complete dispatch rows each supply their own descriptor path
- **THEN** strict decoding preserves the row-local bindings without inheritance,
  aliasing, or a shared batch descriptor

#### Scenario: Follow-up supplies a terminal descriptor
- **WHEN** `followup_task` or `send_message` supplies
  `terminal_event_descriptor_path`
- **THEN** strict validation rejects the unknown field before mailbox, Agent,
  job, or native-session mutation

#### Scenario: Descriptor path is relative
- **WHEN** singular spawn or a dispatch row supplies a relative descriptor path
- **THEN** admission rejects it before Agent reservation or model work

### Requirement: Terminal descriptor preflight precedes Agent ownership

When a terminal descriptor is requested, the runtime SHALL resolve only the
configured wake publisher executable and runtime root, invoke the publisher's
read-only descriptor preflight with the deterministic proposed Agent name, and
require a compatible redacted receipt before creating an Agent, mailbox, job,
lease, native session, or model request. HarnessDock SHALL retain only the
descriptor path and bounded redacted binding identity; it MUST NOT parse, copy,
log, expose, or persist the bearer token. A `dispatch_agents` descriptor failure
is a whole-array preflight failure and SHALL launch no row.

#### Scenario: Descriptor preflight succeeds
- **WHEN** the configured publisher validates the private descriptor against the
  exact proposed Agent name and selected runtime root
- **THEN** spawn may continue through the existing authoritative final gates
  while retaining only redacted binding evidence

#### Scenario: Publisher executable is unavailable
- **WHEN** a descriptor-bound request cannot resolve or execute the configured
  publisher preflight
- **THEN** the request fails before Agent ownership or model work and no shell,
  provider, or unmonitored fallback is attempted

#### Scenario: Descriptor belongs to another Agent
- **WHEN** preflight reports that the frozen producer task differs from the
  deterministic proposed Agent name
- **THEN** the request fails before lifecycle mutation without exposing either
  producer bearer or private descriptor contents

#### Scenario: One dispatch descriptor fails preflight
- **WHEN** any structurally valid row fails descriptor preflight
- **THEN** every row is `not_attempted` under the existing ordered batch receipt
  and no Agent or model turn launches

### Requirement: Descriptor binding advances the public MCP generation once

The optional singular and batch fields, their strict validation, Skills, and
runtime wiring SHALL ship under one MCP API generation subsequent to the current
dispatch/progress generation. Existing Agents and completion events require no
storage migration. An older MCP process SHALL fail before lifecycle work with
the existing restart-required instruction.

#### Scenario: Older task supplies a terminal descriptor
- **WHEN** its MCP process predates the descriptor generation
- **THEN** no descriptor is inspected and no Agent launches; the caller receives
  the existing new-task restart boundary

#### Scenario: Spawn receipt succeeds with a descriptor
- **WHEN** descriptor-bound spawn completes its existing durable background
  handoff
- **THEN** the public Agent Card remains exactly `agent_name`, `model`, and
  `status` and does not echo descriptor, monitor, reservation, token, runtime,
  or terminal-event fields
