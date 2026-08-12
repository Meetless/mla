import test from "node:test";
import assert from "node:assert/strict";

import { redact, REDACTED } from "./redactor.js";

// Plane-parity lock for the shared redactor (principle 7 of
// notes/20260528-mla-logging-and-tracing-proposal.md). MIRROR of
// packages/cli/test/lib/redactor-parity.spec.ts,
// apps/control/src/core/services/redactor.parity.spec.ts and
// intel/tests/observability/test_redaction_parity.py.
//
// Every PARITY_CASES entry below must match the corresponding entries
// byte-for-byte across all four specs. If you add a case here, add it
// to the other three AT THE SAME TIME. If a case fails here only, the
// ask-core ESM redactor has drifted from the contract.

const PARITY_CASES = [
  {
    name: "env_assignment_openai",
    // The NAME survives, only the VALUE goes. A variable name is not a
    // credential, and it is usually the primary retrieval key: an operator
    // asking "which key did that command set?" gets an answer from
    // "OPENAI_API_KEY=[REDACTED]" and nothing at all from a bare "[REDACTED]".
    input: "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    expectedRedacted: `export OPENAI_API_KEY=${REDACTED}`,
  },
  {
    name: "env_assignment_anthropic_quoted",
    input: 'ANTHROPIC_API_KEY="sk-ant-api03-abcdefghijklmnop"',
    expectedRedacted: `ANTHROPIC_API_KEY=${REDACTED}`,
  },
  {
    name: "env_assignment_aws_pair",
    input: "AWS_ACCESS_KEY_ID=AKIA" + "IOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expectedRedacted: `AWS_ACCESS_KEY_ID=${REDACTED} AWS_SECRET_ACCESS_KEY=${REDACTED}`,
  },
  {
    name: "env_assignment_generic_secret_var",
    // Not a known provider: caught by the generic `*_TOKEN` suffix rule, so
    // name preservation is not a hardcoded allowlist of vendor variables.
    input: "MY_SERVICE_TOKEN=hunter2 launched",
    expectedRedacted: `MY_SERVICE_TOKEN=${REDACTED} launched`,
  },
  {
    name: "env_assignment_multiple_in_one_command",
    input:
      "export GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWX && export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    expectedRedacted: `export GH_TOKEN=${REDACTED} && export OPENAI_API_KEY=${REDACTED}`,
  },
  {
    name: "env_assignment_quoted_value_with_space",
    // The quoted alternatives exist for exactly this: a bare `\S+` stops at
    // the space and leaves `baz'` in the clear.
    input: "SECRET_FOO='bar baz' PASSWORD=\"hunter2\"",
    expectedRedacted: `SECRET_FOO=${REDACTED} PASSWORD=${REDACTED}`,
  },
  {
    name: "env_assignment_long_name_eaten_by_entropy",
    // Honest residual, pinned so it stays a decision and not a surprise. The
    // entropy sweep runs after env_assignment and does not know the name was
    // deliberately preserved, so a 32+ char SCREAMING_SNAKE name clears the
    // 2-class / 3.5 bar and goes too. That is over-redaction, never a leak,
    // and never worse than the whole-match behaviour this replaced. See the
    // "retrieval" counterpart test below: the 3-class bar keeps such names.
    input: "MEETLESS_PRODUCTION_INTERNAL_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    expectedRedacted: `${REDACTED}=${REDACTED}`,
  },
  {
    name: "path_shaped_token_eaten_at_rest",
    // The four-plane lock for the "events" profile (ruling section 7, test 6).
    // This token is EXEMPT under "events". At the DEFAULT, on every plane, it
    // must still be redacted. See the events block below for the exempt half.
    input: "apps/control/src/coordination-case/coordination-case-projection",
    expectedRedacted: REDACTED,
  },
  {
    name: "bearer_in_curl",
    input: 'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.payload.sig" api.example.com',
    expectedRedacted: `curl -H "Authorization: ${REDACTED}" api.example.com`,
  },
  {
    name: "bearer_scheme_word_is_not_a_credential",
    // "Bearer" and "Basic" are also ordinary English. The rule used to match the
    // keyword plus any word, which fired 517 times across 262 of 2094 real notes
    // and caught no credential a sibling rule missed. Under block_on_detect egress
    // each hit is a refused document, not a redacted one.
    input: "a Bearer token for the basic implementation",
    expectedRedacted: "a Bearer token for the basic implementation",
  },
  {
    name: "bearer_long_prose_tail_is_not_a_credential",
    // 22 characters, so the length floor alone does not save it. All-lowercase and
    // digitless is what makes it prose.
    input: "Authorization: Bearer worker-callback-jwt",
    expectedRedacted: "Authorization: Bearer worker-callback-jwt",
  },
  {
    name: "bearer_short_opaque_token_no_digit",
    // The other direction: 20 characters, mixed case, no digit. Too short for the
    // entropy sweep (32-char floor) and matched by no prefix rule, so this one is
    // caught by the bearer rule or by nothing at all.
    input: "Bearer AbCdEfGhIjKlMnOpQrSt",
    expectedRedacted: REDACTED,
  },
  {
    name: "basic_short_base64_credential_pair",
    // Why the `Basic` floor is 12 and not 16: the payload is base64("user:pass"),
    // and base64 spends 4 characters on every 3 bytes, so a 9-byte credential pair
    // is only 12 characters wide. A uniform 16 floor let this one walk straight
    // through the egress scanner.
    input: "Authorization: Basic dXNlcjpwYXNz",
    expectedRedacted: `Authorization: ${REDACTED}`,
  },
  {
    name: "basic_camelcase_prose_is_an_accepted_residual",
    // Pinned so it stays a decision and not a surprise. A 12-char CamelCase word
    // after a scheme keyword has exactly the shape of a short base64 pair, so the
    // price of catching the case above is over-redacting this one. Measured at 3
    // such phrases across 2094 real notes. Over-redaction, never a leak.
    input: "Basic Conversation",
    expectedRedacted: REDACTED,
  },
  {
    name: "env_generic_key_suffix_is_not_a_credential",
    // env_assignment carried the same /i defect as bearer. Under the flag its
    // SCREAMING_SNAKE classes matched `scope_key`, and the rule became "any
    // identifier ending in key/token/secret/password": 140 of 2094 notes refused,
    // led by scope_key (162 hits), idempotency_key, issue_key, jira_key.
    input: "scope_key = tenant.id and issue_key = PDM-1234",
    expectedRedacted: "scope_key = tenant.id and issue_key = PDM-1234",
  },
  {
    name: "env_credential_word_survives_lowercasing",
    // The other half: dropping /i entirely would be as wrong as a case-sensitive
    // (Bearer|Basic) was. `api_key`, `password` and `client_secret` are real and
    // routinely lowercase. The name has to say credential in WORDS, not by suffix.
    input: "client_secret = abc123xyz",
    expectedRedacted: `client_secret = ${REDACTED}`,
  },
  {
    name: "env_pgpassword_has_no_word_boundary",
    // A gap no plane ever covered: `\bPASSWORD` cannot match inside `PGPASSWORD`,
    // and every other name alternative requires a literal `_` before the suffix.
    // This exact shape is in our own documented prod psql command.
    input: "PGPASSWORD=tr0ub4dor psql -h 127.0.0.1",
    expectedRedacted: `PGPASSWORD=${REDACTED} psql -h 127.0.0.1`,
  },
  {
    name: "env_type_annotation_is_not_a_credential",
    // A credential word appears in code as often as in config. The guard is shape,
    // not a dictionary of type names: a bare value that runs into `;` is code.
    input: "accessToken: string;",
    expectedRedacted: "accessToken: string;",
  },
  {
    name: "env_empty_value_is_not_a_credential",
    input: 'api_key = ""',
    expectedRedacted: 'api_key = ""',
  },
  // A REFERENCE is not a VALUE. `$(cmd)` names a command, `${VAR}` and `{{ x }}`
  // name a variable, `<x>` is not legal in any credential literal in any format,
  // and `[REDACTED]` is this redactor's own output. None of them can BE a
  // credential, so a setup doc built out of them is not a leak.
  {
    name: "env_command_substitution_is_not_a_value",
    input: 'EVENT_KEY="$(gen-secret 32)"',
    expectedRedacted: 'EVENT_KEY="$(gen-secret 32)"',
  },
  {
    name: "env_interpolation_is_not_a_value",
    input: "REDIS_PASSWORD=${_REDIS_PASSWORD}",
    expectedRedacted: "REDIS_PASSWORD=${_REDIS_PASSWORD}",
  },
  {
    name: "env_angle_placeholder_is_not_a_value",
    input: "SENDGRID_API_KEY=<sendgrid-key>",
    expectedRedacted: "SENDGRID_API_KEY=<sendgrid-key>",
  },
  {
    name: "env_redacted_marker_is_not_a_value",
    input: `GH_TOKEN=${REDACTED}`,
    expectedRedacted: `GH_TOKEN=${REDACTED}`,
  },
  // The other edge of the same rule: `$` followed by a DIGIT is a bcrypt hash,
  // never a shell variable, and it stays redacted.
  {
    name: "env_bcrypt_hash_is_still_a_value",
    input: "PASSWORD=$2b$10$N9qo8uLOickgx2ZMRZoMye",
    expectedRedacted: `PASSWORD=${REDACTED}`,
  },
  {
    name: "github_pat_literal",
    input: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
    expectedRedacted: `token=${REDACTED}`,
  },
  {
    name: "slack_token_literal",
    input: "xox" + "b-1234567890-abcdefghij and rest",
    expectedRedacted: `${REDACTED} and rest`,
  },
  {
    name: "google_api_key_literal",
    input: "key=AIzaSyA-1234567890abcdefghijklmnopqrstuv",
    expectedRedacted: REDACTED,
  },
  {
    name: "jwt_whole_token",
    input:
      "session token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQfakesig here",
    expectedRedacted: `session token ${REDACTED} here`,
  },
  {
    name: "set_cookie_header",
    input: "Set-Cookie: session=abc123; HttpOnly; Path=/",
    expectedRedacted: REDACTED,
  },
  {
    name: "cookie_name_list_is_not_a_value",
    input: "Cookie: ml_access, ml_refresh",
    expectedRedacted: "Cookie: ml_access, ml_refresh",
  },
  {
    name: "cookie_empty_value_is_not_a_value",
    input: "Set-Cookie: ml_refresh=;",
    expectedRedacted: "Set-Cookie: ml_refresh=;",
  },
  {
    name: "cookie_attributes_are_not_values",
    input: "Set-Cookie: ml_session=...; HttpOnly; Secure; SameSite=Lax",
    expectedRedacted: "Set-Cookie: ml_session=...; HttpOnly; Secure; SameSite=Lax",
  },
  {
    name: "cookie_diagram_label_is_not_a_value",
    input: "Cookie: ml_access=EXPIRED",
    expectedRedacted: "Cookie: ml_access=EXPIRED",
  },
  {
    name: "cookie_value_in_a_later_pair_still_goes",
    input: "Cookie: theme=dark; session=Zm9vYmFyYmF6cXV4",
    expectedRedacted: REDACTED,
  },
  {
    name: "env_elided_prefix_is_a_reference",
    input: "OPENAI_API_KEY=sk-...",
    expectedRedacted: "OPENAI_API_KEY=sk-...",
  },
  {
    name: "env_dotted_name_is_a_reference",
    input: "apiKey: process.env.POSTHOG_API_KEY",
    expectedRedacted: "apiKey: process.env.POSTHOG_API_KEY",
  },
  {
    name: "env_bare_name_is_a_reference",
    input: "CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN",
    expectedRedacted: "CONTROL_TOKEN = MEETLESS_CONTROL_TOKEN",
  },
  {
    name: "env_name_shaped_prefix_does_not_launder",
    input: "API_KEY=SECRET_KEYabc123def456",
    expectedRedacted: `API_KEY=${REDACTED}`,
  },
  {
    name: "env_hyphenated_token_is_not_a_reference",
    input: "SLACK_BOT_TOKEN=xoxb-test-bot-token",
    expectedRedacted: `SLACK_BOT_TOKEN=${REDACTED}`,
  },
  // A bare WORD is not a VALUE, unless a human chose it. A machine-issued key
  // cannot be spelled with 26 letters (base64 mixes case and carries digits, hex
  // IS digits, every provider prefix carries punctuation), so a letters-only
  // value of at most 12 characters is not a credential. A PASSWORD is the
  // exception, because a human picks it and a short lowercase word is the
  // commonest real password there is.
  {
    name: "env_bare_word_is_not_a_value",
    input: "api_key: str",
    expectedRedacted: "api_key: str",
  },
  {
    name: "env_bare_word_ceiling_holds_at_twelve",
    input: "API_KEY=abcdefghijklm",
    expectedRedacted: `API_KEY=${REDACTED}`,
  },
  {
    name: "env_bare_word_with_a_digit_is_still_a_value",
    input: "API_KEY=abcdefghijk1",
    expectedRedacted: `API_KEY=${REDACTED}`,
  },
  {
    name: "env_bare_word_password_is_human_chosen",
    input: "PGPASSWORD=postgres",
    expectedRedacted: `PGPASSWORD=${REDACTED}`,
  },
  {
    // The redactor's own marker parses as an assignment, so without the guard
    // redact() was not idempotent: it re-flagged its own output.
    name: "env_redaction_marker_is_not_re_flagged",
    input: "[REDACTED_SECRET:JWT]",
    expectedRedacted: "[REDACTED_SECRET:JWT]",
  },
  // A value lives on the SAME LINE as its name. The separator's `\s*` matches a
  // newline, so a name that ends a line used to adopt the first token of the
  // next one: a Python block opener became an assignment to the identifier
  // below it.
  {
    name: "env_value_does_not_cross_a_newline",
    input: "strategy == Strategy.UPSERT_BY_KEY:\n    key_parts = []",
    expectedRedacted: "strategy == Strategy.UPSERT_BY_KEY:\n    key_parts = []",
  },
  {
    name: "env_separator_still_spans_spaces_on_one_line",
    input: "API_KEY  =  abcdefghijk1",
    expectedRedacted: `API_KEY  =  ${REDACTED}`,
  },
  {
    // A credential word standing alone is still a credential name. `APP_SECRET=x`
    // used to refuse while `SECRET=x` egressed, for the identical x, because the
    // prefix was mandatory. The bare word is the STRONGER claim, not the weaker one.
    name: "env_bare_credential_word_is_a_name",
    input: "SECRET=A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
    expectedRedacted: `SECRET=${REDACTED}`,
  },
  {
    // And the leading `\b` is what keeps the optional prefix honest: there is no
    // word boundary before the `KEY` inside `MONKEY`.
    name: "env_bare_word_is_not_read_out_of_a_longer_word",
    input: "MONKEY=abcdefghijklm",
    expectedRedacted: "MONKEY=abcdefghijklm",
  },
  {
    // A passphrase IS a password. `DB_PASSWORD=x` refused while
    // `DB_PASSPHRASE=x` egressed, for the identical x, because the word list was
    // a list of spellings and this spelling was missing.
    name: "env_passphrase_is_a_password",
    input: "DB_PASSPHRASE=A1b2C3d4E5f6G7h8I9j0K1l2M3n4",
    expectedRedacted: `DB_PASSPHRASE=${REDACTED}`,
  },
  {
    // And it is HUMAN-chosen, so it joins the password family and a short
    // lowercase word is a value rather than a placeholder, exactly as for
    // `PGPASSWORD=postgres`.
    name: "env_passphrase_bare_word_is_a_value",
    input: "passphrase: hunter",
    expectedRedacted: `passphrase: ${REDACTED}`,
  },
  {
    // `credential` is deliberately NOT a credential name: `credentials` is also
    // the name of a config MODE (fetch, gcloud), so the word does not identify a
    // secret. Measured at zero vault cost and rejected anyway.
    name: "env_credentials_is_a_mode_not_a_name",
    input: "credentials: application-default",
    expectedRedacted: "credentials: application-default",
  },
  {
    // D15, rejected. The "a name is not a value" guard exempts the WHOLE value, so
    // widening its separator from `_` to `[_-]` would exempt anything that merely
    // ENDS in a credential word. `env_assignment` is the only credential rule that
    // fires on the line below, so the exemption would be a leak. Worth 5 notes of
    // 2094 across the vault; not worth this.
    name: "env_kebab_suffix_is_not_a_reference",
    input: "API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-key",
    expectedRedacted: `API_KEY=${REDACTED}`,
  },
  {
    // The snake-case twin IS a reference, because `_` is identifier syntax and `-`
    // is not. The asymmetry is the ruling, not an oversight.
    name: "env_snake_name_stays_exempt_beside_it",
    input: "API_KEY=my_api_key",
    expectedRedacted: "API_KEY=my_api_key",
  },
  {
    // A prose LABEL whose last word is a credential noun, followed by an English
    // sentence. Two lines in 2094 real notes look like this, and they are the whole
    // measured cost of letting the name prefix be optional. A price, not a bug: the
    // twin below is what any fix for it would cost.
    name: "env_prose_label_is_still_a_credential_name",
    input: "KEY: obligation_strength and intent are independent axes",
    expectedRedacted: `KEY: ${REDACTED} and intent are independent axes`,
  },
  {
    // The twin. Exempting the line above means letting a `_`-joined run of short
    // lowercase words through, and this is that shape: a diceware passphrase under a
    // name in no password family. The hyphen-joined passphrases pinned elsewhere do
    // not move under that change, so this row is the one holding the ceiling.
    name: "env_underscore_passphrase_is_a_value",
    input: "SECRET=correct_horse_battery_staple",
    expectedRedacted: `SECRET=${REDACTED}`,
  },
  {
    // A hyphenated placeholder stays REFUSED, in all four planes, on purpose.
    // Exempting it means exempting a diceware passphrase and every short
    // issuer-prefixed key; see "a PHRASE is a credential shape, not a
    // placeholder" in redactor-env-assignment.spec.ts.
    name: "env_hyphenated_placeholder_is_still_refused",
    input: "CONTROL_API_KEY=your-dev-api-key",
    expectedRedacted: `CONTROL_API_KEY=${REDACTED}`,
  },
  {
    name: "pem_private_key_block",
    input: "config=-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
    expectedRedacted: `config=${REDACTED}`,
  },
  {
    name: "high_entropy_token_unprefixed",
    input: "blob: Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345",
    expectedRedacted: `blob: ${REDACTED}`,
  },
  {
    name: "low_entropy_word_passes_through",
    input: "the quick brown fox jumps over the lazy dog",
    expectedRedacted: "the quick brown fox jumps over the lazy dog",
  },
  {
    name: "all_letters_no_digits_passes_through",
    input: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv",
    expectedRedacted: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv",
  },
];

