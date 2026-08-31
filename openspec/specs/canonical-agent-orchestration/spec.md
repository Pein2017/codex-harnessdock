# canonical-agent-orchestration Specification

## Purpose
Define the eight canonical model-facing Agent operations and their exact mapping
to the checkout-owned HarnessDock for Codex plugin surface.
## Requirements

### Requirement: Plugin skills map directly to the canonical operations
The installed Plugin SHALL expose exactly `$codex-harnessdock:spawn-agent`, `$codex-harnessdock:send-message`, `$codex-harnessdock:followup-task`, `$codex-harnessdock:wait-agent`, `$codex-harnessdock:interrupt-agent`, `$codex-harnessdock:list-agents`, `$codex-harnessdock:read-agent-messages`, and `$codex-harnessdock:list-harnesses` as Experimental orchestration guidance for the matching eight `mcp__codex_harnessdock__*` typed tools. Each MCP tool SHALL delegate to the matching checkout-owned snake_case runtime operation. All eight Skills and tools SHALL be eligible for model-visible discovery in a newly started Codex task. Skills SHALL NOT silently substitute shell execution when the typed server is unavailable; the checkout CLI remains an operator/debug fallback.

#### Scenario: Installed snapshot is verified in a new task
- **WHEN** Codex loads the new public generation
- **THEN** all eight Experimental Agent Skills and all eight typed tools are present, none of the old lifecycle Skills is discoverable, and ordinary lifecycle calls require no shell command

#### Scenario: Typed MCP server is unavailable
- **WHEN** a model-facing lifecycle operation cannot resolve its matching MCP tool
- **THEN** the Skill reports Plugin discovery or startup failure instead of silently invoking a Harness CLI or checkout CLI

### Requirement: Model-facing activation selects write intent deliberately
The `spawn-agent` Skill SHALL require explicit Harness, full model, topology, and write intent and SHALL pass every value unchanged. It SHALL describe `write` as immutable behavioral authority whose enforcement is route-specific and observable, never a universal CLI permission or OS sandbox. `followup-task` SHALL explain that Harness, model, topology, and authority are inherited and cannot change; a different route or authority requires a new Agent.

#### Scenario: Parent delegates a read-only OpenCode audit
- **WHEN** Codex chooses the admitted Explorer route
- **THEN** it passes `opencode`, `opencode-go/deepseek-v4-flash`, `leaf`, and `write: false` explicitly

#### Scenario: Parent delegates authorized Claude implementation
- **WHEN** Codex chooses a Claude route whose Driver admits mutation
- **THEN** it passes that exact Harness/model/topology plus `write: true` and limits mutation to the delegated task

#### Scenario: Follow-up would change authority
- **WHEN** new work needs a different authority or route
- **THEN** Codex creates a new explicitly routed Agent instead of changing the old identity

### Requirement: Spawn skill presents a concise acknowledgement by default
The `spawn-agent` skill SHALL receive only a bounded successful projection containing stable `agent_name`, exact `model`, and bounded lifecycle `status`. It SHALL present one concise acknowledgement derived from those fields and the configured approximate model role. It SHALL NOT print raw JSON or expose Agent IDs, delegation metadata, workspace, native session/config, job, continuation, or mailbox internals; deeper evidence SHALL use the operator diagnostics path. Actionable error or recovery information SHALL remain visible when spawn fails.

#### Scenario: Agent starts successfully
- **WHEN** `spawn-agent` receives a successful bounded runtime receipt
- **THEN** Codex reports the selected model, concise role, stable Agent name, and current status without dumping JSON or internal state

#### Scenario: Deeper diagnostics are requested
- **WHEN** the user needs Agent ID, delegation, session, job, continuation, workspace, or mailbox evidence
- **THEN** the ordinary Agent receipt remains bounded and the operator diagnostics path is used instead

#### Scenario: Spawn fails or requires recovery
- **WHEN** spawn fails or reaches an actionable recovery condition
- **THEN** Codex reports the actionable condition instead of hiding it behind a generic concise success message

### Requirement: Real HarnessDock testing stops on account-limit exhaustion
The model-facing orchestration policy SHALL explicitly pass Haiku 4.5 with low effort for routine real Plugin smoke, hook, environment-parity, and integration witnesses unless the test specifically targets another model. Haiku SHALL remain fully available for non-test work and all supported effort values. The runtime SHALL NOT inject an omitted effort under `terminal-parity`. When Claude reports explicit subscription, usage, credit, weekly/monthly, or quota-limit exhaustion, the parent SHALL stop subsequent real HarnessDock test launches and SHALL NOT retry or fall back to another model. Local code work, fake-Claude fixtures, unit tests, and integration tests MAY continue.

