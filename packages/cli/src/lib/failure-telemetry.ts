// Agent-failure telemetry: the central sanitizer, the local deadletter, and the
// F8 (telemetry-upload-failed) detector. The TS half of the
// notes/20260608-agent-failure-telemetry-sentry-proposal.md §8 contracts.
//
// Three §8 invariants live here:
//   INV-TELEMETRY-METADATA-CLASSIFICATION  -> sanitizeTelemetry (allowlist, fail closed)
//   INV-DEADLETTER-SAFETY                  -> appendDeadletter / flushDeadletter (0600, bounded, TTL, backoff)
//   F8 detector                            -> recordTelemetryUploadFailure
//
// The Python twin is intel app/core/telemetry_sanitizer.py + failure_telemetry.py.
// The two MUST classify the same field names the same way; a field that hashes on
// one plane and ships raw on the other defeats the whole contract.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveMeetlessHome, telemetryDisabled } from "./config";

// Schema version stamped on every deadletter record. Bump when the record shape
// changes so a post-upgrade replay can drop records it no longer understands
// (INV-DEADLETTER-SAFETY: schema-versioned).
export const TELEMETRY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// INV-TELEMETRY-METADATA-CLASSIFICATION: the single central sanitizer.
//
// One choke point. Every telemetry / deadletter payload passes through this
// before it leaves the process. The table is an ALLOWLIST: any field not
// classified here is dropped, so an unclassified field fails closed to
// "not sent" rather than open to "sent raw" (An, 2026-06-08). The next detector
// author who adds a field MUST add a row, which is the point.
// ---------------------------------------------------------------------------

// Always sent verbatim: low-cardinality enums and the cross-system join keys.
// workspace_id / session_id are server-resolved identifiers, not free text.
const ALWAYS_SEND = new Set<string>([
  "failure_class",
  "severity",
  "trace_id",
  "surface",
  "workspace_id",
  "session_id",
  "schema_version",
  "release",
  "mla_version",
  "platform",
  "environment",
  "window",
  "tool", // tool NAME (e.g. "Bash", "Edit") is low-cardinality, not content
  "posture",
  "reason_code",
  "status", // HTTP status code: low-cardinality integer, never content
  "http_status",
  "status_code",
  // Billing sub-reason enum from a 402 (e.g. "NO_PAYER"). Bounded to a short
  // SCREAMING_SNAKE token at the MCP boundary (intel_error_mask.js SAFE_ENUM)
  // before it ever reaches here, so it is a low-cardinality enum, never content.
  "billing_reason",
]);

// Never sent: content and anything that can carry customer / security context.
// Full paths and raw text are the canonical leak vectors (§8: a path like
// customers/acme/security-audit/oauth-migration.ts is itself sensitive).
const NEVER_SEND = new Set<string>([
  "full_path",
  "path",
  "file_path",
  "query",
  "query_text",
  "answer",
  "answer_text",
  "prompt",
  "prompt_text",
  "tool_output",
  "tool_input",
  "doc_body",
  "content",
  "code",
  "stdout",
  "stderr",
  "message_text",
]);

// File basenames are hashed (not sent raw): keeps the path out of the clear but
// preserves cross-event correlation via a stable digest. A full path smuggled
// under one of these keys is reduced to its basename first, then hashed.
const BASENAME_KEYS = new Set<string>([
  "file_basename",
  "basename",
  "file_name",
  "filename",
  "target_basename",
]);

// Nested metadata bags that are themselves sanitized field-by-field. Lets a
// detector pass a `metadata_only_context: { candidate_count: 3 }` without the
// whole object being dropped, while every field inside it still runs the table.
const CONTAINER_KEYS = new Set<string>(["context", "metadata_only_context", "metadata"]);

// Numeric metadata: counts, durations, lengths, byte sizes, attempt counters.
// Only sent when the value is actually a number, so a string smuggled under a
// "*_count" key still drops.
const NUMERIC_METADATA_RE =
  /(?:_count|_ms|_seconds|_secs|_duration|_len|_length|_bytes|_attempts?|_size|_total|_index|_n)$|^(?:count|attempts|duration_ms|n|index|total)$/i;

