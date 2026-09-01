## Context

See [proposal.md](proposal.md) for motivation. Current V3 jobs already persist
the supervisor worker as exact `{pid, identity}`, record the start of unknown
settlement in `uncertainty.recordedAt`, reconcile a lost worker through the
Driver's `observeTurn()`, and release ordinary leases only from normalized
settlement. Claude also exposes an exact accepted-child locator, while Pi owns
an exact RPC child without persisting its process identity. OpenCode separately
stores a managed-service receipt and one private lease per admitted turn.

The existing OpenCode reaper is exact and fenced, but its repeating timer is
owned by the MCP stdio process. The runtime already has the two primitives
needed to remove that dependency: durable directory locks and
`waitForDurableActivity()`. The active `stream-native-harness-progress` and
`publish-agent-terminal-events` changes remain the owners of lost-worker
observation and descriptor-bound publication respectively; this change extends
their terminal boundary rather than adding parallel mechanisms.

## Goals / Non-Goals

**Goals:**

- Bound current-generation settlement-unknown resource residency at one fixed
  hour while keeping semantic settlement unknown.
- Recover admission capacity after exact worker-tree death and writer capacity
  only after every mutation-capable scope is proven dead.
- Make cleanup independent of the Codex task/MCP lifetime without introducing a
  permanently resident supervisor.
- Preserve exact managed/reused ownership and make every retry idempotent.

**Non-Goals:**

- No inactivity policy for a healthy running Agent, Codex native subagent, MCP
  stdio frontend, or operator-owned service.
- No public kill/reclaim tool, process-name scan, service-manager dependency,
  new network endpoint, Driver output PID, or synthetic model result.
- No change to inherited tools, plugins, MCP servers, environment, or Harness
  configuration.
- No automatic reclamation of legacy or identity-incomplete unknown records.

## Decisions

### 1. Persist one closed physical-residency variant on the V3 attempt

The V3 record generation advances once and gains a private
`physicalResidency` value bound by the enclosing root, Agent, job, attempt,
route, and launch claim. It has exactly one Driver-owned variant:

```text
local_process  { pid, identity }
managed_service { pid, identity, commandFingerprint, receiptGeneration,
                  turnLeaseToken }
reused_service  { turnLeaseToken }
```

The existing `worker: {pid, identity}` remains the supervisor identity rather
than being duplicated. Records contain no command, arbitrary path, endpoint,
prompt, output, or credential. A managed-service value is valid only while the
existing service receipt and turn lease revalidate together. A reused-service
value deliberately carries no termination capability.

Alternative: discover children later with `ps` or process names. Rejected
because PID reuse, foreign peers, and missing launch lineage make a later sweep
unsafe.

### 2. Bind Driver residency through one awaited private launch callback

`launchContext` gains one process-local callback that atomically binds the
closed residency value to the current attempt. A process-backed Driver must
await it after exact child identity exists and before any prompt/input can cross
the native transport. A service Driver awaits it after managed/reused ownership
and the exact turn lease are known, also before submission.

- Claude reuses its awaited accepted-child `onSpawn` fence and existing
  `{pid, processIdentity}` observation.
- Pi exposes its already-spawned RPC child's PID, obtains the existing Linux
  start identity, and binds it before `rpc.prompt()`.
- OpenCode binds either the exact managed-service receipt plus turn lease or the
  closed reused-service classification before its prompt request.

The same callback binds the exact worker identity and Driver-validated
provisional native-turn reference in the launch claim. It does not claim native
acceptance. Ordinary acceptance copies that identical reference into the final
claim and V3 running record. If the worker dies after this binding but before
the running record is written, reconciliation marks the claim
`acceptance_unknown` and materializes one V3 `unknown` record whose
`uncertainty.recordedAt` is the recovery observation time. That record is then
governed by the same one-hour policy; input is never replayed. An incomplete or
contradictory provisional reference remains an operator hold and is not made
hard-reclaim eligible.

Binding failure is pre-transport rejection and disposes only the exact child or
unsubmitted turn lease just created. The callback is private because process
control is neither native settlement nor a public Driver result.

Alternative: add residency to the live-turn return value. Rejected because Pi
and Claude may submit before `startTurn()` returns, which would preserve the
orphan window.

