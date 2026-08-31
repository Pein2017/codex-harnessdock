# native-claude-team-orchestration Specification

## Purpose
Define one bounded experimental Claude Native Agent Team inside an
orchestrating Claude Agent turn without creating a second Plugin-owned lifecycle or
weakening Codex's ownership of final acceptance.
## Requirements

### Requirement: Every orchestrator turn uses one fresh native team
An orchestrating Claude Agent turn SHALL enable Claude Code's experimental Native
Agent Teams transport only for that process. The lead SHALL use named native
teammates rather than silently substituting ordinary unnamed subagents. The
team SHALL exist only inside the current Claude process/turn: a later HarnessDock
follow-up that resumes the parent Claude session SHALL form a new team and
SHALL NOT address or resume a teammate from the earlier process. The Plugin
SHALL NOT create durable Claude Agent identities, mailbox entries, completion
events, public receipts, or transcript pointers for native teammates.

#### Scenario: Lead starts a team
- **WHEN** an Opus or Fable orchestrator starts and native team admission succeeds
- **THEN** the first named teammate forms one Native Agent Team with the current Claude session as lead while the lead remains the only durable Claude Agent

#### Scenario: Named teammate and message prove team transport
- **WHEN** a correlated named Agent result proves asynchronous launch and a later correlated `SendMessage` to that launched member name succeeds
- **THEN** the runtime marks the current turn's native-team transport live-validated without treating init tool names or launch status alone as proof

#### Scenario: Same Claude Agent receives a follow-up turn
- **WHEN** a durable orchestrating Claude Agent resumes its parent Claude session in a new process
- **THEN** it forms a fresh native team and does not reuse the earlier process's in-process teammates

#### Scenario: Native team gate is unavailable
- **WHEN** Claude accepts the process but omits an injected definition, returns a non-asynchronous named Agent result, or fails to complete a correlated message to the launched member name
- **THEN** the turn fails as Harness-incompatible and does not accept ordinary-subagent output as native-team work

### Requirement: Team-size controls are classified by enforcement strength
The runtime SHALL inject instructions limiting one turn to at most three
simultaneously active teammates plus the lead and at most six teammate
creations in total. It SHALL retain the reviewed Claude concurrency environment
only as a residual guard on the forbidden ordinary-subagent path and SHALL NOT
claim that value constrains native teammates. It SHALL deny native `Agent` and
`Workflow` to every teammate. Because current Claude Code exposes no
unbypassable native-team concurrency or creation-count control, the Plugin
SHALL describe both numerical limits as behavioral cost and coordination
budgets, not as process-enforced facts. It SHALL retain native
no-nested-team behavior and member tool denial as the enforceable topology
boundary.

#### Scenario: Lead parallelizes independent work
- **WHEN** a team lead has three independent delegated tasks
- **THEN** its envelope instructs it to run at most three named teammates concurrently while the lead remains the only durable Claude Agent

#### Scenario: Team reaches its creation budget
- **WHEN** six teammate creations have already been requested during the turn
- **THEN** the lead instruction requires convergence without requesting a seventh and the final synthesis reports any budget uncertainty instead of claiming hard enforcement

### Requirement: Native teammate types and roles are bounded
Every team SHALL use only the session-local teammate types `haiku-scout`,
`sonnet`, and `opus`. Haiku SHALL be used only for scouting and SHALL receive a
behavioral instruction not to mutate task, workspace, repository, or external
state. Sonnet and Opus MAY act as implementor, reviewer, investigator, or
verifier according to the delegated task. Fable SHALL NOT be a teammate. No
teammate SHALL receive the native `Agent` or `Workflow` tool. Claude's shared
task and same-team messaging tools MAY remain available because they are the
chosen Native Agent Teams coordination transport.

#### Scenario: Lead needs inexpensive evidence discovery
- **WHEN** the team needs bounded codebase or documentation reconnaissance
- **THEN** it creates a named `haiku-scout` teammate with no task mutation authority

#### Scenario: Task needs implementation or review
- **WHEN** a bounded lane requires implementation, diagnosis, or independent review
- **THEN** the lead may choose either `sonnet` or `opus` according to task shape rather than a fixed worker/reviewer label

#### Scenario: Teammate attempts nested delegation
- **WHEN** any teammate tries to start another subagent, teammate, fork, or Workflow
- **THEN** native `Agent` and `Workflow` are unavailable and the teammate completes or reports its own bounded task

### Requirement: Every internal delegation states route and acceptance
The team lead SHALL give every teammate a self-contained brief that explicitly
states the selected teammate type and its pinned model, intended effort, role,
current behavioral write authority, non-overlapping write surface when mutation
is authorized, acceptance evidence, and stop boundary. The lead SHALL select
the named teammate definition and SHALL NOT pass a call-level `model` argument
that overrides that definition. The orchestrator environment SHALL remove a
conflicting `CLAUDE_CODE_SUBAGENT_MODEL` override. Because teammates inherit the
lead's effort and current Claude Code exposes no per-teammate effort, the final
synthesis SHALL label intended effort separately from inherited or unknown
effective effort.

#### Scenario: Lead creates a named teammate
- **WHEN** the lead invokes `haiku-scout`, `sonnet`, or `opus`
- **THEN** it selects the pinned definition without a call-level model override and supplies a self-contained brief with intended effort, role, authority, scope, verifier, and stop boundary

#### Scenario: Effective effort is inherited
- **WHEN** a teammate starts under a lead effort
- **THEN** the final synthesis records the member's intended effort and labels effective effort as inherited from the lead or unknown rather than claiming a per-teammate override

