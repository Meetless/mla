import {
  CFG_PATH,
  CliAuth,
  CliConfig,
  DEFAULT_CONTROL_URL,
  DEFAULT_INTEL_URL,
  configExists,
  readConfig,
  writeConfig,
} from "../lib/config";
import { get, HttpError } from "../lib/http";
import { clearAuthBreaker } from "../lib/auth-breaker";
import { runBrowserLogin, TokenBundle } from "../lib/login";
import { resolveMlaPath } from "../lib/wire";

// Injectable seams (T29 self-heal). Production wiring is the defaults below; tests
// substitute fakes to exercise the dead-session / live-session / offline branches
// without a real control server or browser. `verifySession` resolves when the
// session is genuinely live and REJECTS (with an HttpError carrying `.status`) when
// control rejects it; `browserLogin` runs the loopback OAuth flow.
export interface LoginDeps {
  verifySession?: (cfg: CliConfig) => Promise<void>;
  browserLogin?: typeof runBrowserLogin;
}

// Default liveness probe: GET /internal/v1/auth/me through the control `get`
// helper, which already does the §6.5 refresh-on-401 dance. A genuinely live
// session (or one the access token silently refreshes for) resolves; a session
// whose refresh token is dead server-side rejects with HttpError.status === 401.
async function defaultVerifySession(cfg: CliConfig): Promise<void> {
  await get(cfg, "/internal/v1/auth/me");
}

// `mla login` (proposal §6.6, T24).
//
// Browser-based user login over the loopback OAuth + PKCE flow (the transport
// lives in lib/login.ts, T21). This command is the thin policy layer on top:
//   - refuses to run before `mla init` (no cli-config.json to write into);
//   - is a no-op when already logged in with a comfortably-fresh refresh token;
//   - resolves the Console URL by an explicit precedence ladder;
//   - validates the --no-browser / --port pairing;
//   - on success REPLACES auth.* in cli-config.json with the user-token shape
//     (the prior shared-key value is NOT preserved, §6.6); `mla logout` is the
//     only path back to shared-key, via a fresh `mla init --control-token`.
//
// SECURITY: this command never logs the access token, refresh token, grant code,
// or PKCE verifier. It prints only identity (display name / email / workspace)
// and the (non-secret) expiry timestamps.

// `mla login` is a no-op when the live user-token's refresh window still has
// more than this much runway. Below it (or any other mode), we re-run the flow.
// Mirrors §6.6: "more than 24h remaining".
const REFRESH_FRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface LoginFlags {
  noBrowser?: boolean;
  consoleUrl?: string;
  port?: number;
  force?: boolean;
}

// Strict argv parsing, mirroring `mla init`'s VALUE_FLAGS/BOOLEAN_FLAGS shape
// (init.ts): a value flag must be followed by a non-flag value; unknown flags
// and positionals throw. `mla login` takes no positionals.
const VALUE_FLAGS = new Set(["--console-url", "--port"]);
// --force skips every no-op/self-heal short-circuit and runs the browser flow
// unconditionally (escape hatch for "just re-mint my tokens").
const BOOLEAN_FLAGS = new Set(["--no-browser", "--force"]);

export function parseLoginArgs(argv: string[]): LoginFlags {
  const out: LoginFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      if (v.startsWith("--") || v.startsWith("-")) {
        throw new Error(
          `Missing value for ${a} (got the next flag ${v} instead)`,
        );
      }
      if (a === "--console-url") {
        out.consoleUrl = v;
      } else if (a === "--port") {
        const port = Number(v);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(
            `Invalid --port value "${v}": expected an integer in 1..65535.`,
          );
        }
        out.port = port;
      }
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--no-browser") out.noBrowser = true;
      else if (a === "--force") out.force = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla login\` takes no positional arguments.`,
    );
  }
  return out;
}

