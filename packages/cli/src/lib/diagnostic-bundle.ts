// The safe diagnostic bundle for `mla bug report` (notes/20260705-mla-bug-report-
// command-proposal.md §3.2, "the heart of the design"). This is Phase 0: the
// highest-risk piece, built and verified BEFORE the upload path, because the
// upload system must not be built on an unsafe collector.
//
// The contract is ALLOWLIST-FIRST, not denylist-scrubbed. Unlike lib/debug-bundle.ts
// (which reads raw logs and scrubs them with a key denylist + value scrubber),
// this exporter NEVER opens a file that can carry injected content:
//   - it reads events.jsonl (a STRUCTURED analytics envelope with a known field
//     set) and telemetry-deadletter.jsonl (already sanitizeTelemetry-scrubbed),
//   - field-projects each source record into a fixed, enum-constrained shape,
//   - and emits ONLY allowlisted fields. Unknown enum values become OTHER; any
//     value that is not a known-safe scalar is dropped.
// It never touches logs/*.jsonl (ask-traces, mcp-calls), ce0/evidence.db, the
// queue, or the Claude Code transcript. There is no --include-raw path in v1.
//
// The secret scanner (redactor.ts scanForCredentials) runs AFTER the allowlist as
// Layer-2 defense-in-depth, never as the primary boundary. Because the allowlist
// already excludes free-form content, a Layer-2 hit means something leaked into a
// field we believed structured -- it is redacted and counted, and its presence is
// a bug signal, not the design working as intended.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createZip, ZipEntry } from "./zip";
import { hashWorkspaceId } from "./debug-bundle";
import { scanForCredentials, REDACTED, SECRET_SCANNER_VERSION } from "./redactor";
import { DeadletterRecord } from "./failure-telemetry";
import {
  EVENT_TYPES,
  COMMAND_OUTCOMES,
  COMMAND_SCOPES,
  TOUCHED_SURFACES,
} from "./analytics/envelope";

// Bump when the bundle file set or projection shape changes so a reader can tell
// which contract produced a bundle.
export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;

// --- fixed enums for the projected fields (rule 10: enum-constrain) ----------
// The analytics envelope's own closed tuples are the source of truth where one
// exists. Values outside the set become OTHER; they never pass through raw.

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);
const OUTCOME_SET = new Set<string>(COMMAND_OUTCOMES);
const SCOPE_SET = new Set<string>(COMMAND_SCOPES);
const TOUCHED_SURFACE_SET = new Set<string>(TOUCHED_SURFACES);

// The deadletter failure classes MLA emits (failure-telemetry.ts twins). A class
// outside this set is coerced to OTHER so a future detector cannot leak an
// unreviewed string.
const FAILURE_CLASS_SET = new Set<string>(["telemetry_upload_failed", "kb_write_blocked"]);
const SEVERITY_SET = new Set<string>(["debug", "info", "warning", "error", "critical"]);

// os.platform() / os.arch() closed sets. Anything else becomes OTHER.
const OS_PLATFORM_SET = new Set<string>([
  "darwin",
  "linux",
  "win32",
  "aix",
  "freebsd",
  "openbsd",
  "sunos",
  "android",
]);
const OS_ARCH_SET = new Set<string>([
  "arm64",
  "x64",
  "ia32",
  "arm",
  "ppc64",
  "s390x",
  "riscv64",
  "loong64",
]);

// A conservative SHAPE allowlist for the low-cardinality, MLA-authored tokens
// that have no closed enum in the type layer: the command verb, the subcommand,
// a tool name, an error class. A token of this shape cannot carry a file path
// (no `/`), a query (no spaces), a URL, an email, or a quote -- so it satisfies
// rule 10's security intent (no arbitrary string escapes) without hardcoding a
// list that would rot. Anything failing the shape becomes OTHER.
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/;

