# claude-session-execution Specification

## Purpose

Define Claude Code headless transport, execution profiles, session capture, and exact-session continuation.
## Requirements

### Requirement: Claude runs through the headless streaming protocol
The runtime SHALL execute only a statically admitted Claude executable, using
print mode, stream-json input and output, verbose partial messages, and hook
events so that prompts, steering, session identity, output, tool use, and
terminal receipts can be tracked. Each attempt SHALL retain the prepared
executable fingerprint and record the runtime-reported Claude Code version.

#### Scenario: A tracked turn starts
- **WHEN** the supervisor launches a Claude attempt
- **THEN** the initial prompt is written through stdin and stream events are parsed into bounded runtime receipts

#### Scenario: A tracked turn completes
- **WHEN** Claude reports a terminal success for the admitted executable
- **THEN** the turn receipt records both its prepared compatibility fingerprint and runtime-reported Claude Code version

### Requirement: Account-limit exhaustion is terminal and non-fallback
The runtime SHALL classify explicit native Claude subscription, usage, credit, weekly/monthly, session-capacity, or quota-limit exhaustion as `usage_or_subscription_limit`. It SHALL expose the terminal failure without automatic reconnect or model fallback. Terminal result error strings SHALL participate in classification so a structured Claude error cannot be hidden by an empty final message. The classification SHALL use native failure evidence and SHALL NOT treat successful assistant prose that merely discusses a session limit as an account failure.

#### Scenario: Structured result reports a periodic usage limit
- **WHEN** Claude exits with a terminal result whose errors state that a weekly, monthly, subscription, usage, credit, or quota limit is exhausted
- **THEN** the attempt fails as `usage_or_subscription_limit` and the supervisor performs no reconnect

#### Scenario: Native result reports the Claude session limit
- **WHEN** native Claude failure evidence states `You've hit your session limit` and may include a reset time
- **THEN** the attempt fails as `usage_or_subscription_limit` and public blocking becomes account-scoped operator intervention without a new-Agent retry

#### Scenario: Successful assistant discusses a session limit
- **WHEN** a successful final assistant message mentions `session limit` without matching stderr, warning, terminal-error, failed-result, or exit evidence
- **THEN** the job is not classified as account-limit exhaustion

#### Scenario: Limit text also contains HTTP 429
- **WHEN** explicit account-exhaustion text is accompanied by HTTP 429
- **THEN** permanent account-limit classification takes precedence over transport retry

#### Scenario: Generic transport rate limit is transient
- **WHEN** an attempt reports HTTP 429 without explicit subscription, usage, credit, periodic, session-capacity, or quota exhaustion
- **THEN** the existing bounded transport-recovery policy remains applicable

#### Scenario: Rate limit mentions a usage tier
- **WHEN** HTTP 429 reports a request or rate limit for the current usage tier and provides retry guidance without saying account capacity is exhausted
- **THEN** the failure remains eligible for bounded exact-session transport recovery

#### Scenario: User-directed wording names a rate or request limit
- **WHEN** HTTP 429 says the caller has hit, reached, or exceeded a rate limit or request limit and provides retry guidance
- **THEN** the failure remains eligible for bounded exact-session transport recovery rather than being treated as account-capacity exhaustion

#### Scenario: Billing-period allowance is exhausted
- **WHEN** Claude explicitly reports that the current period allowance or billing-period limit is exhausted or reached
- **THEN** the attempt fails as `usage_or_subscription_limit` and the supervisor performs no reconnect

#### Scenario: Caller-imposed command budget is exhausted
- **WHEN** Claude reports `error_max_budget_usd` or otherwise identifies that the caller's `--max-budget-usd` ceiling was reached, even if its prose contains "usage limit"
- **THEN** the attempt terminates without being classified as subscription or usage exhaustion

### Requirement: Safe execution profile applies explicit safeguards
The explicit opt-in safe profile SHALL apply the runtime-owned sandbox and permission policy and SHALL restrict tools for read-only work unless the caller supplies an explicit allowed-tool set. It SHALL still require the caller-selected supported model inherited from the Agent request.

#### Scenario: Read-only safe task starts
- **WHEN** a caller starts a safe task without write access or explicit allowed tools
- **THEN** Claude receives the read-only sandbox settings, bounded read-only tool policy, and caller-selected supported model

