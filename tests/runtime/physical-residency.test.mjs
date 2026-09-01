/** SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePhysicalResidency } from "../../runtime/physical-residency.mjs";

describe("physical residency", () => {
  it("admits only the three closed private receipt variants", () => {
    assert.deepEqual(validatePhysicalResidency({ kind: "local_process", pid: 7, identity: "123" }), { kind: "local_process", pid: 7, identity: "123" });
    assert.deepEqual(validatePhysicalResidency({
      kind: "managed_service", pid: 8, identity: "456", commandFingerprint: "a".repeat(64),
      receiptGeneration: "b".repeat(64), turnLeaseToken: "c".repeat(32),
    }).kind, "managed_service");
    assert.deepEqual(validatePhysicalResidency({ kind: "reused_service", turnLeaseToken: "d".repeat(32) }).kind, "reused_service");
    assert.throws(() => validatePhysicalResidency({ kind: "local_process", pid: 7 }), /field set/);
    assert.throws(() => validatePhysicalResidency({ kind: "reused_service", turnLeaseToken: "x" }), /exact reused/);
    assert.throws(() => validatePhysicalResidency({ kind: "managed_service", pid: 8, identity: "456", commandFingerprint: "a".repeat(64), receiptGeneration: "b".repeat(64), turnLeaseToken: "c".repeat(32), endpoint: "http://127.0.0.1" }), /field set/);
  });
});
