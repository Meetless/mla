import { renderBootstrapSummary } from "../../../src/lib/scanner/bootstrap-summary";
import { Directive, ScanResult, StaleSignal } from "../../../src/lib/scanner/types";

// GAP1 Slice 1: the "Active agent instructions" review bundle (step 6 of the
// design's `mla activate --bootstrap fast`, notes/20260611-onboarding-mla.md:1939).
// The deterministic scan + extraction + provisional-context + injection (steps 2-5)
// are already built by the M-slices, the scanner, and the hot-path injector. This
// slice turns the cosmetic count card into the magic moment: it shows the human
// WHAT was found and what Meetless will do with it, split on the two-axis model:
//   - result.directives        => injected now (human-authored / high-confidence)
//   - result.advisoryDirectives => machine_inferred, awaiting review, NEVER injected
//   - result.staleSignals       => need a keep/drop verdict
// Pure string rendering over ScanResult; no I/O.

function directive(over: Partial<Directive>): Directive {
  return {
    id: over.id ?? "deadbeef0001",
    text: over.text ?? "Some rule text",
    source: over.source ?? "CLAUDE.md",
    kind: "RULE",
    strength: over.strength ?? "MUST_FOLLOW",
    attestation: over.attestation ?? "human_attested",
    ...(over.globs ? { globs: over.globs } : {}),
  };
}

function stale(over: Partial<StaleSignal>): StaleSignal {
  return {
    id: over.id ?? "stale0001",
    source: over.source ?? "notes/old.md",
    reason: over.reason ?? "frontmatter_deprecated",
    detail: over.detail ?? "marked deprecated in frontmatter",
    ...(over.supersededBy ? { supersededBy: over.supersededBy } : {}),
  };
}

function result(over: Partial<ScanResult>): ScanResult {
  return {
    schemaVersion: 1,
    workspaceId: "ws_demo",
    commitSha: "abc123",
    generatedAt: "2026-06-21T00:00:00Z",
    inventory: over.inventory ?? {
      instructionFiles: 0,
      decisionDocs: 0,
      legacyNotes: 0,
      staleSignals: 0,
      agentMemoryRules: 0,
    },
    directives: over.directives ?? [],
    staleSignals: over.staleSignals ?? [],
    confirmedRulesXml: over.confirmedRulesXml ?? "",
    floorRulesXml: over.floorRulesXml ?? "",
    staleContextXml: over.staleContextXml ?? "",
    advisoryDirectives: over.advisoryDirectives ?? [],
  };
}

// The card is a pure function of the scan now: it makes no claim that depends on whether the
// CURRENT session was bootstrapped, because measurement showed the claim was false either way.
function render(scan: ScanResult): string {
  return renderBootstrapSummary(scan);
}

describe("renderBootstrapSummary", () => {
  it("leads with the inventory headline", () => {
    const out = render(
      result({
        inventory: { instructionFiles: 3, decisionDocs: 8, legacyNotes: 71, staleSignals: 4, agentMemoryRules: 2 },
      }),
    );
    expect(out).toContain("3 agent-instruction files");
    expect(out).toContain("8 decision/spec docs");
  });

  it("lists the high-confidence directives it found, with source", () => {
    const out = render(
      result({
        directives: [
          directive({ text: "Never create feature branches", source: "CLAUDE.md", strength: "MUST_FOLLOW" }),
          directive({ text: "Use make test-db for migrations", source: "AGENTS.md", strength: "SHOULD_FOLLOW" }),
        ],
      }),
    );
    expect(out).toContain("Never create feature branches");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("Use make test-db for migrations");
    expect(out).toContain("AGENTS.md");
  });

  it("orders MUST_FOLLOW directives ahead of SHOULD_FOLLOW", () => {
    const out = render(
      result({
        directives: [
          directive({ text: "Should rule", strength: "SHOULD_FOLLOW" }),
          directive({ text: "Must rule", strength: "MUST_FOLLOW" }),
        ],
      }),
    );
    expect(out.indexOf("Must rule")).toBeLessThan(out.indexOf("Should rule"));
  });

  it("caps the directive list and reports how many more were found", () => {
    const directives = Array.from({ length: 9 }, (_, i) =>
      directive({ id: `d${i}`, text: `Rule number ${i}`, strength: "MUST_FOLLOW" }),
    );
    const out = render(result({ directives }));
    expect(out).toContain("Rule number 0");
    expect(out).toContain("Rule number 4");
    // 9 directives, cap 5 => 4 more not shown.
    expect(out).not.toContain("Rule number 5");
    expect(out).toMatch(/4 more/);
  });

  it("surfaces advisory candidates as awaiting review and points at `mla context advisory`", () => {
    const out = render(
      result({
        advisoryDirectives: [
          directive({ text: "Maybe a rule", attestation: "machine_inferred" }),
          directive({ id: "x2", text: "Another maybe", attestation: "machine_inferred" }),
        ],
      }),
    );
    expect(out).toMatch(/2 advisory/i);
    expect(out).toContain("mla context advisory");
    // Advisory candidates are never auto-injected; the card must say so.
    expect(out).toMatch(/review|not.*inject|machine/i);
  });

  it("surfaces stale signals as needing a verdict and points at `mla context list`", () => {
    const out = render(
      result({
        staleSignals: [stale({ detail: "PRD marked superseded" }), stale({ id: "s2" })],
        inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 2, agentMemoryRules: 0 },
      }),
    );
    expect(out).toMatch(/2 .*stale/i);
    expect(out).toContain("mla context list");
  });

  it("omits the advisory and stale sections entirely when there are none", () => {
    const out = render(
      result({ directives: [directive({ text: "Only rule" })] }),
    );
    expect(out).not.toContain("mla context advisory");
    expect(out).not.toContain("mla context list");
  });

  // The regression this exists to prevent: `mla activate` from a plain terminal has
  // NO session to inject into (CLAUDE_CODE_SESSION_ID unset), and the card used to
  // claim "Guiding this session now (injected)" anyway, four lines above activate's
  // own "capture takes effect on the NEXT session". Never claim a live injection we
  // did not perform.
  it("never claims a live injection when the current session was not bootstrapped", () => {
    const out = render(
      result({ directives: [directive({ text: "Never create feature branches" })] }),
    );
    expect(out).not.toMatch(/this session now/i);
    expect(out).not.toMatch(/injected/i);
    // The rules themselves are still worth showing: they were found, and that is the point.
    expect(out).toContain("Never create feature branches");
  });
});

