## Context

The accepted Driver v2 boundary already has exact native turn references,
version-three durable job records, event-woken waits, and the narrow
`observeTurn()` worker-loss reconciler.  It does not have a durable,
Harness-neutral progress fact: Pi's RPC reader currently retains only
`message_end` and `agent_settled`, and OpenCode's Driver submits the ordinary
synchronous `session.prompt` request without subscribing to its read-only
session event/history APIs.  Consequently a live turn can look inert, and a
worker that loses its primary result channel can remain `unknown` even when an
exact native terminal record is available later.

Local source evidence supports a bounded native path rather than a terminal
emulator.  Pi already emits JSONL lifecycle, message, and tool records through
`runtime/pi-rpc-process.mjs`; its pre-prompt `get_entries()` leaf cursor and
counter baseline are already bound into the Pi native-turn reference.  The
installed OpenCode 1.18.25 service exposes the live instance SSE `/event`, the
bounded legacy session message read `/session/{sessionID}/message`, and
`/session/status`.  A live probe against retained HarnessDock-created sessions
showed that the newer `/api/session/{sessionID}/history` route returned an
internal error for those legacy sessions, so this change does not make that
incompatible route part of its recovery contract.  None of the admitted
surfaces requires `prompt_async`, a TTY, or an interactive chat broker.

The shared supervisor remains the public-progress owner.  Drivers may observe
native activity, but they may never persist or expose a native event, raw
message delta, reasoning, prompt, path, transcript, tool arguments, tool
result, or provider event identifier.

## Goals / Non-Goals

**Goals**

- Give each V3 active turn one optional latest, redacted native-progress
  snapshot and let a deliberate `wake_on_progress: true` wait observe each
  later meaningful revision once.
- Use Pi RPC JSONL directly and OpenCode's read-only session SSE/history
  surfaces; retain the existing synchronous OpenCode prompt submission.
- Reconcile an actually lost V3 worker through the existing exact-turn
  `observeTurn()` path, never by resubmitting input or guessing terminality.
- Make native-progress treatment an explicit closed Driver capability, so a
  future Harness cannot call its lifecycle maturity validated while silently
  ignoring an available native progress surface.

**Non-Goals**

- TTY/TUI or chat simulation, approval relaying, raw streaming, a generic event
  bus, transcript retention, polling loops, a new public tool, or a model-facing
  automatic progress loop.
- An OpenCode `prompt_async` migration, cross-Harness fallback, input replay,
  synthetic terminal state, or a change to completion acknowledgement tokens.
- Replacing ordinary completion-only waits or treating progress as a result.

## Decisions

### 1. Add a closed native-progress capability and a process-local sink

Route capability schema advances from v3 to v4 with one required dimension:
`nativeProgress: native_coalesced | supervisor_projected | unavailable`.  Its capability maturity and
provenance are required exactly like every other route dimension.  A route that
declares `native_coalesced` must implement the v2 live-turn progress
subscription; `supervisor_projected` keeps an already-owned supervisor stream
without adding a Driver subscription; `unavailable` implements neither and
never produces a synthetic update.  Pi and OpenCode declare
`native_coalesced`; the current Claude/legacy path declares
`supervisor_projected` and keeps its existing local reporter.

The v2 live-turn contract gains a process-local `subscribeProgress(listener)`
method when the accepted route declares `native_coalesced`.  A Driver starts
its native observer before prompt submission, keeps at most its latest reduced
activity until the V3 worker subscribes after creating the durable running
record, immediately replays that latest activity, and then reports changes.
The listener accepts only a Driver-reduced `NativeProgress` value:

```text
{ activity: thinking | responding | tool | retrying | reconnecting,
  toolName?: safe route atom }
```

The subscription is process-local, one-way, and best-effort.  Its unsubscribe
function is called before live-turn disposal; listener failure cannot delay or
change native transport.  Driver admission checks capability/method coherence,
and the supervisor validates this closed shape again before persistence.  This
creates one common seam without adding a function to the durable launch input,
a generic event bus, or a second terminal-result schema.

Validated lifecycle maturity requires an explicit tested `nativeProgress`
claim.  `unavailable` is acceptable only with source/compatibility evidence
that the admitted non-interactive route has no usable native progress surface;
an unexamined surface is not evidence of unavailability.  Future Harness
proposals and their admission fixtures must state this decision.

### 2. Persist only the latest meaningful V3 snapshot

`v3-job-store` gains an optional `progress` projection and
`progressDeliveredRevision` cursor for active records:

```text
{ revision: positive safe integer,
  activity: closed activity,
  toolName: safe route atom | null,
  updatedAt: ISO timestamp }
```

It is written under the existing per-record lock only when the reduced
`(activity, toolName)` changes.  The writer increments `revision` atomically;
timestamps, duplicate events, raw-event sequence changes, and reconnects alone
are not meaningful revisions.  A terminal/unknown record refuses all later
progress writes.  The record stores one snapshot, never an event list.

