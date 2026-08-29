# local-runtime-boundary Specification

## Purpose

Define the checkout-owned runtime, host Claude dependency, environment selection, and portability boundary.
## Requirements
### Requirement: Checkout-owned executable runtime
The installed HarnessDock for Codex Plugin SHALL load executable runtime source only from the canonical `/data/CoordExp/codex-harnessdock` checkout. Both lifecycle and MCP bootstraps SHALL NOT accept caller or ambient runtime-checkout selection. They SHALL NOT load runtime or Git objects from `/data/CoordExp/external/cc-plugin-codex`, Sendbird, another upstream repository, a Git alternate, a registered development worktree, or a versioned Plugin Cache path.

#### Scenario: Matching independent checkout delegates successfully
- **WHEN** an installed lifecycle or MCP bootstrap validates `/data/CoordExp/codex-harnessdock`
- **THEN** it delegates execution to that checkout's matching public runtime entrypoint while reporting the HarnessDock public identity

#### Scenario: Source root mismatch fails closed
- **WHEN** the loaded runtime source does not resolve to the canonical fixed checkout
- **THEN** the runtime refuses to execute and reports the source mismatch

#### Scenario: Development worktree provenance is inspected
- **WHEN** the canonical checkout's Git common directory and remotes are inspected
- **THEN** they resolve only to the independent local clone and its Pein2017 `origin`, with no upstream or external-repo dependency, and no development worktree becomes an executable runtime source

### Requirement: Host Claude Code dependency is explicit
The runtime SHALL use the host `claude` CLI for authentication, Claude configuration, sessions, hooks, memories, skills, plugins, MCP configuration, and tool execution.

#### Scenario: Claude CLI is unavailable
- **WHEN** the configured Claude executable cannot be resolved
- **THEN** readiness fails without substituting an upstream package or cached runtime

### Requirement: Harness dependencies remain explicit behind checkout-owned Drivers
Each admitted Harness SHALL declare its host executable, native configuration/session identity, authentication boundary, compatibility detector, and redacted readiness evidence through its checkout-owned Driver. Those host components MAY remain external execution dependencies, but Driver source, registry, lifecycle orchestration, and durable state ownership SHALL remain inside `/data/CoordExp/codex-harnessdock`. No Driver SHALL load source or Git objects from upstream repositories, registered development worktrees, or versioned Plugin Cache paths.

#### Scenario: Claude Code Driver becomes ready
- **WHEN** the current registry validates its only admitted Driver
- **THEN** readiness identifies the host `claude` executable and fixed Claude configuration as external dependencies while all Driver and supervisor source resolves to the canonical checkout

#### Scenario: Future Harness CLI is unavailable
- **WHEN** an in-tree Driver cannot resolve or validate its declared host executable
- **THEN** readiness fails for that route without substituting a raw provider API, upstream package, Cache runtime, or another Harness

### Requirement: Harness implementation selection is not model-facing
Model-facing lifecycle calls SHALL NOT accept a Harness executable path, Driver module, native configuration directory, environment file, authentication store, capability override, or compatibility bypass. The static Driver registry and each Driver's checkout-owned environment owner SHALL resolve those values before durable Agent creation. A future public Harness selector MAY choose only an admitted stable Harness ID through a separately versioned API.

#### Scenario: Caller attempts executable override
- **WHEN** spawn or follow-up supplies a binary, module, configuration, environment, or capability selector
- **THEN** the runtime rejects the unsupported input before route validation, state mutation, or process launch

#### Scenario: Current public API omits Harness
- **WHEN** the current-generation API starts a supported Claude Agent
- **THEN** the sole admitted `claude-code` Driver is recorded internally without inferring a Driver from an arbitrary executable or ambient model alias

### Requirement: Exactly one environment file is selected
The installed model-facing lifecycle and MCP bootstraps SHALL load exactly `/data/CoordExp/codex-harnessdock/config/runtime.env`. They SHALL NOT select an environment from invocation arguments, MCP tool arguments, `CODEX_HARNESSDOCK_RUNTIME_ENV_FILE`, `${CODEX_HOME}/.env`, or a workspace `.codex/.env`. They SHALL parse the fixed file as data and SHALL NOT evaluate it as shell code.

