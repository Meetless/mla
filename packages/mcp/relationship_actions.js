/**
 * Phase F §F7.1: MCP relationship review actions (list + verdict).
 *
 * Extracted from server.js so the handlers are unit-testable without
 * spawning a stdio MCP server. server.js wires these to MCP tool dispatch;
 * tests import them directly with an injected fetch.
 *
 * Design notes:
 *   - The CALLER is responsible for picking workspace_id defaults (server.js
 *     reads MEETLESS_WORKSPACE_ID env; tests pass it explicitly). This module
 *     does NOT read env, which keeps it deterministic and portable.
 *   - The fetch closure is injected (runRelationships + runVerdict both take an
 *     intelFetch; makeControlFetch survives only for the legacy env bin) so
 *     tests can stub the API surface with no live server required.
 *   - Field validation is strict: an out-of-band enum value throws with the
 *     allowed set in the message; the MCP error envelope surfaces this back
 *     to the caller as-is so the LLM can self-correct.
 */

// §10.2 hard swap: the MCP verdict now records onto intel's canonical
// RelationAssertion trust model, whose outcome enum is exactly ACCEPTED |
// REJECTED. The candidate-era verbs (defer / promote-posture /
// propose-correction) have NO counterpart in the assertion model -- they were
// statusId/postureId concepts on the legacy control candidate -- and so were
// dropped with the single-authority cutover.
export const VERDICT_ACTIONS = new Set(["accept", "reject"]);

const ACTION_TO_OUTCOME = Object.freeze({
  accept: "ACCEPTED",
  reject: "REJECTED",
});

// The trust the reviewer believed they saw at read time. Intel uses it for
// optimistic concurrency (a concurrent move yields 409). PENDING is the default
// because the review queue only ever surfaces born-PENDING assertions.
export const ALLOWED_PRIOR_OUTCOMES = new Set([
  "PENDING",
  "ACCEPTED",
  "REJECTED",
]);

export function ensureAllowed(value, allowed, fieldName) {
  if (value === undefined || value === null) return null;
  if (!allowed.has(value)) {
    throw new Error(
      `unsupported ${fieldName}: "${value}" (allowed: ${[...allowed].join(", ")})`,
    );
  }
  return value;
}

/**
 * Build a controlFetch helper bound to a base URL + control-token bearer.
 * Returns an async (pathAndQuery, init) closure that throws on non-2xx with
 * the body snippet attached. Used by the legacy env bin (server.js
 * buildDepsFromEnv) and tests (stubbed via `fetchImpl`).
 *
 * On a non-2xx the thrown Error additionally carries `.status` (the HTTP
 * status) and, when the body parses as control's ApiErrorResponse envelope,
 * `.code` (the top-level error code) and `.reason` (the `details.reason`
 * sub-code). This lets a dispatch handler map a typed control 409 to
 * operator-facing text instead of leaking a raw status line. The attachment is
 * additive: the message is unchanged, and a non-JSON body leaves status only.
 */
