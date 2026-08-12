// Withdrawal reconciliation for a pinned notes corpus: decide which KB documents no longer exist
// at their authoritative location.
//
// WHY THIS EXISTS. `kb add --mode corpus` globs the marker-pinned set under the vault root, so it
// already holds the complete current file list. Nothing ever compared that list against what the KB
// holds, so a note deleted from disk stayed `tombstoneState: ACTIVE` and kept serving. On
// 2026-08-05 `notes/20260731-proposal-d-intervention-legibility.md`, deleted five days earlier, came
// back at high relevance carrying a claim that a later session had refuted, in the same result set
// as the correction and indistinguishable from it. An empty answer costs a session one grep; a
// confidently-served refuted answer costs it a wrong decision.
//
// WHAT WITHDRAWAL ASSERTS. Exactly one thing: this source is no longer current at its authoritative
// location. NOT that its claims were refuted, and not a trust verdict (document-grain trust is
// retired; the claim is the unit of governance). It is the same lifecycle act `mla kb forget`
// performs, which is why the caller routes each decision through `kb/forget`: that route owns the
// notes keyspace, and `kb/withdraw` explicitly refuses `sourceSystem=notes` so it cannot become a
// general note-tombstone backdoor.
//
// WHY IT IS A PURE PLANNER. The dangerous direction here is unbounded: a bad comparison tombstones
// a live corpus. Keeping the decision in a total function over two lists means every guard is
// testable without a network, a database, or a filesystem, and the effectful caller has no judgment
// left to get wrong.

/** The document liveness states the planner distinguishes. Anything not ACTIVE is left alone. */
export type KbTombstoneState = "ACTIVE" | "TOMBSTONED" | "HARD_DELETE_PENDING" | "HARD_DELETED";

/** One KB document as the reconciliation sees it. */
export interface KbCorpusDocument {
  documentId: string;
  /** The stored logical identity, vault-relative POSIX (e.g. `notes/20260805-x.md`). */
  externalObjectId: string;
  sourceSystem: string;
  tombstoneState: KbTombstoneState;
}

export interface WithdrawalPlanInput {
  /** Every path the scan found. Must be the COMPLETE set for the scanned scope. */
  scannedRelPaths: string[];
  /** Every KB document that could conceivably be in that scope. */
  known: KbCorpusDocument[];
  /**
   * Whether the caller can prove the scan covered the whole scope. False means the planner
   * abstains: absence is only evidence of deletion when the search was exhaustive.
   */
  scanComplete: boolean;
  /** Is this stored identity inside the scanned scope? Usually the corpus glob. */
  inScope: (externalObjectId: string) => boolean;
  /** Absolute-path prefix to strip so scanned paths and stored ids share one representation. */
  repoRoot?: string;
}

export interface WithdrawalPlan {
  /** Documents to tombstone. Empty whenever the planner is not certain. */
  withdraw: KbCorpusDocument[];
  /** In-scope documents found on disk and left serving. */
  keptActive: number;
  /** Documents the scan says nothing about (other source system, or outside the glob). */
  outOfScope: number;
  /** In-scope documents already non-ACTIVE, so there is nothing to do. */
  alreadyWithdrawn: number;
  /** True when the planner declined to decide. `withdraw` is always empty in that case. */
  abstained: boolean;
  /** Why it abstained, for the operator-facing receipt. */
  abstainReason: string | null;
}

/** The source system whose keyspace this reconciliation governs. */
const NOTES_SOURCE_SYSTEM = "notes";

/**
 * Canonicalize to vault-relative, `/`-separated, `.`/`..`-resolved form.
 *
 * Returns null for an empty, non-string, or root-escaping path. A null contributes nothing to the
 * present-set rather than raising, so one malformed entry cannot fail a scan; the aggregate
 * emptiness check below is what catches a scan that is malformed all the way through.
 */
export function normalizeCorpusPath(input: unknown, repoRoot?: string): string | null {
  if (typeof input !== "string") return null;
  let p = input.trim().replace(/\\/g, "/");
  if (!p) return null;
  if (repoRoot) {
    const root = repoRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (p.startsWith(root)) p = p.slice(root.length);
  }
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Escaping above the root cannot be expressed as a vault-relative identity.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  // CASEFOLD, because the server does. `intel/app/services/kb_canonicalize.py`
  // ends its note-identity function with `return posix.casefold()`, so a stored
  // externalObjectId is casefolded BY DESIGN, while the scan reads the real
  // on-disk case. Comparing them case-sensitively mismatches for EVERY mixed-case
  // filename, and a mismatch here does not read as "unchanged", it reads as "this
  // file left disk".
  //
  // Found 2026-08-06 by running the human-authored backfill under observation,
  // which is the only way it surfaces: a mixed-case note has to actually be
  // INGESTED before reconcile can mis-compare it. At that moment 51 of the 2,207
  // vault notes carried an uppercase letter and 4 were already listed under
  // `MISSING from disk` with their files sitting right there. `--apply` would
  // have tombstoned live documents.
  //
  // This is not a heuristic about filesystems: it matches the identity function
  // the server actually uses. The residual (two notes differing only by case on a
  // case-SENSITIVE filesystem collapse to one identity) is the server's existing
  // behavior, not something introduced here, and it errs toward a missed
  // withdrawal, which this module already states is strictly cheaper than a false
  // one.
  return segments.length > 0 ? segments.join("/").normalize("NFC").toLowerCase() : null;
}

