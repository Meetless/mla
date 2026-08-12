import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readScanCacheAtRoot, writeScanCache } from "../../../src/lib/scanner/cache";
import type { ScanResult } from "../../../src/lib/scanner/types";

// D2 / S3. THE INVARIANT:
//
//   A live bound root must not silently lose repo-specific governance merely
//   because other live roots exist.
//
// The per-root slot is what carries a checkout's own scoped rules, inventory and
// review items; `readScanCacheForRoot` reads it first and, when it is missing,
// falls back to the workspace-global slot whose stamp check then REFUSES a
// foreign root. That is a floor-only turn: the workspace floor still reaches the
// model, the repo's own rules do not, and nothing says a word.
//
// Pruning used to cap slot COUNT at 8 and evict the oldest by mtime. That cap was
// written when "real installs have one to three roots" was true. Under D2 a
// company binds ten or thirty repos to one workspace, and the eleventh activate
// silently darkens the repo nobody has touched recently. A cardinality limit is
// the wrong instrument for correctness: it cannot tell a dead root from a quiet
// one, and only one of those is safe to drop.

const HOME = mkdtempSync(join(tmpdir(), "mla-slot-home-"));
const WS = "ws-slots";

function mkScan(rootPath: string): ScanResult {
  return {
    schemaVersion: 2,
    workspaceId: WS,
    scanRootPath: rootPath,
    generatedAt: "2026-08-10T00:00:00.000Z",
    commitSha: "abc1234",
    directives: [],
    scopedRules: [{ id: `rule-for-${rootPath}` }],
    staleSignals: [],
    inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0 },
  } as unknown as ScanResult;
}

function slotFiles(): string[] {
  const dir = join(HOME, ".meetless", "workspaces", WS, "roots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("scan-cache-") && f.endsWith(".json"));
}

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe("per-root slots: liveness decides eviction, never a count", () => {
  let roots: string[];
  let base: string;

  beforeEach(() => {
    rmSync(join(HOME, ".meetless", "workspaces", WS), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    base = mkdtempSync(join(tmpdir(), "mla-slot-roots-"));
    roots = [];
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function liveRoot(name: string): string {
    const p = join(base, name);
    mkdirSync(p, { recursive: true });
    roots.push(p);
    return p;
  }

  it("keeps EVERY live root's slot readable, well past the old cap of 8", () => {
    // A company with twenty repos on one shared workspace. Every one of them is
    // a real checkout somebody works in.
    const dirs = Array.from({ length: 20 }, (_, i) => liveRoot(`repo-${i}`));
    for (const d of dirs) writeScanCache(HOME, WS, mkScan(d));

    for (const d of dirs) {
      const slot = readScanCacheAtRoot(HOME, WS, d);
      // The assertion that IS the invariant: this checkout's own scoped rules
      // are still addressable, so its next turn is not floor-only.
      expect(slot?.scanRootPath).toBe(d);
      expect(slot?.scopedRules).toEqual([{ id: `rule-for-${d}` }]);
    }
    expect(slotFiles()).toHaveLength(20);
  });

  it("still reaps slots whose root directory is GONE", () => {
    const live = liveRoot("live");
    const doomed = Array.from({ length: 5 }, (_, i) => liveRoot(`temp-${i}`));
    for (const d of [live, ...doomed]) writeScanCache(HOME, WS, mkScan(d));
    expect(slotFiles()).toHaveLength(6);

    // The throwaway dirs vanish, as temp dirs do.
    for (const d of doomed) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    // Any subsequent write runs the prune.
    writeScanCache(HOME, WS, mkScan(live));

    expect(slotFiles()).toHaveLength(1);
    expect(readScanCacheAtRoot(HOME, WS, live)?.scanRootPath).toBe(live);
  });

  it("a quiet live root outlives many newer dead ones (mtime is not the signal)", () => {
    // The exact shape the old mtime cap got backwards: the temp dirs are the
    // NEWEST slots, so sorting by mtime evicted the real checkout and kept them.
    const quiet = liveRoot("quiet-but-real");
    writeScanCache(HOME, WS, mkScan(quiet));
    for (let i = 0; i < 12; i++) {
      const t = liveRoot(`throwaway-${i}`);
      writeScanCache(HOME, WS, mkScan(t));
      rmSync(t, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
    writeScanCache(HOME, WS, mkScan(quiet));

    expect(readScanCacheAtRoot(HOME, WS, quiet)?.scanRootPath).toBe(quiet);
  });

  it("caps only slots it cannot prove live, and never drops a provable one", () => {
    // Unparseable slots carry no root to check. They are the only population a
    // cardinality limit may act on, because "cannot tell" is not "vanished" but
    // it is also not a licence to accumulate forever.
    const live = liveRoot("real");
    writeScanCache(HOME, WS, mkScan(live));
    const dir = join(HOME, ".meetless", "workspaces", WS, "roots");
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(dir, `scan-cache-junk${i}.json`), "{ not json", "utf8");
    }
    writeScanCache(HOME, WS, mkScan(live));

    // The live root survives...
    expect(readScanCacheAtRoot(HOME, WS, live)?.scanRootPath).toBe(live);
    // ...and the unprovable pile is bounded rather than unbounded.
    const junk = slotFiles().filter((f) => f.includes("junk"));
    expect(junk.length).toBeLessThan(40);
  });
});
