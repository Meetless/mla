import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PluginOwnership } from "../../src/connectors/claude-code/plugin-detect";

// Lock for the plugin-aware capture-hook resolver behind `mla activate`'s
// bootstrap (dogfood 2026-07-10): the shipped install is the Claude Code plugin
// `mla@meetless`, whose hooks live under the plugin root, NOT ~/.meetless/hooks.
// The pre-fix home-only check falsely told plugin users to run `mla init`.
// resolveSessionStartHook must find the plugin hook when the plugin is owned and
// the home hook is absent, prefer the home hook when both exist, and return null
// (the ONLY case that warrants an install nudge) when neither surface is present.

function stageHomeHook(home: string): string {
  const hooks = path.join(home, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const p = path.join(hooks, "session-start.sh");
  fs.writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  return p;
}

function stagePluginHook(installPath: string): string {
  const hooks = path.join(installPath, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const p = path.join(hooks, "session-start.sh");
  fs.writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
  return p;
}

describe("resolveSessionStartHook", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-hook-resolve-"));
    prevHome = process.env.MEETLESS_HOME;
    process.env.MEETLESS_HOME = path.join(tmp, "home");
    jest.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/activate").resolveSessionStartHook as (
      detect?: () => PluginOwnership,
    ) => string | null;
  }

  it("returns the home-dir hook when it exists (home-first, no plugin probe)", () => {
    const home = process.env.MEETLESS_HOME!;
    const homeHook = stageHomeHook(home);
    const detect = jest.fn<PluginOwnership, []>(() => {
      throw new Error(
        "detectPluginOwnership must not be called when home hook exists",
      );
    });
    expect(load()(detect)).toBe(homeHook);
    expect(detect).not.toHaveBeenCalled();
  });

  it("falls back to the owned plugin hook when the home hook is absent", () => {
    const installPath = path.join(tmp, "plugin", "mla", "1.0.0");
    const pluginHook = stagePluginHook(installPath);
    const detect = () =>
      ({
        status: "owned",
        scope: "user",
        version: "1.0.0",
        installPath,
      }) as PluginOwnership;
    expect(load()(detect)).toBe(pluginHook);
  });

  it("returns null when the plugin is owned but its hook file is missing", () => {
    const installPath = path.join(tmp, "plugin", "mla", "1.0.0");
    // installPath resolves but no hooks/session-start.sh on disk.
    const detect = () =>
      ({
        status: "owned",
        scope: "user",
        version: "1.0.0",
        installPath,
      }) as PluginOwnership;
    expect(load()(detect)).toBeNull();
  });

  it("returns null when the plugin is only non-global (no global wiring)", () => {
    const detect = () =>
      ({
        status: "non-global",
        scope: "project",
        version: "1.0.0",
      }) as PluginOwnership;
    expect(load()(detect)).toBeNull();
  });

  it("returns null when neither surface is present (warrants the install nudge)", () => {
    const detect = () => ({ status: "absent" }) as PluginOwnership;
    expect(load()(detect)).toBeNull();
  });

  it("swallows a detection throw and returns null (best-effort, never crashes)", () => {
    const detect = () => {
      throw new Error("claude plugin list wedged");
    };
    expect(load()(detect)).toBeNull();
  });
});
