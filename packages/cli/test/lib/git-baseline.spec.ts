import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { captureGitEvidence } from "../../src/lib/git";

// Reproduces the 2026-05-31 dogfood false-attribution bug: `mla review`
// attributed an AMBIENT pre-existing git change (`.claude/scheduled_tasks.lock`
// deleted BEFORE the mission started) to the mission. `captureGitEvidence`
// snapshots the whole dirty working tree at finalize with no session-start
// baseline, so anything already dirty at session start is blamed on the run.
//
// Fix: session-start.sh records the working-tree dirty state as a baseline; at
// finalize `captureGitEvidence(repo, baseline)` subtracts entries that are
// byte-identical (same porcelain XY + path) to the baseline -- i.e. ambient
// changes the mission never touched. Entries whose status CHANGED since the
// baseline (the mission acted on them) are kept.
//
// Known, accepted limitation (documented in git.ts): a file already dirty at
// session start that the mission edits FURTHER with the SAME status code is
// treated as ambient. The dominant bug (files the mission never touched) is
// what this closes.

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-gitbaseline-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function porcelain(repo: string): string {
  const r = spawnSync(
    "git",
    ["-C", repo, "-c", "core.quotePath=false", "status", "--porcelain=v1"],
    { encoding: "utf8" },
  );
  return r.stdout || "";
}

