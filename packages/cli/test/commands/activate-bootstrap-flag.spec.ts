import {
  parseActivateArgs,
  resolveBootstrapTier,
  bootstrapTierEmitsMission,
  bootstrapTierIsDeprecated,
  agenticDeprecationNote,
  onboardRecommendation,
} from "../../src/commands/activate";

// Phase 2 (notes/20260624-mla-new-user-value-and-brownfield-proof.md): onboarding is
// consolidated to ONE public flow. `mla activate` runs the `fast` deterministic scan +
// review bundle (the default), then `/mla onboard` does the agent-driven deep read.
//   - fast    : deterministic scan + the "Active agent instructions" review bundle;
//   - agentic : DEPRECATED. Still emits the static scout mission for back-compat, but
//               steers the operator to `/mla onboard`.
//   - full    : REMOVED. Its temporal legacy-note graph was never built, so rather than
//               silently falling back to a shallower tier, `--bootstrap full` errors
//               with a migration message pointing at `/mla onboard`.
// These tests pin the parse surface and the pure tier predicates that gate the
// activation tail. The mission text itself is covered by scout-mission.spec.ts.

describe("parseActivateArgs --bootstrap", () => {
  it("accepts the two public named tiers", () => {
    expect(parseActivateArgs(["--bootstrap", "fast"]).bootstrap).toBe("fast");
    expect(parseActivateArgs(["--bootstrap", "agentic"]).bootstrap).toBe("agentic");
  });

  it("leaves bootstrap unset when the flag is absent", () => {
    expect(parseActivateArgs([]).bootstrap).toBeUndefined();
  });

  it("rejects the removed `full` tier with a migration message, never a silent fallback", () => {
    // No silent under-delivery: `full` must error, not quietly degrade to agentic/fast.
    expect(() => parseActivateArgs(["--bootstrap", "full"])).toThrow(/full/);
    expect(() => parseActivateArgs(["--bootstrap", "full"])).toThrow(/\/mla onboard/);
  });

  it("rejects an unknown tier value", () => {
    expect(() => parseActivateArgs(["--bootstrap", "banana"])).toThrow(/bootstrap/i);
  });

  it("rejects a missing tier value", () => {
    expect(() => parseActivateArgs(["--bootstrap"])).toThrow(/value for --bootstrap/i);
  });

  it("composes with the other activate flags", () => {
    const flags = parseActivateArgs(["--name", "demo", "--bootstrap", "agentic"]);
    expect(flags.name).toBe("demo");
    expect(flags.bootstrap).toBe("agentic");
  });
});

describe("resolveBootstrapTier", () => {
  it("defaults to fast when no tier was given", () => {
    expect(resolveBootstrapTier({})).toBe("fast");
  });

  it("honors an explicit tier", () => {
    expect(resolveBootstrapTier({ bootstrap: "agentic" })).toBe("agentic");
    expect(resolveBootstrapTier({ bootstrap: "fast" })).toBe("fast");
  });
});

describe("bootstrapTierEmitsMission", () => {
  it("is false for fast and true for the deprecated agentic tier", () => {
    expect(bootstrapTierEmitsMission("fast")).toBe(false);
    expect(bootstrapTierEmitsMission("agentic")).toBe(true);
  });
});

describe("bootstrapTierIsDeprecated", () => {
  it("flags only agentic as deprecated", () => {
    expect(bootstrapTierIsDeprecated("fast")).toBe(false);
    expect(bootstrapTierIsDeprecated("agentic")).toBe(true);
  });
});

describe("agenticDeprecationNote", () => {
  it("steers to /mla onboard and preserves the born-PENDING trust posture", () => {
    const note = agenticDeprecationNote();
    expect(note).toMatch(/deprecated/i);
    expect(note).toContain("/mla onboard");
    expect(note).toMatch(/born PENDING/);
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    const note = agenticDeprecationNote();
    expect(note).not.toContain("—");
    expect(note).not.toMatch(/ -- /);
  });
});

// Phase 3e: the one-time `/mla onboard` nudge printed at the activation tail. It
// fires only for a freshly provisioned workspace (empty governed KB) AND only inside
// a live Claude Code session (where the slash command is invokable). The bind path
// never provisions, so this is one-time per workspace without sentinel state.
describe("onboardRecommendation", () => {
  it("recommends /mla onboard for a fresh workspace inside a session", () => {
    const out = onboardRecommendation({ inSession: true, justProvisioned: true });
    expect(out).not.toBeNull();
    expect(out!).toContain("/mla onboard");
    // Trust posture: candidates land born PENDING, never auto-accepted.
    expect(out!).toMatch(/born PENDING/);
    expect(out!).toMatch(/nothing is accepted/i);
    // First-run heads-up: scouts are freshly wired, so a same-session dispatch can hit
    // "agent not found" until Claude Code reloads agents (only at session start).
    expect(out!).toMatch(/not found/);
    expect(out!).toMatch(/restart Claude Code|open a new session/i);
  });

  it("stays silent outside a Claude Code session (slash command not invokable)", () => {
    expect(onboardRecommendation({ inSession: false, justProvisioned: true })).toBeNull();
  });

  it("stays silent on the bind path (no fresh workspace to seed)", () => {
    expect(onboardRecommendation({ inSession: true, justProvisioned: false })).toBeNull();
    expect(onboardRecommendation({ inSession: false, justProvisioned: false })).toBeNull();
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    const out = onboardRecommendation({ inSession: true, justProvisioned: true })!;
    expect(out).not.toContain("—");
    expect(out).not.toMatch(/ -- /);
  });
});
