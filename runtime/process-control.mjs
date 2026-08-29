/**
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, expectedIdentity, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null, reason: "missing_pid" };
  }
  if (!expectedIdentity) {
    return { attempted: false, delivered: false, method: null, reason: "missing_identity" };
  }
  if (!validateProcessIdentity(pid, expectedIdentity, options)) {
    return { attempted: false, delivered: false, method: null, reason: "identity_mismatch" };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        if (!validateProcessIdentity(pid, expectedIdentity, options)) {
          return { attempted: false, delivered: false, method: null, reason: "identity_mismatch" };
        }
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}

/**
 * Get stable process identity for PID reuse detection.
 * Returns a string that is immutable for the process lifetime.
 */
export function getProcessIdentity(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const runCommandCheckedImpl = options.runCommandCheckedImpl ?? runCommandChecked;
  if (platform === "darwin") {
    const row = runCommandCheckedImpl("ps", ["-o", "lstart=,comm=", "-p", String(pid)]);
    return row.stdout.trim();
  }
  if (platform === "win32") {
    const script = [
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop`,
      "$p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path",
    ].join("; ");
    const row = runCommandCheckedImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return row.stdout.trim();
  }
  if (platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    return fields[19]; // starttime field
  }
  throw new Error(`Unsupported platform for process identity: ${platform}`);
}

export function validateProcessIdentity(pid, expectedIdentity, options = {}) {
  try {
    return getProcessIdentity(pid, options) === expectedIdentity;
  } catch {
    return false;
  }
}

function readLinuxProcessState(pid, readFileImpl) {
  const stat = String(readFileImpl(`/proc/${pid}/stat`, "utf8"));
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error("Linux process stat has no command boundary.");
  const state = stat.slice(closeParen + 2).trim().split(/\s+/u)[0];
  if (!state) throw new Error("Linux process stat has no state.");
  return state;
}

export function isProcessAlive(pid, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
  } catch {
    return false;
  }
  if ((options.platform ?? process.platform) !== "linux") return true;
  try {
    const state = readLinuxProcessState(pid, options.readFileImpl ?? readFileSync);
    return !["Z", "X", "x"].includes(state);
  } catch {
    // A successful signal-zero probe with unreadable proc state is ambiguous;
    // preserving the process/lock is safer than reclaiming a live owner.
    return true;
  }
}
