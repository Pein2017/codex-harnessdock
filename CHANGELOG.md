# Changelog

## 0.28.0 - 2026-09-01

- Bind every accepted native turn to exact physical residency and reclaim only
  one-hour-old uncertainty whose worker and native process/service identity are
  still provably owned, while preserving ambiguous leases and durable history.
- Replace MCP-owned lifecycle timers with one self-exiting residency manager,
  and project committed worker loss plus descriptor-bound wake events without
  fabricating settlement, continuation, or assistant output.
- Load heavy Harness Drivers only for launch/activation operations and omit
  process-resident heavy registries from observational MCP calls, reducing the
  measured idle MCP footprint without changing the nine public operations.
- Keep retained capability-schema v2/v3 launch evidence readable and byte-stable
  during writer safety scans; fresh routes and inspection evidence remain strict
  capability-schema v4.
- Resolve Harness executables and wake publication only from `/data/CoordExp`
  runtime paths, and scrub inherited Conda activation state from child launches.

## 0.27.0 - 2026-08-31

- Make bounded native progress a first-class capability: Pi consumes RPC JSONL
  events and OpenCode consumes fixed-origin SSE plus exact-session message/status
  reads, while raw text, thinking, tool payloads, paths, prompts, and transcripts
  remain private.
- Persist only the latest meaningful version-three progress revision and let an
  explicit `wait_agent(wake_on_progress: true)` observe later revisions without
  changing ordinary completion-only waits, fixed barriers, or completion priority.
- Reconcile exact dead-worker turns from Driver-owned native evidence, including
  Pi baseline-entry lineage and OpenCode user-message lineage; fix terminal
  transitions with retained progress, omitted OpenCode idle-status entries,
  env-file Driver resolution, and bounded SSE header connection waits.
- Advance route capability snapshots to schema v4 with explicit
  `nativeProgress`, requiring future Harness lifecycle proposals to integrate or
  honestly classify their noninteractive progress surface. Direct-Harness
  differential parity now records 34 pass and 8 not-applicable cells.
- Remove the remaining current Plugin `CC`/`HD` display names and guidance in
  favor of `HarnessDock`, including all nine Skill metadata cards and branded
  assets; keep only the historical identity-transition specification.

## 0.26.0 - 2026-08-31

- Add `dispatch_agents` as the ninth typed MCP operation and matching Skill for
  1..8 complete explicit rows, with pure structural validation, bounded
  environment preflight, exact-pair discovery reuse, ordered launch, and no
  durable batch identity, retry, fallback, or cross-row rollback.
- Preserve singular-spawn ownership across cancellation and non-rollback-safe
  failure, returning only the public Agent name and closed recovery outcome;
  update operator accounting for exact Harness/model/effort/topology/write
  routes and batch row outcomes.
- Advance the MCP API to generation 10 and update the zero-model release smoke,
  Plugin guidance, direct-Harness parity, and failure/performance acceptance for
  exactly nine tools and Skills within the existing catalog budget.

## 0.25.5 - 2026-08-31

- Revalidate and pin OpenCode 1.18.25 so an upgraded managed service is
  admitted instead of being mislabeled as an interactive-policy failure.

## 0.25.4 - 2026-08-30

- Give a complete OpenCode Agent turn the same fixed one-hour window as the
  model-facing join instead of declaring a still-running native turn unknown
  after two minutes.

## 0.25.3 - 2026-08-30

- Keep capability-schema-v2 version-three jobs readable across upgrades without
  widening or rewriting their frozen routes, while new jobs still require the
  current schema. This prevents historical owner-root state from aborting a new
  target-worktree writer admission before native submission.

## 0.25.2 - 2026-08-30

- Resolve Pi RPC dialogs with unattended continuation defaults instead of
  cancellation, and instruct Pi Agents to decide without asking the user.

## 0.25.1 - 2026-08-30