This is an additive V3-record field, not a new lifecycle or public job store.
Readers treat an absent field in retained schema-v1 records as no progress and
`progressDeliveredRevision: 0`; new writers emit `progress: null` and a zero
cursor until a native event arrives.  Thus no
directory copy, backfill, or conversion is needed.  By contrast, route
capability snapshots are semantic contracts: retained v3 snapshots are read
only through the existing legacy/stored-route reader for completion recovery;
they are not defaulted to the new capability or admitted for a new turn.  New
Agents/routes require v4 after the Plugin refresh.

The public projection keeps the current `progress` receipt shape
(`revision`, `activity`, `phase`, `summary`, `updated_at`) but derives generic
templates from the closed activity.  For `tool`, it may include only the
validated `toolName` in the fixed sentence.  It never names a path, command,
argument, output, thought, or model delta.  Existing V1/V2 progress remains
unchanged; V3 joins read their own durable snapshot rather than the legacy job
store.

### 3. Repeated explicit progress waits consume only a newer revision

The V3 record adds a durable delivered-progress revision cursor.  A targeted
single-Agent wait with `wake_on_progress: true` may claim the snapshot only
when `revision > deliveredRevision`; the claim advances the cursor atomically
to that revision.  Root-wide progress selection retains its existing bounded
one-update behavior and chooses only active V3 snapshots with an undelivered
revision.  Ordinary waits never read/claim progress as a wake reason.

`waitAgent()` keeps completion priority in this order: validate the wait,
reconcile eligible lost V3 workers, inspect completion, wait, reconcile once
more, then make one zero-time completion-only observation before returning a
progress receipt.  The progress claim itself rechecks the exact V3 record is
still active.  A completion visible at either recheck wins and progress is not
returned.  Multiple-target barriers remain completion-only; targeted progress
continues to require exactly one target.

### 4. Pi reduces its existing JSONL stream with a durable baseline cursor

Pi's RPC process gains an internal event hook that sees the already-framed,
size-limited JSONL object before the current lifecycle handling.  It reduces
only recognised lifecycle/message/tool transitions to `NativeProgress`; all
other records are ignored.  `message_end` and `agent_settled` retain their
current terminal duties and are never progress payloads.  Hook errors,
oversized/invalid protocol input, and a slow/throwing sink follow the existing
best-effort progress rule: they do not change prompt/result settlement.

Before `prompt`, Pi continues to capture `baselineLeafId` and baseline stats.
That leaf cursor remains in the exact native-turn reference.  A post-loss Pi
observer opens a fresh read-only RPC session for that persisted session ID,
gets entries strictly after `baselineLeafId`, and verifies the accepted route
and monotonic counters.  It may return terminal only when that bounded lineage
contains one unambiguous eligible terminal assistant outcome for the persisted
turn; active streaming, no outcome, malformed/foreign/multiple contradictory
outcomes, a regressed baseline, or RPC failure is `active`/`unknown`, never a
synthesized result.

### 5. OpenCode uses SSE for liveness and bounded message replay after disconnect

The fixed-origin OpenCode client grows a read-only, explicitly admitted
session-observation handle.  It can subscribe only to the fixed instance
`/event` stream and read only the exact session's bounded message list and
status; it inherits the same loopback/auth, redirect, byte, deadline, and
sanitised-error boundaries as the turn client.  It cannot create, prompt,
interrupt, or select another session.

At turn start, after fresh-session and caller-generated user-message identity
are proven, the Driver establishes the event subscription before dispatching
(but never awaiting) the synchronous `session.prompt` result.  The request
remains the existing `session.prompt` promise; no `prompt_async` endpoint or
changed submission contract is introduced.  Because `/event` supplies no
replay cursor, the observer filters every event by the exact session ID and
deduplicates stable message/part IDs.  On initial connection and reconnect it
uses an observe-register-observe sequence: establish and buffer the new SSE
subscription, fetch the exact session's bounded message list, reduce the
current post-user-message state, then drain buffered live events through the
same deduplicator.  A malformed frame, foreign session, duplicate ID,
bounded-read overflow, or exhaustion of the reconnect window stops progress
observation only; it neither retries the prompt nor settles the turn.  Live
handle disposal aborts the SSE/message work.

The reducer admits only session-local state that maps to the closed activity
vocabulary, plus a safe tool name when the native event supplies one.  Text,
reasoning, tool input/output, diff/path, todo, permission, and arbitrary event
data are discarded before the sink.  SSE alone is rejected because a dropped
connection loses revisions; message polling alone is rejected because it adds
latency and persistent polling with no live wake.  SSE plus one finite message
replay at connection boundaries is the smallest currently compatible
loss-tolerant read-only path.

For `observeTurn`, the Driver validates the persisted
`{sessionId,userMessageId,providerId,modelId,variant,attemptId}` locator, reads
the exact session's bounded messages and status, and reuses the existing
final-result selector only for an assistant child unambiguously bound to that
user message and accepted route.  It returns terminal only after coherent
terminal/idle evidence; missing, running, foreign, duplicate, conflicting, or
unreadable evidence remains nonterminal.  The result is then validated by the
existing normalized-terminal validator, so restart recovery cannot broaden
the deliverable contract.

