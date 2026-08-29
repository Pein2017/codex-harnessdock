## Context

See [proposal.md](proposal.md) for motivation. The current runtime uses one `cwd`/`workspaceRoot` value for three different responsibilities: trusted Codex control ownership, durable state lookup, and native Harness execution. New public Agents already use the version-three identity plane, but Claude turns still execute through the version-one supervisor while Pi and OpenCode use the version-three worker. The latter currently binds exactly one instance or native-session lease into a launch claim; the writer-lease engine exists but is not part of public turn admission. The design therefore has to separate roots without creating another lifecycle owner and has to correct writer admission in both execution lifecycles.

The trusted control root remains the canonicalized Codex `_meta` sandbox workspace. It is the only owner of the root-thread registry, mailbox, jobs, completion inbox, waits, logs, control stream, and detached-worker reconstruction. The execution root is an immutable per-Agent fact used only for native working-directory selection and workspace-writer identity.

## Goals / Non-Goals

**Goals:**

- Introduce one bounded target-worktree admission seam shared by initial spawn and pre-transport revalidation.
- Persist one immutable execution root on every newly created Agent while keeping all durable control ownership under the trusted control root.
- Make Claude, Pi, and OpenCode native directory selection consume the same validated execution-root fact.
- Require a complete admission bundle—one instance or native-session lease, plus an execution-root writer lease for write authority—before native submission in both supported lifecycles.
- Preserve exact existing settlement, unknown-retention, rollback, redaction, and public-receipt behavior.

**Non-Goals:**

- No generic cwd selector, branch selector, worktree manager, permission broker, target repair, target fallback, or Agent retargeting.
- No new dependency, Driver, state store, lifecycle owner, public receipt field, or paid/live Harness test.
- No conversion or eager rewrite of existing workspace-only records.

## Decisions

### 1. Keep `cwd` as the control-root owner and add one Agent `executionRoot`

The runtime factory and internal runtime keep their existing canonical `cwd`; its meaning becomes explicitly `controlRoot`. The registry's workspace identity and each existing Agent `workspaceRoot` continue to name that control root. Newly created Agent records add one closed, immutable `executionRoot` field. Spawn omission writes the canonical control root into that field; an admitted target writes the target's canonical registered worktree path. Because an explicit current-root target is rejected, `executionRoot !== workspaceRoot` is sufficient to identify a targeted Agent without another boolean.

All new activation, job, worker-snapshot, launch-claim, and terminal records carry control and execution roots separately where they need both. State resolvers always receive the control root. Driver scopes and writer leases always receive the execution root. Agent update validation treats `executionRoot` like the immutable route.

On read, `executionRoot ?? workspaceRoot` is the only compatibility interpretation. Reads, lists, and reconciliation do not persist that derived value. An ordinary later write may serialize it only while preserving the same canonical path. This keeps compatibility localized rather than adding a migration pass.

Alternative considered: move the Agent registry and jobs into the target worktree's state bucket. Rejected because follow-up, waits, completion, and root-thread ownership would split across worktrees and make the target a second control root.

Alternative considered: replace `workspaceRoot` everywhere with two renamed fields in one broad refactor. Rejected because the existing field is already the registry owner and a localized additive field is smaller and safer.

### 2. Admit targets through one checkout-owned Git worktree validator

Add one small runtime module that accepts `{controlRoot, targetWorktree}` and returns canonical `{controlRoot, executionRoot}` or a closed sanitized error code. It uses Node filesystem/path primitives and the host `git` executable already required by this checkout; no library or shell evaluation is added.

Admission order is fixed:

1. require an absolute, NUL-free target string;
2. canonicalize the existing control and target directories;
3. reject canonical equality with the control root;
4. read the control repository's registered worktrees from `git -c core.quotePath=false worktree list --porcelain`, accepting only raw absolute, control-free `worktree ` values and never decoding Git quoting;
5. require one exact canonical target entry with no `prunable` marker;
6. resolve both roots' absolute canonical Git common directories and require equality;
7. repeat the path/registration/common-directory comparison before returning so conflicting observations fail as owner drift.

