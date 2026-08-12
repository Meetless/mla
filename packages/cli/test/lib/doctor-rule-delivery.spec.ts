import { doctorJson, ruleDeliveryDoctorChecks } from "../../src/commands/doctor";
import type { RuleDeliveryProbe } from "../../src/commands/doctor";
import type { ScanResult } from "../../src/lib/scanner/types";
import type { PersistedDeliveryReceipt } from "../../src/lib/scanner/cache";

/**
 * These checks exist because `mla doctor` validated the wrong artifact.
 *
 * `rules.bundle` reads ~/.meetless/rules/bundle-<ws>-<principal>-<proj>.json and prints
 * "revision N, M active rule(s)". The hook that actually puts rules in front of the model reads
 * ~/.meetless/workspaces/<ws>/scan-cache.json. On 2026-08-02 the second one was re-stamped by a
 * throwaway checkout and every floor MUST was dropped for 8h11m while doctor printed green,
 * because nothing it looked at had changed.
 *
 * Each test below pins one state that green was previously indistinguishable from.
 */

// Any absolute path works here; keep it synthetic. This subtree is exported to a public
// mirror whose scrub gate refuses the real monorepo self-path, and that refusal is silent.
const ROOT = "/Users/alice/projects/app";
const NOW = new Date("2026-08-02T18:00:00.000Z");

function cache(over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 2,
    workspaceId: "ws_1",
    commitSha: "abc123",
    generatedAt: "2026-08-02T17:30:00.000Z",
    inventory: { files: [] } as unknown as ScanResult["inventory"],
    directives: [],
    staleSignals: [],
    confirmedRulesXml: "",
    floorRulesXml: "<meetless-context kind=\"floor-rules\">...</meetless-context>",
    floorRules: [{ ruleId: "r1" } as unknown as NonNullable<ScanResult["floorRules"]>[number]],
    scopedRules: [{ ruleId: "r2" } as unknown as NonNullable<ScanResult["scopedRules"]>[number]],
    staleContextXml: "",
    advisoryDirectives: [],
    scanRootPath: ROOT,
    ...over,
  } as ScanResult;
}

function receipt(over: Partial<PersistedDeliveryReceipt> = {}): PersistedDeliveryReceipt {
  return {
    at: "2026-08-02T17:59:00.000Z",
    path: "assembler",
    delivery: "emitted",
    floorRules: 6,
    scopedRules: 1,
    bytes: 2829,
    cwd: ROOT,
    freshness: "fresh",
    bundleId: "bundle_1",
    ...over,
  };
}

function run(over: Partial<RuleDeliveryProbe> = {}) {
  return ruleDeliveryDoctorChecks({
    root: ROOT,
    cacheForThisRoot: cache(),
    globalCache: cache(),
    receipt: receipt(),
    now: NOW,
    ...over,
  });
}

const byId = (checks: ReturnType<typeof run>, id: string) => checks.find((c) => c.id === id)!;

