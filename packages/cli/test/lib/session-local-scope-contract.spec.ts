import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

// The coverage contract of the session feed, settled and pinned.
//
// THE QUESTION. The 2026-08-06 audit found `session_local` serving nothing on a session
// with 18,961 transcript rows, and traced it to a feed whose touched-file half was empty
// because every path the session touched fell OUTSIDE the git root: the work was in
// `intel/` (a sibling repo), the notes vault, and a scratchpad. That reads like a bug, and
// the execution report filed it as "structurally starved". It is a BOUNDARY.
//
// THE CONTRACT, verified on a live machine rather than assumed. `.meetless.json` marks
// the workspace and `meetless_activated` walks UP from the hook's cwd taking the NEAREST
// one. On a machine laid out like this (paths genericized: this file ships to the public
// mirror, so it may not name a real operator or a real checkout):
//
//   /Users/alice/projects/acme/.meetless.json        umbrella, non-git binding
//   /Users/alice/projects/acme/app/.meetless.json    nested git-root binding
//   /Users/alice/projects/acme/intel/.meetless.json  sibling repo, own binding
//
// All three carry the SAME workspaceId, so they are one workspace, but nearest-wins means a
// session launched in `app/` resolves its activation root to `app/`, which is
// also its git top level. `collect_touched_files` scoping to the git top level is therefore
// exactly the activation boundary, not an accident of using git.
//
// So the answer is CURRENT ROOT ONLY, and a sibling repo's edits belong to that sibling's
// own activation root, which runs its own hook. Widening this would send paths from
// directories the operator activated separately, which is a consent question and not a
// defect to patch.
//
// WHAT IS ACTUALLY WRONG is the naming. `session_local` and `session_report` read as "the
// whole session", and the feed is one activation root's view of it. These pin the real
// contract so the next reader does not re-file the boundary as starvation, which is exactly
// what happened once already.

const COMMON = join(__dirname, "../../src/hooks-template/common.sh");

/** Run `collect_touched_files` out of the real common.sh against a seeded ledger. */
function collectTouched(opts: { cwd: string; touched: string[] }): string[] {
  const home = mkdtempSync(join(tmpdir(), "mla-scope-home-"));
  const queue = join(home, "queue");
  mkdirSync(queue, { recursive: true });
  const sid = "scope_probe";
  writeFileSync(join(queue, `${sid}.touched`), opts.touched.join("\n") + "\n");

  const out = execFileSync(
    "bash",
    [
      "-c",
      `set -a; MEETLESS_HOME="${home}"; source "${COMMON}" >/dev/null 2>&1; cd "${opts.cwd}" && collect_touched_files "${sid}" "${opts.cwd}"`,
    ],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: home, HOME: home } },
  );
  return JSON.parse(out.trim() || "[]");
}

/** An umbrella dir holding two sibling git repos, mirroring the real machine's layout. */
function umbrella(): { root: string; primary: string; sibling: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mla-umbrella-")));
  const primary = join(root, "primary");
  const sibling = join(root, "sibling");
  for (const d of [primary, sibling]) {
    mkdirSync(d, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, ".meetless.json"), JSON.stringify({ workspaceId: "ws_same" }));
  }
  writeFileSync(join(root, ".meetless.json"), JSON.stringify({ workspaceId: "ws_same" }));
  return { root, primary, sibling };
}

describe("the session feed covers ONE activation root", () => {
  it("reports files inside the current root, so the rest of this suite is not vacuous", () => {
    const { primary } = umbrella();

    const files = collectTouched({ cwd: primary, touched: [join(primary, "src/a.ts")] });

    expect(files).toEqual(["src/a.ts"]);
  });

  it("emits repo-relative paths, never absolute ones", () => {
    // The class of data on the wire. Whatever the scope decision, the feed has never sent
    // an absolute path, and widening the scope must not become the thing that does.
    const { primary } = umbrella();

    const files = collectTouched({ cwd: primary, touched: [join(primary, "src/a.ts")] });

    expect(files.every((f) => !f.startsWith("/"))).toBe(true);
  });

  it("drops a sibling repo's file, because that repo is its own activation root", () => {
    // NOT starvation. `sibling/.meetless.json` binds that directory separately and its own
    // hook reports its own work. Carrying it here would attribute one root's edits to
    // another and send paths from a directory this session never activated.
    const { primary, sibling } = umbrella();

    const files = collectTouched({
      cwd: primary,
      touched: [join(primary, "src/a.ts"), join(sibling, "app/b.py")],
    });

    expect(files).toEqual(["src/a.ts"]);
  });

  it("drops a path above the current root", () => {
    const { root, primary } = umbrella();

    const files = collectTouched({ cwd: primary, touched: [join(root, "notes/n.md")] });

    expect(files).toEqual([]);
  });

  it("reports an empty feed rather than a wrong one when ALL work was out of root", () => {
    // The exact live condition of session d629ac1c: every touched path outside the git
    // root, so the feed is legitimately empty. Empty is the correct answer here, and the
    // defect it exposed is that nothing SAYS the feed is root-scoped.
    const { primary, sibling } = umbrella();

    const files = collectTouched({ cwd: primary, touched: [join(sibling, "app/b.py")] });

    expect(files).toEqual([]);
  });
});
