// Onboarding enrichment protocol: the pure, dependency-free core shared by the two
// CLI bookends (`enrich plan` writes the authoritative run record; `enrich ingest`
// loads it and validates the scouts' candidates). Everything here is deterministic
// and side-effect-free: types, the candidate identity hash, the plan digest, and the
// SHAPE validators. Impure checks (realpath containment, exist-at-HEAD, line-range vs
// real file length, fs/network) live in ingest.ts; clock + id injection lives in
// plan.ts. See notes/20260626-mla-agent-onboarding-enrichment-plan.md (§5, §5b, §6, §6b, §8).

import { createHash } from "crypto";

export const PROTOCOL_VERSION = 1 as const;

// Input bounds (§8). Explicit MVP constants; only the time budget is configurable.
export const MAX_DOCUMENT_TARGETS = 20;
// History bounds are SPLIT into scan vs selected (verdict item 7): the scan window is the
// pool `git log` walks (bounded, never the whole repo), and the selected count is what we
// actually inline as the commit allowlist. Keeping them distinct lets the byte-budget fill
// reach DEEPER than the inline cap (a single fat commit no longer starves the rest) without
// ever loading an unbounded log. scan >= selected by construction.
export const MAX_HISTORY_SCAN_COMMITS = 300;
export const MAX_HISTORY_SELECTED_COMMITS = 40;
export const MAX_PREPARED_INPUT_BYTES = 200_000;
// Per-ROLE HARD cap (verdict item 8, revised). Each scout is bounded INDEPENDENTLY: an
// under-producing scout never cedes its surplus and an over-producer is never handed the
// other's leftover (no reallocation).
//
// This is a total Record over ScoutName, NOT a scalar dealt out of a shared pool, because
// the shared-pool form made ARRAY ORDER part of the allocation contract: it walked the slots
// in order and drained `remainingTotal`, so with two slots at 10 and a total of 20 the pool
// hit zero and any THIRD role silently allocated 0. That is the worst failure shape we have:
// the scout still dispatches, still reads the docs, still burns the history payload, still
// returns findings, and ingest discards every one of them without an error. A role's cap must
// be a property of the role, never of where it sits in a list.
//
// `reconciliation` is deliberately small: it reports doc/code inconsistencies, which are
// high-value and low-volume. A handful of undeniable findings is the goal, not coverage.
export const SCOUT_CANDIDATE_CAPS = {
  documentation: 10,
  history: 10,
  reconciliation: 3,
} as const satisfies Record<ScoutName, number>;

// DERIVED, never hand-written. Deriving it is what makes the old run-total backstop provably
// dead: per-role caps can no longer sum past the total, so nothing can be silently clamped.
export const MAX_CANDIDATES_TOTAL: number = Object.values(SCOUT_CANDIDATE_CAPS).reduce(
  (sum, cap) => sum + cap,
  0,
);

/**
 * The candidate ceiling for one role. The single reader for both allocation (ingest) and the
 * "aim for N" sentence in the scout's own brief, so a scout can never be told to aim at a
 * number ingest will not honor.
 */
export function scoutCandidateCap(role: ScoutName): number {
  return SCOUT_CANDIDATE_CAPS[role];
}
export const DEFAULT_BUDGET_MS = 240_000;

// Defensive bounds NOT pinned by the plan (§5 says only "max statement length" and
// "allowed kind"); these are conservative defaults, tune freely.
export const MAX_STATEMENT_LENGTH = 500;
export const MIN_STATEMENT_LENGTH = 1; // non-empty after normalization; no semantic floor (the human governs durability)
export const MAX_EVIDENCE_PER_CANDIDATE = 12;
export const MIN_COMMIT_SHA_LENGTH = 7; // git's conventional abbreviation floor
export const MAX_RATIONALE_LENGTH = 1000; // rationale is a short "why", not an essay
// A quoted claim is a sentence or two of a document, not a section. The ceiling matters beyond
// tidiness: ingest re-reads the anchored range and requires this text to occur in it verbatim,
// so a quote allowed to be arbitrarily long is a quote that can span an entire file and "prove"
// a rule the document never states in one place.
export const MAX_CLAIM_TEXT_LENGTH = 600;
export const MAX_CLAIM_SCOPE_LENGTH = 300; // a repo-relative path or directory prefix

// Provenance of a candidate's rationale (memo Phase 1). The scouts are AGENTS, so any "why"
// THEY compose is an AGENT_SUMMARY; USER_EXPLICIT is reserved for the human's own words
// (e.g. a verbatim quote from an instruction file the user wrote). The two must never be
// conflated: presenting an agent paraphrase as user-provided is the exact failure this
// field exists to prevent, and a missing rationale always beats a fabricated one.
export const RATIONALE_SOURCES = ["USER_EXPLICIT", "AGENT_SUMMARY"] as const;
export type RationaleSource = (typeof RATIONALE_SOURCES)[number];

export const ENRICHMENT_KINDS = [
  "constraint",
  "decision",
  "convention",
  "boundary",
  "deprecation",
  "doc_code_inconsistency",
] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];

// The reconciliation scout's one finding kind, named as a constant because several rules key
// off it: which scout may emit it, which identity it hashes under, what a resolution may mint.
//
// It rides ENRICHMENT_KINDS so a finding travels the SAME validate/merge/persist path as every
// other candidate. It is deliberately NOT a governance rule. A doc_code_inconsistency asserts
// that a document and a commit disagree, which is a QUESTION for the human, not an answer: a
// historical commit and a current document are not automatically inconsistent. Nothing here is
// ever minted as policy on its own (materializeRules omits it from DURABLE_RULE_KINDS).
export const RECONCILIATION_FINDING_KIND = "doc_code_inconsistency" as const;
export type ReconciliationFindingKind = typeof RECONCILIATION_FINDING_KIND;

// The kinds that state a governed RULE, and therefore the only kinds a resolved finding may
// propose minting. DERIVED by exclusion, never written out as a second literal union: a
// hand-listed copy stops tracking the moment a kind is added, and the one member it must never
// contain (the finding kind) is exactly the member a stale copy would be free to regain. A
// finding whose resolution mints another finding is a loop with no rule at the end of it.
export type MintableEnrichmentKind = Exclude<EnrichmentKind, ReconciliationFindingKind>;
export const MINTABLE_ENRICHMENT_KINDS: readonly MintableEnrichmentKind[] = ENRICHMENT_KINDS.filter(
  (kind): kind is MintableEnrichmentKind => kind !== RECONCILIATION_FINDING_KIND,
);

// The rule kind a resolved finding proposes. An alias, not a parallel union, so the mint
// surface and the governance kinds cannot drift apart.
export type ProposedRuleKind = MintableEnrichmentKind;

// The scout roles. `documentation` and `history` EXTRACT governance candidates from one
// source each. `reconciliation` reads BOTH (the ranked doc targets via Read, the prepared
// commits inlined) and reports only where they disagree: the one finding class neither
// extraction scout can see, because each holds half the evidence.
//
// Order here is presentation only. It must never affect allocation (see SCOUT_CANDIDATE_CAPS)
// and there is a test that permutes it.
export const SCOUT_NAMES = ["documentation", "history", "reconciliation"] as const;
export type ScoutName = (typeof SCOUT_NAMES)[number];

/** Narrow an untrusted value to a ScoutName. The one membership test; no role literals. */
export function isScoutName(value: unknown): value is ScoutName {
  return typeof value === "string" && (SCOUT_NAMES as readonly string[]).includes(value);
}

const SMALL_COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];

/**
 * "three". User-facing copy in several commands used to spell the roster size as the
 * literal word "two"; prose is not type-checked, so a third role left three surfaces
 * confidently lying about how many scouts run. Every such sentence now derives from here.
 */
