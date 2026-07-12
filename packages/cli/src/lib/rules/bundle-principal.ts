/**
 * Resolve the local session's rule-bundle principal for the §6.1 zero-network cache
 * (notes/20260627-rules-store-unification-backend-sot-proposal.md §6.1, §7 / P1F).
 *
 * The bundle cache is principal-bound: a read whose embedded principalUserId / workspaceId
 * / projectId does not match the live session is rejected (bundle-cache.ts, acceptance 11).
 * The bundle's principalUserId is stamped SERVER-side from the session token, so the offline
 * readers (the scanner's rule injection and the PreToolUse hook) must resolve the SAME
 * principal locally or every fetched bundle mismatches and reads as "unavailable". This is
 * the one place that mapping lives, mirroring control's resolution exactly:
 *
 *   - user-token session -> the WorkspaceUser id control resolved FOR THIS WORKSPACE. That
 *     is auth.user.id ONLY when the effective workspace is the session's HOME workspace.
 *     Under the per-workspace-identity model (no global User) the same human is a DIFFERENT
 *     WorkspaceUser row in every workspace, so a command acting on a NON-home workspace via
 *     a `.meetless.json` marker gets a DIFFERENT principal -- the one resolveServerActor
 *     stamps from the membership set / live account resolver (apps/control actor-identity.ts).
 *     The client cannot re-derive that id (it depends on MEMBERSHIP_RESOLVER_MODE, account
 *     keying, the live DB, and the transition-email fallback), so it must LEARN it from the
 *     bundle control returns. The fetch vehicle (internal-steer-sync) records the
 *     (homeUserId, workspaceId) -> principalUserId mapping via recordBundlePrincipal after
 *     each fetch; this resolver consults that index and only falls back to auth.user.id (the
 *     home id) when no mapping is known yet -- which is exactly the home workspace, plus the
 *     honest "unavailable" for a not-yet-synced foreign workspace.
 *   - shared-key / none  -> null. A headless caller has no user; control builds a
 *     principal-null bundle and the cache is keyed by the `_shared` segment.
 *
 * The index is keyed by the HOME identity (auth.user.id) so a re-login as a DIFFERENT human
 * on the same $MEETLESS_HOME can never read the prior user's snapshot: the new session reads
 * under its own home id, finds no entry, and falls back to its own home id (acceptance 11).
 *
 * projectId is ALWAYS null: the CLI has no project-activation concept (see
 * rule-import-mapping.ts, which forces projectId null on every imported rule), so the
 * bundle is workspace + principal bound and the readers expect null. The index therefore
 * needs no project dimension.
 *
 * BEST-EFFORT and THROW-FREE: this runs inside the UserPromptSubmit scan hook, which must
 * never break on a config error (a missing cli-config.json, or a MEETLESS_CONTROL_TOKEN
 * rejected under an on-disk user-token, §0.01 clause 4). Any failure degrades to a null
 * principal, which yields "no usable bundle" rather than crashing the scan. The config
 * reader is injectable so the resolver is unit-testable with no disk.
 */
import * as fs from "fs";
import * as path from "path";

import { HOME, readConfig, type CliConfig } from "../config";
import type { BundlePrincipal } from "./bundle-cache";

/** The on-disk index schema version, independent of the bundle cache envelope. */
const PRINCIPAL_INDEX_SCHEMA_VERSION = 1 as const;

interface PrincipalIndex {
  version: number;
  /** homeUserId (auth.user.id) -> { workspaceId -> control-resolved principalUserId }. */
  byHome: Record<string, Record<string, string>>;
}

/**
 * The gitignored sidecar that maps (home identity, workspace) to the principal control
 * stamped on the last fetched bundle for that workspace. Lives beside the bundle cache
 * files under $MEETLESS_HOME/rules/. Named so it can never collide with a `bundle-*.json`
 * cache file.
 */
export function principalIndexPath(home: string = HOME): string {
  return path.join(home, "rules", "principal-index.json");
}

function readPrincipalIndex(home: string): PrincipalIndex {
  try {
    const raw = JSON.parse(
      fs.readFileSync(principalIndexPath(home), "utf8"),
    ) as Partial<PrincipalIndex>;
    if (
      raw &&
      typeof raw === "object" &&
      raw.version === PRINCIPAL_INDEX_SCHEMA_VERSION &&
      raw.byHome &&
      typeof raw.byHome === "object"
    ) {
      return { version: PRINCIPAL_INDEX_SCHEMA_VERSION, byHome: raw.byHome };
    }
  } catch {
    /* missing / unreadable / wrong schema: treat as empty */
  }
  return { version: PRINCIPAL_INDEX_SCHEMA_VERSION, byHome: {} };
}

/**
 * Record the authoritative principal control resolved for (this home identity, workspace),
 * learned from a freshly fetched bundle. Called by the fetch vehicle after it persists a
 * bundle so the offline readers can key the bundle-cache read by the SAME principal control
 * stamped. No-op for a non-user-token session (shared-key uses the `_shared` segment; there
 * is no per-workspace human) or a null principal. THROW-FREE: an index write failure must
 * never break the sync; the resolver then simply falls back to the home id next read.
 */
export function recordBundlePrincipal(
  workspaceId: string,
  principalUserId: string | null,
  read: () => CliConfig = readConfig,
  opts: { home?: string } = {},
): void {
  const home = opts.home ?? HOME;
  try {
    if (!principalUserId) return;
    const cfg = read();
    if (cfg.auth.mode !== "user-token") return;
    const homeUserId = cfg.auth.user.id;
    const index = readPrincipalIndex(home);
    const forHome = index.byHome[homeUserId] ?? {};
    if (forHome[workspaceId] === principalUserId) return; // already current: skip the write
    forHome[workspaceId] = principalUserId;
    index.byHome[homeUserId] = forHome;

    const file = principalIndexPath(home);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Owner-only: the file lives beside the principal-bound bundle cache and maps internal
    // WorkspaceUser ids; keep it off group/world-readable to match the cache posture.
    fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort: a failed record just means the next reader falls back to the home id */
  }
}

export function resolveBundlePrincipal(
  workspaceId: string,
  read: () => CliConfig = readConfig,
  opts: { home?: string } = {},
): BundlePrincipal {
  const home = opts.home ?? HOME;
  let principalUserId: string | null = null;
  try {
    const cfg = read();
    if (cfg.auth.mode === "user-token") {
      const homeUserId = cfg.auth.user.id;
      // Prefer the principal control stamped for THIS workspace on the last fetch; fall
      // back to the home id when unknown (the home workspace, or a not-yet-synced foreign
      // workspace where "unavailable" is the correct answer anyway).
      principalUserId =
        readPrincipalIndex(home).byHome[homeUserId]?.[workspaceId] ?? homeUserId;
    }
  } catch {
    // A config error must never break the scan; fall back to the shared/headless principal.
    principalUserId = null;
  }
  return { workspaceId, principalUserId, projectId: null };
}
