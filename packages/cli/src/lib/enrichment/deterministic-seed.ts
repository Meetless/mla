// src/lib/enrichment/deterministic-seed.ts
//
// The bind-time deterministic corpus seed (P0-1 of
// notes/20260805-onboarding-reachability-and-aha-proposal.md, as corrected by An's review on
// 2026-08-06).
//
// WHAT IT FIXES, measured in production 2026-08-05: 24 workspaces ran the injection hook 459
// times and received nothing. Their `retrieve_knowledge` answers every query with silence, and
// the only door to a corpus (`/mla onboard`) requires a human to type a command inside a session
// that 29 of 31 workspaces never typed. This module makes a corpus exist with no agent, no model
// token, and no human in the loop.
//
// WHAT IT DELIBERATELY DOES NOT DO, and why each boundary is load-bearing:
//
//   - It does not extract or paraphrase RULES. It uploads the file's bytes verbatim. The scanner
//     already owns a mature directive extractor (`parseDirectivesFromMarkdown`), and pointing it
//     at the KB would mint model-shaped claims out of a deterministic path. A seed is a copy.
//
//   - It does not touch the INJECTION lane. A repo's `CLAUDE.md` is excluded from the floor on
//     purpose (`isFloorRule`, render.ts): Claude Code already loads CLAUDE.md natively, so
//     injecting it back would be pure duplication -- exactly the redundancy `7f0f4f1cb` measured
//     at 94.7% and removed. The gap this closes is RETRIEVAL, where that content genuinely is
//     absent: the KB has never held it, so `retrieve_knowledge` cannot answer from it.
//
//   - It accepts nothing. Every document lands born PENDING, forced SERVER-side by the kb-add
//     route. Nothing in this file can change a trust state. That still delivers value on the
//     retrieval surface, because PENDING claims SERVE: `_DEFAULT_STATUS_FILTER = ("ACCEPTED",
//     "PENDING")` in intel's `search_claims.py`, whose docstring is the law ("grounded provisional
//     evidence is READABLE on every surface"). Serving and trust are two different gates, and only
//     the trust gate needs a human.
//
//   - It seeds T1 ONLY (`isInstructionFile`): CLAUDE.md, AGENTS.md, GEMINI.md,
//     copilot-instructions.md, .claude/rules/*, .cursor/rules/*. A README explains, a CONTRIBUTING
//     describes process, an ADR carries history and superseded alternatives. Only a file whose
//     declared purpose is instructing an agent is safe to seed unread; the rest is what the
//     agentic scouts are for.
import { createHash } from "node:crypto";
import { isInstructionFile } from "../scanner/score";
import { normalizedContentHash } from "../scanner/content-normalization";
import type { PersistDocument, PersistOutcome } from "./ingest";

/**
 * The KB identity root for seeded instruction files. The server prefixes the single `notes/`
 * identity root, so a seeded root CLAUDE.md is governed as `notes/repo-instructions/<repo>/CLAUDE.md`.
 * A distinct namespace keeps the deterministic seed separable from `onboarding/` (the scouts'
 * candidates) and from a human's real notes, which matters for both review and any later sweep.
 */
export const SEED_NAMESPACE = "repo-instructions";

/**
 * The per-repository batch cap. A monorepo keeps one CLAUDE.md per package (this repo's scanner
 * comment says so explicitly), so the count is unbounded in principle. An's kill criterion for
 * P0-1 is an acceptance rate below one in ten, and a review queue nobody drains is worse than an
 * empty corpus because it also costs attention -- so the cap is a product bound, not a perf one.
 */
export const MAX_SEED_FILES = 25;

/**
 * Per-file size ceiling, matching the scanner's own `MAX_FILE_BYTES`. A 256KB instruction file is
 * not an instruction file, and this path runs on SessionStart where the whole budget is a moment.
 */
export const MAX_SEED_FILE_BYTES = 256 * 1024;

/** Why a T1 file present in the checkout was not seeded. Always reported, never silent. */
export type SeedSkipReason = "unreadable" | "too_large" | "empty" | "cap";

export interface SeedSkip {
  repoPath: string;
  reason: SeedSkipReason;
}

