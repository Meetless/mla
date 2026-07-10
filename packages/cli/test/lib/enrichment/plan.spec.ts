import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDocumentationTargets,
  prepareGitEvidence,
  buildOnboardingRun,
  writeRunRecord,
  loadRunRecord,
  pruneOldRuns,
  runsDir,
  createPlan,
  buildPlan,
  readGitIdentity,
  runRecordPath,
  type GitRunner,
} from "../../../src/lib/enrichment/plan";
import { computePlanDigest, defaultLimits, type OnboardingRun } from "../../../src/lib/enrichment/protocol";

const COMMIT_MARK = "@@MLA-ENRICH-COMMIT@@";
const META_END_MARK = "@@MLA-ENRICH-ENDMETA@@";

// A canned `git log --name-status` payload framed exactly as prepareGitEvidence asks for,
// including the blank lines real git inserts after the message and between commits.
const GIT_LOG_FIXTURE = [
  COMMIT_MARK,
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "2026-06-20T10:00:00+00:00",
  "feat: add propagation",
  "first body line",
  "second body line",
  META_END_MARK,
  "",
  "M\tcontrol/sm.ts",
  "A\tnotes/decision.md",
  "R100\told/path.ts\tnew/path.ts",
  "",
  COMMIT_MARK,
  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "2026-06-19T09:00:00+00:00",
  "chore: remove dead code",
  "",
  META_END_MARK,
  "",
  "D\tlegacy/gone.ts",
  "",
].join("\n");

