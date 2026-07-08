// CE0 live telemetry sink (notes/20260617-evidence-consultation-forcing-function-proposal.md §6.4 P0.2):
// the fail-soft local-append seam between the CE0 hooks and the existing generic analytics spool. The
// pure ce0-telemetry builders produce a RecordInput; this attaches the run-context envelope and appends
// it to the local jsonl via the shared recorder.
//
// Two §6.4 P0.2 invariants this seam upholds:
//   - Local-append-only: the hook NEVER makes a synchronous network call. recordAnalyticsEvent appends
//     to the local spool and buffers for the existing detached forward; remote delivery is that path's
//     job, so CE0 adds no worker, queue, or uploader.
//   - Fail-soft: a missing run context (no joinable trace/run) or a spool append fault is swallowed and
//     never throws into the turn the hook observed. The durable CE0 store write already happened; live
//     telemetry is strictly best-effort on top of it.

import { readConfig, type CliConfig } from "../config";
import { machineId } from "../analytics/store";
import { getRunId, getRunTraceId } from "../observability";
import { recordAnalyticsEvent, type RecordContext, type RecordInput } from "../analytics/recorder";

/** The turn coordinate + emission clock a CE0 event needs beyond its own payload. */
export interface Ce0EmitCoords {
  workspaceId: string;
  sessionId: string | null;
  /** Epoch ms at emission; becomes the envelope's ISO created_at/emitted_at. */
  nowMs: number;
}

/** Injection seams (all default to the real implementations; tests pin them for determinism). */
export interface Ce0EmitDeps {
  record?: typeof recordAnalyticsEvent;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  /** Defaults to the bootstrap-set run id; a joinable envelope requires it. */
  runId?: string | null;
  /** Defaults to the bootstrap-set trace id; a joinable envelope requires it. */
  traceId?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append a built CE0 RecordInput to the local analytics spool under a "hook" run-context envelope.
 * Fail-soft and local-append-only (§6.4 P0.2): if there is no joinable run/trace context the event is
 * skipped (the durable store already recorded the fact), and any fault in building or appending is
 * swallowed so a telemetry failure never disturbs the turn.
 */
export function emitCe0Event(input: RecordInput, coords: Ce0EmitCoords, deps: Ce0EmitDeps = {}): void {
  try {
    const traceId = deps.traceId ?? getRunTraceId();
    const runId = deps.runId ?? getRunId();
    // No joinable envelope -> a local line that can never join the enrichment is worse than none.
    if (!traceId || !runId) return;

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
      // The hook cannot cheaply resolve the actor cuid; prefer the configured actor when present, else
      // the hashed machine id (a workspace-scoped anonymous id, never end-user PII).
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "hook",
      now: new Date(coords.nowMs).toISOString(),
    };

    const record = deps.record ?? recordAnalyticsEvent;
    // The onError swallows a local spool append fault; the outer try swallows a buildEvent throw.
    record(ctx, input, deps.env ?? process.env, () => {
      /* fail-soft: a CE0 telemetry append must never escalate into a blocking hook. */
    });
  } catch {
    // Fail-soft (§6.4 P0.2): CE0 telemetry must never disturb the turn it observed.
  }
}
