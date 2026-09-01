## Why

Codex currently keeps one task-owned stdio HarnessDock MCP process for each resident task. A fresh Linux observation found 10 such processes using 322,128 KiB aggregate PSS and 211 tree-local file descriptors, while each process remained owned by the live Codex app-server. This is bounded host residency rather than a proven leak, so replacing stdio with a shared daemon would add startup, caller-trust, disconnect, lock-liveness, and version-skew failure modes for a small resource win.

The smallest useful change is to stop the idle MCP frontend from importing every Harness Driver merely to build its static schema, while retaining Codex-owned stdio lifecycle and the existing isolated per-call runtime boundary.

## What Changes

- Move the public MCP generation's admitted Harness ID list to the existing leaf MCP-generation owner and make both the MCP schema and Driver registry validate against it.
- Remove the idle MCP frontend's dependency on the heavy Driver registry; no Harness implementation loads until an isolated lifecycle call needs it.
- Add one deterministic import-boundary regression and retain before/after Linux PSS, RSS, FD, and startup evidence without treating RSS as unique physical memory.
- Keep per-task stdio ownership, trusted `_meta` handling, durable Agent state, service idle reclamation, tool schemas, model-facing text, and API generation unchanged.
- Explicitly reject a shared HTTP daemon, Unix-socket relay, MCP idle TTL, process killing, and client/Agent lease registry from this change. They may be reconsidered only if later PSS evidence crosses a declared host-pressure threshold and production-shaped startup, caller identity, disconnect, lock-liveness, and version-skew gates pass.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is an implementation-only import-graph optimization under the existing `runtime-residency`, `typed-mcp-orchestration`, and `plugin-release-readiness` contracts; `skip_specs: true` is intentional.

## Impact

- Expected implementation: `runtime/mcp-api.mjs`, `runtime/harness-registry.mjs`, `runtime/mcp-server.mjs`, and focused runtime tests.
- No dependency, public tool, schema-generation, environment, process-lifecycle, persistent-state, installation, or release-format change.
- This isolated worktree is based on commit `0643f3816ba10eaee93a5991b47f2604f4107862`. The concurrent `bound-unknown-agent-residency` work remains separately owned and must be integrated after both changes are committed; this change does not edit its files or semantics.
