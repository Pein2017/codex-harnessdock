## Context

See `proposal.md` for motivation and the six delta specs for the public contract. The current checkout-owned Driver registry already separates static Driver-module admission from `inspectInstances().routes`, but Pi and OpenCode still project fixed route constants. Pi currently probes a human CLI catalog and launches RPC with extensions, skills, prompt templates, tools, approval, and offline behavior forcibly changed; OpenCode currently pins its catalog/profile route. Neither pattern can represent the locally resolved native configuration that owns these Harnesses.

## Goals / Non-Goals

**Goals:**

- Keep only Driver-module admission checkout-static while taking bounded Pi/OpenCode route facts from fresh native discovery.
- Make list and spawn exact-tuple operations: list reveals no selection; every spawn validates and immediately revalidates the caller's explicit full model and effort tuple before transport, while dynamic native inventory remains Pi/OpenCode-only.
- Preserve native local configuration ownership and retain only prompt/receipt semantics for `write`.
- Make the one schema/plugin-minor transition deterministic and prove all behavior using fake RPC/Server transport without model inference.

**Non-Goals:**

- No Claude native route discovery, native configuration, or lifecycle redesign; no generic provider/model registry, discovered-route cache, raw-config copy, configuration inventory, tool filtering, Server management, new dependency, benchmark, install, release, or archive. Discovery, list, doctor, and deterministic checks remain zero-model-cost.
- No claim that inherited native plugins, MCP, tools, skills, or prompt templates are enumerable or sandboxed by HarnessDock.

## Decisions

### 1. Static modules, dynamic route facts

`harness-registry` continues to hold the literal `claude-code`, `pi`, and `opencode` Driver factories. It does not become a provider registry. The Driver contract's existing `inspectInstances().routes` seam becomes the sole source for a bounded route inventory: full model strings, allowed topology/authority, and exact model-specific effort/variant facts. A new `validateRoute` call consumes a fresh inspection, requires exact field equality, and emits an immutable canonical route containing the caller-stated effort. Spawn repeats the same bounded inspection and equality validation immediately before the Driver sends native input.

An Agent stores that canonical route; it is not a subscription to a future inventory. Later Driver operations first prove the stored tuple is still current. Failure is terminal for that operation, not a request to select a nearby model, effort, profile, or Harness.

Alternative rejected: process-wide discovery cache or a shared provider store. It would make list and spawn disagree after local configuration changes and adds ownership/state recovery without a requirement.

### 2. Pi discovery is native RPC with local configuration restored

Pi inspection starts a bounded native RPC control session with `PI_CODING_AGENT_DIR` as the only configuration-root input. It queries `get_available_models`; for each retained candidate it selects that exact model in the control session and queries `get_available_thinking_levels`, using `get_state` only to verify the selected model/effort capability and never storing or using a discovered default. It uses the native `get_commands` response only as a bounded, redacted parity witness: installed Pi documentation fixes its order as extensions, prompt templates, then skills. HarnessDock exposes no command inventory and does not infer MCP presence or execution capability from this witness. The control session sends no `prompt`, `steer`, `follow_up`, `bash`, or model request and is disposed after inspection.

Turn launch removes the current explicit disabling of extensions, skills, prompt templates, and tool selection so Pi resolves its normal local configuration. `--offline` and `--no-approve` are not assumed safe or unsafe: a fake-RPC parity test must demonstrate whether each changes the discovery/turn contract. The implementation keeps either flag only if that test proves it preserves the resolved native configuration and does not turn `write` into a process-permission control; otherwise it removes it. The same test is the sensitivity gate for accepting the final argv.

Alternative rejected: `--list-models`/human CLI output scraping. It cannot express per-model thinking levels through the same native session contract and bypasses the required RPC boundary.

### 3. OpenCode remains fixed-origin and attach-only

The existing fixed-origin, GET-only OpenCode client remains the only network capability. It reads `/provider` for connected provider/model catalog and variants. The Driver always omits the agent selector so the pinned Server retains its local native default agent and configuration. It never reads `/config`, enumerates configuration, hardcodes `codex-explorer`, `build`, another agent, a profile, or a model, creates an OpenCode configuration profile, starts/reconfigures the Server, or makes provider calls.

The OpenCode Driver filters and validates that bounded projection. Every caller explicitly states an effort which maps to exactly one advertised variant and is sent as that native variant. It rejects absent effort, inference, and fallback before session, message, or provider work.

The route uses the connected Server's local plugin/MCP/tool/prompt configuration unchanged. Its eligibility check proves only the specified route and noninteractive interaction facts; it neither copies configuration nor treats an inherited capability as enumerated. The existing one-active-turn, fixed-origin, secret-redaction, and attach-only boundaries remain unchanged.

