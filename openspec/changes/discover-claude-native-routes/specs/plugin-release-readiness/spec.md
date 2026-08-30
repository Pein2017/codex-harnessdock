## ADDED Requirements

### Requirement: Claude native discovery acceptance is zero-prompt first
Release acceptance SHALL use fake native control transport to prove complete replacement, exact model/effort validation, alias/default refusal, route drift, redaction, process cleanup, and no user prompt or model request. Only after deterministic gates pass may a separately authorized live witness run one zero-prompt inspection and at most one `claude-haiku-4-5` low-effort minimal turn, with no automatic retry and no fallback.

#### Scenario: Deterministic Claude discovery suite runs
- **WHEN** focused tests and `npm run check` execute
- **THEN** they cover success and failure branches without Claude model usage and leave no inspection process behind

#### Scenario: Live witness hits authentication or quota failure
- **WHEN** the separately authorized bounded witness cannot inspect or run the exact route
- **THEN** it records a sanitized failed witness and stops without retrying, changing model, or weakening the deterministic gates
