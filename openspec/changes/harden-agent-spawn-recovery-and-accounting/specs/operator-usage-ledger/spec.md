## MODIFIED Requirements

### Requirement: Usage report uses fixed replay-safe evidence
The operator surface SHALL retain its fixed UTC window, replay-safe call-ID
deduplication, exact `codex_harnessdock` namespace, frozen completion parsing,
operator dispositions, privacy boundary, and provider-reported metric
provenance. For current singular `spawn_agent` calls it SHALL parse the bounded
explicit invocation fields `harness`, full `model`, `reasoning_effort`,
`topology`, and boolean `write`; it SHALL not use a static Claude model
allowlist, retired `delegation_mode`, model-prefix Harness inference, or a
default effort/topology. Requested route counts SHALL remain distinct by exact
Harness/model/effort/topology/write tuple. Missing or malformed fields SHALL be
reported as malformed evidence, never silently normalized.

#### Scenario: Pi and OpenCode use dynamic GPT routes
- **WHEN** production-shaped calls contain bounded full models discovered by Pi
  or OpenCode
- **THEN** the ledger attributes each exact Harness route rather than rejecting
  it for absence from a Claude allowlist

#### Scenario: Native orchestrator topology is requested
- **WHEN** a current spawn call states `topology=native_orchestrator`
- **THEN** the ledger records that exact topology rather than defaulting the
  retired `delegation_mode` field to leaf

#### Scenario: Equal model text appears on distinct Harnesses
- **WHEN** two qualifying calls state the same model text but different Harness
  identities
- **THEN** their requested route rows remain separate

#### Scenario: Provider omits token or cost metrics
- **WHEN** a completion has no provider-reported value
- **THEN** the report keeps that metric unavailable and does not infer billing,
  savings, acceptance, or cache behavior

### Requirement: Operator reporting does not expose delegated content
The disposition ledger and usage report SHALL remain operator-only and SHALL
retain no prompt, final answer, arbitrary argument/output, target path,
credential, configuration identity, or internal Agent/job/session identifier.
Only the bounded current spawn route fields and existing closed
completion/disposition metrics are admitted.

#### Scenario: Current spawn contains task content
- **WHEN** the ledger parses a qualifying singular spawn call
- **THEN** it admits only route/write fields and discards task name,
  description, message, target worktree, and other delegated content
