import { scanForSecrets, scanForCredentials } from "../../src/lib/redactor";

/**
 * `mla agent-memory report` printed "Project files with a secret signal
 * (observe-only): 453". Measured across the real agent-memory corpus:
 * 866 of 876 files flagged, 98.9%, and 856 of those 866 on `high_entropy_token`
 * ALONE. A signal that fires on essentially every file is not a control; it is a
 * line the operator learns to scroll past, which is how the last set of dead
 * instruments got that way.
 *
 * The driver is our own naming convention, not a credential: long snake_case
 * markdown filenames clear the 32-char / 2-class / 3.5-entropy bar with no
 * whitespace to break them up. `looksPathLike` already exists for exactly this
 * problem but requires a SLASH, so a bare `reference_a_very_long_note_name.md`
 * misses it entirely.
 *
 * ORDERING IS THE WHOLE FIX (and it is why precision here does not cost recall):
 * explicit issuer-prefixed detectors run first and are untouched. Only the GENERIC
 * entropy fallback gets the document-identifier exemption. Two of the three real
 * credential shapes found in the live trace file were already caught by
 * `provider_token` independently of the heuristic; the third (Sentry) was not, and
 * is given its own explicit pattern here rather than left leaning on entropy.
 *
 * PRECISION IS PINNED TO A FIXED FIXTURE, not to a percentage over a live corpus.
 * A repo-wide "< 5% of files flag" assertion is a useful report and a terrible
 * unit test: it moves every time someone adds a note. The strings below were taken
 * from the measured false positives and stay put.
 *
 * The scanner stays OBSERVE-ONLY. Five positive fixtures are not evidence of
 * production recall, so nothing here promotes it to a gate.
 */

// The three real credential shapes found in ~/.meetless/logs/ask-traces.jsonl,
// plus two more issuer families. Recall floor: loosening the generic heuristic
// must not quietly stop catching any of these.
//
// EVERY LITERAL HERE IS SPLIT ACROSS THE VENDOR PREFIX, AND MUST STAY SPLIT. These are
// synthetic (keyboard walks, and AWS's own published example access-key id),
// but GitHub's push protection matches on SHAPE and validity checks are off, so it
// cannot tell. A contiguous literal here refuses every push of the PUBLIC mirror at
// `github.com/Meetless/mla`, and that is not hypothetical: this file made the mirror
// unpushable from 2026-08-05 until 2026-08-12, so 0.2.35's export was silently refused
// and nobody noticed for two days. Concatenation is resolved at module load, so `secret`
// below is byte-identical to the joined form and the recall floor is unchanged.
// `scripts/lint-provider-token-literals.mjs` fails the build if anyone rejoins them.
const REAL_SECRETS: Array<[string, string]> = [
  ["sentry user token", "sntry" + "u_4987abcdEF01234567890abcdefABCDEF0123456789abcdefABCD"],
  ["anthropic api key", "sk-ant-" + "api03-AbCdEf0123456789_-AbCdEf0123456789AbCdEf0123456789AA"],
  ["github pat", "gh" + "p_AbCdEf0123456789AbCdEf0123456789AbCd"],
  ["slack bot token", "xox" + "b-1234567890-abcdefghijklmnop"],
  ["aws access key id", "AKIA" + "IOSFODNN7EXAMPLE"],
];

// Verbatim false positives from the 866-file measurement. Every one is a document
// identifier this product's own conventions produce.
const MEASURED_FALSE_POSITIVES: Array<[string, string]> = [
  ["bare long snake_case note", "reference_identifier_boost_ranks_the_doc_that_names_the_thing.md"],
  ["markdown link target", "[trap](reference_a_ttl_column_and_a_cleanup_method_are_claims_not_enforcement.md)"],
  ["another bare note name", "reference_a_test_that_builds_its_own_input_from_its_own_expectation_tests_the_harness.md"],
  ["project archive name", "archive_shipped_work_20260803.md"],
  ["dated note path", "notes/20260805-mla-router-abstention-and-raw-prompt-at-rest.md"],
  ["source path", "apps/console/app/kb/[id]/OnboardingFindingCard.test.tsx"],
  ["migration path", "packages/control-db/prisma/migrations/20260714_add_account_id/migration.sql"],
  ["python module path", "intel/app/graphs/ask/enrich_router_plan_test.py"],
];

// Identifier shapes that were ALREADY clean and must stay clean.
const BENIGN_IDENTIFIERS: Array<[string, string]> = [
  ["git sha", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"],
  ["short sha", "7b81d7a35"],
  ["cuid", "cmexample0000000000000001"],
  ["sha256 digest", "sha256:2b6822aa5ec50f161f51de44ce56918f06d431a4134331f451952597f2549f37"],
  ["uuid v4", "2c0c38b4-2478-4243-8d02-a681e80e8eea"],
  ["ordinary prose", "The router declined to route this prompt and offered nothing at all this turn."],
];

describe("secret scanner recall floor (E5): the real shapes still flag", () => {
  it.each(REAL_SECRETS)("flags a bare %s", (_label, secret) => {
    expect(scanForSecrets(secret)).not.toHaveLength(0);
  });

  it.each(REAL_SECRETS)("flags a labelled %s", (_label, secret) => {
    expect(scanForSecrets(`export TOKEN=${secret}`)).not.toHaveLength(0);
  });

  it("catches every real shape by an EXPLICIT rule, never only by entropy", () => {
    // This is the assertion that makes the precision fix safe. If a shape is only
    // ever caught by `high_entropy_token`, then any future tightening of the
    // generic heuristic silently drops it.
    for (const [label, secret] of REAL_SECRETS) {
      const hits = scanForSecrets(secret).filter((h) => h !== "high_entropy_token");
      expect([label, hits.length > 0]).toEqual([label, true]);
    }
  });

  it("keeps the pre-upload credential denylist independent and intact", () => {
    // scanForCredentials is the REAL fail-closed gate and deliberately excludes the
    // entropy heuristic. Nothing in this precision work may touch it.
    for (const [label, secret] of REAL_SECRETS) {
      expect([label, scanForCredentials(secret).length > 0]).toEqual([label, true]);
    }
  });
});

describe("secret scanner precision (E4/E6): document identifiers are not secrets", () => {
  it.each(MEASURED_FALSE_POSITIVES)("does not flag a %s", (_label, text) => {
    expect(scanForSecrets(text)).toEqual([]);
  });

  it.each(BENIGN_IDENTIFIERS)("keeps a %s clean", (_label, text) => {
    expect(scanForSecrets(text)).toEqual([]);
  });

  it("does not exempt a REMOTE link target the way it exempts a local one", () => {
    // A relative markdown target is a file in this repo. An http(s) target can carry
    // a signed URL, a query-string token or embedded credentials, so it gets no
    // document-identifier exemption.
    const remote = "[x](https://example.com/cb?token=AbCdEf0123456789AbCdEf0123456789AbCdEf.md)";
    expect(scanForSecrets(remote)).toContain("high_entropy_token");
  });

  it("states its residual out loud: a crafted secret wearing a doc extension passes", () => {
    // Pinned, not argued away. This is the accepted cost of the exemption, and it is
    // why the scanner stays observe-only rather than being promoted to a gate.
    const crafted = "abcdefghijklmnopqrstuvwxyz0123456789abcdef.md";
    expect(scanForSecrets(crafted)).toEqual([]);
  });
});
