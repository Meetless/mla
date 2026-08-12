// M1 (session d779aeaa, 2026-08-09): a floor rule can leave the snapshot silently.
//
// THE MEASURED SYMPTOM. Two `[SHOULD]` rules were in turn 1's floor and gone by turn 7,
// and the only thing that said so was `analyze.py`, which diffs snapshots ACROSS turns
// after the session is over. Inside the session the block said:
//
//   "This block is the current MLA floor snapshot except best-effort [SHOULD] rules
//    that did not fit this turn"
//
// so the agent was told that SOMETHING may be missing and never WHAT. Three states
// collapse into that one string, and they do not mean the same thing:
//
//   dropped for budget this turn   still governing; it rides again on a shorter prompt
//   retired by a human            no longer governing; stop obeying it
//   never existed                 nothing to obey
//
// A channel that can silently shrink is not a contract, and the failure is invisible
// from inside the session: an agent cannot miss what it was never shown.
//
// THE PREMISE THE PROPOSAL GOT WRONG, checked against the code before any of this was
// written. It said "a rule id is the prerequisite and the floor has no stable id today".
// The floor has had one all along: `FloorRuleEntry.ruleId` (scan.ts `ruleIdOf`: the
// governed rule-node id, else the directive's content hash), and `assembleContext`
// ALREADY records every budget drop as `{ ruleId, reason: "best-effort:did-not-fit" }`.
// Nothing here mints an identity primitive; the renderer is simply handed the entries it
// was previously handed only a COUNT of.
//
// WHY IT QUOTES TEXT AND NOT THAT ID. `floor-delta.ts` settled this once already, for
// the sibling surface: "the id answers 'which row changed' and the agent needs 'which
// obligation changed'". Neither the agent nor the analyzer can resolve a rule id to its
// statement today (`mla rules activity` prints ids without text), so a bare id would be
// a dead handle. Same convention, same helper, same 120-character quote — one omission
// vocabulary across both surfaces rather than two that drift.
//
// WHAT THIS DOES NOT TOUCH: the budget policy. Whether `[SHOULD]` should be droppable at
// all is a separate decision with its own evidence (the proposal's option B), and the two
// rules dropped in d779aeaa were genuinely irrelevant to that session. The finding is
// that the drop was invisible, and that is the only thing fixed here.

import { assembleContext, AssembleInput } from "../../../src/lib/scanner/assemble";
import { floorDelta, renderFloorDelta } from "../../../src/lib/scanner/floor-delta";
import {
  FLOOR_PRECEDENCE_SENTENCE,
  FLOOR_PRECEDENCE_SENTENCE_PARTIAL,
  renderFloorBlock,
} from "../../../src/lib/scanner/render";
import { FloorRuleEntry } from "../../../src/lib/scanner/types";

const MUST: FloorRuleEntry = {
  ruleId: "fm1",
  versionId: "v1",
  text: "Work directly on main; never create feature branches. Commit frequently.",
  strength: "MUST",
};
// The two rules that actually left the snapshot in d779aeaa, verbatim.
const LOOPBACK: FloorRuleEntry = {
  ruleId: "fs-loopback",
  versionId: "v1",
  text: "Prefer 127.0.0.1 over localhost on macOS, because Node resolves localhost to ::1 first and can reach the wrong process.",
  strength: "SHOULD",
};
const SERVICES: FloorRuleEntry = {
  ruleId: "fs-services",
  versionId: "v1",
  text: "The active backend services are control, connector, worker, relay, and intel.",
  strength: "SHOULD",
};

const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  base: "workspace_hint: ws_test",
  prompt: "",
  floorRules: [],
  scopedRules: [],
  explicitPaths: [],
  workingSetPaths: [],
  safeTotal: 1800,
  ...over,
});

describe("M1: the three states of a missing floor rule are distinguishable on the wire", () => {
  it("PRESENT: says nothing extra when every configured floor rule rode", () => {
    const xml = renderFloorBlock([MUST], [LOOPBACK], [LOOPBACK]);
    expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE);
    expect(xml).not.toContain("withheld");
    expect(xml).toContain("Prefer 127.0.0.1");
  });

  it("BUDGET-OMITTED: names the rule that did not fit, and says it still governs", () => {
    const xml = renderFloorBlock([MUST], [], [LOOPBACK]);
    expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
    // The whole point: the reader can see WHICH obligation is missing...
    expect(xml).toContain("Prefer 127.0.0.1");
    // ...and that it was withheld, not withdrawn.
    expect(xml).toMatch(/still governing/i);
    expect(xml).toMatch(/not retired/i);
  });

  it("RETIRED: a rule no longer in the configured floor is not announced as withheld", () => {
    // Turn N+1 after a human retired the rule: it is not in `allShould` at all, so there
    // is nothing withheld and the block is complete. Claiming an omission here would be
    // the same defect pointed the other way.
    const xml = renderFloorBlock([MUST], [], []);
    expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE);
    expect(xml).not.toContain("Prefer 127.0.0.1");
    expect(xml).not.toMatch(/withheld/i);
  });

  it("the budget-omitted and retired blocks are not the same bytes", () => {
    // The regression in one line. Before this change both rendered identically, which is
    // exactly why the audit could only see the difference from outside the session.
    expect(renderFloorBlock([MUST], [], [LOOPBACK])).not.toBe(renderFloorBlock([MUST], [], []));
  });
});