### 6. Invoke worker-loss reconciliation only after proven worker loss

The V3 running record records the detached worker's exact process identity
when it is created.  The supervisor adds a small `reconcileLostV3Turns()`
helper used only at `wait_agent`'s bounded pre-wait and post-wait reconciliation
points, after ordinary input validation.  It considers only the current
owner-root's V3 `running`/`unknown` records whose Agent still names that job,
whose persisted worker identity is no longer live (PID identity, not PID
number alone), and whose accepted route coheres with the static Driver.

For each such candidate, sequentially and within the wait's remaining bounded
deadline, the helper calls `reconcileVersionThreeWorkerLoss()` with the exact
record identity and Driver.  It does not run from `list_agents`, spawn,
follow-up, or a background timer.  A live/ambiguous/reused PID, absent worker
identity, unavailable capability, cancellation, deadline, observer failure,
or contradictory native evidence leaves the record and its leases unchanged.
Only the existing reconciler may release leases, close the control stream,
write a terminal record, project the Agent, and publish completion.

### 7. Acknowledge the alternatives explicitly

- **Polling-only:** rejected.  It adds a recurring control loop, still misses
  fresh work between polls, and gives no event-woken liveness.
- **Event-only:** rejected.  A transient OpenCode SSE loss can skip a native
  transition; finite exact-session message replay is the smallest compatible
  repair.
- **TTY/chat simulation:** rejected.  It changes the interaction and
  permission authority boundary, leaks transcript-like material, and is not
  needed by either native API.

## Risks / Trade-offs

- **Native event flood or verbose payloads** → Drivers reduce before the sink;
  the supervisor stores one bounded snapshot and advances only meaningful
  changes.  No raw event is queued or durable.
- **A terminal races a progress claim** → Existing completion-first checks plus
  active-record claim validation and the final zero-time completion look make
  terminal completion authoritative.
- **OpenCode SSE reconnect loses or duplicates events** → Observe-register-observe
  message replay, stable-ID deduplication, and best-effort liveness ensure loss affects
  only advisory progress, never prompt ownership or settlement.
- **A supervisor mistakes a reused PID for a dead worker** → Require the exact
  persisted process identity and skip ambiguity; `observeTurn` is never called
  while the original worker can still own the turn.
- **A native observer sees adjacent session work** → Pi requires the persisted
  baseline lineage; OpenCode requires the exact user-message parent and route.
  Ambiguity remains unknown and retains leases.
- **Capability upgrade strands retained routes** → Read old snapshots only for
  terminal recovery; require a refreshed v4 route for new execution rather
  than silently assigning progress semantics to historic data.

## Affected Seams and Verification

The smallest implementation surface is
`runtime/harness-capabilities.mjs`, `runtime/harness-contract.mjs`,
`runtime/v3-job-store.mjs`, `runtime/v3-worker-loop.mjs`,
`runtime/agent-runtime.mjs`, `runtime/internal-runtime.mjs`,
`runtime/pi-rpc-process.mjs`, `runtime/pi-driver.mjs`,
`runtime/opencode-client.mjs`, and `runtime/opencode-driver.mjs`, with focused
Driver/progress/reconciliation/wait-race fixtures.  No public MCP operation or
dependency changes.

Focused checks must prove: redaction and coalescing under an event flood;
second explicit progress wait waking only after a later revision; completion
winning the claim race; Pi baseline ambiguity refusing settlement; OpenCode
SSE disconnect/history replay deduplication; post-loss-only observer
invocation; exact OpenCode/Pi terminal evidence settling once; and all
unsupported, malformed, foreign, active, or contradictory observations
retaining leases and publishing nothing.  `npm run check` remains the release
gate after the corresponding spec/tasks are approved.

## Migration Plan

1. Land the capability-v4, Driver, V3 projection, wait, and focused-test
   changes together; no stored V3 job conversion or transcript migration runs.
2. Retained V3 records without progress remain recoverable. Stored capability
   schemas v2/v3 are validated against the dimensions that existed in that
   schema, without fabricating or writing back the later `nativeProgress`
   claim; an explicitly present later claim must still be complete. Fresh
   routes remain strict v4, and old snapshots alone are not re-admitted for new
   work.
3. Refresh the Plugin cachebuster and start a new Codex task so fresh Driver
   capability snapshots and model-facing guidance are loaded together.
4. Rollback removes the new sink/projection and restores capability v3 only if
   no v4 route has been admitted.  If v4 records exist, retain their read-only
   terminal-recovery path until they settle; never reinterpret them as v3.

## Open Questions

None.  Exact OpenCode event type names and the Pi protocol's recognised
event-to-activity mapping are fixture-pinned during implementation; unsupported
types remain ignored rather than expanding this design's public vocabulary.