The validator never checks remote similarity or commit equality because neither proves linked-worktree ownership. It never runs a mutating Git command. Spawn performs this admission before `acceptStatedRoute`, so an invalid target causes no Driver inspection, readiness work, Agent reservation, or durable mutation. MCP Zod validation performs only the cheap absolute-path syntax check; the runtime remains the semantic authority.

Alternative considered: accept any Git checkout with the same remote or history. Rejected because an independent clone has separate worktree ownership and must not share control or writer identity.

Alternative considered: infer the target from the task prompt. Rejected because prompt text is not an authority boundary and cannot support durable revalidation.

### 3. Revalidate only explicit targets at the final pre-transport seam

The same validator is called again after detached reconstruction and Harness readiness/preflight, immediately before the submission-start fence and `Driver.startTurn()`. The call supplies the stored control and execution roots and requires the validator to reproduce the exact execution root. This position avoids a long readiness interval between validation and native session creation or prompt submission.

For the version-three launch core, drift is a Driver pre-transport rejection: the claim remains `not_submitted`/rejected and the existing fenced rollback path applies. For the version-one Claude supervisor, drift fails the prepared job before `startTurn()` and runs the same pre-submission admission rollback described below. Neither path retries in the control root or asks the Harness to approve an external directory.

No extra revalidation flag is stored: a differing immutable execution root proves the spawn was targeted. Omitted-target Agents continue to use the already trusted control root and existing lifecycle checks.

Alternative considered: revalidate only once at spawn. Rejected because a registered worktree can disappear, become prunable, or be replaced before a detached worker reaches native transport.

### 4. Pass execution root to Drivers and nowhere else

`createDriverScope()` continues exposing a field named `workspaceRoot`, but callers populate it from `agent.executionRoot ?? agent.workspaceRoot`. Driver code therefore needs no second directory concept:

- Claude receives the execution root as native `cwd`/workspace root;
- Pi starts its RPC process with the execution root as `cwd`;
- OpenCode discovery/turn clients use the execution root as `directory`, including session creation and prompt submission.

Detached Node workers still start in the control root and reopen stores from it. Driver scopes do not receive the control-root path. The fixed environment and service manager remain owned by the canonical runtime checkout, not by files under the execution root.

Alternative considered: change the detached worker's process cwd to the target. Rejected because many state owners derive their bucket from `cwd`; doing so would silently move registry, job, and completion ownership.

### 5. Represent turn admission as one complete lease bundle

For every turn, derive an exact ordered lease intent:

- one instance lease for a fresh native turn, or one native-session lease for exact continuation;
- plus one writer lease keyed by the immutable execution root when `route.authority === "behavioral_write"`.

Read-only turns retain only the first lease. The existing `instance-admission-lease.mjs` engine remains the sole key, holder, capacity, locking, rollback, and settlement owner; `workspace-writer-lease.mjs` remains its thin writer facade.

The version-three launch-claim intent API is generalized from one `expectedLease` to the closed ordered `expectedLeases` set. Acquisition uses the existing branded functions, and one generalized bind operation accepts the complete array of exact in-process acquired objects. Claim validation requires the acquired binding set to equal intent and independently enforces `instance XOR native_session`, plus `writer` exactly when authority is write. Native submission cannot start while the set is intended, partial, duplicated, or authority-incomplete. If acquisition or binding fails, the current rollback fence releases whatever exact intent holders exist; unknown or post-submission paths retain them.

The version-one Claude path uses the same intent builder and lease engine around its existing job lifecycle. It persists the lease intent/bindings on the control-root job before `Driver.startTurn()`: a fresh turn uses instance admission and an exact continuation uses native-session admission, with the writer binding added for write authority. Its existing Claude adapter supplies settlement evidence to the shared `releaseLeasesOnSettlement()` batch. If terminal native and execution settlement are not both proven, all unresolved bindings remain held and the job reports unknown rather than releasing on process exit. Pre-transport failure uses the same exact pre-submission rollback eligibility; it does not create a version-three job or completion owner.

Both lifecycles build release targets from stored binding `keyFields`, including the stored canonical execution-root text. They never realpath the worktree during release, so a removed target does not strand or redirect a legitimate lease. Batch outcome `all`, `partial`, `none`, or `unknown` remains authoritative and no caller converts a partial result into success.

