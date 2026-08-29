## ADDED Requirements

### Requirement: Differential authority proves prompt-and-receipt-only behavior
For every route declaring `authorityEnforcement=prompt_only`, deterministic differential evidence SHALL prove that `write: true` and `write: false` use byte-equivalent native argv, environment, configuration sources, tool surface, plugin/MCP inputs, sandbox inputs, and transport options. Only the bounded authority prompt text and HarnessDock receipt may differ.

#### Scenario: Authority changes a Pi tool list
- **WHEN** either authority value adds, removes, or filters a native Pi tool compared with the other
- **THEN** the differential authority row fails even if neither test task mutates a file
