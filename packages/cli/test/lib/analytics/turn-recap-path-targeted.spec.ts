import { computeTurnRecap, type TurnRecapDeps } from "../../../src/lib/analytics/turn-recap";
import { scorePointerOutcomes } from "../../../src/lib/analytics/pointer-outcome";
import { parsePointerFires } from "../../../src/lib/evidence-pointer";

// G1 (notes/20260810-did-mla-help-session-06e2aec1-two-ledgers-one-turn-opposite-verdicts.md).
//
// THE MEASURED DEFECT. On session 06e2aec1 turn 12, mla injected
// `NT:notes/20260810-extraction-capacity-production-needs-none.md`, the agent ran
// `sed -n '30,60p'` on exactly that path, the PreToolUse pointer intercepted the command and
// recorded `{"matched_on":"path","tool":"Bash"}`, and the agent corrected a wrong production
// claim on the strength of the excerpt. The recap scored the turn `IGNORED` with
// `engaged_reported: 0`, because `opened_source_ids` is fed by `file-reads.jsonl`, which
// post-tool-use.sh writes only when `TOOL == "Read"`. A `sed` writes nothing.
//
// Two ledgers, one turn, opposite verdicts: the pointer ledger holds a durable receipt that
// the agent went for the exact document mla served, and the verdict never opens that file.
// Measured across the whole spool: 14 of 15 path-matched fires on record are Bash and 1 is
// Read, so the engagement ledger is wired to the channel carrying 7% of the signal.
//
// WHY THIS IS NOT `opened_source_ids`. A PreToolUse receipt proves the agent explicitly
// TARGETED the source. It does not prove the source was opened -- and on turn 12 that
// distinction is load-bearing, because the pointer's own text told the agent it could skip
// the lookup. Widening "opened" to mean "might not have opened" would buy one reused bucket
// with a dishonest field, so this is its own set, derived from the pointer ledger, unioned
// into `engaged_source_ids` only.
//
// WHY READ INTENT IS A SEPARATE GATE, and it was measured rather than assumed. The review
// asked whether every Bash `matched_on:"path"` fire represents read intent. It does not.
// `extractNeedles` admits a segment headed by `git log|show|blame|diff` alongside
// `grep|cat|sed -n|head|tail`, and 3 of the 15 historical path fires came from the git arm:
// `git diff --stat -- <note>.md` and `git log --oneline -1 -- <note>.md`, every one of them
// on a note the agent was AUTHORING. Those name the file; they never consume it. Crediting
// them would let a self-audit note earn engagement for being `git diff`ed by its own author,
// which is this instrument's own stated failure direction. So the fire carries the answer the
// shell parse ALREADY computed (`read_intent`), and this reader admits only that arm.

