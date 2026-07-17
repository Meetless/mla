// Shared core for the PERSON <-> WORKSPACE scope flip behind `mla kb promote`
// (-> WORKSPACE, "share to the team") and `mla kb demote` (-> PERSON, "make it
// personal again").
//
// Both post to POST /internal/v1/kb/documents/<id>/scope, the route that
// replaced PATCH /internal/v1/kb/documents/<id>/posture. That posture route was
// deleted as COLLATERAL in the 2026-06-21 two-axis cutover (intel 77d591c), so
// `mla kb promote` has 404'd ever since and `demote` never existed. The scope
// column is mutable (unlike the immutable RuleAuthorityScope), so this is an
// in-place flip plus one audit event, not the Rules mint+revoke MOVE. Full
// rationale + the collision edge: notes/20260715-kb-scope-promote-demote.md.

import { KbCliConfig } from "../lib/config";
import { HttpError } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";

// The API scope enum. User-facing copy says "Personal" / "Team" (matching the
// Console KnowledgeScopeBadge); the wire enum stays PERSON / WORKSPACE.
export type KbScope = "PERSON" | "WORKSPACE";

// The /scope route echoes the flipped document.
export interface KbScopeResponse {
  documentId: string;
  scope: string;
}

// Injectable transport (mirrors kb_promote's original shape): the unit test
// drives the flip offline; production wires the real intelPost.
export interface KbScopeHttp {
  intelPost: (
    cfg: KbCliConfig,
    path: string,
    body: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
}

export interface ParsedScopeArgs {
  docId: string;
  reject: boolean;
  reason?: string;
}

// Parse `<doc-id> [--reason <text>]`, plus `--reject` only when allowReject is
// set (promote's decline path). `--reason` consumes the next token. A `kbdoc:`
// prefix (printed by `kb add` / `kb reingest` receipts, so operators paste it
// verbatim) is stripped to the bare id; left in place it flowed into the URL and
// 404'd. A missing id, a second positional, a valueless `--reason`, or an
// unknown flag is a usage error.
export function parseScopeArgs(
  argv: string[],
  opts: { usage: string; allowReject: boolean },
): ParsedScopeArgs {
  let docId: string | null = null;
  let reject = false;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reject" && opts.allowReject) {
      reject = true;
    } else if (a === "--reason") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new Error(`--reason needs a value. ${opts.usage}`);
      }
      reason = v;
      i++;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${opts.usage}`);
    } else if (docId === null) {
      docId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}. ${opts.usage}`);
    }
  }
  if (docId === null) {
    throw new Error(`a document id is required. ${opts.usage}`);
  }
  if (docId.startsWith("kbdoc:")) {
    docId = docId.slice("kbdoc:".length);
    if (docId.length === 0) {
      throw new Error(`a document id is required after 'kbdoc:'. ${opts.usage}`);
    }
  }
  return { docId, reject, reason };
}

// POST the scope flip. workspaceId rides as a query param (the route reads it
// there, not in the body); actorBy carries the operator's configured actor for
// the shared-key plane. A cli-session (mla login) IGNORES actorBy and stamps the
// authenticated human, so it cannot be spoofed; supplying it is a harmless
// belt-and-suspenders that also serves the headless shared-key path.
export async function setKbScope(
  cfg: KbCliConfig,
  docId: string,
  scope: KbScope,
  reason: string | undefined,
  http: KbScopeHttp,
): Promise<KbScopeResponse> {
  const qs = new URLSearchParams({ workspaceId: cfg.workspaceId }).toString();
  const body: Record<string, unknown> = { scope, actorBy: cfg.actorUserId };
  if (reason) body.reason = reason;
  const res = await http.intelPost(
    cfg,
    `/internal/v1/kb/documents/${docId}/scope?${qs}`,
    body,
  );
  return res as KbScopeResponse;
}

// Surface a /scope failure helpfully. 409 is the governed edge: promoting a
// source object already shared as a Team doc (KB_SCOPE_SOURCE_ALREADY_SHARED), or
// re-scoping a tombstoned / non-ACTIVE doc (KB_DOCUMENT_NOT_RESCOPABLE); intel's
// message explains which. 404 is document-not-found OR the PERSON-is-private ACL
// (a non-owner promoting someone else's personal doc reads as 404 by design).
export function explainScopeError(err: HttpError, intelUrl: string): string {
  if (err.status === 409) {
    return `intel could not change the scope (HTTP 409): ${err.body || err.message}`;
  }
  if (err.status === 404) {
    return `intel returned 404 for the scope route. The document was not found in this workspace, or it is another member's personal doc that only its owner can share.`;
  }
  if (isWorkspaceAccessDenied(err)) {
    return workspaceAccessDeniedMessage(err);
  }
  if (err.status === 401 || err.status === 403) {
    return `intel rejected the token (HTTP ${err.status}). Run \`mla doctor\` to check your login and workspace access.`;
  }
  if (err.status === undefined) {
    return `intel not reachable at ${intelUrl}. Is it running? Try \`mla doctor\`.`;
  }
  return err.message;
}
