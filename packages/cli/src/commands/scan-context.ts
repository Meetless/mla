// src/commands/scan-context.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { scanWorkspace } from "../lib/scanner/scan";
import {
  applyVerdicts,
  readScanCache,
  readVerdicts,
  writeScanCache,
  writeProjectionReceipt,
  type PersistedProjectionReceipt,
} from "../lib/scanner/cache";
import { Directive, FloorMeta, ScanResult } from "../lib/scanner/types";
import { findWorkspaceContext } from "../lib/workspace";
import { resolveBundlePrincipal } from "../lib/rules/bundle-principal";
import { readRuleBundleCache, type BundlePrincipal } from "../lib/rules/bundle-cache";
import {
  materializeFloorProjection,
  removeOwnedProjection,
} from "../lib/scanner/floor-projection-writer";
import { renderProjectionBody, projectionBodyHash } from "../lib/scanner/floor-projection";
import { refreshBundleForScan, type DeliveryOutcome } from "../lib/rules/bundle-refresh";

export interface RescanArgs {
  cwd: string;
  workspaceId: string;
  home?: string;
  now?: () => string;
}

// Pure-ish core: scan, apply current verdicts, persist. Returns the applied result.
export function rescanAndCache(args: RescanArgs): ScanResult {
  // No local homedir() default: the state root is the cache module's policy (it honors
  // MEETLESS_HOME), and duplicating the default here is exactly what made it unreachable.
  const home = args.home;
  const now = args.now ?? (() => new Date().toISOString());
  // The scanner's injected rule set is sourced from the principal-bound backend bundle,
  // which is principal-keyed. Resolve the live session's principal (mirroring control's
  // server-side stamping) so the bundle read matches.
  const principal = resolveBundlePrincipal(args.workspaceId);
  const raw = scanWorkspace(args.cwd, {
    workspaceId: args.workspaceId,
    now,
    principalUserId: principal.principalUserId,
    projectId: principal.projectId,
  });
  const applied = applyVerdicts(raw, readVerdicts(home, args.workspaceId));
  // One bundle read serves BOTH the hook and the projection: currency + provenance are
  // stamped into the cache as `floorMeta` so the zero-Node hot-path hook can write a
  // delivery receipt (freshness/bundleId/bundleHash) with a pure jq read, and the same
  // bundleId/hash flow into the on-disk projection header. Throw-free.
  const floorMeta = computeFloorMeta(applied.directives, principal, now);
  // Stamp WHOSE checkout this cache is: the realpath of the scan root. Two checkouts of one
  // workspace write the same scan-cache.json path, so a reader in checkout B must be able to
  // tell it is holding checkout A's repo-specific scan and decline to render/inject it. Derived
  // via resolveScanRoot (not raw args.cwd) so every caller, including activate which passes a raw
  // cwd, stamps the SAME canonical marker-dir identity the readers compute.
  const withMeta: ScanResult = { ...applied, floorMeta, scanRootPath: resolveScanRootIdentity(args.cwd) };
  writeScanCache(home, args.workspaceId, withMeta);
  // One producer, two projections (matrix doc, "the same successful scan"): the scan that
  // just wrote scan-cache.json.floorRulesXml for the main-agent hook ALSO materializes the
  // `.claude/rules` fallback for write-capable subagents. Best-effort and isolated in its
  // own try/catch so a projection failure never breaks the scan/cache the callers depend on.
  try {
    materializeAndRecordProjection(args.cwd, args.workspaceId, withMeta, floorMeta, home, now);
  } catch {
    // Defense in depth: the writer is already throw-free; this guards the receipt path too.
  }
  return withMeta;
}

// Currency + provenance for the floor block, from the SAME principal-bound bundle cache
// the scanner injected floor directives from. `bundleHash` is the floor BODY hash (the
// projection's payloadHash by construction), so the hook receipt and the on-disk
// projection share one identity. THROW-FREE: a bundle-read failure degrades to
// unavailable/missing, and an empty floor yields a null hash. `freshness` never reports
// "unknown": a delivered floor is fresh or stale; only an unusable bundle is missing.
function computeFloorMeta(
  dirs: Directive[],
  principal: BundlePrincipal,
  now: () => string,
): FloorMeta {
  let bundleId = "unavailable";
  let freshness: FloorMeta["freshness"] = "missing";
  try {
    const read = readRuleBundleCache(principal, { nowMs: Date.parse(now()) });
    if (read.bundle) bundleId = `rev-${read.bundle.bundleRevision}`;
    freshness = read.status === "fresh" ? "fresh" : read.status === "stale" ? "stale" : "missing";
  } catch {
    // keep unavailable/missing defaults
  }
  const body = renderProjectionBody(dirs);
  const bundleHash = body ? projectionBodyHash(body) : null;
  return { bundleId, bundleHash, freshness };
}

