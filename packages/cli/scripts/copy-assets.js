#!/usr/bin/env node
// Copy non-TS runtime assets into dist/. tsc only emits compiled .js for .ts
// inputs; it silently skips the shell/jq hook templates the CLI installs at
// `mla init`/`mla rewire`. Without this step a published, dist-only package has
// no hooks-template/ at all, and `locateHooksTemplate()` (src/lib/wire.ts) throws
// "hooks-template directory not found". The dev tree only works today because
// that resolver falls back to ../../src/hooks-template, which is not shipped.
// Run as a build step after tsc, before gen-build-info. Cross-platform (node fs;
// no `cp`). Executable bits are irrelevant here: copyHooks() chmod 0o755s every
// installed .sh on its own, so these templates need no mode preservation.
const fs = require("fs");
const path = require("path");

// Each entry is copied recursively from package-root-relative `from` to
// dist-relative `to`. Add to this list when the CLI gains another shipped asset.
const ASSETS = [{ from: "src/hooks-template", to: "hooks-template" }];

const pkgRoot = path.join(__dirname, "..");
const distRoot = path.join(pkgRoot, "dist");

let total = 0;
for (const asset of ASSETS) {
  const src = path.join(pkgRoot, asset.from);
  const dst = path.join(distRoot, asset.to);
  if (!fs.existsSync(src)) {
    throw new Error(`copy-assets: source not found: ${asset.from}`);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  total += fs.readdirSync(dst).length;
  console.log(`copy-assets: ${asset.from} -> dist/${asset.to}`);
}
console.log(`copy-assets: ${total} file(s) copied`);
