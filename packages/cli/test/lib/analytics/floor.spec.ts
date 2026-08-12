// The floor channel summary (F1). The load-bearing claims are (1) it reports COST and
// never invents a value term, (2) an overflow turn is held out of the per-turn means,
// and (3) `rules_now` is the CURRENT floor, not an average across a retirement.

import { AnalyticsEvent } from "../../../src/lib/analytics/envelope";
import { computeFloorSummary, emptyFloorSummary } from "../../../src/lib/analytics/floor";

const row = (over: Record<string, unknown> = {}): AnalyticsEvent =>
  ({
    event_type: "mla_rule_injection",
    created_at: "2026-08-08T00:00:00.000Z",
    always_on_tokens: 900,
    scoped_tokens: 100,
    always_on_rules: 12,
    overflow: false,
    degraded: false,
    ...over,
  }) as unknown as AnalyticsEvent;

describe("computeFloorSummary", () => {
  it("is empty when no rule block was ever delivered", () => {
    expect(computeFloorSummary([])).toEqual(emptyFloorSummary());
    // Every rate is null rather than 0: nothing was measured, which is not the same
    // fact as "the floor cost nothing".
    const e = emptyFloorSummary();
    expect(e.always_on_tokens_mean).toBeNull();
    expect(e.always_on_share).toBeNull();
    expect(e.rules_now).toBeNull();
  });

  it("reports the per-turn tax and the window bill", () => {
    const f = computeFloorSummary([row(), row(), row({ always_on_tokens: 1200 })]);
    expect(f.turns).toBe(3);
    expect(f.always_on_tokens_total).toBe(900 + 900 + 1200);
    expect(f.always_on_tokens_mean).toBe(1000);
    expect(f.scoped_tokens_mean).toBe(100);
    // 3000 ambient of 3300 rule tokens.
    expect(f.always_on_share).toBeCloseTo(3000 / 3300, 6);
  });

  it("holds an overflow turn out of every mean, and still counts it", () => {
    // An overflow means the applicable MUST did not fit and the prompt was BLOCKED.
    // The user paid a block, not an injection. Averaging its tokens with a delivery
    // produces a number that describes neither.
    const f = computeFloorSummary([row(), row({ overflow: true, always_on_tokens: 9999 })]);
    expect(f.turns).toBe(2);
    expect(f.overflow_turns).toBe(1);
    expect(f.always_on_tokens_mean).toBe(900); // the delivering turn alone
    expect(f.always_on_tokens_total).toBe(900); // the block did not bill 9999 of floor
  });

  it("reports the CURRENT floor size, not an average across a rule retirement", () => {
    // This is the whole reason the field is read off the newest row: F7 retires a
    // duplicate rule, and the number someone checks afterwards has to answer "what
    // rides on my next turn", not "what rode on average while I was deleting it".
    const f = computeFloorSummary([
      row({ created_at: "2026-08-01T00:00:00.000Z", always_on_rules: 13 }),
      row({ created_at: "2026-08-08T00:00:00.000Z", always_on_rules: 12 }),
    ]);
    expect(f.rules_now).toBe(12);
  });

  it("counts a degraded turn's BYTES but never lets it set the rule count", () => {
    // degraded means the cache could not be read, so the COUNTS read 0 and mean
    // "unknown". A tile that averaged rules-per-turn over these would report a floor
    // shrinking toward zero while nothing changed.
    const f = computeFloorSummary([
      row({ created_at: "2026-08-01T00:00:00.000Z", always_on_rules: 13 }),
      row({ created_at: "2026-08-08T00:00:00.000Z", degraded: true, always_on_rules: 0 }),
    ]);
    expect(f.degraded_turns).toBe(1);
    expect(f.rules_now).toBe(13); // the newest row that actually knew
    expect(f.always_on_tokens_total).toBe(1800); // both rows' bytes are still true
  });

  it("survives a row missing fields instead of dropping it", () => {
    // A rule-meter schema that gains a field must not silently shrink the denominator
    // of the fields that were already there.
    const f = computeFloorSummary([row(), { event_type: "mla_rule_injection", created_at: "x" } as unknown as AnalyticsEvent]);
    expect(f.turns).toBe(2);
    expect(f.always_on_tokens_total).toBe(900);
    expect(f.always_on_tokens_mean).toBe(450);
  });

  it("ignores every other event type", () => {
    const f = computeFloorSummary([
      row(),
      { event_type: "mla_evidence_inject", created_at: "x" } as unknown as AnalyticsEvent,
    ]);
    expect(f.turns).toBe(1);
  });
});
