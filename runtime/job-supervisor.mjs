/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * One logical Claude Code task session across subprocess attempts.
 */

import { cancelClaudeProcess, runClaudeTurn } from "./claude-headless-adapter.mjs";
import { getProcessIdentity } from "./process-control.mjs";
import {
  acknowledgeSteeringMessage,
  claimJobSessionLease,
  getSteeringSnapshot,
  listPendingSteeringMessages,
  markSteeringMessageDispatched,
  mutateJob,
  readJobFile,
  tryCloseSteeringWindow,
} from "./job-store.mjs";

export const DEFAULT_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
export const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const MIN_TRUSTED_OUTPUT_OVERLAP = 8;
const MAX_AGGREGATED_RECEIPTS = 256;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedRetryPolicy(policy = {}, env = process.env) {
  const envAttempts = Number(env.CODEX_HARNESSDOCK_CLAUDE_RECONNECT_ATTEMPTS);
  const envBaseDelay = Number(env.CODEX_HARNESSDOCK_CLAUDE_RECONNECT_BASE_DELAY_MS);
  return {
    maxReconnectAttempts: Math.max(
      0,
      Number.isFinite(policy.maxReconnectAttempts)
        ? Number(policy.maxReconnectAttempts)
        : Number.isFinite(envAttempts)
          ? envAttempts
          : DEFAULT_RECONNECT_ATTEMPTS
    ),
    baseDelayMs: Math.max(
      0,
      Number.isFinite(policy.baseDelayMs)
        ? Number(policy.baseDelayMs)
        : Number.isFinite(envBaseDelay)
          ? envBaseDelay
          : DEFAULT_RECONNECT_BASE_DELAY_MS
    ),
    jitterRatio: Math.max(
      0,
      Number.isFinite(policy.jitterRatio)
        ? Number(policy.jitterRatio)
        : DEFAULT_RECONNECT_JITTER_RATIO
    ),
  };
}

function patchSupervisorJob(workspaceRoot, jobId, patch) {
  return mutateJob(workspaceRoot, jobId, (job) => ({ ...job, ...patch }));
}

function transportText(result) {
  return [result?.stderr, result?.warning]
    .filter(Boolean)
    .join("\n");
}

function looksLikeTransportFailure(result) {
  if (result?.failureClass === "usage_or_subscription_limit") return false;
  if (result?.failureClass === "transport_closed_resumable") return true;
  return /connection closed mid-response|socket (?:closed|reset|hang up)|\bECONNRESET\b|\bEPIPE\b|stream(?:ing)? (?:idle )?timeout|timed out while streaming|\bHTTP\s*(?:408|429|5\d\d)\b/i.test(
    transportText(result)
  );
}

function terminalIsError(event) {
  return Boolean(
    event?.is_error === true ||
      (event?.subtype && event.subtype !== "success")
  );
}

function computeBackoffMs(policy, reconnectAttempt, random) {
  const exponential = policy.baseDelayMs * (2 ** Math.max(0, reconnectAttempt - 1));
  if (!exponential || !policy.jitterRatio) return exponential;
  const spread = exponential * policy.jitterRatio;
  return Math.max(0, Math.round(exponential - spread + random() * spread * 2));
}

async function waitForReconnect({
  workspaceRoot,
  jobId,
  delayMs,
  sleep,
}) {
  let remaining = delayMs;
  do {
    const job = readJobFile(workspaceRoot, jobId);
    if (!job || job.status !== "running") return false;
    if (remaining <= 0) return true;
    const step = Math.min(remaining, 100);
    await sleep(step);
    remaining -= step;
  } while (remaining >= 0);
  return readJobFile(workspaceRoot, jobId)?.status === "running";
}

