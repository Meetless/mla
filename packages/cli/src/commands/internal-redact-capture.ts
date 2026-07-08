// `mla _internal redact-capture` (governed-story capture, P1). The
// user-prompt-submit / post-tool-use hooks assemble injected-context blocks and
// MCP query text in shell, then pipe a single JSON payload through this command
// to redact secrets BEFORE the trace is spooled. We redact here (in a node
// child) rather than in bash so the capture path reuses the ONE parity-locked
// redactor (lib/redactor.ts, mirror of intel + control), instead of forking a
// third, drifting copy of the secret patterns into shell. Spec
// notes/20260627-session-detail-mla-actions-and-colored-injection-timeline-design.md §4.4.
//
// Contract (fail-closed telemetry, fail-open agent -- the agent's prompt is
// delivered by the hook independently of this call):
//   stdin  : { blocks?: [{kind, content, citations?, charCount?, itemCount?}], query?: string }
//   stdout : { blocks: [{kind, content, contentStatus, citations, charCount, itemCount}], query }
//   exit 0 : redaction succeeded; the hook spools the redacted output verbatim.
//   exit 1 : ANY failure (unreadable/malformed stdin, serialization fault). The
//            hook treats this as redaction_failed: it persists content:null +
//            contentStatus:"redaction_failed" for every block and NEVER
//            substitutes a raw body. Raw content never leaves this process on a
//            failure path.
//
// charCount is computed HERE from the raw (pre-redaction) body so it is a single
// factual source the control boundary can check (summary.injectedCharCount ==
// sum(block.charCount)); the producer cannot drift it. citations and itemCount
// are producer metadata and pass through untouched (they are governance ids /
// counts, not secrets).

import { redact } from "../lib/redactor";

// contentStatus values this command can produce. "purged" (retention) and
// "redaction_failed" (this command failed; set by the hook) are produced
// elsewhere; this command only ever emits "available" or "redacted".
export type CaptureContentStatus =
  | "available"
  | "redacted"
  | "purged"
  | "redaction_failed";

export interface RedactCaptureBlockIn {
  kind: unknown;
  content?: unknown;
  citations?: unknown;
  charCount?: unknown;
  itemCount?: unknown;
}

export interface RedactCaptureInput {
  blocks?: unknown;
  query?: unknown;
}

export interface RedactCaptureBlockOut {
  kind: string;
  content: string | null;
  contentStatus: CaptureContentStatus;
  citations: string[];
  charCount: number;
  itemCount: number | null;
}

export interface RedactCaptureOutput {
  blocks: RedactCaptureBlockOut[];
  query: string | null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

// Count code points (not UTF-16 units) so the "N chars" the chip later shows is
// honest for multi-byte content. Computed from the RAW body, pre-redaction.
function charCountOf(content: string): number {
  return Array.from(content).length;
}

/**
 * Pure. Redact every block body and the query with the shared redactor.
 * - content null/empty stays as-is, contentStatus "available" (nothing to scrub).
 * - content that the redactor changed -> "redacted"; unchanged -> "available".
 * - charCount is the ORIGINAL (pre-redaction) length, factual.
 * Never throws on well-formed string inputs (redact is a regex replace); the IO
 * shell maps a throw to exit 1.
 */
export function redactCapturePayload(input: RedactCaptureInput): RedactCaptureOutput {
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  const blocks: RedactCaptureBlockOut[] = rawBlocks.map((b) => {
    const block = (b ?? {}) as RedactCaptureBlockIn;
    const kind = typeof block.kind === "string" ? block.kind : "unknown";
    const citations = asStringArray(block.citations);
    const itemCount = asNonNegativeInt(block.itemCount);

    const rawContent = typeof block.content === "string" ? block.content : null;
    if (rawContent === null || rawContent === "") {
      return {
        kind,
        content: rawContent,
        contentStatus: "available",
        citations,
        charCount: 0,
        itemCount,
      };
    }
    const redacted = redact(rawContent) ?? rawContent;
    return {
      kind,
      content: redacted,
      contentStatus: redacted === rawContent ? "available" : "redacted",
      citations,
      charCount: charCountOf(rawContent),
      itemCount,
    };
  });

  const rawQuery = typeof input.query === "string" ? input.query : null;
  const query = rawQuery === null ? null : (redact(rawQuery) ?? rawQuery);

  return { blocks, query };
}

export interface RedactCaptureDeps {
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

const defaultDeps: RedactCaptureDeps = {
  readStdin: readStdinReal,
  writeOut: (s) => process.stdout.write(s),
};

/**
 * IO shell. Reads the JSON payload from stdin, redacts, writes the redacted JSON
 * to stdout. Exit 1 on ANY failure (read error, malformed JSON, serialization
 * fault) WITHOUT writing a partial/raw body, so the hook degrades to
 * redaction_failed and never persists an unredacted secret. Takes no argv.
 */
export async function runInternalRedactCapture(
  _argv: string[],
  deps: RedactCaptureDeps = defaultDeps,
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
  if (!parsed || typeof parsed !== "object") return 1;
  try {
    const out = redactCapturePayload(parsed as RedactCaptureInput);
    deps.writeOut(JSON.stringify(out));
    return 0;
  } catch {
    return 1;
  }
}
