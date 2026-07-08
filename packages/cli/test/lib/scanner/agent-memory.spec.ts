// test/lib/scanner/agent-memory.spec.ts
//
// The agent auto-memory (~/.claude/projects/<enc>/memory/) is where past Claude Code
// sessions have written the rules the user taught them. It is NOT git-tracked, so the
// `git ls-files` scan structurally misses it. This module discovers it so the cold-start
// scan can surface those rules. Trust gate: everything here is machine_inferred (untracked,
// per-machine, agent-distilled), so it can NEVER earn must-follow; it rides advisory until
// a human attests. The scanner keeps it OUT of the auto-injected confirmed-rules pack.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentMemoryDir,
  readAgentMemoryFiles,
  parseAgentMemoryDirectives,
  discoverAgentMemoryDirectives,
  collectAgentMemoryFiles,
  claudeCodeProvider,
  DEFAULT_AGENT_MEMORY_PROVIDERS,
  type AgentMemoryProvider,
  type MemoryFile,
} from "../../../src/lib/scanner/agent-memory";

describe("agentMemoryDir", () => {
  it("encodes cwd slashes and dots as dashes under <home>/.claude/projects/<enc>/memory", () => {
    expect(agentMemoryDir("/Users/dev/projects/acme/webapp", "/home")).toBe(
      "/home/.claude/projects/-Users-dev-projects-acme-webapp/memory",
    );
    // Dots in the path are encoded too, matching Claude Code's projects-dir scheme.
    expect(agentMemoryDir("/a/b.c", "/h")).toBe("/h/.claude/projects/-a-b-c/memory");
  });
});

describe("readAgentMemoryFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mla-mem-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fails open to [] when the dir is missing", () => {
    expect(readAgentMemoryFiles(join(dir, "nope"))).toEqual([]);
  });

  it("reads only feedback_*.md, sorted, ignoring the index, project/reference files, and non-markdown", () => {
    writeFileSync(join(dir, "feedback_b.md"), "b");
    writeFileSync(join(dir, "feedback_a.md"), "a");
    writeFileSync(join(dir, "MEMORY.md"), "index");
    writeFileSync(join(dir, "project_x.md"), "x");
    writeFileSync(join(dir, "reference_y.md"), "y");
    writeFileSync(join(dir, "feedback_c.txt"), "c");
    const files = readAgentMemoryFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["feedback_a.md", "feedback_b.md"]);
    expect(files.map((f) => f.text)).toEqual(["a", "b"]);
  });
});

describe("parseAgentMemoryDirectives", () => {
  const fb = (name: string, description: string, body = "x"): MemoryFile => ({
    name,
    text: `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: feedback\n---\n${body}\n`,
  });

  it("emits one machine_inferred RULE per feedback file from the frontmatter description", () => {
    const dirs = parseAgentMemoryDirectives([fb("feedback_main.md", "Commit directly on main; never branch")]);
    expect(dirs).toHaveLength(1);
    const d = dirs[0];
    expect(d.text).toBe("Commit directly on main; never branch");
    expect(d.source).toBe("agent-memory:feedback_main.md");
    expect(d.kind).toBe("RULE");
    // Untracked, per-machine, agent-distilled => never must-follow (render.ts gates on this).
    expect(d.attestation).toBe("machine_inferred");
  });

  it("marks a description with a shouted modal MUST_FOLLOW, otherwise SHOULD_FOLLOW", () => {
    const [must] = parseAgentMemoryDirectives([fb("feedback_x.md", "NEVER push without asking")]);
    const [should] = parseAgentMemoryDirectives([fb("feedback_y.md", "prefer pnpm over npm")]);
    expect(must.strength).toBe("MUST_FOLLOW");
    expect(should.strength).toBe("SHOULD_FOLLOW");
  });

  it("skips files with no description and dedupes identical descriptions", () => {
    const noDesc: MemoryFile = { name: "feedback_z.md", text: "---\nname: z\n---\nbody\n" };
    const dirs = parseAgentMemoryDirectives([
      fb("feedback_a.md", "same rule"),
      fb("feedback_b.md", "same rule"),
      noDesc,
    ]);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].text).toBe("same rule");
  });
});

describe("discoverAgentMemoryDirectives", () => {
  let home: string;
  const cwd = "/work/proj";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-home-"));
    mkdirSync(agentMemoryDir(cwd, home), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("discovers + parses feedback memory under the encoded dir, respecting the cap", () => {
    const dir = agentMemoryDir(cwd, home);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `feedback_${i}.md`), `---\ndescription: rule ${i}\n---\nx\n`);
    }
    expect(discoverAgentMemoryDirectives(cwd, home).length).toBe(5);
    expect(discoverAgentMemoryDirectives(cwd, home, 2).length).toBe(2);
  });

  it("fails open to [] when no agent memory exists for the workspace", () => {
    expect(discoverAgentMemoryDirectives("/no/such/work", home)).toEqual([]);
  });

  // The default cap is a pathological-directory guard, not a curation limit: a realistic
  // feedback corpus (tens to low-hundreds of files, e.g. the dogfood repo's ~55) must
  // surface in FULL, not be silently truncated. 120 distinct rules all come through.
  it("surfaces a realistic large feedback corpus in full under the default cap", () => {
    const dir = agentMemoryDir(cwd, home);
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(dir, `feedback_${String(i).padStart(3, "0")}.md`), `---\ndescription: rule ${i}\n---\nx\n`);
    }
    expect(discoverAgentMemoryDirectives(cwd, home).length).toBe(120);
  });
});

