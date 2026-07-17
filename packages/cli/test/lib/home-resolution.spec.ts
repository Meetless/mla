import * as fs from "fs";
import * as path from "path";
import { repairHomeEnv, resolveMeetlessHome, userHomeDir } from "../../src/lib/config";

// `os.homedir()` returns $HOME VERBATIM whenever $HOME is set, even to garbage.
// It only falls back to the passwd entry when $HOME is UNSET. So a set-but-broken
// $HOME ("" or a literal "~") made `path.join(os.homedir(), ".meetless")` produce a
// RELATIVE path, and every mla state path (cli-config.json, queue, logs, hooks, the
// ce0 evidence store) silently re-rooted under process.cwd(). That is not cosmetic
// litter: with no cli-config.json under the forked home, mla reads an empty config
// and behaves as if the operator were logged out, while writing evidence rows into
// whatever repo happened to be the cwd. Observed for real on 2026-07-13: an
// `mla evidence` run wrote <repo>/.meetless/{ce0,events.jsonl,update-check.json}.
describe("resolveMeetlessHome", () => {
  const noop = () => {};

  it("uses $HOME when it is absolute", () => {
    const home = resolveMeetlessHome({ env: {}, homedir: () => "/Users/x", warn: noop });
    expect(home).toBe(path.join("/Users/x", ".meetless"));
  });

  it("prefers an absolute MEETLESS_HOME over $HOME", () => {
    const home = resolveMeetlessHome({
      env: { MEETLESS_HOME: "/box/.meetless" },
      homedir: () => "/Users/x",
      warn: noop,
    });
    expect(home).toBe("/box/.meetless");
  });

  it.each([
    ["an empty $HOME", ""],
    ['a literal "~" $HOME', "~"],
    ["a relative $HOME", "some/dir"],
  ])("recovers the passwd home from %s rather than returning a cwd-relative path", (_label, broken) => {
    const home = resolveMeetlessHome({
      env: {},
      homedir: () => broken,
      passwdHomedir: () => "/Users/x",
      warn: noop,
    });
    expect(path.isAbsolute(home)).toBe(true);
    expect(home).toBe(path.join("/Users/x", ".meetless"));
  });

  it("warns on stderr when it recovers, so a poisoned env is visible and not silent", () => {
    const warnings: string[] = [];
    resolveMeetlessHome({
      env: {},
      homedir: () => "~",
      passwdHomedir: () => "/Users/x",
      warn: (m: string) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HOME");
    expect(warnings[0]).toContain("/Users/x");
  });

  // A relative MEETLESS_HOME is a deliberate operator input, so it is NOT silently
  // rewritten: quietly relocating the state dir the operator asked for is its own
  // surprise. Fail loudly instead.
  it("rejects a relative MEETLESS_HOME", () => {
    expect(() =>
      resolveMeetlessHome({ env: { MEETLESS_HOME: ".meetless" }, homedir: () => "/Users/x", warn: noop }),
    ).toThrow(/MEETLESS_HOME.*absolute/s);
  });

  it("throws when neither $HOME nor the passwd entry yields an absolute path", () => {
    expect(() =>
      resolveMeetlessHome({ env: {}, homedir: () => "", passwdHomedir: () => "", warn: noop }),
    ).toThrow(/home directory/i);
  });

  it("throws, rather than crashing, when the passwd lookup itself fails", () => {
    expect(() =>
      resolveMeetlessHome({
        env: {},
        homedir: () => "",
        passwdHomedir: () => {
          throw new Error("getpwuid failed");
        },
        warn: noop,
      }),
    ).toThrow(/home directory/i);
  });
});

// The `.meetless` family was only half the blast radius. `wire`, `activate`, `doctor`
// and `uninstall` resolve the CLAUDE CODE family (~/.claude.json, ~/.claude/settings.json,
// ~/.claude/skills/mla) off their own raw `os.homedir()`, so under HOME='~' they wrote a
// phantom <cwd>/~/.claude.json (and dutifully took a BACKUP of it) while the real Claude
// Code config sat untouched. Same trap, different family.
describe("userHomeDir", () => {
  const noop = () => {};

  it("returns $HOME when it is absolute, with no .meetless suffix", () => {
    expect(userHomeDir({ homedir: () => "/Users/x", warn: noop })).toBe("/Users/x");
  });

  it.each([
    ["an empty $HOME", ""],
    ['a literal "~" $HOME', "~"],
    ["a relative $HOME", "some/dir"],
  ])("recovers the passwd home from %s, so ~/.claude paths cannot land in the cwd", (_l, broken) => {
    const home = userHomeDir({ homedir: () => broken, passwdHomedir: () => "/Users/x", warn: noop });
    expect(home).toBe("/Users/x");
    expect(path.isAbsolute(path.join(home, ".claude.json"))).toBe(true);
  });

  it("is not memoized, because the HOME-isolated tests repoint $HOME between calls", () => {
    let home = "/tmp/a";
    expect(userHomeDir({ homedir: () => home, warn: noop })).toBe("/tmp/a");
    home = "/tmp/b";
    expect(userHomeDir({ homedir: () => home, warn: noop })).toBe("/tmp/b");
  });
});

// Fixing every call site in THIS codebase protects only what mla writes itself. It does
// nothing about the processes mla spawns, and they inherit our environment: `doctor` spawns
// `claude plugin list`, `wire` spawns git and brew, `upgrade` spawns tar. Reproduced: `mla
// doctor` under HOME='~' spawns the Claude Code CLI, which sees a home it has never seen and
// bootstraps a brand new <cwd>/~/.claude.json (firstStartTime = now, fresh machineID) while
// the operator's real ~/.claude.json sits untouched. We cannot patch Claude Code, git, or npm
// from in here; we can refuse to hand them a broken $HOME.
//
// The real 2026-07-13 incident was the EMPTY case, not the tilde one: a `bash -c 'source
// ./lib.sh; ...; env HOME="$BOX_HOME" claude ...'` ran from a cwd where ./lib.sh did not
// exist, so every box var was unset and Claude Code booted with HOME=''. Claude Code itself
// shrugged it off (it does not resolve its config dir off $HOME), but everything it spawned
// inherited the empty value: mla wrote <repo>/.meetless, and npm (`this.home = env.HOME ||
// homedir()`, then `resolve('~/.npm')` when that is falsy) wrote a 71MB literal <repo>/~/.npm.
describe("repairHomeEnv", () => {
  const noop = () => {};
  const deps = (passwd = "/Users/x") => ({ passwdHomedir: () => passwd, warn: noop });

  it.each([
    ["an empty $HOME", ""],
    ['a literal "~" $HOME', "~"],
    ["a relative $HOME", "some/dir"],
  ])("rewrites %s to the passwd home, so children cannot inherit the poison", (_l, broken) => {
    const env: NodeJS.ProcessEnv = { HOME: broken };
    repairHomeEnv(env, { homedir: () => broken, ...deps() });
    expect(env.HOME).toBe("/Users/x");
  });

  it("leaves an absolute $HOME exactly as the operator set it", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/Users/real" };
    repairHomeEnv(env, { homedir: () => "/Users/real", ...deps() });
    expect(env.HOME).toBe("/Users/real");
  });

  // An ABSENT $HOME is not broken, it is unset, and every tool (us included) already falls
  // back to the passwd entry for it. Inventing a value would be a behavior change with no bug
  // behind it, so the repair stays scoped to the one case that is unambiguously wrong.
  it("leaves an unset $HOME unset", () => {
    const env: NodeJS.ProcessEnv = {};
    repairHomeEnv(env, { homedir: () => "/Users/x", ...deps() });
    expect("HOME" in env).toBe(false);
  });

  it("leaves the broken value in place when there is no passwd home to repair it to", () => {
    const env: NodeJS.ProcessEnv = { HOME: "~" };
    repairHomeEnv(env, { homedir: () => "~", passwdHomedir: () => "", warn: noop });
    expect(env.HOME).toBe("~");
  });
});

// A lint, not a unit test. The bug was never one bad line: it was ~20 call sites each
// independently trusting `os.homedir()`. Fixing them without closing the door just means
// the 21st reintroduces it. `userHomeDir()` is the only sanctioned reader of the home dir.
describe("no raw os.homedir() outside the one resolver", () => {
  const SRC = path.join(__dirname, "..", "..", "src");
  const ALLOWED = [path.join("lib", "config.ts")];

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.isFile() && e.name.endsWith(".ts") ? [full] : [];
    });

  // Strip comments before matching: the doc comments in config.ts and the call sites
  // legitimately NAME `os.homedir()` while explaining why not to call it.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("has no call site that bypasses userHomeDir()", () => {
    const offenders = walk(SRC)
      .filter((f) => !ALLOWED.some((a) => f.endsWith(a)))
      .filter((f) => /(?:os\.)?\bhomedir\s*\(\s*\)/.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });
});
