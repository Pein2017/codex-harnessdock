# GPT-5.6 Cross-Harness Routing Diary

## Frozen purpose and claim boundary

This append-only diary records naturalistic end-to-end behavior of real Agent
routes in the current local environment. It asks which route is a useful prior
for a similar future task class; it does not isolate a causal Harness effect,
rank models globally, establish provider billing, remove a supported Harness or
model, or gate either B-prime OpenSpec change.

The evaluated route includes the current native Codex/Pi/OpenCode client,
installed configuration, prompts, tools, plugins/MCP, service lifecycle, model,
effort, and HarnessDock transport when used. A later configuration or version
is a new population.

## Observational question

> For real tasks completed in the current checkout and client configuration,
> what end-to-end strengths, failure modes, lead burden, latency, and reported
> usage are observed for each task class and explicit GPT-5.6 route?

Cross-task differences are descriptive. They are never interpreted as the
effect of changing only Harness, model, or effort.

## Population, allocation, and stopping rule

- Seek nine valid observations covering each available
  `native Codex | HarnessDock Pi | HarnessDock OpenCode` by
  `GPT-5.6 Luna | Terra | Sol` cell once when real work supplies a suitable
  task. Twelve real attempts is the hard ceiling.
- Distribute `low`, `medium`, `high`, `xhigh`, and `max` by task shape across
  the portfolio; do not force every effort into every cell.
- Route for task fit first. An uncovered cell is only a tie-breaker between
  otherwise reasonable routes.
- Every observation must be independently useful work with its ordinary owner
  and verifier. Do not duplicate, replay, weaken, or invent work to fill a cell.
- A route is selected only from fresh current availability. Discovery admits a
  route; it does not rank or choose it.
- Stop at nine valid observations, twelve real attempts, or exhaustion of the
  authorized real work, whichever occurs first. Report sparse coverage rather
  than extend the budget.

## Validity and evidence levels

One observation is one bounded Agent assignment on one exact route. It is
valid task-performance evidence only when it has:

1. a stable real-task/artifact identity and declared task class;
2. exact full model, effort, execution plane, write authority, and current
   client/checkout identity;
3. sanitized fresh admission evidence;
4. an ownership-safe terminal disposition;
5. independently inspectable acceptance evidence and lead disposition; and
6. end-to-end wall time.

Admission, authentication, service, transport, or unresolved-ownership failures
consume the twelve-attempt ceiling and remain operational Harness evidence, but
do not become model-quality observations. Provider usage may be unavailable;
absence remains unknown. `reported_cost_usd` is provider-reported metadata, not
an invoice or subscription charge.

When a receipt separates cache reads, `usage.input_tokens` records fresh/
non-cache input rather than duplicating `cache_read_tokens`.

## Evaluation dimensions

No scalar score or global winner is produced. Each accepted observation records
these dimensions separately:

- **Acceptance:** first-pass, accepted after one correction, rejected/escalated,
  surface failure, or unresolved.
- **Lead burden:** intervention/correction count and whether the Agent falsely
  claimed completion.
- **Instruction discipline:** task boundary, write surface, stop rule, and
  avoidance of unnecessary abstraction.
- **Evidence quality:** source trace, counterexamples, verifier use, and claim
  calibration.
- **Operational integrity:** discovery, submission, settlement, recovery, and
  completion/usage receipt behavior.
- **Latency:** discovery/launch/settlement stage timings when available and total
  wall time.
- **Usage:** exact available provider/local counters with provenance; missing
  fields stay unavailable.

Synthesis is by task class with the observed confounds stated. A ceiling-effect
task, unmatched verifier, unavailable route, or technical-invalid run is
explicitly non-ranking.

## Append-only receipt schema

Append one fenced YAML record under `## Receipts` for every real attempt. Use
exact identifiers only when they are safe for this repository; never include a
credential, prompt body, private native/session/Agent ID, raw final answer, or
absolute private runtime-state path.