for (const c of PARITY_CASES) {
  test(`redactor parity (ask-core ESM plane): ${c.name}`, () => {
    assert.equal(redact(c.input), c.expectedRedacted);
  });
}

// The env-var NAME is retrieval-critical and must survive; the VALUE must not,
// in any form. Table-driven so a new separator or quoting style is one line,
// and asserted as "the secret substring is absent" rather than by equality, so
// a case cannot pass by accident when the output shape shifts.
const ENV_NAME_CASES = [
  {
    input: "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    varName: "OPENAI_API_KEY",
    secret: "sk-proj-AbCdEfGhIjKlMnOpQrStUv",
  },
  { input: "MY_SERVICE_TOKEN=hunter2", varName: "MY_SERVICE_TOKEN", secret: "hunter2" },
  { input: "password: hunter2", varName: "password", secret: "hunter2" },
  {
    input: "GH_TOKEN = ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
    varName: "GH_TOKEN",
    secret: "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
  },
  { input: "SECRET_FOO='bar baz'", varName: "SECRET_FOO", secret: "bar baz" },
  { input: 'DB_PASSWORD="p@ss w0rd"', varName: "DB_PASSWORD", secret: "p@ss w0rd" },
];

for (const c of ENV_NAME_CASES) {
  test(`env name survives, value does not: ${c.varName}`, () => {
    const out = redact(c.input);
    assert.ok(out.includes(c.varName), `expected ${c.varName} to survive, got: ${out}`);
    assert.ok(out.includes(REDACTED), `expected a redaction marker, got: ${out}`);
    assert.ok(!out.includes(c.secret), `secret value survived: ${out}`);
  });
}

