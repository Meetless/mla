import { redact, REDACTED } from "../../src/lib/redactor";
import { scanForCredentials } from "../../src/lib/redactor";

// `env_assignment` carried the SAME defect as `bearer`, one entry above it in the
// table, and it cost four times as many refusals.
//
// The rule was:
//
//     /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|…)|PASSWORD|…)(\s*[:=]\s*)(…|\S+)/gim
//
// Every name alternative is written in SCREAMING_SNAKE, which is the entire signal
// that the thing being assigned is an environment variable rather than an ordinary
// program identifier. The `i` flag deletes that signal: under `/i`, `[A-Z][A-Z0-9_]*`
// matches `scope_key`, and the rule stops meaning "an env var holding a credential"
// and starts meaning "any identifier ending in key, token, secret, or password".
//
// Measured against the real vault (2094 notes) before this file was written:
//
//     with `i`:     140 notes matched
//     without `i`:   46 notes matched
//     the flag's contribution: 53 distinct lowercase names, 410 hits
//
// and the top of that contribution is not credentials, it is domain vocabulary:
// `scope_key` (162), `run_key` (29), `idempotency_key` (25), `issue_key` (15),
// `jira_key` (15), `external_idempotency_key` (13), `inflight_token` (12),
// `project_key`, `identity_key`, `partition_key`, `cache_key`, `dedupe_key`. Under
// `block_on_detect` egress each of those is a REFUSED NOTE, so one flag made 94 notes
// ungovernable in exchange for names nobody would call a secret.
//
// But dropping the flag outright is as wrong as a case-sensitive `(Bearer|Basic)` was:
// it also drops `api_key` (31), `password` (8), `api_token`, `client_secret`,
// `openai_api_key`, `aws_secret_access_key`, `private_key`. Those ARE credentials, and
// they appear lowercased in YAML, JSON, Python and shell all day.
//
// The noise is concentrated entirely in the GENERIC suffix. `scope_key` is noise
// because `key` means "identifier"; `api_key` is signal because `api key` means
// "credential". So the rule splits in two, sharing one id:
//
//   A  today's pattern, case-SENSITIVE. SCREAMING_SNAKE is itself the env-var signal.
//   B  any casing, but the NAME must say credential in WORDS (`api_key`, `client_secret`,
//      `access_token`, `password`), never a bare `_key` / `_token`.
//
// B deliberately carries no uppercase character class and no lookahead, so the `/i`
// trap that broke `bearer` and then `env_assignment` cannot structurally apply to it.
//
// B needs one guard of its own, because a credential WORD appears in code as often as
// in config: `accessToken: string;` is a type annotation, not a secret. Measured, B
// without a guard fires on `string;` (32), `...` (11), `str,` (7), `Optional[str]`,
// `result.accessToken,`, `os.getenv("OPENAI_API_KEY")`. The guard is shape, not a
// dictionary of type names:
//
//     the value must contain at least one alphanumeric, AND
//     a BARE (unquoted) value must be literal-shaped end to end
//
// A quoted value is a literal by construction and needs no shape test. A bare value
// that runs into `;` `,` `)` `[` `(` `{` `$` or a backtick is code, and code is not a
// credential. Net over the vault: 140 notes refused -> 59.
//
// The split also closes a live gap the old rule never covered. `\bPASSWORD` cannot
// match inside `PGPASSWORD` (no word boundary between `PG` and `PASSWORD`) and every
// other alternative requires a literal `_` before the suffix, so `PGPASSWORD=<pw>`,
// `apiKey=<v>` and `clientSecret=<v>` were never redacted by ANY plane. `PGPASSWORD=`
// is not hypothetical: it is in the documented prod psql command.

