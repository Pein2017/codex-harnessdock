# Candidate owner evidence — bootstrap and control-text lane

Status: candidate; L0 acceptance required. No model, provider, paid, install, release, or termination action occurred.

## Baseline characterization

- Linux observation supplied with the accepted change: 29 bootstrap processes, RSS 1,412,232 KiB and PSS 262,647 KiB; 29 MCP servers, RSS 2,331,360 KiB and PSS 839,233 KiB. RSS and PSS are distinct and RSS is not summed as unique memory.
- OpenCode probe observation: PID 3948641, RSS 404,628 KiB, PSS 403,102 KiB.
- Model-visible guidance: 13,028 chars = 1,272 raw tool-description chars + 8 × 1,103 chars of host-repeated instructions (8,824 chars) + a frozen 2,932-char host projection reserve for unchanged schemas, names, Plugin identity, and declaration projection. Client catalog data alone is not the actual Codex model-visible aggregate.
- Eight Skill files: 16,648 bytes. Default prompt: 793 joined chars / 809 compact-JSON chars. OpenCode v1 envelope: 789 chars.

## Current deterministic receipts

- Raw client seam: 8 tools; shared instructions 43 chars; raw descriptions 1,078 chars; raw client projection `1,078 + 8 × 43 = 1,422` chars.
- Frozen host projection reserve: 2,932 chars. Projected model-visible total `2,932 + 1,422 = 4,354` chars (limit 4,500). A fresh installed Codex task must remeasure `ALL_TOOLS`; this is a bounded projection, not a fresh host measurement.
- Eight Skills: 11,428 bytes (internal production margin limit 11,500; OpenSpec ceiling 12,000). Default prompt: 372 joined chars / 382 compact-JSON chars (limit 800).
- OpenCode v2: envelope 373 chars (limit 450), version 2; caller task remains one unchanged delimited occurrence.
- Bootstrap has no child spawn: it preflights, changes to the canonical checkout, sets the resolved environment, dynamically imports the canonical MCP module, and awaits `runCcMcpServer()` in the same PID. While the test bootstrap is alive, Linux checks its exact `/proc/<pid>/task/<pid>/children` file is empty; after stdin closes it exits code 0 and `ps --ppid <pid>` finds no survivor. The plugin contract also rejects a child-process bootstrap source.

## Sensitivity and diagnostics

- `mcp-server.test.mjs` reads the actual `Client.listTools()` catalog and fails when the frozen host reserve plus synthetic host-repeated instructions exceeds 4,500; it separately asserts the raw client seam and exact eight schemas. Route, authority, wait, delivery, and closed-error guidance remains in the owning tool description and Skill.
- `opencode-prompt.test.mjs` asserts v2 is at most 450 and the v1 characterization (789) cannot satisfy that ceiling; delimiter refusal, exact caller text identity, final-only bounded output, unknowns, and digest/version lineage remain exercised.
- `plugin-contract.test.mjs` measures installed Skill bytes/default prompt and fails if the pre-change 16,648-byte characterization is applied to the 11,500-byte margin bound.
- `opencode-native-discovery.test.mjs` freezes complete model success, malformed, truncated, duplicate, timeout, unavailable, and credential-redaction cases. Its ANSI-decorated bullet fixture proves that title, config-path, and footer lines do not become providers; malformed, duplicate, and rowless credential output fails closed. The fixture failed against the previous whole-line normalizer, then passed after the bounded parser correction.
- One ordinary-config, zero-model recheck resolved `./config/runtime.env` from this checkout and invoked dormant discovery once. It returned `ok: true` with model ids `openai/gpt-5.6-luna`, `openai/gpt-5.6-sol`, and `openai/gpt-5.6-terra`; each exposed only effort keys `high`, `low`, `max`, `medium`, `none`, and `xhigh`. No raw auth/configuration diagnostic was persisted or reported.
- MCP idle self-exit/restart probe is HOLD: no host-transparent trusted-context recovery evidence, so no idle self-exit was implemented.

## Final acceptance additions (2026-08-29)

### Five-seam falsification receipt (Task 1.3)

