/**
 * §13.12 MCP/API parity: kb_doc_detail handler.
 *
 * Wraps intel `GET /internal/v1/kb/documents/{document_id}/detail` so the LLM
 * surface gets the same §4.2 bundle that `mla kb show` renders (identity,
 * current revision, revision history, chunks, candidates, promoted edges,
 * audit trail). When the caller passes a `note:<path>` artifact, the handler
 * first resolves it to a `kbdoc:<id>` via `GET /internal/v1/kb/documents/resolve`
 * so the LLM does not need to know the internal id (this matches the
 * artifact_id.ts CLI helper behavior).
 *
 * Design notes (mirror relationship_actions.js):
 *   - Env is the CALLER's job; server.js binds `intelFetch` + `defaultWorkspaceId`.
 *   - Strict validation; an out-of-band field throws with the allowed set.
 *   - 404 from intel propagates as a structured error (not a silent fallback)
 *     so cross-workspace requests surface as "not found" per §13.12 bullet 3.
 */

const KBDOC_PREFIX = "kbdoc:";
const NOTE_PREFIX = "note:";
// The public note-citation prefix emitted by meetless__retrieve_knowledge
// (`NT:<path>`, e.g. NT:notes/foo.md). It names the SAME artifact as
// note:<path>; the substring after it is the note path the resolve route
// canonicalizes server-side.
const NOTE_CITATION_PREFIX = "NT:";

/**
 * F4: the COMPOSITION contract between the two tools that ship together.
 *
 * `meetless__retrieve_knowledge` can emit exactly four citation namespaces. intel's
 * `_PUBLIC_CITATION_PREFIXES` (agentic_service.py) is the authority and reads
 * `("NT:", "CC:", "TH:", "DE:")`; the SEC-3 facade backstop drops everything else
 * before it can reach a model. This tool resolved ONE of the four.
 *
 * Reproduced live 2026-08-08 on the dogfood workspace: "workspace scope decision
 * accepted ruling" returned `DE:cmexample0000000000000006` as its only non-note
 * candidate and the highest-relevance ACCEPTED hit of the query. Opening it answered
 * `KB document not found ... (404)` -- while control's own
 * `GET /internal/v1/decisions/cmexample0000000000000006` returned the record. The
 * decision was not missing; the DETAIL TOOL could not address it, and said the wrong
 * thing about why.
 *
 * So the rule is not "widen kb_doc_detail into a second KB noun". It is: a citation
 * this pair emits is addressable by the pair, through whatever backing lookup ALREADY
 * owns that class, and a class with no lookup says so BY NAME. The one answer that is
 * never allowed is "not found", which asserts the object does not exist.
 *
 * Inventory, measured against the running services on 2026-08-08:
 *   NT:  -> intel KB detail (unchanged; the note path is not touched by any of this)
 *   DE:  -> control GET /internal/v1/decisions/:id      (InternalOrCliSessionGuard:
 *           serves BOTH the shared-key plane and an `mla login` user-token session,
 *           which is the plane `mla mcp` actually runs on. Verified 200 live.)
 *   CC:  -> control GET /internal/v1/cases/:id          (InternalApiGuard: shared key
 *           only. Dispatched anyway rather than declared unopenable -- the lookup is
 *           real and the shared-key plane reaches it -- and a user-token caller gets
 *           control's own auth answer instead of a fabricated "no such case".)
 *   TH:  -> NOTHING. control exposes no thread-detail route on /internal/v1, and
 *           intel's ACL-enforcing artifact repo is reachable only from inside the ask
 *           graph, never over HTTP. This is the one class that is genuinely
 *           unresolvable today, and it is the only one allowed to say so.
 */
const DECISION_CITATION_PREFIX = "DE:";
const CASE_CITATION_PREFIX = "CC:";
const THREAD_CITATION_PREFIX = "TH:";

/** Case-insensitive prefix test. The agent retypes citations, and `de:` is the same id. */
function hasPrefix(value, prefix) {
  return value.slice(0, prefix.length).toUpperCase() === prefix;
}

/**
 * Build an intelFetch helper bound to a base URL + control-token bearer.
 * Mirrors makeControlFetch in relationship_actions.js but targets intel's
 * /internal/v1/* surface (same bearer auth per Rule 5).
 */