export function mergeAttemptOutput(existing, next) {
  const left = String(existing ?? "");
  const right = String(next ?? "");
  if (!left) return right;
  if (!right || left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;
  const maxOverlap = Math.min(left.length, right.length);
  for (let overlap = maxOverlap; overlap >= MIN_TRUSTED_OUTPUT_OVERLAP; overlap -= 1) {
    if (left.endsWith(right.slice(0, overlap))) {
      return left + right.slice(overlap);
    }
  }
  return `${left}\n${right}`;
}

export function buildRecoveryPrompt({
  jobId,
  reconnectAttempt,
  uncertainSteering = [],
}) {
  const lines = [
    `Transport recovery attempt ${reconnectAttempt} for Claude plugin job ${jobId}.`,
    "Continue the interrupted turn from the persisted Claude conversation and current workspace state.",
    "Do not repeat completed side-effecting actions. Continue from the last incomplete step and finish the requested result.",
  ];
  if (uncertainSteering.length > 0) {
    lines.push(
      "The following steering messages were written before the disconnect but their replay acknowledgement was not observed. Honor each only if it is not already present in the resumed conversation:"
    );
    for (const message of uncertainSteering) {
      lines.push(`- sequence ${message.sequence}: ${message.text}`);
    }
  }
  return lines.join("\n");
}

function uncertainSteeringMessages(workspaceRoot, jobId) {
  const messages = readJobFile(workspaceRoot, jobId)?.steering?.messages;
  return Array.isArray(messages)
    ? messages.filter((message) => message.dispatchedAt && !message.acknowledgedAt)
    : [];
}

function attemptReceipt(result, attempt, startedAt, completedAt) {
  return {
    attempt,
    startedAt,
    completedAt,
    status: result.status,
    exitCode: result.exitCode ?? null,
    failureClass: result.failureClass ?? null,
    sessionId: result.sessionId ?? null,
    lastByteAt: result.lastByteAt ?? null,
    partialOutput: result.finalMessage ?? "",
    assistantOutputObserved: result.assistantOutputObserved === true,
    toolUses: Array.isArray(result.toolUses) ? result.toolUses : [],
    touchedFiles: Array.isArray(result.touchedFiles) ? result.touchedFiles : [],
    hookReceipts: Array.isArray(result.runtimeReceipt?.hookReceipts)
      ? result.runtimeReceipt.hookReceipts
      : [],
  };
}

function appendUniqueBounded(target, values, keyOf) {
  const seen = new Set(target.map(keyOf));
  for (const value of Array.isArray(values) ? values : []) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(value);
    if (target.length > MAX_AGGREGATED_RECEIPTS) target.shift();
  }
}

function collectAttemptReceipts(aggregate, result) {
  appendUniqueBounded(aggregate.toolUses, result.toolUses, (value) => JSON.stringify(value));
  appendUniqueBounded(aggregate.touchedFiles, result.touchedFiles, (value) => String(value));
  appendUniqueBounded(aggregate.terminalEvents, result.terminalEvents, (value) => JSON.stringify(value));
  appendUniqueBounded(
    aggregate.hookReceipts,
    result.runtimeReceipt?.hookReceipts,
    (value) => JSON.stringify(value)
  );
}

function withAggregateReceipts(result, aggregate) {
  return {
    ...result,
    toolUses: [...aggregate.toolUses],
    touchedFiles: [...aggregate.touchedFiles],
    terminalEvents: [...aggregate.terminalEvents],
    runtimeReceipt: {
      ...(result.runtimeReceipt ?? {}),
      hookReceipts: [...aggregate.hookReceipts],
    },
    providerReportedMetrics: result.providerReportedMetrics ?? null,
  };
}

function cancelledDuringRecoveryResult(sessionId, attempts, recoveryAttempts, finalMessage) {
  return {
    status: "failed",
    exitCode: 130,
    sessionId,
    finalMessage,
    structuredOutput: null,
    toolUses: [],
    touchedFiles: [],
    stderr: "Recovery stopped because the job left running state.",
    failureClass: "cancelled_or_interrupted",
    failureReason: "job left running state during reconnect backoff",
    resumable: false,
    attempts,
    recoveryAttempts,
    providerReportedMetrics: null,
  };
}

