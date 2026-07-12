import {
  AssembleContextDeps,
  runAssembleContext,
} from "../../../src/commands/assemble-context";
import { ScanResult, SCAN_SCHEMA_VERSION } from "../../../src/lib/scanner/types";
import { PersistedAssembleAudit } from "../../../src/lib/scanner/cache";
import {
  INCOMPLETE_DELIVERY_MARKER_TEXT,
  SCOPED_UNAVAILABLE_MARKER_TEXT,
  OVERFLOW_MARKER_TEXT,
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
}

async function run(
  stdin: Record<string, unknown> | string,
  cacheValue: ScanResult | null,
  argv: string[] = [],
): Promise<Harness> {
  const audits: PersistedAssembleAudit[] = [];
  let stdout = "";
  const deps: AssembleContextDeps = {
    readStdin: () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    readCache: () => cacheValue,
    writeAudit: (_home, _ws, audit) => {
      audits.push(audit);
    },
    home: "/tmp/unused",
    now: () => "2026-07-05T12:00:00.000Z",
    log: (out) => {
      stdout += out;
    },
  };
  const code = await runAssembleContext(argv, deps);
  return { code, stdout, audits };
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

  it("FAILS CLOSED (exit 3) and emits the marker when a required scoped MUST does not fit (§7.5)", async () => {
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts" }),
      cache({
        floorRules: [{ ruleId: "fm1", versionId: "v1", text: "floor", strength: "MUST" }],
        scopedRules: [
          { ruleId: "s_big", versionId: "v1", text: "x".repeat(4000), strength: "MUST", globs: ["apps/control/**"] },
        ],
      }),
    );
    // A required scoped MUST that cannot be delivered is DELIVERY_FAILED (proposal L230/235): the
    // subcommand exits 3 so the hook turns it into a block (exit 2), never a silent exit-0 drop.
    expect(h.code).toBe(3);
    // The base-preserving head (base + floor + marker) is still printed to stdout; the big rule's
    // body is dropped, and the instructive overflow marker rides in its place.
    expect(h.stdout).toContain(OVERFLOW_MARKER_TEXT);
    expect(h.stdout).not.toContain("xxxx");
    expect(h.audits[0].state).toBe("overflow");
    expect(h.audits[0].overflow).toBe(true);
    // The omitted MUST is named with the exact RuleVersion that could not be delivered (§7.4).
    expect(h.audits[0].omitted).toEqual([
      { ruleId: "s_big", reason: "overflow:required-scoped-did-not-fit", versionId: "v1" },
    ]);
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

describe("assemble-context — failed-compile-last-good (base invariant broken)", () => {
  it("prints NOTHING (bash fallback owns the floor) and audits state=base-invariant", async () => {
    // A floor so large that base + floor + marker cannot fit SAFE_TOTAL: the assembler throws
    // BaseInvariantError, the subcommand returns null and prints nothing, so the hook's bash
    // fallback delivers the last-known-good compiled floor XML. The audit still records it.
    const h = await run(
      stdin(),
      cache({
        floorRules: [{ ruleId: "fm_big", versionId: "v1", text: "z".repeat(3000), strength: "MUST" }],
      }),
    );
    expect(h.code).toBe(0);
    expect(h.stdout).toBe("");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].state).toBe("base-invariant");
    expect(h.audits[0].bytes).toBe(0);
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
