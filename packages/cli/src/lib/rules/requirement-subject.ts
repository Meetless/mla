import { canonicalize, sha256Hex, type CanonicalObject } from "./canonical-json";

/**
 * RequirementSubject extraction + deterministic subject matching, vendored into the CLI
 * for the CE0 forcing function (proposal §1.6).
 *
 * Why vendored, not imported: the CLI does not depend on @meetless/utils. This is a
 * byte-faithful copy of packages/utils/src/requirement-subject.ts:
 *
 *  - extractRequirementSubject    : raw prompt -> structured RequirementSubject (the
 *                                   obligation side, used by the UserPromptSubmit hook)
 *  - matchConsultationSubject     : (required, consultation) -> per-subject coverage
 *  - selectEligibleConsultations  : keep COMPLETE + delivered + on-time consultations
 *  - recomputeSubjectSatisfaction : (requiredSubjects, eligible) -> SubjectSatisfactionProof[]
 *  - isObligationSatisfied        : every required subject has a proof
 *
 * The extraction half feeds prompt-submit; the consultation half (matcher + reducer) feeds
 * the agent-pull capture and Stop slices. Both share ONE normalizer: a consultation's query
 * subject and a turn's required subject are built by the same extractor, so identical text
 * keys identically and coverage cannot silently break.
 *
 * §1.6 makes the subject a STRUCTURED value, not an opaque hash, because coverage is a
 * field-wise intersection. The `fingerprint` is IDENTITY ONLY: it keys dedup, audit, and
 * the obligation's UNIQUE constraint, and is NEVER a similarity input. It is sha256 over
 * RFC 8785 canonical JSON, exactly like the utils side, so the two implementations emit
 * byte-identical digests for the same structured subject; the golden corpus +
 * requirement-subject.spec.ts pin both the extraction and the match vectors.
 */

/** The structured matching key (§1.6). `normalizedTerms` and the three id sets are
 * stored sorted + deduped (set semantics) so identity is a pure function of content,
 * independent of input order. */
export interface RequirementSubject {
  /** Stable, addressable handle within the turn. v1 derives it deterministically from
   * the identity fingerprint, so identical content yields the same handle (free dedup). */
  subjectId: string;
  /** Lowercased, stopworded subject terms lifted from the prompt; sorted+deduped. */
  normalizedTerms: string[];
  /** Resolved governed entities, when an upstream resolver supplies them. */
  entityIds: string[];
  /** Referenced decisions / diffs. */
  decisionIds: string[];
  /** Canonical concepts. */
  conceptIds: string[];
  /** Hash over the normalized fields; IDENTITY only, never a similarity input. */
  fingerprint: string;
}

/** The structured fields the fingerprint reads (everything on a RequirementSubject
 * except its derived `subjectId` and `fingerprint`). */
export interface RequirementSubjectFields {
  normalizedTerms: string[];
  entityIds: string[];
  decisionIds: string[];
  conceptIds: string[];
}

export const REQUIREMENT_SUBJECT_EXTRACTOR_VERSION = "prompt-terms-v1";
export const SUBJECT_FINGERPRINT_SCHEMA_VERSION = "requirement-subject-v1";
export const SUBJECT_STOPWORD_SET_VERSION = "seed-v1";

/** Minimum length for a kept term; drops single-character noise left by punctuation /
 * contraction splits ("don't" -> "don","t" -> "don"). */
const MIN_TERM_LENGTH = 2;

const sortedFrozen = (words: string[]): readonly string[] =>
  Object.freeze(Array.from(new Set(words)).sort());

/** The versioned seed stopword set: English function words plus the question and
 * governance scaffolding that wraps a governed subject ("what did we decide about X",
 * "why did we choose Y", "who owns Z", "are we still doing W"). Content nouns that ARE
 * the subject (policy, canonical, architecture, decision, model, ...) are deliberately
 * absent. Frozen so identity is byte-stable; the corpus pins the exact behavior. */
export const SUBJECT_STOPWORDS: readonly string[] = sortedFrozen([
  "a", "about", "an", "and", "any", "are", "as", "at",
  "be", "been", "being", "between", "but", "by",
  "can", "choose", "chose", "chosen", "could",
  "decide", "decided", "did", "do", "does", "doing",
  "for", "from",
  "had", "has", "have", "how",
  "i", "in", "into", "is", "it", "its",
  "my", "nor", "of", "on", "or", "our", "over",
  "own", "owned", "owns",
  "approve", "approved", "approves",
  "should", "so", "still",
  "that", "the", "their", "them", "then", "there", "these", "this", "those", "to",
  "under", "us",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
  "you", "your",
]);

