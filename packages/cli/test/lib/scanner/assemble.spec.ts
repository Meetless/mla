import { Buffer } from "node:buffer";
import {
  AssembleInput,
  assembleContext,
} from "../../../src/lib/scanner/assemble";
import { FloorRuleEntry, ScopedRuleEntry } from "../../../src/lib/scanner/types";
import {
  renderFloorBlock,
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

describe("assembleContext: oversize required scoped rules are delivered whole (budget expands, no overflow)", () => {
  it("delivers BOTH required scoped rules even when their combined size overruns SAFE_TOTAL", () => {
    const big = "x".repeat(3000);
    const out = assembleContext(
      input({
        floorRules: [floor()],
        // Two required scoped rules whose combined size far exceeds SAFE_TOTAL (1800). Required
        // content is never withheld: the budget expands to max(safeTotal, requiredBytes) and both ride.
        scopedRules: [
          scoped({ ruleId: "s_small", text: "small required rule", globs: ["apps/control/**"] }),
          scoped({ ruleId: "s_big", text: big, globs: ["apps/control/**"] }),
        ],
        explicitPaths: ["apps/control/outbox.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    // Floor preserved.
    expect(out.text).toContain("never push without explicit consent");
    // BOTH required scoped rules delivered whole, in explicit-match order, ahead of any SHOULD.
    expect(out.text).toContain("small required rule");
    expect(out.text).toContain("xxx");
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s_small", tier: "scoped-required" },
      { ruleId: "s_big", tier: "scoped-required" },
    ]);
    // No required rule is ever dropped, so nothing is omitted.
    expect(out.omitted).toEqual([]);
    // The byte count equals the emitted string and EXCEEDS SAFE_TOTAL: the budget followed the
    // required set, it was not capped at 1800.
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeGreaterThan(1800);
  });

  it("delivers a single required scoped rule far larger than SAFE_TOTAL whole (no marker, no truncation)", () => {
    // A 5000-byte required scoped rule. There is no harness inline cap to truncate it, so the head
    // is base + floor + the whole rule and the assembler reports its true byte size.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ text: "y".repeat(5000) })],
        explicitPaths: ["apps/control/outbox.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("yyyy");
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s1", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeGreaterThan(5000);
  });
});

describe("assembleContext: a floor larger than SAFE_TOTAL is delivered whole (budget expands, never throws)", () => {
  it("delivers a 3000-byte global MUST floor even though it exceeds SAFE_TOTAL", () => {
    // The universal floor grew past SAFE_TOTAL. There is no harness inline cap and required content
    // is never withheld, so the assembler delivers the whole floor (budget = max(safeTotal,
    // requiredBytes)) rather than throwing or degrading. The old BaseInvariantError path is gone.
    const out = assembleContext(
      input({ floorRules: [floor({ text: "z".repeat(3000) })], safeTotal: 1800 }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("zzzz");
    expect(out.delivered).toEqual([{ ruleId: "fm1", tier: "floor-must" }]);
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeGreaterThan(1800);
  });
});

describe("assembleContext: a floor sized exactly at the budget is delivered whole (no reserved marker room)", () => {
  // The marker-reservation mechanic is retired: there is no fail-loud marker to reserve room for.
  // A floor sized exactly at the budget is delivered whole, and a best-effort (working-set-only)
  // scoped rule that is present but not required this turn does not change that.
  const floorRule = floor({ text: "keep the compressed floor within the inline budget" });
  const head = BASE + "\n" + renderFloorBlock([floorRule]); // exactly what gets emitted (no scoped)
  const headBytes = bytes(head);

  it("delivers a floor sized exactly at SAFE_TOTAL when no scoped rule exists", () => {
    const out = assembleContext(input({ floorRules: [floorRule], scopedRules: [], safeTotal: headBytes }));
    expect(out.overflow).toBe(false);
    expect(out.text).toBe(head);
    expect(out.bytes).toBe(headBytes);
    expect(out.bytes).toBeLessThanOrEqual(headBytes);
    expect(out.delivered).toEqual([{ ruleId: floorRule.ruleId, tier: "floor-must" }]);
    expect(out.omitted).toEqual([]);
  });

  it("a best-effort (working-set-only) scoped rule does not affect a floor sized at the budget", () => {
    // Same floor, same tight budget, and a scoped MUST is present but reachable ONLY via the working
    // set (no explicit path matches its glob, and the working set is empty). It is not required this
    // turn, so it is simply absent: the floor is delivered whole, the head equals base+floor, and
    // nothing is dropped. This is the behavior that removes the every-turn marker tax a configured
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

describe("assembleContext: turn-scoped rule delivery (matched turn MUST is mandatory and delivered; unmatched rules never ride)", () => {
  // A turn rule is a scoped rule carrying a TurnTrigger and NO globs (§5.1). When its trigger fires
  // it is a MANDATORY scoped MUST (joined to the same required set as explicit-path MUSTs, §7.1) and
  // is delivered whole; when the trigger does not fire it is not a candidate at all. There is no
  // fail-loud marker and no base-invariant throw: required content is never withheld.
  const turnRule = (over: Partial<ScopedRuleEntry> = {}): ScopedRuleEntry =>
    scoped({ ruleId: "s_turn", globs: [], trigger: { promptAny: ["design doc"] }, ...over });

  const floorRule = floor({ text: "keep the compressed floor within the inline budget" });
  const head = BASE + "\n" + renderFloorBlock([floorRule]);
  const headBytes = bytes(head);

  it("1. an unmatched turn rule is not a candidate: the floor is delivered whole, the rule is neither delivered nor omitted", () => {
    // The trigger needle ("design doc") is absent from a bug-fix prompt, so the rule is not even a
    // candidate. base+floor fills the budget exactly, the floor is delivered whole, and the turn rule
    // is neither delivered nor audited-omitted (it simply did not apply this turn).
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

  it("2. a matched turn MUST larger than SAFE_TOTAL is delivered whole (mandatory, budget expands), floor preserved", () => {
    // The trigger fires (the prompt contains 'design doc'), so this turn-matched MUST is mandatory
    // and joins the required set. At 3000 bytes it overruns SAFE_TOTAL, but required content is never
    // withheld: the budget expands to hold it, the floor rides with it, and it is delivered as
    // scoped-required (never dropped, never marker-replaced).
    const out = assembleContext(
      input({
        floorRules: [floorRule],
        scopedRules: [turnRule({ text: "d".repeat(3000) })],
        prompt: "draft the design doc for the approvals flow",
        explicitPaths: [],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("keep the compressed floor within the inline budget");
    expect(out.text).toContain("dddd");
    expect(out.delivered).toEqual([
      { ruleId: floorRule.ruleId, tier: "floor-must" },
      { ruleId: "s_turn", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeGreaterThan(1800);
  });

  it("3. a required explicit-path MUST larger than SAFE_TOTAL is delivered whole (budget expands), floor preserved", () => {
    // The explicit-path required path behaves identically: an oversize required scoped MUST is
    // delivered whole (budget expands), the floor rides, and it is audited as scoped-required.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_req", text: "r".repeat(3000), globs: ["apps/control/**"] })],
        explicitPaths: ["apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("rrrr");
    expect(out.text).toContain("never push without explicit consent");
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s_req", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
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

  it("4b. matched turn MUST overflows SAFE_TOTAL: the WHOLE mandatory set is delivered whole (budget expands), nothing dropped", () => {
    // The mandatory set is all-or-nothing, and now "all" always rides. A small explicit-path MUST
    // (s_req) and a huge matched turn MUST (s_turn) are both required, so the budget expands to hold
    // the whole set. Both are delivered scoped-required, the floor rides, and nothing is omitted:
    // a mandatory rule is never traded away, and the whole set is delivered rather than blocked.
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
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("never push without explicit consent");
    expect(out.text).toContain("guard the outbox on every write");
    expect(out.text).toContain("dddd");
    // Explicit-path MUST is pushed before the turn MUST (explicit signal ranks first).
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s_req", tier: "scoped-required" },
      { ruleId: "s_turn", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBe(bytes(out.text));
    expect(out.bytes).toBeGreaterThan(1800);
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

describe("assembleContext: working-set-matched MUST is MANDATORY (§7.2) and always delivered whole", () => {
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

  it("delivers a working-set-only scoped MUST whole even when it overruns SAFE_TOTAL (budget expands)", () => {
    // The same working-set MUST, now oversize. A working-set-matched MUST is mandatory, so required
    // content is never withheld: the budget expands, the rule is delivered as scoped-required, the
    // floor rides, and nothing is dropped.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_ws", text: "w".repeat(3000) })],
        explicitPaths: [],
        workingSetPaths: [...noisyWorkingSet, "apps/control/x.ts"],
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("wwww");
    expect(out.delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must" },
      { ruleId: "s_ws", tier: "scoped-required" },
    ]);
    expect(out.omitted).toEqual([]);
    expect(out.bytes).toBeGreaterThan(1800);
  });

  it("delivers an oversize EXPLICIT-path scoped MUST whole identically (signal no longer changes mandatoriness)", () => {
    // Under §7 the explicit-path vs working-set distinction no longer changes whether a MUST is
    // mandatory: both are. An oversize explicit-path MUST is delivered whole exactly like the
    // working-set one.
    const out = assembleContext(
      input({
        floorRules: [floor()],
        scopedRules: [scoped({ ruleId: "s_explicit", text: "w".repeat(3000) })],
        explicitPaths: ["apps/control/x.ts"],
        workingSetPaths: noisyWorkingSet,
        safeTotal: 1800,
      }),
    );
    expect(out.overflow).toBe(false);
    expect(out.text).toContain("wwww");
    expect(out.delivered).toContainEqual({ ruleId: "s_explicit", tier: "scoped-required" });
    expect(out.omitted).toEqual([]);
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
  it("returns bytes === byteLength(text) and never overflows, across small and oversize required sets", () => {
    // The load-bearing invariant is that the reported byte count IS the emitted string (no bytes are
    // appended after the assembler's final word) and the run never fails closed. The middle scenario
    // carries a 4000-byte required scoped MUST: it is delivered whole, so its bytes legitimately
    // EXCEED safeTotal (the budget expanded to hold the required set) while still equalling the text.
    const scenarios: AssembleInput[] = [
      input({ floorRules: [floor()], scopedRules: [scoped()], explicitPaths: ["apps/control/x.ts"] }),
      input({ floorRules: [floor()], scopedRules: [scoped({ text: "q".repeat(4000) })], explicitPaths: ["apps/control/x.ts"] }),
      input({ floorRules: [floor(), { ruleId: "fs", versionId: "v", text: "a should", strength: "SHOULD" }] }),
    ];
    for (const s of scenarios) {
      const out = assembleContext(s);
      expect(out.bytes).toBe(bytes(out.text));
      expect(out.overflow).toBe(false);
    }
    // And the oversize-required scenario really does exceed safeTotal, proving the budget followed
    // the required set rather than capping it.
    expect(assembleContext(scenarios[1]).bytes).toBeGreaterThan(scenarios[1].safeTotal);
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

describe("assembleContext: delivery-correctness acceptance (INV-DELIVERY)", () => {
  // These pin the numbered acceptance criteria from the proposal §11 that are expressible at the
  // pure-assembler grain (27, 28, 32). 29 (canonical-equality representation) is a dedup property
  // proven in render.spec.ts; 30/31 (hook block + real deliveryStatus) are proven in
  // intercept-hook.spec.ts against the live subcommand. The invariant they jointly enforce:
  // "A run cannot report successful delivery when any selected MUST was neither injected nor
  // represented by an injected canonical equivalent." Under the always-deliver contract the strongest
  // form of that invariant holds: every applicable MUST is delivered whole, so it is never omitted.

  it("27. under budget pressure a SHOULD is never delivered ahead of a MUST", () => {
    // An oversize explicit-path MUST is delivered whole (the budget expands to hold the required
    // set); a small explicit-path SHOULD would fit at SAFE_TOTAL, but the required set now consumes
    // the whole budget, leaving zero slack. So the MUST rides and the SHOULD is dropped best-effort:
    // the SHOULD is never delivered in place of, or ahead of, the mandatory MUST.
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
    expect(out.overflow).toBe(false);
    // The mandatory MUST is delivered whole.
    expect(out.text).toContain("mmmm");
    expect(out.delivered).toContainEqual({ ruleId: "s_must", tier: "scoped-required" });
    // The SHOULD, which has no slack above the required set, is dropped best-effort, never delivered
    // ahead of the MUST.
    expect(out.text).not.toContain("a tiny should");
    expect(out.delivered.some((d) => d.ruleId === "s_should")).toBe(false);
    expect(out.omitted).toContainEqual({ ruleId: "s_should", reason: "best-effort:did-not-fit" });
    // No best-effort rule was delivered while a mandatory rule was in play.
    expect(out.delivered.every((d) => d.tier !== "best-effort")).toBe(true);
  });

  it("28. every applicable mandatory rule is accounted for and delivered whole, never silently absent", () => {
    // Every applicable MUST (matched by explicit path, turn trigger, OR working set) must appear in
    // delivered ∪ omitted. Here three mandatory MUSTs (one per signal) total ~4500 bytes and overrun
    // SAFE_TOTAL, but required content is never withheld: the budget expands and all three are
    // delivered as scoped-required. None is dropped, and none is silently absent.
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
    // The budget expands to hold the whole mandatory set: overflow false, all three delivered
    // scoped-required, nothing omitted.
    expect(out.overflow).toBe(false);
    for (const id of ["m_explicit", "m_turn", "m_ws"]) {
      expect(out.delivered).toContainEqual({ ruleId: id, tier: "scoped-required" });
    }
    expect(out.omitted).toEqual([]);
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
