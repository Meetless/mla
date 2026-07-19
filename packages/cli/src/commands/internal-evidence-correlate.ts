// `mla _internal evidence-correlate` -- the v1 local correlator (INV-CORRELATOR-1,
// spec sections 7.4, 10.5). Fired DETACHED from the Stop hook (spawn_evidence_correlate)
// at the end of every session. It closes every eligible PENDING inject window and
// appends one mla_evidence_outcome per closed inject to the local events.jsonl, then
// best-effort forwards when telemetry is on.
//
// It processes ALL pending injects across ALL sessions, not just the stopping one:
// a cross-session inject only closes by time_limit minutes later, and a Stop is the
// natural recompute tick. Idempotency comes from two guards: a skip-set of inject_ids
// that already have an outcome line, and the deterministic outcome event_id
// (sha256(inject_id:outcome_version), event-id.ts) so a re-run cannot inflate counts
// even across a race. An inject whose window is still open derives no outcome and
// stays pending (the ABSENCE of an outcome line, never dropped, never counted ignored).
//
// The outcome carries the INJECT's trace_id + run_id + workspace_id + session_id
// (section 11.3: the enrichment-outcome record is keyed by inject_id and stamped with
// the inject's trace/run), so the outcome joins back to the enrichment that produced
// it. The correlator is the recompute engine, not a new logical owner (INV-RUN-1: the
// outcome belongs to the inject's run).
//
// Fail-soft: every error is swallowed and the command exits 0 (a strict argv parse
// error -> 2), so closing windows can never disturb the session it spawned from.

import { CliConfig, readConfig } from "../lib/config";
import {
  buildCoverageGapPayload,
  coerceRetrievalConfidence,
  coverageGapNotUsedEventId,
} from "../lib/analytics/coverage-gap";
import {
  CURRENT_CAPTURE_CONTRACT_VERSION,
  WINDOW_TURNS,
  deriveEndedSessions,
  deriveOutcome,
  InjectRecord,
  isTerminalOutcome,
} from "../lib/analytics/evidence";
import { readCaptures, reapLocalCaptures } from "../lib/analytics/work-product-capture";
import {
  WorkProductCaptureBody,
  buildPromptsBySession,
  buildSealBody,
  postWorkProductCapture,
} from "../lib/analytics/work-product-seal";
import { traceUploadEnabled } from "../lib/analytics/consent";
import {
  McpCall,
  ReportCitation,
  parseMcpCalls,
  parseReportCitations,
} from "../lib/analytics/followthrough";
import { logsDir, readLogJsonl } from "../lib/analytics/logs";
import {
  RecordContext,
  flushAnalyticsEvents,
  recordAnalyticsEvent,
} from "../lib/analytics/recorder";
import { AnalyticsEvent } from "../lib/analytics/envelope";
import { readEvents } from "../lib/analytics/store";

// v1 takes no flags: the correlator always sweeps every pending inject across every
// session. Any argument is a strict error (exit 2), matching the other _internal
// commands. The hook calls it with no args.
export function parseArgs(argv: string[]): void {
  if (argv.length > 0) {
    throw new Error(`Unknown flag for \`mla _internal evidence-correlate\`: ${argv[0]}`);
  }
}

// Reconstruct the minimal inject view deriveOutcome needs from a stored
// mla_evidence_inject jsonl line (the event is flat: payload + envelope at one level).
function toInjectRecord(ev: Record<string, unknown>): InjectRecord {
  return {
    inject_id: typeof ev.inject_id === "string" ? ev.inject_id : "",
    session_id: typeof ev.session_id === "string" ? ev.session_id : "",
    turn_index:
      typeof ev.turn_index === "number" && Number.isFinite(ev.turn_index)
        ? ev.turn_index
        : null,
    offered_source_ids: Array.isArray(ev.offered_source_ids)
      ? (ev.offered_source_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    window_deadline: typeof ev.window_deadline === "string" ? ev.window_deadline : "",
  };
}

// Highest turn observed per session, so deriveOutcome can tell whether the full
// 3-turn window has elapsed (turn_limit). Built from every signal that advances the
// per-session turn counter: ask-traces (the true counter, every prompt), pulls,
// citations, and the inject events themselves.
function buildMaxTurnBySession(
  asks: Record<string, unknown>[],
  calls: McpCall[],
  citations: ReportCitation[],
  injects: Record<string, unknown>[],
): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (sid: unknown, turn: unknown): void => {
    if (typeof sid !== "string" || !sid) return;
    if (typeof turn !== "number" || !Number.isFinite(turn)) return;
    const cur = m.get(sid);
    if (cur === undefined || turn > cur) m.set(sid, turn);
  };
  for (const a of asks) bump(a.session_id, a.turn_index);
  for (const c of calls) bump(c.session_id, c.turn_index);
  for (const r of citations) bump(r.session_id, r.turn_index);
  for (const ev of injects) bump(ev.session_id, ev.turn_index);
  return m;
}

