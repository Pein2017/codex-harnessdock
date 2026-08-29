## Context

See `proposal.md` for motivation and the four delta specs for behavior. `discover-native-harness-routes` already made Pi/OpenCode discovery fresh and exact, but the generic inspection validator still treats route facts as an opaque bounded object, canonical validation permits a missing effort on non-MCP paths, and the installed spawn Skill carries mutable route rosters plus a stale Pi tool-containment claim. `runtime/index.mjs` remains the sole public lifecycle interface.

## Goals / Non-Goals

**Goals:**

- Put exact per-model effort validation at the shared Driver contract so every caller and future Driver inherits it.
- Make fresh Driver inspection the one current model-facing inventory and keep static guidance semantic rather than catalog-shaped.
- Preserve honest prompt/receipt authority and existing durable route ownership.

**Non-Goals:**

- No new Harness, Driver, provider registry, discovery cache, route selector, model call, benchmark, process sandbox, or plugin/MCP inventory.
- No install, release, archive, or public lifecycle-method change in this package.
- No Claude native discovery; that is owned by the dependent `discover-claude-native-routes` change.

## Decisions

### 1. One normalized route-facts shape is validated at inspection

Every ready instance uses `models: string[]` plus `effortsByModel: Record<string, string[]>`. Validation snapshots the ordinary data once, bounds keys/atoms/counts, requires exact key equality with `models`, rejects duplicates and empty lists, and preserves native effort strings byte-for-byte. Source-specific convenience fields such as Pi's aggregate `reasoningEfforts` may remain Driver-internal but never drive admission or public guidance.

Alternative rejected: let each Driver validate its own effort field. That is the current gap and allows a new Driver or internal caller to create a route shape the MCP layer cannot describe safely.

### 2. Effort is a universal canonical-route field

`validateCanonicalRoute` requires `effort` before comparing the request with the fresh inspection. Driver validators receive a complete tuple and may narrow it further, but may not supply, alias, normalize, or default the field. Follow-up inherits the durable value and never reopens selection. A legacy record with an explicit persisted effort may be revalidated; a record without one remains readable but cannot start new work because any migration would invent user intent.

Alternative rejected: rely on the current Zod-required `reasoning_effort`. It protects only one public entry and does not protect recovery, internal callers, future transports, or corrupt durable data.

### 3. Skills describe procedure, not mutable inventory

The spawn Skill states mandatory fields, authority/topology meaning, error/stop behavior, and the requirement to call `list_harnesses`. It contains no current model IDs or effort roster for any Harness. The list Skill remains the progressive-disclosure owner of current routes. Tests mutate fake catalogs while holding every Skill byte-identical.

Alternative rejected: generate Skills from discovery during install. It would create a stale second catalog, require reload after local configuration changes, and spend context repeating data already returned by `list_harnesses`.

### 4. Authority claims derive from the capability contract

Static guidance says `write` is behavioral and tells Codex to inspect the route's enforcement. It does not enumerate a Pi read/write tool list. Driver receipts keep the accepted authority and the capability snapshot; deterministic tests compare both authority values' native inputs.

Alternative rejected: preserve stronger prose as a safety warning. A containment claim that is not enforced is unsafe because it can change task placement decisions.

### 5. The stack gets one coordinated public refresh

This change can be implemented and accepted as a source checkpoint without installing an intermediate Plugin. The final integrated stack reserves one package minor/API-generation transition after provenance and differential gates pass. No retained shell is regenerated until that authorized release step.

## Risks / Trade-offs

- [A legacy Agent lacks explicit effort] → Keep it inspectable, refuse a new turn, and require a new explicitly routed Agent; never infer a value.
- [A native Harness exposes an unexpected effort spelling] → Preserve it as an opaque exact atom and let the Driver decide whether it is runnable; do not normalize it in shared code.
- [Removing route rosters costs one extra list call] → That call is zero-model, fresh, and already the supported route-selection boundary; the context saved and drift removed outweigh the call.
- [Multiple open changes modify the same requirements] → Synchronize or archive `discover-native-harness-routes` first, then validate this delta against the new main specs before implementation.

## Migration Plan

1. With separate authorization, synchronize/archive `discover-native-harness-routes`; rebase only these planning deltas, not unrelated work.
2. Characterize current Pi/OpenCode route shapes and demonstrate failures for missing Claude effort, internal effort omission, stale Skill inventory, and false authority text.
3. Add the shared validator and migrate all three Driver projections; keep legacy records read-forward and refuse effortless activation.
4. Make Skills inventory-neutral and run focused contract, MCP, guidance, migration, doctor, and release tests plus `npm run check`.
5. Do not install or bump the public version until the complete four-change stack reaches its final authorized release gate. Rollback is the prior source checkpoint; no durable state is eagerly rewritten.
