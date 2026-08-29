## MODIFIED Requirements

### Requirement: Driver scope and prompt envelope are least-authority boundaries
The supervisor SHALL provide a Driver only the canonical validated execution root, trusted root/Agent/turn/attempt identifiers, immutable accepted route and capabilities, bounded task input, assigned mailbox inputs, deadlines/signals, and that Driver's admitted fixed environment view. It SHALL NOT provide the control-root path, registry/store mutation APIs, another Driver, MCP tools, arbitrary environment, credentials, route selection, or another Agent's native references. Driver-added prompt text SHALL be limited to immutable authority/topology facts, the caller task input, and a bounded return contract; it SHALL NOT reveal either root path merely to describe targeting. Task decomposition, methodology selection, cross-worker synthesis, and final acceptance SHALL remain with Codex.

#### Scenario: Driver requests supervisor internals
- **WHEN** a Driver attempts to access the control root, registry, durable store owner, MCP operation, another Driver, or arbitrary environment through its scope
- **THEN** contract validation fails before native submission

#### Scenario: Driver prepares an ordinary turn
- **WHEN** the route and immutable execution root are admitted and the task input is bounded
- **THEN** the Driver receives only that execution root plus its Harness-specific authority/topology/return envelope and cannot silently create a second scheduler policy

## ADDED Requirements

### Requirement: Every native turn executes from the immutable execution root
Each supported Driver SHALL use the Agent's immutable canonical execution root for the native turn's working-directory or directory selector. The control root SHALL remain the location for detached-worker process ownership and durable control state and SHALL NOT replace the execution root at native launch. A Driver SHALL NOT infer a directory from prompt text, process cwd, prior native session state, or a Harness default, and SHALL NOT request a permission-broker fallback when the Harness rejects another directory.

#### Scenario: Claude turn targets a sibling worktree
- **WHEN** a Claude Agent has a separate execution root
- **THEN** its native CLI turn starts with that root as its working directory while its Agent and job state remain control-root scoped

#### Scenario: Pi turn targets a sibling worktree
- **WHEN** a Pi Agent has a separate execution root
- **THEN** its native process starts with that root as cwd rather than the detached worker's control-root cwd

#### Scenario: OpenCode turn targets a sibling worktree
- **WHEN** an OpenCode Agent has a separate execution root
- **THEN** native session creation and prompt submission use that root as the directory selector without an external-directory approval fallback

### Requirement: Explicit targets are revalidated immediately before native transport
After detached handoff and before any native session creation, resume, or prompt submission, the runtime SHALL revalidate an explicitly targeted execution root against the immutable canonical path and the control root's current registered linked-worktree and Git-common-directory ownership evidence. Missing, prunable, unregistered, current-root, independent-clone, or owner-drifted evidence SHALL fail as a proven pre-transport rejection. The runtime SHALL NOT submit, replay, retarget, fall back, create, repair, or request approval after that failure.

#### Scenario: Target remains owned at transport time
- **WHEN** immediate revalidation reproduces the admitted canonical target, registration, non-prunable state, and Git common directory
- **THEN** the Driver may cross its native transport boundary using exactly that execution root

#### Scenario: Target owner drifts after spawn admission
- **WHEN** immediate revalidation no longer proves the stored target belongs to the control repository as a registered non-prunable sibling
- **THEN** the attempt records a not-submitted pre-transport failure, native input is not accepted, and the Agent remains bound to the original execution root

#### Scenario: Harness would ask for external-directory approval
- **WHEN** native directory policy refuses the already admitted execution root
- **THEN** the Driver reports the pre-transport failure and does not broker approval or retry in the control root
