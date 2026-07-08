import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const cliRoot = path.join(__dirname, "..", "..");
const meetlessCli = path.join(cliRoot, "..", "..");
// plugin-artifact compiles under dist/connectors/claude-code/ (it moved out of
// dist/lib/ with the Claude connector split); its presence is the build gate.
const pluginArtifactDist = path.join(
  cliRoot,
  "dist",
  "connectors",
  "claude-code",
  "plugin-artifact.js",
);

const hasDist = fs.existsSync(pluginArtifactDist);
const maybe = hasDist ? describe : describe.skip;

maybe("sync-plugin --check", () => {
  let sandbox: string;
  let pluginRoot: string;

  const runEnv = () => ({
    ...process.env,
    MLA_MARKETPLACE_ROOT: sandbox,
    MLA_PLUGIN_ROOT: pluginRoot,
  });
  const sync = (args: string[] = []) =>
    execFileSync("node", ["scripts/sync-plugin.mjs", ...args], {
      cwd: meetlessCli,
      encoding: "utf8",
      env: runEnv(),
    });
  // --check exits 1 on drift; capture code + combined output without throwing.
  const check = (): { code: number; out: string } => {
    try {
      return { code: 0, out: sync(["--check"]) };
    } catch (e: any) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mla-plugin-"));
    pluginRoot = path.join(sandbox, "plugin");
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("reports clean immediately after a sync", () => {
    sync();
    const { code, out } = check();
    expect(code).toBe(0);
    expect(out).toContain("in sync");
  });

  it("detects content drift when a generated file is mutated", () => {
    sync();
    const manifest = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8") + "\n// tampered\n");
    const { code, out } = check();
    expect(code).toBe(1);
    expect(out).toContain("content drift");
  });

  it("detects an obsolete stray file in the tree", () => {
    sync();
    fs.writeFileSync(path.join(pluginRoot, "hooks", "stray.sh"), "#!/bin/sh\n");
    const { code, out } = check();
    expect(code).toBe(1);
    expect(out).toContain("obsolete");
  });

  it("detects a missing generated file", () => {
    sync();
    fs.rmSync(path.join(pluginRoot, "hooks", "hooks.json"));
    const { code, out } = check();
    expect(code).toBe(1);
    expect(out).toContain("missing");
  });

  it("detects an exec-bit flip on the resolver", () => {
    sync();
    // The resolver is written 0o755; strip its exec bits without touching content,
    // so ONLY the exec-bit branch (not content drift) can fire.
    const resolver = path.join(pluginRoot, "scripts", "resolve-mla");
    fs.chmodSync(resolver, 0o644);
    const { code, out } = check();
    expect(code).toBe(1);
    expect(out).toContain("exec-bit drift");
    expect(out).toContain("scripts/resolve-mla");
  });

  it("detects drift in the marketplace catalog outside the plugin tree", () => {
    sync();
    // The catalog lives at MLA_MARKETPLACE_ROOT/.claude-plugin/, a sibling of the
    // plugin tree; its drift branch is separate from the plugin-tree walk.
    const catalog = path.join(sandbox, ".claude-plugin", "marketplace.json");
    fs.writeFileSync(catalog, fs.readFileSync(catalog, "utf8") + "\n// tampered\n");
    const { code, out } = check();
    expect(code).toBe(1);
    expect(out).toContain("content drift: .claude-plugin/marketplace.json");
  });
});
