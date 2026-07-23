/**
 * Unit tests for the MCP meetless__decision_record handler (ADR Phase 4 / T12c).
 *
 * Strategy mirrors dismiss_conflict_action.test.js: inject a stub controlFetch so
 * the tests never touch a network or spawn the stdio server. The stub records
 * (path, init) tuples so the workspace-pinning invariant is asserted on the WIRE,
 * not on an internal variable.
 *
 * The behaviors that matter here are honesty behaviors, not plumbing:
 *   - workspace comes from deps, never from args (§12.6), so a model cannot
 *     redirect a read at another tenant;
 *   - the raw DTO is passed through UNTOUCHED, because the native-nullable
 *     contract is the whole point of handing an agent the DTO instead of prose;
 *   - a 422 (exists, not projectable) never degrades into a 404 (does not exist).
 *
 * Run: `node --test decision_record_action.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runDecisionRecord } from "./decision_record_action.js";
import {
  TOOLS,
  ADVERTISED_EVIDENCE_TOOLS,
  MUTATING_TOOL_NAMES,
} from "./tool_manifest.js";

const WS = "ws_test";
const DECISION = "cmt_abc123";

const DTO = {
  id: DECISION,
  status: "ACCEPTED",
  title: "Ship SSO in Q2 as the primary login",
  scope: "WORKSPACE",
  supersedes: [],
  supersededBy: [],
  acceptance: { by: "an@meetless.ai", at: "2026-07-22T10:00:00.000Z" },
  evidence: [{ kind: "ASK_TURN", withheld: true, citation: "ask turn", url: null }],
  linkedCase: null,
  reconciliation: null,
};

function stubFetch(reply = DTO) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    return typeof reply === "function" ? reply(pathAndQuery, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

function throwingFetch(status) {
  const e = new Error(`control GET failed: ${status}`);
  if (status !== undefined) e.status = status;
  e.body = "";
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    throw e;
  };
  fn.calls = calls;
  return fn;
}

test("reads the decision by id from the agent plane and returns the DTO verbatim", async () => {
  const controlFetch = stubFetch();
  const result = await runDecisionRecord(
    { decision_id: DECISION },
    { controlFetch, defaultWorkspaceId: WS },
  );

  assert.equal(controlFetch.calls.length, 1);
  assert.equal(
    controlFetch.calls[0].path,
    `/internal/v1/decisions/${DECISION}?workspaceId=${WS}`,
  );

  // Verbatim, not reshaped. An agent tests `acceptance === null`; any massaging
  // here (dropping nulls, stringifying a placeholder) would break that contract
  // and force exactly the string-matching the DTO exists to prevent.
  assert.deepEqual(result, DTO);
  assert.equal(result.linkedCase, null);
  assert.equal(result.evidence[0].withheld, true);
});

test("§12.6: workspace comes from deps and a model-supplied one is ignored", async () => {
  const controlFetch = stubFetch();
  await runDecisionRecord(
    { decision_id: DECISION, workspace_id: "ws_someone_else" },
    { controlFetch, defaultWorkspaceId: WS },
  );
  const path = controlFetch.calls[0].path;
  assert.ok(path.includes(`workspaceId=${WS}`));
  assert.ok(
    !path.includes("ws_someone_else"),
    "a model-supplied workspace must never reach the wire",
  );
});

test("ids are url-encoded so a crafted id cannot forge a query string", async () => {
  const controlFetch = stubFetch();
  await runDecisionRecord(
    { decision_id: "cmt_x?workspaceId=ws_evil" },
    { controlFetch, defaultWorkspaceId: WS },
  );
  const path = controlFetch.calls[0].path;
  assert.ok(path.startsWith("/internal/v1/decisions/cmt_x%3FworkspaceId%3Dws_evil?"));
  assert.ok(path.endsWith(`?workspaceId=${WS}`));
});

test("a missing decision_id or workspace fails before any request", async () => {
  const noId = stubFetch();
  await assert.rejects(
    () => runDecisionRecord({}, { controlFetch: noId, defaultWorkspaceId: WS }),
    /decision_id is required/,
  );
  assert.equal(noId.calls.length, 0);

  const noWs = stubFetch();
  await assert.rejects(
    () => runDecisionRecord({ decision_id: DECISION }, { controlFetch: noWs, defaultWorkspaceId: null }),
    /workspace is not configured/,
  );
  assert.equal(noWs.calls.length, 0);
});

test("a 422 (exists, not projectable) never degrades into a 404 (does not exist)", async () => {
  await assert.rejects(
    () =>
      runDecisionRecord(
        { decision_id: DECISION },
        { controlFetch: throwingFetch(404), defaultWorkspaceId: WS },
      ),
    (e) => {
      assert.match(e.message, /No decision/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      runDecisionRecord(
        { decision_id: DECISION },
        { controlFetch: throwingFetch(422), defaultWorkspaceId: WS },
      ),
    (e) => {
      assert.match(e.message, /not a projectable decision/);
      // A PENDING or DISMISSED commitment EXISTS. Telling the agent it does not
      // would misstate the governed graph, which is the failure this whole
      // surface is built to prevent.
      assert.doesNotMatch(e.message, /No decision/);
      return true;
    },
  );
});

test("an unresolvable viewer (400) says what would fix it, and 5xx passes through", async () => {
  await assert.rejects(
    () =>
      runDecisionRecord(
        { decision_id: DECISION },
        { controlFetch: throwingFetch(400), defaultWorkspaceId: WS },
      ),
    /mla login/,
  );

  // Untyped failures are re-thrown, NOT mapped to a friendly sentence: an agent
  // that read a transient 500 as "no such decision" would draw the wrong
  // conclusion about the graph.
  await assert.rejects(
    () =>
      runDecisionRecord(
        { decision_id: DECISION },
        { controlFetch: throwingFetch(500), defaultWorkspaceId: WS },
      ),
    (e) => {
      assert.equal(e.status, 500);
      assert.doesNotMatch(e.message, /No decision|not a projectable/);
      return true;
    },
  );
});

test("manifest placement: registered, read-only, not evidence, not mutating", () => {
  const tool = TOOLS.find((t) => t.name === "meetless__decision_record");
  assert.ok(tool, "meetless__decision_record must be registered in TOOLS");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);

  // Not mutating: it is a GET.
  assert.ok(!MUTATING_TOOL_NAMES.includes("meetless__decision_record"));
  // Not advertised as evidence either: ADVERTISED_EVIDENCE_TOOLS is the Layer 1
  // RETRIEVAL surface (ask a question, get candidates). This is a by-id lookup
  // of an already-known decision, the same class as meetless__query.
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__decision_record"));

  // §12.6: no workspace_id input from the model.
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["decision_id"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
});
