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

## Installed activation

- Candidate commit `7f80766cd4a16dc14ba5319172d8d404ad2d6d5c` was fast-forwarded from
  `developer` to the canonical `main` checkout.
- Identity-adoption commit `ed52a1b1708b954309efffdb319aa43052793728`
  was also fast-forwarded to canonical `main` after the operator confirmed the
  current HarnessDock data root is authoritative and no legacy recovery is
  required.
- Canonical `npm ci` passed and `npm run refresh:local` installed
  `0.22.0+codex.20260828070239` while retaining the two bounded predecessor
  discovery shells.
- Installed zero-model `npm run smoke:release` passed. It observed the exact
  configured OpenCode `openai/gpt-5.6-{luna,sol,terra}` variants and Pi
  `openai-codex/gpt-5.6-{luna,sol,terra}` thinking levels without a model call.
- The promotion-only bootstrap integration gate then ran 20/20 with no skip.
- The separate one-time adoption operation wrote
  `/data/CoordExp/.codex/plugins/data/codex-harnessdock/operator/identity-adoption.json`
  with mode `0600`. It records the current root as authoritative, the legacy
  `cc` root and cutover backup boundary as absent, validated durable state, and
  `legacy_data_recovery_required: false`; no data was moved or deleted.
- Canonical `npm run refresh:local` restored the two bounded predecessor
  discovery shells from their valid archive without changing the installed
  `0.22.0+codex.20260828070239` version.
- Final `npm run doctor`: pass, including identity adoption, installed parity,
  compatibility coverage, MCP tools, and fresh native routes.
- Final zero-model `npm run smoke:release`: pass with `zeroModelCost: true`.
- Final `openspec validate discover-native-harness-routes --strict`: pass.

The Pi and OpenCode live receipts above remain the only paid smokes: exactly
one turn per Harness, no retry, and no second model call after identity
adoption. OpenSpec tasks 5.3 and 5.5 are therefore accepted without broadening
the model-quality scope.
