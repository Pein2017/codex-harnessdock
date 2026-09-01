# Harness evaluation receipt

Date: 2026-09-01 UTC  
Common review route: GPT-5.6 Terra, high effort  
Claim boundary: two task-shaped observations, not a universal Harness or model ranking.

## Round 1: same OpenSpec implementation-plan task

| Harness | Outcome | Observable cost/latency | Decision-bearing result |
|---|---|---|---|
| native Codex subagent | completed | Comparable provider token and exact duration fields were not exposed | Concise correct plan; uniquely highlighted the future transitive `mcp-api -> registry` regression/cycle risk. No correction was required. |
| Pi through HarnessDock | completed in 138.6 s | 100,671 input, 252,928 cache-read, 6,089 output tokens; 31 tool calls; cost unavailable | Correct, detailed source trace and the same minimal patch. More evidence than needed for this bounded task. |
| OpenCode through HarnessDock | terminal unknown after 300.6 s | No accepted terminal usage receipt | `driver_result_rejected`; no history capability or acceptable answer. This is Harness/control-plane reliability evidence, not proof that Terra reasoned poorly. |

Pi's durable terminal record contained a complete final answer even though a later `read_agent_messages` call returned `Pi RPC closed before agent_settled`. The terminal record, not that reader error, owns the accepted outcome.

## Round 2: same tiny final-diff review

Both HarnessDock routes returned `PASS`, matching the lead's focused test replay.

| Harness | Provider-reported usage | Tool calls | Output shape |
|---|---:|---:|---|
| OpenCode | 3,800 input; 26,112 cache-read; 83 output; reported cost USD 0 | 0 | Direct 61-word bounded verdict with the requested falsifier. |
| Pi | 20,543 input; 39,424 cache-read; 966 output; cost unavailable | 7 | Correct verdict, but substantially more exploration than the task required. |

## Write-package observation

- HarnessDock correctly rejected two concurrent writers targeting one canonical execution root with `batch_writer_conflict`.
- Separate-worktree HarnessDock write launches then rolled back or failed before a model turn with `Launch claim record ... capability schema version 3; this runtime requires 4`.
- Therefore no OpenCode/Pi write diff is scored. Treating the failure as model quality would be invalid.
- Fresh native Codex Terra-high workers produced the RED tests and the three-file production patch. Lead replay found the intended 2/2 RED, then 156/156 focused GREEN with no correction.

## Task-shaped routing hypothesis

Current evidence suggests:

1. **OpenCode** may be efficient for extremely bounded, zero-tool diff judgments; its longer exploratory turn currently has a serious settlement/reliability risk.
2. **Pi** is strong when a source-tracing investigation benefits from many tool calls and a durable exact-session transcript, but it can spend far more tokens than necessary on a small review.
3. **native Codex subagents** are currently the most reliable implementation route in this environment: direct writable worktrees, concise plans, RED/GREEN completion, and no HarnessDock launch-claim migration blocker.

These are hypotheses to guide routing, not permanent preferences. A future benchmark should first repair the HarnessDock write-claim migration path, then compare accepted diffs with provider usage available on all three routes.
