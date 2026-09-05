/**
 * meetless__remember: conversational GOVERNED CAPTURE of a fact / event a person
 * tells the agent to remember ("remember my meeting with Kevin Wednesday").
 *
 * This is model C from notes/20260902-emily-explicit-remember-vs-passive-source-
 * of-truth.md, NOT a generic memory box (that is the Wedge/Reject the doctrine
 * names). "remember" is a CAPTURE verb, not a truth-write: the utterance lands in
 * the SAME governed store as passive extraction, born non-authoritative (PENDING),
 * PERSON-scoped, with the trust label derived SERVER-SIDE. It becomes recallable
 * to its owner as attributed evidence ("you told me X"), never as verified truth.
 *
 * It is a THIN wrapper over the existing governed ingest front door
 * (POST /internal/v1/kb/ingest-governed). It adds NO schema, NO new route, NO new
 * subsystem (doctrine §11.4). Everything security-relevant is server-derived:
 *   - OWNER (whose memory) = the authenticated caller. On the `mla mcp`
 *     (cli-session) plane the route IGNORES any body actor and uses the token
 *     holder (intel effective_actor_user_id); on the shared-key plane the trusted
 *     config actor (operatorUserId) is the owner, re-validated against membership.
 *   - SCOPE = PERSON, always, at document creation ("Fresh ingest is always
 *     PERSON", kb_document_service). Widening to the team is a separate deliberate
 *     act, never a side effect of remember.
 *   - PROVENANCE label (human_authored) = derived server-side from the producer,
 *     never taken from a client field.
 *
 * The model-facing surface is TEXT ONLY. The provenance SHAPE below
 * (sourceSystem/producer/captureMethod) is fixed by THIS trusted action, not
 * chosen by the model, so a tool argument cannot forge who the memory belongs to,
 * its authority, or its trust label (An correction #10, 2026-09-02).
 *
 * PROVENANCE IS TRUTHFUL, NOT FLATTERING (An review 2026-09-05). The tool is
 * called BY an agent relaying text; the only evidence at this boundary is the
 * agent's tool submission, which does NOT prove a human authored these exact
 * bytes. So the producer is `agent` -> the server derives provenance
 * `agent_distilled`, not `human_authored`. An authenticated OWNER (whose memory
 * this is) is certain and server-derived; human AUTHORSHIP of arbitrary tool text
 * is not, so we never claim it. captureMethod stays
 * `authenticated_authoring_surface` (the surface really is the owner's
 * authenticated session), which keeps the doc PUBLISHED/recallable; the
 * born-ACCEPTED gate needs producer=human AND authenticatedProducerId, so an
 * agent-produced capture is correctly born PENDING (ingest_provenance.py:124).
 * Recall wording reflects the evidence: "saved through your assistant", never
 * "you told me". If a future caller can bind the text to an authenticated human
 * source or an explicit human confirmation, THAT call may set producer=human.
 */

import { createHash } from "node:crypto";

// Fixed §5.1 envelope shape for a conversational capture. NONE of these is a
// model-facing knob; they are the semantics of the `remember` verb itself.
const SOURCE_SYSTEM = "agent"; // the closed §5.1 set; the capture arrives via the agent surface
// The agent relays the text; the only evidence here is its tool submission, which
// does not prove human authorship. Truthful producer -> provenance agent_distilled
// (An review 2026-09-05). NOT "human": that would be a false attribution.
const PRODUCER_ACTOR_TYPE = "agent";
const CAPTURE_METHOD = "authenticated_authoring_surface"; // -> publicationMode PUBLISHED (recallable); born-accept still cannot fire (producer!=human)
const SOURCE_ORDERING_KIND = "SERVER_RECEIVE_SEQUENCE"; // no external ordering; the server assigns it

function requireWorkspace(deps) {
  const workspaceId = deps && deps.defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }
  return workspaceId;
}

/**
 * Build the §5.1 connector envelope for a capture. Content-addressed identity:
 * externalObjectId is derived from the SHA-256 of the exact text, so a retried
 * identical capture resolves to the SAME document (idempotent / retry-safe), while
 * a different utterance is a different document. NEVER carries a SERVER_OWNED field
 * (scope / ownerUserId / provenance / normalizedContent* / workspaceId), so the
 * §5.1 boundary accepts it and the trust label stays server-derived.
 */
