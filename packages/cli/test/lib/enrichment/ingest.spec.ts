import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestRun,
  loadState,
  writeState,
  renderCandidateDocument,
  CANDIDATE_DOC_SCHEMA_VERSION,
  verifyCandidate,
  defaultProbe,
  loadCandidatesSidecar,
  upsertCandidatesSidecar,
  candidatesSidecarPath,
  PERSIST_BATCH_SIZE,
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

  it("does not mark a scout complete when every candidate it sent was rejected", async () => {
    // Regression (prod, 2026-07-14): a doc scout sent 10 candidates and every one was
    // rejected (each omitted `sourceScout`). received=10, accepted=0, persisted=0 — zero
    // progress — yet the scout was still stamped `complete`, because completion keyed off
    // "did anything fail to persist?" and nothing had been *offered* to persist. Resume
    // skips complete scouts, so the corrected candidates could never be re-ingested: the
    // run was permanently stranded with no recovery path. A scout that put candidates on
    // the wire and landed none of them has made no progress and MUST stay retryable.
    seedRun(home);
    const bad = { ...docCandidate(), sourceScout: undefined };
    const first = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [bad, bad] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]);
    const firstRes = await ingestRun(first);

    const docFirst = firstRes.outcomes.find((o) => o.scout === "documentation")!;
    expect(docFirst).toMatchObject({ received: 2, accepted: 0, persisted: 0 });
    // The whole point: total rejection is NOT completion.
    expect(firstRes.state?.scouts.documentation.status).not.toBe("complete");
    expect(firstRes.state?.status).not.toBe("complete");

    // Rerun with the corrected candidates: they must actually land, not be skipped.
    const second = ingestArgs(home, "run-1", [
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]);
    const res = await ingestRun(second);
    const docOut = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(docOut.errors.map((e) => e.code)).not.toContain("already_complete");
    expect(docOut).toMatchObject({ received: 1, accepted: 1, persisted: 1 });
    expect(res.state?.scouts.documentation.status).toBe("complete");
    expect(res.state?.status).toBe("complete");
  });

  it("discards a v1 state file rather than resuming it, so a run stranded by the v1 bug re-runs", async () => {
    // The recovery path for runs already stranded on disk before the fix. Their state says
    // `documentation: complete` with zero candidates landed; nothing in v2's write path can
    // repair a file it never wrote. Because v1 and v2 disagree about what `complete` MEANS,
    // loadState refuses the v1 file, the scouts re-run, and the corrected candidates land.
    const run = seedRun(home);
    writeState(home, {
      workspaceId: "ws_1",
      runId: "run-1",
      repositoryRoot: "/repo",
      schemaVersion: 1 as unknown as 2, // the stranded v1 shape, exactly as An's run has it
      status: "partial",
      updatedAt: NOW,
      scouts: {
        documentation: { status: "complete", candidateCount: 0 }, // landed nothing, skipped forever
        history: { status: "persistence_failed", error: "kb-add persistence failed" },
      },
    } as unknown as Parameters<typeof writeState>[1]);
    expect(loadState(home, "ws_1", "run-1")).toBeNull(); // refused, not resumed
    expect(run.runId).toBe("run-1");

    // The documentation scout is therefore runnable again: its candidates actually land.
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: [docCandidate()] },
        { scout: "history", status: "complete", candidates: [histCandidate()] },
      ]),
    );
    const docOut = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(docOut.errors.map((e) => e.code)).not.toContain("already_complete");
    expect(docOut).toMatchObject({ received: 1, accepted: 1, persisted: 1 });
    expect(res.state?.status).toBe("complete");
    expect(loadState(home, "ws_1", "run-1")?.schemaVersion).toBe(2);
  });

  it("keeps a scout complete when it genuinely had nothing to say (zero candidates)", async () => {
    // The counterpart to the test above, and the reason the rule is `received > 0`, not
    // `accepted === 0`. A scout that legitimately finds nothing worth governing sends zero
    // candidates. That IS a finished scout. If it were left retryable, the run would never
    // reach `complete` and the run-level idempotency gate (findCompletedRunWithDigest)
    // would re-run a finished onboarding forever.
    seedRun(home);
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: [] },
        { scout: "history", status: "complete", candidates: [histCandidate()] },
      ]),
    );
    const docOut = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(docOut).toMatchObject({ received: 0, accepted: 0, persisted: 0 });
    expect(res.state?.scouts.documentation.status).toBe("complete");
    expect(res.state?.status).toBe("complete");
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
    // ...but the scout is NOT done. It offered candidates and landed none, so it stays
    // retryable. (This assertion used to read `complete`, on the reasoning that "the scout
    // still ran successfully; its candidates were merely all rejected" — which pinned the
    // prod bug of 2026-07-14 as the intent: resume skips a complete scout, so the corrected
    // candidates could never be re-ingested. See the total-rejection test above.)
    expect(res.state?.scouts.documentation.status).toBe("malformed");
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
  // surfaced as a persistence_partial error. Because the doc did not persist, the scout is NOT
  // done: it flips to persistence_failed (retryable) so resume re-attempts it, rather than being
  // marked complete and stranded (a complete scout is skipped on resume, so the failed doc would
  // never be retried). This keeps the run partial until every doc actually persists.
  it("treats a per-document failed receipt as not persisted and marks the scout retryable", async () => {
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
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");
  });

  // The point of flipping a per-doc failure to persistence_failed: resume must RE-RUN it. A scout
  // stranded as `complete` would be skipped (already_complete) and its failed doc lost forever. On
  // rerun the transient failure self-heals (the doc persists) and the run completes.
  it("re-runs a scout whose doc failed to persist, and completes on the retry", async () => {
    seedRun(home);
    // run 1: intel is up but its KB DB is briefly down -> a per-document failed receipt.
    const failingOnce: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "failed" as const })),
    }));
    const first = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: failingOnce,
      now: NOW,
      probe: makeProbe(),
    });
    expect(first.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(first.state?.status).toBe("partial");

    // run 2: same scout re-reported. It must NOT be skipped as already_complete; the DB is back,
    // so the doc persists and the run finishes.
    const healthy: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })),
    }));
    const second = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }] },
      persist: healthy,
      now: NOW,
      probe: makeProbe(),
    });
    expect(healthy).toHaveBeenCalledTimes(1); // the scout re-ran, it was not skipped
    const doc = second.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.errors.map((e) => e.code)).not.toContain("already_complete");
    expect(doc.persisted).toBe(1);
    // The scout itself is now done (the run stays partial only because this single-scout request
    // never exercised the history slot; a complete scout is what drives resume to skip it).
    expect(second.state?.scouts.documentation.status).toBe("complete");
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