const fakeGit = (lsFiles: string[], log = GIT_LOG_FIXTURE): GitRunner => {
  return (args) => {
    if (args[0] === "ls-files") return lsFiles.join("\n");
    if (args[0] === "log") return log;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
};

describe("buildDocumentationTargets", () => {
  const files = [
    "src/index.ts", // null -> excluded
    "package.json", // T3 -> excluded
    ".github/workflows/ci.yml", // T3 -> excluded
    "CLAUDE.md", // T1
    "apps/control/CLAUDE.md", // T1 (basename)
    ".claude/rules/notes-location.md", // T1
    "README.md", // T2
    "docs/adr/0001-foo.md", // T2
    "guide.md", // T2 (generic prose)
    "notes/20260101-thing.md", // T4
  ];

  it("excludes code, T3, and unclassified files", () => {
    const targets = buildDocumentationTargets("/repo", 50, fakeGit(files));
    const paths = targets.map((t) => t.path);
    expect(paths).not.toContain("src/index.ts");
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain(".github/workflows/ci.yml");
  });

  it("groups by tier priority (all T1 before T2 before T4) with contiguous ranks", () => {
    const targets = buildDocumentationTargets("/repo", 50, fakeGit(files));
    const order = ["T1", "T1", "T1", "T2", "T2", "T2", "T4"];
    expect(targets.map((t) => t.tier)).toEqual(order);
    expect(targets.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("orders curated T2 (known doc names, ADR/RFC/spec dirs) ahead of generic prose", () => {
    // Regression: when the budget is tight, a curated doc (the canonical package README,
    // an ADR) must not be crowded out by alphabetically-earlier generic prose. Within T2,
    // curated comes first; generic prose (guide.md) sinks below it.
    const targets = buildDocumentationTargets("/repo", 50, fakeGit(files));
    const paths = targets.map((t) => t.path);
    const adr = paths.indexOf("docs/adr/0001-foo.md");
    const readme = paths.indexOf("README.md");
    const generic = paths.indexOf("guide.md");
    expect(adr).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(Math.max(adr, readme)); // generic prose is last among T2
  });

  it("does not let a tight budget spend a slot on generic prose over a curated doc", () => {
    // Four T1 + curated/generic T2: with a budget that only reaches into T2, the curated
    // doc takes the slot, not the generic prose that sorts earlier by path.
    const mixed = ["CLAUDE.md", "alpha-notes.md", "docs/adr/0002-bar.md"];
    // "alpha-notes.md" sorts before "docs/..." but is generic; the ADR must win the T2 slot.
    const targets = buildDocumentationTargets("/repo", 2, fakeGit(mixed));
    expect(targets.map((t) => t.path)).toEqual(["CLAUDE.md", "docs/adr/0002-bar.md"]);
  });

  it("caps to the limit", () => {
    const targets = buildDocumentationTargets("/repo", 2, fakeGit(files));
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.tier === "T1")).toBe(true);
  });

  it("returns [] when git is unavailable", () => {
    const throwing: GitRunner = () => {
      throw new Error("not a git repo");
    };
    expect(buildDocumentationTargets("/repo", 50, throwing)).toEqual([]);
  });
});

describe("prepareGitEvidence", () => {
  it("parses commits, bounded body, name-status, and rename info", () => {
    const { evidence, truncated } = prepareGitEvidence("/repo", {
      maxScanCommits: 300,
      maxSelectedCommits: 40,
      maxBytes: 1_000_000,
      gitRunner: fakeGit([]),
    });
    expect(truncated).toBe(false);
    expect(evidence).toHaveLength(2);

    const [a, b] = evidence;
    expect(a.commit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); // lowercased
    expect(a.subject).toBe("feat: add propagation");
    expect(a.body).toBe("first body line\nsecond body line");
    expect(a.changedFiles).toEqual([
      { path: "control/sm.ts", status: "M" },
      { path: "notes/decision.md", status: "A" },
      { path: "new/path.ts", status: "R100", renamedFrom: "old/path.ts" },
    ]);

    expect(b.subject).toBe("chore: remove dead code");
    expect(b.body).toBe("");
    expect(b.changedFiles).toEqual([{ path: "legacy/gone.ts", status: "D" }]);
  });

  it("caps to maxSelectedCommits and flags truncation", () => {
    const { evidence, truncated } = prepareGitEvidence("/repo", {
      maxScanCommits: 300,
      maxSelectedCommits: 1,
      maxBytes: 1_000_000,
      gitRunner: fakeGit([]),
    });
    expect(evidence).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("bounds total prepared bytes (keeps at least one commit)", () => {
    const { evidence, truncated } = prepareGitEvidence("/repo", {
      maxScanCommits: 300,
      maxSelectedCommits: 40,
      maxBytes: 10, // far below one commit's size
      gitRunner: fakeGit([]),
    });
    expect(evidence).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("skips an oversized commit and keeps filling from smaller later ones", () => {
    // The byte budget SKIPS rather than HALTS (verdict item 7): a fat middle commit must
    // not starve the smaller commits after it. Old behavior would stop at the first commit
    // and return [small one]; the new fill reaches past the oversized one to [one, three].
    const bigBody = "x".repeat(900);
    const log = [
      COMMIT_MARK, "1".repeat(40), "2026-06-22T10:00:00+00:00", "feat: small one", "small body", META_END_MARK, "",
      "M\ta.ts", "",
      COMMIT_MARK, "2".repeat(40), "2026-06-21T10:00:00+00:00", "feat: huge one", bigBody, META_END_MARK, "",
      "M\tb.ts", "",
      COMMIT_MARK, "3".repeat(40), "2026-06-20T10:00:00+00:00", "feat: small three", "small body", META_END_MARK, "",
      "M\tc.ts", "",
    ].join("\n");
    const { evidence, truncated } = prepareGitEvidence("/repo", {
      maxScanCommits: 300,
      maxSelectedCommits: 40,
      maxBytes: 600, // fits small+small (~375B) but not small+huge (~1.1KB)
      gitRunner: fakeGit([], log),
    });
    expect(evidence.map((e) => e.subject)).toEqual(["feat: small one", "feat: small three"]);
    expect(truncated).toBe(true); // the skipped commit counts as truncation
  });

  it("flags truncation when the scan window is fully consumed (maybe-more-history)", () => {
    // When the parsed pool fills the scan ceiling exactly, older commits may exist beyond it,
    // so the run reports truncated even though every scanned commit was inlined. (The fake
    // git runner does not honor `-n`, so we model the ceiling via the count it returns: the
    // 2-commit fixture against a scan cap of 2 trips parsed.length >= scanCap.)
    const { evidence, truncated } = prepareGitEvidence("/repo", {
      maxScanCommits: 2,
      maxSelectedCommits: 40,
      maxBytes: 1_000_000,
      gitRunner: fakeGit([]),
    });
    expect(evidence).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("returns empty on git failure", () => {
    const throwing: GitRunner = () => {
      throw new Error("empty history");
    };
    expect(
      prepareGitEvidence("/repo", { maxScanCommits: 300, maxSelectedCommits: 40, maxBytes: 100, gitRunner: throwing }),
    ).toEqual({
      evidence: [],
      truncated: false,
    });
  });

  // Real-git smoke: exercise the actual `git log --name-status` format end-to-end
  // against this very repo (don't mock the thing you depend on).
  it("parses real repository history", () => {
    const { evidence } = prepareGitEvidence(process.cwd(), {
      maxScanCommits: 300,
      maxSelectedCommits: 5,
      maxBytes: 1_000_000,
    });
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.length).toBeLessThanOrEqual(5);
    for (const e of evidence) {
      expect(e.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof e.subject).toBe("string");
      expect(Array.isArray(e.changedFiles)).toBe(true);
    }
  });
});

describe("buildOnboardingRun", () => {
  const base = {
    runId: "run-xyz",
    workspaceId: "ws_1",
    repositoryRoot: "/repo",
    now: "2026-06-26T00:00:00.000Z",
    documentationTargets: [{ path: "CLAUDE.md", tier: "T1" as const, rank: 1 }],
    historyEvidence: [],
  };

  it("computes deadlineAt from the injected clock + budget", () => {
    const run = buildOnboardingRun(base);
    expect(run.createdAt).toBe("2026-06-26T00:00:00.000Z");
    expect(run.deadlineAt).toBe("2026-06-26T00:04:00.000Z"); // +240000ms
  });

  it("computes a digest matching computePlanDigest over the integrity-bearing content", () => {
    const run = buildOnboardingRun(base);
    expect(run.planDigest).toBe(computePlanDigest(run));
    expect(run.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honors a custom budget", () => {
    const run = buildOnboardingRun({ ...base, limits: defaultLimits(60_000) });
    expect(run.deadlineAt).toBe("2026-06-26T00:01:00.000Z");
  });
});

describe("run-record persistence", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-enrich-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const run = (runId: string): OnboardingRun =>
    buildOnboardingRun({
      runId,
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: "2026-06-26T00:00:00.000Z",
      documentationTargets: [],
      historyEvidence: [],
    });

  it("round-trips a written record", () => {
    const r = run("run-a");
    const path = writeRunRecord(home, r);
    expect(existsSync(path)).toBe(true);
    expect(loadRunRecord(home, "ws_1", "run-a")).toEqual(r);
  });

  it("returns null for an unknown runId", () => {
    expect(loadRunRecord(home, "ws_1", "missing")).toBeNull();
  });

  it("prunes every same-repo record except the current runId", () => {
    writeRunRecord(home, run("old-1"));
    writeRunRecord(home, run("old-2"));
    writeRunRecord(home, run("current"));
    const removed = pruneOldRuns(home, "ws_1", "current", "/repo");
    expect(removed).toBe(2);
    expect(loadRunRecord(home, "ws_1", "current")).not.toBeNull();
    expect(loadRunRecord(home, "ws_1", "old-1")).toBeNull();
    expect(loadRunRecord(home, "ws_1", "old-2")).toBeNull();
  });

  it("never prunes another repo's run sharing the workspace (multi-repo)", () => {
    // The Meetless monorepo and intel bind one workspace. Planning a run for one repo
    // must not delete the other repo's in-flight run record or its resume state.
    const runFor = (runId: string, repo: string): OnboardingRun =>
      buildOnboardingRun({
        runId,
        workspaceId: "ws_1",
        repositoryRoot: repo,
        now: "2026-06-26T00:00:00.000Z",
        documentationTargets: [],
        historyEvidence: [],
      });
    writeRunRecord(home, runFor("intel-old", "/repoB"));
    writeRunRecord(home, runFor("mono-old", "/repoA"));
    writeRunRecord(home, runFor("mono-current", "/repoA"));
    // a resume-state sidecar for the other repo's run must survive too
    const sidecar = join(runsDir(home, "ws_1"), "intel-old.state.json");
    writeFileSync(sidecar, JSON.stringify({ runId: "intel-old", schemaVersion: 1 }), "utf8");

    const removed = pruneOldRuns(home, "ws_1", "mono-current", "/repoA");
    expect(removed).toBe(1); // only mono-old (same repo, older)
    expect(loadRunRecord(home, "ws_1", "mono-current")).not.toBeNull();
    expect(loadRunRecord(home, "ws_1", "mono-old")).toBeNull();
    expect(loadRunRecord(home, "ws_1", "intel-old")).not.toBeNull(); // other repo untouched
    expect(existsSync(sidecar)).toBe(true); // other repo's resume state preserved
  });

  it("drops the paired state sidecar when it prunes a same-repo old run", () => {
    writeRunRecord(home, run("old-1"));
    writeRunRecord(home, run("current"));
    const sidecar = join(runsDir(home, "ws_1"), "old-1.state.json");
    writeFileSync(sidecar, JSON.stringify({ runId: "old-1", schemaVersion: 1 }), "utf8");
    pruneOldRuns(home, "ws_1", "current", "/repo");
    expect(loadRunRecord(home, "ws_1", "old-1")).toBeNull();
    expect(existsSync(sidecar)).toBe(false);
  });

  it("prune is a no-op when the dir does not exist", () => {
    expect(pruneOldRuns(home, "never", "x", "/repo")).toBe(0);
  });
});

describe("createPlan", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-enrich-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("assembles, persists, and prunes in one shot", () => {
    // seed a stale record that should be pruned
    writeRunRecord(
      home,
      buildOnboardingRun({
        runId: "stale",
        workspaceId: "ws_1",
        repositoryRoot: "/repo",
        now: "2026-06-25T00:00:00.000Z",
        documentationTargets: [],
        historyEvidence: [],
      }),
    );

    const { run, recordPath, pruned } = createPlan({
      runId: "fresh",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      home,
      now: "2026-06-26T00:00:00.000Z",
      gitRunner: fakeGit(["CLAUDE.md", "notes/x.md"]),
    });

    expect(existsSync(recordPath)).toBe(true);
    expect(recordPath).toBe(runRecordPath(home, "ws_1", "fresh"));
    expect(run.documentationTargets.map((t) => t.path)).toEqual(["CLAUDE.md", "notes/x.md"]);
    expect(run.historyEvidence).toHaveLength(2);
    expect(run.planDigest).toBe(computePlanDigest(run));
    expect(pruned).toBe(1);
    expect(loadRunRecord(home, "ws_1", "stale")).toBeNull();
  });
});

// A git runner that answers ONLY the two identity probes (rev-parse HEAD, rev-list root),
// so we can assert readGitIdentity in isolation from ls-files / log.
const fakeIdentityGit = (opts: {
  head?: string | Error;
  roots?: string[] | Error;
}): GitRunner => {
  return (args) => {
    if (args[0] === "rev-parse") {
      if (opts.head instanceof Error) throw opts.head;
      return `${opts.head ?? ""}\n`;
    }
    if (args[0] === "rev-list") {
      if (opts.roots instanceof Error) throw opts.roots;
      return `${(opts.roots ?? []).join("\n")}\n`;
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
};

describe("readGitIdentity", () => {
  const HEAD = "a".repeat(40);
  const ROOT_A = "b".repeat(40);
  const ROOT_B = "c".repeat(40);

  it("returns the lowercased 40-hex HEAD and the LAST root commit (git ... | tail -1)", () => {
    const id = readGitIdentity(fakeIdentityGit({ head: HEAD.toUpperCase(), roots: [ROOT_A, ROOT_B] }));
    expect(id.headCommit).toBe(HEAD); // lowercased
    expect(id.rootCommit).toBe(ROOT_B); // the oldest root when several exist (last line)
  });

  it("rejects a HEAD that is not a full 40-hex sha (abbreviated / non-sha => null)", () => {
    expect(readGitIdentity(fakeIdentityGit({ head: "abc1234", roots: [ROOT_A] })).headCommit).toBeNull();
    expect(readGitIdentity(fakeIdentityGit({ head: "not-a-sha", roots: [ROOT_A] })).headCommit).toBeNull();
  });

  it("fails soft when git has no HEAD (unborn branch): headCommit null, no throw", () => {
    const id = readGitIdentity(fakeIdentityGit({ head: new Error("fatal: bad revision 'HEAD'"), roots: [ROOT_A] }));
    expect(id.headCommit).toBeNull();
    expect(id.rootCommit).toBe(ROOT_A); // root probe is independent
  });

  it("fails soft when the root probe throws: rootCommit null, HEAD still resolved", () => {
    const id = readGitIdentity(fakeIdentityGit({ head: HEAD, roots: new Error("boom") }));
    expect(id.headCommit).toBe(HEAD);
    expect(id.rootCommit).toBeNull();
  });

  it("filters non-hex noise from the root listing", () => {
    const id = readGitIdentity(fakeIdentityGit({ head: HEAD, roots: ["", "garbage", ROOT_A] }));
    expect(id.rootCommit).toBe(ROOT_A);
  });

  it("is null/null outside a git repo (both probes throw)", () => {
    const id = readGitIdentity(fakeIdentityGit({ head: new Error("not a repo"), roots: new Error("not a repo") }));
    expect(id).toEqual({ headCommit: null, rootCommit: null });
  });
});

describe("buildPlan git identity", () => {
  const HEAD = "d".repeat(40);
  const ROOT = "e".repeat(40);

  // A runner covering all four probes buildPlan issues: ls-files, log, rev-parse, rev-list.
  const fullGit: GitRunner = (args) => {
    if (args[0] === "ls-files") return ["CLAUDE.md"].join("\n");
    if (args[0] === "log") return GIT_LOG_FIXTURE;
    if (args[0] === "rev-parse") return `${HEAD}\n`;
    if (args[0] === "rev-list") return `${ROOT}\n`;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };

  it("stamps the run with the git HEAD/root and keeps the digest independent of them", () => {
    const { run } = buildPlan({
      runId: "run-git",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: "2026-06-26T00:00:00.000Z",
      gitRunner: fullGit,
    });
    expect(run.headCommit).toBe(HEAD);
    expect(run.rootCommit).toBe(ROOT);
    // The gate keys on headCommit precisely BECAUSE the digest cannot: the digest excludes
    // head/root, so it stays stable when only the commit advances (and would differ across
    // clones by repositoryRoot). Its own integrity check must still hold.
    expect(run.planDigest).toBe(computePlanDigest(run));
  });

  it("tolerates a repo where the identity probes fail (null head/root, run still builds)", () => {
    const noId: GitRunner = (args) => {
      if (args[0] === "ls-files") return "CLAUDE.md";
      if (args[0] === "log") return GIT_LOG_FIXTURE;
      throw new Error("no identity here");
    };
    const { run } = buildPlan({
      runId: "run-noid",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: "2026-06-26T00:00:00.000Z",
      gitRunner: noId,
    });
    expect(run.headCommit).toBeNull();
    expect(run.rootCommit).toBeNull();
    expect(run.planDigest).toBe(computePlanDigest(run));
  });
});