// Hash a basename into a stable, non-reversible short digest. A full path is
// reduced to its last segment first (split on both separators so a Windows path
// is handled), so even a misclassified full path cannot leak its parent dirs.
export function hashBasename(value: string): string {
  const base = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  const digest = crypto.createHash("sha256").update(base).digest("hex").slice(0, 16);
  return `b_${digest}`;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The central sanitizer. Drop-by-default. Returns a new object; the input is
// never mutated. Recurses one level into known container keys so a detector's
// metadata bag is classified field-by-field, not waved through.
export function sanitizeTelemetry(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (NEVER_SEND.has(key)) continue;
    if (CONTAINER_KEYS.has(key) && isPlainObject(value)) {
      out[key] = sanitizeTelemetry(value);
      continue;
    }
    if (BASENAME_KEYS.has(key) && typeof value === "string") {
      out[`${key}_hash`] = hashBasename(value);
      continue;
    }
    if (ALWAYS_SEND.has(key) && isScalar(value)) {
      out[key] = value;
      continue;
    }
    if (NUMERIC_METADATA_RE.test(key) && typeof value === "number") {
      out[key] = value;
      continue;
    }
    // Allowlist fail-closed: anything not classified above is dropped.
  }
  return out;
}

// ---------------------------------------------------------------------------
// INV-DEADLETTER-SAFETY: the bounded, mode-0600, TTL-governed local store.
// ---------------------------------------------------------------------------

export const DEADLETTER_MAX_RECORDS = 500;
export const DEADLETTER_MAX_BYTES = 1_000_000; // 1 MB ceiling
export const DEADLETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEADLETTER_MAX_ATTEMPTS = 5;
const DEADLETTER_BACKOFF_BASE_MS = 60_000; // 1 minute
const DEADLETTER_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEADLETTER_FILE_MODE = 0o600;
const DEADLETTER_DIR_MODE = 0o700;

export interface DeadletterRecord {
  schema_version: number;
  created_at: string;
  expires_at: string;
  attempts: number;
  last_attempt_at: string | null;
  failure_class: string;
  event: Record<string, unknown>;
}

// config.ts's HOME resolution, computed per-call so a test can redirect the whole
// store to a temp dir via MEETLESS_HOME without module-cache games. This used to be
// a hand-rolled copy of the same expression, which is how it inherited the
// `os.homedir()` trap independently of config.ts (see userHomeDir).
function homeDir(env: NodeJS.ProcessEnv): string {
  return resolveMeetlessHome({ env });
}

export function deadletterPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), "telemetry-deadletter.jsonl");
}

function readRecords(file: string): DeadletterRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: DeadletterRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as DeadletterRecord;
      // Drop records from an older/newer schema we cannot safely replay.
      if (rec && rec.schema_version === TELEMETRY_SCHEMA_VERSION) out.push(rec);
    } catch {
      // A torn line (partial write) is skipped, not fatal.
    }
  }
  return out;
}

function notExpired(rec: DeadletterRecord, now: number): boolean {
  const exp = Date.parse(rec.expires_at);
  return Number.isNaN(exp) ? true : now < exp;
}

// Enforce the count + byte ceilings by dropping OLDEST records first. The file
// is append-mostly, so position == age; keeping the tail keeps the freshest.
function enforceBounds(records: DeadletterRecord[]): DeadletterRecord[] {
  let kept = records;
  if (kept.length > DEADLETTER_MAX_RECORDS) {
    kept = kept.slice(kept.length - DEADLETTER_MAX_RECORDS);
  }
  let serialized = kept.map((r) => JSON.stringify(r)).join("\n");
  while (kept.length > 0 && Buffer.byteLength(serialized, "utf8") > DEADLETTER_MAX_BYTES) {
    kept = kept.slice(1);
    serialized = kept.map((r) => JSON.stringify(r)).join("\n");
  }
  return kept;
}

