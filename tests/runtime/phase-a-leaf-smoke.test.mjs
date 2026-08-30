/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 8.3: the Phase-A authorized real-Claude leaf smoke, proven at zero
 * model cost.
 *
 * Every test here drives the *production* seam -- the static Driver v2
 * registry, the real `claude-code` Driver, the real job supervisor, the real
 * durable Agent store, launch claim, instance lease, version-three worker
 * loop, and the real completion inbox -- and replaces only the native
 * executable (a fake `claude` on `CODEX_HARNESSDOCK_CLAUDE_BIN`) or, where a native-transport
 * ambiguity cannot be produced by any real child, the Driver's own session
 * seam. No test here may reach a real Claude account.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { runPhaseALeafSmokeCli } from "../../scripts/phase-a-leaf-smoke.mjs";
import {
  PHASE_A_CLEANUP_OUTCOMES,
  PHASE_A_EFFORT,
  PHASE_A_FAILURE_CLASSES,
  PHASE_A_MARKER,
  PHASE_A_MODEL,
  PHASE_A_STATUSES,
  runPhaseALeafSmoke,
} from "../../runtime/phase-a-leaf-smoke.mjs";
import { isProcessAlive } from "../../runtime/process-control.mjs";

const priorRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const roots = [];
const DISCOVERED_ROUTES = {
  models: [PHASE_A_MODEL],
  effortsByModel: { [PHASE_A_MODEL]: [PHASE_A_EFFORT] },
};

