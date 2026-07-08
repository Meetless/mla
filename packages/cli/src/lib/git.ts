import { spawnSync } from "child_process";
import * as crypto from "crypto";

// Git evidence capture per §4.5. Runs in the CLI process (not the hook).
// The CLI sends the resulting JSON in the POST /finalize body.

export interface GitEvidence {
  branch: string;
  topLevel: string;
  lastCommit: string;
  trackedModified: string[];
  staged: string[];
  untracked: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  diffStat: { filesChanged: number; insertions: number; deletions: number };
  diffStatCached: { filesChanged: number; insertions: number; deletions: number };
  errors: string[];
}

function gitRun(repo: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

// A NON-identifying, one-way fingerprint of the repository a run executed in,
// for analytics attribution (spec section 3.7 / T1.10). Hashes the git remote
// URL (the stable repo identity) when present, else the repo top-level path, so
// two runs in the same checkout share a fingerprint WITHOUT the raw remote URL
// or absolute path ever leaving the machine (INV-POSTHOG-PII-1 forbids a raw
// repoPath). The "r_" prefix + sha256-slice mirror store.ts machineId(). Returns
// null outside a git repo or when git is unavailable; attribution then carries a
// null repoFingerprint rather than a fabricated value. Computed once per run at
// bootstrap, never per event (it shells out to git).
export function computeRepoFingerprint(repo: string = process.cwd()): string | null {
  const remote = gitRun(repo, ["config", "--get", "remote.origin.url"]);
  let seed = remote.ok ? remote.stdout.trim() : "";
  if (!seed) {
    const top = gitRun(repo, ["rev-parse", "--show-toplevel"]);
    seed = top.ok ? top.stdout.trim() : "";
  }
  if (!seed) return null;
  return "r_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function parseDiffStat(out: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const m = out.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  if (m) {
    filesChanged = parseInt(m[1] || "0", 10);
    insertions = parseInt(m[2] || "0", 10);
    deletions = parseInt(m[3] || "0", 10);
  }
  return { filesChanged, insertions, deletions };
}

function parsePorcelain(out: string): {
  trackedModified: string[];
  staged: string[];
  untracked: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
} {
  const trackedModified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const lines = out.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const X = xy[0];
    const Y = xy[1];
    if (X === "?" && Y === "?") {
      untracked.push(rest);
      continue;
    }
    if (X === "R" || Y === "R") {
      const parts = rest.split(" -> ");
      if (parts.length === 2) {
        renamed.push({ from: parts[0], to: parts[1] });
      }
      continue;
    }
    if (X === "D" || Y === "D") {
      deleted.push(rest);
    }
    if (X !== " " && X !== "?") {
      staged.push(rest);
    }
    if (Y !== " " && Y !== "?") {
      trackedModified.push(rest);
    }
  }
  return { trackedModified, staged, untracked, deleted, renamed };
}

// Subtract the session-start baseline from the finalize-time porcelain so the
// review attributes only what the SESSION touched, not ambient dirty state the
// working tree already carried before the agent started (the 2026-05-31 dogfood
// bug: a pre-existing `.claude/scheduled_tasks.lock` deletion was blamed on the
// run). Comparison is exact-line (porcelain `XY␣path`): a line byte-identical to
// the baseline is ambient and dropped; a line whose status code CHANGED since
// the baseline means the session acted on it, so it survives.
//
// Known, accepted limitation: a file already dirty at session start that the
// session edits FURTHER with the SAME status code (e.g. " M" -> " M") is treated
// as ambient. Closing that needs per-path content hashing; the dominant bug
// (files the session never touched at all) is what this fixes.
function subtractBaseline(currentPorcelain: string, baselinePorcelain: string): string {
  const baselineLines = new Set(
    baselinePorcelain.split("\n").filter((l) => l.length > 0),
  );
  return currentPorcelain
    .split("\n")
    .filter((l) => l.length > 0 && !baselineLines.has(l))
    .join("\n");
}

export function captureGitEvidence(repo: string, baselinePorcelain?: string | null): GitEvidence {
  const errors: string[] = [];

  const branchRes = gitRun(repo, ["branch", "--show-current"]);
  const branch = branchRes.ok ? branchRes.stdout.trim() : "";
  if (!branchRes.ok) errors.push("branch:" + branchRes.stderr.trim().slice(0, 100));

  const topRes = gitRun(repo, ["rev-parse", "--show-toplevel"]);
  const topLevel = topRes.ok ? topRes.stdout.trim() : "";
  if (!topRes.ok) errors.push("toplevel:" + topRes.stderr.trim().slice(0, 100));

  const logRes = gitRun(repo, ["log", "-1", "--oneline"]);
  const lastCommit = logRes.ok ? logRes.stdout.trim() : "";

  // -c core.quotePath=false keeps non-ASCII paths in raw UTF-8 instead of the
  // default C-style octal-quoted form. Without this, a Vietnamese filename
  // like `Lỗi-không-tìm-thấy.ts` comes back as
  // `"L\341\273\227i-kh\303\264ng-t\303\254m-th\341\272\245y.ts"`, which then
  // flows into trackedModified / staged / untracked verbatim, kills the
  // worker's classifier match, and renders as garbled text in `mla review`.
  const porcelainRes = gitRun(repo, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
  ]);
  // A non-null baseline (even an empty string) switches us to session-scoped
  // attribution; `undefined`/`null` preserves the original whole-tree behavior.
  const scoped = baselinePorcelain !== undefined && baselinePorcelain !== null;
  const effectivePorcelain =
    scoped && porcelainRes.ok ? subtractBaseline(porcelainRes.stdout, baselinePorcelain) : porcelainRes.stdout;

  const { trackedModified, staged, untracked, deleted, renamed } = porcelainRes.ok
    ? parsePorcelain(effectivePorcelain)
    : { trackedModified: [], staged: [], untracked: [], deleted: [], renamed: [] };
  if (!porcelainRes.ok) errors.push("status:" + porcelainRes.stderr.trim().slice(0, 100));

  // When scoped, recompute the diff stats over only the session-attributed
  // paths so insertion/deletion counts and filesChanged exclude ambient churn.
  // `git diff --stat -- <paths>` with an empty pathspec would list everything,
  // so an empty session set is reported as a zeroed stat (the honest answer).
  const ZERO_STAT = { filesChanged: 0, insertions: 0, deletions: 0 };
  const renamedPaths = renamed.flatMap((r) => [r.from, r.to]);
  const unstagedPaths = Array.from(new Set([...trackedModified, ...renamedPaths]));
  const stagedPaths = Array.from(new Set([...staged, ...renamedPaths]));

  let diffStat: { filesChanged: number; insertions: number; deletions: number };
  let diffStatCached: { filesChanged: number; insertions: number; deletions: number };
  if (scoped) {
    diffStat = unstagedPaths.length > 0 ? parseDiffStat(gitRun(repo, ["diff", "--stat", "--", ...unstagedPaths]).stdout) : { ...ZERO_STAT };
    diffStatCached = stagedPaths.length > 0 ? parseDiffStat(gitRun(repo, ["diff", "--cached", "--stat", "--", ...stagedPaths]).stdout) : { ...ZERO_STAT };
  } else {
    diffStat = parseDiffStat(gitRun(repo, ["diff", "--stat"]).stdout);
    diffStatCached = parseDiffStat(gitRun(repo, ["diff", "--cached", "--stat"]).stdout);
  }

  return {
    branch,
    topLevel,
    lastCommit,
    trackedModified,
    staged,
    untracked,
    deleted,
    renamed,
    diffStat,
    diffStatCached,
    errors,
  };
}
