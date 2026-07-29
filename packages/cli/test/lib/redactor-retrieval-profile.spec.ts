import { redact, scanForSecrets, REDACTED } from "../../src/lib/redactor";

// OR-1 (notes/20260728-open-rulings.md): the "retrieval" profile was destroying
// the SUBJECT of the questions it exists to carry.
//
// Two independent holes, same root cause (the last-resort entropy heuristic
// measuring a STRUCTURED identifier as one opaque token):
//
//   1. ENTROPY_TOKEN's charset excludes "." and ":", so a URL is never matched
//      AS a URL. The match begins at the hostname's last dot and the
//      replacement lands mid-hostname.
//   2. A file path carrying DIGITS clears the 3-class retrieval bar on the
//      digits alone, so every date-prefixed note slug and every timestamped
//      migration name died.
//
// Both were silent and content-dependent: two Confluence URLs, one survives and
// one does not, on character diversity. This spec is the lock. It asserts the
// SURVIVAL cases (the product bug) and the KILL cases (the property that makes
// the fix a granularity change and not a leak licence) with equal weight.

describe("redactor: retrieval profile treats a URL as a structure", () => {
  // The exact table from the OR-1 ledger entry. Before the fix, 4 of these 7
  // lost their subject. If any regresses, a user's grounded question silently
  // stops finding its own answer and nothing anywhere reports it.
  const RETRIEVAL_KEYS: Array<[string, string]> = [
    ["bare docs URL", "See https://meetless.ai/docs/getting-started for setup"],
    ["versioned API URL", "Check https://api.stripe.com/v1/charges/ch_3PabcdEfGhIjKlMn0123 now"],
    [
      "GitHub deep link",
      "https://github.com/Meetless/meetless/blob/main/apps/control/src/app.module.ts",
    ],
    ["Jira issue", "Blocked by https://meetless.atlassian.net/browse/PDM-1427"],
    [
      "Confluence PRD with a numeric page id",
      "PRD at https://meetless.atlassian.net/wiki/spaces/PDM/pages/1234567/Wedge-V5-PRD",
    ],
    [
      "date-prefixed note slug",
      "see notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md",
    ],
    [
      "object-store URL",
      "artifact at https://storage.googleapis.com/meetless-public/cli/releases/0.2.28/mla-darwin-arm64",
    ],
    [
      "timestamped migration path",
      "packages/control-db/prisma/migrations/20260714_add_account_id/migration.sql",
    ],
  ];

  it.each(RETRIEVAL_KEYS)("%s survives the retrieval bar intact", (_name, input) => {
    expect(redact(input, "retrieval")).toBe(input);
  });

  it("splits a URL on its own separators and nothing else", () => {
    // The join is the input, byte for byte, when no component clears the bar.
    // A reconstructed URL would be a different bug wearing this test's costume.
    const url = "https://user@host.example.com:8443/a/b?x=1&y=2#frag";
    expect(redact(url, "retrieval")).toBe(url);
  });
});

describe("redactor: the retrieval bar itself did not move", () => {
  // Each of these dies because a single COMPONENT clears the bar on its own.
  // That is the whole claim of the fix: granularity changed, threshold did not.
  const MUST_DIE: Array<[string, string]> = [
    ["provider token in a query value", "https://api.x.com/v1/z?access_token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX"],
    [
      "JWT in a path segment",
      "https://api.x.com/cb/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQsig",
    ],
    ["AWS key id in a query value", "https://s3.amazonaws.com/b/k?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE"],
    [
      "opaque signature in a query value",
      "https://storage.googleapis.com/b/o?X-Goog-Signature=aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5m",
    ],
    ["bare base64 blob outside any URL", "blob: Zm9vYmFyYmF6cXV4YWJjZGVmZ2hpamtsbW5vcA12345"],
    [
      "mixed-case blob with a slash (the no-uppercase clause)",
      "aB3dE5fG7hJ9kL1mN3pQ5/rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5m",
    ],
  ];

  it.each(MUST_DIE)("%s is still destroyed under retrieval", (_name, input) => {
    expect(redact(input, "retrieval")).toContain(REDACTED);
  });

  it.each(MUST_DIE)("%s is still BLOCKED by the scanner", (_name, input) => {
    expect(scanForSecrets(input).length).toBeGreaterThan(0);
  });

  it("a credential is caught by its LITERAL pattern, before any of this runs", () => {
    // Ordering proof. The literal patterns sweep the whole text first, so the
    // URL walk can never be the thing standing between a known credential and
    // the wire. Kill the entropy heuristic entirely and this still holds.
    const out = redact("https://api.x.com/v1/z?access_token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX", "retrieval");
    expect(out).toBe(`https://api.x.com/v1/z?access_token=${REDACTED}`);
  });
});

describe("redactor: the ACCEPTED RESIDUAL, pinned rather than argued away", () => {
  // Standard base64 includes "/", and the path-shape exemption asks only for
  // "has a slash, has lowercase, has no uppercase". A lowercase-and-digit
  // secret in that shape therefore passes the retrieval bar. This is the same
  // residual already accepted for "events", and it is bounded the same way:
  // at rest, under "full", it is still eaten whole. If this test ever starts
  // failing, someone tightened the shape and that is good news, not a break.
  const LOWERCASE_BLOB_WITH_SLASH = "aaaa1bbbb2cccc3dddd4/eeee5ffff6gggg7hhhh8iiii9jjjj0kkkk";

  it("escapes the retrieval bar (the cost we are choosing)", () => {
    expect(redact(LOWERCASE_BLOB_WITH_SLASH, "retrieval")).toBe(LOWERCASE_BLOB_WITH_SLASH);
  });

  it("is still destroyed at rest under full (the bound on that cost)", () => {
    expect(redact(LOWERCASE_BLOB_WITH_SLASH, "full")).toBe(REDACTED);
  });

  it("is still BLOCKED by the block-on-detect scanner", () => {
    expect(scanForSecrets(LOWERCASE_BLOB_WITH_SLASH)).toContain("high_entropy_token");
  });
});

describe("redactor: full and events are untouched by the OR-1 change", () => {
  // The whole safety argument for shipping OR-1 without re-deriving four-plane
  // parity is that "full" is byte-identical. control and intel have no profile
  // parameter at all, so they can only ever be on this path. Assert it here so
  // the argument is a test and not a paragraph.
  it("a URL is still eaten whole at rest under full", () => {
    expect(redact("PRD at https://meetless.atlassian.net/wiki/spaces/PDM/pages/1234567/Wedge-V5-PRD", "full")).toContain(
      REDACTED,
    );
  });

  it("an unrecognized profile still falls back to full, URLs included", () => {
    const url = "https://meetless.atlassian.net/wiki/spaces/PDM/pages/1234567/Wedge-V5-PRD";
    // @ts-expect-error deliberately invalid profile: the fallback is the point
    expect(redact(url, "retreival")).toContain(REDACTED);
  });

  it("the events path exemption still applies and still excludes uppercase", () => {
    expect(redact("apps/control/src/coordination-case/coordination-case-projection", "events")).toBe(
      "apps/control/src/coordination-case/coordination-case-projection",
    );
    expect(redact("aB3dE5fG7hJ9kL1mN3pQ5/rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5m", "events")).toBe(REDACTED);
  });
});
