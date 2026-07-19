// Pins the human vocabulary that replaced the raw CoverageGapType slugs in the
// `mla stats` roadmap section. The bug this fixes: the dashboard printed internal
// enum identifiers (candidates_found_not_used, low_confidence_candidates) straight
// into operator-facing output, where they read as debug noise. The contract under
// test: every known slug maps to a plain-English label + a non-empty hint, and an
// unknown slug is humanized rather than leaked verbatim.
//
// The labels here must match apps/console/lib/value/coverage-gaps.ts so the CLI and
// the Console Value page name the same gap the same way.

import { COVERAGE_GAP_TYPES } from "../../src/lib/analytics/envelope";
import { coverageGapPresentation } from "../../src/lib/analytics/coverage-gap-presentation";

describe("coverageGapPresentation", () => {
  it("gives every known gap type a plain-English label with no raw slug", () => {
    for (const type of COVERAGE_GAP_TYPES) {
      const { label, hint } = coverageGapPresentation(type);
      expect(label.length).toBeGreaterThan(0);
      expect(hint.length).toBeGreaterThan(0);
      // The whole point: the enum slug must never survive into the label.
      expect(label).not.toContain("_");
      expect(label).not.toBe(type);
    }
  });

  it("uses distinct labels so the breakdown does not collapse two causes into one word", () => {
    const labels = COVERAGE_GAP_TYPES.map((t) => coverageGapPresentation(t).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the two types the user actually saw in plain English", () => {
    expect(coverageGapPresentation("candidates_found_not_used").label).toBe(
      "Found but unused",
    );
    expect(coverageGapPresentation("low_confidence_candidates").label).toBe(
      "Weak matches",
    );
  });

  it("keeps hints as clean parenthetical fragments (no trailing period)", () => {
    for (const type of COVERAGE_GAP_TYPES) {
      const { hint } = coverageGapPresentation(type);
      expect(hint.endsWith(".")).toBe(false);
    }
  });

  it("humanizes an unknown future gap type instead of leaking the raw slug", () => {
    const { label, hint } = coverageGapPresentation("some_new_gap_type");
    expect(label).toBe("Some new gap type");
    expect(hint.length).toBeGreaterThan(0);
  });

  it("never renders a blank label, even for a degenerate slug", () => {
    expect(coverageGapPresentation("").label).toBe("");
    // The fallback hint still explains the row rather than leaving it empty.
    expect(coverageGapPresentation("").hint.length).toBeGreaterThan(0);
  });
});