// Render + atomically write the floor projection under the CURRENT checkout root (the
// nearest .meetless.json marker dir, so a subdir invocation still lands the file at the
// checkout root and a worktree materializes in its own checkout only), then persist the
// local materialization receipt. Split out to keep rescanAndCache readable.
function materializeAndRecordProjection(
  cwd: string,
  workspaceId: string,
  applied: ScanResult,
  floorMeta: FloorMeta,
  home: string | undefined,
  now: () => string,
): void {
  const scanRoot = resolveScanRoot(cwd);
  const outcome = resolveProjectionOutcome(scanRoot, applied.directives, floorMeta);
  writeProjectionReceipt(home, workspaceId, {
    schemaVersion: 1,
    at: now(),
    workspaceId,
    projection: outcome.projection,
    reason: outcome.reason,
    bundleId: floorMeta.bundleId,
  });
}

// Decide the projection action for a scan, disambiguating a REVOKED floor from a TRANSIENT
// empty read (matrix doc Phase 1). The writer deliberately treats an empty floor as
// no_floor_rules and leaves any owned projection intact: an empty read is also the
// bundle-unavailable case, and revoking last-known-good on a blink would be worse than a
// brief stale projection. But a FRESH bundle carrying zero floor rules is a genuine
// governance revocation, and only the caller has the `freshness` signal to tell the two
// apart. So on fresh+empty we tear the owned projection down (else it keeps governing
// subagents until deactivation); every other case defers to the writer's own safety posture.
// bundleId is informational provenance in the header; ownership/rewrite decisions are driven
// purely by the body hash, so reusing the floorMeta read (vs a second read) is safe.
export function resolveProjectionOutcome(
  scanRoot: string,
  directives: Directive[],
  floorMeta: FloorMeta,
): { projection: PersistedProjectionReceipt["projection"]; reason?: string } {
  if (directives.length === 0 && floorMeta.freshness === "fresh") {
    const r = removeOwnedProjection(scanRoot);
    if (r.removed) return { projection: "removed", reason: "revoked" };
    // Nothing owned to remove -> unchanged; a foreign/edited file or IO error -> blocked (leave
    // the on-disk file untouched, but surface that we could not reconcile it).
    return { projection: r.reason === "absent" ? "unchanged" : "blocked", reason: r.reason };
  }
  const receipt = materializeFloorProjection(scanRoot, directives, floorMeta.bundleId);
  return { projection: receipt.projection, reason: receipt.reason };
}

export interface ScanTarget {
  workspaceId: string;
  scanRoot: string;
}

// The directory a scan must run FROM: the nearest .meetless.json marker dir if we
// are inside an activated workspace, else the start dir unchanged. `git ls-files`
// from a package subdir only lists that subtree, so anchoring here is what keeps a
// rescan whole-workspace (all rules, root-relative + stable ids) no matter which
// subdir the command was invoked from. Shared by every caller that rescans.
export function resolveScanRoot(startDir: string): string {
  return findWorkspaceContext(startDir)?.markerDir ?? startDir;
}

