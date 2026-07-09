import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import {
  ACTIVATION_FILENAME,
  ActivationMarker,
  FoundActivation,
  findActivation,
} from "../lib/activation";
import {
  CFG_PATH,
  CliConfig,
  configExists,
  HOOKS_DIR,
  QUEUE_DIR,
  readConfig,
  SESSION_GATE_DIR,
} from "../lib/config";
import { backfillSessionPrompts } from "../lib/transcript-prompts";
import { runLogin } from "./login";
import { get, HttpError, post } from "../lib/http";
import { renderActivationCard, renderBootstrapSummary } from "../lib/scanner/bootstrap-summary";
import { renderManualScoutMission, renderAgenticInvitation } from "../lib/scanner/scout-mission";
import { rescanAndCache } from "./scan-context";
import { removeOwnedProjection } from "../lib/scanner/floor-projection-writer";
import { FLOOR_PROJECTION_RELPATH } from "../lib/scanner/floor-projection";
import { tryResolveWorkspaceId } from "../lib/workspace";
import { detectPluginOwnership } from "../connectors/claude-code/plugin-detect";
import {
  inspectLegacyWiring,
  planLegacyReconcile,
  applyLegacyReconcile,
  legacyWiringPaths,
  defaultReconcileIO,
  type LegacyWiringPaths,
  type ReconcileIO,
  type ReconcileAction,
} from "../connectors/claude-code/plugin-migrate";

// `mla activate` (folder = workspace, T2.1,
// notes/20260604-folder-equals-workspace-binding-design.md)
//
// One workspace per directory. `mla activate`:
//   - with NO marker in the tree, PROVISIONS a new workspace (named after the
//     cwd basename or --name) by POSTing /internal/v1/workspaces, then writes
//     the server-minted id into `.meetless.json`. Marker presence is the
//     unambiguous create-vs-bind signal.
//   - with a marker present (e.g. a teammate cloned the repo), BINDS to the
//     existing id and provisions nothing.
//
// A repo-root guard (INV-FLAGS-1) stops accidental workspace fragments: auto-
// create only fires at a Git repo root. From a Git subdir it refuses unless
// `--here` (the in-Git subdir override); outside Git it refuses unless
// `--create` (the non-Git override). The two flags are never overloaded.
//
// The marker is committable because it is strictly non-secret (it carries an
// opaque workspaceId, never credentials, paths, or actor ids). It is no longer
// auto-gitignored; if a stale `.meetless.json` entry survives in `.gitignore`
// from the old auto-ignore behavior, activate removes it so the user is free to
// commit the marker.
//
// Usage:
//   mla activate [--name <name>] [--note <text>]   (provision-or-bind)
//   mla activate --here                            (in-Git subdir override)
//   mla activate --create                          (non-Git override)
//   mla activate --repair                          (re-check binding health)

// The inventory headline and the full "Active agent instructions" bundle now live
// in the pure scanner-adjacent module so both are testable without the activation
// machinery. Re-exported here because the long-standing card test imports it from
// this command module.
export { renderActivationCard };

// The public bootstrap tiers (notes/20260624-mla-new-user-value-and-brownfield-proof.md,
// Phase 2). Onboarding is consolidated to ONE public flow: `mla activate` (the `fast`
// deterministic scan + review bundle, the long-standing default) then `/mla onboard`
// (the agent-driven deep read). `agentic` survives only as a deprecated alias that
// still prints the static scout mission while steering the operator to `/mla onboard`.
// The old `full` tier (temporal legacy-note graph) was never built; rather than
// silently falling back, it is removed from the CLI and `--bootstrap full` now errors
// with a migration message (no silent under-delivery).
export type BootstrapTier = "fast" | "agentic";
const BOOTSTRAP_TIERS: readonly BootstrapTier[] = ["fast", "agentic"];

interface ActivateFlags {
  name?: string;
  note?: string;
  here?: boolean;
  create?: boolean;
  repair?: boolean;
  bootstrap?: BootstrapTier;
}

const VALUE_FLAGS = new Set(["--name", "--note", "--bootstrap"]);
const BOOLEAN_FLAGS = new Set(["--here", "--create", "--repair"]);

