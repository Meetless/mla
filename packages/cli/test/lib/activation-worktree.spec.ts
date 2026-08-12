import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findActivation } from "../../src/lib/activation";
import { findWorkspaceContext } from "../../src/lib/workspace";
import { resolveScanRootIdentity } from "../../src/commands/scan-context";
import { resolveActiveRuntimeScopeId } from "../../src/lib/rules/runtime-scope";

// D1 (notes/20260810-worktree-binding-loss-and-multi-repo-shared-workspace.md).
//
// A linked worktree of an activated repo resolved NO workspace, because binding
// resolution is a filesystem walk upward and `.meetless.json` is untracked, so
// `git worktree add` (tracked files only) cannot carry it. Reported by an
// external user whose agent went ungoverned inside an isolated recovery
// worktree while approving a policy change.
//
// Every worktree here is a REAL `git worktree add`, never a hand-built `.git`
// file: the whole defect lives in git's actual on-disk layout, and a fixture
// that fabricates it would pass against a resolver that reads it wrong.

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "seed.txt"), "x\n", "utf8");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "-qm", "seed"]); // worktree add needs a HEAD
}

function bindMarker(dir: string, workspaceId: string): void {
  writeFileSync(
    join(dir, ".meetless.json"),
    JSON.stringify({ workspaceId, workspaceName: "probe" }, null, 2),
    "utf8",
  );
}

