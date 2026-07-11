// The CE0 durable store: the local SQLite WAL database that backs the evidence-
// consultation forcing function's three records
// (notes/20260617-evidence-consultation-forcing-function-proposal.md Part VII,
// P0.1-P0.6). It is the single CE0 runtime authority for "did this turn's
// obligation get satisfied?", read with one local SQLite lookup off the PreToolUse
// hot path. The doc mandates SQLite (with WAL) precisely so the obligation lifecycle
// can be a transactional read/write rather than an append-log scan.
//
// SCOPE (Commit 4): the three record TABLES and their typed insert/read only. The
// LocalTurnIdentity PARENT table and its BEGIN IMMEDIATE sequence allocation are the
// next slice; deny, recovery, correction, checkpoint, and any rollout-mode column are
// held seams and are deliberately absent. The offline per-subject CoverageAuditLabel
// is a JSONL artifact (the `mla evidence` workflow), never a table here.
//
// The CLI intentionally does not depend on @meetless/utils (see kb-candidate.ts), so
// the value shapes below are vendored with field names byte-identical to the utils CE0
// types; the array fields persist as JSON text columns and round-trip across that
// boundary without a translation layer.

import * as path from "path";

import Database from "better-sqlite3";

import { HOME } from "../config";
import { betterSqlite3NativeBinding } from "./native-binding";
import { samplingBucketFor } from "./ce0-sampling-bucket";
import { INTERCEPTION_SCHEMA } from "./interception-schema";
import type {
  RequirementSubject,
  SubjectSatisfactionProof,
  ConsultationExecution,
  ConsultationResult,
  ConsultationSource,
  ConsultationAttempt,
} from "./requirement-subject";

// ---------------------------------------------------------------------------
// CE0 value shapes. The structured matching key and the consultation-side value
// types are OWNED by requirement-subject.ts, the vendored extractor + matcher, so
// every side (the prompt a required subject is lifted from, the query a consultation
// is lifted from, and the records this store persists) shares ONE definition.
// Re-exported here so the store's public surface is unchanged: callers may still
// `import { SubjectSatisfactionProof } from "./ce0-store"`.
// ---------------------------------------------------------------------------

export type {
  RequirementSubject,
  SubjectSatisfactionProof,
  ConsultationExecution,
  ConsultationResult,
  ConsultationSource,
};

/** The CE0 local store path: one SQLite file per machine under the Meetless home (the
 * obligation rows carry their own workspace_id, and every read/finalize filters by the
 * resolved workspace). It lives HERE, on the lean store module, rather than on the heavy
 * `mla evidence` command module, so the PreToolUse deny hot path can resolve the store
 * path without pulling evidence.ts's analytics/observability graph (latency lever A,
 * notes/20260615-...-consolidated-proposal.md). The `mla evidence` command re-exports it
 * for backward compatibility. */
export function defaultCe0StorePath(): string {
  return path.join(HOME, "ce0", "evidence.db");
}

export type MemoryRequirement = "REQUIRED" | "NOT_REQUIRED" | "UNKNOWN";

/** The minted turn coordinate every hook of a user turn shares (proposal req 1). It is
 * NOT the harness turn id; UserPromptSubmit mints localTurnSequence atomically and every
 * later hook (PreToolUse, the first Stop) inherits it by reading the latest assessment. */
export interface LocalTurnIdentity {
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
}

// ---------------------------------------------------------------------------
// The three durable records. Each carries the LocalTurnIdentity coordinate
// (workspaceId, sessionId, localTurnSequence) the later hooks inherit.
// ---------------------------------------------------------------------------

/** §2.3 Stage B (proposal lines 1128-1136): a local-only, content-free pointer to the exact Claude
 * transcript record the asserted answer was read from. It is NEVER emitted to analytics; the offline
 * exporter seeks to recordByteOffset, reads recordByteLength bytes, verifies recordSha256, re-applies
 * the PARENT_ASSISTANT_TEXT_V1 selector, and checks the recomputed hash against the stored
 * responseHash. The literal `kind` / `version` / `selector` pin the format so a later selector or
 * transcript shape is a distinct, recognizable variant rather than a silent reinterpretation. */
export interface ResponseSourceRefV1 {
  kind: "CLAUDE_TRANSCRIPT_JSONL";
  version: 1;
  transcriptPath: string;
  recordByteOffset: number;
  recordByteLength: number;
  recordSha256: string;
  selector: "PARENT_ASSISTANT_TEXT_V1";
}

