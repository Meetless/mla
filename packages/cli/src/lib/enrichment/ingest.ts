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
  normalizeExactSourceClaim,
  normalizeStatement,
  RECONCILIATION_FINDING_KIND,
  SCOUT_NAMES,
  DISPATCH_SCOUT_NAMES,
  scoutCandidateCap,
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
import { assertSafeRunId } from "../path-component";
import { INGEST_BATCH_SIZE } from "../intel-ingest-budget";

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

// How many documents ride in ONE kb-add POST.
//
// This number is a deadline, not a taste. Every document in a POST is embedded and indexed
// server-side before the response is written, so the request's cost scales with the batch,
// and past the wall the connection is severed mid-write no matter what either side intended.
//
// That is not hypothetical. On 2026-07-13 a pilot user's `mla onboard` sent every one of his
// documents in a single POST, hit the wall, and got nothing back. The run had no partial state
// to fall back on, so his rules died IN THE CLIENT and his workspace ended up with zero
// governed rules. He had to start over from nothing.
//
// The wall itself, and why this file used to name the wrong one, is documented once in
// `../intel-ingest-budget`. Do not re-derive it here: this constant was wrong for exactly as
// long as it carried its own copy of the reasoning.
export const PERSIST_BATCH_SIZE = INGEST_BATCH_SIZE;

// Two consecutive failed batches is the line between "one batch is poison" and "the
// server is down", and the two want opposite handling.
//
// A single failing batch must NOT abort the rest: if it did, a document that trips a
// server-side bug would strand every later batch behind it, and every rerun would strand
// them again at the same place. The run would never make progress. So we keep going, land
// what we can, and let the failed documents come back on the next run.
//
// But if intel really is down, "keep going" spends a full request budget per batch
// discovering the same outage over and over, and a large run would hang the CLI for many
// minutes before saying anything. Stop after the second consecutive failure and mark the
// remainder failed: they are retryable either way, and the operator gets the truth in minutes
// instead of tens of minutes.
const MAX_CONSECUTIVE_BATCH_FAILURES = 2;

export interface IngestEnv {
  home: string;
  workspaceId: string; // authoritative, derived by the command (not from the agent)
  repositoryRoot: string;
}

// One line of `git blame --line-porcelain`. `author*` only: mixing in the committer would
// attribute a rule to whoever last rebased the branch.
export interface BlamedLine {
  commit: string; // lowercased 40-char SHA
  authorName: string; // "" when git named none
  authorTime: string; // epoch seconds as git wrote them; "" when absent
}

// Filesystem + git probe for the impure candidate checks. Injectable for tests.
//
// The last three exist for the reconciliation finding, whose whole claim is historical and
// therefore unverifiable from the working tree: the quote has to come out of the repository at
// a pinned commit, and the ordering has to come out of git's ancestry graph. Each returns
// null/false on ANY failure rather than throwing, because an unprovable finding is dropped, not
// escalated: one unreadable document must not take the rest of the run down with it.
export interface FsProbe {
  repoRealpath: string;
  realpath(absPath: string): string; // throws if the path does not exist
  lineCount(absPath: string): number; // throws if the path does not exist
  isTracked(relPath: string): boolean; // present in `git ls-files` (exists at HEAD)
  // Content of `relPath` AS OF `commit`. null when the path did not exist there, which is what
  // makes an uncommitted document ineligible rather than silently quoted from the working tree.
  readFileAtCommit(commit: string, relPath: string): string | null;
  // Per-line blame of the inclusive 1-based range, as of `commit`. null on any failure.
  blameRange(commit: string, relPath: string, startLine: number, endLine: number): BlamedLine[] | null;
  // `git merge-base --is-ancestor`: true ONLY on a clean exit 0. Exit 1 (proven not an
  // ancestor) and any other failure (unresolvable) both return false, because both mean the
  // same thing here: the ordering was not proven, so the finding is not emitted.
  isAncestor(ancestor: string, descendant: string): boolean;
}

export interface IngestResult {
  ok: boolean;
  rejectionReason?: string; // top-level reject (unknown run, wrong ws/repo, bad digest/envelope)
  runId?: string;
  outcomes: ScoutIngestOutcome[];
  state?: OnboardingState;
  // Candidate ids of the doc/code inconsistencies that landed NEWLY on this call (design §9).
  // Returned rather than emitted here so the analytics append stays at the command boundary,
  // where the session and run context live; this module keeps doing persistence only.
  //
  // `noop_unchanged` findings are deliberately excluded: that outcome means the governed
  // document was already there, so counting it would restart the "time to first finding"
  // clock every time a repository re-onboards and would inflate the share metrics with
  // findings the operator has already seen.
  newFindingIds?: string[];
}

