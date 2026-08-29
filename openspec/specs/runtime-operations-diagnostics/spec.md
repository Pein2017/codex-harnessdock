# runtime-operations-diagnostics Specification

## Purpose

Define redacted, read-only operator health and storage diagnostics without expanding the model-facing Agent API.
## Requirements
### Requirement: One operator doctor reports actionable health
The checkout SHALL provide one Linux operator command that evaluates checkout identity, installed Plugin parity, required Node dependencies, Claude CLI availability and static compatibility, Claude authentication, the fixed config/proxy envelope, exactly seven MCP tools, and storage health. Each check SHALL return a stable identifier, bounded status, redacted summary, and actionable recovery when failed. The command SHALL NOT be exposed through Plugin Skills or MCP tools.

#### Scenario: All required surfaces are healthy
- **WHEN** the operator runs doctor from the canonical checkout with the matching Plugin installed
- **THEN** it exits successfully and reports every required check as passed or advisory

#### Scenario: Required dependency is absent
- **WHEN** the MCP SDK or Zod cannot be resolved from the canonical checkout
- **THEN** doctor fails with an instruction to run `npm install` in `/data/CoordExp/codex-harnessdock`

### Requirement: Diagnostic output is redacted and read-only
Doctor SHALL NOT expose credentials, email, organization identity, raw authentication output, proxy credentials, arbitrary environment values, message bodies, prompts, or Claude session contents. It SHALL NOT reconcile lifecycle state, acknowledge completion, prune jobs, acquire a session lease, launch a model, or otherwise mutate Agent/runtime/Claude state.

#### Scenario: Auth status contains private identity
- **WHEN** Claude returns authentication metadata including account or organization fields
- **THEN** doctor reports only bounded login/method/provider/subscription facts and omits private identity fields

#### Scenario: Runtime state is malformed
- **WHEN** storage diagnosis encounters an unreadable or invalid control record
- **THEN** it counts the malformed artifact as a warning without rewriting or deleting it

### Requirement: Storage inventory separates runtime and Claude retention
Doctor SHALL report aggregate Agent registry, job status, completion inbox, runtime artifact, and Claude session-history facts. Cleanup candidates SHALL be dry-run only and limited to conservative Plugin-owned stale temporary/reservation artifacts and terminal job receipts beyond the existing retention boundary. Claude history SHALL be reported separately under a 30-day observation window and SHALL never appear in Plugin cleanup candidates.

#### Scenario: Old Claude history exists
- **WHEN** Claude session JSONL artifacts are older than 30 days
- **THEN** doctor reports their count and age without marking, moving, truncating, or deleting them

#### Scenario: Excess terminal Plugin jobs exist
- **WHEN** an owner bucket contains more than 100 terminal job receipts
- **THEN** doctor reports the oldest excess receipts as dry-run cleanup candidates without deleting them

### Requirement: Doctor describes authentication evidence without overstating liveness
The zero-model-cost operator doctor SHALL report whether the fixed Claude credential is present, locally expired, or unavailable and SHALL explicitly report `liveValidated: false` for metadata-only authentication checks. Credential presence MAY remain a passing readiness fact when the host CLI can perform its own refresh, while local expiry SHALL be visible as bounded advisory evidence. Doctor SHALL NOT launch Claude print mode, refresh credentials, mutate the credential store, or claim that a provider request succeeded.

#### Scenario: Auth status reports logged in
- **WHEN** `claude auth status --json` reports a logged-in Claude account and the fixed credential record is readable
- **THEN** doctor reports bounded method/provider/subscription facts, local credential state, and `liveValidated: false` instead of “authentication is active”

#### Scenario: Local access token has expired
- **WHEN** the fixed native credential record has an access expiry at or before the doctor observation time
- **THEN** doctor reports the credential as locally expired or refreshable advisory evidence without exposing secrets or performing a model call

#### Scenario: Diagnostic output is persisted or shared
- **WHEN** doctor output is rendered as text or JSON
- **THEN** it contains no token, token hash, raw credential path content, account identity, organization identity, or arbitrary native auth output

