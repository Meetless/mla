// THE FLOOR CHANNEL: the always-on rules that ride on every single turn.
//
// mla delivers governed memory through three channels and until now the dashboard
// reported one of them.
//
//   PUSH   the hook retrieves evidence and injects it       (metrics.ts)
//   PULL   the agent calls retrieve_knowledge for itself    (pull.ts)
//   FLOOR  the always-on rule block, every turn, no query   (this file)
//
// Measured over the session that prompted this: the push channel injected once in
// five turns and nothing came of it, while the floor's Premise Gate rule caught three
// false premises and a stale build, and two hand-pulls each changed a conclusion. The
// headline metric watched the one channel that did not work and could not see the two
// that did.
//
// WHAT THIS IS NOT. This is NOT a value number and it must never be read as one, or
// rendered next to one without the label. Floor DELIVERY is not floor USE: every row
// here says "these bytes rode along", and nothing on disk says whether the agent
// obeyed the rule. There is no observable event for "the agent followed a MUST", the
// way there is for a pull (a citation) or a push (a reference). Counting delivery as
// value is exactly the over-claim `mla status` was fixed for.
//
// So the contract is: report the floor as COST, name it as cost, and leave the
// reference rates as the only "did it help" numbers on the page. Three channels side
// by side, never summed, never weighted into a composite. A composite would need a
// value term for this channel, and we do not have one.
//
// NO NEW TELEMETRY. `mla_rule_injection` has been written on every turn by the rule
// meter for months; this is a read over rows that were already on disk, which is why
// it can report a 30-day history the day it ships.

import { AnalyticsEvent } from "./envelope";

export interface FloorSummary {
  /** Turns on which a rule block was assembled and delivered. */
  turns: number;
  /** Always-on rules delivered on the most recent such turn (the current floor size). */
  rules_now: number | null;
  /** Mean always-on tokens per delivering turn, rounded. The per-turn tax. */
  always_on_tokens_mean: number | null;
  /** Total always-on tokens across the window. The bill. */
  always_on_tokens_total: number;
  /** Mean scoped (path-targeted) tokens per delivering turn, rounded. */
  scoped_tokens_mean: number | null;
  /**
   * Share of delivered rule tokens that were ambient rather than targeted, 0..1.
   * 1.0 means every byte we spent on rules this window was untargeted.
   */
  always_on_share: number | null;
  /**
   * Turns whose applicable MUST could not fit the budget, so the prompt was BLOCKED
   * fail-closed. Held separately and EXCLUDED from the token means: the user paid a
   * block, not an injection, and averaging the two describes neither.
   */
  overflow_turns: number;
  /**
   * Turns whose rule COUNTS were unknowable (cache missing or too old). Their BYTES
   * are still true, so they count toward the token totals and are excluded only from
   * `rules_now`. A count of 0 on these rows means "unknown", not "zero".
   */
  degraded_turns: number;
}

export function emptyFloorSummary(): FloorSummary {
  return {
    turns: 0,
    rules_now: null,
    always_on_tokens_mean: null,
    always_on_tokens_total: 0,
    scoped_tokens_mean: null,
    always_on_share: null,
    overflow_turns: 0,
    degraded_turns: 0,
  };
}

interface RuleInjectionRow {
  always_on_tokens?: unknown;
  scoped_tokens?: unknown;
  always_on_rules?: unknown;
  overflow?: unknown;
  degraded?: unknown;
  created_at?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Summarize the floor channel over an already-windowed event list.
 *
 * Pure and defensive: a row missing a field contributes 0 for that field rather than
 * dropping the row, because the row's OTHER fields are still true and a rule-meter
 * schema that gains a field must not silently shrink the denominator of the others.
 *
 * `overflow` turns are excluded from every mean. On an overflow the assembler could
 * not deliver, so its token numbers describe an attempt, not a delivery, and folding
 * them into a per-turn average makes the average describe neither case.
 */
export function computeFloorSummary(events: AnalyticsEvent[]): FloorSummary {
  const rows = events.filter((e) => e.event_type === "mla_rule_injection") as unknown as (RuleInjectionRow & {
    created_at: string;
  })[];
  if (rows.length === 0) return emptyFloorSummary();

  const overflow = rows.filter((r) => r.overflow === true);
  const degraded = rows.filter((r) => r.degraded === true);
  const delivered = rows.filter((r) => r.overflow !== true);

  let alwaysOn = 0;
  let scoped = 0;
  for (const r of delivered) {
    alwaysOn += num(r.always_on_tokens);
    scoped += num(r.scoped_tokens);
  }
  const n = delivered.length;

  // The CURRENT floor size, read off the newest non-degraded delivering row rather
  // than averaged. "How many rules ride on my next turn" is a question about now; a
  // mean over a window that spans a rule being retired answers a different one, and
  // the retirement is precisely the kind of change someone reads this line to confirm.
  const sized = delivered
    .filter((r) => r.degraded !== true && typeof r.always_on_rules === "number")
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const rulesNow = sized.length > 0 ? num(sized[sized.length - 1].always_on_rules) : null;

  const ruleTokens = alwaysOn + scoped;
  return {
    turns: rows.length,
    rules_now: rulesNow,
    always_on_tokens_mean: n > 0 ? Math.round(alwaysOn / n) : null,
    always_on_tokens_total: alwaysOn,
    scoped_tokens_mean: n > 0 ? Math.round(scoped / n) : null,
    always_on_share: ruleTokens > 0 ? alwaysOn / ruleTokens : null,
    overflow_turns: overflow.length,
    degraded_turns: degraded.length,
  };
}
