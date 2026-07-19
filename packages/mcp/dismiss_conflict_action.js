/**
 * Task 7 (notes/20260717-agent-verified-conflict-fp-dismiss-plan-v4.md):
 * meetless__dismiss_conflict handler.
 *
 * The coding agent asserts that a flagged draft-vs-draft (SESSION_CONTRADICTION)
 * conflict is a false positive and closes it via control's per-user
 * agent-dismiss endpoint:
 *
 *   POST /internal/v1/session-conflicts/:caseId/agent-dismiss?workspaceId=<ws>
 *
 * Contract (mirrors runVerdict, relationship_actions.js):
 *   - workspace comes from deps.defaultWorkspaceId (env-pinned / marker-resolved),
 *     NEVER from args. A smuggled args.workspace_id is ignored (SEC-2.2).
 *   - the body carries ONLY { rationale, runtimeHint }; the actor is derived
 *     server-side under INV-AUTH-1 (the verified cli-session human, or the
 *     Console BFF asserted actor). The agent cannot name a different actor.
 *   - the outcome is FORCED to DISMISS in the service (an agent can only claim
 *     "false positive", never adjudicate a winner). Eligibility is re-derived
 *     inside control's tx; anything an agent must not touch comes back as a
 *     typed 409 which we map to operator-facing text rather than re-throwing.
 */

// Control's ApiErrorResponse rides its machine-readable sub-code on
// `details.reason` (top-level `code` is always "CONFLICT" for a 409). The two
// front doors surface that differently, so read it from whichever is present:
//
//   - the mcp-package makeControlFetch (legacy env bin) attaches `err.reason`
//     directly (relationship_actions.js).
//   - the `mla mcp` path throws http.ts's HttpError, which carries only
//     `err.status` + `err.body` (the raw response text), so the reason must be
//     parsed out of the body here.
//
// Fail-safe: a missing / non-JSON / reason-less body yields null, and the caller
// then re-throws the raw error rather than swallowing an unmapped failure.
function readControlErrorReason(err) {
  if (!err || typeof err !== "object") return null;
  if (typeof err.reason === "string" && err.reason !== "") return err.reason;
  if (typeof err.body === "string" && err.body !== "") {
    try {
      const parsed = JSON.parse(err.body);
      if (
        parsed &&
        parsed.details &&
        typeof parsed.details.reason === "string"
      ) {
        return parsed.details.reason;
      }
    } catch (_e) {
      /* non-JSON body: no typed reason to read */
    }
  }
  return null;
}

// Typed 409 reason -> operator-facing text. Every mapped reason means "this is
// not a clean agent dismiss": the conflict is left OPEN for a human in /now.
const DISMISS_REASON_MESSAGES = Object.freeze({
  ALREADY_RESOLVED:
    "This conflict was already resolved by another actor. Nothing to do.",
  APPROVED_LANE_HUMAN_ONLY:
    "This conflict is against approved knowledge; a human must resolve it.",
  CONFLICT_INELIGIBLE:
    "This conflict is not agent-dismissible. Leave it for a human in /now.",
  NOT_DURABLY_SUPPRESSIBLE:
    "Dismissing this would not durably stop re-detection. Leave it for a human in /now.",
  NOT_SESSION_CONTRADICTION: "This case is not a session conflict.",
});

export async function runDismissConflict(args, deps) {
  const { controlFetch, defaultWorkspaceId, agentRuntime } = deps;
  const caseId = String((args && args.case_id) || "").trim();
  const rationale = String((args && args.rationale) || "").trim();
  if (!caseId) throw new Error("case_id is required");
  if (!rationale) throw new Error("rationale is required");
  // SEC-2.2 (mirrors runVerdict): workspace is env-pinned, never a model
  // parameter. A dismiss is a MUTATION, so a smuggled workspace_id would be a
  // cross-tenant write foot-gun under a shared key; it is ignored.
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }

  const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  try {
    const result = await controlFetch(
      `/internal/v1/session-conflicts/${encodeURIComponent(caseId)}/agent-dismiss${query}`,
      {
        method: "POST",
        // Do NOT set content-type here. makeControlFetch adds exactly one
        // `Content-Type: application/json` whenever there is a body; passing a
        // second (lowercase) header makes undici merge them into
        // `application/json, application/json`, which Express body-parser's
        // type-is rejects, so control never parses the body and 400s on a
        // "missing" rationale. runVerdict relies on the same auto-header.
        body: JSON.stringify({
          rationale,
          runtimeHint: agentRuntime ?? null,
        }),
      },
    );
    return {
      status: "dismissed",
      caseId,
      resolution: result && result.resolution,
      // An #8: durable-but-async wording, no "suppressed synchronously" claim.
      message:
        "Closed as a false positive. Suppression has been durably queued and becomes effective asynchronously.",
    };
  } catch (err) {
    // A typed control 409 -> operator-facing text, conflict left for a human.
    // Anything unmapped (a 500, a network error, an untyped body) re-throws so
    // the dispatch envelope reports a real error instead of a silent success.
    const reason = readControlErrorReason(err);
    if (reason && DISMISS_REASON_MESSAGES[reason]) {
      return {
        status: "not_dismissed",
        caseId,
        reason,
        message: DISMISS_REASON_MESSAGES[reason],
      };
    }
    throw err;
  }
}

// Exported for unit tests; the handler itself is the only production consumer.
export { readControlErrorReason };
