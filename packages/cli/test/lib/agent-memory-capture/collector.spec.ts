import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runDryRunCollector } from "../../../src/lib/agent-memory-capture/collector";
import { enableBinding, disableBinding } from "../../../src/lib/agent-memory-capture/binding";
import { acquireBindingLock } from "../../../src/lib/agent-memory-capture/lock";
import { decisionLogPath } from "../../../src/lib/agent-memory-capture/paths";

const NOW = "2026-06-27T00:00:00.000Z";

function projectFile(body: string): string {
  return `---\nname: x\nmetadata:\n  type: project\n---\n${body}\n`;
}

function enable(home: string, mem: string): string {
  const out = enableBinding(mem, "ws-1", NOW, home);
  if (!out.ok) throw new Error("enable failed: " + out.reason);
  return out.binding.bindingId;
}

describe("runDryRunCollector", () => {
  let home: string;
  let mem: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "amcol-home-"));
    mem = mkdtempSync(join(tmpdir(), "amcol-mem-"));
  });
  afterEach(() => {
    for (const d of [home, mem]) rmSync(d, { recursive: true, force: true });
  });

  it("returns empty when no bindings are enabled", () => {
    expect(runDryRunCollector({ nowIso: NOW, home })).toEqual([]);
  });

  it("appends only actionable decisions to a metadata-only JSONL", () => {
    const id = enable(home, mem);
    writeFileSync(join(mem, "a.md"), projectFile("durable claim"));

    const [res] = runDryRunCollector({ nowIso: NOW, home });
    expect(res.locked).toBe(true);
    expect(res.appended).toBe(1);

    const log = decisionLogPath(id, home);
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.decision).toBe("eligible");
    expect(rec.relativePath).toBe("a.md");
    // metadata-only: a hash, never raw content
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rec)).not.toContain("durable claim");
  });

  it("does not append unchanged no-ops on a repeat pass", () => {
    const id = enable(home, mem);
    writeFileSync(join(mem, "a.md"), projectFile("same body"));
    runDryRunCollector({ nowIso: NOW, home });
    const before = readFileSync(decisionLogPath(id, home), "utf8");
    runDryRunCollector({ nowIso: NOW, home });
    const after = readFileSync(decisionLogPath(id, home), "utf8");
    expect(after).toBe(before); // unchanged -> nothing appended
  });

  it("skips a binding whose lock is held by a live collector", () => {
    const id = enable(home, mem);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    const held = acquireBindingLock(id, NOW, home);
    expect(held).not.toBeNull();
    try {
      const [res] = runDryRunCollector({ nowIso: NOW, home });
      expect(res.locked).toBe(false);
      expect(res.summary).toBeNull();
      expect(res.appended).toBe(0);
      expect(existsSync(decisionLogPath(id, home))).toBe(false);
    } finally {
      held!.release();
    }
  });

  it("processes a disabled binding by skipping it entirely", () => {
    enable(home, mem);
    writeFileSync(join(mem, "a.md"), projectFile("body"));
    // a second, disabled directory should not appear
    const mem2 = mkdtempSync(join(tmpdir(), "amcol-mem2-"));
    try {
      const out = enableBinding(mem2, "ws-1", NOW, home);
      expect(out.ok).toBe(true);
      disableBinding(mem2, home); // present in store but not enabled
      const results = runDryRunCollector({ nowIso: NOW, home });
      expect(results).toHaveLength(1); // only the enabled binding
    } finally {
      rmSync(mem2, { recursive: true, force: true });
    }
  });
});
