import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Unbounded-backup footgun (dogfood 2026-06-11): ensureClaudeSettings backed up
// ~/.claude/settings.json to a fresh .bak.<timestamp> on EVERY call, never
// pruning. `mla rewire` runs often (and a poisoning test ran it every suite), so
// ~227 backups piled up, almost all byte-identical no-op-rewire copies. The fix:
// (1) only write + back up when the wiring actually CHANGES, so a no-op rewire
// touches nothing; (2) cap retained backups to SETTINGS_BACKUP_RETENTION, newest
// kept. Both halves are exercised here.
//
// Isolation: MEETLESS_HOME points at a temp dir so the module-level HOOKS_DIR
// resolves under temp; the settings file lives under the SAME temp tree, so the
// temp-poison guard sees a temp settings file too and does not fire.

function isolatedEnsure(): {
  ensureClaudeSettings: typeof import("../../src/lib/wire").ensureClaudeSettings;
  SETTINGS_BACKUP_RETENTION: number;
} {
  let mod!: typeof import("../../src/lib/wire");
  jest.isolateModules(() => {
    mod = require("../../src/lib/wire");
  });
  return {
    ensureClaudeSettings: mod.ensureClaudeSettings,
    SETTINGS_BACKUP_RETENTION: mod.SETTINGS_BACKUP_RETENTION,
  };
}

function backupCount(settingsPath: string): number {
  const dir = path.dirname(settingsPath);
  const base = path.basename(settingsPath) + ".bak.";
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.startsWith(base)).length;
}

describe("ensureClaudeSettings: bounded, change-only backups", () => {
  let tmpHome: string;
  let settingsPath: string;
  let prevMlHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bak-home-"));
    prevMlHome = process.env.MEETLESS_HOME;
    process.env.MEETLESS_HOME = tmpHome; // -> HOOKS_DIR under temp
    settingsPath = path.join(tmpHome, ".claude", "settings.json");
  });

  afterEach(() => {
    if (prevMlHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevMlHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    jest.resetModules();
  });

  it("creates no backup on a no-op rewire (unchanged wiring writes nothing)", () => {
    const { ensureClaudeSettings } = isolatedEnsure();

    // First call: file is absent -> nothing to back up, writes our hooks.
    ensureClaudeSettings(false, settingsPath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(backupCount(settingsPath)).toBe(0);

    const after1 = fs.readFileSync(settingsPath, "utf8");

    // Second call: our hooks are already canonical -> a true no-op. It must NOT
    // create a backup and must NOT rewrite the file.
    ensureClaudeSettings(false, settingsPath);
    expect(backupCount(settingsPath)).toBe(0);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(after1);
  });

  it("backs up the prior content on a real change and caps retention to the newest N", () => {
    const { ensureClaudeSettings, SETTINGS_BACKUP_RETENTION } = isolatedEnsure();
    expect(SETTINGS_BACKUP_RETENTION).toBeGreaterThan(0);

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // Pre-change content WITHOUT our hooks, so the call is a genuine change.
    const original = JSON.stringify({ foo: "bar" }, null, 2) + "\n";
    fs.writeFileSync(settingsPath, original, "utf8");

    // Seed more stale backups than the retention cap, with small timestamps so
    // the real backup (Date.now(), ~1.7e12) always sorts as the newest.
    const stale = SETTINGS_BACKUP_RETENTION + 5;
    for (let i = 0; i < stale; i++) {
      fs.writeFileSync(`${settingsPath}.bak.${1000 + i}`, "stale", "utf8");
    }
    expect(backupCount(settingsPath)).toBe(stale);

    ensureClaudeSettings(false, settingsPath);

    // The change landed (our hooks present now).
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(written.hooks?.SessionStart).toBeTruthy();

    // Retention is enforced: exactly the cap remains.
    expect(backupCount(settingsPath)).toBe(SETTINGS_BACKUP_RETENTION);

    // The pre-change content was preserved in a backup (we save prior state
    // before overwriting), and the oldest stale stamps were pruned.
    const dir = path.dirname(settingsPath);
    const base = path.basename(settingsPath) + ".bak.";
    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base))
      .map((f) => Number(f.slice(base.length)))
      .sort((a, b) => a - b);
    // Smallest seeded stamp (1000) must be gone; newest seeded stamps survive.
    expect(remaining).not.toContain(1000);
    const realBackups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .filter((c) => c === original);
    expect(realBackups.length).toBe(1);
  });
});
