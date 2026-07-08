// plugin-detect.ts: decide whether THIS machine has our plugin installed, so the
// migrator (plugin-migrate.ts) and `mla doctor` can reconcile legacy home-dir
// wiring against it. Ownership is decided by an EXACT match on the fully-qualified
// id `mla@meetless` (design §6.1), NOT a `startsWith("mla@")` prefix, which would
// false-own someone else's fork published under a different marketplace. The result
// is 4-state:
//
//   owned       enabled at user/managed scope: the plugin provides global wiring.
//   non-global  enabled at project OR local scope only: installed, yet it does NOT
//               provide user-global wiring, so legacy home-dir wiring is still live.
//   unknown     ours by id, but the entry's scope/enabled shape is uninterpretable
//               (missing scope, non-boolean enabled, or an enabled but UNRECOGNIZED
//               scope string), OR the list could not be read.
//   absent      not present, or ours-but-disabled, or a foreign id.
//
// The single most important fail-safe (design §6.4): a malformed-but-ours entry, a
// missing `claude`, a nonzero exit, or unparseable JSON yields "unknown", NEVER a
// false "absent". An "absent" would let the migrator rip out working legacy
// wiring. And we never read from a pipe (the piped `--json` output truncates at
// 64KB, GH #36685): the command redirects to a temp file we then read whole.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

// The exact fully-qualified plugin id: marketplace catalog `name: "meetless"` ×
// plugin manifest `name: "mla"` => `mla@meetless`. Single source of truth for the
// identity check so detection cannot drift from the artifact generator.
export const PLUGIN_QUALIFIED_ID = "mla@meetless";

export type PluginOwnership =
  | { status: "owned"; scope: "user" | "managed"; version: string; installPath?: string }
  | { status: "non-global"; scope: "project" | "local"; version: string }
  | { status: "unknown"; reason: string }
  | { status: "absent" };

export interface PluginListEntry {
  id?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
}

export function classifyPluginList(entries: PluginListEntry[]): PluginOwnership {
  // Scan ALL entries: a plugin id can legitimately appear at more than one scope,
  // and the list order is not guaranteed. Precedence: an owned (global, active) row
  // wins outright; else a non-global (project-scope) row; else a malformed-but-ours
  // row degrades to unknown; else absent. A malformed entry must NEVER read as
  // absent (design §6.4): that is the one classification that greenlights ripping
  // out working legacy wiring.
  let nonGlobal: PluginOwnership | undefined;
  let unknown: PluginOwnership | undefined;
  for (const e of entries) {
    if (e.id !== PLUGIN_QUALIFIED_ID) continue; // exact identity, never a prefix
    // Uninterpretable shape (missing/blank scope or non-boolean enabled): ours, but
    // we cannot tell its state -> unknown, never absent.
    if (typeof e.scope !== "string" || e.scope.length === 0 || typeof e.enabled !== "boolean") {
      unknown ??= {
        status: "unknown",
        reason: "an mla@meetless entry has an uninterpretable scope/enabled shape",
      };
      continue;
    }
    if (e.enabled !== true) continue; // ours, but disabled -> inactive, treat as absent
    // Only an ours+enabled+interpretable entry can carry a version we report; compute
    // it here, past the early continues, so a malformed-shape entry does no wasted work.
    const version = typeof e.version === "string" ? e.version : "unknown";
    if (e.scope === "user" || e.scope === "managed") {
      return {
        status: "owned",
        scope: e.scope,
        version,
        installPath: typeof e.installPath === "string" ? e.installPath : undefined,
      };
    }
    if (e.scope === "project" || e.scope === "local") {
      // Enabled at a non-global scope: installed, but not providing user-global
      // wiring, so legacy home-dir wiring must be preserved.
      nonGlobal ??= { status: "non-global", scope: e.scope, version };
      continue;
    }
    // Enabled, ours by id, but an UNRECOGNIZED scope string (neither global nor
    // project/local). We cannot safely say it is or is not global -> unknown, never
    // a silent non-global (An high-pri #4). unknown is the fail-safe: it preserves
    // legacy wiring rather than risking a double-wire or a false teardown.
    unknown ??= {
      status: "unknown",
      reason: `an mla@meetless entry has an unrecognized scope "${e.scope}"`,
    };
  }
  return nonGlobal ?? unknown ?? { status: "absent" };
}

// `claude plugin list --json` is a local config read that returns in milliseconds; a
// subprocess still alive after this bound is wedged, not slow. Without a cap a hung
// `claude` would block `mla activate`/`mla doctor` (both reach here via the reconcile
// backstop) rather than degrading. spawnSync kills it at the bound and sets r.error
// (ETIMEDOUT), which we rethrow so detectPluginOwnership maps it to the fail-safe
// "unknown". Keep the bound generous: it exists to break a hang, not to race a slow read.
const PLUGIN_LIST_TIMEOUT_MS = 10_000;

// Default runner: `claude plugin list --json > tmpFile`, returning the exit code.
// Overridable in tests. We redirect to a file rather than capturing stdout so we
// never hit the 64KB pipe-truncation bug.
function defaultRun(bin: string, tmpFile: string): number {
  const fd = fs.openSync(tmpFile, "w");
  try {
    const r = spawnSync(bin, ["plugin", "list", "--json"], {
      stdio: ["ignore", fd, "ignore"],
      timeout: PLUGIN_LIST_TIMEOUT_MS,
    });
    if (r.error) throw r.error;
    return typeof r.status === "number" ? r.status : 1;
  } finally {
    fs.closeSync(fd);
  }
}

export function detectPluginOwnership(
  opts: { claudeBin?: string; run?: (bin: string, tmpFile: string) => number } = {},
): PluginOwnership {
  const bin = opts.claudeBin ?? "claude";
  const run = opts.run ?? defaultRun;
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mla-plugin-list-")),
    "list.json",
  );
  try {
    let code: number;
    try {
      code = run(bin, tmpFile);
    } catch (e: any) {
      return { status: "unknown", reason: `could not run \`${bin} plugin list\`: ${e.message}` };
    }
    if (code !== 0) {
      return { status: "unknown", reason: `\`${bin} plugin list\` exited ${code}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    } catch (e: any) {
      return { status: "unknown", reason: `unparseable plugin list JSON: ${e.message}` };
    }
    if (!Array.isArray(parsed)) {
      return { status: "unknown", reason: "plugin list JSON was not an array" };
    }
    return classifyPluginList(parsed as PluginListEntry[]);
  } finally {
    try {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
