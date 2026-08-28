## RENAMED Requirements

- FROM: `The first OpenCode route is discovered, exact, and read-only`
- TO: `OpenCode native routes are discovered and exact`
- FROM: `Explorer profile permits only bounded repository research`
- TO: `OpenCode inherits bounded resolved native configuration`
- FROM: `Explorer prompt and result stay narrow and Harness-neutral`
- TO: `OpenCode prompt and result stay narrow and Harness-neutral`

## MODIFIED Requirements

### Requirement: OpenCode attaches only to an operator-owned loopback Server
The OpenCode Driver SHALL attach as a fixed-origin network client to one operator-owned loopback OpenCode Server. It SHALL derive bounded route facts from `/provider` for the connected provider/model catalog and variants. It SHALL omit an agent selector so the Server retains its local native agent/configuration, and SHALL NOT read or expose raw configuration. Native plugin, MCP, tool, permission, or prompt-template configuration SHALL NOT be copied or enumerated. It SHALL NOT install OpenCode, start/stop/restart a Server, use the TUI, dispose an instance, perform login, mutate provider/configuration state, bind a non-loopback address, or call an underlying model provider directly. Readiness SHALL validate Server/client compatibility, the current workspace, and resolved route facts without starting a model turn.

#### Scenario: Server is ready
- **WHEN** the fixed loopback Server is healthy and exposes a bounded compatible provider catalog and route facts for the current workspace
- **THEN** readiness reports one experimental logical instance with `liveValidated: true` and no model request

#### Scenario: Server is unavailable or non-loopback
- **WHEN** the endpoint cannot be reached, fails authentication, or resolves outside loopback
- **THEN** only the OpenCode logical instance is unavailable and no Plugin action starts, repairs, or reconfigures it

### Requirement: OpenCode native routes are discovered and exact
Before route admission, the Driver SHALL freshly confirm the requested full provider/model identifier and its explicitly requested exact Server-advertised variant, sent as the native variant. It SHALL omit the agent selector and let the pinned Server retain its local native default agent/configuration. It SHALL never hardcode `codex-explorer`, `build`, another agent, a profile, model, or variant. It SHALL admit only an exact caller-selected tuple, `leaf` topology, and `noninteractive_fixed_policy`; it SHALL reject omitted route fields including effort, aliases, another model/provider, variant inference, interactive approval, dynamic tool overrides, and more than one active turn before session creation or prompt admission. `write` SHALL remain an accepted prompt/receipt authority and SHALL not alter native tool configuration, argv, plugin/MCP inheritance, sandbox, or Server ownership.

#### Scenario: Intended route is confirmed exactly
- **WHEN** fresh Server discovery reports the requested full model and its explicitly requested effort variant
- **THEN** the Driver may freeze that exact route and its experimental capability snapshot

#### Scenario: OpenCode effort is omitted
- **WHEN** an OpenCode caller omits effort
- **THEN** spawn rejects before session, message, or provider work without selecting or inferring a variant

#### Scenario: Actual route differs
- **WHEN** fresh discovery does not report the exact provider/model/variant tuple requested or previously accepted
- **THEN** admission stops before session creation without aliasing, inference, profile substitution, or model substitution

#### Scenario: OpenCode write is requested
- **WHEN** `write: true` is supplied with Harness `opencode`
- **THEN** spawn retains that behavioral authority only in the prompt and receipt while inheriting the same native tools, plugins, MCP configuration, argv, and sandbox as `write: false`

### Requirement: OpenCode inherits bounded resolved native configuration
The OpenCode Driver SHALL treat the connected Server's resolved local configuration as the sole authority for native plugins, MCP servers, tools, skills, and prompt templates. It SHALL inherit that configuration for an admitted route without copying it into HarnessDock configuration, exposing it in list/receipt/diagnostic output, or treating capability inheritance as proof that individual plugins, MCP servers, or tools are enumerable. The Driver SHALL fail closed when the connected Server cannot prove the bounded route and noninteractive interaction contract required by this generation; it SHALL not replace local configuration with a HarnessDock profile, allowlist, tool override, or agent selector.

#### Scenario: Native configuration is available
- **WHEN** the connected Server resolves local configuration for a route that satisfies the bounded route and interaction contract
- **THEN** the Driver inherits it unchanged for the native turn and exposes no configuration inventory to Codex

#### Scenario: Native configuration cannot prove the route
- **WHEN** resolved local configuration cannot support the requested exact route or requires an interactive approval path
- **THEN** readiness or spawn fails before model execution without falling back to a HarnessDock-managed profile or tool policy

### Requirement: OpenCode prompt and result stay narrow and Harness-neutral
The Driver SHALL construct each turn from one versioned stable authority/topology/return prefix, the caller's bounded task message, the canonical workspace identity, and native-inherited configuration. The `leaf` setting SHALL constrain only the HarnessDock top-level Agent; native delegation remains unmanaged and prompt-constrained. The prefix MAY ask for concise relevant paths, evidence, unknowns, and next checks but SHALL NOT impose task decomposition, methodology, cross-worker synthesis, or a universal repository JSON ontology. Success SHALL return exactly one matching nonempty bounded outer-assistant final text plus optional closed Driver metadata; malformed lineage, empty/oversized output, native tool/event history, or terminal UI output SHALL not be projected as success.

#### Scenario: Valid Explorer result arrives
- **WHEN** the exact matching assistant response contains one nonempty bounded final text
- **THEN** the Driver projects it as the final Agent result without exposing native tool history or configuration

#### Scenario: Caller needs a task-specific format
- **WHEN** Codex includes that return request in the task message
- **THEN** OpenCode may follow it, but the shared runtime does not parse, repair, or promote that format into a global contract

### Requirement: Initial optional operations fail honestly
The initial OpenCode capability snapshot SHALL expose only its proven values: `initial_only` active input, unavailable history, unsupported public interrupt request, unavailable restart observation, and no automatic recovery. `write` SHALL be admitted only as immutable prompt/receipt authority and SHALL NOT make an optional operation supported or select native execution permissions. Public topology SHALL remain `leaf`; `nativeOrchestration=opaque_bounded` means native delegation may exist but HarnessDock neither enumerates nor controls it. `send_message` MAY queue a message but SHALL not claim active delivery. `followup_task` SHALL obey the route's proven `exact_resume` or `fresh_only` continuation. `interrupt_agent` and `read_agent_messages` SHALL return the snapshot's explicit unsupported result without treating abort, status, events, or native transcript APIs as proof.

#### Scenario: Active OpenCode Agent receives follow-up
- **WHEN** the current turn has not settled and active input is unsupported
- **THEN** follow-up rejects before mailbox mutation rather than promise queued activation

#### Scenario: Interrupt is requested
- **WHEN** the initial OpenCode route is active
- **THEN** the Plugin reports unsupported and does not treat abort/status as proven settlement