- Keep Pi RPC turns unattended when a native extension requests a dialog:
  cancel `select`, `confirm`, `input`, and `editor` immediately instead of
  waiting for a main-thread reply that HarnessDock cannot deliver.

## 0.25.0 - 2026-08-30

- Bind every admitted turn to an explicit target worktree and exact freshly
  discovered model/effort route, with capability provenance and launch claims
  preventing route, execution-root, or writer-lease drift before prompt submission.
- Discover Claude Code model/effort routes through the official Agent SDK using
  the operator's native configuration, revalidate the exact tuple before launch,
  and recover a disconnect by resuming the same session with one new recovery prompt.
- Add direct-native differential parity and release gating across Claude, Pi, and
  OpenCode; keep managed OpenCode turns fully unattended (including doom-loop
  confirmation) and compact model-facing discovery guidance without losing schema.

## 0.24.1 - 2026-08-29

- Keep focused OpenCode turn tests inside disposable Plugin-data roots, accept
  the Linux `/proc/net/tcp6` `remote_address` header, and check pre-existing
  peers before the reaper's own health request so an owned one-hour-idle Server
  can terminate without weakening lease, socket, or identity guards. Admit the
  dormant OpenCode discovery detail through the public Harness contract and
  carry the operator-owned XDG roots into shell-independent native discovery.

## 0.24.0 - 2026-08-29

- Remove the extra MCP bootstrap process, discover OpenCode routes while
  dormant, reap only proven idle owned services after one hour, and compact
  Plugin/MCP/OpenCode control text without changing the eight-tool contract.
- Add an explicit one-time identity-adoption receipt for an authoritative
  current data root when the legacy root and cutover recovery boundary are
  both absent.

## 0.23.0 - 2026-08-29

- **BREAKING (operator-facing).** Manage or reuse one fixed-loopback OpenCode
  Server during MCP bootstrap and immediately before an OpenCode spawn. The
  checkout records only proven private child identity, never kills a reused or
  foreign endpoint, and keeps doctor/listing read-only. Pi and OpenCode now
  take their fixed executable/configuration through `config/runtime.env`; Pi
  discovery reports closed redacted configuration, executable, timeout, RPC,
  and protocol failures instead of `unknown`.

## 0.22.0 - 2026-08-28

- Replace the fixed Pi and OpenCode model/effort constants with bounded,
  zero-inference native discovery at list and spawn time. `list_harnesses`
  and `spawn_agent` now project the routes Pi resolves from its local
  `PI_CODING_AGENT_DIR` RPC configuration and the connected OpenCode Server
  resolves from its `/provider` catalog and variants; a static checkout-owned
  Driver registry still admits only `claude-code`, `opencode`, and `pi`, and an
  unavailable, ambiguous, or changed route fails closed rather than aliasing,
  inferring, or substituting a nearby one.
- Require an explicit `reasoning_effort` for every Pi and OpenCode spawn,
  freshly validated against the exact native model or variant; follow-up
  inherits that frozen effort. No Driver stores or uses a discovered native
  default. OpenCode maps the stated effort to exactly one advertised variant
  and omits an agent selector so the Server keeps its native local
  agent/configuration.
- Keep `write` a prompt-and-receipt authority only across native routes: it no
  longer selects Pi native tools, argv, or process permissions, and OpenCode
  inherits the same native plugins, MCP servers, tools, and sandbox for
  `write: true` and `write: false`. Restore Pi's native extensions, skills,
  prompt templates, and tools without copying or exposing their configuration.
- Report bounded, redacted fresh native-route discovery in `npm run doctor`
  and the zero-model `npm run smoke:release`, distinguishing unavailable,
  ambiguous, and route-drift conditions without a model call, Server start, or
  configuration enumeration.
