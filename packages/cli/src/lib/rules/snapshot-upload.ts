// src/lib/rules/snapshot-upload.ts
//
// The PUSH half of the artifact-revision contract, for `mla scan`
// (notes/20260717-adr-decision-record-projection-and-reconciliation.md §4.2 / §3.2, Phase 2B).
//
// `fetchReconciliationForScan` (bundle-refresh.ts) PULLS the findings the detector already raised;
// this is the upstream half that gives the detector something to raise them FROM. On every scan it
// re-reads each instruction file the scan inventoried, normalizes it under content-normalization-v1,
// and upserts the normalized bytes + digest to control, so control holds a server-visible revision
// of every CLAUDE.md / .claude/rules / .cursor/rules this checkout carries. Without it the detector
// has no artifact to scan a superseded decision against and never raises a finding (ADR "deviation
// 4": nothing in the CLI uploaded snapshots).
//
// WHY RE-READ instead of reusing the scan's cached digest: the scan discards the normalized CONTENT
// (it caches only the digest + byteLength, to keep the every-turn jq read of the cache lean). To
// upload content we must re-read, and once we re-read we recompute the digest from the SAME bytes we
// send, so the payload is self-consistent and the server's re-normalization can only agree. A file
// that drifted between scan and upload simply publishes its CURRENT revision, which is exactly
// right: the upload's job is to make control mirror what is on disk now.
//
// BEST EFFORT, on the same terms as the bundle / findings pulls: a logged-out CLI, an unbound repo,
// an offline laptop, or a since-deleted file must never fail a scan. Per-file failures are counted
// into the returned summary and never thrown; only an inability to start the pass at all (no config,
// no commit to anchor revisions to) reports `delivered: false`.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspaceConfig, type WorkspaceCliConfig } from "../config";
import { describeEgressRefusal } from "../egress/policy";
import {
  sweepRepoInstructionSnapshots,
  upsertRepoInstructionSnapshot,
  type RepoInstructionSnapshotClientHttp,
} from "./repo-instruction-snapshot-client";
import {
  CONTENT_NORMALIZATION_V1,
  normalizeContent,
  normalizedContentHash,
} from "../scanner/content-normalization";

// The same ceiling the scanner uses (scan.ts MAX_FILE_BYTES). A file it skipped as too large is not
// in artifactDigests and never reaches this list, but the re-read guards defensively too: a file
// that GREW past the ceiling between scan and upload is skipped rather than sent whole.
const MAX_FILE_BYTES = 256 * 1024;

/** Read a file the way the scanner did (utf8, skip >256KB / unreadable). Null means skip. */
function safeReadFile(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** The per-file paths + provenance a scan produces, all this pass needs to publish revisions. */
export interface SnapshotUploadArgs {
  workspaceId: string;
  /** Per-checkout partition key: resolveScanRootIdentity(scanRoot). NEVER the workspaceId. */
  repositoryId: string;
  /** The directory the scan ran from; instruction paths are relative to it. */
  scanRoot: string;
  /** The scan's instruction-file relative paths (ScanResult.artifactDigests[].relativePath). */
  paths: string[];
  /**
   * The FULL enumeration of instruction files this scan saw on disk, used to retire everything
   * else. Deliberately a superset of `paths`: an oversized or unreadable file is still ON DISK, and
   * sweeping by the uploaded set would tombstone it every scan and re-detect nothing, quietly
   * dropping a rule the operator can still see in their editor.
   *
   * `undefined` means "I have no authoritative list" (the scan could not enumerate the checkout, or
   * the caller predates this field) and NO sweep runs. `[]` means "I looked, and there are genuinely
   * zero instruction files" and DOES sweep: a repo whose only CLAUDE.md was just deleted is the
   * common case, and refusing to converge there would leave the bug permanently unfixed.
   */
  observedPaths?: string[];
  /** The commit the scan observed (ScanResult.commitSha). */
  observedCommitSha: string;
  /** When the scan ran (ScanResult.generatedAt), ISO-8601. */
  observedAt: string;
}

/**
 * The outcome of a scan-time upload pass. `delivered: false` means the pass could not START (no
 * config, or no commit to anchor a revision to); the scan itself is unaffected. A per-file failure
 * keeps `delivered: true` with a non-zero `failed`, because the scan succeeded and only some
 * uploads did not. `uploaded` counts both fresh inserts and server-side dedupes (both mean control
 * now holds the revision); `skipped` is unreadable / too-large at re-read.
 */
export type SnapshotUploadOutcome =
  | {
      delivered: true;
      attempted: number;
      uploaded: number;
      skipped: number;
      failed: number;
      /**
       * Set iff at least one file was refused by the egress policy rather than lost to a
       * transport failure (ruling §2). A count alone cannot tell those apart, and they need
       * opposite reactions: a flaky network retries itself on the next scan, an unregistered
       * route or unclassified field NEVER uploads again until someone edits rules.ts. Body-free
       * by construction (see describeEgressRefusal). First refusal only: they are all the same
       * defect, and N copies of one line is noise.
       */
      refusal?: string;
      /**
       * Live revisions control retired because this scan no longer sees their path, or `null` when
       * no sweep ran. Null covers both "the scan could not enumerate the checkout" (no authority to
       * retire anything) and "the sweep call failed"; 0 means it ran and the corpus already matched.
       * The distinction matters because 0 and null read identically in a counter but mean opposite
       * things about whether removal is working.
       */
      swept: number | null;
    }
  | { delivered: false; error: string };

export interface SnapshotUploadDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RepoInstructionSnapshotClientHttp;
  readFile?: (abs: string) => string | null;
}