### Requirement: Runtime appends a bounded delegation envelope
Every public Claude turn SHALL receive a runtime-owned
`--append-system-prompt` envelope without replacing Claude's native system
prompt. The common envelope SHALL identify the turn as a bounded delegation
from the Codex lead, preserve the supplied task/workspace boundary, state the
current activation's write intent as behavioral authority, assign user-facing
synthesis and final acceptance to Codex, require one self-contained result,
and require an exact blocker question with evidence when a reserved decision is
needed. False write intent SHALL forbid task/workspace/repository/external
mutation except explicitly identified native local-memory maintenance; true
write intent SHALL permit only task-scoped mutation. Every mode SHALL emit the
reviewed deny list for `Workflow`, machine-global discovery, scheduled/routine
wakeups, user/notification delivery, and native worktree switching. Leaf mode
SHALL additionally deny `Agent` and `SendMessage`. Orchestrator mode SHALL make
the Native Agent Teams coordination surface available only under the approved
team contract, require named pinned teammate definitions and disjoint write
surfaces, forbid isolation/forks/cross-session recipients in the prompt, and
require the lead to join, verify, and synthesize the team. The envelope SHALL
label prompt-governed recipient, role, write, team-size, and cost budgets as
behavioral rather than process-enforced.

#### Scenario: Read-intent leaf turn starts
- **WHEN** an Agent activates in leaf mode with `write: false`
- **THEN** Claude receives the common read-only behavioral instruction and leaf instruction plus hard native delegation, Workflow, and SendMessage tool denials

#### Scenario: Write-intent leaf turn starts
- **WHEN** an eligible non-Haiku Agent activates in leaf mode with `write: true`
- **THEN** Claude receives task-scoped mutation authority and the same leaf containment boundary

#### Scenario: Native team lead starts
- **WHEN** an eligible Opus or Fable Agent activates in `claude_orchestrator` mode
- **THEN** Claude receives the current authority and explicit experimental Native Agent Team instructions while Workflow, machine-global discovery, isolation, forks, and cross-session recipients remain forbidden by the stated enforcement layer

#### Scenario: Fable orchestrator starts
- **WHEN** a `claude-fable-5` Agent activates in `claude_orchestrator` mode
- **THEN** Claude receives the current authority and explicit experimental Native Agent Team instructions with the same reviewed enforcement boundaries

#### Scenario: Lead-owned decision blocks progress
- **WHEN** Claude cannot continue without a decision reserved to the Codex lead or user
- **THEN** the envelope instructs Claude to end the turn with the precise question and supporting evidence so the same durable Claude Agent can receive a follow-up

#### Scenario: Leaf transport reconnects
- **WHEN** bounded transport recovery reconnects a leaf job in the exact parent Claude session
- **THEN** the same delegation mode, tool denials, authority, and leaf envelope are reconstructed from durable job evidence

#### Scenario: Exact job reconnects
- **WHEN** bounded transport recovery reconnects the same leaf Agent job
- **THEN** the same delegation mode, tool denials, authority, and leaf envelope are reconstructed from that durable job evidence

#### Scenario: Native team transport closes
- **WHEN** an orchestrator process loses transport while native teammates may still have in-process state
- **THEN** the runtime does not automatically reconnect that same team turn and instead preserves the parent session evidence for a later explicit follow-up that forms a fresh team

#### Scenario: Follow-up changes write intent
- **WHEN** a follow-up activates the same parent Claude session with a new explicit write intent
- **THEN** the new job receives a fresh native team and envelope for the new intent without changing durable Claude Agent identity

#### Scenario: Native Claude customizations exist
- **WHEN** hooks, memories, skills, plugins, Serena MCP, or other native configuration is enabled
- **THEN** the runtime appends its bounded envelope rather than replacing or disabling Claude's native system and configuration sources

### Requirement: Default terminal-parity profile preserves native configuration with full access
The model-facing terminal-parity profile SHALL inherit Claude settings, hooks,
memories, skills, plugins, MCP configuration, and native tools while requiring
an explicit supported model and explicit spawn write intent. Before launch it
SHALL set the effective `CLAUDE_CONFIG_DIR`, `IS_SANDBOX=1`, force native Auto
Memory enabled after env-file resolution, and use
`--dangerously-skip-permissions` for both authority values. It SHALL NOT add a
general allowed-tool list, model fallback, settings, MCP, or
replacement-system-prompt override. It SHALL add only the runtime-owned
delegation/team envelope, mode-specific deny list, and orchestrator-only
session-local teammate definitions and fixed environment. The orchestrator
environment SHALL enable Native Agent Teams, remove an inherited
`CLAUDE_CODE_SUBAGENT_MODEL` override so pinned definitions own requested
models, set one child layer as a hard boundary, and set the reviewed concurrency
value only as a residual guard on the forbidden ordinary-subagent path, not as
a native-team host hint. The profile SHALL describe write authority, Haiku
read-only behavior, teammate recipients, and team budgets by their actual
enforcement strength.

