import { buildPendingCandidateQuery } from "../../src/lib/relationship-candidate-query";

describe("buildPendingCandidateQuery", () => {
  it("pins the review view to PENDING_REVIEW across BOTH postures (includeShadow) and the limit", () => {
    const p = new URLSearchParams(buildPendingCandidateQuery("ws1", null, 200));
    expect(p.get("workspaceId")).toEqual("ws1");
    expect(p.get("statusId")).toEqual("PENDING_REVIEW");
    // The D1-resolution + semantic detectors mint candidates at SHADOW +
    // PENDING_REVIEW; those SHADOW rows ARE the human-review workload. A
    // posture=LIVE filter hid the entire SHADOW queue (mla graph/kb review showed
    // nothing while the Console inbox showed them). No `posture` + includeShadow=true
    // returns both postures, mirroring apps/console/app/review/load-inbox.ts.
    expect(p.has("posture")).toBe(false);
    expect(p.get("includeShadow")).toEqual("true");
    expect(p.get("limit")).toEqual("200");
    expect(p.has("cursorId")).toBe(false);
  });

  it("routes a qualified doc to artifactId and a bare doc to notePath", () => {
    expect(new URLSearchParams(buildPendingCandidateQuery("ws1", "note:foo.md", 200)).get("artifactId")).toEqual("note:foo.md");
    const bare = new URLSearchParams(buildPendingCandidateQuery("ws1", "foo.md", 200));
    expect(bare.get("notePath")).toEqual("foo.md");
    expect(bare.has("artifactId")).toBe(false);
  });

  it("appends cursorId + cursorCreatedAt when a cursor is given", () => {
    const p = new URLSearchParams(buildPendingCandidateQuery("ws1", null, 200, { id: "c9", createdAt: "2026-06-07T00:00:00.000Z" }));
    expect(p.get("cursorId")).toEqual("c9");
    expect(p.get("cursorCreatedAt")).toEqual("2026-06-07T00:00:00.000Z");
  });
});
