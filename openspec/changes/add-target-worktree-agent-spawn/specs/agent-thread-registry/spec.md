## ADDED Requirements

### Requirement: Agent records separate control and execution roots
Every newly created Agent SHALL remain stored in the registry owned by the trusted canonical control root and SHALL carry one separate canonical execution root. The execution root SHALL be fixed at spawn to either the admitted `target_worktree` or, when omitted, the control root. It SHALL remain immutable across mailbox delivery, follow-up activation, interruption, recovery, reconciliation, and process restart; no operation SHALL retarget an existing Agent.

#### Scenario: Spawn omits a target
- **WHEN** a new Agent is admitted without `target_worktree`
- **THEN** its control and execution roots are the same canonical worktree while remaining distinct semantic fields for the new record generation

#### Scenario: Spawn selects a sibling
- **WHEN** a new Agent is admitted with a registered linked sibling
- **THEN** the Agent is discoverable only from its original control-root registry and every turn uses the frozen sibling execution root

#### Scenario: Follow-up is activated from the control root
- **WHEN** the owner sends a follow-up to an Agent whose execution root differs from its control root
- **THEN** the mailbox and activation stay control-root scoped and the turn inherits the stored execution root without accepting a replacement

#### Scenario: Agent updater changes the execution root
- **WHEN** any update or reconciliation result proposes a different execution root
- **THEN** the registry rejects the drift without changing the Agent or its mailbox

### Requirement: Existing workspace-only records retain their original meaning
An existing Agent record without a separately stored execution root SHALL be interpreted as using its stored workspace as both control root and execution root. Reading, listing, reconciling, or validating such a record SHALL NOT rewrite it merely to add the new field. A later ordinary mutation MAY write the owning record generation only if it preserves both roots as that same canonical stored workspace.

#### Scenario: Legacy Agent is listed
- **WHEN** the registry reads a valid Agent whose only workspace field names its owning registry workspace
- **THEN** the Agent remains discoverable with that workspace interpreted as both roots and no compatibility write occurs

#### Scenario: Legacy Agent receives a supported follow-up
- **WHEN** ordinary continuation mutates a valid workspace-only Agent record
- **THEN** the new durable state preserves the original workspace as both control and execution root without target inference

### Requirement: Public Agent projections keep workspace identity private
Model-facing spawn, list, wait, completion, blocking, and follow-up projections SHALL NOT expose either the control-root path or execution-root path. The runtime MAY use exact paths in owner-only durable state and bounded operator diagnostics.

#### Scenario: Targeted Agent is listed
- **WHEN** an Agent executes in a sibling worktree
- **THEN** its public card preserves the existing route, authority, status, and maturity fields without either absolute worktree path
