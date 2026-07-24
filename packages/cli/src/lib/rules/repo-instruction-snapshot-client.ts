// src/lib/rules/repo-instruction-snapshot-client.ts
//
// The CLI's typed client for control's repo-instruction-snapshot upsert
// (notes/20260717-adr-decision-record-projection-and-reconciliation.md §4.2 / §3.2, Phase 2B).
//
//   upsertRepoInstructionSnapshot -> POST /internal/v1/repo-instruction-snapshots
//
// Same shape and posture as reconciliation-client: the ONE place the CLI knows this path and its
// wire types, so a rename on either side surfaces as a compile error in exactly one module, with
// the http verb injectable so it is unit-testable with no network.
//
// This is the PRODUCER half of the artifact-revision contract. `listReconciliationFindings` PULLS
// the findings the detector already raised; this PUSHES the artifact the detector scans against.
// The scan emits a local `normalizedContentHash` per instruction file (§3.3 item 2); this uploads
// the NORMALIZED bytes plus that digest so control holds a server-visible revision of every
// CLAUDE.md / .claude/rules / .cursor/rules this checkout carries. The server re-normalizes and
// recomputes the digest, REJECTING (400) a mismatch: that refusal is the proof the two sides
// address the SAME revision id, so a finding's `evaluatedDigest` is comparable across the boundary.
import type { WorkspaceCliConfig } from "../config";
import { post } from "../http";

/** The http verb this client needs; injectable so it is testable with no network. */
export interface RepoInstructionSnapshotClientHttp {
  post: typeof post;
}

const defaultHttp: RepoInstructionSnapshotClientHttp = { post };

const PATH = "/internal/v1/repo-instruction-snapshots";

/**
 * One instruction-file revision to upsert (the per-file half of control's
 * `RepoInstructionSnapshotUpsertDto`). `workspaceId` is NOT here: the client stamps it from cfg,
 * so a caller cannot upload one workspace's file under another's id.
 */
export interface RepoInstructionSnapshotUpsertWire {
  /**
   * The per-CHECKOUT partition key, NOT the workspaceId. One workspace binds several checkouts
   * (see ScanResult.scanRootPath), and control's unique key is (workspace, repo, path, digest);
   * keying it by workspace would let two checkouts' CLAUDE.md stomp each other. The producer
   * derives it from the system's existing per-checkout identity, resolveScanRootIdentity().
   */
  repositoryId: string;
  relativePath: string;
  /** Content already normalized under content-normalization-v1. Server re-normalizes defensively. */
  normalizedContent: string;
  /** sha256(normalize(content)), computed locally. Server recomputes and rejects (400) a mismatch. */
  normalizedContentHash: string;
  contentNormalizationVersion: string;
  observedCommitSha: string;
  /** ISO-8601 timestamp of when the scan observed this revision. */
  observedAt: string;
}

/** The persisted revision control echoes back (mirrors `RepoInstructionSnapshotDto`), bytes elided. */
export interface RepoInstructionSnapshotWire {
  id: string;
  workspaceId: string;
  repositoryId: string;
  relativePath: string;
  normalizedContentHash: string;
  contentNormalizationVersion: string;
  observedCommitSha: string;
  observedAt: string;
  tombstonedAt: string | null;
  createdAt: string;
}

/** Upsert response (mirrors `RepoInstructionSnapshotUpsertResponseDto`). */
export interface RepoInstructionSnapshotUpsertResponseWire {
  snapshot: RepoInstructionSnapshotWire;
  /** true when this exact (workspace, repo, path, digest) revision already existed. */
  deduped: boolean;
}

/**
 * Upsert one instruction-file revision. Throws on transport / auth / validation failure (a 400 on
 * digest mismatch included); every caller is best-effort and catches (a scan must still scan).
 */
export async function upsertRepoInstructionSnapshot(
  cfg: WorkspaceCliConfig,
  rev: RepoInstructionSnapshotUpsertWire,
  http: RepoInstructionSnapshotClientHttp = defaultHttp,
): Promise<RepoInstructionSnapshotUpsertResponseWire> {
  return http.post<RepoInstructionSnapshotUpsertResponseWire>(cfg, PATH, {
    // `workspaceId` LAST, not first: the type already forbids `rev` from carrying one, but stamping
    // it after the spread means that even a malformed runtime object cannot override cfg's id. A
    // caller can never upload one workspace's file under another's id.
    ...rev,
    workspaceId: cfg.workspaceId,
  });
}
