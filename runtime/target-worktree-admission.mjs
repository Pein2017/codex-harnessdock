/** SPDX-License-Identifier: Apache-2.0 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveGitCommonDirectory } from "./promotion-gate.mjs";

function admissionError(code) {
  return Object.assign(new Error(code), { code });
}

function existingDirectory(value, code) {
  try {
    const canonical = fs.realpathSync.native(value);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw admissionError(code);
  }
}

function worktreeInventory(controlRoot) {
  const result = spawnSync("git", ["-C", controlRoot, "-c", "core.quotePath=false", "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw admissionError("target_inventory_unavailable");
  const entries = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? true : line.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      // Git C-quotes paths it cannot represent unambiguously in the line
      // format. Never decode or shell-evaluate that text: only one raw,
      // absolute, control-free path can match an already-canonical target.
      const hasControl = typeof value === "string" && [...value].some((character) => {
        const code = character.codePointAt(0);
        return code <= 31 || code === 127;
      });
      const unambiguous = typeof value === "string" && path.isAbsolute(value) &&
        !hasControl && !value.startsWith('"');
      current = { worktree: unambiguous ? value : null, prunable: false };
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function observeTarget(controlRoot, executionRoot) {
  const observedControl = existingDirectory(controlRoot, "control_root_invalid");
  const observedExecution = existingDirectory(executionRoot, "target_missing");
  if (observedControl !== controlRoot || observedExecution !== executionRoot) {
    throw admissionError("target_owner_drift");
  }
  const entry = worktreeInventory(controlRoot).find(
    (candidate) => candidate.worktree === executionRoot,
  );
  if (!entry) throw admissionError("target_not_registered");
  if (entry.prunable) throw admissionError("target_prunable");
  let controlCommon;
  let executionCommon;
  try {
    controlCommon = resolveGitCommonDirectory(controlRoot);
    executionCommon = resolveGitCommonDirectory(executionRoot);
  } catch {
    throw admissionError("target_owner_mismatch");
  }
  if (controlCommon !== executionCommon) throw admissionError("target_owner_mismatch");
  return { controlRoot: observedControl, executionRoot: observedExecution, commonDirectory: controlCommon };
}

/**
 * Admit one explicit registered sibling worktree, or use the trusted control
 * root when the selector is omitted. This function never mutates Git state.
 * @param {{controlRoot: string, targetWorktree?: string|null}} input
 */
export function admitTargetWorktree({ controlRoot, targetWorktree }) {
  const canonicalControl = existingDirectory(controlRoot, "control_root_invalid");
  if (targetWorktree == null) {
    return Object.freeze({ controlRoot: canonicalControl, executionRoot: canonicalControl });
  }
  if (typeof targetWorktree !== "string" || targetWorktree.includes("\0") || !path.isAbsolute(targetWorktree)) {
    throw admissionError("target_not_absolute");
  }
  const canonicalTarget = existingDirectory(targetWorktree, "target_missing");
  if (canonicalTarget === canonicalControl) throw admissionError("target_is_control_root");
  const first = observeTarget(canonicalControl, canonicalTarget);
  let second;
  try {
    second = observeTarget(canonicalControl, canonicalTarget);
  } catch {
    throw admissionError("target_owner_drift");
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) throw admissionError("target_owner_drift");
  return Object.freeze({ controlRoot: first.controlRoot, executionRoot: first.executionRoot });
}
