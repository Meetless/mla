#!/usr/bin/env node
// Bounded JSON-RPC probe for `mla mcp` (release-testing proposal §6.2, boot half).
//
// Spawns the given mla binary as `mla mcp` over stdio, drives the newline-delimited
// JSON-RPC handshake (initialize -> tools/list), and asserts:
//   * initialize returns result.serverInfo.name === "meetless-mcp"
//   * tools/list returns a non-empty array
//   * closing stdin (EOF) makes the server exit 0 with no lingering process
//
// It runs under a hard timeout that SIGKILLs the whole child on expiry, captures
// stderr for diagnosis, and treats a premature exit or a missing response as a
// failure (proposal §144). Non-JSON stdout lines are skipped rather than failed,
// so a stray banner cannot red the run; an absent/garbled RESPONSE still fails via
// the timeout. Env (isolated HOME/MEETLESS_HOME, MEETLESS_MCP_SUPERVISOR=0) is
// inherited from the caller.
import { spawn } from "node:child_process";

const bin = process.argv[2];
if (!bin) {
  console.error("mcp-probe: missing mla binary path");
  process.exit(2);
}

const TIMEOUT_MS = 20000;
const child = spawn(bin, ["mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let stdoutBuf = "";
let stderrBuf = "";
let settled = false;
const seen = { init: false, tools: false };

const killChild = () => {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
};

const fail = (msg) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.error("mcp-probe: FAIL: " + msg);
  if (stderrBuf.trim()) console.error("--- child stderr ---\n" + stderrBuf.trim());
  killChild();
  process.exit(1);
};

const timer = setTimeout(
  () => fail(`no valid handshake within ${TIMEOUT_MS}ms`),
  TIMEOUT_MS,
);

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

child.on("error", (e) => fail("spawn error: " + e.message));
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore non-JSON-RPC noise; a missing response still times out
    }
    if (msg.id === 1) {
      const info = msg.result && msg.result.serverInfo;
      if (!info || info.name !== "meetless-mcp") {
        return fail("initialize serverInfo.name != meetless-mcp: " + JSON.stringify(info));
      }
      seen.init = true;
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (msg.id === 2) {
      const tools = msg.result && msg.result.tools;
      if (!Array.isArray(tools) || tools.length === 0) {
        return fail("tools/list returned empty/invalid: " + JSON.stringify(msg.result));
      }
      seen.tools = true;
      child.stdin.end(); // EOF -> the server should shut down cleanly
    }
  }
});

child.on("exit", (code, signal) => {
  if (settled) return;
  clearTimeout(timer);
  if (!seen.init || !seen.tools) {
    return fail(
      `server exited before the handshake completed (init=${seen.init}, tools=${seen.tools}, code=${code}, signal=${signal})`,
    );
  }
  if (code !== 0) {
    return fail(`server did not exit 0 on EOF (code=${code}, signal=${signal})`);
  }
  settled = true;
  console.log("mcp-probe: OK (serverInfo=meetless-mcp, tools non-empty, clean EOF exit)");
  process.exit(0);
});

// Kick off the handshake.
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mla-smoke", version: "0" },
  },
});
