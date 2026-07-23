// test/lib/rules/bundle-refresh.spec.ts
//
// The fetch primitive at the top of the delivery chain (see src/commands/rule-delivery.ts). Only the
// NETWORK is faked (RuleClientHttp, the established CLI test boundary); the bundle cache and the
// principal index are the real ones, writing into a temp home. That is the point: the bug this fixes
// was never a logic error inside a function, it was a write that never happened, so a test that
// mocked the cache away would have proven nothing.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchReconciliationForScan,
  refreshBundleCache,
  refreshBundleForScan,
} from "../../../src/lib/rules/bundle-refresh";
import type { ReconciliationFindingWire } from "../../../src/lib/rules/reconciliation-client";
import { ruleBundleCachePath } from "../../../src/lib/rules/bundle-cache";
import type { RuleBundle, RuleClientHttp } from "../../../src/lib/rules/control-rule-client";
import type { WorkspaceCliConfig } from "../../../src/lib/config";

const WS = "ws_1";
const PRINCIPAL = "user_an";

function cfg(): WorkspaceCliConfig {
  return {
    backendUrl: "http://127.0.0.1:3006",
    workspaceId: WS,
    auth: { mode: "user-token", accessToken: "tok", user: { id: PRINCIPAL } },
  } as unknown as WorkspaceCliConfig;
}

function bundle(over: Partial<RuleBundle> = {}): RuleBundle {
  return {
    schemaVersion: 1,
    principalUserId: PRINCIPAL,
    workspaceId: WS,
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-07-13T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    rules: [],
    ...over,
  };
}

function fakeHttp(impl: () => unknown): { http: RuleClientHttp; calls: string[] } {
  const calls: string[] = [];
  const http: RuleClientHttp = {
    get: (async (_cfg: unknown, p: string) => {
      calls.push(`get ${p}`);
      return impl();
    }) as RuleClientHttp["get"],
    post: (async () => {
      throw new Error("unexpected post");
    }) as RuleClientHttp["post"],
    patch: (async () => {
      throw new Error("unexpected patch");
    }) as RuleClientHttp["patch"],
  };
  return { http, calls };
}

describe("refreshBundleCache", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-br-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("fetches the authority bundle and persists it as this machine's cached bundle", async () => {
    const { http, calls } = fakeHttp(() => bundle({ bundleRevision: 9 }));

    const got = await refreshBundleCache(cfg(), http, { home });

    expect(calls).toEqual([`get /internal/v1/rules/bundle?workspaceId=${WS}`]);
    expect(got.bundleRevision).toBe(9);
    // The write is the whole product: a fetch that does not land in the cache delivers nothing.
    const cached = ruleBundleCachePath({ workspaceId: WS, principalUserId: PRINCIPAL, projectId: null }, home);
    expect(existsSync(cached)).toBe(true);
    expect(JSON.parse(readFileSync(cached, "utf8")).bundle.bundleRevision).toBe(9);
  });

  it("throws when the authority is unreachable (the caller decides whether that is fatal)", async () => {
    const { http } = fakeHttp(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(refreshBundleCache(cfg(), http, { home })).rejects.toThrow("ECONNREFUSED");
  });
});

describe("refreshBundleForScan", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-br-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports delivered and caches the bundle on success", async () => {
    const { http } = fakeHttp(() => bundle());
    const outcome = await refreshBundleForScan(WS, { loadConfig: cfg, http, home });

    expect(outcome).toEqual({ delivered: true });
    expect(
      existsSync(ruleBundleCachePath({ workspaceId: WS, principalUserId: PRINCIPAL, projectId: null }, home)),
    ).toBe(true);
  });

  // A scan on a plane, in CI, or from a repo that was never bound must still SCAN. It degrades to
  // the last cached bundle and says so; it never hard-fails, and it never silently claims currency.
  it("never throws when the fetch fails: it reports the reason so scan can warn and continue", async () => {
    const { http } = fakeHttp(() => {
      throw new Error("getaddrinfo ENOTFOUND control");
    });
    const outcome = await refreshBundleForScan(WS, { loadConfig: cfg, http, home });

    expect(outcome).toEqual({ delivered: false, error: "getaddrinfo ENOTFOUND control" });
  });

  it("never throws when the CLI is not logged in / the repo is unbound", async () => {
    const outcome = await refreshBundleForScan(WS, {
      loadConfig: () => {
        throw new Error("not logged in");
      },
      home,
    });

    expect(outcome).toEqual({ delivered: false, error: "not logged in" });
  });
});

