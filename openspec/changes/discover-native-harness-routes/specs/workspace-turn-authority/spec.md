## MODIFIED Requirements

### Requirement: Behavioral authority is explicit and immutable per Agent
Every version-3 Agent SHALL carry `behavioral_read_only` or `behavioral_write` authority selected explicitly at spawn. The authority SHALL remain immutable across follow-up and recovery. For Pi and OpenCode, both values SHALL be represented only in the Harness prompt and durable route/receipt evidence; their snapshots SHALL state `authorityEnforcement=prompt_only`, `leafEnforcement=prompt_only`, and `nativeOrchestration=opaque_bounded`. Public topology remains `leaf`, while opaque native delegation is neither enumerated nor controlled by HarnessDock. Changing `write` SHALL NOT filter native tools, change argv/process permissions, plugins, MCP configuration, sandbox, or native configuration. The Plugin SHALL NOT describe either value as filesystem containment.

#### Scenario: Read-only Agent starts
- **WHEN** explicit behavioral read-only authority is admitted by the selected route
- **THEN** every turn inherits that prompt/receipt boundary and receipts identify its actual enforcement strength

#### Scenario: Write Agent starts on a native route
- **WHEN** explicit behavioral write authority is admitted by Pi or OpenCode
- **THEN** its prompt and immutable receipt permit task-scoped writes while its native configuration is otherwise identical to the read-only route

#### Scenario: Follow-up requests write
- **WHEN** a read-only Agent receives a request to change authority
- **THEN** the request fails and a separately named write-authorized Agent is required
