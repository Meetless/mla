import { redact, REDACTED, type RedactProfile } from "../../src/lib/redactor";

// REDACTION FIDELITY BENCHMARK.
//
// Redaction is a security control with a quality cost, and the cost is only
// acceptable if it is measured. When the enrichment question started going
// through the redactor on its way to intel (notes/20260726-mla-redaction-egress-boundary.md),
// it stopped being telemetry and became a RETRIEVAL KEY: "[REDACTED]" where a
// file path used to be does not protect anything and does destroy the query.
//
// So this file is two corpora and one scoreboard:
//
//   PRESERVE -- realistic developer questions whose retrieval keys MUST survive
//     verbatim. A failure here is silent answer degradation: the question still
//     reaches intel, still returns something, and is simply worse. Nothing else
//     in the suite would notice.
//   SECRETS -- questions carrying a real-shaped credential that MUST NOT
//     survive. A failure here is a leak.
//
// Both profiles are scored against both corpora, so the tradeoff is a number in
// the test output rather than an assertion someone has to take on faith. The
// measured result that set the "retrieval" bar at 3 classes / entropy 4.0:
//
//   profile      PRESERVE damaged   SECRETS leaked
//   full          12 / 20            0 / 11
//   retrieval      0 / 20            0 / 11
//
// Those counts are measured off the two arrays below, so they move when the
// corpora move. The denominators ARE PRESERVE.length and SECRETS.length; if you
// add a case, re-derive this table instead of editing one number.
//
// If you change ENTROPY_BARS, this file tells you what it cost.

// ---------------------------------------------------------------------------
// Corpus 1: retrieval keys that must survive.
// ---------------------------------------------------------------------------
// Every entry is a question a developer plausibly types, holding a token shape
// that retrieval keys on. `key` is the substring whose survival is the point.
interface PreserveCase {
  name: string;
  question: string;
  key: string;
}

