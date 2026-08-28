## Purpose

Define attach-only experimental OpenCode routes discovered from the operator-owned Server's current `/provider` catalog, with caller-stated exact model and variant effort, native agent/configuration ownership, launch/session/turn evidence, result/usage normalization, and staged acceptance.

## Requirements
### Requirement: OpenCode attaches only to an operator-owned loopback Server
The OpenCode Driver SHALL attach as a pinned network client to one statically configured loopback OpenCode Server. It SHALL NOT install OpenCode, start/stop/restart a Server, use the TUI, dispose an instance, perform login, mutate provider/configuration state, bind a non-loopback address, or call an underlying model provider directly. Readiness SHALL validate Server/client compatibility, the current workspace, the configured Explorer profile, and the discovered exact model route without starting a model turn.

#### Scenario: Server is ready
- **WHEN** the fixed loopback Server is healthy and exposes the accepted client contract, Explorer profile, and exact model route for the current workspace
- **THEN** readiness reports one experimental logical instance with `liveValidated: true` and no model request

#### Scenario: Server is unavailable or non-loopback
- **WHEN** the endpoint cannot be reached, fails authentication, or resolves outside loopback
- **THEN** only the OpenCode logical instance is unavailable and no Plugin action starts, repairs, or reconfigures it

### Requirement: OpenCode credentials never cross the secret boundary
Optional Basic-auth username/password SHALL be read only from the operator process environment through an exact Driver allowlist and used only at the fixed loopback origin. Passwords, authorization values, and private auth configuration SHALL NOT be written to the repository, prompt, logs, errors, instance keys, readiness receipts, Agent/job/attempt records, native references, metrics, completion messages, or model-facing Harness listings.

#### Scenario: Authentication fails
- **WHEN** the Server rejects the configured credentials
- **THEN** readiness returns a closed sanitized authentication failure without echoing the username, password, header, or credential-bearing endpoint

### Requirement: The first OpenCode route is discovered, exact, and read-only
Before route admission, the compatibility probe SHALL confirm the full DeepSeek V4 Flash identifier independently through the installed CLI catalog and Server/client discovery. The initial Driver SHALL then admit only Harness `opencode`, that exact full model identifier, topology `leaf`, `behavioral_read_only` authority, and `noninteractive_fixed_policy`. It SHALL reject omitted route fields, aliases, another model/provider, native orchestration, write authority, unproven reasoning effort, interactive approval, dynamic tool overrides, and more than one active turn before session creation or prompt admission.

#### Scenario: Intended identifier is confirmed exactly
- **WHEN** both local discovery surfaces report `opencode-go/deepseek-v4-flash` and the configured profile admits it
- **THEN** the Driver may freeze that exact route and its experimental capability snapshot

#### Scenario: Actual identifier differs
- **WHEN** installed discovery reports another provider/model string or inconsistent catalogs
- **THEN** admission stops for a specification update without aliasing, inference, or model substitution

#### Scenario: OpenCode write is requested
- **WHEN** `write: true` is supplied with Harness `opencode`
- **THEN** spawn fails before Plugin Agent, OpenCode session, message, or model usage is created

### Requirement: Explorer profile permits only bounded repository research
Readiness SHALL require a resolved `codex-explorer` profile whose effective configuration denies file edits, shell, task/subagent launch, external-directory access, web access, skill loading, deployment, publication, interactive approval, and unknown custom/MCP tools while allowing only reviewed repository read/list/glob/search/LSP inspection. Every prompt SHALL repeat the supported no-mutation/no-delegation boundary. The Driver SHALL report actual enforcement and SHALL NOT call it an OS sandbox.

#### Scenario: Profile is missing or wider than admitted
- **WHEN** the Server lacks the profile or exposes a forbidden effective tool, permission, or approval path
- **THEN** readiness fails before model execution rather than silently using Build, Plan, or another Agent

