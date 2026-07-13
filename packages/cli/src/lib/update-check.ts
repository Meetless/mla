// Update notifier, copied from gh's model: a background version check on a 24h
// throttle plus an install-method-aware upgrade nag. Two rules, both deliberate:
//
//   1. NEVER auto-apply. We detect how `mla` was installed and print the right
//      upgrade command; we never rename a binary over a brew/npm-managed path
//      (that corrupts their metadata). Detect-and-redirect, not self-replace.
//   2. NEVER block or spam. The fetch runs in a detached child so the parent
//      exits instantly; the nag shows only on a real TTY, off CI, and honors
//      MLA_NO_UPDATE_NOTIFIER.
//
// This file is the PURE core (throttle, version compare, install-method
// detection, nag text). The IO wrappers (spawn the child, fetch GitHub, read/
// write the cache) live in update-notifier.ts so this stays unit-testable.
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as crypto from "crypto";

export type InstallMethod = "homebrew" | "curl" | "npm" | "unknown";

// A binary the background check has already downloaded, verified, and parked
// under ~/.meetless/staged/, ready for apply-on-launch to promote with a cheap
// local swap (no network on the hot path). One staged binary at a time (D4).
export interface StagedUpgrade {
  // bare target version (e.g. "0.4.2").
  version: string;
  // release triple the staged binary was built for; promotion refuses a triple
  // mismatch so a moved ~/.meetless can never swap in the wrong-arch binary.
  triple: string;
  // sha256 of the staged binary file, re-verified at promote time.
  sha256: string;
  // absolute path to the staged binary file.
  path: string;
  // epoch ms the binary was staged (for staleness / observability).
  stagedAt: number;
}

export interface UpdateState {
  // epoch ms of the last completed background check (0 if never).
  lastCheckedAt: number;
  // latest version string seen from the release feed (bare, no leading v).
  latestVersion: string | null;
  // minimum supported version from the signed manifest (bare). Clients below it
  // get the stronger "required" nag. Optional so pre-manifest caches still parse.
  minVersion?: string | null;
  // a verified, ready-to-promote binary parked by the background stager. Optional
  // and omitted when absent, so the on-disk cache stays backward compatible.
  staged?: StagedUpgrade | null;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h, gh's cadence
export const UPDATE_STATE_FILE = "update-check.json";
// Where the update check learns the latest published version: a plaintext file
// on the public meetless-public bucket holding the bare version (e.g. "0.4.2"),
// written by the release pipeline next to the binaries. The GCS bucket is the
// canonical release host, so the nag and the installer agree on the same
// source. Override with MLA_UPDATE_URL.
export const DEFAULT_UPDATE_URL =
  "https://storage.googleapis.com/meetless-public/cli/releases/latest/VERSION";

// --- signed release manifest -------------------------------------------------

// The signed manifest is the source of truth the upgrade path reads: the latest
// version, the floor below which a client is forced to upgrade, and a per-triple
// {url, sha256} so a client can download and verify the exact bytes for its own
// platform. It is fetched alongside a detached Ed25519 signature (manifest.json
// .sig) so a tampered manifest is rejected before any byte is trusted.
//
// Hosted on the same public bucket as the binaries so the installer, the cask,
// and the upgrade path all agree on one release host. The bucket can later sit
// behind the meetless.ai load balancer with zero code change (override the URL).
export const DEFAULT_MANIFEST_URL =
  "https://storage.googleapis.com/meetless-public/cli/releases/latest/manifest.json";

// The three triples we publish. Hard invariants: install.sh, the Homebrew cask,
// and this list MUST stay byte-identical or a platform silently loses upgrades.
export const RELEASE_TRIPLES = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
] as const;
export type ReleaseTriple = (typeof RELEASE_TRIPLES)[number];

export interface ManifestArtifact {
  // absolute https URL (http allowed only for loopback, for local eval).
  url: string;
  // sha256 of the .tar.gz archive at `url` (64 lowercase hex chars).
  sha256: string;
}

