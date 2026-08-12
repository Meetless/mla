// I7: the shared-tree floor rule taught the spelling that caused the incident.
//
// THE RULE, as it stood until 2026-08-12 (backend rule cmexample0000000000000031,
// TEAM/MUST_FOLLOW, delivered into every agent prompt on this machine):
//
//     "Never `git add -A` and never a bare `git commit`; scope every commit with
//      `git commit -m msg -- <paths>` and read `git diff -- <those exact paths>` first"
//
// That MUST names the one spelling that DISCARDS a prepared index. On session 5e8a7182
// it swept 109 lines of a peer's uncommitted work into a commit while the agent was
// following the rule as written, and it had already fired twice on 2026-08-10, an hour
// apart, on a single file.
//
// THIS SUITE IS NOT A STRING MATCH ON THE RULE TEXT. The floor projection
// (.claude/rules/meetless-mla-floor.generated.md) is gitignored and generated per
// machine from the backend rule store, so asserting over it would be asserting over
// whatever the last `mla scan` happened to write. What is pinned here is the GIT
// BEHAVIOUR the corrected rule rests on, against real git, in a throwaway repo:
//
//   (a) isolated index + commit with NO pathspec  -> commits exactly what was staged,
//       and a concurrent session's working-tree edits stay uncommitted.
//   (b) `git commit -m msg -- <paths>`            -> DISCARDS the isolated index and
//       commits the WORKING TREE for those paths, peer edits and all.
//
// (b) is the falsifiable half and the reason the rule changed. If a future edit puts the
// pathspec spelling back into the floor rule, this file is the counter-evidence: the
// claim "path scoping bounds the commit" is false, and here is the repo where it fails.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repos: string[] = [];

afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  repos.length = 0;
});

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  }).trim();
}

/**
 * A checkout in the state a shared tree is always in: my file edited, and a PEER's file
 * edited by another session that has not committed yet.
 */
