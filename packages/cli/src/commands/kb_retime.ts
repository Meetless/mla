// `mla kb retime <source-item-id> --effective-date <date>` (Phase 5.3).
//
// retime corrects the trusted EFFECTIVE DATE of a source item (a note, a diff, a
// thread) and regenerates the derived relations it anchors. It is the operator's
// front door to the Phase 4 correction path:
//
//   POST /internal/v1/kb/retime -> create_temporal_correction -> regeneration
//
// which honours the Option-3 invariant: an accepted relation is NEVER edited in
// place nor physically deleted. A correction records a new anchor for the source
// item, stales that item's live derived relations (sets invalidated_at, leaving
// valid_at and row identity intact), and re-inserts fresh live edges under the
// corrected anchor through the resolver. So retime edits the SOURCE ITEM, not a
// relation; you never hand-edit a relation's valid_at.
//
// Mirrors the kb_promote.ts deps-injection shape: a thin public `runKbRetime` that
// loads the real config (readKbConfig) and wires the real intelPost, while every
// collaborator is injectable so the unit test drives it offline (no network,
// config, or disk).
//
// Auth + actor: the POST carries Authorization via the shared intel HTTP layer;
// the actor rides in the BODY (intel stamps only Authorization + X-Trace-ID,
// never X-Meetless-Actor), so `actor` comes from cfg.actorUserId in the payload.

import { KbCliConfig, readKbConfig } from "../lib/config";
import { intelPost, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { parseAsOf } from "../lib/temporal";

export interface KbRetimeDeps {
  cfg?: KbCliConfig;
  http?: {
    intelPost: (
      cfg: KbCliConfig,
      path: string,
      body: unknown,
      timeoutMs?: number,
    ) => Promise<unknown>;
  };
}

// The correction receipt the intel endpoint returns.
interface RetimeResponse {
  workspaceId: string;
  sourceItemId: string;
  effectiveDate: string;
  newAnchorId: string;
  priorAnchorId: string | null;
  staledRelationIds: string[];
  regeneratedRelationIds: string[];
  regenerated: boolean;
}

const USAGE =
  "Usage: mla kb retime <source-item-id> --effective-date <date> [--reason <s>] [--anchor-type <t>] [--json]";

interface ParsedRetimeArgs {
  sourceItemId: string;
  effectiveDate: string;
  reason?: string;
  anchorType?: string;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--effective-date", "--reason", "--anchor-type"]);
const BOOLEAN_FLAGS = new Set(["--json"]);

// Parse a single positional <source-item-id>, the required --effective-date, plus
// optional --reason / --anchor-type / --json. A value flag with no following
// value, a missing source id or effective date, a second positional, or an
// unknown flag are all usage errors (the caller maps them to exit 2).
export function parseKbRetimeArgs(argv: string[]): ParsedRetimeArgs {
  let sourceItemId: string | null = null;
  let effectiveDate: string | null = null;
  let reason: string | undefined;
  let anchorType: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`Missing value for ${a}. ${USAGE}`);
      }
      if (a === "--effective-date") effectiveDate = next;
      else if (a === "--reason") reason = next;
      else if (a === "--anchor-type") anchorType = next;
      i++;
    } else if (BOOLEAN_FLAGS.has(a)) {
      json = true;
    } else if (a.startsWith("-")) {
      const supported = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ");
      throw new Error(`Unknown flag: ${a}. Supported: ${supported}. ${USAGE}`);
    } else if (sourceItemId === null) {
      sourceItemId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}. ${USAGE}`);
    }
  }

  if (sourceItemId === null) {
    throw new Error(`mla kb retime requires a source item id. ${USAGE}`);
  }
  if (effectiveDate === null) {
    throw new Error(`mla kb retime requires --effective-date. ${USAGE}`);
  }
  return { sourceItemId, effectiveDate, reason, anchorType, json };
}

// Surface an intel HTTP failure helpfully, mirroring kb_promote.ts's explainPromoteError.
function explainRetimeError(err: HttpError, intelUrl: string): string {
  if (err.status === 404) {
    return `intel returned 404 for the retime route. The source item was not found, or this intel does not expose the KB retime endpoint.`;
  }
  if (err.status === 422) {
    return `intel rejected the correction (HTTP 422): ${err.body ?? err.message}`;
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

// Render the correction receipt in plain words. No double-dash range separators
// (An's AI-smell rule); each line spells out what changed so an operator reads a
// receipt, not a guess.
function renderReceipt(r: RetimeResponse): string {
  const out: string[] = [];
  out.push(`Retimed ${r.sourceItemId}: effective date corrected to ${r.effectiveDate}.`);
  out.push(`  new anchor:      ${r.newAnchorId}`);
  if (r.priorAnchorId) out.push(`  prior anchor:    ${r.priorAnchorId} (superseded, kept for audit)`);
  out.push(`  staled relations: ${r.staledRelationIds.length}`);
  if (r.regenerated) {
    out.push(`  regenerated:     ${r.regeneratedRelationIds.length} live edge(s) under the corrected anchor`);
  } else {
    out.push(`  regenerated:     pending (a concurrent drainer claimed the event; it will regenerate)`);
  }
  out.push("");
  out.push(
    "retime edits the SOURCE ITEM's effective date and regenerates derived relations; it does not edit accepted relations in place.",
  );
  return out.join("\n");
}

export async function runKbRetime(argv: string[], deps?: KbRetimeDeps): Promise<number> {
  let cfg: KbCliConfig;
  try {
    cfg = deps?.cfg ?? readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let parsed: ParsedRetimeArgs;
  try {
    parsed = parseKbRetimeArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // Validate + normalize the effective date client-side so a typo never silently
  // anchors to "now". parseAsOf throws on anything malformed (exit 2, no POST).
  let effectiveDate: string;
  try {
    effectiveDate = parseAsOf(parsed.effectiveDate);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const post = deps?.http?.intelPost ?? intelPost;
  const body: Record<string, unknown> = {
    workspaceId: cfg.workspaceId,
    sourceItemId: parsed.sourceItemId,
    effectiveDate,
    actor: cfg.actorUserId,
  };
  if (parsed.reason !== undefined) body.reason = parsed.reason;
  if (parsed.anchorType !== undefined) body.anchorType = parsed.anchorType;

  let res: RetimeResponse;
  try {
    res = (await post(cfg, "/internal/v1/kb/retime", body)) as RetimeResponse;
  } catch (e) {
    const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;
    console.error(explainRetimeError(e as HttpError, intelUrl));
    return 1;
  }

  if (parsed.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(renderReceipt(res));
  return 0;
}
