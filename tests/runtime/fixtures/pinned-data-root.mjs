/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pin every test process's durable data root to a disposable per-run directory.
 *
 * ## Why
 *
 * `resolvePluginDataRoot()` falls back to the real operator namespace
 * (`<codex home>/plugins/data/codex-harnessdock`) whenever no runtime home is
 * injected. Any test that builds a runtime, store, lease, or job without
 * setting `CODEX_HARNESSDOCK_RUNTIME_HOME` therefore writes into the same
 * namespace production will use. That is not hypothetical: a sweep of that
 * namespace found 2,316 accumulated state roots, created by ordinary
 * `npm run check` runs since the Phase A suites landed, and dozens more per
 * run today.
 *
 * The fallback itself is correct for production -- an operator's runtime must
 * resolve its own home without being told. What is wrong is that a test run
 * inherits it by default. So this preload states the home once, for the whole
 * run, before any test file is loaded.
 *
 * ## How it holds
 *
 * The test runner loads this with `--import`, so it runs before any test
 * module. Setting the variable on `process.env` here means every test file the
 * runner spawns, every worker thread those files create, and every detached
 * child they launch inherits it, because that is how environment inheritance
 * works -- there is no per-suite discipline to remember.
 *
 * A suite that wants its own home still sets one; this only supplies the
 * default that was previously the operator's real namespace.
 *
 * `tests/runtime/durable-state-isolation.test.mjs` is the loud half: it fails
 * the run if any process ever resolves a data root inside the real namespace.
 * This module is only the mechanism.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VARIABLE = "CODEX_HARNESSDOCK_RUNTIME_HOME";

if (!process.env[VARIABLE]?.trim()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-test-data-"));
  process.env[VARIABLE] = root;
  // Managed Harness services deliberately keep ownership receipts below the
  // stable Plugin data root instead of the disposable per-worker runtime home.
  // Pin CODEX_HOME as well so tests cannot observe or write the operator's
  // production receipt/lease namespace.
  process.env.CODEX_HOME = path.join(root, "codex-home");
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  // Only the process that created the directory removes it. A spawned test file
  // inherits the variable but not this branch, so it never deletes a root its
  // siblings are still using.
  process.on("exit", () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // A best-effort cleanup never fails a run that already passed.
    }
  });
}
