import {
  floorDelta,
  renderFloorDelta,
  type FloorRuleRef,
} from "../../src/lib/scanner/floor-delta";
import { computeTurnRecap, renderFooter } from "../../src/lib/analytics/turn-recap";

// M6 (session 4caa06b9): a floor rule left the delivered snapshot mid-session and
// nothing said so. The duplicate Mermaid rule was in the turn-1 floor and gone by
// turn 3; the dedup was almost certainly correct, but "a rule leaving the floor is
// invisible to the only party who has to obey it" is the defect. If a rule is
// withdrawn while an agent is mid-task under it, it should hear about it.
//
// PREMISE CHECK: the proposal said this "uses a diff the hook already has". It does
// not. Nothing recorded the previously-delivered floor: the ask-traces line carries
// injected_floor as a BOOLEAN and no rule identities, and `governance` carries only
// counts. What DOES exist is assemble-audit.json, the assembler's own per-turn
// delivery receipt, which already records `delivered` with ruleId + versionId and is
// already read and written by TypeScript. So the delta is computed from the artifact
// that exists, with the rule ids that exist, and the recap quotes the rule text that
// exists. No new identifier system and no new telemetry pipeline.
//
// The correction is explicit that +n/-n alone is not enough: the line has to say
// WHICH rules moved.

const MERMAID: FloorRuleRef = {
  ruleId: "a1b2c3d4e5f6",
  text:
    "When authoring a design doc, proposal, plan, RFC, or architecture spec, include a " +
    "complete Mermaid sequence diagram for each flow, lifecycle, or state transition it describes.",
};
const MAIN_ONLY: FloorRuleRef = {
  ruleId: "0f1e2d3c4b5a",
  text: "Work directly on main; never create feature branches. Commit frequently.",
};
const PREMISE_GATE: FloorRuleRef = {
  ruleId: "998877665544",
  text: "Premise Gate: before implementing any proposed fix, prove on current main and current data that the symptom reproduces.",
};

