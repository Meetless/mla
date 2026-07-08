import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  enumerateEligibleFiles,
  MAX_FILE_BYTES,
} from "../../../src/lib/agent-memory-capture/containment";

describe("enumerateEligibleFiles (containment)", () => {
  let mem: string;
  let outside: string;

  beforeEach(() => {
    mem = mkdtempSync(join(tmpdir(), "amc-mem-"));
    outside = mkdtempSync(join(tmpdir(), "amc-out-"));
  });
  afterEach(() => {
    for (const d of [mem, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("enumerates direct .md children as complete", () => {
    writeFileSync(join(mem, "a.md"), "x");
    writeFileSync(join(mem, "b.md"), "yy");
    const { files, complete } = enumerateEligibleFiles(mem);
    expect(complete).toBe(true);
    expect(files.map((f) => f.relativePath).sort()).toEqual(["a.md", "b.md"]);
    expect(files.find((f) => f.relativePath === "b.md")?.bytes).toBe(2);
  });

  it("skips non-.md files and the MEMORY.md index (denylist, case-insensitive)", () => {
    writeFileSync(join(mem, "note.md"), "x");
    writeFileSync(join(mem, "readme.txt"), "x");
    writeFileSync(join(mem, "MEMORY.md"), "index");
    const { files } = enumerateEligibleFiles(mem);
    expect(files.map((f) => f.relativePath)).toEqual(["note.md"]);
  });

  it("ignores subdirectories (flat corpus, direct children only)", () => {
    writeFileSync(join(mem, "top.md"), "x");
    mkdirSync(join(mem, "nested"));
    writeFileSync(join(mem, "nested", "deep.md"), "x");
    const { files } = enumerateEligibleFiles(mem);
    expect(files.map((f) => f.relativePath)).toEqual(["top.md"]);
  });

  it("excludes a symlink that escapes the consented directory", () => {
    writeFileSync(join(outside, "secret.md"), "outside content");
    writeFileSync(join(mem, "real.md"), "inside");
    symlinkSync(join(outside, "secret.md"), join(mem, "escape.md"));
    const { files } = enumerateEligibleFiles(mem);
    expect(files.map((f) => f.relativePath)).toEqual(["real.md"]);
  });

  it("reports byte size from stat for an oversized file (caller decides failure)", () => {
    writeFileSync(join(mem, "big.md"), "z".repeat(MAX_FILE_BYTES + 100));
    const { files } = enumerateEligibleFiles(mem);
    const big = files.find((f) => f.relativePath === "big.md");
    expect(big?.bytes).toBe(MAX_FILE_BYTES + 100);
  });

  it("returns complete=false (and no files) for an unresolvable directory", () => {
    const res = enumerateEligibleFiles(join(mem, "ghost"));
    expect(res.complete).toBe(false);
    expect(res.files).toEqual([]);
  });
});