/** One per turn: the memory-requirement classification (the P0.9 telemetry source). */
export interface TurnMemoryAssessmentRecord {
  assessmentId: string;
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
  requirement: MemoryRequirement;
  markersMatched: string[];
  exclusionsMatched: string[];
  classifierVersion: string;
  markerSetVersion: string;
  exclusionSetVersion: string;
  createdAt: number;
  /** R3 P0.9 (proposal line 280): the deterministic unflagged-recall bucket, derived from this
   * turn's natural key by `samplingBucketFor`, so the offline `ce0-export` sample is
   * reconstructible. Minted inside `allocateTurnIdentity` (it depends on the sequence minted there),
   * never carried on the draft. */
  samplingBucket: string;
  /** R4 P0.1 recall snapshot (proposal lines 287-295): the identity-only hash of the classified
   * prompt, born at classification (the prompt-submit adapter computes it) and carried on EVERY
   * assessment so the offline `ce0-export` can resolve the prompt for false-negative grading. It is
   * a content-free pointer: the raw prompt text is NEVER duplicated into this SQLite record. Because
   * promptHash is born at classification it rides on the draft, unlike `samplingBucket` and
   * `localTurnSequence`, which `allocateTurnIdentity` mints. */
  promptHash: string;
  /** R4 §2.3 asserted-answer half (proposal lines 287-296), the snapshot the prompt-side promptHash
   * pairs with. Written AFTER the insert, so all three are OPTIONAL (absent on the UserPromptSubmit
   * shape) and the Draft / prompt-submit adapter never carry them. Stage A stamps `stopObservedAt` on
   * EVERY classified turn inside the deadline transaction (no I/O). Best-effort Stage B then fills
   * `responseHash` (sha256 of the canonical asserted answer) and `responseSourceRef` (a local-only
   * pointer to the transcript record it read). When Stage B cannot label the answer they stay absent
   * forever and the offline sample is marked UNLABELABLE; this slice never overwrites a filled field. */
  stopObservedAt?: number;
  responseHash?: string;
  responseSourceRef?: ResponseSourceRefV1;
}

/** One per (turn, rule version): the obligation and its accumulating proof set. The
 * field list is the directive's contract; status and outcome are split (status is the
 * runtime lifecycle, outcome is set offline at FINALIZED), and stateVersion is the CAS
 * token a later slice advances. */
export interface TurnRuleObligationRecord {
  obligationId: string;
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
  ruleId: string;
  ruleVersionId: string;
  requiredSubjects: RequirementSubject[];
  subjectSatisfaction: SubjectSatisfactionProof[];
  status: string;
  stateVersion: number;
  deadlineClaimedAt: number | null;
  deadlineClaimedVersion: number | null;
  responseHash: string | null;
  outcome: string | null;
  canonicalPayloadHash: string;
}

/** One per governed-memory consultation observed in a turn. `result` is present only
 * on a COMPLETE consultation; `deliveredToAnsweringContext` gates eligibility. */
export interface ConsultationAttemptRecord {
  consultationId: string;
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
  source: ConsultationSource;
  consultationSubjects: RequirementSubject[];
  execution: ConsultationExecution;
  result: ConsultationResult | null;
  deliveredToAnsweringContext: boolean;
  orderingToken: number;
  createdAt: number;
}

/** Project a persisted consultation record onto the deterministic reducer's read subset. The
 * reducer (requirement-subject) treats `result` as optional and never reads `source`, so the
 * stored null becomes undefined and source is dropped. This is the SINGLE home of the
 * record -> reducer-input mapping: both the offline export (`ce0-evidence`) and the finalization
 * projector (`ce0-telemetry-project`) recompute the proof set over the same shape, so neither
 * may carry its own copy and drift. */
export function consultationRecordToReducerInput(
  rec: ConsultationAttemptRecord,
): ConsultationAttempt {
  return {
    consultationId: rec.consultationId,
    consultationSubjects: rec.consultationSubjects,
    execution: rec.execution,
    result: rec.result ?? undefined,
    deliveredToAnsweringContext: rec.deliveredToAnsweringContext,
    orderingToken: rec.orderingToken,
  };
}

export interface Ce0Store {
  readonly db: Database.Database;
}

// ---------------------------------------------------------------------------
// Schema. Exactly three tables. Array fields are JSON text; booleans are 0/1
// integers; the obligation is unique per (turn, rule version) per the doc.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_memory_assessment (
  assessment_id         TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  local_turn_sequence   INTEGER NOT NULL,
  requirement           TEXT NOT NULL,
  markers_matched       TEXT NOT NULL,
  exclusions_matched    TEXT NOT NULL,
  classifier_version    TEXT NOT NULL,
  marker_set_version    TEXT NOT NULL,
  exclusion_set_version TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  sampling_bucket       TEXT NOT NULL,
  prompt_hash           TEXT NOT NULL,
  -- §2.3 asserted-answer half of the recall snapshot, all nullable: filled by a later UPDATE
  -- (Stage A stamps stop_observed_at; best-effort Stage B fills response_hash + response_source_ref),
  -- absent at the UserPromptSubmit insert and forever when Stage B cannot label the answer.
  stop_observed_at      INTEGER,
  response_hash         TEXT,
  response_source_ref   TEXT,
  UNIQUE (workspace_id, session_id, local_turn_sequence)
);

