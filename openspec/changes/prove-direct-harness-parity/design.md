## Context

See `proposal.md`, the new differential capability, and the three modified specs. Current `tests/runtime/harness-claude-parity.test.mjs` and Driver tests are valuable regression checks but derive expected behavior from this checkout. `/data/CoordExp/external/codex-host/tests/differential/codex-transparent-proxy.mjs` demonstrates an independent direct-versus-proxy pattern, while `/data/CoordExp/external/codex-host/docs/acp-layer-follow-up.md` supplies the cross-restart native-turn identity gate. These are evidence patterns only; HarnessDock keeps its existing native Drivers and public lifecycle.

## Goals / Non-Goals

**Goals:**

- Make direct native behavior the oracle for every parity claim that can change route safety, configuration inheritance, lifecycle, history, or usage interpretation.
- Keep deterministic coverage zero-model and use capability-qualified `not_applicable` instead of false common-denominator parity.
- Produce one sanitized, source-bound acceptance receipt for each released Driver generation.
- Remove the implementation-order deadlock without treating unavailable external discovery as parity.

**Non-Goals:**

- No model-quality/cost benchmark, generic event API, transcript database, ACP layer, scheduler, automatic reviewer, plugin/MCP inventory, production config mutation, or paid retry loop.
- No claim that Pi, OpenCode, and Claude expose identical native semantics.
- No requirement to run live model turns when deterministic evidence is complete and live calls were not authorized.

## Decisions

### 1. Freeze one matrix schema and three native oracles

The change owns a machine-readable matrix fixture plus a rendered acceptance receipt. Every row records Harness, Driver/capability schema version, dimension, direct source, HarnessDock source, deterministic/live/not-applicable mode, comparator, result, and sanitized artifact digest.

`result` is closed: `pass` means the applicable row's independent comparison succeeded; `fail` means a regression counterexample; `hold` means an external prerequisite remains unavailable; and `not_applicable` means the accepted capability snapshot makes the operation unavailable. A deterministic test passes when it correctly detects and records its expected `hold`; final parity/release acceptance passes only when every required row is `pass` or justified `not_applicable`. Thus `hold` neither becomes parity nor makes zero-model regression tests red merely because their external prerequisite is unavailable.

The accepted explicit-effort plus provenance-v3 base permits implementation of generic matrix infrastructure and supported Pi/OpenCode rows now. Claude Code 2.1.250 exact dynamic model/effort discovery is an evidence-backed `hold`: its exact-route inventory cell records a sanitized negative-control receipt and has no static catalog/config/authority/transport fallback. Deterministic Claude rows for which native evidence exists may proceed, but no final stack acceptance occurs until this exact discovery succeeds alongside universal exact-route evidence.

- **Claude:** direct exact CLI/control invocation under the same allowlisted environment and `CLAUDE_CONFIG_DIR`; compare captured argv/env/config witness, control/model catalog, stream events, history, usage, and process outcome with the Driver path.
- **Pi:** direct native RPC under the same `PI_CODING_AGENT_DIR`; compare commands, catalog/thinking levels, turn RPC/event/history/usage, and cleanup with `pi-driver`.
- **OpenCode:** direct pinned Server SDK/HTTP boundary for session/turn semantics plus a native CLI/server configuration witness for ordinary local config. Do not parse `opencode run` or TUI output as a HarnessDock result.

Alternative rejected: one universal fake Harness. It can test the supervisor but cannot establish Driver-native parity.

### 2. Compare semantics at the nearest stable native boundary

The deterministic matrix is:

| Dimension | Claude | Pi | OpenCode |
| --- | --- | --- | --- |
| exact models and efforts | fixture + optional live inspection | fixture + optional live inspection | fixture + optional live inspection |
| argv and environment | fixture | fixture | server launch/config fixture |
| native configuration inheritance | fixture + optional benign live witness | fixture + optional benign live witness | fixture + optional benign live witness |
| prompt delta and authority | fixture | fixture | fixture |
| event/tool ordering | fixture | fixture | fixture |
| interrupt | fixture | fixture | capability `not_applicable` until supported |
| `exact_session_continuation` | fixture + optional live | fixture + optional live | capability `not_applicable` until supported |
| `cross_process_turn_observation_or_reconciliation` | fixture + optional live | fixture + required fail-closed correction for its current `terminal_observable` claim | capability `not_applicable` until supported |
| `automatic_recovery_exact_session_transport` | fixture + optional live when `automaticRecovery=exact_session_transport` is claimed; otherwise capability `not_applicable` | fixture + optional live when claimed; otherwise capability `not_applicable` | fixture + optional live when claimed; otherwise capability `not_applicable` |
| native usage provenance | fixture + optional live | fixture + optional live | fixture + optional live |
| terminal/lifecycle and route drift | fixture | fixture | fixture |

Comparators use exact equality for route/config inputs and IDs, ordered equality for events, closed semantic mapping for native terminal outcomes, and source-field correspondence for usage. Unknown/missing fields remain unknown; no price or token-savings inference is allowed.

### 3. Configuration parity uses benign witnesses, not enumeration

