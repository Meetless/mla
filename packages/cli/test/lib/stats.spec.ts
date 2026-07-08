// `mla stats` -- the usefulness-first local dashboard (spec §7, §10.5). These
// tests drive buildDashboard with hand-built event arrays (no fs), so the window
// math, the pending model (INV-LOCAL-STATS-2), and the evidence-section alias
// (INV-ADOPTION-SOURCE-1) are all asserted hermetically.

import { AnalyticsEvent } from "../../src/lib/analytics/envelope";
import {
  buildDashboard,
  GlobalRollup,
  parseStatsArgs,
  renderDashboard,
  runStats,
} from "../../src/commands/stats";
import { MetricFamily } from "../../src/lib/analytics/metrics";
import {
  RecordContext,
  RecordInput,
  peekBuffer,
  recordAnalyticsEvent,
  resetRecorderForTesting,
} from "../../src/lib/analytics/recorder";
import { resetRunIdForTesting, setRunId, setRunTraceId } from "../../src/lib/observability";

const NOW = Date.parse("2026-06-07T12:00:00.000Z");
const TRACE = "0123456789abcdef0123456789abcdef";
const DAY = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

// Flat event builders (envelope + payload at one level, as stored in jsonl). Only
// the fields the dashboard reads are required; the rest are filled to satisfy the
// reader and cast through unknown to the discriminated union.
function inject(
  opts: { id: string; createdMsAgo: number; offered: number; offeredIds?: string[] },
): AnalyticsEvent {
  return {
    event_type: "mla_evidence_inject",
    created_at: isoAgo(opts.createdMsAgo),
    inject_id: opts.id,
    evidence_offered: opts.offered,
    offered_source_ids: opts.offeredIds ?? [],
  } as unknown as AnalyticsEvent;
}

function outcome(
  opts: {
    id: string;
    createdMsAgo: number;
    outcome: "used" | "ignored" | "unknown";
    referenced: boolean;
    referencedIds?: string[];
    version?: number;
  },
): AnalyticsEvent {
  return {
    event_type: "mla_evidence_outcome",
    created_at: isoAgo(opts.createdMsAgo),
    inject_id: opts.id,
    outcome_version: opts.version ?? 1,
    outcome: opts.outcome,
    referenced: opts.referenced,
    referenced_source_ids: opts.referencedIds ?? [],
  } as unknown as AnalyticsEvent;
}

function coverageGap(type: string, createdMsAgo: number): AnalyticsEvent {
  return {
    event_type: "mla_coverage_gap",
    created_at: isoAgo(createdMsAgo),
    coverage_gap_type: type,
  } as unknown as AnalyticsEvent;
}

function command(name: string, createdMsAgo: number): AnalyticsEvent {
  return {
    event_type: "mla_command",
    created_at: isoAgo(createdMsAgo),
    command: name,
  } as unknown as AnalyticsEvent;
}

function enforcement(opts: {
  incidentId: string;
  createdMsAgo: number;
  decision?: "deny" | "warn";
  tool?: "Write" | "Edit" | "unknown";
  reviewStatus?: "unreviewed" | "confirmed" | "false_positive";
}): AnalyticsEvent {
  return {
    event_type: "mla_enforcement_incident",
    created_at: isoAgo(opts.createdMsAgo),
    incident_id: opts.incidentId,
    decision: opts.decision ?? "deny",
    enforced_tool: opts.tool ?? "Write",
    touched_surface: "docs",
    rule_version_id: "rv_test",
    review_status: opts.reviewStatus ?? "unreviewed",
  } as unknown as AnalyticsEvent;
}

// A correlated STAR's-R outcome for a deny incident. Its created_at may post-date the
// incident (the correlator emits on a later Stop), so tests can stamp it "in the future".
function enforcementOutcome(opts: {
  incidentId: string;
  createdMsAgo: number;
}): AnalyticsEvent {
  return {
    event_type: "mla_enforcement_outcome",
    created_at: isoAgo(opts.createdMsAgo),
    incident_id: opts.incidentId,
    outcome: "complied_redirected",
    outcome_version: 0,
  } as unknown as AnalyticsEvent;
}

