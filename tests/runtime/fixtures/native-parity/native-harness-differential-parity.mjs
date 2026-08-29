/** SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";

export const NATIVE_HARNESS_DIFFERENTIAL_PARITY_SCHEMA = "harnessdock.native-harness-differential-parity.v2";
export const NATIVE_HARNESS_IDS = Object.freeze(["claude-code", "pi", "opencode"]);
export const NATIVE_HARNESS_DIFFERENTIAL_DIMENSIONS = Object.freeze([
  "exact_model_effort_inventory",
  "argv_environment_or_request_transport",
  "native_configuration_inheritance",
  "prompt_authority_delta",
  "event_tool_order",
  "interrupt",
  "exact_session_continuation",
  "cross_process_turn_observation_or_reconciliation",
  "automatic_recovery_exact_session_transport",
  "terminal_classification",
  "route_drift",
  "native_usage_provenance",
  "process_lifecycle",
]);

const DRIVER_VERSIONS = Object.freeze({ "claude-code": "claude-code@3", pi: "pi@2", opencode: "opencode@1" });
const RECEIPT_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:@#/,;()\-]*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(message) { throw new Error(`Native differential parity composition: ${message}`); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is missing`);
  return value;
}
function safeText(value, label) {
  const text = required(value, label);
  if (text.length > 480 || !RECEIPT_TEXT.test(text)) fail(`${label} is not a sanitized receipt value`);
  return text;
}
function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}
function findRow(rows, dimension, label) {
  const matches = rows.filter((row) => row?.dimension === dimension);
  if (matches.length !== 1) fail(`${label} must have exactly one ${dimension} row`);
  return matches[0];
}
function requireResult(row, result, label) {
  if (row?.result !== result) fail(`${label} must be ${result}`);
  return row;
}
function localReference(file, section, receipt) {
  const label = `${file}#${section}`;
  safeText(label, "local evidence label");
  return { label, digest: digest(receipt) };
}
function derivedSources(directSource, harnessdockSource, evidence) {
  return {
    directSource: safeText(directSource, "direct source"),
    harnessdockSource: safeText(harnessdockSource, "HarnessDock source"),
    artifactDigest: digest(evidence),
  };
}
function cell({ harness, dimension, evidence, directSource, harnessdockSource, artifactDigest, mode, comparator, result, blockerReason, notApplicableBasis }) {
  if (!SHA256.test(artifactDigest ?? "")) fail("artifact digest is invalid");
  const body = {
    harness,
    driverVersion: DRIVER_VERSIONS[harness],
    capabilitySchemaVersion: 3,
    dimension,
    localEvidence: evidence,
    directSource: safeText(directSource, "direct source"),
    harnessdockSource: safeText(harnessdockSource, "HarnessDock source"),
    artifactDigest: required(artifactDigest, "artifact digest"),
    mode,
    comparator,
    result,
    ...(blockerReason ? { blockerReason } : {}),
    ...(notApplicableBasis ? { notApplicableBasis } : {}),
  };
  return { ...body, contentDigest: digest(body) };
}

function validateClaudeReceipt(receipt) {
  if (receipt?.schema !== "harnessdock.claude-native-differential-parity.v1") fail("Claude local receipt schema changed");
  const proven = requireArray(receipt.provenRows, "Claude provenRows");
  if (!proven.every((row) => typeof row === "string")) fail("Claude provenRows are malformed");
  const unproven = requireArray(receipt.unprovenRows, "Claude unprovenRows");
  if (receipt?.hold?.result !== "HOLD") fail("Claude local inventory prerequisite must remain HOLD");
  if (receipt?.notApplicable?.oldTurnObservation !== "turnObservation is unavailable in the current Claude route capability snapshot") {
    fail("Claude old-turn capability receipt changed");
  }
  return { proven: new Set(proven), unproven };
}

function validatePiReceipt(receipt) {
  if (receipt?.schemaVersion !== "pi-native-differential-v1" || receipt?.harness !== "pi") fail("Pi local receipt schema changed");
  const rows = requireArray(receipt.rows, "Pi rows");
  if (new Set(rows.map((row) => row?.dimension)).size !== rows.length) fail("Pi receipt has duplicate dimensions");
  for (const row of rows) {
    required(row?.dimension, "Pi row dimension");
    if (!["pass", "not_applicable"].includes(row?.result)) fail("Pi row has an open result");
    safeText(row.directSource, "Pi row direct source");
    safeText(row.harnessdockSource, "Pi row HarnessDock source");
    if (!SHA256.test(row?.artifactDigest ?? "")) fail("Pi row artifact digest is invalid");
    if (row.result === "not_applicable") {
      safeText(row.capability, "Pi N/A capability");
      safeText(row.observed, "Pi N/A observed capability value");
    }
  }
  requireArray(receipt.unprovenRows, "Pi unprovenRows");
  return rows;
}

function validateOpencodeReceipt(receipt) {
  const proven = requireArray(receipt?.provenRows, "OpenCode provenRows");
  const notApplicable = requireArray(receipt?.notApplicableRows, "OpenCode notApplicableRows");
  const unproven = requireArray(receipt?.unprovenRows, "OpenCode unprovenRows");
  const expectedDigest = digest({ provenRows: proven, notApplicableRows: notApplicable, unprovenRows: unproven });
  if (receipt.digest !== expectedDigest) fail("OpenCode local receipt digest does not match its contents");
  for (const row of notApplicable) {
    safeText(row?.capability, "OpenCode N/A capability");
    safeText(row?.observed, "OpenCode N/A observed capability value");
  }
  return { proven, notApplicable, unproven };
}

function provenEvidence(receipt, file, rows, dimension, localDimension = dimension) {
  const row = requireResult(findRow(rows, localDimension, file), "pass", `${file} ${localDimension}`);
  return { evidence: localReference(file, `provenRows/${localDimension}`, receipt), row };
}
function unprovenEvidence(receipt, file, rows, dimension, localDimension = dimension) {
  const row = findRow(rows, localDimension, file);
  if (row?.result !== "unproven") fail(`${file} ${localDimension} must remain unproven`);
  return { evidence: localReference(file, `unprovenRows/${localDimension}`, receipt), reason: safeText(row.reason, `${file} ${localDimension} reason`) };
}
function notApplicableEvidence(receipt, file, rows, dimension) {
  const row = requireResult(findRow(rows, dimension, file), "not_applicable", `${file} ${dimension}`);
  return {
    evidence: localReference(file, `notApplicableRows/${dimension}`, receipt), row,
    basis: { capability: safeText(row.capability, `${file} ${dimension} capability`), observed: safeText(row.observed, `${file} ${dimension} observed`) },
  };
}

export function composeNativeHarnessDifferentialParity({ claudeReceipt, piReceipt, opencodeReceipt }) {
  const claude = validateClaudeReceipt(claudeReceipt);
  const piRows = validatePiReceipt(piReceipt);
  const opencode = validateOpencodeReceipt(opencodeReceipt);
  const cells = [];
  const claudeFile = "claude-differential-receipt.json";
  const piFile = "pi-native-differential-receipt.json";
  const opencodeFile = "opencode-native-differential-parity.receipt.json";
  const claudeSources = (evidence) => derivedSources(
    "independent Claude stream-json control fixture",
    "Claude Driver differential receipt",
    evidence,
  );
  const opencodeSources = (evidence) => derivedSources(
    "independent OpenCode Server fixture",
    "OpenCode Driver differential receipt",
    evidence,
  );
  const piSources = (row) => ({
    directSource: safeText(row.directSource, "Pi row direct source"),
    harnessdockSource: safeText(row.harnessdockSource, "Pi row HarnessDock source"),
    artifactDigest: row.artifactDigest,
  });
  const claudePass = (dimension, rows, label = dimension) => {
    for (const row of rows) if (!claude.proven.has(row)) fail(`Claude ${row} was not executed`);
    const evidence = rows.map((row) => localReference(claudeFile, `provenRows/${row}`, claudeReceipt));
    cells.push(cell({
      harness: "claude-code", dimension,
      evidence, ...claudeSources(evidence),
      mode: "zero-model deterministic native comparison", comparator: label, result: "pass",
    }));
  };
  const claudeUnproven = (dimension, row, comparator) => {
    const source = claude.unproven.filter((entry) => entry?.row === row);
    if (source.length !== 1) fail(`Claude ${row} unproven evidence is missing`);
    const evidence = [localReference(claudeFile, `unprovenRows/${row}`, claudeReceipt)];
    cells.push(cell({
      harness: "claude-code", dimension, evidence, ...claudeSources(evidence),
      mode: "prerequisite evidence gap", comparator, result: "hold", blockerReason: safeText(source[0].reason, `Claude ${row} reason`),
    }));
  };
  {
    const evidence = [localReference(claudeFile, "hold", claudeReceipt)];
    cells.push(cell({
    harness: "claude-code", dimension: "exact_model_effort_inventory", evidence, ...claudeSources(evidence),
    mode: "zero-prompt negative control", comparator: "exact native selectable model and effort inventory", result: "hold",
    blockerReason: safeText(claudeReceipt.hold.reason, "Claude inventory HOLD reason"),
    }));
  }
  claudePass("argv_environment_or_request_transport", ["baseline_argv_environment"], "exact argv and allowlisted environment comparison");
  claudePass("native_configuration_inheritance", ["benign_config_inheritance_witness"], "benign native configuration witness comparison");
  claudePass("prompt_authority_delta", ["task_native_input", "closed_harnessdock_policy_delta", "write_authority_delta"], "bounded task and authority-only native delta comparison");
  claudePass("event_tool_order", ["ordered_stream_tool_events"], "ordered native stream and tool comparison");
  claudePass("interrupt", ["interrupt_behavior"], "native interrupt terminal comparison");
  claudeUnproven("exact_session_continuation", "exact_resume_same_session_fresh_process_mechanics", "provider-native session and distinct continuation turn binding");
  {
    const evidence = [localReference(claudeFile, "notApplicable/oldTurnObservation", claudeReceipt)];
    cells.push(cell({
    harness: "claude-code", dimension: "cross_process_turn_observation_or_reconciliation", evidence, ...claudeSources(evidence),
    mode: "capability-derived", comparator: "capability snapshot unavailability", result: "not_applicable",
    notApplicableBasis: { capability: "turnObservation", observed: "unavailable" },
    }));
  }
  claudeUnproven("automatic_recovery_exact_session_transport", "exact_session_transport_recovery_without_duplicate_input", "provider-defined interrupted-turn recovery binding");
  claudePass("terminal_classification", ["terminal_classification"], "closed native terminal comparison");
  claudePass("route_drift", ["route_drift"], "fresh native route drift refusal");
  claudePass("native_usage_provenance", ["provider_native_usage_source_fields"], "provider-native usage source comparison");
  claudePass("process_lifecycle", ["process_lifecycle_cleanup"], "native process cleanup comparison");

  const piPass = (dimension, localDimension, comparator) => {
    const { evidence, row } = provenEvidence(piReceipt, piFile, piRows, dimension, localDimension);
    cells.push(cell({
    harness: "pi", dimension, evidence: [evidence], ...piSources(row),
    mode: "zero-model deterministic native comparison", comparator, result: "pass",
    }));
  };
  piPass("exact_model_effort_inventory", "exact_model_per_model_effort_inventory", "exact native model and effort inventory comparison");
  piPass("argv_environment_or_request_transport", "argv_environment", "exact argv and environment comparison");
  piPass("native_configuration_inheritance", "configuration_inheritance_witness", "deterministic native configuration sentinel comparison");
  piPass("prompt_authority_delta", "prompt_authority_native_input", "authority-only native input comparison");
  piPass("event_tool_order", "ordered_events", "ordered native event comparison");
  piPass("interrupt", "interrupt_request_behavior", "native interrupt request comparison");
  piPass("exact_session_continuation", "exact_session_continuation", "same native session and distinct provider-native history identities");
  for (const dimension of ["cross_process_turn_observation_or_reconciliation", "automatic_recovery_exact_session_transport"]) {
    const { evidence, row, basis } = notApplicableEvidence(piReceipt, piFile, piRows, dimension);
    cells.push(cell({ harness: "pi", dimension, evidence: [evidence], ...piSources(row), mode: "capability-derived", comparator: "capability snapshot unavailability", result: "not_applicable", notApplicableBasis: basis }));
  }
  piPass("terminal_classification", "terminal_classification", "closed native terminal comparison");
  piPass("route_drift", "route_drift", "fresh native route drift refusal");
  piPass("native_usage_provenance", "native_usage_source_fields", "provider-native usage source comparison");
  piPass("process_lifecycle", "lifecycle_process_cleanup", "native process cleanup comparison");

  const opencodePass = (dimension, localDimension, comparator) => {
    const { evidence } = provenEvidence(opencodeReceipt, opencodeFile, opencode.proven, dimension, localDimension);
    cells.push(cell({
    harness: "opencode", dimension, evidence: [evidence], ...opencodeSources([evidence]),
    mode: "zero-model deterministic native comparison", comparator, result: "pass",
    }));
  };
  opencodePass("exact_model_effort_inventory", "exact_model_effort_inventory", "exact native model and effort inventory comparison");
  opencodePass("argv_environment_or_request_transport", "request_transport_environment", "exact normalized native request transport comparison");
  opencodePass("native_configuration_inheritance", "native_configuration_inheritance", "independent native config and resolved Agent witness comparison");
  opencodePass("prompt_authority_delta", "driver_authority_non_prompt_invariance", "authority-only non-prompt request comparison");
  opencodePass("event_tool_order", "ordered_request_event_tool_observations", "ordered native request event and tool comparison");
  for (const dimension of ["interrupt", "exact_session_continuation", "cross_process_turn_observation_or_reconciliation", "automatic_recovery_exact_session_transport"]) {
    const { evidence, basis } = notApplicableEvidence(opencodeReceipt, opencodeFile, opencode.notApplicable, dimension);
    cells.push(cell({ harness: "opencode", dimension, evidence: [evidence], ...opencodeSources([evidence]), mode: "capability-derived", comparator: "capability snapshot unavailability", result: "not_applicable", notApplicableBasis: basis }));
  }
  opencodePass("terminal_classification", "terminal_classification", "closed native terminal comparison");
  opencodePass("route_drift", "route_drift", "fresh native route drift refusal");
  opencodePass("native_usage_provenance", "provider_native_usage_source_fields", "provider-native usage source comparison");
  {
    const { evidence: direct } = provenEvidence(opencodeReceipt, opencodeFile, opencode.proven, "process_lifecycle", "direct_executable_process_lifecycle_comparison");
    const { evidence: managed } = provenEvidence(opencodeReceipt, opencodeFile, opencode.proven, "process_lifecycle", "managed_service_process_lifecycle");
    const evidence = [direct, managed];
    cells.push(cell({
      harness: "opencode", dimension: "process_lifecycle", evidence, ...opencodeSources(evidence),
      mode: "zero-model deterministic native comparison", comparator: "direct executable comparison and managed Service guard suite", result: "pass",
    }));
  }
  if (cells.length !== NATIVE_HARNESS_IDS.length * NATIVE_HARNESS_DIFFERENTIAL_DIMENSIONS.length) fail("did not compose every global matrix cell");
  return sealNativeHarnessDifferentialParityReceipt({ schema: NATIVE_HARNESS_DIFFERENTIAL_PARITY_SCHEMA, cells });
}

export function sealNativeHarnessDifferentialParityReceipt(receipt) {
  const cells = receipt?.cells?.map(({ contentDigest: _contentDigest, ...row }) => ({ ...row, contentDigest: digest(row) }));
  if (!cells) fail("receipt cells are missing");
  return { schema: receipt.schema, cells, digest: digest({ schema: receipt.schema, cells }) };
}

export function assertNativeHarnessDifferentialParityComposition(receipt, localReceipts) {
  const expected = composeNativeHarnessDifferentialParity(localReceipts);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) fail("global receipt is not the composition of its local evidence");
}

export function renderNativeHarnessDifferentialParityReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function renderNativeHarnessDifferentialParityMarkdown(receipt, assessment) {
  const lines = [
    "# Native Harness Differential Parity",
    "",
    `Status: \`${assessment.status}\`; promotion eligible: \`${assessment.promotionEligible}\`.`,
    "",
    "| Harness | Dimension | Result | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of receipt.cells) lines.push(`| ${entry.harness} | ${entry.dimension} | ${entry.result} | ${entry.localEvidence.map((reference) => reference.label).join(", ")} |`);
  if (assessment.blockers.length) {
    lines.push("", "## Blockers", "");
    for (const blocker of assessment.blockers) lines.push(`- ${blocker.harness}/${blocker.dimension}: ${blocker.result} — ${blocker.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
