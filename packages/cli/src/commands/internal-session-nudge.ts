import * as path from "path";
import { spawnSync } from "child_process";
import { readConfig, type CliConfig, type KbCliConfig } from "../lib/config";
import {
  resolveWorkspaceContext,
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
} from "../lib/workspace";
import { fetchOnboardingStatus } from "../lib/enrichment/onboarding-status-client";

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
//   - valid marker, logged in, NEVER onboarded: nudge `/mla onboard` (see below).
//   - valid marker, logged in, onboarded/unknown: silent. The active hook path
//       injects context.
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
  workspaceEverOnboarded?: (
    workspaceId: string,
    cfg: CliConfig,
  ) => Promise<boolean | null>;
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

// Addressed to the AGENT, not to the human: the agent is what calls
// retrieve_knowledge, and the failure this prevents is it reading an empty corpus
// as "the fact is not recorded" (the same misread the `corpus_empty` tri-state was
// introduced to stop on the MCP side).
const NEVER_ONBOARDED_MSG =
  "Meetless is activated in this repository, but its governed memory has never been " +
  "seeded from the repo, so `retrieve_knowledge` returns nothing for EVERY query here, " +
  "not just hard ones. Treat an empty result as an onboarding gap, NEVER as evidence " +
  "that a fact is not recorded. Run `/mla onboard` to index this repository: two " +
  "read-only scouts read the docs and git history and surface candidates born PENDING " +
  "for review, and nothing is accepted automatically. This is a one-time step per workspace.";

// How long SessionStart will wait for the onboarding answer. Deliberately far below
// the 10s default the other callers use: this runs before every session, the answer
// only decides whether to print one paragraph, and an unreachable intel must cost the
// user nothing. Timing out lands on `null` (unknown), which is silent.
const ONBOARD_PROBE_TIMEOUT_MS = 2500;

// Has this workspace EVER been onboarded? Tri-state: true / false / null when we could
// not find out. Workspace grain (no headCommit): a commit-grain answer reads false at
// every new HEAD, which would nag forever. The workspaceId comes from the RESOLVED
// marker, not from cli-config, so the question is always about the repo we are in.
async function defaultWorkspaceEverOnboarded(
  workspaceId: string,
  cfg: CliConfig,
): Promise<boolean | null> {
  const kbCfg: KbCliConfig = {
    ...cfg,
    workspaceId,
    actorUserId: cfg.actorUserId ?? "",
  };
  return (
    await fetchOnboardingStatus(kbCfg, { timeoutMs: ONBOARD_PROBE_TIMEOUT_MS })
  ).onboarded;
}

export async function runInternalSessionNudge(
  argv: string[],
  deps: SessionNudgeDeps = {},
): Promise<number> {
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
  let cfg: CliConfig;
  try {
    cfg = readCfg();
  } catch {
    return 0;
  }
  const loggedIn = cfg.auth.mode !== "none";

  // Git repositories only: suppress scratch dirs and $HOME, regardless of auth.
  if (!isGitRepo(cwd)) return 0;

  // Resolve the marker FIRST, then branch on (marker-state x auth). Reusing the
  // MCP's resolver keeps "activated?" meaning EXACTLY the same thing in both
  // surfaces. The key distinction this enables: "logged out in a repo the user
  // activated" (nudge login) vs "logged out in an unrelated repo" (stay silent).
  try {
    const ctx = resolveWs(cwd);
    // Valid marker: this repo is activated. Logged out -> governance is dark in a
    // repo the user chose, so surface the login path and stop (no credential to
    // probe intel with anyway).
    if (!loggedIn) {
      log(additionalContext(LOGGED_OUT_MSG));
      return 0;
    }
    // Logged in. The active hook path injects context, so the only thing left worth
    // saying is that there is nothing TO inject: a workspace that was activated but
    // never onboarded has an empty corpus, and every retrieve_knowledge in this
    // session will come back empty. `mla activate` already hands off to the onboard
    // skill, but that is an EDGE at activation time; a workspace already past it can
    // only be reached here, at SessionStart, which is a LEVEL condition.
    //
    // Tri-state, and ONLY an affirmative `false` speaks. `null` (offline, 5xx,
    // timeout) is silence: a nudge is not a gate, and failing quiet is what keeps a
    // network hiccup from becoming a nag on every session.
    const everOnboarded = deps.workspaceEverOnboarded ?? defaultWorkspaceEverOnboarded;
    let onboarded: boolean | null = null;
    try {
      onboarded = await everOnboarded(ctx.workspaceId, cfg);
    } catch {
      onboarded = null;
    }
    if (onboarded === false) {
      log(additionalContext(NEVER_ONBOARDED_MSG));
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
