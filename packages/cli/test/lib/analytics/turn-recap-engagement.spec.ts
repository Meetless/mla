import {
  computeTurnRecap,
  renderFooter,
  renderBlock,
  type TurnRecapDeps,
} from "../../../src/lib/analytics/turn-recap";

// U1-U4 (notes/20260808-mla-in-this-session-measured-and-a-fix-proposal.md §5.1): what the
// per-turn metric can actually SEE of the push path.
//
// The measured defect: `referenced_source_ids` is `offered INTERSECT (pulled + cited)`, and
// neither half can fire when the agent reads the injected snippet inline and acts on it.
// Turns 7 and 8 of session 85d97591 were the two most valuable assists of that session (one
// of them walked back a conclusion the owner had already ruled on) and both recap as
// `pulled 0 · cited 0 · IGNORED`.
//
// What this suite does NOT do is redefine "helped". Opening a file proves the agent went to
// the source; quoting a span proves the text reached the output; neither proves usefulness,
// and an agent that opens a note to reject it is not "helped" by it. So the model here is
// three RAW signals (pulled / cited / opened, all deterministic, plus echoed as an
// explicitly-labelled heuristic) and one derived question: was any engagement OBSERVED.
//
// The important half is the negative one. When nothing fires, the only honest statement is
// "no use was observed", which is not the same claim as "the agent ignored it". The stored
// verdict keeps its wire spelling (intel pins `Literal["USED","IGNORED","NO_OFFER","NOT_RUN"]`
// on the score route, so a new member is a coordinated deploy for zero behaviour change) and
// the RENDERING stops asserting a mental state we never observed.

function ask(opts: {
  session?: string;
  turn?: number;
  offered?: { id: string; text?: string }[];
}): Record<string, unknown> {
  const offered = opts.offered ?? [];
  return {
    trace_id: "a".repeat(32),
    ts: "2026-08-08T00:00:00Z",
    session_id: opts.session ?? "s1",
    turn_index: opts.turn ?? 1,
    arbitration: { decision: "injected", reason: "enrichment_driven", discarded_after_compute: false },
    enrichment: {
      status: offered.length ? "ok" : "empty",
      context_items: offered.map((o, i) => ({
        id: `ctx_${i + 1}`,
        kind: "architecture_constraint",
        provenance: "derived_from_accepted_kb",
        source_id: o.id,
        text: o.text ?? "",
        injected: true,
      })),
    },
    hook: {
      injected: true,
      layer2_injected: offered.length > 0,
      enrich_latency_ms: 1500,
      fail_open_reason: null,
    },
    error: null,
  };
}

function read(session: string, turn: number, path: string): Record<string, unknown> {
  return { ts: "x", event: "tool_used_read", session_id: session, turn_index: turn, path };
}

function echo(session: string, turn: number, source_ids: string[]): Record<string, unknown> {
  return { ts: "x", event: "evidence_echo", session_id: session, turn_index: turn, source_ids };
}

function mcp(session: string, turn: number, source_ids: string[]): Record<string, unknown> {
  return {
    ts: "x",
    event: "tool_used_mcp",
    session_id: session,
    turn_index: turn,
    tool: "kb_doc_detail",
    evidence_tool: true,
    query: "",
    source_ids,
  };
}

function deps(files: {
  traces?: Record<string, unknown>[];
  mcp?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
  reads?: Record<string, unknown>[];
  echoes?: Record<string, unknown>[];
}): TurnRecapDeps {
  return {
    readLog: (file: string) => {
      switch (file) {
        case "ask-traces.jsonl":
          return files.traces ?? [];
        case "mcp-calls.jsonl":
          return files.mcp ?? [];
        case "report-citations.jsonl":
          return files.reports ?? [];
        case "file-reads.jsonl":
          return files.reads ?? [];
        case "evidence-echoes.jsonl":
          return files.echoes ?? [];
        default:
          return [];
      }
    },
  };
}

const NOTE = "NT:notes/20260808-acceptance-census-and-retry-exhaustion-recovery.md";
const NOTE_PATH = "/Users/alice/projects/app/notes/20260808-acceptance-census-and-retry-exhaustion-recovery.md";

