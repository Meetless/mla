import { computeActivation } from "../../src/commands/stats";
import type { AnalyticsEvent } from "../../src/lib/analytics/envelope";

// An's ruling, 2026-08-08: "MLA activation = the first agent turn carrying repo-scoped governed
// state or repo-derived evidence." The narrowing is the whole point, so these tests pin the
// EXCLUSION as hard as the inclusion: a floor-only turn must never activate a workspace, because
// the floor is generic and delivering it proves nothing was learned about this repository.
const ev = (over: Record<string, unknown>): AnalyticsEvent =>
  ({ schema_version: 1, source: "cli", ...over }) as unknown as AnalyticsEvent;

describe("computeActivation", () => {
  it("does NOT activate on floor-only injections, however many turns run", () => {
    const out = computeActivation([
      ev({ event_type: "mla_command", command: "activate", created_at: "2026-08-01T10:00:00.000Z" }),
      ev({ event_type: "mla_rule_injection", scoped_rules: 0, created_at: "2026-08-01T10:05:00.000Z" }),
      ev({ event_type: "mla_rule_injection", scoped_rules: 0, created_at: "2026-08-02T10:05:00.000Z" }),
    ]);
    expect(out.activated).toBe(false);
    expect(out.via).toBeNull();
    expect(out.minutes_to_activation).toBeNull();
  });

  it("activates on the first SCOPED rule and measures from the first command", () => {
    const out = computeActivation([
      ev({ event_type: "mla_command", command: "activate", created_at: "2026-08-01T10:00:00.000Z" }),
      ev({ event_type: "mla_rule_injection", scoped_rules: 0, created_at: "2026-08-01T10:05:00.000Z" }),
      ev({ event_type: "mla_rule_injection", scoped_rules: 2, created_at: "2026-08-01T10:30:00.000Z" }),
    ]);
    expect(out.activated).toBe(true);
    expect(out.via).toBe("scoped_rule");
    expect(out.first_governed_turn_at).toBe("2026-08-01T10:30:00.000Z");
    expect(out.minutes_to_activation).toBe(30);
  });

  it("activates on evidence, and reports the EARLIEST qualifying turn when both exist", () => {
    const out = computeActivation([
      ev({ event_type: "mla_command", command: "doctor", created_at: "2026-08-01T10:00:00.000Z" }),
      ev({ event_type: "mla_rule_injection", scoped_rules: 5, created_at: "2026-08-01T12:00:00.000Z" }),
      ev({ event_type: "mla_evidence_inject", created_at: "2026-08-01T11:00:00.000Z" }),
    ]);
    expect(out.via).toBe("evidence");
    expect(out.first_governed_turn_at).toBe("2026-08-01T11:00:00.000Z");
    expect(out.minutes_to_activation).toBe(60);
  });

  it("reports no duration rather than a negative one when the spool is pruned or skewed", () => {
    // A governed turn stamped before the first surviving command row. The workspace IS activated;
    // the CLOCK is what we lost, and inventing a negative time to value would be worse than silence.
    const out = computeActivation([
      ev({ event_type: "mla_command", command: "stats", created_at: "2026-08-05T10:00:00.000Z" }),
      ev({ event_type: "mla_evidence_inject", created_at: "2026-08-01T10:00:00.000Z" }),
    ]);
    expect(out.activated).toBe(true);
    expect(out.minutes_to_activation).toBeNull();
  });

  it("is empty-safe and ignores rows with no usable timestamp", () => {
    expect(computeActivation([]).activated).toBe(false);
    const out = computeActivation([ev({ event_type: "mla_evidence_inject", created_at: "" })]);
    expect(out.activated).toBe(false);
  });
});