```yaml
observation_id: unique diary-local id
recorded_at_utc: ISO-8601
task:
  identity: stable task/package/artifact id
  class: investigation | docs | implementation | repair | review | other
  novelty: new | continuation | correction
  verifier_strength: deterministic | inspected | judgmental
environment:
  checkout_commit: git commit
  execution_plane: native_codex | harnessdock_pi | harnessdock_opencode
  client_version: exact version | unavailable
  harnessdock_version: exact version | not_applicable | unavailable
route:
  exact_model: full native model id
  effort: low | medium | high | xhigh | max
  topology: leaf | native_depth2_l1 | native_depth2_l2 | not_applicable
  write: true | false
admission:
  evidence: sanitized fresh discovery/call handle
  outcome: admitted | unavailable | auth_failure | plugin_failure |
           runtime_failure | rejected
execution:
  submission: accepted | rejected | uncertain | not_attempted
  terminal: completed | failed | interrupted | unresolved
  discovery_ms: nonnegative integer | unavailable
  launch_ms: nonnegative integer | unavailable
  settle_ms: nonnegative integer | unavailable
  end_to_end_ms: nonnegative integer
  automatic_retries: nonnegative integer
acceptance:
  receipt: sanitized command/result or artifact digest
  lead_disposition: accepted_first_pass | accepted_after_correction |
                    rejected_or_escalated | surface_failure | unresolved
  lead_corrections: nonnegative integer
  false_completion_claim: true | false | unknown
subjective:
  first_pass_usefulness: strong | adequate | weak | not_assessed
  instruction_discipline: strong | adequate | weak | not_assessed
  evidence_quality: strong | adequate | weak | not_assessed
  overdesign: absent | minor | material | not_assessed
  harness_friction: none | minor | material | not_assessed
usage:
  provenance: provider_reported | locally_measured | unavailable
  input_tokens: nonnegative integer | unavailable
  cache_read_tokens: nonnegative integer | unavailable
  cache_write_tokens: nonnegative integer | unavailable
  output_tokens: nonnegative integer | unavailable
  reasoning_tokens: nonnegative integer | unavailable
  reported_cost_usd: nonnegative number | unavailable
incident: none | sanitized operational category
limitations: concise confounds and missing evidence
task_class_prior_note: bounded implication for similar future work
```

An attempt counts toward the nine valid observations only when admission is
`admitted`, terminal ownership is safe, and lead disposition is one of the two
accepted values or `rejected_or_escalated` under a real verifier. Operational
failures and `unresolved` consume the twelve-attempt ceiling but do not support
model-quality comparisons.

## Native depth-2 documentation pilot receipt

```yaml
package_id: harnessdock-bprime-docs-20260830
task_class: documentation and contract design
lead_disposition: accepted_after_correction
effective_depth: 2
depth_2_predicate:
  materialized_outputs: 2
  output_a: Change A complete OpenSpec artifacts
  output_b: Change B complete OpenSpec artifacts
routes:
  l1: gpt-5.6-terra/high
  l2_a: gpt-5.6-luna/medium
  l2_b: gpt-5.6-terra/medium
accepted_outcome: two strictly valid changes plus routing diary after one L0 semantic correction bundle
verifier:
  change_a: openspec validate harden-agent-spawn-recovery-and-accounting --strict
  change_b: openspec validate add-stateless-batch-agent-dispatch --strict
l0_raw_l2_transcript_reads: 0
l0_direct_package_code_edits: 0
l0_document_correction_bundles: 1
l1_correction_rounds: 1
semantic_escalations: none
role_or_write_surface_drift: none
critical_path_wall_ms: 416184
usage_coverage: complete locally measured native receipts for L1 and both L2 workers
observed_benefit: L0 received one compressed package packet and never read raw L2 transcripts.
observed_overhead_or_failure: Strict validators and L1 integration missed semantic-owner gaps, wrong batch input identity, and speculative accounting scope; L0 performed a material docs-only correction.
recommendation: revise
recommendation_note: Retain depth-2 for multi-output packages, but require an L1 semantic-owner/baseline checklist; no context, cost, latency, or model-superiority claim without matched depth-1 evidence.
```

## Receipts

