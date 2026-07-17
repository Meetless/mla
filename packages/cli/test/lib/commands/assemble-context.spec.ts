import {
  AssembleContextDeps,
  runAssembleContext,
} from "../../../src/commands/assemble-context";
import { ScanResult, SCAN_SCHEMA_VERSION } from "../../../src/lib/scanner/types";
import { PersistedAssembleAudit } from "../../../src/lib/scanner/cache";
import {
  INCOMPLETE_DELIVERY_MARKER_TEXT,
  SCOPED_UNAVAILABLE_MARKER_TEXT,
} from "../../../src/lib/scanner/render";

// Degradation-table tests for the `mla _internal assemble-context` subcommand (§6 cache-state
// table + §8 old-schema-after-activation / failed-compile-last-good). The subcommand is a thin
// I/O shell around the pure assembler; these drive it end-to-end through injected deps (stdin,
// cache reader, audit writer, clock, stdout) so we assert the ACTUAL stdout head + persisted audit
// state per cache condition, with zero filesystem/clock reliance.

const WS = "ws_test";
const BASE = "workspace_hint: ws_test\nUse the governed evidence tools before answering.";

/** A current-schema (v2) scan cache with the assembler-relevant fields; the rest is stubbed. */
function cache(over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    workspaceId: WS,
    commitSha: "abc",
    generatedAt: "2026-07-05T00:00:00.000Z",
    inventory: {} as ScanResult["inventory"],
    directives: [],
    staleSignals: [],
    confirmedRulesXml: "",
    floorRulesXml: "",
    floorRules: [],
    scopedRules: [],
    staleContextXml: "",
    advisoryDirectives: [],
    ...over,
  } as ScanResult;
}

interface Harness {
  code: number;
  stdout: string;
  audits: PersistedAssembleAudit[];
  meters: { path: string; json: string }[];
}

async function run(
  stdin: Record<string, unknown> | string,
  cacheValue: ScanResult | null,
  argv: string[] = [],
): Promise<Harness> {
  const audits: PersistedAssembleAudit[] = [];
  const meters: { path: string; json: string }[] = [];
  let stdout = "";
  const deps: AssembleContextDeps = {
    readStdin: () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    readCache: () => cacheValue,
    writeAudit: (_home, _ws, audit) => {
      audits.push(audit);
    },
    writeMeter: (path, json) => {
      meters.push({ path, json });
    },
    home: "/tmp/unused",
    now: () => "2026-07-05T12:00:00.000Z",
    log: (out) => {
      stdout += out;
    },
  };
  const code = await runAssembleContext(argv, deps);
  return { code, stdout, audits, meters };
}

const stdin = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  base: BASE,
  prompt: "",
  workingSet: [],
  workspaceId: WS,
  safeTotal: 1800,
  ...over,
});

describe("assemble-context — Row 1/2: current schema, normal assembly", () => {
  it("assembles the floor + explicit-matched scoped head and audits state=normal", async () => {
    const h = await run(
      stdin({ prompt: "please edit apps/control/outbox.ts" }),
      cache({
        floorRules: [{ ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" }],
        scopedRules: [
          { ruleId: "s1", versionId: "v1", text: "guard the outbox", strength: "MUST", globs: ["apps/control/**"] },
        ],
      }),
    );
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("never push without consent");
    expect(h.stdout).toContain("guard the outbox");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].state).toBe("normal");
    expect(h.audits[0].overflow).toBe(false);
    // Delivered entries carry the RuleVersion they delivered (§7.4 version-scoped delivery
    // accounting): the audit records which version rode, so enforcement evidence and the
    // represent-edge can be attributed to an exact version rather than a bare ruleId.
    expect(h.audits[0].delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must", versionId: "v1" },
      { ruleId: "s1", tier: "scoped-required", versionId: "v1" },
    ]);
    // stdout is EXACTLY the assembled head, nothing appended after the assembler's byte assertion:
    // the audit records the assembler's own byte count, and stdout must equal it byte-for-byte.
    expect(Buffer.byteLength(h.stdout, "utf8")).toBe(h.audits[0].bytes);
  });

  it("delivers a required scoped MUST WHOLE (exit 0, budget expands) even when it overruns SAFE_TOTAL", async () => {
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts" }),
      cache({
        floorRules: [{ ruleId: "fm1", versionId: "v1", text: "floor", strength: "MUST" }],
        scopedRules: [
          { ruleId: "s_big", versionId: "v1", text: "x".repeat(4000), strength: "MUST", globs: ["apps/control/**"] },
        ],
      }),
    );
    // A required scoped MUST is never withheld for budget: the assembler's budget expands to hold it
    // (there is no harness inline cap to truncate a 4000-byte rule). So the turn is a normal exit-0
    // delivery, not a fail-closed block, and the rule body rides whole.
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("xxxx");
    expect(h.audits[0].state).toBe("normal");
    expect(h.audits[0].overflow).toBe(false);
    // Both the floor MUST and the oversize scoped MUST are delivered, each stamped with the exact
    // RuleVersion that rode (§7.4). Nothing is omitted.
    expect(h.audits[0].delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must", versionId: "v1" },
      { ruleId: "s_big", tier: "scoped-required", versionId: "v1" },
    ]);
    expect(h.audits[0].omitted).toEqual([]);
  });
});

