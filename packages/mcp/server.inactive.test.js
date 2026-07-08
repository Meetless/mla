/**
 * Inactive-mode MCP server: the "known not-activated / not-authenticated /
 * invalid-activation" front door.
 *
 * Run: node --test
 *
 * The bug this fixes: `mla`'s MCP server is registered globally, so Claude Code
 * spawns `mla mcp` in EVERY repo. In a directory that was never `mla activate`-d,
 * the old code exited nonzero BEFORE the MCP handshake completed, so Claude Code
 * painted a red "failed to connect" server. The fix makes a KNOWN-inactive state
 * complete the handshake (green/connected) but advertise ONLY a status tool and
 * touch NO backend. This test drives a real in-memory handshake to prove:
 *
 *   1. The server connects (completes init) with no backend deps at all.
 *   6. listTools returns EXACTLY one tool, `meetless__status`, and a call to it
 *      returns actionable text (the reason + the next step).
 *   7. Any OTHER tool name is a real unknown-tool error, not a silent fallback to
 *      the status text (no backend request is even possible: the deps carry none).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";

function inactiveDeps(overrides = {}) {
  return {
    mode: "inactive",
    status: {
      state: "inactive",
      reason: "not-activated",
      message:
        "Meetless is installed but inactive in this repository. No Meetless context is being injected.",
      action: { command: "mla activate" },
      ...overrides,
    },
  };
}

// Stand up an inactive server, link it to a fresh Client over an in-memory
// transport pair, and complete the handshake. Returns the connected client.
async function connectInactive(deps) {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-harness", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("inactive server completes the handshake with NO backend deps (green, not red)", async () => {
  // The whole point: no controlFetch, no intelFetch, no workspaceId. The old
  // code would have exited before connect. This must connect cleanly.
  const { client, server } = await connectInactive(inactiveDeps());
  // A completed connect() is the proof; getServerVersion is populated post-init.
  const info = client.getServerVersion();
  assert.equal(info.name, "meetless-mcp", "server identity stays stable (no dynamic naming)");
  await client.close();
  await server.close();
});

test("inactive server advertises EXACTLY the status tool", async () => {
  const { client, server } = await connectInactive(inactiveDeps());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1, "exactly one tool");
  assert.equal(tools[0].name, "meetless__status");
  await client.close();
  await server.close();
});

test("calling meetless__status returns the reason and the next step", async () => {
  const { client, server } = await connectInactive(inactiveDeps());
  const res = await client.callTool({ name: "meetless__status", arguments: {} });
  assert.ok(Array.isArray(res.content) && res.content[0].type === "text");
  const text = res.content[0].text;
  assert.match(text, /installed but inactive/i, "carries the reason");
  assert.match(text, /Next step: mla activate/, "carries the actionable next step");
  await client.close();
  await server.close();
});

test("the not-activated status points the next step at `mla activate` and adds a doctor diagnosis line", async () => {
  const { client, server } = await connectInactive(inactiveDeps());
  const res = await client.callTool({ name: "meetless__status", arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /Next step: mla activate/);
  assert.match(text, /For a full diagnosis: mla doctor/);
  await client.close();
  await server.close();
});

test("the invalid-activation status routes to `mla doctor` WITHOUT a duplicate diagnosis line", async () => {
  const { client, server } = await connectInactive(
    inactiveDeps({
      reason: "invalid-activation",
      message:
        "Meetless activation is incomplete in this repository. Run `mla doctor`, then rerun `mla activate` to repair it.",
      action: { command: "mla doctor" },
    }),
  );
  const res = await client.callTool({ name: "meetless__status", arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /Next step: mla doctor/);
  // doctor is already the next step, so we must NOT also append the redundant
  // "For a full diagnosis" line (the message body may still mention doctor).
  assert.doesNotMatch(
    text,
    /For a full diagnosis: mla doctor/,
    "no redundant diagnosis line when doctor is already the action",
  );
  await client.close();
  await server.close();
});

test("any OTHER tool is a real unknown-tool error, not a silent status fallback", async () => {
  const { client, server } = await connectInactive(inactiveDeps());
  await assert.rejects(
    client.callTool({ name: "meetless__retrieve_knowledge", arguments: { query: "x" } }),
    /Unknown tool/i,
    "an inactive server must not answer arbitrary tool names",
  );
  await client.close();
  await server.close();
});
