import * as path from "path";
import type { CliConfig } from "../lib/config";
import { readConfig } from "../lib/config";
import {
  resolveWorkspaceContext,
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
  type WorkspaceContext,
} from "../lib/workspace";
import {
  makeControlFetchFromCli,
  makeIntelFetchFromCli,
  makeIntelAskFromCli,
  type McpFetch,
  type IntelAskParams,
} from "../lib/mcp-fetchers";
import { makeMcpStaleCheck } from "../lib/staleness";
import { MCP_RESTART_EXIT_CODE, isMcpChild } from "../lib/mcp-restart";
import { installOrphanGuard } from "../lib/orphan-guard";
import { isPackagedBinary } from "../lib/packaged";

// `mla mcp`: boot the Meetless MCP server authenticated as the logged-in human
// (cli-config user-token, auto-refreshing) and scoped to the workspace resolved
// from the nearest `.meetless.json` marker. This replaces the old standalone
// `meetless-mcp` bin, which read a shared service key (MEETLESS_CONTROL_TOKEN /
// INTERNAL_API_KEY) and an env-pinned MEETLESS_WORKSPACE_ID. Now the MCP uses
// the SAME auth(n/z) as the rest of `mla`: no service key, no env workspace pin,
// ACL-scoped to the operator's membership.
//
// Invariant note (refines ask.ts): `mla`'s ASK PATH still never tunnels through
// the MCP. `mla ask` imports @meetless/ask-core directly, and the server here
// also reaches intel via ask-core. This command depends on @meetless/mcp ONLY
// to LAUNCH the server (An: "distribute mla to other users" with the MCP
// in-repo). It is the one sanctioned `mla -> @meetless/mcp` edge, and it is
// launcher-only, not a data path.

/**
 * The ACTIVE-runtime deps shape @meetless/mcp's createMcpServer / runStdioServer
 * consume. `mode: "active"` is the discriminant; an active server always carries a
 * real, non-null `defaultWorkspaceId` (the invariant is preserved by construction,
 * not by a nullable field). The server treats a missing `mode` as active too, so
 * the legacy env path is unaffected.
 */
export interface ActiveMcpServerDeps {
  mode: "active";
  controlFetch: McpFetch;
  intelFetch: McpFetch;
  intelAsk: (params: IntelAskParams) => Promise<unknown>;
  defaultWorkspaceId: string;
  notesRoot: string;
  operatorUserId: string | null;
  agentRuntime: string | null;
  // Per-call probe: returns a one-line warning when this long-lived server now
  // runs code older than the build on disk (rebuild-without-restart), else null.
  // Always present; the server prepends its non-null result to tool responses.
  staleCheck: () => string | null;
  // Self-heal hook for the supervised worker: the server's idle poller calls it
  // once staleCheck reports a newer build, and the worker exits with the restart
  // sentinel so the parent respawns a fresh worker on the new dist. Null for a
  // bare / kill-switched run (no parent to respawn it), where staleCheck only
  // warns inline.
  onStaleRestart: (() => void) | null;
}

/**
 * The structured reason `mla mcp` is serving in status-only mode. Kept structured
 * internally (reason + message + action) even though the MCP renders it as plain
 * text, so doctor, tests, and a future surface can branch on `reason` without
 * parsing prose. No repository path is carried: it would not materially help and
 * would leak an absolute path into tool output.
 */
export interface InactiveStatus {
  state: "inactive";
  reason: "not-activated" | "not-authenticated" | "invalid-activation";
  message: string;
  action: { command: "mla activate" | "mla login" | "mla doctor" };
}

/** Status-only deps: a connected-but-inactive server. Touches no backend. */
export interface InactiveMcpServerDeps {
  mode: "inactive";
  status: InactiveStatus;
}

/**
 * The discriminated runtime the MCP server boots into. `active` carries the real
 * workspace + fetch closures; `inactive` carries only a self-describing status.
 * Genuine/unanticipated failures are deliberately NOT a member here: they stay
 * exceptions and exit nonzero (a red server), per the fail-visible matrix. No
 * `degraded`/`crashed` member yet.
 */
export type McpServerDeps = ActiveMcpServerDeps | InactiveMcpServerDeps;

