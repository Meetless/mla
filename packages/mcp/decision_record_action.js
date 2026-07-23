/**
 * meetless__decision_record: the agent-plane read of one governed decision
 * (ADR notes/20260717-adr-decision-record-projection-and-reconciliation.md, Phase 4 / T12).
 *
 *   GET /internal/v1/decisions/:id?workspaceId=<ws>  ->  DecisionRecordDto
 *
 * Read-only, so it is NOT in MUTATING_TOOL_NAMES. It is also NOT in
 * ADVERTISED_EVIDENCE_TOOLS: that set is the Layer 1 RETRIEVAL surface (ask a
 * question, get candidates back). This is a targeted by-id lookup of one already
 * known decision, the same class of tool as meetless__query. Adding it to the
 * evidence manifest would misdescribe what it does and dilute the retrieval
 * contract the coding agent is taught to reach for first.
 *
 * WHY THE RAW DTO AND NOT MARKDOWN. `mla decisions show` renders Markdown because
 * a human reads it. An agent must not. The DTO is NATIVE-NULLABLE by design: a
 * missing acceptance is `null`, not the string "Not recorded", so the agent tests
 * `acceptance === null` instead of string-matching a renderer's label (which is
 * presentation, may be localized, and is the renderer's to change). Handing an
 * agent the Markdown skin would force exactly the string-matching the DTO
 * contract exists to prevent.
 *
 * Workspace is env-pinned from deps.defaultWorkspaceId and never read from args
 * (§12.6). Under `mla mcp` the call rides a cli-session, so control derives the
 * viewer from the verified token (INV-AUTH-1); the agent cannot name a viewer and
 * therefore cannot read past §4.5 evidence withholding. Evidence the caller is not
 * entitled to still appears, marked `withheld: true` with no id and no url, so a
 * governed decision never reads as unsourced.
 */

export async function runDecisionRecord(args, deps) {
  const { controlFetch, defaultWorkspaceId } = deps;
  const decisionId = String((args && args.decision_id) || "").trim();
  if (!decisionId) throw new Error("decision_id is required");

  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }

  const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  try {
    return await controlFetch(
      `/internal/v1/decisions/${encodeURIComponent(decisionId)}${query}`,
    );
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 404) {
      throw new Error(
        `No decision ${decisionId} in this workspace. It may have been purged, or the id may belong to another workspace.`,
      );
    }
    if (status === 422) {
      // The assembler projects ACCEPTED and SUPERSEDED only. A candidate,
      // pending, dismissed or retracted commitment EXISTS but is not a decision,
      // and reporting it as "not found" would misstate the graph.
      throw new Error(
        `${decisionId} is not a projectable decision: only an ACCEPTED or SUPERSEDED commitment has a DecisionRecord.`,
      );
    }
    if (status === 400) {
      // Control fails closed when no viewer resolves (the shared-key plane with
      // no asserted actor). Say what would fix it rather than leaking the raw body.
      throw new Error(
        "Control could not resolve a viewer for this read. Run `mla login` so the MCP server calls as an audited human.",
      );
    }
    throw err;
  }
}
