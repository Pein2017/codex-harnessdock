## Why

HarnessDock currently pays avoidable resource and model-context overhead even when no Agent work is active. A verified live snapshot on 2026-08-29 found 34 descriptor bootstrap processes using about 298 MiB aggregate PSS, one idle HarnessDock-managed OpenCode Server using about 393 MiB PSS, 13,028 model-visible MCP tool-description characters of which 8,824 repeat the same server guidance, and a 789-character OpenCode control envelope on every turn.

This change follows the completed but unarchived `manage-local-opencode-service` change. That predecessor establishes safe managed/reused service ownership and MUST be synced or archived before this change is archived so the lifecycle deltas apply in order.

## What Changes

- Remove the redundant resident descriptor bootstrap hop while retaining a canonical-checkout-only, dependency-checked, fail-closed MCP entry.
- Start the HarnessDock-managed OpenCode Server only when an OpenCode turn needs it. When the Server is dormant, discover the operator's native OpenCode models and efforts through the installed CLI without `--pure`, configuration overrides, or a model request.
- Add a configurable managed-service idle TTL with a one-hour default. Refresh activity only for real OpenCode turn use, protect active turns with exact durable leases, and terminate only a receipt-proven HarnessDock-owned process after the TTL. Preserve durable Agents, native session references, results, history, and usage receipts.
- Keep reused/operator-owned OpenCode services completely outside cleanup ownership.
- Compact MCP server instructions, per-tool descriptions, Plugin default guidance, and lifecycle Skills without changing the eight tool names, schemas, exact-route requirements, completion delivery, or safety semantics.
- Introduce OpenCode prompt envelope v2 with a smaller stable prefix. Preserve behavioral authority, leaf topology, caller-task identity and delimiter protection, final-only delivery, bounded output, and explicit unknown reporting; stop universally requiring path-and-line citations when the caller did not request them.
- Add deterministic context-size budgets and record provider-reported input, cache, output, and reasoning fields separately in acceptance evidence. Do not infer token savings from service reuse, wall-clock latency, or cache presence.
- Probe Codex host restart behavior before considering MCP idle self-exit. Unless automatic transparent reactivation is proven, keep task-owned MCP runtimes alive and make self-exit a non-goal.

### Non-goals

- No capacity limit, model or effort default, routing policy, model-family benchmark, or automatic quality/cost decision.
- No Agent unregister, session deletion, history retention TTL, result deletion, or durable-state compaction.
- No Pi daemon or Pi prompt rewrite solely to improve a benchmark number.
- No OpenCode login, plugin/MCP/configuration override, `--pure`, provider call outside the Harness, or cleanup of an operator-owned service.
- No OpenCode/Pi continuation expansion, active steering, or native-history feature work.
- No process termination based only on age, PPID 1, RSS, elapsed silence, or health probes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `runtime-residency`: define managed shared-service idle reclamation independently from durable Agent/history residency and prohibit unproven MCP idle self-exit.
- `typed-mcp-orchestration`: replace the resident bootstrap hop with one canonical MCP process and bound model-visible MCP/Skill guidance without changing the public tool contract.
- `local-runtime-boundary`: add lazy OpenCode startup, one-hour owned-only idle expiry, exact active-turn leases, and process-only reclamation.
- `opencode-explorer-runtime`: allow dormant native CLI route discovery and define the smaller v2 prompt envelope while preserving exact native configuration and route admission.
- `plugin-release-readiness`: require deterministic process-topology, lifecycle, model-visible-context, zero-model, and bounded paid-smoke acceptance evidence.

## Impact

Affected surfaces include the installed Plugin MCP descriptor and compatibility shells, MCP startup and tool descriptions, local refresh/install checks, OpenCode service ownership receipts and Driver turn lifecycle, OpenCode prompt rendering, runtime environment allowlisting, lifecycle Skills/default guidance, doctor/release diagnostics, and focused runtime/release tests. No new runtime dependency or external service is introduced. The public eight-tool API and explicit `harness + model + reasoning_effort + topology + write` spawn contract remain unchanged.
