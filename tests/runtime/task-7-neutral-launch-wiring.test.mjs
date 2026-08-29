/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 7 mandatory carry-forward from Task 6: the accepted Driver Contract v2
 * turn options and native session continuation must travel through the real
 * neutral version-three launch path, not only through a hand-built
 * `DriverScope`/`startTurn()` call, and one native Claude configuration must
 * enter exactly one logical version-three instance namespace.
 *
 * The Claude Driver here is the real production `createClaudeCodeDriverV2()`
 * behind a fake native session, wired through the real
 * `runVersionThreeWorkerLoop()`/`launchVersionThreeTurn()` owners -- the same
 * composition `claude-driver-v2-interrupt-command-path.test.mjs` already uses.
 * No real Claude process is started.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentStore } from "../../runtime/agent-store.mjs";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_HARNESS_ID,
  claudeCodeInstanceKey,
  createClaudeCodeDriverV2,
  reconcileLegacyClaudeInstanceKey,
} from "../../runtime/claude-code-driver.mjs";
import {
  canonicalClaudeInstanceKey,
  canonicalInstanceKeyForHarness,
  versionThreeInstanceKeyForHarness,
} from "../../runtime/claude-legacy-adapter.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";
import {
  acceptDriverRoute,
  createDriverScope,
  inspectDriverInstances,
} from "../../runtime/harness-registry.mjs";
import { acquireInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import { createLaunchClaim, readLaunchClaim } from "../../runtime/launch-claim.mjs";
import { launchVersionThreeTurn } from "../../runtime/v3-worker-launch.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { acquireInstanceLease as acquireFixtureInstanceLease } from "../../runtime/instance-admission-lease.mjs";
import {
  V3_HARNESS_ID,
  V3_INSTANCE_KEY,
  versionThreeRoute,
} from "./fixtures/version-three-state.mjs";
import { runVersionThreeWorkerLoop } from "../../runtime/v3-worker-loop.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-task7-wiring-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let sequence = 0;

const PROMPT = "Inspect only.\n\nReturn one bounded finding.";
const EXECUTABLE = "/usr/local/bin/claude";

function hostSeams() {
  return {
    observeAvailability: () => ({ available: true, detail: "claude 2.0.0" }),
    observeAuth: () => ({ available: true, loggedIn: true, detail: "logged in" }),
    observeCompatibility: () => ({
      staticCompatible: true,
      version: "2.0.0",
      fingerprint: "fingerprint-1",
      executable: EXECUTABLE,
    }),
    revalidateCompatibility: (_cwd, compatibility) => compatibility,
  };
}

function claudeResult(overrides = {}) {
  return {
    status: "completed",
    exitCode: 0,
    sessionId: "session-task7-wiring",
    finalMessage: "the work is done",
    failureClass: null,
    failureReason: null,
    resumable: false,
    requiresAttention: false,
    assistantOutputObserved: true,
    toolUses: [],
    touchedFiles: [],
    attempts: [],
    recoveryAttempts: 0,
    steering: null,
    runtimeReceipt: { claudeCodeVersion: "2.0.0" },
    providerReportedMetrics: null,
    lastByteAt: null,
    stderr: null,
    warning: null,
    ...overrides,
  };
}

/** A fake stream-json session that records every request and settles at once. */
function fakeSession() {
  const state = { requests: [] };
  const run = async (request) => {
    state.requests.push(request);
    await request.onSpawn({ pid: 5150, pidIdentity: "task7-wiring-identity" });
    return claudeResult();
  };
  return { run, state };
}

/**
 * One production-shaped version-three turn: real Agent record, real mailbox,
 * real instance lease, real launch claim, real worker loop, real Claude
 * Driver v2 -- with only the native session faked.
 */
async function setup(options = {}) {
  sequence += 1;
  const label = sequence;
  const workspaceRoot = path.join(root, `workspace-${label}`);
  fs.mkdirSync(workspaceRoot);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, `runtime-home-${label}`);
  const configDir = path.join(root, `claude-config-${label}`);
  const env = { CLAUDE_CONFIG_DIR: configDir, PATH: "/usr/bin" };

  const session = options.session ?? fakeSession();
  const driver = createClaudeCodeDriverV2({
    env,
    runTurnSession: session.run,
    requestInterrupt: () => ({ requested: true, requestFailure: null }),
    recordCompatibilityObservation: () => ({ recorded: true, compatibility: { version: "2.0.0" } }),
    ...hostSeams(),
  });

  const ownerRootId = `root-w-${label}`;
  const jobId = `job-w-${label}`;
  const attemptId = `attempt-w-${label}`;

  const inspections = await inspectDriverInstances(driver, createDriverScope({
    driver, purpose: "inspect", rootId: ownerRootId, workspaceRoot, env,
  }));
  const { route } = acceptDriverRoute(driver, {
    harnessId: CLAUDE_CODE_HARNESS_ID,
    model: options.model ?? "claude-sonnet-5",
    effort: options.routeEffort ?? "high",
    topology: "leaf",
    authority: "behavioral_read_only",
  }, inspections);
  const v3Route = { ...route, capabilitySchemaVersion: route.capabilities.capabilitySchemaVersion };

  const store = createAgentStore({ cwd: workspaceRoot, ownerRootId, writeGeneration: FUTURE_WRITE_GENERATION });
  const agent = store.createAgent({ task_name: `claude_wiring_${label}`, route: v3Route, initialMessage: PROMPT });
  const reservation = store.reserveActivation(agent.agentId, jobId, { initial: true });
  assert.ok(reservation.reserved, "version-three activation reservation failed");

  const lease = acquireInstanceLease({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    route: v3Route,
    harnessId: v3Route.harnessId,
    instanceKey: v3Route.instanceKey,
    capacityClass: `claude-v2-wiring-${label}`,
    capacityLimit: 1,
  });

  const preparedTurn = driver.prepareTurn({
    route: v3Route,
    taskInput: PROMPT,
    turnId: jobId,
    ...(options.turnOptions === undefined ? {} : { turnOptions: options.turnOptions }),
  });
  const assignedMessageIds = reservation.assignedMessages.map((message) => message.messageId);
  const launchTurnOptions = options.launchTurnOptions === undefined
    ? preparedTurn.turnOptions
    : options.launchTurnOptions;
  createLaunchClaim({
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    route: v3Route,
    leaseBindings: [lease],
    assignedMessageIds,
    preparedInput: PROMPT,
    turnOptions: launchTurnOptions,
  });

  return {
    ownerRootId,
    agentId: agent.agentId,
    jobId,
    attemptId,
    configDir,
    route: v3Route,
    session,
    driver,
    preparedTurn,
    input: {
      ownerRootId,
      agentId: agent.agentId,
      jobId,
      attemptId,
      route: v3Route,
      driver,
      preparedTurn,
      preparedInput: PROMPT,
      assignedMessageIds,
      assignedInputs: [],
      leaseBindings: [lease],
      workspaceRoot,
      env: {},
      cwd: workspaceRoot,
      // Always stated. Claude's prepared turn always resolves an explicit
      // effort, so a launch that stated nothing would now be refused.
      turnOptions: launchTurnOptions,
      ...(options.nativeSessionRef === undefined ? {} : { nativeSessionRef: options.nativeSessionRef }),
    },
    claim: () => {
      try {
        return readLaunchClaim({ ownerRootId, agentId: agent.agentId, jobId, attemptId });
      } catch {
        return null;
      }
    },
  };
}

