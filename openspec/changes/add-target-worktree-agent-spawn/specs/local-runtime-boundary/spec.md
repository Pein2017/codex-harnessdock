## MODIFIED Requirements

### Requirement: Public lifecycle workspace is inherited from Codex
Each model-facing lifecycle call SHALL use the canonical Codex turn workspace as its trusted control root. That control root SHALL continue to own the Agent registry, mailboxes, jobs, completions, waits, and detached-worker control state. `spawn_agent` MAY additionally accept the single absolute `target_worktree` field to select one admitted execution root; omission SHALL make the canonical control root the execution root. No other lifecycle operation or field SHALL accept `--cwd`, `-C`, `--env-file`, a generic working directory, or another execution selector. CLI calls SHALL inherit the host process working directory as their control and execution root; MCP calls SHALL require the trusted sandbox-state `sandboxCwd` URI attached by Codex and SHALL NOT fall back to the server process cwd. Every lifecycle Skill SHALL instruct Codex to confirm the intended control checkout and, when used, the exact target worktree before invocation. Private detached-worker reconstruction and explicit read-only operator diagnostics MAY retain internal control-context arguments, and those arguments SHALL NOT become model-facing execution selectors.

#### Scenario: Codex invokes spawn from the intended worktree
- **WHEN** a Plugin MCP call receives trusted sandbox workspace metadata and omits `target_worktree`
- **THEN** the public runtime scopes lifecycle state and Harness execution to that same canonical worktree without a model-supplied fallback

#### Scenario: Codex invokes spawn for an admitted sibling
- **WHEN** a Plugin MCP call receives trusted control-workspace metadata and supplies an admitted absolute `target_worktree`
- **THEN** the runtime keeps lifecycle state under the control worktree and freezes the sibling as the separate execution root

#### Scenario: Generic model-facing context selector is supplied
- **WHEN** any public lifecycle invocation includes `--cwd`, `-C`, `--env-file`, `cwd`, `directory`, or an equivalent generic property
- **THEN** it fails before selecting a different workspace or environment

#### Scenario: MCP workspace metadata is unavailable
- **WHEN** an MCP lifecycle call lacks a valid local Codex sandbox workspace URI
- **THEN** it fails instead of using `target_worktree`, the Plugin Cache, bootstrap, or server process directory as the control root

#### Scenario: Detached worker reconstructs public context
- **WHEN** a public spawn hands a prepared job to its private detached worker
- **THEN** the worker reconstructs owner state from the already-canonical control root and carries the immutable execution root only as bounded internal turn state

## ADDED Requirements

### Requirement: Target worktree admission is exact and fail closed
Before route inspection, readiness work, or durable mutation, the runtime SHALL canonicalize the trusted control root and a supplied absolute `target_worktree` and SHALL admit the target only when it exists as a directory, is a non-current non-prunable entry in the control root's current registered linked-worktree inventory, and resolves to the same canonical Git common directory as the control root. It SHALL reject a relative path, an explicit path resolving to the current control root, a missing path, a prunable or unregistered path, an independent clone, or any identity whose registered owner drifts during validation. Rejection SHALL NOT infer another path from the prompt, fall back to the control root, create or repair a worktree, alter permissions, or broker a native approval.

#### Scenario: Registered linked sibling is selected
- **WHEN** the absolute target resolves to an existing non-prunable registered sibling sharing the control root's canonical Git common directory
- **THEN** admission returns that sibling's canonical path as the execution root before route inspection begins

#### Scenario: Current worktree is supplied explicitly
- **WHEN** `target_worktree` resolves to the trusted control root
- **THEN** admission rejects the redundant selector and instructs the caller to omit it

#### Scenario: Target is missing, prunable, or unregistered
- **WHEN** the candidate is absent from disk, marked prunable in the current registered inventory, or not registered there
- **THEN** admission fails before route inspection or durable mutation without creating or repairing anything

#### Scenario: Target belongs to an independent clone
- **WHEN** the target has a different canonical Git common directory even if its history or remote resembles the control repository
- **THEN** admission rejects it without treating remote or commit similarity as repository ownership

#### Scenario: Candidate identity changes during admission
- **WHEN** canonical path, registration, or Git common-directory evidence disagrees across the admission checks
- **THEN** admission fails as owner drift rather than selecting either observation

### Requirement: Execution targeting does not change runtime or environment ownership
Selecting a target worktree SHALL change only the immutable Harness execution root for the new Agent. Checkout-owned runtime source, the fixed environment file, Driver registry, credentials, service ownership, process-permission behavior, and the trusted Codex control root SHALL remain unchanged.

#### Scenario: Target worktree contains another runtime or environment file
- **WHEN** an admitted execution root contains local runtime source, a `.env`, or Harness configuration
- **THEN** HarnessDock continues using its canonical runtime and fixed Driver-owned environment and does not load those target-local files as control configuration