The owner bound the five required stable seams without recasting post-change results as a pre-change RED timestamp: the baseline report records eager MCP ensure, a two-process bootstrap child, missing active/unknown protection, 13,028-character guidance, and the 789-character v1 envelope. Current consumer-facing checks cover (1) zero-model/non-OpenCode startup without an OpenCode Server, (2) one resident bootstrap process with an empty exact `/proc` children file, (3) active and settlement-unknown lease holds, (4) the 4,500-character projected guidance limit with injected growth sensitivity, and (5) v1's 789-character failure against v2's 450-character limit. Mutation/sensitivity receipts are retained by the owning test lanes. This proves the declared five current seams; it does not invent a historical RED run.

### Disposable same-task restart probe (Task 1.4)

An interactive fresh installed task first completed `list_harnesses`. Its exact task-owned MCP PID `1118281` ran `node -- /data/CoordExp/codex-harnessdock/plugins/codex-harnessdock/bootstrap/harnessdock-mcp.mjs`, with PPID `1115045`, PGID `1118281`, and an empty exact children file. Only that exact process group received `SIGTERM`; the disposable Codex host remained alive. The second same-task `list_harnesses` call failed with `Transport closed`, so the host supplied neither transparent restart nor trusted-context recovery. The host then exited cleanly with `/exit`. This is negative evidence sufficient for the task: no MCP idle self-exit was added, and the no-self-exit design remains mandatory.

### Release, installed, and bounded live receipts (Tasks 6.1–6.3)

- Task 6.1: `npm run check` passed lint, typecheck, 1,556 unit tests and 19 integration tests, each suite with one intentional skip, and left no test-owned service or supervisor process. The PSS observation remains process-group evidence, not summed RSS.
- Task 6.2: developer and main reached `177cc06`, then cachebuster correction `8f41483`; installed/enabled Plugin identity is `0.24.0+codex.20260829074259`. `npm run smoke:release -- --json` passed: eight tools/Skills, `skillBytes=11428`, `defaultPromptChars=372`, `rawClientDescriptionCharacters=1422`, `projectedModelVisibleCharacters=4354`, valid compatibility shells, and `paid.requested=false`.
- Task 6.3: exactly one authorized OpenCode leaf turn ran with route `opencode/openai/gpt-5.6-luna/low`, `write=false`, output `HARNESSDOCK_LUNA_SMOKE name=codex-harnessdock-runtime version=0.24.0`, and `attemptCount=1`, `recoveryAttemptCount=0`, `toolCallCount=0`. Provider fields were input `1962`, cache read `11776`, cache write `0`, output `27`, reasoning `0`, reported cost `0`; the result was verified against `package.json`.

### Fresh installed task and remaining boundary (Task 6.4)

A fresh native persistent Codex task (`01a04c80-a641-7bd0-961c-1632a5d49042`) loaded the exact installed `list-harnesses` Skill and reported all three Harnesses ready with `liveValidated=true`, exact OpenCode Luna/Sol/Terra variants and advertised efforts, Pi/Claude preservation, `restart_required=false`, `tool_unavailable=false`, and the exact eight tools. A separate interactive fresh task (`01a04c82-c734-7d22-8048-99569d67e01b`) also loaded the installed `0.24.0` Plugin and its first `list_harnesses` call reported all three ready. Neither fresh task measured the host description aggregate; `4354` remains the deterministic installed projection, not a fresh host measurement.

Task 6.4 remains unchecked. The ordinary managed OpenCode service was already live and protected by active/unknown durable leases, so no unsafe live stop/start was attempted. Deterministic Driver and service-manager tests prove that an absent service starts exactly one managed Server before a turn, but the fresh installed task did not observe an absent service cold-start. This is a capability/test receipt, not the literal live cold-start witness required by the task.

### Predecessor ordering and archive boundary (Task 6.5)

The user explicitly authorized sync/archive without push. `manage-local-opencode-service` was refreshed only to preserve pre-existing main-spec scenarios, then strict-validated, synchronized, and archived as `openspec/changes/archive/2026-08-29-manage-local-opencode-service`. Its archive updated two added and five modified requirements. The active delta was then strict-validated against that resulting main-spec base. This satisfies the ordering/authorization task, but does not authorize archiving the active change while Task 6.4 remains unchecked.
