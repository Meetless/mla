import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Detect Claude Code sessions whose transcript has been DELETED on disk and
// archive the mirrored Meetless AgentRun (`mla session reconcile`).
//
// Why a sweep and not a hook: Claude Code has NO "session deleted" event.
// SessionEnd does not fire on delete, and the transcript file outlives SessionEnd
// anyway. The only reliable signal that a session was deleted is its transcript's
// ABSENCE from disk. So reconciliation compares the workspace's captured sessions
// (from control) against the transcripts still present under ~/.claude/projects.
//
// Fail-SAFE is the whole design: archive is a reversible, per-user view flag (no
// liveness change, no outbox, no audit mutation), but we still refuse to hide a
// session unless we can POSITIVELY prove its transcript is gone. Every uncertain
// case resolves to "skip", never to a false archive. Concretely we only archive
// when the project dir that owned the session still exists on THIS machine (proof
// we are on the capture host) yet the session's own transcript is absent. A wrong
// machine, a missing repoPath, or a slug we cannot match all degrade to "unknown".

export type TranscriptStatus = "present" | "deleted" | "unknown";

// The minimal slice of control's SessionSummary the planner reasons over. Kept
// structural (not an import of the server type) so this stays a dependency-free
// pure module the command layer can feed from the HTTP response.
export interface ReconcilableSession {
  externalSessionId: string;
  adapter: string;
  liveness: "LIVE" | "IDLE" | "ENDED" | string;
  archivedAt?: string | null;
  repoPath?: string | null;
}

export interface ReconcileSkip {
  sessionId: string;
  reason:
    | "not-claude-code"
    | "already-archived"
    | "live"
    | "transcript-present"
    | "transcript-unknown";
}

export interface ReconcilePlan {
  toArchive: string[];
  skipped: ReconcileSkip[];
}

// A resolver maps a session (id + its repoPath) to whether its transcript is
// present/deleted/unknown on disk. Injected so the planner is a pure function and
// the fs scan is tested separately.
export type TranscriptStatusResolver = (
  sessionId: string,
  repoPath?: string | null,
) => TranscriptStatus;

// Pure decision core. Walks the captured sessions and partitions them into
// "archive" (provably-deleted transcript) and "skip" (everything else, with the
// reason). Order-preserving so the human/JSON output is stable.
export function planSessionReconcile(
  sessions: ReconcilableSession[],
  transcriptStatus: TranscriptStatusResolver,
): ReconcilePlan {
  const plan: ReconcilePlan = { toArchive: [], skipped: [] };
  for (const s of sessions) {
    const id = s.externalSessionId;
    // The gates are ordered cheapest/safest first so the skip reason is the most
    // specific true statement about why this session was left alone.
    if (s.adapter !== "claude_code") {
      plan.skipped.push({ sessionId: id, reason: "not-claude-code" });
      continue;
    }
    if (s.archivedAt != null) {
      plan.skipped.push({ sessionId: id, reason: "already-archived" });
      continue;
    }
    if (s.liveness === "LIVE") {
      plan.skipped.push({ sessionId: id, reason: "live" });
      continue;
    }
    const status = transcriptStatus(id, s.repoPath);
    if (status === "deleted") {
      plan.toArchive.push(id);
    } else if (status === "present") {
      plan.skipped.push({ sessionId: id, reason: "transcript-present" });
    } else {
      plan.skipped.push({ sessionId: id, reason: "transcript-unknown" });
    }
  }
  return plan;
}

// Claude Code names a project dir by collapsing the cwd's path separators (and
// dots) to '-'. Verified empirically against the live ~/.claude/projects:
//   /Users/alice/projects/acme/web
//     -> -Users-alice-projects-acme-web
//   /private/tmp/ml-q6-pg-rV03lX -> -private-tmp-ml-q6-pg-rV03lX
// We only use this to PROVE the project still exists on this machine; if our
// encoding ever diverges from Claude Code's the dir simply will not be found, so
// the session resolves to "unknown" (skip) rather than a false "deleted".
export function projectDirForRepoPath(repoPath: string): string {
  return repoPath.replace(/[/.]/g, "-");
}

export interface TranscriptResolverDeps {
  // Defaults to ~/.claude/projects. Injected in tests.
  projectsRoot?: string;
}

// Build the default disk-backed resolver. Performs ONE upfront scan of every
// project dir under projectsRoot, recording the set of session ids that have a
// `<id>.jsonl` transcript ANYWHERE (an encoding-independent presence check: even
// if the server's repoPath disagrees with the real project dir, a transcript that
// exists is still found and the session is reported present, never archived).
//
// A session is "deleted" ONLY when it is absent from that global set AND the
// project dir derived from its repoPath still exists on disk (proof we are on the
// capture host and that project is real here). Otherwise it is "unknown".
export function makeTranscriptStatusResolver(
  deps: TranscriptResolverDeps = {},
): TranscriptStatusResolver {
  const projectsRoot =
    deps.projectsRoot ?? path.join(os.homedir(), ".claude", "projects");

  const present = new Set<string>();
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(projectsRoot);
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    const dir = path.join(projectsRoot, entry);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      files = [];
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) present.add(f.slice(0, -".jsonl".length));
    }
  }

  const dirExists = (dir: string): boolean => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };

  return (sessionId, repoPath) => {
    if (present.has(sessionId)) return "present";
    const rp = (repoPath || "").trim();
    if (!rp) return "unknown";
    const projectDir = path.join(projectsRoot, projectDirForRepoPath(rp));
    return dirExists(projectDir) ? "deleted" : "unknown";
  };
}

// The injected transport seam for the orchestrator: how to LIST the workspace's
// reconcilable sessions, how to RESOLVE a transcript's on-disk status, and how to
// ARCHIVE one session by id. The command layer wires these to control's HTTP
// endpoints + the disk resolver; tests pass pure stubs. Keeping the orchestrator
// dependency-injected is what lets the whole decision path be tested with zero
// network, disk, or config mocking.
export interface ReconcileExecDeps {
  listSessions: () => Promise<ReconcilableSession[]>;
  resolver: TranscriptStatusResolver;
  archive: (sessionId: string) => Promise<void>;
}

export interface ReconcileResult {
  plan: ReconcilePlan;
  // ids the archive call actually succeeded for (empty under dry-run).
  archived: string[];
  // per-session archive failures: we keep going so one 500 cannot strand the rest.
  failed: Array<{ sessionId: string; error: string }>;
  dryRun: boolean;
}

// Orchestrate one reconcile sweep: fetch the captured sessions, plan which have a
// provably-deleted transcript, and (unless dry-run) archive exactly those. Archive
// is fail-SOFT per session: a single failure is recorded in `failed` and the sweep
// continues, because hiding one stale session must never depend on hiding another.
// Under dry-run the plan is computed and returned but `archive` is never called, so
// `--dry-run` is a faithful, side-effect-free preview of what a real run would do.
export async function executeSessionReconcile(
  deps: ReconcileExecDeps,
  opts: { dryRun: boolean },
): Promise<ReconcileResult> {
  const sessions = await deps.listSessions();
  const plan = planSessionReconcile(sessions, deps.resolver);
  const archived: string[] = [];
  const failed: Array<{ sessionId: string; error: string }> = [];
  if (!opts.dryRun) {
    for (const id of plan.toArchive) {
      try {
        await deps.archive(id);
        archived.push(id);
      } catch (e) {
        failed.push({ sessionId: id, error: (e as Error).message });
      }
    }
  }
  return { plan, archived, failed, dryRun: opts.dryRun };
}
