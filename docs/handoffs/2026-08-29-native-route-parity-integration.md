# Native route/parity integration handoff

## Authority and boundary

- Candidate worktree: `/data/CoordExp/.worktrees/harnessdock-parity-compose`
- Candidate branch: `codex/parity-compose`
- Base: `926fcbe`
- Do not install, release, archive, or push this candidate. The release gate is intentionally non-promotable.
- Peer task `01a04e08-19e0-7613-aeff-da531be96c05` owns the active `target_worktree`, OpenCode full-access/no-ask, and MCP-token work in `/data/CoordExp/codex-harnessdock-dev`.

## Candidate commits in order

1. `20994be` explicit canonical effort and inventory-neutral spawn guidance.
2. `3749fec` four OpenSpec changes and execution plans.
3. `3181dca` fail-close Pi old-turn observation; preserve `exact_resume`.
4. `3c70a48` permit generic provenance while Claude native evidence is on HOLD.
5. `c4e6e65` capability provenance v3, whole-replacement inspection evidence, v2 read-forward, cards/doctor projection.
6. `869e831` operation-specific parity rows and explicit HOLD semantics.
7. `faffa7a`, `3a2af69` Claude direct evidence and corrected claim boundaries.
8. `4cd8491`, `8691bd8` Pi direct evidence and corrected prompt oracle.
9. `15f5540`, `6e19716` OpenCode direct evidence and corrected raw-HTTP oracle.
10. `570d8ca` global 3x13 matrix and generic release assessment.
11. `0a4052c` production release CLI loads the canonical matrix and fails closed.

## Current evidence

- Global matrix: 39 cells = 27 pass, 2 fail, 3 hold, 7 capability-derived not-applicable.
- HOLD: Claude exact dynamic model/effort inventory; Claude provider-native continuation-turn identity; Claude replay-safe recovery binding.
- FAIL pending peer integration: OpenCode full native configuration inheritance; managed OpenCode Service process lifecycle.
- Canonical receipts:
  - `tests/runtime/fixtures/native-parity/native-harness-differential-parity.receipt.json`
  - `tests/runtime/fixtures/native-parity/native-harness-differential-parity.receipt.md`
- Lead replay: focused parity suite 260/260; `npm run check` unit 1588 pass, 1 expected skip; integration 20/20; strict provenance and parity OpenSpec validation passed.

## Integration order

1. Seal the peer task into logical commits without resetting unrelated state.
2. Start a fresh integration branch from the peer's accepted tip.
3. Replay this branch's commits in the order above. Resolve by behavior, never whole-file replacement.
4. Re-run the three local direct-oracle suites before recomposing the global receipt.
5. OpenCode full-access/config/service changes must update its local receipt from new behavioral comparisons; never flip the two global failures by editing the global JSON alone.
6. Run `npm run check`, both strict OpenSpec validations, and verify `npm run smoke:release` remains nonzero while any HOLD/FAIL remains.

## Expected conflict surfaces

- `runtime/agent-runtime.mjs`, `agent-store.mjs`, `internal-runtime.mjs`, `launch-claim.mjs`, `v3-worker-entry.mjs`
- `runtime/harness-contract.mjs`, `opencode-driver.mjs`, `opencode-service-manager.mjs`, `release-smoke.mjs`
- spawn/wait Skill metadata and MCP descriptions
- shared Driver/public-generation/launch-claim/reconciliation/release-smoke tests

Preserve peer-owned execution-root/writer-lease semantics and this branch's attempt-qualified provenance/execution-route semantics. A schema-v2 Agent keeps its historical route; a fresh v3 attempt uses a semantically equal execution route and full inspection evidence.

## Remaining completion boundary

- `discover-claude-native-routes` is correctly HOLD on Claude Code 2.1.250: zero-prompt list/set controls do not validate exact selectable model/effort values.
- `enforce-exact-discovered-routes` cannot claim universal ready-instance effort inventory while Claude remains unchanged.
- Parity task 3.1 and optional live task 4.3 remain unchecked. No live witness is authorized in this candidate.
