import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { maybeHealMcpCommand } from "../../src/lib/wire";
import type { BuildInfo } from "../../src/lib/observability";

// Behavioral lock for `maybeHealMcpCommand`: the bootstrap self-heal that repairs a
// PROVABLY-BROKEN Meetless MCP `command` in ~/.claude.json the moment a NEW binary
// is in charge. This is the piece maybeResyncHooks deliberately does NOT do (it
// never touches ~/.claude.json), and it is what actually rescues the prod bug where
// an older @yao-pkg/pkg binary baked the command from process.argv[1] =
// `/snapshot/.../cli.js` -- a snapshot-VFS path Claude Code cannot spawn (ENOENT),
// so the meetless__* tools silently never load.
//
// Design under test:
//   - A hidden `.mla-mcp-heal-stamp` in the hooks dir records the build identity
//     that last reconciled the MCP command. Matching stamp => cheap no-op, and
//     crucially NO parse of the (large) claude.json.
//   - On a stamp mismatch, repair ONLY an entry that EXISTS and is provably broken
//     (a /snapshot mount, or a stale/moved absolute path). NEVER create from
//     absence, NEVER re-canonicalize a healthy or bare-name command.
//   - Fail-open: never throws; unbuilt `dev` sha, an unwired machine, a missing
//     claude.json, and a kill switch are all skipped.

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

const BUILD_A: BuildInfo = {
  version: "1.0.0",
  sha: "aaaaaaa",
  branch: "main",
  dirty: false,
  builtAt: "2026-06-26T00:00:00.000Z",
};
const BUILD_B: BuildInfo = {
  version: "1.1.0",
  sha: "bbbbbbb",
  branch: "main",
  dirty: false,
  builtAt: "2026-06-27T00:00:00.000Z",
};
const STAMP_A = "aaaaaaa|clean|2026-06-26T00:00:00.000Z";
const STAMP_B = "bbbbbbb|clean|2026-06-27T00:00:00.000Z";
const STAMP = ".mla-mcp-heal-stamp";
const POISON = "/snapshot/meetless-cli/packages/cli/dist/cli.js";
const HEAL_TARGET = "/opt/homebrew/bin/mla"; // deterministic heal destination

