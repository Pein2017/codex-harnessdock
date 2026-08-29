## Why

HarnessDock currently binds every Agent to the Codex control worktree even when the task explicitly names another registered worktree. Pi can silently write outside that root, while OpenCode stops at a native `external_directory` approval; neither behavior provides the workspace identity or writer exclusion required by the durable runtime contract.

## What Changes

- Add optional spawn-only `target_worktree` selecting one existing registered sibling worktree of the trusted Codex Git repository.
- Separate the trusted control root, which owns registry and lifecycle state, from one immutable canonical execution root used by the Harness.
- Bind Driver cwd/directory, durable turn evidence, and writer admission to the execution root; follow-up inherits it and cannot retarget.
- Correct the existing v3 write path so every write-authorized turn durably binds both its Harness instance/session lease and the required execution-root writer lease before native input.
- Fail closed before route inspection or durable mutation for missing, unregistered, prunable, independent-clone, current-root-as-explicit-target, or owner-drifted targets.
- Keep receipts compact and keep exact roots operator-only.

Non-goals: creating or repairing worktrees, accepting generic cwd/env selectors, selecting branches, changing permissions, brokering approvals, copying lifecycle state between roots, retargeting an Agent, or adding a second lease system.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `typed-mcp-orchestration`: Admit the bounded spawn-only `target_worktree` selector while preserving strict rejection of generic execution selectors.
- `local-runtime-boundary`: Let a trusted Codex control root supervise execution in one registered sibling worktree without changing runtime or environment ownership.
- `agent-thread-registry`: Persist one immutable execution root independently from the root-scoped registry owner.
- `harness-driver-runtime`: Give Drivers only the validated execution root and revalidate it before native transport.
- `durable-runtime-state`: Carry control and execution roots separately through detached work, recovery, jobs, and launch evidence.
- `workspace-turn-authority`: Acquire, retain, and release write leases against the immutable execution root on every supported Harness lifecycle.

## Impact

The typed MCP schema, Agent registry generation, supervisor and v3 worker handoff, launch claims, Pi/OpenCode/Claude Driver scopes, workspace writer admission, skills, and focused runtime tests change. No dependency, installation, provider call, release, or public receipt field is added.
