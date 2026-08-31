## MODIFIED Requirements

### Requirement: Plugin exposes one typed HarnessDock MCP server
The installed `codex_harnessdock` MCP server SHALL expose exactly the nine
canonical operation-specific tools, adding strict `dispatch_agents` without
replacing or relaxing singular spawn. The server SHALL retain trusted Codex
context, zero-argument `list_harnesses`, operation annotations, bounded error
redaction, and one lifecycle owner behind `runtime/index.mjs`.

#### Scenario: MCP catalog is loaded
- **WHEN** the dispatch generation initializes
- **THEN** exactly nine strict tools are visible and no generic command,
  scheduler, retry, cancel, session, endpoint, credential, or Driver tool exists

### Requirement: Public generation changes once for the unified surface
The ninth tool/Skill, rows schema, receipt, ledger integration, and release
contract SHALL use one MCP API generation subsequent to Change A. An older MCP
process SHALL fail before lifecycle work with the current restart-required
instruction. Existing durable Agents need no migration because no batch state
is persisted.

#### Scenario: Change-A task calls dispatch_agents
- **WHEN** its MCP process predates the batch generation
- **THEN** no row is preflighted or launched and the task is instructed to use
  a refreshed Plugin/new Codex task

## ADDED Requirements

### Requirement: Typed dispatch schema contains only complete spawn rows
`dispatch_agents` SHALL accept exactly `{ rows: [...] }`, where `rows` contains
1..8 strict objects. Every row SHALL require `task_name`, `message`, exact
admitted `harness`, full `model`, `reasoning_effort`, explicit `topology`, and
boolean `write`; it MAY accept only current singular-spawn `description` and
`target_worktree`. It SHALL reject `agent_name` input, duplicate task names,
unknown fields, shared/default/inherited route fields, Team/DAG/dependency/
retry/rollback/barrier/usage fields, and generic working-directory/session/
credential selectors.

#### Scenario: Two complete rows are supplied
- **WHEN** both state distinct task names and every explicit route/authority
  field
- **THEN** typed decoding succeeds without copying a field between rows

#### Scenario: A later row omits effort
- **WHEN** an earlier row states `reasoning_effort` but a later row does not
- **THEN** the whole call fails typed validation before service or lifecycle
  work

#### Scenario: Caller supplies agent_name instead of task_name
- **WHEN** a row attempts to address an existing or proposed public Agent
- **THEN** strict validation rejects adoption/aliasing before runtime mutation

### Requirement: Dispatch uses pure structural and bounded environment preflight
After strict decoding, dispatch SHALL first perform pure whole-array structural
validation with no service or lifecycle side effect. It SHALL then admit target
worktrees, reject currently existing root Agent names and deterministic
same-root batch writer conflicts, and obtain
fresh discovery/readiness once per exact canonical `(harness, executionRoot)`
pair before any Agent launch. Environment preflight MAY perform only the
existing spawn-authorized bounded local service ensure; it SHALL create no
Agent, mailbox, job, lease, native session, or model request. Any preflight
failure SHALL launch no row and SHALL not be described as atomic against later
concurrent-root or route changes.

#### Scenario: Structural preflight fails
- **WHEN** decoded rows conflict deterministically
- **THEN** every row is `not_attempted` and no service or lifecycle action runs

#### Scenario: OpenCode needs its managed local service
- **WHEN** a structurally valid OpenCode row requires the existing bounded
  service ensure for fresh discovery
- **THEN** preflight may ensure that service while still creating no Agent,
  native session, or model turn

#### Scenario: One route is unavailable
- **WHEN** environment preflight cannot admit one exact row
- **THEN** no row launches; the failing row has sanitized reason and all other
  rows state `batch_preflight_stopped`

#### Scenario: A requested name already belongs to this root
- **WHEN** environment preflight observes an existing Agent under that
  deterministic public name
- **THEN** no row launches and the batch does not adopt, replace, or skip the
  existing Agent

### Requirement: Row launch repeats authoritative final gates
Passing preflight SHALL reserve nothing. Each caller-ordered row SHALL use the
same internal lifecycle owner as singular spawn and repeat final target-owner,
name, route/provenance drift, lease/capacity, and Driver pre-submit/pre-session
checks. Fresh call-local discovery MAY be reused only for an exactly equal
canonical `(harness, executionRoot)` and SHALL not replace those checks or
persist across calls.

#### Scenario: Another root wins the writer lease after preflight
- **WHEN** row launch reaches final writer admission
- **THEN** that row reports its authoritative non-launched disposition without
  rolling back an earlier row or claiming preflight atomicity

#### Scenario: Same Harness targets two roots
- **WHEN** two rows share Harness but not canonical execution root
- **THEN** environment preflight performs distinct fresh discovery/readiness
  observations

### Requirement: Dispatch receipt is ordered, bounded, and row-local
The result SHALL contain exactly ordered `rows`. Every result row SHALL contain
derived public `agent_name`, boolean `agent_exists`, and one closed outcome
`launched | rolled_back | lifecycle_owned | ownership_uncertain |
not_attempted`. `agent_exists` SHALL be true for launched/lifecycle-owned/
uncertain rows and false otherwise. Only `launched` MAY carry the current Agent
Card; other rows MAY carry only bounded sanitized stop/error evidence. No batch
ID, aggregate success, completion, provider usage, cost, prompt, target path,
or private runtime identity is exposed.

#### Scenario: Cancellation arrives during a row
- **WHEN** the current row finishes its Change A ownership classification
- **THEN** its exact result is returned and every later row is
  `not_attempted` with cancellation stop evidence

#### Scenario: Response transport is lost
- **WHEN** the caller cannot receive an otherwise durable partial result
- **THEN** no replay safety is inferred; deterministic public names and existing
  Agent operations remain the only reconciliation path
