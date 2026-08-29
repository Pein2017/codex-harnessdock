## Context

See `proposal.md` and its five delta specs. The installed Claude Code 2.1.250 help exposes model/effort selection but no documented `models` subcommand. The executable contains a native `list_models` control subtype, and `/data/CoordExp/external/codex-host/packages/adapters/claude-code/src/sdk-transport.ts` proves that a zero-prompt Agent SDK initialization can return `initializationResult().models`. That precedent establishes a native seam, not a contract to copy its default-model or all-model thinking assumptions.

## Goals / Non-Goals

**Goals:**

- Discover the authenticated local Claude model/effort routes without a model turn and without a checkout-owned catalog.
- Remove aliases and default effort atomically with successful native discovery.
- Reuse existing Claude process, configuration, compatibility, topology, and recovery owners.

**Non-Goals:**

- No Anthropic Models API client, API-key requirement, settings scraping, Agent SDK runtime dependency, human TUI parsing, static version table, default route, or fallback model.
- No model-quality ordering, provider/account details, plugin/MCP inventory, permission-mode change, or Claude lifecycle redesign.
- No partial rollout that disables a currently usable Claude route merely because the research probe is incomplete.

## Decisions

### 1. First freeze a zero-prompt native control receipt

Implementation begins with a disposable process-shaped probe against the exact configured executable using the existing stream-json transport family. It may send only initialization and `list_models`-class control messages, bounds stdout/stderr/time/process group, and must prove that no user message, accepted turn, session continuation, or model request occurred. The sanitized response becomes the fake fixture before production code changes.

If the installed protocol cannot return complete exact selectable model values and per-model effort evidence, the change enters `HOLD`: keep the shipped Claude catalog behavior unchanged, record the negative receipt, and do not remove aliases/defaults or merge an always-unavailable Driver.

Alternative rejected: infer routes from `claude --help`. Help proves accepted flag syntax, not account/model entitlement or per-model effort availability.

### 2. Native values must be exact, complete, and non-default

Each retained row needs a stable full native model value plus a non-empty exact effort set. Rows representing `default`, family aliases, unresolved display labels, automatic/fallback choices, or values without exact resolution are discarded; if no complete row remains, inspection is unavailable. The projection is whole-replacement and never cached.

Alternative rejected: expose the Agent SDK's `default` row or encode native aliases as opaque refs. HarnessDock's public contract requires an explicit full model and forbids defaulting/alias routing.

### 3. Discovery uses ordinary Claude ownership without adding turn policy

The probe inherits the same allowlisted environment and `CLAUDE_CONFIG_DIR` as a normal direct invocation. It does not add `--bare`, `--safe-mode`, `--restricted`, settings sources, tools, plugins, MCP configuration, system prompts, permission modes, fallback models, or native Agent definitions. Process cleanup reuses the existing verified process-group identity rules.

The ordinary turn still passes through `runtime/execution-profile.mjs`; terminal-parity additions and the leaf/native-orchestrator envelope remain unchanged and are compared separately by the differential change.

Alternative rejected: reuse the external inspector's `settingSources: ["user"]`, `tools: []`, or SDK dependency. Those are codex-host product choices and would not prove parity with this user's direct Claude invocation.

### 4. Discovery and admission are two fresh observations

`list_harnesses` runs bounded inspection without a turn. Spawn obtains another fresh inspection, validates exact equality, persists the complete route, and the Claude Driver repeats the equality gate immediately before prompt submission. Topology stays checkout-declared policy: only exact discovered Opus/Fable IDs may admit the current native-orchestrator path.

Alternative rejected: keep a process-wide model cache or use the list-time snapshot for spawn. Either makes a local account/config change invisible until reload.

### 5. Alias/default removal is one atomic compatibility cut

The source checkpoint removes `MODEL_ALIASES`, `EFFORT_ALIASES`, `DEFAULT_EFFORT_BY_MODEL`, and default-effort resolution from new-route admission only after fake discovery proves a usable exact catalog. Existing durable Agents with full model+effort continue through fresh equality validation. Legacy records lacking effort remain readable but cannot activate; historical model migration does not manufacture a new route.

## Risks / Trade-offs

- [The CLI exposes models but not exact resolved IDs or per-model efforts] → Stop at `HOLD`; do not parse UI text or ship a static fallback.
- [Initialization performs nonessential network traffic] → Capture the exact control transcript, require no model request, bound time/bytes, and classify auth/network failure as unavailable without retry.
- [Native catalog values change across Claude versions] → Validate a strict bounded shape, include CLI compatibility evidence, and fail closed on unknown fields needed for admission.
- [Removing aliases breaks callers] → The current public spawn contract already requires full model+effort; update inventory-neutral guidance and return an actionable exact-list hint.

## Migration Plan

1. Accept `enforce-exact-discovered-routes` and freeze a fake plus one separately authorized zero-prompt native control receipt. Stop at `HOLD` if it lacks exact full model and per-model effort evidence.
2. Add a bounded Claude inspection owner behind the Driver; demonstrate no-prompt/process cleanup and catalog replacement sensitivity.
3. Switch list/spawn/pre-transport validation and remove new-route alias/default resolution in one checkpoint; keep terminal transport untouched.
4. Run Claude contract, compatibility, migration, history, authority, MCP, doctor, release, and full `npm run check` gates. A paid Haiku-low turn remains separately authorized and non-retrying.
5. Do not install or release this intermediate checkpoint. Rollback restores the prior Driver and leaves durable Agents unchanged because no eager migration occurs.
