## ADDED Requirements

### Requirement: Doctor reports bounded fresh native-route discovery
The read-only operator doctor SHALL report bounded, redacted current Pi and OpenCode discovery status, including route availability, discovery freshness, and exact model-specific effort/variant choices necessary to diagnose an unavailable native route. It SHALL not launch a model, start or reconfigure a native Harness, expose endpoints, credentials, configuration paths or content, plugins, MCP servers, tools, prompt templates, or arbitrary provider catalog fields. It SHALL distinguish unavailable, ambiguous, and route-drift conditions from successful native-model execution.

#### Scenario: Native route discovery is available
- **WHEN** doctor completes bounded Pi RPC and OpenCode fixed-origin discovery without a model inference call
- **THEN** it reports redacted route availability and discovery facts without claiming model liveness or tool/plugin enumeration

#### Scenario: Native route discovery fails
- **WHEN** Pi configuration/RPC discovery or the attached OpenCode Server cannot prove a bounded route
- **THEN** doctor returns an actionable redacted unavailable, ambiguous, or drift result without repairing, reloading, or changing configuration
