/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Operator-only identity/data transition helpers.  The normal runtime never
 * calls these functions: Phase 0 prepares a reversible cutover and leaves the
 * actual installed activation behind an explicit operator authorization.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IDENTITY_CUTOVER_VERSION = 1;
export const CURRENT_DATA_NAMESPACE = "codex-harnessdock";
export const LEGACY_DATA_NAMESPACE = "cc";

function asPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a path.`);
  return path.resolve(value);
}

function codexHomeFrom(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function rejectRetiredOverride(env = process.env) {
  if (String(env.CC_RUNTIME_HOME ?? "").trim()) {
    throw new Error(
      "CC_RUNTIME_HOME is retired; use CODEX_HARNESSDOCK_RUNTIME_HOME for operator/test-only runtime isolation.",
    );
  }
}

function resolveRoots(options = {}) {
  const env = options.env ?? process.env;
  rejectRetiredOverride(env);
  const dataRoot = path.join(options.codexHome
    ? asPath(options.codexHome, "CODEX_HOME")
    : codexHomeFrom(env), "plugins", "data");
  const oldRoot = asPath(options.oldRoot ?? path.join(dataRoot, LEGACY_DATA_NAMESPACE), "oldRoot");
  const newRoot = asPath(options.newRoot ?? path.join(dataRoot, CURRENT_DATA_NAMESPACE), "newRoot");
  const receiptFile = asPath(
    options.receiptFile ?? path.join(newRoot, "operator", "identity-cutover.json"),
    "receiptFile",
  );
  const adoptionFile = asPath(
    options.adoptionFile ?? path.join(newRoot, "operator", "identity-adoption.json"),
    "adoptionFile",
  );
  return { env, dataRoot, oldRoot, newRoot, receiptFile, adoptionFile };
}

export function defaultIdentityCutoverFile(env = process.env) {
  rejectRetiredOverride(env);
  return path.join(codexHomeFrom(env), "plugins", "data", CURRENT_DATA_NAMESPACE, "operator", "identity-cutover.json");
}

export function defaultIdentityAdoptionFile(env = process.env) {
  rejectRetiredOverride(env);
  return path.join(codexHomeFrom(env), "plugins", "data", CURRENT_DATA_NAMESPACE, "operator", "identity-adoption.json");
}

function exists(directory) {
  try {
    return fs.existsSync(directory);
  } catch {
    return false;
  }
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isEmpty(directory) {
  return isDirectory(directory) && fs.readdirSync(directory).length === 0;
}

// Compatibility discovery shells share the new data namespace but are not
// lifecycle state. Their presence must not make an uninstalled candidate look
// like a half-completed durable-data migration.
function hasManagedIdentityData(directory) {
  if (!isDirectory(directory)) return false;
  try {
    return fs.readdirSync(directory).some((entry) => entry !== "compatibility-shells");
  } catch {
    return true;
  }
}

function hasAdoptableIdentityData(directory) {
  if (!isDirectory(directory)) return false;
  try {
    return fs.readdirSync(directory).some((entry) => entry !== "compatibility-shells" && entry !== "operator");
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(directory, 0o700); } catch {}
  }
}

function writePrivateJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(temporary, 0o600); } catch {}
  }
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readAcceptedReceipt(filePath) {
  if (!exists(filePath)) return null;
  const value = readJson(filePath);
  if (
    !value ||
    value.version !== IDENTITY_CUTOVER_VERSION ||
    value.status !== "accepted" ||
    typeof value.cutover_at !== "string" ||
    !Number.isFinite(Date.parse(value.cutover_at)) ||
    !/[zZ]$/.test(value.cutover_at) ||
    new Date(value.cutover_at).toISOString() !== value.cutover_at ||
    (value.old_root != null && typeof value.old_root !== "string") ||
    (value.new_root != null && typeof value.new_root !== "string") ||
    (value.backup_root != null && typeof value.backup_root !== "string")
  ) return null;
  return value;
}

function readAcceptedAdoptionReceipt(filePath, roots) {
  if (!exists(filePath)) return null;
  const value = readJson(filePath);
  if (
    !value ||
    value.version !== IDENTITY_CUTOVER_VERSION ||
    value.status !== "accepted" ||
    value.operation !== "adoption" ||
    typeof value.adopted_at !== "string" ||
    !Number.isFinite(Date.parse(value.adopted_at)) ||
    !/[zZ]$/.test(value.adopted_at) ||
    new Date(value.adopted_at).toISOString() !== value.adopted_at ||
    value.current_namespace !== CURRENT_DATA_NAMESPACE ||
    value.legacy_namespace !== LEGACY_DATA_NAMESPACE ||
    typeof value.current_root !== "string" ||
    path.resolve(value.current_root) !== roots.newRoot ||
    typeof value.legacy_root !== "string" ||
    path.resolve(value.legacy_root) !== roots.oldRoot ||
    value.legacy_root_absent !== true ||
    value.cutover_backup_absent !== true ||
    value.state_validated !== true ||
    value.current_root_authoritative !== true ||
    value.legacy_data_recovery_required !== false ||
    !Array.isArray(value.writable_roots) ||
    value.writable_roots.length !== 1 ||
    typeof value.writable_roots[0] !== "string" ||
    path.resolve(value.writable_roots[0]) !== roots.newRoot ||
    !hasAdoptableIdentityData(roots.newRoot)
  ) return null;
  return value;
}

function validPendingReceipt(value, roots) {
  return Boolean(
    value &&
    value.version === IDENTITY_CUTOVER_VERSION &&
    value.status === "pending" &&
    typeof value.cutover_at === "string" &&
    Number.isFinite(Date.parse(value.cutover_at)) &&
    path.resolve(value.old_root ?? "") === roots.oldRoot &&
    path.resolve(value.new_root ?? "") === roots.newRoot &&
    typeof value.backup_root === "string" &&
    isDirectory(path.resolve(value.backup_root))
  );
}

function readPendingReceipt(roots, options = {}) {
  const candidateFiles = [];
  if (options.backupRoot) {
    const backupRoot = asPath(options.backupRoot, "backupRoot");
    candidateFiles.push(path.join(path.dirname(backupRoot), `.pending-${path.basename(backupRoot)}.json`));
  } else {
    const backupDirectory = path.join(path.dirname(roots.newRoot), ".codex-harnessdock-backups");
    if (isDirectory(backupDirectory)) {
      for (const name of fs.readdirSync(backupDirectory)) {
        if (name.startsWith(".pending-") && name.endsWith(".json")) {
          candidateFiles.push(path.join(backupDirectory, name));
        }
      }
    }
  }
  const receipts = candidateFiles
    .map((filePath) => readJson(filePath))
    .filter((value) => validPendingReceipt(value, roots));
  return receipts.length === 1 ? receipts[0] : null;
}

export function readIdentityCutoverReceipt(options = {}) {
  const roots = resolveRoots(options);
  return readAcceptedReceipt(roots.receiptFile);
}

export function readIdentityAdoptionReceipt(options = {}) {
  const roots = resolveRoots(options);
  return readAcceptedAdoptionReceipt(roots.adoptionFile, roots);
}

function visitFiles(root, visitor) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`State contains an unsupported symlink: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) visitor(target);
      else throw new Error(`State contains an unsupported entry: ${target}`);
    }
  };
  visit(root);
}

