// `enrich ingest`: load the authoritative run record (the agent supplies only
// {runId, results}, never trusted plan data), re-verify it, then validate + persist each
// scout's candidates. Security-critical: realpath containment, exist-at-HEAD via the
// tracked set, and commit-allowlist membership all live here (plan §5, §5b, §6, §6b, §9).
//
// HTTP is injected as a Persister so this module is fully unit-testable without a live
// intel server; the command wires the real kb-add POST. The filesystem/git probe is
// likewise injectable, default-built from the repo root.

import { realpathSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, sep, isAbsolute } from "node:path";
import {
  computePlanDigest,
  commitAllowlist,
  resolveAllowedCommit,
  candidateId,
  candidateRelPath,
  dedupKey,
  validateIngestRequestShape,
  validateScoutResultShape,
  validateCandidateShape,
  SCOUT_NAMES,
  type CandidateValidationError,
  type EnrichmentCandidate,
  type EnrichmentEvidence,
  type MergedCandidate,
  type OnboardingRun,
  type OnboardingState,
  type OnboardingCandidateRecord,
  type OnboardingCandidatesSidecar,
  type ScoutIngestOutcome,
  type ScoutName,
  type ScoutRunState,
  type ScoutRunStatus,
} from "./protocol";
import { loadRunRecord, runsDir, defaultGitRunner, type GitRunner } from "./plan";

// One inline document for the kb-add POST. relPath is vault-relative; the server prefixes
// the `notes/` identity root and forces reviewOutcome=PENDING (verified in kb_add.py).
export interface PersistDocument {
  relPath: string;
  content: string;
}

// The real server outcome for one document, mirroring KbAddReceipt.outcome:
//   "ingested"       — a new governed revision was minted (a brand-new doc, or changed content)
//   "noop_unchanged" — the content was byte-identical to what is already governed; nothing changed
//   "failed"         — the server could not persist this one document (a 200 can still carry these)
export type PersistOutcome = "ingested" | "noop_unchanged" | "failed";
export interface PersistedDoc {
  relPath: string;
  outcome: PersistOutcome;
}

// The persister POSTs the docs and reports each one's real outcome, IN THE SAME ORDER it was
// given them (kb/add returns one receipt per document in input order). ingest uses this to
// report idempotency honestly: re-running onboarding on an unchanged repo reports every doc as
// already-present, never as freshly persisted. The whole POST throwing is the all-or-nothing
// failure path (handled by ingest's try/catch); per-document "failed" is the partial-failure
// signal the server returns inside an otherwise-successful response.
export type Persister = (docs: PersistDocument[]) => Promise<{ docs: PersistedDoc[] }>;

export interface IngestEnv {
  home: string;
  workspaceId: string; // authoritative, derived by the command (not from the agent)
  repositoryRoot: string;
}

// Filesystem + git probe for the impure candidate checks. Injectable for tests.
export interface FsProbe {
  repoRealpath: string;
  realpath(absPath: string): string; // throws if the path does not exist
  lineCount(absPath: string): number; // throws if the path does not exist
  isTracked(relPath: string): boolean; // present in `git ls-files` (exists at HEAD)
}

export interface IngestResult {
  ok: boolean;
  rejectionReason?: string; // top-level reject (unknown run, wrong ws/repo, bad digest/envelope)
  runId?: string;
  outcomes: ScoutIngestOutcome[];
  state?: OnboardingState;
}

const SCOUT_SLOTS: ScoutName[] = ["documentation", "history"];

/**
 * Per-scout HARD cap with a run-total backstop, NO reallocation (verdict item 8). Each
 * runnable scout gets at most `perScoutCap` candidates, INDEPENDENT of what the other scout
 * produced: an under-producing scout never cedes its surplus and an over-producer is never
 * handed the other's leftover. This deliberately replaces the old round-robin fair-share,
 * which DID reallocate surplus. The run-total backstop (`totalCap` minus budget already
 * consumed by scouts that completed in a prior ingest) only bites when the per-scout caps
 * could otherwise sum past the total; for the shipped 10/10/20 defaults each runnable scout
 * simply gets its full 10. `runnable` is the set of scouts not already complete from a prior
 * ingest; complete scouts get 0 here (they are skipped in the loop and counted via prior).
 * Caps are dealt in slot order so the backstop is deterministic.
 */
