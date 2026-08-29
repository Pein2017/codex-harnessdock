## MODIFIED Requirements

### Requirement: Explorer prompt and result stay narrow and Harness-neutral
The Driver SHALL construct each turn from one versioned stable authority/topology/return prefix of no more than 450 characters, the caller's bounded task message carried unchanged inside an unforgeable delimited block, and no task-specific policy not supplied by the caller. The prefix SHALL state behavioral authority, leaf/no-delegation topology, final-assistant-only delivery, bounded output, and honest unknown reporting. It SHALL NOT universally require file/line citations, impose task decomposition or methodology, request cross-worker synthesis, or define a repository JSON ontology. Success SHALL return exactly one matching nonempty bounded outer-assistant final text plus optional closed Driver metadata; malformed lineage, empty/oversized output, native tool/event history, or terminal UI output SHALL not be projected as success.

#### Scenario: Valid Explorer result arrives
- **WHEN** the exact matching assistant response contains one nonempty bounded final text
- **THEN** the Driver projects it as the final Agent result without exposing native tool history

#### Scenario: Caller needs a task-specific format
- **WHEN** Codex includes that evidence or return request in the task message
- **THEN** OpenCode may follow it, but the shared prefix does not impose it on unrelated tasks or parse it into a global contract

#### Scenario: Caller task contains an envelope delimiter
- **WHEN** the caller text could close or forge the stable task block
- **THEN** the Driver refuses it before submission rather than escaping, rewriting, or weakening the envelope

## ADDED Requirements

### Requirement: Dormant OpenCode route discovery remains native and spawn-time exact
When the fixed Server is absent, HarnessDock SHALL discover candidate OpenCode model identifiers and reasoning-effort variants from the configured executable under the operator's ordinary native configuration without a model request. The listing SHALL distinguish dormant configuration evidence from live Server validation. Immediately before native session creation, the Driver SHALL ensure the Server and require its current provider catalog to advertise the same exact model and effort; drift SHALL fail before prompt submission.

#### Scenario: Server is dormant and native configuration is valid
- **WHEN** native CLI diagnostics advertise exact configured model/effort variants and the corresponding credential provider
- **THEN** `list_harnesses` reports those bounded routes as available on demand without starting the Server

#### Scenario: Server catalog drifts from dormant discovery
- **WHEN** the ensured Server does not advertise the selected exact model or effort
- **THEN** spawn fails before session creation or model usage instead of substituting another route

#### Scenario: Native plugins or MCP configuration change
- **WHEN** the operator changes ordinary OpenCode configuration before the next discovery
- **THEN** HarnessDock observes the executable's fresh native result without supplying `--pure`, an agent override, a model override, or a HarnessDock-owned config copy
