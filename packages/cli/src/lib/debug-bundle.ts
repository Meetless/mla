import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { createZip, ZipEntry } from "./zip";
import { langfuseTraceUrl } from "./observability";
import { redact } from "./redactor";

// mla debug bundle core (Phase 5 / gap 6.7). Pure-ish builders kept separate
// from the command's IO so they are unit-testable without a filesystem or a
// backend. The command (commands/debug.ts) does the IO (read local logs,
// best-effort backend fetch, write the zip) and calls buildBundle().
//
// Safe-by-construction guarantees, all enforced here:
//  - Raw payloads (document bodies, prompts, diffs, tool payloads, raw user
//    requests) are NOT in the bundle by default. They enter only behind the
//    includePrompts / includeDiffs opt-ins (the command gates those on a
//    confirmation). redactValue does the stripping and counts every drop.
//  - Redaction is layered, not a single denylist (a key denylist can never be
//    complete). Layer 1: a key denylist drops whole payload categories (diffs,
//    prompts, secrets) by key name. Layer 2: the value-level secret scrubber
//    (lib/redactor.ts) runs on EVERY remaining string value, regardless of key
//    name or include flags, so credentials (sk-..., ghp_..., Bearer ..., env
//    assignments, PEM blocks, high-entropy tokens) never leak through an unknown
//    key or even inside a deliberately-included raw payload. Correlation ids are
//    allowlisted past Layer 2 so the bundle stays joinable.
//  - The redaction report is mandatory and lists which redactors ran + counts.
//  - manifest.json is the first thing in the bundle: read it, know the bundle.
//  - Backend summaries are best-effort: their absence yields a partial bundle
//    with a warning, never a failure (the command never requires backend access).

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Keys whose values are source diffs / patches. Gated by includeDiffs.
const DIFF_KEYS = new Set(["diff", "diffs", "patch", "patches", "source_diff", "sourcediff"]);

// Keys whose values are prompts, retrieved document bodies, LLM output, tool
// payloads, or raw user requests. Gated by includePrompts. (Two opt-in flags
// cover the gated payload categories: --include-diffs for diffs, --include-prompts
// for the rest, matching the spec's flag surface in gap 6.7.)
const PROMPT_KEYS = new Set([
  // prompts
  "prompt",
  "prompts",
  "system_prompt",
  "systemprompt",
  "messages",
  // retrieved document bodies / evidence
  "evidence",
  "document",
  "documents",
  "body",
  "bodies",
  "content",
  "text",
  "chunk",
  "chunks",
  "passage",
  "passages",
  "snippet",
  "snippets",
  // LLM output / generated content (model responses are raw payloads too: the
  // denylist must name them or they leak through under an unlisted key)
  "completion",
  "completions",
  "llm_response",
  "llmresponse",
  "llm_output",
  "llmoutput",
  "model_output",
  "modeloutput",
  "response",
  "responses",
  "output",
  "outputs",
  "answer",
  "answers",
  "generation",
  "generations",
  "retrieved_text",
  "retrievedtext",
  "retrieval",
  "retrievals",
  "reasoning",
  // tool payloads
  "tool_payload",
  "toolpayload",
  "tool_input",
  "tool_output",
  "payload",
  // raw user requests
  "raw_request",
  "rawrequest",
  "request_body",
  "requestbody",
  "query",
  "question",
  "user_input",
  "userinput",
]);

// Keys whose values are credentials. ALWAYS redacted, never re-exposed by the
// include flags: --include-prompts is for content, never for secrets. The
// value-level scrubber (Layer 2) is the pattern-based backstop for credentials
// under any other key; this set is the belt-and-suspenders for credential keys
// whose value may not match a known token pattern (short/custom tokens).
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "api_secret",
  "apisecret",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "id_token",
  "idtoken",
  "session_token",
  "sessiontoken",
  "secret",
  "client_secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "auth_header",
  "authheader",
  "cookie",
  "set_cookie",
  "setcookie",
  "credentials",
  "credential",
  "private_key",
  "privatekey",
]);

// Correlation / id fields are pointers, not secrets (OBS-9: ids and URLs only).
// The Layer 2 high-entropy heuristic would otherwise flag hex/uuid ids and nuke
// exactly the join keys an operator needs the bundle for. These keys bypass
// Layer 2; they are never a payload category, so the denylist (Layer 1) is
// unaffected and a credential never hides here (those keys are in SECRET_KEYS).
const ID_PASSTHROUGH_KEYS = new Set([
  "id",
  "trace_id",
  "traceid",
  "langfuse_trace_id",
  "langfusetraceid",
  "run_id",
  "runid",
  "session_id",
  "sessionid",
  "span_id",
  "spanid",
  "parent_span_id",
  "parentspanid",
  "request_id",
  "requestid",
  "correlation_id",
  "correlationid",
  "workspace_id",
  "workspaceid",
  "tenant_id",
  "tenantid",
  "event_id",
  "eventid",
  "user_id",
  "userid",
  "diff_id",
  "diffid",
]);