function allocateScoutBudgets(
  perScoutCap: number,
  totalCap: number,
  committedPrior: number,
  runnable: Set<ScoutName>,
): Map<ScoutName, number> {
  const budget = new Map<ScoutName, number>();
  let remainingTotal = Math.max(0, totalCap - Math.max(0, committedPrior));
  for (const s of SCOUT_SLOTS) {
    if (!runnable.has(s)) {
      budget.set(s, 0);
      continue;
    }
    const cap = Math.max(0, Math.min(Math.max(0, perScoutCap), remainingTotal));
    budget.set(s, cap);
    remainingTotal -= cap;
  }
  return budget;
}

// Evidence dedup key INCLUDING line ranges: two file anchors on the same path but different
// lines are distinct evidence and both are kept; only a byte-identical anchor is collapsed.
// (candidateId strips lines, so unioning same-path/different-line anchors leaves the id
// unchanged; this just stops the rendered doc from listing the very same anchor twice.)
function evidenceKey(ev: EnrichmentEvidence): string {
  return ev.type === "file"
    ? `file|${ev.path}|${ev.startLine}|${ev.endLine}`
    : `commit|${ev.commit.toLowerCase()}|${ev.path ?? ""}`;
}

/**
 * Exact cross-scout merge (verdict item 9), scoped to a SINGLE ingest call. Candidates are
 * folded by dedupKey (kind + normalized statement, anchor-insensitive). Iterated in slot
 * order (SCOUT_NAMES) then input order so the result is independent of how the agent ordered
 * the results array: the first contributing candidate seeds kind/statement/rationale; every
 * later duplicate only unions its evidence (deduped) and adds its scout to sourceScouts. The
 * returned map preserves first-seen insertion order so the rendered documents stay
 * deterministic. Merge NEVER spans ingest calls (a resuming scout's candidates arrive in a
 * later call with the other scout already complete), so this is the only place exact
 * duplicates collapse and a re-ingest of the same inputs reproduces the same merged set.
 */
function mergeAcceptedCandidates(
  batches: Array<{ scout: ScoutName; candidates: EnrichmentCandidate[] }>,
): Map<string, MergedCandidate> {
  const merged = new Map<string, MergedCandidate>();
  const evidenceSeen = new Map<string, Set<string>>();
  const scoutsSeen = new Map<string, Set<ScoutName>>();
  const ordered = [...batches].sort((a, b) => SCOUT_NAMES.indexOf(a.scout) - SCOUT_NAMES.indexOf(b.scout));
  for (const batch of ordered) {
    for (const c of batch.candidates) {
      const key = dedupKey(c);
      let m = merged.get(key);
      if (!m) {
        m = {
          kind: c.kind,
          statement: c.statement,
          evidence: [],
          sourceScouts: [],
          rationale: c.rationale ?? null,
          rationaleSource: c.rationaleSource ?? null,
        };
        merged.set(key, m);
        evidenceSeen.set(key, new Set());
        scoutsSeen.set(key, new Set());
      } else if ((!m.rationale || m.rationale.trim().length === 0) && c.rationale && c.rationale.trim().length > 0) {
        // First non-empty rationale wins (deterministic by the slot/input order above); a
        // later duplicate may FILL an empty one but never overwrites a rationale already set.
        m.rationale = c.rationale;
        m.rationaleSource = c.rationaleSource ?? null;
      }
      const evSet = evidenceSeen.get(key)!;
      for (const ev of c.evidence) {
        const ek = evidenceKey(ev);
        if (!evSet.has(ek)) {
          evSet.add(ek);
          m.evidence.push(ev);
        }
      }
      scoutsSeen.get(key)!.add(c.sourceScout);
    }
  }
  for (const [key, m] of merged) {
    const seen = scoutsSeen.get(key)!;
    m.sourceScouts = SCOUT_NAMES.filter((s) => seen.has(s));
  }
  return merged;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function defaultProbe(repoRoot: string, gitRunner: GitRunner = defaultGitRunner(repoRoot)): FsProbe {
  const repoRealpath = safeRealpath(repoRoot);
  let tracked: Set<string> | null = null;
  return {
    repoRealpath,
    realpath: (absPath) => realpathSync(absPath),
    lineCount: (absPath) => readFileSync(absPath, "utf8").split("\n").length,
    isTracked: (relPath) => {
      if (!tracked) {
        try {
          tracked = new Set(
            gitRunner(["ls-files"])
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          );
        } catch {
          tracked = new Set();
        }
      }
      return tracked.has(relPath);
    },
  };
}

// --- impure candidate verification (shape already validated upstream) -------------

function verifyFileEvidence(
  ev: Extract<EnrichmentEvidence, { type: "file" }>,
  probe: FsProbe,
  push: (code: string, message: string) => void,
): void {
  const raw = ev.path.trim();
  if (isAbsolute(raw)) {
    push("path_traversal", `file path must be repo-relative: ${raw}`);
    return;
  }
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.split("/").includes("..")) {
    push("path_traversal", `file path may not contain "..": ${raw}`);
    return;
  }
  if (!probe.isTracked(norm)) {
    push("untracked_path", `file is not tracked at HEAD: ${norm}`);
    return;
  }
  const abs = join(probe.repoRealpath, norm);
  let real: string;
  try {
    real = probe.realpath(abs);
  } catch {
    push("missing_file", `file does not exist: ${norm}`);
    return;
  }
  if (real !== probe.repoRealpath && !real.startsWith(probe.repoRealpath + sep)) {
    push("escapes_repo", `file resolves outside the repository: ${norm}`);
    return;
  }
  let lines: number;
  try {
    lines = probe.lineCount(real);
  } catch {
    push("missing_file", `file is unreadable: ${norm}`);
    return;
  }
  if (ev.endLine > lines) {
    push("line_out_of_range", `endLine ${ev.endLine} exceeds file length ${lines}: ${norm}`);
  }
}

