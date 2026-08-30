## ADDED Requirements

### Requirement: Claude selection is exact and never defaulted
Every new Claude Agent SHALL require the caller's byte-exact native model value and exact advertised effort. Claude model aliases, effort aliases, configured defaults, family names, dated-ID normalization, default effort tables, and automatic fallback models SHALL NOT participate in admission or turn launch.

#### Scenario: Caller supplies a Claude family alias
- **WHEN** a caller supplies `opus`, `sonnet`, `haiku`, `fable`, or another value not byte-identical to a freshly advertised native route
- **THEN** admission fails before durable mutation or Claude transport and reports that a full listed model is required

#### Scenario: Caller omits Claude effort
- **WHEN** a caller supplies an exact model but no effort
- **THEN** admission fails before durable mutation or Claude transport without consulting a default effort

### Requirement: Claude native configuration remains Claude-owned
The inspection and turn paths SHALL use the same ordinary configured Claude state and SHALL NOT add safe/bare/restricted modes, settings overlays, plugin or MCP selectors, tool lists, fallback models, or permission-mode changes to discover or admit a route. Existing terminal-parity additions and topology prompt/tool denials SHALL remain owned by their current execution-profile contract.

#### Scenario: Local Claude configuration changes
- **WHEN** the operator changes ordinary Claude plugins, MCP, skills, instructions, settings, or account-visible models before the next invocation
- **THEN** both direct Claude and HarnessDock resolve that native state without HarnessDock copying or enumerating its identities