const STOPWORD_SET = new Set(SUBJECT_STOPWORDS);

/**
 * Lift the deterministic subject terms from a prompt: lowercase, split on any
 * non-alphanumeric run, drop stopwords and sub-`MIN_TERM_LENGTH` tokens, then return the
 * sorted, deduped set. Order-independent and idempotent.
 */
export function normalizeSubjectTerms(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  const kept = new Set<string>();
  for (const tok of tokens) {
    if (tok.length < MIN_TERM_LENGTH) continue;
    if (STOPWORD_SET.has(tok)) continue;
    kept.add(tok);
  }
  return Array.from(kept).sort();
}

const sortedUniq = (xs: readonly string[]): string[] =>
  Array.from(new Set(xs)).sort();

/**
 * Build the closed canonical fingerprint payload. Every id / term set is sorted +
 * deduped so the digest is a pure function of SET content (identity), and the schema
 * version is pinned so a version bump rotates every digest.
 */
export function buildRequirementSubjectPayload(
  fields: RequirementSubjectFields,
): CanonicalObject {
  return {
    schemaVersion: SUBJECT_FINGERPRINT_SCHEMA_VERSION,
    normalizedTerms: sortedUniq(fields.normalizedTerms),
    entityIds: sortedUniq(fields.entityIds),
    decisionIds: sortedUniq(fields.decisionIds),
    conceptIds: sortedUniq(fields.conceptIds),
  };
}

/** Identity fingerprint over the structured fields (sha256 hex). Identity only. */
export function requirementSubjectFingerprint(
  fields: RequirementSubjectFields,
): string {
  return sha256Hex(canonicalize(buildRequirementSubjectPayload(fields)));
}

/** Optional already-resolved id sets an upstream resolver may pass in. With no resolver
 * wired (v1), all default to empty and only `normalizedTerms` carries signal. */
export interface ResolvedSubjectIds {
  entityIds?: string[];
  decisionIds?: string[];
  conceptIds?: string[];
}

/**
 * Extract a structured RequirementSubject from a raw prompt. The term set is lifted
 * deterministically here; entity / decision / concept ids are accepted from an upstream
 * resolver (none wired in v1, so they default empty) rather than fabricated. `subjectId`
 * is derived from the identity fingerprint, so the same structured content always yields
 * the same handle.
 */
export function extractRequirementSubject(
  prompt: string,
  resolved: ResolvedSubjectIds = {},
): RequirementSubject {
  const fields: RequirementSubjectFields = {
    normalizedTerms: normalizeSubjectTerms(prompt),
    entityIds: sortedUniq(resolved.entityIds ?? []),
    decisionIds: sortedUniq(resolved.decisionIds ?? []),
    conceptIds: sortedUniq(resolved.conceptIds ?? []),
  };
  const fingerprint = requirementSubjectFingerprint(fields);
  return { subjectId: `subj:${fingerprint}`, ...fields, fingerprint };
}

/**
 * The obligation's required subject, lifted from the user prompt. A thin, named call
 * site over the single `extractRequirementSubject` normalizer: both the obligation side
 * and the consultation side share ONE normalizer, never a second extractor. It takes no
 * resolved-ids argument by construction, because the proactive-enrich path surfaces no
 * resolved ids at prompt-submit time; a required subject is strictly terms-only and
 * cannot carry fabricated ids.
 */
export function buildRequiredSubjectFromPrompt(prompt: string): RequirementSubject {
  return extractRequirementSubject(prompt, {});
}

// ---------------------------------------------------------------------------
// Consultation side: deterministic subject matching + the satisfaction reducer
// (byte-faithful copy of the utils consultation half).
// ---------------------------------------------------------------------------

/** A per-subject coverage grade (§1.6). FULL / PARTIAL / NONE / UNKNOWN is the OFFLINE
 * label space; the CE0 deterministic matcher in this module only ever produces FULL or
 * UNKNOWN (see `matchConsultationSubject`). PARTIAL and NONE are reserved for the later
 * versioned CE2 semantic grader and are part of the shared value type, never emitted here. */
export type SubjectCoverageResult = "FULL" | "PARTIAL" | "NONE" | "UNKNOWN";

/** Per-subject coverage of one consultation against one required subject. */
export interface SubjectCoverage {
  subjectId: string;
  result: SubjectCoverageResult;
  /** The live deterministic-intersection signal (CE0 status driver). In this v1 grader
   * candidateMatch === (result === "FULL"). */
  candidateMatch: boolean;
}

export const SUBJECT_MATCH_VERSION = "deterministic-intersection-v1";