function ask(opts: {
  session?: string;
  turn?: number;
  offered?: string[];
}): Record<string, unknown> {
  const offered = opts.offered ?? [];
  return {
    trace_id: "b".repeat(32),
    ts: "2026-08-10T21:46:36Z",
    session_id: opts.session ?? "06e2aec1",
    turn_index: opts.turn ?? 12,
    arbitration: { decision: "injected", reason: "enrichment_driven", discarded_after_compute: false },
    enrichment: {
      status: offered.length ? "ok" : "empty",
      context_items: offered.map((id, i) => ({
        id: `ctx_${i + 1}`,
        kind: "architecture_constraint",
        provenance: "derived_from_accepted_kb",
        source_id: id,
        text: "",
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

function fire(opts: {
  session?: string;
  turn?: number;
  source_id: string;
  tool?: string;
  matched_on?: "path" | "term";
  read_intent?: boolean;
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    ts: "2026-08-10T21:47:07.911Z",
    event: "evidence_pointer",
    session_id: opts.session ?? "06e2aec1",
    turn_index: opts.turn ?? 12,
    source_id: opts.source_id,
    tool: opts.tool ?? "Bash",
    matched_on: opts.matched_on ?? "path",
  };
  if (opts.read_intent !== undefined) line.read_intent = opts.read_intent;
  return line;
}

function read(session: string, turn: number, path: string): Record<string, unknown> {
  return { ts: "x", event: "tool_used_read", session_id: session, turn_index: turn, path };
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
  reads?: Record<string, unknown>[];
  pointers?: Record<string, unknown>[];
}): TurnRecapDeps {
  return {
    readLog: (file: string) => {
      switch (file) {
        case "ask-traces.jsonl":
          return files.traces ?? [];
        case "mcp-calls.jsonl":
          return files.mcp ?? [];
        case "file-reads.jsonl":
          return files.reads ?? [];
        case "evidence-pointers.jsonl":
          return files.pointers ?? [];
        default:
          return [];
      }
    },
  };
}

const NOTE = "NT:notes/20260810-extraction-capacity-production-needs-none.md";
const NOTE_PATH = "/Users/alice/projects/app/notes/20260810-extraction-capacity-production-needs-none.md";
const OTHER = "NT:notes/20260810-router-decline-and-extraction-recurrence-premise-check.md";

// --- 1. the canonical positive: turn 12, reproduced ---------------------------

describe("G1/E1: a same-turn read-intent path pointer is engagement", () => {
  it("scores USED on the turn-12 shape, where pulled, cited and opened are all empty", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, read_intent: true })],
      }),
    );

    expect(r.path_targeted_source_ids).toEqual([NOTE]);
    expect(r.engaged_source_ids).toEqual([NOTE]);
    expect(r.verdict).toBe("USED");

    // The other three signals stay exactly where they were. A reader must be able to tell
    // WHICH signal fired, and "targeted" is not "opened".
    expect(r.opened_source_ids).toEqual([]);
    expect(r.referenced_source_ids).toEqual([]);
    expect(r.cited_source_ids).toEqual([]);
    expect(r.pull_count).toBe(0);
  });

  it("FAILS CLOSED on a legacy fire that predates the read_intent stamp", () => {
    // The first cut of this admitted `undefined` on the reasoning that 12 of the 15 fires on
    // record are genuine reads. That is unknown-treated-as-yes, and it recreates the exact
    // flattering error this change exists to remove: the same 15 rows contain 3 `git diff` /
    // `git log` fires on notes the agent was AUTHORING, and no property of the durable record
    // separates them from the other 12. An unstamped fire is not evidence of read intent.
    //
    // So legacy fires contribute NOTHING. This costs the historical reclassification of
    // turn 12, which is the correct price: the instrument is right going forward, and the
    // alternative is asserting a strength the stored evidence does not have.
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({ traces: [ask({ offered: [NOTE] })], pointers: [fire({ source_id: NOTE })] }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("requires the stamp even when every other admission rule passes", () => {
    // Guards the predicate SHAPE, not just the outcome: `read_intent !== false` and
    // `read_intent === true` agree on every stamped row and differ only here, so a future
    // edit that relaxes the operator back would pass every other test in this file.
    const legacy = computeTurnRecap(
      "06e2aec1",
      12,
      deps({ traces: [ask({ offered: [NOTE] })], pointers: [fire({ source_id: NOTE })] }),
    );
    const stamped = computeTurnRecap(
      "06e2aec1",
      12,
      deps({ traces: [ask({ offered: [NOTE] })], pointers: [fire({ source_id: NOTE, read_intent: true })] }),
    );
    expect(legacy.path_targeted_source_ids).toEqual([]);
    expect(stamped.path_targeted_source_ids).toEqual([NOTE]);
  });
});

// --- 2. the existing Read positive still holds --------------------------------

describe("G1/E2: the existing Read-fed signal is untouched", () => {
  it("still counts a Read of the offered path as OPENED, with no pointer on record", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({ traces: [ask({ offered: [NOTE] })], reads: [read("06e2aec1", 12, NOTE_PATH)] }),
    );
    expect(r.opened_source_ids).toEqual([NOTE]);
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.engaged_source_ids).toEqual([NOTE]);
    expect(r.verdict).toBe("USED");
  });

  it("does not double-count when the same id is both Read and path-targeted", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        reads: [read("06e2aec1", 12, NOTE_PATH)],
        pointers: [fire({ source_id: NOTE, read_intent: true })],
      }),
    );
    expect(r.engaged_source_ids).toEqual([NOTE]);
  });
});

// --- 3. the unrelated negative ------------------------------------------------

