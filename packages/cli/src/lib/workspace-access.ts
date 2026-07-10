// src/lib/workspace-access.ts
//
// The ONE place the CLI turns a workspace-membership 403 into human text.
//
// Both server planes reject a call whose EFFECTIVE workspace (resolved from the
// folder `.meetless.json` marker or an explicit --workspace override) names a
// workspace the logged-in user is not a member of. They emit the SAME code and
// the SAME human message; they differ only in envelope shape:
//
//   control (apps/control api-exception.ts workspaceAccessDenied):
//     { statusCode, code: "WORKSPACE_ACCESS_DENIED", message,
//       requestId, details: { requestedWorkspaceId } }
//   intel (app/core/auth.py):
//     { detail: { code: "WORKSPACE_ACCESS_DENIED", message } }
//
// In BOTH, `message` is exactly:
//   "You are not a member of workspace 'X'. Ask a workspace admin to add you to it."
// (intel's message embeds the id too, so it is self-sufficient with no
// server-supplied requestedWorkspaceId field).
//
// buildError (lib/http.ts) sets `.status` and `.body` (the raw response text)
// and inlines the body into `.message`, so a substring test on the code is
// stable across get/post/patch/del AND intelGet/intelPost/intelPatch. Every
// read/lookup command routes its membership 403 through here so the five
// divergent, three-wrong renderings BUG-5 catalogued (a nonexistent
// "controlToken" to check, a false "login expired", a raw internal-URL dump)
// collapse to the single canonical line.

/** Control's + intel's shared 403 code for "not a member of this workspace". */
export const WORKSPACE_ACCESS_DENIED_CODE = "WORKSPACE_ACCESS_DENIED";

/** The shape either plane's denial body parses into (fields best-effort). */
interface DeniedBody {
  code?: string;
  message?: string;
  details?: { requestedWorkspaceId?: string };
  detail?: { code?: string; message?: string };
}

/** The raw response body carried on an HttpError, when it was HTTP (not a socket error). */
function rawBody(e: unknown): string {
  const body = (e as { body?: unknown } | null)?.body;
  return typeof body === "string" ? body : "";
}

function parseBody(e: unknown): DeniedBody | null {
  const body = rawBody(e);
  if (!body) return null;
  try {
    return JSON.parse(body) as DeniedBody;
  } catch {
    // non-JSON body (e.g. an edge proxy rewrote it): fall through to reconstruction
    return null;
  }
}

/**
 * True iff `e` is a 403 whose body carries code WORKSPACE_ACCESS_DENIED. Reads
 * both the raw `.body` and the `.message` (buildError inlines the body into the
 * message) so it holds whether the caller kept the HttpError or re-wrapped it.
 */
export function isWorkspaceAccessDenied(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status !== 403) return false;
  const message = e instanceof Error ? e.message : "";
  return (
    rawBody(e).includes(WORKSPACE_ACCESS_DENIED_CODE) ||
    message.includes(WORKSPACE_ACCESS_DENIED_CODE)
  );
}

/**
 * The workspace id the denied call targeted, if the server disclosed it.
 * Control carries it as details.requestedWorkspaceId; intel does not (its id
 * lives inside the message string), so this returns null for an intel denial.
 */
export function deniedWorkspaceId(e: unknown): string | null {
  const id = parseBody(e)?.details?.requestedWorkspaceId;
  return typeof id === "string" && id ? id : null;
}

/**
 * The single canonical remediation line for a workspace-membership 403. Prefers
 * the server's own message (identical on both planes) so the CLI never drifts
 * from the source of truth; reconstructs it from a known workspace id only when
 * the body is unparseable. `knownWorkspaceId` is the effective workspace the
 * caller already resolved (cfg.workspaceId or the --workspace override) and is
 * used purely for that fallback.
 */
export function workspaceAccessDeniedMessage(
  e: unknown,
  knownWorkspaceId?: string,
): string {
  const parsed = parseBody(e);
  const serverMsg = parsed?.message ?? parsed?.detail?.message;
  if (typeof serverMsg === "string" && serverMsg) return serverMsg;
  const id = knownWorkspaceId || deniedWorkspaceId(e) || "unknown";
  return `You are not a member of workspace '${id}'. Ask a workspace admin to add you to it.`;
}