#### Scenario: Routine Plugin smoke selects a model
- **WHEN** a real HarnessDock test needs only a protocol, hook, or environment witness
- **THEN** the parent explicitly selects `claude-haiku-4-5` with `low` effort rather than spending Sonnet, Opus, or Fable capacity

#### Scenario: Haiku test omits effort under terminal parity
- **WHEN** a direct runtime caller selects Haiku under `terminal-parity` without an effort argument
- **THEN** the runtime passes no effort override instead of silently injecting `low`

#### Scenario: Test specifically validates another model
- **WHEN** the test requirement is to prove another exact model selection itself
- **THEN** the parent may launch that exact supported model instead of Haiku

#### Scenario: Claude reports subscription exhaustion
- **WHEN** a real HarnessDock test returns an explicit subscription, usage, credit, periodic, or quota-limit exhaustion
- **THEN** the parent reports the condition, starts no further real HarnessDock tests in that workflow, and does not substitute another model

#### Scenario: Local verification remains available
- **WHEN** real HarnessDock testing has stopped because of account-limit exhaustion
- **THEN** local edits, fake-Claude tests, and non-Claude integration verification may continue

### Requirement: Spawn skill uses exact Claude model and effort identifiers
The `spawn-agent` skill SHALL require an explicit model selection and SHALL pass model and effort as separate arguments. It SHALL support Haiku 4.5 as `claude-haiku-4-5`, Sonnet 5 as `claude-sonnet-5`, Opus 5 as `claude-opus-5`, and Fable 5 as `claude-fable-5`. All four models SHALL accept each exact effort value `low`, `medium`, `high`, `xhigh`, and `max`. The skill SHALL present the approximate relative capability/spend ladder `Haiku < Sonnet < Opus < Fable`, recommend Sonnet for balanced general coding, Opus for deeper or higher-risk work, and Fable primarily for core decision discussion and planning rather than routine code writing. It SHALL NOT pass partial identifiers such as `sonnet-5`, `opus-5`, `haiku-4-5`, or `fable-5`, and SHALL NOT silently substitute a different model after an availability or account-limit rejection.

#### Scenario: Public alias and effort are requested
- **WHEN** the user requests Opus 5 with x-high effort
- **THEN** the skill passes model `claude-opus-5` and reasoning effort `xhigh`
  as separate canonical arguments

#### Scenario: Every model accepts every effort
- **WHEN** spawn selects any supported model with any of `low`, `medium`, `high`, `xhigh`, or `max`
- **THEN** the runtime forwards that exact canonical model and effort combination to Claude

#### Scenario: Orchestration label resembles a model version
- **WHEN** an `Ops5` substring appears only inside an Agent or task name
- **THEN** the skill does not infer any model argument from that label

#### Scenario: Sonnet is selected
- **WHEN** the user selects Sonnet or Sonnet 5
- **THEN** the skill passes the exact model ID `claude-sonnet-5`

#### Scenario: Haiku is selected
- **WHEN** the user selects Haiku or Haiku 4.5 for either test or general work
- **THEN** the skill passes the exact model ID `claude-haiku-4-5` and accepts the caller-selected supported effort

#### Scenario: Fable is selected for a core decision
- **WHEN** the user selects Fable for core decision discussion or planning
- **THEN** the skill passes the exact model ID `claude-fable-5` and reports it as the highest relative capability/spend tier

#### Scenario: Fable is considered for routine coding
- **WHEN** the parent is choosing a model for ordinary code implementation without an explicit Fable request
- **THEN** the skill recommends Sonnet or Opus instead of spending Fable capacity

#### Scenario: Requested model is unavailable
- **WHEN** Claude Code rejects the requested model for the active account
- **THEN** the skill reports the rejection and does not retry under another model