export function parseActivateArgs(argv: string[]): ActivateFlags {
  const out: ActivateFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new Error(`Missing value for ${a}`);
      }
      if (a === "--name") out.name = v;
      else if (a === "--note") out.note = v;
      else if (a === "--bootstrap") {
        // The removed `full` tier gets a migration message, never a silent fallback
        // to a shallower tier (Phase 2: "never silently fall back from a named-but-
        // unbuilt tier").
        if (v === "full") {
          throw new Error(
            "The `full` bootstrap tier was removed: its temporal legacy-note graph was " +
              "never built. The deep, agent-driven read now lives in `/mla onboard` " +
              "(two read-only scouts; candidates land born PENDING for you to review). " +
              "Use `--bootstrap fast` (default) or run `/mla onboard` inside a session.",
          );
        }
        if (!(BOOTSTRAP_TIERS as readonly string[]).includes(v)) {
          throw new Error(
            `Invalid value for --bootstrap: ${v}. Supported tiers: ${BOOTSTRAP_TIERS.join(", ")}.`,
          );
        }
        out.bootstrap = v as BootstrapTier;
      }
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--here") out.here = true;
      else if (a === "--create") out.create = true;
      else if (a === "--repair") out.repair = true;
      continue;
    }
    throw new Error(
      `Unknown argument: ${a}. Supported: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
    );
  }
  return out;
}

// The activation tail defaults to the `fast` tier when no `--bootstrap` was given,
// so the long-standing behavior is unchanged unless the operator opts into a
// deeper tier.
export function resolveBootstrapTier(flags: { bootstrap?: BootstrapTier }): BootstrapTier {
  return flags.bootstrap ?? "fast";
}

// Whether a tier emits the static scout mission after the review bundle. Only the
// deterministic `fast` tier stays silent; the deprecated `agentic` tier still emits
// the deep-read mission for back-compat.
export function bootstrapTierEmitsMission(tier: BootstrapTier): boolean {
  return tier !== "fast";
}

// Whether a tier is deprecated. `agentic` is kept working but steered toward the
// consolidated `/mla onboard` flow; the activation tail prints the steer below it.
export function bootstrapTierIsDeprecated(tier: BootstrapTier): boolean {
  return tier === "agentic";
}

// Pure steer printed above the static `agentic` mission, pointing at the consolidated
// `/mla onboard` flow. Exported so the writing-style + content guards can assert it
// without driving the whole activation tail.
export function agenticDeprecationNote(): string {
  return [
    "`--bootstrap agentic` is deprecated. The richer, agent-driven onboarding is",
    "`/mla onboard`: two read-only scouts read your docs and git history and surface",
    "candidates born PENDING for you to review (the static mission below is a copy/paste",
    "fallback for shells without a Claude Code session).",
  ].join("\n");
}

// Pure marker writer (no console output). Writes a `.meetless.json` into `cwd`
// unless one already exists and `force` is not set. Returns whether a NEW marker
// was written (created=false means an existing marker was left untouched). The
// marker is strictly non-secret: workspaceId is an opaque tenant pointer and
// workspaceName is display-only, so the default note tells the human it is safe
// to commit.
export function writeActivationMarker(
  cwd: string,
  workspaceId: string,
  opts: { force?: boolean; note?: string; workspaceName?: string } = {},
): { markerPath: string; created: boolean } {
  const markerPath = path.join(cwd, ACTIVATION_FILENAME);
  if (fs.existsSync(markerPath) && !opts.force) {
    return { markerPath, created: false };
  }
  const marker: ActivationMarker = {
    workspaceId,
    ...(opts.workspaceName ? { workspaceName: opts.workspaceName } : {}),
    activatedAt: new Date().toISOString(),
    note:
      opts.note ??
      "Meetless workspace binding for this folder. Non-secret and safe to commit " +
        "(it holds no credentials). Run `mla deactivate` to remove it.",
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf8");
  return { markerPath, created: true };
}

// Clear the per-session OFF sentinel for the CURRENT live session, if present.
// Returns the session id when a sentinel was removed (so the caller can report
// it), or null when there was nothing to clear / no live session. Pure fs; no
// console output. Used by `mla activate` to re-enable a session that was muted
// with `mla mute`.
export function clearDeactivateSentinel(): string | null {
  const liveSid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!liveSid) return null;
  const sentinel = path.join(SESSION_GATE_DIR, `${liveSid}.off`);
  if (!fs.existsSync(sentinel)) return null;
  fs.rmSync(sentinel, { force: true });
  return liveSid;
}

// Best-effort: undo the OLD auto-gitignore behavior. The marker is committable
// and no longer force-ignored, so if a prior `mla activate` left a
// `.meetless.json` entry (and its banner comment) in the local `.gitignore`,
// strip it so the user is free to commit the marker. Returns a human message
// when something changed, else null. Never creates a `.gitignore`.
export function removeStaleGitignoreEntry(dir: string): string | null {
  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return null;
  const body = fs.readFileSync(gitignorePath, "utf8");
  const lines = body.split("\n");
  const kept = lines.filter(
    (l) =>
      l.trim() !== ACTIVATION_FILENAME &&
      !l.startsWith("# Meetless per-folder activation marker"),
  );
  if (kept.length === lines.length) return null;
  fs.writeFileSync(gitignorePath, kept.join("\n"), "utf8");
  return `removed stale ${ACTIVATION_FILENAME} entry from ${gitignorePath}`;
}

interface BootstrapResult {
  ok: boolean;
  sessionId?: string;
  detail: string;
}

// Bootstrap the CURRENT Claude Code session so capture takes effect NOW,
// without waiting for the next session. The current session's SessionStart
// hook already fired and exited dormant (no marker existed yet), so there is
// no AgentRun, no `session_started` spool line, and no repoPath sidecar for it.
// We reuse the installed session-start.sh as the canonical writer: with the
// marker now present its activation gate passes, and it writes the sidecar,
// spools session_started, and spawns the detached flush exactly as a real
// SessionStart would. Claude Code exports CLAUDE_CODE_SESSION_ID to hook
// subprocesses (and it equals the stdin session_id the hooks parse), so we can
// learn the live session id and feed it on stdin.
//
// Best-effort: a failure here never fails `mla activate`. The NEXT session in
// this folder still captures via the marker gate; this only buys the current
// one. Production stays dir-wise; this is the "get one session working now"
// affordance.
export function bootstrapCurrentSession(dir: string): BootstrapResult {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    return { ok: false, detail: "not inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset)" };
  }
  const sessionStart = path.join(HOOKS_DIR, "session-start.sh");
  if (!fs.existsSync(sessionStart)) {
    return {
      ok: false,
      sessionId,
      detail: `installed hooks not found at ${sessionStart}; run 'mla init' to wire capture`,
    };
  }
  // Recover the user prompts the marker gate dropped BEFORE this folder was
  // activated. They live in Claude Code's transcript but never reached the spool
  // (every capture hook opens with `meetless_activated || exit 0`), which is why
  // a session activated mid-flight renders its run and session_stopped but not
  // its opening human turn. Emit them as prompt_submitted lines BEFORE
  // session-start.sh runs: the flush it spawns creates the run first (Pass 1,
  // session_started) and then attaches these prompts (Pass 2), and the
  // deterministic backfill-<uuid> eventKey makes a repeated activate idempotent.
  // Strictly best-effort: a throw here must never fail `mla activate`.
  try {
    backfillSessionPrompts(sessionId, {
      projectsRoot: path.join(claudeConfigDir(), "projects"),
      queueDir: QUEUE_DIR,
      activatedAt: resolveActivationInstant(dir),
    });
  } catch {
    // never fail activation on a back-fill hiccup
  }
  try {
    execFileSync("bash", [sessionStart], {
      cwd: dir,
      input: JSON.stringify({ session_id: sessionId, transcript_path: "" }),
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 15000,
    });
    return { ok: true, sessionId, detail: "bootstrapped" };
  } catch (e) {
    return { ok: false, sessionId, detail: (e as Error).message };
  }
}

// Claude Code's config/transcript root: CLAUDE_CONFIG_DIR when the user has
// relocated it, else ~/.claude. Per-project transcripts live under <root>/projects.
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".claude");
}

// The back-fill cutoff: only prompts strictly before this instant were dropped
// by the gate; everything after was captured live. Prefer the marker's recorded
// activatedAt; fall back to "now" (activate is running this instant, so the whole
// transcript-so-far predates capture and live capture begins with the NEXT turn).
function resolveActivationInstant(dir: string): string {
  const found = findActivation(dir);
  if (found) {
    try {
      const parsed = JSON.parse(fs.readFileSync(found.path, "utf8")) as ActivationMarker;
      if (typeof parsed.activatedAt === "string" && parsed.activatedAt) {
        return parsed.activatedAt;
      }
    } catch {
      // fall through to the marker mtime
    }
    // Legacy marker with no recorded activatedAt: use the marker FILE's mtime as
    // the activation instant. It still cleanly separates the dropped
    // pre-activation turns from live-captured ones, so re-running `mla activate`
    // in an already-capturing session cannot duplicate already-captured turns
    // (which a naive "now" cutoff would).
    try {
      return new Date(fs.statSync(found.path).mtimeMs).toISOString();
    } catch {
      // fall through to now
    }
  }
  return new Date().toISOString();
}

// Probe a directory's Git context: whether cwd is inside a work tree, and the
// repo root if so. Both `git` calls swallow stderr and any non-Git failure maps
// to insideWorkTree=false, so a missing git binary or a non-repo directory is
// handled the same way (not inside Git).
function gitInfo(dir: string): { insideWorkTree: boolean; root?: string } {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (inside !== "true") return { insideWorkTree: false };
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { insideWorkTree: true, root };
  } catch {
    return { insideWorkTree: false };
  }
}

// Compare two directory paths for identity, resolving symlinks. On macOS
// `process.cwd()` reports the physical path (/private/var/...) while
// `git rev-parse --show-toplevel` may report through the /var symlink; realpath
// on both sides makes the repo-root check robust to that.
function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// Loads machine credentials (controlUrl, controlToken, actor) from
// cli-config.json. cli-config no longer carries the workspaceId (T1.1); this
// only fetches the creds the provision POST / repair probe need.
function loadCfgOrExplain(): CliConfig | number {
  if (!configExists()) {
    console.error(
      `cli-config.json not found at ${CFG_PATH}. Run 'mla init --control-token <token>' first.`,
    );
    return 2;
  }
  try {
    return readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
}

export async function runActivate(argv: string[]): Promise<number> {
  let flags: ActivateFlags;
  try {
    flags = parseActivateArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const cwd = process.cwd();

  // Fold the browser login into activate when the machine is wired but logged
  // out, so a fresh user does not have to discover `mla login` separately. Runs
  // before every real-work branch below (repair/bind/provision all hit the
  // backend and need a token). Strictly best-effort and TTY-gated inside the
  // helper; a decline or failure never blocks activate.
  await maybeOfferLogin();

  // `--repair` re-checks an existing binding's membership/connectivity ONLY. It
  // never mints a new id (An, 2026-06-04): re-creation is an explicit
  // `mla deactivate` then `mla activate`.
  if (flags.repair) {
    return runRepair(cwd);
  }

  // `--here` (in-Git subdir override) and `--create` (non-Git override) are two
  // distinct flags, never overloaded (INV-FLAGS-1). Passing both is a category
  // error, refused before any side effect.
  if (flags.here && flags.create) {
    console.error(
      "`--here` and `--create` cannot be combined: --here is the in-Git subdir " +
        "override, --create is the non-Git override.",
    );
    return 2;
  }

  // Create-vs-bind keys on marker PRESENCE. Under `--here` the resolution is
  // narrowed to a marker exactly AT cwd (INV-ACTIVATE-1): a parent marker does
  // NOT bind, so `--here` provisions a shadowing sub-project workspace even when
  // a parent marker exists (the monorepo sub-project case).
  const cwdMarkerPath = path.join(cwd, ACTIVATION_FILENAME);
  const existing: FoundActivation | null = flags.here
    ? fs.existsSync(cwdMarkerPath)
      ? findActivation(cwd)
      : null
    : findActivation(cwd);

  if (existing) {
    return runBind(existing, cwd, resolveBootstrapTier(flags));
  }

  const git = gitInfo(cwd);
  const guard = checkCreateGuard(flags, git, cwd);
  if (guard !== 0) return guard;

  return runProvision(cwd, flags);
}

// Repo-root guard (INV-FLAGS-1). Returns 0 to allow provisioning, or a non-zero
// exit code after printing the refusal. Called only when no marker resolves.
function checkCreateGuard(
  flags: ActivateFlags,
  git: { insideWorkTree: boolean; root?: string },
  cwd: string,
): number {
  if (flags.here) {
    // --here is the in-Git subdir override; it only applies inside a Git tree.
    if (!git.insideWorkTree) {
      console.error("`--here` only applies inside a Git repository.");
      console.error(
        "This directory is not inside a Git repository. To create a workspace " +
          "here anyway, use `mla activate --create`.",
      );
      return 2;
    }
    return 0;
  }

  if (flags.create) {
    // --create is the non-Git override; it is refused inside a Git tree, where
    // the safe paths are the repo root (no flag) or a subdir (`--here`).
    if (git.insideWorkTree) {
      const atRoot = git.root ? sameDir(cwd, git.root) : false;
      console.error("`--create` is for directories that are NOT inside a Git repository.");
      if (atRoot) {
        console.error("You are at a Git repo root; run `mla activate` (no flag) to provision here.");
      } else {
        console.error(
          "You are in a Git subdir; run `mla activate --here` to bind this subdir, " +
            "or cd to the repo root and run `mla activate`.",
        );
      }
      return 2;
    }
    return 0;
  }

  // No override flag. Outside Git, refuse and point at --create.
  if (!git.insideWorkTree) {
    console.error("No Meetless workspace is bound here, and this directory is not inside a Git repository.");
    console.error("To create a workspace here, run `mla activate --create`.");
    return 2;
  }

  // Inside Git with no flag: auto-create only at the repo root.
  const atRoot = git.root ? sameDir(cwd, git.root) : false;
  if (atRoot) return 0;

  console.error("No Meetless workspace is bound here.");
  console.error("");
  console.error("You are inside a Git repository but not at its root:");
  console.error(`  repo root: ${git.root}`);
  console.error(`  cwd:       ${cwd}`);
  console.error("");
  console.error("Run one of:");
  console.error(`  cd ${git.root} && mla activate`);
  console.error("  mla activate --here");
  return 2;
}

// Provision a fresh workspace server-side and write its id into the marker at
// cwd. The owner is the authenticated caller (resolved server-side from the
// actor identity), never the request body, so a caller cannot mint a workspace
// owned by someone else.
async function runProvision(cwd: string, flags: ActivateFlags): Promise<number> {
  const loaded = loadCfgOrExplain();
  if (typeof loaded === "number") return loaded;
  const cfg = loaded;

  const name = (flags.name && flags.name.trim()) || path.basename(cwd);

  let resp: { id: string; name: string; isNew: boolean };
  try {
    resp = await post<{ id: string; name: string; isNew: boolean }>(
      cfg,
      "/internal/v1/workspaces",
      { name },
    );
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 401 || err.status === 403) {
      console.error(
        "Control rejected the provision request (not authorized). Check `mla doctor` and your token.",
      );
    } else if (err.status !== undefined) {
      console.error(`Control could not provision the workspace (HTTP ${err.status}).`);
    } else {
      console.error("Could not reach control to provision the workspace. Is it running? (`mla doctor`)");
    }
    return 1;
  }

  const { markerPath } = writeActivationMarker(cwd, resp.id, {
    force: true,
    workspaceName: resp.name,
    note: flags.note,
  });

  console.log(`Provisioned workspace ${resp.id} (${resp.name}).`);
  console.log(`  marker:      ${markerPath}`);
  console.log(`  workspaceId: ${resp.id}`);
  console.log("");
  console.log("Commit guidance:");
  console.log(`  ${ACTIVATION_FILENAME} is untracked and not gitignored; it holds no secrets.`);
  console.log("  Commit it to share this workspace binding with the team, or leave it");
  console.log("  uncommitted to keep the binding local to this clone.");

  const giResult = removeStaleGitignoreEntry(cwd);
  if (giResult) console.log(`  gitignore:   ${giResult}`);

  // Fresh workspace = empty governed KB: invite onboarding (one-time per workspace).
  return finishActivate(cwd, resolveBootstrapTier(flags), true);
}

// Bind to an already-resolved marker. Provisions nothing; the marker is local
// truth for "which workspace this folder runs under".
function runBind(found: FoundActivation, cwd: string, tier: BootstrapTier): number {
  const nameSuffix = found.workspaceName ? ` (${found.workspaceName})` : "";
  const id = found.workspaceId ?? "(no workspaceId in marker)";
  console.log(`Already activated: ${found.path} -> ${id}${nameSuffix}`);
  console.log("  Marker unchanged; this folder is already bound to a workspace.");

  const giResult = removeStaleGitignoreEntry(found.dir);
  if (giResult) console.log(`  gitignore:   ${giResult}`);

  return finishActivate(cwd, tier);
}

// `mla activate --repair`: re-check an existing binding's health WITHOUT ever
// minting a new id (An, 2026-06-04). A missing/inaccessible workspace is
// surfaced loudly and the user is pointed at deactivate+activate to re-create;
// repair itself never re-creates.
async function runRepair(cwd: string): Promise<number> {
  const found = findActivation(cwd);
  if (!found) {
    console.error("Nothing to repair: no .meetless.json is bound to this folder.");
    console.error("  Run `mla activate` to create or bind a workspace here.");
    return 2;
  }
  if (!found.workspaceId) {
    console.error(`Nothing to repair: ${found.path} has no usable workspaceId (stale marker).`);
    console.error("  Re-create the binding with `mla deactivate` then `mla activate`.");
    return 2;
  }

  const loaded = loadCfgOrExplain();
  if (typeof loaded === "number") return loaded;
  const cfg = loaded;

  console.log(`Checking binding: ${found.workspaceId} (${found.path})`);
  try {
    await get(
      cfg,
      `/internal/v1/workspaces/me?workspaceId=${encodeURIComponent(found.workspaceId)}`,
      5000,
    );
    console.log("  Status: active (exists and reachable). Nothing to repair.");
    return 0;
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) {
      console.error(
        `  Status: bound to ${found.workspaceId}, but the workspace does not exist or is inaccessible.`,
      );
      console.error(
        "  `mla activate --repair` never re-creates a workspace; run `mla deactivate` " +
          "then `mla activate` to mint a new one.",
      );
      return 1;
    }
    if (err.status === 401 || err.status === 403) {
      console.error(
        `  Status: bound to ${found.workspaceId}, but your token is not a member. ` +
          "Ask a workspace owner to add you.",
      );
      return 1;
    }
    // Network error / control down: never fail repair on transient unreachability.
    console.log(
      `  Status: could not verify with control (${err.status ?? "offline"}). ` +
        "The local binding still applies.",
    );
    return 0;
  }
}

// One-time nudge toward `/mla onboard`, the agent-driven repo onboarding that seeds
// the governed KB from the repo's docs and git history (the mla-onboard skill wired
// by `mla init`/`rewire`). Pure: returns the text to print, or null to stay silent.
//
// Shown only when BOTH hold:
//   - inSession: there is a live Claude Code session, so the `/mla onboard` slash
//     command is actually invokable (it is a no-op suggestion from a bare shell).
//   - justProvisioned: this run created a brand-new workspace, whose governed KB is
//     empty: exactly the moment onboarding pays off. Re-running `mla activate` on an
//     already-bound folder takes the bind path (no provision), so the nudge is
//     naturally one-time per workspace without any sentinel state.
export function onboardRecommendation(opts: {
  inSession: boolean;
  justProvisioned: boolean;
}): string | null {
  if (!opts.inSession || !opts.justProvisioned) return null;
  return [
    "Next: seed this workspace's governed memory from the repo.",
    "  Run `/mla onboard` to dispatch two read-only scouts over your docs and git",
    "  history. They surface constraints, decisions, conventions, boundaries, and",
    "  deprecations as candidates born PENDING for you to review; nothing is accepted",
    "  automatically. You can run it now or any time later.",
    "  First run only: the scout agents were just installed, and Claude Code loads",
    "  agents at session start. If `/mla onboard` reports a scout agent is not found,",
    "  restart Claude Code (or open a new session) and run it again.",
  ].join("\n");
}

// Activate is the BACKSTOP migrator (design §6.7): `mla doctor --fix` is the primary
// path, but a user who never runs doctor still lands on activate, so we run the reconcile
// here in `activate` mode. Review minimum patch #1: activate mode is connector-neutral and
// remove-only, so `restore-legacy` is unreachable and the ONLY mutation possible here is
// remove-legacy under `owned` (tearing out legacy that shadows the plugin). It NEVER
// installs or restores Claude wiring. It is strictly fail-safe: any detection/reconcile
// error is caught and reported as `failed: true` (NOT silently swallowed) so the caller
// can WARN, and activate never aborts on a wiring hiccup. The paths + executor are
// injectable so the whole thing is testable without touching the real home dir.
export function reconcileWiringBackstop(io: {
  paths?: LegacyWiringPaths;
  detect?: typeof detectPluginOwnership;
  reconcileIO?: ReconcileIO;
} = {}): {
  action: ReconcileAction;
  changed: boolean;
  restartRequired: boolean;
  failed: boolean;
  warn?: string;
} {
  const paths = io.paths ?? legacyWiringPaths();
  const detect = io.detect ?? detectPluginOwnership;
  const reconcileIO = io.reconcileIO ?? defaultReconcileIO(paths);
  try {
    const ownership = detect();
    const plan = planLegacyReconcile({
      ownership: ownership.status,
      inspection: inspectLegacyWiring(paths),
      mode: "activate", // connector-neutral: NEVER installs or restores Claude wiring (only remove-legacy)
    });
    const { changed } = applyLegacyReconcile(plan, reconcileIO);
    // Blocker 3: propagate the planner's advisory (e.g. non-global "reinstall at user
    // scope") so the activate caller can WARN even though a non-global plan is a noop.
    return {
      action: plan.action,
      changed,
      restartRequired: plan.restartRequired,
      failed: false,
      warn: plan.warn,
    };
  } catch {
    // Never let a wiring reconcile abort activate; surface failed so the caller warns.
    return { action: "noop", changed: false, restartRequired: false, failed: true };
  }
}

// Shared tail for the provision/bind paths: clear any per-session OFF sentinel,
// then bootstrap the current session so capture starts NOW (not next session). The
// bootstrap tier decides whether the activation preview also emits the agentic
// scout mission (fast = review bundle only; agentic/full = bundle + mission).
// recommendOnboard is set only by the provision path, so the `/mla onboard` nudge
// fires once per fresh workspace (see onboardRecommendation).
function finishActivate(cwd: string, tier: BootstrapTier, recommendOnboard = false): number {
  // Re-running `mla activate` inside a session that was previously muted with
  // `mla mute` is one supported way to turn it back ON (the other is
  // `mla unmute`): clear the per-session sentinel FIRST, so the bootstrap below
  // (and every subsequent hook) is no longer short-circuited by
  // meetless_session_disabled.
  const clearedSid = clearDeactivateSentinel();
  if (clearedSid) {
    console.log("");
    console.log(
      `Cleared a prior \`mla mute\` for this session (${clearedSid.slice(0, 8)}); capture is back ON.`,
    );
  }

  // Deterministic preview (Regime 1): scan + cache, then show the review bundle.
  // Never block activation on the preview; it is reassurance, not a gate.
  try {
    const scanWorkspaceId = tryResolveWorkspaceId(cwd); // existing resolver from ../lib/workspace
    if (scanWorkspaceId) {
      const result = rescanAndCache({ cwd, workspaceId: scanWorkspaceId });
      console.log("");
      console.log(renderBootstrapSummary(result));

      // The deprecated `agentic` tier still prints the static scout mission for the
      // messy Tier-2 docs the deterministic pass could only count, but steers the
      // operator to the consolidated `/mla onboard` flow first (Phase 2).
      if (bootstrapTierEmitsMission(tier)) {
        if (bootstrapTierIsDeprecated(tier)) {
          console.log("");
          console.log(agenticDeprecationNote());
        }
        console.log("");
        console.log("Static scout mission (hand this to a coding agent):");
        console.log("");
        console.log(renderManualScoutMission(result));
      } else {
        // Fast tier: do not hide the deeper bootstrap. When deep docs went unread,
        // nudge the operator toward `mla activate --bootstrap agentic`.
        const invite = renderAgenticInvitation(result);
        if (invite) {
          console.log("");
          console.log(invite);
        }
      }
    }
  } catch {
    // swallow: the preview must never fail activation
  }

  const boot = bootstrapCurrentSession(cwd);
  console.log("");
  if (boot.ok) {
    console.log(
      `Capture is active NOW for this session (${boot.sessionId!.slice(0, 8)}); no restart needed.`,
    );
    console.log("Run `mla review` inside this session to see the console URLs + captured review.");
  } else {
    console.log("Capture takes effect on the NEXT Claude Code session started from this folder.");
    // Only explain when we were inside a session but the bootstrap could not
    // run (e.g. hooks not installed); a plain non-session invocation needs no
    // scary detail.
    if (boot.sessionId) {
      console.log(`  (current session not bootstrapped: ${boot.detail})`);
    }
  }

  const backstop = reconcileWiringBackstop();
  if (backstop.failed) {
    // Fail-safe warning (An's exact copy, design §6.7): activate succeeded, but we
    // could not verify or repair the global wiring, so point the user at the primary
    // fix path rather than pretending everything is wired.
    console.warn(
      "Repository activated, but MLA could not verify or repair global wiring. Run `mla doctor --fix`.",
    );
  } else if (backstop.changed && backstop.restartRequired) {
    console.log(
      `Wiring updated (${backstop.action}). Restart Claude Code so the change takes effect.`,
    );
  }
  // Blocker 3: surface the planner's advisory even on a noop plan. A non-global install
  // reconciles to noop (nothing changed, nothing failed), so without this the user would
  // never learn from `mla activate` that their plugin is project-scoped. Independent of
  // the failed/changed branches above; `warn` is only set on the success path, so it
  // never doubles up with the fail-safe copy (the catch path returns no `warn`).
  if (backstop.warn) {
    console.warn(backstop.warn);
  }

  // A live Claude Code session is what makes `/mla onboard` invokable; key off the
  // session id (present even if the bootstrap hook itself could not run), not boot.ok.
  const onboard = onboardRecommendation({
    inSession: !!boot.sessionId,
    justProvisioned: recommendOnboard,
  });
  if (onboard) {
    console.log("");
    console.log(onboard);
  }
  return 0;
}

