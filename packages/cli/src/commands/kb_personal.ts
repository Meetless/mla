// `mla kb personal list` / `mla kb personal show <id>` (Phase 3, Task 3.3).
//
// The owner-scoped view of a user's OWN Personal-KB documents.
//
//   list        -> GET /internal/v1/kb/documents?ownerUserId=<actor>&posture=SHADOW
//                  Lists ONLY the configured actor's ACTIVE personal docs. The
//                  owner is the configured actorUserId (readKbConfig), so a user
//                  can never list another owner's docs from their own CLI.
//   show <id>   -> reuse `mla kb show` (the existing single-doc detail path).
//                  Personal docs render through the same §4.2 detail view; there
//                  is no separate personal detail endpoint to maintain.
//
// Mirrors the kb_pending.ts deps-injection shape: a pure `runKbPersonalWith`
// core takes an injected fetcher (and a show-delegate) so the unit test can
// drive it without touching the network or the real config, while the public
// `runKbPersonal` wrapper wires the real intelGet fetcher and the real
// `runKbShow` delegate.

import { readKbConfig } from "../lib/config";
import { intelGet } from "../lib/http";
import { runKbShow } from "./kb_show";

export interface KbPersonalArgs {
  sub: "list" | "show";
  id: string | null;
  json: boolean;
}

const USAGE = "Usage: mla kb personal list [--json] | mla kb personal show <id>";

// The id `mla kb personal list` prints is a bare KbDocument cuid. `mla kb show`
// (the show delegate) only skips path-resolution when its input parses as
// `kbdoc:<id>`; a bare token is classified as a canonical PATH and 404s. So
// normalize a bare id into the kbdoc: form before delegating, while passing an
// already-prefixed artifact input (kbdoc:/kbdocrev:/note:) through untouched so
// a power user who types the canonical form is never double-prefixed.
const ARTIFACT_PREFIXES = ["kbdoc:", "kbdocrev:", "note:"];
export function normalizePersonalShowId(raw: string): string {
  const t = raw.trim();
  if (ARTIFACT_PREFIXES.some((p) => t.startsWith(p))) return t;
  return `kbdoc:${t}`;
}

export function parseKbPersonalArgs(argv: string[]): KbPersonalArgs {
  const sub = argv[0];
  if (sub !== "list" && sub !== "show") {
    throw new Error(`mla kb personal takes 'list' or 'show'. ${USAGE}`);
  }

  let id: string | null = null;
  let json = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${USAGE}`);
    } else if (sub === "show" && id === null) {
      id = a;
    } else {
      throw new Error(`Unexpected argument: ${a}. ${USAGE}`);
    }
  }

  if (sub === "show" && id === null) {
    throw new Error(`mla kb personal show requires a document id. ${USAGE}`);
  }

  return { sub, id, json };
}

// Build the owner-scoped list query. Always pins posture=SHADOW: personal docs
// are SHADOW-posture by construction (agent-distilled / private), so the list is
// the user's private shadow corpus, never the shared LIVE workspace docs. The
// owner is stamped explicitly so the server filters to this caller's rows only.
export function buildPersonalQuery(workspaceId: string, ownerUserId: string): string {
  const qs = new URLSearchParams();
  qs.set("workspaceId", workspaceId);
  qs.set("ownerUserId", ownerUserId);
  qs.set("posture", "SHADOW");
  return qs.toString();
}

export interface KbPersonalDoc {
  id: string;
  canonicalPath: string | null;
  currentPosture: string | null;
  ownerUserId: string | null;
  updatedAt: string;
}

export interface KbPersonalListResponse {
  // The owner-scoped projection from intel's KbDocumentListResponse.documents.
  documents: KbPersonalDoc[];
}

export interface KbPersonalDeps {
  // Owner-scoped list fetcher (the real impl wraps intelGet against
  // /internal/v1/kb/documents).
  fetchPersonal: (qs: string) => Promise<KbPersonalListResponse>;
  // Single-doc detail delegate (the real impl is `mla kb show <id>`). Returns
  // the show command's exit code.
  showDocument: (id: string) => Promise<number>;
}

export interface KbPersonalCtx {
  workspaceId: string;
  ownerUserId: string;
}

// The result the unit test inspects: the surfaced documents (empty for a show)
// plus the exit code.
export interface KbPersonalResult {
  documents: KbPersonalDoc[];
  code: number;
}

function renderPersonalHuman(ws: string, owner: string, docs: KbPersonalDoc[]): string {
  if (docs.length === 0) {
    return `No personal KB documents for ${owner} (workspace ${ws}).`;
  }
  const lines: string[] = [];
  const n = docs.length;
  lines.push(`${n} personal KB document${n === 1 ? "" : "s"} for ${owner} (workspace ${ws}):`);
  lines.push("");
  for (const d of docs) {
    const path = d.canonicalPath ?? "(no path)";
    const posture = d.currentPosture ?? "?";
    lines.push(`  ${d.id}`);
    lines.push(`    ${path}  [${posture}]  updated ${d.updatedAt}`);
  }
  lines.push("");
  lines.push("Inspect one: mla kb personal show <id>");
  return lines.join("\n");
}

export async function runKbPersonalWith(
  argv: string[],
  ctx: KbPersonalCtx,
  deps: KbPersonalDeps,
): Promise<KbPersonalResult> {
  let parsed: KbPersonalArgs;
  try {
    parsed = parseKbPersonalArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return { documents: [], code: 2 };
  }

  if (parsed.sub === "show") {
    // Reuse the existing single-doc detail path. The id is normalized to the
    // kbdoc: form first (see normalizePersonalShowId): the bare cuid `list`
    // prints would otherwise be treated as a path by `mla kb show` and 404.
    const code = await deps.showDocument(normalizePersonalShowId(parsed.id as string));
    return { documents: [], code };
  }

  // list
  let resp: KbPersonalListResponse;
  try {
    resp = await deps.fetchPersonal(buildPersonalQuery(ctx.workspaceId, ctx.ownerUserId));
  } catch (e) {
    console.error(`Failed to list personal KB documents: ${(e as Error).message}`);
    return { documents: [], code: 1 };
  }

  const documents = resp.documents ?? [];

  if (parsed.json) {
    console.log(JSON.stringify({ workspaceId: ctx.workspaceId, ownerUserId: ctx.ownerUserId, documents }, null, 2));
  } else {
    console.log(renderPersonalHuman(ctx.workspaceId, ctx.ownerUserId, documents));
  }

  return { documents, code: 0 };
}

export async function runKbPersonal(argv: string[]): Promise<number> {
  let cfg: ReturnType<typeof readKbConfig>;
  try {
    cfg = readKbConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const deps: KbPersonalDeps = {
    fetchPersonal: (qs) =>
      intelGet<KbPersonalListResponse>(cfg, `/internal/v1/kb/documents?${qs}`, 12000),
    // Delegate to `mla kb show <id>`: the single-doc detail path is reused
    // wholesale, including its resolve/poll handling and exit codes.
    showDocument: (id) => runKbShow([id]),
  };

  const result = await runKbPersonalWith(
    argv,
    { workspaceId: cfg.workspaceId, ownerUserId: cfg.actorUserId },
    deps,
  );
  return result.code;
}
