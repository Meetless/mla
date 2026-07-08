import { closeSync, fstatSync, openSync, readSync, statSync } from "fs";

import { sha256Hex } from "./canonical-json";
import type { ResponseSourceRefV1 } from "./ce0-store";

// CE0 §2.3 Stage B, the best-effort response snapshot
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3, lines 1119-1160).
//
// Stage B is layered ON TOP of the Stage A deadline claim, never inside it: a transcript read must
// never delay Stop, fail Stop, or roll back the deadline. This module holds the PURE selector
// (PARENT_ASSISTANT_TEXT_V1, with no filesystem surface) and the bounded backward reader that feeds
// it real transcript records. The reader is best-effort: every failure mode resolves to a stable
// labelability reason, never a throw.

const MAX_WINDOW_BYTES = 2 * 1024 * 1024; // 2 MiB (§2.3)
const MAX_RECORDS = 256; // at most 256 records from the tail (§2.3)
const NEWLINE = 0x0a; // JSONL is newline-delimited; 0x0a never appears inside a UTF-8 continuation byte

/**
 * The §2.3 PARENT_ASSISTANT_TEXT_V1 selector, as a pure function over already-parsed transcript
 * records given in file order (oldest first). It returns the canonical answer of the latest top-level
 * parent assistant record, or null when the scanned window holds no such record
 * (NO_PARENT_ASSISTANT_RECORD).
 *
 * A "top-level parent assistant record" is one whose `type` is "assistant" and which is NOT a
 * sidechain / subagent record (`isSidechain === true`). User, system, progress, and tool-result
 * records are excluded by that same `type` filter. The canonical answer is the selected record's text
 * blocks (`block.type === "text"`) joined with a single literal newline, preserving each block's text
 * exactly; a record with no text blocks yields the empty answer "" rather than skipping to an earlier
 * record. The latest such record wins, so the scan runs from the newest record backward and stops at
 * the first match.
 */
export function selectParentAssistantText(records: readonly unknown[]): string | null {
  const idx = findLatestParentAssistantIndex(records);
  return idx < 0 ? null : joinTextBlocks(records[idx] as Record<string, unknown>);
}

/** The latest (highest-index) top-level parent assistant record, or -1 when there is none. The byte
 * reader and the pure text selector share this one selection predicate. */
function findLatestParentAssistantIndex(records: readonly unknown[]): number {
  for (let i = records.length - 1; i >= 0; i--) {
    if (isTopLevelParentAssistant(records[i])) return i;
  }
  return -1;
}

function isTopLevelParentAssistant(rec: unknown): rec is Record<string, unknown> {
  if (typeof rec !== "object" || rec === null) return false;
  const r = rec as Record<string, unknown>;
  return r.type === "assistant" && r.isSidechain !== true;
}

/** Extract `message.content[]` text blocks in order and join them with a single literal newline.
 * A missing / malformed message, a non-array content, or an absence of text blocks all yield "". */
function joinTextBlocks(rec: Record<string, unknown>): string {
  const message = rec.message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
  }
  return texts.join("\n");
}

/** The Stage B reasons reachable on the live snapshot path. The remaining codes
 * (RECORD_HASH_MISMATCH, RECORD_UNPARSEABLE, RESPONSE_HASH_MISMATCH) belong to the offline
 * exporter-resolution half (§6.3), which re-derives the answer from this pointer. */
export type StopSnapshotUnlabelableReason =
  | "TRANSCRIPT_MISSING"
  | "TRANSCRIPT_UNREADABLE"
  | "NO_PARENT_ASSISTANT_RECORD";

export type StopResponseSnapshotResult =
  | { ok: true; responseHash: string; responseSourceRef: ResponseSourceRefV1 }
  | { ok: false; reason: StopSnapshotUnlabelableReason };

/**
 * Read the §2.3 Stage B response snapshot from the tail of a Claude transcript. Reads at most 2 MiB
 * and at most 256 records backward from the end, selects the latest top-level parent assistant record,
 * and returns its `responseHash = sha256Hex(canonicalAnswer)` plus a byte-exact `ResponseSourceRefV1`
 * pointer the offline exporter can rehydrate deterministically. Any unreadable / absent transcript or
 * empty selection window resolves to a stable reason; this function NEVER throws.
 */
