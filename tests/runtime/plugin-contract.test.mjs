import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createAgentRuntime } from "../../runtime/index.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const releaseMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const escapedReleaseVersion = releaseMetadata.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pluginVersionPattern = new RegExp(`^${escapedReleaseVersion}\\+codex\\.[A-Za-z0-9._-]+$`);

describe("native plugin contract", () => {
  const canonicalSkills = [
    "followup-task",
    "interrupt-agent",
    "list-agents",
    "list-harnesses",
    "read-agent-messages",
    "send-message",
    "spawn-agent",
    "wait-agent",
  ];

  const canonicalOperations = [
    "followup_task",
    "interrupt_agent",
    "list_agents",
    "list_harnesses",
    "read_agent_messages",
    "send_message",
    "spawn_agent",
    "wait_agent",
  ];

  it("publishes only the eight canonical Agent skills and no Codex hook", () => {
    const pluginRoot = path.join(root, "plugins", "codex-harnessdock");
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.name, "codex-harnessdock");
    assert.match(manifest.version, pluginVersionPattern);
    assert.equal(manifest.hooks, undefined);
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(manifest.author.name, "Pein2017");
    assert.equal(manifest.interface.brandColor, "#312E81");
    assert.equal(manifest.interface.composerIcon, "./assets/harnessdock-icon.svg");
    assert.equal(manifest.interface.logo, "./assets/harnessdock-logo.svg");
    for (const asset of [manifest.interface.composerIcon, manifest.interface.logo]) {
      assert.match(asset, /^\.\/assets\/[A-Za-z0-9._-]+\.svg$/);
      const source = fs.readFileSync(path.join(pluginRoot, asset), "utf8");
      assert.match(source, /^<svg\b/);
      assert.match(source, /viewBox=/);
      assert.doesNotMatch(source, /<script|javascript:|(?:href|xlink:href)=["']https?:\/\//i);
    }
    const skills = fs.readdirSync(path.join(pluginRoot, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(pluginRoot, "skills", entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(skills, canonicalSkills);
    for (const legacy of ["cancel", "interrupt", "result", "run", "status", "steer"]) {
      assert.equal(fs.existsSync(path.join(pluginRoot, "skills", legacy)), false);
    }
  });

  it("keeps the manifest defaultPrompt free of mandatory join-obligation language", () => {
    const pluginRoot = path.join(root, "plugins", "codex-harnessdock");
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
    const defaultPrompt = manifest.interface.defaultPrompt.join("\n");
    assert.doesNotMatch(defaultPrompt, /retain required join obligations/i);
    assert.doesNotMatch(defaultPrompt, /required join/i);
    assert.doesNotMatch(defaultPrompt, /critical dependency/i);
    assert.doesNotMatch(defaultPrompt, /completion-first/i);
  });

  it("has no active import or metadata dependency on upstream installers or versioned cache", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.scripts["install:codex"], undefined);
    const runtimeText = fs.readdirSync(path.join(root, "runtime"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => fs.readFileSync(path.join(root, "runtime", name), "utf8"))
      .join("\n");
    assert.doesNotMatch(runtimeText, /\.\.\/scripts|plugins\/cache|sendbird\/cc-plugin-codex|installer-cli/);
    for (const legacySurface of [
      "scripts/install.sh",
      "scripts/uninstall.sh",
      "scripts/installer-cli.mjs",
      "hooks/hooks.json",
      "internal-skills/cli-runtime/runtime.md",
      "tests/installer-cli.test.mjs",
    ]) {
      assert.equal(fs.existsSync(path.join(root, legacySurface)), false, `${legacySurface} must stay retired`);
    }
  });

  it("exposes only the canonical Agent lifecycle operations from the public index", () => {
    const runtime = createAgentRuntime({
      cwd: root,
      env: {
        ...process.env,
        CODEX_THREAD_ID: "plugin-contract-root",
        CODEX_HARNESSDOCK_TRUSTED_OWNER_ROOT_ID: "plugin-contract-root",
        CODEX_HARNESSDOCK_RUNTIME_HOME: path.join(root, ".test-runtime-contract"),
        CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: path.join(root, "config", "runtime.env"),
      },
    });
    assert.deepEqual(Object.keys(runtime).sort(), canonicalOperations);
    assert.equal(Object.isFrozen(runtime), true);
  });

  it("routes every active skill through exactly one typed MCP tool without shell fallback", () => {
    for (const [name, operation] of [
      ["spawn-agent", "spawn_agent"],
      ["send-message", "send_message"],
      ["followup-task", "followup_task"],
      ["wait-agent", "wait_agent"],
      ["interrupt-agent", "interrupt_agent"],
      ["list-agents", "list_agents"],
      ["list-harnesses", "list_harnesses"],
      ["read-agent-messages", "read_agent_messages"],
    ]) {
      const text = fs.readFileSync(path.join(root, "plugins", "codex-harnessdock", "skills", name, "SKILL.md"), "utf8");
      assert.match(text, new RegExp(`mcp__codex_harnessdock__${operation}`));
      assert.match(text, /Trusted Codex\s+metadata owns cwd\/root/i);
      assert.match(
        text,
        /If\s+(?:the tool is\s+)?unavailable,\s+report\s+Plugin\s+startup or\s+discovery failure/i,
      );
      assert.match(text, /never use[\s\S]*shell/i);
      assert.doesNotMatch(text, /harnessdock-runtime\.mjs|runtime\/cli\.mjs|node --/);

      const metadata = fs.readFileSync(
        path.join(root, "plugins", "codex-harnessdock", "skills", name, "agents", "openai.yaml"),
        "utf8",
      );
      assert.match(metadata, new RegExp(`mcp__codex_harnessdock__${operation}`));
      assert.match(metadata, /never fall back to (?:a )?shell(?: command)?/i);
    }
  });

  it("keeps interrupt-agent guidance truthful about graceful, never forced, termination", () => {
    const text = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "skills", "interrupt-agent", "SKILL.md"),
      "utf8",
    );
    assert.match(text, /graceful\s+interrupt request may be accepted, rejected, or left pending/i);
    assert.match(text, /`status`[\s\S]*`interrupted`,\s*`still_working`,[\s\S]*`failed`,[\s\S]*`settlement_unknown`/i);
    assert.match(text, /`still_working`[\s\S]*never\s+a\s+forced\s+termination/i);
    assert.doesNotMatch(text, /Forced unflushed\s+termination becomes failed and non-resumable/i);
    assert.doesNotMatch(text, /force-terminat/i);
  });

  it("keeps single-target progress discoverable through the existing wait skill", () => {
    const text = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "skills", "wait-agent", "SKILL.md"),
      "utf8",
    );
    assert.match(text, /wake_on_progress: true[\s\S]*exactly one target/i);
    assert.match(text, /multiple[\s\S]*targets form one completion-only all-settled barrier/i);
    assert.match(text, /unrelated root[\s\S]*activity remains[\s\n]+available to its proper consumer/i);
  });

  it("publishes one checkout-owned stdio MCP server with the one-hour timeout margin", () => {
    const pluginRoot = path.join(root, "plugins", "codex-harnessdock");
    const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), ["codex_harnessdock"]);
    assert.deepEqual(config.mcpServers.codex_harnessdock, {
      type: "stdio",
      command: "node",
      args: ["--", "/data/CoordExp/codex-harnessdock/plugins/codex-harnessdock/bootstrap/harnessdock-mcp.mjs"],
      cwd: "/data/CoordExp/codex-harnessdock",
      required: true,
      supports_parallel_tool_calls: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 3660,
      default_tools_approval_mode: "approve",
    });

    const bootstrap = fs.readFileSync(path.join(pluginRoot, "bootstrap", "harnessdock-mcp.mjs"), "utf8");
    assert.match(bootstrap, /FIXED_RUNTIME_CHECKOUT = "\/data\/CoordExp\/codex-harnessdock"/);
    assert.match(bootstrap, /runtime["',\s]+"mcp-server\.mjs"/);
    assert.match(bootstrap, /process\.chdir\(checkout\)/);
    assert.match(bootstrap, /await import\(pathToFileURL\(server\)\.href\)/);
    assert.match(bootstrap, /await runCcMcpServer\(\)/);
    assert.doesNotMatch(bootstrap, /child_process|spawn\(/);
    assert.doesNotMatch(bootstrap, /plugins\/cache|sendbird\/cc-plugin-codex/);
    assert.match(bootstrap, /assertCheckoutDependencies\(checkout\)/);

    const lifecycleBootstrap = fs.readFileSync(path.join(pluginRoot, "bootstrap", "harnessdock-runtime.mjs"), "utf8");
    assert.match(lifecycleBootstrap, /assertCheckoutDependencies\(checkout\)/);

    const server = fs.readFileSync(path.join(root, "runtime", "mcp-server.mjs"), "utf8");
    assert.match(server, /CODEX_SANDBOX_META_KEY = "codex\/sandbox-state-meta"/);
    assert.match(server, /missing _meta\.threadId/);
    assert.match(server, /sandboxCwd/);
    assert.doesNotMatch(server, /background terminal|exec_command|write_stdin/);
    assert.match(server, /invokeIsolatedRuntimeOperation/);
    assert.match(server, /mcp-call-worker\.mjs/);
  });

  it("pins the installed bootstrap and Claude envelope to the canonical checkout", () => {
    const bootstrap = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "bootstrap", "harnessdock-runtime.mjs"),
      "utf8",
    );
    assert.match(bootstrap, /FIXED_RUNTIME_CHECKOUT = "\/data\/CoordExp\/codex-harnessdock"/);
    assert.doesNotMatch(bootstrap, /function (?:findAncestorEnv|selectEnvFile|bootstrapContext)/);
    assert.match(bootstrap, /CODEX_HARNESSDOCK_RUNTIME_CHECKOUT: checkout/);
    assert.match(bootstrap, /CODEX_HARNESSDOCK_RUNTIME_ENV_FILE: envFile/);
    assert.match(bootstrap, /CODEX_HARNESSDOCK_RUNTIME_SOURCE_ROOT: checkout/);

    const env = fs.readFileSync(path.join(root, "config", "runtime.env"), "utf8");
    assert.match(env, /^CLAUDE_NATIVE_CONFIG_DIR=\/data\/CoordExp\/\.claude$/m);
    assert.match(env, /^CLAUDE_CONFIG_DIR=\/data\/CoordExp\/\.claude$/m);
    assert.match(env, /^CLAUDE_CODE_DISABLE_AUTO_MEMORY=0$/m);
    assert.doesNotMatch(env, /autoMemoryDirectory/);
    assert.match(env, /^CONDA_EXE=\/root\/miniconda3\/bin\/conda$/m);
    for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      assert.match(env, new RegExp(`^${key}=http:\\/\\/127\\.0\\.0\\.1:9090$`, "m"));
    }
  });

  it("keeps every lifecycle skill eligible for model-visible discovery", () => {
    for (const name of canonicalSkills) {
      const metadata = fs.readFileSync(
        path.join(root, "plugins", "codex-harnessdock", "skills", name, "agents", "openai.yaml"),
        "utf8",
      );
      assert.doesNotMatch(metadata, /allow_implicit_invocation:\s*false/);
    }
  });

  it("keeps spawn success concise and routes internal evidence to operator diagnostics", () => {
    const text = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "skills", "spawn-agent", "SKILL.md"),
      "utf8",
    );
    assert.match(text, /On success:[\s\S]*returned Agent Card[\s\S]*`agent_name`, `model`, and `status`/i);
    assert.match(text, /never worktree paths[\s\S]*final Harness text[\s\S]*JSON[\s\S]*internal IDs/i);
    assert.match(text, /operator diagnostics[\s\S]*actionable[\s\S]*failure\/recovery detail/i);
    assert.match(text, /actionable\s+failure\/recovery detail/i);
    assert.doesNotMatch(text, /receipt exactly as returned/i);
  });

  it("keeps spawn guidance inventory-neutral without route ranking", () => {
    const text = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "skills", "spawn-agent", "SKILL.md"),
      "utf8",
    );
    assert.doesNotMatch(text, /cheapest\/fastest|preferred for real smoke|highest capability\/spend|Haiku < Sonnet < Opus < Fable/i);
    assert.match(text, /Ask when no model family was selected/i);
    assert.match(text, /Agent label such as Ops5[\s\S]*partial IDs[\s\S]*substitute another[\s\S]*model/i);
    assert.match(text, /(?:subscription|usage)[\s\S]*(?:quota|credit) exhaustion[\s\S]*stop further\s+real Claude tests/i);
    assert.match(text, /generic transient 429[\s\S]*bounded reconnect/i);
    assert.match(text, /`write: false`[\s\S]*behavioral read\/review-only[\s\S]*`write: true`[\s\S]*task-scoped mutation[\s\S]*not an OS-level/i);
    assert.match(text, /`IS_SANDBOX=1`[\s\S]*`--dangerously-skip-permissions`[\s\S]*never omit `write`/i);
    assert.match(text, /`leaf`[\s\S]*native[\s\S]*`Agent`[\s\S]*`Workflow`[\s\S]*`native_orchestrator`[\s\S]*fresh listing admits it/i);
    // Every route field is stated by the caller; nothing is defaulted.
    assert.match(text, /`harness`[\s\S]*`model`[\s\S]*`topology`[\s\S]*`write`/);
    assert.match(text, /no default (?:Harness|route)/i);
    assert.doesNotMatch(text, /delegation_mode/);
    assert.match(text, /list-harnesses[\s\S]*current inventory[\s\S]*`harness`[\s\S]*`model`[\s\S]*`topology`[\s\S]*`write`[\s\S]*`reasoning_effort`/i);
    assert.match(text, /all route fields[\s\S]*mandatory[\s\S]*nothing is defaulted, inferred, aliased, or substituted/i);
    for (const rosterEntry of [
      "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5",
      "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol",
      "openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol",
      "Pi `write: false` allows only", "No `-fast` variants",
    ]) assert.doesNotMatch(text, new RegExp(rosterEntry.replaceAll("/", "\\/"), "i"));
    // Route facts are read from fresh native discovery; native configuration is
    // inherited, never enumerated by HarnessDock.
    assert.match(text, /list-harnesses[\s\S]*immediately before route selection/i);
    assert.match(text, /Pi and OpenCode are\s+prompt\/receipt only, inheriting native tools, plugins, MCP, and config unchanged\s+and never enumerated/i);
    assert.match(text, /experimental Native Agent Team lead/i);
    assert.match(text, /named member[\s\S]*launch(?:es|ed)? asynchronously[\s\S]*correlated `SendMessage`[\s\S]*succeed(?:s)?/i);
    assert.match(text, /definition-owned[\s\S]*models[\s\S]*effective teammate model[\s\S]*unknown/i);
    assert.match(text, /effective teammate model, effort, and cost are unknown/i);
    assert.match(text, /explicit follow-up[\s\S]*fresh native team/i);
    assert.match(text, /not an OS-level/i);
    assert.match(text, /at most three[\s\S]*six creations[\s\S]*behavioral/i);
    assert.match(text, /SendMessage[\s\S]*current-team/i);
    assert.match(text, /`Workflow`[\s\S]*remains disabled/i);
    assert.doesNotMatch(text, /allowed_tools/);
    assert.doesNotMatch(text, /fork_turns|execution_profile/);
  });

  it("does not need a guidance edit when a fake catalog replaces the admitted tuple", () => {
    const file = path.join(root, "plugins", "codex-harnessdock", "skills", "spawn-agent", "SKILL.md");
    const before = fs.readFileSync(file);
    const catalog = { "fake/provider-a": ["opaque-effort-a"] };
    const admits = (model, effort) => catalog[model]?.includes(effort) === true;
    assert.equal(admits("fake/provider-a", "opaque-effort-a"), true);
    delete catalog["fake/provider-a"];
    catalog["fake/provider-b"] = ["opaque-effort-b"];
    assert.equal(admits("fake/provider-a", "opaque-effort-a"), false);
    assert.equal(admits("fake/provider-b", "opaque-effort-b"), true);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(before.includes("fake/provider-b"), false);
  });

  it("documents follow-up write inheritance and explicit authority changes", () => {
    const text = fs.readFileSync(
      path.join(root, "plugins", "codex-harnessdock", "skills", "followup-task", "SKILL.md"),
      "utf8",
    );
    // The route and its behavioral authority are frozen at creation: a
    // follow-up inherits them and cannot restate, widen, or narrow either.
    assert.match(text, /frozen at creation[\s\S]*inherit/i);
    assert.match(text, /a different route means a new Agent/i);
    assert.doesNotMatch(text, /Omitted `write` inherits/i);
    assert.match(text, /`agent_name`[\s\S]*`delivery`[\s\S]*raw JSON/i);
    // A route proving fresh-only continuation has no same-Agent second turn.
    assert.match(text, /fresh_only[\s\S]*new Agent/i);
  });

  it("keeps send-message receipts and presentation compact", () => {
    const skillRoot = path.join(root, "plugins", "codex-harnessdock", "skills", "send-message");
    const text = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    assert.match(text, /one concise sentence[\s\S]*`agent_name`[\s\S]*`delivery`/i);
    assert.match(text, /Do not repeat the message or JSON/i);
    assert.match(text, /queued_no_turn[\s\S]*followup-task/i);
    assert.doesNotMatch(text, /Present the delivery receipt exactly as returned/);

    const metadata = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
    assert.match(metadata, /one concise disposition-aware sentence/i);
    assert.match(metadata, /never raw JSON or repeated message text/i);
  });

  it("keeps list and wait guidance intentional by default", () => {
    for (const name of ["list-agents", "wait-agent"]) {
      const text = fs.readFileSync(
        path.join(root, "plugins", "codex-harnessdock", "skills", name, "SKILL.md"),
        "utf8",
      );
      assert.doesNotMatch(text, /Present the runtime receipt exactly as returned/);
      assert.match(text, /Experimental/i);
      if (name === "list-agents") {
        assert.match(text, /final output/i);
        assert.match(text, /[Nn]ever call this\s+solely to recheck completion after a quiet `wait_agent` timeout/i);
        assert.match(text, /call `wait_agent` again directly/i);

        const metadata = fs.readFileSync(
          path.join(root, "plugins", "codex-harnessdock", "skills", name, "agents", "openai.yaml"),
          "utf8",
        );
        assert.match(metadata, /solely to recheck completion after a quiet wait_agent timeout/i);
      } else {
        assert.match(text, /complete stored[\s\S]*completion_message/i);
        assert.match(text, /untargeted call observes current-root completion[\s\S]*targeted call observes/i);
        assert.match(text, /3600000 ms/);
        assert.doesNotMatch(text, /10-minute/i);
        assert.doesNotMatch(text, /timeout_ms/);
        assert.match(text, /wake_on_progress: true[\s\S]*an intermediate update/i);
        assert.match(text, /hook[\s\S]*private/i);
        assert.match(text, /Do not repeat progress waiting/i);
        assert.match(text, /narrate unchanged timeouts/i);
        assert.match(text, /`list_agents` or\s+`read_agent_messages` immediately\s+afterward merely to recheck completion/i);
        assert.match(text, /call `wait_agent` again directly/i);

        const metadata = fs.readFileSync(
          path.join(root, "plugins", "codex-harnessdock", "skills", name, "agents", "openai.yaml"),
          "utf8",
        );
        assert.match(metadata, /one-hour completion bound/i);
        assert.match(metadata, /wake_on_progress[\s\S]*one intentional intermediate observation per Agent turn[\s\S]*never repeat/i);
        assert.match(metadata, /quiet timeout[\s\S]*call wait_agent again directly/i);
      }
    }
  });

  it("keeps the eight self-contained Skill instructions within the context budget", () => {
    let words = 0;
    let bytes = 0;
    for (const name of canonicalSkills) {
      const text = fs.readFileSync(
        path.join(root, "plugins", "codex-harnessdock", "skills", name, "SKILL.md"),
        "utf8",
      );
      words += text.trim().split(/\s+/u).length;
      bytes += Buffer.byteLength(text, "utf8");
      assert.match(text, /Experimental/i);
      assert.match(text, /If\s+(?:the tool is\s+)?unavailable,\s+report\s+Plugin/i);
    }
    // `canonical-agent-orchestration`: the eight installed Skills' aggregate
    // whitespace-delimited word count SHALL NOT exceed 2,200.
    assert.ok(words <= 2_200, `Agent Skill guidance uses ${words} words`);
    assert.ok(bytes <= 11_500, `Agent Skill guidance uses ${bytes} bytes`);
    assert.ok(16_648 > 11_500, "the pre-change 16,648-byte characterization must fail this budget");
  });

  it("keeps the installed default routing prompt within 800 characters", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", "codex-harnessdock", ".codex-plugin", "plugin.json"), "utf8"));
    assert.ok(manifest.interface.defaultPrompt.join("\n").length <= 800);
  });

  it("marks all eight skill prompts and discovery descriptions Experimental", () => {
    for (const name of canonicalSkills) {
      const skillRoot = path.join(root, "plugins", "codex-harnessdock", "skills", name);
      assert.match(fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8"), /Experimental/i);
      const metadata = fs.readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
      assert.match(metadata, /Experimental/i);
      assert.match(metadata, /cannot reactivate an idle Codex parent/i);
    }
  });

  it("teaches every lifecycle Skill the bounded release-drift boundary", () => {
    for (const name of canonicalSkills) {
      const text = fs.readFileSync(
        path.join(root, "plugins", "codex-harnessdock", "skills", name, "SKILL.md"),
        "utf8",
      );
      assert.match(text, /exact retained Skill path/i);
      assert.match(text, /latest-version instructions\s+are emergency-only/i);
      assert.match(text, /HARNESSDOCK_MCP_RESTART_REQUIRED[\s\S]*new Codex task/i);
      assert.match(text, /Never repair Plugin Cache/i);
    }
  });

  it("keeps list-harnesses inspection-only and free of route policy", () => {
    const skillRoot = path.join(root, "plugins", "codex-harnessdock", "skills", "list-harnesses");
    const text = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    // It reports what exists; it never chooses.
    assert.match(text, /readiness/i);
    assert.match(text, /liveValidated/);
    assert.match(text, /maturity/i);
    assert.match(text, /capacity/i);
    assert.match(text, /never orders[\s\S]*selects[\s\S]*implies a default/i);
    assert.match(text, /the caller[\s\S]*states[\s\S]*whole route/i);
    assert.match(text, /accepts no (?:fields|arguments)/i);
    // An unavailable Harness is still admitted; absence is not removal.
    assert.match(text, /unavailable[\s\S]*still admitted|admitted[\s\S]*not[\s\S]*removed/i);
    assert.doesNotMatch(text, /endpoint|credential|password|username/i);
  });

  it("states dynamic native discovery without promising native config/plugin/MCP/tool enumeration or filesystem containment", () => {
    const pluginRoot = path.join(root, "plugins", "codex-harnessdock");
    const skillTexts = canonicalSkills.flatMap((name) => [
      fs.readFileSync(path.join(pluginRoot, "skills", name, "SKILL.md"), "utf8"),
      fs.readFileSync(path.join(pluginRoot, "skills", name, "agents", "openai.yaml"), "utf8"),
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
    const serverText = fs.readFileSync(path.join(root, "runtime", "mcp-server.mjs"), "utf8");
    // Discovery is stated as fresh/native on both public surfaces.
    assert.match(fs.readFileSync(path.join(pluginRoot, "skills", "list-harnesses", "SKILL.md"), "utf8"), /fresh native discovery/i);
    assert.match(serverText, /fresh exact model\/effort routes/i);
    assert.match(serverText, /freshly validated against native discovery/i);
    // Spawn requires an explicit effort; follow-up inherits the frozen route.
    assert.match(fs.readFileSync(path.join(pluginRoot, "skills", "spawn-agent", "SKILL.md"), "utf8"), /`reasoning_effort` \(required for every route/i);
    assert.match(fs.readFileSync(path.join(pluginRoot, "skills", "followup-task", "SKILL.md"), "utf8"), /route is frozen at creation[\s\S]*inherited unchanged, including effort/i);
    // No surface promises an enumerable native inventory or OS-level containment.
    const forbidden = [
      /enumerate[sd]? (?:the )?native (?:plugins?|MCP|tools?|prompt templates?)/i,
      /list[s]? (?:every |all )?native (?:plugins?|MCP servers?|tools?)/i,
      /filesystem containment/i,
      /os-level (?:read-only|sandbox|containment)/i,
    ];
    for (const text of [...skillTexts, serverText, JSON.stringify(manifest.interface)]) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(text, pattern);
      }
    }
    // The explicit "not enumerated / prompt-only" framing is present.
    assert.match(fs.readFileSync(path.join(pluginRoot, "skills", "spawn-agent", "SKILL.md"), "utf8"), /inheriting native tools, plugins, MCP, and config unchanged\s+and never enumerated/i);
  });

  it("states each Harness's unsupported capabilities where a caller would hit them", () => {
    const skills = path.join(root, "plugins", "codex-harnessdock", "skills");
    const read = (name) => fs.readFileSync(path.join(skills, name, "SKILL.md"), "utf8");
    // An unsupported operation answers with a receipt, never an exception and
    // never a substitute call.
    assert.match(read("interrupt-agent"), /`unsupported`[\s\S]*turn (?:keeps|is still) running/i);
    assert.match(read("read-agent-messages"), /`unsupported`[\s\S]*no messages/i);
    assert.match(read("send-message"), /queue/i);
  });

  it("documents Pi as a first-class exact-session route and removes DeepSeek from current routes", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    assert.match(readme, /Three Harnesses are admitted[\s\S]*Experimental \*\*Pi\*\*/i);
    for (const model of [
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
    ]) assert.match(readme, new RegExp(model.replace("/", "\\/")));
    assert.match(readme, /Pi resumes that exact session only[\s\S]*asynchronous assistant history/i);
    assert.match(readme, /`settlement_unknown`/);
    const openCodeStart = readme.indexOf("## OpenCode Explorer (Experimental)");
    const openCodeSection = readme.slice(openCodeStart, readme.indexOf("## Route refusal is Codex-led", openCodeStart));
    assert.doesNotMatch(openCodeSection, /deepseek|opencode-go/i);
    assert.match(readme, /\*\*DeepSeek Harness\*\*[\s\S]*later, independent probes/i);
  });

  it("keeps every Skill free of route ranking or preference language", () => {
    // Deliberately narrower than the runtime's policy guard: Skills legitimately
    // say "shell fallback" and name `reported_cost_usd`. What may never appear
    // is a preference between admitted routes.
    const policy =
      /\brank(?:ing|ed|s)?\b|\brecommend\w*\b|\bpreferred\b|\bprefer\b|cheape|\bthreshold\b|\bbest (?:model|Harness|route)\b|auto[_-]?(?:delegate|select|route|choose)/i;
    for (const name of canonicalSkills) {
      const skillRoot = path.join(root, "plugins", "codex-harnessdock", "skills", name);
      for (const file of ["SKILL.md", path.join("agents", "openai.yaml")]) {
        const text = fs.readFileSync(path.join(skillRoot, file), "utf8");
        assert.doesNotMatch(text, policy, `${name}/${file} states route policy`);
      }
    }
  });

  it("keeps package-owned base metadata synchronized with one local plugin cachebuster", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "plugins", "codex-harnessdock", ".codex-plugin", "plugin.json"), "utf8"),
    );
    const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(packageJson.version, releaseMetadata.version);
    assert.equal(lockfile.version, packageJson.version);
    assert.equal(lockfile.packages[""].version, packageJson.version);
    assert.equal(manifest.version.split("+")[0], packageJson.version);
    assert.match(manifest.version, pluginVersionPattern);
    assert.doesNotMatch(marketplace.plugins.find((plugin) => plugin.name === "codex-harnessdock").description, /v0\.4\.0/);
  });
});
