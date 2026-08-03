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