// ------------------------------------------------------------------------------------------------
// The SECOND pull that rides the same scan-refresh moment (ADR §3.5 / §3.7, T11).
//
// Everything here turns on one distinction: `findings: null` (the pull did not succeed) is NOT
// `findings: []` (control says there are none). The caller uses exactly that difference to decide
// between carrying the previous findings forward and CLEARING them, so a test suite that only
// checked "did we get an array back" would let the two collapse into each other and let a backend
// blip erase a live divergence.
// ------------------------------------------------------------------------------------------------

function wireFinding(over: Partial<ReconciliationFindingWire> = {}): ReconciliationFindingWire {
  return {
    id: "rf_1",
    path: "CLAUDE.md",
    evaluatedDigest: "sha256:abc",
    contentNormalizationVersion: "v1",
    acceptedStatement: "Use 127.0.0.1, never localhost.",
    sourceCaseId: "case_1",
    supersedingCommitmentId: "cm_1",
    currentSummary: "the file still says localhost",
    detectorExplanation: "contradicts an accepted decision",
    detectorVersion: "detector-v1",
    detectedAt: "2026-07-13T00:00:00.000Z",
    ...over,
  };
}

describe("fetchReconciliationForScan", () => {
  it("pulls this viewer's findings and narrows them to the cache shape", async () => {
    const { http, calls } = fakeHttp(() => ({ findings: [wireFinding()], truncated: false }));

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    expect(calls).toEqual([`get /internal/v1/reconciliation/findings?workspaceId=${WS}`]);
    expect(pull).toEqual({
      truncated: false,
      findings: [
        {
          path: "CLAUDE.md",
          evaluatedDigest: "sha256:abc",
          contentNormalizationVersion: "v1",
          reason: "contradicts an accepted decision",
          acceptedStatement: "Use 127.0.0.1, never localhost.",
          sourceCaseId: "case_1",
          supersedingCommitmentId: "cm_1",
          currentSummary: "the file still says localhost",
          detectorExplanation: "contradicts an accepted decision",
          detectorVersion: "detector-v1",
        },
      ],
    });
  });

  it("drops backend bookkeeping instead of persisting it into an agent-read file", async () => {
    // `id`, `detectedAt`, and `evidenceSpans` are control's, not the renderer's. The scan cache is
    // read by an agent on every turn; putting backend identifiers in it buys no rendering and
    // widens what a copied cache leaks.
    const { http } = fakeHttp(() => ({
      findings: [wireFinding({ evidenceSpans: [{ start: 0, end: 10 }] })],
      truncated: false,
    }));

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    const got = pull.findings?.[0] as Record<string, unknown> | undefined;
    expect(got).toBeDefined();
    expect(Object.keys(got!)).not.toContain("id");
    expect(Object.keys(got!)).not.toContain("detectedAt");
    expect(Object.keys(got!)).not.toContain("evidenceSpans");
  });

  it("falls back to a readable reason when the detector offered no explanation", async () => {
    // `reason` predates the trust bands and is what the rehash audit and `mla context` print. An
    // empty string there reads as "no reason given" when a governed reason exists one field over.
    const { http } = fakeHttp(() => ({
      findings: [wireFinding({ detectorExplanation: null })],
      truncated: false,
    }));

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    expect(pull.findings?.[0].reason).toBe("a governed decision superseded this instruction");
    expect(pull.findings?.[0].detectorExplanation).toBeNull();
  });

  it("returns an EMPTY list (not null) when control says this workspace has none", async () => {
    // Load-bearing: this is the signal that CLEARS the cache. A finding control no longer serves
    // was dismissed, resolved, or had its decision retracted, and must stop being injected.
    const { http } = fakeHttp(() => ({ findings: [], truncated: false }));

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    expect(pull.findings).toEqual([]);
    expect(pull.findings).not.toBeNull();
  });

  it("returns findings: null (not an empty list) when the pull fails", async () => {
    // The mirror of the case above, and the reason they cannot share a shape: if a transport error
    // came back as `[]`, an offline laptop would silently clear every live finding it had.
    const { http } = fakeHttp(() => {
      throw new Error("getaddrinfo ENOTFOUND control");
    });

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    expect(pull).toEqual({ findings: null, error: "getaddrinfo ENOTFOUND control" });
  });

  it("never throws when the CLI is not logged in / the repo is unbound", async () => {
    const pull = await fetchReconciliationForScan(WS, {
      loadConfig: () => {
        throw new Error("not logged in");
      },
    });

    expect(pull).toEqual({ findings: null, error: "not logged in" });
  });

  it("tolerates a response with no findings key at all", async () => {
    // An older control, or a proxy that trimmed the body. Treat it as "none", never as a crash on
    // the scan path.
    const { http } = fakeHttp(() => ({ truncated: false }));

    const pull = await fetchReconciliationForScan(WS, { loadConfig: cfg, http });

    expect(pull).toEqual({ findings: [], truncated: false });
  });
});
