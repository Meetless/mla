import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { analyzeCorpus } from "../../../src/lib/agent-memory-capture/report";

function projectFile(body: string): string {
  return `---\nname: x\nmetadata:\n  type: project\n---\n${body}\n`;
}
function userFile(): string {
  return `---\nname: x\nmetadata:\n  type: user\n---\nbody\n`;
}

describe("analyzeCorpus (Phase 0A static value gate)", () => {
  let mem: string;

  beforeEach(() => {
    mem = mkdtempSync(join(tmpdir(), "amrep-"));
  });
  afterEach(() => {
    rmSync(mem, { recursive: true, force: true });
  });

  it("counts files by type and reports a size distribution", () => {
    writeFileSync(join(mem, "p1.md"), projectFile("a durable claim"));
    writeFileSync(join(mem, "p2.md"), projectFile("another claim"));
    writeFileSync(join(mem, "u1.md"), userFile());
    writeFileSync(join(mem, "MEMORY.md"), "# index\n- one\n");

    const rep = analyzeCorpus(mem);
    expect(rep.exists).toBe(true);
    expect(rep.totalMdFiles).toBe(4);
    expect(rep.byType.project).toBe(2);
    expect(rep.byType.user).toBe(1);
    expect(rep.byType.none).toBe(1); // MEMORY.md has no frontmatter
    expect(rep.sizeBytes.max).toBeGreaterThanOrEqual(rep.sizeBytes.min);
    expect(rep.manualGates.length).toBeGreaterThan(0);
  });

  it("reports a project file with a secret signal (observe-only) and passes the credential probe", () => {
    writeFileSync(join(mem, "clean.md"), projectFile("nothing secret here"));
    writeFileSync(join(mem, "leak.md"), projectFile("redis: requirepass O3o7j8zX"));

    const rep = analyzeCorpus(mem);
    const flagged = rep.secretSignalFiles.map((b) => b.file);
    expect(flagged).toContain("leak.md");
    expect(flagged).not.toContain("clean.md");
    // The fixture token IS caught by the scanner, so the probe has no misses.
    expect(rep.credentialProbeMisses).toEqual([]);
    expect(rep.credentialProbePass).toBe(true);
  });

  it("counts a malformed file distinctly from a typed one", () => {
    writeFileSync(join(mem, "bad.md"), "---\nname: x\ntype: project\nunterminated\n");
    const rep = analyzeCorpus(mem);
    expect(rep.byType.malformed).toBe(1);
    expect(rep.malformedFiles).toBe(1);
  });

  it("returns an exists=false report for a missing directory (sends nothing)", () => {
    const rep = analyzeCorpus(join(mem, "ghost"));
    expect(rep.exists).toBe(false);
    expect(rep.totalMdFiles).toBe(0);
    expect(rep.credentialProbePass).toBe(true);
  });
});