function validateState(root) {
  try {
    visitFiles(root, (filePath) => {
      const basename = path.basename(filePath);
      if (basename.endsWith(".json")) {
        JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else if (basename.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
          if (line.trim()) JSON.parse(line);
        }
      }
    });
  } catch (error) {
    throw new Error("Durable state contains a malformed durable state record.", { cause: error });
  }
}

function ownershipWitness(options, roots, phase) {
  let observed;
  if (Object.hasOwn(options, "ownership")) {
    observed = options.ownership;
  } else if (typeof options.inspectOwnership === "function") {
    observed = options.inspectOwnership({
      ...roots,
      phase,
      stateRoot: phase === "rollback" ? roots.newRoot : roots.oldRoot,
    });
  } else {
    const error = new Error("Identity cutover requires an explicit Agent ownership witness.");
    /** @type {any} */ (error).code = "IDENTITY_CUTOVER_OWNERSHIP_UNPROVEN";
    throw error;
  }
  if (
    !observed ||
    typeof observed !== "object" ||
    Array.isArray(observed) ||
    typeof observed.activeTurn !== "boolean" ||
    typeof observed.pendingHandoff !== "boolean" ||
    typeof observed.unknownSettlement !== "boolean"
  ) {
    const error = new Error(
      "Identity cutover requires a complete Agent ownership witness with activeTurn, pendingHandoff, and unknownSettlement booleans.",
    );
    /** @type {any} */ (error).code = "IDENTITY_CUTOVER_OWNERSHIP_UNPROVEN";
    throw error;
  }
  return observed;
}

