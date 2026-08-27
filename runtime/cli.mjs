#!/usr/bin/env node
/** SPDX-License-Identifier: Apache-2.0 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { readStdinIfPiped } from "./input.mjs";
import { createAgentRuntime } from "./index.mjs";
import { createInternalAgentRuntime } from "./internal-runtime.mjs";

const PUBLIC_COMMANDS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "read_agent_messages",
  "list_agents",
  "list_harnesses",
]);

function usage() {
  return [
    "Usage:",
    "  node runtime/cli.mjs spawn_agent --task-name <name> --harness <harness> --model <full-model-id> --topology <leaf|native_orchestrator> --write=<true|false> [options] <message>",
    "  node runtime/cli.mjs send_message <exact-target> <message>",
    "  node runtime/cli.mjs followup_task <exact-target> <message>",
    "  node runtime/cli.mjs wait_agent [--timeout-ms <ms>] [--targets <csv>] [--wake-on-progress] [--acknowledge-tokens <csv>]",
    "  node runtime/cli.mjs interrupt_agent <exact-target>",
    "  node runtime/cli.mjs read_agent_messages <exact-target> [--before <message-id>] [--limit <1-20>]",
    "  node runtime/cli.mjs list_agents [--path-prefix </root/prefix>]",
    "  node runtime/cli.mjs list_harnesses",
    "",
    "Internal diagnostics:",
    "  node runtime/cli.mjs readiness",
  ].join("\n");
}

function normalizeArgv(argv) {
  if (argv.length === 1 && String(argv[0] ?? "").trim()) {
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function parse(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd", "env-file", ...(config.valueOptions ?? [])],
    booleanOptions: ["json", ...(config.booleanOptions ?? [])],
    aliasMap: { C: "cwd", m: "model", ...(config.aliasMap ?? {}) },
  });
}

function runtimeOptions(options) {
  return {
    cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
    envFile: options["env-file"] ?? null,
    env: process.env,
  };
}

function output(payload, json = false) {
  const text = JSON.stringify(payload, null, 2);
  process.stdout.write(json ? `${text}\n` : `${text}\n`);
}

function rejectForbiddenPublicArgs(argv) {
  const forbidden = normalizeArgv(argv).find((value) =>
    /^(?:--all|--cwd|--env-file|--owner(?:-root|-session)?-id|--resume-session|--session-id|--agent-type|--service-tier|--allowed-tools)(?:=|$)/.test(value) ||
    /^(?:-C)(?:=|$)/.test(value)
  );
  if (forbidden) {
    throw new Error(
      `Unsupported model-facing option ${forbidden}. Lifecycle workspace is inherited from the Codex working directory; environment, cross-root, and foreign-session selectors are not public operations.`
    );
  }
}

function messageFrom(options, positionals, startIndex = 0) {
  if (options.message != null) return String(options.message);
  const positional = positionals.slice(startIndex).join(" ");
  return positional || readStdinIfPiped();
}

async function spawnAgent(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, {
    valueOptions: [
      "task-name",
      "message",
      "description",
      "harness",
      "model",
      "topology",
      "reasoning-effort",
      "prompt-file",
    ],
    booleanOptions: ["write"],
  });
  const cwd = runtimeOptions(options).cwd;
  const message = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : messageFrom(options, positionals);
  const receipt = await createAgentRuntime(runtimeOptions(options)).spawn_agent({
    task_name: options["task-name"],
    message,
    description: options.description,
    harness: options.harness,
    model: options.model,
    topology: options.topology,
    reasoning_effort: options["reasoning-effort"],
    write: Object.hasOwn(options, "write") ? Boolean(options.write) : undefined,
  });
  output(receipt, options.json);
}

async function listHarnesses(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options } = parse(argv, {});
  const receipt = await createAgentRuntime(runtimeOptions(options)).list_harnesses({});
  output(receipt, options.json);
}

function targetAndMessage(options, positionals) {
  const target = options.target ?? positionals[0];
  const message = messageFrom(options, positionals, options.target ? 0 : 1);
  return { target, message };
}

function sendMessage(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, { valueOptions: ["target", "message"] });
  const receipt = createAgentRuntime(runtimeOptions(options)).send_message(
    targetAndMessage(options, positionals)
  );
  output(receipt, options.json);
}

async function followupTask(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, {
    valueOptions: [
      "target",
      "message",
      "reasoning-effort",
    ],
  });
  const receipt = await createAgentRuntime(runtimeOptions(options)).followup_task({
    ...targetAndMessage(options, positionals),
    reasoning_effort: options["reasoning-effort"],
  });
  output(receipt, options.json);
}

async function waitAgent(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, {
    valueOptions: ["timeout-ms", "targets", "acknowledge-tokens"],
    booleanOptions: ["wake-on-progress"],
  });
  if (positionals.length > 0) {
    throw new Error("wait_agent is root-scoped and accepts Agent targets only through --targets <csv>.");
  }
  const receipt = await createAgentRuntime(runtimeOptions(options)).wait_agent({
    timeout_ms: options["timeout-ms"],
    ...(Object.hasOwn(options, "targets")
      ? {
          targets: String(options.targets ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {}),
    wake_on_progress: Object.hasOwn(options, "wake-on-progress")
      ? Boolean(options["wake-on-progress"])
      : undefined,
    acknowledge_tokens: String(options["acknowledge-tokens"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  output(receipt, options.json);
}

async function interruptAgent(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, { valueOptions: ["target"] });
  const target = options.target ?? positionals[0];
  if (positionals.length > (options.target ? 0 : 1)) {
    throw new Error("interrupt_agent accepts exactly one target.");
  }
  const receipt = await createAgentRuntime(runtimeOptions(options)).interrupt_agent({ target });
  output(receipt, options.json);
}

function listAgents(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, { valueOptions: ["path-prefix"] });
  if (positionals.length > 0) throw new Error("list_agents accepts only --path-prefix.");
  const receipt = createAgentRuntime(runtimeOptions(options)).list_agents({
    path_prefix: options["path-prefix"],
  });
  output(receipt, options.json);
}

async function readAgentMessages(argv) {
  rejectForbiddenPublicArgs(argv);
  const { options, positionals } = parse(argv, {
    valueOptions: ["target", "before", "limit"],
  });
  const target = options.target ?? positionals[0];
  if (positionals.length > (options.target ? 0 : 1)) {
    throw new Error("read_agent_messages accepts exactly one target plus optional --before/--limit.");
  }
  const receipt = await createAgentRuntime(runtimeOptions(options)).read_agent_messages({
    target,
    before: options.before,
    limit: options.limit,
  });
  output(receipt, options.json);
}

async function worker(argv) {
  const { options } = parse(argv, {
    valueOptions: ["job-id", "agent-id", "attempt-id", "reasoning-effort"],
  });
  if (!options["job-id"]) throw new Error("worker requires --job-id.");
  // A version-three handoff states its Agent and attempt; a legacy handoff
  // states neither and reads its whole turn from the stored job record.
  await createInternalAgentRuntime(runtimeOptions(options)).runWorker(options["job-id"], {
    agentId: options["agent-id"],
    attemptId: options["attempt-id"],
    effort: options["reasoning-effort"],
  });
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "spawn_agent": await spawnAgent(argv); break;
    case "list_harnesses": await listHarnesses(argv); break;
    case "send_message": sendMessage(argv); break;
    case "followup_task": await followupTask(argv); break;
    case "wait_agent": await waitAgent(argv); break;
    case "interrupt_agent": await interruptAgent(argv); break;
    case "read_agent_messages": await readAgentMessages(argv); break;
    case "list_agents": listAgents(argv); break;
    case "worker": await worker(argv); break;
    case "readiness": {
      const { options } = parse(argv);
      output(createInternalAgentRuntime(runtimeOptions(options)).readiness(), options.json);
      break;
    }
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(`${usage()}\n`);
      break;
    default:
      if (!PUBLIC_COMMANDS.has(command)) {
        throw new Error(`Unknown or removed command ${command}.\n${usage()}`);
      }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
