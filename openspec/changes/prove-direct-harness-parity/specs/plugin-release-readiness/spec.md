## ADDED Requirements

### Requirement: Differential parity gates Harness release claims
Release acceptance SHALL require every deterministic matrix row applicable to the released Driver generation, sensitivity evidence for decision-bearing rows, zero surviving test-owned processes, and source-specific sanitized receipts. A passing self-referential unit suite, one successful smoke, or a plumbing-only model response SHALL NOT establish native configuration, lifecycle, history, or usage parity.

#### Scenario: Deterministic matrix row regresses
- **WHEN** a sensitivity mutation changes route selection, configuration inputs, event ordering, authority enforcement, history identity, usage provenance, or cleanup and the corresponding differential row does not fail
- **THEN** release acceptance fails until that row has an independent oracle with demonstrated sensitivity

#### Scenario: All deterministic rows pass
- **WHEN** the complete capability-qualified fake-native matrix, focused checks, and `npm run check` pass with no owned process leak
- **THEN** the candidate is deterministically accepted without requiring a paid live call
