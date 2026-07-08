import { redact, redactPayload, REDACTED } from "../../src/lib/redactor";

// Plane-parity lock for the shared redactor (principle 7 of
// notes/20260528-mla-logging-and-tracing-proposal.md). MIRROR of
// apps/control/src/core/services/redactor.parity.spec.ts and
// intel/tests/observability/test_redaction_parity.py.
//
// Every PARITY_CASES entry below must match the corresponding entries
// byte-for-byte across all three specs. If you add a case here, add it
// to the other two AT THE SAME TIME. If a case fails here only, the CLI
// redactor has drifted from the contract.

interface ParityCase {
  name: string;
  input: string;
  expectedRedacted: string;
}

const PARITY_CASES: ParityCase[] = [
  {
    name: "env_assignment_openai",
    input: "export OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    expectedRedacted: `export ${REDACTED}`,
  },
  {
    name: "env_assignment_anthropic_quoted",
    input: 'ANTHROPIC_API_KEY="sk-ant-api03-abcdefghijklmnop"',
    expectedRedacted: REDACTED,
  },
  {
    name: "env_assignment_aws_pair",
    input: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expectedRedacted: `${REDACTED} ${REDACTED}`,
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
    expect(out.command).toBe(`${REDACTED} curl`);
    expect(out.args[0]).toBe("ok");
    expect(out.args[1]).toBe(REDACTED);
    expect(out.env.GH_TOKEN).toBe(REDACTED);
    expect(out.env.normal).toBe("value");
  });
});
