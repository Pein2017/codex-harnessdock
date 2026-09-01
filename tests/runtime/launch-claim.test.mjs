/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenSpec `generalize-multi-harness-agent-control-plane` task 5.3.
 *
 * `runtime/launch-claim.mjs` is the narrow single owner of the durable
 * launch-claim/attempt state machine `design.md` decision 4 and the
 * `durable-runtime-state` spec require before any possible native submission:
 * one unique launch claim/attempt bound to the trusted root/Agent/job,
 * immutable route/capability snapshot, authority lease bindings (proven
 * against Task 4's own brand-gated acquisition evidence, never a caller's
 * claim about them), a bounded ordered mailbox activation identity plus a
 * module-owned digest (never caller-supplied, never prompt content), the
 * closed acceptance axis `not_submitted|acceptance_proven|acceptance_rejected|
 * acceptance_unknown`, whose only proof is Task 1's own `durableTurnEvidence()`
 * brand seam, and a separate `submissionState` pre-submission fence gating
 * rollback eligibility. It never calls a Driver, never acquires or releases
 * a lease, never appends or acknowledges a mailbox message, and never
 * publishes a completion.
 *
 * This test file, and the module it exercises, are the result of a lead
 * review-driven correction pass over an earlier submission that returned
 * FAIL. See `.superpowers/sdd/2026-08-13-multi-harness-control-plane/
 * task-5b1-report.md` for the exact defects the review found and the
 * corrections applied; this file's own comments do not restate that history.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  LAUNCH_ACCEPTANCE_VALUES,
  LAUNCH_CLAIM_ROLLBACK_REASONS,
  LAUNCH_CLAIM_SCHEMA_VERSION,
  LOCK_ACQUIRE_TIMEOUT_MS,
  MAX_ASSIGNED_MESSAGE_IDS,
  SUBMISSION_STATES,
  bindLaunchClaimLease,
  bindLaunchClaimLeases,
  bindLaunchClaimPhysicalResidencyAsync,
  claimNativeSubmissionStartAsync,
  createLaunchIntent,
  createLaunchClaim,
  beginPreSubmissionRollback,
  completePreSubmissionRollback,
  launchClaimRollbackEligibility,
  listLaunchClaimsForOwnerRoot,
  markNativeSubmissionStarted,
  readLaunchClaim,
  recordLaunchAcceptanceProven,
  recordLaunchAcceptanceRejected,
  recordLaunchAcceptanceUnknown,
  resolveLaunchClaimDirectory,
  verifyPreparedLaunchClaim,
} from "../../runtime/launch-claim.mjs";
import {
  acquireInstanceLease,
  acquireIntendedInstanceLease,
  acquireNativeSessionLease,
  acquiredLeaseEvidence,
  inspectLeaseInventory,
  releaseLeasesForPreSubmissionRollback,
} from "../../runtime/instance-admission-lease.mjs";
import { acquireWorkspaceWriterLease } from "../../runtime/workspace-writer-lease.mjs";
import {
  recordVersionThreeTurnRunning,
  recordVersionThreeTurnUncertain,
} from "../../runtime/v3-job-store.mjs";
import { validateLiveHarnessTurn } from "../../runtime/harness-contract.mjs";
import { getProcessIdentity } from "../../runtime/process-control.mjs";
import { createFakeServiceDriver } from "./fixtures/fake-service-driver.mjs";
import { V3_DRIVER_VERSION, V3_HARNESS_ID, V3_INSTANCE_KEY, versionThreeRoute } from "./fixtures/version-three-state.mjs";
import { FUTURE_WRITE_GENERATION } from "../../runtime/durable-state-v3.mjs";

const contentionFixture = fileURLToPath(
  new URL("./fixtures/launch-claim-contender.mjs", import.meta.url)
);
const intentRaceFixture = fileURLToPath(
  new URL("./fixtures/launch-intent-race.mjs", import.meta.url)
);

const priorHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
const roots = [];

afterEach(() => {
  if (priorHome == null) delete process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
  else process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = priorHome;
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launch-claim-"));
  roots.push(root);
  process.env.CODEX_HARNESSDOCK_RUNTIME_HOME = path.join(root, "state-home");
  return { root };
}

function spawnIntentRace(mode, payload) {
  const child = spawn(process.execPath, [intentRaceFixture, mode, JSON.stringify(payload)], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `race child exited ${code}`));
    });
  });
  return { child, exit };
}

async function waitUntil(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for race barrier");
}

function binding(overrides = {}) {
  return {
    ownerRootId: "root-1",
    agentId: "agent-1",
    jobId: "job-1",
    ...overrides,
  };
}

function instanceLease(overrides = {}) {
  return acquireInstanceLease({
    ...binding(),
    route: versionThreeRoute(),
    harnessId: V3_HARNESS_ID,
    instanceKey: V3_INSTANCE_KEY,
    capacityClass: "default",
    capacityLimit: 4,
    ...overrides,
  });
}

function writerLease(overrides = {}) {
  return acquireWorkspaceWriterLease({
    ...binding(),
    route: versionThreeRoute({ authority: "behavioral_write" }),
    workspaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), "cc-launch-claim-ws-")),
    ...overrides,
  });
}

/**
 * `leaseBindings` is deliberately lazy: `instanceLease()` has a real
 * side effect (it durably acquires a lease), so it must never run merely to
 * compute a default value a caller is about to override -- doing so would
 * silently plant a real matching lease behind an adversarial test's back.
 */
function claimInput(overrides = {}) {
  const base = {
    ...binding(),
    attemptId: "attempt-1",
    route: versionThreeRoute(),
    assignedMessageIds: ["message-1"],
    preparedInput: "hello world",
    // Explicitly stated, never defaulted inside production: this fixture's
    // route belongs to a Driver that owns no turn options.
    turnOptions: null,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "inspectionEvidence")) base.inspectionEvidence = inspectionEvidence(base.route);
  if (!("leaseBindings" in overrides)) base.leaseBindings = [instanceLease({ route: base.route })];
  return base;
}

function inspectionEvidence(route = versionThreeRoute()) {
  return { generation: "unavailable", capabilities: route.capabilities };
}

/**
 * The exact raw shape a Driver's `startTurn()` would return, before it is
 * ever passed through `validateLiveHarnessTurn()`. Used both to build a real
 * branded `liveHarnessTurn` (via `fakeLiveHarnessTurn()`) and, unbranded, as
 * the negative "raw/fresh reference" attack case.
 */
function rawFakeLiveTurnShape(overrides = {}) {
  return {
    nativeTurnRef: {
      version: 1, harnessId: V3_HARNESS_ID, driverVersion: V3_DRIVER_VERSION, instanceKey: V3_INSTANCE_KEY,
      locatorVersion: 1, locator: { sessionId: "s-1", turnId: "t-1" },
    },
    nativeSessionRef: {
      version: 1, harnessId: V3_HARNESS_ID, driverVersion: V3_DRIVER_VERSION, instanceKey: V3_INSTANCE_KEY,
      locatorVersion: 1, locator: { sessionId: "s-1" },
    },
    result: Promise.resolve({}),
    dispose: async () => {},
    requestInterrupt: async () => ({}),
    deliverActiveInput: async () => ({}),
    ...overrides,
  };
}

/** A genuinely branded `LiveHarnessTurn` wrapper: the only object `recordLaunchAcceptanceProven()` ever accepts. */
function fakeLiveHarnessTurn({ route = versionThreeRoute(), live = {} } = {}) {
  const { driver } = createFakeServiceDriver();
  return validateLiveHarnessTurn(rawFakeLiveTurnShape(live), { driver, route });
}

const RECORD_FIELDS = [
  "version", "ownerRootId", "agentId", "jobId", "attemptId",
  "lifecycleOwner",
  "route", "inspectionEvidence", "leaseState", "leaseIntent", "leaseBindings", "assignedMessageIds", "turnOptions", "inputDigest",
  "acceptance", "nativeTurnRef", "nativeSessionRef", "acceptanceEvidenceAt", "sanitizedDetail",
  "physicalResidency",
  "worker", "provisionalNativeTurnRef",
  "submissionState", "submissionStartedAt",
  "createdAt", "updatedAt",
];

