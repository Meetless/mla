// test/commands/scan-cache-root-guard.spec.ts
//
// Finding A: one workspace can bind several checkouts (meetless-monorepo + intel share a
// workspace), and EVERY per-workspace artifact lives under workspaces/<workspaceId>/, so two
// checkouts' scans write the SAME scan-cache.json and stomp each other. The repo-specific fields
// (commitSha, inventory, staleSignals, locally-parsed scopedRules) then belong to whichever
// checkout scanned LAST, and an unguarded read in the other checkout would render / inject a
// sibling repo's scan as its own.
//
// The fix has two halves. First, each scan is stamped with its scan-root identity
// (ScanResult.scanRootPath) and read back through readScanCacheForRoot / a filtered review card,
// so a reader never sees a sibling checkout's scan as its own. That guard alone leaves the other
// checkouts DARK, which is what took every floor MUST off the prompt for 8h11m on 2026-08-02, so
// the second half gives each root its own cache slot: a scan from B writes B's slot and cannot
// darken A. Legacy (unstamped) caches and single-repo installs must be entirely unaffected.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readScanCacheForRoot,
  rescanAndCache,
  resolveScanRootIdentity,
} from "../../src/commands/scan-context";
import {
  readScanCache,
  reviewCardsPath,
  scanCachePathForRoot,
  writeScanCache,
} from "../../src/lib/scanner/cache";
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

