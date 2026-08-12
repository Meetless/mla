import * as path from "path";
import { spawnSync } from "child_process";
import { readConfig, type CliConfig, type KbCliConfig } from "../lib/config";
import {
  resolveWorkspaceContext,
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
} from "../lib/workspace";
import { fetchOnboardingStatus } from "../lib/enrichment/onboarding-status-client";
import { seedWorkspaceInstructions, type SeedOutcome } from "../lib/enrichment/seed-workspace";
import {
  emitOnboardingOffer,
  type OnboardingOfferInput,
} from "../lib/analytics/onboarding-offer";
import type { OnboardingOfferCorpusState } from "../lib/analytics/envelope";

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
// In EVERY logged-in, activated case (including both silent ones) the corpus
// synchronization runs first and independently; only the sentence is conditional.
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
  /** The deterministic bind-time seed (P0-1). Injected so a test never reaches git or intel. */
  seedWorkspace?: (cwd: string, workspaceId: string, cfg: CliConfig) => Promise<SeedOutcome>;
  /** The offer telemetry seam (P0-3). Injected so a test can assert the row without a spool. */
  emitOffer?: (input: OnboardingOfferInput) => void;
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

// Spoken once the deterministic seed has actually INDEXED this repository's own written
// instructions. Deliberately not "governed": that is the authority word, it is what a human
// review confers, and it is the one thing this path does not do. Calling born-PENDING material
// governed tells the agent the corpus carries team authority it was never granted.
// It replaces the chore above with a state change, which is the whole point
// of P0-1: the workspace stopped being un-answerable without anybody being asked to do anything.
//
// Three things it must say and keep saying:
//   1. retrieval WORKS now, so the agent stops reading empty as absent.
//   2. the material is PENDING. Serving and trust are different gates (PENDING claims are
//      readable on every surface by design), and blurring that is how an unreviewed line starts
//      reading as team authority.
//   3. what is still MISSING. Instruction files are what the repo wrote down; decisions and the
//      reasoning behind them are not in them, and that is what the scouts are for. Onboarding is
//      reframed from the doorway into the product to the enrichment step after it.
function seededMsg(documents: number): string {
  const plural = documents === 1 ? "" : "s";
  return (
    `Meetless just indexed ${documents} agent-instruction file${plural} from this repository, ` +
    "with no model and no review, and shared them with the workspace. `retrieve_knowledge` can " +
    "now answer from this repo's own written rules, so stop treating an empty result here as " +
    "proof a fact is unrecorded. This material is PENDING: retrievable and citable, NOT accepted " +
    "as team authority until a human reviews it. It also covers only what is written DOWN. For " +
    "the decisions behind the rules and the history that changed them, run `/mla onboard` (two " +
    "read-only scouts read the docs and git log; nothing is accepted automatically)."
  );
}

// The steady state after a seed: this checkout's instruction files are already governed and
// unchanged, but the workspace has still never had an onboarding run. Distinct from the message
// above because repeating "just indexed N files" every session would be a lie by the second one.
// P2-6: what teammate number two sees. Their sync ingested their own private copies, found a
// teammate already shares each file, and retracted them, so they added nothing durable and must
// not be told they did. Same gate, opposite feeling: the workspace is already answerable.
const SHARED_BY_TEAMMATE_MSG =
  "This repository's agent-instruction files are already indexed and shared with this workspace " +
  "by a teammate, so `retrieve_knowledge` can answer from them right now; an empty result is a " +
  "miss, not proof a fact is unrecorded. They are PENDING: retrievable, not accepted as team " +
  "authority until a human reviews them. What is still missing is everything NOT written down " +
  "in them: the decisions behind the rules and the history that changed them. Run `/mla onboard` " +
  "to index that too; nothing is accepted automatically.";

const SEEDED_PRIOR_MSG =
  "This repository's agent-instruction files are already indexed and retrievable in Meetless, " +
  "so `retrieve_knowledge` can answer from them; an empty result is a miss, not proof a fact is " +
  "unrecorded. They are PENDING: retrievable, not accepted as team authority until a human " +
  "reviews them. What is still missing is everything NOT written down in them: the decisions " +
  "behind the rules and the history that changed them. Run `/mla onboard` to index that too; " +
  "nothing is accepted automatically.";

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

// The real seams, kept out of the handler so the handler reads as policy and the wiring stays
// one line each. Both are fail-soft at their own layer as well: belt and braces, because this
// path runs before every session and a throw here is a broken session start, not a lost metric.
async function defaultSeedWorkspace(
  cwd: string,
  workspaceId: string,
  cfg: CliConfig,
): Promise<SeedOutcome> {
  return seedWorkspaceInstructions({ cwd, workspaceId, cfg });
}

