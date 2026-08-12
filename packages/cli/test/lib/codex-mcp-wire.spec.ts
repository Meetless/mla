// Phase-1 gate for the Codex MCP AUTO-WIRE half of install parity (the sibling
// to codex-connector.spec.ts, which gates the hook half). These map to the
// acceptance proofs from the approved proposal's ownership + orchestration
// corrections (RC2 orchestration, RC3 absolute-executable identity, RC4
// ownership behavior, RC5 append-only TOML).
//
// The only faked seam is the `codex` argv subprocess: every test injects a
// `CodexExecFn` so the real merge/append logic runs against a temp CODEX_HOME
// with no Codex binary required. config.toml paths are per-test throwaways;
// nothing touches the operator's real ~/.codex.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ensureCodexMcpServer,
  autoWireCodex,
  findCodexExecutable,
  isOurMlaCommand,
  CODEX_MCP_APPROVAL_MODE,
  type CodexExecFn,
} from "../../src/connectors/codex/wire";
import { printWireResult, type WireResult } from "../../src/lib/wire";

const MLA = "/opt/mla/bin/mla";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
function cfgIn(dir: string): string {
  return path.join(dir, "config.toml");
}

// A stdio meetless entry exactly as `codex mcp get meetless --json` returns it.
function meetlessEntry(
  command: string,
  args: string[],
  enabled: boolean,
): object {
  return { name: "meetless", enabled, transport: { type: "stdio", command, args } };
}

// Build a fake `codex` runner keyed on the argv we send. Any arg vector we do
// not explicitly stub returns a benign non-zero exit (mirrors a Codex that ran
// but had nothing to say).
function fakeExec(map: {
  get?: Partial<{ status: number | null; stdout: string; stderr: string; errorCode: string }>;
  list?: Partial<{ status: number | null; stdout: string; stderr: string; errorCode: string }>;
}): CodexExecFn {
  return (args: string[]) => {
    const key = args.join(" ");
    const base = { status: 1 as number | null, stdout: "", stderr: "" };
    if (key === "mcp get meetless --json") return { ...base, ...(map.get ?? {}) };
    if (key === "mcp list --json") return { ...base, status: 0, stdout: "[]", ...(map.list ?? {}) };
    return base;
  };
}

