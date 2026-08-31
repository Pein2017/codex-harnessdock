## MODIFIED Requirements

### Requirement: wait_agent returns bounded root mailbox activity
Model-facing `wait_agent` SHALL accept optional `wake_on_progress`, optional non-empty unique exact current-root `targets`, and the HarnessDock durable-delivery extension `acknowledge_tokens`; SHALL NOT expose `timeout_ms`; and SHALL use a fixed 3600000 ms observation upper bound. With no targets, wait SHALL preserve the Codex-V2-shaped root-wide next-activity behavior and return at most one current-root update. With one target it SHALL join the concrete active or latest turn snapshotted at call entry; when that one target is combined with `wake_on_progress: true`, the same bounded observation MAY instead return that snapshotted job's one eligible advisory progress revision before completion. With multiple targets it SHALL remain completion-only, wait for every concrete snapshotted turn to settle, and return one aggregate barrier receipt in caller target order. A later activation SHALL NOT extend or satisfy that fixed snapshot. Model-facing guidance SHALL make no-target, no-progress wait the canonical ordinary root join and targeted wait the canonical result-required join when the parent knows the dependency set. `wake_on_progress: true` is an explicit long-poll request, not a polling instruction: after it returns one meaningful bounded revision, another model-facing call is required to observe a later revision.

The runtime SHALL process only valid previously delivered acknowledgement tokens, SHALL acknowledge targeted events independently of older unrelated unread events, and SHALL derive compaction only through the highest fully acknowledged or quarantined sequence. It SHALL prioritize eligible target completion over advisory target progress. A delivered completion SHALL include the complete stored Agent final message, legacy-compatible truncation flag, and opaque delivery token. Targeted/barrier output SHALL omit unrelated completions, hook activity, raw inbox state, full Agent records, result pointers, native session evidence, native event payloads, and reconciliation detail, and SHALL NOT acknowledge a newly returned completion in the same call. The checkout CLI and public runtime operation SHALL retain explicit 0..3600000 ms diagnostic selection independently of the fixed model-facing bound.

#### Scenario: Unread activity predates untargeted wait
- **WHEN** the root inbox already contains an unread Agent completion and the caller omits targets
- **THEN** wait returns one oldest status/summary/complete-final-message update with an opaque delivery token and leaves it unread

#### Scenario: Later wait confirms prior delivery
- **WHEN** a later wait echoes valid previously delivered Agent completion tokens
- **THEN** each named event becomes acknowledged idempotently and compaction advances only through the highest sequence with no unread Agent-linked hole

#### Scenario: Caller joins one exact Agent turn
- **WHEN** `targets` contains one Agent whose active turn is snapshotted at wait entry and progress wakeup is omitted
- **THEN** only that job's completion, blocker, non-joinable state, or timeout can resolve the targeted join

#### Scenario: Caller observes one exact Agent turn repeatedly
- **WHEN** `targets` contains one Agent, `wake_on_progress: true`, and its snapshotted job publishes a later meaningful eligible revision after an earlier progress observation
- **THEN** a later explicit wait remains scoped to that same target job and may return the newer bounded revision or completion

#### Scenario: Unrelated activity occurs during targeted progress wait
- **WHEN** another current-root Agent publishes completion or progress while the selected target remains active
- **THEN** the unrelated activity neither resolves nor blocks the targeted observation and remains available to its proper consumer

#### Scenario: Caller joins a fixed barrier
- **WHEN** `targets` contains multiple valid Agents with concrete snapshotted jobs and progress wakeup is omitted
- **THEN** wait returns the aggregate completion only after every snapshotted job is completed, failed, or interrupted

#### Scenario: Caller requests progress from multiple targets
- **WHEN** `targets` contains two or more Agents and `wake_on_progress: true`
- **THEN** strict validation rejects the call before acknowledgement, delivery, or Agent state changes

#### Scenario: Follow-up starts during a barrier
- **WHEN** a target's snapshotted job settles and the same Agent starts a later follow-up before the remaining targets settle
- **THEN** the later job neither extends the barrier nor replaces the frozen status and handoff for the snapshotted job

#### Scenario: Unrelated completion predates a target completion
- **WHEN** an unread completion outside the target set has a lower sequence than a target completion
- **THEN** targeted wait leaves the unrelated event unread and unfrozen while returning and later acknowledging the eligible target event independently

#### Scenario: Target is not joinable
- **WHEN** a resolved Agent has no concrete active or latest job, or its Agent/job linkage is irreconcilable
- **THEN** wait returns that target as non-joinable immediately without activating an Agent or consuming the observation window

#### Scenario: Barrier reaches its quiet bound
- **WHEN** at least one snapshotted target remains active through the fixed 3600000 ms window
- **THEN** wait returns a per-target status snapshot and unresolved targets without freezing or acknowledging partial completion payloads

#### Scenario: Root Agent publishes progress during ordinary join
- **WHEN** a current-root Agent publishes safe progress before the fixed deadline, no completion is unread, and the caller omitted or disabled `wake_on_progress`
- **THEN** wait does not return or acknowledge that progress and continues to completion or timeout

#### Scenario: Caller requests one root-wide progress observation
- **WHEN** a current-root Agent job publishes a meaningful eligible non-hook safe progress revision before the fixed deadline, no completion is unread, the caller set `wake_on_progress: true`, and targets are absent
- **THEN** wait reports that job's bounded progress update without returning model text, tool inputs, or native event payloads

#### Scenario: Root Agent completes during untargeted wait
- **WHEN** any current-root Agent publishes completion activity before the fixed deadline and targets are absent
- **THEN** wait reports the oldest eligible completion with the complete stored Agent final message regardless of `wake_on_progress`

#### Scenario: Ordinary caller omits timeout
- **WHEN** the parent performs an ordinary required join without a specific scheduling deadline
- **THEN** it supplies no timeout field and may return before the fixed upper bound on eligible completion or user steer

#### Scenario: Caller supplies timeout to the model-facing tool
- **WHEN** the parent supplies `timeout_ms`
- **THEN** the model-facing boundary rejects that field before changing Agent or delivery state, leaving explicit bounds only to the checkout CLI and runtime
