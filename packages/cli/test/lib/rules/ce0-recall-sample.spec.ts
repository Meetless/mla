import {
  DEFAULT_RECALL_SAMPLE_RATE,
  isInRecallSample,
} from "../../../src/lib/rules/ce0-recall-sample";

// R3 P0.9 / R4 P0.2 (proposal lines 1010-1019, 2129): the durable store stamps EVERY classified turn
// with a uniform `samplingBucket` (sha256 over the turn's natural key) and bakes in NO cardinality. The
// OFFLINE ce0-export decides the recall sampling RATE by THRESHOLDING that bucket. `isInRecallSample` is
// that threshold: it reads the first 32 bits of the digest as a uniform fraction in [0, 1) and samples
// the turn iff that fraction is below the rate. Deterministic and pure, so a grader reconstructs sample
// membership from the turn alone.
//
// The pinned DEFAULT is 1.0 (sample every unflagged turn). At dogfood / measurement-harness scale the
// recall gate needs >= 100 sampled NOT_REQUIRED/UNKNOWN turns to be observable at all (proposal line
// 2129; line 2145: recall unmeasurable -> do not authorize CE1); sampling DOWN from that would starve
// the gate. The threshold machinery exists so the rate can be dialed below 1.0 once a real pilot's
// volume forces a grader-load bound; the default measures everything until then.

describe("isInRecallSample: the offline recall-sampling threshold (R4 P0.2)", () => {
  // Crafted 64-char digests whose leading 32 bits pin a known fraction, so the assertions are crisp.
  const ZERO = "00000000".padEnd(64, "0"); // fraction 0.0
  const HALF = "80000000".padEnd(64, "0"); // 0x80000000 / 2^32 = exactly 0.5
  const NEAR_ONE = "ffffffff".padEnd(64, "f"); // fraction ~0.99999999977 (largest 32-bit prefix)

  it("pins the default rate to 1.0: measure every unflagged turn at dogfood scale", () => {
    expect(DEFAULT_RECALL_SAMPLE_RATE).toBe(1);
  });

  it("rate 1.0 samples every turn regardless of bucket", () => {
    expect(isInRecallSample(ZERO, 1)).toBe(true);
    expect(isInRecallSample(HALF, 1)).toBe(true);
    expect(isInRecallSample(NEAR_ONE, 1)).toBe(true);
  });

  it("rate 0 samples no turn regardless of bucket", () => {
    expect(isInRecallSample(ZERO, 0)).toBe(false);
    expect(isInRecallSample(HALF, 0)).toBe(false);
    expect(isInRecallSample(NEAR_ONE, 0)).toBe(false);
  });

  it("thresholds the leading-32-bit fraction: in-sample iff fraction < rate", () => {
    // HALF sits at exactly 0.5: excluded at rate 0.5 (strict <), included just above, excluded just below.
    expect(isInRecallSample(HALF, 0.5)).toBe(false);
    expect(isInRecallSample(HALF, 0.6)).toBe(true);
    expect(isInRecallSample(HALF, 0.4)).toBe(false);
    // ZERO is the floor: in-sample for any positive rate.
    expect(isInRecallSample(ZERO, 0.0001)).toBe(true);
    // NEAR_ONE is the ceiling: out for any rate below ~1.
    expect(isInRecallSample(NEAR_ONE, 0.99)).toBe(false);
  });

  it("is monotonic in rate: a turn sampled at rate r stays sampled at any higher rate", () => {
    // HALF enters the sample at rate > 0.5; once in, widening the rate never drops it.
    expect(isInRecallSample(HALF, 0.51)).toBe(true);
    expect(isInRecallSample(HALF, 0.75)).toBe(true);
    expect(isInRecallSample(HALF, 1)).toBe(true);
  });

  it("is deterministic and pure: same inputs always yield the same verdict", () => {
    expect(isInRecallSample(HALF, 0.7)).toBe(isInRecallSample(HALF, 0.7));
  });

  it("never samples a malformed bucket (defensive; the real producer always emits a 64-char digest)", () => {
    expect(isInRecallSample("", 1)).toBe(false);
    expect(isInRecallSample("zzzz", 1)).toBe(false);
  });
});
