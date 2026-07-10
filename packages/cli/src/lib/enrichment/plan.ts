// `enrich plan` builder: turns the local repo into an immutable OnboardingRun record.
// Three jobs (plan §5b, §8, §14): (1) rank documentation targets the doc scout should
// read; (2) prepare a bounded git-history allowlist + context for the history scout;
// (3) assemble + digest + persist the run record, pruning stale ones.
//
// The nondeterministic dependency (git) is injected as a GitRunner so the parsing and
// byte-bounding logic is unit-testable without a real repo, mirroring the scanner's
// injected-clock idiom. Identity/digest math lives in protocol.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { classifyTier, isCuratedDoc, type Tier } from "../scanner/score";
import {
  PROTOCOL_VERSION,
  computePlanDigest,
  defaultLimits,
  type DocumentationTarget,
  type EnrichmentLimits,
  type OnboardingRun,
  type PreparedGitEvidence,
  type PreparedGitFileChange,
} from "./protocol";

// Defensive per-commit caps (not pinned by §8, which bounds the total). Conservative.
const MAX_BODY_CHARS = 1000;
const MAX_CHANGED_FILES_PER_COMMIT = 100;

// Sentinels for single-pass `git log` parsing. Chosen to be vanishingly unlikely to
// appear at the start of a commit-message line; a collision would garble at most one
// commit (bounded, all downstream candidates are PENDING + human-rejectable anyway).
const COMMIT_MARK = "@@MLA-ENRICH-COMMIT@@";
const META_END_MARK = "@@MLA-ENRICH-ENDMETA@@";

export type GitRunner = (args: string[]) => string;

