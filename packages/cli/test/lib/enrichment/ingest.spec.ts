import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestRun,
  loadState,
  renderCandidateDocument,
  CANDIDATE_DOC_SCHEMA_VERSION,
  verifyCandidate,
  defaultProbe,
  loadCandidatesSidecar,
  upsertCandidatesSidecar,
  candidatesSidecarPath,
  type FsProbe,
  type Persister,
  type PersistDocument,
} from "../../../src/lib/enrichment/ingest";
import { buildOnboardingRun, writeRunRecord, runRecordPath } from "../../../src/lib/enrichment/plan";
import {
  defaultLimits,
  candidateId,
  candidateRelPath,
  type DocumentationTarget,
  type EnrichmentCandidate,
  type EnrichmentLimits,
  type MergedCandidate,
  type PreparedGitEvidence,
  type OnboardingCandidateRecord,
  type OnboardingCandidatesSidecar,
} from "../../../src/lib/enrichment/protocol";

const NOW = "2026-06-26T12:00:00.000Z";
const ALLOWED_SHA = "a".repeat(40);

const ALLOWLIST_HISTORY: PreparedGitEvidence[] = [
  { commit: ALLOWED_SHA, timestamp: "2026-06-20T10:00:00+00:00", subject: "feat: x", body: "", changedFiles: [] },
];

// A permissive probe: everything tracked, realpath is identity (in-repo), files are long.
// Each test overrides only what it needs to flip a single verification check.
function makeProbe(over: Partial<FsProbe> = {}): FsProbe {
  return {
    repoRealpath: over.repoRealpath ?? "/repo",
    isTracked: over.isTracked ?? (() => true),
    realpath: over.realpath ?? ((abs) => abs),
    lineCount: over.lineCount ?? (() => 100_000),
  };
}

function seedRun(
  home: string,
  over: {
    runId?: string;
    workspaceId?: string;
    repositoryRoot?: string;
    documentationTargets?: DocumentationTarget[];
    historyEvidence?: PreparedGitEvidence[];
    limits?: EnrichmentLimits;
  } = {},
) {
  const run = buildOnboardingRun({
    runId: over.runId ?? "run-1",
    workspaceId: over.workspaceId ?? "ws_1",
    repositoryRoot: over.repositoryRoot ?? "/repo",
    now: NOW,
    limits: over.limits,
    documentationTargets: over.documentationTargets ?? [],
    historyEvidence: over.historyEvidence ?? ALLOWLIST_HISTORY,
  });
  writeRunRecord(home, run);
  return run;
}

const docCandidate = (over: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate => ({
  kind: "convention",
  statement: "Use 127.0.0.1 not localhost on macOS.",
  evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }],
  sourceScout: "documentation",
  ...over,
});

const histCandidate = (over: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate => ({
  kind: "decision",
  statement: "Removed the dogfood gate from control.",
  evidence: [{ type: "commit", commit: "aaaaaaa" }], // unambiguous prefix of ALLOWED_SHA
  sourceScout: "history",
  ...over,
});

// renderCandidateDocument now takes the MERGED shape (sourceScouts plural). A single-scout
// candidate is the degenerate merge of one wire candidate.
const asMerged = (c: EnrichmentCandidate): MergedCandidate => ({
  kind: c.kind,
  statement: c.statement,
  evidence: c.evidence,
  sourceScouts: [c.sourceScout],
  rationale: c.rationale ?? null,
  rationaleSource: c.rationaleSource ?? null,
});

function ingestArgs(home: string, runId: string, results: unknown[], probe?: FsProbe) {
  return {
    env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
    request: { protocolVersion: 1, runId, results },
    persist: jest.fn(async (docs: PersistDocument[]) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })),
    })) as unknown as Persister,
    now: NOW,
    probe: probe ?? makeProbe(),
  };
}

