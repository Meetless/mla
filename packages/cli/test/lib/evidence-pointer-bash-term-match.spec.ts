import {
  computeEvidencePointer,
  extractNeedles,
  isUsableNeedle,
  matchPointer,
  TurnOffer,
} from "../../src/lib/evidence-pointer";

// F5 / D6: the "it contains the literal X you are searching for" nudge must not run
// against a shell command.
//
// THE PREMISE WAS CHECKED BEFORE THIS WAS WRITTEN, AND ONE THIRD OF IT WAS ALREADY DEAD.
//
//   1. `IS NOT DISTINCT FROM` inside a SQL string (session b83bb228, fired TWICE
//      verbatim; the 08-09 audit's D6). DOES NOT REPRODUCE on current main, and it is
//      kept below as a regression rather than as evidence. Measured 2026-08-09: the
//      needle `DISTINCT` fails `isUsableNeedle` (no separator, no digit, no internal
//      capitalization), and `extractNeedles` returns `[]` for the whole command anyway
//      because the psql segment is not headed by an inspection verb. Two independent
//      later guards each kill it on their own. Quoting it as live evidence for this
//      change would have been quoting a fixed defect.
//
//   2. `intel-dev` as psql's `-d` argument (session 0b2d408c turn 2). Also already
//      fixed, by M8 segmentation. It is the case that proves needle SHAPE can never be
//      the gate: `intel-dev` is a perfectly good identifier and passes every
//      distinctiveness rule there is.
//
//   3. `grep -rln "router_confidence" --include=*.py .` -- THIS ONE IS LIVE. Fired
//      TWICE in this session at 2026-08-09T23:37, both recorded in
//      ~/.meetless/logs/evidence-pointers.jsonl against
//      NT:notes/20260805-mla-router-abstention-and-raw-prompt-at-rest.md, WITH M8
//      segmentation already in the working tree. `extractNeedles` yields
//      ["router_confidence", "."] and `router_confidence` is usable, because the
//      segment really is headed by `grep` and that really is its pattern. Segmentation
//      is a correct narrowing that does not reach this class at all, and no further
//      narrowing can: this is a well-formed inspection whose needle is a well-formed
//      identifier.
//
// So the surviving class is not "malformed needles from compound shell lines". It is
// "a symbol lookup is not a topic lookup", and 34 of the 37 recorded fires are Bash.
//
// THE MECHANISM, AND WHY NARROWING CANNOT CLOSE IT. A shell inspection is a CODE-SHAPE
// action, and CLAUDE.md routes code-shape questions (definitions, callers, regex
// behaviour, whether a field is written) to grep deliberately. The pointer answers a
// different question -- "you were already handed a document about this TOPIC" -- so on a
// code-shape action it is off-target however good the needle is. A symbol grep and a
// design note share vocabulary by construction: that is what makes the corpus about the
// codebase, not what makes the note relevant.
//
// PATH MATCHING IS KEPT, AND THE SPLIT IS THE WHOLE FIX. `matched_on: "path"` fires when
// the needle IS the delivered document's own citation path ("you are about to open it
// directly"). That is an exact identity match on a primary key, not a lexical
// coincidence in prose, and `cat notes/foo.md` right after foo.md was delivered is
// precisely the moment the mechanism exists for. 5 of 34 recorded Bash fires are `path`;
// the other 29 are `term`.
//
// `extractNeedles` IS DELIBERATELY UNTOUCHED. The needles are still extracted from Bash
// exactly as M8 segmentation leaves them, because path matching needs them. What changes
// is which MATCHER those needles are allowed to reach.

const NOTE = "NT:notes/20260704-mla-vs-future-agents-discussion.md";

function offer(): TurnOffer {
  return {
    turn_index: 0,
    items: [
      {
        source_id: NOTE,
        status: "pending",
        text:
          "Whether MLA is a durable business depends on whether the governed substrate " +
          "stays DISTINCT from what a general agent can reconstruct. A router_confidence " +
          "of 0.0 is an abstention, not a score.",
      },
      {
        source_id: "NT:notes/20260101-unrelated.md",
        status: "accepted",
        text: "An unrelated second item, so the all-items guard does not silence the match.",
      },
    ],
  };
}

// The exact command from session b83bb228, reduced to the clause that carried the needle.
const SQL_DISTINCT =
  `psql -c "select a.id from audit a join outbox o on a.trace_id IS NOT DISTINCT FROM o.trace_id"`;
// The exact command from this session, twice.
const GREP_ROUTER_CONFIDENCE = `grep -rln "router_confidence" --include=*.py .`;

describe("the term matcher does not run against a shell command", () => {
  it("the D6 SQL case is already dead upstream, and stays dead", () => {
    // NON-VACUITY MATTERS HERE. This passes today for a reason that has nothing to do
    // with the term gate, so it asserts the ACTUAL upstream mechanism rather than the
    // null it would return either way. If a future change makes `DISTINCT` usable or
    // makes the psql segment inspectable, this fails and says which one moved.
    expect(isUsableNeedle("DISTINCT")).toBe(false);
    expect(extractNeedles("Bash", { command: SQL_DISTINCT })).toEqual([]);
  });

  it("does not point at an abstention note because grep is looking up a symbol", () => {
    expect(matchPointer(offer(), ["router_confidence"], { termMatch: false })).toBeNull();
  });

  it("end to end: neither real command produces a pointer", () => {
    const deps = {
      readOffer: () => offer(),
      readFires: () => [],
      appendFire: () => undefined,
      now: () => "2026-08-09T23:37:00.000Z",
    };

    expect(computeEvidencePointer("s1", "Bash", { command: SQL_DISTINCT }, deps)).toBeNull();
    expect(computeEvidencePointer("s1", "Bash", { command: GREP_ROUTER_CONFIDENCE }, deps)).toBeNull();
  });
});

describe("what the fix deliberately preserves", () => {
  it("a Bash command opening the delivered document directly still points", () => {
    const deps = {
      readOffer: () => offer(),
      readFires: () => [],
      appendFire: () => undefined,
      now: () => "2026-08-09T23:37:00.000Z",
    };

    const pointer = computeEvidencePointer(
      "s1",
      "Bash",
      { command: "cat notes/20260704-mla-vs-future-agents-discussion.md" },
      deps,
    );

    expect(pointer).toContain(NOTE);
    expect(pointer).toContain("you are about to open it directly");
  });

  it("a prose surface still gets the term match", () => {
    // Grep's `pattern` is the agent stating what it is looking for on a surface the
    // mechanism was built for, and it accounts for 3 of the 37 recorded fires. Nothing
    // here changes it.
    const match = matchPointer(offer(), ["router_confidence"]);

    expect(match).not.toBeNull();
    expect(match!.matched_on).toBe("term");
    expect(match!.source_id).toBe(NOTE);
  });

  it("term matching is the default, so only the Bash call site opts out", () => {
    // Vacuity guard. If `termMatch` silently defaulted to false the two preserved
    // behaviours above would still pass while every non-Bash surface went dark.
    expect(matchPointer(offer(), ["router_confidence"])).not.toBeNull();
    expect(matchPointer(offer(), ["router_confidence"], {})).not.toBeNull();
  });

  it("path matching still works when term matching is off", () => {
    const match = matchPointer(
      offer(),
      ["notes/20260704-mla-vs-future-agents-discussion.md"],
      { termMatch: false },
    );

    expect(match).not.toBeNull();
    expect(match!.matched_on).toBe("path");
  });
});