export interface Manifest {
  schemaVersion: 1;
  channel: string;
  version: string; // bare, no leading v
  minVersion: string; // bare; clients below this are force-nagged
  releasedAt: string; // ISO 8601
  notes?: string;
  artifacts: Record<string, ManifestArtifact>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const BARE_SEMVER_RE = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;

// Allow https anywhere; allow http ONLY for loopback hosts. Loopback can't be
// MITM'd, which is exactly what the local eval server needs, and a real release
// URL is always https so production never downgrades the transport.
function isAllowedArtifactUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === "https:") return true;
    if (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Parse + validate a manifest's JSON text. Returns null on ANY shape violation
// (wrong schemaVersion, bad semver, non-hex sha, disallowed url, empty artifact
// set) so a malformed or truncated manifest is treated as "no update", never
// acted on. Pure: callers verify the signature over the raw bytes first.
export function parseManifest(raw: string | null | undefined): Manifest | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  if (o.schemaVersion !== 1) return null;
  if (typeof o.channel !== "string" || !o.channel) return null;
  if (typeof o.version !== "string" || !BARE_SEMVER_RE.test(o.version)) return null;
  if (typeof o.minVersion !== "string" || !BARE_SEMVER_RE.test(o.minVersion)) return null;
  if (typeof o.releasedAt !== "string" || !o.releasedAt) return null;
  if (!o.artifacts || typeof o.artifacts !== "object") return null;

  const artifacts: Record<string, ManifestArtifact> = {};
  for (const [triple, a] of Object.entries(o.artifacts as Record<string, unknown>)) {
    if (!a || typeof a !== "object") return null;
    const url = (a as Record<string, unknown>).url;
    const sha256 = (a as Record<string, unknown>).sha256;
    if (typeof url !== "string" || !isAllowedArtifactUrl(url)) return null;
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return null;
    artifacts[triple] = { url, sha256 };
  }
  if (Object.keys(artifacts).length === 0) return null;

  const m: Manifest = {
    schemaVersion: 1,
    channel: o.channel,
    version: o.version,
    minVersion: o.minVersion,
    releasedAt: o.releasedAt,
    artifacts,
  };
  if (typeof o.notes === "string") m.notes = o.notes;
  return m;
}

// Verify a detached Ed25519 signature over the EXACT manifest bytes against a
// trust list of SPKI PEM public keys. True iff any key verifies (so the prod key
// and a rotation key can be trusted at once). Ed25519 takes a null algorithm in
// Node's crypto (the hash is intrinsic). A malformed key or signature returns
// false, never throws: an unverifiable manifest is simply not trusted.
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureB64: string,
  publicKeysPem: string[],
): boolean {
  if (!signatureB64 || publicKeysPem.length === 0) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64.trim(), "base64");
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  for (const pem of publicKeysPem) {
    if (!pem || !pem.trim()) continue;
    try {
      const key = crypto.createPublicKey(pem);
      if (crypto.verify(null, manifestBytes, key, sig)) return true;
    } catch {
      // a bad key in the trust list is skipped, not fatal
    }
  }
  return false;
}

// Map this process's platform/arch to a release triple, or null if unsupported
// (e.g. win32, or linux-arm64 which we do not publish). Mirrors install.sh's
// detect_target so the upgrade path picks the same artifact the installer would.
export function currentTriple(platform: NodeJS.Platform, arch: string): ReleaseTriple | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    return null;
  }
  return null;
}

export function selectArtifact(manifest: Manifest, triple: string | null): ManifestArtifact | null {
  if (!triple) return null;
  return manifest.artifacts[triple] ?? null;
}

// True iff `current` is strictly below `minVersion` (the forced-upgrade floor).
// Reuses the dev-build-safe comparison: an unparseable current is never "below".
export function isBelowMinVersion(current: string | null, minVersion: string | null): boolean {
  return isNewerVersion(minVersion, current);
}

// --- version comparison ------------------------------------------------------

// Parse "1.2.3" / "v1.2.3" / "1.2.3-dirty" / "abc123-dirty" into [major,minor,
// patch], or null if it has no clean numeric core. Build suffixes (a git sha,
// "-dirty", "+meta") are ignored: a dev build like "b6a81f7a-dirty" has no
// semver and must never be compared as if it were behind or ahead.
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// True iff `latest` is strictly newer than `current`. If either side has no
// parseable semver (e.g. a dev `<sha>-dirty` build), return false: we never nag
// someone whose version we can't reason about.
export function isNewerVersion(latest: string | null, current: string | null): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// --- environment gating ------------------------------------------------------