#### Scenario: Explorer attempts a forbidden capability
- **WHEN** the native Harness reports a denied mutation, shell, delegation, external, web, skill, deployment, publication, custom/MCP, or approval request
- **THEN** the turn fails with bounded evidence and the Plugin grants no permission

### Requirement: Explorer prompt and result stay narrow and Harness-neutral
The Driver SHALL construct each turn from one versioned stable authority/topology/return prefix, the caller's bounded task message, the canonical workspace identity, and fixed no-modification constraints. The prefix MAY ask for concise relevant paths, evidence, unknowns, and next checks but SHALL NOT impose task decomposition, methodology, cross-worker synthesis, or a universal repository JSON ontology. Success SHALL return exactly one matching nonempty bounded outer-assistant final text plus optional closed Driver metadata; malformed lineage, empty/oversized output, native tool/event history, or terminal UI output SHALL not be projected as success.

#### Scenario: Valid Explorer result arrives
- **WHEN** the exact matching assistant response contains one nonempty bounded final text
- **THEN** the Driver projects it as the final Agent result without exposing native tool history

#### Scenario: Caller needs a task-specific format
- **WHEN** Codex includes that return request in the task message
- **THEN** OpenCode may follow it, but the shared runtime does not parse, repair, or promote that format into a global contract

### Requirement: Launch, session, and turn evidence are separate and replay-safe
Before native submission, the supervisor SHALL persist a launch claim/attempt with the immutable route, input identity/digest, and leases. A new Plugin Agent SHALL create a fresh OpenCode session and persist a secret-free `NativeSessionRef` only after exact session binding is proven. Every prompt SHALL persist a separate `NativeTurnRef` only after the exact session/user-message/attempt/provider/model lineage proves native acceptance. A local error or lost worker that may have occurred after submission but before that proof SHALL produce unknown acceptance, retain capacity, publish no completion, and trigger no replay, fallback, replacement session, or automatic recovery.

#### Scenario: Session exists but prompt acceptance is ambiguous
- **WHEN** the Driver can validate the session but cannot determine whether the exact user message was accepted
- **THEN** the attempt remains acceptance-unknown and the session reference does not prove turn acceptance

#### Scenario: Failure is proven before transport
- **WHEN** the Driver proves no native prompt request left the process
- **THEN** the attempt records not-submitted/rejected without consuming provider work or fabricating a native turn

### Requirement: Native terminal evidence is exact and first-release restart observation is unavailable
The process-local LiveTurn SHALL be owned by the original pinned blocking prompt request. Terminal success SHALL require that request to settle with matching session/parent/provider/model/attempt, coherent assistant finish/error evidence, and a valid final result. `prompt_async` acceptance, HTTP 204, session status, health, Server PID, elapsed silence, or origin equality SHALL NOT prove acceptance or terminal settlement. The initial Driver SHALL expose no `observeTurn`; worker/connection loss after possible acceptance remains unknown.

#### Scenario: Blocking request returns matching result
- **WHEN** exact turn lineage, coherent terminal evidence, and the bounded final result all validate
- **THEN** the Driver may publish one completed terminal result and release matching capacity

#### Scenario: Worker disappears after possible acceptance
- **WHEN** the original live request can no longer produce authoritative terminal evidence
- **THEN** no completion is published, capacity remains held, and the runtime does not query status/abort as a substitute observer

### Requirement: OpenCode continuation requires authoritative session incarnation binding
Each new Plugin Agent SHALL own a fresh native session. Terminal same-Agent follow-up SHALL reuse that session only when the pinned compatibility evidence can prove the original exact session binding and authoritative Server/session incarnation across isolated calls. A digest of the loopback origin, a bare session ID, or an uncorrelated transcript SHALL be insufficient. If such proof is unavailable, the route SHALL declare `fresh_only`; Codex SHALL create a new Agent for later work. Session deletion, sharing, forking, adoption, cross-Agent, and cross-root reuse SHALL remain unavailable.

