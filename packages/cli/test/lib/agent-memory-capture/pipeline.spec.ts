import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  collectOnce,
  syntheticSourceId,
  isActionable,
  type CollectDeps,
} from "../../../src/lib/agent-memory-capture/pipeline";
import { MAX_FILE_BYTES } from "../../../src/lib/agent-memory-capture/containment";
import { readLedger } from "../../../src/lib/agent-memory-capture/ledger";
import type { DecisionRecord, MemoryBinding } from "../../../src/lib/agent-memory-capture/types";

const NOW = "2026-06-27T00:00:00.000Z";

function projectFile(body: string): string {
  return `---\nname: x\nmetadata:\n  type: project\n---\n${body}\n`;
}
function userFile(): string {
  return `---\nname: x\nmetadata:\n  type: user\n---\nbody\n`;
}

function byRel(records: DecisionRecord[], rel: string): DecisionRecord | undefined {
  return records.find((r) => r.relativePath === rel);
}

describe("collectOnce (§4 transition router)", () => {
  let home: string;
  let mem: string;
  let binding: MemoryBinding;
  let deps: CollectDeps;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amp-home-"));
    mem = mkdtempSync(join(tmpdir(), "amp-mem-"));
    binding = {
      bindingId: "bind-1",
      memoryDir: mem,
      workspaceId: "ws-1",
      enabled: true,
      consentedAt: NOW,
    };
    deps = { nowIso: NOW, home };
  });
  afterEach(() => {
    for (const d of [home, mem]) rmSync(d, { recursive: true, force: true });
  });

  it("new clean project file -> eligible, ledger records it", () => {
    writeFileSync(join(mem, "a.md"), projectFile("durable claim here"));
    const sum = collectOnce(binding, deps);
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("eligible");
    expect(r.reason).toBe("new");
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sourceId).toBe(syntheticSourceId("bind-1", "a.md"));
    expect(sum.scanComplete).toBe(true);

    const led = readLedger("bind-1", home).entries["a.md"];
    expect(led.lastDecision).toBe("eligible");
    expect(led.lastObservedHash).toBe(r.hash);
  });

  it("unchanged content on a second pass -> unchanged (no re-emit)", () => {
    writeFileSync(join(mem, "a.md"), projectFile("same"));
    collectOnce(binding, deps);
    const sum2 = collectOnce(binding, deps);
    expect(byRel(sum2.records, "a.md")!.decision).toBe("unchanged");
  });

  it("changed content -> eligible with reason 'changed'", () => {
    writeFileSync(join(mem, "a.md"), projectFile("v1"));
    collectOnce(binding, deps);
    writeFileSync(join(mem, "a.md"), projectFile("v2 different"));
    const sum2 = collectOnce(binding, deps);
    const r = byRel(sum2.records, "a.md")!;
    expect(r.decision).toBe("eligible");
    expect(r.reason).toBe("changed");
  });

  it("block mode: a project file carrying a secret -> blocked, ledger marks scanner version", () => {
    writeFileSync(join(mem, "a.md"), projectFile("config: requirepass O3o7j8zX"));
    const sum = collectOnce(binding, { ...deps, scannerVersion: "vTest", scannerMode: "block" });
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("blocked");
    expect(r.secretRuleIds).toContain("redis_directive");
    const led = readLedger("bind-1", home).entries["a.md"];
    expect(led.lastDecision).toBe("blocked");
    expect(led.blockedScannerVersion).toBe("vTest");
  });

  it("block mode: a blocked file, identical bytes + same scanner version -> unchanged (no re-emit)", () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    collectOnce(binding, { ...deps, scannerVersion: "vTest", scannerMode: "block" });
    const sum2 = collectOnce(binding, { ...deps, scannerVersion: "vTest", scannerMode: "block" });
    expect(byRel(sum2.records, "a.md")!.decision).toBe("unchanged");
  });

  it("block mode: a blocked file is re-evaluated when the scanner version bumps (RETRY-2)", () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    collectOnce(binding, { ...deps, scannerVersion: "v1", scannerMode: "block" });
    const sum2 = collectOnce(binding, { ...deps, scannerVersion: "v2", scannerMode: "block" });
    expect(byRel(sum2.records, "a.md")!.decision).toBe("blocked");
    expect(readLedger("bind-1", home).entries["a.md"].blockedScannerVersion).toBe("v2");
  });

  it("observe mode (the local default): a secret file is eligible with signals, never blocked", () => {
    writeFileSync(join(mem, "a.md"), projectFile("config: requirepass O3o7j8zX"));
    const sum = collectOnce(binding, deps); // no scannerMode -> observe
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("eligible");
    expect(r.secretRuleIds).toContain("redis_directive");
    const led = readLedger("bind-1", home).entries["a.md"];
    expect(led.lastDecision).toBe("eligible");
    expect(led.blockedScannerVersion).toBeUndefined();
  });

  it("observe mode: a scanner outage does not fail the file (no upload to protect)", () => {
    writeFileSync(join(mem, "a.md"), projectFile("clean body"));
    const throwingScan = () => {
      throw new Error("scanner down");
    };
    const sum = collectOnce(binding, { ...deps, scan: throwingScan }); // observe default
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("eligible");
    expect(r.secretRuleIds).toEqual([]);
  });

  it("off mode: the scanner is never invoked and the file routes by content state", () => {
    writeFileSync(join(mem, "a.md"), projectFile("requirepass O3o7j8zX"));
    let called = false;
    const spyScan = () => {
      called = true;
      return ["redis_directive"];
    };
    const sum = collectOnce(binding, { ...deps, scan: spyScan, scannerMode: "off" });
    expect(called).toBe(false);
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("eligible");
    expect(r.secretRuleIds).toEqual([]);
  });

  it("non-project file never tracked -> skipped (and not in ledger)", () => {
    writeFileSync(join(mem, "u.md"), userFile());
    const sum = collectOnce(binding, deps);
    expect(byRel(sum.records, "u.md")!.decision).toBe("skipped");
    expect(readLedger("bind-1", home).entries["u.md"]).toBeUndefined();
  });

  it("project file that turns non-project -> reclassified, ledger entry withdrawn", () => {
    writeFileSync(join(mem, "a.md"), projectFile("was project"));
    collectOnce(binding, deps);
    expect(readLedger("bind-1", home).entries["a.md"]).toBeDefined();
    writeFileSync(join(mem, "a.md"), userFile());
    const sum2 = collectOnce(binding, deps);
    expect(byRel(sum2.records, "a.md")!.decision).toBe("reclassified");
    expect(readLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("malformed frontmatter -> failed, no upload, no lifecycle change", () => {
    writeFileSync(join(mem, "a.md"), "---\nname: x\ntype: project\nno closing fence\n");
    const sum = collectOnce(binding, deps);
    expect(byRel(sum.records, "a.md")!.decision).toBe("failed");
    expect(byRel(sum.records, "a.md")!.reason).toBe("malformed_frontmatter");
    expect(readLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("oversized file -> failed (oversized), never read into a buffer", () => {
    writeFileSync(join(mem, "big.md"), projectFile("z".repeat(MAX_FILE_BYTES + 10)));
    const sum = collectOnce(binding, deps);
    const r = byRel(sum.records, "big.md")!;
    expect(r.decision).toBe("failed");
    expect(r.reason).toBe("oversized");
    expect(r.hash).toBeNull();
  });

  it("block mode: scanner unavailable (throws) -> failed scanner_unavailable, fail-closed (no ledger mutation)", () => {
    writeFileSync(join(mem, "a.md"), projectFile("clean body"));
    const throwingScan = () => {
      throw new Error("scanner down");
    };
    const sum = collectOnce(binding, { ...deps, scan: throwingScan, scannerMode: "block" });
    const r = byRel(sum.records, "a.md")!;
    expect(r.decision).toBe("failed");
    expect(r.reason).toBe("scanner_unavailable");
    expect(readLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("tracked file deleted, scan complete -> deleted, ledger entry removed", () => {
    writeFileSync(join(mem, "a.md"), projectFile("here"));
    collectOnce(binding, deps);
    unlinkSync(join(mem, "a.md"));
    const sum2 = collectOnce(binding, deps);
    const r = byRel(sum2.records, "a.md")!;
    expect(r.decision).toBe("deleted");
    expect(readLedger("bind-1", home).entries["a.md"]).toBeUndefined();
  });

  it("a clean scan that just runs again does not invent deletions", () => {
    writeFileSync(join(mem, "a.md"), projectFile("present"));
    collectOnce(binding, deps);
    const sum2 = collectOnce(binding, deps);
    expect(sum2.records.some((r) => r.decision === "deleted")).toBe(false);
  });

  it("syntheticSourceId is stable across passes (two worktrees -> one source)", () => {
    expect(syntheticSourceId("bind-1", "a.md")).toBe("_external/agent-auto-memory/bind-1/a.md");
  });

  it("isActionable omits the no-op decisions", () => {
    expect(isActionable("unchanged")).toBe(false);
    expect(isActionable("skipped")).toBe(false);
    expect(isActionable("eligible")).toBe(true);
    expect(isActionable("blocked")).toBe(true);
    expect(isActionable("deleted")).toBe(true);
    expect(isActionable("reclassified")).toBe(true);
    expect(isActionable("failed")).toBe(true);
  });
});
