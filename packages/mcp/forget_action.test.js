/**
 * Unit tests for meetless__forget (withdraw a prior conversational capture).
 *
 * Written before the implementation. forget maps to the governed withdraw
 * primitive (POST /internal/v1/kb/withdraw), which tombstones the document
 * (ACTIVE -> TOMBSTONED): it drops from retrieval at read time while keeping the
 * immutable revisions + audit. That is why the "undo" is only offered once this
 * is wired (An correction #9).
 *
 * Invariants:
 *   - it POSTs the source-tuple handle (withdraw takes {sourceSystem,
 *     sourceTenantId, externalObjectId}, NOT the documentId), with reason=deleted;
 *   - workspace is env-pinned from deps, never args;
 *   - it requires the handle a prior remember returned;
 *   - a not_found / already-withdrawn outcome is DATA, not an error.
 *
 * Run: `node --test forget_action.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runForget } from "./forget_action.js";
import { TOOLS, ADVERTISED_EVIDENCE_TOOLS, MUTATING_TOOL_NAMES } from "./tool_manifest.js";

const WS = "ws_test";
const HANDLE = {
  sourceSystem: "agent",
  sourceTenantId: "memory:ws_test",
  externalObjectId: "mem-abc123",
};

function recordingFetch(reply) {
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : undefined });
    return typeof reply === "function" ? reply(path, init) : reply;
  };
  return { fetchImpl, calls };
}

test("forget: POSTs the source-tuple handle with reason=deleted + the config actor", async () => {
  const { fetchImpl, calls } = recordingFetch({ outcome: "withdrawn", withdrawn: true, documentId: "doc_1", reason: "deleted", workspaceId: WS });
  const res = await runForget({ handle: HANDLE }, { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: "wu_owner" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/internal/v1/kb/withdraw");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, {
    workspaceId: WS,
    sourceSystem: HANDLE.sourceSystem,
    sourceTenantId: HANDLE.sourceTenantId,
    externalObjectId: HANDLE.externalObjectId,
    reason: "deleted",
    actor: "wu_owner",
  });
  assert.equal(res.forgotten, true);
});

test("forget: actor is the trusted config actor, never taken from args", async () => {
  const { fetchImpl, calls } = recordingFetch({ withdrawn: true });
  // A model-supplied actor in args must be ignored; only deps.operatorUserId is used.
  await runForget(
    { handle: HANDLE, actor: "wu_attacker", operatorUserId: "wu_attacker" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: "wu_owner" },
  );
  assert.equal(calls[0].body.actor, "wu_owner");
});

test("forget: requires the full handle", async () => {
  const { fetchImpl } = recordingFetch({ withdrawn: true });
  await assert.rejects(
    () => runForget({ handle: { sourceSystem: "agent" } }, { intelFetch: fetchImpl, defaultWorkspaceId: WS }),
    /handle/,
  );
});

test("forget: a not_found outcome is DATA, not an error", async () => {
  const { fetchImpl } = recordingFetch({ outcome: "not_found", withdrawn: false, reason: "not_found", workspaceId: WS });
  const res = await runForget({ handle: HANDLE }, { intelFetch: fetchImpl, defaultWorkspaceId: WS });
  assert.equal(res.forgotten, false);
  assert.equal(res.outcome, "not_found");
});

test("manifest: meetless__forget is advertised, mutating, disjoint from evidence tools", () => {
  assert.ok(MUTATING_TOOL_NAMES.includes("meetless__forget"));
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__forget"));
  const tool = TOOLS.find((t) => t.name === "meetless__forget");
  assert.ok(tool, "TOOLS advertises meetless__forget");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
});