describe("ingestRun — top-level rejections", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a malformed envelope (bad protocolVersion)", async () => {
    seedRun(home);
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 2, runId: "run-1", results: [] },
      persist: jest.fn() as unknown as Persister,
      now: NOW,
      probe: makeProbe(),
    });
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toMatch(/protocolVersion/);
  });

  it("rejects an unknown runId", async () => {
    const res = await ingestRun(ingestArgs(home, "does-not-exist", []));
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toMatch(/unknown run/);
  });

  it("rejects a workspace mismatch", async () => {
    // record is written under ws_1; env claims ws_2 -> load under ws_2 misses entirely
    seedRun(home, { workspaceId: "ws_1" });
    const res = await ingestRun({
      ...ingestArgs(home, "run-1", []),
      env: { home, workspaceId: "ws_2", repositoryRoot: "/repo" },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toMatch(/unknown run/); // no record under ws_2
  });

  it("rejects a repository-root mismatch", async () => {
    seedRun(home, { repositoryRoot: "/repo" });
    const res = await ingestRun({
      ...ingestArgs(home, "run-1", []),
      env: { home, workspaceId: "ws_1", repositoryRoot: "/elsewhere" },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toMatch(/repository mismatch/);
  });

  it("rejects a corrupted run record (plan digest mismatch)", async () => {
    seedRun(home);
    const path = runRecordPath(home, "ws_1", "run-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.planDigest = "0".repeat(64); // tamper without touching ws/repo (checked first)
    writeFileSync(path, JSON.stringify(onDisk), "utf8");
    const res = await ingestRun(ingestArgs(home, "run-1", []));
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toMatch(/plan digest mismatch/);
  });
});

describe("ingestRun — candidate verification", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-"));
    seedRun(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const completeDoc = (candidates: unknown[]) => [{ scout: "documentation", status: "complete", candidates }];

  it("accepts a valid documentation candidate and persists it PENDING", async () => {
    const args = ingestArgs(home, "run-1", completeDoc([docCandidate()]));
    const res = await ingestRun(args);
    expect(res.ok).toBe(true);
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc).toMatchObject({ received: 1, accepted: 1, rejected: 0, persisted: 1 });
    expect(args.persist).toHaveBeenCalledTimes(1);
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs[0].relPath).toBe(candidateRelPath(docCandidate()));
    expect(docs[0].content).toContain("127.0.0.1");
  });

  it("rejects an untracked file path (does not exist at HEAD)", async () => {
    const probe = makeProbe({ isTracked: () => false });
    const res = await ingestRun(ingestArgs(home, "run-1", completeDoc([docCandidate()]), probe));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.accepted).toBe(0);
    expect(doc.errors.map((e) => e.code)).toContain("untracked_path");
  });

  it("rejects a path-traversal escape", async () => {
    const cand = docCandidate({ evidence: [{ type: "file", path: "../etc/passwd", startLine: 1, endLine: 2 }] });
    const res = await ingestRun(ingestArgs(home, "run-1", completeDoc([cand])));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.errors.map((e) => e.code)).toContain("path_traversal");
  });

  it("rejects a symlink that resolves outside the repo", async () => {
    const probe = makeProbe({ realpath: (abs) => (abs.includes("link.md") ? "/outside/secret" : abs) });
    const cand = docCandidate({ evidence: [{ type: "file", path: "link.md", startLine: 1, endLine: 2 }] });
    const res = await ingestRun(ingestArgs(home, "run-1", completeDoc([cand]), probe));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.errors.map((e) => e.code)).toContain("escapes_repo");
  });

  it("rejects a line range beyond the file length", async () => {
    const probe = makeProbe({ lineCount: () => 5 });
    const res = await ingestRun(ingestArgs(home, "run-1", completeDoc([docCandidate()]), probe));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.errors.map((e) => e.code)).toContain("line_out_of_range");
  });

  it("rejects a history candidate citing a commit outside the allowlist", async () => {
    const cand = histCandidate({ evidence: [{ type: "commit", commit: "bbbbbbb" }] });
    const results = [{ scout: "history", status: "complete", candidates: [cand] }];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(hist.accepted).toBe(0);
    expect(hist.errors.map((e) => e.code)).toContain("commit_not_in_allowlist");
  });

  it("accepts a history candidate citing an allowlisted commit prefix", async () => {
    const results = [{ scout: "history", status: "complete", candidates: [histCandidate()] }];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(hist).toMatchObject({ accepted: 1, persisted: 1 });
  });
});

