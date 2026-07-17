/**
 * The CLI's typed client for the Shared-Workspace Membership Doorway
 * (notes/20260710-mla-team-shared-workspace-membership.md).
 *
 * This is the ONE place the CLI knows the membership API: every
 * `/internal/v1/workspaces/members` path, query, and response shape lives here,
 * mirrored from the control DTOs and service so a rename surfaces as a compile
 * error in exactly one module. The verbs map 1:1 to WorkspaceMembersController:
 *
 *   inviteMember -> POST   /internal/v1/workspaces/members   (add a teammate's email)
 *   listMembers  -> GET    /internal/v1/workspaces/members   (active roster)
 *   removeMember -> DELETE /internal/v1/workspaces/members   (revoke by email)
 *
 * It is a THIN transport shell over lib/http.ts (mirroring control-rule-client):
 * it builds the path + query, forwards the body verbatim, and types the result.
 * It does NOT resolve actors or make policy decisions: the backend resolves the
 * acting human server-side and enforces the OWNER/ADMIN gate against the
 * marker-resolved effectiveWorkspaceId. The http verbs are injectable (last
 * param) so the client is unit-testable with no network.
 *
 * `workspaceId` is sent on EVERY call, and for GET/DELETE it MUST ride in the
 * query string (there is no body to carry it): a cli-session GET/DELETE with no
 * workspaceId marker falls back to the session HOME workspace under
 * CliSessionTenantGuard, so `members`/`remove` against a folder-bound or
 * --workspace target would silently hit the operator's personal workspace
 * (BUG-3/BUG-4). Sending cfg.workspaceId pins the effective workspace for both a
 * cli-session caller (must match or the tenant guard 403s) and an internal-key
 * caller (needs it to scope the write).
 */
import type { WorkspaceCliConfig } from "./config";
import { del, get, post } from "./http";

const BASE = "/internal/v1/workspaces/members";

/** One active member row, as the backend serializes it (email may be null on legacy rows). */
export interface WorkspaceMemberView {
  email: string | null;
  role: string;
}

/** GET /members response: the active roster (owner-first, then admin, then member). */
export interface ListMembersResult {
  members: WorkspaceMemberView[];
}

/** POST /members response: the resolved member after the role-preserving upsert. */
export interface InviteMemberResult {
  email: string;
  role: string;
  // A freshly minted, single-use join token for the email-invite web flow
  // (notes/20260715-email-invite-web-join-flow-design.md). The caller builds
  // `${consoleUrl}/join/${joinToken}`. Optional so an older control that does
  // not yet mint one still types (the caller then omits the join link).
  joinToken?: string;
}

/** DELETE /members response: the target email + whether a row was actually deactivated. */
export interface RemoveMemberResult {
  email: string;
  removed: boolean;
}

/** The http verbs this client needs; injectable so it is testable with no network. */
export interface WorkspaceMemberClientHttp {
  get: typeof get;
  post: typeof post;
  del: typeof del;
}

const defaultHttp: WorkspaceMemberClientHttp = { get, post, del };

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
 * Add a teammate's email as an active MEMBER of cfg.workspaceId. The acting human
 * is resolved server-side; only an OWNER/ADMIN of the target workspace succeeds.
 * The upsert is role-preserving (see the service): it can only create/reactivate
 * a MEMBER, never elevate or reinstate a privileged row (that path 409s).
 * workspaceId rides in the body (POST carries one).
 */
export async function inviteMember(
  cfg: WorkspaceCliConfig,
  email: string,
  http: WorkspaceMemberClientHttp = defaultHttp,
): Promise<InviteMemberResult> {
  return http.post<InviteMemberResult>(cfg, BASE, {
    email,
    workspaceId: cfg.workspaceId,
  });
}

/**
 * List the active members of cfg.workspaceId. Open to any active member of the
 * target workspace. workspaceId rides in the query string (GET has no body): see
 * the file header on the BUG-3/BUG-4 HOME-workspace fallback.
 */
export async function listMembers(
  cfg: WorkspaceCliConfig,
  http: WorkspaceMemberClientHttp = defaultHttp,
): Promise<ListMembersResult> {
  const path = withQuery(BASE, { workspaceId: cfg.workspaceId });
  return http.get<ListMembersResult>(cfg, path);
}

/**
 * Revoke a MEMBER's access to cfg.workspaceId by email (OWNER/ADMIN only). MEMBER
 * rows only: an owner/admin email 409s. Idempotent: a missing/already-removed
 * MEMBER returns removed=false. Both email and workspaceId ride in the query
 * string (DELETE carries no body): the workspaceId marker is required or the
 * tenant guard would resolve to the session HOME workspace (BUG-3/BUG-4).
 */
export async function removeMember(
  cfg: WorkspaceCliConfig,
  email: string,
  http: WorkspaceMemberClientHttp = defaultHttp,
): Promise<RemoveMemberResult> {
  const path = withQuery(BASE, {
    email,
    workspaceId: cfg.workspaceId,
  });
  return http.del<RemoveMemberResult>(cfg, path);
}
