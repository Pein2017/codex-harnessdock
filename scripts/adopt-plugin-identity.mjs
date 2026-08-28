#!/usr/bin/env node
/** SPDX-License-Identifier: Apache-2.0 */

import process from "node:process";

import { adoptPluginIdentity } from "../runtime/plugin-identity-cutover.mjs";

const required = [
  "--confirm-current-root-authoritative",
  "--confirm-no-legacy-recovery",
];

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(
      "Usage: npm run adopt:identity -- --confirm-current-root-authoritative --confirm-no-legacy-recovery\n",
    );
    return;
  }
  if (args.length !== required.length || required.some((argument) => !args.includes(argument))) {
    throw new Error(
      "Identity adoption requires both --confirm-current-root-authoritative and --confirm-no-legacy-recovery.",
    );
  }

  const receipt = adoptPluginIdentity({
    currentRootAuthoritative: true,
    legacyDataRecoveryRequired: false,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
