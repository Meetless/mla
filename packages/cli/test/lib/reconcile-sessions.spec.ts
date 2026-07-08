import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  planSessionReconcile,
  projectDirForRepoPath,
  makeTranscriptStatusResolver,
  executeSessionReconcile,
  type ReconcilableSession,
  type TranscriptStatus,
  type ReconcileExecDeps,
} from "../../src/lib/reconcile-sessions";

// `mla session reconcile` detects Claude Code sessions whose transcript has been
// DELETED on disk and archives the mirrored Meetless AgentRun. There is no Claude
// Code "session deleted" hook (SessionEnd does not fire on delete, and the
// transcript outlives SessionEnd), so detection is a disk-reconciliation sweep:
// compare the workspace's captured sessions against the transcripts still present
// under ~/.claude/projects. The whole feature is fail-SAFE: any uncertainty must
// resolve to "skip", never to a false archive (archive is reversible per-user
// view state, but we still never want to hide a session whose transcript is live).

function ses(over: Partial<ReconcilableSession> = {}): ReconcilableSession {
  return {
    externalSessionId: "11111111-1111-1111-1111-111111111111",
    adapter: "claude_code",
    liveness: "ENDED",
    archivedAt: null,
    repoPath: "/repo",
    ...over,
  };
}

describe("planSessionReconcile — the archive decision (pure)", () => {
  // The ONLY path to archive: a claude_code, not-already-archived, non-LIVE
  // session whose transcript the resolver reports DELETED.
  it("archives a claude_code, non-LIVE, not-archived session whose transcript is deleted", () => {
    const s = ses({ externalSessionId: "dead", liveness: "ENDED" });
    const plan = planSessionReconcile([s], () => "deleted");
    expect(plan.toArchive).toEqual(["dead"]);
    expect(plan.skipped).toEqual([]);
  });

  it("treats IDLE (not just ENDED) as archivable when the transcript is deleted", () => {
    const plan = planSessionReconcile([ses({ externalSessionId: "idle", liveness: "IDLE" })], () => "deleted");
    expect(plan.toArchive).toEqual(["idle"]);
  });

  it("NEVER archives a LIVE session even when the transcript appears deleted", () => {
    const plan = planSessionReconcile([ses({ externalSessionId: "live", liveness: "LIVE" })], () => "deleted");
    expect(plan.toArchive).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: "live", reason: "live" }]);
  });

  it("skips a session whose transcript is still present", () => {
    const plan = planSessionReconcile([ses({ externalSessionId: "here" })], () => "present");
    expect(plan.toArchive).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: "here", reason: "transcript-present" }]);
  });

  it("skips a session whose transcript status is unknown (cannot prove deletion)", () => {
    const plan = planSessionReconcile([ses({ externalSessionId: "huh" })], () => "unknown");
    expect(plan.toArchive).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: "huh", reason: "transcript-unknown" }]);
  });

  it("skips a non-claude_code adapter outright, regardless of transcript status", () => {
    const plan = planSessionReconcile([ses({ externalSessionId: "codex", adapter: "codex" })], () => "deleted");
    expect(plan.toArchive).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: "codex", reason: "not-claude-code" }]);
  });

  it("skips an already-archived session (idempotent: no re-archive churn)", () => {
    const plan = planSessionReconcile(
      [ses({ externalSessionId: "old", archivedAt: "2026-06-13T00:00:00.000Z" })],
      () => "deleted",
    );
    expect(plan.toArchive).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: "old", reason: "already-archived" }]);
  });

  it("partitions a mixed batch correctly and keeps input order", () => {
    const sessions = [
      ses({ externalSessionId: "a-del", liveness: "ENDED" }),
      ses({ externalSessionId: "b-live", liveness: "LIVE" }),
      ses({ externalSessionId: "c-here" }),
      ses({ externalSessionId: "d-del", liveness: "IDLE" }),
      ses({ externalSessionId: "e-codex", adapter: "codex" }),
    ];
    const status: Record<string, TranscriptStatus> = {
      "a-del": "deleted",
      "b-live": "deleted",
      "c-here": "present",
      "d-del": "deleted",
      "e-codex": "deleted",
    };
    const plan = planSessionReconcile(sessions, (id) => status[id]);
    expect(plan.toArchive).toEqual(["a-del", "d-del"]);
    expect(plan.skipped).toEqual([
      { sessionId: "b-live", reason: "live" },
      { sessionId: "c-here", reason: "transcript-present" },
      { sessionId: "e-codex", reason: "not-claude-code" },
    ]);
  });

  it("passes the session id AND its repoPath to the resolver (so the resolver can locate the project dir)", () => {
    const seen: Array<[string, string | null | undefined]> = [];
    planSessionReconcile([ses({ externalSessionId: "x", repoPath: "/r" })], (id, repoPath) => {
      seen.push([id, repoPath]);
      return "unknown";
    });
    expect(seen).toEqual([["x", "/r"]]);
  });
});

describe("projectDirForRepoPath — Claude Code project-slug encoding", () => {
  it("collapses path separators to '-' (the verified Claude Code rule)", () => {
    // Empirically: /Users/alice/projects/acme/web ->
    //              -Users-alice-projects-acme-web
    expect(projectDirForRepoPath("/Users/alice/projects/acme/web")).toBe(
      "-Users-alice-projects-acme-web",
    );
    expect(projectDirForRepoPath("/private/tmp/ml-q6-pg-rV03lX")).toBe("-private-tmp-ml-q6-pg-rV03lX");
  });

  it("also collapses dots (Claude Code replaces '.' with '-' in the slug)", () => {
    expect(projectDirForRepoPath("/Users/x/.config/app")).toBe("-Users-x--config-app");
  });
});

