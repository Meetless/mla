import {
  noteKey,
  noteArtifactId,
  SessionScopeError,
} from "../../src/lib/session-scope";

describe("noteKey", () => {
  // Pins the join rule verified live against control on 2026-06-07: control keys
  // a note artifact by its BASENAME, not the repo-relative path (DTO comment:
  // notePath is "a bare basename"). A candidate's artifactId is `note:<basename>`;
  // the store records canonicalPath as `notes/<basename>`. If control ever re-keys
  // notes, THIS test must fail loudly.
  it("reduces a repo-relative notes path to its basename", () => {
    expect(noteKey("notes/20260607-mla-observability-and-debugging.md")).toEqual(
      "20260607-mla-observability-and-debugging.md",
    );
  });

  it("is a no-op for an already-bare basename", () => {
    expect(noteKey("foo.md")).toEqual("foo.md");
  });

  it("normalizes backslashes defensively", () => {
    expect(noteKey("notes\\foo.md")).toEqual("foo.md");
  });

  it("builds the fully-qualified note artifactId", () => {
    expect(noteArtifactId("notes/foo.md")).toEqual("note:foo.md");
  });
});

describe("SessionScopeError", () => {
  it("is an Error subclass with a stable name and instanceof", () => {
    const e = new SessionScopeError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SessionScopeError);
    expect(e.name).toEqual("SessionScopeError");
  });
});

