# HarnessDock activation runbook (Task 11.3, accepted 2026-08-17)

> **Accepted version.** Every acceptance placeholder is filled from measured
> evidence. Two fields are deliberately recorded by the operator at execution
> time and are marked as such; they are instructions, not gaps.

This runbook is executed by an operator, in order, after the candidate review
(11.1) and disposition (11.2) are complete. Every step below is one of the
actions Task 11.4 deliberately leaves outside the change: production promotion,
identity/data cutover, install/refresh, Codex restart, live model calls, and the
physical rename. Nothing here runs automatically, and nothing here is part of
`npm run check`.

Background this runbook links rather than restates: the multi-Harness plan of
record is [`docs/handoffs/2026-08-13-multi-harness-implementation.md`](handoffs/2026-08-13-multi-harness-implementation.md);
the operator-owned OpenCode Server, its Basic-auth allowlist, the reviewed
profile, and the roadmap are in the [README](../README.md).

Each step states its **verification** and its **abort/rollback** note. If a
verification fails, stop at that step; do not proceed to the next one.

---

## 1. Pre-cutover cleanup of test-created state roots

Test runs before the Task 9 isolation fix wrote empty state roots into the real
plugin data namespace. They are inert, but they should not be carried across a
cutover.

```bash
# Count them. They are DIRECTORIES that contain no files, which is why a
# `find -type f` sweep reports nothing and they went unnoticed.
find /data/CoordExp/.codex/plugins/data/codex-harnessdock/state \
  -mindepth 1 -maxdepth 1 -type d \
  -exec sh -c 'test -z "$(find "$1" -type f -print -quit)"' _ {} \; -print | wc -l
```

The command above reported **2,373** empty roots at acceptance time.
**Operator: re-run the count immediately before executing and record the number
here at execution.** Delete only roots that contain **no files**; a root holding
any file is examined in step 4 before the namespace move, not deleted here.

```bash
find /data/CoordExp/.codex/plugins/data/codex-harnessdock/state \
  -mindepth 1 -maxdepth 1 -type d \
  -exec sh -c 'test -z "$(find "$1" -type f -print -quit)"' _ {} \; -exec rm -rf {} +
```

**Verification.** Re-run the count command; it reports `0`. Then run
`npm run check` in the checkout and re-run the count: it still reports `0`. Since
Task 9 the test runner pins its data root to a per-run temporary directory and
`tests/runtime/durable-state-isolation.test.mjs` fails loudly if anything
resolves the operator namespace, so no new roots appear.

**Abort/rollback.** This step deletes only empty directories and is not
reversible, which is acceptable because an empty directory carries no state. If
the count command reports roots that *do* contain files, stop: that is unexpected
and means real Agent state is present.

---

## 2. Record the candidate freeze facts

These facts were measured in the development worktree that produced the
candidate; step 3's verification compares the production checkout against them.

```bash
git -C /data/CoordExp/codex-harnessdock-dev rev-parse HEAD HEAD^{tree}
git -C /data/CoordExp/codex-harnessdock-dev status --porcelain   # must be empty
```

| Fact | Value |
| --- | --- |
| Candidate commit | `e1a7f5f878d6d48310059bc97c6ebba64094c9b2` |
| Candidate tree digest | git tree `9dc49511cd38cb22068f5d818fc232f66be01ee5` (637 git-visible paths, 6,116,535 file bytes) |
| Runtime suite | 1519/1519 pass, data-root delta 0 |
| Integration suite | 20/20 pass |
| OpenSpec strict (change) | `add-opencode-explorer-driver` valid |
| OpenSpec strict (all) | 25 passed, 0 failed |
| Probed OpenCode Server / client / model / profile | Server `1.18.18` on the literal loopback origin; pinned `@opencode-ai/sdk@1.18.18` (lockfile integrity held); exact `opencode-go/deepseek-v4-flash` confirmed on both the CLI catalog and the Server surface; `codex-explorer` resolved live (mode `primary`, 91 merged rules, readiness `ready`/`liveValidated` with zero blockers) |
| Continuation mode | `fresh_only` |
| Recorded unknown states | no authoritative Server session/incarnation evidence (hence `fresh_only`); turn restart observation unavailable; unknown settlement retains its leases and no operator force-clear exists; live reliability, provider cache behavior, and economics unmeasured until the Task 10.5 maturity work |