/** The single identity root the server prefixes onto every vault-relative note path. */
export const NOTES_IDENTITY_ROOT = "notes/";

function segmentToRegex(seg: string): RegExp {
  let re = "";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does a vault-relative path match the corpus glob, using the SCANNER's semantics?
 *
 * `**` matches zero or more directory segments; `*` and `?` match within one segment; a segment
 * containing `*` skips dotfiles. This mirrors `globFiles` in kb_add deliberately and exactly.
 *
 * WHY EXACTNESS IS LOAD-BEARING. The scope predicate decides which documents the scan is entitled
 * to speak for. If it is LOOSER than the glob that produced the scan, every document the scan never
 * looked for reads as deleted: the default `*.md` never descends into `notes/onboarding/`, so a
 * predicate of "starts with notes/" would tombstone every onboarding document on the first run.
 * Tighter is merely conservative; looser destroys the corpus.
 */
export function corpusGlobMatches(relPath: string, pattern: string): boolean {
  const parts = relPath.split("/").filter((s) => s !== "");
  const pat = pattern.split("/").filter((s) => s !== "");
  if (parts.length === 0) return false;

  const walk = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === parts.length;
    const seg = pat[pi];
    if (seg === "**") {
      // Zero or more segments.
      for (let skip = si; skip <= parts.length; skip++) {
        if (walk(pi + 1, skip)) return true;
      }
      return false;
    }
    if (si >= parts.length) return false;
    const name = parts[si];
    // Unix-glob convention: a wildcard segment does not match a leading dot.
    if (seg.includes("*") && name.startsWith(".")) return false;
    if (!segmentToRegex(seg).test(name)) return false;
    return walk(pi + 1, si + 1);
  };

  return walk(0, 0);
}

/**
 * Is this STORED document identity inside the scanned corpus?
 *
 * Stored ids carry the `notes/` identity root the server prefixes; the scan produced
 * vault-relative paths without it. Strip the root, then apply the scanner's own glob.
 */
export function storedIdInCorpusScope(externalObjectId: string, pattern: string): boolean {
  const norm = normalizeCorpusPath(externalObjectId);
  if (norm === null) return false;
  if (!norm.startsWith(NOTES_IDENTITY_ROOT)) return false;
  const rel = norm.slice(NOTES_IDENTITY_ROOT.length);
  if (!rel) return false;
  return corpusGlobMatches(rel, pattern);
}

/**
 * Decide which in-scope documents left disk.
 *
 * Total and side-effect free. Every path that cannot be proven safe returns an abstaining plan with
 * an empty `withdraw`, because the cost of a false withdrawal (a live document stops being served)
 * strictly exceeds the cost of a missed one (the status quo persists one more cycle).
 */
export function planCorpusWithdrawals(input: WithdrawalPlanInput): WithdrawalPlan {
  const { known, scanComplete, inScope, repoRoot } = input;

  const empty = (reason: string | null): WithdrawalPlan => ({
    withdraw: [],
    keptActive: 0,
    outOfScope: 0,
    alreadyWithdrawn: 0,
    abstained: reason !== null,
    abstainReason: reason,
  });

  // Guard 1: absence is only evidence of deletion when the search was exhaustive.
  if (!scanComplete) {
    return empty("scan not proven complete; refusing to infer deletion from absence");
  }

  const present = new Set<string>();
  for (const raw of input.scannedRelPaths) {
    const norm = normalizeCorpusPath(raw, repoRoot);
    if (norm) present.add(norm);
  }

  // Guard 2: a scan that normalizes to nothing is indistinguishable from a scan that ran against
  // the wrong root. Acting on it would tombstone the entire corpus, which is the one outcome worth
  // engineering against.
  if (present.size === 0) {
    return empty("scan yielded no usable paths; refusing to withdraw an entire corpus");
  }

  const plan: WithdrawalPlan = {
    withdraw: [],
    keptActive: 0,
    outOfScope: 0,
    alreadyWithdrawn: 0,
    abstained: false,
    abstainReason: null,
  };

  for (const d of known) {
    // Guard 3: this reconciliation speaks only for the notes keyspace it scanned.
    if (d.sourceSystem !== NOTES_SOURCE_SYSTEM || !inScope(d.externalObjectId)) {
      plan.outOfScope += 1;
      continue;
    }
    // Guard 4: only an ACTIVE document has anything to withdraw. TOMBSTONED is already the target
    // state; HARD_DELETE_PENDING and HARD_DELETED are terminal and owned by purge.
    if (d.tombstoneState !== "ACTIVE") {
      plan.alreadyWithdrawn += 1;
      continue;
    }
    const norm = normalizeCorpusPath(d.externalObjectId, repoRoot);
    if (norm !== null && present.has(norm)) {
      plan.keptActive += 1;
      continue;
    }
    plan.withdraw.push(d);
  }

  return plan;
}