export function scoutCountWord(): string {
  return SMALL_COUNT_WORDS[SCOUT_NAMES.length] ?? String(SCOUT_NAMES.length);
}

export const SCOUT_STATUSES = ["complete", "failed", "timed_out"] as const;
export type ScoutStatus = (typeof SCOUT_STATUSES)[number];

/**
 * Compile-time exhaustiveness guard for a closed union.
 *
 * Use this instead of a binary `role === "documentation" ? a : b`. A ternary is not a
 * total function over ScoutName: it silently lumps every new role into the `else`
 * branch and the compiler stays green. That is how a reconciliation scout would have
 * quietly received the history scout's brief. A `switch` whose default calls this fails
 * to build the moment a role is added, which is exactly the signal we want.
 *
 * It throws at runtime too, because a value can reach here from unvalidated JSON even
 * when the types say it cannot.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

// --- Candidate schema (§5, discriminated evidence) -------------------------------

export interface FileEvidence {
  type: "file";
  path: string;
  startLine: number;
  endLine: number;
}
export interface CommitEvidence {
  type: "commit";
  commit: string;
  path?: string;
}
export type EnrichmentEvidence = FileEvidence | CommitEvidence;
export type EvidenceType = EnrichmentEvidence["type"];

// The anchors a candidate MUST carry, by the role that surfaced it. A total Record, because
// the requirement is a property of the role: `documentation` proves its claim with the lines
// that state it, `history` with the commit that made it, and `reconciliation` with BOTH,
// since its entire claim is that a specific document and a specific commit disagree. One
// anchor from a reconciliation scout is not a weaker finding, it is not a finding: with only
// the document there is no divergence, and with only the commit there is no rule.
export const REQUIRED_ANCHOR_TYPES = {
  documentation: ["file"],
  history: ["commit"],
  reconciliation: ["file", "commit"],
} as const satisfies Record<ScoutName, readonly EvidenceType[]>;

// The kinds each scout may emit, for the same reason REQUIRED_ANCHOR_TYPES is a total Record:
// the answer is a property of the role. The two extraction scouts surface governance rules and
// cannot see a doc/code disagreement (each holds half the evidence); the reconciliation scout
// holds both halves and reports ONLY the disagreement.
//
// Without this, adding the finding kind to ENRICHMENT_KINDS would have advertised it to all
// three scouts, and the two that cannot anchor it would have emitted it anyway. It also closes
// the reverse door: a reconciliation candidate dressed up as a plain `constraint` would skip
// every verification the finding exists for and land as a governed rule.
export const SCOUT_CANDIDATE_KINDS = {
  documentation: MINTABLE_ENRICHMENT_KINDS,
  history: MINTABLE_ENRICHMENT_KINDS,
  reconciliation: [RECONCILIATION_FINDING_KIND],
} as const satisfies Record<ScoutName, readonly EnrichmentKind[]>;

/** May `role` emit `kind`? The one membership test; no role literals at call sites. */
export function scoutMayEmitKind(role: ScoutName, kind: EnrichmentKind): boolean {
  return (SCOUT_CANDIDATE_KINDS[role] as readonly EnrichmentKind[]).includes(kind);
}

// --- Doc/code inconsistency (the reconciliation finding's payload) ----------------

// The commit-side half of a finding: the ONE changed file it claims contradicts the document.
//
// Structurally identical to PreparedGitFileChange on purpose, because ingest validates it by
// exact field-for-field comparison against the plan's prepared change under the validated
// commit SHA. It is a SEPARATE type because the provenance differs: a PreparedGitFileChange is
// what the CLI read out of git, a DivergenceFileChange is what a model claims it read out of
// the brief, and the entire point of the check is that those are not the same thing until they
// are proven equal.
export interface DivergenceFileChange {
  path: string;
  status: string; // git porcelain status letter(s), byte-identical to what the plan recorded
  renamedFrom?: string; // present iff status begins with R or C
}

type AssertTrue<T extends true> = T;
/**
 * Compile-time drift guard. If a field is added to either shape and not the other, the exact
 * comparison in ingest silently stops covering it (a claimed field the plan never recorded is
 * unverifiable; a recorded field the claim omits is unchecked). Divergence makes this `false`,
 * which fails the `extends true` constraint and breaks the build.
 */
export type DivergenceShapeGuard = AssertTrue<
  DivergenceFileChange extends PreparedGitFileChange
    ? PreparedGitFileChange extends DivergenceFileChange
      ? true
      : false
    : false
>;

// The claim classes v1 can PROVE from a commit's porcelain status letter alone.
//
// Every other doc/code disagreement (a behavior-preserving refactor, a comment-only edit, "does
// this hunk really violate the rule") needs the patch, and the scout has never seen one: the
// brief carries SHA, timestamp, subject, body, and changed-file statuses. A claim outside these
// four is not a weaker finding, it is an unprovable one.
export const DOC_CLAIM_CLASSES = ["never_modify", "never_add", "never_delete", "never_rename"] as const;
export type DocClaimClass = (typeof DOC_CLAIM_CLASSES)[number];

// Does `status` PROVE `claimClass` was violated? The single place a porcelain letter is
// interpreted, and a switch rather than a lookup so a newly added class cannot default to
// "matches nothing" (silently unprovable) or "matches anything" (silently universal).
//
// `M` proves modification and nothing else. It does NOT prove reintroduction: a document saying
// "X was removed and must stay removed" is contradicted by `A`, never by `M`, because `M` means
// the path was already there. That inference is exactly why the class list is closed.
export function statusProvesClaimViolation(claimClass: DocClaimClass, status: string): boolean {
  const letter = status.trim().charAt(0).toUpperCase();
  switch (claimClass) {
    case "never_modify":
      return letter === "M";
    case "never_add":
      return letter === "A";
    case "never_delete":
      return letter === "D";
    // R and C both land a governed path at a NEW location, which is what "never move this"
    // forbids; the plan records `renamedFrom` for exactly these two statuses.
    case "never_rename":
      return letter === "R" || letter === "C";
    default:
      return assertNever(claimClass, "statusProvesClaimViolation");
  }
}

// Which side of the change the claim's scope must cover. For a rename or copy the plan records
// the NEW path in `path` and the origin in `renamedFrom`; "never move X" identifies X by where
// it WAS, so the origin is the governed side. The other three classes have only one path.
// Returns null when a rename claim arrives without an origin (the shape validator rejects it).
export function governedChangePath(claimClass: DocClaimClass, change: DivergenceFileChange): string | null {
  return claimClass === "never_rename" ? (change.renamedFrom ?? null) : change.path;
}

// Does the claim's scope cover this path? An exact repo-relative path, or a directory prefix
// written with a trailing slash. No globs: a glob is where an unfalsifiable scope hides, and a
// scope of `**` makes every commit violate every claim. Narrow on purpose; widen only when a
// real finding is provably lost to it.
export function claimScopeCovers(scope: string, path: string): boolean {
  const s = scope.trim();
  const p = path.trim();
  if (s.length === 0 || p.length === 0) return false;
  return s.endsWith("/") ? p.startsWith(s) && p.length > s.length : p === s;
}

// Who last touched the sentence the claim quotes, stamped BY THE CLI from `git blame` after
// verification, never sent by a scout (it is absent from INCONSISTENCY_FIELDS, so a candidate
// carrying one is rejected as an unknown field).
//
// `commit` is the load-bearing half: it is the doc-anchor whose ancestry proves the document
// already said this when the divergent commit landed. The person is courtesy, and is omitted
// rather than guessed. `authorTime` is display metadata: nothing is decided from it, because
// commit dates are attacker- and rebase-controlled and are not a reliable ordering.
export interface DocClaimAttribution {
  commit: string; // full 40-char SHA of the commit that last touched the anchored range
  authorName?: string; // git's `author`, never the committer; omitted when git names none
  authorTime?: string; // ISO 8601 UTC, display only
}

