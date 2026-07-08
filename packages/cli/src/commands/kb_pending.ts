// `mla kb review [--all | --session <sid|current|latest> | --doc <id>] [--json]`
// (list mode; the same runner also backs the deprecated `mla kb pending` alias).
//
// B5 (notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3). Lists the
// PENDING_REVIEW relationship candidates a human (or an agent proxy) must decide on.
// Reads the control list route (GET /internal/v1/relationship-candidates) at its
// default view (PENDING_REVIEW + LIVE posture) -- the same queue the Console review
// inbox shows.
//
// Scope (notes/20260607-mla-kb-pending-session-scope-and-bulk-discard-plan.md):
//   * default (no flag): the CURRENT session if $CLAUDE_CODE_SESSION_ID is set, else
//     the full workspace queue. Parallel coding agents each see only the candidates
//     touching docs THEIR session produced.
//   * `--all`: the full workspace queue.
//   * `--session <sid|current|latest>`: an explicit session scope.
//   * `--doc <id>`: scope to one artifact. A value containing ":" is treated as a
//     fully-qualified artifactId (e.g. "note:notes/foo.md", "jira:PDM-9"); a bare
//     path is treated as a notePath the route resolves to "note:<rel>".
//
//   * Human view: the "needs your decision" digest (one line per candidate: type,
//     source -> target, confidence, detector, evidence snippet, Console deep link).
//     No in-terminal relationship graph; the Console is the deep-work surface.
//   * `--json`: structured for an automated proxy, each candidate annotated with its
//     mechanical-validity verdict so the agent knows which ones it may auto-reject
//     via `mla kb review --reject --agent` (P2 reject-only policy).

import { loadWorkspaceConfig, WorkspaceCliConfig, getConsoleUrl } from "../lib/config";
import { get } from "../lib/http";
import { writePendingCountCache } from "../lib/governance-cache";
import {
  RelationshipCandidate,
  classifyMechanicalInvalidity,
  MechanicalVerdict,
  candidateConsoleUrl,
} from "../lib/kb-candidate";
import {
  SessionScopeResult,
  candidateInSession,
  loadSessionScope as loadSessionScopeImpl,
} from "../lib/session-scope";
import { buildPendingCandidateQuery } from "../lib/relationship-candidate-query";

export type PendingScope =
  | { kind: "default" } // no flag: current session if available, else workspace
  | { kind: "workspace" } // --all
  | { kind: "session"; value: string } // --session <sid|current|latest>
  | { kind: "doc"; doc: string }; // --doc <id>

export interface KbPendingArgs {
  scope: PendingScope;
  json: boolean;
}

const USAGE =
  "Usage: mla kb review [--all | --session <sid|current|latest> | --doc <id>] [--json]";

// Verdict flags belong on `mla kb review <id> <flag>`; if one leads (so the
// overload routes here to list mode), give a targeted hint instead of a generic
// "unknown flag".
const VERDICT_FLAGS = new Set(["--accept", "--reject", "--reclassify", "--no-relation"]);