export function readStopResponseSnapshot(
  transcriptPath: string | undefined,
): StopResponseSnapshotResult {
  if (!transcriptPath) return { ok: false, reason: "TRANSCRIPT_MISSING" };

  let isFile: boolean;
  try {
    isFile = statSync(transcriptPath).isFile();
  } catch (err) {
    return { ok: false, reason: isMissingError(err) ? "TRANSCRIPT_MISSING" : "TRANSCRIPT_UNREADABLE" };
  }
  // A path that exists but is not a regular file (e.g. a directory) is not MISSING; it simply cannot
  // be read as a transcript.
  if (!isFile) return { ok: false, reason: "TRANSCRIPT_UNREADABLE" };

  let coords: RecordCoord[];
  try {
    coords = readTailRecords(transcriptPath);
  } catch {
    return { ok: false, reason: "TRANSCRIPT_UNREADABLE" };
  }

  const idx = findLatestParentAssistantIndex(coords.map((c) => c.record));
  if (idx < 0) return { ok: false, reason: "NO_PARENT_ASSISTANT_RECORD" };

  const chosen = coords[idx];
  const canonicalAnswer = joinTextBlocks(chosen.record as Record<string, unknown>);
  const responseHash = sha256Hex(canonicalAnswer);
  const responseSourceRef: ResponseSourceRefV1 = {
    kind: "CLAUDE_TRANSCRIPT_JSONL",
    version: 1,
    transcriptPath,
    recordByteOffset: chosen.byteOffset,
    recordByteLength: chosen.byteLength,
    // The line's exact bytes; the line is valid UTF-8 (it parsed), so hashing the decoded string
    // re-encodes to the identical bytes the exporter will read at recordByteOffset.
    recordSha256: sha256Hex(chosen.bytes),
    selector: "PARENT_ASSISTANT_TEXT_V1",
  };
  return { ok: true, responseHash, responseSourceRef };
}

/** A parsed transcript record plus the exact byte span it occupies in the file. `bytes` is the line's
 * UTF-8 text (the trailing newline excluded); `byteLength` is its byte count, not its code-unit count. */
interface RecordCoord {
  record: unknown;
  byteOffset: number;
  byteLength: number;
  bytes: string;
}

function isMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read the tail window (at most 2 MiB) and parse it into records with exact byte coordinates, keeping
 * at most the last 256. When the window starts mid-file it almost certainly starts mid-record, so the
 * partial first line is dropped to keep every recorded byte span complete. Unparseable lines in the
 * live window are skipped (the selected record, a top-level assistant, parses by construction).
 */
function readTailRecords(transcriptPath: string): RecordCoord[] {
  const fd = openSync(transcriptPath, "r");
  let windowStart: number;
  let buf: Buffer;
  let read: number;
  try {
    const size = fstatSync(fd).size;
    const windowSize = Math.min(size, MAX_WINDOW_BYTES);
    windowStart = size - windowSize;
    buf = Buffer.allocUnsafe(windowSize);
    read = 0;
    while (read < windowSize) {
      const n = readSync(fd, buf, read, windowSize - read, windowStart + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }

  let cursor = 0;
  if (windowStart > 0) {
    const firstNl = buf.indexOf(NEWLINE, 0);
    cursor = firstNl === -1 ? read : firstNl + 1;
  }

  const coords: RecordCoord[] = [];
  while (cursor < read) {
    const nl = buf.indexOf(NEWLINE, cursor);
    const lineEnd = nl === -1 ? read : nl; // exclusive; excludes the trailing newline
    if (lineEnd > cursor) {
      const bytes = buf.subarray(cursor, lineEnd).toString("utf8");
      try {
        const record: unknown = JSON.parse(bytes);
        coords.push({ record, byteOffset: windowStart + cursor, byteLength: lineEnd - cursor, bytes });
      } catch {
        // not valid JSONL at this offset: skip it, it cannot be the selected assistant record
      }
    }
    if (nl === -1) break;
    cursor = nl + 1;
  }

  return coords.length > MAX_RECORDS ? coords.slice(coords.length - MAX_RECORDS) : coords;
}