### 3. Use one detached, receipt-bound, self-exiting Node manager

The first durable residency/lease transition calls `ensureResidencyManager()`.
Under the existing durable directory lock it validates the current manager
receipt by PID, start identity, state-root digest, and generation. It either
keeps that exact manager or starts the checkout-owned Node entrypoint detached,
waits for its receipt, and releases the launch lock. Concurrent starters may
not create two valid owners; stale receipts are replaceable only after exact
identity validation.

The manager repeatedly:

1. takes a fenced snapshot of current-generation jobs, leases, and managed
   service receipts;
2. performs due reconciliation or exact reclamation;
3. derives the nearest unknown or idle-service deadline; and
4. awaits `waitForDurableActivity()` over those durable directories.

Filesystem notifications remain hints; the helper's bounded recovery wake
forces a reread. Durable writes themselves are the nudge, so no socket, queue,
heartbeat protocol, or second timer framework is added. MCP
`onOperationComplete` only ensures a missing manager; it no longer owns a
repeating reap timer.

When a fenced reread finds no running job, eligible unknown deadline,
managed-service idle deadline, or current managed residual disposition, the
manager removes its own matching receipt and exits. A retained reused-service
writer/turn lease is operator state with no automatic deadline and therefore
does not keep the manager resident. A later operation repairs a crashed or
missing manager from durable state.

Alternative: keep the MCP alive or install a system service. Rejected because
both add residency to solve residency, and task transport lifetime is not an
Agent lifecycle authority.

### 4. Start the hard boundary only from durable unknown settlement

The hard deadline is the fixed instant
`Date.parse(uncertainty.recordedAt) + 3_600_000`; it is not configurable and is
never refreshed by reads, health checks, restarts, progress, or failed cleanup.
A `running` job with a live exact worker is ineligible regardless of age.

If a running record's exact worker is gone, the manager invokes the existing
lost-worker reconciler. At every due unknown boundary it gives the Driver one
final `observeTurn()` opportunity: coherent terminal evidence takes the normal
completion path; active or unknown evidence leaves semantic settlement unknown
and permits only the physical policy below. Legacy generations, missing
residency, mismatched identity, contradictory lease state, or an ambiguous
observation fail closed for automatic reclaim.

Alternative: use last activity or task archive time. Rejected because neither
proves when settlement became unknown, and both can be refreshed accidentally.

### 5. Fence hard reclaim as an idempotent physical state machine

Under the job lock, the manager rechecks generation, attempt, `unknown` status,
deadline, launch claim, and exact residency, then writes one reclaim claim. A
normal terminal commit that won before this claim remains authoritative. Once
claimed, no later observer may turn process exit or delayed prose into semantic
completion.

The owner then uses existing exact process-control primitives: validate
PID/start identity, send the existing bounded `SIGTERM` process/process-group
request only to receipt-owned targets, wait for exact death, and never escalate
to a name sweep. Already-absent exact targets are acceptable; PID reuse,
receipt drift, a still-live target after the bound, or uncertain lease mutation
is not. Service termination additionally reuses the existing command
fingerprint, loopback, peer, and service-manager fence.

Durable phases separate `claimed`, `physical_dead`, `lease_pending`, and
`committed`. A crash after signalling resumes from the exact death receipt and
does not signal again. A crash or ambiguity during lease unlink retries only
that exact lease disposition. `committed` records released and intentionally
retained lease classes and closes the internal job as `hard_reclaimed` while
retaining its last observation and `settlement=unknown`.

Alternative: feed a fabricated failed result through
`releaseLeasesOnSettlement()`. Rejected because it would conflate capacity
recovery with native/model settlement and could free writer authority early.

### 6. Apply the user-selected release matrix

Admission means the matching instance lease for an initial turn or native
session lease for a follow-up. Every row first requires the exact supervisor
worker to be dead; read-only rows simply have no writer lease.

| Driver-owned scope after one hour | Process action | Admission | Writer | Service-turn lease |
| --- | --- | --- | --- | --- |
| Claude/Pi exact local tree | terminate if needed and prove dead | release | release if present | n/a |
| OpenCode managed, target is sole turn | terminate exact service and prove dead | release | release if present | release |
| OpenCode managed, peer work remains | do not terminate shared service | release | retain | retain until the target later becomes sole and exact closure succeeds |
| OpenCode reused/operator-owned | never terminate service | release | retain | retain for operator reconciliation |

