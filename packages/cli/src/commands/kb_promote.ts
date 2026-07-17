// `mla kb promote <doc-id>` / `mla kb promote --reject <doc-id>`: promote a
// PERSONAL knowledge doc to TEAM scope (PERSON -> WORKSPACE).
//
// Renamed from `kb share`: "share" read as "invite a teammate", but this verb
// has nothing to do with membership. It moves a doc from your personal scope into
// the workspace's shared, team-visible corpus. `kb share` survives as a hidden,
// deprecated alias in kb.ts. The reverse move is `mla kb demote` (kb_demote.ts).
//
//   promote <doc-id>          -> POST /internal/v1/kb/documents/<id>/scope with
//                                { scope: "WORKSPACE", actorBy, reason? } (workspaceId
//                                as a query param). Flips the doc's scope PERSON ->
//                                WORKSPACE in place and appends a PROMOTE lifecycle
//                                event. The route replaced the PATCH .../posture
//                                endpoint dropped in the 2026-06-21 two-axis cutover.
//   promote --reject <doc-id> -> the owner declines to promote. Makes NO scope call,
//                                so the personal doc survives untouched. Records the
//                                decline locally so the agent can avoid re-proposing
//                                it later (test 16).
//
// Mirrors the kb_personal.ts deps-injection shape: a thin public `runKbPromote`
// that loads the real config (readKbConfig) and wires the real intelPost +
// rejection recorder, while every collaborator is injectable so the unit test
// drives it offline without touching the network, config, or disk. The scope
// flip itself lives in the shared kb_scope.ts (promote and demote share it).

import * as fs from "fs";
import * as path from "path";

import { KbCliConfig, readKbConfig, HOME } from "../lib/config";
import { intelPost, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  KbScopeHttp,
  explainScopeError,
  parseScopeArgs,
  setKbScope,
} from "./kb_scope";

export interface KbPromoteResult {
  rejected: boolean;
  code: number;
}

export interface KbPromoteDeps {
  cfg?: KbCliConfig;
  http?: KbScopeHttp;
  recordReject?: (cfg: KbCliConfig, docId: string) => void;
}

const USAGE =
  "Usage: mla kb promote <doc-id> [--reason <text>] | mla kb promote --reject <doc-id>";

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

export async function runKbPromote(argv: string[], deps?: KbPromoteDeps): Promise<KbPromoteResult> {
  let cfg: KbCliConfig;
  try {
    cfg = deps?.cfg ?? readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return { rejected: false, code: 2 };
  }

  let parsed;
  try {
    parsed = parseScopeArgs(argv, { usage: USAGE, allowReject: true });
  } catch (e) {
    console.error((e as Error).message);
    return { rejected: false, code: 2 };
  }

  const http: KbScopeHttp = deps?.http ?? { intelPost };
  const recordReject = deps?.recordReject ?? recordRejectDefault;

  // REJECT path: no scope call. Record the decline and confirm the personal doc
  // is unchanged.
  if (parsed.reject) {
    recordReject(cfg, parsed.docId);
    console.log(
      `Declined to promote ${parsed.docId}. Your personal copy is unchanged (still Personal, not deleted).`,
    );
    return { rejected: true, code: 0 };
  }

  // PROMOTE path: flip the scope PERSON -> WORKSPACE.
  try {
    await setKbScope(cfg, parsed.docId, "WORKSPACE", parsed.reason, http);
  } catch (e) {
    const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
    console.error(explainScopeError(e as HttpError, intelUrl));
    return { rejected: false, code: 1 };
  }

  console.log(`Promoted ${parsed.docId} to the team (scope is now Team; anyone in the workspace can see it).`);
  return { rejected: false, code: 0 };
}
