// `mla conflicts`: read AND resolve the open cross-session conflicts from the
// terminal.
//
// A D1 cross-session conflict is a SESSION_CONTRADICTION CoordinationCase: a
// decision this (or another) agent session captured that contradicts either an
// approved decision or a decision another live session captured. The hook already
// writes the thin snapshot to active-conflicts.json for the soft PreToolUse
// warning; this command is the on-demand, human-readable view of the same set,
// plus the four-verdict resolve path.
//
// Surface:
//   mla conflicts                 -> conflicts involving THIS session
//                                    (CLAUDE_CODE_SESSION_ID).
//   mla conflicts --global        -> every open cross-session conflict in the
//                                    workspace.
//   mla conflicts --session <sid> -> conflicts involving an explicit session
//                                    ('current' / 'latest' / a literal sid).
//   mla conflicts --json          -> machine-readable mirror of the server read.
//   mla conflicts resolve <case-id> --outcome <uphold-subject|uphold-counterparty|
//                         dismiss|discard-both> --rationale <text>
//                                 -> record ONE of the four D1 verdicts on a case.
//   mla conflicts dismiss <case-id> --rationale <text>
//                                 -> shorthand for `resolve ... --outcome dismiss`
//                                    (the conflict is not real; close it as a false
//                                    positive).
//
// Both write verbs hit the SAME control endpoint the console Conflict Detail page
// drives (POST /internal/v1/session-conflicts/:caseId/resolve), so a terminal
// resolve is byte-for-byte the console resolve: it closes the case on the mapped
// resolution, writes the SESSION_CONFLICT_RESOLVED audit row under the operator's
// identity, and (for the outcomes that need it) broadcasts a steer to the loser
// session. A --rationale is REQUIRED: it is recorded on the case and carried in the
// broadcast. There is no interactive resolve loop -- a verdict has durable side
// effects, so each one is an explicit, id-addressed call.
//
// Auth is the logged-in human's cli-session token (InternalOrCliSessionGuard on
// the controller), so both the ADMIN-gated read and the MEMBER-gated resolve run
// as the real person, and the verdict is audited as them (the CLI cannot spoof
// another actor: identity is derived server-side from the token, never the body).

import {
  loadWorkspaceConfig,
  consoleDeepLink,
  WorkspaceCliConfig,
} from "../lib/config";
import { get, post, HttpError } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { resolveScopeSession, SessionScopeError } from "../lib/session-scope";

// One side of a conflict, mirroring control's WorkspaceConflictSide. `sessionId`
// is the counterpart's external session id (resolved server-side from its run);
// `artifactId` is the approved artifact for an APPROVED_KNOWLEDGE side.
export interface ConflictSideView {
  role: string; // SUBJECT | COUNTERPARTY | AFFECTED
  refType: string; // SESSION | APPROVED_KNOWLEDGE
  refId: string;
  sessionId: string | null;
  isCurrentSession: boolean;
  statement: string | null;
  artifactId: string | null;
}

// One open conflict, mirroring control's WorkspaceConflict.
export interface WorkspaceConflictView {
  caseId: string;
  kindId: string;
  status: string;
  openedAt: string;
  reason: string;
  sides: ConflictSideView[];
}

// The server response for GET /internal/v1/session-conflicts/active.
export interface ConflictsResponse {
  workspaceId: string;
  sessionId: string | null;
  global: boolean;
  conflicts: WorkspaceConflictView[];
}

// The four human verdicts a D1 session conflict can be resolved with (control's
// D1ConflictOutcome). Declared here rather than imported: control is a separate
// service, and this is its wire contract, not a shared type. The CLI accepts the
// kebab-case flag form (`uphold-subject`) and normalizes to this enum.
export type D1ConflictOutcome =
  | "UPHOLD_SUBJECT"
  | "UPHOLD_COUNTERPARTY"
  | "DISMISS"
  | "DISCARD_BOTH";