- **BREAKING (task-facing).** Bump the MCP API generation to 7 and the plugin
  minor version to 0.22.0. An MCP process that discovered generation 6 assumed
  fixed native model/effort enums and now fails restart-required before any
  operation; a newly loaded MCP observes later local Pi/OpenCode configuration
  changes through fresh discovery without a HarnessDock reload.

## 0.21.0 - 2026-08-27

- Add the first-class Pi RPC Harness for exactly
  `openai-codex/gpt-5.6-luna`, `openai-codex/gpt-5.6-terra`, and
  `openai-codex/gpt-5.6-sol`: explicit per-turn effort, leaf-only fixed tool
  policy, exact UUID resume, acknowledged active input, interruption, native
  assistant history, and cumulative provider-token deltas. Pi has no global
  capacity ceiling; only concurrent use of one exact native session is
  serialized.
- Contract OpenCode Explorer to the matching three OpenAI subscription routes,
  defaulting to Luna and rejecting DeepSeek and `-fast` variants. Preserve its
  read-only, fresh-session-only capability boundary and unlimited instance
  admission.
- Harden detached version-three launch handoff with a durable pre-acquisition
  intent, claim-aware lease publication, submission/rollback fencing, exact
  lease release, and mailbox restoration. Abandoned pre-submission launches are
  cleaned by an owning reconciliation without native replay; `list_agents`
  remains observational.
- Version launch claims at v2 while projecting valid released v1 records
  read-only and materializing v2 only on an exact owning mutation. Conflicting,
  corrupt, over-bound, or ambiguous recovery evidence continues to fail closed.

## 0.20.0 - 2026-08-18

- **BREAKING (operator-facing).** Complete the identifier half of the
  HarnessDock rename as one flag day with no aliases and no fallbacks. Every
  `CC_*` environment variable becomes `CODEX_HARNESSDOCK_*` (the prefix the
  runtime-home variable already used); non-environment identifiers -- receipt
  codes, prompt sentinels, and internal constants -- take the established
  `HARNESSDOCK_*` form. The retired names stop working rather than degrading:
  `CC_RUNTIME_HOME` in particular still fails closed, because ignoring a stale
  runtime-home export would silently resolve the operator's real data
  namespace.
- Remove the `createClaudeRuntime()` compatibility alias. `createAgentRuntime()`
  is the only public factory, and the isolated MCP call worker no longer falls
  back to the Claude-named export. Internally `createInternalClaudeRuntime()`
  becomes `createInternalAgentRuntime()` and class `ClaudeRuntime` becomes
  `InternalAgentRuntime`. Genuinely Claude-specific modules and symbols keep
  their Claude names: renaming the Claude Driver would be false neutrality.
- Retire the "CC Agent" wording. Operator- and model-facing text now says
  "HarnessDock Agent" where the sentence means the neutral two-Harness surface
  and "Claude Agent" where it is genuinely Claude-specific, such as native Auto
  Memory.
- **BREAKING (durable vocabulary).** New job identifiers use the `hd-agent-`
  prefix and no reader accepts the retired one, because the authorized state
  reset leaves no pre-rename record to read. The usage report drops the
  `cc_for_pein` admission and its cutover-timestamp branching entirely: a
  retired-identity event is now excluded from usage at any timestamp and
  counted only as `diagnostics.retired_identity_events`, while its call ID is
  still reserved so the same call cannot reappear as current usage. The report
  version becomes 2.
- Point the promotion constants, installed bootstraps, MCP descriptor, and
  documentation at `/data/CoordExp/codex-harnessdock` (live, `main`) and
  `/data/CoordExp/codex-harnessdock-dev` (development, `developer`). Until the
  operator relocation runs, the live path does not exist yet and the fixed
  bootstraps fail closed naming it -- which is the designed behavior, not a
  regression.
- Add a repo-wide guard test proving the retired variable prefix, wording,
  plugin slug, server name, job prefix, and checkout path are absent from the
  tracked tree. Its allowlist is per-file *and* per-token, so a module allowed
  to keep a retired-name refusal still fails if it grows a retired variable,
  and it names the offending file and line.