describe("ingestRun — orchestration", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("marks status complete only when both scouts complete; writes state", async () => {
    seedRun(home);
    const results = [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    expect(res.state?.status).toBe("complete");
    expect(res.state?.scouts.documentation.status).toBe("complete");
    expect(res.state?.scouts.history.status).toBe("complete");
    expect(loadState(home, "ws_1", "run-1")?.status).toBe("complete");
  });

  it("keys completion state by runId so a second repo in the same workspace is not skipped", async () => {
    // Regression (multi-repo): a workspace can bind more than one repo (the Meetless
    // monorepo and intel share one). State was once a per-workspace singleton, so the
    // first repo's "complete" made every later repo's scouts skip with already_complete.
    // Each repo onboards under its own run; completing run-A must not touch run-B's state.
    seedRun(home, { runId: "run-A", repositoryRoot: "/repoA" });
    seedRun(home, { runId: "run-B", repositoryRoot: "/repoB" });

    const completeBoth = (runId: string, repo: string) =>
      ingestRun({
        env: { home, workspaceId: "ws_1", repositoryRoot: repo },
        request: {
          protocolVersion: 1,
          runId,
          results: [
            { scout: "documentation", status: "complete", candidates: [docCandidate()] },
            { scout: "history", status: "complete", candidates: [histCandidate()] },
          ],
        },
        persist: jest.fn(async (docs: PersistDocument[]) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })),
    })) as unknown as Persister,
        now: NOW,
        probe: makeProbe(),
      });

    const a = await completeBoth("run-A", "/repoA");
    expect(a.state?.status).toBe("complete");
    // run-B has not run yet: its state is absent, NOT inherited from run-A.
    expect(loadState(home, "ws_1", "run-B")).toBeNull();

    const b = await completeBoth("run-B", "/repoB");
    const docB = b.outcomes.find((o) => o.scout === "documentation")!;
    const histB = b.outcomes.find((o) => o.scout === "history")!;
    // The second repo's scouts actually ran and persisted; nothing was skipped.
    expect(docB.errors.map((e) => e.code)).not.toContain("already_complete");
    expect(histB.errors.map((e) => e.code)).not.toContain("already_complete");
    expect(docB.persisted + histB.persisted).toBe(2);
    expect(b.state?.status).toBe("complete");
    // The two repos hold independent state side by side.
    expect(loadState(home, "ws_1", "run-A")?.status).toBe("complete");
    expect(loadState(home, "ws_1", "run-B")?.status).toBe("complete");
  });

  it("marks status partial when a scout reports it did not finish; persists nothing for it", async () => {
    seedRun(home);
    const args = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "timed_out", candidates: [], error: "budget exceeded" },
    ]);
    const res = await ingestRun(args);
    expect(res.state?.status).toBe("partial");
    expect(res.state?.scouts.history.status).toBe("timed_out");
    // only the documentation scout's doc was persisted
    expect(args.persist).toHaveBeenCalledTimes(1);
  });

  it("does not re-process a scout already complete on rerun (resume)", async () => {
    seedRun(home);
    // run 1: doc complete, history failed
    const first = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "failed", candidates: [], error: "git error" },
    ]);
    await ingestRun(first);
    expect(first.persist).toHaveBeenCalledTimes(1);

    // run 2: doc re-reported (must be SKIPPED), history now complete
    const second = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]);
    const res = await ingestRun(second);
    expect(res.state?.status).toBe("complete");
    const docOut = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(docOut.errors.map((e) => e.code)).toContain("already_complete");
    // only the history doc persisted in run 2; documentation skipped
    expect(second.persist).toHaveBeenCalledTimes(1);
    const docs = (second.persist as jest.Mock).mock.calls[0][0];
    expect(docs[0].content).toContain("dogfood gate");
  });

  it("enforces the run-wide candidate cap", async () => {
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesTotal: 1 } });
    const results = [
      {
        scout: "documentation",
        status: "complete",
        candidates: [docCandidate(), docCandidate({ statement: "Second distinct convention here." })],
      },
    ];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.accepted).toBe(1);
    expect(doc.rejected).toBe(1);
    expect(doc.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("caps each scout independently at the per-scout cap, no reallocation (verdict item 8)", async () => {
    // Each scout gets its OWN cap, not a share of a pooled total. With a per-scout cap of 1
    // and a non-binding run total of 20, both scouts produce 2 and each keeps exactly 1 of
    // its own; neither can starve the other (the old fair-share pool let the first slot
    // swallow a tiny shared total and starve the second).
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesPerScout: 1, maxCandidatesTotal: 20 } });
    const results = [
      {
        scout: "documentation",
        status: "complete",
        candidates: [docCandidate(), docCandidate({ statement: "Second distinct doc convention." })],
      },
      {
        scout: "history",
        status: "complete",
        candidates: [histCandidate(), histCandidate({ statement: "Second distinct history decision." })],
      },
    ];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(doc.accepted).toBe(1);
    expect(hist.accepted).toBe(1);
    expect(doc.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
    expect(hist.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("does NOT reallocate an under-producing scout's surplus to the other scout (verdict item 8)", async () => {
    // Inverse of the retired fair-share behavior. Per-scout cap 2, total 20 (non-binding).
    // documentation sends 1 (under its own cap of 2), history sends 3. The unused
    // documentation slot must NOT flow to history: history is still bounded at its own 2,
    // so it keeps 2 and rejects 1 (it would have kept all 3 under the old reallocation).
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesPerScout: 2, maxCandidatesTotal: 20 } });
    const results = [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      {
        scout: "history",
        status: "complete",
        candidates: [
          histCandidate(),
          histCandidate({ statement: "Second distinct history decision." }),
          histCandidate({ statement: "Third distinct history decision." }),
        ],
      },
    ];
    const res = await ingestRun(ingestArgs(home, "run-1", results));
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(doc.accepted).toBe(1);
    expect(doc.rejected).toBe(0);
    expect(hist.accepted).toBe(2); // <- was 3 under the old surplus-redistribution
    expect(hist.rejected).toBe(1);
    expect(hist.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("counts a prior-complete scout's candidates against the run-total backstop on resume", async () => {
    // The run-total backstop (not the per-scout cap) still bounds resume. Run 1:
    // documentation completes with 2 candidates. Run 2: history arrives with a per-scout
    // cap of 2 but only 1 slot left under the run total of 3 (3 - 2 prior), so it keeps 1.
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesPerScout: 2, maxCandidatesTotal: 3 } });
    await ingestRun(
      ingestArgs(home, "run-1", [
        {
          scout: "documentation",
          status: "complete",
          candidates: [docCandidate(), docCandidate({ statement: "Second distinct doc convention." })],
        },
      ]),
    );
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        {
          scout: "history",
          status: "complete",
          candidates: [
            histCandidate(),
            histCandidate({ statement: "Second distinct history decision." }),
            histCandidate({ statement: "Third distinct history decision." }),
          ],
        },
      ]),
    );
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(hist.accepted).toBe(1);
    expect(hist.rejected).toBe(2);
    expect(hist.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("dedups identical candidates to one persisted document", async () => {
    seedRun(home);
    const args = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate(), docCandidate()] },
    ]);
    const res = await ingestRun(args);
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.accepted).toBe(2); // both pass validation
    expect(doc.persisted).toBe(1); // collapsed to one unique document
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs).toHaveLength(1);
  });

  it("merges an exact cross-scout duplicate into ONE document citing both anchors (verdict item 9)", async () => {
    seedRun(home);
    const statement = "Removed the dogfood gate from control.";
    const args = ingestArgs(home, "run-1", [
      {
        scout: "documentation",
        status: "complete",
        candidates: [
          docCandidate({ kind: "decision", statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }] }),
        ],
      },
      {
        scout: "history",
        status: "complete",
        candidates: [histCandidate({ kind: "decision", statement, evidence: [{ type: "commit", commit: "aaaaaaa" }] })],
      },
    ]);
    const res = await ingestRun(args);
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    // Each scout accepted its own candidate, but the two collapse to ONE persisted document.
    expect(doc.accepted).toBe(1);
    expect(hist.accepted).toBe(1);
    expect(args.persist).toHaveBeenCalledTimes(1);
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs).toHaveLength(1);
    // The merged document carries BOTH anchors and names both scouts.
    expect(docs[0].content).toContain("`CLAUDE.md` lines 10-20");
    expect(docs[0].content).toContain("commit `aaaaaaa`");
    expect(docs[0].content).toContain("documentation + history scouts");
    // The shared document counts toward each contributing scout's persisted tally.
    expect(doc.persisted).toBe(1);
    expect(hist.persisted).toBe(1);
  });

  it("merges a statement one scout emitted twice with DIFFERENT anchors, unioning them (verdict item 9)", async () => {
    // Stronger than the byte-identical dedup above: same kind + statement, different line
    // ranges. The anchor-insensitive dedupKey collapses them while the union keeps both
    // anchors (candidateId already strips line numbers, so the id is unchanged either way).
    seedRun(home);
    const statement = "Use 127.0.0.1 not localhost on macOS.";
    const args = ingestArgs(home, "run-1", [
      {
        scout: "documentation",
        status: "complete",
        candidates: [
          docCandidate({ statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }] }),
          docCandidate({ statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 30, endLine: 40 }] }),
        ],
      },
    ]);
    const res = await ingestRun(args);
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.accepted).toBe(2);
    expect(doc.persisted).toBe(1);
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("`CLAUDE.md` lines 10-20");
    expect(docs[0].content).toContain("`CLAUDE.md` lines 30-40");
  });

  it("does NOT merge across ingest calls: a resuming scout's duplicate persists on its own (verdict item 9)", async () => {
    seedRun(home);
    const statement = "Removed the dogfood gate from control.";
    // Run 1: documentation completes with the statement (file anchor); history fails.
    const first = ingestArgs(home, "run-1", [
      {
        scout: "documentation",
        status: "complete",
        candidates: [
          docCandidate({ kind: "decision", statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }] }),
        ],
      },
      { scout: "history", status: "failed", candidates: [], error: "git error" },
    ]);
    await ingestRun(first);
    expect(first.persist).toHaveBeenCalledTimes(1);

    // Run 2 (resume): history emits the SAME statement. documentation is already complete from
    // the prior call, so the two never fold; history persists its own (commit-anchored) doc.
    const second = ingestArgs(home, "run-1", [
      {
        scout: "history",
        status: "complete",
        candidates: [histCandidate({ kind: "decision", statement, evidence: [{ type: "commit", commit: "aaaaaaa" }] })],
      },
    ]);
    const res = await ingestRun(second);
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(hist.accepted).toBe(1);
    expect(hist.persisted).toBe(1);
    expect(second.persist).toHaveBeenCalledTimes(1);
    const docs = (second.persist as jest.Mock).mock.calls[0][0];
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("commit `aaaaaaa`");
    expect(docs[0].content).toContain("history scout");
    expect(docs[0].content).not.toContain("documentation + history");
  });

  it("orders merged sourceScouts by slot, not by the results array order (verdict item 9 determinism)", async () => {
    seedRun(home);
    const statement = "Removed the dogfood gate from control.";
    // history listed FIRST, documentation second; the merged label must still be slot-ordered.
    const args = ingestArgs(home, "run-1", [
      {
        scout: "history",
        status: "complete",
        candidates: [histCandidate({ kind: "decision", statement, evidence: [{ type: "commit", commit: "aaaaaaa" }] })],
      },
      {
        scout: "documentation",
        status: "complete",
        candidates: [
          docCandidate({ kind: "decision", statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }] }),
        ],
      },
    ]);
    await ingestRun(args);
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain("documentation + history scouts");
    expect(docs[0].content).not.toContain("history + documentation");
  });

  it("fills an empty rationale from a later duplicate, deterministically by slot (verdict item 9)", async () => {
    seedRun(home);
    const statement = "Removed the dogfood gate from control.";
    const args = ingestArgs(home, "run-1", [
      {
        scout: "documentation",
        status: "complete",
        candidates: [
          docCandidate({ kind: "decision", statement, evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }] }),
        ],
      },
      {
        scout: "history",
        status: "complete",
        candidates: [
          histCandidate({
            kind: "decision",
            statement,
            evidence: [{ type: "commit", commit: "aaaaaaa" }],
            rationale: "ramped adoption from soft gate to hard gate",
            rationaleSource: "AGENT_SUMMARY",
          }),
        ],
      },
    ]);
    await ingestRun(args);
    const docs = (args.persist as jest.Mock).mock.calls[0][0];
    expect(docs[0].content).toContain("ramped adoption from soft gate to hard gate");
    expect(docs[0].content).toContain("## Rationale (agent summary; not the user's words)");
  });

  it("does not call the persister when a scout yields zero accepted candidates", async () => {
    seedRun(home);
    const probe = makeProbe({ isTracked: () => false }); // every doc candidate rejected
    const args = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
    ], probe);
    const res = await ingestRun(args);
    expect(args.persist).not.toHaveBeenCalled();
    // the scout still ran successfully; its candidates were merely all rejected
    expect(res.state?.scouts.documentation.status).toBe("complete");
  });

  it("records persistence_failed when the kb-add POST throws", async () => {
    seedRun(home);
    const failing: Persister = jest.fn(async () => {
      throw new Error("intel unreachable");
    });
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: failing,
      now: NOW,
      probe: makeProbe(),
    });
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");
  });

  it("records a malformed scout envelope without discarding the run", async () => {
    seedRun(home);
    const res = await ingestRun(ingestArgs(home, "run-1", [{ scout: "documentation", status: "bogus", candidates: [] }]));
    expect(res.ok).toBe(true);
    expect(res.state?.scouts.documentation.status).toBe("malformed");
    const out = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(out.errors.map((e) => e.code)).toContain("malformed_envelope");
  });

  // Idempotency: a re-run of an unchanged repo dedups server-side (noop_unchanged). The doc
  // still LANDED born PENDING (it counts toward `persisted`), but `deduped` records that it was
  // already present, so the summary can honestly say "already present" instead of "new".
  it("counts a server noop_unchanged outcome as deduped, still persisted", async () => {
    seedRun(home);
    const deduping: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "noop_unchanged" as const })),
    }));
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: deduping,
      now: NOW,
      probe: makeProbe(),
    });
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(1); // it landed (born PENDING already in the KB)
    expect(doc.deduped).toBe(1); // ...but it was already present, not new
    expect(res.state?.scouts.documentation.status).toBe("complete");
  });

  // A 200 can still carry a per-document failure (kb_add.py appends a failed receipt and keeps
  // going). That doc landed for nobody: it counts toward neither persisted nor deduped, and is
  // surfaced as a persistence_partial error, but it does NOT flip the scout to persistence_failed
  // (that status is reserved for a whole-POST failure that warrants a retry).
  it("treats a per-document failed receipt as not persisted and surfaces it", async () => {
    seedRun(home);
    const partial: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "failed" as const })),
    }));
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: partial,
      now: NOW,
      probe: makeProbe(),
    });
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(0);
    expect(doc.deduped).toBe(0);
    expect(doc.errors.map((e) => e.code)).toContain("persistence_partial");
    expect(res.state?.scouts.documentation.status).toBe("complete");
  });

  // A receipt-count mismatch (the server returned more/fewer outcomes than documents sent) is a
  // contract violation we refuse to interpret: attributing outcomes by index would mis-report.
  // Treat it as a whole-POST failure rather than emit a confident wrong tally.
  it("treats a receipt-count mismatch as a whole-POST persistence failure", async () => {
    seedRun(home);
    const shortResponse: Persister = jest.fn(async () => ({ docs: [] }));
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: shortResponse,
      now: NOW,
      probe: makeProbe(),
    });
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");
  });
});

