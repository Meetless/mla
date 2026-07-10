// `mla kb accept <doc-id>` / `mla kb reject <doc-id>` (trust verdict).
//
// These record a reviewer's trust verdict on a KB document's HEAD revision:
// accept flips its cached `reviewOutcome` PENDING -> ACCEPTED; reject flips it to
// REJECTED (which also drops the revision from serving per governed liveness, so
// it stops grounding answers). This is the trust axis, distinct from the
// grounding-posture axis (`kb promote`, SHADOW -> LIVE) and the relationship-edge
// axis (`kb review`, which also takes --accept / --reject but decides edges, not
// documents).
//
// Wire contract (intel/app/api/routes/kb_document_review.py). There is exactly
// one document-verdict route; the old per-verb `/accept` and `/reject` routes
// were consolidated into it by the 2026-06-21 slice-A re-home:
//
//   POST /internal/v1/kb/documents/<id>/review?workspaceId=<ws>
//        body { revisionId, outcome: "ACCEPTED"|"REJECTED",
//               expectedPriorOutcome, actorUserId }
//        -> KbReviewResponse (the recorded ReviewEvent)
//
// The route needs the target `revisionId` and its `expectedPriorOutcome` (the
// trust it had when read, for optimistic concurrency). We source both the same
// way the Console does: read the document detail bundle first and take its head
// revision, then POST the verdict against it. Two intel calls, mirroring
// `mla kb show`'s GET-then-render shape:
//
//   GET  /internal/v1/kb/documents/<id>/detail?workspaceId=<ws>  (resolve head)
//   POST /internal/v1/kb/documents/<id>/review?workspaceId=<ws>  (record verdict)
//
// Both act on a DOCUMENT id; a `note:` or `kbdocrev:` input is a usage error, not
// a silent path resolution (run `mla kb show <note>` to find the kbdoc id first).
//
// Auth + actor: the calls carry Authorization via the shared intel HTTP layer;
// the actor rides in the review BODY as actorUserId (cfg.actorUserId). For a
// cli-session caller intel ignores the body actor and stamps the session human;
// the shared-key service plane honors the body actor.

import { KbCliConfig, readKbConfig } from "../lib/config";
import {
  intelGet as realIntelGet,
  intelPost as realIntelPost,
  HttpError,
  DEFAULT_INTEL_URL,
} from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";

export type RevisionAction = "accept" | "reject";

export interface KbRevisionDeps {
  cfg?: KbCliConfig;
  http?: {
    intelGet?: (cfg: KbCliConfig, path: string, timeoutMs?: number) => Promise<unknown>;
    intelPost?: (cfg: KbCliConfig, path: string, body: unknown, timeoutMs?: number) => Promise<unknown>;
  };
}

// The slice of the intel detail bundle we need to resolve the review target: the
// head revision's id and its current trust. Mirrors `mla kb show`'s DetailResponse
// (we read only these two head fields).
interface DetailHeadRevision {
  revisionId: string;
  reviewOutcome: string; // PENDING | ACCEPTED | REJECTED
}
interface DetailBundle {
  document: { documentId: string; currentRevisionId: string | null };
  headRevision: DetailHeadRevision | null;
}

// The recorded verdict intel's /review route returns (KbReviewResponse).
interface KbReviewResponse {
  reviewEventId: string;
  revisionId: string;
  documentId: string;
  eventSequence: number;
  priorOutcome: string;
  newOutcome: string;
  actorId: string;
  reviewMethod: string;
  reviewedAt: string;
  idempotentReplay: boolean;
}

