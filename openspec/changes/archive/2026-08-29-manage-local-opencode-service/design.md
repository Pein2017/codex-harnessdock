## Context

HarnessDock already owns a single fixed dotenv parser, a pinned fixed-origin OpenCode client, process-identity checks, and a stale-safe cross-process directory lock. The missing behavior is lifecycle glue: OpenCode is attach-only, so no Server survives unless the operator keeps a terminal open; Pi discovery also loses its fixed agent directory when the long-lived MCP process did not inherit shell configuration.

## Goals / Non-Goals

**Goals:**
- make Pi and OpenCode use allowlisted values from the existing canonical `config/runtime.env`;
- reuse or start one loopback OpenCode Server across concurrent MCP processes;
- preserve the user's native Pi/OpenCode authentication, models, plugins, MCPs, tools, and configuration;
- expose bounded actionable readiness without a model call.

**Non-Goals:**
- per-Agent Servers, a general supervisor, public lifecycle/config selectors, automatic login/install, model fallback, or a second env mechanism;
- stopping an external or reused Server;
- making doctor or `list_harnesses` mutating operations.

## Decisions

### Reuse the canonical dotenv boundary

Add `PI_CODING_AGENT_DIR` and `OPENCODE_EXECUTABLE` to the existing environment allowlist and tracked `config/runtime.env`. Driver construction receives only its bounded view. Shell profiles remain optional direct-CLI convenience and are never loaded by HarnessDock.

Alternative rejected: source `/root/.bashrc`. It is executable shell, process-dependent, non-portable across MCP bootstrap, and violates the existing data-only trust boundary.

### Ensure one shared OpenCode service at bootstrap and before spawn

An internal `opencode-service-manager` reuses the existing fixed client and process helpers. MCP startup attempts `ensure()` once so ordinary listing sees ready state without a user terminal; OpenCode spawn calls it again to recover from a later crash. Ensure failure is scoped to the OpenCode instance and does not prevent Claude or Pi registration. `list_harnesses` and doctor never call `ensure()`.

Alternative rejected: one Server per Agent. It adds ports, cleanup, config drift, and duplicate native resources without improving the fixed local subscription use case.

### Serialize ownership with existing lock and identity primitives

Ensure first probes the fixed origin. If unavailable, contenders acquire one owner-only durable directory lock, re-probe, validate any private managed-process receipt, and only then spawn the exact configured executable as `serve --hostname 127.0.0.1 --port <fixed-port>`. The receipt records the minimum process identity and command fingerprint. Other MCP processes wait on the same bounded lock and re-probe. A healthy compatible pre-existing Server is reused without being claimed.

If the port is occupied by an incompatible service, readiness fails closed. If the current contender's exact new child fails startup, it may terminate only that child. Managed Servers intentionally outlive their launching MCP for later reuse; this change adds no public stop operation.

### Keep native behavior behind the Server

The process is not launched with `--pure`, an agent selector, provider/model overrides, or model commands. All provider discovery, session, message, and result operations remain on the pinned SDK. Workspace directory continues to be supplied per request, so the Server resolves the same native configuration as direct OpenCode use.

### Replace Pi catch-all readiness with a closed taxonomy

Pi inspection classifies missing agent directory, invalid executable, RPC incompatibility, timeout, malformed protocol, and other bounded discovery failures. Raw paths, stderr, configuration, and secrets are not projected. Spawn continues to fail closed against fresh exact model/effort discovery.

## Risks / Trade-offs

- A managed Server persists after an MCP process exits. This is intentional reuse; ownership evidence prevents HarnessDock from confusing a foreign process with its child.
- Simultaneous first boot can race. The existing cross-process lock plus a second health probe makes process creation single-writer.
- Startup can fail after the child is created but before the receipt is durable. The current contender retains the exact child handle and may terminate only that child.
- OpenCode configuration may change while the Server lives. Fresh `/provider` discovery before every spawn remains authoritative; HarnessDock does not cache route admission.

## Migration Plan

1. Add the two fixed keys to the canonical env file and bounded loader.
2. Add focused falsification tests for env independence, concurrent ensure/reuse, stale ownership, foreign-port fail-closed behavior, and Pi reason projection.
3. Integrate ensure at MCP bootstrap and OpenCode spawn, update doctor/release acceptance, then run `npm run check`.
4. Bump the minor release, refresh the canonical installed Plugin, and validate doctor plus live `list_harnesses` without a model turn.

Rollback restores attach-only runtime behavior. An already-running compatible Server is left untouched and can be reused or stopped by the operator; rollback never kills it.