export function makeIntelFetch({ baseUrl, apiKey, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("makeIntelFetch: baseUrl required");
  if (!apiKey) throw new Error("makeIntelFetch: apiKey required");
  return async function intelFetch(pathAndQuery, init = {}) {
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
        `intel ${init.method || "GET"} ${pathAndQuery} ${res.status}: ${text.slice(0, 600)}`,
      );
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  };
}

/**
 * Resolve an arbitrary document identifier (kbdoc:<id>, note:<path>, or a raw
 * UUID) to a concrete kbdoc id. note: artifacts go through the resolve route
 * so a bare note path "works" against `mla kb show`'s normalization. Returns
 * null if the path could not be matched (caller raises a "not found" error).
 */
async function resolveDocumentId({ intelFetch, workspaceId, documentId }) {
  if (!documentId || typeof documentId !== "string") {
    throw new Error("document_id is required (kbdoc:<id> | note:<path> | <id>)");
  }
  // Two-layer handoff: a retrieve_knowledge note citation (NT:<path>) is the
  // same artifact as note:<path>. Normalize it to the note: form (matched
  // case-insensitively so a lowercased `nt:` still works) so "open any citation
  // with kb_doc_detail" resolves instead of 404ing on the raw-uuid branch.
  if (hasPrefix(documentId, NOTE_CITATION_PREFIX)) {
    const rawPath = documentId.slice(NOTE_CITATION_PREFIX.length).trim();
    if (!rawPath) throw new Error(`malformed note citation: "${documentId}"`);
    documentId = `${NOTE_PREFIX}${rawPath}`;
  }
  if (documentId.startsWith(KBDOC_PREFIX)) {
    const id = documentId.slice(KBDOC_PREFIX.length).trim();
    if (!id) throw new Error(`malformed kbdoc id: "${documentId}"`);
    return { id, source: "artifact" };
  }
  if (documentId.startsWith(NOTE_PREFIX)) {
    const rawPath = documentId.slice(NOTE_PREFIX.length).trim();
    if (!rawPath) throw new Error(`malformed note path: "${documentId}"`);
    const params = new URLSearchParams({
      workspaceId,
      path: rawPath,
    });
    try {
      const resolved = await intelFetch(
        `/internal/v1/kb/documents/resolve?${params.toString()}`,
      );
      if (resolved && typeof resolved.documentId === "string") {
        return { id: resolved.documentId, source: "note" };
      }
      return null;
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }
  return { id: documentId.trim(), source: "raw" };
}

/**
 * The chunk fields a READER of a governed document can act on: the text, and the
 * span that says where in the document it sits.
 *
 * WHY THE REST IS DROPPED HERE (2026-08-07, session cdf1553e). Intel's chunk rail
 * also carries `chunkId`, `revisionId`, `runId`, `normalizedContentHash`,
 * `normalizationVersion` and `createdAt`. Those are substrate identity, repeated
 * once per chunk, and on the measured reproducer -- a 15,574-char note in 67
 * chunks -- they were the majority of a 53,970-unit MCP result. The host's MCP
 * ceiling sits near 50,000, so it persisted the response and injected a 2,000-char
 * preview. `document` / `serving` / `headRevision` / `revisions` all serialize
 * before `chunks`, so the preview held a uuid, a revision id and a content hash and
 * ZERO characters of the document. The agent went and grepped the vault file: the
 * governed read path returned metadata and the ungoverned one returned the note.
 *
 * NOT A CAP. Every chunk is returned; only the per-chunk metadata is projected out.
 * Capping the chunk list would truncate the DOCUMENT, which is strictly worse than
 * a persisted response -- the persisted one at least announces itself.
 *
 * OFFSETS STAY, both of them. A REDACTED revision sends `indexedText: null` with the
 * span retained; that is how intel says "text withheld". Without `endOffset` a
 * withheld chunk is indistinguishable from an empty one and the reader cannot tell
 * that text is missing, let alone how much. They also make the concatenation
 * checkable rather than trusted.
 *
 * THE BACKEND IS UNTOUCHED. Consumer audit over non-test callers (2026-08-07):
 * Console `/kb/[id]` reads startOffset / endOffset / indexedText / chunkId, and
 * `mla kb show` reads chunkId / revisionId / offsets / indexedText -- both against
 * intel's HTTP route DIRECTLY. Nothing downstream of THIS tool reads a chunk field;
 * its consumer is a language model. So the projection lives at the model-facing
 * boundary and `GET /internal/v1/kb/documents/{id}/detail` still serves the full
 * substrate grain to the surfaces that debug it.
 */
function slimChunk(c) {
  return { startOffset: c.startOffset, endOffset: c.endOffset, indexedText: c.indexedText };
}

/**
 * The size a page of this tool's result is allowed to reach, in the unit the HOST
 * actually counts.
 *
 * WHY THIS EXISTS (measured 2026-08-07, session 8779efcf). The canonical relations
 * note, `NT:notes/20260430-relations-handling-reference.md`, is 295 chunks and
 * 94,866 characters of text. Projected through `projectDetailForModel` and wrapped
 * the way server.js wraps it, the whole document measures **135,264 outer
 * String.length units**. The MCP result ceiling on this host sits near 50,000
 * (bracket 49,752..51,200), so the host persisted the body and injected a ~2KB
 * preview. The tool reported success. The second rung of the documented citation
 * ladder -- retrieve_knowledge gives a snippet, kb_doc_detail gives the full text --
 * therefore FAILED on precisely the largest and most canonical documents, which are
 * the ones worth opening.
 *
 * The A2-1 chunk projection (see `slimChunk`) removed the per-chunk substrate that
 * was half the payload, and that was necessary but not sufficient: it takes the
 * 3.5x metadata multiplier off a document, it cannot make a 95KB document fit a
 * 50KB envelope. Only paging can.
 *
 * WHY A SIZE BUDGET AND NOT A CHUNK COUNT. Chunk length is a property of the
 * DOCUMENT, not of the tool. On the measured note the mean chunk is 321 chars and
 * the max is 1,200, a ~4x spread inside ONE document; across documents it is wider.
 * A fixed count that fits the mean overruns on a document of large chunks and
 * wastes most of the envelope on a document of small ones. The bound has to be
 * expressed in the unit being bounded.
 *
 * 38,000 and not 49,000: the ceiling is the host's dial, not ours (it has already
 * moved once), and a page that fits today by 500 units is a page that breaks on the
 * next release with the same silent failure mode. Headroom is the point.
 */
export const CHUNK_PAGE_BUDGET_UNITS = 38000;

/**
 * The size the host measures: the OUTER content array, JSON escaping included.
 *
 * Not the response object, and not the inner pretty-printed body. Measured against
 * a real persisted artifact on 2026-08-07: intel's HTTP body was 42,771 bytes, the
 * inner `JSON.stringify(result, null, 2)` 50,452 units, and the outer array 53,970
 * -- and 53,970/1024 = 52.7KB is the number the host printed. Escaping the
 * pretty-printed body adds roughly 7%, so budgeting against the inner size
 * under-reads the real payload by exactly that much. Mirrors the wrapping in
 * server.js `dispatchTool`.
 */
function outerResultUnits(result) {
  return JSON.stringify([{ type: "text", text: JSON.stringify(result, null, 2) }]).length;
}

/**
 * The largest page starting at `offset` that still fits `CHUNK_PAGE_BUDGET_UNITS`.
 *
 * Binary search over an EXACT measurement rather than an estimate, because the
 * estimate is the thing that was wrong last time: a metadata bucket serialized
 * standalone rather than at its real nesting depth under-read the result by 55%.
 * Payload size is monotonic in page length (a chunk only ever adds), so the search
 * is sound and costs ~log2(n) serializations of a <=50KB string.
 *
 * ALWAYS AT LEAST ONE CHUNK while chunks remain. A caller handed an empty page with
 * `chunkOffset + 0 < chunkCount` has no legal next offset and stalls forever, which
 * is a worse failure than a single oversized chunk tripping the host's persist path
 * -- that one at least announces itself, and `chunks` serializes first so the
 * preview still holds document text.
 */
function fitChunkPage(buildResult, available) {
  if (available <= 0) return 0;
  if (outerResultUnits(buildResult(available)) <= CHUNK_PAGE_BUDGET_UNITS) return available;
  let lo = 1; // the deadlock guard: never search below one chunk
  let hi = available;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (outerResultUnits(buildResult(mid)) <= CHUNK_PAGE_BUDGET_UNITS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The bundle rails that describe the document's PROVENANCE rather than its text.
 * Each is an unbounded array whose length is a property of how much review the
 * document has accumulated, not of how much a reader asked for.
 *
 * Ordered by what a reader of THIS tool loses by dropping it. `claims` carry
 * verbatim semantic content and are the only one a model can reason over;
 * `revisions` are pure lineage, and the HEAD of that lineage is already carried
 * separately by the scalar `headRevision` rail, so trimming the array never loses
 * the fact a reader most often wants; `audit` is the furthest from the question
 * "what does this note say?".
 */
const PROVENANCE_KEYS = ["claims", "revisions", "audit"];

/**
 * Largest prefix of `len` items that keeps the whole result inside the budget.
 *
 * Same exact-measurement binary search as fitChunkPage and sound for the same
 * reason (an item only ever adds), with one deliberate difference: this one may
 * return ZERO. A provenance array trimmed to empty is a legitimate outcome and
 * the reader can still tell how much exists, because the scalar count rails
 * (`claimCount`, `revisionCount`, `auditCount`) are budgeted before any of this
 * and never trimmed. Chunks cannot return zero, because a zero-length page with
 * chunks remaining leaves the caller no legal next offset.
 */
function fitArrayPrefix(buildResult, len) {
  if (len <= 0) return 0;
  if (outerResultUnits(buildResult(len)) <= CHUNK_PAGE_BUDGET_UNITS) return len;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (outerResultUnits(buildResult(mid)) <= CHUNK_PAGE_BUDGET_UNITS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Put the claims that describe THIS page of chunks in front of the ones that do
 * not, preserving document order inside each group.
 *
 * Claims are already chunk-addressable: intel's KbClaimItem carries `startOffset`
 * / `endOffset` in the same coordinate space as KbChunkItem. So "relevant to the
 * page the caller just asked for" is a fact the bundle already contains, and
 * nothing new has to be computed, stored, or advertised to use it. Before this,
 * the claims that survived the budget were a document-order prefix, so a caller
 * paging into the middle of a note got claims about the opening paragraph.
 *
 * A stable partition, not a filter: the non-overlapping claims stay reachable
 * behind the relevant ones whenever the budget allows. Falls back to the original
 * order whenever the offsets are missing or the page is empty; an ordering
 * heuristic must never be the thing that drops a claim.
 *
 * RULED CLAIMS OUTRANK PAGE RELEVANCE (P2, 2026-08-09). A claim carrying a human
 * verdict sorts ahead of every unruled claim, and page relevance then orders
 * WITHIN each band. Measured that day: kb_doc_detail on the 348-chunk doctrine
 * note returned `claimCount: 61`, `claimsOnPriorRevisions: 0` and `claims: []` --
 * the chunk-first budget correctly gave the text priority and `claims` is the
 * first provenance array trimmed, so every verdict on the document was dropped,
 * on exactly the large governed documents where a verdict is worth reading.
 *
 * The tie is broken by scarcity, not by preference. The corpus held 107 human
 * verdicts against 63,222 claims: a ruled claim is ~0.17% of the population and
 * the only part of this array a human paid for, while page overlap is abundant and
 * reconstructible by paging. It also makes an outward promise true: the
 * retrieve_knowledge contract tells the agent that the band is a fold of these
 * claims and to open the citation when one matters, which is only honest if the
 * verdict survives the trip.
 */
function isRuledClaim(c) {
  // The AUTHOR is the discriminator, not the outcome: every claim carries a
  // `reviewOutcome` from birth (PENDING), and only a human verdict writes
  // `reviewedBy` / `reviewedAt` (the DB CHECK ck_claim_review_attribution pairs
  // them). Keying on the outcome string would rank the entire born-PENDING corpus.
  return Boolean(c && c.reviewedBy);
}

function orderClaimsForPage(claims, page) {
  if (!Array.isArray(claims) || claims.length === 0) return claims;
  const ruled = [];
  const unruled = [];
  for (const c of claims) (isRuledClaim(c) ? ruled : unruled).push(c);

  const byPage = (list) => {
    if (list.length === 0) return list;
    if (!Array.isArray(page) || page.length === 0) return list;
    const pageStart = page[0]?.startOffset;
    const pageEnd = page[page.length - 1]?.endOffset;
    if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) return list;
    const onPage = [];
    const offPage = [];
    for (const c of list) {
      const s = c?.startOffset;
      const e = c?.endOffset;
      const overlaps =
        Number.isFinite(s) && Number.isFinite(e) && e > pageStart && s < pageEnd;
      (overlaps ? onPage : offPage).push(c);
    }
    return [...onPage, ...offPage];
  };

  return [...byPage(ruled), ...byPage(unruled)];
}

/** A required non-negative integer arg, or a plain error the model can self-correct. */
function readIntArg(value, name, { min }) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

/**
 * Project the intel bundle for a MODEL: slim chunks, and content before identity.
 *
 * The reordering is A2-2 and it is BEST-EFFORT, not a contract and not a size
 * reduction. It exists because the host's preview is a literal PREFIX of the
 * serialized content array (verified against the persisted artifact for cdf1553e:
 * `persisted.startsWith(previewPayload)` is true and the cut lands mid-token), so
 * whichever key serializes first is what a truncated read contains. Leading with
 * `chunks` turns a total failure into a partial one for free, and it keeps helping
 * if the ceiling moves -- which it will, because it is the host's dial, not ours.
 * Nobody should lean on JSON key order; this is a courtesy to the truncator.
 *
 * Unknown keys survive: intel is free to add rails to the bundle and they pass
 * through in their original relative order, after `chunks`.
 */
function projectDetailForModel(detail, chunks, provenance) {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return detail;
  if (!Array.isArray(detail.chunks)) return detail;
  const { chunks: _all, ...rest } = detail;
  const out = { chunks, ...rest };
  // Substitute only rails the bundle actually carries: inventing an empty
  // `audit` on an intel that never sent one would be a claim, not a projection.
  if (provenance) {
    for (const key of PROVENANCE_KEYS) {
      if (key in provenance && Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = provenance[key];
      }
    }
  }
  return out;
}

/**
 * The canonical citation for a document, derived from the BUNDLE, not from how
 * the caller happened to address it.
 *
 * WHY (measured 2026-08-07 over ~/.meetless/logs/mcp-calls.jsonl). The PostToolUse
 * hook derives a pull's citations by grepping the call record for the
 * `(DD|TH|NT|CC|...)` grammar. A detail bundle carries uuids, so the only thing
 * that ever matched was the caller's own argument: across 104 kb_doc_detail calls,
 * `source_ids` is non-empty on exactly the 43 whose record contains an `NT:`
 * token, a clean 104-of-104 split. Open the same document as `note:<path>` or a
 * bare uuid and the call emits nothing, no InjectionTrace row is written, and the
 * turn reads in the pull ledger as though no governed memory was fetched. It
 * measured typing style, not behaviour.
 *
 * Returning the token closes both halves: the agent is handed the exact string the
 * citation metric counts it on naming, and the hook's existing grammar finds it in
 * the RESPONSE instead of in a lucky argument.
 *
 * NOTES ONLY. `NT:` is the note citation grammar. A Slack- or Confluence-sourced
 * document gets null rather than a minted id that resolves nowhere.
 */
function canonicalCitation(detail) {
  const doc = detail && typeof detail === "object" ? detail.document : null;
  if (!doc || typeof doc !== "object") return null;
  if (doc.sourceSystem !== "notes") return null;
  const path = doc.externalObjectId;
  return typeof path === "string" && path.trim() ? `NT:${path}` : null;
}

/**
 * meetless__kb_doc_detail handler. Returns the §4.2 detail bundle for one
 * KbDocument, projected for a model reader (see `projectDetailForModel`). Per
 * §13.12, as amended 2026-08-07:
 *   - The bundle's RAILS match the HTTP endpoint exactly; the chunk grain is
 *     projected to the reader-usable fields, and nothing else is transformed.
 *   - Cross-workspace requests yield a structured "not found" (the intel
 *     route already filters on workspaceId; we surface 404 as a clean error).
 */
/**
 * F4 dispatch: resolve a `DE:` decision citation through control's decision-record
 * lookup, the SAME route `meetless__decision_record` already calls.
 *
 * The envelope keeps `kb_doc_detail`'s preamble shape (mode / requested / resolved /
 * resolverSource / citation) so a reader does not have to learn a second response
 * grammar to follow a citation, and `citation` echoes the DE: token the caller asked
 * with because that is the string the follow-through metric counts.
 */
async function openDecision(rawId, { controlFetch, workspaceId, requested }) {
  const id = rawId.trim();
  if (!id) throw new Error(`malformed decision citation: "${requested}"`);
  if (typeof controlFetch !== "function") {
    // Honest, and a different claim from "no such decision". Only the legacy env bin
    // and a partial embedding land here; `mla mcp` always binds controlFetch.
    const e = new Error(
      `This surface cannot reach control, so ${requested} cannot be opened here. ` +
        `Use meetless__decision_record(decision_id: "${id}").`,
    );
    e.status = 501;
    throw e;
  }
  try {
    const detail = await controlFetch(
      `/internal/v1/decisions/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    return {
      mode: "decision_record",
      workspaceId,
      requestedDocumentId: requested,
      resolvedDocumentId: id,
      resolverSource: "decision",
      citation: `${DECISION_CITATION_PREFIX}${id}`,
      detail,
    };
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 404) {
      // Say DECISION, and say it is a decision-shaped miss. The old line claimed a KB
      // document was missing, which was false in both halves: it is not a KB document,
      // and (measured) it was not missing.
      const e = new Error(
        `No decision ${id} in this workspace. It may have been purged, or the id may belong to another workspace.`,
      );
      e.status = 404;
      throw e;
    }
    if (status === 422) {
      // Same discrimination `meetless__decision_record` makes: only an ACCEPTED or
      // SUPERSEDED commitment projects a DecisionRecord. "Exists but is not projectable"
      // is not "not found".
      const e = new Error(
        `${id} is not a projectable decision: only an ACCEPTED or SUPERSEDED commitment has a DecisionRecord.`,
      );
      e.status = 422;
      throw e;
    }
    if (status === 400) {
      const e = new Error(
        "Control could not resolve a viewer for this read. Run `mla login` so the MCP server calls as an audited human.",
      );
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

/**
 * F4 dispatch: resolve a `CC:` coordination-case citation through control's case-detail
 * lookup.
 *
 * The route derives nothing: it requires BOTH `workspaceId` and `actorUserId`, and it
 * is guarded by `InternalApiGuard` (shared key). Under `mla login` the MCP calls with a
 * user token, so this read can answer 401 -- and that is control's answer about
 * AUTHORIZATION, which is the honest thing to surface. The failure this closes is the
 * one where a reachable object was reported as a nonexistent one.
 */
async function openCase(rawId, { controlFetch, workspaceId, operatorUserId, requested }) {
  const id = rawId.trim();
  if (!id) throw new Error(`malformed coordination-case citation: "${requested}"`);
  if (typeof controlFetch !== "function") {
    const e = new Error(`This surface cannot reach control, so ${requested} cannot be opened here.`);
    e.status = 501;
    throw e;
  }
  if (!operatorUserId) {
    // The case read is viewer-scoped and control will not infer one. Name the missing
    // identity rather than letting the server turn it into a 400 the agent reads as
    // "the case is not there".
    const e = new Error(
      `Opening ${requested} needs an audited viewer and this session has none. Run \`mla login\`.`,
    );
    e.status = 400;
    throw e;
  }
  const params = new URLSearchParams({ workspaceId, actorUserId: operatorUserId });
  try {
    const detail = await controlFetch(`/internal/v1/cases/${encodeURIComponent(id)}?${params.toString()}`);
    return {
      mode: "coordination_case",
      workspaceId,
      requestedDocumentId: requested,
      resolvedDocumentId: id,
      resolverSource: "case",
      citation: `${CASE_CITATION_PREFIX}${id}`,
      detail,
    };
  } catch (err) {
    const status = err && typeof err === "object" ? err.status : undefined;
    if (status === 404) {
      const e = new Error(`No coordination case ${id} in this workspace.`);
      e.status = 404;
      throw e;
    }
    if (status === 401 || status === 403) {
      const e = new Error(
        `Control refused this read of ${requested} for this session's identity. ` +
          `The case-detail route serves the shared-key plane; a user-token session cannot read it yet.`,
      );
      e.status = status;
      throw e;
    }
    throw err;
  }
}

export async function runKbDocDetail(args, deps) {
  const { intelFetch, defaultWorkspaceId, controlFetch, operatorUserId = null } = deps;
  // Validated BEFORE the network call: a malformed offset should cost a message,
  // not a round trip, and the error has to name the field so the model can fix it.
  const offset = readIntArg(args.offset, "offset", { min: 0 }) ?? 0;
  const limit = readIntArg(args.limit, "limit", { min: 1 });
  // §12.6 / SEC-2.2: workspace is env-pinned, never a model parameter.
  // args.workspace_id is deliberately NOT read (a smuggled value is ignored);
  // the schema does not advertise it either.
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }

  // F4: route the three non-KB citation namespaces to their own backing lookups BEFORE
  // the KB resolver sees them. Placed here, ahead of `resolveDocumentId`, because that
  // function's last branch treats any unrecognized string as a raw KbDocument uuid --
  // which is exactly how `DE:<id>` became "KB document not found". Paging/offset/limit
  // are KB-chunk concepts and are deliberately not honored on these branches: a decision
  // record and a case detail are whole objects, not chunk rails.
  const requested = typeof args.document_id === "string" ? args.document_id.trim() : "";
  if (hasPrefix(requested, DECISION_CITATION_PREFIX)) {
    return openDecision(requested.slice(DECISION_CITATION_PREFIX.length), {
      controlFetch,
      workspaceId,
      requested,
    });
  }
  if (hasPrefix(requested, CASE_CITATION_PREFIX)) {
    return openCase(requested.slice(CASE_CITATION_PREFIX.length), {
      controlFetch,
      workspaceId,
      operatorUserId,
      requested,
    });
  }
  if (hasPrefix(requested, THREAD_CITATION_PREFIX)) {
    // The one class with no resolver anywhere (see the inventory above). It says which
    // namespace it is, that the gap is OURS and not the object's, and what the agent can
    // still read -- the snippet retrieve_knowledge already returned for this same id.
    const e = new Error(
      `${requested} is a thread citation, and no detail lookup is exposed for the TH: namespace yet ` +
        `(this is a gap in our tooling, not evidence that the thread is missing). ` +
        `The snippet meetless__retrieve_knowledge returned for this id is the fullest read available.`,
    );
    e.status = 501;
    throw e;
  }

  const resolved = await resolveDocumentId({
    intelFetch,
    workspaceId,
    documentId: args.document_id,
  });
  if (!resolved) {
    const err = new Error(
      `KB document not found for "${args.document_id}" in workspace "${workspaceId}"`,
    );
    err.status = 404;
    throw err;
  }

  // workspaceId ONLY. The re-homed detail route (slice-A, kb_document_detail.py)
  // takes no revision / audit / chunk knobs; the bundle is whole. This used to
  // forward `revisionLimit` / `auditLimit`, which FastAPI accepted and discarded:
  // proven live 2026-08-07, the same document with and without them returned
  // byte-identical bodies. `mla kb show` had already stopped sending them and
  // truncates client-side instead; only the MCP kept the dead knobs, and only the
  // MCP advertises them to a model.
  const params = new URLSearchParams({ workspaceId });

  let detail;
  try {
    detail = await intelFetch(
      `/internal/v1/kb/documents/${encodeURIComponent(resolved.id)}/detail?${params.toString()}`,
    );
  } catch (err) {
    if (err && err.status === 404) {
      const e = new Error(
        `KB document not found for "${args.document_id}" in workspace "${workspaceId}"`,
      );
      e.status = 404;
      throw e;
    }
    throw err;
  }

  const envelope = {
    mode: "kb_doc_detail",
    workspaceId,
    requestedDocumentId: args.document_id,
    resolvedDocumentId: resolved.id,
    resolverSource: resolved.source,
    // Cite THIS, not the uuid. Placed in the envelope preamble so it survives the
    // host's 2KB preview cut: a citation the truncator removes is one the agent
    // cannot use, and it is the token this read path is measured on.
    citation: canonicalCitation(detail),
    // The claims rail, in the preamble for the SAME reason (2026-08-08, session
    // a9192083). This tool returned `"claims": []` for a document the corpus held
    // 38 NORMALIZED claims for, every one of them anchored on a SUPERSEDED
    // revision. The list was right -- claims anchor on the HEAD by design, because
    // text a newer revision replaced is not current -- and it read as "this
    // document contributes zero claims", which a session nearly shipped as a
    // finding. `claimsOnPriorRevisions` is the discriminator: 0 means nothing was
    // ever extracted, non-zero means the head has not been extracted YET. Both are
    // undefined against an intel that predates the field, and an absent counter is
    // deliberately not coerced to 0: "we did not measure" and "we measured zero"
    // are the two readings this whole fix exists to separate.
    claimCount: detail?.claimCount,
    claimsOnPriorRevisions: detail?.claimsOnPriorRevisions,
    claimsAnchorRevisionId: detail?.claimsAnchorRevisionId,
    // The other two provenance arrays get the same treatment `claimCount` already
    // gives claims, and for the same reason: chunk-first budgeting can trim any of
    // them to fit, and a trimmed array with no count beside it reads as the whole
    // truth. `claimCount` comes from intel (it counts the head's claims, which is
    // not the array length); these two are derived here because the array IS the
    // count. Absent rails stay undefined rather than being coerced to 0, so "not
    // sent" never reads as "measured zero".
    revisionCount: Array.isArray(detail?.revisions) ? detail.revisions.length : undefined,
    auditCount: Array.isArray(detail?.audit) ? detail.audit.length : undefined,
  };

  // A bundle with no chunk rail (a malformed or future shape) pages over nothing
  // and reports no paging rails; inventing a chunkCount of 0 for it would tell the
  // reader the document is empty, which is a different claim from "not chunked".
  if (!Array.isArray(detail?.chunks)) {
    return { ...envelope, detail: projectDetailForModel(detail, null) };
  }

  const all = detail.chunks.map(slimChunk);
  const available = Math.max(0, Math.min(all.length - offset, limit ?? Infinity));

  // PAGING RAILS BEFORE `detail`, for the same reason `citation` is: they are what
  // tells the reader this is a page and where the next one starts, and a rail the
  // preview cut removes is a rail the agent cannot act on.
  //
  // `chunkCount` is the WHOLE document; `chunkOffset` is where this page starts.
  // There is deliberately no `hasMore` / cursor / token: `chunkOffset +
  // detail.chunks.length < chunkCount` already answers it, and a second encoding of
  // the same fact is a second thing that can disagree with the first.
  const paged = (n, provenance) => ({
    ...envelope,
    chunkCount: all.length,
    chunkOffset: offset,
    detail: projectDetailForModel(detail, all.slice(offset, offset + n), provenance),
  });

  // CHUNK-FIRST BUDGETING (M2, measured 2026-08-09 in session 4caa06b9).
  //
  // The tool exists to answer "what does this document say?", and it was answering
  // with provenance. On a 147-chunk note carrying 50 claims and 10 full revision
  // records it returned ONE chunk of 89 characters -- the title -- because
  // fitChunkPage searched for the chunks that fit in what the metadata LEFT. Worse,
  // the metadata alone overran: the result measured 54,412 units against a 38,000
  // budget, so even the one-chunk deadlock guard could not bring it inside.
  //
  // The order is the fix. Nothing here is a new constant, a reserved percentage, or
  // a new knob: the document text is budgeted first under the offset/limit the
  // caller already passed, and the provenance arrays then take what is left, in the
  // order a reader of this tool misses them. The scalar counts are budgeted before
  // all of it and never trimmed, so a shortened array is always legible as one.
  const emptyProvenance = { claims: [], revisions: [], audit: [] };
  const n = fitChunkPage((k) => paged(k, emptyProvenance), available);
  const page = all.slice(offset, offset + n);

  const chosen = { ...emptyProvenance };
  for (const key of PROVENANCE_KEYS) {
    const source =
      key === "claims" ? orderClaimsForPage(detail.claims, page) : detail[key];
    if (!Array.isArray(source) || source.length === 0) continue;
    // Each array is fitted against a result that already contains the ones before
    // it, so the priority order in PROVENANCE_KEYS is what actually decides who
    // gets the remaining budget, not the order intel happened to serialize them in.
    const take = fitArrayPrefix(
      (k) => paged(n, { ...chosen, [key]: source.slice(0, k) }),
      source.length,
    );
    chosen[key] = source.slice(0, take);
  }
  return paged(n, chosen);
}
