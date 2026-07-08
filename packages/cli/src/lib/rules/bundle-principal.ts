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
 *   - user-token session -> the authenticated user's id (auth.user.id). Control resolves
 *     the same user from the bearer, so the binding matches.
 *   - shared-key / none  -> null. A headless caller has no user; control builds a
 *     principal-null bundle and the cache is keyed by the `_shared` segment.
 *
 * projectId is ALWAYS null: the CLI has no project-activation concept (see
 * rule-import-mapping.ts, which forces projectId null on every imported rule), so the
 * bundle is workspace + principal bound and the readers expect null.
 *
 * BEST-EFFORT and THROW-FREE: this runs inside the UserPromptSubmit scan hook, which must
 * never break on a config error (a missing cli-config.json, or a MEETLESS_CONTROL_TOKEN
 * rejected under an on-disk user-token, §0.01 clause 4). Any failure degrades to a null
 * principal, which yields "no usable bundle" rather than crashing the scan. The config
 * reader is injectable so the resolver is unit-testable with no disk.
 */
import { readConfig, type CliConfig } from "../config";
import type { BundlePrincipal } from "./bundle-cache";

export function resolveBundlePrincipal(
  workspaceId: string,
  read: () => CliConfig = readConfig,
): BundlePrincipal {
  let principalUserId: string | null = null;
  try {
    const cfg = read();
    principalUserId = cfg.auth.mode === "user-token" ? cfg.auth.user.id : null;
  } catch {
    // A config error must never break the scan; fall back to the shared/headless principal.
    principalUserId = null;
  }
  return { workspaceId, principalUserId, projectId: null };
}