describe("assemble-context — Row 3/4: old schema after activation (visible, not silent floor-only)", () => {
  it("emits floor XML + the scoped-unavailable marker and audits state=old-schema", async () => {
    const h = await run(
      stdin(),
      cache({ schemaVersion: 1, floorRulesXml: '<meetless-context kind="floor-rules" trust="must-follow">\n- floor\n</meetless-context>' }),
    );
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("floor");
    // The degradation is VISIBLE: the model is told scoped delivery is unavailable, not left to
    // assume a missing scoped rule means the rule does not exist.
    expect(h.stdout).toContain(SCOPED_UNAVAILABLE_MARKER_TEXT);
    expect(h.stdout).not.toBe("");
    expect(h.audits[0].state).toBe("old-schema");
  });

  it("places the marker BEFORE the floor so it survives a last-complete-line trim of an over-budget floor", async () => {
    // A floor large enough to overrun the harness inline window on its own: if the marker trailed
    // it, the trim would drop the marker and silently degrade back to a floor-only success. The
    // marker must lead so base + marker (always within budget) is what a trim preserves.
    const bigFloor =
      '<meetless-context kind="floor-rules" trust="must-follow">\n' +
      Array.from({ length: 80 }, (_, i) => `- floor rule ${i} that carries real prose to fill the budget`).join("\n") +
      "\n</meetless-context>";
    const h = await run(stdin(), cache({ schemaVersion: 1, floorRulesXml: bigFloor }));
    expect(h.code).toBe(0);
    const markerAt = h.stdout.indexOf(SCOPED_UNAVAILABLE_MARKER_TEXT);
    const floorAt = h.stdout.indexOf("floor rule 0");
    expect(markerAt).toBeGreaterThanOrEqual(0);
    // The marker precedes the floor payload.
    expect(floorAt).toBeGreaterThan(markerAt);
    // And the marker ends within the byte budget, so a trim at safeTotal keeps the whole marker.
    const throughMarker = h.stdout.slice(0, markerAt + SCOPED_UNAVAILABLE_MARKER_TEXT.length);
    expect(Buffer.byteLength(throughMarker, "utf8")).toBeLessThanOrEqual(1800);
    // Sanity: this floor really was over-budget, so the ordering mattered (the test is not vacuous).
    expect(Buffer.byteLength(bigFloor, "utf8")).toBeGreaterThan(1800);
  });
});

describe("assemble-context — Row 5: missing/unreadable cache (incomplete delivery)", () => {
  it("emits base + incomplete-delivery marker and audits state=incomplete", async () => {
    const h = await run(stdin(), null);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(BASE);
    expect(h.stdout).toContain(INCOMPLETE_DELIVERY_MARKER_TEXT);
    expect(h.audits[0].state).toBe("incomplete");
  });
});

describe("assemble-context: a floor larger than SAFE_TOTAL is delivered whole (base invariant retired)", () => {
  it("delivers an oversize floor MUST (exit 0, state=normal) instead of yielding to the bash fallback", async () => {
    // A floor larger than SAFE_TOTAL once tripped the base invariant: the assembler threw, the
    // subcommand printed nothing, and the hook's bash fallback owned the floor. That path is retired.
    // With no harness inline cap to truncate it, the assembler's budget expands and delivers the
    // oversize floor whole, so this is now a normal exit-0 delivery with real bytes on stdout.
    const h = await run(
      stdin(),
      cache({
        floorRules: [{ ruleId: "fm_big", versionId: "v1", text: "z".repeat(3000), strength: "MUST" }],
      }),
    );
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("zzzz");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].state).toBe("normal");
    expect(h.audits[0].overflow).toBe(false);
    expect(h.audits[0].bytes).toBe(Buffer.byteLength(h.stdout, "utf8"));
    expect(h.audits[0].delivered).toEqual([
      { ruleId: "fm_big", tier: "floor-must", versionId: "v1" },
    ]);
  });
});

