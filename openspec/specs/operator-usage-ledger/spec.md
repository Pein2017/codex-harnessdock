# operator-usage-ledger Specification

## Purpose

Provide a privacy-preserving operator-only record that connects HarnessDock runtime use and provider-reported metrics to explicit lead acceptance outcomes without expanding the model-facing Agent API.

## Requirements

### Requirement: Acceptance disposition is explicit and operator-owned
The operator surface SHALL append a disposition for one exact completion delivery token only when an operator supplies one of `accepted_first_pass`, `accepted_after_correction`, `rejected_or_escalated`, or `surface_failure`. It SHALL store only a one-way token digest, the closed disposition, record timestamp, and schema version. It SHALL NOT infer acceptance from completion, acknowledgement, follow-up, model text, tests, terminal status, or metrics. A later valid disposition for the same token MAY supersede the earlier value in reports while preserving the append-only history.

#### Scenario: Lead accepts a first-pass completion
- **WHEN** the operator records `accepted_first_pass` for an exact delivery token
- **THEN** the durable ledger appends a validated owner-only record whose token is stored only as a digest

#### Scenario: No disposition was recorded
- **WHEN** a completion appears in a usage report without a matching valid ledger record
- **THEN** its acceptance outcome is `unknown`

#### Scenario: Worker completion is successful
- **WHEN** an Agent reports completion but no lead/operator disposition exists
- **THEN** the runtime does not infer acceptance from that success

#### Scenario: Disposition is corrected
- **WHEN** the operator later records another valid outcome for the same delivery token
- **THEN** reports use the latest valid record while the earlier append-only record remains auditable

### Requirement: Usage report uses fixed replay-safe evidence
The operator surface SHALL produce a fixed UTC half-open-window report, defaulting to the preceding seven days, from Codex rollout `mcp_tool_call_end` events whose server is exactly `codex_harnessdock`. Events from any other server name, including the retired `cc_for_pein` identity, SHALL NOT be admitted as usage: after the authorized durable-state reset there is no pre-cutover lineage to represent, and a retired-identity event in the window SHALL be counted only as an identity diagnostic. The report SHALL index retained owning-session and direct-parent IDs, scan retained rollouts in deterministic oldest-first order, and reserve each non-empty MCP `call_id` before applying the report window, so a historical event copied into a later fork cannot become recent usage. It SHALL report primary-rollout records without an ID separately, reject malformed IDs, and fail closed for no-ID fork records or fork files whose direct parent is not retained. It SHALL aggregate tool counts, explicit tool errors, wait outcomes, spawn route selections, unique completion deliveries, closed terminal metrics, and operator dispositions. Provider-reported cost SHALL be labeled as provider-reported rather than billed or estimated cost. The report SHALL expose its generated time, window bounds, scanned-file count, qualifying-call count, retired-identity diagnostic count, replay exclusions, unresolved replay diagnostics, and malformed evidence counters.

#### Scenario: Rollout event is replayed in another file
- **WHEN** two qualifying records carry the same non-empty MCP call ID
- **THEN** the report counts the call once and increments its replay-exclusion counter

#### Scenario: Historical call is copied into a later fork
- **WHEN** a canonical pre-window event and an in-window fork-materialized copy carry the same non-empty MCP call ID
- **THEN** the report reserves the canonical occurrence before windowing and does not count the copied event as in-window usage

#### Scenario: Retired-identity event appears in the window
- **WHEN** a rollout records a `cc_for_pein` MCP event inside the report window
- **THEN** the report excludes it from usage totals and increments the retired-identity diagnostic counter without guessing a transition boundary

### Requirement: Operator reporting does not expose delegated content
The disposition ledger and usage report SHALL remain outside the seven model-facing tools and Skills. Except for the closed spawn route fields admitted by the usage requirement, they SHALL NOT persist or output task prompts, Claude final messages, assistant history, raw or unadmitted tool arguments, arbitrary tool output, environment values, native Claude session IDs, internal job IDs, or absolute runtime-state paths. Malformed ledger or rollout records SHALL never become accepted outcomes and SHALL be counted as diagnostics or skipped.

#### Scenario: Wait completion contains a final message
- **WHEN** the report parses a successful wait receipt containing completion text
- **THEN** it aggregates only admitted status, token digest, route, metrics, and disposition fields and discards the message content

#### Scenario: Malformed disposition record exists
- **WHEN** a ledger line fails closed-schema validation
- **THEN** the report increments a malformed-ledger counter and treats the affected completion as `unknown`

#### Scenario: Model-facing catalog is inspected
- **WHEN** Codex discovers the installed Plugin tools and Skills
- **THEN** the catalog remains exactly the existing seven Agent operations with no usage or disposition tool