export interface SeedCandidate {
  /** Repo-relative path as `git ls-files` reports it, e.g. `apps/control/CLAUDE.md`. */
  repoPath: string;
  /** Vault-relative KB identity the kb-add route governs (it prefixes `notes/`). */
  relPath: string;
  /** The file's bytes, verbatim. Never a paraphrase, never an extract. */
  content: string;
  /** `content-normalization-v1` digest, the idempotency key. */
  digest: string;
}

/**
 * The local record of what this checkout has already seeded, keyed by repo-relative path.
 *
 * Written per-ROOT, never per-workspace. One workspace id can be bound by several `.meetless.json`
 * markers (this dogfood workspace is bound by three), and a workspace-keyed file is last-writer-wins
 * across roots -- the exact shape of the 2026-07-28 and 2026-08-02 scan-cache poisonings.
 */
export interface SeedReceiptEntry {
  /** `content-normalization-v1` digest of the bytes we last successfully synchronized. */
  digest: string;
  /**
   * The governed documentId. Recorded so a file that later LEAVES the repository can be
   * retracted by an exact handle. Without it we would have to resolve a tombstone target by
   * path, and tombstoning the wrong document is not a recoverable mistake.
   * Absent on entries migrated from a v1 receipt, which carried no ids.
   */
  documentId?: string;
  /**
   * Why this path is permanently skipped. Sticky, and the whole reason it exists is convergence:
   * object identity includes the OWNER, so without a memory every re-add mints another private
   * copy whose promote 409s again, forever.
   *
   *   shared_by_other   a TEAMMATE holds the one permitted WORKSPACE copy (409
   *                     KB_SCOPE_SOURCE_ALREADY_SHARED). Ours was redundant and was retracted.
   *   local_tombstoned  OUR OWN copy is tombstoned and cannot be re-scoped (409
   *                     KB_DOCUMENT_NOT_RESCOPABLE). Measured live: a teammate who loses this
   *                     receipt re-adds, kb-add DEDUPS onto their tombstoned copy
   *                     (`noop_unchanged`, identical content), and the promote can never
   *                     succeed. Kept DISTINCT from the case above because it is not evidence a
   *                     teammate owns the file, and the copy must not claim one.
   */
  skipReason?: "shared_by_other" | "local_tombstoned";
}

export interface SeedReceipt {
  version: 2;
  seededAt: string;
  entries: Record<string, SeedReceiptEntry>;
}

/** The pre-TEAM receipt shape, kept only so `migrateReceipt` can read one off disk. */
interface SeedReceiptV1 {
  version: 1;
  seededAt: string;
  digests: Record<string, string>;
}

/**
 * Read either receipt version as v2.
 *
 * A v1 receipt knows WHICH paths were seeded but not their document ids and not whether they
 * reached WORKSPACE scope (v1 predates promoting at all). So a migrated entry keeps its digest,
 * which is what stops a pointless re-POST of unchanged bytes, and deliberately carries no
 * documentId: those documents are re-promoted (idempotent) on the next run, and until one is
 * promoted we hold no handle we would trust for a retraction.
 */
export function migrateReceipt(raw: unknown): SeedReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SeedReceipt> & Partial<SeedReceiptV1>;
  if (r.version === 2 && r.entries && typeof r.entries === "object") {
    return { version: 2, seededAt: String(r.seededAt ?? ""), entries: r.entries };
  }
  if (r.version === 1 && r.digests && typeof r.digests === "object") {
    const entries: Record<string, SeedReceiptEntry> = {};
    for (const [repoPath, digest] of Object.entries(r.digests)) {
      if (typeof digest === "string") entries[repoPath] = { digest };
    }
    return { version: 2, seededAt: String(r.seededAt ?? ""), entries };
  }
  return null;
}

export interface SeedPlanInput {
  /** The repository's NAME (git toplevel basename), used only to namespace the KB identity. */
  repoName: string;
  /**
   * The tracked file list, or `null` when the enumeration itself FAILED.
   *
   * The tri-state is the same one `ScanResult.instructionFilePaths` carries and for the same
   * reason: `[]` is an authoritative "this checkout tracks nothing", `null` is "I could not look".
   * Collapsing them would let a non-git scan root report that a repo has no instruction files.
   */
  tracked: string[] | null;
  /** Reads one repo-relative path; returns null when the file cannot be read. */
  readFile: (repoPath: string) => string | null;
  /** The prior receipt for this root, or null when this checkout has never seeded. */
  prior: SeedReceipt | null;
}

