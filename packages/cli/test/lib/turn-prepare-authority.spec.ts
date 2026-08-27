import {
  fetchCanonicalTurnContext,
  formatTurnAuthority,
  normalizeCanonicalContext,
  prepareTurn,
  type PrepareTurnOptions,
} from "../../src/lib/turn-prepare-authority";
import type { AssembleInput, AssembleOutput } from "../../src/lib/scanner/assemble";

const legacyInput: AssembleInput = {
  base: "BASE",
  prompt: "",
  floorRules: [{ ruleId: "f1", versionId: "f1v", text: "floor one", strength: "MUST" }],
  scopedRules: [],
  explicitPaths: [],
  workingSetPaths: [],
  safeTotal: 100_000,
};

const opts = (over: Partial<PrepareTurnOptions>): PrepareTurnOptions => ({
  cutover: false,
  platformUrl: "http://127.0.0.1:3020",
  accessToken: "tok",
  task: "t",
  sessionId: "s",
  legacyInput,
  ...over,
});

describe("normalizeCanonicalContext", () => {
  it("extracts the four tiers and drops malformed rules", () => {
    const ctx = normalizeCanonicalContext({
      context: {
        floorMust: [{ ruleId: "f1", versionId: "f1v", text: "a", strength: "MUST" }, { ruleId: "", text: "x" }],
        floorShould: [{ ruleId: "fs1", text: "b", strength: "SHOULD" }],
        scopedRequired: [{ ruleId: "s1", text: "c", strength: "MUST", signal: "turn_trigger" }],
        bestEffort: [{ ruleId: "be1", text: "d", strength: "SHOULD", source: "scoped" }],
      },
    });
    expect(ctx?.floorMust.map((r) => r.ruleId)).toEqual(["f1"]); // the blank-id rule dropped
    expect(ctx?.scopedRequired[0]).toMatchObject({ ruleId: "s1", text: "c", strength: "MUST" });
    expect(ctx?.bestEffort[0]).toMatchObject({ ruleId: "be1", source: "scoped" });
  });

  it("returns null for a body with no context", () => {
    expect(normalizeCanonicalContext(null)).toBeNull();
    expect(normalizeCanonicalContext({ nope: 1 })).toBeNull();
  });
});

describe("fetchCanonicalTurnContext never throws and names the reason", () => {
  it("canonical_unavailable with no URL or no token (nothing to call)", async () => {
    expect(await fetchCanonicalTurnContext(opts({ platformUrl: undefined }))).toEqual({
      ok: false,
      reason: "canonical_unavailable",
    });
    expect(await fetchCanonicalTurnContext(opts({ accessToken: undefined }))).toEqual({
      ok: false,
      reason: "canonical_unavailable",
    });
  });

  it("canonical_unavailable (not a throw) when the tier is unreachable", async () => {
    expect(await fetchCanonicalTurnContext(opts({ platformUrl: "http://127.0.0.1:9" }))).toEqual({
      ok: false,
      reason: "canonical_unavailable",
    });
  });
});

describe("formatTurnAuthority", () => {
  it("is one greppable line, with the reason only on a fallback", () => {
    const out = {} as AssembleOutput;
    expect(formatTurnAuthority({ output: out, authority: "canonical" })).toBe("e1_authority authority=canonical");
    expect(formatTurnAuthority({ output: out, authority: "legacy_pre_cutover" })).toBe(
      "e1_authority authority=legacy_pre_cutover",
    );
    expect(formatTurnAuthority({ output: out, authority: "legacy_fallback", reason: "canonical_invalid" })).toBe(
      "e1_authority authority=legacy_fallback reason=canonical_invalid",
    );
  });
});

describe("prepareTurn holds the flip, falls back, and records the authority source", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it("records legacy_pre_cutover when cutover is off (the default everywhere today)", async () => {
    const r = await prepareTurn(opts({ cutover: false }));
    expect(r.authority).toBe("legacy_pre_cutover");
    expect(r.reason).toBeUndefined();
    expect(r.output.delivered.map((d) => d.ruleId)).toEqual(["f1"]);
    // The observation fires at the boundary, distinct from a fallback, so it can never be mistaken for one.
    expect(spy).toHaveBeenCalledWith("e1_authority authority=legacy_pre_cutover");
  });

  it("records legacy_fallback + canonical_unavailable when cutover is on but the tier is unreachable", async () => {
    const r = await prepareTurn(opts({ cutover: true, platformUrl: "http://127.0.0.1:9" }));
    expect(r.authority).toBe("legacy_fallback");
    expect(r.reason).toBe("canonical_unavailable");
    expect(r.output.text).toContain("floor one"); // the turn is still prepared, never blocked
    expect(spy).toHaveBeenCalledWith("e1_authority authority=legacy_fallback reason=canonical_unavailable");
  });
});
