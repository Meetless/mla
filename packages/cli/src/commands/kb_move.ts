// `mla kb move` is a BLOCKED capability in the governed (slice-A) model.
//
// A governed document's identity IS its source tuple (sourceSystem,
// sourceTenantId, externalObjectId). For a note, externalObjectId is derived
// from its path, so re-pathing a note produces a DIFFERENT governed document,
// not a rename of the existing one. The legacy worker faked a rename by
// rewriting a row's canonical_path and array-appending the old path to
// path_aliases while preserving parent_uuid; the slice-A reshape dropped that
// table shape and every method it leaned on (move_document,
// resolve_by_canonical_path, path_aliases, parent_uuid, current_posture).
//
// Slice A ships no redirect / alias primitive that would let a new path inherit
// the old document's stable id, revisions, human review verdicts, and audit
// trail. Until that primitive lands, a true identity-preserving move is not
// expressible, so this command refuses fast (no config load, no owner check, no
// subprocess) rather than silently forking a document's history.
//
// Workaround (history does NOT follow the content):
//   1. mla kb add <new-path>   - ingest the content under its new identity
//   2. mla kb forget <old>     - tombstone the old document
//
// Exit code 2 = unsupported / refused, consistent with the other curation
// commands' usage-error code.

export const MOVE_BLOCKED_MESSAGE = [
  "`mla kb move` is blocked in the governed model.",
  "",
  "A document's identity is its source tuple (sourceSystem, sourceTenantId,",
  "externalObjectId). For a note, externalObjectId is derived from its path, so",
  "re-pathing it is a different governed document, not a rename. Slice A ships no",
  "redirect / alias primitive that would carry the old document's id, revisions,",
  "review verdicts, and audit trail to the new path, so a true move is not yet",
  "expressible.",
  "",
  "Workaround (history does NOT follow the content):",
  "  1. mla kb add <new-path>   - ingest the content under its new identity",
  "  2. mla kb forget <old>     - tombstone the old document",
].join("\n");

export async function runKbMove(_argv: string[]): Promise<number> {
  console.error(MOVE_BLOCKED_MESSAGE);
  return 2;
}