// Coerce an epoch-ms number or an ISO/parseable date string to epoch ms; anything
// else (null, NaN, garbage) -> null so it never participates in the max.
function tsToMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Newest observed activity timestamp per session, drawn from heterogeneous local
// logs. Each group names the records and the timestamp keys to consider on them
// (events use created_at/emitted_at; trace logs use ts). A record contributes the
// max of its present, parseable keys; a session's value is the max across all its
// records. A session with no parseable timestamp anywhere is absent (never reaped).
// Exported for the correlator test.
export function buildLastActivityBySession(
  groups: Array<{ records: Record<string, unknown>[]; keys: string[] }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of groups) {
    for (const r of g.records) {
      const sid = r.session_id;
      if (typeof sid !== "string" || !sid) continue;
      let best: number | null = null;
      for (const k of g.keys) {
        const t = tsToMs(r[k]);
        if (t !== null && (best === null || t > best)) best = t;
      }
      if (best === null) continue;
      const cur = m.get(sid);
      if (cur === undefined || best > cur) m.set(sid, best);
    }
  }
  return m;
}

export interface EvidenceCorrelateDeps {
  read?: typeof readEvents;
  readLog?: (file: string) => Record<string, unknown>[];
  record?: typeof recordAnalyticsEvent;
  flush?: typeof flushAnalyticsEvents;
  readCfg?: () => CliConfig | null;
  // Seal seams (§8/§12.1): read the local capture store and POST the atomic intake.
  readCaptures?: typeof readCaptures;
  postCapture?: (cfg: CliConfig, body: WorkProductCaptureBody) => Promise<void>;
  // Local-capture reaper seam (§11): drops staged capture files past the 48h TTL.
  reap?: typeof reapLocalCaptures;
  nowMs?: number;
  // Test seam: pin the turn window (defaults to evidence.WINDOW_TURNS inside deriveOutcome).
  window?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runInternalEvidenceCorrelate(
  argv: string[],
  deps: EvidenceCorrelateDeps = {},
): Promise<number> {
  try {
    parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  try {
    const read = deps.read ?? readEvents;
    const events = read(env) as unknown as Record<string, unknown>[];

    // Split the local event log into pending injects and the TERMINAL-only skip-set.
    // We track the latest recorded outcome per inject (highest outcome_version wins,
    // ties last seen) and skip only injects whose latest outcome is terminal
    // (used / ignored / no_opportunity). An inject whose latest outcome is the
    // provisional `unknown` -- or that has none -- is re-derived every sweep, so a
    // window that once closed blind as `unknown` is finalized once the idle reaper
    // proves its session ENDED (the re-open guard that drains the legacy backlog).
    // `gapInjectIds` is the set that already carry an inject-time mla_coverage_gap,
    // so the outcome-time `candidates_found_not_used` gap fires only when the inject
    // surfaced no gap at inject time (spec §7.5).
    const injectEvents: Record<string, unknown>[] = [];
    const latestOutcome = new Map<string, { version: number; outcome: string }>();
    const gapInjectIds = new Set<string>();
    for (const ev of events) {
      if (ev.event_type === "mla_evidence_inject") {
        injectEvents.push(ev);
      } else if (ev.event_type === "mla_evidence_outcome") {
        const id = typeof ev.inject_id === "string" ? ev.inject_id : "";
        if (!id) continue;
        const version = typeof ev.outcome_version === "number" ? ev.outcome_version : 0;
        const outcome = typeof ev.outcome === "string" ? ev.outcome : "";
        const prev = latestOutcome.get(id);
        if (!prev || version >= prev.version) latestOutcome.set(id, { version, outcome });
      } else if (ev.event_type === "mla_coverage_gap") {
        if (typeof ev.inject_id === "string" && ev.inject_id) gapInjectIds.add(ev.inject_id);
      }
    }
    const terminallyClosed = new Set<string>();
    for (const [id, latest] of latestOutcome) {
      if (isTerminalOutcome(latest.outcome)) terminallyClosed.add(id);
    }

    const readLog = deps.readLog ?? readLogJsonl;
    const asks = readLog("ask-traces.jsonl");
    // Keep the raw call/citation lines (which still carry `ts`) for the idle reaper;
    // the parsers below strip everything but session/turn/ids.
    const callLog = readLog("mcp-calls.jsonl");
    const citationLog = readLog("report-citations.jsonl");
    const calls = parseMcpCalls(callLog);
    const citations = parseReportCitations(citationLog);
    const maxTurnBySession = buildMaxTurnBySession(asks, calls, citations, injectEvents);

    const nowMs = deps.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const record = deps.record ?? recordAnalyticsEvent;

    // The idle reaper: a session totally silent for >= ABANDONED_AFTER_MS is ENDED, so
    // its deadline-closed injects can be finalized as ignored / no_opportunity instead
    // of the blind `unknown`. Last-activity is the newest timestamp across every local
    // signal the session emits: the analytics events (created_at/emitted_at) and the
    // three trace logs (ts). With no parseable timestamp a session is simply absent
    // from the map, so deriveEndedSessions never marks it ended (fail-safe: we only
    // finalize what we can positively prove is old).
    const lastActivityBySession = buildLastActivityBySession([
      { records: events, keys: ["created_at", "emitted_at"] },
      { records: asks, keys: ["ts"] },
      { records: callLog, keys: ["ts"] },
      { records: citationLog, keys: ["ts"] },
    ]);
    const endedSessions = deriveEndedSessions(lastActivityBySession, nowMs);

    const ctxBase = {
      nowMs,
      maxTurnBySession,
      endedSessions,
      ...(deps.window !== undefined ? { window: deps.window } : {}),
    };

    // Seal-on-window-close cohort (§8/§12.1). An inject that closes in `all_decided`
    // (referenced OR ignored) and is capture-capable + live-consented has its work-product
    // window sealed via ONE atomic capture-intake POST. The POSTs are DEFERRED until after
    // the flush so control has the inject row first (§10.6 step 1 authenticates the intake
    // through the inject's indexed (workspaceId, eventId) identity). Live consent is read
    // once: consent withdrawn since emit means no capture request at all (§11).
    const sealConsentLive = traceUploadEnabled(env);
    const effectiveWindow = deps.window ?? WINDOW_TURNS;
    const sealTasks: Array<{
      injectId: string;
      workspaceId: string;
      sessionId: string;
      turnIndex: number;
      captureContractVersion: number;
    }> = [];

    let closedCount = 0;
    let pendingCount = 0;
    for (const ev of injectEvents) {
      const injectId = typeof ev.inject_id === "string" ? ev.inject_id : "";
      if (!injectId || terminallyClosed.has(injectId)) continue; // already terminal -> skip

      // A stored inject must carry the run/trace it belongs to; without them the
      // outcome cannot join back to the enrichment, so leave it pending rather than
      // fabricate a join from the correlator's own run context.
      const runId = typeof ev.run_id === "string" && ev.run_id ? ev.run_id : null;
      const traceId = typeof ev.trace_id === "string" && ev.trace_id ? ev.trace_id : null;
      if (!runId || !traceId) {
        pendingCount++;
        continue;
      }

      const inject = toInjectRecord(ev);
      const derived = deriveOutcome(inject, calls, citations, ctxBase);
      if (!derived) {
        pendingCount++;
        continue;
      }

      // The blind `unknown` (deadline passed but the session is not provably ENDED)
      // is NOT a durable verdict under v3: collapse it to pending and re-derive next
      // sweep, so the idle reaper can finalize it once the session is provably dead.
      // Only terminal outcomes are emitted and counted as closed.
      if (!isTerminalOutcome(derived.payload.outcome)) {
        pendingCount++;
        continue;
      }

      const ctx: RecordContext = {
        workspaceId: typeof ev.workspace_id === "string" ? ev.workspace_id : null,
        sessionId: inject.session_id || null,
        distinctId: typeof ev.distinct_id === "string" ? ev.distinct_id : null,
        runId,
        traceId,
        source: "hook",
        now: nowIso,
      };
      record(
        ctx,
        {
          eventType: "mla_evidence_outcome",
          eventId: derived.event_id,
          payload: derived.payload as unknown as Record<string, unknown>,
        },
        env,
      );

      // Outcome-time coverage gap (spec §7.5, INV-COVERAGE-GAP-1): a confident,
      // non-empty inject that the agent had its FULL turn window to use yet
      // referenced none of is `candidates_found_not_used` (fix retrieval/ranking,
      // not capture). Gated on window_closed_reason === "turn_limit": only there was
      // the full opportunity observed. A `session_ended` close can also be `ignored`
      // (>=1 later turn) but it saw only a PARTIAL window, so it is NOT a coverage
      // gap (the agent may simply have ended before reaching the candidates). Also
      // requires candidates actually came back (not zero_results) and no inject-time
      // gap already classified this inject. The deterministic event_id + the
      // once-per-inject close make it idempotent.
      const hadCandidates = ev.zero_results !== true;
      if (
        derived.payload.outcome === "ignored" &&
        derived.payload.window_closed_reason === "turn_limit" &&
        hadCandidates &&
        !gapInjectIds.has(injectId)
      ) {
        record(
          ctx,
          {
            eventType: "mla_coverage_gap",
            eventId: coverageGapNotUsedEventId(injectId),
            payload: buildCoverageGapPayload({
              injectId,
              coverageGapType: "candidates_found_not_used",
              // The correlator cannot recover the original query topic; the
              // inject-time gap carries it when known. Default to unknown here.
              queryTopicCategory: "unknown",
              retrievalConfidence: coerceRetrievalConfidence(
                typeof ev.retrieval_confidence === "string"
                  ? ev.retrieval_confidence
                  : null,
              ),
              zeroResults: false,
            }) as unknown as Record<string, unknown>,
          },
          env,
        );
        gapInjectIds.add(injectId);
      }

      // Seal-on-window-close (§8/§12.1). A decided inject (referenced -> outcome "used",
      // or "ignored") that is capture-capable (carries a positive emit-time
      // work_product_capture_version) and consented (emit-time trace_upload_consented AND
      // live consent) is queued for one atomic capture-intake POST after the flush. A
      // referenced inject is sealed too: capture COVERAGE (§9.1) counts it in
      // capture_expected, so it must reach capture_ready. no_opportunity / unknown are
      // never sealed. The seal POST is deferred so the inject lands in control first.
      const outcome = derived.payload.outcome;
      const decided = outcome === "used" || outcome === "ignored";
      const captureVersion =
        typeof ev.work_product_capture_version === "number" &&
        Number.isInteger(ev.work_product_capture_version) &&
        ev.work_product_capture_version > 0
          ? ev.work_product_capture_version
          : null;
      if (
        decided &&
        captureVersion !== null &&
        ev.trace_upload_consented === true &&
        sealConsentLive &&
        ctx.workspaceId &&
        inject.session_id &&
        inject.turn_index !== null
      ) {
        sealTasks.push({
          injectId,
          workspaceId: ctx.workspaceId,
          sessionId: inject.session_id,
          turnIndex: inject.turn_index,
          captureContractVersion: captureVersion,
        });
      }

      // Guard against a duplicate (S, inject_id) line in the same sweep; the
      // deterministic event_id already makes a cross-process race idempotent.
      terminallyClosed.add(injectId);
      closedCount++;
    }

    // Best-effort, telemetry-gated forward (the consent gate is inside the
    // forwarder). Skipped when the run has no control config.
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
    if (cfg) {
      const flush = deps.flush ?? flushAnalyticsEvents;
      await flush(cfg, env);

      // Seal AFTER the flush so the inject row is durable in control before its capture
      // intake authenticates against it (§10.6 step 1, §12.1). One best-effort POST per
      // eligible inject: control owns idempotency + the 200/409/failed resolution, so a
      // failure here just leaves the capture local (48h reaper) and the inject as
      // capture-not-ready, which the metric reports honestly (§9.1). Never re-driven.
      if (sealTasks.length > 0) {
        const promptsBySession = buildPromptsBySession(asks);
        const readCaps = deps.readCaptures ?? readCaptures;
        const postCap = deps.postCapture ?? postWorkProductCapture;
        for (const task of sealTasks) {
          try {
            const body = buildSealBody({
              inject: {
                injectId: task.injectId,
                workspaceId: task.workspaceId,
                sessionId: task.sessionId,
                turnIndex: task.turnIndex,
              },
              captures: readCaps(task.sessionId, env),
              promptsByTurn:
                promptsBySession.get(task.sessionId) ?? new Map<number, string[]>(),
              window: effectiveWindow,
              captureContractVersion: task.captureContractVersion,
              sealedAtIso: nowIso,
            });
            await postCap(cfg, body);
          } catch {
            // Best-effort: a failed seal never disturbs the sweep.
          }
        }
      }
    }

    // Backstop reaper (§11): drop locally staged work-product captures past the 48h TTL.
    // The seal store is keyed per SESSION and shared by every inject in that session, so
    // there is no safe per-inject eager delete (a sibling inject's window may still be
    // open); this age-based sweep is the guaranteed local cleanup. It touches only the
    // work-product-capture store, never the general events file. Runs regardless of
    // control config (a machine that staged captures then logged out still gets cleaned)
    // and is fail-soft. The Stop-detached correlator is the natural recompute tick.
    try {
      const reap = deps.reap ?? reapLocalCaptures;
      reap(env, nowMs);
    } catch {
      // Best-effort: a reaper failure never disturbs the sweep.
    }

    console.log(
      JSON.stringify({
        correlated: true,
        closed: closedCount,
        pending: pendingCount,
        total: injectEvents.length,
      }),
    );
    return 0;
  } catch {
    // Fail-soft: a correlation failure never disturbs the session that spawned it.
    console.log(JSON.stringify({ correlated: false, reason: "error" }));
    return 0;
  }
}

// Exported only so a future reader (mla stats) can reuse the same event-log split.
// `closedInjectIds` is the TERMINAL-only skip-set (latest outcome is a terminal
// verdict), matching the correlator: an inject whose latest outcome is the
// provisional `unknown` is NOT closed and stays eligible for re-derivation.
export function splitEvidenceEvents(events: AnalyticsEvent[]): {
  injects: Record<string, unknown>[];
  closedInjectIds: Set<string>;
} {
  const injects: Record<string, unknown>[] = [];
  const latestOutcome = new Map<string, { version: number; outcome: string }>();
  for (const ev of events as unknown as Record<string, unknown>[]) {
    if (ev.event_type === "mla_evidence_inject") {
      injects.push(ev);
    } else if (ev.event_type === "mla_evidence_outcome") {
      const id = typeof ev.inject_id === "string" ? ev.inject_id : "";
      if (!id) continue;
      const version = typeof ev.outcome_version === "number" ? ev.outcome_version : 0;
      const outcome = typeof ev.outcome === "string" ? ev.outcome : "";
      const prev = latestOutcome.get(id);
      if (!prev || version >= prev.version) latestOutcome.set(id, { version, outcome });
    }
  }
  const closedInjectIds = new Set<string>();
  for (const [id, latest] of latestOutcome) {
    if (isTerminalOutcome(latest.outcome)) closedInjectIds.add(id);
  }
  return { injects, closedInjectIds };
}
