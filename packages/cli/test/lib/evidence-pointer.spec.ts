// F1: the pointer that fires at the moment of need.
//
// The two cases in §2 of notes/20260807-did-mla-help-this-session-measured-and-a-fix-
// proposal.md are the acceptance tests, because they are the measured failures: mla
// injected the answering document, the agent went and derived the answer by hand, and
// nothing pointed back at what it already had.
//
// Everything else here is a PRECISION test. The mechanism's whole risk is the false
// pointer: it costs attention on the hot path and it costs credibility permanently, so
// the bar is "a wrong pointer must be hard to produce", not "catch as much as possible".

import {
  MAX_POINTERS_PER_TURN,
  MIN_NEEDLE_LENGTH,
  OfferedItem,
  TurnOffer,
  computeEvidencePointer,
  excerptAround,
  extractNeedles,
  firesThisTurn,
  isUsableNeedle,
  matchPointer,
  parsePointerFires,
  pointerFireLine,
  renderPointer,
} from "../../src/lib/evidence-pointer";

function offer(items: Partial<OfferedItem>[]): TurnOffer {
  return {
    session_id: "s1",
    turn_index: 6,
    items: items.map((i) => ({
      source_id: i.source_id ?? "NT:notes/x.md",
      status: i.status ?? "pending",
      text: i.text ?? "",
    })),
  };
}

// §2.1, verbatim in shape. The agent had this note injected at turn start, then read
// PROFILES_BY_NAME and ran git log over chunking/profiles.py to prove the registry had
// one entry. Line 449 of the injected note says so outright.
const DOGFOOD_PLAN: OfferedItem = {
  source_id: "NT:notes/20260514-meetless-dogfood-implementation-plan-v2.md",
  status: "pending",
  text:
    "Meetless dogfood implementation plan v2: B3. Wire the ingest seam. " +
    "B4. Implement intel/app/knowledge/chunking/profiles.py per section 6.7. " +
    "Single profile constant MARKDOWN_ATOMIC_V1. No engine code yet. " +
    "B5. Land the reconciler behind the flag.",
};

// §2.2. Injected on turns 4 AND 5; the agent re-derived the forward-only rule by
// reading _kb_gate_sql and running two census queries.
const R2_PLAN: OfferedItem = {
  source_id: "NT:notes/20260609-r2-revision-backfill-plan.md",
  status: "pending",
  text:
    "R2 revision-stamp backfill plan: status resolved. Both retrieval arms gate on " +
    "current_revision_id, so an older generation can never be served after a newer " +
    "revision commits. Unstamped chunks are KEPT by the forward-only rule.",
};

describe("F1 extractNeedles: what a tool call is reaching for", () => {
  it("takes the path off a Read", () => {
    expect(extractNeedles("Read", { file_path: "/abs/intel/app/knowledge/chunking/profiles.py" })).toEqual([
      "/abs/intel/app/knowledge/chunking/profiles.py",
    ]);
  });

  it("takes the pattern and the path off a Grep", () => {
    const n = extractNeedles("Grep", { pattern: "PROFILES_BY_NAME", path: "intel/app" });
    expect(n).toContain("PROFILES_BY_NAME");
    expect(n).toContain("intel/app");
  });

  it("takes the arguments off an inspecting Bash command", () => {
    const n = extractNeedles("Bash", { command: "git log --oneline -- intel/app/knowledge/chunking/profiles.py" });
    expect(n).toContain("intel/app/knowledge/chunking/profiles.py");
    // The verb and its flags carry no intent and must not become needles.
    expect(n).not.toContain("git");
    expect(n).not.toContain("log");
    expect(n).not.toContain("--oneline");
  });

  it("ignores a Bash command that is not an inspection", () => {
    // Building, testing and installing are not the agent looking a fact up. A pointer
    // fired at `pnpm build` would be noise at the worst possible moment.
    expect(extractNeedles("Bash", { command: "pnpm run build && pnpm test" })).toEqual([]);
    expect(extractNeedles("Bash", { command: "rm -rf dist" })).toEqual([]);
  });

  it("ignores the tools that WRITE, because a pointer would arrive after the decision", () => {
    expect(extractNeedles("Write", { file_path: "notes/x.md", content: "PROFILES_BY_NAME" })).toEqual([]);
    expect(extractNeedles("Edit", { file_path: "notes/x.md" })).toEqual([]);
  });
});

