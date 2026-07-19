// `mla _internal evidence-inject` -- emit one mla_evidence_inject analytics event.
//
// Fired DETACHED from the user-prompt-submit hook (spawn_evidence_inject) on a turn
// where mla actually injected evidence (INJECTED=true). It builds the typed,
// PII-bounded inject payload (buildInjectPayload), records it to the local
// events.jsonl immediately as the start of a pending window (the Stop-hook
// correlator closes the window later and appends mla_evidence_outcome,
// INV-CORRELATOR-1), and best-effort forwards to control when telemetry is on.
//
// It rides OFF the session's hot path: every failure is swallowed and the command
// exits 0 (except a strict argv parse error -> 2), so analytics can never disturb
// the session it spawned from.
//
// The spawn is a fresh process with NO run context, so trace_id arrives via
// --trace-id (the SAME trace as the enrichment that produced the inject, so the
// inject joins to it in Langfuse) and a fresh run_id is minted for this invocation
// (INV-RUN-1: one run_id per invocation, never derived from trace_id).

import { CliConfig, readConfig } from "../lib/config";
import { getRunTraceId, mintRunId } from "../lib/observability";
import { buildInjectPayload } from "../lib/analytics/evidence";
import {
  buildCoverageGapPayload,
  classifyCoverageGap,
  coerceTopicCategory,
  coverageGapEventId,
} from "../lib/analytics/coverage-gap";
import {
  RecordContext,
  flushAnalyticsEvents,
  recordAnalyticsEvent,
} from "../lib/analytics/recorder";
import { machineId } from "../lib/analytics/store";
import { traceUploadEnabled } from "../lib/analytics/consent";

export interface EvidenceInjectArgs {
  turnIndex: number | null;
  offered: number | null;
  offeredIds: string[];
  tokens: number;
  confidence: string;
  latencyMs: number;
  traceId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  injectId: string | null;
  // Coverage-gap signals (spec §7.5). All default-safe: the hook sets only the
  // ones it can cheaply detect, and the classifier degrades gracefully.
  retrievalError: boolean;
  permissionFiltered: boolean;
  stale: boolean;
  topicCategory: string | null;
}

export function parseArgs(argv: string[]): EvidenceInjectArgs {
  const out: EvidenceInjectArgs = {
    turnIndex: null,
    offered: null,
    offeredIds: [],
    tokens: 0,
    confidence: "low",
    latencyMs: 0,
    traceId: null,
    workspaceId: null,
    sessionId: null,
    injectId: null,
    retrievalError: false,
    permissionFiltered: false,
    stale: false,
    topicCategory: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${a} requires a value.`);
      return v;
    };
    switch (a) {
      case "--turn-index": {
        const v = Number(value());
        out.turnIndex = Number.isInteger(v) ? v : null;
        break;
      }
      case "--offered": {
        const v = Number(value());
        out.offered = Number.isFinite(v) ? v : null;
        break;
      }
      // Source ids are filename-derived (e.g. NT:20260529-notes.md) and never
      // contain commas, so a comma-separated list is unambiguous from a bash hook.
      case "--offered-ids":
        out.offeredIds = value()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--tokens": {
        const v = Number(value());
        out.tokens = Number.isFinite(v) ? v : 0;
        break;
      }
      case "--latency-ms": {
        const v = Number(value());
        out.latencyMs = Number.isFinite(v) ? v : 0;
        break;
      }
      case "--confidence":
        out.confidence = value();
        break;
      case "--trace-id":
        out.traceId = value();
        break;
      case "--workspace-id":
        out.workspaceId = value();
        break;
      case "--session-id":
        out.sessionId = value();
        break;
      case "--inject-id":
        out.injectId = value();
        break;
      // Coverage-gap signal flags. Boolean flags take no value (a retrieval that
      // errored / was permission-filtered / returned stale candidates); the
      // topic category is a closed-enum string coerced at emit time.
      case "--retrieval-error":
        out.retrievalError = true;
        break;
      case "--permission-filtered":
        out.permissionFiltered = true;
        break;
      case "--stale":
        out.stale = true;
        break;
      case "--topic-category":
        out.topicCategory = value();
        break;
      default:
        throw new Error(`Unknown flag for \`mla _internal evidence-inject\`: ${a}`);
    }
  }
  return out;
}

