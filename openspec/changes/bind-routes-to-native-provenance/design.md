## Context

See `proposal.md` and its four delta specs. `runtime/harness-capabilities.mjs` already records per-dimension maturity, while `inspectInstances()` supplies fresh route values. Neither says whether a value is checkout-declared, proven by the inspection, or negotiated by the exact session. External `agent-orchestrator` separates static support, live probe, and conversation capabilities in `/data/CoordExp/external/agent-orchestrator/backend/internal/ports/chat.go`; its whole-replacement option update in `backend/internal/adapters/chatdriver/acp/config_options.go` is useful as an invariant, not as permission for mid-session route mutation.

## Goals / Non-Goals

**Goals:**

- Add provenance to the existing capability snapshot rather than create a new control plane.
- Show that a native executable/configuration generation was observed without exposing implementation identities or treating a digest as route selection.
- Preserve whole-catalog freshness and immutable Agent route meaning across benign local configuration changes.

**Non-Goals:**

- No configuration inventory, raw file-content hashing, secret hashing, route cache, provider store, mid-Agent model/effort mutation, public provenance selector, or generic negotiation protocol.
- No automatic block merely because an opaque generation changed while the exact route and required capabilities remain admitted.
- No eager rewrite of older durable Agent records.

## Decisions

### 0. Generic evidence can start from explicit effort; stronger facts remain gated

The accepted shared foundation that every canonical route carries an explicit effort is the prerequisite for generic schema-v3 validation and whole-replacement work. It permits that implementation now; it does not stand in for universal exact-route enforcement. Final exact-route/provenance stack acceptance remains gated on `enforce-exact-discovered-routes`.

Claude Code 2.1.250 cannot currently zero-prompt validate an exact selectable model-plus-effort catalog. Therefore `discover-claude-native-routes` remains `HOLD` for Claude dynamic/native facts. Until successful discovery supplies matching native or exact-session evidence, Claude may emit only checkout-owned capability/projection facts as `checkout_declared` and explicit unavailable safe configuration-generation evidence. It must not emit `inspection_proven` or `session_negotiated`, infer a catalog, or receive a legacy exception service.

### 1. Extend the capability schema, not the architecture

Capability schema v3 adds a `provenance` object keyed exactly like `values` and `maturity`, with closed values `checkout_declared`, `inspection_proven`, and `session_negotiated`. Validation snapshots all three objects once and requires exact key equality. The Driver contract states which native receipt proves every `inspection_proven` or `session_negotiated` value.

Schema-v2 durable Agents stay readable. Before a new operation they must obtain a complete current v3 snapshot; the runtime records it on the new attempt rather than fabricating provenance for the historical turn or eagerly rewriting the Agent.

Alternative rejected: add a separate static/live/session capability service. It duplicates the route snapshot and would let two owners disagree.

### 2. Inspection generation is an evidence token, not config identity

Each inspection carries one bounded opaque generation computed from the validated complete projection, exact Driver/executable identity evidence, and only a native-reported configuration token/digest the Driver already consumes. If the native protocol has no safe configuration witness, the configuration component is explicitly unavailable. Arbitrary settings, plugin manifests, MCP files, credentials, endpoints, and paths are never read merely to make the token.

The public projection exposes only the opaque token and availability/provenance class. Operator diagnostics may show an already-allowlisted configured executable candidate, but never the raw generation material.

Alternative rejected: hash the entire native config directory. It captures secrets and irrelevant churn, still cannot prove which files the Harness loaded, and turns HarnessDock into a second configuration parser.

### 3. Refresh replaces the full projection

The registry treats one validated inspection result as indivisible. It never merges a route or capability field from the previous result. The shared runtime keeps no discovery cache; whole replacement is a contract and test invariant for any future cache/UI consumer, not a new store.

Alternative rejected: patch only the selected model's effort row after a native response. A model switch can change other effort/capability options, leaving a mixed-generation catalog.

### 4. Generation drift triggers revalidation, not automatic rejection

An Agent's Harness/model/effort/topology/authority remains immutable. Every operation already revalidates current availability. If the generation changes but the exact tuple and required capabilities remain valid, the attempt proceeds with a receipt naming the new observation, matching what a new direct Harness invocation would load. If the tuple disappears, a required capability narrows, or a session-negotiated fact cannot be re-proven, the operation fails before native submission.

Alternative rejected: make the generation part of immutable route identity. Normal user edits to plugins/MCP/settings would strand otherwise valid Agents and violate local native parity.

### 5. Persistence stays attempt-qualified

The accepted snapshot/generation is stored with the launch/attempt evidence already owned by durable v3 state and Agent cards. It does not create a configuration-history database or alter completion/lease ownership. Unknown native acceptance retains the exact attempt evidence and leases as before.

## Risks / Trade-offs

- [A generation token changes on harmless executable metadata] → Treat it as a revalidation cue and receipt fact, not automatic failure.
- [A Driver labels native evidence too strongly] → Require per-dimension fixtures and reject provenance/value combinations without a matching native receipt.
- [Capability schema v2 records outlive the upgrade] → Read them without rewrite; require fresh v3 evidence only when a new operation is attempted.
- [Opaque public tokens become accidental selectors] → Reject them in all model-facing input schemas and test `assertNoHarnessImplementationSelector` against them.

## Migration Plan

1. Confirm the accepted explicit-canonical-effort foundation; add schema-v3 validation with fake snapshots and read-forward v2 fixtures.
2. Add generic whole-replacement plus Pi/OpenCode safe generation/provenance producers without changing admission decisions. For Claude under `HOLD`, cover only `checkout_declared` plus unavailable safe configuration-generation evidence; verify no dynamic/native provenance claim.
3. Bind v3 evidence to new attempts and make capability-dependent operations require current provenance; preserve route identity and old durable records. Integrate universal exact-route revalidation only after `enforce-exact-discovered-routes` is accepted, and Claude dynamic/native facts only after successful `discover-claude-native-routes` discovery.
4. Update listing, cards, doctor, and MCP redaction/projection tests; run focused migration/coherence suites and `npm run check`.
5. Do not install or release the intermediate checkpoint. Rollback reads unchanged old state and ignores new optional attempt evidence through the normal versioned reader.
