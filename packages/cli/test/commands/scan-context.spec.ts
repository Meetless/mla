// test/commands/scan-context.spec.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  rescanAndCache,
  resolveScanRoot,
  resolveScanTarget,
  runScanContext,
} from "../../src/commands/scan-context";
import { readScanCache, writeVerdicts } from "../../src/lib/scanner/cache";
import type { DeliveryOutcome } from "../../src/lib/rules/bundle-refresh";
import type { ReconciliationFinding } from "../../src/lib/scanner/types";

function git(cwd: string, args: string[]) { execFileSync("git", args, { cwd, stdio: "ignore" }); }

/** One §3.5 reconciliation finding in cache shape, shared by the rescan and the runScanContext specs. */
const FINDING: ReconciliationFinding = {
  path: "CLAUDE.md",
  evaluatedDigest: "sha256:abc",
  contentNormalizationVersion: "v1",
  reason: "contradicts an accepted decision",
  acceptedStatement: "Use 127.0.0.1, never localhost.",
  sourceCaseId: "case_1",
  supersedingCommitmentId: "cm_1",
  currentSummary: "the file still says localhost",
  detectorExplanation: "contradicts an accepted decision",
  detectorVersion: "detector-v1",
};

describe("resolveScanTarget", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-sct-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws-marker" }));
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("resolves id + root from the marker when invoked from a subdir (no env/flag)", () => {
    const sub = join(repo, "apps", "control");
    mkdirSync(sub, { recursive: true });
    // The whole point of ISSUE #1: scanning from a package subdir must still scan
    // the workspace root, not just that subtree (git ls-files from a subdir only
    // lists the subtree, which is how nested CLAUDE.md rules got silently dropped).
    expect(resolveScanTarget({ startDir: sub, env: {}, argv: [] })).toEqual({
      workspaceId: "ws-marker",
      scanRoot: resolve(repo),
    });
  });

  it("env id wins over the marker id but scanRoot stays the marker dir", () => {
    expect(resolveScanTarget({ startDir: repo, env: { MEETLESS_WORKSPACE_ID: "ws-env" }, argv: [] })).toEqual({
      workspaceId: "ws-env",
      scanRoot: resolve(repo),
    });
  });

  it("falls back to startDir when no marker exists and an explicit id is given", () => {
    const bare = mkdtempSync(join(tmpdir(), "mla-bare-"));
    try {
      expect(resolveScanTarget({ startDir: bare, env: {}, argv: ["--workspace", "ws-flag"] })).toEqual({
        workspaceId: "ws-flag",
        scanRoot: resolve(bare),
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("errors when neither a marker nor an explicit id is available", () => {
    const bare = mkdtempSync(join(tmpdir(), "mla-bare-"));
    try {
      const t = resolveScanTarget({ startDir: bare, env: {}, argv: [] });
      expect("error" in t).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("resolveScanRoot", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-scanroot-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws-marker" }));
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("returns the marker dir when invoked from a subdir", () => {
    const sub = join(repo, "apps", "control");
    mkdirSync(sub, { recursive: true });
    expect(resolveScanRoot(sub)).toBe(resolve(repo));
  });

  it("returns the start dir unchanged when no marker exists up the tree", () => {
    const bare = mkdtempSync(join(tmpdir(), "mla-scanroot-bare-"));
    try {
      expect(resolveScanRoot(bare)).toBe(resolve(bare));
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("rescanAndCache", () => {
  let repo: string; let home: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-sc-repo-"));
    home = mkdtempSync(join(tmpdir(), "mla-sc-home-"));
    git(repo, ["init"]); git(repo, ["config", "user.email", "t@t"]); git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
    writeFileSync(join(repo, "notes-old.md"), "---\nstatus: deprecated\n---\nold\n");
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "i"]);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  // ISSUE #4: a verdict (accept/dismiss) from a package subdir must rescan the
  // WHOLE workspace, not just that subtree. The cwd-rooted rescan silently drops
  // every rule outside the subdir AND shifts the stale-signal ids (they are
  // path-relative), so the just-dismissed signal resurfaces under a new id.
  it("anchored rescan from a subdir keeps root rules + stable ids; the cwd-rooted rescan drops them", () => {
    mkdirSync(join(repo, "apps", "control"), { recursive: true });
    writeFileSync(join(repo, "apps", "control", "old.md"), "---\nstatus: deprecated\n---\nold\n");
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws1" }));
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "sub"]);
    const sub = join(repo, "apps", "control");

    // OLD behavior: scanning from cwd only sees the subtree.
    const naive = rescanAndCache({ cwd: sub, workspaceId: "ws1", home, now: () => "t" });
    expect(naive.directives.length).toBe(0); // root CLAUDE.md silently lost

    // FIX: anchoring to the marker dir scans the whole workspace, root-relative.
    const anchored = rescanAndCache({ cwd: resolveScanRoot(sub), workspaceId: "ws1", home, now: () => "t" });
    expect(anchored.directives.map((d) => d.text)).toContain("NEVER commit secrets.");
    expect(anchored.staleSignals.map((s) => s.source)).toContain("apps/control/old.md");
  });

  it("writes a cache reflecting current verdicts", () => {
    const result = readScanCacheFrom(repo, home, "ws1");
    expect(result.staleSignals.length).toBe(1);
    const dismissedId = result.staleSignals[0].id;

    writeVerdicts(home, "ws1", { schemaVersion: 1, accepted: [], dismissed: [dismissedId] });
    const after = readScanCacheFrom(repo, home, "ws1");
    expect(after.staleSignals.length).toBe(0);
    expect(after.confirmedRulesXml).toContain("NEVER commit secrets.");
  });

  // INV-3: a dismissed stale signal id must not appear in the pre-rendered
  // staleContextXml that the hook reads. Confirm that dismissing clears the xml
  // field while the confirmedRulesXml (rules) is unaffected.
  it("INV-3: dismissed signal is absent from staleContextXml but rules remain intact", () => {
    const result = readScanCacheFrom(repo, home, "ws1");
    const stale = result.staleSignals[0];
    expect(result.staleContextXml).toContain(stale.detail); // signal present before dismiss

    writeVerdicts(home, "ws1", { schemaVersion: 1, accepted: [], dismissed: [stale.id] });
    const after = readScanCacheFrom(repo, home, "ws1");

    // The pre-rendered xml the hook reads must no longer contain the dismissed signal.
    expect(after.staleContextXml).not.toContain(stale.detail);
    // Dismissing must not affect rules.
    expect(after.confirmedRulesXml).toContain("NEVER commit secrets.");
  });

  function readScanCacheFrom(cwd: string, h: string, ws: string) {
    rescanAndCache({ cwd, workspaceId: ws, home: h, now: () => "t" });
    return readScanCache(h, ws)!;
  }

  // ---------------------------------------------------------------------------------------------
  // Reconciliation findings survive a LOCAL rescan (ADR §3.5, T11).
  //
  // `writeScanCache` overwrites the whole file, and `rescanAndCache` is called from four places:
  // `mla scan` (which pulls), plus activate, `mla context`, and internal-steer-sync (which do not).
  // Without carry-forward the feature blinks out: `mla scan` fetches findings and the very next
  // `mla context` seconds later wipes them. So a rescan with nothing supplied must preserve what is
  // there, and it must preserve the ORIGINAL stamp, because a purely local rescan is not evidence
  // that control still serves the finding.
  // ---------------------------------------------------------------------------------------------

  it("stamps a supplied findings list with the time of the pull that produced it", () => {
    rescanAndCache({
      cwd: repo, workspaceId: "ws1", home, now: () => "2026-07-20T10:00:00.000Z",
      reconciliation: [FINDING],
    });

    const cached = readScanCache(home, "ws1")!;
    expect(cached.reconciliationFindings).toEqual([FINDING]);
    expect(cached.reconciliationFetchedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  it("carries findings forward through a local rescan WITHOUT refreshing their stamp", () => {
    rescanAndCache({
      cwd: repo, workspaceId: "ws1", home, now: () => "2026-07-20T10:00:00.000Z",
      reconciliation: [FINDING],
    });

    // `mla context` an hour later: no pull, so nothing new is known about liveness.
    rescanAndCache({ cwd: repo, workspaceId: "ws1", home, now: () => "2026-07-20T11:00:00.000Z" });

    const cached = readScanCache(home, "ws1")!;
    expect(cached.reconciliationFindings).toEqual([FINDING]);
    // The anti-laundering assertion. If a local rescan could advance this stamp, an offline laptop
    // would keep its findings looking freshly confirmed forever and the assembler's freshness gate
    // would never fire, which is the entire failure mode that gate exists to stop.
    expect(cached.reconciliationFetchedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  it("CLEARS the findings when a pull explicitly returned none", () => {
    rescanAndCache({
      cwd: repo, workspaceId: "ws1", home, now: () => "2026-07-20T10:00:00.000Z",
      reconciliation: [FINDING],
    });

    // An empty list is an ANSWER, not an absence: control no longer serves this finding, so it was
    // dismissed, resolved, or its decision was retracted. Carrying it forward here would keep
    // injecting a retracted decision under trust="governed".
    rescanAndCache({
      cwd: repo, workspaceId: "ws1", home, now: () => "2026-07-20T11:00:00.000Z",
      reconciliation: [],
    });

    const cached = readScanCache(home, "ws1")!;
    expect(cached.reconciliationFindings).toEqual([]);
    expect(cached.reconciliationFetchedAt).toBe("2026-07-20T11:00:00.000Z");
  });
});

// `mla scan` is the PULL half of rule delivery. A verb can only push what IT changed; the same
// authority is also mutated from the Console, from another machine, and by a teammate promoting a
// TEAM rule. `scan` is the documented lever for all of that ("rebuild this repo's local rule cache
// from the backend bundle") and it used to do no such thing: it rescanned whatever bundle happened
// to be cached and never contacted control, which made its own help text false.
describe("runScanContext", () => {
  let repo: string; let home: string; let cwd: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-rsc-repo-"));
    // The caches MUST be redirected through the `home` dep, not through $HOME: on macOS
    // os.homedir() reads getpwuid and ignores the env var entirely, so an env-only redirect
    // silently writes a test's scan cache into the OPERATOR's real ~/.meetless (it does contain
    // it on Linux CI, which is exactly what makes that mistake so easy to ship).
    home = mkdtempSync(join(tmpdir(), "mla-rsc-home-"));
    git(repo, ["init"]); git(repo, ["config", "user.email", "t@t"]); git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws-scan" }));
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "i"]);
    cwd = process.cwd();
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function sink() {
    const out: string[] = []; const err: string[] = [];
    return { out, err, o: (l: string) => out.push(l), e: (l: string) => err.push(l) };
  }

  it("re-fetches the backend bundle for the resolved workspace, then scans", async () => {
    const asked: string[] = [];
    const { out, err, o, e } = sink();

    const code = await runScanContext([], {
      refreshBundle: async (ws) => { asked.push(ws); return { delivered: true }; },
      home,
      out: o, err: e,
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["ws-scan"]); // the marker's workspace, not a guess
    expect(out[0]).toMatch(/^scanned: /);
    expect(err).toEqual([]);
  });

  // Ordering is the invariant: the fetch has to LAND before the scan reads, or the scan rebuilds the
  // cache from the bundle that was already there and the change arrives a full cycle late. Proven
  // causally rather than with a spy: the refresh drops a rule into the world, and the scan sees it.
  it("scans the state produced BY the refresh, not the state before it", async () => {
    const { out, o, e } = sink();

    const code = await runScanContext([], {
      refreshBundle: async () => {
        writeFileSync(join(repo, "AGENTS.md"), "- ALWAYS write a test first.\n");
        git(repo, ["add", "."]); git(repo, ["commit", "-m", "refresh"]);
        return { delivered: true };
      },
      home,
      out: o, err: e,
    });

    expect(code).toBe(0);
    const cached = readScanCache(home, "ws-scan")!;
    expect(cached.directives.map((d) => d.text)).toContain("ALWAYS write a test first.");
    expect(out[0]).toMatch(/^scanned: /);
  });

  // On a plane, in CI, logged out, or against a dead control: scanning must still WORK. It degrades
  // to the last cached bundle and says so on stderr. What it must never do is fail, and it must
  // never silently imply the cache is current.
  it("warns and still scans (exit 0) when the bundle refresh fails", async () => {
    const { out, err, o, e } = sink();

    const code = await runScanContext([], {
      refreshBundle: async (): Promise<DeliveryOutcome> => ({ delivered: false, error: "ECONNREFUSED" }),
      home,
      out: o, err: e,
    });

    expect(code).toBe(0);
    expect(out[0]).toMatch(/^scanned: /);
    expect(err.join("\n")).toContain("could not refresh the rule bundle");
    expect(err.join("\n")).toContain("ECONNREFUSED");
    expect(err.join("\n")).toContain("may be stale");
    expect(readScanCache(home, "ws-scan")).not.toBeNull(); // scanned anyway
  });

  // The SECOND pull that rides this same refresh moment. Two pulls, one moment, independent
  // outcomes: a findings failure must not make the bundle look stale (rules would be wrongly
  // disclaimed) and a bundle failure must not suppress findings (a governed decision would silently
  // stop being surfaced).
  it("pulls reconciliation findings for the same workspace and lands them in the cache", async () => {
    const asked: string[] = [];
    const { out, err, o, e } = sink();

    const code = await runScanContext([], {
      refreshBundle: async () => ({ delivered: true }),
      fetchReconciliation: async (ws) => {
        asked.push(ws);
        return { findings: [FINDING], truncated: false };
      },
      home,
      out: o, err: e,
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["ws-scan"]);
    const cached = readScanCache(home, "ws-scan")!;
    expect(cached.reconciliationFindings).toEqual([FINDING]);
    expect(cached.reconciliationFetchedAt).toBeTruthy();
    expect(err).toEqual([]);
    expect(out[0]).toMatch(/^scanned: /);
  });

  it("still pulls findings when the bundle refresh failed, and vice versa", async () => {
    const { o, e } = sink();

    // Bundle down, findings up: the divergence is still real and must still be surfaced.
    const code = await runScanContext([], {
      refreshBundle: async (): Promise<DeliveryOutcome> => ({ delivered: false, error: "ECONNREFUSED" }),
      fetchReconciliation: async () => ({ findings: [FINDING], truncated: false }),
      home,
      out: o, err: e,
    });

    expect(code).toBe(0);
    expect(readScanCache(home, "ws-scan")!.reconciliationFindings).toEqual([FINDING]);

    // Findings down, bundle up: the rules must land without a whisper of a findings problem, and
    // the previous findings must survive rather than being cleared by a transport error.
    const second = sink();
    const code2 = await runScanContext([], {
      refreshBundle: async () => ({ delivered: true }),
      fetchReconciliation: async () => ({ findings: null, error: "ECONNREFUSED" }),
      home,
      out: second.o, err: second.e,
    });

    expect(code2).toBe(0);
    expect(readScanCache(home, "ws-scan")!.reconciliationFindings).toEqual([FINDING]);
  });

  it("fails with a usage error and never touches the network when no workspace can be resolved", async () => {
    const bare = mkdtempSync(join(tmpdir(), "mla-rsc-bare-"));
    const prevWs = process.env.MEETLESS_WORKSPACE_ID;
    delete process.env.MEETLESS_WORKSPACE_ID;
    process.chdir(bare);
    const asked: string[] = [];
    const { out, err, o, e } = sink();
    try {
      const code = await runScanContext([], {
        refreshBundle: async (ws) => { asked.push(ws); return { delivered: true }; },
        fetchReconciliation: async (ws) => { asked.push(ws); return { findings: [], truncated: false }; },
        out: o, err: e,
      });

      expect(code).toBe(2);
      // NEITHER pull may fire. They are concurrent now, so "we bailed before the network" has to be
      // asserted across both doors or a resolution bug leaks out through the one nobody watched.
      expect(asked).toEqual([]);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("no workspace id");
    } finally {
      process.chdir(repo);
      if (prevWs !== undefined) process.env.MEETLESS_WORKSPACE_ID = prevWs;
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
