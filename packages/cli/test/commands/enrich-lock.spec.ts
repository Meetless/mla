import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import {
  acquireOnboardingLock,
  onboardingLockPath,
  type OnboardingLock,
} from "../../src/lib/enrichment/lock";

// Command-boundary coverage for the active-run guard (verdict item 3). The lock
// library is exhaustively unit-tested in test/lib/enrichment/lock.spec.ts (acquire,
// stale-reclaim, fail-closed, release ownership); createPlan has plan.spec.ts and
// ingestRun has ingest.spec.ts. What NEITHER layer proves is that `mla enrich plan`
// actually wires the guard at the CLI boundary: that a real second invocation while
// a run is live is rejected (exit 2) without clobbering the holder, and that a clean
// invocation claims the lock keyed to the run it just minted. That wiring (a deleted
// acquire call, a swallowed reject, or a release that fires too early) is invisible to
// the layered specs, so it gets a real end-to-end test here against the actual git +
// filesystem, exactly as the command runs in production.
//
// Scope note: the ingest-side RELEASE (`enrich ingest` frees the lock only on a
// complete run) is intentionally NOT re-tested here. ingestRun's completeness is
// covered by ingest.spec.ts and releaseOnboardingLock's run-keyed ownership by
// lock.spec.ts; the glue is one conditional line. A command-level ingest test would
// need a working kb-add HTTP stub purely to re-prove those two layers, so it stays
// at the unit boundary by design.

const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-lock-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME/CFG_PATH at
// module load, so the command must capture our tmp home.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich } = enrich;

const WS = "ws_enrich_lock";

function seedCliConfig(): void {
  // Legacy top-level controlToken migrates to shared-key auth (normalizeAuthFromDisk);
  // actorUserId is the preserved top-level value readKbConfig requires. controlUrl
  // points at a dead port: a clean plan never makes a network call, and the reject
  // path returns before createPlan, so nothing here should ever reach the wire.
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

// A minimal real git repo so resolveRepositoryRoot (git rev-parse) succeeds and
// createPlan's ls-files/log have something to scan. One tracked T1 doc + one commit
// is enough for a valid, non-empty plan.
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

function readLock(): OnboardingLock {
  return JSON.parse(readFileSync(onboardingLockPath(HOME, WS), "utf8")) as OnboardingLock;
}

describe("mla enrich plan: active-run guard wiring", () => {
  let repoDir: string;
  let restoreCwd: () => void;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    seedCliConfig();
    // Fresh per-workspace lock/run state so one test never leaks a held lock into the next.
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "mla-enrich-lock-repo-"));
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

  it("a clean plan claims the lock keyed to the run it just minted", async () => {
    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);

    // The plan JSON is the agent contract; its runId must be the one stamped into the lock.
    const plan = JSON.parse(out.join("\n")) as { runId: string };
    expect(plan.runId).toMatch(/^run-/);
    expect(existsSync(onboardingLockPath(HOME, WS))).toBe(true);
    const lock = readLock();
    expect(lock.runId).toBe(plan.runId);
    expect(lock.workspaceId).toBe(WS);
  });

  it("rejects a second plan while a run is live, without clobbering the holder", async () => {
    // Stand up a live lock the way a first `enrich plan` would have, with a long ttl so
    // it is unambiguously non-stale at the real wall-clock the command reads.
    const held = acquireOnboardingLock({
      home: HOME,
      workspaceId: WS,
      runId: "run-existing",
      repositoryRoot: repoDir,
      now: new Date().toISOString(),
      ttlMs: 10 * 60_000,
    });
    expect(held.ok).toBe(true);

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(2);
    // Disambiguate from the other exit-2 paths (bad flags, missing config, no git repo):
    // this 2 must come from the active-run guard specifically.
    expect(err.join("\n")).toMatch(/already active/i);
    // The reject must name the way out. An ABANDONED run (the agent crashed, the human hit
    // Ctrl-C mid-`/mla onboard`) holds a lock that is LIVE by the clock, so staleness cannot
    // free it: told only to "wait", the operator is blocked for the rest of budget + grace.
    expect(err.join("\n")).toContain("--force");
    // The loser never overwrote the winner: same run still owns the lock.
    expect(readLock().runId).toBe("run-existing");
  });

  it("--force takes the lock from an abandoned run and names what it displaced", async () => {
    const held = acquireOnboardingLock({
      home: HOME,
      workspaceId: WS,
      runId: "run-abandoned",
      repositoryRoot: repoDir,
      now: new Date().toISOString(),
      ttlMs: 10 * 60_000, // unambiguously live: only --force can take this
    });
    expect(held.ok).toBe(true);

    const rc = await runEnrich(["plan", "--json", "--force"]);
    expect(rc).toBe(0);

    const plan = JSON.parse(out.join("\n")) as { runId: string };
    expect(plan.runId).not.toBe("run-abandoned");
    expect(readLock().runId).toBe(plan.runId); // the new run owns the lock now
    // Displacing a run that had not expired is a real consequence of --force; it is reported,
    // never silent.
    expect(err.join("\n")).toContain("took the onboarding lock from run run-abandoned");
  });

  it("--force on a free lock displaces nothing and says nothing about it", async () => {
    const rc = await runEnrich(["plan", "--json", "--force"]);
    expect(rc).toBe(0);
    expect(err.join("\n")).not.toContain("took the onboarding lock");
  });
});