function writeJson(p: string, obj: unknown): void {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
// A real executable file so mcpCommandExecutable() reports healthy.
function goodBinary(dir: string): string {
  const p = path.join(dir, "mla");
  fs.writeFileSync(p, "#!/bin/sh\n:\n");
  fs.chmodSync(p, 0o755);
  return p;
}

describe("maybeHealMcpCommand (bootstrap MCP command self-heal)", () => {
  it("heals a /snapshot pkg-VFS poison and preserves every other key", () => {
    const inst = mkTmp("ml-inst-"); // stands in for a wired HOOKS_DIR
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, {
      numStartups: 7,
      mcpServers: {
        other: { command: "/usr/bin/other", args: ["serve"] },
        meetless: { command: POISON, args: ["mcp"] },
      },
    });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(true);
    expect(res.reason).toBe("healed");
    expect(res.from).toBe(POISON);
    expect(res.to).toBe(HEAL_TARGET);

    const after = readJson(cfg);
    // The meetless command is re-pointed at this binary; args stay canonical.
    expect(after.mcpServers.meetless).toEqual({ command: HEAL_TARGET, args: ["mcp"] });
    // Untouched keys survive the read-merge-write.
    expect(after.numStartups).toBe(7);
    expect(after.mcpServers.other).toEqual({ command: "/usr/bin/other", args: ["serve"] });
    // Stamp written, naming BUILD_B, so the next run is a hot no-op.
    expect(fs.readFileSync(path.join(inst, STAMP), "utf8").trim()).toBe(STAMP_B);
  });

  it("heals a stale/moved absolute path (not a snapshot, just gone)", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    const stale = path.join(dir, "old", "bin", "mla"); // absolute, does not exist
    writeJson(cfg, { mcpServers: { meetless: { command: stale, args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(true);
    expect(res.reason).toBe("healed");
    expect(readJson(cfg).mcpServers.meetless.command).toBe(HEAL_TARGET);
  });

  it("leaves a HEALTHY absolute command untouched (records the stamp, no rewrite)", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    const good = goodBinary(dir);
    writeJson(cfg, { mcpServers: { meetless: { command: good, args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("healthy");
    expect(res.from).toBe(good);
    expect(readJson(cfg).mcpServers.meetless.command).toBe(good);
    expect(fs.readFileSync(path.join(inst, STAMP), "utf8").trim()).toBe(STAMP_B);
  });

  it("leaves a bare-name command alone (PATH-resolved at spawn; never absolutized)", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: "mla", args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("healthy");
    expect(readJson(cfg).mcpServers.meetless.command).toBe("mla");
  });

  it("is a cheap no-op when the stamp already names the running binary (no parse, no repair)", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    // Poisoned, but the stamp already names BUILD_A: the gate short-circuits before
    // any claude.json parse, so the poison stays until the NEXT binary change.
    writeJson(cfg, { mcpServers: { meetless: { command: POISON, args: ["mcp"] } } });
    fs.writeFileSync(path.join(inst, STAMP), STAMP_A + "\n");

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_A,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("current");
    expect(readJson(cfg).mcpServers.meetless.command).toBe(POISON);
  });

  it("never creates the entry from absence (that is init/rewire, not heal)", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { other: { command: "/usr/bin/other", args: ["x"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("no-entry");
    expect(readJson(cfg).mcpServers.meetless).toBeUndefined();
    // Stamped so we do not re-parse claude.json every command.
    expect(fs.readFileSync(path.join(inst, STAMP), "utf8").trim()).toBe(STAMP_B);
  });

  it("is idempotent: a second call after a heal is a hot no-op", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: POISON, args: ["mcp"] } } });
    const opts = { buildInfo: BUILD_B, stampDir: inst, claudeJsonPath: cfg, mlaPath: HEAL_TARGET, env: {} };

    const first = maybeHealMcpCommand(opts);
    const second = maybeHealMcpCommand(opts);

    expect(first.ran).toBe(true);
    expect(first.reason).toBe("healed");
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("current");
  });

  it("stamps (and does not thrash) on an unparseable claude.json it cannot repair", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    fs.writeFileSync(cfg, "{ this is not json ");

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("unparseable-claude-json");
    // File left byte-identical; stamped so a huge broken file is not re-parsed per hook.
    expect(fs.readFileSync(cfg, "utf8")).toBe("{ this is not json ");
    expect(fs.existsSync(path.join(inst, STAMP))).toBe(true);
  });

  it("kill switch disables the self-heal and leaves the poison in place", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: POISON, args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: { MLA_DISABLE_MCP_HEAL: "1" },
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(readJson(cfg).mcpServers.meetless.command).toBe(POISON);
    expect(fs.existsSync(path.join(inst, STAMP))).toBe(false);
  });

  it("skips an unbuilt dev binary", () => {
    const inst = mkTmp("ml-inst-");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: POISON, args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: { ...BUILD_B, sha: "dev" },
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("dev-build");
    expect(readJson(cfg).mcpServers.meetless.command).toBe(POISON);
  });

  it("skips a machine that was never wired (no hooks dir to stamp into)", () => {
    const inst = path.join(mkTmp("ml-parent-"), "hooks-does-not-exist");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: POISON, args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("not-wired");
    expect(fs.existsSync(inst)).toBe(false);
  });

  it("skips when there is no ~/.claude.json at all", () => {
    const inst = mkTmp("ml-inst-");
    const cfg = path.join(mkTmp("ml-cfg-"), ".claude.json"); // never created

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: inst,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("no-claude-json");
  });

  it("never throws and reports the error reason when the stamp dir is unwritable", () => {
    // stampDir is a FILE, so existsSync passes the wired guard but the stamp write
    // (ENOTDIR) fails; the function must swallow it and fall open.
    const parent = mkTmp("ml-parent-");
    const instFile = path.join(parent, "hooks-is-a-file");
    fs.writeFileSync(instFile, "not a dir\n");
    const dir = mkTmp("ml-cfg-");
    const cfg = path.join(dir, ".claude.json");
    writeJson(cfg, { mcpServers: { meetless: { command: goodBinary(dir), args: ["mcp"] } } });

    const res = maybeHealMcpCommand({
      buildInfo: BUILD_B,
      stampDir: instFile,
      claudeJsonPath: cfg,
      mlaPath: HEAL_TARGET,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason.startsWith("error:")).toBe(true);
  });

  it("cli.ts wires maybeHealMcpCommand into the bootstrap (guard against silent removal)", () => {
    const cliSrc = fs.readFileSync(path.resolve(__dirname, "../../src/cli.ts"), "utf8");
    expect(cliSrc).toContain("maybeHealMcpCommand");
  });
});
