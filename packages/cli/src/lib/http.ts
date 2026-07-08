import * as fs from "fs";
import {
  CFG_PATH,
  CliAuth,
  CliConfig,
  readConfig,
  writeConfig,
} from "./config";
import {
  clearAuthBreaker,
  consultAuthBreaker,
  tripAuthBreaker,
} from "./auth-breaker";
import {
  getRunSessionId,
  getRunTraceId,
  getRunTracer,
  noteIntelEchoedTraceId,
  routeNameFromPath,
} from "./observability";
import type { SpanHandle } from "@meetless/trace-core";

export interface HttpError extends Error {
  // Optional: fetch-level failures (ECONNREFUSED, AbortError) reject as raw
  // TypeError/DOMException with no status. Only buildError (an HTTP non-2xx)
  // sets it. Call sites that read it must treat undefined as "never reached
  // the server" (see explainIntelError / ping).
  status?: number;
  body: string;
}

function buildError(status: number, body: string, method: string, url: string): HttpError {
  const e = new Error(`${method} ${url} -> HTTP ${status}: ${body.slice(0, 500)}`) as HttpError;
  e.status = status;
  e.body = body;
  return e;
}

// Wedge v6 Epoch 28: Build per-request headers. Content-Type is set ONLY when
// there is a body. Sending `Content-Type: application/json` on a body-less GET
// is HTTP-semantically wrong (RFC 7231 §3.1.1.5) AND a documented platform
// trap: Express's `body-parser` json() middleware on certain Node versions
// silently 400s a body-less request that advertises a JSON content type. The
// failure mode is invisible (no body in the 400 response) and the CLI's
// HttpError surfaces "HTTP 400: " with no diagnostic. Past production breakage
// is recorded in CLAUDE.md "Hard-Won Platform Lessons" -> macOS/Node.js.
//
// T1.4 (folder = workspace): when an actor is supplied (cli-config.actorUserId)
// it is stamped as X-Meetless-Actor on EVERY control request. The membership
// guard (INV-AUTH-1) needs the caller identity to resolve a WorkspaceUser; the
// header is harmless on reads and load-bearing on agent-review writes (it also
// covers agent-traces, which never carry an actor in the body). A blank/
// whitespace-only actor is treated as absent so the config-less `mla init` path
// stays header-free.
export function buildRequestHeaders(
  token: string,
  hasBody: boolean,
  actorUserId?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (hasBody) {
    h["Content-Type"] = "application/json";
  }
  // Stamp the run's trace_id on every outbound request so Sentry tags, intel's
  // Langfuse traces, and any server-side scope share a single id. CLI never
  // reads X-Trace-ID off the response; the run's id is immutable.
  const traceId = getRunTraceId();
  if (traceId) {
    h["X-Trace-ID"] = traceId;
  }
  if (actorUserId && actorUserId.trim().length > 0) {
    h["X-Meetless-Actor"] = actorUserId;
  }
  return h;
}

// P2.1 / P2.2: span helper. Child spans wrap every outbound HTTP call so the
// Langfuse trace renders one span per `mlaFetch` with route, http.status, and
// latency_ms attributes. plane is "intel" or "control"; route is derived from
// the URL path via routeNameFromPath so id-shaped segments roll up cleanly.
// Returns null when no tracer is registered (mla init / config-less paths),
// so the http layer no-ops cheaply.
function startHttpSpan(
  plane: "intel" | "control",
  method: string,
  path: string,
): { handle: SpanHandle | null; startMs: number } {
  const tracer = getRunTracer();
  if (!tracer) return { handle: null, startMs: Date.now() };
  const handle = tracer.startSpan({
    name: `${plane}.${routeNameFromPath(path)}`,
  });
  handle.setAttribute("http.method", method);
  handle.setAttribute("route", path);
  return { handle, startMs: Date.now() };
}