```yaml
observation_id: 20260830-native-luna-medium-change-a-docs
recorded_at_utc: 2026-08-30T15:35:23Z
task:
  identity: openspec-change-harden-agent-spawn-recovery-and-accounting-draft
  class: docs
  novelty: new
  verifier_strength: inspected
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-luna
  effort: medium
  topology: native_depth2_l2
  write: true
admission:
  evidence: native child path /root/draft_bprime_docs/draft_change_a
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 184165
  automatic_retries: 0
acceptance:
  receipt: final strict OpenSpec validation plus L0 semantic-owner inspection
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: false
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: strong
  evidence_quality: adequate
  overdesign: material
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 85238
  cache_read_tokens: 603392
  cache_write_tokens: 0
  output_tokens: 6431
  reasoning_tokens: 720
  reported_cost_usd: unavailable
incident: none
limitations: Strict validation passed, but L0 replaced speculative durable usage persistence and added the actual Agent/thread/job semantic owners.
task_class_prior_note: Luna-medium produced a usable scaffold quickly, but this contract-heavy task needed substantial lead semantic correction.
```

```yaml
observation_id: 20260830-native-terra-medium-change-b-docs
recorded_at_utc: 2026-08-30T15:35:17Z
task:
  identity: openspec-change-add-stateless-batch-agent-dispatch-draft
  class: docs
  novelty: new
  verifier_strength: inspected
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-terra
  effort: medium
  topology: native_depth2_l2
  write: true
admission:
  evidence: native child path /root/draft_bprime_docs/draft_change_b
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 167023
  automatic_retries: 0
acceptance:
  receipt: final strict OpenSpec validation plus L0 input-shape and owner inspection
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: false
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: adequate
  evidence_quality: adequate
  overdesign: minor
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 72171
  cache_read_tokens: 431872
  cache_write_tokens: 0
  output_tokens: 8752
  reasoning_tokens: 587
  reported_cost_usd: unavailable
incident: none
limitations: The scaffold used agent_name as input and omitted release-smoke and ledger integration owners; L0 corrected all three.
task_class_prior_note: Terra-medium was fast and structurally coherent, but public API ownership still required lead review.
```

```yaml
observation_id: 20260830-native-terra-high-depth2-docs-integration
recorded_at_utc: 2026-08-30T15:37:53Z
task:
  identity: harnessdock-bprime-docs-20260830
  class: docs
  novelty: new
  verifier_strength: inspected
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-terra
  effort: high
  topology: native_depth2_l1
  write: true
admission:
  evidence: native child path /root/draft_bprime_docs
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 416184
  automatic_retries: 0
acceptance:
  receipt: effective_depth 2 packet, final strict validations, and one L0 correction bundle
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: false
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: strong
  evidence_quality: adequate
  overdesign: material
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 75680
  cache_read_tokens: 1052416
  cache_write_tokens: 0
  output_tokens: 9336
  reasoning_tokens: 2852
  reported_cost_usd: unavailable
incident: none
limitations: L1 correctly integrated two independent outputs and strict validators, but did not catch omitted spec owners, the wrong batch input name, or speculative accounting scope.
task_class_prior_note: Terra-high effectively compressed depth-2 work, but strict validation did not substitute for lead semantic-owner inspection.
```

```yaml
observation_id: 20260830-pi-sol-high-docs-adviser
recorded_at_utc: 2026-08-30T15:39:01Z
task:
  identity: bprime-docs-owner-and-diary-advisory
  class: review
  novelty: new
  verifier_strength: inspected
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: harnessdock_pi
  client_version: unavailable
  harnessdock_version: 0.25.4+codex.20260830104618
route:
  exact_model: openai-codex/gpt-5.6-sol
  effort: high
  topology: leaf
  write: false
admission:
  evidence: fresh HarnessDock Pi route and public Agent /root/pi_sol_docs_adviser
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 442984
  automatic_retries: 0
acceptance:
  receipt: completed HarnessDock receipt plus L0 source verification of blocking owner findings
  lead_disposition: accepted_first_pass
  lead_corrections: 0
  false_completion_claim: false
subjective:
  first_pass_usefulness: strong
  instruction_discipline: strong
  evidence_quality: strong
  overdesign: minor
  harness_friction: none
usage:
  provenance: provider_reported
  input_tokens: 149875
  cache_read_tokens: 2520576
  cache_write_tokens: 0
  output_tokens: 18701
  reasoning_tokens: unavailable
  reported_cost_usd: unavailable
incident: none
limitations: Unlike the native writers, this was a read-only advisory task; it found decisive owner and baseline gaps but did not test implementation ability.
task_class_prior_note: Pi/Sol-high was valuable for broad source/spec ownership review and caught issues missed by the native depth-2 drafting package.
```

