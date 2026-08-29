## ADDED Requirements

### Requirement: Public provenance is bounded and non-selectable
`list_harnesses` and Agent receipts SHALL expose only closed provenance values and a bounded opaque generation token or explicit `unavailable` state. They SHALL NOT expose raw fingerprint inputs, executable or configuration paths, plugin/MCP/skill/tool/prompt identities, endpoints, credentials, config contents, or hashes over secrets. Spawn and follow-up schemas SHALL reject provenance and generation as caller inputs.

#### Scenario: Caller supplies an inspection generation
- **WHEN** a model-facing caller attempts to select or override provenance, a generation token, a native config path, or a capability snapshot
- **THEN** strict schema validation rejects the field before discovery or durable mutation

#### Scenario: Native config evidence is unavailable
- **WHEN** a Driver cannot obtain a safe native-reported configuration witness
- **THEN** listing reports `unavailable` provenance detail rather than reading arbitrary configuration content or fabricating a digest