#### Scenario: Read-intent leaf Agent starts
- **WHEN** `spawn_agent` supplies a valid supported model with `write: false`
- **THEN** Claude receives the selected config, full-access process envelope, explicit parent model, leaf behavioral envelope, no general allow-list, and no native teammate definitions or Agent Teams flag

#### Scenario: Read-intent Agent starts
- **WHEN** `spawn_agent` supplies a valid supported leaf model with `write: false`
- **THEN** Claude receives the selected config, full-access process envelope, explicit parent model, read-only behavioral envelope, and no general allow-list

#### Scenario: Write-intent leaf Agent starts
- **WHEN** `spawn_agent` supplies an eligible model with `write: true`
- **THEN** Claude receives the same terminal-parity process envelope with task-scoped mutation authority and no native teammate definitions or Agent Teams flag

#### Scenario: Write-intent Agent starts
- **WHEN** `spawn_agent` supplies an eligible leaf model with `write: true`
- **THEN** Claude receives the same full-access process envelope with task-scoped mutation authority and no general allow-list

#### Scenario: Native Claude customizations are configured
- **WHEN** the selected Claude config enables hooks, Serena MCP, memories, plugins, or skills
- **THEN** terminal parity leaves those sources enabled instead of replacing them with runtime-owned settings

#### Scenario: Native team lead starts
- **WHEN** terminal parity activates an explicit Opus or Fable orchestrator
- **THEN** the profile injects only the three sanctioned teammate definitions, sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, removes a conflicting subagent-model environment override, sets the hard depth boundary and residual ordinary-subagent concurrency guard, and applies the team-lead deny list without a general allow-list

#### Scenario: Fable orchestrator uses native subagents
- **WHEN** terminal parity activates an explicit Fable orchestrator
- **THEN** the profile forms the bounded Native Agent Team, keeps `Workflow` denied, and applies no general native-tool allow-list

#### Scenario: Later orchestrator turn resumes the parent Claude session
- **WHEN** a follow-up activates a durable orchestrator in the exact parent session
- **THEN** the runtime supplies a new job-derived team identity while retaining the same three stable member types and native local memories without restoring prior in-process teammates

#### Scenario: Operator safe profile is selected
- **WHEN** an explicit operator/debug path selects the safe profile
- **THEN** safe behavior remains internal and is not exposed as a model-facing activation choice

### Requirement: Initial Agent sessions have an explicit Claude display name
The runtime SHALL pass the durable Agent name through Claude's `--name` option when creating a new session, so Claude Code does not need an auxiliary model to generate an automatic title. Exact-session resumes SHALL retain the existing session identity without renaming it.

