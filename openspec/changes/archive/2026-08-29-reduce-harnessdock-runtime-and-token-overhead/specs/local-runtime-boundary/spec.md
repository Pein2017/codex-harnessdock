## MODIFIED Requirements

### Requirement: OpenCode CLI remains diagnostic only
Production Agent lifecycle MAY invoke the configured `opencode serve` command to start the shared fixed-origin service for an admitted OpenCode turn. While that service is absent, bounded readiness MAY invoke and parse only the configured executable's native model and credential-list diagnostics needed to discover exact configured model/effort routes. Those diagnostics SHALL retain the operator's ordinary plugins and configuration, SHALL NOT use `--pure` or refresh remote model data, and SHALL NOT create a session or model request. The runtime SHALL NOT invoke or parse `opencode run`, TUI output, model-event stdout, or any CLI output as a turn, result, native-history, or terminal-settlement source. Session creation, prompt submission, and result selection SHALL remain on the pinned SDK boundary after service ensure.

#### Scenario: Dormant configured route is inspected
- **WHEN** the fixed Server is absent and the configured executable can report the operator's current model variants and credential provider
- **THEN** HarnessDock reports only those exact model/effort routes without starting the Server or a model turn

#### Scenario: Managed service is needed for a turn
- **WHEN** an admitted OpenCode Agent reaches pre-transport revalidation while the Server is absent
- **THEN** the Plugin invokes only `opencode serve` with fixed loopback host and port arguments before SDK route validation

#### Scenario: CLI diagnostic is malformed or inconsistent
- **WHEN** the bounded native diagnostic cannot prove an exact configured route
- **THEN** dormant readiness fails closed without aliasing a model, inventing an effort, starting the Server, or calling a provider

#### Scenario: CLI is absent but Server is reachable
- **WHEN** the pinned SDK can validate the configured Server and route
- **THEN** Driver readiness may succeed without a local `opencode` executable in the Plugin process environment

#### Scenario: Managed service is started
- **WHEN** the fixed Server is absent and the configured executable is valid
- **THEN** the Plugin invokes only `opencode serve` with fixed loopback host and port arguments and validates readiness through the pinned client

#### Scenario: Server is reachable without an executable
- **WHEN** a compatible fixed-origin Server already exists but the configured executable is unavailable
- **THEN** the Plugin may reuse the Server without invoking a CLI command

## ADDED Requirements

### Requirement: Managed OpenCode startup is demand-driven
MCP startup, `list_harnesses`, doctor, and zero-model release smoke SHALL inspect or discover OpenCode without starting an absent Server. Only pre-transport validation for an admitted OpenCode turn MAY ensure the shared Server. A compatible already-running Server MAY still be reused without ownership.

#### Scenario: Codex task never uses OpenCode
- **WHEN** a Codex task loads HarnessDock and uses only Pi, Claude, or observational Agent tools
- **THEN** HarnessDock does not start an absent OpenCode Server

#### Scenario: Dormant OpenCode route is selected
- **WHEN** spawn selects an exact route advertised from current dormant native discovery
- **THEN** the detached turn path ensures one shared Server and revalidates the same route before creating a native session

### Requirement: Managed OpenCode idle reclamation is exact and process-only
The canonical environment SHALL admit one bounded OpenCode idle-TTL value whose default is 3,600 seconds. HarnessDock SHALL record managed service activity separately from health, hold one private durable lease for every submitted or acceptance-unknown OpenCode turn, and make reclamation eligible only after the TTL when no such lease exists. Under the existing cross-process fence it SHALL revalidate the ownership receipt, PID identity, command fingerprint, loopback endpoint, and absence of active peer work before requesting graceful termination of the exact managed process. It SHALL never stop a healthy reused service or delete durable Agent state. A bounded tombstone SHALL record only the process-only reclamation outcome.

#### Scenario: Managed service passes the idle boundary
- **WHEN** last admitted turn activity is at least 3,600 seconds old, every turn lease is released, and exact process identity still matches
- **THEN** one contender gracefully terminates that managed process and records a bounded tombstone without deleting logical state

#### Scenario: Reused service is idle
- **WHEN** a compatible fixed-origin service has no valid HarnessDock ownership receipt
- **THEN** HarnessDock leaves it running regardless of elapsed inactivity

#### Scenario: Active or unknown turn holds a lease
- **WHEN** any current turn is active or its native acceptance/settlement is unknown
- **THEN** reclamation leaves the service and lease unchanged

#### Scenario: Configured TTL is invalid
- **WHEN** the canonical environment states an absent, non-integer, non-positive, or out-of-range override
- **THEN** startup uses the one-hour default for absence and fails closed on an explicitly malformed override without evaluating shell code
