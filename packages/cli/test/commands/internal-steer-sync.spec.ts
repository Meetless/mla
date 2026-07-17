import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseArgs } from "../../src/commands/internal-steer-sync";
import {
  RULE_BUNDLE_SCHEMA_VERSION,
  ruleBundleCachePath,
} from "../../src/lib/rules/bundle-cache";
import { managedRuleToRulePayload } from "../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../src/lib/rules/rule-version-hash";
import { makeManagedRule } from "../../src/lib/scanner/managed-rules";
import { writeScanCache, scanCachePath } from "../../src/lib/scanner/cache";
import type { ScanResult } from "../../src/lib/scanner/types";
import type { RuleBundle } from "../../src/lib/rules/control-rule-client";

// Plan 1 (cross-session conflict-resolution loop), Task 1.6. The minimal pinned
// contract is parseArgs (mirroring how internal-active-review pins its own
// parseArgs). A full pull -> cache -> markInjected run needs a live control and is
// exercised by the manual end-to-end task; the stubbed transport seam keeps the
// command itself offline-runnable but is not asserted here.

describe("internal steer-sync parseArgs", () => {
  it("parses --session", () => {
    expect(parseArgs(["--session", "abc"])).toEqual({ sessionId: "abc" });
  });

  it("throws when --session is absent (flush always passes it)", () => {
    expect(() => parseArgs([])).toThrow(/--session/);
  });

  it("throws on an unknown flag rather than silently binding it", () => {
    expect(() => parseArgs(["--session", "abc", "--nope"])).toThrow(/Unknown flag/);
  });
});

// The third job (G8 / D1 §11.3): on the SAME turn-boundary pass that pulls steers,
// snapshot the session's open conflicts and overwrite the zero-network active-conflict
// cache the PreToolUse hook reads. The hermetic seam is MEETLESS_CONFLICT_SYNC_STUB
// (parsed as the snapshot) paired with MEETLESS_STEER_SYNC_STUB_PULL (offline pull). We
// redirect $MEETLESS_HOME to a tmpdir and re-require the command so config's HOME const
// re-evaluates against it, then assert the on-disk snapshot the hook would read.
describe("internal steer-sync writes the active-conflict snapshot", () => {
  let home: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "steer-sync-conflict-"));
    prev = {
      MEETLESS_HOME: process.env.MEETLESS_HOME,
      MEETLESS_STEER_SYNC_STUB_PULL: process.env.MEETLESS_STEER_SYNC_STUB_PULL,
      MEETLESS_CONFLICT_SYNC_STUB: process.env.MEETLESS_CONFLICT_SYNC_STUB,
    };
    process.env.MEETLESS_HOME = home;
    process.env.MEETLESS_STEER_SYNC_STUB_PULL = "[]";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    jest.resetModules();
  });

  function snapshotFile(sessionId: string): string {
    return path.join(home, "logs", "steer", `active-conflicts-${sessionId}.json`);
  }

  it("overwrites the snapshot with the fetched open conflicts (within the TTL)", async () => {
    process.env.MEETLESS_CONFLICT_SYNC_STUB = JSON.stringify([
      { caseId: "case_1", openedAt: "2026-06-26T00:00:00.000Z", reason: "Contested by another session." },
    ]);
    jest.resetModules();
    const { runInternalSteerSync } = require("../../src/commands/internal-steer-sync");
    const code = await runInternalSteerSync(["--session", "sess_x"]);
    expect(code).toBe(0);
    const body = JSON.parse(fs.readFileSync(snapshotFile("sess_x"), "utf8"));
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].caseId).toBe("case_1");
    expect(typeof body.ts).toBe("number");
  });

  it("writes an empty snapshot when no conflict is open, so a resolved warning clears", async () => {
    process.env.MEETLESS_CONFLICT_SYNC_STUB = "[]";
    jest.resetModules();
    const { runInternalSteerSync } = require("../../src/commands/internal-steer-sync");
    const code = await runInternalSteerSync(["--session", "sess_y"]);
    expect(code).toBe(0);
    const body = JSON.parse(fs.readFileSync(snapshotFile("sess_y"), "utf8"));
    expect(body.conflicts).toEqual([]);
  });
});

