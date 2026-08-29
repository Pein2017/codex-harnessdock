## MODIFIED Requirements

### Requirement: Each Driver owns a bounded environment view
The shared runtime SHALL parse the one canonical environment file as data and provide each static Driver only its allowlisted keys. The Pi Driver SHALL receive `PI_CODING_AGENT_DIR`; the OpenCode integration SHALL receive `OPENCODE_EXECUTABLE` and `OPENCODE_SERVER_URL`. The runtime SHALL NOT source `.bashrc`, evaluate shell code, select a second dotenv file, expose these values through model-facing input, or persist arbitrary environment values as readiness evidence.

#### Scenario: Two Drivers require different host settings
- **WHEN** their static environment schemas differ
- **THEN** each receives its admitted fixed values without changing the canonical environment-file owner or leaking the other Driver's private settings

#### Scenario: Shell profile differs from fixed configuration
- **WHEN** `/root/.bashrc` omits or conflicts with a Pi or OpenCode value present in the canonical environment file
- **THEN** HarnessDock uses the canonical environment value without reading or sourcing the shell profile

#### Scenario: Driver receives its bounded view
- **WHEN** the runtime constructs Pi and OpenCode dependencies
- **THEN** each integration receives only its admitted fixed values plus already-approved secret or host inheritance and does not receive the other Driver's configuration

### Requirement: OpenCode connection configuration is fixed and secret-safe
The canonical runtime environment SHALL provide one checkout-owned loopback Server URL and one absolute OpenCode executable path. Optional official Basic-auth username/password variables SHALL be inherited only from the operator environment, admitted through an exact secret allowlist, and omitted from the tracked environment file and all receipts. The Driver SHALL use the executable only to ensure `opencode serve` on the fixed loopback origin and SHALL construct bounded authenticated SDK requests with explicit deadlines and no loopback proxy routing.

#### Scenario: Model-facing endpoint is supplied
- **WHEN** spawn, follow-up, or any other tool includes an endpoint, username, password, token, directory override, timeout bypass, or SDK option
- **THEN** strict validation rejects it before connection or state mutation

#### Scenario: Request exceeds its deadline
- **WHEN** health, discovery, session, message, or prompt-admission observation exceeds the Driver-owned bound
- **THEN** the request aborts with a sanitized retryability classification and never becomes a silent infinite wait

#### Scenario: Configured executable is invalid
- **WHEN** the fixed executable path is missing, non-absolute, or not executable
- **THEN** OpenCode readiness fails with a bounded redacted reason before process launch

#### Scenario: Model-facing endpoint or executable is supplied
- **WHEN** a lifecycle tool includes an endpoint, executable, credential, directory override, timeout bypass, or SDK option
- **THEN** strict validation rejects it before connection, process launch, or state mutation

### Requirement: OpenCode CLI remains diagnostic only
Production Agent lifecycle MAY invoke exactly the configured `opencode serve` command to ensure the shared fixed-origin service. It SHALL NOT invoke or parse `opencode models`, `opencode run`, TUI output, model-event stdout, or any other CLI command as a production route, turn, result, or readiness source. Provider discovery, session creation, messages, and results SHALL remain on the pinned SDK boundary.

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

### Requirement: Managed OpenCode ownership is exact and private
HarnessDock SHALL serialize service ensure across processes with owner-only Plugin data, persist only the minimum process identity needed to prove a managed Server, recover stale ownership fences, and never treat endpoint reachability alone as process ownership. A started Server MAY outlive one MCP process for reuse by later tasks. There SHALL be no public start, stop, restart, endpoint, PID, or executable selector.

#### Scenario: Managed receipt is stale
- **WHEN** a receipt names a dead or identity-mismatched process
- **THEN** the next ensure discards that ownership claim under the fence and starts at most one replacement

#### Scenario: Started process fails readiness
- **WHEN** the exact child started by the current contender exits or cannot become healthy within the bounded startup deadline
- **THEN** the contender reports a bounded failure and may terminate only that exact proven child
