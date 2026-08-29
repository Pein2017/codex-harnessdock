## MODIFIED Requirements

### Requirement: Typed spawn schema exposes only lead decisions
The typed `spawn_agent` schema SHALL require `task_name`, `message`, exact admitted `harness`, explicit full `model`, explicit `topology`, and boolean `write`. It SHALL expose only optional `description`, Driver-discriminated `reasoning_effort`, and absolute spawn-only `target_worktree`. The typed `followup_task` schema SHALL expose only `target`, `message`, and optional Driver-admitted `reasoning_effort`; it SHALL inherit every immutable route field and the Agent's immutable execution root and SHALL NOT accept authority or execution-root mutation. Both SHALL reject `allowed_tools`, `scope`, and `questions`; spawn SHALL also reject `delegation_mode`, `fork_turns`, `execution_profile`, generic working-directory, environment-file, instance, endpoint, credential, native-session, permission-mode, and dangerous-bypass fields as unknown public inputs.

#### Scenario: Minimal explicit Claude spawn is submitted
- **WHEN** Codex supplies task name, message, `harness=claude-code`, exact Claude model, explicit topology, and explicit write boolean without `target_worktree`
- **THEN** typed validation accepts the request without an instance, profile, tool list, or execution selector and the runtime uses the trusted control worktree as the execution root

#### Scenario: Minimal explicit OpenCode spawn is submitted
- **WHEN** Codex supplies task name, message, `harness=opencode`, model `opencode-go/deepseek-v4-flash`, `topology=leaf`, `write=false`, and an absolute `target_worktree`
- **THEN** typed validation passes the exact stated route and target to runtime admission without inferring either field

#### Scenario: Harness or topology is omitted
- **WHEN** spawn lacks either required field even when only one route appears ready
- **THEN** typed validation rejects the call before readiness or durable mutation

#### Scenario: Follow-up attempts a route or authority field
- **WHEN** follow-up supplies `harness`, `model`, `topology`, `write`, or `target_worktree`
- **THEN** strict validation rejects it before mailbox mutation

#### Scenario: Caller supplies repository policy fields
- **WHEN** spawn or follow-up supplies generic `scope` or `questions`
- **THEN** strict validation rejects them and Codex places any task-specific constraints in the bounded message instead

#### Scenario: Target worktree is relative
- **WHEN** spawn supplies a relative `target_worktree`
- **THEN** typed validation rejects it before route inspection or runtime mutation

### Requirement: MCP calls bind only trusted Codex context
Every lifecycle tool call SHALL require a non-empty Codex `_meta.threadId` and a local `file:` workspace URI in `_meta["codex/sandbox-state-meta"].sandboxCwd`. The adapter SHALL use those trusted values as the owner root and control workspace for registry, mailbox, job, completion, and wait state. Only `spawn_agent` MAY additionally supply the bounded `target_worktree` execution selector; that selector SHALL NOT replace or relocate the trusted control context. The adapter SHALL NOT accept trusted-context equivalents in other tool arguments, process cwd, inherited stale identity, Plugin Cache paths, or native session identifiers.

#### Scenario: Trusted call context is complete
- **WHEN** Codex supplies a thread ID and local sandbox workspace URI and spawn omits `target_worktree`
- **THEN** the adapter invokes the public runtime for that exact logical root and canonical control workspace, which is also the execution root

#### Scenario: Trusted control context accompanies a target
- **WHEN** Codex supplies valid trusted context and spawn supplies an absolute `target_worktree`
- **THEN** registry and lifecycle ownership remain bound to the trusted control workspace while runtime admission decides the separate execution root

#### Scenario: Root identity is absent
- **WHEN** `_meta.threadId` is missing or empty
- **THEN** the call fails before reading or mutating an Agent registry

#### Scenario: Workspace metadata is absent or non-local
- **WHEN** sandbox-state metadata is missing, malformed, non-file, or not convertible to a native local path
- **THEN** the call fails instead of using `target_worktree`, the MCP server process cwd, or Plugin Cache root as control context

### Requirement: MCP receipts remain complete and structured
Successful MCP tools SHALL return the matching operation's complete bounded public runtime receipt as structured content with a JSON text representation for protocol clients. Spawn SHALL expose only `agent_name`, `model`, and `status`; follow-up SHALL expose only `agent_name` and `delivery`; interrupt SHALL expose only `agent_name` and operation `status`. Other operation-specific receipts, including complete wait completion delivery, SHALL remain unchanged. No model-facing receipt SHALL expose the control root, execution root, requested target path, or any internal Agent, message, job, steering, session, or persistence evidence. Runtime validation, compatibility, subscription-limit, continuation, and recovery errors SHALL remain actionable while excluding arbitrary environment values, raw private state, native path identity, and foreign-root evidence.

#### Scenario: Spawn succeeds
- **WHEN** the runtime returns a durable spawn receipt for either the control worktree or an admitted target worktree
- **THEN** the MCP result contains exactly `agent_name`, `model`, and `status` without either workspace path or another Agent or terminal session identifier

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
- **THEN** the MCP result preserves the complete stored Agent final message and delivery token without adding root paths

#### Scenario: Runtime rejects a request
- **WHEN** an operation fails validation or reaches an actionable lifecycle boundary
- **THEN** the MCP call reports a sanitized stable error category and recovery action without replacing it with generic success, fallback execution, or an absolute root path

## ADDED Requirements

### Requirement: Target-worktree spawn is one atomic public generation
The addition of optional `target_worktree` SHALL use one new MCP API generation across schema, runtime adapter, tool description, and spawn Skill. An older MCP process SHALL fail with the existing HarnessDock restart-required error before any lifecycle operation; no intermediate generation SHALL accept the field while ignoring, defaulting, or partially enforcing its admission contract.

#### Scenario: Existing Codex task uses the new spawn field
- **WHEN** its MCP process predates the target-worktree generation
- **THEN** the checkout performs no route inspection, durable mutation, or native submission and returns the restart-required instruction
