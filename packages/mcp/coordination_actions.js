/**
 * meetless__coordination_*: the agent-plane DRIVER surface for Emily coordination.
 *
 * These five tools expose the existing Emily coordination lifecycle
 * (control's /internal/v1/cases/* and /internal/v1/coordination/*) as a public
 * MCP interface so an external agent can DRIVE a coordination Goal without
 * touching internal HTTP or the database directly. They are thin wrappers: each
 * one reuses the existing control service, auth (the workspace bearer, Rule 5),
 * and validation, and changes no schema and no coordination semantics.
 *
 * DRIVER, NOT A SECOND PLANNER (the load-bearing design rule). The in-case
 * coordination planner is the worker AgentLoopService + intel reasoner, triggered
 * by CASE_AGENT_WAKE. It owns decompose / ask / verify / resolve on the case. An
 * external caller that ALSO decided those actions would be a competing brain and
 * would race the kernel (double-decompose, double-ask, close race). So these
 * tools deliberately DO NOT expose require-condition / capture-decision /
 * verify-condition / transition. They expose only the OPERATOR-plane verbs a human
 * driver legitimately performs (as tools/scenarios/emily/golden_spine.py does):
 *   - submit a Goal (then let the kernel plan it)
 *   - read its state
 *   - list proposals the kernel has queued for human review
 *   - review (approve/hold) a queued proposal
 *   - propose closure (the server structural gate decides; the model cannot close)
 *
 * Workspace is env-pinned from deps.defaultWorkspaceId and never read from args.
 * The reviewer identity defaults to deps.operatorUserId (MEETLESS_OPERATOR_USER_ID)
 * and can be overridden per call for multi-persona demos.
 */

import { createHash } from "node:crypto";

// The valid evidence kinds (FK to control's case_evidence_kinds reference table).
// A model may improvise a kind ("thread", "note", ...) that is not seeded, which
// would FK-fail with an opaque 500. We REJECT an unknown kind with a clear error
// listing the valid ones, rather than silently relabeling it as some other real
// source (that would corrupt provenance by impersonating, e.g., a Slack thread).
// Kept in sync with the seed; a drift only rejects a genuinely-new valid kind,
// never mislabels one.
const KNOWN_EVIDENCE_KINDS = new Set([
  "agent_review_evidence",
  "approval_record",
  "confluence_page",
  "diff_version",
  "jira_issue",
  "linked_case",
  "relationship_candidate",
  "slack_message",
  "slack_thread",
  "watch_event",
]);

function requireWorkspace(deps) {
  const workspaceId = deps.defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  return workspaceId;
}

/**
 * coordination_submit_goal: POST /internal/v1/cases/start-goal.
 * The Goal is created and its first evaluation is queued; the kernel then
 * decomposes and drives it. Idempotent on canonical_fingerprint (default: a
 * content hash of the objective, so re-submitting the same objective in a
 * workspace returns the same Goal rather than duplicating it).
 * Returns { goalCaseId, evaluation }.
 */