function materializeLegacyVersionOne(record) {
  const currentDirectory = resolveLaunchClaimDirectory(record);
  const legacyDirectory = path.join(
    path.dirname(path.dirname(currentDirectory)),
    "v1",
    path.basename(currentDirectory),
  );
  const legacy = { ...record, version: 1 };
  delete legacy.leaseState;
  delete legacy.leaseIntent;
  delete legacy.turnOptions;
  delete legacy.lifecycleOwner;
  delete legacy.inspectionEvidence;
  delete legacy.physicalResidency;
  delete legacy.worker;
  delete legacy.provisionalNativeTurnRef;
  fs.rmSync(currentDirectory, { recursive: true, force: true });
  fs.mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
  const fileName = `${createHash("sha256").update(record.attemptId).digest("hex")}.json`;
  const filePath = path.join(legacyDirectory, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  return { legacy, filePath };
}

function materializeLegacyIncompleteWriter(record) {
  const filePath = path.join(
    resolveLaunchClaimDirectory(record),
    `${createHash("sha256").update(record.attemptId).digest("hex")}.json`,
  );
  const canonicalRoute = record.route;
  const routeDigest = createHash("sha256").update(JSON.stringify(canonicalRoute)).digest("hex");
  const projectReceipt = (receipt) => {
    const projected = { ...receipt, routeDigest };
    projected.evidenceDigest = createHash("sha256").update(JSON.stringify({
      kind: projected.kind,
      keyFields: projected.keyFields,
      capacity: projected.capacity,
      routeDigest,
      ownerRootId: projected.ownerRootId,
      agentId: projected.agentId,
      jobId: projected.jobId,
    })).digest("hex");
    return projected;
  };
  const legacy = {
    ...record,
    route: canonicalRoute,
    leaseIntent: record.leaseIntent.filter((receipt) => receipt.kind !== "writer").map(projectReceipt),
    leaseBindings: record.leaseBindings.filter((receipt) => receipt.kind !== "writer").map(projectReceipt),
  };
  delete legacy.controlRoot;
  delete legacy.executionRoot;
  delete legacy.lifecycleOwner;
  const bytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  fs.writeFileSync(filePath, bytes);
  return { filePath, bytes, legacy };
}

describe("launch claim: closed identity and durable binding", () => {
  it("creates a launch claim as not_submitted/not_started with no native turn/session reference", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    assert.equal(record.version, LAUNCH_CLAIM_SCHEMA_VERSION);
    assert.equal(record.ownerRootId, "root-1");
    assert.equal(record.agentId, "agent-1");
    assert.equal(record.jobId, "job-1");
    assert.equal(record.attemptId, "attempt-1");
    assert.deepEqual(record.route, versionThreeRoute());
    assert.deepEqual(record.assignedMessageIds, ["message-1"]);
    assert.equal(record.turnOptions, null);
    assert.match(record.inputDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(record.acceptance, "not_submitted");
    assert.equal(record.nativeTurnRef, null);
    assert.equal(record.nativeSessionRef, null);
    assert.equal(record.acceptanceEvidenceAt, null);
    assert.equal(record.sanitizedDetail, null);
    assert.equal(record.submissionState, "not_started");
    assert.equal(record.submissionStartedAt, null);
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);
    assert.equal(record.leaseBindings.length, 1);
    assert.equal(record.leaseBindings[0].kind, "instance");
    assert.deepEqual(Object.keys(record).sort(), [...RECORD_FIELDS].sort());
  });

  it("exposes exactly the closed acceptance and submission-state vocabularies", () => {
    assert.equal(LAUNCH_CLAIM_SCHEMA_VERSION, 3);
    assert.deepEqual(LAUNCH_ACCEPTANCE_VALUES, [
      "not_submitted", "acceptance_proven", "acceptance_rejected", "acceptance_unknown",
    ]);
    assert.deepEqual(SUBMISSION_STATES, [
      "not_started", "started", "rollback_in_progress", "rollback_complete",
    ]);
  });

  it("projects an immutable proven/started v1 record into v2 without changing legacy evidence", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const proven = recordLaunchAcceptanceProven({
      ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn(),
    });
    const { legacy, filePath } = materializeLegacyVersionOne(proven);

    const listed = listLaunchClaimsForOwnerRoot({ ownerRootId: "root-1" });
    assert.deepEqual(listed, [{
      ...legacy,
      version: 2,
      leaseState: "acquired",
      leaseIntent: legacy.leaseBindings,
    }]);
    assert.equal(fs.existsSync(resolveLaunchClaimDirectory(binding())), false);

    const migrated = readLaunchClaim(binding());
    assert.equal(migrated.version, 2);
    assert.equal(migrated.leaseState, "acquired");
    assert.deepEqual(migrated.leaseIntent, migrated.leaseBindings);
    for (const field of Object.keys(legacy)) {
      if (field !== "version") assert.deepEqual(migrated[field], legacy[field]);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), legacy);
    assert.equal(fs.existsSync(path.join(resolveLaunchClaimDirectory(binding()), path.basename(filePath))), false);
  });

  it("projects a rollback-eligible v1 record and keeps its exact timestamps", () => {
    setup();
    const prepared = createLaunchClaim(claimInput());
    const { legacy } = materializeLegacyVersionOne(prepared);
    const migrated = readLaunchClaim(binding());
    assert.equal(migrated.createdAt, legacy.createdAt);
    assert.equal(migrated.updatedAt, legacy.updatedAt);
    assert.equal(launchClaimRollbackEligibility(migrated).eligible, true);
  });

  it("reads a colliding evidence-less v1 identity but refuses a new evidence-bearing submission", () => {
    setup();
    const prepared = createLaunchClaim(claimInput());
    materializeLegacyVersionOne(prepared);
    assert.deepEqual(readLaunchClaim(binding()).route, prepared.route);
    assert.throws(() => createLaunchClaim(claimInput()), /identity mismatch/);
  });

  it("fails closed when valid v1 and v2 records disagree", () => {
    setup();
    const prepared = createLaunchClaim(claimInput());
    const { filePath } = materializeLegacyVersionOne(prepared);
    const currentDirectory = resolveLaunchClaimDirectory(binding());
    fs.mkdirSync(currentDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(currentDirectory, path.basename(filePath)),
      `${JSON.stringify({ ...prepared, sanitizedDetail: "conflicting_current_record" }, null, 2)}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => listLaunchClaimsForOwnerRoot({ ownerRootId: "root-1" }),
      /Legacy and current launch claims disagree/,
    );
    assert.throws(() => readLaunchClaim(binding()), /Current and historical launch claims overlap/);
  });

  it("round-trips a native v2 record without rewriting it", () => {
    setup();
    const created = createLaunchClaim(claimInput());
    assert.equal(created.version, 3);
    assert.deepEqual(readLaunchClaim(binding()), created);
  });

  it("reads a pre-writer-bundle v2 write claim byte-for-byte but refuses verify, replay, and submission", () => {
    setup();
    const route = versionThreeRoute({ authority: "behavioral_write" });
    const created = createLaunchClaim(claimInput({
      route,
      leaseBindings: [instanceLease({ route }), writerLease({ route })],
    }));
    const { filePath, bytes } = materializeLegacyIncompleteWriter(created);

    const readable = readLaunchClaim(binding());
    assert.equal(readable.route.authority, "behavioral_write");
    assert.deepEqual(readable.leaseBindings.map((receipt) => receipt.kind), ["instance"]);
    assert.deepEqual(fs.readFileSync(filePath), bytes);
    assert.throws(
      () => verifyPreparedLaunchClaim({
        ...binding(),
        attemptId: readable.attemptId,
        lifecycleOwner: "version_three_worker",
        route,
        assignedMessageIds: readable.assignedMessageIds,
        preparedInput: "hello world",
        turnOptions: null,
      }),
      (error) => error?.code === "legacy_incomplete_writer_authority",
    );
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: readable.attemptId }),
      (error) => error?.code === "legacy_incomplete_writer_authority",
    );
    assert.throws(
      () => createLaunchClaim(claimInput({
        route,
        leaseBindings: [instanceLease({ route })],
      })),
      (error) => error?.code === "legacy_incomplete_writer_authority",
    );
    assert.deepEqual(fs.readFileSync(filePath), bytes);
  });

  it("blocks only the unresolved legacy writer's authoritative execution root", () => {
    const { root } = setup();
    const route = versionThreeRoute({ authority: "behavioral_write" });
    createLaunchClaim(claimInput({
      route,
      leaseBindings: [instanceLease({ route }), writerLease({ route })],
    }));
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const proven = recordLaunchAcceptanceProven({
      ...binding(),
      attemptId: "attempt-1",
      liveHarnessTurn: fakeLiveHarnessTurn({ route }),
    });
    materializeLegacyIncompleteWriter(proven);
    const executionRoot = fs.mkdtempSync(path.join(root, "legacy-root-"));
    const otherRoot = fs.mkdtempSync(path.join(root, "other-root-"));
    recordVersionThreeTurnRunning({
      generation: FUTURE_WRITE_GENERATION,
      ...binding(),
      attemptId: "attempt-1",
      workspaceRoot: executionRoot,
      route,
      nativeTurnRef: proven.nativeTurnRef,
    });
    recordVersionThreeTurnUncertain({
      generation: FUTURE_WRITE_GENERATION,
      ...binding(),
      attemptId: "attempt-1",
      reason: "worker_lost",
    });

    assert.throws(
      () => acquireWorkspaceWriterLease({
        ownerRootId: "root-2",
        agentId: "agent-2",
        jobId: "job-2",
        route: versionThreeRoute({
          authority: "behavioral_write",
          instanceKey: "writer-contender",
        }),
        workspaceRoot: executionRoot,
      }),
      (error) => error?.code === "legacy_writer_authority_unsettled",
    );
    assert.equal(acquireWorkspaceWriterLease({
      ownerRootId: "root-3",
      agentId: "agent-3",
      jobId: "job-3",
      route: versionThreeRoute({
        authority: "behavioral_write",
        instanceKey: "other-root-writer",
      }),
      workspaceRoot: otherRoot,
    }).kind, "writer");
    assert.equal(acquireInstanceLease({
      ownerRootId: "root-4",
      agentId: "agent-4",
      jobId: "job-4",
      route: versionThreeRoute({ instanceKey: "read-only-contender" }),
      harnessId: V3_HARNESS_ID,
      instanceKey: "read-only-contender",
      capacityClass: "legacy-writer-read-only",
      capacityLimit: 1,
    }).kind, "instance");
  });

  it("persists the complete write lease bundle before acquisition and refuses partial binding", () => {
    setup();
    const route = versionThreeRoute({ authority: "behavioral_write" });
    const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-launch-intent-ws-"));
    const intent = createLaunchIntent({
      ...binding(),
      attemptId: "attempt-1",
      lifecycleOwner: "version_three_worker",
      route,
      expectedLeases: [
        { kind: "instance", capacityClass: "default", capacityLimit: 4 },
        { kind: "writer", workspaceRoot: executionRoot },
      ],
      assignedMessageIds: ["message-1"],
      preparedInput: "hello world",
      turnOptions: null,
      inspectionEvidence: inspectionEvidence(),
    });
    assert.equal(intent.leaseState, "intended");
    assert.equal(intent.leaseBindings.length, 0);
    assert.equal(intent.leaseIntent[0].capacity.class, "default");
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" }),
      /acquired lease proof/,
    );

    const acquired = bindLaunchClaimLeases({
      ...binding(),
      attemptId: "attempt-1",
      leases: [instanceLease({ route }), writerLease({ route, workspaceRoot: executionRoot })],
    });
    assert.equal(acquired.leaseState, "acquired");
    assert.deepEqual(acquired.leaseBindings, acquired.leaseIntent);
  });

  it("retains current v3 inspection evidence when the owning runtime provides it", () => {
    setup();
    const input = {
      ...binding(),
      attemptId: "attempt-1",
      lifecycleOwner: "version_three_worker",
      route: versionThreeRoute(),
      expectedLease: { kind: "instance", capacityClass: "default", capacityLimit: 4 },
      assignedMessageIds: ["message-1"],
      preparedInput: "hello world",
      turnOptions: null,
    };
    assert.throws(() => createLaunchIntent(input), /requires complete current inspectionEvidence/);
    const created = createLaunchIntent({ ...input, inspectionEvidence: inspectionEvidence(input.route) });
    assert.deepEqual(created.inspectionEvidence, inspectionEvidence(input.route));
    assert.throws(
      () => createLaunchIntent({
        ...input,
        inspectionEvidence: { generation: "unavailable", capabilities: {
          ...input.route.capabilities,
          provenance: { ...input.route.capabilities.provenance, history: "inspection_proven" },
        } },
      }),
      /capabilities do not exactly match/,
    );
  });

  it("refuses omitted evidence from both new-claim APIs before a claim file exists", () => {
    setup();
    const createInput = claimInput();
    delete createInput.inspectionEvidence;
    assert.throws(() => createLaunchClaim(createInput), /requires complete current inspectionEvidence/);
    assert.equal(readLaunchClaim(binding()), null);
    assert.throws(() => createLaunchIntent({
      ...binding(), attemptId: "attempt-intent", route: versionThreeRoute(),
      expectedLease: { kind: "instance", capacityClass: "default", capacityLimit: 4 },
      assignedMessageIds: ["message-intent"], preparedInput: "hello", turnOptions: null,
    }), /requires complete current inspectionEvidence/);
    assert.equal(readLaunchClaim({ ...binding(), jobId: "job-1" }), null);
  });

  it("keeps an old evidence-less claim readable for rollback but fences it before submission", () => {
    setup();
    const created = createLaunchClaim(claimInput());
    const [fileName] = fs.readdirSync(resolveLaunchClaimDirectory(created)).filter((entry) => entry.endsWith(".json"));
    const filePath = path.join(resolveLaunchClaimDirectory(created), fileName);
    const historical = JSON.parse(fs.readFileSync(filePath, "utf8"));
    delete historical.inspectionEvidence;
    fs.writeFileSync(filePath, JSON.stringify(historical));
    assert.equal(readLaunchClaim(binding()).inspectionEvidence, undefined);
    assert.throws(() => verifyPreparedLaunchClaim({
      ...binding(), attemptId: created.attemptId, route: created.route,
      assignedMessageIds: created.assignedMessageIds, preparedInput: "hello world", turnOptions: null,
    }), /evidence-less historical launch claim/);
  });

  it("acquires only while the exact durable intent is still rollback-safe", () => {
    setup();
    const route = versionThreeRoute();
    const expectedLease = { kind: "instance", capacityClass: "default", capacityLimit: 4 };
    const intent = createLaunchIntent({
      ...binding(), attemptId: "attempt-1", lifecycleOwner: "version_three_worker", route, expectedLease,
      assignedMessageIds: ["message-1"], preparedInput: "hello world", turnOptions: null,
      inspectionEvidence: inspectionEvidence(route),
    });
    const lease = acquireIntendedInstanceLease({
      ...binding(), attemptId: "attempt-1", route,
      harnessId: route.harnessId, instanceKey: route.instanceKey,
      capacityClass: "default", capacityLimit: 4,
    });
    assert.equal(bindLaunchClaimLease({ ...binding(), attemptId: "attempt-1", lease }).leaseState, "acquired");

    const eligible = launchClaimRollbackEligibility(readLaunchClaim(binding()));
    beginPreSubmissionRollback({ ...binding(), token: eligible.token });
    assert.throws(
      () => acquireIntendedInstanceLease({
        ...binding(), attemptId: "attempt-1", route,
        harnessId: route.harnessId, instanceKey: route.instanceKey,
        capacityClass: "default", capacityLimit: 4,
      }),
      /launch intent|rollback|not_started/,
    );
    assert.equal(intent.leaseState, "intended");
  });

  it("is idempotent for a repeated identical create call", () => {
    setup();
    const first = createLaunchClaim(claimInput());
    const second = createLaunchClaim(claimInput());
    assert.deepEqual(first, second);
  });

  it("fails closed when a different attempt tries to claim a job that already has a launch claim", () => {
    setup();
    const original = createLaunchClaim(claimInput());
    assert.throws(
      () => createLaunchClaim(claimInput({ attemptId: "attempt-2" })),
      /already claimed by a different attempt/
    );
    assert.deepEqual(readLaunchClaim(binding()), original);
  });

  it("fails closed on conflicting reuse of the same attemptId with a different route, without rewriting the stored record", () => {
    setup();
    const original = createLaunchClaim(claimInput());
    const differentRoute = versionThreeRoute({ model: "a-different-model" });
    assert.throws(
      () => createLaunchClaim(claimInput({ route: differentRoute, leaseBindings: [instanceLease({ route: differentRoute })] })),
      /identity mismatch/
    );
    assert.deepEqual(readLaunchClaim(binding()), original);
  });

  it("returns null for a job that has no launch claim yet", () => {
    setup();
    assert.equal(readLaunchClaim(binding()), null);
  });

  it("isolates distinct jobs: a different jobId never resolves another job's claim", () => {
    setup();
    createLaunchClaim(claimInput());
    assert.equal(readLaunchClaim(binding({ jobId: "job-2" })), null);
  });

  it("isolates distinct owner roots even for the same agentId/jobId text", () => {
    setup();
    createLaunchClaim(claimInput());
    assert.equal(readLaunchClaim(binding({ ownerRootId: "root-2" })), null);
  });
});

describe("launch claim: lease binding authority is Task 4's brand-gated acquisition evidence, never a caller's claim", () => {
  it("accepts a real acquired instance lease and projects kind/keyFields/capacity/routeDigest/holder/evidenceDigest", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const [receipt] = record.leaseBindings;
    assert.deepEqual(
      Object.keys(receipt).sort(),
      ["kind", "keyFields", "capacity", "routeDigest", "ownerRootId", "agentId", "jobId", "evidenceDigest"].sort()
    );
    assert.equal(receipt.kind, "instance");
    assert.deepEqual(receipt.keyFields, { harnessId: V3_HARNESS_ID, instanceKey: V3_INSTANCE_KEY });
    assert.deepEqual(receipt.capacity, { class: "default", limit: 4 });
    assert.match(receipt.routeDigest, /^[0-9a-f]{64}$/);
    assert.equal(receipt.ownerRootId, "root-1");
    assert.match(receipt.evidenceDigest, /^[0-9a-f]{64}$/);
  });

  it("accepts multiple distinct-kind lease bindings (instance plus writer)", () => {
    setup();
    const writeRoute = versionThreeRoute({ authority: "behavioral_write" });
    const record = createLaunchClaim(claimInput({
      route: writeRoute,
      leaseBindings: [instanceLease({ route: writeRoute }), writerLease({ route: writeRoute })],
    }));
    const kinds = record.leaseBindings.map((entry) => entry.kind).sort();
    assert.deepEqual(kinds, ["instance", "writer"]);
  });

  it("rejects an empty leaseBindings array: a launch claim always binds at least one authority lease", () => {
    setup();
    assert.throws(() => createLaunchClaim(claimInput({ leaseBindings: [] })), /at least one/);
  });

  it("rejects two lease bindings of the same kind", () => {
    setup();
    const second = instanceLease({ jobId: "job-1", capacityClass: "default" });
    assert.throws(
      () => createLaunchClaim(claimInput({ leaseBindings: [instanceLease(), second] })),
      /more than one/
    );
  });

  it("is byte-identical across an idempotent re-acquire of the same real lease, even though a new object reference is returned each time", () => {
    setup();
    const first = instanceLease();
    const original = createLaunchClaim(claimInput({ leaseBindings: [first] }));
    const second = instanceLease();
    assert.notEqual(first, second, "expected a freshly re-validated object reference, not the identical one");
    const replay = createLaunchClaim(claimInput({ leaseBindings: [second] }));
    assert.deepEqual(replay, original);
  });

  it("REVIEWER ATTACK -- a workspace-A writer lease conflicts with a launch claim expecting workspace B (distinct keyFields)", () => {
    setup();
    const writeRoute = versionThreeRoute({ authority: "behavioral_write" });
    const leaseForA = writerLease({ route: writeRoute });
    const record = createLaunchClaim(claimInput({ route: writeRoute, leaseBindings: [instanceLease({ route: writeRoute }), leaseForA] }));
    const writerReceipt = record.leaseBindings.find((entry) => entry.kind === "writer");
    const evidenceA = acquiredLeaseEvidence(leaseForA);
    assert.equal(writerReceipt.keyFields.workspaceRoot, evidenceA.keyFields.workspaceRoot);
    // Recreating the same attemptId with a lease for a *different* workspace fails closed.
    const leaseForB = writerLease({ route: writeRoute });
    assert.throws(
      () => createLaunchClaim(claimInput({
        route: writeRoute, leaseBindings: [instanceLease({ route: writeRoute }), leaseForB],
      })),
      /identity mismatch/
    );
  });

  it("REVIEWER ATTACK -- a native_session lease for REAL conflicts with one for GHOST on replay", () => {
    setup();
    const real = nativeSessionLease("REAL-session");
    createLaunchClaim(claimInput({ leaseBindings: [real] }));
    const ghost = nativeSessionLease("GHOST-session");
    assert.throws(
      () => createLaunchClaim(claimInput({ leaseBindings: [ghost] })),
      /identity mismatch/
    );
  });

  it("REVIEWER ATTACK -- capability-snapshot drift between two otherwise-identical routes conflicts", () => {
    setup();
    const routeA = versionThreeRoute();
    const routeADrifted = versionThreeRoute({
      capabilities: { ...routeA.capabilities, driverMaturity: "validated" },
    });
    createLaunchClaim(claimInput({ route: routeA, leaseBindings: [instanceLease({ route: routeA })] }));
    assert.throws(
      () => createLaunchClaim(claimInput({
        route: routeADrifted, leaseBindings: [instanceLease({ route: routeADrifted })],
      })),
      /identity mismatch/
    );
  });

  it("REVIEWER ATTACK -- rejects a structurally identical clone of a real lease record (fails at the Task 4 brand seam)", () => {
    setup();
    const real = instanceLease();
    const clone = JSON.parse(JSON.stringify(real));
    assert.throws(() => createLaunchClaim(claimInput({ leaseBindings: [clone] })), /exact object reference/);
  });

  it("REVIEWER ATTACK -- rejects a same-identity forged lease-shaped object, never really acquired, stating the exact correct route", () => {
    setup();
    const evidence = acquiredLeaseEvidence(instanceLease());
    const forged = { ...evidence };
    assert.throws(() => createLaunchClaim(claimInput({ leaseBindings: [forged] })), /exact object reference/);
  });

  it("REVIEWER ATTACK -- rejects a Proxy wrapping a real acquired lease record, invoking zero traps", () => {
    setup();
    const real = instanceLease();
    let trapped = false;
    const proxy = new Proxy(real, { get(t, p, r) { trapped = true; return Reflect.get(t, p, r); } });
    assert.throws(() => createLaunchClaim(claimInput({ leaseBindings: [proxy] })), /exact object reference/);
    assert.equal(trapped, false);
  });

  it("rejects a lease genuinely acquired under a foreign owner root/Agent/job", () => {
    setup();
    const foreign = instanceLease({ ownerRootId: "root-9", agentId: "agent-9", jobId: "job-9" });
    assert.throws(() => createLaunchClaim(claimInput({ leaseBindings: [foreign] })), /foreign owner root/);
  });
});

function nativeSessionLease(nativeSessionId, overrides = {}) {
  return acquireNativeSessionLease({
    ...binding(), route: versionThreeRoute(), harnessId: V3_HARNESS_ID, instanceKey: V3_INSTANCE_KEY, nativeSessionId,
    ...overrides,
  });
}

describe("launch claim: bounded, ordered, deduplicated mailbox activation identity and module-owned digest", () => {
  it("rejects a create input carrying a caller-supplied inputDigest field (closed field set)", () => {
    setup();
    assert.throws(
      () => createLaunchClaim({ ...claimInput(), inputDigest: `sha256:${"a".repeat(64)}` }),
      /unsupported field|unknown field/
    );
  });

  it("persists no prompt/input content: assignedMessageIds and inputDigest are the only input-shaped fields, and preparedInput never appears", () => {
    setup();
    const record = createLaunchClaim(claimInput({ preparedInput: "a very specific secret prompt payload" }));
    assert.deepEqual(Object.keys(record).sort(), [...RECORD_FIELDS].sort());
    assert.doesNotMatch(JSON.stringify(record), /secret prompt payload/);
  });

  it("rejects an empty assignedMessageIds array", () => {
    setup();
    assert.throws(() => createLaunchClaim(claimInput({ assignedMessageIds: [] })), /at least one/);
  });

  it("rejects a duplicate message identity", () => {
    setup();
    assert.throws(
      () => createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-1"] })),
      /duplicate message identity/
    );
  });

  it("rejects more than MAX_ASSIGNED_MESSAGE_IDS entries", () => {
    setup();
    const tooMany = Array.from({ length: MAX_ASSIGNED_MESSAGE_IDS + 1 }, (_, index) => `message-${index}`);
    assert.throws(() => createLaunchClaim(claimInput({ assignedMessageIds: tooMany })), /exceeds its durable bound/);
  });

  it("persists all ids for a genuine multi-message activation, in order", () => {
    setup();
    const record = createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-2", "message-3"] }));
    assert.deepEqual(record.assignedMessageIds, ["message-1", "message-2", "message-3"]);
  });

  it("order matters: the same set of ids in a different order produces a different digest and is a conflicting replay", () => {
    setup();
    createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-2"] }));
    assert.throws(
      () => createLaunchClaim(claimInput({ assignedMessageIds: ["message-2", "message-1"] })),
      /identity mismatch/
    );
  });

  it("exact replay (same ids, same order, same prepared input) agrees", () => {
    setup();
    const first = createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-2"], preparedInput: "same text" }));
    const second = createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-2"], preparedInput: "same text" }));
    assert.deepEqual(first, second);
  });

  it("changing one message id conflicts with the stored claim", () => {
    setup();
    createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-2"] }));
    assert.throws(
      () => createLaunchClaim(claimInput({ assignedMessageIds: ["message-1", "message-3"] })),
      /identity mismatch/
    );
  });

  it("changing the prepared input text (same ids) conflicts with the stored claim", () => {
    setup();
    createLaunchClaim(claimInput({ preparedInput: "original text" }));
    assert.throws(
      () => createLaunchClaim(claimInput({ preparedInput: "a completely different text" })),
      /identity mismatch/
    );
  });

  it("rejects a missing/empty preparedInput", () => {
    setup();
    assert.throws(() => createLaunchClaim(claimInput({ preparedInput: "" })), /non-empty text/);
    assert.throws(() => createLaunchClaim(claimInput({ preparedInput: null })), /non-empty text/);
  });

  it("hashes realistic opaque prepared input byte-for-byte without persisting it", () => {
    for (const preparedInput of [
      ["first message", "second message"].join("\n\n"),
      "```js\nconsole.log('ok');\n```",
      "column-1\tcolumn-2",
      "x".repeat(70 * 1024),
    ]) {
      setup();
      const record = createLaunchClaim(claimInput({
        assignedMessageIds: ["message-1", "message-2"],
        preparedInput,
      }));
      assert.match(record.inputDigest, /^sha256:[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(record), /first message|console\.log|column-1/);
    }
  });
});

describe("launch claim: malformed and exotic fields fail closed", () => {
  it("refuses a Proxy route", () => {
    setup();
    const proxyRoute = new Proxy(versionThreeRoute(), {});
    assert.throws(() => createLaunchClaim(claimInput({ route: proxyRoute })), /Proxy/);
  });

  it("refuses an unstable-identity attemptId", () => {
    setup();
    assert.throws(() => createLaunchClaim(claimInput({ attemptId: "attempt​1" })), /control or format characters/);
  });

  it("refuses a caller-supplied acceptance-shaped field on create (closed field set)", () => {
    setup();
    assert.throws(
      () => createLaunchClaim({ ...claimInput(), acceptance: "acceptance_proven" }),
      /unsupported field|unknown field/
    );
  });

  it("BRAND-SEAM ATTACK: a raw, never-branded liveHarnessTurn -- structurally valid and route-correct -- can never prove acceptance", () => {
    setup();
    createLaunchClaim(claimInput());
    const rawUnbranded = rawFakeLiveTurnShape();
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: rawUnbranded }),
      /requires the exact wrapper validateLiveHarnessTurn\(\) returned/
    );
    assert.equal(readLaunchClaim(binding()).acceptance, "not_submitted");
  });

  it("refuses a now-shaped field on any mutation recorder: there is no caller-injectable clock", () => {
    setup();
    createLaunchClaim(claimInput());
    assert.throws(
      () => recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1", now: () => 0 }),
      /unsupported field|unknown field/
    );
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1", now: () => 0 }),
      /unsupported field|unknown field/
    );
  });
});

describe("launch claim: corrupt and partial durable records", () => {
  function claimFilePath() {
    const dir = resolveLaunchClaimDirectory(binding());
    const [fileName] = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
    return path.join(dir, fileName);
  }

  it("reads a pre-effort launch claim but refuses every activation mutation", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    const { effort: _effort, ...legacyRoute } = record.route;
    const routeDigest = createHash("sha256").update(JSON.stringify(legacyRoute)).digest("hex");
    const legacyReceipt = (receipt) => {
      const updated = { ...receipt, routeDigest };
      updated.evidenceDigest = createHash("sha256").update(JSON.stringify({
        kind: updated.kind,
        keyFields: updated.keyFields,
        capacity: updated.capacity,
        routeDigest,
        ownerRootId: updated.ownerRootId,
        agentId: updated.agentId,
        jobId: updated.jobId,
      })).digest("hex");
      return updated;
    };
    const legacy = {
      ...record,
      route: legacyRoute,
      leaseIntent: record.leaseIntent.map(legacyReceipt),
      leaseBindings: record.leaseBindings.map(legacyReceipt),
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    assert.equal(Object.hasOwn(readLaunchClaim(binding()).route, "effort"), false);
    const bytes = fs.readFileSync(filePath);
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" }),
      /explicit.*effort/i,
    );
    assert.deepEqual(fs.readFileSync(filePath), bytes);
  });

  it("fails closed on invalid JSON without deleting the file", () => {
    setup();
    createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    const originalBytes = fs.readFileSync(filePath);
    fs.writeFileSync(filePath, "not json");
    assert.throws(() => readLaunchClaim(binding()), /corrupt/);
    assert.deepEqual(fs.readFileSync(filePath), Buffer.from("not json"));
    fs.writeFileSync(filePath, originalBytes);
  });

  it("fails closed on an unsupported schema version", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ ...record, version: 99 }));
    assert.throws(() => readLaunchClaim(binding()), /unsupported schema version/);
  });

  it("fails closed on an identity-drifted (hand-copied) record", () => {
    setup();
    createLaunchClaim(claimInput());
    const dir = resolveLaunchClaimDirectory(binding());
    const [fileName] = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
    const content = fs.readFileSync(path.join(dir, fileName), "utf8");
    fs.writeFileSync(path.join(dir, "hand-placed.json"), content);
    assert.throws(() => readLaunchClaim(binding()), /does not live at the directory\/filename its own identity derives/);
  });

  it("fails closed on a tampered lease receipt whose evidenceDigest disagrees with its own stated fields", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    const tampered = { ...record };
    tampered.leaseBindings = [{ ...record.leaseBindings[0], capacity: { class: "default", limit: 999 } }];
    fs.writeFileSync(filePath, JSON.stringify(tampered));
    assert.throws(() => readLaunchClaim(binding()), /possible tamper/);
  });

  it("fails closed when a self-consistent lease receipt names a foreign route digest", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    const receipt = { ...record.leaseBindings[0], routeDigest: "f".repeat(64) };
    receipt.evidenceDigest = createHash("sha256").update(JSON.stringify({
      kind: receipt.kind,
      keyFields: receipt.keyFields,
      capacity: receipt.capacity,
      routeDigest: receipt.routeDigest,
      ownerRootId: receipt.ownerRootId,
      agentId: receipt.agentId,
      jobId: receipt.jobId,
    })).digest("hex");
    fs.writeFileSync(filePath, JSON.stringify({ ...record, leaseBindings: [receipt] }));
    assert.throws(() => readLaunchClaim(binding()), /route digest does not match/);
  });

  it("fails closed on a tampered record claiming acceptance_proven with no native turn reference", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    fs.writeFileSync(filePath, JSON.stringify({
      ...record, acceptance: "acceptance_proven", acceptanceEvidenceAt: record.createdAt,
    }));
    assert.throws(() => readLaunchClaim(binding()), /acceptance_proven requires an exact canonical native turn reference/);
  });

  it("fails closed on a tampered record claiming submissionState started with no submissionStartedAt", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ ...record, submissionState: "started" }));
    assert.throws(() => readLaunchClaim(binding()), /started requires a submission-started timestamp/);
  });

  it("fails closed on a tampered record claiming submissionState not_started while carrying a submissionStartedAt", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const filePath = claimFilePath();
    const started = JSON.parse(fs.readFileSync(filePath, "utf8"));
    fs.writeFileSync(filePath, JSON.stringify({ ...started, submissionState: "not_started" }));
    assert.throws(() => readLaunchClaim(binding()), /not_started must not carry a submission-started timestamp/);
  });

  it("fails closed on a tampered record whose updatedAt precedes createdAt", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const filePath = claimFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ ...record, updatedAt: "2000-01-01T00:00:00.000Z" }));
    assert.throws(() => readLaunchClaim(binding()), /updatedAt must not precede createdAt/);
  });

  it("fails closed on a tampered record whose submissionStartedAt precedes createdAt", () => {
    setup();
    createLaunchClaim(claimInput());
    const started = markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const filePath = claimFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ ...started, submissionStartedAt: "2000-01-01T00:00:00.000Z" }));
    assert.throws(() => readLaunchClaim(binding()), /submissionStartedAt must not precede createdAt/);
  });

  it("fails closed on a tampered record whose submissionStartedAt follows acceptanceEvidenceAt", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const proven = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    const filePath = claimFilePath();
    const futureSubmission = new Date(Date.parse(proven.acceptanceEvidenceAt) + 60_000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({ ...proven, submissionStartedAt: futureSubmission }));
    assert.throws(() => readLaunchClaim(binding()), /submissionStartedAt must not follow acceptanceEvidenceAt/);
  });
});

describe("launch claim: pre-submission fence (markNativeSubmissionStarted)", () => {
  it("binds one exact physical receipt only after the submission fence and rejects route or receipt drift", async () => {
    setup();
    const claim = createLaunchClaim(claimInput());
    const physicalResidency = { kind: "local_process", pid: 7, identity: "123" };
    const worker = { pid: process.pid, identity: getProcessIdentity(process.pid) };
    const provisionalNativeTurnRef = {
      version: 1, harnessId: claim.route.harnessId, driverVersion: claim.route.driverVersion,
      instanceKey: claim.route.instanceKey, locatorVersion: 1, locator: { sessionId: "s-1", turnId: "t-1" },
    };
    await assert.rejects(
      bindLaunchClaimPhysicalResidencyAsync({ ...binding(), attemptId: claim.attemptId, route: claim.route, physicalResidency, worker, provisionalNativeTurnRef }),
      (error) => error.code === "binding_too_late",
    );
    await claimNativeSubmissionStartAsync({ ...binding(), attemptId: claim.attemptId });
    const bound = await bindLaunchClaimPhysicalResidencyAsync({ ...binding(), attemptId: claim.attemptId, route: claim.route, physicalResidency, worker, provisionalNativeTurnRef });
    assert.deepEqual(bound.physicalResidency, physicalResidency);
    await assert.rejects(
      bindLaunchClaimPhysicalResidencyAsync({ ...binding(), attemptId: claim.attemptId, route: { ...claim.route, instanceKey: "other" }, physicalResidency, worker, provisionalNativeTurnRef }),
      (error) => error.code === "route_mismatch",
    );
    await assert.rejects(
      bindLaunchClaimPhysicalResidencyAsync({ ...binding(), attemptId: claim.attemptId, route: claim.route, physicalResidency: { kind: "local_process", pid: 8, identity: "456" }, worker, provisionalNativeTurnRef }),
      (error) => error.code === "residency_mismatch",
    );
  });

  it("refuses acceptance whose final native turn differs from the durably bound provisional lineage", async () => {
    setup();
    const claim = createLaunchClaim(claimInput());
    await claimNativeSubmissionStartAsync({ ...binding(), attemptId: claim.attemptId });
    const first = fakeLiveHarnessTurn({ route: claim.route });
    await bindLaunchClaimPhysicalResidencyAsync({
      ...binding(), attemptId: claim.attemptId, route: claim.route,
      physicalResidency: { kind: "local_process", pid: 7, identity: "123" },
      worker: { pid: process.pid, identity: getProcessIdentity(process.pid) },
      provisionalNativeTurnRef: first.nativeTurnRef,
    });
    const second = fakeLiveHarnessTurn({ route: claim.route, live: {
      nativeTurnRef: { ...first.nativeTurnRef, locator: { sessionId: "s-2", turnId: "t-2" } },
    } });
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding(), attemptId: claim.attemptId, liveHarnessTurn: second }),
      (error) => error.code === "provisional_native_turn_mismatch",
    );
  });

  it("moves not_started to started with a real timestamp", () => {
    setup();
    createLaunchClaim(claimInput());
    const started = markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    assert.equal(started.submissionState, "started");
    assert.ok(started.submissionStartedAt);
    assert.equal(started.acceptance, "not_submitted");
  });

  it("is idempotent for an exact replay: submissionStartedAt never moves forward", () => {
    setup();
    createLaunchClaim(claimInput());
    const first = markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const second = markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    assert.deepEqual(first, second);
  });

  it("refuses a wrong-attempt call", () => {
    setup();
    createLaunchClaim(claimInput());
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-2" }),
      /wrong attempt|attemptId/
    );
  });

  it("refuses to start submission once acceptance has already been recorded (out-of-order call)", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" });
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" }),
      /refuses to start submission after acceptance has already been recorded/
    );
  });

  it("has no regression path: there is no exported function that moves started back to not_started", async () => {
    const moduleExports = await import("../../runtime/launch-claim.mjs");
    assert.equal(moduleExports.markNativeSubmissionNotStarted, undefined);
    assert.equal(moduleExports.resetSubmissionState, undefined);
  });
});

describe("launch claim: acceptance state machine", () => {
  it("records acceptance_rejected from not_submitted with an evidence timestamp", () => {
    setup();
    createLaunchClaim(claimInput());
    const updated = recordLaunchAcceptanceRejected({
      ...binding(), attemptId: "attempt-1", sanitizedDetail: "auth_failed",
    });
    assert.equal(updated.acceptance, "acceptance_rejected");
    assert.equal(updated.nativeTurnRef, null);
    assert.equal(updated.nativeSessionRef, null);
    assert.ok(updated.acceptanceEvidenceAt);
    assert.equal(updated.sanitizedDetail, "auth_failed");
  });

  it("records acceptance_rejected even after submission has started", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const rejected = recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" });
    assert.equal(rejected.acceptance, "acceptance_rejected");
    assert.equal(rejected.submissionState, "started");
  });

  it("records acceptance_unknown from not_submitted with an evidence timestamp and no native turn/session reference", () => {
    setup();
    createLaunchClaim(claimInput());
    const updated = recordLaunchAcceptanceUnknown({
      ...binding(), attemptId: "attempt-1", sanitizedDetail: "worker_disappeared",
    });
    assert.equal(updated.acceptance, "acceptance_unknown");
    assert.equal(updated.nativeTurnRef, null);
    assert.equal(updated.nativeSessionRef, null);
    assert.ok(updated.acceptanceEvidenceAt);
  });

  it("records acceptance_proven from not_submitted via durableTurnEvidence(), with turn and session references both persisted", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const updated = recordLaunchAcceptanceProven({
      ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn(),
    });
    assert.equal(updated.acceptance, "acceptance_proven");
    assert.deepEqual(updated.nativeTurnRef.locator, { sessionId: "s-1", turnId: "t-1" });
    assert.deepEqual(updated.nativeSessionRef.locator, { sessionId: "s-1" });
    assert.ok(updated.acceptanceEvidenceAt);
  });

  it("records acceptance_proven with a null nativeSessionRef when the live turn carries none", () => {
    setup();
    createLaunchClaim(claimInput());
    const updated = recordLaunchAcceptanceProven({
      ...binding(), attemptId: "attempt-1",
      liveHarnessTurn: fakeLiveHarnessTurn({ live: { nativeSessionRef: null } }),
    });
    assert.equal(updated.acceptance, "acceptance_proven");
    assert.equal(updated.nativeSessionRef, null);
  });

  it("promotes acceptance_unknown to acceptance_proven when exact later proof arrives", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceUnknown({ ...binding(), attemptId: "attempt-1" });
    const updated = recordLaunchAcceptanceProven({
      ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn(),
    });
    assert.equal(updated.acceptance, "acceptance_proven");
  });

  it("never regresses acceptance_proven to acceptance_unknown, acceptance_rejected, or not_submitted", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    assert.throws(
      () => recordLaunchAcceptanceUnknown({ ...binding(), attemptId: "attempt-1" }),
      /conflicting acceptance transition/
    );
    assert.throws(
      () => recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" }),
      /conflicting acceptance transition/
    );
  });

  it("never regresses acceptance_unknown to not_submitted or acceptance_rejected", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceUnknown({ ...binding(), attemptId: "attempt-1" });
    assert.throws(
      () => recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" }),
      /conflicting acceptance transition/
    );
  });

  it("never allows acceptance_rejected to transition to acceptance_unknown or acceptance_proven: rejected is terminal", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" });
    assert.throws(
      () => recordLaunchAcceptanceUnknown({ ...binding(), attemptId: "attempt-1" }),
      /conflicting acceptance transition/
    );
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() }),
      /conflicting acceptance transition/
    );
  });

  it("is idempotent for a repeated identical acceptance_proven call with the exact same native turn reference", () => {
    setup();
    createLaunchClaim(claimInput());
    const first = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    const second = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    assert.deepEqual(first, second);
  });

  it("never silently replaces an already-proven attempt's native turn reference", () => {
    setup();
    createLaunchClaim(claimInput());
    recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    const differentTurn = fakeLiveHarnessTurn({
      live: {
        nativeTurnRef: {
          version: 1, harnessId: V3_HARNESS_ID, driverVersion: V3_DRIVER_VERSION, instanceKey: V3_INSTANCE_KEY,
          locatorVersion: 1, locator: { sessionId: "s-1", turnId: "a-different-turn" },
        },
      },
    });
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: differentTurn }),
      /conflicting acceptance transition|already proven/
    );
  });

  it("refuses a native turn reference whose Harness/instance does not match the bound route", () => {
    setup();
    createLaunchClaim(claimInput());
    const { driver: otherDriver } = createFakeServiceDriver({ harnessId: "other-harness", driverVersion: "other-harness@1" });
    const otherRoute = versionThreeRoute({ harnessId: "other-harness", driverVersion: "other-harness@1" });
    const foreignHarnessTurn = validateLiveHarnessTurn(
      rawFakeLiveTurnShape({
        nativeTurnRef: {
          version: 1, harnessId: "other-harness", driverVersion: "other-harness@1", instanceKey: V3_INSTANCE_KEY,
          locatorVersion: 1, locator: { sessionId: "s-1", turnId: "t-1" },
        },
        nativeSessionRef: {
          version: 1, harnessId: "other-harness", driverVersion: "other-harness@1", instanceKey: V3_INSTANCE_KEY,
          locatorVersion: 1, locator: { sessionId: "s-1" },
        },
      }),
      { driver: otherDriver, route: otherRoute }
    );
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: foreignHarnessTurn }),
      /does not match its bound route/
    );
  });

  it("refuses a wrong-attempt call: only the exact winning attemptId may record this claim's acceptance", () => {
    setup();
    createLaunchClaim(claimInput());
    assert.throws(
      () => recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-2" }),
      /wrong attempt|attemptId/
    );
  });
});

describe("launch claim: native-turn live uniqueness (process-local WeakMap)", () => {
  it("REVIEWER ATTACK -- the exact same validated liveHarnessTurn wrapper reused for a different claim/job is refused", () => {
    setup();
    createLaunchClaim(claimInput({ jobId: "job-1", leaseBindings: [instanceLease({ jobId: "job-1" })] }));
    createLaunchClaim(claimInput({ jobId: "job-2", leaseBindings: [instanceLease({ jobId: "job-2" })] }));
    const sharedWrapper = fakeLiveHarnessTurn();
    const first = recordLaunchAcceptanceProven({
      ...binding({ jobId: "job-1" }), attemptId: "attempt-1", liveHarnessTurn: sharedWrapper,
    });
    assert.equal(first.acceptance, "acceptance_proven");
    assert.throws(
      () => recordLaunchAcceptanceProven({ ...binding({ jobId: "job-2" }), attemptId: "attempt-1", liveHarnessTurn: sharedWrapper }),
      /already bound to a different launch claim/
    );
    // The second job's claim must remain untouched.
    assert.equal(readLaunchClaim(binding({ jobId: "job-2" })).acceptance, "not_submitted");
  });

  it("allows idempotent same-claim replay of the exact same wrapper", () => {
    setup();
    createLaunchClaim(claimInput());
    const wrapper = fakeLiveHarnessTurn();
    const first = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: wrapper });
    const second = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: wrapper });
    assert.deepEqual(first, second);
  });
});

describe("launch claim: pre-submission rollback eligibility, gated on submissionState, with a CAS-style token", () => {
  it("is eligible only for not_submitted while submissionState is not_started", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const result = launchClaimRollbackEligibility(record);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "not_submitted");
    assert.deepEqual(result.token, {
      attemptId: "attempt-1", acceptance: "not_submitted", submissionState: "not_started", updatedAt: record.updatedAt,
    });
  });

  it("becomes ineligible once submission has started, even though acceptance is still not_submitted (crash/lock-failure scenario)", () => {
    setup();
    createLaunchClaim(claimInput());
    const started = markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    assert.equal(started.acceptance, "not_submitted");
    const result = launchClaimRollbackEligibility(started);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "not_submitted_after_submission_started_never_rollback_safe");
  });

  it("is eligible for acceptance_rejected regardless of submissionState", () => {
    setup();
    createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const rejected = recordLaunchAcceptanceRejected({ ...binding(), attemptId: "attempt-1" });
    assert.deepEqual(
      launchClaimRollbackEligibility(rejected),
      {
        eligible: true, reason: "acceptance_rejected",
        token: {
          attemptId: "attempt-1", acceptance: "acceptance_rejected", submissionState: "started", updatedAt: rejected.updatedAt,
        },
      }
    );
  });

  it("is never eligible for acceptance_unknown", () => {
    setup();
    createLaunchClaim(claimInput());
    const unknown = recordLaunchAcceptanceUnknown({ ...binding(), attemptId: "attempt-1" });
    assert.equal(launchClaimRollbackEligibility(unknown).eligible, false);
    assert.equal(launchClaimRollbackEligibility(unknown).reason, "acceptance_unknown_never_rollback_safe");
  });

  it("is never eligible for acceptance_proven", () => {
    setup();
    createLaunchClaim(claimInput());
    const proven = recordLaunchAcceptanceProven({ ...binding(), attemptId: "attempt-1", liveHarnessTurn: fakeLiveHarnessTurn() });
    assert.equal(launchClaimRollbackEligibility(proven).eligible, false);
    assert.equal(launchClaimRollbackEligibility(proven).reason, "acceptance_proven_never_rollback_safe");
  });

  it("exposes exactly the closed rollback reasons", () => {
    assert.deepEqual(LAUNCH_CLAIM_ROLLBACK_REASONS, [
      "not_submitted",
      "acceptance_rejected",
      "not_submitted_after_submission_started_never_rollback_safe",
      "acceptance_unknown_never_rollback_safe",
      "acceptance_proven_never_rollback_safe",
    ]);
  });

  it("FORGED RECORD: rejects a fully shape-valid record whose attemptId was never really persisted for this job", () => {
    setup();
    const real = createLaunchClaim(claimInput());
    const forged = { ...real, attemptId: "attempt-forged-never-created" };
    assert.throws(() => launchClaimRollbackEligibility(forged), /exact currently durable record/);
  });

  it("STALE/RACE: rejects an in-hand copy whose token would be stale after the real record has since advanced", () => {
    setup();
    const staleCopy = createLaunchClaim(claimInput());
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    assert.throws(() => launchClaimRollbackEligibility(staleCopy), /exact currently durable record/);
  });

  it("the token's updatedAt/submissionState changes as the durable record advances, letting a caller detect staleness via CAS-style comparison", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const before = launchClaimRollbackEligibility(record);
    markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" });
    const advanced = readLaunchClaim(binding());
    const after = launchClaimRollbackEligibility(advanced);
    assert.notEqual(before.token.updatedAt, after.token.updatedAt);
    assert.equal(before.token.submissionState, "not_started");
    assert.equal(after.token.submissionState, "started");
  });

  it("rejects a partial object missing required fields", () => {
    setup();
    assert.throws(() => launchClaimRollbackEligibility({ acceptance: "not_submitted" }), /is missing required field/);
  });

  it("rejects a Proxy-wrapped record", () => {
    setup();
    const real = createLaunchClaim(claimInput());
    assert.throws(() => launchClaimRollbackEligibility(new Proxy(real, {})), /Proxy/);
  });

  it("imports exactly the two narrow proof seams it needs (acquiredLeaseEvidence, durableTurnEvidence), never an acquire/release/inventory/Driver-registry/mailbox/completion export", () => {
    const moduleUrl = new URL("../../runtime/launch-claim.mjs", import.meta.url);
    const source = fs.readFileSync(moduleUrl, "utf8");
    const importStatements = [...source.matchAll(/^import\s+(\{[\s\S]*?\}|\S+)\s+from\s+["'](.+?)["'];/gm)];
    const bySpecifier = new Map(importStatements.map((match) => [match[2], match[1]]));

    assert.ok(bySpecifier.has("./instance-admission-lease.mjs"));
    assert.deepEqual(
      [...bySpecifier.get("./instance-admission-lease.mjs").matchAll(/[\w$]+/g)].map((m) => m[0]),
      ["acquiredLeaseEvidence"],
      "must import only the brand-gated evidence seam, never acquireLease/acquireInstanceLease/" +
      "acquireNativeSessionLease/releaseLeasesOnSettlement/inspectLeaseInventory"
    );

    assert.ok(bySpecifier.has("./harness-contract.mjs"));
    assert.deepEqual(
      [...bySpecifier.get("./harness-contract.mjs").matchAll(/[\w$]+/g)].map((m) => m[0]),
      ["durableTurnEvidence", "validateRouteInspectionEvidence"],
      "must import only bounded evidence validators, never validateLiveHarnessTurn or a Driver-invoking export"
    );

    for (const forbidden of ["harness-registry", "workspace-writer-lease", "completion-inbox", "agent-store", "job-store"]) {
      for (const specifier of bySpecifier.keys()) {
        assert.doesNotMatch(specifier, new RegExp(forbidden), `unexpected import of ${specifier}`);
      }
    }
  });
});

describe("launch claim: tightly bounded lock timeout, not the 30-second convention", () => {
  it("times out against a genuinely held, never-releasing lock within a small bounded multiple of LOCK_ACQUIRE_TIMEOUT_MS, never anywhere near 30s", async () => {
    setup();
    assert.ok(LOCK_ACQUIRE_TIMEOUT_MS <= 5_000, `expected a tightly bounded timeout, got ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"]);
    await new Promise((resolve, reject) => {
      holder.once("spawn", resolve);
      holder.once("error", reject);
    });
    const claimDir = resolveLaunchClaimDirectory(binding());
    fs.mkdirSync(claimDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(claimDir, ".lock");
    const identity = getProcessIdentity(holder.pid);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, identity, token: "held-forever", timestamp: Date.now() }));
    const start = Date.now();
    try {
      assert.throws(() => createLaunchClaim(claimInput()), /Timed out acquiring launch claim directory lock/);
    } finally {
      holder.kill();
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= LOCK_ACQUIRE_TIMEOUT_MS, `expected at least the bounded timeout (${LOCK_ACQUIRE_TIMEOUT_MS}ms), got ${elapsed}ms`);
    assert.ok(elapsed < LOCK_ACQUIRE_TIMEOUT_MS * 3, `expected close to the bounded timeout, got ${elapsed}ms`);
    assert.ok(elapsed < 10_000, `must never approach the old 30s convention, got ${elapsed}ms`);
  });
});