describe("F1 isUsableNeedle: precision floor", () => {
  it("rejects short words that appear in every note", () => {
    for (const w of ["id", "run", "path", "status", "value"]) {
      expect(isUsableNeedle(w)).toBe(false);
    }
    expect(MIN_NEEDLE_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it("rejects a regex pattern, which cannot be matched verbatim against prose", () => {
    expect(isUsableNeedle("should_drop_.*_revision")).toBe(false);
    expect(isUsableNeedle("^def _kb_gate_sql")).toBe(false);
    expect(isUsableNeedle("(foo|bar)baz")).toBe(false);
  });

  it("rejects a token with no letters", () => {
    expect(isUsableNeedle("1234567890")).toBe(false);
    expect(isUsableNeedle("---------")).toBe(false);
  });

  it("accepts a distinctive literal symbol or path", () => {
    expect(isUsableNeedle("PROFILES_BY_NAME")).toBe(true);
    expect(isUsableNeedle("current_revision_id")).toBe(true);
    expect(isUsableNeedle("intel/app/knowledge/chunking/profiles")).toBe(true);
  });
});

describe("F1 matchPointer: the two measured reproducers", () => {
  it("§2.1 fires on the chunking-profile question the agent derived by hand", () => {
    const m = matchPointer(
      offer([DOGFOOD_PLAN, { source_id: "NT:notes/unrelated.md", text: "a note about billing" }]),
      extractNeedles("Bash", { command: "git log --oneline -- intel/app/knowledge/chunking/profiles.py" }),
    );
    expect(m).not.toBeNull();
    expect(m!.source_id).toBe(DOGFOOD_PLAN.source_id);
    expect(m!.matched_on).toBe("term");
    // The RESURFACED text is the delivered snippet, and it carries the load-bearing
    // sentence the agent went and re-derived.
    expect(m!.excerpt).toContain("Single profile constant MARKDOWN_ATOMIC_V1");
  });

  it("§2.2 fires on the generation-drift question, on the id injected both turns", () => {
    const m = matchPointer(
      offer([{ source_id: "NT:notes/other.md", text: "unrelated" }, R2_PLAN]),
      extractNeedles("Grep", { pattern: "current_revision_id", path: "intel/app" }),
    );
    expect(m).not.toBeNull();
    expect(m!.source_id).toBe(R2_PLAN.source_id);
    expect(m!.excerpt).toContain("forward-only");
  });

  it("prefers the certain signal: a path match beats a term match", () => {
    const m = matchPointer(
      offer([
        { source_id: "NT:notes/term-hit.md", text: "mentions current_revision_id in passing" },
        { source_id: "NT:notes/20260609-r2-revision-backfill-plan.md", text: R2_PLAN.text },
      ]),
      ["current_revision_id", "/Users/an/projects/notes/20260609-r2-revision-backfill-plan.md"],
    );
    expect(m!.matched_on).toBe("path");
    expect(m!.source_id).toBe("NT:notes/20260609-r2-revision-backfill-plan.md");
  });
});

describe("F1 matchPointer: precision", () => {
  it("does not fire when nothing distinctive matches", () => {
    expect(matchPointer(offer([DOGFOOD_PLAN]), extractNeedles("Grep", { pattern: "TODO" }))).toBeNull();
    expect(matchPointer(offer([DOGFOOD_PLAN]), ["unrelatedSymbolName"])).toBeNull();
  });

  it("does not fire when the term is in EVERY offered item", () => {
    // A word every candidate carries is a property of the corpus, not a pointer to one
    // document: it discriminates nothing, so it is worse than silence.
    const common = "coordination case";
    const m = matchPointer(
      offer([
        { source_id: "NT:a.md", text: `alpha ${common} alpha` },
        { source_id: "NT:b.md", text: `beta ${common} beta` },
      ]),
      [common],
    );
    expect(m).toBeNull();
  });

  it("does not fire on an empty offer (a NO_OFFER turn has nothing to point at)", () => {
    expect(matchPointer(offer([]), ["PROFILES_BY_NAME"])).toBeNull();
  });

  it("returns at most ONE match, never a list", () => {
    const m = matchPointer(
      offer([
        { source_id: "NT:a.md", text: "PROFILES_BY_NAME appears here" },
        { source_id: "NT:b.md", text: "PROFILES_BY_NAME appears here too" },
        { source_id: "NT:c.md", text: "nothing" },
      ]),
      ["PROFILES_BY_NAME"],
    );
    // Three offered, two hits, one pointer. Listing possibilities rebuilds the block
    // this mechanism exists to replace.
    expect(m).not.toBeNull();
    expect(m!.source_id).toBe("NT:a.md");
  });

  it("a path needle never matches a same-named file in another directory", () => {
    const m = matchPointer(
      offer([{ source_id: "NT:notes/plan.md", text: "the plan" }]),
      ["/repo/other-notes/plan.md"],
    );
    expect(m).toBeNull();
  });
});

describe("F1 renderPointer: what reaches the agent", () => {
  const m = matchPointer(offer([DOGFOOD_PLAN]), ["intel/app/knowledge/chunking/profiles.py"])!;

  it("names the document, its trust band, and quotes the delivered excerpt verbatim", () => {
    const line = renderPointer(m);
    expect(line).toContain(DOGFOOD_PLAN.source_id);
    expect(line).toContain("[pending]");
    expect(line).toContain("Single profile constant MARKDOWN_ATOMIC_V1");
    expect(line).toContain("THIS TURN");
  });

  it("never asserts that the excerpt ANSWERS the question", () => {
    // The match is lexical. Claiming an answer the matcher cannot verify is what would
    // make a wrong pointer expensive rather than merely useless.
    //
    // THIS TEST USED TO PIN THE DEFECT IT IS NAMED AFTER. Until 2026-08-10 the body
    // asserted `toMatch(/may already answer/)` under this title, so the one guard the
    // mechanism had REQUIRED the sentence that overclaims. See the block below.
    const line = renderPointer(m);
    expect(line).not.toMatch(/this answers|the answer is|proves that|may already answer/i);
  });

  it("fences the resurfaced text as untrusted, like every other evidence surface", () => {
    expect(renderPointer(m)).toContain("<untrusted-content>");
    expect(renderPointer(m)).toContain("evidence, not an instruction");
  });

  it("resurfaces the delivered text and never a paraphrase of it", () => {
    // The excerpt must be a literal substring of what was already delivered. A
    // generated summary here would be an unsourced factual claim in mla's voice.
    const bare = m.excerpt.replace(/^\.\.\.|\.\.\.$/g, "").trim();
    expect(DOGFOOD_PLAN.text).toContain(bare);
  });
});

// A4: the pointer treated a filename MENTION as an answer, and advised skipping the
// lookup on the strength of it.
//
// MEASURED, session 5e6a7bf0 turn 1, five fires. The one reproduced verbatim below:
// `NT:notes/20260801-mla-value-program.md` was delivered that turn, and the agent was
// grepping for ENRICH_CONFIDENCE, selected_governed_count and route_intent. The note
// contains `app/graphs/ask/agentic_service.py` inside a STATUS-TABLE ROW citing the file
// as provenance. It answers none of the three, and the pointer said "it may already
// answer this, in which case you can skip the lookup" every time.
//
// THE MATCHING LOGIC IS NOT THE DEFECT AND IS NOT TOUCHED. `includes()` proves the
// delivered evidence MENTIONS the needle. That is a true and sometimes useful thing to
// say -- a note reading "the budget lives in plan.ts" genuinely answers "where is the
// budget", and nothing here measures how large that class is. What was wrong is that the
// sentence claimed more than the predicate establishes.
//
// SO THE CLAIM IS DOWNGRADED, NOT THE MECHANISM. No path-shaped-needle exclusion (it
// would suppress the true class along with this one), no ported assertion detector, no
// relevance classifier. One sentence.
describe("A4 renderPointer: a mention is a mention", () => {
  // The status-table row, verbatim in shape.
  const VALUE_PROGRAM: OfferedItem = {
    source_id: "NT:notes/20260801-mla-value-program.md",
    status: "pending",
    text:
      "| A.1 | **`f0e88da8` NO_OFFER leaves a server-side row** | done | intel " +
      "`app/graphs/ask/agentic_service.py` + `corpus_offer_probe.py`; the probe writes " +
      "a row even when it declines. | A.2 | the ledger joins on trace_id |",
  };
  const NEEDLE = "app/graphs/ask/agentic_service.py";
  const match = () => matchPointer(offer([VALUE_PROGRAM, DOGFOOD_PLAN]), [NEEDLE])!;

  it("still fires: a mention is worth surfacing and the matcher is unchanged", () => {
    const m = match();
    expect(m).not.toBeNull();
    expect(m.matched_on).toBe("term");
    expect(m.source_id).toBe(VALUE_PROGRAM.source_id);
  });

  it("still quotes the matching excerpt", () => {
    expect(renderPointer(match())).toContain("agentic_service.py");
    expect(renderPointer(match())).toContain("<untrusted-content>");
  });

  it("says the evidence MENTIONS the needle, and names it", () => {
    const line = renderPointer(match());
    expect(line).toMatch(/mentions/i);
    expect(line).toContain(NEEDLE);
  });

  it("does not claim the note answers the lookup", () => {
    expect(renderPointer(match())).not.toMatch(/may already answer|answers this|the answer/i);
  });

  it("does not advise skipping the lookup", () => {
    expect(renderPointer(match())).not.toMatch(/skip the lookup|no need to|you can skip/i);
  });

  it("through the WHOLE composition, not just the renderer", () => {
    // `renderPointer` is called from exactly one place in production
    // (`computeEvidencePointer`), and the e2e block below hands the hook a canned
    // pointer string. Without this, the four assertions above could all pass while the
    // sentence the agent actually receives is composed somewhere else.
    const fires: Record<string, unknown>[] = [];
    const line = computeEvidencePointer("s1", "Grep", { pattern: NEEDLE }, {
      readOffer: () => offer([VALUE_PROGRAM, DOGFOOD_PLAN]),
      readFires: () => [],
      appendFire: (l: string) => fires.push(JSON.parse(l)),
      now: () => "2026-08-10T22:00:00.000Z",
    })!;
    expect(line).toContain(VALUE_PROGRAM.source_id);
    expect(line).toMatch(/mentions/i);
    expect(line).not.toMatch(/may already answer|skip the lookup/i);
    // And the fire is still spooled, so the downgrade did not cost the attribution.
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ source_id: VALUE_PROGRAM.source_id, matched_on: "term" });
  });

  it("the path branch makes no answer claim either", () => {
    // The agent is about to open the delivered document itself. That is the stronger
    // signal of the two and it still does not establish that the excerpt answers
    // anything, so the same sentence is gone from both branches.
    const m = matchPointer(offer([DOGFOOD_PLAN]), [
      "notes/20260514-meetless-dogfood-implementation-plan-v2.md",
    ])!;
    expect(m.matched_on).toBe("path");
    expect(renderPointer(m)).not.toMatch(/may already answer|skip the lookup/i);
  });
});

describe("F1 excerptAround", () => {
  it("centers on the hit rather than returning the document opening", () => {
    // This is the §2.1 defect in miniature: the opening of the note was delivered and
    // the answering sentence was past the cut.
    const text = `${"lead in. ".repeat(80)}THE ANSWER IS ONE PROFILE.${" trailing. ".repeat(80)}`;
    const ex = excerptAround(text, "THE ANSWER IS ONE PROFILE");
    expect(ex).toContain("THE ANSWER IS ONE PROFILE");
    expect(ex.length).toBeLessThan(text.length);
  });

  it("survives a needle that is not present", () => {
    expect(excerptAround("short text", "absent")).toBe("short text");
  });
});

describe("F1 attribution spool: the kill criterion's own instrument", () => {
  it("records the fire with everything needed to attribute later engagement", () => {
    const line = pointerFireLine(
      { session_id: "s1", turn_index: 6, source_id: "NT:notes/a.md", tool: "Grep", matched_on: "term" },
      "2026-08-08T00:00:00.000Z",
    );
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("evidence_pointer");
    expect(parsed.session_id).toBe("s1");
    expect(parsed.turn_index).toBe(6);
    expect(parsed.source_id).toBe("NT:notes/a.md");
  });

  it("parses leniently and drops a row it cannot join", () => {
    const fires = parsePointerFires([
      { session_id: "s1", turn_index: 6, source_id: "NT:a.md", tool: "Read", matched_on: "path" },
      { session_id: "", turn_index: 6, source_id: "NT:b.md" },
      { session_id: "s1", turn_index: null, source_id: "NT:c.md" },
      { session_id: "s1", turn_index: 7, source_id: "" },
    ]);
    expect(fires).toHaveLength(1);
    expect(fires[0].source_id).toBe("NT:a.md");
  });

  it("counts this turn's fires so the per-turn cap can hold", () => {
    const fires = parsePointerFires([
      { session_id: "s1", turn_index: 6, source_id: "NT:a.md" },
      { session_id: "s1", turn_index: 6, source_id: "NT:b.md" },
      { session_id: "s1", turn_index: 7, source_id: "NT:c.md" },
      { session_id: "s2", turn_index: 6, source_id: "NT:d.md" },
    ]);
    expect(firesThisTurn(fires, "s1", 6)).toBe(2);
    expect(firesThisTurn(fires, "s1", 7)).toBe(1);
    expect(MAX_POINTERS_PER_TURN).toBeLessThanOrEqual(3);
  });
});

// --- end to end through the REAL PreToolUse decision function ----------------
//
// The unit tests above prove the matcher. This proves the mechanism is REACHED: that a
// Grep actually arrives at the hook (it did not before the matcher widening), that the
// pointer rides `additionalContext` where the model will see it, and that it can never
// carry a permission decision.

import { runInternalPretoolObserve } from "../../src/commands/internal-pretool-observe";

async function runHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  pointer: string | null,
): Promise<Record<string, unknown>> {
  let stdout = "";
  await runInternalPretoolObserve([], {
    readStdin: async () =>
      JSON.stringify({ session_id: "s1", tool_name: toolName, tool_input: toolInput, cwd: "/repo" }),
    writeOut: (s: string) => {
      stdout = s;
    },
    readConflicts: () => [],
    evidencePointer: () => pointer,
  });
  return JSON.parse(stdout || "{}");
}

