// test/commands/status-foreign-root.spec.ts
//
// `mla status` inside a correctly-activated repo printed "Meetless is not activated for
// this repo. Run `mla activate`." whenever the workspace-global scan cache was stamped by
// a DIFFERENT checkout of the same workspace (2026-07-28 and again 2026-08-02). The marker
// was present the whole time, so the message was a lie in exactly the case that matters:
// the operator runs `mla activate`, it succeeds, and nothing explains why rules are missing.
//
// readScanCacheForRoot returns null for two structurally different reasons and status
// collapsed them into one string:
//   (a) nothing has ever been scanned for this workspace  -> "not activated" is TRUE
//   (b) a global slot exists, owned by another root        -> "not activated" is FALSE
//
// `mla doctor` already tells the truth here (ruleDeliveryDoctorChecks); status did not.
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanResult } from "../../src/lib/scanner/types";

function scanFixture(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 1,
    workspaceId: "ws-foreign",
    commitSha: "deadbee",
    generatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    inventory: {
      instructionFiles: 4,
      decisionDocs: 1,
      legacyNotes: 0,
      staleSignals: 0,
      agentMemoryRules: 0,
    },
    directives: [],
    staleSignals: [],
    confirmedRulesXml: "",
    floorRulesXml: "<floor/>",
    staleContextXml: "",
    advisoryDirectives: [],
    ...overrides,
  } as unknown as ScanResult;
}

describe("mla status: a scan cache owned by another checkout", () => {
  let tmp: string;
  let mlHome: string;
  let thisRoot: string;
  let otherRoot: string;
  let prevHome: string | undefined;
  let prevWs: string | undefined;
  let prevCwd: string;
  let out: string[];
  let err: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mla-status-root-")));
    mlHome = join(tmp, ".meetless");
    thisRoot = join(tmp, "checkout-here");
    otherRoot = join(tmp, "checkout-elsewhere");
    mkdirSync(thisRoot, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });

    prevHome = process.env.MEETLESS_HOME;
    prevWs = process.env.MEETLESS_WORKSPACE_ID;
    prevCwd = process.cwd();
    process.env.MEETLESS_HOME = mlHome;
    process.env.MEETLESS_WORKSPACE_ID = "ws-foreign";
    // No .meetless.json anywhere under tmp, so resolveScanRoot falls back to cwd:
    // this checkout's identity is thisRoot itself.
    process.chdir(thisRoot);

    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevWs === undefined) delete process.env.MEETLESS_WORKSPACE_ID;
    else process.env.MEETLESS_WORKSPACE_ID = prevWs;
    rmSync(tmp, { recursive: true, force: true });
    jest.resetModules();
  });

  // Re-require under the sandboxed MEETLESS_HOME so config.ts's module-level CFG_PATH
  // resolves inside tmp. There is no cli-config.json there, so readConfig() throws,
  // probeMembershipDenied returns null, and no membership request leaves the machine.
  function load(): {
    runStatus: typeof import("../../src/commands/status").runStatus;
    writeScanCache: typeof import("../../src/lib/scanner/cache").writeScanCache;
  } {
    let mods!: ReturnType<typeof load>;
    jest.isolateModules(() => {
      mods = {
        runStatus: require("../../src/commands/status").runStatus,
        writeScanCache: require("../../src/lib/scanner/cache").writeScanCache,
      };
    });
    return mods;
  }

  it("does NOT claim the repo is unactivated when another live checkout owns the cache", async () => {
    const { runStatus, writeScanCache } = load();
    writeScanCache(tmp, "ws-foreign", scanFixture({ scanRootPath: otherRoot }));

    const code = await runStatus([]);

    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain("not activated");
    expect(err.join("\n")).toBe("");
  });

  it("names the checkout that owns the cache, and the one command that fixes it", async () => {
    const { runStatus, writeScanCache } = load();
    writeScanCache(tmp, "ws-foreign", scanFixture({ scanRootPath: otherRoot }));

    await runStatus([]);
    const text = out.join("\n");

    // The operator must be able to see WHICH directory took the slot without
    // reconstructing it from ~/.meetless by hand.
    expect(text).toContain(otherRoot);
    expect(text).toContain(thisRoot);
    expect(text).toContain("mla scan");
    // And it must not send them back to the command that already succeeded.
    expect(text).not.toContain("mla activate");
  });

  it("says the floor still delivers and the scoped rules do not", async () => {
    const { runStatus, writeScanCache } = load();
    writeScanCache(tmp, "ws-foreign", scanFixture({ scanRootPath: otherRoot }));

    await runStatus([]);
    const text = out.join("\n").toLowerCase();

    // The hot-path hook reads .floorRulesXml straight out of the workspace-global slot
    // (hooks-template/user-prompt-submit.sh), so the floor survives a foreign stamp and
    // only the repo-specific half is lost. Saying "no rules" here would be the opposite lie.
    expect(text).toContain("floor");
    expect(text).toContain("scoped");
  });

  // The 2026-07-28 shape: the poisoner was a peer session's scratchpad, deleted minutes
  // later. Naming a path the operator cannot even `cd` into, with no hint that it is gone,
  // reads as a live sibling checkout they are supposed to go find.
  it("says so when the owning directory no longer exists", async () => {
    const { runStatus, writeScanCache } = load();
    const throwaway = join(tmp, "scratchpad-gone");
    mkdirSync(throwaway, { recursive: true });
    writeScanCache(tmp, "ws-foreign", scanFixture({ scanRootPath: throwaway }));
    rmSync(throwaway, { recursive: true, force: true });

    await runStatus([]);
    const text = out.join("\n");

    expect(text).toContain(throwaway);
    expect(text).toContain("no longer exists");
  });

  it("still says not-activated when nothing has ever been scanned", async () => {
    const { runStatus } = load();

    const code = await runStatus([]);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("not activated");
  });

  it("reports active when this checkout owns its own per-root slot", async () => {
    const { runStatus, writeScanCache } = load();
    writeScanCache(tmp, "ws-foreign", scanFixture({ scanRootPath: thisRoot }));

    await runStatus([]);

    expect(out.join("\n")).toContain("Meetless is active");
  });

  // A cache written before scanRootPath existed carries no stamp. readScanCacheForRoot
  // TRUSTS it (single-repo installs must not regress into a scary message on upgrade).
  it("reports active for an unstamped legacy cache", async () => {
    const { runStatus, writeScanCache } = load();
    writeScanCache(tmp, "ws-foreign", scanFixture());

    await runStatus([]);

    expect(out.join("\n")).toContain("Meetless is active");
    expect(out.join("\n")).not.toContain("DIFFERENT");
  });
});
