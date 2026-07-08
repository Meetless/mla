import * as path from "path";
import { spawnSync } from "child_process";
import { readConfig } from "../lib/config";
import {
  resolveWorkspaceContext,
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
} from "../lib/workspace";

// `mla _internal session-nudge`: the SessionStart hook's one-line "Meetless is
// installed but inactive here" explanation.
//
// It lives in the CLI (not in shell) so it reuses the SAME marker resolver as
// `mla mcp` (resolveWorkspaceContext). The hook must NOT reimplement activation
// detection in bash, or the two surfaces would drift on parent-directory scanning
// and malformed markers.
//
// It prints a Claude Code SessionStart `additionalContext` JSON object to stdout
// for a git work tree (scratch dirs and $HOME stay silent), branching on the
// marker state crossed with auth so an activated repo that has gone dark is never
// silent:
//   - no marker (NotActivatedError):     nudge `mla activate` ONLY when logged in.
//       A logged-out user in an unrelated repo has never expressed intent here, so
//       we stay silent (never nag the un-onboarded). Once they activate, intent is
//       durable and the rules below apply.
//   - valid marker, logged out:          nudge `mla login`. The user CHOSE to govern
//       this repo; a logout makes governance dark, which must be visible (the MCP
//       layer already serves a green `mla login` server for the same state).
//   - valid marker, logged in:           silent. The active hook path injects context.
//   - broken marker (no workspaceId):    nudge `mla doctor` regardless of auth; a
//       present-but-broken marker is itself evidence of intent worth repairing.
// In every other case it prints nothing and exits 0. It writes no files, keeps no
// state, and emits once per SessionStart (the hook invokes it once per session).

interface SessionNudgeDeps {
  readConfig?: typeof readConfig;
  resolveWorkspaceContext?: typeof resolveWorkspaceContext;
  isGitRepo?: (dir: string) => boolean;
  log?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
}

function defaultIsGitRepo(dir: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", dir, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  return r.status === 0 && r.stdout.trim() === "true";
}

function parseCwd(argv: string[], fallback: string): string {
  const i = argv.indexOf("--cwd");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return fallback;
}

// Claude Code reads a SessionStart hook's stdout and, when it is this shape,
// injects `additionalContext` into the session.
function additionalContext(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  });
}

const NOT_ACTIVATED_MSG =
  "Meetless is installed but inactive in this repository. No Meetless context is being injected. " +
  "Run `mla activate` to enable it, or `mla doctor` for details.";

const INVALID_MARKER_MSG =
  "Meetless activation is incomplete in this repository. No Meetless context is being injected. " +
  "Run `mla doctor`, then rerun `mla activate` to repair it.";

const LOGGED_OUT_MSG =
  "Meetless is activated in this repository but you are signed out, so no Meetless context is being injected. " +
  "Run `mla login` to resume, or `mla doctor` for details.";

export function runInternalSessionNudge(
  argv: string[],
  deps: SessionNudgeDeps = {},
): number {
  const readCfg = deps.readConfig ?? readConfig;
  const resolveWs = deps.resolveWorkspaceContext ?? resolveWorkspaceContext;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const log = deps.log ?? ((m: string) => process.stdout.write(m + "\n"));
  const env = deps.env ?? process.env;
  const cwd = parseCwd(
    argv,
    env.MEETLESS_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  );

  // Read auth, but do NOT use it to short-circuit: an activated repo that the user
  // has since logged out of still deserves a visible login nudge. Auth only gates
  // the no-marker case below. Any config-read failure -> silent (never break a hook).
  let loggedIn = false;
  try {
    loggedIn = readCfg().auth.mode !== "none";
  } catch {
    return 0;
  }

  // Git repositories only: suppress scratch dirs and $HOME, regardless of auth.
  if (!isGitRepo(cwd)) return 0;

  // Resolve the marker FIRST, then branch on (marker-state x auth). Reusing the
  // MCP's resolver keeps "activated?" meaning EXACTLY the same thing in both
  // surfaces. The key distinction this enables: "logged out in a repo the user
  // activated" (nudge login) vs "logged out in an unrelated repo" (stay silent).
  try {
    resolveWs(cwd);
    // Valid marker: this repo is activated. Logged in -> the active hook path
    // injects context, so we stay silent. Logged out -> governance is dark in a
    // repo the user chose, so surface the login path.
    if (!loggedIn) {
      log(additionalContext(LOGGED_OUT_MSG));
    }
    return 0;
  } catch (e) {
    if (e instanceof NotActivatedError) {
      // No marker: only nudge a logged-in user. A logged-out user in an unrelated
      // repo has never expressed intent here; silence is correct.
      if (loggedIn) {
        log(additionalContext(NOT_ACTIVATED_MSG));
      }
      return 0;
    }
    if (e instanceof MarkerMissingWorkspaceIdError) {
      // A present-but-broken marker is durable evidence of intent to use Meetless
      // here, so surface the repair path regardless of auth.
      log(additionalContext(INVALID_MARKER_MSG));
      return 0;
    }
    // Unanticipated resolver failure: stay silent rather than emit a confusing
    // message into a fresh session.
    return 0;
  }
}