describe("Task 7 — turn options reach the native turn through the neutral launch path", () => {
  it("carries an explicit task effort into the real Claude v2 session, bound to the prepared digest", async () => {
    const context = await setup({ turnOptions: { effort: "xhigh" }, launchTurnOptions: { effort: "xhigh" } });
    const result = await runVersionThreeWorkerLoop(context.input);
    assert.equal(result.status, "completed");

    const [request] = context.session.state.requests;
    assert.ok(request, "the neutral launch never reached the Claude session");
    assert.equal(request.claudeOptions.effort, "xhigh");

    // The effort that ran is the effort the prepared evidence digested.
    assert.deepEqual(context.preparedTurn.turnOptions, { effort: "xhigh" });
    assert.equal(
      context.preparedTurn.inputDigest,
      context.driver.prepareTurn({
        route: context.route,
        taskInput: "Inspect only.\n\nReturn one bounded finding.",
        turnId: context.jobId,
        turnOptions: { effort: "xhigh" },
      }).inputDigest
    );
    assert.notEqual(
      context.preparedTurn.inputDigest,
      context.driver.prepareTurn({
        route: context.route,
        taskInput: "Inspect only.\n\nReturn one bounded finding.",
        turnId: context.jobId,
        turnOptions: { effort: "low" },
      }).inputDigest
    );
  });

  it("refuses a launch whose turn options are not the ones its prepared evidence bound", async () => {
    const context = await setup({ turnOptions: { effort: "low" }, launchTurnOptions: { effort: "max" } });
    await assert.rejects(
      runVersionThreeWorkerLoop(context.input),
      (error) => error?.acceptance === "not_submitted" && /turn options/i.test(error.message)
    );
    assert.equal(context.session.state.requests.length, 0, "a mismatched turn option must never be submitted");
  });

  it("refuses a launch that states nothing where its prepared turn bound options", async () => {
    // Claude's prepared turn always resolves an explicit effort, so stating
    // `null` here is not "no preference" -- it is a different launch, and it
    // must never be silently reinterpreted as the prepared default.
    const context = await setup({ turnOptions: { effort: "low" }, launchTurnOptions: null });
    await assert.rejects(
      runVersionThreeWorkerLoop(context.input),
      (error) => error?.acceptance === "not_submitted" && /turn options/i.test(error.message)
    );
    assert.equal(context.session.state.requests.length, 0);
  });

  it("refuses a worker input that omits turn options without advancing its parent claim", async () => {
    const context = await setup({ turnOptions: { effort: "low" } });
    const omitted = { ...context.input };
    delete omitted.turnOptions;
    await assert.rejects(
      runVersionThreeWorkerLoop(omitted),
      /requires turnOptions/
    );
    assert.equal(context.session.state.requests.length, 0);
    assert.equal(context.claim().submissionState, "not_started");
  });

  it("never reads Claude-specific option vocabulary in the generic core", () => {
    const runtimeDirectory = path.resolve(new URL("../../runtime/", import.meta.url).pathname);
    for (const name of [
      "harness-registry.mjs",
      "harness-contract.mjs",
      "v3-worker-launch.mjs",
      "v3-worker-loop.mjs",
      "durable-state-v3.mjs",
      "instance-admission-lease.mjs",
      "launch-claim.mjs",
    ]) {
      // Prose may explain the boundary; executable code may not cross it.
      const code = fs.readFileSync(path.join(runtimeDirectory, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /\bclaude(?:Options|Effort)\b/i, `${name} must not read Claude-specific options`);
      // The static registry names its admitted Drivers by design, and
      // `harness-contract.mjs` owns `V1_HARNESS_ID` so a durable version-one
      // record can be read without loading any Driver. No lifecycle owner
      // names a Harness at all, and nowhere may one be a fallback.
      assert.doesNotMatch(
        code,
        /\?\?\s*(?:V1_HARNESS_ID|CLAUDE_LEGACY_HARNESS_ID|"claude-code"|'claude-code')/,
        `${name} must not fall back to one Harness`
      );
      if (["harness-registry.mjs", "harness-contract.mjs"].includes(name)) continue;
      assert.doesNotMatch(code, /claude/i, `${name} must not name one Harness`);
    }
  });
});

describe("Task 7 — exact session continuation reaches the native turn through the neutral launch path", () => {
  it("resumes the exact validated native session and keeps session and turn references distinct", async () => {
    const first = await setup({});
    const firstResult = await runVersionThreeWorkerLoop(first.input);
    assert.equal(firstResult.status, "completed");
    const sessionRef = firstResult.terminalResult.continuation.nativeSessionRef;
    assert.ok(sessionRef, "the completed turn proved no native session to resume");

    const second = await setup({ nativeSessionRef: sessionRef });
    // The second turn belongs to a different logical instance, so the exact
    // same-route rule must refuse it rather than resuming a foreign session.
    await assert.rejects(
      runVersionThreeWorkerLoop(second.input),
      (error) => error?.acceptance === "not_submitted" && /instance/i.test(error.message)
    );
    assert.equal(second.session.state.requests.length, 0);

    const sameRoute = await setup({});
    const owned = {
      ...sessionRef,
      instanceKey: sameRoute.route.instanceKey,
    };
    sameRoute.input.nativeSessionRef = owned;
    const resumed = await runVersionThreeWorkerLoop(sameRoute.input);
    assert.equal(resumed.status, "completed");
    const [request] = sameRoute.session.state.requests;
    assert.equal(request.claudeOptions.resumeSessionId, sessionRef.locator.sessionId);

    // Session and turn references stay distinct durable envelopes.
    const claim = sameRoute.claim();
    assert.ok(claim.nativeTurnRef);
    assert.notDeepEqual(claim.nativeTurnRef.locator, owned.locator);
    assert.ok(Object.hasOwn(claim.nativeTurnRef.locator, "pid"));
  });

  it("refuses a native turn reference offered where a session reference belongs", async () => {
    const first = await setup({});
    assert.equal((await runVersionThreeWorkerLoop(first.input)).status, "completed");
    const turnRef = first.claim().nativeTurnRef;

    const second = await setup({});
    second.input.nativeSessionRef = { ...turnRef, instanceKey: second.route.instanceKey };
    await assert.rejects(
      runVersionThreeWorkerLoop(second.input),
      (error) => error?.acceptance === "not_submitted" && /session locator/i.test(error.message)
    );
    assert.equal(second.session.state.requests.length, 0);
  });
});

describe("Task 7 — one native Claude configuration enters one version-three instance namespace", () => {
  it("maps a legacy Claude configuration identity onto the exact redacted version-three key", () => {
    const configDir = path.join(root, "shared-claude-config");
    fs.mkdirSync(configDir, { recursive: true });
    const legacyKey = canonicalClaudeInstanceKey(configDir);
    const redacted = claudeCodeInstanceKey(configDir);

    assert.equal(versionThreeInstanceKeyForHarness(CLAUDE_CODE_HARNESS_ID, legacyKey), redacted);
    assert.equal(versionThreeInstanceKeyForHarness(CLAUDE_CODE_HARNESS_ID, configDir), redacted);
    assert.equal(reconcileLegacyClaudeInstanceKey(legacyKey), redacted);
    // Idempotent: an already-redacted key is one namespace, never re-hashed.
    assert.equal(versionThreeInstanceKeyForHarness(CLAUDE_CODE_HARNESS_ID, redacted), redacted);
    // The raw configuration path never survives into the namespace identity.
    assert.doesNotMatch(redacted, /[/\\]/);
    // The legacy namespace itself is unchanged.
    assert.equal(canonicalInstanceKeyForHarness(CLAUDE_CODE_HARNESS_ID, configDir), legacyKey);
    // Another Harness owns its own key verbatim.
    assert.equal(versionThreeInstanceKeyForHarness("fake-service", "tenant-alpha"), "tenant-alpha");
    assert.throws(() => versionThreeInstanceKeyForHarness("fake-service", null), /instance key/i);
  });

  it("gives a legacy configuration and the Driver's own inspected key one lease namespace", async () => {
    const context = await setup({});
    assert.equal(
      versionThreeInstanceKeyForHarness(CLAUDE_CODE_HARNESS_ID, context.configDir),
      context.route.instanceKey
    );
    assert.equal(
      versionThreeInstanceKeyForHarness(
        CLAUDE_CODE_HARNESS_ID,
        canonicalClaudeInstanceKey(context.configDir)
      ),
      context.route.instanceKey
    );
  });

  it("never re-resolves a version-three instance key as a filesystem path, and rewrites no legacy bytes", () => {
    const workspaceRoot = path.join(root, "legacy-namespace-workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "legacy-namespace-home");
    const ownerRootId = "root-legacy-namespace";
    const configDir = path.join(root, "legacy-namespace-config");
    fs.mkdirSync(configDir, { recursive: true });

    const legacyStore = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId,
      claudeConfigDir: configDir,
      harness: { harnessId: CLAUDE_CODE_HARNESS_ID, driverVersion: "claude-code@2", capabilities: CLAUDE_CODE_CAPABILITIES },
    });
    const legacyAgent = legacyStore.createAgent({
      task_name: "legacy_namespace_agent",
      selectedModel: "claude-sonnet-5",
      initialMessage: "legacy work",
    });
    assert.equal(legacyAgent.version, 2);

    // The future generation reads the same configuration through the
    // version-three namespace: the redacted key, never `path.resolve()`d, and
    // never a second logical instance for one native Claude configuration.
    const futureStore = createAgentStore({
      cwd: workspaceRoot,
      ownerRootId,
      writeGeneration: FUTURE_WRITE_GENERATION,
      harness: {
        harnessId: CLAUDE_CODE_HARNESS_ID,
        instanceKey: claudeCodeInstanceKey(configDir),
        driverVersion: "claude-code@3",
        capabilities: CLAUDE_CODE_CAPABILITIES,
      },
    });
    const readBack = futureStore.readAgent(legacyAgent.agentId);
    assert.equal(readBack.version, 2, "reading a legacy record must not rewrite it");
    assert.equal(readBack.harnessId, CLAUDE_CODE_HARNESS_ID);

    // A future-generation store never invents a Claude configuration
    // directory for a legacy session binding out of a redacted key.
    assert.throws(
      () => futureStore.bindSession(legacyAgent.agentId, "session-x", { jobId: "job-x", allowTerminal: true }),
      /explicit|instance/i
    );
  });
});