export async function runCoordinationSubmitGoal(args, deps) {
  const { controlFetch, operatorUserId } = deps;
  const workspaceId = requireWorkspace(deps);
  const objective = String((args && args.objective) || "").trim();
  if (!objective) throw new Error("objective is required");

  const canonicalFingerprint =
    (args && typeof args.canonical_fingerprint === "string" && args.canonical_fingerprint.trim()) ||
    `emily-agent:${createHash("sha256").update(objective).digest("hex").slice(0, 32)}`;

  let evidenceRefs = Array.isArray(args && args.evidence_refs)
    ? args.evidence_refs.map((e) => {
        const kind = String((e && e.kind) || "").trim();
        // An explicitly-supplied kind must be a real seeded kind. Reject an
        // unknown one honestly instead of relabeling it as an unrelated source.
        if (kind && !KNOWN_EVIDENCE_KINDS.has(kind)) {
          throw new Error(
            `unknown evidence kind '${kind}'. Valid kinds: ${[...KNOWN_EVIDENCE_KINDS].join(", ")}. ` +
              `Omit evidence_refs to attach the operator instruction automatically.`,
          );
        }
        return {
          kind: kind || "slack_thread",
          ref: (e && typeof e.ref === "object" && e.ref) || {},
          ...(e && e.label ? { label: String(e.label) } : {}),
        };
      })
    : [];
  // Control requires at least one evidence ref (§6 Rule 4): a coordination case
  // must cite the source of the change. When the operator agent supplies none, we
  // attach one honest ref for the demo's delivery medium: the operator's objective
  // arrives as a chat instruction, so it is a slack_thread carrying that
  // instruction. This is the demo's real source, not an impersonation; a
  // production integration should pass the actual originating evidence. The agent
  // should ground with retrieve_knowledge and pass richer evidence when it has it.
  if (evidenceRefs.length === 0) {
    evidenceRefs = [
      { kind: "slack_thread", ref: { source: "emily-agent", objective }, label: "Operator instruction (chat)" },
    ];
  }

  const owners = Array.isArray(args && args.decision_owners) ? args.decision_owners : [];
  const stakeholders = owners
    .map((o) => (typeof o === "string" ? o : o && o.workspaceUserId))
    .filter(Boolean)
    .map((workspaceUserId) => ({ workspaceUserId: String(workspaceUserId), role: "DECISION_OWNER" }));

  const body = { workspaceId, objective, canonicalFingerprint, evidenceRefs, stakeholders };

  // Close the loop back to the human operator who gave Emily this objective.
  // Threading the operator as the CoordinationContext requester makes control
  // seed the accountable OWNER seat and post the verified-completion closure
  // brief to them on goal_resolved (An ruling 2026-08-31). Distinct from the
  // decision_owners authority seats above: this is Goal accountability. Omitted
  // when no operator identity is configured, in which case the goal correctly
  // fails closed for closure notification rather than guessing a recipient.
  if (operatorUserId) {
    body.context = {
      workspaceId,
      initiatorId: operatorUserId,
      requesterId: operatorUserId,
      surface: "system",
      directness: "EXPLICIT_REQUEST",
    };
  }

  try {
    return await controlFetch("/internal/v1/cases/start-goal", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 400 || status === 422) {
      throw new Error(
        `Goal not created (control ${status}): the objective or stakeholders were rejected. ` +
          `Decision owners must be existing workspace user ids. Original: ${String(err.message || err)}`,
      );
    }
    throw err;
  }
}

/**
 * coordination_get_state: GET /internal/v1/coordination/goals/:goalId.
 * Returns the goal + nested condition tree with statuses (the HUD read).
 */