## 0.19.0 - 2026-08-18

- Activate the eight-operation multi-Harness public generation (MCP API
  generation 6): `list_harnesses` joins the surface, `spawn_agent` requires
  explicit `task_name`, `message`, `harness`, full `model`, `topology`, and
  `write` from closed enums with no defaults or aliases, and `followup_task`
  inherits the immutable route with its write mutation removed. Pre-generation
  payloads fail closed at the typed schema before any store write.
- Add the read-only OpenCode Explorer Driver pinned to
  `opencode-go/deepseek-v4-flash` through an operator-owned loopback Server:
  fixed-origin secret-safe client, reviewed default-deny `codex-explorer`
  profile with positive-proof validation, narrow versioned prompt/result
  boundary, launch/session/turn lineage with fail-closed unknown settlement,
  route-keyed usage, and workspace mutation witnesses. Interrupt and history
  answer explicit unsupported receipts; continuation is fresh-only.
- Execute by route: new spawns on both Harnesses write version-3 identity
  records; claude-code keeps the proven version-one supervisor (progress,
  bound history, resumable waits preserved), opencode runs the detached
  version-three worker path.
- Isolate test state: runs pin their data root to a per-run temp directory and
  a complete check adds zero entries under the operator data namespace.
- Add the gated live evaluation script (explicit authorization flag, bounded
  stop conditions) and the consolidated activation runbook.

## 0.18.1 - 2026-08-13

- Preserve the current and two predecessor discovery-only Plugin shells in a
  durable owner-only archive before Codex Cache replacement, fail closed when a
  known predecessor is unavailable, and expose managed/first-install/unmanaged
  coverage through doctor and release smoke.
- Teach all seven lifecycle Skills to keep their exact retained instructions,
  treat latest-version fallback as emergency-only, and start a new Codex task on
  `CC_MCP_RESTART_REQUIRED` instead of attempting to repair Plugin Cache.

## 0.18.0 - 2026-08-13

- Add experimental bounded Claude Native Agent Teams for explicit Opus/Fable
  orchestrators while preserving the flat seven-tool CC Agent API, strict leaf
  behavior, fresh-team follow-ups, and zero automatic team reconnect.
- Inject stable Haiku scout, Sonnet, and Opus teammate definitions with pinned
  requested models, Claude-owned local memory, reviewed tool denials, explicit
  behavioral authority, and no Plugin-owned teammate registry or transcript.
- Translate Claude's versioned Agent and `SendMessage` results only at the
  Adapter boundary. A bounded asynchronous member launch is necessary but not
  sufficient; successful correlated messaging to that launched member name is
  required before stable team transport becomes live-validated.
- Add bounded native-surface compatibility history, doctor projections, and a
  disposable production-Driver release witness with fail-closed protocol,
  mutation, overflow, account-limit, and observer-false-negative handling.

## 0.17.0 - 2026-08-11

- Observe native Claude OAuth credential generations without retaining tokens,
  token hashes, account identity, scopes, or provider-live claims. Readiness
  and doctor now expose metadata-only `liveValidated: false` evidence and warn
  on locally expired or unproven access credentials.
- Let an activating `followup_task` recover the same logical Agent after a
  credential refresh only for a first-turn `auth_or_permission` failure with
  durable zero-side-effect evidence. The historical failure remains immutable,
  its original task messages are atomically requeued once, and the new turn is
  always a safe-fresh native Claude session; all ambiguous cases remain blocked.
- Prevent authentication-failed native session IDs from becoming exact-resume
  pointers and persist an explicit assistant-output observation bit across the
  Claude stream, Driver, supervisor attempt, and job boundaries.

## 0.16.0 - 2026-08-09

- Permit one exact targeted `wait_agent` join to opt into its single bounded
  progress update while preserving the snapshotted turn, unrelated-root
  isolation, completion priority, and completion-only multi-target barriers.
