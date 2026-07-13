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
// - hooks-template: the shell/jq hook templates installed at `mla init`/`mla rewire`.
//
// The docs corpus is deliberately NOT here. It is vendored as a generated .ts module
// (src/lib/docs-corpus.data.ts), so tsc compiles it into dist/lib/ and it ships with
// the code. An asset would have needed three lists (files, this one, pkg.assets) to
// stay in sync forever, and losing it would exit 1 in a user's terminal rather than
// failing the build. See packages/utils/scripts/docs-corpus-artifacts.ts.
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

// Embed the better-sqlite3 native addon so the pkg single-file binary can load
// SQLite. pkg cannot dlopen a `.node` out of its read-only /snapshot VFS, so we
// ship the addon as a pkg asset (package.json "pkg.assets": dist/native/**) and
// materialize it to a real temp file at runtime (src/lib/rules/native-binding.ts).
// Resolve the addon from the RESOLVED better-sqlite3 install (survives pnpm
// version bumps) and copy the build-host's ABI-correct binary. Each release
// target builds on its own native runner, so this is always the right ABI.
// build/Release is better-sqlite3's canonical output; build/ (older prebuild
// layouts) is the fallback.
const bsqlitePkg = path.dirname(require.resolve("better-sqlite3/package.json"));
const nativeCandidates = [
  path.join(bsqlitePkg, "build", "Release", "better_sqlite3.node"),
  path.join(bsqlitePkg, "build", "better_sqlite3.node"),
];
const nativeSrc = nativeCandidates.find((p) => fs.existsSync(p));
if (!nativeSrc) {
  throw new Error(
    `copy-assets: better_sqlite3.node not found (looked in ${nativeCandidates.join(
      ", ",
    )}). Run pnpm install so the addon builds before packaging.`,
  );
}
const nativeDstDir = path.join(distRoot, "native");
fs.rmSync(nativeDstDir, { recursive: true, force: true });
fs.mkdirSync(nativeDstDir, { recursive: true });
fs.copyFileSync(nativeSrc, path.join(nativeDstDir, "better_sqlite3.node"));
total += 1;
console.log(`copy-assets: ${path.relative(pkgRoot, nativeSrc)} -> dist/native/better_sqlite3.node`);

console.log(`copy-assets: ${total} file(s) copied`);
