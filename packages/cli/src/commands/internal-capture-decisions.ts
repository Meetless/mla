import * as fs from "fs";

import {
  AGENT_DECISION_EVENT,
  type AgentDecisionSpoolEvent,
  type CanonicalDecisionPayload,
  type CapturedBy,
  buildEventKey,
  validateCanonicalDecisionPayload,
} from "../lib/agent-decision";
import {
  CLAUDE_TOOL_NAME,
  type ClaudeQuestion,
  normalizeClaudeAskUserQuestion,
} from "../lib/agent-decision/normalize-claude";

// `mla _internal capture-decisions` (spec notes/20260608-agent-decision-capture-design.md
// section 5). The ONE place the raw provider input becomes canonical
// agent_decision_captured spool events.
//
// This command is a PURE TRANSFORM with a thin IO shell. It reads raw provider
// input, normalizes it through the Claude seam, and writes one spool-event JSON
// line per decision to stdout. It does NOT touch the spool itself: all shell
// locking stays in the hook (post-tool-use.sh / stop.sh), which appends each
// emitted line via common.sh:spool_append. Keeping the command IO-light keeps it
// testable as a pure function and keeps the single-writer lock invariant in one
// place (the hook).
//
// Two capture paths, both deduped by providerEventId (section 5):
//   --source post_tool_use      Primary, real-time. Reads ONE PostToolUse hook
//                               payload from stdin ({tool_name, tool_input,
//                               tool_response, tool_use_id}).
//   --source stop_transcript_scan  Backstop, guaranteed. Scans the session
//                               transcript JSONL (--transcript) for
//                               AskUserQuestion tool_use / tool_result pairs.
//
// The two paths derive the SAME providerEventId ("<tool_use_id>#<i>") because the
// tool_use_id is present in both the PostToolUse stdin (top-level tool_use_id)
// and the transcript (assistant message.content[].id, echoed on the user
// tool_result block). So a decision captured by both paths produces one identical
// eventKey; --spool lets the backstop skip what the primary already spooled, and
// control independently upserts on (workspaceId, provider, providerEventId).

export interface CaptureArgs {
  source: CapturedBy;
  // Provider session id (Claude's own session id). Authoritative over any
  // session_id embedded in the hook payload, since the hook passes it explicitly.
  session: string;
  // Required for stop_transcript_scan: path to the session transcript JSONL.
  transcript?: string;
  // Optional: an existing spool file whose eventKeys are already present. The
  // backstop passes its session spool so it never re-emits a decision the
  // primary path already captured.
  spool?: string;
}

const SOURCES: readonly CapturedBy[] = ["post_tool_use", "stop_transcript_scan"];

// Strict argv parsing, mirroring the convention in internal-finalize.ts: any
// unknown flag, a missing required flag, or a bare positional throws (exit 2 in
// the wrapper). A silent default here would let a flush.sh wiring bug capture
// decisions under the wrong source or session and never surface.
export function parseArgs(argv: string[]): CaptureArgs {
  let source: string | undefined;
  let session: string | undefined;
  let transcript: string | undefined;
  let spool: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":
        source = argv[++i];
        break;
      case "--session":
        session = argv[++i];
        break;
      case "--transcript":
        transcript = argv[++i];
        break;
      case "--spool":
        spool = argv[++i];
        break;
      default:
        throw new Error(
          `Unknown argument: ${a}. usage: mla _internal capture-decisions --source <post_tool_use|stop_transcript_scan> --session <id> [--transcript <path>] [--spool <path>]`,
        );
    }
  }

  if (source === undefined || !SOURCES.includes(source as CapturedBy)) {
    throw new Error(
      `--source must be one of ${SOURCES.join(", ")} (got ${JSON.stringify(source)})`,
    );
  }
  if (session === undefined || session.length === 0) {
    throw new Error("--session <providerSessionId> is required");
  }
  if (source === "stop_transcript_scan" && (transcript === undefined || transcript.length === 0)) {
    throw new Error("--transcript <path> is required when --source stop_transcript_scan");
  }

  const out: CaptureArgs = { source: source as CapturedBy, session };
  if (transcript !== undefined) out.transcript = transcript;
  if (spool !== undefined) out.spool = spool;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// PostToolUse path: one hook payload -> canonical payloads. Returns [] (never