/**
 * Per-ROLE HARD cap, NO reallocation and NO shared pool (verdict item 8, revised).
 *
 * Each runnable scout gets exactly SCOUT_CANDIDATE_CAPS[role], INDEPENDENT of what any other
 * scout produced and independent of where the role sits in any list. `runnable` is the set of
 * scouts not already complete from a prior ingest; complete scouts get 0 (they are skipped in
 * the loop and counted via prior).
 *
 * The previous form dealt a scalar cap out of a shared `remainingTotal` in slot order. That
 * made array order part of the allocation contract and, with the caps summing exactly to the
 * total, guaranteed that any newly appended role received 0: dispatched, briefed, burning the
 * full history payload, returning findings, and silently discarded at ingest. Deriving
 * MAX_CANDIDATES_TOTAL from the caps makes the old backstop unreachable by construction, so
 * it is gone rather than left as decoration.
 */
function allocateScoutBudgets(runnable: Set<ScoutName>): Map<ScoutName, number> {
  const budget = new Map<ScoutName, number>();
  for (const role of SCOUT_NAMES) {
    budget.set(role, runnable.has(role) ? scoutCandidateCap(role) : 0);
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
          // The payload IS the finding. It rides the merge for the same reason kind and statement
          // do: nothing downstream can re-derive it. The scout process is gone by now, the results
          // file was a temp file, and the KB stores rendered markdown. Drop it here and the record
          // that reaches the sidecar is a finding that landed, was counted, and can never be
          // answered, because `isFinding` and every reader after it gate on this field.
          ...(c.inconsistency ? { inconsistency: c.inconsistency } : {}),
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

// Parse `git blame --line-porcelain`. Each blamed line opens with "<sha> <orig> <final>[ <n>]"
// and is followed by its full header block, then a TAB-prefixed copy of the source line.
// Matched on the exact "author " / "author-time " prefixes so "author-mail", "author-tz", and
// every "committer*" key are skipped rather than fuzzily absorbed.
function parseLinePorcelain(out: string): BlamedLine[] {
  const lines: BlamedLine[] = [];
  let current: BlamedLine | null = null;
  for (const raw of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(raw);
    if (header) {
      current = { commit: header[1].toLowerCase(), authorName: "", authorTime: "" };
      lines.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("author ")) current.authorName = raw.slice("author ".length).trim();
    else if (raw.startsWith("author-time ")) current.authorTime = raw.slice("author-time ".length).trim();
  }
  return lines;
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
    // `<rev>:<path>` is one argv element beginning with a validated 40-hex SHA, so the path can
    // never be read as an option, and a path with no leading "./" is resolved from the top of
    // the tree (the runner's cwd is the repo root regardless).
    readFileAtCommit: (commit, relPath) => {
      try {
        return gitRunner(["show", `${commit}:${relPath}`]);
      } catch {
        return null;
      }
    },
    // `--` before the path so a document named like a flag stays a path. -L is inclusive on
    // both ends, matching the evidence anchor's 1-based startLine/endLine.
    blameRange: (commit, relPath, startLine, endLine) => {
      try {
        const out = gitRunner(["blame", commit, "--line-porcelain", "-L", `${startLine},${endLine}`, "--", relPath]);
        const parsed = parseLinePorcelain(out);
        return parsed.length > 0 ? parsed : null;
      } catch {
        return null;
      }
    },
    isAncestor: (ancestor, descendant) => {
      try {
        gitRunner(["merge-base", "--is-ancestor", ancestor, descendant]);
        return true; // exit 0
      } catch {
        return false; // exit 1 (not an ancestor) or anything else (unresolvable): same verdict
      }
    },
  };
}

// --- impure candidate verification (shape already validated upstream) -------------

// The one normalization applied to a claimed repo-relative path before it is compared with
// anything: git speaks forward slashes and never a leading "./", so a path that differs only
// that way is the same path. Traversal is NOT normalized away here; it is rejected by the
// caller, because silently absorbing ".." is how a containment check gets talked out of its job.
function normalizeEvidencePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

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
  const norm = normalizeEvidencePath(raw);
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

const FULL_SHA = /^[0-9a-f]{40}$/;
// git's "not committed yet" sentinel. A blamed line carrying it names no commit at all, so it
// can anchor no ordering.
const NULL_SHA = "0".repeat(40);

// Epoch seconds as git wrote them, rendered for display. Returns undefined on anything
// unparseable rather than inventing a date: attribution is courtesy, and a wrong timestamp on a
// governance artifact is worse than a missing one.
function isoFromEpochSeconds(raw: string): string | undefined {
  if (!/^\d{1,15}$/.test(raw)) return undefined;
  const ms = Number(raw) * 1000;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Prove the historical half of a doc_code_inconsistency, the half no shape check can reach.
 *
 * Shape validation established that the finding is internally coherent: the status letter proves
 * the claim class, the changed path sits inside the claim's scope. This establishes that it is
 * TRUE OF THIS REPOSITORY, and it is the only reason the finding is allowed to exist:
 *
 *   1. the claimed change is the change the CLI itself read out of that commit, field for field;
 *   2. the claimed quote is really in that document, read out of the repository at headCommit
 *      rather than out of the working tree or out of the model;
 *   3. the document ALREADY SAID IT when the commit landed, proven by ancestry, never by dates.
 *
 * (3) is the whole argument. A historical commit and a current document are not automatically
 * inconsistent: a commit that predates the rule broke nothing, and reporting it as a violation
 * teaches the reader that these findings are noise. Every unprovable branch below therefore
 * rejects this ONE candidate and lets the run continue. Zero findings beats a plausible one.
 */
// Occurrences of `needle` in `haystack`, counting OVERLAPPING ones (advance by one, not by the
// needle's length). A repeated rule is ambiguous however its copies overlap, and the stricter
// count can only reject more.
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
}

function verifyInconsistency(
  candidate: EnrichmentCandidate,
  run: OnboardingRun,
  probe: FsProbe,
  push: (code: string, message: string) => void,
): void {
  const inc = candidate.inconsistency;
  if (!inc) return; // shape validation guarantees this for the kind; nothing to prove without it

  // Everything below is read AS OF headCommit: the quote, the blame, and the ancestry all have
  // to describe one snapshot or they describe nothing. A run recorded without one (git was
  // unavailable at plan time) cannot host a finding, and fails closed rather than falling back
  // to the working tree, where an uncommitted edit would read as a governed rule.
  const headCommit = (run.headCommit ?? "").toLowerCase();
  if (!FULL_SHA.test(headCommit)) {
    push("no_head_commit", "the run has no recorded headCommit, so no document snapshot can be verified");
    return;
  }

  const docAnchor = candidate.evidence.find((e): e is Extract<EnrichmentEvidence, { type: "file" }> => e.type === "file");
  const commitAnchor = candidate.evidence.find(
    (e): e is Extract<EnrichmentEvidence, { type: "commit" }> => e.type === "commit",
  );
  if (!docAnchor || !commitAnchor) return; // REQUIRED_ANCHOR_TYPES already rejected this
  const sha = resolveAllowedCommit(commitAllowlist(run), commitAnchor.commit);
  if (sha === null) return; // already rejected as commit_not_in_allowlist by the caller
  const docPath = normalizeEvidencePath(docAnchor.path);

  // 1. The claimed change against the change the CLI prepared. The scout was SHOWN this line and
  // asked to copy it, so any difference is either a transcription error or an invention; neither
  // is a finding. Compared field for field (DivergenceFileChange is a projection of the prepared
  // shape, so a new field lands on both sides and cannot slip past this unnoticed).
  const prepared = run.historyEvidence.find((e) => e.commit.toLowerCase() === sha);
  const change = prepared?.changedFiles.find((f) => f.path === inc.divergence.path);
  if (!change) {
    push(
      "divergence_not_in_commit",
      `commit ${sha.slice(0, 12)} did not change "${inc.divergence.path}" according to the plan's own evidence`,
    );
    return;
  }
  if (change.status !== inc.divergence.status || (change.renamedFrom ?? "") !== (inc.divergence.renamedFrom ?? "")) {
    push(
      "divergence_mismatch",
      `claimed change does not match the plan's evidence for ${sha.slice(0, 12)}: ` +
        `claimed ${JSON.stringify(inc.divergence)}, recorded ${JSON.stringify(change)}`,
    );
    return;
  }

  // 2. The claimed quote against the document AS OF headCommit. Normalizing both sides collapses
  // whitespace and line endings and NOTHING else, so a re-wrapped paragraph still matches while a
  // paraphrase, a softened "should" for "must", or a dropped "not" does not.
  const snapshot = probe.readFileAtCommit(headCommit, docPath);
  if (snapshot === null) {
    push("doc_not_at_head", `"${docPath}" does not exist at the run's headCommit; an uncommitted document cannot anchor a finding`);
    return;
  }
  const snapLines = snapshot.replace(/\r\n?/g, "\n").split("\n");
  if (docAnchor.endLine > snapLines.length) {
    push(
      "line_out_of_range_at_head",
      `endLine ${docAnchor.endLine} exceeds "${docPath}" at headCommit (${snapLines.length} lines)`,
    );
    return;
  }
  const windowText = (from: number, to: number): string =>
    normalizeExactSourceClaim(snapLines.slice(from - 1, to).join("\n"));
  const anchoredRange = windowText(docAnchor.startLine, docAnchor.endLine);
  const quote = normalizeExactSourceClaim(inc.claimText);
  const hits = quote.length === 0 ? 0 : countOccurrences(anchoredRange, quote);
  if (hits === 0) {
    push(
      "claim_not_in_document",
      `claimText is not a verbatim quote of ${docPath}#L${docAnchor.startLine}-L${docAnchor.endLine} at headCommit`,
    );
    return;
  }
  if (hits > 1) {
    // Two occurrences are two candidate origins with two possible blames, and picking either
    // asserts an ancestry the CLI cannot prove. A narrower anchor makes this finding provable.
    push(
      "ambiguous_claim_occurrence",
      `claimText occurs ${hits} times in ${docPath}#L${docAnchor.startLine}-L${docAnchor.endLine}; anchor the one occurrence`,
    );
    return;
  }
  // Persist the CLI-verified span, not the model's string. They are byte-identical here (that is
  // what the substring check just established), which is precisely why overwriting is safe and
  // why what lands in the artifact is provably the document's own words.
  inc.claimText = quote;

  // The MINIMAL line span still containing that one occurrence. A scout quoting one sentence
  // routinely anchors the paragraph around it, and blaming the paragraph attributes the rule to
  // whoever last touched any neighbouring line: one unrelated edit anywhere in the anchor makes
  // the range span two commits and drops a provable finding as `ambiguous_claim_origin`. The
  // walk is safe because the occurrence is unique: the set of start lines whose window still
  // holds it is a prefix, so the last one that holds is where the quote begins.
  let claimStart = docAnchor.startLine;
  while (claimStart < docAnchor.endLine && windowText(claimStart + 1, docAnchor.endLine).includes(quote)) {
    claimStart += 1;
  }
  let claimEnd = claimStart;
  while (claimEnd < docAnchor.endLine && !windowText(claimStart, claimEnd).includes(quote)) {
    claimEnd += 1;
  }

  // 3. Ancestry. The doc-anchor commit is the one that last touched the quoted range; one blame
  // call yields both it and the attribution. Failure drops this finding, never the run.
  const blamed = probe.blameRange(headCommit, docPath, claimStart, claimEnd);
  if (!blamed || blamed.length === 0) {
    push("blame_unavailable", `git could not blame ${docPath}#L${claimStart}-L${claimEnd} at headCommit`);
    return;
  }
  const distinct = [...new Set(blamed.map((l) => l.commit))];
  if (distinct.length !== 1) {
    // Picking one of several would mean ordering them, and the only cheap ordering is by date,
    // which is display metadata precisely because it is rebase- and author-controlled. A narrower
    // anchor (quote the one sentence) makes this finding provable; guessing does not.
    push(
      "ambiguous_claim_origin",
      `${docPath}#L${claimStart}-L${claimEnd} spans ${distinct.length} commits, so no single commit can be shown to predate the change`,
    );
    return;
  }
  const claimCommit = distinct[0];
  if (claimCommit === NULL_SHA) {
    push("claim_not_committed", "the anchored range is not committed, so it cannot be shown to predate anything");
    return;
  }
  // `--is-ancestor X X` exits 0, so without this a single commit that wrote the rule AND made the
  // change would "prove" it violated itself. That is not an unpropagated change, it is one commit
  // doing two things, and it is the reader's first false positive.
  if (claimCommit === sha) {
    push("claim_and_change_same_commit", `the rule and the change landed in the same commit (${sha.slice(0, 12)})`);
    return;
  }
  if (!probe.isAncestor(claimCommit, sha)) {
    // Exit 1 (the rule is NOT an ancestor: it landed after the change, so the change broke
    // nothing) and an unresolvable graph both arrive here, because both mean the same thing:
    // the ordering was not proven.
    push(
      "claim_not_proven_older",
      `${claimCommit.slice(0, 12)} (which wrote the quoted rule) is not a proven ancestor of ${sha.slice(0, 12)}`,
    );
    return;
  }

  // Verified. Stamp the attribution the CLI derived; the person and the time are courtesy fields
  // and are omitted rather than guessed, which is why they sit outside the finding's identity.
  const line = blamed[0];
  inc.attribution = {
    commit: claimCommit,
    ...(line.authorName ? { authorName: line.authorName } : {}),
    ...(isoFromEpochSeconds(line.authorTime) ? { authorTime: isoFromEpochSeconds(line.authorTime) } : {}),
  };
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
  // Only after the anchors themselves hold: the historical proof reads the document at the
  // anchored range, so running it over a path that failed containment would be verifying a
  // quote from a file we already refused to trust.
  if (candidate.kind === RECONCILIATION_FINDING_KIND && errors.length === 0) {
    verifyInconsistency(candidate, run, probe, push);
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
// The display/ranking title for a candidate note, derived from its own statement.
//
// P4 (session d50582e9, F6): every onboarding note used to render a literal `# Candidate`
// H1, and the server derives a note's title from its first H1 (ldm_markdown._extract_title)
// when no frontmatter `title:` is present. So the entire onboarding corpus was titled
// "Candidate", which is useless for ranking and for display. The title MUST come from the
// body, not the frontmatter: the frontmatter here is a closed-vocabulary machine header (no
// user/agent free text) precisely so the reconciliation scanners never trip on it, so a
// free-text `title:` key would break that invariant.
//
// Deterministic and semantics-free, exactly like the id and the slug: collapse the statement
// to one line, keep the first sentence when it reads as a title on its own, otherwise cut at
// a word boundary. NO LLM, no summarization. It does NOT touch identity: `candidateId` hashes
// kind + statement + anchors and never the title, so a better H1 leaves the id and the relPath
// unchanged, and only NEW renders (or a re-mint of the same identity) pick it up. An empty
// statement (which validation forbids, but render must never throw) falls back to the kind.
const CANDIDATE_TITLE_MAX = 72;

export function candidateTitle(candidate: MergedCandidate): string {
  const norm = normalizeStatement(candidate.statement);
  if (norm.length === 0) return `Onboarding candidate (${candidate.kind})`;
  const firstSentence = norm.match(/^.*?[.!?](?=\s|$)/)?.[0]?.trim();
  const base =
    firstSentence && firstSentence.length <= CANDIDATE_TITLE_MAX
      ? firstSentence.replace(/[.!?]+$/, "")
      : norm;
  if (base.length <= CANDIDATE_TITLE_MAX) return base;
  const cut = base.slice(0, CANDIDATE_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
  return `${trimmed}…`;
}

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
  // The H1 is the note's display/ranking title (the server reads it as the title when no
  // frontmatter title exists). Derived from the statement so it is never the useless
  // "Candidate" literal; the full statement still follows in full below.
  body.push(`# ${candidateTitle(candidate)}`);
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
  return join(runsDir(home, workspaceId), `${assertSafeRunId(runId)}.state.json`);
}

export function loadState(home: string, workspaceId: string, runId: string): OnboardingState | null {
  const path = statePath(home, workspaceId, runId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OnboardingState;
    // A v1 file is deliberately unreadable, not upgraded: v1's `complete` could mean "landed
    // nothing and is stranded". Reading null re-runs the scouts, which is the recovery.
    if (parsed?.schemaVersion !== 2) return null;
    // A state file is only valid for the run it names: ignore one whose stored runId
    // drifted from its path (corruption / hand-edit), rather than resuming the wrong run.
    if (parsed.runId !== runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(home: string, state: OnboardingState): void {
  // Through runsDir, not an inline join: the mkdir must never precede the id validation, or a
  // malformed workspaceId would materialize a directory outside the state root before the
  // builder below got the chance to refuse it.
  const dir = runsDir(home, state.workspaceId);
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
  return join(runsDir(home, workspaceId), `${assertSafeRunId(runId)}.candidates.json`);
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
  for (const c of incoming.candidates) {
    // A later ingest must never UN-resolve a finding a human already closed. Ingest rewrites a
    // record in place (that is how a resuming scout refreshes its landed outcome) and it has no
    // opinion about resolution, so a prior verdict is carried across rather than silently dropped.
    const prior = byId.get(c.candidateId);
    byId.set(c.candidateId, prior?.resolution && !c.resolution ? { ...c, resolution: prior.resolution } : c);
  }
  const merged: OnboardingCandidatesSidecar = {
    schemaVersion: 1,
    workspaceId: incoming.workspaceId,
    runId: incoming.runId,
    repositoryRoot: incoming.repositoryRoot,
    updatedAt: incoming.updatedAt,
    candidates: [...byId.values()],
  };
  // Through runsDir (same reason as writeState): `incoming` is a PARSED PAYLOAD, so its
  // workspaceId and runId are the least trustworthy ids on this path and must not reach a
  // mkdir before they are validated.
  const dir = runsDir(home, incoming.workspaceId);
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
  // The ONBOARDING roster this run dispatched (defaults to the compile-time
  // DISPATCH_SCOUT_NAMES). Not a runtime switch: nothing at run time can select it, the
  // production call sites take the default, and the parameter exists so the retirement of
  // a scout is testable against real run records BEFORE the constant is edited. Note the
  // asymmetry that makes retirement safe: `scoutState` is still keyed by the full PARSE
  // roster (SCOUT_NAMES), so a pre-retirement run's slots survive a reload untouched, but
  // only roster members are runnable, budgeted, or counted toward completion.
  dispatchRoster?: readonly ScoutName[];
}): Promise<IngestResult> {
  const { env, request, persist, now } = input;
  const dispatchRoster = input.dispatchRoster ?? DISPATCH_SCOUT_NAMES;

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
  // Built by mapping SCOUT_NAMES, not by hand: a hand-written literal here is exactly the
  // shape that goes stale when a role is added, and the compiler only catches it because the
  // annotation is a TOTAL Record. Deriving it removes the chance entirely.
  const scoutState = Object.fromEntries(
    SCOUT_NAMES.map((role) => [role, prior?.scouts[role] ?? emptyScoutState()]),
  ) as Record<ScoutName, ScoutRunState>;

  const outcomes: ScoutIngestOutcome[] = [];

  // Runnable scouts = every role not already complete from a prior ingest. Each gets its own
  // independent per-ROLE cap (no reallocation, no shared pool, no order sensitivity); the cap
  // does NOT depend on what any scout actually sent, so a low-producing scout never frees
  // capacity for another and an appended role can never allocate zero.
  const runnable = new Set<ScoutName>(
    dispatchRoster.filter((s) => scoutState[s].status !== "complete"),
  );
  const budget = allocateScoutBudgets(runnable);

  // Phase 1: validate + cap each scout, but persist NOTHING yet. A scout that completed in a
  // prior ingest, reported it did not finish, or arrived malformed is resolved in-loop (it
  // contributes no accepted candidates); every complete scout's accepted set is collected so
  // Phase 2 can merge exact duplicates across ALL scouts before a single POST.
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

    // A result for a role this run never dispatched. Reachable two ways: a stale agent
    // still installed in someone's home dir, or a hand-rolled ingest envelope. Refuse it
    // BEFORE any state read or budget lookup: the slot may not exist in the roster at all,
    // and accepting it would spend a retired scout's cap and re-open a closed surface.
    if (!dispatchRoster.includes(scout)) {
      outcomes.push({
        scout,
        received: result.candidates.length,
        accepted: 0,
        rejected: 0,
        persisted: 0,
        deduped: 0,
        errors: [
          {
            index: -1,
            code: "scout_not_dispatched",
            message: `the ${scout} scout was not dispatched by this run; its result is ignored`,
          },
        ],
      });
      continue;
    }

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
          // Name only THIS role's cap. The old message also quoted a shared run total, which
          // implied the drop might be someone else's fault; caps are now per-role and nothing
          // another scout did can change this number.
          message: `per-scout candidate cap reached; the ${result.scout} scout's cap is ${scoutBudget}`,
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
  // statement more than one scout surfaced becomes ONE governed document citing all of them,
  // instead of near-identical docs the reviewer must reconcile. Merge is anchor-insensitive (keyed
  // by kind + normalized statement) so it also collapses a scout that emitted the same
  // statement twice; it is scoped to THIS call only, so a resuming scout (whose candidates
  // arrive after the other is already complete) never folds across calls.
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

  // Persist in BOUNDED batches, and never let one failure erase what already landed.
  //
  // This used to be a single POST carrying the whole run, justified as "one POST so the run
  // has a single persistence outcome". That symmetry is what destroyed a pilot user's
  // onboarding: one POST also means one timeout, one 504, and one all-or-nothing loss of
  // every document, including the ones the server had already indexed. A run's persistence
  // is not atomic on the server (kb-add reports a per-document receipt precisely because it
  // is not), so pretending it is atomic on the client buys nothing and costs everything.
  //
  // Each batch is now independent. A batch that fails marks ONLY its own documents "failed",
  // which is the same signal the server already sends for a per-document failure, so those
  // documents flow into the `docFailedByScout` path below: the scout is left retryable, the
  // run stays `partial`, and a rerun re-POSTs them. Documents that DID land re-POST as an
  // idempotent `noop_unchanged`, so the retry is cheap and the progress is monotonic.
  //
  // `persistFailed` (the whole-run, nothing-landed fate) is now reserved for what it actually
  // means: every batch failed. A run that lands 30 of 40 documents is a PARTIAL run that
  // resumes, not a total loss that starts over.
  const outcomeByPath = new Map<string, PersistOutcome>();
  const persistErrors: string[] = [];
  let batchesAttempted = 0;
  let batchesLanded = 0;
  let consecutiveFailures = 0;

  for (let start = 0; start < docs.length; start += PERSIST_BATCH_SIZE) {
    const batch = docs.slice(start, start + PERSIST_BATCH_SIZE);

    if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
      // The server is not answering. Do not spend another timeout to prove it. These
      // documents are marked failed, which makes them retryable, exactly as if we had
      // tried and been refused.
      for (const d of batch) outcomeByPath.set(d.relPath, "failed");
      continue;
    }

    batchesAttempted += 1;
    try {
      const res = await persist(batch);
      // The server returns one outcome per document in input order; a length mismatch is a
      // contract violation we refuse to interpret (it would mis-attribute outcomes), so treat
      // it as a failure of this batch rather than silently report a partial, wrong tally.
      if (res.docs.length !== batch.length) {
        throw new Error(`kb-add returned ${res.docs.length} outcome(s) for ${batch.length} document(s)`);
      }
      batch.forEach((d, i) => outcomeByPath.set(d.relPath, res.docs[i].outcome));
      batchesLanded += 1;
      consecutiveFailures = 0;
    } catch (e) {
      // Carry the REAL message (the 524, the 504, the timeout, the connection reset). The
      // user who lost his rules was told nothing at all about why; a generic "persistence
      // failed" is how a request ceiling stays invisible for a day. Which ceiling it was is
      // the whole diagnosis: a 524 is the edge, a 504 is the origin, and they are 200s apart.
      persistErrors.push(e instanceof Error ? e.message : String(e));
      for (const d of batch) outcomeByPath.set(d.relPath, "failed");
      consecutiveFailures += 1;
    }
  }

  // Nothing landed at all: the run made zero progress, and every scout that offered a
  // candidate shares that fate. This is the ONLY case that is still all-or-nothing, and it
  // is all-or-nothing because it genuinely is, not because we posted it that way.
  const persistFailed = batchesAttempted > 0 && batchesLanded === 0;
  // Distinct messages only: five batches timing out against a wedged server produce five
  // identical strings, and repeating them tells the operator nothing the first one did not.
  const persistErrorMessage = [...new Set(persistErrors)].join("; ");

  // Tally each scout's landed documents by REAL server outcome: newly minted ("ingested") vs
  // already governed and unchanged ("noop_unchanged"). A doc shared by several scouts counts
  // toward each: the union truly carries each one's evidence. A doc the server reported
  // "failed" (a 200 carrying a per-document failure) landed for neither and is surfaced as an
  // error below. This split is what makes idempotency visible: a re-run of an unchanged repo
  // reports every doc as already-present, not as freshly persisted.
  const zeroPerScout = (): Record<ScoutName, number> =>
    Object.fromEntries(SCOUT_NAMES.map((role) => [role, 0])) as Record<ScoutName, number>;
  const newByScout = zeroPerScout();
  const dedupedByScout = zeroPerScout();
  const docFailedByScout = zeroPerScout();
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
  // one transactional result). `persisted` is the count of the scout's merged documents that
  // landed born PENDING (new + already-present); `deduped` is how many of those were already
  // present.
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
        // Append the transport cause when there was one. A batch that timed out and a
        // document the server refused both land here, and they are not the same problem:
        // the first is ours to fix, the second is the payload's. Saying only "could not
        // persist" is what left a severed request undiagnosed for a day.
        message:
          `${docFailed} document(s) the server could not persist; rerun ingest to retry` +
          (persistErrorMessage ? ` (${persistErrorMessage})` : ""),
      });
      scoutState[b.scout] = {
        status: "persistence_failed",
        error: `${docFailed} document(s) could not persist`,
      };
    } else if (b.received > 0 && b.accepted.length === 0) {
      // The scout put candidates on the wire and landed NONE of them: every one was rejected
      // on shape or evidence verification. That is zero progress, not completion, and the
      // scout's payload is by definition malformed. Stamping it `complete` here (which this
      // branch once did, since nothing was offered to persist and so nothing could fail to
      // persist) strands the scout forever: resume skips a complete scout with
      // `already_complete` and never re-reads it, so the corrected candidates can never be
      // ingested under this run. `malformed` keeps it retryable, which is what a rerun with
      // fixed candidates needs. Note the guard is `received > 0`, NOT `accepted === 0`: a
      // scout that legitimately found nothing worth governing sends zero candidates and IS
      // done, and must stay `complete` or the run never settles and the run-level
      // idempotency gate (findCompletedRunWithDigest) re-runs a finished onboarding forever.
      errors.push({
        index: -1,
        code: "all_candidates_rejected",
        message: `all ${b.received} candidate(s) were rejected; scout stays retryable, rerun ingest with corrected candidates`,
      });
      scoutState[b.scout] = {
        status: "malformed",
        error: `all ${b.received} candidate(s) rejected`,
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

  // Persist the accept half's durable record: the post-merge candidates this call actually
  // LANDED, so `enrich accept` can later materialize the durable ones (constraint /
  // convention / boundary) into .meetless/rules.md. Skip when nothing landed (the retry
  // rewrites) and when there is nothing to add (an empty or already-complete scout), so a
  // no-op call never churns the sidecar. upsert MERGES with any prior sidecar, so a resuming
  // second scout appends to the first scout's candidates rather than replacing them, and a
  // batch that lands on the SECOND run joins the ones that landed on the first.
  const records: OnboardingCandidateRecord[] = [];
  if (!persistFailed && merged.size > 0) {
    for (const m of merged.values()) {
      const relPath = candidateRelPath(m);
      const landed = outcomeByPath.get(relPath);
      // ONLY what actually landed. `enrich accept` materializes a durable candidate from this
      // sidecar into .meetless/rules.md and filters on KIND, not on outcome, so a candidate
      // recorded here with landed="failed" would become a local rule with NO governed document
      // behind it: precisely the stale-local-assumption this product exists to prevent, minted
      // by the product itself. It never landed, so it is not in the record of what landed.
      //
      // Dropping it loses nothing. Its scout is left retryable by the persistence_partial path
      // above, and upsertCandidatesSidecar MERGES, so the rerun that finally persists the
      // document adds it to this same sidecar alongside its siblings.
      if (landed !== "ingested" && landed !== "noop_unchanged") continue;
      records.push({
        candidateId: candidateId(m),
        kind: m.kind,
        statement: m.statement,
        evidence: m.evidence,
        sourceScouts: [...m.sourceScouts],
        rationale: m.rationale ?? null,
        rationaleSource: m.rationaleSource ?? null,
        relPath,
        landed,
        // The verified payload, carried verbatim from the candidate this CLI proved: the
        // normalized quote `verifyInconsistency` overwrote onto the wire string, the attribution
        // it derived from blame over the minimal span, the parser-stamped `proposedRuleKind`, and
        // the divergence. `mla enrich resolve` runs LATER, in another session, with only this
        // sidecar to read; without the payload the three-way choice has nothing to offer and
        // `isFinding` is false, so the finding is invisible to the very surface built to close it.
        ...(m.inconsistency ? { inconsistency: m.inconsistency } : {}),
      });
    }
  }
  // `records` can be empty even when a batch landed: a 200 can carry per-document failures for
  // every doc it was given. Writing an empty candidate list would be a churn of the sidecar
  // that says nothing, so hold the write for a call that actually has something to record.
  if (records.length > 0) {
    upsertCandidatesSidecar(env.home, {
      schemaVersion: 1,
      workspaceId: env.workspaceId,
      runId,
      repositoryRoot: env.repositoryRoot,
      updatedAt: now,
      candidates: records,
    });
  }

  // Completion is judged over the DISPATCHED roster, not every slot that exists. Judging it
  // over SCOUT_NAMES would leave every post-retirement run "partial" forever (the retired
  // slot can never reach "complete" because nothing dispatches it), which in turn disables
  // the plan-digest reuse gate that only trusts a "complete" state.
  const allComplete = dispatchRoster.every((s) => scoutState[s].status === "complete");
  const state: OnboardingState = {
    workspaceId: env.workspaceId,
    runId,
    repositoryRoot: env.repositoryRoot,
    schemaVersion: 2,
    status: allComplete ? "complete" : "partial",
    updatedAt: now,
    // scoutState is already the total per-role record this run computed; re-listing the roles
    // here would have silently dropped any role not named, so the resume state would forget a
    // completed scout and re-run it forever.
    scouts: scoutState,
  };
  writeState(env.home, state);

  // The findings this call newly landed, in sidecar order. Filtered on `landed === "ingested"`
  // (not merely "is a finding") so the §9 clock starts on the run that actually surfaced it.
  const newFindingIds = records
    .filter((r) => r.kind === RECONCILIATION_FINDING_KIND && r.landed === "ingested")
    .map((r) => r.candidateId);

  return { ok: true, runId, outcomes, state, newFindingIds };
}

// Attribute a MALFORMED envelope to a slot so it can be retried. Membership is tested against
// SCOUT_NAMES, not a hand-written pair of literals: an `s === "documentation" || s ===
// "history"` test compiles forever, so a third scout's malformed envelope would have been
// unattributable, its slot would never be stamped `malformed`, and the run would report that
// scout as never having run at all.
function guessScoutName(raw: unknown): ScoutName | null {
  if (raw && typeof raw === "object" && "scout" in raw) {
    const s = (raw as { scout?: unknown }).scout;
    if (typeof s === "string" && (SCOUT_NAMES as readonly string[]).includes(s)) {
      return s as ScoutName;
    }
  }
  return null;
}