describe("M1: the omission line is bounded and its count is exact", () => {
  it("quotes one rule and counts all of them", () => {
    const xml = renderFloorBlock([MUST], [], [LOOPBACK, SERVICES]);
    expect(xml).toContain("2 ");
    expect(xml).toContain("Prefer 127.0.0.1");
    expect(xml).toContain("+1 more");
  });

  it("does not grow without bound as the withheld set grows", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...LOOPBACK,
      ruleId: `fs-${i}`,
      text: `Rule number ${i}: ${"padding ".repeat(40)}`,
    }));
    const one = renderFloorBlock([MUST], [], [LOOPBACK]);
    const forty = renderFloorBlock([MUST], [], many);
    // Forty withheld rules cost a two-digit count and a "+39 more", not forty statements.
    expect(forty.length).toBeLessThan(one.length + 40);
    expect(forty).toContain("+39 more");
  });

  it("costs zero bytes on a turn that withheld nothing", () => {
    const should = [LOOPBACK];
    expect(renderFloorBlock([MUST], should, should)).toBe(renderFloorBlock([MUST], should));
  });
});

describe("M1: the assembler names what its own budget dropped", () => {
  // The real path, not the renderer in isolation: `safeTotal` is set below the required
  // set so the greedy fill has no slack and every `[SHOULD]` loses.
  const out = assembleContext(
    input({ floorRules: [MUST, LOOPBACK, SERVICES], safeTotal: 1 }),
  );

  it("drops both SHOULD rules for budget", () => {
    expect(out.omitted.map((o) => o.ruleId).sort()).toEqual(["fs-loopback", "fs-services"]);
    expect(out.omitted.every((o) => o.reason === "best-effort:did-not-fit")).toBe(true);
  });

  it("and the block the agent reads names them", () => {
    expect(out.text).toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
    expect(out.text).toMatch(/still governing/i);
    expect(out.text).toContain("Prefer 127.0.0.1");
    expect(out.text).toContain("+1 more");
  });

  it("the omission line is INSIDE the budget, not appended after trimming", () => {
    // The reviewer's constraint, and the one that decides where this line is computed.
    // An omission report appended after the fill would violate the very budget the fill
    // exists to enforce; because it is rendered by `renderFloorBlock`, every greedy trial
    // measures the block that would actually be emitted, including this line.
    const budget = Math.max(out.meter.headBytes, 1);
    expect(out.bytes).toBeLessThanOrEqual(budget);
    expect(out.bytes).toBe(out.meter.headBytes);
  });

  it("a turn with slack rides both rules and says nothing about withholding", () => {
    const roomy = assembleContext(input({ floorRules: [MUST, LOOPBACK, SERVICES], safeTotal: 4000 }));
    expect(roomy.omitted).toEqual([]);
    expect(roomy.text).toContain(FLOOR_PRECEDENCE_SENTENCE);
    expect(roomy.text).not.toMatch(/still governing/i);
  });
});

describe("M1: across turns, a budget drop cannot be mistaken for a retirement", () => {
  // THE MULTI-TURN REGRESSION. Both events remove a rule from what the agent is handed.
  // They must have different signatures, and the signature has to be readable from the
  // two things a turn actually emits: the floor block, and the recap's floor delta.
  const turn1 = {
    block: renderFloorBlock([MUST], [LOOPBACK], [LOOPBACK]),
    floor: [MUST, LOOPBACK],
    delivered: new Set(["fm1", "fs-loopback"]),
    omitted: new Set<string>(),
  };

  // Turn 2, BUDGET: the rule is still configured, it just lost the byte contest.
  const budgetTurn = {
    block: renderFloorBlock([MUST], [], [LOOPBACK]),
    floor: [MUST, LOOPBACK],
    delivered: new Set(["fm1"]),
    omitted: new Set(["fs-loopback"]),
  };

  // Turn 2, RETIRED: a human withdrew it, so it is not in the configured floor at all.
  const retiredTurn = {
    block: renderFloorBlock([MUST], [], []),
    floor: [MUST],
    delivered: new Set(["fm1"]),
    omitted: new Set<string>(),
  };

  const delta = (next: typeof budgetTurn) =>
    renderFloorDelta(
      floorDelta(turn1.floor, next.floor, {
        prev: turn1.delivered,
        prevOmitted: turn1.omitted,
        curr: next.delivered,
        currOmitted: next.omitted,
      }),
    );

  it("BUDGET: the block names it as withheld and the delta stays silent", () => {
    // The delta is silent BY DESIGN (floor-delta I3): a rule that lost the byte contest
    // was not withdrawn, so announcing "-1 removed" would be a false alarm on every
    // budget flip. That silence is exactly why the floor block has to say it instead.
    expect(budgetTurn.block).toContain("Prefer 127.0.0.1");
    expect(budgetTurn.block).toMatch(/still governing/i);
    expect(delta(budgetTurn)).toBeNull();
  });

  it("RETIRED: the delta announces the removal and the block claims no withholding", () => {
    expect(retiredTurn.block).not.toContain("Prefer 127.0.0.1");
    expect(retiredTurn.block).toContain(FLOOR_PRECEDENCE_SENTENCE);
    expect(delta(retiredTurn)).toContain("removed");
    expect(delta(retiredTurn)).toContain("Prefer 127.0.0.1");
  });

  it("the two turns are distinguishable on EVERY channel the agent reads", () => {
    expect(budgetTurn.block).not.toBe(retiredTurn.block);
    expect(delta(budgetTurn)).not.toBe(delta(retiredTurn));
  });
});