// `mla mute` (per-session capture OFF, folder = workspace T2.3).
//
// Silences the CURRENT live Claude Code session, both capture AND Push, even
// inside an activated folder, by dropping a `<sid>.off` sentinel into
// SESSION_GATE_DIR. The capture hooks check meetless_session_disabled (after the
// folder gate, once the session id is parsed) and exit 0 when the sentinel
// exists. This is the dogfooding A/B affordance: run the same repo with the
// pipeline on in one session and off in another, with no folder churn.
//
// Scope is deliberately the SESSION, not the folder: `mute` never touches
// `.meetless.json`. To unbind a whole folder from its workspace, run
// `mla deactivate`. Re-enable this session with `mla unmute` (or `mla activate`).
export async function runMute(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(`Unknown argument: ${argv[0]}. \`mla mute\` takes no arguments.`);
    return 2;
  }

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.error(
      "mla mute must run INSIDE a live Claude Code session (CLAUDE_CODE_SESSION_ID is unset).",
    );
    console.error(
      "It silences the CURRENT session only. To unbind a whole folder from its workspace, run `mla deactivate`.",
    );
    return 2;
  }

  fs.mkdirSync(SESSION_GATE_DIR, { recursive: true });
  const sentinel = path.join(SESSION_GATE_DIR, `${sessionId}.off`);
  fs.writeFileSync(sentinel, new Date().toISOString() + "\n", "utf8");

  console.log(`Muted this session (${sessionId.slice(0, 8)}): capture AND Push are now OFF.`);
  console.log(`  sentinel: ${sentinel}`);
  console.log("  Takes effect on the next hook fire (prompt, tool use, or stop).");
  console.log("  Re-run `mla unmute` (or `mla activate`) in this session to turn it back on.");
  return 0;
}