/** Fraction of the REQUIRED subject's terms that a consultation must contain for a
 * term-based FULL match. Directional: it measures whether the consultation COVERS the
 * required subject, not mutual similarity. */
export const SUBJECT_TERM_OVERLAP_THRESHOLD = 0.5;
export const SUBJECT_TERM_OVERLAP_THRESHOLD_VERSION = "required-containment-half-v1";

/**
 * A consultation's query subject, lifted from the retrieval query the agent issued. The
 * SAME normalizer as `buildRequiredSubjectFromPrompt`, so identical text yields a
 * byte-identical subject (the two sides can never silently diverge). Resolved ids are
 * admitted ONLY when the call already surfaced them (e.g. a kb_doc_detail citation id);
 * they default empty, never invented here.
 */
export function buildConsultationSubjectFromQuery(
  query: string,
  resolved: ResolvedSubjectIds = {},
): RequirementSubject {
  return extractRequirementSubject(query, resolved);
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

/** Fraction of `required`'s terms present in `consultation` (directional containment).
 * Zero when `required` has no terms (nothing to cover). */
function requiredTermContainment(
  required: readonly string[],
  consultation: readonly string[],
): number {
  if (required.length === 0) return 0;
  const set = new Set(consultation);
  const hit = required.reduce((n, t) => (set.has(t) ? n + 1 : n), 0);
  return hit / required.length;
}

/**
 * The CE0 deterministic coverage ladder (§1.6). candidateMatch is true iff a non-empty id
 * intersection on entityIds / decisionIds / conceptIds, OR a required-term containment at
 * or above the versioned threshold. Anything uncertain (including a disjoint pair or a
 * degenerate required subject) fails toward silence: result UNKNOWN, candidateMatch false,
 * which neither satisfies nor violates. This grader never asserts PARTIAL or NONE; the
 * crude term test is not entitled to claim non-coverage, so a non-match is UNKNOWN, not NONE.
 *
 * Source-independent by design: a PROACTIVE_PUSH does NOT blanket match. A push is graded
 * by this same per-subject test; it contributes a proof to a required subject only when its
 * query subjects cover that subject, exactly as `recomputeSubjectSatisfaction` attributes proofs.
 */
export function matchConsultationSubject(
  required: RequirementSubject,
  consultation: RequirementSubject,
): SubjectCoverage {
  const idIntersect =
    intersects(required.entityIds, consultation.entityIds) ||
    intersects(required.decisionIds, consultation.decisionIds) ||
    intersects(required.conceptIds, consultation.conceptIds);

  const termMatch =
    requiredTermContainment(required.normalizedTerms, consultation.normalizedTerms) >=
    SUBJECT_TERM_OVERLAP_THRESHOLD;

  const candidateMatch = idIntersect || termMatch;
  return {
    subjectId: required.subjectId,
    result: candidateMatch ? "FULL" : "UNKNOWN",
    candidateMatch,
  };
}

/** How a governed-memory consultation was initiated. The tuple is the SINGLE source of both
 * the closed value set and the stable sort order the offline projector resolves a finalized
 * obligation's `satisfiedBySources` into. CE0 emits only PROACTIVE_PUSH and AGENT_PULL; today
 * only AGENT_PULL is written (the PostToolUse capture seam). STOP_RECOVERY_PULL is a held seam:
 * it lives in the enum so its ordering is fixed up front, but CE0 (RECORD_ONLY) never writes
 * it. */
export const CONSULTATION_SOURCES = ["PROACTIVE_PUSH", "AGENT_PULL", "STOP_RECOVERY_PULL"] as const;
export type ConsultationSource = (typeof CONSULTATION_SOURCES)[number];

/** Whether a governed-memory retrieval ran to a trustworthy completion (the CE0 retrieval
 * envelope). COMPLETE = a valid canonical response, regardless of whether it returned hits;
 * FAILED = the retrieval errored; UNKNOWN = a malformed / missing / uncorrelatable response. */
export type ConsultationExecution = "COMPLETE" | "FAILED" | "UNKNOWN";

/** Present only on a COMPLETE consultation: did the canonical response carry hits
 * (RESULTS_RETURNED) or was it a valid empty answer (NO_MATCH)? Result NEVER gates
 * eligibility: a COMPLETE + NO_MATCH consultation still attests its query subjects were
 * consulted. */
export type ConsultationResult = "RESULTS_RETURNED" | "NO_MATCH";

/** The pure evidence one governed-memory consultation contributes to subject satisfaction.
 * The PERSISTED ConsultationAttempt record (ce0-store) carries workspaceId / LocalTurnIdentity
 * / createdAt on top; this is the subset the deterministic reducer reads.
 * `consultationSubjects` are the QUERY subjects the consultation asked about; `orderingToken`
 * is the monotonic per-turn position used both to compare against the claimed deadline and to
 * break ties so the earliest eligible consultation wins a subject's proof. */
export interface ConsultationAttempt {
  consultationId: string;
  consultationSubjects: RequirementSubject[];
  execution: ConsultationExecution;
  result?: ConsultationResult;
  deliveredToAnsweringContext: boolean;
  orderingToken: number;
}

/** One proof that a required subject was consulted: the required `subjectId` and the id of
 * the eligible consultation that covered it. The set of proofs is the obligation's
 * `subjectSatisfaction` (TurnRuleObligation, ce0-store). */
export interface SubjectSatisfactionProof {
  subjectId: string;
  consultationId: string;
}

/**
 * A consultation contributes proofs iff it COMPLETED and its evidence reached the parent
 * answering context. Result (RESULTS_RETURNED vs NO_MATCH) does NOT gate: asking governed
 * memory about a subject and completing, even with zero hits, is a consultation of that
 * subject. FAILED, UNKNOWN, and undelivered consultations never contribute (we cannot
 * attest they consulted).
 */
export function consultationContributesProof(c: ConsultationAttempt): boolean {
  return c.execution === "COMPLETE" && c.deliveredToAnsweringContext === true;
}

/**
 * The eligible consultation set for an obligation: contributing consultations (above)
 * recorded on or before the claimed deadline. Pass `deadlineOrderingToken = null` while the
 * obligation has no deadline yet (the first Stop has not claimed it), so every contributing
 * consultation is on time. Once the deadline is claimed at orderingToken D, a consultation at
 * orderingToken > D is late: it stays factual telemetry but can never produce an on-time proof.
 */
export function selectEligibleConsultations(
  consultations: readonly ConsultationAttempt[],
  deadlineOrderingToken: number | null,
): ConsultationAttempt[] {
  return consultations.filter(
    (c) =>
      consultationContributesProof(c) &&
      (deadlineOrderingToken === null || c.orderingToken <= deadlineOrderingToken),
  );
}

/**
 * Accumulate one SubjectSatisfactionProof per COVERED required subject across all ELIGIBLE
 * consultations: a required subject is covered iff some eligible consultation's query
 * subjects match it (via `matchConsultationSubject`), and the proof records the consultation
 * that covered it. Two consultations can jointly satisfy two subjects; one consultation can
 * satisfy several. This is NOT a coverage table: there is no per-subject grade, only the
 * presence or absence of a proof.
 *
 * Deterministic and idempotent: consultations are considered in ascending (orderingToken,
 * then consultationId), so the EARLIEST eligible consultation wins a subject's proof
 * regardless of input order, and a duplicated consultation yields the identical proof. Proofs
 * are emitted in `requiredSubjects` order, at most one per subjectId (a subject listed twice
 * still yields one proof). Uncovered required subjects yield no proof.
 */
export function recomputeSubjectSatisfaction(
  requiredSubjects: readonly RequirementSubject[],
  eligibleConsultations: readonly ConsultationAttempt[],
): SubjectSatisfactionProof[] {
  const ordered = [...eligibleConsultations].sort((a, b) =>
    a.orderingToken !== b.orderingToken
      ? a.orderingToken - b.orderingToken
      : a.consultationId < b.consultationId
        ? -1
        : a.consultationId > b.consultationId
          ? 1
          : 0,
  );
  const proofs: SubjectSatisfactionProof[] = [];
  const proven = new Set<string>();
  for (const required of requiredSubjects) {
    if (proven.has(required.subjectId)) continue;
    const hit = ordered.find((c) =>
      c.consultationSubjects.some(
        (qs) => matchConsultationSubject(required, qs).candidateMatch,
      ),
    );
    if (hit) {
      proofs.push({ subjectId: required.subjectId, consultationId: hit.consultationId });
      proven.add(required.subjectId);
    }
  }
  return proofs;
}

/**
 * SATISFIED iff every required subject has a proof. An empty required set does NOT vacuously
 * satisfy (fail toward silence): satisfaction requires demonstrated consultation of at least
 * one subject. On-time-ness is already enforced by `selectEligibleConsultations`, so a proof
 * set built from eligible consultations is on time by construction.
 */
export function isObligationSatisfied(
  requiredSubjects: readonly RequirementSubject[],
  proofs: readonly SubjectSatisfactionProof[],
): boolean {
  if (requiredSubjects.length === 0) return false;
  const proven = new Set(proofs.map((p) => p.subjectId));
  return requiredSubjects.every((r) => proven.has(r.subjectId));
}