export interface CoercionCounts {
  // enum values outside their fixed set, coerced to OTHER.
  enumValuesCoercedToOther: number;
  // top-level source keys not in the projection allowlist, dropped.
  fieldsDroppedByAllowlist: number;
  // Layer-2 scanForCredentials hits: a value we believed structured that
  // matched a known credential pattern and was redacted. Should be 0 by design.
  knownPatternMatchesRemoved: number;
}

function newCounts(): CoercionCounts {
  return {
    enumValuesCoercedToOther: 0,
    fieldsDroppedByAllowlist: 0,
    knownPatternMatchesRemoved: 0,
  };
}

function coerceEnum(value: unknown, allowed: Set<string>, counts: CoercionCounts): string {
  if (typeof value === "string" && allowed.has(value)) return value;
  counts.enumValuesCoercedToOther += 1;
  return "OTHER";
}

// A closed-set enum that is allowed to be absent (null) rather than OTHER.
function coerceEnumOrNull(
  value: unknown,
  allowed: Set<string>,
  counts: CoercionCounts,
): string | null {
  if (value === null || value === undefined) return null;
  return coerceEnum(value, allowed, counts);
}

// A shape-constrained token: keep if it matches the safe shape, else OTHER.
// Null/absent stays null (the field simply was not present on the source).
function coerceToken(value: unknown, counts: CoercionCounts): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && SAFE_TOKEN_RE.test(value)) return value;
  counts.enumValuesCoercedToOther += 1;
  return "OTHER";
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// A version-ish string (e.g. "1.4.2", "v20.11.0", "abc1234", "dev"). Kept only
// when it is a short token of a safe shape; otherwise dropped to null. Version
// and git-sha strings are MLA-authored build metadata, never user content.
function coerceVersion(value: unknown): string | null {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value)) return value;
  return null;
}

// Layer-2 backstop. Runs the credential scanner on a projected scalar string.
// A clean value passes through unchanged; a value that matches a known
// credential pattern is replaced with [REDACTED] and counted (it should never
// happen given the allowlist, so a non-zero count is a signal to investigate).
function scrubScalar(value: string | null, counts: CoercionCounts): string | null {
  if (value === null) return null;
  if (scanForCredentials(value).length > 0) {
    counts.knownPatternMatchesRemoved += 1;
    return REDACTED;
  }
  return value;
}

// The projected trace-event record. Every field is an id, a fixed enum, a
// number, a boolean, or a shape-constrained token. No args, paths, queries,
// prompts, or response bodies -- those never exist on the source event.
export interface ProjectedTraceEvent {
  ts: string | null;
  eventType: string;
  command: string | null;
  subcommand: string | null;
  scope: string | null;
  outcome: string | null;
  errorClass: string | null;
  retryable: boolean | null;
  exitCode: number | null;
  durationMs: number | null;
  touchedSurface: string | null;
  commandIndexInSession: number | null;
  mlaVersion: string | null;
  gitSha: string | null;
  runId: string | null;
  sessionId: string | null;
  traceId: string | null;
}

// The set of source keys the trace-event projection consumes. Any other top-level
// key on the source event is intentionally dropped (counted in
// fieldsDroppedByAllowlist) so a newly-added, unreviewed field fails closed.
const TRACE_EVENT_CONSUMED_KEYS = new Set<string>([
  "created_at",
  "event_type",
  "command",
  "subcommand",
  "scope",
  "outcome",
  "error_class",
  "retryable",
  "exit_code",
  "duration_ms",
  "touched_surface",
  "command_index_in_session",
  "mla_version",
  "git_sha",
  "run_id",
  "session_id",
  "trace_id",
]);

