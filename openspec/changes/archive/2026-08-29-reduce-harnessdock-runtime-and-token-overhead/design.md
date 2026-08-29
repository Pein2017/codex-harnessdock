## Context

See [proposal.md](./proposal.md) for the measured motivation. The completed `manage-local-opencode-service` change already provides fixed-loopback ensure, cross-process fencing, exact child identity, and managed/reused distinction; this change extends that owner rather than introducing another service supervisor.

Three different lifetimes must remain separate:

1. A Codex task owns one stdio MCP connection. The host, not HarnessDock, decides whether that connection is still usable.
2. HarnessDock may own one shared OpenCode Server process used across many MCP tasks.
3. Durable Agents, jobs, messages, native references, completions, and usage receipts outlive both process kinds.

The existing installed bootstrap is a standard-library Node process which validates the canonical checkout and then spawns a second Node MCP process with inherited stdio. OpenCode is currently ensured at every MCP startup. Production MCP calls already execute runtime operations in short-lived worker threads, and OpenCode turns run in detached version-three workers.

## Goals / Non-Goals

**Goals:**

- Remove one resident Node process from every newly started HarnessDock MCP connection.
- Make an absent OpenCode Server start only for an admitted OpenCode turn and reclaim only a proven managed instance after one idle hour.
- Keep dormant route discovery faithful to the operator's native OpenCode configuration.
- Reduce always-loaded and per-turn control text with deterministic budgets while preserving all public safety and delivery facts.
- Leave a measurable acceptance receipt that distinguishes physical-process, model-context, and provider-usage evidence.

**Non-Goals:**

- Do not use idle time as evidence that a Codex-owned MCP connection can disappear.
- Do not add a cleanup daemon, service manager dependency, capacity broker, or history retention policy.
- Do not make Pi resident or change its already-small prompt.
- Do not add an output-budget API field; the caller can request brevity in the existing task message.
- Do not expand native continuation or infer a model/harness ranking from this optimization.

## Decisions

### 1. Keep the descriptor bootstrap, but load the canonical MCP entry in-process

The installed and compatibility-shell bootstrap keeps its current standard-library-only validation and environment parsing. After validation it changes to the fixed checkout and dynamically imports the canonical `runtime/mcp-server.mjs`, then awaits its exported server entry in the same process. Signal forwarding and child-exit relaying disappear because there is no child.

This preserves actionable dependency failures before importing the MCP SDK, avoids any Plugin Cache runtime dependency, and removes the measured bootstrap process without changing `.mcp.json` framing or public tools.

Alternative: point `.mcp.json` directly at `runtime/mcp-server.mjs`. Rejected because a missing SDK/Zod dependency would fail in Node's module loader before the checkout-specific preflight can provide its bounded recovery action.

### 2. Dormant OpenCode discovery uses only bounded native diagnostics

When `/health` is absent, the Driver invokes the configured executable's existing `models --verbose` diagnostic, with no provider filter, `--pure`, or `--refresh`, under the same cwd/environment the operator's direct CLI receives. Output has a deadline and byte cap. The parser accepts only a sequence of exact model identifiers followed by complete JSON objects, projects only provider/model ids and variant keys, bounds counts with existing route limits, and rejects truncation, duplicate/conflicting identities, malformed JSON, unsupported atoms, or diagnostic failure. A bounded credential-list diagnostic may prove that a projected provider is configured, but its raw text is never persisted or returned.

Dormant discovery produces a distinct readiness detail such as `dormant_native_config`; it does not claim a live Server. The selected exact route is frozen as today. The detached worker then ensures the Server and requires fresh SDK `/provider` discovery to match the same model and effort before session creation.

Alternative: start the Server from `list_harnesses` and immediately stop it. Rejected because observational discovery would mutate lifecycle state and every main-thread route check would pay cold-start RSS/latency.

Alternative: cache the last live `/provider` response. Rejected because it would not observe the user's current native configuration after local edits.

### 3. Extend the existing service receipt; do not add a second lifecycle owner

The managed receipt advances one version and adds `startedAt` and `lastActivityAt`. A new allowlisted `HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS` value is parsed as data from the canonical environment file; absence selects `3600`, and an explicit value must be an integer from 60 through 604800 seconds.

The OpenCode Driver creates one owner-only lease file under the existing service directory before any possibly accepted native turn. The lease contains only bounded root/Agent/turn/attempt lineage and lifecycle state; it contains no prompt, credential, model output, or provider payload. It is released only after proven pre-transport rejection or exact terminal settlement. Acceptance-unknown work retains the lease even if its worker exits, because a dead worker does not prove the Server has no native work.

Creating a turn lease and releasing a settled turn both set `lastActivityAt` to the current time under the existing cross-process fence. Health, provider/model discovery, doctor, release smoke, and plain ensure/reuse do not update it.

### 4. Reap from existing MCP opportunities; add no daemon

Each long-lived MCP process owns at most one unreferenced housekeeping timer. MCP startup and completion of any MCP operation run one bounded `reapIfIdle` attempt and schedule the next opportunity no later than one TTL interval. Multiple MCP processes may become contenders; the existing link lock serializes them and every contender re-reads the receipt and leases after acquiring it. Consequently one hour is the eligibility threshold, while actual process exit may occur at the next bounded opportunity.

