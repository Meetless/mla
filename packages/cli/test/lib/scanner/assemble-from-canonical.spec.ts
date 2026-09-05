import {
  assembleContext,
  assembleFromCanonicalDecision,
  type CanonicalTurnContext,
} from "../../../src/lib/scanner/assemble";
import type { FloorRuleEntry, ScopedRuleEntry } from "../../../src/lib/scanner/types";

const floor = (id: string, strength: "MUST" | "SHOULD"): FloorRuleEntry => ({
  ruleId: id,
  versionId: `${id}v`,
  text: `${id} body`,
  strength,
});
const scoped = (id: string, strength: "MUST" | "SHOULD", globs: string[]): ScopedRuleEntry => ({
  ruleId: id,
  versionId: `${id}v`,
  text: `${id} body`,
  strength,
  globs,
});

describe("assembleFromCanonicalDecision renders the server decision like the local path", () => {
  it("is BYTE-IDENTICAL to assembleContext for the same required decision", () => {
    const floorMust = [floor("f1", "MUST"), floor("f2", "MUST")];
    const scopedMust = scoped("s1", "MUST", ["apps/*"]);
    // Local: decides (f1,f2 floor-must; s1 scoped-required by explicit path) AND renders.
    const local = assembleContext({
      base: "BASE-PREAMBLE",
      prompt: "",
      floorRules: floorMust,
      scopedRules: [scopedMust],
      explicitPaths: ["apps/x.ts"],
      workingSetPaths: [],
      safeTotal: 100_000,
    });
    // Canonical: the SAME decision, arriving as the tier's context. Render only.
    const ctx: CanonicalTurnContext = {
      floorMust: floorMust.map((f) => ({ ruleId: f.ruleId, versionId: f.versionId, text: f.text, strength: "MUST" })),
      floorShould: [],
      scopedRequired: [{ ruleId: "s1", versionId: "s1v", text: "s1 body", strength: "MUST" }],
      bestEffort: [],
    };
    const canonical = assembleFromCanonicalDecision("BASE-PREAMBLE", ctx, 100_000);

    expect(canonical.text).toBe(local.text);
    expect(canonical.delivered).toEqual(local.delivered);
  });

  it("delivers the required floor whole and drops best-effort that does not fit the budget", () => {
    const ctx: CanonicalTurnContext = {
      floorMust: [{ ruleId: "f1", text: "floor must body that is required whole", strength: "MUST" }],
      floorShould: [{ ruleId: "fs1", text: "x".repeat(500), strength: "SHOULD" }],
      scopedRequired: [],
      bestEffort: [{ ruleId: "fs1", text: "x".repeat(500), strength: "SHOULD", source: "floor" }],
    };
    // A tiny budget: the required floor MUST rides, the 500-byte best-effort SHOULD is omitted.
    const out = assembleFromCanonicalDecision("", ctx, 50);
    expect(out.delivered.map((d) => [d.ruleId, d.tier])).toEqual([["f1", "floor-must"]]);
    expect(out.omitted.map((o) => o.ruleId)).toEqual(["fs1"]);
  });

  it("routes a scoped best-effort candidate into the scoped block, a floor one into the floor tail", () => {
    const ctx: CanonicalTurnContext = {
      floorMust: [],
      floorShould: [{ ruleId: "fs1", text: "floor should body", strength: "SHOULD" }],
      scopedRequired: [],
      bestEffort: [
        { ruleId: "sc1", text: "scoped best effort body", strength: "SHOULD", source: "scoped" },
        { ruleId: "fs1", text: "floor should body", strength: "SHOULD", source: "floor" },
      ],
    };
    const out = assembleFromCanonicalDecision("", ctx, 100_000);
    // Both ride under a large budget; both are best-effort.
    expect(out.delivered.filter((d) => d.tier === "best-effort").map((d) => d.ruleId).sort()).toEqual(["fs1", "sc1"]);
    expect(out.text).toContain("scoped best effort body");
    expect(out.text).toContain("floor should body");
  });

  // Step 3 of the cutover gate: deterministic client rendering under TOKEN PRESSURE.
  it("fills best-effort in RANK ORDER under pressure: delivered is a rank prefix, the rest drop", () => {
    const ctx: CanonicalTurnContext = {
      floorMust: [{ ruleId: "f1", text: "req", strength: "MUST" }],
      floorShould: [],
      scopedRequired: [],
      bestEffort: [
        { ruleId: "be1", text: "a", strength: "SHOULD", source: "floor" },
        { ruleId: "be2", text: "b", strength: "SHOULD", source: "floor" },
        { ruleId: "be3", text: "x".repeat(4000), strength: "SHOULD", source: "floor" }, // cannot fit
      ],
    };
    // Budget fits the required floor block + the two tiny candidates, never the 4000-byte one.
    const out = assembleFromCanonicalDecision("", ctx, 400);
    const be = out.delivered.filter((d) => d.tier === "best-effort").map((d) => d.ruleId);
    // Rank order preserved (a prefix of the input order), and the oversized lowest-rank one dropped.
    expect(be).toEqual(["be1", "be2"]);
    expect(out.omitted.map((o) => o.ruleId)).toContain("be3");
  });

  it("delivers a SCOPED-REQUIRED rule whole even under a tiny budget (required never drops)", () => {
    const ctx: CanonicalTurnContext = {
      floorMust: [],
      floorShould: [],
      scopedRequired: [{ ruleId: "sr1", versionId: "sr1v", text: "scoped required body that must ride whole", strength: "MUST" }],
      bestEffort: [{ ruleId: "be1", text: "y".repeat(500), strength: "SHOULD", source: "scoped" }],
    };
    const out = assembleFromCanonicalDecision("", ctx, 30);
    expect(out.delivered.map((d) => [d.ruleId, d.tier])).toEqual([["sr1", "scoped-required"]]);
    expect(out.text).toContain("scoped required body that must ride whole");
    expect(out.omitted.map((o) => o.ruleId)).toEqual(["be1"]);
  });
});
