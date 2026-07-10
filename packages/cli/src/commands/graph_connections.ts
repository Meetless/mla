// `mla graph connections [--limit <n>] [--json]`
//
// Lists the CLAIM-GRAIN pending relationship connections — Intel's born-PENDING
// RelationAssertions — which are exactly what the console `/relationships` page
// shows. This is the SECOND, independent pending-relationship surface:
//   * `mla graph review` / `mla kb review` -> control's artifact-grain
//     relationship_candidates (typed edges between docs).
//   * `mla graph connections` (this)      -> intel's claim-grain relation
//     assertions (the /relationships queue).
// They are different queues; an operator who saw "no candidates" from the first
// was still blind to a real backlog in the second. That was the reported bug.
//
// Intel's read endpoint is internal-key-only, so the CLI cannot call it with a
// user token. Control proxies the read (GET /internal/v1/relation-assertions/
// pending), scoped to the caller's session workspace — same pattern the console
// uses server-side. Verdicts are NOT recorded from the CLI: they go through the
// MCP `relationship_verdict` tool (the claim-grain decision path). This command
// is discovery + a pointer to that path and the console.

import { loadWorkspaceConfig, WorkspaceCliConfig, getConsoleUrl, consoleDeepLinkFrom } from "../lib/config";
import { get } from "../lib/http";

// One pending relation assertion as Control proxies it from Intel. Loose on
// purpose: Control forwards Intel's payload verbatim, so we read the fields we
// render and tolerate the rest.
export interface RelationAssertionItem {
  assertionId: string;
  relationType: string;
  subjectLabel?: string | null;
  objectLabel?: string | null;
  subjectStableIdentity?: string | null;
  objectStableIdentity?: string | null;
  reviewOutcome?: string | null;
  createdAt?: string | null;
}

export interface PendingConnectionsResponse {
  items: RelationAssertionItem[];
  // FULL pending backlog for the workspace (the console badge number), which can
  // exceed items.length when the page is capped by --limit.
  count: number;
}

