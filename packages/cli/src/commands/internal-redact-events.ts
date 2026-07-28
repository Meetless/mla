// `mla _internal redact-events` -- the MANDATORY redaction boundary for every
// hook-spooled event that leaves this machine.
//
// Why this exists. Before this command, only two capture paths went through the
// shared redactor (injected-context blocks and the MCP query text, both via
// `redact-capture`). Everything else the bash hooks spool -- the raw user
// prompt, the assistant's between-tool narration, the final message, the full
// bash command plus its stdout/stderr tails, and the whole agent-decision Q&A --
// was written to ~/.meetless/queue/<sid>.jsonl verbatim and PATCHed to control
// verbatim. A pasted API key in any of those reached the backend in the clear.
//
// Rather than bolt a redact call onto each of the ~8 spool sites (each of which
// costs a node spawn on a latency-sensitive hook, and each of which a future
// event type would silently bypass), we redact ONCE at the single network
// egress chokepoint: flush.sh Pass 2, after the jq batch filter has built the
// events array and before the PATCH body is assembled. One spawn per flush
// batch, on an already-detached process, covering every event type that exists
// now or later.
//
// Policy: DEFAULT-REDACT. Every string leaf inside `payload` is passed through
// the ONE parity-locked redactor (lib/redactor.ts) UNLESS its key is in
// STRUCTURAL_KEYS. The allowlist is deliberately the exception rather than the
// rule so that a new payload field added by a future hook is redacted by
// default -- forgetting to update this file fails safe (over-redaction), never
// unsafe (a leaked secret).
//
// Why an allowlist at all, instead of blanket redactPayload: the redactor's
// high-entropy heuristic fires on any 32+ char token with 2+ character classes,
// which a session UUID, a turnId, a tool_use id, or a content hash all satisfy.
// Blanket redaction would replace the correlation ids control joins on, and the
// batch would land structurally intact but semantically destroyed. STRUCTURAL_KEYS
// enumerates exactly those identifier / enum / counter / timestamp fields.
//
// Contract (fail-closed telemetry, fail-open agent):
//   stdin  : JSON array of event records [{eventKey, eventType, occurredAt, source, payload, ...}]
//   stdout : the same array, byte-identical except for redacted payload strings
//   exit 0 : redaction succeeded; the caller PATCHes the redacted array.
//   exit 1 : ANY failure (unreadable/malformed stdin, non-array, serialization
//            fault). NOTHING is written to stdout. flush.sh treats this as a
//            deferral: the events stay spooled and the batch is retried on the
//            next flush; raw bodies are never sent as a fallback.

import { redact } from "../lib/redactor";

// Keys whose values are structural -- identifiers, enums, counters, timestamps,
// and governance citations. These are NOT free text, and several of them would
// be destroyed by the redactor's entropy heuristic (UUIDs, tool_use ids, hashes).
// Everything NOT listed here is treated as potentially-secret-bearing free text.
//
// Sourced from the payloads of every event the hooks currently spool:
// prompt_submitted, tool_used_bash, tool_used_file, tool_used_mcp,
// session_stopped, assistant_message, injection_trace, agent_decision_captured.
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  // correlation ids
  "id",
  "sessionId",
  "eventKey",
  "turnId",
  "turnIndex",
  "injectId",
  "traceId",
  "entryUuid",
  "providerEventId",
  "providerSessionId",
  "choiceId",
  "choiceIds",
  "sourceIds",
  "source_id",
  "citation",
  "citations",
  "rawPromptHash",
  "raw_prompt_hash",
  // timestamps
  "ts",
  "occurredAt",
  "capturedAt",
  "detectedAt",
  "startedAt",
  "endedAt",
  "createdAt",
  "updatedAt",
  // enums / classifications / flags
  "event",
  "eventType",
  "source",
  "sourceSurface",
  "adapter",
  "provider",
  "providerSource",
  "providerToolName",
  "decisionKind",
  "choiceMatchStatus",
  "multiSelect",
  "capturedBy",
  "categoryHint",
  "storyCategory",
  "tool",
  "toolName",
  "operation",
  "outcome",
  "status",
  "deliveryStatus",
  "contentStatus",
  "kind",
  "trust",
  "provenance",
  "field",
  "injected",
  "schemaVersion",
  "confidence",
  // counters / sizes
  "exitCode",
  "charCount",
  "itemCount",
  "blockCount",
  "injectedCharCount",
  "promptChars",
  "prompt_chars",
  // filesystem locations (governance metadata the story renders; never a body)
  "filePath",
  "markdownPath",
  "cwd",
]);

/**
 * Recursively redact a payload value.
 *
 * `key` is the object key the value was reached under (null at the payload
 * root). Array elements inherit their parent's key, so `choices: ["a", "b"]`
 * redacts each element as free text while `sourceIds: [...]` passes through.
 *
 * Non-strings are structurally preserved. Only string leaves are ever rewritten.
 */
export function redactEventValue(value: unknown, key: string | null): unknown {
  if (typeof value === "string") {
    if (key !== null && STRUCTURAL_KEYS.has(key)) return value;
    // The "events" profile, and its ONLY production caller. Same literal
    // patterns and same entropy bar as "full"; the one difference is that a
    // path-shaped token (slash, lowercase, no uppercase) survives the entropy
    // sweep. Measured over the real corpus, "full" alters 64% of captured bash
    // commands and eats 8,909 path-shaped spans while only 2.3% of those items
    // contain any credential pattern at all, which leaves `mla review`
    // reasoning about a ledger that cannot say which file a command touched.
    // See PATH_LIKE_EXEMPTION in lib/redactor.ts for the accepted residual.
    return redact(value, "events") ?? value;
  }
  if (Array.isArray(value)) return value.map((v) => redactEventValue(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactEventValue(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Pure. Redact the `payload` of every event in the batch, preserving the
 * envelope (eventKey / eventType / occurredAt / source / provider / adapter)
 * exactly -- control joins and dedupes on those.
 *
 * Records that are not objects are passed through untouched; the jq filter that
 * produces this array already guarantees object records, and silently dropping
 * a record here would look like data loss rather than a redaction concern.
 */
export function redactEventBatch(events: unknown[]): unknown[] {
  return events.map((ev) => {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return ev;
    const rec = ev as Record<string, unknown>;
    if (!("payload" in rec)) return rec;
    return { ...rec, payload: redactEventValue(rec.payload, null) };
  });
}

export interface RedactEventsDeps {
  readStdin: () => Promise<string>;
  writeOut: (s: string) => void;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const defaultDeps: RedactEventsDeps = {
  readStdin: readStdinReal,
  writeOut: (s) => process.stdout.write(s),
};

/**
 * IO shell. Reads the JSON events array from stdin, redacts every payload,
 * writes the redacted array to stdout. Exit 1 on ANY failure WITHOUT writing a
 * partial or raw body, so the caller defers the batch instead of shipping
 * unredacted content. Takes no argv.
 */
export async function runInternalRedactEvents(
  _argv: string[],
  deps: RedactEventsDeps = defaultDeps,
): Promise<number> {
  let raw: string;
  try {
    raw = await deps.readStdin();
  } catch {
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 1;
  }
  if (!Array.isArray(parsed)) return 1;
  try {
    const out = redactEventBatch(parsed);
    deps.writeOut(JSON.stringify(out));
    return 0;
  } catch {
    return 1;
  }
}