// The workspace id is carried on the input rather than re-resolved here: the handler already
// holds the id from the RESOLVED marker, and re-deriving it from cli-config would attribute the
// row to the home workspace whenever this repo binds a different one.
function makeDefaultEmitOffer(workspaceId: string) {
  return (input: OnboardingOfferInput): void => {
    emitOnboardingOffer(input, {
      workspaceId,
      sessionId: (process.env.CLAUDE_CODE_SESSION_ID || "").trim() || null,
      nowMs: Date.now(),
    });
  };
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
    // ---- SYNCHRONIZE FIRST, and independently of the probe below -------------
    //
    // This is the ONLY trigger that reaches a workspace already past `mla activate`: hooks gate
    // on an existing `.meetless.json` and only activate writes one, so there is no hook-driven
    // bind to hang a seed on. `activate` is an EDGE; this is the LEVEL.
    //
    // It runs BEFORE the probe and does not read its answer, because the two answer different
    // questions with different failure modes. "Are this checkout's instruction files in the
    // corpus?" is a LOCAL receipt-versus-scan diff that costs one `git ls-files` and one file
    // read in steady state. "Has this workspace ever run agentic onboarding?" is a remote lookup
    // on a 2500ms budget that was sized, in its own comment, for deciding whether to print one
    // paragraph. Hanging the corpus off that budget meant a slow intel silently cost us the
    // corpus; and gating on `onboarded === false` meant that once `/mla onboard` had ever run,
    // a CLAUDE.md added next week would never be picked up at all.
    //
    // The fix is the decoupling, not a bigger timeout: the probe now decides COPY and nothing else.
    const seed = deps.seedWorkspace ?? defaultSeedWorkspace;
    let outcome: SeedOutcome | null = null;
    try {
      outcome = await seed(cwd, ctx.workspaceId, cfg);
    } catch {
      // A nudge is not a gate. An unreachable intel costs the user nothing and retries next
      // session; the workspace is simply still dark, and the copy below says so.
      outcome = null;
    }

    // ---- then decide what, if anything, to SAY --------------------------------
    // Tri-state, and ONLY an affirmative `false` speaks. `null` (offline, 5xx,
    // timeout) is silence: a nudge is not a gate, and failing quiet is what keeps a
    // network hiccup from becoming a nag on every session. Silence here no longer
    // means nothing happened; the sync above already ran.
    const everOnboarded = deps.workspaceEverOnboarded ?? defaultWorkspaceEverOnboarded;
    let onboarded: boolean | null = null;
    try {
      onboarded = await everOnboarded(ctx.workspaceId, cfg);
    } catch {
      onboarded = null;
    }
    if (onboarded === false) {
      // What WE durably added, counted off what was SHARED rather than off what was added.
      // Adding is not the achievement: a document that lands and then fails to promote is
      // invisible to the team, and a teammate's copy is retracted outright. Measured live, a
      // teammate whose receipt was lost produced ingested+noop = 2 with nothing shared at all,
      // and counting the add would have claimed two indexed files for a run that achieved none.
      const landed = outcome ? outcome.shared : 0;
      // Files this checkout did not have to add because the corpus already answers for them:
      // ours from a previous session, a teammate's shared copy, or a path we have abandoned.
      const alreadySeeded = outcome
        ? outcome.unchanged + outcome.redundant + outcome.blocked
        : 0;
      const corpusState: OnboardingOfferCorpusState =
        landed > 0 ? "seeded" : alreadySeeded > 0 ? "seeded_prior" : "dark";
      // Within `seeded_prior`, a teammate's shared corpus and our own prior seed are the same
      // product state but different sentences: only one of them can honestly say "a teammate".
      const sharedByTeammate = (outcome?.redundant ?? 0) > 0 && landed === 0;

      // P0-3, emitted BEFORE the message so a fault in rendering cannot cost us the row, and
      // wrapped so a fault in the row cannot cost us the session.
      try {
        (deps.emitOffer ?? makeDefaultEmitOffer(ctx.workspaceId))({
          surface: "session_start",
          corpusState,
          seededDocuments: landed,
          instructionFilesPresent: landed + alreadySeeded,
          // A seed that failed and a repo with nothing to seed are both zero documents and
          // demand opposite fixes, so they must not collapse into one row.
          seedFailed: outcome === null || outcome.failed > 0,
        });
      } catch {
        /* telemetry must never fail the session start it observes */
      }

      log(
        additionalContext(
          corpusState === "seeded"
            ? seededMsg(landed)
            : corpusState === "seeded_prior"
              ? sharedByTeammate
                ? SHARED_BY_TEAMMATE_MSG
                : SEEDED_PRIOR_MSG
              : NEVER_ONBOARDED_MSG,
        ),
      );
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