export interface GraphConnectionsArgs {
  json: boolean;
  limit: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500; // control route caps at 500 (@Max)
const USAGE = "Usage: mla graph connections [--limit <n>] [--json]";

export function parseGraphConnectionsArgs(argv: string[]): GraphConnectionsArgs {
  let json = false;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--limit") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--limit requires a value");
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      limit = n;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${USAGE}`);
    } else {
      throw new Error(`mla graph connections takes no positional args. ${USAGE}`);
    }
  }

  return { json, limit };
}

// Prefer the human label; fall back to the stable identity (e.g. "claim:<uuid>")
// so a row is never blank when Intel could not resolve a display label.
function endpointLabel(
  label: string | null | undefined,
  stableIdentity: string | null | undefined,
): string {
  const l = (label ?? "").trim();
  if (l) return l;
  const s = (stableIdentity ?? "").trim();
  return s || "(unknown)";
}

function truncate(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

export interface ConnectionsView {
  workspaceId: string;
  consoleBase: string;
  count: number;
  items: RelationAssertionItem[];
}

export function renderConnectionsJson(view: ConnectionsView): string {
  return JSON.stringify(
    {
      workspaceId: view.workspaceId,
      count: view.count,
      shown: view.items.length,
      // Verdicts on these are recorded via the MCP relationship_verdict tool, NOT
      // any `mla` verb — state that once, machine-readably, so an agent does not
      // hunt for a nonexistent `mla graph connections --accept`.
      verdictPath: "mcp:relationship_verdict",
      consoleUrl: consoleDeepLinkFrom(view.consoleBase, view.workspaceId, "/relationships"),
      connections: view.items.map((it) => ({
        assertionId: it.assertionId,
        relationType: it.relationType,
        subject: {
          label: it.subjectLabel ?? null,
          stableIdentity: it.subjectStableIdentity ?? null,
        },
        object: {
          label: it.objectLabel ?? null,
          stableIdentity: it.objectStableIdentity ?? null,
        },
        reviewOutcome: it.reviewOutcome ?? null,
        createdAt: it.createdAt ?? null,
      })),
    },
    null,
    2,
  );
}

export function renderConnectionsHuman(view: ConnectionsView): string {
  if (view.count === 0 && view.items.length === 0) {
    return `No pending relationship connections (workspace ${view.workspaceId}).`;
  }

  const lines: string[] = [];
  const shown = view.items.length;
  // Distinguish the page from the backlog: "showing 200 of 2657" is the honest
  // statement, and it is the exact number the console badge reports.
  const header =
    view.count > shown
      ? `${view.count} pending relationship connection${view.count === 1 ? "" : "s"} (showing ${shown}) in workspace ${view.workspaceId}:`
      : `${view.count} pending relationship connection${view.count === 1 ? "" : "s"} in workspace ${view.workspaceId}:`;
  lines.push(header);
  lines.push("");

  for (const it of view.items) {
    const subject = truncate(endpointLabel(it.subjectLabel, it.subjectStableIdentity));
    const object = truncate(endpointLabel(it.objectLabel, it.objectStableIdentity));
    lines.push(`  [${it.relationType}] ${subject}`);
    lines.push(`      -> ${object}`);
    lines.push(`      id ${it.assertionId}`);
    lines.push("");
  }

  if (view.count > shown) {
    lines.push(`Showing ${shown} of ${view.count}. Use --limit ${MAX_LIMIT} to widen the page, or review in the console.`);
    lines.push("");
  }

  // These are claim-grain assertions; the verdict path is the MCP tool, not an
  // `mla` verb. Point both the human and any coding agent at it explicitly so no
  // one hunts for a CLI accept/reject that does not exist for this surface.
  lines.push("These are claim-grain relationship connections pending review.");
  lines.push("Record a verdict with the Meetless MCP tool `relationship_verdict`,");
  lines.push(`or review them in the console: ${consoleDeepLinkFrom(view.consoleBase, view.workspaceId, "/relationships")}`);
  return lines.join("\n");
}

export interface GraphConnectionsDeps {
  fetchPending: (workspaceId: string, limit: number) => Promise<PendingConnectionsResponse>;
}

export async function runGraphConnectionsWith(
  argv: string[],
  ctx: { workspaceId: string; consoleBase: string },
  deps: GraphConnectionsDeps,
): Promise<number> {
  let parsed: GraphConnectionsArgs;
  try {
    parsed = parseGraphConnectionsArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let res: PendingConnectionsResponse;
  try {
    res = await deps.fetchPending(ctx.workspaceId, parsed.limit);
  } catch (e) {
    // A control 502 (Intel unreachable) lands here as an HttpError. Surface it as
    // a failure + non-zero exit — NEVER a silent "0 pending", which is the bug
    // class we are fixing.
    console.error(`Failed to list pending relationship connections: ${(e as Error).message}`);
    return 1;
  }

  const items = Array.isArray(res.items) ? res.items : [];
  const count = typeof res.count === "number" ? res.count : items.length;
  const view: ConnectionsView = {
    workspaceId: ctx.workspaceId,
    consoleBase: ctx.consoleBase,
    count,
    items,
  };

  console.log(parsed.json ? renderConnectionsJson(view) : renderConnectionsHuman(view));
  return 0;
}

export async function runGraphConnections(argv: string[]): Promise<number> {
  let cfg: WorkspaceCliConfig;
  try {
    cfg = loadWorkspaceConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const consoleBase = getConsoleUrl(cfg);

  const deps: GraphConnectionsDeps = {
    fetchPending: (workspaceId, limit) => {
      const qs = new URLSearchParams({
        workspaceId,
        limit: String(limit),
      });
      return get<PendingConnectionsResponse>(
        cfg,
        `/internal/v1/relation-assertions/pending?${qs.toString()}`,
        12000,
      );
    },
  };

  return runGraphConnectionsWith(argv, { workspaceId: cfg.workspaceId, consoleBase }, deps);
}