#### Scenario: Another available Claude model is requested
- **WHEN** spawn explicitly requests an older, dated, partial, or otherwise available model outside `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, and `claude-fable-5`
- **THEN** the runtime rejects the model before launching Claude

#### Scenario: No model is explicitly selected
- **WHEN** spawn omits a model under either execution profile
- **THEN** the runtime rejects the request before creating an Agent reservation or launching Claude

### Requirement: Claude-native delegation is explicit and bounded
Every new Claude Agent SHALL persist immutable topology selected explicitly at spawn. `leaf` SHALL deny native `Agent`, `Workflow`, and the reviewed high-blast-radius tools. Exact Opus 5 and Fable 5 MAY use `native_orchestrator`; Haiku and Sonnet SHALL reject it. An orchestrator SHALL enable the experimental native team transport for that Claude process and SHALL fail observably rather than accept ordinary-subagent work as a native team when required definitions or transport proof are unavailable. The Plugin SHALL track only the durable parent Claude Agent and instruct it to return one self-contained synthesis. OpenCode SHALL admit only `leaf` and SHALL not project its task/subagent facilities as Plugin Agent communication.

#### Scenario: Claude leaf is spawned
- **WHEN** a supported Claude model is combined with explicit `topology=leaf`
- **THEN** native `Agent`, `Workflow`, and cross-session communication tools are denied

#### Scenario: Opus or Fable orchestration is explicit
- **WHEN** exact Opus 5 or Fable 5 is combined with `topology=native_orchestrator`
- **THEN** the Claude Agent may lead one bounded experimental Native Agent Team while remaining the only Agent in the Plugin registry

#### Scenario: Haiku or Sonnet orchestration is requested
- **WHEN** either model is combined with `native_orchestrator`
- **THEN** spawn fails before readiness, durable mutation, or native process

#### Scenario: OpenCode orchestration is requested
- **WHEN** the Explorer route is combined with `native_orchestrator`
- **THEN** spawn fails before session creation or model usage

### Requirement: spawn_agent creates identity and starts the first turn
`spawn_agent` SHALL require canonical `task_name`, `message`, explicit admitted `harness`, explicit full `model`, explicit `topology`, and explicit boolean `write`. It SHALL accept only optional `description` and Driver-discriminated `reasoning_effort`; removed or Driver/config/session/repository-policy selectors SHALL be absent and rejected. Before readiness, Agent creation, mailbox mutation, or job preparation, it SHALL synchronously validate the complete route and intent. On success it SHALL atomically reserve a root-unique v3 Agent identity with the first-turn message as mailbox sequence one, then start its first internal job from the ordered assignment.

#### Scenario: New Agent starts successfully
- **WHEN** the name is unique and every explicit route, authority, effort, and readiness check passes
- **THEN** the call returns the stable Agent name and a bounded route-qualified starting/working projection

#### Scenario: Route combination is invalid
- **WHEN** Harness, model, topology, effort, or authority are unsupported or incompatible
- **THEN** spawn fails synchronously before creating an Agent, message, job, native session, or model request

#### Scenario: Required route field is omitted
- **WHEN** spawn omits Harness, model, topology, or write
- **THEN** the request fails rather than inferring from configuration, model prefix, or the only ready Driver

#### Scenario: Native session adoption is requested
- **WHEN** spawn includes an existing Claude or OpenCode session ID
- **THEN** spawn rejects it because session adoption is outside the public contract

### Requirement: Legacy Agent model migration is evidence-only and recoverable
A pre-v0.3 Agent without `selectedModel` SHALL be backfilled only from an exact supported model proven by a retained runtime receipt or a bounded read of its own Claude session artifact. Dated artifact evidence matching the verified Haiku 4.5 family SHALL normalize to canonical `claude-haiku-4-5`; arbitrary dated public requests SHALL remain unsupported. Reconciliation SHALL index pending session artifacts once per Claude config root rather than rescan the full history per Agent. It SHALL defer an evidence-free active turn. It SHALL preserve identity and history while blocking terminal continuation when the model is unsupported or not yet proven, SHALL retry a directly located unproven artifact, and SHALL never infer or substitute a supported model.

#### Scenario: Pruned job has a supported Claude artifact
- **WHEN** a terminal legacy Agent has no retained job but its bound Claude session artifact proves `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, or a dated `claude-haiku-4-5-YYYYMMDD` backend
- **THEN** the runtime persists the exact canonical selected model and preserves exact-session continuation

#### Scenario: Historical model is unsupported
- **WHEN** retained evidence proves that a legacy Agent ran an older or otherwise unsupported model
- **THEN** continuation is blocked with the observed model recorded, while Agent identity and Claude history remain intact

#### Scenario: Active legacy model is not yet observable
- **WHEN** a legacy Agent still has an active turn and no exact model evidence is available
- **THEN** migration persists a non-blocking pending marker and direct artifact candidate without changing the active continuation mode or repeatedly scanning the full history tree

#### Scenario: Terminal model evidence arrives after an unproven block
- **WHEN** a terminal legacy Agent was blocked because its artifact had no model evidence and that same artifact later proves a supported exact model
- **THEN** reconciliation persists the canonical model and restores exact-session continuation

### Requirement: send_message never activates an idle Agent
`send_message` SHALL append the complete message and delivery evidence to the Agent-level durable mailbox, deliver to an active Agent turn when possible, and leave the message queued without starting a new turn when the Agent is terminal. A successful model-facing receipt SHALL contain only stable `agent_name` and `delivery`; it SHALL preserve the `dispatched_active`, `activation_pending`, and `queued_no_turn` dispositions while excluding Agent status, the message text, message and Agent IDs, timestamps, assignment, job, steering, model, and delegation metadata. Model-facing guidance SHALL summarize success in one concise disposition-aware sentence and SHALL NOT print raw JSON unless the user explicitly requests debug detail.

