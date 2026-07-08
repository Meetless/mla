import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

import { DEFAULT_MANIFEST_URL, currentTriple } from "../../src/lib/update-check";
import type { Manifest } from "../../src/lib/update-check";
import type { BuildInfo } from "../../src/lib/observability";

// IO-layer coverage for the self-upgrade path (proposal 20260615). Every test
// runs against a throwaway MEETLESS_HOME so the real ~/.meetless is never
// touched. The module-level HOME const in config.ts is captured at require time,
// so each test re-requires upgrade-apply under a fresh temp home (jest gives this
// file its own module registry; resetModules clears it between tests). What gets
// pinned: the atomic swap and its single rollback slot, the single-writer lock
// (held vs stale-steal), staging, the dev-gated trust/url resolvers, and the
// apply-on-launch promote/re-exec decision tree.

type Mod = typeof import("../../src/lib/upgrade-apply");

let home: string;
let prevHome: string | undefined;
let mod: Mod;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-upgrade-"));
  prevHome = process.env.MEETLESS_HOME;
  process.env.MEETLESS_HOME = home;
  jest.resetModules();
  mod = require("../../src/lib/upgrade-apply") as Mod;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MEETLESS_HOME;
  else process.env.MEETLESS_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  jest.resetModules();
});

function writeExec(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function writeAutoApplyConfig(on: boolean): void {
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({ update: { autoApply: on } }),
  );
}

// A config that exists but carries NO `update` block. This is the shape every
// curl user has until they hand-edit their config; readUpdateConfig must default
// it to auto-apply ON (proposal 20260615 §5.6 fork 1: default TRUE for curl).
function writeConfigWithoutUpdateBlock(): void {
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({ auth: { mode: "none" } }),
  );
}

function buildInfo(over: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: "0.5.0",
    sha: "deadbee",
    branch: "main",
    dirty: false,
    builtAt: "2026-06-20T00:00:00Z",
    ...over,
  } as BuildInfo;
}

describe("sha256File", () => {
  it("matches a node-computed digest", () => {
    const p = path.join(home, "blob");
    fs.writeFileSync(p, "hello world");
    const expected = crypto.createHash("sha256").update("hello world").digest("hex");
    expect(mod.sha256File(p)).toBe(expected);
  });
});