export type RedactionCategory = "diffs" | "prompts" | "secrets";

export interface RedactionOptions {
  includePrompts: boolean;
  includeDiffs: boolean;
}

export interface RedactionCounts {
  diffs: number;
  prompts: number;
  // Credential redactions: Layer 1 secret-key drops PLUS Layer 2 value-scrubber
  // hits (any string whose credential pattern the scrubber stripped).
  secrets: number;
}

function categoryFor(key: string): RedactionCategory | null {
  const k = key.toLowerCase();
  if (SECRET_KEYS.has(k)) return "secrets";
  if (DIFF_KEYS.has(k)) return "diffs";
  if (PROMPT_KEYS.has(k)) return "prompts";
  return null;
}

function shouldRedact(category: RedactionCategory, opts: RedactionOptions): boolean {
  if (category === "secrets") return true; // never re-exposed by include flags
  if (category === "diffs") return !opts.includeDiffs;
  return !opts.includePrompts;
}

// Recursively redact an arbitrary JSON value with two layers. Layer 1: drop
// payload-bearing keys by category (replaced with a marker, key kept so the
// structure stays inspectable, counted). Layer 2: run the value-level secret
// scrubber on every remaining string value so credentials never leak through an
// unlisted key or a deliberately-included raw payload. Correlation ids are
// allowlisted past Layer 2 so the bundle stays joinable.
export function redactValue(
  value: unknown,
  opts: RedactionOptions,
  counts: RedactionCounts,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, opts, counts));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const category = categoryFor(k);
      if (category && shouldRedact(category, opts)) {
        out[k] = `[REDACTED:${category}]`;
        counts[category] += 1;
        continue;
      }
      // Layer 2 bypass: keep correlation ids readable (pointers, not secrets).
      if (typeof v === "string" && ID_PASSTHROUGH_KEYS.has(k.toLowerCase())) {
        out[k] = v;
        continue;
      }
      out[k] = redactValue(v, opts, counts);
    }
    return out;
  }
  // Layer 2: scalar string backstop. Scrub credential patterns from every
  // string value regardless of key or include flags. A non-id string that the
  // scrubber changed contained a secret => count it.
  if (typeof value === "string") {
    return scrubSecret(value, counts);
  }
  return value;
}

// Apply the value-level secret scrubber, counting a hit when it changes the
// string. redact() returns its input unchanged for null/undefined/""; a string
// in always returns a string out, so the `?? value` is a pure type-narrowing
// guard, never a runtime branch for real input.
function scrubSecret(value: string, counts: RedactionCounts): string {
  const scrubbed = redact(value);
  if (scrubbed !== value) counts.secrets += 1;
  return scrubbed ?? value;
}

// ---------------------------------------------------------------------------
// Local log collection (best-effort, trace-scoped)
// ---------------------------------------------------------------------------

export interface CollectedLog {
  // Bundle-relative path under logs/ (e.g. "logs/kb-knowledge.jsonl").
  name: string;
  // Redacted, trace-id-matching lines joined by "\n".
  data: string;
  lineCount: number;
}

// Scan logsDir recursively for *.jsonl / *.log files, keep only lines that
// mention the trace_id, redact each (JSON lines parsed + two-layer redacted;
// plaintext lines get the value-level secret scrubber), and return the
// trace-scoped slice per file. The scoped trace_id itself is preserved in every
// line so the bundle stays greppable by trace_id. Missing dir => empty (offline
// / fresh box is normal, never an error).
export function collectLocalLogs(
  logsDir: string,
  traceId: string,
  opts: RedactionOptions,
  counts: RedactionCounts,
): CollectedLog[] {
  const out: CollectedLog[] = [];
  let files: string[] = [];
  try {
    files = walkLogFiles(logsDir);
  } catch {
    return out;
  }
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const matched: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.includes(traceId)) continue;
      matched.push(redactLogLine(line, traceId, opts, counts));
    }
    if (matched.length === 0) continue;
    const rel = path.relative(logsDir, file).split(path.sep).join("/");
    out.push({
      name: `logs/${rel}`,
      data: matched.join("\n") + "\n",
      lineCount: matched.length,
    });
  }
  return out;
}

function walkLogFiles(dir: string): string[] {
  const result: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      result.push(...walkLogFiles(full));
    } else if (ent.isFile() && (ent.name.endsWith(".jsonl") || ent.name.endsWith(".log"))) {
      result.push(full);
    }
  }
  return result;
}

