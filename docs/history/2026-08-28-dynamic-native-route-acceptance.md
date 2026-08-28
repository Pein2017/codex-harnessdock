# Dynamic native route acceptance receipt (2026-08-28)

Scope: OpenSpec change `discover-native-harness-routes` in
`/data/CoordExp/codex-harnessdock-dev`.

## Deterministic candidate

- Package base: `0.22.0`.
- MCP API generation: `7`.
- Plugin manifest: `0.22.0+codex.20260828070239`.
- `npm run check`: pass.
- Required Pi/OpenCode/MCP/diagnostics/release focus: 198/198 pass.
- Expanded route/lifecycle consumer gate: 442/442 pass before the full-suite
  migration; all migrated consumers and the final full suite pass.
- `openspec validate discover-native-harness-routes --strict`: pass.
- `git diff --check`: pass.

The accepted runtime requires explicit full model and effort for every new
spawn. Pi and OpenCode discovery never retain or infer a native default.
`write` changes only the behavioral prompt/receipt authority. OpenCode uses a
workspace-bound fixed-origin `/provider` projection, omits the agent selector,
and sends the exact advertised effort as the native top-level variant.

## Zero-model discovery

The development checkout observed Pi ready with
`openai-codex/gpt-5.6-luna` and exact effort `low`. After an operator-owned
loopback `opencode serve` started, OpenCode observed exactly the locally
configured `openai/gpt-5.6-{luna,terra,sol}` models and their advertised
variants, including `low`. Discovery made no model request.

## Bounded live smoke

Exactly one turn per Harness, with no retry:

- Pi: `openai-codex/gpt-5.6-luna`, effort `low`, read-only prompt; completed
  with `PI_LUNA_LOW_OK`.
- OpenCode: `openai/gpt-5.6-luna`, variant `low`, read-only prompt; completed
  with `OPENCODE_LUNA_LOW_OK`.

## Remaining activation boundary

The installed Plugin remains on the canonical checkout
`/data/CoordExp/codex-harnessdock`. The development worktree is dirty and no
commit, promotion, install, archive, or push was performed. The promotion gate
requires a clean committed `developer` branch and a fast-forward into clean
`main`; until that separately authorized boundary occurs, installed
`npm run doctor` and `npm run smoke:release` correctly report stale install
parity. The live smokes above exercised the development checkout's production
runtime, not the installed Plugin snapshot.