// Resolve the Console origin by the §6.6 precedence ladder, stopping at the first
// defined value: --console-url > MEETLESS_CONSOLE_URL > raw cfg.consoleUrl. When
// all three are absent this returns undefined and runBrowserLogin infers the
// origin from the control URL via its pair table (failing loud if no pair
// matches). We deliberately read the RAW `cfg.consoleUrl`, NOT getConsoleUrl():
// the latter defaults to localhost:3000 and would mask the pair-table inference
// (and silently point login at the wrong origin for a prod control URL).
function resolveConsoleOverride(flags: LoginFlags, cfg: CliConfig): string | undefined {
  const fromFlag = flags.consoleUrl?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.MEETLESS_CONSOLE_URL?.trim();
  if (fromEnv) return fromEnv;
  const fromCfg = cfg.consoleUrl?.trim();
  if (fromCfg) return fromCfg;
  return undefined;
}

// Map control's exchange bundle into the on-disk user-token credential. Only the
// four display fields of `user` survive: role here is display-only (§4.6); every
// authorization decision re-reads the live WorkspaceUser.role server-side.
function bundleToUserTokenAuth(bundle: TokenBundle): Extract<CliAuth, { mode: "user-token" }> {
  return {
    mode: "user-token",
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    accessExpiresAt: bundle.accessExpiresAt,
    refreshExpiresAt: bundle.refreshExpiresAt,
    sessionId: bundle.sessionId,
    user: {
      id: bundle.user.id,
      displayName: bundle.user.displayName,
      email: bundle.user.email,
      role: bundle.user.role,
    },
  };
}

// Best-effort humanizer for "how much runway is left" on an ISO expiry. Returns
// null for an unparseable/empty timestamp so callers can degrade gracefully.
function formatRemaining(iso: string): string | null {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `in ~${hours}h`;
  return `in ~${Math.floor(hours / 24)}d`;
}

// The shared "you're still logged in" message. Pulled out so the fast path, the
// verify-confirmed path, and the offline-fallback path all print identically.
function printAlreadyLoggedIn(auth: Extract<CliAuth, { mode: "user-token" }>): void {
  const who = auth.user.displayName || auth.user.id;
  const email = auth.user.email ? ` <${auth.user.email}>` : "";
  const runway = formatRemaining(auth.refreshExpiresAt);
  console.log(`Already logged in as ${who}${email}.`);
  console.log(
    `  Session expires ${runway ?? "soon"} (run \`mla login --force\` to re-login).`,
  );
}

// What a failed liveness probe means for `mla login`'s no-op short-circuit.
//   "keep"   -> we could not reach control for a verdict; keep the cached
//               session and do NOT open a browser (offline, or control up but
//               erroring on a concrete non-auth status).
//   "reauth" -> the session may be invalid, or a transient/contended check
//               prevented confirmation; open a real browser login rather than
//               declaring "already logged in".
export type ProbeVerdict = "keep" | "reauth";

// Classify why `GET /internal/v1/auth/me` failed during the login no-op probe.
//
// The critical case is RefreshBusyError (see lib/http.ts): `get()` funnels EVERY
// transient refresh failure into it. A sibling mla process (hook / MCP worker)
// holding the single-use refresh lock, the server's dead-session 429 rate limit,
// and a transient 5xx/network blip on the refresh POST all surface as a
// RefreshBusyError that carries NO HTTP `.status`. The old code lumped that into
// the "no status -> offline, keep cached" branch, so `mla login` would print
// "already logged in (could not verify)" and exit WITHOUT opening the browser,
// exactly the intermittent "didn't open the browser" report. None of those
// signals prove the session is live, so we re-authenticate instead of no-op'ing.
//
// A genuinely dead session is distinguishable: its refresh is REJECTED (401/410)
// and surfaces here as a 401 (authExpiredError), which we also route to reauth.
export function classifyProbeFailure(err: HttpError): ProbeVerdict {
  // Session rejected server-side: definitely re-authenticate.
  if (err.status === 401 || err.status === 403) return "reauth";
  // Refresh contention / throttle / transient refresh failure (no HTTP status).
  // Not proof of a live session -> re-authenticate rather than suppress the browser.
  if (err.name === "RefreshBusyError") return "reauth";
  // A concrete non-auth HTTP status (control reachable but erroring): keep the
  // cached session; an OAuth exchange would hit the same broken control.
  if (typeof err.status === "number") return "keep";
  // No status, not a known contention signal: the client never reached control
  // (offline / DNS / connection refused). Keep the cached session.
  return "keep";
}