describe("renderCandidateDocument", () => {
  it("emits versioned onboarding-candidate frontmatter and a # Candidate / ## Evidence / ## Status body", () => {
    const md = renderCandidateDocument(
      asMerged(docCandidate({ evidence: [{ type: "file", path: "CLAUDE.md", startLine: 3, endLine: 9 }] })),
    );
    // Frontmatter is the deterministic machine header the scout never authors (verdict item 10).
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("mlaGenerated: onboarding-candidate");
    expect(md).toContain(`schemaVersion: ${CANDIDATE_DOC_SCHEMA_VERSION}`);
    expect(md).toContain("kind: convention");
    expect(md).toContain("sourceScouts: [documentation]");
    expect(md).toContain("reviewHint: provisional");
    // Body skeleton.
    expect(md).toContain("# Candidate");
    expect(md).toContain("127.0.0.1");
    expect(md).toContain("## Evidence");
    expect(md).toContain("`CLAUDE.md` lines 3-9");
    expect(md).toContain("## Status");
  });

  it("carries a frontmatter candidateId equal to the candidate's identity (the same id its relPath uses)", () => {
    const c = asMerged(docCandidate());
    const md = renderCandidateDocument(c);
    expect(md).toContain(`candidateId: ${candidateId(c)}`);
  });

  // Verdict item 7 reconciliation: the frontmatter keys must not trip the two scanners that
  // read frontmatter, and governance status stays server-authoritative (no asserted outcome).
  it("uses keys that neither auto-capture nor stale-detection act on, and asserts no outcome", () => {
    const md = renderCandidateDocument(asMerged(docCandidate()));
    // auto-capture captures `metadata.type == project`; we emit `kind:`, never a type key or metadata block.
    expect(md).not.toMatch(/^type:/m);
    expect(md).not.toMatch(/^metadata:/m);
    // stale-detection acts on `status: deprecated|superseded|rejected`; we never emit a status key.
    expect(md).not.toMatch(/^status:/m);
    // The server owns the governance outcome; the file never claims one.
    expect(md).not.toMatch(/reviewOutcome:/);
  });

  it("renders a single-scout source label in the singular", () => {
    const md = renderCandidateDocument(asMerged(docCandidate()));
    expect(md).toContain("Surfaced by the documentation scout (onboarding enrichment, advisory).");
    // The only plural "scouts" is the frontmatter key; the human body label stays singular.
    expect(md).not.toContain("scouts (onboarding");
  });

  it("renders a both-scouts source label naming each contributing scout (verdict item 9)", () => {
    const md = renderCandidateDocument({
      kind: "decision",
      statement: "Removed the dogfood gate from control.",
      evidence: [
        { type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 },
        { type: "commit", commit: "abcdef0" },
      ],
      sourceScouts: ["documentation", "history"],
      rationale: null,
      rationaleSource: null,
    });
    expect(md).toContain("documentation + history scouts");
    expect(md).toContain("sourceScouts: [documentation, history]");
  });

  it("renders commit evidence", () => {
    const md = renderCandidateDocument(asMerged(histCandidate({ evidence: [{ type: "commit", commit: "abcdef0", path: "control/x.ts" }] })));
    expect(md).toContain("commit `abcdef0`");
    expect(md).toContain("control/x.ts");
  });

  // The persisted artifact must label rationale provenance so a human reviewer can never
  // mistake an agent's paraphrase for the user's own words (memo Phase 1).
  it("labels a USER_EXPLICIT rationale as the user's stated reason", () => {
    const md = renderCandidateDocument(
      asMerged(docCandidate({ rationale: "the user said so", rationaleSource: "USER_EXPLICIT" })),
    );
    expect(md).toContain("## Rationale (user-stated)");
    expect(md).toContain("the user said so");
  });

  it("labels an AGENT_SUMMARY rationale as the agent's paraphrase, not the user's words", () => {
    const md = renderCandidateDocument(
      asMerged(docCandidate({ rationale: "scout distilled this", rationaleSource: "AGENT_SUMMARY" })),
    );
    expect(md).toContain("## Rationale (agent summary; not the user's words)");
    expect(md).toContain("scout distilled this");
  });

  it("omits the rationale section entirely when there is none (missing beats fabricated)", () => {
    const md = renderCandidateDocument(asMerged(docCandidate()));
    expect(md).not.toContain("## Rationale");
  });
});

