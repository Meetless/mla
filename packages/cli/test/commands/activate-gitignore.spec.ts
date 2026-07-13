// test/commands/activate-gitignore.spec.ts
//
// Regression net for a bug that shipped: `mla activate` used to DELETE the
// `.meetless.json` line out of the repo's `.gitignore` (a tracked file) and call
// it a "stale entry", then print "untracked and not gitignored" as if that were
// an observation rather than something it had just forced to be true. It ran on
// this very monorepo, whose .gitignore ignores the marker on purpose with a
// hand-written banner above the line. The CLI must READ the repo's answer and
// never write to the user's .gitignore.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { commitGuidanceLines, isMarkerGitignored } from "../../src/commands/activate";

function gitRepo(gitignore?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-gitignore-"));
  // -c flags: a bare `git init` inherits the runner's global config, and a
  // global core.excludesfile could otherwise decide the outcome for us.
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  if (gitignore !== undefined) {
    fs.writeFileSync(path.join(dir, ".gitignore"), gitignore, "utf8");
  }
  return dir;
}

describe("isMarkerGitignored", () => {
  it("reports true when the repo ignores the marker", () => {
    const dir = gitRepo("node_modules\n.meetless.json\n");
    expect(isMarkerGitignored(dir)).toBe(true);
  });

  it("reports false when the repo does not ignore the marker", () => {
    const dir = gitRepo("node_modules\n");
    expect(isMarkerGitignored(dir)).toBe(false);
  });

  it("reports false with no .gitignore at all", () => {
    const dir = gitRepo();
    expect(isMarkerGitignored(dir)).toBe(false);
  });

  it("reports false outside a Git repo instead of throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nogit-"));
    expect(isMarkerGitignored(dir)).toBe(false);
  });

  it("sees .git/info/exclude, which a scan of .gitignore alone would miss", () => {
    const dir = gitRepo("node_modules\n");
    fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), ".meetless.json\n", "utf8");
    expect(isMarkerGitignored(dir)).toBe(true);
  });

  it("NEVER writes to the user's .gitignore", () => {
    const body = [
      "# Per-machine dogfood workspace binding, never commit",
      ".meetless.json",
      "",
    ].join("\n");
    const dir = gitRepo(body);
    const gi = path.join(dir, ".gitignore");

    isMarkerGitignored(dir);
    commitGuidanceLines(dir);

    // Byte-for-byte: the old code stripped the entry and orphaned the comment.
    expect(fs.readFileSync(gi, "utf8")).toBe(body);
  });
});

describe("commitGuidanceLines", () => {
  it("tells the truth when the repo ignores the marker", () => {
    const text = commitGuidanceLines(gitRepo(".meetless.json\n")).join("\n");
    expect(text).toContain("ignores .meetless.json");
    expect(text).toContain("local to your clone");
    // The claim that shipped false. It must not appear when it is not true.
    expect(text).not.toContain("not gitignored");
  });

  it("tells the truth when the repo does not ignore the marker", () => {
    const text = commitGuidanceLines(gitRepo("node_modules\n")).join("\n");
    expect(text).toContain("untracked and not gitignored");
    expect(text).toContain("Commit it to share this workspace binding");
  });

  it("promises no secrets either way, because the marker carries none", () => {
    expect(commitGuidanceLines(gitRepo(".meetless.json\n")).join("\n")).toContain("no secrets");
    expect(commitGuidanceLines(gitRepo("")).join("\n")).toContain("no secrets");
  });
});
