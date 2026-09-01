## ADDED Requirements

### Requirement: Drivers bind managed execution identity before it can be orphaned
A process-backed Driver SHALL expose the exact PID and deterministic process
identity of every local child that can continue turn-owned work, and the
supervisor SHALL durably bind that receipt to the launch attempt before the
Driver may submit native input. A service-backed Driver SHALL instead bind one
closed ownership classification: exact HarnessDock-managed service and turn
lease, or reused/operator-owned service with no termination authority.

The receipt is a private resource-control fact, not native settlement evidence
or a universal public Driver result field. It MUST NOT be used to infer native
acceptance, completion, model output, or resumability.

#### Scenario: Process-backed Driver cannot prove child identity
- **WHEN** the Driver launched a local process but cannot bind its deterministic identity before possible submission
- **THEN** the turn fails pre-transport and no model work or hard-reclaim-eligible record is created

#### Scenario: Service-backed Driver uses managed ownership
- **WHEN** the exact managed service receipt and target turn lease are durably bound
- **THEN** later resource control may address only that receipt-proven scope and still requires independent settlement evidence

#### Scenario: Service-backed Driver uses reused ownership
- **WHEN** the Driver attaches to a compatible operator-owned service
- **THEN** the turn may proceed with reused classification but no later HarnessDock lifecycle may terminate that service
