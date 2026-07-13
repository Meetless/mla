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

  // --- hard-wrapped prose (the fragment bug) --------------------------------
  //
  // Verbatim from this repo's own CLAUDE.md. A line is not a unit of meaning:
  // markdown authors wrap at 80 columns. Reading line by line, `mla activate`
  // extracted line 4 of 5 on its own and injected it into every session as a
  // MUST_FOLLOW rule: `about Y", "what's the difference between X and Y"** MUST
  // go through`. An incoherent shard is worse than no rule at all.
  it("rejoins a hard-wrapped paragraph and emits the whole sentence, never a line-shard", () => {
    const md = [
      "Any question about an **idea, concept, architecture, product, flow, decision,",
      'privacy/ACL, intent, naming, pattern, "what is X", "how does Y work",',
      '"what did we decide about Y", "what\'s the difference between X and Y"** MUST go through',
      "`meetless__retrieve_knowledge` first, then open the citations that matter with",
      "`meetless__kb_doc_detail`.",
    ].join("\n");

    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");

    expect(dirs).toHaveLength(1);
    // The whole sentence, start to finish, on one line.
    expect(dirs[0].text).toMatch(/^Any question about an/);
    expect(dirs[0].text).toMatch(/kb_doc_detail`\.$/);
    expect(dirs[0].text).toContain("MUST go through");
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
    // And never the shard the old line-grain parser produced.
    expect(dirs[0].text).not.toMatch(/^about Y/);
  });

  it("emits only the sentence carrying the modal, not the whole paragraph", () => {
    const md = [
      "The connector normalizes inbound events and hands them to control.",
      "It MUST NOT make intelligence decisions; intel owns all LLM logic.",
      "Latency here is dominated by the Slack round trip.",
    ].join("\n");

    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);

    expect(texts).toEqual([
      "It MUST NOT make intelligence decisions; intel owns all LLM logic.",
    ]);
  });

  it("skips fenced code blocks, however loudly they shout", () => {
    const md = [
      "Run the migration:",
      "```bash",
      "# ALWAYS pass --force here, NEVER omit it",
      "make test-db",
      "```",
      "- Never hand-roll `prisma migrate deploy`",
    ].join("\n");

    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);

    expect(texts).toEqual(["Never hand-roll `prisma migrate deploy`"]);
  });

  // --- adjectival tokens (the noun-phrase bug) -------------------------------
  //
  // Also verbatim from this repo's CLAUDE.md, under "Every meaningful scope change
  // becomes:". "Required" here is an adjective on a noun phrase describing a field
  // of an object; it instructs nobody. It was injected as MUST_FOLLOW.
  it("does not mistake a capitalized adjective for an instruction", () => {
    const md = [
      "Every meaningful scope change becomes:",
      "- **Required sign-offs** (accountable owners via ownership rules)",
      "- **Immutable audit trail** (who approved what, when)",
      "- Forbidden characters are stripped from the slug",
    ].join("\n");

    expect(parseDirectivesFromMarkdown(md, "CLAUDE.md")).toEqual([]);
  });

  it("still honors a SHOUTED adjectival marker, which an author only writes on purpose", () => {
    const md = ["- Approval by a second owner is REQUIRED before merge"].join("\n");

    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");

    expect(dirs).toHaveLength(1);
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
  });

  it("keeps a lowercase verb-adjacent modal, which does instruct", () => {
    const md = ["- Routing and notifications must be precise, batched, configurable"].join("\n");

    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");

    expect(dirs).toHaveLength(1);
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
  });

  // --- descriptive modals in a doc bullet (the paragraph-as-rule bug) --------
  //
  // Verbatim from this repo's CLAUDE.md, under "mla CLI authentication". A bullet is
  // not automatically a rule: this one is five sentences of reference documentation,
  // and it was injected whole as MUST_FOLLOW because "an actively-used CLI never
  // re-auths" contains the word "never". That "never" is a frequency adverb stating
  // what the CLI DOES, not an instruction about what the agent MUST NOT do.
  it("does not turn a multi-sentence doc bullet into a rule on a descriptive 'never'", () => {
    const md = [
      "- **`user-token`** (set by `mla login`, browser OAuth + loopback PKCE): a real",
      "  Console user; every action is audited as that human. This is the default for",
      "  interactive operators. The refresh token is a 30-day SLIDING window: every",
      "  rotation re-issues a fresh 30 days, so an actively-used CLI never re-auths.",
      "  Only ~30 days of total dormancy forces a new `mla login`.",
    ].join("\n");

    expect(parseDirectivesFromMarkdown(md, "CLAUDE.md")).toEqual([]);
  });

  it("extracts only the instructing sentence from a bullet that buries a rule in prose", () => {
    const md = [
      "- Secrets live in Secret Manager, bound at deploy time. NEVER commit a key to",
      "  the repo. The rotation policy is documented in the connector README.",
    ].join("\n");

    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);

    expect(texts).toEqual(["NEVER commit a key to the repo."]);
  });

  it("honors a lowercase modal that leads the bullet, even inside markdown emphasis", () => {
    const md = ["- **Never** create feature branches; work directly on main"].join("\n");

    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");

    expect(dirs).toHaveLength(1);
    expect(dirs[0].text).toBe("**Never** create feature branches; work directly on main");
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
  });

  // A leading code span is the SUBJECT of a reference entry, not decoration around a
  // verb. Both bullets below are from the "Scenario Runner" command table in this
  // repo's CLAUDE.md; unwrapping the backticks exposed "run" and shipped a command
  // catalogue as agent instructions.
  it("does not read the verb inside a leading code span as an order", () => {
    const md = [
      "**Commands**:",
      "- `run scenarios <diff-id>` — run all 7 scenario scripts against an existing diff",
      "- `mla doctor --fix` — repair an existing install",
    ].join("\n");

    expect(parseDirectivesFromMarkdown(md, "CLAUDE.md")).toEqual([]);
  });

  it("still reads a rule that merely mentions a command", () => {
    const md = ["- Always run `pnpm build` before you publish"].join("\n");

    expect(parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text)).toEqual([
      "Always run `pnpm build` before you publish",
    ]);
  });

  it("drops a colon-terminated lead-in and keeps the sub-list it introduces", () => {
    // Verbatim shape from apps/control/CLAUDE.md. "It MUST:" commands nothing on its
    // own, and it was injected as a MUST_FOLLOW rule saying exactly nothing.
    const md = [
      "The scenario clock is authoritative. It MUST:",
      "- NEVER read `new Date()` directly",
      "- ALWAYS resolve time through the injected clock",
    ].join("\n");

    const texts = parseDirectivesFromMarkdown(md, "CLAUDE.md").map((d) => d.text);

    expect(texts).toEqual([
      "NEVER read `new Date()` directly",
      "ALWAYS resolve time through the injected clock",
    ]);
  });

  it("keeps a complete rule whose trailing colon only introduces a code block", () => {
    // Verbatim from apps/control/CLAUDE.md:308. A trailing colon does NOT make a
    // lead-in: this states the rule in full and then shows the symlink command. A
    // blanket "ends with a colon" filter silently dropped it.
    const md = [
      "**Control's `prisma/schema.prisma` is the source of truth.** Worker's",
      "schema.prisma MUST be a symlink pointing to Control's schema:",
      "```bash",
      "ln -s ../../control/prisma/schema.prisma schema.prisma",
      "```",
    ].join("\n");

    const dirs = parseDirectivesFromMarkdown(md, "CLAUDE.md");

    expect(dirs).toHaveLength(1);
    expect(dirs[0].text).toBe(
      "**Control's `prisma/schema.prisma` is the source of truth.** Worker's schema.prisma MUST be a symlink pointing to Control's schema",
    );
    expect(dirs[0].strength).toBe("MUST_FOLLOW");
  });
});
