import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  extractRequirementSubject,
  buildRequiredSubjectFromPrompt,
  buildConsultationSubjectFromQuery,
  normalizeSubjectTerms,
  requirementSubjectFingerprint,
  buildRequirementSubjectPayload,
  matchConsultationSubject,
  consultationContributesProof,
  selectEligibleConsultations,
  recomputeSubjectSatisfaction,
  isObligationSatisfied,
  REQUIREMENT_SUBJECT_EXTRACTOR_VERSION,
  SUBJECT_FINGERPRINT_SCHEMA_VERSION,
  SUBJECT_STOPWORD_SET_VERSION,
  SUBJECT_MATCH_VERSION,
  SUBJECT_TERM_OVERLAP_THRESHOLD,
  SUBJECT_TERM_OVERLAP_THRESHOLD_VERSION,
  type RequirementSubject,
  type SubjectCoverage,
  type ConsultationAttempt,
} from "../../../src/lib/rules/requirement-subject";

// Commit 6b: the RequirementSubject extractor + RFC 8785 canonical fingerprint,
// vendored into the CLI (notes/20260617-evidence-consultation-forcing-function-
// proposal.md §1.6). The CLI does not depend on @meetless/utils, so the
// UserPromptSubmit hook reimplements extraction + fingerprinting here. §1.6 anticipates
// exactly this cross-language duplication and guards it with byte-identical
// fingerprints: the obligation's requiredSubjects and a later consultation's query
// subjects must key identically across implementations or coverage silently breaks.
//
// The contract is pinned by the SAME golden corpus the utils side uses, copied here
// byte-for-byte. The sha256 sidecar pins the corpus bytes; every extraction vector then
// pins the extractor: a one-byte divergence in normalization or canonicalization rotates
// a fingerprint and fails this suite.

const FIXTURES = path.join(__dirname, "fixtures");
const CORPUS_PATH = path.join(FIXTURES, "requirement-subject-corpus.json");
const SIDECAR_PATH = path.join(FIXTURES, "requirement-subject-corpus.sha256");

interface ExtractionVector {
  label: string;
  prompt: string;
  resolved?: { entityIds?: string[]; decisionIds?: string[]; conceptIds?: string[] };
  derived: RequirementSubject;
}

interface MatchVector {
  label: string;
  required: RequirementSubject;
  consultation: RequirementSubject;
  coverage: SubjectCoverage;
}

const corpusRaw = fs.readFileSync(CORPUS_PATH, "utf8");
const corpus = JSON.parse(corpusRaw) as {
  extractionVectors: ExtractionVector[];
  matchVectors: MatchVector[];
};

describe("the vendored corpus is byte-pinned by its sidecar", () => {
  it("matches the sha256 sidecar (the cross-language byte anchor)", () => {
    const expected = fs.readFileSync(SIDECAR_PATH, "utf8").trim();
    const actual = crypto.createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    expect(actual).toBe(expected);
  });
});

describe("extractRequirementSubject reproduces every golden extraction vector byte-for-byte", () => {
  for (const v of corpus.extractionVectors) {
    it(`reproduces the '${v.label}' subject (id + terms + ids + fingerprint)`, () => {
      const got = extractRequirementSubject(v.prompt, v.resolved ?? {});
      expect(got).toEqual(v.derived);
      // The fingerprint is the cross-language anchor; assert it explicitly too.
      expect(got.fingerprint).toBe(v.derived.fingerprint);
      expect(got.subjectId).toBe(`subj:${v.derived.fingerprint}`);
    });
  }
});

describe("canonical-json pins the exact RFC 8785 byte sequence", () => {
  it("encodes the flat subject payload with keys sorted by UTF-16 code unit, no whitespace", () => {
    const payload = buildRequirementSubjectPayload({
      normalizedTerms: ["soft", "gate", "enforcement"],
      entityIds: [],
      decisionIds: [],
      conceptIds: [],
    });
    const canonical = canonicalize(payload);
    expect(canonical).toBe(
      '{"conceptIds":[],"decisionIds":[],"entityIds":[],' +
        '"normalizedTerms":["enforcement","gate","soft"],"schemaVersion":"requirement-subject-v1"}',
    );
    // sha256 of that exact byte sequence IS the golden soft-gate fingerprint.
    expect(sha256Hex(canonical)).toBe(
      "e0a9890cdd58624a050c1f17f788aa2720fef29aa95f52d593e949de56cbc89b",
    );
  });
});

