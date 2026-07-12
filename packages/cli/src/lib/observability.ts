// mla observability spine: trace_id + Sentry helpers + build-info loader.
//
// See notes/20260530-mla-observability-diagnostic-spine.md for the full design.
// One trace_id per mla run; same string used as Sentry tag, X-Trace-ID header,
// and Langfuse trace id once intel propagates it.
//
// Canonical format is 32 hex chars (16 random bytes hex-encoded). This is OTel-
// native and matches intel's existing RequestContext.langfuse_trace_id format.
// Spec (§4) names UUIDv4, but every Langfuse SDK and intel itself wants 32-hex
// without dashes; zero translation across planes is the prize.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import * as Sentry from "@sentry/node";
import type { FlushFn, FlushPayload, Tracer, TracerOptions } from "@meetless/trace-core";
import { redact, REDACTED } from "./redactor";
import { telemetryDisabled } from "./config";
import { recordTelemetryUploadFailure } from "./failure-telemetry";

// @meetless/trace-core is bundled to CJS at build time (scripts/bundle-esm.js ->
// dist/bundles/trace-core.js) so the published @meetless/mla package and the pkg
// binary carry the tracer with ZERO `workspace:*` runtime deps (trace-core is
// private, not on the npm registry). observability.ts loads only these two
// factories at runtime; every other trace-core import here is a type, erased at
// compile. Prefer the bundle (require() works in the pkg snapshot and in an npm
// install); fall back to the workspace package for dev (ts-node, no dist/bundles).
// Only fall through on module-not-found, so a real load error in the bundle
// surfaces instead of being masked. dist/lib/observability.js -> dist/bundles.
interface TraceCoreModule {
  makeTracer: (opts: TracerOptions) => Tracer;
  makeNoopTracer: (opts: { traceId: string }) => Tracer;
}

function loadTraceCore(): TraceCoreModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.resolve(__dirname, "..", "bundles", "trace-core.js")) as TraceCoreModule;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@meetless/trace-core") as TraceCoreModule;
  }
}

const { makeNoopTracer, makeTracer } = loadTraceCore();

export interface BuildInfo {
  version: string;
  sha: string;
  branch: string;
  dirty: boolean;
  builtAt: string;
  sentryDsn?: string;
  // Ed25519 public key (SPKI PEM, or base64-of-PEM) used to verify the signed
  // release manifest the self-upgrade path reads. Public-by-design and baked at
  // build time from MLA_UPDATE_PUBLIC_KEY, the same pattern as sentryDsn. Empty
  // on dev builds, which then honor the MLA_UPDATE_PUBLIC_KEY runtime override.
  updatePublicKey?: string;
}

let cachedBuildInfo: BuildInfo | null = null;
export function loadBuildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "build-info.json"), "utf8");
    cachedBuildInfo = JSON.parse(raw) as BuildInfo;
  } catch {
    cachedBuildInfo = {
      version: "0.0.0",
      sha: "dev",
      branch: "dev",
      dirty: true,
      builtAt: new Date().toISOString(),
    };
  }
  return cachedBuildInfo;
}

// A conventional User-Agent-style client label, e.g. "mla/0.2.13 (darwin-arm64)".
// Sent on the auth heartbeat (refresh + login exchange) so control can record the
// exact CLI version each user is running (lands in Session.userAgent) and we can
// see who is behind and nudge them. The version is not telemetry: it is a client
// identifier attached to already-authenticated requests, so it flows regardless of
// the analytics opt-out. Cheap: loadBuildInfo() is memoized.
export function mlaUserAgent(): string {
  const { version } = loadBuildInfo();
  return `mla/${version} (${process.platform}-${process.arch})`;
}

export function mintTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

// OBS-1 shape: a canonical trace_id is exactly 32 lowercase hex chars (OTel
// native, the shape mintTraceId produces and the shape intel adopts verbatim as
// a Langfuse trace id). The single source of truth for the shape guard, reused
// by the debug-bundle command's `--trace-id` validation (Phase 5 / gap 6.7) so a
// malformed id is rejected up front rather than seeding a bad bundle path.
const CANONICAL_TRACE_ID_RE = /^[0-9a-f]{32}$/;

export function isCanonicalTraceId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_TRACE_ID_RE.test(value);
}