// The finding itself: everything the human needs to resolve it and everything ingest needs to
// verify it. Carried ON the candidate rather than modelled as a second top-level object, so a
// finding rides the one validate/merge/persist path (a per-kind arity rule, not a second
// pipeline). Present iff kind === RECONCILIATION_FINDING_KIND, enforced both directions.
export interface DocCodeInconsistency {
  claimClass: DocClaimClass;
  // The document's assertion, quoted from the anchored line range. Ingest re-reads that range
  // out of the repository AT headCommit and rejects the finding unless this text occurs there
  // verbatim (whitespace-normalized only), so what is persisted is a CLI-verified quote rather
  // than a model paraphrase that happens to land near the truth.
  claimText: string;
  // The exact path, or the directory scope (trailing slash), the claim governs. Without it,
  // "merged migrations are never edited" is proven violated by any commit touching any file.
  claimScope: string;
  // The rule kind a `code_diverged` resolution would mint. The model proposes; the human's
  // selection is the approval.
  proposedRuleKind: ProposedRuleKind;
  // The single changed file that contradicts the claim, verified field-for-field against the
  // plan's prepared evidence for the validated commit.
  divergence: DivergenceFileChange;
  // Stamped by ingest, never by a scout, and deliberately OUTSIDE the finding's identity: the
  // same disagreement is the same finding whether or not git could name a person for it.
  attribution?: DocClaimAttribution;
}

// --- Resolving a finding (§5.9) --------------------------------------------------

// A finding is a QUESTION, and these are its three answers. The set is closed on purpose: a fourth
// outcome would be a state nothing acts on, and a finding nobody can close is worse than one that
// was never surfaced.
//
//   code_diverged  the document was right and the commit broke it. The human's selection IS the
//                  governance approval, so the verified claim mints as a rule through the SAME
//                  primitive `enrich accept` mints through. No second approval, no second authority.
//   doc_stale      the commit was right and the document is out of date. Nothing mints; the finding
//                  closes as resolved. Superseding the document itself needs a direct validated
//                  claim id, which a finding does not carry, so this records the verdict and stops.
//   carve_out      both were right and this change was a deliberate exception. Nothing mints, and
//                  the outcome is recorded EXPLICITLY rather than left looking untouched.
export const FINDING_RESOLUTIONS = ["code_diverged", "doc_stale", "carve_out"] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

export function isFindingResolution(value: unknown): value is FindingResolution {
  return typeof value === "string" && (FINDING_RESOLUTIONS as readonly string[]).includes(value);
}

// The recorded outcome of resolving one finding. It carries the verdict and nothing derived:
// the quote, the commit, and the proposed kind already live on the finding it is stamped onto.
export interface FindingResolutionRecord {
  outcome: FindingResolution;
  resolvedAt: string; // ISO 8601
  // The rule kind that actually reached the authority. Present iff outcome is `code_diverged` AND
  // the mint ran, so its absence on a code_diverged record means the mint was skipped (--dry-run)
  // rather than that the resolution was something else.
  mintedRuleKind?: ProposedRuleKind;
}

export interface EnrichmentCandidate {
  kind: EnrichmentKind;
  statement: string;
  evidence: EnrichmentEvidence[];
  sourceScout: ScoutName;
  // Optional provenance-tagged rationale (memo Phase 1). `null` means "no rationale", which
  // is STRICTLY preferred over a fabricated one. When `rationale` is a non-empty string,
  // `rationaleSource` MUST declare whether it is the user's own words (USER_EXPLICIT) or an
  // agent's paraphrase (AGENT_SUMMARY); when `rationale` is null, `rationaleSource` is null.
  // validateCandidateShape enforces that pairing so the two can never drift apart.
  rationale?: string | null;
  rationaleSource?: RationaleSource | null;
  // Required iff kind === RECONCILIATION_FINDING_KIND, forbidden otherwise (both directions
  // enforced by validateCandidateShape). Optional in the TYPE because the five governance kinds
  // never carry one; it is not optional in the protocol.
  inconsistency?: DocCodeInconsistency;
}

// The persistence-layer view of a candidate after exact cross-scout merge (verdict item 9).
// The WIRE candidate a scout emits keeps a singular `sourceScout`; ingest merges every
// candidate sharing a `dedupKey` (kind + normalized statement, anchor-INsensitive) WITHIN a
// single ingest call into one of these: evidence is unioned (so a claim the documentation and
// history scouts each found carries the file AND the commit anchor) and `sourceScouts` records every scout that
// produced it. Merge never spans ingest calls, so a resuming scout never re-touches an
// already-persisted claim. The id helpers below operate on this shape too (they read only
// kind/statement/evidence), so the merged candidate's path is derived from its unioned
// anchors and stays idempotent on re-ingest.
export interface MergedCandidate {
  kind: EnrichmentKind;
  statement: string;
  evidence: EnrichmentEvidence[];
  sourceScouts: ScoutName[]; // union of producing scouts, deduped + slot-ordered
  rationale?: string | null;
  rationaleSource?: RationaleSource | null;
  // Survives the merge because it IS the finding: a doc_code_inconsistency stripped of its
  // payload is a sentence with nothing to check. Merge only ever unions candidates that already
  // share a dedupKey, and for a finding that key is derived from the verified quote, so the
  // payload carried through is the same payload on both sides.
  inconsistency?: DocCodeInconsistency;
}

// The minimal shape the identity helpers need. Both EnrichmentCandidate (wire) and
// MergedCandidate (persistence) satisfy it structurally, so candidateId/anchors/relPath work
// on either without a cast.
export type CandidateIdentityInput = Pick<
  EnrichmentCandidate,
  "kind" | "statement" | "evidence" | "inconsistency"
>;

// --- Plan record + envelopes (§5b) -----------------------------------------------

export interface EnrichmentLimits {
  maxDocumentTargets: number;
  maxHistoryScanCommits: number; // git-log pool walked (>= selected)
  maxHistorySelectedCommits: number; // commits actually inlined as the allowlist
  maxPreparedInputBytes: number;
  // The DERIVED sum of the per-role caps, recorded for display and audit. It is NOT a second
  // limit: nothing enforces it, because the per-role caps already bound the run by
  // construction. A separate run-total that could be set lower would have to be drained in
  // some order across scouts, and draining a shared pool in array order is precisely the bug
  // this design removed (see SCOUT_CANDIDATE_CAPS).
  maxCandidatesTotal: number;
  budgetMs: number;
}

export interface DocumentationTarget {
  path: string; // repo-relative
  tier: "T1" | "T2" | "T4"; // T3 is grounding-only, never a scout target
  rank: number; // 1-based priority
}

export interface PreparedGitFileChange {
  path: string;
  status: string; // git porcelain status letter(s): A, M, D, R100, C75, ...
  renamedFrom?: string; // present when status begins with R or C
}
export interface PreparedGitEvidence {
  commit: string; // full 40-char SHA; the allowlist entry
  timestamp: string; // committer ISO 8601
  subject: string;
  body: string; // bounded
  changedFiles: PreparedGitFileChange[];
  diffExcerpt?: string; // optional, bounded
}

export interface OnboardingRun {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  workspaceId: string;
  repositoryRoot: string;
  createdAt: string;
  deadlineAt: string;
  planDigest: string;
  limits: EnrichmentLimits;
  documentationTargets: DocumentationTarget[];
  historyEvidence: PreparedGitEvidence[]; // the commit allowlist + prepared context
  // Git-native snapshot identity for the WORKSPACE-grain idempotency gate. headCommit
  // (`git rev-parse HEAD`) is identical across every clone of the same content, so it,
  // not planDigest (which embeds the absolute repositoryRoot), is the cross-machine key
  // the intel marker is keyed on. rootCommit (oldest root) is repo identity, telemetry
  // only. Both null when git is unavailable (gate then degrades to the local record).
  // Optional so a run record written before this field existed still parses.
  headCommit?: string | null;
  rootCommit?: string | null;
}

