## Context

The current runtime already owns the required durable truth:
`rollback_safe`, `lifecycle_owned`, and `ownership_uncertain`; version-three
launch claims; Agent/mailbox preservation; and unknown-settlement lease
retention. The defects are narrower: spawn ignores the MCP abort signal, a
non-rollback-safe thrown error omits the public Agent name, one duplicate-name
path can leak an internal Agent ID, and the operator ledger parses a retired
route shape.

The Required Baseline in `proposal.md` is part of this design. Implementation
does not begin from stable specs alone while those completed changes remain
unsynchronized.

## Goals / Non-Goals

**Goals:**

- Stop singular spawn promptly only while no durable/native ownership can have
  been created.
- Preserve the existing handoff disposition after launch may have begun.
- Give the caller one public reconciliation handle without exposing private
  runtime identity.
- Account for current explicit multi-Harness route arguments from existing
  rollout/completion evidence.

**Non-Goals:**

- No new durable lifecycle or usage schema.
- No attempt to cancel or interrupt an accepted worker/native turn.
- No batch dispatch, retries, fallback, route defaults, Team/DAG/scheduler,
  barrier change, or model-facing usage aggregate.
- No replacement of the successful Agent Card or current blocking vocabulary.

## Decisions

### 1. Existing handoff disposition remains the only rollback authority

Cancellation is an observation about the caller, not evidence that a worker or
native turn did not start. The runtime checks the abort signal before route
work and again before durable Agent reservation. Once OS worker spawn or native
submission may have begun, it completes the existing handoff classification:

| boundary | cancellation result | durable effect |
| --- | --- | --- |
| before route/readiness or reservation | `AbortError` | no Agent/job/model work |
| reservation/preparation, with proven `rollback_safe` | cancelled failure | existing guarded rollback |
| launch begun, `lifecycle_owned` | structured failure with public name | Agent/job/leases remain owned |
| launch begun, `ownership_uncertain` | structured failure with public name | Agent/job/leases remain for reconciliation |

It does not add a public cancel operation, signal a child, infer submission from
transport closure, or rewrite the disposition because the MCP client left.

### 2. Non-rollback-safe failure is structured but remains failure

When transport is still able to receive the result, the MCP adapter returns an
error result with only:

```json
{
  "agent_name": "/root/example",
  "outcome": "lifecycle_owned",
  "code": "bounded_public_code",
  "message": "sanitized actionable text"
}
```

`outcome` is exactly `lifecycle_owned` or `ownership_uncertain`. It is not a
successful spawn receipt and carries no private Agent ID, job/session ID,
instance/config identity, path, prompt, route dump, or provider error. A failure
before a public name is valid stays an ordinary sanitized error without
`agent_name`.

If transport loss prevents delivery, durable Agent state and the deterministic
public name derived from the requested `task_name` remain the recovery facts;
the runtime does not create a request or batch replay protocol.

### 3. Redaction closes both content and identifier shape

The final MCP projection removes internal Agent IDs in addition to the existing
session/job/UUID/path patterns. Duplicate-name errors retain the conflicting
public Agent path and actionable name conflict, not the registry ID. Tests use
representative private identifier shapes and prove they do not survive.

### 4. The ledger parses existing evidence instead of creating a second ledger

`operator-usage-ledger` continues to read replay-safe Codex
`mcp_tool_call_end` and frozen completion receipts. For singular spawn it
admits bounded current arguments:

```text
harness, full model, reasoning_effort, topology, write
```

It removes the static Claude model allowlist and retired `delegation_mode`
parser. Counts remain separated by exact Harness/model/effort/topology/write;
missing provider usage remains unknown. No new runtime usage record, price
table, billing inference, or model-facing total is introduced.

### 5. Public error change gets its own generation

Because a non-rollback-safe failure gains structured model-visible fields,
Change A increments the MCP API generation once and requires a refreshed Plugin
and new Codex task when later released. This is distinct from the subsequent
generation required by Change B. Older durable Agents need no migration.

## Risks / Trade-offs

- **Cancellation arrives during handoff.** Finish classification rather than
  terminate or guess; the caller may not receive a result after disconnect.
- **A public name is mistaken for proof of model submission.** The separate
  outcome states only ownership disposition, not completion or acceptance.
- **Dynamic route text expands ledger cardinality.** Bound the existing public
  route atoms and preserve Harness identity rather than merge them.
- **Stable specs lag source.** Block implementation until the named baseline is
  composed and revalidated.

## Migration Plan

1. Reconcile the named baseline and freeze current successful receipts.
2. Add RED characterization for cancellation boundaries, non-rollback-safe
   error projection, identifier redaction, and current ledger invocation shape.
3. Implement the smallest safe-boundary checks and bounded error transport.
4. Repair the ledger parser without adding runtime persistence.
5. Increment one MCP generation, run focused tests and `npm run check`, then
   stop before install/release unless separately authorized.

Rollback preserves every non-rollback-safe Agent and existing frozen evidence;
it may remove the additive error projection/parser only after retaining readers
for any already-recorded operator report shape.