- Classify Claude's native session-capacity limit as terminal account
  exhaustion without misclassifying successful assistant prose, caller
  budgets, or generic request/rate HTTP 429 failures. Normalize exact
  `list_agents(path_prefix: "/root")` to the current-root unfiltered view.
- Add a privacy-preserving operator-only usage report and append-only
  acceptance-disposition ledger. Retained rollout evidence is scanned with
  fixed UTC bounds, replay-safe call identities, fail-closed fork provenance,
  closed metrics, and no delegated content; the model-facing surface remains
  exactly seven Agent tools.

## 0.15.1 - 2026-08-07

- Add an original CC for Pein visual identity: a compact bidirectional relay
  icon and a larger matching logo, declared through `composerIcon`, `logo`, and
  `brandColor` with Plugin-root-relative asset paths.

## 0.15.0 - 2026-08-07

- Add compact Agent Cards to spawn and list receipts with closed model, effort,
  authority, phase, activity, and elapsed-time projections. Keep listing
  observation-only: it never reconciles lifecycle state, dispatches mail,
  consumes progress, or acknowledges completion.
- Propagate a closed, nullable terminal-metrics receipt from Claude stream-json
  through Driver, supervisor, durable jobs, completion inboxes, targeted joins,
  pruning, and byte-identical redelivery. Admit only documented numeric fields,
  distinguish provider-reported usage from Plugin counters, and never expose raw
  usage payloads or claim billing accuracy.
- Harden Agent Card provenance against cross-Agent and cross-owner job evidence,
  keep terminal elapsed time null without a valid completion timestamp, and add
  fake-Claude, recovery, root-isolation, compatibility, and release-path tests.
- Shorten the model-facing Skill and MCP guidance while preserving all seven
  operations, their existing input schemas, dynamic lead-owned join decisions,
  and the active-wait completion boundary.

## 0.14.0 - 2026-08-04

- **Breaking:** extend typed `wait_agent` with one-to-eight exact current-root
  `targets` for fixed-turn joins and ordered all-settled barriers. Preserve the
  untargeted receipt, reject progress-target combinations, return no partial
  completion payload at a barrier timeout, and increment the MCP API generation
  so existing Codex tasks fail closed until restarted.
- Migrate the completion inbox to per-Agent-event acknowledgement with a derived
  contiguous compaction watermark. Targeted barriers can acknowledge selected
  completions independently of unrelated older events while retaining frozen
  at-least-once redelivery across races and runtime restarts.
- Replace the 500 ms durable wait scan with directory event hints plus
  observe-register-observe race closure. Durable inbox and job files remain the
  sole facts, with bounded 10-second recovery and 5-second watcher-failure
  fallback scans, immediate abort, and isolated Worker cleanup.
- Retain bounded, sanitized unknown Claude stream event type/subtype counts for
  protocol-drift diagnosis without persisting arbitrary payloads or changing
  completion classification. Native background-task completion remains gated
  on a pinned real Headless receipt rather than inferred from assistant prose.
- Add fixed `developer` and `main` worktrees with a checked fast-forward
  promotion gate, restart/hot-compatibility classification, and checkout-owned
  local release guidance.

## 0.13.0 - 2026-08-03

- Force-enable Claude Code native Auto Memory for every new and resumed CC
  Agent through the canonical fixed environment while preserving Claude's
  repository-derived memory ownership and avoiding prompt, receipt, or
  Plugin-owned memory emulation.
- Extend the strict model-facing `wait_agent` completion-first observation to
  one hour behind the unchanged public schema, preserving early completion,
  optional one-update progress, cancellation, and the checkout CLI's 10-minute
  default. Direct required-work joins now avoid timeout narration and
  list/history polling.

## 0.12.1 - 2026-08-03

