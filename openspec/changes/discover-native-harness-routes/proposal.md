## Why

HarnessDock currently carries fixed Pi and OpenCode route constants, so its public listing can drift from the native Harness configuration that actually owns models, effort levels, local plugins, MCP tools, and prompt templates. The next public generation needs to expose only the fresh native routes that Pi and an already-running OpenCode Server resolve locally, then validate the exact requested tuple again before transport.

## What Changes

- Replace fixed Pi and OpenCode model/effort allowlists with bounded, zero-inference native discovery at list and spawn time; preserve a static checkout-owned Driver registry and fail closed on an unavailable, ambiguous, or changed route.
- Admit Pi routes from its local `PI_CODING_AGENT_DIR` configuration and RPC discovery, restoring native extensions, skills, prompt templates, and tools. Determine and enforce only the parity-safe RPC launch flags; `write` remains a prompt and receipt authority, never a tool, argv, plugin, MCP, or sandbox selector.
- Admit OpenCode routes from the connected Server's resolved provider catalog and variants. Keep the fixed-origin safety boundary and attach-only Server ownership; always omit an agent selector so the Server retains its local native agent/configuration, never hardcode `codex-explorer`, another agent name, or a model identifier, and never expose configuration.
- Make model and effort explicit for every HarnessDock spawn; Pi/OpenCode values remain bounded dynamic native inventory facts. Bump the public MCP/schema generation and plugin minor version once. Existing Agent routes remain immutable and fail closed if their route later disappears.
- Extend operator diagnostics, zero-model release checks, and fake-native regression coverage for discovery, exact tuple revalidation, route disappearance, explicit effort, selector omission, prompt-only write behavior, and no-inference operation. After deterministic gates, allow exactly one minimal real Pi and one minimal real OpenCode final smoke using `gpt-5.6-luna` low effort/variant; neither is a benchmark.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-driver-runtime`: replace fixed Pi/OpenCode route facts with fresh native discovery and exact revalidation while retaining checkout-owned Driver modules and immutable Agent lineage.
- `typed-mcp-orchestration`: expose bounded dynamic native model/effort selections and one public-generation transition without making native configuration model-facing.
- `opencode-explorer-runtime`: replace the single fixed Explorer model/profile route with attach-only resolved native catalog/profile discovery and exact variant-backed effort admission.
- `workspace-turn-authority`: define `write` as immutable prompt/receipt authority across native routes without translating it into native execution permissions.
- `runtime-operations-diagnostics`: report bounded, redacted fresh native-route discovery and drift facts without a model call or configuration enumeration.
- `plugin-release-readiness`: update zero-model release acceptance for the one schema/plugin-minor transition and fake-native discovery/revalidation coverage.

## Impact

Expected implementation surfaces are the Driver contract/registry and route validators, Pi RPC process/Driver, OpenCode discovery/profile/Driver client, typed MCP schema and receipts, doctor/release checks, and their zero-model tests. No new HarnessDock provider registry, configuration cache, dependency, benchmark, install, release, or archive is part of this change. Discovery, list, doctor, and deterministic checks make no model call; final acceptance may make only the two separately bounded real smokes described above.