function redactLogLine(
  line: string,
  traceId: string,
  opts: RedactionOptions,
  counts: RedactionCounts,
): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    // Non-JSON line: no structure to category-redact, but it can still carry a
    // credential in plaintext (e.g. "Authorization: Bearer ghp_..."). Run the
    // value-level scrubber so secrets never pass through verbatim.
    return scrubPlaintext(line, traceId, counts);
  }
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(redactValue(parsed, opts, counts));
  } catch {
    // Looked like JSON but did not parse: scrub it as plaintext rather than
    // keep it verbatim (a half-written log line can still hold a secret).
    return scrubPlaintext(line, traceId, counts);
  }
}

// Scrub a plaintext line while preserving the scoped trace_id. The value
// scrubber's high-entropy heuristic would otherwise redact a real hex trace_id
// (a 32-hex correlation pointer reads as a generic token), erasing the join key
// the bundle exists to expose. There is no JSON key to allowlist on here, so we
// mask the trace_id with a control-char sentinel (never matches a token pattern,
// never appears in real logs), scrub, then restore it.
function scrubPlaintext(line: string, traceId: string, counts: RedactionCounts): string {
  const SENTINEL = "\x00\x00MLA_TRACE_ID\x00\x00";
  const masked = traceId ? line.split(traceId).join(SENTINEL) : line;
  const scrubbed = scrubSecret(masked, counts);
  return traceId ? scrubbed.split(SENTINEL).join(traceId) : scrubbed;
}

// ---------------------------------------------------------------------------
// Manifest / redaction report / README
// ---------------------------------------------------------------------------

export interface BundleInputs {
  traceId: string;
  createdAt: string; // ISO 8601, supplied by the command (no clock in core)
  mlaVersion: string;
  releaseSha: string;
  workspaceId: string | null;
  command: string; // the command being debugged, "unknown" if not derivable
  runId: string | null;
  sessionId: string | null;
  telemetryEnabled: boolean;
  langfuseProjectId: string | null;
  sentryUrl: string | null;
  opts: RedactionOptions;
  localLogs: CollectedLog[];
  // Best-effort backend summary (already redacted) or null when unavailable.
  backendSummary: unknown | null;
  // Non-fatal warnings accumulated while collecting (e.g. backend unreachable).
  warnings: string[];
  // Redaction counts accumulated by collection so far (logs + backend).
  redactionCounts: RedactionCounts;
}

// Hash the workspace id so a shared bundle never leaks the raw tenant id. The
// raw id is a pointer, not a secret, but a bundle is meant to be attached to a
// public issue, so the conservative default is a hash.
export function hashWorkspaceId(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return "sha256:" + crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}

// Deep links / search hints for this trace. Concrete URLs are emitted when the
// inputs carry the pieces to build them (Langfuse needs a project id, Sentry a
// dashboard URL), both of which depend on backend/workspace config that may be
// absent offline. The trace-id search hints are ALWAYS emitted: they need
// nothing but the id, so the bundle stays useful even fully offline (spec 6.7:
// "known deep-links ... are always included").
export function deepLinks(inputs: BundleInputs): string[] {
  const links: string[] = [];
  if (inputs.langfuseProjectId) {
    links.push(`langfuse: ${langfuseTraceUrl(inputs.langfuseProjectId, inputs.traceId)}`);
  }
  if (inputs.sentryUrl) {
    links.push(`sentry: ${inputs.sentryUrl}`);
  }
  links.push(`search Langfuse for trace_id: ${inputs.traceId}`);
  links.push(`search Sentry for the tag trace_id == ${inputs.traceId}`);
  links.push(`grep your CLI logs for: ${inputs.traceId}`);
  return links;
}

export function buildManifest(inputs: BundleInputs, fileList: string[]): Record<string, unknown> {
  return {
    trace_id: inputs.traceId,
    created_at: inputs.createdAt,
    mla_version: inputs.mlaVersion,
    release_sha: inputs.releaseSha,
    workspace_id_hash: hashWorkspaceId(inputs.workspaceId),
    command: inputs.command,
    run_id: inputs.runId,
    session_id: inputs.sessionId,
    telemetry_enabled: inputs.telemetryEnabled,
    files: fileList,
    redaction: {
      raw_payloads_included: {
        prompts: inputs.opts.includePrompts,
        diffs: inputs.opts.includeDiffs,
      },
      redacted_counts: inputs.redactionCounts,
    },
    backend_summary_present: inputs.backendSummary !== null,
    warnings: inputs.warnings,
  };
}

