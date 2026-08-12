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
import { egressFetch } from "./egress/fetch";

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
  // No local default: when nothing is injected the boundary supplies the real
  // socket, so `globalThis.fetch` is named in exactly one file in the CLI.
  const fetchImpl = deps.fetchImpl;
  const timeoutMs = deps.timeoutMs ?? EMIT_TIMEOUT_MS;

  const body = {
    traceId: recap.trace_id,
    sessionId: recap.session_id,
    turnIndex: recap.turn_index,
    verdict: recap.verdict,
    // One-line footer rides as the score comment.
    footer: renderFooter(recap),
    notRunReason: recap.not_run_reason,
    // Recap -> trace metadata for drilldown. Projected FIELD BY FIELD on purpose,
    // never `recap` whole. The egress rule for this route is `passthrough`, and
    // passthrough only allowlists TOP-LEVEL body keys; a nested object rides
    // whole. So `recap,` would mean "whatever anyone adds to TurnRecap next ships
    // to intel automatically", which is precisely the forgetting the boundary
    // exists to prevent. With the projection the failure direction flips: a new
    // TurnRecap field is silently OMITTED (recoverable) instead of silently SENT
    // (not recoverable). turn-recap-emit.spec.ts pins this list against the
    // EMITTED BODY, so adding one is a visible decision, not a side effect.
    recap: {
      session_id: recap.session_id,
      turn_index: recap.turn_index,
      trace_id: recap.trace_id,
      ran: recap.ran,
      injected_floor: recap.injected_floor,
      injected_evidence: recap.injected_evidence,
      not_run_reason: recap.not_run_reason,
      enrich_latency_ms: recap.enrich_latency_ms,
      evidence_offered: recap.evidence_offered,
      offered_source_ids: recap.offered_source_ids,
      zero_results: recap.zero_results,
      coverage_gap_type: recap.coverage_gap_type,
      evidence_layer_down: recap.evidence_layer_down,
      // Ships DELIBERATELY (the projection pin makes this a decision, not a
      // side effect). It is a derived boolean, no turn content, and it is the
      // only thing that keeps an `evidence_layer_down` count in Langfuse from
      // reading resolved blips as live outages, which is the same misreading
      // this field was added to stop in the injected recap.
      evidence_layer_recovered: recap.evidence_layer_recovered,
      retrieved_count: recap.retrieved_count,
      selected_count: recap.selected_count,
      abstain_class: recap.abstain_class,
      evidence_tools_pulled: recap.evidence_tools_pulled,
      pull_count: recap.pull_count,
      referenced_source_ids: recap.referenced_source_ids,
      cited_source_ids: recap.cited_source_ids,
      // The push-path signals ride DELIBERATELY (this projection is a decision list, not a
      // spread). They are the same data class as the two ids above: source ids WE sent this
      // turn, no turn content and no file content. Shipping them is the entire point of the
      // change, because the question they answer -- has the push path been undervalued in
      // every review we have run? -- is a fleet question, and a signal that stops at one
      // laptop's local spool cannot answer it. `recap` is `dict[str, Any]` on intel's route,
      // so this needs no coordinated deploy.
      opened_source_ids: recap.opened_source_ids,
      // Ships DELIBERATELY, and it ships because `engaged_source_ids` ships. From
      // 2026-08-11 the union has a fourth input, so without this column a fleet reader sees
      // ids in `engaged` that appear in neither `referenced` nor `opened` and cannot explain
      // them. A derived union that travels without the column explaining it is how a metric
      // starts producing findings nobody can trace back to a signal.
      path_targeted_source_ids: recap.path_targeted_source_ids,
      echoed_source_ids: recap.echoed_source_ids,
      engaged_source_ids: recap.engaged_source_ids,
      // The falsifier behind an `unverified_abstain`, shipped DELIBERATELY (same
      // decision list, same data class: governed source ids, no turn content). Without
      // it a fleet reader can see that an abstention was demoted but not what demoted
      // it, and "which documents does the push path keep missing?" is exactly the
      // question the abstention population exists to answer.
      hand_pulled_source_ids: recap.hand_pulled_source_ids,
      verdict: recap.verdict,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Through the egress boundary, not straight to the socket. `fetchImpl` is
    // the SOCKET seam only: the registry classifies this body every time and
    // there is no argument that skips it, so an injected stub sees the wire
    // bytes rather than replacing the check. This emitter is exactly the seam
    // the first `\bfetch\(` audit missed, because the primitive was injected.
    const res = await egressFetch<Awaited<ReturnType<FetchLike>>>("intel", url, {
      socket: fetchImpl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.controlToken}`,
        "Content-Type": "application/json",
        // Pinned to the just-finished turn's trace, not this run's.
        "X-Trace-ID": recap.trace_id,
      },
      body,
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