describe("verifyCandidate (unit)", () => {
  const run = buildOnboardingRun({
    runId: "r",
    workspaceId: "ws_1",
    repositoryRoot: "/repo",
    now: NOW,
    documentationTargets: [],
    historyEvidence: ALLOWLIST_HISTORY,
  });

  it("returns no errors for a fully valid candidate", () => {
    expect(verifyCandidate(docCandidate(), run, makeProbe(), 0)).toEqual([]);
  });

  it("collects errors across multiple bad anchors", () => {
    const cand = docCandidate({
      evidence: [
        { type: "file", path: "../escape", startLine: 1, endLine: 2 },
        { type: "commit", commit: "fedcba9" }, // not allowlisted
      ],
    });
    const errs = verifyCandidate(cand, run, makeProbe(), 0);
    expect(errs.map((e) => e.code).sort()).toEqual(["commit_not_in_allowlist", "path_traversal"]);
  });
});

describe("defaultProbe (real fs + injected git)", () => {
  it("reports tracked membership and real line counts against this repo", () => {
    // exercise the real probe end-to-end with an injected ls-files so it is deterministic
    const probe = defaultProbe(process.cwd(), (args) => {
      if (args[0] === "ls-files") return "package.json\n";
      throw new Error(`unexpected: ${args.join(" ")}`);
    });
    expect(probe.isTracked("package.json")).toBe(true);
    expect(probe.isTracked("nope.xyz")).toBe(false);
    const abs = join(probe.repoRealpath, "package.json");
    expect(probe.lineCount(abs)).toBeGreaterThan(0);
  });
});

