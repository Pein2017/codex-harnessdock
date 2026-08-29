import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { readOpencodeSecrets, resolveOpencodeIdleTtlSeconds, resolveRuntimeEnvironment } from "../../runtime/environment.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-env-"));
  cleanups.push(root);
  const codexHome = path.join(root, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  return { root, codexHome };
}

describe("runtime environment", () => {
  it("uses CODEX_HOME/.env as one authoritative file and preserves CONDA_EXE", () => {
    const { root, codexHome } = fixture();
    const envFile = path.join(codexHome, ".env");
    fs.writeFileSync(envFile, [
      `CLAUDE_CONFIG_DIR=${path.join(root, ".claude")}`,
      "CONDA_EXE=/opt/conda/bin/conda",
      "HTTP_PROXY=http://127.0.0.1:9090",
      "NO_PROXY=127.0.0.1,localhost",
      "",
    ].join("\n"));
    const result = resolveRuntimeEnvironment({
      cwd: root,
      env: { PATH: "/usr/bin", CODEX_HOME: codexHome, HTTP_PROXY: "http://old:1" },
    });
    assert.deepEqual(result.receipt.sources, [envFile]);
    assert.equal(result.env.CONDA_EXE, "/opt/conda/bin/conda");
    assert.equal(result.env.HTTP_PROXY, "http://127.0.0.1:9090");
    assert.equal(result.env.PATH, "/usr/bin");
  });

  it("lets an explicit env file replace the CODEX_HOME selection", () => {
    const { root, codexHome } = fixture();
    fs.writeFileSync(path.join(codexHome, ".env"), "CLAUDE_CONFIG_DIR=/wrong\n");
    const explicit = path.join(root, "runtime.env");
    fs.writeFileSync(explicit, "CLAUDE_CONFIG_DIR=/right\nCUSTOM_FLAG=kept\n");
    const result = resolveRuntimeEnvironment({
      cwd: root,
      env: { CODEX_HOME: codexHome },
      envFile: explicit,
    });
    assert.deepEqual(result.receipt.sources, [explicit]);
    assert.equal(result.env.CLAUDE_CONFIG_DIR, "/right");
    assert.equal(result.env.CUSTOM_FLAG, "kept");
  });

  it("forces native Auto Memory on after the selected env file", () => {
    const { root, codexHome } = fixture();
    const omitted = path.join(root, "omitted.env");
    const disabled = path.join(root, "disabled.env");
    fs.writeFileSync(omitted, "CLAUDE_CONFIG_DIR=/selected\n");
    fs.writeFileSync(disabled, "CLAUDE_CONFIG_DIR=/selected\nCLAUDE_CODE_DISABLE_AUTO_MEMORY=1\n");

    for (const envFile of [omitted, disabled]) {
      const result = resolveRuntimeEnvironment({
        cwd: root,
        envFile,
        env: {
          CODEX_HOME: codexHome,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        },
      });
      assert.equal(result.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "0");
      assert.equal(JSON.stringify(result.receipt).includes("AUTO_MEMORY"), false);
    }
  });

  it("normalizes native Claude config precedence and ignores empty overrides", () => {
    const { root, codexHome } = fixture();
    const configured = path.join(root, "configured-claude");
    const native = path.join(root, "native-claude");
    const envFile = path.join(codexHome, ".env");
    fs.writeFileSync(envFile, [
      `CLAUDE_CONFIG_DIR=${configured}`,
      `CLAUDE_NATIVE_CONFIG_DIR=${native}`,
      "",
    ].join("\n"));
    const preferred = resolveRuntimeEnvironment({ cwd: root, env: { CODEX_HOME: codexHome } });
    assert.equal(preferred.env.CLAUDE_CONFIG_DIR, native);
    assert.equal(preferred.receipt.claudeConfigDir, native);

    fs.writeFileSync(envFile, `CLAUDE_NATIVE_CONFIG_DIR=\nCLAUDE_CONFIG_DIR=${configured}\n`);
    const fallback = resolveRuntimeEnvironment({ cwd: root, env: { CODEX_HOME: codexHome } });
    assert.equal(fallback.env.CLAUDE_CONFIG_DIR, configured);
  });

  it("rejects shell syntax instead of executing it", () => {
    const { root } = fixture();
    const explicit = path.join(root, "bad.env");
    fs.writeFileSync(explicit, "$(touch /tmp/should-not-exist)\n");
    assert.throws(
      () => resolveRuntimeEnvironment({ cwd: root, env: {}, envFile: explicit }),
      /Invalid env syntax/
    );
  });

  it("finds the workspace ancestor .codex/.env without CODEX_HOME", () => {
    const { root } = fixture();
    const nested = path.join(root, "worktrees", "checkout");
    fs.mkdirSync(nested, { recursive: true });
    const projectCodex = path.join(root, ".codex");
    fs.mkdirSync(projectCodex, { recursive: true });
    const envFile = path.join(projectCodex, ".env");
    fs.writeFileSync(envFile, "CONDA_EXE=/ancestor/conda\nCLAUDE_CONFIG_DIR=/ancestor/claude\n");
    const result = resolveRuntimeEnvironment({
      cwd: nested,
      env: { CODEX_HOME: path.join(root, "missing-codex-home") },
    });
    assert.deepEqual(result.receipt.sources, [envFile]);
    assert.equal(result.env.CONDA_EXE, "/ancestor/conda");
  });

  it("keeps CONDA_EXE in the packaged fallback", () => {
    const { root } = fixture();
    const result = resolveRuntimeEnvironment({
      cwd: root,
      env: {
        CODEX_HOME: path.join(root, "missing"),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
    });
    assert.equal(result.receipt.sources.length, 1);
    assert.match(result.receipt.sources[0], /config[/\\]runtime\.env$/);
    assert.equal(result.env.CONDA_EXE, "/root/miniconda3/bin/conda");
    assert.equal(result.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "0");
    assert.equal(JSON.stringify(result.receipt).includes("AUTO_MEMORY"), false);
  });

  it("takes Pi and OpenCode configuration from the selected data-only file, not shell inheritance", () => {
    const { root } = fixture();
    const envFile = path.join(root, "runtime.env");
    fs.writeFileSync(envFile, [
      "PI_CODING_AGENT_DIR=/selected/pi",
      "OPENCODE_EXECUTABLE=/selected/opencode",
      "OPENCODE_SERVER_URL=http://127.0.0.1:4096",
      "",
    ].join("\n"));
    const result = resolveRuntimeEnvironment({
      cwd: root,
      envFile,
      env: {
        PI_CODING_AGENT_DIR: "/shell/pi",
        OPENCODE_EXECUTABLE: "/shell/opencode",
        OPENCODE_SERVER_URL: "http://127.0.0.1:4999",
      },
    });
    assert.equal(result.env.PI_CODING_AGENT_DIR, "/selected/pi");
    assert.equal(result.env.OPENCODE_EXECUTABLE, "/selected/opencode");
    assert.equal(result.env.OPENCODE_SERVER_URL, "http://127.0.0.1:4096");
    assert.equal(JSON.stringify(result.receipt).includes("/selected/opencode"), false);
  });

  it("uses the bounded OpenCode idle TTL only from canonical dotenv data", () => {
    const { root } = fixture();
    const envFile = path.join(root, "runtime.env");
    const emptyEnvFile = path.join(root, "empty.env");
    fs.writeFileSync(envFile, "HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS=60\n");
    fs.writeFileSync(emptyEnvFile, "");
    assert.equal(resolveRuntimeEnvironment({ cwd: root, envFile, env: {} }).env.HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS, "60");
    assert.equal(resolveRuntimeEnvironment({ cwd: root, envFile: emptyEnvFile, env: { HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS: "60" } }).env.HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS, undefined);
    assert.equal(resolveOpencodeIdleTtlSeconds({}), 3600);
    for (const value of ["59", "604801", "1.5", "$(bad)"]) {
      fs.writeFileSync(envFile, `HARNESSDOCK_OPENCODE_IDLE_TTL_SECONDS=${value}\n`);
      assert.throws(() => resolveRuntimeEnvironment({ cwd: root, envFile, env: {} }), /IDLE_TTL/);
    }
  });

  it("rejects OPENCODE_SERVER_USERNAME in a tracked env file", () => {
    const { root, codexHome } = fixture();
    const envFile = path.join(codexHome, ".env");
    fs.writeFileSync(envFile, "OPENCODE_SERVER_USERNAME=admin\n");
    assert.throws(
      () => resolveRuntimeEnvironment({ cwd: root, env: {}, envFile }),
      /OPENCODE_SERVER_USERNAME.*not allowed/
    );
  });

  it("rejects OPENCODE_SERVER_PASSWORD in a tracked env file", () => {
    const { root, codexHome } = fixture();
    const envFile = path.join(codexHome, ".env");
    fs.writeFileSync(envFile, "OPENCODE_SERVER_PASSWORD=hunter2\n");
    assert.throws(
      () => resolveRuntimeEnvironment({ cwd: root, env: {}, envFile }),
      /OPENCODE_SERVER_PASSWORD.*not allowed/
    );
  });

  it("never merges OpenCode secrets into the resolved environment even when inherited from the operator process", () => {
    const { root } = fixture();
    const result = resolveRuntimeEnvironment({
      cwd: root,
      env: {
        CODEX_HOME: path.join(root, "missing-codex-home"),
        OPENCODE_SERVER_USERNAME: "admin",
        OPENCODE_SERVER_PASSWORD: "hunter2",
      },
    });
    assert.equal("OPENCODE_SERVER_USERNAME" in result.env, false);
    assert.equal("OPENCODE_SERVER_PASSWORD" in result.env, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("hunter2"), false);
  });

  it("readOpencodeSecrets reads username/password only from the exact given raw environment", () => {
    assert.deepEqual(readOpencodeSecrets({ OPENCODE_SERVER_USERNAME: "admin", OPENCODE_SERVER_PASSWORD: "hunter2", OTHER: "x" }), {
      username: "admin",
      password: "hunter2",
    });
    assert.deepEqual(readOpencodeSecrets({}), { username: null, password: null });
    assert.deepEqual(readOpencodeSecrets({ OPENCODE_SERVER_USERNAME: "  " }), { username: null, password: null });
  });
});
