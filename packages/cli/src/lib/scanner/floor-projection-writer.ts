// IO for the floor projection (notes/20260705-floor-rule-delivery-coverage-matrix.md,
// Phase 1). Materializes / removes `.claude/rules/meetless-mla-floor.generated.md` under
// the activated checkout, with the same safety posture the bundle cache uses:
//   - Never clobber a file MLA does not own. A tracked file, a foreign (non-sentinel)
//     file, or an MLA file whose body was hand-edited is left byte-for-byte intact; the
//     writer reports `blocked` with a reason and moves on. Activation must never fail
//     because a projection could not be written.
//   - Atomic replacement only: write a temp sibling then rename over the target, so a
//     reader never observes a half-written projection.
//   - Repo-local Git exclusion via `.git/info/exclude` (never `.gitignore`, which is the
//     user's tracked file). A non-Git directory still gets the projection; it just skips
//     the exclude step.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { Directive } from "./types";
import {
  FLOOR_PROJECTION_RELPATH,
  isOwnedProjection,
  renderFloorProjection,
  renderProjectionBody,
  projectionBodyHash,
  splitProjection,
  declaredPayloadHash,
} from "./floor-projection";

export type ProjectionOutcome = "written" | "unchanged" | "blocked";

export interface ProjectionReceipt {
  projection: ProjectionOutcome;
  reason?:
    | "no_floor_rules" // nothing eligible to project (also the bundle-unavailable case)
    | "same_hash" // an owned projection already carries this exact floor body
    | "path_tracked" // the target is tracked by Git; refuse to touch a versioned file
    | "foreign_file" // a non-MLA file sits at the target; never overwrite it
    | "edited" // an MLA file whose body was hand-edited; treat as user-owned
    | "error"; // an unexpected IO / Git failure (fail-safe, activation still succeeds)
  path?: string; // absolute target path, for the observability receipt
}

export interface RemovalReceipt {
  removed: boolean;
  reason?: "absent" | "foreign_file" | "edited" | "error";
  path?: string;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // not a Git repo, or Git absent: caller degrades gracefully
  }
}

// Resolve symlinks in a path, degrading to the input when the target does not exist yet
// or cannot be resolved. Used to reconcile a caller-supplied (possibly symlinked) path
// with git's realpath-resolved toplevel before computing a repo-relative pattern.
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// True iff Git tracks the target. `ls-files --error-unmatch` exits 0 (printing the path) only
// when the target is tracked; for an untracked path it exits NON-ZERO, which makes runGit catch
// and return null. A non-Git directory also returns null. So "tracked" is exactly a non-null
// result: the check keys on `!== null`, NOT on whether the printed output is empty.
function isTrackedByGit(scanRoot: string, absTarget: string): boolean {
  const out = runGit(scanRoot, ["ls-files", "--error-unmatch", "--", absTarget]);
  return out !== null;
}

