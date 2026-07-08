import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  RULE_BUNDLE_CACHE_SCHEMA_VERSION,
  RULE_BUNDLE_SCHEMA_VERSION,
  readRuleBundleCache,
  ruleBundleCachePath,
  writeRuleBundleCache,
  type BundlePrincipal,
} from "../../../src/lib/rules/bundle-cache";
import { managedRuleToRulePayload } from "../../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { makeManagedRule } from "../../../src/lib/scanner/managed-rules";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";

// The P1F principal-bound bundle cache, exercised against a REAL temp-dir filesystem and the
// REAL v1 hasher (no mocks: it is pure fs + hashing). Pins the safety contract from
// apps/control/src/rules/rule-bundle.ts: verbatim round-trip (acc 12), principal binding
// (acc 11), freshness guard (acc 13), atomic non-duplicating write (acc 14), unavailable on
// no usable bundle (acc 15), age reporting (acc 16), and lease expiry -> stale (acc 17).

const BASE_MS = Date.parse("2026-06-20T00:00:00.000Z");
const LEASE_MS = 24 * 60 * 60 * 1000;
const SCOPE = "scope_a";

const PRINCIPAL: BundlePrincipal = { workspaceId: "ws_1", projectId: null, principalUserId: "user_1" };

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cache-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function goodPayload(statement = "include a Mermaid diagram in design docs") {
  return managedRuleToRulePayload(makeManagedRule({ statement, strength: "MUST_FOLLOW" }), SCOPE);
}

function entry(over: Partial<RuleBundleEntry> = {}): RuleBundleEntry {
  const payload = goodPayload();
  return {
    ruleNodeId: "node_1",
    ruleVersionId: "ver_1",
    authorityScope: "TEAM",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: null,
    attestedAt: "2026-06-20T00:00:00.000Z",
    supersedesVersionId: null,
    ...over,
  };
}

function bundle(over: Partial<RuleBundle> = {}): RuleBundle {
  return {
    schemaVersion: RULE_BUNDLE_SCHEMA_VERSION,
    principalUserId: "user_1",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 5,
    generatedAt: new Date(BASE_MS).toISOString(),
    validUntil: new Date(BASE_MS + LEASE_MS).toISOString(),
    rules: [entry()],
    ...over,
  };
}

/** Hand-write a raw envelope to a principal's path (to forge content the writer would never produce). */
function forge(p: BundlePrincipal, body: unknown): void {
  const file = ruleBundleCachePath(p, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

describe("writeRuleBundleCache + readRuleBundleCache: happy path", () => {
  it("round-trips a fresh bundle verbatim, including the nested payload (acc 12)", () => {
    const b = bundle();
    const w = writeRuleBundleCache(b, { home });
    expect(w).toEqual({ outcome: "written", storedRevision: 5, priorRevision: null });

    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + 1000 });
    expect(r.status).toBe("fresh");
    expect(r.droppedForIntegrity).toBe(0);
    expect(r.reason).toBeNull();
    expect(r.ageMs).toBe(1000);
    // The DENY-relevant nested payload survives the cache byte-for-byte.
    expect(r.bundle!.rules).toHaveLength(1);
    expect(r.bundle!.rules[0].payload).toEqual(b.rules[0].payload);
    expect(r.bundle!.bundleRevision).toBe(5);
  });

  it("reports the bundle revision and age for an offline list (acc 16)", () => {
    writeRuleBundleCache(bundle(), { home });
    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + 90 * 60 * 1000 });
    expect(r.bundle!.bundleRevision).toBe(5);
    expect(r.ageMs).toBe(90 * 60 * 1000);
  });
});

describe("lease expiry -> stale (acc 17)", () => {
  it("returns stale (bundle still present, so the consumer can degrade DENY to ASK) past validUntil", () => {
    writeRuleBundleCache(bundle(), { home });
    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + LEASE_MS + 1 });
    expect(r.status).toBe("stale");
    expect(r.bundle).not.toBeNull();
    expect(r.reason).toBe("bundle lease expired");
  });

  it("treats an unparseable validUntil as expired (fails toward stale, not fresh)", () => {
    writeRuleBundleCache(bundle({ validUntil: "not-a-date" }), { home });
    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + 1000 });
    expect(r.status).toBe("stale");
  });
});

