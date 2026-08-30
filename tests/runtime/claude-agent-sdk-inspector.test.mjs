import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inspectClaudeAgentSdkRoutes } from "../../runtime/claude-agent-sdk-inspector.mjs";

const executable = "/usr/local/bin/claude";
const model = (value, resolvedModel = value, efforts = ["low", "high"]) => ({
  value, resolvedModel, supportsEffort: true, supportedEffortLevels: efforts,
});

function sdk(rows, hooks = {}) {
  return {
    query(input) {
      hooks.input = input;
      return {
        initializationResult: hooks.initializationResult ?? (async () => ({ models: rows })),
        supportedModels: hooks.supportedModels ?? (async () => rows),
        close() { hooks.closed = (hooks.closed ?? 0) + 1; },
      };
    },
  };
}

describe("Claude Agent SDK route inspection", () => {
  it("projects an alias row only to its native resolved full model and closes without a prompt", async () => {
    const hooks = {};
    const routes = await inspectClaudeAgentSdkRoutes({
      cwd: "/workspace", executable,
      importAgentSdk: async () => sdk([model("sonnet", "claude-sonnet-5")], hooks),
    });
    assert.deepEqual(routes, {
      models: ["claude-sonnet-5"], effortsByModel: { "claude-sonnet-5": ["low", "high"] },
    });
    assert.equal(hooks.input.options.pathToClaudeCodeExecutable, executable);
    assert.equal(Object.hasOwn(hooks.input.options, "settingSources"), false);
    assert.equal(hooks.closed, 1);
    assert.deepEqual(await hooks.input.prompt.next(), { value: undefined, done: true });
  });

  for (const [label, rows, code] of [
    ["default", [model("default", "claude-sonnet-5")], "default_or_unresolved_model"],
    ["missing resolved model", [{ value: "sonnet", supportsEffort: true, supportedEffortLevels: ["low"] }], "default_or_unresolved_model"],
    ["duplicate resolved model", [model("sonnet", "claude-sonnet-5"), model("claude-sonnet-5")], "duplicate_resolved_model"],
    ["missing efforts", [{ value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", supportsEffort: false }], "missing_efforts"],
  ]) {
    it(`fails closed for ${label}`, async () => {
      await assert.rejects(
        () => inspectClaudeAgentSdkRoutes({ executable, importAgentSdk: async () => sdk(rows) }),
        (error) => error?.code === code,
      );
    });
  }

  it("fails closed and closes the query on initialization error or deadline", async () => {
    for (const initializationResult of [
      async () => { throw new Error("no auth"); },
      () => new Promise(() => {}),
    ]) {
      const hooks = {};
      hooks.initializationResult = initializationResult;
      await assert.rejects(
        () => inspectClaudeAgentSdkRoutes({ executable, timeoutMs: 1, importAgentSdk: async () => sdk([], hooks) }),
      );
      assert.equal(hooks.closed, 1);
    }
  });
});
