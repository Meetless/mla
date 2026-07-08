import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeScanCache, readScanCache, readVerdicts, writeVerdicts, applyVerdicts,
} from "../../../src/lib/scanner/cache";
import { ScanResult, Verdicts } from "../../../src/lib/scanner/types";

function fakeResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 1, workspaceId: "ws1", commitSha: "deadbeef", generatedAt: "2026-06-12T00:00:00Z",
    inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 2, agentMemoryRules: 0 },
    directives: [],
    staleSignals: [
      { id: "s1", source: "a.md", reason: "frontmatter_deprecated", detail: "a deprecated" },
      { id: "s2", source: "b.md", reason: "frontmatter_deprecated", detail: "b deprecated" },
    ],
    confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "<possible-stale-context>\n  <item source=\"a.md\">a deprecated</item>\n  <item source=\"b.md\">b deprecated</item>\n</possible-stale-context>",
    advisoryDirectives: [],
    ...over,
  };
}

describe("cache + verdicts", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-cache-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("round-trips a scan cache under the workspace dir", () => {
    writeScanCache(home, "ws1", fakeResult());
    const back = readScanCache(home, "ws1");
    expect(back?.workspaceId).toBe("ws1");
    expect(back?.staleSignals).toHaveLength(2);
  });

  it("defaults verdicts to empty and round-trips them", () => {
    expect(readVerdicts(home, "ws1")).toEqual({ schemaVersion: 1, accepted: [], dismissed: [] });
    const v: Verdicts = { schemaVersion: 1, accepted: ["s1"], dismissed: ["s2"] };
    writeVerdicts(home, "ws1", v);
    expect(readVerdicts(home, "ws1")).toEqual(v);
  });

  it("applyVerdicts drops dismissed signals and re-renders the stale block", () => {
    const result = fakeResult();
    const applied = applyVerdicts(result, { schemaVersion: 1, accepted: [], dismissed: ["s2"] });
    expect(applied.staleSignals.map((s) => s.id)).toEqual(["s1"]);
    expect(applied.staleContextXml).toContain("a deprecated");
    expect(applied.staleContextXml).not.toContain("b deprecated");
    expect(applied.inventory.staleSignals).toBe(1);
  });
});