- Close the final `wait_agent` observation gap: after its bounded wait and
  terminal reconciliation, perform one zero-time completion-only mailbox read
  so an already-visible completion replaces a stale timeout or advisory
  progress receipt. Preserve acknowledgement, at-least-once redelivery,
  progress budgets, public schemas, and zero-write settled timeouts.
- Clarify that a timeout proves only that no unread current-root completion was
  visible at the call's final observation, and discourage immediate
  `list_agents` calls made solely to repeat that completion check.

## 0.12.0 - 2026-08-03

- Harden supervisor residency and Linux signal truth, preserve only the latest
  complete outer-assistant handoff, restrict recovery classification to native
  execution evidence, bound persisted tool metadata, enforce owner-only
  runtime evidence, redact model-facing errors, validate blocking tuples, and
  whitelist compatibility-shell discovery files. Align wait guidance and the
  optional paid release smoke with the current public schema.

- **Breaking:** compact successful `spawn_agent` to `agent_name`, `model`, and
  `status`; `followup_task` to `agent_name` and `delivery`; and
  `interrupt_agent` to `agent_name` and operation `status`. Preserve internal
  recovery evidence, actionable failures, and complete `wait_agent` final
  messages. Increment the MCP generation for the discovered result shapes.
- Reduce the seven Agent Skills from roughly 2,859 to about 1,310 words, remove
  ordinary raw-receipt echoing, and shorten MCP descriptions plus the appended
  Claude delegation envelope without weakening authority, joining, account
  limits, delegation depth, or tool denial.
- **Breaking:** remove public `allowed_tools` from `spawn_agent` and
  `followup_task`; terminal-parity Agents inherit the native Claude tool surface
  by default. Deny `Workflow` for every Agent, continue denying `Agent` for
  leaves, and leave native `Agent` available only to explicit Fable
  orchestrators. Increment the MCP API generation so existing Codex tasks fail
  closed until restarted on the new schema.
- Add a bounded prompt escape hatch for decisions only the Codex lead or user
  can make: Claude ends the current turn with the exact question and evidence,
  allowing the same durable session to continue through a follow-up.
- **Breaking:** shrink successful `send_message` receipts to only stable
  `agent_name` and `delivery`. Keep complete mailbox,
  assignment, job, and steering evidence durable for operator diagnosis, while
  directing the parent to give one concise disposition-aware confirmation
  instead of repeating raw JSON or message text.
- Make `wait_agent` completion-first by default so advisory progress no longer
  wakes the lead every 5 to 30 seconds. Add call-local `wake_on_progress` for
  one intentional bounded progress observation, preserve progress cursors
  during ordinary joins, and align Skill guidance with sparse Codex V2 waits.
- Add compatible live runtime refresh for existing Codex tasks: every accepted
  MCP lifecycle call now loads `runtime/index.mjs` and its transitive modules in
  a fresh isolated worker while the MCP adapter remains stateless. Pin new MCP
  descriptors directly to the canonical checkout, fail stale public API
  generations with `CC_MCP_RESTART_REQUIRED`, split no-cachebuster
  `refresh:local` from versioned `release:local`, and retain at most two recent
  discovery-only Plugin shells so a release does not strand older tasks on a
  deleted Cache path.
- **Breaking:** decouple behavioral write intent from Claude CLI permissions.
  Default terminal parity now sets `IS_SANDBOX=1` and always passes
  `--dangerously-skip-permissions` for both read/review and mutation turns so
  headless Bash, MCP, hooks, and native tools do not stall. Keep `write` as an
  explicit durable authority boundary and append a read-only or task-scoped
  mutation instruction to every Claude turn.
- **Breaking:** slim public spawn to required `task_name`, `message`, `model`,
  and `write`; remove public `fork_turns` and execution-profile selectors.
  Default every Agent to an immutable leaf with an appended Codex-lead envelope
  and native `Agent` denial, while allowing explicit Fable-only
  `claude_orchestrator` mode with opaque one-generation native children. Map
  public lifecycle state to five strings and expose delegation mode in listings.
