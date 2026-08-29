# plugin-release-readiness Specification

## Purpose

Define zero-model-cost installed Plugin acceptance and the explicitly paid Haiku release extension.
## Requirements
### Requirement: Default release smoke costs no Claude model usage
The checkout SHALL provide a release smoke that verifies the enabled current HarnessDock record, matching installed snapshot, current Plugin minor version, exactly eight `$codex-harnessdock:*` Skills, one canonical-checkout in-process MCP bootstrap, exactly eight `codex_harnessdock` MCP tools, and successful isolated `list_agents` and fresh `list_harnesses` calls through the production isolated runtime path. MCP startup and the smoke SHALL NOT start an absent OpenCode Server or a Codex, Claude, Pi, OpenCode, or provider model turn. The smoke SHALL verify the current MCP generation, retained compatibility shells and known predecessor coverage, and SHALL reject concurrent legacy `cc_for_pein` discovery.

#### Scenario: Matching installation is ready
- **WHEN** the operator runs default release smoke after local refresh or versioned release
- **THEN** it exercises the installed snapshot, one-process MCP entry, dormant or live native route discovery, and MCP protocol successfully without model usage

#### Scenario: OpenCode is not running
- **WHEN** zero-cost smoke lists Harnesses and the fixed Server is absent
- **THEN** it uses bounded dormant diagnostics without starting the Server or a model turn

#### Scenario: OpenCode executable or service is unavailable
- **WHEN** zero-model smoke cannot prove a compatible dormant or live OpenCode route
- **THEN** it accepts the bounded unavailable OpenCode instance while still verifying the eight-tool contract and no model execution

#### Scenario: Installed current snapshot is stale
- **WHEN** installed current version or discovery content differs from the checkout
- **THEN** smoke fails before MCP execution and instructs the operator to run the appropriate local refresh

#### Scenario: Known predecessor is missing
- **WHEN** successful-install metadata names an unreconstructable previous version
- **THEN** smoke fails with actionable compatibility repair instead of accepting an empty shell set

### Requirement: Host-load smoke is isolated from production Agent state
The release smoke SHALL use a synthetic trusted root identity and temporary runtime home for its MCP call. It SHALL remove its temporary state after completion and SHALL NOT read, reconcile, acknowledge, interrupt, or modify production Agent state.

#### Scenario: Smoke calls list_agents
- **WHEN** the installed MCP bootstrap receives the synthetic task metadata
- **THEN** `list_agents` returns an empty isolated Agent view and production Plugin data remains unchanged

### Requirement: Paid smoke is explicit and fixed to Haiku low
An optional real-Claude extension SHALL require an explicit operator flag, SHALL announce `claude-haiku-4-5` with `low` effort before launch, SHALL use `write: false`, and SHALL run at most one bounded task. Subscription or quota exhaustion SHALL stop the paid smoke immediately.

#### Scenario: Real smoke is omitted
- **WHEN** the operator runs release smoke without the paid flag
- **THEN** no Claude model process is started

#### Scenario: Real smoke is requested
- **WHEN** the operator supplies the explicit paid flag
- **THEN** the smoke launches only one Haiku 4.5 low read-only turn and reports its terminal result

### Requirement: Release version has one manual source
`package.json` SHALL be the only manually maintained release base-version source. MCP server metadata and refreshed Plugin manifest base SHALL derive from it, while the Plugin manifest MAY append one Codex cachebuster suffix. Installation and release smoke SHALL fail when generated version expressions disagree.

#### Scenario: Package base version changes
- **WHEN** a maintainer updates the package version and refreshes the Plugin
- **THEN** MCP metadata and the Plugin manifest base report the new package version without another manual version edit

### Requirement: Paid release smoke is schema-current and regression tested without Claude usage
The optional paid Haiku/low release smoke SHALL exercise the current public MCP argument schema, and the repository SHALL verify that loop with a fake transport that consumes no Claude model quota.

