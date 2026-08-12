import * as fs from "fs";
import * as path from "path";

// Per-folder activation marker (opt-in capture gate). The bash counterpart
// lives in hooks-template/common.sh (`meetless_activated`); this module is the
// TypeScript side used by `mla activate` (write) and `mla doctor` (report).
// Both sides MUST agree on the filename and the nearest-wins walk-up semantics.
// "marker" here means the folder activation marker `.meetless.json`; it is the
// only marker concept in the CLI.
export const ACTIVATION_FILENAME = ".meetless.json";

export interface ActivationMarker {
  workspaceId?: string;
  // Display-only workspace label (folder = workspace design). Non-secret, never
  // an authorization input; the server is the sole authority for membership.
  // Purely so humans and `mla workspace show` can name the binding without a
  // round-trip.
  workspaceName?: string;
  // Free-form provenance. Never read by the gate; purely for the human who
  // opens the file later to remember why this folder is activated.
  activatedAt?: string;
  note?: string;
}

export interface FoundActivation {
  path: string;
  dir: string;
  workspaceId?: string;
  workspaceName?: string;
  parseError?: string;
  // How this binding was reached. Absent for the ordinary walk. "worktree" when
  // the walk found nothing here and the binding was inherited from the origin
  // checkout of a linked git worktree (see findWorktreeOrigin). DIAGNOSTIC ONLY:
  // status and doctor render it so an inherited binding is never silent, and
  // nothing else reads it. It is not a scoping input, not an authorization
  // input, and no code branches on it.
  via?: "worktree";
}

// Walk UP from startDir looking for the nearest `.meetless.json`, nearest-wins,
// mirroring how Claude Code resolves CLAUDE.md and how common.sh's
// `meetless_activated` gate behaves. Returns null when no marker is found.
function walkUpForMarker(startDir: string): FoundActivation | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, ACTIVATION_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const found: FoundActivation = { path: candidate, dir };
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ActivationMarker;
        if (typeof parsed.workspaceId === "string" && parsed.workspaceId) {
          found.workspaceId = parsed.workspaceId;
        }
        if (typeof parsed.workspaceName === "string" && parsed.workspaceName) {
          found.workspaceName = parsed.workspaceName;
        }
      } catch (e) {
        // Matches the bash gate: a malformed marker still activates the folder
        // (the file exists); the workspaceId is simply treated as absent.
        found.parseError = (e as Error).message;
      }
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The origin checkout of the linked git worktree containing `startDir`, or null.
//
// D1 (notes/20260810-worktree-binding-loss-and-multi-repo-shared-workspace.md):
// `.meetless.json` is untracked in most repos and `git worktree add` checks out
// TRACKED files only, so a worktree of an activated repo could never see the
// marker and every agent working in one ran ungoverned. A worktree is the same
// repository by definition, so the binding follows the repository.
//
// Proven from git's OWN worktree metadata, never from string surgery on a path:
//
//   <worktree>/.git            a FILE containing `gitdir: <admin dir>` (abs or
//                              relative to the directory holding the file)
//   <admin dir>/commondir      the shared .git, relative to the admin dir
//   <admin dir>/gitdir         a back-pointer naming the `.git` FILE above
//
// The back-pointer is the bidirectional proof: it is what makes this a REAL
// link rather than a `.git` file that happens to name a directory. If any hop
// is missing or disagrees we return null and the caller stays unbound, which
// surfaces as the ordinary fail-visible "not activated" state. We do not guess,
// and we do not reach for `git rev-parse`: this runs only after the marker walk
// already failed, but the bash twin of this logic sits on the capture-hook hot
// path and a subprocess there is not free.
function findWorktreeOrigin(startDir: string): WorktreeLink | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const dotGit = path.join(dir, ".git");
    try {
      if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
        const origin = resolveWorktreeOrigin(dir, dotGit);
        // A `.git` file that does not prove a link ends the search: it is the
        // repository boundary either way, so walking past it would resolve a
        // parent directory's repository, not this one.
        return origin ? { worktreeDir: dir, originDir: origin } : null;
      }
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface WorktreeLink {
  /** The checkout root of the linked worktree itself (the dir holding `.git`). */
  worktreeDir: string;
  /** The checkout root of the repository the worktree was created from. */
  originDir: string;
}

// The linked-worktree checkout root containing `startDir`, or null when this is
// not a linked worktree. Exported for `resolveScanRoot`, which needs THIS
// checkout's root and must never adopt the origin's: a worktree keeps its own
// scan-root, runtime-scope and instruction-snapshot identity even though it
// shares a workspace binding (D1 §1.6).
export function findWorktreeCheckoutRoot(startDir: string): string | null {
  return findWorktreeOrigin(startDir)?.worktreeDir ?? null;
}

function resolveWorktreeOrigin(worktreeDir: string, dotGitFile: string): string | null {
  try {
    const raw = fs.readFileSync(dotGitFile, "utf8");
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
    if (!m) return null;
    const adminDir = path.resolve(worktreeDir, m[1]);
    if (!fs.existsSync(adminDir) || !fs.statSync(adminDir).isDirectory()) return null;

    // The back-pointer must name the `.git` file we came from. realpath both
    // sides so /tmp vs /private/tmp on macOS is not read as a mismatch.
    const backPtr = path.resolve(
      adminDir,
      fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim(),
    );
    if (realpathOrSelf(backPtr) !== realpathOrSelf(dotGitFile)) return null;

    const commonDir = path.resolve(
      adminDir,
      fs.readFileSync(path.join(adminDir, "commondir"), "utf8").trim(),
    );
    if (!fs.existsSync(commonDir) || !fs.statSync(commonDir).isDirectory()) return null;

    // <origin checkout>/.git is the common dir, so the checkout is its parent.
    const origin = path.dirname(commonDir);
    if (!fs.existsSync(origin) || !fs.statSync(origin).isDirectory()) return null;
    // A bare origin repository has no checkout to carry a marker. Its parent is
    // whatever directory happens to hold the bare repo, which is not ours to bind.
    if (path.basename(commonDir) !== ".git") return null;
    return origin;
  } catch {
    // Missing gitdir/commondir, an unreadable admin dir, a submodule `.git` file
    // (which carries no worktree metadata): all "cannot prove it", all null.
    return null;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Resolve the activation marker governing `startDir`.
//
// 1. The ordinary nearest-wins walk. Unchanged, and it still costs exactly what
//    it always did: an activated checkout never reaches step 2.
// 2. Only on failure: if this is a linked git worktree, restart the walk from
//    its origin checkout and stamp the result `via: "worktree"`. A
//    worktree-local marker therefore still wins, because step 1 found it first.
export function findActivation(startDir: string): FoundActivation | null {
  const direct = walkUpForMarker(startDir);
  if (direct) return direct;

  const link = findWorktreeOrigin(startDir);
  if (!link) return null;

  const inherited = walkUpForMarker(link.originDir);
  if (!inherited) return null;
  return { ...inherited, via: "worktree" };
}
