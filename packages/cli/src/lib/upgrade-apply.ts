// IO layer for the self-upgrade mechanism (proposal 20260615-mla-version-
// detection-and-upgrade). The pure decision logic lives in update-check.ts; this
// file does every side effect the upgrade path needs:
//
//   - cache IO (read/write the update-check.json state file)
//   - resolve the trusted manifest key(s) and the manifest URL
//   - fetch + Ed25519-verify the signed manifest
//   - download an artifact, verify its sha256, extract the `mla` binary
//   - atomically swap the live binary (keeping one mla.prev for rollback, D4)
//   - take a single-writer lock so two upgrades never race
//   - stage a verified binary in the background and promote it on launch (D3)
//   - re-exec the freshly-promoted binary with a loop guard
//   - the `mla upgrade` command handler
//
// Every entry point is defensive: an upgrade failure must NEVER brick the CLI.
// On any error the live binary is left untouched (or rolled back) and the caller
// continues running the version it already had. Self-replace happens ONLY for
// the curl install method; brew/npm/unknown are redirected to their package
// manager (renaming over a managed path corrupts that manager's metadata).
import { execFileSync, spawnSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { HOME, readUpdateConfig } from "./config";
import { loadBuildInfo, type BuildInfo } from "./observability";
import {
  DEFAULT_MANIFEST_URL,
  UPDATE_STATE_FILE,
  currentTriple,
  detectInstallMethod,
  parseManifest,
  parseState,
  planUpgrade,
  resolveAutoApply,
  selectArtifact,
  serializeState,
  upgradeCommandFor,
  upgradeKillSwitch,
  verifyManifestSignature,
  type Manifest,
  type ManifestArtifact,
  type StagedUpgrade,
  type UpdateState,
} from "./update-check";

// --- cache IO (moved here from update-notifier so the upgrade path and the nag
//     share one reader/writer with no import cycle) -------------------------

export function stateFilePath(): string {
  return path.join(HOME, UPDATE_STATE_FILE);
}

export function readUpdateState(): UpdateState {
  try {
    return parseState(fs.readFileSync(stateFilePath(), "utf8"));
  } catch {
    return parseState(null);
  }
}

export function writeUpdateState(state: UpdateState): void {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(stateFilePath(), serializeState(state), "utf8");
  } catch {
    // best-effort; a read-only HOME just means we re-check next time.
  }
}

// Persist the latest published version + minimum-supported floor learned from a
// freshly VERIFIED manifest into the update cache. The passive nag reads ONLY the
// cache; a foreground `mla upgrade [--check]` fetches the manifest LIVE. Without
// this, the two disagree: `--check` can see a new release while the throttled
// background check leaves the cache stale, so the nag never fires (it has nothing
// newer to report). Stamping here makes any foreground upgrade path refresh the
// cache as a side effect, so the manual and passive surfaces always agree.
//
// Preserves lastCheckedAt (the background-check throttle is a separate concern)
// and any staged binary. Best-effort: a cache write must never fail an otherwise
// successful upgrade command.
export function stampLatestFromManifest(manifest: Manifest): void {
  try {
    const prev = readUpdateState();
    writeUpdateState({
      ...prev,
      latestVersion: manifest.version,
      minVersion: manifest.minVersion,
    });
  } catch {
    // never let a cache write break `mla upgrade`
  }
}

// --- filesystem layout -------------------------------------------------------

// The curl install puts the binary here (install.sh: $HOME/.meetless/bin/mla),
// as a plain file (no symlink), so rename(2) over this path atomically swaps the
// inode. HOME honors MEETLESS_HOME, so a throwaway home makes eval hermetic.
export function liveBinaryPath(): string {
  return path.join(HOME, "bin", "mla");
}

// The single rollback slot (D4: keep exactly one previous binary).
export function prevBinaryPath(): string {
  return path.join(HOME, "bin", "mla.prev");
}

// Where the background stager parks a verified, ready-to-promote binary so the
// hot path (apply-on-launch) only does a cheap local rename, never a network call.
export function stagedDir(): string {
  return path.join(HOME, "staged");
}

export function stagedBinaryPath(): string {
  return path.join(stagedDir(), "mla");
}