#### Scenario: Initial Agent turn starts
- **WHEN** a new Agent turn creates a fresh Claude session
- **THEN** Claude receives the Agent name through `--name` together with the selected canonical `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, or `claude-fable-5` model

#### Scenario: Exact session resumes
- **WHEN** a follow-up resumes an existing Claude session
- **THEN** the runtime uses the exact session ID without adding a new `--name`
  argument

### Requirement: Dangerous permission bypass is constrained
The terminal-parity profile SHALL always apply dangerous permission bypass and SHALL NOT combine it with an explicit permission mode. The safe profile SHALL reject dangerous permission bypass. Write intent SHALL NOT enable or disable the terminal-parity bypass.

#### Scenario: Terminal-parity read intent starts
- **WHEN** a caller starts an Agent with false write intent
- **THEN** the runtime selects terminal-parity with dangerous permission bypass and a read-only behavioral prompt

#### Scenario: Terminal-parity write intent starts
- **WHEN** a caller starts an Agent with `write: true`
- **THEN** the runtime selects terminal-parity with dangerous permission bypass and a task-scoped mutation prompt

#### Scenario: Explicit permission mode conflicts with terminal parity
- **WHEN** a terminal-parity caller supplies an explicit permission mode
- **THEN** the runtime rejects the request before launching Claude

#### Scenario: Dangerous bypass is requested in safe mode
- **WHEN** a caller combines dangerous permission bypass with the safe profile
- **THEN** the runtime rejects the request before launching Claude

### Requirement: Claude session identity is captured and resumable
The runtime SHALL preserve Claude Code session persistence by default, capture the Claude session ID from protocol events or results, and use `--resume` with that exact ID for recovery or follow-up.

#### Scenario: New Claude session completes
- **WHEN** Claude reports a session ID during a new tracked job
- **THEN** the job receipt stores that Claude session ID independently from the Codex owner session ID

#### Scenario: Exact-session follow-up starts
- **WHEN** a caller follows up on a resumable terminal job
- **THEN** the new attempt invokes Claude with the recorded Claude session ID and rejects observed session drift

### Requirement: Session ownership is sequential
The runtime SHALL prevent concurrent plugin workers from owning the same canonical `CLAUDE_CONFIG_DIR` and Claude session ID.

#### Scenario: A second worker requests an actively leased session
- **WHEN** a session lease is held by another active plugin job
- **THEN** the second request fails without launching a competing Claude owner

### Requirement: Claude Code Driver extraction preserves established execution semantics
The `claude-code` Harness Driver SHALL compose the established Claude Code
execution, environment, profile, compatibility, stream-json, steering,
session, history, interruption, and recovery owners behind a bumped Driver
contract version. It SHALL preserve supported model/effort admission, fixed
terminal-parity environment, dangerous permission bypass, prompt-level write
intent, universal Workflow denial, leaf Agent/SendMessage denial, exact-session
drift rejection, usage-limit classification, native customizations, completion
content, and public lifecycle receipts. It SHALL replace the old Fable-only
one-generation orchestration with the explicit Opus/Fable Native Agent Team
contract and SHALL fail closed across old/new prepared-job or rollback version
mismatches.

#### Scenario: Existing Claude leaf Agent runs after extraction
- **WHEN** the unchanged public API starts any valid route in leaf mode
- **THEN** the same admitted command, fixed environment, stream protocol, prompt/tool envelope, native configuration, receipts, session binding, and terminal result are produced through the bumped Claude Code Driver

#### Scenario: Opus or Fable team lead runs after extraction
- **WHEN** the unchanged public API starts exact Opus or Fable in `claude_orchestrator` mode
- **THEN** Workflow remains denied, the experimental native team envelope is reproduced, and only the outer Claude turn becomes the durable Harness result

#### Scenario: Existing Fable orchestrator runs after extraction
- **WHEN** the unchanged public API starts `claude-fable-5` in `claude_orchestrator` mode
- **THEN** Workflow remains denied, the experimental native team envelope is reproduced, and only the outer Claude turn becomes the durable Harness result

#### Scenario: Old prepared job meets new Driver
- **WHEN** a job prepared under the previous Driver version is discovered after hot refresh or promotion
- **THEN** the new Driver refuses to launch it rather than reconstruct the job under materially different orchestration semantics

#### Scenario: New prepared job meets rolled-back Driver
- **WHEN** rollback exposes a job prepared under the bumped Driver version to the old Driver
- **THEN** the old Driver refuses to launch it while safe interrupt/process-control paths remain available

#### Scenario: Active steering is acknowledged after extraction
- **WHEN** a running Claude parent turn receives a valid active message
- **THEN** the Driver preserves the current dispatch, acknowledgement, ordering, and recovery semantics rather than reducing the message to an unproven generic capability

#### Scenario: Claude history is read after extraction
- **WHEN** the root reads bounded assistant messages for its nonresident Agent
- **THEN** the Driver uses the same native Claude history owner and returns the same bounded message semantics without activating the Agent

#### Scenario: Claude compatibility or account limit fails
- **WHEN** the host Claude version is incompatible or the selected account reports explicit exhaustion
- **THEN** the Driver preserves the existing fail-closed compatibility or non-fallback usage-limit result

### Requirement: Claude final handoff is the latest complete outer-assistant message
The Claude Code Driver SHALL return the latest complete top-level outer-assistant message as `finalMessage`, SHALL exclude earlier tool-boundary narration and intermediate assistant messages, and SHALL not truncate that selected message.

#### Scenario: Turn contains intermediate narration and tools
- **WHEN** stream-json contains an assistant message before tool use and a later complete assistant message after tool use
- **THEN** `finalMessage` contains only the later complete outer-assistant message

#### Scenario: Message boundaries are unavailable
- **WHEN** a compatible Claude stream contains no complete outer-assistant message boundary but provides terminal result text
- **THEN** the Driver uses the terminal result as a fallback without concatenating duplicate prefixes

### Requirement: Harness failure classification uses native execution evidence
The runtime SHALL derive Harness-scoped authentication, account-limit,
transport, process, and native-team/tool-surface blocking only from structured
terminal or initialization events, stderr, warnings, exit state, or equivalent
native execution evidence, not from Claude assistant prose. A reviewed
mode-forbidden tool observed after canonicalizing native aliases, an
orchestrator initialization missing any injected teammate definition or
necessary coordination tool name, a named Agent result that is not a correlated
asynchronous launch, or a failed/uncorrelated `SendMessage` to that launched
member name, SHALL produce an admitted Harness-scoped compatibility
classification that maps to the existing `harness_incompatible` blocking
reason. An absent leaf inventory or unknown non-forbidden native tool SHALL NOT
produce that classification.

#### Scenario: Assistant discusses an account limit hypothetically
- **WHEN** a successful final assistant message mentions quota, authentication, permission, or forbidden-tool errors without matching native failure evidence
- **THEN** the job is not classified as a Harness-scoped operator-required failure

#### Scenario: Native initialization leaks a forbidden tool
- **WHEN** an authoritative production init inventory exposes a tool forbidden by the active mode after mapping init alias `Task` to policy name `Agent`
- **THEN** the turn is classified as Harness-incompatible from structured native evidence and no assistant prose is used in that decision

#### Scenario: Orchestrator definitions do not load
- **WHEN** an orchestrator init inventory omits `haiku-scout`, `sonnet`, or `opus`
- **THEN** the turn fails as Harness-incompatible rather than continuing with silently ignored `--agents` definitions

#### Scenario: Team server gate is unavailable after clean initialization
- **WHEN** a named Agent returns a synchronous/interactive result or no correlated `SendMessage` succeeds for the launched member name
- **THEN** the turn fails as Harness-incompatible and does not accept that result as native-team completion

### Requirement: Claude Agent turns enable native Auto Memory by default
Every model-facing Claude Code turn launched by the HarnessDock runtime SHALL receive
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` from the canonical effective environment
after the one env file is resolved, so a selected file cannot accidentally
omit or disable it. The runtime SHALL NOT emulate Auto Memory with `CLAUDE.md`,
prompt content, public receipts, or Plugin-owned memory storage, and SHALL NOT
set `autoMemoryDirectory`. Claude SHALL retain its repository-derived memory
isolation and shared-worktree behavior. Native teammate `memory: local` SHALL
remain Claude-owned at `.claude/agent-memory-local/<member-type>/`.

