import { advisoriesFromDetections, Detection } from "../../src/lib/conflict-advisory";

const live = (relationType: string, citedKbId: string, confidence: number, extra: Partial<Detection> = {}): Detection => ({
  relationType, citedKbId, confidence,
  citedQuote: "approved: defer to Q4", candidatePath: "notes/x.md",
  posture: "LIVE", status: "ACCEPTED", ...extra,
});

describe("conflict-advisory", () => {
  it("silence by default (test 8): no conflict detections -> no advisory", () => {
    expect(advisoriesFromDetections([], { minConfidence: 0.6 })).toHaveLength(0);
  });
  it("related is not conflict (test 9): REFERENCES emits nothing", () => {
    expect(advisoriesFromDetections([live("REFERENCES", "DD:1", 0.9)], { minConfidence: 0.6 })).toHaveLength(0);
  });
  it("contradiction emits one advisory (test 10): multiple chunks of one doc collapse to one flag", () => {
    const out = advisoriesFromDetections(
      [live("CONTRADICTS", "DD:1", 0.8, { citedQuote: "chunk a" }), live("CONTRADICTS", "DD:1", 0.7, { citedQuote: "chunk b" })],
      { minConfidence: 0.6 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].citedKbId).toBe("DD:1");
  });
  it("below-threshold logs but emits no advisory (test 11)", () => {
    expect(advisoriesFromDetections([live("CONTRADICTS", "DD:1", 0.3)], { minConfidence: 0.6 })).toHaveLength(0);
  });
  it("pending private edge does not flag (test 35)", () => {
    const out = advisoriesFromDetections([live("CONTRADICTS", "DD:1", 0.9, { status: "PENDING_REVIEW", posture: "SHADOW" })], { minConfidence: 0.6 });
    expect(out).toHaveLength(0);
  });
  it("accepted private edge flags (test 36): an approved SHADOW conflict still surfaces to its owner", () => {
    const out = advisoriesFromDetections([live("CONTRADICTS", "DD:1", 0.9, { status: "ACCEPTED", posture: "SHADOW" })], { minConfidence: 0.6 });
    expect(out).toHaveLength(1);
    expect(out[0].citedKbId).toBe("DD:1");
  });
});
