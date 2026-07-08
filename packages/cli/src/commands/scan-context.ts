// src/commands/scan-context.ts
import { homedir } from "node:os";
import { scanWorkspace } from "../lib/scanner/scan";
import {
  applyVerdicts,
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

export interface RescanArgs {
  cwd: string;
  workspaceId: string;
  home?: string;
  now?: () => string;
}

// Pure-ish core: scan, apply current verdicts, persist. Returns the applied result.
export function rescanAndCache(args: RescanArgs): ScanResult {
  const home = args.home ?? homedir();
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
  const withMeta: ScanResult = { ...applied, floorMeta };
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
  home: string,
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

// Thin CLI wrapper: `mla _internal scan-context`. Resolves the workspace and the
// scan root from the marker (env/flag override the id), then scans + caches.
export async function runScanContext(argv: string[]): Promise<number> {
  const target = resolveScanTarget({ startDir: process.cwd(), env: process.env, argv });
  if ("error" in target) {
    console.error(target.error);
    return 2;
  }
  const result = rescanAndCache({ cwd: target.scanRoot, workspaceId: target.workspaceId });
  console.log(
    `scanned: ${result.inventory.instructionFiles} instruction files, ` +
      `${result.directives.length} rules, ${result.inventory.staleSignals} stale signals`,
  );
  return 0;
}

function argFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