// The single canonical Claude agent-session UUID grammar, byte-identical to the
// Python twin (intel app/observability/langfuse_session.py:_AGENT_SESSION_RE) and
// the Bash hook twin. NEVER a language UUID parser: Python's uuid.UUID accepts
// braces, urn:uuid:, and un-dashed 32-hex, and JS has no native UUID parser at
// all; agreeing on this one explicit regex is what stops the same Claude id
// canonicalizing to two different strings and splitting the Langfuse Session.
const AGENT_SESSION_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// TS twin of canonicalize_agent_session_id. Pure: no metric, no logging. Trim,
// match the regex (case-insensitive), lowercase; no match -> null. The regex is
// anchored, so any leftover whitespace or header-injection byte after trim fails
// the match and yields null, which is what keeps the composed value safe to pass
// to a `-H` curl header downstream.
export function canonicalizeSessionId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  return AGENT_SESSION_RE.test(s) ? s.toLowerCase() : null;
}

// OSS telemetry kill switch (Phase 4.4). When set to an explicit "off" value,
// BOTH outbound planes are hard-disabled regardless of any baked Sentry DSN or
// configured backend: initSentry() refuses to init (below) and cli.ts builds a
// null flushFn so the trace plane is a no-op tracer that never POSTs. This is
// the single, grep-able guarantee that nothing leaves the machine. See
// TELEMETRY.md. The definition now lives in low-level config.ts so the
// failure-telemetry deadletter can share it without an observability import
// cycle; re-exported here so every existing `from "./observability"` importer is
// unchanged. Accepts MEETLESS_TELEMETRY in {off,0,false,no} (case- and
// whitespace-insensitive) OR any truthy MEETLESS_NO_TELEMETRY.
export { telemetryDisabled };

let sentryAvailable = false;

// Keys whose VALUE is always a credential regardless of entropy, redacted by
// name in every Sentry event (breadcrumb data, contexts, extra, tags, request
// headers, exception/stack vars). This is the §9 Sentry-redaction invariant
// (Finding K / Patch P7): the observability layer must never ship an
// Authorization header, access/refresh token, PKCE codeVerifier, control token,
// or INTERNAL_API_KEY off the machine, even with telemetry enabled.
//
// Bare `code` is deliberately ABSENT: it collides with error/status/language
// codes. The one-time login-grant `code` is 64-hex high-entropy, so it is
// caught by the value-based redactor (entropy heuristic in redact()) instead.
const SENTRY_SENSITIVE_KEY =
  /(authorization|access[_-]?token|refresh[_-]?token|code[_-]?verifier|control[_-]?token|internal[_-]?api[_-]?key|\bapi[_-]?key\b|x-api-key|secret|passw(?:or)?d|\bbearer\b|cookie|\btoken\b)/i;

// Keys carrying NON-secret high-entropy identifiers (trace/span/event/run ids,
// git sha, build version, environment). These are exactly the strings the value
// redactor's entropy heuristic would otherwise nuke, and they are the whole
// point of the observability spine (the cross-plane trace-id join + release
// correlation). Exempt them from value redaction; everything else high-entropy
// stays conservatively redacted (over-redaction is the safe failure mode).
const SENTRY_SAFE_IDENTIFIER_KEY =
  /^(x-)?(trace|span|event|run)[_-]?id$|^trace_source$|^release$|^dist$|^sha$|^environment$|^mla_version$|^platform$/i;

// One recursive scrub of a Sentry event. Per field: a credential KEY collapses
// to [REDACTED]; a safe-identifier key passes its value verbatim; every other
// string runs through the shared value redactor (Bearer/provider tokens, PEM,
// cookies, and the high-entropy heuristic that catches the grant code +
// codeVerifier even when they hide in a free-text body).
function scrubEventNode(value: unknown, keyHint: string | undefined): unknown {
  if (keyHint !== undefined && SENTRY_SENSITIVE_KEY.test(keyHint)) return REDACTED;
  if (typeof value === "string") {
    if (keyHint !== undefined && SENTRY_SAFE_IDENTIFIER_KEY.test(keyHint)) return value;
    return redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubEventNode(v, keyHint));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubEventNode(v, k);
    }
    return out;
  }
  return value;
}

// beforeSend hook: scrub every event before it leaves the process. On any
// redaction error we DROP the event (return null) rather than risk shipping an
// unscrubbed payload.
export function redactSentryEvent<T>(event: T): T | null {
  if (event === null || event === undefined) return event;
  try {
    return scrubEventNode(event, undefined) as T;
  } catch {
    return null;
  }
}

