// The single query-string builder for control's relationship-candidate list route
// (GET /internal/v1/relationship-candidates). Shared by the kb review listing
// (cursor pagination) and the kb forget cascade so neither command module imports
// the other. Pins the review view to PENDING_REVIEW across BOTH postures.
//
// Posture contract (must mirror apps/console/app/review/load-inbox.ts): the
// D1-resolution + semantic/heuristic detectors mint candidates at SHADOW +
// PENDING_REVIEW ("stuck until a human acts"); those SHADOW rows ARE the bulk of
// the human-review workload. A `posture=LIVE` filter hid the entire SHADOW review
// queue, so `mla graph review` / `mla kb review` reported "no candidates" while
// real pending edges sat in the Console inbox. Control's default-view discipline
// pins LIVE unless a caller opts out, so we send NO `posture` + `includeShadow=true`
// to get both postures. The forget/purge cascade wants both too: a SHADOW-pending
// candidate pointing at a tombstoned doc must be rejected, not orphaned.
export function buildPendingCandidateQuery(
  workspaceId: string,
  doc: string | null,
  limit: number,
  cursor?: { id: string; createdAt: string } | null,
): string {
  const qs = new URLSearchParams();
  qs.set("workspaceId", workspaceId);
  qs.set("statusId", "PENDING_REVIEW");
  qs.set("includeShadow", "true");
  qs.set("limit", String(limit));
  if (doc) {
    // `--doc note:foo.md` is an exact artifactId; a bare `foo.md` is a notePath the
    // route resolves to a basename server-side (relationship-candidate.dto.ts).
    if (doc.includes(":")) qs.set("artifactId", doc);
    else qs.set("notePath", doc);
  }
  if (cursor) {
    qs.set("cursorId", cursor.id);
    qs.set("cursorCreatedAt", cursor.createdAt);
  }
  return qs.toString();
}
