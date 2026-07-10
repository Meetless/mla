// `mla login` browser-login transport (proposal §6.1-§6.3, T21).
//
// Owns the loopback OAuth dance: generate PKCE, stand up a single-shot loopback
// HTTP listener on 127.0.0.1, open the Console authorize page in the OS browser,
// wait for the callback (or a 5-minute timeout), then exchange the one-time grant
// `code` + PKCE `codeVerifier` for a user-token bundle. No new runtime deps: Node
// built-in `http`, `crypto`, `child_process`, `os` only.
//
// Security invariants enforced here:
//   - The exchange POST carries NO Authorization header (proposal §0.01 clause 1 /
//     §4.1): the one-time `code` + PKCE `codeVerifier` in the JSON body ARE the
//     proof-of-possession. Control rejects the call with 400 if any Authorization
//     header is present, so we never send one.
//   - The grant `code`, PKCE `codeVerifier`, and the returned access/refresh
//     tokens are NEVER logged. We log only the authorize URL (which carries the
//     PKCE *challenge*, a sha256 hash, and the `state` CSRF nonce, neither secret)
//     and high-level status lines.
//   - Loopback binds to 127.0.0.1 ONLY (never 0.0.0.0 / localhost) so no other
//     host on the LAN can hit the callback (RFC 8252 §7.3).
//   - `state` is compared constant-time; a mismatch is refused as possible CSRF.

import { spawn } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as os from "os";

// ---------------------------------------------------------------------------
// Bundle shape returned by control's exchange endpoint (SessionResult, §4.1).
// Date fields are serialized as ISO 8601 strings over the wire. This is the
// exact shape `mla login` (T24) maps into the CliAuth user-token variant.
// ---------------------------------------------------------------------------

export interface LoginUser {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  role: string;
  roleVersion: number;
  canCreateDiff: boolean;
  canAdminDiff: boolean;
}

export interface LoginWorkspace {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  language: string;
}

export interface TokenBundle {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string; // ISO 8601
  refreshExpiresAt: string; // ISO 8601
  user: LoginUser;
  workspace: LoginWorkspace;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636 S256) + CSRF state.
// ---------------------------------------------------------------------------

export interface Pkce {
  verifier: string; // client secret; base64url of 32 random bytes (43 chars)
  challenge: string; // base64url(sha256(verifier)); sent to Console, not secret
}

