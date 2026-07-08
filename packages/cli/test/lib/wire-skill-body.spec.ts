import { buildMlaSkillBody } from "../../src/lib/wire";

// Regression lock for the /mla skill body the CLI materializes into
// ~/.claude/skills/mla/SKILL.md on every `mla init` / `mla rewire`.
//
// The bug: the generator hardcoded `mla review latest --plain`. So `/mla
// activate` (and every other subcommand) ran a REVIEW instead of the requested
// command, and `latest` had been removed from `mla review`, so the hardcoded
// command exited non-zero every time. Patching only the materialized SKILL.md
// (as the original bug report proposed) is silently reverted by the next
// `mla rewire`, because THIS function is the source of truth. These assertions
// pin the contract at the generator so it can't regress.
describe("buildMlaSkillBody (the /mla skill the CLI writes on init/rewire)", () => {
  const body = buildMlaSkillBody();

  it("does NOT hardcode the retired `mla review latest` command", () => {
    expect(body).not.toContain("mla review latest");
    expect(body).not.toContain("review latest --plain");
  });

  it("does NOT hardcode a single subcommand as the only thing the skill runs", () => {
    // The pre-fix body had a lone ```bash\nmla review latest --plain\n``` block.
    // The fixed body instructs forwarding, so there must be no fenced block that
    // pins one command as the sole action.
    expect(body).not.toMatch(/```bash\s*\nmla review[^\n]*\n```/);
  });

  it("instructs forwarding the user's verbatim subcommand to `mla`", () => {
    expect(body).toMatch(/forward it to `mla` exactly as given/i);
    // Concrete examples prove non-review subcommands are honored.
    expect(body).toContain("`/mla activate` runs `mla activate`");
    expect(body).toContain("`/mla doctor` runs `mla doctor`");
  });

  it("injects NO default subcommand for a bare `/mla` (no guessing)", () => {
    // A bare `/mla` must run `mla` with no args -- the CLI prints its own usage.
    // It must NOT substitute `review` (or any command): guessing the user's
    // intent is the exact bug we are removing. `mla review` has side effects, so
    // guessing it is worse than guessing nothing. Better to surface the real
    // command menu than to run the wrong thing.
    expect(body).not.toContain("review --plain");
    expect(body).not.toMatch(/no subcommand runs `mla review/i);
    expect(body).toMatch(/no subcommand runs `mla`/i);
  });

  it("forbids injecting any token the user did not type (pure pass-through)", () => {
    expect(body).toMatch(/do NOT inject any token the user did not type/i);
    expect(body).toMatch(/pure pass-through/i);
    // `latest` / `by-session` are still named as concrete things never to add.
    expect(body).toMatch(/latest/);
    expect(body).toMatch(/by-session/);
  });

  it("keeps the skill frontmatter name `mla`", () => {
    expect(body).toMatch(/^---\nname: mla\n/);
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    expect(body).not.toContain("—"); // em dash
    expect(body).not.toMatch(/ -- /); // double dash as a word separator
  });
});
