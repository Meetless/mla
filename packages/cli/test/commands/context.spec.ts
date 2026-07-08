// test/commands/context.spec.ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisoryLines, applyContextVerdict, latestReviewCardItems, runContext } from "../../src/commands/context";
import { readVerdicts, writeScanCache } from "../../src/lib/scanner/cache";
import { ScanResult } from "../../src/lib/scanner/types";

describe("applyContextVerdict", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-ctx-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("records an accept and removes it from dismissed if present", () => {
    applyContextVerdict({ home, workspaceId: "ws1", action: "dismiss", id: "s1" });
    expect(readVerdicts(home, "ws1").dismissed).toContain("s1");
    applyContextVerdict({ home, workspaceId: "ws1", action: "accept", id: "s1" });
    const v = readVerdicts(home, "ws1");
    expect(v.accepted).toContain("s1");
    expect(v.dismissed).not.toContain("s1");
  });

  it("is idempotent (no duplicate ids)", () => {
    applyContextVerdict({ home, workspaceId: "ws1", action: "dismiss", id: "s2" });
    applyContextVerdict({ home, workspaceId: "ws1", action: "dismiss", id: "s2" });
    expect(readVerdicts(home, "ws1").dismissed).toEqual(["s2"]);
  });

  it("dismiss removes id from accepted if present", () => {
    applyContextVerdict({ home, workspaceId: "ws1", action: "accept", id: "s3" });
    applyContextVerdict({ home, workspaceId: "ws1", action: "dismiss", id: "s3" });
    const v = readVerdicts(home, "ws1");
    expect(v.dismissed).toContain("s3");
    expect(v.accepted).not.toContain("s3");
  });
});

describe("runContext workspace resolution", () => {
  let markerDir: string;
  let home: string;
  const origCwd = process.cwd();
  const origEnv = process.env.MEETLESS_WORKSPACE_ID;

  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), "mla-ctx-ws-"));
    home = mkdtempSync(join(tmpdir(), "mla-ctx-home-"));
    // Write a .meetless.json marker so tryResolveWorkspaceId() can find it.
    writeFileSync(join(markerDir, ".meetless.json"), JSON.stringify({ workspaceId: "ws_from_marker" }));
    // Seed a minimal scan cache so runContext list returns a result (not a fallback path).
    const fakeResult: ScanResult = {
      schemaVersion: 1, workspaceId: "ws_from_marker", commitSha: "abc", generatedAt: "2026-06-12T00:00:00Z",
      inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
      directives: [], staleSignals: [], confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "", advisoryDirectives: [],
    };
    writeScanCache(home, "ws_from_marker", fakeResult);
    // Remove the env override so the command must fall back to the marker.
    delete process.env.MEETLESS_WORKSPACE_ID;
    process.chdir(markerDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origEnv === undefined) {
      delete process.env.MEETLESS_WORKSPACE_ID;
    } else {
      process.env.MEETLESS_WORKSPACE_ID = origEnv;
    }
    rmSync(markerDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves workspaceId from .meetless.json when MEETLESS_WORKSPACE_ID is unset", async () => {
    // runContext uses homedir() internally; we cannot override that without monkey-patching,
    // but we can verify the command does NOT return rc=2 (the "no workspace" error code),
    // which is what it returns today when the env var is absent.
    // With the fix in place it must resolve via the marker (rc=0).
    // We use a custom home so there is a populated cache to read; but since runContext
    // calls homedir() internally we stub the env path instead: restore home via the
    // cache written to the real homedir path would be fragile; assert rc != 2 is sufficient.
    //
    // The observable contract: rc=2 means "no workspace found". rc=0 means resolved.
    // Inject a minimal scan cache under the real homedir for ws_from_marker so list returns 0.
    const { homedir } = await import("node:os");
    const realHome = homedir();
    const wsDir = join(realHome, ".meetless", "workspaces", "ws_from_marker");
    mkdirSync(wsDir, { recursive: true });
    const cacheFile = join(wsDir, "scan-cache.json");
    const fakeResult: ScanResult = {
      schemaVersion: 1, workspaceId: "ws_from_marker", commitSha: "abc", generatedAt: "2026-06-12T00:00:00Z",
      inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
      directives: [], staleSignals: [], confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "", advisoryDirectives: [],
    };
    writeFileSync(cacheFile, JSON.stringify(fakeResult));
    try {
      const rc = await runContext(["list"]);
      expect(rc).toBe(0); // must NOT return 2 (workspace not found)
    } finally {
      rmSync(cacheFile, { force: true });
    }
  });
});

describe("advisoryLines (read-only agent-memory advisory list)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-adv-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const cacheWith = (advisory: ScanResult["advisoryDirectives"]): ScanResult => ({
    schemaVersion: 1, workspaceId: "ws-a", commitSha: "c", generatedAt: "t",
    inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: advisory.length },
    directives: [], staleSignals: [], confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "",
    advisoryDirectives: advisory,
  });

  it("renders one line per advisory directive with id, strength, text, and source", () => {
    writeScanCache(home, "ws-a", cacheWith([
      { id: "m1", text: "Commit on main", source: "agent-memory:feedback_a.md", kind: "RULE", strength: "SHOULD_FOLLOW", attestation: "machine_inferred" },
      { id: "m2", text: "Never push without asking", source: "agent-memory:feedback_b.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "machine_inferred" },
    ]));
    const lines = advisoryLines(home, "ws-a");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("m1");
    expect(lines[0]).toContain("SHOULD_FOLLOW");
    expect(lines[0]).toContain("Commit on main");
    expect(lines[0]).toContain("agent-memory:feedback_a.md");
    expect(lines[1]).toContain("MUST_FOLLOW");
    expect(lines[1]).toContain("Never push without asking");
  });

  it("returns [] when no cache exists and when the advisory set is empty", () => {
    expect(advisoryLines(home, "ws-missing")).toEqual([]);
    writeScanCache(home, "ws-empty", cacheWith([]));
    expect(advisoryLines(home, "ws-empty")).toEqual([]);
  });

  it("guards a pre-M1 cache that lacks advisoryDirectives entirely (returns [])", () => {
    writeScanCache(home, "ws-old", {
      schemaVersion: 1, workspaceId: "ws-old", commitSha: "c", generatedAt: "t",
      inventory: { instructionFiles: 0, decisionDocs: 0, legacyNotes: 0, staleSignals: 0 },
      directives: [], staleSignals: [], confirmedRulesXml: "", staleContextXml: "",
    } as unknown as ScanResult);
    expect(advisoryLines(home, "ws-old")).toEqual([]);
  });
});

describe("latestReviewCardItems", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-rc-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads the latest review-card items from the local jsonl", () => {
    const dir = join(home, ".meetless", "workspaces", "ws1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-cards.jsonl"),
      JSON.stringify({ event: "review_card", items: [{ id: "s1", detail: "old", source: "a.md" }], total: 1 }) + "\n" +
      JSON.stringify({ event: "review_card", items: [{ id: "s2", detail: "new", source: "b.md" }], total: 1 }) + "\n");
    const items = latestReviewCardItems(home, "ws1");
    expect(items).toEqual([{ id: "s2", detail: "new", source: "b.md" }]);
  });

  it("returns [] when the jsonl is absent", () => {
    expect(latestReviewCardItems(home, "ws-missing")).toEqual([]);
  });
});
