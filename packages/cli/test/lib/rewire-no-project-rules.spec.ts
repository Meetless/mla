import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// os.homedir() is a non-configurable property under jest (jest.spyOn throws
// "Cannot redefine property"), and a runtime-mutated process.env.HOME is NOT
// honored by it here. So we mock the os module itself: real implementation for
// everything, but homedir() reads a mutable sandbox path. The `mock`-prefixed
// name is required for a jest.mock factory closure.
let mockHomedir: string | null = null;
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, homedir: () => mockHomedir ?? actual.homedir() };
});

// BUG (found dogfooding 2026-06-04): `mla rewire` refreshes local wiring
// (hooks, skill, flock, cli-config.json). It is documented as "only refreshes
// the local wiring of an existing install". But it also called
// writeProjectRules(resolveProjectRoot()), so a routine hook refresh silently
// mutated the CLAUDE.md of whatever repo the cwd happened to sit in (it planted
// a 14-line onboarding stub in the meetless monorepo root when run from
// tools/meetless-agent). Writing a repo's Project rules file is `mla init`'s job
// (operator opting a repo into onboarding hygiene), NOT a side effect of a
// frequent, cwd-sensitive wiring refresh. This test locks the decoupling:
// rewire does its wiring work but never touches the cwd repo's CLAUDE.md.
//
// Isolation: a tmp MEETLESS_HOME drives HOOKS_DIR/CFG_PATH (config.ts reads
// process.env.MEETLESS_HOME directly, so that override is honored). The
// ~/.claude/* writes (settings.json, the /mla skill) go through os.homedir(),
// and os.homedir() under jest does NOT reliably honor a runtime-mutated
// process.env.HOME: it returned the operator's REAL home, so this test used to
// write temp-HOOKS_DIR hook entries into the real ~/.claude/settings.json on every
// run and then delete the temp dir in afterEach. That dangling-path poison is the
// exact F3 idle-session incident (prefix mla-rewire-home-*). We now pin
// os.homedir() to tmpHome via the os module mock above so every .claude/* write
// lands in the sandbox (and the ensureClaudeSettings temp-poison guard sees a temp
// settings file too, so it does not fire). cwd is a fresh git repo so
// resolveProjectRoot() returns it.
describe("mla rewire is decoupled from Project rules (init's job, not rewire's)", () => {
  let tmpHome: string;
  let tmpRepo: string;
  let prevHome: string | undefined;
  let prevMlHome: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rewire-home-"));
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rewire-repo-"));
    // A real git repo so resolveProjectRoot() returns tmpRepo, not some
    // ancestor that os.tmpdir() might happen to live under.
    execFileSync("git", ["init", "-q"], { cwd: tmpRepo });

    prevHome = process.env.HOME;
    prevMlHome = process.env.MEETLESS_HOME;
    prevCwd = process.cwd();

    process.env.HOME = tmpHome;
    // Pin os.homedir() to the sandbox. Without this, ensureClaudeSettings +
    // installSkill write into the operator's REAL ~/.claude (the F3 poison vector).
    mockHomedir = tmpHome;
    process.env.MEETLESS_HOME = path.join(tmpHome, ".meetless");
    fs.mkdirSync(process.env.MEETLESS_HOME, { recursive: true });
    // Seed a config valid enough for readConfig() so rewire reaches runWire
    // instead of bailing early (which would pass this test for the wrong reason).
    fs.writeFileSync(
      path.join(process.env.MEETLESS_HOME, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        controlToken: "test-token",
        workspaceId: "ws_test",
        intelUrl: "http://127.0.0.1:8100",
      }) + "\n",
    );

    process.chdir(tmpRepo);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevMlHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevMlHome;
    mockHomedir = null;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    jest.resetModules();
  });

  it("refreshes hooks but writes no CLAUDE.md into the cwd repo", async () => {
    let runRewire: (argv: string[]) => Promise<number>;
    jest.isolateModules(() => {
      // Re-required under the redirected env so config consts (HOOKS_DIR,
      // CFG_PATH) resolve into the tmp MEETLESS_HOME.
      runRewire = require("../../src/commands/rewire").runRewire;
    });
    await runRewire!([]);

    // Proof that rewire actually did its wiring work (did not bail early):
    // the hook templates were copied into the tmp MEETLESS_HOME.
    const installedHook = path.join(
      process.env.MEETLESS_HOME as string,
      "hooks",
      "common.sh",
    );
    expect(fs.existsSync(installedHook)).toBe(true);

    // Isolation lock: the settings write MUST land in the sandbox, not the real
    // ~/.claude. If os.homedir() ever stops being pinned, this fails instead of
    // silently poisoning the operator's real settings.json (the F3 incident).
    expect(fs.existsSync(path.join(tmpHome, ".claude", "settings.json"))).toBe(true);

    // The actual contract: no Project rules file is planted in the cwd repo.
    expect(fs.existsSync(path.join(tmpRepo, "CLAUDE.md"))).toBe(false);
  });
});
