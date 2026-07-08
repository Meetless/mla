// Remote analytics forwarder (spec section 10.1, INV-JOIN-1, INV-CONSENT-1).
//
// Ships locally-recorded events to control, which dedupes by (workspace_id,
// event_id), lands them in control.analytics_events, rolls them up, and mirrors
// to PostHog server-side. The CLI never holds a PostHog key (INV-POSTHOG-PII-1
// is enforced server-side too, but we minimize here as well).
//
// Three gates, all of which must pass for a single event to leave the machine:
//   1. remoteAnalyticsEnabled(env)  -> the opt-in posture (master kill wins)
//   2. isRemotelyEmittable(ev)      -> has a real workspace_id + session_id to join
//   3. transport succeeds           -> control POST. A failure is swallowed (never
//                                       thrown) and counted in ForwardResult.failed;
//                                       the optional onError hook is the operator
//                                       seam. The event stays in the local jsonl
//                                       (the durable record for `mla stats`), but
//                                       the CLI does NOT re-forward it on a later
//                                       run: a control outage simply means the
//                                       global rollup never sees it, which the spec
//                                       reports as unknown rather than zero
//                                       (INV-GLOBAL-UNKNOWN-1). Forwarding is
//                                       intentionally silent to the user (no-spam);
//                                       wire onError to surface failures to an
//                                       operator.
//
// X-Trace-ID is already stamped on every control POST by buildRequestHeaders, so
// the forward inherits the run's trace_id for free.

import { CliConfig } from "../config";
import { post } from "../http";
import { remoteAnalyticsEnabled } from "./consent";
import { AnalyticsEvent, isRemotelyEmittable } from "./envelope";

export const ANALYTICS_INGEST_PATH = "/internal/v1/analytics/events";

// The forward runs at command finalize, so it must never add a long tail to a
// command's wall-clock. A short, hard bound: a slow or hung control costs at most
// this many ms before the run completes. On timeout the batch is dropped, not
// re-queued; it stays durable in the local jsonl and the global rollup tolerates
// the gap (INV-GLOBAL-UNKNOWN-1).
export const FORWARD_TIMEOUT_MS = 3000;

export interface ForwardResult {
  attempted: number;
  forwarded: number;
  skippedConsent: boolean;
  skippedNotEmittable: number;
  failed: number;
}

// Partition events into those that may be shipped and those that can't (unbound
// runs). Exported for the test contract (INV-JOIN-1: an event with a null
// workspace never ships).
export function partitionEmittable(events: AnalyticsEvent[]): {
  emittable: AnalyticsEvent[];
  withheld: AnalyticsEvent[];
} {
  const emittable: AnalyticsEvent[] = [];
  const withheld: AnalyticsEvent[] = [];
  for (const ev of events) {
    if (isRemotelyEmittable(ev)) emittable.push(ev);
    else withheld.push(ev);
  }
  return { emittable, withheld };
}

// Forward a batch of events to control. Best-effort: a transport error never
// throws (analytics must not break a command), it is counted in `failed` so the
// caller can decide whether to log it. Returns the disposition counts.
export async function forwardEvents(
  cfg: CliConfig,
  events: AnalyticsEvent[],
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
  timeoutMs: number = FORWARD_TIMEOUT_MS,
): Promise<ForwardResult> {
  const result: ForwardResult = {
    attempted: events.length,
    forwarded: 0,
    skippedConsent: false,
    skippedNotEmittable: 0,
    failed: 0,
  };

  if (!remoteAnalyticsEnabled(env)) {
    result.skippedConsent = true;
    return result;
  }

  const { emittable, withheld } = partitionEmittable(events);
  result.skippedNotEmittable = withheld.length;
  if (emittable.length === 0) return result;

  // Control's AgentReviewWorkspaceGuard authorizes ONE workspaceId per request,
  // so a batch is grouped by workspace_id and posted once per group. In practice
  // a single CLI run touches one workspace, but grouping keeps the contract honest
  // if a flush ever spans more (and isolates a per-workspace transport failure).
  for (const [workspaceId, group] of groupByWorkspace(emittable)) {
    try {
      // Control dedupes by (workspace_id, event_id), so the ingest is idempotent:
      // re-POSTing an already-landed event never double-counts a rollup
      // (INV-REMOTE-DEDUPE-1). The CLI does not auto-replay across runs; this is
      // what would keep a future manual re-sync safe.
      await post(cfg, ANALYTICS_INGEST_PATH, { workspaceId, events: group }, timeoutMs);
      result.forwarded += group.length;
    } catch (err) {
      result.failed += group.length;
      if (onError) onError(err);
    }
  }
  return result;
}

// Group emittable events by their workspace_id. Every event here passed
// isRemotelyEmittable, so workspace_id is a non-empty string; the cast is safe.
function groupByWorkspace(
  events: AnalyticsEvent[],
): Map<string, AnalyticsEvent[]> {
  const groups = new Map<string, AnalyticsEvent[]>();
  for (const ev of events) {
    const ws = ev.workspace_id as string;
    const existing = groups.get(ws);
    if (existing) existing.push(ev);
    else groups.set(ws, [ev]);
  }
  return groups;
}
