## Why

A Codex lead currently performs one typed MCP call for every independent Agent
it wants to launch. The repeated call boundary adds orchestration latency and
repeats route discovery even when several rows intentionally use the same exact
Harness and execution root. A batch convenience can remove those caller
round-trips without creating a Team, scheduler, route policy, or transaction.

## Required Baseline

Implementation is strictly ordered after
`harden-agent-spawn-recovery-and-accounting` (Change A). It also composes after
the completed route/worktree/provenance/catalog/Agent-card/blocking changes
named by Change A and the accepted `prove-direct-harness-parity` baseline.
Before implementation, those changes SHALL be synchronized or frozen as one
explicit stacked source/spec baseline. Change B does not reinterpret them.

## What Changes

- Add `dispatch_agents` as a ninth typed MCP/runtime operation with one matching
  `$codex-harnessdock:dispatch-agents` Skill. Singular `spawn_agent` remains the
  preferred one-Agent operation.
- Accept `rows`, an ordered array of 1..8 complete singular-spawn requests. Each
  row supplies `task_name`, `message`, full explicit route/effort/authority, and
  only current spawn optionals; no field is inherited across rows.
- Run pure whole-array structural preflight first. Then run a pre-reservation
  environment preflight that may perform the existing bounded service ensure
  and fresh discovery once per exact canonical `(harness, executionRoot)`.
  Any preflight failure launches no Agent or model turn, though an allowed local
  service ensure may have occurred.
- Launch rows sequentially in caller order through Change A's authoritative
  singular lifecycle seam, repeating final target/route/lease/pre-submit gates.
- Return ordered results with derived public `agent_name`, whether a public
  Agent exists, and one closed outcome: `launched`, `rolled_back`,
  `lifecycle_owned`, `ownership_uncertain`, or `not_attempted`.
- Finish classifying the current row when cancellation arrives, then start no
  later row. Stop after the first `ownership_uncertain`. Never roll back an
  earlier row.
- Extend operator accounting and zero-model release acceptance to the ninth
  tool/Skill without adding model-facing usage totals.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `canonical-agent-orchestration`: add the stateless ordered dispatch operation
  and matching guidance while retaining singular spawn.
- `typed-mcp-orchestration`: define the strict rows schema, two preflight
  phases, ordered receipt, cancellation, and subsequent MCP generation.
- `operator-usage-ledger`: count one batch tool call, each explicit requested
  route row, and each bounded row outcome under Change A's privacy rules.
- `plugin-release-readiness`: verify exactly nine tools/Skills and rebaseline
  the compact catalog without model use.

## Impact

Implementation changes the public MCP/runtime catalog, one Skill, dispatch
orchestration behind `runtime/index.mjs`, fake-runtime tests, operator ledger
parser, release smoke, API generation, and later package metadata. It adds no
durable batch identity, shared route/default, dependency graph, retry, fallback,
cross-row rollback, barrier behavior, model-facing usage aggregate, worktree
creation, install, release, or live provider test without separate authority.
