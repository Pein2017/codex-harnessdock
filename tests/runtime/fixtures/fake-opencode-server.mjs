/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * A minimal configurable HTTP fake of the OpenCode Server surface the pinned
 * client actually uses: the side-effect-free GET discovery routes
 * (health/agents/provider/capabilities) plus, for Task 5, exactly the two
 * mutating routes one turn needs -- `POST /session` and
 * `POST /session/{sessionID}/message`.
 *
 * Only those routes exist. A client that ever tried `prompt_async`, `abort`,
 * `fork`, `share`, `summarize`, `command`, `shell`, or `revert` would 404 here,
 * and the runtime's own admission gate refuses them before the network anyway.
 *
 * Every request is recorded with its method, path, and (for the two mutating
 * routes) its parsed body, so a test can assert exactly what the runtime sent:
 * no `tools`, no `system`, no `variant`, no per-session `permission` ruleset.
 */
import http from "node:http";

const ROUTES = {
  "/global/health": "health",
  "/config": "config",
  "/agent": "agents",
  "/provider": "provider",
  "/experimental/capabilities": "capabilities",
};

const PROMPT_PATH_PATTERN = /^\/session\/([^/]+)\/message$/;

/** The pinned assistant-message shape, with only the fields the runtime reads. */
export function fakeAssistantMessage(overrides = {}) {
  return {
    id: "msg_assistant_fake",
    sessionID: "ses_fake",
    role: "assistant",
    time: { created: 1_764_000_000_000, completed: 1_764_000_002_000 },
    parentID: "msg_user_fake",
    modelID: "gpt-5.6-luna",
    providerID: "openai",
    mode: "primary",
    agent: "codex-explorer",
    variant: "high",
    path: { cwd: "/opt/operator-owned/workspace", root: "/opt/operator-owned/workspace" },
    cost: 0.001,
    tokens: { total: 100, input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...overrides,
  };
}

/** One assistant text part bound to a message. */
export function fakeTextPart(text, overrides = {}) {
  return {
    id: "prt_text_fake",
    sessionID: "ses_fake",
    messageID: "msg_assistant_fake",
    type: "text",
    text,
    time: { start: 1_764_000_001_000, end: 1_764_000_002_000 },
    ...overrides,
  };
}

export function createFakeOpencodeServer(scenario = {}) {
  const state = {
    health: scenario.health ?? { status: 200, body: { healthy: true, version: "1.18.18" } },
    config: scenario.config ?? { status: 200, body: {} },
    agents: scenario.agents ?? { status: 200, body: [{ name: "codex-explorer", mode: "primary", native: false }] },
    provider: scenario.provider ?? { status: 200, body: { all: [], connected: [], default: {} } },
    capabilities: scenario.capabilities ?? { status: 200, body: { backgroundSubagents: false } },
    auth: scenario.auth ?? null,
    delayMsByPath: scenario.delayMsByPath ?? {},
    hangPaths: new Set(scenario.hangPaths ?? []),
    redirectPaths: scenario.redirectPaths ?? {},
    malformedPaths: new Set(scenario.malformedPaths ?? []),
    // path -> declares a Content-Length far larger than the body actually sent,
    // to exercise a declared-size precheck without transferring real bytes.
    oversizedDeclaredLengthPaths: new Set(scenario.oversizedDeclaredLengthPaths ?? []),
    // path -> total bytes to actually stream with no Content-Length header
    // (chunked), to exercise a streaming/decoded size cap.
    oversizedStreamingPaths: scenario.oversizedStreamingPaths ?? {},

    // --- session create ---------------------------------------------------
    /** Session ids handed out in order; the default generates its own. */
    sessionIds: [...(scenario.sessionIds ?? [])],
    sessionStatus: scenario.sessionStatus ?? 200,
    /** Replaces the whole create response body when set. */
    sessionBody: scenario.sessionBody ?? null,
    sessionDelayMs: scenario.sessionDelayMs ?? 0,
    sessionHang: scenario.sessionHang === true,
    sessionMalformed: scenario.sessionMalformed === true,
    sessionDestroy: scenario.sessionDestroy === true,

    // --- prompt -----------------------------------------------------------
    /**
     * `(request) => {status?, body?, malformed?, destroy?, delayMs?}` or a
     * static object of the same shape. `request` carries `{sessionId, body, query}`.
     */
    prompt: scenario.prompt ?? null,
    promptDelayMs: scenario.promptDelayMs ?? 0,
    promptHang: scenario.promptHang === true,
    promptMalformed: scenario.promptMalformed === true,
    promptDestroy: scenario.promptDestroy === true,
    promptStatus: scenario.promptStatus ?? 200,
  };
  const requests = [];
  let sessionSequence = 0;

  function nextSessionId() {
    sessionSequence += 1;
    if (state.sessionIds.length > 0) {
      // The last configured id repeats, which is how a duplicate-session-id
      // Server is simulated.
      const index = Math.min(sessionSequence - 1, state.sessionIds.length - 1);
      return state.sessionIds[index];
    }
    return `ses_fake_${sessionSequence}`;
  }

  function defaultPromptBody({ sessionId, body }) {
    const messageId = "msg_assistant_fake";
    const info = fakeAssistantMessage({
      id: messageId,
      sessionID: sessionId,
      parentID: body?.messageID ?? "msg_user_fake",
      modelID: body?.model?.modelID ?? "gpt-5.6-luna",
      providerID: body?.model?.providerID ?? "openai",
      variant: body?.variant,
      agent: body?.agent ?? "codex-explorer",
    });
    return {
      info,
      parts: [fakeTextPart("The fake Explorer answer.", { sessionID: sessionId, messageID: messageId })],
    };
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://placeholder.invalid");
    const pathname = url.pathname;
    const record = {
      method: req.method,
      path: pathname,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
      query: Object.fromEntries(url.searchParams.entries()),
    };
    requests.push(record);

    if (state.hangPaths.has(pathname)) return; // never responds; caller deadline must fire

    if (state.auth) {
      const expected = `Basic ${Buffer.from(`${state.auth.username}:${state.auth.password}`, "utf8").toString("base64")}`;
      if (req.headers.authorization !== expected) {
        sendJson(res, 401, { message: "unauthorized" });
        return;
      }
    }

    if (state.redirectPaths[pathname]) {
      res.writeHead(302, { Location: state.redirectPaths[pathname] });
      res.end();
      return;
    }

    if (state.oversizedDeclaredLengthPaths.has(pathname)) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "999999999" });
      res.end(JSON.stringify({ healthy: true, version: "1.18.18" }));
      return;
    }

    if (pathname in state.oversizedStreamingPaths) {
      res.writeHead(200, { "Content-Type": "application/json" }); // no Content-Length => chunked
      const totalBytes = state.oversizedStreamingPaths[pathname];
      const chunk = Buffer.alloc(4096, 0x20);
      let sent = 0;
      const pump = () => {
        if (sent >= totalBytes) {
          res.end();
          return;
        }
        const size = Math.min(chunk.length, totalBytes - sent);
        res.write(chunk.subarray(0, size));
        sent += size;
        setImmediate(pump);
      };
      pump();
      return;
    }

    // --- POST /session ----------------------------------------------------
    if (pathname === "/session" && req.method === "POST") {
      readBody(req).then((body) => {
        record.body = body;
        if (state.sessionHang) return;
        const respond = () => {
          if (state.sessionDestroy) {
            req.socket.destroy();
            return;
          }
          if (state.sessionMalformed) {
            sendJson(res, 200, "{not-valid-json");
            return;
          }
          if (state.sessionStatus !== 200) {
            sendJson(res, state.sessionStatus, { message: "session refused" });
            return;
          }
          const sessionId = nextSessionId();
          sendJson(res, 200, state.sessionBody ?? {
            id: sessionId,
            slug: sessionId,
            projectID: "prj_fake",
            directory: "/opt/operator-owned/workspace",
            title: "",
            version: "1.18.18",
            time: { created: 1_764_000_000_000, updated: 1_764_000_000_000 },
          });
        };
        if (state.sessionDelayMs) setTimeout(respond, state.sessionDelayMs);
        else respond();
      });
      return;
    }

    // --- POST /session/{id}/message ---------------------------------------
    const promptMatch = PROMPT_PATH_PATTERN.exec(pathname);
    if (promptMatch && req.method === "POST") {
      const sessionId = decodeURIComponent(promptMatch[1]);
      readBody(req).then((body) => {
        record.body = body;
        record.sessionId = sessionId;
        const configured =
          typeof state.prompt === "function" ? state.prompt({ sessionId, body, query: record.query }) : state.prompt ?? {};
        if (state.promptHang || configured.hang) return;
        const respond = () => {
          if (state.promptDestroy || configured.destroy) {
            req.socket.destroy();
            return;
          }
          if (state.promptMalformed || configured.malformed) {
            sendJson(res, 200, "{not-valid-json");
            return;
          }
          const status = configured.status ?? state.promptStatus;
          if (status !== 200) {
            sendJson(res, status, { message: "prompt refused" });
            return;
          }
          sendJson(res, 200, configured.body ?? defaultPromptBody({ sessionId, body }));
        };
        const delay = configured.delayMs ?? state.promptDelayMs;
        if (delay) setTimeout(respond, delay);
        else respond();
      });
      return;
    }

    const respond = () => {
      if (state.malformedPaths.has(pathname)) {
        sendJson(res, 200, "{not-valid-json");
        return;
      }
      const key = ROUTES[pathname];
      const entry = key ? state[key] : null;
      if (!entry) {
        sendJson(res, 404, { message: "not found" });
        return;
      }
      sendJson(res, entry.status, entry.body);
    };

    const delay = state.delayMsByPath[pathname];
    if (delay) setTimeout(respond, delay);
    else respond();
  });

  return {
    requests,
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