function endHttpSpan(
  ctx: { handle: SpanHandle | null; startMs: number },
  outcome:
    | { kind: "ok"; status: number }
    | { kind: "http_error"; status: number }
    | { kind: "network_error"; error: unknown },
): void {
  const { handle, startMs } = ctx;
  if (!handle) return;
  const latencyMs = Date.now() - startMs;
  handle.setAttribute("latency_ms", latencyMs);
  if (outcome.kind === "ok") {
    handle.setAttribute("http.status", outcome.status);
    handle.end({ status: "ok", output: { status: outcome.status, latency_ms: latencyMs } });
    return;
  }
  if (outcome.kind === "http_error") {
    handle.setAttribute("http.status", outcome.status);
    handle.end({
      status: "error",
      output: { status: outcome.status, latency_ms: latencyMs },
    });
    return;
  }
  handle.end({ status: "error", error: outcome.error, output: { latency_ms: latencyMs } });
}

// Single-shot control request: exactly one fetch, no auth-mode policy, no retry.
// doFetch (below) wraps this with the none-mode fail-fast and the user-token
// auto-refresh dance (§6.5). Splitting them keeps the refresh retry a clean
// "call doFetchOnce again with the rotated token" rather than re-entrant.
async function doFetchOnce(
  cfg: CliConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  timeoutMs = 10000,
): Promise<unknown> {
  const url = `${cfg.controlUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hasBody = body !== undefined && body !== null;
  const span = startHttpSpan("control", method, path);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: buildRequestHeaders(cfg.controlToken, hasBody, cfg.actorUserId),
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      endHttpSpan(span, { kind: "network_error", error: err });
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      endHttpSpan(span, { kind: "http_error", status: res.status });
      throw buildError(res.status, text, method, url);
    }
    endHttpSpan(span, { kind: "ok", status: res.status });
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

interface DoFetchOpts {
  // doctor's connectivity probe pings the UNAUTHENTICATED /internal/v1/health
  // route; without this bypass a `mode: 'none'` config would fail-fast before the
  // probe could run and doctor could never report "control reachable". Only the
  // `ping` helper sets it. It also skips the auto-refresh retry: an unauthed
  // probe has no session to refresh.
  allowUnauthenticated?: boolean;
}

// Control request with the §6.4/§6.5 auth policy layered on top of doFetchOnce:
//   - `mode: 'none'`  -> fail fast with "not logged in" (Blocking 3), unless the
//     caller is an unauthenticated probe (doctor health).
//   - `mode: 'user-token'` + 401 -> transparently refresh the access token once
//     (concurrency-safe, §6.5 clause 7) and retry the original request ONCE. A
//     second 401 becomes `auth_expired`.
//   - `mode: 'shared-key'` -> a 401 propagates directly (the operator rotated the
//     shared key out of band; they must re-run `mla init --control-token <NEW>`).
async function doFetch(
  cfg: CliConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  timeoutMs = 10000,
  opts: DoFetchOpts = {},
): Promise<unknown> {
  if (!opts.allowUnauthenticated && cfg.auth.mode === "none") {
    throw notLoggedInError();
  }
  // Dead-auth circuit breaker. Once control has REJECTED this exact on-disk
  // refresh token (tripAuthBreaker, below), fail fast WITHOUT touching control so
  // a dead session's hooks (heartbeat, steer-sync, flush) stop self-DoSing it
  // with a validate+refresh storm. consultAuthBreaker re-reads disk and self-
  // clears the moment the token changes (an `mla login`), so a re-login heals even
  // the long-lived `mla mcp` workers live. Skipped for unauthenticated probes and
  // for shared-key (no refresh token to be rejected).
  if (
    !opts.allowUnauthenticated &&
    cfg.auth.mode === "user-token" &&
    consultAuthBreaker()
  ) {
    throw authExpiredError();
  }
  try {
    return await doFetchOnce(cfg, method, path, body, timeoutMs);
  } catch (e) {
    const err = e as HttpError;
    // Auto-refresh applies ONLY to a user-token 401. Unauthenticated probes,
    // shared-key, none, network errors, and non-401 statuses all propagate.
    if (
      opts.allowUnauthenticated ||
      err.status !== 401 ||
      cfg.auth.mode !== "user-token"
    ) {
      throw e;
    }
    const outcome = await refreshUserToken(cfg);
    if (outcome === "busy") {
      throw refreshBusyError();
    }
    if (outcome === "expired") {
      throw authExpiredError();
    }
    // "refreshed": cfg now carries the rotated token. Retry exactly once.
    try {
      const out = await doFetchOnce(cfg, method, path, body, timeoutMs);
      // A call that succeeds after a refresh proves auth recovered; ensure no
      // dead-auth sentinel lingers (belt-and-suspenders with consult's self-clear).
      clearAuthBreaker();
      return out;
    } catch (e2) {
      const err2 = e2 as HttpError;
      if (err2.status === 401) {
        throw authExpiredError();
      }
      throw e2;
    }
  }
}

// ---------------------------------------------------------------------------
// Auth-policy errors (§6.4, §6.5). All carry an empty `body` and a
// human-readable message that NEVER contains a token.
// ---------------------------------------------------------------------------

function notLoggedInError(): HttpError {
  const e = new Error(
    "Not logged in. Run `mla login` (or `mla init --control-token <T>`).",
  ) as HttpError;
  e.body = "";
  return e;
}

function authExpiredError(): HttpError {
  // §6.5: invisible until the refresh token itself expires (~30 days idle).
  const e = new Error("Your CLI login expired. Run `mla login`.") as HttpError;
  e.status = 401;
  e.body = "";
  return e;
}

function refreshBusyError(): HttpError {
  const e = new Error(
    "Another mla process is refreshing the login. Retry in a moment.",
  ) as HttpError;
  e.body = "";
  return e;
}

// Fail-fast guard for the intel plane (which always needs a real bearer; intel
// validates it via control, §7). Mirrors doFetch's none-mode reject. Intel does
// NOT auto-refresh in v1: refresh is scoped to control's doFetch (§6.5). A
// user-token whose access token expired refreshes on its next control call; the
// rotated token (cfg mutated in place) is then used by any later intel call in
// the same run.
function assertIntelAuthed(cfg: CliConfig): void {
  if (cfg.auth.mode === "none") {
    throw notLoggedInError();
  }
}

// ---------------------------------------------------------------------------
// Concurrency-safe access-token refresh (§6.5, §0.01 clause 7).
//
// Two `mla` processes (e.g. the detached auto-index loop and an interactive
// `mla review`) can 401 on the SAME on-disk refresh token at the same instant.
// Refresh tokens are single-use (the server rotates on every call, §9), so a
// naive double-refresh would let one rotation win and tear the other's session
// down with a spurious "login expired". The lock + re-read makes the loser adopt
// the winner's freshly-rotated token instead of POSTing a now-dead one.
// ---------------------------------------------------------------------------

// Sidecar advisory lock, NOT the config file itself: a crashed holder can never
// corrupt cli-config.json, and a stale lock is safe to steal.
const LOCK_PATH = `${CFG_PATH}.lock`;
// Cap the wait for an interactive command (§6.5 clause 1: "e.g. 5s"). On expiry
// we surface "retry" rather than hang.
const LOCK_WAIT_CAP_MS = 5000;
const LOCK_POLL_MS = 75;
// A lock older than this is treated as abandoned (holder crashed) and stolen.
// Comfortably above the refresh HTTP timeout so we never steal a live refresh.
const LOCK_STALE_MS = 30000;
const REFRESH_TIMEOUT_MS = 10000;
// Treat an access token expiring within this window as already-expired, so we
// never adopt a token that would die mid-request.
const ACCESS_SKEW_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Acquire the exclusive sidecar lock. Returns the open fd, or null if the cap
// elapsed while another process held it (caller maps null -> "busy"/"retry").
async function acquireRefreshLock(): Promise<number | null> {
  const deadline = Date.now() + LOCK_WAIT_CAP_MS;
  for (;;) {
    try {
      // `wx`: create-and-fail-if-exists is the atomic test-and-set.
      const fd = fs.openSync(LOCK_PATH, "wx");
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } catch {
        // Best effort: the lock IS the file's existence, not its content.
      }
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held. Steal only a clearly-abandoned (stale) lock, then retry.
      try {
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        // Holder released between EEXIST and stat: just retry the create.
      }
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseRefreshLock(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    // A stale-steal by another process may have already removed it.
  }
}

function accessTokenStillFresh(accessExpiresAt: string): boolean {
  const ms = Date.parse(accessExpiresAt) - Date.now();
  return !Number.isNaN(ms) && ms > ACCESS_SKEW_MS;
}

// Adopt a (re-read or freshly-rotated) user-token into the caller's in-memory
// cfg so the retry, and the rest of this run, use it without re-reading disk.
function adoptAuth(cfg: CliConfig, auth: Extract<CliAuth, { mode: "user-token" }>): void {
  cfg.auth = auth;
  cfg.controlToken = auth.accessToken;
  cfg.actorUserId = auth.user.id;
}

// Over-the-wire refresh response (Dates serialize to ISO strings). Mirrors
// control's RefreshResult = SessionResult | RaceRecoveryResult: a benign tab-race
// returns the identity with null tokens (the winning process already rotated).
interface RefreshWire {
  sessionId?: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

// POST the refresh token (body proof-of-possession; NO Authorization header,
// the access token is dead). The refresh token is NEVER logged. Returns the
// wire body, or a sentinel: "unauthorized" (refresh token itself is dead ->
// re-login) vs "transient" (network/5xx -> retry, session untouched).
async function callRefresh(
  controlUrl: string,
  refreshToken: string,
): Promise<RefreshWire | "unauthorized" | "transient"> {
  const url = `${controlUrl.replace(/\/+$/, "")}/internal/v1/auth/token/refresh`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
      });
    } catch {
      return "transient"; // timeout / DNS / connection refused
    }
    if (res.status === 401 || res.status === 410) return "unauthorized";
    if (!res.ok) return "transient"; // 5xx etc: server broken, not session dead
    const text = await res.text();
    try {
      return JSON.parse(text) as RefreshWire;
    } catch {
      return "transient";
    }
  } finally {
    clearTimeout(timer);
  }
}

export type RefreshOutcome = "refreshed" | "expired" | "busy";

// The lock + re-read + (maybe) rotate critical section (§6.5 clauses 1-3). The
// lock is held ONLY here, never across the original API request. Releases on
// every exit path via finally.
//
// Exported (Part 3) so `mla _internal refresh` can trigger the SAME
// concurrency-safe refresh the in-process auto-refresh uses. The hook-triggered
// caller is byte-identical to the doFetch caller from the config file's view: it
// shares the sidecar lock, single-flight re-read, and atomic writeConfig. Bash
// performs no token crypto, persistence, or refresh HTTP of its own.
export async function refreshUserToken(cfg: CliConfig): Promise<RefreshOutcome> {
  // Defensive: doFetch only calls this for user-token, but guard anyway.
  if (cfg.auth.mode !== "user-token") return "expired";

  const fd = await acquireRefreshLock();
  if (fd === null) return "busy"; // another process is mid-refresh; tell operator to retry
  try {
    // Clause 2: re-read AFTER the lock. Another process may have rotated while
    // we waited.
    let fresh: CliConfig;
    try {
      fresh = readConfig();
    } catch {
      // Config became unreadable (corrupt, or the Gate-4 env conflict appeared
      // mid-run). We cannot safely refresh; the operator must re-login / fix env.
      return "expired";
    }
    if (fresh.auth.mode !== "user-token") {
      // Another process logged out or downgraded the config underneath us.
      return "expired";
    }
    // Already rotated by another process: adopt it, NO network call (this is the
    // case that prevents the double-rotation race).
    if (accessTokenStillFresh(fresh.auth.accessExpiresAt)) {
      adoptAuth(cfg, fresh.auth);
      return "refreshed";
    }

    // Clause 3: still expired -> rotate against control.
    const rotated = await callRefresh(fresh.controlUrl, fresh.auth.refreshToken);
    if (rotated === "transient") {
      // Do NOT tear the session down on a transient outage: the on-disk refresh
      // token is untouched and still valid. Surface as "retry".
      return "busy";
    }
    if (rotated === "unauthorized") {
      // The refresh token itself was REJECTED (401/410): the session is genuinely
      // dead, not throttled. Trip the breaker keyed to THIS token so every later
      // call (this process and the other hooks/workers sharing the config) fails
      // fast instead of re-hammering control. A transient/throttled outcome maps to
      // "transient"->"busy" above and never reaches here, so a rate-limit burst
      // (the server's new 429) can never trip the breaker.
      tripAuthBreaker(fresh.auth.refreshToken, "refresh_rejected");
      return "expired";
    }
    if (rotated.accessToken === null) {
      // RaceRecoveryResult: the server saw a benign race and minted no new pair.
      // Re-read once: the winning process's rotation may now be on disk. NEVER
      // writeConfig the null tokens.
      let after: CliConfig;
      try {
        after = readConfig();
      } catch {
        return "expired";
      }
      if (
        after.auth.mode === "user-token" &&
        accessTokenStillFresh(after.auth.accessExpiresAt)
      ) {
        adoptAuth(cfg, after.auth);
        return "refreshed";
      }
      return "expired";
    }

    // Normal rotation. Refresh does not change identity; only the tokens rotate,
    // so preserve user + sessionId (fall back to the wire sessionId if present).
    if (
      !rotated.refreshToken ||
      !rotated.accessExpiresAt ||
      !rotated.refreshExpiresAt
    ) {
      // Malformed success body: treat as transient rather than persist a partial
      // credential.
      return "busy";
    }
    const newAuth: Extract<CliAuth, { mode: "user-token" }> = {
      mode: "user-token",
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      accessExpiresAt: rotated.accessExpiresAt,
      refreshExpiresAt: rotated.refreshExpiresAt,
      sessionId: rotated.sessionId ?? fresh.auth.sessionId,
      user: fresh.auth.user,
    };
    writeConfig({
      ...fresh,
      auth: newAuth,
      controlToken: newAuth.accessToken,
      actorUserId: newAuth.user.id,
    });
    adoptAuth(cfg, newAuth);
    return "refreshed";
  } finally {
    releaseRefreshLock(fd);
  }
}

export async function get<T = unknown>(
  cfg: CliConfig,
  path: string,
  timeoutMs?: number,
): Promise<T> {
  return (await doFetch(cfg, "GET", path, undefined, timeoutMs)) as T;
}

export async function post<T = unknown>(
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  return (await doFetch(cfg, "POST", path, body, timeoutMs)) as T;
}

export async function patch<T = unknown>(
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  return (await doFetch(cfg, "PATCH", path, body, timeoutMs)) as T;
}

// Intel reads (KB inspector, T18). Intel is a SEPARATE base URL from control
// (cfg.intelUrl, default 127.0.0.1:8100) but accepts the same bearer the hook
// uses for /v1/intercept + /v1/ask: cfg.controlToken IS intel's INTERNAL_API_KEY
// in the dogfood config (see user-prompt-submit.sh INTEL_TOKEN). Keeping the
// token source identical to the hook avoids a second secret in cli-config.json.
export const DEFAULT_INTEL_URL = "http://127.0.0.1:8100";

// Build per-request headers for intel calls. Mirrors buildRequestHeaders for
// control: stamp X-Trace-ID when a run-local id exists so intel adopts it as
// the Langfuse trace id (intel/app/core/context.py:55). hasBody gates
// Content-Type to avoid the Express bodyParser silent-400 trap on GET.
export function buildIntelHeaders(token: string, hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (hasBody) {
    h["Content-Type"] = "application/json";
  }
  const traceId = getRunTraceId();
  if (traceId) {
    h["X-Trace-ID"] = traceId;
  }
  // X-Agent-Session-ID carries the raw canonical Claude UUID (Channel A). Intel
  // stores it verbatim on RequestContext and composes the workspace-namespaced
  // Langfuse session exactly once at its telemetry sink, so the CLI never sends
  // the composed value. Stamped only when a run-local session id exists; absent
  // means "no agent session" (console fallback at intel), and the value is
  // already canonicalized so it cannot inject a header.
  const sessionId = getRunSessionId();
  if (sessionId) {
    h["X-Agent-Session-ID"] = sessionId;
  }
  return h;
}

export async function intelGet<T = unknown>(
  cfg: CliConfig,
  path: string,
  timeoutMs = 10000,
): Promise<T> {
  assertIntelAuthed(cfg);
  const base = cfg.intelUrl || DEFAULT_INTEL_URL;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const span = startHttpSpan("intel", "GET", path);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: buildIntelHeaders(cfg.controlToken, false),
        signal: controller.signal,
      });
    } catch (err) {
      endHttpSpan(span, { kind: "network_error", error: err });
      throw err;
    }
    noteIntelEchoedTraceId(res.headers.get("x-trace-id"));
    const text = await res.text();
    if (!res.ok) {
      endHttpSpan(span, { kind: "http_error", status: res.status });
      throw buildError(res.status, text, "GET", url);
    }
    endHttpSpan(span, { kind: "ok", status: res.status });
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text } as T;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function intelPost<T = unknown>(
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs = 15000,
): Promise<T> {
  assertIntelAuthed(cfg);
  const base = cfg.intelUrl || DEFAULT_INTEL_URL;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const span = startHttpSpan("intel", "POST", path);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: buildIntelHeaders(cfg.controlToken, true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      endHttpSpan(span, { kind: "network_error", error: err });
      throw err;
    }
    noteIntelEchoedTraceId(res.headers.get("x-trace-id"));
    const text = await res.text();
    if (!res.ok) {
      endHttpSpan(span, { kind: "http_error", status: res.status });
      throw buildError(res.status, text, "POST", url);
    }
    endHttpSpan(span, { kind: "ok", status: res.status });
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text } as T;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Intel writes via PATCH (KB posture flip, `mla kb promote`). Mirrors intelPost
// exactly: same intel base URL, same buildIntelHeaders(controlToken, true), same
// span plane, same error handling, same JSON parse. Only the HTTP method differs.
export async function intelPatch<T = unknown>(
  cfg: CliConfig,
  path: string,
  body: unknown,
  timeoutMs = 15000,
): Promise<T> {
  assertIntelAuthed(cfg);
  const base = cfg.intelUrl || DEFAULT_INTEL_URL;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const span = startHttpSpan("intel", "PATCH", path);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "PATCH",
        headers: buildIntelHeaders(cfg.controlToken, true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      endHttpSpan(span, { kind: "network_error", error: err });
      throw err;
    }
    noteIntelEchoedTraceId(res.headers.get("x-trace-id"));
    const text = await res.text();
    if (!res.ok) {
      endHttpSpan(span, { kind: "http_error", status: res.status });
      throw buildError(res.status, text, "PATCH", url);
    }
    endHttpSpan(span, { kind: "ok", status: res.status });
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return { raw: text } as T;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function ping(cfg: CliConfig, path: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    // allowUnauthenticated: doctor pings the UNAUTHENTICATED /internal/v1/health
    // route to prove connectivity. A `mode: 'none'` config must not fail-fast
    // here (there is genuinely no session, but the probe still answers), and the
    // probe has no token to auto-refresh. Goes through doFetch directly to pass
    // the bypass that `get` cannot express.
    await doFetch(cfg, "GET", path, undefined, 5000, { allowUnauthenticated: true });
    return { ok: true };
  } catch (e) {
    const err = e as HttpError;
    return { ok: false, status: err.status, error: err.message };
  }
}
