## MODIFIED Requirements

### Requirement: Installed MCP bootstrap remains descriptor-only
The Plugin snapshot SHALL declare an absolute canonical checkout bootstrap and working directory for the `codex_harnessdock` stdio server. The current snapshot and every retained new-identity descriptor-only compatibility shell SHALL validate the fixed checkout and its production dependencies, then load `/data/CoordExp/codex-harnessdock/runtime/mcp-server.mjs` in the same Node process with the fixed checkout environment. They SHALL NOT retain a second resident child merely to relay inherited stdio. A pre-cutover `cc_for_pein` descriptor MAY exist only inside the explicit rollback backup and SHALL NOT remain enabled or discoverable after acceptance. No route SHALL import or execute an MCP lifecycle implementation from the Plugin Cache.

#### Scenario: New task starts installed MCP server
- **WHEN** Codex launches the installed HarnessDock Plugin's stdio command
- **THEN** one Node process validates and runs the canonical checkout MCP entry without a resident bootstrap child

#### Scenario: Retained new-identity descriptor starts installed MCP server
- **WHEN** an existing post-cutover task launches a relative bootstrap from a retained recent HarnessDock discovery shell
- **THEN** that descriptor validates and loads the canonical checkout MCP entry in its own process while preserving protocol framing

#### Scenario: Pre-cutover descriptor is observed after acceptance
- **WHEN** installed discovery still enables or advertises a `cc_for_pein` MCP descriptor
- **THEN** acceptance fails instead of treating that descriptor as a live compatibility alias

#### Scenario: Canonical checkout is unavailable
- **WHEN** the fixed checkout, MCP entrypoint, configuration, manifest, or production dependencies are missing or invalid
- **THEN** MCP startup fails closed with the checkout-specific recovery action without loading cached or upstream runtime code

## ADDED Requirements

### Requirement: Model-visible orchestration guidance is compact without losing the public contract
The installed Plugin SHALL expose the same eight MCP tools, strict schemas, safety boundaries, exact-route fields, fixed-wait semantics, completion-token behavior, and lifecycle distinctions using a compact guidance surface. The aggregate descriptions exposed for the eight MCP tools SHALL contain no more than 4,500 characters, the eight installed lifecycle Skill files SHALL contain no more than 12,000 bytes in aggregate, and the Plugin default-prompt strings SHALL contain no more than 800 characters in aggregate. Detailed operation guidance SHALL live once in the owning Skill instead of being repeated in every tool description.

#### Scenario: Codex discovers HarnessDock tools
- **WHEN** the installed MCP server exposes its tool catalog
- **THEN** the eight names and schemas remain unchanged and the aggregate exposed descriptions satisfy the 4,500-character bound

#### Scenario: Codex loads one lifecycle Skill
- **WHEN** a lifecycle operation requires its owning Skill
- **THEN** that Skill still states its exact invocation, authority, wait, error, and stop rules without requiring duplicated common prose from every other Skill

#### Scenario: Guidance compaction is proposed
- **WHEN** a wording deletion would remove an exact model/effort requirement, authority boundary, completion-delivery rule, or fail-closed condition
- **THEN** acceptance rejects the deletion even if the size budget would pass