// `mla unmute` (per-session capture back ON, folder = workspace T2.3).
//
// Removes the `<sid>.off` sentinel for the CURRENT live session, undoing a prior
// `mla mute`. Like `mute`, it is strictly session-scope and never touches
// `.meetless.json`. A no-op (exit 0) when the session was not muted.
export async function runUnmute(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(`Unknown argument: ${argv[0]}. \`mla unmute\` takes no arguments.`);
    return 2;
  }

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    console.error(
      "mla unmute must run INSIDE a live Claude Code session (CLAUDE_CODE_SESSION_ID is unset).",
    );
    console.error("It re-enables the CURRENT session only.");
    return 2;
  }

  const sentinel = path.join(SESSION_GATE_DIR, `${sessionId}.off`);
  if (!fs.existsSync(sentinel)) {
    console.log(`This session (${sessionId.slice(0, 8)}) was not muted; nothing to do.`);
    return 0;
  }
  fs.rmSync(sentinel, { force: true });

  console.log(`Unmuted this session (${sessionId.slice(0, 8)}): capture is back ON.`);
  console.log("  Takes effect on the next hook fire (prompt, tool use, or stop).");
  return 0;
}

interface DeactivateFlags {
  yes?: boolean;
  fromRoot?: boolean;
  marker?: string;
}

