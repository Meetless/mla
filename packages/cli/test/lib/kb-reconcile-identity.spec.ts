import { forgetRefFor, isAlreadyGone } from "../../src/commands/kb_reconcile";

// THE BUG THIS PINS. The first live run of `kb reconcile --apply` withdrew 0 of 52 documents and
// failed all 52 with:
//
//   HTTP 404 KB_DOCUMENT_NOT_FOUND: no KbDocument matches 'bec1e982-b332-4729-93b0-ab9129b3e3dc'
//
// The planner was right about every one of those 52; the caller simply handed `kb/forget` a bare
// UUID. That route resolves `ref` as a PREFIXED identity (`kbdoc:<id>`), so an unprefixed UUID
// matches nothing and 404s. The failure was total and therefore harmless, but a partial version of
// the same mistake is the dangerous shape, so the prefix is pinned here rather than left to a
// string concatenation at the call site.

describe("forgetRefFor: kb/forget resolves a PREFIXED identity, never a bare uuid", () => {
  it("prefixes the document id with kbdoc:", () => {
    expect(forgetRefFor({
      documentId: "bec1e982-b332-4729-93b0-ab9129b3e3dc",
      externalObjectId: "notes/note-05.md",
      sourceSystem: "notes",
      tombstoneState: "ACTIVE",
    })).toBe("kbdoc:bec1e982-b332-4729-93b0-ab9129b3e3dc");
  });

  it("does not double-prefix an id that already carries one", () => {
    expect(forgetRefFor({
      documentId: "kbdoc:abc",
      externalObjectId: "notes/x.md",
      sourceSystem: "notes",
      tombstoneState: "ACTIVE",
    })).toBe("kbdoc:abc");
  });
});

describe("isAlreadyGone: reconciliation is idempotent, so 'nothing to do' is not a failure", () => {
  // `kb forget` is a user command: it 404s an unknown doc and 409s a PURGED one, and surfacing
  // those as errors is right for a human who named one document. A reconciliation names a set it
  // derived from a scan, and a document that vanished between listing and forgetting has simply
  // reached the state the reconciliation wanted. Counting that as a failure would make a clean run
  // look broken and would mask the failures that matter.
  it("treats KB_DOCUMENT_NOT_FOUND as done", () => {
    expect(isAlreadyGone(new Error('HTTP 404: {"detail":{"code":"KB_DOCUMENT_NOT_FOUND"}}'))).toBe(true);
  });

  it("treats a PURGED terminal state as done", () => {
    expect(isAlreadyGone(new Error('HTTP 409: {"detail":{"message":"kbdoc:x is PURGED (terminal); nothing to forget."}}'))).toBe(true);
  });

  it("does NOT swallow a real server fault", () => {
    expect(isAlreadyGone(new Error("HTTP 500: internal error"))).toBe(false);
  });

  it("does NOT swallow an auth failure", () => {
    expect(isAlreadyGone(new Error("HTTP 403: forbidden"))).toBe(false);
  });
});
