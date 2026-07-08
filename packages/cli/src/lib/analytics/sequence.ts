// Per-session command sequence fields (spec section 6.2: command_index_in_session,
// preceded_by, session_idle_gap_ms). These unlock PostHog path analysis (section
// 8: the `preceded_by` Sankey) without any second on-disk tracker: the local
// events.jsonl is already the single source of truth for `mla stats`, so the
// prior commands of a session are simply the `mla_command` rows that already
// carry the same session_id. Deriving from the jsonl keeps one source of truth
// and cannot drift from what `mla stats` sees.
//
// Computed BEFORE the current event is appended, so the rows read here are the
// strictly-prior commands of this session.

import { AnalyticsEvent } from "./envelope";
import { readEvents } from "./store";

export interface SequenceInfo {
  command_index_in_session: number | null;
  preceded_by: string | null;
  session_idle_gap_ms: number | null;
}

// Sequence fields are null for an unbound run (no session to order within).
const NO_SEQUENCE: SequenceInfo = {
  command_index_in_session: null,
  preceded_by: null,
  session_idle_gap_ms: null,
};

function eventMillis(ev: AnalyticsEvent): number | null {
  const raw = ev.emitted_at || ev.created_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

// Derive the sequence fields for the command about to be recorded. `readEvents`
// is the injectable read so a test can drive it off a tmp MEETLESS_HOME; when
// local stats are off it returns [], which correctly yields index 1 / no
// predecessor (we have no local working set to order against).
export function computeSequence(
  sessionId: string | null,
  commandStartedAtMs: number,
  env: NodeJS.ProcessEnv = process.env,
): SequenceInfo {
  if (!sessionId) return NO_SEQUENCE;

  const prior: AnalyticsEvent[] = [];
  for (const ev of readEvents(env)) {
    if (ev.event_type === "mla_command" && ev.session_id === sessionId) {
      prior.push(ev);
    }
  }

  // 1-based position of this command in the session.
  const index = prior.length + 1;

  if (prior.length === 0) {
    // First command of the session: no predecessor, no idle gap to measure.
    return {
      command_index_in_session: index,
      preceded_by: null,
      session_idle_gap_ms: null,
    };
  }

  // The immediately-preceding command is the latest prior row by ship time.
  let latest: AnalyticsEvent = prior[0];
  let latestMs = eventMillis(prior[0]);
  for (const ev of prior) {
    const ms = eventMillis(ev);
    if (ms !== null && (latestMs === null || ms >= latestMs)) {
      latest = ev;
      latestMs = ms;
    }
  }

  const precededBy =
    typeof (latest as { command?: unknown }).command === "string"
      ? ((latest as { command?: string }).command as string)
      : null;

  // Idle gap = this command's start minus the prior command's recorded time.
  // Clamp a negative result (clock skew, out-of-order rows) to null rather than
  // emit a nonsense negative duration.
  let idleGap: number | null = null;
  if (latestMs !== null) {
    const gap = commandStartedAtMs - latestMs;
    idleGap = gap >= 0 ? gap : null;
  }

  return {
    command_index_in_session: index,
    preceded_by: precededBy,
    session_idle_gap_ms: idleGap,
  };
}
