## ADDED Requirements

### Requirement: Managed shared-service residency expires independently from durable history
HarnessDock SHALL make a managed shared Harness service eligible for process-only reclamation after one hour without an admitted native turn using that service. Readiness, health, model discovery, doctor, release smoke, and receipt inspection SHALL NOT refresh activity. Reclamation SHALL preserve every Agent, job, message, native reference, completion, result, usage receipt, and audit record.

#### Scenario: Managed service becomes idle
- **WHEN** the service has no active or uncertainty-held turn lease and its last admitted turn activity is at least one hour old
- **THEN** HarnessDock may terminate only the exact receipt-proven managed process and leaves all durable logical state intact

#### Scenario: Health is inspected repeatedly
- **WHEN** health, doctor, or Harness discovery probes occur without an OpenCode turn
- **THEN** the service's last turn activity remains unchanged and the probes do not postpone idle eligibility

#### Scenario: Native settlement is unknown
- **WHEN** a turn may have been accepted but exact terminal settlement is unavailable
- **THEN** its durable service lease remains held and idle reclamation does not terminate the shared service

### Requirement: Task-owned MCP residency does not self-expire without transparent host recovery
A live Codex task's stdio MCP process SHALL NOT exit solely because no HarnessDock tool was called for an elapsed interval unless a production-shaped host probe proves that the same task transparently restarts the MCP server, restores trusted task/workspace context, and completes the next operation without user reload or logical-state loss.

#### Scenario: Host restart behavior is unproven
- **WHEN** the MCP connection remains open but no HarnessDock tool has been called for any duration
- **THEN** HarnessDock keeps the task-owned MCP process available rather than converting inactivity into an unavailable Plugin

#### Scenario: Stdio transport closes
- **WHEN** the Codex host closes the MCP transport or sends the supported shutdown signal
- **THEN** the MCP process exits promptly without affecting detached Agents or durable history
