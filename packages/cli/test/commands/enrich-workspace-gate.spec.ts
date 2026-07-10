import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { onboardingLockPath, releaseOnboardingLock } from "../../src/lib/enrichment/lock";
import { runRecordPath } from "../../src/lib/enrichment/plan";
import { writeState } from "../../src/lib/enrichment/ingest";
import type { OnboardingRun, ScoutIngestOutcome, ScoutName } from "../../src/lib/enrichment/protocol";

// Command-boundary + pure-helper coverage for the WORKSPACE-grain half of the onboarding
// idempotency gate (notes/20260710-mla-onboarding-idempotency-and-activate-autochain.md).
// The local (plan-digest) half is proven in enrich-idempotency.spec.ts; what THIS proves is
// the OTHER source in the OR: a marker keyed on the cross-machine git HEAD. A real local HTTP
// stub stands in for intel so the wiring is exercised end to end (no mocked fetch): the gate
// consults `/internal/v1/onboarding/status` ONLY when the local gate misses and --force is
// absent, gates by "workspace" on a true marker, fails OPEN on an unreachable intel, and never
// pays the round-trip once the local record already gates.

const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-wsgate-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich, decideOnboardingGate, buildOnboardingMarkerRequest, checkWorkspaceOnboarded } = enrich;

const WS = "ws_enrich_wsgate";

// --- the intel stub ---------------------------------------------------------------------
interface Hit {
  path: string;
  query: URLSearchParams;
}
let server: Server;
let port: number;
let hits: Hit[] = [];
let statusResponse: { status: number; body: unknown } = { status: 200, body: { onboarded: false } };

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push({ path: u.pathname, query: u.searchParams });
    res.writeHead(statusResponse.status, { "content-type": "application/json" });
    res.end(JSON.stringify(statusResponse.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(HOME, { recursive: true, force: true });
});