export async function runLogin(argv: string[], deps: LoginDeps = {}): Promise<number> {
  const verifySession = deps.verifySession ?? defaultVerifySession;
  const browserLogin = deps.browserLogin ?? runBrowserLogin;
  let flags: LoginFlags;
  try {
    flags = parseLoginArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // --no-browser needs a fixed loopback port: the browser runs on a different
  // machine (SSH), so the operator forwards `ssh -L <port>:127.0.0.1:<port>`
  // ahead of time and the redirect_uri must target that known port (§6.6). With
  // a browser on this machine, port 0 (kernel-assigned) is correct.
  if (flags.noBrowser && flags.port === undefined) {
    console.error(
      "--port <n> is required with --no-browser: the loopback redirect must " +
        "target a port you have forwarded (e.g. `ssh -L 8765:127.0.0.1:8765`).",
    );
    return 2;
  }

  // `mla login` writes INTO cli-config.json. When none exists yet (a fresh
  // install that goes straight to `mla login`, which is the documented flow on
  // the install page), bootstrap a minimal MACHINE config pointing at the hosted
  // prod backend, then carry on -- so login works with zero extra steps instead
  // of dead-ending on "run `mla init` first".
  //
  // Multi-repo safety: this is HOME-level (one cli-config.json per MEETLESS_HOME,
  // shared by every repo on the machine, the long-standing model) and writes NO
  // per-folder workspace binding. A user with several repos still binds each one
  // to its own workspace through its `.meetless.json` marker (`mla activate`);
  // login never reads or writes that, so it is correct from any directory. The
  // bootstrap is idempotent: it fires only when the config is absent, so a second
  // `mla login` from another repo just reads the existing config.
  //
  // It deliberately does NOT wire capture hooks or the MCP server (that is
  // `mla init`'s runWire job, §6.6) -- it only creates the config the browser
  // login writes tokens into. A non-default backend (dogfood/staging/self-host)
  // is still pinned with `mla init --control-url ...`; MEETLESS_BACKEND_URL /
  // MEETLESS_INTEL_URL continue to override these defaults at read time
  // (readConfig), so a one-off `MEETLESS_BACKEND_URL=... mla login` still works.
  if (!configExists()) {
    writeConfig({
      controlUrl: DEFAULT_CONTROL_URL,
      controlToken: "", // auth.mode 'none': no bearer until the login below
      intelUrl: DEFAULT_INTEL_URL,
      mlaPath: resolveMlaPath(),
      auth: { mode: "none" },
    });
    console.log(
      `No cli-config.json found; created ${CFG_PATH} for the hosted backend ` +
        `(${DEFAULT_CONTROL_URL}).`,
    );
    console.log(
      "Tip: run `mla init` to wire capture hooks and the Meetless MCP server " +
        "into your coding agent.",
    );
  }

  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    // readConfig throws loudly on a corrupt config or the Gate-4 env conflict
    // (user-token on disk + MEETLESS_CONTROL_TOKEN set). Surface it verbatim.
    console.error((e as Error).message);
    return 1;
  }

  // No-op when already logged in with a comfortably-fresh refresh token. Forcing
  // a re-login is `mla login --force` (or `mla logout && mla login`). A corrupt/
  // empty refreshExpiresAt parses to NaN, so this guard safely falls through to a
  // real login rather than mis-treating a broken session as fresh.
  //
  // T29 self-heal: NO local timestamp is proof the session is alive. The on-disk
  // refresh token can be dead server-side (rotated/revoked) while refreshExpiresAt
  // still reads ~Nd out, AND the access JWT can sit well inside its 24h TTL while
  // the session it belongs to was revoked (e.g. a control-dev reseed). The original
  // T29 trusted a still-live access token and fast-no-op'd without probing, so An
  // hit the exact closed loop it was meant to kill: every hook 401'd telling him to
  // "run `mla login`", and `mla login` answered "already logged in" all day. So we
  // NEVER short-circuit on a local timestamp alone:
  //   - refresh window locally-fresh -> ALWAYS PROBE control (GET /auth/me, which
  //       refreshes transparently). Live -> no-op. Rejected (401/403) -> the session
  //       is dead server-side: fall through to a real browser login (self-heal).
  //       Unreachable (network error, no .status) -> keep the cached session rather
  //       than force a doomed flow on someone merely offline.
  //   - refresh window locally-expired -> no probe; re-auth is required regardless,
  //       so drop straight through to a browser login.
  //   - --force always re-authenticates and skips the probe entirely.
  if (cfg.auth.mode === "user-token" && !flags.force) {
    const auth = cfg.auth;
    const refreshRemainingMs = Date.parse(auth.refreshExpiresAt) - Date.now();
    const refreshLocallyFresh =
      !Number.isNaN(refreshRemainingMs) && refreshRemainingMs > REFRESH_FRESH_THRESHOLD_MS;
    if (refreshLocallyFresh) {
      // Verify against control before ever declaring "already logged in". login is a
      // rare, interactive command, so one GET /auth/me on the happy path is a non-issue
      // next to the all-day dead loop a blind no-op can hide.
      try {
        await verifySession(cfg);
        printAlreadyLoggedIn(auth);
        return 0;
      } catch (e) {
        if (classifyProbeFailure(e as HttpError) === "keep") {
          // We could not reach control for a verdict: either the client is truly
          // offline (network error / DNS / connection refused) or control is up
          // but erroring on a concrete non-auth status (e.g. 500 on /auth/me).
          // Keep the cached session; opening a browser flow whose token exchange
          // would hit the same wall helps no one.
          printAlreadyLoggedIn(auth);
          console.log(
            "  (could not verify with control; keeping cached session for now.)",
          );
          return 0;
        }
        // verdict === "reauth": the session is dead server-side (401/403), OR a
        // sibling mla process held the refresh lock / the server throttled us
        // (429) / a transient refresh error occurred. None of those prove the
        // session is live, so do NOT silently no-op and suppress the browser
        // (the reported "mla login didn't open the browser" bug). Self-heal by
        // dropping through to a real browser login below.
        console.log(
          "Could not confirm your cached session; re-authenticating...",
        );
      }
    }
  }

  const consoleUrl = resolveConsoleOverride(flags, cfg);

  let bundle: TokenBundle;
  try {
    bundle = await browserLogin({
      controlUrl: cfg.controlUrl,
      consoleUrl,
      noBrowser: flags.noBrowser ?? false,
      port: flags.port,
    });
  } catch (e) {
    // runBrowserLogin already keeps tokens/codes out of its messages. Print the
    // message (timeout, CSRF refusal, exchange failure, missing console URL).
    console.error((e as Error).message);
    return 1;
  }

  const auth = bundleToUserTokenAuth(bundle);
  // REPLACE auth.* outright: no shared-key preservation (§6.6). actorUserId and
  // controlToken are re-derived by writeConfig/readConfig from the new auth.
  writeConfig({
    ...cfg,
    auth,
    controlToken: auth.accessToken,
    actorUserId: auth.user.id,
  });
  // A fresh login retires any dead-auth circuit breaker proactively. consult also
  // self-clears on the fingerprint mismatch, but clearing here reopens the gate
  // for live `mla mcp` workers the instant the new token lands on disk.
  clearAuthBreaker();

  const email = bundle.user.email ? ` <${bundle.user.email}>` : "";
  const accessRunway = formatRemaining(bundle.accessExpiresAt);
  const refreshRunway = formatRemaining(bundle.refreshExpiresAt);
  console.log(`Logged in as ${bundle.user.displayName}${email}.`);
  // An account-only login (no workspace yet) is the NORMAL first-run outcome, not
  // a failure: login creates an Account and nothing else (INV-ACC-3). Say so, and
  // point at the one command that resolves it. `mla whoami` would be a dead end
  // here (nothing workspace-scoped to report), so the next step is `mla activate`.
  if (bundle.workspace) {
    console.log(`  Workspace: ${bundle.workspace.name} (${bundle.workspace.slug})`);
    console.log(`  Role:      ${bundle.user.role}`);
  } else {
    console.log("  Workspace: none yet.");
  }
  console.log(
    `  Access token expires ${accessRunway ?? "soon"}; refresh token ${refreshRunway ?? "soon"}.`,
  );
  console.log(
    bundle.workspace
      ? "Next: mla whoami"
      : "Next: run `mla activate` in your repo to create your first workspace.",
  );
  return 0;
}
