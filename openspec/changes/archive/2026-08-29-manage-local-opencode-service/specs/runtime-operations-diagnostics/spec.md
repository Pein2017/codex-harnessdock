## ADDED Requirements

### Requirement: Doctor reports bounded fresh native-route discovery
The read-only operator doctor SHALL report bounded, redacted current Pi and OpenCode discovery status, including route availability, discovery freshness, exact model-specific effort choices, OpenCode service readiness and managed/reused status, and closed Pi configuration or RPC failure reasons. Doctor SHALL NOT launch a model, start, stop, repair, or reconfigure a native Harness, acquire the OpenCode service ownership fence, expose endpoints, executable/configuration paths, credentials, plugins, MCP servers, tools, prompt templates, or arbitrary provider fields.

#### Scenario: Managed or reused OpenCode is available
- **WHEN** doctor can inspect a compatible fixed-origin Server without mutation
- **THEN** it reports bounded service and route availability without claiming model liveness or changing ownership state

#### Scenario: Pi configuration is missing
- **WHEN** the canonical environment does not provide a valid `PI_CODING_AGENT_DIR`
- **THEN** doctor reports the closed redacted missing-configuration reason instead of the catch-all `unknown`

#### Scenario: Native route discovery fails
- **WHEN** Pi RPC discovery or the current OpenCode service cannot prove a bounded route
- **THEN** doctor returns an actionable redacted unavailable, ambiguous, drift, executable, or protocol result without repairing or changing configuration