// The provider seam (memo Phase 2): the Claude path convention is one adapter, not the
// workspace identity. Discovery searches the active path AND the canonical root, dedupes by
// content, and a new tool is a new provider rather than a change to discovery or the scanner.
describe("agent-memory provider adapter", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const write = (dir: string, name: string, description: string, body = "x") => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `---\ndescription: ${description}\n---\n${body}\n`);
  };

  it("ships exactly the Claude Code provider by default, keying off its own path convention", () => {
    expect(DEFAULT_AGENT_MEMORY_PROVIDERS).toEqual([claudeCodeProvider]);
    expect(claudeCodeProvider.name).toBe("claude-code");
    expect(claudeCodeProvider.memoryDirs("/work/proj", "/home")).toEqual([
      agentMemoryDir("/work/proj", "/home"),
    ]);
  });

  it("tags every collected file with its provider and absolute source path", () => {
    const cwd = "/work/proj";
    const dir = agentMemoryDir(cwd, home);
    write(dir, "feedback_a.md", "rule a");
    const [file] = collectAgentMemoryFiles(cwd, home);
    expect(file.provider).toBe("claude-code");
    expect(file.sourcePath).toBe(join(dir, "feedback_a.md"));
  });

  it("searches the canonical root too, so memory written from a nested dir is not missed", () => {
    const root = "/work/proj";
    const nested = "/work/proj/services/api"; // a different encoded dir, with no memory of its own
    write(agentMemoryDir(root, home), "feedback_root.md", "root rule");
    // cwd (nested) has nothing; only the canonical root carries the memory.
    expect(discoverAgentMemoryDirectives(nested, home).length).toBe(0);
    const dirs = discoverAgentMemoryDirectives(nested, home, undefined, { canonicalRoot: root });
    expect(dirs.map((d) => d.text)).toEqual(["root rule"]);
  });

  it("dedupes identical content found under two search paths down to a single entry", () => {
    const root = "/work/proj";
    const nested = "/work/proj/web";
    // The SAME memory file content exists under both encoded dirs (repo opened at both paths).
    write(agentMemoryDir(root, home), "feedback_dup.md", "shared rule");
    write(agentMemoryDir(nested, home), "feedback_dup.md", "shared rule");
    const files = collectAgentMemoryFiles(nested, home, { canonicalRoot: root });
    expect(files).toHaveLength(1);
    // First search path (cwd = nested) wins the provenance.
    expect(files[0].sourcePath).toBe(join(agentMemoryDir(nested, home), "feedback_dup.md"));
  });

  it("merges genuinely distinct memory across both paths", () => {
    const root = "/work/proj";
    const nested = "/work/proj/web";
    write(agentMemoryDir(root, home), "feedback_root.md", "root rule");
    write(agentMemoryDir(nested, home), "feedback_web.md", "web rule");
    const dirs = discoverAgentMemoryDirectives(nested, home, undefined, { canonicalRoot: root });
    expect(dirs.map((d) => d.text).sort()).toEqual(["root rule", "web rule"]);
  });

  it("collapses cwd and an equal canonical root to a single search (no double count)", () => {
    const cwd = "/work/proj";
    write(agentMemoryDir(cwd, home), "feedback_a.md", "rule a");
    const files = collectAgentMemoryFiles(cwd, home, { canonicalRoot: cwd });
    expect(files).toHaveLength(1);
  });

  it("accepts a custom provider so a non-Claude memory layout is discoverable without touching discovery", () => {
    // A fake tool that keeps memory at <home>/.mytool/<basename>/mem.
    const myProvider: AgentMemoryProvider = {
      name: "mytool",
      memoryDirs: (searchPath, h) => [join(h, ".mytool", searchPath.replace(/\//g, "_"), "mem")],
    };
    const cwd = "/work/proj";
    write(join(home, ".mytool", "_work_proj", "mem"), "feedback_x.md", "mytool rule");
    const files = collectAgentMemoryFiles(cwd, home, { providers: [myProvider] });
    expect(files).toHaveLength(1);
    expect(files[0].provider).toBe("mytool");
    // The default Claude provider would have found nothing here.
    expect(collectAgentMemoryFiles(cwd, home)).toHaveLength(0);
  });
});
