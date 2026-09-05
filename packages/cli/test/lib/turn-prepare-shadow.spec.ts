import {
  compareTurnDecisions,
  compareRuleVersions,
  formatTurnPrepareShadow,
  runTurnPrepareShadow,
  type LegacyTurnDecision,
} from "../../src/lib/turn-prepare-shadow";

const legacy = (over: Partial<LegacyTurnDecision> = {}): LegacyTurnDecision => ({
  floorMust: [],
  scopedRequired: [],
  bestEffort: [],
  warnings: [],
  ...over,
});

const canonical = (over: Record<string, unknown> = {}) => ({
  context: { floorMust: [], scopedRequired: [], bestEffort: [], floorShould: [], ...over },
  warnings: [],
});

describe("compareTurnDecisions", () => {
  it("calls a matching floor set the same, per rule id", () => {
    const cmp = compareTurnDecisions(
      legacy({ floorMust: ["f2", "f1"] }),
      canonical({ floorMust: [{ ruleId: "f1" }, { ruleId: "f2" }] }),
    );
    expect(cmp.floorMust).toMatchObject({ same: true, overlap: 2, legacy: 2, canonical: 2 });
    expect(cmp.floorMust?.onlyLegacy).toEqual([]);
  });

  it("names the divergence per dimension: legacy-only and canonical-only rule ids", () => {
    const cmp = compareTurnDecisions(
      legacy({ scopedRequired: ["local_file_rule", "gov_a"] }),
      canonical({ scopedRequired: [{ ruleId: "gov_a" }, { ruleId: "gov_b" }] }),
    );
    expect(cmp.scopedRequired?.same).toBe(false);
    expect(cmp.scopedRequired?.overlap).toBe(1);
    // A local-file rule the server bundle does not carry surfaces as legacy-only, which the
    // analysis reads as an explainable input difference, not a regression.
    expect(cmp.scopedRequired?.onlyLegacy).toEqual(["local_file_rule"]);
    expect(cmp.scopedRequired?.onlyCanonical).toEqual(["gov_b"]);
  });

  it("compares warnings by path", () => {
    const cmp = compareTurnDecisions(
      legacy({ warnings: ["CLAUDE.md"] }),
      { context: {}, warnings: [{ path: "CLAUDE.md" }] },
    );
    expect(cmp.warnings?.same).toBe(true);
  });

  it("treats empty sets as agreement (the common floor-only turn)", () => {
    const cmp = compareTurnDecisions(legacy(), canonical());
    expect(cmp.floorMust?.same).toBe(true);
    expect(cmp.scopedRequired?.same).toBe(true);
  });

  it("does not choke on a malformed canonical body", () => {
    expect(compareTurnDecisions(legacy({ floorMust: ["f1"] }), null).floorMust?.canonical).toBe(0);
    expect(compareTurnDecisions(legacy(), { context: "nope" }).floorMust?.same).toBe(true);
  });
});

describe("runTurnPrepareShadow never affects the (already-delivered) injection", () => {
  const opts = { legacy: legacy(), task: "t", sessionId: "s" };

  it("does nothing when disabled", async () => {
    const cmp = await runTurnPrepareShadow({ ...opts, enabled: false, platformUrl: "http://127.0.0.1:3020", accessToken: "t" });
    expect(cmp).toEqual({ ran: false, skipped: "disabled" });
  });

  it("SKIPS on a shared-key CLI (no user token)", async () => {
    const cmp = await runTurnPrepareShadow({ ...opts, enabled: true, platformUrl: "http://127.0.0.1:3020", accessToken: undefined });
    expect(cmp.ran).toBe(false);
    expect(cmp.skipped).toMatch(/shared-key/);
  });

  it("SKIPS when no platform URL is configured", async () => {
    const cmp = await runTurnPrepareShadow({ ...opts, enabled: true, platformUrl: undefined, accessToken: "t" });
    expect(cmp.skipped).toMatch(/MEETLESS_PLATFORM_URL/);
  });

  it("swallows an unreachable tier: a shadow must never disturb the turn", async () => {
    const cmp = await runTurnPrepareShadow({ ...opts, enabled: true, platformUrl: "http://127.0.0.1:9", accessToken: "t" });
    expect(cmp.ran).toBe(false);
    expect(cmp.error ?? cmp.skipped).toBeTruthy();
  });
});

