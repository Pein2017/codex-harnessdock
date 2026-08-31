## MODIFIED Requirements

### Requirement: Jobs publish only bounded safe progress activity
Each active version-three Agent job SHALL maintain an optional monotonic public-progress revision containing only a closed shared activity vocabulary, phase, sanitized summary, and timestamp. Every admitted Harness Driver SHALL project only meaningful native lifecycle, tool, or message milestones through this bounded sink; the supervisor SHALL coalesce duplicate or routine activity and SHALL NOT manufacture progress from elapsed time. The public projection SHALL NOT contain model response or thinking text, tool inputs, file paths, hook payloads, session IDs, native event IDs, partial output, raw receipts, or transcript content. Only a fixed trusted allowlist of native tool names SHALL be model-visible; every other native tool name SHALL become a generic tool milestone.

#### Scenario: A Driver reports a native tool milestone
- **WHEN** an admitted Harness Driver reports a native tool-use event through its progress sink
- **THEN** the job publishes at most a bounded milestone containing an allowlisted native tool name and no tool arguments, paths, native event payload, or transcript content

#### Scenario: Native tool name is unknown or path-shaped
- **WHEN** a Driver reports an MCP, unknown, malformed, encoded, or path-shaped tool name
- **THEN** public progress says only that the Agent is using a tool and contains no substring from that name

#### Scenario: Native text or thinking deltas arrive
- **WHEN** Pi, OpenCode, or a future Harness emits repeated text, thinking, or other raw stream deltas
- **THEN** the Driver and supervisor discard them from public progress and may coalesce only a generic bounded activity milestone

#### Scenario: Native activity is unchanged
- **WHEN** a Driver repeats the same nonterminal native activity without a meaningful closed-vocabulary, phase, or sanitized-summary revision
- **THEN** the job does not advance its public-progress revision

### Requirement: wait_agent delivers later meaningful progress as advisory root activity
`wait_agent` SHALL return at most one atomically claimed oldest pending current-root Agent public-progress revision only when the caller explicitly sets `wake_on_progress: true` and no eligible completion has priority. A revision is pending only when it is newer than that job's persisted advisory delivery revision. The update SHALL identify the Agent, progress revision, activity kind, phase, bounded summary, and timestamp, and SHALL atomically advance the persisted monotonic advisory delivery revision without changing Agent lifecycle state. A wait that omits or disables `wake_on_progress` SHALL neither return nor claim progress. Later meaningful public-progress revisions of the same active job remain eligible to later explicit progress waits; repeated quiet observations, duplicate native events, and private hook activity SHALL NOT become model-facing progress. Hook activity SHALL remain private runtime evidence and SHALL NOT be eligible for model-facing progress delivery.

#### Scenario: Progress arrives during an explicit progress wait
- **WHEN** a current-root Agent job publishes a meaningful eligible non-hook public-progress revision before timeout, the caller set `wake_on_progress: true`, and no eligible completion is unread
- **THEN** wait atomically claims and returns that bounded progress update

#### Scenario: A later meaningful revision arrives after delivery
- **WHEN** an earlier revision of an active current-root job was delivered and that job later publishes a meaningful revision with a larger public-progress revision
- **THEN** a later `wake_on_progress: true` wait may atomically claim and return the newer revision

#### Scenario: Ordinary completion wait observes pending progress
- **WHEN** a current-root Agent has pending public progress and the caller omits or disables `wake_on_progress`
- **THEN** wait continues toward completion or timeout without returning the progress or advancing its delivered revision

#### Scenario: Hook activity is current
- **WHEN** an active job's latest private progress activity is `hook`
- **THEN** an opt-in progress wait neither returns nor claims that hook activity and continues toward another job's eligible progress, completion, or timeout

#### Scenario: Routine native progress remains noisy
- **WHEN** an Agent continues publishing duplicate, coalesced, hook, thinking, response, or tool events without a newer meaningful public-progress revision
- **THEN** no opt-in wait receives a synthetic update and it continues toward later meaningful progress, completion, or timeout

#### Scenario: A follow-up starts a new Agent job
- **WHEN** the same durable Agent starts a follow-up turn under a new active job
- **THEN** the new job has its own public-progress and advisory-delivery revisions without resetting or rewriting the completed prior job

#### Scenario: A new turn starts after progress wait begins
- **WHEN** a current-root Agent turn is created after a root-wide `wake_on_progress: true` wait has blocked and then publishes eligible non-hook progress
- **THEN** the same wait refreshes current active turns and may return that new job's bounded progress update before timeout

#### Scenario: The latest revision was already delivered
- **WHEN** an opt-in progress wait runs while every current-root active job has no public-progress revision newer than its persisted delivered revision
- **THEN** no progress is returned or claimed and the wait remains completion-first

#### Scenario: Two progress waits race on one revision
- **WHEN** two current-root opt-in progress waits concurrently observe the same job's eligible progress revision
- **THEN** at most one claims that revision and the persisted delivered revision never regresses

#### Scenario: Two progress waits race across two pending Agents
- **WHEN** two current-root opt-in progress waits first observe the same oldest job while another Agent job has an eligible public-progress revision
- **THEN** a waiter that loses the oldest claim reselects and may atomically claim the other job instead of falsely timing out

#### Scenario: Another root publishes progress
- **WHEN** a job owned by a different Codex root publishes a progress revision
- **THEN** the current root's wait does not observe or advance it