// throws) when the tool is not AskUserQuestion or the payload is structurally
// unusable, so the hook it rides on is never crashed by a surprise shape.
export function normalizePostToolUseInput(
  hookPayload: unknown,
  opts: { providerSessionId: string; occurredAt: string },
): CanonicalDecisionPayload[] {
  if (!isPlainObject(hookPayload)) return [];
  if (hookPayload.tool_name !== CLAUDE_TOOL_NAME) return [];

  const toolUseId = hookPayload.tool_use_id;
  const toolInput = hookPayload.tool_input;
  const toolResponse = hookPayload.tool_response;
  const questions = isPlainObject(toolInput) ? toolInput.questions : undefined;
  // tool_response.answers is an object keyed on the EXACT question text (verified
  // against a real PostToolUse payload and a real transcript sidecar). A missing
  // or malformed answers map yields no decisions: an unanswered question is not a
  // captured human decision, which the normalizer already enforces per-question.
  const answers = isPlainObject(toolResponse) ? toolResponse.answers : undefined;

  if (typeof toolUseId !== "string" || !Array.isArray(questions) || !isPlainObject(answers)) {
    return [];
  }

  return normalizeClaudeAskUserQuestion(
    {
      toolUseId,
      questions: questions as ClaudeQuestion[],
      answers,
    },
    {
      providerSessionId: opts.providerSessionId,
      capturedBy: "post_tool_use",
      occurredAt: opts.occurredAt,
    },
  );
}

// Stop backstop path: scan transcript JSONL for AskUserQuestion tool_use /
// tool_result pairs. A single forward pass works because an assistant tool_use
// line always precedes its user tool_result line in chronological JSONL.
//
// The tool_use line (assistant) is authoritative for the offered questions +
// options; the matching user line carries the toolUseResult sidecar with the
// answers keyed on question text, plus a tool_result block echoing the
// tool_use_id used to pair them. occurredAt is the user line's recorded
// timestamp when present (the moment the answer landed); it is stored but is
// NEVER an identity input, so it may differ from the primary path safely.
export function scanTranscriptForDecisions(
  lines: string[],
  opts: { providerSessionId: string },
): CanonicalDecisionPayload[] {
  const askQuestions = new Map<string, ClaudeQuestion[]>();
  const out: CanonicalDecisionPayload[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // a truncated / non-JSON line is skipped, not fatal
    }
    if (!isPlainObject(obj)) continue;

    const message = obj.message;
    const content = isPlainObject(message) ? message.content : undefined;

    if (obj.type === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          isPlainObject(block) &&
          block.type === "tool_use" &&
          block.name === CLAUDE_TOOL_NAME &&
          typeof block.id === "string"
        ) {
          const input = block.input;
          const questions = isPlainObject(input) ? input.questions : undefined;
          if (Array.isArray(questions)) {
            askQuestions.set(block.id, questions as ClaudeQuestion[]);
          }
        }
      }
      continue;
    }

    if (obj.type === "user") {
      if (!Array.isArray(content)) continue;
      let toolUseId: string | undefined;
      for (const block of content) {
        if (isPlainObject(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          toolUseId = block.tool_use_id;
          break;
        }
      }
      if (toolUseId === undefined) continue;
      const questions = askQuestions.get(toolUseId);
      if (questions === undefined) continue; // not an AskUserQuestion result

      const sidecar = obj.toolUseResult;
      const answers = isPlainObject(sidecar) ? sidecar.answers : undefined;
      if (!isPlainObject(answers)) continue; // unanswered / unexpected shape

      const occurredAt = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      const ctx: Parameters<typeof normalizeClaudeAskUserQuestion>[1] = {
        providerSessionId: opts.providerSessionId,
        capturedBy: "stop_transcript_scan",
      };
      if (occurredAt !== undefined) ctx.occurredAt = occurredAt;

      out.push(...normalizeClaudeAskUserQuestion({ toolUseId, questions, answers }, ctx));
    }
  }

  return out;
}

