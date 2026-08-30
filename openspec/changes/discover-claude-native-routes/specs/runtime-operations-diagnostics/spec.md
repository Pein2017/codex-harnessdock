## ADDED Requirements

### Requirement: Doctor reports Claude native catalog evidence without guessing
The read-only doctor SHALL distinguish executable absence, control-protocol incompatibility, authentication unavailability, malformed model evidence, missing per-model effort evidence, and exact route drift. It SHALL report bounded attempted-source and failure-class facts without emitting executable paths, config paths/content, credentials, account identifiers, model defaults, plugins, MCP servers, tools, skills, or prompt-template identities.

#### Scenario: Claude control inspection cannot enumerate efforts
- **WHEN** the configured executable reports models but not complete exact per-model effort evidence
- **THEN** doctor reports the instance unavailable for exact routing and does not recommend or synthesize a static effort table
