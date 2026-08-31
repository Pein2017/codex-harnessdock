## Why

HarnessDock already preserves Agent completion durably, but an inactive Codex
L0 has no supported callback that can wake it when a long HarnessDock Agent turn
settles. A coordinated producer-side terminal event lets L0 arm wake-me-up and
end its turn without making polling, streaming, or HarnessDock private state a
cross-plugin dependency.

## What Changes

- Add optional `terminal_event_descriptor_path` to singular `spawn_agent` and
  each strict `dispatch_agents` row; no field is inherited or accepted by
  follow-up operations.
- Resolve an explicitly configured wake publisher binary and runtime root, then
  preflight the private descriptor against the deterministic Agent name before
  any Agent, job, native session, or model work.
- Freeze only the descriptor path and redacted binding receipt on the immutable
  Agent turn; never expose, copy, log, or parse the bearer token in HarnessDock.
- After the existing Agent-linked completion is durable, publish exactly one
  corresponding `worker_terminal` envelope: completed to `completed`, failed to
  `failed`, interrupted to `cancelled`, and unverifiable terminal settlement to
  `settlement_uncertain` where the existing closed reason applies.
- Preserve HarnessDock completion, delivery-token, acknowledgement, progress,
  reconciliation, interruption, recovery, and Agent Card semantics. Terminal
  publication is an additional wake hint and never acceptance.
- Make crash repair publish the same deterministic immutable envelope
  idempotently; publication failure never rewrites or withholds HarnessDock's
  authoritative completion.
- Advance the strict MCP generation because the spawn and dispatch schemas gain
  an optional field.
- Do not add a resident process, private wake-me-up state reader, live progress
  wake, follow-up descriptor, automatic re-arm, automatic interruption,
  installation, release, or model-cost smoke.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `typed-mcp-orchestration`: admit and preflight an optional terminal publisher
  descriptor on singular spawn and each batch row while preserving strict route,
  authority, receipt, and restart-generation boundaries.
- `completion-delivery`: publish one idempotent external terminal envelope only
  after the existing durable Agent completion fact is settled, without changing
  completion delivery or acknowledgement semantics.

## Impact

- Affects strict MCP schemas/generation, spawn and dispatch preflight, immutable
  Agent/job records, terminal reconciliation, runtime configuration, focused
  tests, Skills, and release validation under
  `/data/CoordExp/codex-harnessdock-dev`.
- Depends on the source-accepted wake-me-up change
  `admit-scopeless-worker-settlement` and its descriptor preflight/publication
  CLI; loaded integration requires a separately authorized install/restart.
- Adds no external package dependency and no second lifecycle owner.
