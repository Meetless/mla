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
    rmSync(mem, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
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

// --- The "453 files" line was noise, and noise is not a control ----------------
//
// `mla agent-memory report` printed one undifferentiated count: "Project files with
// a secret signal (observe-only): 453". Measured over the real 876-file corpus it
// was 866 files, 98.9%, and 856 of those matched ONLY `high_entropy_token`. An
// operator who reads that number twice learns to stop reading it.
//
// The scanner's precision fix (document identifiers no longer clear the generic
// entropy bar) took the real corpus from 98.9% to 92.8%. It cannot go further
// without exempting bare lowercase word-joins, which is the PHRASE relaxation this
// repo already measured and rejected in redactor.ts, so the rest is fixed HERE,
// where it is a presentation problem rather than a detection one.
//
// An EXPLICIT hit (a provider prefix, a JWT, a Redis directive, a credential-named
// env assignment) names the credential family it found and is worth a human's time.
// A generic entropy-only hit says "this file contains a long opaque string", which
// in a corpus of governed notes is almost always a document identifier. They are
// different claims and they are now counted separately.
describe("the secret-signal report separates a named finding from a shrug", () => {
  let mem: string;
  beforeEach(() => {
    mem = mkdtempSync(join(tmpdir(), "amrep-split-"));
  });
  afterEach(() => {
    rmSync(mem, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("splits explicit-rule hits from entropy-only hits", () => {
    writeFileSync(join(mem, "named.md"), projectFile("redis: requirepass O3o7j8zX"));
    writeFileSync(
      join(mem, "opaque.md"),
      projectFile("see AbCdEf0123456789AbCdEf0123456789AbCdEfGh for context"),
    );
    writeFileSync(join(mem, "clean.md"), projectFile("nothing notable"));

    const rep = analyzeCorpus(mem);

    const explicit = rep.secretSignalFiles.filter((f) => f.ruleIds.some((r) => r !== "high_entropy_token"));
    const entropyOnly = rep.secretSignalFiles.filter((f) => f.ruleIds.every((r) => r === "high_entropy_token"));

    expect(explicit.map((f) => f.file)).toEqual(["named.md"]);
    expect(entropyOnly.map((f) => f.file)).toEqual(["opaque.md"]);
    // Both are still reported. Nothing is hidden; they are just no longer one number.
    expect(rep.secretSignalFiles).toHaveLength(2);
    expect(rep.namedSecretSignalFiles.map((f) => f.file)).toEqual(["named.md"]);
    expect(rep.entropyOnlySignalFiles.map((f) => f.file)).toEqual(["opaque.md"]);
  });

  it("does not flag a corpus of ordinary governed notes at all", () => {
    // The exact shapes that produced the 98.9%: wiki links, dated note paths and
    // long snake_case slugs carrying an extension.
    writeFileSync(
      join(mem, "typical.md"),
      projectFile(
        "See [[reference_a_ttl_column_and_a_cleanup_method_are_claims_not_enforcement]] and\n" +
          "notes/20260805-mla-router-abstention-and-raw-prompt-at-rest.md and\n" +
          "[trap](reference_identifier_boost_ranks_the_doc_that_names_the_thing.md).",
      ),
    );
    const rep = analyzeCorpus(mem);
    expect(rep.secretSignalFiles).toEqual([]);
  });
});