describe("floorDelta", () => {
  it("is empty when the delivered set is unchanged", () => {
    const d = floorDelta([MERMAID, MAIN_ONLY], [MERMAID, MAIN_ONLY]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("is empty when only the ORDER changed", () => {
    const d = floorDelta([MERMAID, MAIN_ONLY], [MAIN_ONLY, MERMAID]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("reports a REMOVED rule with its identity and its text", () => {
    const d = floorDelta([MERMAID, MAIN_ONLY], [MAIN_ONLY]);
    expect(d.removed.map((r) => r.ruleId)).toEqual([MERMAID.ruleId]);
    expect(d.removed[0].text).toContain("Mermaid sequence diagram");
    expect(d.added).toEqual([]);
  });

  it("reports an ADDED rule", () => {
    const d = floorDelta([MAIN_ONLY], [MAIN_ONLY, PREMISE_GATE]);
    expect(d.added.map((r) => r.ruleId)).toEqual([PREMISE_GATE.ruleId]);
    expect(d.removed).toEqual([]);
  });

  it("reports both directions at once", () => {
    const d = floorDelta([MERMAID, MAIN_ONLY], [MAIN_ONLY, PREMISE_GATE]);
    expect(d.added.map((r) => r.ruleId)).toEqual([PREMISE_GATE.ruleId]);
    expect(d.removed.map((r) => r.ruleId)).toEqual([MERMAID.ruleId]);
  });

  it("treats a first-ever snapshot (no prior) as no delta, never as N additions", () => {
    // The first turn of a session has nothing to diff against. Announcing the whole
    // floor as "added" would be a false alarm on every single session start.
    const d = floorDelta(null, [MERMAID, MAIN_ONLY]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("a rule whose TEXT was edited under the same id is not a churn event", () => {
    // Identity is the ruleId. A reworded rule is the same obligation; reporting it as
    // +1/-1 would make every copy-edit look like a governance change.
    const reworded = { ...MERMAID, text: MERMAID.text.replace("each flow", "any flow") };
    const d = floorDelta([MERMAID], [reworded]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe("renderFloorDelta", () => {
  it("is null when nothing moved, so the recap line is untouched on a quiet turn", () => {
    expect(renderFloorDelta({ added: [], removed: [] })).toBeNull();
  });

  it("names the REMOVED rule, not just a count", () => {
    const line = renderFloorDelta({ added: [], removed: [MERMAID] });
    expect(line).not.toBeNull();
    expect(line).toContain("-1");
    // The whole point of the correction: the agent must be able to tell WHICH
    // obligation it is no longer under.
    expect(line).toContain("Mermaid");
  });

  it("names the ADDED rule", () => {
    const line = renderFloorDelta({ added: [PREMISE_GATE], removed: [] })!;
    expect(line).toContain("+1");
    expect(line).toContain("Premise Gate");
  });

  it("reports both counts and both texts", () => {
    const line = renderFloorDelta({ added: [PREMISE_GATE], removed: [MERMAID] })!;
    expect(line).toContain("+1");
    expect(line).toContain("-1");
    expect(line).toContain("Premise Gate");
    expect(line).toContain("Mermaid");
  });

  it("stays a ONE-LINE recap: compact text, no newlines, bounded length", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ruleId: `id${i}`,
      text: `Rule number ${i} with a long statement that goes on and on and on and on and on.`,
    }));
    const line = renderFloorDelta({ added: many, removed: many })!;
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThanOrEqual(400);
    // The counts stay exact even when the quoted sample is truncated: a reader must
    // never be able to mistake "3 shown" for "3 changed".
    expect(line).toContain("+6");
    expect(line).toContain("-6");
  });

  it("states the direction in words, so `-1` is never read as a score", () => {
    const line = renderFloorDelta({ added: [], removed: [MERMAID] })!;
    expect(line).toMatch(/floor/i);
    expect(line).toMatch(/removed|withdrawn|no longer/i);
  });
});

// --- the recap footer, which is the surface the correction actually names ---------

function recapWith(delta: { added: FloorRuleRef[]; removed: FloorRuleRef[] } | null) {
  return computeTurnRecap("s1", 3, {
    readLog: (f) =>
      f === "ask-traces.jsonl"
        ? [{ session_id: "s1", turn_index: 3, trace_id: "t", hook: { injected: true } }]
        : [],
    readFloorDelta: () => delta,
  });
}

describe("the recap footer carries the floor delta", () => {
  it("says nothing on a turn where the floor did not move", () => {
    const line = renderFooter(recapWith(null));
    expect(line).not.toMatch(/floor changed/);
  });

  it("names the withdrawn rule on the turn it left", () => {
    const line = renderFooter(recapWith({ added: [], removed: [MERMAID] }));
    expect(line).toMatch(/floor changed since your last turn/);
    expect(line).toContain("Mermaid");
    expect(line).toContain("-1 removed");
  });

  it("rides a NO_OFFER turn too: obligations change independently of evidence", () => {
    // The measured case was not an evidence turn. A delta that only appeared on
    // turns that offered something would miss exactly the case that motivated it.
    const r = computeTurnRecap("s1", 3, {
      readLog: (f) =>
        f === "ask-traces.jsonl"
          ? [{ session_id: "s1", turn_index: 3, trace_id: "t", hook: { injected: true } }]
          : [],
      readFloorDelta: () => ({ added: [], removed: [MERMAID] }),
    });
    expect(r.verdict).toBe("NO_OFFER");
    expect(renderFooter(r)).toContain("floor changed");
  });

  it("never breaks the recap when the delta reader throws", () => {
    const r = computeTurnRecap("s1", 3, {
      readLog: () => [],
      readFloorDelta: () => {
        throw new Error("audit unreadable");
      },
    });
    expect(r.floor_delta).toBeNull();
    expect(() => renderFooter(r)).not.toThrow();
  });

  it("stays ONE line", () => {
    const line = renderFooter(recapWith({ added: [PREMISE_GATE], removed: [MERMAID] }));
    expect(line).not.toContain("\n");
  });
});

// --- G1 COVERAGE: the tiers the delta cannot currently see ------------------------
//
// Filed 2026-08-09 from notes/20260809-mla-helpfulness-session-345a4bce-the-delta-i-
// shipped-could-not-see-the-first-rule-that-left.md.
//
// The floor delta shipped in 53de85cf8 and its FIRST live opportunity, four hours
// later, was a case it could not see. Two floor SHOULD rules lost their slot to three
// newly-created MUST rules; the recap rendered `+3 added` and said nothing about the
// removals. Measured on the live audit for workspace cmexample0000000000000001:
//
//   delivered : Counter({'floor-must': 13, 'scoped-required': 1})   <- no SHOULD at all
//   omitted   : two entries, reason "best-effort:did-not-fit"
//   cache     : floorRules = 15 (MUST 13, SHOULD 2)  <- both still present
//   store     : both rules still ACTIVE              <- neither was revoked
//
// So there are TWO blind spots, and the one that fired is the second:
//   1. a floor SHOULD that FITS delivers under tier "best-effort" (assemble.ts:321),
//      a tier it shares with scoped rules, and the delta filters on "floor-must";
//   2. a floor SHOULD that does NOT fit is recorded in `omitted`, and the delta never
//      reads `omitted` at all.
//
// These describe floorDelta's INPUT (which rules the caller hands it), so they are
// written against the pure function with the inputs the fixed caller would supply.
// They pass. What is NOT tested anywhere, and what must go red until G1 lands, is that
// assemble-context BUILDS those inputs. That assertion lives in
// test/lib/commands/assemble-context.spec.ts, where the audit is observable.

describe("G1: the floor delta must cover both ways a SHOULD rule stops being delivered", () => {
  const SHOULD_LOCALHOST: FloorRuleRef = {
    ruleId: "cmexample0000000000000002",
    text: "Prefer 127.0.0.1 over localhost for local services on macOS to avoid IPv6 resolution surprises.",
  };
  const SHOULD_SERVICES: FloorRuleRef = {
    ruleId: "cmexample0000000000000003",
    text: "The active backend services are control, connector, worker, relay, and intel.",
  };
  const NEW_MUST: FloorRuleRef = {
    ruleId: "cmexample0000000000000004",
    text: "Shared working tree: 10+ agent sessions share this checkout, its git index and HEAD, so staging is a public act.",
  };

  it("reports a SHOULD that was pushed off the floor by a new MUST (the case that fired)", () => {
    const d = floorDelta([SHOULD_LOCALHOST, SHOULD_SERVICES], [NEW_MUST]);
    expect(d.removed.map((r) => r.ruleId).sort()).toEqual(
      [SHOULD_LOCALHOST.ruleId, SHOULD_SERVICES.ruleId].sort(),
    );
    expect(d.added.map((r) => r.ruleId)).toEqual([NEW_MUST.ruleId]);
  });

  it("renders BOTH directions when MUSTs displace SHOULDs, which is what the live recap omitted", () => {
    const line = renderFloorDelta(floorDelta([SHOULD_LOCALHOST, SHOULD_SERVICES], [NEW_MUST]))!;
    expect(line).toContain("+1 added");
    // The live line stopped here. The removals are the half an agent mid-task needs.
    expect(line).toContain("-2 removed");
    expect(line).toContain("127.0.0.1");
  });

  it("a SHOULD that merely moved tier is still not a removal", () => {
    // Delivered last turn and delivered this turn is delivered, whatever tier carried
    // it. Only absence from the delivered floor is a removal, or the fix trades one
    // false silence for a false alarm.
    const d = floorDelta([SHOULD_LOCALHOST], [SHOULD_LOCALHOST, NEW_MUST]);
    expect(d.removed).toEqual([]);
    expect(d.added.map((r) => r.ruleId)).toEqual([NEW_MUST.ruleId]);
  });
});

// F3 (notes/20260809-did-mla-help-session-ae6411e4-fix-proposal.md D4). The contract of the
// third parameter, stated at the function rather than only at its one caller.
//
// THE INVARIANT: a rule has LEFT the delivered snapshot only when its stable id is absent
// from BOTH the current floor set and the current scoped set. Membership is the subject of
// the line; DELIVERY is the test for whether to print it.
describe("F3: the delta is decided against the delivered snapshot, not against floor membership", () => {
  const MERMAID = {
    ruleId: "r_mermaid",
    text: "When authoring a design doc, proposal, plan, RFC, or architecture spec, include a complete Mermaid sequence diagram.",
  };
  const MUST = { ruleId: "r_main", text: "Work directly on main; never create feature branches." };

  it("floor -> scoped is silent while the rule is still delivered", () => {
    // The measured false alarm, five recorded instances before this one. Turn 1 delivered the
    // rule from the floor; turn 2 delivered the SAME rule from the scoped block.
    const d = floorDelta([MUST, MERMAID], [MUST], {
      prev: new Set([MUST.ruleId, MERMAID.ruleId]),
      curr: new Set([MUST.ruleId, MERMAID.ruleId]),
    });
    expect(d.removed).toEqual([]);
    expect(renderFloorDelta(d)).toBeNull();
  });

  it("scoped -> floor is silent too, or the fix trades one false alarm for the other", () => {
    const d = floorDelta([MUST], [MUST, MERMAID], {
      prev: new Set([MUST.ruleId, MERMAID.ruleId]),
      curr: new Set([MUST.ruleId, MERMAID.ruleId]),
    });
    expect(d.added).toEqual([]);
    expect(renderFloorDelta(d)).toBeNull();
  });

  it("a rule absent from BOTH sets is still a removal, and still quotable", () => {
    // The half M6 exists for. Reclassified AND out of scope this turn is not in front of the
    // agent, and that is exactly the withdrawal the line must announce.
    const d = floorDelta([MUST, MERMAID], [MUST], {
      prev: new Set([MUST.ruleId, MERMAID.ruleId]),
      curr: new Set([MUST.ruleId]),
    });
    expect(d.removed.map((r) => r.ruleId)).toEqual([MERMAID.ruleId]);
    expect(renderFloorDelta(d)).toContain("Mermaid");
  });

  it("omitting the snapshots keeps the pre-F3 floor-only reading", () => {
    // Not a compatibility shim: a caller that genuinely cannot observe the scoped set must not
    // be made to invent one. Falling back to the floor's own ids is the honest default.
    const d = floorDelta([MUST, MERMAID], [MUST]);
    expect(d.removed.map((r) => r.ruleId)).toEqual([MERMAID.ruleId]);
  });
});

// I3 (notes/20260810-did-mla-help-session-bb182a52-served-every-turn-used-on-none.md).
// THE THIRD STATE OF ABSENCE, and the instrument had it on disk the whole time.
//
// Measured live in session bb182a52. The recap the agent received on turn 3:
//
//   floor changed since your last turn: -2 removed "Prefer 127.0.0.1 over localhost
//   for local services on macOS to avoid IPv6 resolution surprises." +1 more
//
// The SAME process's assemble receipt, written seconds earlier against the same turn:
//
//   "omitted": [{"ruleId": "...", "reason": "best-effort:did-not-fit"}, {...}]
//
// Two rules, the same two rules. The assembler computed the reason PER RULE, wrote it
// to disk, and the delta called it a removal anyway.
//
// THIS REVERSES HALF OF G1, DELIBERATELY, AND THE OTHER HALF STANDS. G1 named two blind
// spots and closed both: (1) a floor SHOULD that FITS delivers under tier "best-effort"
// and was invisible to a floor-must filter (still correct, still tested above); and
// (2) a floor SHOULD that does NOT fit lands in `omitted` and the delta never read it.
// G1 read (2) as a missing REMOVAL. It is not one, for three reasons that only became
// legible once the line ran in production:
//
//   * The floor block already discloses this every single turn, in its own precedence
//     sentence: "except best-effort [SHOULD] rules that did not fit this turn". The
//     agent is ALREADY told. The recap adds no information, only a wrong word.
//   * "floor changed since your last turn: -2 removed" asserts a GOVERNANCE event. The
//     floor did not change; the rule was not withdrawn; `mla context list` still shows
//     it and it rides again the moment the prompt is shorter. The sentence is false.
//   * This line's own contract is that it "has to be absent almost always for its
//     presence to mean anything". Omission is driven by PROMPT LENGTH, and the governed
//     corpus records `omitted_rules: 2` on EVERY turn at the real static base, so the
//     removal fires on every byte-budget flip. That is precisely the per-turn churn the
//     F3 comment above says would bury the rare real event.
//
// THE INVARIANT, stated without reference to any reason string:
//
//   A rule is REMOVED only when this turn's assembler can no longer account for it at
//   all. Delivered and omitted-for-budget are both ACCOUNTED FOR; only genuinely absent
//   is a withdrawal.
//
// So presence is `delivered ∪ omitted` on each side, which is membership arithmetic over
// two lists the receipt already carries, not a match on the literal `best-effort:`
// prefix the proposal suggested. A renamed reason must not silently re-open this.
describe("I3: a rule the assembler withheld for BYTES was not withdrawn", () => {
  const MUST: FloorRuleRef = { ruleId: "r_main", text: "Work directly on main; never create feature branches." };
  const SHOULD_LOCALHOST: FloorRuleRef = {
    ruleId: "r_localhost",
    text: "Prefer 127.0.0.1 over localhost for local services on macOS to avoid IPv6 resolution surprises.",
  };
  const SHOULD_SERVICES: FloorRuleRef = {
    ruleId: "r_services",
    text: "The active backend services are control, connector, worker, relay, and intel.",
  };

  it("is silent when the two SHOULDs it dropped for budget are the ones it says it dropped", () => {
    // The exact turn-3 shape: both delivered last turn, both omitted this turn.
    const d = floorDelta([MUST, SHOULD_LOCALHOST, SHOULD_SERVICES], [MUST], {
      prev: new Set([MUST.ruleId, SHOULD_LOCALHOST.ruleId, SHOULD_SERVICES.ruleId]),
      curr: new Set([MUST.ruleId]),
      currOmitted: new Set([SHOULD_LOCALHOST.ruleId, SHOULD_SERVICES.ruleId]),
    });
    expect(d.removed).toEqual([]);
    expect(renderFloorDelta(d)).toBeNull();
  });

  it("still reports a rule that is genuinely gone, so the fix cannot swallow a withdrawal", () => {
    // The other half, and the reason presence is a UNION rather than "ignore absences".
    // One rule was withheld for bytes; the other was revoked. The revoked one must still
    // announce itself, quotably.
    const d = floorDelta([MUST, SHOULD_LOCALHOST, SHOULD_SERVICES], [MUST], {
      prev: new Set([MUST.ruleId, SHOULD_LOCALHOST.ruleId, SHOULD_SERVICES.ruleId]),
      curr: new Set([MUST.ruleId]),
      currOmitted: new Set([SHOULD_LOCALHOST.ruleId]),
    });
    expect(d.removed.map((r) => r.ruleId)).toEqual([SHOULD_SERVICES.ruleId]);
    expect(renderFloorDelta(d)).toContain("connector");
  });

  it("does not announce a re-fitted rule as ADDED either, which is the same lie backwards", () => {
    // The symmetric false alarm, and it fires on the very next short prompt. The rule was
    // omitted for bytes last turn and fits this turn: nothing was granted, the budget just
    // moved. `prev` is the previous receipt's DELIVERED set, so without the union this
    // renders "+1 added" about an obligation that never left.
    const d = floorDelta([MUST], [MUST, SHOULD_LOCALHOST], {
      prev: new Set([MUST.ruleId]),
      prevOmitted: new Set([SHOULD_LOCALHOST.ruleId]),
      curr: new Set([MUST.ruleId, SHOULD_LOCALHOST.ruleId]),
    });
    expect(d.added).toEqual([]);
    expect(renderFloorDelta(d)).toBeNull();
  });

  it("reads omission MEMBERSHIP, never the reason string", () => {
    // The proposal's own implementation sketch was "exclude any rule whose omission reason
    // starts with `best-effort:`". Rejected on review: that pins today's reason vocabulary
    // as a contract, so renaming the reason silently re-opens the defect. The caller hands
    // over ids; this function never sees a reason at all. Written as a test because the
    // cheapest way to re-introduce the coupling is to add the string back "for clarity".
    const d = floorDelta([MUST, SHOULD_LOCALHOST], [MUST], {
      prev: new Set([MUST.ruleId, SHOULD_LOCALHOST.ruleId]),
      curr: new Set([MUST.ruleId]),
      // No reason travels with it, and none is needed.
      currOmitted: new Set([SHOULD_LOCALHOST.ruleId]),
    });
    expect(d.removed).toEqual([]);
  });

  it("an omitted id that was never delivered before changes nothing", () => {
    // Degenerate but load-bearing: the union must not manufacture membership. A rule that
    // was omitted on both turns is in neither delivered set and in neither `prev` list, so
    // both directions stay empty whatever the omission sets say.
    const d = floorDelta([MUST], [MUST], {
      prev: new Set([MUST.ruleId]),
      prevOmitted: new Set([SHOULD_SERVICES.ruleId]),
      curr: new Set([MUST.ruleId]),
      currOmitted: new Set([SHOULD_SERVICES.ruleId]),
    });
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("omitting the omission sets keeps every pre-I3 verdict, for a caller that cannot observe them", () => {
    // Same honesty rule the F3 snapshots follow: a caller with no better information falls
    // back to what it does know, rather than being made to invent an empty set that means
    // "nothing was withheld".
    const d = floorDelta([MUST, SHOULD_LOCALHOST], [MUST], {
      prev: new Set([MUST.ruleId, SHOULD_LOCALHOST.ruleId]),
      curr: new Set([MUST.ruleId]),
    });
    expect(d.removed.map((r) => r.ruleId)).toEqual([SHOULD_LOCALHOST.ruleId]);
  });
});

// F3 GENERICITY. Every case above is written on the Mermaid rule, because Mermaid is the
// incident that funded the fix. That proves the FIXTURE passes; it does not prove the
// ALGORITHM is rule-agnostic, and those are different claims.
//
// THE INVARIANT, which names no rule, topic, category, source or tier:
//
//   Given a previously delivered rule, report it as dropped only when the system can no
//   longer establish that the same obligation remains anywhere in the CURRENT delivered
//   rule set.
//
// So these are written on synthetic governance rules with no connection to Mermaid, to
// this repository, or to the incident. If the Mermaid fixtures were deleted outright these
// still pass, which is the actual claim.
//
// WHY THE RUNTIME IS THE EASY HALF, and it is worth stating because the analyzer's
// equivalent is not: `floorDelta` never reads `text` at all. It is set arithmetic over
// `ruleId`, which is the backend rule-node identity (`ruleIdOf`, scanner/scan.ts:213) and
// therefore already survives reclassification, rewording and re-attest. `text` rides along
// solely so the recap can QUOTE the rule; no branch ever compares it. The analyzer needs a
// similarity heuristic only because its substrate is the rendered payload, which carries no
// ids. Nothing like that belongs here, and these tests are what stops one arriving.
describe("F3 GENERICITY: the delta decides on identity alone, never on what a rule says", () => {
  // Deliberately from a domain this workspace has no rules about.
  const DEPLOY_GATE: FloorRuleRef = {
    ruleId: "rn_deploy_gate",
    text: "Never deploy without passing the production smoke test.",
  };
  const ROTATE: FloorRuleRef = {
    ruleId: "rn_rotate",
    text: "Record every credential rotation in the operations log within one hour.",
  };

  it("A. tier movement with identical content is silent in BOTH directions", () => {
    const toScoped = floorDelta([ROTATE, DEPLOY_GATE], [ROTATE], {
      prev: new Set([ROTATE.ruleId, DEPLOY_GATE.ruleId]),
      curr: new Set([ROTATE.ruleId, DEPLOY_GATE.ruleId]),
    });
    expect(toScoped.removed).toEqual([]);
    expect(renderFloorDelta(toScoped)).toBeNull();

    const toFloor = floorDelta([ROTATE], [ROTATE, DEPLOY_GATE], {
      prev: new Set([ROTATE.ruleId, DEPLOY_GATE.ruleId]),
      curr: new Set([ROTATE.ruleId, DEPLOY_GATE.ruleId]),
    });
    expect(toFloor.added).toEqual([]);
    expect(renderFloorDelta(toFloor)).toBeNull();
  });

  it("B. a non-material reword of an arbitrary rule is not a governance event", () => {
    // The clause-reordering shape, on a rule with nothing to do with the incident. The
    // analyzer has to score this; here it is free, because the id did not move.
    const reordered: FloorRuleRef = {
      ...DEPLOY_GATE,
      text: "The production smoke test must pass before any deploy.",
    };
    const d = floorDelta([DEPLOY_GATE, ROTATE], [reordered, ROTATE]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("C. two rules whose TEXT is nearly identical stay distinct, because identity is not text", () => {
    // The precision half, and the sharpest statement of what "rule-agnostic" buys. These
    // two statements differ by ONE WORD and are different obligations: passing a test you
    // have is not the act of creating one you do not. Character similarity scores them at
    // 0.937 and cannot separate them -- which is a real, pinned limit on the ANALYZER
    // (TestRewordSimilarityCannotSeeMeaning). Here it is a non-question: different rule
    // nodes, different ids, and the withdrawal reports.
    const MATERIAL_SWAP: FloorRuleRef = {
      ruleId: "rn_deploy_gate_v2",
      text: "Never deploy without creating the production smoke test.",
    };
    const d = floorDelta([DEPLOY_GATE, ROTATE], [MATERIAL_SWAP, ROTATE], {
      prev: new Set([DEPLOY_GATE.ruleId, ROTATE.ruleId]),
      curr: new Set([MATERIAL_SWAP.ruleId, ROTATE.ruleId]),
    });
    expect(d.removed.map((r) => r.ruleId)).toEqual([DEPLOY_GATE.ruleId]);
    expect(d.added.map((r) => r.ruleId)).toEqual([MATERIAL_SWAP.ruleId]);
  });

  it("C2. and the converse: identical ids under UNRELATED text are still one rule", () => {
    // The other way a text-reading implementation would betray itself. Nobody should ever
    // rewrite a rule into an unrelated obligation under the same node, but if they do, the
    // delta must follow the identity the system actually governs by and stay silent rather
    // than invent a churn event from prose distance.
    const d = floorDelta([DEPLOY_GATE], [{ ...DEPLOY_GATE, text: ROTATE.text }]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it("D. the arbitrary-replacement test: swap the domain, change no production code", () => {
    // Same four verdicts on rules from an unrelated domain. This is the substitution the
    // contract owes and the reason the Mermaid fixture is evidence, not a dependency.
    const gone = floorDelta([DEPLOY_GATE, ROTATE], [ROTATE], {
      prev: new Set([DEPLOY_GATE.ruleId, ROTATE.ruleId]),
      curr: new Set([ROTATE.ruleId]),
    });
    expect(gone.removed.map((r) => r.ruleId)).toEqual([DEPLOY_GATE.ruleId]);
    expect(renderFloorDelta(gone)).toContain("smoke test");

    const arrived = floorDelta([ROTATE], [ROTATE, DEPLOY_GATE], {
      prev: new Set([ROTATE.ruleId]),
      curr: new Set([ROTATE.ruleId, DEPLOY_GATE.ruleId]),
    });
    expect(arrived.added.map((r) => r.ruleId)).toEqual([DEPLOY_GATE.ruleId]);
  });

  it("carries no branch keyed to any particular rule: N unrelated rules behave identically", () => {
    // A structural check rather than another example. Ten synthetic rules from ten
    // domains, one withdrawn: the verdict must be exactly the withdrawn one, with no
    // rule's content earning it different treatment.
    const many: FloorRuleRef[] = Array.from({ length: 10 }, (_, i) => ({
      ruleId: `rn_synthetic_${i}`,
      text: `Governance obligation number ${i} concerning subject ${i}, stated plainly.`,
    }));
    for (let victim = 0; victim < many.length; victim++) {
      const curr = many.filter((_, i) => i !== victim);
      const d = floorDelta(many, curr, {
        prev: new Set(many.map((r) => r.ruleId)),
        curr: new Set(curr.map((r) => r.ruleId)),
      });
      expect(d.removed.map((r) => r.ruleId)).toEqual([many[victim].ruleId]);
      expect(d.added).toEqual([]);
    }
  });
});