Fixtures run direct and Driver paths against the same disposable configuration root containing bounded sentinel instructions/extensions or fake endpoints, then compare the native-reported loaded witness or observed benign capability. Production live checks reuse the user's ordinary config but emit only equality/digest/count outcomes. They never list plugin, MCP, skill, tool, template, endpoint, path, or credential identities model-facing.

Alternative rejected: expose configuration names so Codex can compare them. That reverses accepted selector/redaction contracts and makes native implementation details part of routing policy.

### 4. Session continuation, old-turn observation, and transport recovery are separate hard gates

`exact_session_continuation` is the sole row for `exact_resume`: it captures stable `nativeSessionRef` `S` and an accepted old native turn `T1`, destroys the Driver/process, constructs a fresh Driver in another process, passes only `S` plus new continuation input, and requires the accepted result to remain in `S` as a distinct new turn `T2` (`T2 != T1`). It does not pass `T1` as the continuation target and does not require `turnObservation`; Claude's current `turnObservation=unavailable` therefore does not downgrade its `exact_resume` session-continuation claim.

`cross_process_turn_observation_or_reconciliation` is the sole row for `terminal_observable`: it starts a fresh no-prompt observer/reconciliation for the already accepted `T1` and must bind that old turn through the same persistent provider-native turn identity or exactly one authoritative pre/post history delta. No PID, request, job, array-index, replay-counter, scope-local, or synthetic identity qualifies. Any ambiguity downgrades/refuses only `terminal_observable` rather than a separate session-continuation or transport-recovery claim.

`automatic_recovery_exact_session_transport` is the sole row for `automaticRecovery=exact_session_transport`. Starting from an accepted interrupted turn, it exercises the provider's declared bounded reconnect semantics without a duplicate prompt, duplicate input, or replay of accepted input, then requires the same logical/native accepted turn or an authoritative provider-defined recovery binding. A new-input continuation is not recovery evidence. Routes that do not claim this automatic recovery record a capability-derived `not_applicable` cell.

Pi's current observer, which uses HarnessDock `scope.turnId` and the latest post-baseline result, is a deterministic counterexample: its `terminal_observable` claim must fail close or be downgraded until production code provides an unambiguous authoritative one-turn observation. This correction does not decide Pi's `exact_session_continuation` or `automatic_recovery_exact_session_transport` outcome.

Alternative rejected: requiring `T1 == T2` for a normal follow-up, treating a new-input continuation as transport recovery, envelope-shape validation, or same-process replay. A continuation legitimately creates `T2`; the latter two can pass while no-prompt observation or interrupted-turn recovery binds the wrong turn.

### 5. Live witnesses are last, bounded, and non-retrying

After all deterministic rows pass, separate authorization may run one minimal low-effort turn per Harness: Claude Haiku-low, Pi Luna-low, and OpenCode Luna-low when those exact routes are freshly advertised. Each stops on auth/quota/route/protocol failure, uses no automatic fallback/retry, and records provider-native usage fields separately. A failed live witness blocks only the claim it was intended to establish; it does not invalidate deterministic plumbing evidence or trigger broader paid probing.

### 6. This is a test/acceptance layer, not a runtime plane

Driver-local capture seams remain test-only or bounded existing receipts. `runtime/index.mjs` keeps exactly eight methods. No generic event/session/interaction abstraction is added merely to make the matrix uniform.

## Risks / Trade-offs

- [A direct oracle accidentally reuses Driver code] → Record source module ownership and reject rows whose two sides share the value-producing helper or constant.
- [Live configuration witnesses alter user state] → Use disposable roots for mutations; production config checks are read-only and sanitized.
- [A capability is unsupported] → Record explicit capability-derived `not_applicable`; do not fake parity or block unrelated route dimensions.
- [The matrix becomes an open-ended integration suite] → Freeze the decision-bearing rows above; later Driver capabilities add their own row by OpenSpec rather than expanding this change opportunistically.

## Migration Plan

1. Start on the accepted explicit-effort plus provenance-v3 base. Record the Claude Code 2.1.250 exact dynamic model/effort inventory as `hold` with its sanitized negative-control receipt; do not substitute static discovery.
2. Add the matrix schema, three independent fake-native fixture families, and sensitivity mutations; no live Harness call. Implement supported Pi/OpenCode rows and Claude non-catalog/config/authority/transport rows wherever deterministic native evidence exists.
3. Add fresh-process `exact_session_continuation` tests, separate no-prompt old-turn observation/reconciliation tests, and bounded no-duplicate-input automatic-recovery tests only for routes claiming `automaticRecovery=exact_session_transport`, plus explicit OpenCode capability-derived `not_applicable` evidence.
4. Run focused matrices, process-leak checks, `npm run check`, strict OpenSpec validation, and one bounded final review of blocking parity counterexamples.
5. If separately authorized, run at most one live low-effort witness per Harness and freeze sanitized receipts. A required `hold` still blocks final parity/release acceptance. Once every required row is `pass` or justified `not_applicable`, perform the stack's single version/changelog/manifest refresh and local install/release verification under separate release authorization.
6. Rollback removes test seams/receipts and restores the prior source checkpoint; native config and durable Agent state are never mutated by this change.