function parseDeactivateArgs(argv: string[]): DeactivateFlags {
  const out: DeactivateFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--marker") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new Error("Missing value for --marker");
      out.marker = v;
      i += 1;
      continue;
    }
    if (a === "--yes") {
      out.yes = true;
      continue;
    }
    if (a === "--from-root") {
      out.fromRoot = true;
      continue;
    }
    throw new Error(
      `Unknown argument: ${a}. \`mla deactivate\` accepts --yes, --from-root, --marker <path>.`,
    );
  }
  return out;
}

// Best-effort read of a marker's workspaceId for human-facing messages. A
// malformed or missing file yields undefined; never throws.
function readMarkerWorkspaceId(markerPath: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { workspaceId?: unknown };
    return typeof raw.workspaceId === "string" && raw.workspaceId.trim()
      ? raw.workspaceId
      : undefined;
  } catch {
    return undefined;
  }
}

// Interactive y/N prompt. Only reached on a real TTY (every caller TTY-gates
// before calling this), so reading stdin can never hang a script. `defaultYes`
// picks the answer for a bare Enter: false = `[y/N]` (deactivate, the safe
// default for a destructive action), true = `[Y/n]` (the login offer, where the
// happy path is "yes, log me in").
function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

// `mla activate` is the first command a user runs that genuinely needs the backend
// (provision POSTs a new workspace; bind's capture/review lean on it too), and it
// is the moment they have committed to the product on a repo. So when the machine
// is wired but logged out, we fold the browser login into activate inline, exactly
// as Claude Code folds auth into first-run. Best-effort and strictly gated:
//   - config must exist AND be readable (a missing config takes activate's existing
//     "run `mla init` first" path; an unreadable/Gate-4-conflicted config is left
//     for the downstream reader to surface verbatim);
//   - only when auth.mode === 'none' (already signed in via user-token OR shared-key
//     is left untouched);
//   - only on a real TTY (headless/hook contexts never prompt; the printed
//     `mla login` nudges cover them);
//   - a decline or a failed login NEVER blocks activate: we continue, and any
//     backend call that then needs auth surfaces its own clear 401 guidance.
//
// `deps` exists only to make the two genuinely-external seams testable: the stdin
// prompt (`confirm`) and the browser login (`login`). The gating (configExists /
// readConfig / isTTY) is driven for real in tests via MEETLESS_HOME + an isTTY
// spy, so the guard logic is exercised against the real config loader, not a mock.
export interface OfferLoginDeps {
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  login?: (argv: string[]) => Promise<number>;
}

