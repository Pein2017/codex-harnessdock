## MODIFIED Requirements

### Requirement: Driver registry is static and checkout-owned
The runtime SHALL resolve Driver modules only from a static in-tree registry in the canonical checkout. For this generation the registry SHALL admit exactly `claude-code`, `opencode`, and `pi`; only the Pi and OpenCode Drivers may discover the native routes their fixed local Harness configuration currently resolves. Model-facing and ambient inputs SHALL NOT select a Driver module, executable, endpoint, environment file, configuration store, capability snapshot, or implementation path. Adding another Driver SHALL require an OpenSpec-owned in-tree implementation, contract evidence, and an explicit public-generation decision.

#### Scenario: Claude route starts
- **WHEN** spawn explicitly selects `claude-code` with a supported Claude model, topology, and authority
- **THEN** the static registry resolves the checkout-owned Claude Code Driver and freezes its route snapshot

#### Scenario: Native route starts
- **WHEN** spawn explicitly selects `pi` or `opencode` with a full model, topology, authority, and an admitted effort
- **THEN** the static registry resolves that checkout-owned Driver and no default, alias, fallback, or caller-selected native configuration chooses a different route

#### Scenario: Caller supplies a Driver path
- **WHEN** a caller or ambient environment attempts to select a module, executable, Cache snapshot, external checkout, Server endpoint, or capability override
- **THEN** startup rejects the selector before any native process, session, model request, or durable Agent is created

### Requirement: Logical Harness instances are admitted before route validation
The checkout-owned Driver registry SHALL inspect a bounded static set of logical instances without model inference or lifecycle mutation. Pi inspection SHALL use native RPC discovery against its local `PI_CODING_AGENT_DIR` configuration. OpenCode inspection SHALL use only its already-connected fixed-origin Server provider catalog and variants while omitting an agent selector so the Server retains its native local agent/configuration. Instance inspection SHALL return a stable Driver-derived instance key, redacted readiness, `liveValidated`, maturity, and bounded discoverable native model and effort facts. Route validation SHALL require an admitted fresh instance and return one canonical immutable route plus its accepted capability snapshot; it SHALL never choose a Harness, model, topology, authority, native configuration, plugin, MCP server, tool set, or prompt template for the caller.

#### Scenario: Two admitted instances differ in readiness
- **WHEN** one logical instance is unavailable and another is ready
- **THEN** readiness reports each independently and the unavailable instance does not disable the ready one

#### Scenario: Instance selection is ambiguous
- **WHEN** a generation that exposes no instance selector discovers multiple eligible instances for one Harness
- **THEN** route validation fails closed rather than selecting one from order, environment, or prior use

#### Scenario: Native discovery changes before spawn
- **WHEN** a Pi or OpenCode route listed earlier is absent, differs, or becomes ambiguous in the fresh inspection used by spawn
- **THEN** the exact requested tuple is rejected before durable Agent creation or native transport and no alias, remembered route, or fallback is used

### Requirement: Initial OpenCode capabilities are independently experimental
Every exact discovered OpenCode route SHALL publish instance capacity one and an experimental snapshot with `noninteractive_fixed_policy`, initial-only input, unavailable history, unsupported interrupt request, unavailable restart observation, no automatic recovery, `authorityEnforcement=prompt_only`, `leafEnforcement=prompt_only`, and `nativeOrchestration=opaque_bounded`. Public topology SHALL remain `leaf`; opaque native orchestration means native delegation may exist but HarnessDock neither enumerates nor controls it. Native configuration is inherited but not enumerated by HarnessDock, and `write` SHALL not select a stronger or weaker native configuration. Continuation SHALL be `exact_resume` only when the compatibility probe proves authoritative exact session and Server/session incarnation binding across calls; otherwise it SHALL be `fresh_only`. Each later capability SHALL require its own evidence and OpenSpec change; enabling one SHALL NOT silently enable the others.

#### Scenario: History later becomes validated
- **WHEN** a future change proves bounded root-safe OpenCode history
- **THEN** that capability may advance without changing write, interrupt, active-input, concurrency, or orchestration maturity

#### Scenario: Server incarnation evidence is unavailable
- **WHEN** the pinned Server/client cannot prove that a persisted session belongs to the original authoritative instance and binding
- **THEN** continuation is fresh-only and same-Agent OpenCode follow-up is rejected without session reuse

## ADDED Requirements

### Requirement: Native route admission is exact, fresh, and immutable per Agent
For Pi and OpenCode, listing and spawn SHALL each obtain bounded current native route facts without a model inference call or persistent HarnessDock cache. Spawn SHALL require and validate the caller's exact Harness, model, topology, authority, and effort, and SHALL revalidate that exact tuple immediately before native transport. Native route snapshots SHALL state `authorityEnforcement=prompt_only`, `leafEnforcement=prompt_only`, and `nativeOrchestration=opaque_bounded`; the public topology remains `leaf` and no native delegation is enumerated or controlled by HarnessDock. Spawn without effort SHALL fail before session, message, provider, durable mutation, or native transport work; no Driver SHALL infer, select, store, or use a native default. A persisted Agent SHALL retain its accepted route, including effort, and capability lineage; follow-up, recovery, or observation SHALL fail closed when that Driver can no longer prove the route rather than substituting a current route.

#### Scenario: Required effort is omitted
- **WHEN** a caller omits reasoning effort for a Pi or OpenCode route
- **THEN** spawn rejects before session, message, provider, durable mutation, or native transport work and no Driver infers a default

#### Scenario: Requested effort is not native-admitted
- **WHEN** a caller states an effort not exposed for the exact native model or variant
- **THEN** validation fails before durable mutation or native transport

#### Scenario: Existing route disappears
- **WHEN** an existing Pi or OpenCode Agent needs a Driver operation after its exact accepted route is no longer provable from fresh native facts
- **THEN** that operation fails closed and the runtime does not reroute, recreate, or continue the Agent on another model, variant, profile, or Harness