#### Scenario: Ambient environment selectors conflict
- **WHEN** inherited `CODEX_HARNESSDOCK_RUNTIME_ENV_FILE`, `CODEX_HOME`, or workspace `.codex/.env` point to other files
- **THEN** the active bootstrap ignores them as selectors and loads only the canonical checkout environment file

#### Scenario: Invocation supplies an environment selector
- **WHEN** a model-facing CLI or MCP invocation supplies an environment-file selector
- **THEN** startup rejects the unsupported input instead of selecting that file

#### Scenario: Fixed environment file is unavailable or invalid
- **WHEN** the canonical environment file is missing or contains invalid dotenv syntax
- **THEN** startup fails instead of silently falling back

#### Scenario: Explicit environment file wins
- **WHEN** a legacy model-facing caller attempts to provide an existing explicit environment file
- **THEN** the fixed Plugin environment wins by rejecting the removed selector before that file can be loaded

#### Scenario: Explicit environment file is missing
- **WHEN** a legacy model-facing caller provides a missing explicit environment-file path
- **THEN** startup rejects the removed selector without checking lower-precedence files or silently falling back

### Requirement: Runtime environment preserves required host settings
The fixed environment file SHALL authoritatively provide both Claude config variables, uppercase and lowercase proxy variables, no-proxy variables, `CONDA_EXE`, and the Claude executable to the model-facing Claude subprocess. Those fixed values SHALL overlay conflicting inherited values. Valid unrelated inherited host values such as `PATH`, Codex root identity, and runtime-state location SHALL remain available. Receipts SHALL expose only the effective config path and redacted network endpoints, not arbitrary environment values.

#### Scenario: Inherited protected value conflicts with fixed config
- **WHEN** the host environment supplies a different Claude config path, proxy endpoint, Conda executable, or Claude executable
- **THEN** the Claude child receives the value from the canonical fixed environment file

#### Scenario: Unrelated host path is inherited
- **WHEN** the host provides a valid `PATH` not defined by the fixed environment file
- **THEN** the Claude child retains that inherited `PATH`

#### Scenario: Proxy and Claude config are recorded safely
- **WHEN** readiness or execution emits an environment receipt
- **THEN** it identifies the effective fixed Claude config directory and redacted proxy endpoints without recording proxy credentials or unrelated environment values

#### Scenario: Native Claude config override is present
- **WHEN** the inherited host environment supplies a non-empty `CLAUDE_NATIVE_CONFIG_DIR` that conflicts with the fixed file
- **THEN** the Claude child receives the fixed canonical value as `CLAUDE_CONFIG_DIR`

#### Scenario: Native override is absent
- **WHEN** the inherited host environment omits or empties `CLAUDE_NATIVE_CONFIG_DIR`
- **THEN** the Claude child still receives the canonical value supplied by the fixed file

### Requirement: Local development separates checkout edits from Plugin discovery refresh
Executable runtime source SHALL remain checkout-owned and SHALL NOT require Plugin uninstall/reinstall. A compatible change behind `runtime/index.mjs` SHALL load in a fresh isolated module graph on the next accepted MCP call, including from an already-running MCP server. The long-lived MCP protocol adapter, Plugin Skills, manifest, `.mcp.json`, annotations, and tool schemas SHALL remain task snapshots and SHALL NOT be claimed to hot-reload. Same-generation discovery edits SHALL use an in-place local refresh without changing the manifest version. An incompatible public MCP generation or release SHALL use a versioned local release refresh and a new Codex task.

#### Scenario: Compatible runtime changes during an existing MCP task
- **WHEN** a module behind `runtime/index.mjs` changes without changing the MCP API generation
- **THEN** the next accepted lifecycle call uses the revised checkout module graph without reinstalling the Plugin or restarting the task

#### Scenario: Same-generation discovery file changes
- **WHEN** a Skill, metadata, manifest content, `.mcp.json`, annotation, or bootstrap changes without a public generation change
- **THEN** `refresh:local` reinstalls the same manifest version and acceptance of the discovery change uses a new Codex task

#### Scenario: Public generation changes
- **WHEN** a stale MCP process calls a checkout whose public MCP API generation differs from the generation captured at server startup
- **THEN** the call performs no lifecycle operation and reports that a versioned refresh and new Codex task are required

#### Scenario: Versioned local release
- **WHEN** the operator intentionally runs the versioned local release command
- **THEN** it updates exactly one cachebuster, installs the resulting snapshot, and directs schema/Skill acceptance to a new task

