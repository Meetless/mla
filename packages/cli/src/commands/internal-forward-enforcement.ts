// `mla _internal forward-enforcement --session <sid>` -- the delivery bridge for
// hook-emitted enforcement incidents (STAR review queue, INV-ENFORCEMENT-DELIVERY-1).
//
// The PreToolUse deny hot path records an mla_enforcement_incident to the local
// events.jsonl and pushes it to the in-process forward buffer, then the short-lived
// hook process exits -- WITHOUT ever draining that buffer (recorder.ts: the buffer is
// the "only forward attempt ... there is no cross-run replay", and the deny path never
// reaches a flush before process.exit). So the incident was durable locally but never
// reached control's analytics ingest, and the console /value review queue never saw a
// real deny. This command closes that gap: fired DETACHED right after the emit
// (spawn-enforcement-forward.ts), it re-reads the session's enforcement incidents from
// events.jsonl and forwards them to control's /internal/v1/analytics/events.
//
// Idempotent by construction: control dedupes by (workspace_id, event_id) and every
// re-fire of an incident shares the deterministic event_id, so a re-run -- or a later
// generic flush that happens to include the same rows -- never double-counts a rollup.
//
// It forwards ONLY enforcement incidents, not the whole spool: the generic buffer
// forward remains the owner of every other event type; this is the one type whose emit
// hot path exits before it can flush. Scoped to --session so a deny forwards just its
// own session's incidents, not the entire local history (with no --session it forwards
// every local incident: a manual re-sync).
//
// Fail-soft: every error is swallowed and the command exits 0 (a strict argv parse
// error -> 2), so a forward can never disturb the deny it rode on.

import { CliConfig, readConfig } from "../lib/config";
import { AnalyticsEvent } from "../lib/analytics/envelope";
import { forwardEvents } from "../lib/analytics/forwarder";
import { readEvents } from "../lib/analytics/store";

export interface ForwardEnforcementDeps {
  read?: typeof readEvents;
  forward?: typeof forwardEvents;
  readCfg?: () => CliConfig | null;
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  session: string | null;
}

// --session <sid> scopes the forward to one session's incidents. Optional: with no
// flag every local enforcement incident is forwarded (a manual re-sync). An unknown
// flag is a strict error (exit 2), matching the other _internal commands.
export function parseArgs(argv: string[]): ParsedArgs {
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") {
      session = argv[++i] ?? null;
    } else if (a.startsWith("--session=")) {
      session = a.slice("--session=".length);
    } else {
      throw new Error(`Unknown flag for \`mla _internal forward-enforcement\`: ${a}`);
    }
  }
  return { session };
}

export async function runInternalForwardEnforcement(
  argv: string[],
  deps: ForwardEnforcementDeps = {},
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
    const read = deps.read ?? readEvents;
    const events = read(env);

    // The one event type whose emit hot path exits before it can flush. Scope to the
    // requested session when given; dedupe by event_id so N re-fires of one incident
    // become ONE forwarded row (control would dedupe anyway, but this keeps the POST
    // lean). First occurrence wins -- the deterministic event_id makes them equivalent.
    const byEventId = new Map<string, AnalyticsEvent>();
    for (const ev of events) {
      const e = ev as unknown as Record<string, unknown>;
      if (e.event_type !== "mla_enforcement_incident") continue;
      if (parsed.session && e.session_id !== parsed.session) continue;
      const id = typeof e.event_id === "string" ? e.event_id : "";
      if (!id) continue;
      if (!byEventId.has(id)) byEventId.set(id, ev);
    }
    const incidents = [...byEventId.values()];
    if (incidents.length === 0) {
      console.log(JSON.stringify({ forwarded: 0, reason: "no_incidents" }));
      return 0;
    }

    // No control config -> nothing to forward to (headless before init, or logged out).
    // Leave the incidents durable in the local spool; a later run can re-sync.
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
    if (!cfg) {
      console.log(JSON.stringify({ forwarded: 0, reason: "no_control_config" }));
      return 0;
    }

    // The consent gate + join-eligibility gate live inside forwardEvents; a transport
    // failure is counted, never thrown. Idempotent on control's side.
    const forward = deps.forward ?? forwardEvents;
    const result = await forward(cfg, incidents, env);
    console.log(JSON.stringify({ ...result, candidates: incidents.length }));
    return 0;
  } catch {
    // Fail-soft: a forward failure never disturbs the session that spawned it.
    console.log(JSON.stringify({ forwarded: 0, reason: "error" }));
    return 0;
  }
}