### Requirement: Doctor reports bounded native-tool drift evidence
Doctor SHALL report the configured forbidden-tool policy and the latest bounded
production initialization inventory for each delegation mode and executable
fingerprint when such evidence exists. It SHALL fail a mode whose latest
inventory contains a forbidden tool, warn on unknown non-forbidden names, and
report `denySetLiveValidated: false` when no matching production observation
exists. That field SHALL describe only the reviewed deny set, not universal
containment. For an orchestrator it SHALL separately report whether all three
injected definitions and necessary coordination tool names were observed, and
whether correlated launch-and-message evidence produced
`teamTransportLiveValidated: true`. Doctor SHALL
NOT launch a model to obtain inventory and SHALL NOT expose tool inputs,
prompts, outputs, session identity, member roster, or memory content.

#### Scenario: Matching live evidence is clean
- **WHEN** the latest production observation for an executable fingerprint contains no mode-forbidden tool
- **THEN** doctor reports `denySetLiveValidated: true` and lists only bounded tool-name facts without making a universal safety claim

#### Scenario: No production inventory exists
- **WHEN** static CLI compatibility passes but no matching initialization inventory has been retained
- **THEN** doctor reports the mode as statically compatible with `denySetLiveValidated: false`

#### Scenario: Unknown tool appears
- **WHEN** retained initialization evidence includes a non-forbidden name outside the reviewed baseline
- **THEN** doctor emits an advisory drift warning without declaring the executable incompatible

#### Scenario: Injected definition is absent
- **WHEN** the latest orchestrator observation omits one required teammate definition
- **THEN** doctor reports the native team surface incompatible even if the reviewed deny set itself is clean

#### Scenario: No validated current-team transport exists
- **WHEN** init names are clean but no asynchronous named member launch plus successful correlated `SendMessage` has been observed
- **THEN** doctor reports the native transport as live-unverified rather than inferring Agent Teams from tool names or launch status alone

### Requirement: Doctor reports active-task discovery coverage
Doctor SHALL compare bounded successful-install coverage metadata, the durable
discovery archive, and restored Codex Cache shells without reading arbitrary
historical runtime content. It SHALL report the current installed version, the
known predecessor when one exists, retained versions, archive validity, and
whether active-task discovery coverage is complete. Zero retained shells SHALL
pass only when no distinct predecessor is known; a missing known predecessor
SHALL fail with an instruction to run the local compatibility repair or refresh
path. Diagnostic output SHALL remain read-only and SHALL NOT repair, install, or
delete Plugin state.

#### Scenario: Known predecessor is retained
- **WHEN** the last successful installed version differs from the current version and a valid restored shell exists for it
- **THEN** doctor reports active-task discovery coverage complete

#### Scenario: Known predecessor is missing
- **WHEN** bounded coverage metadata names a distinct predecessor that is absent or invalid in the restored Cache
- **THEN** doctor fails the compatibility-shell check and reports the exact bounded version identifier plus an operator recovery command

#### Scenario: First-install coverage is explicit
- **WHEN** no predecessor has been recorded
- **THEN** doctor reports coverage unavailable or first-install rather than claiming that zero shells protect older active tasks

#### Scenario: Archive contains non-whitelisted content
- **WHEN** a durable discovery archive contains a path outside the compatibility whitelist or a bootstrap that does not route exclusively to the canonical checkout
- **THEN** doctor reports the archive invalid without opening or executing that content

### Requirement: Doctor reports bounded fresh native-route discovery
The read-only operator doctor SHALL report bounded, redacted current Pi and OpenCode discovery status, including route availability, discovery freshness, exact model-specific effort choices, OpenCode service readiness and managed/reused status, and closed Pi configuration or RPC failure reasons. Doctor SHALL NOT launch a model, start, stop, repair, or reconfigure a native Harness, acquire the OpenCode service ownership fence, expose endpoints, executable/configuration paths, credentials, plugins, MCP servers, tools, prompt templates, or arbitrary provider fields.

#### Scenario: Managed or reused OpenCode is available
- **WHEN** doctor can inspect a compatible fixed-origin Server without mutation
- **THEN** it reports bounded service and route availability without claiming model liveness or changing ownership state

#### Scenario: Pi configuration is missing
- **WHEN** the canonical environment does not provide a valid `PI_CODING_AGENT_DIR`
- **THEN** doctor reports the closed redacted missing-configuration reason instead of the catch-all `unknown`

#### Scenario: Native route discovery fails
- **WHEN** Pi RPC discovery or the current OpenCode service cannot prove a bounded route
- **THEN** doctor returns an actionable redacted unavailable, ambiguous, drift, executable, or protocol result without repairing or changing configuration