Reaping requires all of the following at the same fence:

- a valid managed receipt whose PID, start identity, command fingerprint, and loopback service still match;
- `lastActivityAt + TTL` in the past;
- no active or uncertainty-held OpenCode turn lease;
- no current peer/connection evidence contradicting idleness.

The winner requests the existing exact process-tree termination path, waits its bounded grace, removes only the matching ownership receipt after confirmed exit, and writes an owner-only tombstone with timestamps and a closed outcome. A missing/mismatched receipt, reused service, held lease, live peer, or ambiguous termination is a no-op/fail-closed result. No Agent or native session record participates in deletion.

Alternative: launch a detached reaper process per Server. Rejected because it recreates the resident-resource problem for one timer.

Alternative: reclaim only on the next OpenCode ensure. Rejected because ensure would immediately restart the process and would not release resources during ordinary non-OpenCode HarnessDock use.

### 5. Do not implement MCP idle self-exit in this change

A read-only production-shaped probe may terminate a disposable test MCP and attempt a later call from the same Codex task. Unless the host automatically restarts the server with the same trusted task/workspace metadata and durable operations still succeed, no MCP idle timer is added. This isolates the approximately 977 MiB current aggregate MCP-runtime PSS as host/task residency rather than misclassifying it as a Plugin-owned orphan leak.

### 6. Compact control text at its owning layer

The MCP server's common instructions become a short routing sentence; each tool description states only that operation's unique semantics. Detailed invocation and stop rules remain in the corresponding Skill, where they are loaded on demand. Plugin default prompts are reduced to routing pointers rather than mini copies of the Skills. Tests inspect the actual registered tool catalog and installed files, not hand-maintained estimates.

OpenCode prompt prefix version advances to v2. One composer still owns rendering and the digest. The prefix keeps authority, leaf/no-delegation, final-only delivery, bounded output, honest unknowns, and the existing unforgeable task delimiters, but removes universal path-and-line citation language. The caller task remains byte-for-byte identical and appears once. A load-time invariant enforces the 450-character envelope budget and the existing total/task bounds.

Completion messages and delivery tokens remain complete. Removing or truncating the Agent's final message would save parent context by discarding the requested result, so it is explicitly not an optimization.

### 7. Treat token savings as separate evidence classes

Deterministic tests record:

- actual exposed MCP-description characters;
- installed Skill bytes and Plugin default-prompt characters;
- OpenCode v1 fixture versus v2 envelope characters;
- process topology and zero surviving test-owned process groups.

The optional final live witness is one `openai/gpt-5.6-luna` low-effort OpenCode turn after all zero-model gates pass. It reports provider input, cache-read, cache-write, output, reasoning, and reported cost fields exactly as separate facts. The report does not add them into a fabricated "saved tokens" number because provider schemas may overlap or omit fields. PSS is reported separately from RSS; PSS variance is evidence, not a brittle test threshold.

## Risks / Trade-offs

- [Dormant CLI output changes across OpenCode versions] → Bound and fail closed in one parser; live SDK discovery remains the final pre-session authority.
- [Credential diagnostics prove configuration but not future token validity] → Label the state dormant and revalidate the live Server immediately before session creation.
- [A crashed/unknown turn can retain a service lease indefinitely] → Preserve the hold; false resource retention is safer than terminating possibly accepted native work. Add no automatic age override.
- [Multiple MCP timers contend for one cleanup] → Reuse the existing ownership fence and make every losing/no-longer-eligible attempt a no-op.
- [One-hour eligibility is not an exact wall-clock stop] → Run housekeeping at MCP startup/operation boundaries plus one unreferenced bounded timer; document the next-opportunity semantics.
- [Text compaction removes a safety fact] → Pair size assertions with semantic contract assertions for exact route, authority, topology, wait, delivery, and fail-closed wording.
- [In-process bootstrap makes the bootstrap itself the MCP PID] → Update diagnostics and tests to identify the canonical loaded source/generation rather than requiring a child PID.

## Migration Plan

1. Archive or sync `manage-local-opencode-service` before archiving this change; implementation may proceed on its already accepted code tree.
2. Capture the pre-change process/context baseline and a dormant CLI fixture before editing behavior.
3. Promote receipt v2 and lease handling first; old receipts without activity timestamps remain managed but are not idle-reaped until safely upgraded under the ownership fence.
4. Enable demand startup and dormant discovery, then the bounded reaper.
5. Convert the bootstrap to in-process loading and compact model-visible guidance/prompt v2.
6. Run focused tests, `npm run check`, zero-model installed release smoke, and the single explicitly authorized Luna-low witness.
7. Bump the minor release, refresh the canonical installed Plugin, and start a new Codex task for loaded-contract acceptance.

Rollback restores the previous Plugin version/bootstrap and disables the idle scheduler. It does not delete receipt v2, lease, tombstone, Agent, or usage state. A previous runtime treats unfamiliar service metadata as non-actionable and therefore does not reap it.
