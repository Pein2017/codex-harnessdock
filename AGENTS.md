# Repository guidance

- This is a checkout-owned Node.js 20.19+ ESM Codex Plugin supported on Linux. Non-Linux branches are best-effort only and do not define release gates.
- `runtime/index.mjs` is the sole public lifecycle interface. Keep stream-json, process, persistence, recovery, and mailbox details behind it.
- `runtime/execution-profile.mjs` is the sole owner of Claude CLI overrides. `terminal-parity` always adds `IS_SANDBOX=1` and `--dangerously-skip-permissions`; explicit `write` remains a prompt-level behavioral and recovery-risk boundary, not a process-permission switch. It must not acquire an implicit model, effort, settings, tool, MCP, or prompt override except the OpenSpec-owned bounded delegation envelope, the universal `Workflow` denial, and the leaf `Agent` denial.
- Resolve one env file through `runtime/environment.mjs`; never evaluate it as shell code or leak arbitrary values in receipts.
- Do not add runtime or source dependencies on Sendbird, upstream installers, Codex hooks, forwarding subagents, or versioned plugin cache paths.
- The independent clone `/data/CoordExp/codex-harnessdock` and its registered worktrees are the only Git/source owners. `/data/CoordExp/external/cc-plugin-codex` is reference-only and must never be used as a runtime, install, worktree, remote, merge, or Git-object dependency.
- Keep the Agent skills under `plugins/codex-harnessdock/skills/`, `runtime/`, package/manifest metadata, and `tests/runtime*` in sync. Old upstream material is not a compatibility contract.
- Run `npm run check` before merging.
- For releases, update `CHANGELOG.md` and the base version in `package.json`; the cachebuster refresh derives `plugins/codex-harnessdock/.codex-plugin/plugin.json` from that single source.
