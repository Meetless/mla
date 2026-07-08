import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  writeProjectRules,
  PROJECT_RULES_FILENAME,
  MEETLESS_RULES_BEGIN,
  MEETLESS_RULES_END,
} from "../../src/lib/wire";

// IN (notes/20260603-mla-kb-agent-proxy §7.2 backlog "IN"; §6 #3; NT:20260526 §12):
// `mla init` writes a Project rules file into a foreign repo as onboarding
// hygiene (NOT enforcement). The file states the consult-governed-memory-first
// expectation so an agent landing in the repo knows to pull the raw evidence
// tools (`meetless__retrieve_knowledge` + `meetless__kb_doc_detail`) before
// grepping for concepts, with `meetless__query` as the synthesis convenience.
// This block must agree with the per-turn grounding pack (which leads with the
// same evidence tools and demotes query); a divergence here is the steering
// contradiction this contract guards against. The design is explicit that a
// rules file is necessary and not sufficient (this very repo proves it), so the
// contract here is narrow:
//   - idempotent (re-running init never duplicates the block),
//   - non-clobbering (operator's own rules survive byte-for-byte),
//   - replace-in-place (a stale Meetless block is refreshed, not appended-to).
// These tests lock that contract against a tmp repo root.

function mkTmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-rules-"));
}

function read(root: string): string {
  return fs.readFileSync(path.join(root, PROJECT_RULES_FILENAME), "utf8");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("writeProjectRules IN (foreign-repo onboarding rules)", () => {
  let root: string;
  beforeEach(() => {
    root = mkTmpRepo();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates CLAUDE.md with the Meetless rules block when none exists", () => {
    const res = writeProjectRules(root);
    expect(res.action).toBe("created");
    expect(res.path).toBe(path.join(root, PROJECT_RULES_FILENAME));
    const body = read(root);
    expect(body).toContain(MEETLESS_RULES_BEGIN);
    expect(body).toContain(MEETLESS_RULES_END);
  });

  it("states the consult-governed-memory-first expectation, leading with the evidence tools", () => {
    writeProjectRules(root);
    const body = read(root).toLowerCase();
    // Primary door is the raw-evidence retrieval tool (matches the grounding pack).
    expect(body).toContain("meetless__retrieve_knowledge");
    // query is still named, but as the synthesis convenience, not the headline.
    expect(body).toContain("meetless__query");
    // The retrieval tool must be introduced BEFORE query, not the other way round.
    expect(body.indexOf("meetless__retrieve_knowledge")).toBeLessThan(
      body.indexOf("meetless__query"),
    );
    // The expectation: consult governed memory before grepping for concepts.
    expect(body).toMatch(/before you (grep|search)/);
    expect(body).toContain("mcp");
  });

  it("frames the file as onboarding hygiene, not enforcement", () => {
    writeProjectRules(root);
    const body = read(root).toLowerCase();
    expect(body).toContain("not enforcement");
  });

  it("is idempotent: re-running leaves the file byte-identical and the block appears once", () => {
    const first = writeProjectRules(root);
    expect(first.action).toBe("created");
    const afterFirst = read(root);

    const second = writeProjectRules(root);
    expect(second.action).toBe("unchanged");
    const afterSecond = read(root);

    expect(afterSecond).toBe(afterFirst);
    expect(occurrences(afterSecond, MEETLESS_RULES_BEGIN)).toBe(1);
    expect(occurrences(afterSecond, MEETLESS_RULES_END)).toBe(1);
  });

  it("preserves an operator's pre-existing CLAUDE.md content (non-clobbering append)", () => {
    const ownRules = "# My Project Rules\n\nAlways run the linter before committing.\n";
    fs.writeFileSync(path.join(root, PROJECT_RULES_FILENAME), ownRules, "utf8");

    const res = writeProjectRules(root);
    expect(res.action).toBe("updated");

    const body = read(root);
    expect(body).toContain("# My Project Rules");
    expect(body).toContain("Always run the linter before committing.");
    expect(body).toContain(MEETLESS_RULES_BEGIN);
    // The operator's content comes first; the Meetless block is appended after.
    expect(body.indexOf("My Project Rules")).toBeLessThan(body.indexOf(MEETLESS_RULES_BEGIN));
  });

  it("replaces a stale Meetless block in place rather than appending a second one", () => {
    const stale = [
      "# My Project Rules",
      "",
      MEETLESS_RULES_BEGIN,
      "OLD STALE MEETLESS TEXT that should be gone",
      MEETLESS_RULES_END,
      "",
      "## Operator footer kept below",
    ].join("\n");
    fs.writeFileSync(path.join(root, PROJECT_RULES_FILENAME), stale, "utf8");

    const res = writeProjectRules(root);
    expect(res.action).toBe("updated");

    const body = read(root);
    expect(body).not.toContain("OLD STALE MEETLESS TEXT");
    expect(body).toContain("meetless__retrieve_knowledge");
    // Operator content on BOTH sides of the block survives.
    expect(body).toContain("# My Project Rules");
    expect(body).toContain("## Operator footer kept below");
    // Still exactly one managed block.
    expect(occurrences(body, MEETLESS_RULES_BEGIN)).toBe(1);
    expect(occurrences(body, MEETLESS_RULES_END)).toBe(1);
  });

  it("never re-running collapses an already-current operator file to unchanged", () => {
    const ownRules = "# Mine\n";
    fs.writeFileSync(path.join(root, PROJECT_RULES_FILENAME), ownRules, "utf8");
    expect(writeProjectRules(root).action).toBe("updated");
    expect(writeProjectRules(root).action).toBe("unchanged");
  });

  it("uses no em-dash or prose double-dash in the rules prose (house style)", () => {
    writeProjectRules(root);
    const body = read(root);
    // Inspect only the prose BETWEEN the markers. The HTML comment delimiters
    // (`<!--` / `-->`) legitimately contain "--" as required comment syntax;
    // they are not prose double-dashes, so exclude the marker lines.
    const innerStart = body.indexOf(MEETLESS_RULES_BEGIN) + MEETLESS_RULES_BEGIN.length;
    const innerEnd = body.indexOf(MEETLESS_RULES_END);
    const prose = body.slice(innerStart, innerEnd);
    expect(prose).not.toContain("—"); // em dash
    expect(prose).not.toContain("–"); // en dash
    expect(prose).not.toContain("--"); // prose double-dash
  });
});