export interface ScoutResult {
  scout: ScoutName;
  status: ScoutStatus;
  candidates: unknown[]; // untrusted; ingest validates each independently
  truncated?: boolean;
  error?: string;
}

export interface EnrichmentIngestRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  results: ScoutResult[];
}

// --- Per-scout state + outcomes (§6, §6b) ----------------------------------------

export type ScoutRunStatus =
  | "not_started"
  | "complete"
  | "failed"
  | "timed_out"
  | "malformed"
  | "persistence_failed";

export interface ScoutRunState {
  status: ScoutRunStatus;
  candidateCount?: number;
  error?: string;
}

// Completion state is per-RUN, not per-workspace: it is resume data for one onboarding
// run (which scouts of THIS run already landed). A workspace can bind more than one repo
// (Meetless monorepo + intel share one), and each repo onboards under its own run, so a
// workspace-singleton state would let the first repo's "complete" silently skip every
// later repo's scouts. Keyed by runId; `repositoryRoot` is carried for human audit.
export interface OnboardingState {
  workspaceId: string;
  runId: string;
  repositoryRoot: string;
  // v2 (2026-07-14): v1 wrote `complete` for a scout that offered candidates and landed NONE
  // of them (every candidate rejected), which resume then skipped forever with
  // `already_complete` — the corrected candidates could never be re-ingested and the run was
  // stranded with no recovery path. v2 stamps that scout `malformed` instead. The versions
  // disagree about what `complete` MEANS, so a v1 file is not upgradable in place: loadState
  // reads it as null, the run re-plans, and every scout re-runs. That is the recovery. The
  // re-POST is harmless because kb/add is an idempotent upsert (a doc that already landed
  // comes back `noop_unchanged`), so the only cost of discarding v1 state is one redundant
  // scout pass on a run that had genuinely finished.
  schemaVersion: 2;
  status: "complete" | "partial";
  updatedAt: string;
  // A total Record, not a hand-listed pair: adding a role must not require remembering this
  // line. No schema bump is needed to add one, because a v2 file written before the role
  // existed simply lacks that key and the reader treats a missing key as "never ran" (see
  // scoutState in ingest). The role then runs on the next ingest, which is the correct
  // resume: it has genuinely produced nothing.
  scouts: Record<ScoutName, ScoutRunState>;
}

// --- Candidates sidecar (the accept half's durable record) -----------------------

// The landed KB outcome for a candidate this run persisted, mirroring ingest's PersistOutcome
// ("ingested" minted a revision, "noop_unchanged" deduped against the governed head, "failed"
// the server could not persist). Recorded so `enrich accept` can report it and the operator
// can cross-reference the console; it does NOT gate local materialization (the managed rule
// file is independent of KB persistence).
export type OnboardingCandidateLanded = "ingested" | "noop_unchanged" | "failed";

// One merged candidate this onboarding run produced, captured AFTER ingest merged + validated
// it. This is the exact, post-merge shape `enrich accept` reads to materialize the durable ones
// into .meetless/rules.md, so it carries everything materializeRules needs (kind, statement,
// evidence) plus display/audit context (which scouts surfaced it, where it landed in the KB).
// kind/statement/evidence satisfy CandidateIdentityInput and EnrichmentCandidate's rule-bearing
// fields, so a record reconstructs a materializable candidate without re-parsing markdown.
export interface OnboardingCandidateRecord {
  candidateId: string; // the sha256 identity (protocol.candidateId); selection + dedup key
  kind: EnrichmentKind;
  statement: string;
  evidence: EnrichmentEvidence[];
  sourceScouts: ScoutName[]; // which scouts surfaced it (display/provenance)
  rationale: string | null;
  rationaleSource: RationaleSource | null;
  relPath: string; // the governed KB doc path it persisted to (onboarding/<id>-<slug>.md)
  landed: OnboardingCandidateLanded;
  // Present iff kind === RECONCILIATION_FINDING_KIND. Persisted because the resolution step
  // runs LATER, in another session, against this sidecar: without the verified quote, the
  // claim class, and the exact divergence, the three-way choice has nothing to offer.
  inconsistency?: DocCodeInconsistency;
  // Stamped by `mla enrich resolve` when a human closes the finding. Absent means OPEN, which is
  // why the review lists on absence rather than on a boolean nobody remembers to set.
  resolution?: FindingResolutionRecord;
}

// Project a resolved finding into the rule candidate `code_diverged` mints.
//
// This function IS the "no second authority path" rule (§5.9). The finding gets no mint of its own,
// no hash of its own, and no bundle write of its own. It becomes an ORDINARY candidate whose kind is
// the proposed rule kind and whose statement is the CLI-VERIFIED quote, and then rides
// materializeRules -> mintAndDeliverRules exactly like an accepted rule from any other scout;
// isDurableRuleKind gates it on the far side, unchanged.
//
// The statement is `claimText` and never the candidate's `statement`: the latter is generated prose
// ABOUT the disagreement ("CLAUDE.md forbids editing this file, and commit abc did"), which is a
// finding, not a rule. The document's own sentence is the rule, and it is the half the CLI proved.
//
// `rationale` is dropped rather than carried: the record's rationale explains why the VIOLATION is
// a finding, and attaching that to the minted rule would file a rule under the reasoning of the
// thing that broke it. Provenance survives in the evidence (the doc anchor plus the commit anchor).
//
// Returns null for anything that is not a verified finding, so no caller can mint from a record
// that never carried one.
export function findingToRuleCandidate(record: {
  kind: EnrichmentKind;
  evidence: EnrichmentEvidence[];
  sourceScouts?: readonly ScoutName[];
  inconsistency?: DocCodeInconsistency;
}): EnrichmentCandidate | null {
  if (record.kind !== RECONCILIATION_FINDING_KIND) return null;
  const inconsistency = record.inconsistency;
  if (!inconsistency) return null;
  return {
    kind: inconsistency.proposedRuleKind,
    statement: inconsistency.claimText,
    evidence: record.evidence,
    sourceScout: record.sourceScouts?.[0] ?? "reconciliation",
    rationale: null,
    rationaleSource: null,
  };
}

// The per-run sidecar `enrich ingest` writes beside the run record + resume state, so the
// candidates a run produced survive the session for `enrich accept` to materialize later.
// Accumulated across ingest calls (a resuming scout's candidates are appended, deduped by
// candidateId), keyed by runId so two repos sharing a workspace never collide.
export interface OnboardingCandidatesSidecar {
  schemaVersion: 1;
  workspaceId: string;
  runId: string;
  repositoryRoot: string;
  updatedAt: string;
  candidates: OnboardingCandidateRecord[];
}

export interface CandidateValidationError {
  index: number; // position in the scout's candidates[] (0-based; render it 1-based)
  code: string; // machine code, e.g. "unknown_field", "bad_kind"
  message: string;
  field?: string;
  // A short, whitespace-collapsed excerpt of the statement this error rejected. A rejected
  // candidate is DROPPED, and by the time the operator reads the summary the scout is gone and
  // the results file was a temp file: a bare code plus an index into that vanished array names
  // nothing they can act on. The excerpt is what makes a dropped claim recoverable by hand.
  // Stamped by ingest (which holds the raw candidate), not by the pure shape validator.
  excerpt?: string;
}

export interface ScoutIngestOutcome {
  scout: ScoutName;
  received: number;
  accepted: number;
  rejected: number;
  persisted: number; // documents that landed born PENDING (newly minted + already-present)
  deduped: number; // of `persisted`, how many were already governed (server noop_unchanged)
  errors: CandidateValidationError[];
}

// --- Identity + digest -----------------------------------------------------------

