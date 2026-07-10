// `mla kb promote <doc-id>` / `mla kb promote --reject <doc-id>` (Personal-KB
// posture promotion, Phase 3).
//
// Renamed from `kb share`: "share" read as "invite a teammate", but this verb
// has nothing to do with membership. It flips a SHADOW Personal-KB doc to LIVE,
// i.e. it PROMOTES the doc into the workspace's grounded, agent-visible corpus.
// `kb share` survives as a hidden, deprecated alias in kb.ts (see the dispatch).
//
//   promote <doc-id>          -> PATCH /internal/v1/kb/documents/<id>/posture with
//                                { workspaceId, actorUserId, posture: "LIVE" }. This
//                                promotes the owner's Personal-KB doc from SHADOW to
//                                LIVE: the "promote into the workspace corpus" action.
//   promote --reject <doc-id> -> the owner declines to promote. Makes NO posture call
//                                and NO delete call, so the personal doc survives
//                                untouched at SHADOW. Records the decline locally so
//                                the agent can avoid re-proposing it later (test 16).
//
// Mirrors the kb_personal.ts deps-injection shape: a thin public `runKbPromote`
// that loads the real config (readKbConfig) and wires the real intelPatch +
// rejection recorder, while every collaborator is injectable so the unit test
// drives it offline without touching the network, config, or disk.

import * as fs from "fs";
import * as path from "path";

import { KbCliConfig, readKbConfig, HOME } from "../lib/config";
import { intelPatch, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";

export interface KbPromoteResult {
  rejected: boolean;
  code: number;
}

export interface KbPromoteDeps {
  cfg?: KbCliConfig;
  http?: {
    intelPatch: (
      cfg: KbCliConfig,
      path: string,
      body: unknown,
      timeoutMs?: number,
    ) => Promise<unknown>;
  };
  recordReject?: (cfg: KbCliConfig, docId: string) => void;
}

const USAGE = "Usage: mla kb promote <doc-id> | mla kb promote --reject <doc-id>";

interface ParsedPromoteArgs {
  docId: string;
  reject: boolean;
}

// Parse a single positional <doc-id> plus an optional --reject flag. The flag may
// appear before or after the id (`--reject doc_1` or `doc_1 --reject`). Unknown
// flags, a missing id, or a second positional are usage errors.
export function parseKbPromoteArgs(argv: string[]): ParsedPromoteArgs {
  let docId: string | null = null;
  let reject = false;
  for (const a of argv) {
    if (a === "--reject") {
      reject = true;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${USAGE}`);
    } else if (docId === null) {
      docId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}. ${USAGE}`);
    }
  }
  if (docId === null) {
    throw new Error(`mla kb promote requires a document id. ${USAGE}`);
  }
  // `kb add` / `kb reingest` receipts print the id as `kbdoc:<cuid>`, so
  // operators paste that exact token. The posture route keys on the bare cuid;
  // a `kbdoc:` prefix flowed verbatim into the URL used to 404 with a
  // misleading "intel does not expose the posture endpoint" message. Strip it
  // (mirrors the kb_reingest `kbdoc:` input handling) so both spellings work.
  if (docId.startsWith("kbdoc:")) {
    docId = docId.slice("kbdoc:".length);
    if (docId.length === 0) {
      throw new Error(`mla kb promote requires a document id after 'kbdoc:'. ${USAGE}`);
    }
  }
  return { docId, reject };
}

// The local rejections spool. Path + filename live under the SAME logs directory
// the Phase 1 Active Review store uses (HOME/logs), so both the agent and this
// command resolve their state under one MEETLESS_HOME. Forward-looking plumbing:
// the agent reads this to avoid re-proposing a doc the owner already declined.
//
// The filename + event string keep the legacy `kb-share` spelling on purpose:
// this is an append-only on-disk contract, not a user-facing surface. Renaming it
// would orphan any already-spooled declines for zero operator benefit. The command
// was renamed promote; the durable record name stays stable.
function rejectionsLogPath(): string {
  return path.join(HOME, "logs", "kb-share-rejections.jsonl");
}

// Append one JSON line recording the decline. Best-effort by contract: every
// failure (unwritable dir, EACCES, full disk) is swallowed so the command outcome
// is never affected and the function NEVER throws (the unit test relies on this).
function recordRejectDefault(cfg: KbCliConfig, docId: string): void {
  try {
    const file = rejectionsLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "kb_share_rejected",
        workspaceId: cfg?.workspaceId ?? null,
        ownerUserId: cfg?.actorUserId ?? null,
        docId,
      }) + "\n";
    fs.appendFileSync(file, line);
  } catch {
    // best-effort: never throw, never affect the command outcome.
  }
}

// Surface an intel HTTP failure helpfully, mirroring kb.ts's explainIntelError
// for the postures most likely on a posture flip; falls back to the raw message.
function explainPromoteError(err: HttpError, intelUrl: string): string {
  if (err.status === 404) {
    return `intel returned 404 for the posture route. Document not found, or this intel does not expose the KB posture endpoint.`;
  }
  // Membership 403 (folder marker / --workspace names a workspace you are not
  // in) is not a token problem; route it to the shared canonical line (BUG-5).
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

export async function runKbPromote(argv: string[], deps?: KbPromoteDeps): Promise<KbPromoteResult> {
  let cfg: KbCliConfig;
  try {
    cfg = deps?.cfg ?? readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return { rejected: false, code: 2 };
  }

  let parsed: ParsedPromoteArgs;
  try {
    parsed = parseKbPromoteArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return { rejected: false, code: 2 };
  }

  const patch = deps?.http?.intelPatch ?? intelPatch;
  const recordReject = deps?.recordReject ?? recordRejectDefault;

  // REJECT path: no posture call, no delete. Record the decline and confirm the
  // personal doc is unchanged.
  if (parsed.reject) {
    recordReject(cfg, parsed.docId);
    console.log(
      `Declined to promote ${parsed.docId}. Your personal copy is unchanged (still SHADOW, not deleted).`,
    );
    return { rejected: true, code: 0 };
  }

  // PROMOTE path: flip the posture to LIVE.
  const body = {
    workspaceId: cfg.workspaceId,
    actorUserId: cfg.actorUserId,
    posture: "LIVE",
  };
  try {
    await patch(cfg, `/internal/v1/kb/documents/${parsed.docId}/posture`, body);
  } catch (e) {
    const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
    console.error(explainPromoteError(e as HttpError, intelUrl));
    return { rejected: false, code: 1 };
  }

  console.log(`Promoted ${parsed.docId} to the workspace corpus (posture is now LIVE).`);
  return { rejected: false, code: 0 };
}
