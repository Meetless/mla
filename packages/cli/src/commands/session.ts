import { loadWorkspaceConfig, CliConfig, WorkspaceCliConfig } from "../lib/config";
import { get, post, HttpError } from "../lib/http";
import { redactPayload, redact } from "../lib/redactor";
import {
  executeSessionReconcile,
  makeTranscriptStatusResolver,
  type ReconcilableSession,
} from "../lib/reconcile-sessions";

// `mla session show [sid] [--json] [--last N]`. Plane 3 of the logging-and-
// tracing proposal (notes/20260528 §2.5, §6.B, principle 6).
//
// NOTE (2026-05-31): `mla session distill` + `mla session remember` were removed
// from this file. They were a dogfood scaffold (Bridge A1) that routed a finished
// session's ReviewPacket back to the KB as a low-trust note via a manual
// distill -> remember -> ingest chain. The learning loop replaces that with
// direct per-turn agent-artifact capture into the relationships orchestrator (no
// markdown note, no user-run command). See
// notes/20260531-agent-review-retraction-and-pending-items-loop.md §2. The intel
// `POST /v1/session/distill` endpoint is left in place (server-side, harmless)
// but is now CLI-orphaned.
//
// Resolves the session via a deterministic, SESSION-BOUND ladder:
//   positional sid -> $SESSION_ID env -> fail.
// There is deliberately NO workspace-latest fallback: `mla session show` must
// only ever resolve to the session the operator named (positional) or the
// session it is running inside ($SESSION_ID). Reaching for "the latest run in
// the workspace" would silently bind to a DIFFERENT session, which is exactly
// the cross-session leak this command must not do. If neither rung is present
// we fail loudly and tell the operator to pass a sid.
// The first line printed is `Session: <sid> (source: ...)` so a stale env var
// is never silent.
//
// Reads the workspace-scoped, redacted, capped event window from control's
// `/internal/v1/agent-runs/by-session/:sid/events` endpoint. The server already
// applies the shared redactor; we re-apply it client-side (`redactPayload`)
// before printing as a belt-and-suspenders defense (principle 7: same redactor,
// every operator-visible surface). Under `--json` the human truncation drops
// out but redaction stays in.
//
// `--last N` is a deterministic-tail UX wrapper: page the chronological feed
// to completion (server enforces a hard cap regardless), then keep only the
// last N events for display. The server cap is announced via a footer when
// `truncated:true` so the operator never assumes a complete dump.

interface ShowArgs {
  sessionId?: string;
  json: boolean;
  last?: number;
}

const SHOW_DEFAULT_LIMIT = 100;
const SHOW_MAX_PAGES = 50;

interface AgentRunEventView {
  id: string;
  // Server contract returns `eventType` (matches the Prisma column name on
  // AgentRunEvent). Earlier drafts of this view used `type` and rendered every
  // row as `[ts] undefined` in production while green tests masked the bug
  // because the stub mirrored the wrong field. Keep this in sync with
  // AgentRunService.getEventsBySession's response shape.
  eventType: string;
  occurredAt: string;
  payload: unknown;
  toolName?: string | null;
}

interface EventsEnvelope {
  sessionId: string;
  externalSessionId?: string;
  runId?: string;
  events: AgentRunEventView[];
  truncated: boolean;
  nextCursor?: string | null;
}

export function parseShowArgs(argv: string[]): ShowArgs {
  const out: ShowArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--last") {
      const next = argv[i + 1];
      if (!next) throw new Error("--last requires a positive integer (e.g. --last 20)");
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--last must be a positive integer, got: ${next}`);
      }
      out.last = n;
      i++;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. Supported flags: --json, --last <N>`);
    }
    if (out.sessionId) {
      throw new Error(`Unexpected extra argument: ${a}. Expected at most one sessionId.`);
    }
    out.sessionId = a;
  }
  return out;
}

interface ResolvedSid {
  sessionId: string;
  source: "positional" | "env";
}