/** A governed document whose source file is no longer in the checkout. */
export interface SeedDeletion {
  repoPath: string;
  documentId: string;
}

export interface SeedPlan {
  /** Files to POST: T1, readable, in-bounds, and CHANGED since the prior receipt. */
  candidates: SeedCandidate[];
  /** T1 files whose digest already matches the receipt. Counted, never re-POSTed. */
  unchanged: number;
  /** T1 files a teammate already shares; deliberately never re-added. */
  sharedByOther: number;
  /** Every T1 file that was present but not seeded, with its reason. */
  skipped: SeedSkip[];
  /** False when `tracked` was null: we could not enumerate, so we assert nothing. */
  enumerated: boolean;
  /**
   * Documents to retract: a receipt path that is no longer a tracked T1 file. A RENAME is
   * exactly this plus a new candidate, which is all a path-keyed identity can observe; there is
   * no rename primitive in the substrate and inventing one would be a parallel identity model.
   * Empty whenever `enumerated` is false: tombstoning a corpus because a git probe failed is
   * the most destructive thing this module could do.
   */
  deletions: SeedDeletion[];
  /**
   * Receipt paths that vanished but carry NO documentId (migrated v1 entries), so we hold no
   * handle we would trust. Reported rather than resolved-by-path: tombstoning the wrong
   * document is not recoverable, and these self-heal once the path is re-seeded and promoted.
   */
  unretractable: string[];
  /** Entries for every T1 file seen this pass (changed + unchanged + shared), for the receipt. */
  entries: Record<string, SeedReceiptEntry>;
}

/**
 * The KB identity for one seeded instruction file.
 *
 * Namespaced by repo NAME rather than absolute path, and the choice is deliberate on both axes:
 *   - stable ACROSS MACHINES, so a teammate's clone at a different absolute path seeds the SAME
 *     identity and the server answers `noop_unchanged` instead of minting a duplicate. Keying it
 *     by `resolveScanRootIdentity()` (a realpath) would give every clone its own copy.
 *   - distinct ACROSS SIBLING REPOS, so three markers bound to one workspace do not overwrite
 *     each other's `CLAUDE.md` revision on every seed.
 *
 * The residual failure (two repos cloned into identically-named directories, bound to one
 * workspace) mints one shared identity whose revisions alternate. That is a duplicate-content
 * annoyance, not a correctness fault, and it is strictly better than the guaranteed collision a
 * bare path would produce.
 */
export function seedRelPath(repoName: string, repoPath: string): string {
  return `${SEED_NAMESPACE}/${sanitizeRepoName(repoName)}/${repoPath}`;
}

