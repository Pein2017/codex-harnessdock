import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  adoptPluginIdentity,
  defaultIdentityAdoptionFile,
  defaultIdentityCutoverFile,
  inspectIdentityCutover,
  cutoverPluginIdentity,
  readIdentityAdoptionReceipt,
  rollbackInstalledIdentity,
  rollbackPluginIdentity,
} from "../../runtime/plugin-identity-cutover.mjs";
import { configureRuntimePaths } from "../../runtime/paths.mjs";

/** @type {string[]} */
const temporaryDirectories = [];

function temporaryDirectory(prefix = "harnessdock-cutover-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * @returns {{
 *   codexHome: string,
 *   dataRoot: string,
 *   oldRoot: string,
 *   newRoot: string,
 *   ownership?: {activeTurn: boolean, pendingHandoff: boolean, unknownSettlement: boolean},
 *   mcpOwnership?: {oldActive: boolean, newActive: boolean},
 * }}
 */
function roots() {
  const codexHome = temporaryDirectory();
  const dataRoot = path.join(codexHome, "plugins", "data");
  const oldRoot = path.join(dataRoot, "cc");
  const newRoot = path.join(dataRoot, "codex-harnessdock");
  fs.mkdirSync(path.join(oldRoot, "state"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(oldRoot, "state", "agent.json"), '{"id":"agent-1","status":"completed"}\n', { mode: 0o600 });
  return {
    codexHome,
    dataRoot,
    oldRoot,
    newRoot,
    ownership: {
      activeTurn: false,
      pendingHandoff: false,
      unknownSettlement: false,
    },
    mcpOwnership: { oldActive: false, newActive: false },
  };
}

function adoptionRoots() {
  const target = roots();
  fs.renameSync(target.oldRoot, target.newRoot);
  return target;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("HarnessDock identity data cutover", () => {
  it("adopts one explicitly confirmed authoritative current root without inventing a cutover", () => {
    const target = adoptionRoots();
    assert.equal(inspectIdentityCutover(target).state, "rollback_required");
    assert.equal(
      defaultIdentityAdoptionFile({ CODEX_HOME: target.codexHome }),
      path.join(target.newRoot, "operator", "identity-adoption.json"),
    );

    const receipt = adoptPluginIdentity({
      ...target,
      currentRootAuthoritative: true,
      legacyDataRecoveryRequired: false,
      now: "2026-08-28T12:00:00.000Z",
    });
    assert.deepEqual(receipt, {
      version: 1,
      status: "accepted",
      operation: "adoption",
      adopted_at: "2026-08-28T12:00:00.000Z",
      current_namespace: "codex-harnessdock",
      current_root: target.newRoot,
      legacy_namespace: "cc",
      legacy_root: target.oldRoot,
      legacy_root_absent: true,
      cutover_backup_absent: true,
      state_validated: true,
      current_root_authoritative: true,
      legacy_data_recovery_required: false,
      writable_roots: [target.newRoot],
    });
    assert.deepEqual(readIdentityAdoptionReceipt(target), receipt);
    assert.equal(inspectIdentityCutover(target).state, "adopted");
    assert.deepEqual(adoptPluginIdentity({
      ...target,
      currentRootAuthoritative: true,
      legacyDataRecoveryRequired: false,
    }), { ...receipt, idempotent: true });
  });

  it("refuses adoption without exact authority, absence, and valid-state evidence", () => {
    const missingAuthority = adoptionRoots();
    assert.throws(
      () => adoptPluginIdentity({ ...missingAuthority, legacyDataRecoveryRequired: false }),
      /current root.*authoritative/i,
    );

    const recoveryRequired = adoptionRoots();
    assert.throws(
      () => adoptPluginIdentity({ ...recoveryRequired, currentRootAuthoritative: true, legacyDataRecoveryRequired: true }),
      /legacy data recovery.*false/i,
    );

    const legacyPresent = adoptionRoots();
    fs.mkdirSync(legacyPresent.oldRoot);
    assert.throws(
      () => adoptPluginIdentity({ ...legacyPresent, currentRootAuthoritative: true, legacyDataRecoveryRequired: false }),
      /legacy data root.*absent/i,
    );

    const backupPresent = adoptionRoots();
    fs.mkdirSync(path.join(backupPresent.dataRoot, ".codex-harnessdock-backups"));
    assert.throws(
      () => adoptPluginIdentity({ ...backupPresent, currentRootAuthoritative: true, legacyDataRecoveryRequired: false }),
      /backup.*absent/i,
    );

    const malformed = adoptionRoots();
    fs.writeFileSync(path.join(malformed.newRoot, "state", "broken.json"), "not-json\n");
    assert.throws(
      () => adoptPluginIdentity({ ...malformed, currentRootAuthoritative: true, legacyDataRecoveryRequired: false }),
      /malformed durable state/i,
    );

    const invalidReceipt = adoptionRoots();
    fs.mkdirSync(path.join(invalidReceipt.newRoot, "operator"));
    fs.writeFileSync(path.join(invalidReceipt.newRoot, "operator", "identity-adoption.json"), JSON.stringify({
      version: 1,
      status: "accepted",
      operation: "adoption",
      current_root: 42,
    }));
    assert.equal(inspectIdentityCutover(invalidReceipt).state, "rollback_required");
    assert.throws(
      () => adoptPluginIdentity({ ...invalidReceipt, currentRootAuthoritative: true, legacyDataRecoveryRequired: false }),
      /invalid adoption receipt/i,
    );

    const absent = roots();
    fs.rmSync(absent.oldRoot, { recursive: true, force: true });
    assert.throws(
      () => adoptPluginIdentity({ ...absent, currentRootAuthoritative: true, legacyDataRecoveryRequired: false }),
      /current data root.*unavailable/i,
    );
  });

  it("derives the new default namespace and rejects the retired override", () => {
    const codexHome = "/tmp/harnessdock-codex-home";
    assert.equal(
      defaultIdentityCutoverFile({ CODEX_HOME: codexHome }),
      path.join(codexHome, "plugins", "data", "codex-harnessdock", "operator", "identity-cutover.json"),
    );
    assert.throws(
      () => cutoverPluginIdentity({ ...roots(), env: { CC_RUNTIME_HOME: "/tmp/old" } }),
      /CC_RUNTIME_HOME is retired/i,
    );
    // The same refusal guards path ownership. A stale export must fail loudly:
    // ignoring it would silently resolve the operator's real data namespace,
    // which is exactly the isolation escape the pinned test home exists to stop.
    assert.throws(
      () => configureRuntimePaths({ CC_RUNTIME_HOME: "/tmp/old" }),
      /CC_RUNTIME_HOME is retired/i,
    );
  });

  it("reports pending, migrated, and conflicting roots without mutating them", () => {
    const pending = roots();
    assert.equal(inspectIdentityCutover(pending).state, "pending");

    const migrated = roots();
    fs.renameSync(migrated.oldRoot, migrated.newRoot);
    fs.mkdirSync(path.join(migrated.newRoot, "operator"), { recursive: true });
    fs.writeFileSync(path.join(migrated.newRoot, "operator", "identity-cutover.json"), JSON.stringify({
      version: 1,
      status: "accepted",
      cutover_at: "2026-08-14T00:00:00.000Z",
    }));
    assert.equal(inspectIdentityCutover(migrated).state, "migrated");

    const invalidReceipt = roots();
    fs.renameSync(invalidReceipt.oldRoot, invalidReceipt.newRoot);
    fs.mkdirSync(path.join(invalidReceipt.newRoot, "operator"), { recursive: true });
    fs.writeFileSync(path.join(invalidReceipt.newRoot, "operator", "identity-cutover.json"), JSON.stringify({
      version: 1,
      status: "accepted",
      cutover_at: "2026-08-14T00:00:00+00:00",
    }));
    assert.equal(inspectIdentityCutover(invalidReceipt).state, "rollback_required");

    const conflict = roots();
    fs.mkdirSync(conflict.newRoot, { recursive: true });
    fs.writeFileSync(path.join(conflict.newRoot, "marker"), "conflict");
    assert.equal(inspectIdentityCutover(conflict).state, "conflicting");
  });

  it("backs up and atomically moves valid state while preserving bytes and owner mode", () => {
    const target = roots();
    const before = fs.readFileSync(path.join(target.oldRoot, "state", "agent.json"));
    const beforeMode = fs.statSync(target.oldRoot).mode & 0o777;
    const receipt = cutoverPluginIdentity({ ...target, now: "2026-08-14T01:02:03.000Z" });
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.cutover_at, "2026-08-14T01:02:03.000Z");
    assert.equal(fs.existsSync(target.oldRoot), false);
    assert.equal(fs.existsSync(target.newRoot), true);
    assert.deepEqual(fs.readFileSync(path.join(target.newRoot, "state", "agent.json")), before);
    assert.equal(fs.statSync(target.newRoot).mode & 0o777, beforeMode);
    assert.equal(fs.existsSync(receipt.backup_root), true);
    assert.equal(inspectIdentityCutover(target).state, "migrated");
  });

  it("refuses malformed state, active/unknown ownership, nonempty destination, backup failure, and cross-device moves", () => {
    const noOwnershipWitness = roots();
    delete noOwnershipWitness.ownership;
    assert.throws(
      () => cutoverPluginIdentity(noOwnershipWitness),
      /explicit Agent ownership witness/i,
    );

    const incompleteOwnershipWitness = roots();
    incompleteOwnershipWitness.ownership = /** @type {any} */ ({});
    assert.throws(
      () => cutoverPluginIdentity(incompleteOwnershipWitness),
      /complete Agent ownership witness/i,
    );

    const noWitness = roots();
    delete noWitness.mcpOwnership;
    assert.throws(() => cutoverPluginIdentity(noWitness), /MCP process ownership witness/i);

    const mcpActive = roots();
    mcpActive.mcpOwnership = { oldActive: true, newActive: false };
    assert.throws(() => cutoverPluginIdentity(mcpActive), /old or new MCP process is active/i);

    const malformed = roots();
    fs.writeFileSync(path.join(malformed.oldRoot, "state", "broken.json"), "not-json\n");
    assert.throws(() => cutoverPluginIdentity(malformed), /malformed durable state/i);

    for (const ownership of [
      { activeTurn: true },
      { pendingHandoff: true },
      { unknownSettlement: true },
    ]) {
      const target = roots();
      assert.throws(() => cutoverPluginIdentity({ ...target, ownership }), /active|unknown|pending/i);
    }

    const occupied = roots();
    fs.mkdirSync(occupied.newRoot, { recursive: true });
    fs.writeFileSync(path.join(occupied.newRoot, "existing"), "keep");
    assert.throws(() => cutoverPluginIdentity(occupied), /destination.*non-empty/i);

    const backupFailure = roots();
    assert.throws(() => cutoverPluginIdentity({
      ...backupFailure,
      copyDirectory() { throw new Error("backup unavailable"); },
    }), /backup unavailable/i);

    const crossDevice = roots();
    assert.throws(() => cutoverPluginIdentity({ ...crossDevice, deviceIds: { old: 1, destination: 2 } }), /same filesystem|cross-device/i);
  });

  it("leaves a recoverable boundary on interrupted move and restores only settled state", () => {
    const interrupted = roots();
    assert.throws(() => cutoverPluginIdentity({
      ...interrupted,
      renameDirectory() { throw new Error("simulated interruption"); },
    }), /simulated interruption/i);
    assert.equal(fs.existsSync(interrupted.oldRoot), true);
    assert.equal(fs.existsSync(interrupted.newRoot), false);

    const target = roots();
    const receipt = cutoverPluginIdentity({ ...target, now: "2026-08-14T02:00:00.000Z" });
    const rollback = rollbackPluginIdentity({
      ...target,
      receipt,
      ownership: { activeTurn: true },
    });
    assert.equal(rollback.status, "blocked");
    assert.equal(fs.existsSync(target.newRoot), true);

    const noRollbackWitness = { ...target };
    delete noRollbackWitness.ownership;
    const unproven = rollbackPluginIdentity({ ...noRollbackWitness, receipt });
    assert.equal(unproven.status, "blocked");
    assert.equal(unproven.code, "IDENTITY_CUTOVER_OWNERSHIP_UNPROVEN");
    assert.equal(fs.existsSync(target.newRoot), true);

    const restored = rollbackPluginIdentity({ ...target, receipt });
    assert.equal(restored.status, "rolled_back");
    assert.equal(fs.existsSync(target.oldRoot), true);
    assert.equal(fs.statSync(target.oldRoot).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(target.newRoot), false);
  });

  it("restores from the pending receipt after post-move metadata verification fails", () => {
    if (process.platform === "win32") return;
    const target = roots();
    assert.throws(
      () => cutoverPluginIdentity({
        ...target,
        now: "2026-08-14T02:30:00.000Z",
        renameDirectory(source, destination) {
          fs.renameSync(source, destination);
          fs.chmodSync(destination, 0o755);
        },
      }),
      /preserve owner\/mode metadata/i,
    );
    assert.equal(fs.existsSync(target.oldRoot), false);
    assert.equal(fs.existsSync(target.newRoot), true);
    assert.equal(inspectIdentityCutover(target).state, "rollback_required");

    const restored = rollbackPluginIdentity(target);
    assert.equal(restored.status, "rolled_back");
    assert.equal(fs.existsSync(target.oldRoot), true);
    assert.equal(fs.existsSync(target.newRoot), false);
  });

  it("evidence-gates installed rollback callbacks before restoring the legacy record", () => {
    const target = roots();
    const receipt = cutoverPluginIdentity({ ...target, now: "2026-08-14T03:00:00.000Z" });
    /** @type {string[]} */
    const blockedCalls = [];
    const blocked = rollbackInstalledIdentity({
      ...target,
      receipt,
      ownership: { unknownSettlement: true },
      disableCurrent() { blockedCalls.push("disable"); },
      restoreLegacyEnabledRecord() { blockedCalls.push("restore"); },
      runLegacyDoctor() { blockedCalls.push("doctor"); },
    });
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blockedCalls, []);

    /** @type {Array<[string, string]>} */
    const calls = [];
    const restored = rollbackInstalledIdentity({
      ...target,
      receipt,
      disableCurrent(context) { calls.push(["disable", context.currentNamespace]); },
      restoreLegacyEnabledRecord(context) { calls.push(["restore", context.legacyNamespace]); },
      runLegacyDoctor(context) { calls.push(["doctor", context.namespace]); return { status: "pass" }; },
    });
    assert.equal(restored.status, "rolled_back");
    assert.deepEqual(calls, [
      ["disable", "codex-harnessdock"],
      ["restore", "cc"],
      ["doctor", "cc"],
    ]);
    assert.deepEqual(restored.doctor, { status: "pass" });
    assert.equal(fs.existsSync(target.oldRoot), true);
    assert.equal(fs.existsSync(target.newRoot), false);
  });
});