// Job 4 (rules-store unification §6.1 / P1F): on the SAME turn-boundary pass, sync the
// principal-bound rule bundle into the zero-network cache the scanner + PreToolUse read.
// The sync is unconditional (the backend store is the only rule authority post-cutover); a
// fetch that returns no bundle leaves the prior cache untouched, mirroring job 3's best-effort
// posture. Hermetic seam: MEETLESS_RULE_BUNDLE_SYNC_STUB carries the fetched bundle. We redirect
// $MEETLESS_HOME and re-require the command so config + bundle-cache HOME re-evaluate.
describe("internal steer-sync job 4: rule-bundle sync", () => {
  let home: string;
  let prev: Record<string, string | undefined>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "steer-sync-bundle-"));
    prev = {
      MEETLESS_HOME: process.env.MEETLESS_HOME,
      MEETLESS_STEER_SYNC_STUB_PULL: process.env.MEETLESS_STEER_SYNC_STUB_PULL,
      MEETLESS_CONFLICT_SYNC_STUB: process.env.MEETLESS_CONFLICT_SYNC_STUB,
      MEETLESS_RULE_BUNDLE_SYNC_STUB: process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB,
    };
    process.env.MEETLESS_HOME = home;
    process.env.MEETLESS_STEER_SYNC_STUB_PULL = "[]";
    process.env.MEETLESS_CONFLICT_SYNC_STUB = "[]";
    // The scan-cache stamp (floorMeta.bundleId) is principal-keyed: computeFloorMeta reads the
    // bundle cache under the SAME principal the scanner injected from, and resolveBundlePrincipal
    // returns a real user id ONLY under a user-token cli-config. Without one it degrades to the
    // headless `_shared` principal, the bundle read misses the user_1-keyed cache, and every stamp
    // is "unavailable" (which the behind-trigger would read as perpetually stale). Seed a
    // user-token config so the test env resolves user_1 exactly like a logged-in operator, and the
    // stamp is a real "rev-N" the behind-trigger can compare against.
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ auth: { mode: "user-token", accessToken: "test-token", user: { id: "user_1" } } }),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // The tmp home IS the scan cache's root now (MEETLESS_HOME is honored end to end), so one
    // rm takes the stamp with it. Until 2026-07-13 rescanAndCache stamped the REAL ~/.meetless
    // and this teardown had to reach into the operator's own home to delete it.
    fs.rmSync(home, { recursive: true, force: true });
    jest.resetModules();
  });

  function makeBundle(over: Partial<RuleBundle> = {}): RuleBundle {
    const payload = managedRuleToRulePayload(
      makeManagedRule({ statement: "include a Mermaid diagram in design docs", strength: "MUST_FOLLOW" }),
      "scope_a",
    );
    return {
      schemaVersion: RULE_BUNDLE_SCHEMA_VERSION,
      principalUserId: "user_1",
      workspaceId: "ws_1",
      projectId: null,
      bundleRevision: 5,
      generatedAt: "2026-06-28T00:00:00.000Z",
      validUntil: "2026-06-29T00:00:00.000Z",
      rules: [
        {
          ruleNodeId: "node_1",
          ruleVersionId: "ver_1",
          authorityScope: "TEAM",
          ownerUserId: null,
          projectId: null,
          payload,
          canonicalPayloadHash: ruleVersionHash(payload),
          attestedByUserId: null,
          attestedAt: "2026-06-28T00:00:00.000Z",
          supersedesVersionId: null,
        },
      ],
      ...over,
    };
  }

  function cacheFile(): string {
    return ruleBundleCachePath(
      { workspaceId: "ws_1", principalUserId: "user_1", projectId: null },
      home,
    );
  }

  it("writes the fetched bundle to the principal-bound cache", async () => {
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle());
    jest.resetModules();
    const { runInternalSteerSync } = require("../../src/commands/internal-steer-sync");
    const code = await runInternalSteerSync(["--session", "sess_b"]);
    expect(code).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    expect(envelope.bundle.bundleRevision).toBe(5);
    expect(envelope.bundle.principalUserId).toBe("user_1");
    expect(envelope.bundle.rules).toHaveLength(1);
  });

  it("leaves the cache untouched when no bundle is on the wire (best-effort, mirrors job 3)", async () => {
    // No stub bundle: the fetch returns null. Job 4 must not clobber a prior cache (or write an
    // empty one); a transient fetch miss is non-fatal, exactly like the conflict-snapshot job.
    delete process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB;
    jest.resetModules();
    const { runInternalSteerSync } = require("../../src/commands/internal-steer-sync");
    const code = await runInternalSteerSync(["--session", "sess_c"]);
    expect(code).toBe(0);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  // The bundle -> scan-cache bridge: a genuine revision bump (a rule was added/attested/
  // revoked) must regenerate the scan cache the UserPromptSubmit hook injects, but an
  // equal-revision re-sync (the every-turn lease refresh) must NOT, or every turn would
  // needlessly rescan. We assert the command's `rescanned` flag, which mirrors exactly
  // that gate. (The rescan itself is best-effort and swallowed; here we only pin the gate.)
  async function syncAndReadFlag(sessionId: string): Promise<boolean> {
    const lines: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => {
      if (typeof m === "string") lines.push(m);
    });
    try {
      jest.resetModules();
      const { runInternalSteerSync } = require("../../src/commands/internal-steer-sync");
      await runInternalSteerSync(["--session", sessionId]);
    } finally {
      spy.mockRestore();
    }
    const summary = JSON.parse(lines[lines.length - 1]);
    return summary.rescanned === true;
  }

  it("regenerates the scan cache on a genuine revision bump but not on an equal-revision re-sync", async () => {
    // First sync (no prior cache) is a bump: rescan.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 5 }));
    expect(await syncAndReadFlag("sess_bump")).toBe(true);
    // Re-sync the SAME revision (lease refresh): no bump, no rescan.
    expect(await syncAndReadFlag("sess_bump")).toBe(false);
    // A higher revision (a rule changed): rescan again.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 6 }));
    expect(await syncAndReadFlag("sess_bump")).toBe(true);
  });

  // The self-heal trigger (reported "mla status shows 0 rules injected" bug). A session
  // whose bundle does NOT bump this turn but whose scan cache is BEHIND the bundle (stale
  // bundleId) or missing entirely must still rescan, because the bump trigger alone only
  // ever fires on the single turn the revision changes. Without this, a fresh checkout or a
  // cleared/interrupted scan cache stays empty forever while the bundle sits at a steady
  // revision. Seed the stamp through the SAME default resolution the product uses (no explicit
  // home: the cache module resolves MEETLESS_HOME), so the seed lands exactly where steer-sync
  // reads it.
  function seedScanCacheRevision(rev: number): void {
    const stub = {
      floorMeta: { bundleId: `rev-${rev}`, bundleHash: null, freshness: "stale" },
    } as unknown as ScanResult;
    writeScanCache(undefined, "ws_1", stub);
  }

  it("rescans when the scan cache is behind the bundle even without a revision bump", async () => {
    // Establish a prior bundle cache at rev5 so the next rev5 sync is NOT a bump.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 5 }));
    expect(await syncAndReadFlag("sess_behind")).toBe(true); // first sync: bump (no prior cache)
    // Now force the scan cache BEHIND the bundle (rev4 < rev5), simulating a stale/cleared
    // scan cache that the bump trigger can no longer heal on its own.
    seedScanCacheRevision(4);
    // Same revision on the wire (lease refresh, no bump): the BEHIND trigger must still rescan.
    expect(await syncAndReadFlag("sess_behind")).toBe(true);
    // That rescan re-stamped the scan cache to the current revision, so a further equal-
    // revision sync goes quiet again: the trigger is self-limiting, not a per-turn rescan.
    expect(await syncAndReadFlag("sess_behind")).toBe(false);
  });

  it("rescans when the scan cache is missing entirely (fresh checkout, no bump)", async () => {
    // Prime a rev7 bundle cache (bump) then wipe the scan cache so the next equal-revision
    // sync faces a MISSING cache. Missing is treated as infinitely behind -> rescan.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 7 }));
    expect(await syncAndReadFlag("sess_missing")).toBe(true);
    fs.rmSync(scanCachePath("ws_1"), { force: true });
    expect(await syncAndReadFlag("sess_missing")).toBe(true);
  });

  it("refuses to regress: a newer cached revision survives an older fetched one", async () => {
    // Seed a newer revision first.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 9 }));
    jest.resetModules();
    let mod = require("../../src/commands/internal-steer-sync");
    await mod.runInternalSteerSync(["--session", "sess_d"]);
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8")).bundle.bundleRevision).toBe(9);
    // A late, older fetch must not displace it.
    process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB = JSON.stringify(makeBundle({ bundleRevision: 4 }));
    jest.resetModules();
    mod = require("../../src/commands/internal-steer-sync");
    await mod.runInternalSteerSync(["--session", "sess_d"]);
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8")).bundle.bundleRevision).toBe(9);
  });
});