// The kebab-case `--outcome` flag values, in the order the help string lists them.
const OUTCOME_BY_FLAG: Record<string, D1ConflictOutcome> = {
  "uphold-subject": "UPHOLD_SUBJECT",
  "uphold-counterparty": "UPHOLD_COUNTERPARTY",
  dismiss: "DISMISS",
  "discard-both": "DISCARD_BOTH",
};

const OUTCOME_FLAGS = Object.keys(OUTCOME_BY_FLAG).join(", ");

// Retired outcomes and where they went. Kept as a named table rather than folded
// into the unknown-value branch: an operator who types `reject-both` used a verb
// that WORKED for months, and telling them it is merely "unknown" reads like a
// typo. They need to know it is gone, why, and what replaced it.
const RETIRED_OUTCOME_HELP: Record<string, string> = {
  "reject-both":
    "`reject-both` is retired. It promised a follow-up decision that nothing " +
    "ever picked up, so the conflict just sat there. Use `--outcome discard-both` " +
    "to remove both claims from current knowledge, or leave the case open.",
};

// Accept either the kebab flag (`uphold-subject`) or the raw enum (`UPHOLD_SUBJECT`),
// case-insensitively. Throws on anything else so a typo fails loud, never resolves
// to a silent default, and never sends a retired verdict control would 410.
function normalizeOutcome(raw: string): D1ConflictOutcome {
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  const retired = RETIRED_OUTCOME_HELP[key];
  if (retired) {
    throw new Error(retired);
  }
  const outcome = OUTCOME_BY_FLAG[key];
  if (!outcome) {
    throw new Error(`Unknown outcome "${raw}". Use one of: ${OUTCOME_FLAGS}.`);
  }
  return outcome;
}

// The subset of control's ResolveSessionConflictResult the CLI renders.
export interface ResolveConflictResult {
  caseId: string;
  outcome: D1ConflictOutcome;
  resolution: string;
  /**
   * Always null today. Still on control's response, but the only outcome that
   * ever set it (the retired REJECT_BOTH) is gone, and DISCARD_BOTH opens no
   * follow-up case.
   */
  linkedCaseId: string | null;
}

// Injection seams (default to the real implementations; specs pin them).
export interface ConflictsDeps {
  loadConfig?: () => WorkspaceCliConfig;
  fetchConflicts?: (
    cfg: WorkspaceCliConfig,
    params: { sessionId?: string; adapter?: string },
  ) => Promise<ConflictsResponse>;
  resolveConflict?: (
    cfg: WorkspaceCliConfig,
    caseId: string,
    outcome: D1ConflictOutcome,
    rationale: string,
  ) => Promise<ResolveConflictResult>;
  resolveSession?: (
    value: string,
    workspaceId: string,
  ) => { sessionId: string };
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const FETCH_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 15_000;
const STATEMENT_MAX = 100;

function defaultFetchConflicts(
  cfg: WorkspaceCliConfig,
  params: { sessionId?: string; adapter?: string },
): Promise<ConflictsResponse> {
  const qs = new URLSearchParams({ workspaceId: cfg.workspaceId });
  if (params.sessionId) qs.set("sessionId", params.sessionId);
  if (params.adapter) qs.set("adapter", params.adapter);
  return get<ConflictsResponse>(
    cfg,
    `/internal/v1/session-conflicts/active?${qs.toString()}`,
    FETCH_TIMEOUT_MS,
  );
}

// POST one verdict to /internal/v1/session-conflicts/:caseId/resolve, the same
// endpoint the console Conflict Detail page drives. The body carries workspaceId +
// outcome + rationale; the actor is derived server-side from the cli-session token
// (INV-AUTH-1), never sent from here.
function defaultResolveConflict(
  cfg: WorkspaceCliConfig,
  caseId: string,
  outcome: D1ConflictOutcome,
  rationale: string,
): Promise<ResolveConflictResult> {
  return post<ResolveConflictResult>(
    cfg,
    `/internal/v1/session-conflicts/${encodeURIComponent(caseId)}/resolve`,
    { workspaceId: cfg.workspaceId, outcome, rationale },
    RESOLVE_TIMEOUT_MS,
  );
}

function defaultResolveSession(
  value: string,
  workspaceId: string,
): { sessionId: string } {
  const r = resolveScopeSession(value, { workspaceId });
  return { sessionId: r.sessionId };
}

// A short, stable handle: the last 8 chars of an id, so the list stays scannable
// while the full case id is still printed for a console deep link.
function shortId(id: string): string {
  return id.length <= 8 ? id : `...${id.slice(-8)}`;
}

function fmtWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length <= STATEMENT_MAX ? t : `${t.slice(0, STATEMENT_MAX - 1)}…`;
}