```yaml
observation_id: 20260830-pi-luna-low-change-a-failure-map
recorded_at_utc: 2026-08-30T16:19:41Z
task:
  identity: change-a-pre-edit-failure-propagation-map
  class: investigation
  novelty: new
  verifier_strength: inspected
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: harnessdock_pi
  client_version: unavailable
  harnessdock_version: 0.25.4+codex.20260830104618
route:
  exact_model: openai-codex/gpt-5.6-luna
  effort: low
  topology: leaf
  write: false
admission:
  evidence: fresh HarnessDock Pi discovery and public Agent /root/pi_luna_change_a_failure_map
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 60431
  automatic_retries: 0
acceptance:
  receipt: completed HarnessDock receipt plus L0 source verification of the v3 launch and worker serialization gaps
  lead_disposition: accepted_first_pass
  lead_corrections: 0
  false_completion_claim: false
subjective:
  first_pass_usefulness: strong
  instruction_discipline: strong
  evidence_quality: strong
  overdesign: absent
  harness_friction: none
usage:
  provenance: provider_reported
  input_tokens: 63279
  cache_read_tokens: 263168
  cache_write_tokens: 0
  output_tokens: 2467
  reasoning_tokens: unavailable
  reported_cost_usd: unavailable
incident: none
limitations: Read-only pre-change analysis; its suggested public handoffDisposition field conflicted with the accepted OpenSpec outcome vocabulary and was not adopted.
task_class_prior_note: Pi/Luna-low was fast and source-specific for a bounded failure-chain map, but the lead still had to enforce the already-frozen public contract.
```

## Native depth-2 Change A implementation pilot receipt

```yaml
package_id: harnessdock-change-a-implementation-20260830
task_class: implementation of cancellation recovery, MCP projection, and route accounting
lead_disposition: accepted_after_correction
effective_depth: 2
depth_2_predicate:
  materialized_outputs: 2
  output_a: recovery runtime, MCP projection, redaction, and focused regression tests
  output_b: current-route operator ledger parser and production-shaped fixtures
routes:
  l1: gpt-5.6-terra/high
  l2_a: gpt-5.6-luna/max
  l2_b: gpt-5.6-terra/xhigh
accepted_outcome: Change A implementation, generation 9, 15 of 15 tasks complete, strict-valid, focused green, and final npm check green
verifier:
  focused: 45 pass, 0 fail
  full: npm run check exit 0 on final lead replay
  sensitivity: new recovery and ledger tests fail against source commit e2d2589
l0_raw_l2_transcript_reads: 0
l0_direct_package_code_edits: 1
l0_direct_edit: removed one unused abort signal option after source inspection
l1_correction_rounds: 1
semantic_escalations: none
role_or_write_surface_drift: none
critical_path_wall_ms: 2272568
usage_coverage: complete locally measured native receipts for L1 and both L2 workers
observed_benefit: Two independent semantic surfaces completed in parallel and L0 received one integrated packet with RED and verifier handles.
observed_overhead_or_failure: The recovery L2 consumed a very large cached context and emitted a large answer; L0 also encountered one unrelated high-contention job-store flake before the final full check passed.
recommendation: retain
recommendation_note: Retain depth 2 for similarly independent lifecycle and accounting surfaces, but route narrower recovery tickets when possible; no savings or model-superiority claim without matched depth 1.
```

```yaml
observation_id: 20260830-native-luna-max-change-a-recovery
recorded_at_utc: 2026-08-30T16:50:56Z
task:
  identity: change-a-recovery-cancellation-and-mcp-projection
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-luna
  effort: max
  topology: native_depth2_l2
  write: true
admission:
  evidence: native child path /root/implement_change_a/recovery
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 1853523
  automatic_retries: 0
acceptance:
  receipt: pre-change sensitivity RED, final recovery and MCP tests green, and L0 source inspection
  lead_disposition: accepted_after_correction
  lead_corrections: 2
  false_completion_claim: false
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: strong
  evidence_quality: strong
  overdesign: minor
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 467304
  cache_read_tokens: 47345152
  cache_write_tokens: 0
  output_tokens: 77731
  reasoning_tokens: 44682
  reported_cost_usd: unavailable
incident: none
limitations: L1 tightened public code projection and L0 removed one unused signal option; the task was broader and far more cache-heavy than the ledger package.
task_class_prior_note: Native Luna-max completed a difficult multi-boundary lifecycle fix with strong tests, but its latency and token footprint argue for narrower tickets before treating max as a default.
```

