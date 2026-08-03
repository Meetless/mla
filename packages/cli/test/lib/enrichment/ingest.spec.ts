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
  scoutCandidateCap,
  SCOUT_NAMES,
  candidateId,
  candidateRelPath,
  FINDING_PROPOSED_RULE_KIND,
  type DocCodeInconsistency,
  type DocumentationTarget,
  type EnrichmentCandidate,
  type EnrichmentLimits,
  type MergedCandidate,
  type PreparedGitEvidence,
  type OnboardingCandidateRecord,
  type OnboardingCandidatesSidecar,
} from "../../../src/lib/enrichment/protocol";
import { withIdleScouts } from "../../helpers/scout-state";

const NOW = "2026-06-26T12:00:00.000Z";
const ALLOWED_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40); // the run's snapshot: every quote and blame is read AS OF this
const CLAIM_SHA = "c".repeat(40); // the commit that wrote the rule; a proven ancestor of ALLOWED_SHA
// Attribution is passed through verbatim, so the fixture only needs A name, never a real one.
// Keep it synthetic: this tree is exported to a public mirror whose scrub gate refuses any
// operator identity, and a real name here blocks that export (it blocked 0.2.31's).
const CLAIM_AUTHOR = "Test Author";

// The document the fake probe serves at HEAD_SHA. Reconciliation fixtures quote it BY LINE, so
// a claim is "verbatim" in these tests only because it really was copied from here; a fixture
// that invents its own sentence fails the same substring check a real scout would.
const RECON_DOC = "CLAUDE.md";
const reconClaim = (n: number): string =>
  `Rule ${n}: src/generated/file-${n}.ts is generated and must never be edited by hand.`;
const RECON_DOC_LINES = Array.from({ length: 40 }, (_, i) => reconClaim(i + 1));

const ALLOWLIST_HISTORY: PreparedGitEvidence[] = [
  {
    commit: ALLOWED_SHA,
    timestamp: "2026-06-20T10:00:00+00:00",
    subject: "feat: x",
    body: "",
    // The changes a finding's `divergence` is checked against, field for field. Recorded here
    // rather than in each fixture because that is where they live in a real run: the CLI read
    // them out of git, and the scout only ever gets to copy them.
    changedFiles: Array.from({ length: 40 }, (_, i) => ({ path: `src/generated/file-${i + 1}.ts`, status: "M" })),
  },
];

