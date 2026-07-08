import { loadWorkspaceConfig, getConsoleUrl, WorkspaceCliConfig } from "../lib/config";
import { get, HttpError } from "../lib/http";
import { renderPacket, ReviewPacketView } from "../lib/render";
import { runFlush } from "./flush";
import { HOOKS_DIR } from "../lib/config";
import { triggerSessionFinalize } from "./internal-finalize";

// `mla review` and `mla review <id>` (Wedge v6 dogfood loop, redesigned).
//
// Locked surface:
//
//   mla review                  -> current session ONLY (CLAUDE_CODE_SESSION_ID).
//                                  Leads with console URLs (workspace queues),
//                                  then renders the deterministic packet. Flags:
//                                  --plain, --no-flush.
//   mla review <id>             -> emit a console deep link for an id. Probes
//                                  control for relationship-candidate first,
//                                  then agent-review case. No flags.
//
// Removed (intentionally; do not bring back without An sign-off):
//
//   mla review latest           Resolved a workspace-wide "latest run" implicitly
//                               from /internal/v1/agent-runs/latest. That is
//                               implementation-driven incoherence: the right
//                               default is the session you are running INSIDE,
//                               not whatever the workspace last touched.
//   mla review by-session <sid> Per-session escape hatch. The locked rule is
//                               "current session is the default AND the only
//                               one allowed; go to the UI to access more." A
//                               --session flag re-opens the same hole.
//   mla cases list/show         Replaced by the unified `mla review` + console
//                               URL emission. The console at /cases is the
//                               first-class surface for browsing cases.
//
// Polling contract (unchanged from the pre-redesign by-session path):
//   status=pending                  -> poll up to 60s, 500ms cadence
//   status=ready,  syn=pending      -> continue polling with a 30s sub-timeout
//   status=ready,  syn=ready        -> STOP, render full packet
//   status=ready,  syn=failed       -> STOP, render base + synth-failed footer
//   status=failed,  syn=*           -> STOP, render error and doctor suggestion
//   60s overall timeout w/ pending  -> print doctor suggestion

const OVERALL_TIMEOUT_MS = 60_000;
const SYNTH_SUBTIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Exported for unit tests. The poll loop must STOP rendering immediately when:
//   - status=failed (base build blew up; render the error packet)
//   - status=ready + synthesisStatus in {ready, failed} (LLM either succeeded or
//     gave up; render whatever is available)
//   - status=ready + synthesisStatus is null OR undefined (server signalled the
//     synthesis path will never run for this packet; render the base layer).
// A backend response that omits synthesisStatus entirely (undefined) used to
// fall through every branch and trap the loop until the 60s overall timeout
// fired. The user got "Review not ready after 60s" for a packet that was
// already terminal. Treating null and undefined identically closes the trap.
export function isImmediateTerminal(
  status: string,
  synthesisStatus: string | null | undefined,
): boolean {
  if (status === "failed") return true;
  if (status === "ready") {
    if (synthesisStatus == null) return true;
    if (synthesisStatus === "ready" || synthesisStatus === "failed") return true;
  }
  return false;
}

export interface ReviewFlags {
  plain?: boolean;
  noFlush?: boolean;
}

// Strict argv parser for the no-arg `mla review`. Two supported flags only.
//
// The pre-redesign parser also handled a `wantBySession` mode that allowed a
// session-id positional. That mode is gone because the locked design is
// "current session only; go to the UI for more." Re-introducing a positional
// here would silently re-open the deprecated `mla review by-session <sid>`
// path as a positional shortcut.
export function parseArgs(argv: string[]): ReviewFlags {
  const out: ReviewFlags = {};
  for (const a of argv) {
    if (a === "--plain") {
      out.plain = true;
      continue;
    }
    if (a === "--no-flush") {
      out.noFlush = true;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}. Supported flags: --plain, --no-flush`);
    }
    // No positionals. `mla review <id>` is a SEPARATE command routed by cli.ts
    // before we get here. A stray positional at THIS layer means the operator
    // tried `mla review --plain some-sid` (sid-as-trailing-positional) or the
    // dispatcher routed wrong; either way, naming the offender is more useful
    // than silently dropping it.
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla review\` takes no positional arguments; ` +
        `use \`mla review <id>\` for a specific item.`,
    );
  }
  return out;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Build the operator-visible timeout message. Carries the last observed
// status + synthesisStatus so `mla review` does not return a useless
// "not ready after 60s." It matters which side of the worker pipeline
// is hung: `pending/not_started` means the base-layer build never
// started (worker draining or DB writes wedged); `ready/pending` means
// synthesis is hung (intel reachability or token bucket exhaustion).
// Surfacing these in the failure message saves the operator a full
// `mla doctor` round-trip on every timeout.
export function buildTimeoutMessage(lastStatus: string, lastSyn: string): string {
  return (
    `Review not ready after 60s (last seen: status=${lastStatus}, syn=${lastSyn}). ` +
    "Run `mla doctor` to check worker draining and intel reachability."
  );
}