function projectTraceEvent(
  ev: Record<string, unknown>,
  counts: CoercionCounts,
): ProjectedTraceEvent {
  for (const key of Object.keys(ev)) {
    if (!TRACE_EVENT_CONSUMED_KEYS.has(key)) counts.fieldsDroppedByAllowlist += 1;
  }
  return {
    ts: typeof ev.created_at === "string" ? ev.created_at : null,
    eventType: coerceEnum(ev.event_type, EVENT_TYPE_SET, counts),
    command: scrubScalar(coerceToken(ev.command, counts), counts),
    subcommand: scrubScalar(coerceToken(ev.subcommand, counts), counts),
    scope: coerceEnumOrNull(ev.scope, SCOPE_SET, counts),
    outcome: coerceEnumOrNull(ev.outcome, OUTCOME_SET, counts),
    errorClass: scrubScalar(coerceToken(ev.error_class, counts), counts),
    retryable: safeBool(ev.retryable),
    exitCode: safeNumber(ev.exit_code),
    durationMs: safeNumber(ev.duration_ms),
    touchedSurface: coerceEnumOrNull(ev.touched_surface, TOUCHED_SURFACE_SET, counts),
    commandIndexInSession: safeNumber(ev.command_index_in_session),
    mlaVersion: coerceVersion(ev.mla_version),
    gitSha: coerceVersion(ev.git_sha),
    runId: coerceToken(ev.run_id, counts),
    sessionId: coerceToken(ev.session_id, counts),
    traceId: coerceToken(ev.trace_id, counts),
  };
}

// The projected error record. Built from two structured sources:
//   - failing mla_command events (outcome != success), and
//   - telemetry-deadletter records (failure-telemetry.ts).
// Per rules 8-9 there is NO free-form error.message and NO raw stack: the
// sources carry none. errorFingerprint is a stable hash over the safe class
// tokens so downstream can group; mlaOwnedFrames is always [] (no stack source
// exists in v1).
export interface ProjectedErrorRecord {
  ts: string | null;
  source: "command" | "deadletter";
  errorClass: string | null;
  failureClass: string | null;
  severity: string | null;
  outcome: string | null;
  reasonCode: string | null;
  status: number | null;
  errorFingerprint: string;
  mlaOwnedFrames: string[];
  traceId: string | null;
  sessionId: string | null;
}

function fingerprint(...parts: (string | null)[]): string {
  const seed = parts.map((p) => p ?? "").join("|");
  return "fp_" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function projectCommandError(
  ev: Record<string, unknown>,
  counts: CoercionCounts,
): ProjectedErrorRecord {
  const errorClass = scrubScalar(coerceToken(ev.error_class, counts), counts);
  const outcome = coerceEnumOrNull(ev.outcome, OUTCOME_SET, counts);
  const command = coerceToken(ev.command, counts);
  return {
    ts: typeof ev.created_at === "string" ? ev.created_at : null,
    source: "command",
    errorClass,
    failureClass: null,
    severity: null,
    outcome,
    reasonCode: null,
    status: null,
    errorFingerprint: fingerprint(command, errorClass, outcome),
    mlaOwnedFrames: [],
    traceId: coerceToken(ev.trace_id, counts),
    sessionId: coerceToken(ev.session_id, counts),
  };
}

function projectDeadletterError(
  rec: DeadletterRecord,
  counts: CoercionCounts,
): ProjectedErrorRecord {
  const event = (rec.event ?? {}) as Record<string, unknown>;
  const container = (event.metadata_only_context ?? event.context ?? {}) as Record<string, unknown>;
  const failureClass = coerceEnum(rec.failure_class ?? event.failure_class, FAILURE_CLASS_SET, counts);
  const severity = coerceEnumOrNull(event.severity, SEVERITY_SET, counts);
  const reasonCode = scrubScalar(coerceToken(container.reason_code, counts), counts);
  return {
    ts: typeof rec.created_at === "string" ? rec.created_at : null,
    source: "deadletter",
    errorClass: null,
    failureClass,
    severity,
    outcome: null,
    reasonCode,
    status: safeNumber(container.status),
    errorFingerprint: fingerprint(failureClass, severity, reasonCode),
    mlaOwnedFrames: [],
    traceId: coerceToken(event.trace_id, counts),
    sessionId: coerceToken(event.session_id, counts),
  };
}

// --- lenient source readers --------------------------------------------------
// Read the two structured on-disk sources from the given home dir. Both are
// jsonl; a malformed line is skipped, never fatal (a fresh box has neither file,
// which is normal). We read the files DIRECTLY (not via readEvents/loadDeadletter)
// so the exporter is testable against a temp home and does not mutate the store.

function readJsonlObjects(file: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // torn / corrupt line -- skip.
    }
  }
  return out;
}