// A permissive probe: everything tracked, realpath is identity (in-repo), files are long, the
// document reads back at headCommit, one commit wrote the quoted line, and it predates the
// change. Each test overrides only what it needs to flip a single verification check.
function makeProbe(over: Partial<FsProbe> = {}): FsProbe {
  return {
    repoRealpath: over.repoRealpath ?? "/repo",
    isTracked: over.isTracked ?? (() => true),
    realpath: over.realpath ?? ((abs) => abs),
    lineCount: over.lineCount ?? (() => 100_000),
    readFileAtCommit:
      over.readFileAtCommit ?? ((_commit, relPath) => (relPath === RECON_DOC ? RECON_DOC_LINES.join("\n") : null)),
    blameRange:
      over.blameRange ?? (() => [{ commit: CLAIM_SHA, authorName: CLAIM_AUTHOR, authorTime: "1750000000" }]),
    isAncestor: over.isAncestor ?? (() => true),
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
    headCommit?: string | null;
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
    headCommit: "headCommit" in over ? over.headCommit : HEAD_SHA,
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

// A reconciliation finding is a PAIR of anchors by construction (REQUIRED_ANCHOR_TYPES):
// the documented claim and the commit that diverged from it. Either one alone is a different
// scout's finding. `n` picks the line of RECON_DOC it quotes, which is also what makes two
// fixtures distinct: identity is the verified quote plus the change, never the generated prose.
const reconCandidate = (over: Partial<EnrichmentCandidate> = {}, n = 1): EnrichmentCandidate => ({
  kind: "doc_code_inconsistency",
  statement: `${RECON_DOC} says file-${n} is generated, but a commit edited it by hand.`,
  evidence: [
    { type: "file", path: RECON_DOC, startLine: n, endLine: n },
    { type: "commit", commit: "aaaaaaa" }, // unambiguous prefix of ALLOWED_SHA
  ],
  sourceScout: "reconciliation",
  // Exactly what a scout may send. `proposedRuleKind` and `attribution` are stamped by the CLI
  // and are unknown fields on the wire, so the fixture omits them and casts: a fixture that
  // carried them would be testing a payload no scout is allowed to produce.
  inconsistency: {
    // The scope is the path the QUOTE names, not the directory around it: a scope the document
    // does not write out is a broadening the CLI cannot verify (`claim_scope_not_in_quote`).
    claimClass: "never_modify",
    claimText: reconClaim(n),
    claimScope: `src/generated/file-${n}.ts`,
    divergence: { path: `src/generated/file-${n}.ts`, status: "M" },
  } as DocCodeInconsistency,
  ...over,
});

// Cap tests need MORE candidates than a role's cap, and the caps are real numbers (10) rather
// than a test-tuned 1 or 2. Statements must be distinct or dedup merges them and the count
// under test is not the count that arrived.
const distinct = (
  make: (over: Partial<EnrichmentCandidate>) => EnrichmentCandidate,
  label: string,
) => (n: number): EnrichmentCandidate[] =>
  Array.from({ length: n }, (_, i) => make({ statement: `Distinct ${label} statement number ${i + 1}.` }));

const distinctDocs = distinct(docCandidate, "documentation");
const distinctHists = distinct(histCandidate, "history");
// Findings vary by the LINE they quote, not by their statement: two findings with different
// prose over the same quote and the same change are one finding, which is the whole point of
// hashing the verified quote instead of the generated sentence.
const distinctRecons = (n: number): EnrichmentCandidate[] =>
  Array.from({ length: n }, (_, i) => reconCandidate({}, i + 1));

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

describe("ingestRun: top-level rejections", () => {
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

describe("ingestRun: candidate verification", () => {
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

describe("ingestRun: orchestration", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("marks status complete only when EVERY scout completes; writes state", async () => {
    seedRun(home);
    const results = withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]);
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
          results: withIdleScouts([
            { scout: "documentation", status: "complete", candidates: [docCandidate()] },
            { scout: "history", status: "complete", candidates: [histCandidate()] },
          ]),
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
    // Every other role reports complete, so the timed-out history scout is the ONLY reason
    // the run is partial. Leaving a role silently unreported would make the assertion pass
    // for the wrong reason.
    const args = ingestArgs(home, "run-1", withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "timed_out", candidates: [], error: "budget exceeded" },
    ]));
    const res = await ingestRun(args);
    expect(res.state?.status).toBe("partial");
    expect(res.state?.scouts.history.status).toBe("timed_out");
    // only the documentation scout's doc was persisted
    expect(args.persist).toHaveBeenCalledTimes(1);
  });

  it("does not re-process a scout already complete on rerun (resume)", async () => {
    seedRun(home);
    // run 1: doc complete, history failed
    const first = ingestArgs(home, "run-1", withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "failed", candidates: [], error: "git error" },
    ]));
    await ingestRun(first);
    expect(first.persist).toHaveBeenCalledTimes(1);

    // run 2: doc re-reported (must be SKIPPED), history now complete
    const second = ingestArgs(home, "run-1", withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]));
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
    const first = ingestArgs(home, "run-1", withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [bad, bad] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]));
    const firstRes = await ingestRun(first);

    const docFirst = firstRes.outcomes.find((o) => o.scout === "documentation")!;
    expect(docFirst).toMatchObject({ received: 2, accepted: 0, persisted: 0 });
    // The whole point: total rejection is NOT completion.
    expect(firstRes.state?.scouts.documentation.status).not.toBe("complete");
    expect(firstRes.state?.status).not.toBe("complete");

    // Rerun with the corrected candidates: they must actually land, not be skipped.
    const second = ingestArgs(home, "run-1", withIdleScouts([
      { scout: "documentation", status: "complete", candidates: [docCandidate()] },
      { scout: "history", status: "complete", candidates: [histCandidate()] },
    ]));
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
      // Deliberately a hand-written two-role literal, NOT scoutStates(): a v1 file on disk
      // predates the third scout and really does name only these two. The cast below is what
      // lets an off-roster shape compile, which is the whole point of the test.
      scouts: {
        documentation: { status: "complete", candidateCount: 0 }, // landed nothing, skipped forever
        history: { status: "persistence_failed", error: "kb-add persistence failed" },
      },
    } as unknown as Parameters<typeof writeState>[1]);
    expect(loadState(home, "ws_1", "run-1")).toBeNull(); // refused, not resumed
    expect(run.runId).toBe("run-1");

    // The documentation scout is therefore runnable again: its candidates actually land.
    const res = await ingestRun(
      ingestArgs(home, "run-1", withIdleScouts([
        { scout: "documentation", status: "complete", candidates: [docCandidate()] },
        { scout: "history", status: "complete", candidates: [histCandidate()] },
      ])),
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
      ingestArgs(home, "run-1", withIdleScouts([
        { scout: "documentation", status: "complete", candidates: [] },
        { scout: "history", status: "complete", candidates: [histCandidate()] },
      ])),
    );
    const docOut = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(docOut).toMatchObject({ received: 0, accepted: 0, persisted: 0 });
    expect(res.state?.scouts.documentation.status).toBe("complete");
    expect(res.state?.status).toBe("complete");
  });

  it("has no run-wide backstop: a low recorded maxCandidatesTotal binds nothing", async () => {
    // `limits.maxCandidatesTotal` is display and audit metadata, derived from the per-role
    // caps. It is deliberately NOT a second enforcement point. A run-total that could be set
    // below the sum of the caps would have to be drained in some order across scouts, and
    // draining a shared pool in list order is precisely the bug the per-role map removed:
    // whichever role sorted last silently allocated whatever was left, often zero.
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesTotal: 1 } });
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: distinctDocs(3) },
      ]),
    );
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.accepted).toBe(3); // its own cap is 10; the recorded total of 1 changes nothing
    expect(doc.rejected).toBe(0);
    expect(doc.errors.map((e) => e.code)).not.toContain("candidate_cap_exceeded");
  });

  it("caps each scout at its OWN cap, which differ per role (verdict item 8)", async () => {
    // Roles do not share a number. documentation is capped at 10 and reconciliation at 3, so
    // a single scalar could never describe both: whichever value it held, one role would be
    // told the wrong limit and have the difference silently dropped. Each scout here sends
    // one more than its own cap and keeps exactly its own cap.
    const docCap = scoutCandidateCap("documentation");
    const reconCap = scoutCandidateCap("reconciliation");
    expect(docCap).not.toBe(reconCap); // the premise: this is a per-ROLE cap, not one number
    seedRun(home);
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: distinctDocs(docCap + 1) },
        { scout: "reconciliation", status: "complete", candidates: distinctRecons(reconCap + 1) },
      ]),
    );
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    const recon = res.outcomes.find((o) => o.scout === "reconciliation")!;
    expect(doc.accepted).toBe(docCap);
    expect(doc.rejected).toBe(1);
    expect(recon.accepted).toBe(reconCap);
    expect(recon.rejected).toBe(1);
    expect(doc.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
    expect(recon.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("does NOT reallocate an under-producing scout's surplus to another scout (verdict item 8)", async () => {
    // Inverse of the retired fair-share behavior. documentation sends 1, far under its cap of
    // 10. Those 9 unused slots must NOT flow to reconciliation: it stays bounded at its own
    // 3 and rejects the 4th (under the old reallocation it would have kept all 4).
    const reconCap = scoutCandidateCap("reconciliation");
    seedRun(home);
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: [docCandidate()] },
        { scout: "reconciliation", status: "complete", candidates: distinctRecons(reconCap + 1) },
      ]),
    );
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    const recon = res.outcomes.find((o) => o.scout === "reconciliation")!;
    expect(doc.accepted).toBe(1);
    expect(doc.rejected).toBe(0);
    expect(recon.accepted).toBe(reconCap);
    expect(recon.rejected).toBe(1);
    expect(recon.errors.map((e) => e.code)).toContain("candidate_cap_exceeded");
  });

  it("gives a resuming scout its FULL own cap, whatever a prior scout already landed", async () => {
    // The retired run-total backstop counted a prior-complete scout's candidates against the
    // resuming one, so a productive first scout could starve a later one to zero on resume.
    // A per-role cap does not depend on what any other scout produced. Run 1: documentation
    // completes at its full cap of 10. Run 2: history still gets all 10 of its own, even
    // though the recorded total here is a deliberately absurd 3.
    const docCap = scoutCandidateCap("documentation");
    const histCap = scoutCandidateCap("history");
    seedRun(home, { limits: { ...defaultLimits(), maxCandidatesTotal: 3 } });
    const first = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: distinctDocs(docCap) },
      ]),
    );
    expect(first.outcomes.find((o) => o.scout === "documentation")!.accepted).toBe(docCap);

    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "history", status: "complete", candidates: distinctHists(histCap) },
      ]),
    );
    const hist = res.outcomes.find((o) => o.scout === "history")!;
    expect(hist.accepted).toBe(histCap); // <- was 0 under the old prior-counting backstop
    expect(hist.rejected).toBe(0);
    expect(hist.errors.map((e) => e.code)).not.toContain("candidate_cap_exceeded");
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

  it("collapses two findings that differ ONLY in their generated explanation (fixture 18)", async () => {
    // The statement is prose an LLM wrote about the finding, and prose is not stable across
    // runs or across models. Identity is the CLI-verified quote plus the change, so two
    // sentences describing the same line and the same commit are one finding, not two.
    seedRun(home);
    const args = ingestArgs(home, "run-1", [
      {
        scout: "reconciliation",
        status: "complete",
        candidates: [
          reconCandidate({ statement: "CLAUDE.md forbids editing this generated file, and a commit edited it." }),
          reconCandidate({ statement: "A hand edit landed in a file the docs mark generated." }),
        ],
      },
    ]);
    const res = await ingestRun(args);
    const recon = res.outcomes.find((o) => o.scout === "reconciliation")!;
    expect(recon.accepted).toBe(2);
    expect(recon.persisted).toBe(1);
    expect((args.persist as jest.Mock).mock.calls[0][0]).toHaveLength(1);
  });

  it("lands the SAME finding document after an unrelated HEAD advance (fixture 17)", async () => {
    // A later run reads the same evidence at a newer headCommit, because the repository moved
    // for reasons that touched neither the document nor the commit. `headCommit` is deliberately
    // outside the identity: including it would mint a fresh copy of every open finding on every
    // commit anyone makes, which is the fastest way to make the inbox worthless.
    seedRun(home, { runId: "run-1", headCommit: HEAD_SHA });
    const first = ingestArgs(home, "run-1", [
      { scout: "reconciliation", status: "complete", candidates: [reconCandidate()] },
    ]);
    await ingestRun(first);

    seedRun(home, { runId: "run-2", headCommit: "e".repeat(40) });
    const second = ingestArgs(home, "run-2", [
      { scout: "reconciliation", status: "complete", candidates: [reconCandidate()] },
    ]);
    await ingestRun(second);

    const firstDoc = (first.persist as jest.Mock).mock.calls[0][0][0];
    const secondDoc = (second.persist as jest.Mock).mock.calls[0][0][0];
    expect(secondDoc.relPath).toBe(firstDoc.relPath); // same document, so the KB updates in place
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
// "a single persistence outcome". It also gives it a single TIMEOUT, and the CLI asked for
// 20s per document against a wall that does not move: past it the connection dies mid-write
// and the client throws away every document in the POST, including the ones intel had already
// indexed. (Which wall, and why the code named the wrong one for a week, is in
// `src/lib/intel-ingest-budget.ts`.) That is how a
// pilot user's onboarding produced a workspace with ZERO governed rules on 2026-07-13: the
// run had no partial state to resume from, so his rules died in the client and he had to
// start over from nothing.
//
// These tests pin the property that was missing: PROGRESS IS MONOTONIC. Whatever lands, stays
// landed, and only the documents that actually failed come back on the next run.
describe("ingestRun: batched persistence (progress must survive a failure)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ml-ingest-batch-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Batching needs MORE documents than one POST carries, and no `limits` override can supply
  // them: the per-role caps live in SCOUT_CANDIDATE_CAPS, so a run record cannot widen them.
  // The largest run the product can produce is therefore every scout at its own full cap,
  // which is several batches. Sizing the fixture from the real caps also means these tests
  // exercise the actual maximum a user can hit rather than an invented one.
  const CAPS = { documentation: scoutCandidateCap("documentation"), history: scoutCandidateCap("history"), reconciliation: scoutCandidateCap("reconciliation") };

  // The full roster at full caps, plus the exact order the batcher will slice.
  // `ordered` matters: documents are built by walking the scouts in roster order and each
  // scout's candidates in arrival order, so a test that needs to name the document sitting in
  // batch N reads it from here instead of guessing which scout owns that batch.
  function roster() {
    const doc = distinctDocs(CAPS.documentation);
    const hist = distinctHists(CAPS.history);
    const recon = distinctRecons(CAPS.reconciliation);
    return {
      results: [
        { scout: "documentation", status: "complete", candidates: doc },
        { scout: "history", status: "complete", candidates: hist },
        { scout: "reconciliation", status: "complete", candidates: recon },
      ],
      ordered: [...doc, ...hist, ...recon],
    };
  }

  const ROSTER_TOTAL = CAPS.documentation + CAPS.history + CAPS.reconciliation;

  // Batch 2 must fall entirely inside the documentation scout's own run of documents, so the
  // "one batch failed" tests can say exactly WHICH scout was hurt and which were not.
  const SECOND_BATCH_IS_DOCUMENTATION = CAPS.documentation >= 2 * PERSIST_BATCH_SIZE;

  function batchArgs(persist: Persister, results: unknown[], runId = "run-1") {
    return {
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId, results },
      persist,
      now: NOW,
      probe: makeProbe(),
    };
  }

  it("splits a run across several bounded POSTs instead of one unbounded one", async () => {
    seedRun(home);
    const sizes: number[] = [];
    const persist: Persister = jest.fn(async (docs) => {
      sizes.push(docs.length);
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, roster().results));

    // The run splits into full batches plus a remainder, none larger than the cap. Derive the
    // expected split from PERSIST_BATCH_SIZE instead of writing the batch layout out by hand:
    // the cap is a measured number that has already moved once (10 -> 5, when the real ceiling
    // turned out to be Cloudflare's 100s and not Cloud Run's 300s), and an assertion that
    // hardcodes today's layout fails the next time the measurement says to move it.
    const expected = [
      ...Array(Math.floor(ROSTER_TOTAL / PERSIST_BATCH_SIZE)).fill(PERSIST_BATCH_SIZE),
      ...(ROSTER_TOTAL % PERSIST_BATCH_SIZE ? [ROSTER_TOTAL % PERSIST_BATCH_SIZE] : []),
    ];
    expect(sizes).toEqual(expected);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(ROSTER_TOTAL);
    expect(sizes.length).toBeGreaterThan(1); // it batched at all
    expect(sizes.every((s) => s <= PERSIST_BATCH_SIZE)).toBe(true);
    for (const role of SCOUT_NAMES) {
      expect(res.outcomes.find((o) => o.scout === role)!.persisted).toBe(CAPS[role]);
      expect(res.state?.scouts[role].status).toBe("complete");
    }
  });

  it("keeps what landed when a later batch fails, and only the failed documents come back", async () => {
    expect(SECOND_BATCH_IS_DOCUMENTATION).toBe(true); // the premise of the per-scout claims below
    seedRun(home);
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout"); // the exact prod shape
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, roster().results));

    // THE REGRESSION. Under the single POST this was 0: a 504 anywhere erased everything. Every
    // document outside the lost batch reached the KB and is counted.
    const landed = res.outcomes.reduce((n, o) => n + o.persisted, 0);
    expect(landed).toBe(ROSTER_TOTAL - PERSIST_BATCH_SIZE);

    // The lost batch is documentation's, so documentation is the scout left retryable...
    const doc = res.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(CAPS.documentation - PERSIST_BATCH_SIZE);
    expect(doc.errors.map((e) => e.code)).toContain("persistence_partial");
    expect(res.state?.scouts.documentation.status).toBe("persistence_failed");
    expect(res.state?.status).toBe("partial");

    // ...and ONLY that scout. A failed batch is not collective punishment: a scout whose
    // documents all landed is finished, and resume must not make it pay for a neighbor's 504
    // by re-running it (and re-spending its tokens).
    for (const role of ["history", "reconciliation"] as const) {
      expect(res.outcomes.find((o) => o.scout === role)!.persisted).toBe(CAPS[role]);
      expect(res.state?.scouts[role].status).toBe("complete");
    }
  });

  it("carries the REAL failure cause, not a generic 'could not persist'", async () => {
    seedRun(home);
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, roster().results));

    // A user who is told only "persistence failed" cannot tell a timeout from a rejected
    // payload. That silence is how a severed request stayed undiagnosed for a day.
    const partial = res.outcomes
      .find((o) => o.scout === "documentation")!
      .errors.find((e) => e.code === "persistence_partial")!;
    expect(partial.message).toContain("504 Gateway Timeout");
  });

  it("still reports a whole-run failure when NOTHING lands", async () => {
    seedRun(home);
    const persist: Persister = jest.fn(async () => {
      throw new Error("intel unreachable");
    });

    const res = await ingestRun(batchArgs(persist, roster().results));

    // Batching must not soften a total outage into a cheerful partial. Zero landed is zero
    // progress, and every scout that offered a candidate shares that fate, exactly as before.
    for (const role of SCOUT_NAMES) {
      const out = res.outcomes.find((o) => o.scout === role)!;
      expect(out.persisted).toBe(0);
      expect(out.errors.map((e) => e.code)).toContain("persistence_failed");
      expect(res.state?.scouts[role].status).toBe("persistence_failed");
    }
  });

  it("stops hammering a server that is down, and marks the unattempted documents retryable", async () => {
    seedRun(home);
    const persist: Persister = jest.fn(async () => {
      throw new Error("intel unreachable");
    });

    // A full roster is several batches. Once two in a row have failed, the server is down, not
    // the batch: spending another full request budget per remaining batch to rediscover that
    // would hang the CLI for many minutes before telling the operator anything.
    expect(Math.ceil(ROSTER_TOTAL / PERSIST_BATCH_SIZE)).toBeGreaterThan(2);
    await ingestRun(batchArgs(persist, roster().results));

    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("keeps trying past a SINGLE poison batch, or a bad document would strand every batch behind it", async () => {
    seedRun(home);
    // The MIDDLE batch is poison: some document in it trips a server-side bug, forever. Derive
    // which document that is from the batch size so the poison keeps landing mid-run when the
    // size moves; a hardcoded index quietly becomes a FIRST-batch or LAST-batch test, and
    // neither of those exercises "a failure in the middle did not strand what was behind it".
    // Identify it by relPath off the known persistence order, so the test does not care which
    // scout happens to own the middle of the run.
    const { results, ordered } = roster();
    const batchCount = Math.ceil(ROSTER_TOTAL / PERSIST_BATCH_SIZE);
    const poisonPath = candidateRelPath(asMerged(ordered[Math.floor(batchCount / 2) * PERSIST_BATCH_SIZE]));
    const persist: Persister = jest.fn(async (docs) => {
      if (docs.some((d) => d.relPath === poisonPath)) throw new Error("kb-add 500");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    const res = await ingestRun(batchArgs(persist, results));

    // If a failed batch aborted the run, every batch after the poison one would never be
    // attempted, and never on ANY rerun either: each run would die at the same poison batch and
    // the documents behind it would be permanently unreachable. Keep going: attempt them all,
    // and land everything except the one batch that is genuinely poison.
    expect(persist).toHaveBeenCalledTimes(batchCount);
    const landed = res.outcomes.reduce((n, o) => n + o.persisted, 0);
    expect(landed).toBe(ROSTER_TOTAL - PERSIST_BATCH_SIZE);
  });

  it("records ONLY what landed in the accept sidecar", async () => {
    seedRun(home);
    let call = 0;
    const persist: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });

    await ingestRun(batchArgs(persist, roster().results));

    // `enrich accept` materializes durable candidates out of this sidecar into .meetless/rules.md
    // and filters on KIND, not on outcome. A candidate parked here that never reached the KB
    // would become a local rule with no governed document behind it: a stale local assumption,
    // minted by the very product that exists to prevent them.
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    expect(sidecar.candidates).toHaveLength(ROSTER_TOTAL - PERSIST_BATCH_SIZE);
    expect(sidecar.candidates.every((c) => c.landed === "ingested" || c.landed === "noop_unchanged")).toBe(true);
  });

  it("resumes: the retry re-POSTs the landed docs as no-ops and finishes the failed ones", async () => {
    expect(SECOND_BATCH_IS_DOCUMENTATION).toBe(true); // batch 2 is documentation's; see below
    seedRun(home);
    const { results, ordered } = roster();

    let call = 0;
    const flaky: Persister = jest.fn(async (docs) => {
      call += 1;
      if (call === 2) throw new Error("504 Gateway Timeout");
      return { docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })) };
    });
    const first = await ingestRun(batchArgs(flaky, results));
    expect(first.state?.scouts.documentation.status).toBe("persistence_failed");

    // Run 2: intel is healthy. ONLY documentation is retryable (the other scouts finished), so
    // only its documents are re-reported, and kb-add is an idempotent upsert: the ones that
    // already landed come back noop_unchanged (cheap, no re-index) and the lost batch finally
    // persists. THIS is what "progress is monotonic" buys, and what the single POST could not.
    const landed = new Set<string>();
    const healthy: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => {
        const seen = landed.has(d.relPath);
        landed.add(d.relPath);
        return { relPath: d.relPath, outcome: seen ? ("noop_unchanged" as const) : ("ingested" as const) };
      }),
    }));
    // Seed the server's memory with what run 1 actually persisted: everything except batch 2.
    const lost = new Set(
      ordered
        .slice(PERSIST_BATCH_SIZE, 2 * PERSIST_BATCH_SIZE)
        .map((c) => candidateRelPath(asMerged(c))),
    );
    for (const c of ordered) {
      const relPath = candidateRelPath(asMerged(c));
      if (!lost.has(relPath)) landed.add(relPath);
    }

    const second = await ingestRun(batchArgs(healthy, results));

    const doc = second.outcomes.find((o) => o.scout === "documentation")!;
    expect(doc.persisted).toBe(CAPS.documentation); // all of documentation's are now governed
    expect(doc.deduped).toBe(CAPS.documentation - PERSIST_BATCH_SIZE); // the run-1 survivors
    expect(second.state?.scouts.documentation.status).toBe("complete");
    // The scouts that finished in run 1 are skipped, not re-persisted.
    for (const role of ["history", "reconciliation"] as const) {
      const out = second.outcomes.find((o) => o.scout === role)!;
      expect(out.errors.map((e) => e.code)).toContain("already_complete");
      expect(out.persisted).toBe(0);
    }

    // And the sidecar the accept half reads now holds the whole set: upsert MERGES, so the
    // documents that landed late joined the ones that landed early rather than replacing them.
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    expect(sidecar.candidates).toHaveLength(ROSTER_TOTAL);
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

  // CROSS-PACKAGE CONTRACT. The console renders a finding card by PARSING this artifact back
  // out of the governed KB (apps/console/app/kb/[id]/onboarding-candidate.ts), because a
  // finding's structured payload and its verdict live only in a per-machine sidecar and the
  // card is not allowed to add a second store or a second way to close a finding. That parser
  // fails closed on any deviation, so a silent change here does not corrupt the card, it makes
  // the card VANISH. This test is the tripwire: it pins the exact byte layout the parser keys
  // on. If it fails, fix the parser and its fixture in the same change, or bump
  // CANDIDATE_DOC_SCHEMA_VERSION so the parser refuses the new layout on purpose.
  it("emits the EXACT frontmatter block and body skeleton the console parser reads back", () => {
    const c = asMerged(reconCandidate());
    const lines = renderCandidateDocument(c).split("\n");

    // Six flat `key: value` lines between two fences, in this order, with nothing else.
    expect(lines.slice(0, 8)).toEqual([
      "---",
      "mlaGenerated: onboarding-candidate",
      "schemaVersion: 1",
      `candidateId: ${candidateId(c)}`,
      "kind: doc_code_inconsistency",
      "sourceScouts: [reconciliation]",
      "reviewHint: provisional",
      "---",
    ]);
    // The parser matches the id as 64 lowercase hex and shows its first 12 as the `--finding`
    // prefix; anything else and the card's copyable command points at nothing.
    expect(candidateId(c)).toMatch(/^[0-9a-f]{64}$/);

    // Body skeleton: blank, heading, blank, statement, blank, the sentinel that bounds it.
    expect(lines[8]).toBe("");
    expect(lines[9]).toBe("# Candidate");
    expect(lines[10]).toBe("");
    expect(lines[11]).toBe(c.statement);
    expect(lines[12]).toBe("");
    expect(lines[13]).toBe("Surfaced by the reconciliation scout (onboarding enrichment, advisory).");

    // Evidence bullets: `- ` prefixed, under a bare `## Evidence` heading.
    const evidenceAt = lines.indexOf("## Evidence");
    expect(evidenceAt).toBeGreaterThan(13);
    expect(lines[evidenceAt + 1].startsWith("- ")).toBe(true);
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

// The half of a finding no shape check can reach: is it TRUE OF THIS REPOSITORY? Every case
// below is a way a finding can look internally perfect and still be historically meaningless,
// which is the failure this whole verification exists to prevent.
describe("verifyCandidate: doc_code_inconsistency (historical proof)", () => {
  const reconRun = buildOnboardingRun({
    runId: "r",
    workspaceId: "ws_1",
    repositoryRoot: "/repo",
    now: NOW,
    documentationTargets: [],
    historyEvidence: ALLOWLIST_HISTORY,
    headCommit: HEAD_SHA,
  });
  const codes = (cand: EnrichmentCandidate, probe = makeProbe()): string[] =>
    verifyCandidate(cand, reconRun, probe, 0).map((e) => e.code);

  it("accepts a finding whose quote, change, and ordering all check out", () => {
    expect(codes(reconCandidate())).toEqual([]);
  });

  it("reads the quote and the blame AS OF headCommit, and orders claim-commit before change-commit", () => {
    // Not incidental plumbing: reading the working tree instead would let an UNCOMMITTED edit
    // to CLAUDE.md manufacture a rule, and ordering the arguments backwards would prove the
    // opposite of the claim (that the change predates the rule, which breaks nothing).
    const seen: string[][] = [];
    const probe = makeProbe({
      readFileAtCommit: (commit, relPath) => {
        seen.push(["read", commit, relPath]);
        return RECON_DOC_LINES.join("\n");
      },
      blameRange: (commit, relPath, s, e) => {
        seen.push(["blame", commit, relPath, String(s), String(e)]);
        return [{ commit: CLAIM_SHA, authorName: CLAIM_AUTHOR, authorTime: "1750000000" }];
      },
      isAncestor: (a, b) => {
        seen.push(["ancestor", a, b]);
        return true;
      },
    });
    expect(codes(reconCandidate({}, 7), probe)).toEqual([]);
    expect(seen).toEqual([
      ["read", HEAD_SHA, RECON_DOC],
      ["blame", HEAD_SHA, RECON_DOC, "7", "7"],
      ["ancestor", CLAIM_SHA, ALLOWED_SHA],
    ]);
  });

  it("rejects when the run has no headCommit: there is no snapshot to verify against", () => {
    const noHead = buildOnboardingRun({
      runId: "r",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: NOW,
      documentationTargets: [],
      historyEvidence: ALLOWLIST_HISTORY,
      headCommit: null, // git was unavailable at plan time
    });
    expect(verifyCandidate(reconCandidate(), noHead, makeProbe(), 0).map((e) => e.code)).toEqual(["no_head_commit"]);
  });

  it("rejects a change the cited commit never made", () => {
    const cand = reconCandidate({
      inconsistency: { ...reconCandidate().inconsistency!, divergence: { path: "src/generated/nope.ts", status: "M" } },
    });
    expect(codes(cand)).toEqual(["divergence_not_in_commit"]);
  });

  it("rejects a status letter the plan's own evidence does not carry", () => {
    // The scout was SHOWN this line and asked to copy it. `A` where the CLI recorded `M` is not
    // a near miss: it is the difference between "edited a generated file" and "created one",
    // and the claim class is chosen from that letter.
    const cand = reconCandidate({
      inconsistency: {
        ...reconCandidate().inconsistency!,
        claimClass: "never_add",
        divergence: { path: "src/generated/file-1.ts", status: "A" },
      },
    });
    expect(codes(cand)).toEqual(["divergence_mismatch"]);
  });

  it("rejects a rename origin the plan never recorded", () => {
    const withRename: PreparedGitEvidence[] = [
      {
        ...ALLOWLIST_HISTORY[0],
        changedFiles: [{ path: "src/generated/file-1.ts", status: "R100", renamedFrom: "src/old/file-1.ts" }],
      },
    ];
    const runR = buildOnboardingRun({
      runId: "r",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: NOW,
      documentationTargets: [],
      historyEvidence: withRename,
      headCommit: HEAD_SHA,
    });
    const cand = reconCandidate({
      inconsistency: {
        ...reconCandidate().inconsistency!,
        claimClass: "never_rename",
        claimScope: "src/",
        divergence: { path: "src/generated/file-1.ts", status: "R100", renamedFrom: "src/invented/file-1.ts" },
      },
    });
    expect(verifyCandidate(cand, runR, makeProbe(), 0).map((e) => e.code)).toEqual(["divergence_mismatch"]);
  });

  it("rejects a document that does not exist at headCommit (an uncommitted doc anchors nothing)", () => {
    expect(codes(reconCandidate(), makeProbe({ readFileAtCommit: () => null }))).toEqual(["doc_not_at_head"]);
  });

  it("rejects an anchored range past the end of the document at headCommit", () => {
    // The working-tree length check upstream passed; the SNAPSHOT is the authority here, and a
    // document that got shorter since is exactly how a stale anchor quotes lines that are gone.
    const oneLineDoc = makeProbe({ readFileAtCommit: () => reconClaim(1) });
    expect(codes(reconCandidate({}, 1), oneLineDoc)).toEqual([]);
    expect(codes(reconCandidate({}, 9), oneLineDoc)).toEqual(["line_out_of_range_at_head"]);
  });

  it("rejects a paraphrase, however plausible", () => {
    const cand = reconCandidate({
      inconsistency: {
        ...reconCandidate().inconsistency!,
        claimText: "Rule 1: src/generated/file-1.ts is generated and should not be edited by hand.",
      },
    });
    expect(codes(cand)).toEqual(["claim_not_in_document"]);
  });

  it("still matches across re-wrapping and CRLF: whitespace is the ONLY thing normalized", () => {
    const wrapped = makeProbe({
      readFileAtCommit: () => `Rule 1: src/generated/file-1.ts is generated\r\n   and must never be edited by hand.`,
    });
    expect(codes(reconCandidate({ evidence: [
      { type: "file", path: RECON_DOC, startLine: 1, endLine: 2 },
      { type: "commit", commit: "aaaaaaa" },
    ] }, 1), wrapped)).toEqual([]);
  });

  it("persists the CLI-verified span, not the model's string", () => {
    const cand = reconCandidate({
      inconsistency: { ...reconCandidate().inconsistency!, claimText: `  ${reconClaim(1)}\n\n  ` },
    });
    expect(codes(cand)).toEqual([]);
    expect(cand.inconsistency!.claimText).toBe(reconClaim(1));
  });

  it("blames the MINIMAL span containing the quote, not the whole anchored range", () => {
    // A generous anchor is the normal case: a scout quotes one sentence and anchors the
    // paragraph around it. Blaming the paragraph attributes the rule to whoever last touched
    // any neighbouring line, and one unrelated edit anywhere in it makes the range span two
    // commits, which drops a provable finding as `ambiguous_claim_origin`.
    const seen: number[][] = [];
    const probe = makeProbe({
      blameRange: (_c, _p, s, e) => {
        seen.push([s, e]);
        return [{ commit: CLAIM_SHA, authorName: CLAIM_AUTHOR, authorTime: "1750000000" }];
      },
    });
    const wideAnchor = reconCandidate(
      {
        evidence: [
          { type: "file", path: RECON_DOC, startLine: 1, endLine: 5 },
          { type: "commit", commit: "aaaaaaa" },
        ],
      },
      3,
    );
    expect(codes(wideAnchor, probe)).toEqual([]);
    expect(seen).toEqual([[3, 3]]);
  });

  it("rejects a quote that occurs more than once in the anchored range", () => {
    // Two occurrences means two candidate origins, and picking either one asserts an ancestry
    // the CLI cannot prove. A narrower anchor makes this finding provable; a guess does not.
    const repeated = makeProbe({
      readFileAtCommit: () => [reconClaim(1), reconClaim(2), reconClaim(1), reconClaim(4), reconClaim(5)].join("\n"),
    });
    const wideAnchor = reconCandidate(
      {
        evidence: [
          { type: "file", path: RECON_DOC, startLine: 1, endLine: 5 },
          { type: "commit", commit: "aaaaaaa" },
        ],
      },
      1,
    );
    expect(codes(wideAnchor, repeated)).toEqual(["ambiguous_claim_occurrence"]);
  });

  it("rejects when git cannot blame the anchored range", () => {
    expect(codes(reconCandidate(), makeProbe({ blameRange: () => null }))).toEqual(["blame_unavailable"]);
  });

  it("rejects a range written by more than one commit: no single commit can be shown to be older", () => {
    const probe = makeProbe({
      blameRange: () => [
        { commit: CLAIM_SHA, authorName: "An", authorTime: "1750000000" },
        { commit: "d".repeat(40), authorName: "An", authorTime: "1750000001" },
      ],
    });
    expect(codes(reconCandidate(), probe)).toEqual(["ambiguous_claim_origin"]);
  });

  it("rejects a range git reports as not committed", () => {
    const probe = makeProbe({ blameRange: () => [{ commit: "0".repeat(40), authorName: "", authorTime: "" }] });
    expect(codes(reconCandidate(), probe)).toEqual(["claim_not_committed"]);
  });

  it("rejects when the rule and the change landed in the SAME commit", () => {
    // `git merge-base --is-ancestor X X` exits 0, so without an explicit guard one commit that
    // wrote a rule and changed a file in the same breath would "prove" it violated itself.
    const probe = makeProbe({ blameRange: () => [{ commit: ALLOWED_SHA, authorName: "An", authorTime: "1750000000" }] });
    expect(codes(reconCandidate(), probe)).toEqual(["claim_and_change_same_commit"]);
  });

  it("rejects when the rule is not a proven ancestor of the change (it landed AFTER)", () => {
    // The commit predates the rule, so it broke nothing. This is the false positive that would
    // otherwise dominate: every old commit looks like it violates every new document.
    expect(codes(reconCandidate(), makeProbe({ isAncestor: () => false }))).toEqual(["claim_not_proven_older"]);
  });

  it("stamps the attribution git proved, and omits what git could not name", () => {
    const cand = reconCandidate();
    expect(codes(cand)).toEqual([]);
    expect(cand.inconsistency!.attribution).toEqual({
      commit: CLAIM_SHA,
      authorName: CLAIM_AUTHOR,
      authorTime: "2025-06-15T15:06:40.000Z",
    });

    const bare = reconCandidate();
    expect(codes(bare, makeProbe({ blameRange: () => [{ commit: CLAIM_SHA, authorName: "", authorTime: "" }] }))).toEqual([]);
    // A missing person is missing, never guessed: the commit is the load-bearing half.
    expect(bare.inconsistency!.attribution).toEqual({ commit: CLAIM_SHA });
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

// Design §9: the metric plane needs to know WHICH findings newly landed on this call, and it has
// to learn it from the ingest itself. The command boundary emits one analytics row per id in this
// array, so what is in it decides whether "time to first finding" and the share metrics measure
// onboarding or measure how often somebody re-ran a command.
describe("ingestRun reports the findings that newly landed (design §9)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-newfindings-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const reconResults = (candidates: unknown[]) => [
    { scout: "reconciliation", status: "complete", candidates },
  ];

  it("returns the candidate id of each finding whose document was newly ingested", async () => {
    seedRun(home);
    const first = reconCandidate({}, 1);
    const second = reconCandidate({}, 2);
    const res = await ingestRun(ingestArgs(home, "run-1", reconResults([first, second])));
    expect(res.ok).toBe(true);
    expect(res.newFindingIds).toHaveLength(2);
    // Asserted against the SIDECAR's ids, not against candidateId() re-run on the fixtures. The
    // ids must join to the records `mla enrich resolve` reads, and the CLI expands the short
    // commit prefix a scout may send before it hashes, so a fixture-side recomputation would
    // "pass" while producing an id that resolves to nothing.
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    const findingIds = sidecar.candidates
      .filter((c) => c.kind === "doc_code_inconsistency")
      .map((c) => c.candidateId);
    expect(new Set(res.newFindingIds)).toEqual(new Set(findingIds));
  });

  it("returns NOTHING for a re-onboard the server deduped (noop_unchanged)", async () => {
    // The single most damaging way to get this wrong. A repository that re-onboards would
    // restart the time-to-first-finding clock and re-count toward the share metrics every time,
    // so a feature nobody adopted would read as one being discovered over and over.
    seedRun(home);
    const deduping: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "noop_unchanged" as const })),
    }));
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: reconResults([reconCandidate()]) },
      persist: deduping,
      now: NOW,
      probe: makeProbe(),
    });
    // It still landed (persisted counts it), it just was not NEW.
    expect(res.outcomes.find((o) => o.scout === "reconciliation")!.persisted).toBe(1);
    expect(res.newFindingIds).toEqual([]);
  });

  it("returns NOTHING for a document the server failed to persist", async () => {
    seedRun(home);
    const failing: Persister = jest.fn(async (docs) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "failed" as const })),
    }));
    const res = await ingestRun({
      env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
      request: { protocolVersion: 1, runId: "run-1", results: reconResults([reconCandidate()]) },
      persist: failing,
      now: NOW,
      probe: makeProbe(),
    });
    expect(res.newFindingIds).toEqual([]);
  });

  it("counts ONLY findings, never the conventions and decisions the other scouts land", async () => {
    // The §9 metrics are about the drift-finding feature. A run that lands twelve conventions and
    // zero findings must read as zero findings, not as a productive onboarding.
    seedRun(home);
    const res = await ingestRun(
      ingestArgs(home, "run-1", [
        { scout: "documentation", status: "complete", candidates: [docCandidate()] },
        { scout: "history", status: "complete", candidates: [histCandidate()] },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.outcomes.find((o) => o.scout === "documentation")!.persisted).toBe(1);
    expect(res.newFindingIds).toEqual([]);
  });
});

