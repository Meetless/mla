#!/usr/bin/env node
// Stamp build provenance into dist/build-info.json so `mla --version` reports
// exactly which commit + when the running binary was built. This is the
// antidote to the stale-dist footgun: the binary's identity stops being a
// hardcoded version string that never moves across builds. Run as the second
// step of `pnpm build`, after tsc has populated dist/.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const pkg = require("../package.json");
const sha = git("rev-parse --short HEAD");
const branch = git("rev-parse --abbrev-ref HEAD");
const dirty = !!git("status --porcelain");

// builtAt is deterministic when SOURCE_DATE_EPOCH is exported (seconds since the
// Unix epoch, the reproducible-builds convention). The npm release packs the tgz
// once, smokes those exact bytes, and publishes them; pinning builtAt to the
// commit time keeps the packed artifact byte-reproducible for the same source so
// a re-pack (or a checksum audit) matches, instead of drifting on wall-clock.
// Unset (local/dev) -> wall-clock now, unchanged. A malformed value falls back.
function resolveBuiltAt() {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw && /^\d+$/.test(raw.trim())) {
    const ms = Number(raw.trim()) * 1000;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

const info = {
  version: pkg.version ?? "0.0.0",
  sha: sha ?? "unknown",
  branch: branch ?? "unknown",
  dirty,
  builtAt: resolveBuiltAt(),
  // Public Sentry DSN baked at build time. Public-by-design: client-side Sentry
  // ships its DSN to every browser/CLI. Production builds set SENTRY_DSN in CI
  // env so the binary auto-enables Sentry on install. Dev builds leave it empty
  // and the CLI honors MLA_SENTRY_DSN env override for local testing.
  sentryDsn: process.env.SENTRY_DSN || "",
  // Ed25519 manifest-verification public key, baked the same way: public-by-
  // design (it only verifies signatures, never signs), set in CI from
  // MLA_UPDATE_PUBLIC_KEY. Empty on dev builds, which honor the runtime override.
  // Accepts a SPKI PEM or a base64-encoded PEM (single-line, env-friendly).
  updatePublicKey: process.env.MLA_UPDATE_PUBLIC_KEY || "",
};

const out = path.join(__dirname, "..", "dist", "build-info.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(info, null, 2) + "\n", "utf8");
console.log(
  `build-info: ${info.version} ${info.sha}${info.dirty ? "-dirty" : ""} @ ${info.builtAt}`,
);
