## 1. Compact the static discovery surface

- [x] 1.1 Shorten only `runtime/mcp-server.mjs` public tool and field descriptions while retaining every locally attached decision-bearing semantic and leaving `runtime/mcp-api.mjs` unchanged.
- [x] 1.2 Regenerate `tests/runtime/fixtures/harnessdock-mcp-discovery.json` from the resulting source discovery payload without curating its fields or projection.

## 2. Freeze regression and guidance invariants

- [x] 2.1 Extend `tests/runtime/mcp-server.test.mjs` to assert the exact eight-tool catalog, unchanged spawn schema including `target_worktree`, deterministic serialized-catalog <= 4,500 characters, aggregate nested description text <= 800 characters, and a verbose-description sensitivity failure.
- [x] 2.2 Correct only `plugins/codex-harnessdock/skills/wait-agent/agents/openai.yaml` so one target may use `wake_on_progress`, and extend `tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs` to reject the former blanket prohibition while retaining the invalid multi-target case.

## 3. Verify the bounded change

- [x] 3.1 Run `node --test tests/runtime/mcp-server.test.mjs tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs` and `npm run check`.
- [x] 3.2 Report the before/after character counts and offline `o200k_base` token count as static evidence only; state that dynamic savings remain unmeasured because the target rollout made zero public MCP calls.
