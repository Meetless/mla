import { cascadeRejectForDoc, CascadeDeps, CascadeResult } from "../../src/commands/kb_forget";
import type { RelationshipCandidate } from "../../src/lib/kb-candidate";

function cand(id: string, over: Partial<RelationshipCandidate> = {}): RelationshipCandidate {
  return {
    id, workspaceId: "ws1", relationTypeId: "SUPERSEDES", statusId: "PENDING_REVIEW",
    postureId: "LIVE", sourceType: "note", sourceArtifactId: "note:a.md", targetType: "note",
    targetArtifactId: "note:b.md", confidence: 0.9, detectorFamily: "semantic.m3b",
    evidenceJson: null, createdAt: "2026-06-07T00:00:00.000Z", ...over,
  } as RelationshipCandidate;
}

describe("cascadeRejectForDoc", () => {
  const ctx = { workspaceId: "ws1", actorUserId: "u1" };

  it("rejects each PENDING candidate for the doc and reports counts", async () => {
    const rejected: string[] = [];
    const deps: CascadeDeps = {
      fetchPending: async () => ({ items: [cand("x"), cand("y")], nextCursor: null }),
      submitReject: async (id) => { rejected.push(id); },
    };
    const r: CascadeResult = await cascadeRejectForDoc("notes/a.md", ctx, deps);
    expect(r).toEqual({ fetched: 2, rejected: 2, failed: 0, fetchFailed: false });
    expect(rejected.sort()).toEqual(["x", "y"]);
  });

  it("returns zeros and makes no reject calls when there are none", async () => {
    let called = false;
    const r = await cascadeRejectForDoc("notes/a.md", ctx, {
      fetchPending: async () => ({ items: [], nextCursor: null }),
      submitReject: async () => { called = true; },
    });
    expect(r).toEqual({ fetched: 0, rejected: 0, failed: 0, fetchFailed: false });
    expect(called).toBe(false);
  });

  it("counts per-candidate failures without throwing", async () => {
    const r = await cascadeRejectForDoc("notes/a.md", ctx, {
      fetchPending: async () => ({ items: [cand("x"), cand("y")], nextCursor: null }),
      submitReject: async (id) => { if (id === "y") throw new Error("boom"); },
    });
    expect(r).toEqual({ fetched: 2, rejected: 1, failed: 1, fetchFailed: false });
  });

  it("flags a fetch failure", async () => {
    const r = await cascadeRejectForDoc("notes/a.md", ctx, {
      fetchPending: async () => { throw new Error("net"); },
      submitReject: async () => {},
    });
    expect(r).toEqual({ fetched: 0, rejected: 0, failed: 0, fetchFailed: true });
  });
});
