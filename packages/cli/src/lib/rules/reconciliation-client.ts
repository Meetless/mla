// src/lib/rules/reconciliation-client.ts
//
// The CLI's typed client for control's reconciliation read
// (notes/20260717-adr-decision-record-projection-and-reconciliation.md §3.5 / §3.7, T11).
//
//   listReconciliationFindings -> GET /internal/v1/reconciliation/findings
//
// Same shape and posture as control-rule-client: the ONE place the CLI knows this path and
// its wire types, so a rename on either side surfaces as a compile error in exactly one
// module, with the http verbs injectable so it is unit-testable with no network.
//
// A SEPARATE door from `getBundle`, deliberately, even though the CLI walks through both at
// the same refresh moment on the same auth. The bundle is principal-bound, integrity-hashed,
// and governed by a DENY-lease; folding a churning findings list into it would rev the bundle
// hash on every detector write and couple injection to scoped-rule delivery, which §3.5
// forbids outright. Same moment, separate door. (The controller carries the mirror of this
// note, since the argument has to survive a reader arriving from either side.)
//
// The VIEWER is not a parameter here and must never become one. Control derives it
// server-side from the session (or re-validates an asserted actor under INV-AUTH-1), because
// the governed band renders a decision statement and a caller who could name its own viewer
// could read another person's PERSON-scoped decision.
import type { WorkspaceCliConfig } from "../config";
import { get } from "../http";
import type { ReconciliationFinding } from "../scanner/types";

/** The http verbs this client needs; injectable so it is testable with no network. */
export interface ReconciliationClientHttp {
  get: typeof get;
}

const defaultHttp: ReconciliationClientHttp = { get };

const PATH = "/internal/v1/reconciliation/findings";

/**
 * One ACTIVE finding, as control serializes it (mirrors `ReconciliationFindingDto`).
 *
 * Wider than the local `ReconciliationFinding`: control also returns `id`, `detectedAt`, and
 * `evidenceSpans`. Those are deliberately NOT carried into the cache. `evidenceSpans` is raw
 * byte offsets into a file the renderer never re-reads, and `id`/`detectedAt` are backend
 * bookkeeping. Persisting them would put backend identifiers into a file that is read by an
 * agent every turn, for no rendering gain.
 */
export interface ReconciliationFindingWire {
  id: string;
  path: string;
  evaluatedDigest: string;
  contentNormalizationVersion: string;
  acceptedStatement: string;
  sourceCaseId: string | null;
  supersedingCommitmentId: string;
  currentSummary: string;
  evidenceSpans?: unknown;
  detectorExplanation: string | null;
  detectorVersion: string;
  detectedAt: string;
}

export interface ReconciliationFindingListWire {
  findings: ReconciliationFindingWire[];
  /** True when the workspace has more ACTIVE findings than this page carries. */
  truncated: boolean;
}

/**
 * Fetch this viewer's ACTIVE findings for the workspace. Throws on transport/auth failure;
 * every caller is best-effort and catches (a scan on a plane must still scan).
 */
export async function listReconciliationFindings(
  cfg: WorkspaceCliConfig,
  http: ReconciliationClientHttp = defaultHttp,
): Promise<ReconciliationFindingListWire> {
  const path = `${PATH}?workspaceId=${encodeURIComponent(cfg.workspaceId)}`;
  return http.get<ReconciliationFindingListWire>(cfg, path);
}

/**
 * Narrow a wire finding to the cache shape.
 *
 * `reason` is the cache's pre-Phase-3 advisory field and predates the trust bands. It is fed
 * from `detectorExplanation` so an older reader (the rehash gate's audit, `mla context list`)
 * still gets a human-readable "why", rather than an empty string that reads as "no reason
 * given" when a reason exists one field over.
 */
export function toCacheFinding(w: ReconciliationFindingWire): ReconciliationFinding {
  return {
    path: w.path,
    evaluatedDigest: w.evaluatedDigest,
    contentNormalizationVersion: w.contentNormalizationVersion,
    reason: w.detectorExplanation ?? "a governed decision superseded this instruction",
    acceptedStatement: w.acceptedStatement,
    sourceCaseId: w.sourceCaseId,
    supersedingCommitmentId: w.supersedingCommitmentId,
    currentSummary: w.currentSummary,
    detectorExplanation: w.detectorExplanation,
    detectorVersion: w.detectorVersion,
  };
}