// One-line descriptor for a side: who is on it. A SESSION side names its external
// session (and flags the queried session); an APPROVED_KNOWLEDGE side names the
// approved artifact it contradicts.
export function describeSide(s: ConflictSideView): string {
  if (s.refType === "SESSION") {
    const who = s.sessionId ?? `run ${shortId(s.refId)}`;
    return `session ${who}${s.isCurrentSession ? " (this session)" : ""}`;
  }
  if (s.refType === "APPROVED_KNOWLEDGE") {
    return `approved knowledge ${s.artifactId ?? s.refId}`;
  }
  return `${s.refType} ${s.refId}`;
}

// Render one conflict as the evidence a reader needs: what kind, when it opened,
// its current status, the human reason, each side (with the captured statement
// when present), and the full case id for a console deep link.
export function renderConflict(
  c: WorkspaceConflictView,
  index: number,
): string {
  const lines: string[] = [];
  lines.push(
    `${index}. [${shortId(c.caseId)}] ${c.kindId}  (${fmtWhen(c.openedAt)})  status ${c.status}`,
  );
  lines.push(`   why:  ${c.reason}`);
  const pad = 15; // aligns "subject:" / "counterparty:" descriptor columns
  for (const side of c.sides) {
    const col = `${side.role.toLowerCase()}:`.padEnd(pad);
    lines.push(`   ${col}${describeSide(side)}`);
    if (side.statement) {
      lines.push(`   ${" ".repeat(pad)}"${truncate(side.statement)}"`);
    }
  }
  lines.push(`   id:   ${c.caseId}`);
  return lines.join("\n");
}

// A one-line, outcome-aware confirmation of what the resolve just did, so the
// operator sees the consequence (which side won, what was closed, where it
// escalated) instead of a bare "ok".
export function describeResolveResult(r: ResolveConflictResult): string {
  switch (r.outcome) {
    case "UPHOLD_SUBJECT":
      return `Resolved ${r.caseId}: upheld the subject (the newer capture wins; the counterparty is superseded).`;
    case "UPHOLD_COUNTERPARTY":
      return `Resolved ${r.caseId}: upheld the counterparty (prior approved knowledge stands; the subject capture is dropped).`;
    case "DISMISS":
      return `Dismissed ${r.caseId}: not a real conflict, closed as a false positive.`;
    case "DISCARD_BOTH":
      // Present tense on purpose. The verdict is durable the moment this returns,
      // but the claims leave current knowledge on intel's clock, not ours. Saying
      // "removed" here would claim a landing this command cannot have observed.
      return `Resolved ${r.caseId}: both claims are being removed from current knowledge; the conflicting session was notified.`;
  }
  // Exhaustive above; this keeps the compiler happy without exhaustiveness inference.
  return `Resolved ${r.caseId} (${r.outcome}).`;
}

export interface ParsedConflictsArgs {
  verb: "list" | "resolve" | "dismiss";
  caseId?: string;
  outcome?: D1ConflictOutcome;
  rationale?: string;
  global: boolean;
  session?: string;
  adapter?: string;
  json: boolean;
}

