import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assembleAuditPath, readAssembleAudit, writeAssembleAudit } from "../../src/lib/scanner/cache";
import { floorDelta, renderFloorDelta, type FloorRuleRef } from "../../src/lib/scanner/floor-delta";
import { runAssembleContext } from "../../src/commands/assemble-context";
import { SCAN_SCHEMA_VERSION, type FloorRuleEntry, type ScanResult } from "../../src/lib/scanner/types";

// THE INVARIANT: a session's floor delta compares the current floor with THAT SAME
// SESSION's previous delivered floor. Never with a stranger's.
//
// This file was a DEFECT PIN (d6ad79c13). It is now a positive regression, because the
// defect is fixed; the history stays because the harm is not obvious from the code.
//
// THE MEASURED CASE, session bc08eb20, 2026-08-09.
//
// M6 shipped `floorDelta` so an agent is told when an obligation is WITHDRAWN under it:
// "one that DISAPPEARS without announcement is worse, because the agent keeps paying its
// cost and may keep citing it as the reason for a decision." Turn 2 of that session read:
//
//   floor changed since your last turn: +2 added "Prefer 127.0.0.1 over localhost ..." +1 more
//
// Four rules had LEFT between that agent's turn 1 and turn 2, three of them `[MUST]`
// (production read credentials, the governed prod helper path, and the comms-doctrine
// lookup). The receipt recorded `removed: []`.
//
// `renderFloorDelta` was NEVER the defect: it renders both directions, and the first test
// below still pins that so this file cannot be misread as "removals are unimplemented".
// The defect was the BASELINE. `assembleAuditPath(workspaceId)` was keyed on the workspace
// and carried no session id, so every session on the machine wrote the same file and
// `defaultReadFloorDelta` diffed against whatever was there last. Counted off
// `ask-traces.jsonl` between that agent's two turns: 35 assemblies by OTHER sessions, 1 by
// itself. The delta was computed against the 35th stranger, and the line's own words are
// "since your last turn".
//
// The floor block one paragraph above that receipt carries a `[MUST]` rule reading "10+
// agent sessions share this checkout". The receipt beside it did not know that.
//
// THE FIX: the audit filename carries the session id. A per-session FILE and not a
// `{sessionId: audit}` map inside the shared one, deliberately: the map needs a
// read-modify-write from 10+ concurrent processes, which trades today's logical race for a
// lost-update race, and the write is a plain full-file overwrite precisely so it cannot
// interleave. Sessions cannot overwrite one another when they do not share a file.
describe("M6 floor delta: the baseline is the SAME session's previous floor", () => {
  const WS = "ws_floor_delta_scope";
  const SESSION_A = "a7a7eb27-d37d-4e64-a15d-67b9c5cc1236";
  const SESSION_B = "bc08eb20-b032-43dc-b381-a4d3b60d3685";

  function home(): string {
    return mkdtempSync(join(tmpdir(), "mla-floor-scope-"));
  }

  const RULE_A: FloorRuleRef = { ruleId: "r_prod_reads", text: "Production reads are non-interactive and already provisioned." };
  const RULE_B: FloorRuleRef = { ruleId: "r_shared_tree", text: "Shared working tree: 10+ agent sessions share this checkout." };
  const RULE_C: FloorRuleRef = { ruleId: "r_localhost", text: "Prefer 127.0.0.1 over localhost for local services on macOS." };

  function audit(delivered: FloorRuleRef[]): Parameters<typeof writeAssembleAudit>[2] {
    return { schemaVersion: 1, at: "2026-08-09T23:34:46Z", workspaceId: WS, state: "normal", delivered, omitted: [] } as never;
  }

  // Exactly what the assembler does on the hot path, in the order it does it: read the
  // baseline for THIS session, diff, then overwrite this session's own receipt. Written as
  // a helper so the interleaving below reads as a sequence of turns rather than as
  // bookkeeping.
  function assembleTurn(h: string, sessionId: string, delivered: FloorRuleRef[]) {
    const prior = (readAssembleAudit(h, WS, sessionId)?.delivered ?? null) as FloorRuleRef[] | null;
    const delta = floorDelta(prior, delivered);
    writeAssembleAudit(h, WS, audit(delivered), sessionId);
    return delta;
  }

  it("the renderer is not the defect: it states removals in words", () => {
    const d = floorDelta([RULE_A, RULE_B], [RULE_B, RULE_C]);
    expect(d.removed.map((r) => r.ruleId)).toEqual(["r_prod_reads"]);
    expect(d.added.map((r) => r.ruleId)).toEqual(["r_localhost"]);
    const line = renderFloorDelta(d);
    expect(line).toContain("removed");
    expect(line).toContain("added");
  });

  it("two sessions in one workspace do not share a receipt file", () => {
    const h = home();
    expect(assembleAuditPath(WS, h, SESSION_A)).not.toBe(assembleAuditPath(WS, h, SESSION_B));
    // Stable for one session: a delta needs the same file across the session's turns.
    expect(assembleAuditPath(WS, h, SESSION_A)).toBe(assembleAuditPath(WS, h, SESSION_A));
    expect(assembleAuditPath(WS, h, SESSION_A)).toContain(SESSION_A);
  });

  it("A1 -> B1 -> A2: A2 diffs against A1, and the WITHDRAWAL is reported", () => {
    const h = home();

    // A1. Session A's first turn. No prior for A, so nothing is announced.
    const a1 = assembleTurn(h, SESSION_A, [RULE_A, RULE_B]);
    expect(renderFloorDelta(a1)).toBeNull();

    // B1. A peer session assembles in between. On the measured session this happened 35
    // times. B's floor does not carry RULE_A.
    assembleTurn(h, SESSION_B, [RULE_B, RULE_C]);

    // A2. Session A's second turn, with the SAME floor B happens to be on. The baseline
    // must be A1, not B1. RULE_A left A's floor and A must be told so -- this removal is
    // the whole reason the mechanism exists, and it is what reported as `removed: []`.
    const a2 = assembleTurn(h, SESSION_A, [RULE_B, RULE_C]);
    expect(a2.removed.map((r) => r.ruleId)).toEqual(["r_prod_reads"]);
    expect(a2.added.map((r) => r.ruleId)).toEqual(["r_localhost"]);
    const line = renderFloorDelta(a2);
    expect(line).toContain("removed");
    expect(line).toContain("added");
  });

  it("B1 has NO delta merely because another session ran first", () => {
    const h = home();

    // A assembles first and its floor is wildly different. Under the shared file this
    // became B's baseline, so B's very first turn announced a delta that happened to
    // nobody -- "announcing the entire floor as new on every session start is exactly the
    // false alarm that teaches an agent to skip the line", from floorDelta's own contract.
    assembleTurn(h, SESSION_A, [RULE_A]);

    const b1 = assembleTurn(h, SESSION_B, [RULE_A, RULE_B, RULE_C]);
    expect(b1.added).toEqual([]);
    expect(b1.removed).toEqual([]);
    expect(renderFloorDelta(b1)).toBeNull();
  });

  it("a session id that is not one safe path component is REFUSED, not sanitized", () => {
    const h = home();
    // Same discipline as the workspace id (path-component.ts): mapping two distinct ids
    // onto one filename would mix two sessions' baselines, which is the bug this file is
    // about, arriving through the sanitizer instead.
    expect(() => assembleAuditPath(WS, h, "../../escaped")).toThrow(/session id/i);
    expect(() => assembleAuditPath(WS, h, "'quoted'")).toThrow(/session id/i);
  });

  // The tests above drive the storage seam directly. This one drives the SUBCOMMAND, with the
  // real `readAssembleAudit`/`writeAssembleAudit` against a real temp state root, because the
  // defect was never in `floorDelta`; it was in which file the assembler handed it. A test
  // that injects the audit I/O cannot see that, which is why the original defect shipped past a
  // suite that already had floor-delta coverage.
  describe("end to end through the subcommand, real receipts on disk", () => {
    const FLOOR_A: FloorRuleEntry = { ruleId: "r_prod_reads", versionId: "v1", text: "Production reads are non-interactive.", strength: "MUST" };
    const FLOOR_B: FloorRuleEntry = { ruleId: "r_shared_tree", versionId: "v1", text: "10+ agent sessions share this checkout.", strength: "MUST" };

    function cacheWith(floorRules: FloorRuleEntry[]): ScanResult {
      return {
        schemaVersion: SCAN_SCHEMA_VERSION,
        workspaceId: WS,
        commitSha: "abc",
        generatedAt: "2026-08-09T00:00:00.000Z",
        inventory: {} as ScanResult["inventory"],
        directives: [],
        staleSignals: [],
        confirmedRulesXml: "",
        floorRulesXml: floorRules.map((r) => `- ${r.text}`).join("\n"),
        floorRules,
        scopedRules: [],
        staleContextXml: "",
        advisoryDirectives: [],
        reconciliationFetchedAt: "2026-08-09T00:00:00.000Z",
      } as ScanResult;
    }

    async function turn(h: string, sessionId: string | undefined, floorRules: FloorRuleEntry[]) {
      await runAssembleContext([], {
        readStdin: () =>
          JSON.stringify({
            base: "workspace_hint: ws",
            prompt: "a prompt",
            workingSet: [],
            workspaceId: WS,
            ...(sessionId ? { sessionId } : {}),
          }),
        readCache: () => cacheWith(floorRules),
        readGlobalCache: () => null,
        home: h,
        now: () => "2026-08-09T12:00:00.000Z",
        log: () => {},
      });
      return readAssembleAudit(h, WS, sessionId);
    }

    it("A1 -> B1 -> A2 through the real subcommand: A2 is told about the withdrawal", async () => {
      const h = home();

      await turn(h, SESSION_A, [FLOOR_A, FLOOR_B]);
      await turn(h, SESSION_B, [FLOOR_B]);
      const a2 = await turn(h, SESSION_A, [FLOOR_B]);

      // The rule left A's floor between A1 and A2. Under the shared receipt A2's baseline was
      // B1, which already lacked it, so the withdrawal reported as no change at all.
      expect(a2?.floorDelta?.removed?.map((r) => r.ruleId)).toEqual(["r_prod_reads"]);
      expect(a2?.floorDelta?.added ?? []).toEqual([]);
    });

    it("B's first turn is silent, and the two sessions' receipts are separate files", async () => {
      const h = home();

      await turn(h, SESSION_A, [FLOOR_A]);
      const b1 = await turn(h, SESSION_B, [FLOOR_A, FLOOR_B]);

      // A ran first with a different floor. B has no prior of its own, so B says nothing.
      expect(b1?.floorDelta).toBeUndefined();
      // Both receipts survive: neither session overwrote the other.
      expect(readAssembleAudit(h, WS, SESSION_A)).not.toBeNull();
      expect(readAssembleAudit(h, WS, SESSION_B)).not.toBeNull();
      expect(existsSync(assembleAuditPath(WS, h, SESSION_A))).toBe(true);
      expect(existsSync(assembleAuditPath(WS, h, SESSION_B))).toBe(true);
      // And the legacy shared file is not written at all when a session is named, so it cannot
      // become anyone's baseline.
      expect(existsSync(assembleAuditPath(WS, h))).toBe(false);
    });

    it("a caller with no session id still gets a receipt, on the legacy path", async () => {
      const h = home();
      const t1 = await turn(h, undefined, [FLOOR_A]);
      expect(t1).not.toBeNull();
      expect(existsSync(assembleAuditPath(WS, h))).toBe(true);
    });
  });

  it("no session id still resolves the workspace-shaped path, for callers that have none", () => {
    const h = home();
    // Back-compat, and the honest fallback: a caller that cannot name a session gets the
    // legacy file rather than a guess at someone else's.
    expect(assembleAuditPath(WS, h)).toBe(assembleAuditPath(WS, h));
    expect(assembleAuditPath(WS, h)).toMatch(/assemble-audit\.json$/);
    writeAssembleAudit(h, WS, audit([RULE_A]));
    expect(readAssembleAudit(h, WS)?.delivered).toHaveLength(1);
    // And it is a DIFFERENT file from any session's, so a legacy writer cannot become a
    // session's baseline.
    expect(readAssembleAudit(h, WS, SESSION_A)).toBeNull();
  });
});
