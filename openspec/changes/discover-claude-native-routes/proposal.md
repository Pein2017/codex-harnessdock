## Why

Pi and OpenCode already take current model/effort facts from their native Harnesses, while Claude still publishes a checkout-owned model roster and accepts aliases and a default effort. That carve-out prevents one consistent harness -> exact model -> exact effort contract and can silently drift from the authenticated Claude installation.

## What Changes

- Replace the Claude static route roster with a bounded, zero-prompt native control inspection from the exact configured Claude executable and ordinary `CLAUDE_CONFIG_DIR` state.
- Use the native initialization/model-list response as the only admitted model source and require native per-model effort evidence. If the installed CLI cannot provide complete, unambiguous model/effort facts without a turn, report the Claude instance unavailable rather than falling back to a static table.
- **BREAKING:** remove Claude model aliases, effort aliases, and default-effort resolution from route admission; accept only the exact caller-stated model and effort freshly advertised by the native inspection.
- Revalidate the same exact tuple immediately before transport and leave existing Agent route identity immutable. Native configuration changes need no HarnessDock reload, but a disappeared or changed tuple fails before prompt submission.
- Preserve terminal-parity execution, prompt-only `write`, leaf/native-orchestrator topology policy, Claude-owned settings/plugins/MCP/history, and current exact-session recovery behavior without adding a process permission switch.
- Depend on `enforce-exact-discovered-routes`; implementation does not begin until that change and `discover-native-harness-routes` are accepted against the same base.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-driver-runtime`: obtain Claude model/effort route facts from bounded native inspection and revalidate the exact tuple before transport.
- `claude-session-execution`: remove static aliases/defaults while preserving native configuration, transport, session, and topology behavior.
- `typed-mcp-orchestration`: report Claude per-model effort choices from fresh discovery without adding a default or selector.
- `runtime-operations-diagnostics`: distinguish zero-prompt native catalog failure, incomplete effort evidence, authentication state, and route drift without exposing secrets.
- `plugin-release-readiness`: prove Claude discovery with fake control transport and one separately authorized bounded live inspection/turn witness.

## Impact

Expected surfaces are the Claude Driver/headless adapter, existing stream-json control transport, route inspection and MCP projection, diagnostics/release smoke, and Claude parity fixtures. The change adds no SDK/runtime dependency, model API client, settings parser, static compatibility catalog, provider fallback, paid retry, installation, release, archive, or model-quality claim.
