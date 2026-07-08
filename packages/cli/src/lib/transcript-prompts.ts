import * as fs from "fs";
import * as path from "path";

// Pre-activation prompt back-fill.
//
// WHY THIS EXISTS (dogfood 2026-07-03): capture is dir-gated. Every hook opens
// with `meetless_activated || exit 0`, so a Claude Code session that only gets
// activated MID-FLIGHT (`mla activate` inside a live session) has already
// dropped every user prompt submitted before the marker existed. The session
// then shows its run and its session_stopped but NOT the opening human turn(s):
// exactly the "missing user's prompt" report. bootstrapCurrentSession reuses
// session-start.sh to materialize the run for the current session; this module
// recovers the lost prompts from the on-disk Claude Code transcript and re-emits
// them as prompt_submitted spool lines the same flush drains.
//
// Idempotency: the eventKey is DETERMINISTIC (`backfill-<uuid>` keyed on the
// transcript entry's own uuid), so re-running `mla activate` re-POSTs the SAME
// key and control's (runId, eventKey) dedup collapses it. The cutoff is what
// keeps back-fill from colliding with LIVE capture: only prompts strictly before
// the activation instant are re-emitted; everything at/after was captured live
// by the UserPromptSubmit hook (under a random gen_event_key that would NOT
// dedup against ours), so re-emitting it would double the turn.

// The genuine-human-turn predicate is shared by every reader of the raw prompt
// stream (see packages/utils agent-prompt.ts). The CLI intentionally has no
// dependency on @meetless/utils, so the tag list is vendored here in lockstep
// (same established pattern as canonical-json.ts / memory-requirement.ts).
const SYNTHETIC_AGENT_PROMPT_PREFIXES = ["<task-notification>"] as const;

function isSyntheticAgentPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const lstripped = prompt.replace(/^\s+/, "");
  return SYNTHETIC_AGENT_PROMPT_PREFIXES.some((tag) => lstripped.startsWith(tag));
}

export interface TranscriptPrompt {
  // The prompt text exactly as the human typed it.
  text: string;
  // The transcript entry's ISO 8601 timestamp (== when the turn was submitted).
  ts: string;
  // The transcript entry's uuid; the deterministic back-fill dedup key rides on it.
  uuid: string;
}

// Returns the prompt text, or null when this user turn is not a genuine human
// prompt. A string content is the text verbatim. An array content is the join
// of its text blocks UNLESS it carries a tool_result block (agent tool output
// re-entering through the user channel), which is never a prompt.
function extractPromptText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const isToolResult = content.some(
    (b) => b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result",
  );
  if (isToolResult) return null;
  const texts: string[] = [];
  for (const b of content) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
    ) {
      texts.push((b as { text: string }).text);
    }
  }
  if (texts.length === 0) return null;
  return texts.join("\n");
}

// Parse the genuine human user-prompt turns out of a Claude Code transcript's
// JSONL. Mirrors the capture-hook / control / worker predicate: type==user,
// not meta, not sidechain, real text (not a tool_result), non-empty, and not a
// <task-notification> synthetic wake-up. One corrupt line never poisons the
// batch (bad JSON is skipped).
export function parseUserPromptsFromTranscript(jsonl: string): TranscriptPrompt[] {
  const out: TranscriptPrompt[] = [];
  for (const raw of jsonl.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    const r = rec as {
      type?: unknown;
      uuid?: unknown;
      timestamp?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      message?: unknown;
    };
    if (r.type !== "user") continue;
    if (r.isMeta === true) continue;
    if (r.isSidechain === true) continue;
    if (typeof r.uuid !== "string" || !r.uuid) continue;
    if (typeof r.timestamp !== "string" || !r.timestamp) continue;
    const text = extractPromptText(r.message);
    if (text === null) continue;
    if (!text.trim()) continue;
    if (isSyntheticAgentPrompt(text)) continue;
    out.push({ text, ts: r.timestamp, uuid: r.uuid });
  }
  return out;
}