// Standard CI markers. The notifier is pointless (and noisy in logs) on CI.
export function isCI(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CI ||
      env.CONTINUOUS_INTEGRATION ||
      env.GITHUB_ACTIONS ||
      env.GITLAB_CI ||
      env.BUILDKITE ||
      env.CIRCLECI ||
      env.TEAMCITY_VERSION,
  );
}

// Shared env-flag truthiness: unset / "" / "0" / "false" is off, anything else
// (1, yes, true, ...) is on. One definition so every opt-out reads the same way.
function envTruthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false";
}

// The user-facing opt-out (gh uses GH_NO_UPDATE_NOTIFIER; we mirror it).
export function notifierDisabled(env: NodeJS.ProcessEnv): boolean {
  return envTruthy(env.MLA_NO_UPDATE_NOTIFIER);
}

// --- upgrade opt-out precedence ----------------------------------------------

// The total kill switch. When set, the binary does NO self-management at all:
// no background check, no nag, no staging, no apply-on-launch, and even an
// explicit `mla upgrade` refuses. For locked-down / managed environments that
// want the binary to never modify itself or phone home about versions.
export function upgradeKillSwitch(env: NodeJS.ProcessEnv): boolean {
  return envTruthy(env.MLA_DISABLE_UPGRADE);
}

// Disable only the automatic self-replace (background staging + apply-on-launch).
// The check and the nag still run, and explicit `mla upgrade` still works; the
// binary just never swaps itself without the user typing the command.
export function autoUpgradeDisabled(env: NodeJS.ProcessEnv): boolean {
  return envTruthy(env.MLA_DISABLE_AUTO_UPGRADE);
}

// Whether the binary may replace itself unattended (stage in the background and
// promote on launch). Precedence, highest first:
//   MLA_DISABLE_UPGRADE > MLA_DISABLE_AUTO_UPGRADE > MLA_NO_UPDATE_NOTIFIER
//   > config.update.autoApply (defaults ON via readUpdateConfig; only an explicit
//     `autoApply: false` opts out). A raw `undefined` here still fails safe to
//   false: the default-ON decision lives in readUpdateConfig, which always feeds a
//   resolved boolean, so this layer stays a pure kill-switch gate.
export function resolveAutoApply(opts: {
  env: NodeJS.ProcessEnv;
  configAutoApply: boolean | undefined;
}): boolean {
  const { env, configAutoApply } = opts;
  if (upgradeKillSwitch(env)) return false;
  if (autoUpgradeDisabled(env)) return false;
  if (notifierDisabled(env)) return false;
  return configAutoApply === true;
}

// --- throttle ----------------------------------------------------------------