```yaml
observation_id: 20260830-native-terra-xhigh-change-a-ledger
recorded_at_utc: 2026-08-30T16:24:45Z
task:
  identity: change-a-current-route-operator-ledger
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-terra
  effort: xhigh
  topology: native_depth2_l2
  write: true
admission:
  evidence: native child path /root/implement_change_a/ledger
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 270896
  automatic_retries: 0
acceptance:
  receipt: production-shaped pre-change RED plus final operator ledger tests and privacy inspection
  lead_disposition: accepted_first_pass
  lead_corrections: 0
  false_completion_claim: false
subjective:
  first_pass_usefulness: strong
  instruction_discipline: strong
  evidence_quality: strong
  overdesign: absent
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 133160
  cache_read_tokens: 1592320
  cache_write_tokens: 0
  output_tokens: 11388
  reasoning_tokens: 5573
  reported_cost_usd: unavailable
incident: none
limitations: This was a narrow parser and fixture task with a strong deterministic oracle; it is not comparable to the recovery lifecycle package.
task_class_prior_note: Native Terra-xhigh was fast and precise for a bounded contract parser with an exact verifier; no inference extends to broader lifecycle work.
```

```yaml
observation_id: 20260830-native-terra-high-change-a-integration
recorded_at_utc: 2026-08-30T16:57:17Z
task:
  identity: harnessdock-change-a-implementation-20260830
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: native_codex
  client_version: 0.151.0
  harnessdock_version: not_applicable
route:
  exact_model: gpt-5.6-terra
  effort: high
  topology: native_depth2_l1
  write: true
admission:
  evidence: native child path /root/implement_change_a
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 2272568
  automatic_retries: 0
acceptance:
  receipt: effective-depth-2 packet, L0 code inspection, sensitivity RED, strict OpenSpec, and final npm run check exit 0
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: false
subjective:
  first_pass_usefulness: strong
  instruction_discipline: strong
  evidence_quality: strong
  overdesign: minor
  harness_friction: none
usage:
  provenance: locally_measured
  input_tokens: 131256
  cache_read_tokens: 2208768
  cache_write_tokens: 0
  output_tokens: 11617
  reasoning_tokens: 4034
  reported_cost_usd: unavailable
incident: unrelated_job_store_high_contention_flake
limitations: L0's first full-suite replay lost one of 600 unrelated contention messages; the isolated test passed three of three and the final full check passed.
task_class_prior_note: Native Terra-high integrated two independent implementations with low lead burden; the evidence supports this task-class prior only, not a global route ranking.
```

```yaml
observation_id: 20260830-opencode-terra-max-batch-public-surface-admission-failure
recorded_at_utc: 2026-08-30T17:12:56Z
task:
  identity: change-b-ninth-public-tool-and-release-contract
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: harnessdock_opencode
  client_version: 1.18.25
  harnessdock_version: 0.25.4+codex.20260830104618
route:
  exact_model: openai/gpt-5.6-terra
  effort: max
  topology: leaf
  write: true
admission:
  evidence: fresh HarnessDock discovery reported service_unreachable and spawn rejected before Agent creation
  outcome: unavailable
execution:
  submission: not_attempted
  terminal: failed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 200
  automatic_retries: 0
acceptance:
  receipt: no Agent created and no package file changed
  lead_disposition: surface_failure
  lead_corrections: 0
  false_completion_claim: unknown
subjective:
  first_pass_usefulness: not_assessed
  instruction_discipline: not_assessed
  evidence_quality: not_assessed
  overdesign: not_assessed
  harness_friction: material
usage:
  provenance: unavailable
  input_tokens: unavailable
  cache_read_tokens: unavailable
  cache_write_tokens: unavailable
  output_tokens: unavailable
  reasoning_tokens: unavailable
  reported_cost_usd: unavailable
incident: opencode_service_unreachable
limitations: No model turn began. A subsequent zero-model managed ensure started OpenCode 1.18.25, but the installed Driver pins 1.18.23 and projected the version mismatch as interactive_policy; this is operational Harness evidence only.
task_class_prior_note: None for model quality; current OpenCode admission must be repaired or republished before comparative implementation evidence is possible.
```

