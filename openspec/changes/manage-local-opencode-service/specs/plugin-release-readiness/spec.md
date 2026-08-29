## MODIFIED Requirements

### Requirement: Default release smoke costs no Claude model usage
The checkout SHALL provide a release smoke that verifies the enabled current HarnessDock record, matching installed snapshot, current Plugin minor version, exactly eight `$codex-harnessdock:*` Skills, an absolute canonical-checkout descriptor bootstrap, exactly eight `codex_harnessdock` MCP tools, and successful isolated `list_agents` and fresh `list_harnesses` calls through the production isolated runtime path. MCP bootstrap MAY ensure or reuse the fixed local OpenCode Server, but the smoke SHALL NOT start a Codex, Claude, Pi, OpenCode, or provider model turn. The smoke SHALL verify the current MCP generation, retained compatibility shells and known predecessor coverage, and SHALL reject concurrent legacy `cc_for_pein` discovery.

#### Scenario: Matching installation is ready
- **WHEN** the operator runs default release smoke after local refresh or versioned release
- **THEN** it exercises the installed snapshot, current generation, shared OpenCode service ensure/reuse, and MCP protocol successfully without model usage

#### Scenario: OpenCode executable or service is unavailable
- **WHEN** zero-model smoke cannot reuse or ensure a compatible fixed-origin Server
- **THEN** it accepts the bounded unavailable OpenCode instance while still verifying the eight-tool contract and no model execution

#### Scenario: Installed current snapshot is stale
- **WHEN** installed current version or discovery content differs from the checkout
- **THEN** smoke fails before MCP execution and instructs the operator to run the appropriate local refresh

#### Scenario: Known predecessor is missing
- **WHEN** successful-install metadata names an unreconstructable previous version
- **THEN** smoke fails with actionable compatibility repair instead of accepting an empty shell set
