import { Buffer } from "node:buffer";
import {
  AssembleInput,
  BaseInvariantError,
  assembleContext,
} from "../../../src/lib/scanner/assemble";
import { FloorRuleEntry, ScopedRuleEntry } from "../../../src/lib/scanner/types";
import {
  OVERFLOW_MARKER_TEXT,
  renderFloorBlock,
  renderOverflowMarker,
  renderScopedBlock,
} from "../../../src/lib/scanner/render";

// Behavioral tests for the byte-budgeted assembler core (targeted-rule-injection §8). These
// assert the *observable* envelope + audit, not the internal call graph: the exact bytes emitted,
// which rule TEXTS survive, and which ruleIds land in delivered/omitted. The assembler is the
// single owner of the model-facing head, so "did we deliver rule X" is answered by the rendered
// string and the delivered/omitted ledger, never by a spy.

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// A small, fixed LAYER1-shaped base (counted as part of the always-fit base).
const BASE = 'workspace_hint: ws_test\nUse the governed evidence tools before answering.';

function floor(over: Partial<FloorRuleEntry> = {}): FloorRuleEntry {
  return { ruleId: "fm1", versionId: "v1", text: "never push without explicit consent", strength: "MUST", ...over };
}
function scoped(over: Partial<ScopedRuleEntry> = {}): ScopedRuleEntry {
  return {
    ruleId: "s1",
    versionId: "v1",
    text: "guard the transactional outbox on every write",
    strength: "MUST",
    globs: ["apps/control/**"],
    ...over,
  };
}

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    base: BASE,
    // Empty prompt by default: the existing suites exercise explicit-path and working-set
    // behavior, never turn triggers, so the unparsed prompt is irrelevant to them. The
    // turn-trigger suites below pass their own `prompt`.
    prompt: "",
    floorRules: [],
    scopedRules: [],
    explicitPaths: [],
    workingSetPaths: [],
    safeTotal: 1800,
    ...over,
  };
}

describe("assembleContext — happy path (floor + explicit-matched scoped both delivered)", () => {
  it("delivers the global MUST floor and an explicit-path scoped MUST, under budget", () => {
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped()],
        explicitPaths: ["apps/control/outbox.ts"],
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("never push without explicit consent");
    expect(out.text).toContain("guard the transactional outbox on every write");
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s1", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    // The byte count is the assembler's final word: it equals the emitted string and holds the
    // ceiling. No model-facing string may be appended after this assertion (§4.1 central owner).
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });

  it("leaves a scoped rule out of REQUIRED when no explicit path matches (working set is a hint)", () => {
    // Same rule, but the path only appears in the working set: it is best-effort, not required,
    // so an empty working set means it is simply absent (never an overflow).
    const out = assembleContext(input({ floorRules: [floor()], scopedRules: [scoped()] }));
    expect(out.overflow).toBe(false);
    expect(out.text).not.toContain("guard the transactional outbox");
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
  });
});

