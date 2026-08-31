## Why

The current MCP cancellation signal stops `wait_agent` observation but singular
`spawn_agent` does not consult it. A caller can therefore cancel while spawn
continues through reservation and detached handoff without returning a usable
public recovery handle. Separately, the operator usage ledger still parses the
retired Claude-only route shape, so current Pi, OpenCode, and
`native_orchestrator` calls are misclassified or lose their actual route.

This change repairs those existing contracts before any batch-dispatch surface
is added.

## Required Baseline

This change is drafted against the current source plus the completed route,
worktree, Agent-card, blocking, catalog, and provenance changes that have not
all been synchronized into stable specs. Before implementation, the lead SHALL
freeze one stacked baseline in which these changes are accepted or synchronized:

- `add-target-worktree-agent-spawn`
- `discover-native-harness-routes`
- `discover-claude-native-routes`
- `enforce-exact-discovered-routes`
- `bind-routes-to-native-provenance`
- `fail-closed-opencode-interaction-admission`
- `improve-agent-card-and-usage-receipts`
- `expose-actionable-agent-blocking`
- `compact-mcp-catalog-guidance`

Their current successful Agent Card, exact-route, redaction, target-worktree,
and blocking contracts are inputs, not behavior this change may replace.

## What Changes

- Honor MCP cancellation at safe singular-spawn boundaries. A cancellation
  before durable ownership prevents new work; one observed after worker/native
  launch may have begun waits for the existing handoff disposition and never
  interrupts or guesses rollback.
- Return a bounded structured error result containing the stable public
  `agent_name` and exact `lifecycle_owned` or `ownership_uncertain` outcome when
  rollback is not safe. Proven pre-identity failures do not invent a name.
- Redact internal Agent/job/session/instance identifiers, absolute paths, and
  raw provider text from those errors.
- Repair the operator-only ledger to parse the current explicit
  `harness`/full-model/effort/`topology`/`write` invocation shape and preserve
  provider-metric provenance without adding new runtime usage persistence or a
  model-facing aggregate.
- Preserve singular `spawn_agent`, its successful Agent Card, zero-argument
  `list_harnesses`, current durable ownership records, and every existing
  no-fallback/no-retry rule.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `canonical-agent-orchestration`: expose actionable public identity only for
  non-rollback-safe singular-spawn failure.
- `typed-mcp-orchestration`: define safe cancellation and the structured,
  redacted error projection.
- `agent-thread-registry`: preserve or roll back Agent identity and mailbox only
  under the existing handoff disposition.
- `tracked-job-control`: make cancellation obey the detached/native handoff
  ownership boundary.
- `operator-usage-ledger`: parse current dynamic multi-Harness routes and
  denominators.

## Impact

Implementation will touch singular-spawn cancellation checks, bounded MCP worker
error transport/redaction, existing ownership-disposition projection, operator
ledger parsing/tests, and one public MCP generation. It adds no batch tool,
durable field, retry, fallback, replacement session, Team/DAG/scheduler,
cross-row rollback, model-facing usage aggregate, install, or release action.