export async function runCoordinationGetState(args, deps) {
  const { controlFetch } = deps;
  const workspaceId = requireWorkspace(deps);
  const goalId = String((args && args.goal_id) || "").trim();
  if (!goalId) throw new Error("goal_id is required");

  try {
    return await controlFetch(
      `/internal/v1/coordination/goals/${encodeURIComponent(goalId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 404) {
      throw new Error(
        `No coordination goal ${goalId} in this workspace. It may belong to another workspace or not be a GOAL.`,
      );
    }
    throw err;
  }
}

/**
 * Collect the goal case id and every (recursively nested) condition case id from
 * a CoordinationReadDto so proposals can be gathered across the whole goal tree.
 */
export function collectCaseIds(dto) {
  const ids = [];
  // The coordination read DTO is wrapped: { goal: { goalId, conditions: [...] } }.
  // Accept the wrapped shape (real wire), and tolerate a flat one defensively.
  const root = dto && dto.goal ? dto.goal : dto;
  if (!root || typeof root !== "object") return ids;
  if (root.goalId) ids.push(String(root.goalId));
  const walk = (conditions) => {
    if (!Array.isArray(conditions)) return;
    for (const c of conditions) {
      if (c && c.conditionId) ids.push(String(c.conditionId));
      if (c && Array.isArray(c.conditions)) walk(c.conditions);
    }
  };
  walk(root.conditions);
  // de-dupe, preserve order
  return [...new Set(ids)];
}

/**
 * coordination_list_proposals: aggregate the kernel's human-gated proposals
 * across the goal and all its condition cases. Asks are proposed on CONDITION
 * cases (a Goal never executes external actions), so this walks the tree and
 * calls GET /internal/v1/cases/:id/agent/proposals/pending per case.
 * Returns { goalId, proposals: [{ caseId, ...proposal }] }.
 */
export async function runCoordinationListProposals(args, deps) {
  const { controlFetch } = deps;
  requireWorkspace(deps);
  const goalId = String((args && args.goal_id) || "").trim();
  if (!goalId) throw new Error("goal_id is required");

  const state = await runCoordinationGetState({ goal_id: goalId }, deps);
  const caseIds = collectCaseIds(state);

  const proposals = [];
  for (const caseId of caseIds) {
    let pending;
    try {
      pending = await controlFetch(
        `/internal/v1/coordination/proposals/pending?caseId=${encodeURIComponent(caseId)}`,
      );
    } catch (err) {
      // A case with no agent run yet returns 404/empty; skip it rather than fail
      // the whole aggregation.
      const status = err && typeof err === "object" ? err.status : undefined;
      if (status === 404) continue;
      throw err;
    }
    const list = Array.isArray(pending) ? pending : pending && pending.proposals;
    if (Array.isArray(list)) {
      // Expose case_id + proposal_id under the exact names coordination_review_proposal
      // takes, so the model maps list -> review without guessing which field is which.
      for (const p of list) {
        proposals.push({ caseId, case_id: caseId, proposal_id: p.id, ...p });
      }
    }
  }
  return { goalId, proposals };
}

/**
 * coordination_review_proposal: POST /internal/v1/cases/:caseId/agent/proposals/:proposalId/review.
 * The operator's supervisory approve/hold on a kernel-proposed action (Gate A).
 * Approving triggers the supervised-execution resume path (the kernel then
 * executes the ask). This is the operator judging the kernel's proposal, NOT the
 * kernel deciding to ask, so it does not compete with the planner.
 * decision defaults to "approved"; reviewer_id defaults to operatorUserId.
 */
export async function runCoordinationReviewProposal(args, deps) {
  const { controlFetch, operatorUserId } = deps;
  requireWorkspace(deps);
  const caseId = String((args && args.case_id) || "").trim();
  const proposalId = String((args && args.proposal_id) || "").trim();
  if (!caseId) throw new Error("case_id is required");
  if (!proposalId) throw new Error("proposal_id is required");

  const decision = String((args && args.decision) || "approved").trim();
  const allowed = new Set([
    "approved",
    "approved_with_edits",
    "rejected",
    "rejected_with_reason",
    "deferred",
  ]);
  if (!allowed.has(decision)) {
    throw new Error(`decision must be one of ${[...allowed].join(", ")}`);
  }

  const reviewerId =
    (args && typeof args.reviewer_id === "string" && args.reviewer_id.trim()) || operatorUserId;
  if (!reviewerId) {
    throw new Error(
      "reviewer_id is required (no operator identity configured; set MEETLESS_OPERATOR_USER_ID or pass reviewer_id)",
    );
  }

  // Driver plane: caseId + proposalId travel in the BODY (the per-user route is
  // /internal/v1/coordination/proposals/review, allowlistable as a static prefix,
  // unlike the mid-path-:id internal route). reviewerId is IGNORED server-side for a
  // cli-session token (the reviewer is the verified token holder); it is honored only
  // for the shared-key demo/CI plane.
  const body = { caseId, proposalId, action: decision, reviewerId };
  if (args && args.rationale) body.rejectionReason = String(args.rationale);

  try {
    return await controlFetch(`/internal/v1/coordination/proposals/review`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 404) {
      throw new Error(
        `No pending proposal ${proposalId} on case ${caseId}. It may have been reviewed already or belong to another case.`,
      );
    }
    throw err;
  }
}

/**
 * coordination_propose_close: POST /internal/v1/cases/resolve-goal.
 * The model PROPOSES closure; the server structural gate decides. Returns
 * { status: closed | already_closed | not_ready, blockedBy? }. A "not_ready"
 * result is NOT an error: it is the governance guardrail refusing to close a Goal
 * whose Conditions are not all satisfied (the model cannot declare done). Surface
 * it as data so the agent can narrate the refusal.
 */
export async function runCoordinationProposeClose(args, deps) {
  const { controlFetch } = deps;
  const workspaceId = requireWorkspace(deps);
  const goalId = String((args && args.goal_id) || "").trim();
  if (!goalId) throw new Error("goal_id is required");

  return await controlFetch("/internal/v1/cases/resolve-goal", {
    method: "POST",
    body: JSON.stringify({ workspaceId, goalCaseId: goalId }),
  });
}
