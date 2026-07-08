// Analytics consent: the three privacy postures (spec section 9, INV-CONSENT-1).
//
// Local recording, remote ids-only analytics, and content-bearing trace upload
// are genuinely different privacy decisions; a user may want ids-only analytics
// on but content traces off. We reconcile with the EXISTING CLI kill switch
// (TELEMETRY.md) rather than inventing a parallel flag set:
//
//   MEETLESS_LOCAL_STATS   default ON   -> write ~/.meetless/events.jsonl
//   MEETLESS_TELEMETRY     default ON   -> ship ids-only events to control->PostHog
//                                          (opt-OUT via this same flag's kill-switch
//                                          role: an off-value hard-disables both planes)
//   MEETLESS_TRACE_UPLOAD  default ON*  -> content-bearing traces (Langfuse) + Sentry
//
// (*) MEETLESS_TRACE_UPLOAD's ABSENCE preserves today's trace-plane behavior so
// dogfood keeps working; the effective posture is still "off unless your server
// opts in" because control refuses with TRACING_NOT_ENABLED_FOR_WORKSPACE. The
// flag is an explicit content-trace sub-kill, independent of the analytics opt-in.
//
// The master kill switch (telemetryDisabled: MEETLESS_TELEMETRY in {off,0,false,no}
// OR truthy MEETLESS_NO_TELEMETRY) wins over BOTH remote planes.

import { telemetryDisabled } from "../observability";

function isOff(v: string | undefined): boolean {
  const t = (v || "").trim().toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

// Local jsonl recording for `mla stats`. Default ON. Only an explicit off-value
// disables it. Independent of the remote planes: `mla stats` (local) works even
// with all remote telemetry off (INV-LOCAL-STATS-1, INV-CONSENT-1).
export function localStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOff(env.MEETLESS_LOCAL_STATS);
}

// Remote ids-only analytics upload (CLI -> control -> PostHog/rollups). Default
// ON (opt-OUT), matching the trace plane: ids/counts/rates/enums/hashes only ever
// leave the machine (INV-POSTHOG-PII-1), so the product-health signal is on by
// default and a user turns it off via the existing master kill switch. There is
// NO second flag: telemetryDisabled already treats MEETLESS_TELEMETRY in
// {off,0,false,no} (and a truthy MEETLESS_NO_TELEMETRY) as the hard opt-out, so
// the only state that re-enables after an off-value is unset/absent (= ON) or an
// explicit truthy value. The first-run disclosure (mla init) and TELEMETRY.md
// state this posture and the opt-out.
export function remoteAnalyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (telemetryDisabled(env)) return false;
  return true;
}

// Content-bearing trace upload (Langfuse spans) + Sentry error reporting. The
// master kill wins; an explicit MEETLESS_TRACE_UPLOAD off-value is the content
// sub-kill; absence preserves the pre-existing trace-plane behavior (still
// server-gated downstream). This is what gates initSentry() and the trace
// flushFn at their cli.ts call sites.
export function traceUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (telemetryDisabled(env)) return false;
  return !isOff(env.MEETLESS_TRACE_UPLOAD);
}