describe("extractor internals", () => {
  it("normalizeSubjectTerms drops stopwords + sub-2-char tokens and returns a sorted, deduped set", () => {
    expect(normalizeSubjectTerms("What did we decide about the SOFT gate gate")).toEqual([
      "gate",
      "soft",
    ]);
  });

  it("derives subjectId from the identity fingerprint", () => {
    const fp = requirementSubjectFingerprint({
      normalizedTerms: ["email", "digest"],
      entityIds: [],
      decisionIds: [],
      conceptIds: [],
    });
    const subject = buildRequiredSubjectFromPrompt("Are we still doing the email digest");
    expect(subject.fingerprint).toBe(fp);
    expect(subject.subjectId).toBe(`subj:${fp}`);
  });

  it("ships the pinned extractor / schema / stopword-set versions", () => {
    expect(REQUIREMENT_SUBJECT_EXTRACTOR_VERSION).toBe("prompt-terms-v1");
    expect(SUBJECT_FINGERPRINT_SCHEMA_VERSION).toBe("requirement-subject-v1");
    expect(SUBJECT_STOPWORD_SET_VERSION).toBe("seed-v1");
  });
});

// Commit 7a: the consultation-side half of the same vendored module (proposal §1.6).
// The matcher is the second cross-language transform, so it is pinned by the SAME golden
// corpus (its matchVectors family); the satisfaction reducer is pure boolean set logic
// with no hashing, so it is pinned by the spec, not the corpus. Both halves share ONE
// normalizer: a consultation's query subject and a turn's required subject are built by
// the same extractor, so identical text can never key differently and silently miss.

describe("matchConsultationSubject reproduces every golden match vector byte-for-byte", () => {
  for (const v of corpus.matchVectors) {
    it(`grades '${v.label}' as the pinned coverage`, () => {
      expect(matchConsultationSubject(v.required, v.consultation)).toEqual(v.coverage);
    });
  }
});

describe("the consultation-side matcher ships its pinned versions and shares ONE normalizer", () => {
  it("pins the match version and the required-containment threshold", () => {
    expect(SUBJECT_MATCH_VERSION).toBe("deterministic-intersection-v1");
    expect(SUBJECT_TERM_OVERLAP_THRESHOLD).toBe(0.5);
    expect(SUBJECT_TERM_OVERLAP_THRESHOLD_VERSION).toBe("required-containment-half-v1");
  });

  it("builds a consultation subject with the SAME normalizer as the required subject", () => {
    const text = "What did we decide about the soft gate enforcement";
    expect(buildConsultationSubjectFromQuery(text)).toEqual(buildRequiredSubjectFromPrompt(text));
  });

  it("admits resolved ids on the consultation side (sorted + deduped), never invents them", () => {
    const got = buildConsultationSubjectFromQuery("rollout plan", { entityIds: ["E2", "E1", "E2"] });
    expect(got.entityIds).toEqual(["E1", "E2"]);
    expect(got.decisionIds).toEqual([]);
  });
});

/** Build a pure ConsultationAttempt input for the reducer, COMPLETE + delivered + on time
 * by default, so each test overrides only the field it exercises. */
function consultation(
  over: Partial<ConsultationAttempt> & { consultationId: string },
): ConsultationAttempt {
  return {
    consultationSubjects: [],
    execution: "COMPLETE",
    deliveredToAnsweringContext: true,
    orderingToken: 0,
    ...over,
  };
}

describe("eligibility: only COMPLETE + delivered consultations contribute, and only on time", () => {
  it("contributes iff COMPLETE and delivered; the result (NO_MATCH) never gates", () => {
    expect(
      consultationContributesProof(
        consultation({ consultationId: "c", execution: "COMPLETE", result: "NO_MATCH" }),
      ),
    ).toBe(true);
    expect(
      consultationContributesProof(
        consultation({ consultationId: "c", deliveredToAnsweringContext: false }),
      ),
    ).toBe(false);
    expect(
      consultationContributesProof(consultation({ consultationId: "c", execution: "FAILED" })),
    ).toBe(false);
    expect(
      consultationContributesProof(consultation({ consultationId: "c", execution: "UNKNOWN" })),
    ).toBe(false);
  });

  it("with no deadline yet (null) keeps every contributing consultation, drops non-contributing", () => {
    const cs = [
      consultation({ consultationId: "a", orderingToken: 5 }),
      consultation({ consultationId: "b", orderingToken: 99, execution: "FAILED" }),
    ];
    expect(selectEligibleConsultations(cs, null).map((c) => c.consultationId)).toEqual(["a"]);
  });

  it("once a deadline is claimed at D, drops contributing consultations recorded after D", () => {
    const cs = [
      consultation({ consultationId: "ontime", orderingToken: 3 }),
      consultation({ consultationId: "atdeadline", orderingToken: 7 }),
      consultation({ consultationId: "late", orderingToken: 8 }),
    ];
    expect(selectEligibleConsultations(cs, 7).map((c) => c.consultationId)).toEqual([
      "ontime",
      "atdeadline",
    ]);
  });
});