describe("assembleContext — overflow preserves floor, no partial subset, audits ALL", () => {
  it("drops every required scoped rule, keeps the floor, emits the instructive marker", () => {
    const big = "x".repeat(3000);
    const out = assembleContext(
      input({
        floorRules: [floor()],
        // Two required scoped rules; even the SMALL one is dropped (no partial subset) because
        // the required set as a whole cannot fit alongside the base.
        scopedRules: [
          scoped({ ruleId: "s_small", text: "small required rule", globs: ["apps/control/**"] }),
          scoped({ ruleId: "s_big", text: big, globs: ["apps/control/**"] }),
        ],
        explicitPaths: ["apps/control/outbox.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    // Floor preserved.
    expect(out.text).toContain("never push without explicit consent");
    // Marker present, in place of the scoped block.
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    // No partial subset: NEITHER scoped rule text leaks, not even the one that would fit alone.
    expect(out.text).not.toContain("small required rule");
    expect(out.text).not.toContain("xxx");
    // Delivered is floor-only.
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    // Audits ALL omitted required ids (not just the first), each with the overflow reason.
    expect(out.omitted).toEqual([
      { ruleId: "s_small", reason: "overflow:required-scoped-did-not-fit" },
      { ruleId: "s_big", reason: "overflow:required-scoped-did-not-fit" },
    ]);
    // Marker output still respects the ceiling.
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });

  it("the overflow marker always fits because the base invariant reserves its room", () => {
    // A required scoped rule so large it can never fit; the returned head is base+floor+marker
    // and is still under budget. This is the marker-fit guarantee.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ text: "y".repeat(5000) })],
        explicitPaths: ["apps/control/outbox.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });
});

describe("assembleContext — base invariant (failed-compile precondition)", () => {
  it("throws BaseInvariantError when base + floor + marker exceeds SAFE_TOTAL", () => {
    // The universal floor grew past the budget: the caller must fall back to last-known-good,
    // never invent a partial floor. (The subcommand turns this into a null return + audit.)
    const call = () =>
      assembleContext(input({ floorRules: [floor({ text: "z".repeat(3000) })], safeTotal: 1800 }));
    expect(call).toThrow(BaseInvariantError);
    try {
      call();
    } catch (e) {
      expect(e).toBeInstanceOf(BaseInvariantError);
      expect((e as BaseInvariantError).safeTotal).toBe(1800);
      expect((e as BaseInvariantError).baseBytes).toBeGreaterThan(1800);
    }
  });
});

describe("assembleContext — overflow-marker room is reserved CONDITIONALLY (zero scoped rules)", () => {
  // The band this pins: base+floor fits, but base+floor+marker does not. The old invariant
  // reserved marker room unconditionally and threw here even with no scoped rules; the marker is
  // unreachable in that case (renderScopedBlock([]) is "", so the required-overflow branch never
  // fires), so the floor must be delivered whole instead.
  const floorRule = floor({ text: "keep the compressed floor within the inline budget" });
  const head = BASE + "\n" + renderFloorBlock([floorRule]); // exactly what gets emitted (no scoped)
  const headBytes = bytes(head);
  const markerBytes = bytes(renderOverflowMarker());

  it("delivers a floor that fits base+floor but not base+floor+marker when no scoped rule exists", () => {
    // Budget = exactly base+floor. head+marker would overrun it, so the old unconditional
    // reservation would have thrown; with zero scoped rules the assembler delivers the floor.
    expect(headBytes + markerBytes).toBeGreaterThan(headBytes); // marker genuinely would not fit
    const out = assembleContext(input({ floorRules: [floorRule], scopedRules: [], safeTotal: headBytes }));
    expect(out.overflow).toBe(false);
    expect(out.text).toBe(head);
    expect(out.bytes).toBe(headBytes);
    expect(out.bytes).toBeLessThanOrEqual(headBytes);
    expect(out.delivered).toEqual([{ ruleId: floorRule.ruleId, tier: "floor-must" }]);
    expect(out.omitted).toEqual([]);
  });

  it("does NOT reserve marker room for a best-effort (working-set-only) scoped rule (§5.5 change 3)", () => {
    // Same floor, same tight budget, and a scoped MUST is present but reachable ONLY via the working
    // set (no explicit path matches its glob). Pre-§5.5-change-3 the invariant gated on
    // `scopedRules.length > 0`, so merely configuring this rule reserved the marker here and threw
    // BaseInvariantError, dropping the whole turn to the bash fallback. Post-fix the reservation is
    // gated on the REQUIRED explicit-path set: a best-effort rule can never emit the fail-loud marker
    // and so must not reserve its bytes. The floor is delivered whole, the (unmatched) rule is simply
    // absent, and nothing throws. This is the fix that removes the every-turn marker tax a configured
    // turn / working-set rule used to levy.
    const out = assembleContext(
      input({ floorRules: [floorRule], scopedRules: [scoped()], explicitPaths: [], safeTotal: headBytes }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toBe(head);
    expect(out.bytes).toBe(headBytes);
    expect(out.delivered).toEqual([{ ruleId: floorRule.ruleId, tier: "floor-must" }]);
    expect(out.omitted).toEqual([]);
  });
});

describe("assembleContext — turn-scoped rule delivery (§7 P3: required reserves failure capacity, best-effort does not)", () => {
  // A turn rule is a scoped rule carrying a TurnTrigger and NO globs (§5.1). It is best-effort by
  // construction: it can never be scopedRequired (that needs a glob matched by an explicit path), so
  // it can never reserve the fail-loud marker nor throw the base invariant. It rides only when its
  // trigger fires AND the remaining capacity holds it.
  const turnRule = (over: Partial<ScopedRuleEntry> = {}): ScopedRuleEntry =>
    scoped({ ruleId: "s_turn", globs: [], trigger: { promptAny: ["design doc"] }, ...over });

  // base + floor fits at this budget, but base + floor + marker would not — the exact band §5.5
  // change 3 is about. Under the OLD `reserveMarker = scopedRules.length > 0`, merely configuring a
  // turn rule reserved the marker here and threw, dropping the whole turn to the bash fallback.
  const floorRule = floor({ text: "keep the compressed floor within the inline budget" });
  const head = BASE + "\n" + renderFloorBlock([floorRule]);
  const headBytes = bytes(head);

  it("1. unmatched turn rule + heavy base: normal assembly, no marker reservation, no fallback", () => {
    // The trigger needle ("design doc") is absent from a bug-fix prompt, so the rule is not even a
    // candidate. base+floor fills the budget exactly; base+floor+marker would overrun it. The rule
    // must NOT reserve the marker (no throw), the floor is delivered whole, and the turn rule is
    // neither delivered nor audited-omitted (it simply did not apply this turn).
    const out = assembleContext(
      input({
        floorRules: [floorRule],
        scopedRules: [turnRule({ text: "include a Mermaid diagram in the design doc" })],
        prompt: "fix the null-pointer crash in the parser",
        explicitPaths: [],
        safeTotal: headBytes,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toBe(head);
    expect(out.bytes).toBe(headBytes);
    expect(out.delivered).toEqual([{ ruleId: floorRule.ruleId, tier: "floor-must" }]);
    // Unmatched -> not a candidate -> neither delivered nor omitted.
    expect(out.omitted).toEqual([]);
    expect(out.delivered.some((d) => d.ruleId === "s_turn")).toBe(false);
  });

  it("2. matched turn MUST + insufficient capacity: fails LOUD (mandatory, §7.1/§7.5), floor preserved, NOT best-effort dropped", () => {
    // §7 INVERSION of the old droppable-MUST behavior. The trigger fires (the prompt contains
    // 'design doc'), so this turn-matched MUST is now MANDATORY, not a best-effort candidate. The
    // 3000-byte rule cannot fit, so the assembler fails LOUD: overflow true, the fail-loud marker
    // replaces the scoped block, the floor is preserved, and the MUST is audited with the OVERFLOW
    // reason (never `best-effort:did-not-fit`, which would be a silent drop of a mandatory rule).
    // Budget 1800 comfortably holds base+floor+marker, so this is a mandatory-overflow, NOT a
    // BaseInvariantError (the floor itself still fits).
    const out = assembleContext(
      input({
        floorRules: [floorRule],
        scopedRules: [turnRule({ text: "d".repeat(3000) })],
        prompt: "draft the design doc for the approvals flow",
        explicitPaths: [],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.text).toContain("keep the compressed floor within the inline budget");
    expect(out.text).not.toContain("dddd");
    expect(out.delivered).toEqual([{ ruleId: floorRule.ruleId, tier: "floor-must" }]);
    expect(out.omitted).toEqual([{ ruleId: "s_turn", reason: "overflow:required-scoped-did-not-fit" }]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });

  it("3. required explicit-path rule overflow: marker reservation and fail-loud unchanged", () => {
    // Guardrail that the reserveMarker fix did NOT touch the required path. An explicit-path scoped
    // MUST too large to fit still reserves the marker, fails loud (overflow true), preserves the
    // floor, and audits the required id with the overflow reason.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_req", text: "r".repeat(3000), globs: ["apps/control/**"] })],
        explicitPaths: ["apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.text).toContain("never push without explicit consent");
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    expect(out.omitted).toEqual([{ ruleId: "s_req", reason: "overflow:required-scoped-did-not-fit" }]);
  });

  it("4. matched turn MUST + explicit MUST both fit: BOTH delivered scoped-required (turn MUST is now mandatory, §7.1)", () => {
    // §7 INVERSION of the old behavior where the turn rule was best-effort and dropped while the
    // explicit-path MUST rode. Now a matched turn MUST joins the SAME mandatory set as the
    // explicit-path MUST. Both are small and both fit, so both are delivered as scoped-required,
    // ordered ahead of any SHOULD. Overflow stays false because the whole mandatory set fit.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [
          scoped({ ruleId: "s_req", text: "guard the outbox on every write", globs: ["apps/control/**"] }),
          turnRule({ text: "include a Mermaid diagram in the design doc" }),
        ],
        explicitPaths: ["apps/control/x.ts"],
        prompt: "update the design doc and the outbox",
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("guard the outbox on every write");
    expect(out.text).toContain("include a Mermaid diagram in the design doc");
    expect(out.delivered).toContainEqual({ ruleId: "fm1", tier: "floor-must" });
    expect(out.delivered).toContainEqual({ ruleId: "s_req", tier: "scoped-required" });
    expect(out.delivered).toContainEqual({ ruleId: "s_turn", tier: "scoped-required" });
    // No mandatory rule was dropped, so nothing is omitted.
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });

  it("4b. matched turn MUST overflows: the WHOLE mandatory set fails loud, taking down even the deliverable explicit MUST (no partial subset, §7.5)", () => {
    // The mandatory set is all-or-nothing. Here a small explicit-path MUST (s_req) WOULD fit on its
    // own, but a huge matched turn MUST (s_turn) cannot. Because both are mandatory and there is no
    // partial-subset delivery, the assembler drops the entire mandatory set and fails loud: overflow
    // true, floor preserved, and BOTH mandatory ids audited with the overflow reason. This is the
    // safety property — a mandatory rule is never silently traded away to squeeze in another.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [
          scoped({ ruleId: "s_req", text: "guard the outbox on every write", globs: ["apps/control/**"] }),
          turnRule({ text: "d".repeat(3000) }),
        ],
        explicitPaths: ["apps/control/x.ts"],
        prompt: "update the design doc and the outbox",
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.text).toContain("never push without explicit consent");
    expect(out.text).not.toContain("guard the outbox on every write");
    expect(out.text).not.toContain("dddd");
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    expect(out.omitted).toEqual([
      { ruleId: "s_req", reason: "overflow:required-scoped-did-not-fit" },
      { ruleId: "s_turn", reason: "overflow:required-scoped-did-not-fit" },
    ]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeLessThanOrEqual(1800);
  });

  it("5. a whitespace-only trigger needle from a foreign cache does NOT match every turn (matcher guard)", () => {
    // Defense-in-depth for the `includes("")` coercion. The grammar owner rejects a blank needle, so
    // this trigger can only arrive from a cache written by an older/foreign build. The matcher must
    // drop the empty-normalized needle, not fire on it: with an unrelated prompt the rule stays
    // out of the candidate set entirely (neither delivered nor audited-omitted), exactly as an
    // unmatched turn rule does — NOT delivered-on-every-turn.
    const out = assembleContext(
      input({
        floorRules: [floorRule],
        scopedRules: [turnRule({ ruleId: "s_blank", text: "should never ride", trigger: { promptAny: ["   "] } })],
        prompt: "fix the null-pointer crash in the parser",
        explicitPaths: [],
        safeTotal: headBytes,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toBe(head);
    expect(out.delivered.some((d) => d.ruleId === "s_blank")).toBe(false);
    expect(out.omitted).toEqual([]);
  });
});

describe("assembleContext — multibyte budgeting (bytes, not characters)", () => {
  it("counts UTF-8 bytes: bytes === byteLength(text), and a multibyte rule is measured by bytes", () => {
    // Vietnamese floor text (multibyte) — the reported byte count must match the encoded string.
    const out = assembleContext(
      input({ floorRules: [floor({ text: "không bao giờ đẩy mã khi chưa được phép" })] }),
    );
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.text).toContain("không bao giờ đẩy mã khi chưa được phép");
  });

  it("drops a best-effort candidate whose BYTE length overruns even though its CHAR length fits", () => {
    // 200 CJK chars: length 200 (< safeTotal 400) but 600 UTF-8 bytes (> 400). A char-counting
    // budget would keep it; the byte-counting budget must drop it. No floor, tiny base.
    const cjk = "字".repeat(200);
    expect(cjk.length).toBeLessThan(400);
    expect(bytes(cjk)).toBeGreaterThan(400);
    const out = assembleContext(
      input({
        base: "b",
        scopedRules: [scoped({ ruleId: "s_cjk", text: cjk, strength: "SHOULD" })],
        explicitPaths: ["apps/control/x.ts"],
        safeTotal: 400,
      }),
    );
    expect(out.delivered.find((d) => d.ruleId === "s_cjk")).toBeUndefined();
    expect(out.omitted).toContainEqual({ ruleId: "s_cjk", reason: "best-effort:did-not-fit" });
  });
});

describe("assembleContext — byte-budget boundary (inclusive fill predicate)", () => {
  it("keeps a best-effort candidate at EXACTLY safeTotal and drops it one byte tighter", () => {
    // Pins the greedy fill predicate `byteLength(trial) <= safeTotal` (assemble.ts) at its exact
    // boundary: measure the head size with the candidate included under a generous budget, then
    // re-run at that exact byte count (must keep it — proves `<=`, not `<`) and one byte tighter
    // (must drop it — proves it is a real ceiling, not an off-by-one). The candidate is a SHOULD
    // long enough that the marker room is never the binding constraint, so the base invariant
    // holds at both budgets and only the best-effort fill flips.
    const candidate = scoped({
      ruleId: "s_edge",
      text: "guard the edge invariant carefully " + "e".repeat(300),
      strength: "SHOULD",
      globs: ["apps/edge/**"],
    });
    const shared = {
      floorRules: [floor()],
      scopedRules: [candidate],
      explicitPaths: ["apps/edge/x.ts"],
    };
    const generous = assembleContext(input({ ...shared, safeTotal: 100000 }));
    expect(generous.delivered.map((d) => d.ruleId)).toContain("s_edge");
    const exact = generous.bytes;

    // At exactly `exact` bytes the inclusive predicate must still deliver the candidate.
    const atBoundary = assembleContext(input({ ...shared, safeTotal: exact }));
    expect(atBoundary.delivered.map((d) => d.ruleId)).toContain("s_edge");
    expect(atBoundary.omitted).toEqual([]);
    expect(atBoundary.bytes).toBe(exact);
    expect(atBoundary.overflow).toBe(false);

    // One byte tighter, the SAME candidate no longer fits: dropped best-effort, floor preserved,
    // overflow stays false (a droppable SHOULD never triggers the required-overflow marker).
    const tighter = assembleContext(input({ ...shared, safeTotal: exact - 1 }));
    expect(tighter.delivered.map((d) => d.ruleId)).not.toContain("s_edge");
    expect(tighter.omitted).toContainEqual({ ruleId: "s_edge", reason: "best-effort:did-not-fit" });
    expect(tighter.text).toContain("never push without explicit consent");
    expect(tighter.overflow).toBe(false);
    expect(tighter.bytes).toBeLessThan(exact);
  });
});

describe("assembleContext — working-set-matched MUST is MANDATORY (§7.2), delivered or fails loud", () => {
  const noisyWorkingSet = Array.from({ length: 40 }, (_v, i) => `apps/other/mod-${i}/file.ts`);

  it("delivers a working-set-only scoped MUST that fits as scoped-required (mandatory, not best-effort)", () => {
    // §7.2 INVERSION: an applicable MUST is mandatory regardless of match signal, so a rule matched
    // ONLY via the working set (its glob hits a dirty file, no explicit path) is now scoped-required,
    // ordered ahead of every SHOULD. Under a comfortable budget it rides; it is never a droppable tail.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_ws", text: "guard the outbox on every write" })],
        explicitPaths: [],
        workingSetPaths: [...noisyWorkingSet, "apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("guard the outbox on every write");
    expect(out.delivered).toContainEqual({ ruleId: "s_ws", tier: "scoped-required" });
    expect(out.omitted).toEqual([]);
  });

  it("fails LOUD when a working-set-only scoped MUST cannot fit (§7.5 marker extended to working-set MUST)", () => {
    // The same working-set MUST, now oversize. Under §7.5 the fail-loud marker is extended from the
    // explicit-path required set to working-set MUST: the rule overflows loud (overflow true), the
    // floor is preserved, and it is audited with the OVERFLOW reason, never dropped best-effort. This
    // repeals the old "contaminated working set never forces a required overflow" invariant.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_ws", text: "w".repeat(3000) })],
        explicitPaths: [],
        workingSetPaths: [...noisyWorkingSet, "apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    expect(out.omitted).toEqual([{ ruleId: "s_ws", reason: "overflow:required-scoped-did-not-fit" }]);
  });

  it("an oversize EXPLICIT-path scoped MUST fails loud identically (signal no longer changes mandatoriness)", () => {
    // Under §7 the explicit-path vs working-set distinction no longer changes whether a MUST is
    // mandatory: both are. An oversize explicit-path MUST fails loud exactly like the working-set one.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_explicit", text: "w".repeat(3000) })],
        explicitPaths: ["apps/control/x.ts"],
        workingSetPaths: noisyWorkingSet,
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).toContain(OVERFLOW_MARKER_TEXT);
    expect(out.omitted).toEqual([
      { ruleId: "s_explicit", reason: "overflow:required-scoped-did-not-fit" },
    ]);
  });
});

describe("assembleContext — directory-token glob match", () => {
  it("matches an explicit `apps/control/` directory token against an `apps/control/**` glob", () => {
    // The trailing-slash directory token (from prompt-paths) must promote a rule globbed on the
    // directory tree — the shared matcher agrees with Plane B on directory semantics.
    const out = assembleContext(
      input({
        scopedRules: [scoped({ ruleId: "s_dir", globs: ["apps/control/**"] })],
        explicitPaths: ["apps/control/"],
      }),
    );
    expect(out.delivered).toContainEqual({ ruleId: "s_dir", tier: "scoped-required" });
  });
});

describe("assembleContext — global SHOULD overflow (droppable tail, floor survives)", () => {
  it("omits a global SHOULD that does not fit while keeping the global MUST floor", () => {
    // Base + floor MUST + marker fits (base invariant holds), but the SHOULD tail does not:
    // the SHOULD is dropped best-effort, the MUST rides, and nothing throws.
    const out = assembleContext(
      input({
        floorRules: [floor(), { ruleId: "fs1", versionId: "v1", text: "s".repeat(3000), strength: "SHOULD" }],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("never push without explicit consent");
    expect(out.text).not.toContain("sss");
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    expect(out.omitted).toContainEqual({ ruleId: "fs1", reason: "best-effort:did-not-fit" });
  });
});

describe("assembleContext — best-effort rank order and dedup", () => {
  it("fills best-effort SHOULD candidates in rank order: explicit SHOULD > global SHOULD > working-set SHOULD (§7.2: the working-set MUST is mandatory, not a best-effort tail)", () => {
    const out = assembleContext(
      input({
        floorRules: [
          floor(),
          { ruleId: "global_should", versionId: "v1", text: "prefer the simplest solution", strength: "SHOULD" },
        ],
        scopedRules: [
          scoped({ ruleId: "explicit_should", text: "explicit should rule", strength: "SHOULD", globs: ["apps/a/**"] }),
          scoped({ ruleId: "ws_must", text: "working set must rule", strength: "MUST", globs: ["apps/b/**"] }),
          scoped({ ruleId: "ws_should", text: "working set should rule", strength: "SHOULD", globs: ["apps/c/**"] }),
        ],
        explicitPaths: ["apps/a/x.ts"],
        workingSetPaths: ["apps/b/y.ts", "apps/c/z.ts"],
        safeTotal: 1800,
      }),
    );
    // §7.2 INVERSION: a working-set-matched MUST is mandatory, delivered as scoped-required
    // AHEAD of every SHOULD, never mixed into the best-effort ladder.
    expect(out.delivered).toContainEqual({ ruleId: "ws_must", tier: "scoped-required" });
    const bestEffortOrder = out.delivered.filter((d) => d.tier === "best-effort").map((d) => d.ruleId);
    expect(bestEffortOrder).toEqual(["explicit_should", "global_should", "ws_should"]);
  });

  it("dedupes a rule that appears twice in the scoped set by ruleId (delivered once)", () => {
    const dup = scoped({ ruleId: "dup", text: "deduped rule", strength: "SHOULD", globs: ["apps/a/**"] });
    const out = assembleContext(
      input({ scopedRules: [dup, dup], explicitPaths: ["apps/a/x.ts"], safeTotal: 1800 }),
    );
    const dupHits = out.delivered.filter((d) => d.ruleId === "dup");
    expect(dupHits).toHaveLength(1);
  });

  it("never re-renders a REQUIRED rule as best-effort (cross-tier dedup seeded from requiredIds)", () => {
    // The same ruleId surfaces through two channels: a MUST matched by an explicit path (REQUIRED)
    // and a SHOULD also matched by that path (a tier-1 best-effort candidate). `seen` is seeded
    // with the required ids, so the best-effort ladder must skip it — delivered once, as
    // scoped-required, never a second time as best-effort, and its text renders exactly once.
    const out = assembleContext(
      input({
        scopedRules: [
          scoped({ ruleId: "dual", text: "guard the dual-matched rule", strength: "MUST", globs: ["apps/dual/**"] }),
          scoped({ ruleId: "dual", text: "guard the dual-matched rule", strength: "SHOULD", globs: ["apps/dual/**"] }),
        ],
        explicitPaths: ["apps/dual/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.delivered.filter((d) => d.ruleId === "dual")).toEqual([
      { ruleId: "dual", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    // The rule text appears once in the head, not twice (no best-effort re-render).
    expect(out.text.split("guard the dual-matched rule").length - 1).toBe(1);
  });
});

describe("assembleContext — no model-facing bytes escape the assertion (central owner)", () => {
  it("returns bytes === byteLength(text) <= safeTotal across normal, overflow, and marker paths", () => {
    const scenarios: AssembleInput[] = [
      input({ floorRules: [floor()], scopedRules: [scoped()], explicitPaths: ["apps/control/x.ts"] }),
      input({ floorRules: [floor()], scopedRules: [scoped({ text: "q".repeat(4000) })], explicitPaths: ["apps/control/x.ts"] }),
      input({ floorRules: [floor(), { ruleId: "fs", versionId: "v", text: "a should", strength: "SHOULD" }] }),
    ];
    for (const s of scenarios) {
      const out = assembleContext(s);
      expect(out.bytes).toBe(bytes(out.text));
      expect(out.bytes).toBeLessThanOrEqual(s.safeTotal);
    }
  });

  it("renders exactly one floor block and (at most) one scoped block — the sole emit path", () => {
    // Structural guard for "no-append-after-assert": the assembler emits ONE head; a stray second
    // rule block would mean a second, unbudgeted emit path had crept in.
    const out = assembleContext(
      input({ floorRules: [floor()], scopedRules: [scoped()], explicitPaths: ["apps/control/x.ts"] }),
    );
    const floorBlocks = out.text.split('kind="floor-rules"').length - 1;
    const scopedBlocks = out.text.split('kind="scoped-rules"').length - 1;
    expect(floorBlocks).toBe(1);
    expect(scopedBlocks).toBe(1);
    // And the constituent renders are byte-for-byte the shared renderers' output (no re-wrapping).
    expect(out.text).toContain(renderFloorBlock([floor()]));
    expect(out.text).toContain(renderScopedBlock([{ text: scoped().text, strength: "MUST" }]));
  });
});

describe("assembleContext — §7 delivery-correctness acceptance (INV-DELIVERY)", () => {
  // These pin the numbered acceptance criteria from the proposal §11 that are expressible at the
  // pure-assembler grain (27, 28, 32). 29 (canonical-equality representation) is a dedup property
  // proven in render.spec.ts; 30/31 (hook block + real deliveryStatus) are proven in
  // intercept-hook.spec.ts against the live subcommand. The invariant they jointly enforce:
  // "A run cannot report successful delivery when any selected MUST was neither injected nor
  // represented by an injected canonical equivalent."

  it("27. under budget pressure a SHOULD is never delivered ahead of a MUST", () => {
    // An oversize explicit-path MUST cannot fit; a small explicit-path SHOULD would fit on its own.
    // Mandatory-first + fail-closed means the mandatory overflow returns BEFORE the best-effort
    // ladder runs, so the SHOULD is never delivered in place of the undeliverable MUST. The SHOULD
    // is not even reached (not in delivered, not audited best-effort): the run failed loud first.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [
          scoped({ ruleId: "s_must", text: "m".repeat(3000), strength: "MUST", globs: ["apps/a/**"] }),
          scoped({ ruleId: "s_should", text: "a tiny should", strength: "SHOULD", globs: ["apps/a/**"] }),
        ],
        explicitPaths: ["apps/a/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(true);
    expect(out.text).not.toContain("a tiny should");
    expect(out.delivered.some((d) => d.ruleId === "s_should")).toBe(false);
    expect(out.delivered.every((d) => d.tier !== "best-effort")).toBe(true);
  });

  it("28. an applicable mandatory rule is always accounted for (delivered or omitted), never silently absent", () => {
    // Every applicable MUST — matched by explicit path, turn trigger, OR working set — must appear in
    // delivered ∪ omitted. It can never vanish (the assembler's analog of "cannot receive
    // NOT_APPLICABLE": the assembler only sees applicable rules, so a mandatory one is either
    // delivered or loudly omitted). Here three mandatory MUSTs (one per signal) all overflow.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [
          scoped({ ruleId: "m_explicit", text: "e".repeat(1500), strength: "MUST", globs: ["apps/a/**"] }),
          scoped({ ruleId: "m_turn", text: "t".repeat(1500), strength: "MUST", globs: [], trigger: { promptAny: ["design doc"] } }),
          scoped({ ruleId: "m_ws", text: "w".repeat(1500), strength: "MUST", globs: ["apps/b/**"] }),
        ],
        explicitPaths: ["apps/a/x.ts"],
        workingSetPaths: ["apps/b/y.ts"],
        prompt: "draft the design doc",
        safeTotal: 1800,
      }),
    );
    const accounted = new Set([...out.delivered, ...out.omitted].map((r) => r.ruleId));
    for (const id of ["m_explicit", "m_turn", "m_ws"]) {
      expect(accounted.has(id)).toBe(true);
    }
    // And when overflow fires, each mandatory id is omitted with the loud reason — never absent.
    expect(out.overflow).toBe(true);
    for (const id of ["m_explicit", "m_turn", "m_ws"]) {
      expect(out.omitted).toContainEqual({ ruleId: id, reason: "overflow:required-scoped-did-not-fit" });
    }
  });

  it("32. a passing run (overflow false) may omit a SHOULD but NEVER a MUST", () => {
    // The run-level INJECTED ⟺ overflow-false contract. A budget that holds the mandatory MUST but
    // not a large global SHOULD: overflow stays false (INJECTED-eligible), the MUST is delivered, and
    // the ONLY omission is a SHOULD. There is no MUST in omitted on any overflow-false run.
    const out = assembleContext(
      input({
        floorRules: [floor(), { ruleId: "fs_big", versionId: "v1", text: "s".repeat(3000), strength: "SHOULD" }],
        scopedRules: [scoped({ ruleId: "s_req", text: "guard the outbox on every write", globs: ["apps/control/**"] })],
        explicitPaths: ["apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.delivered).toContainEqual({ ruleId: "s_req", tier: "scoped-required" });
    expect(out.omitted).toContainEqual({ ruleId: "fs_big", reason: "best-effort:did-not-fit" });
    // The load-bearing half of #32: no omission on a passing run carries the overflow (MUST) reason.
    expect(out.omitted.every((o) => o.reason !== "overflow:required-scoped-did-not-fit")).toBe(true);
  });
});
