import * as fs from "fs";
import * as path from "path";

import { readConfig, CliConfig, QUEUE_DIR } from "../lib/config";
import { resolveWorkspaceId } from "../lib/workspace";
import { post } from "../lib/http";
import { captureGitEvidence, GitEvidence } from "../lib/git";

// `mla _internal finalize-session <sessionId>` (§5.2 + Correction 6)
//
// Invoked by flush.sh after it drains a session and observes a
// finalize_requested event. CLI is responsible for git evidence capture
// because hooks must NOT shell out to git (slow + sandbox unpredictability).
//
// Wire: POST /internal/v1/agent-runs/by-session/<sid>/finalize
//   body: { workspaceId, gitEvidence }   (Correction 6: no finalMessage)
//
// Git is opportunistic corroboration, NOT the source of truth (Decision 7,
// note 20260528 §11). The source of truth for what a session changed is the
// coding agent's own text report (captured by stop.sh into
// session_stopped.finalMessage -> agentClaimsRaw). Meetless is a coordination
// layer, not a git forensics tool; we do not reconstruct "what changed" from
// disk state. Git evidence is captured ONLY as supplementary "actuals" when the
// session cwd resolves to a single repo.
//
// We prefer $MEETLESS_REPO_PATH (set by flush.sh from the session_started
// repoPath sidecar) over process.cwd(). When that path is a real repo,
// captureGitEvidence returns the actuals (branch, last commit, changed files,
// diff stat). When it is a non-repo (e.g. a parent folder holding many child
// repos, or a scratch dir), captureGitEvidence returns an empty shell with the
// reason in `errors[]` (`{topLevel: "", errors: ["toplevel:fatal: not a git
// repository"], ...}`). Either way we POST finalize: the worker degrades
// gracefully on empty git, and `errors[]` keeps the absence visible rather than
// silently dropped (preserving Epoch 33's anti-silent-loss intent without the
// hard block).
//
// Why no block: a non-repo cwd is a legitimate, supported setup, not a wrong-cwd
// retry to fix. The earlier guard (Epoch 33) refused to POST on empty topLevel
// and re-spooled finalize_requested, which re-spooled FOREVER in a multi-repo
// parent and wedged the whole review loop. Git absence is now just absence.

// Strict argv parsing for `mla _internal finalize-session` (Wedge v6
// Epoch 53). The internal subcommand is fired by flush.sh on every
// drained session's finalize_requested event:
//
//   "$MLA_PATH" _internal finalize-session "$SESSION_ID"
//
// flush.sh always passes exactly one positional. The CLI's old guard
// was `argv.length < 1` which masked three silent drops if the hook
// is ever invoked with anything other than that exact shape:
//
//   1. `mla _internal finalize-session sid extra` silently dropped
//      "extra". An accidental flush.sh refactor that appended a
//      second positional would silently target one sessionId but
//      look like it accepted two.
//
//   2. `mla _internal finalize-session --foo` bound sessionId="--foo"
//      and the server then 404'd opaquely. A flush.sh template bug
//      that emitted a flag in the SESSION_ID slot (e.g. shell glob
//      expansion gone wrong) would silently 404.
//
//   3. Zero positionals returned exit 2 with the usage line, which
//      is correct -- but the same path is preserved here through
//      the throw + catch convention so it stays symmetric with the
//      other strict parsers.
//
// Strict rules below:
//   - Exactly one positional (sessionId). Zero or two+ throw.
//   - Zero flags supported. Any `--`-prefixed or `-`-prefixed token
//     throws.
export function parseArgs(argv: string[]): { sessionId: string } {
  let sessionId: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`mla _internal finalize-session\` takes no flags, only <sessionId>.`,
      );
    }
    if (sessionId !== undefined) {
      throw new Error(
        `Unexpected extra positional argument: ${a}. \`mla _internal finalize-session\` takes exactly one sessionId.`,
      );
    }
    sessionId = a;
  }
  if (sessionId === undefined) {
    throw new Error("usage: mla _internal finalize-session <sessionId>");
  }
  return { sessionId };
}