describe("assemble-context — fail-soft parsing (never crashes the hook)", () => {
  it("returns exit 2 on an unknown flag and prints nothing", async () => {
    const h = await run(stdin(), cache(), ["--nope"]);
    expect(h.code).toBe(2);
    expect(h.stdout).toBe("");
    expect(h.audits).toEqual([]);
  });

  it("returns exit 0 and prints nothing when base or workspaceId is missing (fail-soft)", async () => {
    const noBase = await run(stdin({ base: "" }), cache());
    expect(noBase.code).toBe(0);
    expect(noBase.stdout).toBe("");
    const noWs = await run(stdin({ workspaceId: "" }), cache());
    expect(noWs.code).toBe(0);
    expect(noWs.stdout).toBe("");
  });

  it("returns exit 0 and prints nothing on malformed stdin JSON", async () => {
    const h = await run("{ not json", cache());
    expect(h.code).toBe(0);
    expect(h.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// The rule-injection cost meter (audit 6.G / 7.10). The assembler is the ONLY place that can
// price a turn (it alone holds the prompt, the cache, and the rendered blocks), and it sits on a
// hot path that may never make a network call. So it writes pure numbers to a caller-named temp
// file and a detached process ships them. These tests pin that file: every branch that produces a
// head produces a meter, the numbers add up, and NOTHING but numbers and booleans ever leaves.
// ---------------------------------------------------------------------------------------------

const METER_PATH = "/tmp/meter.json";

function meterOf(h: Harness): Record<string, unknown> {
  expect(h.meters).toHaveLength(1);
  expect(h.meters[0].path).toBe(METER_PATH);
  return JSON.parse(h.meters[0].json) as Record<string, unknown>;
}

describe("assemble-context — rule-injection meter", () => {
  it("prices a normal turn: always-on vs scoped bytes, the avoided counterfactual, head total", async () => {
    const h = await run(
      stdin({ prompt: "please edit apps/control/outbox.ts", meterFile: METER_PATH }),
      cache({
        floorRules: [{ ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" }],
        scopedRules: [
          { ruleId: "s1", versionId: "v1", text: "guard the outbox", strength: "MUST", globs: ["apps/control/**"] },
          // Configured but NOT matched by this prompt: this is the byte cost scoping AVOIDED.
          { ruleId: "s2", versionId: "v1", text: "y".repeat(300), strength: "SHOULD", globs: ["intel/**"] },
        ],
      }),
    );
    expect(h.code).toBe(0);
    const m = meterOf(h);
    expect(m.degraded).toBe(false);
    expect(m.overflow).toBe(false);
    expect(m.always_on_rules).toBe(1);
    expect(m.scoped_rules).toBe(1);
    // Both scoped rules were CONFIGURED; only one was charged. That delta is the design bet.
    expect(m.scoped_configured).toBe(2);
    expect(m.omitted_rules).toBe(0);
    expect(m.base_bytes).toBe(Buffer.byteLength(BASE, "utf8"));
    expect(m.always_on_bytes as number).toBeGreaterThan(0);
    expect(m.scoped_bytes as number).toBeGreaterThan(0);
    // The unmatched rule's body (300 bytes) plus its share of the wrapper was never billed.
    expect(m.avoided_bytes as number).toBeGreaterThanOrEqual(300);
    // The head the model actually received is exactly what was metered.
    expect(m.head_bytes).toBe(Buffer.byteLength(h.stdout, "utf8"));
    expect(m.head_bytes).toBe(h.audits[0].bytes);
    expect(m.safe_total).toBe(1800);
    // INV-POSTHOG-PII-1: the meter is numbers and booleans only. No prompt, no path, no rule text.
    for (const v of Object.values(m)) {
      expect(["number", "boolean"]).toContain(typeof v);
    }
  });

  it("meters an oversize required-scoped turn: the scoped MUST is billed whole, nothing avoided", async () => {
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", meterFile: METER_PATH }),
      cache({
        floorRules: [{ ruleId: "fm1", versionId: "v1", text: "floor", strength: "MUST" }],
        scopedRules: [
          { ruleId: "s_big", versionId: "v1", text: "x".repeat(4000), strength: "MUST", globs: ["apps/control/**"] },
        ],
      }),
    );
    expect(h.code).toBe(0);
    const m = meterOf(h);
    // The oversize scoped MUST matched this prompt and rides whole (the budget expands), so it is
    // PRICED, not dropped: the floor and the scoped block are both billed, nothing is omitted, and
    // since the only configured scoped rule matched, nothing is left to count as avoided.
    expect(m.overflow).toBe(false);
    expect(m.degraded).toBe(false);
    expect(m.scoped_rules).toBe(1);
    expect(m.scoped_configured).toBe(1);
    expect(m.scoped_bytes as number).toBeGreaterThanOrEqual(4000);
    expect(m.omitted_rules).toBe(0);
    expect(m.always_on_bytes as number).toBeGreaterThan(0);
    expect(m.avoided_bytes).toBe(0);
    expect(m.head_bytes).toBe(Buffer.byteLength(h.stdout, "utf8"));
  });

  it("meters a missing cache as degraded with zero rules but honest bytes", async () => {
    const h = await run(stdin({ meterFile: METER_PATH }), null);
    expect(h.code).toBe(0);
    const m = meterOf(h);
    expect(m.degraded).toBe(true);
    expect(m.always_on_bytes).toBe(0);
    expect(m.always_on_rules).toBe(0);
    // The head still cost real bytes (base + the incomplete-delivery marker), so it is metered.
    expect(m.head_bytes).toBe(Buffer.byteLength(h.stdout, "utf8"));
  });

  it("meters an old-schema cache as degraded, charging the pre-rendered floor XML it delivered", async () => {
    const floorXml = '<meetless-context kind="floor-rules" trust="must-follow">\n- floor\n</meetless-context>';
    const h = await run(stdin({ meterFile: METER_PATH }), cache({ schemaVersion: 1, floorRulesXml: floorXml }));
    expect(h.code).toBe(0);
    const m = meterOf(h);
    expect(m.degraded).toBe(true);
    // The old cache cannot say how many rules are inside the XML, but the BYTES it billed are known.
    expect(m.always_on_bytes).toBe(Buffer.byteLength(floorXml, "utf8"));
    expect(m.always_on_rules).toBe(0);
  });

  it("meters a formerly base-invariant turn: the oversize floor rides whole and the matched scoped rule is billed", async () => {
    // A floor larger than SAFE_TOTAL once tripped the base invariant: the assembler threw, we printed
    // nothing, and the hook's bash fallback owned the head. That path is retired. The assembler now
    // delivers the oversize floor whole AND the scoped MUST that matched this prompt, so this is a
    // normal, fully-priced turn: exactly the worst-tax population 6.G exists to price, and none of it
    // is lost to a null meter (the original bug) anymore.
    const h = await run(
      stdin({ prompt: "please edit apps/control/outbox.ts", meterFile: METER_PATH }),
      cache({
        floorRules: [
          { ruleId: "fm_big", versionId: "v1", text: "z".repeat(3000), strength: "MUST" },
          { ruleId: "fm2", versionId: "v1", text: "second floor rule", strength: "MUST" },
        ],
        scopedRules: [
          { ruleId: "s1", versionId: "v1", text: "guard the outbox", strength: "MUST", globs: ["apps/control/**"] },
        ],
      }),
    );
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("zzzz");
    expect(h.stdout).toContain("guard the outbox");
    expect(h.audits[0].state).toBe("normal");

    const m = meterOf(h);
    expect(m.base_invariant).toBe(false);
    // NOT degraded: every count here is known, so the cost tiles must keep this row rather than
    // filter it out with the cache-less ones.
    expect(m.degraded).toBe(false);
    expect(m.overflow).toBe(false);
    // Both floor MUSTs ride as ambient (the always-on tax); the oversize floor makes that block
    // exceed 3000 bytes on its own.
    expect(m.always_on_rules).toBe(2);
    expect(m.always_on_bytes as number).toBeGreaterThan(3000);
    // The headline inverts the old bug: a scoped rule MATCHED this prompt and DID ride, because
    // assembly happened. Scoping bought delivery, so with the one configured rule matched there is
    // nothing left to count as avoided.
    expect(m.scoped_rules).toBe(1);
    expect(m.scoped_configured).toBe(1);
    expect(m.avoided_bytes).toBe(0);
    expect(m.head_bytes).toBe(Buffer.byteLength(h.stdout, "utf8"));
    expect(m.head_bytes).toBe(h.audits[0].bytes);
    for (const v of Object.values(m)) {
      expect(["number", "boolean"]).toContain(typeof v);
    }
  });

  it("writes NO meter when the caller did not ask for one", async () => {
    const h = await run(stdin({ prompt: "hello" }), cache({ floorRules: [{ ruleId: "fm1", versionId: "v1", text: "floor", strength: "MUST" }] }));
    expect(h.code).toBe(0);
    expect(h.meters).toHaveLength(0);
  });

  it("never lets a meter write failure disturb the turn (telemetry is not load-bearing)", async () => {
    const audits: PersistedAssembleAudit[] = [];
    let stdout = "";
    const code = await runAssembleContext([], {
      readStdin: () => JSON.stringify(stdin({ prompt: "hi", meterFile: METER_PATH })),
      readCache: () =>
        cache({ floorRules: [{ ruleId: "fm1", versionId: "v1", text: "floor rule", strength: "MUST" }] }),
      writeAudit: (_h, _w, a) => {
        audits.push(a);
      },
      writeMeter: () => {
        throw new Error("disk full");
      },
      home: "/tmp/unused",
      now: () => "2026-07-05T12:00:00.000Z",
      log: (out) => {
        stdout += out;
      },
    });
    // The head still shipped and the exit code is still clean: the model gets its rules even when
    // the meter cannot be written.
    expect(code).toBe(0);
    expect(stdout).toContain("floor rule");
    expect(audits[0].state).toBe("normal");
  });
});
