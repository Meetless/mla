import { redact, REDACTED } from "../../src/lib/redactor";

// The `bearer` rule matched the ENGLISH WORD, not the credential.
//
// `/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi` says "the scheme keyword, then one or
// more characters from the credential alphabet". Every letter is in that alphabet, so
// the rule really says "the scheme keyword, then any word", and under `/i` the keyword
// is also the ordinary adjective "basic" and the noun phrase "bearer token".
//
// Measured against the real vault (2094 notes) before this file was written:
//
//     517 matches across 262 notes
//     zero of them a credential that a sibling rule did not already catch
//     the single genuinely opaque tail in the corpus is 74 chars and `entropy32` owns it
//
// The most common "credentials" it found were `Bearer token` (28x), `bearer token`
// (20x), `Basic Admin`, `Basic Information`, `basic implementation`, `basic mission`,
// and roughly two hundred more distinct English phrases. Because `/internal/v1/kb/add`
// runs `block_on_detect`, each of those is not a redaction but a REFUSAL: the note never
// leaves the machine. One rule, 262 notes ungovernable, no credential anywhere.
//
// The fix is to require the TAIL to be credential-shaped rather than merely
// word-shaped: at least 16 characters (the floor `provider_token` already uses for
// `sk-…` two rules below, so this is house style rather than an invented number), and
// either carrying a digit / base64 `=` padding, or mixing upper and lower case. Prose
// fails all three. The scheme keyword STAYS case-insensitive: measured, a case-sensitive
// `(Bearer|Basic)` misses `bearer <hex>` and `BEARER <token>`, both real, so dropping
// the flag would cost detection and buy nothing. The tail check does all of the
// false-positive work on its own.
//
// The keyword is SPELLED case-insensitively (`[Bb][Ee]…`) instead of carrying `/i`
// because `/i` also makes `[A-Z]` match lowercase, which silently collapses the
// mixed-case lookahead into "contains any letter" and reinstates the whole defect.
// Inline `(?i:...)` groups would say it better but are not portable to the Python plane.

/** Assembled at runtime so no literal here resembles a real secret. */
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("bearer/basic: the scheme keyword is not the credential", () => {
  // Every entry below is a phrase lifted from the real vault, where it cost a refusal.
  const PROSE = [
    "Bearer token",
    "bearer token",
    "the basic auth flow",
    "Basic Admin",
    "Basic Information",
    "basic implementation",
    "a basic mission",
    "basic review",
    // The tail runs past the space because `.` `/` and `-` are all in the credential
    // alphabet, so these matched further than they look.
    "a basic decision/discussion",
    "basic personalization.",
    // Placeholders, which is what a note about auth actually contains.
    "Authorization: Bearer INTERNAL_API_KEY",
    "Authorization: Bearer worker-callback-jwt",
    "curl -H 'Authorization: Bearer agent-key'",
  ];

  it.each(PROSE)("leaves ordinary prose alone: %s", (input) => {
    expect(redact(input)).toBe(input);
  });

  // The other direction, and the expensive one: a miss here is a live credential on the
  // wire. Each tail below is short enough that `entropy32` (32-char floor) would NOT
  // save us, so this rule is genuinely load-bearing for all but the first two.
  const CREDENTIALS: Array<[string, string, string]> = [
    [
      "jwt after the scheme, whole match including the keyword",
      'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.payload.sig" api.example.com',
      `curl -H "Authorization: ${REDACTED}" api.example.com`,
    ],
    [
      "basic auth, user:pass base64",
      `Authorization: Basic ${b64("admin:hunter2")}`,
      `Authorization: ${REDACTED}`,
    ],
    [
      "basic auth, service account",
      `Authorization: Basic ${b64("service-account:s3cr3t-p4ssw0rd")}`,
      `Authorization: ${REDACTED}`,
    ],
    [
      // The case a uniform 16-character floor MISSED, which is why `Basic` gets its
      // own floor of 12. base64 spends 4 characters on every 3 bytes, so a 9-byte
      // pair is only 12 wide, and the short pairs are precisely the ones a human
      // types by hand into a note.
      "basic auth, 9-byte pair that a 16-char floor let through",
      `Authorization: Basic ${b64("user:pass")}`,
      `Authorization: ${REDACTED}`,
    ],
    [
      "basic auth, short root pair",
      `Authorization: Basic ${b64("root:toor")}`,
      `Authorization: ${REDACTED}`,
    ],
    [
      "lowercase scheme, 32-hex opaque token",
      `bearer ${"9f8e7d6c5b4a39281706f5e4d3c2b1a0"}`,
      REDACTED,
    ],
    [
      "shouty scheme, prefixed opaque token",
      `BEARER ${"tok_live_51H7bQ2eZvKYlo2C9x8"}`,
      REDACTED,
    ],
    [
      // ~3% of base64 output contains no digit at all. Mixed case is what saves it.
      "mixed case, no digit, 20 chars",
      `Bearer ${"AbCdEfGhIjKlMnOpQrSt"}`,
      REDACTED,
    ],
    [
      // Neither a digit nor mixed case in the payload proper, but base64 padding is
      // itself a shape no English word has.
      "base64 padding, no digit",
      `Bearer ${"Zm9vYmFyYmF6cXV1eA=="}`,
      REDACTED,
    ],
  ];

  it.each(CREDENTIALS)("still redacts %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("never leaves the scheme keyword standing next to a redacted tail", () => {
    // The failure shape if the keyword were dropped from the rule and a sibling picked
    // up only the tail: "Authorization: Bearer [REDACTED]" still tells a reader which
    // scheme, which is fine, but it means THIS rule stopped matching and the short
    // tails above are unprotected. Assert the keyword goes with it.
    for (const [, input] of CREDENTIALS.map((c) => [c[0], c[1]])) {
      expect(redact(input as string)).not.toMatch(/Bearer|Basic|bearer|BEARER/);
    }
  });

  it("accepts three measured residuals rather than growing a prose detector", () => {
    // These are every phrase in 2094 real notes that survives the new rule. All three
    // are mixed-case words of 12 characters or more sitting after a scheme keyword,
    // which is the exact shape of a short base64 payload. Nothing but a dictionary
    // separates them, and a dictionary is a boundary you can talk your way past. We
    // take the false positive. Pinned so a future reader knows the cost was measured
    // and chosen rather than overlooked.
    for (const phrase of [
      "basic Slack-citizenship.",
      "Basic Conversation",
      "Basic Implementation",
    ]) {
      expect(redact(phrase)).toBe(REDACTED);
    }
  });

  it("pins the one credential shape still under the Basic floor", () => {
    // base64("a:b") is 4 characters wide. Reaching it means a floor of 4, which
    // measured at 41 hits across the same 2094 notes against 4 today: 37 more notes
    // refused at the egress boundary, every "Basic Auth" and "basic idea" among them.
    // A 1-character password is not a credential anyone has. Those 37 refusals are a
    // cost real users would pay every day. Stated here rather than left to be found.
    const pathological = `Basic ${b64("a:b")}`;
    expect(redact(pathological)).toBe(pathological);
  });
});