// The sidecar is the ONLY place a finding survives its own ingest. Nothing re-derives it: the
// scout is gone, the results file was a temp file, and the KB holds rendered markdown. So a
// record written without its `inconsistency` is a finding that landed, counted, printed a
// candidate id, and then became permanently unanswerable, because every reader downstream
// (`isFinding`, the ingest summary, `mla enrich resolve`, findingToRuleCandidate) gates on the
// presence of that field. This is exactly what a live run of the built binary did: 1 persisted,
// "No inconsistencies...", and a review surface that reported zero.
describe("the sidecar carries the finding the CLI verified", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-ingest-sidecar-inc-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const reconResults = (candidates: unknown[]) => [
    { scout: "reconciliation", status: "complete", candidates },
  ];

  async function ingestOne(): Promise<OnboardingCandidateRecord> {
    seedRun(home);
    const res = await ingestRun(ingestArgs(home, "run-1", reconResults([reconCandidate()])));
    expect(res.ok).toBe(true);
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    const finding = sidecar.candidates.find((c) => c.kind === "doc_code_inconsistency");
    expect(finding).toBeDefined();
    return finding!;
  }

  it("persists the inconsistency, so the finding is still answerable in a later session", async () => {
    const finding = await ingestOne();
    expect(finding.inconsistency).toBeDefined();
    expect(finding.inconsistency!.claimClass).toBe("never_modify");
    expect(finding.inconsistency!.claimScope).toBe("src/generated/file-1.ts");
    expect(finding.inconsistency!.divergence).toEqual({ path: "src/generated/file-1.ts", status: "M" });
  });

  it("persists the CLI-stamped proposedRuleKind, not whatever a scout wished for", async () => {
    // The scout cannot send this field at all (unknown-field reject). If the record loses it, a
    // `code_diverged` resolution has no durable kind to mint under.
    const finding = await ingestOne();
    expect(finding.inconsistency!.proposedRuleKind).toBe(FINDING_PROPOSED_RULE_KIND);
  });

  it("persists the attribution ingest derived from blame, so the card can say who last changed it", async () => {
    const finding = await ingestOne();
    expect(finding.inconsistency!.attribution).toBeDefined();
    expect(finding.inconsistency!.attribution!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("persists the VERIFIED quote, not the model's string", async () => {
    // verifyInconsistency overwrites claimText with the normalized text it proved is in the
    // document. A record that kept the wire string would mint a rule the CLI never verified.
    const finding = await ingestOne();
    expect(finding.inconsistency!.claimText).toBe(reconClaim(1));
  });

  it("leaves a non-finding candidate WITHOUT an inconsistency", async () => {
    // The field is present iff the kind is a finding, enforced both directions. A convention
    // carrying one would make isFinding true for something that answers no question.
    seedRun(home);
    const res = await ingestRun(
      ingestArgs(home, "run-1", [{ scout: "documentation", status: "complete", candidates: [docCandidate()] }]),
    );
    expect(res.ok).toBe(true);
    const sidecar = loadCandidatesSidecar(home, "ws_1", "run-1")!;
    expect(sidecar.candidates).toHaveLength(1);
    expect(sidecar.candidates[0].inconsistency).toBeUndefined();
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
