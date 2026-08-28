## MODIFIED Requirements

### Requirement: Default release smoke costs no Claude model usage
The checkout SHALL provide a release smoke that verifies the enabled current HarnessDock for Codex record, matching installed snapshot, current plugin minor version, exactly eight `$codex-harnessdock:*` Skills, an absolute canonical-checkout descriptor bootstrap, exactly eight `codex_harnessdock` MCP tools, and successful isolated `list_agents` and fresh `list_harnesses` calls through the production isolated runtime path. Harness listing MAY report Pi or OpenCode unavailable and SHALL not contact a model. The smoke SHALL verify the one current MCP generation, retained compatibility shells and known predecessor coverage, and SHALL reject concurrent legacy `cc_for_pein` discovery. The default smoke SHALL NOT start a Codex, Claude, Pi, OpenCode, or provider model turn.

#### Scenario: Matching installation is ready
- **WHEN** the operator runs default release smoke after local refresh or versioned release
- **THEN** it exercises the installed snapshot, current generation, and MCP protocol successfully without model usage

#### Scenario: Native Harness is unavailable
- **WHEN** zero-cost smoke lists Harnesses while Pi discovery fails or OpenCode is not running
- **THEN** it accepts the bounded unavailable instance while still verifying the eight-tool contract and no model execution

#### Scenario: Installed current snapshot is stale
- **WHEN** installed current version or discovery content differs from the checkout
- **THEN** smoke fails before MCP execution and instructs the operator to run the appropriate local refresh

#### Scenario: Known predecessor is missing
- **WHEN** successful-install metadata names an unreconstructable previous version
- **THEN** smoke fails with actionable compatibility repair instead of accepting an empty shell set

### Requirement: OpenCode acceptance loop is regression tested without Server or model usage
The repository SHALL test the complete OpenCode acceptance controller against a fake fixed-origin Server transport, including resolved catalog/model-specific variant discovery, explicit effort validation, agent-selector omission, exact tuple revalidation, profile rejection, prompt-only write equivalence, native acceptance, malformed output, metrics, mutation observation, mixed-route projection, route disappearance, auth/quota stop, and report finalization, without a live Server or model request. It SHALL separately test Pi native-RPC discovery and launch parity with fakes, including explicit effort validation, restored extensions, skills, prompt templates, and tools plus the resolved decision on `--offline` and `--no-approve`, without a model request.

#### Scenario: Zero-cost native-route regression runs
- **WHEN** `npm run check` executes the fake native discovery and acceptance suites
- **THEN** every listed control branch is verified with no network service or paid usage
