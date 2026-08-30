## Why

HarnessDock now discovers Pi and OpenCode routes from their native configuration, but the shared Driver contract can still admit a route with no effort and the installed spawn guidance repeats mutable model/effort rosters. Live discovery can therefore disagree with the model-facing instructions that are supposed to consume it.

## What Changes

- **BREAKING:** require every ready Driver inspection to publish a non-empty exact effort set for every advertised model, and require the canonical accepted route to contain the caller-stated exact effort on every entry path.
- Reject an omitted, aliased, normalized, defaulted, or no-longer-advertised model/effort before durable Agent mutation, native session creation, or provider work.
- Make fresh `list_harnesses` output the sole model-facing source of current model/effort inventory; remove mutable Pi/OpenCode/Claude route rosters from the spawn Skill and retained Skill shells.
- Correct authority guidance so every Harness is described according to its observed enforcement. In particular, Pi and OpenCode `write` values remain prompt/receipt-only and do not imply a native tool allowlist.
- Keep exactly eight public lifecycle methods and the existing explicit `harness`, `model`, `reasoning_effort`, `topology`, and `write` spawn fields.
- Depend on synchronization or archival of `discover-native-harness-routes` before implementation because that change owns the current dynamic-discovery requirements. No synchronization, archive, install, release, or code implementation is authorized by this proposal.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-driver-runtime`: make per-model effort inventory and effort-bearing canonical routes universal Driver invariants.
- `typed-mcp-orchestration`: make fresh route listing authoritative and reject every omitted or stale exact tuple without duplicating mutable inventories in model-facing guidance.
- `workspace-turn-authority`: remove false native-tool containment claims while preserving prompt/receipt-only behavioral authority.
- `plugin-release-readiness`: require installed and retained Skills to stay inventory-neutral and coherent with live discovery.

## Impact

Expected surfaces are `runtime/harness-contract.mjs`, Driver inspection projections, runtime/MCP route validation, the eight checkout-owned Skills and compatibility shells, doctor/release checks, and focused contract/guidance tests. No new dependency, public operation, route cache, model call, benchmark, installation, release, archive, or provider registry is included.