### Requirement: Behavioral write authority applies to the whole team
A top-level `write: false` turn SHALL instruct the lead and every teammate not
to mutate task, workspace, repository, or external state, while allowing the
specific native local-memory maintenance required by the teammate definition.
A top-level `write: true` turn MAY authorize Sonnet or Opus teammates to mutate
only their assigned write surfaces and MAY allow an Opus lead to implement. A
Fable lead SHOULD delegate substantive implementation but MAY write plans,
documentation, integration changes, and small unblockers inside its declared
surface. Haiku SHALL remain behaviorally read-only under both top-level values.
These constraints SHALL be described as prompt-governed authority, not an OS
sandbox or process-permission boundary.

#### Scenario: Read-only team performs an audit
- **WHEN** an orchestrator turn has `write: false`
- **THEN** every delegated task forbids task-state mutation while explicitly allowing only native memory maintenance under `.claude/agent-memory-local/<member-type>/`

#### Scenario: Multiple teammates implement in parallel
- **WHEN** a `write: true` team delegates concurrent implementation to Sonnet or Opus teammates
- **THEN** each teammate receives a disjoint write surface and the lead performs only non-overlapping work until integration review

#### Scenario: Haiku scouts during a write-enabled turn
- **WHEN** a `write: true` team invokes `haiku-scout`
- **THEN** that teammate still receives no task mutation authority

### Requirement: Native teammates retain local persistent memory
The three stable teammate types SHALL use Claude Code native `memory: local` so
their curated learnings survive for the same project. The runtime SHALL
force-enable native Auto Memory after environment-file resolution. The Plugin
SHALL acknowledge that Claude may eagerly create and maintain
`.claude/agent-memory-local/<member-type>/` with ordinary file tools even in a
`write: false` turn. It SHALL NOT read, merge, lock, redirect, synchronize,
expose, or clean memory contents. Concurrent instances of one member type MAY
use Claude's native memory behavior without Plugin-side conflict resolution.

#### Scenario: A later Sonnet teammate starts in the same project
- **WHEN** a new team invokes the stable `sonnet` teammate type
- **THEN** Claude Code may load that type's existing local persistent memory without the Plugin copying prior transcripts

#### Scenario: Same type runs concurrently
- **WHEN** two Sonnet teammates are active in one team
- **THEN** the Plugin adds no memory lock or merge layer and leaves native memory contention to Claude Code

#### Scenario: Selected dotenv omits Auto Memory setting
- **WHEN** the one selected runtime env file omits or disables native Auto Memory
- **THEN** the effective Claude child environment still contains `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`

### Requirement: Communication stays inside the active native team
The lead and active named teammates MAY use the native shared task list,
automatic idle/failure notifications, and `SendMessage` for bounded evidence,
blockers, steering, and review handoff. The runtime envelope SHALL restrict
recipients to names in the current native team and SHALL forbid cross-session
addressing, machine-global `ListAgents`, guessing recipients, and peer-driven
completed-teammate resume. Only the lead MAY decide to send follow-up work to an
idle/completed current-team teammate. These recipient and resume limits SHALL
be identified as prompt-governed because `SendMessage` also supports other
local/remote Claude sessions.

#### Scenario: Teammate shares a blocker
- **WHEN** an active teammate needs evidence from another active teammate
- **THEN** it sends a bounded message to a name supplied by Claude's current-team roster

#### Scenario: Teammate is idle or completed
- **WHEN** a peer wants to send more work to that teammate
- **THEN** the peer reports the need to the lead rather than triggering native auto-resume

#### Scenario: Cross-session recipient is considered
- **WHEN** the lead or teammate considers a recipient outside the current native team
- **THEN** the envelope forbids the send and requires the parent synthesis to report the blocker instead

### Requirement: Teammate invocation stays in the current checkout
Every teammate brief SHALL require the named Native Agent Teams path and SHALL
forbid `isolation`, remote execution, worktree creation, conversation forks,
and ordinary unnamed subagent substitution. Native teammates MAY run
concurrently in the default in-process team mode; the lead SHALL use automatic
idle/failure delivery and the shared task list to join required work rather
than repeatedly polling or treating task status alone as completion proof.

#### Scenario: Lead creates an implementation teammate
- **WHEN** it invokes the native Agent tool for a team member
- **THEN** it supplies a deterministic current-team name and named member type, omits call-level model and isolation overrides, and assigns a self-contained current-checkout brief

#### Scenario: Shared task status lags
- **WHEN** a task entry remains nonterminal but the teammate reports its turn idle/completed
- **THEN** the lead inspects the actual deliverable and evidence instead of declaring the team blocked solely from the task-list label

### Requirement: Lead joins, verifies, and synthesizes the team
The team lead SHALL wait for every required teammate's native idle, failure, or
completion signal before returning and SHALL request graceful teammate shutdown
when no further work is needed. For mutation work it SHALL inspect the actual
diff, key verification receipts, and conflicts rather than concatenate
teammate summaries. Its one final result SHALL state the teammate types and
roles requested, pinned models, intended and inherited/unknown effort, which
teammates wrote, resulting changes and verification, and unresolved risks or
blockers. Codex SHALL remain responsible for cross-lane integration,
user-facing synthesis, and final acceptance.

#### Scenario: Teammates complete a write-enabled task
- **WHEN** all required teammates return implementation or review results
- **THEN** the lead examines the combined tree and evidence before producing one self-contained final synthesis

#### Scenario: A required teammate remains unresolved
- **WHEN** the lead cannot observe a required teammate settle or verify a conflicting write
- **THEN** it reports the exact blocker and does not claim the team completed successfully
