import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssembleContextDeps,
  runAssembleContext,
} from "../../../src/commands/assemble-context";
import {
  ReconciliationFinding,
  ScanResult,
  SCAN_SCHEMA_VERSION,
} from "../../../src/lib/scanner/types";
import { PersistedAssembleAudit, writeScanCache } from "../../../src/lib/scanner/cache";
import { ArtifactByteReader } from "../../../src/lib/scanner/reconciliation-rehash";
import {
  CONTENT_NORMALIZATION_V1,
  normalizedContentHash,
} from "../../../src/lib/scanner/content-normalization";
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
    // 12h before the harness clock: inside the freshness window, so a test that cares about the
    // rehash gate is not silently answering a freshness question instead. The stale/absent-stamp
    // cases override this explicitly, and are asserted in their own describe below.
    reconciliationFetchedAt: "2026-07-05T00:00:00.000Z",
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
  // Injected only by the reconciliation-rehash tests; every other caller leaves it undefined and
  // the subcommand falls back to its repoRoot-contained filesystem reader (never invoked here,
  // because no cache below carries reconciliation findings for it to rehash).
  readArtifactBytes?: ArtifactByteReader,
  // The UNGUARDED workspace-global cache. Only Row 5 reads it, to recover the floor when no cache
  // is readable for this root. Defaults to null = no global cache on disk either.
  globalCacheValue: ScanResult | null = null,
  // The audit THIS turn is about to overwrite, i.e. the previous turn's delivery receipt. The
  // floor delta is a diff against it, so a test that asserts on the delta has to supply it.
  //
  // Injected, and that is the whole point: without it the subcommand falls back to the real
  // `readAssembleAudit`, which reads `home` ("/tmp/unused") and returns null. A null prior makes
  // `floorDelta` return an empty delta on EVERY turn, so an un-injected delta assertion is
  // vacuous -- it passes for the same reason whether the code is right or wrong. The first
  // version of the G1 test below was written without this and could not have passed at any
  // point, in either direction.
  priorAudit: PersistedAssembleAudit | null = null,
): Promise<Harness> {
  const audits: PersistedAssembleAudit[] = [];
  const meters: { path: string; json: string }[] = [];
  let stdout = "";
  const deps: AssembleContextDeps = {
    readStdin: () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    readCache: () => cacheValue,
    readGlobalCache: () => globalCacheValue,
    readAudit: () => priorAudit,
    writeAudit: (_home, _ws, audit) => {
      audits.push(audit);
    },
    writeMeter: (path, json) => {
      meters.push({ path, json });
    },
    readArtifactBytes,
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
    // M6: floor entries also carry their own `text`. Next turn's assembler diffs its
    // floor against this array, and a rule that LEFT the floor is gone from the new scan
    // cache, so its statement can only survive here. Floor tier only; scoped is not diffed.
    expect(h.audits[0].delivered).toEqual([
      { ruleId: "fm1", tier: "floor-must", versionId: "v1", text: "never push without consent", floor: true },
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
      { ruleId: "fm1", tier: "floor-must", versionId: "v1", text: "floor", floor: true },
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

  it("still delivers the workspace-global floor when this root has no readable cache", async () => {
    // The regression this pins: a root mismatch (several `.meetless.json` markers, one workspace
    // id) makes the guarded per-root read return null, and this branch used to emit base + marker
    // ONLY. The floor block is bundle-sourced and workspace-global, so it is correct from any
    // root's scan, and dropping it cost every floor MUST for 8h11m on 2026-08-02. The bash hook
    // cannot cover this: the head below is non-empty, so the hook's floor fallback never runs.
    const floorXml =
      '<meetless-context kind="floor-rules" trust="must-follow">\n- never push without consent\n</meetless-context>';
    const h = await run(stdin(), null, [], undefined, cache({ floorRulesXml: floorXml }));
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(BASE);
    expect(h.stdout).toContain(INCOMPLETE_DELIVERY_MARKER_TEXT);
    expect(h.stdout).toContain("never push without consent");
    // Still a VISIBLE degradation, not a silent floor-only success: the scoped rules for this root
    // genuinely were not delivered, and the state must keep saying so.
    expect(h.audits[0].state).toBe("incomplete");
    // The marker leads, for the same reason as Rows 3/4: the instruction to distrust the missing
    // scoped rules outranks the floor bullets it precedes.
    expect(h.stdout.indexOf(INCOMPLETE_DELIVERY_MARKER_TEXT)).toBeLessThan(
      h.stdout.indexOf("never push without consent"),
    );
  });

  it("meters the recovered floor as real always-on bytes", async () => {
    const floorXml =
      '<meetless-context kind="floor-rules" trust="must-follow">\n- never push without consent\n</meetless-context>';
    const h = await run(
      stdin({ meterFile: "/tmp/meter-row5.json" }),
      null,
      [],
      undefined,
      cache({ floorRulesXml: floorXml }),
    );
    const meter = JSON.parse(h.meters[0].json);
    // Bytes are true even on a degraded branch (a turn that delivered a floor is not a free turn),
    // while the rule COUNT stays 0 because a pre-rendered block cannot say how many rules are in it.
    expect(meter.always_on_bytes).toBe(Buffer.byteLength(floorXml, "utf8"));
    expect(meter.always_on_rules).toBe(0);
    expect(meter.degraded).toBe(true);
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
      { ruleId: "fm_big", tier: "floor-must", versionId: "v1", text: "z".repeat(3000), floor: true },
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

// ---------------------------------------------------------------------------------------------
// ADR Phase 2A test 9, part (b): the prompt-time rehash gate end-to-end through the subcommand
// (§3.3 item 9, notes/20260717-adr-decision-record-projection-and-reconciliation.md). The pure
// partition is pinned in test/lib/scanner/reconciliation-rehash.spec.ts; here we drive
// runAssembleContext with a cache carrying reconciliation findings + an injected byte reader and
// assert the OUT-OF-BAND AUDIT partition, which is the sole Phase 2A consumer of the rehash. The
// gate is filter-only in Phase 2A (rendering kept findings into the head is the blocked Phase 3),
// so the head must be byte-identical whether findings are present or absent.
// ---------------------------------------------------------------------------------------------

describe("assemble-context — prompt-time reconciliation rehash (ADR Phase 2A test 9)", () => {
  const KEPT_PATH = "CLAUDE.md";
  const DRIFT_PATH = "apps/control/CLAUDE.md";
  const GONE_PATH = ".claude/rules/removed.md";

  // The KEPT file still hashes to what the finding recorded.
  const KEPT_BYTES = "# CLAUDE.md\n\nAlways prefer 127.0.0.1 over localhost.\n";
  // The DRIFT file's CURRENT bytes differ from the bytes the finding was evaluated against: the
  // operator edited it after the detector read it (the edit-between-scan case).
  const DRIFT_NOW = "# CLAUDE.md\n\nEdited after the scan read it.\n";
  const DRIFT_OLD = "# CLAUDE.md\n\nThe revision the finding was evaluated against.\n";

  const FLOOR = [
    { ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" as const },
  ];

  const findings: ReconciliationFinding[] = [
    {
      path: KEPT_PATH,
      evaluatedDigest: normalizedContentHash(KEPT_BYTES, CONTENT_NORMALIZATION_V1),
      reason: "a scoped decision superseded this instruction",
    },
    {
      path: DRIFT_PATH,
      evaluatedDigest: normalizedContentHash(DRIFT_OLD, CONTENT_NORMALIZATION_V1),
      reason: "a scoped decision superseded this instruction",
    },
    {
      path: GONE_PATH,
      evaluatedDigest: normalizedContentHash("whatever\n", CONTENT_NORMALIZATION_V1),
      reason: "a scoped decision superseded this instruction",
    },
  ];

  // Serves each path's CURRENT bytes; an unknown path (a deleted file) reads as null (unreadable),
  // exactly as the real filesystem reader behaves.
  const reader: ArtifactByteReader = (p) =>
    p === KEPT_PATH ? KEPT_BYTES : p === DRIFT_PATH ? DRIFT_NOW : null;

  it("audits KEPT vs NEEDS_REEVALUATION and drops nothing into the head (edit-between-scan)", async () => {
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts" }),
      cache({ floorRules: FLOOR, reconciliationFindings: findings }),
      [],
      reader,
    );

    expect(h.code).toBe(0);
    expect(h.audits[0].state).toBe("normal");
    // The rehash partitioned the three findings: the matched digest is KEPT (eligible to inject,
    // pending the blocked Phase-3 renderer); the drifted file and the deleted file are held back as
    // NEEDS_REEVALUATION, in input order, each stamped with WHY it was held.
    expect(h.audits[0].reconciliation).toEqual({
      kept: [{ path: KEPT_PATH, reason: "digest_match" }],
      needsReevaluation: [
        { path: DRIFT_PATH, reason: "digest_drift" },
        { path: GONE_PATH, reason: "unreadable" },
      ],
    });

    // The gate is a FILTER in Phase 2A: a KEPT finding has no head effect yet (rendering is Phase 3,
    // blocked), so the head is byte-identical to the same turn with no findings at all. Prove it by
    // replaying the identical cache without reconciliation findings; that run also proves the audit
    // key is OMITTED when there is nothing to partition (a clean no-op).
    const plain = await run(
      stdin({ prompt: "edit apps/control/outbox.ts" }),
      cache({ floorRules: FLOOR }),
      [],
    );
    expect(plain.stdout).toBe(h.stdout);
    expect(plain.audits[0].reconciliation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// ADR §8 test 18: the §3.5 reconciliation block leaves the head ALONE.
//
// The block is injected by the hook's TAIL region, not by this subcommand's stdout, precisely so
// it can never compete with a floor or scoped MUST for the head's byte budget. That separation is
// only real if it is asserted: these drive the subcommand with findings present and prove (a) the
// block travels out-of-band through `reconcileFile`, (b) the head is BYTE-IDENTICAL to the same
// turn with no findings at all, (c) the out-of-band channel survives both degraded branches, and
// (d) the block is bound to the rehash gate's verdict rather than to the raw cache.
// ---------------------------------------------------------------------------------------------

describe("assemble-context — §3.5 reconciliation block is out-of-band (ADR §8 test 18)", () => {
  const RECONCILE_FILE = "/tmp/mla-reconcile-test.xml";
  const KEPT_PATH = "CLAUDE.md";
  const DRIFT_PATH = "apps/control/CLAUDE.md";
  const KEPT_BYTES = "# CLAUDE.md\n\nAlways prefer 127.0.0.1 over localhost.\n";
  const DRIFT_NOW = "# CLAUDE.md\n\nEdited after the scan read it.\n";
  const DRIFT_OLD = "# CLAUDE.md\n\nThe revision the finding was evaluated against.\n";

  const FLOOR = [
    { ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" as const },
  ];
  const SCOPED = [
    {
      ruleId: "sc1",
      versionId: "sv1",
      text: "control DTO fields carry @ApiProperty",
      strength: "MUST" as const,
      globs: ["apps/control/**"],
    },
  ];

  const kept: ReconciliationFinding = {
    path: KEPT_PATH,
    evaluatedDigest: normalizedContentHash(KEPT_BYTES, CONTENT_NORMALIZATION_V1),
    reason: "a scoped decision superseded this instruction",
    acceptedStatement: "Localhost is banned in examples; use 127.0.0.1.",
    sourceCaseId: "case-kept",
    currentSummary: "the file still tells the reader to use localhost",
    detectorExplanation: "the instruction contradicts an accepted decision",
    detectorVersion: "detector-v1",
  };
  const drifted: ReconciliationFinding = {
    path: DRIFT_PATH,
    evaluatedDigest: normalizedContentHash(DRIFT_OLD, CONTENT_NORMALIZATION_V1),
    reason: "a scoped decision superseded this instruction",
    acceptedStatement: "Every control DTO field carries @ApiProperty.",
    sourceCaseId: "case-drifted",
    currentSummary: "the file says @ApiProperty is optional",
    detectorExplanation: "the instruction contradicts an accepted decision",
    detectorVersion: "detector-v1",
  };

  const reader: ArtifactByteReader = (p) =>
    p === KEPT_PATH ? KEPT_BYTES : p === DRIFT_PATH ? DRIFT_NOW : null;

  const block = (h: Harness): string | undefined =>
    h.meters.find((m) => m.path === RECONCILE_FILE)?.json;

  it("writes the block to reconcileFile and leaves stdout byte-identical to a no-findings turn", async () => {
    const withFindings = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({ floorRules: FLOOR, scopedRules: SCOPED, reconciliationFindings: [kept] }),
      [],
      reader,
    );

    expect(withFindings.code).toBe(0);
    // (a) The block exists, and it exists ONLY on the side channel. A single stray append into the
    // head would silently start charging reconciliation noise against the rules budget.
    const xml = block(withFindings);
    expect(xml).toContain(`kind="decision-reconciliation"`);
    expect(xml).toContain("Localhost is banned in examples");
    expect(withFindings.stdout).not.toContain("decision-reconciliation");
    expect(withFindings.stdout).not.toContain("Localhost is banned in examples");

    // (b) The byte-identity control. Same cache, same prompt, findings removed: if the head differs
    // by even one byte then the block is coupled to delivery and the separation above is a fiction.
    const noFindings = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({ floorRules: FLOOR, scopedRules: SCOPED }),
      [],
      reader,
    );
    expect(noFindings.stdout).toBe(withFindings.stdout);
    // Nothing to say means nothing written: "file absent or empty" is the hook's whole read, so an
    // empty pass must not leave a zero-length file that a later turn could misread as a block.
    expect(block(noFindings)).toBeUndefined();

    // The floor and the scoped MUST both still rode in that identical head.
    expect(withFindings.stdout).toContain("never push without consent");
    expect(withFindings.stdout).toContain("@ApiProperty");
  });

  it("renders only gate-KEPT findings, never the raw cache", async () => {
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({ floorRules: FLOOR, reconciliationFindings: [kept, drifted] }),
      [],
      reader,
    );

    // The drifted finding cites a file whose bytes changed since the detector read it, so its
    // evidence is no longer a claim about the file as it is RIGHT NOW. Rendering it would inject a
    // stale assertion under trust="governed", which is exactly what the digest binding exists to
    // stop. It is held back for re-evaluation, not silently resolved.
    const xml = block(h) ?? "";
    expect(xml).toContain("Localhost is banned in examples");
    expect(xml).not.toContain("@ApiProperty");
    expect(xml).not.toContain("case-drifted");
    expect(h.audits[0].reconciliation).toEqual({
      kept: [{ path: KEPT_PATH, reason: "digest_match" }],
      needsReevaluation: [{ path: DRIFT_PATH, reason: "digest_drift" }],
    });
  });

  it("still delivers the block on both degraded branches", async () => {
    // Row 5: no usable cache at all. There are no findings to render either (they live in the
    // cache), so the contract here is that the side channel stays silent rather than throwing.
    const noCache = await run(
      stdin({ reconcileFile: RECONCILE_FILE }),
      null,
      [],
      reader,
    );
    expect(noCache.code).toBe(0);
    expect(noCache.stdout).toContain(INCOMPLETE_DELIVERY_MARKER_TEXT);
    expect(block(noCache)).toBeUndefined();

    // Rows 3/4: an old-schema cache cannot surface scoped rules, but a finding parked in it is
    // still a live divergence. The block rides the side channel independently of scoped delivery,
    // which is the whole reason it lives in the tail region and not in the assembler's head.
    const oldSchema = await run(
      stdin({ reconcileFile: RECONCILE_FILE }),
      cache({ schemaVersion: 1, floorRulesXml: "<floor/>", reconciliationFindings: [kept] }),
      [],
      reader,
    );
    expect(oldSchema.code).toBe(0);
    expect(oldSchema.stdout).toContain(SCOPED_UNAVAILABLE_MARKER_TEXT);
    expect(block(oldSchema)).toContain("Localhost is banned in examples");
    expect(oldSchema.stdout).not.toContain("decision-reconciliation");
  });

  it("writes nothing when the caller names no reconcileFile", async () => {
    // The hook owns the temp path; a caller that does not want the block simply omits it. The
    // subcommand must not invent a well-known destination, because a file nobody deletes is a
    // stale block the next turn would inject as if it were fresh.
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts" }),
      cache({ floorRules: FLOOR, reconciliationFindings: [kept] }),
      [],
      reader,
    );
    expect(h.code).toBe(0);
    expect(h.meters).toEqual([]);
    expect(h.audits[0].reconciliation?.kept).toEqual([{ path: KEPT_PATH, reason: "digest_match" }]);
  });

  // -------------------------------------------------------------------------------------------
  // The freshness gate, which sits IN FRONT of the rehash gate and answers a different question.
  //
  // The rehash gate proves the cited file has not drifted. It cannot prove the DECISION is still
  // live: dismissal, retraction, tombstoning, and this viewer's visibility are all decided in
  // control per read. So a laptop that has not reached control since yesterday must stop asserting
  // trust="governed", no matter how pristine the file's digest still is. These pin the direction
  // of that failure: stale goes SILENT, and it goes silent WITHOUT reading a single artifact byte.
  // -------------------------------------------------------------------------------------------

  it("renders nothing once the pull ages out, and does not even read the artifact", async () => {
    const reads: string[] = [];
    const countingReader: ArtifactByteReader = (p) => {
      reads.push(p);
      return reader(p);
    };
    // 24h is the window; 24h + 1min is outside it. The digest still matches perfectly.
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({
        floorRules: FLOOR,
        reconciliationFindings: [kept],
        reconciliationFetchedAt: "2026-07-04T11:59:00.000Z",
      }),
      [],
      countingReader,
    );

    expect(h.code).toBe(0);
    expect(block(h)).toBeUndefined();
    // Short-circuited, not filtered: a stale list costs zero file reads, so an agent working in a
    // huge repo pays nothing for findings it will never be shown.
    expect(reads).toEqual([]);
    expect(h.audits[0].reconciliation).toBeUndefined();
  });

  it("treats an unstamped cache as infinitely stale rather than assuming it is fresh", async () => {
    // A cache written by a pre-stamp CLI, or hand-edited. The findings look identical to a fresh
    // pull; the difference is that nothing can date them. Trust that cannot be dated is not trust.
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({
        floorRules: FLOOR,
        reconciliationFindings: [kept],
        reconciliationFetchedAt: undefined,
      }),
      [],
      reader,
    );

    expect(h.code).toBe(0);
    expect(block(h)).toBeUndefined();
  });

  it("does not let a future-dated stamp buy trust", async () => {
    // Clock skew, or a stamp someone edited forward to keep a finding alive. Either way it is not
    // evidence of a recent pull, so it must not be treated as one.
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({
        floorRules: FLOOR,
        reconciliationFindings: [kept],
        reconciliationFetchedAt: "2026-07-06T12:00:00.000Z",
      }),
      [],
      reader,
    );

    expect(h.code).toBe(0);
    expect(block(h)).toBeUndefined();
  });

  it("still renders at the very edge of the window", async () => {
    // Exactly 24h old. The boundary is inclusive on purpose: a scan from this time yesterday is
    // the ordinary daily-driver case, and flipping it to silent one millisecond early would make
    // the feature blink out for the operator who scans at the same time each morning.
    const h = await run(
      stdin({ prompt: "edit apps/control/outbox.ts", reconcileFile: RECONCILE_FILE }),
      cache({
        floorRules: FLOOR,
        reconciliationFindings: [kept],
        reconciliationFetchedAt: "2026-07-04T12:00:00.000Z",
      }),
      [],
      reader,
    );

    expect(h.code).toBe(0);
    expect(block(h)).toContain("Localhost is banned in examples");
  });
});

// ---------------------------------------------------------------------------------------------
// The DEFAULT wiring, on a real filesystem, when the marker sits ABOVE the checkout.
//
// Every test above injects both `readCache` and `readArtifactBytes`, which is exactly why the
// suite was blind to this: the two defaults resolved paths against two DIFFERENT roots and no
// test ever ran both. A finding's `path` is scan-root relative (scan.ts enumerates via
// `gitLsFiles(scanRoot)`), and a marker above the checkouts is an explicitly supported layout, so
// rooting the byte reader at the turn's repoRoot (the git toplevel, one level DOWN) made every
// finding read as unreadable. The gate then dropped it in silence: the hook said nothing while
// `mla context list`, which already resolved against the scan root, still listed it as live.
//
// This drives the subcommand with NO reader and NO cache injected, so both defaults are the thing
// under test.
// ---------------------------------------------------------------------------------------------

describe("assemble-context: the byte reader is rooted where the finding paths are", () => {
  const ARTIFACT = "CLAUDE.md";
  const BYTES = "# House rules\n\nUse localhost for every local service example.\n";
  const ACCEPTED = "Use 127.0.0.1, never localhost.";

  let markerDir: string;
  let checkout: string;
  let home: string;
  let reconcileFile: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    markerDir = realpathSync(mkdtempSync(join(tmpdir(), "mla-asm-root-")));
    checkout = join(markerDir, "checkout");
    home = mkdtempSync(join(tmpdir(), "mla-asm-home-"));
    reconcileFile = join(home, "reconcile.xml");
    mkdirSync(checkout, { recursive: true });
    // The marker binds the workspace one level ABOVE the checkout, and the scan that produced the
    // finding ran from there, so the artifact is addressed relative to markerDir.
    writeFileSync(join(markerDir, ".meetless.json"), JSON.stringify({ workspaceId: WS }));
    writeFileSync(join(markerDir, ARTIFACT), BYTES);
    writeScanCache(
      home,
      WS,
      cache({
        scanRootPath: markerDir,
        floorRules: [
          { ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" as const },
        ],
        reconciliationFindings: [
          {
            path: ARTIFACT,
            evaluatedDigest: normalizedContentHash(BYTES, CONTENT_NORMALIZATION_V1),
            reason: "a governed decision superseded this instruction",
            acceptedStatement: ACCEPTED,
            sourceCaseId: "case_root",
          },
        ],
      }),
    );
    // The session runs inside the checkout, which is what makes repoRoot and the scan root differ.
    process.chdir(checkout);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(markerDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("renders a finding whose path resolves under the scan root, not under repoRoot", async () => {
    const code = await runAssembleContext([], {
      readStdin: () =>
        JSON.stringify({
          base: BASE,
          prompt: "",
          workingSet: [],
          workspaceId: WS,
          safeTotal: 1800,
          // The git toplevel the hook derives. It is NOT the root the finding path speaks about.
          repoRoot: checkout,
          reconcileFile,
        }),
      writeAudit: () => {},
      home,
      now: () => "2026-07-05T12:00:00.000Z",
      log: () => {},
    });

    expect(code).toBe(0);
    expect(readFileSync(reconcileFile, "utf8")).toContain(ACCEPTED);
  });

  it("still drops the finding when the artifact under the scan root has drifted", async () => {
    // The negative control for the test above: proof it passes because the gate READ the file and
    // the digest matched, not because containment was loosened into "resolve it anywhere".
    writeFileSync(join(markerDir, ARTIFACT), BYTES + "\nAlso: use 127.0.0.1.\n");

    const code = await runAssembleContext([], {
      readStdin: () =>
        JSON.stringify({
          base: BASE,
          prompt: "",
          workingSet: [],
          workspaceId: WS,
          safeTotal: 1800,
          repoRoot: checkout,
          reconcileFile,
        }),
      writeAudit: () => {},
      home,
      now: () => "2026-07-05T12:00:00.000Z",
      log: () => {},
    });

    expect(code).toBe(0);
    expect(existsSync(reconcileFile)).toBe(false);
  });
});

// G1 (notes/20260809-mla-helpfulness-session-345a4bce-*.md): the floor delta is built
// from `delivered` filtered to tier "floor-must", so it cannot see either way a floor
// SHOULD rule stops being delivered. Measured live on 2026-08-09: three newly-created
// MUST rules pushed two ACTIVE floor SHOULD rules into `omitted` with reason
// "best-effort:did-not-fit", and the turn recap rendered "+3 added" with no removals.
//
// UN-SKIPPED 2026-08-09 when G1 landed. It was parked as `describe.skip` rather than
// left red because this tree is shared by 10+ concurrent sessions and a
// deliberately-failing test is hostile to every one of them; it went live the moment
// the caller started building the delta from the whole delivered floor.
describe("G1: the audit's floor delta covers floor SHOULD rules", () => {
  const MUST = { ruleId: "fm1", versionId: "v1", text: "a must rule", strength: "MUST" as const };
  // The SHOULD is deliberately LONG, and that is a fixture repair rather than a style
  // choice. It read "a should rule that will be squeezed out" (39 chars) and went red at
  // 85dce566d, which made the floor block's PARTIAL-delivery sentence longer than its
  // COMPLETE one. The budget baseline is sized with the partial sentence (the correct
  // worst case: no SHOULD accepted), so the trial that accepts the LAST SHOULD swaps that
  // sentence for the shorter complete one and refunds ~40 bytes to itself. A 39-char
  // SHOULD fits inside that refund; the squeeze the test is about never happened, and the
  // test measured a sentence length instead of a budget contest.
  //
  // The refund is not a defect -- the delivered text still fits `budget`, which is the
  // only guarantee the assembler makes -- but a fixture whose verdict turns on 40 bytes of
  // prose is not testing what its name says. At 600 chars the contest is decided by the
  // budget and nothing else, and no future wording change can flip it.
  const SHOULD = {
    ruleId: "fs1",
    versionId: "v1",
    text: "a should rule that will be squeezed out. " + "s".repeat(600),
    strength: "SHOULD" as const,
  };
  const BIG_MUST = { ruleId: "fm2", versionId: "v1", text: "z".repeat(5800), strength: "MUST" as const };

  it("records a delivered floor SHOULD as part of the floor, whatever tier carried it", async () => {
    // Blind spot 1, at its source. The SHOULD fits, so it is DELIVERED -- but under tier
    // "best-effort", which it shares with scoped rules. Marking floor membership on the row is
    // what lets the next turn diff the whole floor instead of only its MUST half.
    const h = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }));
    const row = h.audits[0].delivered.find((d) => d.ruleId === "fs1");
    expect(row).toBeDefined();
    expect(row!.floor).toBe(true);
    // And its statement is retained, for the same reason a MUST's is: a rule that leaves the floor
    // is absent from the next scan cache, so this is the only surviving copy for the delta to quote.
    expect(row!.text).toBe(SHOULD.text);
  });

  it("does NOT report a floor SHOULD that lost its slot to a new MUST as a removal (I3 reverses this half of G1)", async () => {
    // REVERSED 2026-08-10, measured in session bb182a52. G1 shipped this assertion the other
    // way round and it was wrong in production: the recap told the agent "-2 removed" about two
    // rules the same process's receipt recorded, seconds earlier, as "best-effort:did-not-fit".
    //
    // Nobody withdrew them. The floor block discloses the size drop on this very turn in its own
    // precedence sentence ("except best-effort [SHOULD] rules that did not fit this turn"), the
    // rules are still ACTIVE in the store, and they ride again the moment the prompt is shorter.
    // Because omission tracks PROMPT LENGTH, the old assertion made the line fire on every budget
    // flip, on a line whose entire value is being "absent almost always".
    //
    // What survives from G1 is the test above: a delivered floor SHOULD is floor membership, not
    // tier "floor-must". That was the blind spot worth closing.
    const first = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }));
    expect(first.audits[0].delivered.map((d) => d.ruleId)).toContain("fs1");

    // Turn 2: a big new MUST arrives and the SHOULD no longer fits. The previous turn's receipt is
    // fed in, because the delta is a diff against it and nothing else.
    const second = await run(
      stdin(),
      cache({ floorRules: [MUST, BIG_MUST, SHOULD] }),
      [],
      undefined,
      null,
      first.audits[0],
    );
    // The assembler still records WHY it went missing, on the same receipt. That record is the
    // whole reason the delta can now tell the two cases apart.
    expect(second.audits[0].omitted.map((o) => o.ruleId)).toContain("fs1");
    expect(second.audits[0].omitted.find((o) => o.ruleId === "fs1")?.reason).toBe("best-effort:did-not-fit");
    expect(second.audits[0].floorDelta?.removed.map((r) => r.ruleId) ?? []).not.toContain("fs1");
    // The genuinely new obligation still announces itself. Suppressing the false half must not
    // cost the true half.
    expect(second.audits[0].floorDelta?.added.map((r) => r.ruleId)).toContain("fm2");
  });

  it("still reports a floor SHOULD that was genuinely revoked, on the same budget-squeezed turn", async () => {
    // The other half of I3, end to end and in the hardest shape: one SHOULD is withheld for bytes
    // and another is deleted from the cache on the SAME turn. If presence were "ignore anything
    // absent" instead of "delivered union omitted", this real withdrawal would vanish with the
    // false one.
    const REVOKED = {
      ruleId: "fs2",
      versionId: "v1",
      text: "a should rule that is about to be revoked outright. " + "r".repeat(200),
      strength: "SHOULD" as const,
    };
    const first = await run(stdin(), cache({ floorRules: [MUST, SHOULD, REVOKED] }));
    expect(first.audits[0].delivered.map((d) => d.ruleId)).toEqual(expect.arrayContaining(["fs1", "fs2"]));

    // fs2 is gone from the cache entirely (revoked); fs1 is still configured but squeezed out.
    const second = await run(
      stdin(),
      cache({ floorRules: [MUST, BIG_MUST, SHOULD] }),
      [],
      undefined,
      null,
      first.audits[0],
    );
    expect(second.audits[0].omitted.map((o) => o.ruleId)).toContain("fs1");
    expect(second.audits[0].floorDelta?.removed.map((r) => r.ruleId)).toEqual(["fs2"]);
    // Quotable, for the same reason M6 quotes at all: a count says something changed, not which
    // obligation, and "which" is the half an agent mid-task needs.
    expect(second.audits[0].floorDelta?.removed.find((r) => r.ruleId === "fs2")?.text).toBe(REVOKED.text);
  });

  it("does not announce a re-fitted SHOULD as added when the budget frees up again", async () => {
    // The symmetric alarm, which fires on the very next short prompt. `prev` on the delta is the
    // previous receipt's DELIVERED set, so without reading that receipt's `omitted` too, a rule
    // that merely re-fits reads as a brand-new obligation.
    const squeezed = await run(stdin(), cache({ floorRules: [MUST, BIG_MUST, SHOULD] }));
    expect(squeezed.audits[0].omitted.map((o) => o.ruleId)).toContain("fs1");

    const roomy = await run(
      stdin(),
      cache({ floorRules: [MUST, SHOULD] }),
      [],
      undefined,
      null,
      squeezed.audits[0],
    );
    expect(roomy.audits[0].delivered.map((d) => d.ruleId)).toContain("fs1");
    expect(roomy.audits[0].floorDelta?.added.map((r) => r.ruleId) ?? []).not.toContain("fs1");
  });

  it("does not report a removal when the SHOULD merely moved tier", async () => {
    // The false-alarm direction. Delivered last turn and delivered this turn is delivered; if the
    // fix reported tier CHANGES it would trade one false silence for per-turn noise.
    const first = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }));
    const second = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }), [], undefined, null, first.audits[0]);
    expect(second.audits[0].floorDelta).toBeUndefined();
  });

  it("stays silent on a degraded turn instead of reporting the whole floor as removed", async () => {
    // The degraded branches (Row 5 no-cache, Rows 3/4 old-schema) deliver a PRE-RENDERED floor
    // block and record `delivered: []`, because a rendered block cannot say how many rules are
    // inside it -- which is why the meter for those branches sets `degraded: true` and
    // `always_on_rules: 0`. Empty there means UNKNOWN, not NONE.
    //
    // Diffing a real prior against that unknown reads every floor rule as withdrawn. The line
    // rides a footer the agent sees every turn, so one spurious "-13 removed" is exactly the false
    // alarm that teaches it to skip the line -- and it would fire hardest on the turns where the
    // floor is most degraded.
    const first = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }));
    const degraded = await run(stdin(), null, [], undefined, null, first.audits[0]);
    expect(degraded.audits[0].state).toBe("incomplete");
    expect(degraded.audits[0].floorDelta).toBeUndefined();
  });

  it("does not report the whole floor as added on the turn AFTER a degraded one", async () => {
    // The other half of the same hazard: a degraded receipt carries no floor knowledge, so treating
    // its empty `delivered` as a real prior makes the next healthy turn announce the entire floor
    // as new. An unknown prior must read as "no prior", which floorDelta already renders as silence.
    const degradedAudit = (await run(stdin(), null)).audits[0];
    const healthy = await run(stdin(), cache({ floorRules: [MUST, SHOULD] }), [], undefined, null, degradedAudit);
    expect(healthy.audits[0].state).toBe("normal");
    expect(healthy.audits[0].floorDelta).toBeUndefined();
  });
});