Commits after the candidate commit are acceptance bookkeeping only (OpenSpec
ledger, this runbook, the handoff checkpoint); they change no runtime, test, or
Skill content.

**Verification.** The working tree is clean and the recorded commit is the one
reviewed in 11.1 and dispositioned/rechecked in 11.2.

**Abort/rollback.** Nothing has changed yet; abort by stopping.

---

## 3. Promote the accepted candidate into the loaded source

`/data/CoordExp/cc-plugin-codex` is the only Git/source owner and the path the
installed bootstrap delegates to. Promotion moves the accepted candidate there.

```bash
npm run promote:local
```

**Verification.** `git -C /data/CoordExp/cc-plugin-codex rev-parse HEAD` equals
the candidate commit from step 2, and the working tree is clean.

**Abort/rollback.** Promotion is a Git operation on the loaded-source checkout;
roll back by checking out the previous commit there. Respect the
stored-canonical-writer rule: the workspace root recorded in durable state is the
authority, so do not promote into an alias path or a different worktree — a
release under a differently-spelled root would not address the same durable
state.

---

## 4. Identity and data cutover

The deferred Phase 0 tasks: the durable namespace still carries the pre-rename
identity.

The live data namespace is `cc`; `codex-harnessdock` currently holds only
test-era residue (production has never written it — the loaded Plugin still
uses the `cc` namespace). The move target must not exist when the atomic rename
runs, so the residue namespace is inspected and retired first.

```bash
# 1. Back up BOTH namespaces first. `cc` is the live data being moved and is
#    the one artifact in this runbook that is not reconstructible; the residue
#    namespace is kept for forensic completeness.
tar -czf ~/harnessdock-data-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz \
  -C /data/CoordExp/.codex/plugins/data cc codex-harnessdock

# 2. Inspect what step 1's cleanup left in the residue namespace. Expect only
#    file-bearing caches (e.g. Claude CLI compatibility config.json roots)
#    written by pre-isolation test runs. If ANY agent, job, mailbox, or lease
#    record is present, STOP — that would be real state nobody expected here.
grep -rl '"agent"\|"job"\|"mailbox"\|"lease"' \
  /data/CoordExp/.codex/plugins/data/codex-harnessdock/ && echo "STOP" || true

# 3. Retire the residue namespace (it is inside the backup), then perform the
#    single atomic rename.
rm -rf /data/CoordExp/.codex/plugins/data/codex-harnessdock
mv /data/CoordExp/.codex/plugins/data/cc \
   /data/CoordExp/.codex/plugins/data/codex-harnessdock

# 4. Record the cutover timestamp alongside the backup.
date -u +%Y-%m-%dT%H:%M:%SZ
```

Cutover timestamp: **operator records the step-4 output here at execution.**

Then remove the old-name discovery entry so no stale identity is discoverable.
Concurrent legacy `cc_for_pein` discovery is already rejected by release smoke,
which is the check that proves this step landed.

**Verification.** The new namespace exists, the old name does not, and
`npm run doctor` reports the fixed environment healthy.

**Abort/rollback.** Restore the backup tarball over the data root and reverse the
rename. Do this only while no Agent is active — see step 8.

---

## 5. Install or refresh the Plugin, then restart Codex

Pick exactly one, by what changed:

| Situation | Command | Why |
| --- | --- | --- |
| First install on this machine | `npm run install:local` | Creates the enabled record and the initial snapshot. |
| Same generation, discovery content changed | `npm run refresh:local` | Refreshes the snapshot without a version bump. |
| Release or MCP API generation change | `npm run release:local` | Bumps the cachebuster first, then refreshes; required whenever the generation changes. |

This activation **is** a generation change: the public surface moves to nine
tools at MCP API generation 10. Use `npm run release:local`.

Then restart Codex and start a **new Codex task**. An older MCP process fails
closed with `HARNESSDOCK_MCP_RESTART_REQUIRED` before any operation, by design;
a new task is the only way to pick up the new generation.

**Verification.** `npm run doctor` passes, including the nine-tool contract.

**Abort/rollback.** Re-run the install command for the previous version; the
bounded compatibility shells retain the two previous versions.

---

## 6. Installed smoke (the deferred Task 9.3 execution)

```bash
npm run smoke:release -- --json
```