describe("doctor rule DELIVERY checks", () => {
  it("green only when the cache resolves for THIS root and the last turn delivered", () => {
    const checks = run();
    expect(doctorJson(checks).status).toBe("green");
    expect(byId(checks, "rules.scan-cache").ok).toBe(true);
    expect(byId(checks, "rules.scan-cache").detail).toContain("1 floor, 1 scoped");
    expect(byId(checks, "rules.last-delivery").ok).toBe(true);
    expect(byId(checks, "rules.last-delivery").detail).toContain("path assembler");
    expect(byId(checks, "rules.last-delivery").detail).toContain("6 floor");
  });

  it("RED when the workspace-global cache was stamped by a different checkout", () => {
    // The exact 2026-08-02 state: three `mla activate` calls from live-handoff-test-000{1,2,3}
    // re-stamped one cache slot, the hook refused it, and doctor said nothing.
    const foreign = "/private/tmp/live-handoff-test-0001";
    const checks = run({
      cacheForThisRoot: null,
      globalCache: cache({ scanRootPath: foreign }),
    });
    const c = byId(checks, "rules.scan-cache");
    expect(c.ok).toBe(false);
    expect(c.label).toContain("DIFFERENT checkout");
    expect(c.detail).toContain(foreign);
    expect(c.detail).toContain("mla scan");
    expect(doctorJson(checks).status).not.toBe("green");
  });

  it("RED when the cache resolves but carries zero floor rules", () => {
    // The state the retired jq receipt reported as `{"delivery":"emitted"}`: floorRulesXml is
    // still populated, so every string-shaped probe reads healthy, and floorRules[] is empty so
    // the assembler emits no floor block at all.
    const checks = run({ cacheForThisRoot: cache({ floorRules: [] }) });
    const c = byId(checks, "rules.scan-cache");
    expect(c.ok).toBe(false);
    expect(c.label).toContain("NO floor rules");
    expect(c.detail).toContain("no floor block");
  });

  // The fresh-install closed loop (notes/20260807-mla-activation-onboarding-audit.md §1.2
  // Finding A). Three tests, because the fix is only correct if it separates the two causes of a
  // zero floor rather than excusing all of them.
  it("RED, still, when the workspace HAS governed rules but this checkout carries none", () => {
    // Delivery is genuinely broken here: 12 rules exist and none of them reached this root.
    // This is the case `mla scan` really does fix, so the remedy stays.
    const checks = run({
      cacheForThisRoot: cache({ floorRules: [] }),
      governedRules: { kind: "known", count: 12 },
    });
    const c = byId(checks, "rules.scan-cache");
    expect(c.ok).toBe(false);
    expect(c.label).toContain("NO floor rules");
    expect(c.detail).toContain("mla scan");
  });

  it("INFO, not RED, when the workspace has no governed rules to deliver yet", () => {
    // A correctly installed brand-new workspace. Before this, doctor exited RED for every new
    // user and prescribed `mla scan`, which cannot mint a floor rule because the floor carries
    // only bundle-sourced human-attested directives. Running it produced an identical RED.
    const checks = run({
      cacheForThisRoot: cache({ floorRules: [] }),
      governedRules: { kind: "known", count: 0 },
    });
    const c = byId(checks, "rules.scan-cache");
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label).toContain("no governed rules to deliver yet");
    // The remedy must point at onboarding, and must NOT send the user back into the loop.
    expect(c.detail).toContain("/mla onboard");
    expect(c.detail).not.toContain("run `mla scan`");
    // A brand-new workspace that has not taken a turn yet must not be RED overall.
    expect(doctorJson(run({
      cacheForThisRoot: cache({ floorRules: [] }),
      governedRules: { kind: "known", count: 0 },
      receipt: null,
    })).status).toBe("green");
  });

  it("INFO when no bundle has been fetched yet, and the remedy is the one that works", () => {
    // `mla activate` binds the folder without pulling rules, so this is the ordinary state one
    // command before the first scan. Measured in a clean room 2026-08-08: activate then doctor
    // gave "carries NO floor rules ... run `mla scan`" and exited RED, on a brand-new workspace
    // where nothing was wrong. Here `mla scan` genuinely IS the lever (it performs the pull), so
    // the remedy stays, but the row must not be a hard failure.
    const checks = run({
      cacheForThisRoot: cache({ floorRules: [] }),
      governedRules: { kind: "never-fetched" },
    });
    const c = byId(checks, "rules.scan-cache");
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label).toContain("no rule bundle fetched");
    expect(c.detail).toContain("mla scan");
    // It must NOT claim the workspace has no rules: they may exist on the authority and simply
    // not be on this machine, and saying otherwise would hide an undelivered rule set.
    expect(c.detail).not.toContain("no accepted rules");
  });

  it("RED when the governed rule count is UNKNOWN, because unknown must never suppress", () => {
    // Bundle unreadable. Suppressing on null would re-open the 2026-08-02 hole this file exists
    // to guard: a delivery failure hidden behind a read that merely failed.
    const checks = run({
      cacheForThisRoot: cache({ floorRules: [] }),
      governedRules: { kind: "unknown" },
    });
    expect(byId(checks, "rules.scan-cache").ok).toBe(false);
  });

  it("RED when the last turn emitted a head carrying no floor rules", () => {
    const checks = run({
      receipt: receipt({ delivery: "missing", floorRules: 0, reason: "floor_empty" }),
    });
    const c = byId(checks, "rules.last-delivery");
    expect(c.ok).toBe(false);
    expect(c.label).toContain("NO floor rules");
    expect(c.detail).toContain("floor_empty");
  });

  it("RED when the last turn delivered but degraded", () => {
    // Floor arrived, scoped rules did not. Previously invisible: the head was non-empty and
    // exit 0, so every consumer read it as success.
    const checks = run({
      receipt: receipt({ degraded: "delivery-incomplete", scopedRules: 0 }),
    });
    const c = byId(checks, "rules.last-delivery");
    expect(c.ok).toBe(false);
    expect(c.label).toContain("DEGRADED");
    expect(c.detail).toContain("delivery-incomplete");
  });

  it("does not grade the deliberate inject-nothing arm as a failure", () => {
    const checks = run({
      receipt: receipt({ path: "none", delivery: "missing", floorRules: 0, reason: "no_injection_this_turn" }),
    });
    const c = byId(checks, "rules.last-delivery");
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(doctorJson(checks).status).toBe("green");
  });

  it("refuses a legacy receipt instead of formatting its absent fields", () => {
    // The literal bytes found on disk 2026-08-02 while exercising this live. The old hook wrote
    // only these five fields, and `delivery: "emitted"` there was a constant: it read the cache
    // BEFORE the assembler ran, so it said "emitted" on the two turns that delivered nothing.
    // Trusting it would resurrect the bug; formatting it printed "undefined floor, undefinedB".
    const onDisk = {
      at: "2026-08-02T16:26:54Z",
      delivery: "emitted",
      freshness: "fresh",
      bundleId: "rev-96",
      bundleHash: "sha256:2e49721bfab6fd16154f2de0895fd9c8ece56e2134150e6b8b2c1efdb7612ed0",
    } as unknown as PersistedDeliveryReceipt;
    const checks = run({ receipt: onDisk });
    const c = byId(checks, "rules.last-delivery");
    expect(c.level).toBe("info");
    expect(c.label).toContain("predates delivery accounting");
    expect(c.detail).not.toContain("undefined");
    expect(c.detail).toContain("mla wire");
  });

  it("reports a never-scanned root and a never-run hook as info, not failure", () => {
    const checks = run({ cacheForThisRoot: null, globalCache: null, receipt: null });
    expect(byId(checks, "rules.scan-cache").level).toBe("info");
    expect(byId(checks, "rules.last-delivery").level).toBe("info");
    expect(doctorJson(checks).status).toBe("green");
  });

  it("ages the receipt in human units so a stale one is visible", () => {
    const checks = run({ receipt: receipt({ at: "2026-07-30T18:00:00.000Z" }) });
    expect(byId(checks, "rules.last-delivery").detail).toContain("3d ago");
  });
});