describe("no usable bundle -> unavailable (acc 15)", () => {
  it("is unavailable when no cache file exists", () => {
    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS });
    expect(r).toMatchObject({ status: "unavailable", bundle: null, reason: "no cached rule bundle" });
  });

  it("is unavailable on a corrupt (non-JSON) cache file", () => {
    const file = ruleBundleCachePath(PRINCIPAL, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readRuleBundleCache(PRINCIPAL, { home }).status).toBe("unavailable");
  });

  it("is unavailable when the cache envelope schema does not match", () => {
    forge(PRINCIPAL, { cacheSchemaVersion: 99, bundle: bundle() });
    expect(readRuleBundleCache(PRINCIPAL, { home }).reason).toBe("cache envelope schema mismatch");
  });

  it("is unavailable when the inner bundle schema does not match", () => {
    forge(PRINCIPAL, { cacheSchemaVersion: RULE_BUNDLE_CACHE_SCHEMA_VERSION, bundle: bundle({ schemaVersion: 2 }) });
    expect(readRuleBundleCache(PRINCIPAL, { home }).reason).toBe("bundle schema mismatch");
  });
});

describe("principal binding (acc 11)", () => {
  it("swaps to a different last-good snapshot when the user changes (path-keyed)", () => {
    writeRuleBundleCache(bundle(), { home });
    // user_2 has never synced: their keyed file is absent, so they get unavailable, never
    // user_1's rules.
    const asUser2 = readRuleBundleCache({ ...PRINCIPAL, principalUserId: "user_2" }, { home });
    expect(asUser2.status).toBe("unavailable");
  });

  it("rejects a file whose embedded principal does not match the reader (hand-edited)", () => {
    forge(PRINCIPAL, {
      cacheSchemaVersion: RULE_BUNDLE_CACHE_SCHEMA_VERSION,
      bundle: bundle({ principalUserId: "user_2" }),
    });
    expect(readRuleBundleCache(PRINCIPAL, { home }).reason).toBe("bundle principal/scope mismatch");
  });

  it("rejects a file whose embedded workspace or project does not match the reader", () => {
    forge(PRINCIPAL, {
      cacheSchemaVersion: RULE_BUNDLE_CACHE_SCHEMA_VERSION,
      bundle: bundle({ projectId: "proj_other" }),
    });
    expect(readRuleBundleCache(PRINCIPAL, { home }).reason).toBe("bundle principal/scope mismatch");
  });
});

describe("freshness guard (acc 13)", () => {
  it("refuses to let an older revision overwrite a newer one", () => {
    expect(writeRuleBundleCache(bundle({ bundleRevision: 5 }), { home }).outcome).toBe("written");
    const kept = writeRuleBundleCache(bundle({ bundleRevision: 3 }), { home });
    expect(kept).toEqual({ outcome: "kept-newer", storedRevision: 5, priorRevision: 5 });
    expect(readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS }).bundle!.bundleRevision).toBe(5);
  });

  it("accepts an equal or higher revision", () => {
    writeRuleBundleCache(bundle({ bundleRevision: 5 }), { home });
    expect(writeRuleBundleCache(bundle({ bundleRevision: 5 }), { home }).outcome).toBe("written");
    expect(writeRuleBundleCache(bundle({ bundleRevision: 7 }), { home }).outcome).toBe("written");
    expect(readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS }).bundle!.bundleRevision).toBe(7);
  });
});

describe("atomic, non-duplicating write (acc 14)", () => {
  it("leaves no temp files behind and keeps exactly one cache file per principal", () => {
    writeRuleBundleCache(bundle({ bundleRevision: 5 }), { home });
    writeRuleBundleCache(bundle({ bundleRevision: 3 }), { home }); // kept-newer, no write
    writeRuleBundleCache(bundle({ bundleRevision: 7 }), { home });
    const files = fs.readdirSync(path.join(home, "rules"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(".tmp");
  });
});

describe("per-entry integrity drop (fork assumption #6)", () => {
  it("drops only the entry whose payload no longer hashes to its digest, keeping the rest", () => {
    const good = entry({ ruleNodeId: "node_good", ruleVersionId: "ver_good" });
    const tampered = entry({
      ruleNodeId: "node_bad",
      ruleVersionId: "ver_bad",
      canonicalPayloadHash: "deadbeef".repeat(8), // 64 hex, but not the real hash
    });
    writeRuleBundleCache(bundle({ rules: [good, tampered] }), { home });

    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + 1 });
    expect(r.status).toBe("fresh");
    expect(r.droppedForIntegrity).toBe(1);
    expect(r.bundle!.rules.map((e) => e.ruleNodeId)).toEqual(["node_good"]);
  });

  it("drops an entry whose payload is outside the closed v1 key set (hasher throws)", () => {
    const malformed = entry({
      ruleNodeId: "node_malformed",
      payload: { totally: "not a rule payload" },
      canonicalPayloadHash: "0".repeat(64),
    });
    writeRuleBundleCache(bundle({ rules: [entry(), malformed] }), { home });
    const r = readRuleBundleCache(PRINCIPAL, { home, nowMs: BASE_MS + 1 });
    expect(r.droppedForIntegrity).toBe(1);
    expect(r.bundle!.rules).toHaveLength(1);
  });
});