#### Scenario: Agent is running
- **WHEN** a message is sent during an active Claude stream
- **THEN** it is delivered in durable order at the next supported stream boundary and the public receipt reports `dispatched_active` without internal delivery evidence

#### Scenario: Agent is terminal
- **WHEN** a message is sent while no turn is active
- **THEN** it is retained as a `queued` Agent-mailbox entry, the public receipt reports `queued_no_turn`, and no Claude process starts

#### Scenario: Agent activation is pending
- **WHEN** the message is durably assigned to an Agent activation that has not yet reached a supported stream boundary
- **THEN** the public receipt reports `activation_pending` without exposing its assigned job or mailbox record

#### Scenario: Agent is activation-blocked
- **WHEN** an errored Agent has `continuation=blocked`
- **THEN** send rejects the message with the blocking evidence instead of queueing it indefinitely

#### Scenario: Parent presents successful delivery
- **WHEN** the model receives a successful `send_message` receipt
- **THEN** it presents one concise sentence reflecting the delivery disposition and does not repeat the message or raw receipt unless the user requested debug detail

### Requirement: followup_task guarantees only capability-valid activation
`followup_task` SHALL inherit the Agent's immutable route and accept only a new message plus optional route-admitted turn effort. For a terminal Agent it SHALL start an exact-session or receipt-proven safe-fresh turn when admitted. For an active Agent it SHALL deliver only when its accepted capability proves active input; otherwise it SHALL fail before mailbox mutation rather than promise later activation. It SHALL reject route, authority, topology, model, Driver, tool, session, configuration, scope, or questions overrides.

#### Scenario: Terminal OpenCode Agent receives follow-up
- **WHEN** its exact session binding, authoritative Server/session incarnation, and route remain valid and its snapshot declares exact resume
- **THEN** a new turn starts on that exact session and consumes queued `send_message` entries in order

#### Scenario: Terminal OpenCode Agent is fresh-only
- **WHEN** the accepted snapshot lacks authoritative exact-resume evidence
- **THEN** follow-up rejects before mailbox mutation and Codex must create a new explicitly routed Agent

#### Scenario: Active OpenCode Agent receives follow-up
- **WHEN** its snapshot declares initial input only
- **THEN** follow-up fails without enqueueing a message under a false activation guarantee

#### Scenario: Active Claude Agent receives follow-up
- **WHEN** its snapshot proves acknowledged active input
- **THEN** the message is durably delivered at the supported stream boundary without a competing job

#### Scenario: Agent is activation-blocked
- **WHEN** neither exact resume nor proven safe fresh is available
- **THEN** follow-up rejects with bounded route-qualified blocking evidence

### Requirement: wait_agent returns bounded root mailbox activity
Model-facing `wait_agent` SHALL accept optional `wake_on_progress`, optional non-empty unique exact current-root `targets`, and the HarnessDock durable-delivery extension `acknowledge_tokens`; SHALL NOT expose `timeout_ms`; and SHALL use a fixed 3600000 ms observation upper bound. With no targets, wait SHALL preserve the Codex-V2-shaped root-wide next-activity behavior and return at most one current-root update. With one target it SHALL join the concrete active or latest turn snapshotted at call entry; when that one target is combined with `wake_on_progress: true`, the same bounded observation MAY instead return that snapshotted job's one eligible advisory progress update before completion. With multiple targets it SHALL remain completion-only, wait for every concrete snapshotted turn to settle, and return one aggregate barrier receipt in caller target order. A later activation SHALL NOT extend or satisfy that fixed snapshot. Model-facing guidance SHALL make no-target, no-progress wait the canonical ordinary root join and targeted wait the canonical result-required join when the parent knows the dependency set.

The runtime SHALL process only valid previously delivered acknowledgement tokens, SHALL acknowledge targeted events independently of older unrelated unread events, and SHALL derive compaction only through the highest fully acknowledged or quarantined sequence. It SHALL prioritize eligible target completion over advisory target progress. A delivered completion SHALL include the complete stored Agent final message, legacy-compatible truncation flag, and opaque delivery token. Targeted/barrier output SHALL omit unrelated completions, hook activity, raw inbox state, full Agent records, result pointers, native session evidence, and reconciliation detail, and SHALL NOT acknowledge a newly returned completion in the same call. The checkout CLI and public runtime operation SHALL retain explicit 0..3600000 ms diagnostic selection independently of the fixed model-facing bound.

#### Scenario: Unread activity predates untargeted wait
- **WHEN** the root inbox already contains an unread Agent completion and the caller omits targets
- **THEN** wait returns one oldest status/summary/complete-final-message update with an opaque delivery token and leaves it unread

#### Scenario: Later wait confirms prior delivery
- **WHEN** a later wait echoes valid previously delivered Agent completion tokens
- **THEN** each named event becomes acknowledged idempotently and compaction advances only through the highest sequence with no unread Agent-linked hole