export function initSentry(buildInfo: BuildInfo): boolean {
  // 4.4 kill switch wins over everything, including a baked production DSN.
  if (telemetryDisabled()) {
    sentryAvailable = false;
    return false;
  }
  // Dev-only override: only honored when build-info reports a dev build
  // (no baked DSN). Production binaries ignore the env override entirely.
  // OSS-facing MEETLESS_SENTRY_DSN wins; legacy MLA_SENTRY_DSN still accepted.
  const bakedDsn = buildInfo.sentryDsn;
  const isDev = !bakedDsn;
  const dsn = isDev
    ? process.env.MEETLESS_SENTRY_DSN || process.env.MLA_SENTRY_DSN
    : bakedDsn;
  if (!dsn) {
    sentryAvailable = false;
    return false;
  }
  Sentry.init({
    dsn,
    release: buildInfo.sha,
    environment: buildInfo.dirty ? "dev" : "prod",
    // Pure CLI: no transaction sampling, no tracing integrations.
    // Errors and explicit captureMessage only.
    tracesSampleRate: 0,
    // §9 redaction invariant (Finding K / P7): scrub credentials out of every
    // event before transport. Must exist before any token-capturing path (login
    // / refresh) can land a token in a breadcrumb or stack var.
    beforeSend: (event) => redactSentryEvent(event),
  });
  Sentry.setTags({
    mla_version: `${buildInfo.version} (${buildInfo.sha}${buildInfo.dirty ? "-dirty" : ""})`,
    platform: process.platform,
    trace_source: "mla-cli",
  });
  sentryAvailable = true;
  return true;
}

export function isSentryAvailable(): boolean {
  return sentryAvailable;
}

// Shape of the `tracing` block returned by GET /internal/v1/workspaces/me. Kept
// minimal on purpose; §8 of the spine doc fixes it at three keys.
export interface WorkspaceTracingConfig {
  enabled: boolean;
  sentryEnabled: boolean;
  langfuseProjectId: string | null;
}

export interface WorkspaceConfigForTracing {
  workspaceId: string;
  tracing?: WorkspaceTracingConfig | null;
  tracingDogfood?: boolean;
}

// Run-local workspace config snapshot. Read by capture helpers to decide
// whether non-bootstrap captures are allowed (cycle 4 fix 4). null until
// workspace-me has loaded; bootstrap captures fire under null without
// consulting this gate.
let currentWorkspaceConfig: WorkspaceConfigForTracing | null = null;

export function setWorkspaceConfig(cfg: WorkspaceConfigForTracing | null): void {
  currentWorkspaceConfig = cfg;
}

export function getWorkspaceConfig(): WorkspaceConfigForTracing | null {
  return currentWorkspaceConfig;
}

// Tenant guardrail (§9): even if workspace.tracing.sentryEnabled were flipped
// true on a non-dogfood workspace by a config drift, the CLI still refuses to
// send full-context captures. Only ws_an_local or workspaces explicitly flagged
// tracing_dogfood: true clear the gate.
export function workspaceSentryAllowed(cfg: WorkspaceConfigForTracing | null): boolean {
  if (!cfg) return false;
  if (cfg.tracing?.sentryEnabled !== true) return false;
  if (cfg.workspaceId === "ws_an_local") return true;
  return cfg.tracingDogfood === true;
}

// OBS-9 allowlist. The ONLY fields permitted to ride a Sentry context: pointers
// (ids + URLs) and low-cardinality run metadata, never content. Anything else
// (prompt bodies, retrieved evidence text, tool payloads, source diffs, raw
// requests, tokens) is dropped silently so payload leakage is a code guardrail,
// not a rule each future engineer must remember (spec section 8 per-sink
// posture). The Python twin is
// app/core/observability_context.py:set_safe_observability_context.
export interface SafeObservabilityFields {
  traceId?: string;
  langfuseUrl?: string;
  release?: string;
  command?: string;
  exitCode?: number;
  traceSource?: string;
  workspaceIdOrHash?: string;
}

const SAFE_OBSERVABILITY_KEYS: ReadonlyArray<keyof SafeObservabilityFields> = [
  "traceId",
  "langfuseUrl",
  "release",
  "command",
  "exitCode",
  "traceSource",
  "workspaceIdOrHash",
];

// Pick only the allowlisted keys from arbitrary input, dropping anything else
// plus null/undefined and non-scalar values (so an object smuggled into an
// allowlisted key still cannot leak). Exported so the OBS-9 guarantee is
// unit-testable without a live Sentry scope.
export function pickSafeObservabilityFields(
  input: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of SAFE_OBSERVABILITY_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number") {
      out[key] = value;
    }
  }
  return out;
}

// Minimal scope shape so this works against Sentry.withScope's scope without
// importing Sentry's types, and is trivial to fake in tests.
export interface SentryScopeLike {
  setContext(key: string, context: Record<string, unknown> | null): unknown;
}

// Attach the allowlisted observability fields as a single Sentry "observability"
// context block; returns the safe object actually attached (for tests). Pass the
// full candidate object: non-allowlisted keys never reach Sentry. When nothing
// safe survives, the context is set to null so no empty frame is advertised.
export function setSafeObservabilityContext(
  scope: SentryScopeLike,
  fields: Record<string, unknown>,
): Record<string, string | number> {
  const safe = pickSafeObservabilityFields(fields);
  scope.setContext("observability", Object.keys(safe).length > 0 ? safe : null);
  return safe;
}

