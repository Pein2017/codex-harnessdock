import { runClaudeNativeRouteProbe } from "../runtime/claude-headless-adapter.mjs";
import { resolveRuntimeEnvironment } from "../runtime/environment.mjs";

function operatorHold(failureClass) {
  return {
    probe: "claude-native-route-control",
    schema: "claude-native-route-probe-v1",
    cliVersionClass: "unknown",
    counts: { frames: 0, rowsSeen: 0, candidates: 0, failureClasses: 1 },
    failureClasses: [failureClass],
    noUserPrompt: true,
    noAcceptedTurn: true,
    noGeneration: true,
    noSessionContinuation: true,
    noModelRequest: true,
    processCleaned: false,
    result: "HOLD",
  };
}

if (process.argv.length !== 2) {
  process.stdout.write(`${JSON.stringify(operatorHold("operator_arguments_rejected"))}\n`);
  process.exitCode = 2;
} else {
  try {
    const { env } = resolveRuntimeEnvironment({ cwd: process.cwd(), env: process.env });
    const receipt = await runClaudeNativeRouteProbe(process.cwd(), { env });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.result === "candidate" ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify(operatorHold("operator_setup_failed"))}\n`);
    process.exitCode = 1;
  }
}