// Atomic-ish rewrite with locked-down perms. Writes the whole set (the store is
// low-volume: it only grows on an upload failure), then chmods to 0600 even when
// the file pre-existed with looser perms.
function writeRecords(file: string, records: DeadletterRecord[]): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: DEADLETTER_DIR_MODE });
  const body = records.length > 0 ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  fs.writeFileSync(file, body, { mode: DEADLETTER_FILE_MODE });
  try {
    fs.chmodSync(file, DEADLETTER_FILE_MODE);
  } catch {
    // best-effort on platforms without POSIX perms
  }
}

// Append one failure event. Sanitizes BEFORE write so a replayed record can
// never carry content the live path would have stripped (§8, An Decision 9).
// Never throws: a telemetry write must not break the user's command.
export function appendDeadletter(
  event: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DeadletterRecord | null {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  try {
    const sanitized = sanitizeTelemetry(event);
    const record: DeadletterRecord = {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + DEADLETTER_TTL_MS).toISOString(),
      attempts: 0,
      last_attempt_at: null,
      failure_class: String(sanitized.failure_class ?? "unknown"),
      event: sanitized,
    };
    const file = deadletterPath(env);
    const existing = readRecords(file).filter((r) => notExpired(r, now));
    const next = enforceBounds([...existing, record]);
    writeRecords(file, next);
    return record;
  } catch {
    return null;
  }
}