export interface RunMcpDeps {
  readConfig?: () => CliConfig;
  resolveWorkspaceContext?: (startDir?: string) => WorkspaceContext;
  makeControlFetch?: (cfg: CliConfig) => McpFetch;
  makeIntelFetch?: (cfg: CliConfig) => McpFetch;
  makeIntelAsk?: (cfg: CliConfig) => (params: IntelAskParams) => Promise<unknown>;
  // Builds the spawn-snapshotting staleness probe. Default reads the real
  // dist/build-info.json; injected in tests.
  makeStaleCheck?: () => () => string | null;
  // The server launcher. Default dynamic-imports @meetless/mcp and serves over
  // stdio (long-lived; resolves only when the client disconnects). Injected so
  // the command's guards + wiring are unit-tested without the real transport.
  startServer?: (deps: McpServerDeps) => Promise<unknown>;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  // Exits the worker (default process.exit). Injected so the self-heal hook is
  // unit-tested without tearing down the test runner.
  exit?: (code: number) => void;
  // Installs the worker's death backstops (signal handlers + parent-death
  // watchdog) so an orphaned server does not block on stdin forever. Default is
  // the real installOrphanGuard; tests inject a no-op so the jest process is not
  // littered with real listeners/timers across the many runMcp calls.
  installOrphanGuard?: () => void;
  env?: NodeJS.ProcessEnv;
  startDir?: string;
}

// @meetless/mcp is ESM-only; `mla` compiles to CommonJS. It ships as a CJS
// bundle (scripts/bundle-esm.js -> dist/bundles/mcp.js) so the CLI loads it with
// a plain require(), which the pkg V8 snapshot supports. A true import() does
// NOT work inside the snapshot (no ESM dynamic-import callback) and would die
// with "A dynamic import callback was not specified". The Function constructor
// below preserves a TRUE runtime import() for the dev fallback only (ts-node
// `pnpm dev`, no built dist), where tsc must not downlevel it to require() of an
// ESM package.
const trueDynamicImport = new Function("u", "return import(u)") as (
  u: string,
) => Promise<unknown>;

interface McpModule {
  runStdioServer: (deps: McpServerDeps) => Promise<unknown>;
}

// dist/commands/mcp.js -> dist -> dist/bundles/mcp.js
function mcpBundlePath(): string {
  return path.resolve(__dirname, "..", "bundles", "mcp.js");
}

// Prefer the bundled CJS (require() works in the binary). Fall back to the ESM
// source via a true import() for dev (ts-node), where no dist/bundles exists.
// The fallback never runs inside the binary, where a true import() would throw;
// there a require failure surfaces as-is. Only fall through on a genuine
// "module not found"; a real load error inside the bundle must surface.
async function loadAndServe(deps: McpServerDeps): Promise<unknown> {
  let mod: McpModule;
  try {
    mod = require(mcpBundlePath()) as McpModule;
  } catch (e) {
    if (isPackagedBinary()) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
    mod = (await trueDynamicImport("@meetless/mcp")) as McpModule;
  }
  return mod.runStdioServer(deps);
}

// A spawned MCP server is a daemon: it cannot `cd`, and its launch cwd is
// whatever the client chose, which may sit outside the activated repo. So
// `mla mcp` must NOT blindly trust process.cwd() for marker resolution. Derive
// the start dir from an explicit client signal instead, in priority order:
//   1. an injected startDir (tests, and a future `mla mcp --dir <path>`),
//   2. MEETLESS_PROJECT_DIR  (client-agnostic: any MCP client can pin the repo
//      in its server `env` block),
//   3. CLAUDE_PROJECT_DIR    (Claude Code sets this to the project root for
//      every stdio server it spawns, so CC users get zero-config resolution).
// Falling through to undefined lets resolveWorkspaceContext default to
// process.cwd(), which is correct for an interactive `mla mcp` launch.
function resolveStartDir(
  env: NodeJS.ProcessEnv,
  explicit?: string,
): string | undefined {
  return (
    explicit ?? env.MEETLESS_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? undefined
  );
}

// notesRoot powers ONLY the INDEX.md canonical matcher, which degrades to
// retrieval when absent, so an imperfect guess is non-fatal. Honor an explicit
// override, else derive the standalone notes repo as a sibling of the marker
// repo (projects/<x>/notes for the dogfood layout).
function resolveNotesRoot(
  env: NodeJS.ProcessEnv,
  ctx: WorkspaceContext,
): string {
  if (env.MEETLESS_NOTES_ROOT) return env.MEETLESS_NOTES_ROOT;
  return path.resolve(ctx.markerDir, "..", "notes");
}

function notActivatedStatus(): InactiveStatus {
  return {
    state: "inactive",
    reason: "not-activated",
    message:
      "Meetless is installed but inactive in this repository. No Meetless context is being injected.",
    action: { command: "mla activate" },
  };
}

function notAuthenticatedStatus(): InactiveStatus {
  return {
    state: "inactive",
    reason: "not-authenticated",
    message:
      "Meetless is not logged in, so it is inactive here. No Meetless context is being injected.",
    action: { command: "mla login" },
  };
}

function invalidActivationStatus(): InactiveStatus {
  return {
    state: "inactive",
    reason: "invalid-activation",
    message:
      "Meetless activation is incomplete in this repository. Run `mla doctor`, then rerun `mla activate` to repair it.",
    action: { command: "mla doctor" },
  };
}

