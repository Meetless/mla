import { spawnSync } from "child_process";
import * as path from "path";

import { buildDashboard, renderDashboard } from "../../../src/commands/stats";
import { AnalyticsEvent } from "../../../src/lib/analytics/envelope";
import { buildInjectPayload } from "../../../src/lib/analytics/evidence";
import { parseArgs } from "../../../src/commands/internal-evidence-inject";

// SPLIT UTILIZATION BY ROUTER INTENT.
//
// THE OBSERVATION. Over one measured session the router returned
// intent_type: "unknown" on 4 of 6 traced turns and injected anyway on 2 of them;
// both were ignored. That is either "the router cannot classify this workspace's
// prompts" or "the label is missing but the ranking was fine" -- and NOTHING in
// the telemetry could tell those apart, because the inject event never carried the
// intent at all.
//
// SO THIS MEASURES FIRST AND CHANGES NOTHING. Injection behavior on an unknown
// intent is deliberately UNTOUCHED: suppressing those injects would shrink the
// denominator and make the utilization rate rise without a single additional
// useful inject, which is the cheapest way to fake this metric. The intent rides
// on the event instead, so `mla stats` can report known vs unknown side by side
// and the suppression decision can be made from a week of data rather than from
// one session.
//
// intent_type is already computed and already on the wire: intel puts it on
// EnrichTrace and the hook already persists that trace verbatim as
// governed_kb_trace. This carries an existing field one hop further; it does not
// add a classifier.

const NOW = Date.parse("2026-06-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function inject(o: {
  id: string;
  offered: number;
  intent?: string | null;
  offeredIds?: string[];
}): AnalyticsEvent {
  return {
    event_type: "mla_evidence_inject",
    created_at: new Date(NOW - DAY).toISOString(),
    inject_id: o.id,
    evidence_offered: o.offered,
    offered_source_ids: o.offeredIds ?? [],
    intent_type: o.intent === undefined ? null : o.intent,
  } as unknown as AnalyticsEvent;
}

function outcome(id: string, referenced: boolean): AnalyticsEvent {
  return {
    event_type: "mla_evidence_outcome",
    created_at: new Date(NOW - DAY).toISOString(),
    inject_id: id,
    outcome_version: 1,
    outcome: referenced ? "used" : "ignored",
    referenced,
    referenced_source_ids: referenced ? ["NT:a"] : [],
  } as unknown as AnalyticsEvent;
}

describe("intent on the inject event", () => {
  it("buildInjectPayload carries the router intent, defaulting to null not to a guess", () => {
    const base = {
      turn_index: 1,
      evidence_offered: 1,
      offered_source_ids: ["NT:a"],
      evidence_tokens: 10,
      retrieval_confidence: "low",
      retrieval_latency_ms: 5,
      createdAtMs: NOW,
      injectId: "i1",
    };
    expect(buildInjectPayload({ ...base, intentType: "session_report" }).intent_type).toBe(
      "session_report",
    );
    expect(buildInjectPayload({ ...base, intentType: "unknown" }).intent_type).toBe("unknown");
    // An older hook that never passes the flag must record null, NOT "unknown":
    // "the router said unknown" and "nobody told us" are different facts, and
    // collapsing them would put every pre-rollout row into the unknown bucket.
    expect(buildInjectPayload(base).intent_type).toBeNull();
  });

  it("the CLI accepts --intent-type", () => {
    expect(parseArgs(["--intent-type", "session_report"]).intentType).toBe("session_report");
    expect(parseArgs([]).intentType).toBeNull();
  });
});