const PRESERVE: PreserveCase[] = [
  {
    name: "shallow file path",
    question: "explain apps/control/src/main.ts",
    key: "apps/control/src/main.ts",
  },
  {
    name: "deep file path",
    question: "explain meetless-cli/packages/cli/src/lib/redactor.ts",
    key: "meetless-cli/packages/cli/src/lib/redactor.ts",
  },
  {
    name: "path with no extension",
    question: "what is in src/lib/agent-memory-capture/live-pipeline-orchestrator",
    key: "src/lib/agent-memory-capture/live-pipeline-orchestrator",
  },
  {
    name: "package import specifier",
    question: "why does @meetless/control-db/prisma/schema.prisma keep drifting",
    key: "@meetless/control-db/prisma/schema.prisma",
  },
  {
    name: "SCREAMING_SNAKE identifier",
    question: "where is DECISION_DIFF_GENERATE_WITH_CITATIONS handled",
    key: "DECISION_DIFF_GENERATE_WITH_CITATIONS",
  },
  {
    name: "full-length git sha",
    question: "why did commit a5df27d44e1b3c9f0d2a8e7461b5c0d93f8a2e17 break the build",
    key: "a5df27d44e1b3c9f0d2a8e7461b5c0d93f8a2e17",
  },
  {
    name: "short git sha",
    question: "why did commit a5df27d break the build",
    key: "a5df27d",
  },
  {
    name: "32-hex trace id",
    question: "look at trace a10957866d144bd68a80697fdfa4c088",
    key: "a10957866d144bd68a80697fdfa4c088",
  },
  {
    name: "uuid case id",
    question: "what happened in case 550e8400-e29b-41d4-a716-446655440000",
    key: "550e8400-e29b-41d4-a716-446655440000",
  },
  {
    name: "cuid case id",
    question: "status of case cmexamplews1a2b3c4d5e6f7g",
    key: "cmexamplews1a2b3c4d5e6f7g",
  },
  {
    name: "jira key",
    question: "what is the status of PDM-1234",
    key: "PDM-1234",
  },
  {
    name: "plain english, no tokens",
    question: "how does the coordination case state machine work",
    key: "coordination case state machine",
  },
  // Vietnamese is a first-class pilot language, and the redactor is a byte-level
  // regex: a non-ASCII question must not fare worse than its English twin.
  {
    name: "vietnamese with cuid",
    question: "trạng thái của case cmexamplews1a2b3c4d5e6f7g là gì",
    key: "cmexamplews1a2b3c4d5e6f7g",
  },
  {
    name: "vietnamese with file path",
    question: "giải thích meetless-cli/packages/cli/src/lib/redactor.ts giúp tôi",
    key: "meetless-cli/packages/cli/src/lib/redactor.ts",
  },
  {
    name: "url with route path",
    question: "why does https://api.example.test/internal/v1/agent-runs/by-session return 404",
    key: "https://api.example.test/internal/v1/agent-runs/by-session",
  },
  {
    name: "stack frame with line",
    question: "TypeError at packages/cli/src/lib/enrichment/assemble-context.ts:205:14",
    key: "packages/cli/src/lib/enrichment/assemble-context.ts:205:14",
  },
  {
    name: "env var NAME only",
    question: "is MEETLESS_CONTROL_TOKEN still honored after mla login",
    key: "MEETLESS_CONTROL_TOKEN",
  },
  {
    name: "long branch name",
    question: "rebase feature/agent-memory-capture-live-pipeline-orchestrator onto main",
    key: "feature/agent-memory-capture-live-pipeline-orchestrator",
  },
  {
    name: "long function name",
    question: "trace runInternalRedactCaptureWithDepsAndTimeout through the hook",
    key: "runInternalRedactCaptureWithDepsAndTimeout",
  },
  {
    name: "sha256 image digest",
    question:
      "why is image sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 stale",
    key: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
];

// ---------------------------------------------------------------------------
// Corpus 2: credentials that must not survive.
// ---------------------------------------------------------------------------
// Fixtures are real-SHAPED on purpose (see the note in redaction-egress.spec.ts):
// the patterns are narrow, so a hand-waved fake passes a test that proves
// nothing. `secret` is the substring that must be gone from the output.
interface SecretCase {
  name: string;
  question: string;
  secret: string;
  // true when NO literal pattern covers this shape, so the generic entropy
  // heuristic is the only thing standing between it and the wire. These are the
  // cases that decide whether a profile may drop the heuristic entirely.
  entropyOnly?: boolean;
}

const SECRETS: SecretCase[] = [
  {
    name: "anthropic api key",
    question: "rotate sk-ant-" + "api03-BENCHfakekeyAAAABBBBCCCCDDDDEEEEFFFF for me",
    secret: "sk-ant-" + "api03-BENCHfakekeyAAAABBBBCCCCDDDDEEEEFFFF",
  },
  {
    name: "github pat",
    question: "is gh" + "p_BENCHfakegithubtokenAAAABBBBCCCC still valid",
    secret: "gh" + "p_BENCHfakegithubtokenAAAABBBBCCCC",
  },
  {
    name: "aws access key id",
    question: "revoke AKIA" + "BENCHFAKEKEYIDXX now",
    secret: "AKIA" + "BENCHFAKEKEYIDXX",
  },
  {
    name: "google api key",
    // AIza + exactly 35 chars. An earlier draft used 36 and silently fell
    // through to the entropy heuristic, which is exactly the kind of fixture
    // that makes a literal pattern look covered when it is not.
    question: "key AIzaSyA-1234567890abcdefghijklmnopqrstu here",
    secret: "AIzaSyA-1234567890abcdefghijklmnopqrstu",
  },
  {
    name: "slack bot token",
    question: "xox" + "b-1234567890-abcdefghij leaked in the log",
    secret: "xox" + "b-1234567890-abcdefghij",
  },
  {
    name: "env assignment",
    question: "I set DATABASE_PASSWORD=hunter2correcthorse in the env",
    secret: "hunter2correcthorse",
  },
  {
    name: "bearer header",
    question: "curl -H 'Authorization: Bearer abcdefFAKE1234567890' api",
    secret: "abcdefFAKE1234567890",
  },
  {
    name: "set-cookie header",
    question: "the response had Set-Cookie: session=abc123secret; HttpOnly",
    secret: "abc123secret",
  },
  {
    name: "jwt, whole",
    question:
      "my token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQfakesig",
    secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQfakesig",
  },
  {
    name: "bare aws secret access key",
    question: "the secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    entropyOnly: true,
  },
  {
    name: "bare base64 blob",
    question: "use dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ1234 to auth",
    secret: "dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZQ1234",
    entropyOnly: true,
  },
];

function damaged(profile: RedactProfile): PreserveCase[] {
  return PRESERVE.filter((c) => !(redact(c.question, profile) ?? "").includes(c.key));
}

function leaked(profile: RedactProfile): SecretCase[] {
  return SECRETS.filter((c) => (redact(c.question, profile) ?? "").includes(c.secret));
}

describe("redaction fidelity: the retrieval profile preserves what retrieval keys on", () => {
  // The contract. Both halves matter: a profile that preserves everything by
  // redacting nothing fails the second, and today's "full" bar fails the first.
  it.each(PRESERVE)("preserves $name", ({ question, key }) => {
    expect(redact(question, "retrieval")).toContain(key);
  });

  it.each(SECRETS)("redacts $name", ({ question, secret }) => {
    const out = redact(question, "retrieval") ?? "";
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("preserves every retrieval key in the corpus", () => {
    expect(damaged("retrieval").map((c) => c.name)).toEqual([]);
  });

  it("leaks no secret in the corpus", () => {
    expect(leaked("retrieval").map((c) => c.name)).toEqual([]);
  });
});

describe("redaction fidelity: why the retrieval profile exists", () => {
  // Regression lock on the FINDING, not just the fix. If someone points the
  // enrichment question back at the "full" bar, these numbers are the argument.
  it("the full profile damages most of the corpus, which is why it is not used on the wire", () => {
    const names = damaged("full").map((c) => c.name);
    // Not a tuned number: every one of these is a token shape retrieval needs.
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toEqual(expect.arrayContaining(["deep file path", "full-length git sha"]));
  });

  it("the retrieval profile is a strict improvement in fidelity, at no measured leak cost", () => {
    expect(damaged("retrieval").length).toBeLessThan(damaged("full").length);
    expect(leaked("retrieval")).toEqual(leaked("full"));
  });

  // The load-bearing reason the retrieval profile keeps the entropy heuristic
  // at a higher bar instead of dropping it. Without it these two reach intel.
  it("still catches the secrets that NO literal pattern covers", () => {
    for (const c of SECRETS.filter((s) => s.entropyOnly)) {
      expect(redact(c.question, "retrieval")).not.toContain(c.secret);
    }
  });

  it("keeps the at-rest profile as the default, so a missing argument cannot weaken anything", () => {
    for (const c of SECRETS) {
      expect(redact(c.question)).not.toContain(c.secret);
    }
    // Same call, no profile argument, same answer as an explicit "full".
    const sample = "the secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok";
    expect(redact(sample)).toBe(redact(sample, "full"));
  });
});

describe("redaction fidelity: the jwt pattern", () => {
  // Before the literal pattern existed, entropy caught only the header segment
  // (the payload is 27 chars, under the 32-char floor), so the claims and the
  // signature survived on EVERY plane, including at rest.
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQfakesig";

  it.each(["full", "retrieval"] as const)("redacts the whole token under %s", (profile) => {
    const out = redact(`bearerless token ${JWT} here`, profile) ?? "";
    expect(out).toBe(`bearerless token ${REDACTED} here`);
    // The specific pre-fix leak: claims and signature left behind.
    expect(out).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkwIn0");
    expect(out).not.toContain("dQw4w9WgXcQfakesig");
  });
});