export function defaultGitRunner(repoRoot: string): GitRunner {
  return (args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface GitIdentity {
  headCommit: string | null; // `git rev-parse HEAD`: cross-machine snapshot key for the workspace gate
  rootCommit: string | null; // oldest root commit: repo identity, telemetry-only
}

// Read the git-native identity of the working snapshot for the workspace-grain gate.
// headCommit is the gate key (identical across clones of the same content); rootCommit
// is repo identity for telemetry. Both degrade to null on any failure (no git, empty
// repo) so a repo without usable git simply falls back to the local gate rather than
// throwing. A repo can have MULTIPLE root commits (grafted / merged histories); we take
// the last line deterministically since it is telemetry-only.
export function readGitIdentity(gitRunner: GitRunner): GitIdentity {
  let headCommit: string | null = null;
  try {
    const out = gitRunner(["rev-parse", "HEAD"]).trim().toLowerCase();
    headCommit = FULL_SHA.test(out) ? out : null;
  } catch {
    headCommit = null;
  }
  let rootCommit: string | null = null;
  try {
    const roots = gitRunner(["rev-list", "--max-parents=0", "HEAD"])
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => FULL_SHA.test(l));
    rootCommit = roots.length ? roots[roots.length - 1] : null;
  } catch {
    rootCommit = null;
  }
  return { headCommit, rootCommit };
}

// Within-target ordering band (lower is read first). T1 instruction files first; then,
// among T2, curated decision/instruction-adjacent docs (known doc names, ADR/RFC/spec
// dirs) ahead of arbitrary prose, so a tight target budget surfaces a repo's ADRs and
// package READMEs instead of spending slots on generic marketing .md that merely sorts
// early; T4 legacy notes last. Path breaks ties so the plan stays deterministic. T3 is
// grounding-only and never a target.
function targetBand(path: string, tier: Exclude<Tier, "T3">): number {
  if (tier === "T1") return 0;
  if (tier === "T4") return 3;
  return isCuratedDoc(path) ? 1 : 2; // T2: curated docs above generic prose
}

// Rank the doc targets the documentation scout should read: T1 instruction files first,
// then curated T2 decision docs, then generic prose, then T4 legacy notes; within a
// band, deterministic by path. T3 (grounding-only) and unclassified files are excluded.
// Capped to the limit.
export function buildDocumentationTargets(
  repoRoot: string,
  limit: number,
  gitRunner: GitRunner = defaultGitRunner(repoRoot),
): DocumentationTarget[] {
  let tracked: string[];
  try {
    tracked = gitRunner(["ls-files"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // not a git repo / git unavailable: no targets, never throw
  }

  const scored: { path: string; tier: Exclude<Tier, "T3"> }[] = [];
  for (const path of tracked) {
    const tier = classifyTier(path);
    if (!tier || tier === "T3") continue;
    scored.push({ path, tier });
  }
  scored.sort(
    (a, b) =>
      targetBand(a.path, a.tier) - targetBand(b.path, b.tier) || a.path.localeCompare(b.path),
  );

  return scored.slice(0, Math.max(0, limit)).map((s, i) => ({ path: s.path, tier: s.tier, rank: i + 1 }));
}

// Prepare a bounded slice of recent git history: the commit allowlist (full SHAs) plus
// enough context (subject, bounded body, changed paths + statuses, rename info) for the
// history scout to distil decisions. No raw unbounded logs (§8). Merge commits are
// skipped: their diffs are mechanical noise; authored commits carry the decisions.
// A bounded diff excerpt is intentionally omitted in the MVP (the scout reads files at
// HEAD); it is a future toggle.
export function prepareGitEvidence(
  repoRoot: string,
  opts: { maxScanCommits: number; maxSelectedCommits: number; maxBytes: number; gitRunner?: GitRunner },
): { evidence: PreparedGitEvidence[]; truncated: boolean } {
  const gitRunner = opts.gitRunner ?? defaultGitRunner(repoRoot);
  const scanCap = Math.max(0, opts.maxScanCommits);
  let raw: string;
  try {
    raw = gitRunner([
      "log",
      `-n`,
      String(scanCap),
      "--no-merges",
      "--date=iso-strict",
      "--name-status",
      `--pretty=format:${COMMIT_MARK}%n%H%n%cI%n%s%n%b%n${META_END_MARK}`,
    ]);
  } catch {
    return { evidence: [], truncated: false }; // empty history / not a repo: no evidence
  }

  // Scan a WIDE window (maxScanCommits) but inline only maxSelectedCommits (verdict item 7).
  // The byte budget SKIPS rather than HALTS: a single fat commit (huge body / many files)
  // no longer starves the rest, so the recency-ordered fill reaches deeper into the pool
  // and the scout sees more distinct decisions within the same byte budget. Selection stays
  // deterministic (recency order) and taste-free; substance ranking is a future toggle, not
  // built here. The first commit is always kept even if it alone exceeds the byte budget, so
  // a repo whose newest commit is oversized still yields evidence.
  const parsed = parseGitLog(raw);
  const evidence: PreparedGitEvidence[] = [];
  let bytes = 0;
  let truncated = false;

  for (const commit of parsed) {
    if (evidence.length >= opts.maxSelectedCommits) {
      truncated = true;
      break;
    }
    const size = Buffer.byteLength(JSON.stringify(commit), "utf8");
    if (bytes + size > opts.maxBytes && evidence.length > 0) {
      truncated = true;
      continue; // skip this oversized commit, keep filling from smaller later ones
    }
    bytes += size;
    evidence.push(commit);
  }
  // Truncated if anything in the scanned pool was dropped, OR the scan itself hit its
  // ceiling (there may be older commits the scan never reached).
  if (parsed.length > evidence.length || parsed.length >= scanCap) truncated = true;
  return { evidence, truncated };
}

// Single-pass parser for the sentinel-framed `git log --name-status` output above.
function parseGitLog(raw: string): PreparedGitEvidence[] {
  const lines = raw.split("\n");
  const out: PreparedGitEvidence[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== COMMIT_MARK) {
      i++;
      continue;
    }
    // header block: hash, committer ISO, subject, then body until META_END_MARK
    const commit = (lines[i + 1] ?? "").trim();
    const timestamp = (lines[i + 2] ?? "").trim();
    const subject = lines[i + 3] ?? "";
    i += 4;
    const bodyLines: string[] = [];
    while (i < lines.length && lines[i] !== META_END_MARK && lines[i] !== COMMIT_MARK) {
      bodyLines.push(lines[i]);
      i++;
    }
    if (lines[i] === META_END_MARK) i++; // consume the end marker
    // name-status lines until the next commit marker (or EOF); skip blanks
    const changedFiles: PreparedGitFileChange[] = [];
    while (i < lines.length && lines[i] !== COMMIT_MARK) {
      const line = lines[i];
      i++;
      if (!line.trim()) continue;
      if (changedFiles.length >= MAX_CHANGED_FILES_PER_COMMIT) continue;
      const parts = line.split("\t");
      const status = parts[0]?.trim();
      if (!status) continue;
      if (/^[RC]/.test(status) && parts.length >= 3) {
        changedFiles.push({ path: parts[2], status, renamedFrom: parts[1] });
      } else if (parts.length >= 2) {
        changedFiles.push({ path: parts[1], status });
      }
    }
    if (!commit) continue; // guard against a garbled record
    out.push({
      commit: commit.toLowerCase(),
      timestamp,
      subject,
      body: bodyLines.join("\n").trim().slice(0, MAX_BODY_CHARS),
      changedFiles,
    });
  }
  return out;
}

// Assemble the run record: compute the deadline from the injected clock + budget and the
// plan digest over the integrity-bearing content. Pure (clock + runId injected).
export function buildOnboardingRun(input: {
  runId: string;
  workspaceId: string;
  repositoryRoot: string;
  now: string; // ISO 8601
  limits?: EnrichmentLimits;
  documentationTargets: DocumentationTarget[];
  historyEvidence: PreparedGitEvidence[];
  headCommit?: string | null;
  rootCommit?: string | null;
}): OnboardingRun {
  const limits = input.limits ?? defaultLimits();
  const deadlineAt = new Date(Date.parse(input.now) + limits.budgetMs).toISOString();
  const partial = {
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    repositoryRoot: input.repositoryRoot,
    limits,
    documentationTargets: input.documentationTargets,
    historyEvidence: input.historyEvidence,
  };
  // headCommit/rootCommit are DELIBERATELY excluded from `partial`: computePlanDigest
  // pins the plan's commitments only, and the snapshot identity is orchestration
  // metadata, not a commitment. Two clones at the same HEAD but different paths still
  // produce different planDigests (repositoryRoot differs) yet the SAME headCommit,
  // which is exactly why the workspace gate keys on headCommit and not the digest.
  return {
    ...partial,
    runId: input.runId,
    createdAt: input.now,
    deadlineAt,
    planDigest: computePlanDigest(partial),
    headCommit: input.headCommit ?? null,
    rootCommit: input.rootCommit ?? null,
  };
}

// --- Persistence: ~/.meetless/workspaces/<ws>/onboarding-runs/<runId>.json ---------

export function runsDir(home: string, workspaceId: string): string {
  return join(home, "workspaces", workspaceId, "onboarding-runs");
}

export function runRecordPath(home: string, workspaceId: string, runId: string): string {
  return join(runsDir(home, workspaceId), `${runId}.json`);
}

export function writeRunRecord(home: string, run: OnboardingRun): string {
  const dir = runsDir(home, run.workspaceId);
  mkdirSync(dir, { recursive: true });
  const path = runRecordPath(home, run.workspaceId, run.runId);
  writeFileSync(path, JSON.stringify(run, null, 2), "utf8");
  return path;
}

export function loadRunRecord(home: string, workspaceId: string, runId: string): OnboardingRun | null {
  const path = runRecordPath(home, workspaceId, runId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OnboardingRun;
    if (parsed?.protocolVersion !== PROTOCOL_VERSION || parsed.runId !== runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Keep only the current active run record FOR THIS REPO; drop this repo's older ones
// (§5b: no run-history retention). A workspace can bind more than one repo (the Meetless
// monorepo and intel share one), so "older" must mean "same repo, different runId", never
// "any other run": deleting another repo's in-flight run would strand its resume/ingest.
// We compare repositoryRoot by realpath (symlink/`..` safe). Records we cannot read are
// left alone (harmless; ingest loads strictly by runId). The paired `<runId>.state.json`
// is dropped with its record so stale resume state never lingers.
export function pruneOldRuns(
  home: string,
  workspaceId: string,
  currentRunId: string,
  currentRepoRoot: string,
): number {
  const dir = runsDir(home, workspaceId);
  if (!existsSync(dir)) return 0;
  const currentRepoReal = safeRealpath(currentRepoRoot);
  let removed = 0;
  for (const name of readdirSync(dir)) {
    // Only run-record files (`<runId>.json`); skip state/candidates sidecars and the current
    // record. The `.candidates.json` skip is load-bearing: a sidecar carries a repositoryRoot
    // too, so without it prune would parse the sidecar as a run and delete the CURRENT run's
    // candidates (its runId differs from currentRunId, so the current-record skip misses it).
    if (
      !name.endsWith(".json") ||
      name.endsWith(".state.json") ||
      name.endsWith(".candidates.json") ||
      name === `${currentRunId}.json`
    )
      continue;
    const recordPath = join(dir, name);
    let sameRepo = false;
    try {
      const rec = JSON.parse(readFileSync(recordPath, "utf8")) as OnboardingRun;
      sameRepo = safeRealpath(rec.repositoryRoot) === currentRepoReal;
    } catch {
      continue; // unreadable / corrupt: leave it, do not risk deleting another repo's run
    }
    if (!sameRepo) continue;
    try {
      unlinkSync(recordPath);
      removed++;
    } catch {
      // best-effort cleanup; a leftover record is harmless (ingest loads by runId)
    }
    // Drop the paired resume-state + candidates sidecars, if any, so neither outlives its
    // record (a stale candidates sidecar would otherwise let `enrich accept` materialize a
    // pruned run's rules).
    const stem = name.slice(0, -".json".length);
    for (const sidecar of [`${stem}.state.json`, `${stem}.candidates.json`]) {
      try {
        unlinkSync(join(dir, sidecar));
      } catch {
        // no sidecar (run never ingested / never produced candidates) or already gone: skip
      }
    }
  }
  return removed;
}

// Build the run record in memory: scan the repo into targets + git evidence and assemble +
// digest the record. PURE of persistence (writes nothing, prunes nothing) so the command can
// compute the deterministic planDigest for the idempotency gate BEFORE deciding to persist.
export function buildPlan(input: {
  runId: string;
  workspaceId: string;
  repositoryRoot: string;
  now: string;
  budgetMs?: number;
  gitRunner?: GitRunner;
}): { run: OnboardingRun; historyTruncated: boolean } {
  const limits = defaultLimits(input.budgetMs);
  const gitRunner = input.gitRunner ?? defaultGitRunner(input.repositoryRoot);
  const documentationTargets = buildDocumentationTargets(input.repositoryRoot, limits.maxDocumentTargets, gitRunner);
  const { evidence: historyEvidence, truncated: historyTruncated } = prepareGitEvidence(input.repositoryRoot, {
    maxScanCommits: limits.maxHistoryScanCommits,
    maxSelectedCommits: limits.maxHistorySelectedCommits,
    maxBytes: limits.maxPreparedInputBytes,
    gitRunner,
  });
  const { headCommit, rootCommit } = readGitIdentity(gitRunner);
  const run = buildOnboardingRun({
    runId: input.runId,
    workspaceId: input.workspaceId,
    repositoryRoot: input.repositoryRoot,
    now: input.now,
    limits,
    documentationTargets,
    historyEvidence,
    headCommit,
    rootCommit,
  });
  return { run, historyTruncated };
}

// Persist a built run record: write it, then prune this repo's stale records. Split from
// buildPlan so the command can run the idempotency gate in between (build yields the digest;
// only a non-gated run commits to disk and prunes). Prune is here, not in buildPlan, so a
// gated re-run never deletes the prior completed record it is gating against.
export function persistPlan(home: string, run: OnboardingRun): { recordPath: string; pruned: number } {
  const recordPath = writeRunRecord(home, run);
  const pruned = pruneOldRuns(home, run.workspaceId, run.runId, run.repositoryRoot);
  return { recordPath, pruned };
}

// Orchestration helper for callers that always persist (buildPlan + persistPlan). Returns
// the run record (the command prints it as the plan envelope).
export function createPlan(input: {
  runId: string;
  workspaceId: string;
  repositoryRoot: string;
  home: string;
  now: string;
  budgetMs?: number;
  gitRunner?: GitRunner;
}): { run: OnboardingRun; recordPath: string; pruned: number; historyTruncated: boolean } {
  const { run, historyTruncated } = buildPlan(input);
  const { recordPath, pruned } = persistPlan(input.home, run);
  return { run, recordPath, pruned, historyTruncated };
}
