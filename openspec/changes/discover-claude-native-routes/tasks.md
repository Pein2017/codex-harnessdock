## 1. Freeze zero-prompt native evidence

- [x] 1.1 A prior disposable stream-json control probe at the Claude process seam captured a sanitized native initialization/`list_models`-class receipt proving no user prompt, accepted turn, continuation, or model request. The explicitly reset live receipt is `docs/history/2026-08-30-claude-native-route-probe-reset.json`.
- [x] 1.2 The raw-control receipt lacked a complete exact full-model and per-model-effort projection, so that raw protocol route entered `HOLD`; it did not parse help/TUI text, scrape config, or substitute a static fallback. This package supersedes only that raw-control hold with the approved documented Agent SDK contract; it does not retry or retain the private protocol path.
- [x] 1.3 Replace the failed raw control fixture with deterministic Agent SDK fakes in `tests/runtime/claude-agent-sdk-inspector.test.mjs` and Driver tests for malformed/ambiguous rows, default and alias projection, missing effort, no-prompt enforcement, timeout/error, and `close()` cleanup.

## 2. Replace Claude catalog admission atomically

- [x] 2.1 Add the bounded Agent SDK inspection owner behind `runtime/claude-code-driver.mjs`, dynamically importing the pinned SDK and binding its documented `pathToClaudeCodeExecutable` to the compatibility-resolved executable without changing ordinary turn configuration or topology owners.
- [x] 2.2 Project only complete exact resolved rows into the shared `models`/`effortsByModel` inspection shape; reject default, unresolved, duplicate-resolved, and effortless rows. Inspection failure produces a redacted unavailable Claude instance with no cache or prior-table merge.
- [x] 2.3 Remove alias/default resolution from new V2 Claude route admission. The V2 launch path receives only its persisted exact model and immutable explicit effort; preserve legacy adapter compatibility and readable records.
- [x] 2.4 Route list/spawn through the existing fresh V2 inspection and repeat the SDK exact-tuple check immediately before prompt submission. A disappeared or narrowed tuple fails before submission; accepted model/effort identity remains immutable.

## 3. Preserve Claude ownership and diagnostics

- [x] 3.1 Keep terminal-parity behavior, prompt-only `write`, native-orchestrator eligibility, settings/plugin/MCP/skill ownership, and session/recovery transport unchanged. The profile now requires its explicit admitted model and effort rather than resolving aliases/defaults.
- [x] 3.2 Reuse the existing redacted instance `detailCode` projection: executable/auth host failures retain their closed codes; SDK catalog failure maps to existing closed `protocol_error`; exact drift fails before prompt submission. No raw SDK/config/account data is projected.
- [x] 3.3 Existing MCP, guidance, and release-smoke projection tests pass with the fresh Driver route shape; listing remains model-specific and guidance remains inventory-neutral.

## 4. Deterministic acceptance and optional witness boundary

- [x] 4.1 Sensitivity-check SDK alias/default projection, duplicate resolved IDs, missing effort, initialization timeout/error, and close cleanup. The Driver revalidation path refuses a missing tuple before prompt submission.
- [x] 4.2 Run `npm run test:focus -- tests/runtime/claude-agent-sdk-inspector.test.mjs tests/runtime/claude-driver-v2.test.mjs tests/runtime/harness-claude-parity.test.mjs tests/runtime/harness-driver-contract.test.mjs tests/runtime/mcp-server.test.mjs tests/runtime/operator-diagnostics.test.mjs tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs tests/runtime/plugin-contract.test.mjs tests/runtime/release-smoke.test.mjs`, then `openspec validate discover-claude-native-routes --strict`.
- [ ] 4.3 Run `npm run check`. The package-specific focus suite passes, but the full suite currently fails in sibling static-Claude fixtures that require their owners to reconcile with dynamic discovery.
- [x] 4.4 No live probe or model turn is authorized for this package. Deterministic SDK fakes are the complete acceptance evidence; auth, quota, route, or protocol failures remain unavailable without retry or fallback.
