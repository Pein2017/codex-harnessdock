## Why

OpenCode's default approvals can indefinitely stall a HarnessDock turn. The chosen boundary is not restrictive native permissions: HarnessDock must grant the maximum supported permission surface, then remove only unattended interaction and escape surfaces while target-worktree, writer, and lifecycle controls remain the safety boundary.

## What Changes

- **BREAKING**: Admit an OpenCode route only when the exact max-permission, zero-approval session policy can be freshly witnessed; otherwise expose the sanitized `interactive_policy` blocker and create no session.
- For a managed child, inject exactly `OPENCODE_PERMISSION='{"*":"allow"}'`, bind its nonsecret policy-generation digest and child-local environment into the managed-Service fingerprint/receipt, and revalidate OpenCode 1.18.23 compatibility rather than treating 1.18.18 reference source or SDK identity as proof.
- Create a session with ordered permissions: wildcard `allow`, then `question: deny`, `plan_exit: deny`, and `task: deny`; preserve the exact provider/model/variant route and omit an Agent selector.
- Revalidate health, provider, config, and agent at list, after managed-Service ensure, and immediately before session creation. The final native `GET /agent` must prove the default Agent resolves `doom_loop:*:allow`, because that rule is Agent-scoped despite the session wildcard.
- Exclude GitLab `duo-workflow-*` models, whose unoverrideable `ask` cannot meet zero-wait execution. Attached Servers are never restarted, replaced, or mutated to install policy; they run only after the final native witness proves the exceptional policy.

Non-goals: user/global/project OpenCode configuration mutation, a permission/question broker, prompt tool map, auto-answer, model call, install, release, archive, or changing target-worktree/writer/lifecycle controls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-explorer-runtime`: Require a fresh maximum-permission, zero-approval native witness before advertising or creating an OpenCode session.

## Impact

OpenCode discovery, managed-child lifecycle receipts, session creation, and focused fake-Server tests change. Pi and Claude are unaffected.