#### Scenario: Caller joins one exact Agent turn
- **WHEN** `targets` contains one Agent whose active turn is snapshotted at wait entry and progress wakeup is omitted
- **THEN** only that job's completion, blocker, non-joinable state, or timeout can resolve the targeted join

#### Scenario: Caller observes one exact Agent turn
- **WHEN** `targets` contains one Agent and `wake_on_progress: true`
- **THEN** the wait remains scoped to the snapshotted target job and returns either its completion or at most its one eligible bounded progress update

#### Scenario: Unrelated activity occurs during targeted progress wait
- **WHEN** another current-root Agent publishes completion or progress while the selected target remains active
- **THEN** the unrelated activity neither resolves nor blocks the targeted observation and remains available to its proper consumer

#### Scenario: Caller joins a fixed barrier
- **WHEN** `targets` contains multiple valid Agents with concrete snapshotted jobs and progress wakeup is omitted
- **THEN** wait returns the aggregate completion only after every snapshotted job is completed, failed, or interrupted

#### Scenario: Caller requests progress from multiple targets
- **WHEN** `targets` contains two or more Agents and `wake_on_progress: true`
- **THEN** strict validation rejects the call before acknowledgement, delivery, or Agent state changes

#### Scenario: Follow-up starts during a barrier
- **WHEN** a target's snapshotted job settles and the same Agent starts a later follow-up before the remaining targets settle
- **THEN** the later job neither extends the barrier nor replaces the frozen status and handoff for the snapshotted job

#### Scenario: Unrelated completion predates a target completion
- **WHEN** an unread completion outside the target set has a lower sequence than a target completion
- **THEN** targeted wait leaves the unrelated event unread and unfrozen while returning and later acknowledging the eligible target event independently

#### Scenario: Target is not joinable
- **WHEN** a resolved Agent has no concrete active or latest job, or its Agent/job linkage is irreconcilable
- **THEN** wait returns that target as non-joinable immediately without activating an Agent or consuming the observation window

#### Scenario: Barrier reaches its quiet bound
- **WHEN** at least one snapshotted target remains active through the fixed 3600000 ms window
- **THEN** wait returns a per-target status snapshot and unresolved targets without freezing or acknowledging partial completion payloads

#### Scenario: Root Agent publishes progress during ordinary join
- **WHEN** a current-root Agent publishes safe progress before the fixed deadline, no completion is unread, and the caller omitted or disabled `wake_on_progress`
- **THEN** wait does not return or acknowledge that progress and continues to completion or timeout

#### Scenario: Caller requests one root-wide progress observation
- **WHEN** a current-root Agent job publishes its first eligible non-hook safe progress before the fixed deadline, no completion is unread, the caller set `wake_on_progress: true`, and targets are absent
- **THEN** wait reports that job's single bounded progress update without returning Claude text or tool inputs

#### Scenario: Root Agent completes during untargeted wait
- **WHEN** any current-root Agent publishes completion activity before the fixed deadline and targets are absent
- **THEN** wait reports the oldest eligible completion with the complete stored Agent final message regardless of `wake_on_progress`

#### Scenario: Ordinary caller omits timeout
- **WHEN** the parent performs an ordinary required join without a specific scheduling deadline
- **THEN** it supplies no timeout field and may return before the fixed upper bound on eligible completion or user steer

#### Scenario: Caller supplies timeout to the model-facing tool
- **WHEN** the parent supplies `timeout_ms`
- **THEN** the model-facing boundary rejects that field before changing Agent or delivery state, leaving explicit bounds only to the checkout CLI and runtime

### Requirement: interrupt_agent ends only the current turn
`interrupt_agent` SHALL address only the target Agent's current turn and preserve the logical Agent. If the accepted route does not support interruption, it SHALL return `unsupported` without native action. When interruption is supported, durable request acknowledgement SHALL remain nonterminal: only authoritative terminal Driver evidence may produce `interrupted`. A pending/rejected request SHALL return `interrupt_requested` or `still_working`; lost ownership without authoritative settlement SHALL return `settlement_unknown`. A terminal Agent SHALL return `no_active_turn`. The public operation SHALL NOT auto-escalate a rejected or unobserved graceful request to destructive cancellation.

#### Scenario: Graceful interruption proves terminal settlement
- **WHEN** the Driver accepts the request and later proves the exact native turn interrupted with settled execution
- **THEN** the Agent becomes interrupted, no turn worker remains resident, and the receipt reports `interrupted`

#### Scenario: Request is accepted but settlement is pending
- **WHEN** the Driver has acknowledged interruption but the exact turn remains nonterminal
- **THEN** the receipt reports `interrupt_requested` and the Agent remains active