- Reject stale trusted Codex workspace metadata before runtime construction and
  distinguish a removed workspace from a missing Claude executable instead of
  reporting a false PATH failure.
- Add an operator-only, redacted `doctor`, read-only storage/history inventory,
  and a zero-model-cost installed Plugin release smoke covering seven Skills,
  stdio MCP startup, seven tools, and isolated `list_agents`. Add an explicit
  one-turn Haiku 4.5/low paid extension, derive runtime/Plugin versions from the
  package base, and replace missing dependency loader stacks with an actionable
  checkout `npm install` recovery.
- Add one checkout-owned `cc_for_pein` stdio MCP server with exactly seven
  typed lifecycle tools. Bind calls to trusted Codex thread/workspace metadata,
  keep spawn/follow-up background handoff asynchronous, keep wait as the
  explicit 10-minute-default/one-hour-maximum join, and cancel only the wait
  observation. Skills now guide MCP calls without silent shell fallback; the
  installed snapshot remains descriptor-only and the CLI remains operator-only.
- Add a zero-model-cost Claude Code update guard: fingerprint the configured
  executable, cache a required-CLI-surface check, fail before incompatible new
  activation, revalidate at detached launch and after completion, and mark only
  a full-fingerprint-matching requested turn as `observed_working` without an
  automatic paid smoke.
- Deliver each new CC Agent final message completely through the durable
  completion inbox and `wait_agent`, removing the former 64 KiB persistence and
  4096-byte public handoff truncation while retaining honest legacy provenance.
- Add Experimental `read_agent_messages` and `$cc-for-pein:read-agent-messages`
  for root-bound, observation-only access to recent outer-assistant text in the
  Agent's native Claude transcript; exclude thinking, tools, attachments,
  subagent artifacts, arbitrary paths, and foreign sessions.
- Harden detached worker handoff with launcher identity/generation predicates
  and an atomic `queued` to `cancelling` cleanup fence; accepted Agent turns
  continue across Codex exit or network loss, while failed handoffs cannot race
  a worker claim or release an exact-session lease early.
- Expand the supported roster to full `claude-haiku-4-5`, `claude-sonnet-5`,
  `claude-opus-5`, and `claude-fable-5` selections. All accept `low` through
  `max`; relative Plugin guidance (not exact pricing) orders approximate
  capability and spend as Haiku < Sonnet < Opus < Fable. Make Haiku/low the
  recommended real-smoke route rather than a test-only restriction, while
  recommending Fable for core decisions and planning rather than routine coding.
- Treat explicit Claude subscription, usage, allowance, credit, or quota
  exhaustion as terminal and non-retrying, with no model fallback; keep generic
  HTTP 429 recovery and caller-imposed maximum-budget failures distinct.
- Keep the 500 ms completion observation cadence while eliminating completion
  inbox locks and fsyncs from quiet polls and already-frozen redelivery; retain
  locked first-delivery freezing and acknowledgement semantics.

## 0.4.0 - 2026-07-26

- Mark all six CC Agent skills and discovery descriptions as Experimental and
  state the current host limitation: background completion cannot start a new
  Codex parent turn after the parent has ended.
- Add required, parallel-then-join, and explicitly detached parent policies;
  keep spawn asynchronous while forbidding a parent final with unresolved
  required work.
- Wake `wait_agent` on coalesced safe progress milestones without exposing
  Claude response/thinking text, tool inputs, paths, hooks, sessions, or raw
  receipts.
- Give public waits a 10-minute default and one-hour maximum observation bound;
  adapt routine progress delivery from 5 to 10, 20, then 30 seconds while
  letting completion and high-value retry/reconnect/response transitions
  bypass or reset the heartbeat cooldown.
