## Why

HarnessDock's eight-tool MCP discovery catalog is static model-visible context: the measured current serialization is 6,112 characters / 1,358 `o200k_base` tokens, despite the target rollout (`01a04b75-c1f0-7c03-9b8f-6a8407fbe26e`) making zero public HarnessDock MCP calls. The static catalog can therefore be reduced now, but dynamic savings and behavior effects remain unmeasured. The wait-agent metadata also incorrectly forbids every `targets` plus `wake_on_progress` combination although the strict schema permits exactly one target, causing invalid retry guidance.

## What Changes

- Compact only the public MCP tool and field descriptions in `runtime/mcp-server.mjs`, retaining all callable schema fields, strictness, enums, refinements, annotations, tool names, and receipts.
- Add deterministic character-budget coverage for the serialized eight-tool public catalog and description text, with sensitivity checks that reject restored verbose prose.
- Regenerate the checked MCP discovery fixture from the source catalog.
- Correct `wait-agent/agents/openai.yaml` to permit `wake_on_progress` with exactly one target and add a guidance sensitivity check for the former contradictory wording.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `typed-mcp-orchestration`: Preserve the exact eight-tool public contract while bounding static catalog size and making wait guidance agree with the one-target progress schema.

## Impact

- Affected implementation and tests: `runtime/mcp-server.mjs`, `tests/runtime/mcp-server.test.mjs`, `tests/runtime/fixtures/harnessdock-mcp-discovery.json`, `plugins/codex-harnessdock/skills/wait-agent/agents/openai.yaml`, and `tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs`.
- No API generation, runtime operation, service, configuration, dependency, install, release, route-tuple, receipt, or lifecycle behavior changes.
- Non-goals: output-field deletion; `list_harnesses` projection changes; wait-receipt, pagination, compression, or shorthand protocol changes; API generation bump; inter-thread reporting; commit, push, or archive.
