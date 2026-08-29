# Native Harness Differential Parity

Status: `fail`; promotion eligible: `false`.

| Harness | Dimension | Result | Evidence |
| --- | --- | --- | --- |
| claude-code | exact_model_effort_inventory | hold | claude-differential-receipt.json#hold |
| claude-code | argv_environment_or_request_transport | pass | claude-differential-receipt.json#provenRows/baseline_argv_environment |
| claude-code | native_configuration_inheritance | pass | claude-differential-receipt.json#provenRows/benign_config_inheritance_witness |
| claude-code | prompt_authority_delta | pass | claude-differential-receipt.json#provenRows/task_native_input, claude-differential-receipt.json#provenRows/closed_harnessdock_policy_delta, claude-differential-receipt.json#provenRows/write_authority_delta |
| claude-code | event_tool_order | pass | claude-differential-receipt.json#provenRows/ordered_stream_tool_events |
| claude-code | interrupt | pass | claude-differential-receipt.json#provenRows/interrupt_behavior |
| claude-code | exact_session_continuation | hold | claude-differential-receipt.json#unprovenRows/exact_resume_same_session_fresh_process_mechanics |
| claude-code | cross_process_turn_observation_or_reconciliation | not_applicable | claude-differential-receipt.json#notApplicable/oldTurnObservation |
| claude-code | automatic_recovery_exact_session_transport | hold | claude-differential-receipt.json#unprovenRows/exact_session_transport_recovery_without_duplicate_input |
| claude-code | terminal_classification | pass | claude-differential-receipt.json#provenRows/terminal_classification |
| claude-code | route_drift | pass | claude-differential-receipt.json#provenRows/route_drift |
| claude-code | native_usage_provenance | pass | claude-differential-receipt.json#provenRows/provider_native_usage_source_fields |
| claude-code | process_lifecycle | pass | claude-differential-receipt.json#provenRows/process_lifecycle_cleanup |
| pi | exact_model_effort_inventory | pass | pi-native-differential-receipt.json#provenRows/exact_model_per_model_effort_inventory |
| pi | argv_environment_or_request_transport | pass | pi-native-differential-receipt.json#provenRows/argv_environment |
| pi | native_configuration_inheritance | pass | pi-native-differential-receipt.json#provenRows/configuration_inheritance_witness |
| pi | prompt_authority_delta | pass | pi-native-differential-receipt.json#provenRows/prompt_authority_native_input |
| pi | event_tool_order | pass | pi-native-differential-receipt.json#provenRows/ordered_events |
| pi | interrupt | pass | pi-native-differential-receipt.json#provenRows/interrupt_request_behavior |
| pi | exact_session_continuation | pass | pi-native-differential-receipt.json#provenRows/exact_session_continuation |
| pi | cross_process_turn_observation_or_reconciliation | not_applicable | pi-native-differential-receipt.json#notApplicableRows/cross_process_turn_observation_or_reconciliation |
| pi | automatic_recovery_exact_session_transport | not_applicable | pi-native-differential-receipt.json#notApplicableRows/automatic_recovery_exact_session_transport |
| pi | terminal_classification | pass | pi-native-differential-receipt.json#provenRows/terminal_classification |
| pi | route_drift | pass | pi-native-differential-receipt.json#provenRows/route_drift |
| pi | native_usage_provenance | pass | pi-native-differential-receipt.json#provenRows/native_usage_source_fields |
| pi | process_lifecycle | pass | pi-native-differential-receipt.json#provenRows/lifecycle_process_cleanup |
| opencode | exact_model_effort_inventory | pass | opencode-native-differential-parity.receipt.json#provenRows/exact_model_effort_inventory |
| opencode | argv_environment_or_request_transport | pass | opencode-native-differential-parity.receipt.json#provenRows/request_transport_environment |
| opencode | native_configuration_inheritance | fail | opencode-native-differential-parity.receipt.json#unprovenRows/native_configuration_inheritance |
| opencode | prompt_authority_delta | pass | opencode-native-differential-parity.receipt.json#provenRows/driver_authority_non_prompt_invariance |
| opencode | event_tool_order | pass | opencode-native-differential-parity.receipt.json#provenRows/ordered_request_event_tool_observations |
| opencode | interrupt | not_applicable | opencode-native-differential-parity.receipt.json#notApplicableRows/interrupt |
| opencode | exact_session_continuation | not_applicable | opencode-native-differential-parity.receipt.json#notApplicableRows/exact_session_continuation |
| opencode | cross_process_turn_observation_or_reconciliation | not_applicable | opencode-native-differential-parity.receipt.json#notApplicableRows/cross_process_turn_observation_or_reconciliation |
| opencode | automatic_recovery_exact_session_transport | not_applicable | opencode-native-differential-parity.receipt.json#notApplicableRows/automatic_recovery_exact_session_transport |
| opencode | terminal_classification | pass | opencode-native-differential-parity.receipt.json#provenRows/terminal_classification |
| opencode | route_drift | pass | opencode-native-differential-parity.receipt.json#provenRows/route_drift |
| opencode | native_usage_provenance | pass | opencode-native-differential-parity.receipt.json#provenRows/provider_native_usage_source_fields |
| opencode | process_lifecycle | fail | opencode-native-differential-parity.receipt.json#provenRows/turn_session_cleanup, opencode-native-differential-parity.receipt.json#unprovenRows/managed_service_process_lifecycle |

## Blockers

- claude-code/exact_model_effort_inventory: hold — zero-prompt native controls do not establish the exact selectable full model and effort catalog
- claude-code/exact_session_continuation: hold — the fake protocol exposes no provider-native persistent turn key; a distinct child PID is not native turn identity
- claude-code/automatic_recovery_exact_session_transport: hold — same session and non-duplicated input lack a provider-defined accepted-turn or recovery binding
- opencode/native_configuration_inheritance: fail — not_observed_by_fake_transport
- opencode/process_lifecycle: fail — test_owned_server_only