describe("env_assignment: the casing IS the signal", () => {
  // --- A: SCREAMING_SNAKE still redacts, exactly as before the split ---------
  const ENV_VARS = [
    ["MY_SERVICE_TOKEN=hunter2", "MY_SERVICE_TOKEN="],
    ["DATABASE_PASSWORD=hunter2hunter2", "DATABASE_PASSWORD="],
    ['PASSWORD="hunter2"', "PASSWORD="],
    ["SECRET_FOO='bar baz'", "SECRET_FOO="],
    ["AWS_SECRET_ACCESS_KEY=abc123", "AWS_SECRET_ACCESS_KEY="],
    ["GITHUB_TOKEN=ghp_x", "GITHUB_TOKEN="],
    ["ANTHROPIC_API_KEY: sk-ant-short", "ANTHROPIC_API_KEY:"],
    ["REDIS_PASSWORD=s3cr3t", "REDIS_PASSWORD="],
  ] as const;

  it.each(ENV_VARS)("redacts the value of %s", (input, keptPrefix) => {
    const out = String(redact(input));
    expect(out).toContain(keptPrefix);
    expect(out).toContain(REDACTED);
    // The NAME survives (it is the retrieval key); the VALUE does not.
    expect(out.slice(keptPrefix.length)).not.toMatch(/hunter2|abc123|s3cr3t|ghp_x|bar baz/);
  });

  // --- The defect: domain vocabulary is not a credential ---------------------
  // Every line here is lifted from the real vault, where it cost a refusal.
  const VOCABULARY = [
    "scope_key = tenant.id",
    "scope_key: workspace",
    "run_key = `${sessionId}:${turn}`",
    "idempotency_key = sha256(body)",
    "external_idempotency_key = envelope.id",
    "meetless_idempotency_key = hash",
    "issue_key = PDM-1234",
    "jira_key: PDM-1234",
    "project_key = PDM",
    "identity_key = accountId",
    "partition_key = workspaceId",
    "primary_key = id",
    "cache_key = `${a}:${b}`",
    "object_key = bucket/path",
    "dedupe_key = fingerprint",
    "business_key = externalId",
    "inflight_token = crypto.randomUUID()",
    "server_first_token = frame.token",
  ];

  it.each(VOCABULARY)("leaves domain vocabulary alone: %s", (input) => {
    expect(redact(input)).toBe(input);
  });

  it("does not refuse a note that merely uses the word key", () => {
    for (const line of VOCABULARY) {
      expect(scanForCredentials(line).length).toBe(0);
    }
  });

  // --- B: a credential WORD in any casing IS a credential --------------------
  const CREDENTIAL_WORDS: Array<[string, string]> = [
    ["api_key = sk-live-abcdefgh", "api_key ="],
    ["api_key: hunter2", "api_key:"],
    ["openai_api_key = sk-proj-abcdefgh", "openai_api_key ="],
    ["password: hunter2", "password:"],
    ["passwd=hunter2", "passwd="],
    ["client_secret = abc123xyz", "client_secret ="],
    // Was `abcdefgh` until D9. Eight letters and nothing else is now exempt by
    // shape (see "a bare word is not a value"); the row proves REACHABILITY of the
    // private_key name, so it takes a value that is actually credential-shaped.
    ["private_key = abcdefgh1", "private_key ="],
    ["aws_secret_access_key = abc123", "aws_secret_access_key ="],
    ["signing_secret = whsec-abcdef", "signing_secret ="],
    ["webhook_secret = abcdef123", "webhook_secret ="],
    // camelCase and no-separator forms the old rule could not reach at all.
    ["apiKey = sk-live-abcdefgh", "apiKey ="],
    ["clientSecret = abc123xyz", "clientSecret ="],
    ["authToken = abcdef123456", "authToken ="],
    ["ApiToken=abcdef123456", "ApiToken="],
  ];

  it.each(CREDENTIAL_WORDS)("redacts the value of %s", (input, keptPrefix) => {
    const out = String(redact(input));
    expect(out).toContain(keptPrefix);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/hunter2|abc123xyz|abcdefgh|abcdef123456|whsec-abcdef/);
  });

  // The gap the old rule could never see: no word boundary before PASSWORD, and
  // no underscore before it either, so this shape was never redacted anywhere.
  it("redacts PGPASSWORD, which no plane has ever caught", () => {
    const out = String(redact("PGPASSWORD=tr0ub4dor psql -h 127.0.0.1 -U meetless_prod"));
    expect(out).toContain("PGPASSWORD=");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("tr0ub4dor");
    // The rest of the command survives: a redacted runbook is still a runbook.
    expect(out).toContain("psql -h 127.0.0.1 -U meetless_prod");
  });

  // --- B's own guard: a credential word in CODE is not a credential ----------
  // These are the false positives B introduces if the value side is unguarded.
  // Every one is lifted from the vault.
  const CODE = [
    "accessToken: string;",
    "refreshToken: string;",
    "apiKey: string,",
    "access_token: str,",
    "api_key: Optional[str]",
    'api_key = os.getenv("OPENAI_API_KEY")',
    "const { accessToken } = result.accessToken,",
    "openai_api_key: settings.openai_api_key,",
    "password: this.configService.get(REDIS_PW),",
    "accessToken: {",
    "apiKey: $(grep -m1 KEY .env)",
    "access_token: `${a}`",
  ];

  it.each(CODE)("leaves a code-shaped value alone: %s", (input) => {
    expect(redact(input)).toBe(input);
  });

  it("an empty value is not a credential", () => {
    expect(redact('api_key = ""')).toBe('api_key = ""');
    expect(redact("api_key = ''")).toBe("api_key = ''");
  });

  // --- The residual this test used to pin, and how it was split --------------
  // This block used to assert that BOTH `api_key: str` and `password: postgres`
  // were redacted, on the grounds that a bare lowercase word is indistinguishable
  // by shape from a short secret. That was half right. The two are separated not
  // by the value, which is genuinely tied, but by WHO ISSUES IT: a key is
  // machine-issued and never a bare word, a password is human-chosen and often
  // exactly one. D9 exempts the first and keeps the second. See "a bare word is
  // not a value" below for the measurement.
  it("splits the bare-word residual by who issues the value", () => {
    expect(redact("api_key: str")).toBe("api_key: str");
    expect(redact("password: postgres")).toContain(REDACTED);
    // The Python signature default that cost a real annotation now survives whole.
    expect(redact("api_key: str = None")).toBe("api_key: str = None");
  });

  // --- The split shares one rule id ------------------------------------------
  it("reports both halves under the single id env_assignment", () => {
    expect(scanForCredentials("SECRET_FOO=abc123")).toEqual([
      "env_assignment",
    ]);
    expect(scanForCredentials("client_secret = abc123xyz")).toEqual([
      "env_assignment",
    ]);
    // Both halves in one input still report the id ONCE.
    expect(
      scanForCredentials("SECRET_FOO=abc123 and client_secret = abc123xyz"),
    ).toEqual(["env_assignment"]);
  });
});

