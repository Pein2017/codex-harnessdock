## Context

See [proposal.md](proposal.md) for the measured static discovery baseline and the absence of public MCP calls in the target rollout. `runtime/mcp-server.mjs` owns the public definitions; the existing discovery fixture is a checked projection of that source. `runtime/index.mjs` remains the sole lifecycle interface, so catalog wording must not create a second state, persistence, recovery, or process owner.

## Goals / Non-Goals

**Goals:**
- Reduce static discovery context by changing only tool and field description strings.
- Freeze deterministic, tokenizer-free size checks that catch regression.
- Make wait-agent metadata describe the schema's existing one-target progress case correctly.

**Non-Goals:**
- No change to `runtime/mcp-api.mjs`, tool generation, schemas, outputs, runtime invocation, persistent state, recovery, route selection, services, configuration, installation, release, or process lifecycle.
- No compression protocol, shorthand DSL, pagination, list-harnesses projection change, or dynamic-token/performance claim.

## Decisions

### Keep semantics local, shorten duplication

Edit only public `description` strings in `runtime/mcp-server.mjs`. Each shortened field string retains its local decision-bearing fact: required/exact route selection, topology, behavioral write authority, exact target identity, absolute target worktree, one-target progress rule, and completion acknowledgement. Retain detailed procedural explanation in the existing owning Skills rather than adding indirection or a shared catalog abstraction.

Alternative considered: remove field descriptions or move all meaning to Skills. Rejected because discovery must remain self-contained enough to prevent invalid calls and because the frozen contract forbids output or semantic deletion.

### Use two character budgets from the public discovery object

In `tests/runtime/mcp-server.test.mjs`, measure `JSON.stringify(listed.tools).length` for the actual in-memory discovery array and recursively sum its `description` values. The limits are 4,500 serialized characters and 800 description characters. Against the supplied 6,112-character baseline, the first limit requires at least a 26% static-catalog reduction, exceeding the 15% material-reduction floor; the description limit reduces the supplied 1,136-character description baseline by at least 29%.

Use characters rather than a tokenizer dependency because the guard must be deterministic in the repository. The already installed offline tokenizer is reporting-only evidence after implementation, not an acceptance dependency. Keep the exact-eight-tools and spawn-schema assertions, including `target_worktree`, beside the budgets.

Alternative considered: a token budget only. Rejected because tokenizer versions and host serialization can drift and the implementation needs a stable local regression guard.

### Make sensitivity checks explicit

The catalog test will prove the size guard has teeth by adding/restoring representative prior verbose descriptions to an otherwise discovered catalog and asserting the relevant budget fails. The skill-guidance test will reject the exact former contradiction (`Never combine targets with wake_on_progress`) while asserting the corrected exactly-one-target wording. The discovery fixture will be regenerated from the source catalog, not manually compressed or curated.

Alternative considered: green-only maximum assertions. Rejected because they would not demonstrate that a future re-expansion is detected.

### Preserve process and receipt boundaries

This change runs before the existing MCP registration loop and changes no input validation or tool handler. The MCP process continues to construct definitions at startup and delegates accepted operations to `runtime/index.mjs`; it gains no persistence, recovery, mailbox, session, or receipt role. A running process may retain its already-loaded wording until normal rediscovery/restart, but callable behavior and the API generation remain unchanged.

## Risks / Trade-offs

- [Over-compression hides an operational constraint] → Keep each decision-bearing fact attached to its tool or field and retain schema/Skill invariants.
- [Serializer measurement diverges from discovery] → Measure the actual `client.listTools()` payload and regenerate the checked fixture from that source.
- [A wording-only change is misreported as runtime savings] → State that dynamic MCP savings are unmeasured because the target rollout made zero public calls.
- [Metadata again contradicts validation] → Assert both the valid one-target case and invalid multi-target case in the guidance test.

## Migration Plan

No protocol migration is required. Implement and verify the source, fixture, and focused tests together; a subsequently discovered or normally restarted MCP server presents the compact wording with the same generation and callable surface. Rollback is restoring the prior descriptions and metadata, with no state conversion or recovery action.
