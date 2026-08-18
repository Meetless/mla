// `scripts/scoped-commit.sh`: the two destructive states, made impossible rather than forbidden.
//
// `shared-tree-commit-scoping.spec.ts` pins the git BEHAVIOUR the floor rule rests on,
// including the two failure modes that fired on 2026-08-10:
//
//   1. an isolated index seeded with `read-tree HEAD`, a slow verification, then
//      `commit-tree -p HEAD` -> the STALE tree is parented onto the NEW tip and every
//      peer commit that landed in the window is reverted. Six files, one commit.
//   2. the repair loop's `update-index --cacheinfo` on a path the clobber had DELETED
//      -> hard error, loop aborts, and the "repair" commits an index identical to the
//      one it was fixing.
//
// The rule was already correct when both fired. This file grades the tooling instead:
// every test below drives the real script against real git, in the state that broke it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "..", "scripts", "scoped-commit.sh");

const repos: string[] = [];

afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  repos.length = 0;
});

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...ENV, ...env } }).trim();
}

/**
 * Run the script under test. Returns stdout AND stderr; throws on a non-zero exit.
 *
 * The merge is load-bearing: every progress line the script emits about a race goes to
 * stderr, and a first cut of this helper returned stdout only, so the rebuild assertion
 * below failed against a script that had rebuilt correctly.
 */
function scoped(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", `bash "$0" "$@" 2>&1`, SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...ENV, ...env },
  }).trim();
}

/**
 * Run it expecting a NON-ZERO exit, and return what it printed.
 *
 * `toThrow(/text/)` matches the Error MESSAGE, and execFileSync puts the child's output
 * on `.stdout`/`.stderr` rather than in the message, so a refusal test written that way
 * passes on any failure at all, including the script not existing.
 */
function scopedFails(repo: string, args: string[], env: Record<string, string> = {}): string {
  try {
    scoped(repo, args, env);
  } catch (e) {
    const err = e as { stdout?: string | Buffer; status?: number };
    expect(err.status).not.toBe(0);
    return String(err.stdout ?? "").trim();
  }
  throw new Error("expected scoped-commit.sh to exit non-zero and it succeeded");
}

