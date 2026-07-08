import {
  selectEnforcementViews,
  type EnforcementIncidentView,
} from "../../src/commands/enforcement";

// selectEnforcementViews is the pure split behind `mla enforcement`: the --json
// machine mirror keeps every in-scope block (adjudicated included), while the human
// review queue shows only unreviewed work. This locks the regression where a stray
// unreviewed-only filter made a block a reviewer had just adjudicated (confirmed /
// false_positive) silently vanish from BOTH surfaces -- so the operator could not
// see the verdict they had just cast. Session scope narrows both; status narrows
// only the queue.

function inc(
  over: Partial<EnforcementIncidentView> & Pick<EnforcementIncidentView, "incident_id" | "review_status">,
): EnforcementIncidentView {
  return {
    enforced_tool: "Write",
    touched_surface: "docs",
    first_seen_at: "2026-06-29T00:00:00.000Z",
    last_seen_at: "2026-06-29T00:00:00.000Z",
    session_id: null,
    blocked_path: null,
    ...over,
  };
}

// A: outstanding in session S1. B: outstanding in S2. C: CONFIRMED in S1. D: FALSE
// POSITIVE in S2. So each status and each session is represented.
const A = inc({ incident_id: "A", review_status: "unreviewed", session_id: "S1" });
const B = inc({ incident_id: "B", review_status: "unreviewed", session_id: "S2" });
const C = inc({ incident_id: "C", review_status: "confirmed", session_id: "S1" });
const D = inc({ incident_id: "D", review_status: "false_positive", session_id: "S2" });
const ALL = [A, B, C, D];

const ids = (xs: EnforcementIncidentView[]) => xs.map((x) => x.incident_id).sort();

describe("selectEnforcementViews", () => {
  it("--all: the json mirror keeps adjudicated blocks; the queue is unreviewed-only", () => {
    const sel = selectEnforcementViews(ALL, { scopeToSession: false });

    // The regression guard: confirmed C and false-positive D survive to --json.
    expect(ids(sel.inScope)).toEqual(["A", "B", "C", "D"]);
    expect(sel.inScope).toContain(C);
    expect(sel.inScope).toContain(D);

    // The human queue drops everything already adjudicated.
    expect(ids(sel.queue)).toEqual(["A", "B"]);
    expect(sel.queue.every((i) => i.review_status === "unreviewed")).toBe(true);

    expect(sel.workspaceUnreviewed).toBe(2);
  });

  it("session scope narrows BOTH surfaces but still keeps the adjudicated row", () => {
    const sel = selectEnforcementViews(ALL, {
      scopeToSession: true,
      sessionId: "S1",
    });

    // Only S1 blocks, and the confirmed S1 block (C) is kept in the mirror.
    expect(ids(sel.inScope)).toEqual(["A", "C"]);
    expect(sel.inScope).toContain(C);

    // Queue is the unreviewed S1 block only.
    expect(ids(sel.queue)).toEqual(["A"]);

    // workspaceUnreviewed counts the WHOLE workspace (A + B), not just the session,
    // so the "0 here, N across the workspace" hint stays honest under session scope.
    expect(sel.workspaceUnreviewed).toBe(2);
  });

  it("session scope with an all-adjudicated session yields an empty queue but a non-empty mirror", () => {
    const onlyAdjudicated = [C, inc({ incident_id: "E", review_status: "confirmed", session_id: "S1" })];
    const sel = selectEnforcementViews(onlyAdjudicated, {
      scopeToSession: true,
      sessionId: "S1",
    });

    expect(ids(sel.inScope)).toEqual(["C", "E"]);
    expect(sel.queue).toHaveLength(0);
    expect(sel.workspaceUnreviewed).toBe(0);
  });
});