function lockPath(): string {
  return path.join(HOME, "upgrade.lock");
}

// --- trust + url resolution (dev-gated overrides) ----------------------------

// A baked key may be a raw SPKI PEM or a single-line base64-of-PEM (env-friendly
// for CI). Normalize either into PEM text; return "" if it is neither.
function normalizeKeyPem(raw: string | undefined): string {
  const v = (raw || "").trim();
  if (!v) return "";
  if (v.includes("-----BEGIN")) return v;
  // Try base64-of-PEM. A bad decode that does not yield a PEM is rejected.
  try {
    const decoded = Buffer.from(v, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    // fall through
  }
  return "";
}

// The trusted Ed25519 public key(s) the manifest signature is checked against.
// Production trusts ONLY the key baked into the binary (buildInfo.updatePublicKey).
// On a dev build (buildInfo.dirty) the MLA_UPDATE_PUBLIC_KEY env override is also
// honored, so local eval can sign with a throwaway key. This mirrors the
// sentryDsn dev-gating in observability.ts: never let a runtime env var weaken a
// release binary's trust root.
export function trustedManifestKeys(opts: {
  env: NodeJS.ProcessEnv;
  buildInfo: BuildInfo;
}): string[] {
  const { env, buildInfo } = opts;
  const keys: string[] = [];
  const baked = normalizeKeyPem(buildInfo.updatePublicKey);
  if (baked) keys.push(baked);
  if (buildInfo.dirty) {
    const override = normalizeKeyPem(env.MLA_UPDATE_PUBLIC_KEY);
    if (override) keys.push(override);
  }
  return keys;
}

// The manifest URL. Defaults to the public bucket; a dev build honors the
// MLA_UPDATE_MANIFEST_URL override so eval can point at a 127.0.0.1 server.
export function resolveManifestUrl(opts: {
  env: NodeJS.ProcessEnv;
  buildInfo: BuildInfo;
}): string {
  const { env, buildInfo } = opts;
  if (buildInfo.dirty && env.MLA_UPDATE_MANIFEST_URL) {
    return env.MLA_UPDATE_MANIFEST_URL;
  }
  return DEFAULT_MANIFEST_URL;
}

// --- manifest fetch + verify -------------------------------------------------

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mla-upgrade" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifiedManifest {
  manifest: Manifest;
  // the exact bytes the signature was verified over (for observability).
  bytes: Buffer;
}

// Fetch manifest.json + manifest.json.sig, verify the detached Ed25519 signature
// over the EXACT manifest bytes against the trust list, then parse+validate.
// Returns null on ANY failure (offline, http error, bad signature, malformed
// manifest) so the caller treats it as "no update", never acting on unverified
// or untrusted bytes. The signature is checked over the raw bytes BEFORE parsing.
export async function fetchManifest(opts: {
  env?: NodeJS.ProcessEnv;
  buildInfo?: BuildInfo;
  timeoutMs?: number;
}): Promise<VerifiedManifest | null> {
  const env = opts.env ?? process.env;
  const buildInfo = opts.buildInfo ?? loadBuildInfo();
  const timeoutMs = opts.timeoutMs ?? 5000;

  const url = resolveManifestUrl({ env, buildInfo });
  const sigUrl = url.endsWith(".json") ? url.slice(0, -5) + ".json.sig" : url + ".sig";

  const [bytes, sigBytes] = await Promise.all([
    fetchBytes(url, timeoutMs),
    fetchBytes(sigUrl, timeoutMs),
  ]);
  if (!bytes || !sigBytes) return null;

  const keys = trustedManifestKeys({ env, buildInfo });
  if (keys.length === 0) return null; // no trust root: refuse rather than trust blindly
  const signatureB64 = sigBytes.toString("utf8").trim();
  if (!verifyManifestSignature(bytes, signatureB64, keys)) return null;

  const manifest = parseManifest(bytes.toString("utf8"));
  if (!manifest) return null;
  return { manifest, bytes };
}

