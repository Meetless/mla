import { runActiveReview } from "../../src/lib/active-review-runner";
import { ActiveMemoryRecord } from "../../src/lib/active-memory";

const rec = (p: Partial<ActiveMemoryRecord>): ActiveMemoryRecord => ({
  ts: "2026-06-04T00:00:00Z", event: "active_memory_record", workspaceId: "ws_1", ownerUserId: "user_a",
  repoRootHash: "repoA", canonicalPath: "notes/x.md", contentHash: "h1", sessionId: "sess_1", turnIndex: 1,
  sourceProduct: "claude_code", kind: "produced_doc", createdAt: "2026-06-04T00:00:00Z", ...p,
});

describe("active-review-runner", () => {
  it("emits an advisory when intel returns a contradiction, persisting nothing", async () => {
    const calls: any[] = [];
    const intel = {
      detect: async (req: any) => {
        calls.push(req);
        return { detections: [{ relationType: "CONTRADICTS", citedKbId: "DD:7", confidence: 0.8, citedQuote: "q", candidatePath: "notes/x.md", posture: "LIVE", status: "ACCEPTED" }], persisted: false };
      },
    };
    const out = await runActiveReview({ records: [rec({})], intel: intel as any, minConfidence: 0.6 });
    expect(out.advisories).toHaveLength(1);
    expect(out.advisories[0].citedKbId).toBe("DD:7");
    expect(calls[0].dryRun).toBe(true);
  });
  it("intel failure is swallowed (advise-never-block, P6): returns empty, no throw", async () => {
    const intel = { detect: async () => { throw new Error("intel down"); } };
    const out = await runActiveReview({ records: [rec({})], intel: intel as any, minConfidence: 0.6 });
    expect(out.advisories).toHaveLength(0);
    expect(out.degraded).toBe(true);
  });
});