function assertSettled(options, roots, phase = "cutover") {
  const observed = ownershipWitness(options, roots, phase);
  const active = observed?.activeTurn === true || observed?.active === true;
  const pending = observed?.pendingHandoff === true || observed?.pending === true;
  const unknown = observed?.unknownSettlement === true || observed?.unknown === true;
  if (active || pending || unknown) {
    const reasons = [
      active ? "active Agent turn" : null,
      pending ? "pending handoff" : null,
      unknown ? "unknown settlement" : null,
    ].filter(Boolean).join(", ");
    const error = new Error(`Identity cutover is blocked by ${reasons}.`);
    /** @type {any} */ (error).code = unknown ? "IDENTITY_CUTOVER_UNKNOWN" : "IDENTITY_CUTOVER_ACTIVE";
    throw error;
  }
}

function assertNoMcpRace(options, roots) {
  const observed = options.mcpOwnership
    ?? (typeof options.inspectMcpOwnership === "function" ? options.inspectMcpOwnership(roots) : null);
  if (!observed) {
    const error = new Error("Identity cutover requires an explicit old/new MCP process ownership witness.");
    /** @type {any} */ (error).code = "IDENTITY_CUTOVER_MCP_RACE_UNPROVEN";
    throw error;
  }
  const oldActive = observed.oldActive === true || observed.oldRunning === true;
  const newActive = observed.newActive === true || observed.newRunning === true;
  if (oldActive || newActive) {
    const error = new Error("Identity cutover is blocked while an old or new MCP process is active.");
    /** @type {any} */ (error).code = "IDENTITY_CUTOVER_MCP_RACE";
    throw error;
  }
}

function deviceId(root, options, key) {
  if (options.deviceIds && Object.hasOwn(options.deviceIds, key)) return options.deviceIds[key];
  return fs.statSync(root).dev;
}

function timestamp(options) {
  const raw = options.now ?? new Date();
  const value = raw instanceof Date ? raw.toISOString() : String(raw);
  if (!Number.isFinite(Date.parse(value))) throw new Error("Identity cutover timestamp must be valid UTC text.");
  return new Date(value).toISOString();
}

function backupName(newRoot, cutoverAt) {
  const token = cutoverAt.replace(/[^0-9]/g, "").slice(0, 14) || String(Date.now());
  return path.join(path.dirname(newRoot), ".codex-harnessdock-backups", `${LEGACY_DATA_NAMESPACE}-${token}`);
}

function makeReadonly(root) {
  if (process.platform === "win32") return;
  try { fs.chmodSync(root, 0o500); } catch {}
}

export function inspectIdentityCutover(options = {}) {
  const roots = resolveRoots(options);
  const oldPresent = exists(roots.oldRoot);
  const newPresent = hasManagedIdentityData(roots.newRoot);
  if (oldPresent && newPresent) {
    return { state: "conflicting", ...roots, old_present: true, new_present: true };
  }
  if (newPresent) {
    const cutoverReceipt = readAcceptedReceipt(roots.receiptFile);
    const adoptionReceipt = readAcceptedAdoptionReceipt(roots.adoptionFile, roots);
    if (cutoverReceipt && adoptionReceipt) {
      return { state: "conflicting", ...roots, old_present: false, new_present: true };
    }
    if (cutoverReceipt) {
      return { state: "migrated", ...roots, receipt: cutoverReceipt, old_present: false, new_present: true };
    }
    if (adoptionReceipt) {
      return { state: "adopted", ...roots, receipt: adoptionReceipt, old_present: false, new_present: true };
    }
    return {
          state: "rollback_required",
          ...roots,
          recovery_receipt: readPendingReceipt(roots, options),
          old_present: false,
          new_present: true,
        };
  }
  if (oldPresent) return { state: "pending", ...roots, old_present: true, new_present: false };
  return { state: "absent", ...roots, old_present: false, new_present: false };
}