export interface CaptureCtx {
  traceId: string;
  command: string;
  sub?: string | null;
}

// Build the OBS-9-safe observability fields for a Sentry capture from run-local
// state. langfuseUrl is included only when the workspace config carries a project
// id; otherwise it is omitted (the allowlist drops the undefined). release is the
// build sha so a Sentry event pins the exact binary.
function captureObservabilityFields(
  ctx: CaptureCtx & { exitCode?: number },
): Record<string, string | number | undefined> {
  const cfg = currentWorkspaceConfig;
  const projectId = cfg?.tracing?.langfuseProjectId ?? null;
  return {
    traceId: ctx.traceId,
    langfuseUrl: projectId ? langfuseTraceUrl(projectId, ctx.traceId) : undefined,
    release: cachedBuildInfo?.sha,
    command: ctx.sub ? `${ctx.command} ${ctx.sub}` : ctx.command,
    exitCode: ctx.exitCode,
    traceSource: "mla-cli",
    workspaceIdOrHash: cfg?.workspaceId,
  };
}

export function captureCliError(err: unknown, ctx: CaptureCtx): void {
  if (!sentryAvailable) return;
  if (!workspaceSentryAllowed(currentWorkspaceConfig)) return;
  Sentry.withScope((scope) => {
    scope.setTag("trace_id", ctx.traceId);
    scope.setTag("command", ctx.command);
    scope.setTag("sub", ctx.sub ?? "none");
    setSafeObservabilityContext(scope, captureObservabilityFields(ctx));
    scope.setLevel("error");
    Sentry.captureException(err);
  });
}

export function captureCliNonZeroExit(
  ctx: CaptureCtx & { exitCode: number; reason?: string },
): void {
  if (!sentryAvailable) return;
  if (!workspaceSentryAllowed(currentWorkspaceConfig)) return;
  Sentry.withScope((scope) => {
    scope.setTag("trace_id", ctx.traceId);
    scope.setTag("command", ctx.command);
    scope.setTag("sub", ctx.sub ?? "none");
    scope.setTag("exit_code", String(ctx.exitCode));
    setSafeObservabilityContext(scope, captureObservabilityFields(ctx));
    scope.setLevel("warning");
    Sentry.captureMessage(`mla ${ctx.command} exited ${ctx.exitCode}`);
  });
}

