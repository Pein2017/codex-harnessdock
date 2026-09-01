## MODIFIED Requirements

### Requirement: Managed OpenCode idle reclamation is exact and process-only
The canonical environment SHALL retain one bounded OpenCode idle-TTL value whose
default is 3,600 seconds. HarnessDock SHALL record managed service activity
separately from health and hold one private durable service-turn lease for every
submitted or acceptance-unknown OpenCode turn. Ordinary idle reclamation SHALL
remain eligible only after the TTL when no such lease exists.

The independent residency manager SHALL own ordinary idle and unknown-turn
deadlines. After one service turn has remained durably unknown for one hour, it
MAY terminate the exact managed service only when the matching ownership
receipt, PID identity, command fingerprint, loopback endpoint, sole target
lease, and absence of peer work all revalidate under the existing cross-process
fence. It SHALL never stop a healthy reused/operator-owned service or a managed
service with another active/unknown turn. A bounded tombstone SHALL record only
the process and lease dispositions; all durable Agent and semantic state SHALL
remain intact.

#### Scenario: Managed service passes the idle boundary
- **WHEN** last admitted turn activity is at least 3,600 seconds old, every service-turn lease is released, and exact process identity still matches
- **THEN** one manager generation gracefully terminates that managed process and records a bounded tombstone without deleting logical state

#### Scenario: Reused service is idle
- **WHEN** a compatible fixed-origin service has no valid HarnessDock ownership receipt
- **THEN** HarnessDock leaves it running regardless of elapsed inactivity

#### Scenario: Active or newly unknown turn holds a lease
- **WHEN** any current turn is active or its native acceptance/settlement has been unknown for less than one hour
- **THEN** reclamation leaves the service and service-turn lease unchanged

#### Scenario: Sole managed unknown turn reaches one hour
- **WHEN** one unknown turn is the exact managed service's sole lease and every ownership and peer-absence check passes
- **THEN** the manager may terminate only that service, prove it dead, release the matching service-turn lease, and retain semantic settlement as unknown

#### Scenario: Another service turn remains
- **WHEN** the managed service has another active or unknown turn lease at the target's hard boundary
- **THEN** HarnessDock does not terminate the shared service or release the target's service-turn lease merely to reclaim one worker

#### Scenario: Configured TTL is invalid
- **WHEN** the canonical environment states an absent, non-integer, non-positive, or out-of-range override
- **THEN** startup uses the one-hour default for absence and fails closed on an explicitly malformed override without evaluating shell code
