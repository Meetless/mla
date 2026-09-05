/**
 * Unit tests for meetless__publish (conversational governed PUBLICATION), Slice C6.
 *
 * Written BEFORE the implementation. The verb is the deliberate "widen this to
 * everyone here" act the `remember` doctrine reserves ("Widening to the team is a
 * separate deliberate act, never a side effect of remember"). It is a THIN wrapper
 * over the existing, live-exercised KB scope route
 * (POST /internal/v1/kb/documents/{id}/scope), promoting a captured PERSON KB doc
 * to WORKSPACE. Publish-only (An ruling 2026-09-03: no demote on this surface).
 *
 * Invariants (An amendment, 2026-09-03):
 *   - the model passes only a fact_ref (a documentId) + optional reason /
 *     destination_workspace_id; scope is server-fixed to WORKSPACE (publish-only);
 *   - the contract is the HONEST generic shape {published_artifact_id, audit...},
 *     never a substrate-specific derivativeId (the KB path mutates in place);
 *   - destination_workspace_id targeting ANOTHER workspace is refused until A5
 *     (cross-workspace HQ->External publish) lands (C7);
 *   - it persists BEFORE it confirms: the result is derived from the route
 *     receipt, never fabricated ahead of the write.
 *
 * Strategy mirrors remember_action.test.js: inject a stub intelFetch, record the
 * (path, init) tuples, assert on the WIRE.
 *
 * Run: `node --test publish_action.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runPublish } from "./publish_action.js";
import { TOOLS, ADVERTISED_EVIDENCE_TOOLS, MUTATING_TOOL_NAMES } from "./tool_manifest.js";

const WS = "ws_test";
const OPERATOR = "wu_owner";

function recordingFetch(reply) {
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : undefined });
    return typeof reply === "function" ? reply(path, init) : reply;
  };
  return { fetchImpl, calls };
}

const OK_RECEIPT = { documentId: "doc_123", scope: "WORKSPACE" };

test("publish: promotes the referenced doc to WORKSPACE via the scope route", async () => {
  const { fetchImpl, calls } = recordingFetch(OK_RECEIPT);
  const result = await runPublish(
    { fact_ref: "doc_123" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );

  assert.equal(calls.length, 1, "exactly one route call");
  const call = calls[0];
  assert.match(call.path, /\/internal\/v1\/kb\/documents\/doc_123\/scope/, "hits the KB scope route for the doc");
  assert.match(call.path, /workspaceId=ws_test/, "passes the current workspace as a query param");
  assert.equal(call.init.method, "POST");
  // Publish-only: scope is server-fixed to WORKSPACE, never taken from the model.
  assert.equal(call.body.scope, "WORKSPACE", "scope is fixed to WORKSPACE (publish-only)");
  // Honest generic contract: the published artifact id, never a fake derivativeId.
  assert.equal(result.published, true);
  assert.equal(result.published_artifact_id, "doc_123");
  assert.equal(result.scope, "workspace");
  assert.ok(result.audit && result.audit.recorded === true, "reports an audit event was recorded");
  assert.equal(result.derivativeId, undefined, "must not promise a substrate-specific derivativeId");
});

test("publish: requires a fact_ref", async () => {
  const { fetchImpl, calls } = recordingFetch(OK_RECEIPT);
  await assert.rejects(() => runPublish({}, { intelFetch: fetchImpl, defaultWorkspaceId: WS }), /fact_ref/);
  assert.equal(calls.length, 0, "no route call without a fact_ref");
});

test("publish: destination_workspace_id equal to the current workspace is a within-workspace publish", async () => {
  const intel = recordingFetch(OK_RECEIPT);
  const control = recordingFetch({});
  const result = await runPublish(
    { fact_ref: "doc_123", destination_workspace_id: WS, statement: "ignored here" },
    { intelFetch: intel.fetchImpl, controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  assert.equal(intel.calls.length, 1, "same-workspace destination is just a within-workspace KB widen");
  assert.equal(control.calls.length, 0, "control A5 is NOT called for a same-workspace destination");
  assert.equal(result.mode, "within_workspace");
  assert.equal(result.published, true);
});

// ---------------------------------------------------------------------------
// C7: cross-workspace publication (governed HQ -> External via control A5)
// ---------------------------------------------------------------------------

const A5_RECEIPT = { commitmentId: "cmt_ext_1", workspaceId: "ws_external", scope: "workspace", alreadyPublished: false };

test("C7: cross-workspace publish routes to A5 with the human statement + fact_ref as provenance", async () => {
  const intel = recordingFetch(OK_RECEIPT);
  const control = recordingFetch(A5_RECEIPT);
  const result = await runPublish(
    { fact_ref: "doc_hq_1", destination_workspace_id: "ws_external", statement: "Our standard pilot is two weeks." },
    { intelFetch: intel.fetchImpl, controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );

  assert.equal(intel.calls.length, 0, "cross-workspace must NOT touch the source KB doc (no set_scope)");
  assert.equal(control.calls.length, 1, "cross-workspace routes to control A5");
  const call = control.calls[0];
  assert.match(call.path, /\/internal\/v1\/commitments\/publish-to-workspace/, "hits the A5 route");
  assert.equal(call.body.sourceWorkspaceId, WS);
  assert.equal(call.body.destinationWorkspaceId, "ws_external");
  assert.equal(call.body.sourceActorUserId, OPERATOR);
  assert.equal(call.body.statement, "Our standard pilot is two weeks.", "the human statement is what is published");
  assert.equal(call.body.sourceProvenanceRef, "doc_hq_1", "fact_ref is preserved as provenance, never dropped");
  // Result carries A5's REAL destination ids, not a synthetic within-workspace shape.
  assert.equal(result.mode, "cross_workspace");
  assert.equal(result.published_artifact_id, "cmt_ext_1");
  assert.equal(result.destination_workspace_id, "ws_external");
  assert.equal(result.scope, "workspace");
  assert.equal(result.source_provenance_ref, "doc_hq_1");
});

test("C7: cross-workspace publish REQUIRES a statement (never derives it from the source)", async () => {
  const intel = recordingFetch(OK_RECEIPT);
  const control = recordingFetch(A5_RECEIPT);
  await assert.rejects(
    () =>
      runPublish(
        { fact_ref: "doc_hq_1", destination_workspace_id: "ws_external" },
        { intelFetch: intel.fetchImpl, controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
      ),
    /statement is required/i,
  );
  assert.equal(control.calls.length, 0, "no A5 call without a statement");
  assert.equal(intel.calls.length, 0, "and never a silent fallback that copies the source doc");
});

test("C7: fact_ref is still required for cross-workspace (statement does not substitute)", async () => {
  const control = recordingFetch(A5_RECEIPT);
  await assert.rejects(
    () =>
      runPublish(
        { destination_workspace_id: "ws_external", statement: "some text" },
        { controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
      ),
    /fact_ref/,
  );
  assert.equal(control.calls.length, 0);
});

test("C7: an A5 failure fails closed (no within-workspace fallback, source untouched)", async () => {
  const intel = recordingFetch(OK_RECEIPT);
  const control = recordingFetch(() => {
    const e = new Error("A5 denied: not OWNER/ADMIN of destination");
    e.status = 403;
    throw e;
  });
  await assert.rejects(
    () =>
      runPublish(
        { fact_ref: "doc_hq_1", destination_workspace_id: "ws_external", statement: "Our standard pilot is two weeks." },
        { intelFetch: intel.fetchImpl, controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
      ),
    /A5 denied/,
  );
  assert.equal(intel.calls.length, 0, "MUST NOT fall back to a within-workspace set_scope publish");
});

test("C7: cross-workspace requires an authenticated operator identity", async () => {
  const control = recordingFetch(A5_RECEIPT);
  await assert.rejects(
    () =>
      runPublish(
        { fact_ref: "doc_hq_1", destination_workspace_id: "ws_external", statement: "text" },
        { controlFetch: control.fetchImpl, defaultWorkspaceId: WS, operatorUserId: null },
      ),
    /operator identity/i,
  );
  assert.equal(control.calls.length, 0, "no unattributed cross-workspace publish");
});

test("publish: passes the trusted operator as actorBy for the shared-key plane", async () => {
  const { fetchImpl, calls } = recordingFetch(OK_RECEIPT);
  await runPublish({ fact_ref: "doc_123" }, { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR });
  // On the cli-session plane the route ignores actorBy and uses the token holder;
  // on the shared-key plane it needs the trusted config actor. Passing it is safe
  // on both and required on one.
  assert.equal(calls[0].body.actorBy, OPERATOR);
});

test("publish: manifest registration (mutating, not advertised evidence)", () => {
  const tool = TOOLS.find((t) => t.name === "meetless__publish");
  assert.ok(tool, "meetless__publish is registered in TOOLS");
  assert.equal(tool.inputSchema.additionalProperties, false, "no free-form model input");
  assert.deepEqual(tool.inputSchema.required, ["fact_ref"]);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.ok(MUTATING_TOOL_NAMES.includes("meetless__publish"), "listed as mutating");
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__publish"), "never advertised as read-only evidence");
});
