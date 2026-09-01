/** SPDX-License-Identifier: Apache-2.0 */
import fs from "node:fs";
import path from "node:path";

import { terminateProcessTree, validateProcessIdentity } from "../../../runtime/process-control.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Stop only the exact manager owned by a disposable test home, then remove it. */
export async function removeTestRuntimeHome(runtimeHome) {
  const receiptFile = path.join(runtimeHome, "runtime", "residency-manager", "receipt.json");
  await wait(50);
  if (fs.existsSync(receiptFile)) {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    if (!Number.isSafeInteger(receipt.pid) || typeof receipt.identity !== "string") {
      throw new Error("Test residency-manager receipt is invalid.");
    }
    if (validateProcessIdentity(receipt.pid, receipt.identity)) {
      terminateProcessTree(receipt.pid, receipt.identity);
      const deadline = Date.now() + 3_000;
      while (validateProcessIdentity(receipt.pid, receipt.identity) && Date.now() < deadline) await wait(20);
      if (validateProcessIdentity(receipt.pid, receipt.identity)) {
        throw new Error("Test residency manager did not terminate.");
      }
    }
  }
  fs.rmSync(runtimeHome, { recursive: true, force: true });
}