describe("order (sequence) comparison for the required tiers", () => {
  it("same set but different order -> orderFloorMust false (isolates a pure ordering difference)", () => {
    const cmp = compareTurnDecisions(
      legacy({ floorMust: ["f2", "f1"] }),
      canonical({ floorMust: [{ ruleId: "f1" }, { ruleId: "f2" }] }),
    );
    expect(cmp.floorMust?.same).toBe(true); // the SET agrees
    expect(cmp.orderFloorMust).toBe(false); // the ORDER does not
  });

  it("same set and same order -> orderScopedRequired true", () => {
    const cmp = compareTurnDecisions(
      legacy({ scopedRequired: ["s1", "s2"] }),
      canonical({ scopedRequired: [{ ruleId: "s1" }, { ruleId: "s2" }] }),
    );
    expect(cmp.scopedRequired?.same).toBe(true);
    expect(cmp.orderScopedRequired).toBe(true);
  });

  it("emits an order[...] token before the excluded end anchor", () => {
    const line = formatTurnPrepareShadow(
      compareTurnDecisions(legacy({ floorMust: ["f1"] }), canonical({ floorMust: [{ ruleId: "f1" }] })),
    );
    expect(line).toContain("order[floor_must=true scoped_required=true]");
    expect(line).toContain("excluded=not_comparable");
  });
});

describe("formatTurnPrepareShadow", () => {
  it("is one greppable line, per-dimension, and marks excluded not_comparable", () => {
    const line = formatTurnPrepareShadow(
      compareTurnDecisions(legacy({ floorMust: ["f1"] }), canonical({ floorMust: [{ ruleId: "f1" }] })),
    );
    expect(line).toContain("e1_shadow");
    expect(line).toContain("floor_must[same=true overlap=1 L=1 C=1]");
    expect(line).toContain("excluded=not_comparable");
  });

  it("names the divergent ids so the log is actionable", () => {
    const line = formatTurnPrepareShadow(
      compareTurnDecisions(legacy({ scopedRequired: ["only_l"] }), canonical({ scopedRequired: [{ ruleId: "only_c" }] })),
    );
    expect(line).toContain("only_L=[only_l]");
    expect(line).toContain("only_C=[only_c]");
  });

  it("reports a skip as a skip", () => {
    expect(formatTurnPrepareShadow({ ran: false, skipped: "disabled" })).toBe("e1_shadow skipped=disabled");
  });
});

// Step 1 of the cutover gate: the rule-VERSION identity comparison. Matching rule ids/order can
// hide a different rule version/content; this proves the comparator catches that using the
// versionId both sides already carry. Not wired into per-turn telemetry.
describe("compareRuleVersions", () => {
  it("flags a rule selected by both paths at a DIFFERENT version (same id, drifted content)", () => {
    const cmp = compareRuleVersions(
      { r1: "v1" },
      canonical({ floorMust: [{ ruleId: "r1", versionId: "v2" }] }),
    );
    expect(cmp.comparedRuleIds).toBe(1);
    expect(cmp.mismatches).toEqual([{ ruleId: "r1", legacyVersionId: "v1", canonicalVersionId: "v2" }]);
  });

  it("is clean when the shared rules carry the SAME version on both sides", () => {
    const cmp = compareRuleVersions(
      { r1: "v1", r2: "v9" },
      canonical({ floorMust: [{ ruleId: "r1", versionId: "v1" }], scopedRequired: [{ ruleId: "r2", versionId: "v9" }] }),
    );
    expect(cmp.mismatches).toEqual([]);
    expect(cmp.comparedRuleIds).toBe(2);
  });

  it("ignores a rule present on only one side (that is an id-set diff, not a version diff)", () => {
    const cmp = compareRuleVersions(
      { onlyLegacy: "v1" },
      canonical({ floorMust: [{ ruleId: "onlyCanonical", versionId: "v1" }] }),
    );
    expect(cmp.comparedRuleIds).toBe(0);
    expect(cmp.mismatches).toEqual([]);
  });

  it("compares across BOTH required tiers, not just the floor", () => {
    const cmp = compareRuleVersions(
      { scoped1: "v1" },
      canonical({ scopedRequired: [{ ruleId: "scoped1", versionId: "v2" }] }),
    );
    expect(cmp.mismatches.map((m) => m.ruleId)).toEqual(["scoped1"]);
  });
});
