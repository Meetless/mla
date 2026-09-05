/**
 * meetless__publish: conversational governed PUBLICATION (Slice C6).
 *
 * The deliberate "make this available to everyone here" act. The `remember`
 * doctrine reserves exactly this ("Widening to the team is a separate deliberate
 * act, never a side effect of remember"): `remember` captures a fact PERSON-scoped;
 * `publish` is the separate, explicit widening. Together they are the canonical
 * two-action model (capture privately vs publish to the team).
 *
 * It is a THIN wrapper over the existing, live-exercised KB scope route
 * (POST /internal/v1/kb/documents/{documentId}/scope), promoting a governed KB
 * document PERSON -> WORKSPACE. It adds NO schema and NO new subsystem: the route
 * already appends a PROMOTE lifecycle event (the audit) under the document's row
 * lock, is idempotent (a doc already at WORKSPACE is a no-op), and inherits that
 * route's authority (a cli-session viewer must OWN the PERSON doc; the operator is
 * stamped as the actor). See the authority note below.
 *
 * Publish-only (An ruling 2026-09-03): this surface never demotes. Demotion /
 * retraction is a different lifecycle problem and stays an operator/console
 * action. So `scope` is server-fixed to WORKSPACE and is NOT a model knob.
 *
 * Contract (An amendment 2026-09-03): the return is the HONEST generic shape
 * { published_artifact_id, scope, audit }, never a substrate-specific
 * `derivativeId`. The KB substrate mutates the document in place, so the published
 * artifact IS the same document; that is represented faithfully (published_artifact_id
 * = the documentId) rather than pretending a new derivative was minted. The
 * invariant "publishing produces an auditable published artifact while preserving
 * the original restricted evidence WHENEVER THE SUBSTRATE SUPPORTS THAT DISTINCTION"
 * is honored: a single KB doc's substrate does not support a separate preserved
 * original (it is one row, widened), and the qualifier excuses exactly this case;
 * the audit trail (PROMOTE event) is the durable record.
 *
 * destination_workspace_id drives C7 (governed HQ -> External publish) over control's
 * A5 route. A destination equal to the current workspace (or omitted) is the C6
 * within-workspace KB widen above; a DIFFERENT workspace routes to A5, which mints a
 * new governed Commitment derivative there from a human-supplied `statement`. The two
 * are different substrates on purpose (see runCrossWorkspacePublish).
 *
 * AUTHORITY NOTE (open item for An, surfaced not buried): the governed ruling
 * The governed OWNER/ADMIN publish ruling says "workspace-scope publish is OWNER/ADMIN only".
 * The control Commitment publish path (publishDecision) enforces that in-service.
 * The KB-doc scope route this verb wraps has ALWAYS gated promote on document
 * OWNERSHIP (any member who owns the PERSON doc), identical to `mla kb promote` and
 * the Console promote button. This verb inherits that established authority rather
 * than diverging with a second, inconsistent gate for the same operation. If the
 * OWNER/ADMIN ruling should extend to KB-document publication too, that is a
 * route-level change affecting `mla kb promote` and should be governed as one; it
 * is a pre-existing property of the route, not introduced here. In the dogfood the
 * operator is An (OWNER), so the ruling is satisfied in practice today.
 */

function requireWorkspace(deps) {
  const workspaceId = deps && deps.defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  return workspaceId;
}

/**
 * runPublish: widen one captured fact to the whole workspace.
 * Input: { fact_ref, reason?, destination_workspace_id? }. Returns the
 * receipt-derived result (persist-before-confirm).
 */
