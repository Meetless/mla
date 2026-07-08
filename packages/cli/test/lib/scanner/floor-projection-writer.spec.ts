// Phase 1 coverage-matrix tests for the IO writer. Uses REAL temp directories and REAL
// git repos (no fs/git mocks): the whole point of these rows is the on-disk + version-
// control behavior. Each test names the matrix-doc row it pins.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeFloorProjection,
  removeOwnedProjection,
} from "../../../src/lib/scanner/floor-projection-writer";
import { FLOOR_PROJECTION_RELPATH } from "../../../src/lib/scanner/floor-projection";
import { Directive, FloorMeta } from "../../../src/lib/scanner/types";
import { resolveProjectionOutcome, resolveScanRoot } from "../../../src/commands/scan-context";

const floor = (over: Partial<Directive> = {}): Directive => ({
  id: "abc",
  text: "Work directly on main.",
  source: "rule-bundle",
  kind: "RULE",
  strength: "MUST_FOLLOW",
  attestation: "human_attested",
  ...over,
});

const DIRS_A = [floor({ text: "Notes vault is /notes." }), floor({ text: "Never over-engineer." })];
const DIRS_B = [floor({ text: "Notes vault is /notes." }), floor({ text: "A brand new rule." })];

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    // Deterministic identity so `git commit` never fails on an unconfigured CI box.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function initGit(root: string): void {
  git(root, ["init", "-q"]);
}

function targetPath(root: string): string {
  return join(root, FLOOR_PROJECTION_RELPATH);
}

