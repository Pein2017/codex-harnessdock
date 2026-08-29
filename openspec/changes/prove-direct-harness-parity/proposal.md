## Why

Current parity tests compare HarnessDock components with HarnessDock-owned expectations. They do not demonstrate that invoking the same locally configured Claude, Pi, or OpenCode Harness directly and through HarnessDock preserves route discovery, configuration, transport, lifecycle, history, and native usage semantics.

## What Changes

- Add a source-independent differential acceptance matrix for direct native invocation versus the corresponding HarnessDock Driver, with one fixture family per Harness and closed row results: `pass`, regression `fail`, prerequisite `hold`, and capability-derived `not_applicable`.
- Implement generic deterministic matrix infrastructure and supported Pi/OpenCode rows on the accepted explicit-effort plus provenance-v3 base. Claude Code 2.1.250 exact dynamic model/effort discovery remains an evidence-backed `hold`: record its exact-route inventory cell with a sanitized negative-control receipt, never a static fallback, `pass`, `fail`, or capability-derived `not_applicable`.
- Compare exact model/effort inventory, launch argv/env, loaded native configuration evidence, prompt envelope delta, `write` parity, event ordering, tool surface, interrupt, history, terminal classification, route drift, and native usage provenance at the nearest stable native boundary.
- Split continuity evidence into three independent rows: `exact_session_continuation` for `exact_resume` (a fresh process keeps the stable native session while accepting a distinct new continuation turn); `cross_process_turn_observation_or_reconciliation` for `terminal_observable` (a no-prompt fresh observer/reconciliation binds the already accepted old turn by persistent provider-native identity or one authoritative history delta); and `automatic_recovery_exact_session_transport` for `automaticRecovery=exact_session_transport` (a bounded reconnect of an interrupted accepted turn without duplicate input/replay, bound to the same logical/native accepted turn or provider-defined recovery binding). In-memory IDs, array positions, replay counters, guessed history matches, and synthetic PID/request/job/index identities are rejected.
- Keep deterministic fake-native comparisons in `npm run check`. Any live witness is separately authorized, runs at most one minimal low-effort turn per Harness after zero-model gates, stops on auth/quota/route mismatch, never retries automatically, and records a sanitized native-source receipt.
- Treat plugin/MCP/skill/tool parity as configuration inheritance evidence, not an enumerable model-facing inventory or spawn selector.
- Depend on the explicit-effort and provenance-v3 base for implementation. Final parity/release acceptance still depends on universal exact-route evidence and successful Claude discovery; a `hold` blocks that promotion but not deterministic tests which correctly record the expected external prerequisite.

## Capabilities

### New Capabilities

- `native-harness-differential-parity`: define the direct-versus-HarnessDock evidence matrix, cross-restart identity gate, and bounded live-witness rules.

### Modified Capabilities

- `harness-driver-runtime`: require each admitted Driver to supply the native seams and source provenance needed by its differential rows.
- `plugin-release-readiness`: make differential fixtures and capability-qualified live receipts release evidence rather than self-referential parity assertions.
- `workspace-turn-authority`: prove that `write` changes only prompt/receipt authority and not argv, env, native configuration, tools, MCP, or sandbox inputs.

## Impact

Expected surfaces are new differential fixtures/tests and sanitised history/recovery receipts, plus narrow test seams in each Driver and release smoke. Pi's current `terminal_observable` claim is a deterministic fail-closed counterexample until it has an unambiguous authoritative one-turn observer; this does not pre-decide Pi's session-continuation or automatic-recovery result. No generic event API, transcript duplication, benchmark, model-quality ranking, cost inference, plugin/MCP inventory, production config mutation, automatic retry beyond a provider-declared bounded transport recovery, install, release, archive, or paid call is included.
