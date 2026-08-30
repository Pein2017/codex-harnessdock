## ADDED Requirements

### Requirement: Claude listing exposes exact per-model effort choices
`list_harnesses` SHALL report the fresh exact Claude model set and exact effort choices for each model using the same bounded route shape as other Drivers. It SHALL not expose or use a default model, default effort, alias, fallback chain, local configuration identity, provider account detail, or model-quality ordering.

#### Scenario: Claude models have different effort bounds
- **WHEN** native Claude inspection reports different effort sets for two models
- **THEN** the listing preserves each set and spawn admits only the exact model-specific choice stated by Codex
