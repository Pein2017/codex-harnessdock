import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { runClaudeNativeRouteProbe } from "../../runtime/claude-headless-adapter.mjs";
import { createClaudeCodeDriver } from "../../runtime/claude-code-driver.mjs";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "claude-native-route-control.mjs");
const OPERATOR_SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "claude-native-route-probe.mjs");
const roots = [];

after(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function fixtureProbe(mode, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-route-probe-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const trace = path.join(root, "trace.json");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "claude");
  fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(executable, 0o755);
  const env = {
    PATH: bin,
    CLAUDE_CONFIG_DIR: "/ordinary-config-state",
    CLAUDE_NATIVE_ROUTE_PROBE_FIXTURE_MODE: mode,
    CLAUDE_NATIVE_ROUTE_PROBE_TRACE: trace,
  };
  return {
    root,
    trace,
    run: () => runClaudeNativeRouteProbe(root, { env, ...options }),
  };
}

function readTrace(trace) {
  const [json] = fs.readFileSync(trace, "utf8").split("\n");
  return JSON.parse(json);
}

describe("Claude native route zero-prompt probe", () => {
  it("freezes the current default/family/context schema as a sanitized HOLD", async () => {
    const fixture = fixtureProbe("current-negative");
    const receipt = await fixture.run();

    assert.equal(receipt.result, "HOLD");
    assert.equal(Object.hasOwn(receipt, "candidates"), false);
    assert.equal(receipt.cliVersionClass, "2.1");
    assert.equal(receipt.counts.rowsSeen, 3);
    assert.ok(receipt.failureClasses.includes("default_or_disabled"));
    assert.ok(receipt.failureClasses.includes("unresolved_or_alias"));
    assert.ok(receipt.failureClasses.includes("no_complete_candidate"));
    assert.deepEqual(
      [receipt.noUserPrompt, receipt.noAcceptedTurn, receipt.noGeneration, receipt.noSessionContinuation, receipt.noModelRequest],
      [true, true, true, true, true],
    );
    assert.equal(receipt.processCleaned, true);
  });

  it("keeps only a complete exact native candidate and redacts source data", async () => {
    const fixture = fixtureProbe("candidate");
    const receipt = await fixture.run();

    assert.equal(receipt.result, "candidate");
    assert.deepEqual(receipt.candidates, [{ value: "claude-test-1", efforts: ["low", "high"] }]);
    const durable = JSON.stringify(receipt);
    assert.equal(durable.includes("fixture-secret-config-/not-for-receipt"), false);
    assert.equal(durable.includes("/ordinary-config-state"), false);
    assert.equal(durable.includes("claude-native-route-control.mjs"), false);
  });

  it("allows only the observed pre-init hook lifecycle and preserves opaque effort atoms", async () => {
    const receipt = await fixtureProbe("hook-lifecycle").run();

    assert.equal(receipt.result, "candidate");
    assert.deepEqual(receipt.candidates, [{ value: "claude-test-1", efforts: ["opaque-effort-v1"] }]);
    assert.equal(receipt.counts.frames, 5);
    assert.deepEqual(
      [receipt.noUserPrompt, receipt.noAcceptedTurn, receipt.noGeneration, receipt.noSessionContinuation, receipt.noModelRequest, receipt.processCleaned],
      [true, true, true, true, true, true],
    );
  });

  it("does not turn fake parser evidence into Claude route admission", async () => {
    const receipt = await fixtureProbe("candidate").run();
    assert.equal(receipt.result, "candidate");
    assert.throws(
      () => createClaudeCodeDriver().validateRoute({ model: "claude-test-1", write: false }),
      /Unsupported Claude model/,
    );
  });

  for (const [mode, failure] of [
    ["default", "default_or_disabled"],
    ["alias", "unresolved_or_alias"],
    ["mismatch", "unresolved_or_alias"],
    ["missing-efforts", "missing_efforts"],
    ["malformed-row", "row_malformed"],
  ]) {
    it(`holds ${mode} rows without a partial catalog`, async () => {
      const receipt = await fixtureProbe(mode).run();
      assert.equal(receipt.result, "HOLD");
      assert.equal(Object.hasOwn(receipt, "candidates"), false);
      assert.ok(receipt.failureClasses.includes(failure));
    });
  }

  for (const [mode, failure] of [
    ["malformed", "malformed_response"],
    ["oversized", "stdout_oversized"],
    ["mismatched", "correlation_mismatch"],
    ["user", "forbidden_user_event"],
    ["assistant", "forbidden_assistant_event"],
    ["result", "forbidden_result_event"],
    ["model-request", "forbidden_model_request"],
    ["continuation", "forbidden_session_continuation"],
    ["unknown-system", "malformed_initialization"],
  ]) {
    it(`rejects ${mode} native output`, async () => {
      const receipt = await fixtureProbe(mode).run();
      assert.equal(receipt.result, "HOLD");
      assert.ok(receipt.failureClasses.includes(failure));
      assert.equal(Object.hasOwn(receipt, "candidates"), false);
    });
  }

  it("sends one list_models control frame, closes stdin, and preserves ordinary Claude state", async () => {
    const fixture = fixtureProbe("candidate");
    const receipt = await fixture.run();
    const trace = readTrace(fixture.trace);
    const lines = trace.input.split("\n").filter(Boolean);

    assert.equal(receipt.result, "candidate");
    assert.equal(lines.length, 1);
    const input = JSON.parse(lines[0]);
    assert.deepEqual(input.type, "control_request");
    assert.deepEqual(input.request, { subtype: "list_models" });
    assert.deepEqual(trace.args, [
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--input-format", "stream-json", "--no-session-persistence",
    ]);
    assert.equal(trace.configDir, "/ordinary-config-state");
    assert.equal(trace.args.includes("--model"), false);
    assert.equal(trace.args.includes("--effort"), false);
    assert.equal(trace.args.includes("--resume"), false);
  });

  it("times out a lingering process group and records completed cleanup", async () => {
    const fixture = fixtureProbe("linger", { timeoutMs: 100 });
    const receipt = await fixture.run();

    assert.equal(receipt.result, "HOLD");
    assert.ok(receipt.failureClasses.includes("timeout"));
    assert.equal(receipt.processCleaned, true);
  });

  it("holds a silent native process at the deadline", async () => {
    const receipt = await fixtureProbe("timeout", { timeoutMs: 100 }).run();
    assert.equal(receipt.result, "HOLD");
    assert.ok(receipt.failureClasses.includes("timeout"));
    assert.equal(receipt.processCleaned, true);
  });

  it("rejects operator selectors before it can alter the fixed control invocation", () => {
    const result = spawnSync(process.execPath, [OPERATOR_SCRIPT, "--model=anything"], {
      cwd: fixtureProbe("candidate").root,
      encoding: "utf8",
    });
    const receipt = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.deepEqual(receipt.failureClasses, ["operator_arguments_rejected"]);
  });
});