// A minimal stamped ScanResult, for the write-side cases that need two scans differing in exactly
// one field. Everything a real scan derives from a checkout is overridable.
function mkScan(scanRootPath: string, over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 2,
    workspaceId: "owner-ws",
    commitSha: "0000",
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
    scanRootPath,
    ...over,
  };
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

  it("keeps each checkout on its OWN scan after a sibling scans the same workspace", () => {
    // A scans, then B scans the SAME workspace.
    rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    rescanAndCache({ cwd: repoB, workspaceId: WS, home, now: () => "t" });

    // The workspace-global slot keeps its OWNER, the first root to stamp it, for as long as that
    // root exists on disk. It used to belong to whoever scanned last, and that was the defect:
    // the stamp guard could tell A the cache was not its own, but it could not give A a cache, so
    // A went dark. (See the ownership cases below for what a non-owner is still allowed to write.)
    expect(readScanCache(home, WS)!.scanRootPath).toBe(realpathSync(repoA));

    // Per-root slots end that. Each root reads its own, so B's scan neither replaces A's nor
    // darkens it, and neither checkout can be handed the other's repo-specific scan.
    const asA = readScanCacheForRoot(home, WS, repoA)!;
    const asB = readScanCacheForRoot(home, WS, repoB)!;
    expect(asA.scanRootPath).toBe(realpathSync(repoA));
    expect(asB.scanRootPath).toBe(realpathSync(repoB));
    // Content, not just the stamp: each carries ITS repo's unique superseded ADR and commit.
    expect(asA.staleSignals.map((s) => s.source)).toEqual(["docs/adr/0001-a.md"]);
    expect(asB.staleSignals.map((s) => s.source)).toEqual(["docs/adr/0002-b.md"]);
    expect(asA.commitSha).not.toBe(asB.commitSha);
  });

  it("falls back to the stamp guard when this root has no per-root slot", () => {
    // The shape an older build leaves behind: one stamped workspace-global cache and no per-root
    // slot at all. The guard is still the only thing standing between A and B's scan, so it has
    // to keep rejecting a foreign stamp on that path.
    rescanAndCache({ cwd: repoB, workspaceId: WS, home, now: () => "t" });
    rmSync(scanCachePathForRoot(WS, realpathSync(repoB), home), { force: true });

    expect(readScanCacheForRoot(home, WS, repoA)).toBeNull();
    expect(readScanCacheForRoot(home, WS, repoB)!.scanRootPath).toBe(realpathSync(repoB));
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

// The write side of the same finding, and the half that per-root slots did NOT close.
//
// Per-root slots fix the read for a root that already owns a slot. They do nothing for the ONE
// workspace-global scan-cache.json, which is still written unconditionally by every scan and is
// what the three shell readers in the hot-path hook consume. That is the file a scan inside a
// throwaway directory stomped on 2026-07-28 (a peer's scratchpad, via `mla scan`) and again on
// 2026-08-02 (three `mla activate` calls from /private/tmp/live-handoff-test-000{1,2,3}, since
// deleted). Both times the poisoning root HAD instruction files, so a guard keyed on "this root
// looks empty" would have shipped green and fired on neither.
//
// The rule instead is ownership: the first root to stamp the global slot keeps its repo-specific
// fields for as long as that root exists on disk, a stranger may refresh only the workspace-global
// floor, and the slot changes hands the moment the owner's directory is gone.
describe("scan-cache workspace-global slot ownership (Finding A, write side)", () => {
  let home: string;
  let repoA: string;
  let repoB: string;
  const WS = "owner-ws";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-own-home-"));
    repoA = makeRepo("mla-own-a-", "0001-a.md");
    repoB = makeRepo("mla-own-b-", "0002-b.md");
  });

  afterEach(() => {
    for (const d of [home, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  });

  it("a scan from a throwaway root cannot take the slot from a live checkout", () => {
    // The 2026-08-02 shape: the real checkout is activated, then a live-exercise test runs the
    // same command from a temp dir bound to the SAME workspace id.
    const owner = rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    const throwaway = makeRepo("mla-own-throwaway-", "0003-t.md");
    try {
      rescanAndCache({ cwd: throwaway, workspaceId: WS, home, now: () => "t" });
    } finally {
      rmSync(throwaway, { recursive: true, force: true });
    }

    // Before this fix the slot named the temp dir, the temp dir was then deleted, and every root
    // in the workspace read `delivery-incomplete` until a human noticed.
    const global = readScanCache(home, WS)!;
    expect(global.scanRootPath).toBe(realpathSync(repoA));
    expect(global.commitSha).toBe(owner.commitSha);
    expect(global.staleSignals.map((s) => s.source)).toEqual(["docs/adr/0001-a.md"]);
  });

  it("lets a stranger refresh the workspace-global floor without taking the repo-specific fields", () => {
    // Hand-built so the two scans differ in exactly one field per class: floor (workspace-global,
    // identical from any root, so the freshest wins) versus commitSha/inventory (one checkout's).
    writeScanCache(home, WS, mkScan(realpathSync(repoA), { commitSha: "aaaa", floorRulesXml: "<old/>" }));
    writeScanCache(home, WS, mkScan(realpathSync(repoB), { commitSha: "bbbb", floorRulesXml: "<new/>" }));

    const global = readScanCache(home, WS)!;
    expect(global.scanRootPath).toBe(realpathSync(repoA));
    expect(global.commitSha).toBe("aaaa"); // A's, untouched
    expect(global.floorRulesXml).toBe("<new/>"); // B's, refreshed
  });

  it("keeps the incumbent's schemaVersion, so a preserved record never over-claims", () => {
    // schemaVersion gates how the assembler reads the record it is attached to. Raising a v1
    // record to v2 because a v2 scan arrived would claim structured arrays it does not carry,
    // turning a VISIBLE degraded delivery into a silent floor-only one.
    writeScanCache(home, WS, mkScan(realpathSync(repoA), { schemaVersion: 1 }));
    writeScanCache(home, WS, mkScan(realpathSync(repoB), { schemaVersion: 2 }));
    expect(readScanCache(home, WS)!.schemaVersion).toBe(1);
  });

  it("hands the slot over once the owner's directory is gone (the self-heal that was missing)", () => {
    const ghost = makeRepo("mla-own-ghost-", "0004-g.md");
    const ghostPath = realpathSync(ghost);
    rescanAndCache({ cwd: ghost, workspaceId: WS, home, now: () => "t" });
    expect(readScanCache(home, WS)!.scanRootPath).toBe(ghostPath);

    // The temp dir is deleted, which is exactly what left the 2026-07-28 cache unmatchable
    // forever: "that directory is then deleted, so the cache can never match again and nothing
    // self-heals."
    rmSync(ghost, { recursive: true, force: true });
    rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    expect(readScanCache(home, WS)!.scanRootPath).toBe(realpathSync(repoA));
  });

  it("a rescan from the owner itself still replaces the whole record", () => {
    writeScanCache(home, WS, mkScan(realpathSync(repoA), { commitSha: "aaaa" }));
    writeScanCache(home, WS, mkScan(realpathSync(repoA), { commitSha: "cccc" }));
    expect(readScanCache(home, WS)!.commitSha).toBe("cccc");
  });

  it("drops a per-root slot whose directory has vanished before capping by mtime", () => {
    // mtime order is backwards for this hazard: throwaway roots are the NEWEST slots, so a pure
    // mtime cap evicts the real checkouts and keeps the temp dirs. A slot naming a root that is
    // gone is unreachable (reads key on the live cwd's realpath), so it goes first.
    rescanAndCache({ cwd: repoA, workspaceId: WS, home, now: () => "t" });
    const ghost = makeRepo("mla-own-ghost2-", "0005-g.md");
    const ghostPath = realpathSync(ghost);
    rescanAndCache({ cwd: ghost, workspaceId: WS, home, now: () => "t" });
    expect(existsSync(scanCachePathForRoot(WS, ghostPath, home))).toBe(true);

    rmSync(ghost, { recursive: true, force: true });
    rescanAndCache({ cwd: repoB, workspaceId: WS, home, now: () => "t" }); // any write prunes

    expect(existsSync(scanCachePathForRoot(WS, ghostPath, home))).toBe(false);
    expect(existsSync(scanCachePathForRoot(WS, realpathSync(repoA), home))).toBe(true);
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
