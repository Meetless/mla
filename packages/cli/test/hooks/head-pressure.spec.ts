// E23: when the always-on head crowds the evidence block down to its minimum, a human
// surface says so.
//
// THE DEFECT (notes/20260809-mla-helpfulness-session-a4a779b2-the-budgeter-miscounts-its-own-items.md
// H2). `MAX_MD = ceiling - head - 411 - 1400`, floored at 1200. The code's own comment
// states the assumed head (static 1,635 + floor-rules 2,584 + scoped 228 = 4,447), which
// yields a comfortable evidence budget. On session a4a779b2 turn 3 the head was 7,043B,
// 58% over the assumption, because the governed rule bundle had grown mid-session. The
// evidence block was floored at 1200B and the turn overflowed the ceiling anyway.
//
// The hook already logged that, and the log is a per-session file no report reads. It
// had fired exactly twice, both on the same day, in two different sessions, and neither
// was noticed until someone went looking by hand.
//
// WHAT IS PINNED HERE IS THE SEMANTIC CONDITION, NOT 7,043. That number is one measured
// head on one machine on one day; it is a fixture, not an invariant. The invariant is
// "a head large enough to leave less than the evidence minimum is recorded as such, and
// a head that leaves room is recorded as not". The stub sizes the head RELATIVE to the
// hook's own arithmetic, so a future change to the ceiling, the reserve or the floor
// moves the test with the code instead of stranding it on a stale constant.
//
// This suite asserts NOTHING about the head being capped, the ceiling being raised or a
// MUST-follow rule being spilled, because none of those happen: an oversized head is a
// governance question and this change only makes it countable.

import { renderAskOutcomes, summarizeAskOutcomes, toAskTraceRow } from "../../src/lib/analytics/ask-outcomes";
import { cleanupHookRuns, envelope, makeHeadStub, runEnrichHook } from "../helpers/enrich-hook-run";

// The hook's own arithmetic, restated so the fixtures below are derived from it rather
// than from a remembered byte count. Any change to these in user-prompt-submit.sh should
// break this file loudly.
const CEILING = 9500; // MEETLESS_INLINE_CONTEXT_CEILING default
const CHROME = 411; // the evidence envelope's own wrapper
const RESERVE = 1400; // the blocks built after the evidence block
const EVIDENCE_MIN = 1200; // the floor MAX_MD is clamped to
/** The largest head that still leaves the evidence minimum. */
const HEAD_WITH_ROOM = CEILING - CHROME - RESERVE - EVIDENCE_MIN;

const ITEMS = [
  { source_id: "NT:notes/20260301-a.md", text: "the first candidate. " + "body. ".repeat(400) },
  { source_id: "NT:notes/20260302-b.md", text: "the second candidate. " + "body. ".repeat(400) },
];

afterAll(cleanupHookRuns);

describe("E23: head pressure on the evidence block is recorded and reported", () => {
  jest.setTimeout(60000);

  it("records evidence_floored=true when the head leaves less than the evidence minimum", async () => {
    // One byte over the largest head that still leaves room. Derived, not remembered.
    const head = HEAD_WITH_ROOM + 1;
    const { trace } = await runEnrichHook(envelope(ITEMS), { mlaPath: makeHeadStub(head) });

    expect(trace.hook.layer2_injected).toBe(true);
    expect(trace.hook.evidence_floored).toBe(true);
    // The magnitude, so a count can be read as pressure rather than as a bare tally.
    expect(trace.hook.head_bytes).toBeGreaterThanOrEqual(head);
    // The condition is exactly "the head left less than the minimum", which is the same
    // statement as "this turn is projected to overflow the ceiling".
    expect(trace.hook.head_bytes + CHROME + RESERVE + EVIDENCE_MIN).toBeGreaterThan(CEILING);
  });

  it("records evidence_floored=false when the head leaves room, on the same payload", async () => {
    // The control. Without it a field hardcoded to true would pass the case above.
    const { trace } = await runEnrichHook(envelope(ITEMS), { mlaPath: makeHeadStub(HEAD_WITH_ROOM - 500) });

    expect(trace.hook.layer2_injected).toBe(true);
    expect(trace.hook.evidence_floored).toBe(false);
    expect(trace.hook.head_bytes + CHROME + RESERVE + EVIDENCE_MIN).toBeLessThanOrEqual(CEILING);
  });

  it("records null on a turn that rendered no evidence block", async () => {
    // Not false. A turn with no evidence block had nothing to crowd out, and counting it
    // as a healthy turn would dilute the rate with turns that were never at risk.
    const { trace } = await runEnrichHook(envelope([]), { mlaPath: makeHeadStub(HEAD_WITH_ROOM + 1) });
    expect(trace.hook.layer2_injected).toBe(false);
    expect(trace.hook.evidence_floored).toBeNull();
  });

  // THE HALF THAT WAS ACTUALLY MISSING. The condition was already detectable; nothing
  // counted it. This drives the real trace lines through the real `mla stats ask`
  // renderer and requires the floored turn to appear in what a human reads.
  it("reports the floored turn on the mla stats ask surface", async () => {
    const floored = await runEnrichHook(envelope(ITEMS), { mlaPath: makeHeadStub(HEAD_WITH_ROOM + 1) });
    const roomy = await runEnrichHook(envelope(ITEMS), { mlaPath: makeHeadStub(HEAD_WITH_ROOM - 500) });

    const rows = [floored.trace, roomy.trace]
      .map(toAskTraceRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    expect(rows).toHaveLength(2);

    const report = summarizeAskOutcomes(rows, { budgetMs: 10000 });
    expect(report.headPressure.measured).toBe(2);
    expect(report.headPressure.floored).toBe(1);
    expect(report.headPressure.flooredRate).toBe(0.5);
    expect(report.headPressure.headBytes.max).toBeGreaterThanOrEqual(HEAD_WITH_ROOM + 1);

    const text = renderAskOutcomes(report, "last 7d").join("\n");
    expect(text).toContain("HEAD PRESSURE");
    expect(text).toMatch(/1 of 2 evidence turns \(50\.0%\) floored/);
    // And it names the remedy that is NOT "raise the ceiling".
    expect(text).toContain("reclassify a floor rule");
  });

  // A window of rows written before the field existed must read UNMEASURED, never 0%.
  // A silent zero is how this condition stayed invisible in the first place.
  it("reports UNMEASURED, not zero, over rows that predate the field", () => {
    const legacy = [{ ts: "2026-08-01T00:00:00Z", enrichment: { status: "ok" }, hook: { layer2_injected: true } }]
      .map(toAskTraceRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const report = summarizeAskOutcomes(legacy, { budgetMs: 10000 });

    expect(report.headPressure.measured).toBe(0);
    expect(report.headPressure.flooredRate).toBeNull();
    const text = renderAskOutcomes(report, "last 7d").join("\n");
    expect(text).toContain("HEAD PRESSURE  UNMEASURED");
    expect(text).not.toMatch(/0 of 0/);
  });
});