describe("recomputeSubjectSatisfaction accumulates one proof per covered required subject", () => {
  const softGate = buildRequiredSubjectFromPrompt("soft gate enforcement");
  const emailDigest = buildRequiredSubjectFromPrompt("email digest");

  it("covers a required subject when an eligible consultation's query subject matches it", () => {
    const c = consultation({
      consultationId: "c1",
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement rollout")],
    });
    expect(recomputeSubjectSatisfaction([softGate, emailDigest], [c])).toEqual([
      { subjectId: softGate.subjectId, consultationId: "c1" },
    ]);
  });

  it("lets two consultations jointly satisfy two subjects, in requiredSubjects order", () => {
    const c1 = consultation({
      consultationId: "c1",
      orderingToken: 1,
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    const c2 = consultation({
      consultationId: "c2",
      orderingToken: 2,
      consultationSubjects: [buildConsultationSubjectFromQuery("email digest")],
    });
    expect(recomputeSubjectSatisfaction([softGate, emailDigest], [c1, c2])).toEqual([
      { subjectId: softGate.subjectId, consultationId: "c1" },
      { subjectId: emailDigest.subjectId, consultationId: "c2" },
    ]);
  });

  it("gives a subject's proof to the EARLIEST eligible consultation (token first), any input order", () => {
    const early = consultation({
      consultationId: "z",
      orderingToken: 1,
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    const late = consultation({
      consultationId: "a",
      orderingToken: 5,
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    expect(recomputeSubjectSatisfaction([softGate], [late, early])).toEqual([
      { subjectId: softGate.subjectId, consultationId: "z" },
    ]);
  });

  it("breaks an orderingToken tie on the lexicographically smaller consultationId", () => {
    const ca = consultation({
      consultationId: "a",
      orderingToken: 4,
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    const cb = consultation({
      consultationId: "b",
      orderingToken: 4,
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    expect(recomputeSubjectSatisfaction([softGate], [cb, ca])).toEqual([
      { subjectId: softGate.subjectId, consultationId: "a" },
    ]);
  });

  it("emits at most one proof per subjectId even if the required subject is listed twice", () => {
    const c = consultation({
      consultationId: "c1",
      consultationSubjects: [buildConsultationSubjectFromQuery("soft gate enforcement")],
    });
    expect(recomputeSubjectSatisfaction([softGate, softGate], [c])).toEqual([
      { subjectId: softGate.subjectId, consultationId: "c1" },
    ]);
  });

  it("leaves an uncovered required subject without a proof", () => {
    const c = consultation({
      consultationId: "c1",
      consultationSubjects: [buildConsultationSubjectFromQuery("completely different topic here")],
    });
    expect(recomputeSubjectSatisfaction([softGate], [c])).toEqual([]);
  });
});

describe("isObligationSatisfied requires a proof for every required subject, never vacuously", () => {
  const softGate = buildRequiredSubjectFromPrompt("soft gate enforcement");
  const emailDigest = buildRequiredSubjectFromPrompt("email digest");

  it("is false for an empty required set (fail toward silence, no vacuous satisfaction)", () => {
    expect(isObligationSatisfied([], [])).toBe(false);
  });

  it("is true once every required subject has a proof", () => {
    expect(
      isObligationSatisfied(
        [softGate, emailDigest],
        [
          { subjectId: softGate.subjectId, consultationId: "c1" },
          { subjectId: emailDigest.subjectId, consultationId: "c2" },
        ],
      ),
    ).toBe(true);
  });

  it("is false while any required subject is unproven", () => {
    expect(
      isObligationSatisfied(
        [softGate, emailDigest],
        [{ subjectId: softGate.subjectId, consultationId: "c1" }],
      ),
    ).toBe(false);
  });
});
