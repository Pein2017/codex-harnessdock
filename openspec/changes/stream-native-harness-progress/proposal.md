## Why

Pi and OpenCode already expose structured non-interactive progress, but HarnessDock currently discards Pi's intermediate JSONL events and never subscribes to OpenCode events. Long turns can therefore look inert and can remain `settlement_unknown` after the primary result channel is lost even when native history later proves a terminal result.

## What Changes

- Make bounded native progress a first-class Driver capability for Pi, OpenCode, and future Harness integrations, while keeping raw model deltas, thinking, tool payloads, paths, prompts, and transcripts private.
- Project a coalesced monotonic progress snapshot into version-three durable jobs so `list_agents` and explicit `wait_agent(wake_on_progress: true)` observations work uniformly across Harnesses.
- Let explicit progress waits consume later meaningful revisions of the same turn; ordinary waits remain completion-only, quiet updates do not wake the model, and completion always wins.
- Consume Pi RPC lifecycle/tool/message events directly and subscribe to OpenCode's read-only session event/history surfaces without simulating a TTY or switching the turn submission contract to `prompt_async`.
- Promote restart-safe terminal observation only from an exact durable native-turn locator and coherent Driver-owned evidence. Active, missing, foreign, or contradictory observations remain unknown and retain leases.
- Invoke the existing version-three worker-loss reconciler at bounded `wait_agent` reconciliation points so a later authoritative terminal observation can publish completion and release leases exactly once.
- Require future Harness proposals to state and test their non-interactive progress and terminal-observation capabilities; experimental admission may report them unavailable, but a Harness route cannot claim validated lifecycle maturity while a natively available progress surface is ignored.

Explicit non-goals:

- No terminal/TUI emulation, interactive chat broker, permission-question relay, raw token streaming, new Desktop UI, new public tool, or automatic model-facing progress loop.
- No OpenCode `prompt_async` migration, cross-Harness fallback, input replay, synthetic terminal state, or relaxation of completion and lease safety.
- No duplicated full native transcript or generic event bus in HarnessDock.

Lifecycle ordering: this change builds on the existing version-three launch claim, durable job, event-woken wait, completion inbox, and worker-loss reconciliation contracts. It changes only explicit progress observation and proven post-loss terminal projection; ordinary completion waits and existing delivery tokens retain their authority.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-progress-delivery`: make bounded progress Harness-neutral, durable for version-three turns, coalesced, and repeatedly observable only after a newer meaningful revision.
- `canonical-agent-orchestration`: preserve completion-first joins while allowing deliberate repeated progress observations of one active turn without exposing raw streams.
- `harness-driver-runtime`: define the native progress sink and evidence rules, require explicit progress capability treatment for future Harnesses, and connect exact terminal observers to version-three reconciliation.
- `opencode-explorer-runtime`: add read-only native event/history observation and exact restart-safe terminal observation while retaining synchronous prompt submission and fail-closed lineage.

## Impact

- Primary runtime seams: `runtime/harness-contract.mjs`, `runtime/v3-job-store.mjs`, `runtime/v3-worker-loop.mjs`, `runtime/v3-turn-reconciliation.mjs`, `runtime/internal-runtime.mjs`, and `runtime/agent-runtime.mjs`.
- Pi adapter seams: `runtime/pi-rpc-process.mjs` and `runtime/pi-driver.mjs`.
- OpenCode adapter seams: `runtime/opencode-client.mjs`, `runtime/opencode-driver.mjs`, and the existing managed-service boundary.
- Focused Driver, progress, reconciliation, wait-race, redaction, flood/backpressure, and differential-parity fixtures change. No new dependency or external runtime is introduced.
- Repeated progress is an intentional public behavior change but uses the existing `wake_on_progress` input and receipt shape; release still requires a new Plugin cachebuster and Codex task reload because Driver capability snapshots and model-facing guidance change.
