import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { renderResolverScript } from "../../src/connectors/claude-code/plugin-artifact";

// Write the rendered resolver to a temp dir and run it under a controlled env.
// A fake "mla" is a tiny sh script that prints a marker plus its args, so the
// test can tell WHICH candidate got exec'd and that args were forwarded.
function makeFakeMla(dir: string, marker: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "mla");
  fs.writeFileSync(p, `#!/bin/sh\nprintf '${marker}:%s\\n' "$*"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

// Render the resolver with its three baked-in absolute install paths
// (/opt/homebrew/bin/mla, /usr/local/bin/mla, /home/linuxbrew/.linuxbrew/bin/mla)
// repointed into an absent sandbox path, so "nothing installed on this machine"
// is genuinely reachable even on a dev box where /opt/homebrew/bin/mla is a live
// symlink to the dogfood CLI. The drift guard fails loudly if a candidate is ever
// renamed, rather than silently regressing to a coincidental pass.
function renderScriptWithoutSystemCandidates(absent: string): string {
  let script = renderResolverScript();
  for (const hard of [
    "/opt/homebrew/bin/mla",
    "/usr/local/bin/mla",
    "/home/linuxbrew/.linuxbrew/bin/mla",
  ]) {
    const before = script;
    script = script.split(hard).join(absent);
    expect(script).not.toBe(before);
  }
  return script;
}

// A fake installer, served to the resolver over a file:// URL, that drops a fake
// mla (printing `BOOTSTRAPPED:<args>`) into the canonical ~/.meetless/bin location
// the resolver execs after bootstrap. Returns the installer path.
function makeFakeInstaller(root: string, name: string): string {
  const premade = makeFakeMla(path.join(root, `${name}-src`), "BOOTSTRAPPED");
  const installer = path.join(root, `${name}.sh`);
  fs.writeFileSync(
    installer,
    `#!/bin/sh\nmkdir -p "$HOME/.meetless/bin"\ncp '${premade}' "$HOME/.meetless/bin/mla"\nchmod +x "$HOME/.meetless/bin/mla"\n`,
  );
  fs.chmodSync(installer, 0o755);
  return installer;
}