describe("F1 end to end: the pointer reaches the agent", () => {
  it("rides additionalContext on a Grep, the tool that could not reach this hook before", async () => {
    const body = await runHook("Grep", { pattern: "current_revision_id" }, "Meetless: NT:notes/r2.md ...");
    expect(body.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      additionalContext: expect.stringContaining("NT:notes/r2.md"),
    });
    // Model-facing only. A pointer is not an operator concern and would be terminal noise.
    expect(body.systemMessage).toBe("");
  });

  it("carries no permission decision, on any inspection tool", async () => {
    for (const tool of ["Grep", "Glob"]) {
      const body = await runHook(tool, { file_path: "/repo/a.md", pattern: "x" }, "Meetless: NT:a.md ...");
      expect((body.hookSpecificOutput as Record<string, unknown>)?.permissionDecision).toBeUndefined();
    }
  });

  it("is silent when nothing matched: no pointer, no advisory, the empty pass-through", async () => {
    const body = await runHook("Glob", { pattern: "src/**/unrelated.ts" }, null);
    expect(body).toEqual({});
  });

  it("appends to a conflict warning rather than replacing it", async () => {
    // Both ride additionalContext, so they must concatenate; a pointer that silently
    // dropped an open cross-session conflict would be a real loss.
    let stdout = "";
    await runInternalPretoolObserve([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "s1", tool_name: "Grep", tool_input: { pattern: "anything" }, cwd: "/repo" }),
      writeOut: (s: string) => {
        stdout = s;
      },
      readConflicts: () => [
        { caseId: "c1", reason: "two sessions disagree", openedAt: "2026-08-08T00:00:00Z" } as never,
      ],
      evidencePointer: () => "Meetless: NT:notes/a.md was already delivered",
    });
    const body = JSON.parse(stdout);
    const ctx = String((body.hookSpecificOutput as Record<string, unknown>).additionalContext);
    expect(ctx).toContain("cross-session conflict");
    expect(ctx).toContain("NT:notes/a.md was already delivered");
  });
});

