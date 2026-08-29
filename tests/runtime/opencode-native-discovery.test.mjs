import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  parseOpencodeCredentialProviders,
  parseOpencodeVerboseModels,
  runDiagnostic,
} from "../../runtime/opencode-native-discovery.mjs";

const MODELS = [
  "openai/gpt-5.6-luna",
  '{"variants":{"none":{},"low":{},"high":{}}}',
  "openai/gpt-5.6-sol",
  '{"variants":{"medium":{},"xhigh":{}}}',
].join("\n");

describe("OpenCode dormant native discovery", () => {
  it("projects only exact model and effort atoms from complete verbose blocks", () => {
    assert.deepEqual(parseOpencodeVerboseModels(MODELS), {
      ok: true,
      routes: [
        { model: "openai/gpt-5.6-luna", efforts: ["high", "low", "none"] },
        { model: "openai/gpt-5.6-sol", efforts: ["medium", "xhigh"] },
      ],
    });
  });

  it("fails closed on truncated, malformed, or duplicate model diagnostics", () => {
    for (const value of [
      "openai/gpt-5.6-luna\n{\"variants\":{\"low\":{}",
      "openai/gpt-5.6-luna\n{\"variants\":[]}",
      `${MODELS}\nopenai/gpt-5.6-luna\n{\"variants\":{\"low\":{}}}`,
    ]) assert.equal(parseOpencodeVerboseModels(value).ok, false);
  });

  it("reduces credential diagnostics to provider presence without returning raw text", () => {
    const parsed = parseOpencodeCredentialProviders("OpenCode Go(api), OpenAI(oauth)");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.providers.has("opencodego"), true);
    assert.equal(parsed.providers.has("openai"), true);
    assert.equal(JSON.stringify(parsed).includes("oauth"), false);
  });

  it("accepts only ANSI-decorated credential bullet rows, not titles, paths, or footers", () => {
    const parsed = parseOpencodeCredentialProviders([
      "\u001b[1mCredentials\u001b[0m",
      "/data/CoordExp/.local/share/opencode/auth.json",
      "● OpenCode Go \u001b[90mapi",
      "● OpenAI \u001b[90moauth",
      "Run opencode auth login to add another provider.",
    ].join("\n"));
    assert.deepEqual(parsed.ok ? [...parsed.providers].sort() : parsed, ["openai", "opencodego"]);
  });

  it("fails closed for malformed, duplicate, or rowless credential diagnostics", () => {
    for (const value of [
      "● OpenAI (token)",
      "● OpenAI (oauth)\n● Open AI (api)",
      "Credentials\n/data/CoordExp/.local/share/opencode/auth.json\nNo providers configured.",
      "● OpenAI \u001b[2Joauth",
      Array.from({ length: 129 }, (_, index) => `● Provider ${index} api`).join("\n"),
    ]) assert.equal(parseOpencodeCredentialProviders(value).ok, false);
  });

  it("terminates its exact diagnostic child after timeout or output overflow", async () => {
    for (const [args, options, code] of [
      [["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 20, maxBytes: 1_024 }, "diagnostic_timeout"],
      [["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"], { timeoutMs: 1_000, maxBytes: 16 }, "diagnostic_truncated"],
    ]) {
      let child = null;
      const result = await runDiagnostic(process.execPath, args, {
        ...options,
        cleanupTimeoutMs: 200,
        spawn: (...spawnArgs) => {
          child = spawn(...spawnArgs);
          return child;
        },
      });
      assert.deepEqual(result, { ok: false, code });
      assert.ok(child?.pid);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    }
  });

  it("waits for close when an exact timed-out child also emits error", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let closed = false;
    child.kill = () => {
      child.emit("error", new Error("late-error"));
      setTimeout(() => { closed = true; child.emit("close", null); }, 5);
    };
    const hold = setInterval(() => {}, 1_000);
    try {
      const result = await runDiagnostic("/fake/opencode", ["models"], {
        timeoutMs: 1, cleanupTimeoutMs: 50, spawn: () => child,
      });
      assert.deepEqual(result, { ok: false, code: "diagnostic_timeout" });
      assert.equal(closed, true);
    } finally {
      clearInterval(hold);
    }
  });
});
