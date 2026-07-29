import { scanForCredentials, scanForSecrets } from "../../src/lib/redactor";

// redis_directive: the residual we are DECLINING to fix, pinned so the decision
// survives the next person who measures it and reaches for the obvious fix.
//
// Measured against the real 2094-note vault, this rule fires on exactly two
// lines in two notes, and both are prose. It is the only blocker on ONE of them
// (the other is independently blocked by env_assignment), so the entire prize
// for "fixing" it is a single document out of 2094.
//
// The two prose lines:
//   ...FIXED + live-verified (requirepass wired...
//   ...DOES open a real leak: the live Redis requirepass and any...
//
// Every other rule in this family was fixed by a SHAPE claim: a credential-shaped
// tail behind a length floor (bearer), a casing requirement (env_assignment), RFC
// 6265 grammar (cookie), "a reference is not a value" (env_assignment again). All
// three candidate shape claims are DEAD here, and each one is dead for the same
// reason: the fixture that proves the rule catches the real thing sits in exactly
// the position, and carries exactly the value shape, that the prose does.
//
//   1. VALUE SHAPE. `requirepass wired` (must not block) and `masteruser admin`
//      (must block) are both five lowercase letters. Identical signature, identical
//      length. A length floor or a character-class mix cannot separate them, and
//      `masterauth somesecret` is a lowercase word too. A Redis password is allowed
//      to be a short lowercase word; the canonical redis.conf example literally is
//      one. A guard that frees `wired` frees a real password.
//   2. POSITION. A directive claim looks like a claim about position in a config
//      grammar, so "keyword at line start, or after --, or after CONFIG SET" looks
//      right. It is not: the live-corpus catch fixture is `redis_url with
//      requirepass O3o7j8zX then more text`, whose left context is a word plus a
//      space. So is the prose false positive (`the live Redis requirepass`). Same
//      position class. A position guard that frees the prose drops the catch.
//   3. END OF DIRECTIVE. `requirepass <value>` ends a redis.conf line, so an EOL
//      anchor looks right. The same live-corpus fixture has four words of prose
//      AFTER the value, and `redis-server --requirepass foo --port 6379` is a real
//      command shape that also fails an EOL anchor.
//
// So the asymmetry decides it. A false positive here costs one refused document,
// which is recoverable and visible. A false negative is a live Redis password
// leaving the machine, which is neither. This rule exists BECAUSE a real credential
// was found in the real corpus in this exact form (SECRET-1), and it is the only
// rule that catches a short low-entropy secret that env_assignment's casing gate
// and the 32-char entropy gate both miss.
//
// The accepted residual is therefore narrow and self-inflicted: a governance
// corpus that documents its own secret-scanning rules will quote the keywords it
// scans for. That is the cheapest false-positive class we have.
//
// SECRET-1: no real credential value appears in this file.
describe("redis_directive: an accepted residual, not an unexamined one", () => {
  // The two real vault lines, verbatim except for surrounding context. These are
  // ACCEPTED blocks. If a future change frees them, it has almost certainly freed
  // a real password too, and the tie-break test below says why.
  const VAULT_PROSE = [
    "- Redis auth | FIXED + live-verified (requirepass wired through)",
    "The note `DOES open a real leak: the live Redis requirepass and any API keys`",
  ];

  it("still blocks the two known prose lines, and that is the accepted cost", () => {
    for (const line of VAULT_PROSE) {
      expect(scanForCredentials(line)).toContain("redis_directive");
    }
  });

  it("catches the live-corpus format the rule exists for", () => {
    // Mid-line, after a word, with prose following the value. Every candidate
    // guard above would have dropped at least one of these.
    expect(scanForCredentials("redis_url with requirepass O3o7j8zX then more")).toContain(
      "redis_directive",
    );
    expect(scanForCredentials("config: requirepass FAKE_VALUE_xyz")).toContain(
      "redis_directive",
    );
    expect(scanForSecrets("masterauth somesecret")).toContain("redis_directive");
    expect(scanForSecrets("masteruser admin")).toContain("redis_directive");
  });

  it("catches the config-file and CLI-flag forms", () => {
    expect(scanForCredentials("  requirepass FAKE_VALUE_xyz")).toContain("redis_directive");
    expect(scanForCredentials("redis-server --requirepass FAKE_VALUE_xyz")).toContain(
      "redis_directive",
    );
    expect(scanForCredentials("CONFIG SET requirepass FAKE_VALUE_xyz")).toContain(
      "redis_directive",
    );
  });

  it("the value shapes are tied, so no value guard can separate them", () => {
    // This is the tie-break, executable. `wired` is the false positive we would
    // like to free; `admin` is a pinned must-block. If someone loosens the rule by
    // value shape, they will have had to break this tie first, and breaking it
    // means editing a must-block fixture to make a fix pass. That is the move this
    // test exists to catch.
    const signature = (v: string) =>
      [
        /[a-z]/.test(v) && "lower",
        /[A-Z]/.test(v) && "upper",
        /[0-9]/.test(v) && "digit",
        /[_\-.]/.test(v) && "punct",
      ]
        .filter(Boolean)
        .join("+");

    expect(signature("wired")).toEqual(signature("admin"));
    expect("wired".length).toEqual("admin".length);
    expect(scanForCredentials("(requirepass wired through)")).toContain("redis_directive");
    expect(scanForCredentials("masteruser admin")).toContain("redis_directive");
  });

  it("the positions are tied, so no position guard can separate them either", () => {
    // Left context is a word plus a space in BOTH the prose we would like to free
    // and the live-corpus fixture we must keep.
    const prose = "the live Redis requirepass and any API keys";
    const corpus = "redis_url with requirepass O3o7j8zX then more";
    expect(/\w\s$/.test(prose.slice(0, prose.indexOf("requirepass")))).toBe(true);
    expect(/\w\s$/.test(corpus.slice(0, corpus.indexOf("requirepass")))).toBe(true);
    expect(scanForCredentials(prose)).toContain("redis_directive");
    expect(scanForCredentials(corpus)).toContain("redis_directive");
  });
});
