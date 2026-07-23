// The LIVE reconciliation view (ADR §3.5 / §3.7, T11): the single place that decides which cached
// reconciliation findings are still entitled to be spoken as governed.
//
// This used to live inside src/commands/assemble-context.ts, where it had exactly one consumer.
// It moved here the moment a SECOND surface needed the same answer (`mla context list` and the
// `mla ask` documentation-impact section). Two copies of "is this finding still live" would drift,
// and the drift would be invisible in the worst direction: the always-on injection surface going
// silent while a human-facing command still printed the finding as current, or the reverse.
//
// TWO gates, and they answer different questions. Neither subsumes the other.
//
//   FRESHNESS  "is control's answer still recent enough to speak for it"
//              Liveness of the DECISION. Whether the superseding commitment is still ACCEPTED,
//              whether the finding was dismissed, whether the artifact was tombstoned, and whether
//              this viewer may still see any of it are decided server-side, per read, in control.
//              So the age of the last successful pull is the age of the evidence that these
//              findings are governed at all.
//
//   REHASH     "does the cited file still say what we evaluated"
//              Integrity of the ARTIFACT, which only this machine can judge. See
//              reconciliation-rehash.ts.
//
// A file can sit untouched for a week after its decision was retracted, and a freshly pulled
// finding can be invalidated by an edit one second later. Freshness runs FIRST and short-circuits
// to an empty list, so a stale cache costs zero file reads.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  filterReconciliationFindings,
  type ArtifactByteReader,
  type ReconciliationRehashResult,
} from "./reconciliation-rehash";
import type { ScanResult } from "./types";

// How long a reconciliation pull stays trustworthy enough to render under trust="governed".
//
// One working day. Long enough that a laptop scanned this morning keeps injecting through the
// afternoon and an offline stretch does not silently drop a live divergence; short enough that a
// machine that has not reached control since yesterday stops asserting somebody else's decision as
// current. The failure direction is deliberate: stale goes SILENT, never stale-but-confident.
export const RECONCILIATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Is the cached findings list young enough to render?
 *
 * An absent stamp is infinitely stale, not "assume fresh": it means the list never came from a
 * successful pull (a pre-stamp cache written by an older CLI, or a hand-edited one), and a band
 * labelled trust="governed" has to be backed by a pull we can date. A stamp in the FUTURE (clock
 * skew, a hand-edited cache) is treated as stale for the same reason: it is not evidence, so it
 * cannot buy trust.
 */
export function isReconciliationFresh(fetchedAt: string | undefined, nowIso: string): boolean {
  if (!fetchedAt) return false;
  const then = Date.parse(fetchedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return false;
  const age = now - then;
  return age >= 0 && age <= RECONCILIATION_MAX_AGE_MS;
}

/**
 * The default artifact byte reader for the rehash gate: read one repo-relative instruction file's
 * UTF-8 bytes, contained under `repoRoot`. It mirrors the scanner's containment discipline exactly
 * (reject absolute paths and `..` escapes) so a finding can never coerce a read outside the repo,
 * and swallows every fs error to null so an unreadable path becomes NEEDS_REEVALUATION rather than
 * throwing. Pure-posix join, matching the rest of the scanner's path handling.
 */
export function makeArtifactByteReader(repoRoot: string | undefined): ArtifactByteReader {
  const root = repoRoot ?? process.cwd();
  return (rel: string): string | null => {
    const t = rel.trim();
    if (!t || t.startsWith("/")) return null;
    const n = posix.normalize(t);
    if (n === "" || n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) return null;
    try {
      return readFileSync(posix.join(root, n), "utf8");
    } catch {
      return null;
    }
  };
}

// The slice of a scan cache this gate reads. Deliberately narrow: callers hand it a whole
// ScanResult, but nothing here may reach for anything else, so a future field cannot quietly
// become load-bearing for "is this governed".
export type ReconciliationCacheView = Pick<
  ScanResult,
  "reconciliationFindings" | "reconciliationFetchedAt"
>;

/**
 * Apply both gates to a scan cache and return the rehash partition.
 *
 * `kept` are the findings a surface may present as governed RIGHT NOW. `needsReevaluation` are the
 * ones held back because the cited file drifted, could not be read, or failed normalization; they
 * are never auto-resolved, only dropped from this moment's output. A stale or absent cache yields
 * both empty, with no file reads at all.
 */
export function liveReconciliationFindings(
  cache: ReconciliationCacheView | null | undefined,
  readBytes: ArtifactByteReader,
  nowIso: string,
): ReconciliationRehashResult {
  const fresh = isReconciliationFresh(cache?.reconciliationFetchedAt, nowIso);
  return filterReconciliationFindings(fresh ? (cache?.reconciliationFindings ?? []) : [], readBytes);
}