import { resolveScopeSession } from "../../src/lib/session-scope";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function writeStore(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
  const store = path.join(dir, "kb-knowledge.jsonl");
  fs.writeFileSync(store, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return store;
}
const rec = (o: object) => ({ event: "active_memory_record", workspaceId: "ws1", ...o });

describe("resolveScopeSession", () => {
  it("uses a concrete sid verbatim", () => {
    expect(resolveScopeSession("abc-123", { env: {} })).toEqual({ sessionId: "abc-123", source: "explicit" });
  });

  it("'current' binds to $CLAUDE_CODE_SESSION_ID", () => {
    expect(resolveScopeSession("current", { env: { CLAUDE_CODE_SESSION_ID: "sid-env" } })).toEqual({ sessionId: "sid-env", source: "current-env" });
  });

  it("'current' fails loudly when the env var is unset", () => {
    expect(() => resolveScopeSession("current", { env: {} })).toThrow(SessionScopeError);
  });

  it("'latest' picks the most recent PRODUCED-DOC session in THIS workspace", () => {
    const store = writeStore([
      rec({ sessionId: "old", kind: "produced_doc", canonicalPath: "notes/a.md", createdAt: "2026-06-01T00:00:00.000Z" }),
      rec({ sessionId: "newer-but-ref", kind: "tagged_reference", canonicalPath: "notes/r.md", createdAt: "2026-06-09T00:00:00.000Z" }),
      rec({ sessionId: "new", kind: "produced_doc", canonicalPath: "notes/b.md", createdAt: "2026-06-07T00:00:00.000Z" }),
      rec({ sessionId: "otherws", workspaceId: "ws2", kind: "produced_doc", canonicalPath: "notes/c.md", createdAt: "2026-06-12T00:00:00.000Z" }),
    ]);
    expect(resolveScopeSession("latest", { env: {}, storePath: store, workspaceId: "ws1" })).toEqual({ sessionId: "new", source: "latest-store" });
  });

  it("'latest' fails loudly when no session produced docs", () => {
    const store = writeStore([rec({ sessionId: "x", kind: "tagged_reference", canonicalPath: "notes/r.md", createdAt: "2026-06-01T00:00:00.000Z" })]);
    expect(() => resolveScopeSession("latest", { env: {}, storePath: store, workspaceId: "ws1" })).toThrow(SessionScopeError);
  });

  it("'latest' fails loudly on a missing store", () => {
    expect(() => resolveScopeSession("latest", { env: {}, storePath: "/nope.jsonl", workspaceId: "ws1" })).toThrow(SessionScopeError);
  });

  it("'latest' ignores a record with a malformed timestamp (it cannot win)", () => {
    const store = writeStore([
      rec({ sessionId: "good", kind: "produced_doc", canonicalPath: "notes/a.md", createdAt: "2026-06-01T00:00:00.000Z" }),
      rec({ sessionId: "corrupt", kind: "produced_doc", canonicalPath: "notes/b.md", createdAt: "not-a-date" }),
    ]);
    expect(resolveScopeSession("latest", { env: {}, storePath: store, workspaceId: "ws1" })).toEqual({ sessionId: "good", source: "latest-store" });
  });

  it("rejects an empty value", () => {
    expect(() => resolveScopeSession("   ", { env: {} })).toThrow(SessionScopeError);
  });
});

import {
  sessionNoteKeys,
  candidateInSession,
  loadSessionScope,
} from "../../src/lib/session-scope";
import type { RelationshipCandidate } from "../../src/lib/kb-candidate";

function cand(over: Partial<RelationshipCandidate> = {}): RelationshipCandidate {
  return {
    id: "c1", workspaceId: "ws1", relationTypeId: "SUPERSEDES", statusId: "PENDING_REVIEW",
    postureId: "LIVE", sourceType: "note", sourceArtifactId: "note:20260607-a.md",
    targetType: "note", targetArtifactId: "note:20260601-b.md", confidence: 0.9,
    detectorFamily: "semantic.m3b", evidenceJson: null, createdAt: "2026-06-07T00:00:00.000Z",
    ...over,
  } as RelationshipCandidate;
}

describe("sessionNoteKeys", () => {
  const nowMs = Date.parse("2026-06-07T01:00:00.000Z");

  it("collects produced-doc basenames for one session in one workspace; ignores other kinds/sessions/workspaces", () => {
    const store = writeStore([
      rec({ sessionId: "S", kind: "produced_doc", canonicalPath: "notes/20260607-a.md", createdAt: "2026-06-07T00:00:00.000Z" }),
      rec({ sessionId: "S", kind: "tagged_reference", canonicalPath: "notes/ref.md", createdAt: "2026-06-07T00:00:00.000Z" }),
      rec({ sessionId: "OTHER", kind: "produced_doc", canonicalPath: "notes/zzz.md", createdAt: "2026-06-07T00:00:00.000Z" }),
      rec({ sessionId: "S", workspaceId: "ws2", kind: "produced_doc", canonicalPath: "notes/20260607-a.md", createdAt: "2026-06-07T00:00:00.000Z" }),
    ]);
    const scope = sessionNoteKeys("S", { workspaceId: "ws1", storePath: store, nowMs });
    expect(scope.sessionId).toEqual("S");
    expect([...scope.keys].sort()).toEqual(["20260607-a.md"]);
  });

  it("returns an empty key set for an unknown session or missing store", () => {
    expect([...sessionNoteKeys("ghost", { workspaceId: "ws1", storePath: "/nope.jsonl", nowMs: 0 }).keys]).toEqual([]);
  });
});

describe("candidateInSession", () => {
  const keys = new Set(["20260607-a.md"]);
  it("matches when the SOURCE is a session doc", () => {
    expect(candidateInSession(cand({ sourceArtifactId: "note:20260607-a.md", targetArtifactId: "note:other.md" }), keys)).toBe(true);
  });
  it("matches when the TARGET is a session doc", () => {
    expect(candidateInSession(cand({ sourceArtifactId: "note:other.md", targetArtifactId: "note:20260607-a.md" }), keys)).toBe(true);
  });
  it("does not match when neither endpoint is a session doc", () => {
    expect(candidateInSession(cand({ sourceArtifactId: "note:x.md", targetArtifactId: "note:y.md" }), keys)).toBe(false);
  });
  it("ignores non-note artifacts (jira:)", () => {
    expect(candidateInSession(cand({ sourceArtifactId: "jira:PDM-9", targetArtifactId: null }), keys)).toBe(false);
  });
});

describe("loadSessionScope", () => {
  it("resolves the sid then loads its workspace-scoped keys", () => {
    const store = writeStore([
      rec({ sessionId: "S", kind: "produced_doc", canonicalPath: "notes/a.md", createdAt: "2026-06-07T00:00:00.000Z" }),
    ]);
    const r = loadSessionScope("S", { env: {}, storePath: store, workspaceId: "ws1", nowMs: Date.parse("2026-06-07T01:00:00.000Z") });
    expect(r).toEqual({ sessionId: "S", source: "explicit", keys: new Set(["a.md"]) });
  });
});
