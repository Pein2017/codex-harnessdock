# local-development-promotion Specification

## Purpose

Define the fixed developer/main checkout topology, tested linear promotion, activation classification, and module-load exclusion used to update the live local Plugin safely.

## Requirements

### Requirement: Development and live execution use distinct fixed worktrees
The repository SHALL use `/data/CoordExp/codex-harnessdock-dev` on branch `developer` for implementation and verification, and `/data/CoordExp/codex-harnessdock` on branch `main` as the sole live Plugin runtime checkout. Both worktrees SHALL share the same independent Git common directory. The development worktree SHALL NOT become an executable Plugin runtime source.

#### Scenario: Development begins
- **WHEN** an operator edits the Plugin on the development track
- **THEN** the edit occurs in `/data/CoordExp/codex-harnessdock-dev` without changing files in the live main checkout

#### Scenario: Plugin runtime resolves source
- **WHEN** Codex invokes an installed HarnessDock lifecycle operation
- **THEN** executable source resolves only from `/data/CoordExp/codex-harnessdock` and never from the developer worktree

### Requirement: Local promotion is clean and linear
The local promotion command SHALL verify exact checkout paths, expected branches, common repository identity, clean status in both worktrees, and that `developer` is a descendant of `main`. It SHALL run the configured repository acceptance command before updating `main`, and SHALL update `main` only with a fast-forward. It SHALL NOT commit, push, install, refresh, release, or restart Codex.

#### Scenario: Tested developer history is promotable
- **WHEN** both worktrees are clean, `developer` descends from `main`, and acceptance passes
- **THEN** promotion fast-forwards `main` to the exact tested developer commit

#### Scenario: Main and developer diverge
- **WHEN** neither branch can be fast-forwarded to the other under the required direction
- **THEN** promotion fails before changing either worktree and instructs the operator to resolve history explicitly

#### Scenario: A worktree is dirty
- **WHEN** either fixed worktree contains tracked or untracked changes
- **THEN** promotion fails before running Git update or Plugin lifecycle commands

#### Scenario: Acceptance fails
- **WHEN** the configured repository check exits unsuccessfully
- **THEN** promotion leaves `main` unchanged

### Requirement: Promotion reports activation class
The promotion command SHALL classify the exact pre-main to developer diff as `hot_compatible` or `restart_required`. MCP server/schema/generation, Plugin discovery/Skills/descriptors, bootstrap, fixed environment, dependency, and host-instruction changes SHALL be `restart_required`. Compatible runtime implementation and non-runtime project changes MAY be `hot_compatible` only when the MCP API generation is unchanged. The receipt SHALL list decisive paths and the required next action, including only the dependency installation, Plugin refresh, or release preparation actually required before a new Codex task.

#### Scenario: Compatible lifecycle implementation changes
- **WHEN** the promoted diff changes only implementation behind the isolated runtime boundary and preserves the MCP API generation
- **THEN** the receipt reports `hot_compatible` and says existing tasks observe it on their next MCP call without Plugin refresh

#### Scenario: Static Plugin surface changes
- **WHEN** the promoted diff changes a Skill, MCP schema/server, manifest, descriptor, bootstrap, environment, dependency, or API generation owner
- **THEN** the receipt reports `restart_required`, directs the operator to any required dependency/discovery/API preparation, and requires a new Codex task; a checkout-only server change does not require Plugin refresh

#### Scenario: No commits need promotion
- **WHEN** `main` and `developer` already identify the same commit
- **THEN** the command reports a no-op without running acceptance or changing Plugin state

### Requirement: Promotion excludes concurrent runtime module loading
No fresh production MCP Worker SHALL import the live `runtime/index.mjs` graph while promotion is updating the main checkout. A Worker SHALL register only for the module-load interval and SHALL release that registration immediately after import. Promotion SHALL acquire an exclusive gate, wait for registered loaders to drain, update `main`, and release the gate even when Git fails. Already-loaded operations and Claude turns SHALL continue independently.

#### Scenario: Promotion is active before a new call loads runtime
- **WHEN** a fresh MCP Worker reaches the runtime import boundary while the exclusive promotion gate exists
- **THEN** it waits until promotion releases the gate and then imports the complete promoted module graph

#### Scenario: Runtime import began before promotion
- **WHEN** a Worker has registered its module-load interval before promotion acquires exclusivity
- **THEN** promotion waits for that import interval to end before updating the main checkout

#### Scenario: Promotion update fails
- **WHEN** the main fast-forward command exits unsuccessfully after exclusivity is acquired
- **THEN** the gate is released and later MCP calls are not permanently blocked

#### Scenario: Existing Agent turn is active
- **WHEN** promotion begins after an MCP Worker already imported its module graph or launched a detached Claude turn
- **THEN** promotion does not interrupt that operation or Agent, and only later MCP calls load the promoted implementation

### Requirement: Promotion gate recovery is bounded and ownership-safe
Loader markers SHALL identify their owning process. Promotion MAY remove a marker only when that process is provably absent. If a live or unprovable marker does not drain within the bounded gate timeout, promotion SHALL fail without updating `main` or deleting the marker.

#### Scenario: Loader owner exited unexpectedly
- **WHEN** a retained marker identifies a process that no longer exists
- **THEN** promotion removes that stale marker and continues gate acquisition

#### Scenario: Loader owner remains live
- **WHEN** a marker still identifies a live process after the bounded wait
- **THEN** promotion fails closed and preserves the marker for diagnosis
