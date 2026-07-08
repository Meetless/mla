// test/commands/scan-context.spec.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rescanAndCache, resolveScanRoot, resolveScanTarget } from "../../src/commands/scan-context";
import { readScanCache, writeVerdicts } from "../../src/lib/scanner/cache";

function git(cwd: string, args: string[]) { execFileSync("git", args, { cwd, stdio: "ignore" }); }

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
});