export interface EvidenceInjectDeps {
  record?: typeof recordAnalyticsEvent;
  flush?: typeof flushAnalyticsEvents;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  mintRunId?: () => string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runInternalEvidenceInject(
  argv: string[],
  deps: EvidenceInjectDeps = {},
): Promise<number> {
  let args: EvidenceInjectArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  try {
    const sessionId =
      args.sessionId ?? ((env.CLAUDE_CODE_SESSION_ID || "").trim() || null);
    // trace_id is mandatory for a joinable event; the spawn passes it explicitly.
    // Without one, record nothing (a local line with no trace cannot join the
    // enrichment) and no-op.
    const traceId = args.traceId ?? getRunTraceId();
    if (!traceId) {
      console.log(JSON.stringify({ recorded: false, reason: "no_trace_id" }));
      return 0;
    }

    const nowMs = deps.nowMs ?? Date.now();
    const offeredCount = args.offered ?? args.offeredIds.length;
    const payload = buildInjectPayload({
      turn_index: args.turnIndex,
      evidence_offered: offeredCount,
      offered_source_ids: args.offeredIds,
      evidence_tokens: args.tokens,
      retrieval_confidence: args.confidence,
      retrieval_latency_ms: args.latencyMs,
      createdAtMs: nowMs,
      // Content-upload consent at inject time (§6.4). Read here (the command owns env
      // access) and threaded in so buildInjectPayload stays hermetic. When false the
      // seal path never stages or POSTs a capture for this inject.
      traceUploadConsented: traceUploadEnabled(env),
      ...(args.injectId ? { injectId: args.injectId } : {}),
    });

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
    const runId = (deps.mintRunId ?? mintRunId)();

    const ctx: RecordContext = {
      workspaceId: args.workspaceId,
      sessionId,
      // The hook cannot cheaply resolve the actor cuid; prefer the configured
      // actor when present, else the hashed machine id (a workspace-scoped
      // anonymous id, never end-user PII).
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "hook",
      now: new Date(nowMs).toISOString(),
    };

    const record = deps.record ?? recordAnalyticsEvent;
    // event_id == inject_id: one inject produces exactly one inject event, so the
    // business key IS the idempotency key. A re-ship dedupes on
    // (workspace_id, inject_id) in control (§10.2, INV-REMOTE-DEDUPE-1).
    record(
      ctx,
      {
        eventType: "mla_evidence_inject",
        eventId: payload.inject_id,
        payload: payload as unknown as Record<string, unknown>,
      },
      env,
    );

    // Typed coverage gap (spec §7.5, INV-COVERAGE-GAP-1): if this inject failed
    // to help (errored / permission-filtered / empty / stale / low-confidence),
    // emit a paired mla_coverage_gap keyed to the same inject_id so `mla stats`
    // can sort the backlog by cause. A confident, non-empty retrieval classifies
    // to null and emits nothing. Reuses the inject's already-coerced confidence
    // and zero_results so the two events never disagree.
    const coverageGapType = classifyCoverageGap({
      retrievalError: args.retrievalError,
      permissionFiltered: args.permissionFiltered,
      zeroResults: payload.zero_results,
      staleOrConflicting: args.stale,
      retrievalConfidence: payload.retrieval_confidence,
    });
    if (coverageGapType) {
      record(
        ctx,
        {
          eventType: "mla_coverage_gap",
          eventId: coverageGapEventId(payload.inject_id),
          payload: buildCoverageGapPayload({
            injectId: payload.inject_id,
            coverageGapType,
            queryTopicCategory: coerceTopicCategory(args.topicCategory),
            retrievalConfidence: payload.retrieval_confidence,
            zeroResults: payload.zero_results,
          }) as unknown as Record<string, unknown>,
        },
        env,
      );
    }

    // Best-effort, bounded, telemetry-gated forward (the consent gate is inside
    // the forwarder). Skipped entirely when the run has no control config.
    if (cfg) {
      const flush = deps.flush ?? flushAnalyticsEvents;
      await flush(cfg, env);
    }

    console.log(
      JSON.stringify({
        recorded: true,
        inject_id: payload.inject_id,
        turn_index: payload.turn_index,
        offered: payload.evidence_offered,
        outcome: "pending",
        window_deadline: payload.window_deadline,
        coverage_gap_type: coverageGapType,
      }),
    );
    return 0;
  } catch {
    // Fail-soft: an inject failing to record never disturbs the session.
    console.log(JSON.stringify({ recorded: false, reason: "error" }));
    return 0;
  }
}