// Keep only prompts submitted STRICTLY before the activation instant. Those are
// the turns the meetless_activated gate dropped. Everything at/after activatedAt
// was captured live, so re-emitting it would double the turn. An unparseable
// cutoff returns all prompts (first-run safe: nothing was captured live yet).
export function selectPreActivationPrompts(
  prompts: TranscriptPrompt[],
  activatedAtIso: string,
): TranscriptPrompt[] {
  const cutoff = Date.parse(activatedAtIso);
  if (Number.isNaN(cutoff)) return prompts;
  return prompts.filter((p) => {
    const t = Date.parse(p.ts);
    return !Number.isNaN(t) && t < cutoff;
  });
}

// Build the spool JSONL line for a back-filled prompt. Matches the
// UserPromptSubmit hook's prompt_submitted envelope exactly so flush.sh's
// Pass-2 filter (event-batch-filter.jq) forwards it unchanged to control's
// ingest endpoint. turnId/turnIndex use the hook's own unanchored fallback
// (no per-session turn counter is available at back-fill time; the console
// orders the timeline by occurredAt, so these are diagnostic only).
export function buildBackfillPromptLine(prompt: TranscriptPrompt, sessionId: string): string {
  return JSON.stringify({
    ts: prompt.ts,
    event: "prompt_submitted",
    eventKey: `backfill-${prompt.uuid}`,
    sessionId,
    payload: { prompt: prompt.text, sessionTitle: "", turnId: null, turnIndex: 0 },
  });
}

export interface BackfillDeps {
  // Root of Claude Code's per-project transcript store (~/.claude/projects).
  projectsRoot: string;
  // The spool queue directory ($MEETLESS_HOME/queue).
  queueDir: string;
  // The folder's activation instant (marker.activatedAt), or null when unknown.
  activatedAt: string | null;
}

export interface BackfillResult {
  transcriptFound: boolean;
  spooled: number;
}

// Locate a session's transcript by scanning EVERY project dir for
// `<sessionId>.jsonl`. This is an encoding-independent presence check (mirrors
// makeTranscriptStatusResolver): even if Claude Code's project-dir encoding
// diverges from ours, a transcript that exists is still found.
function findTranscriptPath(sessionId: string, projectsRoot: string): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const cand = path.join(projectsRoot, entry, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      // not this dir; keep scanning
    }
  }
  return null;
}

// Recover the pre-activation prompts for a session and append them to its spool
// as prompt_submitted lines. Best-effort by contract: a missing transcript or an
// unreadable queue is a no-op, never an error, so it can never fail activation.
// The subsequent session-start.sh run spools session_started and spawns the
// flush, whose Pass 1 creates the run (from session_started) before Pass 2
// attaches these prompts, so there is no create-order race.
export function backfillSessionPrompts(sessionId: string, deps: BackfillDeps): BackfillResult {
  const transcriptPath = findTranscriptPath(sessionId, deps.projectsRoot);
  if (!transcriptPath) return { transcriptFound: false, spooled: 0 };

  let jsonl: string;
  try {
    jsonl = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return { transcriptFound: false, spooled: 0 };
  }

  const prompts = parseUserPromptsFromTranscript(jsonl);
  const pre =
    deps.activatedAt === null ? prompts : selectPreActivationPrompts(prompts, deps.activatedAt);
  if (pre.length === 0) return { transcriptFound: true, spooled: 0 };

  const lines = pre.map((p) => buildBackfillPromptLine(p, sessionId)).join("\n") + "\n";
  try {
    fs.mkdirSync(deps.queueDir, { recursive: true });
    fs.appendFileSync(path.join(deps.queueDir, `${sessionId}.jsonl`), lines, "utf8");
  } catch {
    return { transcriptFound: true, spooled: 0 };
  }
  return { transcriptFound: true, spooled: pre.length };
}
