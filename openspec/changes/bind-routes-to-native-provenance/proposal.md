## Why

Fresh discovery currently reports a route value but not how each capability was established or which native executable/configuration generation produced the observation. A caller cannot distinguish checkout-declared support from live or session-negotiated evidence, and diagnostics cannot show whether a local Harness change was actually observed.

## What Changes

- Add closed per-capability provenance to Driver inspection: `checkout_declared`, `inspection_proven`, or `session_negotiated`; maturity and provenance remain separate facts.
- Require a fresh inspection to replace its complete route projection atomically. Never merge a stale model, effort, or capability field into a newer projection.
- Add a secret-safe opaque inspection generation derived only from exact executable identity and native-reported configuration evidence that the Driver actually consumes. When a Harness cannot report configuration evidence safely, state `unavailable` rather than reading arbitrary config contents or inventing a digest.
- Revalidate persisted exact routes against the new complete projection. A disappeared tuple or narrowed required capability fails closed; a benign configuration-generation change may be observed and receipted without mutating the immutable model/effort route or blocking parity with the next direct native invocation.
- Expose only bounded provenance/generation facts, never plugin, MCP, skill, tool, prompt-template, endpoint, credential, config-path, or config-content identities. These facts are evidence and cannot be supplied as spawn selectors.
- Begin generic schema-v3 and whole-replacement implementation after the accepted shared explicit-canonical-effort foundation (every canonical route carries an explicit effort); this is a behavior prerequisite, not a commit-identity dependency.
- Final exact-route/provenance stack acceptance still depends on `enforce-exact-discovered-routes`. Claude-specific dynamic/native provenance additionally depends on successful `discover-claude-native-routes` discovery: while that change is `HOLD`, Claude may publish only truthful checkout-owned capability/projection facts as `checkout_declared` with safe configuration-generation evidence `unavailable`, never `inspection_proven` or `session_negotiated` route facts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-driver-runtime`: bind complete route/capability projections to closed provenance and a secret-safe native inspection generation.
- `durable-runtime-state`: retain bounded accepted and revalidated provenance evidence without turning configuration generation into mutable route identity.
- `typed-mcp-orchestration`: report bounded provenance while keeping native implementation identities and selectors private.
- `runtime-operations-diagnostics`: explain executable/config-generation drift and unavailable provenance using operator-safe evidence.

## Impact

Expected surfaces are the Driver capability schema, instance inspection validation, Pi/OpenCode/Claude inspection producers, durable route evidence, Agent cards, MCP projection, doctor, and focused drift/coherence tests. No configuration inventory, arbitrary file hashing, cache, provider registry, remote instance, process-permission mapping, public repair operation, installation, release, or archive is included.
