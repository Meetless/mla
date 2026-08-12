// F2: the hook must never HAND the host a payload it will persist, and the blocks it
// gives up to stay under that line must be the optional ones.
//
// THE DEFECT, and it is a residual rather than the one the proposal described. Budgeting
// the payload under the host ceiling already shipped (5ffceac17, 2026-08-06): the evidence
// block is sized as `ceiling - head - chrome - RESERVE`, and across 378 traces carrying
// `hook.injected_bytes` on this machine ZERO exceed 9,500B. The 12.2KB persisted injection
// the proposal cites (session ae6411e4, trace 7792a50b, 2026-08-04T13:41Z) predates that
// commit by two days.
//
// What did NOT ship is enforcement. RESERVE is a fixed 1,400B estimate of the blocks built
// AFTER the evidence block (governance, reconciliation, steer, active-review, turn-recap),
// measured p99 837 / max 1,161 over 127 real injections. Nothing checks it. When the tail
// exceeds the estimate the payload closes over the ceiling, the host persists the WHOLE
// string and injects a ~2KB preview, and the guard at the end of `intercept_main` writes a
// WARN to a per-session log file that no report reads. The cost of being wrong is total:
// past the ceiling the model loses the floor rules AND the evidence AND the tail, not just
// the overrun.
//
// THE INVARIANT, and it is deliberately one-sided. An OPTIONAL block may never be the
// reason a payload crosses the ceiling. Required content -- the static grounding, the floor
// rules, the scoped rules, the degradation markers, the evidence block, the
// evidence-unavailable notice, a coordination directive, a reconciliation finding, a human
// steer -- is never dropped, never reordered and never truncated to make room. A head that
// exceeds the ceiling on its own is a GOVERNANCE question (reclassify a floor rule) and a
// machine picking which MUST to spill is the wrong answer to it; that case is recorded, not
// solved.
//
// NOT AN A/B AND NOT A REORDER. The proposal's F2 also asked to move the evidence block
// ahead of the floor. Rejected on this file's own evidence: Layer 1 changed the outcome of
// the audited session three times and Layer 2 was cited zero times, so burying the floor
// behind the evidence trades the half that works for the half that does not. Ordering also
// stops mattering once the payload fits, which is what this suite asserts.

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanupHookRuns, envelope, makeHeadStub, runEnrichHook } from "../helpers/enrich-hook-run";

// The hook's own arithmetic, restated so every fixture below is DERIVED from it. A change
// to these constants in user-prompt-submit.sh should break this file loudly rather than
// leave it green against a stale number.
const CHROME = 411; // the evidence envelope's own wrapper
const RESERVE = 1400; // the hook's estimate of the blocks built after the evidence block
const EVIDENCE_MIN = 1200; // the floor MAX_MD is clamped to

const ITEMS = [
  { source_id: "NT:notes/20260301-a.md", text: "the first candidate. " + "body. ".repeat(400) },
  { source_id: "NT:notes/20260302-b.md", text: "the second candidate. " + "body. ".repeat(400) },
];

/**
 * Make the governance nudge fire. It is the lowest-priority tail block reachable from this
 * harness without a second turn, and it is genuinely OPTIONAL: a pending-review reminder,
 * appended after the grounding precisely so it never displaces it.
 */
function seedGovernanceNudge(home: string): void {
  const dir = join(home, "logs", "governance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pending-count-ws_hook_run.json"),
    JSON.stringify({ count: 7, ts: Math.floor(Date.now() / 1000) }),
  );
}

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

afterAll(cleanupHookRuns);