function seedCliConfig(intelUrl: string): void {
  writeFileSync(
    join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl,
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
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
}

// -------------------------------------------------------------------------------------------
// Pure precedence table. Every (force, localHit, workspaceOnboarded) combination, so the OR
// and the local>workspace ordering are pinned without touching git, the fs, or the network.
// -------------------------------------------------------------------------------------------
describe("decideOnboardingGate (pure precedence)", () => {
  const table: Array<{
    force: boolean;
    localHit: boolean;
    workspaceOnboarded: boolean;
    expect: ReturnType<typeof decideOnboardingGate>;
  }> = [
    // --force always wins: never gated, whatever the two sources say.
    { force: true, localHit: true, workspaceOnboarded: true, expect: { gated: false } },
    { force: true, localHit: false, workspaceOnboarded: true, expect: { gated: false } },
    { force: true, localHit: true, workspaceOnboarded: false, expect: { gated: false } },
    { force: true, localHit: false, workspaceOnboarded: false, expect: { gated: false } },
    // local wins over workspace when both are set (offline + path-precise, no round-trip).
    { force: false, localHit: true, workspaceOnboarded: true, expect: { gated: true, by: "local" } },
    { force: false, localHit: true, workspaceOnboarded: false, expect: { gated: true, by: "local" } },
    // workspace gates only when local missed.
    { force: false, localHit: false, workspaceOnboarded: true, expect: { gated: true, by: "workspace" } },
    // neither: proceed.
    { force: false, localHit: false, workspaceOnboarded: false, expect: { gated: false } },
  ];

  it.each(table)(
    "force=$force local=$localHit ws=$workspaceOnboarded -> $expect",
    ({ force, localHit, workspaceOnboarded, expect: want }) => {
      expect(decideOnboardingGate({ force, localHit, workspaceOnboarded })).toEqual(want);
    },
  );
});

// -------------------------------------------------------------------------------------------
// The best-effort marker payload written after a successful ingest.
// -------------------------------------------------------------------------------------------
describe("buildOnboardingMarkerRequest (pure)", () => {
  const HEAD = "a".repeat(40);
  const ROOT = "b".repeat(40);
  const runWith = (head: string | null, root: string | null = ROOT, digest: string | null = "pd-x"): OnboardingRun =>
    ({ headCommit: head, rootCommit: root, planDigest: digest } as unknown as OnboardingRun);
  const outcome = (scout: ScoutName, persisted: number): ScoutIngestOutcome => ({
    scout,
    received: persisted,
    accepted: persisted,
    rejected: 0,
    persisted,
    deduped: 0,
    errors: [],
  });

  it("returns null when there is no run (nothing to key on)", () => {
    expect(buildOnboardingMarkerRequest(null, [outcome("documentation", 3)], WS)).toBeNull();
  });

  it("returns null when the run has no git HEAD (cannot record cross-machine)", () => {
    expect(buildOnboardingMarkerRequest(runWith(null), [outcome("documentation", 3)], WS)).toBeNull();
  });

  it("sums persisted across scouts and carries the run's root + digest", () => {
    const body = buildOnboardingMarkerRequest(
      runWith(HEAD),
      [outcome("documentation", 4), outcome("history", 5)],
      WS,
    );
    expect(body).toEqual({
      workspaceId: WS,
      headCommit: HEAD,
      rootCommit: ROOT,
      planDigest: "pd-x",
      candidatesPersisted: 9,
    });
  });

  it("records a zero-candidate marker (a clean run still marks the HEAD onboarded)", () => {
    const body = buildOnboardingMarkerRequest(runWith(HEAD, null, null), [], WS);
    expect(body).toEqual({
      workspaceId: WS,
      headCommit: HEAD,
      rootCommit: null,
      planDigest: null,
      candidatesPersisted: 0,
    });
  });
});

// -------------------------------------------------------------------------------------------
// checkWorkspaceOnboarded: the FAIL-OPEN contract. Every failure resolves to onboarded:false.
// -------------------------------------------------------------------------------------------
describe("checkWorkspaceOnboarded (fail-open)", () => {
  const cfgFor = (intelUrl: string): any => ({
    intelUrl,
    workspaceId: WS,
    controlToken: "ik-test",
    auth: { mode: "shared-key", accessToken: "ik-test" },
  });

  beforeEach(() => {
    hits = [];
    statusResponse = { status: 200, body: { onboarded: true, candidatesPersisted: 9 } };
  });

  it("no git HEAD => onboarded:false with NO network round-trip", async () => {
    const res = await checkWorkspaceOnboarded(cfgFor(`http://127.0.0.1:${port}`), null);
    expect(res).toEqual({ onboarded: false });
    expect(hits).toHaveLength(0); // short-circuits before touching intel
  });

  it("unreachable intel => onboarded:false (never blocks onboarding)", async () => {
    const res = await checkWorkspaceOnboarded(cfgFor("http://127.0.0.1:1"), "c".repeat(40));
    expect(res).toEqual({ onboarded: false });
  });

  it("a 5xx from intel => onboarded:false", async () => {
    statusResponse = { status: 503, body: { error: "down" } };
    const res = await checkWorkspaceOnboarded(cfgFor(`http://127.0.0.1:${port}`), "c".repeat(40));
    expect(res).toEqual({ onboarded: false });
    expect(hits).toHaveLength(1); // it DID try
  });

  it("a true marker passes through with its completedAt + candidate count", async () => {
    statusResponse = {
      status: 200,
      body: { onboarded: true, completedAt: "2026-07-01T00:00:00.000Z", candidatesPersisted: 6 },
    };
    const head = "d".repeat(40);
    const res = await checkWorkspaceOnboarded(cfgFor(`http://127.0.0.1:${port}`), head);
    expect(res).toEqual({ onboarded: true, completedAt: "2026-07-01T00:00:00.000Z", candidatesPersisted: 6 });
    // The status probe is a GET carrying the HEAD + workspace as query, not a body.
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe("/internal/v1/onboarding/status");
    expect(hits[0].query.get("headCommit")).toBe(head);
    expect(hits[0].query.get("workspaceId")).toBe(WS);
  });
});

// -------------------------------------------------------------------------------------------
// Command boundary: `mla enrich plan` wiring for the workspace source. Real git + fs + a live
// intel stub, exactly as production runs.
// -------------------------------------------------------------------------------------------
interface PlanJson {
  runId: string;
  planDigest: string;
  gated?: boolean;
  gatedBy?: string;
  reason?: string;
  headCommit?: string;
  completedAt?: string | null;
  candidatesPersisted?: number;
}

describe("mla enrich plan: workspace-marker gate wiring", () => {
  let repoDir: string;
  let restoreCwd: () => void;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];

  beforeEach(() => {
    seedCliConfig(`http://127.0.0.1:${port}`);
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
    hits = [];
    statusResponse = { status: 200, body: { onboarded: false } };
    repoDir = mkdtempSync(join(tmpdir(), "mla-enrich-wsgate-repo-"));
    initRepo(repoDir);
    restoreCwd = bindWorkspaceMarker(repoDir, WS);
    out = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Simulate a COMPLETED local run of the current repo (as `enrich ingest` would leave it):
  // release the lock + write a complete state sidecar. Returns the plan JSON.
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
      updatedAt: "2026-07-01T00:00:00.000Z",
      scouts: {
        documentation: { status: "complete", candidateCount: counts.documentation },
        history: { status: "complete", candidateCount: counts.history },
      },
    });
    return first;
  }

  it("gates by workspace when a teammate's clone already onboarded this exact HEAD", async () => {
    statusResponse = {
      status: 200,
      body: { onboarded: true, completedAt: "2026-07-02T00:00:00.000Z", candidatesPersisted: 4 },
    };

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const gated = JSON.parse(out.join("\n")) as PlanJson;

    expect(gated.gated).toBe(true);
    expect(gated.gatedBy).toBe("workspace");
    expect(gated.reason).toBe("already_onboarded_in_workspace");
    expect(gated.candidatesPersisted).toBe(4);
    expect(gated.completedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(gated.headCommit).toMatch(/^[0-9a-f]{40}$/);

    // It consulted intel with the real repo HEAD + workspace.
    expect(hits).toHaveLength(1);
    expect(hits[0].query.get("headCommit")).toBe(gated.headCommit);
    expect(hits[0].query.get("workspaceId")).toBe(WS);

    // A gated no-op holds no lock and persists no run record (the gate fires before persist).
    expect(existsSync(onboardingLockPath(HOME, WS))).toBe(false);
    expect(existsSync(runRecordPath(HOME, WS, gated.runId))).toBe(false);
  });

  it("the human (non-JSON) workspace-gate message cites the other clone + the --force escape", async () => {
    statusResponse = { status: 200, body: { onboarded: true, candidatesPersisted: 1 } };
    const rc = await runEnrich(["plan"]);
    expect(rc).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/another clone/i);
    expect(text).toMatch(/--force/);
    expect(text).toMatch(/1 candidate\b/); // singular
  });

  it("local hit short-circuits: the workspace marker is NEVER consulted", async () => {
    await completeFirstRun({ documentation: 7, history: 5 });
    // Trap: even though the workspace marker WOULD gate, the local record must win first and
    // spare the network round-trip entirely.
    statusResponse = { status: 200, body: { onboarded: true, candidatesPersisted: 99 } };
    hits = [];

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const gated = JSON.parse(out.join("\n")) as PlanJson;
    expect(gated.gated).toBe(true);
    expect(gated.gatedBy).toBe("local");
    expect(gated.reason).toBe("unchanged_repository");
    expect(gated.candidatesPersisted).toBe(12); // from the LOCAL record, not the marker's 99
    expect(hits).toHaveLength(0); // no round-trip once the local gate fires
  });

  it("--force bypasses BOTH sources without touching intel", async () => {
    statusResponse = { status: 200, body: { onboarded: true, candidatesPersisted: 4 } };

    const rc = await runEnrich(["plan", "--json", "--force"]);
    expect(rc).toBe(0);
    const forced = JSON.parse(out.join("\n")) as PlanJson;
    expect(forced.gated).toBeUndefined();
    expect(forced.runId).toMatch(/^run-/);
    expect(hits).toHaveLength(0); // force skips the workspace check entirely
    expect(existsSync(onboardingLockPath(HOME, WS))).toBe(true);
  });

  it("workspace marker false + no local prior: proceeds to a real plan (fail-open miss)", async () => {
    statusResponse = { status: 200, body: { onboarded: false } };

    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const plan = JSON.parse(out.join("\n")) as PlanJson;
    expect(plan.gated).toBeUndefined();
    expect(plan.runId).toMatch(/^run-/);
    expect(hits).toHaveLength(1); // it DID consult, got a false, and proceeded
  });

  it("unreachable intel does not block a fresh onboarding (fail-open at the boundary)", async () => {
    seedCliConfig("http://127.0.0.1:1"); // dead port
    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const plan = JSON.parse(out.join("\n")) as PlanJson;
    expect(plan.gated).toBeUndefined();
    expect(plan.runId).toMatch(/^run-/);
  });
});