export function adoptPluginIdentity(options = {}) {
  const roots = resolveRoots(options);
  if (options.currentRootAuthoritative !== true) {
    throw new Error("Identity adoption requires explicit confirmation that the current root is authoritative.");
  }
  if (options.legacyDataRecoveryRequired !== false) {
    throw new Error("Identity adoption requires legacy data recovery to be stated explicitly as false.");
  }

  const current = inspectIdentityCutover(options);
  if (current.state === "adopted" && "receipt" in current) return { ...current.receipt, idempotent: true };
  if (exists(roots.oldRoot)) throw new Error("Identity adoption requires the legacy data root to be absent.");
  if (!hasAdoptableIdentityData(roots.newRoot)) {
    throw new Error("Identity adoption current data root is unavailable or has no authoritative state.");
  }
  if (exists(roots.receiptFile)) {
    throw new Error("Identity adoption refuses an existing or malformed cutover receipt.");
  }
  if (exists(roots.adoptionFile)) {
    throw new Error("Identity adoption refuses to overwrite an invalid adoption receipt.");
  }
  const backupDirectory = path.join(roots.dataRoot, ".codex-harnessdock-backups");
  if (exists(backupDirectory)) {
    throw new Error("Identity adoption requires the cutover backup boundary to be absent.");
  }

  validateState(roots.newRoot);
  if (exists(roots.oldRoot) || exists(backupDirectory)) {
    throw new Error("Identity adoption evidence changed before receipt creation.");
  }
  const receipt = {
    version: IDENTITY_CUTOVER_VERSION,
    status: "accepted",
    operation: "adoption",
    adopted_at: timestamp(options),
    current_namespace: CURRENT_DATA_NAMESPACE,
    current_root: roots.newRoot,
    legacy_namespace: LEGACY_DATA_NAMESPACE,
    legacy_root: roots.oldRoot,
    legacy_root_absent: true,
    cutover_backup_absent: true,
    state_validated: true,
    current_root_authoritative: true,
    legacy_data_recovery_required: false,
    writable_roots: [roots.newRoot],
  };
  writePrivateJson(roots.adoptionFile, receipt);
  const accepted = readAcceptedAdoptionReceipt(roots.adoptionFile, roots);
  if (!accepted || exists(roots.oldRoot) || exists(backupDirectory)) {
    fs.rmSync(roots.adoptionFile, { force: true });
    throw new Error("Identity adoption could not preserve its accepted evidence.");
  }
  return accepted;
}

