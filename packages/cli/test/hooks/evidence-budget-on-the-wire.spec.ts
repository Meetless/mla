// G1: the composer is told how wide the pipe is, and there is exactly ONE formula.
//
// THE DEFECT (notes/20260811-did-mla-help-session-5e8a7182-the-composer-writes-12kb-into-a-1-2kb-pipe.md
// I1). Intel composes against an ITEM cap and nothing else. The hook computes the byte
// budget one statement AFTER it has already received the payload, so the composer has
// never been able to make the trade it is best placed to make: three complete items beat
// four titles, and today nothing anywhere can express that.
//
// Measured over every turn carrying both composed items and a recorded head_bytes
// (n=64): intel composed a median of 12,193 bytes into a transport whose median budget
// was 1,209. 85.9% of evidence turns could not carry even half of what was composed.
// Reproduced live on 2026-08-12 against local intel: 5,428 bytes composed, 900 delivered
// at the median budget, 3 of 3 items cut to their titles.
//
// WHAT IS BEING FIXED, AND WHAT IS NOT.
//
// The budget constrains PROJECTION, never RELEVANCE. Nothing on this path lets a
// document lose a slot for being large; intel ranks and caps exactly as it did, and the
// budget only decides how many of an already-selected document's bytes are spent. A
// size-aware SELECTOR would be a new defect wearing the fix's clothes: the most relevant
// document is routinely the biggest one.
//
// The unit is UTF-8 BYTES and the field says so. The host's inline ceiling is measured
// in UTF-16 units -- the bracket is (9,991, 10,108] units / (10,015, 10,119] bytes -- and
// the hook deliberately budgets in bytes because bytes >= utf16 units >= codepoints for
// all input, so a byte budget can never under-count what the host will. `ctx_bytes`
// counts UTF-8 bytes; `max_evidence_bytes` carries that same number.
//
// THE CLI REMAINS THE FINAL HARD CAP. `budget_evidence_markdown` still runs, unchanged,
// after the response arrives. The blocks built after the evidence block can still move
// the close by up to ~1.2KB, which is what the reserve is for, so the request-time
// number is a composition target and the post-response cut is the enforcement.

import { execFileSync } from "node:child_process";
import { cleanupHookRuns, envelope, makeHeadStub, runEnrichHook } from "../helpers/enrich-hook-run";
import { join } from "node:path";

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

// The hook's own arithmetic, restated so every fixture below is derived from it rather
// than from a remembered byte count.
const CEILING = 9500; // MEETLESS_INLINE_CONTEXT_CEILING default
const CHROME = 411; // the evidence envelope's own wrapper
const RESERVE = 1400; // the blocks built after the evidence block
const EVIDENCE_MIN = 1200; // the floor the budget is clamped to
const EVIDENCE_MAX = 8600; // the historical cap the budget may never grow past

/** Run `evidence_budget_bytes <head_bytes>` against the real common.sh. */
function budgetFor(headBytes: number): { budget: number; floored: boolean } {
  const out = execFileSync(
    "bash",
    ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; evidence_budget_bytes "$1"', "mla-g1", String(headBytes)],
    { env: { ...process.env, COMMON_SH, MEETLESS_DEBUG: "0" } },
  ).toString();
  const [b, f] = out.trim().split(/\s+/);
  return { budget: Number(b), floored: f === "1" };
}

afterAll(cleanupHookRuns);

describe("G1: one evidence-budget formula, shared by the request and the cut", () => {
  it("computes ceiling - head - chrome - reserve", () => {
    const head = 3000;
    expect(budgetFor(head)).toEqual({ budget: CEILING - head - CHROME - RESERVE, floored: false });
  });

  it("floors at the evidence minimum and says that it floored", () => {
    // One byte over the largest head that still leaves room. Derived, not remembered.
    const head = CEILING - CHROME - RESERVE - EVIDENCE_MIN + 1;
    expect(budgetFor(head)).toEqual({ budget: EVIDENCE_MIN, floored: true });
  });

  it("does not report a floor at the exact head that still leaves the minimum", () => {
    // The boundary is what separates "floored" from "landed on the floor naturally";
    // a >= comparison here would report every tight-but-fitting turn as floored.
    const head = CEILING - CHROME - RESERVE - EVIDENCE_MIN;
    expect(budgetFor(head)).toEqual({ budget: EVIDENCE_MIN, floored: false });
  });

  it("is bounded by the ceiling long before the historical cap, at today's ceiling", () => {
    // WRITTEN DOWN BECAUSE THE FIRST DRAFT OF THIS SUITE ASSERTED THE OPPOSITE. The
    // `> 8600` clamp is unreachable at the default 9,500B ceiling: the largest budget a
    // zero-byte head can produce is 9500 - 411 - 1400 = 7,689. The clamp is a guard
    // against a FUTURE ceiling change licensing an 8KB+ payload, not a live bound, and
    // asserting it as one would pin a number the code never emits.
    expect(budgetFor(0).budget).toBe(CEILING - CHROME - RESERVE);
    expect(budgetFor(0).budget).toBeLessThan(EVIDENCE_MAX);
    expect(budgetFor(0).floored).toBe(false);
  });

  it("clamps to the historical cap once the ceiling is raised past it", () => {
    // The clamp's only live case, exercised through the same override the ceiling
    // already honours, so the guard is not merely dead code with a comment.
    const out = execFileSync(
      "bash",
      ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; evidence_budget_bytes 0', "mla-g1"],
      { env: { ...process.env, COMMON_SH, MEETLESS_DEBUG: "0", MEETLESS_INLINE_CONTEXT_CEILING: "20000" } },
    ).toString();
    expect(out.trim()).toBe(`${EVIDENCE_MAX} 0`);
  });

  it("treats a non-numeric head as zero rather than producing arithmetic garbage", () => {
    // Zero is the conservative reading: it can only ever yield the LARGEST budget the
    // ceiling allows, never an oversized one, and bash would otherwise either abort
    // under `set -e` or evaluate the string as 0 without saying so.
    const out = execFileSync(
      "bash",
      ["-c", 'source "$COMMON_SH" >/dev/null 2>&1; evidence_budget_bytes "not-a-number"', "mla-g1"],
      { env: { ...process.env, COMMON_SH, MEETLESS_DEBUG: "0" } },
    ).toString();
    expect(out.trim()).toBe(`${CEILING - CHROME - RESERVE} 0`);
  });
});