// Non-expired records, oldest first. Drops expired records as a side effect
// (rewrites the file) so a stale record cannot be retried forever.
export function loadDeadletter(
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DeadletterRecord[] {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const file = deadletterPath(env);
  const all = readRecords(file);
  const live = all.filter((r) => notExpired(r, now));
  if (live.length !== all.length) {
    try {
      writeRecords(file, live);
    } catch {
      // best effort
    }
  }
  return live;
}

// Exponential backoff gate. A fresh record (0 attempts) is due immediately;
// thereafter the next attempt waits base * 2^(attempts-1), capped, measured from
// the last attempt. Keeps a down backend from being hammered on every CLI run.
export function isAttemptDue(rec: DeadletterRecord, now: number): boolean {
  if (rec.attempts <= 0 || !rec.last_attempt_at) return true;
  const last = Date.parse(rec.last_attempt_at);
  if (Number.isNaN(last)) return true;
  const delay = Math.min(
    DEADLETTER_BACKOFF_BASE_MS * 2 ** (rec.attempts - 1),
    DEADLETTER_BACKOFF_CAP_MS,
  );
  return now >= last + delay;
}

export interface FlushResult {
  sent: number;
  dropped: number;
  kept: number;
}

// Replay the deadletter through `upload`. Per record:
//   - expired              -> dropped
//   - not yet due (backoff) -> kept as-is
//   - upload ok            -> dropped (sent)
//   - upload fails         -> attempts++, last_attempt_at=now; at MAX_ATTEMPTS dropped
// Respects the telemetry kill switch (nothing leaves the machine when off) and
// never throws.
export async function flushDeadletter(opts: {
  upload: (rec: DeadletterRecord) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<FlushResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const result: FlushResult = { sent: 0, dropped: 0, kept: 0 };
  if (telemetryDisabled(env)) {
    // Kill switch on: do not forward anything. Leave the local store intact.
    return result;
  }
  const file = deadletterPath(env);
  const all = readRecords(file);
  const survivors: DeadletterRecord[] = [];
  for (const rec of all) {
    if (!notExpired(rec, now)) {
      result.dropped++;
      continue;
    }
    if (!isAttemptDue(rec, now)) {
      survivors.push(rec);
      result.kept++;
      continue;
    }
    try {
      await opts.upload(rec);
      result.sent++;
    } catch {
      const attempts = rec.attempts + 1;
      if (attempts >= DEADLETTER_MAX_ATTEMPTS) {
        result.dropped++;
      } else {
        survivors.push({
          ...rec,
          attempts,
          last_attempt_at: new Date(now).toISOString(),
        });
        result.kept++;
      }
    }
  }
  try {
    writeRecords(file, survivors);
  } catch {
    // best effort
  }
  return result;
}

// ---------------------------------------------------------------------------
// F8 detector: telemetry upload itself failed.
//
// Per INV-SENTRY-NOISE-BUDGET, F8 routes to the LOCAL deadletter + a local
// warning, NOT to Sentry (unless the backend side later observes it). The CLI
// has no PostHog key by design, so an F8 on the user's machine is recorded
// locally; the deadletter IS the store. This is also the self-host posture: on a
// user-owned backend nothing leaves the machine.
// ---------------------------------------------------------------------------

export const FAILURE_TELEMETRY_UPLOAD_FAILED = "telemetry_upload_failed";

export interface UploadFailureCtx {
  traceId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  surface?: string;
  reasonCode?: string;
  status?: number;
}

// Record an F8 failure to the deadletter. Returns the record (for tests/logging)
// or null when the kill switch is on or the write failed. Never throws.
export function recordTelemetryUploadFailure(
  ctx: UploadFailureCtx,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DeadletterRecord | null {
  const env = opts.env ?? process.env;
  if (telemetryDisabled(env)) return null;
  const context: Record<string, unknown> = {};
  if (typeof ctx.status === "number") context.status = ctx.status;
  if (ctx.reasonCode) context.reason_code = ctx.reasonCode;
  const event: Record<string, unknown> = {
    failure_class: FAILURE_TELEMETRY_UPLOAD_FAILED,
    severity: "warning",
    surface: ctx.surface ?? "mla-cli",
    metadata_only_context: context,
  };
  if (ctx.traceId) event.trace_id = ctx.traceId;
  if (ctx.workspaceId) event.workspace_id = ctx.workspaceId;
  if (ctx.sessionId) event.session_id = ctx.sessionId;
  return appendDeadletter(event, opts);
}

// ---------------------------------------------------------------------------
// MCP-evidence-unavailable detector: an MCP evidence tool (retrieve_knowledge /
// query) called intel and the call failed for an intel-side reason (a 402
// billing denial, an auth failure, a 5xx/transport blip). One structured record
// per failure so the dogfood loop's friction is countable instead of vanishing
// into a masked one-line string the agent reads and forgets.
//
// This is a CLI-MCP-LOCAL class (like F8 telemetry_upload_failed): the signal is
// observed entirely on the operator's machine, at the MCP<->intel seam the CLI
// owns, so it has NO intel twin to keep in lockstep. It routes to the LOCAL
// deadletter, never straight to Sentry; a single billing denial is expected
// friction (bind a payer), a recurrence is what an operator should escalate.
//
// The payload is enum/status/id ONLY: the tool name, the discriminated reason
// (the failure category: auth | payment_required | unavailable | error), the
// HTTP status, and the bounded billing sub-reason enum (NO_PAYER). It never
// carries the query text or the raw intel error (INV-POSTHOG-PII-1); the MCP
// boundary already stripped substrate, and sanitizeTelemetry re-checks here.
// ---------------------------------------------------------------------------

export const FAILURE_MCP_EVIDENCE_UNAVAILABLE = "mcp_evidence_unavailable";

export interface McpEvidenceUnavailableCtx {
  traceId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  surface?: string;
  // The MCP tool that failed, e.g. "meetless__retrieve_knowledge". Low-cardinality
  // tool name, allowlisted as `tool`.
  tool?: string;
  // The discriminated failure category from intel_error_mask.js: one of
  // auth | payment_required | unavailable | error. Allowlisted as reason_code.
  reasonCode?: string;
  // The intel HTTP status (402, 503, ...). Numeric only; undefined for a pure
  // transport failure (connection refused mid-restart).
  status?: number;
  // The bounded billing sub-reason enum (e.g. "NO_PAYER") for a 402. Already
  // clamped to a SCREAMING_SNAKE token at the MCP boundary; allowlisted here as
  // billing_reason. Absent for non-billing failures.
  billingReason?: string;
}

// Record an MCP-evidence-unavailable failure to the deadletter. Returns the
// record (for tests/logging) or null when the kill switch is on or the write
// failed. Never throws: recording friction must not itself break the tool call.
export function recordMcpEvidenceUnavailable(
  ctx: McpEvidenceUnavailableCtx,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DeadletterRecord | null {
  const env = opts.env ?? process.env;
  if (telemetryDisabled(env)) return null;
  const context: Record<string, unknown> = {};
  if (ctx.tool) context.tool = ctx.tool;
  if (ctx.reasonCode) context.reason_code = ctx.reasonCode;
  if (typeof ctx.status === "number") context.status = ctx.status;
  if (ctx.billingReason) context.billing_reason = ctx.billingReason;
  const event: Record<string, unknown> = {
    failure_class: FAILURE_MCP_EVIDENCE_UNAVAILABLE,
    severity: "warning",
    surface: ctx.surface ?? "mla-mcp",
    metadata_only_context: context,
  };
  if (ctx.traceId) event.trace_id = ctx.traceId;
  if (ctx.workspaceId) event.workspace_id = ctx.workspaceId;
  if (ctx.sessionId) event.session_id = ctx.sessionId;
  return appendDeadletter(event, opts);
}

// ---------------------------------------------------------------------------
// F5 detector: a KB write the agent attempted was blocked.
//
// The canonical signal is `mla kb add` exiting non-zero because the actor is not
// the workspace owner (the §13.14 owner-only ACL): the agent tried to write a
// lesson down and could not. Like F8 this routes to the LOCAL deadletter and a
// local warning, NOT to Sentry directly (intel SENTRY_ROUTE[F5] = IF_REPEATED;
// a one-off block is expected friction, a recurrence is the alert). The CLI has
// no PostHog key by design, so the deadletter IS the store on the user's machine.
//
// The failure_class string and "warning" severity MUST match the intel twin
// (app/core/failure_telemetry.py: FailureClass.KB_WRITE_BLOCKED = "kb_write_blocked",
// _DEFAULT_SEVERITY[KB_WRITE_BLOCKED] = WARNING); they are the cross-plane key.
// ---------------------------------------------------------------------------

export const FAILURE_KB_WRITE_BLOCKED = "kb_write_blocked";

export interface KbWriteBlockedCtx {
  traceId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  surface?: string;
  // Low-cardinality reason the write was blocked, e.g. "owner_gate" (ACL) or
  // "worker_nonzero_exit" (the add subprocess failed). Allowlisted as reason_code.
  reasonCode?: string;
  // The non-zero exit code / status the blocked write produced. Numeric only.
  status?: number;
}

// Record an F5 (kb-write-blocked) failure to the deadletter. Returns the record
// (for tests/logging) or null when the kill switch is on or the write failed.
// Never throws: detecting a blocked write must not itself break the command.
export function recordKbWriteBlocked(
  ctx: KbWriteBlockedCtx,
  opts: { env?: NodeJS.ProcessEnv; now?: number } = {},
): DeadletterRecord | null {
  const env = opts.env ?? process.env;
  if (telemetryDisabled(env)) return null;
  const context: Record<string, unknown> = {};
  if (typeof ctx.status === "number") context.status = ctx.status;
  if (ctx.reasonCode) context.reason_code = ctx.reasonCode;
  const event: Record<string, unknown> = {
    failure_class: FAILURE_KB_WRITE_BLOCKED,
    severity: "warning",
    surface: ctx.surface ?? "mla-cli",
    metadata_only_context: context,
  };
  if (ctx.traceId) event.trace_id = ctx.traceId;
  if (ctx.workspaceId) event.workspace_id = ctx.workspaceId;
  if (ctx.sessionId) event.session_id = ctx.sessionId;
  return appendDeadletter(event, opts);
}
