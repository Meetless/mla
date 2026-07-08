import { extractExplicitPaths } from "../../../src/lib/scanner/prompt-paths";

// Explicit prompt-path extraction + containment (§4.7). The extractor feeds the scoped-rule
// matcher: a path it returns can promote a scoped MUST to REQUIRED, so containment (no `..`
// escape, no absolute-outside) is a security boundary, not a nicety. These assert the exact
// normalization contract and every rejection the spec calls out.

const REPO = "/Users/dev/projects/meetless";

describe("extractExplicitPaths — path shape", () => {
  it("keeps a directory-separated path and a bare filename with an extension", () => {
    expect(extractExplicitPaths("please edit apps/control/outbox.ts and README.md")).toEqual([
      "apps/control/outbox.ts",
      "README.md",
    ]);
  });

  it("ignores ordinary words with no separator and no extension", () => {
    expect(extractExplicitPaths("fix the control outbox please")).toEqual([]);
  });

  it("preserves a trailing slash so a directory token matches a `dir/**` glob", () => {
    // apps/control/ (with slash) is what matches apps/control/** in the shared matcher;
    // apps/control (no slash) would not, so the slash must survive normalization.
    expect(extractExplicitPaths("look under apps/control/")).toEqual(["apps/control/"]);
  });

  it("dedupes a path named twice, preserving first-seen order", () => {
    expect(extractExplicitPaths("touch a/b.ts then re-open a/b.ts and c/d.ts")).toEqual([
      "a/b.ts",
      "c/d.ts",
    ]);
  });
});

describe("extractExplicitPaths — prose punctuation stripping", () => {
  it("strips wrapping backticks and quotes", () => {
    expect(extractExplicitPaths("edit `src/x.ts` and \"src/y.ts\" and 'src/z.ts'")).toEqual([
      "src/x.ts",
      "src/y.ts",
      "src/z.ts",
    ]);
  });

  it("strips brackets, parens, and a trailing comma or period", () => {
    expect(extractExplicitPaths("(src/a.ts), [src/b.ts]. see src/c.ts,")).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("strips a :line and :line:col editor suffix", () => {
    expect(extractExplicitPaths("break at src/x.ts:42 and src/y.ts:10:3")).toEqual([
      "src/x.ts",
      "src/y.ts",
    ]);
  });

  it("collapses a leading ./ segment", () => {
    expect(extractExplicitPaths("edit ./src/x.ts")).toEqual(["src/x.ts"]);
  });
});

describe("extractExplicitPaths — containment (security boundary)", () => {
  it("rejects a ../ escape", () => {
    expect(extractExplicitPaths("open ../../outside/secret.ts")).toEqual([]);
  });

  it("rejects a lexical escape that normalizes above the root", () => {
    expect(extractExplicitPaths("open a/../../b.ts")).toEqual([]);
  });

  it("rejects an absolute path outside the repo", () => {
    expect(extractExplicitPaths("cat /etc/passwd", { repoRoot: REPO })).toEqual([]);
  });

  it("relativizes an absolute path inside the repo", () => {
    expect(
      extractExplicitPaths(`edit ${REPO}/apps/control/outbox.ts`, { repoRoot: REPO }),
    ).toEqual(["apps/control/outbox.ts"]);
  });

  it("drops an absolute path when no repoRoot is given (cannot prove containment)", () => {
    expect(extractExplicitPaths("/abs/whatever.ts")).toEqual([]);
  });

  it("rejects URL-like strings", () => {
    expect(
      extractExplicitPaths("see https://example.com/a.ts and file:///etc/x.ts and mailto:me@x.io"),
    ).toEqual([]);
  });
});

describe("extractExplicitPaths — edge cases", () => {
  it("returns [] for an empty or whitespace-only prompt", () => {
    expect(extractExplicitPaths("")).toEqual([]);
    expect(extractExplicitPaths("   \n\t ")).toEqual([]);
  });

  it("keeps a path with a multibyte segment (byte budgeting is downstream)", () => {
    expect(extractExplicitPaths("edit notes/ghi-chú.md")).toEqual(["notes/ghi-chú.md"]);
  });

  it("does not treat a bare dot or double-dot token as a path", () => {
    expect(extractExplicitPaths("run it in . or ..")).toEqual([]);
  });
});