interface ParsedRevisionArgs {
  documentId: string;
  workspace?: string;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--workspace"]);
const BOOLEAN_FLAGS = new Set(["--json"]);

const KBDOC_PREFIX = "kbdoc:";

// accept -> the trust band we move the head revision to.
const OUTCOME: Record<RevisionAction, "ACCEPTED" | "REJECTED"> = {
  accept: "ACCEPTED",
  reject: "REJECTED",
};

function usage(action: RevisionAction): string {
  return `Usage: mla kb ${action} <kbdoc:<id>|<doc-id>> [--workspace <id>] [--json]`;
}

// Parse a single positional document id, plus optional --workspace / --json. The
// id may carry the canonical `kbdoc:` prefix (stripped to the raw id for the URL
// path) or be bare. A `note:` or `kbdocrev:` input is rejected: the verb is keyed
// on a document id (the revision is resolved from the document's head), so neither
// a note path nor a specific revision id is a valid target. The action only shapes
// the error text; both verbs share this grammar.
export function parseKbRevisionArgs(argv: string[], action: RevisionAction = "accept"): ParsedRevisionArgs {
  let documentId: string | null = null;
  let workspace: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`Missing value for ${a}. ${usage(action)}`);
      }
      if (a === "--workspace") workspace = next;
      i++;
    } else if (BOOLEAN_FLAGS.has(a)) {
      json = true;
    } else if (a.startsWith("-")) {
      const supported = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ");
      throw new Error(`Unknown flag: ${a}. Supported: ${supported}. ${usage(action)}`);
    } else if (documentId === null) {
      documentId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}. ${usage(action)}`);
    }
  }

  if (documentId === null) {
    throw new Error(`mla kb ${action} requires a document id. ${usage(action)}`);
  }

  const trimmed = documentId.trim();
  if (trimmed.startsWith("note:")) {
    throw new Error(
      `mla kb ${action} acts on a document id, not a note path. ` +
        `Run \`mla kb show ${trimmed}\` to find its kbdoc id, then \`mla kb ${action} kbdoc:<id>\`.`,
    );
  }
  if (trimmed.startsWith("kbdocrev:")) {
    throw new Error(
      `mla kb ${action} acts on a document id, not a revision id. The verb resolves ` +
        `the document's head revision itself; pass the kbdoc id instead.`,
    );
  }

  const id = trimmed.startsWith(KBDOC_PREFIX) ? trimmed.slice(KBDOC_PREFIX.length).trim() : trimmed;
  if (!id) {
    throw new Error(`mla kb ${action} requires a non-empty document id. ${usage(action)}`);
  }
  return { documentId: id, workspace, json };
}

// Surface an intel HTTP failure helpfully. Shared by the detail GET and the
// review POST; `stage` names which call failed so a 404 on the resolve step reads
// differently from a 404 on the verdict step.
function explainReviewError(
  action: RevisionAction,
  stage: "resolve" | "review",
  err: HttpError,
  intelUrl: string,
): string {
  if (err.status === 404) {
    const detail = err.body ? ` Details: ${err.body.slice(0, 200)}` : "";
    if (stage === "resolve") {
      return `intel returned 404: no KB document matches that id in this workspace.${detail}`;
    }
    return (
      `intel returned 404: the document or its head revision was not found in this workspace ` +
      `(it may have changed since it was read).${detail}`
    );
  }
  if (err.status === 409) {
    return (
      `intel returned 409: this document's trust verdict moved since it was read ` +
      `(a concurrent reviewer got there first). Re-run \`mla kb ${action}\` to pick up the new state. ` +
      `Details: ${err.body ?? err.message}`
    );
  }
  if (err.status === 400) {
    return `intel returned 400: ${err.body ?? err.message}`;
  }
  // Membership 403 (folder marker / --workspace names a workspace you are not
  // in) is not a token problem; route it to the shared canonical line (BUG-5).
  if (isWorkspaceAccessDenied(err)) {
    return workspaceAccessDeniedMessage(err);
  }
  if (err.status === 401 || err.status === 403) {
    return `intel rejected the request (HTTP ${err.status}). Run \`mla doctor\` to check your login and workspace access.`;
  }
  if (err.status === undefined) {
    return `intel not reachable at ${intelUrl}. Is it running? Try \`mla doctor\`.`;
  }
  return err.message;
}

