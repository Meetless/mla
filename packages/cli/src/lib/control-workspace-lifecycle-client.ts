/**
 * The CLI's typed client for reversible workspace deactivation
 * (notes/20260710-mla-workspace-deactivate-retired-state.md §6).
 *
 * This is the ONE place the CLI knows the workspace-lifecycle API: every
 * `/internal/v1/workspaces/{deactivation-preflight,deactivate,reactivate}` path,
 * query, and response shape lives here, mirrored from the control DTOs and
 * WorkspaceLifecycleController so a rename surfaces as a compile error in exactly
 * one module. The verbs map 1:1 to the controller:
 *
 *   deactivationPreflight -> GET  /internal/v1/workspaces/deactivation-preflight
 *   deactivateWorkspace   -> POST /internal/v1/workspaces/deactivate
 *   reactivateWorkspace   -> POST /internal/v1/workspaces/reactivate
 *
 * This is E2 ("retire the workspace") of the two-verbs model. E1 ("unbind this
 * folder") is local to the CLI and NEVER touches control, so it has no client here.
 *
 * Same THIN transport-shell contract as control-workspace-member-client: it builds
 * the path + query, forwards the body verbatim, types the result, and makes NO
 * policy decision. The backend resolves the acting human server-side and enforces
 * the OWNER/ADMIN gate against the marker-resolved effectiveWorkspaceId (the
 * preflight is advisory only; the mutation re-gates independently, INV-AUTH-1).
 *
 * `workspaceId` is sent on EVERY call. The preflight is a GET, so its workspaceId
 * MUST ride in the query string (there is no body): a cli-session GET with no
 * workspaceId marker falls back to the session HOME workspace under
 * CliSessionTenantGuard, so a folder-bound / --workspace target would silently
 * preflight the operator's personal workspace (BUG-3/BUG-4). The POSTs carry it in
 * the body. Sending cfg.workspaceId pins the effective workspace for both a
 * cli-session caller (must match or the tenant guard 403s) and an internal-key
 * caller (needs it to scope the write).
 */
import type { WorkspaceCliConfig } from "./config";
import { get, post } from "./http";

const BASE = "/internal/v1/workspaces";

/**
 * GET /deactivation-preflight response. Advisory: it tells `mla deactivate` which
 * prompt to show. `callerRole` is null when the actor cannot be resolved (anonymous
 * shared key) or is not an active member; the CLI then treats the caller as E1-only.
 * `retiredAt` is the current state (non-null => already retired).
 */
export interface DeactivationPreflightResult {
  workspaceId: string;
  callerRole: string | null;
  activeMemberCount: number;
  retiredAt: string | null;
}

/** POST /deactivate response: the workspace and the (idempotent) retiredAt stamp. */
export interface DeactivateWorkspaceResult {
  workspaceId: string;
  retiredAt: string;
}

/** POST /reactivate response: retiredAt is always null after a successful clear. */
export interface ReactivateWorkspaceResult {
  workspaceId: string;
  retiredAt: null;
}

/** The http verbs this client needs; injectable so it is testable with no network. */
export interface WorkspaceLifecycleClientHttp {
  get: typeof get;
  post: typeof post;
}

const defaultHttp: WorkspaceLifecycleClientHttp = { get, post };

/** Append a query string, dropping null/undefined/empty params. */
function withQuery(
  path: string,
  params: Record<string, string | null | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      qs.set(key, value);
    }
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Advisory preflight for cfg.workspaceId. Open to any active member. Drives which
 * `mla deactivate` prompt shows (sole-owner default-YES vs multi-member default-NO
 * vs member E1-only). NEVER the mutation authority. workspaceId rides in the query
 * string (GET has no body): see the file header on the BUG-3/BUG-4 HOME fallback.
 */
export async function deactivationPreflight(
  cfg: WorkspaceCliConfig,
  http: WorkspaceLifecycleClientHttp = defaultHttp,
): Promise<DeactivationPreflightResult> {
  const path = withQuery(`${BASE}/deactivation-preflight`, {
    workspaceId: cfg.workspaceId,
  });
  return http.get<DeactivationPreflightResult>(cfg, path);
}

/**
 * Retire (soft-deactivate) cfg.workspaceId: sets Workspace.retiredAt. OWNER/ADMIN
 * only (server-gated). Idempotent: an already-retired workspace returns its existing
 * retiredAt. workspaceId rides in the body (POST carries one).
 */
export async function deactivateWorkspace(
  cfg: WorkspaceCliConfig,
  http: WorkspaceLifecycleClientHttp = defaultHttp,
): Promise<DeactivateWorkspaceResult> {
  return http.post<DeactivateWorkspaceResult>(cfg, `${BASE}/deactivate`, {
    workspaceId: cfg.workspaceId,
  });
}

/**
 * Reactivate a retired cfg.workspaceId: clears Workspace.retiredAt. OWNER/ADMIN only
 * (server-gated). Idempotent: an already-active workspace returns retiredAt=null.
 * workspaceId rides in the body.
 */
export async function reactivateWorkspace(
  cfg: WorkspaceCliConfig,
  http: WorkspaceLifecycleClientHttp = defaultHttp,
): Promise<ReactivateWorkspaceResult> {
  return http.post<ReactivateWorkspaceResult>(cfg, `${BASE}/reactivate`, {
    workspaceId: cfg.workspaceId,
  });
}
