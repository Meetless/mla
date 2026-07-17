import { mkdtempSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOnboardingRun, writeRunRecord } from "../../../src/lib/enrichment/plan";
import { writeState, findCompletedRunWithDigest } from "../../../src/lib/enrichment/ingest";
import type { OnboardingRun, OnboardingState } from "../../../src/lib/enrichment/protocol";

// Unit coverage for the idempotency gate's lookup (findCompletedRunWithDigest). The command
// wiring is covered end-to-end in test/commands/enrich-idempotency.spec.ts; this isolates the
// matching rules a single-repo command test cannot reach: digest equality, complete-only,
// per-repo scoping by realpath (a workspace can bind several repos), and excludeRunId.

const HOME = mkdtempSync(join(tmpdir(), "mla-idem-gate-home-"));
const WS = "ws_gate";

function makeRun(runId: string, repositoryRoot: string): OnboardingRun {
  // Same {workspaceId, repositoryRoot, limits, targets, evidence} -> same deterministic
  // planDigest, regardless of runId/createdAt (excluded from the digest).
  return buildOnboardingRun({
    runId,
    workspaceId: WS,
    repositoryRoot,
    now: "2026-06-27T00:00:00.000Z",
    documentationTargets: [],
    historyEvidence: [],
  });
}

function completeState(run: OnboardingRun, counts = { documentation: 3, history: 2 }): OnboardingState {
  return {
    workspaceId: WS,
    runId: run.runId,
    repositoryRoot: run.repositoryRoot,
    schemaVersion: 2,
    status: "complete",
    updatedAt: "2026-06-27T01:00:00.000Z",
    scouts: {
      documentation: { status: "complete", candidateCount: counts.documentation },
      history: { status: "complete", candidateCount: counts.history },
    },
  };
}

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("findCompletedRunWithDigest", () => {
  it("returns null when no run directory exists yet", () => {
    expect(findCompletedRunWithDigest(HOME, "ws_never", "/tmp/nope", "deadbeef")).toBeNull();
  });

  it("matches a completed run with the same repo + plan digest", () => {
    const repo = mkdtempSync(join(tmpdir(), "mla-idem-repo-a-"));
    const run = makeRun("run-a1", repo);
    writeRunRecord(HOME, run);
    writeState(HOME, completeState(run, { documentation: 7, history: 5 }));

    const hit = findCompletedRunWithDigest(HOME, WS, repo, run.planDigest);
    expect(hit).not.toBeNull();
    expect(hit!.run.runId).toBe("run-a1");
    expect(hit!.state.status).toBe("complete");
    expect(hit!.state.scouts.documentation.candidateCount).toBe(7);
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not match when the plan digest differs", () => {
    const repo = mkdtempSync(join(tmpdir(), "mla-idem-repo-b-"));
    const run = makeRun("run-b1", repo);
    writeRunRecord(HOME, run);
    writeState(HOME, completeState(run));

    expect(findCompletedRunWithDigest(HOME, WS, repo, "0".repeat(64))).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not match a run whose state is partial (or has no state at all)", () => {
    const repo = mkdtempSync(join(tmpdir(), "mla-idem-repo-c-"));
    // No state written at all: an in-flight run never ingested.
    const bare = makeRun("run-c-bare", repo);
    writeRunRecord(HOME, bare);
    expect(findCompletedRunWithDigest(HOME, WS, repo, bare.planDigest)).toBeNull();

    // Partial state: work left undone, must not gate.
    const partial = makeRun("run-c-partial", repo);
    writeRunRecord(HOME, partial);
    writeState(HOME, { ...completeState(partial), runId: "run-c-partial", status: "partial" });
    expect(findCompletedRunWithDigest(HOME, WS, repo, partial.planDigest)).toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not match a completed run of a DIFFERENT repo that shares the workspace + digest", () => {
    // A workspace can bind several repos (monorepo + intel). buildOnboardingRun folds the
    // repositoryRoot into the digest, so two distinct repos never collide on digest here;
    // assert the per-repo scoping explicitly with two real repos.
    const repoX = mkdtempSync(join(tmpdir(), "mla-idem-repo-x-"));
    const repoY = mkdtempSync(join(tmpdir(), "mla-idem-repo-y-"));
    const runX = makeRun("run-x1", repoX);
    writeRunRecord(HOME, runX);
    writeState(HOME, completeState(runX));

    // Looking up under repoY (its own digest) must not return repoX's run.
    const runY = makeRun("run-y-probe", repoY);
    expect(findCompletedRunWithDigest(HOME, WS, repoY, runY.planDigest)).toBeNull();
    // And looking up repoX with runY's (different) digest must also miss.
    expect(findCompletedRunWithDigest(HOME, WS, repoX, runY.planDigest)).toBeNull();
    rmSync(repoX, { recursive: true, force: true });
    rmSync(repoY, { recursive: true, force: true });
  });

  it("matches across a symlinked repo path (realpath-normalized)", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "mla-idem-repo-real-")));
    const run = makeRun("run-sym", real);
    writeRunRecord(HOME, run);
    writeState(HOME, completeState(run));

    const linkParent = mkdtempSync(join(tmpdir(), "mla-idem-link-"));
    const link = join(linkParent, "alias");
    symlinkSync(real, link);
    // The record stored the real path; a lookup via the symlink alias must still match
    // (the gate normalizes both sides with realpath).
    const hit = findCompletedRunWithDigest(HOME, WS, link, run.planDigest);
    expect(hit?.run.runId).toBe("run-sym");
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  });

  it("honors excludeRunId (the in-flight run never gates against itself)", () => {
    const repo = mkdtempSync(join(tmpdir(), "mla-idem-repo-self-"));
    const run = makeRun("run-self", repo);
    writeRunRecord(HOME, run);
    writeState(HOME, completeState(run));

    expect(findCompletedRunWithDigest(HOME, WS, repo, run.planDigest, "run-self")).toBeNull();
    // Without the exclusion it would match.
    expect(findCompletedRunWithDigest(HOME, WS, repo, run.planDigest)).not.toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });
});