// Should the background fetch run? Only when notifications could ever be shown
// (not disabled, not CI) AND the throttle window has elapsed. Gating the fetch
// here means a disabled notifier makes zero network calls.
export function shouldRunCheck(opts: {
  state: UpdateState;
  now: number;
  env: NodeJS.ProcessEnv;
}): boolean {
  const { state, now, env } = opts;
  if (upgradeKillSwitch(env) || notifierDisabled(env) || isCI(env)) return false;
  return now - state.lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

// --- nag display gating ------------------------------------------------------

// Should we print the upgrade nag now? Requires a cached newer version, an
// interactive session (both stdout and stderr are TTYs, so piping `mla ... |`
// stays clean), off CI, and not opted out.
export function shouldShowNag(opts: {
  state: UpdateState;
  currentVersion: string | null;
  env: NodeJS.ProcessEnv;
  stdoutTTY: boolean;
  stderrTTY: boolean;
}): boolean {
  const { state, currentVersion, env, stdoutTTY, stderrTTY } = opts;
  if (notifierDisabled(env) || isCI(env)) return false;
  if (!stdoutTTY || !stderrTTY) return false;
  return isNewerVersion(state.latestVersion, currentVersion);
}

// --- install-method detection ------------------------------------------------

// Detect how this `mla` was installed so the nag prints the command that
// actually works. We check both the running binary path (pkg build) and the
// script path (node + cli.js for source/npm), because which one is meaningful
// depends on the install:
//   - curl|sh    -> binary lives under ~/.meetless/bin
//   - homebrew   -> path under a brew prefix or a Caskroom dir
//   - npm        -> path under a node_modules tree
// MLA_INSTALL_METHOD overrides everything (an explicit escape hatch + the test seam).
export function detectInstallMethod(opts: {
  execPath: string;
  scriptPath: string | undefined;
  home?: string;
  env: NodeJS.ProcessEnv;
  brewPrefixes?: string[];
}): InstallMethod {
  const { execPath, scriptPath, env } = opts;
  const override = (env.MLA_INSTALL_METHOD || "").trim().toLowerCase();
  if (override === "homebrew" || override === "curl" || override === "npm" || override === "unknown") {
    return override;
  }

  // Canonicalize both sides before comparing. Node realpaths `process.execPath` but
  // NOT `os.homedir()`, so on any box whose home reaches through a symlink the two
  // are spelled differently and containment silently fails -> "unknown" -> `mla
  // upgrade` refuses to run. macOS makes this routine: a $HOME under TMPDIR is
  // /var/folders/... which is really /private/var/folders/.... Non-existent paths
  // (the test seam passes fabricated ones) realpath-throw; fall back to the literal.
  const canon = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };

  const home = canon(opts.home ?? os.homedir());
  const brewPrefixes = (opts.brewPrefixes ?? ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"]).map(canon);
  const candidates = [execPath, scriptPath].filter((p): p is string => Boolean(p)).map(canon);

  const within = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  // curl|sh install dir wins first: it is the most specific and unambiguous.
  const curlDir = path.join(home, ".meetless", "bin");
  if (candidates.some((c) => within(c, curlDir))) return "curl";

  // Homebrew: a Caskroom path, or anything under a brew prefix.
  if (candidates.some((c) => c.includes(`${path.sep}Caskroom${path.sep}`))) return "homebrew";
  if (candidates.some((c) => brewPrefixes.some((p) => within(c, p)))) return "homebrew";

  // npm global / npx: served out of a node_modules tree.
  if (candidates.some((c) => c.includes(`${path.sep}node_modules${path.sep}`))) return "npm";

  return "unknown";
}

// The upgrade command to print for each install method.
export function upgradeCommandFor(method: InstallMethod): string {
  switch (method) {
    case "homebrew":
      return "brew upgrade --cask mla";
    case "curl":
      return "curl -fsSL https://meetless.ai/install.sh | sh";
    case "npm":
      return "npm i -g @meetless/mla@latest";
    case "unknown":
    default:
      // We genuinely don't know how it was installed; send them to the page
      // rather than guess a command that might corrupt a managed install.
      return "see https://meetless.ai/install";
  }
}

// --- nag text ----------------------------------------------------------------

// The two-line nag, gh-style. Kept here so it is asserted in tests verbatim.
export function formatUpdateNag(opts: {
  current: string | null;
  latest: string;
  method: InstallMethod;
  required?: boolean;
}): string {
  const { current, latest, method, required } = opts;
  const from = current ? `${current} ` : "";
  const lead = required
    ? `\nmla ${from}is below the minimum supported version. Please upgrade to ${latest}.\n`
    : `\nA new release of mla is available: ${from}-> ${latest}\n`;
  return lead + `To upgrade, run: ${upgradeCommandFor(method)}\n`;
}

// The line appended to an "unknown command / unknown subcommand" error so an
// operator (or a coding agent driving mla over a pipe) never concludes "mla
// can't do this" when the real cause is a stale binary that predates the verb.
// This is the one moment the TTY-gated update nag never reaches a piped agent,
// so the hint rides the error path instead. Two shapes:
//   - We KNOW a newer version is cached -> name it, and when the current build is
//     below the floor (minVersion) say so with the stronger wording.
//   - We don't know (empty/again-current cache, or an unparseable dev build) -> a
//     soft "may be out of date" pointer. `mla upgrade` is a safe no-op when
//     already current, so nudging it is never wrong. Pure so the copy is asserted
//     verbatim in tests; the cache/version read is the IO wrapper in
//     update-notifier.ts.
export function formatStaleCommandHint(opts: {
  current: string | null;
  latestVersion: string | null;
  minVersion?: string | null;
}): string {
  const { current, latestVersion, minVersion } = opts;
  if (isNewerVersion(latestVersion, current)) {
    const from = current ? `${current} ` : "";
    const lead = isBelowMinVersion(current, minVersion ?? null)
      ? `Your mla ${from}is below the minimum supported version; this command may only exist in a newer release. Please upgrade to ${latestVersion}.`
      : `A newer mla is available (${from}-> ${latestVersion}); this command may only exist there.`;
    return `\n${lead}\nRun 'mla upgrade' to update, then retry.`;
  }
  return `\nIf you expected this command to exist, your mla may be out of date. Run 'mla upgrade' to update, then retry.`;
}

// --- upgrade plan (the `mla upgrade` decision) -------------------------------

export type UpgradeAction =
  | "upgrade" // a strictly newer version is available for this triple
  | "up-to-date" // already on the manifest version
  | "downgrade-blocked" // manifest is OLDER than current; refused without --force
  | "no-artifact" // no artifact published for this triple
  | "unparseable-current"; // running a dev build with no semver; needs --force

export interface UpgradePlan {
  action: UpgradeAction;
  from: string | null;
  to: string;
  triple: string | null;
}

// Decide what `mla upgrade` should do given the current version, the verified
// manifest, this machine's triple, and whether --force was passed. Encapsulates
// the downgrade guard: we never silently move a user to an OLDER build (a stale
// "latest" pointer, a rolled-back release) unless they explicitly force it.
export function planUpgrade(opts: {
  current: string | null;
  manifest: Manifest;
  triple: string | null;
  force: boolean;
}): UpgradePlan {
  const { current, manifest, triple, force } = opts;
  const to = manifest.version;
  if (!triple || !selectArtifact(manifest, triple)) {
    return { action: "no-artifact", from: current, to, triple };
  }
  if (isNewerVersion(to, current)) {
    return { action: "upgrade", from: current, to, triple };
  }
  // Not newer: same version, older, or a current we can't parse.
  if (force) {
    return { action: "upgrade", from: current, to, triple };
  }
  const cur = parseVersion(current);
  const tgt = parseVersion(to); // always parses; manifest.version is validated
  if (!cur) {
    return { action: "unparseable-current", from: current, to, triple };
  }
  if (tgt && cur[0] === tgt[0] && cur[1] === tgt[1] && cur[2] === tgt[2]) {
    return { action: "up-to-date", from: current, to, triple };
  }
  return { action: "downgrade-blocked", from: current, to, triple };
}

// --- state (de)serialization -------------------------------------------------

const EMPTY_STATE: UpdateState = { lastCheckedAt: 0, latestVersion: null };

// Validate a staged-upgrade pointer read back from disk; null if any field is
// missing or the wrong type, so a corrupt staged record is ignored, never acted
// on (apply-on-launch re-verifies the file's sha before promoting regardless).
function parseStaged(v: unknown): StagedUpgrade | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== "string" || typeof o.triple !== "string") return null;
  if (typeof o.sha256 !== "string" || typeof o.path !== "string") return null;
  if (typeof o.stagedAt !== "number") return null;
  return {
    version: o.version,
    triple: o.triple,
    sha256: o.sha256,
    path: o.path,
    stagedAt: o.stagedAt,
  };
}

export function parseState(raw: string | null | undefined): UpdateState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const o = JSON.parse(raw) as Partial<UpdateState> & { staged?: unknown };
    // Base shape only, so a pre-manifest cache deserializes to exactly the two
    // original fields. Optional fields are attached ONLY when present and valid.
    const state: UpdateState = {
      lastCheckedAt: typeof o.lastCheckedAt === "number" ? o.lastCheckedAt : 0,
      latestVersion: typeof o.latestVersion === "string" ? o.latestVersion : null,
    };
    if (typeof o.minVersion === "string") state.minVersion = o.minVersion;
    const staged = parseStaged(o.staged);
    if (staged) state.staged = staged;
    return state;
  } catch {
    // A corrupt cache is treated as "never checked", never fatal.
    return { ...EMPTY_STATE };
  }
}

export function serializeState(state: UpdateState): string {
  return JSON.stringify(state);
}
