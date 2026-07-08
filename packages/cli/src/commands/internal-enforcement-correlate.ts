// `mla _internal enforcement-correlate --session <sid> --transcript <path>` -- the
// STAR "R" correlator (the result of our action). Fired DETACHED from the Stop hook
// (spawn_enforcement_correlate) at the end of every turn. It reads this session's deny
// incidents from the local events.jsonl, reconstructs what the agent did NEXT from the
// session transcript, and appends one mla_enforcement_outcome per closed deny, then
// best-effort forwards when telemetry is on.
//
// Scoped to ONE session (unlike evidence-correlate, which sweeps every session): a deny's
// follow-through is always same-session and same-turn, so we only need this session's
// transcript. The Stop hook passes both --session and --transcript.
//
// Idempotency comes from two guards, exactly like evidence-correlate: a skip-set of
// incident_ids that already have an outcome line, and the deterministic outcome event_id
// (enforcementOutcomeEventId, event-id.ts) so a re-run cannot inflate counts even across
// a race. Only TERMINAL classifications are emitted; a `pending` deny (its reaction is not
// yet in the transcript) or an `indeterminate` deny (its attempt is not locatable) derives
// no outcome and is simply re-derived, or stays blind, on a later Stop.
//
// The outcome carries the INCIDENT's trace_id + run_id + workspace_id + session_id +
// distinct_id, so it self-joins to the incident it resolves (the logical action is the
// same; control groups outcome onto incident by incident_id). It is EVIDENCE-ONLY: it
// never touches review_status (the human verdict stays orthogonal to the machine outcome).
//
// Fail-soft: every error is swallowed and the command exits 0 (a strict argv parse error
// -> 2), so closing a window can never disturb the session it spawned from.

import * as fs from "fs";
import { CliConfig, readConfig } from "../lib/config";
import { AnalyticsEvent, EnforcementOutcomePayload } from "../lib/analytics/envelope";
import { enforcementOutcomeEventId } from "../lib/analytics/event-id";
import {
  IncidentFacts,
  deriveEnforcementOutcomes,
} from "../lib/analytics/enforcement-outcome";
import { mintRunId, mintTraceId } from "../lib/observability";
import {
  RecordContext,
  flushAnalyticsEvents,
  recordAnalyticsEvent,
} from "../lib/analytics/recorder";
import { readEvents } from "../lib/analytics/store";

const ENFORCEMENT_INCIDENT_TYPE = "mla_enforcement_incident";
const ENFORCEMENT_OUTCOME_TYPE = "mla_enforcement_outcome";

export interface EnforcementCorrelateDeps {
  read?: typeof readEvents;
  // Reads the raw transcript file contents. Defaults to a fail-soft fs read.
  readTranscript?: (path: string) => string;
  record?: typeof recordAnalyticsEvent;
  flush?: typeof flushAnalyticsEvents;
  readCfg?: () => CliConfig | null;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  session: string | null;
  transcript: string | null;
}

// --session <sid> and --transcript <path> are both required for a real run; a missing one
// is a soft no-op (a malformed spawn must never disturb anything), while an UNKNOWN flag is
// a strict error (exit 2), matching the other _internal commands.
export function parseArgs(argv: string[]): ParsedArgs {
  let session: string | null = null;
  let transcript: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") {
      session = argv[++i] ?? null;
    } else if (a.startsWith("--session=")) {
      session = a.slice("--session=".length);
    } else if (a === "--transcript") {
      transcript = argv[++i] ?? null;
    } else if (a.startsWith("--transcript=")) {
      transcript = a.slice("--transcript=".length);
    } else {
      throw new Error(`Unknown flag for \`mla _internal enforcement-correlate\`: ${a}`);
    }
  }
  return { session, transcript };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Epoch ms from a stored ISO created_at (orders incidents for the order-zip). Anything
