import {
  parseAdrStatus,
  parseCodeowners,
  parseClaudeRulesFile,
} from "../../../src/lib/scanner/parse-structured";

describe("parseAdrStatus", () => {
  it("returns a superseded signal when Status names a superseding ADR", () => {
    const text = "# ADR-0007\nStatus: superseded by ADR-0012\n## Decision\nuse X\n";
    const sig = parseAdrStatus(text, "docs/adr/0007-x.md");
    expect(sig).not.toBeNull();
    expect(sig!.reason).toBe("adr_superseded");
    expect(sig!.supersededBy).toBe("ADR-0012");
  });

  it("returns null for an accepted ADR", () => {
    expect(parseAdrStatus("Status: accepted\n", "docs/adr/0008-y.md")).toBeNull();
  });

  it("does not match a lowercase YAML frontmatter status key", () => {
    const text = "---\nstatus: deprecated\n---\nold thinking\n";
    expect(parseAdrStatus(text, "notes/20260101-old.md")).toBeNull();
  });
});

describe("parseCodeowners", () => {
  it("parses pattern -> owners, ignoring comments and blanks", () => {
    const text = "# owners\n/src/api/ @api-team @an\n\n*.md   @docs\n";
    const rules = parseCodeowners(text);
    expect(rules).toEqual([
      { pattern: "/src/api/", owners: ["@api-team", "@an"] },
      { pattern: "*.md", owners: ["@docs"] },
    ]);
  });
});

describe("parseClaudeRulesFile", () => {
  it("extracts paths globs from frontmatter and directives from the body", () => {
    const text = "---\npaths:\n  - 'src/api/**'\n  - 'src/db/**'\n---\n- MUST validate inputs.\n";
    const parsed = parseClaudeRulesFile(text, ".claude/rules/api.md");
    expect(parsed.globs).toEqual(["src/api/**", "src/db/**"]);
    expect(parsed.directives).toHaveLength(1);
    expect(parsed.directives[0].globs).toEqual(["src/api/**", "src/db/**"]);
    expect(parsed.directives[0].strength).toBe("MUST_FOLLOW");
  });
});
