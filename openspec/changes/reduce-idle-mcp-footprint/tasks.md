## 1. Freeze the import boundary

- [ ] 1.1 Add a load-bearing characterization that proves the current MCP frontend imports `harness-registry.mjs` and therefore the three Driver implementation modules before any lifecycle call; demonstrate sensitivity against the pre-change source.
- [ ] 1.2 Add the public generation Harness enum to `runtime/mcp-api.mjs` and make `runtime/mcp-server.mjs` consume it without importing the Driver registry or a Driver module.
- [ ] 1.3 Make `runtime/harness-registry.mjs` fail closed when its derived Driver-v2 factory membership differs from the public generation enum; retain alphabetical order and all existing v1/v2 semantics.

## 2. Preserve the public contract

- [ ] 2.1 Extend focused tests to prove the exact admitted Harness enum, exact MCP tool schemas, unchanged generation 11, and the cold frontend dependency boundary.
- [ ] 2.2 Run `node --test tests/runtime/mcp-server.test.mjs tests/runtime/harness-driver-contract.test.mjs tests/runtime/opencode-public-generation.test.mjs tests/runtime/pi-public-generation.test.mjs tests/runtime/plugin-contract.test.mjs`.

## 3. Measure and accept

- [ ] 3.1 Re-run the exact clean-checkout cold-import command and record before/after PSS, RSS, FD count, and import latency in `evidence/resource-receipt.md`; do not derive unique memory from RSS or turn observations into portable limits.
- [ ] 3.2 Run `openspec validate reduce-idle-mcp-footprint --strict` and `npm run check`; verify the worktree contains no unrelated changes and no test-owned service or worker remains.

## 4. Harness evaluation

- [ ] 4.1 Give OpenCode, Pi, and native Codex subagents the same `gpt-5.6-terra` high-effort read-only implementation-planning prompt over this OpenSpec, then record route, latency, correction burden, decision-bearing findings, and available native usage fields in `evidence/harness-evaluation.md`.
- [ ] 4.2 Assign disjoint implementation or verification packages based on that first-round evidence, lead-verify every accepted diff/receipt, and report only task-shaped strengths; do not infer a universal Harness ranking or fabricate comparable token cost when a provider omits fields.

## 5. Integration boundary

- [ ] 5.1 Commit this change on `codex/reduce-idle-mcp-footprint` without release or installation changes. Reconcile the separately owned `bound-unknown-agent-residency` change only after both sides have commits, then rerun the union of their focused gates before any later merge.
