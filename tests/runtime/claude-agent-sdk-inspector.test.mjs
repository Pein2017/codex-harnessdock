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
  it("keeps zero-message input open through initialization and projects only effort-capable exact routes", async () => {
    const hooks = {};
    let pendingInput;
    hooks.initializationResult = async () => {
      pendingInput = hooks.input.prompt.next();
      assert.equal(
        await Promise.race([pendingInput.then(() => "closed"), Promise.resolve("open")]),
        "open",
      );
      return {
        models: [
          model("default", "claude-sonnet-5"),
          model("sonnet", "claude-sonnet-5"),
          { value: "claude-haiku-4-5", supportsEffort: false },
        ],
      };
    };
    const environment = { PATH: "/usr/local/bin", CLAUDE_CONFIG_DIR: "/config" };
    const routes = await inspectClaudeAgentSdkRoutes({
      cwd: "/workspace", executable, environment,
      importAgentSdk: async () => sdk([], hooks),
    });
    assert.deepEqual(routes, {
      models: ["claude-sonnet-5"], effortsByModel: { "claude-sonnet-5": ["low", "high"] },
    });
    assert.equal(hooks.input.options.pathToClaudeCodeExecutable, executable);
    assert.equal(hooks.input.options.env, environment);
    assert.equal(Object.hasOwn(hooks.input.options, "settingSources"), false);
    assert.equal(hooks.closed, 1);
    assert.deepEqual(await pendingInput, { value: undefined, done: true });
    assert.deepEqual(await hooks.input.prompt.next(), { value: undefined, done: true });
  });

  it("accepts an explicit model without resolvedModel and deduplicates an equivalent alias", async () => {
    const routes = await inspectClaudeAgentSdkRoutes({
      executable,
      importAgentSdk: async () => sdk([
        { value: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["high", "low"] },
        model("sonnet", "claude-sonnet-5", ["low", "high"]),
      ]),
    });
    assert.deepEqual(routes, {
      models: ["claude-sonnet-5"], effortsByModel: { "claude-sonnet-5": ["high", "low"] },
    });
  });

  for (const [label, rows, code] of [
    ["only non-routable rows", [model("default", "claude-sonnet-5"), { value: "claude-haiku-4-5", supportsEffort: false }], "no_effort_routes"],
    ["conflicting duplicate efforts", [model("sonnet", "claude-sonnet-5"), model("claude-sonnet-5", "claude-sonnet-5", ["low"])], "conflicting_efforts"],
    ["missing efforts", [{ value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", supportsEffort: true }], "missing_efforts"],
    ["unknown effort", [model("claude-sonnet-5", "claude-sonnet-5", ["turbo"])], "invalid_efforts"],
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
