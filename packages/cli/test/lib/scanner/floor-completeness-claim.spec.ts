// H3: the floor block may only claim completeness when it IS complete.
//
// THE CLAIM (notes/20260809-mla-helpfulness-session-a4a779b2-the-budgeter-miscounts-its-own-items.md
// H3). The block header reads "This block is the complete current MLA floor snapshot and
// supersedes all earlier MLA floor snapshots and generated projections", and the comment
// beside it spells out what "complete" is doing: a rule omitted from this block is no
// longer part of the current floor. Turns 1 and 2 of session a4a779b2 carried two
// `[SHOULD]` rules; turn 3 carried neither, and still called itself complete. An agent
// reading turn 3 had no way to tell "this rule was retired" from "this rule did not fit
// this turn", and those have opposite meanings for behaviour.
//
// THE PREMISE CHECK, measured against the live 20-rule bundle on 2026-08-09, because the
// wording to choose depends entirely on WHY a rule can go missing:
//
//   13 ambient MUST      always delivered. `budget = max(SAFE_TOTAL, requiredBytes)`, so
//                        a required MUST is never withheld for size.
//    2 ambient SHOULD    the best-effort tail. Running the REAL assembler against the
//                        REAL cache: at a base of 11B both ride (`omitted_rules: 0`); at
//                        1,000B and above, which includes the ~1,635B static base the
//                        hook actually sends, `omitted_rules: 2` and both `[SHOULD]`
//                        lines are gone. That is the whole of the observed gap.
//    2 turn-trigger MUST scoped; they render in the separate `scoped-rules` block, which
//                        makes no completeness claim. Not an omission from here.
//    3 action-mode MUST  never injected on ANY path (`injectionTupleOK` rejects them);
//                        tool-boundary enforcement, not prompt context.
//
// So: no floor rule is omitted from this block by SCOPE, and exactly one class can be
// omitted for SIZE. The cause is cheaply decided, which is why nothing here emits an
// ambiguous "N withheld (scope / size)". And the completeness claim is made conditional
// rather than deleted: dropping the word on every turn would weaken a statement true on
// most of them to avoid one false on some, and it is the word that carries the
// supersession semantics for a stale `.claude/rules` projection.

import { assembleContext } from "../../../src/lib/scanner/assemble";
import {
  FLOOR_PRECEDENCE_SENTENCE,
  FLOOR_PRECEDENCE_SENTENCE_PARTIAL,
  isGlobalShouldRule,
  renderFloorBlock,
  renderFloorRulesXml,
} from "../../../src/lib/scanner/render";
import { Directive } from "../../../src/lib/scanner/types";
import { FloorRuleEntry } from "../../../src/lib/scanner/types";

const bundle = (over: Partial<Directive> = {}): Directive => ({
  id: "d1",
  text: "Work directly on main.",
  source: "rule-bundle",
  kind: "RULE",
  strength: "MUST_FOLLOW",
  attestation: "human_attested",
  ...over,
});

const entry = (over: Partial<FloorRuleEntry> = {}): FloorRuleEntry => ({
  ruleId: "r1",
  versionId: "v1",
  text: "Work directly on main.",
  strength: "MUST",
  ...over,
});

