# typed-mcp-orchestration Specification

## Purpose

Define the typed Codex MCP transport for the eight checkout-owned HarnessDock
Agent operations without creating another lifecycle or session owner.
## Requirements
### Requirement: Plugin exposes one typed HarnessDock MCP server
The installed Plugin SHALL declare one required local stdio MCP server named `codex_harnessdock`. The server SHALL expose exactly `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `read_agent_messages`, and `list_harnesses`, with strict operation-specific input schemas and no generic command, terminal, job, cancellation, deletion, cross-root, native-session, executable, endpoint, credential, or Driver-module tool.

#### Scenario: Codex loads the new generation
- **WHEN** the selected Plugin MCP server initializes successfully
- **THEN** its tool catalog contains exactly the eight canonical snake_case operations

#### Scenario: Caller supplies an unknown field
- **WHEN** a tool call contains a field outside that operation's public schema
- **THEN** the call fails before durable runtime state or Harness service state changes

### Requirement: Typed spawn schema exposes only lead decisions
The typed `spawn_agent` schema SHALL require `task_name`, `message`, exact admitted `harness`, explicit full `model`, explicit `topology`, and boolean `write`. It SHALL expose only optional `description` and Driver-discriminated `reasoning_effort`. The typed `followup_task` schema SHALL expose only `target`, `message`, and optional Driver-admitted `reasoning_effort`; it SHALL inherit every immutable route field and SHALL NOT accept authority mutation. Both SHALL reject `allowed_tools`, `scope`, and `questions`; spawn SHALL also reject `delegation_mode`, `fork_turns`, `execution_profile`, working-directory, environment-file, instance, endpoint, credential, native-session, permission-mode, and dangerous-bypass fields as unknown public inputs.

#### Scenario: Minimal explicit Claude spawn is submitted
- **WHEN** Codex supplies task name, message, `harness=claude-code`, exact Claude model, explicit topology, and explicit write boolean
- **THEN** typed validation accepts the request without an instance, profile, tool list, or execution selector

#### Scenario: Minimal explicit OpenCode spawn is submitted
- **WHEN** Codex supplies task name, message, `harness=opencode`, model `opencode-go/deepseek-v4-flash`, `topology=leaf`, and `write=false`
- **THEN** typed validation passes the exact route to Driver validation without inferring any field

#### Scenario: Harness or topology is omitted
- **WHEN** spawn lacks either required field even when only one route appears ready
- **THEN** typed validation rejects the call before readiness or durable mutation

#### Scenario: Follow-up attempts a route or authority field
- **WHEN** follow-up supplies `harness`, `model`, `topology`, or `write`
- **THEN** strict validation rejects it before mailbox mutation

#### Scenario: Caller supplies repository policy fields
- **WHEN** spawn or follow-up supplies generic `scope` or `questions`
- **THEN** strict validation rejects them and Codex places any task-specific constraints in the bounded message instead

### Requirement: Typed activation exposes one immutable behavioral authority
The typed `spawn_agent` tool SHALL require boolean `write`, which maps once to `behavioral_read_only` or `behavioral_write` on the immutable Agent route. False SHALL impose the strongest reviewed Driver-specific no-mutation boundary and truthfully report its enforcement; true SHALL be admitted only by routes that support mutation. `followup_task` SHALL inherit this value and expose no permission switch. The MCP adapter SHALL NOT reinterpret authority, grant a Driver permission, or claim a filesystem sandbox.

#### Scenario: Read-only OpenCode activation is requested
- **WHEN** the exact Explorer route supplies `write: false`
- **THEN** the runtime freezes behavioral read-only authority and validates the configured Explorer profile before session creation

#### Scenario: Follow-up omits authority
- **WHEN** any v3 Agent receives a valid follow-up
- **THEN** the turn inherits the Agent's immutable authority rather than the latest job or a default

### Requirement: MCP annotations reflect reconciliation effects
MCP tool annotations SHALL describe observable runtime effects rather than treating logically observational output as proof of a zero-write implementation. `list_agents` SHALL advertise `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true` because it can persist convergent owner-scoped reconciliation repairs without consuming completion delivery.

#### Scenario: Host discovers list_agents
- **WHEN** Codex reads the typed tool catalog
- **THEN** `list_agents` is advertised as non-read-only, non-destructive, and idempotent

#### Scenario: Caller repeats list_agents
- **WHEN** no new lifecycle evidence appears between repeated calls
- **THEN** reconciliation converges on the same logical Agent projection without acknowledging completion delivery

### Requirement: MCP calls bind only trusted Codex context
Every lifecycle tool call SHALL require a non-empty Codex `_meta.threadId` and a local `file:` workspace URI in `_meta["codex/sandbox-state-meta"].sandboxCwd`. The adapter SHALL use those values as the owner root and workspace and SHALL NOT accept their equivalents in tool arguments, process cwd, inherited stale identity, Plugin Cache paths, or Claude session identifiers.

#### Scenario: Trusted call context is complete
- **WHEN** Codex supplies a thread ID and local sandbox workspace URI
- **THEN** the adapter invokes the public runtime for that exact logical root and canonical workspace

#### Scenario: Root identity is absent
- **WHEN** `_meta.threadId` is missing or empty
- **THEN** the call fails before reading or mutating an Agent registry

#### Scenario: Workspace metadata is absent or non-local
- **WHEN** sandbox-state metadata is missing, malformed, non-file, or not convertible to a native local path
- **THEN** the call fails instead of using the MCP server process cwd or Plugin Cache root

### Requirement: MCP adapter preserves one lifecycle owner
The MCP server SHALL validate trusted Codex context and delegate every accepted call to the matching operation returned by checkout-owned `runtime/index.mjs` in a fresh isolated module graph. It SHALL NOT persist or reconstruct Agents, jobs, mailboxes, completion cursors, Claude sessions, worker identities, or recovery state outside the existing runtime owners. A test-only injected runtime factory MAY execute in-process without changing production behavior.

#### Scenario: Compatible runtime changes while MCP remains running
- **WHEN** a lifecycle implementation module changes without changing the public MCP API generation
- **THEN** the next operation runs in a fresh worker module graph and observes the compatible change

#### Scenario: MCP server restarts
- **WHEN** Codex restarts the stdio MCP process between lifecycle calls
- **THEN** subsequent calls recover entirely from existing durable runtime state without an MCP-local registry

#### Scenario: Public generation mismatch
- **WHEN** the current checkout generation differs from the MCP process generation
- **THEN** the worker returns `HARNESSDOCK_MCP_RESTART_REQUIRED`, performs no lifecycle operation, and instructs the caller to run a versioned refresh and start a new Codex task

#### Scenario: Wait observation is cancelled
- **WHEN** Codex cancels an in-flight isolated `wait_agent` call
- **THEN** the worker observation receives an abort signal and exits without interrupting or deleting the Agent or its Claude turn

### Requirement: MCP call boundaries preserve asynchronous Agents and explicit joins
`spawn_agent` and an activating `followup_task` SHALL return after the existing durable background handoff rather than waiting for Claude completion. Model-facing `wait_agent` SHALL remain a synchronous bounded observation with a fixed 3600000 ms upper bound injected behind its strict public schema, SHALL NOT expose per-call timeout selection, SHALL return early for completion, and SHALL return early for advisory progress only when the caller explicitly sets `wake_on_progress: true`. The checkout CLI and public runtime operation SHALL retain explicit bounded timeout selection for operator diagnostics and tests. Cancelling the MCP request SHALL stop only the in-flight observation and SHALL NOT interrupt, cancel, archive, delete, or otherwise change the Agent.

#### Scenario: Spawn starts background work
- **WHEN** `spawn_agent` durably hands its prepared turn to a worker
- **THEN** the MCP call returns the existing Agent acknowledgement while Claude continues independently

#### Scenario: Wait observes completion early
- **WHEN** completion becomes eligible before the fixed model-facing wait deadline
- **THEN** the MCP call returns the complete stored completion without waiting for the upper bound

#### Scenario: Wait explicitly observes progress early
- **WHEN** eligible progress becomes available before the fixed model-facing wait deadline and `wake_on_progress: true`
- **THEN** the MCP call returns one safe progress update without changing the Agent turn

#### Scenario: Model supplies a timeout override
- **WHEN** a model-facing `wait_agent` request includes `timeout_ms`
- **THEN** the strict MCP schema rejects the unknown field without changing Agent, completion, or progress state

#### Scenario: Operator uses an explicit diagnostic timeout
- **WHEN** the checkout CLI or direct runtime test supplies a timeout within the retained 0..3600000 ms diagnostic bound
- **THEN** that non-MCP observation uses the requested bound without changing Agent execution lifetime

#### Scenario: Parent cancels a wait call
- **WHEN** Codex cancels an in-flight `wait_agent` MCP request
- **THEN** the observation exits promptly while the Agent and its active Claude turn remain unchanged

### Requirement: MCP receipts remain complete and structured
Successful MCP tools SHALL return the matching operation's complete bounded public runtime receipt as structured content with a JSON text representation for protocol clients. Spawn SHALL expose only `agent_name`, `model`, and `status`; follow-up SHALL expose only `agent_name` and `delivery`; interrupt SHALL expose only `agent_name` and operation `status`. Other operation-specific receipts, including complete wait completion delivery, SHALL remain unchanged. The MCP adapter SHALL NOT supplement a compact receipt with internal Agent, message, job, steering, session, or persistence evidence. Runtime validation, compatibility, subscription-limit, continuation, and recovery errors SHALL remain actionable while excluding arbitrary environment values, raw private state, and foreign-root evidence.

#### Scenario: Spawn succeeds
- **WHEN** the runtime returns a durable spawn receipt
- **THEN** the MCP result contains exactly `agent_name`, `model`, and `status` without inventing another Agent or terminal session identifier

#### Scenario: Follow-up succeeds
- **WHEN** the runtime durably delivers or activates a follow-up
- **THEN** the MCP result contains exactly `agent_name` and `delivery`

#### Scenario: Interrupt succeeds
- **WHEN** the runtime completes an interruption request
- **THEN** the MCP result contains exactly `agent_name` and operation `status`

#### Scenario: Send succeeds with a compact receipt
- **WHEN** the runtime returns a bounded `send_message` receipt
- **THEN** the MCP result contains exactly that compact receipt in text and structured content without reconstructing the durable mailbox record

#### Scenario: Wait returns completion
- **WHEN** `wait_agent` returns an unread completion
- **THEN** the MCP result preserves the complete stored Agent final message and delivery token

#### Scenario: Runtime rejects a request
- **WHEN** an operation fails validation or reaches an actionable lifecycle boundary
- **THEN** the MCP call reports the sanitized runtime error and does not replace it with a generic success or fallback execution

### Requirement: Installed MCP bootstrap remains descriptor-only
The Plugin snapshot SHALL declare an absolute canonical checkout bootstrap and working directory for the `codex_harnessdock` stdio server. The current snapshot and every retained new-identity descriptor-only compatibility shell SHALL validate the fixed checkout and its production dependencies, then load `/data/CoordExp/codex-harnessdock/runtime/mcp-server.mjs` in the same Node process with the fixed checkout environment. They SHALL NOT retain a second resident child merely to relay inherited stdio. A pre-cutover `cc_for_pein` descriptor MAY exist only inside the explicit rollback backup and SHALL NOT remain enabled or discoverable after acceptance. No route SHALL import or execute an MCP lifecycle implementation from the Plugin Cache.

#### Scenario: New task starts installed MCP server
- **WHEN** Codex launches the installed HarnessDock Plugin's stdio command
- **THEN** one Node process validates and runs the canonical checkout MCP entry without a resident bootstrap child

#### Scenario: Retained new-identity descriptor starts installed MCP server
- **WHEN** an existing post-cutover task launches a relative bootstrap from a retained recent HarnessDock discovery shell
- **THEN** that descriptor validates and loads the canonical checkout MCP entry in its own process while preserving protocol framing

#### Scenario: Pre-cutover descriptor is observed after acceptance
- **WHEN** installed discovery still enables or advertises a `cc_for_pein` MCP descriptor
- **THEN** acceptance fails instead of treating that descriptor as a live compatibility alias

#### Scenario: Canonical checkout is unavailable
- **WHEN** the fixed checkout, MCP entrypoint, configuration, manifest, or production dependencies are missing or invalid
- **THEN** MCP startup fails closed with the checkout-specific recovery action without loading cached or upstream runtime code

### Requirement: MCP transport timeout exceeds the fixed model wait
The Plugin MCP declaration SHALL configure an outer tool-call timeout greater than 3600 seconds while the runtime SHALL retain its 3600000 ms maximum operator observation bound. Neither timeout SHALL define or shorten Agent execution lifetime.

#### Scenario: Model-facing wait reaches its upper bound
- **WHEN** no completion or explicitly eligible progress is available during the fixed 3600000 ms model-facing wait
- **THEN** the MCP transport leaves sufficient margin for the runtime to return an honest timeout before Codex ends the tool call

#### Scenario: Caller requests the maximum wait
- **WHEN** a checkout CLI or runtime observation uses the retained 3600000 ms maximum
- **THEN** the declared transport timeout still leaves a margin for that non-MCP observation's own bound without shortening Agent execution lifetime

### Requirement: MCP errors redact private runtime identity
Model-facing MCP errors SHALL preserve actionable public categories while excluding native Claude session identifiers, internal job identifiers, and absolute runtime-state paths.

#### Scenario: Session lease conflict contains native identity
- **WHEN** an internal lease error contains a Claude session identifier, job identifier, or absolute state path
- **THEN** the MCP response replaces those values with stable public wording and retains the recovery action

### Requirement: MCP wait guidance matches the fixed public schema
Model-facing tool descriptions, server instructions, Skills, and release smoke SHALL call `wait_agent` without a timeout argument and SHALL describe its fixed one-hour completion-first wait plus conditional completion-token acknowledgement. They SHALL distinguish `list_agents` as a logical state view rather than completion/progress delivery and SHALL prohibit list/history probes made solely after a quiet wait timeout.

#### Scenario: Paid smoke joins a test Agent
- **WHEN** the explicitly enabled Haiku/low release smoke waits for its Agent
- **THEN** it sends only arguments accepted by the current `wait_agent` schema

#### Scenario: Parent considers list after timeout
- **WHEN** an ordinary wait returns a quiet timeout and required Agent work remains unresolved
- **THEN** model-facing guidance directs another completion-first wait rather than `list_agents`, `read_agent_messages`, or unchanged-state narration

### Requirement: Typed wait schema permits one-target progress observation
The typed `wait_agent` schema SHALL accept `wake_on_progress: true` together with `targets` only when the array contains exactly one target. It SHALL continue to reject a progress-enabled target array containing two or more Agents before invoking the runtime, while leaving completion-only target barriers and untargeted progress waits unchanged.

#### Scenario: One target requests progress
- **WHEN** a model-facing call supplies one target and `wake_on_progress: true`
- **THEN** strict validation passes the fixed target observation to the public runtime with the fixed one-hour upper bound

#### Scenario: Multiple targets request progress
- **WHEN** a model-facing call supplies two or more targets and `wake_on_progress: true`
- **THEN** strict validation rejects the call before acknowledgement, delivery, or Agent state changes

#### Scenario: Barrier omits progress
- **WHEN** a model-facing call supplies one to eight valid targets and omits or disables progress wakeup
- **THEN** the existing fixed completion-only targeted join behavior is unchanged

### Requirement: list_harnesses exposes admitted route facts without selecting one
`list_harnesses` SHALL accept no model-facing arguments and SHALL return every statically admitted Harness, each bounded logical-instance readiness, `liveValidated`, Driver/capability maturity, and safely discoverable exact route constraints. It SHALL not start model work, mutate lifecycle state, choose a route, expose endpoint/credential/configuration identity, or imply that an unavailable Harness is removed from the static registry.

#### Scenario: OpenCode Server is unavailable
- **WHEN** Codex lists Harnesses
- **THEN** the response includes `opencode` as admitted but unavailable and leaves `claude-code` facts independent

### Requirement: MCP receipts preserve immutable route lineage
Spawn, list, targeted wait/barrier, completion, blocking, and Harness listing receipts SHALL expose only the bounded public Harness, full model, topology, behavioral authority, and maturity facts needed to distinguish routes. They SHALL exclude native session IDs, instance keys, endpoints, credentials, jobs, raw capability receipts, and private Server errors. The same model string under another Harness SHALL remain a distinct lineage.

#### Scenario: Mixed-Harness Agents are listed
- **WHEN** one root owns Claude and OpenCode Agents
- **THEN** each Agent card identifies its immutable public route without exposing native identities

### Requirement: Public generation changes once for the unified surface
The addition of required Harness/topology fields, immutable authority, route-qualified receipts, and `list_harnesses` SHALL use one new MCP API generation. An older MCP process SHALL fail with the current HarnessDock restart-required error before any operation, and acceptance SHALL require a versioned refresh and new Codex task. No intermediate generation SHALL expose defaulted or partially explicit multi-Harness spawn.

#### Scenario: Old task invokes list or spawn
- **WHEN** its MCP process generation predates the unified surface
- **THEN** the checkout performs no lifecycle operation and returns the restart-required instruction

### Requirement: Model-visible orchestration guidance is compact without losing the public contract
The installed Plugin SHALL expose the same eight MCP tools, strict schemas, safety boundaries, exact-route fields, fixed-wait semantics, completion-token behavior, and lifecycle distinctions using a compact guidance surface. The aggregate descriptions exposed for the eight MCP tools SHALL contain no more than 4,500 characters, the eight installed lifecycle Skill files SHALL contain no more than 12,000 bytes in aggregate, and the Plugin default-prompt strings SHALL contain no more than 800 characters in aggregate. Detailed operation guidance SHALL live once in the owning Skill instead of being repeated in every tool description.

#### Scenario: Codex discovers HarnessDock tools
- **WHEN** the installed MCP server exposes its tool catalog
- **THEN** the eight names and schemas remain unchanged and the aggregate exposed descriptions satisfy the 4,500-character bound

#### Scenario: Codex loads one lifecycle Skill
- **WHEN** a lifecycle operation requires its owning Skill
- **THEN** that Skill still states its exact invocation, authority, wait, error, and stop rules without requiring duplicated common prose from every other Skill

#### Scenario: Guidance compaction is proposed
- **WHEN** a wording deletion would remove an exact model/effort requirement, authority boundary, completion-delivery rule, or fail-closed condition
- **THEN** acceptance rejects the deletion even if the size budget would pass
