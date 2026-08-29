## 1. Freeze exact-route failures

- [ ] 1.1 Confirm `discover-native-harness-routes` has been synchronized or archived onto the implementation base; add focused RED cases in `tests/runtime/harness-driver-contract.test.mjs`, `tests/runtime/pi-driver.test.mjs`, and `tests/runtime/opencode-driver.test.mjs` for missing, empty, duplicated, orphaned, or cross-model `effortsByModel` entries and for an omitted internal canonical effort. Each case must fail before listing, durable mutation, session creation, or native work.
- [ ] 1.2 Add a stable public-admission sensitivity case in `tests/runtime/mcp-server.test.mjs` and `tests/runtime/agent-launch-boundary.test.mjs` proving an exact advertised tuple succeeds while a stale model, stale effort, alias, or effort-null tuple cannot reach an Agent write or Driver transport.

## 2. Enforce one shared inspected route shape

- [ ] 2.1 Tighten `runtime/harness-contract.mjs` `validateInstanceInspection()` to snapshot and validate one bounded `models` plus `effortsByModel` projection with exact key equality, non-empty model-specific effort arrays, duplicate rejection, and byte-preserving atoms; do not union, normalize, or cache native values.
- [ ] 2.2 Make `validateCanonicalRoute()` require the caller-stated bounded effort and compare the full tuple against the validated fresh inspection. Keep the Driver as a narrowing validator only; it must not supply or transform model or effort.
- [ ] 2.3 Update the existing Pi and OpenCode inspection/route producers in `runtime/pi-driver.mjs` and `runtime/opencode-driver.mjs` only as needed to satisfy the shared contract, then preserve their existing pre-transport fresh-equality gates and prompt/receipt-only authority behavior.
- [ ] 2.4 Preserve durable compatibility in `runtime/agent-store.mjs`, `runtime/agent-runtime.mjs`, and `runtime/internal-runtime.mjs`: historical records with an explicit effort may revalidate; a record without one stays readable but cannot activate or acquire an invented route.

## 3. Keep model-facing guidance inventory-neutral

- [ ] 3.1 Remove mutable current model/effort roster text from the eight checkout-owned `plugins/codex-harnessdock/skills/*/SKILL.md` files and their `agents/openai.yaml` metadata where present. Keep only mandatory-field, fresh-`list_harnesses`, topology, authority, and fail-closed procedure guidance.
- [ ] 3.2 Correct Pi/OpenCode `write` language in public descriptions, Skills, and receipts so it names observed behavioral prompt/receipt authority without claiming native tool filtering, sandboxing, permission switching, or configuration containment.
- [ ] 3.3 Extend `tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs`, `tests/runtime/plugin-contract.test.mjs`, and `tests/runtime/release-smoke.test.mjs` with a fake-catalog mutation that changes listing/admission while checked-in guidance bytes stay unchanged; assert no native turn starts and no configuration identities leak.

## 4. Deterministic acceptance

- [ ] 4.1 Demonstrate sensitivity by restoring an omitted-effort acceptance or a stale/merged catalog path and observing the corresponding focused contract/admission test fail, then restore the candidate implementation.
- [ ] 4.2 Run `npm run test:focus -- tests/runtime/harness-driver-contract.test.mjs tests/runtime/pi-driver.test.mjs tests/runtime/opencode-driver.test.mjs tests/runtime/mcp-server.test.mjs tests/runtime/agent-launch-boundary.test.mjs tests/runtime/harnessdock-skill-guidance-neutrality.test.mjs tests/runtime/plugin-contract.test.mjs tests/runtime/release-smoke.test.mjs` and record the passing deterministic receipt.
- [ ] 4.3 Run `npm run check` and `openspec validate enforce-exact-discovered-routes --strict`; do not install, release, archive, refresh, or run a provider/model turn.