describe("U1: an offered note the turn OPENS counts as observed engagement", () => {
  it("USED on a Read of the offered path, with no pull and no citation", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], reads: [read("s1", 1, NOTE_PATH)] }),
    );
    expect(r.opened_source_ids).toEqual([NOTE]);
    expect(r.verdict).toBe("USED");
    // The deterministic split stays visible: this was NOT a pull and NOT a citation, and a
    // reader must be able to tell which signal fired.
    expect(r.pull_count).toBe(0);
    expect(r.cited_source_ids).toEqual([]);
    expect(r.referenced_source_ids).toEqual([]);
    expect(r.engaged_source_ids).toEqual([NOTE]);
  });

  it("matches a note id against an absolute path at a segment boundary, never a bare suffix", () => {
    // notes/20260808-x.md must not be satisfied by .../other-notes/20260808-x.md.
    const r = computeTurnRecap(
      "s1",
      1,
      deps({
        traces: [ask({ offered: [{ id: "NT:notes/20260808-x.md" }] })],
        reads: [read("s1", 1, "/tmp/vault/other-notes/20260808-x.md")],
      }),
    );
    expect(r.opened_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("does not credit a read from another turn or another session", () => {
    const r = computeTurnRecap(
      "s1",
      2,
      deps({
        traces: [ask({ turn: 2, offered: [{ id: NOTE }] })],
        reads: [read("s1", 1, NOTE_PATH), read("s2", 2, NOTE_PATH)],
      }),
    );
    expect(r.opened_source_ids).toEqual([]);
  });

  it("does not let a non-path id (a decision, a case) be satisfied by a file read", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({
        traces: [ask({ offered: [{ id: "DE:cmexample0000000000000001" }] })],
        reads: [read("s1", 1, "/tmp/notes/cmexample0000000000000001.md")],
      }),
    );
    // A DE: id names a governed decision record, not a file on this disk. A same-named file
    // is a coincidence, and crediting it would manufacture engagement out of a filename.
    expect(r.opened_source_ids).toEqual([]);
  });
});

describe("U2: an echoed span is reported, separately, and never flips the verdict", () => {
  it("records echoed_source_ids without turning a no-signal turn into USED", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], echoes: [echo("s1", 1, [NOTE])] }),
    );
    expect(r.echoed_source_ids).toEqual([NOTE]);
    // The heuristic is diagnostic. A substring match is not an observed action, and a
    // self-reported value metric must not be allowed to err in the flattering direction.
    expect(r.engaged_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("keeps echoed out of referenced_source_ids", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], echoes: [echo("s1", 1, [NOTE])] }),
    );
    expect(r.referenced_source_ids).toEqual([]);
  });

  it("surfaces the echo in the footer as a distinct, hedged word", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], echoes: [echo("s1", 1, [NOTE])] }),
    );
    const footer = renderFooter(r);
    expect(footer).toContain("echoed 1");
    // and it must not be smuggled into the pulled/cited counters
    expect(footer).toContain("pulled 0");
    expect(footer).toContain("cited 0");
  });
});

describe("U3: no signal at all reports absence of observation, not a mental state", () => {
  it("keeps the stored verdict but stops rendering it as `IGNORED`", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [{ id: NOTE }] })] }));
    expect(r.verdict).toBe("IGNORED");
    const footer = renderFooter(r);
    expect(footer).toContain("no explicit evidence reference observed");
    expect(footer).not.toContain("IGNORED");
  });

  it("says the same thing in the expanded block", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [{ id: NOTE }] })] }));
    const block = renderBlock(r);
    expect(block).toContain("no explicit evidence reference observed");
    expect(block).not.toMatch(/verdict:\s+IGNORED/);
  });

  it("still reports USED when the agent pulled the offered id", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], mcp: [mcp("s1", 1, [NOTE])] }),
    );
    expect(r.verdict).toBe("USED");
    expect(r.referenced_source_ids).toEqual([NOTE]);
    // M1: the POSITIVE arm names the observation too. `USED` is a wire spelling on both
    // sides now, and a footer that says "USED" beside "no explicit evidence reference
    // observed" is a verdict beside a hedge, which is the asymmetry that let every
    // historical rollup read this number as adoption.
    expect(renderFooter(r)).toContain("explicit evidence reference observed");
    expect(renderFooter(r)).not.toContain("· USED");
  });
});

describe("U4: nothing offered is NO_OFFER, never a use verdict", () => {
  it("does not report absence of engagement when there was nothing to engage with", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [] })] }));
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.opened_source_ids).toEqual([]);
    expect(r.echoed_source_ids).toEqual([]);
    expect(r.engaged_source_ids).toEqual([]);
    expect(renderFooter(r)).not.toContain("reference observed");
  });

  it("a read of an unoffered note on a NO_OFFER turn credits nothing", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [] })], reads: [read("s1", 1, NOTE_PATH)] }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.opened_source_ids).toEqual([]);
  });
});

