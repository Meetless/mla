/**
 * Unit tests for the meetless__coordination_* driver tools.
 *
 * Strategy mirrors decision_record_action.test.js: inject a stub controlFetch so
 * the tests never touch a network or the stdio server. Calls are recorded as
 * (path, init) tuples so wire-level invariants are asserted on the WIRE.
 *
 * The behaviors that matter are contract + boundary behaviors:
 *   - workspace is env-pinned from deps, never from args;
 *   - decision_owners become DECISION_OWNER stakeholders (authority seats);
 *   - propose_close passes a `not_ready` refusal through as DATA, not an error
 *     (the can't-lie governance guardrail must be observable to the agent);
 *   - list_proposals aggregates across the goal + every nested condition case;
 *   - the DRIVER-NOT-PLANNER boundary: the manifest must NOT expose the kernel's
 *     in-case planner verbs (require_condition / capture_decision /
 *     verify_condition / transition). Exposing them would let an external caller
 *     become a competing second brain.
 *
 * Run: `node --test coordination_actions.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runCoordinationSubmitGoal,
  runCoordinationGetState,
  runCoordinationListProposals,
  runCoordinationReviewProposal,
  runCoordinationProposeClose,
  collectCaseIds,
} from "./coordination_actions.js";
import { TOOLS, ADVERTISED_EVIDENCE_TOOLS, MUTATING_TOOL_NAMES } from "./tool_manifest.js";

const WS = "ws_test";
const OPERATOR = "wu_owner";
const GOAL = "case_goal_1";

// A router stub: map exact (or prefix) paths to replies. Records calls.
function routerFetch(routes) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    for (const [prefix, reply] of routes) {
      if (pathAndQuery.startsWith(prefix)) {
        if (typeof reply === "function") return reply(pathAndQuery, init);
        return reply;
      }
    }
    const e = new Error(`no route for ${pathAndQuery}`);
    e.status = 404;
    throw e;
  };
  fn.calls = calls;
  return fn;
}

function throwing(status, message = "boom") {
  const e = new Error(message);
  if (status !== undefined) e.status = status;
  const fn = async () => {
    throw e;
  };
  return fn;
}

// ---------------------------------------------------------------- submit_goal

test("submit_goal posts start-goal with env-pinned workspace and a default fingerprint", async () => {
  const controlFetch = routerFetch([["/internal/v1/cases/start-goal", { goalCaseId: GOAL, evaluation: {} }]]);
  const res = await runCoordinationSubmitGoal(
    { objective: "Get Checkout pilot ready for Monday" },
    { controlFetch, defaultWorkspaceId: WS },
  );
  assert.equal(res.goalCaseId, GOAL);
  const call = controlFetch.calls[0];
  assert.equal(call.path, "/internal/v1/cases/start-goal");
  assert.equal(call.init.method, "POST");
  const body = JSON.parse(call.init.body);
  assert.equal(body.workspaceId, WS, "workspace must come from deps, not args");
  assert.equal(body.objective, "Get Checkout pilot ready for Monday");
  assert.match(body.canonicalFingerprint, /^emily-agent:[0-9a-f]{32}$/);
  // Control requires >=1 evidence ref; when none given, an honest operator ref is attached.
  assert.equal(body.evidenceRefs.length, 1);
  assert.equal(body.evidenceRefs[0].kind, "slack_thread");
  assert.deepEqual(body.stakeholders, []);
});

test("submit_goal maps decision_owners to DECISION_OWNER stakeholder seats (authority)", async () => {
  const controlFetch = routerFetch([["/internal/v1/cases/start-goal", { goalCaseId: GOAL, evaluation: {} }]]);
  await runCoordinationSubmitGoal(
    {
      objective: "Ship it",
      decision_owners: ["wu_pm", { workspaceUserId: "wu_qa" }],
      evidence_refs: [{ kind: "slack_message", ref: { channel: "C1", ts: "1.2" }, label: "thread" }],
      canonical_fingerprint: "fixed-fp",
    },
    { controlFetch, defaultWorkspaceId: WS },
  );
  const body = JSON.parse(controlFetch.calls[0].init.body);
  assert.equal(body.canonicalFingerprint, "fixed-fp");
  assert.deepEqual(body.stakeholders, [
    { workspaceUserId: "wu_pm", role: "DECISION_OWNER" },
    { workspaceUserId: "wu_qa", role: "DECISION_OWNER" },
  ]);
  assert.equal(body.evidenceRefs[0].kind, "slack_message");
  assert.equal(body.evidenceRefs[0].label, "thread");
});

test("submit_goal REJECTS an unknown evidence kind (no silent relabel / provenance corruption)", async () => {
  const controlFetch = routerFetch([["/internal/v1/cases/start-goal", { goalCaseId: GOAL, evaluation: {} }]]);
  await assert.rejects(
    runCoordinationSubmitGoal(
      { objective: "x", evidence_refs: [{ kind: "email", ref: {}, label: "t" }] },
      { controlFetch, defaultWorkspaceId: WS },
    ),
    /unknown evidence kind 'email'/,
  );
  assert.equal(controlFetch.calls.length, 0, "must not post to control with a bad kind");
});

test("submit_goal requires an objective and a workspace", async () => {
  await assert.rejects(
    runCoordinationSubmitGoal({ objective: "  " }, { controlFetch: routerFetch([]), defaultWorkspaceId: WS }),
    /objective is required/,
  );
  await assert.rejects(
    runCoordinationSubmitGoal({ objective: "x" }, { controlFetch: routerFetch([]), defaultWorkspaceId: null }),
    /workspace is not configured/,
  );
});

// ---------------------------------------------------------------- get_state

test("get_state reads the goal with the workspace as a query param and maps 404", async () => {
  // Real wire shape is wrapped under `goal`.
  const dto = { goal: { goalId: GOAL, objective: "o", status: "OPEN", conditions: [] } };
  const controlFetch = routerFetch([["/internal/v1/coordination/goals/", dto]]);
  const res = await runCoordinationGetState({ goal_id: GOAL }, { controlFetch, defaultWorkspaceId: WS });
  assert.deepEqual(res, dto);
  assert.match(controlFetch.calls[0].path, /\/internal\/v1\/coordination\/goals\/case_goal_1\?workspaceId=ws_test$/);

  await assert.rejects(
    runCoordinationGetState({ goal_id: GOAL }, { controlFetch: throwing(404), defaultWorkspaceId: WS }),
    /No coordination goal/,
  );
});

// ---------------------------------------------------------------- collectCaseIds

test("collectCaseIds returns the goal plus every nested condition case id, de-duped", () => {
  // Real wire shape: wrapped under `goal`.
  const dto = {
    goal: {
      goalId: GOAL,
      conditions: [
        { conditionId: "c1", conditions: [{ conditionId: "c1a", conditions: [] }] },
        { conditionId: "c2" },
        { conditionId: "c1" }, // duplicate
      ],
    },
  };
  assert.deepEqual(collectCaseIds(dto), [GOAL, "c1", "c1a", "c2"]);
  assert.deepEqual(collectCaseIds(null), []);
  // Defensive: a flat shape (no `goal` wrapper) still works.
  assert.deepEqual(collectCaseIds({ goalId: GOAL, conditions: [{ conditionId: "c1" }] }), [GOAL, "c1"]);
});

// ---------------------------------------------------------------- list_proposals

test("list_proposals aggregates pending proposals across the goal tree and tags caseId", async () => {
  const dto = {
    goal: {
      goalId: GOAL,
      conditions: [{ conditionId: "c1", conditions: [] }, { conditionId: "c2", conditions: [] }],
    },
  };
  const controlFetch = routerFetch([
    ["/internal/v1/coordination/goals/", dto],
    // Driver plane: per-case pending lists hit the allowlistable coordination alias
    // with caseId in the query (the mid-path :id internal route is not edge-forwardable).
    ["/internal/v1/coordination/proposals/pending?caseId=case_goal_1", []],
    ["/internal/v1/coordination/proposals/pending?caseId=c1", [{ id: "p1", tool: "AskStakeholder" }]],
    // c2 has no agent run yet -> 404, must be skipped, not fatal
    ["/internal/v1/coordination/proposals/pending?caseId=c2", throwing(404)],
  ]);
  const res = await runCoordinationListProposals({ goal_id: GOAL }, { controlFetch, defaultWorkspaceId: WS });
  assert.equal(res.goalId, GOAL);
  assert.equal(res.proposals.length, 1);
  // Exposes case_id + proposal_id under the review tool's exact param names.
  assert.equal(res.proposals[0].case_id, "c1");
  assert.equal(res.proposals[0].proposal_id, "p1");
  assert.equal(res.proposals[0].tool, "AskStakeholder");
});

// ---------------------------------------------------------------- review_proposal

test("review_proposal defaults to approved and uses the operator identity as reviewer", async () => {
  const controlFetch = routerFetch([["/internal/v1/coordination/proposals/review", { status: "reviewed" }]]);
  await runCoordinationReviewProposal(
    { case_id: "c1", proposal_id: "p1" },
    { controlFetch, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  const call = controlFetch.calls[0];
  // Driver plane: caseId + proposalId travel in the BODY (the review alias is a
  // static allowlistable path, unlike the mid-path-:id internal route).
  assert.equal(call.path, "/internal/v1/coordination/proposals/review");
  assert.equal(call.init.method, "POST");
  const body = JSON.parse(call.init.body);
  assert.equal(body.caseId, "c1");
  assert.equal(body.proposalId, "p1");
  assert.equal(body.action, "approved");
  assert.equal(body.reviewerId, OPERATOR);
});

test("review_proposal rejects an unknown decision and a missing reviewer", async () => {
  await assert.rejects(
    runCoordinationReviewProposal(
      { case_id: "c1", proposal_id: "p1", decision: "yolo" },
      { controlFetch: routerFetch([]), defaultWorkspaceId: WS, operatorUserId: OPERATOR },
    ),
    /decision must be one of/,
  );
  await assert.rejects(
    runCoordinationReviewProposal(
      { case_id: "c1", proposal_id: "p1" },
      { controlFetch: routerFetch([]), defaultWorkspaceId: WS, operatorUserId: null },
    ),
    /reviewer_id is required/,
  );
});

// ---------------------------------------------------------------- propose_close

test("propose_close posts resolve-goal and passes a not_ready refusal through as DATA", async () => {
  // The can't-lie guardrail: a Goal with open Conditions returns 200 not_ready.
  const controlFetch = routerFetch([
    ["/internal/v1/cases/resolve-goal", { status: "not_ready", blockedBy: ["c2"] }],
  ]);
  const res = await runCoordinationProposeClose({ goal_id: GOAL }, { controlFetch, defaultWorkspaceId: WS });
  assert.equal(res.status, "not_ready", "refusal must be observable data, not an error");
  assert.deepEqual(res.blockedBy, ["c2"]);
  const body = JSON.parse(controlFetch.calls[0].init.body);
  assert.equal(body.workspaceId, WS);
  assert.equal(body.goalCaseId, GOAL);
});

test("propose_close surfaces a closed result", async () => {
  const controlFetch = routerFetch([["/internal/v1/cases/resolve-goal", { status: "closed" }]]);
  const res = await runCoordinationProposeClose({ goal_id: GOAL }, { controlFetch, defaultWorkspaceId: WS });
  assert.equal(res.status, "closed");
});

// ---------------------------------------------------- manifest + boundary

test("the five coordination tools are registered", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const n of [
    "meetless__coordination_submit_goal",
    "meetless__coordination_get_state",
    "meetless__coordination_list_proposals",
    "meetless__coordination_review_proposal",
    "meetless__coordination_propose_close",
  ]) {
    assert.ok(names.has(n), `missing tool ${n}`);
  }
});

test("the three state-changing coordination tools are declared MUTATING and not evidence tools", () => {
  const mutating = new Set(MUTATING_TOOL_NAMES);
  const evidence = new Set(ADVERTISED_EVIDENCE_TOOLS);
  for (const n of [
    "meetless__coordination_submit_goal",
    "meetless__coordination_review_proposal",
    "meetless__coordination_propose_close",
  ]) {
    assert.ok(mutating.has(n), `${n} must be in MUTATING_TOOL_NAMES`);
    assert.ok(!evidence.has(n), `${n} must not be an advertised evidence tool`);
  }
});

test("DRIVER-NOT-PLANNER boundary: the kernel's in-case planner verbs are NOT exposed as tools", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const forbidden of [
    "meetless__coordination_require_condition",
    "meetless__coordination_capture_decision",
    "meetless__coordination_verify_condition",
    "meetless__coordination_transition",
  ]) {
    assert.ok(
      !names.has(forbidden),
      `${forbidden} must NOT exist: exposing it would let an external caller become a competing second planner`,
    );
  }
});
