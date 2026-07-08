// Coverage-gap classification (spec §7.5, INV-COVERAGE-GAP-1; T7.1). A pure,
// I/O-free classifier, so the inject command and this test run the identical
// code. The cases pin the precedence (most-specific cause first) so a single
// inject is attributed to exactly one type even when several signals are set.

import {
  CoverageGapSignals,
  buildCoverageGapPayload,
  classifyCoverageGap,
  coerceRetrievalConfidence,
  coerceTopicCategory,
  coverageGapEventId,
  coverageGapNotUsedEventId,
} from "../../src/lib/analytics/coverage-gap";
import { COVERAGE_GAP_TYPES } from "../../src/lib/analytics/envelope";

const signals = (over: Partial<CoverageGapSignals> = {}): CoverageGapSignals => ({
  zeroResults: false,
  retrievalConfidence: "high",
  ...over,
});

describe("classifyCoverageGap", () => {
  it("returns null for a confident, non-empty retrieval (no gap)", () => {
    expect(classifyCoverageGap(signals())).toBeNull();
    expect(classifyCoverageGap(signals({ retrievalConfidence: "medium" }))).toBeNull();
  });

  it("classifies no_candidate_found on zero results", () => {
    expect(classifyCoverageGap(signals({ zeroResults: true }))).toBe("no_candidate_found");
  });

  it("classifies low_confidence_candidates when confidence is low and candidates exist", () => {
    expect(classifyCoverageGap(signals({ retrievalConfidence: "low" }))).toBe(
      "low_confidence_candidates",
    );
  });

  it("classifies stale_or_conflicting_candidates", () => {
    expect(classifyCoverageGap(signals({ staleOrConflicting: true }))).toBe(
      "stale_or_conflicting_candidates",
    );
  });

  it("classifies permission_filtered", () => {
    expect(classifyCoverageGap(signals({ permissionFiltered: true }))).toBe(
      "permission_filtered",
    );
  });

  it("classifies retrieval_error", () => {
    expect(classifyCoverageGap(signals({ retrievalError: true }))).toBe("retrieval_error");
  });

  // Precedence: most-specific cause wins when several signals are set at once.
  it("prefers retrieval_error over every other signal", () => {
    expect(
      classifyCoverageGap(
        signals({
          retrievalError: true,
          permissionFiltered: true,
          zeroResults: true,
          staleOrConflicting: true,
          retrievalConfidence: "low",
        }),
      ),
    ).toBe("retrieval_error");
  });

  it("prefers permission_filtered over no_candidate_found", () => {
    expect(
      classifyCoverageGap(signals({ permissionFiltered: true, zeroResults: true })),
    ).toBe("permission_filtered");
  });

  it("prefers no_candidate_found over stale and low_confidence", () => {
    expect(
      classifyCoverageGap(
        signals({ zeroResults: true, staleOrConflicting: true, retrievalConfidence: "low" }),
      ),
    ).toBe("no_candidate_found");
  });

  it("prefers stale_or_conflicting over low_confidence", () => {
    expect(
      classifyCoverageGap(signals({ staleOrConflicting: true, retrievalConfidence: "low" })),
    ).toBe("stale_or_conflicting_candidates");
  });

  it("never returns the outcome-time type candidates_found_not_used", () => {
    // Exhaust the inject-time signal space; the outcome-time type is owned by the
    // correlator and must never come out of the inject-time classifier.
    const confidences: CoverageGapSignals["retrievalConfidence"][] = ["high", "medium", "low"];
    const bools = [false, true];
    for (const retrievalError of bools)
      for (const permissionFiltered of bools)
        for (const zeroResults of bools)
          for (const staleOrConflicting of bools)
            for (const retrievalConfidence of confidences) {
              const got = classifyCoverageGap({
                retrievalError,
                permissionFiltered,
                zeroResults,
                staleOrConflicting,
                retrievalConfidence,
              });
              expect(got).not.toBe("candidates_found_not_used");
              if (got !== null) expect(COVERAGE_GAP_TYPES).toContain(got);
            }
  });
});

describe("coerceTopicCategory", () => {
  it("passes through a valid closed-enum category", () => {
    expect(coerceTopicCategory("api_contract")).toBe("api_contract");
    expect(coerceTopicCategory("security")).toBe("security");
  });

  it("defaults unknown/empty/raw strings to unknown (no raw string leaks)", () => {
    expect(coerceTopicCategory(null)).toBe("unknown");
    expect(coerceTopicCategory(undefined)).toBe("unknown");
    expect(coerceTopicCategory("")).toBe("unknown");
    expect(coerceTopicCategory("stripe webhook idempotency bug")).toBe("unknown");
  });
});

describe("coerceRetrievalConfidence", () => {
  it("passes through a valid confidence", () => {
    expect(coerceRetrievalConfidence("high")).toBe("high");
    expect(coerceRetrievalConfidence("medium")).toBe("medium");
    expect(coerceRetrievalConfidence("low")).toBe("low");
  });

  it("defaults anything unknown to low (never inflate the dashboard)", () => {
    expect(coerceRetrievalConfidence(null)).toBe("low");
    expect(coerceRetrievalConfidence("definitely")).toBe("low");
  });
});

describe("coverage-gap event ids", () => {
  it("are deterministic and distinct between inject-time and outcome-time", () => {
    const a = coverageGapEventId("inj_1");
    const b = coverageGapNotUsedEventId("inj_1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b); // distinct business-key prefixes never collide
    // Deterministic: same inject id -> same id.
    expect(coverageGapEventId("inj_1")).toBe(a);
    expect(coverageGapNotUsedEventId("inj_1")).toBe(b);
    // Distinct injects -> distinct ids.
    expect(coverageGapEventId("inj_2")).not.toBe(a);
  });
});

describe("buildCoverageGapPayload", () => {
  it("builds the typed, PII-bounded payload (ids/enums/booleans only)", () => {
    const p = buildCoverageGapPayload({
      injectId: "inj_1",
      coverageGapType: "no_candidate_found",
      queryTopicCategory: "api_contract",
      retrievalConfidence: "low",
      zeroResults: true,
    });
    expect(p).toEqual({
      inject_id: "inj_1",
      coverage_gap_type: "no_candidate_found",
      query_topic_category: "api_contract",
      retrieval_confidence: "low",
      zero_results: true,
    });
  });
});