// --- precision defects found by DOGFOODING, 2026-08-08 -----------------------
//
// F1 fired on the author of F1, wrongly, within an hour of shipping. The tool call was
//
//     cat >> test/lib/evidence-pointer.spec.ts <<'EOF' ... EOF
//
// and it matched the offered note on the literal "constant". Two independent defects,
// both of which the unit tests above missed because both fixtures were realistic
// INSPECTIONS with distinctive symbols:
//
//   1. `cat >> file` is a WRITE. The inspection gate matched the verb `cat` anywhere in
//      the command, so a heredoc that writes a file read as a lookup. A pointer on a
//      write is the exact thing `extractNeedles` refuses to do for Write and Edit,
//      arriving through Bash instead.
//   2. "constant" is a plain English word that happens to be eight characters, so the
//      length floor admitted it. Length was never the property that mattered:
//      DISTINCTIVENESS is. Any prose word long enough will match some note in the
//      corpus, and a matcher that fires on prose fires constantly and is right by
//      accident.

describe("F1 precision: the dogfood false positive", () => {
  it("a heredoc or redirect is a WRITE, not an inspection", () => {
    for (const command of [
      "cat >> test/lib/evidence-pointer.spec.ts <<'EOF'\nconstant profile\nEOF",
      "cat > notes/x.md <<EOF\nbody\nEOF",
      "grep -rn PROFILES_BY_NAME src/ > /tmp/out.txt",
      "git log --oneline >> /tmp/log.txt",
      "cat a.txt | tee /tmp/copy.txt",
    ]) {
      expect(extractNeedles("Bash", { command })).toEqual([]);
    }
  });

  it("still reads a genuine inspection with no redirect", () => {
    expect(extractNeedles("Bash", { command: "git log --oneline -- intel/app/chunking/profiles.py" })).toContain(
      "intel/app/chunking/profiles.py",
    );
    expect(extractNeedles("Bash", { command: "grep -rn current_revision_id intel/app" })).toContain(
      "current_revision_id",
    );
    // A pipe between two READS is still a read.
    expect(extractNeedles("Bash", { command: "git show HEAD:profiles.py | grep MARKDOWN_ATOMIC_V1" })).toContain(
      "MARKDOWN_ATOMIC_V1",
    );
  });

  it("a plain English word is not a needle, however long", () => {
    for (const w of ["constant", "different", "something", "implementation", "retrieval", "documents"]) {
      expect(isUsableNeedle(w)).toBe(false);
    }
  });

  it("a symbol or a path still is", () => {
    // The rule is DISTINCTIVENESS, not length: an identifier or a path carries a
    // separator, a digit, or internal capitalization. Prose does not.
    //
    // `profiles.py` was in this list and is now in the reject list below. M7
    // (session 4caa06b9) measured the residual false-positive class this shape
    // admits: `activate.ts` and `install.sh` both cleared it and both interrupted
    // a code-shape grep. A bare filename is one generic word plus a file type, and
    // the full path that made the §2.1 acceptance case work is still accepted.
    for (const w of [
      "PROFILES_BY_NAME",
      "current_revision_id",
      "intel/app/knowledge/chunking/profiles.py",
      "matchOpenedIds",
      "20260609-r2-revision-backfill-plan.md",
      "MARKDOWN_ATOMIC_V1",
    ]) {
      expect(isUsableNeedle(w)).toBe(true);
    }
  });

  it("end to end: the exact call that misfired now produces nothing", () => {
    const needles = extractNeedles("Bash", {
      command: "cat >> test/lib/evidence-pointer.spec.ts <<'EOF'\nSingle profile constant MARKDOWN_ATOMIC_V1\nEOF",
    });
    expect(matchPointer(offer([DOGFOOD_PLAN]), needles)).toBeNull();
  });
});