// Nothing semantic: no stemming, no punctuation removal, no LLM canonicalization (§6).
export function normalizeStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// Normalize an exact source quote, for BOTH the substring check that verifies a claim against
// the file and the identity that dedups it. Line endings and whitespace ONLY: never case, never
// punctuation, never stemming, never semantics.
//
// The two uses are why the rule is that strict. This runs on both sides of the verification
// comparison, so any normalization that loses information here is a normalization that lets an
// unverified claim through: lowercasing would let "NEVER" match "never", stripping punctuation
// would let "must not" match "must, not". Whitespace is safe because CRLF, a re-wrapped
// paragraph, and a re-indented list are the same sentence in a Markdown document.
export function normalizeExactSourceClaim(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ");
}

// The text a candidate's identity is built from.
//
// For the five governance kinds that is the statement (the claim itself). For a
// doc_code_inconsistency it is the CLI-VERIFIED quote, because the statement is GENERATED
// PROSE: the same document line and the same commit, described in different words on a re-run,
// is the same finding, and hashing the prose mints a fresh copy of it every time.
function candidateIdentityText(
  candidate: Pick<EnrichmentCandidate, "kind" | "statement" | "inconsistency">,
): string {
  if (candidate.kind === RECONCILIATION_FINDING_KIND && candidate.inconsistency) {
    return normalizeExactSourceClaim(candidate.inconsistency.claimText);
  }
  return normalizeStatement(candidate.statement);
}

// The anchors that define a candidate's identity: file paths (from file evidence) and
// commit SHAs (from commit evidence). Line numbers are EXCLUDED so identity survives
// line drift (§6). Anchors are type-tagged ("f:"/"c:") to prevent a path that happens
// to equal a SHA string from colliding across the two evidence kinds, then deduped and
// sorted for a stable hash. A commit's optional historical `path` is supplementary
// context, not identity (the SHA is the anchor).
export function candidateAnchors(candidate: CandidateIdentityInput): string[] {
  const anchors = new Set<string>();
  for (const ev of candidate.evidence) {
    if (ev.type === "file") {
      anchors.add(`f:${ev.path}`);
    } else {
      anchors.add(`c:${ev.commit.toLowerCase()}`);
    }
  }
  return [...anchors].sort();
}

// candidateId = sha256( protocolVersion + kind + normalizeStatement(statement) + sortedAnchors )
// Identical content reuses the same id (idempotent re-ingest); changed content gets a
// different id. The server's per-revision PENDING default is the real authority backstop;
// this hash is only for dedup stability (§6).
// The prose-free identity of a doc_code_inconsistency: document, verified quote, commit, and
// the exact change that contradicts it.
//
// Three things are deliberately absent. `headCommit`, so an unrelated commit landing between
// two runs does not mint a second copy of an unchanged finding. The generated statement, for
// the reason candidateIdentityText gives. Line numbers, so the same claim survives an inserted
// paragraph pushing it down the document (the same reason candidateAnchors drops them).
function findingIdentityParts(candidate: CandidateIdentityInput): string[] {
  const inc = candidate.inconsistency;
  const doc = candidate.evidence.find((e): e is FileEvidence => e.type === "file");
  const commit = candidate.evidence.find((e): e is CommitEvidence => e.type === "commit");
  return [
    doc?.path ?? "",
    normalizeExactSourceClaim(inc?.claimText ?? ""),
    commit?.commit.toLowerCase() ?? "",
    inc?.divergence.path ?? "",
    inc?.divergence.status ?? "",
    inc?.divergence.renamedFrom ?? "",
  ];
}

