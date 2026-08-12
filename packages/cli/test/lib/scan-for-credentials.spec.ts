import {
  scanForCredentials,
  scanForSecrets,
  CREDENTIAL_RULE_IDS,
} from "../../src/lib/redactor";

// Pre-upload credential denylist (proposal §4 SECRET-1, §6 Phase 2A/2B).
//
// This is the precision-first blocker that withholds a file from the LIVE
// capture upload. It must catch known credential FORMATS and, critically, must
// NOT fire on high-entropy prose: the generic Shannon heuristic over-blocked
// 99.2% of the real corpus in Phase 0A, so it is excluded from the blocking
// path. These tests pin both halves of that contract.
//
// SECRET-1: never embed a real credential value. The redis_directive fixtures
// use an obviously-fake value.
describe("scanForCredentials (pre-upload credential denylist)", () => {
  it("fires on the Redis requirepass directive (the live-corpus format)", () => {
    expect(scanForCredentials("config: requirepass FAKE_VALUE_xyz")).toEqual([
      "redis_directive",
    ]);
    expect(scanForCredentials("masterauth FAKE")).toEqual(["redis_directive"]);
    expect(scanForCredentials("masteruser FAKE")).toEqual(["redis_directive"]);
  });

  it("fires on provider-token prefixes", () => {
    expect(scanForCredentials("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("k=sk-proj-AbCdEfGhIjKlMnOpQrStUv")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("aws AKIA" + "IOSFODNN7EXAMPLE here")).toEqual([
      "provider_token",
    ]);
    expect(scanForCredentials("xox" + "b-1234567890-abcdefghij")).toEqual([
      "provider_token",
    ]);
  });

  describe("provider_token: a placeholder shaped like a token stays refused", () => {
    // RULED: the rule is right and the two notes it blocks alone are not.
    //
    // `provider_token` has no BODY shape test. `xox[baprs]-[A-Za-z0-9\-]{10,}`
    // accepts any ten-plus characters after the prefix, so it fires on the
    // documentation placeholder `xoxb-test-bot-token` exactly as it fires on an
    // issued token. That reads like every other over-firing rule this campaign
    // has fixed, so it was measured against the same 2094-note vault instead of
    // being reasoned about.
    //
    // The whole rule fires SIX times across five notes:
    //
    //   2  `ASIA` + 16, inside `X-Amz-Credential=` in an AWS SigV4 presigned URL
    //   1  a Langfuse `sk-lf-<w>-dev-<w>-key` placeholder in a fenced block
    //   1  `xoxb-test-bot-token`, a compose env placeholder in a test plan
    //   1  an `sk-` example key in this campaign's own proposal note
    //   1  a `ghp_` plus 24 uppercase placeholder in that same note
    //
    // The two `ASIA` hits are TRUE POSITIVES. Their line also carries
    // X-Amz-Algorithm, X-Amz-Date, X-Amz-Expires and X-Amz-Signature, so it is a
    // real presigned URL with a real STS access key id and signature in it. Both
    // expired in May 2026, which shape cannot know and must not assume.
    //
    // They are also the ONLY two notes this rule blocks by itself. The other
    // three are independently refused by `env_assignment` and `bearer`, so
    // loosening `provider_token` would free exactly ZERO documents. Measure the
    // freed set, not the hit count: a false positive on a note that another rule
    // blocks anyway is worth nothing.
    //
    // And no shape test exists to loosen it with. The placeholders differ from
    // issued tokens in ENGLISH, not in shape, and a body-class test (the one
    // `bearer` uses) contradicts this rule's own `AKIA[0-9A-Z]{16}` and
    // `ASIA[0-9A-Z]{16}` alternatives, which are single-case-plus-digits BY
    // CONSTRUCTION because that is the issued AWS shape. The two fixtures below
    // prove it rather than asserting it: their bodies carry the identical
    // character-class signature, so any body test keeping one drops the other.
    // Anything that separates them is a dictionary of placeholder names, which
    // has already been refused three times.
    //
    // The remedy for the two blocked notes is to fix the SOURCE, which is what
    // the refusal message already tells the author to do: quote the shape, not
    // the value.

    // SECRET-1: both bodies are typed here, not copied from any note.
    const PLACEHOLDER_BODY = "PLACEHOLDER1234567890AB";
    const ISSUED_SHAPE_BODY = "QWERTY1234ABCDEF";

    const bodyClass = (s: string) =>
      (/[a-z]/.test(s) ? "l" : "") +
      (/[A-Z]/.test(s) ? "U" : "") +
      (/[0-9]/.test(s) ? "d" : "");

    it("refuses an STS key id inside a presigned URL (the real vault hit)", () => {
      expect(
        scanForCredentials(
          `https://b.s3.amazonaws.com/o.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
            `&X-Amz-Credential=ASIA${ISSUED_SHAPE_BODY}%2F20260504%2Fus-east-1` +
            `%2Fs3%2Faws4_request&X-Amz-Expires=21600&X-Amz-Signature=deadbeef`,
        ),
      ).toEqual(["provider_token"]);
    });

    it("refuses the prose placeholders too, deliberately", () => {
      expect(scanForCredentials("SLACK_BOT=xoxb-test-bot-token")).toContain(
        "provider_token",
      );
      expect(scanForCredentials("langfuse: sk-lf-demo-dev-sample-key")).toEqual([
        "provider_token",
      ]);
      expect(scanForCredentials(`gh: ghp_${PLACEHOLDER_BODY}`)).toEqual([
        "provider_token",
      ]);
    });

    it("cannot be narrowed by body shape: the two bodies are the same shape", () => {
      // "Ud" both ways. The placeholder is not distinguishable from the issued
      // AWS shape by anything a regex can see, only by reading the words.
      expect(bodyClass(PLACEHOLDER_BODY)).toEqual(bodyClass(ISSUED_SHAPE_BODY));
      expect(scanForCredentials(`gh: ghp_${PLACEHOLDER_BODY}`)).toEqual([
        "provider_token",
      ]);
      expect(scanForCredentials(`aws: ASIA${ISSUED_SHAPE_BODY}`)).toEqual([
        "provider_token",
      ]);
    });
  });

  it("fires on a bare JWT with no Authorization header to carry it", () => {
    // The `bearer` rule only sees a token that follows "Bearer "/"Basic ". A JWT
    // pasted into a curl body, a log line, or a config file has no such prefix,
    // and entropy is not in this scanner, so before the `jwt` rule this file
    // uploaded with a live session token in it.
    expect(
      scanForCredentials(
        "session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQfakesig",
      ),
    ).toEqual(["jwt"]);
  });

  it("fires on Authorization bearer/basic, cookies, and PEM private keys", () => {
    // Two rules fire on one span here, and that is correct: the header shape is
    // `bearer`, the token inside it is independently a `jwt`. The rule ids are a
    // set of reasons, not a partition of the text.
    expect(
      scanForCredentials("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.p.s"),
    ).toEqual(["bearer", "jwt"]);
    expect(scanForCredentials("Set-Cookie: session=abc123; HttpOnly")).toEqual([
      "cookie",
    ]);
    expect(
      scanForCredentials(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
      ),
    ).toEqual(["pem_key"]);
  });

  it("fires on a credential-named env assignment", () => {
    expect(
      scanForCredentials("export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOp"),
    ).toEqual(expect.arrayContaining(["env_assignment"]));
    expect(scanForCredentials("DATABASE_PASSWORD=hunter2hunter2")).toEqual([
      "env_assignment",
    ]);
  });

  it("does NOT fire on high-entropy prose or a bare base64 blob (entropy heuristic excluded)", () => {
    // A 44-char mixed-class base64 blob: scanForSecrets blocks it via the
    // entropy heuristic; scanForCredentials deliberately does not.
    const blob = "Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345";
    expect(scanForSecrets(`blob: ${blob}`)).toContain("high_entropy_token");
    expect(scanForCredentials(`blob: ${blob}`)).toEqual([]);
  });

  it("does NOT fire on a bare git SHA or content hash", () => {
    expect(
      scanForCredentials("commit a887f06d and digest deadbeefcafebabe00112233"),
    ).toEqual([]);
    expect(
      scanForCredentials(
        "sha256: 9f88098daa3be67454cc4cc0e3e34ee20506affac308839891",
      ),
    ).toEqual([]);
  });

  it("does NOT fire on ordinary durable-memory prose", () => {
    expect(
      scanForCredentials(
        "The control service owns the Decision Diff state machine and outbox.",
      ),
    ).toEqual([]);
  });

  it("returns sorted, de-duplicated rule ids and never the secret text", () => {
    // The JWT is full-length on purpose. This fixture used to read `Bearer
    // eyJabc.def.ghi`, a 14-character abbreviation that no real header carries,
    // and it only ever fired `bearer` because the rule then matched the scheme
    // keyword plus any word at all. An abbreviated fixture cannot prove a rule
    // that exists to tell credentials apart from prose BY SHAPE.
    const text =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX and requirepass FAKE";
    const hits = scanForCredentials(text);
    expect(hits).toEqual(["bearer", "jwt", "provider_token", "redis_directive"]);
    expect(hits).toEqual([...hits].sort());
    expect(hits.join(" ")).not.toContain("ghp_");
    expect(hits.join(" ")).not.toContain("eyJhbGci");
    expect(hits.join(" ")).not.toContain("FAKE");
  });

  it("treats empty, null, and undefined as clean", () => {
    expect(scanForCredentials("")).toEqual([]);
    expect(scanForCredentials(null)).toEqual([]);
    expect(scanForCredentials(undefined)).toEqual([]);
  });

  it("every advertised rule id is reachable and entropy is not among them", () => {
    // CREDENTIAL_RULE_IDS is DERIVED from the pattern tables, so it can no longer
    // omit a reachable id. This assertion is the other half: a NEW pattern must
    // be acknowledged here deliberately rather than appearing by itself.
    expect([...CREDENTIAL_RULE_IDS].sort()).toEqual([
      "bearer",
      "cookie",
      "env_assignment",
      "jwt",
      "pem_key",
      "provider_token",
      "redis_directive",
    ]);
    expect(CREDENTIAL_RULE_IDS).not.toContain("high_entropy_token");
  });

  it("every advertised rule id is actually reachable from scanForCredentials", () => {
    // Reachability, proven rather than asserted: one fixture per rule id, and
    // the union of what the scanner returns must be the whole advertised set. A
    // rule that no input can trigger is a lie in the block-reason vocabulary.
    const fixtures: Record<string, string> = {
      env_assignment: "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOp",
      // 20 characters, mixed case, no digit: caught by the bearer rule or by
      // nothing else in the table. It used to read `Bearer abc.def.ghi`, which is
      // 11 characters of lowercase prose and reached this rule only while the
      // rule was broken. A reachability fixture that reaches a rule by exploiting
      // its defect stops proving reachability the moment the defect is fixed.
      bearer: "Authorization: Bearer AbCdEfGhIjKlMnOpQrSt",
      provider_token: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
      jwt: "t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      cookie: "Set-Cookie: session=abc123; HttpOnly",
      pem_key:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
      redis_directive: "requirepass FAKE_VALUE_xyz",
    };
    const reached = new Set<string>();
    for (const id of CREDENTIAL_RULE_IDS) {
      expect(fixtures[id]).toBeDefined();
      expect(scanForCredentials(fixtures[id])).toContain(id);
      for (const hit of scanForCredentials(fixtures[id])) reached.add(hit);
    }
    expect([...reached].sort()).toEqual([...CREDENTIAL_RULE_IDS].sort());
  });
});
