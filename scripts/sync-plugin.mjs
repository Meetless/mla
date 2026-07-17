#!/usr/bin/env node
// sync-plugin.mjs: materialize the Claude Code plugin tree from the CLI source
// as the single source of truth. Run `pnpm plugin:sync` to (re)write it, or
// `pnpm plugin:check` in CI to fail on drift. Deterministic: same CLI source ->
// byte-identical tree. This is an ESM module, but the CLI compiles to CommonJS,
// so the renderers are loaded through createRequire from dist/ (build first).
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url)); // meetless-cli/scripts
const cliRoot = path.join(here, "..", "packages", "cli");
// Compiled roots track the source split: the Claude connector modules compile
// to dist/connectors/claude-code/ (surface, plugin-artifact, hook-contract),
// while the connector-neutral shared modules (enrichment/) stay in dist/lib/.
const distRoot = path.join(cliRoot, "dist");
const connectorDist = path.join(distRoot, "connectors", "claude-code");
const libDist = path.join(distRoot, "lib");

// The plugin manifest carries the REAL semver read from the @meetless/mla release
// package at meetless-cli/packages/cli/package.json (Global Constraints §8): one public
// plugin, no dogfood sentinel and no manifest variant. Read from `cliRoot` (the CLI
// package), NOT from `here/..` (the private workspace-root meetless-cli package, a
// DIFFERENT version that must never be the release source). `cliRoot` is the real CLI
// root even when the DEST roots below are overridden to a temp sandbox, so the version
// never comes from a fixture. renderPluginManifest throws on an empty string, so a
// package.json with no version fails the generator loudly rather than shipping a
// strict-invalid manifest. Per INV-PLUGIN-VERSION-DELIVERY, this version is the
// canonical MLA release version: bumping it here is what delivers a plugin update.
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"),
).version;

const surface = require(path.join(connectorDist, "surface.js"));
const artifact = require(path.join(connectorDist, "plugin-artifact.js"));
const protocol = require(path.join(libDist, "enrichment", "protocol.js"));
const contract = require(path.join(connectorDist, "hook-contract.js"));
const { PLUGIN_SURFACE, renderCliSkill, renderOnboardSkill, renderScoutAgent } = surface;
const {
  renderHookManifest,
  renderPluginManifest,
  renderMarketplaceCatalog,
  renderResolverScript,
} = artifact;
const SCOUT_NAMES = protocol.SCOUT_NAMES;
const MANAGED_HOOK_SCRIPTS = contract.MANAGED_HOOK_SCRIPTS;

// SOURCE stays the real hooks-template (single source of truth). Only the DEST
// roots are overridable via env, so a test can drive the generator against a temp
// sandbox without touching the committed repo tree.
const marketplaceRoot = process.env.MLA_MARKETPLACE_ROOT
  ? path.resolve(process.env.MLA_MARKETPLACE_ROOT)
  : path.join(here, "..");
const pluginRoot = process.env.MLA_PLUGIN_ROOT
  ? path.resolve(process.env.MLA_PLUGIN_ROOT)
  : path.join(marketplaceRoot, "plugin");
const hooksTemplateDir = path.join(cliRoot, "src", "hooks-template");

// Every hook-template file ships in the plugin (13 files). Listed by an EXPLICIT
// allowlist, NOT a readdir: the 9 registered scripts come from MANAGED_HOOK_SCRIPTS
// (the single source of truth the hook manifest is built from), and the 4 support
// files (home.sh, common.sh, flush.sh, event-batch-filter.jq) are the un-registered
// files the registered scripts source at runtime. Explicit so a NEW template file is a
// deliberate addition here, and a MISSING registered file fails the generator loudly
// instead of silently shipping a broken plugin.
//
// home.sh is sourced by common.sh AND, directly, by every self-contained hook (the
// ce0-* family, pre-tool-use.sh): it is the shell-side $HOME repair. Omit it here and
// the plugin ships hooks that source a file that is not there, so `mla` resolves its
// state under the operator's repo again the moment a session inherits a broken $HOME.
const REGISTERED_HOOK_SCRIPTS = [...new Set(MANAGED_HOOK_SCRIPTS.map((w) => w.script))];
const SUPPORT_HOOK_FILES = ["home.sh", "common.sh", "flush.sh", "event-batch-filter.jq"];
const HOOK_TEMPLATE_FILES = [...REGISTERED_HOOK_SCRIPTS, ...SUPPORT_HOOK_FILES].sort();

for (const f of HOOK_TEMPLATE_FILES) {
  if (!fs.existsSync(path.join(hooksTemplateDir, f))) {
    throw new Error(
      `sync-plugin: hook file '${f}' is declared but missing from ${hooksTemplateDir}. ` +
        `Add the template or remove it from MANAGED_HOOK_SCRIPTS/SUPPORT_HOOK_FILES.`,
    );
  }
}