function tree(): string {
  const repo = mkdtempSync(join(tmpdir(), "mla-scoped-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "mine.txt"), "base\n");
  writeFileSync(join(repo, "peer.txt"), "base\n");
  git(repo, ["add", "mine.txt", "peer.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function filesIn(repo: string, ref = "HEAD"): string[] {
  return git(repo, ["show", "--pretty=format:", "--name-only", ref])
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .sort();
}

/**
 * A peer commit that lands DURING the script's own run.
 *
 * The script never runs `git commit`, so there is no hook seam. The window is opened
 * with a `git` wrapper on PATH that fires exactly once, on the script's first
 * `read-tree`, and then gets out of the way so the rebuild can converge.
 *
 * `read-tree` and not `rev-parse` ON PURPOSE. The script captures `BASE` with a
 * `rev-parse HEAD` and then stages; racing the rev-parse itself would only mean BASE
 * is already the new tip, which is correct but exercises nothing. Racing the
 * read-tree puts the peer commit INSIDE the staging window, which is the exact shape
 * of the incident and the only thing that drives the rebuild branch.
 */
function peerRacesDuringStaging(repo: string): string {
  const bin = join(repo, ".git", "racebin");
  mkdirSync(bin, { recursive: true });
  const flag = join(repo, ".git", "raced");
  // Only the FIRST read-tree triggers it, so the script's rebuild attempt sees a
  // stable HEAD and converges instead of spinning to the retry cap.
  writeFileSync(
    join(bin, "git"),
    [
      "#!/usr/bin/env bash",
      `REAL=$(which -a git | grep -v '${bin}' | head -1)`,
      'if [[ "$1" == "read-tree" ]]; then',
      `  if [[ ! -f '${flag}' ]]; then`,
      `    touch '${flag}'`,
      `    printf 'a peer LANDED fix\\n' >> '${join(repo, "peer.txt")}'`,
      `    "$REAL" -C '${repo}' add peer.txt >/dev/null 2>&1`,
      `    "$REAL" -C '${repo}' commit -q -m 'peer: landed mid-run' >/dev/null 2>&1`,
      "  fi",
      "fi",
      'exec "$REAL" "$@"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  return bin;
}

describe("scoped-commit.sh: what it commits", () => {
  it("takes my paths and leaves a peer's uncommitted work alone", () => {
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
    writeFileSync(join(repo, "peer.txt"), "base\na peer's uncommitted work\n");

    scoped(repo, ["-m", "mine only", "--", "mine.txt"]);

    expect(filesIn(repo)).toEqual(["mine.txt"]);
    expect(readFileSync(join(repo, "peer.txt"), "utf8")).toContain("a peer's uncommitted work");
    expect(git(repo, ["status", "--porcelain", "--", "peer.txt"])).toContain("peer.txt");
  });

  it("commits a NEW file, which is the shape plain --cacheinfo cannot stage", () => {
    const repo = tree();
    mkdirSync(join(repo, "notes"));
    writeFileSync(join(repo, "notes", "20260816-x.md"), "new\n");

    scoped(repo, ["-m", "add a note", "--", "notes/20260816-x.md"]);

    expect(filesIn(repo)).toEqual(["notes/20260816-x.md"]);
  });

  it("commits a DELETION, which needs --force-remove and not --add", () => {
    const repo = tree();
    unlinkSync(join(repo, "mine.txt"));

    scoped(repo, ["-m", "drop it", "--", "mine.txt"]);

    expect(filesIn(repo)).toEqual(["mine.txt"]);
    expect(() => git(repo, ["cat-file", "-e", "HEAD:mine.txt"])).toThrow();
    // ...and the peer's file is untouched by the deletion.
    expect(git(repo, ["cat-file", "-e", "HEAD:peer.txt"])).toBe("");
  });

  it("reads the message from a file, so a backtick in it is never command-substituted", () => {
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
    const msg = join(repo, "msg.txt");
    writeFileSync(msg, "fix(x): the `governed_query` field nothing read\n");

    scoped(repo, ["-F", msg, "--", "mine.txt"]);

    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("fix(x): the `governed_query` field nothing read");
  });

  it("leaves the SHARED index disarmed, so the next bare commit cannot revert this one", () => {
    const repo = tree();
    // An older version staged in the shared index, the hazard `git reset` exists for.
    writeFileSync(join(repo, "mine.txt"), "base\nan OLDER version\n");
    git(repo, ["add", "mine.txt"]);
    writeFileSync(join(repo, "mine.txt"), "base\nthe version I am shipping\n");

    scoped(repo, ["-m", "mine only", "--", "mine.txt"]);

    expect(git(repo, ["show", "HEAD:mine.txt"])).toContain("the version I am shipping");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("refuses a run that would stage nothing rather than making an empty commit", () => {
    const repo = tree();
    expect(scopedFails(repo, ["-m", "nothing changed", "--", "mine.txt"])).toContain("nothing to commit");
    // ...and it left no commit behind.
    expect(git(repo, ["log", "--format=%s"])).toBe("base");
  });
});

describe("scoped-commit.sh: the mixed file a peer is editing too", () => {
  it("stages MY content and leaves the peer's hunk in the working tree", () => {
    // The hardest case on this tree and the one no pathspec can solve. Both of us are
    // editing `mine.txt`; only my change may ship.
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\na peer's uncommitted hunk in MY file\n");
    // What I intend: HEAD's version with only my hunk applied. Built by hand, because
    // deciding which hunk is whose is a judgement no tool can make.
    const intended = join(repo, ".git", "intended-mine.txt");
    writeFileSync(intended, "base\nmy change\n");

    scoped(repo, ["-m", "mine only", "--blob", `mine.txt=${intended}`, "--", "mine.txt"]);

    expect(git(repo, ["show", "HEAD:mine.txt"])).toBe("base\nmy change");
    expect(git(repo, ["show", "HEAD:mine.txt"])).not.toContain("a peer's uncommitted hunk");
    // ...and the peer still has their line, on disk, uncommitted.
    expect(readFileSync(join(repo, "mine.txt"), "utf8")).toContain("a peer's uncommitted hunk");
  });

  it("refuses a --blob whose content file does not exist rather than staging the worktree", () => {
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\nand a peer's\n");
    const out = scopedFails(repo, ["-m", "x", "--blob", "mine.txt=/nope/missing.txt", "--", "mine.txt"]);
    expect(out).toContain("no such blob content file");
    expect(git(repo, ["log", "--format=%s"])).toBe("base");
  });

  it("keeps every HEAD-race guarantee while a blob is in play", () => {
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\na peer's hunk\n");
    const intended = join(repo, ".git", "intended-mine.txt");
    writeFileSync(intended, "base\nmy change\n");
    const bin = peerRacesDuringStaging(repo);

    scoped(repo, ["-m", "mine only", "--blob", `mine.txt=${intended}`, "--", "mine.txt"], {
      PATH: `${bin}:${process.env.PATH}`,
    });

    expect(git(repo, ["show", "HEAD:peer.txt"])).toContain("a peer LANDED fix");
    expect(git(repo, ["show", "HEAD:mine.txt"])).toBe("base\nmy change");
    const parent = git(repo, ["rev-parse", "HEAD^"]);
    expect(git(repo, ["diff", "--name-only", parent, "HEAD"]).split("\n").filter(Boolean)).toEqual(["mine.txt"]);
  });
});

describe("scoped-commit.sh: HEAD moving underneath it", () => {

  it("rebuilds from the new tip instead of reverting the peer commit", () => {
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
    const bin = peerRacesDuringStaging(repo);

    const out = scoped(repo, ["-m", "mine only", "--", "mine.txt"], { PATH: `${bin}:${process.env.PATH}` });

    // The peer commit landed inside the run and SURVIVED it. Under the hand procedure
    // this is the commit that reverted six files.
    expect(git(repo, ["show", "HEAD:peer.txt"])).toContain("a peer LANDED fix");
    expect(filesIn(repo)).toEqual(["mine.txt"]);
    expect(git(repo, ["show", "HEAD:mine.txt"])).toContain("my change");
    expect(out).toMatch(/HEAD moved|lost the update-ref race/);
    // Both commits are on the branch, in order, neither undoing the other.
    expect(git(repo, ["log", "--format=%s", "-2"]).split("\n")).toEqual(["mine only", "peer: landed mid-run"]);
  });

  it("never parents a tree onto a commit it was not built from", () => {
    // The invariant, stated directly: whatever HEAD the run ends on, the commit's
    // parent tree plus my paths IS the commit. Nothing else moved.
    const repo = tree();
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
    const bin = peerRacesDuringStaging(repo);

    scoped(repo, ["-m", "mine only", "--", "mine.txt"], { PATH: `${bin}:${process.env.PATH}` });

    const parent = git(repo, ["rev-parse", "HEAD^"]);
    const changed = git(repo, ["diff", "--name-only", parent, "HEAD"]).split("\n").filter(Boolean);
    expect(changed).toEqual(["mine.txt"]);
  });
});