// How much of a rejected statement to echo back. Long enough to identify the claim and
// retype it from the source, short enough that a scout that sent garbage cannot flood the
// terminal with it.
const REJECT_EXCERPT_CHARS = 160;

// Pulls a human-identifiable excerpt out of an UNVALIDATED candidate: this runs on raw
// scout output, so `raw` may be any shape at all (that is precisely what is being rejected)
// and every access has to survive it. Returns undefined when there is no usable statement,
// in which case the reject prints its code alone, as it always did.
export function statementExcerpt(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const statement = (raw as { statement?: unknown }).statement;
  if (typeof statement !== "string") return undefined;
  const collapsed = statement.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= REJECT_EXCERPT_CHARS) return collapsed;
  return `${collapsed.slice(0, REJECT_EXCERPT_CHARS)}...`;
}

// Verifies a single shape-valid candidate against the filesystem + commit allowlist.
// Rejects the whole candidate if ANY anchor fails (a citation is only as trustworthy as
// its weakest anchor). Returns all errors for reporting.
export function verifyCandidate(
  candidate: EnrichmentCandidate,
  run: OnboardingRun,
  probe: FsProbe,
  index: number,
): CandidateValidationError[] {
  const errors: CandidateValidationError[] = [];
  const push = (code: string, message: string): void => {
    errors.push({ index, code, message });
  };
  const allowlist = commitAllowlist(run);
  for (const ev of candidate.evidence) {
    if (ev.type === "file") {
      verifyFileEvidence(ev, probe, push);
    } else if (resolveAllowedCommit(allowlist, ev.commit) === null) {
      push("commit_not_in_allowlist", `commit is not in the plan's allowlist: ${ev.commit}`);
    }
  }
  return errors;
}

// --- candidate -> governed document ----------------------------------------------

// The schema version of the rendered onboarding-candidate document. Bumped if the
// frontmatter keys or body skeleton change in a way a downstream reader must notice.
export const CANDIDATE_DOC_SCHEMA_VERSION = 1 as const;

