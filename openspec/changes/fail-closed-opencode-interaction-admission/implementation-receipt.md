## Implementation receipt

- Fake-server REDs: missing session permission (61/62 prior to Lane B correction); missing child environment; final witness drift. The terminal-denial and doom-loop sensitivity mutations failed their targeted assertions, then the candidate was restored.
- Correction round: interaction witness failures now project only `interactive_policy`; post-ensure revalidation raises the same closed code; public projection and generic-message tests pass. Task 5.4 remains open pending a green shared final `npm run check`.
- Focused green after correction: 157 tests across client/driver/service, composed, and public-spawn suites, plus the public interaction-policy projection test. Typecheck, owned ESLint, `git diff --check`, and both strict OpenSpec validations passed.
- Lead correction: the full-suite rollback race was reproduced deterministically and fixed in the owning shared lease seam; the original public-spawn file then passed 24/24.
- Final shared `npm run check` passed: lint/typecheck; unit 1,582 tests, 1,581 passed, 1 skipped, 0 failed; integration 20 passed, 0 failed.
- Original acceptance deliberately stopped before live Server, Service,
  configuration, session, prompt, model, install, release, archive, commit, or
  push operations; the bounded post-acceptance correction below records the
  later authorized live probe and release actions.

## Post-acceptance permission correction

- A bounded live 1.18.23 probe reproduced `interactive_policy` for a managed
  child carrying only `OPENCODE_PERMISSION='{"*":"allow"}'`: the native
  `build` Agent appended terminal `doom_loop:*:ask`, which the witness correctly
  rejected.
- The smallest correction is child-local
  `OPENCODE_PERMISSION='{"*":"allow","doom_loop":"allow"}'` plus the same
  terminal `doom_loop:allow` rule in `POST /session`; no attached Server is
  mutated or replaced.
- Focused OpenCode client/Driver/service tests pass 125/125 after the
  correction. A real temporary managed 1.18.23 service then advertised OpenCode
  as ready and completed one cross-worktree turn; Pi completed one adjacent
  cross-worktree turn in the same temporary registered sibling worktree. Both
  target markers were written only under the target root; control root stayed
  unchanged.