// The canonical identity of a scan cache: the realpath of the directory a scan runs FROM
// (the marker dir; see resolveScanRoot). This is what a cache's scanRootPath is stamped with
// on write and compared against on read, so a reader in checkout B never renders or injects
// checkout A's stomped cache as its own. realpath canonicalizes symlinks and worktrees to one
// stable string (the same rule resolveActiveRuntimeScopeId uses on the enforcement plane).
// Falls back to the un-canonicalized marker path if realpath throws (dir removed mid-flight),
// which still compares equal to itself. Cheap: a filesystem walk to the marker plus one realpath,
// no subprocess, so it is safe on the assembler hot path.
export function resolveScanRootIdentity(cwd?: string): string {
  const root = resolveScanRoot(cwd ?? process.cwd());
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

// Read the scan cache, but ONLY return it when it belongs to the CURRENT checkout. A workspace
// can bind several checkouts that all write one scan-cache.json (see ScanResult.scanRootPath), so
// a raw read can hand a caller another checkout's repo-specific scan. Callers that consume
// repo-specific fields (status/context display, the assembler's locally-parsed scopedRules) MUST
// go through this; callers that read only workspace-global fields (floorMeta.bundleId, the bash
// floor block) may read raw. An unstamped legacy cache is TRUSTED (returned as-is): the field is
// additive and single-repo installs never wrote it, so guarding on its absence would be a pure
// regression. Only a PRESENT, mismatching stamp is rejected (returns null → re-scan / floor-only).
export function readScanCacheForRoot(
  home: string | undefined,
  workspaceId: string,
  cwd?: string,
): ScanResult | null {
  const cache = readScanCache(home, workspaceId);
  if (!cache || !cache.scanRootPath) return cache;
  return cache.scanRootPath === resolveScanRootIdentity(cwd) ? cache : null;
}

// Decide which workspace to scan and which directory to scan FROM. Pure: takes
// the start dir, env, and argv so it is fully testable without mutating process
// state. Precedence for the id is MEETLESS_WORKSPACE_ID > --workspace > the
// nearest .meetless.json marker. The scan ROOT is always the marker directory
// when a marker exists, so invoking from a package subdir (apps/control) still
// scans the whole workspace; `git ls-files` from a subdir only lists that
// subtree, which is exactly how nested instruction files would otherwise be
// missed. Only when there is no marker at all do we fall back to the start dir,
// and that path requires an explicit id from env or flag.
export function resolveScanTarget(opts: {
  startDir: string;
  env: NodeJS.ProcessEnv;
  argv: string[];
}): ScanTarget | { error: string } {
  const ctx = findWorkspaceContext(opts.startDir);
  const envWs = (opts.env.MEETLESS_WORKSPACE_ID ?? "").trim();
  const flagWs = (argFlag(opts.argv, "--workspace") ?? "").trim();
  const workspaceId = envWs || flagWs || ctx?.workspaceId;
  if (!workspaceId) {
    return {
      error:
        "scan-context: no workspace id (run inside an activated workspace, " +
        "set MEETLESS_WORKSPACE_ID, or pass --workspace)",
    };
  }
  return { workspaceId, scanRoot: resolveScanRoot(opts.startDir) };
}

export interface ScanContextDeps {
  refreshBundle?: (workspaceId: string) => Promise<DeliveryOutcome>;
  /**
   * Where the caches live. Defaults to the real home, as everywhere else. A test SHOULD override it
   * (or set MEETLESS_HOME) to contain a scan.
   *
   * The note that used to sit here said macOS `os.homedir()` ignores $HOME and reads getpwuid. That
   * is false, and believing it is what let a poisoned $HOME go unvalidated until it wrote state into
   * a git working tree. os.homedir() returns $HOME verbatim on Darwin exactly as on Linux; it is
   * os.userInfo() that ignores it. See config.userHomeDir.
   */
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// The CLI wrapper behind `mla scan` (and `mla _internal scan-context`). Resolves the workspace and
// the scan root from the marker (env/flag override the id), re-fetches the backend rule bundle,
// then scans + caches.
//
// The FETCH is the point, not an optimization. `scan` is the documented refresh lever ("rebuild
// this repo's local rule cache from the backend bundle"), and it used to do no such thing: it
// rescanned whatever bundle happened to be cached and never contacted control. A rule added or
// revoked anywhere else (the Console, another machine, a teammate's TEAM promotion) therefore
// never reached this laptop no matter how many times you scanned. A rule verb can only push what
// IT changed; this is the pull that covers everything else.
//
// The refresh is BEST EFFORT: a logged-out CLI, an unbound repo, or a plane must still scan against
// the cached bundle. We warn and keep going rather than fail, but we never silently pretend the
// bundle is current.
export async function runScanContext(argv: string[], deps: ScanContextDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const target = resolveScanTarget({ startDir: process.cwd(), env: process.env, argv });
  if ("error" in target) {
    err(target.error);
    return 2;
  }
  const refreshBundle =
    deps.refreshBundle ?? ((ws: string) => refreshBundleForScan(ws, { home: deps.home }));
  const refreshed = await refreshBundle(target.workspaceId);
  const result = rescanAndCache({
    cwd: target.scanRoot,
    workspaceId: target.workspaceId,
    home: deps.home,
  });
  out(
    `scanned: ${result.inventory.instructionFiles} instruction files, ` +
      `${result.directives.length} rules, ${result.inventory.staleSignals} stale signals`,
  );
  if (!refreshed.delivered) {
    err(
      `warning: could not refresh the rule bundle from the backend (${refreshed.error}); ` +
        `scanned against the last cached bundle, which may be stale.`,
    );
  }
  return 0;
}

function argFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