// --- Profile behavior, mirrored from the CLI plane's profile tests ----------

test("the retrieval profile keeps retrieval keys that the full profile eats", () => {
  // A 40-char git SHA: 2 classes, clears 3.5, does not clear 4.0. It is a
  // legitimate retrieval key, and destroying it destroys the question.
  const sha = "9f4b2c1e8a7d6053f1e2b3c4d5a6978012345678";
  assert.equal(redact(sha, "full"), REDACTED, "full profile redacts a git SHA");
  assert.equal(redact(sha, "retrieval"), sha, "retrieval profile keeps a git SHA");
});

test("the retrieval profile keeps a 32+ char env-var name that full eats", () => {
  // Counterpart to the env_assignment_long_name_eaten_by_entropy parity case.
  // On the wire to intel the name IS the query, so the 3-class bar keeping it
  // is the whole point of the retrieval profile.
  const line = "MEETLESS_PRODUCTION_INTERNAL_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv";
  assert.equal(redact(line, "full"), `${REDACTED}=${REDACTED}`);
  assert.equal(redact(line, "retrieval"), `MEETLESS_PRODUCTION_INTERNAL_API_KEY=${REDACTED}`);
});

test("both profiles still redact a literal provider token", () => {
  const line = "use ghp_ABCDEFGHIJKLMNOPQRSTUVWX to push";
  assert.equal(redact(line, "full"), `use ${REDACTED} to push`);
  assert.equal(redact(line, "retrieval"), `use ${REDACTED} to push`);
});