// The finalize core, extracted so it can be fired by more than the Stop hook.
//
// Two callers share it:
//   1. `mla _internal finalize-session` (this file's runInternalFinalize),
//      driven by flush.sh on the Stop hook's finalize_requested event.
//   2. `mla review` (Phase 7 / PATCH 5 / INV-M6,
//      notes/20260604-mla-mission-and-review-packet-rethink.md), which fires
//      this on demand so a review snapshot is produced WITHOUT waiting for a
//      Stop signal that, in practice, never cleanly arrives. The Stop-hook
//      finalize is now one trigger among several, not the sole producer.
//
// Captures git evidence (opportunistic corroboration, never the source of truth)
// and POSTs the finalize. Returns both the evidence and the resolved repoPath so
// the caller can tailor its own logging. Idempotent on runId server-side, so it
// is safe to re-fire on every `mla review` (the rolling-snapshot model). Carries
// no mission (PR1) and tolerates branch = null (INV-M1): a detached-HEAD / non-
// repo checkout yields an empty branch and the finalize still proceeds.
export async function triggerSessionFinalize(
  sessionId: string,
  cfg: CliConfig,
): Promise<{ git: GitEvidence; repoPath: string; workspaceId: string }> {
  // Repo resolution ladder, mirroring flush.sh so both finalize callers agree:
  //   1. $MEETLESS_REPO_PATH  -- the Stop-hook path: flush.sh exports it from the
  //      <sid>.repoPath sidecar before invoking `mla _internal finalize-session`.
  //   2. <sid>.repoPath sidecar -- the on-demand `mla review` path (Phase 7 /
  //      INV-M6) has no flush.sh wrapper to set the env var, so it reads the
  //      sidecar directly. Without this rung, on-demand finalize captured git
  //      evidence from whatever directory the human happened to type `mla review`
  //      in, and the rolling-snapshot finalize OVERWROTE the run with wrong-repo
  //      (or empty) evidence. Since Phase 7 assumes a clean Stop never arrives,
  //      that on-demand capture may be the only git evidence the run ever gets.
  //   3. process.cwd() -- legacy fallback for a session with no sidecar (started
  //      before session-start.sh wrote one), preserving the original behavior.
  const envRepoPath = process.env.MEETLESS_REPO_PATH;
  let repoPath: string;
  if (envRepoPath && envRepoPath.length > 0) {
    repoPath = envRepoPath;
  } else {
    let sidecarRepoPath: string | null = null;
    try {
      const raw = fs.readFileSync(
        path.join(QUEUE_DIR, `${sessionId}.repoPath`),
        "utf8",
      ).trim();
      sidecarRepoPath = raw.length > 0 ? raw : null;
    } catch {
      sidecarRepoPath = null;
    }
    repoPath = sidecarRepoPath ?? process.cwd();
  }

  // Folder = workspace (T1.1): the run belongs to the workspace bound to the
  // SESSION REPO, resolved from the nearest `.meetless.json` marker walking up
  // from repoPath -- NOT from process.cwd(). The Stop-hook path runs this via
  // flush.sh, which is nohup-spawned and whose cwd is usually $HOME, so cwd is
  // not the repo; repoPath (env -> sidecar -> cwd ladder above) is. Both finalize
  // callers therefore agree on the workspace the same way they agree on git
  // evidence: through the one resolved repo path. An unactivated repo (no marker)
  // throws NotActivatedError here -- finalize cannot name a workspace to the
  // server, so it correctly does not POST a half-bound run.
  const workspaceId = resolveWorkspaceId(repoPath);

  // Read the session-start git baseline sidecar (written by session-start.sh).
  // Subtracting it makes captureGitEvidence attribute only session-touched
  // changes, not ambient dirty state the tree carried before the agent ran.
  // Absent sidecar (older session, or session-start hook never ran) => null =>
  // original whole-tree behavior, so this is fully backward-compatible.
  const baselinePath = path.join(QUEUE_DIR, `${sessionId}.gitBaseline`);
  let baseline: string | null = null;
  try {
    baseline = fs.readFileSync(baselinePath, "utf8");
  } catch {
    baseline = null;
  }
  const git = captureGitEvidence(repoPath, baseline);

  await post(
    cfg,
    `/internal/v1/agent-runs/by-session/${encodeURIComponent(sessionId)}/finalize`,
    {
      workspaceId,
      gitEvidence: git as unknown as Record<string, unknown>,
    },
    15000,
  );

  return { git, repoPath, workspaceId };
}

export async function runInternalFinalize(argv: string[]): Promise<number> {
  let sessionId: string;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  // Folder = workspace (T1.1): credentials only here. The run's workspaceId is
  // resolved INSIDE triggerSessionFinalize from the `.meetless.json` marker
  // at/above the resolved session repo path (NOT process.cwd()), because flush.sh
  // is nohup-spawned and runs this from $HOME -- cwd is not the repo.
  const cfg = readConfig();

  const { git, repoPath } = await triggerSessionFinalize(sessionId, cfg);

  if (!git.topLevel) {
    console.log(
      `Finalize accepted for session ${sessionId} (no git corroboration: ${repoPath} is not a single repo; ` +
        `agent report remains the source of truth).`,
    );
  } else {
    console.log(`Finalize accepted for session ${sessionId}.`);
  }
  return 0;
}