// Render the verdict receipt in plain words. No double-dash range separators
// (An's AI-smell rule); `->` matches how `mla kb show` renders trust transitions.
function renderReceipt(action: RevisionAction, r: KbReviewResponse): string {
  const out: string[] = [];
  const verb = action === "accept" ? "Accepted" : "Rejected";
  out.push(`${verb} kbdoc:${r.documentId}.`);
  out.push(`  revision: ${r.revisionId}`);
  out.push(`  trust:    ${r.priorOutcome} -> ${r.newOutcome} (event #${r.eventSequence})`);
  out.push(`  by:       ${r.actorId} at ${r.reviewedAt} (${r.reviewMethod})`);
  out.push("");
  if (r.newOutcome === "ACCEPTED") {
    out.push("The head revision is now trusted; it keeps grounding answers under an ACCEPTED band.");
  } else {
    out.push("REJECTED drops the head revision from serving per governed liveness; it no longer grounds answers.");
  }
  if (r.idempotentReplay) {
    out.push("(idempotent replay: this matched a prior verdict and wrote no new event.)");
  }
  return out.join("\n");
}

async function runRevisionReview(
  action: RevisionAction,
  argv: string[],
  deps?: KbRevisionDeps,
): Promise<number> {
  let parsed: ParsedRevisionArgs;
  try {
    parsed = parseKbRevisionArgs(argv, action);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = deps?.cfg ?? readKbConfig(parsed.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const intelGet = deps?.http?.intelGet ?? realIntelGet;
  const intelPost = deps?.http?.intelPost ?? realIntelPost;
  const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
  const ws = encodeURIComponent(cfg.workspaceId);
  const docId = encodeURIComponent(parsed.documentId);

  // 1. Resolve the head revision + its current trust (the /review target). Same
  //    detail bundle `mla kb show` reads; we take only the head fields.
  let detail: DetailBundle;
  try {
    detail = (await intelGet(cfg, `/internal/v1/kb/documents/${docId}/detail?workspaceId=${ws}`)) as DetailBundle;
  } catch (e) {
    console.error(explainReviewError(action, "resolve", e as HttpError, intelUrl));
    return 1;
  }

  const head = detail.headRevision;
  if (!head) {
    console.error(
      `kbdoc:${parsed.documentId} has no head revision to ${action} ` +
        `(it may still be ingesting or failed to activate). Check \`mla kb show kbdoc:${parsed.documentId}\`.`,
    );
    return 1;
  }

  const targetOutcome = OUTCOME[action];
  // Already at the target trust: report a clean no-op instead of POSTing a
  // same-state verdict (which the route may treat as stale / a no-op event).
  if (head.reviewOutcome === targetOutcome) {
    console.log(`kbdoc:${parsed.documentId} is already ${targetOutcome} (no change).`);
    return 0;
  }

  // 2. Record the verdict against the resolved head revision. expectedPriorOutcome
  //    is the trust we just read: intel 409s if a concurrent reviewer moved it.
  const body: Record<string, unknown> = {
    revisionId: head.revisionId,
    outcome: targetOutcome,
    expectedPriorOutcome: head.reviewOutcome,
    actorUserId: cfg.actorUserId,
  };

  let res: KbReviewResponse;
  try {
    res = (await intelPost(cfg, `/internal/v1/kb/documents/${docId}/review?workspaceId=${ws}`, body)) as KbReviewResponse;
  } catch (e) {
    console.error(explainReviewError(action, "review", e as HttpError, intelUrl));
    return 1;
  }

  if (parsed.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(renderReceipt(action, res));
  return 0;
}

export async function runKbAccept(argv: string[], deps?: KbRevisionDeps): Promise<number> {
  return runRevisionReview("accept", argv, deps);
}

export async function runKbReject(argv: string[], deps?: KbRevisionDeps): Promise<number> {
  return runRevisionReview("reject", argv, deps);
}