describe("ensureCodexMcpServer: register + ownership (RC3/RC4/RC5)", () => {
  it("registers a fresh entry with the ABSOLUTE mla path and the writes approval mode", () => {
    const dir = mkTmp("mla-cmcp-add-");
    // codex reports meetless absent (get exit 1) from a config that loads (list []).
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({ get: { status: 1 }, list: { status: 0, stdout: "[]" } }),
    });
    expect(res.action).toBe("added");
    expect(res.configPath).toBe(cfgIn(dir));

    const body = fs.readFileSync(cfgIn(dir), "utf8");
    expect(body).toContain("[mcp_servers.meetless]");
    // RC3: the absolute resolved executable, never the literal "mla".
    expect(body).toContain(`command = "${MLA}"`);
    expect(body).toContain(`args = ["mcp"]`);
    // The governance-critical approval mode: writes gated, reads friction-free.
    expect(body).toContain(`default_tools_approval_mode = "${CODEX_MCP_APPROVAL_MODE}"`);
    expect(CODEX_MCP_APPROVAL_MODE).toBe("writes");
    cleanup(dir);
  });

  it("is idempotent: a canonical present entry is unchanged and NOTHING is written", () => {
    const dir = mkTmp("mla-cmcp-idem-");
    const sentinel = "# hand-managed config, do not touch\n";
    fs.writeFileSync(cfgIn(dir), sentinel, "utf8");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 0, stdout: JSON.stringify(meetlessEntry(MLA, ["mcp"], true)) },
      }),
    });
    expect(res.action).toBe("unchanged");
    // No append, no backup: the file is byte-identical.
    expect(fs.readFileSync(cfgIn(dir), "utf8")).toBe(sentinel);
    expect(fs.readdirSync(dir)).toEqual(["config.toml"]);
    cleanup(dir);
  });

  it("probes from a NEUTRAL cwd, never the process cwd (project-config scope, 0.144.6)", () => {
    // `codex mcp get`/`list` merge the trusted project-level `.codex/config.toml`
    // of the working directory. Probing from the operator's repo could mistake a
    // project-local entry for machine-level wiring, so every probe must run from a
    // cwd that carries no trusted project config.
    const dir = mkTmp("mla-cmcp-cwd-");
    const seenCwds: string[] = [];
    const capturingExec: CodexExecFn = (args, cwd) => {
      seenCwds.push(cwd);
      const key = args.join(" ");
      if (key === "mcp get meetless --json") return { status: 1, stdout: "", stderr: "" };
      if (key === "mcp list --json") return { status: 0, stdout: "[]", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: capturingExec,
    });
    expect(seenCwds.length).toBeGreaterThan(0);
    // Every probe ran from the OS temp dir, not this test process's cwd.
    for (const c of seenCwds) {
      expect(c).toBe(os.tmpdir());
      expect(c).not.toBe(process.cwd());
    }
    cleanup(dir);
  });

  it("preserves a disabled meetless entry and never re-enables it", () => {
    const dir = mkTmp("mla-cmcp-dis-");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 0, stdout: JSON.stringify(meetlessEntry(MLA, ["mcp"], false)) },
      }),
    });
    expect(res.action).toBe("preserved-disabled");
    expect(res.detail).toMatch(/disabled/i);
    // No config write at all for a present entry.
    expect(fs.existsSync(cfgIn(dir))).toBe(false);
    cleanup(dir);
  });

  it("reports a FOREIGN meetless entry as a conflict and never overwrites it (RC4)", () => {
    const dir = mkTmp("mla-cmcp-conf-");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: {
          status: 0,
          stdout: JSON.stringify(meetlessEntry("/usr/bin/false", ["pretend"], true)),
        },
      }),
    });
    expect(res.action).toBe("conflict");
    expect(res.existingCommand).toBe("/usr/bin/false");
    expect(res.existingArgs).toEqual(["pretend"]);
    expect(fs.existsSync(cfgIn(dir))).toBe(false); // never written
    cleanup(dir);
  });

  it("recognizes the bare `mla` plugin form as ours (unchanged, not conflict)", () => {
    const dir = mkTmp("mla-cmcp-bare-");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 0, stdout: JSON.stringify(meetlessEntry("mla", ["mcp"], true)) },
      }),
    });
    expect(res.action).toBe("unchanged");
    cleanup(dir);
  });

  it("treats a non-canonical args vector on an mla command as a conflict", () => {
    const dir = mkTmp("mla-cmcp-args-");
    // Same mla binary, but launched as `mla serve` (not `mla mcp`): not our server.
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 0, stdout: JSON.stringify(meetlessEntry(MLA, ["serve"], true)) },
      }),
    });
    expect(res.action).toBe("conflict");
    expect(res.existingArgs).toEqual(["serve"]);
    cleanup(dir);
  });

  it("uses `list` as the authoritative disambiguator when `get` exits non-zero", () => {
    const dir = mkTmp("mla-cmcp-list-");
    // get fails (exit 1) but the config loads: list carries a foreign entry.
    const conflict = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 1 },
        list: {
          status: 0,
          stdout: JSON.stringify([meetlessEntry("/usr/bin/false", ["x"], true)]),
        },
      }),
    });
    expect(conflict.action).toBe("conflict");
    expect(fs.existsSync(cfgIn(dir))).toBe(false);

    // And list carrying OUR entry disambiguates to unchanged (no double-append).
    const dir2 = mkTmp("mla-cmcp-list2-");
    const unchanged = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir2),
      exec: fakeExec({
        get: { status: 1 },
        list: { status: 0, stdout: JSON.stringify([meetlessEntry(MLA, ["mcp"], true)]) },
      }),
    });
    expect(unchanged.action).toBe("unchanged");
    cleanup(dir, dir2);
  });

  it("skips (never writes) when codex is absent from PATH", () => {
    const dir = mkTmp("mla-cmcp-noexe-");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({ get: { errorCode: "ENOENT", status: null } }),
    });
    expect(res.action).toBe("skipped");
    expect(res.detail).toMatch(/not on PATH/i);
    expect(fs.existsSync(cfgIn(dir))).toBe(false);
    cleanup(dir);
  });

  it("skips (never writes) when Codex cannot load its config", () => {
    const dir = mkTmp("mla-cmcp-badcfg-");
    fs.writeFileSync(cfgIn(dir), "this = is = broken\n", "utf8");
    const before = fs.readFileSync(cfgIn(dir), "utf8");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({
        get: { status: 1 },
        list: { status: 2, stderr: "TOML parse error at line 1\nmore noise" },
      }),
    });
    expect(res.action).toBe("skipped");
    expect(res.detail).toContain("TOML parse error at line 1");
    expect(res.detail).toContain(cfgIn(dir)); // names the file to fix
    expect(fs.readFileSync(cfgIn(dir), "utf8")).toBe(before); // untouched
    cleanup(dir);
  });

  it("byte-backs-up and preserves prior content when appending (RC5)", () => {
    const dir = mkTmp("mla-cmcp-pres-");
    const prior =
      "# my codex config\n" +
      'model = "o3"\n\n' +
      "[mcp_servers.other]\n" +
      'command = "/usr/bin/other"\n' +
      "startup_timeout_sec = 42\n";
    fs.writeFileSync(cfgIn(dir), prior, "utf8");
    const res = ensureCodexMcpServer({
      mlaPath: MLA,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({ get: { status: 1 }, list: { status: 0, stdout: "[]" } }),
    });
    expect(res.action).toBe("added");
    const body = fs.readFileSync(cfgIn(dir), "utf8");
    expect(body.startsWith(prior)).toBe(true); // prior bytes preserved verbatim
    expect(body).toContain("[mcp_servers.meetless]"); // ours appended after
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("config.toml.bak."));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(prior);
    cleanup(dir);
  });

  it("TOML-escapes a backslash/quote in the executable path (RC5 correctness)", () => {
    const dir = mkTmp("mla-cmcp-esc-");
    const weird = 'C:\\Program "Files"\\mla';
    const res = ensureCodexMcpServer({
      mlaPath: weird,
      configPathOverride: cfgIn(dir),
      exec: fakeExec({ get: { status: 1 }, list: { status: 0, stdout: "[]" } }),
    });
    expect(res.action).toBe("added");
    const body = fs.readFileSync(cfgIn(dir), "utf8");
    expect(body).toContain('command = "C:\\\\Program \\"Files\\"\\\\mla"');
    cleanup(dir);
  });
});