// A run's persistence is NOT atomic, and the client used to pretend it was.
//
// Every candidate went out in ONE kb-add POST, on the reasoning that one POST gives the run
// "a single persistence outcome". It also gives it a single TIMEOUT. Intel runs behind a hard
// 300s Cloud Run ceiling and the CLI asks for 20s per document, so a full-cap run (20 docs)
// requests 400s: past the ceiling, the connection dies mid-write, and the client throws away
// every document in the POST, including the ones intel had already indexed. That is how a
// pilot user's onboarding produced a workspace with ZERO governed rules on 2026-07-13: the
// run had no partial state to resume from, so his rules died in the client and he had to
// start over from nothing.
//
// These tests pin the property that was missing: PROGRESS IS MONOTONIC. Whatever lands, stays
// landed, and only the documents that actually failed come back on the next run.
describe("ingestRun — batched persistence (progress must survive a failure)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ml-ingest-batch-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Caps default to 10 per scout / 20 total, which is exactly one batch and exactly two. Raise
  // them so a single scout can produce a run that spans several POSTs.
  const wideLimits: EnrichmentLimits = {
    ...defaultLimits(),
    maxCandidatesTotal: 40,
    maxCandidatesPerScout: 30,
  };

  // n distinct, verifiable candidates. Distinct statements mean distinct KB paths, which is
  // what makes each document independently attributable to a batch.
  const nDocs = (n: number): EnrichmentCandidate[] =>
    Array.from({ length: n }, (_, i) => docCandidate({ statement: `Convention number ${i}: prefer the explicit form.` }));

  function batchArgs(persist: Persister, candidates: EnrichmentCandidate[], runId = "run-1") {
    return {
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId, results: [{ scout: "documentation", status: "complete", candidates }] },
      persist,
      now: NOW,
      probe: makeProbe(),
    };
  }

  it("splits a run across several bounded POSTs instead of one unbounded one", async () => {
    seedRun(home, { limits: wideLimits });
    const sizes: number[] = [];
    const persist: Persister = jest.fn(async (docs) => {
      sizes.push(docs.length);
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, nDocs(25)));

    // 25 documents, batches of 10: three POSTs, none of them larger than the cap. The cap is
    // the whole point (it keeps each request's 20s-per-doc budget under intel's 300s ceiling),
    // so assert against PERSIST_BATCH_SIZE rather than a copied literal.
    expect(sizes).toEqual([PERSIST_BATCH_SIZE, PERSIST_BATCH_SIZE, 5]);
    expect(sizes.every((s) => s <= PERSIST_BATCH_SIZE)).toBe(true);
    expect(res.outcomes.find((o) => o.scout === "documentation")!.persisted).toBe(25);
    expect(res.state?.scouts.documentation.status).toBe("complete");
  });

  it("keeps what landed when a later batch fails, and only the failed documents come back", async () => {
    seedRun(home, { limits: wideLimits });
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout"); // the exact prod shape
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, nDocs(15)));

    // THE REGRESSION. Under the single POST this was 0: a 504 anywhere erased everything. Ten
    // documents reached the KB and ten documents are counted.
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(10);

    // ...and the five that did not are not silently dropped. They mark the scout retryable, so
    // resume re-attempts exactly them.
    expect(doc.errors.map((e) => e.code)).toContain("persistence_partial");
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");
  });

  it("carries the REAL failure cause, not a generic 'could not persist'", async () => {
    seedRun(home, { limits: wideLimits });
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, nDocs(15)));

    // A user who is told only "persistence failed" cannot tell a timeout from a rejected
    // payload. That silence is how a 300s ceiling stayed undiagnosed for a day.
    const partial = res.outcomes
      .find((o) => o.scout === "documentation")!
      .errors.find((e) => e.code === "persistence_partial")!;
    expect(partial.message).toContain("504 Gateway Timeout");
  });

  it("still reports a whole-run failure when NOTHING lands", async () => {
    seedRun(home, { limits: wideLimits });
    const persist: Persister = jest.fn(async () => {
      throw new Error("intel unreachable");
    });

    const res = await ingestRun(batchArgs(persist, nDocs(15)));

    // Batching must not soften a total outage into a cheerful partial. Zero landed is zero
    // progress, and every scout that offered a candidate shares that fate, exactly as before.
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(0);
    expect(doc.errors.map((e) => e.code)).toContain("persistence_failed");
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
  });

  it("stops hammering a server that is down, and marks the unattempted documents retryable", async () => {
    seedRun(home, { limits: wideLimits });
    const persist: Persister = jest.fn(async () => {
      throw new Error("intel unreachable");
    });

    // 40 documents is four batches. Once two in a row have failed, the server is down, not the
    // batch: spending another 200s timeout per remaining batch to rediscover that would hang
    // the CLI for many minutes before telling the operator anything.
    await ingestRun(batchArgs(persist, nDocs(30)));

    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("keeps trying past a SINGLE poison batch, or a bad document would strand every batch behind it", async () => {
    seedRun(home, { limits: wideLimits });
    const persist: Persister = jest.fn(async (docs) => {
      // The middle batch is poison: some document in it trips a server-side bug, forever.
      if (docs[0].content.includes("Convention number 10:")) throw new Error("kb-add 500");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, nDocs(25)));

    // If a failed batch aborted the run, batch 3 would never be attempted, and it would never
    // be attempted on ANY rerun either: every run would die at the same poison batch and the
    // documents behind it would be permanently unreachable. Keep going.
    expect(persist).toHaveBeenCalledTimes(3);
    expect(res.outcomes.find((o) => o.scout === "documentation")!.persisted).toBe(15);
  });

  it("records ONLY what landed in the accept sidecar", async () => {
    seedRun(home, { limits: wideLimits });
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    await ingestRun(batchArgs(persist, nDocs(15)));

    // `enrich accept` materializes durable candidates out of this sidecar into .meetless/rules.md
    // and filters on KIND, not on outcome. A candidate parked here that never reached the KB
    // would become a local rule with no governed document behind it: a stale local assumption,
    // minted by the very product that exists to prevent them.
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    expect(sidecar.candidates).toHaveLength(10);
    expect(sidecar.candidates.every((c) => c.landed === "ingested" || c.landed === "noop_unchanged")).toBe(true);
  });

  it("resumes: the retry re-POSTs the landed docs as no-ops and finishes the failed ones", async () => {
    seedRun(home, { limits: wideLimits });
    const candidates = nDocs(15);

    let call = 0;
    const flaky: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });
    const first = await ingestRun(batchArgs(flaky, candidates));
    expect(first.state?.scouts.documentation.status).toBe("persistence_failed");

    // Run 2: intel is healthy. The scout is retryable, so it re-reports, and kb-add is an
    // idempotent upsert: the ten documents that already landed come back noop_unchanged (cheap,
    // no re-index) and the five that were lost finally persist. THIS is what "progress is
    // monotonic" buys, and what the single POST could never do.
    const landed = new Set<string>();
    const healthy: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => {
        const seen = landed.has(d.relPath);
        landed.add(d.relPath);
        return { relPath: d.relPath, outcome: seen ? ("noop_unchanged" as const) : ("ingested" as const) };
      }),
    }));
    // Seed the server's memory with what run 1 actually persisted (the first batch).
    for (const c of candidates.slice(0, 10)) landed.add(candidateRelPath(asMerged(c)));

    const second = await ingestRun(batchArgs(healthy, candidates));

    const doc = second.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(15); // all fifteen are now governed
    expect(doc.deduped).toBe(10); // ten of them were already there: the run-1 survivors
    expect(second.state?.scouts.documentation.status).toBe("complete");

    // And the sidecar the accept half reads now holds the whole set: upsert MERGES, so the five
    // that landed late joined the ten that landed early rather than replacing them.
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    expect(sidecar.candidates).toHaveLength(15);
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

