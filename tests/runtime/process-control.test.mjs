import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cancelClaudeProcess,
  interruptClaudeProcess,
  requestClaudeInterrupt,
} from "../../runtime/claude-headless-adapter.mjs";
import { getProcessIdentity, isProcessAlive } from "../../runtime/process-control.mjs";

describe("cross-platform process control", () => {
  it("treats a Linux zombie as unable to own live process state", () => {
    const options = {
      platform: "linux",
      killImpl: () => {},
      readFileImpl: () => `${process.pid} (node worker) Z 1 2 3 4\n`,
    };
    assert.equal(isProcessAlive(process.pid, options), false);

    assert.equal(isProcessAlive(process.pid, {
      ...options,
      readFileImpl: () => `${process.pid} (node worker) S 1 2 3 4\n`,
    }), true);

    assert.equal(isProcessAlive(process.pid, {
      ...options,
      readFileImpl: () => { throw new Error("proc state unavailable"); },
    }), true, "unknown Linux process state must fail closed as alive");
  });

  it("uses process creation time and path as native Windows identity", () => {
    let command = null;
    const identity = getProcessIdentity(42, {
      platform: "win32",
      runCommandCheckedImpl: (name, args) => {
        command = { name, args };
        return { stdout: "638900000000000000|C:\\Program Files\\nodejs\\node.exe\r\n" };
      },
    });
    assert.equal(identity, "638900000000000000|C:\\Program Files\\nodejs\\node.exe");
    assert.equal(command.name, "powershell.exe");
    assert.equal(command.args.includes("-NonInteractive"), true);
  });

  it("fails honestly when graceful Windows SIGINT is unavailable", async () => {
    const identity = "638900000000000000|C:\\node.exe";
    const receipt = await interruptClaudeProcess(42, identity, {
      platform: "win32",
      runCommandCheckedImpl: () => ({ stdout: `${identity}\r\n` }),
    });
    assert.equal(receipt.interrupted, false);
    assert.match(receipt.note, /Graceful SIGINT is unavailable/);
  });

  it("uses taskkill semantics for destructive Windows cancellation", async () => {
    let invocation = null;
    const identity = "638900000000000000|C:\\node.exe";
    const receipt = await cancelClaudeProcess(42, identity, {
      platform: "win32",
      runCommandCheckedImpl: () => ({ stdout: `${identity}\r\n` }),
      runCommandImpl: (command, args) => {
        invocation = { command, args };
        return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
      },
      isProcessAliveImpl: () => false,
    });
    assert.equal(receipt.cancelled, true);
    assert.deepEqual(invocation, {
      command: "taskkill",
      args: ["/PID", "42", "/T", "/F"],
    });
  });

  it("refuses missing and mismatched identities without signalling", async () => {
    const missing = await interruptClaudeProcess(42, null, { platform: "linux" });
    assert.equal(missing.interrupted, false);
    assert.equal(missing.controlFailure, "missing_identity");

    let signalled = false;
    const mismatch = await cancelClaudeProcess(42, "expected", {
      platform: "linux",
      runCommandCheckedImpl: () => ({ stdout: "different\n" }),
      killImpl: () => { signalled = true; },
    });
    assert.equal(mismatch.cancelled, false);
    assert.equal(mismatch.controlFailure, "identity_mismatch");
    assert.equal(signalled, false);
  });

  it("keeps non-ESRCH Linux signal failures explicit for interrupt and cancel", async () => {
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const options = {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: () => { throw denied; },
    };

    const interrupted = await interruptClaudeProcess(42, "identity", options);
    assert.equal(interrupted.interrupted, false);
    assert.equal(interrupted.controlFailure, "EPERM");
    assert.equal(interrupted.controlFailureCode, "EPERM");
    assert.match(interrupted.note, /EPERM/);

    const cancelled = await cancelClaudeProcess(42, "identity", options);
    assert.equal(cancelled.cancelled, false);
    assert.equal(cancelled.controlFailure, "EPERM");
    assert.equal(cancelled.controlFailureCode, "EPERM");
    assert.match(cancelled.note, /EPERM/);
  });

  it("keeps non-ESRCH Linux liveness probe failures explicit after a delivered signal", async () => {
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    let calls = 0;
    const cancelled = await cancelClaudeProcess(42, "identity", {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: (_target, signal) => {
        calls += 1;
        if (signal === 0) throw denied;
      },
    });
    assert.equal(cancelled.cancelled, false);
    assert.equal(cancelled.controlFailure, "EPERM");
    assert.equal(calls, 2, "SIGTERM plus one liveness probe");
  });

  it("treats only ESRCH as an already-absent Linux process group", async () => {
    const absent = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const options = {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: () => { throw absent; },
    };

    const interrupted = await interruptClaudeProcess(42, "identity", options);
    assert.equal(interrupted.interrupted, true);
    assert.match(interrupted.note, /ESRCH/);

    const cancelled = await cancelClaudeProcess(42, "identity", options);
    assert.equal(cancelled.cancelled, true);
    assert.match(cancelled.note, /ESRCH/);
  });

  it("requests interruption without waiting for the process to exit", async () => {
    let signalled = null;
    const start = Date.now();
    const receipt = await requestClaudeInterrupt(42, "identity", {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: (target, signal) => { signalled = { target, signal }; },
    });
    const elapsedMs = Date.now() - start;
    assert.equal(receipt.requested, true);
    assert.equal(receipt.requestFailure, null);
    assert.deepEqual(signalled, { target: -42, signal: "SIGINT" });
    // A request-only helper never runs the bounded observation window: it
    // must not silently reuse `interruptClaudeProcess`'s 5-second wait.
    assert.ok(elapsedMs < 200, `request-only interrupt took ${elapsedMs}ms`);
  });

  it("refuses missing/mismatched identity and unsupported platform as structured codes, never note text", async () => {
    const missing = await requestClaudeInterrupt(42, null, { platform: "linux" });
    assert.equal(missing.requested, false);
    assert.equal(missing.requestFailure, "missing_identity");
    assert.equal("note" in missing, false);

    const mismatch = await requestClaudeInterrupt(42, "expected", {
      platform: "linux",
      validateProcessIdentityImpl: () => false,
    });
    assert.equal(mismatch.requested, false);
    assert.equal(mismatch.requestFailure, "identity_mismatch");

    const unsupported = await requestClaudeInterrupt(42, "identity", {
      platform: "win32",
      validateProcessIdentityImpl: () => true,
    });
    assert.equal(unsupported.requested, false);
    assert.equal(unsupported.requestFailure, "unsupported_platform");
  });

  it("reports an already-absent process group and a real signal failure as distinct structured codes", async () => {
    const absent = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const absentReceipt = await requestClaudeInterrupt(42, "identity", {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: () => { throw absent; },
    });
    assert.equal(absentReceipt.requested, false);
    assert.equal(absentReceipt.requestFailure, "process_absent");

    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const deniedReceipt = await requestClaudeInterrupt(42, "identity", {
      platform: "linux",
      validateProcessIdentityImpl: () => true,
      killImpl: () => { throw denied; },
    });
    assert.equal(deniedReceipt.requested, false);
    assert.equal(deniedReceipt.requestFailure, "EPERM");
    assert.equal(deniedReceipt.controlFailureCode, "EPERM");
  });
});
