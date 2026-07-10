// `mla enforcement` -- adjudicate governed-rule enforcement blocks from the terminal
// (the deny tile, notes/20260607-mla-tracking-and-analytics.md §5.1; capture-time
// verdict path, notes/20260704-enforcement-review-evidence-surface-design.md).
//
// When a PreToolUse deny fires, its reason ends with "Run `mla enforcement` to confirm
// or dismiss this block." This command is the other half of that CTA: it lists the
// blocks and lets the human adjudicate each as a CONFIRMED catch (the rule correctly
// stopped a wrong action) or a FALSE POSITIVE (the rule misfired), the moment they see
// it, without leaving the terminal.
//
// It reuses control's EXACT read-model + adjudicate endpoints (the same ones the
// Console /value review queue drives), so the verdict feeds one metric definition
// (INV-METRIC-DEFINITION-1). Auth is the logged-in human's cli-session token
// (InternalOrCliSessionGuard on the controller), so every verdict is audited as the
// real person, never the anonymous shared key.
//
// Surface:
//   mla enforcement                       -> this session's unreviewed blocks, then an
//                                            interactive confirm/dismiss loop (TTY only).
//   mla enforcement --all                 -> unreviewed blocks across the whole workspace
//                                            (not just this session), same loop.
//   mla enforcement --json                -> machine-readable mirror of the server
//                                            read-model (INCLUDES adjudicated blocks);
//                                            no interaction.
//   mla enforcement confirm <id> [--note] -> adjudicate one block as a confirmed catch.
//   mla enforcement dismiss <id> [--note] -> adjudicate one block as a false positive.
//
// Session scoping mirrors `mla review`: the default is the session you are running
// inside (CLAUDE_CODE_SESSION_ID); --all is the explicit escape hatch to the full
// queue. With no session id in the environment, the default widens to --all so the
// command is still useful from a plain terminal.

import * as fs from "fs";
import { loadWorkspaceConfig, consoleDeepLink, WorkspaceCliConfig } from "../lib/config";
import { get, post, HttpError } from "../lib/http";

// The two verdicts control accepts (ADJUDICATION_VERDICTS in
// adjudicate-enforcement.dto.ts). Confirmed = a real catch; false_positive = a misfire.
// Declared here rather than imported: it is the control DTO's contract, not the
// CLI analytics envelope's (which only carries the "unreviewed" born state).
export type AdjudicationVerdict = "confirmed" | "false_positive";

// The subset of control's CollapsedEnforcementIncident the CLI renders + acts on.
export interface EnforcementIncidentView {
  incident_id: string;
  enforced_tool: string;
  touched_surface: string | null;
  review_status: string;
  first_seen_at: string;
  last_seen_at: string;
  session_id: string | null;
  blocked_path: string | null;
  rule_version_id?: string | null;
  rule_text?: string | null;
  rule_name?: string | null;
  rule_node_id?: string | null;
  adjudication_note?: string | null;
}

interface EnforcementListResponse {
  window_days: number;
  workspaces: number;
  has_any_events: boolean;
  incidents: EnforcementIncidentView[];
}

// The interactive verdict a reviewer gives one block, or a control-flow choice.
type VerdictChoice = "confirm" | "dismiss" | "skip" | "quit";

