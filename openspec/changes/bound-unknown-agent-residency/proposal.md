## Why

HarnessDock already reclaims settled workers and idle managed OpenCode services,
but an Agent whose native settlement becomes `unknown` can retain admission
leases and a managed Harness process indefinitely. The current OpenCode idle
timer also lives inside a task-owned MCP frontend, so detached resource cleanup
is not guaranteed after that frontend exits.

## What Changes

- Add one receipt-bound, singleton, self-exiting residency manager independent
  of any Codex task's MCP process. It watches durable jobs, leases, and managed
  service receipts, wakes at the nearest durable boundary, and exits when no
  active or unknown residency remains.
- Persist exact worker and Driver-owned execution identity before it is needed
  for cleanup. PID-only, late-discovered, mismatched, foreign, operator-owned,
  and reused-service evidence remains ineligible.
- **BREAKING**: after an Agent has remained settlement-`unknown` for one hour,
  exact managed worker-tree death becomes sufficient to hard-reclaim physical
  residency and release that turn's instance or native-session admission
  capacity without claiming semantic completion.
- Release a workspace-writer lease only when the exact mutation-capable native
  process, managed service, or turn scope is also proven dead. A reused or
  operator-owned service is never terminated and keeps any writer lease whose
  execution scope remains unproven.
- Record the separate lifecycle outcome `hard_reclaimed`, project the Agent as
  `worker_lost`, preserve native settlement as `unknown`, and never synthesize
  model output, task success, or resumability.
- For an Agent that already has a validated Wake terminal-event binding,
  publish the existing billed `worker_terminal: settlement_uncertain` envelope
  after the hard-reclaim receipt and Agent lifecycle event are durable, so L0
  can reconcile the loss.
- Replace the MCP-owned repeating OpenCode reap timer with a nudge/restart of the
  same independent residency manager. Task-owned MCP stdio lifetime remains
  host-controlled and does not gain an inactivity timeout.
- Preserve inherited Harness tools, plugins, MCP, and configuration for every
  Agent. Add no process-name sweep, public force-kill command, resident global
  supervisor, service manager dependency, or Codex Core change.

Lifecycle ordering: this change builds on the current source-accepted
`stream-native-harness-progress` worker-loss reconciliation and
`publish-agent-terminal-events` descriptor-bound Wake publication. Before
implementation, their final active artifacts must be re-read or synced so this
change does not duplicate or weaken either owner.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-residency`: move detached resource deadlines to one self-exiting
  manager and bound unknown managed residency at one hour.
- `durable-runtime-state`: store exact physical residency evidence, keep
  settlement separate from hard reclaim, and release only the approved lease
  classes from a durable reclaim receipt.
- `harness-driver-runtime`: require process-backed Drivers to expose exact
  managed execution identity early enough for fail-closed later reclamation.
- `workspace-turn-authority`: permit writer release only after exact proof that
  its mutation-capable execution scope is dead.
- `local-runtime-boundary`: make managed OpenCode unknown-turn reclamation
  manager-owned while preserving reused/operator service immunity.
- `completion-delivery`: project hard reclaim as `worker_lost` and emit an
  opt-in descriptor-bound `settlement_uncertain` wake without fabricating task
  completion.

## Impact

- Affects the v3 job/launch/lease records, worker-loss reconciliation, process
  control, Pi/Claude/OpenCode Driver residency receipts, OpenCode service
  manager, completion and terminal-event projection, MCP housekeeping, and
  focused runtime/integration tests.
- Adds one short-lived detached Node process only while durable active/unknown
  residency or a managed-service deadline exists; it owns no model work and no
  public API.
- Requires a strict internal state-generation and installed-runtime restart,
  but no external package, public MCP schema, environment selector, network
  listener, or migration of legacy unknown records into kill eligibility.
- Existing legacy/identity-incomplete unknown records remain held and
  operator-visible; the new policy applies only when the complete exact
  residency receipt was captured by this generation.