export function makeControlFetch({ baseUrl, apiKey, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("makeControlFetch: baseUrl required");
  if (!apiKey) throw new Error("makeControlFetch: apiKey required");
  return async function controlFetch(pathAndQuery, init = {}) {
    const url = `${baseUrl}${pathAndQuery}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    };
    const res = await fetchImpl(url, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(
        `control ${init.method || "GET"} ${pathAndQuery} ${res.status}: ${text.slice(0, 600)}`,
      );
      err.status = res.status;
      err.body = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.details && typeof parsed.details.reason === "string") {
          err.reason = parsed.details.reason;
        }
        if (parsed && typeof parsed.code === "string") err.code = parsed.code;
      } catch (_e) {
        /* non-JSON body: leave status + body only */
      }
      throw err;
    }
    return text ? JSON.parse(text) : {};
  };
}

/**
 * mode='relationships' handler: lists the workspace's born-PENDING
 * RelationAssertion review backlog and projects each row to the reviewer shape.
 *
 * This is the CLAIM-GRAIN relation-trust queue that Ask serves and that
 * meetless__relationship_verdict acts on: intel's
 * GET /internal/v1/relation-assertions/pending (reviewOutcome=PENDING AND
 * lifecycleStatus=ACTIVE, oldest first). Each row leads with the `assertionId`
 * you pass straight back to the verdict tool, plus the human-readable
 * proposition (subjectLabel -> relationType -> objectLabel).
 *
 * §10.x single-authority cutover: this used to enumerate control's
 * relationship_candidate rows -- the legacy whole-doc / artifact-grain graph
 * that no product surface serves (Ask grounds on claim-grain only). That made
 * list -> verdict a BROKEN pair pointed at two different graphs: the list
 * returned candidate ids, the verdict wants assertion ids. The candidate-era
 * filters (posture / status / review_mode / promotion_status / relation_type /
 * artifact_id / note_path / direction) have no counterpart on an assertion --
 * the pending queue is outcome=PENDING + lifecycle=ACTIVE by definition -- so
 * they are gone. Only `limit` survives.
 */
export async function runRelationships(args, deps) {
  const { intelFetch, defaultWorkspaceId } = deps;
  // §12.6 / SEC-2.2: workspace is env-pinned, never a model parameter. A
  // smuggled args.workspace_id is ignored (it was a cross-tenant foot-gun under
  // a shared key).
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  // intel clamps server-side to [1, 500] (default 100); mirror the bound here so
  // a stray value never round-trips a 422.
  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));

  const params = new URLSearchParams();
  params.set("workspaceId", workspaceId);
  params.set("limit", String(limit));

  const raw = await intelFetch(
    `/internal/v1/relation-assertions/pending?${params.toString()}`,
    { method: "GET" },
  );

  const items = Array.isArray(raw.items) ? raw.items : [];

  // Project to the reviewer shape. Lead with assertionId (the verdict tool's
  // input) and the readable proposition; keep the stable identities + qualifiers
  // a reviewer needs to judge the edge. The route already withholds anything
  // ACL-unsafe, so there is no client-side plumbing to strip.
  const projected = items.map((it) => ({
    assertionId: it.assertionId,
    relationType: it.relationType,
    subject: {
      stableIdentity: it.subjectStableIdentity,
      label: it.subjectLabel ?? null,
    },
    object: {
      stableIdentity: it.objectStableIdentity,
      label: it.objectLabel ?? null,
    },
    qualifiers: it.normalizedQualifiers ?? {},
    reviewOutcome: it.reviewOutcome,
    lifecycleStatus: it.lifecycleStatus,
    reviewedBy: it.reviewedBy ?? null,
    createdAt: it.createdAt,
    fingerprint: it.assertionFingerprint,
    schemaVersion: it.assertionSchemaVersion,
  }));

  return {
    mode: "relationships",
    items: projected,
    // The route returns the FULL pending backlog count (independent of `limit`)
    // for a badge; surface it so a reviewer sees how much remains past the page.
    count: typeof raw.count === "number" ? raw.count : projected.length,
    appliedFilters: { workspaceId, limit },
  };
}

/**
 * meetless__relationship_verdict handler. §10.2 hard swap: records an accept /
 * reject verdict onto intel's canonical RelationAssertion trust model
 * (POST /internal/v1/relation-assertions/{id}/verdict), the single trust
 * authority. The legacy control candidate verdict endpoints
 * (accept/reject/defer/promote-posture/propose-correction) are no longer the
 * authority and are not called here.
 *
 * Contract (mirrors apps/console/lib/server/relation-assertions-api.ts):
 *   - body: { outcome, expectedPriorOutcome, actorUserId, idempotencyKey? }
 *   - workspaceId is a query param, env-pinned (SEC-2.2): a verdict is a
 *     mutation, so a model-supplied workspace_id is ignored to foreclose a
 *     cross-tenant write under the shared key.
 *   - actorUserId must be a real workspace user; defaultUserId lets a
 *     single-operator dogfood setup avoid passing it on every call. Intel
 *     stamps the session human under a cli-session and uses actorUserId on the
 *     shared-key plane.
 *   - expectedPriorOutcome (default PENDING) drives intel's optimistic
 *     concurrency: a concurrent move surfaces back as a 409 through intelFetch.
 *
 * NOTE: intel's verdict endpoint does not accept the candidate-era audit
 * provenance fields (submittedVia / toolName / runtime / session / trace);
 * intel derives the review method from the authenticated caller, so they are
 * no longer sent.
 */
export async function runVerdict(args, deps) {
  const { intelFetch, defaultWorkspaceId, defaultUserId } = deps;
  const action = args.action;
  if (!VERDICT_ACTIONS.has(action)) {
    throw new Error(
      `unsupported action: "${action}" (allowed: ${[...VERDICT_ACTIONS].join(", ")})`,
    );
  }
  const assertionId = args.assertion_id;
  if (!assertionId) throw new Error("assertion_id is required");
  // SEC-2.2 (mirrors runRelationships): workspace is env-pinned, never a model
  // parameter. A verdict is a MUTATION, so honoring a smuggled workspace_id
  // would be a cross-tenant write foot-gun under a shared key; it is ignored.
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  const actorUserId = args.user_id || defaultUserId;
  if (!actorUserId) {
    throw new Error(
      "user_id is required (or set MEETLESS_OPERATOR_USER_ID for a default operator)",
    );
  }
  const expectedPriorOutcome =
    ensureAllowed(
      args.expected_prior_outcome,
      ALLOWED_PRIOR_OUTCOMES,
      "expected_prior_outcome",
    ) || "PENDING";

  const body = {
    outcome: ACTION_TO_OUTCOME[action],
    expectedPriorOutcome,
    actorUserId,
  };
  // Optional idempotency: a retry of the same key is a no-op replay server-side.
  if (typeof args.idempotency_key === "string" && args.idempotency_key !== "") {
    body.idempotencyKey = args.idempotency_key;
  }

  const params = new URLSearchParams({ workspaceId });
  const result = await intelFetch(
    `/internal/v1/relation-assertions/${encodeURIComponent(assertionId)}/verdict?${params.toString()}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  return {
    action,
    assertionId,
    workspaceId,
    actorUserId,
    outcome: body.outcome,
    result,
  };
}