// Wrap validated canonical payloads into spool-event envelopes, deduping against
// eventKeys already present (the backstop skips what the primary spooled) and
// within the batch. Validation is fail-soft: a malformed decision is logged and
// skipped, never crashing the hook (spec: validate-and-skip at capture time).
export function toSpoolEvents(
  payloads: CanonicalDecisionPayload[],
  opts: { sessionId: string; ts: string; existingEventKeys?: Set<string>; logError?: (msg: string) => void },
): AgentDecisionSpoolEvent[] {
  const seen = new Set(opts.existingEventKeys ?? []);
  const out: AgentDecisionSpoolEvent[] = [];
  for (const payload of payloads) {
    const errs = validateCanonicalDecisionPayload(payload);
    if (errs.length > 0) {
      opts.logError?.(
        `[capture-decisions] skipping invalid decision ${String(payload.providerEventId)}: ${errs.join("; ")}`,
      );
      continue;
    }
    const eventKey = buildEventKey(payload.provider, payload.providerEventId);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    out.push({
      ts: opts.ts,
      event: AGENT_DECISION_EVENT,
      eventKey,
      sessionId: opts.sessionId,
      payload,
    });
  }
  return out;
}

export interface CaptureDeps {
  readStdin: () => Promise<string>;
  readFile: (p: string) => string;
  now: () => string;
  writeLine: (line: string) => void;
  logError: (msg: string) => void;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const defaultDeps: CaptureDeps = {
  readStdin: readStdinReal,
  readFile: (p) => fs.readFileSync(p, "utf8"),
  now: () => new Date().toISOString(),
  writeLine: (line) => process.stdout.write(line + "\n"),
  logError: (msg) => console.error(msg),
};

// Read the existing spool (if any) and collect its eventKeys so the backstop
// does not re-emit a decision the primary path already spooled. A missing file
// (no spool yet) is an empty set, not an error.
function readSpoolEventKeys(path: string, deps: CaptureDeps): Set<string> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = deps.readFile(path);
  } catch {
    return keys;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as { eventKey?: unknown };
      if (typeof obj.eventKey === "string") keys.add(obj.eventKey);
    } catch {
      // ignore unparseable spool lines
    }
  }
  return keys;
}

export async function runCaptureDecisions(
  argv: string[],
  deps: CaptureDeps = defaultDeps,
): Promise<number> {
  let parsed: CaptureArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    deps.logError((e as Error).message);
    return 2;
  }

  const ts = deps.now();

  let payloads: CanonicalDecisionPayload[];
  if (parsed.source === "post_tool_use") {
    const stdin = await deps.readStdin();
    const trimmed = stdin.trim();
    if (trimmed.length === 0) return 0; // nothing piped in is a clean no-op
    let hookPayload: unknown;
    try {
      hookPayload = JSON.parse(trimmed);
    } catch (e) {
      deps.logError(`[capture-decisions] stdin is not valid JSON: ${(e as Error).message}`);
      return 0; // never crash the hook on a malformed payload
    }
    payloads = normalizePostToolUseInput(hookPayload, {
      providerSessionId: parsed.session,
      occurredAt: ts,
    });
  } else {
    let raw: string;
    try {
      raw = deps.readFile(parsed.transcript as string);
    } catch (e) {
      deps.logError(`[capture-decisions] cannot read transcript ${parsed.transcript}: ${(e as Error).message}`);
      return 0; // a missing transcript is not a hook-crashing error
    }
    payloads = scanTranscriptForDecisions(raw.split("\n"), {
      providerSessionId: parsed.session,
    });
  }

  const existingEventKeys = parsed.spool ? readSpoolEventKeys(parsed.spool, deps) : undefined;
  const events = toSpoolEvents(payloads, {
    sessionId: parsed.session,
    ts,
    existingEventKeys,
    logError: deps.logError,
  });

  for (const event of events) {
    deps.writeLine(JSON.stringify(event));
  }
  return 0;
}
