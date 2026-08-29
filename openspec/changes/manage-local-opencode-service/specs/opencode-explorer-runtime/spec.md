## MODIFIED Requirements

### Requirement: OpenCode attaches only to an operator-owned loopback Server
The OpenCode Driver SHALL use one fixed-origin loopback OpenCode Server shared by concurrent HarnessDock MCP processes. Before MCP readiness and immediately before OpenCode spawn, the Plugin SHALL reuse a healthy compatible Server or ensure one Server from the allowlisted executable under a cross-process ownership fence. It SHALL omit an agent selector so the Server retains its native configuration, and SHALL NOT install OpenCode, perform login, use `--pure`, reconfigure provider state, bind non-loopback, call a model during readiness, or kill a process it cannot prove it owns. `list_harnesses` SHALL only inspect the resulting state and SHALL NOT start or repair the Server.

#### Scenario: Healthy Server is reused
- **WHEN** the fixed loopback endpoint already exposes compatible health and provider discovery
- **THEN** readiness reuses it without starting a duplicate process or requiring ownership

#### Scenario: Concurrent bootstraps find no Server
- **WHEN** multiple MCP processes ensure the absent fixed loopback Server concurrently
- **THEN** exactly one contender starts the configured executable and the others reuse the proven healthy Server after the ownership fence settles

#### Scenario: Fixed endpoint is occupied but incompatible
- **WHEN** the endpoint is reachable but cannot prove compatible OpenCode readiness or belongs to an unowned process
- **THEN** OpenCode fails closed without killing, replacing, or reconfiguring that process

#### Scenario: Server stops before spawn
- **WHEN** a previously managed Server is absent immediately before an OpenCode spawn
- **THEN** the Plugin re-ensures one shared Server before fresh route validation without starting a model turn