// ---------------------------------------------------------------------------
// A REFERENCE is not a VALUE.
//
// D4 gave the lowercase branch a value guard and left the SCREAMING_SNAKE branch
// with `\S+`: anything at all after the `=`. So a setup doc, which is the single
// most credential-shaped document type a team owns, was refused for lines that
// contain no credential by construction:
//
//     SENDGRID_API_KEY=<sendgrid-key>          a placeholder
//     REDIS_PASSWORD=${_REDIS_PASSWORD}        an interpolation
//     EVENT_KEY="$(gen-secret 32)"             a command that MAKES a secret
//     INGEST_SECRET=${{ secrets.INGEST_SECRET }}   a GitHub Actions reference
//     OPENAI_API_KEY=...                       an elision
//     GH_TOKEN=[REDACTED]                      our own output, re-scanned
//
// None of these can BE a credential. `$(cmd)` names a command, `${VAR}` and
// `{{ x }}` name a variable, `<x>` is not legal in any credential literal in any
// format, `...` has no alphanumeric in it at all, and `[REDACTED]` is the string
// this redactor itself writes. This is a shape rule, not a vocabulary: it holds
// without knowing a single English word.
//
// Two shapes are deliberately NOT exempt, and both are pinned below, because
// each is where an over-broad version of this rule would leak:
//
//   * `$` followed by a DIGIT is a bcrypt hash (`$2b$10$...`), not a shell
//     variable. Shell variables start with a letter or an underscore.
//   * a backtick is markdown formatting, and the thing inside markdown backticks
//     is exactly how a human pastes a real key into a note.
//
// The rest of the residual stays refused on purpose. `ANTHROPIC_AUTH_TOKEN=ollama`
// and `PASSWORD=postgres` are the same shape, and one of them is a real password.
// ---------------------------------------------------------------------------
describe("env_assignment: a reference is not a value", () => {
  const REFERENCES = [
    // command substitution: the value is a recipe for a secret, not a secret
    'EVENT_KEY="$(gen-secret 32)"',
    "FALLBACK_KEY=$(openssl rand -hex 32)",
    'CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.claude/token)"',
    // variable interpolation
    "REDIS_PASSWORD=${_REDIS_PASSWORD}",
    "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}",
    "export CONTROL_TOKEN=$MEETLESS_CONTROL_TOKEN",
    // CI / template references
    "INGEST_SECRET=${{ secrets.INGEST_SECRET }}",
    "API_KEY={{ .Values.apiKey }}",
    // angle-bracket placeholders, the lingua franca of a setup doc
    "SENDGRID_API_KEY=<sendgrid-key>",
    "SLACK_SIGNING_SECRET=<your-signing-secret>",
    "COOKIE_SECRET=<64-char-hex>",
    "FORGE_API_TOKEN=<token>",
    // elision: no alphanumeric anywhere in the value
    "OPENAI_API_KEY=...",
    "GEMINI_API_KEY=...",
  ];

  it.each(REFERENCES)("leaves a reference alone: %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanForCredentials(input)).toEqual([]);
  });

  // Idempotence at the SCANNER, not just at the rewriter. `redact` was already
  // idempotent (it rewrites `[REDACTED]` to `[REDACTED]`), but `scanForCredentials`
  // still reported a hit on its own output, so an already-redacted document was
  // refused at the egress boundary for containing the proof it had been redacted.
  it("does not flag its own output", () => {
    const once = String(redact("GH_TOKEN=gh" + "p_16C7e42F292c6912E7710c838347Ae178B4a"));
    expect(once).toBe(`GH_TOKEN=${REDACTED}`);
    expect(redact(once)).toBe(once);
    expect(scanForCredentials(once)).toEqual([]);
  });

  // The two shapes that must NOT be read as references.
  it("a bcrypt hash is a value, not a shell variable", () => {
    // `$` then a DIGIT. A shell variable can never start with a digit.
    const out = String(redact("PASSWORD=$2b$10$N9qo8uLOickgx2ZMRZoMye"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("N9qo8uLOickgx2ZMRZoMye");
  });

  it("markdown backticks do not launder a token", () => {
    // This is how a key actually arrives in a note: pasted into inline code.
    const out = String(redact("SLACK_BOT_TOKEN=`xoxb-1111-2222-aaaabbbbcccc`"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("xoxb-1111-2222-aaaabbbbcccc");
  });

  // The guard applies to BOTH halves of the split, so the lowercase branch
  // cannot drift back to accepting a substitution inside quotes.
  it("applies to the lowercase branch too", () => {
    expect(redact('client_secret = "$(vault read -field=secret)"')).toBe(
      'client_secret = "$(vault read -field=secret)"',
    );
    expect(redact("api_key = <your-key-here>")).toBe("api_key = <your-key-here>");
  });

  // The residual we keep refusing, restated here so this section cannot be read
  // as licence to widen it: a bare word IS the shape of a real short password.
  // A bare word is not a REFERENCE, and this block is about references: nothing
  // here marks `ollama` as pointing somewhere else. D9 exempts it on a different
  // claim (it is not a credential SHAPE), and only for a machine-issued name.
  it("does not exempt a bare word as a reference", () => {
    expect(redact("PGPASSWORD=postgres")).toContain(REDACTED);
    expect(redact("API_KEY=ollamaollamaollama")).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// The reference guard shipped with two holes, and the vault found both.
//
// D5 read "a reference" narrowly: a value that STARTS with a sigil (`$`, `{{`,
// `<`) or has no alphanumeric anywhere (`...`). Measured after it shipped, 45 of
// the 50 still-refused notes were refused by env_assignment, and the residual
// sorted into exactly two more reference shapes that no sigil announces:
//
//   an ELIDED PREFIX      OPENAI_API_KEY=sk-...      SLACK_BOT_TOKEN=xoxb-...
//                         LANGFUSE_PUBLIC_KEY=pk-lf-86...   api_key="om_sk_..."
//
//   a NAME                CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN
//                         client_secret = "YOUR_CLIENT_SECRET"
//                         apiKey: process.env.POSTHOG_API_KEY
//                         self.api_key = api_key
//
// `OPENAI_API_KEY=...` was already exempt and `OPENAI_API_KEY=sk-...` was not,
// which is the same author doing the same thing: eliding. An ellipsis is the
// mark of text REMOVED, and a prefix is what survives elision. Keeping the first
// six characters of a key does not make those six characters a key.
//
// A name is the older half of the same idea. D5 exempted `$MEETLESS_CONTROL_TOKEN`
// because the `$` says "this is a variable", and then refused
// `CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN`, where the `$` is absent because the
// language does not use one. The sigil was never the evidence; the SHAPE is. A
// value that is a legal identifier, or a dotted path of them, ending in a
// credential word is naming a credential, not carrying one.
//
// Hyphens are deliberately NOT identifier characters here. Allowing them would
// exempt `xoxb-test-bot-token` and `test-signing-secret`, which are token-shaped
// strings, not references. No language we ship writes a variable with a hyphen,
// so the restriction costs nothing and closes the whole hyphenated-token family.
//
// Both arms carry a tail anchor, so the exemption applies to the WHOLE value and
// not to a prefix of one: `API_KEY=SECRET_KEYabc123def456` is still a refusal.
//
// Accepted residual, stated so it cannot be discovered as a surprise: a password
// that is itself spelled like a credential name (`api_key = my_secret_key`) is
// now exempt. It is the same trade the rest of this rule already makes in the
// other direction, and a secret whose text is a legal identifier ending in the
// word "key" is a placeholder in every instance the vault contains.
// ---------------------------------------------------------------------------
describe("env_assignment: an elision and a name are references too", () => {
  // An elided prefix. Every one of these is a real vault line.
  const ELIDED = [
    "OPENAI_API_KEY=sk-...",
    "SLACK_BOT_TOKEN=xoxb-...",
    "SLACK_APP_TOKEN=xapp-...",
    "POSTHOG_PERSONAL_API_KEY=phx_...",
    "LANGFUSE_PUBLIC_KEY=pk-lf-86...",
    "LANGFUSE_SECRET_KEY=sk-lf-96...",
    'api_key="om_sk_..."',
    "OPENAI_API_KEY=sk-proj-AbCdEf...",
  ];

  it.each(ELIDED)("leaves an elided prefix alone: %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanForCredentials(input)).toEqual([]);
  });

  // A name, bare or dotted. Also all real vault lines.
  const NAMES = [
    "CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN",
    'client_secret = "YOUR_CLIENT_SECRET"',
    'password = "YOUR_PASSWORD"',
    'UPSERT_BY_KEY = "UPSERT_BY_KEY"',
    'SAME_JIRA_KEY = "same_jira_key"',
    "NODE_AUTH_TOKEN: secrets.NPM_TOKEN",
    "controlApiKey: process.env.CONTROL_API_KEY",
    "apiKey: process.env.POSTHOG_API_KEY",
    "self.api_key = api_key",
    "final_api_key = api_key",
  ];

  it.each(NAMES)("leaves a name alone: %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanForCredentials(input)).toEqual([]);
  });

  // The tail anchor: the exemption is for the WHOLE value, never a prefix of it.
  it("does not let a name-shaped prefix launder a value", () => {
    const out = String(redact("API_KEY=SECRET_KEYabc123def456"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("SECRET_KEYabc123def456");
    const dotted = String(redact("API_KEY=process.env.MY_KEYabc123def456"));
    expect(dotted).toContain(REDACTED);
    expect(dotted).not.toContain("MY_KEYabc123def456");
  });

  it("does not let an elision prefix launder a value", () => {
    const out = String(redact("API_KEY=abc...def456ghi789"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("def456ghi789");
  });

  // A hyphenated string is not an identifier, so it is not a reference.
  //
  // D15 re-opened this line on a DIFFERENT claim and was killed here, so the
  // argument is recorded rather than left to be rediscovered a third time. The
  // second claim is not "it is a reference" but "it is a PLACEHOLDER: the field's
  // own name written back where a value goes". The proposed fix was to widen this
  // guard's separator from `_` to `[_-]`, making `API_KEY=your-secret-key` as
  // exempt as `API_KEY=your_secret_key` already is.
  //
  // Measured over the real vault first, as every rule change here is: 5 notes of
  // 2094 freed (0.24%), 17 lines exempted, and all 17 genuinely were the field's
  // own name written back. The corpus voted yes. The corpus was not the test.
  //
  // What kills it is the shape the corpus does not contain. This guard exempts the
  // WHOLE value up to a delimiter, so widening the separator exempts anything
  // identifier-shaped that merely ENDS in a credential word, at any length and any
  // entropy:
  //
  //     API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-key
  //
  // is 40 characters of mixed-case base62, and `env_assignment` is the ONLY
  // credential rule that fires on it (`high_entropy_token` matches but is not in
  // CREDENTIAL_RULE_IDS, so it never refuses). Exempt it and that line egresses
  // with zero blockers. Under `block_on_detect` a refused document costs a
  // document and a false negative costs the credential, so 0.24% of the vault does
  // not buy it.
  //
  // The placeholder claim is undecidable by shape in any case.
  // `INTERNAL_API_KEY=dev-internal-key` is indistinguishable from a real dev
  // credential that happens to have no entropy, which is the sentence
  // `PGPASSWORD=postgres` already lost with three describes above: a zero-entropy
  // credential is a bad credential, not a non-credential. Deciding it would require
  // knowing whether the value is live, and "this one is only a test token" is
  // precisely the sentence an exfiltration would need to produce.
  it("does not exempt a hyphenated token shape", () => {
    for (const line of [
      "SLACK_BOT_TOKEN=xoxb-test-bot-token",
      "SLACK_SIGNING_SECRET=test-signing-secret",
      "CONTROL_API_KEY=test-internal-key",
      "ALLOWED_AGENT_API_KEY=your-secret-key",
      // The one that decides it. A credential-word SUFFIX cannot buy an exemption,
      // because the exemption it buys covers everything in front of it.
      "API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-key",
    ]) {
      expect(redact(line)).toContain(REDACTED);
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
  });

  // So the reference guard is deliberately NOT symmetric across separators. `_` is
  // identifier syntax, so `my_api_key` can only be a name. `-` is not, so
  // `my-api-key` is a literal string and nothing vouches for what is in it.
  it("exempts the snake-case name but not its kebab twin", () => {
    expect(scanForCredentials("API_KEY=my_api_key")).toEqual([]);
    expect(scanForCredentials("API_KEY=my-api-key")).toEqual(["env_assignment"]);
  });

  // The unelided form of the very same key still goes.
  it("keeps refusing the key the elision was hiding", () => {
    const out = String(redact("OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });
});

// ---------------------------------------------------------------------------
// A BARE WORD is not a value.
//
// D7 left 80 matches across 34 notes. Classified against the real vault, the
// dominant survivor is not a credential and not even a reference: it is an
// ordinary English or programming word sitting where a value would be.
//
//     api_key: str | None = None,              a Python type annotation
//     const accessToken = await getAccess…     a keyword
//     export ANTHROPIC_AUTH_TOKEN=ollama       a config value that is not secret
//     api_token: Confluence API token          prose, mid-sentence
//     RATE_LIMIT_KEY = "rateLimit"             an identifier constant
//     [REDACTED_SECRET:JWT]                    OUR OWN redaction marker
//
// The shape claim: a value that is nothing but letters, at most 12 of them, is
// not a credential. It is measured, not intuited. Across all 2094 notes there is
// not ONE true positive whose value is letters-only, because every real
// credential format forces a digit or punctuation into the string: base64 and
// base64url carry both cases plus digits, hex is digits by definition, a uuid has
// hyphens, and every provider prefix (`sk-`, `xoxb-`, `ghp_`, `AKIA`) is a
// prefix precisely so it can be recognised. The 12-character ceiling is what
// keeps a letters-only passphrase blocked.
//
// The guard is NOT applied when the NAME is in the password family, and that
// exception is the whole reason this arm is safe. An API key, token or secret is
// MACHINE-issued, so a bare word in that slot is never the credential. A password
// is HUMAN-chosen, and a short lowercase word is the single commonest real
// password shape there is. Measured, the exception is worth exactly three
// matches, all of them `PGPASSWORD=postgres` in a local psql runbook, and that is
// a working credential for a real database. Blocking it is the rule doing its
// job, not a false positive.
//
// Net over the vault: 80 matches -> 57, 34 notes -> 19, 15 notes fully released,
// zero true positives freed, zero password-family matches freed.
//
// SECRET-1: no real credential value appears in this file.
// ---------------------------------------------------------------------------
describe("env_assignment: a bare word is not a value", () => {
  // Every one of these is a real vault line, verbatim.
  const BARE_WORDS = [
    "        api_key: str | None = None,",
    'cohere_api_key: str = ""',
    "  const accessToken = await getAccessToken();",
    "    accessToken: string;",
    "export ANTHROPIC_AUTH_TOKEN=ollama",
    "            api_token: Confluence API token",
    "#   ~/.hermes/.env:  GEMINI_API_KEY / GOOGLE_API_KEY = dedicated restricted key",
    'export const RATE_LIMIT_KEY = "rateLimit";',
    '- `MCP_SERVER_KEY = "meetless"` (currently wire.ts:788)',
    "  raise ValueError(EXPECTED_SECRET = raise)",
  ];

  it.each(BARE_WORDS)("leaves a bare word alone: %s", (input) => {
    expect(redact(input)).toBe(input);
    expect(scanForCredentials(input)).toEqual([]);
  });

  // Our own marker. A redactor whose output trips its own scanner cannot be run
  // twice over the same text, and the vault holds notes that DOCUMENT the marker.
  it("does not re-flag its own redaction marker", () => {
    expect(redact("- `[REDACTED_SECRET:JWT]`")).toBe("- `[REDACTED_SECRET:JWT]`");
    expect(scanForCredentials("- `[REDACTED_SECRET:JWT]`")).toEqual([]);
    // Idempotence, stated directly.
    const once = String(redact("OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx"));
    expect(redact(once)).toBe(once);
  });

  // `\s*` spans a newline under /m, so a NAME ending a prose line takes the first
  // word of the NEXT line as its value. Real vault lines, adjacent.
  it("does not read the next line's first word as a value", () => {
    const input = "# live (small set), needs OPENAI_API_KEY:\nexport $(grep -E '^X=' .env)";
    expect(scanForCredentials(input)).toEqual([]);
  });

  // ---- a value lives on the SAME LINE as its name ------------------------
  // The case above was green for the WRONG REASON. `export` is a bare word the
  // exemption above already frees, so it never exercised the separator at all.
  // The separator is `(\s*[:=]\s*)`, and `\s` matches `\n`: a name that ENDS a
  // line therefore reaches across the break and adopts the first token of the
  // next line as its value. `key_parts` is not letters-only, so nothing above
  // frees it, and the line it comes from is not an assignment at all: it is a
  // Python block opener, `if ... == IdempotencyStrategy.UPSERT_BY_KEY:`, whose
  // colon is syntax and whose "value" was an identifier on the following line.
  // Measured over the vault, that shape refused 2 notes, and both were invisible
  // to a per-line scan: the defect only exists when the two lines are read
  // together, which is exactly how a document is sent.
  it("does not cross a newline to find a value", () => {
    const input =
      "        if self.idempotency_strategy == IdempotencyStrategy.UPSERT_BY_KEY:\n" +
      "            key_parts = [args.get(f) for f in self.idempotency_key_fields]";
    expect(scanForCredentials(input)).toEqual([]);
    expect(redact(input)).toBe(input);
  });

  it("does not cross a newline even when the next line is a real credential", () => {
    // Stated as the safety check it is: the value does not move to the name, but
    // it is still redacted where it actually sits, by the rules that own it.
    const input = "OPENAI_API_KEY:\nsk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
    const out = String(redact(input));
    expect(out).toBe(`OPENAI_API_KEY:\n${REDACTED}`);
  });

  it("still binds a value separated by spaces or tabs on the same line", () => {
    const input = "API_KEY \t=\t abcdefghijk1";
    expect(scanForCredentials(input)).toContain("env_assignment");
    expect(redact(input)).toBe(`API_KEY \t=\t ${REDACTED}`);
  });

  it("does not let a later line's bare word exempt this line's value", () => {
    // The guard's separator is mirrored so both halves agree on what a line is.
    // Honest about what this pins: measured over the vault, the mirroring is
    // INVISIBLE once the rule itself is same-line, so no fixture can go red on
    // it alone. What this does pin is the direction that matters: a real value
    // on this line stays refused no matter what sits on the next one.
    const input = "API_KEY=abcdefabcdefabcdef\nnote: str";
    const out = String(redact(input));
    expect(out).toBe(`API_KEY=${REDACTED}\nnote: str`);
  });

  // ---- a PHRASE is a credential shape, not a placeholder -----------------
  // TRIED, MEASURED, REJECTED. Written down because the idea is a good one and
  // whoever reads D9 next will have it again.
  //
  // D9 freed a bare word. The dominant survivor after it is the same word with a
  // hyphen in the middle: a placeholder a human typed for a reader, spelled the
  // way humans spell things.
  //
  //     INTERNAL_API_KEY=dev-internal-key
  //     CONTROL_API_KEY=your-dev-api-key
  //     SLACK_CLIENT_SECRET=your-app-client-secret
  //     accessToken: 'jira-test-token',
  //
  // The proposed claim: a machine-issued key is one high-entropy RUN, and every
  // issuer forces a digit or structural punctuation into that run, so a value
  // that is only letter-words joined by `-` or `_` is not a run at all. Widen the
  // guard arm to `[A-Za-z]{1,12}(?:[-_][A-Za-z]{1,12})*` and the 12-letter
  // ceiling applies PER SEGMENT. Over the vault it measures beautifully: 19
  // matches freed, ZERO in the password family, notes carrying an env_assignment
  // hit 17 -> 9, and every credential-shaped value in the corpus still refused.
  //
  // It is wrong anyway, and the corpus is exactly what hid that: every true
  // positive in this vault happens to carry a digit, which is a fact about the
  // vault and not about credentials. The next two rows are the falsification.
  // They are asserted rather than described, so the rejection cannot rot.
  it("refuses a phrase, because a phrase is how a short issuer key is spelled too", () => {
    // `sk-live-abcdefgh` is letter-words joined by hyphens, exactly like
    // `your-dev-api-key`; widening the arm frees BOTH. `provider_token` re-catches
    // the issuer family only once the body reaches its own length floor
    // (`sk-live-abcdefghijkl` and up), so the layered defence has a hole precisely
    // where the value is short. These three come from "the casing IS the signal"
    // above, and widening the arm turned all of them green-to-red.
    for (const line of ["api_key = sk-live-abcdefgh", "signing_secret = whsec-abcdef", "GITHUB_TOKEN=ghp_x"]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
  });

  it("refuses a phrase, because the 12-letter ceiling IS the safety argument", () => {
    // BARE_WORD is safe because it exempts at most 12 letters, under 9 bytes, and
    // no issuer mints a 9-byte credential. That bound is the whole argument, and
    // per-SEGMENT it is gone: the first value below is a diceware passphrase with
    // roughly 100 bits in it, and neither name is in the password family. Note
    // what does NOT save us there: `high_entropy_token` matches that line, but it
    // is not in CREDENTIAL_RULE_IDS, so under `block_on_detect` (where the body is
    // never rewritten) it produces no refusal at all and the passphrase egresses
    // intact. Bounding the phrase does not rescue the claim either; a
    // 24-character cap still admits a five-word, ~64-bit passphrase.
    expect(scanForCredentials("APP_SECRET=alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel")).toContain("env_assignment");
    expect(scanForCredentials("SECRET_KEY=correct-horse-battery-staple")).toContain("env_assignment");
  });

  it("holds the ceiling across `_` and `/` too, which is where the prose residuals get their answer", () => {
    // The first two lines are the entire measured cost of the optional prefix over the
    // 2094-note vault: a colon-terminated prose LABEL whose last word is a credential
    // noun, followed by an English sentence. The rule comment states them. Here they are
    // executable, because a comment does not fail when a later change exempts them.
    //
    // The tempting fix is to let a `_`- or `/`-joined run of short lowercase words buy the
    // bare-word exemption, since that is exactly what both values are. Measured against
    // the rule, that change frees both prose lines AND frees the third line below, a
    // diceware passphrase with roughly 100 bits in it under a name in no password family.
    // The two HYPHEN-joined passphrases above do not move under it, so they cannot catch
    // it; the underscore twin is the one that fails. That is why it is pinned here and
    // why the two residuals are a price rather than a bug.
    for (const line of [
      "KEY: obligation_strength and intent are independent axes",
      "INV-EVIDENCE-NO-RAW-SECRET: agent/session/file evidence",
      "SECRET=correct_horse_battery_staple",
    ]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
    // The name survives, so a refused prose line stays readable and searchable.
    expect(String(redact("KEY: obligation_strength and intent are independent axes"))).toBe(`KEY: ${REDACTED} and intent are independent axes`);
  });

  it("keeps refusing the placeholders, which is the price of the two rows above", () => {
    // Real vault lines, every one a placeholder. They stay refused and their
    // documents stay ungoverned, deliberately: separating them from a passphrase
    // needs intent, and reading intent means a dictionary of placeholder words,
    // which is the class rejected at the start of this work. A false positive
    // costs a refused document; a false negative is a leak.
    for (const line of [
      "ALLOWED_AGENT_API_KEY=your-secret-key",
      "   INTERNAL_API_KEY=dev-internal-key",
      "SLACK_CLIENT_SECRET=your-app-client-secret",
      "CONTROL_API_KEY=your-dev-api-key",
      "    accessToken: 'jira-test-token',",
      'EXPECTED_SECRET = "super-long-random-string"  # from env',
    ]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
  });

  // ---- the password family keeps the strict test -------------------------
  // A password is human-chosen. A short lowercase word IS the shape of a real
  // one, so the exemption above must not reach it. `PGPASSWORD=postgres` is a
  // real vault line and a working local credential.
  const PASSWORDS = [
    "PGPASSWORD=postgres psql -h 127.0.0.1 -U meetless -d control_dev",
    "export PGPASSWORD=postgres",
    "PASSWORD=letmein",
    "DB_PASSWORD: hunter",
    "db_passwd = correct",
    "REDIS_PWD=swordfish",
  ];

  it.each(PASSWORDS)("keeps blocking a human-chosen password: %s", (input) => {
    expect(scanForCredentials(input)).toContain("env_assignment");
    expect(String(redact(input))).toContain(REDACTED);
  });

  // ---- anti-laundering ---------------------------------------------------
  it("holds the 12-character ceiling", () => {
    // 12 letters is exempt; 13 is not. The ceiling is the whole defence against
    // a letters-only passphrase, so it gets a test that fails if it drifts.
    expect(scanForCredentials("API_KEY=abcdefghijkl")).toEqual([]);
    expect(scanForCredentials("API_KEY=abcdefghijklm")).toContain("env_assignment");
  });

  it("does not exempt a value carrying a digit or punctuation", () => {
    for (const line of [
      "API_KEY=abcdefgh123",
      "API_KEY=abc-def",
      "API_KEY=abc_def",
      "API_KEY=abc.def",
      "api_key: strabc123",
    ]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
  });

  // Accepted exemption, stated so it is not discovered as a surprise: a value that
  // is letters-only and at most 12 characters is exempt even when it is base64,
  // because 12 base64 characters carry at most 9 bytes and no issuer mints a
  // 9-byte credential. Everything longer, and everything with a digit or `=`
  // padding, is still refused.
  it("accepts that a <=12 letters-only base64 payload is exempt", () => {
    expect(scanForCredentials("API_KEY=YWJjZGVm")).toEqual([]);
    expect(scanForCredentials("API_KEY=YWJjZGVmZ2hpams=")).toContain("env_assignment");
  });

  it("exempts the WHOLE value, never a prefix of it", () => {
    // The tail anchor. `str` is exempt; `strabcdefghijklmnop` must not inherit it.
    const out = String(redact("API_KEY=abcdefabcdefabcdef"));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("abcdefabcdefabcdef");
  });

  it("still catches every credential the earlier fixes catch", () => {
    // A regression net across the whole rule, not just this arm.
    for (const line of [
      "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
      "SLACK_BOT_TOKEN=xoxb-test-bot-token",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      'client_secret: "abc123def456ghi789"',
    ]) {
      expect(String(redact(line))).toContain(REDACTED);
    }
  });
});

// D13. `APP_SECRET=<value>` is REFUSED and `SECRET=<the identical value>` EGRESSES.
//
// Entry A's name alternation is `[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|…)`: the prefix
// and the underscore joining it are MANDATORY, so the credential word only counts as
// a name when something else is glued in front of it. The bare word, which is the
// most direct way anyone writes the thing, matches nothing.
//
// This is a false NEGATIVE, and under `block_on_detect` a false negative is a leak
// while a false positive is only a refused document. It is also backwards on its own
// terms: `SECRET` is not a weaker credential claim than `APP_SECRET`, it is a
// stronger one, because there is no qualifier to make it mean something else.
//
// `high_entropy_token` does match these lines, and that rescues nothing: it is not in
// CREDENTIAL_RULE_IDS, so under `block_on_detect` (where the body is never rewritten)
// it produces no refusal at all and the value egresses intact. Assert against
// `scanForCredentials`, which is what the egress gate actually consults.
describe("env_assignment: a credential name that stands alone is still a credential name", () => {
  // Synthetic, never a real credential: 28 chars, mixed case, digits.
  const VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

  it("refuses the bare SCREAMING_SNAKE credential word", () => {
    for (const name of ["SECRET", "TOKEN", "KEY", "API_KEY", "APP_SECRET", "PASSWORD"]) {
      expect(scanForCredentials(`${name}=${VALUE}`)).toContain("env_assignment");
    }
  });

  it("does not read a credential word out of the tail of an ordinary one", () => {
    // The leading `\b` is what keeps this honest: there is no word boundary before
    // the `KEY` inside `MONKEY`, so an optional prefix cannot turn every word that
    // happens to end in a credential noun into a credential name.
    for (const line of [`MONKEY=${VALUE}`, `DONKEY=${VALUE}`, `TURNKEY=${VALUE}`]) {
      expect(scanForCredentials(line)).toEqual([]);
    }
  });

  it("keeps the name and redacts only the value", () => {
    const out = String(redact(`SECRET=${VALUE}`));
    expect(out).toBe(`SECRET=${REDACTED}`);
  });

  it("still exempts a reference and a bare word under the standalone name", () => {
    // The value guards are shared, so widening the NAME must not widen the VALUE.
    for (const line of ["SECRET=$VAULT_SECRET", "SECRET=${VAULT_SECRET}", "TOKEN=<your-token>", "KEY=[REDACTED]", "SECRET=changeme"]) {
      expect(scanForCredentials(line)).toEqual([]);
    }
  });
});

// A passphrase IS a password, and the word list did not know it. `DB_PASSWORD=<v>`
// was refused while `DB_PASSPHRASE=<the identical v>` egressed, which is the same
// false NEGATIVE shape as the standalone-word gap above: the name list was a list of
// spellings, and one spelling was missing. For an SSH or PGP key the passphrase is
// not an accessory to the credential, it IS the credential.
//
// `passphrase` goes in BOTH places, and the second is load-bearing. The word list
// makes `passphrase: <high-entropy value>` a refusal. The password-family head of the
// BARE_WORD guard is what makes `passphrase: hunter` a refusal too: a passphrase is
// HUMAN-chosen, so a short lowercase word is a real one, exactly as it is for
// `PGPASSWORD=postgres`. Machine-issued names (`API_KEY=rateLimit`) keep the
// exemption, so the family half is precisely targeted and not a general widening.
//
// Cost, measured over the 2094-note vault before applying it: ZERO new matches for
// the word list, and ZERO for the password-family half.
describe("env_assignment: a passphrase is a password", () => {
  const VALUE = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

  it("refuses a passphrase in every casing and separator the vault uses", () => {
    for (const line of [
      `DB_PASSPHRASE=${VALUE}`,
      `PASSPHRASE=${VALUE}`,
      `ssh_passphrase: ${VALUE}`,
      `key_passphrase = ${VALUE}`,
      `gpgPassphrase=${VALUE}`,
    ]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
    }
  });

  it("treats it as human-chosen, so a short lowercase word is still a value", () => {
    for (const line of ["passphrase: hunter", "PASSPHRASE=postgres", "passphrase = swordfish"]) {
      expect(scanForCredentials(line)).toContain("env_assignment");
      expect(String(redact(line))).toContain(REDACTED);
    }
    // The family exemption is targeted: a machine-issued name keeps BARE_WORD.
    expect(scanForCredentials("API_KEY=rateLimit")).toEqual([]);
  });

  it("keeps the name and redacts only the value", () => {
    expect(String(redact(`PASSPHRASE=${VALUE}`))).toBe(`PASSPHRASE=${REDACTED}`);
  });

  it("still exempts a reference under the new name", () => {
    for (const line of [
      "PASSPHRASE=$VAULT_PASSPHRASE",
      "PASSPHRASE=${VAULT_PASSPHRASE}",
      "PASSPHRASE=<your-passphrase>",
      "PASSPHRASE=[REDACTED]",
    ]) {
      expect(scanForCredentials(line)).toEqual([]);
    }
  });

  // RULED, and the measurement is the whole reason: `credential` is NOT added.
  //
  // It looks like the same free win as `passphrase` and it measures like one too:
  // zero new matches over the same 2094-note vault, for both `credential` and
  // `credentials?`. That number is evidence about THIS corpus, never proof of
  // absence, and probing the shapes the corpus lacks is what killed it. Adding it
  // refuses `credentials: "same-origin"` and `credentials: same-origin` (the fetch
  // API), `credentials: application-default` (gcloud), and
  // `google_credentials: /etc/gcp/key.json` (a path, not a secret). All four are
  // ordinary lines in engineering notes, and none is a credential.
  //
  // The case FOR it was `X-Amz-Credential=<sts key id>`, which is a genuine
  // credential in this very vault. It does not match anyway: the value carries `%`
  // from the percent-encoded scope, and `%` is not in the value class, so the arm's
  // `(?=\s|$)` tail fails. `provider_token` catches that line instead, which is
  // exactly the layering working. So the word buys nothing real and costs a
  // documented false-positive class.
  //
  // The difference from `passphrase` is that `passphrase` names ONLY a credential,
  // while `credentials` is also the name of a config MODE. A name that has a
  // non-credential meaning in common use is not a credential name.
  it("does NOT treat `credential` as a credential name, deliberately", () => {
    expect(scanForCredentials('credentials: "same-origin"')).toEqual([]);
    expect(scanForCredentials("credentials: application-default")).toEqual([]);
    expect(scanForCredentials("google_credentials: /etc/gcp/key.json")).toEqual([]);
    expect(scanForCredentials(`credential: ${VALUE}`)).toEqual([]);
  });
});
