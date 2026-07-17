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
import { refreshBundleCache, refreshBundleForScan } from "../../../src/lib/rules/bundle-refresh";
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
