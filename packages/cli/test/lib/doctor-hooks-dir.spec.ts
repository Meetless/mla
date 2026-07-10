import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PluginOwnership } from "../../src/connectors/claude-code/plugin-detect";

// Lock for doctor's install-surface-aware hooks-dir resolution (dogfood
// 2026-07-10). Pre-fix, doctor's 7b presence check + 7c drift check read only
// ~/.meetless/hooks. On the shipped plugin install (hooks under the plugin root)
// that surfaced an UNFIXABLE red "hook script session-start.sh installed" and a
// spurious drift finding, contradicting the GREEN "mla plugin installed" line
// and the very `mla doctor --fix` the activate copy points plugin users to.
// resolveHooksDir must prefer home-dir wiring, fall back to the owned plugin's
// bundled hooks, and only default back to HOOKS_DIR when neither is present.

function withEnv<T>(home: string, fn: () => T): T {
  const prev = process.env.MEETLESS_HOME;
  process.env.MEETLESS_HOME = home;
  jest.resetModules();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prev;
  }
}

function stageHook(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session-start.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
}

function load() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../src/commands/doctor").resolveHooksDir as (
    o: PluginOwnership,
  ) => { dir: string; surface: string };
}

describe("resolveHooksDir (doctor install-surface-aware hooks dir)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-hooks-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("prefers home-dir wiring when ~/.meetless/hooks holds the hook", () => {
    const home = path.join(tmp, "home");
    stageHook(path.join(home, "hooks"));
    const install = path.join(tmp, "plugin", "mla", "1.0.0");
    stageHook(path.join(install, "hooks")); // present too, but home wins
    withEnv(home, () => {
      const r = load()({
        status: "owned",
        scope: "user",
        version: "1.0.0",
        installPath: install,
      });
      expect(r.dir).toBe(path.join(home, "hooks"));
      expect(r.surface).toMatch(/home-dir/);
    });
  });

  it("uses the owned plugin's bundled hooks when home wiring is absent", () => {
    const home = path.join(tmp, "home"); // no hooks staged
    const install = path.join(tmp, "plugin", "mla", "1.0.0");
    stageHook(path.join(install, "hooks"));
    withEnv(home, () => {
      const r = load()({
        status: "owned",
        scope: "user",
        version: "1.0.0",
        installPath: install,
      });
      expect(r.dir).toBe(path.join(install, "hooks"));
      expect(r.surface).toMatch(/plugin/);
      expect(r.surface).toMatch(/user scope/);
    });
  });

  it("falls back to HOOKS_DIR when the plugin is owned but its hook file is missing", () => {
    const home = path.join(tmp, "home");
    const install = path.join(tmp, "plugin", "mla", "1.0.0"); // installPath resolves, no hook on disk
    withEnv(home, () => {
      const r = load()({
        status: "owned",
        scope: "user",
        version: "1.0.0",
        installPath: install,
      });
      expect(r.dir).toBe(path.join(home, "hooks"));
      expect(r.surface).toMatch(/home-dir/);
    });
  });

  it("falls back to HOOKS_DIR when neither surface is present (genuinely unwired -> red)", () => {
    const home = path.join(tmp, "home");
    withEnv(home, () => {
      const r = load()({ status: "absent" });
      expect(r.dir).toBe(path.join(home, "hooks"));
    });
  });

  it("does not consult a non-global plugin (no global wiring)", () => {
    const home = path.join(tmp, "home");
    withEnv(home, () => {
      const r = load()({
        status: "non-global",
        scope: "project",
        version: "1.0.0",
      });
      expect(r.dir).toBe(path.join(home, "hooks"));
      expect(r.surface).toMatch(/home-dir/);
    });
  });
});