describe("launch claim: pre-submission rollback fence", () => {
  function racePayload(root) {
    return {
      ...binding(),
      attemptId: "attempt-1",
      harnessId: V3_HARNESS_ID,
      instanceKey: V3_INSTANCE_KEY,
      capacityClass: "default",
      capacityLimit: 4,
      acquireStartFile: path.join(root, "acquire.start"),
      rollbackStartFile: path.join(root, "rollback.start"),
      holderReadyFile: path.join(root, "holder.ready"),
      releaseHolderFile: path.join(root, "holder.release"),
    };
  }

  function createRaceIntent() {
    return createLaunchIntent({
      ...binding(),
      attemptId: "attempt-1",
      lifecycleOwner: "version_three_worker",
      route: versionThreeRoute(),
      expectedLease: { kind: "instance", capacityClass: "default", capacityLimit: 4 },
      assignedMessageIds: ["message-1"],
      preparedInput: "hello",
      turnOptions: null,
      inspectionEvidence: inspectionEvidence(),
    });
  }

  function exactHolderPresent() {
    return inspectLeaseInventory().entries.flatMap((entry) => entry.holders).some((holder) =>
      holder.ownerRootId === "root-1" && holder.agentId === "agent-1" && holder.jobId === "job-1"
    );
  }

  it("real child race: rollback-before-acquire leaves no late holder", async () => {
    const { root } = setup();
    createRaceIntent();
    const payload = racePayload(root);
    const acquire = spawnIntentRace("acquire", {
      ...payload,
      startFile: payload.acquireStartFile,
      holderReadyFile: null,
      releaseHolderFile: null,
    });
    const rollback = spawnIntentRace("rollback", { ...payload, startFile: payload.rollbackStartFile });
    fs.writeFileSync(payload.rollbackStartFile, "go");
    assert.equal(await rollback.exit, "rolled_back");
    fs.writeFileSync(payload.acquireStartFile, "go");
    assert.equal(await acquire.exit, "fenced");
    assert.equal(readLaunchClaim(binding()).submissionState, "rollback_complete");
    assert.equal(exactHolderPresent(), false);
  });

  it("real child race: acquire-before-rollback removes the holder after the lease lock releases", async () => {
    const { root } = setup();
    createRaceIntent();
    const payload = racePayload(root);
    const acquire = spawnIntentRace("acquire", {
      ...payload,
      startFile: payload.acquireStartFile,
      holderReadyFile: payload.holderReadyFile,
      releaseHolderFile: payload.releaseHolderFile,
    });
    fs.writeFileSync(payload.acquireStartFile, "go");
    await waitUntil(() => fs.existsSync(payload.holderReadyFile));
    const rollback = spawnIntentRace("rollback", { ...payload, startFile: payload.rollbackStartFile });
    fs.writeFileSync(payload.rollbackStartFile, "go");
    await waitUntil(() => readLaunchClaim(binding()).submissionState === "rollback_in_progress");
    fs.writeFileSync(payload.releaseHolderFile, "go");
    assert.equal(await acquire.exit, "acquired");
    assert.equal(await rollback.exit, "rolled_back");
    assert.equal(readLaunchClaim(binding()).submissionState, "rollback_complete");
    assert.equal(exactHolderPresent(), false);
  });

  it("lets a stale rollback releaser converge after its peer completed the same tombstone", () => {
    setup();
    createRaceIntent();
    const lease = acquireIntendedInstanceLease({
      ...binding(),
      attemptId: "attempt-1",
      route: versionThreeRoute(),
      harnessId: V3_HARNESS_ID,
      instanceKey: V3_INSTANCE_KEY,
      capacityClass: "default",
      capacityLimit: 4,
    });
    bindLaunchClaimLeases({ ...binding(), attemptId: "attempt-1", leases: [lease] });
    const current = readLaunchClaim(binding());
    const rollback = beginPreSubmissionRollback({
      ...binding(), token: launchClaimRollbackEligibility(current).token,
    });

    assert.deepEqual(releaseLeasesForPreSubmissionRollback({ claim: rollback }), {
      outcome: "all", released: true,
    });
    assert.equal(
      completePreSubmissionRollback({ ...binding(), attemptId: "attempt-1" }).submissionState,
      "rollback_complete",
    );
    assert.deepEqual(releaseLeasesForPreSubmissionRollback({ claim: rollback }), {
      outcome: "all", released: true,
    });
    assert.equal(exactHolderPresent(), false);
  });

  it("atomically fences a still-unsubmitted attempt, and a stale submitter loses", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const eligibility = launchClaimRollbackEligibility(record);
    const rollback = beginPreSubmissionRollback({ ...binding(), token: eligibility.token });
    assert.equal(rollback.submissionState, "rollback_in_progress");
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" }),
      /rollback/i,
    );
    assert.throws(
      () => beginPreSubmissionRollback({ ...binding(), token: eligibility.token }),
      /stale|rollback/i,
    );
  });

  it("completes the rollback tombstone idempotently and never reopens submission", () => {
    setup();
    const record = createLaunchClaim(claimInput());
    const rollback = beginPreSubmissionRollback({
      ...binding(), token: launchClaimRollbackEligibility(record).token,
    });
    assert.equal(rollback.submissionState, "rollback_in_progress");
    const completed = completePreSubmissionRollback({ ...binding(), attemptId: "attempt-1" });
    assert.equal(completed.submissionState, "rollback_complete");
    assert.deepEqual(
      completePreSubmissionRollback({ ...binding(), attemptId: "attempt-1" }),
      completed,
    );
    assert.throws(
      () => markNativeSubmissionStarted({ ...binding(), attemptId: "attempt-1" }),
      /rollback/i,
    );
  });
});

