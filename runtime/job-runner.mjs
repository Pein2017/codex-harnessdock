/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persisted job execution and progress logging.
 */

import fs from "node:fs";
import process from "node:process";

import { getProcessIdentity } from "./process-control.mjs";
import { nowIso, ensureStateDir, patchJob, readJobFile, resolveJobLogFile, writeJobFile, cleanupOldJobs, transitionJob } from "./job-store.mjs";

export { nowIso };

export const OWNER_ROOT_ID_ENV = "CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID";
export const MAX_JOB_LOG_BYTES = 1024 * 1024;
export const PUBLIC_PROGRESS_TEXT_HEARTBEAT_MS = 10_000;
export const PUBLIC_PROGRESS_REPEAT_MILESTONE_MS = 2_000;
export const MAX_PUBLIC_PROGRESS_SUMMARY_BYTES = 192;
const LOG_TRUNCATION_MARKER = "[... earlier log output truncated ...]\n";
const SAFE_PUBLIC_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "Skill",
  "Task",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
]);

function sliceTextTailByBytes(text, maxBytes) {
  const normalized = typeof text === "string" ? text : String(text ?? "");
  if (!normalized || maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(mid), "utf8") > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let start = low;
  let retained = normalized.slice(start);
  while (start < normalized.length && Buffer.byteLength(retained, "utf8") > maxBytes) {
    start += 1;
    retained = normalized.slice(start);
  }
  return retained;
}

function trimLogFile(logFile, maxBytes = MAX_JOB_LOG_BYTES) {
  if (!logFile || !fs.existsSync(logFile) || maxBytes <= 0) {
    return;
  }

  const content = fs.readFileSync(logFile, "utf8");
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return;
  }

  let retained = content;
  while (Buffer.byteLength(retained, "utf8") > maxBytes) {
    const newlineIndex = retained.indexOf("\n");
    if (newlineIndex === -1 || newlineIndex === retained.length - 1) {
      break;
    }
    retained = retained.slice(newlineIndex + 1);
  }

  let output = retained;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    const markerBytes = Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8");
    if (markerBytes >= maxBytes) {
      output = sliceTextTailByBytes(output, maxBytes);
    } else {
      output =
        LOG_TRUNCATION_MARKER +
        sliceTextTailByBytes(output, maxBytes - markerBytes);
    }
  }

  fs.writeFileSync(logFile, output, "utf8");
}

function appendToBoundedLog(logFile, text) {
  if (!logFile || !text) {
    return;
  }
  fs.chmodSync(logFile, 0o600);
  fs.appendFileSync(logFile, text, "utf8");
  trimLogFile(logFile);
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      kind: typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : null,
      subtype: typeof value.subtype === "string" && value.subtype.trim() ? value.subtype.trim() : null,
      tool: typeof value.tool === "string" && value.tool.trim() ? value.tool.trim() : null,
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    kind: null,
    subtype: null,
    tool: null,
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

function boundedProgressSummary(value, maxBytes = MAX_PUBLIC_PROGRESS_SUMMARY_BYTES) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(`${normalized.slice(0, end)}...`, "utf8") > maxBytes) end -= 1;
  return `${normalized.slice(0, end)}...`;
}

export function safePublicToolName(value) {
  const name = String(value ?? "").trim();
  return SAFE_PUBLIC_TOOL_NAMES.has(name) ? name : null;
}