// Build the desired file map: relative-path -> { content, mode }.
// mode 0o755 for executables (resolver, *.sh), 0o644 otherwise.
function desiredFiles() {
  const files = new Map();
  const put = (rel, content, mode = 0o644) => files.set(rel, { content, mode });

  put(
    path.join(".claude-plugin", "plugin.json"),
    renderPluginManifest(PLUGIN_VERSION),
  );
  // Skills: dir basenames are fixed (cli, onboard). BOTH bodies render with
  // PLUGIN_SURFACE (Blocker 1): its `mlaCommand` routes every executable `mla`
  // through the bundled resolver by absolute ${CLAUDE_PLUGIN_ROOT} path. Claude Code
  // adds only the plugin's bin/ (never scripts/) to the Bash tool PATH and a GUI
  // launch has no operator login PATH, so a bare `mla` here would fail; the earlier
  // "hooks put mla on PATH" assumption was wrong. Hooks resolve `mla` for THEIR OWN
  // spawns via the resolver, but that does nothing for a command Claude types.
  put(path.join("skills", "cli", "SKILL.md"), renderCliSkill(PLUGIN_SURFACE));
  put(path.join("skills", "onboard", "SKILL.md"), renderOnboardSkill(PLUGIN_SURFACE));
  // Agents: file basename == PLUGIN_SURFACE.scoutAgentName[role].
  for (const role of SCOUT_NAMES) {
    const base = PLUGIN_SURFACE.scoutAgentName[role];
    put(path.join("agents", `${base}.md`), renderScoutAgent(role, PLUGIN_SURFACE));
  }
  // Hooks: the generated manifest + every template file copied verbatim.
  put(path.join("hooks", "hooks.json"), renderHookManifest());
  for (const f of HOOK_TEMPLATE_FILES) {
    const content = fs.readFileSync(path.join(hooksTemplateDir, f), "utf8");
    const mode = f.endsWith(".sh") ? 0o755 : 0o644;
    put(path.join("hooks", f), content, mode);
  }
  // Resolver.
  put(path.join("scripts", "resolve-mla"), renderResolverScript(), 0o755);

  return files;
}

// Walk an existing tree and return the set of relative file paths present.
function existingFiles(rootDir) {
  const out = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.add(path.relative(rootDir, abs));
    }
  };
  walk(rootDir);
  return out;
}

function isExecutable(mode) {
  return (mode & 0o111) !== 0;
}

// Compute drift for --check: list of human-readable differences.
function drift(desired) {
  const problems = [];
  // Plugin tree files.
  const present = existingFiles(pluginRoot);
  const wanted = new Set([...desired.keys()]);
  for (const [rel, { content, mode }] of desired) {
    const abs = path.join(pluginRoot, rel);
    if (!fs.existsSync(abs)) {
      problems.push(`missing: plugin/${rel}`);
      continue;
    }
    if (fs.readFileSync(abs, "utf8") !== content) {
      problems.push(`content drift: plugin/${rel}`);
    }
    const actualExec = isExecutable(fs.statSync(abs).mode);
    if (actualExec !== isExecutable(mode)) {
      problems.push(`exec-bit drift: plugin/${rel}`);
    }
  }
  for (const rel of present) {
    if (!wanted.has(rel)) problems.push(`obsolete: plugin/${rel}`);
  }
  // Marketplace catalog. Same `missing:` / `content drift:` prefixes as the plugin
  // tree above so every problem line reads uniformly and callers (tests, CI logs)
  // can key off the class, not just the path.
  const catalogAbs = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  const catalog = renderMarketplaceCatalog();
  if (!fs.existsSync(catalogAbs)) {
    problems.push("missing: .claude-plugin/marketplace.json");
  } else if (fs.readFileSync(catalogAbs, "utf8") !== catalog) {
    problems.push("content drift: .claude-plugin/marketplace.json");
  }
  return problems;
}

function writeAll(desired) {
  // Write/refresh every desired file.
  for (const [rel, { content, mode }] of desired) {
    const abs = path.join(pluginRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    fs.chmodSync(abs, mode);
  }
  // Delete obsolete files (a removed hook script must disappear).
  const wanted = new Set([...desired.keys()]);
  for (const rel of existingFiles(pluginRoot)) {
    if (!wanted.has(rel)) fs.rmSync(path.join(pluginRoot, rel));
  }
  // Prune empty dirs bottom-up.
  const pruneEmpty = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pruneEmpty(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  pruneEmpty(pluginRoot);
  // Marketplace catalog.
  const catalogAbs = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  fs.mkdirSync(path.dirname(catalogAbs), { recursive: true });
  fs.writeFileSync(catalogAbs, renderMarketplaceCatalog());
}

function main() {
  const check = process.argv.includes("--check");
  const desired = desiredFiles();
  if (check) {
    const problems = drift(desired);
    if (problems.length > 0) {
      console.error("plugin artifact is out of sync with the CLI source:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("\nrun `pnpm plugin:sync` and commit the result.");
      process.exit(1);
    }
    console.log("plugin artifact is in sync.");
    return;
  }
  writeAll(desired);
  console.log(`synced plugin artifact -> ${path.relative(process.cwd(), pluginRoot)}`);
}

main();