// --- artifact download + verify + extract ------------------------------------

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Download the artifact .tar.gz, verify its sha256 against the manifest value,
// extract it, and return the absolute path to the `mla` binary inside (the
// archive carries it at the root, matching install.sh). The caller owns the
// returned temp dir's lifecycle via the `dir` field. Returns null on any
// failure; a sha mismatch is a HARD stop (never extract unverified bytes).
export interface ExtractedBinary {
  binaryPath: string;
  dir: string; // temp dir to clean up after staging/swapping
}

export async function downloadVerifyExtract(opts: {
  artifact: ManifestArtifact;
  timeoutMs?: number;
}): Promise<ExtractedBinary | null> {
  const { artifact } = opts;
  const timeoutMs = opts.timeoutMs ?? 60000;
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-upgrade-"));
    const archive = path.join(dir, "pkg.tar.gz");
    const bytes = await fetchBytes(artifact.url, timeoutMs);
    if (!bytes) {
      cleanupDir(dir);
      return null;
    }
    fs.writeFileSync(archive, bytes);

    const got = sha256File(archive);
    if (got !== artifact.sha256) {
      cleanupDir(dir);
      return null; // tampered or truncated download: refuse
    }

    // tar is present on macOS and Linux; -xzf handles the gzip. Extract into the
    // temp dir and require the binary at the archive root (release-layout invariant).
    execFileSync("tar", ["-xzf", archive, "-C", dir], { stdio: "ignore" });
    const binaryPath = path.join(dir, "mla");
    if (!fs.existsSync(binaryPath)) {
      cleanupDir(dir);
      return null;
    }
    fs.chmodSync(binaryPath, 0o755);
    return { binaryPath, dir };
  } catch {
    if (dir) cleanupDir(dir);
    return null;
  }
}

export function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort temp cleanup
  }
}

// --- atomic swap + rollback --------------------------------------------------

// Atomically replace the live binary with `newBinaryPath`:
//   1. copy the new bytes to mla.new.<pid> IN THE SAME DIR (so rename is on one
//      filesystem and therefore atomic), fsync, chmod 0755.
//   2. copy the current live binary to mla.prev (the single rollback slot, D4).
//   3. rename(2) mla.new.<pid> over the live path. The running process keeps its
//      open inode, so a swap mid-run is safe; the NEXT exec gets the new bytes.
// Returns true on success. Throws nothing the caller cannot recover from: on a
// mid-swap failure the live path is either the old binary (rename not reached)
// or the new one (rename done); mla.prev always holds the prior bytes.
export function atomicSwapBinary(opts: {
  newBinaryPath: string;
  live?: string;
  prev?: string;
}): boolean {
  const live = opts.live ?? liveBinaryPath();
  const prev = opts.prev ?? prevBinaryPath();
  const dir = path.dirname(live);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `mla.new.${process.pid}`);

  // 1. stage the new bytes next to the live path, durably.
  const data = fs.readFileSync(opts.newBinaryPath);
  const fd = fs.openSync(tmp, "w", 0o755);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o755);

  // 2. snapshot the current live binary for rollback (if one exists).
  try {
    if (fs.existsSync(live)) fs.copyFileSync(live, prev);
  } catch {
    // a missing/locked prev slot is not fatal; we still swap.
  }

  // 3. atomic replace.
  fs.renameSync(tmp, live);
  return true;
}

// Restore the previous binary from the rollback slot over the live path. Used
// when a freshly-swapped binary fails its post-swap smoke (so a bad release
// never leaves the user stranded). Returns true if a rollback was performed.
export function rollbackBinary(opts?: { live?: string; prev?: string }): boolean {
  const live = opts?.live ?? liveBinaryPath();
  const prev = opts?.prev ?? prevBinaryPath();
  try {
    if (!fs.existsSync(prev)) return false;
    fs.renameSync(prev, live);
    return true;
  } catch {
    return false;
  }
}

// --- single-writer lock ------------------------------------------------------

const LOCK_STALE_MS = 5 * 60 * 1000; // a lock older than this is presumed abandoned

