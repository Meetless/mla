#!/usr/bin/env node
// gen-manifest.js: build the signed-release manifest.json from a directory of
// built artifacts. Pairs with sign-manifest.sh (which produces manifest.json.sig
// over the EXACT bytes this writes). Zero dependencies; runs in CI and locally.
//
// The manifest is the source of truth the mla client repoints to (proposal
// 20260615-mla-version-detection-and-upgrade, section 5.1). Its schema is
// validated client-side by parseManifest() in src/lib/update-check.ts, so this
// generator and that parser must stay in lockstep:
//   - schemaVersion === 1
//   - version / minVersion are bare semver (no leading v)
//   - every artifact url is https (http only for 127.0.0.1 loopback eval)
//   - every artifact sha256 is 64 lowercase hex chars (over the .tar.gz)
//   - artifacts is non-empty
//
// Usage:
//   node scripts/gen-manifest.js \
//     --release-dir <dir with mla-<triple>.tar.gz[.sha256]> \
//     --version 0.5.0 --min-version 0.3.0 --channel stable \
//     --base-url https://storage.googleapis.com/meetless-public/cli/releases/0.5.0 \
//     [--released-at 2026-06-20T00:00:00Z] [--notes "..."] \
//     [--out <dir>]            (default: --release-dir)
//
// Output: <out>/manifest.json
//
// The three published triples (section 8.2). A triple is included only when its
// tarball is present in --release-dir, so a partial matrix still yields a valid
// (smaller) manifest rather than a half-written one with dangling urls.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TRIPLES = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
];

const BARE_SEMVER_RE = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`gen-manifest: error: ${msg}\n`);
  process.exit(1);
}

function sha256OfFile(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

// Resolve a triple's sha256: prefer the sidecar .sha256 (the exact bytes the
// uploader and install.sh read), fall back to hashing the tarball. Cross-check
// when both exist so a stale sidecar can never ship a wrong checksum.
function resolveSha(tarball) {
  const computed = sha256OfFile(tarball);
  const sidecar = `${tarball}.sha256`;
  if (fs.existsSync(sidecar)) {
    const recorded = fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
    if (recorded && recorded.toLowerCase() !== computed) {
      die(
        `sidecar ${path.basename(sidecar)} (${recorded}) disagrees with the ` +
          `tarball hash (${computed}); refusing to ship a wrong checksum`,
      );
    }
    if (recorded) return recorded.toLowerCase();
  }
  return computed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const releaseDir = args["release-dir"];
  const version = args.version;
  const minVersion = args["min-version"];
  const channel = args.channel || "stable";
  const baseUrl = args["base-url"];
  const releasedAt = args["released-at"] || new Date().toISOString();
  const notes = typeof args.notes === "string" ? args.notes : undefined;
  const outDir = args.out || releaseDir;

  if (!releaseDir) die("missing --release-dir");
  if (!version || !BARE_SEMVER_RE.test(version)) die(`--version must be bare semver, got ${version}`);
  if (!minVersion || !BARE_SEMVER_RE.test(minVersion)) die(`--min-version must be bare semver, got ${minVersion}`);
  if (!baseUrl) die("missing --base-url (where the tarballs are hosted)");
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(baseUrl)) {
    die(`--base-url must be https (http allowed only for loopback eval), got ${baseUrl}`);
  }

  const base = baseUrl.replace(/\/+$/, "");
  const artifacts = {};
  for (const triple of TRIPLES) {
    const tarball = path.join(releaseDir, `mla-${triple}.tar.gz`);
    if (!fs.existsSync(tarball)) continue;
    artifacts[triple] = {
      url: `${base}/mla-${triple}.tar.gz`,
      sha256: resolveSha(tarball),
    };
  }
  if (Object.keys(artifacts).length === 0) {
    die(`no mla-<triple>.tar.gz found in ${releaseDir}`);
  }

  const manifest = { schemaVersion: 1, channel, version, minVersion, releasedAt };
  if (notes) manifest.notes = notes;
  manifest.artifacts = artifacts;

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "manifest.json");
  // Compact-but-stable JSON. sign-manifest.sh signs these EXACT bytes and the
  // client verifies over the EXACT bytes it downloads, so the only contract is
  // that what we write here is byte-identical to what gets uploaded. A trailing
  // newline keeps the file tidy without affecting the signed payload (the signer
  // signs the whole file including this newline).
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`gen-manifest: wrote ${outFile}\n`);
  for (const [triple, a] of Object.entries(artifacts)) {
    process.stdout.write(`  ${triple}  ${a.sha256}\n`);
  }
}

main();