describe("atomicSwapBinary", () => {
  it("replaces the live binary and snapshots the old one to mla.prev", () => {
    const live = mod.liveBinaryPath();
    const prev = mod.prevBinaryPath();
    writeExec(live, "#!/bin/sh\nexit 7\n");
    const src = path.join(home, "src-mla");
    writeExec(src, "#!/bin/sh\nexit 0\n");

    expect(mod.atomicSwapBinary({ newBinaryPath: src })).toBe(true);
    expect(fs.readFileSync(live, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(fs.readFileSync(prev, "utf8")).toBe("#!/bin/sh\nexit 7\n");
    expect(fs.statSync(live).mode & 0o111).toBeTruthy(); // executable
  });

  it("works as a fresh install with no prior live binary (no prev written)", () => {
    const live = mod.liveBinaryPath();
    const src = path.join(home, "src-mla");
    writeExec(src, "#!/bin/sh\nexit 0\n");

    expect(mod.atomicSwapBinary({ newBinaryPath: src })).toBe(true);
    expect(fs.readFileSync(live, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(fs.existsSync(mod.prevBinaryPath())).toBe(false);
  });
});

describe("rollbackBinary", () => {
  it("restores the previous binary over the live path", () => {
    const live = mod.liveBinaryPath();
    const prev = mod.prevBinaryPath();
    writeExec(live, "BAD");
    writeExec(prev, "GOOD");

    expect(mod.rollbackBinary()).toBe(true);
    expect(fs.readFileSync(live, "utf8")).toBe("GOOD");
    expect(fs.existsSync(prev)).toBe(false); // rollback consumes the slot
  });

  it("returns false when there is nothing to roll back to", () => {
    expect(mod.rollbackBinary()).toBe(false);
  });
});

describe("withUpgradeLock", () => {
  it("runs the body and releases the lock afterwards", async () => {
    const r = await mod.withUpgradeLock(async () => 42);
    expect(r).toEqual({ ran: true, value: 42 });
    expect(fs.existsSync(path.join(home, "upgrade.lock"))).toBe(false);
  });

  it("refuses to run when a live lock is already held", async () => {
    // A fresh lock file (mtime now) stands in for another process mid-upgrade.
    fs.writeFileSync(path.join(home, "upgrade.lock"), "999");
    let ran = false;
    const r = await mod.withUpgradeLock(async () => {
      ran = true;
      return 1;
    });
    expect(r).toEqual({ ran: false });
    expect(ran).toBe(false);
  });

  it("steals a stale lock and runs the body", async () => {
    const lock = path.join(home, "upgrade.lock");
    fs.writeFileSync(lock, "999");
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago, past the 5m staleness
    fs.utimesSync(lock, old, old);
    let ran = false;
    const r = await mod.withUpgradeLock(async () => {
      ran = true;
      return 7;
    });
    expect(r).toEqual({ ran: true, value: 7 });
    expect(ran).toBe(true);
  });
});

describe("stageBinary / clearStaged", () => {
  it("parks the binary and records a verifiable staged pointer, then clears it", () => {
    const src = path.join(home, "src-mla");
    writeExec(src, "#!/bin/sh\nexit 0\n");

    const staged = mod.stageBinary({ binaryPath: src, version: "0.6.0", triple: "t", now: 111 });
    expect(staged.version).toBe("0.6.0");
    expect(staged.triple).toBe("t");
    expect(staged.stagedAt).toBe(111);
    expect(staged.path).toBe(mod.stagedBinaryPath());
    expect(staged.sha256).toBe(mod.sha256File(mod.stagedBinaryPath()));
    expect(mod.readUpdateState().staged).toEqual(staged);

    mod.clearStaged();
    expect(fs.existsSync(mod.stagedDir())).toBe(false);
    expect(mod.readUpdateState().staged ?? null).toBeNull();
  });
});

describe("readUpdateState / writeUpdateState", () => {
  it("round-trips under the temp home at the expected path", () => {
    expect(mod.stateFilePath()).toBe(path.join(home, "update-check.json"));
    mod.writeUpdateState({ lastCheckedAt: 5, latestVersion: "0.5.0", minVersion: "0.3.0" });
    expect(mod.readUpdateState()).toEqual({
      lastCheckedAt: 5,
      latestVersion: "0.5.0",
      minVersion: "0.3.0",
    });
  });

  it("returns the empty state when no cache file exists yet", () => {
    expect(mod.readUpdateState()).toEqual({ lastCheckedAt: 0, latestVersion: null });
  });
});

describe("trustedManifestKeys (dev-gated override)", () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  // normalizeKeyPem trims, so the stored key drops the PEM's trailing newline.
  const pemT = pem.trim();

  it("trusts only the baked key on a release build, ignoring the env override", () => {
    const keys = mod.trustedManifestKeys({
      env: { MLA_UPDATE_PUBLIC_KEY: pem } as NodeJS.ProcessEnv,
      buildInfo: buildInfo({ updatePublicKey: pem, dirty: false }),
    });
    expect(keys).toEqual([pemT]);
  });

  it("adds the env override on a dev build", () => {
    const otherT = crypto.generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" })
      .toString()
      .trim();
    const keys = mod.trustedManifestKeys({
      env: { MLA_UPDATE_PUBLIC_KEY: otherT } as NodeJS.ProcessEnv,
      buildInfo: buildInfo({ updatePublicKey: pem, dirty: true }),
    });
    expect(keys).toEqual([pemT, otherT]);
  });

  it("honors a dev override alone when no key is baked", () => {
    const keys = mod.trustedManifestKeys({
      env: { MLA_UPDATE_PUBLIC_KEY: pem } as NodeJS.ProcessEnv,
      buildInfo: buildInfo({ updatePublicKey: "", dirty: true }),
    });
    expect(keys).toEqual([pemT]);
  });

  it("decodes a base64-of-PEM baked key", () => {
    // The base64 branch of normalizeKeyPem returns the decoded PEM as-is (only
    // the direct-PEM branch trims), so the round-tripped key keeps its newline.
    const b64 = Buffer.from(pem).toString("base64");
    const keys = mod.trustedManifestKeys({
      env: {} as NodeJS.ProcessEnv,
      buildInfo: buildInfo({ updatePublicKey: b64, dirty: false }),
    });
    expect(keys).toEqual([pem]);
  });

  it("yields no trust root for a garbage key", () => {
    const keys = mod.trustedManifestKeys({
      env: {} as NodeJS.ProcessEnv,
      buildInfo: buildInfo({ updatePublicKey: "garbage", dirty: false }),
    });
    expect(keys).toEqual([]);
  });
});

describe("resolveManifestUrl (dev-gated override)", () => {
  it("ignores the override on a release build", () => {
    expect(
      mod.resolveManifestUrl({
        env: { MLA_UPDATE_MANIFEST_URL: "http://127.0.0.1:8799/manifest.json" } as NodeJS.ProcessEnv,
        buildInfo: buildInfo({ dirty: false }),
      }),
    ).toBe(DEFAULT_MANIFEST_URL);
  });

  it("honors the override on a dev build", () => {
    expect(
      mod.resolveManifestUrl({
        env: { MLA_UPDATE_MANIFEST_URL: "http://127.0.0.1:8799/manifest.json" } as NodeJS.ProcessEnv,
        buildInfo: buildInfo({ dirty: true }),
      }),
    ).toBe("http://127.0.0.1:8799/manifest.json");
  });
});

describe("parseUpgradeArgs", () => {
  it("reads the force and check flags (long and short forms)", () => {
    expect(mod.parseUpgradeArgs(["--force"])).toEqual({ force: true, check: false });
    expect(mod.parseUpgradeArgs(["-f"])).toEqual({ force: true, check: false });
    expect(mod.parseUpgradeArgs(["--check"])).toEqual({ force: false, check: true });
    expect(mod.parseUpgradeArgs(["-n"])).toEqual({ force: false, check: true });
    expect(mod.parseUpgradeArgs([])).toEqual({ force: false, check: false });
  });
});

describe("maybePromoteStagedAndReExec (apply-on-launch decision tree)", () => {
  const curlEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv =>
    ({ MLA_INSTALL_METHOD: "curl", PATH: process.env.PATH, ...over }) as NodeJS.ProcessEnv;

  function stageValid(triple: string, body = "#!/bin/sh\nexit 0\n") {
    const src = path.join(home, "new-mla");
    writeExec(src, body);
    return mod.stageBinary({ binaryPath: src, version: "0.9.9", triple, now: 1 });
  }

  it("no-ops under the re-exec loop guard without touching the staged binary", async () => {
    writeAutoApplyConfig(true);
    stageValid(currentTriple(process.platform, process.arch) ?? "t");
    const r = await mod.maybePromoteStagedAndReExec({
      command: "whoami",
      env: curlEnv({ [mod.REEXEC_GUARD_ENV]: "1" }),
    });
    expect(r).toEqual({ reExeced: false });
    expect(mod.readUpdateState().staged).toBeTruthy(); // untouched
  });

  it("no-ops for the internal check child, an explicit upgrade, and the mcp daemon", async () => {
    writeAutoApplyConfig(true);
    stageValid(currentTriple(process.platform, process.arch) ?? "t");
    expect(await mod.maybePromoteStagedAndReExec({ command: "_internal", env: curlEnv() })).toEqual({ reExeced: false });
    expect(await mod.maybePromoteStagedAndReExec({ command: "upgrade", env: curlEnv() })).toEqual({ reExeced: false });
    // `mcp` is the long-lived stdio daemon; it self-heals a stale dist in-band
    // (worker exits with the restart sentinel, supervisor respawns), so a
    // launch-time re-exec must never fire under it. See Tier 1 Phase 3.
    expect(await mod.maybePromoteStagedAndReExec({ command: "mcp", env: curlEnv() })).toEqual({ reExeced: false });
    expect(mod.readUpdateState().staged).toBeTruthy();
  });

  it("no-ops under the kill switch and when auto-apply is off", async () => {
    writeAutoApplyConfig(true);
    stageValid(currentTriple(process.platform, process.arch) ?? "t");
    expect(
      await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv({ MLA_DISABLE_UPGRADE: "1" }) }),
    ).toEqual({ reExeced: false });

    writeAutoApplyConfig(false);
    expect(await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() })).toEqual({ reExeced: false });
  });

  it("no-ops for a non-curl (package-manager) install", async () => {
    writeAutoApplyConfig(true);
    stageValid(currentTriple(process.platform, process.arch) ?? "t");
    const r = await mod.maybePromoteStagedAndReExec({
      command: "whoami",
      env: curlEnv({ MLA_INSTALL_METHOD: "homebrew" }),
    });
    expect(r).toEqual({ reExeced: false });
  });

  it("no-ops when nothing is staged", async () => {
    writeAutoApplyConfig(true);
    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });
    expect(r).toEqual({ reExeced: false });
  });

  it("clears a staged binary whose triple does not match this machine", async () => {
    writeAutoApplyConfig(true);
    stageValid("totally-wrong-triple");
    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });
    expect(r).toEqual({ reExeced: false });
    expect(mod.readUpdateState().staged ?? null).toBeNull(); // pruned
    expect(fs.existsSync(mod.stagedDir())).toBe(false);
  });

  const triple = currentTriple(process.platform, process.arch);
  const maybeIt = triple ? it : it.skip;

  maybeIt("clears a staged binary whose bytes no longer match the recorded sha", async () => {
    writeAutoApplyConfig(true);
    stageValid(triple as string);
    // Corrupt the staged file so the promote-time re-verify fails.
    fs.writeFileSync(mod.stagedBinaryPath(), "corrupted");
    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });
    expect(r).toEqual({ reExeced: false });
    expect(mod.readUpdateState().staged ?? null).toBeNull();
  });

  maybeIt("promotes the staged binary, swaps it in, and re-execs the command", async () => {
    writeAutoApplyConfig(true);
    const live = mod.liveBinaryPath();
    writeExec(live, "#!/bin/sh\nexit 3\n"); // the currently-running binary
    stageValid(triple as string, "#!/bin/sh\nexit 0\n");

    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });

    expect(r.reExeced).toBe(true);
    expect(r.code).toBe(0); // the re-exec'd stub exits 0
    expect(fs.readFileSync(live, "utf8")).toBe("#!/bin/sh\nexit 0\n"); // swapped in
    expect(fs.readFileSync(mod.prevBinaryPath(), "utf8")).toBe("#!/bin/sh\nexit 3\n"); // rollback slot
    expect(mod.readUpdateState().staged ?? null).toBeNull(); // cleared after promote
    expect(fs.existsSync(mod.stagedDir())).toBe(false);
  });

  maybeIt("arms auto-apply by default when the config has no update block (curl default-ON)", async () => {
    // The whole point of the 20260615 fix: a curl user who never touched their
    // config still gets the silent apply-on-launch. No writeAutoApplyConfig call.
    writeConfigWithoutUpdateBlock();
    const live = mod.liveBinaryPath();
    writeExec(live, "#!/bin/sh\nexit 3\n");
    stageValid(triple as string, "#!/bin/sh\nexit 0\n");

    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });

    expect(r.reExeced).toBe(true);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(live, "utf8")).toBe("#!/bin/sh\nexit 0\n"); // swapped in
    expect(mod.readUpdateState().staged ?? null).toBeNull(); // cleared after promote
  });

  maybeIt("arms auto-apply by default when no config file exists at all", async () => {
    // First-run curl install: no cli-config.json on disk yet. Default must be ON.
    const live = mod.liveBinaryPath();
    writeExec(live, "#!/bin/sh\nexit 3\n");
    stageValid(triple as string, "#!/bin/sh\nexit 0\n");

    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });

    expect(r.reExeced).toBe(true);
    expect(fs.readFileSync(live, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("still opts out when the config explicitly sets autoApply: false", async () => {
    // The one escape hatch must survive the default flip: an explicit false is a
    // deliberate opt-out, not the absent-default, so it must NOT arm.
    writeAutoApplyConfig(false);
    stageValid(currentTriple(process.platform, process.arch) ?? "t", "#!/bin/sh\nexit 0\n");
    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });
    expect(r).toEqual({ reExeced: false });
    expect(mod.readUpdateState().staged).toBeTruthy(); // untouched
  });

  maybeIt("does not re-promote when another process holds the upgrade lock", async () => {
    writeAutoApplyConfig(true);
    writeExec(mod.liveBinaryPath(), "#!/bin/sh\nexit 3\n");
    stageValid(triple as string);
    // Simulate a concurrent upgrade by holding a fresh lock.
    fs.writeFileSync(path.join(home, "upgrade.lock"), "999");

    const r = await mod.maybePromoteStagedAndReExec({ command: "whoami", env: curlEnv() });
    expect(r).toEqual({ reExeced: false });
    // The live binary is untouched because the swap never ran.
    expect(fs.readFileSync(mod.liveBinaryPath(), "utf8")).toBe("#!/bin/sh\nexit 3\n");
  });
});