// Bootstrap captures bypass the workspace gate by design: workspace config has
// not loaded yet, but we still need visibility on bad token / control
// unreachable. Tags are minimal so PII risk is zero.
export function captureBootstrapError(err: unknown, ctx: { traceId: string }): void {
  if (!sentryAvailable) return;
  Sentry.withScope((scope) => {
    scope.setTag("trace_id", ctx.traceId);
    scope.setTag("phase", "bootstrap");
    scope.setLevel("error");
    Sentry.captureException(err);
  });
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export async function boundedSentryFlush(): Promise<void> {
  if (!sentryAvailable) return;
  try {
    await Promise.race([Sentry.flush(500), sleep(500)]);
  } catch {
    // Never block exit on Sentry flush failure.
  }
}

// Per-run trace_id storage. Read by mlaFetch to stamp X-Trace-ID on every
// outbound HTTP request. Set exactly once at the top of the run.
let currentTraceId: string | null = null;

export function setRunTraceId(traceId: string): void {
  currentTraceId = traceId;
}

export function getRunTraceId(): string | null {
  return currentTraceId;
}

// Per-run agent session id storage (the raw canonical Claude UUID, NOT the
// composed namespaced value). Read by buildIntelHeaders to stamp
// X-Agent-Session-ID on intel calls so the workspace-authoritative sink composes
// the session exactly once (INV-COMPOSE-ONCE: the raw UUID rides the wire; intel
// composes). Set exactly once at the top of the run from CLAUDE_CODE_SESSION_ID,
// already canonicalized; null when the CLI is not running inside a Claude session
// or the env value is malformed (the header is then simply not stamped).
let currentSessionId: string | null = null;

export function setRunSessionId(sessionId: string | null): void {
  currentSessionId = sessionId;
}

export function getRunSessionId(): string | null {
  return currentSessionId;
}

// Test-only: clear the run-local session id so suites don't bleed state.
export function resetRunSessionIdForTesting(): void {
  currentSessionId = null;
}

// Per-run analytics run_id (INV-RUN-1). Distinct identity from trace_id: minted
// independently, never derived from it. trace_id is the cross-system
// observability key; run_id is the analytics invocation key. They are 1:1 at the
// CLI in v1, but kept separate so hooks/MCP/child-traces can mint their own
// run_id under a shared trace later. uuid (not the 32-hex trace shape) so the two
// can never be confused.
let currentRunId: string | null = null;

export function mintRunId(): string {
  return crypto.randomUUID();
}

export function setRunId(runId: string): void {
  currentRunId = runId;
}

export function getRunId(): string | null {
  return currentRunId;
}

// Test-only: clear the run-local id so suites don't bleed state across cases.
export function resetRunIdForTesting(): void {
  currentRunId = null;
}

// Per-run repo fingerprint (analytics attribution, spec section 3.7 / T1.10). A
// NON-identifying one-way hash of the git remote/repo the run executed in,
// computed ONCE at bootstrap (the git I/O lives in computeRepoFingerprint) and
// read back by the analytics recorder. Stored as a run-local singleton, exactly
// like run_id/trace_id, so buildEvent stays a pure read and never shells out to
// git per event. null when the run is not in a git repo (or git is unavailable);
// attribution then carries a null repoFingerprint rather than a fabricated one.
let currentRepoFingerprint: string | null = null;

export function setRepoFingerprint(fingerprint: string | null): void {
  currentRepoFingerprint = fingerprint;
}

export function getRepoFingerprint(): string | null {
  return currentRepoFingerprint;
}

// Test-only: clear the run-local fingerprint so suites don't bleed state.
export function resetRepoFingerprintForTesting(): void {
  currentRepoFingerprint = null;
}

// Intel-echo observation (P2.4 deep-link gate). Set true when ANY intel
// response in this run carried our X-Trace-ID back in its response headers.
// Observation only: the CLI never adopts the response id (immutability is
// preserved by mlaFetch / intelGet / intelPost; they never read it back into
// currentTraceId). The deep link is printed only when tracer.flush() succeeded
// OR this flag is true (server-side intel route already produced a Langfuse
// trace under the inbound id).
let intelEchoedRunTraceId = false;

// Thrown only in strict/debug mode (see traceStrictMode) when intel positively
// echoes a trace id that is NOT ours. Typed so a caller can distinguish a
// propagation-integrity failure from an ordinary HTTP error.
export class TraceRoundTripError extends Error {
  constructor(
    readonly sent: string,
    readonly echoed: string,
  ) {
    super(`trace-id round-trip mismatch: sent ${sent}, intel echoed ${echoed}`);
    this.name = "TraceRoundTripError";
  }
}

// Strict trace mode (the "strict/debug flag" of spec gap 6.5 / Phase 4). When
// MEETLESS_TRACE_STRICT or MLA_TRACE_STRICT is truthy, a round-trip MISMATCH is
// fatal (throws) instead of a one-line warning. Off by default: a mismatch is a
// confidence-check failure, not a reason to fail a user's command. CI and local
// debugging flip it on to make a silent propagation break loud.
function traceStrictMode(): boolean {
  const v = process.env.MEETLESS_TRACE_STRICT || process.env.MLA_TRACE_STRICT;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

// P4-T2: assert the trace_id round-trip against intel's echoed X-Trace-ID.
//  - absent header  -> graceful no-op (older intel, or a proxy stripped it): the
//    deep-link gate already falls back to didTraceFlushSucceed(), so a missing
//    echo only weakens a confidence check; it never breaks a join.
//  - match          -> record the positive confirmation.
//  - mismatch       -> a real propagation break (a proxy rewrote the header, or
//    intel minted a fresh id because ours never arrived). Warn by default; throw
//    a TraceRoundTripError under strict/debug. Both ids are observability join
//    keys, not payloads, so naming them is OBS-9-safe and is exactly what you
//    need to debug the split.
export function noteIntelEchoedTraceId(echoedId: string | undefined | null): void {
  if (!echoedId) return;
  if (!currentTraceId) return;
  const normalized = echoedId.toLowerCase();
  if (normalized === currentTraceId) {
    intelEchoedRunTraceId = true;
    return;
  }
  if (traceStrictMode()) {
    throw new TraceRoundTripError(currentTraceId, normalized);
  }
  process.stderr.write(
    `warn: trace-id round-trip mismatch (sent ${currentTraceId}, ` +
      `intel echoed ${normalized}); traces for this run may be split\n`,
  );
}

export function didIntelEchoTraceId(): boolean {
  return intelEchoedRunTraceId;
}

export function resetIntelEchoForTesting(): void {
  intelEchoedRunTraceId = false;
}

// Trace-flush outcome (P2.4 deep-link gate). True when boundedTraceFlush
// observed tracer.flush() resolve without throwing. The deep link is printed
// only when this is true OR intel echoed the run trace id; otherwise we'd be
// advertising URLs that resolve to nothing.
let traceFlushSucceeded = false;

export function didTraceFlushSucceed(): boolean {
  return traceFlushSucceeded;
}

export function resetTraceFlushOutcomeForTesting(): void {
  traceFlushSucceeded = false;
}

// HTTP-backed flush function the tracer calls inside flush(). POSTs the span
// batch to control's /internal/v1/agent-traces/ingest. Auth uses the same
// bearer the CLI uses for every other control hop (controlToken). workspaceId
// is injected from the CLI's run-local workspace config so control can apply
// the §9 tenant guardrail (only ws_an_local or tracing_dogfood workspaces are
// allowed to relay). On non-2xx, throw so boundedTraceFlush prints its single
// stderr line.
// The HTTP flush's per-request deadline: the AbortController aborts the fetch at
// this point. This is the AUTHORITATIVE trace-upload timeout.
export const HTTP_FLUSH_TIMEOUT_MS = 1500;

// The outer ceiling boundedTraceFlush races tracer.flush() against. It MUST stay
// >= HTTP_FLUSH_TIMEOUT_MS so the HTTP deadline is the real timeout and this is
// only a backstop for a flush that hangs WITHOUT honoring its own deadline (e.g.
// a non-HTTP flushFn). When this was 500ms and the HTTP timeout was 1500ms, a
// slow-but-successful upload (500-1500ms) was killed by this race, dropped, and
// reported as a false "timeout" (Finding #2). The +500ms headroom lets the inner
// AbortController fire first on a genuinely slow network so the user sees the
// precise HTTP error, not this generic ceiling.
export const TRACE_FLUSH_CEILING_MS = HTTP_FLUSH_TIMEOUT_MS + 500;

export function makeHttpFlush(opts: {
  controlUrl: string;
  controlToken: string;
  workspaceId: string;
  actorUserId?: string;
  timeoutMs?: number;
}): FlushFn {
  const timeout = opts.timeoutMs ?? HTTP_FLUSH_TIMEOUT_MS;
  return async (payload: FlushPayload) => {
    const url = `${opts.controlUrl}/internal/v1/agent-traces/ingest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // agent-traces ingest is a workspace-bound write behind control's
      // AgentReviewWorkspaceGuard (INV-AUTH-1): it 403s "Actor identity
      // required for this write" unless the caller presents an actor. lib/http.ts
      // stamps X-Meetless-Actor on every other control hop; this hand-rolled
      // flush must mirror that, or every self-trace upload 403s. A blank/
      // whitespace-only actor is treated as absent (same as buildRequestHeaders).
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.controlToken}`,
        "Content-Type": "application/json",
        "X-Trace-ID": payload.traceId,
      };
      if (opts.actorUserId && opts.actorUserId.trim().length > 0) {
        headers["X-Meetless-Actor"] = opts.actorUserId;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, workspaceId: opts.workspaceId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const e = new Error(
          `POST ${url} -> HTTP ${res.status}: ${body.slice(0, 200)}`,
        ) as Error & { status?: number; tracingDisabledByPolicy?: boolean };
        e.status = res.status;
        // §9 tenant guardrail: a 403 TRACING_NOT_ENABLED_FOR_WORKSPACE is a
        // deliberate policy refusal (this workspace simply does not relay CLI
        // self-traces), not a failure. Tag it so boundedTraceFlush skips the
        // user-facing warning. Any other non-2xx (auth 403, 5xx, etc.) stays
        // a real, warnable failure.
        if (res.status === 403 && body.includes(TRACING_DISABLED_CODE)) {
          e.tracingDisabledByPolicy = true;
        }
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

// Control's §9 error code for "this workspace is not authorized to relay
// traces" (apps/control api-exception.ts TRACING_NOT_ENABLED_FOR_WORKSPACE).
// Shared by the tag site (makeHttpFlush) and the classifier so the two cannot
// drift on the literal.
const TRACING_DISABLED_CODE = "TRACING_NOT_ENABLED_FOR_WORKSPACE";

// Control's marker-model 403 code (apps/control api-exception.ts
// workspaceAccessDenied): the folder `.meetless.json` marker named a workspace
// the logged-in user is not a member of. On the trace-relay path the marker is
// fixed for the whole run, so this fires on EVERY command for the entire session
// -- exactly the "warn: trace upload failed (HTTP 403) on every single command"
// noise BUG-1 flagged. It is not transient and not fixable by retry (you simply
// cannot relay traces for a workspace you are not in), so it is a silent skip,
// the same class as the §9 policy refusal.
const WORKSPACE_ACCESS_DENIED_CODE = "WORKSPACE_ACCESS_DENIED";

// True when a flush error is one of the two control refusals we deliberately
// swallow instead of warning on: the §9 tracing-policy refusal, or the
// marker-model workspace-access denial. Both are stable, per-session, expected
// conditions under normal multi-workspace / non-member operation, so a
// per-command "trace upload failed" line is pure noise. Every OTHER failure --
// a token/auth 403, any 5xx, a connection refusal, a timeout -- still warns
// loudly. Recognized by the makeHttpFlush tag (policy only) or, defense in
// depth, the body-borne code carried in the error message.
function isSilencedTraceFlushError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    tracingDisabledByPolicy?: boolean;
    status?: number;
    message?: string;
  };
  if (e.tracingDisabledByPolicy === true) return true;
  if (e.status !== 403 || typeof e.message !== "string") return false;
  return (
    e.message.includes(TRACING_DISABLED_CODE) ||
    e.message.includes(WORKSPACE_ACCESS_DENIED_CODE)
  );
}

function describeFlushErr(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; status?: number };
    if (e.status) return `HTTP ${e.status}`;
    if (e.name === "AbortError") return "timeout";
    if (e.message) return e.message.slice(0, 120);
  }
  return String(err).slice(0, 120);
}

