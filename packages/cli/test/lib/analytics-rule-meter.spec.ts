// The rule-injection cost meter (audit 6.G / 7.10): coercion + payload math.
//
// This is the event that answers "what do our own rules COST the user per turn". Two properties
// are load-bearing and are pinned here:
//   1. It NEVER throws. It runs inside a detached telemetry process; a garbled meter must degrade
//      to a boring zero row, never crash and never poison the payload with a NaN.
//   2. It carries numbers and booleans ONLY (INV-POSTHOG-PII-1). Control's PostHog projector is a
//      fail-closed allowlist: numbers and booleans cross by type, strings only by key. A payload
//      of pure numbers reaches the board with zero backend change, which is the whole point.

import {
  buildRuleInjectionPayload,
  coerceRuleMeter,
  estimateTokens,
  ruleInjectionEventId,
} from "../../src/lib/analytics/rule-meter";
import { RuleMeterFile } from "../../src/lib/analytics/envelope";

const FULL = {
  base_bytes: 100,
  always_on_bytes: 800,
  always_on_rules: 4,
  scoped_bytes: 200,
  scoped_rules: 1,
  scoped_configured: 6,
  avoided_bytes: 1200,
  omitted_rules: 0,
  head_bytes: 1100,
  safe_total: 2000,
  overflow: false,
  degraded: false,
  base_invariant: false,
};

describe("estimateTokens", () => {
  it("ceils, so a nonzero byte cost never rounds down to a free turn", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(8724)).toBe(2181); // the audit's measured always-on floor.
  });

  it("treats a negative byte count as zero rather than inventing a negative cost", () => {
    expect(estimateTokens(-100)).toBe(0);
  });
});

describe("coerceRuleMeter", () => {
  it("passes a well-formed meter through unchanged", () => {
    expect(coerceRuleMeter(FULL)).toEqual(FULL);
  });

  it("rejects anything that is not an object (a meter we cannot read is not a meter)", () => {
    expect(coerceRuleMeter(null)).toBeNull();
    expect(coerceRuleMeter("800")).toBeNull();
    expect(coerceRuleMeter(42)).toBeNull();
    expect(coerceRuleMeter([FULL])).toBeNull();
  });

  it("zero-fills missing fields instead of emitting undefined into the payload", () => {
    const m = coerceRuleMeter({ always_on_bytes: 800 }) as RuleMeterFile;
    expect(m.always_on_bytes).toBe(800);
    expect(m.scoped_bytes).toBe(0);
    expect(m.head_bytes).toBe(0);
    expect(m.overflow).toBe(false);
    expect(m.degraded).toBe(false);
    for (const v of Object.values(m)) expect(["number", "boolean"]).toContain(typeof v);
  });

  it("scrubs garbage numerics (NaN, negatives, fractions, strings, objects) to safe integers", () => {
    const m = coerceRuleMeter({
      base_bytes: "not a number",
      always_on_bytes: -5,
      always_on_rules: 2.7,
      scoped_bytes: NaN,
      scoped_rules: Infinity,
      scoped_configured: { nope: 1 },
      avoided_bytes: "1200",
      head_bytes: null,
    }) as RuleMeterFile;
    expect(m.base_bytes).toBe(0);
    expect(m.always_on_bytes).toBe(0);
    expect(m.always_on_rules).toBe(2); // floored, never fractional.
    expect(m.scoped_bytes).toBe(0);
    expect(m.scoped_rules).toBe(0);
    expect(m.scoped_configured).toBe(0);
    expect(m.avoided_bytes).toBe(1200); // a numeric string is still a number.
    expect(m.head_bytes).toBe(0);
  });

  it("treats the booleans as strictly true, so a truthy string never reads as an overflow", () => {
    const m = coerceRuleMeter({ overflow: "true", degraded: 1, base_invariant: "yes" }) as RuleMeterFile;
    expect(m.overflow).toBe(false);
    expect(m.degraded).toBe(false);
    expect(m.base_invariant).toBe(false);
    expect(coerceRuleMeter({ overflow: true })!.overflow).toBe(true);
    expect(coerceRuleMeter({ base_invariant: true })!.base_invariant).toBe(true);
  });
});

describe("buildRuleInjectionPayload", () => {
  it("derives tokens and the always-on share of the injected rule budget", () => {
    const p = buildRuleInjectionPayload(FULL, { turnIndex: 3 });
    expect(p.schema_version).toBe(1);
    expect(p.turn_index).toBe(3);
    expect(p.always_on_tokens).toBe(200);
    expect(p.scoped_tokens).toBe(50);
    expect(p.avoided_tokens).toBe(300);
    expect(p.head_tokens).toBe(275);
    // 800 of the 1000 injected rule bytes were the always-on tax: 8000 basis points.
    expect(p.always_on_share_bp).toBe(8000);
  });

  it("reports a 100% always-on share when scoping delivered nothing (the pure-tax turn)", () => {
    const p = buildRuleInjectionPayload({ ...FULL, scoped_bytes: 0, scoped_rules: 0 }, { turnIndex: 0 });
    expect(p.always_on_share_bp).toBe(10000);
  });

  it("prices the base-invariant turn as pure tax: the floor rode, nothing scoped could", () => {
    // The floor alone blew the budget, so the assembler never ran: the fallback shipped the floor
    // and every scoped rule was forfeited. 100% of the injected rule budget was the always-on tax.
    const p = buildRuleInjectionPayload(
      { ...FULL, scoped_bytes: 0, scoped_rules: 0, avoided_bytes: 0, base_invariant: true },
      { turnIndex: 2 },
    );
    expect(p.base_invariant).toBe(true);
    expect(p.degraded).toBe(false); // the counts are known, so cost tiles must keep this row.
    expect(p.always_on_share_bp).toBe(10000);
    expect(p.avoided_tokens).toBe(0);
  });

  it("does not divide by zero when the turn carried no rules at all", () => {
    const p = buildRuleInjectionPayload(
      { ...FULL, always_on_bytes: 0, scoped_bytes: 0, degraded: true },
      { turnIndex: null },
    );
    expect(p.always_on_share_bp).toBe(0);
    expect(p.turn_index).toBeNull();
    expect(p.degraded).toBe(true);
  });

  it("emits numbers and booleans only, so control's fail-closed projector passes it whole", () => {
    const p = buildRuleInjectionPayload(FULL, { turnIndex: 7 });
    for (const [k, v] of Object.entries(p)) {
      if (k === "turn_index") continue; // number | null, and null is dropped by the projector.
      expect(["number", "boolean"]).toContain(typeof v);
    }
  });
});

describe("ruleInjectionEventId", () => {
  it("is deterministic per (session, turn) so a re-fired hook dedupes instead of double-charging", () => {
    const a = ruleInjectionEventId("sess-1", 4);
    const b = ruleInjectionEventId("sess-1", 4);
    expect(a).toBe(b);
  });

  it("separates turns and sessions (each priced turn is its own row)", () => {
    expect(ruleInjectionEventId("sess-1", 4)).not.toBe(ruleInjectionEventId("sess-1", 5));
    expect(ruleInjectionEventId("sess-1", 4)).not.toBe(ruleInjectionEventId("sess-2", 4));
    // A null turn index is keyed as turn 0, not as "no key at all".
    expect(ruleInjectionEventId("sess-1", null)).toBe(ruleInjectionEventId("sess-1", 0));
  });

  it("falls back to a random id with no session, preferring a possible dupe over a dropped row", () => {
    const a = ruleInjectionEventId(null, 4);
    const b = ruleInjectionEventId(null, 4);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