#### Scenario: Route does not support interruption
- **WHEN** the accepted capability snapshot declares interrupt unsupported
- **THEN** the receipt reports `unsupported` without calling native abort, signal, status, or recovery APIs

#### Scenario: Worker loss leaves settlement unknown
- **WHEN** an interruption may have been requested but no authoritative terminal evidence can be obtained
- **THEN** the receipt reports `settlement_unknown`, affected leases remain held, and no interrupted completion is synthesized

#### Scenario: Agent has no active turn
- **WHEN** interruption targets a terminal Agent
- **THEN** the receipt reports `no_active_turn` without changing Agent identity or history

### Requirement: list_agents reports logical state and immutable route
`list_agents` SHALL accept only optional canonical `path_prefix` and return every matching current-root logical Agent, including nonresident terminal history, with canonical Agent name, bounded status, immutable Harness, full model, topology, behavioral authority, and maturity. It SHALL not return native sessions, instance keys, endpoints, credentials, completion events/tokens/output, reconciliation receipts, or storage metadata. Cross-root all-state remains operator-only.

#### Scenario: Mixed root is listed
- **WHEN** one root owns Claude and OpenCode Agents
- **THEN** each Agent card preserves its own immutable route and logical status without consuming completion or progress delivery

#### Scenario: Legacy Agent is listed
- **WHEN** a valid v1/v2 Claude Agent is observed
- **THEN** it is identified as Claude with its evidence-backed model/topology and historical authority reported honestly, without rewriting it as v3

### Requirement: No public cancellation operation exists
The model-facing runtime, CLI, and skill surfaces SHALL NOT expose `cancel`, `cancel_job`, or a destructive Agent deletion action.

#### Scenario: Caller requests legacy cancel
- **WHEN** an old cancel command or skill name is invoked after migration
- **THEN** it is rejected as removed and directs the caller to `interrupt_agent` without executing a compatibility alias

### Requirement: All canonical Agent skills disclose Experimental status
Each of the eight model-visible HarnessDock Agent Skills and its discovery metadata SHALL identify the feature as Experimental and SHALL state that the local Plugin cannot automatically start a new Codex model turn after the parent has ended.

#### Scenario: A newly started Codex task discovers the plugin
- **WHEN** the eight Agent Skills are loaded from the installed local snapshot
- **THEN** every Skill is visibly Experimental without claiming automatic idle-parent wakeup or automatic route selection

### Requirement: Completed results use the completion handoff
When `wait_agent` returns a completion update, the parent SHALL synthesize its complete final message directly and SHALL NOT start a follow-up turn, read history, or ask the Agent to write a temporary file solely to recover that current completed result. `read_agent_messages` SHALL be reserved for retrospective access to earlier native messages or explicit recovery investigation.

#### Scenario: Required Agent completes
- **WHEN** wait returns a complete final message for required work
- **THEN** the parent uses that message for disposition and synthesis without a result-recovery follow-up or history read

#### Scenario: Parent needs an older Agent message
- **WHEN** the current completion is already disposed or the requested evidence belongs to an earlier Agent turn
- **THEN** the parent may use `read_agent_messages` on the same exact Agent without activating Claude

### Requirement: read_agent_messages provides root-scoped retrospective access
`read_agent_messages` SHALL require an exact current-root Agent target, SHALL accept only optional `before` and `limit` pagination fields, SHALL default to the latest one eligible outer-assistant native message, and SHALL reject limits outside 1 through 20. It SHALL return messages newest first with complete text and opaque message IDs, plus a next cursor only when older eligible messages remain. It SHALL be observation-only and SHALL NOT activate, resume, interrupt, steer, or change acknowledgement or lifecycle state.

#### Scenario: Parent requests latest history
- **WHEN** the parent calls `read_agent_messages` with only an exact Agent target
- **THEN** it receives at most the latest one eligible outer-assistant message without changing the Agent

#### Scenario: Parent requests an older page
- **WHEN** the parent echoes a valid returned message ID as `before`
- **THEN** it receives only older eligible messages up to the requested message-count limit

#### Scenario: Parent supplies an invalid cursor or limit
- **WHEN** `before` is not an eligible message ID for that Agent or `limit` is outside 1 through 20
- **THEN** the operation fails before returning unrelated transcript content

#### Scenario: Parent attempts a foreign read
- **WHEN** the target does not resolve exactly inside the current root
- **THEN** the operation fails under the same root-isolation boundary as other Agent mutations