// Injection seams (default to the real implementations; specs pin them).
export interface EnforcementDeps {
  listIncidents?: (cfg: WorkspaceCliConfig) => Promise<EnforcementListResponse>;
  adjudicate?: (
    cfg: WorkspaceCliConfig,
    incidentId: string,
    verdict: AdjudicationVerdict,
    note?: string,
  ) => Promise<EnforcementIncidentView>;
  isInteractive?: () => boolean;
  promptVerdict?: (prompt: string) => VerdictChoice;
  sessionId?: () => string | undefined;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const LIST_TIMEOUT_MS = 15_000;
const ADJUDICATE_TIMEOUT_MS = 15_000;

function defaultListIncidents(cfg: WorkspaceCliConfig): Promise<EnforcementListResponse> {
  return get<EnforcementListResponse>(
    cfg,
    "/internal/v1/analytics/enforcement/incidents",
    LIST_TIMEOUT_MS,
  );
}

function defaultAdjudicate(
  cfg: WorkspaceCliConfig,
  incidentId: string,
  verdict: AdjudicationVerdict,
  note?: string,
): Promise<EnforcementIncidentView> {
  const body: { verdict: AdjudicationVerdict; note?: string } = { verdict };
  if (note && note.trim()) body.note = note.trim();
  return post<EnforcementIncidentView>(
    cfg,
    `/internal/v1/analytics/enforcement/incidents/${encodeURIComponent(incidentId)}/adjudicate`,
    body,
    ADJUDICATE_TIMEOUT_MS,
  );
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Read one line from stdin and map its first char to a verdict. Synchronous, matching
// the rest of the CLI's confirmation prompts (no readline dependency).
function defaultPromptVerdict(prompt: string): VerdictChoice {
  process.stderr.write(prompt);
  const buf = Buffer.alloc(64);
  try {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    if (answer === "c" || answer === "confirm" || answer === "y") return "confirm";
    if (answer === "d" || answer === "dismiss" || answer === "f") return "dismiss";
    if (answer === "q" || answer === "quit") return "quit";
    return "skip";
  } catch {
    // A read fault degrades to skip: never silently confirm or dismiss on an IO error.
    return "skip";
  }
}

// A short, stable handle for a block: the last 8 chars of its incident id. The full id
// is still printed for `confirm <id>` / `dismiss <id>`, but the short form keeps the
// interactive list scannable.
function shortId(incidentId: string): string {
  return incidentId.length <= 8 ? incidentId : `...${incidentId.slice(-8)}`;
}

function fmtWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// Render one block as the evidence a reviewer needs to adjudicate: what was blocked,
// which rule blocked it, and the rule's own words. This is the whole point of the
// redesign -- the old queue showed only "Write on docs" with no rule and no path.
export function renderIncident(inc: EnforcementIncidentView, index: number): string {
  const lines: string[] = [];
  const surface = inc.touched_surface ? ` on ${inc.touched_surface}` : "";
  lines.push(`${index}. [${shortId(inc.incident_id)}] ${inc.enforced_tool}${surface}  (${fmtWhen(inc.first_seen_at)})`);
  lines.push(`   blocked: ${inc.blocked_path ?? "(path not captured for this block)"}`);
  const ruleLabel = inc.rule_name ?? inc.rule_node_id ?? inc.rule_version_id ?? "unknown rule";
  lines.push(`   rule:    ${ruleLabel}`);
  if (inc.rule_text && inc.rule_text.trim()) {
    lines.push(`   says:    ${inc.rule_text.trim()}`);
  }
  lines.push(`   id:      ${inc.incident_id}`);
  return lines.join("\n");
}

interface ParsedEnforcementArgs {
  verb: "list" | "confirm" | "dismiss";
  incidentId?: string;
  note?: string;
  all: boolean;
  json: boolean;
}

// Parse `mla enforcement [confirm|dismiss <id>] [--all] [--json] [--note <text>]`.
// Throws on a malformed invocation so a bad call fails loud, never silently no-ops.
export function parseEnforcementArgs(argv: string[]): ParsedEnforcementArgs {
  let verb: ParsedEnforcementArgs["verb"] = "list";
  let incidentId: string | undefined;
  let note: string | undefined;
  let all = false;
  let json = false;

  let i = 0;
  if (argv[0] === "confirm" || argv[0] === "dismiss") {
    verb = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      all = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--note") {
      note = argv[++i];
      if (note === undefined) throw new Error("--note requires a value");
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (verb !== "list" && incidentId === undefined) {
      incidentId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }

  if (verb !== "list" && !incidentId) {
    throw new Error(`Usage: mla enforcement ${verb} <incident-id> [--note <text>]`);
  }
  if (verb === "list" && incidentId) {
    // Defensive: the loop above never assigns incidentId in list mode.
    throw new Error(`Unexpected argument: ${incidentId}`);
  }
  return { verb, incidentId, note, all, json };
}

const VERDICT_BY_VERB: Record<"confirm" | "dismiss", AdjudicationVerdict> = {
  confirm: "confirmed",
  dismiss: "false_positive",
};

// The list read feeds two audiences that split on review_status:
//   - the --json machine mirror keeps EVERY in-scope block (adjudicated included),
//     so a consumer -- or an operator verifying a verdict they just cast -- can SEE
//     the confirmed / false_positive row instead of it silently vanishing the
//     instant it leaves "unreviewed";
//   - the human review queue shows only the unreviewed ones (work still to do).
// Session scope narrows both; the status filter narrows only the queue. Pure, so the
// split -- the exact thing a stray unreviewed-only filter once collapsed -- is
// unit-tested without the config / marker IO the command shell needs.
export interface EnforcementSelection {
  /** The --json mirror: all statuses, narrowed to the active session scope. */
  inScope: EnforcementIncidentView[];
  /** The human review queue: unreviewed only, within the active scope. */
  queue: EnforcementIncidentView[];
  /** Whole-workspace outstanding count, for the "0 here, N across the workspace" hint. */
  workspaceUnreviewed: number;
}

export function selectEnforcementViews(
  incidents: EnforcementIncidentView[],
  opts: { scopeToSession: boolean; sessionId?: string },
): EnforcementSelection {
  const inScope = opts.scopeToSession
    ? incidents.filter((i) => i.session_id === opts.sessionId)
    : incidents;
  return {
    inScope,
    queue: inScope.filter((i) => i.review_status === "unreviewed"),
    workspaceUnreviewed: incidents.filter((i) => i.review_status === "unreviewed")
      .length,
  };
}

export async function runEnforcement(
  argv: string[],
  deps: EnforcementDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  let parsed: ParsedEnforcementArgs;
  try {
    parsed = parseEnforcementArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const cfg = loadWorkspaceConfig();
  const listIncidents = deps.listIncidents ?? defaultListIncidents;
  const adjudicate = deps.adjudicate ?? defaultAdjudicate;

  // Direct-action verbs: adjudicate one block by id, no listing, no prompt.
  if (parsed.verb === "confirm" || parsed.verb === "dismiss") {
    const verdict = VERDICT_BY_VERB[parsed.verb];
    try {
      const result = await adjudicate(cfg, parsed.incidentId!, verdict, parsed.note);
      out(
        parsed.verb === "confirm"
          ? `Confirmed catch: ${result.incident_id} is now recorded as a real block.`
          : `Dismissed as false positive: ${result.incident_id} is now marked a misfire.`,
      );
      return 0;
    } catch (e) {
      return reportAdjudicateError(e, parsed.incidentId!, err);
    }
  }

  // List mode. Default to this session; widen to the whole workspace with --all, or
  // when there is no session id to scope by.
  const sid = (deps.sessionId ?? (() => process.env.CLAUDE_CODE_SESSION_ID))();
  const scopeToSession = !parsed.all && Boolean(sid);

  let response: EnforcementListResponse;
  try {
    response = await listIncidents(cfg);
  } catch (e) {
    return reportListError(e, err);
  }

  const { inScope, queue: scoped, workspaceUnreviewed } = selectEnforcementViews(
    response.incidents,
    { scopeToSession, sessionId: sid },
  );

  if (parsed.json) {
    // The machine mirror is the full in-scope read-model (adjudicated blocks kept).
    out(JSON.stringify({ ...response, incidents: inScope }, null, 2));
    return 0;
  }

  const queueUrl = consoleDeepLink(cfg, "/value");

  if (scoped.length === 0) {
    if (scopeToSession && workspaceUnreviewed > 0) {
      out(
        `No unreviewed enforcement blocks in this session. ${workspaceUnreviewed} pending across the workspace; ` +
          `run \`mla enforcement --all\` to review them, or open ${queueUrl}.`,
      );
    } else {
      out(`No unreviewed enforcement blocks. Full queue: ${queueUrl}`);
    }
    return 0;
  }

  const header = scopeToSession
    ? `${scoped.length} unreviewed enforcement block(s) in this session:`
    : `${scoped.length} unreviewed enforcement block(s) in this workspace:`;
  out(header);
  out("");
  scoped.forEach((inc, idx) => {
    out(renderIncident(inc, idx + 1));
    out("");
  });

  const interactive = (deps.isInteractive ?? defaultIsInteractive)();
  if (!interactive) {
    out(
      "To adjudicate, run `mla enforcement confirm <id>` (a real catch) or " +
        "`mla enforcement dismiss <id>` (a false positive). Full queue: " +
        queueUrl,
    );
    return 0;
  }

  const promptVerdict = deps.promptVerdict ?? defaultPromptVerdict;
  let confirmed = 0;
  let dismissed = 0;
  let skipped = 0;
  for (let idx = 0; idx < scoped.length; idx++) {
    const inc = scoped[idx];
    const choice = promptVerdict(
      `[${idx + 1}/${scoped.length}] ${shortId(inc.incident_id)} -- (c)onfirm catch / (d)ismiss false positive / (s)kip / (q)uit: `,
    );
    if (choice === "quit") {
      out(`Stopped. ${scoped.length - idx} block(s) left unreviewed.`);
      break;
    }
    if (choice === "skip") {
      skipped++;
      continue;
    }
    const verdict = choice === "confirm" ? "confirmed" : "false_positive";
    try {
      await adjudicate(cfg, inc.incident_id, verdict);
      if (choice === "confirm") confirmed++;
      else dismissed++;
    } catch (e) {
      err(`  Failed to adjudicate ${inc.incident_id}: ${adjudicateErrorMessage(e)}`);
    }
  }

  out("");
  out(
    `Done: ${confirmed} confirmed, ${dismissed} dismissed, ${skipped} skipped. Full queue: ${queueUrl}`,
  );
  return 0;
}

function adjudicateErrorMessage(e: unknown): string {
  const status = (e as HttpError | undefined)?.status;
  if (status === 404) return "not found (or not visible to you)";
  if (status === 401 || status === 403) return "not authorized";
  if (status === undefined) return "backend unreachable";
  return `HTTP ${status}`;
}

function reportAdjudicateError(e: unknown, incidentId: string, err: (l: string) => void): number {
  const status = (e as HttpError | undefined)?.status;
  if (status === 404) {
    err(`Enforcement block not found: ${incidentId} (it may be in a workspace you cannot see).`);
    return 1;
  }
  if (status === 401 || status === 403) {
    err("Not authorized. Run `mla login` to adjudicate as yourself.");
    return 1;
  }
  err(`Could not adjudicate ${incidentId}: ${adjudicateErrorMessage(e)}`);
  return 1;
}

function reportListError(e: unknown, err: (l: string) => void): number {
  const status = (e as HttpError | undefined)?.status;
  if (status === 401 || status === 403) {
    err("Not authorized. Run `mla login` to review enforcement blocks as yourself.");
    return 1;
  }
  if (status === undefined) {
    err("Could not reach the backend to list enforcement blocks.");
    return 1;
  }
  err(`Could not list enforcement blocks: HTTP ${status}`);
  return 1;
}
