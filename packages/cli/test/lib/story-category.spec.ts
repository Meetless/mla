import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Governed-story §5.3 / acceptance #24: storyCategory is stamped at CAPTURE so
// the console NEVER re-parses argv or a file path in React to decide what to
// show. The session-detail body renders the agent's `mla` CLI commands and the
// markdown it touched; it HIDES generic bash and non-prose file ops. Two pure
// classifiers in common.sh own that decision:
//
//   story_category_for_command -> "mla_cli" | "other"
//   story_category_for_path    -> "markdown" | "other"
//
// This spec pins both by sourcing common.sh and calling them directly, so a
// future edit to the argv/path grammar can never silently change which rows the
// timeline keeps.

const COMMON = path.resolve(__dirname, "../../src/hooks-template/common.sh");

// Source common.sh in a throwaway home and invoke ONE shell function with ONE
// arg. common.sh runs `set -euo pipefail` and a top-level `mkdir -p $QUEUE_DIR`
// at source time, so MEETLESS_HOME is pinned to a temp dir the call cleans up.
function callFn(fn: string, arg: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-story-"));
  try {
    const r = spawnSync(
      "bash",
      ["-c", `source "$1"; ${fn} "$2"`, "_", COMMON, arg],
      {
        encoding: "utf8",
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
        timeout: 5000,
      },
    );
    if (r.status !== 0) {
      throw new Error(`bash exited ${r.status}: ${r.stderr}`);
    }
    return (r.stdout ?? "").trim();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const cmd = (c: string) => callFn("story_category_for_command", c);
const pathCat = (p: string) => callFn("story_category_for_path", p);

describe("story_category_for_command", () => {
  beforeAll(() => {
    expect(fs.existsSync(COMMON)).toBe(true);
  });

  it("classifies a bare mla invocation as mla_cli", () => {
    expect(cmd("mla ask 'what is the diff'")).toBe("mla_cli");
    expect(cmd("mla")).toBe("mla_cli");
  });

  it("skips a leading ENV=VAL assignment before the command word", () => {
    expect(cmd("FOO=bar mla flush")).toBe("mla_cli");
  });

  it("skips MULTIPLE leading env assignments", () => {
    expect(cmd("A=1 B=2 mla doctor")).toBe("mla_cli");
  });

  it("strips an absolute path prefix from the command word", () => {
    expect(cmd("/usr/local/bin/mla activate")).toBe("mla_cli");
  });

  it("strips a relative path prefix from the command word", () => {
    expect(cmd("./mla login")).toBe("mla_cli");
  });

  it("does NOT match a bare `mla` substring inside an argument", () => {
    // The first real command word alone decides; `mla` as an arg never matches.
    expect(cmd("echo mla")).toBe("other");
    expect(cmd("cat notes/mla.md")).toBe("other");
    expect(cmd('git commit -m "update mla"')).toBe("other");
  });

  it("does NOT match a command that merely starts with the letters mla", () => {
    expect(cmd("mlathing --run")).toBe("other");
  });

  it("classifies an empty command as other", () => {
    expect(cmd("")).toBe("other");
  });

  it("classifies an ordinary shell command as other", () => {
    expect(cmd("pnpm test")).toBe("other");
    expect(cmd("ls -la")).toBe("other");
  });
});

describe("story_category_for_path", () => {
  it("classifies prose extensions as markdown", () => {
    expect(pathCat("notes/20260627-design.md")).toBe("markdown");
    expect(pathCat("README.markdown")).toBe("markdown");
    expect(pathCat("docs/spec.mdx")).toBe("markdown");
    expect(pathCat("docs/spec.rst")).toBe("markdown");
    expect(pathCat("docs/spec.txt")).toBe("markdown");
    expect(pathCat("docs/spec.adoc")).toBe("markdown");
  });

  it("classifies code and other non-prose paths as other", () => {
    expect(pathCat("apps/control/src/service.ts")).toBe("other");
    expect(pathCat("package.json")).toBe("other");
    expect(pathCat("Makefile")).toBe("other");
  });

  it("denylists vendored / build trees even for a .md path", () => {
    expect(pathCat("node_modules/pkg/README.md")).toBe("other");
    expect(pathCat("dist/notes.md")).toBe("other");
    expect(pathCat(".next/x.md")).toBe("other");
  });

  it("denylists eval / fixture / testdata prose (corpus, never knowledge)", () => {
    expect(pathCat("intel/evals/corpus/sample.md")).toBe("other");
    expect(pathCat("test/__fixtures__/doc.md")).toBe("other");
    expect(pathCat("pkg/testdata/note.md")).toBe("other");
  });

  it("keeps a doc merely NAMED like an eval (directory-segment match only)", () => {
    // The denylist matches a directory SEGMENT, not a substring of the filename.
    expect(pathCat("notes/20260627-eval-results.md")).toBe("markdown");
  });
});
