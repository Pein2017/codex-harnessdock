/** SPDX-License-Identifier: Apache-2.0 */
import { plainRecordSnapshot } from "./plain-record.mjs";
import { Buffer } from "node:buffer";

const TOKEN = /^[a-f0-9]{32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_IDENTITY_BYTES = 256;

/** Closed, private receipt vocabulary; no endpoint, command, path, or PID selector leaks outward. */
export function validatePhysicalResidency(value, label = "Physical residency") {
  const snapshot = plainRecordSnapshot(value, label);
  const kind = snapshot.kind;
  if (!["local_process", "managed_service", "reused_service"].includes(kind)) throw new Error(`${label} has unsupported kind.`);
  const exact = (keys) => {
    if (Object.keys(snapshot).sort().join(",") !== keys.sort().join(",")) throw new Error(`${label} has an invalid field set.`);
  };
  if (kind === "local_process") {
    exact(["kind", "pid", "identity"]);
    if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1 || !boundedIdentity(snapshot.identity)) throw new Error(`${label} lacks exact process identity.`);
    return Object.freeze({ kind, pid: snapshot.pid, identity: snapshot.identity });
  }
  if (kind === "managed_service") {
    exact(["kind", "pid", "identity", "commandFingerprint", "receiptGeneration", "turnLeaseToken"]);
    if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1 || !boundedIdentity(snapshot.identity) ||
      !FINGERPRINT.test(snapshot.commandFingerprint ?? "") || !FINGERPRINT.test(snapshot.receiptGeneration ?? "") || !TOKEN.test(snapshot.turnLeaseToken ?? "")) throw new Error(`${label} lacks an exact managed receipt.`);
    return Object.freeze({ ...snapshot });
  }
  exact(["kind", "turnLeaseToken"]);
  if (!TOKEN.test(snapshot.turnLeaseToken ?? "")) throw new Error(`${label} lacks an exact reused turn lease.`);
  return Object.freeze({ kind, turnLeaseToken: snapshot.turnLeaseToken });
}

function boundedIdentity(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTITY_BYTES && !/[\u0000-\u001F\u007F-\u009F]/.test(value); // eslint-disable-line no-control-regex
}
