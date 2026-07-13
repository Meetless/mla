import {
  parseVersion,
  isNewerVersion,
  isCI,
  notifierDisabled,
  shouldRunCheck,
  shouldShowNag,
  detectInstallMethod,
  upgradeCommandFor,
  formatUpdateNag,
  parseState,
  serializeState,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateState,
} from "../../src/lib/update-check";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const env = (o: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe("parseVersion", () => {
  it("parses bare and v-prefixed semver", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.4.2")).toEqual([0, 4, 2]);
    expect(parseVersion(" 10.0.5 ")).toEqual([10, 0, 5]);
  });
  it("ignores build suffixes", () => {
    expect(parseVersion("1.2.3-dirty")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3+abc")).toEqual([1, 2, 3]);
  });
  it("returns null for non-semver (e.g. a dev sha build)", () => {
    expect(parseVersion("b6a81f7a-dirty")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("compares major/minor/patch", () => {
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerVersion("1.3.0", "1.2.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
  });
  it("never reports newer when either side is unparseable (dev build safety)", () => {
    expect(isNewerVersion("1.2.4", "abc-dirty")).toBe(false);
    expect(isNewerVersion(null, "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.4", null)).toBe(false);
  });
});

describe("isCI / notifierDisabled", () => {
  it("detects common CI markers", () => {
    expect(isCI(env({ CI: "true" }))).toBe(true);
    expect(isCI(env({ GITHUB_ACTIONS: "true" }))).toBe(true);
    expect(isCI(env({}))).toBe(false);
  });
  it("treats MLA_NO_UPDATE_NOTIFIER truthy as disabled, 0/false/empty as enabled", () => {
    expect(notifierDisabled(env({ MLA_NO_UPDATE_NOTIFIER: "1" }))).toBe(true);
    expect(notifierDisabled(env({ MLA_NO_UPDATE_NOTIFIER: "yes" }))).toBe(true);
    expect(notifierDisabled(env({ MLA_NO_UPDATE_NOTIFIER: "0" }))).toBe(false);
    expect(notifierDisabled(env({ MLA_NO_UPDATE_NOTIFIER: "false" }))).toBe(false);
    expect(notifierDisabled(env({ MLA_NO_UPDATE_NOTIFIER: "" }))).toBe(false);
    expect(notifierDisabled(env({}))).toBe(false);
  });
});

describe("shouldRunCheck", () => {
  const fresh: UpdateState = { lastCheckedAt: 0, latestVersion: null };
  it("runs when the throttle window has elapsed", () => {
    expect(shouldRunCheck({ state: fresh, now: UPDATE_CHECK_INTERVAL_MS, env: env({}) })).toBe(true);
  });
  it("skips inside the throttle window", () => {
    const recent: UpdateState = { lastCheckedAt: 1000, latestVersion: null };
    expect(shouldRunCheck({ state: recent, now: 1000 + UPDATE_CHECK_INTERVAL_MS - 1, env: env({}) })).toBe(false);
  });
  it("never runs when disabled or on CI (no pointless network)", () => {
    expect(shouldRunCheck({ state: fresh, now: UPDATE_CHECK_INTERVAL_MS, env: env({ MLA_NO_UPDATE_NOTIFIER: "1" }) })).toBe(false);
    expect(shouldRunCheck({ state: fresh, now: UPDATE_CHECK_INTERVAL_MS, env: env({ CI: "1" }) })).toBe(false);
  });
});

describe("shouldShowNag", () => {
  const newer: UpdateState = { lastCheckedAt: 1, latestVersion: "2.0.0" };
  const base = { currentVersion: "1.0.0", stdoutTTY: true, stderrTTY: true };
  it("shows when a newer version is cached on an interactive TTY", () => {
    expect(shouldShowNag({ ...base, state: newer, env: env({}) })).toBe(true);
  });
  it("hides when piped (either stream not a TTY)", () => {
    expect(shouldShowNag({ ...base, state: newer, env: env({}), stdoutTTY: false })).toBe(false);
    expect(shouldShowNag({ ...base, state: newer, env: env({}), stderrTTY: false })).toBe(false);
  });
  it("hides when disabled, on CI, or not actually newer", () => {
    expect(shouldShowNag({ ...base, state: newer, env: env({ MLA_NO_UPDATE_NOTIFIER: "1" }) })).toBe(false);
    expect(shouldShowNag({ ...base, state: newer, env: env({ CI: "1" }) })).toBe(false);
    expect(shouldShowNag({ ...base, state: { lastCheckedAt: 1, latestVersion: "1.0.0" }, env: env({}) })).toBe(false);
    expect(shouldShowNag({ ...base, state: { lastCheckedAt: 1, latestVersion: null }, env: env({}) })).toBe(false);
  });
});

describe("detectInstallMethod", () => {
  const home = "/Users/x";
  it("detects the curl|sh install dir (~/.meetless/bin)", () => {
    expect(
      detectInstallMethod({ execPath: "/Users/x/.meetless/bin/mla", scriptPath: undefined, home, env: env({}) }),
    ).toBe("curl");
  });
  it("detects Homebrew via Caskroom and via brew prefix", () => {
    expect(
      detectInstallMethod({ execPath: "/opt/homebrew/Caskroom/mla/1.0.0/mla", scriptPath: undefined, home, env: env({}) }),
    ).toBe("homebrew");
    expect(
      detectInstallMethod({ execPath: "/usr/local/bin/node", scriptPath: "/usr/local/lib/whatever/mla", home, env: env({}) }),
    ).toBe("homebrew");
  });
  it("detects npm via a node_modules script path", () => {
    expect(
      detectInstallMethod({
        execPath: "/usr/bin/node",
        scriptPath: "/Users/x/.nvm/versions/node/v22/lib/node_modules/@meetless/mla/dist/cli.js",
        home,
        env: env({}),
      }),
    ).toBe("npm");
  });
  it("falls back to unknown when nothing matches", () => {
    expect(
      detectInstallMethod({ execPath: "/some/random/path/mla", scriptPath: undefined, home, env: env({}) }),
    ).toBe("unknown");
  });
  it("honors the MLA_INSTALL_METHOD override", () => {
    expect(
      detectInstallMethod({ execPath: "/opt/homebrew/Caskroom/mla/1/mla", scriptPath: undefined, home, env: env({ MLA_INSTALL_METHOD: "npm" }) }),
    ).toBe("npm");
  });
  it("does not misread ~/.meetless (without /bin) as curl", () => {
    // a path under ~/.meetless but not the bin dir should not be 'curl'
    expect(
      detectInstallMethod({ execPath: "/Users/x/.meetless/queue/mla", scriptPath: undefined, home, env: env({}) }),
    ).not.toBe("curl");
  });

  // Regression: every case above passes fabricated paths, so none of them can see
  // the bug that actually shipped. `process.execPath` is realpath'd by Node but
  // `os.homedir()` is not, so a HOME reached through a symlink is spelled
  // differently from the binary's own path and containment silently fails ->
  // "unknown" -> `mla upgrade` refuses to run. macOS makes this routine (a $HOME
  // under TMPDIR is /var/folders/..., really /private/var/folders/...). Needs a
  // real symlink on a real filesystem to reproduce.
  it("detects a curl install when HOME reaches through a symlink", () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mla-detect-")));
    const realHome = path.join(tmp, "real-home");
    const linkedHome = path.join(tmp, "linked-home");
    const binDir = path.join(realHome, ".meetless", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "mla"), "");
    fs.symlinkSync(realHome, linkedHome);

    try {
      expect(
        detectInstallMethod({
          // what process.execPath gives us: already resolved
          execPath: path.join(realHome, ".meetless", "bin", "mla"),
          scriptPath: undefined,
          // what os.homedir() gives us: the symlink, unresolved
          home: linkedHome,
          env: env(),
        }),
      ).toBe("curl");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("upgradeCommandFor", () => {
  it("maps each method to its real upgrade command", () => {
    expect(upgradeCommandFor("homebrew")).toBe("brew upgrade --cask mla");
    expect(upgradeCommandFor("curl")).toBe("curl -fsSL https://meetless.ai/install.sh | sh");
    expect(upgradeCommandFor("npm")).toBe("npm i -g @meetless/mla@latest");
    expect(upgradeCommandFor("unknown")).toBe("see https://meetless.ai/install");
  });
});

describe("formatUpdateNag", () => {
  it("names the version delta and the method-specific command", () => {
    const out = formatUpdateNag({ current: "1.0.0", latest: "2.0.0", method: "homebrew" });
    expect(out).toContain("1.0.0 -> 2.0.0");
    expect(out).toContain("brew upgrade --cask mla");
  });
  it("works without a known current version", () => {
    const out = formatUpdateNag({ current: null, latest: "2.0.0", method: "curl" });
    expect(out).toContain("-> 2.0.0");
    expect(out).toContain("install.sh");
  });
});

describe("parseState / serializeState", () => {
  it("round-trips", () => {
    const s: UpdateState = { lastCheckedAt: 123, latestVersion: "1.2.3" };
    expect(parseState(serializeState(s))).toEqual(s);
  });
  it("treats missing/corrupt as never-checked", () => {
    expect(parseState(null)).toEqual({ lastCheckedAt: 0, latestVersion: null });
    expect(parseState("not json")).toEqual({ lastCheckedAt: 0, latestVersion: null });
    expect(parseState("{}")).toEqual({ lastCheckedAt: 0, latestVersion: null });
  });
});
