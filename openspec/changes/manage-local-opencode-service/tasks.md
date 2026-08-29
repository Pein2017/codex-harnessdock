## 1. Fixed environment and diagnostics

- [x] 1.1 Add Pi/OpenCode keys to the canonical dotenv allowlist and tracked runtime environment, with focused precedence/redaction tests proving shell-profile independence.
- [x] 1.2 Replace Pi's catch-all discovery projection with closed actionable configuration, executable, RPC, timeout, and protocol reasons plus focused tests.

## 2. Shared OpenCode service

- [x] 2.1 Add focused falsification tests for healthy reuse, concurrent single start, stale ownership, incompatible endpoint, and failed-child cleanup.
- [x] 2.2 Implement the minimal shared service manager using the existing durable lock, process identity, fixed client, and owner-only state helpers.
- [x] 2.3 Ensure the service during MCP bootstrap and immediately before OpenCode spawn while keeping doctor and `list_harnesses` read-only.

## 3. Acceptance and release

- [x] 3.1 Update doctor and zero-model release smoke assertions for bounded managed/reused readiness without a model call.
- [x] 3.2 Update changelog and package minor version, then run focused tests, strict OpenSpec validation, and `npm run check`.
- [x] 3.3 Promote the accepted source to the canonical checkout, refresh the installed Plugin, and validate doctor plus live Pi/OpenCode `list_harnesses` from a fresh task/process.
- [x] 3.4 Freeze the final diff for one `claude-opus-5` high blocking review and directly replay any accepted counterexamples before completion.