export function generatePkce(): Pkce {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// Constant-time string compare. crypto.timingSafeEqual requires equal-length
// buffers, so a length mismatch short-circuits to false (and never throws).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Console URL discovery (assumption table row 2). Inferred from the control URL
// via a small pair table, overridable by the caller (--console-url / cfg /
// MEETLESS_CONSOLE_URL, resolved in the command layer). Returns null when no
// pair matches so the caller can fail loud with a "pass --console-url" hint
// rather than silently guess a wrong origin.
//
// NOTE on the local dev port: the proposal's §6.1 example wrote
// `127.0.0.1:3006 -> http://127.0.0.1:3030`, but the Console dev server actually
// listens on 3003 (apps/console/package.json `next dev --port ...:-3003`); 3030
// appears nowhere in the repo. We use the verified 3003 here. The PRODUCTION pair
// (control.meetless.ai -> app.meetless.ai) matches DEFAULT_CONTROL_URL /
// DEFAULT_CONSOLE_URL in config.ts, so a fresh `mla login` against the default
// backend infers the console URL with no flag. Non-default backends (self-hosted
// or internal) pass --console-url explicitly, or set MEETLESS_CONSOLE_URL /
// consoleUrl in cli-config.json; we deliberately keep no extra hardcoded pairs.
// ---------------------------------------------------------------------------

const CONTROL_CONSOLE_PAIRS: Array<{ control: RegExp; console: string }> = [
  { control: /^https?:\/\/(127\.0\.0\.1|localhost):3006(\/|$)/i, console: "http://127.0.0.1:3003" },
  { control: /^https?:\/\/control\.meetless\.ai(\/|$)/i, console: "https://app.meetless.ai" },
];

export function consoleUrlFromControl(controlUrl: string): string | null {
  const trimmed = controlUrl.trim();
  for (const pair of CONTROL_CONSOLE_PAIRS) {
    if (pair.control.test(trimmed)) return pair.console;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loopback HTTP server (§6.3). Listens on 127.0.0.1, kernel-assigned port,
// single route GET /callback?code=&state=, single-shot.
// ---------------------------------------------------------------------------

export interface LoopbackServer {
  server: http.Server;
  port: number;
  // Resolves with the one-time grant code once a state-valid callback arrives.
  // Rejects if a state-valid callback arrives with no code (malformed).
  callbackPromise: Promise<{ code: string }>;
}

const CLOSE_TAB_HTML =
  "<!doctype html><html><head><meta charset=utf-8><title>mla login</title></head>" +
  "<body style=\"font-family:system-ui;margin:3rem;text-align:center\">" +
  "<h2>You can close this tab.</h2>" +
  "<p>Return to your terminal; <code>mla login</code> is finishing up.</p>" +
  "</body></html>";

export function openLoopbackServer(opts: {
  state: string;
  // Fixed loopback port. Omitted/undefined => port 0 (kernel picks a free one).
  // A fixed port is required only for `--no-browser` over SSH `-L` forwarding
  // (§6.6), where the redirect_uri must match a port forwarded ahead of time.
  port?: number;
}): Promise<LoopbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let resolveCb!: (v: { code: string }) => void;
    let rejectCb!: (e: Error) => void;
    const callbackPromise = new Promise<{ code: string }>((res, rej) => {
      resolveCb = res;
      rejectCb = rej;
    });

    const server = http.createServer((req, res) => {
      // Parse against a fixed 127.0.0.1 base; req.url is path+query only.
      let parsed: URL;
      try {
        parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad request");
        return;
      }

      if (req.method !== "GET" || parsed.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const gotState = parsed.searchParams.get("state") ?? "";
      const code = parsed.searchParams.get("code") ?? "";

      // Constant-time CSRF check. NEVER log the query string (it carries `code`).
      if (!safeEqual(gotState, opts.state)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("State mismatch: possible CSRF; refusing");
        return;
      }

      if (settled) {
        // Single-shot: a second valid callback is a no-op ack.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CLOSE_TAB_HTML);
        return;
      }

      if (!code) {
        settled = true;
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing authorization code");
        rejectCb(new Error("Loopback callback arrived without an authorization code."));
        return;
      }

      settled = true;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CLOSE_TAB_HTML);
      resolveCb({ code });
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        rejectServer(err);
      }
    });

    // port 0 => kernel picks a free port; a caller-supplied port pins it (for
    // SSH `-L` forwarding under --no-browser). host 127.0.0.1 only.
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        rejectServer(new Error("Failed to bind loopback server to 127.0.0.1."));
        return;
      }
      resolveServer({ server, port: addr.port, callbackPromise });
    });
  });
}

// ---------------------------------------------------------------------------
// Browser launcher (§6.2). No new dependency; platform-appropriate spawn.
// Returns the launcher's exit code (0 = launched). A non-zero result is a SOFT
// fallback, not a failure: the caller prints the URL for manual open and keeps
// the loopback listening.
// ---------------------------------------------------------------------------

// The opener is injected (default: real spawn) so the launcher-selection logic
// can be unit-tested per platform without opening a browser. `windowsVerbatimArguments`
// is threaded through because the win32 launcher hand-quotes its args (see openBrowser).
export type BrowserOpener = (
  cmd: string,
  args: string[],
  opts?: { windowsVerbatimArguments?: boolean },
) => Promise<number>;

