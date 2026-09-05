/**
 * meetless__forget: withdraw a prior conversational capture (the "undo" for
 * meetless__remember).
 *
 * Thin wrapper over the governed withdraw primitive
 * (POST /internal/v1/kb/withdraw), which tombstones the document
 * (tombstoneState ACTIVE -> TOMBSTONED): it drops the capture from current
 * retrieval at read time while keeping the immutable revisions + audit + any
 * verdicts. It does NOT delete bytes and it is idempotent.
 *
 * withdraw keys on the SOURCE-TUPLE handle {sourceSystem, sourceTenantId,
 * externalObjectId}, NOT the documentId, and refuses sourceSystem=notes (that is
 * kb/forget's keyspace). A remember uses sourceSystem=agent, so it is withdrawable
 * here. Pass the exact `withdraw` handle meetless__remember returned.
 *
 * Undo is only offered because this withdraw path is wired + tested (An
 * correction #9, 2026-09-02): a promise of reversal with no reversal behind it is
 * worse than none.
 */

function requireWorkspace(deps) {
  const workspaceId = deps && deps.defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  return workspaceId;
}

/**
 * runForget: withdraw one capture. Input: { handle: {sourceSystem,
 * sourceTenantId, externalObjectId} } (the `withdraw` object a prior remember
 * returned). A not_found / already-withdrawn / purged outcome comes back as DATA
 * (forgotten:false + outcome), never thrown, because it is a benign no-op.
 */
export async function runForget(args, deps) {
  const { intelFetch, operatorUserId = null } = deps || {};
  const workspaceId = requireWorkspace(deps);

  const handle = (args && args.handle) || {};
  const sourceSystem = String(handle.sourceSystem || "").trim();
  const sourceTenantId = String(handle.sourceTenantId || "").trim();
  const externalObjectId = String(handle.externalObjectId || "").trim();
  if (!sourceSystem || !sourceTenantId || !externalObjectId) {
    throw new Error(
      "forget requires the withdraw handle {sourceSystem, sourceTenantId, externalObjectId} " +
        "returned by meetless__remember",
    );
  }

  const body = {
    workspaceId,
    sourceSystem,
    sourceTenantId,
    externalObjectId,
    reason: "deleted",
  };
  // withdraw requires an actor (like kb add / forget). Same rule as remember: the
  // trusted config actor from deps, NEVER from the model's args; the cli-session
  // plane ignores it and uses the token holder. Without it the shared-key plane
  // 422s on a missing actor.
  if (operatorUserId) body.actor = operatorUserId;

  const res = await intelFetch("/internal/v1/kb/withdraw", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    forgotten: Boolean(res && res.withdrawn === true),
    outcome: res && res.outcome,
    documentId: res && res.documentId,
    reason: res && res.reason,
  };
}
