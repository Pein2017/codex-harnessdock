<h1 align="center">HarnessDock for Codex</h1>

<p align="center">
  <img src="plugins/codex-harnessdock/assets/harnessdock-logo.svg" width="150" alt="HarnessDock relay logo">
</p>

<p align="center"><strong>Let Codex lead durable Agents across Claude Code, Pi, and OpenCode.</strong></p>

<p align="center">
  <a href="https://github.com/Pein2017/codex-harnessdock/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Pein2017/codex-harnessdock/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-experimental-f59e0b">
  <img alt="Platform: Linux" src="https://img.shields.io/badge/platform-Linux-0f172a?logo=linux&logoColor=white">
  <img alt="Node.js 20.19 or newer" src="https://img.shields.io/badge/node-%E2%89%A520.19-339933?logo=nodedotjs&logoColor=white">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-2563eb"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#supported-harnesses">Harnesses</a> ·
  <a href="#typed-mcp-lifecycle">API</a> ·
  <a href="#operator-doctor-and-release-smoke">Doctor</a> ·
  <a href="#local-development-and-installation">Development</a>
</p>

HarnessDock is an experimental, checkout-owned Codex Plugin. It gives the Codex
lead one typed MCP lifecycle for starting, messaging, joining, interrupting, and
reusing coding Agents while each native Harness keeps ownership of its own
authentication, models, tools, plugins, MCP servers, and sessions.

```text
                                 ┌─ Claude Code  (stream-json)
Codex lead ── typed MCP ── HarnessDock ─┤─ Pi           (RPC)
                                 └─ OpenCode     (managed local server)
                                      │
                                      └─ durable Agent state
```

## Why HarnessDock

- **One explicit route contract.** Every spawn names the Harness, full native
  model, reasoning effort, topology, and behavioral authority. Nothing silently
  falls back to another route.
- **Durable Agent identity.** Work is addressed by a stable Agent name rather
  than an internal process or job ID. Messages, completion, and safe native
  continuation survive worker exit.
- **Native configuration stays native.** Pi and OpenCode routes are discovered
  from their live local configuration; HarnessDock does not maintain a second
  model catalog for them.
- **No babysitting terminals.** Detached workers and the managed OpenCode
  service are started by the Plugin. Pi and OpenCode run with zero-wait
  interaction policies instead of blocking the Codex lead for terminal input.
- **Fail closed, with receipts.** Route drift, stale policy, unsupported
  continuation, and missing native evidence are reported rather than guessed.

## Supported Harnesses

| Harness | Native surface | Durable behavior | Current boundary |
| --- | --- | --- | --- |
| **Claude Code** | Headless `stream-json` CLI | Exact-session follow-up, history, messages, interruption; experimental native orchestration on admitted routes | Explicit configured model and effort; no automatic model fallback |
| **Pi** | `--mode rpc` | Exact-session follow-up, history, active input, interruption | Dynamic native models/efforts; leaf only; unattended UI decisions |
| **OpenCode** | Managed loopback `opencode serve` | Fresh turns with durable HarnessDock completion | Dynamic native models/efforts; leaf only; no native history or interruption |

All three Harnesses remain Experimental. `write: false` and `write: true` are
prompt-level behavioral authorities, not OS sandboxes. Run untrusted work only
inside an isolation boundary you control.

## Quick start

The current local build is intentionally bound to the canonical checkout
`/data/CoordExp/codex-harnessdock` and supports Linux with Node.js 20.19 or newer.

```bash
git clone https://github.com/Pein2017/codex-harnessdock.git /data/CoordExp/codex-harnessdock
cd /data/CoordExp/codex-harnessdock
npm ci
npm run install:local
npm run doctor
npm run smoke:release
```

Reload Codex and start a new task. Discover the routes that are actually ready:

```text
$codex-harnessdock:list-harnesses
```

Then start one explicit Agent and join it:

```text
spawn_agent({
  task_name: "review_auth",
  message: "Review the authentication flow and report concrete defects.",
  harness: "pi",
  model: "openai-codex/gpt-5.6-luna",
  reasoning_effort: "low",
  topology: "leaf",
  write: false
})

wait_agent({ targets: ["/root/review_auth"] })
```

Use only a model/effort tuple returned by the fresh `list_harnesses` call. The
Agent starts asynchronously; no background terminal is required.

> [!IMPORTANT]
> HarnessDock cannot restart an already-ended Codex model turn. If the parent
> needs the result, it must call `wait_agent` before ending its active turn.