#### Scenario: Zero-cost paid-loop regression
- **WHEN** the repository test suite executes the paid-smoke control flow against a fake MCP transport
- **THEN** it verifies schema-current spawn, wait, completion, and cleanup behavior without launching Claude

### Requirement: Native-team release acceptance is explicit and paid
Before releasing the native-team capability, the checkout SHALL run at most one
explicit real-Claude witness per user authorization, with no automatic paid
retry. The acceptance witness SHALL use a top-level `claude-opus-5` Driver turn with `low`
effort and `write: false` inside a dedicated disposable Git witness workspace,
not the source checkout. This witness SHALL invoke the same production
Driver/profile/adapter seam used by public Agents directly, not the public MCP
or detached-worker lifecycle, and SHALL claim only that narrower path. The
witness SHALL require one Haiku scout and one
Sonnet reviewer with explicit intended efforts, one current-team message,
and one successful parent synthesis. For Claude 2.1.227, teammate settle/idle
SHALL be reported as unobservable because native delivery is mailbox- and
optional-hook-based rather than a stable top-level stream event; the witness
SHALL NOT invent `system/teammate_*` events or claim the parent terminal proves
each teammate settled. A
witness-only in-process callback SHALL read only structured top-level
initialization/tool/team events needed to count the requested definitions,
teammate types/names, correlated asynchronous launches, successful validated
current-team transport, and
successful parent terminal synthesis; it SHALL not
persist prompts, message text, child transcripts, session IDs, or memory
content. It SHALL verify pinned requested models from the injected definitions
and SHALL report effective teammate models, effort, and cost as unknown unless
Claude emits an authoritative structured fact. The mutation gate SHALL permit
only `.claude/agent-memory-local/haiku-scout/**` and
`.claude/agent-memory-local/sonnet/**` native-memory maintenance and SHALL fail
on any other disposable-workspace mutation, including ignored paths. The source
checkout SHALL remain unchanged. If the production stream cannot expose a
required definition/spawn/message/terminal fact, the witness SHALL remain
unverified rather than trust assistant prose. A subscription,
allowance, credit, or quota-limit response SHALL stop all subsequent paid
Claude tests and SHALL leave the capability unverified rather than failed on
model quality.

#### Scenario: Native-team capability is ready to release
- **WHEN** all zero-cost tests pass and an explicit native-team witness is authorized
- **THEN** that authorization starts at most one Opus-low read-only production Driver turn in a disposable witness repository to prove the observable Driver/profile/adapter Native Agent Teams path before release without claiming paid MCP/detached-worker validation

#### Scenario: Witness observes repository mutation
- **WHEN** the read-only native-team witness changes task/workspace/repository state outside the two approved native local-memory paths
- **THEN** release acceptance fails and the changed state is reported without claiming read-only enforcement

#### Scenario: Native memory directory is eagerly created
- **WHEN** Claude creates or updates only an approved teammate memory directory during the witness
- **THEN** the witness records bounded path-level mutation evidence without reading contents and does not misclassify it as task-state mutation

#### Scenario: Native settle evidence is not a top-level stream fact
- **WHEN** the exact executable exposes teammate idle/completion only through native mailbox delivery or optional hooks
- **THEN** the witness reports settle as unobservable, does not invent a fake event, and scopes acceptance to the narrower observable path without claiming each teammate settled

#### Scenario: Claude account limit stops the witness
- **WHEN** the witness reports an explicit subscription or quota limit
- **THEN** no further paid model test starts and release evidence records the capability as not live verified

#### Scenario: Adapter vocabulary causes an observer false negative
- **WHEN** one authorized paid turn contains the required closed structured launch, named-message, and parent-terminal facts but the then-current Adapter rejects them because it expected an obsolete upstream status token
- **THEN** acceptance remains closed until the original false report is preserved, the raw-status translation is corrected test-first at the Adapter boundary, and a sanitized replay of those exact fact shapes passes through the production Adapter/witness controller; that same paid turn MAY then satisfy the live-path evidence without an automatic paid retry or reliance on assistant prose

