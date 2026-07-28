import { redact, redactPayload, REDACTED } from "../../src/lib/redactor";

// Plane-parity lock for the shared redactor (principle 7 of
// notes/20260528-mla-logging-and-tracing-proposal.md). MIRROR of
// apps/control/src/core/services/redactor.parity.spec.ts,
// intel/tests/observability/test_redaction_parity.py and
// meetless-cli/packages/ask-core/redactor.test.js.
//
// Every PARITY_CASES entry below must match the corresponding entries
// byte-for-byte across all four specs. If you add a case here, add it
// to the other three AT THE SAME TIME. If a case fails here only, the CLI
// redactor has drifted from the contract.

interface ParityCase {
  name: string;
  input: string;
  expectedRedacted: string;
}

// The env-var NAME is retrieval-critical and must survive; the VALUE must not,
// in any form. Table-driven so a new separator or quoting style is one line,
// and asserted as "the secret substring is absent" rather than by equality, so
// a case cannot pass by accident when the output shape shifts.
interface EnvNameCase {
  input: string;
  varName: string;
  secret: string;
}

const ENV_NAME_CASES: EnvNameCase[] = [
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

const PARITY_CASES: ParityCase[] = [
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
    // and never worse than the whole-match behaviour this replaced. The
    // 3-class "retrieval" bar keeps such names.
    input: "MEETLESS_PRODUCTION_INTERNAL_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    expectedRedacted: `${REDACTED}=${REDACTED}`,
  },
  {
    name: "path_shaped_token_eaten_at_rest",
    // The four-plane lock for the "events" profile (ruling §7, test 6). This
    // token is EXEMPT under "events", which exists only on the CLI and ask-core
    // planes. At rest, on every plane, it must still be redacted.
    //
    // The two profile-less planes (control, intel) cannot be asked for "events"
    // at all, and that is deliberate: a profile parameter there would be a way
    // for a future caller to weaken at-rest redaction. This case is how that
    // stays true. If it ever passes unredacted on any plane, the scoped
    // exemption has escaped its one caller.
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

describe("redactor parity fixture (CLI TS side)", () => {
  it.each(PARITY_CASES.map((c) => [c.name, c]))(
    "%s: redact(input) === expectedRedacted",
    (_name, c) => {
      const cse = c as ParityCase;
      expect(redact(cse.input)).toBe(cse.expectedRedacted);
    },
  );

  it.each(ENV_NAME_CASES.map((c) => [c.varName, c]))(
    "%s: the variable name survives and the value does not",
    (_name, c) => {
      const cse = c as EnvNameCase;
      const out = redact(cse.input) as string;
      expect(out).toContain(cse.varName);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(cse.secret);
    },
  );

  it("redactPayload preserves structure while redacting every string leaf", () => {
    const payload = {
      command: "OPENAI_API_KEY=sk-proj-abcdefghijklmnop curl",
      args: ["ok", "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.payload.sig"],
      env: { GH_TOKEN: "ghp_ABCDEFGHIJKLMNOPQRSTUVWX", normal: "value" },
      counts: { exit: 0, durationMs: 12 },
      nullField: null,
    };
    const out = redactPayload(payload);
    expect(Object.keys(out)).toEqual(Object.keys(payload));
    expect(out.counts).toEqual({ exit: 0, durationMs: 12 });
    expect(out.nullField).toBeNull();
    expect(out.command).toBe(`OPENAI_API_KEY=${REDACTED} curl`);
    expect(out.args[0]).toBe("ok");
    expect(out.args[1]).toBe(REDACTED);
    expect(out.env.GH_TOKEN).toBe(REDACTED);
    expect(out.env.normal).toBe("value");
  });
});
