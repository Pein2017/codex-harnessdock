## MODIFIED Requirements

### Requirement: Typed spawn schema exposes only lead decisions
The typed `spawn_agent` schema SHALL require `task_name`, `message`, exact admitted `harness`, explicit full `model`, explicit `topology`, boolean `write`, and `reasoning_effort`. For Pi and OpenCode, `reasoning_effort` SHALL be a bounded dynamic value that the selected native Driver freshly advertises for the exact model. The typed `followup_task` schema SHALL expose only `target` and `message`; it SHALL inherit every immutable route field including effort and SHALL NOT accept authority or route mutation. Both SHALL reject `allowed_tools`, `scope`, and `questions`; spawn SHALL also reject `delegation_mode`, `fork_turns`, `execution_profile`, working-directory, environment-file, instance, endpoint, credential, native-session, permission-mode, and dangerous-bypass fields as unknown public inputs.

#### Scenario: Minimal explicit native spawn is submitted
- **WHEN** Codex supplies task name, message, an admitted native Harness, a freshly listed full model, explicit topology, and explicit write boolean
- **THEN** typed validation passes the exact route to Driver validation without an instance, profile, tool list, or execution selector

#### Scenario: Required effort is omitted
- **WHEN** Codex supplies no `reasoning_effort` for any spawn
- **THEN** typed validation rejects the call before readiness, session, message, provider, or durable mutation work

#### Scenario: Harness or topology is omitted
- **WHEN** spawn lacks either required field even when only one route appears ready
- **THEN** typed validation rejects the call before readiness or durable mutation

#### Scenario: Follow-up attempts a route or authority field
- **WHEN** follow-up supplies `harness`, `model`, `topology`, or `write`
- **THEN** strict validation rejects it before mailbox mutation

#### Scenario: Caller supplies repository policy fields
- **WHEN** spawn or follow-up supplies generic `scope` or `questions`
- **THEN** strict validation rejects them and Codex places any task-specific constraints in the bounded message instead

### Requirement: list_harnesses exposes admitted route facts without selecting one
`list_harnesses` SHALL accept no model-facing arguments and SHALL freshly return every statically admitted Harness, each bounded logical-instance readiness, `liveValidated`, Driver/capability maturity, and safely discoverable native exact model and effort constraints. It SHALL not start model work, mutate lifecycle state, choose a route, expose endpoint, credential, local configuration, plugin, MCP, tool, or prompt-template identity, or imply that an unavailable Harness is removed from the static registry.

#### Scenario: Native Harness is unavailable
- **WHEN** Codex lists Harnesses while Pi configuration cannot be inspected or the OpenCode Server is unavailable
- **THEN** the response includes the Harness as admitted but unavailable, leaves other Harness facts independent, and starts no native model work

#### Scenario: Native catalog offers variants
- **WHEN** the connected OpenCode Server reports an admitted model with bounded variants
- **THEN** the response exposes only the exact route and effort choices validated from that catalog without selecting a variant for Codex

### Requirement: Public generation changes once for the unified surface
The dynamic native route and explicit-effort surface SHALL use one new MCP API generation and one plugin minor-version bump. An older MCP process SHALL fail with the current HarnessDock restart-required error before any operation; once the upgraded MCP has loaded, subsequent local Pi/OpenCode configuration changes SHALL be observed by fresh discovery without a HarnessDock reload. No intermediate generation SHALL expose fixed native model/profile constants, inferred routes, aliases, or partially explicit spawn.

#### Scenario: Old task invokes list or spawn
- **WHEN** its MCP process generation predates the native dynamic-route surface
- **THEN** the checkout performs no lifecycle operation and returns the restart-required instruction

#### Scenario: Native configuration changes after upgrade
- **WHEN** Pi or connected OpenCode local configuration changes after the upgraded MCP is already running
- **THEN** a later list or spawn observes fresh bounded native facts without reloading HarnessDock
