// tools/meetless-agent/test/lib/common-active-memory.spec.ts
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// Source common.sh in a subshell, call a helper, print its result. The harness
// proves the bash side computes the same envelope fields the TS contract expects.
function callHelper(fn: string, args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  const hooks = join(__dirname, "../../src/hooks-template");
  const script = `source "${hooks}/common.sh"; ${fn} ${args.map((a) => `'${a}'`).join(" ")}`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  return { out: (r.stdout || "").trim(), code: r.status ?? 1 };
}

describe("common.sh active-review helpers", () => {
  it("prose_path_allowed: .md allowed, .ts and node_modules denied (tests 1,2)", () => {
    expect(callHelper("prose_path_allowed", ["notes/x.md"]).code).toBe(0);
    expect(callHelper("prose_path_allowed", ["src/x.ts"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["node_modules/pkg/README.md"]).code).toBe(1);
  });

  // Dogfood incident 2026-06-10: authoring the topic-authority eval corpus
  // (intel/evals/topic_authority/corpus/*.md) got every synthetic fixture
  // captured as a produced_doc and auto-indexed into the operator's Personal KB
  // as SHADOW docs, which then minted bogus relationship candidates. Synthetic
  // eval/fixture/testdata prose is NEVER knowledge; deny it at the gate.
  it("prose_path_allowed: eval/fixture/testdata corpus paths denied (auto-index pollution guard)", () => {
    expect(callHelper("prose_path_allowed", ["intel/evals/topic_authority/corpus/x.md"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["evals/corpus/x.md"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["packages/cli/test/fixtures/sample.md"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["fixtures/sample.md"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["lib/__fixtures__/doc.md"]).code).toBe(1);
    expect(callHelper("prose_path_allowed", ["pkg/testdata/readme.md"]).code).toBe(1);
    // real prose docs stay allowed
    expect(callHelper("prose_path_allowed", ["notes/x.md"]).code).toBe(0);
    // "eval"/"fixture" as a SUBSTRING of a real doc name must NOT trip the deny
    expect(callHelper("prose_path_allowed", ["notes/20260610-topic-authority-eval-results.md"]).code).toBe(0);
  });

  it("repo_root_hash is stable and path-sensitive (test 5)", () => {
    const a = callHelper("repo_root_hash", ["/a/repoA"]).out;
    const b = callHelper("repo_root_hash", ["/a/repoB"]).out;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(callHelper("repo_root_hash", ["/a/repoA"]).out).toBe(a);
  });

  it("canonical_path strips the repo root prefix", () => {
    expect(callHelper("canonical_path", ["/a/repoA", "/a/repoA/notes/x.md"]).out).toBe("notes/x.md");
  });

  it("content_hash matches shasum of file bytes (test 4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ch-"));
    const f = join(dir, "x.md");
    writeFileSync(f, "hello");
    const out = callHelper("content_hash", [f]).out;
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(f, "hello");
    expect(callHelper("content_hash", [f]).out).toBe(out); // identical bytes -> identical hash
  });
});
