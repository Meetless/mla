import { classifyIngestIntent } from "../../src/lib/active-memory";

// Explicit-intent boundary (spec tests 17, 29 / INV-NO-TIER1-KB-WRITE).
//
// Only an explicit "ingest into KB" request promotes a record into the Personal
// KB. Everything else (including "remember this for now") stays Active-only and
// never creates a KB document. Ambiguous prose defaults to active_only: ambiguity
// must never auto-ingest, so the boundary is default-deny.
describe("explicit-intent boundary (test 29)", () => {
  it("'remember this for now' creates no KB doc", () => {
    expect(classifyIngestIntent("remember this for now")).toBe("active_only");
  });
  it("'ingest this into KB' creates a doc", () => {
    expect(classifyIngestIntent("ingest this into KB")).toBe("kb_ingest");
  });
  it("ambiguous prose is active_only (never auto-ingest)", () => {
    expect(classifyIngestIntent("here is a note about the API")).toBe("active_only");
  });
});