// F3 (notes/20260809-did-mla-help-session-ae6411e4-fix-proposal.md D4). The floor delta
// answers "was an obligation WITHDRAWN under me". It computes that from floor membership
// alone, so a rule RECLASSIFIED from the always-on floor to the turn-scoped set reads as a
// withdrawal on the turn it moves -- while the agent is still being told the rule, in the
// `<meetless-context kind="scoped-rules">` block one paragraph down.
//
// FIVE recorded instances of this class before this one, which is why it is a defect and
// not a rough edge: b83bb228 proposal D7 (a whole session spent disproving it),
// `floor-delta-session-scope.spec.ts`, the 2026-08-10 floor-rule classification audit,
// session b2204299 (floor 13 -> 9 -> 11 while scoped went 1 -> 4 -> 2), and session
// ae6411e4, where the alarm named the Mermaid design-doc rule as evicted with that rule
// visibly present in the delivered scoped block.
//
// `mla rules edit --turn-when-*` is the operator action that produces the move, so this is
// a supported flow, not a corrupt-state edge.
//
// THE INVARIANT: a rule has LEFT the delivered snapshot only when its stable id is absent
// from BOTH the current floor set and the current scoped set. Symmetric, because the
// mirror case (scoped -> floor) would otherwise announce a rule the agent already had as
// newly added.
describe("F3: a rule reclassified between floor and scoped has not left the snapshot", () => {
  const MUST = { ruleId: "fm1", versionId: "v1", text: "never push without consent", strength: "MUST" as const };
  const MOVER = {
    ruleId: "r_mermaid",
    versionId: "v1",
    text: "When authoring a design doc, proposal, plan, RFC, or architecture spec, include a complete Mermaid sequence diagram.",
    strength: "MUST" as const,
  };
  // Matches the prompt below, so the reclassified rule is genuinely DELIVERED this turn.
  const MOVER_SCOPED = { ...MOVER, globs: ["notes/**"] };
  const PROMPT = { prompt: "please edit notes/20260810-thing.md" };

  it("does not report a removal when a floor rule became a scoped rule that still delivered", async () => {
    const first = await run(stdin(PROMPT), cache({ floorRules: [MUST, MOVER] }));
    expect(first.audits[0].delivered.map((d) => d.ruleId)).toContain("r_mermaid");

    const second = await run(
      stdin(PROMPT),
      cache({ floorRules: [MUST], scopedRules: [MOVER_SCOPED] }),
      [],
      undefined,
      null,
      first.audits[0],
    );
    // The premise of the assertion: the rule really did ride this turn, in the scoped block.
    expect(second.audits[0].delivered.map((d) => d.ruleId)).toContain("r_mermaid");
    expect(second.stdout).toContain("Mermaid sequence diagram");
    // ...so nothing was withdrawn, and the line must stay silent.
    expect(second.audits[0].floorDelta?.removed.map((r) => r.ruleId) ?? []).not.toContain("r_mermaid");
  });

  it("does not report an addition when a scoped rule became a floor rule", async () => {
    // The mirror. Without it the fix would trade one false alarm for the other: the agent is
    // told a rule is NEW when it read the same obligation on the previous turn.
    const first = await run(stdin(PROMPT), cache({ floorRules: [MUST], scopedRules: [MOVER_SCOPED] }));
    expect(first.audits[0].delivered.map((d) => d.ruleId)).toContain("r_mermaid");

    const second = await run(
      stdin(PROMPT),
      cache({ floorRules: [MUST, MOVER] }),
      [],
      undefined,
      null,
      first.audits[0],
    );
    expect(second.audits[0].delivered.map((d) => d.ruleId)).toContain("r_mermaid");
    expect(second.audits[0].floorDelta?.added.map((r) => r.ruleId) ?? []).not.toContain("r_mermaid");
  });

  it("still reports a removal when the rule left the floor and NO block carried it", async () => {
    // The half that must not be broken by the fix. A reclassified rule whose scope does not
    // match this turn is genuinely not in front of the agent, and that is the event M6 exists
    // to announce. Same cache as the first test, different prompt: the glob does not match.
    const first = await run(stdin(PROMPT), cache({ floorRules: [MUST, MOVER] }));

    const second = await run(
      stdin({ prompt: "please edit apps/control/outbox.ts" }),
      cache({ floorRules: [MUST], scopedRules: [MOVER_SCOPED] }),
      [],
      undefined,
      null,
      first.audits[0],
    );
    expect(second.audits[0].delivered.map((d) => d.ruleId)).not.toContain("r_mermaid");
    expect(second.audits[0].floorDelta?.removed.map((r) => r.ruleId)).toContain("r_mermaid");
    // And it is quotable: the statement survives on the prior receipt, which is the only
    // place it exists once the rule is gone from the floor.
    expect(second.audits[0].floorDelta?.removed.find((r) => r.ruleId === "r_mermaid")?.text).toBe(MOVER.text);
  });
});