CREATE TABLE IF NOT EXISTS turn_rule_obligation (
  obligation_id            TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL,
  session_id               TEXT NOT NULL,
  local_turn_sequence      INTEGER NOT NULL,
  rule_id                  TEXT NOT NULL,
  rule_version_id          TEXT NOT NULL,
  required_subjects        TEXT NOT NULL,
  subject_satisfaction     TEXT NOT NULL,
  status                   TEXT NOT NULL,
  state_version            INTEGER NOT NULL,
  deadline_claimed_at      INTEGER,
  deadline_claimed_version INTEGER,
  response_hash            TEXT,
  outcome                  TEXT,
  canonical_payload_hash   TEXT NOT NULL,
  UNIQUE (workspace_id, session_id, local_turn_sequence, rule_version_id),
  -- §2.3: a finalized obligation carries exactly one terminal outcome, and only a finalized
  -- one does. status = FINALIZED IFF outcome IS NOT NULL, enforced at the DB so no slice can
  -- leave a half-finalized row (FINALIZED with no outcome, or an outcome on a live status).
  CHECK ((status = 'FINALIZED') = (outcome IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS consultation_attempt (
  consultation_id                TEXT PRIMARY KEY,
  workspace_id                   TEXT NOT NULL,
  session_id                     TEXT NOT NULL,
  local_turn_sequence            INTEGER NOT NULL,
  source                         TEXT NOT NULL,
  consultation_subjects          TEXT NOT NULL,
  execution                      TEXT NOT NULL,
  result                         TEXT,
  delivered_to_answering_context INTEGER NOT NULL,
  ordering_token                 INTEGER NOT NULL,
  created_at                     INTEGER NOT NULL
);
`;

/** The schema generation this code writes. Bump this whenever SCHEMA or INTERCEPTION_SCHEMA changes
 * shape (a column added, dropped, or retyped). A store stamped with an older generation cannot be
 * written by this code, so the opener refuses it instead of silently tolerating the drift. Because
 * CE0 is an unshipped local harness ("local unshipped schema may be changed directly"), the resolution
 * is a deliberate operator rebuild of the dev store, never an in-code migration / compatibility path. */
export const CE0_SCHEMA_VERSION = 1;

/** Raised when `openCe0Store` is handed a populated store whose stamped schema generation is not the
 * one this code writes. The opener refuses it loudly (and non-destructively) rather than returning a
 * store whose writes would fail silently inside a fail-soft hook, the exact failure that let the live
 * dogfood store drop 100% of its consultation captures undetected. */
export class Ce0StoreSchemaVersionError extends Error {
  constructor(
    readonly dbPath: string,
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `CE0 store at ${dbPath} is schema version ${found}, but this mla writes version ${expected}. ` +
        `The store predates a schema change and its writes would fail silently; rebuild it ` +
        `(delete the file and let it recreate, or restore from a current build).`,
    );
    this.name = "Ce0StoreSchemaVersionError";
  }
}

/** Open (creating if needed) the CE0 store at `dbPath`, in WAL mode, with the schema
 * applied. WAL keeps the PreToolUse reader off the writer's lock; a bounded busy_timeout
 * keeps the hook from ever blocking behind a concurrent writer. The single bootstrap
 * applies both the CE0 forcing-function schema and the rules interception schema
 * (one database, one opener, no second migration framework).
 *
 * Before applying the schema, the opener reconciles the store's stamped generation: a brand-new
 * (table-less) database is created at the current version, a store already at the current version is
 * accepted, and a populated store at any OTHER version is REFUSED (it predates a schema change and the
 * CREATE TABLE IF NOT EXISTS bootstrap cannot reshape its existing tables). Refusing loudly here turns a
 * silent, fail-soft-swallowed write failure into a detectable one. */
export function openCe0Store(dbPath: string): Ce0Store {
  // In a pkg binary the native addon lives in the read-only /snapshot VFS where
  // dlopen fails; nativeBinding points better-sqlite3 at a real extracted copy.
  // Outside pkg this is undefined and resolution is unchanged. See native-binding.ts.
  const nativeBinding = betterSqlite3NativeBinding();
  const db = new Database(dbPath, nativeBinding ? { nativeBinding } : {});
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 50");

  const found = db.pragma("user_version", { simple: true }) as number;
  const tableCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number }
  ).n;
  // A populated store carries its own generation; if it is not the one we write, its tables cannot be
  // reshaped by CREATE TABLE IF NOT EXISTS and its writes would fail. A fresh (table-less) store has no
  // generation yet and is simply stamped below.
  if (tableCount > 0 && found !== CE0_SCHEMA_VERSION) {
    db.close();
    throw new Ce0StoreSchemaVersionError(dbPath, found, CE0_SCHEMA_VERSION);
  }

  db.exec(SCHEMA);
  db.exec(INTERCEPTION_SCHEMA);
  db.pragma(`user_version = ${CE0_SCHEMA_VERSION}`);
  return { db };
}

export function closeCe0Store(store: Ce0Store): void {
  store.db.close();
}

// ---------------------------------------------------------------------------
// turn_memory_assessment
// ---------------------------------------------------------------------------

export function insertTurnMemoryAssessment(
  store: Ce0Store,
  rec: TurnMemoryAssessmentRecord,
): void {
  store.db
    .prepare(
      `INSERT INTO turn_memory_assessment
        (assessment_id, workspace_id, session_id, local_turn_sequence, requirement,
         markers_matched, exclusions_matched, classifier_version, marker_set_version,
         exclusion_set_version, created_at, sampling_bucket, prompt_hash,
         stop_observed_at, response_hash, response_source_ref)
       VALUES
        (@assessment_id, @workspace_id, @session_id, @local_turn_sequence, @requirement,
         @markers_matched, @exclusions_matched, @classifier_version, @marker_set_version,
         @exclusion_set_version, @created_at, @sampling_bucket, @prompt_hash,
         @stop_observed_at, @response_hash, @response_source_ref)`,
    )
    .run({
      assessment_id: rec.assessmentId,
      workspace_id: rec.workspaceId,
      session_id: rec.sessionId,
      local_turn_sequence: rec.localTurnSequence,
      requirement: rec.requirement,
      markers_matched: JSON.stringify(rec.markersMatched),
      exclusions_matched: JSON.stringify(rec.exclusionsMatched),
      classifier_version: rec.classifierVersion,
      marker_set_version: rec.markerSetVersion,
      exclusion_set_version: rec.exclusionSetVersion,
      created_at: rec.createdAt,
      sampling_bucket: rec.samplingBucket,
      prompt_hash: rec.promptHash,
      stop_observed_at: rec.stopObservedAt ?? null,
      response_hash: rec.responseHash ?? null,
      response_source_ref: rec.responseSourceRef ? JSON.stringify(rec.responseSourceRef) : null,
    });
}

function mapAssessmentRow(row: Record<string, unknown>): TurnMemoryAssessmentRecord {
  const rec: TurnMemoryAssessmentRecord = {
    assessmentId: row.assessment_id as string,
    workspaceId: row.workspace_id as string,
    sessionId: row.session_id as string,
    localTurnSequence: row.local_turn_sequence as number,
    requirement: row.requirement as MemoryRequirement,
    markersMatched: JSON.parse(row.markers_matched as string),
    exclusionsMatched: JSON.parse(row.exclusions_matched as string),
    classifierVersion: row.classifier_version as string,
    markerSetVersion: row.marker_set_version as string,
    exclusionSetVersion: row.exclusion_set_version as string,
    createdAt: row.created_at as number,
    samplingBucket: row.sampling_bucket as string,
    promptHash: row.prompt_hash as string,
  };
  // §2.3 snapshot fields are OPTIONAL: a NULL column maps to an ABSENT key (not an `undefined` value),
  // so a never-snapshotted assessment deep-equals the UserPromptSubmit insert shape that omitted them.
  if (row.stop_observed_at != null) rec.stopObservedAt = row.stop_observed_at as number;
  if (row.response_hash != null) rec.responseHash = row.response_hash as string;
  if (row.response_source_ref != null) {
    rec.responseSourceRef = JSON.parse(row.response_source_ref as string) as ResponseSourceRefV1;
  }
  return rec;
}

export function getTurnMemoryAssessment(
  store: Ce0Store,
  assessmentId: string,
): TurnMemoryAssessmentRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM turn_memory_assessment WHERE assessment_id = ?`)
    .get(assessmentId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapAssessmentRow(row);
}

/** List every memory assessment in the workspace. The offline telemetry sweep
 * (`mla evidence ce0-emit-telemetry`) projects one memory_requirement_assessed event per
 * row (proposal §6.4: the precision/recall denominator). Unlike the obligation export,
 * EVERY assessment is a telemetry fact regardless of requirement or any deadline claim, so
 * there is no filter here. Deterministically ordered by (session, sequence, assessmentId) so
 * a re-run projects the same events in the same order. */
export function listTurnMemoryAssessments(
  store: Ce0Store,
  workspaceId: string,
): TurnMemoryAssessmentRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM turn_memory_assessment
        WHERE workspace_id = ?
        ORDER BY session_id, local_turn_sequence, assessment_id`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapAssessmentRow);
}

// ---------------------------------------------------------------------------
// LocalTurnIdentity: mint at UserPromptSubmit, reuse at later hooks (proposal req 1).
// The assessment row IS the registry; there is no separate turn-registry table.
// ---------------------------------------------------------------------------

/** A TurnMemoryAssessment whose localTurnSequence has not been minted yet. The samplingBucket is
 * likewise unset: it is derived from the natural key (which includes that minted sequence), so
 * `allocateTurnIdentity` is the only place that can compute it. */
export type TurnMemoryAssessmentDraft = Omit<
  TurnMemoryAssessmentRecord,
  "localTurnSequence" | "samplingBucket"
>;

/** Mint this turn's localTurnSequence (MAX+1 per workspace+session) and sampling bucket, then insert
 * the assessment row. This is the side-effecting CORE shared by the two turn-opening entry points:
 * `allocateTurnIdentity` wraps it in its own BEGIN IMMEDIATE, and `openTurnAtomically` runs it inside
 * the same transaction as the obligation insert. It is deliberately NOT exported: every caller must go
 * through one of those transaction boundaries so the sequence allocation stays serialized (the unique
 * (workspace, session, sequence) index is the backstop). */
function mintAndInsertAssessment(
  store: Ce0Store,
  d: TurnMemoryAssessmentDraft,
): TurnMemoryAssessmentRecord {
  const { maxSeq } = store.db
    .prepare(
      `SELECT MAX(local_turn_sequence) AS maxSeq
         FROM turn_memory_assessment
        WHERE workspace_id = ? AND session_id = ?`,
    )
    .get(d.workspaceId, d.sessionId) as { maxSeq: number | null };
  const localTurnSequence = (maxSeq ?? 0) + 1;
  const rec: TurnMemoryAssessmentRecord = {
    ...d,
    localTurnSequence,
    // The bucket binds to the same natural key as the row's UNIQUE constraint, so it must be
    // minted here, after the sequence, never on the draft (R3 P0.9; ce0-sampling-bucket.ts).
    samplingBucket: samplingBucketFor({
      workspaceId: d.workspaceId,
      sessionId: d.sessionId,
      localTurnSequence,
    }),
  };
  insertTurnMemoryAssessment(store, rec);
  return rec;
}

/** Mint this turn's LocalTurnIdentity and persist its assessment in one serialized
 * transaction: `BEGIN IMMEDIATE; nextSequence = MAX(localTurnSequence) + 1; insert`.
 * BEGIN IMMEDIATE takes the write lock up front so two UserPromptSubmit processes for
 * the same (workspace, session) cannot read the same MAX and collide; the unique
 * (workspace, session, sequence) index is the backstop. Returns the persisted record
 * carrying the minted sequence. */
export function allocateTurnIdentity(
  store: Ce0Store,
  draft: TurnMemoryAssessmentDraft,
): TurnMemoryAssessmentRecord {
  const mint = store.db.transaction((d: TurnMemoryAssessmentDraft) =>
    mintAndInsertAssessment(store, d),
  );
  return mint.immediate(draft);
}

/** Open a turn ATOMICALLY (proposal §1.3 req 1 physical resolution, R4 P0.4): in ONE BEGIN IMMEDIATE
 * transaction, mint the LocalTurnIdentity, insert the assessment, and (when the turn is REQUIRED)
 * insert its obligation. `buildObligation` runs INSIDE the transaction so the obligation it returns can
 * carry the localTurnSequence just minted; returning null is a non-REQUIRED turn whose only row is the
 * assessment. If the obligation insert throws, the assessment insert and the sequence allocation roll
 * back with it, so a REQUIRED turn is never left half-open (an assessment with no obligation to grade,
 * which would silently undercount the graded obligation set against the assessed-REQUIRED set). */
export function openTurnAtomically(
  store: Ce0Store,
  draft: TurnMemoryAssessmentDraft,
  buildObligation: (assessment: TurnMemoryAssessmentRecord) => TurnRuleObligationRecord | null,
): { assessment: TurnMemoryAssessmentRecord; obligation: TurnRuleObligationRecord | null } {
  const run = store.db.transaction((d: TurnMemoryAssessmentDraft) => {
    const assessment = mintAndInsertAssessment(store, d);
    const obligation = buildObligation(assessment);
    if (obligation) insertTurnRuleObligation(store, obligation);
    return { assessment, obligation };
  });
  return run.immediate(draft);
}

/** Resolve the LocalTurnIdentity a later hook should inherit: the highest-sequence
 * assessment for the (workspace, session), or null if the turn has none yet. */
export function resolveLatestTurnIdentity(
  store: Ce0Store,
  coord: { workspaceId: string; sessionId: string },
): LocalTurnIdentity | null {
  const row = store.db
    .prepare(
      `SELECT workspace_id, session_id, local_turn_sequence
         FROM turn_memory_assessment
        WHERE workspace_id = ? AND session_id = ?
        ORDER BY local_turn_sequence DESC
        LIMIT 1`,
    )
    .get(coord.workspaceId, coord.sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    workspaceId: row.workspace_id as string,
    sessionId: row.session_id as string,
    localTurnSequence: row.local_turn_sequence as number,
  };
}

// ---------------------------------------------------------------------------
// turn_rule_obligation
// ---------------------------------------------------------------------------

export function insertTurnRuleObligation(store: Ce0Store, rec: TurnRuleObligationRecord): void {
  store.db
    .prepare(
      `INSERT INTO turn_rule_obligation
        (obligation_id, workspace_id, session_id, local_turn_sequence, rule_id,
         rule_version_id, required_subjects, subject_satisfaction, status, state_version,
         deadline_claimed_at, deadline_claimed_version, response_hash, outcome,
         canonical_payload_hash)
       VALUES
        (@obligation_id, @workspace_id, @session_id, @local_turn_sequence, @rule_id,
         @rule_version_id, @required_subjects, @subject_satisfaction, @status, @state_version,
         @deadline_claimed_at, @deadline_claimed_version, @response_hash, @outcome,
         @canonical_payload_hash)`,
    )
    .run({
      obligation_id: rec.obligationId,
      workspace_id: rec.workspaceId,
      session_id: rec.sessionId,
      local_turn_sequence: rec.localTurnSequence,
      rule_id: rec.ruleId,
      rule_version_id: rec.ruleVersionId,
      required_subjects: JSON.stringify(rec.requiredSubjects),
      subject_satisfaction: JSON.stringify(rec.subjectSatisfaction),
      status: rec.status,
      state_version: rec.stateVersion,
      deadline_claimed_at: rec.deadlineClaimedAt,
      deadline_claimed_version: rec.deadlineClaimedVersion,
      response_hash: rec.responseHash,
      outcome: rec.outcome,
      canonical_payload_hash: rec.canonicalPayloadHash,
    });
}

function mapObligationRow(row: Record<string, unknown>): TurnRuleObligationRecord {
  return {
    obligationId: row.obligation_id as string,
    workspaceId: row.workspace_id as string,
    sessionId: row.session_id as string,
    localTurnSequence: row.local_turn_sequence as number,
    ruleId: row.rule_id as string,
    ruleVersionId: row.rule_version_id as string,
    requiredSubjects: JSON.parse(row.required_subjects as string),
    subjectSatisfaction: JSON.parse(row.subject_satisfaction as string),
    status: row.status as string,
    stateVersion: row.state_version as number,
    deadlineClaimedAt: (row.deadline_claimed_at as number | null) ?? null,
    deadlineClaimedVersion: (row.deadline_claimed_version as number | null) ?? null,
    responseHash: (row.response_hash as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    canonicalPayloadHash: row.canonical_payload_hash as string,
  };
}

export function getTurnRuleObligation(
  store: Ce0Store,
  obligationId: string,
): TurnRuleObligationRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM turn_rule_obligation WHERE obligation_id = ?`)
    .get(obligationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapObligationRow(row);
}

/** List every obligation in the workspace whose first-Stop deadline has been claimed (the
 * frozen, due-resolved set the `mla evidence` export labels). A live obligation whose deadline
 * is still null is NOT exportable: its eligibility boundary is not yet fixed. FINALIZED rows are
 * INCLUDED here (this is a mechanical read of the claimed set); the export workflow, not the
 * store, decides to skip already-labeled ones. Deterministically ordered by (session, sequence,
 * obligationId) so the JSONL artifact is stable across runs. */
export function listDeadlineClaimedObligations(
  store: Ce0Store,
  workspaceId: string,
): TurnRuleObligationRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM turn_rule_obligation
        WHERE workspace_id = ? AND deadline_claimed_at IS NOT NULL
        ORDER BY session_id, local_turn_sequence, obligation_id`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapObligationRow);
}

// ---------------------------------------------------------------------------
// consultation_attempt
// ---------------------------------------------------------------------------

export function insertConsultationAttempt(
  store: Ce0Store,
  rec: ConsultationAttemptRecord,
): void {
  store.db
    .prepare(
      `INSERT INTO consultation_attempt
        (consultation_id, workspace_id, session_id, local_turn_sequence,
         source, consultation_subjects, execution, result, delivered_to_answering_context,
         ordering_token, created_at)
       VALUES
        (@consultation_id, @workspace_id, @session_id, @local_turn_sequence,
         @source, @consultation_subjects, @execution, @result, @delivered_to_answering_context,
         @ordering_token, @created_at)`,
    )
    .run({
      consultation_id: rec.consultationId,
      workspace_id: rec.workspaceId,
      session_id: rec.sessionId,
      local_turn_sequence: rec.localTurnSequence,
      source: rec.source,
      consultation_subjects: JSON.stringify(rec.consultationSubjects),
      execution: rec.execution,
      result: rec.result,
      delivered_to_answering_context: rec.deliveredToAnsweringContext ? 1 : 0,
      ordering_token: rec.orderingToken,
      created_at: rec.createdAt,
    });
}

/** A ConsultationAttempt whose orderingToken has not been minted yet (the capture adapter
 * supplies everything but the position; the store mints it). */
export type ConsultationAttemptDraft = Omit<ConsultationAttemptRecord, "orderingToken">;

/** Record one governed-memory consultation, minting its orderingToken in the same serialized
 * transaction: `BEGIN IMMEDIATE; nextToken = MAX(ordering_token) + 1; insert`. The token is a
 * per-turn monotonic position (scoped to the (workspace, session, sequence) the consultation
 * belongs to), NOT a wall clock: the first-Stop deadline claim reads the high-water token as
 * the eligibility boundary, and the reducer breaks proof ties on it. BEGIN IMMEDIATE takes the
 * write lock up front so two concurrent appends in one turn cannot read the same MAX. Returns
 * the persisted record carrying the minted token. */
export function appendConsultationAttempt(
  store: Ce0Store,
  draft: ConsultationAttemptDraft,
): ConsultationAttemptRecord {
  const mint = store.db.transaction((d: ConsultationAttemptDraft): ConsultationAttemptRecord => {
    const { maxTok } = store.db
      .prepare(
        `SELECT MAX(ordering_token) AS maxTok
           FROM consultation_attempt
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?`,
      )
      .get(d.workspaceId, d.sessionId, d.localTurnSequence) as { maxTok: number | null };
    const rec: ConsultationAttemptRecord = { ...d, orderingToken: (maxTok ?? 0) + 1 };
    insertConsultationAttempt(store, rec);
    return rec;
  });
  return mint.immediate(draft);
}

function mapConsultationRow(row: Record<string, unknown>): ConsultationAttemptRecord {
  return {
    consultationId: row.consultation_id as string,
    workspaceId: row.workspace_id as string,
    sessionId: row.session_id as string,
    localTurnSequence: row.local_turn_sequence as number,
    source: row.source as ConsultationSource,
    consultationSubjects: JSON.parse(row.consultation_subjects as string),
    execution: row.execution as ConsultationExecution,
    result: (row.result as ConsultationResult | null) ?? null,
    deliveredToAnsweringContext: row.delivered_to_answering_context === 1,
    orderingToken: row.ordering_token as number,
    createdAt: row.created_at as number,
  };
}

export function getConsultationAttempt(
  store: Ce0Store,
  consultationId: string,
): ConsultationAttemptRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM consultation_attempt WHERE consultation_id = ?`)
    .get(consultationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapConsultationRow(row);
}

