import {
  summarizeShadowLog,
  formatShadowSummary,
  formatTurnPrepareShadow,
  compareTurnDecisions,
  type LegacyTurnDecision,
} from "../../src/lib/turn-prepare-shadow";

// Build real log lines through the PRODUCER so the parser is pinned to the actual format, not a
// hand-typed guess. If formatTurnPrepareShadow changes, these lines change, and the parser must too.
function line(legacy: LegacyTurnDecision, canonical: unknown): string {
  return formatTurnPrepareShadow({ ...compareTurnDecisions(legacy, canonical), status: 200 });
}
const ctx = (o: Record<string, { ruleId: string }[]>) => ({ context: o, warnings: [] });

describe("summarizeShadowLog counts comparable turns and per-dimension agreement", () => {
  it("agrees when both paths select the same id set, disagrees and records the ids otherwise", () => {
    const agreeLine = line(
      { floorMust: ["a", "b"], scopedRequired: ["s1"], bestEffort: [], warnings: [] },
      ctx({ floorMust: [{ ruleId: "a" }, { ruleId: "b" }], scopedRequired: [{ ruleId: "s1" }], bestEffort: [] }),
    );
    // legacy-only 'localrule' in floor, canonical-only 'newgov' in scoped.
    const diffLine = line(
      { floorMust: ["a", "localrule"], scopedRequired: [], bestEffort: [], warnings: [] },
      ctx({ floorMust: [{ ruleId: "a" }], scopedRequired: [{ ruleId: "newgov" }], bestEffort: [] }),
    );
    const s = summarizeShadowLog([agreeLine, diffLine, "unrelated noise line", ""]);

    expect(s.comparable).toBe(2);
    expect(s.agree.floor_must).toBe(1); // only agreeLine agreed on floor
    expect(s.agree.scoped_required).toBe(1); // agreeLine agreed (s1==s1); diffLine did not ([] vs [newgov])
    expect(s.agree.best_effort).toBe(2);
    expect(s.agree.warnings).toBe(2);
    expect(s.onlyLegacy).toEqual({ localrule: 1 });
    expect(s.onlyCanonical).toEqual({ newgov: 1 });
    expect(s.malformed).toBe(0);
  });

  it("groups skips/failures by reason and ignores non-e1_shadow lines", () => {
    const s = summarizeShadowLog([
      "e1_shadow skipped=disabled",
      "e1_shadow skipped=canonical HTTP 404",
      "e1_shadow skipped=canonical HTTP 404",
      "e1_shadow skipped=no user token (shared-key CLI)",
      "e1_shadow skipped=error error=boom",
      "some other log line",
    ]);
    expect(s.comparable).toBe(0);
    expect(s.skips).toEqual({
      disabled: 1,
      "canonical HTTP 404": 2,
      "no user token (shared-key CLI)": 1,
      error: 1,
    });
  });

  it("tallies a distinct only_L id seen across multiple turns", () => {
    const l = line(
      { floorMust: ["keep", "localrule"], scopedRequired: [], bestEffort: [], warnings: [] },
      ctx({ floorMust: [{ ruleId: "keep" }], scopedRequired: [], bestEffort: [] }),
    );
    const s = summarizeShadowLog([l, l, l]);
    expect(s.onlyLegacy).toEqual({ localrule: 3 });
    expect(s.comparable).toBe(3);
  });

  it("flags a malformed e1_shadow comparison line rather than miscounting it", () => {
    const s = summarizeShadowLog(["e1_shadow floor_must[same=true overlap=1 L=1 C=1] truncated"]);
    expect(s.comparable).toBe(0);
    expect(s.malformed).toBe(1);
  });
});

describe("formatShadowSummary is descriptive and sets no threshold", () => {
  it("renders counts, skips, and both id blocks without any pass/fail verdict", () => {
    const diffLine = line(
      { floorMust: ["a", "localrule"], scopedRequired: [], bestEffort: [], warnings: [] },
      ctx({ floorMust: [{ ruleId: "a" }], scopedRequired: [{ ruleId: "newgov" }], bestEffort: [] }),
    );
    const out = formatShadowSummary(summarizeShadowLog([diffLine, "e1_shadow skipped=disabled"]), "/tmp/e1-shadow.log");
    expect(out).toContain("comparable turns: 1");
    expect(out).toContain("floor_must");
    expect(out).toContain("localrule: 1");
    expect(out).toContain("newgov: 1");
    expect(out).toContain("disabled: 1");
    // Descriptive only: no gate/verdict vocabulary. (The word "failures" in the skips heading is
    // descriptive, not a verdict, so the guard is word-bounded to real judgement terms.)
    expect(out).not.toMatch(/\b(passed|failed|threshold|cutover|verdict|ready)\b/i);
  });
});