export function candidateId(candidate: CandidateIdentityInput): string {
  const parts =
    candidate.kind === RECONCILIATION_FINDING_KIND && candidate.inconsistency
      ? [String(PROTOCOL_VERSION), candidate.kind, ...findingIdentityParts(candidate)]
      : [
          String(PROTOCOL_VERSION),
          candidate.kind,
          normalizeStatement(candidate.statement),
          candidateAnchors(candidate).join("\n"),
        ];
  // Join with "\n" (not " "): normalizeStatement collapses all whitespace to single
  // spaces so a statement can never contain a newline, which makes "\n" an unambiguous
  // tuple delimiter. A space would be ambiguous (statements contain spaces); a NUL byte
  // would make this file read as binary to grep/diff. Keep it "\n".
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// Human-friendly suffix for the persisted path; identity lives in the hash, the slug is
// cosmetic. Path: onboarding/<candidateId>-<slug>.md (§6).
export function candidateSlug(statement: string, maxLen = 40): string {
  const slug = normalizeStatement(statement)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "candidate";
}

// The slug is cosmetic, but the PATH is not: it is the KB document identity, so a stable hash
// under a drifting slug still writes two documents for one finding. Both halves therefore
// derive from candidateIdentityText, which for a finding is the verified quote and not the
// re-generated prose. For the five governance kinds the identity text IS the normalized
// statement, so this path is byte-identical to what it has always produced.
export function candidateRelPath(candidate: CandidateIdentityInput): string {
  return `onboarding/${candidateId(candidate)}-${candidateSlug(candidateIdentityText(candidate))}.md`;
}

// The exact-duplicate merge key (verdict item 9): kind + normalized statement, deliberately
// anchor-INsensitive. Two candidates with the same key state the same governed claim and are
// merged into one MergedCandidate (their anchors unioned) even when they came from different
// scouts with different evidence (a file anchor vs a commit anchor). Coarser than candidateId,
// which also folds in the sorted anchors. Joined with "\n" for the same reason candidateId is:
// normalizeStatement guarantees the statement holds no newline, so "\n" is an unambiguous
// delimiter between the kind and the statement.
export function dedupKey(candidate: CandidateIdentityInput): string {
  // A finding is the one kind that must NOT merge on its claim alone. The same document rule
  // contradicted by two different commits is two findings with two different resolutions, and
  // an anchor-insensitive merge would union both commits onto a single payload whose
  // `divergence` describes only one of them. So a finding merges on its full identity: verified
  // quote AND commit AND the exact change. Two scouts reporting the identical finding still
  // collapse; two commits violating the identical rule stay two.
  if (candidate.kind === RECONCILIATION_FINDING_KIND && candidate.inconsistency) {
    return [candidate.kind, ...findingIdentityParts(candidate)].join("\n");
  }
  return `${candidate.kind}\n${normalizeStatement(candidate.statement)}`;
}

// Deterministic JSON: recursively sort object keys so the digest is stable regardless of
// property insertion order. Arrays keep their order (it is meaningful here: ranks, etc.).
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

// Digest over the integrity-bearing plan content: everything that defines the plan's
// commitments. Excludes runId (the lookup key), createdAt/deadlineAt (volatile
// orchestration), and planDigest itself. ingest recomputes this and rejects on mismatch,
// catching on-disk corruption of the stored record (§5b step 4).
export function computePlanDigest(
  run: Pick<
    OnboardingRun,
    "protocolVersion" | "workspaceId" | "repositoryRoot" | "limits" | "documentationTargets" | "historyEvidence"
  >,
): string {
  const canonical = stableStringify({
    protocolVersion: run.protocolVersion,
    workspaceId: run.workspaceId,
    repositoryRoot: run.repositoryRoot,
    limits: run.limits,
    documentationTargets: run.documentationTargets,
    historyEvidence: run.historyEvidence,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function defaultLimits(budgetMs: number = DEFAULT_BUDGET_MS): EnrichmentLimits {
  return {
    maxDocumentTargets: MAX_DOCUMENT_TARGETS,
    maxHistoryScanCommits: MAX_HISTORY_SCAN_COMMITS,
    maxHistorySelectedCommits: MAX_HISTORY_SELECTED_COMMITS,
    maxPreparedInputBytes: MAX_PREPARED_INPUT_BYTES,
    maxCandidatesTotal: MAX_CANDIDATES_TOTAL,
    // There is deliberately no `maxCandidatesPerScout` scalar. Per-role caps differ
    // (SCOUT_CANDIDATE_CAPS), so no single number describes them, and a scalar nothing
    // enforces is worse than absent: a test (or an operator) can set it, watch it change
    // nothing, and conclude the cap is honored. Allocation and the "aim for N" brief
    // sentence both read scoutCandidateCap(role). Removing the key does not invalidate a
    // run record already on disk: computePlanDigest hashes `limits` wholesale, so an old
    // record still hashes over the fields it actually carries.
    budgetMs,
  };
}

// --- Commit allowlist resolution (pure; membership against the stored plan) ------

export function commitAllowlist(run: Pick<OnboardingRun, "historyEvidence">): string[] {
  return run.historyEvidence.map((e) => e.commit.toLowerCase());
}

// Resolve a candidate-cited commit (possibly abbreviated) against the plan's allowlist
// of full SHAs. Returns the canonical full SHA, or null if it matches none or is
// ambiguous (a too-short prefix hitting more than one allowlisted commit). ingest uses
// this to enforce "commit must be in the plan's allowlist" (§5b step 5).
export function resolveAllowedCommit(allowlist: string[], cited: string): string | null {
  const needle = cited.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(needle) || needle.length < MIN_COMMIT_SHA_LENGTH) return null;
  const exact = allowlist.find((c) => c === needle);
  if (exact) return exact;
  const prefixed = allowlist.filter((c) => c.startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : null;
}

// --- Pure shape validators -------------------------------------------------------

const CANDIDATE_FIELDS = new Set([
  "kind",
  "statement",
  "evidence",
  "sourceScout",
  "rationale",
  "rationaleSource",
  "inconsistency",
]);
const FILE_EVIDENCE_FIELDS = new Set(["type", "path", "startLine", "endLine"]);
const COMMIT_EVIDENCE_FIELDS = new Set(["type", "commit", "path"]);
const INCONSISTENCY_FIELDS = new Set(["claimClass", "claimText", "claimScope", "proposedRuleKind", "divergence"]);
const DIVERGENCE_FIELDS = new Set(["path", "status", "renamedFrom"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Rooted = not repo-relative. Spelled out here rather than imported from node:path, because
// path.isAbsolute is PLATFORM-dependent and this module is the deterministic core: the same
// candidate JSON must validate identically on every machine that ingests it.
function isRootedPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export type CandidateShapeResult =
  | { ok: true; candidate: EnrichmentCandidate }
  | { ok: false; errors: CandidateValidationError[] };

// Validates a single untrusted candidate's SHAPE only (§5). Pure: no fs, no git. The
// caller (ingest) layers on realpath containment, exist-at-HEAD, line-range-vs-file,
// and commit-allowlist membership. Collects ALL shape errors for one candidate so the
// scout's report is actionable rather than first-error-only.
export function validateCandidateShape(raw: unknown, index: number): CandidateShapeResult {
  const errors: CandidateValidationError[] = [];
  const err = (code: string, message: string, field?: string): void => {
    errors.push({ index, code, message, field });
  };

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ index, code: "not_an_object", message: "candidate must be a JSON object" }] };
  }

  for (const key of Object.keys(raw)) {
    if (!CANDIDATE_FIELDS.has(key)) err("unknown_field", `unknown field "${key}"`, key);
  }

  const kind = raw.kind;
  if (typeof kind !== "string" || !ENRICHMENT_KINDS.includes(kind as EnrichmentKind)) {
    err("bad_kind", `kind must be one of: ${ENRICHMENT_KINDS.join(", ")}`, "kind");
  }

  const sourceScout = raw.sourceScout;
  if (!isScoutName(sourceScout)) {
    err("bad_source_scout", `sourceScout must be one of: ${SCOUT_NAMES.join(", ")}`, "sourceScout");
  }

  const statement = raw.statement;
  if (typeof statement !== "string") {
    err("bad_statement", "statement must be a string", "statement");
  } else {
    const norm = normalizeStatement(statement);
    if (norm.length < MIN_STATEMENT_LENGTH) err("empty_statement", "statement is empty", "statement");
    if (norm.length > MAX_STATEMENT_LENGTH) {
      err("statement_too_long", `statement exceeds ${MAX_STATEMENT_LENGTH} chars`, "statement");
    }
  }

  const evidence = raw.evidence;
  const validEvidence: EnrichmentEvidence[] = [];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    err("no_evidence", "evidence must be a non-empty array", "evidence");
  } else if (evidence.length > MAX_EVIDENCE_PER_CANDIDATE) {
    err("too_much_evidence", `evidence exceeds ${MAX_EVIDENCE_PER_CANDIDATE} items`, "evidence");
  } else {
    evidence.forEach((ev, i) => {
      const parsed = validateEvidenceShape(ev, index, i, err);
      if (parsed) validEvidence.push(parsed);
    });
  }

  // Anchor-type cross-check (§5), driven by REQUIRED_ANCHOR_TYPES rather than a pair of
  // role literals. Two `if`s naming two roles are not a check over ScoutName: a third role
  // matched NEITHER, so its candidates required no anchor at all and the gate silently
  // stopped applying to the one scout whose whole finding IS a pair of anchors.
  if (isScoutName(sourceScout)) {
    for (const required of REQUIRED_ANCHOR_TYPES[sourceScout]) {
      if (!validEvidence.some((e) => e.type === required)) {
        err(
          required === "file" ? "missing_file_anchor" : "missing_commit_anchor",
          `${sourceScout} candidate requires at least one ${required} anchor`,
          "evidence",
        );
      }
    }
  }

  // A finding names ONE document and ONE commit. Its identity, its quote check, its
  // change check, and its ancestry check each resolve "the" anchor of a type, so a second
  // anchor of either type would ride along unverified while the finding still read as fully
  // checked. "At least one of each" is already covered by REQUIRED_ANCHOR_TYPES above.
  if (kind === RECONCILIATION_FINDING_KIND) {
    for (const type of ["file", "commit"] as const) {
      const n = validEvidence.filter((e) => e.type === type).length;
      if (n > 1) {
        err(
          type === "file" ? "ambiguous_file_anchor" : "ambiguous_commit_anchor",
          `a ${RECONCILIATION_FINDING_KIND} candidate must name exactly one ${type === "file" ? "document" : "commit"}, not ${n}`,
          "evidence",
        );
      }
    }
  }

  // Kind-per-role cross-check (SCOUT_CANDIDATE_KINDS). Not house style: the two extraction
  // scouts hold half the evidence each and cannot anchor a doc/code disagreement, and a
  // reconciliation scout emitting a plain `constraint` would bypass every verification the
  // finding kind exists for and land as a governed rule.
  const kindIsKnown = typeof kind === "string" && ENRICHMENT_KINDS.includes(kind as EnrichmentKind);
  if (isScoutName(sourceScout) && kindIsKnown && !scoutMayEmitKind(sourceScout, kind as EnrichmentKind)) {
    err(
      "kind_not_allowed_for_scout",
      `${sourceScout} may not emit kind "${kind as string}" (allowed: ${SCOUT_CANDIDATE_KINDS[sourceScout].join(", ")})`,
      "kind",
    );
  }

  // Per-kind arity: the inconsistency payload is required by the finding kind and forbidden by
  // every other. Only shape and internal consistency are checked here (pure). Whether the quote
  // really occurs in the document, whether the change really happened in that commit, and
  // whether the document predates it are ingest's job: they need the repository.
  const inconsistency = kindIsKnown
    ? validateInconsistency(raw, kind as EnrichmentKind, err)
    : undefined;

  // Rationale provenance (memo Phase 1): rationale and rationaleSource are paired. A
  // non-empty rationale must declare a valid source. A null/absent rationale carrying an
  // orphan source is sanitized (the orphan is dropped, the candidate kept) rather than
  // rejected: the rationale block is optional and dropping a source with no rationale
  // attributes nothing. Missing rationale is always allowed.
  const rationale = validateRationale(raw, err);

  if (errors.length > 0) return { ok: false, errors };
  const candidate: EnrichmentCandidate = {
    kind: kind as EnrichmentKind,
    statement: statement as string,
    evidence: validEvidence,
    sourceScout: sourceScout as ScoutName,
    rationale: rationale.rationale,
    rationaleSource: rationale.rationaleSource,
  };
  if (inconsistency) candidate.inconsistency = inconsistency;
  return { ok: true, candidate };
}

// Validate the doc/code inconsistency payload and its arity against `kind`. Returns the
// canonicalized block, or undefined when the kind carries none (or the block was rejected).
// Pure: every check here is a check the CLI can make without touching the repository.
function validateInconsistency(
  raw: Record<string, unknown>,
  kind: EnrichmentKind,
  err: (code: string, message: string, field?: string) => void,
): DocCodeInconsistency | undefined {
  const value = raw.inconsistency;
  const present = value !== undefined && value !== null;

  if (kind !== RECONCILIATION_FINDING_KIND) {
    // A governance rule carrying a divergence payload is a category error, and a loud one: it
    // means something built a finding and mislabeled it as policy. Reject rather than strip,
    // because stripping would persist the rule and lose the finding silently.
    if (present) {
      err("unexpected_inconsistency", `inconsistency is only valid on a ${RECONCILIATION_FINDING_KIND} candidate`, "inconsistency");
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    err("missing_inconsistency", `a ${RECONCILIATION_FINDING_KIND} candidate requires an inconsistency object`, "inconsistency");
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!INCONSISTENCY_FIELDS.has(key)) err("unknown_field", `unknown field "${key}" on inconsistency`, `inconsistency.${key}`);
  }

  const claimClass = value.claimClass;
  const claimClassOk = typeof claimClass === "string" && DOC_CLAIM_CLASSES.includes(claimClass as DocClaimClass);
  if (!claimClassOk) {
    err("bad_claim_class", `claimClass must be one of: ${DOC_CLAIM_CLASSES.join(", ")}`, "inconsistency.claimClass");
  }

  const rawClaimText = value.claimText;
  let claimText = "";
  if (typeof rawClaimText !== "string") {
    err("bad_claim_text", "claimText must be a string quoted from the document", "inconsistency.claimText");
  } else {
    claimText = normalizeExactSourceClaim(rawClaimText);
    if (claimText.length < 1) err("empty_claim_text", "claimText is empty", "inconsistency.claimText");
    if (claimText.length > MAX_CLAIM_TEXT_LENGTH) {
      err("claim_text_too_long", `claimText exceeds ${MAX_CLAIM_TEXT_LENGTH} chars`, "inconsistency.claimText");
    }
  }

  const rawScope = value.claimScope;
  let claimScope = "";
  if (typeof rawScope !== "string") {
    err("bad_claim_scope", "claimScope must be a repo-relative path or a directory prefix", "inconsistency.claimScope");
  } else {
    claimScope = rawScope.trim();
    if (claimScope.length < 1) {
      err("empty_claim_scope", "claimScope is empty; a claim that governs nothing proves nothing", "inconsistency.claimScope");
    } else if (claimScope.length > MAX_CLAIM_SCOPE_LENGTH) {
      err("claim_scope_too_long", `claimScope exceeds ${MAX_CLAIM_SCOPE_LENGTH} chars`, "inconsistency.claimScope");
    } else if (isRootedPath(claimScope) || claimScope.split(/[\\/]/).includes("..")) {
      // A scope is matched against repo-relative change paths, so an absolute or climbing
      // scope can never legitimately match one; accepting it only invites a scope that reads
      // as broader than the repository it is checked against.
      err("bad_claim_scope", "claimScope must be repo-relative and must not contain '..'", "inconsistency.claimScope");
    } else if (claimScope === "/" || claimScope === "." || claimScope === "./") {
      err("bad_claim_scope", "claimScope must name a path or directory, not the whole repository", "inconsistency.claimScope");
    }
  }

  const proposed = value.proposedRuleKind;
  const proposedOk =
    typeof proposed === "string" && (MINTABLE_ENRICHMENT_KINDS as readonly string[]).includes(proposed);
  if (!proposedOk) {
    err(
      "bad_proposed_rule_kind",
      `proposedRuleKind must be one of: ${MINTABLE_ENRICHMENT_KINDS.join(", ")}`,
      "inconsistency.proposedRuleKind",
    );
  }

  const divergence = validateDivergence(value.divergence, err);

  // Cross-field checks. Both are pure, and both reject findings that are internally
  // unfalsifiable no matter what the repository says.
  if (claimClassOk && divergence) {
    const cls = claimClass as DocClaimClass;
    if (!statusProvesClaimViolation(cls, divergence.status)) {
      err(
        "claim_not_proven_by_status",
        `status "${divergence.status}" does not prove a ${cls} claim was violated`,
        "inconsistency.divergence.status",
      );
    }
    const governed = governedChangePath(cls, divergence);
    if (governed === null) {
      err("missing_renamed_from", "a never_rename claim requires divergence.renamedFrom", "inconsistency.divergence.renamedFrom");
    } else if (claimScope.length > 0 && !claimScopeCovers(claimScope, governed)) {
      err(
        "divergence_outside_claim_scope",
        `changed path "${governed}" is outside claimScope "${claimScope}"`,
        "inconsistency.divergence.path",
      );
    }
  }

  if (!claimClassOk || !proposedOk || !divergence || claimText.length < 1 || claimScope.length < 1) {
    return undefined;
  }
  return {
    claimClass: claimClass as DocClaimClass,
    claimText,
    claimScope,
    proposedRuleKind: proposed as ProposedRuleKind,
    divergence,
  };
}

// The claimed changed file. Validated as SHAPE only; ingest proves it against the plan's
// prepared evidence for the validated commit, field for field.
function validateDivergence(
  raw: unknown,
  err: (code: string, message: string, field?: string) => void,
): DivergenceFileChange | null {
  const field = "inconsistency.divergence";
  if (!isPlainObject(raw)) {
    err("bad_divergence", "divergence must be an object naming the changed file", field);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!DIVERGENCE_FIELDS.has(key)) err("unknown_field", `unknown field "${key}" on divergence`, `${field}.${key}`);
  }
  const path = raw.path;
  const status = raw.status;
  const renamedFrom = raw.renamedFrom;
  let ok = true;
  if (typeof path !== "string" || path.trim().length === 0) {
    err("bad_path", "divergence requires a non-empty path", `${field}.path`);
    ok = false;
  }
  // The status is compared byte-for-byte against the plan's recorded letter (`R100`, not `R`),
  // so it is kept exactly as sent; only its SHAPE is checked here.
  if (typeof status !== "string" || !/^[A-Z][0-9]*$/.test(status.trim())) {
    err("bad_status", "divergence status must be a git porcelain status such as M, A, D, R100", `${field}.status`);
    ok = false;
  }
  if (renamedFrom !== undefined && (typeof renamedFrom !== "string" || renamedFrom.trim().length === 0)) {
    err("bad_renamed_from", "divergence renamedFrom must be a non-empty string when present", `${field}.renamedFrom`);
    ok = false;
  }
  if (!ok) return null;
  const out: DivergenceFileChange = { path: path as string, status: (status as string).trim() };
  if (typeof renamedFrom === "string") out.renamedFrom = renamedFrom;
  return out;
}

