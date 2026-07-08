import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { onboardingLockPath, releaseOnboardingLock } from "../../src/lib/enrichment/lock";
import { runRecordPath } from "../../src/lib/enrichment/plan";
import { writeState } from "../../src/lib/enrichment/ingest";

// Command-boundary coverage for the plan-digest idempotency gate
// (notes/20260627-onboarding-idempotency-plandigest-gate.md). The gate's job: a re-run of
// `mla enrich plan` on a repository that is unchanged since a COMPLETED onboarding run must
// add nothing (scout output is LLM-non-deterministic, so candidate-level dedup never fires;
// the deterministic planDigest is the safe key). findCompletedRunWithDigest is unit-tested in
// test/lib/enrichment/idempotency-gate.spec.ts; what THIS proves is the CLI wiring: the gate
// fires before persistPlan, releases the lock on a no-op, does NOT prune the prior record it
// is gating against, and --force / a changed repo / a partial prior all bypass it. Real git +
// filesystem, exactly as production runs.

const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-idem-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich } = enrich;

const WS = "ws_enrich_idem";

function seedCliConfig(): void {
  writeFileSync(
    join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: "http://127.0.0.1:1",
      controlToken: "ik-test",
      actorUserId: "user_test",
      mlaPath: "/bin/true",
    }),
  );
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nGoverning rule: do the thing.\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
}

interface PlanJson {
  runId: string;
  planDigest: string;
  gated?: boolean;
  priorRunId?: string;
  candidatesPersisted?: number;
  reason?: string;
}

describe("mla enrich plan: plan-digest idempotency gate", () => {
  let repoDir: string;
  let restoreCwd: () => void;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    seedCliConfig();
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "mla-enrich-idem-repo-"));
    initRepo(repoDir);
    restoreCwd = bindWorkspaceMarker(repoDir, WS);
    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  // Run one `enrich plan --json`, then simulate a COMPLETED run of it the way `enrich ingest`
  // would: release the lock and write a complete state sidecar carrying the candidate counts.
  // Returns the first run's parsed plan so a follow-up plan can be gated against it.
  async function completeFirstRun(counts: { documentation: number; history: number }): Promise<PlanJson> {
    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const first = JSON.parse(out.join("\n")) as PlanJson;
    out.length = 0;
    releaseOnboardingLock(HOME, WS, first.runId);
    writeState(HOME, {
      workspaceId: WS,
      runId: first.runId,
      repositoryRoot: repoDir,
      schemaVersion: 1,
      status: "complete",
      updatedAt: "2026-06-27T00:00:00.000Z",
      scouts: {
        documentation: { status: "complete", candidateCount: counts.documentation },
        history: { status: "complete", candidateCount: counts.history },
      },
    });
    return first;
  }

  it("gates a re-run on an unchanged repo: no-op, reports the prior run, holds no lock", async () => {
    const first = await completeFirstRun({ documentation: 7, history: 5 });

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const gated = JSON.parse(out.join("\n")) as PlanJson;

    expect(gated.gated).toBe(true);
    expect(gated.reason).toBe("unchanged_repository");
    expect(gated.priorRunId).toBe(first.runId);
    expect(gated.planDigest).toBe(first.planDigest); // same repo -> same deterministic digest
    expect(gated.candidatesPersisted).toBe(12); // 7 + 5

    // A no-op holds no run: the lock was released, not left dangling.
    expect(existsSync(onboardingLockPath(HOME, WS))).toBe(false);
    // The gate must NOT prune the completed record it is gating against.
    expect(existsSync(runRecordPath(HOME, WS, first.runId))).toBe(true);
  });

  it("the human (non-JSON) gated message names the prior run and the --force escape hatch", async () => {
    const first = await completeFirstRun({ documentation: 1, history: 0 });

    const rc = await runEnrich(["plan"]); // human summary
    expect(rc).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/unchanged/i);
    expect(text).toContain(first.runId);
    expect(text).toMatch(/--force/);
    expect(text).toMatch(/1 candidate\b/); // singular, count 1
  });

  it("--force bypasses the gate: a fresh run is minted and the lock is claimed", async () => {
    const first = await completeFirstRun({ documentation: 7, history: 5 });

    const rc = await runEnrich(["plan", "--json", "--force"]);
    expect(rc).toBe(0);
    const forced = JSON.parse(out.join("\n")) as PlanJson;

    expect(forced.gated).toBeUndefined(); // a real plan, not a gated envelope
    expect(forced.runId).toMatch(/^run-/);
    expect(forced.runId).not.toBe(first.runId);
    // --force onboards again: it persists + prunes, so the new run owns the lock.
    expect(existsSync(onboardingLockPath(HOME, WS))).toBe(true);
    const lock = JSON.parse(readFileSync(onboardingLockPath(HOME, WS), "utf8")) as { runId: string };
    expect(lock.runId).toBe(forced.runId);
  });

  it("does NOT gate when the prior run is only partial (work left undone)", async () => {
    const rc0 = await runEnrich(["plan", "--json"]);
    expect(rc0).toBe(0);
    const first = JSON.parse(out.join("\n")) as PlanJson;
    out.length = 0;
    releaseOnboardingLock(HOME, WS, first.runId);
    writeState(HOME, {
      workspaceId: WS,
      runId: first.runId,
      repositoryRoot: repoDir,
      schemaVersion: 1,
      status: "partial",
      updatedAt: "2026-06-27T00:00:00.000Z",
      scouts: {
        documentation: { status: "complete", candidateCount: 7 },
        history: { status: "timed_out" },
      },
    });

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const next = JSON.parse(out.join("\n")) as PlanJson;
    expect(next.gated).toBeUndefined(); // partial prior must be allowed to finish
    expect(next.runId).not.toBe(first.runId);
  });

  it("does NOT gate when the repository changed (different plan digest)", async () => {
    const first = await completeFirstRun({ documentation: 7, history: 5 });

    // Change the repo so the next plan digest differs from the completed run's.
    writeFileSync(join(repoDir, "CLAUDE.md"), "# Project\n\nGoverning rule: do a DIFFERENT thing now.\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "change"],
      { cwd: repoDir },
    );

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const next = JSON.parse(out.join("\n")) as PlanJson;
    expect(next.gated).toBeUndefined();
    expect(next.runId).not.toBe(first.runId);
    expect(next.planDigest).not.toBe(first.planDigest);
  });

  it("does NOT gate a fresh repo with no prior completed run", async () => {
    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const plan = JSON.parse(out.join("\n")) as PlanJson;
    expect(plan.gated).toBeUndefined();
    expect(plan.runId).toMatch(/^run-/);
  });
});
