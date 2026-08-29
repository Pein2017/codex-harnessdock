## Purpose

Defines independent evidence that HarnessDock preserves each supported Harness's native configuration and observable turn semantics instead of validating only against HarnessDock's own expectations.

## ADDED Requirements

### Requirement: Every admitted Harness has a capability-qualified differential matrix
The checkout SHALL define one direct-native versus HarnessDock matrix for each admitted Harness. It SHALL cover exact model and per-model effort inventory, launch argv/environment, native configuration inheritance, prompt delta, authority parity, event order, tool surface, interrupt, `exact_session_continuation`, `cross_process_turn_observation_or_reconciliation`, `automatic_recovery_exact_session_transport`, terminal classification, route drift, native usage provenance, and process lifecycle. Every cell SHALL record exactly one of `pass`, regression `fail`, prerequisite `hold`, or capability-derived `not_applicable`. A cell may be `not_applicable` only when the accepted capability snapshot makes the operation unavailable.

#### Scenario: Expected external prerequisite HOLD is deterministically tested
- **WHEN** a zero-model test correctly detects and records a required external prerequisite as `hold`
- **THEN** that test passes, but final parity/release acceptance remains blocked until the required cell is `pass` or justified `not_applicable`

#### Scenario: Claude Code 2.1.250 exact dynamic discovery is unavailable
- **WHEN** Claude Code 2.1.250 cannot supply exact dynamic model/effort discovery
- **THEN** its exact-route inventory cell is recorded as `hold` with a sanitized negative-control receipt; it SHALL NOT be reported as `pass`, `fail`, or capability-derived `not_applicable`, and no static catalog, configuration, authority, or transport fallback may satisfy it

#### Scenario: OpenCode interrupt is unsupported
- **WHEN** the OpenCode route snapshot states interrupt is unsupported
- **THEN** its interrupt cell is recorded as capability-derived `not_applicable` rather than silently skipped or reported as parity

### Requirement: Differential expectations come from independent native evidence
Each matrix row SHALL compare a native Harness output, invocation capture, history source, or native-reported receipt with the corresponding HarnessDock result. A HarnessDock helper, constant, generated expected value, or copy of its own Driver projection SHALL NOT serve as both the subject and oracle.

#### Scenario: HarnessDock and direct fixtures share one expected constant
- **WHEN** a test derives both sides from the same HarnessDock-owned model, prompt, event, or usage constant
- **THEN** acceptance rejects the row as self-referential evidence

### Requirement: Final parity acceptance closes required matrix cells
Generic deterministic matrix infrastructure and rows backed by deterministic native evidence MAY be implemented while another required cell is `hold`. Final parity/release acceptance SHALL pass only when every required matrix cell is `pass` or justified `not_applicable`; `hold` is not parity and blocks that promotion.

#### Scenario: Pi and OpenCode evidence is complete while Claude discovery is on hold
- **WHEN** supported Pi/OpenCode dimensions and deterministic Claude non-catalog/config/authority/transport dimensions have evidence, but Claude exact dynamic model/effort discovery remains `hold`
- **THEN** their deterministic rows may be implemented and tested, while final parity/release acceptance remains blocked

### Requirement: Exact native-session continuation survives a fresh process
Every route claiming `exact_resume` SHALL have an `exact_session_continuation` row that captures stable native session `S` and accepted old turn `T1`, constructs a fresh Driver in another process, passes `S` with new continuation input, and proves the accepted new turn `T2` remains in `S` and is distinct from `T1`. The row SHALL NOT pass `T1` as the continuation target, require old-turn observation, or satisfy an automatic-recovery claim.

#### Scenario: Fresh continuation accepts a distinct turn in the same session
- **WHEN** the fresh Driver continues a stable native session with new input
- **THEN** the row passes only when the provider-native session remains `S`, the new turn is accepted, and `T2` is distinct from the previously accepted `T1`

### Requirement: Cross-process old-turn observation or reconciliation binds no new input
Every route claiming `terminal_observable` SHALL have a separate `cross_process_turn_observation_or_reconciliation` row. A fresh observer/reconciliation SHALL submit no new input and SHALL bind the already accepted `T1` through the same persistent provider-native turn identity or exactly one authoritative pre/post history delta. A random UUID, process-local PID/request/job ID, array index, replay counter, scope-local ID, synthetic identity, or ambiguous history diff SHALL not qualify.

#### Scenario: Fresh observer cannot identify exactly one old turn
- **WHEN** no-prompt authoritative observation after restart yields zero, multiple, or ambiguous candidate turns
- **THEN** the route cannot claim old-turn observation/reconciliation, its capability fails closed or is downgraded, and no guessed reference is published

#### Scenario: Pi observer uses a scope-local latest result
- **WHEN** Pi's observer binds HarnessDock `scope.turnId` or a latest post-baseline result rather than an authoritative one-turn observation
- **THEN** deterministic acceptance rejects its `terminal_observable` claim until a production correction supplies an unambiguous authoritative observer, without deciding Pi's separate session-continuation row

### Requirement: Exact-session transport recovery is replay-safe and separately witnessed
Every route claiming `automaticRecovery=exact_session_transport` SHALL have a separate `automatic_recovery_exact_session_transport` row. Starting from an accepted interrupted turn, the row SHALL exercise only the provider-declared bounded reconnect semantics, submit no duplicate prompt/input or replay of accepted input, and prove the same logical/native accepted turn or an authoritative provider-defined recovery binding. `exact_session_continuation` SHALL NOT satisfy this requirement. A route that does not claim `automaticRecovery=exact_session_transport` SHALL record this row as capability-derived `not_applicable`.

#### Scenario: Recovery reconnect duplicates accepted input
- **WHEN** transport recovery resubmits a prompt/input that was already accepted, creates an unbound replacement turn, or exceeds the provider-declared reconnect bound
- **THEN** the automatic-recovery row fails and the route cannot claim `automaticRecovery=exact_session_transport`

### Requirement: Live differential witnesses are bounded and optional
Deterministic fake-native comparisons SHALL run without model usage. A live witness SHALL require separate authorization, run only after deterministic gates, execute at most one minimal low-effort turn per Harness with no automatic retry, stop on authentication, quota, route, or protocol failure, and record sanitized source-specific usage fields without cost inference.

#### Scenario: Live witness is not authorized
- **WHEN** deterministic acceptance completes without explicit live-call permission
- **THEN** the change remains deterministically verifiable and starts no Harness model turn