#### Scenario: Inherited or selected value disables Auto Memory
- **WHEN** inherited environment or the selected env file contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, or omits the setting
- **THEN** the canonical effective child environment replaces it with `0` before Claude starts

#### Scenario: New Claude Agent starts
- **WHEN** `spawn_agent` activates a new Claude Code turn
- **THEN** the Claude child environment contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`

#### Scenario: Inherited host value disables Auto Memory
- **WHEN** the inherited model-facing environment contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- **THEN** the canonical effective environment replaces it with `0` before Claude starts

#### Scenario: Claude selects memory storage
- **WHEN** Auto Memory is available to an Agent working in a Git repository or worktree
- **THEN** the Plugin passes no shared memory directory or memory content and Claude retains native repository-derived storage

#### Scenario: Durable Agent resumes
- **WHEN** a follow-up activates a proven parent Claude session
- **THEN** the resumed parent and any fresh native teammates receive the same force-enabled Auto Memory environment

### Requirement: Orchestrator activation injects stable native teammate definitions
Every orchestrator activation SHALL supply session-local definitions named
`haiku-scout`, `sonnet`, and `opus`. Each definition SHALL pin its exact Claude
model, enable `memory: local`, omit fixed effort, background, isolation,
permission, skills, and MCP overrides, deny nested `Agent`, `Workflow`,
`ListAgents`, `ListPeers`, scheduled/routine wakeups, user/notification delivery,
and native worktree switching, and describe its role and authority boundary.
Definitions SHALL retain Claude's current-team `SendMessage` and shared-task
coordination. They SHALL NOT be persisted as Plugin-owned project or user Agent
files and SHALL NOT override native settings, hooks, skills, plugins, or MCP.

#### Scenario: Team definitions are serialized
- **WHEN** an orchestrator process starts or resumes
- **THEN** Claude receives exactly three injected definitions with stable type names, exact requested models, native local memory, and bounded tool denials

#### Scenario: Leaf process starts
- **WHEN** a leaf process starts or resumes
- **THEN** it receives no session-local teammate definitions or Agent Teams environment
