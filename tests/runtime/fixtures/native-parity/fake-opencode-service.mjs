#!/usr/bin/env node
/** SPDX-License-Identifier: Apache-2.0 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

const args = process.argv.slice(2);
const [command, hostFlag, host, portFlag, rawPort] = args;
const port = Number(rawPort);
if (command !== "serve" || hostFlag !== "--hostname" || host !== "127.0.0.1" || portFlag !== "--port" || !Number.isSafeInteger(port) || port < 1) {
  process.exitCode = 64;
} else {
  const record = process.env.OPENCODE_NATIVE_PARITY_RECORD;
  if (record) {
    fs.writeFileSync(record, `${JSON.stringify({
      pid: process.pid,
      argv: args,
      cwd: process.cwd(),
      permissionDigest: digest(process.env.OPENCODE_PERMISSION ?? null),
      configurationDigest: digest(process.env.OPENCODE_NATIVE_PARITY_CONFIG ?? null),
    })}\n`);
  }
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && new URL(request.url ?? "/", "http://placeholder.invalid").pathname === "/global/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ healthy: process.env.OPENCODE_NATIVE_PARITY_HEALTH !== "unhealthy", version: "1.18.23" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"message":"not found"}');
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(port, host);
}