```yaml
observation_id: 20260830-pi-terra-max-batch-public-surface-settlement-unknown
recorded_at_utc: 2026-08-30T17:41:25Z
task:
  identity: change-b-ninth-public-tool-and-release-contract
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: e2d25898a87e3194e17c3bc5fb8a6ed28aaad40a
  execution_plane: harnessdock_pi
  client_version: unavailable
  harnessdock_version: 0.25.4+codex.20260830104618
route:
  exact_model: openai-codex/gpt-5.6-terra
  effort: max
  topology: leaf
  write: true
admission:
  evidence: fresh ready Pi discovery and public Agent /root/pi_terra_batch_public_surface
  outcome: admitted
execution:
  submission: accepted
  terminal: unresolved
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 1646079
  automatic_retries: 0
acceptance:
  receipt: public-surface files landed and were later integrated after one lead correction bundle
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: unknown
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: adequate
  evidence_quality: adequate
  overdesign: minor
  harness_friction: material
usage:
  provenance: unavailable
  input_tokens: unavailable
  cache_read_tokens: unavailable
  cache_write_tokens: unavailable
  output_tokens: unavailable
  reasoning_tokens: unavailable
  reported_cost_usd: unavailable
incident: settlement_unknown
limitations: Durable native acceptance was proven but the version-three job ended unknown and retained its writer lease. HEAD also moved to the independent OpenCode 1.18.25 fix during the turn. The artifact is useful, but this attempt is not valid model-quality evidence.
task_class_prior_note: None for model quality; Pi/Terra-max produced a substantial candidate but failed the ownership-safe terminal criterion.
```

```yaml
observation_id: 20260831-opencode-terra-max-batch-acceptance-timeout
recorded_at_utc: 2026-08-31T01:26:06Z
task:
  identity: change-b-performance-and-failure-matrix
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: 74a20a03b79f306e3c67c43100f058427ac1acb2
  execution_plane: harnessdock_opencode
  client_version: 1.18.25
  harnessdock_version: 0.25.5+codex.20260831011238
route:
  exact_model: openai/gpt-5.6-terra
  effort: max
  topology: leaf
  write: true
admission:
  evidence: fresh ready OpenCode discovery and native acceptance-proven launch claim
  outcome: admitted
execution:
  submission: accepted
  terminal: unresolved
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 300556
  automatic_retries: 0
acceptance:
  receipt: no package file was produced before the fixed turn ceiling expired
  lead_disposition: unresolved
  lead_corrections: 0
  false_completion_claim: unknown
subjective:
  first_pass_usefulness: not_assessed
  instruction_discipline: not_assessed
  evidence_quality: not_assessed
  overdesign: not_assessed
  harness_friction: material
usage:
  provenance: unavailable
  input_tokens: unavailable
  cache_read_tokens: unavailable
  cache_write_tokens: unavailable
  output_tokens: unavailable
  reasoning_tokens: unavailable
  reported_cost_usd: unavailable
incident: driver_result_rejected
limitations: OpenCode created a native session and accepted Terra-max, then its Driver result rejected after about five minutes and retained unknown ownership. HarnessDock already sets a one-hour turn ceiling, so this timing is not evidence that its configured deadline fired. No artifact, provider usage receipt, or finer failure class supports model evaluation.
task_class_prior_note: None for quality; the current OpenCode/provider result path needs finer failure evidence before this Terra-max outcome can inform routing.
```