describe("G1: the budget reaches intel on the enrich request", () => {
  jest.setTimeout(60000);

  it("sends max_evidence_bytes, and it equals what the post-response cut will enforce", async () => {
    const headBytes = 3200;
    const run = await runEnrichHook(
      envelope([
        { source_id: "NT:notes/20260301-a.md", text: "the first candidate. " + "body. ".repeat(400) },
        { source_id: "NT:notes/20260302-b.md", text: "the second candidate. " + "body. ".repeat(400) },
      ]),
      { mlaPath: makeHeadStub(headBytes), env: { MEETLESS_INLINE_CONTEXT_CEILING: String(CEILING) } },
    );

    expect(run.requests).toHaveLength(1);
    const sent = run.requests[0].max_evidence_bytes;
    expect(typeof sent).toBe("number");

    // THE POINT OF THIS ROW: the number sent at request time is the number the cut
    // enforces at response time. Two formulas that agree today and drift tomorrow is
    // exactly the failure a shared helper exists to prevent, and `head_bytes` on the
    // trace is the post-response head read back off OUTPUT_ACC.
    const headOnTrace = run.trace.hook.head_bytes;
    expect(typeof headOnTrace).toBe("number");
    expect(sent).toBe(budgetFor(headOnTrace).budget);
  });

  it("sends the floored budget, not a negative or absent one, under head pressure", async () => {
    const headBytes = CEILING - CHROME - RESERVE - EVIDENCE_MIN + 500;
    const run = await runEnrichHook(
      envelope([{ source_id: "NT:notes/20260301-a.md", text: "body. ".repeat(400) }]),
      { mlaPath: makeHeadStub(headBytes), env: { MEETLESS_INLINE_CONTEXT_CEILING: String(CEILING) } },
    );
    expect(run.requests[0].max_evidence_bytes).toBe(EVIDENCE_MIN);
    expect(run.trace.hook.evidence_floored).toBe(true);
  });
});

describe("G4: the third instrument -- composed bytes beside the deliverable cap", () => {
  jest.setTimeout(60000);

  it("records what intel composed and what the transport could carry", async () => {
    // A DIAGNOSTIC, NOT A GATE. Nothing here has a target, a threshold or a nag: the
    // two existing instruments are both ID-grained (`selected_governed_count` counts
    // items with a source_id, `delivered_citations` counts the ids that survived) and
    // on turn 1 all four citations survived while the bytes carrying the answer did
    // not. The gap between these two numbers is the layer neither can see.
    const run = await runEnrichHook(
      envelope([
        { source_id: "NT:notes/20260301-a.md", text: "the first candidate. " + "body. ".repeat(400) },
        { source_id: "NT:notes/20260302-b.md", text: "the second candidate. " + "body. ".repeat(400) },
      ]),
      { mlaPath: makeHeadStub(3200), env: { MEETLESS_INLINE_CONTEXT_CEILING: String(CEILING) } },
    );

    expect(typeof run.trace.hook.evidence_composed_bytes).toBe("number");
    expect(typeof run.trace.hook.evidence_delivered_bytes).toBe("number");
    expect(run.trace.hook.evidence_composed_bytes).toBeGreaterThan(run.trace.hook.evidence_delivered_bytes);
    // The delivered figure is read off the payload AFTER every cut, so it can never
    // exceed the budget the same turn recorded.
    expect(run.trace.hook.evidence_delivered_bytes).toBeLessThanOrEqual(run.requests[0].max_evidence_bytes);
  });

  it("reports both numbers on a turn that fit, so the ratio has a denominator", async () => {
    const run = await runEnrichHook(envelope([{ source_id: "NT:notes/20260301-a.md", text: "short." }]), {
      mlaPath: makeHeadStub(3200),
      env: { MEETLESS_INLINE_CONTEXT_CEILING: String(CEILING) },
    });
    expect(run.trace.hook.evidence_composed_bytes).toBe(run.trace.hook.evidence_delivered_bytes);
    expect(run.trace.hook.truncated).toBe(false);
  });
});