### Requirement: Native-team paid loop is regression tested without Claude usage
The repository SHALL test the native-team paid witness control flow with a fake
Claude transport and the same witness-only in-process callback, including model definitions, cohort messages, the explicit unobservable-settle boundary, final
synthesis, ignored and non-ignored mutation checks, absent-evidence behavior,
and account-limit stop behavior, without consuming Claude quota. The fake
transport SHALL emit the same bounded structured event shape consumed from the
real stream and SHALL NOT invent production-only aggregate fields.

#### Scenario: Zero-cost team-witness regression runs
- **WHEN** the repository test suite exercises the native-team witness with fake Claude
- **THEN** it verifies the full control flow and expected failure branches without starting a real model

### Requirement: OpenCode Explorer live acceptance is explicit and bounded
Before releasing the experimental OpenCode capability, the checkout SHALL require a separate explicit live flag and SHALL announce the exact Harness/model/Agent/workspace before any model request. It SHALL run no more than the three specified read-only successes, using exact-session follow-up only when authoritative session/incarnation evidence is present and otherwise using the specified fresh-only substitute. It SHALL stop on account/auth/quota evidence and capture only the bounded evidence required by `opencode-explorer-runtime`. It SHALL neither install/launch the Server nor fall back automatically to Claude, another OpenCode model, direct provider API, or CLI attach.

#### Scenario: Live flag is omitted
- **WHEN** release smoke or the acceptance script runs without explicit authorization
- **THEN** no OpenCode session or model request is created

#### Scenario: Live acceptance is requested
- **WHEN** the operator supplies the exact flag with a prepared Server and disposable or approved repository
- **THEN** at most three route-fixed read-only examples run and the evidence report records pass, fail, or blocked without automatic retry beyond the specified matrix

### Requirement: OpenCode acceptance loop is regression tested without Server or model usage
The repository SHALL test the complete OpenCode acceptance controller against a fake SDK/Server transport, including route discovery, profile rejection, native acceptance, malformed output, metrics, mutation failure, exact follow-up, mixed-route projection, auth/quota stop, and report finalization, without a live Server or model request.

#### Scenario: Zero-cost acceptance regression runs
- **WHEN** `npm run check` executes the fake OpenCode acceptance suite
- **THEN** every control branch is verified with no network service or paid usage

### Requirement: Runtime and model-context optimization acceptance stays evidence-bounded
Acceptance SHALL verify one-process MCP startup, demand-driven OpenCode startup, one-hour idle eligibility, active/unknown lease protection, owned-only termination, preserved durable state, and the declared model-visible size budgets with deterministic zero-model tests. Resource evidence SHALL report process counts and Linux PSS separately and SHALL NOT sum RSS as unique physical memory. Token evidence SHALL report stable control-text sizes plus provider-reported input, cache-read, cache-write, output, and reasoning fields separately; it SHALL NOT infer cost or token avoidance from elapsed time, service reuse, or a cache flag.

#### Scenario: Deterministic acceptance runs
- **WHEN** focused tests and `npm run check` execute
- **THEN** they prove lifecycle and context-budget branches without starting a Harness model and leave no test-owned service or supervisor process behind

#### Scenario: Live OpenCode smoke is explicitly authorized
- **WHEN** the operator requests the final live witness after zero-model gates pass
- **THEN** acceptance runs at most one `openai/gpt-5.6-luna` low-effort bounded turn, reports its native usage fields without derived savings, and performs no automatic paid retry

#### Scenario: Static context shrinks but a safety fact disappears
- **WHEN** size budgets pass while an exact-route, authority, lifecycle, delivery, or fail-closed invariant is absent from the installed guidance
- **THEN** release acceptance fails despite the smaller text