const contentionFixture = fileURLToPath(
  new URL("./fixtures/launch-claim-contender.mjs", import.meta.url)
);

describe("Task 7 correction — turn options are durably bound to the launch claim", () => {
  function claimContext(label) {
    const stateHome = path.join(root, `claim-home-${label}`);
    process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = stateHome;
    return { stateHome };
  }

  function claimInput(overrides) {
    const binding = { ownerRootId: "root-opt", agentId: "agent-opt", jobId: "job-opt" };
    const route = versionThreeRoute();
    return {
      ...binding,
      attemptId: "attempt-same",
      route,
      leaseBindings: [acquireFixtureInstanceLease({
        ...binding,
        route,
        harnessId: V3_HARNESS_ID,
        instanceKey: V3_INSTANCE_KEY,
        capacityClass: "default",
        capacityLimit: 4,
      })],
      assignedMessageIds: ["message-1"],
      preparedInput: "identical prompt",
      ...overrides,
    };
  }

  it("refuses an omitted turn-option value rather than inventing one", () => {
    claimContext("omitted");
    const input = claimInput({ turnOptions: null });
    delete input.turnOptions;
    assert.throws(() => createLaunchClaim(input), /requires an explicit turnOptions/);
  });

  it("digests stated options apart from stated-nothing, and never persists the bag", () => {
    claimContext("digest");
    const stated = createLaunchClaim(claimInput({ turnOptions: { effort: "low" } }));
    assert.equal(stated.acceptance, "not_submitted");
    // The stated bag is durably bound so a replay cannot change the turn.
    const persisted = JSON.stringify(stated);
    assert.doesNotMatch(persisted, /identical prompt/);
    assert.deepEqual(stated.turnOptions, { effort: "low" });

    // Same attempt, same prompt, same mailbox identity, different options.
    assert.throws(
      () => createLaunchClaim(claimInput({ turnOptions: { effort: "max" } })),
      /identity mismatch/
    );
    // Stating nothing is its own value, never equal to a stated bag.
    assert.throws(
      () => createLaunchClaim(claimInput({ turnOptions: null })),
      /identity mismatch/
    );
    // The exact same options replay idempotently.
    const replay = createLaunchClaim(claimInput({ turnOptions: { effort: "low" } }));
    assert.equal(replay.inputDigest, stated.inputDigest);
  });

  it("lets two independent same-attempt processes with different options share nothing", async () => {
    claimContext("contenders");
    const stateHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    const run = (turnOptionsText) => new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [contentionFixture, "create", "attempt-shared", turnOptionsText],
        { env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: stateHome } }
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(stdout.trim()));
    });
    const results = await Promise.all([
      run(JSON.stringify({ effort: "low" })),
      run(JSON.stringify({ effort: "max" })),
    ]);
    assert.equal(
      results.filter((value) => value === "ok").length, 1,
      `exactly one launch may own the attempt: ${results.join(",")}`
    );
    assert.equal(
      results.filter((value) => value === "mismatch").length, 1,
      `the other must be refused as an identity mismatch: ${results.join(",")}`
    );
  });

  it("refuses an omitted launch turn-option value even where the prepared turn bound none", async () => {
    const label = "omitted-launch";
    claimContext(label);
    const workspaceRoot = path.join(root, `claim-workspace-${label}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { driver, control } = createFakeServiceDriver();
    const binding = { ownerRootId: "root-omit", agentId: "agent-omit", jobId: "job-omit" };
    const route = versionThreeRoute({ harnessId: driver.harnessId, driverVersion: driver.driverVersion });
    const lease = acquireFixtureInstanceLease({
      ...binding,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: "default",
      capacityLimit: 4,
    });
    const preparedInput = "a prompt with no Driver options";
    // This Driver owns no turn options, so its prepared bag is null and an
    // omission would compare equal to it. The launch core must still refuse:
    // "stated null" and "said nothing" are not the same claim.
    await assert.rejects(
      launchVersionThreeTurn({
        ...binding,
        attemptId: "attempt-omit",
        lifecycleOwner: "version_three_worker",
        route,
        driver,
        preparedTurn: driver.prepareTurn({ route, taskInput: preparedInput }),
        preparedInput,
        assignedMessageIds: ["message-1"],
        assignedInputs: [],
        leaseBindings: [lease],
        workspaceRoot,
      }),
      /requires turnOptions/
    );
    assert.equal(control.turnIds().length, 0);
    assert.equal(readLaunchClaim(binding), null, "no durable claim may exist for an unstated launch");
  });

  it("refuses a native submission for a same-attempt replay whose options changed", async () => {
    const label = "submission";
    claimContext(label);
    const workspaceRoot = path.join(root, `claim-workspace-${label}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const { driver, control } = createFakeServiceDriver();
    const binding = { ownerRootId: "root-sub", agentId: "agent-sub", jobId: "job-sub" };
    const route = versionThreeRoute({ harnessId: driver.harnessId, driverVersion: driver.driverVersion });
    const lease = acquireFixtureInstanceLease({
      ...binding,
      route,
      harnessId: route.harnessId,
      instanceKey: route.instanceKey,
      capacityClass: "default",
      capacityLimit: 4,
    });
    const preparedInput = "one prompt, two efforts";
    const launchInput = (turnOptions) => ({
      ...binding,
      attemptId: "attempt-sub",
      lifecycleOwner: "version_three_worker",
      route,
      driver,
      preparedTurn: { ...driver.prepareTurn({ route, taskInput: preparedInput }), turnOptions },
      preparedInput,
      assignedMessageIds: ["message-1"],
      assignedInputs: [],
      leaseBindings: [lease],
      workspaceRoot,
      turnOptions,
    });

    createLaunchClaim({
      ...binding,
      attemptId: "attempt-sub",
      lifecycleOwner: "version_three_worker",
      route,
      leaseBindings: [lease],
      assignedMessageIds: ["message-1"],
      preparedInput,
      turnOptions: { tier: "one" },
    });

    const first = await launchVersionThreeTurn(launchInput({ tier: "one" }));
    assert.ok(first.liveTurn.nativeTurnRef);
    assert.equal(control.turnIds().length, 1);

    // The same attempt, replayed with different Driver-owned options, can
    // neither reuse the claim nor reach the service a second time.
    await assert.rejects(
      launchVersionThreeTurn(launchInput({ tier: "two" })),
      (error) => /identity mismatch|already crossed|does not match/.test(error.message)
    );
    assert.equal(control.turnIds().length, 1, "exactly one native submission may exist");
    await first.liveTurn.dispose();
  });
});
