import { supersessionAdvisory, KbRelationFact } from "../../src/lib/tagged-reference";

describe("tagged-reference supersession (test 12)", () => {
  it("references old.md, KB has old SUPERSEDED_BY new -> advisory cites new and flags old superseded", () => {
    const facts: KbRelationFact[] = [{ fromPath: "old.md", relationType: "SUPERSEDED_BY", toPath: "new.md", toKbId: "DD:new", posture: "LIVE", status: "ACCEPTED" }];
    const out = supersessionAdvisory(["old.md"], facts);
    expect(out).toHaveLength(1);
    expect(out[0].citedKbId).toBe("DD:new");
    expect(out[0].message).toContain("old.md");
    expect(out[0].message).toContain("superseded");
  });
  it("no matching fact -> no advisory", () => {
    expect(supersessionAdvisory(["unrelated.md"], [])).toHaveLength(0);
  });
  it("ignores non-LIVE/non-accepted supersession facts (no leak of unapproved state)", () => {
    const facts: KbRelationFact[] = [{ fromPath: "old.md", relationType: "SUPERSEDED_BY", toPath: "new.md", toKbId: "DD:new", posture: "SHADOW", status: "PENDING_REVIEW" }];
    expect(supersessionAdvisory(["old.md"], facts)).toHaveLength(0);
  });
});