describe("resolve-mla (generated script)", () => {
  let root: string;
  let resolver: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-mla-"));
    resolver = path.join(root, "resolve-mla");
    fs.writeFileSync(resolver, renderResolverScript());
    fs.chmodSync(resolver, 0o755);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(env: NodeJS.ProcessEnv, ...args: string[]): string {
    return execFileSync("sh", [resolver, ...args], {
      env: { PATH: "/usr/bin:/bin", ...env },
      encoding: "utf8",
    });
  }

  it("prefers MEETLESS_MLA_PATH over everything", () => {
    const envMla = makeFakeMla(path.join(root, "env"), "ENV");
    // A HOME candidate also exists, so a plain "ENV:mcp" proves precedence, not just
    // presence. We only need its side effect (the file on disk), not its path.
    makeFakeMla(path.join(root, "home", ".meetless", "bin"), "HOME");
    const out = run(
      { MEETLESS_MLA_PATH: envMla, HOME: path.join(root, "home") },
      "mcp",
    );
    expect(out.trim()).toBe("ENV:mcp");
  });

  it("falls back to $HOME/.meetless/bin/mla and forwards multiple args", () => {
    makeFakeMla(path.join(root, "home", ".meetless", "bin"), "HOME");
    const out = run({ HOME: path.join(root, "home") }, "mcp", "--verbose");
    expect(out.trim()).toBe("HOME:mcp --verbose");
  });

  it("never re-execs itself when MEETLESS_MLA_PATH points at the resolver", () => {
    makeFakeMla(path.join(root, "home", ".meetless", "bin"), "HOME");
    const out = run(
      { MEETLESS_MLA_PATH: resolver, HOME: path.join(root, "home") },
      "mcp",
    );
    // Skips the self-pointing override, resolves the next candidate instead.
    expect(out.trim()).toBe("HOME:mcp");
  });

  it("hits its own exit 127 with the not-found message when no mla exists (bootstrap opted out)", () => {
    // With every candidate absent the resolver would otherwise try its network
    // self-heal, so MEETLESS_MLA_NO_BOOTSTRAP=1 isolates the pure candidate-
    // exhaustion path and proves the resolver reached its OWN exit-127 branch
    // (asserted via the bespoke stderr message), not a stray exec of a real binary.
    const absent = path.join(root, "no-candidates", "mla");
    const hermetic = path.join(root, "resolver-127");
    fs.writeFileSync(hermetic, renderScriptWithoutSystemCandidates(absent));
    fs.chmodSync(hermetic, 0o755);

    let code = 0;
    let stderr = "";
    try {
      execFileSync("sh", [hermetic, "mcp"], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: path.join(root, "empty-home"),
          MEETLESS_MLA_NO_BOOTSTRAP: "1",
        },
        encoding: "utf8",
      });
    } catch (e: any) {
      code = e.status;
      stderr = String(e.stderr ?? "");
    }
    expect(code).toBe(127);
    // Not a stray exec of a real binary: the resolver reached its own last line.
    expect(stderr).toContain("could not find");
  });

  it("bootstraps the binary from MEETLESS_INSTALL_URL when none is installed, then execs it", () => {
    // Plugin-first install: `claude plugin install mla@meetless` with no binary yet.
    // The resolver must fetch the installer (here a local file:// URL, so the test is
    // hermetic and offline), which drops the binary at ~/.meetless/bin/mla, then exec
    // it with the forwarded args. stdout carrying the fake binary's marker proves the
    // exec happened; the persisted file proves the install location is correct.
    const installer = makeFakeInstaller(root, "installer");
    const absent = path.join(root, "no-candidates", "mla");
    const hermetic = path.join(root, "resolver-bootstrap");
    fs.writeFileSync(hermetic, renderScriptWithoutSystemCandidates(absent));
    fs.chmodSync(hermetic, 0o755);

    const home = path.join(root, "boot-home"); // fresh: no ~/.meetless/bin/mla yet
    const out = execFileSync("sh", [hermetic, "mcp"], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        MEETLESS_INSTALL_URL: `file://${installer}`,
      },
      encoding: "utf8",
    });
    expect(out.trim()).toBe("BOOTSTRAPPED:mcp");
    expect(fs.existsSync(path.join(home, ".meetless", "bin", "mla"))).toBe(true);
  });

  it("does NOT bootstrap when MEETLESS_MLA_NO_BOOTSTRAP=1, even with a working installer URL", () => {
    // The kill switch wins over an otherwise-fetchable installer: no network, no
    // binary written, straight to the 127 hint.
    const installer = makeFakeInstaller(root, "optout-installer");
    const absent = path.join(root, "no-candidates", "mla");
    const hermetic = path.join(root, "resolver-optout");
    fs.writeFileSync(hermetic, renderScriptWithoutSystemCandidates(absent));
    fs.chmodSync(hermetic, 0o755);

    const home = path.join(root, "optout-home");
    let code = 0;
    let stderr = "";
    try {
      execFileSync("sh", [hermetic, "mcp"], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          MEETLESS_INSTALL_URL: `file://${installer}`,
          MEETLESS_MLA_NO_BOOTSTRAP: "1",
        },
        encoding: "utf8",
      });
    } catch (e: any) {
      code = e.status;
      stderr = String(e.stderr ?? "");
    }
    expect(code).toBe(127);
    expect(stderr).toContain("could not find");
    expect(fs.existsSync(path.join(home, ".meetless", "bin", "mla"))).toBe(false);
  });

  // A launcher that exports HOME='~' (or '') is the same class of poison the Node CLI
  // now repairs in lib/config, but this script runs BEFORE mla, in the environment Claude
  // Code hands it, so it has to defend itself. A quoted "~" is NOT tilde-expanded, so
  // "$HOME/.meetless" is a RELATIVE path and every use lands in the cwd. Observed
  // 2026-07-13: a 71MB <repo>/~/.npm tree, and a <repo>/~/.claude.json, in a git checkout.
  //
  // The two cases differ in ONE way, deliberately: a non-empty garbage $HOME is a launcher
  // bug worth naming on stderr, while an EMPTY $HOME is indistinguishable from the unset
  // $HOME of a stripped GUI env (below), which is legitimate and must stay quiet. Both are
  // equally refused; only one is announced.
  describe.each([
    ['a literal "~"', "~", true],
    ["an empty string", "", false],
  ])("when $HOME is %s", (_label, poisoned, warns) => {
    // Run FROM a scratch cwd so any relative write lands somewhere we can inspect. This is
    // the whole point of the test: assert on the filesystem, not just on stdout.
    function runIn(cwd: string, env: NodeJS.ProcessEnv, script: string, ...args: string[]) {
      try {
        const stdout = execFileSync("sh", [script, ...args], {
          cwd,
          env: { PATH: "/usr/bin:/bin", HOME: poisoned, ...env },
          encoding: "utf8",
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e: any) {
        return { code: e.status as number, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
      }
    }

    it("never execs an mla out of the CURRENT DIRECTORY", () => {
      // The exploit shape, not a hypothetical: with HOME='~' the candidate
      // "$HOME/.meetless/bin/mla" is the relative path "~/.meetless/bin/mla", so a file
      // sitting in the repo you happen to have open satisfies `[ -x ]` and gets exec'd.
      //
      // No MEETLESS_MLA_PATH here on purpose: the override is the FIRST candidate, so
      // setting it would short-circuit the loop before it ever probed the home candidate
      // and the test would pass with the bug still in. The system candidates are stubbed
      // out and bootstrap is off, so the ONLY thing that can produce output is the cwd
      // binary. Under the old script this printed CWD-BINARY and exited 0.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poisoned-cwd-"));
      makeFakeMla(path.join(cwd, "~", ".meetless", "bin"), "CWD-BINARY");
      const absent = path.join(root, "no-candidates", "mla");
      const hermetic = path.join(root, `resolver-cwd-${warns ? "tilde" : "empty"}`);
      fs.writeFileSync(hermetic, renderScriptWithoutSystemCandidates(absent));
      fs.chmodSync(hermetic, 0o755);

      const r = runIn(cwd, { MEETLESS_MLA_NO_BOOTSTRAP: "1" }, hermetic, "mcp");

      expect(r.stdout).not.toContain("CWD-BINARY");
      expect(r.code).toBe(127); // refused every candidate and said so, honestly
      expect(r.stderr).toContain("could not find");
      expect(r.stderr.includes("not an absolute path")).toBe(warns);
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does not bootstrap, so no literal ~ tree is planted in the cwd", () => {
      // The bootstrap is what actually did the damage: `mkdir -p "$HOME/.meetless"` with a
      // relative $HOME, then curl | sh with the SAME broken $HOME, so the installer wrote
      // its whole tree (and npm its cache) under <cwd>/~. With no usable home there is
      // nowhere legitimate to install to, and refusing is the only correct answer.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poisoned-boot-"));
      const installer = makeFakeInstaller(root, `poisoned-installer-${poisoned ? "tilde" : "empty"}`);
      const absent = path.join(root, "no-candidates", "mla");
      const hermetic = path.join(root, `resolver-poisoned-${poisoned ? "tilde" : "empty"}`);
      fs.writeFileSync(hermetic, renderScriptWithoutSystemCandidates(absent));
      fs.chmodSync(hermetic, 0o755);

      const r = runIn(cwd, { MEETLESS_INSTALL_URL: `file://${installer}` }, hermetic, "mcp");

      expect(r.code).toBe(127); // reached the honest "could not find mla" exit
      expect(r.stderr).toContain("could not find");
      expect(fs.readdirSync(cwd)).toEqual([]); // the load-bearing assertion
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });

  it("does not abort under `set -u` when HOME is unset (stripped GUI env)", () => {
    // A GUI-launched Claude Code, or an `env -i` MCP boot, may run the resolver
    // with HOME unset. The $HOME candidate MUST be written `${HOME:-}` so `set -u`
    // does not abort on an unbound variable before reaching the other candidates.
    // execFileSync's `env` REPLACES the environment (it does not merge process.env),
    // so omitting HOME from the passed object yields a genuinely HOME-free child; a
    // non-interactive `sh script` does not synthesize HOME either. MEETLESS_MLA_PATH
    // still resolves, proving the guard let execution reach the first candidate.
    const envMla = makeFakeMla(path.join(root, "env"), "ENV");
    const out = run({ MEETLESS_MLA_PATH: envMla }, "mcp");
    expect(out.trim()).toBe("ENV:mcp");
  });
});