describe("findActivation: a linked worktree inherits its origin checkout's binding", () => {
  let base: string;
  let main: string;
  let wt: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mla-wt-"));
    main = join(base, "main");
    wt = join(base, "wt");
    initRepo(main);
    git(main, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    // The premise, asserted rather than assumed: this IS a real linked worktree
    // (a `.git` FILE), and the marker genuinely did not come along.
    expect(statSync(join(wt, ".git")).isFile()).toBe(true);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("reproduces the defect precondition: `git worktree add` does not carry the marker", () => {
    bindMarker(main, "ws-origin");
    expect(existsSync(join(main, ".meetless.json"))).toBe(true);
    expect(existsSync(join(wt, ".meetless.json"))).toBe(false);
  });

  it("resolves the origin checkout's workspace from the worktree root", () => {
    bindMarker(main, "ws-origin");
    const found = findActivation(wt);
    expect(found?.workspaceId).toBe("ws-origin");
    // realpath both sides: git records the canonical /private/var path on macOS
    // while mkdtemp hands back /var, and they are the same directory.
    expect(realpathSync(found!.dir)).toBe(realpathSync(main));
    expect(found?.via).toBe("worktree");
  });

  it("resolves from a nested directory inside the worktree", () => {
    bindMarker(main, "ws-origin");
    const nested = join(wt, "packages", "deep", "inner");
    mkdirSync(nested, { recursive: true });
    const found = findActivation(nested);
    expect(found?.workspaceId).toBe("ws-origin");
    expect(found?.via).toBe("worktree");
  });

  it("surfaces the inherited binding through findWorkspaceContext", () => {
    bindMarker(main, "ws-origin");
    const ctx = findWorkspaceContext(wt);
    expect(ctx?.workspaceId).toBe("ws-origin");
    expect(ctx?.via).toBe("worktree");
    expect(realpathSync(ctx!.markerDir)).toBe(realpathSync(main));
  });

  it("stays unbound when the origin checkout is itself unbound", () => {
    // No marker anywhere. Inheritance must not invent a binding.
    expect(findActivation(wt)).toBeNull();
  });

  it("prefers a worktree-local marker over the inherited one (nearest-wins is unchanged)", () => {
    bindMarker(main, "ws-origin");
    bindMarker(wt, "ws-local");
    const found = findActivation(wt);
    expect(found?.workspaceId).toBe("ws-local");
    expect(found?.dir).toBe(wt);
    // A marker found by the ordinary walk is NOT an inherited resolution.
    expect(found?.via).toBeUndefined();
  });

  it("inherits a marker that sits ABOVE the origin checkout (umbrella binding)", () => {
    // The walk from the origin checkout is a full walk, not a single stat. The
    // worktree must live OUTSIDE the umbrella for this to prove anything, which
    // is also the realistic shape (an isolated recovery checkout in /tmp).
    const far = mkdtempSync(join(tmpdir(), "mla-wt-far-"));
    const farWt = join(far, "wt");
    try {
      git(main, ["worktree", "add", "-q", "--detach", farWt, "HEAD"]);
      bindMarker(base, "ws-umbrella");
      const found = findActivation(farWt);
      expect(found?.workspaceId).toBe("ws-umbrella");
      expect(found?.via).toBe("worktree");
    } finally {
      rmSync(far, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("inherits workspace binding ONLY: checkout identity stays the worktree's own", () => {
    bindMarker(main, "ws-origin");
    // The enforcement, attestation, interception and instruction-snapshot planes
    // all fence per checkout. Collapsing a worktree onto its origin would let a
    // worktree at an old commit retire the main checkout's snapshots.
    expect(resolveScanRootIdentity(wt)).not.toBe(resolveScanRootIdentity(main));
    expect(resolveActiveRuntimeScopeId(wt)).not.toBe(resolveActiveRuntimeScopeId(main));
    expect(resolveScanRootIdentity(wt)).toBe(require("fs").realpathSync(wt));
  });

  it("handles a RELATIVE gitdir pointer in the .git file", () => {
    bindMarker(main, "ws-origin");
    // git writes an absolute path; `git worktree repair` and hand-edited setups
    // can leave a relative one. Resolve it against the directory holding the file.
    const dotGit = join(wt, ".git");
    const abs = readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim();
    const rel = require("path").relative(wt, abs);
    writeFileSync(dotGit, `gitdir: ${rel}\n`, "utf8");
    expect(findActivation(wt)?.workspaceId).toBe("ws-origin");
  });

  it("stays unbound (never guesses) when the worktree metadata cannot be proven", () => {
    bindMarker(main, "ws-origin");
    // A `.git` FILE whose gitdir does not carry git's own worktree metadata is
    // not a linked worktree we can prove a relationship for. Fail visible.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(base, "nope")}\n`, "utf8");
    expect(findActivation(wt)).toBeNull();
  });

  it("stays unbound when the commondir back-pointer does not name this worktree", () => {
    bindMarker(main, "ws-origin");
    // Corrupt the bidirectional proof: git's `gitdir` back-pointer inside the
    // worktree's admin dir must name the `.git` file we started from.
    const admin = join(main, ".git", "worktrees", "wt");
    writeFileSync(join(admin, "gitdir"), join(base, "someone-else", ".git") + "\n", "utf8");
    expect(findActivation(wt)).toBeNull();
  });
});

describe("findActivation: the ordinary paths are untouched", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mla-wt-plain-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("an ordinary activated checkout resolves with no `via` stamp", () => {
    const repo = join(base, "repo");
    initRepo(repo);
    bindMarker(repo, "ws-plain");
    const found = findActivation(repo);
    expect(found?.workspaceId).toBe("ws-plain");
    expect(found?.via).toBeUndefined();
  });

  it("an ordinary unbound directory stays unbound", () => {
    const dir = join(base, "loose");
    mkdirSync(dir, { recursive: true });
    expect(findActivation(dir)).toBeNull();
  });

  it("an unbound NON-worktree git repo stays unbound", () => {
    const repo = join(base, "repo2");
    initRepo(repo);
    expect(findActivation(repo)).toBeNull();
  });

  it("does not read any .git entry when the ordinary walk succeeds (fast path)", () => {
    const repo = join(base, "repo3");
    initRepo(repo);
    bindMarker(repo, "ws-fast");
    const fs = require("fs");
    const realRead = fs.readFileSync;
    const gitReads: string[] = [];
    const spy = jest
      .spyOn(fs, "readFileSync")
      .mockImplementation((...args: unknown[]) => {
        const p = String(args[0]);
        if (p.endsWith(`${require("path").sep}.git`)) gitReads.push(p);
        return realRead(...(args as Parameters<typeof realRead>));
      });
    try {
      expect(findActivation(repo)?.workspaceId).toBe("ws-fast");
      expect(gitReads).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
