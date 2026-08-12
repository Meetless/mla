/**
 * M1: the tool contract must be able to move mid-session.
 *
 * Run: node --test
 *
 * Measured host behaviour (2026-08-09, real binaries, server-side JSON-RPC log):
 *
 *   Claude Code 2.1.211  protocol 2025-11-25
 *     - emits `tools/list` again 5 ms after `notifications/tools/list_changed`,
 *       and the refreshed schema reaches the MODEL (it called a brand-new tool
 *       and passed a brand-new parameter).
 *     - a clean stdio exit(0) IS transparently respawned, but the respawned
 *       process is never asked for `tools/list`. So a respawn moves the handler
 *       and NOT the advertised schema.
 *   Codex 0.144.6        protocol 2025-06-18
 *     - ignores the notification (no second tools/list, ever).
 *     - a clean exit(0) is fatal: "Transport closed", the server is dead for the
 *       rest of the session.
 *
 * Consequences pinned here:
 *   1. The server must DECLARE tools.listChanged, or a compliant host has no
 *      reason to subscribe (and the SDK's assertNotificationCapability gates on
 *      the server's own declared capabilities).
 *   2. A supervised RELOAD must announce the change, because the supervisor holds
 *      fd 0/1 across the worker swap so the host sees no disconnect and would
 *      otherwise keep serving the pre-reload schema to the model forever.
 *   3. A FIRST boot must NOT announce: the host is about to call tools/list
 *      anyway as part of the handshake.
 *
 * There is zero schema/handler skew by construction: the notification is emitted
 * by the freshly-spawned worker, and that same process answers the follow-up
 * tools/list from its own in-memory manifest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer, runStdioServer } from "./server.js";

function baseDeps(overrides = {}) {
  return {
    controlFetch: async () => ({}),
    intelFetch: async () => ({}),
    intelAsk: async () => ({}),
    defaultWorkspaceId: "ws_test",
    notesRoot: "/tmp/does-not-exist",
    ...overrides,
  };
}

// A transport double: records everything the server writes, and lets the test
// close the connection so runStdioServer's await resolves.
function fakeTransport() {
  const sent = [];
  const t = {
    sent,
    async start() {},
    async send(msg) {
      sent.push(msg);
    },
    async close() {
      t.onclose?.();
    },
  };
  return t;
}

test("the ACTIVE server declares tools.listChanged so a host subscribes to schema changes", () => {
  const server = createMcpServer(baseDeps());
  // The SDK stores the declared capabilities and gates
  // assertNotificationCapability("notifications/tools/list_changed") on them.
  const caps = server.getCapabilities?.() ?? server._capabilities;
  assert.ok(caps && caps.tools, "server must declare a tools capability");
  assert.equal(
    caps.tools.listChanged,
    true,
    "tools.listChanged must be declared; without it a compliant host has no " +
      "reason to re-request tools/list and every MCP schema fix stays invisible",
  );
});

test("the INACTIVE (status-only) server also declares tools.listChanged", () => {
  // An inactive server becomes active after `mla activate` + a reload, which is
  // exactly a tool-list change. Declaring it here costs nothing and keeps the
  // two front doors from diverging on the protocol contract.
  const server = createMcpServer({
    mode: "inactive",
    status: {
      state: "inactive",
      reason: "not-activated",
      message: "not activated",
      action: { command: "mla activate" },
    },
  });
  const caps = server.getCapabilities?.() ?? server._capabilities;
  assert.equal(caps?.tools?.listChanged, true);
});

test("sendToolListChanged does not throw on the active server (capability gate satisfied)", async () => {
  const server = createMcpServer(baseDeps());
  const transport = fakeTransport();
  await server.connect(transport);
  await server.sendToolListChanged();
  const methods = transport.sent.map((m) => m.method);
  assert.ok(
    methods.includes("notifications/tools/list_changed"),
    `expected the list-changed notification, got ${JSON.stringify(methods)}`,
  );
  await server.close();
});

test("runStdioServer ANNOUNCES the tool-list change when this boot is a supervised reload", { timeout: 8000 }, async () => {
  const transport = fakeTransport();
  const done = runStdioServer(
    baseDeps({ announceToolListChanged: true }),
    { createTransport: () => transport },
  );
  // Let connect + announce flush.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const methods = transport.sent.map((m) => m.method);
  assert.ok(
    methods.includes("notifications/tools/list_changed"),
    `a reloaded worker must announce its new contract; sent ${JSON.stringify(methods)}`,
  );
  await transport.close();
  await done;
});

test("runStdioServer stays SILENT on a first boot (the host lists as part of the handshake)", { timeout: 8000 }, async () => {
  const transport = fakeTransport();
  const done = runStdioServer(baseDeps(), { createTransport: () => transport });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const methods = transport.sent.map((m) => m.method);
  assert.ok(
    !methods.includes("notifications/tools/list_changed"),
    `a first boot must not announce; sent ${JSON.stringify(methods)}`,
  );
  await transport.close();
  await done;
});

test("an announce failure never prevents the server from serving (fails open)", { timeout: 8000 }, async () => {
  const transport = fakeTransport();
  transport.send = async (msg) => {
    if (msg.method === "notifications/tools/list_changed") {
      throw new Error("client went away mid-announce");
    }
    transport.sent.push(msg);
  };
  const done = runStdioServer(
    baseDeps({ announceToolListChanged: true }),
    { createTransport: () => transport },
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await transport.close();
  // The await must resolve normally: a failed courtesy notification is not a
  // reason to take the server down.
  await done;
});
