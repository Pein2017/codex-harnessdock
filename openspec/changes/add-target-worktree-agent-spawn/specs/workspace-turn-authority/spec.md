## MODIFIED Requirements

### Requirement: One canonical workspace has at most one behavioral writer
Before native input acceptance, every write-authorized Agent turn SHALL acquire both its required Harness-instance or native-session admission lease and one durable writer lease keyed by the Agent's immutable canonical execution root and bound to owner root, Agent, job, Harness, instance, and route. This dual admission SHALL apply to every supported public write lifecycle, including version-one Claude turns and version-three Pi and OpenCode turns. Read-only turns SHALL acquire only their required instance or native-session admission and MAY coexist with the writer subject to their Driver capabilities. A missing binding or second writer SHALL fail fast without launching or accepting native input. The runtime SHALL use the existing shared lease engine and SHALL NOT add a second writer lifecycle.

#### Scenario: Two Harnesses request write access to one execution root
- **WHEN** one turn already holds the execution-root writer lease
- **THEN** the other turn is rejected before native input acceptance regardless of Harness, model, control root, or lifecycle generation

#### Scenario: Writers use distinct prepared worktrees
- **WHEN** their immutable canonical execution roots differ
- **THEN** their writer leases do not collide and the Plugin does not create, repair, or merge either worktree

#### Scenario: Version-one Claude write turn starts
- **WHEN** a public Claude Agent turn has write authority
- **THEN** native submission is impossible until both its existing instance or session admission and its execution-root writer lease are durably bound

#### Scenario: Version-three Pi or OpenCode write turn starts
- **WHEN** a public Pi or OpenCode Agent turn has write authority
- **THEN** its launch claim refuses native submission when it carries only the instance or native-session binding and lacks the execution-root writer binding

#### Scenario: Read-only turn starts beside a writer
- **WHEN** a read-only route is otherwise admitted while a writer holds the same execution root
- **THEN** the read-only turn acquires no writer lease and its existing Driver capability rules decide whether it may proceed

### Requirement: Writer lease release requires settled execution evidence
The execution-root writer lease SHALL release through the shared durable settlement path exactly once and only after terminal native state and settled turn-owned execution are proven. Worker loss, failed interruption, unknown remote state, contradictory mutation evidence, missing execution-root filesystem state, or partial release SHALL retain the affected lease and surface an operator-actionable blocked condition. Release and reconciliation SHALL use the stored canonical lease key rather than recanonicalizing a current path. No model-facing operation SHALL force-clear a writer lease.

#### Scenario: Worker disappears after write-capable input acceptance
- **WHEN** the Driver cannot prove whether the native turn or its commands settled
- **THEN** the execution-root writer lease remains held and later write turns fail closed

#### Scenario: Execution root is removed after settlement evidence
- **WHEN** terminal settlement is proven after the worktree path is no longer present
- **THEN** the runtime releases the exact stored writer binding once without deriving a different key from the filesystem

#### Scenario: Writer release outcome is unknown
- **WHEN** the durable release path cannot prove the stored writer lease was removed
- **THEN** later write admission remains blocked and no terminal projection claims complete lease release