// Parse the three shapes:
//   list:    mla conflicts [--global] [--session <sid>] [--adapter <a>] [--json]
//   resolve: mla conflicts resolve <case-id> --outcome <o> --rationale <text>
//   dismiss: mla conflicts dismiss <case-id> --rationale <text>
// --global and --session are mutually exclusive in list mode (one asks for the
// whole workspace, the other for a single session). The write verbs require a
// case id and a non-empty rationale; `resolve` additionally requires --outcome,
// while `dismiss` fixes it to DISMISS. Throws on any malformed invocation so a bad
// call fails loud, never silently no-ops or resolves the wrong case.
export function parseConflictsArgs(argv: string[]): ParsedConflictsArgs {
  let verb: ParsedConflictsArgs["verb"] = "list";
  let caseId: string | undefined;
  let outcome: D1ConflictOutcome | undefined;
  let rationale: string | undefined;
  let global = false;
  let session: string | undefined;
  let adapter: string | undefined;
  let json = false;

  let i = 0;
  if (argv[0] === "resolve" || argv[0] === "dismiss") {
    verb = argv[0];
    i = 1;
    // The shorthand fixes the verdict; --outcome is then not accepted below.
    if (verb === "dismiss") outcome = "DISMISS";
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (verb === "list") {
      if (a === "--global") {
        global = true;
      } else if (a === "--json") {
        json = true;
      } else if (a === "--session") {
        session = argv[++i];
        if (session === undefined) throw new Error("--session requires a value");
      } else if (a === "--adapter") {
        adapter = argv[++i];
        if (adapter === undefined) throw new Error("--adapter requires a value");
      } else if (a.startsWith("-")) {
        throw new Error(`Unknown flag: ${a}`);
      } else {
        throw new Error(`Unexpected argument: ${a}`);
      }
    } else if (a === "--outcome") {
      if (verb === "dismiss") {
        throw new Error(
          "`mla conflicts dismiss` already implies --outcome dismiss; use " +
            "`mla conflicts resolve <case-id> --outcome <o>` to pick another verdict.",
        );
      }
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--outcome requires a value");
      outcome = normalizeOutcome(raw);
    } else if (a === "--rationale" || a === "--note") {
      rationale = argv[++i];
      if (rationale === undefined) throw new Error(`${a} requires a value`);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (caseId === undefined) {
      caseId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }

  if (verb !== "list") {
    if (!caseId) {
      const outcomePart =
        verb === "resolve" ? `--outcome <${OUTCOME_FLAGS.replace(/, /g, "|")}> ` : "";
      throw new Error(
        `Usage: mla conflicts ${verb} <case-id> ${outcomePart}--rationale <text>`,
      );
    }
    if (verb === "resolve" && !outcome) {
      throw new Error(`\`mla conflicts resolve\` requires --outcome <${OUTCOME_FLAGS.replace(/, /g, "|")}>.`);
    }
    if (!rationale || !rationale.trim()) {
      throw new Error(
        "A --rationale is required: it is recorded on the case and broadcast to the affected session.",
      );
    }
  }

  if (global && session !== undefined) {
    throw new Error("Pass either --global or --session, not both.");
  }
  return { verb, caseId, outcome, rationale, global, session, adapter, json };
}

export async function runConflicts(
  argv: string[],
  deps: ConflictsDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  let parsed: ParsedConflictsArgs;
  try {
    parsed = parseConflictsArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const cfg = (deps.loadConfig ?? loadWorkspaceConfig)();
  const queueUrl = consoleDeepLink(cfg, "/conflicts");

  // Direct-action verbs: record one verdict by case id, no listing, no prompt.
  // (Parse guarantees caseId + rationale are set, and outcome for both verbs.)
  if (parsed.verb === "resolve" || parsed.verb === "dismiss") {
    const resolveConflict = deps.resolveConflict ?? defaultResolveConflict;
    try {
      const result = await resolveConflict(
        cfg,
        parsed.caseId!,
        parsed.outcome!,
        parsed.rationale!,
      );
      out(describeResolveResult(result));
      return 0;
    } catch (e) {
      return reportResolveError(e, parsed.caseId!, err);
    }
  }

  const fetchConflicts = deps.fetchConflicts ?? defaultFetchConflicts;
  const resolveSession = deps.resolveSession ?? defaultResolveSession;

  // Resolve the scope. Global skips the session entirely; otherwise default to the
  // session we are running inside ('current'), or an explicit --session value.
  let sessionId: string | undefined;
  if (!parsed.global) {
    try {
      sessionId = resolveSession(parsed.session ?? "current", cfg.workspaceId)
        .sessionId;
    } catch (e) {
      if (e instanceof SessionScopeError) {
        err(
          `${e.message}\n` +
            "Or run `mla conflicts --global` to see every open conflict in the workspace.",
        );
        return 2;
      }
      throw e;
    }
  }

  let response: ConflictsResponse;
  try {
    response = await fetchConflicts(cfg, {
      sessionId,
      adapter: parsed.adapter,
    });
  } catch (e) {
    return reportFetchError(e, err);
  }

  if (parsed.json) {
    out(JSON.stringify(response, null, 2));
    return 0;
  }

  const conflicts = response.conflicts;

  if (conflicts.length === 0) {
    if (parsed.global) {
      out(`No open cross-session conflicts in this workspace. Queue: ${queueUrl}`);
    } else {
      out(
        `No open conflicts involving this session (${sessionId}). ` +
          "See the whole workspace with `mla conflicts --global`, or open " +
          queueUrl +
          ".",
      );
    }
    return 0;
  }

  const header = parsed.global
    ? `${conflicts.length} open cross-session conflict(s) in this workspace:`
    : `${conflicts.length} open conflict(s) involving this session (${sessionId}):`;
  out(header);
  out("");
  conflicts.forEach((c, idx) => {
    out(renderConflict(c, idx + 1));
    out("");
  });
  out(
    "Resolve one here: `mla conflicts resolve <id> --outcome " +
      "<uphold-subject|uphold-counterparty|dismiss|discard-both> --rationale " +
      "<text>` (or `dismiss <id> --rationale <text>` if it is not a real " +
      `conflict). Full evidence + resolve in the console: ${queueUrl}`,
  );
  return 0;
}

function reportFetchError(e: unknown, err: (l: string) => void): number {
  // A workspace-membership 403 means you ARE logged in; re-login will not help.
  // Give the shared canonical line instead of "Run `mla login`" (BUG-5 #3).
  if (isWorkspaceAccessDenied(e)) {
    err(workspaceAccessDeniedMessage(e));
    return 1;
  }
  const status = (e as HttpError | undefined)?.status;
  if (status === 401 || status === 403) {
    err("Not authorized. Run `mla login` to read conflicts as yourself.");
    return 1;
  }
  if (status === undefined) {
    err("Could not reach the backend to read conflicts.");
    return 1;
  }
  err(`Could not read conflicts: HTTP ${status}`);
  return 1;
}

function reportResolveError(
  e: unknown,
  caseId: string,
  err: (l: string) => void,
): number {
  // A workspace-membership 403 means you ARE logged in; re-login will not help.
  // Give the shared canonical line instead of "Run `mla login`" (BUG-5 #3).
  if (isWorkspaceAccessDenied(e)) {
    err(workspaceAccessDeniedMessage(e));
    return 1;
  }
  const status = (e as HttpError | undefined)?.status;
  if (status === 404) {
    err(
      `Conflict case not found: ${caseId} (it may already be resolved, or be in a ` +
        "workspace you cannot see).",
    );
    return 1;
  }
  if (status === 401 || status === 403) {
    err(
      "Not authorized to resolve this conflict. Run `mla login`, and confirm you " +
        "are a member of the workspace.",
    );
    return 1;
  }
  if (status === 400 || status === 409) {
    // A rejected verdict: the case is not in a resolvable state, or the body
    // failed validation (e.g. an empty rationale slipped past the client check).
    const body = (e as HttpError | undefined)?.body;
    const detail = typeof body === "string" && body.trim() ? ` (${body.trim()})` : "";
    err(`Could not resolve ${caseId}: the verdict was rejected${detail}.`);
    return 1;
  }
  if (status === undefined) {
    err("Could not reach the backend to resolve the conflict.");
    return 1;
  }
  err(`Could not resolve ${caseId}: HTTP ${status}`);
  return 1;
}
