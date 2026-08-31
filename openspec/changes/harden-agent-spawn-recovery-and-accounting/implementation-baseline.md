# Implementation baseline

Frozen before Change A implementation on 2026-08-30:

- source commit: `e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a`
- source tree: `24dc2adfc944018d80f56f3bbb78c1ce559f4681`
- main-spec commit/tree: `06619cd705eb9fa03f4283ea91dec7b800dbd49e`
- package version: `0.25.4`
- MCP API generation: `8`

The following completed changes are deliberately **stacked**, not synced into
the main specs. Each was strict-valid at this frozen source:

1. `add-target-worktree-agent-spawn`
2. `discover-native-harness-routes`
3. `discover-claude-native-routes`
4. `enforce-exact-discovered-routes`
5. `bind-routes-to-native-provenance`
6. `fail-closed-opencode-interaction-admission`
7. `improve-agent-card-and-usage-receipts`
8. `expose-actionable-agent-blocking`
9. `compact-mcp-catalog-guidance`

Baseline behavioral receipt (before edits):

```sh
node --test tests/runtime/mcp-server.test.mjs \
  tests/runtime/agent-card.test.mjs \
  tests/runtime/target-worktree-admission.test.mjs \
  tests/runtime/pi-public-generation.test.mjs \
  tests/runtime/opencode-public-generation.test.mjs \
  tests/runtime/task-9-composed-fake-path.test.mjs
```

Result: 68 pass, 0 fail.