function excludeContent(root: string): string {
  const p = join(root, ".git", "info", "exclude");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("materializeFloorProjection", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mla-proj-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("row 'no floor rules': writes nothing and reports unchanged/no_floor_rules", () => {
    const r = materializeFloorProjection(root, [], "rev-1");
    expect(r.projection).toBe("unchanged");
    expect(r.reason).toBe("no_floor_rules");
    expect(existsSync(targetPath(root))).toBe(false);
  });

  it("row 'fresh write': materializes an owned projection under .claude/rules", () => {
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("written");
    const content = readFileSync(targetPath(root), "utf8");
    expect(content.startsWith("<!-- meetless-mla-floor-projection")).toBe(true);
    expect(content).toContain("- Notes vault is /notes.");
    expect(content).toContain("- Never over-engineer.");
  });

  it("rows 'existing CLAUDE.md / MEMORY.md / unrelated file': siblings are byte-identical after write", () => {
    const claude = join(root, "CLAUDE.md");
    const memory = join(root, "MEMORY.md");
    const other = join(root, ".claude", "rules", "user-owned.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(claude, "# project rules\n- do X\n", "utf8");
    writeFileSync(memory, "# memory\n- recall Y\n", "utf8");
    writeFileSync(other, "# my own rule file\n- keep me\n", "utf8");

    materializeFloorProjection(root, DIRS_A, "rev-1");

    expect(readFileSync(claude, "utf8")).toBe("# project rules\n- do X\n");
    expect(readFileSync(memory, "utf8")).toBe("# memory\n- recall Y\n");
    expect(readFileSync(other, "utf8")).toBe("# my own rule file\n- keep me\n");
    expect(existsSync(targetPath(root))).toBe(true); // our own file still landed
  });

  it("row 'same hash → no rewrite': second materialize is unchanged and leaves content identical", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    const before = readFileSync(targetPath(root), "utf8");
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("unchanged");
    expect(r.reason).toBe("same_hash");
    expect(readFileSync(targetPath(root), "utf8")).toBe(before);
  });

  it("row 'same hash across bundleId churn': stable body still means no rewrite", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    const before = readFileSync(targetPath(root), "utf8");
    // A new bundle revision that carries the SAME floor rules must not rewrite the file.
    const r = materializeFloorProjection(root, DIRS_A, "rev-2");
    expect(r.projection).toBe("unchanged");
    expect(r.reason).toBe("same_hash");
    expect(readFileSync(targetPath(root), "utf8")).toBe(before);
  });

  it("row 'newer hash → atomic replacement': a changed floor set overwrites the owned file", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    const r = materializeFloorProjection(root, DIRS_B, "rev-2");
    expect(r.projection).toBe("written");
    const content = readFileSync(targetPath(root), "utf8");
    expect(content).toContain("- A brand new rule.");
    expect(content).not.toContain("- Never over-engineer.");
  });

  it("row 'foreign file exists → refuse': a non-MLA file is left byte-identical, reports blocked/foreign_file", () => {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(targetPath(root), "# a real user file\n- untouchable\n", "utf8");
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("blocked");
    expect(r.reason).toBe("foreign_file");
    expect(readFileSync(targetPath(root), "utf8")).toBe("# a real user file\n- untouchable\n");
  });

  it("row 'edited body → refuse overwrite': a hand-edited MLA file is left intact, reports blocked/edited", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    const edited = readFileSync(targetPath(root), "utf8").replace(
      "- Never over-engineer.",
      "- Never over-engineer. AND ALSO ship fast.",
    );
    writeFileSync(targetPath(root), edited, "utf8");
    const r = materializeFloorProjection(root, DIRS_B, "rev-2"); // even a newer bundle must not clobber
    expect(r.projection).toBe("blocked");
    expect(r.reason).toBe("edited");
    expect(readFileSync(targetPath(root), "utf8")).toBe(edited);
  });

  it("row 'tracked path → refuse': a git-tracked target is left intact, reports blocked/path_tracked", () => {
    initGit(root);
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(targetPath(root), "# committed by the user\n", "utf8");
    git(root, ["add", "--", FLOOR_PROJECTION_RELPATH]);
    git(root, ["commit", "-q", "-m", "user commits the path"]);
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("blocked");
    expect(r.reason).toBe("path_tracked");
    expect(readFileSync(targetPath(root), "utf8")).toBe("# committed by the user\n");
  });

  it("row 'git repo → info/exclude': writing adds a repo-local exclude, never a .gitignore", () => {
    initGit(root);
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("written");
    expect(excludeContent(root)).toContain(`/${FLOOR_PROJECTION_RELPATH}`);
    // Never touches the user's tracked .gitignore.
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("info/exclude is idempotent: a second write does not duplicate the pattern", () => {
    initGit(root);
    materializeFloorProjection(root, DIRS_A, "rev-1");
    materializeFloorProjection(root, DIRS_B, "rev-2"); // rewrite (new content)
    const excl = excludeContent(root);
    const pattern = `/${FLOOR_PROJECTION_RELPATH}`;
    expect(excl.split("\n").filter((l) => l.trim() === pattern)).toHaveLength(1);
    // The temp-sibling glob is also excluded exactly once, so a crash-orphaned
    // `<file>.tmp-<pid>` never shows up in `git status`.
    const tmpGlob = `/${FLOOR_PROJECTION_RELPATH}.tmp-*`;
    expect(excl.split("\n").filter((l) => l.trim() === tmpGlob)).toHaveLength(1);
  });

  it("row 'non-git dir → still materialized': writes the file with no .git present", () => {
    const r = materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(r.projection).toBe("written");
    expect(existsSync(targetPath(root))).toBe(true);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });

  it("row 'worktree = current checkout only': writes strictly under the given scanRoot", () => {
    // The writer confines every write to `${scanRoot}/.claude/rules/...`; there is no
    // cross-checkout fan-out. (resolveScanRoot picking the nearest marker is covered by
    // scan-context.spec.ts.) A sibling checkout dir must stay empty.
    const sibling = mkdtempSync(join(tmpdir(), "mla-proj-sib-"));
    try {
      materializeFloorProjection(root, DIRS_A, "rev-1");
      expect(existsSync(targetPath(root))).toBe(true);
      expect(existsSync(join(sibling, ".claude"))).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("row 'worktree = current checkout only' (real `git worktree add`): resolveScanRoot picks the worktree marker, the projection lands strictly in that checkout, and the exclude lands in the SHARED common-dir info/exclude", () => {
    // The end-to-end proof the unit rows above deliberately stub out. A real linked worktree
    // has a `.git` FILE (not a dir), and `git rev-parse --git-path info/exclude` from it
    // resolves to the SHARED common dir <main>/.git/info/exclude (info/ is not per-worktree).
    // This pins matrix Open Confirmation #1: a session entering a subdir of a worktree
    // materializes lazily in THAT checkout only (no fan-out into the main checkout), and the
    // git-invisibility still comes from the exclude, never a .gitignore.
    initGit(root);
    writeFileSync(join(root, "seed.txt"), "x\n", "utf8");
    git(root, ["add", "seed.txt"]);
    git(root, ["commit", "-qm", "seed"]); // worktree add needs a HEAD to check out

    const wtParent = mkdtempSync(join(tmpdir(), "mla-proj-wtpar-"));
    const wt = join(wtParent, "wt"); // must not exist yet; git creates it
    try {
      git(root, ["worktree", "add", "-q", wt]);
      expect(statSync(join(wt, ".git")).isFile()).toBe(true); // real linked worktree

      // Both checkouts are bound to the SAME workspace identity (marker is per-checkout,
      // untracked, so a fresh worktree is independently activated to the same id).
      const marker = JSON.stringify({ workspaceId: "ws-shared" });
      writeFileSync(join(root, ".meetless.json"), marker, "utf8");
      writeFileSync(join(wt, ".meetless.json"), marker, "utf8");

      // Enter a package subdir of the worktree; the scan root must resolve to the worktree.
      const sub = join(wt, "packages", "x");
      mkdirSync(sub, { recursive: true });
      const scanRoot = resolveScanRoot(sub);
      const r = materializeFloorProjection(scanRoot, DIRS_A, "rev-1");
      expect(r.projection).toBe("written");

      // Lands in the worktree checkout (owned)...
      expect(existsSync(targetPath(wt))).toBe(true);
      expect(readFileSync(targetPath(wt), "utf8").startsWith("<!-- meetless-mla-floor-projection")).toBe(true);
      // ...and NOT in the main checkout: materializing for one worktree never fans out.
      expect(existsSync(join(root, ".claude"))).toBe(false);

      // The exclude lands in the SHARED common-dir info/exclude (resolved from the worktree),
      // and neither checkout gets a .gitignore.
      const sharedExclude = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
        cwd: wt,
        encoding: "utf8",
      }).trim();
      expect(readFileSync(sharedExclude, "utf8")).toContain(`/${FLOOR_PROJECTION_RELPATH}`);
      expect(existsSync(join(wt, ".gitignore"))).toBe(false);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    } finally {
      rmSync(wtParent, { recursive: true, force: true });
    }
  });
});

describe("removeOwnedProjection (matrix: deactivation removes only owned)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mla-proj-rm-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("row 'deactivation → remove owned': removes an MLA-owned projection", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    expect(existsSync(targetPath(root))).toBe(true);
    const r = removeOwnedProjection(root);
    expect(r.removed).toBe(true);
    expect(existsSync(targetPath(root))).toBe(false);
  });

  it("row 'deactivation → keep foreign': a non-MLA file is left intact", () => {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(targetPath(root), "# user's own file\n", "utf8");
    const r = removeOwnedProjection(root);
    expect(r.removed).toBe(false);
    expect(r.reason).toBe("foreign_file");
    expect(readFileSync(targetPath(root), "utf8")).toBe("# user's own file\n");
  });

  it("row 'deactivation → keep edited': a hand-edited MLA file is left intact (delete refused)", () => {
    materializeFloorProjection(root, DIRS_A, "rev-1");
    const edited = readFileSync(targetPath(root), "utf8").replace("/notes.", "/somewhere-else.");
    writeFileSync(targetPath(root), edited, "utf8");
    const r = removeOwnedProjection(root);
    expect(r.removed).toBe(false);
    expect(r.reason).toBe("edited");
    expect(readFileSync(targetPath(root), "utf8")).toBe(edited);
  });

  it("reports absent when there is nothing to remove", () => {
    const r = removeOwnedProjection(root);
    expect(r.removed).toBe(false);
    expect(r.reason).toBe("absent");
  });
});