This intentionally recovers read/admission throughput while an old service
turn may remain semantically unknown. The writer lease is the safety barrier:
later mutation-capable work still fails closed. Releasing a native-session
lease never makes the `worker_lost` Agent resumable and does not authorize a
follow-up. If peers later leave a managed service, the manager may complete the
same residual exact disposition without changing Agent state or waking L0 a
second time.

Alternative: retain every lease forever. Rejected by the chosen capacity
policy. Releasing every lease on worker death was rejected because a reused or
shared service may still mutate the workspace.

### 7. Project resource loss once and reuse the existing Wake mapping

After `committed` is durable, the completion owner emits one deterministic
Agent lifecycle event: Agent `errored`, reason `worker_lost`, no assistant
message, continuation, or semantic result. Reconciliation repairs a missing
event from the reclaim receipt exactly as it repairs ordinary completion.

If and only if the initial Agent already carries a validated terminal-event
binding, the existing terminal publisher receives the closed `unknown`
settlement projection and therefore publishes
`worker_terminal: settlement_uncertain`. It runs after both reclaim and Agent
lifecycle durability. Publication success/failure changes neither leases nor
settlement, and the existing immutable event identity makes crash replay
idempotent. No descriptor means no external call; L0 sees `worker_lost` on its
next natural operation.

Alternative: define a new Wake outcome or publish before lease disposition.
Rejected because the existing outcome already means exactly this, and an early
wake could observe an uncommitted resource state.

### 8. Treat active changes as dependencies, not duplicate owners

Implementation first rereads or syncs the final active
`stream-native-harness-progress` and `publish-agent-terminal-events` artifacts.
The former remains the only Driver observation/reconciliation owner; the latter
remains the only external terminal publisher. This change adds a physical
reclaim caller and one nonsemantic lifecycle projection at those seams.

## Risks / Trade-offs

- [One-hour reclaim can discard a still-running orphaned managed turn] -> It is
  an explicit hard capacity bound, applies only after durable unknown state,
  performs one final observation, and never reports semantic success/failure.
- [Admission reopens while a reused service turn remains unknown] -> Retain the
  writer and service-turn leases; the recovered capacity is intentionally not
  mutation authority or resumability.
- [Manager crashes or two callers race to start it] -> Exact receipt identity,
  one durable launch lock, fenced reclaim claims, and idempotent projections.
- [PID reuse or service ownership drifts] -> Fail closed; signal and release
  nothing without the complete current-generation receipt.
- [Shared managed service prevents immediate full cleanup] -> Release admission
  only, retain authority leases, and retry the residual exact disposition when
  peer lease changes wake the manager.
- [Wake publication fails] -> Preserve durable `worker_lost`, record the bounded
  existing publication failure, and add no fallback callback.

## Migration Plan

1. Re-read/sync the two active dependency changes and add focused RED cases for
   MCP-timer loss, missing Pi identity, one-hour unknown leakage, release-matrix
   safety, and nonsemantic completion.
2. Advance the private job/route generation; add the awaited residency binding
   and fail closed before transport for current Drivers. Legacy records remain
   readable but ineligible for automatic reclaim.
3. Add the self-exiting manager using the existing lock, durable wait, worker
   reconciliation, process-control, service-manager, and lease primitives;
   remove only the MCP-owned repeating timer.
4. Add hard-reclaim state/projection and route descriptor-bound loss through
   the existing terminal publisher.
5. Run focused crash/retry and exact-process tests, `npm run check`, strict
   OpenSpec validation, and a zero-model installed-runtime lifecycle smoke.
   Stop before package promotion, restart, or paid/fresh Agent work unless those
   actions are separately authorized.

Rollback disables new admission before stopping the manager, lets in-flight
current-generation turns settle or reach an explicit operator hold, then
restores the prior runtime. It never downgrades or rewrites a committed
`hard_reclaimed` record, resurrects its Agent, releases retained writer leases,
or makes legacy records kill-eligible.