#### Scenario: Incarnation and session binding are proven
- **WHEN** the terminal Agent's native session can be revalidated against the original authoritative binding and immutable route
- **THEN** an exact same-Agent follow-up may create a new turn in that session

#### Scenario: Server restart or binding uncertainty exists
- **WHEN** incarnation/binding evidence is absent, changed, or ambiguous
- **THEN** follow-up fails before mailbox or native mutation and a new Agent is required

### Requirement: Initial optional operations fail honestly
The initial OpenCode snapshot SHALL declare active input, native history, public interrupt, restart observation, automatic recovery, native orchestration, approval brokerage, and write authority unsupported. `send_message` MAY queue a message but SHALL not claim active delivery. `followup_task` SHALL obey the route's proven `exact_resume` or `fresh_only` continuation. `interrupt_agent` and `read_agent_messages` SHALL return explicit unsupported results without calling abort, status, events, or native transcript APIs.

#### Scenario: Active OpenCode Agent receives follow-up
- **WHEN** the current turn has not settled and active input is unsupported
- **THEN** follow-up rejects before mailbox mutation rather than promise queued activation

#### Scenario: Interrupt is requested
- **WHEN** the initial OpenCode route is active
- **THEN** the Plugin reports unsupported and does not treat abort/status as proven settlement

### Requirement: OpenCode metrics preserve provider and route provenance
The Driver SHALL select only non-negative finite numeric facts from the matching pinned assistant schema: provider/model identity, reported cost, input tokens, output tokens, reasoning tokens, cache-read tokens, and cache-write tokens. It SHALL store them with provider-reported provenance and root/Agent/turn/attempt/Harness/instance/Driver/capability lineage. It SHALL NOT calculate subscription charge, infer uncached tokens/cache hit/prices/savings, merge same-model different-Harness records, or conflate persistent Server reuse with provider prompt caching.

#### Scenario: Assistant message reports cache tokens
- **WHEN** cache read/write values are present and valid
- **THEN** the completion carries those exact values independently from process/Server reuse evidence

#### Scenario: Usage field is absent or malformed
- **WHEN** a field is missing, negative, non-finite, string-shaped, or unexpected
- **THEN** it remains unknown/rejected without copying the raw usage object or deriving a replacement

### Requirement: Experimental acceptance uses three varied real successes
Experimental release acceptance SHALL require deterministic/installed tests plus three explicitly authorized real read-only successes through the loaded production Plugin: one fresh architecture exploration; one exact-session terminal follow-up only when incarnation proof exists, otherwise a second fresh Agent proving fresh-only behavior; and one mixed Claude/OpenCode root or documented fresh substitute. Each success SHALL capture compatibility/route/profile facts, attempt/session/turn lineage, latency, exact metrics, Server-reuse facts, before/after mutation witness, result, and bounded Codex verification. Zero unapproved mutation is mandatory. Account/quota/auth failure SHALL stop further live calls without route substitution.

#### Scenario: Three varied successes pass
- **WHEN** each required production-shaped turn completes with valid lineage/result, verifiable sampled findings, route-qualified metrics, and zero unapproved mutation
- **THEN** the Driver may be labelled experimental for dogfooding through a separately authorized promotion

#### Scenario: Only two successes pass
- **WHEN** deterministic tests pass but fewer than three real examples satisfy the contract
- **THEN** the capability remains unreleased without claiming general reliability

### Requirement: Maturity evaluation remains separate from release acceptance
Twenty-task reliability, one/two/four concurrency, idle/Server-crash recovery, separate-session versus reused-session cache benchmark, a real-workday cost comparison, interrupt/history enablement, and implementation-worker safety SHALL remain later field evidence/changes. The report SHALL distinguish measured facts, unavailable telemetry, sampled correctness, and recommendation, and SHALL never infer cache hits or cost avoidance from wall-clock speed alone.

#### Scenario: Experimental release has three examples
- **WHEN** the initial gate passes without the maturity benchmark
- **THEN** the report labels missing measurements pending and does not convert them into assumed GO evidence
