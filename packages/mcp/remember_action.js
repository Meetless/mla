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
 * The one flagged judgment call (see the plan note §3): producer=human +
 * captureMethod=authenticated_authoring_surface treats a `remember` as "a human
 * authored this through an authenticated surface", which is what the verb means.
 * An agent COULD relay fabricated text; that is contained because the row is born
 * PENDING + PERSON (never authoritative) and is served only as attributed
 * evidence. The alternative (producer=agent) has no served capture method in the
 * current vocab, so it would be a new-enum boundary.
 */

import { createHash } from "node:crypto";

// Fixed §5.1 envelope shape for a conversational capture. NONE of these is a
// model-facing knob; they are the semantics of the `remember` verb itself.
const SOURCE_SYSTEM = "agent"; // the closed §5.1 set; the capture arrives via the agent surface
const PRODUCER_ACTOR_TYPE = "human"; // a human authored the fact through the authenticated surface
const CAPTURE_METHOD = "authenticated_authoring_surface"; // -> publicationMode PUBLISHED (recallable)
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
export function buildRememberEnvelope(text, { workspaceId }) {
  const raw = String(text);
  const rawContentHash = createHash("sha256").update(raw, "utf8").digest("hex");
  const externalObjectId = `mem-${rawContentHash.slice(0, 40)}`;
  return {
    operation: "UPSERT",
    sourceSystem: SOURCE_SYSTEM,
    // Tenant namespace for conversational memory, per workspace. Not an audience
    // (scope is server-owned and born PERSON); just the identity keyspace.
    sourceTenantId: `memory:${workspaceId}`,
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

  const envelope = buildRememberEnvelope(text, { workspaceId });
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

  return {
    captured: true,
    captureId: receipt && receipt.documentId,
    revisionId: receipt && receipt.revisionId,
    scope: "person",
    recorded: text,
    // Honest about what actually happened (An correction #6): retrievable now only
    // if the route actually published + activated it.
    retrievalReady: served,
    outcome: receipt && receipt.outcome,
    // The handle meetless__forget needs (withdraw keys on the source tuple, not
    // the documentId). Hand it straight to meetless__forget to undo this capture.
    withdraw: {
      sourceSystem: envelope.sourceSystem,
      sourceTenantId: envelope.sourceTenantId,
      externalObjectId: envelope.externalObjectId,
    },
    note:
      "Saved privately to your memory (person scope). It is recallable to you as " +
      "something you told me, not as a verified team fact. This did NOT create a " +
      "calendar event or reminder.",
  };
}
