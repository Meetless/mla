// `mla kb demote <doc-id>`: demote a TEAM knowledge doc back to PERSONAL scope
// (WORKSPACE -> PERSON). The reverse of `mla kb promote`.
//
//   demote <doc-id> [--reason <text>]
//        -> POST /internal/v1/kb/documents/<id>/scope with { scope: "PERSON",
//           actorBy, reason? } (workspaceId as a query param). Flips the doc's
//           scope WORKSPACE -> PERSON in place and appends a DEMOTE lifecycle
//           event. The retained owner (ruling 20 keeps ownerUserId non-null even
//           while shared) receives the doc back; nothing is deleted and no claim
//           is dropped -- demote only narrows visibility, and re-promoting undoes
//           it. Any workspace member may demote (strictly less destructive than
//           the tombstone any member can already do).
//
// Mirrors runKbPromote's deps-injection shape and shares the scope flip itself
// with it via kb_scope.ts. Demote has no `--reject` path: there is nothing to
// decline -- the doc is already shared and the operator is pulling it back.

import { KbCliConfig, readKbConfig } from "../lib/config";
import { intelPost, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  KbScopeHttp,
  explainScopeError,
  parseScopeArgs,
  setKbScope,
} from "./kb_scope";

export interface KbDemoteResult {
  code: number;
}

export interface KbDemoteDeps {
  cfg?: KbCliConfig;
  http?: KbScopeHttp;
}

const USAGE = "Usage: mla kb demote <doc-id> [--reason <text>]";

export async function runKbDemote(argv: string[], deps?: KbDemoteDeps): Promise<KbDemoteResult> {
  let cfg: KbCliConfig;
  try {
    cfg = deps?.cfg ?? readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return { code: 2 };
  }

  let parsed;
  try {
    parsed = parseScopeArgs(argv, { usage: USAGE, allowReject: false });
  } catch (e) {
    console.error((e as Error).message);
    return { code: 2 };
  }

  const http: KbScopeHttp = deps?.http ?? { intelPost };

  try {
    await setKbScope(cfg, parsed.docId, "PERSON", parsed.reason, http);
  } catch (e) {
    const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
    console.error(explainScopeError(e as HttpError, intelUrl));
    return { code: 1 };
  }

  console.log(`Demoted ${parsed.docId} to Personal (scope is now Personal; only you can see it). Re-share it any time with \`mla kb promote\`.`);
  return { code: 0 };
}
