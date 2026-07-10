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
export const MAX_CANDIDATES_TOTAL = 20; // EXTRACTION ceiling, not a target; zero is valid
// Per-scout HARD cap (verdict item 8). Each scout is bounded INDEPENDENTLY: an
// under-producing scout never cedes its surplus and an over-producer is never handed the
// other's leftover (no reallocation). MAX_CANDIDATES_PER_SCOUT * SCOUT_NAMES.length must be
// >= MAX_CANDIDATES_TOTAL for the per-scout cap to be the binding limit on a fresh run; the
// total acts only as a backstop (it bites on resume when a prior scout already spent budget).
export const MAX_CANDIDATES_PER_SCOUT = 10;
export const DEFAULT_BUDGET_MS = 240_000;

// Defensive bounds NOT pinned by the plan (§5 says only "max statement length" and
// "allowed kind"); these are conservative defaults, tune freely.
export const MAX_STATEMENT_LENGTH = 500;
export const MIN_STATEMENT_LENGTH = 1; // non-empty after normalization; no semantic floor (the human governs durability)
export const MAX_EVIDENCE_PER_CANDIDATE = 12;
export const MIN_COMMIT_SHA_LENGTH = 7; // git's conventional abbreviation floor
export const MAX_RATIONALE_LENGTH = 1000; // rationale is a short "why", not an essay

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
] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];

export const SCOUT_NAMES = ["documentation", "history"] as const;
export type ScoutName = (typeof SCOUT_NAMES)[number];

export const SCOUT_STATUSES = ["complete", "failed", "timed_out"] as const;
export type ScoutStatus = (typeof SCOUT_STATUSES)[number];

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
}

// The persistence-layer view of a candidate after exact cross-scout merge (verdict item 9).
// The WIRE candidate a scout emits keeps a singular `sourceScout`; ingest merges every
// candidate sharing a `dedupKey` (kind + normalized statement, anchor-INsensitive) WITHIN a
// single ingest call into one of these: evidence is unioned (so a claim both scouts found
// carries both the file and the commit anchor) and `sourceScouts` records every scout that
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
}

// The minimal shape the identity helpers need. Both EnrichmentCandidate (wire) and
// MergedCandidate (persistence) satisfy it structurally, so candidateId/anchors/relPath work
// on either without a cast.
export type CandidateIdentityInput = Pick<EnrichmentCandidate, "kind" | "statement" | "evidence">;

// --- Plan record + envelopes (§5b) -----------------------------------------------

export interface EnrichmentLimits {
  maxDocumentTargets: number;
  maxHistoryScanCommits: number; // git-log pool walked (>= selected)
  maxHistorySelectedCommits: number; // commits actually inlined as the allowlist
  maxPreparedInputBytes: number;
  maxCandidatesTotal: number; // run-wide backstop (sum across scouts)
  maxCandidatesPerScout: number; // independent per-scout hard cap (no reallocation)
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
  schemaVersion: 1;
  status: "complete" | "partial";
  updatedAt: string;
  scouts: { documentation: ScoutRunState; history: ScoutRunState };
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
  index: number; // position in the scout's candidates[]
  code: string; // machine code, e.g. "unknown_field", "bad_kind"
  message: string;
  field?: string;
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
export function candidateId(candidate: CandidateIdentityInput): string {
  const parts = [
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

export function candidateRelPath(candidate: CandidateIdentityInput): string {
  return `onboarding/${candidateId(candidate)}-${candidateSlug(candidate.statement)}.md`;
}

// The exact-duplicate merge key (verdict item 9): kind + normalized statement, deliberately
// anchor-INsensitive. Two candidates with the same key state the same governed claim and are
// merged into one MergedCandidate (their anchors unioned) even when they came from different
// scouts with different evidence (a file anchor vs a commit anchor). Coarser than candidateId,
// which also folds in the sorted anchors. Joined with "\n" for the same reason candidateId is:
// normalizeStatement guarantees the statement holds no newline, so "\n" is an unambiguous
// delimiter between the kind and the statement.
export function dedupKey(candidate: Pick<EnrichmentCandidate, "kind" | "statement">): string {
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
    maxCandidatesPerScout: MAX_CANDIDATES_PER_SCOUT,
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

const CANDIDATE_FIELDS = new Set(["kind", "statement", "evidence", "sourceScout", "rationale", "rationaleSource"]);
const FILE_EVIDENCE_FIELDS = new Set(["type", "path", "startLine", "endLine"]);
const COMMIT_EVIDENCE_FIELDS = new Set(["type", "commit", "path"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  if (typeof sourceScout !== "string" || !SCOUT_NAMES.includes(sourceScout as ScoutName)) {
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

  // Anchor-type cross-check (§5): documentation candidates require >= 1 file anchor;
  // history candidates require >= 1 commit anchor.
  if (sourceScout === "documentation" && !validEvidence.some((e) => e.type === "file")) {
    err("missing_file_anchor", "documentation candidate requires at least one file anchor", "evidence");
  }
  if (sourceScout === "history" && !validEvidence.some((e) => e.type === "commit")) {
    err("missing_commit_anchor", "history candidate requires at least one commit anchor", "evidence");
  }

  // Rationale provenance (memo Phase 1): rationale and rationaleSource are paired. A
  // non-empty rationale must declare a valid source. A null/absent rationale carrying an
  // orphan source is sanitized (the orphan is dropped, the candidate kept) rather than
  // rejected: the rationale block is optional and dropping a source with no rationale
  // attributes nothing. Missing rationale is always allowed.
  const rationale = validateRationale(raw, err);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    candidate: {
      kind: kind as EnrichmentKind,
      statement: statement as string,
      evidence: validEvidence,
      sourceScout: sourceScout as ScoutName,
      rationale: rationale.rationale,
      rationaleSource: rationale.rationaleSource,
    },
  };
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