export async function runPublish(args, deps) {
  const { intelFetch, controlFetch, operatorUserId = null } = deps || {};
  const workspaceId = requireWorkspace(deps);

  const factRef = String((args && args.fact_ref) || "").trim();
  if (!factRef) {
    throw new Error('fact_ref is required: pass the id of the captured fact to publish (the captureId meetless__remember returned)');
  }

  const destination = args && args.destination_workspace_id ? String(args.destination_workspace_id).trim() : null;

  // C7: cross-workspace publication (e.g. HQ -> Meetless External). A different
  // WORKSPACE means a governed HQ->External publish (Slice A5), a fundamentally
  // different substrate from the within-workspace KB widen below: A5 mints a NEW
  // governed Commitment derivative in the DESTINATION from a sanitized, human-
  // supplied statement, and NEVER reads the source. So the human MUST supply the
  // exact publishable text; fact_ref is carried only as opaque provenance.
  if (destination && destination !== workspaceId) {
    return await runCrossWorkspacePublish({ factRef, destination, args, controlFetch, operatorUserId, sourceWorkspaceId: workspaceId });
  }

  const reason = args && args.reason ? String(args.reason).trim() : undefined;

  // Publish-only: scope is server-fixed to WORKSPACE. On the cli-session plane the
  // route ignores actorBy and stamps the token holder; on the shared-key plane it
  // requires the trusted config actor, so pass it (safe on both).
  const body = { scope: "WORKSPACE" };
  if (reason) body.reason = reason;
  if (operatorUserId) body.actorBy = operatorUserId;

  // Persist FIRST. The scope route flips the doc and appends the PROMOTE audit
  // event in one transaction; we only build the success result from its receipt.
  const receipt = await intelFetch(
    `/internal/v1/kb/documents/${encodeURIComponent(factRef)}/scope?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  const publishedScope = (receipt && receipt.scope) || "WORKSPACE";
  return {
    tool: "meetless__publish",
    published: true,
    mode: "within_workspace",
    // Honest generic contract (An amendment): the id of the artifact that is now
    // workspace-visible, NOT a fabricated derivative id. For the KB substrate this
    // is the same document, widened in place.
    published_artifact_id: (receipt && receipt.documentId) || factRef,
    scope: String(publishedScope).toLowerCase(),
    // The audit is the PROMOTE lifecycle event the route appended under the row
    // lock. Its full record (actor + reason + timestamp) is on the document's
    // lifecycle timeline, readable via meetless__kb_doc_detail on this id.
    audit: { recorded: true, kind: "PROMOTE", timeline: (receipt && receipt.documentId) || factRef },
    note:
      "Published to the whole workspace (WORKSPACE scope). Every member here can now " +
      "receive this as team knowledge. The original capture is unchanged; the widening " +
      "is recorded on the document's audit timeline. This is idempotent: a fact already " +
      "shared with the team is a no-op.",
  };
}

/**
 * C7: governed HQ -> destination-workspace publication over control's A5 route
 * (POST /internal/v1/commitments/publish-to-workspace). It mints a NEW governed
 * Commitment derivative in the destination at WORKSPACE scope from the human's
 * sanitized statement; the source is untouched and cited only as opaque provenance.
 *
 * Boundary rules (An ruling 2026-09-03):
 *  - `statement` is REQUIRED and non-empty: the publishing human supplies the exact
 *    publishable text. We NEVER read the source doc to decide what is safe to expose.
 *  - `statement` never substitutes for `fact_ref`: fact_ref is preserved as the
 *    provenance pointer (sourceProvenanceRef), so the derivative links back to origin.
 *  - Authority is NOT re-checked here: A5 is the sole server-side authority (OWNER/
 *    ADMIN of BOTH source and destination, resolved by the same Account).
 *  - FAIL CLOSED: any A5 error propagates. We NEVER fall back to a within-workspace
 *    publish, and we NEVER touch the source KB document.
 *  - The result carries A5's REAL destination ids (commitmentId + destination
 *    workspace), not a synthetic within-workspace shape.
 */
async function runCrossWorkspacePublish({ factRef, destination, args, controlFetch, operatorUserId, sourceWorkspaceId }) {
  if (typeof controlFetch !== "function") {
    throw new Error("cross-workspace publish is unavailable: control is not wired for this session");
  }
  const statement = String((args && args.statement) || "").trim();
  if (!statement) {
    throw new Error(
      "statement is required to publish to another workspace: supply the exact sanitized text to widen (e.g. \"Our standard pilot is two weeks.\"). " +
        "Cross-workspace publication never derives the text from the source; you say precisely what becomes public.",
    );
  }
  if (!operatorUserId) {
    // A5 needs the source actor; the anonymous shared key has no identity to
    // attribute a cross-workspace publication to. Fail closed rather than publish
    // unattributed.
    throw new Error("cross-workspace publish requires an authenticated operator identity");
  }

  const body = {
    sourceWorkspaceId,
    destinationWorkspaceId: destination,
    sourceActorUserId: operatorUserId,
    statement,
    // fact_ref is provenance ONLY, never the served text.
    sourceProvenanceRef: factRef,
  };

  // Persist FIRST via A5; the derivative is born ACCEPTED at WORKSPACE scope in the
  // destination with a COMMITMENT_PUBLISHED audit. Errors propagate (fail closed).
  const receipt = await controlFetch("/internal/v1/commitments/publish-to-workspace", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    tool: "meetless__publish",
    published: true,
    mode: "cross_workspace",
    // A5's REAL destination artifact, not a synthetic id.
    published_artifact_id: receipt && receipt.commitmentId,
    destination_workspace_id: (receipt && receipt.workspaceId) || destination,
    scope: String((receipt && receipt.scope) || "workspace").toLowerCase(),
    already_published: Boolean(receipt && receipt.alreadyPublished),
    source_provenance_ref: factRef,
    note:
      "Published to the destination workspace as governed canonical knowledge (WORKSPACE scope there). " +
      "Members of that workspace can now receive this statement. The source is unchanged and is linked " +
      "only as provenance; the exact text you supplied is what was published. Idempotent per (source, statement).",
  };
}