// Session-bound resolution: positional sid -> $CLAUDE_CODE_SESSION_ID -> fail.
// No network call, no workspace-latest fallback, so this command can never
// resolve to a session other than the one named or the one it runs inside.
// CLAUDE_CODE_SESSION_ID is the only honored env var (it is what Claude Code
// exports to subprocesses, and what `mla review`/`activate` both bind to). The
// legacy $SESSION_ID was a divergent name nothing ever set, so it
// is intentionally NOT consulted (consolidated 2026-05-31).
function resolveSessionId(positional: string | undefined): ResolvedSid {
  const p = (positional || "").trim();
  if (p) return { sessionId: p, source: "positional" };

  const envSid = (process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  if (envSid) return { sessionId: envSid, source: "env" };

  throw new Error(
    "No session id provided and no $CLAUDE_CODE_SESSION_ID env. " +
      "Pass a sessionId: mla session show <sid>",
  );
}

async function fetchEventsPage(
  cfg: WorkspaceCliConfig,
  sid: string,
  cursor: string | null,
): Promise<EventsEnvelope> {
  const params = new URLSearchParams();
  params.set("workspaceId", cfg.workspaceId);
  params.set("limit", String(SHOW_DEFAULT_LIMIT));
  if (cursor) params.set("cursor", cursor);
  return await get<EventsEnvelope>(
    cfg,
    `/internal/v1/agent-runs/by-session/${encodeURIComponent(sid)}/events?${params.toString()}`,
    15000,
  );
}

function clipForHuman(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + ` ...[+${text.length - max} chars]`;
}

function renderEventHuman(ev: AgentRunEventView): string[] {
  const lines: string[] = [];
  const ts = ev.occurredAt;
  const payload = (ev.payload || {}) as Record<string, unknown>;
  if (ev.eventType === "prompt_submitted") {
    const text = String(payload.prompt ?? payload.text ?? "");
    lines.push(`[${ts}] prompt_submitted`);
    lines.push(indent(clipForHuman(text, 2000), "  > "));
    return lines;
  }
  if (ev.eventType === "tool_used_bash") {
    const cmd = String(payload.command ?? "");
    const exit = payload.exitCode ?? payload.exit_code ?? "?";
    const stdout = String(payload.stdout ?? "");
    const stderr = String(payload.stderr ?? "");
    lines.push(`[${ts}] tool_used_bash  exit=${exit}`);
    lines.push(indent(clipForHuman(cmd, 240), "  $ "));
    if (stdout) lines.push(indent(clipForHuman(tailLines(stdout, 20), 1200), "  | "));
    if (stderr) lines.push(indent(clipForHuman(tailLines(stderr, 20), 1200), "  ! "));
    return lines;
  }
  if (ev.eventType === "session_stopped") {
    const final = String(payload.finalMessage ?? payload.final_message ?? payload.text ?? "");
    lines.push(`[${ts}] session_stopped`);
    if (final) lines.push(indent(clipForHuman(final, 2000), "  = "));
    return lines;
  }
  lines.push(`[${ts}] ${ev.eventType}`);
  return lines;
}

function tailLines(text: string, n: number): string {
  const parts = text.split(/\r?\n/);
  if (parts.length <= n) return text;
  return parts.slice(parts.length - n).join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => prefix + l)
    .join("\n");
}

