## MODIFIED Requirements

### Requirement: Native terminal evidence is exact and restart-safe observation is read-only
The process-local LiveTurn SHALL be owned by the original pinned blocking prompt request. Terminal success from that request SHALL require matching session, parent, provider, model, attempt, coherent assistant finish/error evidence, and a valid final result. `prompt_async` acceptance, HTTP 204, session status, health, Server PID, elapsed silence, or origin equality SHALL NOT prove acceptance or terminal settlement.

For a version-three turn with a durable exact native-turn locator, the OpenCode Driver SHALL provide a separate read-only observer over the native event/history surfaces. It SHALL establish terminal settlement only when the persisted exact session/user-message/attempt/provider/model lineage, native event/history lineage, and terminal assistant evidence cohere. It SHALL never send a prompt, use `prompt_async`, replay input, abort, mutate the session, or promote a partial, foreign, missing, active, malformed, or contradictory observation. After possible acceptance, any observation that cannot meet those conditions SHALL retain `unknown` settlement and the matching lease.

#### Scenario: Blocking request returns matching result
- **WHEN** exact turn lineage, coherent terminal evidence, and the bounded final result all validate
- **THEN** the Driver may publish one completed terminal result and release matching capacity

#### Scenario: Worker disappears after possible acceptance
- **WHEN** the original live request can no longer produce authoritative terminal evidence but the durable exact native-turn locator remains available
- **THEN** the read-only observer may be used only by the version-three reconciler and an unproven observation publishes no completion and retains capacity

#### Scenario: Observer finds a foreign or contradictory event
- **WHEN** event/history data does not exactly match the persisted session, user-message, attempt, provider, and model lineage or conflicts with terminal evidence
- **THEN** the Driver rejects it as terminal evidence without sending input, changing native state, or releasing the lease

### Requirement: Initial optional operations fail honestly
The OpenCode snapshot SHALL declare active input, public assistant history, public interrupt, automatic recovery, native orchestration, approval brokerage, and write authority unsupported. It SHALL declare native progress and restart observation only when the bounded read-only event/message observation and exact terminal-lineage validation required by this specification are admitted; otherwise those capabilities remain unavailable. `send_message` MAY queue a message but SHALL not claim active delivery. `followup_task` SHALL obey the route's proven `exact_resume` or `fresh_only` continuation. `interrupt_agent` SHALL return an explicit unsupported result without calling abort or status as a substitute for settlement. `read_agent_messages` SHALL return unsupported and SHALL NOT expose the private native events or message records used only for progress and exact-turn observation.

#### Scenario: Active OpenCode Agent receives follow-up
- **WHEN** the current turn has not settled and active input is unsupported
- **THEN** follow-up rejects before mailbox mutation rather than promise queued activation

#### Scenario: OpenCode publishes bounded native progress
- **WHEN** the admitted read-only observer receives an exact-session event/history lifecycle, tool, or message milestone for an active turn
- **THEN** the Driver projects only a coalesced bounded safe progress revision and retains the raw event/history data private

#### Scenario: Interrupt is requested
- **WHEN** the OpenCode route is active
- **THEN** the Plugin reports unsupported and does not treat abort or status as proven settlement
