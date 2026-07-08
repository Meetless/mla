import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isUnderTempDir } from "../../src/lib/wire";

// Silent-poison footgun (dogfood F3 idle-session incident 2026-06-11): running
// `mla rewire`/`mla init` with MEETLESS_HOME pointed at a system temp dir derives
// a temp HOOKS_DIR, so the hook command paths baked into the PERSISTENT
// ~/.claude/settings.json point inside a directory the OS reaps. After the reap
// every meetless hook is a dangling path: SessionStart, the F3-B heartbeat, and
// Stop all silently no-op, capture goes dark, and an actively-working session
// shows IDLE forever. That is exactly how An's session broke: all four hooks
// pointed at /var/folders/.../T/mla-rewire-home-aMRlcn/.meetless/hooks/*.sh.
//
// The only legitimate temp HOOKS_DIR is a fully-isolated test install whose
// settings.json is ALSO temp (self-cleaning). So ensureClaudeSettings must refuse
// exactly the asymmetric case: a temp hook command written into a PERSISTENT
// settings file, and refuse it BEFORE any write so the settings file is never
// poisoned.

describe("isUnderTempDir", () => {
  it("recognizes the system temp roots but not a real home install", () => {
    expect(isUnderTempDir(path.join(os.tmpdir(), "mla-x", "hooks"))).toBe(true);
    expect(
      isUnderTempDir(
        "/var/folders/zz/T/mla-rewire-home-aMRlcn/.meetless/hooks/stop.sh",
      ),
    ).toBe(true);
    expect(isUnderTempDir(path.join(os.homedir(), ".meetless", "hooks"))).toBe(
      false,
    );
    expect(isUnderTempDir("")).toBe(false);
  });
});

describe("ensureClaudeSettings: refuses temp HOOKS_DIR into a persistent settings file", () => {
  let tmpHome: string;
  let prevMlHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-guard-home-"));
    prevMlHome = process.env.MEETLESS_HOME;
    process.env.MEETLESS_HOME = tmpHome; // -> HOOKS_DIR resolves under temp
  });

  afterEach(() => {
    if (prevMlHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevMlHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    jest.resetModules();
  });

  it("throws (and writes nothing) when the hook path is temp but settings is persistent", () => {
    let ensure!: typeof import("../../src/lib/wire").ensureClaudeSettings;
    jest.isolateModules(() => {
      // Re-required under MEETLESS_HOME=tmpHome so the module-level HOOKS_DIR
      // const resolves under the system temp dir.
      ensure = require("../../src/lib/wire").ensureClaudeSettings;
    });

    // A PERSISTENT settings path (under the real home, not temp). The guard must
    // throw BEFORE creating the directory, so this path is never written.
    const persistentSettings = path.join(
      os.homedir(),
      ".claude-guard-test-DOES-NOT-EXIST",
      "settings.json",
    );

    expect(() => ensure(false, persistentSettings)).toThrow(/temp/i);
    expect(fs.existsSync(path.dirname(persistentSettings))).toBe(false);
    expect(fs.existsSync(persistentSettings)).toBe(false);
  });

  it("allows a fully-isolated install where BOTH the hook path and settings are temp", () => {
    let ensure!: typeof import("../../src/lib/wire").ensureClaudeSettings;
    jest.isolateModules(() => {
      ensure = require("../../src/lib/wire").ensureClaudeSettings;
    });

    // Settings file under the SAME temp tree -> self-cleaning isolation, allowed.
    const tmpSettings = path.join(tmpHome, ".claude", "settings.json");
    expect(() => ensure(false, tmpSettings)).not.toThrow();
    expect(fs.existsSync(tmpSettings)).toBe(true);
  });
});
