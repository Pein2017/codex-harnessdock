## ADDED Requirements

### Requirement: Claude route facts come from bounded native control inspection
The Claude Driver SHALL obtain its current exact model and per-model effort facts from the configured Claude executable under the ordinary configured `CLAUDE_CONFIG_DIR` using a bounded native initialization/model-list control exchange. Inspection SHALL send no user prompt, create no accepted turn, invoke no provider model, select no default, and persist no HarnessDock catalog.

#### Scenario: Native Claude inspection succeeds
- **WHEN** the exact configured executable returns a complete bounded selectable-model response with exact per-model effort evidence
- **THEN** the ready Claude instance publishes only that complete current projection and closes the control process without a model turn

#### Scenario: Native Claude evidence is incomplete
- **WHEN** model or per-model effort evidence is absent, ambiguous, malformed, oversized, unsupported, or inconsistent with the installed control protocol
- **THEN** the Claude instance is unavailable with a redacted reason instead of using a checkout-owned table, alias, default, prior result, or provider guess

### Requirement: Claude route is revalidated immediately before transport
Claude spawn SHALL validate the caller's exact model and effort against a fresh inspection and SHALL revalidate the same tuple immediately before native prompt submission. An Agent SHALL retain its accepted exact route; disappearance or drift SHALL fail before submission without fallback, reroute, or replay.

#### Scenario: Claude catalog changes after listing
- **WHEN** the listed exact model or effort is absent from pre-transport native inspection
- **THEN** spawn fails before session creation or prompt submission and does not select another Claude model or effort