```yaml
observation_id: 20260831-opencode-luna-low-batch-gap-tests
recorded_at_utc: 2026-08-31T01:32:34Z
task:
  identity: change-b-cross-root-discovery-and-lost-response-tests
  class: implementation
  novelty: new
  verifier_strength: deterministic
environment:
  checkout_commit: 74a20a03b79f306e3c67c43100f058427ac1acb2
  execution_plane: harnessdock_opencode
  client_version: 1.18.25
  harnessdock_version: 0.25.5+codex.20260831011238
route:
  exact_model: openai/gpt-5.6-luna
  effort: low
  topology: leaf
  write: true
admission:
  evidence: fresh ready OpenCode discovery and public Agent /root/opencode_luna_batch_gap_tests
  outcome: admitted
execution:
  submission: accepted
  terminal: completed
  discovery_ms: unavailable
  launch_ms: unavailable
  settle_ms: unavailable
  end_to_end_ms: 125197
  automatic_retries: 0
acceptance:
  receipt: isolated test file merged into the existing suite, corrected once, then 10 batch tests and ESLint passed
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  false_completion_claim: false
subjective:
  first_pass_usefulness: adequate
  instruction_discipline: strong
  evidence_quality: weak
  overdesign: absent
  harness_friction: minor
usage:
  provenance: provider_reported
  input_tokens: 1795
  cache_read_tokens: 59904
  cache_write_tokens: 0
  output_tokens: 100
  reasoning_tokens: 58
  reported_cost_usd: 0
incident: none
limitations: The isolated worktree lacked dependencies, so the Agent could not run its tests; the first file omitted one fixture field, used invalid provenance, and modeled lost response with the wrong runtime outcome. L0 corrected those in one bundle before acceptance. Reported zero cost is provider metadata under subscription, not an invoice.
task_class_prior_note: OpenCode/Luna-low completed a tightly bounded one-file task well within the transport ceiling and obeyed its write surface, but semantic tests still required lead correction.
```

## Post-hoc native terminal amendments

These append-only amendments preserve what HarnessDock knew at first
settlement while recording later exact native evidence. Current synthesis uses
the amended values; the original operational incidents remain evidence that
terminal reconciliation failed.

```yaml
amendment_id: 20260831-pi-terra-max-native-stop-recovered
amends_observation_id: 20260830-pi-terra-max-batch-public-surface-settlement-unknown
evidence:
  source: exact HarnessDock-owned Pi session JSONL
  terminal_assistant_at_utc: 2026-08-30T17:41:23.824Z
  stop_reason: stop
  process_state_at_recovery: no Pi RPC process remained
corrected:
  execution_terminal: completed
  acceptance_receipt: public-surface candidate integrated after one lead correction bundle
  lead_disposition: accepted_after_correction
  usage:
    provenance: provider_reported
    input_tokens: 315463
    cache_read_tokens: 15723520
    cache_write_tokens: 0
    output_tokens: 63696
    reasoning_tokens: 37654
    reported_cost_usd: unavailable
incident: harnessdock_terminal_reconciliation_missed_native_stop
limitations: Pi reached native stop, but HarnessDock recorded driver_result_rejected two seconds later and retained the writer lease. Session cost fields are not treated as an invoice.
```

```yaml
amendment_id: 20260831-opencode-terra-max-native-stop-recovered
amends_observation_id: 20260831-opencode-terra-max-batch-acceptance-timeout
evidence:
  source: exact OpenCode session and message rows in the native SQLite store
  terminal_assistant_at_utc: 2026-08-31T01:40:08Z
  finish_reason: stop
  artifact: tests/runtime/batch-dispatch-acceptance.test.mjs
corrected:
  execution_terminal: completed
  end_to_end_ms: 1143000
  acceptance_receipt: 679-line production-shaped acceptance suite corrected once, merged, and 7 of 7 tests plus ESLint passed
  lead_disposition: accepted_after_correction
  lead_corrections: 1
  usage:
    provenance: provider_reported
    input_tokens: 205241
    cache_read_tokens: 4933120
    cache_write_tokens: 0
    output_tokens: 14318
    reasoning_tokens: 37696
    reported_cost_usd: 0
incident: harnessdock_terminal_reconciliation_missed_native_stop
limitations: HarnessDock recorded driver_result_rejected around five minutes, while the same exact native session continued for about fourteen more minutes, wrote the artifact, and reached stop. Reported zero cost is subscription metadata, not an invoice.
```
