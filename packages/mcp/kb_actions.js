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
// canonicalizes server-side. DD: (decision diffs) and TH: (threads) are NOT KB
// documents, so they are deliberately NOT normalized here.
const NOTE_CITATION_PREFIX = "NT:";

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
  if (documentId.slice(0, NOTE_CITATION_PREFIX.length).toUpperCase() === NOTE_CITATION_PREFIX) {
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
 * meetless__kb_doc_detail handler. Returns the §4.2 detail bundle for one
 * KbDocument; same shape the CLI emits for `mla kb show --json`. Per §13.12:
 *   - Output matches the HTTP endpoint exactly (we pass through, with a
 *     receipt envelope that documents which resolver path was used).
 *   - Cross-workspace requests yield a structured "not found" (the intel
 *     route already filters on workspaceId; we surface 404 as a clean error).
 */
export async function runKbDocDetail(args, deps) {
  const { intelFetch, defaultWorkspaceId } = deps;
  // §12.6 / SEC-2.2: workspace is env-pinned, never a model parameter.
  // args.workspace_id is deliberately NOT read (a smuggled value is ignored);
  // the schema does not advertise it either.
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
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

  const params = new URLSearchParams({ workspaceId });
  if (args.revision_limit !== undefined && args.revision_limit !== null) {
    const n = Number(args.revision_limit);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("revision_limit must be a positive integer");
    }
    params.set("revisionLimit", String(Math.floor(n)));
  }
  if (args.audit_limit !== undefined && args.audit_limit !== null) {
    const n = Number(args.audit_limit);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("audit_limit must be a positive integer");
    }
    params.set("auditLimit", String(Math.floor(n)));
  }

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

  return {
    mode: "kb_doc_detail",
    workspaceId,
    requestedDocumentId: args.document_id,
    resolvedDocumentId: resolved.id,
    resolverSource: resolved.source,
    detail,
  };
}