/**
 * Upsert a server-visible revision of every instruction file this scan saw. See the module header
 * for why it re-reads and why it is best-effort.
 */
export async function uploadSnapshotsForScan(
  args: SnapshotUploadArgs,
  deps: SnapshotUploadDeps = {},
): Promise<SnapshotUploadOutcome> {
  // A revision with no commit to anchor it violates the server contract (observedCommitSha is
  // @IsNotEmpty). Rather than fire N requests that each 400, skip the whole pass: an unborn HEAD or
  // a non-git checkout has nothing meaningful to stamp a revision at.
  if (!args.observedCommitSha) {
    return { delivered: false, error: "no observed commit sha (unborn HEAD or non-git checkout)" };
  }
  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(args.workspaceId);
  } catch (e) {
    return { delivered: false, error: (e as Error).message };
  }
  const readFile = deps.readFile ?? safeReadFile;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let refusal: string | undefined;
  for (const relativePath of args.paths) {
    const raw = readFile(join(args.scanRoot, relativePath));
    if (raw === null) {
      skipped++;
      continue;
    }
    try {
      // Normalize + hash the SAME re-read bytes: self-consistent, so the server's recomputed digest
      // must equal `normalizedContentHash(raw)` and the 400-on-mismatch guard is never tripped by us.
      const { normalized } = normalizeContent(raw);
      await upsertRepoInstructionSnapshot(
        cfg,
        {
          repositoryId: args.repositoryId,
          relativePath,
          normalizedContent: normalized,
          normalizedContentHash: normalizedContentHash(raw),
          contentNormalizationVersion: CONTENT_NORMALIZATION_V1,
          observedCommitSha: args.observedCommitSha,
          observedAt: args.observedAt,
        },
        deps.http,
      );
      uploaded++;
    } catch (err) {
      // Best effort: a single file's transport / auth / validation failure must not abort the rest
      // of the pass or the scan. Counted, warned by the caller, retried on the next scan.
      failed++;
      // ...except a policy refusal, which is not retried by anything: it will refuse every file in
      // this pass and every file in every later pass. Carry the reason out so the caller's warning
      // can say so instead of implying a transient blip.
      refusal ??= describeEgressRefusal(err, "instruction-file snapshot") ?? undefined;
    }
  }
  // The removal half, AFTER the uploads. Order is load-bearing: sweeping first would retire a path
  // this very scan is about to re-upload, and a crash in between would leave the corpus short of a
  // file that is on disk. It runs even when some uploads failed, because a failed upload is a blip
  // against a path that IS in the observed set, and the sweep only ever retires paths outside it;
  // making removal hostage to an unrelated flake would be the wrong trade.
  let swept: number | null = null;
  if (args.observedPaths !== undefined) {
    try {
      const res = await sweepRepoInstructionSnapshots(
        cfg,
        { repositoryId: args.repositoryId, observedPaths: args.observedPaths },
        deps.http,
      );
      swept = res.tombstonedCount;
    } catch (err) {
      // Same best-effort posture as a per-file upload: the next scan sweeps again with the same
      // authoritative set, so a blip costs nothing. A POLICY refusal does not self-heal though, so
      // it takes the refusal channel (?? because a per-file refusal already named the same defect).
      refusal ??= describeEgressRefusal(err, "instruction-file sweep") ?? undefined;
    }
  }

  return {
    delivered: true,
    attempted: args.paths.length,
    uploaded,
    skipped,
    failed,
    refusal,
    swept,
  };
}