#### Scenario: Local marketplace root drifts
- **WHEN** refresh or release mode detects that `pein-local` points somewhere other than `/data/CoordExp/codex-harnessdock`
- **THEN** it fails closed instead of silently refreshing from the wrong source; initial installation may explicitly rebind the marketplace once

### Requirement: Recent Plugin discovery shells survive version refresh
The local installer SHALL preserve an exact discovery-only shell for each
successfully installed version in bounded owner-local Plugin data outside the
volatile Codex Plugin Cache. Before changing Plugin state, it SHALL combine any
eligible cached shells with that durable archive, and after installation it
SHALL restore at most the two most-recent non-current versions. A retained shell
SHALL contain only the Plugin snapshot's discovery configuration, Skills, and
descriptor bootstraps, and all executable lifecycle operations SHALL still
resolve to `/data/CoordExp/codex-harnessdock`.

The installer SHALL retain bounded coverage metadata for the last successful
installed version. If that known predecessor differs from the requested version
and cannot be reconstructed from either the durable archive or the existing
Cache, refresh SHALL fail before invoking Codex instead of silently dropping the
active-task compatibility promise. An installation with no prior coverage
metadata MAY proceed as an explicitly reported first-install or migration case.

#### Scenario: Existing task references the immediately previous version
- **WHEN** a versioned local release causes Codex to remove previous Cache versions
- **THEN** the installer restores the recent previous discovery path from durable owner-local data so an existing task can resolve its exact Skill/bootstrap without using cached lifecycle source

#### Scenario: Previous Cache disappeared before refresh starts
- **WHEN** the known previous version is absent from Codex Cache but its durable discovery archive is valid
- **THEN** refresh restores that version after installing the current snapshot and reports it as retained

#### Scenario: Known predecessor has no valid shell
- **WHEN** coverage metadata names a non-current previous version that is absent or invalid in both durable owner-local data and Codex Cache
- **THEN** refresh fails before calling Codex and reports the missing version without deleting or replacing current Plugin state

#### Scenario: First managed installation has no predecessor evidence
- **WHEN** no coverage metadata or durable archive exists before installation
- **THEN** installation may proceed, explicitly reports that no predecessor coverage was available, and archives the successfully installed current discovery shell for the next upgrade

#### Scenario: More than two prior versions exist
- **WHEN** preservation selects compatibility shells from Cache and durable owner-local data
- **THEN** it restores at most the two most-recent non-current version directories and bounds the durable archive to the current version plus those two predecessors

#### Scenario: Installation fails after cleanup begins
- **WHEN** Codex Plugin installation fails after compatibility shells were staged
- **THEN** the installer attempts to restore the selected shells before reporting the installation failure and does not advance successful-install coverage metadata

#### Scenario: Historical cache contains executable runtime source
- **WHEN** a cached or archived version contains content outside the compatibility whitelist
- **THEN** that content is not copied into the durable archive or restored shell

### Requirement: Runtime support scope is Linux
The checkout-owned runtime SHALL support Node.js 20.19 or newer on Linux. macOS
and native Windows behavior is best-effort and SHALL NOT be treated as a release
or compatibility guarantee without a separate OpenSpec change and real-platform
acceptance evidence.

#### Scenario: Supported Linux runtime starts
- **WHEN** the checkout runs on Linux with a compatible Node.js and host Claude CLI
- **THEN** the full runtime, installation, process-control, and state-protection contracts apply

#### Scenario: Non-Linux runtime is attempted
- **WHEN** the checkout is invoked on macOS or native Windows
- **THEN** any surviving defensive behavior is explicitly unsupported and its limitations do not block the Linux release

### Requirement: Public lifecycle workspace is inherited from Codex
Each model-facing lifecycle call SHALL use the canonical Codex turn workspace as the Agent workspace and SHALL NOT accept `--cwd`, `-C`, `--env-file`, or equivalent MCP fields. CLI calls SHALL inherit the host process working directory; MCP calls SHALL require the trusted sandbox-state `sandboxCwd` URI attached by Codex and SHALL NOT fall back to the server process cwd. Every lifecycle skill SHALL instruct Codex to confirm the intended checkout or worktree before invocation. Private detached-worker reconstruction and explicit read-only operator diagnostics MAY retain their own context arguments, and those arguments SHALL NOT be exposed by Plugin skills or MCP schemas.