export function parseKbPendingArgs(argv: string[]): KbPendingArgs {
  let json = false;
  let all = false;
  let session: string | null = null;
  let doc: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--all") {
      all = true;
    } else if (a === "--session") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--session requires a value");
      session = v;
    } else if (a === "--doc") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--doc requires a value");
      doc = v;
    } else if (VERDICT_FLAGS.has(a)) {
      throw new Error(`To record a verdict, pass the candidate id first: mla kb review <candidate-id> ${a}`);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. ${USAGE}`);
    } else {
      throw new Error(`mla kb review (list mode) takes no positional args; pass a scope flag. ${USAGE}`);
    }
  }

  const set = (all ? 1 : 0) + (session !== null ? 1 : 0) + (doc !== null ? 1 : 0);
  if (set > 1) {
    throw new Error(`Pass at most one of --all, --session, or --doc. ${USAGE}`);
  }

  let scope: PendingScope;
  if (all) scope = { kind: "workspace" };
  else if (session !== null) scope = { kind: "session", value: session };
  else if (doc !== null) scope = { kind: "doc", doc };
  else scope = { kind: "default" };

  return { scope, json };
}

// A-0 (A4): the governance action vocabulary. The agent may propose / triage /
// auto-clear (the LEFT list); ACCEPT and APPLY_CORRECTION are governed changes
// made under the user's authority and are NOT in the agent's allowed set (a
// scoped AGENT_PROXY credential is denied them outright, A-1b). Defined once and
// reused by the --json output (surface 3) here; the static <meetless-context>
// hook block (surface 2, A-0c) mirrors this exact vocabulary so the agent reads
// one policy across both channels.
export const ALLOWED_AGENT_ACTIONS = [
  "triage",
  "recommend",
  "defer",
  "propose_correction",
  "auto_reject_mechanical_only",
] as const;
export const USER_CONFIRM_ACTIONS = ["accept", "apply_correction"] as const;
const GOVERNANCE_NOTE =
  "accept and apply_correction are governed changes made under the user's authority; " +
  "by default propose and let the user confirm. A scoped AGENT_PROXY credential is denied these outright.";

// Per-candidate verbs an agent may take WITHOUT user confirmation. "triage" is the
// umbrella activity (top-level only); the concrete per-candidate verbs are these,
// plus auto_reject_mechanical_only ONLY when the candidate is mechanically invalid.
function agentActionsFor(mechanical: MechanicalVerdict): {
  allowed: string[];
  userConfirm: string[];
} {
  const allowed = ["recommend", "defer", "propose_correction"];
  if (mechanical.autoRejectable) allowed.push("auto_reject_mechanical_only");
  return { allowed, userConfirm: [...USER_CONFIRM_ACTIONS] };
}

export interface PendingCandidateView {
  candidate: RelationshipCandidate;
  mechanical: MechanicalVerdict;
  consoleUrl: string;
}

export interface ScopeMeta {
  kind: "workspace" | "session" | "doc";
  doc?: string; // present for kind === "doc": the --doc value that was applied
  sessionId?: string;
  source?: "explicit" | "current-env" | "latest-store";
  sessionDocCount?: number;
  fetchedCount: number;
  displayedCount: number;
  truncated: boolean;
}

export interface PendingView {
  workspaceId: string;
  consoleBase: string;
  truncated: boolean;
  rows: PendingCandidateView[];
  scope: ScopeMeta;
  scopeNote: string | null;
}

export function buildPendingView(
  items: RelationshipCandidate[],
  ctx: {
    workspaceId: string;
    consoleBase: string;
    truncated: boolean;
    scope: ScopeMeta;
    scopeNote: string | null;
  },
): PendingView {
  return {
    workspaceId: ctx.workspaceId,
    consoleBase: ctx.consoleBase,
    truncated: ctx.truncated,
    scope: ctx.scope,
    scopeNote: ctx.scopeNote,
    rows: items.map((candidate) => ({
      candidate,
      mechanical: classifyMechanicalInvalidity(candidate),
      consoleUrl: candidateConsoleUrl(ctx.consoleBase, candidate.id),
    })),
  };
}

export function renderPendingJson(view: PendingView): string {
  return JSON.stringify(
    {
      workspaceId: view.workspaceId,
      scope: view.scope,
      count: view.rows.length,
      truncated: view.truncated,
      // A-0 surface 3: a top-level policy summary so a programmatic agent reads
      // the governance rule once instead of inferring it from per-row prose. This
      // mirrors the static hook block's compact form (A-0c).
      governance: {
        pendingCount: view.rows.length,
        allowedAgentActions: [...ALLOWED_AGENT_ACTIONS],
        userConfirmActions: [...USER_CONFIRM_ACTIONS],
        note: GOVERNANCE_NOTE,
      },
      candidates: view.rows.map((r) => ({
        id: r.candidate.id,
        relationType: r.candidate.relationTypeId,
        source: { type: r.candidate.sourceType, artifactId: r.candidate.sourceArtifactId },
        target: { type: r.candidate.targetType, artifactId: r.candidate.targetArtifactId },
        confidence: r.candidate.confidence,
        status: r.candidate.statusId,
        posture: r.candidate.postureId,
        reviewMode: r.candidate.reviewModeId,
        detector: r.candidate.detectorFamily,
        detectorVersion: r.candidate.detectorVersion,
        createdAt: r.candidate.createdAt,
        evidence: {
          sourceQuote: r.candidate.evidenceJson?.sourceQuote ?? null,
          targetQuote: r.candidate.evidenceJson?.targetQuote ?? null,
          reasoning: r.candidate.evidenceJson?.reasoning ?? null,
        },
        autoRejectable: r.mechanical.autoRejectable,
        autoRejectReasonCode: r.mechanical.reasonCode,
        autoRejectReason: r.mechanical.reason,
        // Per-candidate verbs: what THIS agent may do to THIS candidate without a
        // user confirmation (auto_reject_mechanical_only appears only when the row
        // is mechanically invalid), vs the governed verbs that need the user.
        agentActions: agentActionsFor(r.mechanical),
        consoleUrl: r.consoleUrl,
      })),
    },
    null,
    2,
  );
}

function snippet(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

export function renderPendingHuman(view: PendingView): string {
  if (view.rows.length === 0) {
    const base = `No relationship candidates pending review (workspace ${view.workspaceId}).`;
    // Cross-surface pointer: this queue is control's artifact-grain candidates.
    // Intel's claim-grain relation assertions (the console /relationships page)
    // are a SEPARATE queue this command never shows. Without this line, an empty
    // result here reads as "nothing pending anywhere", which is exactly the trap
    // an operator fell into. `mla graph connections` lists that other queue.
    const pointer =
      "Note: claim-grain relationship connections (the console /relationships queue) " +
      "are a separate surface. List them with `mla graph connections`.";
    const body = `${base}\n${pointer}`;
    return view.scopeNote ? `${view.scopeNote}\n${body}` : body;
  }

  const lines: string[] = [];
  if (view.scopeNote) {
    lines.push(view.scopeNote);
    lines.push("");
  }
  const n = view.rows.length;
  lines.push(`${n} relationship candidate${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} your decision (workspace ${view.workspaceId}):`);
  lines.push("");

  for (const r of view.rows) {
    const c = r.candidate;
    const target = c.targetArtifactId ?? "(unary)";
    lines.push(`  [${c.relationTypeId}] ${c.sourceArtifactId} -> ${target}   conf ${c.confidence.toFixed(2)}  ${c.detectorFamily}`);
    const src = snippet(c.evidenceJson?.sourceQuote);
    const tgt = snippet(c.evidenceJson?.targetQuote);
    if (src || tgt) lines.push(`    "${src}" vs "${tgt}"`);
    lines.push(`    id ${c.id}`);
    lines.push(`    review: ${r.consoleUrl}`);
    if (r.mechanical.autoRejectable) {
      lines.push(`    -> auto-rejectable (${r.mechanical.reasonCode}); agent may run: mla kb review ${c.id} --reject --agent`);
    }
    lines.push("");
  }

  if (view.truncated) {
    lines.push("The workspace queue exceeded the fetch cap; some candidates are not shown. Narrow with --doc <id>.");
    lines.push("");
  }

  // A-0 (A4 surface 1): the CLI caller is UNKNOWN (a human and a coding agent run
  // the identical command), so this block dual-addresses both in one message
  // rather than guessing. Only rendered when the queue is non-empty (the count==0
  // path returns the plain "no candidates" line above). The wording is the one
  // agreed with An (plan §A4): the agent should offer to triage, but accepting an
  // edge or applying a correction is a governed change under the user's authority,
  // so the UX default is propose-first (NOT a hard server block; the server gate
  // restricts only AGENT_PROXY, A-1).
  lines.push("These candidates are pending review in this workspace.");
  lines.push("- If you are the user: you can ask your coding agent to triage these for you.");
  lines.push("- If you are the agent: you may triage them now, and you should offer to. Read");
  lines.push("  both documents, recommend a verdict, auto-clear ONLY mechanically-invalid ones,");
  lines.push("  and propose the correct type when one is mis-classified.");
  lines.push("Accepting an edge or applying a correction is a governed change made under the");
  lines.push("user's authority; by default propose it and let the user confirm.");
  lines.push("");
  lines.push(`Triage:    mla kb review <id> --accept | --reject [--note "..."]`);
  lines.push(`Auto-clear (mechanically-invalid only): mla kb review <id> --reject --agent`);
  lines.push("");
  lines.push("Claim-grain relationship connections (the console /relationships queue) are a");
  lines.push("separate surface not shown here; list them with `mla graph connections`.");
  return lines.join("\n");
}

export interface KbPendingDeps {
  fetchPending: (qs: string) => Promise<{ items: RelationshipCandidate[]; nextCursor: unknown }>;
  // Resolves a session value to its sid + produced-doc keys. Tests inject a stub;
  // production wires the real lib closure. Throws SessionScopeError when an
  // explicit session can't resolve.
  loadSessionScope?: (
    sessionValue: string,
    opts: { env: NodeJS.ProcessEnv; workspaceId: string; nowMs: number },
  ) => SessionScopeResult;
}

const PAGE_LIMIT = 200; // route hard cap (@Max(200))
const MAX_PAGES = 25; // backstop: 5000 candidates before we stop and flag truncation

// Follow the route's cursor to completion so the workspace count and the session
// filter both operate on the full set, not a capped first page. Stops at MAX_PAGES
// (truncated=true) as a runaway backstop. The cursor comes from our own control
// route, so a missing id/createdAt or an unparseable date is a server bug; fail
// LOUD rather than build a corrupt cursor and silently mis-paginate.
export async function fetchAllPending(
  fetchPending: KbPendingDeps["fetchPending"],
  workspaceId: string,
  doc: string | null,
): Promise<{ items: RelationshipCandidate[]; truncated: boolean }> {
  const items: RelationshipCandidate[] = [];
  let cursor: { id: string; createdAt: string } | null = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetchPending(buildPendingCandidateQuery(workspaceId, doc, PAGE_LIMIT, cursor));
    if (Array.isArray(res.items)) items.push(...res.items);
    const nc = res.nextCursor as { id?: unknown; createdAt?: unknown } | null | undefined;
    if (!nc) return { items, truncated: false };

    if (typeof nc !== "object" || typeof nc.id !== "string" || nc.id === "") {
      throw new Error("Malformed relationship-candidates cursor from control (missing id)");
    }
    const rawDate = nc.createdAt;
    const createdAt =
      typeof rawDate === "string"
        ? rawDate
        : rawDate instanceof Date
          ? rawDate.toISOString()
          : null;
    if (createdAt === null || Number.isNaN(Date.parse(createdAt))) {
      throw new Error("Malformed relationship-candidates cursor from control (bad createdAt)");
    }
    cursor = { id: nc.id, createdAt };
  }
  return { items, truncated: true };
}

export async function runKbPendingWith(
  argv: string[],
  // A-0c (A4 surface 2): onWorkspaceCount reports the WORKSPACE-WIDE pending count
  // so the production entrypoint can drop it in the local cache the prompt-submit
  // hook reads (Patch 8: no new hot-path network call; this count is free, we
  // already fetched the queue). Reported ONLY for a non-doc scope (a `--doc` view is
  // a subset and must never overwrite the cache) and ONLY when not truncated.
  // Injected so unit tests can spy without touching the real home.
  ctx: {
    workspaceId: string;
    consoleBase: string;
    env?: NodeJS.ProcessEnv;
    onWorkspaceCount?: (count: number) => void;
  },
  deps: KbPendingDeps,
): Promise<number> {
  let parsed: KbPendingArgs;
  try {
    parsed = parseKbPendingArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = ctx.env ?? process.env;

  // Resolve "default": a current session if one is available, else the full queue.
  let effective: PendingScope = parsed.scope;
  if (effective.kind === "default") {
    const sid = (env.CLAUDE_CODE_SESSION_ID || "").trim();
    effective = sid ? { kind: "session", value: "current" } : { kind: "workspace" };
  }

  // Resolve a session scope BEFORE the network call so a bad session fails fast.
  let scope: SessionScopeResult | null = null;
  if (effective.kind === "session") {
    if (!deps.loadSessionScope) {
      console.error("--session is not supported in this context.");
      return 2;
    }
    try {
      scope = deps.loadSessionScope(effective.value, {
        env,
        workspaceId: ctx.workspaceId,
        nowMs: Date.now(),
      });
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
  }

  const docArg = effective.kind === "doc" ? effective.doc : null;

  let all: { items: RelationshipCandidate[]; truncated: boolean };
  try {
    all = await fetchAllPending(deps.fetchPending, ctx.workspaceId, docArg);
  } catch (e) {
    console.error(`Failed to list pending candidates: ${(e as Error).message}`);
    return 1;
  }

  // Cache the workspace count from the COMPLETE set (every non-doc scope) so the
  // prompt-submit governance nudge reflects the true total, not a session subset.
  // SKIP the write when truncated: all.items.length is then a floor ("fetched up to
  // the cap"), not the exact count, and writing it as exact would lie. The cache
  // value does not carry truncation metadata today, so leaving the prior value
  // (possibly stale) beats overwriting it with a wrong-but-confident number. A
  // 5000-candidate queue never happens at pilot scale; this is a backstop. If
  // truncation ever becomes real, extend the cache to carry a `+`/truncated flag.
  if (effective.kind !== "doc" && !all.truncated) ctx.onWorkspaceCount?.(all.items.length);

  let items = all.items;
  let scopeNote: string | null = null;
  let scopeMeta: ScopeMeta;

  if (scope) {
    const fetched = items.length;
    items = items.filter((c) => candidateInSession(c, scope!.keys));
    const label =
      scope.source === "current-env"
        ? `your current session (${scope.sessionId})`
        : `session ${scope.sessionId} (${scope.source})`;
    scopeNote =
      `Scoped to ${label}: ${items.length} of ${fetched} fetched candidate${fetched === 1 ? "" : "s"} ` +
      `touch ${scope.keys.size} doc${scope.keys.size === 1 ? "" : "s"} this session produced. Use --all for the full workspace queue.`;
    if (scope.keys.size === 0) {
      scopeNote += " This session produced no indexed docs yet, so nothing is attributed to it.";
    }
    if (all.truncated) {
      scopeNote += " WARNING: the workspace queue exceeded the fetch cap, so this session view may be incomplete.";
    }
    scopeMeta = {
      kind: "session",
      sessionId: scope.sessionId,
      source: scope.source,
      sessionDocCount: scope.keys.size,
      fetchedCount: fetched,
      displayedCount: items.length,
      truncated: all.truncated,
    };
  } else if (effective.kind === "doc") {
    scopeMeta = {
      kind: "doc",
      doc: effective.doc,
      fetchedCount: items.length,
      displayedCount: items.length,
      truncated: all.truncated,
    };
  } else {
    scopeMeta = {
      kind: "workspace",
      fetchedCount: items.length,
      displayedCount: items.length,
      truncated: all.truncated,
    };
  }

  const view = buildPendingView(items, {
    workspaceId: ctx.workspaceId,
    consoleBase: ctx.consoleBase,
    truncated: all.truncated,
    scope: scopeMeta,
    scopeNote,
  });

  console.log(parsed.json ? renderPendingJson(view) : renderPendingHuman(view));
  return 0;
}

export async function runKbPending(argv: string[]): Promise<number> {
  let cfg: WorkspaceCliConfig;
  try {
    cfg = loadWorkspaceConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const consoleBase = getConsoleUrl(cfg);

  const deps: KbPendingDeps = {
    fetchPending: (qs) =>
      get<{ items: RelationshipCandidate[]; nextCursor: unknown }>(
        cfg,
        `/internal/v1/relationship-candidates?${qs}`,
        12000,
      ),
    loadSessionScope: (value, opts) => loadSessionScopeImpl(value, opts),
  };

  return runKbPendingWith(
    argv,
    {
      workspaceId: cfg.workspaceId,
      consoleBase,
      // A-0c: persist the workspace-wide count for the prompt-submit hook (surface 2).
      onWorkspaceCount: (count) => writePendingCountCache(cfg.workspaceId, count),
    },
    deps,
  );
}

// kb.ts dispatches the overloaded `review` verb (list mode) and the deprecated
// `pending` alias through this same listing runner.
export const runKbReviewList = runKbPending;