// A repo name reaches the KB identity, so it is constrained here rather than trusted. Anything
// outside the safe set collapses to a stable hash instead of being dropped: two differently-odd
// names must not silently become one identity.
function sanitizeRepoName(name: string): string {
  const trimmed = name.trim().replace(/^[./]+/, "");
  if (trimmed.length > 0 && trimmed.length <= 64 && /^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return `repo-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

/**
 * Decide what to seed. Pure: no filesystem, no clock, no network, so every bound above is a unit
 * test rather than a live probe.
 */
export function planDeterministicSeed(input: SeedPlanInput): SeedPlan {
  const empty: SeedPlan = {
    candidates: [],
    unchanged: 0,
    sharedByOther: 0,
    skipped: [],
    enumerated: false,
    deletions: [],
    unretractable: [],
    entries: {},
  };
  // The probe failed. Say nothing about this repo rather than reporting a zero we did not
  // measure, and in particular do not read "no tracked files" as "every file was deleted".
  if (input.tracked === null) return empty;

  const candidates: SeedCandidate[] = [];
  const skipped: SeedSkip[] = [];
  const entries: Record<string, SeedReceiptEntry> = {};
  let unchanged = 0;
  let sharedByOther = 0;

  // Sorted so the batch (and therefore which files a cap drops) is deterministic across machines
  // and across `git ls-files` orderings.
  const t1 = input.tracked.filter(isInstructionFile).sort();
  const present = new Set(t1);

  for (const repoPath of t1) {
    const prior = input.prior?.entries[repoPath];
    // A teammate owns the shared copy of this exact source object. Object identity includes the
    // OWNER, so re-adding would mint another private copy, the promote would 409 again, and we
    // would tombstone it again: an infinite churn that never converges. Carry the entry forward
    // untouched, including when the CONTENT changed, because we cannot write another owner's
    // document and minting a rival private copy is worse than being one revision behind.
    if (prior?.skipReason) {
      entries[repoPath] = prior;
      sharedByOther++;
      continue;
    }
    if (candidates.length >= MAX_SEED_FILES) {
      // Report the truncation. A silent cap reads as "we seeded everything" when it did not.
      skipped.push({ repoPath, reason: "cap" });
      if (prior) entries[repoPath] = prior;
      continue;
    }
    const content = input.readFile(repoPath);
    if (content === null) {
      skipped.push({ repoPath, reason: "unreadable" });
      if (prior) entries[repoPath] = prior;
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_SEED_FILE_BYTES) {
      skipped.push({ repoPath, reason: "too_large" });
      if (prior) entries[repoPath] = prior;
      continue;
    }
    if (content.trim().length === 0) {
      skipped.push({ repoPath, reason: "empty" });
      if (prior) entries[repoPath] = prior;
      continue;
    }
    // Digest the NORMALIZED bytes (BOM strip, CRLF -> LF, NFC), through the same shared helper the
    // scanner and control both use. A raw-byte hash would reseed the whole set on every session
    // for anyone on a CRLF checkout.
    const digest = normalizedContentHash(content);
    if (prior?.digest === digest) {
      entries[repoPath] = prior;
      unchanged++;
      continue;
    }
    entries[repoPath] = { digest, ...(prior?.documentId ? { documentId: prior.documentId } : {}) };
    candidates.push({
      repoPath,
      relPath: seedRelPath(input.repoName, repoPath),
      content,
      digest,
    });
  }

  // Retraction half. A path we synchronized before that is no longer a tracked T1 file was
  // deleted, renamed, or moved out of the T1 tier; all three mean the governed document no
  // longer has a source, and the substrate's existing answer to that is a tombstone.
  const deletions: SeedDeletion[] = [];
  const unretractable: string[] = [];
  for (const [repoPath, entry] of Object.entries(input.prior?.entries ?? {})) {
    if (present.has(repoPath)) continue;
    if (entry.documentId) deletions.push({ repoPath, documentId: entry.documentId });
    else unretractable.push(repoPath);
  }

  return {
    candidates,
    unchanged,
    sharedByOther,
    skipped,
    enumerated: true,
    deletions,
    unretractable,
    entries,
  };
}

// ---------------------------------------------------------------------------
// The I/O half: synchronize the corpus with the checkout, using only primitives
// the governed substrate already exposes.
// ---------------------------------------------------------------------------

/**
 * Documents per kb/add POST on the SEED path. Deliberately smaller than the ingest path's
 * `INGEST_BATCH_SIZE`: this runs on SessionStart, in front of a human waiting for their session,
 * where the budget is a moment rather than the 90s an interactive `enrich ingest` may take. A
 * measured single-document POST against local intel is ~1.3s, so three is a few seconds worst
 * case, and a repo carrying more converges over the next few sessions instead of stalling this one.
 */
export const SEED_BATCH_SIZE = 3;

/** One document's outcome from the kb-add route, plus the id the later verbs need. */
export interface SeedPersistResult {
  relPath: string;
  outcome: PersistOutcome;
  /** The governed documentId. Absent on a failed document. */
  documentId?: string;
}

/** What a promote attempt learned. */
export interface SeedPromoteResult {
  /** True when this document is now (or already was) the workspace-shared copy. */
  shared: boolean;
  /**
   * True on the 409 KB_SCOPE_SOURCE_ALREADY_SHARED: a TEAMMATE holds the one permitted
   * WORKSPACE copy of this source object, so ours is redundant and gets retracted.
   */
  alreadySharedByOther?: boolean;
  /**
   * True on the 409 KB_DOCUMENT_NOT_RESCOPABLE: this document is tombstoned, so it can never be
   * promoted. A DIFFERENT condition from the one above and never conflated with it.
   */
  notRescopable?: boolean;
}

export interface SeedRunDeps {
  /** Tracked files for this checkout, or null when the enumeration itself failed. */
  listTracked: (cwd: string) => string[] | null;
  /** Read one repo-relative file; null when unreadable. */
  readFile: (cwd: string, repoPath: string) => string | null;
  /** The repository's name, used only to namespace KB identity. */
  repoName: (cwd: string) => string;
  readReceipt: () => SeedReceipt | null;
  writeReceipt: (receipt: SeedReceipt) => void;
  persist: (docs: PersistDocument[]) => Promise<{ docs: SeedPersistResult[] }>;
  /** POST .../scope {scope:"WORKSPACE"}. Idempotent server-side. Throws on a real failure. */
  promote: (documentId: string) => Promise<SeedPromoteResult>;
  /** POST /kb/forget. The existing tombstone primitive. Throws on failure. */
  tombstone: (documentId: string, reason: string) => Promise<void>;
  now: () => string;
}

export interface SeedOutcome {
  /** False when `git ls-files` failed: we looked at nothing and claim nothing. */
  enumerated: boolean;
  /** T1 files that needed seeding this run (before the per-session batch cap). */
  candidates: number;
  /** Newly governed revisions. */
  ingested: number;
  /** Already byte-identical to the governed head. Success, not work. */
  noop: number;
  /** Documents the server refused, a POST that threw, or a promote that failed. */
  failed: number;
  /** T1 files whose digest already matched the receipt; never re-POSTed. */
  unchanged: number;
  /** Documents now serving at WORKSPACE scope because of this run. */
  shared: number;
  /** Our redundant private copies retracted because a teammate already shares the file. */
  redundant: number;
  /** Paths abandoned because our own copy is tombstoned and cannot be re-scoped. */
  blocked: number;
  /** Documents tombstoned because their source file left the checkout. */
  retracted: number;
  /** Candidates deferred by the per-session batch cap; they seed on a later session. */
  remaining: number;
  /** T1 files present but not seeded, each with its reason. Never a silent drop. */
  skipped: SeedSkip[];
  /** Vanished paths we hold no trusted handle for (migrated v1 entries). */
  unretractable: string[];
}

const EMPTY_OUTCOME: SeedOutcome = {
  enumerated: false,
  candidates: 0,
  ingested: 0,
  noop: 0,
  failed: 0,
  unchanged: 0,
  shared: 0,
  redundant: 0,
  blocked: 0,
  retracted: 0,
  remaining: 0,
  skipped: [],
  unretractable: [],
};

/**
 * Synchronize this checkout's agent-instruction files with the workspace's governed corpus:
 * add what changed, share it with the team, retract what left.
 *
 * NEVER THROWS. It runs on the SessionStart path, where a nudge is not a gate: an unreachable
 * intel, an unreadable receipt, or a read-only state dir must all cost the user exactly nothing
 * and simply retry on the next session.
 *
 * CONVERGENCE is the property to preserve when editing this. A path enters the receipt as done
 * only when the server confirmed the WHOLE transition it needed (persisted AND shared), so a
 * document stuck at PERSON scope, where no teammate can see it, is retried rather than recorded
 * as finished. The inverse bug (re-POSTing every session) is merely wasteful; this one is silent.
 */
export async function runDeterministicSeed(cwd: string, deps: SeedRunDeps): Promise<SeedOutcome> {
  let plan;
  try {
    // A corrupt or unreadable receipt is treated as "never seeded". Re-POSTing is idempotent
    // (the server answers `noop_unchanged`), so the recovery is cheap and self-healing.
    let prior: SeedReceipt | null = null;
    try {
      prior = deps.readReceipt();
    } catch {
      prior = null;
    }
    plan = planDeterministicSeed({
      repoName: deps.repoName(cwd),
      tracked: deps.listTracked(cwd),
      readFile: (repoPath) => deps.readFile(cwd, repoPath),
      prior,
    });
  } catch {
    return { ...EMPTY_OUTCOME };
  }

  if (!plan.enumerated) return { ...EMPTY_OUTCOME, skipped: plan.skipped };

  const out: SeedOutcome = {
    ...EMPTY_OUTCOME,
    enumerated: true,
    candidates: plan.candidates.length,
    unchanged: plan.unchanged,
    remaining: Math.max(0, plan.candidates.length - SEED_BATCH_SIZE),
    skipped: plan.skipped,
    unretractable: plan.unretractable,
  };
  // Mutable working copy of what the next receipt should say.
  const entries: Record<string, SeedReceiptEntry> = { ...plan.entries };
  let dirty = false;

  // ---- retraction first ---------------------------------------------------
  // Before adding, remove what no longer has a source. Ordering matters for a RENAME: the old
  // path's document is retracted and the new path is added in the same pass, so the corpus never
  // serves both halves of a rename at once.
  for (const del of plan.deletions) {
    try {
      await deps.tombstone(
        del.documentId,
        `the source file ${del.repoPath} is no longer tracked in this repository`,
      );
      delete entries[del.repoPath];
      out.retracted++;
      dirty = true;
    } catch {
      // Keep the entry so the retraction is retried. Dropping it here would strand a governed
      // document that outlived its file with nothing left pointing at it.
    }
  }

  // ---- the add + share half ----------------------------------------------
  if (plan.candidates.length > 0) {
    const batch = plan.candidates.slice(0, SEED_BATCH_SIZE);
    const docs: PersistDocument[] = batch.map((c) => ({ relPath: c.relPath, content: c.content }));

    let results: SeedPersistResult[] | null = null;
    try {
      results = (await deps.persist(docs)).docs;
    } catch {
      // The POST never completed. Record nothing: kb/add commits per document as it walks the
      // batch, so some documents may in fact have landed, and re-sending them is a
      // `noop_unchanged` rather than a duplicate. Claiming a success we cannot see would be the
      // unrecoverable error.
      results = null;
      out.failed += batch.length;
      for (const c of batch) delete entries[c.repoPath];
    }

    if (results) {
      // Zip receipts back to candidates BY POSITION, the route's contract (kb_add.py iterates
      // body.documents in order). An absent receipt reads as "failed" so the file retries.
      for (let i = 0; i < batch.length; i++) {
        const candidate = batch[i];
        const res = results[i];
        const landed = res?.outcome === "ingested" || res?.outcome === "noop_unchanged";
        if (!landed || !res?.documentId) {
          out.failed++;
          delete entries[candidate.repoPath];
          continue;
        }
        if (res.outcome === "ingested") out.ingested++;
        else out.noop++;

        // Share it. A PERSON-scoped document is visible only to its owner (intel `_passes_acl`),
        // so a seed that stops here has governed nothing for the team.
        let promoted: SeedPromoteResult;
        try {
          promoted = await deps.promote(res.documentId);
        } catch {
          // Landed but not shared: do NOT record it, so the next session promotes it. A document
          // stranded at PERSON scope is invisible to everyone else, and silently.
          out.failed++;
          delete entries[candidate.repoPath];
          continue;
        }

        if (promoted.alreadySharedByOther) {
          // A teammate holds the one permitted WORKSPACE copy. Ours is redundant (the server's
          // own word) and, being PERSON-scoped, would be retrieved by US alongside the shared
          // one: two identical answers to one question. Retract it and remember, so we never
          // mint it again.
          out.redundant++;
          try {
            await deps.tombstone(
              res.documentId,
              "a teammate already shares this repository instruction file at workspace scope",
            );
          } catch {
            // Cleanup failed, but the LEARNING is the durable half and is recorded below
            // regardless: without it we would mint another redundant copy every session.
          }
          entries[candidate.repoPath] = { digest: candidate.digest, skipReason: "shared_by_other" };
          dirty = true;
          continue;
        }

        if (promoted.notRescopable) {
          // Our own copy is tombstoned, so no promote will ever succeed on it. Record the skip
          // rather than "failing" it: a failure retries, and this one would retry every session
          // forever against a document that cannot change state. Nothing to tombstone (it
          // already is), and no claim that a teammate owns the file, because this is not
          // evidence of that.
          out.blocked++;
          entries[candidate.repoPath] = { digest: candidate.digest, skipReason: "local_tombstoned" };
          dirty = true;
          continue;
        }

        if (promoted.shared) out.shared++;
        entries[candidate.repoPath] = { digest: candidate.digest, documentId: res.documentId };
        dirty = true;
      }
    }
  }

  if (dirty) {
    try {
      deps.writeReceipt({ version: 2, seededAt: deps.now(), entries });
    } catch {
      // The documents landed; only the local bookkeeping failed. The next session re-POSTs and
      // the server answers `noop_unchanged`. Wasteful, never wrong.
    }
  }

  return out;
}
