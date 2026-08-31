## MODIFIED Requirements

### Requirement: Harness Drivers own one complete native turn
Each Harness Driver SHALL own executable or service discovery, native configuration and authentication, Harness-specific unreadiness, route validation, prepared-turn validation and immediate revalidation, prompt/envelope construction, protocol parsing, native tool/subagent behavior, bounded transport recovery, native session and turn evidence, bounded native progress projection, failure classification, and optional native history for one complete Agent turn. The supervisor SHALL consume a versioned Driver contract that returns a process-local live turn handle after native acceptance. The live handle SHALL expose one completion promise and only the progress-subscription, active-input, or interrupt-request methods admitted by the accepted capability snapshot. The supervisor SHALL NOT require a child PID, integer exit status, token-level protocol, or tool-schema parity.

The Driver SHALL publish a Driver-validated, secret-free durable native-turn reference before input is considered accepted and MAY separately publish a native-session reference for continuation. The same Driver MAY expose an admitted read-only terminal observer and progress source for that exact reference; they SHALL neither submit input, replay input, mutate a native session, prompt asynchronously, emulate a terminal, nor expose a raw event stream. Those references MAY be used only by the same Driver's bounded validators/observer and SHALL NOT contain a live socket, stream, callback, bearer credential, authentication header, executable environment, arbitrary URL, or general serialized Driver state. The normalized terminal result SHALL contain native turn state, execution-world settlement, continuation evidence, bounded activity/metrics receipts, and the final outer-assistant message or an explicit absence reason. It SHALL remain Harness-neutral and SHALL NOT require a repository-research ontology or native tool/event transcript.

#### Scenario: Local CLI turn completes
- **WHEN** a Driver-owned child process exits and the Driver proves coherent native terminal and execution settlement evidence
- **THEN** the Driver returns one Harness-neutral terminal result without making process evidence a universal contract field

#### Scenario: Service-backed turn completes
- **WHEN** a Driver observes a terminal service session while no Plugin-owned model process exists
- **THEN** the same supervisor lifecycle accepts that terminal evidence without inventing an exit status or child PID

#### Scenario: Native result is contradictory
- **WHEN** terminal status conflicts with native turn state, execution settlement is active or unknown, the durable reference is invalid for that Driver, or the result belongs to another Harness, instance, route, or Driver version
- **THEN** the supervisor rejects terminal projection and retains conservative ownership instead of publishing a false completion

### Requirement: Driver capabilities are closed, versioned, and fail closed
Each admitted logical Harness instance SHALL publish a versioned route-specific capability snapshot for interaction policy, active input, transcript continuation, history, native progress, interrupt request, terminal observation, automatic recovery, authority enforcement, leaf enforcement, and native orchestration using closed values. Interaction policy SHALL be `noninteractive_fixed_policy` or `requires_broker`; the first multi-Harness generation SHALL admit only `noninteractive_fixed_policy`. Capability maturity SHALL be recorded independently as `experimental` or `validated`. Every prepared Agent turn SHALL persist the accepted Driver version, capability-schema version, instance key, canonical route, and capability snapshot. Unknown values, missing required capabilities, caller-supplied overrides, broker-required routes, or use of an operation not admitted by that exact snapshot SHALL fail before native input acceptance or return an explicit unsupported receipt without mutating continuity.

Future Harness proposals SHALL state and test whether their noninteractive native progress and exact terminal-observation surfaces are unavailable, admitted, or deliberately not applicable. Experimental admission MAY report either surface unavailable, but a route SHALL NOT claim validated lifecycle maturity while it ignores a natively available progress surface.

#### Scenario: Active input is unsupported
- **WHEN** a caller sends a message to a route whose snapshot declares initial input only
- **THEN** the supervisor durably queues the message and does not claim active delivery

#### Scenario: Interrupt can be requested but not observed after worker loss
- **WHEN** a route admits live interrupt requests but no restart-safe terminal observation
- **THEN** the live worker may request interruption, while a lost worker leaves settlement `unknown` and retains affected leases

#### Scenario: A native progress surface is unavailable
- **WHEN** a Driver's admitted capability snapshot reports native progress unavailable
- **THEN** it does not synthesize activity from silence, polling, or raw transcript data

#### Scenario: A future Harness ignores native progress
- **WHEN** a future Harness exposes a bounded noninteractive native progress surface but its proposal or validation omits its integration
- **THEN** that route cannot be labelled lifecycle-mature validated

#### Scenario: One experimental capability fails
- **WHEN** an experimental capability is unavailable or fails validation for one route
- **THEN** the runtime blocks that operation or route without automatically disabling unrelated capabilities or logical instances

#### Scenario: Harness requires interactive approval
- **WHEN** route inspection reports `requires_broker`
- **THEN** the first-generation runtime reports the route unavailable instead of auto-approving, waiting on a TUI, or inventing a generic approval protocol

### Requirement: Model-facing wait remains completion-first and progress-bounded
Harness Drivers SHALL project only bounded native progress evidence to the shared supervisor and SHALL NOT control model-facing polling cadence or delivery budget. The supervisor SHALL preserve the fixed `bound-model-facing-agent-wait` contract: normal joins wait until completion or their bounded timeout; `wake_on_progress: true` deliberately long-polls until at most one newer meaningful non-hook public-progress revision or completion; completion wins over progress; and repeated quiet observations do not manufacture a revision or invite automatic model polling.

At bounded `wait_agent` reconciliation points, the supervisor SHALL invoke the existing version-three worker-loss reconciler for affected eligible turns. A later authoritative Driver terminal observation MAY then publish completion and release matching leases exactly once. Active, missing, foreign, malformed, or contradictory observations SHALL remain unknown and retain leases.

#### Scenario: Long Harness turn emits many hook events
- **WHEN** the caller intentionally observes progress while no useful non-hook revision or completion exists
- **THEN** the supervisor returns no synthetic update and does not invite a tight wait loop

#### Scenario: Completion and progress become available together
- **WHEN** a Driver reaches terminal state while a new progress revision is pending
- **THEN** the supervisor delivers completion first under the existing acknowledgement contract

#### Scenario: Reconciliation finds an exact terminal result
- **WHEN** a bounded wait reconciliation observes coherent terminal evidence for an eligible version-three worker-loss turn
- **THEN** the existing reconciler publishes the one completion and releases its matching lease exactly once

#### Scenario: Reconciliation cannot prove settlement
- **WHEN** an eligible turn's observation is active, missing, foreign, malformed, or contradictory
- **THEN** wait does not publish completion from it and the affected lease remains held
