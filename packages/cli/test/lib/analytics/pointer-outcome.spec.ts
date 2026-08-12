// The F1 kill criterion, and why it needed replacing before it could be used.
//
// The proposal (§7) said: 50 pointers fired, and if Proactive Injection Utilization has
// not cleared 15%, remove F1. These tests pin the two reasons that reading decides
// nothing, and then pin the corrected instrument.
//
// The two failure modes are asserted DIRECTLY against the real numerator rule, not
// described in a comment, so a future change that quietly re-points F1's grade at
// `referenced` fails here.

import {
  POINTER_KILL_MIN_ENGAGEMENT,
  POINTER_KILL_MIN_FIRES,
  pointerVerdict,
  referencedWithoutPointerCredit,
  scorePointerOutcomes,
  TurnEngagement,
} from "../../../src/lib/analytics/pointer-outcome";
import { PointerFire } from "../../../src/lib/evidence-pointer";

function fire(over: Partial<PointerFire> = {}): PointerFire {
  return {
    session_id: "s1",
    turn_index: 6,
    source_id: "NT:notes/a.md",
    tool: "Grep",
    matched_on: "term",
    ...over,
  };
}

function turn(over: Partial<TurnEngagement> = {}): TurnEngagement {
  return {
    session_id: "s1",
    turn_index: 6,
    referenced_source_ids: [],
    opened_source_ids: [],
    ...over,
  };
}

describe("why the proposal's kill criterion cannot decide F1", () => {
  it("MODE 1: F1's quiet success is invisible to `referenced`, and visible here", () => {
    // The agent was pointed at a note, opened it, and stopped deriving. That is F1
    // working exactly as designed.
    const fires = [fire({ source_id: "NT:notes/r2.md" })];
    const engagements = [turn({ opened_source_ids: ["NT:notes/r2.md"], referenced_source_ids: [] })];

    // `referenced` is pulled-or-cited ONLY, so the metric the proposal wanted to judge
    // F1 by scores this a zero.
    expect(engagements[0].referenced_source_ids).toHaveLength(0);

    // F1's own instrument sees it.
    const out = scorePointerOutcomes(fires, engagements);
    expect(out.pointed).toBe(1);
    expect(out.engaged).toBe(1);
    expect(out.engagement_rate).toBe(1);
  });

  it("MODE 2: engagement F1 CAUSED is quarantined, so it cannot inflate the injection rate", () => {
    // The pointer told the agent to look at NT:notes/a.md and the agent pulled it. That
    // pull is mla's own output coming back as mla's grade.
    const fires = [fire({ source_id: "NT:notes/a.md" })];
    const referenced = ["NT:notes/a.md", "NT:notes/independent.md"];

    const honest = referencedWithoutPointerCredit(referenced, ["NT:notes/a.md"]);
    expect(honest).toEqual(["NT:notes/independent.md"]);

    // And the pointer-caused half is reported on F1's ledger instead of being lost.
    const out = scorePointerOutcomes(fires, [turn({ referenced_source_ids: referenced })]);
    // Normalized by the same rule the rest of the joins use: lowercased, `.md` dropped.
    expect(out.attributed_source_ids).toContain("nt:notes/a");
  });
});

describe("scorePointerOutcomes", () => {
  it("counts an opportunity per (turn, document), not per fire", () => {
    // Two pointers at one document in one turn is ONE opportunity. Counting fires would
    // let a chattier matcher move the rate without changing any behaviour.
    const fires = [fire({ tool: "Grep" }), fire({ tool: "Read" })];
    const out = scorePointerOutcomes(fires, [turn({ opened_source_ids: ["NT:notes/a.md"] })]);
    expect(out.fires).toBe(2);
    expect(out.pointed).toBe(1);
    expect(out.engaged).toBe(1);
  });

  it("does not credit engagement from a DIFFERENT turn", () => {
    const fires = [fire({ turn_index: 6 })];
    const out = scorePointerOutcomes(fires, [turn({ turn_index: 9, opened_source_ids: ["NT:notes/a.md"] })]);
    expect(out.engaged).toBe(0);
    expect(out.engagement_rate).toBe(0);
  });

  it("does not credit engagement from a different SESSION", () => {
    const fires = [fire({ session_id: "s1" })];
    const out = scorePointerOutcomes(fires, [turn({ session_id: "s2", opened_source_ids: ["NT:notes/a.md"] })]);
    expect(out.engaged).toBe(0);
  });

  it("matches ids the way every other join does (.md and case are not identity)", () => {
    const fires = [fire({ source_id: "NT:notes/A.md" })];
    const out = scorePointerOutcomes(fires, [turn({ referenced_source_ids: ["nt:notes/a"] })]);
    expect(out.engaged).toBe(1);
  });

  it("is null, not zero, before anything has been pointed at", () => {
    // "we have not measured" and "we measured zero" are different claims, and this one
    // is going to be quoted at a kill decision.
    const out = scorePointerOutcomes([], []);
    expect(out.engagement_rate).toBeNull();
    expect(pointerVerdict(out)).toBe("undecided");
  });
});

describe("pointerVerdict: the corrected kill criterion", () => {
  const many = (n: number, engaged: number): [PointerFire[], TurnEngagement[]] => {
    const fires: PointerFire[] = [];
    const turns: TurnEngagement[] = [];
    for (let i = 0; i < n; i++) {
      fires.push(fire({ turn_index: i, source_id: `NT:notes/${i}.md` }));
      turns.push(
        turn({
          turn_index: i,
          opened_source_ids: i < engaged ? [`NT:notes/${i}.md`] : [],
        }),
      );
    }
    return [fires, turns];
  };

  it("stays undecided below the sample size", () => {
    const [f, t] = many(POINTER_KILL_MIN_FIRES - 1, 0);
    expect(pointerVerdict(scorePointerOutcomes(f, t))).toBe("undecided");
  });

  it("says REMOVE when the mechanism fired enough and changed nothing", () => {
    const [f, t] = many(POINTER_KILL_MIN_FIRES, 0);
    const out = scorePointerOutcomes(f, t);
    expect(out.pointed).toBe(POINTER_KILL_MIN_FIRES);
    expect(pointerVerdict(out)).toBe("remove");
  });

  it("says KEEP at or above the engagement floor", () => {
    const [f, t] = many(POINTER_KILL_MIN_FIRES, Math.ceil(POINTER_KILL_MIN_FIRES * POINTER_KILL_MIN_ENGAGEMENT));
    expect(pointerVerdict(scorePointerOutcomes(f, t))).toBe("keep");
  });

  it("keeps the proposal's numbers: 50 fires, 15%", () => {
    // Only WHAT is measured changed. The sample size and the bar are the owner's, and
    // moving them silently would be a different decision wearing the same name.
    expect(POINTER_KILL_MIN_FIRES).toBe(50);
    expect(POINTER_KILL_MIN_ENGAGEMENT).toBe(0.15);
  });
});

describe("referencedWithoutPointerCredit", () => {
  it("is identity when no pointer fired", () => {
    expect(referencedWithoutPointerCredit(["NT:a.md", "NT:b.md"], [])).toEqual(["NT:a.md", "NT:b.md"]);
  });

  it("removes every id a pointer named, normalized", () => {
    expect(referencedWithoutPointerCredit(["NT:notes/a.md", "NT:notes/b.md"], ["nt:notes/a"])).toEqual([
      "NT:notes/b.md",
    ]);
  });
});
