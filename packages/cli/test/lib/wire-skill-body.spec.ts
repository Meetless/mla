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

  it("forbids injecting any token the user did not type (INV-ARGV-1)", () => {
    // Verbatim argument forwarding is the one thing Phase 2 did NOT change. The
    // skill still injects no token the user did not type; it just no longer calls
    // itself a "pure pass-through", because it now reads and acts on the envelope.
    expect(body).toMatch(/do NOT inject any token the user did not type/i);
    expect(body).toMatch(/chooses no operation of its own/i);
    // `latest` / `by-session` are still named as concrete things never to add.
    expect(body).toMatch(/latest/);
    expect(body).toMatch(/by-session/);
  });

  it("states the executor contract: the agent is the only runner, never hands a command back (§4.12)", () => {
    // The Phase 2 core: the agent is the only thing that runs `mla`, and it never
    // asks the user to copy or run a command. This is a POSITIVE rule on purpose.
    expect(body).toMatch(/never ask the user to copy or run an `mla` command/i);
    expect(body).toMatch(/returns a single JSON envelope/i);
    // Execution vs explanation gate: a "how does it work?" question is not authority.
    expect(body).toMatch(/explain it without executing/i);
    // Safe degradation: legacy human text is summarized, never re-emitted as a command.
    expect(body).toMatch(/never reproduce a runnable `mla` command/i);
  });

  it("keeps the closed control transitions and the one legacy sentinel exception", () => {
    // At most one control transition, from a closed vocabulary. The onboard chain
    // is the only one, and it fires on either the envelope next_action or the
    // legacy MLA_NEXT sentinel (the sole non-envelope line ever treated as an
    // instruction).
    expect(body).toContain("decision_request");
    expect(body).toContain("next_action");
    expect(body).toContain('next_action: { kind: "skill", ref: "onboard" }');
    expect(body).toContain("MLA_NEXT: onboard");
    expect(body).toMatch(
      /only non-envelope text you ever treat as an instruction/i,
    );
  });

  it("keeps the skill frontmatter name `mla`", () => {
    expect(body).toMatch(/^---\nname: mla\n/);
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    expect(body).not.toContain("—"); // em dash
    expect(body).not.toMatch(/ -- /); // double dash as a word separator
  });
});
