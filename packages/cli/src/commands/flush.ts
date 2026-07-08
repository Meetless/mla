import { listActiveSessions, runFlushScript, reapQueue } from "../lib/spool";
import { HOOKS_DIR } from "../lib/config";

// `mla flush` (§3 hour 6 + Acceptance A11)
//
// Scans `~/.meetless/queue/` for active sessions, spawns the same flush.sh that
// the hooks call, and reports per-session status. No bespoke flush mechanics
// live here; everything routes through flush.sh so the lock + orphan recovery
// invariants stay in one place.

interface FlushFlags {
  all?: boolean;
  session?: string;
  quiet?: boolean;
  gc?: boolean;
  reapOnly?: boolean;
}

// Strict argv parsing for `mla flush` (Wedge v6 Epoch 48).
//
// The old parser had a genuinely dangerous silent-drop trap and a dead
// flag:
//
//   1. `--session` / `-s` with no following value silently bound
//      `out.session = undefined`. Downstream, `flags.session ? [...] :
//      listActiveSessions()` then treated undefined as falsy and
//      drained EVERY pending session in the queue. The operator's
//      intent ("drain just this one") flipped to "drain everything"
//      with no diagnostic. On a busy machine that is dozens to
//      hundreds of sessions and minutes of un-bounded fan-out.
//
//   2. `--all` was a dead flag. The ternary collapsed to
//      `flags.all ? listActiveSessions() : listActiveSessions()`,
//      so `--all` and the default both did the same thing. Operators
//      reading the help text reasonably inferred the default behaved
//      differently.
//
// Strict rules below:
//   - Unknown `--`-prefixed token throws with the supported set.
//   - `--session`/`-s` MUST be followed by a non-`--` value; a missing
//     or flag-shape value throws rather than silently widening to
//     "drain everything".
//   - Positional argument is still allowed as a shortcut for
//     `--session <sid>`, but a second positional throws.
//   - `--all` and `--session` are mutually exclusive (passing both
//     throws, rather than silently letting `--session` win).
//   - `--all` is preserved as an explicit synonym for the default
//     (drain every active session) but it is no longer a no-op
//     branch; the runFlush body uses the single resolved
//     `listActiveSessions()` call.
//   - `--gc` additionally runs the age-gated stale-session reaper
//     (reapQueue) AFTER the drain, removing dead-session litter
//     (`.lock`/`.turn`/`.repoPath`/`.gitBaseline` and 0-byte spools
//     idle longer than MEETLESS_QUEUE_GC_MAX_AGE_SEC, default 24h). It
//     NEVER touches a session with undelivered work, so it is safe to
//     pair with the default drain. `--gc` is whole-queue, so it is
//     mutually exclusive with `--session` (draining one session while
//     reaping all is contradictory intent).
//   - `--reap-only` runs the SAME reaper but SKIPS the drain loop
//     entirely. This is the Stop-hook path: the session that just
//     ended already self-flushes via spawn_flush, so the hook only
//     needs the cheap age-gated litter sweep. Tail-calling `--gc`
//     there would re-drain EVERY active session on every Stop -- an
//     O(sessions) fan-out per Stop, the exact pile-up that left 99
//     stranded `.lock` files. `--reap-only` is whole-queue and pure
//     reap, so it is mutually exclusive with `--gc` (redundant),
//     `--all`, `--session`, and a positional id (all drain selectors).
const KNOWN_FLAGS = new Set(["--all", "--session", "-s", "--quiet", "-q", "--gc", "--reap-only"]);

// `--reap-only` reaps without draining; combining it with any drain
// selector is contradictory intent. Centralized so every branch raises
// the same message.
const REAP_ONLY_CONFLICT =
  "--reap-only reaps without draining; it cannot be combined with --gc/--all/--session";

