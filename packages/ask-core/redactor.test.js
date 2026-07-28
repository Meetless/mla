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
    input: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
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
    name: "github_pat_literal",
    input: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
    expectedRedacted: `token=${REDACTED}`,
  },
  {
    name: "slack_token_literal",
    input: "xoxb-1234567890-abcdefghij and rest",
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

test("null, undefined and empty string pass through untouched", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(""), "");
});