describe("makeTranscriptStatusResolver — disk reconciliation (real fs)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ml-reconcile-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function project(repoPath: string): string {
    const dir = path.join(root, projectDirForRepoPath(repoPath));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function transcript(repoPath: string, sessionId: string): void {
    fs.writeFileSync(path.join(project(repoPath), `${sessionId}.jsonl`), "{}\n");
  }

  it("reports a session present when its transcript exists under the matching project dir", () => {
    transcript("/repo/one", "sid-present");
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("sid-present", "/repo/one")).toBe("present");
  });

  it("reports DELETED when the project dir exists but the session transcript is gone", () => {
    // The project dir is real (this machine hosts that project) AND a sibling
    // transcript proves the dir is live, but THIS session's file was deleted.
    transcript("/repo/two", "sibling-still-here");
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("deleted-sid", "/repo/two")).toBe("deleted");
  });

  it("reports DELETED even for an empty-but-existing project dir (the operator deleted its last transcript)", () => {
    project("/repo/three"); // dir exists, no transcripts inside
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("gone-sid", "/repo/three")).toBe("deleted");
  });

  it("reports UNKNOWN when the project dir does not exist on this machine (wrong host -> never false-archive)", () => {
    project("/repo/exists"); // some unrelated project exists
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("nomachine-sid", "/some/other/repo")).toBe("unknown");
  });

  it("reports UNKNOWN when the session has no repoPath (cannot locate a project dir)", () => {
    transcript("/repo/four", "irrelevant");
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("no-repo-sid", null)).toBe("unknown");
    expect(resolve("no-repo-sid", "")).toBe("unknown");
  });

  it("present-check is GLOBAL: a transcript found under ANY project dir wins over a slug mismatch", () => {
    // Session lives under project A's dir, but the server-reported repoPath is B.
    // The global presence scan still finds it -> present (never false-archive on a
    // repoPath/slug mismatch).
    transcript("/repo/actual", "moved-sid");
    project("/repo/reported"); // B's dir also exists
    const resolve = makeTranscriptStatusResolver({ projectsRoot: root });
    expect(resolve("moved-sid", "/repo/reported")).toBe("present");
  });

  it("reports UNKNOWN for everything when the projects root is missing (e.g. CI box, no Claude Code)", () => {
    const resolve = makeTranscriptStatusResolver({ projectsRoot: path.join(root, "does-not-exist") });
    expect(resolve("any-sid", "/repo/x")).toBe("unknown");
  });
});

describe("executeSessionReconcile — orchestration (inject the transport seam)", () => {
  // Build deps where the resolver answers from a fixed status map and `archive`
  // records the ids it was asked to hide. The orchestrator fetches sessions,
  // plans, and (unless dry-run) archives exactly the planned ids.
  function deps(
    sessions: ReconcilableSession[],
    status: Record<string, TranscriptStatus>,
    archive: ReconcileExecDeps["archive"],
  ): ReconcileExecDeps {
    return {
      listSessions: async () => sessions,
      resolver: (id) => status[id] ?? "unknown",
      archive,
    };
  }

  function ses(over: Partial<ReconcilableSession> = {}): ReconcilableSession {
    return {
      externalSessionId: "sid",
      adapter: "claude_code",
      liveness: "ENDED",
      archivedAt: null,
      repoPath: "/repo",
      ...over,
    };
  }

  it("archives exactly the planned (deleted-transcript) sessions and reports them", async () => {
    const archived: string[] = [];
    const result = await executeSessionReconcile(
      deps(
        [ses({ externalSessionId: "dead" }), ses({ externalSessionId: "here" })],
        { dead: "deleted", here: "present" },
        async (id) => {
          archived.push(id);
        },
      ),
      { dryRun: false },
    );
    expect(archived).toEqual(["dead"]);
    expect(result.archived).toEqual(["dead"]);
    expect(result.failed).toEqual([]);
    expect(result.dryRun).toBe(false);
    expect(result.plan.toArchive).toEqual(["dead"]);
  });

  it("dry-run PLANS but never calls archive (no side effects)", async () => {
    let calls = 0;
    const result = await executeSessionReconcile(
      deps([ses({ externalSessionId: "dead" })], { dead: "deleted" }, async () => {
        calls++;
      }),
      { dryRun: true },
    );
    expect(calls).toBe(0);
    expect(result.archived).toEqual([]);
    expect(result.dryRun).toBe(true);
    // The plan still names what WOULD be archived, so --dry-run is a faithful preview.
    expect(result.plan.toArchive).toEqual(["dead"]);
  });

  it("is fail-soft per session: one archive failure does not abort the others", async () => {
    const archived: string[] = [];
    const result = await executeSessionReconcile(
      deps(
        [
          ses({ externalSessionId: "a" }),
          ses({ externalSessionId: "boom" }),
          ses({ externalSessionId: "c" }),
        ],
        { a: "deleted", boom: "deleted", c: "deleted" },
        async (id) => {
          if (id === "boom") throw new Error("HTTP 500: archive blew up");
          archived.push(id);
        },
      ),
      { dryRun: false },
    );
    expect(archived).toEqual(["a", "c"]);
    expect(result.archived).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ sessionId: "boom", error: "HTTP 500: archive blew up" }]);
  });

  it("makes NO archive calls when nothing is deleted", async () => {
    let calls = 0;
    const result = await executeSessionReconcile(
      deps([ses({ externalSessionId: "live", liveness: "LIVE" })], { live: "deleted" }, async () => {
        calls++;
      }),
      { dryRun: false },
    );
    expect(calls).toBe(0);
    expect(result.archived).toEqual([]);
    expect(result.plan.toArchive).toEqual([]);
  });
});
