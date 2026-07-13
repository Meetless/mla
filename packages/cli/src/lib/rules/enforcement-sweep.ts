/**
 * The PostToolUse enforcement sweep — the backstop that does not depend on parsing.
 *
 * WHY. The PreToolUse gate now covers every write-capable tool and parses shell
 * commands for write targets, but a shell can always hide a path from a parser
 * (`python -c "open('notes/x','w')"`, base64, eval). A guarantee that rests on a regex
 * is not a guarantee. This sweep asks the only question that cannot be obfuscated:
 * *did a file appear under a forbidden root?* If one did, it is removed, and the agent
 * is told why.
 *
 * It is tool-agnostic ON PURPOSE. It never looks at the tool name or its input, so it
 * covers Bash, MCP filesystem tools, subagent writes, and whatever ships next.
 *
 * HONEST LIMITS, stated rather than buried:
 *  - It is AFTER the fact. The file exists for the instant between the write and the
 *    sweep. For a governed-notes rule that is fine; for a secret-exfil threat model it
 *    would not be.
 *  - It reverts CREATIONS. An edit to a file that already existed under the root is
 *    detected and reported, but its previous content is not restored (we keep no
 *    content backup), so that case blocks-and-reports rather than reverts.
 *  - If SessionStart never ran, the first sweep of a session seeds the baseline and
 *    reverts nothing — a one-call window.
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

/** Cap the walk so a huge forbidden root cannot stall a tool call. */
const MAX_ENTRIES = 20_000;

export type SweepBaseline = {
  version: 1;
  projectRoot: string;
  roots: string[];
  /** posix-relative path (from projectRoot) -> mtimeMs */
  files: Record<string, number>;
};

function walk(dir: string, projectRoot: string, out: Record<string, number>, budget: { n: number }): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir: nothing to enforce on
  }
  for (const e of entries) {
    if (budget.n >= MAX_ENTRIES) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(abs, projectRoot, out, budget);
      continue;
    }
    if (!e.isFile()) continue;
    budget.n++;
    try {
      const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
      out[rel] = fs.statSync(abs).mtimeMs;
    } catch {
      /* raced away; ignore */
    }
  }
}

/** Snapshot every file currently under each forbidden root. */
export function snapshotRoots(projectRoot: string, roots: string[]): Record<string, number> {
  const files: Record<string, number> = {};
  const budget = { n: 0 };
  for (const r of roots) {
    const abs = path.resolve(projectRoot, r);
    // Never walk outside the project root (a root of "../.." must not escape).
    if (!abs.startsWith(projectRoot)) continue;
    if (!fs.existsSync(abs)) continue;
    walk(abs, projectRoot, files, budget);
  }
  return files;
}

export function baselinePath(home: string, sessionId: string, projectRoot: string): string {
  const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "nosession";
  return path.join(home, "enforcement", `baseline-${sid}-${key}.json`);
}

export function writeBaseline(file: string, baseline: SweepBaseline): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(baseline), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readBaseline(file: string): SweepBaseline | null {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8")) as SweepBaseline;
    if (b?.version !== 1 || typeof b.files !== "object" || b.files === null) return null;
    return b;
  } catch {
    return null;
  }
}

export type SweepResult = {
  /** Files that appeared under a forbidden root during the session and were removed. */
  reverted: string[];
  /** Pre-existing files under a forbidden root that were modified (content NOT restored). */
  modified: string[];
};

/**
 * Compare the live tree to the baseline; revert creations, report modifications.
 * Updates the baseline in place so the same file is never reported twice.
 */
export function sweep(projectRoot: string, roots: string[], baseline: SweepBaseline): SweepResult {
  const current = snapshotRoots(projectRoot, roots);
  const reverted: string[] = [];
  const modified: string[] = [];

  for (const [rel, mtime] of Object.entries(current)) {
    const before = baseline.files[rel];
    if (before === undefined) {
      // Created during the session under a forbidden root: the rule says this file must
      // not exist. Remove it and let the agent know — that is the guarantee.
      try {
        fs.unlinkSync(path.resolve(projectRoot, rel));
        reverted.push(rel);
      } catch {
        // Could not remove it (permissions, raced). Report rather than silently pass:
        // a violation we cannot revert is still a violation the human must see.
        modified.push(rel);
      }
      continue;
    }
    if (before !== mtime) {
      modified.push(rel);
      baseline.files[rel] = mtime; // report once
    }
  }
  return { reverted, modified };
}