// --- selection ---------------------------------------------------------------

export interface DiagnosticSelector {
  traceId: string | null;
  sessionId: string | null;
}

// An event/record is in scope when it matches every provided (non-null) selector.
// With only a trace id -> that trace. With only a session id -> that session.
// With both -> that trace within that session. The command guarantees at least
// one selector is non-null.
function matchesSelector(
  sel: DiagnosticSelector,
  traceId: unknown,
  sessionId: unknown,
): boolean {
  if (sel.traceId !== null && traceId !== sel.traceId) return false;
  if (sel.sessionId !== null && sessionId !== sel.sessionId) return false;
  return true;
}

function deadletterExpired(rec: DeadletterRecord, now: number): boolean {
  const exp = Date.parse(rec.expires_at);
  return Number.isNaN(exp) ? false : now >= exp;
}

// --- build -------------------------------------------------------------------

export interface DiagnosticBundleInputs {
  // The .meetless home to read from (redirectable in tests).
  home: string;
  selector: DiagnosticSelector;
  // Supplied by the command (no clock/uuid/version lookups in the pure core).
  createdAt: string; // ISO 8601
  bundleId: string; // uuid
  mlaVersion: string;
  now: number; // ms, for the deadletter TTL filter
}

export interface EnvironmentInfo {
  mlaVersion: string;
  platform: string; // enum, OTHER if unknown
  arch: string; // enum, OTHER if unknown
  nodeVersion: string | null;
}

export interface BuiltDiagnosticBundle {
  zip: Buffer;
  manifest: Record<string, unknown>;
  redactionReport: Record<string, unknown>;
  environment: EnvironmentInfo;
  traceEventCount: number;
  errorCount: number;
  fileList: string[];
  counts: CoercionCounts;
}

// Fixed environment fields (rule 5): mla version, OS platform enum, arch, node
// version. NO hostname, NO username, NO raw uname. Enum-constrained.
function buildEnvironment(mlaVersion: string, counts: CoercionCounts): EnvironmentInfo {
  return {
    mlaVersion: coerceVersion(mlaVersion) ?? "OTHER",
    platform: coerceEnum(os.platform(), OS_PLATFORM_SET, counts),
    arch: coerceEnum(os.arch(), OS_ARCH_SET, counts),
    nodeVersion: coerceVersion(process.version),
  };
}

