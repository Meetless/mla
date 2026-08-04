// test/commands/activate-foreign-root-guard.spec.ts
//
// Item 4: "nothing stops a caller binding a live workspaceId to a throwaway path."
//
// `3ae06e39e` closed the loud half of this: a stranger root can no longer take the
// workspace-global slot away from a live checkout, and the repo-specific fields stay with their
// owner. What it deliberately left open is the floor: `globalSlotContent` lets ANY still-present
// stranger refresh `floorRulesXml` / `floorRules` / `floorMeta`, on the reasoning that the floor is
// workspace-global and principal-keyed, so every root should compute the same one.
//
// That reasoning holds only while the stranger can actually resolve a bundle. When it cannot (no
// network, no cached bundle for that principal, a throwaway dir that resolves no principal at all)
// the scan still succeeds and still carries an EMPTY floor, and the merge above writes that empty
// string straight over the incumbent's real floor. Three shell readers in the hot-path hook read
// `scan-cache.json.floorRulesXml` directly, so the blast radius is every prompt in the owning
// checkout: exactly the shape of the 8h11m floor outage on 2026-08-02, reached by a different road.
//
// A refresh is only a refresh if it carries something. An empty floor is an absence, and an absence
// must never overwrite a presence.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderForeignRootWarning } from "../../src/commands/activate";
import { rescanAndCache } from "../../src/commands/scan-context";
import { readScanCache, writeScanCache } from "../../src/lib/scanner/cache";
import { ScanResult } from "../../src/lib/scanner/types";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

// A real checkout carrying instruction files, so its scan is the kind a live workspace owns.
function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "CLAUDE.md"), "- NEVER commit secrets.\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "i"]);
  return repo;
}

// A throwaway directory: no git, no instruction files, nothing. The shape a test harness, a
// `mktemp -d`, or a stray `cd /tmp && mla activate` produces.
function makeThrowaway(): string {
  const dir = mkdtempSync(join(tmpdir(), "mla-throwaway-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  return dir;
}

function mkScan(scanRootPath: string, over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 2,
    workspaceId: "live-ws",
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

const REAL_FLOOR = "<floor-rules><rule>Work directly on main</rule></floor-rules>";

describe("a foreign root may not erase the floor it cannot compute", () => {
  let home: string;
  let owner: string;
  let stranger: string;
  const WS = "live-ws";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-item4-home-"));
    owner = makeRepo("mla-item4-owner-");
    stranger = makeRepo("mla-item4-stranger-");
  });

  afterEach(() => {
    for (const d of [home, owner, stranger]) rmSync(d, { recursive: true, force: true });
  });

  it("a stranger carrying an EMPTY floor cannot wipe the incumbent's real floor", () => {
    // The owner holds a real floor: this is what the hot-path hook injects on every prompt.
    writeScanCache(home, WS, mkScan(owner, { floorRulesXml: REAL_FLOOR }));
    expect(readScanCache(home, WS)!.floorRulesXml).toBe(REAL_FLOOR);

    // A different, still-present root scans and resolves no bundle, so it carries no floor.
    writeScanCache(home, WS, mkScan(stranger, { floorRulesXml: "" }));

    // The floor must survive. Before the guard this read "" and every prompt in the owner's
    // checkout lost its MUSTs.
    expect(readScanCache(home, WS)!.floorRulesXml).toBe(REAL_FLOOR);
    // and the slot still belongs to its owner
    expect(readScanCache(home, WS)!.scanRootPath).toBe(owner);
  });

  it("a stranger carrying a REAL floor still refreshes it, which is the whole point of the merge", () => {
    const NEWER = "<floor-rules><rule>Commit frequently</rule></floor-rules>";
    writeScanCache(home, WS, mkScan(owner, { floorRulesXml: REAL_FLOOR }));
    writeScanCache(home, WS, mkScan(stranger, { floorRulesXml: NEWER }));
    expect(readScanCache(home, WS)!.floorRulesXml).toBe(NEWER);
  });

  it("the owner itself may still clear its own floor, because that is not a stranger's absence", () => {
    // Ownership, not emptiness, is the discriminator. A rescan from the owning root replaces the
    // whole record, including a floor that genuinely went away.
    writeScanCache(home, WS, mkScan(owner, { floorRulesXml: REAL_FLOOR }));
    writeScanCache(home, WS, mkScan(owner, { floorRulesXml: "" }));
    expect(readScanCache(home, WS)!.floorRulesXml).toBe("");
  });

  it("an absent floor field is treated the same as an empty one", () => {
    // `floorRules` / `floorMeta` are optional, so a stranger that omits them entirely is the same
    // absence wearing different clothes. Guarding only the empty string would leave this open.
    writeScanCache(home, WS, mkScan(owner, { floorRulesXml: REAL_FLOOR }));
    const bare = mkScan(stranger);
    delete (bare as Partial<ScanResult>).floorRulesXml;
    writeScanCache(home, WS, bare);
    expect(readScanCache(home, WS)!.floorRulesXml).toBe(REAL_FLOOR);
  });

  it("warns when a doc-less root binds a workspace another live checkout owns", () => {
    // The cache guard above makes the poisoning harmless. It does not make it VISIBLE, and the
    // 2026-08-02 incident was found by human eyes reading a directory listing. So activate says so.
    const warning = renderForeignRootWarning({
      scan: mkScan(stranger, { inventory: { ...mkScan(stranger).inventory, instructionFiles: 0 } }),
      incumbentRootPath: owner,
    });
    expect(warning).toBeTruthy();
    // It has to name the OTHER checkout, or the operator cannot act on it.
    expect(warning).toContain(owner);
  });

  it("stays silent for the ordinary single-checkout case", () => {
    // The overwhelming majority of installs. A warning here would be noise, and noise is how a
    // real warning gets ignored later.
    expect(
      renderForeignRootWarning({
        scan: mkScan(owner, { inventory: { ...mkScan(owner).inventory, instructionFiles: 0 } }),
        incumbentRootPath: owner,
      }),
    ).toBeNull();
    expect(
      renderForeignRootWarning({
        scan: mkScan(owner, { inventory: { ...mkScan(owner).inventory, instructionFiles: 0 } }),
        incumbentRootPath: null,
      }),
    ).toBeNull();
  });

  it("stays silent when the second checkout brought its own instruction files", () => {
    // Two real checkouts of one workspace is a supported, normal setup. Only the doc-less case is
    // suspicious, because that is the throwaway-dir shape.
    expect(
      renderForeignRootWarning({
        scan: mkScan(stranger, { inventory: { ...mkScan(stranger).inventory, instructionFiles: 3 } }),
        incumbentRootPath: owner,
      }),
    ).toBeNull();
  });

  it("is reachable from the real scan path, not just a hand-built record", () => {
    // The hand-built cases above prove the MERGE POLICY. This one proves a real scan of a real
    // throwaway root actually produces the empty floor that policy has to defend against, so the
    // guard is protecting a live road rather than a hypothetical one.
    const throwaway = makeThrowaway();
    try {
      const scan = rescanAndCache({ cwd: throwaway, workspaceId: WS, home, now: () => "t" });
      expect(scan.floorRulesXml ?? "").toBe("");
      expect(scan.inventory.instructionFiles).toBe(0);
    } finally {
      rmSync(throwaway, { recursive: true, force: true });
    }
  });
});
