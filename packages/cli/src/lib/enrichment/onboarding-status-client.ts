// The ONE client for intel's onboarding-marker status probe, in both of its grains.
//
//   GET /internal/v1/onboarding/status?workspaceId=<ws>[&headCommit=<sha>]
//
// COMMIT grain (headCommit passed): "was THIS commit onboarded". The gate `enrich plan`
// consults after its local plan-digest gate misses, so a teammate's clone at the same
// HEAD is stopped from dumping LLM-drifted near-duplicate PENDING candidates, while an
// advanced repo still onboards its delta.
//
// WORKSPACE grain (headCommit omitted): "was this workspace EVER onboarded". A LEVEL
// condition, which is what `activate` needs to decide whether to hand off to the onboard
// skill. The commit grain cannot answer it: it reads false at every commit but the marked
// one, so an activate keyed on it would nag on every new HEAD forever.
//
// The two callers want OPPOSITE things from a failure, so this returns a tri-state and
// lets each decide:
//   - `enrich plan` fails OPEN (unknown -> proceed): an unreachable intel must never
//     BLOCK onboarding.
//   - `activate` fails QUIET (unknown -> say nothing): a nudge is not a gate, and a
//     network hiccup must not turn a one-shot hand-off into a nag.
import { intelGet } from "../http";
import type { KbCliConfig } from "../config";

export interface OnboardingMarkerStatus {
  // true / false from intel; null when we could not get an answer (offline, 5xx,
  // un-authed). NEVER conflate null with false: that is the whole point of the type.
  onboarded: boolean | null;
  completedAt?: string;
  candidatesPersisted?: number;
}

// `timeoutMs` defaults to intelGet's own 10s. The SessionStart nudge overrides it far
// lower: it runs before EVERY session and only decides whether to print one paragraph,
// so a slow intel must cost the user a moment, not ten seconds. A timeout lands in the
// same place as any other failure, `onboarded: null`, which every caller treats as unknown.
export async function fetchOnboardingStatus(
  cfg: KbCliConfig,
  opts: { headCommit?: string | null; timeoutMs?: number } = {},
): Promise<OnboardingMarkerStatus> {
  try {
    const q = new URLSearchParams({ workspaceId: cfg.workspaceId });
    // Omitted entirely (not sent empty) when absent: an empty headCommit would fail the
    // route's min_length validation rather than selecting the workspace grain.
    if (opts.headCommit) q.set("headCommit", opts.headCommit);
    const res = await intelGet<{ onboarded?: boolean; completedAt?: string; candidatesPersisted?: number }>(
      cfg,
      `/internal/v1/onboarding/status?${q.toString()}`,
      opts.timeoutMs,
    );
    return {
      onboarded: !!res.onboarded,
      completedAt: res.completedAt,
      candidatesPersisted: res.candidatesPersisted,
    };
  } catch {
    return { onboarded: null }; // unknown, NOT false
  }
}
