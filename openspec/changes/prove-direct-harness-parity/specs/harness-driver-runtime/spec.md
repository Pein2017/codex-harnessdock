## ADDED Requirements

### Requirement: Drivers expose parity evidence only through existing owners
Each Driver SHALL provide bounded test and receipt seams for the native facts required by its differential matrix while keeping protocol, history, process, usage, and configuration details behind existing Driver/runtime owners. The change SHALL NOT add a generic event API, second lifecycle interface, transcript store, ACP abstraction, or model-facing native implementation selector.

#### Scenario: A parity test needs native event order
- **WHEN** deterministic comparison captures Driver-native events
- **THEN** the owning Driver exposes a bounded fixture/receipt at its existing seam rather than adding a new public lifecycle operation