describe("isOurMlaCommand: canonical executable identity (RC3)", () => {
  it("accepts the absolute registered path, bare `mla`, and any /mla basename", () => {
    expect(isOurMlaCommand(MLA, MLA)).toBe(true);
    expect(isOurMlaCommand("mla", MLA)).toBe(true);
    expect(isOurMlaCommand("/somewhere/else/bin/mla", MLA)).toBe(true); // relocated binary
  });
  it("rejects a foreign command and non-strings", () => {
    expect(isOurMlaCommand("/usr/bin/false", MLA)).toBe(false);
    expect(isOurMlaCommand("", MLA)).toBe(false);
    expect(isOurMlaCommand(undefined, MLA)).toBe(false);
    expect(isOurMlaCommand(42, MLA)).toBe(false);
  });
});

describe("findCodexExecutable", () => {
  it("returns the absolute path of an executable `codex` on PATH", () => {
    const dir = mkTmp("mla-findcodex-");
    const exe = path.join(dir, "codex");
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    const found = findCodexExecutable({ env: { PATH: dir } });
    expect(found).toBe(exe);
    cleanup(dir);
  });
  it("returns null when codex is not on PATH", () => {
    expect(findCodexExecutable({ env: { PATH: "/nonexistent-dir-xyz" } })).toBeNull();
    expect(findCodexExecutable({ env: { PATH: "" } })).toBeNull();
  });
});