// Validate the rationale/rationaleSource pair on a raw candidate, pushing errors via `err`.
// Returns the canonicalized pair: a non-empty rationale carries its declared source; an
// absent/null rationale canonicalizes to { rationale: null, rationaleSource: null } so the
// two never drift. Whitespace-only rationale is rejected (omit the field or send null
// instead of an empty "why").
function validateRationale(
  raw: Record<string, unknown>,
  err: (code: string, message: string, field?: string) => void,
): { rationale: string | null; rationaleSource: RationaleSource | null } {
  const rawRationale = raw.rationale;
  const rawSource = raw.rationaleSource;

  const hasRationale = rawRationale !== undefined && rawRationale !== null;
  const hasSource = rawSource !== undefined && rawSource !== null;

  if (!hasRationale) {
    // No rationale: a source would be an orphan claiming provenance for nothing.
    // The rationale block is optional, advisory metadata; the candidate's real value
    // lives in its kind, statement, and evidence anchor. So we DROP the orphan source
    // (canonicalize to a null pair) rather than reject an otherwise-valid candidate.
    // This is lossless: with no rationale text there is nothing to attribute, so a
    // dropped source mislabels nothing. Contrast `missing_rationale_source` below,
    // where a real rationale is present and guessing its provenance could mislabel
    // user words as an agent paraphrase, so that case stays a hard reject.
    return { rationale: null, rationaleSource: null };
  }

  if (typeof rawRationale !== "string") {
    err("bad_rationale", "rationale must be a string or null", "rationale");
    return { rationale: null, rationaleSource: null };
  }
  const trimmed = rawRationale.trim();
  if (trimmed.length < 1) {
    err("empty_rationale", "rationale is empty; omit it or send null instead", "rationale");
  } else if (trimmed.length > MAX_RATIONALE_LENGTH) {
    err("rationale_too_long", `rationale exceeds ${MAX_RATIONALE_LENGTH} chars`, "rationale");
  }

  if (!hasSource) {
    err("missing_rationale_source", `rationale requires rationaleSource (one of: ${RATIONALE_SOURCES.join(", ")})`, "rationaleSource");
  } else if (typeof rawSource !== "string" || !RATIONALE_SOURCES.includes(rawSource as RationaleSource)) {
    err("bad_rationale_source", `rationaleSource must be one of: ${RATIONALE_SOURCES.join(", ")}`, "rationaleSource");
  }

  return {
    rationale: trimmed.length >= 1 ? trimmed : null,
    rationaleSource: hasSource && RATIONALE_SOURCES.includes(rawSource as RationaleSource)
      ? (rawSource as RationaleSource)
      : null,
  };
}