#### Scenario: Codex invokes a lifecycle call from the intended worktree
- **WHEN** a Plugin CLI call inherits that cwd or a Plugin MCP call receives its trusted sandbox workspace metadata
- **THEN** the public runtime scopes Agent state to that worktree without a model-supplied context argument

#### Scenario: Model-facing context selector is supplied
- **WHEN** any public lifecycle invocation includes `--cwd`, `-C`, `--env-file`, or an equivalent MCP property
- **THEN** it fails before selecting a different workspace or environment

#### Scenario: MCP workspace metadata is unavailable
- **WHEN** an MCP lifecycle call lacks a valid local Codex sandbox workspace URI
- **THEN** it fails instead of using the Plugin Cache, bootstrap, or server process directory

#### Scenario: Detached worker reconstructs public context
- **WHEN** a public spawn hands a prepared job to its private detached worker
- **THEN** the runtime may pass the already-canonical workspace through the internal worker's `--cwd` argument

### Requirement: Installed bootstraps report missing checkout dependencies actionably
Before starting a checkout runtime entrypoint, each installed lifecycle and MCP bootstrap SHALL verify that the canonical checkout can resolve the required production dependencies. A missing dependency SHALL fail with a bounded message that names `/data/CoordExp/codex-harnessdock` and instructs `npm install`, without exposing the generic Node module-loader stack as the primary error.

#### Scenario: Checkout node_modules is missing
- **WHEN** an installed bootstrap cannot resolve the MCP SDK or Zod from the canonical checkout
- **THEN** it starts no runtime entrypoint and reports the checkout-specific `npm install` recovery

### Requirement: Plugin discovery version derives from package metadata
Local cachebuster refresh SHALL read the base release version from the canonical checkout `package.json`, replace any stale Plugin manifest base, and append exactly one `+codex.<cachebuster>` suffix. Initial installation SHALL validate the same relationship before calling Codex.

#### Scenario: Manifest base drift exists before refresh
- **WHEN** the Plugin manifest base differs from `package.json`
- **THEN** cachebuster refresh replaces it with the package base instead of preserving the stale value

#### Scenario: Install sees unsynchronized version metadata
- **WHEN** initial or refresh installation sees a Plugin base that does not match the package base
- **THEN** installation fails before changing Codex Plugin state

### Requirement: Runtime evidence is owner-only
Plugin-owned runtime state directories and log files SHALL use owner-only permissions on Linux, including correction of permissive modes on artifacts opened by the current runtime.

#### Scenario: Existing log has a permissive mode
- **WHEN** the runtime opens a Plugin-owned job log whose mode permits group or other access
- **THEN** it corrects the log to an owner-only mode before appending sensitive evidence

### Requirement: Compatibility refresh copies only discovery files
The local refresh path SHALL reconstruct a compatibility shell from an explicit whitelist of Plugin discovery descriptors and checkout-owned bootstrap files and SHALL NOT copy arbitrary content from an older cache snapshot.

#### Scenario: Old cache contains an unrelated executable
- **WHEN** an older discovery snapshot contains a file outside the compatibility whitelist
- **THEN** refresh does not copy that file into the new compatibility shell

### Requirement: Operator-owned Harness services remain outside Plugin lifecycle ownership
A checkout-owned Driver MAY attach to a preconfigured local service or use a host-installed Harness executable or SDK. The Plugin SHALL inspect readiness without installing, logging in, starting, stopping, restarting, reconfiguring, or exposing credentials for that Harness. Model-facing inputs SHALL NOT accept executable paths, endpoints, usernames, passwords, tokens, configuration paths, environment files, or lifecycle bypasses.

#### Scenario: Persistent service is unavailable
- **WHEN** side-effect-free readiness cannot reach the configured logical instance
- **THEN** that instance is reported unavailable and no Plugin action starts or repairs the service

#### Scenario: Operator has already authenticated a Harness
- **WHEN** the Driver can validate local readiness from its fixed checkout-owned configuration boundary
- **THEN** the Plugin may use the instance without copying credentials into prompts, receipts, logs, or durable locators