describe("F2: an optional block never pushes the payload past the inline ceiling", () => {
  jest.setTimeout(60000);

  // The head is small on purpose in both cases below: the contest has to be decided by the
  // TAIL, which is the estimate that is actually unchecked. An oversized head is the other
  // case and has its own test at the bottom.
  const HEAD = 2000;

  it("drops the governance nudge rather than close over the ceiling", async () => {
    // A ceiling chosen so the REQUIRED payload fits and the required payload plus the
    // optional nudge does not. Derived: head + separator + chrome + the clamped evidence
    // minimum, plus a hundred bytes of slack, is under it; the nudge is ~900B and is not.
    const ceiling = HEAD + 2 + CHROME + EVIDENCE_MIN + 100;
    const { additionalContext, trace } = await runEnrichHook(envelope(ITEMS), {
      mlaPath: makeHeadStub(HEAD),
      homeSetup: seedGovernanceNudge,
      env: { MEETLESS_INLINE_CONTEXT_CEILING: String(ceiling) },
    });

    // The premise: the nudge really would have fired, so its absence below is a decision
    // and not a no-op. The hook records the count it read even on the turn it declines to
    // inject, which is exactly what makes that distinguishable.
    expect(trace.governance?.pending_count).toBe(7);

    expect(utf8(additionalContext)).toBeLessThanOrEqual(ceiling);
    expect(additionalContext).not.toContain('kind="governance"');
    // ...and the reason is recorded, because a block that vanishes with no record is the
    // same failure as a WARN nobody reads.
    expect(trace.hook.inline_overflow?.dropped).toContain("governance");
  });

  it("keeps every required block while it does it", async () => {
    // The half that must survive the fix. Dropping the grounding to fit would be a worse
    // defect than the overflow: the floor is the layer this session's audit measured as
    // decisive, and the evidence block is the one the operator is paying for.
    const ceiling = HEAD + 2 + CHROME + EVIDENCE_MIN + 100;
    const { additionalContext } = await runEnrichHook(envelope(ITEMS), {
      mlaPath: makeHeadStub(HEAD),
      homeSetup: seedGovernanceNudge,
      env: { MEETLESS_INLINE_CONTEXT_CEILING: String(ceiling) },
    });

    expect(additionalContext).toContain('kind="floor-rules"');
    expect(additionalContext).toContain('kind="evidence"');
    expect(additionalContext).toContain("NT:notes/20260301-a.md");
    // Order is unchanged: the floor still leads. Asserted so a future "just reorder it"
    // has to argue with a red test rather than with a comment.
    expect(additionalContext.indexOf('kind="floor-rules"')).toBeLessThan(
      additionalContext.indexOf('kind="evidence"'),
    );
  });

  it("keeps the nudge when it fits, so the drop above is not a hardcoded skip", async () => {
    // The control. Without it a block deleted unconditionally would pass the first case.
    const { additionalContext, trace } = await runEnrichHook(envelope(ITEMS), {
      mlaPath: makeHeadStub(HEAD),
      homeSetup: seedGovernanceNudge,
      env: { MEETLESS_INLINE_CONTEXT_CEILING: "9500" },
    });

    expect(additionalContext).toContain('kind="governance"');
    expect(utf8(additionalContext)).toBeLessThanOrEqual(9500);
    expect(trace.hook.inline_overflow).toBeFalsy();
  });

  it("delivers an oversized REQUIRED payload whole, and records the overflow as a number", async () => {
    // The governance case, and it is deliberately NOT solved here. When the head alone
    // leaves less than the evidence minimum, no optional block exists to give up and the
    // remedy is to reclassify a floor rule -- with a human. What was missing is the
    // number that makes that question askable: the condition had a WARN in a per-session
    // log file that no report reads, and it had fired twice unnoticed.
    const HUGE = 9000;
    const { additionalContext, trace } = await runEnrichHook(envelope(ITEMS), {
      mlaPath: makeHeadStub(HUGE),
      env: { MEETLESS_INLINE_CONTEXT_CEILING: "9500" },
    });

    // Nothing required was spilled: a preview plus a file path still beats no context.
    expect(additionalContext).toContain('kind="floor-rules"');
    expect(additionalContext).toContain('kind="evidence"');
    expect(utf8(additionalContext)).toBeGreaterThan(9500);

    expect(trace.hook.evidence_floored).toBe(true);
    expect(trace.hook.inline_overflow?.still_over).toBe(true);
    expect(trace.hook.inline_overflow?.closed_bytes).toBeGreaterThan(9500);
    expect(trace.hook.inline_overflow?.ceiling).toBe(9500);
    // AND THE DROPPED LIST IS EMPTY, which is the assertion that caught a real bug. The
    // first cut built this record with `jq -R` over a pipe; `jq -R` reads raw LINES, and
    // an empty INLINE_DROPPED_KINDS is zero lines, so it emitted nothing and the whole
    // field fell back to null on precisely the case it exists for -- an overflow with no
    // optional block left to give up. It passed until a concurrent change stopped
    // rendering one of the optional blocks, at which point the fixture stopped
    // accidentally supplying jq with input.
    expect(trace.hook.inline_overflow?.dropped).toEqual([]);
    // The head is the magnitude a reader acts on; `HUGE + chrome + reserve + minimum` is
    // the same statement as "this turn was always going to overflow".
    expect(trace.hook.head_bytes + CHROME + RESERVE + EVIDENCE_MIN).toBeGreaterThan(9500);
  });
});
