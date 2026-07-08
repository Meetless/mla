// Layer D emitter (notes/20260609-mla-per-turn-assist-recap-plan.md §4.4).
//
// POST a just-finished turn's recap to intel's POST /v1/observability/turn-recap
// so intel attaches the mla_ran / mla_assist Langfuse scores to that turn's
// trace. Spawned detached from stop.sh via `mla _internal turn-recap
// --emit-langfuse`; runInternalTurnRecap wires this as the default emitter.
//
// Why not the generic intelPost helper: intelPost stamps X-Trace-ID from the
// CURRENT run's trace id. Here the trace we score is the JUST-FINISHED turn's
// (recap.trace_id), which differs from this detached invocation's run id. We pin
// X-Trace-ID to recap.trace_id so header and body name the same trace and the
// endpoint's mismatch guard stays satisfied.
//
// Best-effort: a missing trace id is a silent no-op (nothing to score); any
// transport / non-2xx failure throws so the caller can swallow it without ever
// disturbing the agent. Langfuse keys live in intel, never here, so the
// soon-to-be-OSS CLI ships no observability credentials.

import { CliConfig } from "./config";
import { DEFAULT_INTEL_URL } from "./http";
import { TurnRecap, renderFooter } from "./analytics/turn-recap";

// Minimal structural fetch shape so the emitter is unit-testable with a plain
// stub and never depends on the DOM/undici lib types. The live default is
// globalThis.fetch.
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface TurnRecapEmitDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

// Detached + best-effort, so a tight deadline: the turn already ended, this only
// decorates its trace. 1.5s matches the trace-flush HTTP deadline.
const EMIT_TIMEOUT_MS = 1500;

export async function postTurnRecapToIntel(
  cfg: CliConfig,
  recap: TurnRecap,
  deps: TurnRecapEmitDeps = {},
): Promise<void> {
  // No trace id -> no Langfuse trace to attach a score to. Silent no-op.
  if (!recap.trace_id) return;

  const base = cfg.intelUrl || DEFAULT_INTEL_URL;
  const url = `${base}/v1/observability/turn-recap`;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.timeoutMs ?? EMIT_TIMEOUT_MS;

  const body = {
    traceId: recap.trace_id,
    sessionId: recap.session_id,
    turnIndex: recap.turn_index,
    verdict: recap.verdict,
    // One-line footer rides as the score comment.
    footer: renderFooter(recap),
    notRunReason: recap.not_run_reason,
    // Full recap -> trace metadata for drilldown.
    recap,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.controlToken}`,
        "Content-Type": "application/json",
        // Pinned to the just-finished turn's trace, not this run's.
        "X-Trace-ID": recap.trace_id,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `POST ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