// U5 (notes/20260808-did-mla-help-session-f5e19825-...md F3): the outcome phrase names
// its SUBJECT.
//
// `5ba0bd206` already stopped the surfaces asserting a mental state ("IGNORED" ->
// "no use observed"), which is the half of F3 that was about honesty. The half left
// standing is about SCOPE. Read on its own, at the end of a line, "no use observed" is a
// verdict on the TURN, and the turn it was measured on had three of its decisions changed
// by the floor rules delivered in the same injection. What was not used is the EVIDENCE.
//
// The footer gets this half right by accident -- "evidence injected (1 src)" sits four
// fields to its left -- and `mla turn` gets it wrong outright, because `renderBlock`
// prints the phrase on EVERY verdict including the arms where nothing was ever offered.
describe("U5: the outcome phrase says WHICH channel went unused", () => {
  it("footer: scopes the phrase to the evidence channel", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [{ id: NOTE }] })] }));
    expect(renderFooter(r)).toContain("no explicit evidence reference observed");
  });

  it("block: scopes the phrase to the evidence channel", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [{ id: NOTE }] })] }));
    expect(renderBlock(r)).toContain("no explicit evidence reference observed");
  });

  // The defect this pins: `renderBlock` had no arm split, so a turn that offered NOTHING
  // still printed an evidence-use verdict. The footer has refused to do that since U4;
  // the expanded view was still doing it.
  it("block: a NO_OFFER turn reports NO_OFFER, never an evidence-use verdict", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ offered: [] })] }));
    expect(r.verdict).toBe("NO_OFFER");
    const block = renderBlock(r);
    expect(block).not.toContain("reference observed");
    expect(block).toContain("outcome:    NO_OFFER");
  });

  it("block: a USED turn is unchanged", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], mcp: [mcp("s1", 1, [NOTE])] }),
    );
    expect(renderBlock(r)).toContain("outcome:    explicit evidence reference observed");
  });
});

// M1 (2026-08-08, notes/20260808-mla-helpfulness-session-2be606bb-fix-proposal.md).
//
// The proposal's primary finding was that the adoption verdict measures citation behaviour
// and gets read as decision influence. The `INFORMED` classifier it proposed is NOT built
// here: the USED calculation still proves exactly what it always proved, and its underlying
// behaviour is preserved for compatibility. What IS corrected is the presentation, because
// that is where the claim reaches a human.
//
// The asymmetry was the whole defect. "USED" is a verdict; "no evidence use observed" is a
// hedge. Printed as a pair they read as "it worked" vs "we could not tell", so a reader
// counting greens counts adoption. Printed as two sides of one observation they read as what
// they are: an instrument that can see an explicit reference and nothing else.
describe("M1: both arms report the OBSERVATION, never the outcome", () => {
  const offered = () => deps({ traces: [ask({ offered: [{ id: NOTE }] })] });
  const referenced = () =>
    deps({ traces: [ask({ offered: [{ id: NOTE }] })], mcp: [mcp("s1", 1, [NOTE])] });

  it("the two arms are grammatically parallel, so neither reads as the stronger claim", () => {
    const hit = renderFooter(computeTurnRecap("s1", 1, referenced()));
    const miss = renderFooter(computeTurnRecap("s1", 1, offered()));
    expect(hit).toContain("explicit evidence reference observed");
    expect(miss).toContain("no explicit evidence reference observed");
    // The negative is the positive with "no" in front of it. If that ever stops being true,
    // one arm has started making a claim the other does not.
    expect(miss).toContain(`no ${"explicit evidence reference observed"}`);
  });

  it("no rendered surface claims the evidence was USED or was IGNORED", () => {
    for (const d of [offered(), referenced()]) {
      const r = computeTurnRecap("s1", 1, d);
      for (const rendered of [renderFooter(r), renderBlock(r)]) {
        expect(rendered).not.toMatch(/\bIGNORED\b/);
        expect(rendered).not.toMatch(/\bUSED\b/);
      }
    }
  });

  it("the WIRE verdict is untouched, so no consumer or stored series moves", () => {
    // Presentation-layer correction only (the proposal's own constraint, and intel pins
    // Literal["USED","IGNORED",...] on POST /v1/observability/turn-recap).
    expect(computeTurnRecap("s1", 1, referenced()).verdict).toBe("USED");
    expect(computeTurnRecap("s1", 1, offered()).verdict).toBe("IGNORED");
  });

  it("`opened` alone still counts, which is exactly why the wording had to change", () => {
    // An agent that opens a note in order to REJECT it fires `opened` and scores the
    // positive arm. The phrase must therefore stop at "a reference was observed"; it cannot
    // say the evidence was used, because on this very input it was not.
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ offered: [{ id: NOTE }] })], reads: [read("s1", 1, `/abs/${NOTE.slice(3)}`)] }),
    );
    expect(r.opened_source_ids).toEqual([NOTE]);
    expect(r.verdict).toBe("USED");
    expect(renderFooter(r)).toContain("explicit evidence reference observed");
  });
});
