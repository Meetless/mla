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

describe("renderBootstrapSummary", () => {
  it("leads with the inventory headline", () => {
    const out = renderBootstrapSummary(
      result({
        inventory: { instructionFiles: 3, decisionDocs: 8, legacyNotes: 71, staleSignals: 4, agentMemoryRules: 2 },
      }),
    );
    expect(out).toContain("3 agent-instruction files");
    expect(out).toContain("8 decision/spec docs");
  });

  it("lists the high-confidence directives that will guide the session now, with source", () => {
    const out = renderBootstrapSummary(
      result({
        directives: [
          directive({ text: "Never create feature branches", source: "CLAUDE.md", strength: "MUST_FOLLOW" }),
          directive({ text: "Use make test-db for migrations", source: "AGENTS.md", strength: "SHOULD_FOLLOW" }),
        ],
      }),
    );
    expect(out).toMatch(/guid|active|in effect|apply/i);
    expect(out).toContain("Never create feature branches");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("Use make test-db for migrations");
    expect(out).toContain("AGENTS.md");
  });

  it("orders MUST_FOLLOW directives ahead of SHOULD_FOLLOW", () => {
    const out = renderBootstrapSummary(
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
    const out = renderBootstrapSummary(result({ directives }));
    expect(out).toContain("Rule number 0");
    expect(out).toContain("Rule number 4");
    // 9 directives, cap 5 => 4 more not shown.
    expect(out).not.toContain("Rule number 5");
    expect(out).toMatch(/4 more/);
  });

  it("surfaces advisory candidates as awaiting review and points at `mla context advisory`", () => {
    const out = renderBootstrapSummary(
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
    const out = renderBootstrapSummary(
      result({
        staleSignals: [stale({ detail: "PRD marked superseded" }), stale({ id: "s2" })],
        inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 2, agentMemoryRules: 0 },
      }),
    );
    expect(out).toMatch(/2 .*stale/i);
    expect(out).toContain("mla context list");
  });

  it("omits the advisory and stale sections entirely when there are none", () => {
    const out = renderBootstrapSummary(
      result({ directives: [directive({ text: "Only rule" })] }),
    );
    expect(out).not.toContain("mla context advisory");
    expect(out).not.toContain("mla context list");
  });

  it("handles an empty graph without claiming any instructions guide the session", () => {
    const out = renderBootstrapSummary(result({}));
    // No directive bullets, but still a calm headline (no crash, no empty 'Guiding' header).
    expect(out).toMatch(/no .*instruction|nothing|first run|provisional/i);
    expect(out).not.toMatch(/•/);
  });
});