after(() => {
  if (priorRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorRuntimeHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * A fake `claude` executable. It answers the exact three host probes the
 * production Driver makes (`--version`, `--help`, `auth status`) and then
 * serves one stream-json turn whose behaviour the `PHASE_A_FAKE_MODE`
 * environment value selects. It never contacts any account.
 */
function writeFakeClaude(filePath) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.PHASE_A_FAKE_MODE || "ok";

function textOf(event) {
  return Array.isArray(event && event.message && event.message.content)
    ? event.message.content.map((part) => (part && part.text) || "").join("\\n")
    : "";
}

async function firstEvent() {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    const data = (chunk) => {
      body += chunk;
      const newline = body.indexOf("\\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(body.slice(0, newline))); } catch (error) { reject(error); }
    };
    const end = () => { cleanup(); reject(new Error("stdin ended before first stream event")); };
    const cleanup = () => { process.stdin.off("data", data); process.stdin.off("end", end); };
    process.stdin.on("data", data);
    process.stdin.on("end", end);
  });
}

async function main() {
  if (args[0] === "--version") return process.stdout.write("2.1.220 (Claude Code)\\n");
  if (args[0] === "--help") return process.stdout.write("-p --output-format --verbose --include-partial-messages --input-format --replay-user-messages --include-hook-events --name --model --effort --session-id --resume --allowedTools --disallowedTools --append-system-prompt --agents --settings --permission-mode --dangerously-skip-permissions stream-json low medium high xhigh max dontAsk bypassPermissions\\n");
  if (args[0] === "auth" && args[1] === "status") {
    if (mode === "logged_out") { process.stderr.write("not logged in\\n"); process.exit(1); }
    return process.stdout.write("authenticated\\n");
  }
  if (args[0] !== "-p") throw new Error("unexpected args " + JSON.stringify(args));
  if (process.env.PHASE_A_FAKE_INVOCATION_FILE) {
    fs.appendFileSync(process.env.PHASE_A_FAKE_INVOCATION_FILE, JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + "\\n");
  }
  const prompt = textOf(await firstEvent());
  const sessionId = "fake-phase-a-session";
  process.stdout.write(JSON.stringify({
    type: "system", subtype: "init", session_id: sessionId,
    claude_code_version: "2.1.220", model: "claude-haiku-4-5",
  }) + "\\n");
  if (mode === "quota") {
    process.stderr.write("Error: You've hit your session limit. Your limit will reset at 8pm.\\n");
    process.exit(1);
  }
  if (mode === "auth_failed") {
    process.stderr.write("Error: unauthorized. Please re-authenticate.\\n");
    process.exit(1);
  }
  if (mode === "mutate") {
    fs.writeFileSync(require("node:path").join(process.cwd(), "forbidden-write.txt"), "mutation\\n");
  }
  if (mode === "mutate_source" && process.env.PHASE_A_FAKE_SOURCE_TARGET) {
    // An already-untracked source file: its bytes change while porcelain
    // status text keeps saying exactly the same thing about it.
    fs.appendFileSync(process.env.PHASE_A_FAKE_SOURCE_TARGET, "mutated by the turn\\n");
  }
  if (mode === "transport_close") {
    process.stderr.write("Error: Connection closed mid-response.\\n");
    process.exit(1);
  }
  if (mode === "hang") {
    // Never settles: the turn must outlive its deadline and be cancelled by
    // the runner's own exact-process cleanup.
    setInterval(() => {}, 1000);
    return;
  }
  const reply = mode === "no_marker" ? "done, but nothing to report" : ${JSON.stringify("__MARKER__")};
  process.stdout.write(JSON.stringify({
    type: "stream_event", session_id: sessionId,
    event: { delta: { type: "text_delta", text: reply } },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", session_id: sessionId, result: reply,
    duration_ms: 8, duration_api_ms: 5, num_turns: 1, total_cost_usd: 0,
    usage: { input_tokens: 3, output_tokens: 2 },
  }) + "\\n");
}

main().catch((error) => { process.stderr.write(String(error && error.stack) + "\\n"); process.exitCode = 1; });
`.replace("__MARKER__", PHASE_A_MARKER), "utf8");
  fs.chmodSync(filePath, 0o755);
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** One isolated Phase-A fixture: fake executable, env file, and fake source checkout. */
function fixture(mode = "ok") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-phase-a-"));
  roots.push(root);
  const claude = path.join(root, "claude");
  writeFakeClaude(claude);
  const envFile = path.join(root, "runtime.env");
  fs.writeFileSync(envFile, [
    `CLAUDE_CONFIG_DIR=${path.join(root, "claude-config")}`,
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=0",
    `CODEX_HARNESSDOCK_CLAUDE_BIN=${claude}`,
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(root, "claude-config"));
  const sourceRoot = path.join(root, "source");
  fs.mkdirSync(sourceRoot);
  git(sourceRoot, "init", "--quiet");
  git(sourceRoot, "config", "user.email", "phase-a@example.invalid");
  git(sourceRoot, "config", "user.name", "phase-a");
  fs.writeFileSync(path.join(sourceRoot, "README.md"), "# fake source checkout\n");
  git(sourceRoot, "add", "README.md");
  git(sourceRoot, "commit", "--quiet", "-m", "initial");
  // A dirty source checkout with an already-untracked file is the ordinary
  // case; the smoke must leave it exactly as dirty as it found it, and must
  // notice a content change that leaves `git status` byte-identical.
  fs.writeFileSync(path.join(sourceRoot, "README.md"), "# fake source checkout\nlocal edit\n");
  const untracked = path.join(sourceRoot, "untracked-note.txt");
  fs.writeFileSync(untracked, "pre-existing untracked content\n");
  const invocations = path.join(root, "invocations.jsonl");
  const invocationRecords = () => (fs.existsSync(invocations)
    ? fs.readFileSync(invocations, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []);
  let fenceSequence = 0;
  return {
    root,
    sourceRoot,
    untracked,
    invocations,
    invocationRecords,
    // Every `-p` line is one real native process spawn, which is one billed
    // Claude call on the production path.
    invocationCount: () => invocationRecords().length,
    fencePath: () => path.join(root, `fence-${(fenceSequence += 1)}`),
    options(overrides = {}) {
      const { driverSeams = {}, ...rest } = overrides;
      return {
        authorized: true,
        sourceRoot,
        fenceFile: path.join(root, `fence-${(fenceSequence += 1)}`),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFile,
          PHASE_A_FAKE_MODE: mode,
          PHASE_A_FAKE_INVOCATION_FILE: invocations,
          PHASE_A_FAKE_SOURCE_TARGET: untracked,
        },
        driverSeams: { inspectRoutes: async () => DISCOVERED_ROUTES, ...driverSeams },
        ...rest,
      };
    },
  };
}

/** Every leaf value a bounded receipt may carry, flattened for scanning. */
function leafValues(value, out = []) {
  if (Array.isArray(value)) {
    for (const entry of value) leafValues(entry, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) leafValues(entry, out);
    return out;
  }
  out.push(value);
  return out;
}

describe("Phase-A authorized real-Claude leaf smoke", () => {
  it("verifies one terminal marker turn through the production Driver and worker loop", async () => {
    const test = fixture("ok");
    const receipt = await runPhaseALeafSmoke(test.options());

    assert.equal(receipt.status, "verified");
    assert.equal(receipt.failureClass, "none");
    // The fence is consumed and the attempt is spent: even a verified run may
    // never be replayed.
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.oneShot.fenceConsumed, true);

    assert.equal(receipt.route.model, PHASE_A_MODEL);
    assert.equal(receipt.route.effort, PHASE_A_EFFORT);
    assert.equal(receipt.route.write, false);
    assert.equal(receipt.route.delegationMode, "leaf");
    assert.equal(receipt.route.topology, "leaf");
    assert.equal(receipt.route.authority, "behavioral_read_only");

    assert.equal(receipt.seam.productionDriver, true);
    assert.equal(receipt.seam.productionWorkerLoop, true);
    assert.equal(receipt.seam.nativeTeamRequested, false);
    assert.equal(receipt.seam.followUpRequested, false);
    assert.equal(receipt.seam.productionSupervisorSession, true);
    assert.equal(receipt.seam.singleNativeAttemptEnforced, true);

    assert.equal(receipt.lifecycle.driverReadinessProven, true);
    assert.equal(receipt.lifecycle.routeAccepted, true);
    assert.equal(receipt.lifecycle.nativeAcceptance, "proven");
    assert.equal(receipt.lifecycle.terminalSettlement, "settled");
    assert.equal(receipt.lifecycle.terminalStatus, "completed");
    assert.equal(receipt.lifecycle.turnFailureClass, null);
    assert.equal(receipt.lifecycle.completionPublished, true);
    assert.equal(receipt.lifecycle.completionEventObserved, true);
    assert.equal(receipt.lifecycle.agentReconciled, true);
    assert.equal(receipt.lifecycle.leasesReleased, true);
    assert.equal(receipt.lifecycle.disposed, true);
    assert.equal(receipt.lifecycle.markerObserved, true);
    assert.equal(receipt.lifecycle.timedOut, false);
    assert.equal(receipt.lifecycle.timeoutCleanup, "not_needed");

    assert.equal(receipt.authority.writeRequested, false);
    assert.equal(receipt.authority.nativeAgentToolDenied, true);
    assert.equal(receipt.authority.workflowToolDenied, true);

    assert.equal(receipt.mutation.gitWorkspaceClean, true);
    assert.deepEqual(receipt.mutation.workspaceChangedBasenames, []);
    assert.equal(receipt.mutation.sourceCheckoutUnchanged, true);
    assert.ok(receipt.mutation.sourceInventoryPathCount >= 2);
    assert.equal(receipt.mutation.runtimeStateIsolated, true);
    assert.equal(receipt.mutation.workspaceDisposed, true);
    assert.equal(receipt.mutation.runtimeHomeDisposed, true);

    assert.equal(receipt.oneShot.launchAttempts, 1);
    assert.equal(receipt.oneShot.retriedAfterPossibleSubmission, false);
    assert.equal(test.invocationCount(), 1);
  });

  it("stops on account or quota evidence without claiming terminal success", async () => {
    const test = fixture("quota");
    const options = test.options();
    const receipt = await runPhaseALeafSmoke(options);

    assert.equal(receipt.status, "auth_or_quota_stopped");
    assert.equal(receipt.failureClass, "auth_or_quota");
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.lifecycle.turnFailureClass, "usage_or_subscription_limit");
    assert.equal(receipt.lifecycle.markerObserved, false);
    assert.notEqual(receipt.status, "verified");
    // One native attempt, and no replay after it.
    assert.equal(test.invocationCount(), 1);
    assert.equal(receipt.oneShot.retriedAfterPossibleSubmission, false);
    // The fence survives every outcome, including a stopped one.
    assert.equal(fs.existsSync(options.fenceFile), true);
  });

  it("stops before any native submission when the host is not authenticated", async () => {
    const test = fixture("logged_out");
    const receipt = await runPhaseALeafSmoke(test.options());

    assert.equal(receipt.status, "auth_or_quota_stopped");
    assert.equal(receipt.failureClass, "auth_or_quota");
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.lifecycle.driverReadinessProven, false);
    assert.equal(receipt.lifecycle.nativeAcceptance, "not_submitted");
    assert.equal(receipt.oneShot.launchAttempts, 0);
    // The fence was already consumed before the Driver was even inspected.
    assert.equal(receipt.oneShot.fenceConsumed, true);
    assert.equal(test.invocationCount(), 0);
  });

  it("never replays an ambiguous native acceptance", async () => {
    const test = fixture("ok");
    let sessions = 0;
    const receipt = await runPhaseALeafSmoke(test.options({
      driverSeams: {
        // A session that reports a completed turn without ever accepting a
        // child: the Driver cannot prove either way whether the request
        // crossed its native transport.
        runTurnSession: async () => {
          sessions += 1;
          return { status: "completed", exitCode: 0, sessionId: "ambiguous", finalMessage: PHASE_A_MARKER };
        },
      },
    }));

    assert.equal(sessions, 1);
    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.failureClass, "launch_ambiguous");
    assert.equal(receipt.lifecycle.nativeAcceptance, "unknown");
    assert.equal(receipt.lifecycle.markerObserved, false);
    assert.equal(receipt.lifecycle.completionPublished, false);
    assert.equal(receipt.oneShot.launchAttempts, 1);
    assert.equal(receipt.oneShot.retriedAfterPossibleSubmission, false);
    // A possibly-submitted attempt is spent even though nothing was proven.
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.oneShot.fenceConsumed, true);
  });

  it("refuses to call a turn verified when the disposable workspace was mutated", async () => {
    const test = fixture("mutate");
    const receipt = await runPhaseALeafSmoke(test.options());

    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.failureClass, "workspace_mutated");
    assert.equal(receipt.mutation.gitWorkspaceClean, false);
    assert.deepEqual(receipt.mutation.workspaceChangedBasenames, ["forbidden-write.txt"]);
    // The turn itself still settled; only the mutation gate refuses it.
    assert.equal(receipt.lifecycle.terminalSettlement, "settled");
    assert.equal(receipt.mutation.workspaceDisposed, true);
  });

  it("reports an absent marker as unverified rather than a completed success", async () => {
    const test = fixture("no_marker");
    const receipt = await runPhaseALeafSmoke(test.options());

    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.failureClass, "marker_absent");
    assert.equal(receipt.lifecycle.markerObserved, false);
    assert.equal(receipt.lifecycle.terminalStatus, "completed");
  });

  it("rejects an unauthorized invocation locally, before any durable or native state", async () => {
    const test = fixture("ok");
    const receipt = await runPhaseALeafSmoke(test.options({ authorized: false }));

    assert.equal(receipt.status, "preflight_rejected");
    assert.equal(receipt.failureClass, "preflight_not_authorized");
    // Nothing was consumed, so this invocation spends no authorized attempt.
    assert.equal(receipt.stopFurtherRealCalls, false);
    assert.equal(receipt.oneShot.fenceConsumed, false);
    assert.equal(receipt.oneShot.launchAttempts, 0);
    assert.equal(receipt.lifecycle.nativeAcceptance, "not_submitted");
    assert.equal(test.invocationCount(), 0);
  });

  it("requires a durable fence before it will reach any Driver", async () => {
    const test = fixture("ok");
    const receipt = await runPhaseALeafSmoke({ ...test.options(), fenceFile: null });

    assert.equal(receipt.status, "preflight_rejected");
    assert.equal(receipt.failureClass, "preflight_fence_required");
    assert.equal(receipt.oneShot.fenceConsumed, false);
    assert.equal(receipt.stopFurtherRealCalls, false);
    assert.equal(test.invocationCount(), 0);
  });

  it("refuses a relative fence and one inside the source checkout", async () => {
    const test = fixture("ok");
    for (const fenceFile of ["phase-a.fence", path.join(test.sourceRoot, "phase-a.fence")]) {
      const receipt = await runPhaseALeafSmoke(test.options({ fenceFile }));
      assert.equal(receipt.status, "preflight_rejected");
      assert.equal(receipt.failureClass, "preflight_fence_path_invalid");
      assert.equal(receipt.oneShot.fenceConsumed, false);
      assert.equal(fs.existsSync(path.join(test.sourceRoot, "phase-a.fence")), false);
    }
    assert.equal(test.invocationCount(), 0);
  });

  it("refuses a fence whose parent symlinks into the source checkout", async () => {
    const test = fixture("ok");
    const link = path.join(test.root, "link-to-source");
    fs.symlinkSync(test.sourceRoot, link);
    const before = git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all");

    const receipt = await runPhaseALeafSmoke(test.options({
      // Lexically outside the checkout; the kernel would create it inside.
      fenceFile: path.join(link, "phase-a.fence"),
    }));

    assert.equal(receipt.status, "preflight_rejected");
    assert.equal(receipt.failureClass, "preflight_fence_path_invalid");
    assert.equal(receipt.oneShot.fenceConsumed, false);
    // The gate held: nothing was created in the source checkout at all.
    assert.equal(fs.existsSync(path.join(test.sourceRoot, "phase-a.fence")), false);
    assert.equal(git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all"), before);
    assert.equal(test.invocationCount(), 0);
  });

  it("refuses a fence whose parent directory does not exist", async () => {
    const test = fixture("ok");
    const receipt = await runPhaseALeafSmoke(test.options({
      fenceFile: path.join(test.root, "absent-directory", "phase-a.fence"),
    }));

    assert.equal(receipt.status, "preflight_rejected");
    assert.equal(receipt.failureClass, "preflight_fence_unavailable");
    assert.equal(receipt.oneShot.fenceConsumed, false);
    assert.equal(receipt.stopFurtherRealCalls, false);
    assert.equal(test.invocationCount(), 0);
  });

  it("rejects a second run through the same durable one-shot fence", async () => {
    const test = fixture("ok");
    const fenceFile = path.join(test.root, "phase-a.fence");
    const first = await runPhaseALeafSmoke(test.options({ fenceFile }));
    assert.equal(first.status, "verified");
    assert.equal(fs.existsSync(fenceFile), true);
    assert.equal(test.invocationCount(), 1);

    const second = await runPhaseALeafSmoke(test.options({ fenceFile }));

    assert.equal(second.status, "preflight_rejected");
    assert.equal(second.failureClass, "preflight_fence_present");
    assert.equal(second.oneShot.fenceConsumed, false);
    assert.equal(second.oneShot.launchAttempts, 0);
    // The refused replay reached no Driver: still exactly one native process.
    assert.equal(test.invocationCount(), 1);
  });

  it("creates the fence atomically, with owner-only mode, before any Driver work", async () => {
    const test = fixture("logged_out");
    const options = test.options();
    const receipt = await runPhaseALeafSmoke(options);

    // The host was never ready, so no Driver turn happened -- yet the fence
    // exists, which is what makes a retry impossible.
    assert.equal(receipt.lifecycle.driverReadinessProven, false);
    assert.equal(fs.existsSync(options.fenceFile), true);
    assert.equal(fs.statSync(options.fenceFile).mode & 0o777, 0o600);
    assert.equal(receipt.stopFurtherRealCalls, true);
  });

  it("cancels the exact child of a timed-out turn and proves it is gone", async () => {
    const test = fixture("hang");
    const receipt = await runPhaseALeafSmoke(test.options({ maxMs: 1_500 }));

    assert.equal(receipt.lifecycle.timedOut, true);
    assert.equal(receipt.lifecycle.timeoutCleanup, "cancelled");
    assert.equal(receipt.failureClass, "turn_timeout");
    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.lifecycle.markerObserved, false);

    // The proof is the process, not the call: the exact native child this turn
    // accepted is no longer alive.
    const [record] = test.invocationRecords();
    assert.ok(record?.pid, "the fake native child recorded its own pid");
    assert.equal(isProcessAlive(record.pid), false);
  });

  it("spawns exactly one native process when a resumable transport close ends the turn", async () => {
    const test = fixture("transport_close");
    const receipt = await runPhaseALeafSmoke(test.options());

    // The production supervisor's bounded reconnect would spawn a second
    // billed Claude process here; this smoke is authorized for exactly one.
    assert.equal(test.invocationCount(), 1);
    assert.equal(receipt.seam.productionSupervisorSession, true);
    assert.equal(receipt.seam.singleNativeAttemptEnforced, true);
    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.failureClass, "turn_failed");
    assert.equal(receipt.lifecycle.turnFailureClass, "transport_closed_resumable");
    assert.equal(receipt.stopFurtherRealCalls, true);
    assert.equal(receipt.oneShot.launchAttempts, 1);
  });

  it("detects a source mutation that leaves the porcelain status byte-identical", async () => {
    const test = fixture("mutate_source");
    const before = git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all");
    const receipt = await runPhaseALeafSmoke(test.options());
    const after = git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all");

    // An already-untracked file changed content, so status text cannot see it.
    assert.equal(before, after);
    assert.notEqual(
      fs.readFileSync(test.untracked, "utf8"),
      "pre-existing untracked content\n",
    );
    assert.equal(receipt.mutation.sourceCheckoutUnchanged, false);
    assert.equal(receipt.failureClass, "source_mutated");
    assert.equal(receipt.status, "unverified");
    assert.deepEqual(receipt.mutation.sourceChangedBasenames, ["untracked-note.txt"]);
    assert.doesNotMatch(JSON.stringify(receipt), /mutated by the turn|pre-existing/);
  });

  it("leaves the source checkout byte-identical and says so without printing its status", async () => {
    const test = fixture("ok");
    const before = git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all");
    const receipt = await runPhaseALeafSmoke(test.options());
    const after = git(test.sourceRoot, "status", "--porcelain", "--untracked-files=all");

    assert.equal(before, after);
    assert.equal(receipt.mutation.sourceCheckoutUnchanged, true);
    assert.deepEqual(receipt.mutation.sourceChangedBasenames, []);
    assert.equal(
      fs.readFileSync(path.join(test.sourceRoot, "README.md"), "utf8"),
      "# fake source checkout\nlocal edit\n",
    );
    assert.doesNotMatch(JSON.stringify(receipt), /README\.md/);
  });

  it("emits only closed, bounded facts", async () => {
    const test = fixture("ok");
    const receipt = await runPhaseALeafSmoke(test.options());
    const text = JSON.stringify(receipt);

    assert.ok(PHASE_A_STATUSES.includes(receipt.status));
    assert.ok(PHASE_A_FAILURE_CLASSES.includes(receipt.failureClass));
    assert.ok(PHASE_A_CLEANUP_OUTCOMES.includes(receipt.lifecycle.timeoutCleanup));
    // No prompt, marker text, transcript, path, credential location, session
    // identity, process identity, or token payload.
    assert.doesNotMatch(text, /HARNESSDOCK_PHASE_A_LEAF_OK/);
    assert.doesNotMatch(text, /pwd|Bash|prompt/i);
    assert.doesNotMatch(text, /\/tmp\/|\/data\/|claude-config|fake-phase-a-session/);
    assert.doesNotMatch(text, /"pid"|sessionId|processIdentity|input_tokens|stderr/);
    for (const value of leafValues(receipt)) {
      assert.ok(
        value === null || typeof value === "boolean" || typeof value === "number" ||
          (typeof value === "string" && value.length <= 64),
        `unbounded receipt value: ${JSON.stringify(value)}`,
      );
    }
  });
});

describe("Phase-A leaf smoke CLI", () => {
  function capture(argv, dependencies = {}) {
    let stdout = "";
    let stderr = "";
    return runPhaseALeafSmokeCli(argv, {
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
      assertCheckoutDependencies: () => {},
      ...dependencies,
    }).then((code) => ({ code, stdout, stderr }));
  }

  it("refuses to run without explicit authorization and never reaches the runner", async () => {
    let calls = 0;
    const result = await capture([], {
      runPhaseALeafSmoke: async () => { calls += 1; return {}; },
    });

    assert.equal(calls, 0);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).status, "preflight_rejected");
    assert.equal(JSON.parse(result.stdout).failureClass, "preflight_not_authorized");
    assert.match(result.stderr, /requires explicit --authorize/);
  });

  it("refuses --authorize without a durable fence path", async () => {
    let calls = 0;
    const result = await capture(["--authorize"], {
      runPhaseALeafSmoke: async () => { calls += 1; return {}; },
    });

    assert.equal(calls, 0);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).failureClass, "preflight_fence_required");
    assert.equal(JSON.parse(result.stdout).stopFurtherRealCalls, false);
    assert.match(result.stderr, /durable one-shot fence is mandatory/);
  });

  it("runs the single authorized attempt exactly once and exits zero only when verified", async () => {
    const seen = [];
    const result = await capture(["--authorize", "--fence-file", "/tmp/phase-a-cli-fence"], {
      runPhaseALeafSmoke: async (options) => {
        seen.push(options);
        return { version: 1, phase: "A", status: "verified", failureClass: "none", stopFurtherRealCalls: false };
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorized, true);
    assert.equal(seen[0].fenceFile, "/tmp/phase-a-cli-fence");
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, "verified");
  });

  it("exits with a distinct code and a stop notice on account or quota evidence", async () => {
    const result = await capture(["--authorize", "--fence-file", "/tmp/phase-a-cli-fence"], {
      runPhaseALeafSmoke: async () => ({
        version: 1, phase: "A", status: "auth_or_quota_stopped",
        failureClass: "auth_or_quota", stopFurtherRealCalls: true,
      }),
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /stop further real Claude calls/);
  });

  it("refuses an unknown option before authorizing anything", async () => {
    let calls = 0;
    const result = await capture(["--authorize", "--fence-file", "/tmp/phase-a-cli-fence", "--write"], {
      runPhaseALeafSmoke: async () => { calls += 1; return {}; },
    });

    assert.equal(calls, 0);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option: --write/);
  });
});