// The scout NEVER authors the persisted Markdown (verdict item 10): this single versioned
// renderer does, so the artifact's shape is deterministic and auditable. The frontmatter is
// machine-readable metadata; the body is for the human reviewer.
//
// Frontmatter keys are chosen to be NON-COLLIDING with the two scanners that read
// frontmatter (verdict item 7 reconciliation):
//   - agent-memory auto-capture keys on `metadata.type == "project"` (classify.ts); we emit
//     `kind:`, never `type:`, and no nested `metadata:` block, so a candidate is never
//     auto-captured.
//   - stale-detection keys on `status: deprecated|superseded|rejected` (scanner/scan.ts); we
//     emit `reviewHint: provisional`, never `status:`, so a candidate is never stale-flagged.
// Governance status is SERVER-authoritative: this file carries no `status`/`reviewOutcome`.
// `reviewHint: provisional` is an advisory hint only. The note is born PENDING server-side.
//
// Every frontmatter value is a closed-vocabulary literal (a literal, the sha256 candidateId,
// the kind enum, or the scout enum), so no user/agent-controlled string enters the YAML; the
// free-text statement and rationale live in the body, after the closing fence.
export function renderCandidateDocument(candidate: MergedCandidate): string {
  const sourceLabel = renderSourceLabel(candidate.sourceScouts);

  const front: string[] = [
    "---",
    "mlaGenerated: onboarding-candidate",
    `schemaVersion: ${CANDIDATE_DOC_SCHEMA_VERSION}`,
    `candidateId: ${candidateId(candidate)}`,
    `kind: ${candidate.kind}`,
    `sourceScouts: [${candidate.sourceScouts.join(", ")}]`,
    "reviewHint: provisional",
    "---",
  ];

  const body: string[] = [];
  body.push("# Candidate");
  body.push("");
  body.push(candidate.statement.trim());
  body.push("");
  body.push(`Surfaced by the ${sourceLabel} (onboarding enrichment, advisory).`);
  body.push("");
  // Rationale carries a provenance label so the persisted artifact never presents an agent's
  // paraphrase as the user's own words (memo Phase 1). Rendered only when present; a missing
  // rationale is simply omitted (missing beats fabricated).
  if (candidate.rationale && candidate.rationale.trim().length > 0) {
    body.push(
      candidate.rationaleSource === "USER_EXPLICIT"
        ? "## Rationale (user-stated)"
        : "## Rationale (agent summary; not the user's words)",
    );
    body.push(candidate.rationale.trim());
    body.push("");
  }
  body.push("## Evidence");
  for (const ev of candidate.evidence) {
    if (ev.type === "file") {
      body.push(`- \`${ev.path}\` lines ${ev.startLine}-${ev.endLine}`);
    } else {
      body.push(`- commit \`${ev.commit}\`${ev.path ? ` (\`${ev.path}\`)` : ""}`);
    }
  }
  body.push("");
  body.push("## Status");
  body.push(
    "Governance status is owned by Meetless and is PENDING human review; this file does not assert an approval outcome.",
  );

  return `${front.join("\n")}\n\n${body.join("\n")}\n`;
}

// Human-readable source label: a single scout reads as "documentation scout"; multiple as
// "documentation + history scouts", always in SCOUT_NAMES slot order (the merge sorts that
// way, but render is independent of the merge so the label is stable on its own).
function renderSourceLabel(sourceScouts: readonly ScoutName[]): string {
  const ordered = SCOUT_NAMES.filter((s) => sourceScouts.includes(s));
  const list = ordered.length > 0 ? ordered : [...sourceScouts];
  return list.length > 1 ? `${list.join(" + ")} scouts` : `${list[0]} scout`;
}

// --- per-scout state persistence (§6) --------------------------------------------

// Per-run resume state lives BESIDE the run record it belongs to, keyed by runId, so two
// repos sharing one workspace never collide on a single onboarding-state.json (§6). A
// stale path keyed only by workspace made the first repo's completion permanently skip
// every later repo's scouts. Named `<runId>.state.json` so it sorts next to `<runId>.json`
// and prune can drop the pair together.
export function statePath(home: string, workspaceId: string, runId: string): string {
  return join(home, "workspaces", workspaceId, "onboarding-runs", `${runId}.state.json`);
}

export function loadState(home: string, workspaceId: string, runId: string): OnboardingState | null {
  const path = statePath(home, workspaceId, runId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OnboardingState;
    if (parsed?.schemaVersion !== 1) return null;
    // A state file is only valid for the run it names: ignore one whose stored runId
    // drifted from its path (corruption / hand-edit), rather than resuming the wrong run.
    if (parsed.runId !== runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(home: string, state: OnboardingState): void {
  const dir = join(home, "workspaces", state.workspaceId, "onboarding-runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(home, state.workspaceId, state.runId), JSON.stringify(state, null, 2), "utf8");
}

// --- candidates sidecar (the accept half's durable record) -----------------------

// The candidates a run produced live BESIDE the run record + resume state, keyed by runId, as
// `<runId>.candidates.json` (sorts next to `<runId>.json` / `<runId>.state.json`; prune drops
// the trio together). ingest writes it; `enrich accept` reads it to materialize the durable
// ones into .meetless/rules.md. It is the missing bridge between ingest (which parks EVERY
// candidate born PENDING in the governed KB) and the local accept half: after ingest, only the
// rendered markdown remains in the KB, so the structured post-merge candidates would otherwise
// be gone and accept would have nothing to materialize from without re-parsing markdown.
export function candidatesSidecarPath(home: string, workspaceId: string, runId: string): string {
  return join(home, "workspaces", workspaceId, "onboarding-runs", `${runId}.candidates.json`);
}

export function loadCandidatesSidecar(
  home: string,
  workspaceId: string,
  runId: string,
): OnboardingCandidatesSidecar | null {
  const path = candidatesSidecarPath(home, workspaceId, runId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OnboardingCandidatesSidecar;
    if (parsed?.schemaVersion !== 1) return null;
    // A sidecar is only valid for the run it names: ignore one whose stored runId drifted from
    // its path (corruption / hand-edit) rather than materializing another run's candidates.
    if (parsed.runId !== runId) return null;
    if (!Array.isArray(parsed.candidates)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Accumulate candidates into the sidecar, deduped by candidateId, preserving first-seen order
// (existing entries first, new ones appended; a repeated candidateId is overwritten in place so
// its landed outcome reflects the latest ingest). Merge, never overwrite: a resuming scout's
// candidates arrive in a LATER ingest call with the other scout already complete, so a blind
// overwrite would drop the first scout's candidates. Atomic temp+rename so a crash mid-write
// never leaves accept a half-written sidecar. Idempotent: re-ingesting the same inputs yields
// the same candidateIds and the same sidecar.
export function upsertCandidatesSidecar(home: string, incoming: OnboardingCandidatesSidecar): void {
  const existing = loadCandidatesSidecar(home, incoming.workspaceId, incoming.runId);
  const byId = new Map<string, OnboardingCandidateRecord>();
  if (existing) for (const c of existing.candidates) byId.set(c.candidateId, c);
  for (const c of incoming.candidates) byId.set(c.candidateId, c);
  const merged: OnboardingCandidatesSidecar = {
    schemaVersion: 1,
    workspaceId: incoming.workspaceId,
    runId: incoming.runId,
    repositoryRoot: incoming.repositoryRoot,
    updatedAt: incoming.updatedAt,
    candidates: [...byId.values()],
  };
  const dir = join(home, "workspaces", incoming.workspaceId, "onboarding-runs");
  mkdirSync(dir, { recursive: true });
  const path = candidatesSidecarPath(home, incoming.workspaceId, incoming.runId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  renameSync(tmp, path);
}

// Idempotency gate (notes/20260627-onboarding-idempotency-plandigest-gate.md): find a PRIOR
// COMPLETED onboarding run for this repo whose plan is byte-identical (same planDigest) to the
// one just built. Re-running `enrich plan` on an unchanged repo only re-surfaces the same
// governance as fresh near-duplicate PENDING candidates: scout output is LLM-generated and
// non-deterministic, so candidateIds drift and the server's byte-identity dedup never fires.
// The deterministic planDigest is the safe idempotency key (same repo content -> same plan ->
// nothing new to onboard). Returns the matching prior run + its state (carrying the candidate
// count) so the caller can report it, or null to proceed. Only a COMPLETE prior run gates: a
// partial/in-flight one left work undone, so a re-run must be allowed to finish it.
export function findCompletedRunWithDigest(
  home: string,
  workspaceId: string,
  repositoryRoot: string,
  planDigest: string,
  excludeRunId?: string,
): { run: OnboardingRun; state: OnboardingState } | null {
  const dir = runsDir(home, workspaceId);
  if (!existsSync(dir)) return null;
  const repoReal = safeRealpath(repositoryRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    // Only run-record files (`<runId>.json`); skip state + candidates sidecars.
    if (!name.endsWith(".json") || name.endsWith(".state.json") || name.endsWith(".candidates.json")) continue;
    const runId = name.slice(0, -".json".length);
    if (excludeRunId && runId === excludeRunId) continue;
    const rec = loadRunRecord(home, workspaceId, runId);
    if (!rec) continue;
    if (rec.planDigest !== planDigest) continue;
    if (safeRealpath(rec.repositoryRoot) !== repoReal) continue;
    const state = loadState(home, workspaceId, runId);
    if (state?.status === "complete") return { run: rec, state };
  }
  return null;
}

function emptyScoutState(): ScoutRunState {
  return { status: "not_started" };
}

// --- orchestration ---------------------------------------------------------------

export async function ingestRun(input: {
  env: IngestEnv;
  request: unknown;
  persist: Persister;
  now: string;
  probe?: FsProbe;
  gitRunner?: GitRunner;
}): Promise<IngestResult> {
  const { env, request, persist, now } = input;

  const envelope = validateIngestRequestShape(request);
  if (!envelope.ok) return { ok: false, rejectionReason: envelope.error, outcomes: [] };
  const { runId, results } = envelope.request;

  const run = loadRunRecord(env.home, env.workspaceId, runId);
  if (!run) return { ok: false, rejectionReason: `unknown run: ${runId}`, outcomes: [], runId };
  if (run.workspaceId !== env.workspaceId) {
    return { ok: false, rejectionReason: "run record workspace mismatch", outcomes: [], runId };
  }
  if (safeRealpath(run.repositoryRoot) !== safeRealpath(env.repositoryRoot)) {
    return { ok: false, rejectionReason: "run record repository mismatch", outcomes: [], runId };
  }
  if (computePlanDigest(run) !== run.planDigest) {
    return { ok: false, rejectionReason: "plan digest mismatch (run record corrupt)", outcomes: [], runId };
  }

  const probe = input.probe ?? defaultProbe(env.repositoryRoot, input.gitRunner);

  // Resume: a scout already "complete" is never re-processed (its candidates are
  // immutable; §6). Carry prior state forward. Keyed by runId, so a different repo's run
  // in the same workspace starts from a clean slate instead of inheriting "complete".
  const prior = loadState(env.home, env.workspaceId, runId);
  const scoutState: Record<ScoutName, ScoutRunState> = {
    documentation: prior?.scouts.documentation ?? emptyScoutState(),
    history: prior?.scouts.history ?? emptyScoutState(),
  };

  const outcomes: ScoutIngestOutcome[] = [];
  const totalCap = run.limits.maxCandidatesTotal;
  const perScoutCap = run.limits.maxCandidatesPerScout;

  // Budget consumed by scouts that completed in a PRIOR ingest (resume): they are
  // skipped in the loop below but still count against the run's total backstop.
  const committedPrior = SCOUT_SLOTS.reduce((n, s) => {
    const st = scoutState[s];
    return n + (st.status === "complete" ? (st.candidateCount ?? 0) : 0);
  }, 0);

  // Runnable scouts = every slot not already complete from a prior ingest. Each gets its
  // own independent per-scout cap (no reallocation, verdict item 8); the cap does NOT
  // depend on what the scout actually sent, so a low-producing scout never frees capacity
  // for the other one.
  const runnable = new Set<ScoutName>(SCOUT_SLOTS.filter((s) => scoutState[s].status !== "complete"));
  const budget = allocateScoutBudgets(perScoutCap, totalCap, committedPrior, runnable);

  // Phase 1: validate + cap each scout, but persist NOTHING yet. A scout that completed in a
  // prior ingest, reported it did not finish, or arrived malformed is resolved in-loop (it
  // contributes no accepted candidates); every complete scout's accepted set is collected so
  // Phase 2 can merge exact duplicates across BOTH scouts before a single POST.
  const completeBatch: Array<{
    scout: ScoutName;
    received: number;
    accepted: EnrichmentCandidate[];
    errors: CandidateValidationError[];
  }> = [];

  for (const rawResult of results) {
    const shape = validateScoutResultShape(rawResult);
    if (!shape.ok) {
      // Try to attribute a malformed envelope to a slot for retry; else surface loose.
      const guessed = guessScoutName(rawResult);
      if (guessed) scoutState[guessed] = { status: "malformed", error: shape.error };
      outcomes.push({
        scout: guessed ?? "documentation",
        received: 0,
        accepted: 0,
        rejected: 0,
        persisted: 0,
        deduped: 0,
        errors: [{ index: -1, code: "malformed_envelope", message: shape.error }],
      });
      continue;
    }
    const result = shape.result;
    const scout = result.scout;

    if (scoutState[scout].status === "complete") {
      outcomes.push({
        scout,
        received: 0,
        accepted: 0,
        rejected: 0,
        persisted: 0,
        deduped: 0,
        errors: [{ index: -1, code: "already_complete", message: "scout already complete; skipped" }],
      });
      continue;
    }

    // The agent reports the scout did not finish: record it, persist nothing (rerun
    // re-runs it). Avoids partial-persist duplication for unfinished scouts.
    if (result.status !== "complete") {
      scoutState[scout] = { status: result.status as ScoutRunStatus, error: result.error };
      outcomes.push({
        scout,
        received: result.candidates.length,
        accepted: 0,
        rejected: 0,
        persisted: 0,
        deduped: 0,
        errors: [{ index: -1, code: result.status, message: result.error ?? `scout ${result.status}` }],
      });
      continue;
    }

    // Complete + valid envelope: validate each candidate independently, bounded by
    // this scout's own independent per-scout cap (computed above; no reallocation).
    const accepted: EnrichmentCandidate[] = [];
    const errors: CandidateValidationError[] = [];
    const scoutBudget = budget.get(scout) ?? 0;
    result.candidates.forEach((raw, i) => {
      // Every reject raised in this iteration is about THIS candidate, so stamp them all with
      // its statement excerpt. A reject drops the claim for good; without the excerpt the
      // operator is told only a code and a slot number in a scout array that no longer exists
      // anywhere, so a claim lost to a one-character overrun could not even be identified,
      // let alone re-entered by hand.
      const excerpt = statementExcerpt(raw);
      const reject = (...raised: CandidateValidationError[]): void => {
        for (const e of raised) errors.push(excerpt ? { ...e, excerpt } : e);
      };

      if (accepted.length >= scoutBudget) {
        reject({
          index: i,
          code: "candidate_cap_exceeded",
          message: `per-scout candidate cap reached; this scout's cap was ${scoutBudget} (per-scout ${perScoutCap}, run total ${totalCap})`,
        });
        return;
      }
      const shapeRes = validateCandidateShape(raw, i);
      if (!shapeRes.ok) {
        reject(...shapeRes.errors);
        return;
      }
      const verifyErrors = verifyCandidate(shapeRes.candidate, run, probe, i);
      if (verifyErrors.length > 0) {
        reject(...verifyErrors);
        return;
      }
      accepted.push(shapeRes.candidate);
    });

    completeBatch.push({ scout, received: result.candidates.length, accepted, errors });
  }

  // Phase 2: merge EXACT duplicates across this single ingest call (verdict item 9). A
  // statement both scouts surfaced becomes ONE governed document that cites both, instead of
  // two near-identical docs the reviewer must reconcile. Merge is anchor-insensitive (keyed
  // by kind + normalized statement) so it also collapses a scout that emitted the same
  // statement twice; it is scoped to THIS call only, so a resuming scout (whose candidates
  // arrive after the other is already complete) never folds across calls. Everything goes out
  // in one POST so the run has a single persistence outcome.
  const merged = mergeAcceptedCandidates(completeBatch.map((b) => ({ scout: b.scout, candidates: b.accepted })));

  const docsByPath = new Map<string, PersistDocument>();
  const scoutsByPath = new Map<string, ScoutName[]>();
  for (const m of merged.values()) {
    const relPath = candidateRelPath(m);
    if (docsByPath.has(relPath)) continue; // distinct merged candidates never collide here; defensive
    docsByPath.set(relPath, { relPath, content: renderCandidateDocument(m) });
    scoutsByPath.set(relPath, [...m.sourceScouts]);
  }
  const docs = [...docsByPath.values()];

  let persistFailed = false;
  let persistErrorMessage = "";
  const outcomeByPath = new Map<string, PersistOutcome>();
  if (docs.length > 0) {
    try {
      const res = await persist(docs);
      // The server returns one outcome per document in input order; a length mismatch is a
      // contract violation we refuse to interpret (it would mis-attribute outcomes), so treat
      // it as a whole-POST failure rather than silently report a partial, wrong tally.
      if (res.docs.length !== docs.length) {
        throw new Error(
          `kb-add returned ${res.docs.length} outcome(s) for ${docs.length} document(s)`,
        );
      }
      docs.forEach((d, i) => outcomeByPath.set(d.relPath, res.docs[i].outcome));
    } catch (e) {
      persistFailed = true;
      persistErrorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  // Tally each scout's landed documents by REAL server outcome: newly minted ("ingested") vs
  // already governed and unchanged ("noop_unchanged"). A doc shared by both scouts counts
  // toward each: the union truly carries each one's evidence. A doc the server reported
  // "failed" (a 200 carrying a per-document failure) landed for neither and is surfaced as an
  // error below. This split is what makes idempotency visible: a re-run of an unchanged repo
  // reports every doc as already-present, not as freshly persisted.
  const newByScout: Record<ScoutName, number> = { documentation: 0, history: 0 };
  const dedupedByScout: Record<ScoutName, number> = { documentation: 0, history: 0 };
  const docFailedByScout: Record<ScoutName, number> = { documentation: 0, history: 0 };
  if (!persistFailed) {
    for (const [relPath, scouts] of scoutsByPath) {
      const outcome = outcomeByPath.get(relPath);
      for (const s of scouts) {
        if (outcome === "ingested") newByScout[s] += 1;
        else if (outcome === "noop_unchanged") dedupedByScout[s] += 1;
        else docFailedByScout[s] += 1; // "failed", or a missing outcome (defensive)
      }
    }
  }

  // Attribute the single POST's outcome back to each scout. On a whole-POST failure every
  // scout that accepted at least one candidate shares the persistence_failed fate (one POST,
  // one transactional result); a scout that accepted nothing had nothing at stake and stays
  // complete. `persisted` is the count of the scout's merged documents that landed born
  // PENDING (new + already-present); `deduped` is how many of those were already present.
  for (const b of completeBatch) {
    if (persistFailed && b.accepted.length > 0) {
      scoutState[b.scout] = { status: "persistence_failed", error: "kb-add persistence failed" };
      outcomes.push({
        scout: b.scout,
        received: b.received,
        accepted: b.accepted.length,
        rejected: b.received - b.accepted.length,
        persisted: 0,
        deduped: 0,
        errors: [...b.errors, { index: -1, code: "persistence_failed", message: persistErrorMessage }],
      });
      continue;
    }
    // A per-document failure (a 200 carrying a failed receipt for one of this scout's docs)
    // means that doc landed for NOBODY, so the scout is not done: mark it retryable so the
    // next ingest re-attempts it. A transient server-side failure (e.g. the KB DB was briefly
    // unreachable and intel returned per-doc failed receipts instead of a whole-POST error)
    // then self-heals on rerun; the docs that DID land re-POST as an idempotent noop_unchanged.
    // Leaving the scout `complete` here would strand the failed doc forever, because resume
    // skips a complete scout (already_complete) and never retries it. This keeps the run
    // `partial` until every doc actually persists, matching the state-driven resume rule
    // (§6: resume runs scouts whose status != complete).
    const docFailed = docFailedByScout[b.scout];
    const errors = [...b.errors];
    if (docFailed > 0) {
      errors.push({
        index: -1,
        code: "persistence_partial",
        message: `${docFailed} document(s) the server could not persist; rerun ingest to retry`,
      });
      scoutState[b.scout] = {
        status: "persistence_failed",
        error: `${docFailed} document(s) could not persist`,
      };
    } else {
      scoutState[b.scout] = { status: "complete", candidateCount: b.accepted.length };
    }
    outcomes.push({
      scout: b.scout,
      received: b.received,
      accepted: b.accepted.length,
      rejected: b.received - b.accepted.length,
      persisted: newByScout[b.scout] + dedupedByScout[b.scout],
      deduped: dedupedByScout[b.scout],
      errors,
    });
  }

  // Persist the accept half's durable record: the exact post-merge candidates this call
  // produced, so `enrich accept` can later materialize the durable ones (constraint /
  // convention / boundary) into .meetless/rules.md. Skip on a whole-POST failure (nothing
  // landed; the retry rewrites) and when there is nothing to add (an empty or already-complete
  // scout), so a no-op call never churns the sidecar. upsert MERGES with any prior sidecar, so
  // a resuming second scout appends to the first scout's candidates rather than replacing them.
  if (!persistFailed && merged.size > 0) {
    const records: OnboardingCandidateRecord[] = [];
    for (const m of merged.values()) {
      const relPath = candidateRelPath(m);
      records.push({
        candidateId: candidateId(m),
        kind: m.kind,
        statement: m.statement,
        evidence: m.evidence,
        sourceScouts: [...m.sourceScouts],
        rationale: m.rationale ?? null,
        rationaleSource: m.rationaleSource ?? null,
        relPath,
        landed: outcomeByPath.get(relPath) ?? "failed",
      });
    }
    upsertCandidatesSidecar(env.home, {
      schemaVersion: 1,
      workspaceId: env.workspaceId,
      runId,
      repositoryRoot: env.repositoryRoot,
      updatedAt: now,
      candidates: records,
    });
  }

  const allComplete = SCOUT_SLOTS.every((s) => scoutState[s].status === "complete");
  const state: OnboardingState = {
    workspaceId: env.workspaceId,
    runId,
    repositoryRoot: env.repositoryRoot,
    schemaVersion: 1,
    status: allComplete ? "complete" : "partial",
    updatedAt: now,
    scouts: { documentation: scoutState.documentation, history: scoutState.history },
  };
  writeState(env.home, state);

  return { ok: true, runId, outcomes, state };
}

function guessScoutName(raw: unknown): ScoutName | null {
  if (raw && typeof raw === "object" && "scout" in raw) {
    const s = (raw as { scout?: unknown }).scout;
    if (s === "documentation" || s === "history") return s;
  }
  return null;
}