// Run `fn` while holding an exclusive upgrade lock. Uses O_EXCL create as the
// atomic primitive. If the lock exists but is stale (older than LOCK_STALE_MS),
// it is stolen once. If a live lock is held by another process, returns
// { ran: false } WITHOUT running fn (the other upgrade wins; we never double-swap).
export async function withUpgradeLock<T>(
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const lock = lockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const tryAcquire = (): number | null => {
    try {
      return fs.openSync(lock, "wx"); // O_CREAT | O_EXCL | O_WRONLY
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw e;
    }
  };

  let fd = tryAcquire();
  if (fd === null) {
    // Steal a stale lock exactly once.
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        fd = tryAcquire();
      }
    } catch {
      // race on stat/unlink: fall through to "held"
    }
  }
  if (fd === null) return { ran: false };

  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    // closing failure is non-fatal; we still own the file and will unlink it.
  }
  try {
    const value = await fn();
    return { ran: true, value };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// --- stage / promote / clear -------------------------------------------------

// Copy a verified binary into the staged dir and record a staged pointer in the
// cache. The recorded sha256 is the BINARY's sha (re-verified at promote time),
// not the archive sha (which was already verified during download). Replaces any
// existing staged binary (D4: one at a time). Returns the staged pointer.
export function stageBinary(opts: {
  binaryPath: string;
  version: string;
  triple: string;
  now: number;
}): StagedUpgrade {
  const dir = stagedDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = stagedBinaryPath();
  fs.copyFileSync(opts.binaryPath, dest);
  fs.chmodSync(dest, 0o755);
  const staged: StagedUpgrade = {
    version: opts.version,
    triple: opts.triple,
    sha256: sha256File(dest),
    path: dest,
    stagedAt: opts.now,
  };
  const prev = readUpdateState();
  writeUpdateState({ ...prev, staged });
  return staged;
}

// Drop the staged binary and its cache pointer (after a promote, or when stale).
export function clearStaged(): void {
  try {
    fs.rmSync(stagedDir(), { recursive: true, force: true });
  } catch {
    // best-effort
  }
  const prev = readUpdateState();
  if (prev.staged) writeUpdateState({ ...prev, staged: null });
}

// --- re-exec -----------------------------------------------------------------

export const REEXEC_GUARD_ENV = "MLA_UPGRADE_REEXECED";

// A defined, harmless value for PKG_EXECPATH in the re-exec'd child env. See the
// long comment in reExecAfterUpgrade: it must be non-empty (so pkg's patched
// spawnSync leaves it alone), must NOT equal the child binary's path, and must
// NOT be the magic "PKG_INVOKE_NODEJS" string. Any other constant forces the
// child's pkg bootstrap down the normal app-launch branch.
const PKG_REEXEC_SENTINEL = "MLA_REEXEC";

// Re-run the same command with the freshly-promoted binary. Sets the loop-guard
// env var so the child skips apply-on-launch (otherwise an apply that did not
// actually change the version could re-exec forever). Returns the child's exit
// code; the caller should process.exit with it. Used ONLY after a successful
// apply-on-launch swap, so `live` is the new binary.
export function reExecAfterUpgrade(opts: {
  live?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): number {
  const live = opts.live ?? liveBinaryPath();
  // For a pkg binary process.argv is [binary, snapshotEntry, ...userArgs], so the
  // real user args start at slice(2) (the same slice the main entry parses). We
  // spawn `live` directly; pkg re-injects its own snapshot entry as argv[1] in the
  // child, so passing slice(1) here would leak that path through as the command.
  const args = opts.argv ?? process.argv.slice(2);
  // pkg env interaction (proven empirically against a real pkg binary):
  // pkg patches child_process.spawnSync inside a packaged process. When the
  // spawn env has no PKG_EXECPATH key, the patch INJECTS PKG_EXECPATH = the
  // PARENT's process.execPath. Apply-on-launch re-execs the SAME path (the live
  // binary, post-swap), so the child's process.execPath equals that injected
  // value. pkg's prelude/bootstrap then takes its "run as node script" branch
  // and path.resolve()s our first user arg (e.g. "whoami") as a script file,
  // crashing with "Cannot find module .../whoami". Deleting the key does NOT
  // help (the patch re-injects on undefined). Setting it to a defined sentinel
  // that is neither the binary path nor "PKG_INVOKE_NODEJS" makes the patch
  // leave it alone and the child boots normally into the app. Mirrors the
  // CLAUDECODE env-inheritance lesson: neutralize the inherited launcher var.
  const env = {
    ...(opts.env ?? process.env),
    [REEXEC_GUARD_ENV]: "1",
    PKG_EXECPATH: PKG_REEXEC_SENTINEL,
  };
  const res = spawnSync(live, args, { stdio: "inherit", env });
  if (typeof res.status === "number") return res.status;
  return 1; // killed by signal or failed to spawn: non-zero
}

// --- apply-on-launch ---------------------------------------------------------

export interface PromoteResult {
  reExeced: boolean;
  code?: number;
}

const NO_PROMOTE: PromoteResult = { reExeced: false };

// The apply-on-launch hook, run at the very top of CLI bootstrap. If a verified
// staged binary is present, auto-apply is enabled, and this is a curl install,
// it promotes the staged binary with a cheap local swap and re-execs the command
// with the new binary. Returns { reExeced: true, code } when the caller should
// exit with `code`; otherwise { reExeced: false } and the caller continues
// normally on the current binary. NEVER throws: any failure falls open to the
// running binary (and rolls back a half-applied swap).
export async function maybePromoteStagedAndReExec(opts: {
  command: string | undefined;
  env?: NodeJS.ProcessEnv;
  buildInfo?: BuildInfo;
}): Promise<PromoteResult> {
  try {
    const env = opts.env ?? process.env;
    const buildInfo = opts.buildInfo ?? loadBuildInfo();

    // Loop guard: the re-exec'd child must never re-promote.
    if (env[REEXEC_GUARD_ENV]) return NO_PROMOTE;
    // Never promote under the detached check child, an explicit upgrade, or the
    // long-lived `mla mcp` server. `mcp` is carved out because it is spawned by
    // an editor as a persistent stdio daemon: a launch-time re-exec would fork an
    // extra process layer under the supervisor (one more thing to leak) and the
    // server has its OWN in-band stale-dist self-heal (the worker exits with the
    // restart sentinel and the supervisor respawns on the fresh dist, no re-exec
    // needed). See notes/20260622-mla-mcp-process-leak-findings-and-fix.md (Tier
    // 1 Phase 3).
    if (
      opts.command === "_internal" ||
      opts.command === "upgrade" ||
      opts.command === "mcp"
    ) {
      return NO_PROMOTE;
    }
    // Total kill switch / auto-apply opt-out.
    if (upgradeKillSwitch(env)) return NO_PROMOTE;
    if (!resolveAutoApply({ env, configAutoApply: readUpdateConfig().autoApply })) {
      return NO_PROMOTE;
    }
    // Only curl installs self-replace; brew/npm/unknown are package-manager owned.
    const method = detectInstallMethod({
      execPath: process.execPath,
      scriptPath: process.argv[1],
      env,
    });
    if (method !== "curl") return NO_PROMOTE;

    const state = readUpdateState();
    const staged = state.staged;
    if (!staged) return NO_PROMOTE;

    // Validate the staged pointer against this machine + the running version.
    const triple = currentTriple(process.platform, process.arch);
    if (!triple || staged.triple !== triple) {
      clearStaged();
      return NO_PROMOTE;
    }
    // Re-verify the staged file's bytes before trusting them (defends against a
    // corrupted or partially-written staged file).
    if (!fs.existsSync(staged.path) || sha256File(staged.path) !== staged.sha256) {
      clearStaged();
      return NO_PROMOTE;
    }

    const locked = await withUpgradeLock(async () => {
      atomicSwapBinary({ newBinaryPath: staged.path });
      return true;
    });
    if (!locked.ran) return NO_PROMOTE; // another process is mid-upgrade

    clearStaged();
    const code = reExecAfterUpgrade({ env });
    return { reExeced: true, code };
  } catch {
    // An apply-on-launch failure must never break the command. Try a rollback
    // (best-effort) and fall through to running the current binary.
    try {
      rollbackBinary();
    } catch {
      // ignore
    }
    return NO_PROMOTE;
  }
}

// --- the `mla upgrade` command ----------------------------------------------

export interface UpgradeArgs {
  force: boolean; // allow same-version reinstall / downgrade / dev-build upgrade
  check: boolean; // report only; do not apply
}

export function parseUpgradeArgs(argv: string[]): UpgradeArgs {
  return {
    force: argv.includes("--force") || argv.includes("-f"),
    check: argv.includes("--check") || argv.includes("-n"),
  };
}

type Logger = (line: string) => void;

// `mla upgrade` handler. Returns the process exit code. Explicit, foreground,
// and chatty (unlike the silent background path). Honors the kill switch,
// redirects managed installs to their package manager, enforces the downgrade
// guard via planUpgrade, and on a real upgrade does the verified download +
// atomic swap under the lock. Does NOT re-exec: the user is not mid-command, so
// the new binary simply takes effect on the next run.
export async function runUpgrade(opts: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  buildInfo?: BuildInfo;
  log?: Logger;
}): Promise<number> {
  const env = opts.env ?? process.env;
  const buildInfo = opts.buildInfo ?? loadBuildInfo();
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const args = parseUpgradeArgs(opts.argv);
  const current = buildInfo.version;

  if (upgradeKillSwitch(env)) {
    log("Self-upgrade is disabled (MLA_DISABLE_UPGRADE is set).");
    return 1;
  }

  // Managed installs: redirect, never self-replace.
  const method = detectInstallMethod({
    execPath: process.execPath,
    scriptPath: process.argv[1],
    env,
  });
  if (method !== "curl") {
    log(
      method === "unknown"
        ? "Could not determine how mla was installed."
        : `mla was installed via ${method}.`,
    );
    log(`To upgrade, run: ${upgradeCommandFor(method)}`);
    return 0;
  }

  const verified = await fetchManifest({ env, buildInfo });
  if (!verified) {
    log("Could not fetch or verify the release manifest. Try again later.");
    return 1;
  }
  const manifest = verified.manifest;
  // We just verified the authoritative "latest" pointer live. Refresh the cache
  // the passive nag reads BEFORE any of the early returns below (--check,
  // up-to-date, no-artifact, ...), so a manual `mla upgrade --check` un-sticks a
  // stale nag instead of discarding what it learned.
  stampLatestFromManifest(manifest);
  const triple = currentTriple(process.platform, process.arch);
  const plan = planUpgrade({ current, manifest, triple, force: args.force });

  switch (plan.action) {
    case "up-to-date":
      log(`mla is up to date (${current}).`);
      return 0;
    case "no-artifact":
      log(`No release artifact published for this platform (${triple ?? "unsupported"}).`);
      return 1;
    case "downgrade-blocked":
      log(
        `The published version (${plan.to}) is older than the installed one (${current}). ` +
          "Pass --force to install it anyway.",
      );
      return 1;
    case "unparseable-current":
      log(
        `Running a dev build (${current}); refusing to overwrite it. ` +
          `Pass --force to install ${plan.to}.`,
      );
      return 1;
    case "upgrade":
      break;
  }

  if (args.check) {
    log(`Update available: ${current} -> ${plan.to}. Run \`mla upgrade\` to install it.`);
    return 0;
  }

  const artifact = selectArtifact(manifest, triple);
  if (!artifact) {
    log(`No release artifact published for this platform (${triple ?? "unsupported"}).`);
    return 1;
  }

  log(`Downloading mla ${plan.to} for ${triple}...`);
  const extracted = await downloadVerifyExtract({ artifact });
  if (!extracted) {
    log("Download or verification failed. Your current mla is unchanged.");
    return 1;
  }

  const result = await withUpgradeLock(async () => {
    try {
      atomicSwapBinary({ newBinaryPath: extracted.binaryPath });
      return true;
    } catch {
      rollbackBinary();
      return false;
    }
  });
  cleanupDir(extracted.dir);

  if (!result.ran) {
    log("Another upgrade is already in progress. Try again in a moment.");
    return 1;
  }
  if (!result.value) {
    log("Failed to replace the binary; rolled back to the previous version.");
    return 1;
  }

  // A manual upgrade supersedes any background-staged binary.
  clearStaged();
  // Stamp the cache so the nag does not immediately fire for a version we just installed.
  const prevState = readUpdateState();
  writeUpdateState({
    ...prevState,
    latestVersion: manifest.version,
    minVersion: manifest.minVersion,
    staged: null,
  });
  log(`Upgraded mla ${current} -> ${plan.to}. The new version takes effect on your next command.`);
  return 0;
}
