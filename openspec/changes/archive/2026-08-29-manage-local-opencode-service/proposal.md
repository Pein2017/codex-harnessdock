## Why

OpenCode currently becomes unusable whenever the operator-owned `opencode serve` terminal exits, while Pi can appear only as `unknown` when its fixed configuration is absent from a long-lived MCP process. HarnessDock should consume its existing single dotenv boundary and own the minimal local service lifecycle needed for zero-terminal-operation routing.

This change is ordered after the completed `discover-native-harness-routes` change and preserves its dynamic native model/effort discovery, prompt-only write authority, and exact-route validation.

## What Changes

- **BREAKING**: replace OpenCode's attach-only lifecycle with one Plugin-managed-or-reused loopback Server. HarnessDock ensures it during MCP startup and immediately before an OpenCode spawn, using a cross-process ownership fence so concurrent Codex tasks share one service.
- Extend the existing single selected dotenv environment with allowlisted `PI_CODING_AGENT_DIR` and `OPENCODE_EXECUTABLE`; never source `/root/.bashrc` or evaluate shell code.
- Preserve native OpenCode configuration, plugins, MCPs, tools, models, authentication, and workspace routing. HarnessDock does not install, log in, use `--pure`, start a model turn during service readiness, or kill an unowned process.
- Replace Pi's catch-all discovery `unknown` with closed, redacted reasons for missing configuration, missing executable, incompatible RPC, and other bounded protocol failure.
- Update doctor and zero-model release acceptance for managed/reused OpenCode service evidence and Pi's actionable readiness.
- Non-goals: per-Agent Servers, non-loopback binding, public executable/endpoint selectors, automatic authentication, provider fallback, model inference, general process supervision, or a second env-file mechanism.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-explorer-runtime`: OpenCode becomes one shared Plugin-managed-or-reused local Server instead of attach-only operator lifecycle.
- `local-runtime-boundary`: the existing single dotenv boundary admits fixed Pi/OpenCode executable configuration and narrowly owns the managed OpenCode service.
- `runtime-operations-diagnostics`: readiness reports managed/reused OpenCode ownership and actionable bounded Pi discovery failures.
- `plugin-release-readiness`: zero-model installed acceptance permits service ensure/reuse while continuing to forbid model usage and production Agent-state mutation.

## Impact

Affected surfaces include `runtime/environment.mjs`, the OpenCode Driver/client lifecycle, one new internal service manager and its private receipt/log boundary, Pi readiness projection, MCP bootstrap/spawn ordering, doctor/release smoke, focused runtime tests, `config/runtime.env`, package/version metadata, and the corresponding main specs. No new dependency or model-facing configuration field is introduced.