test("both profiles redact a bare high-entropy 3-class blob", () => {
  const blob = "Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345";
  assert.equal(redact(blob, "full"), REDACTED);
  assert.equal(redact(blob, "retrieval"), REDACTED);
});

// --- events profile: the mirror half of the two-plane lock ---
//
// MIRROR of the CROSS_PLANE_CASES block in
// packages/cli/test/lib/redactor-events-profile.spec.ts (ruling section 7, test
// 6). Profiles exist on exactly two of the four planes, this one and the CLI's.
// These expectations must match that spec byte-for-byte; change one, change both
// IN THE SAME COMMIT.
//
// The other two planes (control, intel) have no profile parameter at all. Their
// half of the lock is the path_shaped_token_eaten_at_rest case above, which they
// mirror in their own parity specs.
const EVENTS_PARITY_CASES = [
  [
    "apps/control/src/coordination-case/coordination-case-projection",
    "apps/control/src/coordination-case/coordination-case-projection",
  ],
  [
    "packages/control-db/prisma/migrations/20260722180000_add_reconciliation_disposition_reference_rows",
    "packages/control-db/prisma/migrations/20260722180000_add_reconciliation_disposition_reference_rows",
  ],
  // The ACCEPTED RESIDUAL, stated rather than argued away: a lowercase + digit +
  // slash secret matches the path signature and passes. It is still redacted at
  // rest under "full", which bounds the exposure to the events spool.
  ["k7v2m9x4q1w8/n5b3j6h0z2c7r4t9y1p8s5d3f6g0", "k7v2m9x4q1w8/n5b3j6h0z2c7r4t9y1p8s5d3f6g0"],
  ["OPENAI_API_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWx", `OPENAI_API_KEY=${REDACTED}`],
  ["wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234", REDACTED],
];