export function publicProgressFromEvent(event) {
  const normalized = normalizeProgressEvent(event);
  if (normalized.kind === "tool_use") {
    const tool = safePublicToolName(normalized.tool);
    return {
      activity: "tool",
      phase: "tool",
      summary: boundedProgressSummary(tool ? `Claude is using ${tool}.` : "Claude is using a tool."),
    };
  }
  if (normalized.kind === "thinking") {
    return { activity: "thinking", phase: "thinking", summary: "Claude is reasoning." };
  }
  if (normalized.kind === "text") {
    return { activity: "responding", phase: "running", summary: "Claude is drafting its response." };
  }
  if (normalized.kind === "system" && normalized.subtype === "init") {
    return { activity: "initialized", phase: "running", summary: "Claude session initialized." };
  }
  if (normalized.kind === "system" && normalized.subtype === "hook_response") {
    return { activity: "hook", phase: "hook", summary: "Claude completed a hook." };
  }
  if (normalized.kind === "system" && normalized.subtype === "api_retry") {
    return { activity: "retrying", phase: "retry", summary: "Claude is retrying an API request." };
  }
  if (normalized.kind === "system" && normalized.subtype === "reconnecting") {
    return { activity: "reconnecting", phase: "reconnect_backoff", summary: "Claude is reconnecting." };
  }
  return null;
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  appendToBoundedLog(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  appendToBoundedLog(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  ensureStateDir(workspaceRoot);
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  }
  fs.chmodSync(logFile, 0o600);
  if (title && fs.statSync(logFile).size === 0) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

/** @returns {{ stdio: import("node:child_process").StdioOptions, close: () => void }} */
export function createWorkerLogStdio(logFile) {
  const fd = fs.openSync(logFile, "a");
  /** @type {import("node:child_process").StdioOptions} */
  const stdio = ["ignore", fd, fd];
  return {
    stdio,
    close: () => fs.closeSync(fd),
  };
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const ownerRootId = String(
    options.ownerRootId ?? env[OWNER_ROOT_ID_ENV] ?? ""
  ).trim();
  const agentId = String(options.agentId ?? base.agentId ?? "").trim();
  if (agentId.includes("\0")) {
    throw new Error("Agent ID must not contain a null byte.");
  }
  return {
    ...base,
    createdAt: nowIso(),
    ...(ownerRootId ? { ownerRootId } : {}),
    ...(agentId ? { agentId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId, options = {}) {
  const initial = readJobFile(workspaceRoot, jobId)?.publicProgress ?? null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastPublicProgress = initial;
  let lastPublicProgressAt = initial?.updatedAt ? Date.parse(initial.updatedAt) : 0;
  let publicProgressRevision = Number(initial?.revision ?? 0);

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    const publicProgress = publicProgressFromEvent(normalized);
    if (publicProgress) {
      const observedAt = now();
      const fingerprint = `${publicProgress.activity}\0${publicProgress.phase}\0${publicProgress.summary}`;
      const priorFingerprint = lastPublicProgress
        ? `${lastPublicProgress.activity}\0${lastPublicProgress.phase}\0${lastPublicProgress.summary}`
        : null;
      const repeatInterval = ["responding", "thinking"].includes(publicProgress.activity)
        ? PUBLIC_PROGRESS_TEXT_HEARTBEAT_MS
        : PUBLIC_PROGRESS_REPEAT_MILESTONE_MS;
      if (fingerprint !== priorFingerprint || observedAt - lastPublicProgressAt >= repeatInterval) {
        publicProgressRevision += 1;
        lastPublicProgressAt = observedAt;
        lastPublicProgress = {
          revision: publicProgressRevision,
          ...publicProgress,
          updatedAt: new Date(observedAt).toISOString(),
        };
        patch.publicProgress = lastPublicProgress;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    patchJob(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[cc] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  let workerPidIdentity = job.workerPidIdentity ?? null;
  try { workerPidIdentity = getProcessIdentity(process.pid); } catch {}
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    workerPid: process.pid,
    workerPidIdentity,
    pid: null,
    pidIdentity: null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const claim = transitionJob(
    job.workspaceRoot,
    job.id,
    options.claimStatuses ?? ["queued"],
    "running",
    runningRecord
  );
  if (!claim.transitioned) {
    throw new Error(
      `Claude job ${job.id} cannot start from ${claim.previousStatus}; another worker or control action owns it.`
    );
  }

  // The adapter must await this callback before it sends any stdin bytes. This
  // CAS is therefore the durable launch boundary, not merely observability.
  const onSpawn = ({ pid, pidIdentity }) => {
    if (!Number.isFinite(pid) || !String(pidIdentity ?? "").trim()) {
      return false;
    }
    const transition = transitionJob(
      job.workspaceRoot,
      job.id,
      ["running"],
      "running",
      {
        pid,
        pidIdentity,
        preClaudeLaunch: false,
        safeFreshRetry: false,
      }
    );
    if (!transition.transitioned) {
      // The adapter owns the just-spawned process handle and terminates an
      // unaccepted child. Keeping that action there covers every rejection
      // path, including callback failures before this runner is involved.
      return false;
    }
    return true;
  };

  try {
    const execution = await runner(onSpawn);

    const currentJob = readJobFile(job.workspaceRoot, job.id);
    const interrupted =
      currentJob?.status === "interrupting" &&
      execution.payload?.failureClass === "cancelled_or_interrupted";
    // A successful result that raced with SIGINT remains completed. An
    // observed interrupted terminal is kept separate from destructive cancel.
    const statedTerminalStatus = ["completed", "failed", "interrupted", "unknown"]
      .includes(execution.terminalStatus)
      ? execution.terminalStatus
      : null;
    const completionStatus = statedTerminalStatus ?? (interrupted
      ? "interrupted"
      : execution.exitStatus === 0
        ? "completed"
        : "failed");
    const completedAt = nowIso();
    const terminalData = {
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      pidIdentity: null,
      workerPid: null,
      workerPidIdentity: null,
      phase:
        completionStatus === "completed"
          ? "done"
          : completionStatus === "interrupted"
            ? "interrupted"
            : completionStatus === "unknown" ? "unknown" : "failed",
      completedAt,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
    };

    const transitioned = transitionJob(
      job.workspaceRoot,
      job.id,
      currentJob?.status === "interrupting"
        ? ["interrupting"]
        : ["running"],
      completionStatus,
      terminalData
    );
    // If CAS failed, another actor (cancel) already moved the job to a different state — respect that

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    cleanupOldJobs(job.workspaceRoot);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();

    const currentJob = readJobFile(job.workspaceRoot, job.id);
    const terminalStatus = currentJob?.status === "interrupting" ? "interrupted" : "failed";
    const expectedStatuses = currentJob?.status === "interrupting"
      ? ["interrupting"]
      : ["running"];
    transitionJob(job.workspaceRoot, job.id, expectedStatuses, terminalStatus, {
      errorMessage,
      pid: null,
      pidIdentity: null,
      workerPid: null,
      workerPidIdentity: null,
      phase: terminalStatus,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? null
    });
    cleanupOldJobs(job.workspaceRoot);

    throw error;
  }
}
