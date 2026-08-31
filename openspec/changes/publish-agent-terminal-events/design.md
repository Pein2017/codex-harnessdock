## Context

See [proposal.md](proposal.md) for motivation. HarnessDock's completion inbox is
already the durable, at-least-once handoff owner. `wait_agent` observes it only
while L0 has an active turn; no supported host callback can reactivate an idle
L0. The coordinated wake-me-up change supplies a read-only descriptor preflight
and immutable worker-terminal publication CLI.

The initial-turn public inputs are decoded in the MCP/server and Agent runtime.
Terminal completion is finalized in the v3 worker loop and repaired through v3
and retained legacy reconciliation. Every producer-side publish path must be
derived from the same durable completion fact rather than Driver prose, process
exit, progress, or a second lifecycle state.

## Goals / Non-Goals

**Goals:**

- Bind one optional external terminal publisher to one initial Agent turn before
  model work.
- Publish only after HarnessDock completion is durable and keep the existing
  completion/token contract authoritative and byte-stable.
- Make crash repair idempotent without adding a resident process or reading the
  wake plugin's private state directly.
- Keep singular spawn and stateless dispatch rows explicit and strict.

**Non-Goals:**

- No descriptor on follow-up, send, or existing Agents.
- No live-progress wake, callback daemon, automatic L0 follow-up, interruption,
  acceptance, or monitor management.
- No candidate-commit claim or Git attestation from HarnessDock.
- No installation, local release, MCP restart, archive, push, or paid live
  Agent smoke in source acceptance.

## Decisions

### Add one optional row-local descriptor path

`terminal_event_descriptor_path` is accepted only by singular spawn and each
complete dispatch row. It is an absolute private local path, never inherited,
defaulted, echoed, or accepted by continuation operations. The deterministic
public Agent name remains the producer identity.

Alternative: pass a monitor condition or wake token through the Agent Card.
Rejected because L0 already owns the reservation response and the bearer must
never enter MCP input or output.

### Preflight through the configured wake CLI before ownership

Two checkout-owned environment keys select an absolute publisher executable and
the exact wake runtime root. Descriptor admission invokes the real CLI with
`shell:false`, bounded timeout/output, the descriptor path, and expected Agent
name. Only a compatible redacted receipt admits the existing spawn lifecycle.
Missing configuration, unusable executable, wrong producer, invalid private
file, stale bearer, or incompatible event epoch fails before Agent reservation,
lease, job, native session, or model request. Dispatch performs this in its
whole-array preflight so one failure launches no row.

HarnessDock persists the private path plus redacted reservation/fingerprint
evidence only. It never parses or copies the descriptor JSON.

Alternative: defer validation until terminal publication. Rejected because an
unusable requested wake contract would strand L0 until monitor expiry after
model spend.

### Publish from one shared terminal helper after durable completion

A small Harness-neutral helper maps the already normalized Agent completion to
one bounded worker envelope and invokes the configured descriptor CLI. It uses a
mode-0600 temporary event payload inside checkout-owned private runtime state,
bounded subprocess time/output, `shell:false`, and unconditional temporary-file
cleanup. It records only redacted publication identity, timestamp, or bounded
failure classification.

The v3 worker loop calls the helper after completion publication. The v3 and
retained legacy reconciliation paths call the same helper only when completion
is already durable and local publication has neither succeeded nor reached a
recorded terminal failure. A crash between external acceptance and the local
marker retries the identical envelope; wake-me-up owns immutable idempotency.
A returned publish failure is recorded once and is not a retry loop.

Alternative: publish directly from each Driver. Rejected because it duplicates
cross-plugin policy and can race before normalized settlement or completion
durability.

### Keep completion neutral and map closed outcomes only

Completed, errored, and interrupted completion states map to external
`completed`, `failed`, and `cancelled`. Existing explicitly terminal uncertainty
maps only to wake-me-up's admitted `settlement_uncertain` reason. Progress,
working, waiting, starting, interaction questions, and stream closure never
publish a terminal event. HarnessDock never emits `delivered` or success.

External publish success or failure cannot change Agent status, final message,
completion event, delivery token, first-delivery freeze, acknowledgement cursor,
or retention. A woken L0 still calls targeted `wait_agent` to collect the
authoritative completion and acknowledges its token only through the existing
later-wait rule.

### Advance one strict public generation

Singular and dispatch schema updates, runtime wiring, Skills, and generated MCP
artifacts ship under one generation. Existing Agent/job records treat terminal
binding fields as absent. No migration fabricates a descriptor for old turns.
A stale MCP process stops at the existing restart-required boundary.

### Classify every terminal write site

- v3 worker-loop terminal finalization is wake-eligible only after durable
  completion.
- v3 job-store and retained job-store reconciliation are repair-eligible through
  the shared deterministic helper.
- Driver terminal normalization is not a wake writer.
- Completion inbox delivery/acknowledgement, progress publication, list/read,
  interruption request, and pruning are not external terminal writers.
- A recorded external publish failure is terminal diagnostic evidence and is
  not automatically retried; an unrecorded crash window is safely retryable by
  identical publication.

## Risks / Trade-offs

- [External publisher accepted but local marker was lost] -> Retry the exact
  immutable envelope and rely on wake-me-up idempotency.
- [External publication fails after completion] -> Preserve completion, record
  bounded diagnostic evidence once, and let the monitor expiry wake L0 without a
  fallback callback.
- [Descriptor file disappears during a long turn] -> Preflight proves initial
  validity but terminal publication can still fail; retain the exact failure and
  never fabricate delivery.
- [Cross-repo source versions drift] -> Require descriptor preflight and event
  epoch compatibility; source acceptance stops before loaded-runtime claims.
- [Public schema collides with active dispatch/progress changes] -> Build on the
  current nine-tool generation, preserve complete row validation, and advance
  the generation once.
- [Terminal publish blocks finalization] -> Use a bounded subprocess and run it
  only after authoritative completion is durable.

## Migration Plan

1. Add RED MCP/schema, preflight, persistence, ordering, mapping, failure, crash,
   and reconciliation tests without changing production code.
2. Add the optional fields and fail-closed preflight before existing lifecycle
   ownership.
3. Add private binding fields and one shared terminal publisher helper; wire the
   v3 terminal seam and both reconciliation owners.
4. Run focused tests, `npm run check`, strict OpenSpec validation, and a zero-model
   cross-repo vertical slice using the real wake CLI against a temporary runtime
   root.
5. Stop before release/install/restart. A separately authorized activation must
   promote both source owners, install compatible versions, open a fresh Codex
   task, and prove one mixed native/HarnessDock all-settled wake.

Rollback removes the public field and publisher helper while leaving ordinary
completion records readable. Descriptor-bound in-flight turns must first reach
terminal local publication/failure or be explicitly abandoned; no rollback may
silently discard their requested wake contract.