describe("captureGitEvidence baseline subtraction (ambient-attribution fix)", () => {
  it("excludes an ambient pre-existing deletion the mission never touched", () => {
    const repo = initRepo();
    try {
      fs.writeFileSync(path.join(repo, "keep.ts"), "export const a = 1;\n");
      fs.writeFileSync(path.join(repo, "victim.lock"), "lock\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      // --- AMBIENT change BEFORE the mission: delete victim.lock ---
      fs.rmSync(path.join(repo, "victim.lock"));
      const baseline = porcelain(repo); // " D victim.lock"
      expect(baseline).toContain("victim.lock");

      // --- MISSION change: edit keep.ts ---
      fs.writeFileSync(path.join(repo, "keep.ts"), "export const a = 2;\n");

      const ev = captureGitEvidence(repo, baseline);

      // Mission file attributed; ambient deletion excluded.
      expect(ev.trackedModified).toContain("keep.ts");
      expect(ev.deleted).not.toContain("victim.lock");
      // diffStat reflects ONLY the mission file, not the ambient deletion.
      expect(ev.diffStat.filesChanged).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a baseline-dirty file whose status CHANGED under the mission", () => {
    const repo = initRepo();
    try {
      fs.writeFileSync(path.join(repo, "f.ts"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      // Ambient: modify f.ts (unstaged) -> baseline " M f.ts"
      fs.writeFileSync(path.join(repo, "f.ts"), "v2\n");
      const baseline = porcelain(repo);

      // Mission acts on it: stage the change -> "M  f.ts" (status code changed)
      git(repo, ["add", "f.ts"]);

      const ev = captureGitEvidence(repo, baseline);
      // Status changed from " M" to "M " -> mission touched it -> kept.
      expect(ev.staged).toContain("f.ts");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with no baseline, attributes the whole dirty tree (back-compat)", () => {
    const repo = initRepo();
    try {
      fs.writeFileSync(path.join(repo, "keep.ts"), "v1\n");
      fs.writeFileSync(path.join(repo, "victim.lock"), "lock\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      fs.rmSync(path.join(repo, "victim.lock"));
      fs.writeFileSync(path.join(repo, "keep.ts"), "v2\n");

      // No baseline argument -> original whole-tree behavior preserved.
      const ev = captureGitEvidence(repo);
      expect(ev.trackedModified).toContain("keep.ts");
      expect(ev.deleted).toContain("victim.lock");
      expect(ev.diffStat.filesChanged).toBe(2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an empty baseline subtracts nothing (non-repo session start)", () => {
    const repo = initRepo();
    try {
      fs.writeFileSync(path.join(repo, "keep.ts"), "v1\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "seed"]);
      fs.writeFileSync(path.join(repo, "keep.ts"), "v2\n");

      const ev = captureGitEvidence(repo, "");
      expect(ev.trackedModified).toContain("keep.ts");
      expect(ev.diffStat.filesChanged).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Drift guard: if a future refactor drops the baseline sidecar write from
// session-start.sh, ambient attribution silently returns. Mirror of the
// repoPath sidecar drift guard.
describe("session-start.sh git baseline sidecar (drift guard)", () => {
  const SESSION_START = path.resolve(
    __dirname,
    "../../src/hooks-template/session-start.sh",
  );

  it("KEEPS the gitBaseline sidecar write", () => {
    const src = fs.readFileSync(SESSION_START, "utf8");
    expect(src).toMatch(/\$QUEUE_DIR\/\$SESSION_ID\.gitBaseline/);
    expect(src).toMatch(/status\s+--porcelain/);
  });
});

// 2026-06-01 dogfood finding F-GIT-1 (RCA §9.F): on a CONTINUED / COMPACTED
// session, Claude Code re-fires SessionStart with the SAME session_id. The old
// hook unconditionally re-captured the gitBaseline -- AFTER the prior turns'
// edits already dirtied the tree -- so subtractBaseline treated the agent's own
// work as ambient churn and `mla review` reported "changed files: 0" on a
// session with real uncommitted edits. The baseline must be captured ONCE, at
// the TRUE session start, and preserved across resumes for the same session_id.
// flush.sh still deletes it after a successful finalize, so the next genuine
// segment re-captures fresh.
describe("session-start.sh baseline is captured ONCE per session (continue/compaction guard)", () => {
  const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");

  function stageHooksDir(tmp: string): string {
    const stage = path.join(tmp, "hooks");
    fs.mkdirSync(stage, { recursive: true });
    for (const f of ["common.sh", "session-start.sh", "flush.sh"]) {
      fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(stage, f));
    }
    const filter = path.join(HOOKS_DIR, "event-batch-filter.jq");
    if (fs.existsSync(filter)) {
      fs.copyFileSync(filter, path.join(stage, "event-batch-filter.jq"));
    }
    fs.chmodSync(path.join(stage, "session-start.sh"), 0o755);
    fs.chmodSync(path.join(stage, "flush.sh"), 0o755);
    return stage;
  }

  function makeMeetlessHome(tmp: string): string {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, "queue"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({
        // Unreachable control: the detached flush bails, never finalizes, never
        // deletes the baseline -- so this test observes ONLY session-start.sh.
        controlUrl: "http://127.0.0.1:1",
        controlToken: "test-token",
        workspaceId: "ws_test",
        mlaPath: "/bin/true",
      }),
    );
    return home;
  }

  function runSessionStart(stage: string, home: string, repo: string, sid: string): void {
    const r = spawnSync("bash", [path.join(stage, "session-start.sh")], {
      input: JSON.stringify({ session_id: sid, transcript_path: "/tmp/ignored.json" }),
      encoding: "utf8",
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home },
    });
    expect(r.status).toBe(0);
  }

  it("does NOT clobber an existing baseline when SessionStart re-fires mid-session", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-baseline-once-"));
    const repo = initRepo();
    try {
      // Activated repo with a clean-ish committed tree at TRUE session start.
      fs.writeFileSync(path.join(repo, ".meetless.json"), "{}\n");
      fs.writeFileSync(path.join(repo, "keep.ts"), "export const a = 1;\n");
      git(repo, ["add", "keep.ts"]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sid = "sess-continue";
      const baselineFile = path.join(home, "queue", `${sid}.gitBaseline`);

      // 1) TRUE session start: tree has only the (gitignored) .meetless.json
      //    untracked; keep.ts is clean. Baseline should NOT mention keep.ts.
      runSessionStart(stage, home, repo, sid);
      expect(fs.existsSync(baselineFile)).toBe(true);
      const b1 = fs.readFileSync(baselineFile, "utf8");
      expect(b1).not.toContain("keep.ts");

      // 2) Agent does its work: keep.ts now dirty (" M keep.ts").
      fs.writeFileSync(path.join(repo, "keep.ts"), "export const a = 2;\n");

      // 3) CONTINUE / COMPACTION re-fires SessionStart with the SAME session_id.
      runSessionStart(stage, home, repo, sid);

      // The baseline must be the SAME true-start snapshot, NOT re-captured over
      // the agent's edits. Pre-fix this assertion fails: b2 contains " M keep.ts".
      const b2 = fs.readFileSync(baselineFile, "utf8");
      expect(b2).toBe(b1);
      expect(b2).not.toContain("keep.ts");

      // Downstream proof: with the preserved (clean) baseline, the agent's edit
      // to keep.ts is correctly attributed at finalize.
      const ev = captureGitEvidence(repo, b2);
      expect(ev.trackedModified).toContain("keep.ts");
      expect(ev.diffStat.filesChanged).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("re-captures a fresh baseline after the sidecar is removed (post-finalize segment)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-baseline-reset-"));
    const repo = initRepo();
    try {
      fs.writeFileSync(path.join(repo, ".meetless.json"), "{}\n");
      fs.writeFileSync(path.join(repo, "keep.ts"), "v1\n");
      git(repo, ["add", "keep.ts"]);
      git(repo, ["commit", "-q", "-m", "seed"]);

      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sid = "sess-reset";
      const baselineFile = path.join(home, "queue", `${sid}.gitBaseline`);

      runSessionStart(stage, home, repo, sid);
      const b1 = fs.readFileSync(baselineFile, "utf8");
      expect(b1).not.toContain("keep.ts");

      // Simulate flush.sh deleting the sidecar after a successful finalize, then
      // the working tree being dirtied, then a brand-new segment starting.
      fs.rmSync(baselineFile);
      fs.writeFileSync(path.join(repo, "keep.ts"), "v2\n");

      runSessionStart(stage, home, repo, sid);
      const b2 = fs.readFileSync(baselineFile, "utf8");
      // No sidecar on disk -> this IS a fresh start -> capture the now-dirty tree
      // as the new segment's baseline.
      expect(b2).toContain("keep.ts");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