// Per-run tracer storage. Read by mlaFetch / intelGet / intelPost to start
// child spans around each outbound HTTP call. Set exactly once at the top of
// the run (cli.ts runCliBootstrap). Null when the CLI is invoked without a
// reachable config (e.g. mla init) so HTTP layers can no-op cheaply.
let currentTracer: Tracer | null = null;

export function setRunTracer(tracer: Tracer | null): void {
  currentTracer = tracer;
}

export function getRunTracer(): Tracer | null {
  return currentTracer;
}

export function resetRunTracerForTesting(): void {
  currentTracer = null;
}

// Convert an outbound URL path into the right side of an `intel.<route>` or
// `control.<route>` span name. Drops `/internal/v1/` / `/v1/` prefixes, strips
// query strings, and collapses obvious id-shaped path segments to `:id` so a
// fleet of `coordination-cases.cse_xxxx` spans roll up cleanly in Langfuse.
const ID_LIKE = /^([a-z]+_[A-Za-z0-9]{4,}|[0-9a-f]{20,}|[0-9a-fA-F-]{36})$/;
export function routeNameFromPath(rawPath: string): string {
  const qIdx = rawPath.indexOf("?");
  const noQuery = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
  let p = noQuery;
  if (p.startsWith("/internal/v1/")) p = p.slice("/internal/v1/".length);
  else if (p.startsWith("/v1/")) p = p.slice("/v1/".length);
  else if (p.startsWith("/")) p = p.slice(1);
  const parts = p.split("/").filter((s) => s.length > 0);
  const sanitized = parts.map((s) => {
    let token: string;
    try {
      token = decodeURIComponent(s);
    } catch {
      token = s;
    }
    return ID_LIKE.test(token) ? ":id" : token;
  });
  return sanitized.join(".") || "root";
}

