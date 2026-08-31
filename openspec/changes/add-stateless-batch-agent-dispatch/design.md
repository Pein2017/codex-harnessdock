## Context

Change A owns singular-spawn cancellation, public non-rollback-safe failure,
handoff disposition, identity redaction, and current route accounting. Change B
is only an additive fan-out transport. The existing singular path, dynamic
route discovery, immutable execution root, writer lease, native pre-submit
gates, waits, mailboxes, and completion delivery remain their current owners.

The Required Baseline in `proposal.md` is an implementation gate. Stable specs
that still describe an older tool count or route shape are not independently
sufficient until that baseline is reconciled.

## Goals / Non-Goals

**Goals:**

- Remove N-1 MCP launch calls for 4- and 8-row independent fan-out.
- Reuse only exact call-local discovery/readiness facts.
- Preserve authoritative row ownership, cancellation, and recovery.
- Keep every route and write decision explicit per row.

**Non-Goals:**

- No Team, batch Agent, DAG, scheduler, queue, dependency, role template,
  shared route/default, automatic selection, retry, fallback, cross-row
  rollback, worktree creation, barrier redesign, or model-facing usage total.
- No replacement or deprecation of singular `spawn_agent`.
- No attempt to make unlike Agent launches transactional across roots or
  external Harnesses.

## Decisions

### 1. Input rows are current spawn requests, not public Agent handles

The strict input is:

```text
dispatch_agents({ rows: [1..8 complete spawn rows] })
```

Each row requires `task_name`, `message`, `harness`, full `model`,
`reasoning_effort`, `topology`, and boolean `write`; it admits only the same
optional `description` and `target_worktree` currently lawful for singular
spawn. `agent_name` is derived output, never an input alias. No batch-level
field supplies a route, execution root, authority, retry, dependency, or
default.

### 2. Structural preflight is pure and whole-array

Before readiness or service activity, validate the outer object, 1..8 row
bound, strict row shapes, valid/unique `task_name`s, forbidden fields, and
deterministic duplicate canonical public names. A schema error is an ordinary
typed MCP rejection with no row receipt. A runtime structural conflict after
strict decoding returns every valid row as `not_attempted` and launches none.

This phase creates no Agent, mailbox, job, lease, native session, service, or
model work.

### 3. Environment preflight may ensure services but creates no Agent

After structural success, resolve/admit each target worktree, derive canonical
execution roots, reject collisions with currently existing root Agent names,
reject two batch writers targeting the same root, and obtain
fresh route/readiness evidence per exact `(harness, executionRoot)` pair. This
phase may perform only the existing spawn-authorized bounded local service
ensure (for example starting the managed OpenCode server); it creates no Agent,
mailbox, job, native session, or model request.

If any row fails, all result rows are `not_attempted`: failing rows carry a
sanitized reason and other rows state `batch_preflight_stopped`. Service ensure
is not misreported as a zero-side-effect operation. Passing this phase reserves
nothing and makes no atomic promise against another root or later route drift.

### 4. Sequential launch reuses the singular owner and repeats final gates

Rows launch in caller order through one shared internal seam also used by
singular spawn; dispatch does not copy lifecycle logic. Before each row, the
runtime rechecks cancellation, target ownership when applicable, name
reservation, route/provenance drift, writer/instance capacity, and every
Driver-specific pre-submit/pre-session gate. Call-local discovery may be reused
only for an exactly equal canonical pair and never replaces these gates.

A `rolled_back` row may permit the next row. `lifecycle_owned` also permits the
next row because ownership is known and its public Agent is independently
controllable. `ownership_uncertain` stops all later rows. There is no rollback
of prior rows and no retry of the current one.

### 5. Cancellation settles the current row and stops later rows

Cancellation observed before the first row launch marks all rows
`not_attempted`. Cancellation during a row is forwarded to Change A: the
current row reaches its authoritative `launched`, `rolled_back`,
`lifecycle_owned`, or `ownership_uncertain` result without dispatch
interrupting it. Remaining rows become `not_attempted`. Transport loss may
prevent receipt delivery; it does not make replay safe.

### 6. Receipt is ordered and row-local

The bounded receipt is:

```json
{
  "rows": [
    {
      "agent_name": "/root/example",
      "agent_exists": true,
      "outcome": "launched",
      "card": {}
    }
  ]
}
```

Every decoded row has its deterministic public `agent_name`. `agent_exists` is
true for `launched`, `lifecycle_owned`, and `ownership_uncertain`; false for
`rolled_back` and `not_attempted`. `card` appears only for ordinary
`launched`; other rows carry only bounded sanitized stop/error evidence. There
is no aggregate success, batch ID, completion, usage, or inferred acceptance.

| outcome | exact meaning | `agent_exists` | continue |
| --- | --- | --- | --- |
| `not_attempted` | row launch never began or a final pre-identity gate rejected it | false | yes unless batch stop/cancel applies |
| `rolled_back` | reservation or launch preparation began and Change A proved guarded rollback safe | false | yes |
| `launched` | ordinary singular-spawn handoff succeeded | true | yes |
| `lifecycle_owned` | an error occurred but durable lifecycle ownership is proven | true | yes |
| `ownership_uncertain` | launch may exist and ownership cannot be proven | true | no |

Reissuing a partially executed request is unsafe and ordinarily collides on
existing names. The caller may reconcile each deterministic public name through
existing Agent operations, then submit only genuinely `not_attempted` work as a
new explicit request. There is no `skip_existing` or idempotency mode.

### 7. Accounting and release integrate without new owners

The operator ledger counts one `dispatch_agents` MCP call, N strictly decoded
requested route rows, and each closed row outcome. It discards task content,
target worktrees, private IDs, and raw errors, and it does not calculate batch
provider usage. Existing per-Agent completions retain their own provider
metrics and dispositions.

Zero-model release smoke verifies exactly nine MCP tools/Skills, one subsequent
API generation, compatibility shells, and the compact catalog budget. The
ninth tool must fit the existing 4,500-character serialized catalog budget by
removing duplication, not safety semantics or by raising the bound without a
separate decision.

## Risks / Trade-offs

- **Environment preflight looks atomic.** It reserves nothing; final row checks
  remain authoritative and partial launch remains possible.
- **Service ensure violates a literal no-side-effect claim.** State it
  explicitly and bound it to the existing spawn-authorized manager.
- **Cancellation loses the receipt.** Deterministic public names and durable
  per-Agent state are recovery facts; no batch replay protocol is added.
- **Sequential launch may not improve model execution latency.** The measured
  value is fewer lead/MCP calls and amortized exact-pair discovery, not fewer
  task/model tokens.
- **A ninth surface grows static context.** Preserve the catalog budget and
  singular fast path; abandon B if safety wording cannot fit.

## Migration Plan

1. Accept Change A and reconcile the named stacked baseline.
2. Add RED schema/preflight/outcome/cancellation/accounting/catalog tests.
3. Add `dispatch_agents` and its Skill in one MCP generation subsequent to A.
4. Implement the shared internal singular-launch seam, two preflight phases,
   exact-pair discovery reuse, and sequential receipt.
5. Run focused tests, strict OpenSpec validation, and `npm run check`; stop
   before install/release unless separately authorized.

Rollback removes the ninth operation but never rewrites or deletes Agents
already created by it. Older durable Agents need no batch-state migration
because no batch state exists.