### Requirement: Each Driver owns a bounded environment view
The shared runtime SHALL parse the one canonical environment file as data and provide each static Driver only its allowlisted keys. The Pi Driver SHALL receive `PI_CODING_AGENT_DIR`; the OpenCode integration SHALL receive `OPENCODE_EXECUTABLE` and `OPENCODE_SERVER_URL`. The runtime SHALL NOT source `.bashrc`, evaluate shell code, select a second dotenv file, expose these values through model-facing input, or persist arbitrary environment values as readiness evidence.

#### Scenario: Two Drivers require different host settings
- **WHEN** their static environment schemas differ
- **THEN** each receives its admitted fixed values without changing the canonical environment-file owner or leaking the other Driver's private settings

#### Scenario: Shell profile differs from fixed configuration
- **WHEN** `/root/.bashrc` omits or conflicts with a Pi or OpenCode value present in the canonical environment file
- **THEN** HarnessDock uses the canonical environment value without reading or sourcing the shell profile

#### Scenario: Driver receives its bounded view
- **WHEN** the runtime constructs Pi and OpenCode dependencies
- **THEN** each integration receives only its admitted fixed values plus already-approved secret or host inheritance and does not receive the other Driver's configuration

### Requirement: OpenCode uses one exactly pinned network client
Before adding a production client, the checkout SHALL capture the configured Server/OpenAPI/SDK compatibility facts and then depend on one exact compatible `@opencode-ai/sdk` version or, only when no stable compatible SDK exists, one separately reviewed generated typed OpenAPI client. The runtime SHALL use only that pinned client connection to an existing Server. It SHALL NOT use a range, `latest`, a Server-spawning helper, embedded/in-process Server, raw provider client, ad hoc HTTP, or CLI stdout as the production integration. Upgrading or changing the client SHALL require captured type/fixture comparison and a separate compatibility decision.

#### Scenario: Dependency lock drifts
- **WHEN** package or lock metadata resolves another client version or shape than the accepted compatibility fixture
- **THEN** verification fails before OpenCode release acceptance

### Requirement: OpenCode connection configuration is fixed and secret-safe
The canonical runtime environment SHALL provide one checkout-owned loopback Server URL and one absolute OpenCode executable path. Optional official Basic-auth username/password variables SHALL be inherited only from the operator environment, admitted through an exact secret allowlist, and omitted from the tracked environment file and all receipts. The Driver SHALL use the executable only to ensure `opencode serve` on the fixed loopback origin and SHALL construct bounded authenticated SDK requests with explicit deadlines and no loopback proxy routing.

#### Scenario: Model-facing endpoint is supplied
- **WHEN** spawn, follow-up, or any other tool includes an endpoint, username, password, token, directory override, timeout bypass, or SDK option
- **THEN** strict validation rejects it before connection or state mutation

#### Scenario: Request exceeds its deadline
- **WHEN** health, discovery, session, message, or prompt-admission observation exceeds the Driver-owned bound
- **THEN** the request aborts with a sanitized retryability classification and never becomes a silent infinite wait

#### Scenario: Configured executable is invalid
- **WHEN** the fixed executable path is missing, non-absolute, or not executable
- **THEN** OpenCode readiness fails with a bounded redacted reason before process launch

#### Scenario: Model-facing endpoint or executable is supplied
- **WHEN** a lifecycle tool includes an endpoint, executable, credential, directory override, timeout bypass, or SDK option
- **THEN** strict validation rejects it before connection, process launch, or state mutation

### Requirement: OpenCode CLI remains diagnostic only
Production Agent lifecycle MAY invoke the configured `opencode serve` command to start the shared fixed-origin service for an admitted OpenCode turn. While that service is absent, bounded readiness MAY invoke and parse only the configured executable's native model and credential-list diagnostics needed to discover exact configured model/effort routes. Those diagnostics SHALL retain the operator's ordinary plugins and configuration, SHALL NOT use `--pure` or refresh remote model data, and SHALL NOT create a session or model request. The runtime SHALL NOT invoke or parse `opencode run`, TUI output, model-event stdout, or any CLI output as a turn, result, native-history, or terminal-settlement source. Session creation, prompt submission, and result selection SHALL remain on the pinned SDK boundary after service ensure.

#### Scenario: Dormant configured route is inspected
- **WHEN** the fixed Server is absent and the configured executable can report the operator's current model variants and credential provider
- **THEN** HarnessDock reports only those exact model/effort routes without starting the Server or a model turn