/** List one turn's consultations, ordered by (orderingToken, consultationId): the same total
 * order the satisfaction reducer imposes, so the export's raw facts read in eligibility order.
 * Scoped to the exact (workspace, session, localTurnSequence) coordinate. */
export function listConsultationsForTurn(
  store: Ce0Store,
  coord: { workspaceId: string; sessionId: string; localTurnSequence: number },
): ConsultationAttemptRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM consultation_attempt
        WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?
        ORDER BY ordering_token, consultation_id`,
    )
    .all(coord.workspaceId, coord.sessionId, coord.localTurnSequence) as Record<string, unknown>[];
  return rows.map(mapConsultationRow);
}

// ---------------------------------------------------------------------------
// First-Stop: §2.3 Stage A (stamp the turn + claim the obligation deadline)
// ---------------------------------------------------------------------------

/** The frozen eligibility boundary for one obligation's turn. `deadlineClaimedAt` is the
 * turn's high-water orderingToken at first Stop (a position, never a wall clock);
 * `deadlineClaimedVersion` is the stateVersion the claim CAS'd against; `stateVersion` is
 * the post-claim value (observed + 1). */
export interface DeadlineClaim {
  obligationId: string;
  deadlineClaimedAt: number;
  deadlineClaimedVersion: number;
  stateVersion: number;
}

/** The result of a first-Stop deadline claim.
 *   - CLAIMED: this Stop froze the boundary.
 *   - ALREADY_CLAIMED: a prior Stop already froze it; this is an idempotent no-op.
 *   - NO_OBLIGATION: the turn has no obligation for the rule version (e.g. a NOT_REQUIRED
 *     turn, or a Stop for a session CE0 never assessed). */
export type DeadlineClaimResult =
  | { status: "CLAIMED"; claim: DeadlineClaim }
  | { status: "ALREADY_CLAIMED"; claim: DeadlineClaim }
  | { status: "NO_OBLIGATION" };

/**
 * §2.3 Stage A: the first Stop's immediate, I/O-free observation of a turn. In one serialized
 * `BEGIN IMMEDIATE` transaction it does two things:
 *   1. Stamps `stopObservedAt` on the turn's assessment for EVERY classified turn (REQUIRED or
 *      not), if-null so a later Stop never overwrites the first observation. A NOT_REQUIRED /
 *      UNKNOWN turn has an assessment but no obligation; it is still stamped, so the offline
 *      false-negative recall sample carries the same answer evidence as a flagged turn.
 *   2. When an obligation is present, freezes the eligibility boundary: it finds the obligation by
 *      its unique turn key, reads the turn's high-water orderingToken (the boundary), and
 *      CAS-advances stateVersion while writing the deadline fields. The status column is
 *      deliberately untouched: the claim fixes the boundary, it does not declare the obligation
 *      satisfied (satisfaction is recomputed offline over the frozen eligible set).
 * The deadline claim is idempotent: once a deadline is set, a later Stop returns ALREADY_CLAIMED
 * and never moves the boundary, so a consultation that arrives after the first Stop (a higher
 * token) cannot retroactively become eligible. No filesystem read happens here; the response
 * snapshot is the best-effort Stage B, outside this transaction. BEGIN IMMEDIATE serializes
 * concurrent Stops so exactly one wins the claim and the first stamp.
 */
export function claimFirstStop(
  store: Ce0Store,
  coord: { workspaceId: string; sessionId: string; localTurnSequence: number },
  ruleVersionId: string,
  now: () => number,
): DeadlineClaimResult {
  const run = store.db.transaction((): DeadlineClaimResult => {
    // Stage A step 1: stamp the assessment if-null. A pure write, no I/O; a harmless no-op when no
    // assessment row exists for the coord (e.g. a Stop for a turn CE0 never assessed).
    store.db
      .prepare(
        `UPDATE turn_memory_assessment
            SET stop_observed_at = ?
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?
            AND stop_observed_at IS NULL`,
      )
      .run(now(), coord.workspaceId, coord.sessionId, coord.localTurnSequence);

    // Stage A step 2: claim the obligation deadline, when an obligation is present.
    const key = store.db
      .prepare(
        `SELECT obligation_id FROM turn_rule_obligation
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?
            AND rule_version_id = ?`,
      )
      .get(coord.workspaceId, coord.sessionId, coord.localTurnSequence, ruleVersionId) as
      | { obligation_id: string }
      | undefined;
    if (!key) return { status: "NO_OBLIGATION" };

    const obligation = getTurnRuleObligation(store, key.obligation_id) as TurnRuleObligationRecord;
    if (obligation.deadlineClaimedAt !== null) {
      return {
        status: "ALREADY_CLAIMED",
        claim: {
          obligationId: obligation.obligationId,
          deadlineClaimedAt: obligation.deadlineClaimedAt,
          deadlineClaimedVersion: obligation.deadlineClaimedVersion as number,
          stateVersion: obligation.stateVersion,
        },
      };
    }

    const { maxTok } = store.db
      .prepare(
        `SELECT MAX(ordering_token) AS maxTok FROM consultation_attempt
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?`,
      )
      .get(coord.workspaceId, coord.sessionId, coord.localTurnSequence) as { maxTok: number | null };
    const boundary = maxTok ?? 0;
    const observed = obligation.stateVersion;

    store.db
      .prepare(
        `UPDATE turn_rule_obligation
            SET deadline_claimed_at = ?, deadline_claimed_version = ?, state_version = ?
          WHERE obligation_id = ? AND state_version = ? AND deadline_claimed_at IS NULL`,
      )
      .run(boundary, observed, observed + 1, obligation.obligationId, observed);

    return {
      status: "CLAIMED",
      claim: {
        obligationId: obligation.obligationId,
        deadlineClaimedAt: boundary,
        deadlineClaimedVersion: observed,
        stateVersion: observed + 1,
      },
    };
  });
  return run.immediate();
}

/** The result of the §2.3 Stage B response snapshot write.
 *   - RECORDED: this Stop filled the still-missing response pair.
 *   - ALREADY_RECORDED: a prior Stop already completed the snapshot; an idempotent no-op that never
 *     overwrites it (P0.6).
 *   - NO_ASSESSMENT: no assessment row exists for the coord, so there is nothing to snapshot. */
export type StopSnapshotWriteResult =
  | { status: "RECORDED" }
  | { status: "ALREADY_RECORDED" }
  | { status: "NO_ASSESSMENT" };

/**
 * §2.3 Stage B: record the best-effort response snapshot (`responseHash` + `responseSourceRef`) onto
 * an already-stamped assessment, OUTSIDE and AFTER the Stage A deadline transaction. The two fields
 * move together as one pair, never with `stopObservedAt` (proposal lines 1096-1098): Stage A stamped
 * the observation, this fills the response evidence the offline exporter rehydrates from the pointer.
 *
 * Idempotent under repeated Stop continuations (P0.6): a later Stop may fill a snapshot that is still
 * missing, but it may NEVER overwrite one that already completed. The guard is `response_hash IS NULL`
 * checked inside one serialized `BEGIN IMMEDIATE` transaction, so concurrent Stops cannot both write.
 * `stop_observed_at` is deliberately untouched here; only the response pair is written.
 */
export function recordStopResponseSnapshot(
  store: Ce0Store,
  coord: { workspaceId: string; sessionId: string; localTurnSequence: number },
  snapshot: { responseHash: string; responseSourceRef: ResponseSourceRefV1 },
): StopSnapshotWriteResult {
  const run = store.db.transaction((): StopSnapshotWriteResult => {
    const existing = store.db
      .prepare(
        `SELECT response_hash FROM turn_memory_assessment
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?`,
      )
      .get(coord.workspaceId, coord.sessionId, coord.localTurnSequence) as
      | { response_hash: string | null }
      | undefined;
    if (!existing) return { status: "NO_ASSESSMENT" };
    if (existing.response_hash != null) return { status: "ALREADY_RECORDED" };

    store.db
      .prepare(
        `UPDATE turn_memory_assessment
            SET response_hash = ?, response_source_ref = ?
          WHERE workspace_id = ? AND session_id = ? AND local_turn_sequence = ?
            AND response_hash IS NULL`,
      )
      .run(
        snapshot.responseHash,
        JSON.stringify(snapshot.responseSourceRef),
        coord.workspaceId,
        coord.sessionId,
        coord.localTurnSequence,
      );
    return { status: "RECORDED" };
  });
  return run.immediate();
}

/** The result of finalizing an obligation (writing its terminal outcome).
 *   - FINALIZED: the CAS matched; status moved to FINALIZED, outcome written, stateVersion advanced.
 *   - CAS_CONFLICT: the expected stateVersion did not match the stored one; nothing was written.
 *   - NO_OBLIGATION: no obligation exists for the id. */
export type FinalizeResult =
  | { status: "FINALIZED"; obligationId: string; outcome: string; stateVersion: number }
  | {
      status: "CAS_CONFLICT";
      obligationId: string;
      expectedStateVersion: number;
      actualStateVersion: number;
    }
  | { status: "NO_OBLIGATION"; obligationId: string };

/**
 * Write a turn obligation's terminal outcome and move it to FINALIZED, guarded by a
 * compare-and-swap on stateVersion (the same token the deadline claim advances). The human
 * labeler chooses the outcome offline (§2.3); this is the only thing that finalizes a due turn.
 * In one serialized `BEGIN IMMEDIATE` transaction: read the stored stateVersion, fail closed as
 * CAS_CONFLICT if it does not match the caller's expectation (a concurrent finalize or a stale
 * label), else set status='FINALIZED', write the outcome, and advance stateVersion. The CAS makes
 * a re-import of an already-finalized obligation a clean conflict, never a double-write.
 */
export function finalizeObligation(
  store: Ce0Store,
  cmd: { obligationId: string; expectedStateVersion: number; outcome: string },
): FinalizeResult {
  const run = store.db.transaction((): FinalizeResult => {
    const obligation = getTurnRuleObligation(store, cmd.obligationId);
    if (!obligation) {
      return { status: "NO_OBLIGATION", obligationId: cmd.obligationId };
    }
    if (obligation.stateVersion !== cmd.expectedStateVersion) {
      return {
        status: "CAS_CONFLICT",
        obligationId: cmd.obligationId,
        expectedStateVersion: cmd.expectedStateVersion,
        actualStateVersion: obligation.stateVersion,
      };
    }

    const next = cmd.expectedStateVersion + 1;
    store.db
      .prepare(
        `UPDATE turn_rule_obligation
            SET status = 'FINALIZED', outcome = ?, state_version = ?
          WHERE obligation_id = ? AND state_version = ?`,
      )
      .run(cmd.outcome, next, cmd.obligationId, cmd.expectedStateVersion);

    return {
      status: "FINALIZED",
      obligationId: cmd.obligationId,
      outcome: cmd.outcome,
      stateVersion: next,
    };
  });
  return run.immediate();
}