describe("autoWireCodex: install orchestrator (RC2)", () => {
  it("registerMcp:false wires hooks only and never touches config.toml (--no-mcp)", () => {
    const dir = mkTmp("mla-auto-nomcp-");
    const out = autoWireCodex({
      registerMcp: false,
      hooksPathOverride: path.join(dir, "hooks.json"),
      configPathOverride: cfgIn(dir),
      mlaPath: MLA,
    });
    expect(out.mcp.action).toBe("skipped");
    expect(out.mcp.detail).toBe("--no-mcp");
    expect(out.hooks.result?.changed).toBe(true);
    expect(fs.existsSync(path.join(dir, "hooks.json"))).toBe(true);
    expect(fs.existsSync(cfgIn(dir))).toBe(false); // MCP untouched
    cleanup(dir);
  });

  it("wires both hooks and MCP by default", () => {
    const dir = mkTmp("mla-auto-both-");
    const out = autoWireCodex({
      hooksPathOverride: path.join(dir, "hooks.json"),
      configPathOverride: cfgIn(dir),
      mlaPath: MLA,
      exec: fakeExec({ get: { status: 1 }, list: { status: 0, stdout: "[]" } }),
    });
    expect(out.hooks.result?.changed).toBe(true);
    expect(out.mcp.action).toBe("added");
    expect(fs.existsSync(cfgIn(dir))).toBe(true);
    cleanup(dir);
  });

  it("surfaces a malformed hooks.json as an error string WITHOUT throwing or clobbering", () => {
    const dir = mkTmp("mla-auto-bad-");
    const hooks = path.join(dir, "hooks.json");
    fs.writeFileSync(hooks, "{ not valid json", "utf8");
    let out!: ReturnType<typeof autoWireCodex>;
    expect(() => {
      out = autoWireCodex({
        hooksPathOverride: hooks,
        configPathOverride: cfgIn(dir),
        mlaPath: MLA,
        exec: fakeExec({ get: { errorCode: "ENOENT", status: null } }),
      });
    }).not.toThrow();
    expect(out.hooks.error).toMatch(/not valid JSON/i);
    expect(fs.readFileSync(hooks, "utf8")).toBe("{ not valid json"); // untouched
    // MCP is still attempted independently (here codex is absent -> skipped).
    expect(out.mcp.action).toBe("skipped");
    cleanup(dir);
  });
});

describe("printWireResult: Codex block rendering (RC2)", () => {
  function baseResult(codex: WireResult["codex"]): WireResult {
    return {
      copied: [],
      hooksAdded: [],
      settingsPath: "/tmp/settings.json",
      skillDir: "/tmp/skill",
      onboardSkillDir: "/tmp/onboard",
      scoutAgents: [],
      flock: null,
      projectRules: null,
      mcp: null,
      codex,
    };
  }
  function capture(codex: WireResult["codex"]): string {
    const lines: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => {
      lines.push(String(m));
    });
    try {
      printWireResult(baseResult(codex));
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("renders freshly-registered hooks + MCP and the one-time /hooks trust reminder", () => {
    const out = capture({
      hooks: { result: { changed: true, filePath: "/tmp/cx/hooks.json" } as any },
      mcp: { action: "added", configPath: "/tmp/cx/config.toml" },
    });
    expect(out).toContain("Registered Meetless Codex hooks in /tmp/cx/hooks.json.");
    expect(out).toContain("Meetless MCP server registered with Codex in /tmp/cx/config.toml.");
    expect(out).toContain("open /hooks once to review and trust the Meetless hooks");
  });

  it("renders a conflict with the exact existing command+args and stays non-fatal", () => {
    const out = capture({
      hooks: { result: { changed: false, filePath: "/tmp/cx/hooks.json" } as any },
      mcp: {
        action: "conflict",
        configPath: "/tmp/cx/config.toml",
        detail: "left unchanged",
        existingCommand: "/usr/bin/false",
        existingArgs: ["pretend"],
      },
    });
    expect(out).toContain("A different Meetless MCP registration already exists with Codex; MLA did not replace it.");
    expect(out).toContain("existing entry runs: /usr/bin/false pretend");
    // idempotent hooks -> no trust reminder spam
    expect(out).not.toContain("open /hooks once");
  });

  it("stays silent about the benign --no-mcp skip", () => {
    const out = capture({
      hooks: { result: { changed: false, filePath: "/tmp/cx/hooks.json" } as any },
      mcp: { action: "skipped", configPath: "/tmp/cx/config.toml", detail: "--no-mcp" },
    });
    expect(out).not.toContain("NOT registered with Codex");
  });

  it("reports an unchanged entry source-neutrally, never naming config.toml", () => {
    // `codex mcp get`/`list` cannot prove where a present entry was declared
    // (user config, trusted project config, or a plugin), so `unchanged` must
    // report availability without claiming MLA wrote it to config.toml.
    const out = capture({
      hooks: { result: { changed: false, filePath: "/tmp/cx/hooks.json" } as any },
      mcp: { action: "unchanged", configPath: "/tmp/cx/config.toml" },
    });
    expect(out).toContain(
      "Meetless MCP server already available to Codex; no configuration change was made.",
    );
    expect(out).not.toContain("/tmp/cx/config.toml");
    expect(out).not.toContain("provided by a plugin");
  });

  it("prints no Codex lines when Codex is absent (r.codex null)", () => {
    const out = capture(null);
    expect(out).not.toMatch(/Codex/);
  });
});
