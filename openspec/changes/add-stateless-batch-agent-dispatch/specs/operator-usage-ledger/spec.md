## MODIFIED Requirements

### Requirement: Usage report uses fixed replay-safe evidence
After Change A's current-route parser is accepted, the operator report SHALL
recognize `dispatch_agents` as one MCP tool call and SHALL separately inspect
each strictly decoded explicit input row as one requested
Harness/model/effort/topology/write route. It SHALL count each closed row
outcome without inferring completion, acceptance, retry, or provider usage from
the batch receipt. Per-Agent completion metrics and operator dispositions remain
their existing independently deduplicated facts.

#### Scenario: Four rows are dispatched in one call
- **WHEN** the invocation and bounded receipt are valid
- **THEN** the ledger counts one dispatch tool call, four requested route rows,
  and four row outcomes

#### Scenario: Typed dispatch rejects malformed input
- **WHEN** no strict row set reaches runtime
- **THEN** the ledger counts the tool error but invents no requested route row

#### Scenario: One row remains ownership-uncertain
- **WHEN** the receipt preserves that closed outcome
- **THEN** the ledger records operational uncertainty and does not infer model
  completion, token use, cost, or acceptance

### Requirement: Operator reporting does not expose delegated content
Dispatch accounting SHALL retain only bounded route/write fields, closed row
outcomes, replay-safe call identity, completion metrics, and operator
dispositions already admitted by Change A. It SHALL discard task names,
messages, descriptions, target worktrees, Agent IDs, raw error text, and every
batch row field not required for those counts.

#### Scenario: Dispatch contains multiple task messages
- **WHEN** the operator report parses the call
- **THEN** no delegated text or target path is persisted or emitted
