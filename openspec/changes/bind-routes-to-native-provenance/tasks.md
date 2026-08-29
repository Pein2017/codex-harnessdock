## 1. Freeze capability and generation coherence

- [ ] 1.1 After `enforce-exact-discovered-routes` is accepted on the implementation base (and after Claude discovery for Claude-specific evidence), add RED cases in `tests/runtime/harness-driver-contract.test.mjs` for exact capability-key equality across values, maturity, and provenance; reject foreign, missing, contradictory, or unproven provenance before route use.
- [ ] 1.2 Add fake Pi/OpenCode/Claude inspection cases in `tests/runtime/pi-driver.test.mjs`, `tests/runtime/opencode-driver.test.mjs`, and `tests/runtime/claude-driver-v2.test.mjs` for whole-projection replacement, one disappeared model, unavailable safe configuration evidence, and a changed generation with an otherwise valid exact tuple.

## 2. Bind bounded provenance to existing contracts

- [ ] 2.1 Extend `runtime/harness-capabilities.mjs` and `runtime/harness-contract.mjs` with capability-schema v3: a closed provenance object keyed exactly like the existing capability values/maturity snapshot, plus coherent bounded inspection-generation validation. Do not add a second capability service or mutable route selector.
- [ ] 2.2 Update `runtime/pi-driver.mjs`, `runtime/opencode-driver.mjs`, and `runtime/claude-code-driver.mjs` to publish only evidence they actually obtain: checkout policy as `checkout_declared`, fresh native evidence as `inspection_proven`, and exact-session facts as `session_negotiated`. Compute a bounded opaque generation only from existing executable identity and native-reported configuration evidence; publish unavailable rather than read arbitrary files or invent a digest.
- [ ] 2.3 Make `runtime/harness-registry.mjs`, `runtime/internal-runtime.mjs`, and `runtime/agent-runtime.mjs` accept each validated inspection as a complete indivisible projection, revalidate a persisted exact route/current required capabilities before submission, and preserve immutable Harness/model/effort/topology/authority when only generation changes.

## 3. Persist and project evidence without exposing selectors

- [ ] 3.1 Extend version-three accepted-route/attempt validation and read-forward paths in `runtime/agent-store.mjs`, `runtime/agent-card.mjs`, and their focused tests so a new attempt retains bounded generation/provenance evidence while older schema-v2 records remain readable without eager rewrite or invented historical provenance.
- [ ] 3.2 Project only closed provenance and opaque generation/unavailable facts through `runtime/internal-runtime.mjs`, `runtime/mcp-server.mjs`, Agent cards, and `tests/runtime/mcp-server.test.mjs`; extend `assertNoHarnessImplementationSelector` coverage so callers cannot send provenance, generation, native paths, or capability snapshots.
- [ ] 3.3 Extend `runtime/operator-diagnostics.mjs` and `tests/runtime/operator-diagnostics.test.mjs` with safe unchanged/changed/unavailable generation drift reporting. Permit operator-only reporting of an already-owned configured candidate where the existing contract allows it; keep every raw config, path, endpoint, credential, plugin/MCP/skill/tool/prompt identity, and secret-derived hash out of model-facing output.

## 4. Deterministic acceptance

- [ ] 4.1 Sensitivity-check a stale catalog merge, an overclaimed provenance field, a caller-supplied generation, and a removed required capability. Each must fail before durable mutation or native submission; a benign generation-only change must instead retain the immutable route and record the new observation.
- [ ] 4.2 Run `npm run test:focus -- tests/runtime/harness-driver-contract.test.mjs tests/runtime/pi-driver.test.mjs tests/runtime/opencode-driver.test.mjs tests/runtime/claude-driver-v2.test.mjs tests/runtime/agent-store.test.mjs tests/runtime/mcp-server.test.mjs tests/runtime/operator-diagnostics.test.mjs tests/runtime/plugin-contract.test.mjs` and retain the deterministic receipt.
- [ ] 4.3 Run `npm run check` and `openspec validate bind-routes-to-native-provenance --strict`; do not perform a live model turn, configuration mutation, installation, release, archive, or cache refresh.
