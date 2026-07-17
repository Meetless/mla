// test/commands/scan-cache-root-guard.spec.ts
//
// Finding A: one workspace can bind several checkouts (meetless-monorepo + intel share a
// workspace), and EVERY per-workspace artifact lives under workspaces/<workspaceId>/, so two
// checkouts' scans write the SAME scan-cache.json and stomp each other. The repo-specific fields
// (commitSha, inventory, staleSignals, locally-parsed scopedRules) then belong to whichever
// checkout scanned LAST, and an unguarded read in the other checkout would render / inject a
// sibling repo's scan as its own.
//
// The fix stamps each scan with its scan-root identity (ScanResult.scanRootPath) and reads it back
// through readScanCacheForRoot / a filtered review card, so a reader only ever sees ITS checkout's
// scan. Legacy (unstamped) caches and single-repo installs must be entirely unaffected.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readScanCacheForRoot,
  rescanAndCache,
  resolveScanRootIdentity,
} from "../../src/commands/scan-context";
import { readScanCache, reviewCardsPath, writeScanCache } from "../../src/lib/scanner/cache";
import { latestReviewCardItems } from "../../src/commands/context";
import { ScanResult } from "../../src/lib/scanner/types";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A real git checkout with one unique superseded ADR, so its scan carries a stale signal no other
// checkout has. Returns the repo path (its scan-root identity is realpathSync(repo)).
function makeRepo(prefix: string, adrFile: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "adr", adrFile),
    "# ADR\nStatus: superseded by ADR-9999\n## Decision\nuse X\n",
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "i"]);
  return repo;
}

describe("scan-cache scan-root guard (Finding A: two checkouts, one workspace)", () => {
  let home: string;
  let repoA: string;
  let repoB: string;
  const WS = "shared-ws";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-guard-home-"));
    repoA = makeRepo("mla-guard-a-", "0001-a.md");
    repoB = makeRepo("mla-guard-b-", "0002-b.md");
  });

  afterEach(() => {
    for (const d of [home, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  });

  it("stamps the scan with the realpath of its scan root", () => {
    const scan = rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    expect(scan.scanRootPath).toBe(realpathSync(repoA));
    // and it round-trips onto disk
    expect(readScanCache(home, WS)!.scanRootPath).toBe(realpathSync(repoA));
  });

  it("isolates a checkout from a sibling that stomped the shared cache file", () => {
    // A scans, then B scans the SAME workspace: B's scan overwrites the one shared file.
    rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    rescanAndCache({ cwd: repoB, workspaceId: WS, home, now: () => "t" });

    // The file on disk now belongs to B (last writer wins) — this is the stomp.
    expect(readScanCache(home, WS)!.scanRootPath).toBe(realpathSync(repoB));

    // The guarded read isolates them: reading AS A rejects B's cache (would otherwise show B's
    // commitSha / stale signals as A's), reading AS B accepts it.
    expect(readScanCacheForRoot(home, WS, repoA)).toBeNull();
    const asB = readScanCacheForRoot(home, WS, repoB);
    expect(asB).not.toBeNull();
    expect(asB!.scanRootPath).toBe(realpathSync(repoB));
  });

  it("does not regress the single-checkout case: a scan is readable from its own root", () => {
    rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    expect(readScanCacheForRoot(home, WS, repoA)).not.toBeNull();
  });

  it("trusts a legacy (unstamped) cache, so pre-fix installs are unaffected", () => {
    const legacy: ScanResult = {
      schemaVersion: 2,
      workspaceId: WS,
      commitSha: "deadbeef",
      generatedAt: "t",
      inventory: {
        instructionFiles: 1,
        decisionDocs: 0,
        legacyNotes: 0,
        staleSignals: 0,
        agentMemoryRules: 0,
      },
      directives: [],
      staleSignals: [],
      confirmedRulesXml: "",
      floorRulesXml: "",
      staleContextXml: "",
      advisoryDirectives: [],
      // no scanRootPath: this is the shape written before Finding A
    };
    writeScanCache(home, "legacy-ws", legacy);
    // Read from ANY root: an unstamped cache is trusted (only a present, mismatching stamp is rejected).
    const got = readScanCacheForRoot(home, "legacy-ws", repoB);
    expect(got).not.toBeNull();
    expect(got!.commitSha).toBe("deadbeef");
  });
});

describe("latestReviewCardItems scan-root filter (Finding A)", () => {
  let home: string;
  const WS = "cards-ws";

  function appendCard(scanRoot: string | null, itemId: string): void {
    const path = reviewCardsPath(WS, home);
    mkdirSync(join(path, ".."), { recursive: true });
    const row: Record<string, unknown> = {
      ts: "t",
      event: "review_card",
      session_id: "s",
      items: [{ id: itemId, detail: "d", source: "docs/x.md" }],
      total: 1,
    };
    if (scanRoot !== null) row.scan_root = scanRoot;
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-cards-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("returns the card for the current checkout, skipping a sibling checkout's later card", () => {
    appendCard("/repo/a", "from-a");
    appendCard("/repo/b", "from-b"); // newer, but a different checkout
    // Reading as checkout A skips B's newer card and returns A's.
    expect(latestReviewCardItems(home, WS, "/repo/a").map((i) => i.id)).toEqual(["from-a"]);
    expect(latestReviewCardItems(home, WS, "/repo/b").map((i) => i.id)).toEqual(["from-b"]);
  });

  it("trusts an unstamped (legacy) card regardless of the current root", () => {
    appendCard(null, "legacy");
    expect(latestReviewCardItems(home, WS, "/repo/anything").map((i) => i.id)).toEqual(["legacy"]);
  });

  it("without a current root (2-arg back-compat) returns the latest card unfiltered", () => {
    appendCard("/repo/a", "from-a");
    appendCard("/repo/b", "from-b");
    expect(latestReviewCardItems(home, WS).map((i) => i.id)).toEqual(["from-b"]);
  });

  it("resolveScanRootIdentity is stable and realpath-canonical for a real dir", () => {
    const d = mkdtempSync(join(tmpdir(), "mla-id-"));
    try {
      expect(resolveScanRootIdentity(d)).toBe(realpathSync(d));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
