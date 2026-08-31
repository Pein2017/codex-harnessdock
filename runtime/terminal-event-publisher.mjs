/** SPDX-License-Identifier: Apache-2.0 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUTCOMES = Object.freeze({ completed: "completed", failed: "failed", interrupted: "cancelled", cancelled: "cancelled", unknown: "settlement_uncertain" });
const MAX_OUTPUT = 8 * 1024;
const MAX_REASON = 256;

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be non-empty text.`);
  return value.trim();
}

function boundedReason(value) {
  const reason = [...String(value ?? "")].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").trim().slice(0, MAX_REASON);
  return reason || "terminal_state_unclassified";
}

export function buildWorkerTerminalEvent({ agentName, terminalJob }) {
  const status = String(terminalJob?.status ?? "");
  const outcome = OUTCOMES[status];
  if (!outcome) throw new Error("A worker terminal event requires one closed terminal job state.");
  const event = { kind: "worker_terminal", producer_task_id: text(agentName, "Agent name"), outcome };
  if (outcome !== "completed") {
    event.reason = outcome === "settlement_uncertain"
      ? "driver_unverifiable"
      : boundedReason(terminalJob?.normalizedTerminalResult?.failure?.reason ?? terminalJob?.failureClass ?? terminalJob?.phase);
  }
  return Object.freeze(event);
}

export async function publishWorkerTerminalEvent({ agentName, terminalJob, completion, completionDurable, state = /** @type {any} */ ({}), publish }) {
  if (!completionDurable) throw new Error("A durable completion is required before terminal publication.");
  if (state.terminalEventPublished) return { published: true, reason: "already_published" };
  if (state.terminalEventFailure) return { published: false, reason: "recorded_failure" };
  const event = buildWorkerTerminalEvent({ agentName, terminalJob });
  const receipt = await publish(event, completion);
  if (receipt?.accepted === false) {
    state.terminalEventPublished = false;
    state.terminalEventFailure = { reason: boundedReason(receipt.reason) };
    return { published: false, reason: state.terminalEventFailure.reason };
  }
  state.terminalEventPublished = true;
  state.terminalEvent = event;
  return { published: true, event };
}

export async function reconcileWorkerTerminalEvent({ agentName, terminalJob, completion, state = /** @type {any} */ ({}), publish, priorTerminalJob = null }) {
  if (priorTerminalJob && JSON.stringify(terminalJob) !== JSON.stringify(priorTerminalJob)) {
    throw new Error("Conflicting immutable terminal event rewrite.");
  }
  return publishWorkerTerminalEvent({ agentName, terminalJob, completion, completionDurable: true, state, publish });
}

function configured(env) {
  const executable = String(env?.CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN ?? "").trim();
  const runtimeRoot = String(env?.CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT ?? "").trim();
  if (!path.isAbsolute(executable) || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Terminal publisher executable is not configured as an absolute executable file.");
  }
  try { fs.accessSync(executable, fs.constants.X_OK); } catch {
    throw new Error("Terminal publisher executable is not executable.");
  }
  if (!path.isAbsolute(runtimeRoot) || !fs.statSync(runtimeRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Terminal publisher runtime root is not configured as an absolute directory.");
  }
  return { executable, runtimeRoot: fs.realpathSync.native(runtimeRoot) };
}

/** Redacted operator diagnostic: never expose executable, root, or descriptor. */
export function terminalPublisherReadiness(env = process.env) {
  try {
    configured(env);
    return Object.freeze({ configured: true, ready: true });
  } catch {
    return Object.freeze({ configured: Boolean(env?.CODEX_HARNESSDOCK_WAKE_PUBLISHER_BIN && env?.CODEX_HARNESSDOCK_WAKE_RUNTIME_ROOT), ready: false });
  }
}

function run(executable, args, env) {
  const result = spawnSync(executable, args, { shell: false, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_OUTPUT, env });
  if (result.error || result.status !== 0) throw new Error("Terminal publisher command failed.");
  let receipt;
  try { receipt = JSON.parse(String(result.stdout ?? "")); } catch { throw new Error("Terminal publisher returned an invalid receipt."); }
  return receipt;
}

export function preflightTerminalEventDescriptor({ descriptorPath, agentName, env }) {
  const descriptor = text(descriptorPath, "Terminal event descriptor path");
  if (!path.isAbsolute(descriptor)) throw new Error("Terminal event descriptor path must be absolute.");
  const { executable, runtimeRoot } = configured(env);
  const receipt = run(executable, ["--runtime-root", runtimeRoot, "event-worker-preflight", "--descriptor", descriptor, "--producer-task-id", text(agentName, "Agent name")], env);
  if (receipt?.compatible !== true || receipt?.producer_task_id !== agentName || typeof receipt?.token_fingerprint !== "string") {
    throw new Error("Terminal publisher descriptor receipt is incompatible.");
  }
  return Object.freeze({ descriptorPath: descriptor, reservationId: String(receipt.reservation_id ?? ""), tokenFingerprint: receipt.token_fingerprint });
}

export function publishTerminalEventWithCli({ descriptorPath, agentName, terminalJob, env }) {
  const { executable, runtimeRoot } = configured(env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harnessdock-terminal-event-"));
  const payload = path.join(directory, "event.json");
  try {
    fs.writeFileSync(payload, JSON.stringify(buildWorkerTerminalEvent({ agentName, terminalJob })), { mode: 0o600 });
    const receipt = run(executable, ["--runtime-root", runtimeRoot, "event-worker-publish", "--descriptor", descriptorPath, "--event-payload", payload], env);
    return { published: receipt?.state === "terminal", receipt: { published: receipt?.state === "terminal" } };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Publish only from a caller that has already made completion durable. */
export function publishBoundTerminalEvent({ store, agentId, terminalJob, env = process.env }) {
  const binding = store.terminalEventBinding(agentId);
  if (!binding || binding.binding.jobId !== terminalJob.id || binding.publication) return { published: false, reason: "not_bound_or_recorded" };
  try {
    const result = publishTerminalEventWithCli({
      descriptorPath: binding.binding.descriptorPath,
      agentName: store.resolveTarget(agentId).path,
      terminalJob,
      env,
    });
    store.recordTerminalEventPublication(agentId, { state: result.published ? "published" : "failed", jobId: terminalJob.id });
    return result;
  } catch {
    store.recordTerminalEventPublication(agentId, { state: "failed", jobId: terminalJob.id });
    return { published: false, reason: "publisher_failed" };
  }
}
