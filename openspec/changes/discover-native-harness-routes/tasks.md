## 1. Contract and runtime seam

- [x] 1.1 Add focused failing contract/runtime tests for fresh bounded `inspectInstances().routes`, exact model/topology/authority/effort equality, required explicit Pi/OpenCode effort, pre-transport drift, and fail-closed operations on a disappeared persisted Pi/OpenCode route; prove each test fails against the current fixed/stale behavior.
- [x] 1.2 Extend the existing Driver contract, registry, Agent route/receipt validation, and v3 lifecycle path to admit checkout-static `claude-code`/`pi`/`opencode` Drivers with dynamic bounded native route facts and no persistent inventory cache or provider registry.
- [x] 1.3 Make list and spawn independently inspect fresh state, immediately revalidate the exact tuple before transport, preserve caller-stated effort in immutable route lineage, and reject aliases, fallbacks, omitted or ambiguous caller fields, or silently changed existing routes.
- [x] 1.4 Run the focused contract/runtime suite; sensitivity-check that restoring a cached/list-time snapshot or replacing exact equality with a nearby native route makes the new drift/disappearance tests fail.

## 2. Pi native route and parity

- [x] 2.1 Add fake-RPC RED tests for `PI_CODING_AGENT_DIR`-rooted discovery using `get_available_models`, exact `set_model`, `get_available_thinking_levels`, `get_state`, and bounded/redacted `get_commands` parity order (extensions, prompt templates, skills); require exact caller-supplied model and effort, and assert no discovered native default is stored or used, no human CLI catalog scrape, `prompt`, provider inference, MCP/tool inventory, or execution claim reaches a receipt.
- [x] 2.2 Replace Pi fixed model/effort constants and CLI catalog probing with the bounded native-RPC discovery projection, require exact caller-supplied model and effort without storing or using discovered defaults, and restore local extensions, skills, prompt templates, and native tools without copying or exposing their configuration.
- [x] 2.3 Remove Pi `write`-dependent native tool/argv/process-permission behavior; retain only immutable prompt and receipt authority, and preserve native delegation as unmanaged/prompt-constrained under the top-level `leaf` boundary.
- [x] 2.4 Use fake-RPC parity fixtures to keep `--offline` plus `--no-session` only on zero-refresh discovery/control RPC, while ordinary turns, resumes, history, and observation retain online native configuration without `--offline`, `--no-approve`, disabling flags, or a fixed tool list. Sensitivity-check that removing control `--offline` records a catalog refresh and that adding a rejected turn flag breaks direct native parity.
- [x] 2.5 Run the focused Pi Driver/RPC/public-generation suite with fake transport only and verify every fixture rejects a model prompt and any missing or defaulted effort path.

## 3. OpenCode native route and attach-only revalidation

- [x] 3.1 Add fixed-origin fake-Server RED tests for `/provider` catalog and exact variants, selector omission, required explicit effort, no hardcoded `codex-explorer`/`build`/model fallback, no configuration exposure, and no provider/model call during discovery.
- [x] 3.2 Extend the existing GET-only fixed-origin client and OpenCode Driver to project only bounded `/provider` catalog/variant facts, omit the agent selector so the Server retains its local native agent/configuration, and validate list, spawn, and pre-transport exact tuples against fresh state while retaining attach-only Server ownership and secret redaction.
- [x] 3.3 Remove the HarnessDock-managed OpenCode profile/tool allowlist path; inherit native local plugin/MCP/tool/skill/prompt configuration without copying or enumerating it, while failing closed on unavailable route or interactive interaction facts.
- [x] 3.4 Keep `write` prompt/receipt-only for OpenCode and test that both authorities pass identical native configuration, argv, plugins, MCP, tools, and sandbox inputs; test that `leaf` does not claim control over native delegation.
- [x] 3.5 Run the focused OpenCode client/profile/Driver/public-generation suite; sensitivity-check that fixed route/profile/agent constants, variant inference, an agent selector, stale discovery, or a write-dependent native selector makes the new tests fail.
- [x] 3.6 Update the existing main `openspec/specs/opencode-explorer-runtime/spec.md` Purpose during apply so it describes attach-only dynamic native OpenCode routes rather than one DeepSeek read-only Explorer; keep the historical capability directory name and do not add a delta Purpose.

## 4. Public contract, diagnostics, and release surface

- [x] 4.1 Replace fixed MCP model/effort enums with bounded dynamic string parsing plus fresh Driver validation; require spawn `model` and `reasoning_effort`, preserve explicit Harness/topology/write requirements, make follow-up inherit its frozen route including effort, reject configuration selectors, and return redacted route lineage.
- [x] 4.2 Bump `HARNESSDOCK_MCP_API_GENERATION` and `package.json` minor version once, regenerate the manifest-derived cachebuster, and update the eight Skill descriptions and the separate eight-tool MCP surface so old MCP workers fail restart-required while a newly loaded MCP observes later local native configuration changes without reload.
- [x] 4.3 Extend doctor and zero-model release-smoke fake tests for fresh redacted native discovery, exact model-specific effort/variant choices, unavailable/ambiguous/drift reporting, current schema/plugin parity, no configuration exposure, and no Pi/OpenCode/provider model request; do not install, refresh, or start a Server.
- [x] 4.4 Run focused MCP, operator-diagnostics, plugin-contract/version, and release-smoke suites. Verify the public descriptions do not promise native plugin/MCP/tool enumeration or filesystem containment.

## 5. Integrated verification and acceptance

- [x] 5.1 Run the declared RED/sensitivity checks from 1.4, 2.4, and 3.5 against the focused tests, then restore the candidate implementation and rerun them green; retain only sanitized no-inference test receipts.
- [x] 5.2 Run `npm run test:focus -- tests/runtime/pi-driver.test.mjs tests/runtime/pi-public-generation.test.mjs tests/runtime/opencode-client.test.mjs tests/runtime/opencode-driver.test.mjs tests/runtime/opencode-public-generation.test.mjs tests/runtime/mcp-server.test.mjs tests/runtime/operator-diagnostics.test.mjs tests/runtime/release-smoke.test.mjs` and `npm run check` with no live Pi/OpenCode/Claude/provider model call.
- [ ] 5.3 Run `npm run doctor`, `npm run smoke:release` only in their existing zero-model/read-only modes, and `openspec validate discover-native-harness-routes --strict`; record unavailable external Harnesses as bounded diagnostics rather than repair them.
- [x] 5.4 Inspect the final diff and receipts for exact-route/no-cache behavior, one 0.22/generation-7/cachebuster bump, prompt-only write semantics, attach-only OpenCode ownership, restored Pi native configuration, and no provider registry, install/release/archive, benchmark, or model-quality scope beyond the authorized minimal Claude explicit-effort freeze.
- [ ] 5.5 After 5.1–5.4 pass, run exactly one real Pi and one real OpenCode smoke using `gpt-5.6-luna` with low effort/variant and one minimal bounded prompt each. Stop each smoke on auth, quota, or route mismatch; do not retry, benchmark, or broaden evaluation. Preserve only sanitized receipts. Discovery, list, doctor, and every earlier gate remain zero-model-cost.