// Argv redaction for the root span attribute (P2.2 + spec §10.P2 must-test 6).
// Reuses the shared secret redactor so a token leaked on the command line is
// stripped before the trace reaches Langfuse. The redactor returns the input
// unchanged for empty strings, otherwise a transformed string; the cast is
// safe because every input here is already a string.
export function redactArgvForSpan(argv: string[]): string[] {
  return argv.map((arg) => redact(arg) as string);
}

// Canonical Langfuse trace URL. ONE algorithm, mirrored byte-for-byte by the
// Python twin (intel app/core/observability_context.py: langfuse_trace_url). A
// Python-built URL that drifts from this shape produces a Sentry deep-link that
// 404s, so the two are locked together by a cross-language fixture test
// (test/fixtures/langfuse-url-fixtures.json; spec gap 6.3). The CLI has no
// self-host config, so the host is always the Langfuse Cloud default.
export function langfuseTraceUrl(projectId: string, traceId: string): string {
  return `https://cloud.langfuse.com/project/${projectId}/traces/${traceId}`;
}

// P2.3 / spec §8 deep-link printer. Gate is the explicit boolean conjunction:
// workspace config loaded, tracing.enabled true, langfuseProjectId set, AND
// (flush succeeded OR intel echoed the inbound X-Trace-ID). Any single
// condition failing returns false and prints nothing; printing when no trace
// landed advertises dead URLs.
export function langfuseDeepLink(projectId: string, traceId: string): string {
  return `trace: ${langfuseTraceUrl(projectId, traceId)}`;
}

