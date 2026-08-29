## MODIFIED Requirements

### Requirement: Default release smoke costs no Claude model usage
The checkout SHALL provide a release smoke that verifies the enabled current HarnessDock record, matching installed snapshot, current Plugin minor version, exactly eight `$codex-harnessdock:*` Skills, one canonical-checkout in-process MCP bootstrap, exactly eight `codex_harnessdock` MCP tools, and successful isolated `list_agents` and fresh `list_harnesses` calls through the production isolated runtime path. MCP startup and the smoke SHALL NOT start an absent OpenCode Server or a Codex, Claude, Pi, OpenCode, or provider model turn. The smoke SHALL verify the current MCP generation, retained compatibility shells and known predecessor coverage, and SHALL reject concurrent legacy `cc_for_pein` discovery.

#### Scenario: Matching installation is ready
- **WHEN** the operator runs default release smoke after local refresh or versioned release
- **THEN** it exercises the installed snapshot, one-process MCP entry, dormant or live native route discovery, and MCP protocol successfully without model usage

#### Scenario: OpenCode executable, diagnostic, or service is unavailable
- **WHEN** zero-model smoke cannot prove a compatible dormant or live OpenCode route
- **THEN** it accepts the bounded unavailable OpenCode instance while still verifying the eight-tool contract and no model execution

#### Scenario: Installed current snapshot is stale
- **WHEN** installed current version or discovery content differs from the checkout
- **THEN** smoke fails before MCP execution and instructs the operator to run the appropriate local refresh

#### Scenario: Known predecessor is missing
- **WHEN** successful-install metadata names an unreconstructable previous version
- **THEN** smoke fails with actionable compatibility repair instead of accepting an empty shell set

## ADDED Requirements

### Requirement: Runtime and model-context optimization acceptance stays evidence-bounded
Acceptance SHALL verify one-process MCP startup, demand-driven OpenCode startup, one-hour idle eligibility, active/unknown lease protection, owned-only termination, preserved durable state, and the declared model-visible size budgets with deterministic zero-model tests. Resource evidence SHALL report process counts and Linux PSS separately and SHALL NOT sum RSS as unique physical memory. Token evidence SHALL report stable control-text sizes plus provider-reported input, cache-read, cache-write, output, and reasoning fields separately; it SHALL NOT infer cost or token avoidance from elapsed time, service reuse, or a cache flag.

#### Scenario: Deterministic acceptance runs
- **WHEN** focused tests and `npm run check` execute
- **THEN** they prove lifecycle and context-budget branches without starting a Harness model and leave no test-owned service or supervisor process behind

#### Scenario: Live OpenCode smoke is explicitly authorized
- **WHEN** the operator requests the final live witness after zero-model gates pass
- **THEN** acceptance runs at most one `openai/gpt-5.6-luna` low-effort bounded turn, reports its native usage fields without derived savings, and performs no automatic paid retry

#### Scenario: Static context shrinks but a safety fact disappears
- **WHEN** size budgets pass while an exact-route, authority, lifecycle, delivery, or fail-closed invariant is absent from the installed guidance
- **THEN** release acceptance fails despite the smaller text