test("the events profile matches the CLI plane on every cross-plane case", () => {
  for (const [input, expected] of EVENTS_PARITY_CASES) {
    assert.equal(redact(input, "events"), expected, `events parity: ${input.slice(0, 48)}`);
  }
});

test("the events exemption never reaches the full bar", () => {
  // The same inputs under "full". Three of them flip to REDACTED, which is the
  // entire point: relaxing "events" did not relax the at-rest default.
  const underFull = EVENTS_PARITY_CASES.map(([input]) => redact(input, "full"));
  assert.deepEqual(underFull, [
    REDACTED,
    REDACTED,
    REDACTED,
    `OPENAI_API_KEY=${REDACTED}`,
    REDACTED,
  ]);
});

test("the events entropy bar is identical to full outside the path shape", () => {
  // If these ever diverge, "events" has become a second retrieval bar and the
  // reason for its existence is gone.
  const notPathShaped = [
    "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY1234",
    "9f4b2c1e8a7d6053f1e2b3c4d5a6978012345678",
    "Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345",
    "MEETLESS_PRODUCTION_INTERNAL_API_KEY",
  ];
  for (const t of notPathShaped) {
    assert.equal(redact(t, "events"), redact(t, "full"), `events must equal full for: ${t}`);
  }
});

test("an unknown profile falls back to the stricter bar, never to no redaction", () => {
  const blob = "aGVsbG8td29ybGQtdGhpcy1pcy1hLXNlY3JldC1ibG9i99";
  assert.equal(redact(blob, "typo-profile"), REDACTED);
});