// Add the projection path to `.git/info/exclude` (repo-local, untracked) so the
// generated file never shows up in `git status`. Idempotent: the line is appended only
// when absent. Silently no-ops outside a Git repo. Never touches `.gitignore`.
function ensureGitExclude(scanRoot: string, absTarget: string): void {
  const toplevel = runGit(scanRoot, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return; // not a Git repo
  const excludePath = runGit(scanRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludePath) return;
  // git reports the toplevel as a REAL path (symlinks resolved), but absTarget is built
  // from the caller's scanRoot, which may still carry a symlinked prefix (e.g. macOS
  // /var -> /private/var, or a symlinked checkout). Resolve both through realpath before
  // path.relative so the exclude pattern is the clean repo-relative path, never a broken
  // `../../..`-laden one. Both exist here (toplevel is a repo; absTarget was just written).
  const root = realpathOr(toplevel.trim());
  // The exclude PATTERN is repo-root-relative (git excludes match from toplevel), so it is
  // computed against `root`.
  const rel = path.relative(root, realpathOr(absTarget)).split(path.sep).join("/");
  // Exclude the projection itself AND any crash-orphaned atomic-write temp sibling
  // (`<file>.tmp-<pid>`, see atomicWrite). atomicWrite already unlinks its temp on a thrown
  // error, but a hard kill in the write->rename window can strand one; the glob keeps it out
  // of `git status` so activation never leaves untracked noise behind.
  const patterns = [`/${rel}`, `/${rel}.tmp-*`];
  // The exclude FILE path from `--git-path` is relative to the cwd git ran in (scanRoot),
  // NOT the toplevel. Join it against scanRoot so a marker in a repo SUBDIR (scanRoot !=
  // toplevel) still resolves the real `.git/info/exclude`; they coincide at the repo root.
  const absExclude = path.isAbsolute(excludePath.trim())
    ? excludePath.trim()
    : path.join(scanRoot, excludePath.trim());
  let existing = "";
  try {
    existing = fs.readFileSync(absExclude, "utf8");
  } catch {
    existing = "";
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  // A user may have added a pattern without the leading slash; treat either form as present.
  const missing = patterns.filter((p) => !have.has(p) && !have.has(p.slice(1)));
  if (!missing.length) return; // already excluded
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  try {
    fs.mkdirSync(path.dirname(absExclude), { recursive: true });
    fs.appendFileSync(absExclude, `${prefix}${missing.map((p) => `${p}\n`).join("")}`, "utf8");
  } catch {
    // Best-effort: a read-only .git must not fail the projection write.
  }
}

// Atomic same-directory replacement: write a temp sibling then rename over the target.
function atomicWrite(absTarget: string, content: string): void {
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });
  const tmp = `${absTarget}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, absTarget);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Materialize the floor projection under `scanRoot` (the activated checkout root).
 * BEST-EFFORT and THROW-FREE: every failure degrades to a `blocked`/`unchanged` receipt
 * so the caller (a scan that just wrote scan-cache.json) never breaks.
 */
export function materializeFloorProjection(
  scanRoot: string,
  dirs: Directive[],
  bundleId: string,
): ProjectionReceipt {
  const absTarget = path.join(scanRoot, FLOOR_PROJECTION_RELPATH);
  try {
    // Nothing eligible to project. This is ALSO the bundle-unavailable case (the scanner
    // injects no floor directives), so we intentionally do NOT remove an existing owned
    // projection here: a transient empty read must not revoke the last-known floor. The
    // explicit removal path is deactivation (removeOwnedProjection).
    const body = renderProjectionBody(dirs);
    if (!body) return { projection: "unchanged", reason: "no_floor_rules", path: absTarget };

    // Refuse to touch a versioned file. A tracked target means the user checked the path
    // into Git; report degraded rather than fight version control.
    if (isTrackedByGit(scanRoot, absTarget)) {
      return { projection: "blocked", reason: "path_tracked", path: absTarget };
    }

    const intendedHash = projectionBodyHash(body);
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(absTarget, "utf8");
    } catch {
      existing = null; // absent -> fresh write below
    }

    if (existing !== null) {
      // A file already sits at the target. Only overwrite it when MLA owns it.
      const parts = splitProjection(existing);
      if (!parts || !declaredPayloadHash(parts.header)) {
        return { projection: "blocked", reason: "foreign_file", path: absTarget };
      }
      if (!isOwnedProjection(existing)) {
        // Sentinel present but body hash diverges from the declared hash: hand-edited.
        return { projection: "blocked", reason: "edited", path: absTarget };
      }
      // Owned and valid. Skip the rewrite when the floor body is unchanged (same hash),
      // so an unchanged bundle produces no Git churn.
      if (declaredPayloadHash(parts.header) === intendedHash) {
        return { projection: "unchanged", reason: "same_hash", path: absTarget };
      }
    }

    atomicWrite(absTarget, renderFloorProjection(dirs, bundleId));
    ensureGitExclude(scanRoot, absTarget);
    return { projection: "written", path: absTarget };
  } catch {
    return { projection: "blocked", reason: "error", path: absTarget };
  }
}

/**
 * Remove the floor projection on deactivation, but ONLY when MLA verifiably owns it.
 * A foreign file or a hand-edited projection is left intact. THROW-FREE.
 */
export function removeOwnedProjection(scanRoot: string): RemovalReceipt {
  const absTarget = path.join(scanRoot, FLOOR_PROJECTION_RELPATH);
  try {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(absTarget, "utf8");
    } catch {
      return { removed: false, reason: "absent", path: absTarget };
    }
    const parts = splitProjection(existing);
    if (!parts || !declaredPayloadHash(parts.header)) {
      return { removed: false, reason: "foreign_file", path: absTarget };
    }
    if (!isOwnedProjection(existing)) {
      return { removed: false, reason: "edited", path: absTarget };
    }
    fs.rmSync(absTarget, { force: true });
    return { removed: true, path: absTarget };
  } catch {
    return { removed: false, reason: "error", path: absTarget };
  }
}
