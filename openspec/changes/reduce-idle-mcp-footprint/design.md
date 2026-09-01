## Context

See [proposal.md](proposal.md). The stdio MCP frontend must register strict Zod schemas at process startup, so it needs the public Harness ID enum before any tool call. Today it obtains that enum from `runtime/harness-registry.mjs`, whose static imports load all three Driver implementations and their transitive graphs. The frontend otherwise delegates each call through `runtime/mcp-call-worker.mjs`; it does not need Driver factories while idle.

The accepted main specifications already require task-owned MCP stdio to remain alive until its host closes transport, one-process bootstrap, isolated per-call runtime loading, and PSS evidence separate from RSS. This change must preserve those behaviors rather than introduce another lifecycle owner.

Baseline receipts on 2026-09-01:

- Live Codex app-server: 10 owned HarnessDock MCP processes, 322,128 KiB aggregate PSS, 820,012 KiB aggregate RSS, and 211 FDs.
- Clean-checkout cold import: 45,654 KiB PSS, 95,168 KiB RSS, 22 FDs, and 241.020 ms to import `runtime/mcp-server.mjs`. These are observations, not portable thresholds.

## Goals / Non-Goals

**Goals:**

- Remove Driver implementation modules from the idle MCP frontend import graph.
- Keep one static, generation-owned public Harness ID list and fail closed if Driver registry membership drifts from it.
- Prove unchanged public tool schemas and retain comparable before/after Linux measurements.

**Non-Goals:**

- No shared daemon, Unix relay, idle MCP exit, process reaper, new lease, durable-state change, or service-lifecycle change.
- No attempt to cap memory with a host-specific absolute threshold.
- No model-facing prompt, Skill, token, route, or model call change.

## Decisions

### Put the public Harness enum beside the MCP generation

`runtime/mcp-api.mjs` will export a frozen, alphabetically ordered `HARNESSDOCK_MCP_HARNESS_IDS` array. `runtime/mcp-server.mjs` already imports this leaf module for `HARNESSDOCK_MCP_API_GENERATION`, so consuming the enum there adds no new import edge.

The Driver registry remains the sole factory owner. It derives its implemented IDs from `DRIVER_V2_FACTORIES` and fails during module initialization if those IDs differ from the MCP generation enum. This preserves a single public schema owner without letting the enum silently advertise an unimplemented Driver.

Alternative: dynamically import the registry while registering tools. Rejected because tool registration is synchronous at startup and still loads the heavy graph before serving. Alternative: duplicate string literals only in `mcp-server.mjs`. Rejected because drift would not fail at the owning boundary. Alternative: create a new identity module and move all Driver constants. Rejected because it touches more modules for no additional resource win.

### Guard the dependency boundary, not a brittle memory number

A focused source-boundary test will fail if `runtime/mcp-server.mjs` imports `harness-registry.mjs` or any `*-driver.mjs`, and existing MCP tests will continue to assert the exact tool schemas and admitted route enum. A registry test will prove its derived implementation IDs equal the public generation IDs.

Before/after PSS, RSS, FD count, and import latency use the same one-process command and are retained as change evidence. They inform acceptance but are not a cross-machine test threshold because allocator state and shared-page attribution vary.

### Preserve process and state ownership

Codex continues to start and own one stdio MCP frontend per resident task. EOF and supported shutdown still terminate only that frontend. `runtime/index.mjs`, detached workers, durable Agent/history state, mailbox delivery, waits, OpenCode managed-service activity, and service idle reclamation are unchanged.

## Risks / Trade-offs

- **Public enum and registry factories could drift** → registry initialization compares exact sorted membership and throws before discovery or launch.
- **A future frontend import could reintroduce a Driver transitively** → the focused direct-import guard catches known heavy boundaries; comparable PSS evidence remains the broader signal.
- **Memory reduction may be modest on a large-memory host** → stop after the leaf import correction; do not add a daemon unless measured pressure justifies its trust and liveness costs.
- **Concurrent `bound-unknown-agent-residency` work may touch nearby tests** → keep this branch isolated and integrate only after both commits exist; resolve behavior against both OpenSpecs, not by accepting one worktree's uncommitted state.

## Migration Plan

1. Land the leaf enum/import-boundary refactor and focused tests without changing generation 11.
2. Run focused tests, strict OpenSpec validation, and `npm run check` in this worktree.
3. Re-run the exact cold-import measurement and record the delta.
4. Integrate after the concurrent residency change is committed; rerun its focused tests plus this change's acceptance commands.

Rollback is a normal revert of the scoped refactor; no persisted data or runtime migration is involved.