test("OR-1: retrieval treats a URL and a dated path as structures, not tokens", () => {
  // MIRROR of packages/cli/test/lib/redactor-retrieval-profile.spec.ts. This is
  // the second of the two planes that can be asked for "retrieval" (ask_modes.js
  // sets REDACT_PROFILE = "retrieval"), so the fix has to hold here identically
  // or an ask issued through ask-core loses its subject while the CLI keeps it.
  const survives = [
    "PRD at https://meetless.atlassian.net/wiki/spaces/PDM/pages/1234567/Wedge-V5-PRD",
    "artifact at https://storage.googleapis.com/meetless-public/cli/releases/0.2.28/mla-darwin-arm64",
    "see notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md",
  ];
  for (const s of survives) {
    assert.equal(redact(s, "retrieval"), s, `retrieval must preserve: ${s}`);
  }

  // The bar did not move: a component that clears it alone still dies, and the
  // literal patterns still run first over the whole text.
  assert.equal(
    redact("https://api.x.com/v1/z?access_token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX", "retrieval"),
    `https://api.x.com/v1/z?access_token=${REDACTED}`,
  );
  assert.ok(
    redact(
      "https://storage.googleapis.com/b/o?X-Goog-Signature=aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5m",
      "retrieval",
    ).includes(REDACTED),
  );

  // And "full" is untouched, which is the reason this change needed no
  // re-derivation of four-plane parity: control and intel can only ever be here.
  assert.ok(redact(survives[0], "full").includes(REDACTED));
});

test("null, undefined and empty string pass through untouched", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(""), "");
});
