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

  it("hits its own exit 127 with the not-found message when no mla exists", () => {
    // The §5 list includes hardcoded absolute install paths (/opt/homebrew/bin/mla,
    // /usr/local/bin/mla, /home/linuxbrew/.linuxbrew/bin/mla) that a hermetic test
    // cannot delete from the real filesystem: on a dev machine /opt/homebrew/bin/mla
    // is a live symlink to the dogfood CLI. Left intact, the resolver would exec THAT
    // real binary and 127 would come from its `env node` shebang failing under the
    // stripped PATH, not from the resolver exhausting its candidates. On a box where
    // node is on the base PATH it would instead launch the real `mla mcp` server and
    // hang. So repoint exactly those three baked-in paths into an empty sandbox dir,
    // making "nothing found" genuinely reachable, then prove the resolver's OWN
    // exit-127 branch fired by asserting its bespoke stderr message.
    let script = renderResolverScript();
    const absent = path.join(root, "no-candidates", "mla");
    for (const hard of [
      "/opt/homebrew/bin/mla",
      "/usr/local/bin/mla",
      "/home/linuxbrew/.linuxbrew/bin/mla",
    ]) {
      const before = script;
      script = script.split(hard).join(absent);
      // Drift guard: if a future resolver renames a candidate, fail loudly here rather
      // than silently regress to the coincidental-pass this test exists to kill.
      expect(script).not.toBe(before);
    }
    const hermetic = path.join(root, "resolver-127");
    fs.writeFileSync(hermetic, script);
    fs.chmodSync(hermetic, 0o755);

    let code = 0;
    let stderr = "";
    try {
      execFileSync("sh", [hermetic, "mcp"], {
        env: { PATH: "/usr/bin:/bin", HOME: path.join(root, "empty-home") },
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
