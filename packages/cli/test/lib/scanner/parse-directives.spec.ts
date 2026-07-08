import { parseDirectivesFromMarkdown } from "../../../src/lib/scanner/parse-directives";

describe("parseDirectivesFromMarkdown", () => {
  it("extracts MUST/NEVER bullet lines as MUST_FOLLOW directives", () => {
    const md = [
      "# Project rules",
      "- NEVER commit secrets.",
      "- Use pnpm, not npm.",
      "Some narrative prose that is not a rule.",
      "- Prefer small PRs.",
    ].join("\n");
    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");
    const texts = dirs.map((d) => d.text);
    expect(texts).toContain("NEVER commit secrets.");
    expect(texts).toContain("Use pnpm, not npm.");
    expect(texts).not.toContain("Some narrative prose that is not a rule.");

    const secret = dirs.find((d) => d.text.startsWith("NEVER"))!;
    expect(secret.strength).toBe("MUST_FOLLOW");
    expect(secret.attestation).toBe("human_attested");
    expect(secret.source).toBe("CLAUDE.md");

    const prs = dirs.find((d) => d.text.startsWith("Prefer"))!;
    expect(prs.strength).toBe("SHOULD_FOLLOW");
  });

  it("dedupes identical rule text and caps the count", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `- MUST do thing ${i % 3}.`);
    const dirs = parseDirectivesFromMarkdown(lines.join("\n"), "CLAUDE.md");
    expect(dirs.length).toBe(3); // 3 distinct, deduped
  });

  it("returns nothing for prose with no rule signal", () => {
    expect(parseDirectivesFromMarkdown("Just a description.\nMore prose.", "README.md")).toEqual([]);
  });

  it("does not treat lowercase prose modals on non-bullet lines as rules", () => {
    const md = "We never really finalized the schema.\nThe team must have lunch at noon.";
    expect(parseDirectivesFromMarkdown(md, "notes/x.md")).toEqual([]);
  });

  it("still treats a lowercase imperative bullet as a directive", () => {
    const dirs = parseDirectivesFromMarkdown("- always run lint before pushing.", "CLAUDE.md");
    expect(dirs).toHaveLength(1);
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
  });

  it("does not extract a markdown section heading as a rule (## DO NOT noise)", () => {
    const md = ["## DO NOT", "", "- Add try-catch blocks in controllers"].join("\n");
    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");
    expect(dirs.map((d) => d.text)).not.toContain("## DO NOT");
    expect(dirs.map((d) => d.text)).not.toContain("DO NOT");
  });

  it("re-renders positive bullets under a '## DO NOT' heading as prohibitions (never inverted)", () => {
    // Real CLAUDE.md pattern: a "## DO NOT" section whose bullets are phrased
    // positively. Extracting them bare would inject the OPPOSITE of the rule.
    const md = [
      "## DO NOT",
      "",
      "- Use relative imports when absolute imports work",
      "- Use hardcoded strings for enum values",
    ].join("\n");
    const texts = parseDirectivesFromMarkdown(md, "apps/control/CLAUDE.md").map((d) => d.text);
    // The dangerous positive phrasing must NOT be injected as-is.
    expect(texts).not.toContain("Use relative imports when absolute imports work");
    // It must be captured as an explicit prohibition instead.
    expect(texts).toContain("Do not use relative imports when absolute imports work");
    expect(texts).toContain("Do not use hardcoded strings for enum values");
  });

  it("keeps a bullet that already carries its own modal verbatim under a negation heading (no double negation)", () => {
    const md = ["## DO NOT", "", "- NEVER expose internal IDs in error messages"].join("\n");
    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);
    expect(texts).toContain("NEVER expose internal IDs in error messages");
    expect(texts).not.toContain("Do not NEVER expose internal IDs in error messages");
  });

  it("resets the negation context at the next heading", () => {
    const md = [
      "## DO NOT",
      "- Use relative imports when absolute imports work",
      "## Conventions",
      "- Use string enums with UPPER_SNAKE_CASE values",
    ].join("\n");
    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);
    // Under DO NOT -> prohibition.
    expect(texts).toContain("Do not use relative imports when absolute imports work");
    // Under a normal heading -> kept positive, NOT prefixed.
    expect(texts).toContain("Use string enums with UPPER_SNAKE_CASE values");
    expect(texts).not.toContain("Do not use string enums with UPPER_SNAKE_CASE values");
  });
});