function spawnOpener(
  cmd: string,
  args: string[],
  opts: { windowsVerbatimArguments?: boolean } = {},
): Promise<number> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        stdio: "ignore",
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
      });
      child.on("error", () => resolve(127)); // ENOENT / not installed
      child.on("exit", (code) => resolve(code ?? 0));
    } catch {
      resolve(127);
    }
  });
}

export async function openBrowser(
  url: string,
  opts: { platform?: NodeJS.Platform; run?: BrowserOpener } = {},
): Promise<number> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? spawnOpener;
  if (platform === "darwin") return run("open", [url]);
  if (platform === "win32") {
    // cmd.exe's `start` re-parses its command line and treats `&` as a command
    // separator, so an unquoted OAuth URL is truncated at the first query param
    // (dropping code_challenge/redirect_uri) even though `url` is a distinct argv
    // element. Wrap the URL in quotes so cmd sees ONE token, and pass the args
    // verbatim so Node does not re-escape those quotes. The empty "" is the
    // (required) window-title arg so `start` does not treat the quoted URL as the
    // title. A real Windows prod login hit this: only `?state=...` reached Console.
    return run("cmd", ["/c", "start", '""', `"${url}"`], {
      windowsVerbatimArguments: true,
    });
  }
  // Linux / *BSD: try xdg-open, then sensible-browser, then $BROWSER.
  const candidates = ["xdg-open", "sensible-browser"];
  const envBrowser = process.env.BROWSER;
  if (envBrowser && envBrowser.trim().length > 0) candidates.push(envBrowser.trim());
  for (const cmd of candidates) {
    const code = await run(cmd, [url]);
    if (code === 0) return 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Grant exchange (§4.1). Raw fetch with NO Authorization header. We deliberately
// bypass http.ts's doFetch (which always stamps `Authorization: Bearer`) because
// control rejects this endpoint with 400 unexpected_authorization_header if any
// Authorization header is present (§0.01 clause 1).
// ---------------------------------------------------------------------------

export async function exchangeGrant(
  controlUrl: string,
  code: string,
  codeVerifier: string,
  timeoutMs = 15000,
): Promise<TokenBundle> {
  const url = `${controlUrl.replace(/\/+$/, "")}/internal/v1/auth/cli-login-grants/exchange`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      // Content-Type only; explicitly NO Authorization header.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Body may name the failure (e.g. invalid_or_expired); surface it without
      // echoing the request (which holds the code + verifier).
      throw new Error(
        `Grant exchange failed: HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Grant exchange returned a non-JSON response.");
    }
    return assertTokenBundle(parsed);
  } finally {
    clearTimeout(timer);
  }
}

// Minimal structural validation so we never persist a corrupt user-token config.
function assertTokenBundle(value: unknown): TokenBundle {
  const b = value as Partial<TokenBundle> | null;
  if (
    !b ||
    typeof b.accessToken !== "string" ||
    !b.accessToken ||
    typeof b.refreshToken !== "string" ||
    !b.refreshToken ||
    typeof b.sessionId !== "string" ||
    !b.user ||
    typeof (b.user as LoginUser).id !== "string" ||
    !b.workspace ||
    typeof (b.workspace as LoginWorkspace).id !== "string"
  ) {
    throw new Error("Grant exchange response was missing required token/identity fields.");
  }
  return b as TokenBundle;
}

// ---------------------------------------------------------------------------
// Orchestration: runBrowserLogin (public) / runLoopbackLogin (internal).
// ---------------------------------------------------------------------------

function buildAuthUrl(consoleUrl: string, args: {
  state: string;
  challenge: string;
  port: number;
}): URL {
  const authUrl = new URL(`${consoleUrl.replace(/\/+$/, "")}/cli/authorize`);
  authUrl.searchParams.set("state", args.state);
  authUrl.searchParams.set("code_challenge", args.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("redirect_uri", `http://127.0.0.1:${args.port}/callback`);
  authUrl.searchParams.set("client_id", "mla");
  authUrl.searchParams.set("machine_hint", os.hostname());
  authUrl.searchParams.set("os", `${os.type()} ${os.release()}`);
  return authUrl;
}

// A rejecting timer with a cancel handle so the winning branch of Promise.race
// can clear it (otherwise the timer keeps the event loop alive for 5 minutes).
function rejectingTimeout(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export interface BrowserLoginOptions {
  controlUrl: string;
  // Already-resolved Console override (--console-url / cfg.consoleUrl /
  // MEETLESS_CONSOLE_URL). When absent, inferred from controlUrl.
  consoleUrl?: string;
  // --no-browser: print the URL instead of spawning a browser (SSH / headless).
  // Still the loopback flow, NOT device-code.
  noBrowser?: boolean;
  // Fixed loopback port (§6.6). Required by the command layer when noBrowser is
  // set (the SSH `-L` forward must target a known port); ignored otherwise, where
  // port 0 lets the kernel pick a free port.
  port?: number;
  timeoutMs?: number; // default 5 minutes
  // Injectable seams for tests (default to the real implementations).
  log?: (msg: string) => void;
  openBrowserFn?: (url: string) => Promise<number>;
  exchangeFn?: (controlUrl: string, code: string, codeVerifier: string) => Promise<TokenBundle>;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export async function runBrowserLogin(opts: BrowserLoginOptions): Promise<TokenBundle> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const openBrowserFn = opts.openBrowserFn ?? openBrowser;
  const exchangeFn = opts.exchangeFn ?? exchangeGrant;
  const timeoutMs = opts.timeoutMs ?? FIVE_MINUTES_MS;

  const consoleUrl = (opts.consoleUrl && opts.consoleUrl.trim()) || consoleUrlFromControl(opts.controlUrl);
  if (!consoleUrl) {
    throw new Error(
      `Could not infer the Console URL from control URL "${opts.controlUrl}". ` +
        "Pass --console-url <url> (or set consoleUrl in cli-config.json / MEETLESS_CONSOLE_URL).",
    );
  }

  return runLoopbackLogin(opts.controlUrl, consoleUrl, {
    noBrowser: opts.noBrowser ?? false,
    port: opts.port,
    timeoutMs,
    log,
    openBrowserFn,
    exchangeFn,
  });
}

async function runLoopbackLogin(
  controlUrl: string,
  consoleUrl: string,
  deps: {
    noBrowser: boolean;
    port?: number;
    timeoutMs: number;
    log: (msg: string) => void;
    openBrowserFn: (url: string) => Promise<number>;
    exchangeFn: (controlUrl: string, code: string, codeVerifier: string) => Promise<TokenBundle>;
  },
): Promise<TokenBundle> {
  const { verifier, challenge } = generatePkce();
  const state = generateState();

  const { server, port, callbackPromise } = await openLoopbackServer({ state, port: deps.port });
  const authUrl = buildAuthUrl(consoleUrl, { state, challenge, port }).toString();
  const timer = rejectingTimeout(deps.timeoutMs, "Authorization timed out after 5 minutes.");

  try {
    if (deps.noBrowser) {
      deps.log("Open this URL in a browser on this machine to authorize:");
      deps.log(`  ${authUrl}`);
    } else {
      deps.log(`Opening browser to ${authUrl}`);
      const exit = await deps.openBrowserFn(authUrl);
      if (exit !== 0) {
        // Soft fallback within the loopback flow (NOT device-code): the browser
        // could not be launched, so print the URL and keep listening.
        deps.log("Could not open a browser automatically. Open this URL manually:");
        deps.log(`  ${authUrl}`);
      }
    }
    deps.log("Waiting for authorization (up to 5 minutes)...");

    const { code } = await Promise.race([callbackPromise, timer.promise]);
    // Exchange the one-time code + PKCE verifier for tokens. No Authorization
    // header (§0.01 clause 1). NEVER log `code` or `verifier`.
    const bundle = await deps.exchangeFn(controlUrl, code, verifier);
    return bundle;
  } finally {
    timer.cancel();
    server.close();
  }
}