// Assemble the safe diagnostic bundle as an in-memory zip. Pure given its inputs
// plus the two source files under `home` and the ambient os/process facts; no
// network, no clock (createdAt/now are passed in), no mutation of the store.
export function buildDiagnosticBundle(inputs: DiagnosticBundleInputs): BuiltDiagnosticBundle {
  const counts = newCounts();

  // 1. Read + filter the two structured sources (rule 1: filter by selection).
  const rawEvents = readJsonlObjects(path.join(inputs.home, "events.jsonl")).filter((ev) =>
    matchesSelector(inputs.selector, ev.trace_id, ev.session_id),
  );

  const rawDeadletter = readJsonlObjects(path.join(inputs.home, "telemetry-deadletter.jsonl"))
    .map((o) => o as unknown as DeadletterRecord)
    .filter((rec) => !deadletterExpired(rec, inputs.now))
    .filter((rec) => {
      const event = (rec.event ?? {}) as Record<string, unknown>;
      return matchesSelector(inputs.selector, event.trace_id, event.session_id);
    });

  // 2. Project each into its enum-constrained shape (rules 2, 8, 9, 10).
  const traceEvents = rawEvents.map((ev) => projectTraceEvent(ev, counts));

  const errors: ProjectedErrorRecord[] = [];
  for (const ev of rawEvents) {
    const outcome = typeof ev.outcome === "string" ? ev.outcome : null;
    if (outcome && outcome !== "success" && outcome !== "noop") {
      errors.push(projectCommandError(ev, counts));
    }
  }
  for (const rec of rawDeadletter) {
    errors.push(projectDeadletterError(rec, counts));
  }

  // 3. Environment (fixed field set) + workspace hash (first non-null seen).
  const environment = buildEnvironment(inputs.mlaVersion, counts);
  const rawWorkspaceId =
    (rawEvents.find((ev) => typeof ev.workspace_id === "string")?.workspace_id as string | undefined) ??
    null;
  const workspaceIdHash = hashWorkspaceId(rawWorkspaceId);

  // 4. Serialize the jsonl files.
  const traceEventsJsonl =
    traceEvents.map((r) => JSON.stringify(r)).join("\n") + (traceEvents.length ? "\n" : "");
  const errorsJsonl = errors.map((r) => JSON.stringify(r)).join("\n") + (errors.length ? "\n" : "");

  // 5. redaction-report.json (rule 6: "known-pattern matches removed").
  const redactionReport = {
    scanner: {
      name: "scanForCredentials",
      pattern_set_version: SECRET_SCANNER_VERSION,
      // The credential scanner runs as Layer 2 only; it EXCLUDES the entropy
      // heuristic so it does not nuke join keys (trace/session ids).
      entropy_heuristic: false,
    },
    counts: {
      known_pattern_matches_removed: counts.knownPatternMatchesRemoved,
      fields_dropped_by_allowlist: counts.fieldsDroppedByAllowlist,
      enum_values_coerced_to_other: counts.enumValuesCoercedToOther,
    },
    note:
      "This bundle is allowlist-first: only a fixed set of structured fields is " +
      "emitted, each enum-constrained. The counts above describe known-pattern " +
      "matches removed and fields dropped by the allowlist; they are NOT a " +
      "guarantee that no secret exists. A non-zero known_pattern_matches_removed " +
      "means a value we believed structured matched a credential pattern and was " +
      "replaced with [REDACTED]. No raw logs, database, or transcript were read.",
  };

  // 6. manifest.json (first entry; describes the rest).
  const files = [
    "environment.json",
    "trace-events.jsonl",
    "errors.jsonl",
    "redaction-report.json",
  ];
  const manifest = {
    schema_version: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    bundle_id: inputs.bundleId,
    created_at: inputs.createdAt,
    trace_id: inputs.selector.traceId,
    session_id: inputs.selector.sessionId,
    mla_version: environment.mlaVersion,
    workspace_id_hash: workspaceIdHash,
    trace_event_count: traceEvents.length,
    error_count: errors.length,
    redaction_report: "redaction-report.json",
    files,
  };

  // 7. Assemble the zip. manifest first.
  const entries: ZipEntry[] = [
    { name: "manifest.json", data: jsonBuf(manifest) },
    { name: "environment.json", data: jsonBuf(environment) },
    { name: "trace-events.jsonl", data: Buffer.from(traceEventsJsonl, "utf8") },
    { name: "errors.jsonl", data: Buffer.from(errorsJsonl, "utf8") },
    { name: "redaction-report.json", data: jsonBuf(redactionReport) },
  ];

  return {
    zip: createZip(entries),
    manifest,
    redactionReport,
    environment,
    traceEventCount: traceEvents.length,
    errorCount: errors.length,
    fileList: files,
    counts,
  };
}

function jsonBuf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}
