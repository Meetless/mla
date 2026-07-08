// tools/meetless-agent/src/lib/active-review-runner.ts
//
// Turn-checkpoint Active Review runner (Phase 1).
//
// At a turn checkpoint the runner takes the prior turn's produced docs (the
// Active Memory records) and asks intel to detect conflicts against the
// workspace's governed knowledge, then turns the detections into advisories via
// the normative conflict-advisory policy. Two hard contracts:
//
//   advise-never-block (P6): the runner NEVER blocks, NEVER throws. Any intel
//     failure (down, timeout, 4xx/5xx) is swallowed and surfaced as a degraded
//     result with no advisories. An advisory is informational; a missing one is
//     a quiet no-op, never a turn-halting error.
//
//   dry-run only: Active Review inspects, it does NOT persist. The detect call
//     is always dryRun:true, and as a DEFENSIVE belt-and-suspenders the runner
//     treats a response that claims it persisted as a contract violation: it
//     drops the advisories and reports degraded rather than acting on detections
//     that may have mutated the graph. The intel side must honor dryRun; this is
//     the client-side guard in case it ever does not.
//
// The intel client is injected (IntelDetectClient) so the CLI can pass either a
// real HTTP client or a hermetic stub. Detections flow through
// advisoriesFromDetections so the policy lives in exactly one place.
import { ActiveMemoryRecord } from "./active-memory";
import { advisoriesFromDetections, Advisory, Detection } from "./conflict-advisory";

export interface IntelDetectClient {
  detect(req: { dryRun: true; candidates: ActiveMemoryRecord[] }): Promise<{ detections: Detection[]; persisted: boolean }>;
}

export interface RunActiveReviewArgs {
  records: ActiveMemoryRecord[];
  intel: IntelDetectClient;
  minConfidence: number;
}

export interface ActiveReviewResult {
  advisories: Advisory[];
  degraded: boolean;
}

export async function runActiveReview(args: RunActiveReviewArgs): Promise<ActiveReviewResult> {
  if (args.records.length === 0) {
    return { advisories: [], degraded: false };
  }
  try {
    const resp = await args.intel.detect({ dryRun: true, candidates: args.records });
    // Defensive: Active Review must be dry-run. A response that claims it
    // persisted is a contract violation; drop the advisories and degrade rather
    // than act on detections that may have mutated the graph.
    if (resp.persisted) {
      return { advisories: [], degraded: true };
    }
    return {
      advisories: advisoriesFromDetections(resp.detections, { minConfidence: args.minConfidence }),
      degraded: false,
    };
  } catch {
    // advise-never-block (P6): any intel failure is swallowed.
    return { advisories: [], degraded: true };
  }
}