describe("resolveProjectionOutcome (revoked-floor vs transient-empty disambiguation)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mla-proj-outcome-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const meta = (freshness: FloorMeta["freshness"]): FloorMeta => ({
    bundleId: "rev-7",
    bundleHash: null,
    freshness,
  });

  it("fresh bundle + zero directives REVOKES an owned projection (tears the file down)", () => {
    materializeFloorProjection(root, DIRS_A, "rev-6");
    expect(existsSync(targetPath(root))).toBe(true);
    const out = resolveProjectionOutcome(root, [], meta("fresh"));
    expect(out).toEqual({ projection: "removed", reason: "revoked" });
    expect(existsSync(targetPath(root))).toBe(false);
  });

  it("MISSING bundle (unavailable) + zero directives LEAVES the last-known-good projection intact", () => {
    materializeFloorProjection(root, DIRS_A, "rev-6");
    const before = readFileSync(targetPath(root), "utf8");
    // A transient empty read is indistinguishable from bundle-unavailable, so the floor must
    // survive: the writer's no_floor_rules path is taken, never a removal.
    const out = resolveProjectionOutcome(root, [], meta("missing"));
    expect(out.projection).toBe("unchanged");
    expect(out.reason).toBe("no_floor_rules");
    expect(readFileSync(targetPath(root), "utf8")).toBe(before);
  });

  it("STALE bundle + zero directives also LEAVES the projection (only fresh revokes)", () => {
    materializeFloorProjection(root, DIRS_A, "rev-6");
    const out = resolveProjectionOutcome(root, [], meta("stale"));
    expect(out.projection).toBe("unchanged");
    expect(out.reason).toBe("no_floor_rules");
    expect(existsSync(targetPath(root))).toBe(true);
  });

  it("fresh bundle + zero directives with NOTHING owned reports unchanged/absent (no phantom removal)", () => {
    const out = resolveProjectionOutcome(root, [], meta("fresh"));
    expect(out).toEqual({ projection: "unchanged", reason: "absent" });
    expect(existsSync(targetPath(root))).toBe(false);
  });

  it("fresh bundle + a FOREIGN file at the target reports blocked (never deletes a non-MLA file)", () => {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(targetPath(root), "# user's own file\n", "utf8");
    const out = resolveProjectionOutcome(root, [], meta("fresh"));
    expect(out.projection).toBe("blocked");
    expect(out.reason).toBe("foreign_file");
    expect(readFileSync(targetPath(root), "utf8")).toBe("# user's own file\n");
  });

  it("non-empty directives always materialize (writes the projection regardless of freshness)", () => {
    const out = resolveProjectionOutcome(root, DIRS_A, meta("fresh"));
    expect(out.projection).toBe("written");
    expect(existsSync(targetPath(root))).toBe(true);
    expect(readFileSync(targetPath(root), "utf8")).toContain("- Never over-engineer.");
  });
});