export function buildRememberEnvelope(text, { workspaceId, actorUserId = null }) {
  const raw = String(text);
  const rawContentHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const externalObjectId = `mem-${rawContentHash.slice(0, 40)}`;
  // PER-USER identity keyspace (An review 2026-09-05). The tenant namespaces the
  // capture identity by the acting user, so two people remembering the SAME text
  // are DISTINCT documents (no collision) and one person's withdraw handle cannot
  // be constructed from the text alone (you also need their user id). This is a
  // convenience/uniqueness boundary; the hard privacy boundary is the route's
  // PERSON owner-guard on withdraw. Falls back to the workspace tenant only when
  // no acting user is known (which cannot happen on a real capture: the route
  // requires an owner).
  const tenant = actorUserId ? `memory:${workspaceId}:${actorUserId}` : `memory:${workspaceId}`;
  return {
    operation: "UPSERT",
    sourceSystem: SOURCE_SYSTEM,
    sourceTenantId: tenant,
    externalObjectId,
    externalRevisionId: null,
    parentExternalId: null,
    sourceOrderingKind: SOURCE_ORDERING_KIND,
    sourceSequence: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    sourceDeletedAt: null,
    producerActorType: PRODUCER_ACTOR_TYPE,
    captureMethod: CAPTURE_METHOD,
    authenticatedProducerId: null,
    triggerActorId: null,
    rawContent: raw,
    rawContentHash,
  };
}

/**
 * runRemember: capture one fact/event into the caller's private governed memory.
 * Input: { text }. Returns the receipt-derived result (persist-before-confirm):
 * the success fields come from the route receipt, never fabricated ahead of the
 * write. Includes the withdraw handle meetless__forget needs.
 */
export async function runRemember(args, deps) {
  const { intelFetch, operatorUserId = null } = deps || {};
  const workspaceId = requireWorkspace(deps);
  const text = String((args && args.text) || "").trim();
  if (!text) {
    throw new Error("text is required: pass the fact or event to remember, e.g. \"my meeting with Kevin Wednesday\"");
  }

  // actorUserId is the trusted config actor (deps), never a model arg. It owner-
  // scopes the identity keyspace so captures never collide across users and a
  // handle is not derivable from text alone.
  const envelope = buildRememberEnvelope(text, { workspaceId, actorUserId: operatorUserId });
  // Body carries ONLY workspaceId + envelope (+ the trusted config actor as the
  // shared-key owner; the cli-session plane ignores it and uses the token holder).
  // No scope / provenance / ownerUserId is ever set from here.
  const body = { workspaceId, envelope };
  if (operatorUserId) body.actor = operatorUserId;

  // Persist FIRST. We only reach the lines below AFTER the route has minted +
  // activated the revision (An correction #8: never confirm before the write).
  const receipt = await intelFetch("/internal/v1/kb/ingest-governed", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const served =
    Boolean(receipt) &&
    receipt.publicationMode === "PUBLISHED" &&
    receipt.revisionStatus === "ACTIVE";

  // A DEDUPLICATED outcome means this exact text already has a capture identity
  // (content-addressed). If that prior identity was withdrawn (tombstoned), a
  // re-capture is a no-op: the route deduplicates and does NOT revive it, so it
  // is NOT retrievable. Verified live 2026-09-05. retrievalReady already reflects
  // this (a deduped receipt is not PUBLISHED+ACTIVE), so we NEVER report ready for
  // a withdrawn record; we also say so plainly instead of a bare ready=false.
  const deduped = Boolean(receipt) && receipt.outcome === "DEDUPLICATED";
  const noteText = served
    ? "Saved privately to your memory (person scope), through your assistant. It is " +
      "recallable to you as something captured via your assistant, not as a verified " +
      "team fact, and not as your own verbatim authorship. This did NOT create a " +
      "calendar event or reminder."
    : deduped
      ? "This capture remains withdrawn; it was not restored."
      : "The capture did not become retrievable (the route did not publish + activate " +
        "it). Nothing to rely on yet; try again or report the outcome below.";

  return {
    captured: served,
    captureId: receipt && receipt.documentId,
    revisionId: receipt && receipt.revisionId,
    scope: "person",
    recorded: text,
    // Honest about what actually happened (An correction #6): retrievable now only
    // if the route actually published + activated it. Never true for a deduped /
    // withdrawn identity.
    retrievalReady: served,
    outcome: receipt && receipt.outcome,
    // The handle meetless__forget needs (withdraw keys on the source tuple, not
    // the documentId). Hand it straight to meetless__forget to undo this capture.
    withdraw: {
      sourceSystem: envelope.sourceSystem,
      sourceTenantId: envelope.sourceTenantId,
      externalObjectId: envelope.externalObjectId,
    },
    note: noteText,
  };
}