// The per-run candidates sidecar is the bridge that lets `enrich accept` materialize a run's
// durable rules after ingest. These pin the two behaviors that make it safe to read later:
// upsert MERGES by candidateId (a resuming scout appends, never clobbers the first scout's
// candidates), and load is fail-closed (a corrupt / foreign / stale-schema sidecar reads as
// "no candidates", never as another run's rules).
describe("candidates sidecar IO", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-sidecar-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const record = (over: Partial<OnboardingCandidateRecord> = {}): OnboardingCandidateRecord => ({
    candidateId: "a".repeat(64),
    kind: "constraint",
    statement: "Use 127.0.0.1, not localhost, on macOS.",
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
    sourceScouts: ["documentation"],
    rationale: null,
    rationaleSource: null,
    relPath: "onboarding/x.md",
    landed: "ingested",
    ...over,
  });

  const sidecar = (over: Partial<OnboardingCandidatesSidecar> = {}): OnboardingCandidatesSidecar => ({
    schemaVersion: 1,
    workspaceId: "ws_1",
    runId: "run-1",
    repositoryRoot: "/repo",
    updatedAt: NOW,
    candidates: [record()],
    ...over,
  });

  it("returns null when the sidecar file does not exist", () => {
    expect(loadCandidatesSidecar(home, "ws_1", "run-1")).toBeNull();
  });

  it("round-trips a written sidecar", () => {
    upsertCandidatesSidecar(home, sidecar());
    const loaded = loadCandidatesSidecar(home, "ws_1", "run-1");
    expect(loaded?.candidates).toHaveLength(1);
    expect(loaded?.candidates[0].statement).toBe("Use 127.0.0.1, not localhost, on macOS.");
    expect(loaded?.repositoryRoot).toBe("/repo");
  });

  it("MERGES by candidateId across calls: a resuming scout appends, never clobbers", () => {
    // First scout's candidate.
    upsertCandidatesSidecar(home, sidecar({ candidates: [record({ candidateId: "a".repeat(64) })] }));
    // Second scout resumes in a LATER call with the first already persisted; a blind overwrite
    // would drop scout A. The merge keeps both.
    upsertCandidatesSidecar(
      home,
      sidecar({
        candidates: [record({ candidateId: "b".repeat(64), statement: "Never git add -A here." })],
      }),
    );
    const loaded = loadCandidatesSidecar(home, "ws_1", "run-1");
    expect(loaded?.candidates).toHaveLength(2);
    expect(loaded?.candidates.map((c) => c.candidateId).sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("overwrites a repeated candidateId in place so the latest landed outcome wins", () => {
    upsertCandidatesSidecar(home, sidecar({ candidates: [record({ candidateId: "a".repeat(64), landed: "failed" })] }));
    upsertCandidatesSidecar(home, sidecar({ candidates: [record({ candidateId: "a".repeat(64), landed: "ingested" })] }));
    const loaded = loadCandidatesSidecar(home, "ws_1", "run-1");
    expect(loaded?.candidates).toHaveLength(1);
    expect(loaded?.candidates[0].landed).toBe("ingested");
  });

  it("reads null on a schemaVersion mismatch (never materializes an unknown-shape sidecar)", () => {
    upsertCandidatesSidecar(home, sidecar());
    const path = candidatesSidecarPath(home, "ws_1", "run-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.schemaVersion = 2;
    writeFileSync(path, JSON.stringify(onDisk), "utf8");
    expect(loadCandidatesSidecar(home, "ws_1", "run-1")).toBeNull();
  });

  it("reads null when the stored runId drifted from the path (corruption / hand-edit)", () => {
    upsertCandidatesSidecar(home, sidecar());
    const path = candidatesSidecarPath(home, "ws_1", "run-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.runId = "run-999";
    writeFileSync(path, JSON.stringify(onDisk), "utf8");
    expect(loadCandidatesSidecar(home, "ws_1", "run-1")).toBeNull();
  });

  it("reads null when candidates is not an array", () => {
    upsertCandidatesSidecar(home, sidecar());
    const path = candidatesSidecarPath(home, "ws_1", "run-1");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.candidates = { not: "an array" };
    writeFileSync(path, JSON.stringify(onDisk), "utf8");
    expect(loadCandidatesSidecar(home, "ws_1", "run-1")).toBeNull();
  });

  it("reads null on malformed JSON rather than throwing", () => {
    upsertCandidatesSidecar(home, sidecar());
    writeFileSync(candidatesSidecarPath(home, "ws_1", "run-1"), "{ not json", "utf8");
    expect(loadCandidatesSidecar(home, "ws_1", "run-1")).toBeNull();
  });
});

// The wiring that makes accept reachable at all: a successful ingest must leave a sidecar the
// accept command can later read. Without this, ingested rule-looking candidates would land in
// the governed KB with no local path to `.meetless/rules.md` (the bug this whole change fixes).
describe("ingestRun writes the candidates sidecar", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-sidecar-"));
    seedRun(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const completeDoc = (candidates: unknown[]) => [{ scout: "documentation", status: "complete", candidates }];

  it("parks the persisted candidate in a sidecar keyed by workspace + runId", async () => {
    const res = await ingestRun(ingestArgs(home, "run-1", completeDoc([docCandidate({ kind: "constraint" })])));
    expect(res.ok).toBe(true);
    const loaded = loadCandidatesSidecar(home, "ws_1", "run-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.candidates).toHaveLength(1);
    expect(loaded?.candidates[0].kind).toBe("constraint");
    expect(loaded?.candidates[0].statement).toBe("Use 127.0.0.1 not localhost on macOS.");
    expect(loaded?.repositoryRoot).toBe("/repo");
  });
});
