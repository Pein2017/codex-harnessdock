## ADDED Requirements

### Requirement: Fresh listing is the sole model-facing route inventory
Model-facing HarnessDock guidance SHALL direct Codex to a fresh `list_harnesses` call for current Harness, model, effort, topology, maturity, and readiness facts. Spawn Skills, tool descriptions, default prompts, compatibility shells, and static schemas SHALL NOT duplicate a mutable roster of native model IDs or effort choices, imply a default route, or override a fresh Driver inspection.

#### Scenario: Native configuration adds or removes a route
- **WHEN** a local Harness changes its model or effort inventory between Codex tasks
- **THEN** the next fresh listing reflects the new complete inventory without a Skill edit, Plugin reload, alias, remembered value, or schema regeneration

#### Scenario: Codex loads spawn guidance
- **WHEN** the installed spawn Skill is loaded before route selection
- **THEN** it states the mandatory route fields and fail-closed rules but contains no mutable current model/effort roster