describe("dashboard: utilization split by known vs unknown intent", () => {
  it("splits the same population by intent without changing the headline number", () => {
    const events = [
      // known intent: 1 of 2 referenced
      inject({ id: "k1", offered: 1, intent: "session_report", offeredIds: ["NT:a"] }),
      outcome("k1", true),
      inject({ id: "k2", offered: 1, intent: "decision_query", offeredIds: ["NT:b"] }),
      outcome("k2", false),
      // unknown intent: 0 of 2 referenced (the measured shape)
      inject({ id: "u1", offered: 1, intent: "unknown", offeredIds: ["NT:c"] }),
      outcome("u1", false),
      inject({ id: "u2", offered: 1, intent: "unknown", offeredIds: ["NT:d"] }),
      outcome("u2", false),
    ];
    const d = buildDashboard(events, 30, NOW);

    // The headline is unchanged: the split is a decomposition, not a filter.
    expect(d.evidence.injects_offered).toBe(4);
    expect(d.evidence.injects_referenced).toBe(1);
    expect(d.evidence.injection_utilization).toBeCloseTo(0.25);

    expect(d.intent_split.known.injects_offered).toBe(2);
    expect(d.intent_split.known.injects_referenced).toBe(1);
    expect(d.intent_split.known.injection_utilization).toBeCloseTo(0.5);
    expect(d.intent_split.unknown.injects_offered).toBe(2);
    expect(d.intent_split.unknown.injects_referenced).toBe(0);
    expect(d.intent_split.unknown.injection_utilization).toBe(0);
  });

  it("counts an inject with NO recorded intent as unlabelled, in neither bucket", () => {
    const events = [
      inject({ id: "n1", offered: 1, intent: null, offeredIds: ["NT:a"] }),
      outcome("n1", true),
    ];
    const d = buildDashboard(events, 30, NOW);
    expect(d.intent_split.known.injects_offered).toBe(0);
    expect(d.intent_split.unknown.injects_offered).toBe(0);
    expect(d.intent_split.unlabelled).toBe(1);
    // ...but it is still in the headline, because it really did offer evidence.
    expect(d.evidence.injects_offered).toBe(1);
  });

  it("renders the split, and says so when everything is still unlabelled", () => {
    const withIntent = renderDashboard(
      buildDashboard(
        [
          inject({ id: "k1", offered: 1, intent: "session_report", offeredIds: ["NT:a"] }),
          outcome("k1", true),
          inject({ id: "u1", offered: 1, intent: "unknown", offeredIds: ["NT:b"] }),
          outcome("u1", false),
        ],
        30,
        NOW,
      ),
      false,
    );
    expect(withIntent).toContain("by router intent");
    expect(withIntent).toContain("known");
    expect(withIntent).toContain("unknown");

    // The inject carries an OUTCOME on purpose (F4, 2026-08-08). The claim under test
    // is "an inject with no intent label renders as unlabelled", and an inject with no
    // outcome is unresolved, which is censored from the split's denominator for the
    // same reason it is censored from the headline. Without the outcome this fixture
    // proved the render on an empty population, which is a different thing passing.
    const noIntent = renderDashboard(
      buildDashboard(
        [inject({ id: "n1", offered: 1, intent: null, offeredIds: ["NT:a"] }), outcome("n1", true)],
        30,
        NOW,
      ),
      false,
    );
    // An all-null window must not render "0% for unknown intent", which would read
    // as a measured failure of a bucket that has no members.
    expect(noIntent).not.toMatch(/by router intent[\s\S]*known:\s+\d/);
    expect(noIntent).toContain("not yet labelled");
  });
});

describe("the hook passes the router intent it already has", () => {
  it("forwards governed_kb_trace.intent_type to evidence-inject", () => {
    // The hook persists intel's EnrichTrace verbatim as GOVERNED_KB_TRACE_JSON and
    // already reads .primary_surface out of it for continuation routing. This
    // asserts the same source is read for the intent, so the two can never disagree.
    const hook = path.resolve(__dirname, "../../../src/hooks-template/user-prompt-submit.sh");
    const src = require("fs").readFileSync(hook, "utf8") as string;
    expect(src).toMatch(/GOVERNED_KB_TRACE_JSON[\s\S]{0,400}intent_type/);
    // The hook hands it on POSITIONALLY; common.sh owns the flag spelling (asserted
    // in the next test), so the argv contract lives in exactly one place.
    expect(src).toMatch(/spawn_evidence_inject[\s\S]{0,300}_ei_intent/);
  });

  it("common.sh spawn_evidence_inject accepts and forwards the intent argument", () => {
    const common = path.resolve(__dirname, "../../../src/hooks-template/common.sh");
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${common}" >/dev/null 2>&1; declare -f spawn_evidence_inject`,
      ],
      { encoding: "utf8", env: { ...process.env, MEETLESS_DEBUG: "0" } },
    );
    expect(r.stdout).toContain("--intent-type");
  });
});