describe("launch claim: real restart/redelivery and independent-process contention", () => {
  it("lets exactly one of two competing worker attempts durably claim one job activation", async () => {
    setup();
    const stateHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    const run = (attemptId) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [contentionFixture, "create", attemptId], {
        env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: stateHome },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(stdout.trim()));
    });
    const [resultA, resultB] = await Promise.all([run("attempt-a"), run("attempt-b")]);
    const outcomes = [resultA, resultB];
    assert.equal(outcomes.filter((value) => value === "ok").length, 1, `expected exactly one winner: ${outcomes.join(",")}`);
    assert.equal(outcomes.filter((value) => value === "conflict").length, 1, `expected exactly one conflict: ${outcomes.join(",")}`);
    const stored = readLaunchClaim(binding());
    assert.ok(["attempt-a", "attempt-b"].includes(stored.attemptId));
  });

  it("replays an identical create from independent processes idempotently (no duplicate/lost claim)", async () => {
    setup();
    const stateHome = process.env.CODEX_HARNESSDOCK_RUNTIME_HOME;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [contentionFixture, "create", "attempt-same"], {
        env: { ...process.env, CODEX_HARNESSDOCK_RUNTIME_HOME: stateHome },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(stdout.trim()));
    });
    const results = await Promise.all([run(), run(), run()]);
    assert.ok(results.every((value) => value === "ok"), `unexpected results: ${results.join(",")}`);
    const stored = readLaunchClaim(binding());
    assert.equal(stored.attemptId, "attempt-same");
  });
});