describe("G1/E3: silence still reads as silence", () => {
  it("stays IGNORED when an offered id is never pulled, cited, opened or targeted", () => {
    const r = computeTurnRecap("06e2aec1", 12, deps({ traces: [ask({ offered: [NOTE] })] }));
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.engaged_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("credits only the targeted id when two were offered", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE, OTHER] })],
        pointers: [fire({ source_id: NOTE, read_intent: true })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([NOTE]);
    expect(r.engaged_source_ids).toEqual([NOTE]);
  });
});

// --- 4. the term-match negative (the F5 guard, held at the reader) -------------

describe("G1/E4: a term match never becomes engagement", () => {
  it("ignores matched_on:'term', which is a lexical coincidence and not a target", () => {
    // F5 stopped Bash term matches at the MATCHER. This holds the same line at the READER,
    // so a future widening of the matcher cannot silently start minting engagement.
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, matched_on: "term", read_intent: true })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });
});

// --- 5. the wrong-turn / wrong-source / wrong-session negatives ----------------

describe("G1/E5: the join is keyed on (session, turn, offered id)", () => {
  it("does not credit a fire from another turn", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, turn: 11, read_intent: true })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("does not credit a fire from another session", () => {
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, session: "d1f7f163", read_intent: true })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });

  it("does not credit a fire for a source that was not offered this turn", () => {
    // The pointer only fires on the current turn's offer sidecar, so this should be
    // unreachable in practice. It is pinned anyway: the reader must never widen the offered
    // set, because `engaged ⊆ offered` is what makes the rate a rate.
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: OTHER, read_intent: true })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.engaged_source_ids).toEqual([]);
  });
});

// --- 6. the git-metadata negative (the measured false-positive class) ----------

describe("G1: a path fire that merely NAMES the file is not engagement", () => {
  it("drops a fire the shell parse classified as non-read (git diff / git log)", () => {
    // Measured, 3 of 15 historical path fires: `git diff --stat -- <note>.md`,
    // `git log --oneline -1 -- <note>.md`, each on a note the agent was writing. The needle
    // came from an admitted inspection segment, so `matched_on` is honestly "path"; the
    // command never read a byte of the document.
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, read_intent: false })],
      }),
    );
    expect(r.path_targeted_source_ids).toEqual([]);
    expect(r.verdict).toBe("IGNORED");
  });
});

// --- 7. the self-grading guard (pointer-outcome's rule, unchanged) -------------

describe("G1/E6: F1 still cannot bank its own prompting", () => {
  it("attributes a pointer-driven pull to the POINTER, so it is subtractable", () => {
    // The case pointer-outcome.ts exists to prevent: pointer fires -> agent calls an
    // evidence tool on the named id -> utilization rises because mla told it to. That
    // engagement is still attributed to the pointer and still subtractable from the
    // turn-start injection's own rate. G1 does not touch this arm.
    const fires = parsePointerFires([fire({ source_id: NOTE, matched_on: "term" })]);
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        mcp: [mcp("06e2aec1", 12, [NOTE])],
        pointers: [fire({ source_id: NOTE, matched_on: "term" })],
      }),
    );
    // The pull itself is real and referenced, exactly as before.
    expect(r.referenced_source_ids).toEqual([NOTE]);
    // ...and it is fully attributed to the pointer, so subtracting it leaves nothing.
    const outcome = scorePointerOutcomes(fires, [
      {
        session_id: r.session_id,
        turn_index: r.turn_index,
        referenced_source_ids: r.referenced_source_ids,
        opened_source_ids: r.opened_source_ids,
      },
    ]);
    expect(outcome.attributed_source_ids).toEqual([NOTE.toLowerCase().replace(/\.md$/, "")]);
  });

  it("does not let a path fire earn engagement through the pointer's own attribution set", () => {
    // The causal argument for G1: by the time PreToolUse fires on the Bash command, the model
    // has ALREADY chosen the path. The pointer witnesses a tool invocation it did not
    // manufacture. So `path_targeted` is upstream-clean -- but it must not also be fed back
    // into pointer attribution as if the pointer caused it, which would double-count.
    const r = computeTurnRecap(
      "06e2aec1",
      12,
      deps({
        traces: [ask({ offered: [NOTE] })],
        pointers: [fire({ source_id: NOTE, read_intent: true })],
      }),
    );
    expect(r.opened_source_ids).toEqual([]);
    expect(r.referenced_source_ids).toEqual([]);
  });
});