export function cutoverPluginIdentity(options = {}) {
  const roots = resolveRoots(options);
  const current = inspectIdentityCutover(options);
  if (current.state === "migrated" && "receipt" in current) return { ...current.receipt, idempotent: true };
  if (current.state === "conflicting") throw new Error("Identity cutover destination is non-empty or conflicting and cannot be made writable.");
  if (!isDirectory(roots.oldRoot)) throw new Error(`Legacy data root is unavailable: ${roots.oldRoot}`);
  if (exists(roots.newRoot) && !isEmpty(roots.newRoot)) {
    throw new Error("Identity cutover destination is non-empty.");
  }

  assertSettled(options, roots);
  assertNoMcpRace(options, roots);
  validateState(roots.oldRoot);

  const oldStat = fs.statSync(roots.oldRoot);
  const destinationParent = path.dirname(roots.newRoot);
  ensurePrivateDirectory(destinationParent);
  if (deviceId(roots.oldRoot, options, "old") !== deviceId(destinationParent, options, "destination")) {
    throw new Error("Identity cutover refuses a cross-device move; old and new roots must share a filesystem.");
  }

  const cutoverAt = timestamp(options);
  const backupRoot = asPath(options.backupRoot ?? backupName(roots.newRoot, cutoverAt), "backupRoot");
  if (exists(backupRoot)) throw new Error(`Identity cutover backup already exists: ${backupRoot}`);
  ensurePrivateDirectory(path.dirname(backupRoot));
  const copyDirectory = options.copyDirectory ?? ((source, target) => fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  }));
  copyDirectory(roots.oldRoot, backupRoot);
  const pendingFile = path.join(path.dirname(backupRoot), `.pending-${path.basename(backupRoot)}.json`);
  writePrivateJson(pendingFile, {
    version: IDENTITY_CUTOVER_VERSION,
    status: "pending",
    cutover_at: cutoverAt,
    old_root: roots.oldRoot,
    new_root: roots.newRoot,
    backup_root: backupRoot,
    old_mode: oldStat.mode & 0o777,
  });

  const renameDirectory = options.renameDirectory ?? ((source, target) => fs.renameSync(source, target));
  try {
    renameDirectory(roots.oldRoot, roots.newRoot);
  } catch (error) {
    throw new Error(`Identity cutover move was interrupted: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const newStat = fs.statSync(roots.newRoot);
  const expectedMode = oldStat.mode & 0o777;
  const observedMode = newStat.mode & 0o777;
  if (newStat.uid !== oldStat.uid || newStat.gid !== oldStat.gid || observedMode !== expectedMode) {
    throw new Error("Identity cutover did not preserve owner/mode metadata.");
  }
  const receipt = {
    version: IDENTITY_CUTOVER_VERSION,
    status: "accepted",
    cutover_at: cutoverAt,
    old_namespace: LEGACY_DATA_NAMESPACE,
    new_namespace: CURRENT_DATA_NAMESPACE,
    old_root: roots.oldRoot,
    new_root: roots.newRoot,
    backup_root: backupRoot,
    old_mode: oldStat.mode & 0o777,
    mcp_race_checked: true,
    writable_roots: [roots.newRoot],
    state_preserved: true,
  };
  try {
    writePrivateJson(roots.receiptFile, receipt);
    fs.rmSync(pendingFile, { force: true });
  } catch (error) {
    throw new Error("Identity cutover completed but its receipt is unavailable; rollback is required.", { cause: error });
  }
  makeReadonly(backupRoot);
  return receipt;
}

export function rollbackPluginIdentity(options = {}) {
  const roots = resolveRoots(options);
  const receipt = options.receipt
    ?? readAcceptedReceipt(roots.receiptFile)
    ?? readPendingReceipt(roots, options);
  if (!receipt) throw new Error("No accepted or uniquely recoverable pending identity cutover receipt is available for rollback.");
  try {
    assertSettled(options, roots, "rollback");
    assertNoMcpRace(options, roots);
  } catch (error) {
    return { status: "blocked", reason: error.message, code: error.code };
  }
  const backupRoot = asPath(options.backupRoot ?? receipt.backup_root, "backupRoot");
  if (!isDirectory(backupRoot)) throw new Error(`Identity cutover backup is unavailable: ${backupRoot}`);
  if (exists(roots.oldRoot) && !isEmpty(roots.oldRoot)) {
    throw new Error("Identity rollback destination is non-empty.");
  }
  const quarantineRoot = options.quarantineRoot
    ? asPath(options.quarantineRoot, "quarantineRoot")
    : `${roots.newRoot}.rollback-${Date.now().toString(36)}`;
  if (exists(roots.newRoot)) fs.renameSync(roots.newRoot, quarantineRoot);
  fs.renameSync(backupRoot, roots.oldRoot);
  if (process.platform !== "win32") {
    try { fs.chmodSync(roots.oldRoot, receipt.old_mode ?? 0o700); } catch {}
  }
  return {
    status: "rolled_back",
    old_root: roots.oldRoot,
    new_root: roots.newRoot,
    quarantine_root: quarantineRoot,
    backup_root: backupRoot,
  };
}

/**
 * Coordinate an installed rollback without guessing at Codex's enabled-record
 * format.  The caller supplies explicit, operator-owned callbacks for the
 * external Plugin record and legacy doctor; state movement remains owned by
 * this module.  Ownership is checked before any callback can disable the new
 * identity, so an active or unknown new turn is never rolled back across.
 */
export function rollbackInstalledIdentity(options = {}) {
  const roots = resolveRoots(options);
  try {
    assertSettled(options, roots, "rollback");
    assertNoMcpRace(options, roots);
  } catch (error) {
    return { status: "blocked", reason: error.message, code: error.code };
  }
  for (const [name, callback] of [
    ["disableCurrent", options.disableCurrent],
    ["restoreLegacyEnabledRecord", options.restoreLegacyEnabledRecord],
    ["runLegacyDoctor", options.runLegacyDoctor],
  ]) {
    if (typeof callback !== "function") {
      throw new Error(`Evidence-gated rollback requires an explicit ${name} callback.`);
    }
  }

  const disabled = options.disableCurrent({
    currentNamespace: CURRENT_DATA_NAMESPACE,
    legacyNamespace: LEGACY_DATA_NAMESPACE,
  });
  const state = rollbackPluginIdentity(options);
  if (state.status !== "rolled_back") return state;
  const restored = options.restoreLegacyEnabledRecord({
    currentNamespace: CURRENT_DATA_NAMESPACE,
    legacyNamespace: LEGACY_DATA_NAMESPACE,
  });
  const doctor = options.runLegacyDoctor({
    namespace: LEGACY_DATA_NAMESPACE,
    state,
  });
  return {
    status: "rolled_back",
    disabled: disabled ?? true,
    state,
    restored: restored ?? true,
    doctor: doctor ?? null,
  };
}

// Names used by operator scripts and tests can remain explicit aliases while
// this module stays the single implementation owner.
export const migratePluginIdentity = cutoverPluginIdentity;
export const migratePluginDataNamespace = cutoverPluginIdentity;