This is the zero-model smoke executing `probeInstalledMcp` against the loaded
snapshot. It verifies exactly nine Skills and nine MCP tools, isolated
`list_agents` and `list_harnesses` calls through the production isolated path,
that the typed schema **rejects** an argument it does not declare, and the
retained compatibility shells and predecessor coverage. Harness readiness is
reported, never required: an operator whose OpenCode Server is stopped still
passes this step.

**Verification.** `status: "pass"`, `zeroModelCost: true`,
`paid: {requested: false, status: "skipped"}`, nine skills, nine tools,
`schemaRejected: true`.

**Abort/rollback.** A stale-snapshot failure is repaired by returning to step 5.
This step starts no model turn, so there is nothing to undo.

---

## 7. The three authorized live Explorer examples

This is the only step in this runbook that spends model usage, and the only step
that requires the operator's explicit live flag.

Prerequisites: the operator's OpenCode Server is running on its loopback origin
with the reviewed `codex-explorer` profile; the evaluation workspace is a
disposable or approved repository and is **clean**; a fresh artifact root exists.

```bash
node scripts/evaluate-opencode-explorer.mjs \
  --authorize-live-opencode-evaluation \
  --workspace <disposable-or-approved-repo> \
  --artifact-root <fresh-artifact-root>
```

Without that exact flag the script refuses before observing readiness, opening a
witness, or creating an artifact root. It announces the exact Harness, model,
Agent names, workspace, and artifact root before the first model request, opens
the workspace mutation witness around each example, and stops the whole run on a
mutated workspace, a wrong route, an ambiguous or empty result, or
auth/account/quota evidence. It never falls back to Claude, another OpenCode
model, a provider API, or a CLI attach.

Three read-only examples run in order: a fresh architecture Explorer; a
continuation example that takes the `fresh_only` substitute branch for this
route; and a mixed-root example.

Then populate `docs/opencode-worker-evaluation.md` (Task 10.4) with the measured
facts, the telemetry that was unavailable, the twelve requested architecture
answers, and one bounded `GO`, `GO WITH CHANGES`, or `NO-GO`. Do not fill unknown
cache, economics, or reliability numbers with inference — record them as
unavailable.

**Verification.** The artifact root holds `evaluation.json` with
`status: "completed"`, three examples, `automaticFallback: "none"`, and a clean
workspace witness whose verdict states `enforcement: "harness_policy"` and
`osContainment: false`.

**Abort/rollback.** A stopped run is evidence, not a failure to hide: keep the
artifact and record the stop condition in the evaluation document. Model usage
already spent is not recoverable. The read-only route mutates no repository, so
there is nothing in the workspace to roll back.

---

## 8. Rollback path, and what is deliberately not rolled back

Rollback is bounded and is **never performed across active or unknown work**.

Before rolling anything back:

```bash
node runtime/operator-cli.mjs list-agents --all --json
```

If any Agent is `starting` or `working`, or any version-three job record is
`unknown`, **stop**. An unknown record means a turn whose outcome nobody can
prove, and its instance lease is deliberately retained; rolling back across it
would discard the only evidence of a turn that may have run.

When no active or unknown work exists:

1. Reinstall the previous version (step 5's rollback note).
2. Restore the data backup and reverse the namespace rename (step 4's note).
3. Restart Codex and start a new task.

**Deliberately not rolled back:** durable Agent records, completion events, and
usage receipts for turns that already settled — they are evidence of work that
really happened. Live model usage already spent. The evaluation artifact root.
The server-side session record created by a live example, which stays where it
is rather than being deleted by a second live mutation.

---

## 9. Phase R prerequisites (physical rename)

Phase R is the mechanical rename of the remaining `cc-`/`CC` identifiers to
HarnessDock names. Per the roadmap it runs **after** this activation completes
and **before** a third Harness is admitted, so exactly one generation carries
both the rename and a two-Harness surface.

Prerequisites, all of which this runbook produces:

- this activation is complete and its evaluation document records a bounded
  verdict;
- no Agent is active and no version-three job record is `unknown`;
- the identity/data cutover in step 4 has landed, so the durable namespace
  already carries the current identity and the rename is source-only;
- the data backup from step 4 is retained.

Phase R is a separate authorized change with its own OpenSpec. It is not part of
this runbook beyond recording that these prerequisites hold.
