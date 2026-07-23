// src/lib/rules/bundle-refresh.ts
//
// Re-fetch the principal-bound rule bundle from the AUTHORITY and write it into the local
// rule-bundle cache. This is hop 1 -> 2 of the delivery chain (see commands/rule-delivery.ts for
// the whole chain and why it exists).
//
// It lives in lib/ (not commands/) so both sides can use it without a cycle: the PUSH side
// (commands/rule-delivery.ts, for the verbs that mutate the authority) and the PULL side
// (commands/scan-context.ts, for `mla scan`) both need to fetch, but only the push side needs the
// rescan that follows, and the scanner must never import a command.
//
// It also hosts the SECOND pull that rides the same scan-refresh moment: the §3.5 reconciliation
// findings. Two pulls, one moment, deliberately independent outcomes. A findings failure must not
// make the bundle look stale (rules would be wrongly disclaimed) and a bundle failure must not
// suppress findings (a governed decision would silently stop being surfaced), so they are separate
// functions with separate try/catch rather than one combined fetch.
import { getBundle, type RuleClientHttp } from "./control-rule-client";
import { writeRuleBundleCache } from "./bundle-cache";
import { recordBundlePrincipal } from "./bundle-principal";
import { loadWorkspaceConfig, type WorkspaceCliConfig } from "../config";
import type { RuleBundle } from "./control-rule-client";
import {
  listReconciliationFindings,
  toCacheFinding,
  type ReconciliationClientHttp,
} from "./reconciliation-client";
import type { ReconciliationFinding } from "../scanner/types";

/**
 * What actually reached the agent-visible caches. `delivered: false` NEVER means the authority
 * mutation failed: that write is already committed and durable. It means only that this machine's
 * copy is still stale, so the caller must not print an injection claim it cannot back.
 */
export type DeliveryOutcome = { delivered: true } | { delivered: false; error: string };

/**
 * Fetch the authority's current bundle and make it this machine's cached bundle. Throws on failure.
 *
 * `home` follows the convention of every other cache primitive here (bundle-cache, bundle-principal,
 * scanner/cache all take one): it defaults to the real $MEETLESS_HOME, and a test overrides it so it
 * cannot scribble into the operator's own rule cache.
 */
export async function refreshBundleCache(
  cfg: WorkspaceCliConfig,
  http?: RuleClientHttp,
  opts: { home?: string } = {},
): Promise<RuleBundle> {
  const bundle = await getBundle(cfg, { projectId: null }, http);
  writeRuleBundleCache(bundle, { home: opts.home });
  recordBundlePrincipal(bundle.workspaceId, bundle.principalUserId, undefined, { home: opts.home });
  return bundle;
}

/**
 * The PULL half, for `mla scan`.
 *
 * A verb can only push what IT changed. The same authority is also mutated from the Console web UI,
 * from another machine, and by a teammate promoting a TEAM rule, none of which ever touch this
 * laptop. `mla scan` is the documented refresh lever ("rebuild this repo's local rule cache from the
 * backend bundle"), so it has to actually re-fetch the bundle. Until this existed it rescanned a
 * stale copy of the bundle and never contacted the backend, which made its own help text false: a
 * revoked rule stayed injected and a newly added one stayed invisible, no matter how often you scanned.
 *
 * BEST EFFORT by design: an unbound repo, a logged-out CLI, or an offline laptop must still scan
 * against the cached bundle rather than hard-fail, so scanning keeps working on a plane.
 */
export async function refreshBundleForScan(
  workspaceId: string,
  deps: {
    loadConfig?: (override?: string) => WorkspaceCliConfig;
    http?: RuleClientHttp;
    home?: string;
  } = {},
): Promise<DeliveryOutcome> {
  try {
    const cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspaceId);
    await refreshBundleCache(cfg, deps.http, { home: deps.home });
    return { delivered: true };
  } catch (e) {
    return { delivered: false, error: (e as Error).message };
  }
}

/**
 * What a findings pull produced. `findings: null` means the pull did not happen or did not
 * succeed, which is NOT the same as "this workspace has no findings" (an empty array). The
 * distinction is the whole point: a failed pull must leave the previous findings in the scan
 * cache alone, while a successful empty pull must CLEAR them, because a finding that control
 * no longer serves has been dismissed, resolved, or had its decision retracted, and continuing
 * to inject it under trust="governed" is precisely the failure this ADR exists to prevent.
 */
export type ReconciliationPull =
  | { findings: ReconciliationFinding[]; truncated: boolean }
  | { findings: null; error: string };

/**
 * Pull this viewer's ACTIVE reconciliation findings at the scan-refresh moment.
 *
 * BEST EFFORT, on the same terms as the bundle pull: an unbound repo, a logged-out CLI, or an
 * offline laptop must still scan. Control is the only authority on which findings are live (it
 * re-checks visibility, live ACCEPTED acceptance, and a non-tombstoned artifact per read), so
 * there is nothing local to fall back to: we either got a fresh answer or we did not.
 */
export async function fetchReconciliationForScan(
  workspaceId: string,
  deps: {
    loadConfig?: (override?: string) => WorkspaceCliConfig;
    http?: ReconciliationClientHttp;
  } = {},
): Promise<ReconciliationPull> {
  try {
    const cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspaceId);
    const res = await listReconciliationFindings(cfg, deps.http);
    return {
      findings: (res.findings ?? []).map(toCacheFinding),
      truncated: Boolean(res.truncated),
    };
  } catch (e) {
    return { findings: null, error: (e as Error).message };
  }
}
