import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { rescanAndCache, readScanCacheForRoot, resolveScanRootIdentity } from "../../src/commands/scan-context";

// D2 end state, pinned as a regression: TWO separate repositories and a linked
// worktree, all bound to ONE workspace.
//
// What must be true at once:
//   - the workspace-global floor is IDENTICAL everywhere (that is the feature);
//   - each checkout's own instruction files stay local to it, and are never
//     served as another checkout's rules (that is what makes it safe);
//   - each checkout keeps a DISTINCT identity, so the enforcement, attestation
//     and instruction-snapshot planes keep fencing per checkout.
//
// The umbrella-marker workaround fails the middle one by construction, because
// resolveScanRoot takes the MARKER dir as the scan root, which is why
// `mla activate --workspace <id>` writes a marker per repo instead.

const WS = "ws-shared-company";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function repoWithRule(dir: string, token: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# ${token}\n\n- MUST run the ${token} lint profile before pushing.\n`,
    "utf8",
  );
  git(dir, ["add", "CLAUDE.md"]);
  git(dir, ["commit", "-qm", "seed"]);
  writeFileSync(join(dir, ".meetless.json"), JSON.stringify({ workspaceId: WS }), "utf8");
}

/** Everything this root would serve as ITS OWN repo-specific governance. */
function repoLocalText(home: string, cwd: string): string {
  const c = readScanCacheForRoot(home, WS, cwd);
  return JSON.stringify([c?.directives ?? [], c?.scopedRules ?? [], c?.inventory ?? {}]);
}

describe("two repos and a worktree on ONE workspace", () => {
  let home: string;
  let base: string;
  let repoA: string;
  let repoB: string;
  let wtA1: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-multirepo-home-"));
    base = mkdtempSync(join(tmpdir(), "mla-multirepo-"));
    repoA = join(base, "repo-a");
    repoB = join(base, "repo-b");
    wtA1 = join(base, "wt-a1");
    repoWithRule(repoA, "repoAlpha");
    repoWithRule(repoB, "repoBravo");
    git(repoA, ["worktree", "add", "-q", "--detach", wtA1, "HEAD"]);
    expect(statSync(join(wtA1, ".git")).isFile()).toBe(true);
    for (const cwd of [repoA, repoB, wtA1]) {
      rescanAndCache({ cwd, workspaceId: WS, home, now: () => "2026-08-10T00:00:00.000Z" });
    }
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("keeps each repo's instruction content local to that repo", () => {
    const a = repoLocalText(home, repoA);
    const b = repoLocalText(home, repoB);
    expect(a).toContain("repoAlpha");
    expect(a).not.toContain("repoBravo");
    expect(b).toContain("repoBravo");
    expect(b).not.toContain("repoAlpha");
  });

  it("gives the worktree its OWN slot carrying its own checkout's content", () => {
    // A worktree of repo A is a checkout of repo A, so repoAlpha is correct here.
    // What must not appear is the OTHER repository's rules.
    const wt = repoLocalText(home, wtA1);
    expect(wt).toContain("repoAlpha");
    expect(wt).not.toContain("repoBravo");
  });

  it("gives all three DISTINCT checkout identities", () => {
    const ids = [repoA, repoB, wtA1].map((d) => resolveScanRootIdentity(d));
    expect(new Set(ids).size).toBe(3);
    // The worktree in particular must not adopt its origin's identity, or a
    // worktree at an old commit could retire the origin's instruction snapshots.
    expect(resolveScanRootIdentity(wtA1)).not.toBe(resolveScanRootIdentity(repoA));
  });

  it("serves the SAME workspace-global floor to every checkout", () => {
    const floors = [repoA, repoB, wtA1].map(
      (d) => readScanCacheForRoot(home, WS, d)?.floorRulesXml ?? "",
    );
    expect(new Set(floors).size).toBe(1);
  });

  it("resolves all three to the one workspace, the worktree without a marker of its own", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { findActivation } = require("../../src/lib/activation");
    expect(findActivation(repoA).workspaceId).toBe(WS);
    expect(findActivation(repoB).workspaceId).toBe(WS);
    const wt = findActivation(wtA1);
    expect(wt.workspaceId).toBe(WS);
    expect(wt.via).toBe("worktree");
  });

  it("no checkout can be darkened by the others' scans (order independent)", () => {
    // Re-scan in the reverse order; the earlier roots must still answer for
    // themselves. This is the multi-root case the workspace-global slot alone
    // could not serve, and it is why per-root slots exist.
    for (const cwd of [wtA1, repoB, repoA]) {
      rescanAndCache({ cwd, workspaceId: WS, home, now: () => "2026-08-10T00:00:01.000Z" });
    }
    expect(repoLocalText(home, repoA)).toContain("repoAlpha");
    expect(repoLocalText(home, repoB)).toContain("repoBravo");
    expect(repoLocalText(home, repoB)).not.toContain("repoAlpha");
  });
});
