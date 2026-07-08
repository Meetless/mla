// Artifact ID resolver for `mla kb` commands.
// Source: notes/20260530-mla-kb-curation-cli-proposal-v2.md §3.5 + §4.2.
//
// Inputs accepted on the command line:
//   kbdoc:<id>           the canonical id of a KbDocument row.
//   kbdocrev:<id>        the id of a specific KbDocumentRevision row.
//   note:<canonicalPath> legacy form during the deprecation window (§3.4).
//   <bare path>          treated as a canonical path the server will resolve.
//
// Client-side this layer does NOT canonicalize paths. Canonicalization lives
// server-side in intel's canonicalize_note_path() so that the case-fold rule
// and unicode NFC step apply consistently across CLI, MCP, and worker
// callers. The helper exists to (a) classify the operator's input shape, and
// (b) build display strings for receipts.

export type ArtifactInput =
  | { kind: "kbdoc"; id: string }
  | { kind: "kbdocrev"; id: string }
  | { kind: "note"; path: string }
  | { kind: "path"; path: string };

export class ArtifactInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactInputError";
  }
}

const KBDOC_PREFIX = "kbdoc:";
const KBDOCREV_PREFIX = "kbdocrev:";
const NOTE_PREFIX = "note:";

// Parse a positional input from `mla kb show / forget / reingest / purge /
// move`. Empty strings are rejected because they would silently degrade to a
// bare-path branch that resolves nothing.
export function parseArtifactInput(raw: string): ArtifactInput {
  if (typeof raw !== "string") {
    throw new ArtifactInputError("artifact input must be a string");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ArtifactInputError("artifact input is empty");
  }

  if (trimmed.startsWith(KBDOC_PREFIX)) {
    const id = trimmed.slice(KBDOC_PREFIX.length).trim();
    if (!id) {
      throw new ArtifactInputError("kbdoc: prefix requires an id");
    }
    return { kind: "kbdoc", id };
  }

  if (trimmed.startsWith(KBDOCREV_PREFIX)) {
    const id = trimmed.slice(KBDOCREV_PREFIX.length).trim();
    if (!id) {
      throw new ArtifactInputError("kbdocrev: prefix requires an id");
    }
    return { kind: "kbdocrev", id };
  }

  if (trimmed.startsWith(NOTE_PREFIX)) {
    const p = trimmed.slice(NOTE_PREFIX.length).trim();
    if (!p) {
      throw new ArtifactInputError("note: prefix requires a path");
    }
    return { kind: "note", path: p };
  }

  return { kind: "path", path: trimmed };
}

// Receipts and renderers always express ids in the canonical `kbdoc:<id>`
// shape so audit log lookups and MCP queries can use the same string.
export function formatKbDocId(id: string): string {
  if (!id) throw new ArtifactInputError("formatKbDocId: id is required");
  return `${KBDOC_PREFIX}${id}`;
}

export function formatKbDocRevId(id: string): string {
  if (!id) throw new ArtifactInputError("formatKbDocRevId: id is required");
  return `${KBDOCREV_PREFIX}${id}`;
}

// Inverse of parseArtifactInput for display. Bare paths render as-is (no
// `note:` prefix) because the deprecation-window form is operator-typed
// input, not output the CLI should emit.
export function formatArtifactInput(input: ArtifactInput): string {
  switch (input.kind) {
    case "kbdoc":
      return formatKbDocId(input.id);
    case "kbdocrev":
      return formatKbDocRevId(input.id);
    case "note":
      return `${NOTE_PREFIX}${input.path}`;
    case "path":
      return input.path;
  }
}

// HTTP query-param shape: the intel routes that resolve operator input accept
// either `documentId=<id>` (when the CLI parsed a kbdoc/kbdocrev) or
// `path=<value>` (when the CLI saw a bare path or legacy note:). Centralized
// here so command files don't reinvent the encoding.
export function toResolverQuery(
  input: ArtifactInput,
): { documentId: string } | { revisionId: string } | { path: string } {
  switch (input.kind) {
    case "kbdoc":
      return { documentId: input.id };
    case "kbdocrev":
      return { revisionId: input.id };
    case "note":
    case "path":
      return { path: input.path };
  }
}