// The SAME bug as the one above, one level deeper, and it survived that fix because both are
// about the card's honesty but only one was about the SESSION. Measured live 2026-08-06 on a
// fresh repo carrying CLAUDE.md, AGENTS.md, and two .claude/rules files:
//
//   directives: 9    floorRules: 0    scopedRules: 1
//
// Eight of the nine rules the card had just promised would "guide the next Claude Code session"
// reach NEITHER delivery array. `buildStructuredRules` routes a directive to the floor only when
// it is bundle-sourced, and to scoped only when it carries globs or a turn trigger; a plain
// CLAUDE.md line is neither, so it is parsed, deduped, cached into `confirmedRulesXml`, and
// dropped. `confirmedRulesXml` is the RETIRED first-run pack (targeted-rule-injection Phase 2):
// it has no reader left in the hook.
//
// The exclusion itself is CORRECT and must not be "fixed" by injecting these. Claude Code loads
// CLAUDE.md and .claude/rules natively, so re-injecting them is duplication, which is exactly
// what 7f0f4f1cb measured at 94.7% of delivered material and removed. What was wrong is only the
// claim. A first-run card that promises delivery it cannot perform is also how a fleet of dark
// workspaces went unnoticed: the product told every one of them it was working.
describe("renderBootstrapSummary: what Meetless will ACTUALLY do with what it found", () => {
  it("does not promise to inject a plain CLAUDE.md rule, because nothing delivers it", () => {
    const out = render(
      result({ directives: [directive({ text: "Never create feature branches", source: "CLAUDE.md" })] }),
    );
    expect(out).not.toMatch(/guiding this session/i);
    expect(out).not.toMatch(/will guide/i);
    expect(out).not.toMatch(/injected/i);
  });

  it("says WHY it is not re-injecting them: the agent already reads these files itself", () => {
    const out = render(
      result({ directives: [directive({ text: "Never create feature branches", source: "CLAUDE.md" })] }),
    );
    expect(out).toMatch(/already read|already load|reads .* itself|does not re-?inject/i);
  });

  it("DOES report a rule that genuinely rides the delivery path, kept separate from the rest", () => {
    // A .claude/rules entry carrying explicit globs is the one file-sourced shape that becomes a
    // scoped rule, so it is the one the card may honestly say Meetless delivers.
    const out = render(
      result({
        directives: [
          directive({ text: "Plain repo rule", source: "CLAUDE.md" }),
          directive({ text: "Validate at the boundary", source: ".claude/rules/db.md", globs: ["src/**"] }),
        ],
      }),
    );
    expect(out).toMatch(/Validate at the boundary/);
    expect(out).toMatch(/1 .*(scoped|matching|targeted)/i);
  });

  // The headline sat one line above the false promise and made the same claim ("Meetless will
  // USE high-confidence project instructions"). Fixing only the lower line would have left two
  // headlines making opposite claims about the same files, which is how the first one survived
  // a previous honesty fix.
  it("does not claim in the headline that Meetless will USE the repo's rules either", () => {
    const out = render(result({ directives: [directive({ text: "Plain repo rule", source: "CLAUDE.md" })] }));
    expect(out).not.toMatch(/will use/i);
    expect(out).toMatch(/index/i);
  });

  it("says nothing about scoped delivery when no rule qualifies for it", () => {
    const out = render(result({ directives: [directive({ text: "Plain repo rule", source: "CLAUDE.md" })] }));
    expect(out).not.toMatch(/scoped/i);
  });

  it("handles an empty graph without claiming any instructions guide the session", () => {
    const out = render(result({}));
    // No directive bullets, but still a calm headline (no crash, no empty 'Guiding' header).
    expect(out).toMatch(/no .*instruction|nothing|first run|provisional/i);
    expect(out).not.toMatch(/•/);
  });
});
