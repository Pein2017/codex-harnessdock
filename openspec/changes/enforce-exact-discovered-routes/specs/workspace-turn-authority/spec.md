## ADDED Requirements

### Requirement: Authority guidance matches observed enforcement
Every public receipt and installed Skill SHALL describe `write` using the selected route's observed authority enforcement and SHALL NOT claim native tool filtering, sandboxing, process permissions, plugin/MCP restriction, or filesystem containment that the Driver does not prove. Prompt/receipt-only routes SHALL pass the same native execution configuration for both authority values except for the bounded authority prompt and receipt.

#### Scenario: Pi read-only authority is selected
- **WHEN** Codex spawns Pi with `write: false`
- **THEN** guidance and receipts identify behavioral prompt/receipt authority and do not promise a read-only native tool allowlist

#### Scenario: Authority value changes native configuration
- **WHEN** a regression makes `write` select different argv, environment, tools, plugins, MCP, sandbox, or native settings
- **THEN** authority contract acceptance fails even if the generated prompt still states the requested behavior