### Requirement: Public runtime exposes only eight canonical Agent operations
The public runtime SHALL expose `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `read_agent_messages`, and `list_harnesses` as its complete model-facing surface.

#### Scenario: Public runtime is inspected
- **WHEN** a caller enumerates the frozen Agent interface
- **THEN** exactly the eight canonical operations are present and job, server, session, endpoint, provider, config, login, cancel, and delete operations are absent

### Requirement: Follow-up and interrupt acknowledgements are operation-specific
A successful `followup_task` model-facing receipt SHALL contain only stable `agent_name` and `delivery`. A successful `interrupt_agent` model-facing receipt SHALL contain only stable `agent_name` and one closed operation `status`: `no_active_turn`, `interrupt_requested`, `still_working`, `unsupported`, `settlement_unknown`, or `interrupted`. Request acknowledgement SHALL NOT be presented as terminal effect. Their Skills SHALL present one concise disposition-aware sentence and SHALL NOT echo raw JSON. Actionable failures SHALL remain visible through the existing failure boundary.

#### Scenario: Follow-up is handed off
- **WHEN** a follow-up is durably delivered, pending activation, already active, or starts a new turn
- **THEN** the receipt reports only the Agent name and exact delivery disposition

#### Scenario: Active turn reaches proven interruption
- **WHEN** authoritative Driver evidence proves interruption and settlement
- **THEN** the receipt reports the Agent name and `interrupted`

#### Scenario: Interruption remains pending or unknown
- **WHEN** request acknowledgement or lost ownership cannot prove terminal effect
- **THEN** the receipt reports `interrupt_requested`, `still_working`, or `settlement_unknown` without process-control details

#### Scenario: Route does not support interruption
- **WHEN** the target capability declares interruption unsupported
- **THEN** the receipt reports the Agent name and `unsupported`

#### Scenario: Agent has no active turn
- **WHEN** interruption targets an Agent without an active turn
- **THEN** the receipt reports the Agent name and `no_active_turn`

### Requirement: Agent Skill guidance has a bounded context footprint
The eight installed Agent Skills SHALL remain self-contained and preserve typed inputs, lifecycle distinctions, explicit immutable routing, behavioral authority, capability-specific unsupported paths, completion/acknowledgement mechanics, and actionable failure handling. Their aggregate whitespace-delimited word count SHALL NOT exceed 2,200, and successful presentation guidance SHALL prefer concise synthesis over raw receipt repetition or route policy.

#### Scenario: Plugin contract tests inspect Skills
- **WHEN** all eight installed `SKILL.md` files are measured
- **THEN** their aggregate word count is at most 2,200 while every required contract marker remains present

#### Scenario: Typed tool is unavailable
- **WHEN** a Skill cannot resolve its matching MCP tool
- **THEN** it reports Plugin discovery or startup failure instead of invoking shell or a Harness CLI

### Requirement: Activation-pending guidance is operation specific
Public Skill guidance SHALL distinguish a message durably assigned to activation from a message that is still queued, and SHALL direct the lead to join or observe the activated turn rather than repeatedly resending it.

#### Scenario: Follow-up is assigned but worker startup is pending
- **WHEN** `followup_task` has durably assigned a message and reports activation pending
- **THEN** guidance tells the lead to use the existing Agent join path and not submit a duplicate follow-up

### Requirement: Persisted blocking tuples are coherent
The runtime SHALL accept only blocking reason, scope, and retry combinations permitted by the canonical Agent recovery contract and SHALL reject or safely ignore impossible persisted combinations.

#### Scenario: Harness blocking requests same-Agent follow-up
- **WHEN** persisted state combines Harness scope with a same-Agent follow-up retry
- **THEN** the state is rejected or projected as invalid rather than exposed as a valid recovery instruction

#### Scenario: Operator-required retry is Agent scoped
- **WHEN** persisted state combines `operator_required` with Agent scope
- **THEN** the state is rejected or projected as invalid rather than exposed as a valid recovery instruction

### Requirement: Timeout guidance uses the final observation guarantee
The model-facing wait guidance SHALL state that a timeout means no unread
current-root completion was visible at the call's final observation. It SHALL
instruct the lead not to narrate unchanged state or call `list_agents` or
`read_agent_messages` solely to recheck completion after that timeout. Required
work SHALL re-enter the ordinary completion-first join directly, while timeout
continues not to prove failure, cancellation, health, progress, or future
inactivity.

#### Scenario: Lead receives a genuine timeout
- **WHEN** `wait_agent` returns timeout after its final completion observation and required work remains unresolved
- **THEN** the lead directly waits again without narrating unchanged state or probing list/history merely to ask whether completion was missed

#### Scenario: Lead needs intentional progress evidence
- **WHEN** scheduling depends on one intermediate activity observation rather than completion
- **THEN** the lead uses the existing bounded `wake_on_progress` behavior instead of treating timeout status as health evidence

### Requirement: Credential refresh can safely unblock the same logical Agent
An Agent blocked by a terminal `auth_or_permission` failure SHALL preserve its historical `auth_required / harness / operator_required` completion unchanged. A later `followup_task` MAY satisfy that operator requirement and start a `safe_fresh` native Claude session on the same logical Agent only when the blocked job is the Agent's first activation, the current Driver observes the same fixed Harness/config identity, a different redacted credential generation whose access credential is locally current, and durable evidence that the failed turn produced no tool use, file touch, useful outer-assistant output, or other possible side effect. The recovery check SHALL occur before new follow-up mailbox mutation or job preparation and SHALL be bounded to the selected Agent's latest failed activation.

#### Scenario: Operator refreshed credentials after a side-effect-free 401
- **WHEN** follow-up targets an authentication-blocked Agent, the credential generation changed under the same fixed config identity, the replacement access credential is locally current, and the failed turn proves no possible side effect
- **THEN** the runtime preserves the Agent ID, name, route, delegation mode, and history, atomically requeues only the original task messages consumed by that failed activation, and activates those messages plus the new follow-up in one new safe-fresh Claude native session

#### Scenario: Credential generation is unchanged
- **WHEN** follow-up targets an authentication-blocked Agent and the current credential generation equals the generation captured by the failure
- **THEN** follow-up remains rejected with bounded `auth_required / harness / operator_required` evidence and performs no mailbox or job mutation

#### Scenario: Replacement credential is locally expired or unproven
- **WHEN** the credential generation changed but its local access expiry is missing, malformed, or not later than the recovery observation time
- **THEN** the Agent remains blocked and no native process is launched

#### Scenario: Failed turn may have produced a side effect
- **WHEN** the authentication-failed turn is not the Agent's first activation, has tool use, file-touch evidence, useful assistant output, a message acknowledged by a different turn, a foreign session/config identity, or incomplete recovery evidence
- **THEN** the runtime does not convert the Agent to safe-fresh continuation and requires a new Agent or explicit future recovery contract

#### Scenario: Original prompt was consumed only by the failed authentication activation
- **WHEN** the first activation terminally acknowledged its initial Agent messages but all of those acknowledgements belong exclusively to the side-effect-free authentication-failed job
- **THEN** recovery restores those same message identities to queued state before accepting the new follow-up, so the safe-fresh turn receives the original task exactly once

#### Scenario: Historical completion is read after recovery
- **WHEN** the same logical Agent later activates successfully after credential refresh
- **THEN** the original completion remains an immutable authentication failure with its original acknowledgement and blocking evidence

#### Scenario: Non-activating message targets the blocked Agent
- **WHEN** `send_message` targets an authentication-blocked Agent before a successful recovery activation
- **THEN** it continues to reject rather than treating credential rotation as an implicit activation request

### Requirement: Every Harness Agent is an internal worker under Codex ownership
The Plugin SHALL represent every admitted Harness Agent as a root-scoped internal worker. Codex and the user SHALL retain task decomposition, route selection, synthesis, final repository modification, review, acceptance, and the final answer. A Driver result is research or implementation evidence, not ground truth or an automatically accepted decision.

#### Scenario: Multiple Harnesses return findings
- **WHEN** Codex explicitly starts workers on different routes
- **THEN** the Plugin preserves each lineage independently and Codex verifies, reconciles, and synthesizes the results

### Requirement: Core orchestration is policy-thin
The Plugin SHALL require explicit route inputs and enforce ownership, capability, mailbox, control, lease, and delivery invariants. It SHALL NOT encode delegation thresholds, automatic route ranking, cost optimization, fan-out, fallback, worker conflict resolution, implementation-worker admission, or a rule that all Agents in one root use the same Harness. Operation-specific Skills MAY explain mechanics and safety boundaries but SHALL leave task and route choice to the current Codex lead and user instructions.

#### Scenario: Root mixes Harness routes
- **WHEN** Codex explicitly starts two valid Agents under different Harnesses
- **THEN** both coexist under the same root without a Plugin rule forcing one Harness for the whole root

#### Scenario: Selected route fails
- **WHEN** a Driver reports auth, quota, service, model, or compatibility failure
- **THEN** the Plugin preserves that route-qualified failure and does not start or retry another Harness automatically

#### Scenario: Work appears inexpensive to delegate
- **WHEN** a task matches no runtime safety or ownership constraint
- **THEN** the Plugin makes no delegation decision based on file count, token estimate, price, or latency

### Requirement: Route discovery informs but never decides
The `list-harnesses` Skill SHALL explain admitted/available distinction, `liveValidated`, maturity, exact route constraints, and unsupported capabilities. It SHALL not rank Harnesses, recommend delegation thresholds, select a route, or interpret unavailable authentication/quota/service evidence as model-quality evidence.

#### Scenario: Codex needs current route facts
- **WHEN** the lead has not already been given a valid explicit route
- **THEN** it may inspect `list_harnesses` and then makes its own route decision from the task and user instructions
