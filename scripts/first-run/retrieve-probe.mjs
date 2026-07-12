#!/usr/bin/env node
// Authed JSON-RPC probe for `mla mcp` retrieve_knowledge (first-run harness).
//
// Extends scripts/smoke/mcp-probe.mjs with the step smoke deliberately never does:
// an actual `tools/call meetless__retrieve_knowledge` against PROD, authed as the
// logged-in user, so it proves the end-to-end retrieval path (JSON-RPC -> control
// auth -> intel retrieve -> evidence back), not just that `tools/list` is non-empty
// offline. Workspace is resolved by `mla mcp` from the nearest `.meetless.json`
// marker; the caller pins it via MEETLESS_PROJECT_DIR to a populated workspace so
// the answer is grounded.
//
// Exit codes (so the caller can score precisely):
//   0  grounded: tool call succeeded AND evidence came back
//   3  authed-but-empty: tool call succeeded (no 401/isError) but no evidence rows
//      -- the retrieval path works; the target corpus just had no match
//   4  access-denied: tool ran but the target workspace is not readable by the
//      logged-in identity (403 / not a member / auth failed). The CALLER decides what
//      this means: on a NON-MEMBER --ask-workspace it is correct ACL -> WARN; on the
//      run's OWN freshly-provisioned ws it is NOT correct ACL (the identity owns it)
//      -- it is intel's <=60s stale-membership cache, which the caller rides out in
//      the ask step, so a 4 that survives is scored FAIL.
//   1  failure: spawn / handshake / tool missing / genuine isError / timeout
//   2  usage error
import { spawn } from "node:child_process";

const bin = process.argv[2];
const query = process.argv[3] || "What are the hard constraints for this repo?";
if (!bin) {
  console.error("retrieve-probe: missing mla binary path");
  process.exit(2);
}

const TIMEOUT_MS = 45000; // real prod round-trip: retrieval can take a few seconds
const child = spawn(bin, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });

let stdoutBuf = "";
let stderrBuf = "";
let settled = false;
let toolName = "";
const seen = { init: false, tools: false, call: false };

const killChild = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };

const done = (code, msg) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (code === 0) console.log("retrieve-probe: OK " + msg);
  else if (code === 3) console.log("retrieve-probe: EMPTY " + msg);
  else if (code === 4) console.error("retrieve-probe: DENIED " + msg);
  else {
    console.error("retrieve-probe: FAIL: " + msg);
    if (stderrBuf.trim()) console.error("--- child stderr ---\n" + stderrBuf.trim());
  }
  killChild();
  process.exit(code);
};

const fail = (msg) => done(1, msg);

const timer = setTimeout(() => fail(`no completed retrieve within ${TIMEOUT_MS}ms`), TIMEOUT_MS);
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

child.on("error", (e) => fail("spawn error: " + e.message));
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

// Heuristic: does the tool payload actually carry grounded evidence? We accept
// either a parseable non-empty array/object with a count, or the citation tokens
// the retrieval surface stamps (NT:/DD:/TH:/kbdoc:/claimspan:).
const looksGrounded = (text) => {
  if (!text || !text.trim()) return false;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j.length > 0;
    if (j && typeof j === "object") {
      for (const k of ["evidence", "candidates", "results", "items", "hits"]) {
        if (Array.isArray(j[k])) return j[k].length > 0;
      }
      if (typeof j.count === "number") return j.count > 0;
    }
  } catch { /* not JSON; fall through to token scan */ }
  return /\b(NT:|DD:|TH:|kbdoc:|claimspan:|note:)/.test(text);
};

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id === 1) {
      const info = msg.result && msg.result.serverInfo;
      if (!info || info.name !== "meetless-mcp") {
        return fail("initialize serverInfo.name != meetless-mcp: " + JSON.stringify(info));
      }
      seen.init = true;
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (msg.id === 2) {
      const tools = (msg.result && msg.result.tools) || [];
      const hit = tools.find((t) => t && typeof t.name === "string" && t.name.includes("retrieve_knowledge"));
      if (!hit) return fail("retrieve_knowledge not in tools/list: " + tools.map((t) => t && t.name).join(","));
      toolName = hit.name;
      seen.tools = true;
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: toolName, arguments: { query, limit: 5 } },
      });
    } else if (msg.id === 3) {
      seen.call = true;
      if (msg.error) return fail("tools/call returned JSON-RPC error: " + JSON.stringify(msg.error));
      const res = msg.result || {};
      if (res.isError) {
        const t = (res.content || []).map((c) => c && c.text).filter(Boolean).join(" ");
        const detail = t || JSON.stringify(res);
        // A 403 / membership / auth-failed denial => access-denied (4); the CALLER
        // decides correct-ACL-WARN (non-member ws) vs stale-membership-FAIL (own ws).
        // Everything else (route/tool/route-5xx) is a real isError that must FAIL.
        if (/\b403\b|authentication failed|WORKSPACE_ACCESS_DENIED|not a member|access denied|unauthori[sz]ed|forbidden/i.test(detail)) {
          return done(4, "target workspace not readable by this identity (403/not-a-member): " + detail);
        }
        return fail("tool reported isError (auth/route problem?): " + detail);
      }
      const text = (res.content || []).map((c) => c && c.text).filter(Boolean).join("\n");
      child.stdin.end(); // EOF -> clean shutdown
      if (looksGrounded(text)) {
        return done(0, `(tool=${toolName}, grounded evidence returned, ${text.length} chars)`);
      }
      return done(3, `(tool=${toolName}, authed OK but no evidence rows for query)`);
    }
  }
});

child.on("exit", (code, signal) => {
  if (settled) return;
  clearTimeout(timer);
  if (!seen.call) {
    return fail(`server exited before retrieve completed (init=${seen.init}, tools=${seen.tools}, call=${seen.call}, code=${code}, signal=${signal})`);
  }
  // call was scored already in the id===3 branch; a later nonzero exit is noise.
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mla-first-run", version: "0" } },
});
