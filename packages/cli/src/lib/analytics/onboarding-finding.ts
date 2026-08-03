// Onboarding-finding emit seam (drift-finding design §9, "What to measure").
//
// The §9 metrics were, before this file, a list of intentions. Nothing emitted a finding, so
// "share of runs producing at least one finding" had no numerator, "same-session resolution
// rate" had neither side, and the KILL METRIC (carve-out share) had no denominator at all. A
// gate that cannot be evaluated does not restrain anything; it just reads as if it does.
//
// Two rows, one per lifecycle point, are the whole instrument:
//
//   persisted  stamped by `mla enrich ingest` for each doc/code inconsistency that LANDED.
//              Its `created_at` is the clock for "time to first finding"; its `run_id` and
//              `repo_fingerprint` are the denominators for the share metrics.
//   resolved   stamped by `mla enrich resolve` when a human closes one. Carries the verdict,
//              which is the kill metric, and `minted_rule`, which separates a resolution that
//              produced governance from one that merely closed a card.
//
// Everything else §9 needs is already on the envelope every event carries: created_at,
// session_id, run_id, and the one-way repo_fingerprint (the dimension the kill rule's
// three-repository requirement and 40% cap are computed over).
//
// It mirrors enforcement-incident.ts and upholds the same two invariants:
//
//   - Local-append-only: no synchronous network call. recordAnalyticsEvent appends to the
//     local jsonl and buffers for the run's existing detached forward.
//   - Fail-soft: any fault (no config, a spool append fault, a build throw) is swallowed. A
//     telemetry fault must never fail an ingest that landed documents or a resolution that
//     minted a rule; the sidecar, not this row, is the record of what happened.
//
// The event is deliberately content-free. Nothing about WHAT the finding says rides here: no
// statement, no verified quote, no path, no commit. The `finding_id` is a truncated one-way
// hash whose only job is to join the two rows (INV-POSTHOG-PII-1, INV-OPAQUE-ID-1).

import { readConfig, type CliConfig } from "../config";
import { machineId } from "./store";
import { getRepoFingerprint, getRunId, getRunTraceId, mintRunId, mintTraceId } from "../observability";
import { deterministicEventId } from "./event-id";
import { recordAnalyticsEvent, type RecordContext } from "./recorder";
import type { OnboardingFindingPayload, OnboardingFindingVerdict } from "./envelope";
import type { FindingResolution } from "../enrichment/protocol";

// The joinable prefix of the candidate's sha256 identity. 12 hex characters, the SAME width the
// terminal prints, so an operator reading `a1a1a1a1a1a1 is already resolved as doc_stale` can
// find that exact row without a second lookup table.
export const FINDING_ID_LEN = 12;

/** The classified, PII-safe facts of one finding lifecycle point. */
export interface OnboardingFindingInput {
  /** The candidate's full sha256 identity; truncated here, never emitted whole. */
  candidateId: string;
  /**
   * The human verdict, or null when the finding merely landed. Typed as the PROTOCOL's
   * FindingResolution (not the analytics enum) on purpose: assigning it into the payload's
   * OnboardingFindingVerdict is what makes a new verdict that nobody added to the analytics
   * vocabulary a compile error instead of a resolution that quietly never gets counted.
   */
  verdict?: FindingResolution | null;
  /** True only when closing this finding actually minted a durable rule on the authority. */
  mintedRule?: boolean;
}

/** The turn coordinate + emission clock the event needs beyond its own payload. */
export interface OnboardingFindingCoords {
  workspaceId: string | null;
  sessionId: string | null;
  /** Epoch ms at emission; becomes the envelope's ISO created_at/emitted_at. */
  nowMs: number;
}

/** Injection seams (all default to the real implementations; tests pin them). */
export interface OnboardingFindingDeps {
  record?: typeof recordAnalyticsEvent;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  runId?: string | null;
  traceId?: string | null;
  repoFingerprint?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append one onboarding-finding event to the local analytics spool.
 *
 * The event_id is deterministic on (phase, finding id), so the two rows of one finding never
 * collide and a re-emission dedups on control's (workspace_id, event_id) pair rather than
 * inflating the very rate the kill rule reads. That matters concretely: `enrich ingest` is
 * resumable and re-runnable, so the same finding can be offered to this function more than
 * once across a repository's life.
 */
export function emitOnboardingFinding(
  input: OnboardingFindingInput,
  coords: OnboardingFindingCoords,
  deps: OnboardingFindingDeps = {},
): void {
  try {
    if (!input.candidateId) return;
    const phase = input.verdict ? "resolved" : "persisted";
    const findingId = input.candidateId.slice(0, FINDING_ID_LEN);

    // Both callers run inside a bootstrapped CLI invocation, so a run/trace is normally
    // ambient. Mint rather than drop if one is missing: a finding is rare and high-value, and
    // the two rows self-join on finding_id regardless of which run wrote them.
    const traceId = deps.traceId ?? getRunTraceId() ?? mintTraceId();
    const runId = deps.runId ?? getRunId() ?? mintRunId();

    const readCfg =
      deps.readCfg ??
      ((): CliConfig | null => {
        try {
          return readConfig();
        } catch {
          return null;
        }
      });
    const cfg = readCfg();
    const mId = (deps.machineId ?? machineId)();

    const ctx: RecordContext = {
      workspaceId: coords.workspaceId,
      sessionId: coords.sessionId,
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "cli",
      actorWorkspaceUserId: cfg?.actorUserId ?? null,
      repoFingerprint: deps.repoFingerprint ?? getRepoFingerprint(),
      now: new Date(coords.nowMs).toISOString(),
    };

    const verdict: OnboardingFindingVerdict | null = input.verdict ?? null;
    const payload: OnboardingFindingPayload = {
      finding_id: findingId,
      finding_phase: phase,
      finding_verdict: verdict,
      minted_rule: input.mintedRule === true,
    };

    const record = deps.record ?? recordAnalyticsEvent;
    record(
      ctx,
      {
        eventType: "mla_onboarding_finding",
        payload: payload as unknown as Record<string, unknown>,
        eventId: deterministicEventId(`onboarding-finding:${phase}:${findingId}`, 0),
      },
      deps.env ?? process.env,
      () => {
        /* fail-soft: a metrics append must never fail the ingest or the resolution it observed. */
      },
    );
  } catch {
    // Fail-soft: this row exists to measure the feature, never to be able to break it.
  }
}