// unparseable -> 0 so the incident still participates, ordered by its id tiebreak.
function occurredMs(ev: Record<string, unknown>): number {
  const t = typeof ev.created_at === "string" ? Date.parse(ev.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export async function runInternalEnforcementCorrelate(
  argv: string[],
  deps: EnforcementCorrelateDeps = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  try {
    if (!parsed.session || !parsed.transcript) {
      console.log(JSON.stringify({ correlated: false, reason: "missing_args" }));
      return 0;
    }

    const read = deps.read ?? readEvents;
    const events = read(env) as unknown as Record<string, unknown>[];

    // This session's deny incidents (deduped by incident_id, first-wins: re-fires share
    // the deterministic event_id so they are equivalent), plus the skip-set of incidents
    // that already carry an outcome line. Warns are excluded: a warn does not block, so it
    // has no follow-through to classify.
    const incidentByn = new Map<string, Record<string, unknown>>();
    const alreadyOutcomed = new Set<string>();
    for (const ev of events) {
      if (ev.session_id !== parsed.session) continue;
      if (ev.event_type === ENFORCEMENT_INCIDENT_TYPE) {
        if (ev.decision !== "deny") continue;
        const id = str(ev.incident_id);
        if (!id) continue;
        if (!incidentByn.has(id)) incidentByn.set(id, ev);
      } else if (ev.event_type === ENFORCEMENT_OUTCOME_TYPE) {
        const id = str(ev.incident_id);
        if (id) alreadyOutcomed.add(id);
      }
    }

    if (incidentByn.size === 0) {
      console.log(JSON.stringify({ correlated: true, emitted: 0, reason: "no_incidents" }));
      return 0;
    }

    // Read + split the transcript. A missing / unreadable file falls through to the outer
    // catch and exits 0 (fail-soft): the deny stays pending and re-derives on a later Stop.
    const readTranscript = deps.readTranscript ?? ((p: string) => fs.readFileSync(p, "utf8"));
    const lines = readTranscript(parsed.transcript).split("\n");

    // The full deny set feeds the classifier (its denied-set / order-zip must see every
    // incident, including already-outcomed ones), but we emit only for the not-yet-closed.
    const facts: IncidentFacts[] = [...incidentByn.values()].map((ev) => ({
      incidentId: str(ev.incident_id) as string,
      enforcedTool: typeof ev.enforced_tool === "string" ? ev.enforced_tool : "unknown",
      blockedPath: str(ev.blocked_path),
      occurredAtMs: occurredMs(ev),
    }));
    const classified = deriveEnforcementOutcomes(facts, lines);

    const nowMs = deps.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const record = deps.record ?? recordAnalyticsEvent;

    let emitted = 0;
    let pending = 0;
    let indeterminate = 0;
    for (const c of classified) {
      if (c.status === "pending") {
        pending++;
        continue;
      }
      if (c.status === "indeterminate") {
        indeterminate++;
        continue;
      }
      if (alreadyOutcomed.has(c.incidentId)) continue; // already terminal -> idempotent skip
      const inc = incidentByn.get(c.incidentId);
      if (!inc || c.outcome === null) continue;

      // The outcome self-joins to its incident: reuse the incident's run/trace so it
      // observably belongs to the same logical action (the join key is incident_id, so a
      // minted fallback would not break the group -- buildEvent just requires non-null).
      const ctx: RecordContext = {
        workspaceId: str(inc.workspace_id),
        sessionId: parsed.session,
        distinctId: str(inc.distinct_id),
        runId: str(inc.run_id) ?? mintRunId(),
        traceId: str(inc.trace_id) ?? mintTraceId(),
        source: "hook",
        now: nowIso,
      };
      const payload: EnforcementOutcomePayload = {
        incident_id: c.incidentId,
        outcome_version: 0,
        outcome: c.outcome,
        followup_attempts: c.followupAttempts,
        retried_blocked_count: c.retriedBlockedCount,
      };
      record(
        ctx,
        {
          eventType: ENFORCEMENT_OUTCOME_TYPE,
          eventId: enforcementOutcomeEventId(c.incidentId, 0),
          payload: payload as unknown as Record<string, unknown>,
        },
        env,
      );
      alreadyOutcomed.add(c.incidentId); // guard a duplicate in the same sweep
      emitted++;
    }

    // Best-effort, telemetry-gated forward (the consent gate is inside the forwarder).
    // The Stop-hook pass flushes synchronously, so the outcome reaches control on this
    // run -- no detached re-forward needed (unlike the deny hot path, which exits first).
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
    }

    console.log(
      JSON.stringify({
        correlated: true,
        emitted,
        pending,
        indeterminate,
        total: incidentByn.size,
      }),
    );
    return 0;
  } catch {
    // Fail-soft: a correlation failure never disturbs the session that spawned it.
    console.log(JSON.stringify({ correlated: false, reason: "error" }));
    return 0;
  }
}

// Exported only so a future reader can reuse the same event-log split. Unused today.
export function splitEnforcementEvents(events: AnalyticsEvent[]): {
  incidents: Record<string, unknown>[];
  outcomedIncidentIds: Set<string>;
} {
  const incidents: Record<string, unknown>[] = [];
  const outcomedIncidentIds = new Set<string>();
  for (const ev of events as unknown as Record<string, unknown>[]) {
    if (ev.event_type === ENFORCEMENT_INCIDENT_TYPE && ev.decision === "deny") {
      incidents.push(ev);
    } else if (ev.event_type === ENFORCEMENT_OUTCOME_TYPE) {
      const id = str(ev.incident_id);
      if (id) outcomedIncidentIds.add(id);
    }
  }
  return { incidents, outcomedIncidentIds };
}