export interface DeepLinkOpts {
  traceId: string;
  config: WorkspaceConfigForTracing | null;
  flushSucceeded: boolean;
  intelEchoed: boolean;
}

export function shouldPrintDeepLink(opts: DeepLinkOpts): boolean {
  if (!opts.config) return false;
  if (opts.config.tracing?.enabled !== true) return false;
  if (!opts.config.tracing.langfuseProjectId) return false;
  return opts.flushSucceeded || opts.intelEchoed;
}

export function maybePrintDeepLink(opts: DeepLinkOpts): boolean {
  if (!shouldPrintDeepLink(opts)) return false;
  const projectId = opts.config!.tracing!.langfuseProjectId!;
  process.stdout.write(`${langfuseDeepLink(projectId, opts.traceId)}\n`);
  return true;
}

// Build the run's tracer. Returns a no-op tracer when no HTTP flush function
// is available (mla init / no config / fully-offline command). Otherwise
// returns a real tracer whose flush POSTs to control's relay. flush() is
// always called once (via boundedTraceFlush in cli.ts); the no-op tracer
// resolves immediately so the lifecycle is unconditional.
export function createRunTracer(opts: {
  traceId: string;
  rootName: string;
  buildInfo: BuildInfo;
  flushFn: FlushFn | null;
}): Tracer {
  if (!opts.flushFn) {
    return makeNoopTracer({ traceId: opts.traceId });
  }
  return makeTracer({
    traceId: opts.traceId,
    rootName: opts.rootName,
    client: {
      mlaVersion: opts.buildInfo.version,
      platform: process.platform,
    },
    flushFn: opts.flushFn,
  });
}

// Visible-failure stderr line on flush error (spec §6.2). Exactly one line, no
// retry, no persistence. Caller's command exit code is preserved; this never
// throws so it cannot promote a successful command into a failed one.
//
// The ceiling uses a cleared setTimeout (not sleep().then(throw)) so the timer
// is released when flush wins; otherwise it would hold the event loop open until
// the full ceiling elapses after success (functionally masked by CLI's
// process.exit, but leaks open handles in jest and would block any programmatic
// caller). The ceiling defaults to TRACE_FLUSH_CEILING_MS, kept wider than the
// HTTP flush's own deadline so a slow-but-successful upload is not killed here
// (Finding #2); callers/tests may pass a tighter ceiling.
export async function boundedTraceFlush(
  tracer: Tracer,
  ceilingMs: number = TRACE_FLUSH_CEILING_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushErr: unknown = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timeout: trace flush exceeded ${ceilingMs}ms`);
      flushErr = err;
      reject(err);
    }, ceilingMs);
  });
  try {
    let flushPromise: Promise<void>;
    try {
      flushPromise = Promise.resolve(tracer.flush());
    } catch (err) {
      // A synchronous throw inside tracer.flush() before it returns a promise.
      flushPromise = Promise.reject(err);
    }
    await Promise.race([
      flushPromise.catch((e) => {
        flushErr = e;
        throw e;
      }),
      timeoutPromise,
    ]);
    traceFlushSucceeded = true;
  } catch {
    // Not relayed either way, so no trace URL to advertise (cli.ts gates on
    // didTraceFlushSucceed()).
    traceFlushSucceeded = false;
    // A §9 tracing-policy refusal or a marker-model workspace-access denial is
    // expected, not a failure: stay silent (both fire on every command). Every
    // real failure (token/auth 403, 5xx, connection refused, timeout) still warns.
    if (!isSilencedTraceFlushError(flushErr)) {
      process.stderr.write(
        `warn: trace upload failed (${describeFlushErr(flushErr)}); ` +
          `Sentry event still carries trace_id\n`,
      );
      // F8 (telemetry-upload-failed): the trace upload itself failed on a real,
      // non-policy error. Record it to the local deadletter so the failure is
      // never silently lost (a telemetry system that fails silently gives false
      // "no alerts = no problems"). Per INV-SENTRY-NOISE-BUDGET this is
      // local-deadletter + the local warning above, NOT a Sentry event from the
      // CLI. recordTelemetryUploadFailure respects the kill switch and never
      // throws; the extra guard keeps a future change from breaking the flush
      // path (this must never promote a successful command into a failed one).
      try {
        const wsCfg = getWorkspaceConfig();
        const status = (flushErr as { status?: number } | null)?.status;
        recordTelemetryUploadFailure({
          traceId: tracer.traceId,
          workspaceId: wsCfg?.workspaceId ?? null,
          surface: "mla-cli",
          reasonCode: "trace_upload_failed",
          status: typeof status === "number" ? status : undefined,
        });
      } catch {
        // F8 recording is best-effort; swallow so flush stays non-throwing.
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
