// Local work-product capture: the durable, consent-gated, redacted staging store
// for the Evidence material-incorporation correlator's Prerequisite P1
// (notes/20260716-evidence-material-incorporation-correlator.md §5, §8, §10.6, §11).
//
// WHY THIS EXISTS. A materiality judge is worthless without the agent's actual output
// to judge against, and today nothing durably persists that output nor binds it to a
// turn: the changed-code hunks live only in the raw Claude Code transcript
// (Edit.input.old_string/new_string, Write.input.content), which no correlator reads
// and which auto-compaction can destroy before the correlation window closes (§8).
// This store captures those hunks (at PostToolUse) and each closing assistant message
// (at Stop) LIVE, keyed by (session_id, turn_index), before compaction can drop them.
//
// PRIVACY BOUNDARY. P1 crosses the v0 "no file content, no diff, no tool I/O" boundary
// on purpose, so every write here is gated on the existing content-upload consent
// (traceUploadEnabled, §11); when consent is off nothing is staged. Content is redacted
// with the ONE parity-locked redactor at capture time (defense in depth: raw secrets
// never touch even the local staging file) and byte-capped. The store is reaped after a
// 48h local TTL (§11) and eagerly deleted on a successful atomic intake (§10.6).
//
// THE HASH IS SERVER-OWNED. Per §10.6 the CLI "does not send a trusted input_digest_hash":
// it POSTs the sealed, canonically-ordered digest and control recomputes the hash inside
// its intake transaction (materiality-identity.ts). So this module deliberately does NOT
// port canonicalizeDigest / computeInputDigestHash; it only builds the exact §5 wire shape
// (OMITTING input_digest_hash, INCLUDING sealed_at) and the correlator freezes those bytes
// to disk so a retry replays byte-identical content -> the same server hash -> idempotent.

import * as fs from "fs";
import * as path from "path";
import { resolveMeetlessHome } from "../config";
import { redact } from "../redactor";
import { traceUploadEnabled } from "./consent";

// --- byte + count caps ------------------------------------------------------
// Bounded egress: each captured piece is truncated to a byte cap (on a UTF-8
// boundary) and each turn keeps at most a bounded number of hunks/outputs. Hitting
// any cap sets the turn's completeness.truncated so the judge can honestly return
// insufficient_evidence rather than judge a partial record (§5 judge doctrine).
export const HUNK_MAX_BYTES = 8 * 1024;
export const ASSISTANT_OUTPUT_MAX_BYTES = 16 * 1024;
export const USER_PROMPT_MAX_BYTES = 8 * 1024;
export const MAX_HUNKS_PER_TURN = 50;
export const MAX_ASSISTANT_OUTPUTS_PER_TURN = 8;

// The local staged capture is dropped after this age (§11 retention table). This is a
// code-owned constant, NOT an env var, matching the repo's constant-not-config convention.
export const WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS = 48;

const CAPTURE_DIR = "work-product-capture";
const HOUR_MS = 60 * 60 * 1000;

// --- store location ---------------------------------------------------------

export function captureStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMeetlessHome({ env }), CAPTURE_DIR);
}