describe("reExecAfterUpgrade (argv forwarding)", () => {
  // Records exactly the args the re-exec'd binary receives, one per line, so we
  // can prove the user's command is forwarded byte-for-byte. The default-argv
  // path must mirror the main entry's process.argv.slice(2): the regression this
  // guards is forwarding slice(1), which under a pkg binary leaks the snapshot
  // entry path through as the command. (A pkg binary re-injects its own snapshot
  // entry as argv[1] in the child, so we must hand it ONLY the user args.) The
  // stub-based promote tests above could never catch this: their stub ignores
  // its args entirely.
  function recordingStub(outFile: string): string {
    const stub = path.join(home, "record-mla");
    writeExec(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${outFile}"\nexit 0\n`);
    return stub;
  }

  it("forwards explicit argv to the new binary verbatim", () => {
    const out = path.join(home, "args-explicit.txt");
    const stub = recordingStub(out);
    const code = mod.reExecAfterUpgrade({ live: stub, argv: ["diff", "--list", "FOO-123"] });
    expect(code).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe("diff\n--list\nFOO-123\n");
  });

  it("defaults to process.argv.slice(2) (the same slice the main entry parses)", () => {
    const out = path.join(home, "args-default.txt");
    const stub = recordingStub(out);
    const savedArgv = process.argv;
    // Shape mirrors a pkg binary: [binary, snapshotEntry, ...userArgs].
    process.argv = [stub, "/snapshot/meetless-cli/packages/cli/dist/cli.js", "whoami", "--json"];
    try {
      const code = mod.reExecAfterUpgrade({ live: stub });
      expect(code).toBe(0);
    } finally {
      process.argv = savedArgv;
    }
    // The snapshot entry path must NOT leak through; only the user args survive.
    expect(fs.readFileSync(out, "utf8")).toBe("whoami\n--json\n");
  });

  it("sets the loop-guard env var for the child", () => {
    const out = path.join(home, "guard.txt");
    const stub = path.join(home, "guard-mla");
    writeExec(stub, `#!/bin/sh\nprintf '%s' "$${mod.REEXEC_GUARD_ENV}" > "${out}"\nexit 0\n`);
    const code = mod.reExecAfterUpgrade({ live: stub, argv: [], env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
    expect(code).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe("1");
  });

  it("neutralizes PKG_EXECPATH so the re-exec'd pkg child boots the app, not a script", () => {
    // The S4 apply-on-launch bug: when a pkg binary re-execs its OWN path, pkg's
    // patched spawnSync injects PKG_EXECPATH = parent.execPath into the child env.
    // The child's process.execPath equals that, so pkg's bootstrap treats the
    // first user arg as a script path and crashes ("Cannot find module .../arg").
    // The fix sets PKG_EXECPATH to a defined non-path sentinel; this asserts the
    // child actually receives a non-empty, non-"PKG_INVOKE_NODEJS" value (a shell
    // stub cannot itself be a pkg binary, so we verify the env contract that the
    // real-binary eval proved fixes it).
    const out = path.join(home, "pkgexecpath.txt");
    const stub = path.join(home, "pkgexec-mla");
    writeExec(stub, `#!/bin/sh\nprintf '%s' "$PKG_EXECPATH" > "${out}"\nexit 0\n`);
    const code = mod.reExecAfterUpgrade({ live: stub, argv: [], env: { PATH: process.env.PATH } as NodeJS.ProcessEnv });
    expect(code).toBe(0);
    const val = fs.readFileSync(out, "utf8");
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe("PKG_INVOKE_NODEJS");
    expect(val).not.toBe(stub);
  });
});

describe("stampLatestFromManifest", () => {
  function manifest(over: Partial<Manifest> = {}): Manifest {
    return {
      schemaVersion: 1,
      channel: "stable",
      version: "9.9.9",
      minVersion: "0.0.1",
      releasedAt: "2026-06-26T00:00:00Z",
      artifacts: { "x86_64-unknown-linux-gnu": { url: "https://example.test/a.tar.gz", sha256: "0".repeat(64) } },
      ...over,
    };
  }

  it("refreshes latestVersion + minVersion while preserving lastCheckedAt and staged", () => {
    const staged = {
      version: "9.9.9",
      triple: "x86_64-unknown-linux-gnu",
      sha256: "a".repeat(64),
      path: path.join(home, "staged", "mla"),
      stagedAt: 123,
    };
    mod.writeUpdateState({ lastCheckedAt: 42, latestVersion: "0.1.0", minVersion: "0.0.1", staged });

    mod.stampLatestFromManifest(manifest({ version: "0.1.1", minVersion: "0.1.0" }));

    const state = mod.readUpdateState();
    expect(state.latestVersion).toBe("0.1.1");
    expect(state.minVersion).toBe("0.1.0");
    expect(state.lastCheckedAt).toBe(42); // throttle untouched
    expect(state.staged).toEqual(staged); // staged binary preserved
  });
});

// The bug this guards: the passive nag reads ONLY the cache, but `mla upgrade
// [--check]` fetches the manifest LIVE. A throttled background check that last ran
// while the OLD version was latest leaves the cache stale, so the nag has nothing
// to report even though a `--check` would print "Update available". runUpgrade now
// stamps the cache from the verified manifest BEFORE its early returns, so the two
// surfaces agree.
describe("runUpgrade refreshes the update cache before returning", () => {
  const triple = currentTriple(process.platform, process.arch);
  const maybeIt = triple ? it : it.skip;

  // Sign a manifest and serve manifest.json + manifest.json.sig over loopback.
  // Loopback http is the intended eval seam (isAllowedArtifactUrl + the dev-gated
  // MLA_UPDATE_MANIFEST_URL override both permit 127.0.0.1).
  async function serveSignedManifest(
    manifestObj: Manifest,
    privateKey: crypto.KeyObject,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const body = JSON.stringify(manifestObj);
    const sig = crypto.sign(null, Buffer.from(body), privateKey).toString("base64");
    const server = http.createServer((req, res) => {
      if (req.url === "/manifest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } else if (req.url === "/manifest.json.sig") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(sig);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}/manifest.json`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  maybeIt("--check stamps the live latest version into the stale cache", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const t = triple as string;
    const m: Manifest = {
      schemaVersion: 1,
      channel: "stable",
      version: "9.9.9",
      minVersion: "0.0.1",
      releasedAt: "2026-06-26T00:00:00Z",
      // url is never downloaded on --check; it only has to parse (loopback http ok).
      artifacts: { [t]: { url: "http://127.0.0.1:1/mla.tar.gz", sha256: "0".repeat(64) } },
    };
    const srv = await serveSignedManifest(m, privateKey as crypto.KeyObject);
    try {
      // Pre-seed a stale cache: the background check last ran while 0.5.0 was latest.
      mod.writeUpdateState({ lastCheckedAt: 1000, latestVersion: "0.5.0", minVersion: "0.0.1" });

      const lines: string[] = [];
      const code = await mod.runUpgrade({
        argv: ["--check"],
        env: {
          MLA_INSTALL_METHOD: "curl",
          MLA_UPDATE_MANIFEST_URL: srv.url,
          MLA_UPDATE_PUBLIC_KEY: pem,
          PATH: process.env.PATH,
        } as NodeJS.ProcessEnv,
        buildInfo: {
          version: "0.5.0",
          sha: "deadbee",
          branch: "main",
          dirty: true, // dev build: honors the URL + key overrides
          builtAt: "2026-06-20T00:00:00Z",
        } as BuildInfo,
        log: (l: string) => lines.push(l),
      });

      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("Update available: 0.5.0 -> 9.9.9");
      // The smoking gun: --check no longer discards what it fetched.
      const state = mod.readUpdateState();
      expect(state.latestVersion).toBe("9.9.9");
      expect(state.minVersion).toBe("0.0.1");
      expect(state.lastCheckedAt).toBe(1000); // throttle left alone
    } finally {
      await srv.close();
    }
  });
});
