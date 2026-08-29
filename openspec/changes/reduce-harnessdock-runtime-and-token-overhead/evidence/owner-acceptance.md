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

## Residual gates

- Task 1.2 is complete: the bounded ordinary-config diagnostic recheck and all required parser fixtures now pass without a model request.
- Task 1.3 remains unchecked: the bootstrap/guidance/prompt sensitivity receipts are present here, but L0 must bind the predecessor eager-startup and active/unknown-lease seams to one five-seam receipt without reclassifying the lifecycle lane's pre-change evidence.
- Task 1.4 remains HOLD. L0 must decide any production-shaped Codex-host restart probe and final acceptance.
- Task 6.1 is complete: on 2026-08-29, `npm run check` passed lint, typecheck, 1,556 unit passes (one intentional skip), and 19 integration passes (one intentional skip) in 45.53 seconds. Its pinned test runtime left no test-owned service or supervisor process. The immediately following live observation found 43 pre-existing bootstrap processes at 382,690 KiB PSS and 43 pre-existing MCP servers at 1,243,639 KiB PSS; these are separate process-group PSS totals, not unique-memory RSS claims. Protected ordinary OpenCode PID 3948641 remained alive at 404,472 KiB PSS.