function validateEvidenceShape(
  raw: unknown,
  candidateIndex: number,
  evidenceIndex: number,
  err: (code: string, message: string, field?: string) => void,
): EnrichmentEvidence | null {
  const field = `evidence[${evidenceIndex}]`;
  if (!isPlainObject(raw)) {
    err("bad_evidence", "evidence item must be an object", field);
    return null;
  }
  const type = raw.type;
  if (type === "file") {
    for (const key of Object.keys(raw)) {
      if (!FILE_EVIDENCE_FIELDS.has(key)) err("unknown_field", `unknown field "${key}" on file evidence`, `${field}.${key}`);
    }
    const path = raw.path;
    const startLine = raw.startLine;
    const endLine = raw.endLine;
    let ok = true;
    if (typeof path !== "string" || path.trim().length === 0) {
      err("bad_path", "file evidence requires a non-empty path", `${field}.path`);
      ok = false;
    }
    if (!isPositiveInt(startLine)) {
      err("bad_line", "startLine must be an integer >= 1", `${field}.startLine`);
      ok = false;
    }
    if (!isPositiveInt(endLine)) {
      err("bad_line", "endLine must be an integer >= 1", `${field}.endLine`);
      ok = false;
    }
    if (isPositiveInt(startLine) && isPositiveInt(endLine) && endLine < startLine) {
      err("bad_range", "endLine must be >= startLine", `${field}.endLine`);
      ok = false;
    }
    if (!ok) return null;
    return { type: "file", path: path as string, startLine: startLine as number, endLine: endLine as number };
  }
  if (type === "commit") {
    for (const key of Object.keys(raw)) {
      if (!COMMIT_EVIDENCE_FIELDS.has(key)) err("unknown_field", `unknown field "${key}" on commit evidence`, `${field}.${key}`);
    }
    const commit = raw.commit;
    const path = raw.path;
    let ok = true;
    if (typeof commit !== "string" || !/^[0-9a-f]+$/i.test(commit) || commit.length < MIN_COMMIT_SHA_LENGTH || commit.length > 40) {
      err("bad_commit", `commit must be a hex SHA of ${MIN_COMMIT_SHA_LENGTH}-40 chars`, `${field}.commit`);
      ok = false;
    }
    if (path !== undefined && (typeof path !== "string" || path.trim().length === 0)) {
      err("bad_path", "commit evidence path must be a non-empty string when present", `${field}.path`);
      ok = false;
    }
    if (!ok) return null;
    const out: CommitEvidence = { type: "commit", commit: (commit as string).toLowerCase() };
    if (typeof path === "string") out.path = path;
    return out;
  }
  err("bad_evidence_type", 'evidence type must be "file" or "commit"', `${field}.type`);
  return null;
}

export type ScoutResultShapeResult =
  | { ok: true; result: ScoutResult }
  | { ok: false; error: string };

// Validates the OUTER scout envelope shape (§6b). candidates[] content is intentionally
// left as unknown[] here; each candidate is validated independently downstream so one bad
// candidate never discards the rest from the same scout.
export function validateScoutResultShape(raw: unknown): ScoutResultShapeResult {
  if (!isPlainObject(raw)) return { ok: false, error: "scout result must be an object" };
  const scout = raw.scout;
  if (typeof scout !== "string" || !SCOUT_NAMES.includes(scout as ScoutName)) {
    return { ok: false, error: `scout must be one of: ${SCOUT_NAMES.join(", ")}` };
  }
  const status = raw.status;
  if (typeof status !== "string" || !SCOUT_STATUSES.includes(status as ScoutStatus)) {
    return { ok: false, error: `status must be one of: ${SCOUT_STATUSES.join(", ")}` };
  }
  if (!Array.isArray(raw.candidates)) {
    return { ok: false, error: "candidates must be an array" };
  }
  if (raw.truncated !== undefined && typeof raw.truncated !== "boolean") {
    return { ok: false, error: "truncated must be a boolean when present" };
  }
  if (raw.error !== undefined && typeof raw.error !== "string") {
    return { ok: false, error: "error must be a string when present" };
  }
  const result: ScoutResult = {
    scout: scout as ScoutName,
    status: status as ScoutStatus,
    candidates: raw.candidates as unknown[],
  };
  if (typeof raw.truncated === "boolean") result.truncated = raw.truncated;
  if (typeof raw.error === "string") result.error = raw.error;
  return { ok: true, result };
}

export type IngestRequestShapeResult =
  | { ok: true; request: EnrichmentIngestRequest }
  | { ok: false; error: string };

// Validates the top-level ingest envelope (§5b). Per-scout envelope and per-candidate
// validation happen downstream.
export function validateIngestRequestShape(raw: unknown): IngestRequestShapeResult {
  if (!isPlainObject(raw)) return { ok: false, error: "ingest request must be an object" };
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, error: `protocolVersion must be ${PROTOCOL_VERSION}` };
  }
  if (typeof raw.runId !== "string" || raw.runId.trim().length === 0) {
    return { ok: false, error: "runId must be a non-empty string" };
  }
  if (!Array.isArray(raw.results)) {
    return { ok: false, error: "results must be an array" };
  }
  return {
    ok: true,
    request: {
      protocolVersion: PROTOCOL_VERSION,
      runId: raw.runId,
      results: raw.results as ScoutResult[],
    },
  };
}
