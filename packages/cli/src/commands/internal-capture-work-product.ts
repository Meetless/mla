// `mla _internal capture-work-product` -- stage the agent's own work product LIVE for the
// Evidence material-incorporation correlator's Prerequisite P1
// (notes/20260716-evidence-material-incorporation-correlator.md §5, §8, §10.6, §11).
//
// Two hook entry points, selected by --event:
//   post_tool_use  (Edit/Write/MultiEdit/NotebookEdit): stdin is the raw PostToolUse hook
//                  JSON; this composes the changed-code hunk(s) from tool_input and appends
//                  one `hunk` capture record per edit, keyed by (session_id, turn_index).
//   stop           (Stop): stdin is the turn's CLOSING assistant message text (already
//                  extracted + flush-settled by stop.sh); this appends one `assistant_output`
//                  capture record for the turn.
//
// WHY LIVE. The changed hunks live only in the raw Claude Code transcript, which auto-compaction
// can destroy before the correlation window closes (§8). Capturing at PostToolUse/Stop keeps the
// work product durable, turn-keyed, and available to the seal-on-window-close builder.
//
// DISCIPLINE. It rides OFF the session's hot path exactly like `_internal evidence-inject`: every
// failure is swallowed and it exits 0 (a strict argv parse error -> 2). The content is redacted +
// byte-capped and the whole write is consent-gated INSIDE the store (traceUploadEnabled, §11), so
// a capture we could never egress is never staged. The command does its own early consent check
// only to skip the compose work; the store is the authoritative gate.

import {
  appendAssistantOutputCapture,
  appendHunkCapture,
} from "../lib/analytics/work-product-capture";
import { traceUploadEnabled } from "../lib/analytics/consent";

export type CaptureWorkProductEvent = "post_tool_use" | "stop";

export interface CaptureWorkProductArgs {
  event: CaptureWorkProductEvent | null;
  sessionId: string | null;
  turnIndex: number | null;
}

export function parseArgs(argv: string[]): CaptureWorkProductArgs {
  const out: CaptureWorkProductArgs = {
    event: null,
    sessionId: null,
    turnIndex: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${a} requires a value.`);
      return v;
    };
    switch (a) {
      case "--event": {
        const v = value();
        if (v !== "post_tool_use" && v !== "stop") {
          throw new Error(`--event must be post_tool_use or stop, got: ${v}`);
        }
        out.event = v;
        break;
      }
      case "--session":
        out.sessionId = value();
        break;
      case "--turn": {
        const v = Number(value());
        out.turnIndex = Number.isInteger(v) ? v : null;
        break;
      }
      default:
        throw new Error(
          `Unknown flag for \`mla _internal capture-work-product\`: ${a}`,
        );
    }
  }
  return out;
}

