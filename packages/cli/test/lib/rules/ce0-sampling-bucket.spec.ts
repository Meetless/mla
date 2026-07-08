import { samplingBucketFor } from "../../../src/lib/rules/ce0-sampling-bucket";

// R3 P0.9 (proposal line 280): every classified turn carries a DETERMINISTIC sampling bucket so the
// offline unflagged-recall sample (ce0-export, line 997) is RECONSTRUCTIBLE from the turn's logical
// coordinates; the runtime never makes a random draw. The bucket is derived from the assessment's
// natural identity key (workspace, session, sequence), not the random assessmentId, so a grader can
// recompute sample membership from the turn alone. The durable store bakes in no sampling rate: the
// bucket is a uniform label and the OFFLINE export thresholds it to pick the rate.

describe("samplingBucketFor: deterministic unflagged-recall bucket (R3 P0.9)", () => {
  const key = { workspaceId: "ws_a", sessionId: "sess_1", localTurnSequence: 7 };

  it("is deterministic: the same turn coordinate always yields the same bucket", () => {
    expect(samplingBucketFor(key)).toBe(samplingBucketFor({ ...key }));
  });

  it("is reconstructible from the logical coordinate alone (no random id input)", () => {
    const recomputed = samplingBucketFor({
      workspaceId: "ws_a",
      sessionId: "sess_1",
      localTurnSequence: 7,
    });
    expect(recomputed).toBe(samplingBucketFor(key));
  });

  it("separates turns: each coordinate (workspace, session, sequence) changes the bucket", () => {
    const base = samplingBucketFor(key);
    expect(samplingBucketFor({ ...key, workspaceId: "ws_b" })).not.toBe(base);
    expect(samplingBucketFor({ ...key, sessionId: "sess_2" })).not.toBe(base);
    expect(samplingBucketFor({ ...key, localTurnSequence: 8 })).not.toBe(base);
  });

  it("returns a non-empty lowercase hex string (uniform, threshold-comparable offline)", () => {
    expect(samplingBucketFor(key)).toMatch(/^[0-9a-f]+$/);
  });
});
