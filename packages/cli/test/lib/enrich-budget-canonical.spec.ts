// The Layer-2 enrich deadline has ONE value, and every consumer reads that one.
//
// WHY THIS EXISTS. d7e5bcc12 moved the deadline 6,000ms -> 10,000ms and consolidated the HOOK's
// three copies into `MLA_DEFAULT_INTERCEPT_MAX_S`, for a reason it stated plainly: "a trace that
// reports a budget the hook did not apply is an instrument lying about the very thing it exists
// to measure". That consolidation stopped at the shell script. `stats.ts` kept its own literal,
// commented as "the reader's copy", and the E13 eval in the intel repo kept a third that was
// never updated at all and still graded against 6,000 while the hook applied 10,000.
//
// Three places is how a budget drifts, and it had already drifted before this landed.
//
// WHAT THIS CAN AND CANNOT BIND. The hook is a standalone bash script; it cannot import a TS
// constant at runtime, and generating it would be a far larger change than the problem deserves.
// So the constant is canonical and this spec is the binding: the shell literal is no longer
// INDEPENDENT of it, because changing either one alone goes red. That is the same shape as the
// A5 "drift guard: user-prompt-submit.sh calls both A5 helpers" case beside it.

import * as fs from "fs";
import * as path from "path";

import {
  LAYER2_ENRICH_BUDGET_MS,
  LAYER2_ENRICH_BUDGET_S,
} from "../../src/connectors/claude-code/hook-contract";

const HOOK = path.join(__dirname, "..", "..", "src", "hooks-template", "user-prompt-submit.sh");

function hookSource(): string {
  return fs.readFileSync(HOOK, "utf8");
}

describe("the Layer-2 enrich budget is canonical, and the hook is bound to it", () => {
  it("exports seconds and milliseconds that agree with each other", () => {
    expect(LAYER2_ENRICH_BUDGET_S).toBeGreaterThan(0);
    expect(LAYER2_ENRICH_BUDGET_MS).toBe(LAYER2_ENRICH_BUDGET_S * 1000);
  });

  it("matches MLA_DEFAULT_INTERCEPT_MAX_S in the hook the operator actually runs", () => {
    const m = /^MLA_DEFAULT_INTERCEPT_MAX_S=(\d+)$/m.exec(hookSource());
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(LAYER2_ENRICH_BUDGET_S);
  });

  it("keeps the hook deriving its traced budget from that one assignment", () => {
    // The trace's `budget_ms` and curl's `--max-time` must both come from the constant. If a
    // future edit re-hard-codes either, the trace can report a deadline the hook did not apply,
    // which is the exact instrument-lying failure d7e5bcc12 closed.
    const src = hookSource();
    expect(src).toContain("MLA_DEFAULT_BUDGET_MS=$(( MLA_DEFAULT_INTERCEPT_MAX_S * 1000 ))");
    expect(src).toContain('INTERCEPT_MAX_S="${MEETLESS_INTERCEPT_MAX_S:-${MLA_DEFAULT_INTERCEPT_MAX_S}}"');
    expect(src).toContain('BUDGET_MS="$(( INTERCEPT_MAX_S * 1000 ))"');
    // And no bare numeric fallback anywhere near the traced budget.
    expect(src).not.toMatch(/budget_ms "\$\{BUDGET_MS:-\d/);
  });

  it("is the value stats.ts reports, rather than a second literal beside it", () => {
    // `mla stats ask` prints "budget Nms" under the success-latency block and decides from it
    // whether the tail is near the wall. A reader's copy that lags the hook turns that line into
    // a comparison between two different regimes.
    const stats = fs.readFileSync(path.join(__dirname, "..", "..", "src", "commands", "stats.ts"), "utf8");
    expect(stats).toContain("LAYER2_ENRICH_BUDGET_MS");
    expect(stats).not.toMatch(/const ENRICH_BUDGET_MS = 10_?000/);
  });

  it("does not disturb PRIOR_ENRICH_BUDGET_MS, which is a frozen historical boundary", () => {
    // Not a duplicate: the recovery cohort in ask-outcomes needs the deadline that USED to cut
    // these turns, and that number must NOT follow the canonical one when it next moves. Pinned
    // here so a future "deduplicate the budgets" pass does not helpfully collapse the two.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "lib", "analytics", "ask-outcomes.ts"),
      "utf8",
    );
    expect(src).toContain("export const PRIOR_ENRICH_BUDGET_MS = 6000");
    expect(LAYER2_ENRICH_BUDGET_MS).not.toBe(6000);
  });
});