#### Scenario: Managed service is needed for a turn
- **WHEN** an admitted OpenCode Agent reaches pre-transport revalidation while the Server is absent
- **THEN** the Plugin invokes only `opencode serve` with fixed loopback host and port arguments before SDK route validation

#### Scenario: CLI diagnostic is malformed or inconsistent
- **WHEN** the bounded native diagnostic cannot prove an exact configured route
- **THEN** dormant readiness fails closed without aliasing a model, inventing an effort, starting the Server, or calling a provider

#### Scenario: CLI is absent but Server is reachable
- **WHEN** the pinned SDK can validate the configured Server and route
- **THEN** Driver readiness may succeed without a local `opencode` executable in the Plugin process environment

#### Scenario: Managed service is started
- **WHEN** the fixed Server is absent and the configured executable is valid
- **THEN** the Plugin invokes only `opencode serve` with fixed loopback host and port arguments and validates readiness through the pinned client

#### Scenario: Server is reachable without an executable
- **WHEN** a compatible fixed-origin Server already exists but the configured executable is unavailable
- **THEN** the Plugin may reuse the Server without invoking a CLI command

### Requirement: Managed OpenCode ownership is exact and private
HarnessDock SHALL serialize service ensure across processes with owner-only Plugin data, persist only the minimum process identity needed to prove a managed Server, recover stale ownership fences, and never treat endpoint reachability alone as process ownership. A started Server MAY outlive one MCP process for reuse by later tasks. There SHALL be no public start, stop, restart, endpoint, PID, or executable selector.

#### Scenario: Managed receipt is stale
- **WHEN** a receipt names a dead or identity-mismatched process
- **THEN** the next ensure discards that ownership claim under the fence and starts at most one replacement

#### Scenario: Started process fails readiness
- **WHEN** the exact child started by the current contender exits or cannot become healthy within the bounded startup deadline
- **THEN** the contender reports a bounded failure and may terminate only that exact proven child

### Requirement: Managed OpenCode startup is demand-driven
MCP startup, `list_harnesses`, doctor, and zero-model release smoke SHALL inspect or discover OpenCode without starting an absent Server. Only pre-transport validation for an admitted OpenCode turn MAY ensure the shared Server. A compatible already-running Server MAY still be reused without ownership.

#### Scenario: Codex task never uses OpenCode
- **WHEN** a Codex task loads HarnessDock and uses only Pi, Claude, or observational Agent tools
- **THEN** HarnessDock does not start an absent OpenCode Server

#### Scenario: Dormant OpenCode route is selected
- **WHEN** spawn selects an exact route advertised from current dormant native discovery
- **THEN** the detached turn path ensures one shared Server and revalidates the same route before creating a native session

### Requirement: Managed OpenCode idle reclamation is exact and process-only
The canonical environment SHALL admit one bounded OpenCode idle-TTL value whose default is 3,600 seconds. HarnessDock SHALL record managed service activity separately from health, hold one private durable lease for every submitted or acceptance-unknown OpenCode turn, and make reclamation eligible only after the TTL when no such lease exists. Under the existing cross-process fence it SHALL revalidate the ownership receipt, PID identity, command fingerprint, loopback endpoint, and absence of active peer work before requesting graceful termination of the exact managed process. It SHALL never stop a healthy reused service or delete durable Agent state. A bounded tombstone SHALL record only the process-only reclamation outcome.

#### Scenario: Managed service passes the idle boundary
- **WHEN** last admitted turn activity is at least 3,600 seconds old, every turn lease is released, and exact process identity still matches
- **THEN** one contender gracefully terminates that managed process and records a bounded tombstone without deleting logical state

#### Scenario: Reused service is idle
- **WHEN** a compatible fixed-origin service has no valid HarnessDock ownership receipt
- **THEN** HarnessDock leaves it running regardless of elapsed inactivity

#### Scenario: Active or unknown turn holds a lease
- **WHEN** any current turn is active or its native acceptance/settlement is unknown
- **THEN** reclamation leaves the service and lease unchanged

#### Scenario: Configured TTL is invalid
- **WHEN** the canonical environment states an absent, non-integer, non-positive, or out-of-range override
- **THEN** startup uses the one-hour default for absence and fails closed on an explicitly malformed override without evaluating shell code
