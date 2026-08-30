## ADDED Requirements

### Requirement: Doctor explains native generation drift with safe evidence
Doctor SHALL report whether the exact executable identity and native-reported configuration evidence were unchanged, changed, or unavailable between bounded observations, together with the affected route/capability disposition. Operator detail MAY name an allowlisted configured candidate path already owned by HarnessDock, but model-facing output SHALL remain opaque and every secret, credential, endpoint, raw config value, and native extension identity SHALL be redacted.

#### Scenario: Configured executable candidate is stale
- **WHEN** the explicit HarnessDock executable setting resolves to a missing or identity-changed file
- **THEN** doctor reports the configured candidate and failure class without searching another installation or silently selecting one from PATH

#### Scenario: Benign native generation changes
- **WHEN** the generation changes while the exact route remains admitted
- **THEN** doctor reports the observation separately from route availability and does not instruct the operator to clear durable Agent state