async function pollForPacket(opts: {
  url: () => string;
  cfg: WorkspaceCliConfig;
}): Promise<
  | { kind: "packet"; packet: ReviewPacketView }
  | { kind: "timeout"; lastStatus: string; lastSyn: string }
> {
  const start = Date.now();
  let synthStart: number | null = null;
  let lastStatus = "?";
  let lastSyn = "?";

  while (Date.now() - start < OVERALL_TIMEOUT_MS) {
    let raw: any;
    try {
      raw = await get(opts.cfg, opts.url(), 8000);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 404) {
        // Run exists but packet not created yet; treat as pending and keep polling.
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw e;
    }

    if (raw.status === "pending" && raw.synthesisStatus === "not_started") {
      lastStatus = "pending";
      lastSyn = "not_started";
      if (Date.now() - start < POLL_INTERVAL_MS * 2) {
        process.stderr.write("Building deterministic review...\n");
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const packet = raw as ReviewPacketView;
    lastStatus = packet.status;
    lastSyn = packet.synthesisStatus ?? "n/a";

    if (isImmediateTerminal(packet.status, packet.synthesisStatus)) {
      return { kind: "packet", packet };
    }
    if (packet.status === "ready") {
      if (packet.synthesisStatus === "pending") {
        if (synthStart === null) {
          synthStart = Date.now();
          process.stderr.write("Base ready; waiting on LLM synthesis...\n");
        }
        if (Date.now() - synthStart >= SYNTH_SUBTIMEOUT_MS) {
          packet.warnings = [
            ...(packet.warnings ?? []),
            "LLM synthesis still pending; will appear on next `mla review` invocation.",
          ];
          return { kind: "packet", packet };
        }
      }
      if (packet.synthesisStatus === "not_started") {
        // Worker hasn't enqueued synthesis yet; keep polling.
      }
    }
    if (packet.status === "pending") {
      // Worker is still writing base layer.
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return { kind: "timeout", lastStatus, lastSyn };
}

async function autoFlushAll(): Promise<void> {
  // Best-effort. Failures here are non-fatal; the poll loop will tell the user
  // what's missing through the packet shape itself.
  try {
    await runFlush(["--all"], { quiet: true, hookDir: HOOKS_DIR });
  } catch {
    // ignore
  }
}

// Header block emitted at the top of every `mla review` invocation.
// The locked design is "all the review operations are to be done on web UI,
// so we need to surface the right web UI under the right command." The
// terminal packet render is a convenience snapshot, NOT the review surface.
// Leading with URLs makes the contract obvious.
function consoleUrlsBlock(consoleBase: string): string {
  return [
    "Review in Console:",
    `  Relationships queue:  ${consoleBase}/relationships`,
    `  Cases queue:          ${consoleBase}/cases`,
    "",
    // The Relationships queue above is Intel's claim-grain connections. It is
    // NOT what `mla graph review` lists (that is control's artifact-grain
    // candidates). Give the CLI equivalent so a headless agent following this
    // pointer has a command, not just a URL it cannot open.
    "List from CLI:",
    "  Relationships queue:  mla graph connections",
    "",
  ].join("\n");
}

// Header for `mla review` when CLAUDE_CODE_SESSION_ID is unset. The CLI cannot
// guess which session the user means and the locked design forbids inferring
// one. Print the workspace URLs and exit 0 -- that still routes them to the UI,
// which is the locked outcome.
function printConsoleOnly(consoleBase: string): void {
  console.log(consoleUrlsBlock(consoleBase));
  console.log(
    "`mla review` shows the current session's review packet when run INSIDE a " +
      "Claude Code session (CLAUDE_CODE_SESSION_ID is unset here). Open the queues " +
      "above to review pending items.",
  );
}

// On-demand review trigger (Phase 7 / PATCH 5 / INV-M6,
// notes/20260604-mla-mission-and-review-packet-rethink.md).
//
// `mla review` used to be a PASSIVE poller: the by-session packet only existed
// if the Claude Code Stop hook had already fired the finalize. Running review
// mid-session (before any clean Stop, which in practice rarely arrives) just
// spun to the 60s timeout. INV-M6 makes review producible by at least one
// non-Stop trigger, and the floor is an explicit `mla review`. So we fire the
// same finalize the Stop-hook path fires, ourselves, before polling.
//
// UNCONDITIONAL by design: it runs even under --no-flush. --no-flush means "skip
// draining the spool queues", NOT "skip producing my review"; INV-M6 makes the
// on-demand trigger the producing floor, not a flush side effect. Idempotent on
// runId server-side (rolling-snapshot), so re-firing every review is safe.
//
// Best-effort: a finalize failure (no run attached yet -> 404, transient
// network error) must not abort the review. We swallow it and fall through to
// the poll, which surfaces a missing packet exactly as it did when Stop was the
// only trigger.
async function triggerOnDemandReview(
  sid: string,
  cfg: WorkspaceCliConfig,
): Promise<void> {
  try {
    await triggerSessionFinalize(sid, cfg);
  } catch {
    // ignore; the poll loop reports what's missing
  }
}

// `mla review` (no args). Resolves the current session from
// CLAUDE_CODE_SESSION_ID and polls the by-session packet endpoint. The poll
// shape is exactly the previous `mla review by-session <sid>` path; the only
// difference is who supplies the session id.
export async function runReview(argv: string[]): Promise<number> {
  const cfg = loadWorkspaceConfig();
  const consoleBase = getConsoleUrl(cfg);
  const flags = parseArgs(argv);

  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    printConsoleOnly(consoleBase);
    return 0;
  }

  if (!flags.noFlush) await autoFlushAll();

  // Fire the non-Stop finalize trigger before polling so the packet can exist
  // even when no Stop hook ever ran for this session (INV-M6).
  await triggerOnDemandReview(sid, cfg);

  const result = await pollForPacket({
    cfg,
    url: () =>
      `/internal/v1/review-packets/by-session/${encodeURIComponent(sid)}?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
  });

  // Lead every render path with the console URL block. The previous CLI buried
  // the URL deep in the packet body (or omitted it entirely); An's lock made
  // surfacing the right web UI under the right command the deliverable.
  console.log(consoleUrlsBlock(consoleBase));

  if (result.kind === "timeout") {
    console.error(buildTimeoutMessage(result.lastStatus, result.lastSyn));
    return 1;
  }

  let out = renderPacket(result.packet);
  if (flags.plain) out = stripAnsi(out);
  console.log(out);
  return 0;
}

// `mla review <id>` -- emit a console deep link for an id.
//
// The locked design treats the URL as THE deliverable. We probe control to
// disambiguate between the two id-bearing review surfaces:
//
//   1. relationship candidate  -> /relationships/<id>
//   2. agent-review case       -> /cases/<id>
//
// Order matters: we try relationship-candidates FIRST because the volume is
// higher under dogfood and the URL is the dominant case. A case id that
// happens to also be a relationship-candidate id is impossible (cuids are
// unique across tables), so the ordering only affects the wasted probe on a
// miss, not correctness.
const CUID_REGEX = /^c[a-z0-9]{20,30}$/;

export function parseReviewByIdArgs(argv: string[]): { id: string } {
  let id: string | undefined;
  for (const a of argv) {
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`mla review <id>\` takes no flags, only a single id positional.`,
      );
    }
    if (id !== undefined) {
      throw new Error(
        `Unexpected extra positional argument: ${a}. \`mla review <id>\` takes exactly one id.`,
      );
    }
    id = a;
  }
  if (id === undefined) {
    throw new Error("Usage: mla review <id>");
  }
  return { id };
}

async function existsRelationshipCandidate(
  cfg: WorkspaceCliConfig,
  id: string,
): Promise<boolean> {
  try {
    await get(
      cfg,
      `/internal/v1/relationship-candidates/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
      8000,
    );
    return true;
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) return false;
    throw e;
  }
}

async function existsAgentReviewCase(
  cfg: WorkspaceCliConfig,
  id: string,
): Promise<boolean> {
  try {
    await get(
      cfg,
      `/internal/v1/agent-review/cases/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
      8000,
    );
    return true;
  } catch (e) {
    const err = e as HttpError;
    if (err.status === 404) return false;
    throw e;
  }
}

export async function runReviewById(argv: string[]): Promise<number> {
  const cfg = loadWorkspaceConfig();
  const consoleBase = getConsoleUrl(cfg);
  let parsed: { id: string };
  try {
    parsed = parseReviewByIdArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  if (!CUID_REGEX.test(parsed.id)) {
    console.error(
      `Not a valid cuid: ${parsed.id}. \`mla review <id>\` accepts a relationship ` +
        `candidate id or an agent-review case id.`,
    );
    return 2;
  }

  if (await existsRelationshipCandidate(cfg, parsed.id)) {
    console.log(`${consoleBase}/relationships/${parsed.id}`);
    return 0;
  }
  if (await existsAgentReviewCase(cfg, parsed.id)) {
    console.log(`${consoleBase}/cases/${parsed.id}`);
    return 0;
  }

  console.error(
    `Unknown id ${parsed.id} (not a relationship candidate or agent-review case in this workspace).`,
  );
  return 1;
}