- Add a two-phase-redelivered 4096-byte completion handoff for parent synthesis,
  with completion priority and explicit truncation, removing the need for a
  recovery follow-up or temporary-file workaround.
- Base the orchestration policy on a read-only audit of Codex Multi-Agent V2 at
  `4c43465133428898aa84f0bfc02c306ed65fb66a`: asynchronous spawn, root mailbox
  wait, separate state listing, queue-only completion, and no idle-parent
  auto-reactivation.
- Give a live lock owner a short identity-probe grace so concurrent mailbox
  writers cannot silently overwrite a steering message, while reclaiming a
  lock from a provably dead owner immediately even under clock skew.
- Make the unit and integration harnesses independent of ambient Codex/CC root
  variables so the same check gate is reproducible in CI and a bootstrapped CC
  session.

## 0.3.0 - 2026-07-26

- Make `$cc-for-pein:spawn-agent` acknowledge successful starts with only the
  selected model, Agent path, and status; preserve actionable failure details.
- Pin the spawn skill's two supported model selections to
  `claude-sonnet-5` and `claude-opus-5`, document `low` through `max` effort
  values separately, reject every other model before launch, and forbid partial
  model names, implicit defaults, or silent fallback after account rejection.
- Make Claude terminal parity the default execution profile with effective
  native config resolution, `IS_SANDBOX=1`, and
  `--dangerously-skip-permissions`; keep `safe` as explicit opt-in.
- Align list/wait model-visible receipts with Codex Multi-Agent V2, retain at
  most one bounded acknowledgement update, suppress final output, and prevent
  legacy unowned events from starving current Agent delivery.
- Make all six lifecycle skills model-visible. Separate checkout-hot runtime
  edits from cachebuster-based atomic discovery refresh without destructive
  plugin reinstall.
- Declare the standalone Pein2017 clone as the sole runtime/Git/install owner;
  the external upstream checkout is reference-only.
- Migrate pre-v0.3 Agent model state only from exact retained receipt or Claude
  session evidence, defer unproven active turns, and fail closed for terminal
  unsupported or unproven history without substituting a supported model;
  automatically recover when a located unproven artifact later proves support.

## 0.2.0 - 2026-07-25

- Replace the public job lifecycle with six canonical Agent operations:
  `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `interrupt_agent`, and `list_agents`.
- Replace the six job-oriented plugin skills with exactly
  `$cc-for-pein:spawn-agent`, `$cc-for-pein:send-message`,
  `$cc-for-pein:followup-task`, `$cc-for-pein:wait-agent`,
  `$cc-for-pein:interrupt-agent`, and `$cc-for-pein:list-agents`.
- Make each Agent a durable current-root identity with a flat
  `/root/<task_name>` path, exact targeting, logical-root default isolation,
  nonresident terminal history, and a proven native Claude continuation path.
- Add canonical message-versus-follow-up semantics and crash-safe two-phase
  completion acknowledgement through `wait_agent` tokens.
- Remove all job-oriented public methods, CLI commands, skills, aliases, and
  docs. There is no public `cancel`, `cancel_job`, archive, close, or Agent
  deletion operation; `interrupt_agent` is the sole public stop action.
- Document Codex Multi-Agent V2 alignment and deliberate deviations: plugin
  skill names remain namespaced, `fork_turns` supports only `none`, topology is
  flat, all logical terminal history remains listed, and direct Terminal
  session adoption is deferred to a future OpenSpec change.
- Scope supported execution and CI to Linux with Node.js 20.19+; non-Linux
  defensive branches are best-effort and do not define release gates.

## 0.1.0 - 2026-07-25

- Establish a checkout-owned Claude Code headless runtime with durable jobs,
  safe and terminal-parity execution profiles, one env-file contract, durable
  steering, interruption, exact-session follow-up, bounded transport recovery,
  and redacted receipts.
- Replace upstream review/setup/hook/installer/cache surfaces with a local
  bootstrap that delegates only to the declared checkout.