// The four file-modifying tools whose changed content is the judged work product. A tool outside
// this set (a stray PostToolUse that reached this command) composes to zero hunks and no-ops.
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Prefix every line so the assembled hunk reads like a diff (the judge sees what left and what
// arrived). Redaction runs over the whole composed string downstream, so the markers never mask
// a secret from the redactor (KEY=value etc. are still matched line-internally).
function prefixLines(s: string, marker: string): string {
  return s
    .split("\n")
    .map((l) => marker + l)
    .join("\n");
}

// One before/after edit -> a `- old` / `+ new` block. A pure insertion (no old) or a pure deletion
// (no new) renders just the present side; a no-op edit (both empty) renders nothing.
function editHunk(oldStr: string, newStr: string): string {
  const parts: string[] = [];
  if (oldStr) parts.push(prefixLines(oldStr, "- "));
  if (newStr) parts.push(prefixLines(newStr, "+ "));
  return parts.join("\n");
}

// Compose the changed-code hunk text(s) from a PostToolUse tool_input. Edit -> one before/after
// block; Write / NotebookEdit -> one all-additions block; MultiEdit -> one block per edit. Empty
// blocks are dropped so a metadata-only tool call stages nothing.
export function composeHunks(
  toolName: string,
  toolInput: Record<string, unknown>,
): string[] {
  if (!FILE_TOOLS.has(toolName)) return [];
  switch (toolName) {
    case "Edit": {
      const h = editHunk(
        asString(toolInput.old_string),
        asString(toolInput.new_string),
      );
      return h ? [h] : [];
    }
    case "Write": {
      const c = asString(toolInput.content);
      return c ? [prefixLines(c, "+ ")] : [];
    }
    case "MultiEdit": {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const out: string[] = [];
      for (const e of edits) {
        const rec = (e ?? {}) as Record<string, unknown>;
        const h = editHunk(asString(rec.old_string), asString(rec.new_string));
        if (h) out.push(h);
      }
      return out;
    }
    case "NotebookEdit": {
      const c = asString(toolInput.new_source);
      return c ? [prefixLines(c, "+ ")] : [];
    }
    default:
      return [];
  }
}

export function resolveFile(toolInput: Record<string, unknown>): string {
  const fp = toolInput.file_path;
  if (typeof fp === "string" && fp) return fp;
  const nb = toolInput.notebook_path;
  if (typeof nb === "string" && nb) return nb;
  return "";
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

export interface CaptureWorkProductDeps {
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  appendHunk?: typeof appendHunkCapture;
  appendAssistantOutput?: typeof appendAssistantOutputCapture;
  nowIso?: string;
}

export async function runInternalCaptureWorkProduct(
  argv: string[],
  deps: CaptureWorkProductDeps = {},
): Promise<number> {
  let args: CaptureWorkProductArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const env = deps.env ?? process.env;
  const appendHunk = deps.appendHunk ?? appendHunkCapture;
  const appendAssistantOutput =
    deps.appendAssistantOutput ?? appendAssistantOutputCapture;

  // Read stdin FIRST (before any early return) so the piping hook never takes a SIGPIPE, then gate.
  let raw = "";
  try {
    raw = await (deps.readStdin ?? readStdinReal)();
  } catch {
    raw = "";
  }

  try {
    // Consent gate short-circuit (§11). The store is the authoritative gate (both append helpers
    // re-check), but skipping the JSON parse + compose here keeps a consent-off session cheap.
    if (!traceUploadEnabled(env)) {
      console.log(JSON.stringify({ captured: false, reason: "consent_off" }));
      return 0;
    }

    const sessionId =
      args.sessionId ?? ((env.CLAUDE_CODE_SESSION_ID || "").trim() || null);
    if (!sessionId) {
      console.log(JSON.stringify({ captured: false, reason: "no_session" }));
      return 0;
    }
    const turnIndex = args.turnIndex;
    if (turnIndex === null || !Number.isInteger(turnIndex)) {
      console.log(JSON.stringify({ captured: false, reason: "no_turn" }));
      return 0;
    }

    if (args.event === "stop") {
      // stdin is the CLOSING assistant message text (stop.sh already extracted + settled it).
      if (raw.trim().length === 0) {
        console.log(JSON.stringify({ captured: false, reason: "empty_output" }));
        return 0;
      }
      appendAssistantOutput(
        { sessionId, turnIndex, text: raw, nowIso: deps.nowIso },
        env,
      );
      console.log(
        JSON.stringify({
          captured: true,
          kind: "assistant_output",
          turn_index: turnIndex,
        }),
      );
      return 0;
    }

    // event === post_tool_use: stdin is the raw PostToolUse hook JSON.
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.log(JSON.stringify({ captured: false, reason: "bad_json" }));
      return 0;
    }
    const toolName = asString(payload.tool_name);
    const toolInput =
      payload.tool_input && typeof payload.tool_input === "object"
        ? (payload.tool_input as Record<string, unknown>)
        : {};
    const file = resolveFile(toolInput);
    const hunks = composeHunks(toolName, toolInput);
    let count = 0;
    for (const hunk of hunks) {
      if (!hunk) continue;
      appendHunk(
        { sessionId, turnIndex, file, tool: toolName, hunk, nowIso: deps.nowIso },
        env,
      );
      count++;
    }
    console.log(
      JSON.stringify({
        captured: count > 0,
        kind: "hunk",
        count,
        turn_index: turnIndex,
      }),
    );
    return 0;
  } catch {
    // Fail-soft: a capture failing to stage never disturbs the session it rode on.
    console.log(JSON.stringify({ captured: false, reason: "error" }));
    return 0;
  }
}
