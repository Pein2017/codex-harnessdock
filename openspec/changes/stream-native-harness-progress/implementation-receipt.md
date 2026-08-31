# Implementation Receipt

## Package Acceptance

- Package: `realtime-progress-v1`, frozen from developer HEAD `65a347b8204241371ca520a14b2dcb3eaeb257c8` under OpenSpec `stream-native-harness-progress`.
- Status: `candidate` for L0 acceptance; no archive, release, install, merge, or push was performed.
- Effective depth: **2**. Both independent L2 outputs materialized:
  - Pi JSONL progress plus exact baseline-entry `observeTurn()`; focused source receipt passed.
  - OpenCode SSE/message/status progress plus exact message-lineage `observeTurn()`; focused source receipt passed.
- Routes: L1 `gpt-5.6-terra/high`; Pi L2 `gpt-5.6-luna/high`; OpenCode L2 `gpt-5.6-terra/high`. Recovery packages used Terra/high for lifecycle fixes and Luna/high for bounded guidance assertions.

## Accepted Outcome

- Capability schema v4 records `nativeProgress` explicitly. Claude remains `supervisor_projected`; Pi and OpenCode are `native_coalesced` with exact terminal observation.
- Version-three jobs persist only the latest bounded safe progress revision, allow later explicit meaningful revisions, keep ordinary waits completion-only, and clear live progress on terminal/unknown transitions.
- Pi consumes its native RPC events without TTY simulation and reconstructs a lost turn only from its exact session/baseline lineage.
- OpenCode keeps synchronous prompt submission, consumes the fixed `/event` SSE plus bounded exact-session message/status reads, and never enables public history or `prompt_async`.
- `wait_agent` performs bounded lost-worker reconciliation only for an exact dead worker identity; coherent terminal evidence publishes completion and releases leases exactly once.
- Future Harness lifecycle proposals must state and test native progress rather than silently ignoring an available noninteractive surface.

## Decisive Verification

- Focused integrated suite: **269 passed, 0 failed** across Driver contracts, Pi/OpenCode parity, V3 store/worker/reconciliation, progress/wait races, Skills, and target-worktree admission.
- Full `npm run check`: unit **1695 tests / 1694 passed / 0 failed / 1 skipped**; integration **20 passed / 0 failed**.
- `openspec validate stream-native-harness-progress --strict`: passed.
- Plugin validation: passed.
- `git diff --check`: passed.
- Native differential matrix: **34 pass / 0 fail / 0 hold / 8 not applicable**, 42 closed cells.

## Production-Shaped Witness

The two authorized Luna-low smoke turns each published sanitized progress before their original worker disappeared. After the two discovered recovery bugs were fixed, the same durable turns were reconciled without another model call:

- Pi `hd-agent-mtgq0rp9-y9e5nk`: progress revision 2, then exact terminal completion; 12,465 input tokens and 5 output tokens reported by the native session.
- OpenCode `hd-agent-mtgq4bly-t6kte8`: progress revision 1, then exact terminal completion; 12,599 input, 1,536 cache-read, and 5 output tokens reported by OpenCode.

Both V3 records are now `completed`, carry `progress: null`, preserve their delivered revision, have published completion timestamps, leave no active Agent job, and have no matching lease residue. OpenCode's reported cost `0` is subscription metadata, not an invoice or a zero-cost claim.

## Corrections And Residuals

- One bundled recovery correction followed real counterexamples:
  1. terminal/unknown V3 transitions retained active progress and failed their own validator;
  2. OpenCode treated an omitted idle-session status entry as unknown before checking exact terminal messages;
  3. lost-worker Driver resolution bypassed the runtime env-file view, and the initial SSE header wait lacked its configured deadline.
- The newer OpenCode `/api/session/:id/history` route returned an internal error for retained legacy sessions. The accepted implementation therefore uses the live-compatible `/event`, `/session/:id/message`, and `/session/status` surfaces; raw native history is not a public capability.
- MCP `notifications/progress` remains host-log/UI evidence, not a proven model-visible stream. The supported model-facing boundary remains explicit `wait_agent` long-polling.
- Release/install and a new-task reload remain separate user-authorized actions.

## Retained-Schema Compatibility Correction

- A genuine retained capability-schema v2/v3 Agent without the later `nativeProgress` dimension reproduced the production failure before an unrelated fresh spawn could launch.
- Stored v2/v3 snapshots now validate only their historical dimensions, without defaulting or rewriting `nativeProgress`; a partial later claim still fails, and every fresh route remains strict schema v4.
- The public-spawn regression passed for both retained schemas and preserved each historical route byte-for-byte. The exact production schema-v2 terminal route also passed a read-only replay with `nativeProgress` still absent.
- Focused migration/Driver/public-spawn/worker suites passed **208/208**. Strict OpenSpec validation and `git diff --check` passed. Fresh `npm run check` passed with unit **1710 tests / 1709 passed / 0 failed / 1 skipped** and integration **20/20 passed**.

## Depth-2 Pilot Receipt

- Lead disposition: accepted candidate.
- Depth-2 predicate: satisfied, 2 independent L2 outputs.
- L0 raw L2 transcript reads: 0.
- L0 direct production-code edits: 0. L0 made five bounded schema/receipt or race-semantics fixes in tests after independently reproduced failures and authored/corrected the OpenSpec artifacts.
- L1 correction rounds: 1 bundled recovery round.
- Role/write-surface drift: none; Pi, OpenCode, and shared surfaces remained disjoint until L1/L0 integration.
- Critical-path wall time: not instrumented; no latency claim.
- Usage coverage: implementation-agent tokens were not exposed by the collaboration transport; the two live smoke metrics above are provider/native receipts only. No matched depth-1 run exists, so no savings or model-superiority claim is made.
- Observed benefit: L0 retained the semantic contract and accepted one compressed package while two protocol-specific implementations completed independently.
- Observed overhead: schema-v4 fixture migration and two live recovery counterexamples required one bounded integration/recovery pass.
- Pilot recommendation: **retain** for multi-Harness packages with two genuinely disjoint protocol outputs; do not infer a general cost advantage from this package.
