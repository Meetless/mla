// IO layer for the update notifier. The decision logic is the pure core in
// update-check.ts; the heavier upgrade IO (cache read/write, manifest fetch +
// verify, download, swap, stage) lives in upgrade-apply.ts. This file wires the
// two together for the two background concerns: spawn the detached check child,
// and print the nag. Every function here is best-effort and swallows its own
// errors: the update notifier must never change an exit code or break a command.
import { spawn } from "child_process";
import {
  DEFAULT_UPDATE_URL,
  currentTriple,
  detectInstallMethod,
  formatUpdateNag,
  isBelowMinVersion,
  planUpgrade,
  resolveAutoApply,
  selectArtifact,
  shouldRunCheck,
  shouldShowNag,
} from "./update-check";
import { loadBuildInfo } from "./observability";
import { readUpdateConfig } from "./config";
import {
  cleanupDir,
  downloadVerifyExtract,
  fetchManifest,
  readUpdateState,
  stageBinary,
  writeUpdateState,
} from "./upgrade-apply";
import * as fs from "fs";

// Re-export the cache IO from its new home so existing importers keep working.
export { readUpdateState, writeUpdateState, stateFilePath } from "./upgrade-apply";

// Spawn a detached `mla _internal update-check` that fetches the signed manifest
// (and stages a binary when auto-apply is on), writes the cache, then returns
// immediately. The parent never waits on it. Skipped entirely for `_internal`
// commands (so the check child can't recurse) and whenever the throttle/gating
// says no (shouldRunCheck).
export function maybeSpawnBackgroundCheck(opts: {
  command: string | undefined;
  env: NodeJS.ProcessEnv;
  now: number;
}): void {
  try {
    const { command, env, now } = opts;
    if (command === "_internal") return; // never recurse from the check child
    const entry = process.argv[1];
    if (!entry) return; // no re-invokable entry; skip rather than guess
    if (!shouldRunCheck({ state: readUpdateState(), now, env })) return;

    const child = spawn(process.execPath, [entry, "_internal", "update-check"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {}); // swallow ENOENT etc; never throw from here
    child.unref();
  } catch {
    // never let the notifier break the real command
  }
}

// Print the upgrade nag to stderr if a newer version is cached and the session
// is interactive (TTY) and not opted out / not CI. stderr keeps it off stdout
// so `mla ... | jq` stays clean. When the current version is below the manifest
// floor (minVersion), the stronger "required" wording is shown.
export function maybeShowUpdateNag(opts: {
  currentVersion: string | null;
  env: NodeJS.ProcessEnv;
}): void {
  try {
    const { currentVersion, env } = opts;
    const state = readUpdateState();
    const show = shouldShowNag({
      state,
      currentVersion,
      env,
      stdoutTTY: Boolean(process.stdout.isTTY),
      stderrTTY: Boolean(process.stderr.isTTY),
    });
    if (!show || !state.latestVersion) return;
    const method = detectInstallMethod({
      execPath: process.execPath,
      scriptPath: process.argv[1],
      env,
    });
    const required = isBelowMinVersion(currentVersion, state.minVersion ?? null);
    process.stderr.write(
      formatUpdateNag({ current: currentVersion, latest: state.latestVersion, method, required }),
    );
  } catch {
    // never let the notifier break the real command
  }
}

// Query the plaintext release feed for the latest version (bare, no leading v).
// This is the FALLBACK path used only when the signed manifest is unreachable
// (e.g. during the manifest rollout window): it keeps the nag working but cannot
// drive a self-upgrade (no per-artifact sha to verify). Returns null on any
// failure so the caller just leaves the cache untouched.
export async function fetchLatestVersion(opts?: {
  url?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const url = opts?.url ?? process.env.MLA_UPDATE_URL ?? DEFAULT_UPDATE_URL;
  const timeoutMs = opts?.timeoutMs ?? 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mla-update-check" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // The VERSION file holds a single bare version line (e.g. "0.4.2"). Trim
    // whitespace, take the first line, and drop an optional leading "v". Guard
    // against an unexpected large/HTML body so a misrouted URL can't poison the
    // cache with junk.
    const text = (await res.text()).trim();
    const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const ver = first.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(ver)) return null;
    return ver;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// `mla _internal update-check`: the detached child. Fetch + verify the signed
// manifest, stamp latestVersion + minVersion, and (when auto-apply is enabled on
// a curl install) download + verify + stage a newer binary so apply-on-launch is
// a cheap local swap. Always exits 0 (best-effort); stamps lastCheckedAt even on
// a failed fetch so a flaky network doesn't hammer the feed every command.
export async function runInternalUpdateCheck(): Promise<number> {
  const now = Date.now();
  const env = process.env;
  const buildInfo = loadBuildInfo();
  const prev = readUpdateState();

  const verified = await fetchManifest({ env, buildInfo });
  let latestVersion = prev.latestVersion;
  let minVersion = prev.minVersion ?? null;

  if (verified) {
    latestVersion = verified.manifest.version;
    minVersion = verified.manifest.minVersion;
  } else {
    // Manifest unreachable: fall back to the plaintext VERSION feed so the nag
    // keeps working. Cannot stage from this path (no verified artifact sha).
    const plain = await fetchLatestVersion();
    if (plain) latestVersion = plain;
  }

  let staged = prev.staged ?? null;
  if (
    verified &&
    resolveAutoApply({ env, configAutoApply: readUpdateConfig().autoApply })
  ) {
    const method = detectInstallMethod({
      execPath: process.execPath,
      scriptPath: process.argv[1],
      env,
    });
    if (method === "curl") {
      const triple = currentTriple(process.platform, process.arch);
      const plan = planUpgrade({
        current: buildInfo.version,
        manifest: verified.manifest,
        triple,
        force: false,
      });
      if (plan.action === "upgrade" && triple) {
        const already =
          staged &&
          staged.version === plan.to &&
          staged.triple === triple &&
          fs.existsSync(staged.path);
        if (!already) {
          const artifact = selectArtifact(verified.manifest, triple);
          if (artifact) {
            const extracted = await downloadVerifyExtract({ artifact });
            if (extracted) {
              try {
                staged = stageBinary({
                  binaryPath: extracted.binaryPath,
                  version: plan.to,
                  triple,
                  now,
                });
              } finally {
                cleanupDir(extracted.dir);
              }
            }
          }
        }
      }
    }
  }

  writeUpdateState({ lastCheckedAt: now, latestVersion, minVersion, staged });
  return 0;
}
