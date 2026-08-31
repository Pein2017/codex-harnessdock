## MODIFIED Requirements

### Requirement: Detached worker handoff transfers job and session-lease ownership once
The existing launcher generation, worker publication/claim, cleanup fence,
submission claim, and `rollback_safe | lifecycle_owned |
ownership_uncertain` disposition SHALL remain the only authority for handoff
rollback. An MCP abort signal MAY prevent launch before the durable launch
boundary. Once OS worker spawn or native submission may have begun, cancellation
SHALL NOT signal the worker, release leases, delete the prepared job, or convert
transport loss into rollback. The runtime SHALL first establish the existing
authoritative disposition and retain every non-rollback-safe owner.

#### Scenario: Abort is observed before worker/native launch
- **WHEN** no worker or native request can have been created
- **THEN** launch reports or preserves `rollback_safe` and existing guarded
  cleanup may run

#### Scenario: Abort races worker publication
- **WHEN** cancellation arrives while publication, worker claim, cleanup fence,
  or native acceptance is unresolved
- **THEN** the runtime finishes that ownership race without using cancellation
  as an execution fence

#### Scenario: Worker lifecycle owns the turn
- **WHEN** durable evidence proves `lifecycle_owned`
- **THEN** the job and leases remain owned independently of MCP transport and
  the public failure carries the stable Agent name

#### Scenario: Handoff remains uncertain
- **WHEN** neither accepted ownership nor confirmed fenced termination can be
  proven
- **THEN** the job reports `ownership_uncertain`, retains Agent attachment and
  leases, and no destructive rollback occurs
