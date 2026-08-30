## ADDED Requirements

### Requirement: OpenCode admission establishes maximum permissions without unattended interaction
Before advertising or creating an OpenCode session, the Driver SHALL establish the highest supported permission surface while denying only `question`, `plan_exit`, and `task` for zero-wait execution. A managed child SHALL receive exact `OPENCODE_PERMISSION='{"*":"allow","doom_loop":"allow"}'`; `POST /session` SHALL use ordered rules wildcard `allow`, then `question: deny`, `plan_exit: deny`, `task: deny`, and `doom_loop: allow`. The Driver SHALL preserve the exact provider/model/variant route and omit an Agent selector. It SHALL NOT use user/global/project configuration mutation, a permission/question broker, prompt tool map, auto-answer, or a model call to establish admission.

#### Scenario: Managed child has the requested policy
- **WHEN** a managed OpenCode child is created for an otherwise valid exact route
- **THEN** its child-local environment is exactly the managed wildcard plus `doom_loop` allow policy and the session request has the declared ordered wildcard/terminal-deny rules plus terminal `doom_loop` allow

#### Scenario: Ordinary Agent rule is overridden by the session wildcard
- **WHEN** the resolved default Agent has an ordinary permission rule that conflicts with the session wildcard
- **THEN** admission treats the session wildcard as controlling that ordinary rule and does not reject merely for a generic native `ask`

### Requirement: Native exception witness proves zero-wait execution
At list, after managed-Service ensure, and immediately before `POST /session`, the Driver SHALL perform bounded health, provider, config, and agent observations against the connected Server. The final `GET /agent` SHALL immediately precede `POST /session`. The config/agent witness SHALL resolve exactly one default Agent and require terminal `doom_loop:*:allow`, because session wildcard policy does not override that Agent-scoped rule. GitLab `duo-workflow-*` models SHALL be excluded because their separate unoverrideable `ask` cannot satisfy zero-wait execution.

#### Scenario: Final doom-loop witness passes
- **WHEN** the final health/provider/config/agent observations are valid, preserve the exact route, and resolve the default Agent to terminal `doom_loop:*:allow`
- **THEN** the Driver may create one session using the declared ordered policy without an Agent selector

#### Scenario: Native exception witness fails or drifts
- **WHEN** any required observation is missing, malformed, ambiguous, incompatible, or no longer resolves terminal `doom_loop:*:allow`, or the model is `duo-workflow-*`
- **THEN** the Driver exposes no runnable route or rejects the turn with only sanitized `interactive_policy`, issues zero `POST /session`, prompt, or model request, and releases pre-transport local state

### Requirement: Managed and attached service ownership remains distinct
The managed-Service fingerprint/receipt SHALL bind a nonsecret policy-generation digest and child-local environment identity. Attached Servers SHALL NOT be restarted, replaced, or mutated to install policy; they may run only after the final native witness proves the exceptional policy. Compatibility SHALL be pinned and revalidated against installed OpenCode 1.18.23, not inferred from the 1.18.18 reference source or SDK. This claim excludes hostile Server configuration mutation after the final `GET /agent`, because no atomic read-and-create witness exists.

#### Scenario: Attached Server cannot prove the exception
- **WHEN** an attached Server fails its final native witness
- **THEN** HarnessDock does not repair or replace it and reports only sanitized `interactive_policy`

#### Scenario: Another Harness is inspected
- **WHEN** Pi or Claude readiness and admission run under their existing contracts
- **THEN** this OpenCode admission policy does not alter their routes or native configuration
