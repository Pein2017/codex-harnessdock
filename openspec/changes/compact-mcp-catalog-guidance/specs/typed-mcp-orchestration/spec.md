## MODIFIED Requirements

### Requirement: Model-visible orchestration guidance is compact without losing the public contract
The installed Plugin SHALL expose the same eight MCP tools, strict schemas, safety boundaries, exact-route fields, fixed-wait semantics, completion-token behavior, lifecycle distinctions, annotations, and public receipts using a compact guidance surface. The deterministic JSON serialization of the discovered eight-tool `tools` array SHALL contain no more than 4,500 characters, and the aggregate characters in every tool or nested input-schema `description` value in that array SHALL contain no more than 800 characters. Detailed operation guidance SHALL live once in the owning Skill instead of being repeated in tool and field descriptions. These static bounds SHALL NOT delete, rename, default, widen, narrow, reorder, or otherwise alter a callable field, required set, enum, refinement, annotation, strictness, error code, or receipt; they make no claim about dynamic call-token savings.

#### Scenario: Codex discovers HarnessDock tools
- **WHEN** the installed MCP server exposes its tool catalog
- **THEN** the eight names, schemas, annotations, callable fields, and receipts remain unchanged while the deterministic serialized catalog and aggregate description text satisfy their respective character bounds

#### Scenario: Guidance compaction is proposed
- **WHEN** a wording deletion would remove an exact model/effort requirement, authority boundary, target-worktree constraint, completion-delivery rule, or fail-closed condition
- **THEN** acceptance rejects the deletion even if the size budgets would pass

#### Scenario: Verbose wording returns
- **WHEN** a test restores the prior verbose description text to the discovered catalog
- **THEN** the deterministic catalog or description budget check fails

### Requirement: MCP wait guidance matches the fixed public schema
Model-facing tool descriptions, server instructions, Skills, and release smoke SHALL call `wait_agent` without a timeout argument and SHALL describe its fixed one-hour completion-first wait plus conditional completion-token acknowledgement. They SHALL distinguish `list_agents` as a logical state view rather than completion/progress delivery and SHALL prohibit list/history probes made solely after a quiet wait timeout. Model-facing wait guidance SHALL state that `wake_on_progress: true` may accompany `targets` only when exactly one exact current-root target is supplied, and SHALL continue to reject a progress-enabled target set with two or more targets.

#### Scenario: Paid smoke joins a test Agent
- **WHEN** the explicitly enabled Haiku/low release smoke waits for its Agent
- **THEN** it sends only arguments accepted by the current `wait_agent` schema

#### Scenario: Parent considers list after timeout
- **WHEN** an ordinary wait returns a quiet timeout and required Agent work remains unresolved
- **THEN** model-facing guidance directs another completion-first wait rather than `list_agents`, `read_agent_messages`, or unchanged-state narration

#### Scenario: Guidance presents a one-target progress wait
- **WHEN** the wait-agent metadata describes a targeted progress observation
- **THEN** it permits exactly one target with `wake_on_progress: true` and does not state that every target array is incompatible with progress wakeup

#### Scenario: Guidance presents a multi-target progress wait
- **WHEN** the wait-agent metadata describes two or more targets with `wake_on_progress: true`
- **THEN** it directs a completion-only barrier or rejects that progress-enabled combination rather than describing it as valid