export async function runClaudeTaskSession({
  workspaceRoot,
  jobId,
  cwd,
  prompt,
  write,
  claudeOptions = {},
  harnessInstance = null,
  onProgress = null,
  onSpawn = null,
  runAttempt = runClaudeTurn,
  retryPolicy = {},
  sleep = defaultSleep,
  random = Math.random,
  automaticRecovery = "same_session_recovery_prompt",
}) {
  if (automaticRecovery !== "same_session_recovery_prompt") {
    throw new Error(
      `Claude supervisor recovery is unavailable for automaticRecovery=${JSON.stringify(automaticRecovery)}.`
    );
  }
  /** @type {{ env?: NodeJS.ProcessEnv, resumeSessionId?: string | null, [key: string]: unknown }} */
  const optionBag = claudeOptions;
  // The Driver owns its native instance identity; the version-1 fallback keeps
  // a direct caller that only knows the Claude config directory working.
  const sessionOwner = harnessInstance ?? optionBag.env?.CLAUDE_CONFIG_DIR;
  const policy = normalizedRetryPolicy(retryPolicy, optionBag.env ?? process.env);
  const attempts = [];
  let recoveryAttempts = 0;
  let currentPrompt = String(prompt ?? "");
  let resumeSessionId = optionBag.resumeSessionId ?? null;
  let sessionId = resumeSessionId;
  let combinedOutput = "";
  let leasedSessionId = resumeSessionId;
  let sessionOwnershipError = null;
  let currentProcessReceipt = null;
  const aggregateReceipts = {
    toolUses: [],
    touchedFiles: [],
    terminalEvents: [],
    hookReceipts: [],
  };

  patchSupervisorJob(workspaceRoot, jobId, {
    acceptingSteering: true,
    recoveryAttempts: 0,
    attempts: [],
  });

  while (true) {
    const jobBeforeAttempt = readJobFile(workspaceRoot, jobId);
    if (!jobBeforeAttempt || jobBeforeAttempt.status !== "running") {
      return withAggregateReceipts(cancelledDuringRecoveryResult(
        sessionId,
        attempts,
        recoveryAttempts,
        combinedOutput
      ), aggregateReceipts);
    }

    const attempt = attempts.length + 1;
    const startedAt = new Date().toISOString();
    let streamedAttemptOutput = "";
    let lastPartialPersistedAt = 0;
    const handleAttemptProgress = (event) => {
      if (event?.threadId && !sessionOwnershipError) {
        const observedSessionId = String(event.threadId);
        if (resumeSessionId && observedSessionId !== resumeSessionId) {
          sessionOwnershipError = new Error(
            `Claude session drift: expected ${resumeSessionId}, observed ${observedSessionId}.`
          );
        } else if (leasedSessionId !== observedSessionId) {
          try {
            claimJobSessionLease(
              workspaceRoot,
              jobId,
              sessionOwner,
              observedSessionId
            );
            leasedSessionId = observedSessionId;
          } catch (error) {
            sessionOwnershipError = error instanceof Error
              ? error
              : new Error(String(error));
          }
        }
        if (sessionOwnershipError && currentProcessReceipt?.pid) {
          void cancelClaudeProcess(
            currentProcessReceipt.pid,
            currentProcessReceipt.pidIdentity
          );
        }
      }
      if (event?.kind === "text" && typeof event.text === "string") {
        streamedAttemptOutput += event.text;
        const now = Date.now();
        if (lastPartialPersistedAt === 0 || now - lastPartialPersistedAt >= 250) {
          lastPartialPersistedAt = now;
          patchSupervisorJob(workspaceRoot, jobId, {
            partialOutput: mergeAttemptOutput(combinedOutput, streamedAttemptOutput),
            lastByteAt: new Date(now).toISOString(),
          });
        }
      }
      onProgress?.(event);
    };
    patchSupervisorJob(workspaceRoot, jobId, {
      phase: recoveryAttempts > 0 ? "reconnect_starting" : "starting_attempt",
      acceptingSteering: true,
      recoveryAttempts,
    });

    let result = await runAttempt(cwd, currentPrompt, {
      ...optionBag,
      inputFormat: "stream-json",
      replayUserMessages: true,
      includeHookEvents: true,
      resumeSessionId: resumeSessionId ?? undefined,
      onSpawn: async (processReceipt) => {
        const accepted = onSpawn
          ? await onSpawn(processReceipt)
          : true;
        if (accepted !== true) {
          return false;
        }
        currentProcessReceipt = processReceipt;
        try {
          patchSupervisorJob(workspaceRoot, jobId, {
            phase: "running_attempt",
          });
        } catch {
          // Child acceptance is already durable in the runner CAS. A best-
          // effort phase label must not turn that accepted boundary into a
          // false rejection or suppress the prompt after the marker cleared.
        }
        return true;
      },
      onProgress: handleAttemptProgress,
      pollInput: async () =>
        listPendingSteeringMessages(workspaceRoot, jobId).map((message) => ({
          sequence: message.sequence,
          text: message.text,
          kind: message.kind,
        })),
      onInputDispatched: (message) =>
        markSteeringMessageDispatched(workspaceRoot, jobId, message.sequence, {
          deliveryMode: "live_stdin",
          attempt,
        }),
      onInputAcknowledged: (message) =>
        acknowledgeSteeringMessage(workspaceRoot, jobId, message.sequence),
      onTerminal: async ({ event, pumpedInputs }) => {
        if (terminalIsError(event)) return true;
        if (pumpedInputs > 0) return false;
        return tryCloseSteeringWindow(workspaceRoot, jobId).closed;
      },
    });
    currentProcessReceipt = null;

    if (sessionOwnershipError) {
      const ownershipError = /** @type {Error} */ (sessionOwnershipError);
      result = {
        ...result,
        status: "failed",
        warning: ownershipError.message,
        failureClass: ownershipError.message.includes("session drift")
          ? "protocol_session_drift"
          : "session_owner_conflict",
        failureReason: ownershipError.message,
        resumable: false,
      };
    }

    if (
      resumeSessionId &&
      ((result.sessionId && result.sessionId !== resumeSessionId) ||
        (result.status === "completed" && !result.sessionId))
    ) {
      const observed = result.sessionId ?? "missing";
      result = {
        ...result,
        status: "failed",
        warning: `Claude session drift: expected ${resumeSessionId}, observed ${observed}.`,
        failureClass: "protocol_session_drift",
        failureReason: `expected session ${resumeSessionId}, observed ${observed}`,
        resumable: false,
      };
    }

    if (!resumeSessionId && result.sessionId && leasedSessionId !== result.sessionId) {
      try {
        claimJobSessionLease(
          workspaceRoot,
          jobId,
          sessionOwner,
          result.sessionId
        );
        leasedSessionId = result.sessionId;
      } catch (error) {
        result = {
          ...result,
          status: "failed",
          warning: error instanceof Error ? error.message : String(error),
          failureClass: "session_owner_conflict",
          failureReason: error instanceof Error ? error.message : String(error),
          resumable: false,
        };
      }
    }

    sessionId = result.failureClass === "protocol_session_drift"
      ? sessionId
      : result.sessionId ?? sessionId;
    combinedOutput = mergeAttemptOutput(combinedOutput, result.finalMessage);
    collectAttemptReceipts(aggregateReceipts, result);
    const completedAt = new Date().toISOString();
    attempts.push(attemptReceipt(result, attempt, startedAt, completedAt));
    patchSupervisorJob(workspaceRoot, jobId, {
      attempts,
      recoveryAttempts,
      threadId: sessionId ?? null,
      partialOutput: combinedOutput,
      runtimeReceipt: result.runtimeReceipt ?? null,
      lastFailureClass: result.failureClass ?? null,
      lastByteAt: result.lastByteAt ?? null,
      pid: null,
      pidIdentity: null,
    });

    if (result.status === "completed") {
      patchSupervisorJob(workspaceRoot, jobId, {
        acceptingSteering: false,
        phase: "finalizing",
      });
      return withAggregateReceipts({
        ...result,
        sessionId,
        // Attempt aggregation is progress evidence only. The Driver-selected
        // outer-assistant message from the completed attempt is the handoff.
        finalMessage: result.finalMessage,
        attempts,
        recoveryAttempts,
        steering: getSteeringSnapshot(workspaceRoot, jobId),
      }, aggregateReceipts);
    }

    if (result.failureClass === "cancelled_or_interrupted") {
      patchSupervisorJob(workspaceRoot, jobId, { acceptingSteering: false });
      return withAggregateReceipts({
        ...result,
        sessionId,
        finalMessage: combinedOutput,
        attempts,
        recoveryAttempts,
      }, aggregateReceipts);
    }

    const transportFailure = looksLikeTransportFailure(result);
    if (!transportFailure) {
      patchSupervisorJob(workspaceRoot, jobId, { acceptingSteering: false });
      return withAggregateReceipts({
        ...result,
        sessionId,
        finalMessage: combinedOutput,
        attempts,
        recoveryAttempts,
      }, aggregateReceipts);
    }

    const observedSideEffects =
      (Array.isArray(result.toolUses) && result.toolUses.length > 0) ||
      (Array.isArray(result.touchedFiles) && result.touchedFiles.length > 0);
    if (!sessionId && (write || observedSideEffects)) {
      const warning =
        "Transport failed after possible side effects without a Claude session id; refusing to replay the task automatically.";
      patchSupervisorJob(workspaceRoot, jobId, {
        acceptingSteering: false,
        phase: "attention_required",
        errorMessage: warning,
      });
      return withAggregateReceipts({
        ...result,
        sessionId: null,
        finalMessage: combinedOutput,
        warning,
        requiresAttention: true,
        attempts,
        recoveryAttempts,
      }, aggregateReceipts);
    }

    if (recoveryAttempts >= policy.maxReconnectAttempts) {
      const manualResumeCommand = sessionId ? `claude --resume ${sessionId}` : null;
      const warning = manualResumeCommand
        ? `Automatic recovery budget exhausted. Resume manually with: ${manualResumeCommand}`
        : "Automatic recovery budget exhausted without a resumable session id.";
      patchSupervisorJob(workspaceRoot, jobId, {
        acceptingSteering: false,
        phase: "failed",
        errorMessage: warning,
        manualResumeCommand,
      });
      return withAggregateReceipts({
        ...result,
        sessionId,
        finalMessage: combinedOutput,
        warning,
        manualResumeCommand,
        attempts,
        recoveryAttempts,
      }, aggregateReceipts);
    }

    recoveryAttempts += 1;
    resumeSessionId = sessionId;
    currentPrompt = sessionId
      ? buildRecoveryPrompt({
          jobId,
          reconnectAttempt: recoveryAttempts,
          uncertainSteering: uncertainSteeringMessages(workspaceRoot, jobId),
        })
      : String(prompt ?? "");
    const delayMs = computeBackoffMs(policy, recoveryAttempts, random);
    patchSupervisorJob(workspaceRoot, jobId, {
      phase: "reconnect_backoff",
      acceptingSteering: true,
      recoveryAttempts,
      nextReconnectAt: new Date(Date.now() + delayMs).toISOString(),
      // The Claude child has exited, but this supervisor worker remains alive
      // during backoff. Persist its identity so the stale-job reaper does not
      // mistake a healthy recovery loop for an orphaned task.
      pid: null,
      pidIdentity: null,
      workerPid: process.pid,
      workerPidIdentity: getProcessIdentity(process.pid),
    });
    onProgress?.({
      kind: "system",
      subtype: "reconnecting",
      message: `Reconnecting attempt ${recoveryAttempts}/${policy.maxReconnectAttempts}`,
      phase: "reconnect_backoff",
      threadId: sessionId,
    });

    const shouldRetry = await waitForReconnect({
      workspaceRoot,
      jobId,
      delayMs,
      sleep,
    });
    if (!shouldRetry) {
      return withAggregateReceipts(cancelledDuringRecoveryResult(
        sessionId,
        attempts,
        recoveryAttempts,
        combinedOutput
      ), aggregateReceipts);
    }
  }
}