function sharedTree(): { repo: string; index: string } {
  const repo = mkdtempSync(join(tmpdir(), "mla-sharedtree-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "mine.txt"), "base\n");
  writeFileSync(join(repo, "peer.txt"), "base\n");
  git(repo, ["add", "mine.txt", "peer.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);

  writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
  writeFileSync(join(repo, "peer.txt"), "base\na peer's uncommitted work\n");
  return { repo, index: join(repo, ".git", "mla-isolated-index") };
}

/** Stage ONLY `paths` into an index file that is not the shared one. */
function isolate(repo: string, index: string, paths: string[]): void {
  git(repo, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
  git(repo, ["update-index", "--add", "--", ...paths], { GIT_INDEX_FILE: index });
}

function filesIn(repo: string, ref = "HEAD"): string[] {
  const out = git(repo, ["show", "--pretty=format:", "--name-only", ref]);
  return out.split("\n").filter((l) => l.trim().length > 0).sort();
}

describe("I7: how a commit is scoped on a tree ten sessions share", () => {
  it("VALID: an isolated index committed with NO pathspec takes exactly what was staged", () => {
    const { repo, index } = sharedTree();
    isolate(repo, index, ["mine.txt"]);

    // commit-tree, not `git commit`: the point is that no pathspec is involved at all.
    // read-tree and the write are ADJACENT, because an isolated index is a SNAPSHOT and
    // HEAD moves between two tool calls on a tree this busy.
    const tree = git(repo, ["write-tree"], { GIT_INDEX_FILE: index });
    const parent = git(repo, ["rev-parse", "HEAD"]);
    expect(tree).not.toBe(git(repo, ["rev-parse", `${parent}^{tree}`])); // never an empty commit
    const sha = git(repo, ["commit-tree", tree, "-p", parent, "-m", "mine only"]);
    git(repo, ["update-ref", "HEAD", sha, parent]);

    expect(filesIn(repo)).toEqual(["mine.txt"]);
    // ...and the peer still has their work, uncommitted, exactly where they left it.
    expect(git(repo, ["status", "--porcelain", "--", "peer.txt"])).toContain("peer.txt");
    expect(readFileSync(join(repo, "peer.txt"), "utf8")).toContain("a peer's uncommitted work");
  });

  it("FORBIDDEN: a commit pathspec DISCARDS the isolated index and takes the working tree", () => {
    const { repo, index } = sharedTree();
    isolate(repo, index, ["mine.txt"]);

    // The old MUST, spelled exactly as it was delivered. The isolated index is prepared
    // and then handed to a command that does not read it.
    git(repo, ["commit", "-q", "-m", "scoped, supposedly", "--", "mine.txt", "peer.txt"], { GIT_INDEX_FILE: index });

    // Both files land. The pathspec bounded WHICH FILES were committed and said nothing
    // about WHOSE CHANGES inside them, which is the sentence the corrected rule now
    // carries and the old one did not.
    expect(filesIn(repo)).toEqual(["mine.txt", "peer.txt"]);
    expect(git(repo, ["show", "HEAD:peer.txt"])).toContain("a peer's uncommitted work");
  });

  it("FORBIDDEN: even a pathspec naming ONLY my file commits the working tree, not the index", () => {
    // The subtler case, and the one that actually fired: the pathspec names only my
    // path, so it LOOKS scoped. It still bypasses the index, so anything a peer has
    // edited inside MY file ships under my message.
    const { repo, index } = sharedTree();
    isolate(repo, index, ["mine.txt"]);
    // A peer edits the same file after I staged it. My index holds my version; the
    // working tree holds mine plus theirs.
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\na peer's line in my file\n");

    git(repo, ["commit", "-q", "-m", "mine only, supposedly", "--", "mine.txt"], { GIT_INDEX_FILE: index });

    expect(git(repo, ["show", "HEAD:mine.txt"])).toContain("a peer's line in my file");
  });

  it("FORBIDDEN: a bare commit against the SHARED index takes whatever anyone staged", () => {
    // The other half of the rule, which the correction must not lose. "Commit the
    // isolated index with no pathspec" and "never a bare commit" are only compatible
    // because the first one is not `git commit` at all.
    const { repo } = sharedTree();
    git(repo, ["add", "peer.txt"]); // a concurrent session stages its own work
    writeFileSync(join(repo, "mine.txt"), "base\nmy change\n");
    git(repo, ["add", "mine.txt"]);

    git(repo, ["commit", "-q", "-m", "bare"]);

    expect(filesIn(repo)).toEqual(["mine.txt", "peer.txt"]);
  });

  it("the isolated index leaves the SHARED index ARMED TO REVERT the commit", () => {
    // Why the corrected procedure ends with `git reset -- <paths>`, and it is not
    // tidiness. `update-index` on a private index file does not touch the shared one, so
    // whatever was staged there BEFORE the commit survives it -- and it is now an OLDER
    // version of the same file. The next bare commit anyone runs on this tree stages that
    // older version over mine, silently undoing what I just landed.
    const { repo, index } = sharedTree();
    // An earlier version of my file, staged in the SHARED index (a habit, or an earlier
    // step of my own work).
    writeFileSync(join(repo, "mine.txt"), "base\nan OLDER version\n");
    git(repo, ["add", "mine.txt"]);
    // ...then the work continues in the working tree and THAT is what I commit.
    writeFileSync(join(repo, "mine.txt"), "base\nthe version I am shipping\n");
    isolate(repo, index, ["mine.txt"]);
    const tree = git(repo, ["write-tree"], { GIT_INDEX_FILE: index });
    const parent = git(repo, ["rev-parse", "HEAD"]);
    const sha = git(repo, ["commit-tree", tree, "-p", parent, "-m", "mine only"]);
    git(repo, ["update-ref", "HEAD", sha, parent]);
    expect(git(repo, ["show", "HEAD:mine.txt"])).toContain("the version I am shipping");

    // THE HAZARD, measured: the shared index is staged to put the older version back.
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("mine.txt");
    expect(git(repo, ["diff", "--cached"])).toContain("an OLDER version");

    // The disarm, which is why it is unconditional rather than conditional on noticing.
    git(repo, ["reset", "-q", "--", "mine.txt"]);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });
});