HarnessDock is an unofficial third-party project maintained by
[Pein2017](https://github.com/Pein2017). It is not affiliated with or endorsed
by OpenAI, Anthropic, Pi, or OpenCode.

## Typed MCP lifecycle

The Plugin exposes one stdio MCP server named `codex_harnessdock`. Its nine typed
tools delegate to `runtime/index.mjs`, which remains the sole lifecycle owner:

```text
list_harnesses({})
spawn_agent({ task_name, message, harness, model, reasoning_effort, topology, write, description?, target_worktree? })
dispatch_agents({ rows: [{ task_name, message, harness, model, reasoning_effort, topology, write, description?, target_worktree? }, ...] })
send_message({ target, message })
followup_task({ target, message })
wait_agent({ targets?, wake_on_progress?, acknowledge_tokens? })
interrupt_agent({ target })
read_agent_messages({ target, before?, limit? })
list_agents({ path_prefix? })
```

`spawn_agent` requires `harness`, `model`, `reasoning_effort`, `topology`, and `write` together;
`followup_task` accepts none of them, because an Agent's route and behavioral
authority are frozen at creation. A different route means a new Agent.
`dispatch_agents` is only a stateless ordered convenience for 1..8 independent,
complete spawn rows. It adds no shared defaults, retry, fallback, Team, DAG,
scheduler, batch identity, or cross-row rollback; use singular spawn for one Agent.

Codex sees the tools as:

```text
mcp__codex_harnessdock__list_harnesses
mcp__codex_harnessdock__spawn_agent
mcp__codex_harnessdock__dispatch_agents
mcp__codex_harnessdock__send_message
mcp__codex_harnessdock__followup_task
mcp__codex_harnessdock__wait_agent
mcp__codex_harnessdock__interrupt_agent
mcp__codex_harnessdock__read_agent_messages
mcp__codex_harnessdock__list_agents
```

The installed Plugin also exposes the same nine namespaced skills as
orchestration guidance:

```text
$codex-harnessdock:list-harnesses
$codex-harnessdock:spawn-agent
$codex-harnessdock:dispatch-agents
$codex-harnessdock:send-message
$codex-harnessdock:followup-task
$codex-harnessdock:wait-agent
$codex-harnessdock:interrupt-agent
$codex-harnessdock:read-agent-messages
$codex-harnessdock:list-agents
```

Successful `spawn-agent` calls return a compact Agent Card: `agent_name`, its
`harness` and nullable `route_maturity`, `model`, nullable retained
`reasoning_effort`, behavioral `authority`, immutable `delegation_mode`,
`status`, safe `phase`, nullable timestamps, and query-time elapsed seconds.
`write: false` is behavioral read/review authority, not a process sandbox; its
enforcement is route-specific and observable. The parent reports one concise
sentence with the model role, Agent name, authority, and status—never final
model text or raw JSON.
`send-message` and `followup-task`
return only `agent_name` plus their delivery disposition. `interrupt-agent`
returns only `agent_name` and operation status. `list-agents` reports compact
Agent Cards with the same retained model/effort, behavioral authority,
delegation, safe phase, and nullable timing evidence while keeping delivery and
internal execution evidence out of the list surface. Deeper evidence remains
available through operator diagnostics.
`wait-agent` reports at most one update for an untargeted call: by default a
completion with the complete stored final message for parent synthesis,
or one coalesced safe
progress update when explicitly requested. The model-facing wait has a fixed
3,600,000 ms (one-hour) completion-first window and accepts no timeout
argument. When the dependency set is known, `targets` accepts one to eight
unique exact current-root Agent identifiers. One target joins its fixed turn
and may combine with `wake_on_progress: true` for one target-scoped advisory
update. Multiple targets return one completion-only all-settled barrier in
caller order and cannot combine with progress wakeup. A barrier timeout is
status-only with no partial completion delivery.
Completion and settled barrier receipts additionally carry optional closed
metrics: provider-reported durations, turn/tokens, and `reported_cost_usd` when
present, plus Plugin-observed tool/attempt counts. Reported cost is not a
subscription bill or charge estimate. After a bounded reconnect, provider
fields describe the final native attempt; Plugin attempt/recovery/tool counters
span the retained attempts.
`read-agent-messages` retrieves recent outer-assistant text from the exact
Agent's admitted native history without activation.

The runtime model surface normalizes accepted aliases to four canonical IDs:
`claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5`, and
`claude-fable-5`. Relative Plugin guidance, not exact pricing: approximate
capability and spend rise from Haiku < Sonnet < Opus < Fable. Haiku is the
cheapest/fastest option for tests, real smoke, and small mechanical work;
Haiku/low is the recommended real-smoke route, not a test-only restriction.
Sonnet is the balanced default for general coding. Opus is for deep analysis,
complex work, or high-risk implementation and review. Fable is the highest
capability/spend choice for core decision discussion and planning, generally not
routine code writing. Before launch, state the selected model's role/tier.

Every initial spawn selects a model explicitly and persists its canonical full
ID; there is no implicit model or fallback, and partial IDs are rejected. All four models accept `low`,
`medium`, `high`, `xhigh`, or `max`; model and reasoning effort remain separate
arguments, and `x-high` maps to `xhigh`. Older model IDs, dated backend snapshot
IDs, and other Claude models fail before Claude launches. Follow-up turns
inherit the Agent's selected model.

Pi routes come from the local RPC model catalog. Every new Pi turn, including
an exact-session follow-up, explicitly supplies one freshly discovered full
model and supported effort; there is no default effort, model substitution, or
automatic recovery.

Every Agent states an immutable `topology`. A `leaf` Agent runs its own task;
for Claude that maps to the runtime's `delegation_mode: "leaf"`, which appends a
bounded Codex-lead role envelope and denies Claude Code's native `Agent` and
`Workflow` tools. Only exact `claude-opus-5` or `claude-fable-5` with
`topology: "native_orchestrator"` may act as an experimental Native Agent Team
lead; Pi and OpenCode admit `leaf` only; Pi native orchestration is
disabled. The public registry stays flat: only
the durable parent is a HarnessDock Agent. Initialization definition/tool names are
necessary, but transport is live-validated only after a named member launches
asynchronously and a correlated `SendMessage` to that launched member name
succeeds. A synchronous Agent result, an uncorrelated message, or a failed
message is Harness-incompatible and is not accepted as team work. Haiku and Sonnet remain leaves; ordinary Opus
and Fable turns remain leaves. `Workflow` remains denied; public follow-ups
inherit the mode and form a fresh native team rather than resuming in-process
teammates.

Each lead injects only the stable `haiku-scout`, `sonnet`, and `opus`
definitions, whose exact pinned models are requested definitions rather than
proof of effective teammate model. The brief states intended effort, while
effective teammate effort inherits the lead or remains unknown; effective model
and cost also remain unknown unless native structured facts prove them. Native
`memory: local` may maintain only `.claude/agent-memory-local/<member-type>/` in
a read-only turn; the Plugin never reads, copies, locks, merges, or exposes
memory contents. `write` is behavioral authority, not an OS sandbox.

The one-layer depth and teammate `Agent` denial are hard topology boundaries.
At most three active teammates and six total creations are behavioral budgets;
the concurrency environment is only a residual guard if forbidden ordinary
subagent execution is attempted. Current-team `SendMessage`, shared tasks, and
native idle/failure delivery are Claude-local coordination only. Current-team
recipient and completed-peer-resume limits are behavioral/prompt-governed:
native `SendMessage` can technically reach other sessions, and the Plugin adds
no hard containment, mailbox, or teammate lifecycle. A lead joins required
native settle evidence, inspects actual work, and
returns one parent synthesis. Orchestrator transport has zero automatic
reconnect attempts; an explicit parent follow-up starts a fresh cohort/team.

The public Agent API has no tool allow-list. Terminal parity inherits ordinary
Claude tools, MCP servers, hooks, skills, and configuration, with only the
topology-owned `Agent`/`Workflow` denials above. If progress requires a decision
only the Codex lead or user can make, the Agent ends its turn with the exact
question and supporting evidence so the same durable session can continue.

An authoritative Driver `usage_or_subscription_limit` failure ends subsequent
real CC tests in that workflow. Compatibility text fallback is deliberately
narrow: explicit subscription, allowance, credit, or quota exhaustion; generic
HTTP 429 remains eligible for bounded exact-session recovery, and a
caller-imposed maximum budget is not an account-limit signal. The runtime does
not reconnect or substitute another model, while local code work and fake-Claude
tests may continue.

Each fresh Agent session receives its durable Agent name through Claude's
`--name` option. This preserves a useful Claude-side label and avoids the
auxiliary title-generation model call observed for unnamed sessions; resumed
sessions keep their existing identity and are not renamed.

Plugin skills necessarily remain namespaced; they are not literal replacement
registrations for Codex built-in tools. Each guides the matching typed MCP
tool. If the MCP server is unavailable, the model reports an actionable Plugin
discovery/startup failure instead of silently falling back to a shell command.

`spawn_agent` and an activating `followup_task` are asynchronous at the Agent
boundary: they return after the durable detached-worker handoff, so no Codex
background terminal is needed. `wait_agent` is the explicit synchronous join.
Model-facing callers use a fixed completion-first 3,600,000 ms (one-hour)
upper bound and return immediately when completion arrives; they do not pass a
timeout. Set `wake_on_progress: true` only for one intentional intermediate
progress observation; optionally combine it with exactly one target to observe
only that fixed Agent turn. The next call defaults back to completion-first.
Cancelling the MCP call stops only that observation; it never interrupts or
cancels the Agent.
Codex MCP calls do not expose Unified Exec terminal session IDs, and this
Plugin deliberately does not add a second background-terminal/session layer.

## Agent model and V2 alignment

An Agent belongs to the logical Codex root that created it. Its path is flat:
`/root/<task_name>`. Names are unique within that root. Mutating operations
accept only an exact Agent ID, full path, or normalized name; prefixes are
valid only for `list_agents(path_prefix)`. Exact `/root` means the same
unfiltered current-root view as omitting `path_prefix`; `/root/...` narrows it.

This is a logical default-isolation boundary against accidental cross-root
orchestration, not a cryptographic authorization mechanism. Normal plugin
operations never accept an owner/root override. A redacted `--all` diagnosis is
reserved for a separate operator CLI and cannot message, follow up, interrupt,
wait on, or acknowledge foreign Agents.

The public names and core semantics align with Codex Multi-Agent V2 where the
native Claude process permits it:

| Surface | Codex Multi-Agent V2 | HarnessDock for Codex v0.18 |
| --- | --- | --- |
| Operations | Six built-in snake_case tools | The same six lifecycle names plus the `read_agent_messages` native-history extension, exposed as namespaced hyphenated skills |
| Spawn | `task_name`, `message`, `fork_turns` | `task_name`, self-contained `message`, exact `model`, and explicit `write`; the runtime never inherits Codex turns |
| Targeting | Agent tree | Flat `/root/<task_name>` topology; exact mutation target |
| Send / follow-up | Message versus activation distinction | `send_message` queues an idle Agent; `followup_task` guarantees delivery or activation |
| Wait | Untargeted mailbox activity/timeout; completion separately enters parent mailbox | Completion-first event-wakeup join; one exact target is a single-turn join that may expose one explicit safe progress milestone, while multiple targets remain a completion-only all-settled barrier |
| History | No model-facing transcript reader | Root-scoped recent outer-assistant history from the Agent's admitted native history |
| Residency | Runtime can unload and reload | Claude turns exit; Pi retains exact-session continuation; logical terminal history remains listed when its route supports it |

`list_agents` intentionally includes logical nonresident terminal history.
`wait_agent` is also intentionally narrower than a host-agent mailbox: it
wakes for the current root's durable Agent activity, not arbitrary Codex
inter-agent messages or a new user steer. Like Codex V2, `spawn_agent` never
auto-waits, completion wakes a blocked wait, and an already-idle/final parent is
not automatically restarted.

The parent chooses one of three policies: required work must complete before
final; parallel-then-join work runs alongside useful non-overlapping parent
work and joins before its dependency boundary; explicitly detached work is
allowed only when the user requests background execution and the result is not
needed in the current answer. Calls to `wait_agent` should be sparse: an
ordinary join omits progress wakeup, and one explicit progress observation must
not turn into reflexive polling. After its bounded observation, `wait_agent`
reconciles current-root terminal facts and, unless that observation already
returned a completion, takes one further zero-time completion-only look at the
same observation scope before returning; an eligible completion visible there
replaces a stale timeout or claimed progress update. An untargeted timeout means
no unread current-root completion was visible there. A targeted timeout means
only that its fixed selected turn had no eligible result; unrelated root
activity may still exist.
Quiet wait timeouts are not failures and should not trigger repetitive
narration or an immediate `list_agents` or `read_agent_messages` call made
solely to recheck completion. If required work remains unresolved after that
quiet timeout, the parent calls `wait_agent` again directly.

Public fork/profile selectors, `agent_type`, Codex service-tier routing, and
Claude session adoption fail explicitly rather than being ignored or injected
into a prompt. Direct Terminal-session adoption is deferred to a future
OpenSpec change.

There is no public `cancel`, `cancel_job`, archive, close, delete-history, or
Agent deletion operation. `interrupt_agent` stops only the current turn. A
successful Claude graceful interruption retains exact-session continuation when
the receipt proves it; forced termination without flush evidence becomes an
errored, non-resumable turn while preserving the Agent record. A Pi interrupt
request is nonterminal and may report `settlement_unknown`; wait for settlement
before deciding whether its exact session can continue. Its public receipt
contains only `agent_name` and `status`; control evidence stays in operator
diagnostics.

## Durable delivery and continuation

`send_message` records a durable Agent-mailbox entry. It delivers to an active
turn when possible. Pi acknowledges active input; its exact native session
serializes that input. For an idle resumable Agent it returns `queued_no_turn`
and does not start a native process. Its successful public receipt contains only
`agent_name` and `delivery`; complete message, assignment, job,
steering, and timestamp evidence remains in the durable operator state.
`followup_task` uses the same mailbox but guarantees work: it delivers to an
active turn, or starts one exact-session or receipt-proven safe-fresh turn and
assigns queued entries in order. Pi resumes only its exact session and never
safe-fresh recovers. Its successful public receipt contains only
`agent_name` and `delivery`.

If an Agent's first activation ends in `auth_or_permission`, the failure and
its `auth_required / harness / operator_required` completion remain immutable.
After the operator refreshes native OAuth credentials in the fixed
`CLAUDE_CONFIG_DIR`, an activating `followup_task` may reuse that same logical
Agent through a new safe-fresh Claude session only when the credential file has
a different redacted filesystem generation, its access expiry is locally
current, and the failed turn proves no tool use, file touch, or useful
assistant output. The original task messages are requeued with the same IDs and
delivered once together with the follow-up. Later-turn failures, legacy records
without this evidence, API-key rotation, foreign config state, and ambiguous
side effects remain blocked. `send_message` never performs this recovery.

`wait_agent` first checks the current root's durable completion mailbox.
Model-facing MCP calls use a fixed 3,600,000 ms (one-hour) observation upper
bound and accept no timeout argument. The checkout CLI and direct runtime
operation instead keep their existing 10-minute default and accept an
explicit 0..3,600,000 ms diagnostic timeout. Either surface returns
immediately on completion rather than waiting for its upper bound.
An ordinary wait neither returns nor claims safe public progress. With
`wake_on_progress: true`, the call may return one advisory update containing
only a generic activity/phase summary plus, at most, a sanitized tool name;
Claude response, thinking, tool arguments, paths, hook payloads, receipts, and
session IDs stay private. With exactly one target, that progress observation
is scoped to the snapshotted target job; unrelated root activity remains
untouched. Multiple-target barriers never expose progress. Repeated routine
activity is coalesced into the latest revision and remains subject to an
adaptive 5, 10, 20, then 30 second
eligibility backoff. Retry, reconnect, and first-response transitions reset
that backoff, while completion always bypasses it.

A completion update includes the complete stored final message and a
legacy-compatible truncation flag. New completions are not truncated by this
Plugin; an older event that already lost bytes retains its honest provenance.
It remains unread until a later call echoes its token, so a lost host response
safely redelivers the same message. If the parent performs another `wait_agent`
call, that next call may pass prior delivered completion tokens independently;
each consumed token is passed exactly once. If it ends
after consuming the handoff, no acknowledgement-only call is required. The
parent should synthesize it directly;
it must not start a follow-up, read history, or ask Claude to write a
temporary/repository file solely to recover the current completed result.
Legacy unowned events remain stored but cannot block Agent-linked delivery.
Repeated `list_agents` calls are
state-only.

`read_agent_messages` is a retrospective read-only extension. It defaults to
the latest one eligible message, supports newest-first `before`/`limit`
pagination with a 20-message maximum per call, and never truncates message text.
It resolves only an exact current-root Agent and derives the transcript from
that Agent's persisted config/session/workspace binding. It does not accept a
path or session ID and exposes no thinking, tool data, attachment, subagent
transcript, or Codex history. Claude's native `cleanupPeriodDays` remains the
history-retention authority; missing or expired history fails explicitly.

Job receipts are bounded internal execution evidence. Agent identity, session
binding, mailbox entries, and completion projection survive worker exit and
job pruning. The terminal job receipt is the reconciliation fact source; the
registry and inbox are rebuildable projections.

## Execution profiles

`terminal-parity` is the default. It selects the caller's explicit supported
model, sets `IS_SANDBOX=1`, and always adds
`--dangerously-skip-permissions` so headless Bash, MCP, hooks, and other native
tools do not stop for permission prompts. Read/review intent (`write: false`, or
omission for direct runtime callers) is enforced by the appended delegation
prompt and is not an OS-enforced read-only sandbox. Explicit mutation intent
(`write: true`) permits only task-scoped changes in that prompt. The profile otherwise
leaves effort, settings, tools, MCP configuration, hooks, memories, skills,
plugins, and prompts to the native Claude configuration unless the caller
explicitly supplies an override. Model-facing spawn guidance always passes the
intent explicitly; follow-up omission inherits the Agent's latest activation.

Every Claude Agent has Claude Code native Auto Memory enabled through the fixed
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` environment value. This is Claude's
force-enable spelling despite the inverse variable name; it is not a
`CLAUDE.md` substitute. The Plugin does not provide `autoMemoryDirectory` or
copy memory into prompts or receipts. Claude keeps one native memory directory
per Git repository, shares it across that repository's worktrees and
subdirectories, and creates content lazily when it finds something worth
remembering.

Native Agent Team member definitions additionally use Claude-native `memory:
local`. This is a Claude-owned write exception under the member-specific local
memory path, including when the parent is `write: false`; no Plugin memory
database, cleanup, synchronization, or content inspection exists.

`safe` remains an explicit opt-in profile. It supplies the runtime-owned
sandbox, permission, and read-only tool policy while retaining the Agent's
caller-selected model. This permission choice affects only the Claude child;
the plugin does not change the parent Codex permission policy.

## Claude Code updates and compatibility

Claude Code remains an independently updated host dependency. The fixed
`CODEX_HARNESSDOCK_CLAUDE_BIN` in `config/runtime.env` selects the user's normal installed
Claude entrypoint; an update may replace its target in place without changing
that path. Updating Claude Code does not require reinstalling this Plugin.
Already-running Claude processes keep their launch-time version, while a later
new or resumed turn uses the newly admitted executable.

Before a new Agent or idle follow-up is persisted, readiness fingerprints the
configured executable from its canonical target, filesystem identity, and
`claude --version` output. An unseen fingerprint receives a zero-model-cost
`claude --help` check for the exact flags and values emitted by terminal-parity
and safe profiles. The result is cached in owner-only workspace state until the
fingerprint or runtime surface revision changes. Missing flags, probe failure,
or a binary that changes during the check fails closed without creating a new
Agent activation or falling back to another executable, model, or effort.

Static compatibility is deliberately not called full stream-protocol proof.
Readiness reports `static_only` for a newly admitted version and
`observed_working` after an ordinary requested turn completes with a matching
runtime-reported Claude version and a post-turn resample confirms the complete
prepared executable fingerprint is unchanged. The runtime never spends
subscription quota on an automatic compatibility probe. To verify a new
version through the complete production path, explicitly spawn Haiku 4.5 with
`low` effort and a minimal task, then wait for that Agent normally.

The prepared fingerprint is stored with each job and checked again by the
detached worker before Claude launch. A change in that interval starts no
Claude child and sends no prompt; retrying prepares against the new version.
Active-turn steering continues to target its already-running admitted process.
Inspect the current evidence without a model call with:

```bash
node plugins/codex-harnessdock/bootstrap/harnessdock-runtime.mjs readiness
```

## Pi (Experimental)

Pi is a first-class native-session Harness. At discovery time, HarnessDock asks
the local Pi RPC process for its available provider/model routes and the
thinking levels supported by each route. Every new turn still names one freshly
advertised full model and effort explicitly; HarnessDock supplies neither a
default nor a substitute. Pi is `leaf` only.

Both `write: false` and `write: true` preserve Pi's native tools and local
configuration. The difference is an explicit prompt-level behavioral contract,
not a process-permission switch. The turn prompt also tells Pi to make a
reasonable decision instead of asking the user. If an extension nevertheless
opens RPC UI, HarnessDock resolves it without waiting: confirms continue,
selects use the first option, and text/editor requests use their prefill or an
empty value.

There is no global Pi capacity ceiling, but the same exact native session is
serialized. Pi resumes that exact session only, acknowledges active input, and
keeps asynchronous assistant history available through `read_agent_messages`.
It has no automatic recovery and no native orchestration. An interrupt request
is nonterminal and may return `settlement_unknown`; wait for settlement before
another turn.

## OpenCode (Experimental)

OpenCode is a native local-server Harness. HarnessDock can start the configured
`opencode` executable when the fixed endpoint is absent; it does not install
OpenCode, authenticate accounts, or rewrite the user's provider/model
configuration.

- **Server.** One loopback Server, named by `OPENCODE_SERVER_URL` in the tracked
  environment file (default `http://127.0.0.1:4096`). The Driver admits only a
  literal loopback origin, never a DNS name, and refuses proxy routing for it.
  A healthy compatible Server is reused; otherwise the Plugin starts an exact
  owned process with a receipt. A proven owned Server is eligible for idle
  cleanup after one hour by default; Agent records and results are retained.
- **Authentication.** Optional Basic-auth credentials are read only from the
  operator process environment through an exact allowlist
  (`OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`). They are never
  tracked in the environment file and never appear in receipts, errors, logs,
  instance keys, or any model-facing listing.
- **Interaction policy.** The managed child and every created session use a
  zero-wait policy: ordinary permissions and `doom_loop` are allowed, while
  `question`, `plan_exit`, and nested `task` requests are denied. The Driver
  validates the live primary Agent policy and blocks the Harness if it drifts
  back to an interactive path.
- **Route.** Models and efforts are imported from the live OpenCode provider
  catalog. Each spawn must name one freshly advertised exact tuple, `leaf`, and
  either behavioral authority. There is no HarnessDock capacity ceiling and
  continuation is `fresh_only`. Interruption and assistant history are
  unsupported and answer with a receipt rather than an error. Driver and
  capability maturity remain Experimental.
- **CLI attach is diagnostic only.** Attaching to the Server with the OpenCode
  CLI is an operator debugging aid. It is never a runtime dependency, never a
  fallback path, and no Skill or MCP tool may invoke it. TUI automation is
  forbidden.

Inspect what is admitted and ready, for all admitted Harnesses, without a model call:

```bash
node runtime/operator-cli.mjs list-harnesses --all --json
```

Model-facing callers use `$codex-harnessdock:list-harnesses` for the same facts.
Either surface reports readiness; neither selects a route.

## Route refusal is Codex-led

The Plugin never falls back on its own. A route it cannot serve -- an
unavailable Harness, a model that Harness does not admit, a topology or
authority its capabilities refuse, or a capacity-limited instance already at capacity -- is
reported as a refusal with a closed reason. It is never silently retried on
another Harness, another model, or another instance, and an unavailable Harness
is never removed from the static registry. Codex decides what to do next and
states the next route explicitly.

## Operator doctor and release smoke

Run the unified operator doctor after a Codex or Claude Code update, after a
local Plugin refresh, or when MCP discovery behaves unexpectedly:

```bash
npm run doctor
npm run doctor -- --json
```

Doctor covers the Claude CLI, the fixed environment, and the installed
snapshot; it does not probe the operator's OpenCode Server. Use
`list-harnesses --all` for that Harness's readiness, and treat an unavailable
reading as an operator fact rather than a Plugin defect. Doctor is
zero-model-cost and not exposed as a Skill or MCP tool. It checks the
canonical checkout and installed snapshot, production Node dependencies,
Claude CLI version/static compatibility and login, the fixed Claude config and
9090 proxy envelope, exactly nine
MCP tools, bounded checkout-routed compatibility shells, their durable predecessor
coverage, and aggregate local storage. A first install is reported explicitly with no
invented predecessor; an unmanaged legacy installation warns that coverage is unavailable.
Its
output is redacted: it never reports account email, organization IDs, tokens,
proxy credentials, arbitrary environment values, prompts, messages, or session
contents. A required failure exits nonzero with a recovery command.

Storage diagnosis is read-only and dry-run only. It counts Agent registry and
status records, jobs, completion inbox events, runtime files, and native Claude
JSONL history. Conservative Plugin cleanup candidates are limited to stale
reservation/atomic-temp files and safe terminal receipts beyond the existing
newest-100-per-owner retention boundary. It never reconciles or acknowledges
lifecycle state, and it never treats anything under `CLAUDE_CONFIG_DIR` as a
Plugin cleanup candidate. Claude history older than 30 days is an observation,
not deletion authority.

The separate operator usage report reads Codex's persisted rollout events and
selects only completed MCP calls whose server is exactly `codex_harnessdock`. It is
not a Skill or MCP tool, performs no Claude call, defaults to the preceding
seven 24-hour periods, and requires explicit cross-task scope:

```bash
node runtime/operator-cli.mjs usage-report --all --json
node runtime/operator-cli.mjs usage-report --all \
  --days 7 --until 2026-08-09T00:00:00.000Z --json
```

The fixed UTC report globally deduplicates replayed non-empty call IDs and
aggregates tool errors, wait outcomes, selected spawn routes, completion
redelivery, terminal status, and closed metrics. `reported_cost_usd` remains a
provider-reported runtime field, never a billed-cost or subscription-price
estimate. The reader scans retained rollout files oldest-first and reserves a
non-empty call ID before applying the report window. Consequently a historical
call copied into a later Codex fork cannot be redated into the report. A no-ID
record from a fork, or any record from a fork whose direct parent rollout is no
longer retained, fails closed because its provenance cannot be resolved. The
report emits no prompts, final messages, assistant history, raw
tool arguments/output, environment values, native sessions, internal jobs, or
absolute evidence paths.

Acceptance is never inferred from completion, acknowledgement, tests,
follow-up, terminal status, or metrics. After the lead/operator actually
dispositions a delivered result, record that exact opaque token explicitly:

```bash
node runtime/operator-cli.mjs record-disposition \
  --delivery-token <token> \
  --disposition accepted_first_pass
```

The other admitted outcomes are `accepted_after_correction`,
`rejected_or_escalated`, and `surface_failure`. The append-only owner-readable
ledger stores only a one-way token digest, outcome, schema version, and
timestamp. A completion without a valid explicit record remains `unknown`.

The default release smoke also costs no Claude model usage:

```bash
npm run smoke:release
npm run smoke:release -- --json
```

It resolves the enabled `codex-harnessdock@pein-local` installation, requires an exact
checkout/snapshot match, discovers exactly nine installed Skills, launches the
absolute canonical-checkout descriptor bootstrap, lists exactly nine MCP
tools, verifies at most two discovery-only compatibility shells plus the durable
successful-version coverage record, and calls
`list_agents` with a synthetic root and temporary runtime home. This exercises
the fresh host-load and protocol boundaries used by a new Codex task without
claiming to run a paid Codex model turn or touching production Agent state.

Only separately authorized paid native-team acceptance may add one real Claude
turn through the production Driver/profile/adapter seam in a disposable Git
workspace, never the source checkout. Run it explicitly with:

```bash
npm run smoke:release -- --native-team-witness
```

This is mutually exclusive with `--real-claude`, announces its paid
`claude-opus-5`/`low`/`write:false` intent before launch, resolves the normal
runtime environment, and performs Driver preflight plus prepared revalidation
for the actual executable and fingerprint. It requires Haiku scout/Sonnet
reviewer definitions, correlated member-launch and named-team transport proof,
and one parent synthesis. Teammate settle is explicitly reported as
unobservable for that executable: native mailbox/hook delivery is not a stable
top-level stream event, so it is neither invented nor a verification
requirement. It permits only the two corresponding local-memory prefixes,
recursively records capped content-free path metadata there without opening any
`.claude/agent-memory-local/**` file, and leaves missing structured evidence or
snapshot overflow unverified. Any other disposable mutation or any source
change fails acceptance. Assistant prose cannot fill those gaps. No MCP field,
IPC channel, public receipt, or durable teammate state is added.
The command always prints its structured witness report; it exits nonzero unless
that report has `liveVerified: true`. An `account_limit_stopped` report remains
structured unverified evidence, not a model-quality conclusion.

The older explicit smoke flag remains one ordinary Claude acceptance turn:

```bash
npm run smoke:release -- --real-claude
```

That extension announces and uses exactly `claude-haiku-4-5`, effort `low`, and
`write: false`. It runs at most one read-only Bash `pwd` task to prove the
headless permission path; an explicit subscription, quota, credit, or
usage-limit failure stops paid CC testing immediately. Generic HTTP 429 remains
distinct.

## Environment

The installed MCP bootstrap and the operator Agent-listing path load exactly
`/data/CoordExp/codex-harnessdock/config/runtime.env`. The operator usage report
and disposition recorder need only `CODEX_HOME` and do not initialize Claude.
`--env-file`,
`CODEX_HARNESSDOCK_RUNTIME_ENV_FILE`, `${CODEX_HOME}/.env`, and workspace `.codex/.env` are not
environment selectors for `cc:*`. The public CLI rejects `--env-file` rather
than pretending to honor it.

The fixed file is parsed as literal `KEY=VALUE`, never evaluated as shell code.
It authoritatively pins `CLAUDE_NATIVE_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`,
Claude native Auto Memory enabled with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`,
`CONDA_EXE`, the Claude binary, OpenCode's loopback
`OPENCODE_SERVER_URL`, lower- and upper-case 9090 proxy variables, and localhost
bypasses. Those values overlay conflicting inherited values; valid unrelated
host state such as `PATH`, Codex root identity, and runtime-state location is
preserved. Receipts expose only selected non-secret fields and redact proxy
credentials.

`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` are the one deliberate
exception to that file's authority: they are read only from the operator process
environment through an exact allowlist, are never tracked in the file, and are
removed from the environment the runtime passes onward. They appear in no
receipt, error, log, instance key, or model-facing listing.

Readiness and `doctor` inspect credential metadata only. Their
`liveValidated: false` field is intentional: a successful local `claude auth
status` process or a locally current expiry does not prove that the provider
will accept the next headless turn. Credential observations never retain bearer
tokens, token hashes, account email, organization, scopes, prompts, or native
session content.

Every MCP call is bound to the trusted Codex `_meta.threadId` and local
`_meta["codex/sandbox-state-meta"].sandboxCwd`; tool arguments cannot select a
cwd, environment, owner root, or native Claude session. Before calling a skill,
confirm Codex is operating in the checkout or worktree where Claude should
work. The operator CLI still inherits its host process cwd and rejects
`--env-file`. Private detached-worker reconstruction and the explicit read-only
operator diagnostic retain their own context controls; Plugin skills never
expose them.

## Migration from 0.1

No compatibility aliases remain. Migrate calls by addressing the stable Agent,
not an internal job ID:

| Removed v0.1 surface | v0.3 canonical replacement |
| --- | --- |
| `run` / `start` | `spawn_agent` with `task_name`, self-contained `message`, explicit supported `model`, and explicit `write`; Haiku/low is the recommended real-smoke route |
| `steer <job>` | `send_message <target> <message>` |
| `steer --follow-up <job>` / `followUp` | `followup_task <target> <message>` |
| `status` / `result` | `list_agents` and untargeted `wait_agent`; use `read_agent_messages` only for earlier native messages |
| `interrupt <job>` | `interrupt_agent <target>` |
| `cancel` | Removed; use `interrupt_agent` for graceful stop semantics |

Agents created before v0.3 may not contain a persisted model selection. The
runtime backfills it only when an exact supported model is proven by a retained
receipt or the bounded tail of the Agent's Claude session artifact. A terminal
Agent whose historical model is unsupported or cannot be proven remains
visible with its history intact, but continuation is blocked; the runtime never
substitutes Haiku 4.5, Sonnet 5, Opus 5, or Fable 5. An active legacy turn
without model evidence is left running and migration is deferred. If a
previously unproven artifact later records an exact supported model,
reconciliation restores exact-session continuation automatically.

## Local development and installation

Development uses two fixed tracks:

| Role | Path | Branch |
| --- | --- | --- |
| Live runtime | `/data/CoordExp/codex-harnessdock` | `main` |
| Implementation and verification | `/data/CoordExp/codex-harnessdock-dev` | `developer` |

Make and verify changes only in the development checkout. Once its changes are
committed and both worktrees are clean, run `npm run promote:local` from
`/data/CoordExp/codex-harnessdock-dev`. Promotion runs the full repository check
and fast-forwards `main` to the exact tested `developer` commit. It never
commits, pushes, installs the Plugin, or restarts Codex, and it fails rather
than merging divergent histories.

The promotion receipt classifies the exact diff. `hot_compatible` means current
Codex tasks observe the implementation on their next MCP call. A
`restart_required` receipt identifies the decisive static paths and prescribes
only the preparation they require: checkout-only server/configuration changes
need a new task but no Plugin refresh; dependency, discovery, or API-generation
changes add `npm ci`, `refresh:local`, or `release:local` as appropriate. During
the brief Git update, new Worker module imports wait at
the promotion gate; already-loaded MCP operations and detached Claude turns
continue normally.

Run from this checkout:

```bash
npm ci
npm run check
npm run doctor
node runtime/cli.mjs readiness --json
npm run install:local
npm run smoke:release
```

`runtime/cli.mjs` and `plugins/codex-harnessdock/bootstrap/harnessdock-runtime.mjs` remain
operator/debug surfaces. Model-facing lifecycle calls use the typed MCP tools;
there is no automatic shell fallback.

`package.json` is the one manually maintained release base-version source. MCP
server metadata reads it directly, while cachebuster refresh derives the Plugin
manifest base and appends exactly one `+codex.<timestamp>` suffix. Do not update
the MCP or manifest base independently. If either installed bootstrap cannot
resolve the MCP SDK or Zod from the checkout, it reports a concise instruction
to run `npm install` in `/data/CoordExp/codex-harnessdock` instead of relying on a
generic Node module-loader stack.

The repository-local marketplace is `.agents/plugins/marketplace.json`; its
plugin source is the intentionally small `plugins/codex-harnessdock/` subtree.
`npm run install:local` performs the one-time local-marketplace binding and may
explicitly rebind a mismatched `pein-local` root to this independent clone. It
does not remove the plugin. After that:

- Compatible runtime edits behind `runtime/index.mjs` need no install command.
  Every MCP operation runs in a fresh worker module graph, so an existing task
  observes the edit on its next call. Agent/session state remains in the
  checkout-owned durable runtime and is not duplicated by the worker.
- Same-generation Skill, metadata, manifest content, `.mcp.json`, annotation,
  or bootstrap edits use `npm run refresh:local`. It reinstalls the same
  manifest version and fails closed if the marketplace root drifted. Existing
  tasks retain their already-discovered Skill/schema snapshot, so use a new
  task when accepting those discovery changes.
- Public tool schema, adapter/runtime call-contract, or release changes use
  `npm run release:local`. It advances one cachebuster and installs a versioned
  snapshot. Increase `HARNESSDOCK_MCP_API_GENERATION` for an incompatible public call
  contract; a stale task then receives `HARNESSDOCK_MCP_RESTART_REQUIRED` before any
  lifecycle operation and must start a new Codex task.

During local installation, the installer first stages the current and recent valid
discovery files into the owner-only archive
`$CODEX_HOME/plugins/data/codex-harnessdock/compatibility-shells/v1`. After Codex replaces its
Cache entry, the installer restores at most two non-current versions as exact,
discovery-only compatibility shells and records the successful current version plus
two predecessors. A known predecessor missing from both Cache and archive stops the
install before Codex runs; a first install records that no distinct predecessor exists.
The archive and restored shells use an exact file whitelist and contain no runtime
source. Every descriptor/bootstrap delegates lifecycle execution to
`/data/CoordExp/codex-harnessdock`; never hand-edit either the archive or Plugin Cache.

An already-running Codex task should keep using the exact versioned Skill path it
resolved. If that path is unexpectedly missing, reading the latest Skill is an
emergency aid, not proof that its schema or generation matches. Run `npm run doctor`,
repair coverage with `npm run release:local`, and start a new Codex task whenever the
MCP returns `HARNESSDOCK_MCP_RESTART_REQUIRED`. Versions older than the two retained
predecessors are outside this bounded compatibility promise.

Verify the installed snapshot has exactly the nine Experimental skills and
one `codex_harnessdock` MCP server whose descriptor-only bootstrap delegates only to
`/data/CoordExp/codex-harnessdock`.

## Activation runbook

Production promotion, identity/data cutover, install/refresh, Codex restart, the
installed smoke, and the three authorized live OpenCode examples are operator
steps, not repository steps. They are sequenced, each with its verification and
its rollback note, in [`docs/activation-runbook.md`](docs/activation-runbook.md).

## Architecture roadmap

Sequenced, not scheduled. Each item below is a separate accepted change; none is
a placeholder in the current API. The multi-Harness plan of record is
`docs/handoffs/2026-08-13-multi-harness-implementation.md`, which this section
links rather than restates.

- **Phase R -- physical rename.** This historical pre-admission sequence placed
  the remaining `cc-`/`CC` rename before a third Harness; it no longer describes
  current route admission.
- **DeepSeek Harness** and **Grok Build** are later, independent probes. Each
  needs its own accepted OpenSpec, its own Driver, and its own readiness
  evidence; neither depends on the other, and neither is admitted by adding a
  model identifier to an existing route.
- **Pi reference-only.** This pre-admission note is retired; the current Pi
  Harness contract is above.
- **TUI automation is forbidden.** No Harness is driven by scripting its
  terminal interface. A Harness is admitted through a documented programmatic
  surface -- a headless protocol or a local API -- or it is not admitted.

## Provenance

The initial runtime ideas were evaluated against the Apache-2.0 Sendbird
plugin. Current public architecture, lifecycle, environment contract, and
runtime source are locally owned. Historical upstream material is reference
only and is not an active compatibility contract.

## Support and contributing

Use [GitHub Issues](https://github.com/Pein2017/codex-harnessdock/issues) for
questions, reproducible defects, and focused proposals. Please run
`npm run check` before submitting a pull request. Report vulnerabilities through
the process in [`SECURITY.md`](SECURITY.md), not a public issue.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