export async function maybeOfferLogin(deps: OfferLoginDeps = {}): Promise<void> {
  if (!configExists()) return;
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch {
    return;
  }
  if (cfg.auth.mode !== "none") return;
  if (!process.stdin.isTTY) return;

  const confirm = deps.confirm ?? promptYesNo;
  const login = deps.login ?? runLogin;

  console.log("You're not signed in to Meetless.");
  const yes = await confirm("Open the browser to log in now? [Y/n] ", true);
  if (!yes) {
    console.log(
      "Skipping login. Run `mla login` when you're ready; activate continues.",
    );
    console.log("");
    return;
  }
  // login reads/writes the same HOME-level cli-config.json, so the fresh
  // user-token lands on disk before the provision/bind path below re-reads it.
  // It returns a nonzero code on failure rather than throwing, and we intentionally
  // do not gate activate on its result: a failed login just means the next backend
  // call prints its own actionable error. The try/catch is belt-and-suspenders for
  // a pathological throw (e.g. the post-auth config write failing) so the offer can
  // NEVER turn a wired activate into a crash.
  try {
    await login([]);
  } catch {
    console.log("Login did not complete; activate continues.");
  }
  console.log("");
}

// `mla deactivate` (workspace-binding removal, folder = workspace T2.2).
//
// Removes the nearest `.meetless.json`, unbinding this folder from its
// workspace (future sessions under it stop capturing). This is NOT a per-session
// off switch any more; that is `mla mute`.
//
// Guards (INV-DEACTIVATE-1 + nested-dir safety):
//   - Confirms before deleting; `--yes` skips the prompt. In a non-interactive
//     context (no TTY) it refuses without `--yes` rather than hang.
//   - When the nearest marker lives in an ANCESTOR of cwd (the monorepo case),
//     a plain run refuses: removing it would unbind the whole subtree. The user
//     opts in with `--from-root` (remove the resolved ancestor) or
//     `--marker <path>` (target a specific marker explicitly).
export async function runDeactivate(argv: string[]): Promise<number> {
  let flags: DeactivateFlags;
  try {
    flags = parseDeactivateArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  if (flags.marker && flags.fromRoot) {
    console.error(
      "`--marker` and `--from-root` cannot be combined: --marker already names an " +
        "explicit target; --from-root is for the resolved ancestor marker.",
    );
    return 2;
  }

  const cwd = process.cwd();

  // Resolve the target marker path + the directory it binds.
  let targetPath: string;
  let targetDir: string;
  let workspaceId: string | undefined;

  if (flags.marker) {
    // Explicit path = explicit intent: no locality guard. Resolve, accept a
    // directory by appending the marker filename, and require the basename to
    // be the marker so we never `rm` an arbitrary file.
    let p = path.resolve(cwd, flags.marker);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      p = path.join(p, ACTIVATION_FILENAME);
    }
    if (path.basename(p) !== ACTIVATION_FILENAME) {
      console.error(`--marker must point at a ${ACTIVATION_FILENAME} file (got ${flags.marker}).`);
      return 2;
    }
    if (!fs.existsSync(p)) {
      console.error(`No marker at ${p}.`);
      return 1;
    }
    targetPath = p;
    targetDir = path.dirname(p);
    workspaceId = readMarkerWorkspaceId(p);
  } else {
    const found = findActivation(cwd);
    if (!found) {
      console.error("Nothing to deactivate: no .meetless.json binding resolves from here.");
      console.error("  (Use `mla mute` to silence just the current session.)");
      return 1;
    }
    // Nested-dir safety: an ancestor marker is not removed from a subdir without
    // an explicit opt-in, even with `--yes` (which only skips the y/N prompt).
    if (!sameDir(found.dir, cwd) && !flags.fromRoot) {
      console.error("The nearest workspace binding is in a parent directory, not here:");
      console.error(`  marker: ${found.path}`);
      console.error(`  cwd:    ${cwd}`);
      console.error("");
      console.error("Removing it would unbind the whole subtree, not just this folder.");
      console.error("Re-run with `--from-root` to remove that parent binding, or");
      console.error("`--marker <path>` to target a specific .meetless.json.");
      return 1;
    }
    targetPath = found.path;
    targetDir = found.dir;
    workspaceId = found.workspaceId;
  }

  // Confirm-before-delete context (INV-DEACTIVATE-1). Shown on every path so the
  // operator sees what would change even when the run refuses.
  console.log("Found marker:");
  console.log(`  ${targetPath}`);
  console.log("");
  console.log("`mla deactivate` REMOVES this folder workspace binding (it no longer");
  console.log("just suppresses this session; that is `mla mute`).");
  console.log("");

  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        "Refusing to remove a workspace binding without confirmation in a non-interactive context.",
      );
      console.error("Re-run with `--yes` to deactivate non-interactively.");
      return 1;
    }
    const ok = await promptYesNo("Deactivate this workspace binding? [y/N] ");
    if (!ok) {
      console.log("Aborted; marker left in place.");
      return 0;
    }
  }

  fs.rmSync(targetPath, { force: true });

  // Deactivation removes ONLY the projection MLA verifiably owns (matrix doc Phase 1). A
  // foreign file or a hand-edited projection at the path is left intact. Throw-free, so a
  // removal hiccup never aborts the unbind that already happened above.
  const removed = removeOwnedProjection(targetDir);
  if (removed.removed) {
    console.log(`Removed the MLA floor projection (${FLOOR_PROJECTION_RELPATH}).`);
  }

  const wasBound = workspaceId ? ` (was bound to ${workspaceId})` : "";
  console.log(`Removed ${targetPath}.${wasBound}`);
  console.log(
    `Future sessions under ${targetDir} will not be captured unless another parent marker applies.`,
  );

  // Helpful for monorepos: after removing the nearer marker, re-resolve from the
  // same dir to see whether a parent marker now governs the subtree, and say so.
  const stillApplies = findActivation(targetDir);
  if (stillApplies) {
    const sfx = stillApplies.workspaceId ? ` -> ${stillApplies.workspaceId}` : "";
    console.log(`  Note: a parent marker still governs this subtree: ${stillApplies.path}${sfx}`);
  }
  return 0;
}