Alternative rejected: a HarnessDock model/profile mapping table. It duplicates operator-owned configuration and would require a reload or a second source of truth after every local change.

### 4. `write` is prompt and receipt authority only

Route preparation includes the immutable `behavioral_read_only` or `behavioral_write` text and records that authority on the Agent. Both Pi and OpenCode snapshots explicitly state `authorityEnforcement=prompt_only`, `leafEnforcement=prompt_only`, and `nativeOrchestration=opaque_bounded`. It does not choose native tools, tool denial, CLI arguments, process permissions, plugins, MCP configuration, sandbox settings, or local configuration. `leaf` remains the top-level HarnessDock Agent boundary; native delegation is opaque to HarnessDock, which neither schedules nor controls it, and the prompt is the only HarnessDock constraint.

Alternative rejected: retaining Pi's read/write tool arrays or treating OpenCode profile policy as proof of an OS-level read-only boundary. Either changes native configuration from a caller authority bit and overstates enforcement.

### 5. Dynamic MCP values remain bounded and lifecycle-safe

`list_harnesses` returns the fresh redacted route projection. The typed MCP schema requires explicit model and effort for every spawn; Pi/OpenCode values are bounded dynamic strings which the runtime—not schema enumeration alone—validates against the fresh Driver inventory. Claude retains its existing minimal effort validation/freezing without new native discovery, configuration, or lifecycle behavior. Follow-up inherits its frozen accepted effort. One coordinated MCP API-generation bump and plugin minor version invalidates old MCP processes. After the new MCP is loaded, local Pi/OpenCode configuration changes need no HarnessDock reload because neither inventory nor route acceptance is cached.

Alternative rejected: fixed Zod enums generated at plugin load. They cannot observe local route changes and invite stale client assumptions.

### 6. Tests prove no-inference behavior at the transport seam; final live smoke is bounded

Fake Pi RPC and fake OpenCode fixed-origin Server fixtures capture every command/request and reject `prompt`/mutation/model transport. Contract tests cover fresh-list changes, exact tuples, required explicit effort, selector omission, invalid effort, pre-transport drift, disappeared existing routes, write-equivalent native configuration, redaction, OpenCode variant mapping, Pi configuration restoration, and both candidate flags. The RED/sensitivity check deliberately restores the old fixed route, cached/stale inspection, inferred variant/default, agent selector, tool/argv write branch, or forced Pi-disable flag and requires the corresponding focused test to fail; then the final implementation is rerun green. `npm run check` is the deterministic suite gate.

Only after those deterministic gates, acceptance may run exactly one real Pi and one real OpenCode smoke. Each uses `gpt-5.6-luna` with low effort/variant and one minimal bounded prompt; it stops on auth, quota, or route mismatch and does not retry, benchmark, or broaden into an evaluation. Discovery, list, and doctor remain zero-model-cost.

## Risks / Trade-offs

- [Pi RPC control session may require a process but no prompt] → Bound commands, timeout, output size, and cleanup; use fakes for all repository tests and claim only zero-inference discovery.
- [Native configuration changes between list and transport] → Fresh inspect plus immediate exact revalidation; reject rather than reuse list facts.
- [OpenCode catalog lacks a needed model or variant] → Reject the route; preserve fixed-origin attach-only behavior and do not infer a value from names or old constants.
- [Dynamic MCP schema can accept arbitrary strings before runtime validation] → Bound string size/shape at MCP parsing and require exact fresh Driver equality before durable mutation.
- [Prompt-only authority is mistaken for containment] → Use explicit receipt/enforcement wording and test that `write` does not modify native launch/configuration inputs.

## Migration Plan

1. Build the discovery and exact-route seam behind existing Driver boundaries with fake transport tests; do not start live Harnesses.
2. Change MCP generation and package minor version together, regenerate the plugin manifest from `package.json`, and update all eight skill/MCP descriptors as required by existing release checks.
3. Run focused RED/sensitivity checks, focused green suites, `openspec validate`, doctor, release-smoke fakes, and `npm run check`; all remain zero-model-cost.
4. After those deterministic gates, run exactly one minimal real Pi and one minimal real OpenCode smoke using `gpt-5.6-luna` low effort/variant; stop each on auth, quota, or route mismatch and record only a sanitized receipt.
5. Existing in-memory old-generation MCP calls receive the restart-required error. Existing Agent records retain their original route; after upgrade they fail closed if their route cannot be freshly proven. Rollback is the normal checkout/plugin-version rollback before any installation; this change performs none.

## Open Questions

None. The exact Pi RPC commands (`get_available_models`, `set_model`, `get_available_thinking_levels`, `get_state`, and bounded `get_commands`) are locally source-verifiable; the final `--offline`/`--no-approve` disposition is a required fake-RPC parity gate, not an unresolved contract choice.