export function buildRedactionReport(inputs: BundleInputs): Record<string, unknown> {
  const ranDiffs = !inputs.opts.includeDiffs;
  const ranPrompts = !inputs.opts.includePrompts;
  return {
    redactors_run: [
      ranDiffs ? "diffs" : null,
      ranPrompts ? "prompts (document bodies, prompts, LLM output, tool payloads, raw requests)" : null,
      "secrets (credentials, tokens, API keys, env assignments, PEM blocks; ALWAYS on, even with include flags)",
    ].filter(Boolean),
    redacted_counts: inputs.redactionCounts,
    raw_payloads_included: {
      prompts: inputs.opts.includePrompts,
      diffs: inputs.opts.includeDiffs,
      // secrets are never included; there is no flag to re-expose them.
      secrets: false,
    },
    warnings: inputs.warnings,
    note:
      "Redaction is layered. Layer 1 (key denylist) replaces payload-bearing " +
      "values with [REDACTED:<category>] and keeps the surrounding structure. " +
      "Layer 2 (value-level secret scrubber) runs on every remaining string and " +
      "strips credential patterns regardless of key name or include flags. A " +
      "non-zero count means content was removed before this bundle was written. " +
      "Silent redaction is avoided on purpose: review this report before sharing " +
      "the bundle. The include flags re-expose content categories only; secrets " +
      "are never re-exposed.",
  };
}

export function buildReadme(inputs: BundleInputs): string {
  const lines = [
    "mla debug bundle",
    "================",
    "",
    `trace_id: ${inputs.traceId}`,
    `created:  ${inputs.createdAt}`,
    "",
    "SHARE BOUNDARY",
    "--------------",
    "This bundle was generated locally by `mla debug bundle`. Nothing was",
    "uploaded. You are in control of where it goes.",
    "",
    "Before attaching it to a GitHub issue or support ticket:",
    "  1. Read manifest.json (it summarizes everything inside).",
    "  2. Read redaction-report.json (it states what was stripped).",
    "  3. Confirm you are comfortable sharing what remains.",
    "",
    "By default, raw payloads (document bodies, prompts, source diffs, tool",
    "payloads, and raw user requests) are NOT included. They are present only if",
    "you passed --include-prompts and/or --include-diffs.",
    "",
    `raw prompts included: ${inputs.opts.includePrompts}`,
    `raw diffs included:   ${inputs.opts.includeDiffs}`,
    "",
    "CONTENTS",
    "--------",
    "  manifest.json          machine-readable summary (read this first)",
    "  redaction-report.json  what was redacted and which redactors ran",
    "  deep-links.txt         Langfuse / Sentry links for this trace_id",
  ];
  // Only list files that are actually in this bundle (logs and the backend
  // summary are both best-effort; an offline / fresh box has neither).
  if (inputs.localLogs.length > 0) {
    lines.push("  logs/                  trace-scoped, redacted local CLI log lines");
  }
  if (inputs.backendSummary !== null) {
    lines.push("  backend-summary.json   best-effort control/intel summary");
  }
  lines.push("");
  if (inputs.warnings.length > 0) {
    lines.push("WARNINGS", "--------");
    for (const w of inputs.warnings) lines.push(`  - ${w}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------

export interface BuiltBundle {
  zip: Buffer;
  fileList: string[];
  manifest: Record<string, unknown>;
}

// Assemble the full bundle as an in-memory zip. Deterministic given its inputs
// (no clock, no IO): createdAt and all collection results are passed in.
export function buildBundle(inputs: BundleInputs): BuiltBundle {
  const entries: ZipEntry[] = [];

  // deep links (always non-empty: deepLinks always emits the trace-id search
  // hints, even fully offline).
  const links = deepLinks(inputs);
  entries.push({
    name: "deep-links.txt",
    data: Buffer.from(links.join("\n") + "\n", "utf8"),
  });

  // local logs (trace-scoped, redacted)
  for (const log of inputs.localLogs) {
    entries.push({ name: log.name, data: Buffer.from(log.data, "utf8") });
  }

  // backend summary (best-effort)
  if (inputs.backendSummary !== null) {
    entries.push({
      name: "backend-summary.json",
      data: Buffer.from(JSON.stringify(inputs.backendSummary, null, 2) + "\n", "utf8"),
    });
  }

  // redaction report (mandatory)
  entries.push({
    name: "redaction-report.json",
    data: Buffer.from(JSON.stringify(buildRedactionReport(inputs), null, 2) + "\n", "utf8"),
  });

  // README (share boundary)
  entries.push({ name: "README.txt", data: Buffer.from(buildReadme(inputs), "utf8") });

  // file list excludes the manifest itself (the manifest describes the rest).
  const fileList = entries.map((e) => e.name).sort();

  // manifest (first, but built last so it can list the files)
  const manifest = buildManifest(inputs, fileList);
  entries.unshift({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
  });

  return { zip: createZip(entries), fileList, manifest };
}
