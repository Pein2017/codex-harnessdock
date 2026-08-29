## ADDED Requirements

### Requirement: Every ready route publishes exact per-model effort choices
Every ready Harness instance SHALL publish a non-empty model set and a non-empty exact effort set for every advertised model. The Driver contract SHALL reject an inspection with a missing, empty, foreign, duplicated, or orphaned per-model effort entry instead of treating effort facts as an opaque Driver convention.

#### Scenario: Ready inspection omits one model's efforts
- **WHEN** a Driver advertises a ready instance and one advertised model has no exact effort set
- **THEN** the inspection is rejected before route listing, Agent mutation, native session creation, or provider work

#### Scenario: Native effort names differ across models
- **WHEN** fresh native discovery reports different exact effort strings for two models
- **THEN** `list_harnesses` preserves each model-specific set without unioning, aliasing, normalizing, or inventing a common default

### Requirement: Every canonical route carries caller-stated effort
Every newly accepted canonical route SHALL contain an exact non-empty caller-stated effort that was freshly advertised for its exact model. Spawn and every internal admission path SHALL reject a missing effort before durable mutation; follow-up, recovery, and observation SHALL inherit the frozen accepted effort and SHALL NOT infer or replace it.

#### Scenario: Non-MCP caller omits effort
- **WHEN** an internal, recovery, operator, or future public caller attempts to mint a route without effort
- **THEN** canonical validation rejects the route before it becomes durable or reaches native transport

#### Scenario: Follow-up resumes an accepted Agent
- **WHEN** a follow-up is admitted for an Agent with a complete persisted route
- **THEN** it reuses the exact persisted model and effort after fresh equality validation without accepting a caller override
