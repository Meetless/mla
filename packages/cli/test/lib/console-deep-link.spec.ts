import {
  consoleDeepLink,
  consoleDeepLinkFrom,
  CliConfig,
} from "../../src/lib/config";

// Workspace-pinned Console deep links. A multi-workspace human whose Console
// session is bound to workspace A must not open an `mla`-printed link and land
// on workspace B's data. consoleDeepLink routes through the `/open` landing page
// carrying the target workspaceId; without a workspaceId it degrades to the plain
// URL (an unpinned link beats a broken one).

describe("consoleDeepLinkFrom", () => {
  const base = "https://console.example.test";

  it("pins the workspace via the /open landing page", () => {
    expect(consoleDeepLinkFrom(base, "ws_123", "/relationships")).toBe(
      `${base}/open?workspaceId=ws_123&to=%2Frelationships`,
    );
  });

  it("encodes an id-scoped target path so /open can decode it back", () => {
    expect(consoleDeepLinkFrom(base, "ws_123", "/relationships/cand_abc")).toBe(
      `${base}/open?workspaceId=ws_123&to=%2Frelationships%2Fcand_abc`,
    );
  });

  it("falls back to the plain URL when there is no workspaceId", () => {
    expect(consoleDeepLinkFrom(base, undefined, "/relationships")).toBe(
      `${base}/relationships`,
    );
    expect(consoleDeepLinkFrom(base, "", "/cases")).toBe(`${base}/cases`);
    expect(consoleDeepLinkFrom(base, "   ", "/cases")).toBe(`${base}/cases`);
  });

  it("trims a padded workspaceId before pinning", () => {
    expect(consoleDeepLinkFrom(base, "  ws_123  ", "/cases")).toBe(
      `${base}/open?workspaceId=ws_123&to=%2Fcases`,
    );
  });

  it("normalizes a trailing slash on the base and a missing leading slash on the path", () => {
    expect(consoleDeepLinkFrom(`${base}/`, "ws_1", "conflicts")).toBe(
      `${base}/open?workspaceId=ws_1&to=%2Fconflicts`,
    );
    expect(consoleDeepLinkFrom(`${base}///`, undefined, "kb")).toBe(
      `${base}/kb`,
    );
  });

  it("orders the query as workspaceId then to (stable for callers/tests)", () => {
    const url = consoleDeepLinkFrom(base, "ws_1", "/value");
    expect(url.indexOf("workspaceId=")).toBeLessThan(url.indexOf("to="));
  });
});

describe("consoleDeepLink (cfg convenience)", () => {
  const prevEnv = process.env.MEETLESS_CONSOLE_URL;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MEETLESS_CONSOLE_URL;
    else process.env.MEETLESS_CONSOLE_URL = prevEnv;
  });

  it("resolves base from cfg.consoleUrl and pins cfg.workspaceId", () => {
    delete process.env.MEETLESS_CONSOLE_URL;
    const cfg = {
      consoleUrl: "https://app.meetless.test",
      workspaceId: "ws_cfg",
    } as CliConfig;
    expect(consoleDeepLink(cfg, "/relationships")).toBe(
      "https://app.meetless.test/open?workspaceId=ws_cfg&to=%2Frelationships",
    );
  });

  it("degrades to a plain URL when cfg has no workspaceId", () => {
    delete process.env.MEETLESS_CONSOLE_URL;
    const cfg = { consoleUrl: "https://app.meetless.test" } as CliConfig;
    expect(consoleDeepLink(cfg, "/cases")).toBe(
      "https://app.meetless.test/cases",
    );
  });

  it("honors the MEETLESS_CONSOLE_URL env override for the base", () => {
    process.env.MEETLESS_CONSOLE_URL = "https://override.test/";
    const cfg = {
      consoleUrl: "https://app.meetless.test",
      workspaceId: "ws_cfg",
    } as CliConfig;
    expect(consoleDeepLink(cfg, "/conflicts")).toBe(
      "https://override.test/open?workspaceId=ws_cfg&to=%2Fconflicts",
    );
  });
});