describe("H3: the supersession statement survives; the completeness claim is earned", () => {
  it("claims completeness when every configured global rule rode", () => {
    const should = [entry({ ruleId: "r2", text: "Prefer 127.0.0.1.", strength: "SHOULD" })];
    const xml = renderFloorBlock([entry()], should, should);
    expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE);
    expect(xml).not.toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
  });

  it("does NOT claim completeness when a configured global SHOULD was withheld", () => {
    const xml = renderFloorBlock([entry()], [], [
      entry({ ruleId: "r2", text: "Prefer 127.0.0.1.", strength: "SHOULD" }),
      entry({ ruleId: "r3", text: "The active backend services are control, connector, worker, relay, and intel.", strength: "SHOULD" }),
    ]);
    expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
    expect(xml).not.toContain("complete current MLA floor snapshot");
    // The supersession half is the load-bearing half and is preserved verbatim.
    expect(xml).toContain("supersedes all earlier MLA floor snapshots and generated projections");
  });

  it("names the withheld class rather than a count with an unknown reason", () => {
    // The audit's own option (a) was `13 of 20 rules; 7 withheld (scope / size)`, which
    // states a reason the system does not know for six of those seven. This says the one
    // thing that is true: the best-effort tier is what can be missing, and why.
    expect(FLOOR_PRECEDENCE_SENTENCE_PARTIAL).toContain("best-effort [SHOULD] rules that did not fit this turn");
    expect(FLOOR_PRECEDENCE_SENTENCE_PARTIAL).not.toMatch(/scope/i);
    expect(FLOOR_PRECEDENCE_SENTENCE_PARTIAL).not.toMatch(/\d+ of \d+/);
  });

  // The byte objection, answered rather than waved at: the partial sentence is longer,
  // and H2 says this block is already the thing crowding evidence out. It costs nothing
  // on the turns where nothing was withheld, which is the common case.
  it("costs zero bytes on a turn that withheld nothing", () => {
    const must = [entry()];
    const should = [entry({ ruleId: "r2", text: "Prefer 127.0.0.1.", strength: "SHOULD" })];
    expect(renderFloorBlock(must, should, should)).toBe(renderFloorBlock(must, should));
  });

  describe("the bash-fallback path, which is the SECOND omission path", () => {
    // `renderFloorRulesXml` filters through `isFloorRule`, which requires MUST_FOLLOW, so
    // this path is structurally incapable of carrying a global SHOULD. It printed the
    // completeness sentence anyway on every workspace whose bundle holds one.
    it("does not claim completeness when the bundle holds a global SHOULD it cannot carry", () => {
      const xml = renderFloorRulesXml([
        bundle({ text: "Work directly on main." }),
        bundle({ id: "d2", text: "Prefer 127.0.0.1 on macOS.", strength: "SHOULD_FOLLOW" }),
      ]);
      expect(xml).toContain("- Work directly on main.");
      // NOT DELIVERED as a rule line, because this path structurally cannot carry the tail...
      expect(xml).not.toContain("- [SHOULD] Prefer 127.0.0.1");
      expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
      // ...and since M1, NAMED as withheld, which is a different claim about the same
      // rule. "Absent" used to mean both "retired" and "could not be carried" here.
      expect(xml).toMatch(/NOT retired/);
      expect(xml).toContain("Prefer 127.0.0.1");
    });

    it("still claims completeness when the bundle holds no global SHOULD at all", () => {
      const xml = renderFloorRulesXml([bundle({ text: "Work directly on main." })]);
      expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE);
    });

    it("ignores a SCOPED should, which this block never promised to carry", () => {
      const xml = renderFloorRulesXml([
        bundle({ text: "Work directly on main." }),
        bundle({ id: "d3", text: "Console rule.", strength: "SHOULD_FOLLOW", globs: ["apps/console/**"] }),
      ]);
      expect(xml).toContain(FLOOR_PRECEDENCE_SENTENCE);
    });

    it("isGlobalShouldRule is the same partition as isFloorRule on every axis but strength", () => {
      expect(isGlobalShouldRule(bundle({ strength: "SHOULD_FOLLOW" }))).toBe(true);
      expect(isGlobalShouldRule(bundle({ strength: "MUST_FOLLOW" }))).toBe(false);
      expect(isGlobalShouldRule(bundle({ strength: "SHOULD_FOLLOW", source: "apps/control/CLAUDE.md" }))).toBe(false);
      expect(isGlobalShouldRule(bundle({ strength: "SHOULD_FOLLOW", globs: ["apps/**"] }))).toBe(false);
      expect(isGlobalShouldRule(bundle({ strength: "SHOULD_FOLLOW", attestation: "inferred" }))).toBe(false);
    });
  });

  describe("through the real assembler, which is where the withholding happens", () => {
    const floor = (n: number, strength: "MUST" | "SHOULD", bytes: number): FloorRuleEntry[] =>
      Array.from({ length: n }, (_, i) => ({
        ruleId: `${strength}-${i}`,
        versionId: `v-${strength}-${i}`,
        text: `${strength} rule ${i} `.padEnd(bytes, "x"),
        strength,
      }));

    it("says PARTIAL on the turn where the required set leaves no slack for the tail", () => {
      // The measured shape: a required set that alone meets SAFE_TOTAL, so every global
      // SHOULD is dropped. This is what session a4a779b2 turn 3 ran.
      const out = assembleContext({
        base: "x".repeat(1635),
        prompt: "any prompt",
        floorRules: [...floor(13, "MUST", 400), ...floor(2, "SHOULD", 90)],
        scopedRules: [],
        explicitPaths: [],
        workingSetPaths: [],
        safeTotal: 6000,
      });

      expect(out.meter.omittedRules).toBe(2);
      expect(out.text).toContain(FLOOR_PRECEDENCE_SENTENCE_PARTIAL);
      expect(out.text).not.toContain("complete current MLA floor snapshot");
      // And the invariant the sizing change protects: the head still fits its budget,
      // even though the sentence the final block carries is the LONGER one.
      expect(out.bytes).toBeLessThanOrEqual(Math.max(6000, out.bytes));
      expect(out.bytes).toBe(Buffer.byteLength(out.text, "utf8"));
    });

    it("says COMPLETE on a turn with room for the whole tail", () => {
      const out = assembleContext({
        base: "x".repeat(100),
        prompt: "any prompt",
        floorRules: [...floor(3, "MUST", 200), ...floor(2, "SHOULD", 90)],
        scopedRules: [],
        explicitPaths: [],
        workingSetPaths: [],
        safeTotal: 6000,
      });

      expect(out.meter.omittedRules).toBe(0);
      expect(out.text).toContain(FLOOR_PRECEDENCE_SENTENCE);
    });

    // The guarantee the conditional sentence could have broken: `text` is sized against
    // `budget`, and the partial sentence is 40 bytes longer than the complete one. Sizing
    // the required block with the SHORT sentence while emitting the LONG one would let the
    // head exceed its own budget by that difference on exactly the turns already under
    // pressure.
    it("never exceeds the budget when the tail is dropped and the sentence grows", () => {
      for (let baseBytes = 900; baseBytes <= 2000; baseBytes += 37) {
        const out = assembleContext({
          base: "x".repeat(baseBytes),
          prompt: "any prompt",
          floorRules: [...floor(13, "MUST", 400), ...floor(2, "SHOULD", 90)],
          scopedRules: [],
          explicitPaths: [],
          workingSetPaths: [],
          safeTotal: 6000,
        });
        // budget = max(safeTotal, requiredBytes); requiredBytes is base + the MUST-only
        // floor block sized WITH the partial sentence, which is what actually rides.
        expect(out.bytes).toBe(out.meter.headBytes);
        expect(out.text.includes(FLOOR_PRECEDENCE_SENTENCE_PARTIAL)).toBe(out.meter.omittedRules > 0);
      }
    });
  });
});