// A reject is a DELETION: the candidate never reaches the KB, the scout that produced it is
// gone, and the results file was a temp file. So the error is the only surviving trace of the
// claim, and a bare code plus an array index traces nothing. On the real repo this quietly
// binned the doc scout's sharpest finding (a self-contradiction in apps/control/CLAUDE.md over
// which path owns the Prisma schema) for being seven characters over the 500-char limit, and
// the summary said only "candidate 4: statement_too_long".
describe("a rejected candidate reports WHAT it dropped", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-excerpt-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const scoutResult = (candidates: unknown[]) => ({
    scout: "documentation",
    status: "complete",
    candidates,
  });

  it("stamps the statement excerpt on a shape reject (statement_too_long)", async () => {
    seedRun(home);
    const tooLong = docCandidate({ statement: `Control is the system of record. ${"x".repeat(600)}` });

    const res = await ingestRun(ingestArgs(home, "run-1", [scoutResult([tooLong])]));

    expect(res.ok).toBe(true);
    const err = res.outcomes![0].errors.find((e) => e.code === "statement_too_long");
    expect(err).toBeDefined();
    // Identifies the claim well enough to retype it from the source.
    expect(err!.excerpt).toContain("Control is the system of record.");
    // Bounded: a scout that sends a megabyte of prose cannot flood the terminal with it.
    expect(err!.excerpt!.length).toBeLessThanOrEqual(163); // 160 + the "..." marker
    expect(err!.excerpt!.endsWith("...")).toBe(true);
  });

  it("stamps the excerpt on an anchor reject too (the claim is lost the same way)", async () => {
    seedRun(home, { documentationTargets: [] });
    const badAnchor = docCandidate({
      statement: "Never mock internal services.",
      evidence: [{ type: "file", path: "CLAUDE.md", startLine: 10, endLine: 20 }],
    });

    const res = await ingestRun(
      ingestArgs(home, "run-1", [scoutResult([badAnchor])], makeProbe({ isTracked: () => false })),
    );

    expect(res.ok).toBe(true);
    const errors = res.outcomes![0].errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].excerpt).toBe("Never mock internal services.");
  });

  it("survives a candidate with no usable statement (the reject still lands, without an excerpt)", async () => {
    seedRun(home);

    const res = await ingestRun(
      ingestArgs(home, "run-1", [scoutResult([{ kind: "convention", statement: 42, evidence: [] }, null])]),
    );

    expect(res.ok).toBe(true);
    const errors = res.outcomes![0].errors;
    expect(errors.length).toBeGreaterThan(0);
    // No statement to quote, so no excerpt: the code alone stands, exactly as before.
    expect(errors.every((e) => e.excerpt === undefined)).toBe(true);
    expect(res.outcomes![0].accepted).toBe(0);
  });

  it("collapses whitespace so a multi-line statement stays one readable line", async () => {
    seedRun(home);
    const wrapped = docCandidate({
      statement: `Prisma rules:\n  - no enums\n\n  - no hand-rolled migrations\n${"y".repeat(600)}`,
    });

    const res = await ingestRun(ingestArgs(home, "run-1", [scoutResult([wrapped])]));

    const err = res.outcomes![0].errors.find((e) => e.code === "statement_too_long")!;
    expect(err.excerpt).toContain("Prisma rules: - no enums - no hand-rolled migrations");
    expect(err.excerpt).not.toContain("\n");
  });
});
