## Context

See `proposal.md` and `specs/opencode-explorer-runtime/spec.md`. The installed binary is OpenCode 1.18.23, while the checked reference source and SDK are 1.18.18; implementation must pin and revalidate the installed 1.18.23 behavior. `discover-native-harness-routes` remains the exact provider/model/variant baseline. This successor changes only interaction admission, preserves the omitted Agent selector, and does not select or change a route.

## Goals / Non-Goals

**Goals:**

- Establish the highest supported permission surface before each session while guaranteeing no interactive wait.
- Bind managed-child policy generation to a nonsecret receipt, preserve attached-service ownership, and fail closed only when the requested environment cannot be established.
- Recheck health, provider, config, and agent at every decision-bearing seam and make the final `GET /agent` the immediate predecessor of `POST /session`.

**Non-Goals:**

- No user/global/project configuration mutation, Server restart/replacement for policy installation, permission/question broker, auto-answer, prompt tool map, Agent selector, model call, or generic policy-universe/no-`ask` proof.
- No provider/model/variant substitution, Pi/Claude change, dependency, install, release, or archive.

## Decisions

### 1. Use the maximum session policy, with only zero-wait denials

Managed children receive the exact child-local environment `OPENCODE_PERMISSION='{"*":"allow","doom_loop":"allow"}'`. `POST /session` sends exact ordered rules: wildcard `allow`, followed by `question: deny`, `plan_exit: deny`, `task: deny`, and `doom_loop: allow`. The wildcard maximizes ordinary permissions; the three terminal denials remove unattended interaction and delegation/escape surfaces, while the explicit `doom_loop` allow overrides the native Agent exception. No arbitrary generic `ask` rule is added.

Session wildcard rules override ordinary Agent-specific rules, but `doom_loop` is Agent-scoped. Therefore final `GET /config` plus `GET /agent` resolves the default Agent and requires terminal `doom_loop:*:allow`; an absent, malformed, ambiguous, or non-allow terminal witness produces sanitized `interactive_policy` and zero `POST /session`.

Alternative rejected: inherit a restrictive native default or add broad generic no-ask rules. Either makes permission policy the safety boundary and is stricter than the user-selected maximum-permission contract.

### 2. Keep managed and attached ownership distinct

The managed Service fingerprint/receipt includes a nonsecret digest of the policy generation and the child-local environment identity; it must not disclose arbitrary environment values. A managed child may be ensured with that environment. An attached Server is never mutated, restarted, or replaced to install it. It may run only when the final native health/provider/config/agent witness proves the exceptional policy can satisfy the same zero-wait session contract.

Alternative rejected: repair attached configuration or silently fall back. Both change operator-owned state or conceal an admission failure.

### 3. Revalidate all native witnesses at lifecycle seams

At list, after managed-Service ensure, and immediately before session creation, perform bounded health, provider, config, and agent observations. Preserve exact provider/model/variant identity and exclude GitLab `duo-workflow-*` models because their separate unoverrideable `ask` cannot be made zero-wait. The final `GET /agent` is immediately followed by `POST /session`; any witness drift reports only `interactive_policy`, releases local claim/lease state through the established pre-transport path, and issues zero session/model POSTs.

There is no atomic config/session primitive. The claim excludes hostile mutation after that final `GET`; it does not claim to eliminate that residual Server-side race.

Alternative rejected: list-time cache or post-ensure-only validation. Both leave a material configuration or service drift window before native mutation.

### 4. Pin behavior to the installed OpenCode version

Compatibility acceptance must identify `/root/.opencode/bin/opencode` as 1.18.23 and revalidate the endpoints and permission precedence used here. Reference source HEAD `e23586af...` and this repository's SDK 1.18.18 are explanatory evidence only, not runtime identity or compatibility proof.

## Risks / Trade-offs

- [A native witness cannot establish the requested policy] -> Expose sanitized `interactive_policy`, no route/session POST, and do not mutate an attached Server.
- [Version behavior drifts] -> Fail closed on failed 1.18.23 compatibility revalidation; do not infer behavior from the 1.18.18 source/SDK.
- [Hostile mutation after the final GET] -> State the non-atomic boundary; no claimed protection exists without a native atomic primitive.

## Migration Plan

1. Preserve `discover-native-harness-routes` as the exact-route predecessor; do not alter route tuple or Agent-selector omission.
2. Freeze zero-model fake-Server tests for ordered session rules, managed-child receipt binding, denied interaction surfaces, `doom_loop` terminal matching, `duo-workflow-*` exclusion, and list/post-ensure/final-witness drift.
3. Implement bounded native witnesses and session policy without configuration/service mutation; run focused tests, strict OpenSpec validation, and `npm run check`.
4. Before activation, independently revalidate installed OpenCode 1.18.23 compatibility. Any live check remains zero-model and must not restart, replace, or mutate an attached Server.
5. Roll back by checkout/plugin version; no OpenCode configuration migration exists.
