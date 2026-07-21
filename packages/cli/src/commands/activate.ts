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
  loadWorkspaceConfig,
  QUEUE_DIR,
  readConfig,
  SESSION_GATE_DIR,
  writeConfig,
  type WorkspaceCliConfig,
  userHomeDir,
} from "../lib/config";
import { backfillSessionPrompts } from "../lib/transcript-prompts";
import { runWire, type WireResult } from "../lib/wire";
import { runLogin } from "./login";
import { get, HttpError, post } from "../lib/http";
import {
  deactivationPreflight,
  deactivateWorkspace,
  type DeactivationPreflightResult,
  type DeactivateWorkspaceResult,
} from "../lib/control-workspace-lifecycle-client";
import {
  renderActivationCard,
  renderBootstrapSummary,
} from "../lib/scanner/bootstrap-summary";
import type { ScanResult } from "../lib/scanner/types";
import {
  renderManualScoutMission,
  renderAgenticInvitation,
} from "../lib/scanner/scout-mission";
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
import {
  emitEnvelope,
  failInMode,
  getMachineCommand,
  isMachineMode,
  successEnvelope,
} from "../lib/machine-output";

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
// opaque workspaceId, never credentials, paths, or actor ids). activate no
// longer writes it into `.gitignore`, and it does not remove it either: a repo
// that ignores the marker is making a legitimate choice (one workspace per
// clone), and `.gitignore` is the user's file, not ours. We only READ the
// repo's answer (via `git check-ignore`) and tell the truth about it.
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
export function resolveBootstrapTier(flags: {
  bootstrap?: BootstrapTier;
}): BootstrapTier {
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

// Report whether the repo ignores the marker. REPORT, never rewrite.
//
// This used to DELETE the `.meetless.json` line out of the user's `.gitignore`,
// on the theory that any such line was left over from the old auto-ignore
// behavior. It cannot know that. A repo may ignore the marker on purpose (this
// one did, with a hand-written banner explaining why), and activate silently
// edited a TRACKED file to make its own "not gitignored" claim come true,
// leaving a dirty tree and an orphaned comment behind. `.gitignore` is the
// user's file: floor-projection-writer.ts already says so and writes to
// `.git/info/exclude` instead. Same rule here, no exceptions.
//
// `git check-ignore` is the only correct oracle: ignore rules also come from
// parent directories, `.git/info/exclude`, and the global excludesfile, none of
// which a scan of the local `.gitignore` would ever see. Outside a Git repo (or
// with no git on PATH) it exits non-zero, which is the right answer anyway.
export function isMarkerGitignored(dir: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", ACTIVATION_FILENAME], {
      cwd: dir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// The commit-guidance block, told truthfully for THIS repo rather than asserted.
export function commitGuidanceLines(dir: string): string[] {
  if (isMarkerGitignored(dir)) {
    return [
      "Commit guidance:",
      `  This repo's .gitignore ignores ${ACTIVATION_FILENAME}, so the binding stays`,
      "  local to your clone. That is a valid choice and mla will not touch it.",
      `  The marker holds no secrets (an opaque workspaceId, nothing else), so if you`,
      "  want the team to share one workspace, drop that ignore line and commit it.",
    ];
  }
  return [
    "Commit guidance:",
    `  ${ACTIVATION_FILENAME} is untracked and not gitignored; it holds no secrets.`,
    "  Commit it to share this workspace binding with the team, or leave it",
    "  uncommitted to keep the binding local to this clone.",
  ];
}

// A plain-language "what did I just run, and why" for the fresh-provision path.
// Interview finding: a first-time user runs `mla activate`, sees "Provisioned
// workspace ...", and has no idea what a workspace is or why they needed one. This
// says it once, in their words, at the exact moment a workspace is born. It stays
// OFF the re-run (bind) path, which already prints "already bound" and needs no
// re-explanation. Pure: returns the lines to print.
export function activateExplainerLines(): string[] {
  return [
    "What this did:",
    "  `mla activate` bound this folder to a Meetless workspace: the governed memory",
    "  your coding agents read before they work and write to as they learn. The",
    "  decisions, constraints, conventions, and boundaries of this repo live here, so",
    "  agents stop shipping against stale assumptions and stop asking you the same",
    "  questions. One workspace per folder.",
    "",
    "Why you ran it:",
    "  It is the one-time setup that turns this repo into a governed workspace, and it",
    "  wired Claude Code (the capture hooks, the /mla skill, MCP, and the onboarding",
    "  scouts) so capture starts on its own. You do not run it again for this folder;",
    "  re-running only re-checks the binding and repairs the wiring if it drifted.",
  ];
}

export interface BootstrapResult {
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

// Locate the session-start capture hook from whichever wiring surface is live on
// THIS machine, so "is capture wired?" matches how the user actually installed.
// Two surfaces ship the IDENTICAL self-contained hook (it `source`s common.sh
// relative to its own dir, so it runs the same launched from either path):
//   - legacy home-dir wiring: ~/.meetless/hooks/session-start.sh (written by `mla init`)
//   - the Claude Code plugin `mla@meetless`: <installPath>/hooks/session-start.sh.
//     This is the SHIPPED marketplace install; its hooks live under the plugin
//     root, NOT ~/.meetless/hooks, so a home-only check falsely reports capture
//     as unwired and tells plugin users to run `mla init` (dogfood 2026-07-10).
//     detectPluginOwnership() surfaces installPath only when owned (user/managed
//     scope = global wiring); non-global/unknown/absent do not provide it.
// Precedence is home-first: an explicit `mla init` on this box is the more direct
// signal, and when both exist the reconcile backstop tears out the shadowing
// legacy copy immediately after. Returns the absolute hook path, or null when
// NEITHER surface is present (the only case that genuinely warrants an install nudge).
export function resolveSessionStartHook(
  detect: typeof detectPluginOwnership = detectPluginOwnership,
): string | null {
  const homeHook = path.join(HOOKS_DIR, "session-start.sh");
  if (fs.existsSync(homeHook)) return homeHook;
  try {
    const ownership = detect();
    if (ownership.status === "owned" && ownership.installPath) {
      const pluginHook = path.join(
        ownership.installPath,
        "hooks",
        "session-start.sh",
      );
      if (fs.existsSync(pluginHook)) return pluginHook;
    }
  } catch {
    // Detection is best-effort (`claude plugin list` may be absent/slow/wedged); a
    // failure must not crash the bootstrap. Fall through to null and let the caller
    // emit the neutral install nudge rather than a false "wired" claim.
  }
  return null;
}

// Whether the self-heal installed anything Claude Code can only pick up at session
// start (hook events it reads from settings.json, or an MCP server entry). Hooks that
// were already on disk do not count: they are live in this session already.
export function wiringNeedsRestart(wired: WireResult | null): boolean {
  if (!wired) return false;
  const mcp = wired.mcp;
  const freshMcp =
    !!mcp && mcp.action !== "unchanged" && mcp.action !== "skipped";
  return wired.hooksAdded.length > 0 || freshMcp;
}

// The two facts printed at the end of `mla activate`: is capture running, and did we
// just install wiring that only loads at session start. They MUST be rendered together.
// Printed independently, they contradicted each other: capture claimed "no restart
// needed" and, three lines later, the wiring line said "Restart Claude Code once". Both
// were true (capture rides the hooks that were already live when the session started;
// the tools and scout agents genuinely are not loaded yet), but the pair reads as a
// flat self-negation and the operator cannot act on it. So: only promise "no restart
// needed" when nothing is about to ask for one, and when a restart IS needed, name what
// it is FOR and say what it does not disturb.
export function renderCaptureAndWiringLines(opts: {
  boot: BootstrapResult;
  installedWiring: boolean;
  inSession: boolean;
}): string[] {
  const { boot, installedWiring, inSession } = opts;
  const lines: string[] = [];

  if (boot.ok) {
    const sid = (boot.sessionId ?? "").slice(0, 8);
    lines.push(
      installedWiring
        ? `Capture is active NOW for this session (${sid}).`
        : `Capture is active NOW for this session (${sid}); no restart needed.`,
    );
    lines.push(
      "Run `mla review` inside this session to see the console URLs + captured review.",
    );
  } else {
    lines.push(
      "Capture takes effect on the NEXT Claude Code session started from this folder.",
    );
    // Only explain when we were inside a session but the bootstrap could not run (e.g.
    // hooks not installed); a plain non-session invocation needs no scary detail.
    if (boot.sessionId) {
      lines.push(`  (current session not bootstrapped: ${boot.detail})`);
    }
  }

  if (installedWiring) {
    lines.push("");
    if (inSession) {
      lines.push(
        "Installed the Meetless wiring (hooks, /mla skill, scout agents, MCP). Claude Code loads these at session start, so restart once to pick up the tools and scout agents.",
      );
      if (boot.ok) {
        lines.push(
          "  Capture for this session is already running; the restart does not interrupt it.",
        );
      }
    } else {
      lines.push(
        "Installed the Meetless wiring (hooks, /mla skill, scout agents, MCP). It loads automatically the next time you open Claude Code.",
      );
    }
  }

  return lines;
}

export function bootstrapCurrentSession(dir: string): BootstrapResult {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    return {
      ok: false,
      detail: "not inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset)",
    };
  }
  const sessionStart = resolveSessionStartHook();
  if (!sessionStart) {
    return {
      ok: false,
      sessionId,
      detail:
        "capture hooks are not installed on this machine (checked ~/.meetless/hooks " +
        "and the mla@meetless Claude Code plugin); run `mla init` or install the mla " +
        "plugin to wire capture",
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
  return path.join(userHomeDir(), ".claude");
}

// The back-fill cutoff: only prompts strictly before this instant were dropped
// by the gate; everything after was captured live. Prefer the marker's recorded
// activatedAt; fall back to "now" (activate is running this instant, so the whole
// transcript-so-far predates capture and live capture begins with the NEXT turn).
function resolveActivationInstant(dir: string): string {
  const found = findActivation(dir);
  if (found) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(found.path, "utf8"),
      ) as ActivationMarker;
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
  const command = getMachineCommand() ?? "activate";
  if (!configExists()) {
    return failInMode(
      command,
      "config_error",
      `cli-config.json not found at ${CFG_PATH}. Run 'mla init --control-token <token>' first.`,
      2,
    );
  }
  try {
    return readConfig();
  } catch (e) {
    return failInMode(command, "config_error", (e as Error).message, 2);
  }
}

export async function runActivate(argv: string[]): Promise<number> {
  // Machine mode is armed only for the plain `activate` operation; `--repair`
  // resolves to `activate.repair` (unsupported in Phase 1) and never reaches
  // this handler in machine mode, so the repair path below stays human-only.
  const command = getMachineCommand() ?? "activate";

  let flags: ActivateFlags;
  try {
    flags = parseActivateArgs(argv);
  } catch (e) {
    return failInMode(command, "usage_error", (e as Error).message, 2);
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
    return failInMode(
      command,
      "usage_error",
      "`--here` and `--create` cannot be combined: --here is the in-Git subdir " +
        "override, --create is the non-Git override.",
      2,
    );
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
  const guard = checkCreateGuard(command, flags, git, cwd);
  if (guard !== 0) return guard;

  return runProvision(cwd, flags);
}

// Repo-root guard (INV-FLAGS-1). Returns 0 to allow provisioning, or a non-zero
// exit code after reporting the refusal. Called only when no marker resolves. Each
// refusal is one failInMode call: human mode prints the (newline-joined) message to
// stderr exactly as before; machine mode emits a single guard error envelope.
function checkCreateGuard(
  command: string,
  flags: ActivateFlags,
  git: { insideWorkTree: boolean; root?: string },
  cwd: string,
): number {
  if (flags.here) {
    // --here is the in-Git subdir override; it only applies inside a Git tree.
    if (!git.insideWorkTree) {
      return failInMode(
        command,
        "activate_guard",
        "`--here` only applies inside a Git repository.\n" +
          "This directory is not inside a Git repository. To create a workspace " +
          "here anyway, use `mla activate --create`.",
        2,
      );
    }
    return 0;
  }

  if (flags.create) {
    // --create is the non-Git override; it is refused inside a Git tree, where
    // the safe paths are the repo root (no flag) or a subdir (`--here`).
    if (git.insideWorkTree) {
      const atRoot = git.root ? sameDir(cwd, git.root) : false;
      const where = atRoot
        ? "You are at a Git repo root; run `mla activate` (no flag) to provision here."
        : "You are in a Git subdir; run `mla activate --here` to bind this subdir, " +
          "or cd to the repo root and run `mla activate`.";
      return failInMode(
        command,
        "activate_guard",
        "`--create` is for directories that are NOT inside a Git repository.\n" +
          where,
        2,
      );
    }
    return 0;
  }

  // No override flag. Outside Git, refuse and point at --create.
  if (!git.insideWorkTree) {
    return failInMode(
      command,
      "activate_guard",
      "No Meetless workspace is bound here, and this directory is not inside a Git repository.\n" +
        "To create a workspace here, run `mla activate --create`.",
      2,
    );
  }

  // Inside Git with no flag: auto-create only at the repo root.
  const atRoot = git.root ? sameDir(cwd, git.root) : false;
  if (atRoot) return 0;

  return failInMode(
    command,
    "activate_guard",
    [
      "No Meetless workspace is bound here.",
      "",
      "You are inside a Git repository but not at its root:",
      `  repo root: ${git.root}`,
      `  cwd:       ${cwd}`,
      "",
      "Run one of:",
      `  cd ${git.root} && mla activate`,
      "  mla activate --here",
    ].join("\n"),
    2,
  );
}

interface ProvisionResponse {
  id: string;
  name: string;
  isNew: boolean;
  // The OWNER membership (WorkspaceUser) minted for the caller in this workspace.
  ownerUserId?: string;
  // Control re-bound the caller's account-only session to this new workspace, so
  // the identity we hold on disk (the ACCOUNT id, from an account-only login) is
  // now stale. See healActorIdentityAfterRebind.
  sessionRebound?: boolean;
}

// The account-only -> workspace-bound self-heal (Option B P4).
//
// After a fresh `mla login` with no workspace, the on-disk `auth.user.id` is the
// ACCOUNT id: control had no membership to name, so the session projected the
// account as a least-privilege placeholder. Provisioning re-binds that same
// session to the new workspace server-side, which makes our copy wrong: readConfig
// PINS `actorUserId` to `auth.user.id` under user-token mode, and refreshUserToken
// deliberately preserves the stored identity across rotations. So nothing else in
// the CLI will ever correct it. Left alone, every actor-keyed call would send an
// account id as `X-Meetless-Actor` and read as a non-member of the workspace the
// human just created.
//
// Re-read from disk instead of writing back the caller's snapshot: the provision
// POST itself may have rotated tokens (http.post refreshes on 401), and writing a
// stale `cfg` would clobber the fresh ones. Failure here is non-fatal; the
// workspace exists either way and `mla login --force` re-derives the identity.
function healActorIdentityAfterRebind(ownerUserId: string): boolean {
  let fresh: CliConfig;
  try {
    fresh = readConfig();
  } catch {
    return false;
  }
  if (fresh.auth.mode !== "user-token") return false;
  if (fresh.auth.user.id === ownerUserId) return false;
  writeConfig({
    ...fresh,
    auth: {
      ...fresh.auth,
      // role is display-only (§4.6); control re-reads the live WorkspaceUser.role
      // on every authorization decision. OWNER is simply the truth now.
      user: { ...fresh.auth.user, id: ownerUserId, role: "OWNER" },
    },
  });
  return true;
}

// The folder path we send to control as this activation's re-activation key.
//
// `realpathSync.native` rather than the plain resolve, for two reasons that both
// show up on a normal Mac: it resolves symlinks (so `/tmp/x` and `/private/tmp/x`
// are one key, not two), and it returns the path in the filesystem's canonical
// CASE, so `~/Projects/app` and `~/projects/app` cannot mint two workspaces for
// the same case-insensitive directory. Falls back to the plain resolved path if
// the syscall fails (a path we cannot canonicalize is still a usable key, and a
// failure here must never block activation).
export function canonicalRepoPath(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

// Provision a fresh workspace server-side and write its id into the marker at
// cwd. The owner is the authenticated caller (resolved server-side from the
// actor identity), never the request body, so a caller cannot mint a workspace
// owned by someone else.
//
// Control makes this idempotent per folder: it keys on the path we send, so a
// re-activation after `mla deactivate` (which deletes the marker but leaves the
// workspace alive) resolves the SAME workspace instead of minting a twin. The
// response's `isNew` distinguishes the two outcomes.
async function runProvision(
  cwd: string,
  flags: ActivateFlags,
): Promise<number> {
  const command = getMachineCommand() ?? "activate";
  const loaded = loadCfgOrExplain();
  if (typeof loaded === "number") return loaded;
  const cfg = loaded;

  const name = (flags.name && flags.name.trim()) || path.basename(cwd);

  let resp: ProvisionResponse;
  try {
    resp = await post<ProvisionResponse>(
      cfg,
      "/internal/v1/workspaces",
      { name, repoPath: canonicalRepoPath(cwd) },
    );
  } catch (e) {
    const err = e as HttpError;
    let msg: string;
    if (err.status === 401 || err.status === 403) {
      msg =
        "Control rejected the provision request (not authorized). Check `mla doctor` and your token.";
    } else if (err.status !== undefined) {
      msg = `Control could not provision the workspace (HTTP ${err.status}).`;
    } else {
      msg =
        "Could not reach control to provision the workspace. Is it running? (`mla doctor`)";
    }
    return failInMode(command, "provision_failed", msg, 1);
  }

  // Do this BEFORE anything else touches control: finishActivate goes on to run
  // the onboarding/scan chain, and those calls are actor-keyed. If they fire with
  // the stale account id they read as a non-member of the workspace we just made.
  const healed =
    resp.sessionRebound && resp.ownerUserId
      ? healActorIdentityAfterRebind(resp.ownerUserId)
      : false;

  const { markerPath } = writeActivationMarker(cwd, resp.id, {
    force: true,
    workspaceName: resp.name,
    note: flags.note,
  });

  if (!isMachineMode()) {
    // isNew === false means control matched `repoPath` and handed back the
    // workspace this folder was activated under before (`mla deactivate` removes
    // the marker but leaves the workspace). Say so plainly: silently reporting
    // "Provisioned" for a workspace that already holds the human's history is a
    // lie they would only catch by counting rows in the switcher.
    if (resp.isNew) {
      console.log(`Provisioned workspace ${resp.id} (${resp.name}).`);
    } else {
      console.log(`Re-activated workspace ${resp.id} (${resp.name}).`);
      console.log("  This folder was activated before; its existing workspace and history are intact.");
    }
    console.log(`  marker:      ${markerPath}`);
    console.log(`  workspaceId: ${resp.id}`);
    if (healed) console.log("  identity:    signed-in session bound to this workspace as OWNER.");
    console.log("");
    for (const line of activateExplainerLines()) console.log(line);
    console.log("");
    for (const line of commitGuidanceLines(cwd)) console.log(line);
  }

  // A fresh workspace has an empty governed KB, so invite onboarding (one-time).
  // A reused one already ran it, and re-inviting would read as "your history is
  // gone" at exactly the moment we kept it.
  return finishActivate(cwd, resolveBootstrapTier(flags), resp.isNew);
}

// Bind to an already-resolved marker. Provisions nothing; the marker is local
// truth for "which workspace this folder runs under".
function runBind(
  found: FoundActivation,
  cwd: string,
  tier: BootstrapTier,
): number {
  if (!isMachineMode()) {
    const nameSuffix = found.workspaceName ? ` (${found.workspaceName})` : "";
    const id = found.workspaceId ?? "(no workspaceId in marker)";
    console.log(`Already activated: ${found.path} -> ${id}${nameSuffix}`);
    console.log(
      "  Marker unchanged; this folder is already bound to a workspace.",
    );
  }

  return finishActivate(cwd, tier);
}

// `mla activate --repair`: re-check an existing binding's health WITHOUT ever
// minting a new id (An, 2026-06-04). A missing/inaccessible workspace is
// surfaced loudly and the user is pointed at deactivate+activate to re-create;
// repair itself never re-creates.
async function runRepair(cwd: string): Promise<number> {
  const found = findActivation(cwd);
  if (!found) {
    console.error(
      "Nothing to repair: no .meetless.json is bound to this folder.",
    );
    console.error("  Run `mla activate` to create or bind a workspace here.");
    return 2;
  }
  if (!found.workspaceId) {
    console.error(
      `Nothing to repair: ${found.path} has no usable workspaceId (stale marker).`,
    );
    console.error(
      "  Re-create the binding with `mla deactivate` then `mla activate`.",
    );
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

// Fresh-workspace onboarding hand-off. `/mla activate` (via the /mla skill) greps
// this function's output for the machine sentinel `MLA_NEXT: onboard` and, when it
// finds it, auto-invokes the mla-onboard skill: a fresh workspace flows straight into
// onboarding with no second command and no "want me to run it?" prompt. The trailing
// prose is the human-readable version for anyone who ran `mla activate` from a bare
// shell (where no skill is watching stdout). Pure: returns the text, or null to stay
// silent.
//
// Emitted only when BOTH hold:
//   - inSession: there is a live Claude Code session, so the mla-onboard skill is
//     actually invokable (the sentinel is inert noise from a bare shell).
//   - justProvisioned: this run created a brand-new workspace, whose governed KB is
//     empty: exactly the moment onboarding pays off. Re-running `mla activate` on an
//     already-bound folder takes the bind path (no provision), so the hand-off is
//     naturally one-time per workspace without any persisted sentinel state.
export function onboardRecommendation(opts: {
  inSession: boolean;
  justProvisioned: boolean;
}): string | null {
  if (!opts.inSession || !opts.justProvisioned) return null;
  return [
    // Machine sentinel (rule 6 of the /mla skill): its own line so a stdout scan can
    // match it unambiguously even when other text surrounds it. Do NOT reword.
    "MLA_NEXT: onboard",
    "Next: seeding this workspace's governed memory from the repo (onboarding).",
    "  Two read-only scouts read your docs and git history and surface constraints,",
    "  decisions, conventions, boundaries, and deprecations as candidates born PENDING",
    "  for you to review; nothing is accepted automatically. This runs via `/mla onboard`.",
    "  First run only: the scout agents were just installed, and Claude Code loads agents",
    "  at session start. If onboarding reports a scout agent is not found, restart Claude",
    "  Code (or open a new session) and run `/mla onboard` again. Nothing is lost.",
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
export function reconcileWiringBackstop(
  io: {
    paths?: LegacyWiringPaths;
    detect?: typeof detectPluginOwnership;
    reconcileIO?: ReconcileIO;
  } = {},
): {
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
    return {
      action: "noop",
      changed: false,
      restartRequired: false,
      failed: true,
    };
  }
}

// Shared tail for the provision/bind paths: clear any per-session OFF sentinel,
// then bootstrap the current session so capture starts NOW (not next session). The
// bootstrap tier decides whether the activation preview also emits the agentic
// scout mission (fast = review bundle only; agentic/full = bundle + mission).
// recommendOnboard is set only by the provision path, so the `/mla onboard` nudge
// fires once per fresh workspace (see onboardRecommendation).
function finishActivate(
  cwd: string,
  tier: BootstrapTier,
  recommendOnboard = false,
): number {
  // Re-running `mla activate` inside a session that was previously muted with
  // `mla mute` is one supported way to turn it back ON (the other is
  // `mla unmute`): clear the per-session sentinel FIRST, so the bootstrap below
  // (and every subsequent hook) is no longer short-circuited by
  // meetless_session_disabled.
  const clearedSid = clearDeactivateSentinel();
  if (clearedSid && !isMachineMode()) {
    console.log("");
    console.log(
      `Cleared a prior \`mla mute\` for this session (${clearedSid.slice(0, 8)}); capture is back ON.`,
    );
  }

  // Deterministic preview (Regime 1): scan + cache FIRST, because the session-start
  // hook that bootstrapCurrentSession runs injects from that cache; then bootstrap;
  // only then render. The render has to come last because the header it prints is a
  // claim about the bootstrap ("guiding this session NOW" vs "the next session"), and
  // we may not assert that before we know. Never block activation on the preview; it
  // is reassurance, not a gate.
  let scan: ScanResult | null = null;
  // Hoisted so the machine envelope tail can report which workspace was activated.
  // The assignment happens before any throwing call (rescanAndCache), so a scan
  // failure still leaves the resolved id in hand.
  let workspaceId: string | null = null;
  try {
    workspaceId = tryResolveWorkspaceId(cwd); // existing resolver from ../lib/workspace
    if (workspaceId) {
      scan = rescanAndCache({ cwd, workspaceId });
    }
  } catch {
    // swallow: the preview must never fail activation
  }

  const boot = bootstrapCurrentSession(cwd);

  if (scan && !isMachineMode()) {
    console.log("");
    console.log(renderBootstrapSummary(scan, { injectedNow: boot.ok }));

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
      console.log(renderManualScoutMission(scan));
    } else {
      // Fast tier: do not hide the deeper bootstrap. When deep docs went unread,
      // nudge the operator toward `mla activate --bootstrap agentic`.
      const invite = renderAgenticInvitation(scan);
      if (invite) {
        console.log("");
        console.log(invite);
      }
    }
  }

  // Self-heal global wiring so `mla activate` ALONE leaves the user fully wired, no
  // matter how they installed. A curl install already ran `mla init`, and the Meetless
  // plugin OWNS the wiring; but an `npm i -g @meetless/mla` user (npm runs no
  // postinstall) or anyone who skipped `mla init` would otherwise reach activate with
  // no hooks, /mla skill, MCP, or scout agents. runWire is idempotent: an already-wired
  // home returns "unchanged" (silent), a bare install gets everything installed now.
  // Skipped entirely when a Meetless plugin owns the wiring (home must stay untouched)
  // or in a headless/CI run (MLA_NO_WIRE), mirroring install.sh's opt-out. This is a
  // separate concern from reconcileWiringBackstop below, which is remove-only (it tears
  // out legacy wiring that shadows a plugin and NEVER installs).
  //
  // This runs BEFORE the capture/wiring copy is printed, and must keep doing so: the
  // capture line's "no restart needed" is only honest if we already know whether the
  // self-heal is about to demand one. It has no other ordering dependency (the session
  // was bootstrapped further up, against the hooks that were live at session start).
  let selfHealed: WireResult | null = null;
  if (detectPluginOwnership().status !== "owned" && !process.env.MLA_NO_WIRE) {
    try {
      selfHealed = runWire({ noProjectRules: true });
    } catch {
      // Never fail activation on a wiring hiccup; the backstop + doctor still catch it.
    }
  }

  if (!isMachineMode()) {
    console.log("");
    for (const line of renderCaptureAndWiringLines({
      boot,
      installedWiring: wiringNeedsRestart(selfHealed),
      inSession: !!boot.sessionId,
    })) {
      console.log(line);
    }
  }

  // reconcileWiringBackstop APPLIES wiring changes, so it must run in every mode;
  // only its human advisories are suppressed under machine output.
  const backstop = reconcileWiringBackstop();
  if (!isMachineMode()) {
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
  }

  // A live Claude Code session is what makes `/mla onboard` invokable; key off the
  // session id (present even if the bootstrap hook itself could not run), not boot.ok.
  const onboard = onboardRecommendation({
    inSession: !!boot.sessionId,
    justProvisioned: recommendOnboard,
  });

  // Machine mode: the whole activation collapses to ONE success envelope. The onboarding
  // hand-off travels as a typed next_action (the connector invokes the onboard skill), not
  // as the `MLA_NEXT: onboard` stdout sentinel, which is the human/legacy transport.
  if (isMachineMode()) {
    const command = getMachineCommand() ?? "activate";
    return emitEnvelope(
      successEnvelope(
        command,
        {
          workspaceId,
          repositoryRoot: cwd,
          provisioned: recommendOnboard,
          sessionActive: !!boot.sessionId,
        },
        onboard ? { nextAction: { kind: "skill", ref: "onboard" } } : {},
      ),
      0,
    );
  }

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
    console.error(
      `Unknown argument: ${argv[0]}. \`mla mute\` takes no arguments.`,
    );
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

  console.log(
    `Muted this session (${sessionId.slice(0, 8)}): capture AND Push are now OFF.`,
  );
  console.log(`  sentinel: ${sentinel}`);
  console.log(
    "  Takes effect on the next hook fire (prompt, tool use, or stop).",
  );
  console.log(
    "  Re-run `mla unmute` (or `mla activate`) in this session to turn it back on.",
  );
  return 0;
}

// `mla unmute` (per-session capture back ON, folder = workspace T2.3).
//
// Removes the `<sid>.off` sentinel for the CURRENT live session, undoing a prior
// `mla mute`. Like `mute`, it is strictly session-scope and never touches
// `.meetless.json`. A no-op (exit 0) when the session was not muted.
export async function runUnmute(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(
      `Unknown argument: ${argv[0]}. \`mla unmute\` takes no arguments.`,
    );
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
    console.log(
      `This session (${sessionId.slice(0, 8)}) was not muted; nothing to do.`,
    );
    return 0;
  }
  fs.rmSync(sentinel, { force: true });

  console.log(
    `Unmuted this session (${sessionId.slice(0, 8)}): capture is back ON.`,
  );
  console.log(
    "  Takes effect on the next hook fire (prompt, tool use, or stop).",
  );
  return 0;
}

interface DeactivateFlags {
  yes?: boolean;
  fromRoot?: boolean;
  marker?: string;
  // Two-verbs model (design §2/§3): E1 (unbind this folder) vs E2 (retire the
  // Workspace). These flags override the interactive prompt selection for E2.
  keepWorkspace?: boolean; // never retire; unbind locally only (sole-owner escape hatch)
  deactivateWorkspace?: boolean; // force retire (E2), still server-gated OWNER/ADMIN
}

function parseDeactivateArgs(argv: string[]): DeactivateFlags {
  const out: DeactivateFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--marker") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-"))
        throw new Error("Missing value for --marker");
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
    if (a === "--keep-workspace") {
      out.keepWorkspace = true;
      continue;
    }
    if (a === "--deactivate-workspace") {
      out.deactivateWorkspace = true;
      continue;
    }
    throw new Error(
      `Unknown argument: ${a}. \`mla deactivate\` accepts --yes, --from-root, ` +
        `--marker <path>, --keep-workspace, --deactivate-workspace.`,
    );
  }
  if (out.keepWorkspace && out.deactivateWorkspace) {
    throw new Error(
      "`--keep-workspace` and `--deactivate-workspace` are contradictory: the " +
        "first forbids retiring the workspace, the second forces it.",
    );
  }
  return out;
}

// Best-effort read of a marker's workspaceId for human-facing messages. A
// malformed or missing file yields undefined; never throws.
function readMarkerWorkspaceId(markerPath: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      workspaceId?: unknown;
    };
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
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
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

export async function maybeOfferLogin(
  deps: OfferLoginDeps = {},
): Promise<void> {
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

// OWNER/ADMIN are the only roles allowed to retire a workspace (E2). Anything
// else (MEMBER, or a null role when the actor could not be resolved) is E1-only.
function isOwnerAdmin(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

// Prefer control's human-readable `message` over the raw HttpError.message when
// the retire (E2) call fails. Mirrors workspace.ts:serverMessage; kept local so
// activate.ts does not depend on the workspace command module.
function retireErrorMessage(e: unknown): string {
  const err = e as HttpError;
  if (err && typeof err.body === "string" && err.body) {
    try {
      const parsed = JSON.parse(err.body) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message) {
        return err.status
          ? `${parsed.message} (HTTP ${err.status})`
          : parsed.message;
      }
    } catch {
      // non-JSON body: fall through to the raw error message
    }
  }
  return (e as Error).message;
}

// Injectable seams so the E2 (retire) matrix is unit-testable with no network,
// no on-disk config, and no TTY. Every default resolves to the real production
// path, so `runDeactivate(argv)` with no deps behaves exactly as before for E1.
export interface DeactivateDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  preflight?: (
    cfg: WorkspaceCliConfig,
  ) => Promise<DeactivationPreflightResult>;
  retire?: (cfg: WorkspaceCliConfig) => Promise<DeactivateWorkspaceResult>;
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  isTTY?: () => boolean;
}

// `mla deactivate` (workspace-binding removal + reversible workspace retire,
// folder = workspace T2.2; two-verbs model, design
// notes/20260710-mla-workspace-deactivate-retired-state.md).
//
// Two independent effects, gated differently:
//   E1 (unbind this folder): remove the nearest `.meetless.json` + floor
//      projection. Local, offline-safe, allowed to anyone, unchanged.
//   E2 (retire the workspace): set Workspace.retiredAt so the switcher demotes
//      it. Backend, OWNER/ADMIN-gated, best-effort. Driven by a preflight that
//      selects the prompt (sole-owner default-YES = retire+unbind; multi-member
//      default-NO = unbind unless opted in; member = unbind only).
//
// Guards (INV-DEACTIVATE-1 + nested-dir safety):
//   - Confirms before deleting; `--yes` skips the prompt. In a non-interactive
//     context (no TTY) it refuses without `--yes` rather than hang.
//   - When the nearest marker lives in an ANCESTOR of cwd (the monorepo case),
//     a plain run refuses: removing it would unbind the whole subtree. The user
//     opts in with `--from-root` (remove the resolved ancestor) or
//     `--marker <path>` (target a specific marker explicitly).
//   - E2 is SKIPPED for a `--marker` target (explicit foreign path = local
//     intent only) and for `--keep-workspace`; forced by `--deactivate-workspace`.
export async function runDeactivate(
  argv: string[],
  deps: DeactivateDeps = {},
): Promise<number> {
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
      console.error(
        `--marker must point at a ${ACTIVATION_FILENAME} file (got ${flags.marker}).`,
      );
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
      console.error(
        "Nothing to deactivate: no .meetless.json binding resolves from here.",
      );
      console.error("  (Use `mla mute` to silence just the current session.)");
      return 1;
    }
    // Nested-dir safety: an ancestor marker is not removed from a subdir without
    // an explicit opt-in, even with `--yes` (which only skips the y/N prompt).
    if (!sameDir(found.dir, cwd) && !flags.fromRoot) {
      console.error(
        "The nearest workspace binding is in a parent directory, not here:",
      );
      console.error(`  marker: ${found.path}`);
      console.error(`  cwd:    ${cwd}`);
      console.error("");
      console.error(
        "Removing it would unbind the whole subtree, not just this folder.",
      );
      console.error(
        "Re-run with `--from-root` to remove that parent binding, or",
      );
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
  console.log(
    "`mla deactivate` REMOVES this folder workspace binding (it no longer",
  );
  console.log("just suppresses this session; that is `mla mute`).");
  console.log("");

  const confirm = deps.confirm ?? promptYesNo;
  const isTTY = deps.isTTY ? deps.isTTY() : Boolean(process.stdin.isTTY);

  // ── E2 decision: retire the workspace (global, OWNER/ADMIN-gated, §3 matrix) ──
  // Best-effort and additive to E1: any config/preflight failure (offline, signed
  // out, not a member) falls back to E1-only with a note, so an unbind never hangs
  // or aborts on the backend. Skipped entirely for a `--marker` target (explicit
  // foreign path = local intent) and for `--keep-workspace`.
  let cfg: WorkspaceCliConfig | null = null;
  let retire = false; // POST /deactivate before unbinding?
  let combinedConfirmDone = false; // sole-owner default-YES already authorized E1
  type Branch = "skip" | "member" | "sole" | "multi";
  let branch: Branch = "skip";
  let others = 0;

  const e2Eligible =
    !flags.marker && !flags.keepWorkspace && Boolean(workspaceId);
  if (flags.keepWorkspace && workspaceId && !flags.marker) {
    console.log(
      "--keep-workspace: unbinding this folder only; the workspace stays active.",
    );
    console.log("");
  }

  if (e2Eligible) {
    try {
      cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspaceId);
    } catch {
      cfg = null; // no readable/authenticated config => cannot reach control
    }
    let preflight: DeactivationPreflightResult | null = null;
    if (cfg) {
      try {
        preflight = await (deps.preflight ?? deactivationPreflight)(cfg);
      } catch {
        preflight = null; // control unreachable / not a member => E1-only
      }
    }

    if (!preflight) {
      console.log(
        "Could not check the workspace with control (offline or signed out); " +
          "unbinding this folder only. Retire it later from the Console or " +
          "`mla deactivate` once you're back online.",
      );
      console.log("");
      branch = "skip";
    } else if (preflight.retiredAt) {
      console.log(
        `Workspace ${workspaceId} is already deactivated; unbinding this folder.`,
      );
      console.log("");
      branch = "skip";
    } else if (!isOwnerAdmin(preflight.callerRole)) {
      console.log(
        "Only an owner/admin can deactivate the workspace itself; unbinding this " +
          "folder only.",
      );
      console.log("");
      branch = "member";
    } else if (preflight.activeMemberCount <= 1) {
      branch = "sole";
    } else {
      branch = "multi";
      others = preflight.activeMemberCount - 1;
    }
  }

  // ── E1 confirm + E2 opt-in, selected by the matrix branch (§3) ──
  if (branch === "sole") {
    // Sole owner/admin: ONE default-YES prompt covers BOTH retire and unbind.
    if (flags.yes || flags.deactivateWorkspace) {
      retire = true;
      combinedConfirmDone = true;
    } else if (!isTTY) {
      console.error(
        "Refusing to deactivate without confirmation in a non-interactive context.",
      );
      console.error(
        "Re-run with `--yes` (retire + unbind) or `--keep-workspace` (unbind only).",
      );
      return 1;
    } else {
      const ok = await confirm(
        `Deactivate workspace ${workspaceId}? Unbinds this folder and retires the ` +
          `workspace (reversible). [Y/n] `,
        true,
      );
      if (!ok) {
        console.log("Aborted; marker left in place.");
        return 0;
      }
      retire = true;
      combinedConfirmDone = true;
    }
  }

  // Generic E1 confirm for the member / multi / skip branches (sole already
  // authorized E1 via combinedConfirmDone). `--yes` skips the prompt; a non-TTY
  // context without `--yes` refuses rather than hang.
  if (!combinedConfirmDone && !flags.yes) {
    if (!isTTY) {
      console.error(
        "Refusing to remove a workspace binding without confirmation in a non-interactive context.",
      );
      console.error("Re-run with `--yes` to deactivate non-interactively.");
      return 1;
    }
    const ok = await confirm("Deactivate this workspace binding? [y/N] ", false);
    if (!ok) {
      console.log("Aborted; marker left in place.");
      return 0;
    }
  }

  // Multi-member owner/admin: E1 (unbind) is confirmed above; retiring for everyone
  // is a separate, default-NO opt-in (or `--deactivate-workspace`).
  if (branch === "multi") {
    if (flags.deactivateWorkspace) {
      retire = true;
    } else if (flags.yes || !isTTY) {
      console.log(
        `This workspace has ${others} other member(s); unbinding this folder only. ` +
          `Pass --deactivate-workspace to also retire it for everyone.`,
      );
    } else {
      retire = await confirm(
        `This workspace has ${others} other member(s). Also deactivate it for ` +
          `everyone? [y/N] `,
        false,
      );
    }
  }

  // Run E2 (retire) BEFORE E1 (unbind) so an auth/role failure aborts cleanly with
  // no partial local unbind (design §7.1). preflight reported OWNER/ADMIN moments
  // ago, so a failure here is an anomaly (role changed, or INV-AUTH-1 re-gate).
  if (retire && cfg) {
    try {
      await (deps.retire ?? deactivateWorkspace)(cfg);
      console.log(
        `Retired workspace ${workspaceId} (reversible: ` +
          `\`mla workspace reactivate ${workspaceId}\` or the Console ` +
          `Reactivate button).`,
      );
    } catch (e) {
      console.error(
        `Could not deactivate the workspace: ${retireErrorMessage(e)}`,
      );
      console.error(
        "The folder is still bound; nothing was changed. Retry, or pass " +
          "`--keep-workspace` to unbind locally only.",
      );
      return 1;
    }
  }

  fs.rmSync(targetPath, { force: true });

  // Deactivation removes ONLY the projection MLA verifiably owns (matrix doc Phase 1). A
  // foreign file or a hand-edited projection at the path is left intact. Throw-free, so a
  // removal hiccup never aborts the unbind that already happened above.
  const removed = removeOwnedProjection(targetDir);
  if (removed.removed) {
    console.log(
      `Removed the MLA floor projection (${FLOOR_PROJECTION_RELPATH}).`,
    );
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
    const sfx = stillApplies.workspaceId
      ? ` -> ${stillApplies.workspaceId}`
      : "";
    console.log(
      `  Note: a parent marker still governs this subtree: ${stillApplies.path}${sfx}`,
    );
  }
  return 0;
}