export async function runSessionShow(argv: string[]): Promise<number> {
  const cfg = loadWorkspaceConfig();
  let args: ShowArgs;
  try {
    args = parseShowArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let resolved: ResolvedSid;
  try {
    resolved = resolveSessionId(args.sessionId);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  // In --json mode the announce line goes to stderr so stdout stays a clean
  // JSON document (pipeable into jq / a file). In human mode it leads stdout
  // so the operator sees which rung resolved before the event stream.
  const announce = `Session: ${resolved.sessionId} (source: ${resolved.source})`;
  if (args.json) console.error(announce);
  else console.log(announce);

  let merged: EventsEnvelope | null = null;
  let cursor: string | null = null;
  let pagesFetched = 0;
  try {
    while (pagesFetched < SHOW_MAX_PAGES) {
      const page = await fetchEventsPage(cfg, resolved.sessionId, cursor);
      pagesFetched++;
      if (!merged) {
        merged = {
          sessionId: page.sessionId,
          externalSessionId: page.externalSessionId,
          runId: page.runId,
          events: [...page.events],
          truncated: page.truncated,
          nextCursor: page.nextCursor ?? null,
        };
      } else {
        merged.events.push(...page.events);
        merged.truncated = merged.truncated || page.truncated;
        merged.nextCursor = page.nextCursor ?? null;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Loop hit the page budget without exhausting the feed. Mark the merged
    // envelope truncated so the operator never silently sees a partial dump
    // (without this flag, SHOW_MAX_PAGES * SHOW_DEFAULT_LIMIT events would look
    // like the complete capture). The server's own `truncated` stays sticky.
    // Use merged.nextCursor (faithfully tracks last page's nextCursor incl. null)
    // rather than the loop-local `cursor`, which goes stale when the last page
    // exits via line 600's break before line 601 advances it.
    if (merged && pagesFetched >= SHOW_MAX_PAGES && merged.nextCursor) {
      merged.truncated = true;
      console.error(
        `Note: client page budget (${SHOW_MAX_PAGES} pages of ${SHOW_DEFAULT_LIMIT}) reached; ` +
          `feed may have more events. Follow nextCursor to continue.`,
      );
    }
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) {
      console.error(
        `No agent run found for session ${resolved.sessionId} in this workspace. ` +
          `Was it captured by the hooks?`,
      );
      return 1;
    }
    throw e;
  }

  if (!merged) {
    console.error("Unexpected: no events envelope returned.");
    return 1;
  }

  // Defense-in-depth: the control endpoint already redacts, but apply the
  // shared redactor again at the render boundary (principle 7) so the failure
  // mode for a bug on the server side is "double-redacted output", not
  // "leaked secrets in the operator's terminal".
  const redactedEvents = merged.events.map((ev) => ({
    ...ev,
    payload: redactPayload(ev.payload),
  }));

  const displayEvents =
    args.last && args.last > 0 && args.last < redactedEvents.length
      ? redactedEvents.slice(redactedEvents.length - args.last)
      : redactedEvents;

  if (args.json) {
    const out = {
      sessionId: merged.sessionId,
      externalSessionId: merged.externalSessionId ?? null,
      runId: merged.runId ?? null,
      source: resolved.source,
      truncated: merged.truncated,
      nextCursor: merged.nextCursor ?? null,
      totalReturned: redactedEvents.length,
      displayed: displayEvents.length,
      events: displayEvents,
    };
    console.log(JSON.stringify(out, null, 2));
    if (merged.truncated) {
      console.error(
        "Note: server cap clipped the event window. Re-run with `--last N` or follow nextCursor.",
      );
    }
    return 0;
  }

  if (displayEvents.length === 0) {
    console.log("(no events captured for this session)");
    if (merged.truncated) {
      console.log("output truncated; pass --last N or follow nextCursor to continue.");
    }
    return 0;
  }

  if (args.last && args.last < redactedEvents.length) {
    console.log(`(showing last ${args.last} of ${redactedEvents.length} events)`);
  } else {
    console.log(`(${redactedEvents.length} event(s) captured)`);
  }
  for (const ev of displayEvents) {
    for (const line of renderEventHuman(ev as AgentRunEventView)) {
      // Defense-in-depth at the line level too: any future code path that
      // pulls a string straight from payload into a render line still passes
      // through the redactor here.
      console.log(redact(line) ?? line);
    }
  }
  if (merged.truncated) {
    console.log("");
    console.log("output truncated; pass `--last N` or follow `nextCursor` to continue.");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `mla session reconcile [--dry-run] [--json]`
//
// Claude Code has no "session deleted" event (SessionEnd does not fire on delete,
// and the transcript outlives SessionEnd). So when an operator deletes a session
// in Claude Code, its mirrored Meetless AgentRun lingers in the Sessions list
// forever. This sweep closes that gap: it lists the workspace's non-archived
// claude_code runs, checks each one's transcript on disk under ~/.claude/projects,
// and archives exactly the runs whose transcript is provably gone. Archive is a
// reversible, per-user VIEW flag (no liveness/governance/outbox change), and the
// whole path is fail-SAFE: any uncertainty (wrong host, missing repoPath, a slug
// we cannot match, a present transcript) resolves to "skip", never a false
// archive. The decision + fail-soft archive loop live in lib/reconcile-sessions
// (executeSessionReconcile); this command is just the transport + rendering.
// ---------------------------------------------------------------------------

interface ReconcileArgs {
  dryRun: boolean;
  json: boolean;
}

export function parseReconcileArgs(argv: string[]): ReconcileArgs {
  const out: ReconcileArgs = { dryRun: false, json: false };
  for (const a of argv) {
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}. Supported flags: --dry-run, --json`);
    }
    // reconcile sweeps the entire workspace; it intentionally takes no sid.
    throw new Error(
      `Unexpected argument: ${a}. \`mla session reconcile\` takes no positional ` +
        "arguments (it sweeps the workspace). Supported flags: --dry-run, --json",
    );
  }
  return out;
}

// Cap each sweep at the server's max page (clamped to 500 server-side). The
// working set is self-limiting: once a deleted session is archived it drops out of
// the default (`archived=false`) list, so a later sweep handles any remainder.
const RECONCILE_LIST_LIMIT = 500;

export async function runSessionReconcile(argv: string[]): Promise<number> {
  let args: ReconcileArgs;
  try {
    args = parseReconcileArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const cfg = loadWorkspaceConfig();
  const resolver = makeTranscriptStatusResolver();

  const listSessions = async (): Promise<ReconcilableSession[]> => {
    const params = new URLSearchParams();
    params.set("workspaceId", cfg.workspaceId);
    // archived=false: never re-touch an already-archived row (idempotent sweeps).
    params.set("archived", "false");
    // Only Claude Code has the no-delete-event gap this sweep exists to close.
    params.set("adapter", "claude_code");
    params.set("limit", String(RECONCILE_LIST_LIMIT));
    return await get<ReconcilableSession[]>(
      cfg,
      `/internal/v1/agent-runs?${params.toString()}`,
      15000,
    );
  };

  const archive = async (sid: string): Promise<void> => {
    await post(
      cfg,
      `/internal/v1/agent-runs/by-session/${encodeURIComponent(sid)}/archive`,
      { workspaceId: cfg.workspaceId },
      15000,
    );
  };

  let result;
  try {
    result = await executeSessionReconcile(
      { listSessions, resolver, archive },
      { dryRun: args.dryRun },
    );
  } catch (e) {
    const err = e as HttpError;
    console.error(
      `Could not list sessions to reconcile: ${err.message}` +
        (err.status ? ` (HTTP ${err.status})` : ""),
    );
    return 1;
  }

  const { plan, archived, failed, dryRun } = result;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          workspaceId: cfg.workspaceId,
          dryRun,
          scanned: plan.toArchive.length + plan.skipped.length,
          toArchive: plan.toArchive,
          archived,
          failed,
          skipped: plan.skipped,
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }

  // Human render. Lead with the headline so an operator running it ad hoc sees
  // the outcome immediately; detail (which sessions, why skipped) follows.
  const scanned = plan.toArchive.length + plan.skipped.length;
  if (plan.toArchive.length === 0) {
    console.log(`Reconcile: scanned ${scanned} claude_code session(s); none have a deleted transcript. Nothing to archive.`);
    return 0;
  }

  if (dryRun) {
    console.log(
      `Reconcile (dry-run): ${plan.toArchive.length} of ${scanned} session(s) have a deleted transcript and WOULD be archived:`,
    );
    for (const id of plan.toArchive) console.log(`  - ${id}`);
    console.log("Re-run without --dry-run to archive them.");
    return 0;
  }

  console.log(
    `Reconcile: archived ${archived.length} of ${plan.toArchive.length} session(s) with a deleted transcript (scanned ${scanned}).`,
  );
  for (const id of archived) console.log(`  archived ${id}`);
  if (failed.length > 0) {
    console.error(`${failed.length} archive(s) failed:`);
    for (const f of failed) console.error(`  ${f.sessionId}: ${f.error}`);
    return 1;
  }
  return 0;
}
