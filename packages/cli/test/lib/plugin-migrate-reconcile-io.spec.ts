import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  defaultReconcileIO,
  inspectLegacyWiring,
  legacyWiringPaths,
  type LegacyWiringInspection,
} from "../../src/connectors/claude-code/plugin-migrate";
import { MANAGED_HOOK_SCRIPTS, HOOKS_DIR, MCP_SERVER_KEY } from "../../src/lib/wire";

// Package root so the ts-node child picks up tsconfig.json; and the absolute,
// extensionless module path so the child's require() resolves the SAME TS source
// this suite imports (ts-node transpiles it on require).
const CLI_PKG_ROOT = path.resolve(__dirname, "../..");
const PLUGIN_MIGRATE_MODULE = path.resolve(__dirname, "../../src/connectors/claude-code/plugin-migrate");

// The restore test spawns a ts-node child that transpiles the full module graph on
// first require and then runs the real runWire; give it headroom over jest's 5s default.
jest.setTimeout(30000);

// Build a settings.json that wires EVERY managed hook, so inspectLegacyWiring reports
// hooksComplete after seeding.
function settingsWithAllManagedHooks(): any {
  const hooks: Record<string, any[]> = {};
  for (const w of MANAGED_HOOK_SCRIPTS) {
    const command = path.join(HOOKS_DIR, w.script);
    (hooks[w.event] ??= []).push({ matcher: "*", hooks: [{ type: "command", command }] });
  }
  return { hooks };
}

// A plain temp dir with no $HOME mutation. removeLegacy is path-injectable
// (defaultReconcileIO threads `paths` into every remover and never calls
// os.homedir()), and the restore test isolates $HOME in a child, not this process.
function withTempDir(fn: (tmp: string) => void) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reconcile-io-"));
  try {
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Run the REAL restore executor inside a FRESH node child whose $HOME is `tmp` (and
// MEETLESS_HOME stripped), set in the child env BEFORE any MLA module is imported. This
// is what makes the test robust against import-time os.homedir() capture: even a module
// that froze the home dir at load time saw `tmp`, so a restore provably cannot escape
// onto the operator's home. Returns the child's post-restore self-report ({ home, insp }).
function restoreInChildHome(tmp: string): { home: string; insp: LegacyWiringInspection } {
  const outPath = path.join(tmp, "restore-report.json");
  const runnerPath = path.join(tmp, "runner.cjs");
  // A .cjs entry is plain CJS; the `-r ts-node/register/transpile-only` preload
  // installs a require('.ts') hook, so require(absPath) transpiles the source module
  // on demand. transpile-only skips type-checking the generated runner.
  fs.writeFileSync(
    runnerPath,
    [
      "const os = require('os');",
      "const fs = require('fs');",
      `const m = require(${JSON.stringify(PLUGIN_MIGRATE_MODULE)});`,
      "const paths = m.legacyWiringPaths(os.homedir());",
      "m.defaultReconcileIO(paths).restoreLegacy();",
      "const insp = m.inspectLegacyWiring(paths);",
      `fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ home: os.homedir(), insp }));`,
      "",
    ].join("\n"),
  );
  // Strip MEETLESS_HOME as well as overriding HOME. HOOKS_DIR (config.ts) resolves from
  // `process.env.MEETLESS_HOME || os.homedir()/.meetless`, so an operator with
  // MEETLESS_HOME ambiently exported would otherwise have the child's runWire write real
  // hook scripts into their actual $MEETLESS_HOME/hooks. The read-back stays self-consistent
  // on that same frozen HOOKS_DIR, so the leak would pass silently. Deleting it forces the
  // tmp-rooted os.homedir() default, matching every other surface this test isolates.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, TS_NODE_TRANSPILE_ONLY: "1" };
  delete childEnv.MEETLESS_HOME;
  execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", runnerPath], {
    cwd: CLI_PKG_ROOT, // ts-node resolves tsconfig.json from here
    env: childEnv,
    stdio: ["ignore", "ignore", "inherit"], // surface child stderr if it throws
  });
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

describe("defaultReconcileIO real executor (Blocker 4)", () => {
  it("removeLegacy tears out all four real surfaces (in-process, path-injectable)", () => {
    withTempDir((tmp) => {
      const paths = legacyWiringPaths(tmp);
      fs.mkdirSync(path.dirname(paths.settingsPath), { recursive: true });
      fs.writeFileSync(
        paths.settingsPath,
        JSON.stringify(settingsWithAllManagedHooks(), null, 2),
      );
      fs.writeFileSync(
        paths.claudeJsonPath,
        JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: { command: "mla", args: ["mcp"] } } }),
      );
      for (const name of ["mla", "mla-onboard"]) {
        fs.mkdirSync(path.join(paths.skillsDir, name), { recursive: true });
        fs.writeFileSync(path.join(paths.skillsDir, name, "SKILL.md"), "# skill\n");
      }
      fs.mkdirSync(paths.agentsDir, { recursive: true });
      for (const f of ["meetless-doc-scout.md", "meetless-history-scout.md"]) {
        fs.writeFileSync(path.join(paths.agentsDir, f), "---\n");
      }
      const before = inspectLegacyWiring(paths);
      // Both hooks, a global MCP entry, BOTH skills, and BOTH agents seeded => every
      // *Complete flag holds; this is a full legacy surface about to be torn out.
      expect(
        before.hooksComplete &&
          before.globalMcpPresent &&
          before.mcpAny &&
          before.skillsComplete &&
          before.agentsComplete,
      ).toBe(true);

      const r = defaultReconcileIO(paths).removeLegacy();
      expect(r.changed).toBe(true);

      const after = inspectLegacyWiring(paths);
      expect(after.hooksAny).toBe(false);
      expect(after.mcpAny).toBe(false);
      expect(after.globalMcpPresent).toBe(false);
      expect(after.skillsAny).toBe(false);
      expect(after.agentsAny).toBe(false);
    });
  });

  it("restoreLegacy wires all four surfaces INTO the child's $HOME, never the operator's", () => {
    withTempDir((tmp) => {
      // Clean home, nothing seeded: the real runWire is about to wire it from scratch.
      // Inspected in-process via the path-injectable reader (no $HOME needed here).
      expect(inspectLegacyWiring(legacyWiringPaths(tmp)).hooksAny).toBe(false);

      const report = restoreInChildHome(tmp);

      // The child resolved os.homedir() to the injected tmp (proves $HOME won BEFORE
      // import, so a restore is unredirectable onto the operator's home), and runWire
      // wired all four GLOBAL surfaces there.
      expect(report.home).toBe(tmp);
      expect(report.insp.hooksComplete).toBe(true);
      expect(report.insp.globalMcpPresent).toBe(true);
      expect(report.insp.skillsAny).toBe(true);
      expect(report.insp.agentsAny).toBe(true);
    });
  });
});
