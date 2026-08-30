#!/usr/bin/env node
/** SPDX-License-Identifier: Apache-2.0 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertCheckoutDependencies } from "../plugins/codex-harnessdock/bootstrap/dependency-preflight.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIFFERENTIAL_PARITY_RECEIPT = path.join(
  "tests", "runtime", "fixtures", "native-parity", "native-harness-differential-parity.receipt.json",
);

function parseArguments(argv) {
  let json = false;
  let realClaude = false;
  let nativeTeamWitness = false;
  let workspace = sourceRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--real-claude") realClaude = true;
    else if (argument === "--native-team-witness") nativeTeamWitness = true;
    else if (argument === "--workspace") {
      workspace = path.resolve(argv[++index] ?? "");
      if (!argv[index]) throw new Error("--workspace requires a path.");
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: npm run smoke:release -- [--json] [--workspace <path>] [--real-claude | --native-team-witness]\n" +
        "Default is zero-model-cost. --real-claude adds one Haiku 4.5 low read-only MCP smoke; --native-team-witness directly runs one paid Opus low read-only production-Driver witness.\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (realClaude && nativeTeamWitness) {
    throw new Error("--real-claude and --native-team-witness are mutually exclusive paid smoke modes.");
  }
  return { json, realClaude, nativeTeamWitness, workspace };
}

export async function runReleaseSmokeCli(argv, dependencies = {}) {
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  try {
    const options = parseArguments(argv);
    const checkoutRoot = dependencies.sourceRoot ?? sourceRoot;
    (dependencies.assertCheckoutDependencies ?? assertCheckoutDependencies)(checkoutRoot);
    let report;
    if (options.nativeTeamWitness) {
      writeStderr("Starting explicit paid native-team witness: claude-opus-5, effort=low, write=false.\n");
      const runNativeTeamWitness = dependencies.runNativeTeamWitness
        ?? (await import("../runtime/release-smoke.mjs")).runNativeTeamWitness;
      try {
        report = await runNativeTeamWitness({ sourceRoot });
      } catch {
        report = { status: "unverified", liveVerified: false, reason: "native_team_witness_error" };
      }
    } else {
      const runReleaseSmoke = dependencies.runReleaseSmoke
        ?? (await import("../runtime/release-smoke.mjs")).runReleaseSmoke;
      const differentialParityReceipt = JSON.parse((dependencies.readFileSync ?? fs.readFileSync)(
        path.join(checkoutRoot, DIFFERENTIAL_PARITY_RECEIPT),
        "utf8",
      ));
      report = await runReleaseSmoke({
        workspace: options.workspace,
        realClaude: options.realClaude,
        differentialParityReceipt,
        onPaidStart(receipt) {
          writeStderr(
            `Starting explicit paid smoke: ${receipt.model}, effort=${receipt.reasoningEffort}, write=${receipt.write}.\n`,
          );
        },
      });
    }
    writeStdout(`${JSON.stringify(report, null, options.json ? 2 : 2)}\n`);
    if (options.nativeTeamWitness) return report?.liveVerified === true ? 0 : 1;
    return report?.status === "pass" && report?.promotionEligible === true ? 0 : 1;
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReleaseSmokeCli(process.argv.slice(2));
}