Alternative considered: add a separate target-worktree lock. Rejected because it would duplicate writer ownership and diverge from existing settlement and operator diagnostics.

Alternative considered: acquire the writer lease only for Pi/OpenCode. Rejected because concurrent mutation is a workspace invariant, not a Driver-generation property; the current Claude lifecycle must satisfy it too.

### 6. Carry both roots through durable evidence without publishing paths

New Agent and turn records carry the minimum root facts required by their owner:

- registry/Agent: existing control `workspaceRoot`, plus immutable `executionRoot`;
- version-one and version-three jobs/work snapshots: `controlRoot` and `executionRoot`;
- launch intent/claim: both roots bound into its immutable identity/digest alongside the route and lease bundle;
- writer binding: only canonical `executionRoot` in `keyFields.workspaceRoot`.

Record validators reject root drift between Agent, job, snapshot, claim, and writer binding. Existing records with one stored workspace use it for both meanings in memory. Launch and job readers do not synthesize a target from the current filesystem.

Public projections remain unchanged. The MCP generation changes because the input schema changes, but spawn still returns only `agent_name`, `model`, and `status`; list/follow-up/wait/completion add no path. Model-facing errors use closed categories such as `target_not_registered`, `target_prunable`, or `target_owner_drift`, while exact paths remain in owner-only records and operator diagnostics.

Alternative considered: return the chosen execution root in spawn/list receipts. Rejected because the caller already stated it and public path exposure is unnecessary for orchestration.

### 7. Verify through deterministic fixtures and fake Drivers only

The first checks are sensitivity/RED checks at stable seams:

- target admission rejects relative/current/missing/prunable/unregistered/independent/owner-drifted candidates before a route-inspection spy is called;
- a write launch carrying only its instance/native-session lease is rejected before a Driver submission spy for version-one and version-three lifecycles.

Focused tests then cover schema/generation, immutable Agent persistence and legacy reads, control-root state placement, all three Driver directory mappings, pre-transport revalidation, dual-lease rollback/release/unknown retention, and path-free receipts. A deterministic fake Driver detached-worker smoke creates two temporary linked worktrees in a temporary Git repository, runs from one control root into the other execution root, proves the fake Driver observed that root, proves state stayed under the control bucket, and settles/releases both leases. A second fake result holds unknown settlement and proves both bindings remain. No provider, model, account, persistent Harness service, install, or Plugin refresh is invoked.

## Risks / Trade-offs

- **[Risk] Worktree ownership can drift between Git observations.** → Canonicalize, compare registered inventory and Git common directory twice at admission, then repeat the whole proof immediately before native transport; any disagreement fails closed.
- **[Risk] Splitting one overloaded root can accidentally move durable state.** → Keep runtime `cwd` as control root, add one execution field, and assert Agent/job/claim state directories resolve from control while Driver/writer facts resolve from execution.
- **[Risk] Dual acquisition can fail after one holder exists.** → Persist the complete intent first, bind only exact branded acquisitions, and use the existing fenced rollback to remove any matching pre-submission holders; after submission starts, retain rather than guess.
- **[Risk] Version-one Claude settlement evidence may be weaker than version-three evidence.** → Release only through the shared settlement predicate; insufficient evidence becomes unknown and retains both admission and writer ownership.
- **[Risk] A target may be removed before terminal release.** → Persist the canonical writer key and release by stored key text, never by live realpath.
- **[Risk] Absolute paths may leak through errors or receipts.** → Public projections use closed error codes and unchanged field allowlists; exact evidence remains owner-only.

## Migration Plan

1. Land read-compatible record validators and execution-root projection before writing the new field.
2. Add target admission, schema generation, root propagation, and Driver directory mapping behind the same checkout change.
3. Add complete lease-bundle enforcement for both lifecycle paths before enabling targeted public spawn; there is no state where a write target can launch with only one lease.
4. Run focused tests, the deterministic detached fake-Driver smoke, strict OpenSpec validation, and `npm run check`.
5. A later authorized release may update package/changelog and refresh the Plugin. This planning change performs none of those actions.

Rollback before any targeted Agent is created is an ordinary code rollback. After new records exist, rollback requires a runtime generation that understands `executionRoot`; older MCP generations already fail closed through the restart-required boundary. No migration deletes or rewrites existing records.