describe("parseStatsArgs", () => {
  it("defaults to a 30d window, no section", () => {
    const a = parseStatsArgs([]);
    expect(a.section).toBeNull();
    expect(a.windowDays).toBe(30);
    expect(a.json).toBe(false);
    expect(a.verbose).toBe(false);
  });

  it("parses --window 7d and bare-integer days", () => {
    expect(parseStatsArgs(["--window", "7d"]).windowDays).toBe(7);
    expect(parseStatsArgs(["--window", "90"]).windowDays).toBe(90);
  });

  it("rejects a non-positive / malformed window", () => {
    expect(() => parseStatsArgs(["--window", "0d"])).toThrow();
    expect(() => parseStatsArgs(["--window", "abc"])).toThrow();
    expect(() => parseStatsArgs(["--window"])).toThrow();
  });

  it("selects the evidence section and passes the rest through", () => {
    const a = parseStatsArgs(["evidence", "--all", "--json"]);
    expect(a.section).toBe("evidence");
    expect(a.rest).toEqual(["--all", "--json"]);
  });

  it("rejects an unknown section and an unknown flag", () => {
    expect(() => parseStatsArgs(["bogus"])).toThrow();
    expect(() => parseStatsArgs(["--nope"])).toThrow();
  });
});

describe("buildDashboard", () => {
  it("computes the evidence metric family from inject + outcome events", () => {
    const events = [
      inject({ id: "i1", createdMsAgo: 2 * DAY, offered: 2, offeredIds: ["NT:a", "NT:b"] }),
      outcome({ id: "i1", createdMsAgo: 2 * DAY, outcome: "used", referenced: true, referencedIds: ["NT:a"] }),
      inject({ id: "i2", createdMsAgo: 1 * DAY, offered: 3, offeredIds: ["NT:c", "NT:d", "NT:e"] }),
      outcome({ id: "i2", createdMsAgo: 1 * DAY, outcome: "ignored", referenced: false }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.injections).toBe(2);
    expect(d.evidence.injects_offered).toBe(2);
    expect(d.evidence.injects_referenced).toBe(1);
    expect(d.evidence.injection_utilization).toBeCloseTo(0.5);
    expect(d.evidence.reference_precision_v1).toBeCloseTo(0.5); // 1 used / (1 used + 1 ignored)
    expect(d.evidence.used).toBe(1);
    expect(d.evidence.ignored).toBe(1);
  });

  it("counts a still-pending inject in the denominator, never drops it (INV-LOCAL-STATS-2)", () => {
    const events = [
      inject({ id: "p1", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] }), // no outcome yet
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.injections).toBe(1);
    expect(d.evidence.pending).toBe(1);
    expect(d.evidence.injects_offered).toBe(1); // stays in denominator
    expect(d.evidence.injects_referenced).toBe(0);
    expect(d.evidence.injection_utilization).toBe(0); // 0/1, not n/a, not dropped
    expect(d.evidence.reference_precision_v1).toBeNull(); // no closed window
    expect(d.evidence.closed_windows).toBe(0);
  });

  it("windows the inject denominator but attaches a late-closing outcome by id", () => {
    const events = [
      // inject just inside the 30d window; its outcome closed 1 minute "in the future"
      // relative to render -- must still attach (not undercounted).
      inject({ id: "edge", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] }),
      outcome({ id: "edge", createdMsAgo: -60_000, outcome: "used", referenced: true, referencedIds: ["NT:a"] }),
      // inject well outside the window -> excluded entirely.
      inject({ id: "old", createdMsAgo: 60 * DAY, offered: 1, offeredIds: ["NT:z"] }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.injections).toBe(1); // only "edge"
    expect(d.evidence.used).toBe(1); // its future-stamped outcome still attached
    expect(d.evidence.injection_utilization).toBe(1);
  });

  it("prefers the highest outcome_version when an inject was recomputed", () => {
    const events = [
      inject({ id: "v", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] }),
      outcome({ id: "v", createdMsAgo: 1 * DAY, outcome: "ignored", referenced: false, version: 1 }),
      outcome({ id: "v", createdMsAgo: 1 * DAY, outcome: "used", referenced: true, referencedIds: ["NT:a"], version: 2 }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.evidence.used).toBe(1);
    expect(d.evidence.ignored).toBe(0);
  });

  it("sorts coverage gaps by demand and totals them", () => {
    const events = [
      coverageGap("no_candidate_found", 1 * DAY),
      coverageGap("no_candidate_found", 2 * DAY),
      coverageGap("permission_filtered", 1 * DAY),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.coverage_gaps_total).toBe(3);
    expect(d.coverage_gaps[0]).toEqual({ type: "no_candidate_found", count: 2 });
    expect(d.coverage_gaps[1]).toEqual({ type: "permission_filtered", count: 1 });
  });

  it("ranks load-bearing knowledge and collapses ids by normId", () => {
    const events = [
      inject({ id: "i1", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:foo.md"] }),
      outcome({ id: "i1", createdMsAgo: 1 * DAY, outcome: "used", referenced: true, referencedIds: ["NT:foo.md"] }),
      inject({ id: "i2", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:foo"] }),
      outcome({ id: "i2", createdMsAgo: 1 * DAY, outcome: "used", referenced: true, referencedIds: ["NT:foo"] }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.load_bearing).toHaveLength(1); // "NT:foo.md" and "NT:foo" collapse
    expect(d.load_bearing[0].reference_count).toBe(2);
  });

  it("tallies the command activity footnote", () => {
    const events = [command("ask", 1 * DAY), command("ask", 1 * DAY), command("kb", 1 * DAY)];
    const d = buildDashboard(events, 30, NOW);
    expect(d.commands_total).toBe(3);
    expect(d.commands_by_name[0]).toEqual({ command: "ask", count: 2 });
  });

  it("summarizes governed-rule denies with the honest review-status split and tool drilldown", () => {
    const events = [
      enforcement({ incidentId: "e1", createdMsAgo: 1 * DAY, tool: "Write", reviewStatus: "unreviewed" }),
      enforcement({ incidentId: "e2", createdMsAgo: 2 * DAY, tool: "Edit", reviewStatus: "confirmed" }),
      enforcement({ incidentId: "e3", createdMsAgo: 3 * DAY, tool: "Write", reviewStatus: "false_positive" }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.total).toBe(3);
    expect(d.enforcement.denied).toBe(3);
    expect(d.enforcement.warned).toBe(0);
    expect(d.enforcement.confirmed).toBe(1);
    expect(d.enforcement.false_positive).toBe(1);
    expect(d.enforcement.unreviewed).toBe(1);
    expect(d.enforcement.by_tool).toEqual([
      { tool: "Write", count: 2 },
      { tool: "Edit", count: 1 },
    ]);
  });

  it("collapses a re-labeled incident by incident_id so a labeler flip never double-counts", () => {
    const events = [
      // v0 born unreviewed, then an offline labeler supersedes it to false_positive.
      enforcement({ incidentId: "dup", createdMsAgo: 2 * DAY, reviewStatus: "unreviewed" }),
      enforcement({ incidentId: "dup", createdMsAgo: 1 * DAY, reviewStatus: "false_positive" }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.total).toBe(1); // one incident, not two
    expect(d.enforcement.false_positive).toBe(1); // latest verdict wins
    expect(d.enforcement.unreviewed).toBe(0);
  });

  it("windows denies on the incident's first occurrence and excludes out-of-window incidents", () => {
    const events = [
      enforcement({ incidentId: "in", createdMsAgo: 5 * DAY }),
      enforcement({ incidentId: "old", createdMsAgo: 60 * DAY }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.total).toBe(1);
  });

  it("reports zero denies as an explicit zero summary, never undefined", () => {
    const d = buildDashboard([], 30, NOW);
    expect(d.enforcement.total).toBe(0);
    expect(d.enforcement.denied).toBe(0);
    expect(d.enforcement.by_tool).toEqual([]);
  });

  it("splits denies into correlated (resolved) vs blind (unclassified) by outcome id", () => {
    const events = [
      enforcement({ incidentId: "e1", createdMsAgo: 2 * DAY }),
      enforcement({ incidentId: "e2", createdMsAgo: 1 * DAY }),
      enforcement({ incidentId: "e3", createdMsAgo: 1 * DAY }),
      // Only e1 was correlated; e2/e3 stayed blind (session never Stopped again, etc.).
      enforcementOutcome({ incidentId: "e1", createdMsAgo: 1 * DAY }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.denied).toBe(3);
    expect(d.enforcement.resolved).toBe(1);
    expect(d.enforcement.unclassified).toBe(2);
    // The split is exhaustive over denies -- no deny is dropped or double-counted.
    expect((d.enforcement.resolved ?? 0) + (d.enforcement.unclassified ?? 0)).toBe(
      d.enforcement.denied,
    );
  });

  it("attaches a late-written outcome by id, never window-filtering the resolution", () => {
    const events = [
      // deny just inside the window; its outcome is stamped 1 minute in the "future".
      enforcement({ incidentId: "edge", createdMsAgo: 29 * DAY }),
      enforcementOutcome({ incidentId: "edge", createdMsAgo: -60_000 }),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.denied).toBe(1);
    expect(d.enforcement.resolved).toBe(1); // future-stamped outcome still attached
    expect(d.enforcement.unclassified).toBe(0);
  });

  it("does not count warns toward the follow-through split (only denies are correlated)", () => {
    const events = [enforcement({ incidentId: "w1", createdMsAgo: 1 * DAY, decision: "warn" })];
    const d = buildDashboard(events, 30, NOW);
    expect(d.enforcement.warned).toBe(1);
    expect(d.enforcement.denied).toBe(0);
    expect(d.enforcement.resolved).toBe(0);
    expect(d.enforcement.unclassified).toBe(0);
  });
});

describe("renderDashboard", () => {
  it("labels reference precision as the v1 honest wording and shows the pending count", () => {
    const events = [
      inject({ id: "p1", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] }),
    ];
    const d = buildDashboard(events, 30, NOW);
    const text = renderDashboard(d, false);
    expect(text).toContain("Reference Precision (v1)");
    expect(text).toContain("pending");
    expect(text).not.toContain("Inject Precision"); // §4.2: never call v1 that
  });

  it("only shows the activity footnote under --verbose", () => {
    const events = [command("ask", 1 * DAY)];
    const d = buildDashboard(events, 30, NOW);
    expect(renderDashboard(d, false)).not.toContain("Activity (footnote)");
    expect(renderDashboard(d, true)).toContain("Activity (footnote)");
  });

  it("renders the blocked-action count with the honest adjudication split (never sells unreviewed as a win)", () => {
    const events = [
      enforcement({ incidentId: "e1", createdMsAgo: 1 * DAY, reviewStatus: "confirmed" }),
      enforcement({ incidentId: "e2", createdMsAgo: 1 * DAY, reviewStatus: "unreviewed" }),
      enforcement({ incidentId: "e3", createdMsAgo: 1 * DAY, reviewStatus: "false_positive" }),
    ];
    const d = buildDashboard(events, 30, NOW);
    const text = renderDashboard(d, false);
    expect(text).toContain("mla blocked 3 action(s)");
    expect(text).toContain("1 confirmed correct, 1 false positive, 1 not yet reviewed");
  });

  it("surfaces the correlator blind spot: how many denies have a known follow-through", () => {
    const events = [
      enforcement({ incidentId: "e1", createdMsAgo: 1 * DAY }),
      enforcement({ incidentId: "e2", createdMsAgo: 1 * DAY }),
      enforcementOutcome({ incidentId: "e1", createdMsAgo: 1 * DAY }),
    ];
    const d = buildDashboard(events, 30, NOW);
    const text = renderDashboard(d, false);
    expect(text).toContain("follow-through: 1/2 deny outcome(s) correlated, 1 not yet classified");
  });

  it("renders an explicit empty line when nothing was blocked", () => {
    const d = buildDashboard([], 30, NOW);
    expect(renderDashboard(d, false)).toContain("No risky actions blocked by governed rules");
  });

  it("shows the per-tool breakdown only under --verbose", () => {
    const events = [enforcement({ incidentId: "e1", createdMsAgo: 1 * DAY, tool: "Edit" })];
    const d = buildDashboard(events, 30, NOW);
    expect(renderDashboard(d, false)).not.toContain("by tool:");
    expect(renderDashboard(d, true)).toContain("by tool: Edit 1");
  });
});

describe("runStats", () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("routes `mla stats evidence` to the adoption join (one code path, INV-ADOPTION-SOURCE-1)", async () => {
    const adoption = jest.fn().mockReturnValue(0);
    const code = await runStats(["evidence", "--all", "--json"], { adoption });
    expect(code).toBe(0);
    expect(adoption).toHaveBeenCalledWith(["--all", "--json"]);
  });

  it("rejects an unknown flag with exit 2", async () => {
    expect(await runStats(["--bogus"], { read: () => [], nowMs: NOW })).toBe(2);
  });

  it("routes `mla stats --turn N` to the per-turn recap (alias of `mla turn`)", async () => {
    const turn = jest.fn().mockResolvedValue(0);
    const code = await runStats(["--turn", "5"], { turn });
    expect(code).toBe(0);
    expect(turn).toHaveBeenCalledWith(["5"]);
  });

  it("`mla stats --turn` with no N delegates the latest-turn resolution to the handler", async () => {
    const turn = jest.fn().mockResolvedValue(0);
    await runStats(["--turn"], { turn });
    expect(turn).toHaveBeenCalledWith([]);
  });

  it("`mla stats --turn` carries --json and --session through to the handler", async () => {
    const turn = jest.fn().mockResolvedValue(0);
    await runStats(["--turn", "3", "--json", "--session", "sX"], { turn });
    expect(turn).toHaveBeenCalledWith(["3", "--json", "--session", "sX"]);
  });

  it("renders --json from injected events without touching disk", async () => {
    const events = [
      inject({ id: "i1", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] }),
      outcome({ id: "i1", createdMsAgo: 1 * DAY, outcome: "used", referenced: true, referencedIds: ["NT:a"] }),
    ];
    const code = await runStats(["--json"], { read: () => events, nowMs: NOW });
    expect(code).toBe(0);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed.injections).toBe(1);
    expect(printed.evidence.injection_utilization).toBe(1);
    expect(printed.window).toBe("30d");
  });

  // --- `mla stats --global` (T6.2, spec §10.4, INV-GLOBAL-UNKNOWN-1) -----------

  it("prints the unknown message (not zero) when telemetry is OFF, and never calls control", async () => {
    const fetchGlobal = jest.fn();
    // remote analytics is opt-OUT (default ON); an explicit off-value disables it.
    const code = await runStats(["--global"], { env: { MEETLESS_TELEMETRY: "off" }, fetchGlobal });
    expect(code).toBe(0);
    expect(fetchGlobal).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toBe(
      "No remote telemetry available. Local stats are still available.",
    );
  });

  it("prints the unknown message (not zero) when telemetry is ON but nothing is synced", async () => {
    const fetchGlobal = jest.fn().mockResolvedValue(rollup({ hasAnyEvents: false }));
    const code = await runStats(["--global"], { env: { MEETLESS_TELEMETRY: "on" }, fetchGlobal });
    expect(code).toBe(0);
    expect(fetchGlobal).toHaveBeenCalledWith(30);
    expect(logSpy.mock.calls[0][0]).toBe(
      "No remote telemetry available. Local stats are still available.",
    );
  });

  it("renders the server rollup when telemetry is ON and data exists (reads control, not local)", async () => {
    const fetchGlobal = jest.fn().mockResolvedValue(
      rollup({
        hasAnyEvents: true,
        workspaces: 3,
        injections: 4,
        evidence: { injection_utilization: 0.75, injects_referenced: 3, injects_offered: 4 },
      }),
    );
    // read() must NOT be consulted for --global; passing a throwing reader proves it.
    const read = () => {
      throw new Error("local jsonl must not be read for --global");
    };
    const code = await runStats(["--global", "--window", "7d"], {
      env: { MEETLESS_TELEMETRY: "1" },
      fetchGlobal,
      read,
    });
    expect(code).toBe(0);
    expect(fetchGlobal).toHaveBeenCalledWith(7);
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain("global: 3 workspaces");
    expect(out).toContain("Injection Utilization:    75%");
  });

  it("surfaces the cross-workspace blocked-action count with the honest split under --global", async () => {
    const fetchGlobal = jest.fn().mockResolvedValue(
      rollup({
        hasAnyEvents: true,
        workspaces: 2,
        enforcement: {
          total: 5,
          denied: 5,
          confirmed: 3,
          false_positive: 1,
          unreviewed: 1,
          by_tool: [{ tool: "Write", count: 4 }, { tool: "Edit", count: 1 }],
        },
      }),
    );
    const code = await runStats(["--global"], { env: { MEETLESS_TELEMETRY: "1" }, fetchGlobal });
    expect(code).toBe(0);
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain("mla blocked 5 action(s) before they ran");
    expect(out).toContain("3 confirmed correct, 1 false positive, 1 not yet reviewed");
    // Follow-through is a per-session LOCAL signal; the server rollup has no correlator, so
    // the --global view must never render it (would print a misleading all-blind zero).
    expect(out).not.toContain("follow-through");
  });

  it("emits a machine-readable unavailable marker under --global --json (never activity=0)", async () => {
    const code = await runStats(["--global", "--json"], {
      env: { MEETLESS_TELEMETRY: "off" },
      fetchGlobal: jest.fn(),
    });
    expect(code).toBe(0);
    const printed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(printed).toEqual({
      available: false,
      reason: "telemetry_off",
      message: "No remote telemetry available. Local stats are still available.",
    });
  });

  it("surfaces a control reachability failure as an error (exit 1, not a silent zero)", async () => {
    const fetchGlobal = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const code = await runStats(["--global"], { env: { MEETLESS_TELEMETRY: "on" }, fetchGlobal });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect((errSpy.mock.calls[0][0] as string)).toContain("could not reach control");
  });
});

// --- mla_stats_viewed (T7.2, spec §6.2/§7.2: "are people checking value") ------
// The emit is a value-checking signal recorded on every successful `mla stats`.
// Most cases inject the recorder seam (no build/persist) to assert the scope/window
// mapping; one case runs end-to-end through the real recorder to prove the event
// lands fully enveloped in the forward buffer (the cli.ts finalize ships it).
describe("mla_stats_viewed (T7.2 value-checking signal)", () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    resetRecorderForTesting();
  });
  afterEach(() => {
    logSpy.mockRestore();
    // Clear any run-context this block set so later tests can't accidentally
    // build + persist a stats-viewed event to the real local store.
    resetRunIdForTesting();
  });

  // Injected recorder seam: capture (ctx, input) without building or persisting.
  const capture = () => {
    const calls: Array<{ ctx: RecordContext; input: RecordInput }> = [];
    const record = ((ctx: RecordContext, input: RecordInput) => {
      calls.push({ ctx, input });
      return {} as AnalyticsEvent;
    }) as typeof recordAnalyticsEvent;
    return { calls, record };
  };

  it("records scope=local + the window label on a local stats view", async () => {
    const { calls, record } = capture();
    await runStats([], {
      read: () => [],
      nowMs: NOW,
      record,
      resolveWorkspaceId: () => "ws_test",
      env: { CLAUDE_CODE_SESSION_ID: "sess_x" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].input.eventType).toBe("mla_stats_viewed");
    expect(calls[0].input.payload).toEqual({ scope: "local", window: "30d" });
    expect(calls[0].ctx.workspaceId).toBe("ws_test");
    expect(calls[0].ctx.sessionId).toBe("sess_x");
  });

  it("records scope=global for a --global view (even when telemetry is off)", async () => {
    const { calls, record } = capture();
    await runStats(["--global"], {
      env: { MEETLESS_TELEMETRY: "off" }, // explicit opt-out -> unavailable message, but the view still counts
      fetchGlobal: jest.fn(),
      record,
      resolveWorkspaceId: () => null,
    });
    expect(calls[0].input.payload).toEqual({ scope: "global", window: "30d" });
  });

  it("passes the chosen window label through", async () => {
    const { calls, record } = capture();
    await runStats(["--window", "7d"], {
      read: () => [],
      nowMs: NOW,
      record,
      resolveWorkspaceId: () => null,
    });
    expect(calls[0].input.payload).toEqual({ scope: "local", window: "7d" });
  });

  it("records a view for the evidence section too (still value-checking)", async () => {
    const { calls, record } = capture();
    await runStats(["evidence"], { adoption: () => 0, record, resolveWorkspaceId: () => null });
    expect(calls).toHaveLength(1);
    expect(calls[0].input.payload).toEqual({ scope: "local", window: "30d" });
  });

  it("is fail-soft: a throwing recorder never breaks the stats read", async () => {
    const events = [inject({ id: "i1", createdMsAgo: 1 * DAY, offered: 1, offeredIds: ["NT:a"] })];
    const code = await runStats(["--json"], {
      read: () => events,
      nowMs: NOW,
      record: () => {
        throw new Error("disk full");
      },
      resolveWorkspaceId: () => null,
    });
    expect(code).toBe(0); // the dashboard still rendered
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).injections).toBe(1);
  });

  it("lands a fully-enveloped event in the forward buffer (end-to-end, real recorder)", async () => {
    setRunId("run_stats_x");
    setRunTraceId(TRACE);
    await runStats(["--json"], {
      read: () => [],
      nowMs: NOW,
      resolveWorkspaceId: () => "ws_test",
      // buffer-only: local stats off so nothing touches the real ~/.meetless store.
      env: { MEETLESS_LOCAL_STATS: "off", CLAUDE_CODE_SESSION_ID: "sess_x" },
    });
    const buffered = peekBuffer().filter(
      (e) => (e as unknown as Record<string, unknown>).event_type === "mla_stats_viewed",
    );
    expect(buffered).toHaveLength(1);
    const ev = buffered[0] as unknown as Record<string, unknown>;
    expect(ev.scope).toBe("local");
    expect(ev.window).toBe("30d");
    expect(ev.workspace_id).toBe("ws_test");
    expect(ev.session_id).toBe("sess_x");
    expect(ev.run_id).toBe("run_stats_x");
    expect(ev.trace_id).toBe(TRACE);
  });
});

// Build a GlobalRollup for the --global render tests. Mirrors control's
// AnalyticsRollup; overrides patch the headline fields a given test asserts.
function rollup(
  opts: {
    hasAnyEvents: boolean;
    workspaces?: number;
    injections?: number;
    evidence?: Partial<MetricFamily>;
    enforcement?: Partial<GlobalRollup["enforcement"]>;
  },
): GlobalRollup {
  const evidence: MetricFamily = {
    injection_utilization: null,
    evidence_item_utilization: null,
    reference_precision_v1: null,
    unknown_coverage: null,
    injects_offered: 0,
    injects_referenced: 0,
    distinct_offered: 0,
    distinct_referenced: 0,
    used: 0,
    ignored: 0,
    unknown: 0,
    no_opportunity: 0,
    pending: 0,
    closed_windows: 0,
    ...opts.evidence,
  };
  return {
    window_days: 30,
    workspaces: opts.workspaces ?? 0,
    has_any_events: opts.hasAnyEvents,
    generated_at: new Date(NOW).toISOString(),
    evidence,
    injections: opts.injections ?? 0,
    contradictions_surfaced: 0,
    contradictions_acted_on: 0,
    enforcement: {
      total: 0,
      denied: 0,
      warned: 0,
      confirmed: 0,
      false_positive: 0,
      unreviewed: 0,
      by_tool: [],
      ...opts.enforcement,
    },
    review_decisions: 0,
    coverage_gaps: [],
    coverage_gaps_total: 0,
  };
}