// Boot a connected-but-inactive (status-only) server for a KNOWN dormant state.
// The handshake completes (green in Claude Code), only the status tool is
// advertised, and no backend is touched. One stderr breadcrumb is written for
// Claude Code's MCP log so a connected-but-inactive server reads as intentional,
// not a crash; it is a plain log line, not a TTY branch.
async function serveInactive(
  status: InactiveStatus,
  startServer: (deps: McpServerDeps) => Promise<unknown>,
  installGuard: () => void,
  err: (msg: string) => void,
): Promise<number> {
  err(`meetless mcp: inactive (${status.reason}); run \`${status.action.command}\` to enable.`);
  installGuard();
  try {
    await startServer({ mode: "inactive", status });
    return 0;
  } catch (e) {
    err(`meetless mcp server exited with an error: ${(e as Error).message}`);
    return 1;
  }
}

export async function runMcp(
  argv: string[],
  deps: RunMcpDeps = {},
): Promise<number> {
  const readCfg = deps.readConfig ?? readConfig;
  const resolveWs = deps.resolveWorkspaceContext ?? resolveWorkspaceContext;
  const makeControlFetch = deps.makeControlFetch ?? makeControlFetchFromCli;
  const makeIntelFetch = deps.makeIntelFetch ?? makeIntelFetchFromCli;
  const makeIntelAsk = deps.makeIntelAsk ?? makeIntelAskFromCli;
  const makeStaleCheck = deps.makeStaleCheck ?? makeMcpStaleCheck;
  const startServer = deps.startServer ?? loadAndServe;
  const installGuard = deps.installOrphanGuard ?? installOrphanGuard;
  const env = deps.env ?? process.env;
  const err = deps.errorLog ?? ((m: string) => console.error(m));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let cfg: CliConfig;
  try {
    cfg = readCfg();
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  // `none` is terminal for credentials but no longer fatal for the server: boot
  // a status-only server so Claude Code shows a CONNECTED (not red) server that
  // can explain it needs `mla login`.
  if (cfg.auth.mode === "none") {
    return serveInactive(notAuthenticatedStatus(), startServer, installGuard, err);
  }

  let ctx: WorkspaceContext;
  try {
    ctx = resolveWs(resolveStartDir(env, deps.startDir));
  } catch (e) {
    // Known-inactive states: serve a green, status-only server instead of dying
    // red. Distinguish a missing activation (`mla activate`) from a present but
    // broken marker (`mla doctor` to repair).
    if (e instanceof NotActivatedError) {
      return serveInactive(notActivatedStatus(), startServer, installGuard, err);
    }
    if (e instanceof MarkerMissingWorkspaceIdError) {
      return serveInactive(invalidActivationStatus(), startServer, installGuard, err);
    }
    // An unanticipated resolution failure stays fatal (red): we cannot truthfully
    // describe a state we did not expect.
    err((e as Error).message);
    return 2;
  }

  const serverDeps: McpServerDeps = {
    mode: "active",
    // Closures bind the SAME cfg object, so http.ts's in-place token rotation
    // (refreshUserToken) stays visible to every later control / intel call.
    controlFetch: makeControlFetch(cfg),
    intelFetch: makeIntelFetch(cfg),
    intelAsk: makeIntelAsk(cfg),
    defaultWorkspaceId: ctx.workspaceId,
    notesRoot: resolveNotesRoot(env, ctx),
    // Identity is the audited human under user-token; shared-key has none.
    operatorUserId: cfg.auth.mode === "user-token" ? cfg.auth.user.id : null,
    agentRuntime: env.MEETLESS_AGENT_RUNTIME || null,
    // Snapshot the build identity now, at spawn; the probe compares against the
    // on-disk build on every later tool call.
    staleCheck: makeStaleCheck(),
    // Only a supervised child can be respawned, so only it self-heals. A bare /
    // kill-switched run has no parent to come back to, so it leaves this null and
    // relies on the inline staleCheck warning instead.
    onStaleRestart: isMcpChild(argv, env)
      ? () => exit(MCP_RESTART_EXIT_CODE)
      : null,
  };

  // Install the worker's death backstops just before serving. The server below
  // resolves ONLY on stdin EOF; if the client dies without closing the pipe the
  // process would otherwise block forever (reparented to pid 1). Signal handlers
  // + a parent-death watchdog reap it. Applies to BOTH the supervised --child
  // worker and a bare / kill-switched single-process run: in the bare case our
  // direct parent is the client, so its death also flips ppid to 1 and we exit.
  installGuard();

  try {
    // Long-lived: in production this resolves only when the MCP client
    // disconnects (stdin EOF). The entrypoint's process.exit therefore fires
    // after the server is done, never tearing it down mid-session.
    await startServer(serverDeps);
    return 0;
  } catch (e) {
    err(`meetless mcp server exited with an error: ${(e as Error).message}`);
    return 1;
  }
}
