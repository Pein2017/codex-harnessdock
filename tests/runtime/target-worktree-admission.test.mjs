/** SPDX-License-Identifier: Apache-2.0 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/agent-runtime.mjs";
import { createAgentStore, resolveAgentRegistryDirectory } from "../../runtime/agent-store.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import {
  acquireInstanceLease,
  inspectLeaseInventory,
} from "../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim } from "../../runtime/launch-claim.mjs";
import { admitTargetWorktree } from "../../runtime/target-worktree-admission.mjs";
import { runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";
import { readVersionThreeJobRecord } from "../../runtime/v3-job-store.mjs";
import { acquireWorkspaceWriterLease } from "../../runtime/workspace-writer-lease.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { versionThreeRoute } from "./fixtures/version-three-state.mjs";
import { resolveDriverV2 } from "../../runtime/harness-registry.mjs";
import { PI_HARNESS_ID } from "../../runtime/pi-driver.mjs";

const roots = [];
const sharedRuntimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hd-target-worktree-state-"));
const originalRuntimeHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const originalPath = process.env.PATH;

after(() => fs.rmSync(sharedRuntimeHome, { recursive: true, force: true }));

afterEach(() => {
  if (originalRuntimeHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = originalRuntimeHome;
  process.env.PATH = originalPath;
  delete process.env.HD_TARGET_GIT_COUNTER;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-target-worktree-"));
  roots.push(root);
  const controlRoot = path.join(root, "control");
  const targetWorktree = path.join(root, "target");
  const unicodeWorktree = path.join(root, "target space ü");
  const ambiguousWorktree = path.join(root, "target\nambiguous");
  const unregistered = path.join(root, "unregistered");
  const independent = path.join(root, "independent");
  fs.mkdirSync(controlRoot);
  git(controlRoot, ["init", "-q"]);
  git(controlRoot, ["config", "user.email", "fixture@example.invalid"]);
  git(controlRoot, ["config", "user.name", "Fixture"]);
  fs.writeFileSync(path.join(controlRoot, "tracked.txt"), "fixture\n");
  git(controlRoot, ["add", "tracked.txt"]);
  git(controlRoot, ["commit", "-qm", "fixture"]);
  git(controlRoot, ["worktree", "add", "-qb", "target", targetWorktree]);
  git(controlRoot, ["worktree", "add", "-qb", "unicode-target", unicodeWorktree]);
  git(controlRoot, ["worktree", "add", "-qb", "ambiguous-target", ambiguousWorktree]);
  fs.mkdirSync(unregistered);
  execFileSync("git", ["clone", "-q", controlRoot, independent]);
  const runtimeHome = sharedRuntimeHome;
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = runtimeHome;
  return {
    root, controlRoot, targetWorktree, unicodeWorktree, ambiguousWorktree,
    unregistered, independent, runtimeHome,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => error?.code === code && !String(error.message).includes(path.sep));
}

describe("target worktree admission", () => {
  it("admits only one canonical registered sibling and fails closed on the target matrix", () => {
    const value = fixture();
    assert.deepEqual(admitTargetWorktree({
      controlRoot: value.controlRoot,
      targetWorktree: value.targetWorktree,
    }), {
      controlRoot: fs.realpathSync.native(value.controlRoot),
      executionRoot: fs.realpathSync.native(value.targetWorktree),
    });
    assert.deepEqual(admitTargetWorktree({ controlRoot: value.controlRoot }), {
      controlRoot: fs.realpathSync.native(value.controlRoot),
      executionRoot: fs.realpathSync.native(value.controlRoot),
    });
    assert.equal(
      admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.unicodeWorktree }).executionRoot,
      fs.realpathSync.native(value.unicodeWorktree),
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.ambiguousWorktree }),
      "target_not_registered",
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: "relative" }),
      "target_not_absolute",
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.controlRoot }),
      "target_is_control_root",
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: path.join(value.root, "missing") }),
      "target_missing",
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.unregistered }),
      "target_not_registered",
    );
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.independent }),
      "target_not_registered",
    );

    fs.renameSync(path.join(value.targetWorktree, ".git"), path.join(value.targetWorktree, ".git.hidden"));
    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.targetWorktree }),
      "target_prunable",
    );
  });

  it("completes target admission before route inspection or durable Agent mutation", async () => {
    const value = fixture();
    const envFile = path.join(value.root, "runtime.env");
    const claudeConfigDir = path.join(value.root, "claude");
    fs.mkdirSync(claudeConfigDir);
    fs.writeFileSync(envFile, `CLAUDE_CONFIG_DIR=${claudeConfigDir}\n`);
    const runtime = createAgentRuntime({
      cwd: value.controlRoot,
      envFile,
      env: {
        ...process.env,
        CODEX_THREAD_ID: "target-worktree-root",
        CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "target-worktree-root",
        CODEX_HARNESSDOCK_RUNTIME_HOME: value.runtimeHome,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    });
    let inspections = 0;
    runtime.jobs.inspectRouteInstance = async () => {
      inspections += 1;
      throw new Error("route inspection spy reached");
    };
    const request = {
      task_name: "target_probe",
      message: "probe only",
      harness: "claude-code",
      model: "claude-sonnet-5",
      topology: "leaf",
      write: false,
      reasoning_effort: "high",
    };
    await assert.rejects(
      runtime.spawnAgent({ ...request, target_worktree: value.targetWorktree }),
      /route inspection spy reached/,
    );
    assert.equal(inspections, 1);
    assert.deepEqual(runtime.store.listAgents(), []);

    for (const target of ["relative", value.controlRoot, path.join(value.root, "missing"), value.unregistered, value.independent]) {
      await assert.rejects(runtime.spawnAgent({ ...request, target_worktree: target }));
      assert.equal(inspections, 1, `invalid target ${target} reached route inspection`);
      assert.deepEqual(runtime.store.listAgents(), []);
    }
  });

  it("classifies a changed second Git inventory observation as owner drift", () => {
    const value = fixture();
    const bin = path.join(value.root, "bin");
    const counter = path.join(value.root, "git-counter");
    fs.mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(bin, "git");
    fs.writeFileSync(wrapper, `#!/bin/sh
case " $* " in
  *" worktree list --porcelain "*)
    count=0
    test -f "$HD_TARGET_GIT_COUNTER" && count=$(cat "$HD_TARGET_GIT_COUNTER")
    count=$((count + 1))
    printf '%s' "$count" > "$HD_TARGET_GIT_COUNTER"
    test "$count" -lt 2 || exit 73
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`);
    fs.chmodSync(wrapper, 0o755);
    process.env.HD_TARGET_GIT_COUNTER = counter;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;

    expectCode(
      () => admitTargetWorktree({ controlRoot: value.controlRoot, targetWorktree: value.targetWorktree }),
      "target_owner_drift",
    );
    assert.equal(fs.readFileSync(counter, "utf8"), "2");
  });

  it("sanitizes a target deleted after route inspection and reaches no prompt, claim, session, or native launch", async () => {
    const value = fixture();
    const ownerRootId = "target-deleted-after-inspection";
    const runtime = createAgentRuntime({
      cwd: value.controlRoot,
      env: {
        ...process.env,
        CODEX_THREAD_ID: ownerRootId,
        CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: ownerRootId,
        CODEX_HARNESSDOCK_RUNTIME_HOME: value.runtimeHome,
      },
    });
    const base = resolveDriverV2(PI_HARNESS_ID, { env: runtime.jobs.env });
    let promptCalls = 0;
    let nativeCalls = 0;
    const driver = Object.freeze({
      ...base,
      prepareTurn(...args) {
        promptCalls += 1;
        return base.prepareTurn(...args);
      },
    });
    runtime.jobs.inspectRouteInstance = async () => {
      const observed = {
        driver,
        inspections: [{
          harnessId: PI_HARNESS_ID,
          instanceKey: "pi-local",
          readiness: "ready",
          liveValidated: true,
          maturity: "experimental",
          detailCode: "ready",
          capabilityProvenance: {
            interaction: "checkout_declared", activeInput: "checkout_declared", continuation: "checkout_declared",
            history: "checkout_declared", interruptRequest: "checkout_declared", turnObservation: "checkout_declared",
            automaticRecovery: "checkout_declared", authorityEnforcement: "checkout_declared",
            leafEnforcement: "checkout_declared", nativeOrchestration: "checkout_declared",
          },
          inspectionGeneration: "unavailable",
          routes: {
            models: ["openai-codex/gpt-5.6-luna"],
            topologies: ["leaf"],
            interaction: "noninteractive_fixed_policy",
            effortsByModel: { "openai-codex/gpt-5.6-luna": ["high"] },
            defaultsByModel: { "openai-codex/gpt-5.6-luna": "high" },
          },
        }],
      };
      fs.rmSync(value.targetWorktree, { recursive: true, force: true });
      return observed;
    };
    runtime.jobs.launchVersionThreeWorker = async () => {
      nativeCalls += 1;
      throw new Error("native launch spy reached");
    };

    await assert.rejects(
      runtime.spawnAgent({
        task_name: "deleted_target",
        message: "must never become a prompt",
        harness: PI_HARNESS_ID,
        model: "openai-codex/gpt-5.6-luna",
        topology: "leaf",
        write: true,
        reasoning_effort: "high",
        target_worktree: value.targetWorktree,
      }),
      (error) => {
        assert.equal(error?.code, "target_missing");
        assert.equal(String(error?.message).includes(value.controlRoot), false);
        assert.equal(String(error?.message).includes(value.targetWorktree), false);
        return true;
      },
    );
    assert.equal(promptCalls, 0);
    assert.equal(nativeCalls, 0);
    assert.deepEqual(runtime.versionThreeStore().listAgents(), []);
  });

  it("runs a targeted detached fake-Driver turn from control state and settles or retains both leases", async () => {
    const value = fixture();
    const ownerRootId = "targeted-fake-root";
    const makeTurn = async ({ suffix, unknown }) => {
      const route = versionThreeRoute({
        instanceKey: `targeted-instance-${suffix}`,
        authority: "behavioral_write",
      });
      const store = createAgentStore({
        cwd: value.controlRoot,
        ownerRootId,
        writeGeneration: FUTURE_WRITE_GENERATION,
      });
      const agent = store.createAgent({
        task_name: `targeted_${suffix}`,
        route,
        executionRoot: value.targetWorktree,
        initialMessage: "write the bounded fixture",
      });
      const jobId = `job-targeted-${suffix}`;
      const attemptId = `attempt-targeted-${suffix}`;
      const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
      assert.equal(reservation.reserved, true);
      const identity = { ownerRootId, agentId: agent.agentId, jobId };
      const instanceLease = acquireInstanceLease({
        ...identity,
        route,
        harnessId: route.harnessId,
        instanceKey: route.instanceKey,
        capacityClass: `targeted-${suffix}`,
        capacityLimit: 1,
      });
      const writerLease = acquireWorkspaceWriterLease({
        ...identity,
        route,
        workspaceRoot: value.targetWorktree,
      });
      const assignedMessageIds = reservation.assignedMessages.map((message) => message.messageId);
      const fixtureDriver = createFakeServiceDriver({
        instances: [{ instanceKey: route.instanceKey, readiness: "ready", detailCode: "ready" }],
        resultOverride: unknown
          ? (result) => ({ ...result, executionWorld: { ...result.executionWorld, settlement: "unknown" } })
          : undefined,
      });
      let observedExecutionRoot = null;
      const driver = Object.freeze({
        ...fixtureDriver.driver,
        revalidatePreparedTurn(prepared, scope) {
          observedExecutionRoot = scope.workspaceRoot;
          return fixtureDriver.driver.revalidatePreparedTurn(prepared, scope);
        },
      });
      const preparedTurn = driver.prepareTurn({ route, taskInput: "write the bounded fixture" });
      createLaunchClaim({
        ...identity,
        attemptId,
        controlRoot: value.controlRoot,
        executionRoot: value.targetWorktree,
        route,
        leaseBindings: [instanceLease, writerLease],
        assignedMessageIds,
        preparedInput: "write the bounded fixture",
        turnOptions: null,
        inspectionEvidence: { generation: "unavailable", capabilities: route.capabilities },
      });
      const result = await runVersionThreeWorkerLoop({
        ...identity,
        attemptId,
        route,
        driver,
        preparedTurn,
        preparedInput: "write the bounded fixture",
        assignedMessageIds,
        assignedInputs: [],
        leaseBindings: [
          { ...instanceLease, route },
          { ...writerLease, route },
        ],
        turnOptions: null,
        controlRoot: value.controlRoot,
        executionRoot: value.targetWorktree,
        env: {},
        cwd: value.controlRoot,
      });
      return {
        result,
        observedExecutionRoot,
        record: readVersionThreeJobRecord({ ...identity }),
      };
    };

    const settled = await makeTurn({ suffix: "settled", unknown: false });
    assert.equal(settled.result.status, "completed");
    assert.equal(settled.result.leaseRelease.outcome, "all");
    assert.equal(settled.observedExecutionRoot, fs.realpathSync.native(value.targetWorktree));
    assert.equal(settled.record.controlRoot, fs.realpathSync.native(value.controlRoot));
    assert.equal(settled.record.executionRoot, fs.realpathSync.native(value.targetWorktree));
    assert.equal(fs.existsSync(resolveAgentRegistryDirectory({ cwd: value.controlRoot, ownerRootId })), true);
    assert.equal(fs.existsSync(resolveAgentRegistryDirectory({ cwd: value.targetWorktree, ownerRootId })), false);
    assert.equal(inspectLeaseInventory({ kinds: ["instance", "writer"] }).total, 0);

    const retained = await makeTurn({ suffix: "unknown", unknown: true });
    assert.equal(retained.result.status, "unknown");
    assert.equal(retained.result.leasesReleased, false);
    const held = inspectLeaseInventory({ kinds: ["instance", "writer"] });
    assert.equal(held.total, 2);
    assert.deepEqual(new Set(held.entries.map((entry) => entry.kind)), new Set(["instance", "writer"]));
  });
});