// sessionId is a hook-provided string; sanitize to a safe single-segment basename so a
// hostile or malformed id can never escape the capture dir. Empty -> "unknown".
function sessionFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safe || "unknown"}.jsonl`;
}

export function captureSessionPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(captureStoreDir(env), sessionFileName(sessionId));
}

function ensureCaptureDir(env: NodeJS.ProcessEnv): void {
  const dir = captureStoreDir(env);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- redaction + byte caps --------------------------------------------------

// A single captured/prepared piece of content: redacted, byte-capped, and carrying the
// two completeness signals the judge needs (§5). `truncated` means a byte cap was hit;
// `redactedSubstance` means redaction removed a meaningful fraction of the content.
export interface PreparedPiece {
  text: string;
  truncated: boolean;
  redactedSubstance: boolean;
}

// Cut a string to at most maxBytes UTF-8 bytes without splitting a multibyte char. A
// truncated buffer decoded as utf8 ends in U+FFFD for a split codepoint; strip a single
// trailing replacement char so the tail is always valid text.
function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  const decoded = buf.subarray(0, maxBytes).toString("utf8");
  const text = decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
  return { text, truncated: true };
}

// Did redaction remove the substance? Deterministic proxy: after removing every
// [REDACTED] placeholder from the redacted text, if less than half the original bytes
// survive, redaction gutted the content and the judge cannot fairly assess it. A single
// stray token replaced in a large hunk leaves substance intact and does NOT flag.
function redactionLostSubstance(original: string, redacted: string): boolean {
  if (original === redacted) return false;
  const surviving = redacted.split("[REDACTED]").join("");
  const survivingBytes = Buffer.byteLength(surviving, "utf8");
  const originalBytes = Buffer.byteLength(original, "utf8");
  if (originalBytes === 0) return false;
  return survivingBytes < originalBytes * 0.5;
}

// Redact FIRST (so a byte cap never leaves half a secret exposed), then cap. Returns the
// egress-safe text plus both completeness signals.
export function prepareContent(raw: string, maxBytes: number): PreparedPiece {
  const redacted = (redact(raw) ?? "") as string;
  const redactedSubstance = redactionLostSubstance(raw, redacted);
  const { text, truncated } = capBytes(redacted, maxBytes);
  return { text, truncated, redactedSubstance };
}

// --- on-disk capture records ------------------------------------------------

export type CaptureKind = "hunk" | "assistant_output";

// One staged line in the per-session capture file. Content is ALREADY redacted +
// byte-capped when written (raw content never lands here). Read leniently; a torn final
// line from a crash mid-append is skipped, never fatal.
export interface CaptureRecord {
  session_id: string;
  turn_index: number;
  kind: CaptureKind;
  ts: string;
  // hunk fields
  file?: string;
  tool?: string;
  hunk?: string;
  // assistant_output field
  text?: string;
  // completeness signals, computed at capture time
  truncated?: boolean;
  redacted_substance?: boolean;
}

function appendRecord(
  rec: CaptureRecord,
  env: NodeJS.ProcessEnv,
  onError?: (err: unknown) => void,
): void {
  // Consent gate (§11): capture rides the existing content-upload consent. Off -> stage
  // nothing, because a capture we could never egress is pure risk with no payoff.
  if (!traceUploadEnabled(env)) return;
  try {
    ensureCaptureDir(env);
    // Single-writer append: the hook wraps this call under ml_lock (mirroring the
    // mcp-calls.jsonl spool), so appends are serialized per session and this stays a
    // plain best-effort append. A disk error is swallowed; capture must never break the
    // session it rides on.
    fs.appendFileSync(
      captureSessionPath(rec.session_id, env),
      JSON.stringify(rec) + "\n",
      "utf8",
    );
  } catch (err) {
    if (onError) onError(err);
  }
}

// Stage one changed-code hunk (PostToolUse on Edit/Write/MultiEdit). `hunk` is the
// assembled change text (the caller composes it from tool_input); it is redacted +
// byte-capped here so raw code/secrets never touch disk.
export function appendHunkCapture(
  input: {
    sessionId: string;
    turnIndex: number;
    file: string;
    tool: string;
    hunk: string;
    nowIso?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
): void {
  if (!traceUploadEnabled(env)) return;
  const piece = prepareContent(input.hunk, HUNK_MAX_BYTES);
  appendRecord(
    {
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      kind: "hunk",
      ts: input.nowIso ?? new Date().toISOString(),
      file: input.file,
      tool: input.tool,
      hunk: piece.text,
      truncated: piece.truncated,
      redacted_substance: piece.redactedSubstance,
    },
    env,
    onError,
  );
}

// Stage one closing assistant message (Stop). Redacted + byte-capped; the id is assigned
// at build time from file order (assistant:turn-N:final).
export function appendAssistantOutputCapture(
  input: {
    sessionId: string;
    turnIndex: number;
    text: string;
    nowIso?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
): void {
  if (!traceUploadEnabled(env)) return;
  const piece = prepareContent(input.text, ASSISTANT_OUTPUT_MAX_BYTES);
  appendRecord(
    {
      session_id: input.sessionId,
      turn_index: input.turnIndex,
      kind: "assistant_output",
      ts: input.nowIso ?? new Date().toISOString(),
      text: piece.text,
      truncated: piece.truncated,
      redacted_substance: piece.redactedSubstance,
    },
    env,
    onError,
  );
}

// Read all staged records for a session. Lenient: absent file -> [], malformed line ->
// skipped. NOT consent-gated (reading a local file is harmless; the seal path enforces
// consent before it POSTs anything).
export function readCaptures(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): CaptureRecord[] {
  const file = captureSessionPath(sessionId, env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: CaptureRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as CaptureRecord;
      if (
        rec &&
        typeof rec.session_id === "string" &&
        Number.isInteger(rec.turn_index) &&
        (rec.kind === "hunk" || rec.kind === "assistant_output")
      ) {
        out.push(rec);
      }
    } catch {
      // torn or corrupt line -> skip, never fail the read
    }
  }
  return out;
}

// Eager delete on a successful atomic intake (§10.6): remove one session's staged file.
// Best-effort; a missing file is a no-op.
export function deleteSessionCapture(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    fs.unlinkSync(captureSessionPath(sessionId, env));
  } catch {
    // already gone / unreadable -> nothing to do
  }
}

// The feature-scoped local reaper (§11): drop staged session files whose last write is
// older than the TTL (mtime, which advances on every append, so an old mtime means the
// session stopped capturing and is safe to purge). Touches ONLY this store, never the
// general events file's size-only rotation. Returns the count deleted. Best-effort.
export function reapLocalCaptures(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): number {
  const dir = captureStoreDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no store yet -> nothing to reap
  }
  const cutoffMs = nowMs - WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS * HOUR_MS;
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoffMs) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch {
      // race with another writer / already gone -> skip
    }
  }
  return deleted;
}

// --- §5 sealed work-product digest ------------------------------------------

// The exact §5 wire shape the CLI POSTs (the judge input MINUS input_digest_hash, which
// control recomputes; PLUS sealed_at, which the CLI stamps once and freezes). Field names
// are snake_case to match the judge contract and the artifact-item ids the grounding cites.
export interface DigestAssistantOutput {
  id: string; // "assistant:turn-N:final"
  text: string;
}
export interface DigestChangedHunk {
  id: string; // "hunk:turn-N:edit-M"
  file: string;
  tool: string;
  hunk: string;
}
export interface DigestFileMeta {
  file: string;
  tool: string;
}
export interface DigestCompleteness {
  truncated: boolean;
  redacted_substance: boolean;
}
export interface DigestTurn {
  turn_index: number;
  user_prompt: string;
  assistant_outputs: DigestAssistantOutput[];
  changed_hunks: DigestChangedHunk[];
  files_metadata: DigestFileMeta[];
  completeness: DigestCompleteness;
}
export interface WorkProductDigest {
  window_start_turn: number;
  window_end_turn: number;
  capture_contract_version: number;
  turns: DigestTurn[];
  sealed_at: string;
  // input_digest_hash is intentionally OMITTED (§10.6: control recomputes it).
}

// The prepared per-turn inputs the builder folds into one turn entry. Hunks and outputs
// arrive ALREADY prepared (redacted + capped) from the capture records; user_prompts
// arrive RAW (from ask-traces.jsonl) and are prepared here, so every completeness signal
// is aggregated in exactly one place.
export interface DigestTurnInput {
  turn_index: number;
  user_prompts: string[];
  assistant_outputs: PreparedPiece[];
  hunks: Array<{ file: string; tool: string; piece: PreparedPiece }>;
}

export interface BuildWorkProductDigestInput {
  windowStartTurn: number;
  windowEndTurn: number;
  captureContractVersion: number;
  sealedAtIso: string;
  turns: DigestTurnInput[];
}

// Group a flat list of capture records by turn into the prepared shape the builder wants.
// Preserves file/append order (semantic per §5: hunks and outputs are individually
// addressable in the order they occurred), which is what fixes the edit-M / final ids.
export function assembleTurnCaptures(
  records: CaptureRecord[],
): Map<number, { assistant_outputs: PreparedPiece[]; hunks: DigestTurnInput["hunks"] }> {
  const byTurn = new Map<
    number,
    { assistant_outputs: PreparedPiece[]; hunks: DigestTurnInput["hunks"] }
  >();
  for (const rec of records) {
    let slot = byTurn.get(rec.turn_index);
    if (!slot) {
      slot = { assistant_outputs: [], hunks: [] };
      byTurn.set(rec.turn_index, slot);
    }
    const piece: PreparedPiece = {
      text: rec.kind === "hunk" ? (rec.hunk ?? "") : (rec.text ?? ""),
      truncated: rec.truncated === true,
      redactedSubstance: rec.redacted_substance === true,
    };
    if (rec.kind === "hunk") {
      slot.hunks.push({ file: rec.file ?? "", tool: rec.tool ?? "", piece });
    } else {
      slot.assistant_outputs.push(piece);
    }
  }
  return byTurn;
}

// Build the sealed §5 digest. Pure over its inputs (no clock, no I/O): the correlator
// supplies sealed_at so the bytes can be frozen and replayed byte-identically on retry.
// Per-turn completeness.{truncated, redacted_substance} is the OR across every piece in
// the turn (prompts, outputs, hunks) plus any list-length drop, exactly the signal the
// judge reads to return insufficient_evidence honestly.
export function buildWorkProductDigest(
  input: BuildWorkProductDigestInput,
): WorkProductDigest {
  const turns: DigestTurn[] = [];
  // Ascending by turn_index (canonical §8 ordering), regardless of caller order.
  const ordered = [...input.turns].sort((a, b) => a.turn_index - b.turn_index);

  for (const t of ordered) {
    let truncated = false;
    let redactedSubstance = false;

    // user_prompt: every direct prompt for the turn, each redacted + capped, joined.
    const preparedPrompts = t.user_prompts.map((p) =>
      prepareContent(p, USER_PROMPT_MAX_BYTES),
    );
    for (const pp of preparedPrompts) {
      truncated = truncated || pp.truncated;
      redactedSubstance = redactedSubstance || pp.redactedSubstance;
    }
    const user_prompt = preparedPrompts.map((pp) => pp.text).join("\n\n");

    // assistant_outputs: cap the list length, then id each in occurrence order.
    const outputsIn = t.assistant_outputs.slice(0, MAX_ASSISTANT_OUTPUTS_PER_TURN);
    if (t.assistant_outputs.length > MAX_ASSISTANT_OUTPUTS_PER_TURN) truncated = true;
    const assistant_outputs: DigestAssistantOutput[] = outputsIn.map((piece, i) => {
      truncated = truncated || piece.truncated;
      redactedSubstance = redactedSubstance || piece.redactedSubstance;
      return {
        id: i === 0 ? `assistant:turn-${t.turn_index}:final` : `assistant:turn-${t.turn_index}:final-${i + 1}`,
        text: piece.text,
      };
    });

    // changed_hunks: cap the list length, then id each edit-M (1-based) in occurrence order.
    const hunksIn = t.hunks.slice(0, MAX_HUNKS_PER_TURN);
    if (t.hunks.length > MAX_HUNKS_PER_TURN) truncated = true;
    const changed_hunks: DigestChangedHunk[] = hunksIn.map((h, i) => {
      truncated = truncated || h.piece.truncated;
      redactedSubstance = redactedSubstance || h.piece.redactedSubstance;
      return {
        id: `hunk:turn-${t.turn_index}:edit-${i + 1}`,
        file: h.file,
        tool: h.tool,
        hunk: h.piece.text,
      };
    });

    // files_metadata: distinct { file, tool } across the turn's hunks, first-seen order.
    const seen = new Set<string>();
    const files_metadata: DigestFileMeta[] = [];
    for (const h of hunksIn) {
      const key = `${h.tool} ${h.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files_metadata.push({ file: h.file, tool: h.tool });
    }

    turns.push({
      turn_index: t.turn_index,
      user_prompt,
      assistant_outputs,
      changed_hunks,
      files_metadata,
      completeness: { truncated, redacted_substance: redactedSubstance },
    });
  }

  return {
    window_start_turn: input.windowStartTurn,
    window_end_turn: input.windowEndTurn,
    capture_contract_version: input.captureContractVersion,
    turns,
    sealed_at: input.sealedAtIso,
  };
}