export function parseArgs(argv: string[]): FlushFlags {
  const out: FlushFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reap-only") {
      if (out.all || out.gc || out.session !== undefined) {
        throw new Error(REAP_ONLY_CONFLICT);
      }
      out.reapOnly = true;
      continue;
    }
    if (a === "--all") {
      if (out.session !== undefined) {
        throw new Error("--all and --session are mutually exclusive");
      }
      if (out.reapOnly) {
        throw new Error(REAP_ONLY_CONFLICT);
      }
      out.all = true;
      continue;
    }
    if (a === "--gc") {
      if (out.session !== undefined) {
        throw new Error("--gc and --session are mutually exclusive (--gc reaps the whole queue)");
      }
      if (out.reapOnly) {
        throw new Error(REAP_ONLY_CONFLICT);
      }
      out.gc = true;
      continue;
    }
    if (a === "--session" || a === "-s") {
      if (out.all) {
        throw new Error("--all and --session are mutually exclusive");
      }
      if (out.gc) {
        throw new Error("--gc and --session are mutually exclusive (--gc reaps the whole queue)");
      }
      if (out.reapOnly) {
        throw new Error(REAP_ONLY_CONFLICT);
      }
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      if (v.startsWith("--") || v.startsWith("-")) {
        throw new Error(
          `Missing value for ${a} (got the next flag ${v} instead)`,
        );
      }
      out.session = v;
      i += 1;
      continue;
    }
    if (a === "--quiet" || a === "-q") {
      out.quiet = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      if (!KNOWN_FLAGS.has(a)) {
        throw new Error(
          `Unknown flag: ${a}. Supported flags: --all, --session/-s, --quiet/-q, --gc, --reap-only`,
        );
      }
      // Should be unreachable; KNOWN_FLAGS aligns with the branches above.
      throw new Error(`Unhandled known flag: ${a}`);
    }
    if (out.reapOnly) {
      throw new Error(REAP_ONLY_CONFLICT);
    }
    if (out.all) {
      throw new Error(
        `Unexpected positional argument: ${a}. --all already drains every session.`,
      );
    }
    if (out.gc) {
      throw new Error(
        `--gc and a per-session id are mutually exclusive (--gc reaps the whole queue).`,
      );
    }
    if (out.session !== undefined) {
      throw new Error(
        `Unexpected extra positional argument: ${a}. \`mla flush\` accepts at most one session id.`,
      );
    }
    out.session = a;
  }
  return out;
}

export async function runFlush(
  argv: string[],
  opts: { quiet?: boolean; hookDir?: string } = {},
): Promise<number> {
  const flags = parseArgs(argv);
  const hookDir = opts.hookDir ?? HOOKS_DIR;
  const quiet = opts.quiet ?? flags.quiet;

  let bad = 0;

  // --reap-only skips the drain loop entirely (Stop-hook path). Everything
  // else (`--all`, `--session`, the bare default) drains. `--all` and the bare
  // default both mean "drain every active session"; the distinction is
  // documentation-only. Collapse to a single resolved call so the dead-branch
  // pattern that hid the missing-value trap cannot return.
  if (!flags.reapOnly) {
    const sessions = flags.session ? [flags.session] : listActiveSessions();
    if (sessions.length === 0) {
      if (!quiet) console.log("No sessions to flush.");
    } else {
      for (const sid of sessions) {
        const r = runFlushScript(sid, hookDir);
        if (!r.ok) {
          bad += 1;
          if (!quiet) console.error(`[flush] ${sid} FAILED: ${r.stderr.slice(0, 200)}`);
        } else if (!quiet) {
          console.log(`[flush] ${sid} ok`);
        }
      }
    }
  }

  // --gc reaps dead-session litter AFTER the drain; --reap-only reaps WITHOUT
  // draining. Drain-first (for --gc) is the conservative ordering -- a session
  // that is still deliverable gets delivered (and self-cleaned by flush.sh's
  // RC1 path) before the reaper looks at it, and reapQueue never touches a
  // session with undelivered work regardless. Runs even when there was nothing
  // to drain.
  if (flags.gc || flags.reapOnly) {
    const gc = reapQueue();
    if (!quiet) {
      console.log(
        `[gc] reaped ${gc.reaped.length} stale session(s), removed ${gc.removedFiles} file(s)` +
          ` (${gc.skippedPending} with pending work and ${gc.skippedFresh} still-fresh kept)` +
          (gc.strandedReaped.length > 0
            ? `; reclaimed ${gc.strandedReaped.length} stranded session(s) discarding ${gc.discardedEvents} undeliverable event(s)`
            : ""),
      );
    }
  }

  return bad > 0 ? 1 : 0;
}
